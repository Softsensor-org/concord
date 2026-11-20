"use strict";

// COORD-1044 / ADR 0028: cut-compatible release-edge runner contract tests.
// External release steps are scripted; real scanner integration lives in the donor release suite.
// No real release is built, pushed, tagged or published.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fixtureRepo, fakeExec } = require("./__fixtures__/release-gates-fixture.js");
const { gitFixture } = require("./test-git-fixture.js");
const gates = require("./release-gates.js");
const promote = require("./promote.js");

const DONOR = path.resolve(__dirname, "..", "..", "..");

function runWith(f, gate, exec, extra = {}) {
  return gates.runGate(gate, { root: f.root, cacheRoot: f.cache, exec, scriptRoot: DONOR, ...extra });
}

test("gate diagnostic preserves refusal precedence and explains failures without details", () => {
  const expectedRefusal = { name: "published-asset install", status: "refused", detail: "refused: local-only gate" };
  const refusal = { name: "SEA build", status: "refused", detail: "refused: network unavailable" };
  const plainFailure = { name: "npm install", status: "fail", detail: null };
  const detailedFailure = { name: "npm pack", status: "fail", detail: "no install archive" };
  const refusedFailure = { name: "cut build", status: "fail", detail: "refused: invalid cut" };
  assert.equal(gates.gateDiagnostic([], false), "gate did not pass");
  assert.equal(gates.gateDiagnostic([expectedRefusal], true), null);
  assert.equal(gates.gateDiagnostic([plainFailure, expectedRefusal], false), "failed: npm install");
  assert.equal(gates.gateDiagnostic([plainFailure, expectedRefusal, refusal], false), refusal.detail);
  assert.equal(gates.gateDiagnostic([refusal, detailedFailure], false), detailedFailure.detail);
  assert.equal(gates.gateDiagnostic([detailedFailure, refusedFailure], false), refusedFailure.detail);
  assert.equal(gates.gateDiagnostic([detailedFailure, refusedFailure], true), refusedFailure.detail);
});

test("wiring: the runner table names exactly the eight release-edge gates, and each one is in the producer's GATE_RUNS", () => {
  const expected = ["community-cut-build", "donor-hygiene-scan", "release-secret-scan", "dual-release-verify", "install-canaries-npm-sea", "enterprise-cut-build", "enterprise-qualification", "enterprise-ref-scan"];
  assert.deepEqual(Object.keys(gates.RUNNERS).sort(), [...expected].sort());
  for (const gate of expected) {
    assert.deepEqual(promote.GATE_RUNS[gate].argv, ["coord/engine/scripts/release-gates.js", gate], `${gate} runs through the release-gates CLI`);
    assert.equal(promote.GATE_RUNS[gate].lane, "node22", `${gate} runs on Node 22`);
  }
});

test("an unknown gate is a fail with no runner, never a pass", () => {
  const f = fixtureRepo();
  try {
    for (const name of ["no-such-gate", "constructor", "toString", "__proto__"]) {
      const out = runWith(f, name, fakeExec());
      assert.equal(out.result, "fail");
      assert.equal(out.detail, "no runner for gate " + name);
      assert.equal(out.commit, null);
      assert.deepEqual(out.steps, []);
    }
  } finally {
    f.cleanup();
  }
});

test("a dirty worktree is refused before any build runs", () => {
  const f = fixtureRepo();
  try {
    fs.writeFileSync(path.join(f.root, "dirty.txt"), "x\n");
    const exec = fakeExec();
    const out = runWith(f, "community-cut-build", exec);
    assert.equal(out.result, "fail");
    assert.match(out.detail, /dirty/);
    assert.equal(exec.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("community-cut-build: passes when the builder passes on the commit, and reports the donor commit", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    const out = runWith(f, "community-cut-build", exec);
    assert.equal(out.result, "pass");
    assert.equal(out.commit, execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.equal(exec.calls[0].command, "bash");
    assert.ok(exec.calls[0].args[0].endsWith("release/build-public-release.sh"));
    assert.ok(!exec.calls[0].args.includes("--enterprise"), "Community cut is not built with --enterprise");
  } finally {
    f.cleanup();
  }
});

test("community-cut-build: fails when the builder's hygiene gate fails (non-zero exit)", () => {
  const f = fixtureRepo();
  try {
    const out = runWith(f, "community-cut-build", fakeExec({ build: { status: 1, output: "RELEASE BUILD FAILED" } }));
    assert.equal(out.result, "fail");
    assert.match(out.detail, /exited 1/);
  } finally {
    f.cleanup();
  }
});

test("community-cut-build: Enterprise paths in Community output are a fail, not a pass", () => {
  const f = fixtureRepo();
  try {
    const out = runWith(f, "community-cut-build", fakeExec({ leakEnterprise: true }));
    assert.equal(out.result, "fail");
    assert.match(out.detail, /Enterprise paths in Community output/);
  } finally {
    f.cleanup();
  }
});

test("cut reuse: a second gate on the same commit reuses the recorded cut instead of rebuilding", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec({ "scan-donor-refs.sh": { status: 0, output: "clean fixture scan" } });
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const before = exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length;
    const second = runWith(f, "donor-hygiene-scan", exec);
    assert.equal(second.result, "pass");
    assert.equal(before, 1);
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 1, "no second build");
    assert.equal(second.steps[0].name, "community cut (reused)");
  } finally {
    f.cleanup();
  }
});

