"use strict";

// COORD-976 (ADR 0021): read-only architecture audit and the engine ratchets.
//
//   gov audit-architecture [--json] [--previous <report.json>] [--out <prefix>] [--root <dir>] [--revision <sha>]
//
// The audit reads files only. It writes a report when --out is given and never files tickets:
// proposals appear in the report for human-admin approval. The ratchet (guard, production module
// and production LOC counts) is evaluated at closeout beside the production LOC budget; growth
// needs a growth record on the ticket that grows it (coord/engine/architecture-ratchet.json).
// Reused, not re-implemented: countLoc (prodloc-budget.js, the one LOC rule), stripComments
// (comment-lexer.js), gitTry (git-ops.js).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { countLoc } = require("./prodloc-budget.js");
const { stripComments } = require("./comment-lexer.js");
const { gitTry } = require("./git-ops.js");

const REPORT_SCHEMA = "coord.architecture-audit";
const REPORT_VERSION = 1;
const RATCHET_SCHEMA_VERSION = 1;
const ENGINE_SCRIPTS_REL = "coord/engine/scripts";
const GUARDS_REL = "coord/engine/governance-guards.json";
const RATCHET_REL = "coord/engine/architecture-ratchet.json";
const ALLOWLIST_REL = "coord/engine/architecture-clone-allowlist.json";
const RATCHET_METRICS = Object.freeze(["guards", "production_modules", "production_loc"]);
const WINDOW_LINES = 8;
const MIN_ALNUM_LINES = 5;
const MAX_UNALLOWLISTED_PROPOSALS = 25;

const BOILERPLATE_LINES = Object.freeze([
  /^['"]use strict['"];?$/,
  /^(?:const|let|var)\s+[\w${}\s,:]+=\s*require\(.*\);?$/,
  /^\}\s*=\s*require\(.*\);?$/,
  /^[\w$]+:\s*require\(.*\),?$/,
  /^[\w$]+(?::\s*[\w$.]+)?,?$/,
  /^[{}()[\];,]+$/,
]);

function toPosix(file) {
  return String(file == null ? "" : file).replace(/\\/g, "/").replace(/^\.\//, "");
}

// The Community cut strips the enterprise subtree and forbids naming its path in shipped files, so
// report and allowlist paths use the @enterprise/ alias (the same convention as guard-registry.js).
const ENTERPRISE_SEGMENT = "enterprise";
function displayPath(file) {
  const norm = toPosix(file);
  const prefix = `${ENGINE_SCRIPTS_REL}/${ENTERPRISE_SEGMENT}/`;
  return norm.startsWith(prefix) ? `@${ENTERPRISE_SEGMENT}/${norm.slice(prefix.length)}` : norm;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A production engine module: a non-test .js file under coord/engine/scripts, outside fixture folders.
function isEngineProductionModule(repoPath) {
  const file = toPosix(repoPath);
  if (!file.startsWith(`${ENGINE_SCRIPTS_REL}/`)) return false;
  if (!file.endsWith(".js") || file.endsWith(".test.js")) return false;
  return !file.split("/").some((segment) => segment === "__fixtures__" || segment === "fixtures");
}

// Measures the engine from [{ path, source }] (repo-relative paths) and the guard registry text.
// Callers pass every engine .js file; this function sorts out what each metric counts.
function measureEngine(sources, guardsText) {
  let productionModules = 0;
  let productionLoc = 0;
  let productionRaw = 0;
  let testFiles = 0;
  let fixtureFiles = 0;
  let allJs = 0;
  for (const { path: file, source } of sources) {
    const norm = toPosix(file);
    if (!norm.startsWith(`${ENGINE_SCRIPTS_REL}/`) || !norm.endsWith(".js")) continue;
    allJs += 1;
    if (norm.endsWith(".test.js")) {
      testFiles += 1;
      continue;
    }
    if (!isEngineProductionModule(norm)) {
      fixtureFiles += 1;
      continue;
    }
    const counted = countLoc(source);
    productionModules += 1;
    productionLoc += counted.loc;
    productionRaw += counted.total;
  }
  return {
    guards: countGuards(guardsText),
    production_modules: productionModules,
    production_loc: productionLoc,
    production_raw_lines: productionRaw,
    engine_js_files: allJs,
    test_files: testFiles,
    fixture_files: fixtureFiles,
  };
}

function countGuards(guardsText) {
  if (guardsText == null) return null;
  const registry = JSON.parse(guardsText);
  if (!registry || !Array.isArray(registry.guards)) return null;
  return registry.guards.length;
}

function listEngineSources(root) {
  const base = path.join(root, ENGINE_SCRIPTS_REL);
  const out = [];
  if (!fs.existsSync(base)) return out;
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push({ path: `${ENGINE_SCRIPTS_REL}/${next}`, source: fs.readFileSync(path.join(dir, entry.name), "utf8") });
      }
    }
  };
  walk(base, "");
  return out;
}

