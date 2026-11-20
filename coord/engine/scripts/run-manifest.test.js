"use strict";

// COORD-910: run manifests — schema validation, compare output, and refusal to
// reuse evidence after the tree, base or any other input changed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rm = require("./run-manifest.js");
const { gitFixture } = require("./test-git-fixture.js");


// A small committed workspace with the policy, gate-config and lock files a
// manifest digests.
function makeRepo(t, { enterprise = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord910-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    "coord/GOVERNANCE.md": "# policy\n",
    "coord/project.config.js": "module.exports = {};\n",
    "coord/engine/governance-guards.json": "{}\n",
    "coord/engine-pin.json": "{}\n",
    "release/suite-inventory.json": "{}\n",
    "package-lock.json": "{}\n",
    "frontend/app/package-lock.json": "{}\n",
    "src/a.js": "module.exports = 1;\n",
  };
  if (enterprise) files["coord/engine/scripts/enterprise/x.js"] = "\n";
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  gitFixture(root, ["init", "-q", "-b", "main"]);
  gitFixture(root, ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "-A"]);
  gitFixture(root, ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
  return root;
}

function commit(root, rel, body) {
  fs.writeFileSync(path.join(root, rel), body);
  gitFixture(root, ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qam", `edit ${rel}`]);
  return gitFixture(root, ["rev-parse", "HEAD"]);
}

function manifestFor(root, { base = "main", env = {}, lanes = [{ name: "n22", exit_code: 0, signal: null, duration_ms: 5 }], ruling = null } = {}) {
  const { inputs, host } = rm.collectInputs({ root, env, base, gateConfig: { lane: "full" }, scrubbedEnv: ["COORD_SESSION_ID"] });
  return rm.buildManifest({ tool: "test", inputs, host, lanes, evidencePolicy: rm.defaultEvidencePolicy({ COORD_BATCHING_RULING: ruling || undefined }) });
}

function capture(fn) {
  const out = { text: "", write(chunk) { this.text += chunk; return true; } };
  const err = { text: "", write(chunk) { this.text += chunk; return true; } };
  const status = fn(out, err);
  return { status, out: out.text, err: err.text };
}

test("COORD-910: a collected manifest records every input and validates against its schema", (t) => {
  const root = makeRepo(t);
  const env = { GOVERNANCE_SUITE_TIMEOUT_SECONDS: "3600", COORD_OTHER: "x", NODE_TEST_TIMEOUT: "9" };
  const m = manifestFor(root, { env });
  assert.deepEqual(rm.validateManifest(m), []);
  assert.equal(m.inputs.source.commit, gitFixture(root, ["rev-parse", "HEAD"]));
  assert.equal(m.inputs.source.tree, gitFixture(root, ["rev-parse", "HEAD^{tree}"]));
  assert.equal(m.inputs.source.base, m.inputs.source.commit);
  assert.equal(m.inputs.source.dirty, false);
  assert.equal(m.inputs.edition, "Community");
  assert.deepEqual(m.inputs.dependencies.map((d) => d.path), ["frontend/app/package-lock.json", "package-lock.json"]);
  assert.match(m.inputs.dependencies[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(m.inputs.environment.timeouts, { GOVERNANCE_SUITE_TIMEOUT_SECONDS: "3600", NODE_TEST_TIMEOUT: "9" });
  assert.match(m.inputs.environment.umask, /^[0-7]{4}$/);
  assert.deepEqual(m.inputs.environment.scrubbed_env, ["COORD_SESSION_ID"]);
  assert.equal(m.inputs.toolchain.node, process.version);
  assert.match(m.inputs.toolchain.git, /^\d+\.\d+/);
  assert.equal(m.inputs.policy.files.find((f) => f.path === "coord/engine/shim-registry.json").sha256, null);
  assert.equal(m.inputs.gate_config.lane, "full");
  assert.equal(m.inputs.tool_revision.tool, null);
  assert.match(m.inputs.tool_revision.engine_pin, /^sha256:/);
  assert.equal(m.host.kernel, os.release());
  assert.equal(m.result, "pass");
  assert.equal(m.evidence_policy.rule, rm.STACKED_RULE);
});

test("COORD-910: edition, umask, filesystem type and TMPDIR symlink facts", (t) => {
  assert.equal(rm.detectEdition(makeRepo(t, { enterprise: true })), "Enterprise");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "coord910-bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(rm.detectEdition(bare), "engine");
  fs.mkdirSync(path.join(bare, "release"));
  fs.writeFileSync(path.join(bare, "release", "build-public-release.sh"), "");
  assert.equal(rm.detectEdition(bare), "donor");
  assert.deepEqual(rm.lockFiles(path.join(bare, "release")), ["coord/package-lock.json", "package-lock.json"]);
  assert.equal(rm.formatUmask(0o22), "0022");
  const mounts = "rootfs / ext4 rw 0 0\ntmpfs /tmp tmpfs rw 0 0\nbroken\n/dev/x /tmp/deep xfs rw 0 0\n";
  assert.equal(rm.filesystemType("/tmp/deep/a", mounts), "xfs");
  assert.equal(rm.filesystemType("/tmp/other", mounts), "tmpfs");
  assert.equal(rm.filesystemType("/home/x", mounts), "ext4");
  assert.equal(rm.filesystemType("/home/x", ""), "unknown");
  const link = path.join(bare, "tmp-link");
  fs.symlinkSync(bare, link);
  const facts = rm.tmpdirFacts(link, "x / ext4 rw 0 0\n");
  assert.deepEqual(facts, { path: link, realpath: fs.realpathSync(bare), symlink: true, fs_type: "ext4" });
  assert.deepEqual(rm.tmpdirFacts(path.join(bare, "missing")), { path: path.join(bare, "missing"), realpath: null, symlink: false, fs_type: "unknown" });
  assert.equal(typeof rm.filesystemType("/"), "string");
  assert.equal(rm.filesystemType("/", undefined, path.join(bare, "no-mount-table")), "unknown", "no mount table: unknown");
  assert.equal(rm.gitVersion(path.join(bare, "missing-dir")), null, "git cannot run: no version");
});

test("COORD-910: schema validation names missing fields, bad digests and result/lane mismatches", (t) => {
  const root = makeRepo(t);
  const good = manifestFor(root);
  const errorsOf = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return rm.validateManifest(copy);
  };
  assert.ok(errorsOf((m) => delete m.inputs).some((e) => /missing required "inputs"/.test(e)));
  assert.ok(errorsOf((m) => { m.inputs.environment.umask = "22"; }).some((e) => /umask/.test(e)));
  const unknownQualification = { ...good, qualification: "unknown" };
  assert.ok(rm.validateManifest(unknownQualification).some((error) => error.startsWith("$.qualification:")));
  const relaxedQualificationSchema = structuredClone(require("../run-manifest.schema.json"));
  delete relaxedQualificationSchema.properties.qualification.enum;
  assert.deepEqual(rm.validateManifest(unknownQualification, relaxedQualificationSchema), [
    "$.qualification: unsupported qualification value",
  ]);
  assert.deepEqual(errorsOf((m) => { m.inputs.toolchain.git = "2.0"; }), ["$.input_digest: does not match the recorded inputs"]);
  assert.deepEqual(errorsOf((m) => {
    m.inputs.policy.digest = `sha256:${"0".repeat(64)}`;
    m.input_digest = rm.digestOf(m.inputs);
  }), ["$.inputs.policy.digest: does not match the policy files"]);
  assert.deepEqual(errorsOf((m) => { m.lanes[0].exit_code = 1; }), ["$.result: lanes say fail"]);
  assert.deepEqual(errorsOf((m) => { m.artifacts = [{ path: "/gone", sha256: null, bytes: null }]; }), ["$.artifacts[0]: /gone was not produced"]);
  assert.equal(rm.buildManifest({ tool: "x", inputs: good.inputs, host: good.host }).result, "fail", "no lanes is never a pass");
});

test("COORD-910: dirty working trees carry a content digest, and artifacts are hashed", (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, "new.txt"), "one\n");
  const a = manifestFor(root);
  fs.writeFileSync(path.join(root, "new.txt"), "two\n");
  const b = manifestFor(root);
  assert.equal(a.inputs.source.dirty, true);
  assert.match(a.inputs.source.dirty_digest, /^sha256:/);
  assert.notEqual(a.inputs.source.dirty_digest, b.inputs.source.dirty_digest);
  const [art, missing] = rm.artifactDigests([path.join(root, "new.txt"), path.join(root, "nope")]);
  assert.equal(art.bytes, 4);
  assert.match(art.sha256, /^sha256:/);
  assert.deepEqual(missing, { path: path.join(root, "nope"), sha256: null, bytes: null });
  assert.equal(rm.manifestPathFor("/r/report.json"), "/r/report.manifest.json");
  assert.equal(rm.manifestPathFor("/r/report.json", "/m.json"), "/m.json");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coord910-nogit-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { inputs } = rm.collectInputs({ root: outside, env: {} });
  assert.deepEqual(inputs.source, { commit: null, tree: null, base: null, dirty: false, dirty_digest: null });
});

