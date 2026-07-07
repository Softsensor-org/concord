"use strict";

// COORD-078 (QGATE-004): architecture / complexity guardrails (WARNING-FIRST).
//
// This module is the REUSABLE static-architecture check library AND the
// single-source policy layer for the arch gate. It mirrors audit-policy.js
// (COORD-076) / coverage-policy.js (COORD-077): a zero-dependency Node module
// with config-driven thresholds and a `classify` CLI shelled from the template
// gate.sh runners on the full/ci lanes. Unlike those, arch is WARNING-FIRST by
// default — findings warn (non-blocking) so the gate does not turn red on the
// template's own pre-existing module debt (e.g. lifecycle.js). A check can be
// escalated to `fail` per-config.
//
// DUAL CONSUMER CONTRACT: this module is imported by TWO callers and the shape
// is load-bearing for both:
//   1. the arch gate (classify CLI -> gate.sh -> board annotation `arch=`); and
//   2. COORD-083's code-quality ticket generator, which calls the exported
//      check functions directly to turn findings into tickets. The generator
//      consumes the structured Finding shape below — DO NOT change it without
//      updating COORD-083.
//
// Boundary: this module is pure analysis + policy. It reads source files (given
// an explicit file list or a repo root + scan) and returns structured findings;
// it does NOT run any gate, touch the board, or write artifacts. The gate.sh
// runner owns invocation + artifact write; gates.js owns the board-record
// attribution surface. Dependency-injection friendly: every check takes its
// inputs (file contents / file list / threshold / config) as arguments so it
// can be unit-tested and reused without filesystem coupling — the fs-touching
// scan helpers are thin wrappers over the pure analyzers.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// The check identifiers. Order is the documented/reported order. Each maps to a
// pure analyzer below and to a default threshold in DEFAULT_CONFIG.checks.
const CHECKS = Object.freeze([
  "size",        // max file size (LOC) — the no-new-monolith absolute-budget signal
  "complexity",  // per-function cyclomatic complexity (lightweight estimator)
  "imports",     // disallowed cross-module imports (declared boundary policy)
  "duplication", // repeated N-line blocks across files (normalized-hash)
  "monolith",    // no-new-monolith: file over budget (alias of size at a higher budget)
  "prodloc",     // coord/scripts production-module LOC budget with high-water hotspots
  "compositionRoot", // fail newly-added non-wiring logic in composition roots
  "hardcoding",  // magic literals that should be config/constants (config-seam leaks)
  "deadcode",    // functions/consts defined but never referenced (dispatch/facade-aware)
]);

// Severities. Warning-first: the DEFAULT severity for every check is "warn".
const SEVERITIES = Object.freeze(["off", "warn", "fail"]);

// Config-driven defaults. The policy layer: per-check threshold + severity.
// WARNING-FIRST — every check defaults to "warn" (non-blocking). Escalate a
// check by overriding its `severity` to "fail" (per-repo / per-check config).
// Thresholds are deliberately generous so the template's own engine stays
// GREEN by default (e.g. lifecycle.js is ~6700 LOC; the size check WARNS, it
// does not fail). Overridable via mergeConfig (env / gate config / caller).
const DEFAULT_CONFIG = Object.freeze({
  checks: Object.freeze({
    // LOC budget per file. ~1500 is the "this file is getting large" signal.
    // `perFile` carries justified per-file budget overrides keyed by the file's
    // basename: a file listed here is measured against its own maxLoc instead of
    // the global one. Use sparingly and only for files that are legitimately
    // large by design (composition roots / dispatch hubs), NOT to silence a
    // monolith that should be split.
    //
    // COORD-091: lifecycle.js is the governance COMPOSITION ROOT — it wires ~30
    // DI factories together (the de-monolith extracted doctor/ticket-guidance/
    // agent-commands/landing-resolution/board-rebuild/etc. into their own
    // modules) and owns the dispatch + __testing facade. What remains is
    // irreducible factory-wiring + re-export surface, not an extractable cohesive
    // cluster.
    //
    // COORD-094: the 1750 budget was set against an UNDER-counted LOC. countLoc
    // had a literal-blind comment stripper: an unbalanced `/*` inside a string
    // (e.g. `endsWith("/*")`, `coord/.runtime/plans/*.json`, `${id}/*`) opened a
    // phantom block comment that swallowed ~1600 real lines, so lifecycle.js was
    // once grandfathered at the old monolith ceiling. COORD-397 extracted the
    // remaining command/helper clusters and ratcheted lifecycle.js to a measured
    // residual composition-root budget of 2600 logical LOC. The fail-closed
    // prodloc high-water below is the real growth guard; this size override is
    // the matching generic analyzer threshold.
    size: Object.freeze({
      maxLoc: 1500,
      severity: "warn",
      perFile: Object.freeze({ "lifecycle.js": 2600 }),
    }),
    // Per-function cyclomatic complexity budget (decision-point count + 1).
    complexity: Object.freeze({ maxComplexity: 15, severity: "warn" }),
    // Import boundaries: declared deny rules. Each rule is
    // { from, denyImport, message, exceptFrom? }: a file whose path includes
    // `from` (and does NOT include any `exceptFrom`) may not import a module
    // specifier matching `denyImport`. A derived repo may append its own rules.
    //
    // COORD-111 (open-core boundary): CORE modules MUST NOT import the
    // Enterprise-only subtree `coord/scripts/enterprise/**`; Enterprise MAY
    // import core. Expressed as one rule scoped to `coord/scripts/` with the
    // `enterprise/` subtree carved out via `exceptFrom` (so enterprise→core
    // imports are allowed and enterprise→enterprise sibling imports are not
    // self-flagged), denying any specifier that resolves into the enterprise
    // path. The real tree has ZERO core→enterprise imports, so this stays 0
    // findings; it fires the moment a core module reaches into enterprise/.
    // The rule is WARNING-FIRST at the arch-gate severity but the Community
    // release builder additionally runs a fail-closed enterprise-leak scan
    // (release/scan-enterprise-refs.sh) that hard-fails on any surviving
    // enterprise/ import or path reference.
    imports: Object.freeze({
      rules: Object.freeze([
        Object.freeze({
          from: "coord/scripts/",
          exceptFrom: "coord/scripts/enterprise/",
          denyImport: /(^|[./\\])enterprise\//,
          message: "core module must not import coord/scripts/enterprise/** (open-core boundary, COORD-111) — enterprise-only code may not be a dependency of the Community cut",
        }),
      ]),
      severity: "warn",
    }),
    // Duplicate code: a run of >= minLines normalized identical lines appearing
    // in >= 2 places is flagged. minLines kept high enough to avoid trivia.
    //
    // COORD-136 (Component-library convergence). The DEFAULT gate above is the
    // intra-repo signal and is INTENTIONALLY UNCHANGED (minLines 12, warn,
    // single corpus). The `extractionTuned` block is a SEPARATE, opt-in profile
    // — it does NOT alter the default thresholds. It is consumed only when a
    // caller explicitly selects the extraction-tuned mode (via
    // extractionTunedConfig() / runCrossRepoDuplication()), so existing
    // consumers of the default gate are unaffected. It is tuned to apply
    // EXTRACTION PRESSURE toward the shared package (packages/shared): a LOWER
    // minLines (more sensitive, catches smaller drifting copies) and it runs
    // over a CROSS-REPO corpus, flagging only duplication that crosses repo/dir
    // boundaries (e.g. frontend/ vs coord-ui vs backend/). Run in ratchet mode
    // (COORD-126) it is frictionless on pre-existing divergence and fails only
    // on NEW cross-repo duplication.
    duplication: Object.freeze({
      minLines: 12,
      severity: "warn",
      extractionTuned: Object.freeze({ minLines: 6, severity: "warn", crossRepoOnly: true }),
    }),
    // No-new-monolith: the hard "monolith" budget (above the size warn budget).
    // Absolute-budget form; growth-over-baseline is layered on top when a
    // baseline map is supplied to runChecks (optional).
    monolith: Object.freeze({ maxLoc: 5000, severity: "warn" }),
    // COORD-378 / COORD-395: production coord/scripts module LOC budget. Unlike
    // the generic size/monolith signals, this is fail-closed by default: new
    // production engine modules under coord/scripts/** must stay <= 1200 logical
    // LOC. Existing decomposition hotspots carry explicit high-water budgets at
    // their current measured size. These are growth caps, not grandfather
    // exemptions: any increase fails, and shrink-only decomposition can lower
    // the cap through deriveProductionModuleLocBudgets().
    prodloc: Object.freeze({
      maxLoc: 1200,
      severity: "fail",
      include: Object.freeze(["coord/scripts/"]),
      highWater: Object.freeze({
        "coord/scripts/lifecycle.js": 2599,
        "coord/scripts/governance-validation.js": 1310,
        "coord/scripts/journal.js": 1710,
        "coord/scripts/plan-records.js": 1871,
        "coord/scripts/governance-context.js": 1785,
        "coord/scripts/token-economics.js": 1515,
      }),
    }),
    // COORD-396: append-free composition roots. These files may receive narrow
    // wiring edits (imports, registry entries, exports), but newly-added
    // business/control-flow logic belongs in self-registering modules. This
    // check is DI-friendly and diff-aware: it only evaluates supplied
    // `addedLines`, so existing root contents do not become retroactive debt.
    compositionRoot: Object.freeze({
      severity: "fail",
      roots: Object.freeze([
        "coord/scripts/lifecycle.js",
        "coord/scripts/governance-validation.js",
      ]),
    }),
    // Hardcoding (config-seam leak, COORD-071). WARNING-FIRST, conservative.
    // Three sub-signals, each independently gateable but reported under one
    // check id:
    //   - absolute / filesystem paths in string literals (a config seam: paths
    //     belong in config, not inlined). `pathRe` matches the leak shape.
    //   - repeated magic strings: the SAME non-trivial string literal recurring
    //     in >= `minRepeats` distinct (file,line) sites across the scanned set
    //     should be a shared constant. Single occurrences are NOT flagged.
    //   - bare magic numbers in non-trivial positions, excluding the
    //     `allowNumbers` whitelist (0/1/-1/2/… are obvious-OK) and numbers that
    //     are part of a named-constant assignment (already centralized).
    // `minStringLen` ignores tiny strings; `maxNoiseLen` ignores giant blobs.
    hardcoding: Object.freeze({
      severity: "warn",
      minRepeats: 3,
      minStringLen: 8,
      maxNoiseLen: 120,
      allowNumbers: Object.freeze([0, 1, -1, 2, 10, 100, 1000, 24, 60, 1024]),
      detectPaths: true,
      detectRepeatedStrings: true,
      detectMagicNumbers: false,
      // Path leak shape: a POSIX/Windows absolute path or a repo-relative path
      // with >= 2 segments and a file-ish or dir-ish look. Kept as a string so
      // mergeConfig can carry it; compiled to RegExp at use.
      pathRe: "(^|[\\s'\"`(])(?:/[A-Za-z0-9_.-]+){2,}|[A-Za-z]:\\\\",
    }),
    // Dead code (unreferenced defs). WARNING-FIRST, ALWAYS advisory — a human
    // confirms before deletion, this check NEVER auto-fails. CRITICAL: this
    // detector proves ZERO references across the whole scanned repo (definition
    // site excluded) AND that the name is not reachable by dynamic dispatch
    // (cli.js command tables, `commands`/tool-registry string-keyed maps) or on
    // the `__testing` facade or exported. It prefers FALSE NEGATIVES.
    deadcode: Object.freeze({ severity: "warn" }),
  }),
  // Files matching any of these (relative-path) substrings are skipped by the
  // fs scan helpers (not by the pure analyzers). Tests/fixtures/vendored code.
  ignore: Object.freeze(["node_modules/", ".worktrees/", "/artifacts/", ".next/", ".test.js", ".min.js", "tsconfig.tsbuildinfo"]),
  // Extensions the scan helper picks up.
  extensions: Object.freeze([".js", ".mjs", ".cjs"]),
  // Gate mode (COORD-126). "absolute" (DEFAULT) preserves today's behavior: the
  // verdict fails on ANY fail-severity finding regardless of the base branch.
  // "ratchet" makes the gate baseline-aware: it computes the finding set on the
  // base ref and fails ONLY on findings NEW relative to the base, reporting
  // pre-existing findings as informational. Opt-in so nothing silently changes
  // for existing users; also selectable per-invocation via the CLI --ratchet
  // flag. The base ref is the repo's configured integration branch (resolved by
  // the caller) unless overridden with --baseline <ref>.
  archGate: "absolute",
  // COORD-284: arch-debt PREVENTION ratchet. In ratchet mode, a finding whose
  // `check` is listed here is treated as a HARD FAIL when it is NEW relative to
  // the baseline — even though its own configured severity stays "warn". This is
  // the seam that escalates monolith/size to fail-on-NEW at the submit gate while
  // keeping plain (absolute, non-ratchet) `classify` warning-first: existing
  // over-budget files are GRANDFATHERED (pre-existing, never fail) and only a
  // change that grows a file PAST budget vs the baseline turns the gate RED.
  // EMPTY by default so a bare `--ratchet` does not silently start failing; the
  // gate opts in via GATE_ARCH_CONFIG (archGate:"ratchet" + this list).
  ratchetFailOnNew: Object.freeze([]),
});

