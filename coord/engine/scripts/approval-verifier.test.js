"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("node:fs");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const verifier = require("./approval-verifier.js");

const SUBJECT = verifier.subjectSha256({ verb: "approve", ticket: "COORD-1", reason: "why", state: "row" });

// Runs the fixture wrapper directly so tests can tamper with the record it returns.
function rawSign(fixture, request) {
  const [command, ...args] = fixture.signArgv;
  const result = spawnSync(command, args, { input: JSON.stringify(request), encoding: "utf8", env: { PATH: process.env.PATH } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function requestFor(verb, ticket, subject) {
  return {
    schema: verifier.REQUEST_SCHEMA,
    verb,
    ticket,
    subject_sha256: subject,
    nonce: "a".repeat(32),
    requested_at: new Date().toISOString(),
  };
}

// Explicitly injects the fixture client into this isolated verifier module graph.
function withFixture(fixture, body) {
  return withApprovalTestClient(require("node:path").resolve(__dirname, "..", ".."), fixture.client(), body);
}

test("ADR 0031 valid record is accepted once and journal-checked by record id", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const anchor = verifier.loadTrustAnchor(fixture.anchorPath);
      const result = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.key_id, fixture.keyId);
      assert.match(result.record_id, /^[0-9a-f]{32}$/);
      assert.match(result.session_id, /^[0-9a-f]{32}$/);
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 a record for another verb, ticket or subject digest is refused", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const anchor = verifier.loadTrustAnchor(fixture.anchorPath);
      const wrongVerb = verifier.requestApproval({ verb: "reject", ticket: "COORD-1", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(wrongVerb.ok, false);
      assert.equal(wrongVerb.refused, "scope-mismatch");
    });
  } finally {
    fixture.cleanup();
  }
  const fixture2 = createApprovalFixture();
  try {
    withFixture(fixture2, () => {
      fixture2.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const anchor = verifier.loadTrustAnchor(fixture2.anchorPath);
      const otherDigest = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: "f".repeat(64), isRecordUsed: () => false, anchor });
      assert.equal(otherDigest.refused, "scope-mismatch");
      fixture2.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const otherTicket = verifier.requestApproval({ verb: "approve", ticket: "COORD-2", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(otherTicket.refused, "scope-mismatch");
    });
  } finally {
    fixture2.cleanup();
  }
});

test("ADR 0031 an expired record is refused", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, now: Date.now() - 20 * 60 * 1000 });
      const anchor = verifier.loadTrustAnchor(fixture.anchorPath);
      const expired = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(expired.ok, false);
      assert.equal(expired.refused, "session-expired");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 a replayed record or session is refused", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const anchor = verifier.loadTrustAnchor(fixture.anchorPath);
      const first = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(first.ok, true);
      const replay = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, isRecordUsed: () => false, anchor });
      assert.equal(replay.refused, "session-used");
      // Same record presented again after the journal holds its id: refused by the verifier.
      const journaled = verifier.verifyApprovalRecord(first.record, {
        request: requestFor("approve", "COORD-1", SUBJECT), anchor, isRecordUsed: (id) => id === first.record_id, now: Date.now(),
      });
      assert.equal(journaled.refused, "scope-mismatch");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 a record with a bad signature is refused", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const request = requestFor("approve", "COORD-1", SUBJECT);
      const signed = rawSign(fixture, request);
      assert.equal(signed.status, 0, signed.stderr);
      const record = JSON.parse(signed.stdout);
      const anchor = verifier.loadTrustAnchor(fixture.anchorPath);
      const tampered = { ...record, expires_at: new Date(Date.parse(record.expires_at) + 60_000).toISOString() };
      const refused = verifier.verifyApprovalRecord(tampered, { request, anchor, isRecordUsed: () => false, now: Date.now() });
      assert.equal(refused.refused, "bad-signature");
      const badSig = verifier.verifyApprovalRecord({ ...record, signature: Buffer.from("x".repeat(64)).toString("base64") }, { request, anchor, isRecordUsed: () => false, now: Date.now() });
      assert.equal(badSig.refused, "bad-signature");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 a record signed by a different key is refused", () => {
  const signer = createApprovalFixture();
  const other = createApprovalFixture();
  try {
    withFixture(signer, () => {
      signer.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const request = requestFor("approve", "COORD-1", SUBJECT);
      const record = JSON.parse(rawSign(signer, request).stdout);
      const otherAnchor = verifier.loadTrustAnchor(other.anchorPath);
      const refused = verifier.verifyApprovalRecord(record, { request, anchor: otherAnchor, isRecordUsed: () => false, now: Date.now() });
      assert.equal(refused.refused, "key-mismatch");
    });
  } finally {
    signer.cleanup();
    other.cleanup();
  }
});

