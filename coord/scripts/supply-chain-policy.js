"use strict";

// COORD-133 (Quality dimension #3: Supply chain — SBOM + transitive-CVE scan).
// The THIRD EXTERNAL-tool-adapter dimension built per the dimension contract in
// coord/docs/QUALITY_DIMENSIONS.md (§2.3(b)/§3), mirroring COORD-131's
// mutation-policy.js and COORD-132's sast-policy.js. The gap it closes: the
// native arch-checks dimensions catch structural debt/drift, SAST catches unsafe
// source patterns, and `npm audit` catches *direct* advisories against the
// project's own manifest — but nothing emits an SBOM (a machine-readable
// inventory of every shipped component) or scans the FULL TRANSITIVE dependency
// closure for known CVEs the way a dedicated scanner (Trivy / Grype) does. This
// adapter does two things:
//   (a) SBOM EMISSION — a dependency-free CycloneDX (1.4) BOM generated directly
//       from the repo's package-lock.json (no external tool, no runtime dep).
//   (b) CVE SCAN — wraps Trivy or Grype (whichever resolves), BOUNDED, and turns
//       its JSON output into the uniform finding shape (one finding per
//       advisory×package×version), then applies a selectable verdict.
//
// This module is the SINGLE SOURCE OF TRUTH for the supply-chain policy, the same
// way audit-policy.js / coverage-policy.js / mutation-policy.js / sast-policy.js
// are for theirs. It is:
//   1. an ADAPTER  — emit a CycloneDX SBOM from the lockfile (dependency-free) AND
//                     run Trivy/Grype (BOUNDED, own process group), parsing its
//                     JSON into the uniform finding shape;
//   2. a VERDICT    — THRESHOLD (severity floor — fail on HIGH/CRITICAL) OR RATCHET
//                     (DEFAULT — fail only on NEW advisories vs a base ref), reusing
//                     COORD-126 classifyFindingsAgainstBaseline / summarizeRatchet
//                     from arch-checks.js — NOT re-implemented here;
//   3. EVIDENCE     — a one-line summary + a `supply_chain` field for the gate
//                     artifact (gate-artifact-schema.js), with a skip-reason when
//                     the CVE scanner is unavailable.
//
// THE OPTIONALITY CONSTRAINT IS PARAMOUNT (same as COORD-131/132). The engine has
// ZERO runtime deps and adopters MAY NOT have Trivy/Grype installed. So neither
// CycloneDX nor Trivy/Grype is added to ANY package.json, and none is bundled.
// The SBOM emitter is dependency-free (pure lockfile parsing), but the CVE-scan
// VERDICT is strictly tool-gated: detectTool() resolves Trivy or Grype and, when
// ABSENT, the CVE portion SKIPS GRACEFULLY (result "skip", never "fail"). A
// missing scanner must NEVER fail the gate, and the dimension is OPT-IN: it only
// RUNS when a repo explicitly enables it (GATE_SUPPLY_CHAIN_ENABLED=1 in gate.sh)
// AND a scanner binary resolves. Default = skipped, so the existing gate is
// unperturbed.
//
// Boundary: this module is pure policy + SBOM emission + scanner-output parsing +
// a bounded runner. It does NOT touch the board or the gate-artifact write
// (gate.sh owns that), and it NEVER commits a generated SBOM. It mirrors the
// other policy modules: single-source the policy ONCE in Node rather than
// re-typing it in bash on every repo.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  classifyFindingsAgainstBaseline,
  summarizeRatchet,
} = require("./arch-checks.js");

// Default bound for the heavy CVE-scan step (ms). A scanner over a large
// dependency closure (with a vuln-DB refresh) can be slow; this is generous but
// finite so a hung run can never block the gate. The COORD-129 process-group
// SIGKILL enforces it. Overridable via GATE_SUPPLY_CHAIN_TIMEOUT_MS.
const DEFAULT_SUPPLY_CHAIN_TIMEOUT_MS = 10 * 60 * 1000;

// Default severity floor for the `threshold` mode: any advisory at or above this
// severity fails. RATCHET is the default verdict (see classifySupplyChain);
// threshold is offered for repos that want an absolute severity bar instead. We
// floor at HIGH so HIGH + CRITICAL fail by default in threshold mode.
const DEFAULT_SUPPLY_CHAIN_THRESHOLD = "high";

