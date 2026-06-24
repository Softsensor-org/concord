"use strict";

// COORD-133 (Quality dimension #3: Supply chain — CycloneDX SBOM + Trivy/Grype
// transitive-CVE scan). Tests for the EXTERNAL-tool-adapter. CRITICAL: this suite
// MUST NOT require Trivy/Grype/CycloneDX to be installed — every external
// interaction is a FAKE (injected spawn/kill/fileExists/lookPath/readReport/
// readLock) or a fixture scanner-JSON / lockfile payload. The engine keeps ZERO
// runtime deps and these tests prove the adapter is graceful when the scanner is
// absent, correct when it ran, and bounded when it hangs — and that the
// dependency-free SBOM emitter produces a valid CycloneDX shape from a fixture
// lockfile.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const {
  DEFAULT_SUPPLY_CHAIN_THRESHOLD,
  detectTool,
  buildCycloneDxSbom,
  nameFromLockKey,
  parseScannerReport,
  supplyChainStableDetail,
  classifySupplyChain,
  formatSupplyChainSummary,
  runScannerBounded,
  runSupplyChainGate,
  runCli,
} = require("./supply-chain-policy.js");

const { stableFindingKey } = require("./arch-checks.js");

// ---------------------------------------------------------------------------
// Fixtures: realistic Trivy + Grype CVE JSON payloads, and an npm v3 lockfile.
// ---------------------------------------------------------------------------
function trivyReport(vulns) {
  return {
    SchemaVersion: 2,
    Results: [
      {
        Target: "package-lock.json",
        Vulnerabilities: vulns.map((v) => ({
          VulnerabilityID: v.id,
          PkgName: v.pkg,
          InstalledVersion: v.version,
          Severity: v.severity || "HIGH",
        })),
      },
    ],
  };
}

function grypeReport(vulns) {
  return {
    matches: vulns.map((v) => ({
      vulnerability: { id: v.id, severity: v.severity || "High" },
      artifact: { name: v.pkg, version: v.version },
    })),
  };
}

const FIXTURE_LOCKFILE = {
  name: "demo-app",
  version: "1.2.3",
  lockfileVersion: 3,
  packages: {
    "": { name: "demo-app", version: "1.2.3" },
    "node_modules/lodash": { version: "4.17.21" },
    "node_modules/express": { version: "4.18.2" },
    "node_modules/@scope/util": { version: "2.0.0" },
    // a nested transitive dep resolves to its own name (after the LAST node_modules/)
    "node_modules/express/node_modules/ms": { version: "2.0.0" },
  },
};

// ---------------------------------------------------------------------------
// 1. DETECTION + GRACEFUL SKIP — the #1 requirement: a missing scanner NEVER fails.
// ---------------------------------------------------------------------------
test("detectTool: skips when neither Trivy nor Grype resolves (CVE scanner unavailable)", () => {
  const d = detectTool("/repo", { fileExists: () => false, lookPath: () => null, env: {} });
  assert.equal(d.available, false);
  assert.match(d.reason, /no CVE scanner installed/);
});

test("detectTool: available when trivy resolves on PATH (preferred by default)", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: (bin) => (bin === "trivy" ? "/usr/bin/trivy" : null),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "trivy");
  assert.equal(d.bin, "/usr/bin/trivy");
});

test("detectTool: falls back to grype when only grype is present", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: (bin) => (bin === "grype" ? "/usr/bin/grype" : null),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "grype");
});

test("detectTool: GATE_SUPPLY_CHAIN_SCANNER=grype prefers grype when both present", () => {
  const d = detectTool("/repo", {
    fileExists: () => false,
    lookPath: (bin) => `/usr/bin/${bin}`,
    env: { PATH: "/usr/bin", GATE_SUPPLY_CHAIN_SCANNER: "grype" },
  });
  assert.equal(d.tool, "grype");
});

test("detectTool: TRIVY_BIN override wins when it exists", () => {
  const d = detectTool("/repo", {
    fileExists: (p) => p === "/opt/trivy",
    lookPath: () => null,
    env: { TRIVY_BIN: "/opt/trivy" },
  });
  assert.equal(d.available, true);
  assert.equal(d.tool, "trivy");
  assert.equal(d.bin, "/opt/trivy");
});