test("ADR 0031 non-test environment overrides are ignored; the production trust path is fixed", () => {
  const forged = { NODE_TEST_CONTEXT: "child-v8", COORD_APPROVAL_TEST_TRUST_ANCHOR: "/tmp/forged.pem", COORD_APPROVAL_TEST_SIGN_COMMAND: '["/bin/true"]' };
  assert.equal(verifier.trustAnchorPath(forged), "/etc/coord-approval/approval-public.pem");
  assert.deepEqual(verifier.signCommand(forged), ["sudo", "-n", "-u", "coordapprove", "/usr/local/libexec/coord-approval/coord-approve", "sign"]);
  assert.equal(verifier.PRODUCTION_TRUST_ANCHOR, "/etc/coord-approval/approval-public.pem");
});

test("ADR 0031 a missing production trust anchor fails closed as store-unavailable", () => {
  const result = verifier.loadTrustAnchor("/nonexistent/coord-approval/approval-public.pem");
  assert.equal(result.ok, false);
  assert.equal(result.refused, "store-unavailable");
});

function harness(fixture, { window_ends_at = null, now = Date.now() } = {}) {
  const journaled = [];
  const config = { window_ends_at };
  return {
    journaled,
    config,
    journal: (event) => journaled.push(event),
    recordUsed: () => false,
    now: new Date(now),
  };
}

