"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// Wave 2 (COORD-058): gate-runtime tests relocated out of governance.test.js into
// a module-owned file. Exercise gate script/invocation/artifact-dir resolution and
// package-manager detection via the governance __testing surface.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { GovernanceError, createTempGitRepo, runGit, withScopedGovernanceTestContext } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const governanceCommands = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js")).commands;
const { DEFAULT_PATHS } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const createGateRuntime = require("./gate-runtime.js");
const createRepoRegistry = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/repo-registry.js"));
const createTestingInfraAudit = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/testing-infra-audit.js"));
const { gitTry } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/git-ops.js"));
const repoRegistry = createRepoRegistry();
const testingInfraAudit = createTestingInfraAudit({ gitTry });
const gateRuntime = createGateRuntime({
  repoDisplayNameForCode: repoRegistry.repoDisplayNameForCode,
  readJsonFileFromRef: testingInfraAudit.readJsonFileFromRef,
});
const { validateGateArtifact } = require("./gate-artifact-schema.js");
const { clampDurationMs, reconcileGateReceipt, buildEvidenceIsolation } = require("./gate-runtime.js");

function createGateRuntimeForFixture(repoRoot, displayName) {
  return createGateRuntime({
    configuredRepoArgDescription: () => "B",
    repoCodeForCliRepoArg: (value) => value === "B" ? "B" : null,
    getRepoRoot: () => repoRoot,
    repoDisplayNameForCode: () => displayName,
    readJsonFileFromRef: (root, ref, relativePath) => {
      const result = spawnSync("git", ["-C", root, "show", `${ref}:${relativePath}`], { encoding: "utf8" });
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout); } catch { return null; }
    },
  });
}

function withPublicGateRepo(repoRoot, displayName, callback) {
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repoRoot },
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: displayName },
  }, callback);
}

function makeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeFakePnpm(binDir, body) {
  return makeExecutable(path.join(binDir, "pnpm"), `#!/bin/sh\n${body}\n`);
}

function realGitPath() {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "git");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("git executable not found on PATH");
}

test("COORD-738: evidence checkout is outside the source root and excludes sibling worktrees", () => {
  const isolation = buildEvidenceIsolation({ repoRoot: "/workspace/product", checkoutPath: "/tmp/coord-gates/exact-commit" });
  assert.equal(isolation.contract, "disposable-exact-commit");
  assert.deepEqual(isolation.scanned_paths, ["/tmp/coord-gates/exact-commit"]);
  assert.deepEqual(isolation.excluded_paths, ["/workspace/product/.worktrees"]);
  assert.equal(isolation.sibling_worktrees_excluded, true);
  assert.throws(() => buildEvidenceIsolation({ repoRoot: "/workspace/product", checkoutPath: "/workspace/product/.worktrees/gate" }), /cannot be proven/i);
});

test("COORD-742: receipt reconciliation fails closed for process, lane, and tracked-content contradictions", () => {
  const failed = reconcileGateReceipt({ requestedLane: "full", exitCode: 1, artifactLane: "full", artifactResult: "pass", artifactStatus: "pass", trackedContentChanged: false });
  assert.equal(failed.status, "contradictory");
  assert.equal(failed.result, "fail");
  assert.deepEqual(failed.contradictions, ["receipt_passed_observed_process_failed", "status_passed_observed_process_failed"]);

  const lane = reconcileGateReceipt({ requestedLane: "full", exitCode: 0, artifactLane: "default", artifactResult: "pass", artifactStatus: "pass", trackedContentChanged: false });
  assert.deepEqual(lane.contradictions, ["receipt_lane_mismatch"]);

  const dirty = reconcileGateReceipt({ requestedLane: "full", exitCode: 0, artifactLane: "full", artifactResult: "pass", artifactStatus: "pass", trackedContentChanged: true });
  assert.deepEqual(dirty.contradictions, ["tracked_content_changed_after_run"]);

  const honest = reconcileGateReceipt({ requestedLane: "full", exitCode: 0, artifactLane: "full", artifactResult: "pass", artifactStatus: "pass", trackedContentChanged: false });
  assert.deepEqual(honest, { contradictions: [], status: "authoritative", result: "pass" });
});

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
  const { repoRoot } = createTempGitRepo("legacy-gate-script-matrix-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: {
        "gate:default": "node default.js",
        "gate:default:ci": "node default-ci.js",
        "gate:full": "node full.js",
      },
    }, null, 2),
  }, "gate scripts");

  assert.equal(gateRuntime.resolveGateScript(repoRoot, "default", "local", "dev"), "gate:default");
  assert.equal(gateRuntime.resolveGateScript(repoRoot, "default", "ci", "dev"), "gate:default:ci");
  assert.equal(gateRuntime.resolveGateScript(repoRoot, "full", "ci", "dev"), "gate:full");
  assert.throws(
    () => gateRuntime.resolveGateScript(repoRoot, "full", "hook", "dev"),
    (error) => error instanceof GovernanceError && /unsupported: lane=full, source=hook/i.test(error.message)
  );
});

