"use strict";

// COORD-914 (ADR 0021): the governance guard registry. This module only READS
// engine source and the registry; it changes no guard's behaviour.
//
//   node coord/engine/scripts/guard-registry.js check   completeness + schema
//   node coord/engine/scripts/guard-registry.js write   regenerate the view
//   node coord/engine/scripts/guard-registry.js sites   list scanned sites
//
// Completeness convention (see SCAN_SCOPE, rendered into the view):
//   - a `// guard:<id>` (JS) or `# guard:<id>` (shell) comment covers the scanned
//     sites after it until the next blank line or the next marker;
//   - a registry `anchors` entry {file, text, matches?} covers the sites whose
//     call text starts with `text`; it must match exactly `matches` (default 1)
//     sites. Anchors are used where a comment inside the function would change
//     the coverage ratchet's owner identity. Rewording an anchored message
//     without updating its anchor fails the check, by design;
//   - dynamically dispatched stages are covered by `stage_refs`.

const fs = require("node:fs");
const path = require("node:path");
const { toPosix } = require("./lifecycle-utils.js");

const REGISTRY_REL = "coord/engine/governance-guards.json";
const SCHEMA_REL = "coord/engine/governance-guards.schema.json";
const VIEW_REL = "coord/engine/docs/GUARD_REGISTRY.md";
const ENGINE_SCRIPTS_REL = "coord/engine/scripts";
// The scanner's own patterns and scope text name the wording it looks for.
// lifecycle-help.js is usage text: it names refusals, it does not raise them.
const EXCLUDED_REL = new Set([`${ENGINE_SCRIPTS_REL}/guard-registry.js`, `${ENGINE_SCRIPTS_REL}/lifecycle-help.js`]);
const SHELL_MARKED_REL = ["release/verify-dual-release.sh"];
// The Enterprise-only subtree is stripped from the Community cut, whose
// open-core scan forbids naming its path in shipped files. Registry entries and
// scanned sites therefore name its files through the EDITION_ALIAS prefix.
const EDITION_DIR = "enterprise";
const EDITION_ALIAS = `@${EDITION_DIR}/`;
const EDITION_REAL = `${ENGINE_SCRIPTS_REL}/${EDITION_DIR}/`;
// release/ exists only in the donor; a release cut strips it.
const DONOR_MARKER_REL = "release/check-public-release.sh";
const MANIFEST_REL = "coord/TEMPLATE_SYNC_MANIFEST.json";
const DEFAULT_MANAGED_ROOTS = Object.freeze(["coord/scripts", "coord/board", "coord/engine"]);