test("ADR 0031 central check: a bare override string with no signed record is refused for claim --transfer-to", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      const h = harness(fixture);
      const result = verifier.requireHumanAdminApproval({
        verb: "claim --transfer-to", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "bare string",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      assert.equal(result.ok, false);
      assert.equal(result.refused, "no-session");
      assert.match(result.message, /An override string is not evidence/);
      assert.match(result.message, /coord-approve login --verb claim --transfer-to --ticket COORD-1/);
      assert.equal(h.journaled[0].event, "approval.refused");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 central check: a signed record verifies and journals the session and record id", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      fixture.login({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT });
      const h = harness(fixture);
      const result = verifier.requireHumanAdminApproval({
        verb: "approve", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "reviewed",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.mode, "signed");
      const [event] = h.journaled;
      assert.equal(event.event, "approval.verified");
      assert.match(event.human_admin_session, /^[0-9a-f]{32}$/);
      assert.match(event.approval_record, /^[0-9a-f]{32}$/);
      assert.equal(event.approval_verified, `key_id=${fixture.keyId}`);
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 transition window: integration handoff accepts an unsigned override inside the window with a warning", (t) => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const h = harness(fixture, { window_ends_at: future });
      const result = verifier.requireHumanAdminApproval({
        verb: "integration handoff", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "handover",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "transition");
      assert.match(result.warning, /^unverified override \(ADR 0031 transition\)/);
      assert.equal(h.journaled[0].event, "override_without_session");

      const path = require("node:path");
      const transitionFile = path.resolve(__dirname, "..", "approval-transition.json");
      const readFileSync = fs.readFileSync;
      t.mock.method(fs, "readFileSync", (file, ...args) => file === transitionFile
        ? JSON.stringify(h.config)
        : readFileSync(file, ...args));
      const warnings = [];
      t.mock.method(process.stderr, "write", (warning) => { warnings.push(warning); return true; });
      const events = [];
      const { approval } = verifier.requireSignedOverride({
        commandName: "integration handoff", ticketId: "COORD-1", row: { owner: "fixture" },
        options: { humanAdminOverride: "handover" },
        deps: {
          runtimeDir: path.dirname(fixture.anchorPath),
          resolveHumanAdminOverride: (_command, options) => ({ reason: options.humanAdminOverride }),
          fail: (message) => assert.fail(message),
          appendGovernanceEvent: (event) => events.push(event),
        },
        approvalClient: fixture.client(),
      });
      assert.deepEqual(approval, {
        mode: "transition", session_id: null, record_id: null, key_id: null,
        subject_sha256: verifier.subjectSha256({ verb: "integration handoff", ticket: "COORD-1", reason: "handover",
          state: verifier.canonicalJson({ owner: "fixture" }) }),
      });
      assert.equal(events[0].event, "override_without_session");
      assert.match(warnings[0], /^unverified override \(ADR 0031 transition\)/);
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 transition window: integration recover --abandon is refused after the window ends", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const h = harness(fixture, { window_ends_at: past });
      const result = verifier.requireHumanAdminApproval({
        verb: "integration recover --abandon", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "abandon",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      assert.equal(result.ok, false);
      assert.equal(h.journaled[0].event, "approval.refused");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 transition window: approve, reject, reconcile, claim --transfer-to and lock-abandon never get the window", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      for (const verb of ["approve", "reject", "reconcile", "claim --transfer-to", "lock-abandon", "config approve"]) {
        assert.equal(verifier.transitionWindowOpen(verb, { config: { window_ends_at: future } }), false, verb);
      }
      for (const verb of ["integration handoff", "integration recover --abandon"]) {
        assert.equal(verifier.transitionWindowOpen(verb, { config: { window_ends_at: future } }), true, verb);
      }
      assert.equal(verifier.transitionWindowOpen("integration handoff", { config: { window_ends_at: null } }), false);
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 transition window: a tampered or replayed record never falls through to the window", () => {
  const fixture = createApprovalFixture();
  try {
    withFixture(fixture, () => {
      const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      fixture.login({ verb: "integration handoff", ticket: "COORD-1", subject_sha256: SUBJECT });
      const h = harness(fixture, { window_ends_at: future });
      const first = verifier.requireHumanAdminApproval({
        verb: "integration handoff", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "handover",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      assert.equal(first.mode, "signed");
      const replay = verifier.requireHumanAdminApproval({
        verb: "integration handoff", ticket: "COORD-1", subjectDigest: SUBJECT, reason: "handover",
        journal: h.journal, recordUsed: h.recordUsed, anchor: verifier.loadTrustAnchor(fixture.anchorPath), now: h.now, config: h.config,
      });
      // The session is spent, so the wrapper refuses session-used. That is not a window code.
      assert.equal(replay.ok, false);
      assert.equal(replay.refused, "session-used");
    });
  } finally {
    fixture.cleanup();
  }
});

test("ADR 0031 a normal Node child ignores forged node-test context and fixture overrides", () => {
  const fixture = createApprovalFixture();
  let fakeBin;
  try {
    const digest = "a".repeat(64);
    fixture.login({ verb: "claim --transfer-to", ticket: "COORD-1", subject_sha256: digest });
    fakeBin = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "coord-approval-fake-sudo-"));
    const fakeSudo = require("node:path").join(fakeBin, "sudo");
    fs.writeFileSync(fakeSudo, "#!/bin/sh\nprintf '{\"refused\":\"store-unavailable\"}\\n' >&2\nexit 3\n", { mode: 0o755 });
    const probe = [
      "const v=require(process.argv[1]);",
      "const journal=[];",
      "const result=v.requireHumanAdminApproval({verb:'claim --transfer-to',ticket:'COORD-1',subjectDigest:'" + digest + "',reason:'forged environment',journal:(event)=>journal.push(event),recordUsed:()=>false});",
      "console.log(JSON.stringify({anchor:v.trustAnchorPath(),sign:v.signCommand(),result,journal}));",
    ].join("");
    const child = spawnSync(process.execPath, ["-e", probe, require.resolve("./approval-verifier.js")], {
      encoding: "utf8",
      env: { PATH: fakeBin, NODE_TEST_CONTEXT: "child-v8", COORD_APPROVAL_TEST_TRUST_ANCHOR: fixture.anchorPath, COORD_APPROVAL_TEST_SIGN_COMMAND: JSON.stringify(fixture.signArgv) },
    });
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout);
    assert.equal(seen.anchor, "/etc/coord-approval/approval-public.pem");
    assert.deepEqual(seen.sign, ["sudo", "-n", "-u", "coordapprove", "/usr/local/libexec/coord-approval/coord-approve", "sign"]);
    assert.equal(seen.result.ok, false, "forged test environment cannot authorize a production approval request");
    assert.equal(seen.result.refused, "store-unavailable");
    assert.deepEqual(seen.journal.map((event) => event.event), ["approval.refused"]);
  } finally {
    if (fakeBin) fs.rmSync(fakeBin, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("ADR 0031 fixture authority has no shipped argv-selectable CLI bootstrap", () => {
  const shippedBootstrap = require("node:path").join(__dirname, "__fixtures__", "approval-cli.js");
  assert.equal(require("node:fs").existsSync(shippedBootstrap), false,
    "synthetic fixture authority is injected by test code, not a packaged path-selectable executable");
});

test("ADR 0031 the dry-run requirement names the verb, ticket, subject digest and login command, and authorizes nothing", () => {
  const row = { ID: "T-9", Repo: "X", Status: "doing", Owner: "ownera" };
  const req = verifier.approvalRequirement({ verb: "claim --transfer-to", ticket: "T-9", reason: "why", row });
  assert.equal(req.signed_approval, "required");
  assert.equal(req.subject_sha256, verifier.subjectSha256({ verb: "claim --transfer-to", ticket: "T-9", reason: "why", state: verifier.canonicalJson(row) }));
  assert.equal(req.login_command, `sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb claim --transfer-to --ticket T-9 --subject ${req.subject_sha256} --ttl-minutes 15`);
});


test("COORD-1048: scoped approval client signs state-bound requests with a closed window and restores APIs on throw", () => {
  const fixture = createApprovalFixture({ allowedVerbs: ["integration handoff"] });
  const names = ["requestApproval", "requireHumanAdminApproval", "requireHumanAdminApprovalForState", "requireSignedOverride"];
  const originals = Object.fromEntries(names.map((name) => [name, verifier[name]]));
  const assertRestored = () => {
    for (const name of names) assert.equal(verifier[name], originals[name], `${name} must be restored`);
  };
  const events = [];
  const request = {
    verb: "integration handoff", ticket: "fixture-target", reason: "approved exact fixture state",
    state: { authority: { holder: "fixture-old", epoch: 7 }, target: { session_id: "fixture-session" } },
    config: { window_ends_at: null },
    appendGovernanceEvent: (event) => events.push(event),
    recordUsed: (id) => events.some((event) => event.approval_record === id),
  };
  const expectedSubject = verifier.subjectSha256({ verb: request.verb, ticket: request.ticket,
    reason: request.reason, state: verifier.canonicalJson(request.state) });
  try {
    withFixture(fixture, () => {
      assert.notEqual(verifier.requireHumanAdminApprovalForState, originals.requireHumanAdminApprovalForState);
      assert.throws(() => verifier.requireHumanAdminApprovalForState(request), /requires a signed human-admin approval/);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "approval.refused");
      assert.equal(events[0].refused, "no-session", "the real fixture signer, not the unavailable system store, received the request");
      assert.equal(events[0].subject_sha256, expectedSubject);
      fixture.login({ verb: request.verb, ticket: request.ticket, subject_sha256: expectedSubject });
      const result = verifier.requireHumanAdminApprovalForState(request);
      assert.equal(result.mode, "signed", "a closed window cannot authorize a transition fallback");
      assert.equal(result.subject_sha256, expectedSubject);
      assert.equal(result.key_id, fixture.keyId);
      assert.equal(events.length, 2);
      assert.equal(events[1].event, "approval.verified");
      assert.equal(events[1].approval_record, result.record_id);
      assert.equal(events[1].human_admin_session, result.session_id);
      assert.equal(events[1].subject_sha256, expectedSubject);
    });
    assertRestored();
    const sentinel = new Error("fixture callback interrupted");
    assert.throws(() => withFixture(fixture, () => {
      assert.notEqual(verifier.requireHumanAdminApprovalForState, originals.requireHumanAdminApprovalForState);
      throw sentinel;
    }), (error) => error === sentinel);
    assertRestored();
  } finally { fixture.cleanup(); }
});

test("COORD-1052: approval request refuses oversized input and invalid signer output before any grant", () => {
  let calls = 0;
  const oversized = verifier.requestApproval({ verb: "approve", ticket: "x".repeat(5000), subject_sha256: SUBJECT,
    anchor: { ok: true }, isRecordUsed: () => false,
    runSign: () => { calls += 1; assert.fail("oversized requests must never reach signer"); } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.refused, "bad-request");
  assert.equal(calls, 0);
  const untrusted = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT,
    anchor: { ok: false, refused: "store-unavailable", detail: "fixture unavailable" },
    runSign: () => assert.fail("untrusted anchor must never reach signer") });
  assert.equal(untrusted.refused, "store-unavailable");
  const badJson = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT,
    anchor: { ok: true }, isRecordUsed: () => false, runSign: () => ({ ok: true, stdout: "not JSON" }) });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.refused, "bad-record");
  for (const record of [null, {}, { schema: verifier.RECORD_SCHEMA, signature: 1 }]) {
    const result = verifier.verifyApprovalRecord(record, { request: {}, anchor: {}, isRecordUsed: () => false });
    assert.equal(result.ok, false);
    assert.equal(result.refused, "bad-record");
  }
});

test("COORD-1052: approval trust anchors reject malformed and non-Ed25519 keys", (t) => {
  const crypto = require("node:crypto"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-anchor-errors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "public.pem");
  fs.writeFileSync(file, "not a key");
  assert.match(verifier.loadTrustAnchor(file).detail, /not a public key/);
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  fs.writeFileSync(file, publicKey.export({ type: "spki", format: "pem" }));
  const result = verifier.loadTrustAnchor(file);
  assert.equal(result.ok, false);
  assert.equal(result.refused, "store-unavailable");
  assert.match(result.detail, /not Ed25519/);
});

test("COORD-1052: correctly signed approval records still require matching nonce and fresh issuance", () => {
  const crypto = require("node:crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const anchor = { ok: true, publicKey, key_id: "fixture-key" };
  const now = Date.parse("2026-11-17T12:00:00Z");
  const request = requestFor("approve", "COORD-1", SUBJECT);
  const unsigned = { schema: verifier.RECORD_SCHEMA, verb: request.verb, ticket: request.ticket,
    subject_sha256: request.subject_sha256, nonce: request.nonce, key_id: anchor.key_id,
    record_id: "b".repeat(32), session_id: "c".repeat(32),
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString() };
  const sign = (changes) => {
    const body = { ...unsigned, ...changes };
    return { ...body, signature: crypto.sign(null, Buffer.from(verifier.canonicalJson(body)), privateKey).toString("base64") };
  };
  const check = (changes) => verifier.verifyApprovalRecord(sign(changes), { request, anchor, now, isRecordUsed: () => false });
  assert.equal(check({}).ok, true);
  assert.equal(check({ nonce: "d".repeat(32) }).refused, "scope-mismatch");
  assert.equal(check({ issued_at: "invalid" }).refused, "record-stale");
  assert.equal(check({ issued_at: new Date(now + 60001).toISOString() }).refused, "record-stale");
  assert.equal(check({ issued_at: new Date(now - 60001).toISOString() }).refused, "record-stale");
  assert.equal(check({ expires_at: "invalid" }).refused, "record-expired");
  const invalidKey = verifier.verifyApprovalRecord(sign({}), { request, anchor: { ...anchor, publicKey: "invalid key" }, now, isRecordUsed: () => false });
  assert.equal(invalidKey.refused, "bad-signature");
});

test("COORD-1052: default approval transport isolates environment and verifies the returned signature", (t) => {
  const crypto = require("node:crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const anchor = { ok: true, publicKey, key_id: "fixture-transport-key" };
  const now = new Date("2026-11-17T12:00:00Z");
  let calls = 0;
  t.mock.method(require("node:child_process"), "spawnSync", (command, args, options) => {
    calls += 1;
    assert.deepEqual([command, ...args], verifier.signCommand());
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10000);
    assert.equal(options.encoding, "utf8");
    assert.deepEqual(Object.keys(options.env), ["PATH"], "no credentials or authority overrides reach the signer");
    assert.equal(options.env.PATH, process.env.PATH || "/usr/bin:/bin");
    const request = JSON.parse(options.input);
    assert.equal(request.schema, verifier.REQUEST_SCHEMA);
    assert.equal(request.verb, "approve");
    assert.equal(request.ticket, "COORD-1");
    assert.equal(request.subject_sha256, SUBJECT);
    assert.match(request.nonce, /^[0-9a-f]{32}$/);
    const body = { ...request, schema: verifier.RECORD_SCHEMA, key_id: anchor.key_id,
      record_id: "b".repeat(32), session_id: "c".repeat(32), issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60000).toISOString() };
    const record = { ...body, signature: crypto.sign(null, Buffer.from(verifier.canonicalJson(body)), privateKey).toString("base64") };
    return { status: 0, stdout: JSON.stringify(record) };
  });
  const request = { verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT, anchor, now };
  const accepted = verifier.requestApproval({ ...request, isRecordUsed: () => false });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.record_id, "b".repeat(32));
  const refused = verifier.requestApproval({ ...request, isRecordUsed: (recordId) => recordId === accepted.record_id });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "record-reused");
  assert.equal(calls, 2);
});