// CVE severities, ranked. Both Trivy and Grype emit UPPERCASE severities
// (UNKNOWN/LOW/MEDIUM/HIGH/CRITICAL); CycloneDX/CVSS also use these. We rank them
// so the threshold mode and the fail/warn severity mapping are single-sourced.
const SEVERITY_RANK = Object.freeze({
  unknown: 0,
  negligible: 0,
  none: 0,
  low: 1,
  medium: 2,
  moderate: 2,
  high: 3,
  critical: 4,
});

function severityRank(sev) {
  return SEVERITY_RANK[String(sev || "").toLowerCase()] || 0;
}

// Map a raw scanner severity onto the uniform finding severity. An advisory at or
// above the fail floor is a fail-class supply-chain gap; everything below is warn.
function findingSeverity(rawSeverity) {
  return severityRank(rawSeverity) >= SEVERITY_RANK.high ? "fail" : "warn";
}

// ---------------------------------------------------------------------------
// 1. DETECTION — is a CVE scanner (Trivy or Grype) available?
// ---------------------------------------------------------------------------
// The dimension is OPT-IN (gate.sh gates it behind GATE_SUPPLY_CHAIN_ENABLED=1).
// The CVE portion is "available" when a Trivy OR Grype binary resolves. Like
// Semgrep, these are typically SYSTEM binaries (brew/apt/CI image), so we resolve
// them from PATH (TRIVY_BIN / GRYPE_BIN overrides) AND the repo-local
// node_modules/.bin (some adopters wrap them). When neither resolves we skip the
// CVE verdict gracefully (the SBOM emitter still works — it needs no tool). This
// is detection-only (no execution), safe + instant on every repo.
function defaultLookPath(bin, environ) {
  const PATH = (environ && environ.PATH) || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      if (fs.existsSync(full)) return full;
      if (process.platform === "win32" && fs.existsSync(full + ".exe")) return full + ".exe";
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return null;
}

// Resolve a single named scanner ("trivy" | "grype") via its env override, the
// repo-local node_modules/.bin, or PATH. Returns the resolved path or null.
function resolveScannerBin(name, repoRoot, { fileExists, lookPath, env } = {}) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  const environ = env || process.env;
  const overrideKey = `${name.toUpperCase()}_BIN`;
  if (environ[overrideKey] && exists(environ[overrideKey])) return environ[overrideKey];
  const local = path.join(repoRoot, "node_modules", ".bin", name);
  if (exists(local)) return local;
  if (exists(local + ".cmd")) return local + ".cmd";
  const onPath = (lookPath || defaultLookPath)(name, environ);
  if (onPath) return onPath;
  return null;
}

// Detect tool presence. Returns { available, tool, bin, reason }.
// `available` is true when EITHER Trivy or Grype resolves. Trivy is preferred
// when both are present (it is the more common CI scanner), but GATE_SUPPLY_CHAIN_SCANNER
// can force a specific one. `reason` explains a skip (no scanner) for the artifact.
function detectTool(repoRoot, deps = {}) {
  const environ = deps.env || process.env;
  const prefer = String(environ.GATE_SUPPLY_CHAIN_SCANNER || "").toLowerCase();
  const order = prefer === "grype" ? ["grype", "trivy"] : ["trivy", "grype"];
  for (const name of order) {
    const bin = resolveScannerBin(name, repoRoot, deps);
    if (bin) return { available: true, tool: name, bin, reason: null };
  }
  return {
    available: false,
    tool: null,
    bin: null,
    reason:
      "no CVE scanner installed (no trivy/grype on PATH / TRIVY_BIN / GRYPE_BIN / node_modules/.bin) — supply-chain CVE scan unavailable",
  };
}