const MARKER = /(?:\/\/|#)\s*guard:([a-z0-9][a-z0-9-]*)\b/;
const REFUSAL_WORD = /\brefus(?:e|es|ed|ing|al)\b|Review-plan blockers/i;
const REFUSAL_CALL = /\b(?:fail|die|refuse)\s*\(|\bthrow new \w+\s*\(/;
const REFUSAL_LITERAL = /["'`][^"'`]*\brefus(?:e|es|ed|ing|al)\b/i;
const DENY_DECISION = /\b(?:decision|permissionDecision)\s*:\s*["']deny["']/;
const WRAPPER_NAME = /^(?:assert[A-Z]\w*|collect\w*(?:Issues|Blockers)|(?:format|build)\w*Refusal\w*)$/;
const WRAPPER_DEF = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const BLOCKER_CODE = /^\s*code:\s*"[a-z_]+"/;
const BLOCKER_OPEN = /(?:issues|blockers|problems)\.push\(\{\s*$|return \[\{\s*$/;
const BLOCKER_FILES = /^coord\/engine\/scripts\/(?:gates\/|review-plan-readiness\.js$|decomposition-proof-gate\.js$|gate-plan\.js$|evidence-record\.js$|governance-validation\.js$)/;
const SHELL_FAIL = /(?:^|[\s;&|(])fail\s+["']/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const CALL_WINDOW = 6;

const SCAN_SCOPE = Object.freeze({
  covered: Object.freeze([
    "refusal-call: a fail()/die()/refuse()/throw new X() call in coord/engine/scripts/** production code whose call text (up to 6 lines) says refuse/refused/refusing/refusal or \"Review-plan blockers\"",
    "refusal-text: a string literal with that wording outside a refusal call (message builders such as formatTreeMutationSafetyHazard)",
    "blocker-code: a `code: \"<name>\"` blocker pushed by the start, submit and review-plan readiness collectors (coord/engine/scripts/gates/**, review-plan-readiness.js, decomposition-proof-gate.js, gate-plan.js, governance-validation.js)",
    "deny-decision: a `decision: \"deny\"` result from a runtime-authority, auto-mode or containment policy",
    "wrapper: a shared guard helper defined as assert<Name>, collect<Name>Issues/Blockers or format/build<Name>Refusal (assertRegisteredBoundOwner, assertProductionLocForCloseout, the review-plan blocker collectors, seal and drift assertions)",
    "shell-fail: a `fail \"...\"` call in release/verify-dual-release.sh",
    "stage: dynamically dispatched gate stages — release/check-public-release.sh CHECKS, the test-runner overallPass terms, arch-checks CHECKS and verify-upgrade-bridge.sh steps",
  ]),
  excluded_paths: Object.freeze(["*.test.js", "__fixtures__/", "vendor/", "node_modules/", "coord/engine/scripts/guard-registry.js (the scanner)", "coord/engine/scripts/lifecycle-help.js (usage text only)"]),
  edition_alias: `${EDITION_ALIAS}<file> names a file in the Enterprise-only subtree; in a Community cut those entries are not checked (see Not covered)`,
});

function realPath(file) { return file.startsWith(EDITION_ALIAS) ? EDITION_REAL + file.slice(EDITION_ALIAS.length) : file; }

function aliasPath(rel) { return rel.startsWith(EDITION_REAL) ? EDITION_ALIAS + rel.slice(EDITION_REAL.length) : rel; }

function listEngineSources(root) {
  const out = [];
  const skipped = new Set(["__fixtures__", "vendor", "node_modules"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) walk(full);
      } else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name) && !/\.test\.(?:c|m)?js$/.test(entry.name)) {
        const rel = toPosix(path.relative(root, full));
        if (!EXCLUDED_REL.has(rel)) out.push(aliasPath(rel));
      }
    }
  };
  walk(path.join(root, ENGINE_SCRIPTS_REL));
  return out;
}

function stripLineComment(line) { return line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"); }

function callWindow(lines, index) {
  let text = "";
  let last = index;
  for (let j = index; j < Math.min(lines.length, index + CALL_WINDOW); j += 1) {
    text += `${stripLineComment(lines[j])}\n`;
    last = j;
    if (/;\s*$|^\s*\)\s*;?\s*$/.test(lines[j])) break;
  }
  return { text, last };
}

function wrapperName(line) {
  const match = WRAPPER_DEF.exec(line);
  const name = match && (match[1] || match[2]);
  return name && WRAPPER_NAME.test(name) ? name : null;
}

function classifyJsLine(lines, i, { file, prev }) {
  const line = lines[i];
  if (BLOCKER_FILES.test(file) && BLOCKER_CODE.test(line) && BLOCKER_OPEN.test(prev)) return { kind: "blocker-code", last: i };
  const name = wrapperName(line);
  if (name) return { kind: "wrapper", name, last: i };
  if (REFUSAL_CALL.test(line)) {
    const win = callWindow(lines, i);
    if (REFUSAL_WORD.test(win.text)) return { kind: "refusal-call", last: win.last };
  }
  if (DENY_DECISION.test(line)) return { kind: "deny-decision", last: i };
  if (REFUSAL_LITERAL.test(stripLineComment(line))) return { kind: "refusal-text", last: i };
  return null;
}

// Pure: sites and markers of one source text. A marker covers the following
// sites until a blank line or the next marker.
function scanSource(file, source, { shell = false } = {}) {
  const lines = String(source).split(/\r?\n/);
  const sites = [];
  const markers = [];
  let active = null;
  let prev = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = MARKER.exec(line);
    if (marker) {
      active = marker[1];
      markers.push({ file, line: i + 1, id: active });
    } else if (line.trim() === "") {
      active = null;
    }
    const site = shell ? (SHELL_FAIL.test(line) && !/^\s*#/.test(line) ? { kind: "shell-fail", last: i } : null)
      : (COMMENT_LINE.test(line) ? null : classifyJsLine(lines, i, { file, prev }));
    if (line.trim() !== "" && !COMMENT_LINE.test(line)) prev = line;
    if (!site) continue;
    const text = lines.slice(i, site.last + 1).map((part) => part.trim()).join(" ");
    sites.push({ file, line: i + 1, kind: site.kind, name: site.name || null, text, marker: active });
    for (let j = i + 1; j <= site.last; j += 1) if (lines[j].trim() === "") active = null;
    i = site.last;
  }
  return { sites, markers };
}

function readText(root, rel) { return fs.readFileSync(path.join(root, realPath(rel)), "utf8"); }

function readOptional(root, rel) {
  try {
    return readText(root, rel);
  } catch {
    return null;
  }
}

function arrayAfter(source, pattern) {
  const match = pattern.exec(source);
  return match ? match[1] : "";
}

// Stage refs of dynamically dispatched gate checks. A stage source that is
// absent (release/ in a cut) contributes nothing and is reported as absent.
const STAGE_SOURCES = Object.freeze([
  ["check-public-release", "release/check-public-release.sh",
    (text) => arrayAfter(text, /^CHECKS=\(([^)]*)\)/m).trim().split(/\s+/).filter(Boolean)],
  ["test-runner", `${ENGINE_SCRIPTS_REL}/test-runner.js`,
    (text) => [...new Set(arrayAfter(text, /const overallPass\s*=([\s\S]*?);/).match(/\b(?!result\b|fail\b|length\b)[a-z][A-Za-z]+\b/g) || [])]],
  ["arch-checks", `${ENGINE_SCRIPTS_REL}/arch-checks.js`,
    (text) => (arrayAfter(text, /const CHECKS = Object\.freeze\(\[([\s\S]*?)\]\)/).match(/"([A-Za-z]+)"/g) || []).map((s) => s.slice(1, -1))],
  ["verify-upgrade-bridge", "release/verify-upgrade-bridge.sh",
    (text) => (text.match(/^step "(\d+)\./gm) || []).map((s) => `step-${s.match(/\d+/)[0]}`)],
]);

function discoverStages(root) {
  const refs = [];
  const absent = [];
  for (const [prefix, rel, names] of STAGE_SOURCES) {
    const text = readOptional(root, rel);
    if (text === null) absent.push(prefix);
    else for (const name of names(text)) refs.push(`${prefix}:${name}`);
  }
  return { refs, absent };
}

function discoverStageRefs(root) { return discoverStages(root).refs; }

function scanWorkspace(root) {
  const sites = [];
  const markers = [];
  const add = (file, options) => {
    const text = readOptional(root, file);
    if (text === null) return;
    const result = scanSource(file, text, options);
    sites.push(...result.sites);
    markers.push(...result.markers);
  };
  for (const file of listEngineSources(root)) add(file);
  for (const file of SHELL_MARKED_REL) add(file, { shell: true });
  const stages = discoverStages(root);
  return { sites, markers, stageRefs: stages.refs, absentStageSources: stages.absent, ...treeEdition(root) };
}

// The donor carries release/. A cut is Enterprise when it ships the
// Enterprise-only subtree, Community otherwise; its pruned manifest lists
// exactly the engine-managed files that edition ships.
function treeEdition(root) {
  if (readOptional(root, DONOR_MARKER_REL) !== null) return { donor: true, edition: "donor", shipped: [], managedRoots: [] };
  const edition = fs.existsSync(path.join(root, EDITION_REAL)) ? "Enterprise" : "Community";
  let manifest = {};
  try {
    manifest = JSON.parse(readText(root, MANIFEST_REL));
  } catch {
    // No readable manifest: nothing is known to ship, so every managed-root
    // file an applicable entry names must be present.
  }
  return { donor: false, edition, shipped: (manifest.items || []).map((item) => item.path),
    managedRoots: manifest.discovery?.engine_managed_roots || DEFAULT_MANAGED_ROOTS };
}

// --- minimal JSON-schema subset (type, const, enum, pattern, required,
// properties, additionalProperties:false, items, minItems, minLength) ---------
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(want, value) {
  const got = typeOf(value);
  return [].concat(want).some((t) => t === got || (t === "number" && got === "integer"));
}

function validateObject(schema, value, at, errors) {
  for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
  for (const [key, child] of Object.entries(value)) {
    const sub = schema.properties && schema.properties[key];
    if (sub) validateSchema(sub, child, `${at}.${key}`, errors);
    else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
  }
}

function validateScalar(schema, value, at, errors) {
  if ("const" in schema && value !== schema.const) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  if (typeof value !== "string") return;
  if (schema.minLength && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
}

function validateSchema(schema, value, at = "$", errors = []) {
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${at}: expected ${[].concat(schema.type).join("|")}, got ${typeOf(value)}`);
    return errors;
  }
  validateScalar(schema, value, at, errors);
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, `${at}[${i}]`, errors));
  } else if (typeOf(value) === "object") {
    validateObject(schema, value, at, errors);
  }
  return errors;
}

// --- completeness ------------------------------------------------------------
function referenceProblems(registry, ids) {
  const problems = [];
  for (const guard of registry.guards) {
    for (const other of guard.overlaps) if (!ids.has(other)) problems.push(`${guard.id}: overlaps unknown guard ${other}`);
  }
  for (const merge of registry.review.proposed_merges) {
    for (const id of merge.guards) if (!ids.has(id)) problems.push(`proposed merge ${merge.id}: unknown guard ${id}`);
  }
  for (const item of registry.review.retirement_candidates) {
    if (!ids.has(item.guard)) problems.push(`retirement candidate: unknown guard ${item.guard}`);
  }
  return problems;
}

// Unmeasured cost is unknown, never an estimate; measured cost cites its run.
// Ownership, provenance and integration-safety guards stay enforced at every
// tier, so an always_enforced entry is classified T0.
function entryProblems(registry) {
  const problems = [];
  for (const { id, cost, tier, always_enforced: always } of registry.guards) {
    if (cost.cost_status === "unknown" && cost.wall_time !== null) problems.push(`${id}: unknown cost must have wall_time null`);
    if (cost.cost_status === "measured" && (cost.wall_time === null || cost.source === null)) problems.push(`${id}: measured cost needs wall_time and source`);
    if (always && tier !== "T0") problems.push(`${id}: always_enforced guards must be tier T0`);
  }
  return problems;
}

// Every entry the Community cut cannot check is named in a not_covered item.
function editionProblems(registry, ids) {
  const problems = [];
  const named = new Set(registry.coverage.not_covered.flatMap((item) => item.guards || []));
  for (const guard of registry.guards) {
    if (!guard.editions.includes("Community") && !named.has(guard.id)) problems.push(`${guard.id}: Enterprise-only entry is not named in coverage.not_covered`);
  }
  for (const id of named) {
    const guard = registry.guards.find((g) => g.id === id);
    if (!ids.has(id) || guard.editions.includes("Community")) problems.push(`coverage.not_covered names ${id}, which is not an Enterprise-only entry`);
  }
  return problems;
}

// An absent file is a problem in the donor. In a cut it is skipped only when
// the entry does not ship in that edition, or the file is release tooling
// outside the engine-managed roots that no cut ships. A file the cut's
// manifest lists, or any managed-root file of an applicable entry, must exist.
function fileProblem(scan, exists, guard, file, label) {
  const real = realPath(file);
  if (exists(real)) return null;
  if (scan.donor) return `${guard.id}: ${label} file ${file} does not exist`;
  if (!guard.editions.includes(scan.edition)) return "";
  const managed = scan.managedRoots.some((rootRel) => real.startsWith(`${rootRel}/`));
  if (scan.shipped.includes(real) || managed) return `${guard.id}: ${label} file ${file} is missing from this ${scan.edition} cut`;
  return "";
}

function anchorProblems(registry, scan, exists) {
  const problems = [];
  const seen = new Set();
  for (const guard of registry.guards) {
    for (const anchor of guard.anchors || []) {
      const key = `${anchor.file}\0${anchor.text}`;
      if (seen.has(key)) problems.push(`${guard.id}: duplicate anchor ${anchor.file} "${anchor.text}"`);
      seen.add(key);
      const absent = fileProblem(scan, exists, guard, anchor.file, "anchor");
      if (absent !== null) {
        if (absent) problems.push(absent);
        continue;
      }
      const count = scan.sites.filter((site) => site.file === anchor.file && site.text.startsWith(anchor.text)).length;
      const declared = anchor.matches || 1;
      if (count === 0) problems.push(`${guard.id}: stale anchor ${anchor.file} "${anchor.text}" matches no site (reworded? update the anchor in the same change)`);
      else if (count !== declared) problems.push(`${guard.id}: ambiguous anchor ${anchor.file} "${anchor.text}" matches ${count} sites, declared ${declared}`);
    }
  }
  return problems;
}

function siteProblems(registry, scan, ids) {
  const problems = [];
  const anchors = registry.guards.flatMap((g) => g.anchors || []);
  for (const site of scan.sites) {
    const anchored = anchors.some((a) => a.file === site.file && site.text.startsWith(a.text));
    if (!site.marker && !anchored) problems.push(`unregistered ${site.kind} site ${site.file}:${site.line}: ${site.text.slice(0, 120)}`);
  }
  for (const marker of scan.markers) if (!ids.has(marker.id)) problems.push(`marker guard:${marker.id} at ${marker.file}:${marker.line} has no registry entry`);
  return problems;
}

function stageProblems(registry, scan) {
  const problems = [];
  const claimed = new Set(registry.guards.flatMap((g) => g.stage_refs || []));
  const discovered = new Set(scan.stageRefs);
  for (const ref of discovered) if (!claimed.has(ref)) problems.push(`unregistered gate stage ${ref}`);
  const absent = new Set(scan.absentStageSources);
  for (const ref of claimed) {
    if (!discovered.has(ref) && !absent.has(ref.slice(0, ref.indexOf(":")))) problems.push(`stale stage_ref ${ref}`);
  }
  return problems;
}

function markerLocationProblems(registry, scan, exists) {
  const problems = [];
  const markedFiles = new Map();
  for (const marker of scan.markers) {
    if (!markedFiles.has(marker.id)) markedFiles.set(marker.id, new Set());
    markedFiles.get(marker.id).add(marker.file);
  }
  for (const guard of registry.guards) {
    for (const loc of guard.locations) {
      const absent = fileProblem(scan, exists, guard, loc.file, "location");
      if (absent) problems.push(absent);
      if (absent === null && loc.marker && !(markedFiles.get(guard.id) || new Set()).has(loc.file)) {
        problems.push(`${guard.id}: no guard:${guard.id} marker in ${loc.file}`);
      }
    }
  }
  return problems;
}

function checkRegistry(registry, schema, scan, { exists } = {}) {
  const problems = validateSchema(schema, registry);
  if (problems.length) return { problems, ids: new Set() };
  const ids = new Set();
  for (const guard of registry.guards) {
    if (ids.has(guard.id)) problems.push(`duplicate guard id ${guard.id}`);
    ids.add(guard.id);
  }
  problems.push(...referenceProblems(registry, ids), ...entryProblems(registry), ...editionProblems(registry, ids),
    ...siteProblems(registry, scan, ids), ...anchorProblems(registry, scan, exists),
    ...stageProblems(registry, scan), ...markerLocationProblems(registry, scan, exists));
  return { problems, ids };
}

// --- view --------------------------------------------------------------------
function cell(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function costText(cost) {
  const time = cost.wall_time === null ? "unknown" : cost.wall_time;
  return `${cost.frequency}; time: ${time} (${cost.cost_status})`;
}

function renderGuard(guard) {
  const where = guard.locations.map((l) => `\`${l.file}\` ${l.function}`).join("; ");
  return [
    `### ${guard.id} — ${guard.title}`,
    "",
    `- **Tier (proposed):** ${guard.tier}${guard.always_enforced ? " (always enforced)" : ""}. **Kind:** ${guard.kind}. **Editions:** ${cell(guard.editions)}. **Verbs or stage:** ${cell(guard.verbs)}`,
    `- **Protective intent:** ${guard.intent}`,
    `- **Answers:** ${cell(guard.answers)}`,
    `- **Overlaps:** ${cell(guard.overlaps) || "none recorded"}`,
    `- **Implementation:** ${where}`,
    `- **Cost:** ${costText(guard.cost)}${guard.cost.note ? `. ${guard.cost.note}` : ""}`,
    `- **Failure remedy:** ${guard.remedy}`,
    `- **Retirement criteria:** ${guard.retirement_criteria}`,
    `- **Review date:** ${guard.review_date}`,
    "",
  ].join("\n");
}

// The view depends only on the registry, so a release cut (which strips
// scanned files) renders the same bytes as the donor.
function renderView(registry) {
  const tiers = ["T0", "T1", "T2"].map((t) => `${t}: ${registry.guards.filter((g) => g.tier === t).length}`).join(", ");
  const lines = [
    "# Governance guard registry",
    "",
    `<!-- Generated by coord/engine/scripts/guard-registry.js write from ${REGISTRY_REL}. Do not edit by hand. -->`,
    "",
    `${registry.description}`,
    "",
    `- Ticket: ${registry.ticket}. Decision: ${registry.adr}. Review date: ${registry.review_date}.`,
    `- Guards: ${registry.guards.length} (${tiers}). Run \`node coord/engine/scripts/guard-registry.js sites\` for the scanned refusal sites.`,
    `- Measured gate costs come only from: ${registry.measurement.source}.`,
    "",
    "## Tiers",
    "",
    registry.tier_semantics,
    "",
    "## Changing this registry",
    "",
    registry.ownership,
    "",
    "## Summary",
    "",
    "| id | tier | kind | verbs or stage | remedy |",
    "| --- | --- | --- | --- | --- |",
    ...registry.guards.map((g) => `| ${cell(g.id)} | ${g.tier} | ${g.kind} | ${cell(g.verbs)} | ${cell(g.remedy)} |`),
    "",
    "## What the completeness check covers",
    "",
    ...SCAN_SCOPE.covered.map((item) => `- ${item}`),
    `- Excluded paths: ${SCAN_SCOPE.excluded_paths.join(", ")}.`,
    `- ${SCAN_SCOPE.edition_alias}.`,
    "",
    "## Not covered by the completeness check",
    "",
    ...registry.coverage.not_covered.map((item) => `- **${item.surface}:** ${item.reason}${item.guards ? ` Entries: ${item.guards.join(", ")}.` : ""}`),
    "",
    "## Guards",
    "",
    ...registry.guards.map((g) => renderGuard(g)),
    "## Review: proposed merges",
    "",
    ...registry.review.proposed_merges.flatMap((m) => [`### ${m.id}`, "", `- **Merge:** ${m.guards.join(", ")} into ${m.into}.`,
      `- **Rationale:** ${m.rationale}`, `- **Must still cover:** ${m.must_still_cover.join("; ")}`, ""]),
    "## Review: retirement candidates",
    "",
    ...registry.review.retirement_candidates.flatMap((r) => [`### ${r.guard}`, "", `- **Rationale:** ${r.rationale}`,
      `- **Must still cover:** ${r.must_still_cover.join("; ")}`, ""]),
  ];
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function loadRegistry(root) {
  return {
    registry: JSON.parse(readText(root, REGISTRY_REL)),
    schema: JSON.parse(readText(root, SCHEMA_REL)),
  };
}

function main(argv, { root = path.resolve(__dirname, "..", "..", ".."), out = process.stdout, err = process.stderr } = {}) {
  const command = argv[0] || "check";
  const scan = scanWorkspace(root);
  if (command === "sites") {
    for (const site of scan.sites) out.write(`${site.file}:${site.line}\t${site.kind}\t${site.marker || "-"}\t${site.text.slice(0, 140)}\n`);
    return 0;
  }
  const { registry, schema } = loadRegistry(root);
  const { problems } = checkRegistry(registry, schema, scan, { exists: (rel) => fs.existsSync(path.join(root, realPath(rel))) });
  if (command === "write" && problems.length === 0) {
    fs.writeFileSync(path.join(root, VIEW_REL), renderView(registry));
    out.write(`guard-registry: wrote ${VIEW_REL}\n`);
    return 0;
  }
  if (command !== "check" && command !== "write") {
    err.write(`guard-registry: unknown command ${command} (check, write, sites)\n`);
    return 2;
  }
  if (problems.length === 0 && renderView(registry) !== readOptional(root, VIEW_REL)) problems.push(`${VIEW_REL} is missing or stale; run guard-registry.js write`);
  for (const problem of problems) err.write(`guard-registry: ${problem}\n`);
  out.write(`guard-registry: ${problems.length ? "FAIL" : "PASS"} guards=${registry.guards.length} sites=${scan.sites.length} stages=${scan.stageRefs.length} problems=${problems.length}\n`);
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  REGISTRY_REL, SCHEMA_REL, VIEW_REL, SCAN_SCOPE,
  realPath, listEngineSources, scanSource, discoverStageRefs, scanWorkspace,
  validateSchema, checkRegistry, renderView, loadRegistry, main,
};