test("COORD-1052: default approval transport reports signer refusal without accepting output", (t) => {
  const anchor = { ok: true };
  let next;
  const originalPath = process.env.PATH;
  delete process.env.PATH;
  t.after(() => { if (originalPath !== undefined) process.env.PATH = originalPath; });
  t.mock.method(require("node:child_process"), "spawnSync", (_command, _args, options) => {
    assert.equal(options.env.PATH, "/usr/bin:/bin");
    return next;
  });
  for (const [result, refusal] of [
    [{ status: 1, stderr: 'diagnostic\n{"refused":"no-session"}' }, "no-session"],
    [{ status: 2, stderr: "not JSON" }, "store-unavailable"],
    [{ status: null, error: new Error("fixture spawn unavailable") }, "store-unavailable"],
  ]) {
    next = result;
    const verdict = verifier.requestApproval({ verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT,
      anchor, isRecordUsed: () => assert.fail("failed signer output must not reach record verification") });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.refused, refusal);
    assert.match(verdict.detail, /sign exited/);
  }
});

test("COORD-1052: approval canonicalization and missing authority context fail deterministically", (t) => {
  assert.equal(verifier.canonicalJson([{ z: 1, a: [null, { y: 2, b: 3 }] }]), '[{"a":[null,{"b":3,"y":2}],"z":1}]');
  assert.equal(verifier.subjectSha256({ verb: "approve", ticket: "COORD-1" }),
    verifier.subjectSha256({ verb: "approve", ticket: "COORD-1", reason: "", state: "" }));
  assert.equal(verifier.journalRecordUsed(null)("a".repeat(32)), true);
  const os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-approval-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "transition.json");
  assert.deepEqual(verifier.readTransitionConfig(config), { window_ends_at: null });
  fs.writeFileSync(config, "malformed JSON");
  assert.deepEqual(verifier.readTransitionConfig(config), { window_ends_at: null });
  let journaled = false;
  const request = { commandName: "claim", ticketId: "COORD-1", row: {}, options: {} };
  const deps = { resolveHumanAdminOverride: () => ({ legacyForceAlias: true }),
    fail: (message) => { throw new Error(message); },
    appendGovernanceEvent: () => { journaled = true; } };
  assert.throws(() => verifier.requireSignedOverride({ ...request, deps }), /requires explicit resolver, fail, journal, and runtimeDir/);
  assert.throws(() => verifier.requireSignedOverride({ ...request, deps: { ...deps, runtimeDir: dir } }), /bare --force is refused/);
  assert.equal(journaled, false);
});

