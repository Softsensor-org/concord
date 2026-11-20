"use strict";

// COORD-281: smoke + behavior coverage for the extracted lifecycle CLI
// presentation / thin-wrapper surface (createLifecycleHelp). These functions had
// no direct unit tests before the move (help/initiate were covered only through
// the cli integration, and the command wrappers through spawned `gov` calls), so
// this asserts the extraction stays behavior-preserving: help/primer text is
// emitted, and each thin wrapper's argument-validation path still routes through
// the injected `fail`. The factory is exercised with stub deps so no governance
// engine has to stand up.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createLifecycleHelp = require("./lifecycle-help.js");
const { resolveEngineModule } = require("../../paths.js");
// COORD-866 / COORD-868: lifecycle-help requires the moved memory-layer and
// journal-signing engines by their resolved engine path, so the lazy-module
// stubs are keyed the same way.
const COORD = path.resolve(__dirname, "..", "..");
const JOURNAL_SIGNING_ENGINE = resolveEngineModule(COORD, "scripts/journal-signing.js");
const signing = require(JOURNAL_SIGNING_ENGINE);
const { publicKeyFingerprint } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/conformance-attestation.js")).__internals;

class StubGovernanceError extends Error {}

function makeApi(overrides = {}) {
  return createLifecycleHelp({
    fail: (message) => {
      throw new StubGovernanceError(message);
    },
    ensureCurrentAgentIdentity: () => {
      throw new StubGovernanceError("no identity");
    },
    GovernanceError: StubGovernanceError,
    state: { GOVERNANCE_EVENT_LOG_PATH: "/tmp/none.ndjson", RUNTIME_DIR: "/tmp" },
    COORD_DIR: "/tmp",
    ...overrides,
  });
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function withLazyModuleStubs(stubs, fn) {
  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (parent && parent.filename === require.resolve("./lifecycle-help.js") && Object.hasOwn(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

test("factory returns the expected presentation surface", () => {
  const api = makeApi();
  assert.deepEqual(Object.keys(api).sort(), [
    // COORD-612: the help TEXT builders joined the surface so per-verb help
    // (`gov <verb> --help`) and the flag-coverage guard can project the same
    // single source of truth the printers emit.
    "buildHelpText",
    "buildInitiateSummary",
    "buildVerbHelpText",
    "closeoutSummaryCommand",
    "coverageRollupCommand",
    "insightsCommand",
    "learnedRuleCommand",
    "preworkCommand",
    "printHelp",
    "printInitiate",
    "printVerbHelp",
    "recallCommand",
    "signJournalCommand",
  ]);
});

test("printHelp emits the preferred-workflow help by default", () => {
  const out = captureLog(() => makeApi().printHelp());
  assert.match(out, /Governance helper CLI/);
  assert.match(out, /Preferred workflow:/);
  assert.match(out, /coord\/scripts\/gov start <ticket-id>/);
});

test("printHelp --all emits the advanced/admin usage block", () => {
  const out = captureLog(() => makeApi().printHelp({ all: true }));
  assert.match(out, /node coord\/scripts\/governance\.js initiate/);
  assert.match(out, /agent-rebind --fresh/);
  assert.match(out, /Runtime evidence receipts/);
  assert.match(out, /coord\/scripts\/gov live-mcp-record/);
  assert.match(out, /coord\/scripts\/gov validate-receipt/);
  assert.match(out, /coord\/scripts\/gov code-context/);
});

test("COORD-748: help documents append defaults and explicit collection replacement", () => {
  const out = makeApi().buildHelpText({ all: true });
  assert.match(out, /set-pr <ticket-id> --pr <ref> \[--pr <ref> \.\.\.\] \[--replace\]/);
  assert.match(out, /appends verified refs with stable deduplication by default; --replace explicitly replaces the full collection/);
  assert.match(out, /set-review-cycles <ticket-id> --replace --review-cycle/);
  assert.match(out, /use add-review-cycle for incremental evidence/);
});

test("buildInitiateSummary renders the session primer with the claimed identity", () => {
  const api = makeApi({
    ensureCurrentAgentIdentity: () => ({
      agent: { handle: "claudea1", id: "a1" },
      session: { session_id: "a1-xyz" },
    }),
  });
  const summary = api.buildInitiateSummary();
  assert.match(summary, /Governance Session Primer/);
  assert.match(summary, /claudea1 \(a1\) via a1-xyz/);
});

test("buildInitiateSummary degrades to the no-session line on GovernanceError", () => {
  // The default stub ensureCurrentAgentIdentity throws a GovernanceError, which
  // the primer must swallow (the catch only rethrows non-GovernanceError).
  const summary = makeApi().buildInitiateSummary();
  assert.match(summary, /No active claimed agent session is bound to this thread yet\./);
});

test("COORD-562: doctor template-feedback detail flag is discoverable in both help cuts", () => {
  const api = makeApi();
  for (const options of [{ all: false }, { all: true }]) {
    assert.match(api.buildHelpText(options), /doctor[^\n]*--show-template-feedback/);
  }
  assert.match(api.buildVerbHelpText("doctor"), /--show-template-feedback/);
});

test("printInitiate rejects options through the injected fail", () => {
  assert.throws(
    () => makeApi().printInitiate({ all: true }),
    /initiate does not take options/
  );
});

test("thin command wrappers route argument-validation failures through fail", () => {
  const api = makeApi();
  assert.throws(() => api.recallCommand(""), /recall requires a query/);
  assert.throws(() => api.preworkCommand(null, {}), /prework requires a ticket id or --scope/);
  assert.throws(() => api.closeoutSummaryCommand(null), /closeout-summary requires a ticket id/);
  assert.throws(() => api.learnedRuleCommand("bogus"), /learned-rule requires a subcommand/);
  assert.throws(() => api.signJournalCommand("bogus"), /sign-journal requires a subcommand/);
});

test("COORD-562: help fallback and initiate summary preserve public behavior", () => {
  const api = makeApi({
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "codexa7", id: "a7" }, session: {} }),
  });
  assert.equal(api.buildVerbHelpText(""), null);
  assert.equal(api.buildVerbHelpText("not-a-real-verb"), null);
  const fallback = captureLog(() => assert.equal(api.printVerbHelp("not-a-real-verb"), null));
  assert.match(fallback, /Governance helper CLI/);
  let verbHelp;
  const printedVerb = captureLog(() => { verbHelp = api.printVerbHelp("update-plan"); });
  assert.equal(printedVerb, verbHelp);
  assert.match(verbHelp, /Usage:/);
  assert.match(verbHelp, /--context-pack-ack/);
  assert.match(printedVerb, /--context-pack-ack/);
  assert.match(api.buildInitiateSummary(), /codexa7 \(a7\)\./);
  assert.throws(() => makeApi({ ensureCurrentAgentIdentity: () => { throw new Error("unexpected identity failure"); } }).buildInitiateSummary(), /unexpected identity failure/);
  assert.match(captureLog(() => api.printInitiate()), /Governance Session Primer/);
});

test("COORD-562: read-only recall, insights, and coverage wrappers forward options and format results", () => {
  const calls = [];
  const recallResult = (query) => ({
    query, answer: "answer", confidence: 0.8, staleness: "fresh",
    sources: query === "bare"
      ? [{ type: "plan", verified: false }]
      : [{ type: "plan", id: "COORD-562", path: "coord/PLAN.md", verified: true, event_hash: "abcdef1234567890", chain_head: "1234567890abcdef" }],
  });
  const insights = { generated: true };
  const coverage = {
    outputPath: "coord/TEST_MATURITY.md", changed: true,
    inputs: { gate: { failing_cycles: 1, total_cycles: 4 }, recovery_events: 2, coverage: { result: "pass" }, mutation: { result: "not-run" } },
  };
  const stubs = {
    [resolveEngineModule(COORD, "scripts/recall.js")]: { recall: (query, options) => { calls.push(["recall", query, options]); return recallResult(query); } },
    [resolveEngineModule(COORD, "scripts/insight-reports.js")]: { generateReport: (options) => { calls.push(["insights", options]); return insights; }, renderText: () => "insight text" },
    [resolveEngineModule(COORD, "scripts/coverage-maturity.js")]: { rollup: (options) => {
      calls.push(["coverage", options]);
      if (!options.write) return coverage;
      if (calls.filter(([kind]) => kind === "coverage").length === 2) {
        return { ...coverage, changed: false, inputs: { ...coverage.inputs, coverage: null, mutation: null } };
      }
      return coverage;
    } },
  };
  const api = makeApi();
  withLazyModuleStubs(stubs, () => {
    assert.deepEqual(api.recallCommand("needle", { role: "reviewer", json: true }), recallResult("needle"));
    assert.match(captureLog(() => api.recallCommand("needle")), /confidence=0.8 staleness=fresh/);
    assert.match(captureLog(() => api.recallCommand("bare")), /verified=false/);
    assert.throws(() => api.recallCommand(null), /recall requires a query/);
    assert.equal(api.insightsCommand({ json: true }), insights);
    assert.match(captureLog(() => api.insightsCommand()), /insight text/);
    assert.equal(api.coverageRollupCommand({ dryRun: true, json: true }), coverage);
    assert.match(captureLog(() => api.coverageRollupCommand()), /no change \(idempotent\) coord\/TEST_MATURITY\.md/);
    assert.match(captureLog(() => api.coverageRollupCommand()), /refreshed coord\/TEST_MATURITY\.md/);
    assert.match(captureLog(() => api.coverageRollupCommand({ dryRun: true })), /would refresh coord\/TEST_MATURITY\.md/);
  });
  assert.deepEqual(calls[0], ["recall", "needle", { role: "reviewer" }]);
  assert.ok(calls.some(([kind, opts]) => kind === "insights" && typeof opts.now === "string"));
  assert.deepEqual(calls.filter(([kind]) => kind === "coverage").map(([, opts]) => opts.write), [false, true, true, false]);
});

test("COORD-562: prework and closeout wrappers normalize inputs and expose JSON and text", () => {
  const calls = [];
  const pack = { ticketId: "COORD-562", scope: "doctor" };
  const summary = { ticketId: "COORD-562", result: "ready" };
  const api = makeApi();
  withLazyModuleStubs({
    [resolveEngineModule(COORD, "scripts/prework-pack.js")]: {
      buildPack: (input) => { calls.push(["prework", input]); return pack; },
      renderText: () => "prework text",
    },
    [resolveEngineModule(COORD, "scripts/closeout-summary.js")]: {
      buildSummary: (input) => { calls.push(["closeout", input]); return summary; },
      renderText: () => "closeout text",
    },
  }, () => {
    assert.equal(api.preworkCommand(" COORD-562 ", { scope: "doctor", role: "reviewer", json: true }), pack);
    assert.match(captureLog(() => api.preworkCommand(null, { scope: "doctor" })), /prework text/);
    assert.equal(api.closeoutSummaryCommand(" COORD-562 ", { json: true }), summary);
    assert.match(captureLog(() => api.closeoutSummaryCommand("COORD-562")), /closeout text/);
  });
  assert.equal(calls[0][1].ticketId, "COORD-562");
  assert.equal(calls[0][1].scope, "doctor");
  assert.equal(calls[1][1].ticketId, null);
  assert.equal(calls[2][1].ticketId, "COORD-562");
});

test("COORD-562: learned-rule list is forwarded without invoking write subcommands", () => {
  let args;
  const api = makeApi();
  withLazyModuleStubs({ [resolveEngineModule(COORD, "scripts/learned-rule-promotion.js")]: { runCli: (received) => { args = received; return { rules: [] }; } } }, () => {
    assert.deepEqual(api.learnedRuleCommand("list", ["--json"]), { rules: [] });
  });
  assert.deepEqual(args, ["list", "--json"]);
});

test("COORD-562: sign-journal verify maps journal events and fails an absent event without signing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord562-journal-"));
  const batchPath = path.join(tempDir, "batch.json");
  fs.writeFileSync(batchPath, JSON.stringify({ event_hashes: [] }));
  const malformedPath = path.join(tempDir, "malformed.json");
  fs.writeFileSync(malformedPath, "not-json");
  const calls = [];
  const verification = {
    verdict: "verified", authenticity: "valid", trusted: true, signing_key_fingerprint: "key",
    ok: true, signature_valid: true, merkle_root_matches: true, chain_head_matches: true,
    event_count: 1, problems: [],
  };
  const engine = {
    readJournalEvents: (journalPath) => { calls.push(["read", journalPath]); return [{ line: "event-line" }]; },
    chainHeadOf: () => "chain-head",
    eventHashFromLine: (line) => { calls.push(["hash", line]); return "event-hash"; },
    verifySignedBatch: (batch, options) => { calls.push(["verify", batch, options]); return verification; },
    buildMerkleTree: (hashes) => ({ hashes }),
    buildInclusionProof: (_tree, index) => ({ index }),
    verifyEventInclusion: (batch, hash, proof) => ({ ok: true, event_hash: hash, non_repudiation_proven: true, included: true, problems: [], proof }),
  };
  const api = makeApi();
  try {
    withLazyModuleStubs({ [JOURNAL_SIGNING_ENGINE]: engine }, () => {
      const result = api.signJournalCommand("verify", { file: batchPath, json: true });
      assert.equal(result.batch_ok, true);
      assert.throws(() => api.signJournalCommand("verify", { file: batchPath, event: "missing-event" }), /event non-repudiation could not be proven/);
      assert.throws(() => api.signJournalCommand("verify", {}), /requires a batch file/);
      assert.throws(() => api.signJournalCommand("verify", { file: path.join(tempDir, "absent.json") }), /Signed-batch file not found/);
      assert.throws(() => api.signJournalCommand("verify", { file: malformedPath }), /not valid JSON/);

      fs.writeFileSync(batchPath, JSON.stringify({}));
      assert.throws(() => api.signJournalCommand("verify", { file: batchPath, event: "missing-array" }), /event non-repudiation could not be proven/);
      fs.writeFileSync(batchPath, JSON.stringify({ event_hashes: ["event-hash"] }));
      const verifiedEvent = api.signJournalCommand("verify", { file: batchPath, event: "event-hash" });
      assert.equal(verifiedEvent.event_inclusion.non_repudiation_proven, true);
      assert.match(captureLog(() => api.signJournalCommand("verify", { file: batchPath, event: "event-hash" })), /signer-anchored evidence: PROVEN/);

      engine.verifySignedBatch = () => ({ ...verification, ok: false, verdict: "tampered", problems: [{ code: "bad_signature", detail: "signature mismatch" }] });
      assert.throws(() => api.signJournalCommand("verify", { file: batchPath }), /Journal batch verification FAILED: verdict=tampered/);
    });
    assert.deepEqual(calls.filter(([kind]) => kind === "hash").map(([, line]) => line), Array(9).fill("event-line"));
    assert.equal(calls.filter(([kind]) => kind === "verify").length, 5);
    assert.deepEqual(fs.readdirSync(tempDir).sort(), ["batch.json", "malformed.json"], "verify must not write a signature artifact");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-562: sign-journal writes the requested artifact through the injected engine", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord562-journal-sign-"));
  const journalPath = path.join(tempDir, "events.ndjson");
  const outPath = path.join(tempDir, "signed", "batch.json");
  const events = [{ line: "fixture-event" }];
  const batch = {
    subject: { event_count: 1, merkle_root: "root", chain_head: "head" },
    subject_digest: "digest",
  };
  const tree = { levels: [["root"]] };
  const calls = [];
  const engine = {
    readJournalEvents: (receivedPath) => {
      calls.push(["read", receivedPath]);
      return events;
    },
    chainHeadOf: (receivedEvents) => {
      calls.push(["head", receivedEvents]);
      return "head";
    },
    eventHashFromLine: (line) => line,
    buildSignedBatch: (input) => {
      calls.push(["sign", input]);
      return { batch, tree };
    },
  };
  const api = makeApi({
    state: { GOVERNANCE_EVENT_LOG_PATH: journalPath, RUNTIME_DIR: tempDir },
    COORD_DIR: tempDir,
  });
  try {
    let result;
    const output = captureLog(() => {
      withLazyModuleStubs({ [JOURNAL_SIGNING_ENGINE]: engine }, () => {
        result = api.signJournalCommand("sign", { out: outPath, json: true });
      });
    });
    assert.deepEqual(calls, [
      ["read", journalPath],
      ["head", events],
      ["sign", { events, coordDir: tempDir }],
    ]);
    assert.deepEqual(JSON.parse(output), result);
    assert.deepEqual(result, {
      status: "signed",
      path: outPath,
      event_count: 1,
      merkle_root: "root",
      chain_head: "head",
      subject_digest: "digest",
      merkle_levels: 1,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, "utf8")), batch);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, "signed")), ["batch.json"]);
    assert.deepEqual(fs.readdirSync(tempDir).sort(), ["journal-signatures", "signed"]);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, "journal-signatures")), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-562: sign-journal defaults safely for an empty journal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord562-empty-journal-sign-"));
  const journalPath = path.join(tempDir, "events.ndjson");
  const batch = {
    subject: { event_count: 0, merkle_root: "empty-root", chain_head: null },
    subject_digest: "empty-digest-123456",
  };
  const tree = { levels: [] };
  const calls = [];
  const engine = {
    readJournalEvents: (receivedPath) => {
      calls.push(["read", receivedPath]);
      return [];
    },
    chainHeadOf: (events) => {
      calls.push(["head", events]);
      return null;
    },
    eventHashFromLine: () => assert.fail("empty journal has no event lines"),
    buildSignedBatch: (input) => {
      calls.push(["sign", input]);
      return { batch, tree };
    },
  };
  const api = makeApi({
    state: { GOVERNANCE_EVENT_LOG_PATH: journalPath, RUNTIME_DIR: tempDir },
    COORD_DIR: tempDir,
  });

  try {
    let result;
    const output = captureLog(() => {
      withLazyModuleStubs({ [JOURNAL_SIGNING_ENGINE]: engine }, () => {
        result = api.signJournalCommand("sign", {});
      });
    });
    const expectedPath = path.join(
      tempDir,
      "journal-signatures",
      `no-chain-head.${batch.subject_digest.slice(0, 12)}.json`
    );

    assert.deepEqual(calls, [
      ["read", journalPath],
      ["head", []],
      ["sign", { events: [], coordDir: tempDir }],
    ]);
    assert.deepEqual(result, {
      status: "signed",
      path: expectedPath,
      event_count: 0,
      merkle_root: "empty-root",
      chain_head: null,
      subject_digest: batch.subject_digest,
      merkle_levels: 0,
    });
    assert.equal(fs.readFileSync(expectedPath, "utf8"), `${JSON.stringify(batch, null, 2)}\n`);
    assert.match(output, /Journal batch signed:/);
    assert.match(output, /path:.*no-chain-head\./);
    assert.match(output, /events:\s+0/);
    assert.match(output, /chain_head:\s+\(empty journal\)/);
    assert.deepEqual(fs.readdirSync(tempDir), ["journal-signatures"]);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, "journal-signatures")), [
      path.basename(expectedPath),
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sign-journal verify traverses the production batch and event-verification path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-lifecycle-help-sign-"));
  try {
    const record = { command: "fixture", result: "succeeded", prev_event_hash: "genesis" };
    const line = JSON.stringify(record);
    const event = { record, line };
    const signer = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = signer.publicKey.export({ type: "spki", format: "pem" });
    const batch = signing.buildSignedBatch({
      events: [event],
      keyProvider: signing.staticKeyProvider({ privateKey: signer.privateKey, publicKeyPem }),
    }).batch;
    const journalPath = path.join(root, "events.ndjson");
    const batchPath = path.join(root, "batch.json");
    fs.writeFileSync(journalPath, `${line}\n`);
    fs.writeFileSync(batchPath, `${JSON.stringify(batch)}\n`);

    const api = makeApi({
      state: { GOVERNANCE_EVENT_LOG_PATH: journalPath, RUNTIME_DIR: root },
      COORD_DIR: root,
    });
    let result;
    captureLog(() => {
      result = api.signJournalCommand("verify", {
        file: batchPath,
        event: signing.eventHashFromLine(line),
        json: true,
      });
    });
    assert.equal(result.status, "self-signed");
    assert.equal(result.batch_ok, true);
    assert.equal(result.event_inclusion.included, true);
    assert.equal(result.event_inclusion.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sign-journal sign and verify exercise real success and refusal paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-lifecycle-help-sign-cases-"));
  const priorTrustAnchor = process.env.CONFORMANCE_TRUST_ANCHOR;
  const priorProjectConfig = process.env.COORD_PROJECT_CONFIG;
  try {
    delete process.env.CONFORMANCE_TRUST_ANCHOR;
    delete process.env.COORD_PROJECT_CONFIG;
    const record = { command: "fixture", result: "succeeded", prev_event_hash: "genesis" };
    const line = JSON.stringify(record);
    const journalPath = path.join(root, "events.ndjson");
    const batchPath = path.join(root, "batch.json");
    fs.writeFileSync(journalPath, `${line}\n`);
    const api = makeApi({
      state: { GOVERNANCE_EVENT_LOG_PATH: journalPath, RUNTIME_DIR: root },
      COORD_DIR: root,
    });

    let signed;
    captureLog(() => { signed = api.signJournalCommand("sign", { out: batchPath, json: true }); });
    assert.equal(signed.status, "signed");
    assert.equal(fs.existsSync(batchPath), true);

    fs.writeFileSync(journalPath, "");
    let defaultSigned;
    const defaultSignOutput = captureLog(() => { defaultSigned = api.signJournalCommand("sign", {}); });
    assert.equal(defaultSigned.status, "signed");
    assert.equal(defaultSigned.event_count, 0);
    assert.match(defaultSigned.path, /journal-signatures[\\/]no-chain-head\./);
    assert.equal(fs.existsSync(defaultSigned.path), true);
    assert.match(defaultSignOutput, /chain_head:\s+\(empty journal\)/);

    assert.throws(() => api.signJournalCommand("verify", {}), /requires a batch file/);
    assert.throws(() => api.signJournalCommand("verify", { file: path.join(root, "missing.json") }), /not found/);
    fs.writeFileSync(batchPath, "{not json\n");
    assert.throws(() => api.signJournalCommand("verify", { file: batchPath }), /not valid JSON/);

    const signer = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = signer.publicKey.export({ type: "spki", format: "pem" });
    const event = { record, line };
    const batch = signing.buildSignedBatch({
      events: [event],
      keyProvider: signing.staticKeyProvider({ privateKey: signer.privateKey, publicKeyPem }),
    }).batch;
    fs.writeFileSync(path.join(root, "project.config.js"), `module.exports = ${JSON.stringify({
      conformance: { trustedAttestationKeys: [publicKeyFingerprint(publicKeyPem)] },
    })};\n`);
    fs.writeFileSync(journalPath, `${line}\n`);
    fs.writeFileSync(batchPath, `${JSON.stringify(batch)}\n`);
    const textOutput = captureLog(() => api.signJournalCommand("verify", { file: batchPath }));
    assert.match(textOutput, /Journal batch verification: TRUSTED/);
    const validEventText = captureLog(() => api.signJournalCommand("verify", {
      file: batchPath,
      event: signing.eventHashFromLine(line),
    }));
    assert.match(validEventText, /signer-anchored evidence: PROVEN/);

    const eventFailureOutput = captureLog(() => assert.throws(() => api.signJournalCommand("verify", {
      file: batchPath, event: "not-in-batch",
    }), /event non-repudiation could not be proven/));
    assert.match(eventFailureOutput, /event_not_in_batch/);
    const noHashes = { ...batch, event_hashes: null };
    fs.writeFileSync(batchPath, `${JSON.stringify(noHashes)}\n`);
    captureLog(() => assert.throws(() => api.signJournalCommand("verify", {
      file: batchPath, event: "not-in-batch",
    }), /Journal batch verification FAILED/));
    const tampered = { ...batch, signature: { ...batch.signature, value: Buffer.alloc(64).toString("base64") } };
    fs.writeFileSync(batchPath, `${JSON.stringify(tampered)}\n`);
    const tamperedOutput = captureLog(() => assert.throws(() => api.signJournalCommand("verify", {
      file: batchPath,
    }), /Journal batch verification FAILED/));
    assert.match(tamperedOutput, /signature_invalid/);
  } finally {
    if (priorTrustAnchor === undefined) delete process.env.CONFORMANCE_TRUST_ANCHOR;
    else process.env.CONFORMANCE_TRUST_ANCHOR = priorTrustAnchor;
    if (priorProjectConfig === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = priorProjectConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