test("COORD-910: compare lists environment differences next to result differences", (t) => {
  const root = makeRepo(t);
  const a = manifestFor(root, { env: { GOVERNANCE_SUITE_TIMEOUT_SECONDS: "3600" } });
  const b = JSON.parse(JSON.stringify(manifestFor(root, {
    env: { GOVERNANCE_SUITE_TIMEOUT_SECONDS: "900" },
    lanes: [{ name: "n22", exit_code: 1, signal: null, duration_ms: 7 }],
  })));
  b.inputs.toolchain.git = "2.34.1";
  b.host.kernel = "other-kernel";
  b.input_digest = rm.digestOf(b.inputs);
  const same = rm.compareManifests(a, a);
  assert.equal(same.same_inputs, true);
  assert.deepEqual([same.inputs, same.environment, same.host, same.results], [[], [], [], []]);
  const cmp = rm.compareManifests(a, b);
  assert.equal(cmp.same_inputs, false);
  assert.deepEqual(cmp.environment.map((d) => d.path), ["inputs.environment.timeouts.GOVERNANCE_SUITE_TIMEOUT_SECONDS", "inputs.toolchain.git"]);
  assert.deepEqual(cmp.host.map((d) => d.path), ["host.kernel"]);
  assert.deepEqual(cmp.results.map((d) => d.path), ["result", "lanes.n22.duration_ms", "lanes.n22.exit_code"]);
  assert.deepEqual(cmp.inputs, []);
  const text = rm.formatCompare(cmp, ["a.json", "b.json"]);
  const lines = text.split("\n");
  assert.equal(lines[0], "run-manifest compare: a.json vs b.json (inputs differ)");
  assert.equal(lines[1], "results: 3 difference(s)");
  assert.ok(text.indexOf("environment (toolchain, settings, edition): 2 difference(s)") > text.indexOf("lanes.n22.exit_code"));
  assert.match(text, /~ inputs\.toolchain\.git: ".+" -> "2\.34\.1"/);
  assert.match(text, /inputs: none/);
  assert.match(rm.formatCompare(same), /^run-manifest compare: A vs B \(inputs identical\)\nresults: none\n/);
  assert.deepEqual(rm.compareManifests({}, {}), { same_inputs: true, inputs: [], environment: [], host: [], results: [] });
});