test("runSupplyChainGate: scanner ABSENT => result 'skip', the gate is NOT failed", async () => {
  const res = await runSupplyChainGate(
    { repoRoot: "/repo", mode: "ratchet" },
    { fileExists: () => false, lookPath: () => null, env: {}, readLock: () => null },
  );
  assert.equal(res.ran, false);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /^supply-chain: skip/);
  assert.notEqual(res.classification.result, "fail");
});

test("runSupplyChainGate: scanner absent but lockfile present => SBOM still emitted (dependency-free)", async () => {
  const res = await runSupplyChainGate(
    { repoRoot: "/repo", mode: "ratchet" },
    {
      fileExists: () => false,
      lookPath: () => null,
      env: {},
      readLock: () => JSON.stringify(FIXTURE_LOCKFILE),
    },
  );
  // CVE verdict skipped, but the SBOM emitter (no tool needed) still ran.
  assert.equal(res.classification.result, "skip");
  assert.ok(res.sbom, "SBOM should be emitted even when no scanner is installed");
  assert.equal(res.sbom.bomFormat, "CycloneDX");
});

test("runCli: missing scanner exits 0 (a missing external tool MUST NOT fail the gate)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-absent-"));
  const savedPath = process.env.PATH;
  const savedTrivy = process.env.TRIVY_BIN;
  const savedGrype = process.env.GRYPE_BIN;
  try {
    process.env.PATH = root; // a dir guaranteed to NOT contain trivy/grype
    delete process.env.TRIVY_BIN;
    delete process.env.GRYPE_BIN;
    let out = "";
    const code = await runCli(
      ["classify", "--root", root, "--mode", "ratchet"],
      { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } },
    );
    assert.equal(code, 0, "missing scanner must exit 0 (skip, never fail)");
    assert.match(out, /^supply-chain: skip/);
  } finally {
    process.env.PATH = savedPath;
    if (savedTrivy === undefined) delete process.env.TRIVY_BIN; else process.env.TRIVY_BIN = savedTrivy;
    if (savedGrype === undefined) delete process.env.GRYPE_BIN; else process.env.GRYPE_BIN = savedGrype;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. SBOM EMITTER — dependency-free CycloneDX from a fixture lockfile.
// ---------------------------------------------------------------------------
test("buildCycloneDxSbom: produces a valid CycloneDX 1.4 shape from a v3 lockfile", () => {
  const sbom = buildCycloneDxSbom(FIXTURE_LOCKFILE);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.4");
  assert.equal(sbom.metadata.component.name, "demo-app");
  assert.equal(sbom.metadata.component.version, "1.2.3");
  // One component per non-root package; the root ("") is excluded.
  assert.equal(sbom.components.length, 4);
  for (const c of sbom.components) {
    assert.equal(c.type, "library");
    assert.match(c.purl, /^pkg:npm\//);
    assert.ok(c.name && c.version, "every component has a name + version");
  }
  // Scoped + nested deps resolve to their own name.
  const names = sbom.components.map((c) => c.name).sort();
  assert.deepEqual(names, ["@scope/util", "express", "lodash", "ms"]);
  // Deterministic (sorted by purl) — reproducible across runs.
  const purls = sbom.components.map((c) => c.purl);
  assert.deepEqual(purls, [...purls].sort());
});

test("buildCycloneDxSbom: handles legacy lockfileVersion 1 (nested dependencies tree)", () => {
  const legacy = {
    name: "old-app",
    version: "0.1.0",
    lockfileVersion: 1,
    dependencies: {
      lodash: { version: "4.17.21" },
      express: { version: "4.18.2", dependencies: { ms: { version: "2.0.0" } } },
    },
  };
  const sbom = buildCycloneDxSbom(legacy);
  const names = sbom.components.map((c) => c.name).sort();
  assert.deepEqual(names, ["express", "lodash", "ms"]);
});

test("buildCycloneDxSbom: returns null for empty/garbage/non-lockfile input", () => {
  assert.equal(buildCycloneDxSbom(""), null);
  assert.equal(buildCycloneDxSbom("not json"), null);
  assert.equal(buildCycloneDxSbom({ no: "packages-or-dependencies" }), null);
});

test("nameFromLockKey: derives the dep name after the LAST node_modules segment", () => {
  assert.equal(nameFromLockKey("node_modules/lodash"), "lodash");
  assert.equal(nameFromLockKey("node_modules/@scope/util"), "@scope/util");
  assert.equal(nameFromLockKey("node_modules/a/node_modules/b"), "b");
  assert.equal(nameFromLockKey(""), null);
});

// ---------------------------------------------------------------------------
// 3. PARSE — Trivy + Grype JSON -> findings, with severity mapping.
// ---------------------------------------------------------------------------
test("parseScannerReport: returns null for empty/garbage/unknown input", () => {
  assert.equal(parseScannerReport(""), null);
  assert.equal(parseScannerReport("not json"), null);
  assert.equal(parseScannerReport({ neither: "trivy-nor-grype" }), null);
});

test("parseScannerReport: parses Trivy and maps CRITICAL/HIGH=>fail, MEDIUM/LOW=>warn", () => {
  const parsed = parseScannerReport(
    trivyReport([
      { id: "CVE-2021-1111", pkg: "lodash", version: "4.17.20", severity: "CRITICAL" },
      { id: "CVE-2021-2222", pkg: "express", version: "4.17.0", severity: "MEDIUM" },
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.totals.fail, 1);
  assert.equal(parsed.totals.warn, 1);
  for (const f of parsed.findings) assert.equal(f.check, "supply_chain");
  assert.equal(parsed.findings[0].severity, "fail");
  assert.equal(parsed.findings[1].severity, "warn");
});

test("parseScannerReport: parses the Grype matches[] shape", () => {
  const parsed = parseScannerReport(
    grypeReport([{ id: "GHSA-xxxx", pkg: "minimist", version: "0.0.8", severity: "High" }]),
  );
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].advisoryId, "GHSA-XXXX");
  assert.equal(parsed.findings[0].pkg, "minimist");
  assert.equal(parsed.findings[0].version, "0.0.8");
  assert.equal(parsed.findings[0].severity, "fail");
});

// ---------------------------------------------------------------------------
// 4. STABLE KEY: advisory-id:package:version — dedup + normalization.
// ---------------------------------------------------------------------------
test("stable key: identity = supply_chain:<package>:<advisory>::<version> (advisory:package:version, reuses arch-checks key)", () => {
  const parsed = parseScannerReport(
    trivyReport([{ id: "cve-2021-1111", pkg: "lodash", version: "4.17.20", severity: "HIGH" }]),
  );
  const f = parsed.findings[0];
  // advisory id is normalized to UPPERCASE so casing churn does not re-key it.
  assert.match(stableFindingKey(f), /^supply_chain:lodash:CVE-2021-1111::4\.17\.20$/);
  assert.equal(supplyChainStableDetail(f), f.value);
});

test("stable key: the SAME advisory on the SAME package@version dedups to ONE finding (even across scanners/targets)", () => {
  // Two Trivy Results both report the same advisory on the same package@version.
  const report = {
    Results: [
      { Target: "a", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "lodash", InstalledVersion: "4.17.20", Severity: "HIGH" }] },
      { Target: "b", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "lodash", InstalledVersion: "4.17.20", Severity: "HIGH" }] },
    ],
  };
  const parsed = parseScannerReport(report);
  assert.equal(parsed.findings.length, 1, "the same advisory:package:version collapses to one finding");
});

