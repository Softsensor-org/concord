"use strict";

// COORD-117: tests for `coord conformance`. The command is a PACKAGING wrapper
// over the existing conformance engine, so every test composes the REAL engine
// (createConformanceVerbs + createConformanceAttestation + createEnginePin)
// against an os.tmpdir() coordDir with an injected verifyGovernanceChain stub and
// an EPHEMERAL in-test ed25519 keypair (generated lazily under the temp coordDir
// by the attestation module — no committed keys, no real git / global state).
//
// We prove:
//   - pass case → exit 0 + chain summary;
//   - injected chain failure → non-zero exit + reason (fail-closed);
//   - --json emits the engine's machine report (same verdict);
//   - --attest emits a signed attestation; --verify round-trips it (PASS, exit 0);
//   - a tampered attestation → non-zero exit (fail-closed);
//   - the wrapper verdict/digest MATCH the underlying engine (no reimplementation);
//   - --verify with no attestation present → exit 1;
//   - dispatcher registry now has init + conformance and routes conformance.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCoordConformance = require("./coord-conformance.js");
const createConformanceVerbs = require("./conformance-verbs.js");
const createConformanceAttestation = require("./conformance-attestation.js");
const createEnginePin = require("./engine-pin.js");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const { dispatch, buildRegistry } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));

const SAMPLE_MANIFEST = JSON.stringify(
  { schema_version: 1, manifest_version: "test-engine-v1", items: [] },
  null,
  2
);

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), lines, text: () => lines.join("\n") };
}

// Run a function with BOTH the injected wrapper log and the engine's bare
// console.log captured into one buffer. The engine modules print their summary /
// JSON via console.log, while the wrapper prints its header line via the injected
// log, so a full-output assertion must merge both streams.
function runCapturingAll(fn) {
  const lines = [];
  const push = (line) => lines.push(String(line));
  const originalLog = console.log;
  console.log = push;
  try {
    const result = fn(push);
    return { result, lines, text: () => lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

// Build a temp coordDir + a REAL conformance engine over it, with an injected
// chain stub. Returns the command factory deps + paths for cleanup/mutation.
function makeFixture(overrides = {}) {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-117-"));
  fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), SAMPLE_MANIFEST);
  const chain = overrides.chain || {
    ok: true,
    head: "abc123def456",
    total: 10,
    chainedCount: 5,
    preChainCount: 5,
    broken: [],
  };
  const fail = (m) => {
    const err = new Error(m);
    err.isConformanceFailure = true;
    throw err;
  };
  const engine = createConformanceVerbs({
    coordDir,
    fail,
    verifyGovernanceChain: () => chain,
    createConformanceAttestation,
    createEnginePin,
  });
  return { coordDir, engine, chain };
}

function cleanup(coordDir) {
  fs.rmSync(coordDir, { recursive: true, force: true });
}

test("pass case → exit 0 + chain summary", () => {
  const { coordDir, engine } = makeFixture();
  try {
    const { result, text } = runCapturingAll((log) =>
      createCoordConformance({ engine, log }).run([])
    );
    assert.strictEqual(result.code, 0);
    assert.match(text(), /Journal hash-chain conformance: PASS/);
    assert.match(text(), /coord conformance: PASS/);
  } finally {
    cleanup(coordDir);
  }
});

test("injected chain failure → non-zero exit + reason (fail-closed)", () => {
  const { coordDir, engine } = makeFixture({
    chain: {
      ok: false,
      head: "x",
      total: 3,
      chainedCount: 2,
      preChainCount: 1,
      broken: [{ index: 2, reason: "prev-hash-mismatch" }],
    },
  });
  try {
    const { result, text } = runCapturingAll((log) =>
      createCoordConformance({ engine, log }).run([])
    );
    assert.strictEqual(result.code, 1);
    assert.match(text(), /FAIL/);
    assert.match(text(), /broken link/i);
  } finally {
    cleanup(coordDir);
  }
});

test("--json: wrapper returns the engine machine report with the same verdict", () => {
  const { coordDir, engine } = makeFixture();
  try {
    // The engine emits its JSON via console.log; capture it to assert the shape.
    const originalLog = console.log;
    const out = [];
    console.log = (line) => out.push(String(line));
    let result;
    try {
      const cmd = createCoordConformance({ engine, log: () => {} });
      result = cmd.run(["--json"]);
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(result.code, 0);
    // In --json mode the wrapper prints ONLY the engine's machine report.
    const parsed = JSON.parse(out.join("\n"));
    assert.strictEqual(parsed.verdict, "pass");
    assert.strictEqual(parsed.chain_head, "abc123def456");
    // The returned report is the SAME engine report object.
    assert.strictEqual(result.report.verdict, "pass");
  } finally {
    cleanup(coordDir);
  }
});

test("--attest emits a signed attestation; --verify round-trips it (PASS, exit 0)", () => {
  const { coordDir, engine } = makeFixture();
  try {
    // Emit via the wrapper.
    const attest = runCapturingAll((log) =>
      createCoordConformance({ engine, log }).run(["--attest"])
    );
    assert.strictEqual(attest.result.code, 0);
    assert.match(attest.text(), /Attestation emitted/);
    assert.ok(attest.result.report.attestation, "attestation summary in report");

    // The wrapper digest MUST equal the engine's own digest (no reimplementation).
    const engineDigest = engine.conformanceAttestation.digestSubject(
      engine.conformanceAttestation.deriveSubject()
    );
    assert.strictEqual(attest.result.report.attestation.subject_digest, engineDigest);

    // Verify via the wrapper (latest attestation auto-discovery).
    const verify = runCapturingAll((log) =>
      createCoordConformance({ engine, log }).run(["--verify"])
    );
    assert.strictEqual(verify.result.code, 0);
    assert.match(verify.text(), /Attestation verification: PASS/);
    assert.match(verify.text(), /coord conformance: PASS/);
    assert.strictEqual(verify.result.report.attestation.ok, true);
    assert.strictEqual(verify.result.report.attestation.signature_valid, true);
  } finally {
    cleanup(coordDir);
  }
});

test("a tampered attestation → non-zero exit (fail-closed)", () => {
  const { coordDir, engine } = makeFixture();
  try {
    const emitted = engine.conformanceAttestation.emit();
    // Tamper a signed field without re-signing.
    const attestation = JSON.parse(fs.readFileSync(emitted.path, "utf8"));
    attestation.subject.engine_version = "evil-tampered";
    fs.writeFileSync(emitted.path, JSON.stringify(attestation, null, 2));

    const { result, text } = runCapturingAll((log) =>
      createCoordConformance({ engine, log }).run(["--verify", emitted.path])
    );
    assert.strictEqual(result.code, 1);
    assert.match(text(), /FAIL/);
  } finally {
    cleanup(coordDir);
  }
});

test("--verify with no attestation present → exit 1 with reason", () => {
  const { coordDir, engine } = makeFixture();
  try {
    const cap = capture();
    const cmd = createCoordConformance({ engine, log: cap.log });
    const result = cmd.run(["--verify"]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /no attestation found/);
  } finally {
    cleanup(coordDir);
  }
});

test("--help prints usage and exits 0 without touching the engine", () => {
  const cap = capture();
  // No engine injected + lazy: --help must not trigger production composition.
  const cmd = createCoordConformance({ log: cap.log });
  const result = cmd.run(["--help"]);
  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /Usage: coord conformance/);
});

test("unexpected args → exit 1", () => {
  const cap = capture();
  const cmd = createCoordConformance({ log: cap.log });
  const result = cmd.run(["--bogus"]);
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /unexpected argument/);
});