test("COORD-910: evidence reuse is refused after the tree, base or any other input changed", (t) => {
  const root = makeRepo(t);
  const evidence = manifestFor(root);
  assert.deepEqual(rm.checkEvidenceReuse(evidence, manifestFor(root)).refusals, []);
  const reasons = (current, options) => rm.checkEvidenceReuse(evidence, current, options).refusals;
  assert.deepEqual(reasons(manifestFor(root, { env: { GOVERNANCE_SUITE_TIMEOUT_SECONDS: "1" } })),
    ['input differs: inputs.environment.timeouts.GOVERNANCE_SUITE_TIMEOUT_SECONDS (null -> "1")']);
  assert.match(reasons(manifestFor(root, { base: null })).join("\n"), /landing changes the tested base/);
  const policyChanged = manifestFor(root);
  fs.writeFileSync(path.join(root, "coord/GOVERNANCE.md"), "# changed\n");
  const policyRefusals = reasons(manifestFor(root)).join("\n");
  assert.match(policyRefusals, /input differs: inputs\.policy\.digest/);
  assert.match(policyRefusals, /landing changes the tested tree/, "an uncommitted edit changes the tested tree too");
  gitFixture(root, ["checkout", "--", "coord/GOVERNANCE.md"]);
  assert.deepEqual(reasons(policyChanged), []);
  commit(root, "src/a.js", "module.exports = 2;\n");
  assert.match(reasons(manifestFor(root)).join("\n"), /landing changes the tested tree \(\w+ -> \w+\)/);
});