test("release-secret-scan fails when the scan cannot run (status 2), never a pass", () => {
  const f = fixtureRepo();
  try {
    const out = runWith(f, "release-secret-scan", fakeExec({ "scan-secrets.sh": { status: 2, output: "node missing" } }));
    assert.equal(out.result, "fail");
  } finally {
    f.cleanup();
  }
});

test("enterprise-ref-scan runs on the Community cut and fails on a scan that did not complete", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec({ "scan-enterprise-refs.sh": { status: 3, output: "grep failed" } });
    const out = runWith(f, "enterprise-ref-scan", exec);
    assert.equal(out.result, "fail");
    const scanCall = exec.calls.find((c) => /scan-enterprise-refs\.sh/.test(c.args.join(" ")));
    assert.match(scanCall.args[1], /community$/, "scan targets the Community cut");
  } finally {
    f.cleanup();
  }
});

function writeDualEvidence(root, out, modulePath, change) {
  const fs = require("node:fs");
  const path = require("node:path");
  const runManifest = require(modulePath);
  const { inputs, host } = runManifest.collectInputs({ root });
  const receiptPath = path.join(out, "dual-qualification.json");
  const digest = (file) => runManifest.artifactDigests([file])[0].sha256.slice("sha256:".length);
  const cuts = Object.fromEntries(["community", "enterprise"].map((edition) => {
    const sidecar = path.join(out, edition + ".attestation.json");
    fs.writeFileSync(sidecar, JSON.stringify({ edition }));
    return [edition, { cut_commit: "a".repeat(40), cut_tree_digest: "b".repeat(40),
      cut_content_digest: "c".repeat(64), attestation_sha256: digest(sidecar), ...(edition === "community" && { payload_sha256: "d".repeat(64) }) }];
  }));
  const receipt = { schema: "concord-dual-qualification/1", purpose: "qualification", publishable: false,
    commit: inputs.source.commit, tree: inputs.source.tree, cuts,
    policy_sha256: digest(path.join(root, "coord/engine/test-policy.json")),
    builder_sha256: digest(path.join(root, "release/build-public-release.sh")), ...change };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const manifest = runManifest.buildManifest({ tool: "release/verify-dual-release.sh qualification", inputs, host,
    lanes: ["community", "enterprise", "candidate-binding"].map((name) => ({ name, exit_code: 0, signal: null, duration_ms: 1 })) });
  runManifest.writeManifest(path.join(out, "run-manifest.json"), runManifest.finalizeManifest(manifest, [receiptPath]));
}

test("dual-release-verify: requires exact candidate and manifest-bound qualification evidence", () => {
  const f = fixtureRepo();
  try {
    const modulePath = path.join(__dirname, "run-manifest.js");
    const expected = `--qualify-commit=${gitFixture(f.root, ["rev-parse", "HEAD"])}`;
    const gate = ({ status = 0, output = "DUAL-RELEASE QUALIFICATION PASS", receipt, tamper } = {}) =>
      runWith(f, "dual-release-verify", (command, [, out, flag], options) => {
        assert.equal(command, "bash");
        assert.equal(flag, expected);
        assert.equal(options.cwd, f.root);
        if (receipt) writeDualEvidence(f.root, out, modulePath, receipt);
        if (tamper) fs.appendFileSync(path.join(out, tamper), "\n");
        return { status, output };
      });
    assert.equal(gate({ receipt: {} }).result, "pass");
    assert.equal(gate({ receipt: {}, output: "DUAL-RELEASE VERIFY PASS" }).result, "fail");
    assert.equal(gate({ receipt: {}, status: 1 }).result, "fail");
    assert.match(gate().detail, /missing or mismatched dual qualification evidence/);
    assert.match(gate({ receipt: { commit: "0".repeat(40) } }).detail, /mismatched dual qualification evidence/);
    assert.match(gate({ receipt: { cuts: { community: {} } } }).detail, /mismatched dual qualification evidence/);
    assert.match(gate({ receipt: { cuts: null } }).detail, /mismatched dual qualification evidence/);
    assert.match(gate({ receipt: { policy_sha256: "0".repeat(64) } }).detail, /mismatched dual qualification evidence/);
    assert.match(gate({ receipt: {}, tamper: "enterprise.attestation.json" }).detail, /mismatched dual qualification evidence/);
    assert.match(gate({ receipt: {}, tamper: "dual-qualification.json" }).detail, /receipt bytes are not bound/);
  } finally {
    f.cleanup();
  }
});

test("enterprise-cut-build: builds with --enterprise and requires the Enterprise tree", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "enterprise-cut-build", exec).result, "pass");
    assert.ok(exec.calls[0].args.includes("--enterprise"));
  } finally {
    f.cleanup();
  }
});

test("enterprise-qualification: verifies a bound Enterprise cut without a publication command", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const exec = fakeExec();
  const result = runWith(f, "enterprise-qualification", exec);
  assert.equal(result.result, "pass", result.detail);
  const call = exec.calls[0];
  assert.ok(call.args.includes("--enterprise"));
  assert.ok(call.args.includes(`--qualify-commit=${result.commit}`));
  assert.ok(exec.calls.every((entry) => !entry.args.some((arg) => arg.includes("publish-enterprise-release"))));

  const wrong = fixtureRepo();
  t.after(wrong.cleanup);
  assert.match(runWith(wrong, "enterprise-qualification",
    fakeExec({ qualificationAttestation: { donor_edition: "community" } })).detail, /wrong|mismatched|invalid/);
});