test("parseArgs handles --verify with an explicit path and --verify=PATH", () => {
  const cmd = createCoordConformance({ log: () => {} });
  assert.deepStrictEqual(
    { ...cmd.parseArgs(["--verify", "/x/a.json"]) },
    { json: false, attest: false, verify: true, verifyPath: "/x/a.json", help: false, unknown: [] }
  );
  assert.strictEqual(cmd.parseArgs(["--verify=/y/b.json"]).verifyPath, "/y/b.json");
  // --verify with no following value (next is a flag) → null path (auto-discover).
  assert.strictEqual(cmd.parseArgs(["--verify", "--json"]).verifyPath, null);
});

// ---------------------------------------------------------------------------
// dispatcher: registry now has init + conformance
// ---------------------------------------------------------------------------

test("buildRegistry registers conformance alongside init", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry.init, "init still registered");
  assert.ok(registry.conformance, "conformance registered");
  assert.strictEqual(typeof registry.conformance.run, "function");
});

test("dispatch routes conformance to its run()", () => {
  let routedArgs = null;
  const registry = {
    conformance: { summary: "x", run: (args) => { routedArgs = args; return { code: 0 }; } },
  };
  const cap = capture();
  const result = dispatch(["conformance", "--json"], { log: cap.log, registry });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(routedArgs, ["--json"]);
});

test("COORD-870: with no engine injected, --verify composes the production engine from the engine paths and fails closed on a missing attestation", () => {
  const cap = capture();
  const missing = path.join(os.tmpdir(), `coord-870-no-attestation-${process.pid}-${Date.now()}.json`);
  const cmd = createCoordConformance({ log: cap.log });
  const result = cmd.run(["--verify", missing]);
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /coord conformance: FAIL/);
  assert.strictEqual(fs.existsSync(missing), false);
});