test("COORD-910: stacked evidence needs a batching ruling and an ancestor ticket commit", (t) => {
  const root = makeRepo(t);
  const ticket = gitFixture(root, ["rev-parse", "HEAD"]);
  commit(root, "src/a.js", "module.exports = 3;\n");
  const top = manifestFor(root);
  const current = manifestFor(root);
  const verdict = rm.checkEvidenceReuse(top, current, { intermediate: true, root });
  assert.equal(verdict.ok, false);
  assert.match(verdict.refusals[0], /intermediate ticket without a recorded batching ruling/);
  const ruled = rm.checkEvidenceReuse(top, current, { intermediate: true, batchingRuling: "2026-11-04 human ruling", ticketCommit: ticket, root });
  assert.deepEqual([ruled.ok, ruled.batching_ruling], [true, "2026-11-04 human ruling"]);
  const recorded = manifestFor(root, { ruling: "recorded in manifest" });
  assert.equal(rm.checkEvidenceReuse(recorded, current, { intermediate: true, root }).batching_ruling, "recorded in manifest");
  gitFixture(root, ["checkout", "-q", "-b", "side", ticket]);
  const stray = commit(root, "src/a.js", "module.exports = 4;\n");
  gitFixture(root, ["checkout", "-q", "main"]);
  const notAncestor = rm.checkEvidenceReuse(top, current, { intermediate: true, batchingRuling: "r", ticketCommit: stray, root });
  assert.match(notAncestor.refusals.join("\n"), /is not an ancestor of the tested commit/);
});

test("COORD-910: failed, dirty, unknown-source and invalid evidence is never reused", (t) => {
  const root = makeRepo(t);
  const failed = manifestFor(root, { lanes: [{ name: "n22", exit_code: 1, signal: null, duration_ms: 1 }] });
  assert.match(rm.checkEvidenceReuse(failed, manifestFor(root)).refusals[0], /evidence run result is fail/);
  fs.writeFileSync(path.join(root, "dirt"), "x");
  const dirty = manifestFor(root);
  assert.match(rm.checkEvidenceReuse(dirty, dirty).refusals.join("\n"), /dirty working tree/);
  const unknown = JSON.parse(JSON.stringify(dirty));
  unknown.inputs.source = { commit: null, tree: null, base: null, dirty: false, dirty_digest: null };
  unknown.input_digest = rm.digestOf(unknown.inputs);
  assert.match(rm.checkEvidenceReuse(unknown, unknown).refusals.join("\n"), /source commit or tree is unknown/);
  const broken = { ...dirty, input_digest: `sha256:${"1".repeat(64)}` };
  const invalid = rm.checkEvidenceReuse(broken, dirty);
  assert.deepEqual(invalid.refusals, ["evidence manifest invalid: $.input_digest: does not match the recorded inputs"]);
  assert.match(rm.formatReuseRefusal(invalid), /^run-manifest: refusing evidence reuse: 1 problem\(s\)\n  - evidence manifest invalid/);
});