test("install-canaries-npm-sea: the SEA step is refused with a clear reason when it needs the registry, and never passes", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec({
      "build-linux-binary.sh": { status: 1, output: "npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org\nnpx --yes postject@1.0.0-alpha.6" },
    });
    const out = runWith(f, "install-canaries-npm-sea", exec);
    assert.equal(out.result, "fail");
    assert.match(out.detail, /^refused: SEA step needs postject@1\.0\.0-alpha\.6 from the npm registry/);
    assert.equal(out.steps.find((x) => x.name === "SEA binary build").status, "refused");
    assert.equal(out.steps.find((x) => x.name === "published-asset install").status, "refused");
  } finally {
    f.cleanup();
  }
});

test("install-canaries-npm-sea: local canaries pass while the expected published-asset check is refused", () => {
  const f = fixtureRepo();
  try {
    const normal = fakeExec({ seaBinary: true });
    const installs = [];
    const out = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
      if (args.at(-1) === "--dry-run" || args.at(-2) === "--apply-plan") {
        installs.push({ command, args, options });
      }
      return normal(command, args, options);
    });
    assert.equal(out.result, "pass", out.detail || JSON.stringify(out.steps));
    for (const channel of ["npm", "SEA"]) {
      assert.deepEqual(out.steps.find((entry) => entry.name === `${channel} scaffold (offline canary)`), {
        name: `${channel} scaffold (offline canary)`,
        status: "pass",
        detail: "a".repeat(64),
      });
    }
    assert.equal(installs.length, 4);
    const stages = normal.calls.filter(({ args }) => args[0]?.endsWith("/stage-npm-package.js"));
    assert.deepEqual(stages.map(({ args }) => args[1]), ["stage-qualification", "validate-qualification", "validate-qualification"]);
    assert.ok(stages.every(({ args }) => args[2] === stages[0].args[2]));
    assert.ok(normal.calls.find(({ args }) => args[0]?.endsWith("/build-linux-binary.sh"))
      .args.includes("--qualification-cut"));
    for (const [index, executable, prefix] of [
      [0, "create-concord", []],
      [2, `concord-qualification-linux-${os.machine()}`, ["init"]],
    ]) {
      const [plan, apply] = installs.slice(index, index + 2);
      const target = path.join(plan.options.cwd, "workspace");
      assert.equal(path.basename(plan.command), executable);
      assert.equal(apply.command, plan.command);
      assert.deepEqual(plan.args, [...prefix, target, "--dry-run"]);
      assert.deepEqual(apply.args, [...prefix, target, "--apply-plan", "a".repeat(64)]);
      assert.equal(plan.options.env.npm_config_offline, "true");
      assert.equal(apply.options.env.CONCORD_DONOR, undefined);
      assert.equal(apply.options.env.CONCORD_BUNDLE_DIR, undefined);
      assert.equal(fs.existsSync(target), false);
    }
    assert.equal(out.steps.find((x) => x.name === "npm install (offline canary)").status, "pass");
    assert.equal(out.steps.find((x) => x.name === "SEA binary build").status, "pass");
    assert.deepEqual(out.steps.find((x) => x.name === "published-asset install"), {
      name: "published-asset install",
      status: "refused",
      detail: "refused: requires published release assets; local-only verification does not publish",
    });
  } finally {
    f.cleanup();
  }
});

test("install-canaries-npm-sea: rejects a writing preview or an unreceipted apply", (t) => {
  for (const channel of ["npm", "SEA"]) {
    for (const phase of ["preview", "apply"]) {
      const f = fixtureRepo();
      t.after(f.cleanup);
      const normal = fakeExec({ seaBinary: true });
      const executable = channel === "npm" ? "create-concord" : `concord-qualification-linux-${os.machine()}`;
      const out = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
        if (path.basename(command) === executable) {
          if (phase === "preview" && args.at(-1) === "--dry-run") fs.mkdirSync(args.at(-2));
          if (phase === "preview" && args.at(-2) === "--apply-plan") assert.fail("writing preview must prevent apply");
          if (phase === "apply" && args.at(-2) === "--apply-plan") return { status: 0, output: "" };
        }
        return normal(command, args, options);
      });
      assert.equal(out.result, "fail", `${channel} ${phase}`);
      const scaffold = out.steps.find((entry) => entry.name === `${channel} scaffold (offline canary)`);
      assert.equal(scaffold.status, "fail");
      assert.match(scaffold.detail, phase === "preview" ? /wrote to the target/ : /receipt/);
      assert.equal(out.steps.find((entry) => entry.name === "published-asset install").status, "refused");
    }
  }
});

test("install-canaries-npm-sea: rejects a malformed plan or consent digest before apply", (t) => {
  for (const [output, diagnostic] of [
    ["installer did not return JSON", /valid dry-run plan/],
    [JSON.stringify({ digest: "not-a-digest" }), /valid plan digest/],
  ]) {
    const f = fixtureRepo();
    t.after(f.cleanup);
    const normal = fakeExec({ seaBinary: true });
    const out = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
      if (path.basename(command) === "create-concord") {
        assert.equal(args.at(-1), "--dry-run", "invalid plan must prevent apply");
        return { status: 0, output };
      }
      return normal(command, args, options);
    });
    assert.equal(out.result, "fail");
    assert.match(out.detail, diagnostic);
    assert.equal(out.steps.find((entry) => entry.name === "SEA scaffold (offline canary)").status, "pass");
  }
});