test("resolveGateArtifactDir stores clean-checkout artifacts under coord instead of repo roots", () => {
  const coordDir = path.resolve(__dirname, "..", "..");
  assert.equal(
    gateRuntime.resolveGateArtifactDir("F"),
    path.join(coordDir, "artifacts", "gates", repoRegistry.repoDisplayNameForCode("F"))
  );
  assert.equal(
    gateRuntime.resolveGateArtifactDir("B"),
    path.join(coordDir, "artifacts", "gates", repoRegistry.repoDisplayNameForCode("B"))
  );
});

test("lifecycle clean-checkout gate resolves repo display and package scripts from the configured git ref", () => {
  const { repoRoot } = createTempGitRepo("gate-lifecycle-wiring-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
    "gate.js": "process.exit(0);\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  }, "lifecycle gate wiring");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lifecycle-bin-"));
  const fakePnpm = path.join(fakeBin, "pnpm");
  fs.writeFileSync(fakePnpm, "#!/bin/sh\nif [ \"$1\" = install ]; then exit 0; fi\nexit 7\n", "utf8");
  fs.chmodSync(fakePnpm, 0o755);
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];

  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    withPublicGateRepo(repoRoot, "backend-fixture", () => {
      assert.throws(
        () => governanceCommands.runCleanCheckoutGate("missing", { lane: "default" }),
        (error) => error instanceof GovernanceError && /Invalid repo/.test(error.message),
      );
      assert.throws(
        () => governanceCommands.runCleanCheckoutGate("B", { source: "local", branch: "dev" }),
        (error) => error instanceof GovernanceError && /--lane is required/.test(error.message),
      );
      assert.throws(
        () => governanceCommands.runCleanCheckoutGate("B", {
          lane: "default", source: "remote", branch: "dev",
        }),
        (error) => error instanceof GovernanceError && /Invalid --source/.test(error.message),
      );
      assert.throws(
        () => governanceCommands.runCleanCheckoutGate("B", {
          lane: "default", source: "local", branch: "missing-base",
        }),
        (error) => error instanceof GovernanceError && /Branch "missing-base" does not exist/.test(error.message),
      );
      assert.throws(
        () => governanceCommands.runCleanCheckoutGate("B", {
          lane: "unsupported", source: "local", branch: "dev",
        }),
        (error) => error instanceof GovernanceError && /--lane is required/.test(error.message),
      );
      // Omitted source/branch exercise the public defaults: local and dev.
      governanceCommands.runCleanCheckoutGate("B", { lane: "default" });
    });
    assert.equal(process.exitCode, 1, "the fake gate failure must be reflected in the command result");
    assert.match(output.join("\n"), /backend-fixture gate:default clean-checkout/);
    assert.match(output.join("\n"), /warning:\s+no gate artifact was produced/);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: clean-checkout isolation refuses a temp root inside the source repo", () => {
  const { repoRoot } = createTempGitRepo("gate-isolation-root-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
    "gate.js": "process.exit(0);\n",
  }, "gate isolation root");
  const runtime = createGateRuntimeForFixture(repoRoot, "isolation-fixture");
  const originalTmpdir = os.tmpdir;
  try {
    os.tmpdir = () => repoRoot;
    assert.throws(
      () => runtime.runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /disposable checkout is inside the source repository/i.test(error.message),
    );
    assert.equal(runGit(repoRoot, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
  } finally {
    os.tmpdir = originalTmpdir;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: branch deletion between verification and resolution fails before creating a worktree", () => {
  const { repoRoot } = createTempGitRepo("gate-ref-race-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
  }, "gate branch race");
  const realGit = realGitPath();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ref-race-bin-"));
  const wrapper = makeExecutable(path.join(fakeBin, "git"),
    `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$2" = "${repoRoot}" ] && [ "$3" = "rev-parse" ] && [ "$4" = "dev" ]; then\n  "${realGit}" -C "$2" update-ref -d refs/heads/dev\nfi\nexec "${realGit}" "$@"\n`);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    assert.throws(
      () => createGateRuntimeForFixture(repoRoot, "ref-race-fixture")
        .runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /Could not resolve commit for branch "dev"/.test(error.message),
    );
    assert.equal(runGit(repoRoot, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: temporary worktree branch collision fails without installing dependencies", () => {
  const { repoRoot } = createTempGitRepo("gate-worktree-collision-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
  }, "gate worktree branch collision");
  const originalNow = Date.now;
  const originalRandomBytes = crypto.randomBytes;
  const fixedNow = 1730000000123;
  const fixedRandom = Buffer.from("a1b2c3d4", "hex");
  const collision = `tmp/gate-checkout-gate-${fixedNow}-${fixedRandom.toString("hex")}`;
  try {
    runGit(repoRoot, ["branch", collision]);
    Date.now = () => fixedNow;
    crypto.randomBytes = () => fixedRandom;
    assert.throws(
      () => createGateRuntimeForFixture(repoRoot, "collision-fixture")
        .runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /Failed to create temporary worktree/.test(error.message),
    );
  } finally {
    Date.now = originalNow;
    crypto.randomBytes = originalRandomBytes;
    runGit(repoRoot, ["branch", "-D", collision]);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: a post-checkout hook that dirties the disposable worktree is refused and cleaned", () => {
  const { repoRoot } = createTempGitRepo("gate-dirty-checkout-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
  }, "gate dirty worktree");
  const hook = path.join(repoRoot, ".git", "hooks", "post-checkout");
  makeExecutable(hook, "#!/bin/sh\nprintf dirty > .gate-dirty-sentinel\n");
  try {
    assert.throws(
      () => createGateRuntimeForFixture(repoRoot, "dirty-fixture")
        .runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /unexpectedly dirty after creation/.test(error.message),
    );
    assert.equal(runGit(repoRoot, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: package-manager install failure aborts and removes the disposable worktree", () => {
  const { repoRoot } = createTempGitRepo("gate-install-failure-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  }, "gate install failure");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-install-bin-"));
  const originalPath = process.env.PATH;
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then echo install-refused >&2; exit 17; fi\nexit 0');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    assert.throws(
      () => createGateRuntimeForFixture(repoRoot, "install-fixture")
        .runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /pnpm install \(install --frozen-lockfile\) failed/.test(error.message),
    );
    assert.equal(runGit(repoRoot, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: bash fallback synthesizes an honest incomplete receipt when gate.sh emits none", () => {
  const { repoRoot } = createTempGitRepo("gate-bash-synthesize-", {
    "package.json": JSON.stringify({ scripts: { build: "node build.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "scripts/gate.sh": "#!/usr/bin/env bash\nexit 0\n",
    ".gitignore": "artifacts/gates/\n",
  }, "gate bash synthesis");
  const displayName = `gate-synth-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(path.resolve(__dirname, "..", ".."), "artifacts", "gates", displayName);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-bash-synthesize-bin-"));
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nexit 99');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, displayName).runCleanCheckoutGate("B", { lane: "default" });
    const result = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(result.status, "pass");
    assert.equal(result.source, "local");
    assert.equal(result.branch, "dev");
    assert.equal(result.artifact.synthesized, true);
    assert.equal(result.artifact.authority.status, "authoritative");
    assert.equal(result.artifact.execution.observed_exit_code, 0);
    assert.equal(result.artifact.duration_ms, null);
    assert.deepEqual(result.artifact.command_list, []);
    assert.match(result.artifact.coverage_skip_reason, /no artifact/);
    assert.match(result.artifact.audit_skip_reason, /no artifact/);
    assert.equal(result.artifact.complete, false);
    assert.deepEqual(result.artifact.incomplete_fields.sort(), ["command_list", "duration_ms"]);
    assert.equal(result.artifact.artifact_paths.length, 3);
    for (const relative of result.artifact.artifact_paths) {
      assert.ok(fs.existsSync(path.resolve(__dirname, "..", "..", "..", relative)));
    }
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: an emitted gate receipt is parsed, reconciled, annotated, and published", () => {
  const { repoRoot } = createTempGitRepo("gate-emitted-receipt-", {
    "package.json": JSON.stringify({ scripts: { build: "node build.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "scripts/gate.sh": [
      "#!/usr/bin/env bash",
      "mkdir -p artifacts/gates",
      "cat > artifacts/gates/default.latest.json <<'JSON'",
      JSON.stringify({
        commit: "wrong-commit", result: "pass", status: "pass",
        duration_ms: 12, command_list: ["validate fixture"], coverage: null,
        coverage_skip_reason: "not required by this lane", audit: null,
        audit_skip_reason: "not required by this lane", budget: { status: "pass" },
        artifact_paths: ["stale/path"],
      }),
      "JSON",
      "exit 0",
    ].join("\n") + "\n",
    ".gitignore": "artifacts/gates/\n",
  }, "gate emitted receipt");
  const displayName = `gate-receipt-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(path.resolve(__dirname, "..", ".."), "artifacts", "gates", displayName);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-emitted-receipt-bin-"));
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nexit 99');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, displayName).runCleanCheckoutGate("B", { lane: "default" });
    const result = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(result.status, "pass");
    assert.equal(result.artifact.authority.status, "authoritative");
    assert.equal(result.artifact.lane, "default", "the requested lane fills a missing runner lane");
    assert.equal(result.artifact.commit, runGit(repoRoot, ["rev-parse", "dev"]));
    assert.equal(result.artifact.git.branch, "dev");
    assert.ok(result.artifact.duration_ms > 0);
    assert.equal(result.artifact.budget.status, "pass");
    assert.equal(result.artifact.complete, true);
    assert.deepEqual(result.artifact.artifact_paths.slice(0, 2), [
      path.relative(path.resolve(__dirname, "..", "..", ".."), path.join(artifactDir, "default.latest.json")).replace(/\\/g, "/"),
      path.relative(path.resolve(__dirname, "..", "..", ".."), path.join(artifactDir, "default.local.latest.json")).replace(/\\/g, "/"),
    ]);
    assert.equal(result.artifact.artifact_paths.length, 3);
    assert.match(result.artifact.artifact_paths[2], /^coord\/artifacts\/gates\/gate-receipt-[^/]+\/default\.local\.\d{4}-\d{2}-\d{2}T.+\.json$/);
    for (const relative of result.artifact.artifact_paths) {
      assert.ok(fs.existsSync(path.resolve(__dirname, "..", "..", "..", relative)));
    }
    // COORD-910: the repo-gate evidence names a valid run manifest that hashes the published copies.
    const runManifest = require("./run-manifest.js");
    assert.match(result.artifact.run_manifest.path, /^coord\/artifacts\/gates\/gate-receipt-[^/]+\/default\.local\..+\.manifest\.json$/);
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "..", result.artifact.run_manifest.path), "utf8"));
    assert.deepEqual(runManifest.validateManifest(manifest), []);
    assert.equal(manifest.input_digest, result.artifact.run_manifest.input_digest);
    assert.deepEqual(manifest.lanes.map((l) => [l.name, l.exit_code]), [["default", 0]]);
    assert.equal(manifest.inputs.gate_config.invocation, "bash scripts/gate.sh");
    assert.equal(manifest.inputs.source.commit, result.artifact.commit);
    assert.equal(manifest.artifacts.length, 3);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: silent worktree creation failure still reports a useful error", () => {
  const { repoRoot } = createTempGitRepo("gate-worktree-silent-failure-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
  }, "gate worktree silent failure");
  const realGit = realGitPath();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-worktree-silent-failure-bin-"));
  makeExecutable(path.join(fakeBin, "git"), [
    "#!/bin/sh",
    `if [ "$1" = "-C" ] && [ "$2" = "${repoRoot}" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ]; then exit 1; fi`,
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    assert.throws(
      () => createGateRuntimeForFixture(repoRoot, "silent-worktree-failure")
        .runCleanCheckoutGate("B", { lane: "default" }),
      (error) => error instanceof GovernanceError && /Failed to create temporary worktree for gate run:\n$/.test(error.message),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: malformed bash receipt is replaced with a failing incomplete receipt", () => {
  const { repoRoot } = createTempGitRepo("gate-malformed-receipt-", {
    "package.json": JSON.stringify({ scripts: { build: "node build.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "scripts/gate.sh": "#!/usr/bin/env bash\nmkdir -p artifacts/gates\nprintf '{invalid' > artifacts/gates/default.latest.json\nexit 17\n",
    ".gitignore": "artifacts/gates/\n",
  }, "gate malformed receipt");
  const displayName = `gate-malformed-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(path.resolve(__dirname, "..", ".."), "artifacts", "gates", displayName);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-malformed-receipt-bin-"));
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nexit 99');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, displayName).runCleanCheckoutGate("B", { lane: "default" });
    const result = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(result.status, "fail");
    assert.equal(result.artifact.synthesized, true);
    assert.equal(result.artifact.result, "fail");
    assert.equal(result.artifact.execution.observed_exit_code, 17);
    assert.equal(result.artifact.complete, false);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: a passing receipt cannot override a failing observed bash process", () => {
  const { repoRoot } = createTempGitRepo("gate-contradictory-receipt-", {
    "package.json": JSON.stringify({ scripts: { build: "node build.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "scripts/gate.sh": [
      "#!/usr/bin/env bash",
      "mkdir -p artifacts/gates",
      "cat > artifacts/gates/default.latest.json <<'JSON'",
      JSON.stringify({
        lane: "default", result: "pass", status: "pass", duration_ms: 12,
        command_list: ["validate fixture"], coverage: null,
        coverage_skip_reason: "not required", audit: null,
        audit_skip_reason: "not required", budget: { status: "pass" },
      }),
      "JSON",
      "exit 9",
    ].join("\n") + "\n",
    ".gitignore": "artifacts/gates/\n",
  }, "gate contradictory receipt");
  const displayName = `gate-contradiction-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(path.resolve(__dirname, "..", ".."), "artifacts", "gates", displayName);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-contradictory-receipt-bin-"));
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nexit 99');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, displayName).runCleanCheckoutGate("B", { lane: "default" });
    const result = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(result.status, "fail");
    assert.equal(result.artifact.status, "fail");
    assert.equal(result.artifact.result, "fail");
    assert.equal(result.artifact.authority.status, "contradictory");
    assert.deepEqual(result.artifact.execution.receipt_contradictions, [
      "receipt_passed_observed_process_failed",
      "status_passed_observed_process_failed",
    ]);
    assert.equal(result.artifact.execution.observed_exit_code, 9);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: cleanup failure is reported and the retained worktree remains recoverable", () => {
  const { repoRoot } = createTempGitRepo("gate-cleanup-warning-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  }, "gate cleanup warning");
  const realGit = realGitPath();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cleanup-warning-bin-"));
  const marker = path.join(fakeBin, "retained-worktree-path");
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  const output = [];
  const errors = [];
  makeExecutable(path.join(fakeBin, "git"), [
    "#!/bin/sh",
    `if [ "$1" = "-C" ] && [ "$2" = "${repoRoot}" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then`,
    `  printf '%s' "$6" > "${marker}"`,
    "  exit 1",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"));
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nexit 0');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, "cleanup-warning-fixture")
      .runCleanCheckoutGate("B", { lane: "default" });
    assert.equal(process.exitCode, originalExitCode);
    assert.ok(errors.some((line) => /Warning: failed to remove temporary worktree .*: $/.test(line)));
    const summary = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(summary.status, "pass");
    assert.equal(summary.clean_checkout, true);
    assert.ok(fs.existsSync(marker), "the failed removal identifies the retained checkout");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (fs.existsSync(marker)) {
      const retainedWorktree = fs.readFileSync(marker, "utf8");
      const cleanup = spawnSync(realGit, ["-C", repoRoot, "worktree", "remove", "--force", retainedWorktree], { encoding: "utf8" });
      if (cleanup.status !== 0) {
        spawnSync(realGit, ["-C", repoRoot, "worktree", "prune"], { encoding: "utf8" });
        fs.rmSync(retainedWorktree, { recursive: true, force: true });
      }
    }
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-825: a signaled gate process is an observed failure even without an exit status", () => {
  const { repoRoot } = createTempGitRepo("gate-signal-", {
    "package.json": JSON.stringify({ scripts: { "gate:default": "node gate.js" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  }, "gate signal result");
  const displayName = `gate-signal-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(path.resolve(__dirname, "..", ".."), "artifacts", "gates", displayName);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-signal-bin-"));
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const output = [];
  makeFakePnpm(fakeBin, 'if [ "$1" = "install" ]; then exit 0; fi\nkill -TERM $$');
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    console.log = (...args) => output.push(args.join(" "));
    createGateRuntimeForFixture(repoRoot, displayName).runCleanCheckoutGate("B", { lane: "default" });
    const result = JSON.parse(output.find((line) => line.includes('"command": "gate"')));
    assert.equal(result.status, "fail");
    assert.equal(result.duration_ms, null);
    assert.equal(result.artifact, null);
    assert.equal(result.clean_checkout, true);
    assert.equal(process.exitCode, 1);
    assert.ok(output.some((line) => /warning:\s+no gate artifact/.test(line)));
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
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

    const pnpm = gateRuntime.detectGatePackageManager(pnpmDir);
    assert.equal(pnpm.name, "pnpm");
    assert.deepEqual(pnpm.installArgs, ["install", "--frozen-lockfile"]);
    assert.deepEqual(pnpm.runScriptArgs("gate:default"), ["gate:default"]);

    const yarn = gateRuntime.detectGatePackageManager(yarnDir);
    assert.equal(yarn.name, "yarn");
    assert.deepEqual(yarn.installArgs, ["install", "--frozen-lockfile"]);
    assert.deepEqual(yarn.runScriptArgs("gate:default"), ["gate:default"]);

    const npm = gateRuntime.detectGatePackageManager(npmDir);
    assert.equal(npm.name, "npm");
    assert.deepEqual(npm.installArgs, ["ci"]);
    assert.deepEqual(npm.runScriptArgs("gate:default"), ["run", "gate:default"]);

    // npm-shrinkwrap.json is also npm.
    assert.equal(gateRuntime.detectGatePackageManager(shrinkDir).name, "npm");

    // No lockfile falls back to pnpm (the donor default), preserving prior behavior.
    assert.equal(gateRuntime.detectGatePackageManager(noneDir).name, "pnpm");
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
    gateRuntime.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    { kind: "script", script: "gate:default" }
  );
});

test("resolveGateInvocation falls back to bash scripts/gate.sh when no gate script exists", () => {
  const { repoRoot } = createTempGitRepo("gate-invoke-bash-", {
    "package.json": JSON.stringify({ name: "@template/legacy", scripts: { build: "tsc" } }, null, 2),
    "scripts/gate.sh": "#!/usr/bin/env bash\nexit 0\n",
  }, "bash gate only");

  assert.deepEqual(
    gateRuntime.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    { kind: "bash", command: "bash", args: ["scripts/gate.sh", "default"] }
  );
});

test("resolveGateInvocation still fails when neither a gate script nor scripts/gate.sh exists", () => {
  const { repoRoot } = createTempGitRepo("gate-invoke-none-", {
    "package.json": JSON.stringify({ name: "@template/empty", scripts: { build: "tsc" } }, null, 2),
  }, "no gate");

  assert.throws(
    () => gateRuntime.resolveGateInvocation(repoRoot, "default", "local", "dev"),
    (error) => error instanceof GovernanceError && /unsupported: lane=default/i.test(error.message)
  );
});

// COORD-909: a product repo gate must not hand agent/session identity to the product's own
// install or gate.sh child, while credentials, proxy/network variables and PATH are preserved.
// The fixture gate.sh writes its environment to a path the test passes in as a preserved
// variable, so the assertion reads what the child process actually received.
test("COORD-909: product gate child environment is identity-free and keeps credentials, proxy and PATH", () => {
  const identityNames = ["COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENT_THREAD_ID", "TERM_SESSION_ID"];
  const preservedNames = ["HTTPS_PROXY", "NO_PROXY", "GITHUB_TOKEN", "SSL_CERT_FILE", "PATH"];
  const fixture = createTempGitRepo("coord909-gate-env-", {
    "package.json": JSON.stringify({ name: "fixture-product", version: "1.0.0", private: true }, null, 2) + "\n",
    "package-lock.json": JSON.stringify({ name: "fixture-product", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-product", version: "1.0.0" } } }, null, 2) + "\n",
    "scripts/gate.sh": "#!/usr/bin/env bash\nenv > \"$FIXTURE_ENV_OUT\"\nexit 0\n",
  }, "COORD-909 fixture");

  const repoName = `fixture-coord909-${process.pid}-${Date.now()}`;
  const envOut = path.join(fixture.repoRoot, "child-env.txt");
  const saved = {};
  const setEnv = (name, value) => { saved[name] = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined; process.env[name] = value; };
  const artifactDir = path.join(COORD_ROOT_DIR, "artifacts", "gates", repoName);
  try {
    for (const name of identityNames) setEnv(name, `ambient-${name.toLowerCase()}`);
    setEnv("HTTPS_PROXY", "http://proxy.fixture.invalid:3128");
    setEnv("NO_PROXY", "localhost,127.0.0.1");
    setEnv("GITHUB_TOKEN", "fake-token-for-test");
    setEnv("SSL_CERT_FILE", "/fixture/ca.pem");
    setEnv("FIXTURE_ENV_OUT", envOut);

    const runtime = createGateRuntime({
      fail: (message) => { throw new GovernanceError(message); },
      getRepoRoot: () => fixture.repoRoot,
      repoCodeForCliRepoArg: () => "X",
      repoDisplayNameForCode: () => repoName,
      configuredRepoArgDescription: () => "X",
      readJsonFileFromRef: () => null,
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      runtime.runCleanCheckoutGate("X", { lane: "default", source: "local", branch: "dev" });
    } finally {
      console.log = originalLog;
    }

    assert.ok(fs.existsSync(envOut), "fixture gate.sh must have run and written its environment");
    const childEnv = new Map(fs.readFileSync(envOut, "utf8").split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    for (const name of identityNames) assert.equal(childEnv.has(name), false, `${name} must not reach the product gate child`);
    assert.equal(childEnv.get("HTTPS_PROXY"), "http://proxy.fixture.invalid:3128");
    assert.equal(childEnv.get("NO_PROXY"), "localhost,127.0.0.1");
    assert.equal(childEnv.get("GITHUB_TOKEN"), "fake-token-for-test");
    assert.equal(childEnv.get("SSL_CERT_FILE"), "/fixture/ca.pem");
    assert.ok(childEnv.get("PATH") && childEnv.get("PATH").length > 0, "PATH must be preserved");
    // The governance process keeps its own identity: the scrub never touches process.env.
    for (const name of identityNames) assert.equal(process.env[name], `ambient-${name.toLowerCase()}`, `${name} must remain in the governance process`);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});