// Deep-ish merge of a partial override onto DEFAULT_CONFIG. Per-check overrides
// merge field-by-field; arrays (rules/ignore/extensions) replace wholesale.
function mergeConfig(override = {}) {
  const base = DEFAULT_CONFIG;
  const o = override && typeof override === "object" ? override : {};
  const checks = {};
  for (const name of CHECKS) {
    checks[name] = Object.assign({}, base.checks[name], (o.checks && o.checks[name]) || {});
  }
  return {
    checks,
    ignore: Array.isArray(o.ignore) ? o.ignore : base.ignore.slice(),
    extensions: Array.isArray(o.extensions) ? o.extensions : base.extensions.slice(),
    archGate: o.archGate === "ratchet" ? "ratchet" : base.archGate,
    ratchetFailOnNew: Array.isArray(o.ratchetFailOnNew)
      ? o.ratchetFailOnNew.slice()
      : base.ratchetFailOnNew.slice(),
  };
}

// ---------------------------------------------------------------------------
// Finding shape (THE COORD-083 CONTRACT):
//   { check, file, value, threshold, severity, message, line? }
//   - check:     one of CHECKS
//   - file:      the file path the finding is about (as given to the analyzer)
//   - value:     the measured value (LOC, complexity count, dup-block length…)
//   - threshold: the configured budget the value exceeded
//   - severity:  the configured severity for this check ("warn" | "fail")
//   - message:   a human-readable one-liner
//   - line:      (optional) the 1-based line the finding starts at, when known
// makeFinding centralizes the shape so all checks emit it identically.
// ---------------------------------------------------------------------------
function makeFinding({ check, file, value, threshold, severity, message, line }) {
  const f = { check, file, value, threshold, severity, message };
  if (line != null) f.line = line;
  return f;
}

// Strip JS comments (`//` line + `/* */` block) from a source string in a way
// that is ROBUST to comment markers appearing inside string and regex literals.
// COORD-094: the previous regex approach (`text.replace(/\/\*[\s\S]*?\*\//g)`)
// treated any `/*` as a block-comment opener even when it sat inside a string
// (e.g. `"coord/.runtime/plans/*.json"`, `endsWith("/*")`, the template literal
// `${id}/*`) or a regex. An unbalanced `/*` inside a literal would swallow
// hundreds of real lines as a phantom comment, mis-counting large files (it
// under-counted lifecycle.js by ~1600 LOC). This is a small character-by-char
// state machine over the four lexical contexts that can contain a `/*` or `//`:
//   - inside a single/double-quoted or template string
//   - inside a regex literal
//   - inside a line/block comment (the only contexts where markers count)
// Markers found inside strings/regex are emitted verbatim (NOT stripped) so the
// surrounding code line survives; only genuine comment spans are removed.
// Returns the source with comment characters replaced by spaces (newlines in a
// block comment are preserved so line numbering downstream is unaffected).
function stripComments(source) {
  const text = String(source == null ? "" : source);
  let out = "";
  // States: code | line (//) | block (/* */) | sq ('') | dq ("") | tpl (``) | re (//)
  let state = "code";
  // For regex detection we track the previous significant (non-space) token so
  // we can decide whether a `/` starts a regex or is a division operator.
  let prevSig = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; out += "  "; i += 1; continue; }
      if (ch === "/" && next === "*") { state = "block"; out += "  "; i += 1; continue; }
      if (ch === "'") { state = "sq"; out += ch; prevSig = ch; continue; }
      if (ch === "\"") { state = "dq"; out += ch; prevSig = ch; continue; }
      if (ch === "`") { state = "tpl"; out += ch; prevSig = ch; continue; }
      if (ch === "/" && regexCanStartAfter(prevSig)) { state = "re"; out += ch; continue; }
      out += ch;
      if (!/\s/.test(ch)) prevSig = ch;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; prevSig = ""; }
      else out += " ";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; out += "  "; i += 1; }
      else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    // string / template / regex bodies: copy verbatim, honoring escapes.
    out += ch;
    if (ch === "\\") { out += next == null ? "" : next; i += 1; continue; }
    if (state === "sq" && ch === "'") { state = "code"; prevSig = ch; }
    else if (state === "dq" && ch === "\"") { state = "code"; prevSig = ch; }
    else if (state === "tpl" && ch === "`") { state = "code"; prevSig = ch; }
    else if (state === "re" && ch === "/") { state = "code"; prevSig = ch; }
  }
  return out;
}

// A `/` begins a regex literal (not division) when the previous significant
// token is not a value-producing token. Heuristic but sufficient for stripping:
// after an identifier char, `)`, `]`, or a number, a `/` is division.
function regexCanStartAfter(prevSig) {
  if (prevSig === "") return true;
  return !/[A-Za-z0-9_$)\]]/.test(prevSig);
}

// Count "logical" lines of code in a source string: non-blank, non-comment.
// Lightweight: strips // line comments and /* */ block comments (literal-aware,
// see stripComments), then counts remaining non-empty lines. Good enough for a
// budget signal (not a metric we bill against). Returns { loc, total }.
function countLoc(source) {
  const text = String(source == null ? "" : source);
  const total = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const stripped = stripComments(text);
  let loc = 0;
  for (const raw of stripped.split(/\r?\n/)) {
    if (raw.trim().length > 0) loc += 1;
  }
  return { loc, total };
}

// --- size check (no-new-monolith, absolute budget) -------------------------
// Flags a file whose LOC exceeds the configured budget. Pure: takes the file
// path + source + threshold. `checkName` lets the monolith check reuse it.
function checkFileSize({ file, source, maxLoc, severity, checkName = "size", perFile }) {
  const findings = [];
  const { loc } = countLoc(source);
  // Per-file budget override (keyed by basename) takes precedence over the
  // global budget for the size check. The monolith check intentionally ignores
  // perFile — the hard monolith ceiling is not per-file negotiable.
  let effectiveMaxLoc = maxLoc;
  if (checkName === "size" && perFile && typeof perFile === "object") {
    const base = String(file || "").split(/[\\/]/).pop();
    if (Object.prototype.hasOwnProperty.call(perFile, base) && Number.isFinite(perFile[base])) {
      effectiveMaxLoc = perFile[base];
    }
  }
  if (loc > effectiveMaxLoc) {
    findings.push(makeFinding({
      check: checkName,
      file,
      value: loc,
      threshold: effectiveMaxLoc,
      severity,
      message: `${checkName === "monolith" ? "monolith" : "file"} ${file} is ${loc} LOC, over budget ${effectiveMaxLoc}`,
    }));
  }
  return findings;
}