test("install-canaries-npm-sea: reports the published-asset check as refused when the community cut fails", () => {
  const f = fixtureRepo();
  try {
    const out = runWith(f, "install-canaries-npm-sea", fakeExec({ build: { status: 1, output: "known hygiene failure" } }));
    assert.equal(out.result, "fail");
    const refusal = out.steps.find((x) => x.name === "published-asset install");
    assert.deepEqual(refusal, {
      name: "published-asset install",
      status: "refused",
      detail: "refused: requires published release assets; local-only verification does not publish",
    });
  } finally {
    f.cleanup();
  }
});

test("install-canaries-npm-sea: a SEA build that exits 0 without a binary is still a fail", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec({});
    const out = runWith(f, "install-canaries-npm-sea", (cmd, args, options) => {
      if (args[0]?.endsWith("/build-linux-binary.sh")) {
        fs.writeFileSync(path.join(args[1], `concord-linux-${os.machine()}.sha256`), "checksum only");
      }
      return exec(cmd, args, options);
    });
    assert.equal(out.result, "fail");
    assert.match(out.detail, /without a binary/);
    assert.ok(out.steps.find((x) => x.name === "npm install (offline canary)").status === "pass", "npm canary itself passed");
  } finally {
    f.cleanup();
  }
});

// COORD-1046: a timed-out gate must take its grandchildren with it. spawnSync's timeout kills only the
// direct child, so the real defaultExec runs each gate in its own process group and kills that group.
function processGone(pid) {
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    try {
      if (fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z")) return true;
    } catch {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

test("defaultExec: a gate that times out takes its long-lived grandchild down with it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gate-exec-test-"));
  const pidFile = path.join(dir, "grandchild.pid");
  let grandchild = null;
  let observedGone = false;
  try {
    const run = gates.defaultExec("bash", ["-c", `sleep 300 & echo $! > "${pidFile}"; wait`], { cwd: dir, timeout: 1000 });
    assert.notEqual(run.status, 0, "a timed-out gate is not a pass");
    grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(grandchild > 1, "the gate started a grandchild");
    observedGone = processGone(grandchild);
    assert.equal(observedGone, true, `grandchild ${grandchild} must be gone after the gate timed out`);
  } finally {
    if (!grandchild && fs.existsSync(pidFile)) grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (grandchild > 1 && !observedGone) {
      try { process.kill(grandchild, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultExec: a normal gate returns its exit status and its stdout and stderr together", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gate-exec-test-"));
  try {
    const run = gates.defaultExec("bash", ["-c", "echo out-line; echo err-line 1>&2; exit 3"], { cwd: dir, timeout: 10000 });
    assert.equal(run.status, 3);
    assert.match(run.output, /out-line/);
    assert.match(run.output, /err-line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultExec propagates process-group cleanup errors other than ESRCH", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gate-cleanup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(os, "tmpdir", () => dir);
  const denied = Object.assign(new Error("fixture process-group cleanup denied"), { code: "EPERM" });
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    assert.ok(pid < 0, "cleanup targets the fixture command's process group");
    assert.equal(signal, "SIGKILL");
    throw denied;
  });

  assert.throws(() => gates.defaultExec(process.execPath, ["-e", "process.exit(0)"], {
    cwd: dir, timeout: 10000,
  }), (error) => error === denied);
  assert.equal(kill.mock.callCount(), 1);
});

test("release CLI refuses a non-Git workspace before preparing a cache or report", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gate-non-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const report = path.join(root, "report.json");
  const cli = path.join(DONOR, "coord", "engine", "scripts", "release-gates.js");
  assert.throws(() => execFileSync(process.execPath, [cli, "community-cut-build", "--report", report], {
    cwd: root,
    env: { ...process.env, COORD_RELEASE_GATE_CACHE: cache, GIT_CEILING_DIRECTORIES: path.dirname(root) },
    stdio: "pipe",
  }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /git rev-parse HEAD failed:.*not a git repository/);
    return true;
  });
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(report), false);
  assert.throws(() => gates.runGate("community-cut-build", { root: path.join(root, "missing") }),
    { message: "git rev-parse HEAD failed: " });
});

test("the release-gate CLI writes a report with a top-level result and exits non-zero on fail", () => {
  const f = fixtureRepo();
  try {
    fs.mkdirSync(f.cache, { recursive: true });
    const report = path.join(f.cache, "cli-report.json");
    const cli = path.join(DONOR, "coord", "engine", "scripts", "release-gates.js");
    const run = require("node:child_process").spawnSync(process.execPath, [cli, "no-such-gate", "--report", report], { cwd: f.root, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).result, "fail");
  } finally {
    f.cleanup();
  }
});

test("COORD-1052: release executor exceptions fail without caching a successful cut", (t) => {
  const f = fixtureRepo(); t.after(f.cleanup);
  const out = runWith(f, "community-cut-build", () => { throw new Error("fixture executor unavailable"); });
  assert.equal(out.result, "fail");
  assert.equal(out.detail, "runner threw: fixture executor unavailable");
  assert.deepEqual(out.steps, []);
  const head = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(fs.existsSync(path.join(f.cache, head, "community.status.json")), false);
});

