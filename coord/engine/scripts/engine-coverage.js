"use strict";

// COORD-676: coverage accounting for the production engine, using the LCOV
// reporter of the same node:test children launched by test-runner.js.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveEngineModule, loadShimRegistry, shimDelegates } = require("../../paths.js");
const { classifyFindingsAgainstBaseline, stableFindingKey, summarizeRatchet } = require(
  resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/arch-checks.js")
);
const { findRelocatedUncovered, parseRangeFinding, isLineFinding, findRelocatedLines, selectBaselineSources } = require("./coverage-relocation.js");

// This is the complete exclusion contract. A new helper is measured until this
// list and its contract test are deliberately updated.
const EXCLUSIONS = Object.freeze([
  "**/*.test.js",
  "**/__fixtures__/**",
  "**/fixtures/**",
  "scripts/governance-test-utils.js",
  "scripts/session-lifecycle-test-utils.js",
  "scripts/business-context-pack-test-fixtures.js",
  "scripts/test-isolation-guard.js",
]);

function posix(value) { return value.split(path.sep).join("/"); }
function isProductionPath(rel) {
  const p = posix(rel);
  const logical = p.startsWith("engine/scripts/") ? p.slice("engine/".length) : p;
  if (!logical.startsWith("scripts/") || !logical.endsWith(".js")) return false;
  if (logical.endsWith(".test.js")) return false;
  if (logical.split("/").some((part) => part === "__fixtures__" || part === "fixtures")) return false;
  return !EXCLUSIONS.slice(3).includes(logical);
}

// COORD-863: a registered shim is compatibility plumbing, not production
// source; its engine target is the measured module. A shim without its target
// would leave the module unmeasured, so that fails closed. COORD-864: so does a
// registered path whose file is not the delegating shim template, because
// dropping it would hide real, unmeasured source.
function registeredShimPaths(contentRoot) {
  const shims = new Set();
  for (const shim of loadShimRegistry(contentRoot).shims) {
    if (!fs.existsSync(path.join(contentRoot, shim.target))) {
      throw new Error(`registered shim ${shim.path} has no engine target ${shim.target}`);
    }
    const legacy = path.join(contentRoot, shim.path);
    if (fs.existsSync(legacy) && !shimDelegates(fs.readFileSync(legacy, "utf8"), shim.path, shim.kind)) {
      throw new Error(`registered shim ${shim.path} does not delegate to ${shim.target}`);
    }
    shims.add(shim.path);
  }
  return shims;
}

function productionFiles(contentRoot) {
  const out = [];
  const canonical = new Map();
  const shims = registeredShimPaths(contentRoot);
  // Callers pass only existing directories: each root is checked below and
  // every nested directory comes from readdirSync.
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!["node_modules", ".runtime", ".worktrees"].includes(item.name)) visit(abs);
      } else if (item.isFile()) {
        const rel = posix(path.relative(contentRoot, abs));
        if (isProductionPath(rel) && !shims.has(rel)) out.push(rel);
      }
    }
  }
  for (const root of ["scripts", "engine/scripts"]) {
    const directory = path.join(contentRoot, root);
    if (!fs.existsSync(directory)) continue;
    const before = out.length;
    visit(directory);
    for (const rel of out.slice(before)) {
      const key = rel.startsWith("engine/scripts/") ? rel.slice("engine/".length) : rel;
      const prior = canonical.get(key);
      if (prior) throw new Error(`duplicate legacy/canonical engine module: ${prior} and ${rel}`);
      canonical.set(key, rel);
    }
  }
  return out.sort();
}

function fingerprintProductionSources(contentRoot) {
  const fingerprint = new Map();
  for (const rel of productionFiles(contentRoot)) {
    fingerprint.set(rel, crypto.createHash("sha256").update(fs.readFileSync(path.join(contentRoot, rel))).digest("hex"));
  }
  return fingerprint;
}

function changedProductionSources(before, after) {
  const changed = new Set([...before.keys(), ...after.keys()]);
  return [...changed].filter((rel) => before.get(rel) !== after.get(rel)).sort();
}