// ---------------------------------------------------------------------------
// 2a. SBOM EMISSION — dependency-free CycloneDX (1.4) BOM from package-lock.json.
// ---------------------------------------------------------------------------
// npm v2/v3 lockfiles carry a flat `packages` map keyed by node_modules path
// ("" = the root project, "node_modules/foo" = a dependency). We walk it and emit
// one CycloneDX `component` per non-root package with a name + version, deriving a
// purl (package URL) so downstream scanners/consumers can match it. This is
// PURE + dependency-free: no external tool, no runtime dep — it is the
// "nice-to-have" emitter the ticket allows, kept entirely separate from the
// tool-gated CVE verdict so SBOM emission works on every repo.
function purlFor(name, version) {
  // CycloneDX/PackageURL npm purl: pkg:npm/<name>@<version>, with scope kept
  // (e.g. pkg:npm/@scope/pkg@1.0.0). We URL-do-not-encode the slash in a scope so
  // the purl stays human-readable and matches the common scanner expectation.
  return `pkg:npm/${name}@${version}`;
}

// Derive the package name from a lockfile `packages` key. The key is a path like
// "node_modules/@scope/pkg" or nested "node_modules/a/node_modules/b"; the name is
// the segment AFTER the LAST "node_modules/" (so nested deps resolve to their own
// name). Returns null for the root entry ("").
function nameFromLockKey(key) {
  if (!key) return null;
  const idx = key.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const tail = key.slice(idx + "node_modules/".length);
  return tail || null;
}

// Build a CycloneDX 1.4 SBOM object from a parsed package-lock.json. Returns the
// BOM object (caller serializes / writes it; this module NEVER writes the file to
// avoid committing generated output). Handles both lockfileVersion 2/3 (`packages`)
// and the legacy v1 (`dependencies`) shape. Deterministic component order (sorted
// by purl) so the BOM is reproducible across runs.
function buildCycloneDxSbom(lockJsonOrText, { rootName, rootVersion } = {}) {
  let lock = lockJsonOrText;
  if (typeof lock === "string") {
    if (!lock.trim()) return null;
    try {
      lock = JSON.parse(lock);
    } catch {
      return null;
    }
  }
  if (!lock || typeof lock !== "object") return null;

  const componentsByPurl = new Map();
  const addComponent = (name, version) => {
    if (!name || !version) return;
    const purl = purlFor(name, version);
    if (componentsByPurl.has(purl)) return; // de-dup identical name@version
    componentsByPurl.set(purl, {
      type: "library",
      name,
      version: String(version),
      purl,
      "bom-ref": purl,
    });
  };

  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === "") continue; // the root project, not a component
      if (!entry || typeof entry !== "object") continue;
      const name = entry.name || nameFromLockKey(key);
      addComponent(name, entry.version);
    }
  } else if (lock.dependencies && typeof lock.dependencies === "object") {
    // Legacy lockfileVersion 1: a (possibly nested) `dependencies` tree.
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps)) {
        if (!entry || typeof entry !== "object") continue;
        addComponent(name, entry.version);
        if (entry.dependencies && typeof entry.dependencies === "object") {
          walk(entry.dependencies);
        }
      }
    };
    walk(lock.dependencies);
  } else {
    return null; // not a recognizable npm lockfile
  }

  const components = Array.from(componentsByPurl.values()).sort((a, b) =>
    a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0,
  );

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    version: 1,
    metadata: {
      // No wall-clock timestamp here: a generated SBOM must be reproducible and we
      // never commit it, so we keep the BOM deterministic (the caller can add a
      // timestamp when emitting to a transient artifact path if desired).
      tools: [{ vendor: "coord", name: "supply-chain-policy", version: "1" }],
      component: {
        type: "application",
        name: rootName || (lock.packages && lock.packages[""] && lock.packages[""].name) || "root",
        version:
          rootVersion ||
          (lock.packages && lock.packages[""] && lock.packages[""].version) ||
          "0.0.0",
      },
    },
    components,
  };
}

// ---------------------------------------------------------------------------
// 2b. NORMALIZE + PARSE — Trivy / Grype JSON -> findings[].
// ---------------------------------------------------------------------------
// Both scanners emit JSON with a per-vulnerability record carrying an advisory id
// (CVE / GHSA), the affected package name, the installed version, and a severity.
// We normalize both shapes to the uniform finding, one finding per
// advisory×package×version (the documented stable key advisory-id:package:version).
//
// Trivy shape:  { Results: [ { Target, Vulnerabilities: [ { VulnerabilityID,
//   PkgName, InstalledVersion, Severity } ] } ] }
// Grype shape:  { matches: [ { vulnerability: { id, severity },
//   artifact: { name, version } } ] }
//
// Returns { findings, totals } or null when the payload is neither shape.
function normalizeAdvisoryId(id) {
  return String(id == null ? "" : id).trim().toUpperCase();
}
function normalizePackage(name) {
  return String(name == null ? "" : name).trim();
}
function normalizeVersion(version) {
  return String(version == null ? "" : version).trim();
}