test("stable key: same advisory on a DIFFERENT version => DISTINCT finding (version is part of identity)", () => {
  const parsed = parseScannerReport(
    trivyReport([
      { id: "CVE-1", pkg: "lodash", version: "4.17.20", severity: "HIGH" },
      { id: "CVE-1", pkg: "lodash", version: "4.17.21", severity: "HIGH" },
    ]),
  );
  assert.equal(parsed.findings.length, 2);
  assert.notEqual(stableFindingKey(parsed.findings[0]), stableFindingKey(parsed.findings[1]));
});

// ---------------------------------------------------------------------------
// 5. RATCHET VERDICT (DEFAULT, COORD-126 reuse): fail only on NEW advisories.
// ---------------------------------------------------------------------------
test("ratchet (default): a NEW HIGH advisory vs baseline => fail", () => {
  const base = parseScannerReport(
    trivyReport([{ id: "CVE-LEGACY", pkg: "lodash", version: "4.17.20", severity: "HIGH" }]),
  );
  const current = parseScannerReport(
    trivyReport([
      { id: "CVE-LEGACY", pkg: "lodash", version: "4.17.20", severity: "HIGH" },
      { id: "CVE-NEW", pkg: "express", version: "4.17.0", severity: "HIGH" },
    ]),
  );
  const c = classifySupplyChain({ parsed: current, baseFindings: base.findings }); // ratchet default
  assert.equal(c.mode, "ratchet");
  assert.equal(c.result, "fail");
  assert.equal(c.newFindings, 1);
  assert.equal(c.preExistingFindings, 1);
});