test("COORD-1052: failed cuts prevent dependent scanners and Enterprise qualification", (t) => {
  const f = fixtureRepo(); t.after(f.cleanup);
  const exec = fakeExec({ build: { status: 1, output: "fixture build refused" } });
  for (const gate of ["donor-hygiene-scan", "release-secret-scan", "enterprise-ref-scan", "enterprise-qualification"]) {
    const out = runWith(f, gate, exec);
    assert.equal(out.result, "fail", gate);
    assert.match(out.detail, /exited 1/);
    assert.equal(out.steps.at(-1).status, "fail");
    assert.match(out.steps.at(-1).detail, /cut not built/);
  }
  assert.equal(exec.calls.length, 2, "one failed build per edition, no dependent scanner or publisher");
  assert.ok(exec.calls.every((call) => call.args[0].endsWith("build-public-release.sh")));
});

test("COORD-1052: npm canary failures cannot be hidden by a successful SEA build", (t) => {
  for (const phase of ["stage", "validate", "pack", "install"]) {
    const f = fixtureRepo(); t.after(f.cleanup);
    const normal = fakeExec({ seaBinary: true });
    const exec = (command, args, options) => {
      if ((command === process.execPath && args[1] === `${phase}-qualification`) || (command === "npm" && args[0] === phase)) {
        return { status: 1, output: "fixture npm phase failure" };
      }
      return normal(command, args, options);
    };
    const out = runWith(f, "install-canaries-npm-sea", exec);
    assert.equal(out.result, "fail", phase);
    const step = phase === "install" ? "npm install (offline canary)" : `npm ${phase}`;
    assert.equal(out.steps.find((entry) => entry.name === step).status, "fail");
    assert.equal(out.detail, `failed: ${step}`, "report the local failure, not the deferred published-asset check");
    assert.equal(out.steps.find((entry) => entry.name === "SEA binary build").status, "pass");
    assert.equal(out.steps.find((entry) => entry.name === "published-asset install").status, "refused");
  }
});

test("COORD-1052: release CLI rejects missing gate or report destination without building", (t) => {
  const f = fixtureRepo(); t.after(f.cleanup);
  const cli = path.join(DONOR, "coord", "engine", "scripts", "release-gates.js");
  for (const args of [[], ["community-cut-build", "--report"]]) {
    const out = require("node:child_process").spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: "utf8" });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /usage: release-gates/);
    assert.equal(out.stdout, "");
  }
  assert.equal(fs.existsSync(f.cache), false);
});

test("COORD-1052: missing gate executable returns failure and persists its diagnostic log", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-missing-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "gate.log");
  const out = gates.defaultExec(path.join(dir, "does-not-exist"), [], { cwd: dir, timeout: 1000, log });
  assert.notEqual(out.status, 0);
  assert.match(out.output, /ENOENT/);
  assert.equal(fs.readFileSync(log, "utf8"), out.output);
});

for (const [kind, branch, legacyBranch] of [
  ["community", "concord-public-release", "concordrelease"],
  ["enterprise", "concord-enterprise-release", "enterprise-release"],
]) {
  test(`${kind} donor attestation requires its canonical release branch`, () => {
    for (const donorBranch of [branch, legacyBranch]) {
      const f = fixtureRepo();
      try {
        const outcome = runWith(f, `${kind}-cut-build`, fakeExec({ donorBranch }));
        assert.equal(outcome.result, donorBranch === branch ? "pass" : "fail");
        if (donorBranch === legacyBranch) assert.ok(outcome.detail.includes(`not attested as publishable from ${branch}`), outcome.detail);
      } finally { f.cleanup(); }
    }
  });
}

test("cut cache: a matching failed-build receipt stays failed and is not rebuilt for dependents", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec({ build: { status: 1, output: "RELEASE BUILD FAILED" } });
    assert.equal(runWith(f, "community-cut-build", exec).result, "fail");
    const dependent = runWith(f, "donor-hygiene-scan", exec);
    assert.equal(dependent.result, "fail");
    assert.match(dependent.detail, /build-public-release\.sh exited 1/);
    assert.equal(exec.calls.filter((c) => /scan-donor-refs\.sh/.test(c.args.join(" "))).length, 0);
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 1);
  } finally {
    f.cleanup();
  }
});

test("cut cache: mismatched donor tree receipt is not reused", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const marker = path.join(f.cache, sha, "community.status.json");
    const receipt = JSON.parse(fs.readFileSync(marker, "utf8"));
    receipt.tree = "0".repeat(40);
    fs.writeFileSync(marker, JSON.stringify(receipt));
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 2);
  } finally {
    f.cleanup();
  }
});

test("cut cache: wrong edition or malformed success status is not reused", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const marker = path.join(f.cache, sha, "community.status.json");
    const receipt = JSON.parse(fs.readFileSync(marker, "utf8"));
    receipt.kind = "enterprise";
    receipt.ok = "true";
    fs.writeFileSync(marker, JSON.stringify(receipt));
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 2);
  } finally {
    f.cleanup();
  }
});