function readOptional(root, rel) {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function isBoilerplate(line) {
  return BOILERPLATE_LINES.some((pattern) => pattern.test(line));
}

function normalizedLines(source) {
  return stripComments(source)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

// Deterministic clone detection over production modules. Windows of WINDOW_LINES normalised lines
// (comments stripped, whitespace collapsed) are hashed with SHA-1; a window that appears at two or
// more places is a duplicate. Windows made only of import or destructuring boilerplate are not
// counted. Results are grouped by the set of files they span, so the output is stable.
function findCloneClusters(sources) {
  const occurrences = new Map();
  const ordered = [...sources].sort((a, b) => compareText(toPosix(a.path), toPosix(b.path)));
  for (const { path: file, source } of ordered) {
    const norm = displayPath(file);
    const lines = normalizedLines(source);
    for (let i = 0; i + WINDOW_LINES <= lines.length; i += 1) {
      const window = lines.slice(i, i + WINDOW_LINES);
      if (window.filter((line) => /[A-Za-z0-9]/.test(line)).length < MIN_ALNUM_LINES) continue;
      if (window.every(isBoilerplate)) continue;
      const hash = crypto.createHash("sha1").update(window.join("\n")).digest("hex");
      if (!occurrences.has(hash)) occurrences.set(hash, { sample: window[0], places: [] });
      occurrences.get(hash).places.push({ file: norm, line: i + 1 });
    }
  }
  const clusters = new Map();
  for (const { sample, places } of occurrences.values()) {
    if (places.length < 2) continue;
    const files = [...new Set(places.map((place) => place.file))].sort(compareText);
    const key = files.join("|");
    if (!clusters.has(key)) clusters.set(key, { files, duplicated_windows: 0, sample, first: places[0] });
    clusters.get(key).duplicated_windows += 1;
  }
  return [...clusters.values()]
    .map((cluster) => ({ ...cluster, sample: cluster.sample.slice(0, 120) }))
    .sort((a, b) => compareText(a.files.join("|"), b.files.join("|")));
}

// Reviewed allowlist: { schema_version, entries: [{ files: [>=2 paths], reason }] }. A cluster is
// allowlisted when its exact file set is listed. Invalid entries fail the audit loudly.
function parseAllowlist(obj) {
  if (obj == null) return [];
  if (!obj || !Array.isArray(obj.entries)) throw new Error(`${ALLOWLIST_REL}: entries must be an array`);
  const seen = new Set();
  return obj.entries.map((entry, index) => {
    // One path is valid: a duplicate repeated inside a single module is a cluster too.
    if (!entry || !Array.isArray(entry.files) || entry.files.length < 1 || !entry.files.every((f) => typeof f === "string")) {
      throw new Error(`${ALLOWLIST_REL}: entry ${index} needs files (at least one path)`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`${ALLOWLIST_REL}: entry ${index} needs a reason`);
    }
    const files = [...entry.files].map(displayPath).sort(compareText);
    const key = files.join("|");
    if (seen.has(key)) throw new Error(`${ALLOWLIST_REL}: entry ${index} duplicates an earlier file set`);
    seen.add(key);
    return { files, key, reason: entry.reason };
  });
}

function applyAllowlist(clusters, entries) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const used = new Set();
  const allowlisted = [];
  const unallowlisted = [];
  for (const cluster of clusters) {
    const key = cluster.files.join("|");
    if (byKey.has(key)) {
      used.add(key);
      allowlisted.push({ ...cluster, reason: byKey.get(key).reason });
    } else unallowlisted.push(cluster);
  }
  const stale = entries.filter((entry) => !used.has(entry.key)).map((entry) => entry.files.join("|"));
  return { allowlisted, unallowlisted, stale };
}

// Ratchet: the recorded values are caps. Measured counts may not exceed them. A cap may be raised
// only with a growth record {ticket, metric, from, to, reason} naming the ticket that grows it;
// a raise against the base revision without such a record is refused. Returns refusal texts.
function evaluateRatchet({ ticketId, measured, ratchet, baseRatchet }) {
  const refusals = [];
  if (!ratchet) {
    if (baseRatchet) refusals.push(`${RATCHET_REL} was removed; the engine ratchet may not be deleted`);
    return refusals;
  }
  const values = ratchet.values && typeof ratchet.values === "object" ? ratchet.values : {};
  const growth = Array.isArray(ratchet.growth) ? ratchet.growth : [];
  for (const entry of growth) {
    if (!entry || typeof entry.ticket !== "string" || !RATCHET_METRICS.includes(entry.metric)
      || !Number.isFinite(entry.from) || !Number.isFinite(entry.to)
      || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      refusals.push(`${RATCHET_REL} has a malformed growth record (needs ticket, metric, from, to and a reason)`);
    }
  }
  for (const metric of RATCHET_METRICS) {
    const cap = values[metric];
    if (!Number.isFinite(cap)) {
      refusals.push(`${metric}: recorded ratchet value is missing or not a number`);
      continue;
    }
    const now = measured[metric];
    if (now == null) {
      refusals.push(`${metric}: could not be measured against the recorded ratchet ${cap}`);
      continue;
    }
    if (now > cap) {
      refusals.push(`${metric}: measured ${now} exceeds the recorded ratchet ${cap}; raise it only with a growth record for ${ticketId}`);
    }
    const baseCap = baseRatchet && baseRatchet.values ? baseRatchet.values[metric] : undefined;
    if (Number.isFinite(baseCap) && cap > baseCap) {
      const recorded = growth.some((entry) => entry && entry.ticket === ticketId && entry.metric === metric
        && entry.to === cap && typeof entry.reason === "string" && entry.reason.trim().length > 0);
      if (!recorded) {
        refusals.push(`${metric}: ratchet raised from ${baseCap} to ${cap} without a growth record naming ${ticketId} (metric, to and reason)`);
      }
    }
  }
  return refusals;
}

function deltasAgainst(metrics, previous) {
  if (!previous || previous.schema !== REPORT_SCHEMA || !previous.metrics) return null;
  const deltas = {};
  for (const key of Object.keys(metrics)) {
    const before = previous.metrics[key];
    deltas[key] = typeof before === "number" && typeof metrics[key] === "number" ? metrics[key] - before : null;
  }
  return deltas;
}

function buildReport({ revision, sources, guardsText, ratchet, allowlistObj, registry, previous }) {
  const metrics = measureEngine(sources, guardsText);
  const values = ratchet && ratchet.values ? ratchet.values : {};
  const ratchetStatus = RATCHET_METRICS.map((metric) => ({
    metric,
    measured: metrics[metric],
    ratchet: Number.isFinite(values[metric]) ? values[metric] : null,
    headroom: Number.isFinite(values[metric]) && metrics[metric] != null ? values[metric] - metrics[metric] : null,
  }));
  const production = sources.filter((source) => isEngineProductionModule(source.path));
  const clusters = findCloneClusters(production);
  const { allowlisted, unallowlisted, stale } = applyAllowlist(clusters, parseAllowlist(allowlistObj));
  const registryReview = registry && registry.review ? registry.review : {};
  const mergeProposals = (registryReview.proposed_merges || []).map((merge) => ({
    kind: "guard-merge",
    guards: merge.guards,
    into: merge.into,
    summary: `Merge ${merge.guards.join(", ")} ${merge.into ? `into ${merge.into}` : ""}`.trim(),
  }));
  const retirementProposals = (registryReview.retirement_candidates || []).map((candidate) => ({
    kind: "guard-retirement",
    guard: candidate.guard,
    summary: `Retire guard ${candidate.guard}: ${candidate.rationale}`,
  }));
  const cloneProposals = unallowlisted.slice(0, MAX_UNALLOWLISTED_PROPOSALS).map((cluster) => ({
    kind: "clone-cluster",
    files: cluster.files,
    duplicated_windows: cluster.duplicated_windows,
    summary: `Review duplicated logic across ${cluster.files.join(", ")}`,
  }));
  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    revision: revision || "unknown",
    scope: { engine_scripts: ENGINE_SCRIPTS_REL, excludes: ["*.test.js", "__fixtures__/", "fixtures/"] },
    metrics,
    ratchet: { file: RATCHET_REL, present: Boolean(ratchet), status: ratchetStatus },
    deltas: deltasAgainst(metrics, previous),
    guard_registry: {
      guards: metrics.guards,
      proposed_merges: mergeProposals.length,
      retirement_candidates: retirementProposals.length,
    },
    clones: {
      method: { window_lines: WINDOW_LINES, min_alnum_lines: MIN_ALNUM_LINES, boilerplate_windows_ignored: true, grouping: "exact file set" },
      clusters: clusters.length,
      allowlisted: allowlisted.map((cluster) => ({ files: cluster.files, duplicated_windows: cluster.duplicated_windows, reason: cluster.reason })),
      unallowlisted_count: unallowlisted.length,
      unallowlisted: unallowlisted.slice(0, MAX_UNALLOWLISTED_PROPOSALS),
      stale_allowlist: stale,
    },
    proposals: {
      filed: false,
      note: "Proposals are not filed. Each needs human-admin approval before a ticket is filed (COORD-976 acceptance 4).",
      items: [...mergeProposals, ...retirementProposals, ...cloneProposals],
    },
    not_measured: [
      "overlapping helpers that implement one rule (manual review; see ARCH-AUDIT-2026-11-13.md section 2b)",
      "redundant verbs and flags (manual review; see section 2c)",
      "require-graph cycles (manual review; see section 4)",
    ],
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Architecture audit", "");
  lines.push(`- Schema: ${report.schema} v${report.version}`);
  lines.push(`- Revision: ${report.revision}`);
  lines.push(`- Scope: ${report.scope.engine_scripts} (excludes ${report.scope.excludes.join(", ")})`, "");
  lines.push("## Metrics and ratchet", "", "| Metric | Measured | Ratchet | Headroom | Delta |", "| --- | ---: | ---: | ---: | ---: |");
  for (const row of report.ratchet.status) {
    const delta = report.deltas ? report.deltas[row.metric] : null;
    lines.push(`| ${row.metric} | ${row.measured} | ${row.ratchet == null ? "none" : row.ratchet} | ${row.headroom == null ? "n/a" : row.headroom} | ${delta == null ? "no previous report" : delta} |`);
  }
  lines.push("", `Other counts: engine JS files ${report.metrics.engine_js_files}, production raw lines ${report.metrics.production_raw_lines}, test files ${report.metrics.test_files}, fixture files ${report.metrics.fixture_files}.`, "");
  lines.push("## Guards", "", `- Registry guards: ${report.guard_registry.guards}`);
  lines.push(`- Registry proposed merges: ${report.guard_registry.proposed_merges}`);
  lines.push(`- Registry retirement candidates: ${report.guard_registry.retirement_candidates}`, "");
  lines.push("## Clone detection", "");
  lines.push(`- Method: ${report.clones.method.window_lines}-line windows, at least ${report.clones.method.min_alnum_lines} alphanumeric lines, import and destructuring boilerplate ignored, grouped by exact file set.`);
  lines.push(`- Clusters: ${report.clones.clusters} (allowlisted ${report.clones.allowlisted.length}, not allowlisted ${report.clones.unallowlisted_count})`);
  lines.push(`- Stale allowlist entries: ${report.clones.stale_allowlist.length ? report.clones.stale_allowlist.join("; ") : "none"}`, "");
  lines.push("## Proposals (not filed; human-admin approval required)", "");
  if (report.proposals.items.length === 0) lines.push("None.");
  for (const item of report.proposals.items) lines.push(`- [${item.kind}] ${item.summary}`);
  lines.push("", "## Not measured by this command", "");
  for (const item of report.not_measured) lines.push(`- ${item}`);
  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  const options = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (["--previous", "--out", "--root", "--revision"].includes(arg)) {
      if (i + 1 >= args.length || String(args[i + 1]).startsWith("--")) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args[i + 1];
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function defaultRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

// CLI entry: returns { code }. Read-only unless --out is given (then it writes <prefix>.json and <prefix>.md).
function run(args = [], deps = {}) {
  const log = deps.log || ((text) => process.stdout.write(text));
  const errorLog = deps.errorLog || ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    errorLog(`audit-architecture: ${error.message}\nusage: gov audit-architecture [--json] [--previous <report.json>] [--out <prefix>] [--root <dir>] [--revision <sha>]\n`);
    return { code: 2 };
  }
  const root = options.root ? path.resolve(options.root) : defaultRoot();
  try {
    const revision = options.revision || revisionOf(root);
    const previous = options.previous ? JSON.parse(fs.readFileSync(path.resolve(options.previous), "utf8")) : null;
    const report = buildReport({
      revision,
      sources: listEngineSources(root),
      guardsText: readOptional(root, GUARDS_REL),
      ratchet: parseJsonOptional(readOptional(root, RATCHET_REL), RATCHET_REL),
      allowlistObj: parseJsonOptional(readOptional(root, ALLOWLIST_REL), ALLOWLIST_REL),
      registry: parseJsonOptional(readOptional(root, GUARDS_REL), GUARDS_REL),
      previous,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderMarkdown(report);
    if (options.out) {
      const prefix = path.resolve(options.out);
      fs.mkdirSync(path.dirname(prefix), { recursive: true });
      fs.writeFileSync(`${prefix}.json`, json);
      fs.writeFileSync(`${prefix}.md`, markdown);
      log(`audit-architecture: wrote ${prefix}.json and ${prefix}.md\n`);
    } else {
      log(options.json ? json : markdown);
    }
    return { code: 0, report };
  } catch (error) {
    errorLog(`audit-architecture: ${error.message}\n`);
    return { code: 1 };
  }
}

function parseJsonOptional(text, label) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function revisionOf(root) {
  const result = gitTry(root, ["rev-parse", "--short", "HEAD"]);
  return result.status === 0 ? String(result.stdout).trim() : "unknown";
}

module.exports = {
  REPORT_SCHEMA,
  REPORT_VERSION,
  RATCHET_SCHEMA_VERSION,
  RATCHET_METRICS,
  RATCHET_REL,
  ALLOWLIST_REL,
  GUARDS_REL,
  isEngineProductionModule,
  measureEngine,
  countGuards,
  normalizedLines,
  findCloneClusters,
  parseAllowlist,
  applyAllowlist,
  evaluateRatchet,
  buildReport,
  renderMarkdown,
  run,
};