test("ratchet (default): pre-existing advisories ONLY => pass (legacy CVE debt is frictionless)", () => {
  const base = parseScannerReport(
    trivyReport([
      { id: "CVE-A", pkg: "lodash", version: "4.17.20", severity: "HIGH" },
      { id: "CVE-B", pkg: "express", version: "4.17.0", severity: "CRITICAL" },
    ]),
  );
  // current has the SAME two advisories (same advisory:package:version).
  const current = parseScannerReport(
    trivyReport([
      { id: "CVE-A", pkg: "lodash", version: "4.17.20", severity: "HIGH" },
      { id: "CVE-B", pkg: "express", version: "4.17.0", severity: "CRITICAL" },
    ]),
  );
  const c = classifySupplyChain({ parsed: current, mode: "ratchet", baseFindings: base.findings });
  assert.equal(c.result, "pass");
  assert.equal(c.newFindings, 0);
  assert.equal(c.preExistingFindings, 2);
});

// ---------------------------------------------------------------------------
// 6. THRESHOLD VERDICT (opt-in severity floor): fail on HIGH/CRITICAL.
// ---------------------------------------------------------------------------
test("threshold mode (opt-in): a HIGH advisory at/above the floor => fail; MEDIUM => warn", () => {
  const parsedFail = parseScannerReport(
    trivyReport([{ id: "CVE-1", pkg: "p", version: "1.0.0", severity: "HIGH" }]),
  );
  const cFail = classifySupplyChain({ parsed: parsedFail, mode: "threshold", threshold: "high" });
  assert.equal(cFail.result, "fail");
  assert.equal(cFail.threshold, DEFAULT_SUPPLY_CHAIN_THRESHOLD);

  const parsedWarn = parseScannerReport(
    trivyReport([{ id: "CVE-2", pkg: "p", version: "1.0.0", severity: "MEDIUM" }]),
  );
  const cWarn = classifySupplyChain({ parsed: parsedWarn, mode: "threshold", threshold: "high" });
  assert.equal(cWarn.result, "warn");
});

test("threshold mode: CRITICAL fails even with floor=high (rank-based, not exact-match)", () => {
  const parsed = parseScannerReport(
    trivyReport([{ id: "CVE-3", pkg: "p", version: "1.0.0", severity: "CRITICAL" }]),
  );
  const c = classifySupplyChain({ parsed, mode: "threshold", threshold: "high" });
  assert.equal(c.result, "fail");
  assert.equal(c.atOrAbove, 1);
});

// ---------------------------------------------------------------------------
// 7. TIMEOUT PATH — a hung scanner is process-group SIGKILLed within the bound
// and the gate is SKIPPED (never hangs, never fails). FAST fake child.
// ---------------------------------------------------------------------------
function fakeHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 636363;
  return child;
}

test("runScannerBounded: a hung scanner is SIGKILLed (negative pid = process group) within the bound", async () => {
  const child = fakeHangingChild();
  const killed = [];
  const res = await runScannerBounded(
    { bin: "/x/trivy", tool: "trivy", repoRoot: "/x", timeoutMs: 20 },
    {
      spawn: () => child,
      kill: (target, sig) => { killed.push([target, sig]); child.emit("close", null); },
    },
  );
  assert.equal(res.timedOut, true);
  // COORD-129: the WHOLE process group is signaled via the NEGATIVE pid.
  assert.deepEqual(killed, [[-child.pid, "SIGKILL"]]);
});

test("runSupplyChainGate: timeout path => result 'skip' (hung scanner never fails the gate)", async () => {
  const child = fakeHangingChild();
  const res = await runSupplyChainGate(
    { repoRoot: "/x", mode: "ratchet", timeoutMs: 10 },
    {
      fileExists: () => false,
      lookPath: (bin) => (bin === "trivy" ? "/usr/bin/trivy" : null),
      env: { PATH: "/usr/bin" },
      readLock: () => null,
      spawn: () => child,
      kill: () => child.emit("close", null),
      readReport: () => null,
    },
  );
  assert.equal(res.timedOut, true);
  assert.equal(res.classification.result, "skip");
  assert.match(res.summary, /skip/i);
});