function parseLcov(text) {
  const files = new Map();
  let rel = null;
  let functions = new Map();
  let functionDefs = new Map();
  let functionHits = new Map();
  let lines = new Map();
  let branches = new Map();
  const flush = () => {
    if (rel) files.set(rel, { functions, lines, branches });
    rel = null; functions = new Map(); functionDefs = new Map(); functionHits = new Map(); lines = new Map(); branches = new Map();
  };
  for (const row of String(text).split(/\r?\n/)) {
    if (row.startsWith("SF:")) { flush(); rel = posix(row.slice(3)); }
    else if (row.startsWith("FN:")) {
      const [line, name] = row.slice(3).split(/,(.*)/s);
      const definitions = functionDefs.get(name) || [];
      const site = `${line}:${name}:${definitions.length}`;
      definitions.push(site);
      functionDefs.set(name, definitions);
      functions.set(site, 0);
    }
    else if (row.startsWith("DA:")) {
      const [line, count] = row.slice(3).split(",");
      lines.set(line, Number(count) || 0);
    } else if (row.startsWith("FNDA:")) {
      const [count, name] = row.slice(5).split(/,(.*)/s);
      // LCOV permits same-named functions at distinct source sites. FNDA rows
      // follow their FN declarations in occurrence order in Node's reporter.
      const index = functionHits.get(name) || 0;
      functionHits.set(name, index + 1);
      const site = (functionDefs.get(name) || [])[index];
      if (!site) throw new Error(`LCOV FNDA has no matching FN declaration: ${name} occurrence ${index}`);
      functions.set(site, Number(count) || 0);
    } else if (row.startsWith("BRDA:")) {
      const [line, block, branch, taken] = row.slice(5).split(",");
      branches.set(`${line}:${block}:${branch}`, taken === "-" ? 0 : Number(taken) || 0);
    } else if (row === "end_of_record") flush();
  }
  flush();
  return files;
}

function mergeLcov(reports, { stableAnonymousFunctions = false } = {}) {
  const merged = new Map();
  const anonymousCensus = new Map();
  for (const report of reports) {
    for (const [file, measures] of parseLcov(report)) {
      if (stableAnonymousFunctions) {
        const anonymousIdsByLine = new Map();
        for (const site of measures.functions.keys()) {
          const match = /^(\d+):anonymous_(\d+):\d+$/.exec(site);
          if (!match) continue;
          const line = match[1];
          if (!anonymousIdsByLine.has(line)) anonymousIdsByLine.set(line, []);
          anonymousIdsByLine.get(line).push(Number(match[2]));
        }
        for (const [line, ids] of anonymousIdsByLine) {
          const censusKey = `${file}:${line}`;
          const signature = ids.join(",");
          const prior = anonymousCensus.get(censusKey);
          if (prior !== undefined && prior !== signature) {
            throw new Error(`LCOV anonymous function identities differ across reports at ${censusKey}: ${prior} versus ${signature}`);
          }
          anonymousCensus.set(censusKey, signature);
        }
      }
      const target = merged.get(file) || { functions: new Map(), lines: new Map(), branches: new Map() };
      for (const kind of ["functions", "lines", "branches"]) {
        const ordinals = new Map();
        for (const [site, count] of measures[kind]) {
          const anonymous = kind === "functions" && stableAnonymousFunctions
            ? /^(\d+):anonymous_\d+:\d+$/.exec(site) : null;
          const key = anonymous
            ? `${anonymous[1]}:anonymous:${ordinals.get(anonymous[1]) || 0}` : site;
          if (anonymous) ordinals.set(anonymous[1], (ordinals.get(anonymous[1]) || 0) + 1);
          target[kind].set(key, Math.max(target[kind].get(key) || 0, count));
        }
      }
      merged.set(file, target);
    }
  }
  return merged;
}

function lineIdentities(content) {
  const identities = new Map();
  const occurrences = new Map();
  content.split(/\r?\n/).forEach((source, index) => {
    const compact = source.trim().replace(/\s+/g, " ");
    const hash = crypto.createHash("sha256").update(compact).digest("hex").slice(0, 20);
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    identities.set(String(index + 1), { hash, occurrence });
  });
  return identities;
}

function witnessDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function witnessLine(source, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) return null;
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}
function validateRangeWitnesses(rel, source, data, witness) {
  if (!witness || !Array.isArray(witness.functions) || !Array.isArray(witness.branches) ||
      witness.functions.length !== data.functions.size || witness.branches.length !== data.branches.size) {
    throw new Error(`LCOV source-range witness census differs for ${rel}`);
  }
  const validateOwner = (owner) => {
    if (!owner || typeof owner.name !== "string" || !Number.isSafeInteger(owner.start) ||
        !Number.isSafeInteger(owner.end) || owner.start < 0 || owner.end <= owner.start || owner.end > source.length) {
      throw new Error(`invalid LCOV source-range owner for ${rel}`);
    }
    const sliceHash = crypto.createHash("sha256").update(source.slice(owner.start, owner.end)).digest("hex");
    if (owner.slice_hash !== sliceHash) throw new Error(`LCOV source-range owner hash mismatch for ${rel}`);
  };
  const seenFunctionIds = new Set();
  const functions = [...data.functions.entries()];
  const functionRanges = new Map();
  for (let i = 0; i < witness.functions.length; i++) {
    const [site, count] = functions[i];
    const range = witness.functions[i];
    validateOwner(range?.owner);
    if (range.site !== site || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start !== range.owner.start ||
        range.end !== range.owner.end || range.line !== Number(site.slice(0, site.indexOf(":"))) ||
        range.line !== witnessLine(source, range.start) || range.count !== count) {
      throw new Error(`LCOV source-range function witness mismatch for ${rel} ${site}`);
    }
    const sliceHash = crypto.createHash("sha256").update(source.slice(range.start, range.end)).digest("hex");
    const identity = witnessDigest({ kind: "function", owner: range.owner });
    if (range.slice_hash !== sliceHash || range.identity !== identity || seenFunctionIds.has(identity)) {
      throw new Error(`invalid or ambiguous LCOV source-range function identity for ${rel} ${site}`);
    }
    seenFunctionIds.add(identity);
    functionRanges.set(site, range);
  }
  const seenBranchIds = new Set();
  const branches = [...data.branches.entries()];
  const branchRanges = new Map();
  for (let i = 0; i < witness.branches.length; i++) {
    const [site, count] = branches[i];
    const range = witness.branches[i];
    validateOwner(range?.owner);
    if (range.site !== site || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < range.owner.start ||
        range.end > range.owner.end || range.end <= range.start || range.line !== Number(site.slice(0, site.indexOf(":"))) ||
        range.line !== witnessLine(source, range.start) || range.count !== count) {
      throw new Error(`LCOV source-range branch witness mismatch for ${rel} ${site}`);
    }
    const sliceHash = crypto.createHash("sha256").update(source.slice(range.start, range.end)).digest("hex");
    const identity = witnessDigest({ kind: "branch", owner: range.owner, start: range.start,
      end: range.end, slice_hash: sliceHash });
    if (range.slice_hash !== sliceHash || range.identity !== identity || seenBranchIds.has(identity)) {
      throw new Error(`invalid or ambiguous LCOV source-range branch identity for ${rel} ${site}`);
    }
    seenBranchIds.add(identity);
    branchRanges.set(site, range);
  }
  return { functionRanges, branchRanges };
}