test("cut cache: attestation for another donor commit or edition is not reused", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sidecar = path.join(f.cache, sha, "community.attestation.json");
    const attestation = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    attestation.donor_commit = "f".repeat(40);
    fs.writeFileSync(sidecar, JSON.stringify(attestation));
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const refreshed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    refreshed.donor_edition = "enterprise";
    fs.writeFileSync(sidecar, JSON.stringify(refreshed));
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 3);
  } finally {
    f.cleanup();
  }
});

test("cut cache: modified artifact bytes invalidate success receipt and rebuild", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const cut = path.join(f.cache, sha, "community");
    fs.writeFileSync(path.join(cut, "README.md"), "tampered\n");
    const reused = runWith(f, "community-cut-build", exec);
    assert.equal(reused.result, "pass", reused.detail);
    assert.equal(fs.readFileSync(path.join(cut, "README.md"), "utf8"), "fixture cut\n");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 2);
  } finally {
    f.cleanup();
  }
});

test("cut cache: ignored files and empty directories are included in artifact integrity", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const cut = path.join(f.cache, sha, "community");
    fs.mkdirSync(path.join(cut, "ignored-data"), { recursive: true });
    fs.writeFileSync(path.join(cut, "ignored-data", "extra.txt"), "extra\n");
    fs.mkdirSync(path.join(cut, "coord", "engine", "scripts", "enterprise"), { recursive: true });
    const reused = runWith(f, "community-cut-build", exec);
    assert.equal(reused.result, "pass", reused.detail);
    assert.equal(fs.existsSync(path.join(cut, "ignored-data")), false);
    assert.equal(fs.existsSync(path.join(cut, "coord", "engine", "scripts", "enterprise")), false);
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 2);
  } finally {
    f.cleanup();
  }
});

test("cut cache: an escaping symlink invalidates a receipt and is replaced by the builder", () => {
  const f = fixtureRepo();
  try {
    const exec = fakeExec();
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    const sha = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const cut = path.join(f.cache, sha, "community");
    fs.rmSync(path.join(cut, "coord", "readme-link.md"));
    fs.symlinkSync("../../../../etc/passwd", path.join(cut, "coord", "readme-link.md"));
    const reused = runWith(f, "community-cut-build", exec);
    assert.equal(reused.result, "pass", reused.detail);
    assert.equal(fs.readlinkSync(path.join(cut, "coord", "readme-link.md")), "../README.md");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 2);
    fs.rmSync(path.join(cut, "coord", "readme-link.md"));
    fs.symlinkSync(path.join(cut, "README.md"), path.join(cut, "coord", "readme-link.md"));
    assert.equal(runWith(f, "community-cut-build", exec).result, "pass");
    assert.equal(fs.readlinkSync(path.join(cut, "coord", "readme-link.md")), "../README.md");
    assert.equal(exec.calls.filter((c) => /build-public-release/.test(c.args.join(" "))).length, 3);
  } finally {
    f.cleanup();
  }
});

function updateJson(file, update) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...value, ...update }));
}

test("a successful builder exit cannot qualify an invalid cut for a dependent gate", async (t) => {
  const cases = [
    ["missing cut", (cut) => fs.rmSync(cut, { recursive: true }), /cut directory is missing/],
    ["linked cut root", (cut) => {
      fs.renameSync(cut, `${cut}.real`);
      fs.symlinkSync(path.basename(`${cut}.real`), cut);
    }, /cut path is not a real directory/],
    ["linked Git directory", (cut) => {
      fs.renameSync(path.join(cut, ".git"), `${cut}.git-real`);
      fs.symlinkSync(`${cut}.git-real`, path.join(cut, ".git"));
    }, /cut has no real \.git directory/],
    ["linked attestation", (cut) => {
      fs.renameSync(`${cut}.attestation.json`, `${cut}.real.json`);
      fs.symlinkSync(`${cut}.real.json`, `${cut}.attestation.json`);
    }, /attestation is not a regular file/],
    ["unsupported donor mode", (cut) => {
      updateJson(`${cut}.attestation.json`, { donor_mode: "dev-unpublishable" });
    }, /unsupported donor mode/],
    ["inconsistent local-candidate attestation", (cut) => {
      updateJson(`${cut}.attestation.json`, { unpublishable_reasons: undefined });
    }, /inconsistent unpublished-candidate attestation/],
    ["mismatched attested Git tree", (cut) => {
      updateJson(`${cut}.attestation.json`, { cut_tree_digest: "0".repeat(40) });
    }, /Git tree does not match its attestation/],
    ["missing attested artifact directory", (cut) => {
      updateJson(`${cut}.attestation.json`, { cut_dir: undefined });
    }, /attestation names a different artifact directory/],
    ["linked coord directory", (cut) => {
      fs.renameSync(path.join(cut, "coord"), path.join(cut, "coord-real"));
      fs.symlinkSync("coord-real", path.join(cut, "coord"));
    }, /cut has no real coord\/ directory/],
    ["linked provenance", (cut) => {
      const provenance = path.join(cut, "coord", "RELEASE_PROVENANCE.json");
      fs.renameSync(provenance, path.join(cut, "coord", "provenance-real.json"));
      fs.symlinkSync("provenance-real.json", provenance);
    }, /provenance is not a regular file/],
    ["malformed provenance", (cut) => {
      fs.writeFileSync(path.join(cut, "coord", "RELEASE_PROVENANCE.json"), "{");
    }, /provenance does not bind the expected artifact, edition, and donor commit/],
    ["wrong provenance donor", (cut) => {
      updateJson(path.join(cut, "coord", "RELEASE_PROVENANCE.json"), { donor_commit: "0".repeat(40) });
    }, /provenance does not bind the expected artifact, edition, and donor commit/],
    ["dirty artifact", (cut) => {
      fs.writeFileSync(path.join(cut, "README.md"), "changed after build\n");
    }, /cut working tree is dirty/],
    ["dangling artifact link", (cut) => {
      fs.symlinkSync("missing.md", path.join(cut, "coord", "dangling.md"));
    }, /unresolved symlink coord\/dangling\.md/],
    ["artifact link resolves outside the cut through Git metadata", (cut) => {
      const parent = path.dirname(cut);
      fs.writeFileSync(path.join(parent, "outside-cut.txt"), "fixture outside the cut\n");
      fs.symlinkSync("../../outside-cut.txt", path.join(cut, ".git", "redirect"));
      fs.symlinkSync("../.git/redirect", path.join(cut, "coord", "outside.md"));
    }, /escaping symlink coord\/outside\.md/],
    ["unsupported special file", (cut) => {
      execFileSync("mkfifo", [path.join(cut, "coord", "special-file")]);
    }, /unsupported filesystem entry in cut: coord\/special-file/],
  ];
  for (const [name, invalidate, reason] of cases) {
    await t.test(name, (t) => {
      const f = fixtureRepo();
      t.after(f.cleanup);
      const builder = fakeExec();
      const outcome = runWith(f, "release-secret-scan", (command, args, options) => {
        assert.equal(path.basename(args[0]), "build-public-release.sh");
        const result = builder(command, args, options);
        invalidate(args[1]);
        return result;
      });
      assert.equal(outcome.result, "fail");
      assert.match(outcome.detail, reason);
      assert.deepEqual(outcome.steps.map(({ name, status }) => [name, status]), [
        ["community cut built", "fail"],
        ["release-secret-scan", "fail"],
      ]);
      const receipt = JSON.parse(fs.readFileSync(path.join(f.cache, outcome.commit, "community.status.json"), "utf8"));
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, outcome.detail);
      assert.equal(receipt.artifact_digest, undefined);
    });
  }
});