function shouldCheckProductionModuleLoc(file, config = {}) {
  const norm = normalizeFindingFilePath(file);
  if (!norm.endsWith(".js") && !norm.endsWith(".mjs") && !norm.endsWith(".cjs")) return false;
  if (norm.endsWith(".test.js")) return false;
  if (norm.includes("/__fixtures__/")) return false;
  const include = Array.isArray(config.include) && config.include.length
    ? config.include
    : ["coord/scripts/"];
  return include.some((prefix) => norm.startsWith(normalizeFindingFilePath(prefix)));
}

function checkProductionModuleLocBudget({ file, source, config, severity }) {
  const cfg = config && typeof config === "object" ? config : {};
  if (!shouldCheckProductionModuleLoc(file, cfg)) return [];
  const norm = normalizeFindingFilePath(file);
  const highWater = cfg.highWater && typeof cfg.highWater === "object" ? cfg.highWater : {};
  const maxLoc = Number.isFinite(Number(cfg.maxLoc)) ? Number(cfg.maxLoc) : 1200;
  const threshold = Object.prototype.hasOwnProperty.call(highWater, norm)
    ? Number(highWater[norm])
    : maxLoc;
  const { loc } = countLoc(source);
  if (loc <= threshold) return [];
  return [makeFinding({
    check: "prodloc",
    file,
    value: loc,
    threshold,
    severity,
    message: `${norm} grew past its production-module high-water LOC budget ${threshold} (now ${loc}) — attribute the growth to the ticket and split before adding more engine surface`,
  })];
}

function deriveProductionModuleLocBudgets({ files = [], config } = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const maxLoc = Number.isFinite(Number(cfg.maxLoc)) ? Number(cfg.maxLoc) : 1200;
  const highWater = cfg.highWater && typeof cfg.highWater === "object" ? cfg.highWater : {};
  const next = {};
  for (const entry of Array.isArray(files) ? files : []) {
    const file = entry && entry.file;
    const source = entry && entry.source;
    if (!shouldCheckProductionModuleLoc(file, cfg)) continue;
    const norm = normalizeFindingFilePath(file);
    const currentCap = Object.prototype.hasOwnProperty.call(highWater, norm)
      ? Number(highWater[norm])
      : maxLoc;
    const { loc } = countLoc(source || "");
    next[norm] = Math.min(currentCap, Math.max(loc, maxLoc));
  }
  return next;
}

function isCompositionRootFile(file, config = {}) {
  const norm = normalizeFindingFilePath(file);
  const roots = Array.isArray(config.roots) && config.roots.length
    ? config.roots
    : ["coord/scripts/lifecycle.js", "coord/scripts/governance-validation.js"];
  return roots.map(normalizeFindingFilePath).includes(norm);
}

function normalizeAddedLineEntry(entry) {
  if (entry && typeof entry === "object") {
    return {
      text: String(entry.text == null ? entry.line || "" : entry.text),
      line: entry.lineNumber || entry.line || null,
    };
  }
  return { text: String(entry == null ? "" : entry), line: null };
}