test("COORD-910: the CLI collects, writes, validates, compares and checks reuse", (t) => {
  const root = makeRepo(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord910-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (n) => path.join(dir, n);
  fs.writeFileSync(file("log"), "lane log\n");
  const run = (argv) => capture((out, err) => rm.main(argv, { out, err }));
  const w = run(["write", "--root", root, "--tool", "dual", "--base", "main", "--out", file("a.json"), "--lane", "community:0:12", "--lane", "enterprise:0:3.5", "--artifact", file("log")]);
  assert.equal(w.status, 0, w.err);
  assert.match(w.out, /wrote .*a\.json input_digest=sha256:\w+ result=pass/);
  const a = JSON.parse(fs.readFileSync(file("a.json"), "utf8"));
  assert.deepEqual(a.lanes.map((l) => [l.name, l.exit_code, l.duration_ms]), [["community", 0, 12], ["enterprise", 0, 3.5]]);
  assert.equal(a.artifacts[0].bytes, 9);
  assert.deepEqual(run(["validate", file("a.json")]).status, 0);
  run(["write", "--root", root, "--tool", "dual", "--base", "main", "--out", file("b.json"), "--lane", "community:1:12"]);
  const c = run(["compare", file("a.json"), file("b.json")]);
  assert.match(c.out, /lanes\.community\.exit_code: 0 -> 1/);
  assert.match(run(["compare", file("a.json"), file("b.json"), "--json"]).out, /"same_inputs": false/);
  const ok = run(["check-reuse", file("a.json"), file("a.json")]);
  assert.deepEqual([ok.status, ok.out], [0, "run-manifest: evidence reuse allowed: every input matches\n"]);
  const refused = run(["check-reuse", file("b.json"), file("a.json"), "--json", "--intermediate"]);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /refusing evidence reuse/);
  assert.match(refused.out, /"ok": false/);
  const printed = run(["collect", "--root", root]);
  assert.equal(JSON.parse(printed.out).kind, "coord-run-manifest");
  assert.equal(run(["collect", "--root", root, "--out", file("c.json")]).status, 0);
  const tampered = { ...a, result: "fail" };
  fs.writeFileSync(file("bad.json"), JSON.stringify(tampered));
  const bad = run(["validate", file("bad.json")]);
  assert.deepEqual([bad.status, bad.err], [1, "run-manifest: $.result: lanes say pass\n"]);
  assert.match(run(["write", "--lane", "nope"]).err, /--lane must be <name>:<exit>:<ms>/);
  assert.throws(() => rm.parseLane(undefined), /--lane must be <name>:<exit>:<ms>, got undefined/);
  assert.equal(run(["write", "--root", root, "--out", file("d.json"), "--lane", "x:0:1"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file("d.json"), "utf8")).tool, "unknown", "a write without --tool says so");
  const unknown = run(["bogus"]);
  assert.deepEqual([unknown.status, unknown.err], [2, "run-manifest: unknown command bogus (collect, write, validate, compare, check-reuse)\n"]);
});

test("COORD-910: the CLI entrypoint runs main and sets the exit code", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "run-manifest.js"), "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command bogus/);
});