test("an incomplete Enterprise cut blocks the publish dry run", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const builder = fakeExec();
  const missing = "coord/scripts/enterprise";
  const outcome = runWith(f, "enterprise-qualification", (command, args, options) => {
    assert.equal(path.basename(args[0]), "build-public-release.sh");
    assert.ok(args.includes("--enterprise"));
    const result = builder(command, args, options);
    fs.rmdirSync(path.join(args[1], missing));
    return result;
  });
  assert.equal(outcome.result, "fail");
  assert.equal(outcome.detail, `Enterprise cut is missing ${missing}`);
  assert.equal(outcome.steps.at(-1).detail, "enterprise cut not built");
  assert.equal(builder.calls.length, 1);
});

test("cut cache replaces corrupt and linked receipts before using the artifact", async (t) => {
  for (const [name, replaceMarker] of [
    ["corrupt JSON", (marker) => fs.writeFileSync(marker, "{")],
    ["symlink to valid receipt", (marker) => {
      fs.renameSync(marker, `${marker}.saved`);
      fs.symlinkSync(`${marker}.saved`, marker);
    }],
  ]) {
    await t.test(name, (t) => {
      const f = fixtureRepo();
      t.after(f.cleanup);
      const builder = fakeExec();
      const first = runWith(f, "community-cut-build", builder);
      assert.equal(first.result, "pass", first.detail);
      const marker = path.join(f.cache, first.commit, "community.status.json");
      replaceMarker(marker);
      const rebuilt = runWith(f, "community-cut-build", builder);
      assert.equal(rebuilt.result, "pass", rebuilt.detail);
      assert.equal(rebuilt.steps[0].name, "community cut built");
      assert.equal(builder.calls.length, 2);
      assert.equal(fs.lstatSync(marker).isFile(), true);
      assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).ok, true);
    });
  }
});

test("a cut receipt inspection error refuses the gate without rebuilding or scanning", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const builder = fakeExec();
  const built = runWith(f, "community-cut-build", builder);
  assert.equal(built.result, "pass", built.detail);
  const receipt = path.join(f.cache, built.commit, "community.status.json");
  const before = fs.readFileSync(receipt);

  const lstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (file === receipt) throw Object.assign(new Error("fixture receipt access denied"), { code: "EACCES" });
    return lstatSync(file, ...args);
  });
  const outcome = runWith(f, "release-secret-scan", () => assert.fail("a receipt access error must stop the gate"));
  assert.equal(outcome.result, "fail");
  assert.equal(outcome.detail, "runner threw: fixture receipt access denied");
  assert.deepEqual(outcome.steps, []);
  assert.deepEqual(fs.readFileSync(receipt), before);
});