// Build the packed finding.value so the arch-checks default-branch stable key
// (String(value)) yields the documented identity
// supply_chain:<package>:<advisory-id>::<version> — advisory + package + version,
// scanner/target/title omitted (churn-robust). NOTE: arch-checks keys on
// `<check>:<file>:<detail>`; we put the PACKAGE in finding.file so the key reads
// supply_chain:<package>:<advisory-id>::<version> which IS advisory-id:package:version
// reordered into the check:file:detail frame — the same three-tuple identity.
function packedValue(advisoryId, version) {
  return `${advisoryId}::${version}`;
}

function pushFinding(findings, totals, { advisoryId, pkg, version, severity }) {
  const id = normalizeAdvisoryId(advisoryId) || "UNKNOWN-ADVISORY";
  const name = normalizePackage(pkg) || "unknown-package";
  const ver = normalizeVersion(version) || "0.0.0";
  const sevToken = String(severity || "").toLowerCase();
  const sev = findingSeverity(sevToken);
  if (sev === "fail") totals.fail += 1;
  else totals.warn += 1;
  findings.push({
    check: "supply_chain",
    // file = the package name, so stableFindingKey reads
    // supply_chain:<package>:<advisory>::<version> (advisory:package:version).
    file: name,
    value: packedValue(id, ver),
    advisoryId: id,
    pkg: name,
    version: ver,
    severity: sev,
    level: sevToken,
    line: 0,
    message: `${id}: ${name}@${ver} (${sevToken || "unknown"})`,
  });
}

function parseScannerReport(reportJsonOrText) {
  let report = reportJsonOrText;
  if (typeof report === "string") {
    if (!report.trim()) return null;
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  if (!report || typeof report !== "object") return null;

  const findings = [];
  const totals = { total: 0, fail: 0, warn: 0 };

  // De-dup at the stable-key level: the same advisory on the same package@version
  // reported twice (e.g. across two scan targets) collapses to ONE finding.
  const seen = new Set();
  const dedupedPush = (rec) => {
    const id = normalizeAdvisoryId(rec.advisoryId) || "UNKNOWN-ADVISORY";
    const name = normalizePackage(rec.pkg) || "unknown-package";
    const ver = normalizeVersion(rec.version) || "0.0.0";
    const key = `${id}:${name}:${ver}`;
    if (seen.has(key)) return;
    seen.add(key);
    pushFinding(findings, totals, rec);
  };

  if (Array.isArray(report.Results)) {
    // Trivy.
    for (const result of report.Results) {
      const vulns = result && Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : [];
      for (const v of vulns) {
        dedupedPush({
          advisoryId: v.VulnerabilityID,
          pkg: v.PkgName,
          version: v.InstalledVersion,
          severity: v.Severity,
        });
      }
    }
  } else if (Array.isArray(report.matches)) {
    // Grype.
    for (const m of report.matches) {
      const vuln = (m && m.vulnerability) || {};
      const art = (m && m.artifact) || {};
      dedupedPush({
        advisoryId: vuln.id,
        pkg: art.name,
        version: art.version,
        severity: vuln.severity,
      });
    }
  } else {
    return null; // neither a Trivy nor a Grype report
  }

  totals.total = findings.length;
  return { findings, totals };
}

// stableFindingDetail for the supply-chain dimension. Identity = the advisory id +
// the installed version (with the package carried in finding.file), so the same
// CVE on the same package@version is ONE finding regardless of which scan target
// or scanner reported it. Reuses arch-checks.classifyFindingsAgainstBaseline /
// summarizeRatchet, whose stableFindingKey switches on finding.check and falls
// through to `String(finding.value)` for an unknown check. Because we pack
// "<advisory-id>::<version>" into finding.value and the package into finding.file,
// the default-branch key resolves to supply_chain:<package>:<advisory-id>::<version>
// — exactly the documented advisory-id:package:version three-tuple identity.
// supplyChainStableDetail is exported for tests asserting this property.
function supplyChainStableDetail(finding) {
  return String(finding.value || "UNKNOWN-ADVISORY::0.0.0");
}

// ---------------------------------------------------------------------------
// 3. BOUNDED RUNNER (COORD-129 process-group-kill). Spawns the scanner as its OWN
// process GROUP ({ detached: true }) so a negative-pid SIGKILL on timeout reaches
// the whole tree (scanners fork DB-fetch / worker children), bounds it with a
// timer, and SIGKILLs the group on timeout. Returns { status, timedOut, bound,
// stdout, stderr }. NEVER throws on a hung tool — it resolves with timedOut:true.
// `spawnImpl` is injectable so tests can prove the timeout path without a scanner.
// ---------------------------------------------------------------------------
function scannerArgs(tool, repoRoot) {
  if (tool === "grype") {
    // Scan the directory; emit JSON to stdout.
    return ["dir:" + (repoRoot || "."), "-o", "json"];
  }
  // Trivy filesystem scan; quiet, JSON to stdout.
  return ["fs", "--quiet", "--format", "json", repoRoot || "."];
}

function runScannerBounded(
  { bin, tool, repoRoot, timeoutMs } = {},
  deps = {},
) {
  const spawnImpl = deps.spawn || spawn;
  const killImpl = deps.kill || ((target, sig) => process.kill(target, sig));
  const bound = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_SUPPLY_CHAIN_TIMEOUT_MS;
  const args = scannerArgs(tool, repoRoot);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd: repoRoot,
        detached: true, // own process group → negative-pid kill reaches workers
        env: process.env,
      });
    } catch (err) {
      resolve({ status: null, timedOut: false, bound, stdout: "", stderr: String(err), spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills the scanner AND its worker /
      // DB-fetch grandchildren, releasing the inherited pipes so we never block.
      try { killImpl(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    if (timer.unref) timer.unref();
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, bound, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, timedOut, bound, stdout, stderr: `${stderr}\n${err}` });
    });
  });
}