function measure(contentRoot, lcovReports, { stableAnonymousFunctions = false, rangeWitnesses = null } = {}) {
  if (rangeWitnesses && lcovReports.length !== 1) {
    throw new Error("source-range coverage identity requires one native aggregate LCOV report");
  }
  const raw = mergeLcov(lcovReports, { stableAnonymousFunctions });
  const files = productionFiles(contentRoot);
  const details = [];
  const findings = [];
  const totals = { lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
  for (const rel of files) {
    // Node LCOV paths are workspace-relative in the donor and content-relative
    // in a packed artifact. Match only the canonical scripts suffix.
    const data = raw.get(`coord/${rel}`) || raw.get(rel);
    const source = fs.readFileSync(path.join(contentRoot, rel), "utf8");
    const sourceIdentities = lineIdentities(source);
    const counts = {};
    // LCOV block numbers can vary between aggregate runs. Assign identities
    // from the complete branch census so covered sites cannot renumber debt.
    const branchOrdinals = new Map();
    const branchRanges = new Map();
    const functionRanges = new Map();
    if (data) {
      const witnessPath = rangeWitnesses
        ? (rangeWitnesses[`coord/${rel}`] ? `coord/${rel}` : rel)
        : null;
      const witness = witnessPath ? rangeWitnesses[witnessPath] : null;
      if (rangeWitnesses && !witness) throw new Error(`LCOV source-range witnesses are missing ${rel}`);
      if (witness) {
        const validated = validateRangeWitnesses(rel, source, data, witness);
        for (const [site, range] of validated.functionRanges) functionRanges.set(site, range);
        for (const [site, range] of validated.branchRanges) branchRanges.set(site, range);
      }
      const byLine = new Map();
      for (const site of data.branches.keys()) {
        const line = site.split(":")[0];
        if (!byLine.has(line)) byLine.set(line, []);
        byLine.get(line).push(site);
      }
      for (const sites of byLine.values()) {
        sites.sort((a, b) => {
          const aa = a.split(":").map(Number);
          const bb = b.split(":").map(Number);
          return aa[1] - bb[1] || aa[2] - bb[2];
        });
        sites.forEach((site, index) => branchOrdinals.set(site, index));
      }
    }
    if (!data) {
      // An inherited unobserved file is visible debt, but a change to that
      // file is new unmeasured production code and must fail the ratchet.
      const digest = crypto.createHash("sha256").update(source).digest("hex");
      findings.push({ check: "engine_coverage", file: rel, value: `unobserved:${digest}`, severity: "fail", message: "production file was not loaded by the aggregate suite" });
    }
    for (const kind of ["lines", "branches", "functions"]) {
      const entries = data ? data[kind] : new Map();
      const hit = [...entries.values()].filter((v) => v > 0).length;
      counts[kind] = { found: entries.size, hit, pct: entries.size ? Number((100 * hit / entries.size).toFixed(2)) : null };
      totals[kind].found += entries.size;
      totals[kind].hit += hit;
      for (const [site, count] of entries) {
        if (count > 0) continue;
        const line = String(site).split(":")[0];
        const identity = line ? sourceIdentities.get(line) : null;
        if (!identity) throw new Error(`LCOV site ${site} is outside ${rel}`);
        const suffix = kind === "branches" ? `:${branchOrdinals.get(site)}` : "";
        // Identity must be assigned across all source lines, including covered
        // copies. Otherwise coverage swapping between identical lines looks
        // like inherited debt and escapes the ratchet.
        const functionSite = site.slice(site.indexOf(":") + 1);
        const range = kind === "functions" ? functionRanges.get(site) : branchRanges.get(site);
        // Every range in these maps came from validateRangeWitnesses above,
        // which checks both hashes before the range is stored.
        const value = range
          ? `${kind}:range:${range.owner.start}:${range.owner.end}:${range.start}:${range.end}:${range.slice_hash}:${range.identity}:${identity.occurrence}`
          : kind === "functions"
            // mergeLcov already normalizes anonymous identities when requested.
            ? `${kind}:${functionSite}:${identity.hash}:${identity.occurrence}`
            : `${kind}:${identity.hash}${suffix}:${identity.occurrence}`;
        findings.push({ check: "engine_coverage", file: rel, value, severity: "fail", message: `${kind} uncovered at ${site}` });
      }
    }
    details.push({ file: rel, observed: Boolean(data), ...counts });
  }
  for (const kind of Object.keys(totals)) {
    const item = totals[kind];
    item.pct = item.found ? Number((100 * item.hit / item.found).toFixed(2)) : null;
  }
  return { schema_version: 1, identity_format: rangeWitnesses ? "raw-v8-source-range-v1" : "legacy-lcov-ordinal-v3",
    exclusions: [...EXCLUSIONS], production_file_count: files.length,
    unobserved_file_count: details.filter((f) => !f.observed).length, totals, files: details, findings };
}

function ratchet(measurement, baseline, { sourceProvider } = {}) {
  if (measurement.identity_format === "raw-v8-source-range-v1" &&
      (baseline?.identity_version !== 4 || baseline?.identity_format !== "raw-v8-source-range-v1")) {
    throw new Error("source-range coverage measurement requires identity version 4 baseline");
  }
  if (!baseline || !Array.isArray(baseline.findings)) throw new Error("measured engine coverage baseline is required");
  if (baseline.unstable_findings !== undefined || baseline.unstable_observations !== undefined ||
      baseline.unstable_source_hashes !== undefined) {
    throw new Error("source-range coverage identity v4 does not accept unstable-site exceptions");
  }
  const exactSplit = classifyFindingsAgainstBaseline(measurement.findings, baseline.findings);
  const relocated = [];
  const revalidatedLineFiles = new Set();
  const relocationUnavailable = [];
  const exactBaselineKeys = new Set(exactSplit.preExistingFindings.map((finding) => stableFindingKey(finding)));
  const relocationBaselineFindings = baseline.findings.filter((finding) => !exactBaselineKeys.has(stableFindingKey(finding)));
  if (measurement.identity_format === "raw-v8-source-range-v1" && typeof sourceProvider === "function") {
    // Inserting/removing a duplicate source line changes later ordinals. An
    // apparently exact ordinal can then consume credit belonging to another
    // physical line, even when the set of uncovered IDs is unchanged. Inspect
    // every line-bearing file; unchanged source retains its exact identities.
    for (const finding of measurement.findings.filter(isLineFinding)) revalidatedLineFiles.add(finding.file);
    const sourceFiles = [...new Set([...revalidatedLineFiles, ...exactSplit.newFindings
      .filter((finding) => parseRangeFinding(finding)).map((finding) => finding.file)])].sort();
    for (const file of sourceFiles) {
      let sources;
      try {
        sources = selectBaselineSources(sourceProvider(file, baseline.source_commit), file, baseline.findings);
      } catch {
        sources = null;
      }
      if (!sources || typeof sources.currentSource !== "string" || typeof sources.baselineSource !== "string") {
        relocationUnavailable.push({ file, reason: "exact current or baseline source is unavailable" });
        continue;
      }
      if (sources.currentSource === sources.baselineSource) revalidatedLineFiles.delete(file);
      const matched = findRelocatedUncovered(exactSplit.newFindings, relocationBaselineFindings, {
        file,
        currentSource: sources.currentSource,
        baselineSource: sources.rangeBaselineSource,
      });
      relocated.push(...matched.relocated);
      if (revalidatedLineFiles.has(file)) {
        relocated.push(...findRelocatedLines(measurement.findings, baseline.findings, {
          file, currentSource: sources.currentSource, baselineSource: sources.baselineSource,
        }));
      }
    }
  }
  const effectiveBaseline = [
    ...baseline.findings.filter((finding) => !(revalidatedLineFiles.has(finding.file) && isLineFinding(finding))),
    ...relocated.map((match) => match.finding),
  ];
  const split = classifyFindingsAgainstBaseline(measurement.findings, effectiveBaseline);
  const summary = summarizeRatchet(measurement.findings, {}, measurement.production_file_count, effectiveBaseline);
  return {
    result: summary.result,
    new_uncovered: split.newFindings,
    inherited_uncovered: split.preExistingFindings.length,
    relocated_uncovered: relocated.map(({ finding, current, baseline: prior }) => ({
      file: finding.file,
      kind: current.kind,
      current_occurrence: current.occurrence,
      baseline_occurrence: prior.occurrence,
      current_owner: current.kind === "lines" ? null : [current.ownerStart, current.ownerEnd],
      baseline_owner: prior.kind === "lines" ? null : [prior.ownerStart, prior.ownerEnd],
      current_site: [current.siteStart, current.siteEnd],
      baseline_site: [prior.siteStart, prior.siteEnd],
    })),
    relocation_unavailable: relocationUnavailable,
  };
}

// COORD-907: ADVISORY pre-gate support. A changed-suite measurement is partial: it
// can show arms that the whole-suite baseline credits to unselected suites. Its output is
// therefore labelled advisory, never writes a baseline, is never gate evidence, and never
// replaces the whole-suite ratchet (no partial-measurement accounting is claimed).
// changedLinesFromDiff maps the ADDED lines of a `git diff --unified=0` to content-relative
// files, so each candidate can be told apart as text-changed (needs real tests) or an
// unchanged finer arm (baselined per the ruling).
function changedLinesFromDiff(diffText, contentPrefix = "") {
  const changed = new Map();
  let file = null;
  for (const row of String(diffText).split(/\r?\n/)) {
    if (row.startsWith("+++ ")) {
      const target = row.slice(4).replace(/^b\//, "");
      file = target !== "/dev/null" && target.startsWith(contentPrefix) ? target.slice(contentPrefix.length) : null;
      if (file && !changed.has(file)) changed.set(file, new Set());
    } else if (row.startsWith("@@") && file) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(row);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let offset = 0; offset < count; offset++) changed.get(file).add(start + offset);
    }
  }
  return changed;
}

function advisoryReport(verdict, measurement, changedLines) {
  const unobserved = new Set(measurement.files.filter((f) => !f.observed).map((f) => f.file));
  const candidates = verdict.new_uncovered.filter((finding) => !finding.value.startsWith("unobserved:"));
  const textChanged = [];
  const unchangedArms = [];
  for (const finding of candidates) {
    const line = Number(/uncovered at (\d+)/.exec(finding.message)?.[1]);
    const entry = { file: finding.file, kind: finding.value.split(":")[0], line, message: finding.message };
    if (changedLines.get(finding.file)?.has(line)) textChanged.push(entry);
    else unchangedArms.push(entry);
  }
  return {
    advisory: true,
    gate_evidence: false,
    baseline_written: false,
    candidates,
    text_changed: textChanged,
    unchanged_arms: unchangedArms,
    unobserved_files: [...unobserved].sort(),
    inherited_uncovered: verdict.inherited_uncovered,
  };
}

module.exports = { EXCLUSIONS, isProductionPath, productionFiles, fingerprintProductionSources,
  changedLinesFromDiff, advisoryReport,
  changedProductionSources, parseLcov, mergeLcov, measure, ratchet, validateRangeWitnesses };