// ---------------------------------------------------------------------------
// 8. END-TO-END with a FAKE scanner runner + fixture CVE JSON (no scanner install).
// ---------------------------------------------------------------------------
test("runSupplyChainGate: scanner present + fixture report with a NEW advisory vs base => fail (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseScannerReport(
    trivyReport([{ id: "CVE-LEGACY", pkg: "lodash", version: "4.17.20", severity: "HIGH" }]),
  );
  const current = trivyReport([
    { id: "CVE-LEGACY", pkg: "lodash", version: "4.17.20", severity: "HIGH" },
    { id: "CVE-NEW", pkg: "express", version: "4.17.0", severity: "HIGH" },
  ]);
  const res = await runSupplyChainGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: (bin) => (bin === "trivy" ? "/usr/bin/trivy" : null),
      env: { PATH: "/usr/bin" },
      readLock: () => JSON.stringify(FIXTURE_LOCKFILE),
      spawn: () => { setImmediate(() => child.emit("close", 1)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.ran, true);
  assert.equal(res.classification.result, "fail");
  assert.equal(res.classification.newFindings, 1);
  // SBOM emitted alongside the scan.
  assert.ok(res.sbom);
});

test("runSupplyChainGate: scanner present + fixture report with only pre-existing advisories => pass (ratchet)", async () => {
  const child = fakeHangingChild();
  const base = parseScannerReport(
    trivyReport([{ id: "CVE-A", pkg: "lodash", version: "4.17.20", severity: "HIGH" }]),
  );
  const current = trivyReport([{ id: "CVE-A", pkg: "lodash", version: "4.17.20", severity: "HIGH" }]);
  const res = await runSupplyChainGate(
    { repoRoot: "/x", mode: "ratchet", baseFindings: base.findings },
    {
      fileExists: () => false,
      lookPath: (bin) => (bin === "trivy" ? "/usr/bin/trivy" : null),
      env: { PATH: "/usr/bin" },
      readLock: () => null,
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => JSON.stringify(current),
    },
  );
  assert.equal(res.classification.result, "pass");
  assert.notEqual(res.classification.result, "fail");
});

test("runSupplyChainGate: scanner ran but output unparseable => graceful skip (never fail)", async () => {
  const child = fakeHangingChild();
  const res = await runSupplyChainGate(
    { repoRoot: "/x", mode: "ratchet" },
    {
      fileExists: () => false,
      lookPath: (bin) => (bin === "grype" ? "/usr/bin/grype" : null),
      env: { PATH: "/usr/bin" },
      readLock: () => null,
      spawn: () => { setImmediate(() => child.emit("close", 0)); return child; },
      readReport: () => "garbage-not-json",
    },
  );
  assert.equal(res.classification.result, "skip");
  assert.notEqual(res.classification.result, "fail");
});

// ---------------------------------------------------------------------------
// 9. The supply-chain summary is a valid gate-artifact field shape.
// ---------------------------------------------------------------------------
test("formatSupplyChainSummary: emits a grep-friendly one-liner usable as an artifact field", () => {
  const parsed = parseScannerReport(
    trivyReport([{ id: "CVE-1", pkg: "p", version: "1.0.0", severity: "HIGH" }]),
  );
  const s = formatSupplyChainSummary(classifySupplyChain({ parsed, mode: "ratchet", baseFindings: [] }));
  assert.match(s, /^supply-chain: (pass|fail|warn|skip) mode=ratchet/);
  // The whole string must be embeddable as a JSON string value without breaking
  // the artifact (no raw newlines/quotes injected by the formatter).
  assert.doesNotMatch(s, /[\n"]/);
});

test("gate artifact: the supply_chain summary is schema-valid (round-trips as a complete-artifact field)", () => {
  const { validateGateArtifact } = require("./gate-artifact-schema.js");
  const parsed = parseScannerReport(trivyReport([]));
  const summary = formatSupplyChainSummary(classifySupplyChain({ parsed, mode: "ratchet", baseFindings: [] }));
  const artifact = {
    lane: "full",
    commit: "abc123",
    result: "pass",
    duration_ms: 10,
    command_list: ["supply-chain (SBOM + CVE scan, opt-in, mode=ratchet)"],
    coverage: null,
    coverage_skip_reason: "off lane",
    audit: null,
    audit_skip_reason: "no lockfile",
    artifact_paths: ["artifacts/gates/full.latest.json"],
    supply_chain: summary, // the new field rides alongside the required fields
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `artifact must stay complete with the supply_chain field: missing=${v.missing}`);
});