function isAllowedCompositionRootWiringLine(line) {
  const t = String(line || "").trim();
  if (!t) return true;
  if (t === '"use strict";' || t === "'use strict';") return true;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) return true;
  if (/^[{}()[\],;]+$/.test(t)) return true;
  if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\([^)]*\);?$/.test(t)) return true;
  if (/^(const|let|var)\s+\{/.test(t)) return true;
  if (/^\}\s*=\s*require\([^)]*\);?$/.test(t)) return true;
  if (/^module\.exports\s*=\s*\{?$/.test(t)) return true;
  if (/^exports\.[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*;?$/.test(t)) return true;
  if (/^[A-Za-z_$][\w$]*,?$/.test(t)) return true;
  if (/^[A-Za-z_$][\w$]*:\s*[A-Za-z_$][\w$]*,?$/.test(t)) return true;
  if (/^["'][^"']+["']:\s*[A-Za-z_$][\w$]*,?$/.test(t)) return true;
  return false;
}

function checkCompositionRootAddedLogic({ file, addedLines = [], config, severity }) {
  const cfg = config && typeof config === "object" ? config : {};
  if (!isCompositionRootFile(file, cfg)) return [];
  const findings = [];
  for (const raw of Array.isArray(addedLines) ? addedLines : []) {
    const entry = normalizeAddedLineEntry(raw);
    if (isAllowedCompositionRootWiringLine(entry.text)) continue;
    findings.push(makeFinding({
      check: "compositionRoot",
      file,
      value: String(entry.text || "").trim().slice(0, 120),
      threshold: "wiring-only",
      severity,
      line: entry.line || undefined,
      message: `${normalizeFindingFilePath(file)} added non-wiring logic to a composition root; create a self-registering module instead`,
    }));
  }
  return findings;
}

// --- cyclomatic complexity check -------------------------------------------
// Lightweight per-function estimator: complexity = 1 + count of decision
// points (if / else if / for / while / case / catch / && / || / ?: / ??).
// We segment the source into function-ish bodies by `function` keyword and
// arrow-function / method openings, then count decision tokens within each.
// This is an ESTIMATE (zero-dep, no AST) — sufficient for a warning signal.
const DECISION_PATTERNS = [
  /\bif\s*\(/g,
  /\bfor\s*\(/g,
  /\bwhile\s*\(/g,
  /\bcase\s+/g,
  /\bcatch\s*\(/g,
  /&&/g,
  /\|\|/g,
  /\?\?/g, // nullish coalescing (a branch)
];

function estimateComplexity(bodySource) {
  let count = 1;
  for (const re of DECISION_PATTERNS) {
    const m = bodySource.match(re);
    if (m) count += m.length;
  }
  // Ternary `?` is counted separately AFTER removing `??` (nullish, already
  // counted) and `?.` (optional chaining, not a branch) so neither inflates
  // the ternary tally.
  const ternarySrc = bodySource.replace(/\?\?/g, "").replace(/\?\./g, "");
  const ternary = ternarySrc.match(/\?/g);
  if (ternary) count += ternary.length;
  return count;
}

// Control-flow keywords that lexically look like `name(...) {` but are NOT
// function definitions. COORD-094: the `name(...) {` method-shape alternation
// in the open-regex matched `if (...) {`, `for (...) {`, `while (...) {`,
// `switch (...) {`, `catch (...) {`, etc., attributing a whole block's decision
// points to a phantom "function" named after the keyword — inflating both the
// per-function complexity value AND the finding count. Reject these names.
const CONTROL_FLOW_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "return",
  "with", "function", "typeof", "void", "delete", "in", "of", "new",
  "await", "yield", "case", "default", "throw",
]);

// Extract candidate function bodies with their start line + name. Brace-matched
// from each function-opening token. Heuristic but stable for the gate signal.
// COORD-094: runs over comment/literal-stripped source so braces/parens inside
// strings, regex, and comments cannot derail the brace matcher or the name
// attribution; control-flow keywords are excluded as function names.
function extractFunctions(source) {
  const text = stripComments(String(source == null ? "" : source));
  const fns = [];
  // Match: `function name(` | `name(...) {` method | `=> {` arrow with name via assignment.
  const openRe = /(?:\bfunction\b\s*([A-Za-z0-9_$]*)\s*\([^)]*\)|([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g;
  let match;
  while ((match = openRe.exec(text)) !== null) {
    // The method-shape alternation (group 2) is the only one that can capture a
    // control-flow keyword as a "name". When it does, skip this match entirely
    // and resume scanning just past it — do NOT treat the block as a function.
    if (match[2] && CONTROL_FLOW_KEYWORDS.has(match[2])) {
      openRe.lastIndex = match.index + match[0].length;
      continue;
    }
    const name = match[1] || match[2] || match[3] || "(anonymous)";
    // Find the opening brace at/after the match end.
    let i = text.indexOf("{", match.index);
    if (i === -1) continue;
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = text.slice(i, j + 1);
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    // Track body span (offsets into the stripped text) so callers can compute
    // OWN complexity by excluding directly-nested function bodies.
    fns.push({ name, body, line, start: i, end: j + 1 });
    openRe.lastIndex = i + 1; // continue scanning (allows nested capture)
  }
  return fns;
}

// Per-function OWN cyclomatic complexity: the decision points lexically inside
// `fn` MINUS those that belong to functions nested directly within it. COORD-094:
// without this, an outer factory (e.g. createGovernanceValidation, which wires
// ~30 inner helpers) reported the SUM of every nested function's complexity
// (~383) instead of its own branching, grossly mis-attributing where the real
// cyclomatic hotspot lives. We subtract the immediate children's full body
// complexity (each child reported separately) so each finding reflects that
// function's own control flow.
function ownComplexity(fn, allFns) {
  let value = estimateComplexity(fn.body);
  // Immediate children: functions whose span is strictly inside fn's span and
  // not inside any other function that is itself inside fn.
  const inside = allFns.filter((o) => o !== fn && o.start > fn.start && o.end <= fn.end);
  const immediate = inside.filter((o) => !inside.some(
    (p) => p !== o && p.start <= o.start && p.end >= o.end,
  ));
  for (const child of immediate) {
    // estimateComplexity adds a base 1 per function; subtract the child's
    // decision points only (its body's complexity minus that base 1).
    value -= (estimateComplexity(child.body) - 1);
  }
  return value < 1 ? 1 : value;
}

function checkComplexity({ file, source, maxComplexity, severity }) {
  const findings = [];
  const fns = extractFunctions(source);
  for (const fn of fns) {
    const value = ownComplexity(fn, fns);
    if (value > maxComplexity) {
      findings.push(makeFinding({
        check: "complexity",
        file,
        value,
        threshold: maxComplexity,
        severity,
        message: `function ${fn.name} in ${file} has cyclomatic complexity ~${value}, over budget ${maxComplexity}`,
        line: fn.line,
      }));
    }
  }
  return findings;
}

// --- import boundary check -------------------------------------------------
// Declared boundary policy: each rule is { from, denyImport, message,
// exceptFrom? }. A file whose path includes `from` — and does NOT include any
// `exceptFrom` substring — may not import a module specifier matching
// `denyImport` (substring or RegExp). `exceptFrom` carves a sub-scope out of
// `from` (e.g. allow the enterprise/ subtree to import core while denying core
// modules from importing enterprise/). Detects require(...) and ES import.
function extractImports(source) {
  const text = String(source == null ? "" : source);
  const specs = [];
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const impRe = /\bimport\b[^'"]*['"]([^'"]+)['"]/g;
  let m;
  while ((m = reqRe.exec(text)) !== null) {
    specs.push({ spec: m[1], line: text.slice(0, m.index).split(/\r?\n/).length });
  }
  while ((m = impRe.exec(text)) !== null) {
    specs.push({ spec: m[1], line: text.slice(0, m.index).split(/\r?\n/).length });
  }
  return specs;
}

function importMatches(deny, spec) {
  if (deny instanceof RegExp) return deny.test(spec);
  return typeof deny === "string" && spec.includes(deny);
}

function checkImportBoundaries({ file, source, rules, severity }) {
  const findings = [];
  if (!Array.isArray(rules) || rules.length === 0) return findings;
  const applicable = rules.filter((r) => {
    if (!r || typeof r.from !== "string" || !file.includes(r.from)) return false;
    // exceptFrom carves a sub-scope out of `from`: a file inside the excluded
    // scope is NOT subject to this rule (e.g. enterprise/ may import core).
    if (r.exceptFrom != null) {
      const excl = Array.isArray(r.exceptFrom) ? r.exceptFrom : [r.exceptFrom];
      if (excl.some((e) => typeof e === "string" && file.includes(e))) return false;
    }
    return true;
  });
  if (applicable.length === 0) return findings;
  for (const imp of extractImports(source)) {
    for (const rule of applicable) {
      if (importMatches(rule.denyImport, imp.spec)) {
        findings.push(makeFinding({
          check: "imports",
          file,
          value: imp.spec,
          threshold: String(rule.denyImport),
          severity,
          message: rule.message || `${file} imports '${imp.spec}', disallowed from '${rule.from}'`,
          line: imp.line,
        }));
      }
    }
  }
  return findings;
}

// --- duplicate code check --------------------------------------------------
// Lightweight normalized-hash: for each file, slide a window of `minLines`
// normalized (trimmed, whitespace-collapsed, comment/blank-stripped) lines,
// hash each window, and flag windows whose hash appears in >= 2 distinct
// (file,line) locations. To stay actionable, OVERLAPPING duplicate windows in
// the same file are collapsed into ONE finding per duplicated REGION (a long
// identical block yields one finding, not one per sliding offset). Returns one
// finding per extra occurrence of each distinct region so the generator can
// point at each site.
function normalizeLine(line) {
  return line.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim();
}

function checkDuplication({ files, minLines, severity }) {
  // files: [{ file, source }]. Cross-file + intra-file duplicate detection.
  const windows = new Map(); // hash -> [{ file, line }] (window start lines)
  for (const { file, source } of files) {
    // Literal-aware comment strip (COORD-094) — a `/*` inside a string/regex
    // must not swallow real lines and corrupt the duplicate-window hashing.
    const noBlock = stripComments(String(source == null ? "" : source));
    const rawLines = noBlock.split(/\r?\n/);
    // Keep a parallel index of normalized non-empty lines -> original line no.
    const norm = [];
    rawLines.forEach((raw, idx) => {
      const n = normalizeLine(raw);
      if (n.length > 0) norm.push({ n, line: idx + 1 });
    });
    for (let i = 0; i + minLines <= norm.length; i += 1) {
      const block = norm.slice(i, i + minLines);
      const hash = crypto.createHash("sha1").update(block.map((b) => b.n).join("\n")).digest("hex");
      if (!windows.has(hash)) windows.set(hash, []);
      windows.get(hash).push({ file, line: block[0].line });
    }
  }

  // A duplicated window only matters if its hash appears at >= 2 distinct
  // (file,line) sites. Build the deduplicated site set, tagging each with its
  // hash group so we can pair an occurrence back to a canonical copy. Then
  // collapse OVERLAPPING sites within the same file (consecutive sliding
  // offsets of one long identical region) into a single region — so a long
  // identical block produces one region per occurrence, not one per offset.
  const sites = [];
  for (const [hash, locs] of windows) {
    // Distinct (file,line) within this hash group.
    const seen = new Set();
    const distinct = [];
    for (const loc of locs) {
      const key = `${loc.file}:${loc.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(loc);
    }
    if (distinct.length < 2) continue;
    distinct.forEach((loc) => sites.push({ hash, file: loc.file, line: loc.line }));
  }
  sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

  // Greedy overlap-merge within a file. A site that begins within `minLines`
  // of the previous region's start (same file) extends that region.
  const regions = [];
  for (const site of sites) {
    const prev = regions[regions.length - 1];
    // Merge when this site starts at or before the previous region's current
    // end line (start + span), i.e. the windows overlap or abut.
    if (prev && prev.file === site.file && site.line <= prev.start + prev.span) {
      prev.span = Math.max(prev.span, site.line - prev.start + minLines);
      continue;
    }
    regions.push({ file: site.file, start: site.line, span: minLines, hash: site.hash });
  }

  // Report each duplicate region against the canonical copy of ITS OWN hash
  // group, not a single global region. Regions of distinct hashes describe
  // unrelated duplicate blocks, so they must each reference their own
  // canonical site. Within a hash group the canonical copy is the group's
  // FIRST region (regions are file/line-sorted, so this is deterministic);
  // every subsequent region in that group emits one finding referencing it. A
  // hash group with a single surviving region (e.g. overlap-merge collapsed
  // sibling occurrences) duplicates nothing and yields no finding.
  const canonicalByHash = new Map();
  const findings = [];
  for (const r of regions) {
    const canonical = canonicalByHash.get(r.hash);
    if (!canonical) {
      canonicalByHash.set(r.hash, r);
      continue;
    }
    findings.push(makeFinding({
      check: "duplication",
      file: r.file,
      value: r.span,
      threshold: minLines,
      severity,
      message: `${r.span}-line block in ${r.file} duplicates ${canonical.file}:${canonical.start} (hash ${r.hash.slice(0, 8)})`,
      line: r.start,
    }));
  }
  return findings;
}

// --- extraction-tuned cross-repo duplication (COORD-136) -------------------
// The Component-library-convergence dimension. This is NOT a change to the
// default duplication gate — it is a SEPARATE, opt-in mode that pressures
// extraction toward the shared package (packages/shared). Two knobs differ from
// the default:
//   1. a LOWER minLines (more sensitive — catches smaller drifting copies that
//      the default minLines:12 misses); and
//   2. a CROSS-REPO corpus: files carry a `repo` tag and a duplicate is only
//      flagged when the duplicated block ALSO appears in a DIFFERENT repo (when
//      `crossRepoOnly` is set). Intra-repo duplication is the default gate's
//      job; this mode targets divergence ACROSS repo/dir boundaries
//      (frontend/ vs coord-ui vs backend/) — the signal that logic should live
//      in the shared package instead of being copied per repo.
//
// `files`: [{ file, source, repo }]. `repo` defaults to the leading path
// segment when omitted, so a corpus of repo-prefixed paths (e.g. "frontend/…",
// "backend/…") is grouped automatically. Reuses checkDuplication's region
// detection verbatim (so overlap-merge + per-hash canonical attribution are
// identical), then — in crossRepoOnly mode — keeps only findings whose region
// and its canonical copy live in DIFFERENT repos. The message is augmented with
// a "[cross-repo: A->B]" tag so the finding is self-explaining; the stable key
// (the region hash) is unchanged, so ratchet classification works as-is.
function repoOf(entry) {
  if (entry && typeof entry.repo === "string" && entry.repo.length > 0) return entry.repo;
  const norm = normalizeFindingFilePath(entry && entry.file);
  const seg = norm.split("/")[0];
  return seg || norm;
}

function checkCrossRepoDuplication({ files, minLines, severity, crossRepoOnly = true }) {
  const fileList = Array.isArray(files) ? files : [];
  // Map normalized file path -> repo so we can resolve the repo of both the
  // flagged region and its canonical copy (parsed from the finding message).
  const repoByFile = new Map();
  for (const entry of fileList) {
    repoByFile.set(normalizeFindingFilePath(entry.file), repoOf(entry));
  }
  const raw = checkDuplication({
    files: fileList.map((e) => ({ file: e.file, source: e.source })),
    minLines,
    severity,
  });
  const findings = [];
  for (const f of raw) {
    const dupRepo = repoByFile.get(normalizeFindingFilePath(f.file));
    // Parse the canonical "<file>:<line>" out of the message to find its repo.
    const m = /duplicates\s+(.+?):(\d+)\s+\(hash/.exec(String(f.message || ""));
    const canonicalFile = m ? normalizeFindingFilePath(m[1]) : null;
    const canonicalRepo = canonicalFile != null ? repoByFile.get(canonicalFile) : undefined;
    const crosses = dupRepo != null && canonicalRepo != null && dupRepo !== canonicalRepo;
    if (crossRepoOnly && !crosses) continue;
    findings.push(Object.assign({}, f, {
      message: crosses
        ? `${f.message} [cross-repo: ${canonicalRepo}->${dupRepo}] — extract to packages/shared`
        : f.message,
    }));
  }
  return findings;
}

// Build a config whose duplication gate is the EXTRACTION-TUNED profile (lower
// minLines + cross-repo mode) instead of the default. Everything else inherits
// from DEFAULT_CONFIG / the supplied override. This is how a caller opts into
// the tuned mode WITHOUT mutating the default duplication thresholds. The tuned
// numbers come from DEFAULT_CONFIG.checks.duplication.extractionTuned (override-
// able). Pair with archGate:"ratchet" (COORD-126) for the frictionless on-ramp.
function extractionTunedConfig(override = {}) {
  const base = mergeConfig(override);
  const tuned = (DEFAULT_CONFIG.checks.duplication.extractionTuned) || {};
  const o = override && typeof override === "object" ? override : {};
  const oTuned = (o.checks && o.checks.duplication && o.checks.duplication.extractionTuned) || {};
  const effective = Object.assign({}, tuned, oTuned);
  base.checks.duplication = Object.assign({}, base.checks.duplication, {
    minLines: effective.minLines,
    severity: effective.severity,
    extractionTuned: Object.assign({}, tuned, oTuned),
  });
  return base;
}

// --- hardcoding check (config-seam leaks) ----------------------------------
// Conservative, WARNING-FIRST detector for magic literals that should be
// config/constants. THREE sub-signals (each independently gateable):
//   1. absolute / filesystem paths inlined in string literals;
//   2. repeated magic strings (same literal in >= minRepeats distinct sites);
//   3. bare magic numbers (off by default — noisy; opt-in).
// Designed to catch genuine config-seam leaks (COORD-071), NOT to flood: it
// ignores obvious-OK literals, single occurrences, and (via the scan helpers)
// test files.

// Extract string literals ('...', "...", `...` without interpolation) and bare
// numeric literals from comment-stripped source, each with its 1-based line.
// Literal-aware: runs over stripComments output so markers inside comments are
// gone, but the string BODIES survive (stripComments copies them verbatim).
function extractLiterals(source) {
  const text = stripComments(String(source == null ? "" : source));
  const strings = [];
  const numbers = [];
  // Single/double/backtick strings. Backtick only when it contains no `${`
  // (an interpolated template is dynamic, not a hardcoded constant).
  const strRe = /(['"])((?:\\.|(?!\1).)*)\1|`([^`$\\]*)`/g;
  let m;
  while ((m = strRe.exec(text)) !== null) {
    const raw = m[2] != null ? m[2] : m[3];
    if (raw == null) continue;
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    strings.push({ value: raw, line });
  }
  // Bare numbers: a numeric token not glued to an identifier char before it
  // (so `v12` / `0x` hex handled). We capture decimals and integers.
  const numRe = /(^|[^A-Za-z0-9_$.])(-?\d+(?:\.\d+)?)(?![A-Za-z0-9_$])/g;
  while ((m = numRe.exec(text)) !== null) {
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    numbers.push({ value: n, raw: m[2], line });
    // step back so adjacent numbers separated by one delimiter are both seen
    numRe.lastIndex = m.index + m[0].length - 1;
  }
  return { strings, numbers };
}

// Per-file path + magic-number signals (pure). Repeated-string is cross-file
// and handled in checkRepeatedStrings.
function checkHardcodedLiterals({ file, source, config, severity }) {
  const findings = [];
  const minLen = config.minStringLen;
  const maxLen = config.maxNoiseLen;
  const { strings, numbers } = extractLiterals(source);

  if (config.detectPaths) {
    const pathRe = config.pathRe instanceof RegExp ? config.pathRe : new RegExp(config.pathRe);
    for (const s of strings) {
      if (s.value.length < minLen || s.value.length > maxLen) continue;
      // Reject obvious-OK: pure URLs (scheme://) are routing config, not a
      // filesystem leak; module specifiers (./ ../) are imports, not config;
      // multi-line strings or prose (a path mentioned inside a sentence) are
      // not inline-path config leaks — only flag literals that ARE essentially
      // a path (no newline, no embedded sentence whitespace).
      if (/[\r\n]/.test(s.value)) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s.value)) continue;
      if (/^\.\.?\//.test(s.value)) continue;
      if (/\s/.test(s.value)) continue; // a real path token has no spaces
      if (pathRe.test(s.value)) {
        findings.push(makeFinding({
          check: "hardcoding",
          file,
          value: s.value.length > 48 ? s.value.slice(0, 45) + "..." : s.value,
          threshold: "no-inline-path",
          severity,
          message: `hardcoded path literal in ${file}: "${s.value.length > 60 ? s.value.slice(0, 57) + "..." : s.value}" — move to config/constant`,
          line: s.line,
        }));
      }
    }
  }

  if (config.detectMagicNumbers) {
    const allow = new Set((config.allowNumbers || []).map(Number));
    for (const num of numbers) {
      if (allow.has(num.value)) continue;
      findings.push(makeFinding({
        check: "hardcoding",
        file,
        value: num.value,
        threshold: "named-constant",
        severity,
        message: `magic number ${num.raw} in ${file} — extract to a named constant`,
        line: num.line,
      }));
    }
  }
  return findings;
}

// Obvious-OK filter for the repeated-string sub-signal. A string is a genuine
// shared-constant candidate ("repeatable leak") only when it is NOT:
//   - punctuation/whitespace-only (no alphanumerics);
//   - a URL (routing config, lives elsewhere);
//   - a module specifier (require/import arg — that IS the import surface);
//   - a template-interpolation fragment (`${...}` placeholder text bleeding out
//     of a template literal; not a real constant);
//   - a known directive/format token ("use strict", printf-ish "%s" blobs);
//   - a path-ish specifier (`./`, `../`, ends with `.js`/`.json` — module ref).
// Conservative by design: a missed shared-string (false negative) is fine; a
// flagged import path (false positive) is noise we must avoid.
function isRepeatableLeak(v, moduleSpecs) {
  if (!/[A-Za-z0-9]/.test(v)) return false;
  if (/[\r\n]/.test(v)) return false;                        // multi-line code/doc blob, not a constant
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;      // URL
  if (/^\.\.?\//.test(v)) return false;                      // ./ or ../ module path
  if (/^[A-Za-z0-9_@./-]+\.(?:js|mjs|cjs|json|ts)$/.test(v)) return false; // file/module ref
  if (/^[a-z]+:[A-Za-z0-9_./-]+$/.test(v)) return false;     // node: builtins, scoped specifiers
  if (moduleSpecs && moduleSpecs.has(v)) return false;       // any require/import arg
  if (/\$\{/.test(v)) return false;                          // template-interpolation fragment
  if (v === "use strict") return false;                      // directive prologue
  if (/^%[sdj%]/.test(v) || /^[-+\s]*$/.test(v)) return false; // format/separator tokens
  if (/^--?[A-Za-z]/.test(v)) return false;                  // CLI flag token (shared vocab)
  if (/^<[^>]+>$/.test(v)) return false;                     // <placeholder> usage token
  // Single bare-word token (no whitespace, identifier/enum/flag-shaped) is the
  // codebase's SHARED VOCABULARY — status enums, command verbs, state keys —
  // which are legitimately repeated and usually already centralized. The
  // config-seam concern is about leaked VALUES (paths, structured sentinels,
  // multi-word messages), not the enum lexicon. Require either whitespace (a
  // phrase/message) or a path-ish separator to qualify as a leak. This is the
  // dominant noise control: it prefers false negatives over flooding.
  if (!/\s/.test(v) && !/[\/\\]/.test(v)) return false;
  return true;
}

// Cross-file repeated magic strings: the SAME non-trivial string literal
// recurring in >= minRepeats distinct (file,line) sites should be a shared
// constant. Ignores obvious-OK literals (status/enum-style short tokens are
// excluded by minStringLen; whitespace-only / format-template strings filtered).
function checkRepeatedStrings({ files, config, severity }) {
  if (!config.detectRepeatedStrings) return [];
  const minLen = config.minStringLen;
  const maxLen = config.maxNoiseLen;
  const minRepeats = config.minRepeats;
  // Collect the set of module specifiers (require/import args) per corpus so we
  // never flag a shared dependency path as a "magic string" — those ARE the
  // canonical import surface, not a config-seam leak.
  const moduleSpecs = new Set();
  for (const { source } of files) {
    for (const imp of extractImports(source)) moduleSpecs.add(imp.spec);
  }
  const occ = new Map(); // value -> [{ file, line }]
  for (const { file, source } of files) {
    const { strings } = extractLiterals(source);
    const seenInFile = new Set();
    for (const s of strings) {
      const v = s.value;
      if (v.length < minLen || v.length > maxLen) continue;
      if (!isRepeatableLeak(v, moduleSpecs)) continue;
      // Count at most one occurrence per (file,line) but allow multi-file +
      // multi-line repetition within a file to count distinctly.
      const key = `${file}:${s.line}`;
      if (seenInFile.has(key)) continue;
      seenInFile.add(key);
      if (!occ.has(v)) occ.set(v, []);
      occ.get(v).push({ file, line: s.line });
    }
  }
  const findings = [];
  for (const [value, sites] of occ) {
    if (sites.length < minRepeats) continue;
    // Report ONE finding, at the first site, summarizing the repetition. This
    // keeps it low-noise (one ticket per shared-constant opportunity).
    const first = sites[0];
    const where = sites.map((s) => `${s.file}:${s.line}`).slice(0, 6).join(", ");
    findings.push(makeFinding({
      check: "hardcoding",
      file: first.file,
      value: sites.length,
      threshold: minRepeats,
      severity,
      message: `repeated string literal "${value.length > 40 ? value.slice(0, 37) + "..." : value}" appears ${sites.length}x (${where}${sites.length > 6 ? ", …" : ""}) — extract to a shared constant`,
      line: first.line,
    }));
  }
  return findings;
}

// --- dead code check (unreferenced defs; dispatch/facade/export-aware) -------
// CRITICAL false-positive avoidance: a naive "defined but the name does not
// appear elsewhere" scan is useless here because most coord defs are LIVE via
// dynamic dispatch (cli.js command tables, the `commands` map, governance-mcp
// tool registries reference functions by string key), the `__testing` facade,
// or `module.exports`. This detector therefore proves, across the WHOLE scanned
// set:
//   (a) the definition name has ZERO references anywhere except its own
//       definition site (counting both bare-identifier uses AND string-key uses
//       like `"fnName"` / `'fnName'` so dispatch-by-string keeps it live); and
//   (b) the name is not exported (`module.exports`/factory return/`__testing`).
// Only names passing BOTH are flagged. Prefers FALSE NEGATIVES (we'd rather
// miss a dead fn than wrongly flag a live one). Always severity "warn".

// Extract TOP-LEVEL function/const definitions (name + line) from one file.
// Top-level = column-0 (no leading indentation) `function name`, `const/let/var
// name =`, or `async function name`. Nested/local defs are intentionally NOT
// scanned (too noisy; lower confidence). Returns [{ name, line, file }].
function extractTopLevelDefs(source, file) {
  const text = stripComments(String(source == null ? "" : source));
  const defs = [];
  const lines = text.split(/\r?\n/);
  const defRe = /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)|^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/;
  lines.forEach((raw, idx) => {
    const m = defRe.exec(raw);
    if (!m) return;
    const name = m[1] || m[2];
    if (!name) return;
    defs.push({ name, line: idx + 1, file });
  });
  return defs;
}

// Build a repo-wide reference index: for a given identifier, does it appear
// (as a bare identifier token OR inside a string literal as a dispatch key)
// anywhere in the corpus beyond `count` times. We pre-tokenize each file once.
// References counted from comment-stripped source EXCEPT we also scan string
// bodies (kept verbatim by stripComments) so `commands["fnName"]` counts.
function buildReferenceIndex(files) {
  // identifier token -> total occurrence count across corpus (incl. defs)
  const idCount = new Map();
  // string-literal token (exact body) -> count, for dispatch-by-string keys
  const strCount = new Map();
  for (const { source } of files) {
    const text = stripComments(String(source == null ? "" : source));
    const idRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let m;
    while ((m = idRe.exec(text)) !== null) {
      idCount.set(m[0], (idCount.get(m[0]) || 0) + 1);
    }
    const { strings } = extractLiterals(source);
    for (const s of strings) {
      strCount.set(s.value, (strCount.get(s.value) || 0) + 1);
    }
  }
  return { idCount, strCount };
}

function checkDeadCode({ files, referenceFiles, severity }) {
  const findings = [];
  // The reference index is built over the BROADER corpus (referenceFiles) when
  // given so cross-subtree references (e.g. coord/board referencing a
  // coord/scripts def) keep the def live. Defs are only FLAGGED for files in
  // `files` (the scanned subtree). When referenceFiles is omitted the index is
  // the scanned files themselves (whole-repo scan: identical).
  const refCorpus = Array.isArray(referenceFiles) && referenceFiles.length ? referenceFiles : files;
  const { idCount, strCount } = buildReferenceIndex(refCorpus);
  for (const { file, source } of files) {
    const defs = extractTopLevelDefs(source, file);
    for (const def of defs) {
      // (a) bare-identifier references: the def-site counts as exactly 1
      // occurrence. If the identifier appears MORE than once anywhere in the
      // corpus, it is referenced somewhere — LIVE. (Conservative: a same-named
      // local in another file also keeps it live -> false negative, accepted.)
      if ((idCount.get(def.name) || 0) > 1) continue;
      // (b) dispatch-by-string: if the name appears as a string-literal body
      // anywhere (command table / tool registry key), it is LIVE.
      if ((strCount.get(def.name) || 0) > 0) continue;
      // Survivors: zero references beyond the single definition site AND not a
      // dispatch string key AND (by virtue of idCount===1) not on module.exports
      // / __testing facade / factory return (those are extra references). FLAG.
      findings.push(makeFinding({
        check: "deadcode",
        file,
        value: def.name,
        threshold: "0-refs",
        severity,
        message: `'${def.name}' in ${file} is defined but never referenced (no bare-identifier use, not exported, not a dispatch-table key) — verify before deleting`,
        line: def.line,
      }));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Stable finding key (COORD-126). A DETERMINISTIC identity for a finding that
// is stable across UNRELATED edits — specifically it does NOT depend on the
// raw measured `value` (LOC drifts on every edit) nor, where avoidable, on the
// raw line number (which shifts when unrelated lines are inserted above). This
// is the key the baseline-aware (ratchet) gate diffs on, and the SAME key
// quality-scan.js uses for board dedup (it delegates here so the two never
// drift). Form: `check:normalized-file:detail`.
//   - size/monolith : identity is the file (one budget finding per file) -> "loc"
//   - complexity     : identity is the function NAME (parsed from message), so a
//                      function staying over budget keeps its key even if it
//                      moves down the file; falls back to the start line only
//                      when the name is anonymous.
//   - imports        : identity is the disallowed import specifier.
//   - duplication    : identity is the duplicate-region HASH embedded in the
//                      message (stable while the duplicated TEXT is unchanged,
//                      regardless of where it sits) -> "dup:<hash>".
//   - hardcoding     : identity is the literal value (path/repeat-count) + line.
//                      Path/repeated-string leaks key on the value; this keeps a
//                      leak's identity tied to WHAT leaked, not the churny count.
//   - deadcode       : identity is the unreferenced symbol name.
// ---------------------------------------------------------------------------
function normalizeFindingFilePath(file) {
  return String(file == null ? "" : file).replace(/\\/g, "/").replace(/^\.\//, "");
}

function stableFindingDetail(finding) {
  switch (finding.check) {
    case "size":
    case "monolith":
    case "prodloc":
      return "loc";
    case "compositionRoot":
      return `added:${crypto.createHash("sha1").update(String(finding.value || "")).digest("hex").slice(0, 12)}`;
    case "complexity": {
      const m = /function\s+(\S+)\s+in/.exec(String(finding.message || ""));
      const fn = m ? m[1] : `line${finding.line || 0}`;
      return `fn:${fn}`;
    }
    case "imports":
      return `imp:${normalizeFindingFilePath(finding.value)}`;
    case "duplication": {
      const m = /hash\s+([0-9a-f]+)/.exec(String(finding.message || ""));
      return m ? `dup:${m[1]}` : `dup:line${finding.line || 0}`;
    }
    case "hardcoding":
      // Identity = WHAT leaked (the literal / repeat-count value) keyed with the
      // line so the same leak at the same site round-trips, but an unrelated
      // line shift elsewhere does not reclassify other findings. The value is
      // the dominant component; line disambiguates same-value leaks in one file.
      return `hc:${normalizeFindingFilePath(String(finding.value))}:line${finding.line || 0}`;
    case "deadcode":
      return `dead:${String(finding.value)}`;
    default:
      return String(finding.value);
  }
}

function stableFindingKey(finding) {
  return `${finding.check}:${normalizeFindingFilePath(finding.file)}:${stableFindingDetail(finding)}`;
}

// ---------------------------------------------------------------------------
// Baseline classification (COORD-126). Given the CURRENT finding set and the
// BASE finding set (computed on the integration/base ref), partition the
// current findings into NEW (key absent from the base) and PRE-EXISTING (key
// present on the base). PURE — callers supply both finding arrays. Keyed by
// stableFindingKey so unrelated churn (line shifts, LOC drift) does not
// reclassify a pre-existing finding as new.
//   { newFindings, preExistingFindings, baseKeys, currentKeys }
// ---------------------------------------------------------------------------
function classifyFindingsAgainstBaseline(currentFindings = [], baseFindings = []) {
  const baseKeys = new Set();
  for (const f of baseFindings) baseKeys.add(stableFindingKey(f));
  const newFindings = [];
  const preExistingFindings = [];
  const currentKeys = new Set();
  for (const f of currentFindings) {
    const key = stableFindingKey(f);
    currentKeys.add(key);
    if (baseKeys.has(key)) preExistingFindings.push(f);
    else newFindings.push(f);
  }
  return { newFindings, preExistingFindings, baseKeys, currentKeys };
}

// Ratchet verdict (COORD-126). In ratchet mode the gate fails ONLY on findings
// that are NEW relative to the base AND carry severity "fail"; pre-existing
// findings (any severity) and warn-class new findings are informational. The
// shape mirrors summarizeFindings + adds the new/pre-existing accounting so the
// runner can report both. `summarizeFindings` (absolute mode) is unchanged.
function summarizeRatchet(currentFindings, cfg, fileCount, baseFindings) {
  const { newFindings, preExistingFindings } = classifyFindingsAgainstBaseline(
    currentFindings,
    baseFindings,
  );
  const base = summarizeFindings(currentFindings, cfg, fileCount);
  // COORD-284: checks listed in cfg.ratchetFailOnNew are escalated to a HARD FAIL
  // when NEW vs the baseline, regardless of their own (warn) severity. This is
  // how monolith/size become fail-on-NEW under the ratchet without flipping their
  // absolute-mode severity (plain classify + the no-baseline fallback stay warn).
  const failOnNew = Array.isArray(cfg && cfg.ratchetFailOnNew) ? cfg.ratchetFailOnNew : [];
  let newFailCount = 0;
  let newWarnCount = 0;
  for (const f of newFindings) {
    if (f.severity === "fail" || failOnNew.includes(f.check)) newFailCount += 1;
    else if (f.severity === "warn") newWarnCount += 1;
  }
  let result;
  if (newFailCount > 0) result = "fail";
  else if (newFindings.length > 0) result = "warn";
  else result = "pass";
  return Object.assign({}, base, {
    mode: "ratchet",
    result,
    new: newFindings.length,
    preExisting: preExistingFindings.length,
    newFailCount,
    newWarnCount,
  });
}

// ---------------------------------------------------------------------------
// runChecks: the top-level REUSABLE entry point. Takes a list of files
// (each { file, source }) + optional config override + optional baseline map.
// Returns { findings, summary } where summary = per-check counts + the overall
// classification. PURE: no fs access (caller supplies sources). This is the
// function COORD-083's generator calls directly.
//   - baseline: optional { [file]: locAtBaseline } for growth-over-baseline on
//     the monolith check (a file that grew past budget AND past its baseline).
// ---------------------------------------------------------------------------
function runChecks({ files = [], config, baseline, referenceFiles, baselineFindings } = {}) {
  const cfg = mergeConfig(config);
  const fileList = Array.isArray(files) ? files : [];
  const findings = [];

  for (const entry of fileList) {
    const file = entry.file;
    const source = entry.source;
    const c = cfg.checks;
    if (c.size.severity !== "off") {
      findings.push(...checkFileSize({ file, source, maxLoc: c.size.maxLoc, severity: c.size.severity, perFile: c.size.perFile }));
    }
    if (c.monolith.severity !== "off") {
      findings.push(...checkFileSize({
        file, source, maxLoc: c.monolith.maxLoc, severity: c.monolith.severity, checkName: "monolith",
      }));
    }
    if (c.prodloc && c.prodloc.severity !== "off") {
      findings.push(...checkProductionModuleLocBudget({
        file, source, config: c.prodloc, severity: c.prodloc.severity,
      }));
    }
    if (c.compositionRoot && c.compositionRoot.severity !== "off") {
      findings.push(...checkCompositionRootAddedLogic({
        file,
        addedLines: entry.addedLines || [],
        config: c.compositionRoot,
        severity: c.compositionRoot.severity,
      }));
    }
    if (c.complexity.severity !== "off") {
      findings.push(...checkComplexity({
        file, source, maxComplexity: c.complexity.maxComplexity, severity: c.complexity.severity,
      }));
    }
    if (c.imports.severity !== "off") {
      findings.push(...checkImportBoundaries({
        file, source, rules: c.imports.rules, severity: c.imports.severity,
      }));
    }
    if (c.hardcoding.severity !== "off") {
      findings.push(...checkHardcodedLiterals({
        file, source, config: c.hardcoding, severity: c.hardcoding.severity,
      }));
    }
  }
  if (cfg.checks.duplication.severity !== "off") {
    findings.push(...checkDuplication({
      files: fileList, minLines: cfg.checks.duplication.minLines, severity: cfg.checks.duplication.severity,
    }));
  }
  if (cfg.checks.hardcoding.severity !== "off") {
    findings.push(...checkRepeatedStrings({
      files: fileList, config: cfg.checks.hardcoding, severity: cfg.checks.hardcoding.severity,
    }));
  }
  if (cfg.checks.deadcode.severity !== "off") {
    // The reference index spans `referenceFiles` when supplied (a BROADER
    // corpus than the flagged subtree — e.g. the whole repo) so a def in
    // coord/scripts that is referenced from coord/board is NOT mis-flagged.
    // Defaults to the scanned files when no broader corpus is given.
    findings.push(...checkDeadCode({
      files: fileList,
      referenceFiles: Array.isArray(referenceFiles) && referenceFiles.length ? referenceFiles : fileList,
      severity: cfg.checks.deadcode.severity,
    }));
  }

  // COORD-126: in ratchet mode WITH a supplied base finding set, the verdict is
  // baseline-aware (fail only on NEW findings); otherwise absolute (unchanged).
  // The findings array itself is identical in both modes — only the summary
  // verdict + accounting differ — so every existing consumer of `findings`
  // (quality-scan, the coord-ui cockpit) is unaffected.
  const ratchet = cfg.archGate === "ratchet" && Array.isArray(baselineFindings);
  const summary = ratchet
    ? summarizeRatchet(findings, cfg, fileList.length, baselineFindings)
    : summarizeFindings(findings, cfg, fileList.length);
  return { findings, summary };
}

// ---------------------------------------------------------------------------
// runCrossRepoDuplication (COORD-136): the top-level entry point for the
// extraction-tuned, cross-repo duplication mode. PURE (no fs). Takes a corpus
// of repo-tagged files spanning MULTIPLE repos (each { file, source, repo }),
// runs ONLY the duplication dimension under the extraction-tuned profile (lower
// minLines + crossRepoOnly), and returns { findings, summary }. The verdict is
// ratchet-aware exactly like runChecks: pass `baselineFindings` (the same
// finding set computed on the base ref's corpus) and `archGate:"ratchet"` to
// fail only on NEW cross-repo duplication (COORD-126). This is the function a
// gate.sh step / quality-scan would call to enforce convergence pressure; it
// does NOT touch the default arch gate.
function runCrossRepoDuplication({ files = [], config, baselineFindings } = {}) {
  const cfg = extractionTunedConfig(config);
  const dup = cfg.checks.duplication;
  const fileList = Array.isArray(files) ? files : [];
  const findings = dup.severity === "off" ? [] : checkCrossRepoDuplication({
    files: fileList,
    minLines: dup.minLines,
    severity: dup.severity,
    crossRepoOnly: dup.extractionTuned ? dup.extractionTuned.crossRepoOnly !== false : true,
  });
  const ratchet = cfg.archGate === "ratchet" && Array.isArray(baselineFindings);
  const summary = ratchet
    ? summarizeRatchet(findings, cfg, fileList.length, baselineFindings)
    : summarizeFindings(findings, cfg, fileList.length);
  return { findings, summary };
}

// Classify findings into an overall gate result. WARNING-FIRST: the overall
// result is "fail" ONLY if at least one finding has severity "fail"; otherwise
// "warn" if there are any findings; otherwise "pass". Per-check counts are also
// returned for the grep-friendly summary line.
function summarizeFindings(findings, cfg, fileCount) {
  const byCheck = {};
  for (const name of CHECKS) byCheck[name] = 0;
  let failCount = 0;
  let warnCount = 0;
  for (const f of findings) {
    byCheck[f.check] = (byCheck[f.check] || 0) + 1;
    if (f.severity === "fail") failCount += 1;
    else if (f.severity === "warn") warnCount += 1;
  }
  let result;
  if (failCount > 0) result = "fail";
  else if (findings.length > 0) result = "warn";
  else result = "pass";
  return {
    result,
    files: fileCount,
    findings: findings.length,
    failCount,
    warnCount,
    byCheck,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// e.g. "arch: warn files=42 findings=3 (size=1 complexity=2 imports=0 dup=0 monolith=0)"
function formatArchSummary(summary) {
  const b = summary.byCheck || {};
  const body = `size=${b.size || 0} complexity=${b.complexity || 0} ` +
    `imports=${b.imports || 0} dup=${b.duplication || 0} monolith=${b.monolith || 0} prodloc=${b.prodloc || 0} ` +
    `compositionRoot=${b.compositionRoot || 0} hardcoding=${b.hardcoding || 0} deadcode=${b.deadcode || 0}`;
  // COORD-126: ratchet runs append the new/pre-existing split so the verdict is
  // self-explaining ("failed on 1 NEW finding; 3 pre-existing reported only").
  const ratchet = summary.mode === "ratchet"
    ? ` ratchet new=${summary.new} pre-existing=${summary.preExisting}`
    : "";
  return `arch: ${summary.result} files=${summary.files} findings=${summary.findings} (${body})${ratchet}`;
}

// ---------------------------------------------------------------------------
// fs scan helpers (thin wrappers; the only fs-touching code). Used by the CLI
// and importable by callers that want a repo scan rather than supplying files.
// ---------------------------------------------------------------------------
function isIgnored(relPath, ignore) {
  return ignore.some((frag) => relPath.includes(frag));
}

function collectFiles(root, cfg) {
  const out = [];
  const absRoot = path.resolve(root);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(absRoot, abs);
      if (isIgnored(rel + (ent.isDirectory() ? "/" : ""), cfg.ignore)) continue;
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        walk(abs);
      } else if (cfg.extensions.includes(path.extname(ent.name))) {
        out.push(abs);
      }
    }
  }
  walk(absRoot);
  return out;
}

// Scan a repo root and run all checks. Returns the same { findings, summary }
// shape as runChecks. Findings carry repo-relative file paths.
function scanRepo({ root, config, baseline, referenceRoot, baselineFindings, diffAddedLinesByFile } = {}) {
  const cfg = mergeConfig(config);
  const absRoot = path.resolve(root || ".");
  const readEntry = (absBase) => (abs) => ({
    file: path.relative(absBase, abs),
    source: (() => {
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return "";
      }
    })(),
    addedLines: (diffAddedLinesByFile && diffAddedLinesByFile[normalizeFindingFilePath(path.relative(absBase, abs))]) || [],
  });
  const files = collectFiles(absRoot, cfg).map(readEntry(absRoot));
  // referenceRoot (optional): a BROADER tree used only to build the dead-code
  // reference index, so scanning a subtree (e.g. coord/scripts) does not
  // mis-flag a def that is referenced from a sibling subtree (e.g. coord/board).
  // The reference corpus is read fresh from referenceRoot AND must include the
  // scanned files (with the SAME relative-path keys used in findings) so
  // def-site reference counting lines up. We tag reference entries with paths
  // relative to absRoot for the scanned subset; reference-only files use a
  // distinct path namespace (they are never flagged, only counted).
  let referenceFiles;
  if (referenceRoot) {
    const absRef = path.resolve(referenceRoot);
    referenceFiles = collectFiles(absRef, cfg).map(readEntry(absRoot));
  }
  return runChecks({ files, config, baseline, referenceFiles, baselineFindings });
}

function parseUnifiedDiffAddedLines(diffText) {
  const byFile = {};
  let file = null;
  let newLine = null;
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : normalizeFindingFilePath(target.replace(/^b\//, ""));
      if (file && !byFile[file]) byFile[file] = [];
      newLine = null;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLine = m ? Number(m[1]) : null;
      continue;
    }
    if (!file || newLine == null) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      byFile[file].push({ text: line.slice(1), lineNumber: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      // deletion: current-file line number does not advance
    } else {
      newLine += 1;
    }
  }
  return byFile;
}

function computeDiffAddedLines({ repoRoot, baseRef, timeoutMs = 60_000 } = {}) {
  const root = path.resolve(repoRoot || ".");
  const diff = spawnSyncForGit("git", ["diff", "--unified=0", "--no-ext-diff", baseRef, "--"], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (!diff || diff.status !== 0) {
    return { ok: false, reason: (diff && (diff.stderr || diff.error && diff.error.message)) || "git diff failed" };
  }
  return { ok: true, addedLinesByFile: parseUnifiedDiffAddedLines(diff.stdout || "") };
}

// COORD-126: compute the BASE finding set on a git ref WITHOUT mutating the
// working tree, by adding a throwaway `git worktree` checked out at the ref,
// scanning it with the SAME config, then removing the worktree. Every git op is
// BOUNDED by a timeout so a hung/slow git can never hang the gate. Returns
// { ok, findings, reason } — on ANY failure (no git, ref absent, shallow
// clone, timeout) it returns { ok:false, reason } and the caller falls back to
// absolute mode with a warning. NEVER throws to the caller; NEVER touches the
// live working tree (a separate worktree dir is used and always pruned).
function computeBaselineFindings({ repoRoot, baseRef, config, timeoutMs = 60_000 } = {}) {
  const root = path.resolve(repoRoot || ".");
  const git = (args, cwd) => spawnSyncForGit("git", args, { cwd: cwd || root, encoding: "utf8", timeout: timeoutMs });
  // Resolve the ref to a commit first — this is the cheap "is the base
  // reachable?" probe that catches offline/shallow/missing-base up front.
  const resolved = git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (!resolved || resolved.status !== 0 || !String(resolved.stdout || "").trim()) {
    return { ok: false, reason: `base ref "${baseRef}" could not be resolved (offline, shallow, or absent)` };
  }
  const commit = String(resolved.stdout).trim();
  const tmp = path.join(
    os.tmpdir(),
    `arch-baseline-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const added = git(["worktree", "add", "--detach", "--quiet", tmp, commit]);
  if (!added || added.status !== 0) {
    return { ok: false, reason: `could not create baseline worktree for ${baseRef}: ${(added && (added.stderr || added.error && added.error.message)) || "unknown"}` };
  }
  try {
    // Scan the SAME relative subtree the live scan covers so finding keys line
    // up. When --root is a SUBDIR of the repo (e.g. backend/ in this monorepo),
    // the worktree is a FULL repo checkout at `tmp`; comparing the subdir scan
    // against the whole-repo baseline would mis-key every file as NEW. Resolve
    // the subdir's path relative to the repo top and scan the matching subtree of
    // the worktree. Falls back to the worktree root when root IS the repo top (rel
    // == "") or the relative path can't be determined / escapes the tree.
    let scanRoot = tmp;
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top && top.status === 0 && String(top.stdout || "").trim()) {
      const rel = path.relative(String(top.stdout).trim(), root);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        scanRoot = path.join(tmp, rel);
      }
    }
    const { findings } = scanRepo({ root: scanRoot, config });
    return { ok: true, findings, commit };
  } catch (e) {
    return { ok: false, reason: `baseline scan failed: ${e && e.message ? e.message : e}` };
  } finally {
    // Always remove the throwaway worktree (force: it is detached + dirty-free).
    git(["worktree", "remove", "--force", tmp]);
  }
}

// COORD-284: resolve a DEFAULT baseline ref for ratchet mode when the caller did
// not pass an explicit --baseline. Tries, in order: the GATE_ARCH_BASELINE env
// override, then "origin/main", then "main" — returning the FIRST that resolves
// to a commit in `repoRoot`. Returns null when none resolve (offline, detached,
// no integration branch) so the caller can fall back to a NON-failing absolute
// pass with a logged note (the gate must never brick on a missing ref). NEVER
// throws (spawnSyncForGit swallows a missing/hung git into a non-zero status).
function resolveDefaultBaselineRef({ repoRoot, candidates, timeoutMs = 15_000 } = {}) {
  const root = path.resolve(repoRoot || ".");
  const refs = (Array.isArray(candidates) && candidates.length
    ? candidates
    : [process.env.GATE_ARCH_BASELINE, "origin/main", "main"]
  ).filter((r) => typeof r === "string" && r.length > 0);
  for (const ref of refs) {
    const r = spawnSyncForGit("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    if (r && r.status === 0 && String(r.stdout || "").trim()) return ref;
  }
  return null;
}

// Thin spawnSync wrapper kept as a named function so the worktree git calls are
// testable/mockable and never throw on a missing binary (returns the result
// object with a non-zero status / error instead).
function spawnSyncForGit(bin, args, opts) {
  try {
    return spawnSync(bin, args, opts);
  } catch (e) {
    return { status: 1, stdout: "", stderr: String(e && e.message ? e.message : e), error: e };
  }
}

// CLI: `node arch-checks.js classify [--root <dir>] [--config <json-file>]
//        [--ratchet] [--baseline <ref>]`
// Scans the root, prints the grep-friendly summary, and exits non-zero ONLY
// when the overall result is "fail" (i.e. a check escalated to fail fired).
// WARNING-FIRST: warn/pass both exit 0. Exit codes: 0 pass/warn, 1 fail,
// 2 usage/config error.
//
// COORD-126 baseline-aware (ratchet) mode: `--ratchet` (or archGate:"ratchet"
// in config) turns on baseline-aware gating; `--baseline <ref>` sets the base
// ref (defaults to the current branch's upstream / HEAD's merge base — here the
// CLI requires an explicit ref so the behavior is deterministic). The base
// finding set is computed in an isolated, bounded git worktree; if it can't be
// computed the gate falls back to ABSOLUTE mode with a clear warning (never
// hangs, never crashes).
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const sub = argv[0];
  if (sub !== "classify") {
    err.write("usage: arch-checks.js classify [--root <dir>] [--config <json-file>] [--ratchet] [--baseline <ref>]\n");
    return 2;
  }
  let root = ".";
  let configPath = null;
  let ratchet = false;
  let baselineRef = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1] != null) {
      root = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--config" && argv[i + 1] != null) {
      configPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--ratchet") {
      ratchet = true;
    } else if (argv[i] === "--baseline" && argv[i + 1] != null) {
      ratchet = true;
      baselineRef = argv[i + 1];
      i += 1;
    }
  }
  let config;
  if (configPath) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      err.write(`arch: ERROR could not read config ${configPath}: ${e.message}\n`);
      return 2;
    }
  }
  // Effective mode: CLI --ratchet/--baseline OR config archGate:"ratchet".
  const cfg = mergeConfig(config);
  const ratchetMode = ratchet || cfg.archGate === "ratchet";
  // The config the scan runs with must carry the effective mode so runChecks
  // honors it (the CLI flag wins over an absolute config).
  const effectiveConfig = ratchetMode ? Object.assign({}, config, { archGate: "ratchet" }) : config;

  let baselineFindings;
  let diffAddedLinesByFile;
  if (ratchetMode) {
    // COORD-284: with no explicit --baseline, auto-resolve a default integration
    // ref (GATE_ARCH_BASELINE | origin/main | main) instead of comparing against
    // HEAD (which would make NOTHING ever "new"). If none resolve, fall back to a
    // NON-failing absolute pass with a logged note so the gate never bricks.
    let baseRef = baselineRef;
    if (!baseRef) {
      baseRef = resolveDefaultBaselineRef({ repoRoot: root });
      if (baseRef) err.write(`arch: NOTE ratchet baseline auto-resolved to "${baseRef}"\n`);
    }
    if (!baseRef) {
      err.write("arch: WARNING ratchet requested but no baseline ref (GATE_ARCH_BASELINE, origin/main, main) is resolvable; falling back to absolute mode\n");
    } else {
      const base = computeBaselineFindings({ repoRoot: root, baseRef, config: effectiveConfig });
      if (base.ok) {
        baselineFindings = base.findings;
        const diff = computeDiffAddedLines({ repoRoot: root, baseRef });
        if (diff.ok) {
          diffAddedLinesByFile = diff.addedLinesByFile;
        } else {
          err.write(`arch: WARNING composition-root diff guard disabled: ${diff.reason}\n`);
        }
      } else {
        // Offline / no-base / shallow → fall back to ABSOLUTE with a clear warning.
        err.write(`arch: WARNING ratchet requested but ${base.reason}; falling back to absolute mode\n`);
      }
    }
  }

  const { summary } = scanRepo({
    root,
    config: baselineFindings ? effectiveConfig : config,
    baselineFindings,
    diffAddedLinesByFile,
  });
  out.write(formatArchSummary(summary) + "\n");
  return summary.result === "fail" ? 1 : 0;
}

module.exports = {
  CHECKS,
  SEVERITIES,
  DEFAULT_CONFIG,
  mergeConfig,
  makeFinding,
  stripComments,
  countLoc,
  // pure checks (DI-friendly):
  checkFileSize,
  shouldCheckProductionModuleLoc,
  checkProductionModuleLocBudget,
  deriveProductionModuleLocBudgets,
  isCompositionRootFile,
  isAllowedCompositionRootWiringLine,
  checkCompositionRootAddedLogic,
  estimateComplexity,
  extractFunctions,
  ownComplexity,
  checkComplexity,
  extractImports,
  checkImportBoundaries,
  checkDuplication,
  // extraction-tuned cross-repo duplication (COORD-136 — component-library convergence):
  repoOf,
  checkCrossRepoDuplication,
  extractionTunedConfig,
  runCrossRepoDuplication,
  extractLiterals,
  checkHardcodedLiterals,
  checkRepeatedStrings,
  extractTopLevelDefs,
  buildReferenceIndex,
  checkDeadCode,
  // aggregate entry points:
  runChecks,
  summarizeFindings,
  formatArchSummary,
  // baseline-aware (ratchet) gating (COORD-126):
  normalizeFindingFilePath,
  stableFindingDetail,
  stableFindingKey,
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
  parseUnifiedDiffAddedLines,
  computeDiffAddedLines,
  computeBaselineFindings,
  resolveDefaultBaselineRef,
  // fs scan helpers:
  collectFiles,
  scanRepo,
  runCli,
};

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {});
}