test("default approval request refuses an unavailable system trust anchor before invoking the signer", (t) => {
  const readFileSync = fs.readFileSync;
  const anchorReads = [];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === verifier.trustAnchorPath()) {
      anchorReads.push(file);
      throw Object.assign(new Error("missing public key"), { code: "ENOENT" });
    }
    return readFileSync(file, ...args);
  });
  const verdict = verifier.requestApproval({
    verb: "approve", ticket: "COORD-1", subject_sha256: SUBJECT,
    isRecordUsed: () => false,
    runSign: () => assert.fail("cannot invoke the signer with an unavailable trust anchor"),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refused, "store-unavailable");
  assert.deepEqual(anchorReads, [verifier.trustAnchorPath()]);
});

test("state-bound approval fails closed without an audit path or an override reason", (t) => {
  const os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-approval-missing-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const options = {
    verb: "integration handoff",
    ticket: "COORD-1",
    state: { holder: "fixture-owner" },
    now: new Date("2026-11-18T00:00:00.000Z"),
    config: { window_ends_at: "2026-12-01T00:00:00.000Z" },
    approvalClient: { anchor: { ok: false, refused: "store-unavailable" } },
    appendGovernanceEvent: (event) => events.push(event),
  };
  assert.throws(() => verifier.requireHumanAdminApprovalForState(options), /requires a signed human-admin approval/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "approval.refused");
  assert.equal(events[0].override_reason, null);
  assert.equal(events[0].refused, "store-unavailable");
  assert.throws(() => verifier.requireHumanAdminApprovalForState({ ...options, runtimeDir: dir }),
    /requires a signed human-admin approval/);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "approval.refused");
  assert.equal(events[1].override_reason, null);

  const fixture = createApprovalFixture({ allowedVerbs: ["approve"] });
  t.after(() => fixture.cleanup());
  const reason = "approved test scope";
  fixture.login({ verb: "approve", ticket: options.ticket, subject_sha256: verifier.subjectSha256({
    verb: "approve", ticket: options.ticket, reason, state: verifier.canonicalJson(options.state),
  }) });
  assert.throws(() => verifier.requireHumanAdminApprovalForState({
    ...options, verb: "approve", reason, now: new Date(), config: { window_ends_at: null },
    approvalClient: fixture.client(),
  }), /refused: record-reused/);
  assert.equal(events.length, 3);
  assert.equal(events[2].event, "approval.refused");
});

test("signed override normalizes the legacy reason and still refuses without approval", (t) => {
  const os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-approval-option-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const reason = "documented operator reason";
  const deps = {
    runtimeDir: dir,
    resolveHumanAdminOverride: (_command, options) => {
      assert.equal(options.humanAdminOverride, reason);
      return { reason: options.humanAdminOverride, legacyForceAlias: false };
    },
    fail: (message) => { throw new Error(message); },
    appendGovernanceEvent: (event) => events.push(event),
  };
  assert.throws(() => verifier.requireSignedOverride({
    commandName: "claim", ticketId: "COORD-1", row: { Owner: "fixture-owner" },
    options: { override: reason }, deps,
    approvalClient: { anchor: { ok: false, refused: "store-unavailable" } },
  }), /requires a signed human-admin approval/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "approval.refused");
  assert.equal(events[0].override_reason, reason);
});