test("COORD-870: with no engine injected, the default run verifies the journal chain through the engine-path composition", () => {
  const cap = capture();
  const cmd = createCoordConformance({ log: cap.log });
  const result = cmd.run(["--json"]);
  // The verdict depends on the journal of the tree under test (a release cut
  // ships none); what this proves is that the composed engine's
  // verifyGovernanceChain ran and the wrapper mapped it to an exit code.
  assert.ok(result.code === 0 || result.code === 1, `unexpected exit ${result.code}`);
  if (result.code === 0) assert.strictEqual(typeof result.report.total_events, "number");
  else assert.match(String(result.error), /\S/);
});


test("COORD-1052: verify-engine regenerate forwards its roots and returns the delegated JSON result", () => {
  const engineSurface = require("./engine-surface-integrity.js");
  const original = { gitToplevel: engineSurface.gitToplevel, regenerateAndVerify: engineSurface.regenerateAndVerify };
  const coordDir = path.join(os.tmpdir(), "coord1052-regenerate", "coord");
  const expected = { target: "/fixture/tree", manifest_items: 3, dropped: [], pinned_files: 2,
    manifest_fingerprint: { sha256: "sha256:fixture" } };
  let call;
  try {
    engineSurface.gitToplevel = (cwd) => { assert.equal(path.resolve(cwd), process.cwd()); return null; };
    engineSurface.regenerateAndVerify = (args) => { call = args; return expected; };
    const verbs = createConformanceVerbs({
      coordDir,
      fail: (message) => { throw new Error(message); },
      verifyGovernanceChain: () => ({ ok: true, head: null, total: 0, chainedCount: 0, broken: [] }),
      createConformanceAttestation,
      createEnginePin,
    });
    const originalLog = console.log;
    const output = [];
    let result;
    try {
      console.log = (line) => output.push(String(line));
      result = verbs.verifyEngine({ regenerate: true, json: true });
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(call, { invokedRoot: path.resolve(coordDir, ".."), targetRoot: path.resolve(coordDir, "..") });
    assert.equal(result, expected);
    assert.deepEqual(JSON.parse(output.join("\n")), expected);
    output.length = 0;
    try {
      console.log = (line) => output.push(String(line));
      result = verbs.verifyEngine({ regenerate: true });
    } finally {
      console.log = originalLog;
    }
    assert.equal(result, expected);
    assert.match(output.join("\n"), /Engine surface regenerated and verified/);
    assert.match(output.join("\n"), /manifest fingerprint: sha256:fixture/);
  } finally {
    engineSurface.gitToplevel = original.gitToplevel;
    engineSurface.regenerateAndVerify = original.regenerateAndVerify;
  }
});

test("COORD-1052: verify-engine formats pinned drift and refuses it outside JSON mode", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-verify-engine-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const coordDir = path.join(dir, "coord");
  fs.mkdirSync(coordDir);
  const relativeFile = "coord/example.js";
  const file = path.join(dir, relativeFile);
  fs.writeFileSync(file, "module.exports = 1;\n");
  fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), JSON.stringify({ items: [{ path: relativeFile }] }));
  const verbs = createConformanceVerbs({
    coordDir,
    fail: (message) => { throw new Error(message); },
    verifyGovernanceChain: () => ({ ok: true, head: null, total: 0, chainedCount: 0, broken: [] }),
    createConformanceAttestation,
    createEnginePin,
  });
  const output = [];
  t.mock.method(console, "log", (line) => output.push(String(line)));
  assert.equal(verbs.verifyEngine({}).pinned, false);
  assert.match(output.splice(0).join("\n"), /Engine pin: NONE[\s\S]*no_pin/);
  verbs.verifyEngine({ pin: true });
  assert.match(output.splice(0).join("\n"), /Engine surface pinned:[\s\S]*version: \(none\)[\s\S]*tracked files: 1/);
  const pinned = verbs.verifyEngine({ pin: true, json: true });
  assert.deepStrictEqual(JSON.parse(output.splice(0).join("\n")), pinned.pin);
  const result = verbs.verifyEngine({ json: true });
  assert.equal(result.ok, true);
  assert.deepStrictEqual(JSON.parse(output.splice(0).join("\n")), result);
  assert.equal(verbs.verifyEngine({}).ok, true);
  assert.match(output.splice(0).join("\n"),
    /Engine drift check: IN-SYNC[\s\S]*pinned version:  \(none\)[\s\S]*live version:    \(none\)/);

  fs.writeFileSync(file, "module.exports = 2;\n");
  assert.throws(() => verbs.verifyEngine({}), /Engine drift detected: 1 problem/);
  const text = output.splice(0).join("\n");
  assert.match(text, /Engine drift check: DRIFTED/);
  assert.match(text, /\[changed\] coord\/example\.js/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pinned.path, "utf8")), pinned.pin, "verification never refreshes the pin");
});