// ---------------------------------------------------------------------------
// 4. VERDICT. Two selectable modes (mirroring sast-policy / mutation-policy):
//   - "ratchet" (DEFAULT): fail only on NEW advisories vs base (COORD-126), reusing
//                classifyFindingsAgainstBaseline + summarizeRatchet. So a repo with
//                legacy/un-upgradable transitive CVEs opts in without going red;
//                only NEWLY-introduced advisories block.
//   - "threshold": fail when any advisory's severity >= the configured floor
//                (default HIGH ⇒ HIGH + CRITICAL fail); for repos that want an
//                absolute severity bar.
// `baseFindings` is the advisory finding set on the base ref; supply [] when no
// base is available and the verdict degrades to "any new fail-class advisory
// fails". Ratchet is the default, consistent with sast-policy.
// ---------------------------------------------------------------------------
function classifySupplyChain({ parsed, mode = "ratchet", threshold, baseFindings } = {}) {
  if (!parsed) {
    return { mode, result: "skip", available: false, reason: "no CVE scan report" };
  }
  const findings = parsed.findings || [];
  const totals = parsed.totals || {};

  if (mode === "threshold") {
    const floor = String(threshold || DEFAULT_SUPPLY_CHAIN_THRESHOLD).toLowerCase();
    const floorRank = severityRank(floor) || SEVERITY_RANK.high;
    const atOrAbove = findings.filter((f) => severityRank(f.level) >= floorRank);
    return {
      mode: "threshold",
      result: atOrAbove.length > 0 ? "fail" : findings.length > 0 ? "warn" : "pass",
      available: true,
      threshold: floor,
      totals,
      atOrAbove: atOrAbove.length,
    };
  }

  // ratchet mode (DEFAULT). Reuse COORD-126 helpers verbatim. cfg/fileCount are
  // only used by summarizeRatchet for the absolute-mode passthrough fields; pass a
  // minimal cfg and the (package) count derived from the findings.
  const fileCount = new Set(findings.map((f) => f.file)).size;
  const summary = summarizeRatchet(findings, {}, fileCount, baseFindings || []);
  const split = classifyFindingsAgainstBaseline(findings, baseFindings || []);
  return {
    mode: "ratchet",
    result: summary.result, // "fail" only when a NEW fail-class advisory exists
    available: true,
    totals,
    new: summary.new,
    preExisting: summary.preExisting,
    newFailCount: summary.newFailCount,
    newFindings: split.newFindings.length,
    preExistingFindings: split.preExistingFindings.length,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// ratchet:   "supply-chain: fail mode=ratchet new=1 pre-existing=4 (advisories=5 fail=2 warn=3)"
// threshold: "supply-chain: pass mode=threshold floor=high at-or-above=0 (advisories=5 fail=0 warn=5)"
// skipped:   "supply-chain: skip (no CVE scanner installed ...)"
function formatSupplyChainSummary(classification, skipReason) {
  if (!classification || classification.result === "skip") {
    const reason = (classification && classification.reason) || skipReason || "skipped";
    return `supply-chain: skip (${reason})`;
  }
  const t = classification.totals || {};
  if (classification.mode === "threshold") {
    return (
      `supply-chain: ${classification.result} mode=threshold floor=${classification.threshold} ` +
      `at-or-above=${classification.atOrAbove} ` +
      `(advisories=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
    );
  }
  return (
    `supply-chain: ${classification.result} mode=ratchet ` +
    `new=${classification.newFindings} pre-existing=${classification.preExistingFindings} ` +
    `(advisories=${t.total || 0} fail=${t.fail || 0} warn=${t.warn || 0})`
  );
}

// ---------------------------------------------------------------------------
// runSupplyChainGate: the top-level adapter entry point that wires SBOM emission
// (dependency-free, best-effort) + detection -> bounded scan -> parse -> verdict.
// GRACEFUL by construction:
//   - scanner absent          => { result: "skip", reason } (NEVER fail)
//   - scanner ran but hung     => { result: "skip", reason: "timed out" } + the
//                                 process group was SIGKILLed (NEVER blocks/fails)
//   - scanner ran              => ratchet (default) / threshold verdict
// The SBOM is emitted (best-effort) whenever a lockfile is present and is returned
// on the result for the caller to write to a TRANSIENT artifact path — this module
// NEVER writes/commits it. `deps` injects spawn/kill/fileExists/lookPath/readReport/
// readLock for dependency-free tests.
// ---------------------------------------------------------------------------
function emitSbomBestEffort(repoRoot, deps = {}) {
  const readLock =
    deps.readLock ||
    ((root) => {
      try {
        return fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
      } catch {
        return null;
      }
    });
  const raw = readLock(repoRoot);
  if (!raw) return { sbom: null, reason: "no package-lock.json — SBOM not emitted" };
  const sbom = buildCycloneDxSbom(raw);
  if (!sbom) return { sbom: null, reason: "package-lock.json not parseable — SBOM not emitted" };
  return { sbom, reason: null };
}

async function runSupplyChainGate(
  { repoRoot, mode = "ratchet", threshold, baseFindings, timeoutMs } = {},
  deps = {},
) {
  // (a) SBOM emission is dependency-free and ALWAYS attempted (best-effort), so an
  // adopter gets an SBOM even when no CVE scanner is installed.
  const sbomResult = emitSbomBestEffort(repoRoot, deps);

  // (b) CVE verdict is strictly tool-gated.
  const detection = detectTool(repoRoot, deps);
  if (!detection.available) {
    return {
      ran: false,
      sbom: sbomResult.sbom,
      classification: { mode, result: "skip", available: false, reason: detection.reason },
      skipReason: detection.reason,
      summary: formatSupplyChainSummary({ result: "skip", reason: detection.reason }),
    };
  }

  const run = await runScannerBounded(
    { bin: detection.bin, tool: detection.tool, repoRoot, timeoutMs },
    deps,
  );

  if (run.timedOut) {
    const reason = `${detection.tool} exceeded ${run.bound}ms and its process group was SIGKILLed (COORD-129) — skipped, not failed`;
    return {
      ran: true,
      timedOut: true,
      sbom: sbomResult.sbom,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatSupplyChainSummary({ result: "skip", reason }),
    };
  }

  // Parse the scanner JSON from stdout. A missing/garbage payload degrades to a
  // graceful skip (never a fail). `readReport` is injectable so tests can supply a
  // fixture directly.
  const raw = deps.readReport ? deps.readReport(run) : run.stdout;
  const parsed = parseScannerReport(raw);
  if (!parsed) {
    const reason = `${detection.tool} produced no parseable JSON output — skipped, not failed`;
    return {
      ran: true,
      sbom: sbomResult.sbom,
      classification: { mode, result: "skip", available: false, reason },
      skipReason: reason,
      summary: formatSupplyChainSummary({ result: "skip", reason }),
    };
  }

  const classification = classifySupplyChain({ parsed, mode, threshold, baseFindings });
  return {
    ran: true,
    tool: detection.tool,
    sbom: sbomResult.sbom,
    classification,
    findings: parsed.findings,
    summary: formatSupplyChainSummary(classification),
  };
}

// CLI: `node supply-chain-policy.js classify --root <repo> [--mode ratchet|threshold]
//        [--threshold high|critical|...] [--timeout-ms N] [--base-report <path>]
//        [--sbom-out <path>]`
// Prints the one-line summary; exits non-zero ONLY on a hard "fail" verdict.
// A skip (scanner absent / hung / no output) exits 0 — a missing tool NEVER fails
// the gate. --base-report (ratchet mode) supplies the base ref's scanner report
// from which the base advisory set is parsed. --sbom-out writes the CycloneDX SBOM
// to a TRANSIENT path (opt-in; the gate never commits it).
function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  if (argv[0] !== "classify") {
    err.write(
      "usage: supply-chain-policy.js classify --root <repo> [--mode ratchet|threshold] " +
        "[--threshold <sev>] [--timeout-ms <n>] [--base-report <path>] [--sbom-out <path>]\n",
    );
    return Promise.resolve(2);
  }
  const opts = { mode: "ratchet" };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") { opts.repoRoot = argv[++i]; }
    else if (a === "--mode") { opts.mode = argv[++i]; }
    else if (a === "--threshold") { opts.threshold = argv[++i]; }
    else if (a === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); }
    else if (a === "--base-report") { opts.baseReportPath = argv[++i]; }
    else if (a === "--sbom-out") { opts.sbomOut = argv[++i]; }
  }
  if (!opts.repoRoot) {
    err.write("supply-chain: ERROR --root <repo> is required\n");
    return Promise.resolve(2);
  }
  // In ratchet mode, parse the base ref's report into the base advisory set.
  let baseFindings = [];
  if (opts.mode === "ratchet" && opts.baseReportPath) {
    try {
      const baseParsed = parseScannerReport(fs.readFileSync(opts.baseReportPath, "utf8"));
      baseFindings = baseParsed ? baseParsed.findings : [];
    } catch {
      baseFindings = [];
    }
  }
  return runSupplyChainGate(
    {
      repoRoot: opts.repoRoot,
      mode: opts.mode,
      threshold: opts.threshold,
      timeoutMs: opts.timeoutMs,
      baseFindings,
    },
    {},
  ).then((res) => {
    // Best-effort SBOM emission to a transient path when --sbom-out is given. The
    // gate NEVER commits this; it is a transient artifact only.
    if (opts.sbomOut && res.sbom) {
      try {
        fs.writeFileSync(opts.sbomOut, JSON.stringify(res.sbom, null, 2));
      } catch {
        /* transient write failure must not affect the verdict */
      }
    }
    out.write(res.summary + "\n");
    return res.classification.result === "fail" ? 1 : 0;
  });
}

module.exports = {
  DEFAULT_SUPPLY_CHAIN_TIMEOUT_MS,
  DEFAULT_SUPPLY_CHAIN_THRESHOLD,
  SEVERITY_RANK,
  severityRank,
  resolveScannerBin,
  detectTool,
  buildCycloneDxSbom,
  nameFromLockKey,
  purlFor,
  parseScannerReport,
  supplyChainStableDetail,
  classifySupplyChain,
  formatSupplyChainSummary,
  runScannerBounded,
  runSupplyChainGate,
  runCli,
};

if (require.main === module) {
  runCli(process.argv.slice(2), {}).then((code) => {
    process.exitCode = code;
  });
}