test("npm canary requires the packed tarball and the installed executable even after exit zero", async (t) => {
  for (const [phase, failedStep] of [
    ["pack", "npm pack"],
    ["install", "npm install (offline canary)"],
  ]) {
    await t.test(phase, (t) => {
      const f = fixtureRepo();
      t.after(f.cleanup);
      const normal = fakeExec({ seaBinary: true });
      const out = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
        if (command === "npm" && args[0] === phase) {
          if (phase === "pack") fs.rmSync(args[2], { recursive: true });
          return { status: 0, output: "" };
        }
        return normal(command, args, options);
      });
      assert.equal(out.result, "fail");
      assert.deepEqual(out.steps.find((entry) => entry.name === failedStep), {
        name: failedStep,
        status: "fail",
        detail: null,
      });
      assert.equal(out.steps.find((entry) => entry.name === "SEA binary build").status, "pass");
      if (phase === "pack") {
        const ambiguous = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
          if (command === "npm" && args[0] === "pack") {
            fs.writeFileSync(path.join(args[2], "another-build.tgz"), "ambiguous build output");
          }
          return normal(command, args, options);
        });
        assert.equal(ambiguous.steps.find((entry) => entry.name === "npm pack").status, "fail");
        assert.ok(!ambiguous.steps.some((entry) => entry.name === "npm install (offline canary)"));
      }
    });
  }
});

test("an older failed receipt without a diagnostic still blocks a dependent scan", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const builder = fakeExec({ build: { status: 1, output: "build failed" } });
  const first = runWith(f, "community-cut-build", builder);
  assert.equal(first.result, "fail");
  updateJson(path.join(f.cache, first.commit, "community.status.json"), { reason: undefined });

  const dependent = runWith(f, "donor-hygiene-scan", builder);
  assert.equal(dependent.result, "fail");
  assert.equal(dependent.detail, "cached cut build failed");
  assert.equal(dependent.steps[0].name, "community cut (reused failure)");

  const refusal = "refused: fixture requires an approved cut source";
  updateJson(path.join(f.cache, first.commit, "community.status.json"), { reason: refusal });
  const refusedScan = runWith(f, "donor-hygiene-scan", builder);
  assert.equal(refusedScan.result, "fail");
  assert.equal(refusedScan.detail, refusal);
  assert.equal(refusedScan.steps.at(-1).detail, "community cut not built");
  assert.equal(builder.calls.length, 1);
});

test("release CLI resolves local scripts and writes a successful fixture report", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const release = path.join(f.root, "release");
  fs.writeFileSync(path.join(release, "verify-dual-release.sh"), [
    "#!/usr/bin/env bash",
    "set -eu",
    'mkdir -p "$1"',
    'node "$(dirname "$0")/fixture-verifier.js" "$1"',
    'printf "%s\\n" "DUAL-RELEASE QUALIFICATION PASS"',
    "",
  ].join("\n"));
  const modulePath = path.join(__dirname, "run-manifest.js");
  fs.writeFileSync(path.join(release, "fixture-verifier.js"),
    `(${writeDualEvidence.toString()})(process.cwd(), process.argv[2], ${JSON.stringify(modulePath)});\n`);
  gitFixture(f.root, ["add", "release"]);
  gitFixture(f.root, ["commit", "-qm", "fixture verifier"]);
  fs.mkdirSync(f.cache);
  const report = path.join(f.cache, "outcome.json");
  const cli = path.join(DONOR, "coord", "engine", "scripts", "release-gates.js");

  const stdout = execFileSync(process.execPath, [cli, "dual-release-verify", "--report", report], {
    cwd: f.root,
    env: { ...process.env, COORD_RELEASE_GATE_CACHE: f.cache },
    encoding: "utf8",
  });
  assert.equal(stdout, "release-gate dual-release-verify: pass\n");
  const outcome = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(outcome.schema, gates.REPORT_SCHEMA);
  assert.equal(outcome.result, "pass");
  assert.equal(outcome.commit, gitFixture(f.root, ["rev-parse", "HEAD"]));
  assert.equal(outcome.qualification_receipt.sha256,
    require("node:crypto").createHash("sha256").update(fs.readFileSync(outcome.qualification_receipt.path)).digest("hex"));
  assert.ok(fs.readdirSync(path.join(f.cache, outcome.commit)).some((name) => name.startsWith("dual-")));

  const temp = path.join(f.cache, "tmp");
  fs.mkdirSync(temp);
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp };
  delete env.COORD_RELEASE_GATE_CACHE;
  const script = 'const gates = require(process.argv[1]); console.log(JSON.stringify(gates.runGate("dual-release-verify")));';
  const defaultOutcome = JSON.parse(execFileSync(process.execPath, ["-e", script, cli], {
    cwd: f.root, env, encoding: "utf8",
  }));
  assert.notEqual(defaultOutcome.qualification_receipt.path, outcome.qualification_receipt.path);
  defaultOutcome.qualification_receipt.path = outcome.qualification_receipt.path;
  assert.deepEqual(defaultOutcome, outcome);
  assert.ok(fs.readdirSync(path.join(temp, "coord-release-gates", outcome.commit)).some((name) => name.startsWith("dual-")));
});

test("install qualification refuses a SEA digest mismatch before executing the binary", (t) => {
  const f = fixtureRepo();
  t.after(f.cleanup);
  const normal = fakeExec({ seaBinary: true, seaAttestation: { sha256: "0".repeat(64) } });
  const out = runWith(f, "install-canaries-npm-sea", (command, args, options) => {
    assert.ok(!path.basename(command).startsWith("concord-qualification-linux-"));
    return normal(command, args, options);
  });
  assert.equal(out.result, "fail");
  assert.match(out.detail, /binary attestation does not bind the qualification cut/);
});
