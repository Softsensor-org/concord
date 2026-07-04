"use strict";

// Wave 2 (COORD-058): gate-runtime tests relocated out of governance.test.js into
// a module-owned file. Exercise gate script/invocation/artifact-dir resolution and
// package-manager detection via the governance __testing surface.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { __testing, GovernanceError, createTempGitRepo } = require("./governance-test-utils.js");
const { validateGateArtifact } = require("./gate-artifact-schema.js");
const { clampDurationMs } = require("./gate-runtime.js");

test("COORD-093: clampDurationMs yields a schema-valid, non-negative duration for a measurable run", () => {
  // A real monotonic measurement around a gate spawn produces a positive,
  // finite, sub-second-precise number. The clamp must pass it through unchanged
  // and the result must satisfy the COORD-080 completeness contract (a finite
  // non-negative number, never 0-from-rounding for a measurable run).
  const measured = 480.37; // ms, e.g. process.hrtime.bigint() delta / 1e6
  const clamped = clampDurationMs(measured);
  assert.equal(clamped, 480.37);
  assert.ok(Number.isFinite(clamped) && clamped > 0);

  const artifact = {
    lane: "default",
    commit: "cbfbc738454761b4174600b130deba47e73d9000",
    result: "pass",
    duration_ms: clamped,
    command_list: ["checking module layout", "running unit tests"],
    coverage: null,
    coverage_skip_reason: "not run on this lane (default)",
    audit: null,
    audit_skip_reason: "not run on this lane (default)",
    artifact_paths: ["coord/artifacts/gates/backend/default.latest.json"],
  };
  const v = validateGateArtifact(artifact);
  assert.equal(v.complete, true, `expected complete, missing=${v.missing}`);
});

test("COORD-093: clampDurationMs defends the schema against negative / NaN / non-number durations", () => {
  // A monotonic source should never go negative, but a runner-supplied value can
  // (backward NTP clock step -> negative; bad parse -> NaN; missing -> non-number).
  // The clamp must turn each into a schema-valid value so it can NEVER fail the
  // COORD-080 completeness check.
  //  - negative  -> 0 (clamped, still finite & non-negative)
  //  - NaN / Infinity / non-number -> null (honest "no duration")
  assert.equal(clampDurationMs(-1500), 0, "negative clamps to 0");
  assert.equal(clampDurationMs(-0.0001), 0, "tiny negative clamps to 0");
  assert.equal(clampDurationMs(NaN), null, "NaN -> null");
  assert.equal(clampDurationMs(Infinity), null, "Infinity -> null");
  assert.equal(clampDurationMs("123"), null, "non-number -> null");
  assert.equal(clampDurationMs(undefined), null, "undefined -> null");
  assert.equal(clampDurationMs(0), 0, "exact zero passes through");
  assert.equal(clampDurationMs(12.5), 12.5, "positive passes through");

  // The clamped negative case (0) must validate as a present duration_ms — a
  // backward clock step can never mark an otherwise-clean gate incomplete.
  const recovered = validateGateArtifact({
    lane: "default",
    commit: "cbfbc738454761b4174600b130deba47e73d9000",
    result: "pass",
    duration_ms: clampDurationMs(-42),
    command_list: ["step"],
    coverage: null,
    coverage_skip_reason: "skip",
    audit: null,
    audit_skip_reason: "skip",
    artifact_paths: ["coord/artifacts/gates/backend/default.latest.json"],
  });
  assert.ok(!recovered.missing.includes("duration_ms"), "clamped negative is a present duration_ms");
});

test("COORD-080: the bash synthesize-path artifact shape is marked incomplete with its thin fields", () => {
  // Mirrors the synthesized artifact gate-runtime.js builds when a bash
  // scripts/gate.sh emits no artifact: it carries lane/commit/result/paths but
  // has no real duration or command list (those are unrecoverable post-hoc) and
  // explicitly skips coverage/audit. The validator must flag duration_ms +
  // command_list as missing while accepting the reason-backed null signals.
  const synthesized = {
    lane: "default",
    commit: "cbfbc738454761b4174600b130deba47e73d9000",
    result: "pass",
    duration_ms: null,
    command_list: [],
    coverage: null,
    coverage_skip_reason: "repo gate.sh emitted no artifact; coverage not captured",
    audit: null,
    audit_skip_reason: "repo gate.sh emitted no artifact; audit not captured",
    artifact_paths: ["coord/artifacts/gates/coord/default.latest.json"],
    synthesized: true,
  };
  const v = validateGateArtifact(synthesized);
  assert.equal(v.complete, false);
  assert.deepEqual(v.missing.sort(), ["command_list", "duration_ms"]);
});

