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
const { dispatch, buildRegistry } = require("./coord-cli.js");

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