test("COORD-910: repo-gate and test-runner manifests record their lanes and plan", (t) => {
  const root = makeRepo(t);
  const gate = rm.repoGateManifest({ root, lane: "default", invocation: { kind: "bash" }, exitCode: 0, durationMs: 4, env: {} });
  assert.deepEqual(rm.validateManifest(gate), []);
  assert.equal(gate.inputs.gate_config.invocation, "bash scripts/gate.sh");
  const script = rm.repoGateManifest({ root, lane: "full", invocation: { kind: "script", script: "gate:full" }, exitCode: 2, signal: "SIGTERM", durationMs: 1, env: {} });
  assert.deepEqual([script.inputs.gate_config.invocation, script.lanes[0].signal, script.result], ["script gate:full", "SIGTERM", "fail"]);
  const runner = rm.testRunnerManifest({
    root, argv: ["--file", "x.test.js"], env: { COORD_RUN_BASE: "main" },
    opts: { modules: [], files: ["x.test.js"], engineCoverage: false, passthrough: [], base: null },
    selected: [{ name: "core", files: ["x.test.js"] }],
    results: [{ module: "core", exit_code: 0, signal: null, duration_ms: 3 }],
    scrubbedEnv: ["CLAUDECODE"], toolFile: __filename,
  });
  assert.deepEqual(runner.plan, { shards: [{ lane: "core", files: ["x.test.js"] }], selection: null });
  assert.equal(runner.inputs.source.base, gitFixture(root, ["rev-parse", "main"]));
  assert.match(runner.inputs.tool_revision.tool, /^sha256:/);
  assert.equal(rm.finalizeManifest(runner, [__filename]).artifacts.length, 1);
  assert.equal(rm.parseLane("x:-1:0").exit_code, -1);
  assert.deepEqual(rm.bindingArgv(["--file", "a", "--report", "/tmp/r.json", "--manifest", "/tmp/m.json", "--base", "dev"]), ["--file", "a", "--base", "dev"],
    "output locations are not inputs, so two runs of the same gate compare equal");
  const opts = { modules: [], files: [], engineCoverage: true, passthrough: [] };
  const args = { root, argv: [], selected: [], results: [], scrubbedEnv: [], toolFile: null };
  assert.equal(rm.testRunnerManifest({ ...args, env: {}, opts: { ...opts, base: null } }).inputs.source.base, null, "no base recorded");
  assert.equal(rm.testRunnerManifest({ ...args, env: {}, opts: { ...opts, base: "main" } }).inputs.source.base, gitFixture(root, ["rev-parse", "main"]));
  const sharded = rm.testRunnerManifest({ ...args, env: {}, opts: { ...opts, base: null, shards: 4 },
    selected: [{ name: "core", files: ["x.test.js"] }], results: [{ module: "core", exit_code: 0, signal: null, duration_ms: 3 }] });
  assert.equal(sharded.result, "provisional", "green sharded execution is not landing evidence without donor receipt");
  assert.deepEqual(rm.validateManifest(sharded), []);
  assert.match(rm.checkEvidenceReuse(sharded, sharded).refusals.join("\n"), /evidence run result is provisional/);
  const autoSharded = rm.testRunnerManifest({ ...args, env: {}, opts: { ...opts, base: null, shards: "auto" },
    selected: [{ name: "core", files: ["x.test.js"] }], results: [{ module: "core", exit_code: 0, signal: null, duration_ms: 3 }] });
  assert.equal(autoSharded.result, "provisional", "auto sharding is provisional just like a numeric shard count");
  assert.deepEqual(rm.validateManifest(autoSharded), []);
  assert.match(rm.checkEvidenceReuse(autoSharded, autoSharded).refusals.join("\n"), /evidence run result is provisional/);
  const forged = { ...sharded, inputs: { ...sharded.inputs, gate_config: { ...sharded.inputs.gate_config, shards: null } } };
  forged.input_digest = rm.digestOf(forged.inputs);
  assert.match(rm.validateManifest(forged).join("\n"), /provisional is only valid for successful sharded test-runner execution/);
  assert.equal(rm.collectInputs({ root, env: {}, base: "no-such-ref" }).inputs.source.base, "no-such-ref", "an unresolvable base is recorded as given");
  assert.equal(rm.canonicalJson({ b: [1, { d: undefined }], a: "x" }), '{"a":"x","b":[1,{"d":null}]}');
});