test("resolveGateScript validates the supported lane/source matrix from package.json scripts", () => {
  const { repoRoot } = createTempGitRepo("ebmr-gate-script-matrix-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: {
        "gate:default": "node default.js",
        "gate:default:ci": "node default-ci.js",
        "gate:full": "node full.js",
      },
    }, null, 2),
  }, "gate scripts");

  assert.equal(__testing.resolveGateScript(repoRoot, "default", "local", "dev"), "gate:default");
  assert.equal(__testing.resolveGateScript(repoRoot, "default", "ci", "dev"), "gate:default:ci");
  assert.equal(__testing.resolveGateScript(repoRoot, "full", "ci", "dev"), "gate:full");
  assert.throws(
    () => __testing.resolveGateScript(repoRoot, "full", "hook", "dev"),
    (error) => error instanceof GovernanceError && /unsupported: lane=full, source=hook/i.test(error.message)
  );
});

test("resolveGateArtifactDir stores clean-checkout artifacts under coord instead of repo roots", () => {
  const coordDir = path.resolve(__dirname, "..");
  assert.equal(
    __testing.resolveGateArtifactDir("F"),
    path.join(coordDir, "artifacts", "gates", __testing.repoNameForCode("F"))
  );
  assert.equal(
    __testing.resolveGateArtifactDir("B"),
    path.join(coordDir, "artifacts", "gates", __testing.repoNameForCode("B"))
  );
});

test("COORD-022: detectGatePackageManager picks the right manager per lockfile", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord022-pm-"));
  try {
    const mk = (name, lock) => {
      const d = path.join(base, name);
      fs.mkdirSync(d, { recursive: true });
      if (lock) fs.writeFileSync(path.join(d, lock), "");
      return d;
    };
    const pnpmDir = mk("pnpm", "pnpm-lock.yaml");
    const yarnDir = mk("yarn", "yarn.lock");
    const npmDir = mk("npm", "package-lock.json");
    const shrinkDir = mk("shrink", "npm-shrinkwrap.json");
    const noneDir = mk("none", null);

    const pnpm = __testing.detectGatePackageManager(pnpmDir);
    assert.equal(pnpm.name, "pnpm");
    assert.deepEqual(pnpm.installArgs, ["install", "--frozen-lockfile"]);
    assert.deepEqual(pnpm.runScriptArgs("gate:default"), ["gate:default"]);

    const yarn = __testing.detectGatePackageManager(yarnDir);
    assert.equal(yarn.name, "yarn");
    assert.deepEqual(yarn.installArgs, ["install", "--frozen-lockfile"]);
    assert.deepEqual(yarn.runScriptArgs("gate:default"), ["gate:default"]);

    const npm = __testing.detectGatePackageManager(npmDir);
    assert.equal(npm.name, "npm");
    assert.deepEqual(npm.installArgs, ["ci"]);
    assert.deepEqual(npm.runScriptArgs("gate:default"), ["run", "gate:default"]);

    // npm-shrinkwrap.json is also npm.
    assert.equal(__testing.detectGatePackageManager(shrinkDir).name, "npm");

    // No lockfile falls back to pnpm (the donor default), preserving prior behavior.
    assert.equal(__testing.detectGatePackageManager(noneDir).name, "pnpm");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveGateInvocation returns a script invocation when a gate:<lane> script exists", () => {
  const { repoRoot } = createTempGitRepo("gate-invoke-script-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: { "gate:default": "node default.js", "gate:full": "node full.js" },
    }, null, 2),
  }, "gate scripts");

  assert.deepEqual(
    __testing.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    { kind: "script", script: "gate:default" }
  );
});

test("resolveGateInvocation falls back to bash scripts/gate.sh when no gate script exists", () => {
  const { repoRoot } = createTempGitRepo("gate-invoke-bash-", {
    "package.json": JSON.stringify({ name: "@template/legacy", scripts: { build: "tsc" } }, null, 2),
    "scripts/gate.sh": "#!/usr/bin/env bash\nexit 0\n",
  }, "bash gate only");

  assert.deepEqual(
    __testing.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    { kind: "bash", command: "bash", args: ["scripts/gate.sh", "default"] }
  );
});

test("resolveGateInvocation still fails when neither a gate script nor scripts/gate.sh exists", () => {
  const { repoRoot } = createTempGitRepo("gate-invoke-none-", {
    "package.json": JSON.stringify({ name: "@template/empty", scripts: { build: "tsc" } }, null, 2),
  }, "no gate");

  assert.throws(
    () => __testing.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    (error) => error instanceof GovernanceError && /unsupported: lane=default/i.test(error.message)
  );
});
