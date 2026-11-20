"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const u = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { COORD_DIR, state, withGovernanceRuntimeLock } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const { createIsolatedGovernanceWorkspace } = require("./fixtures/isolated-governance-workspace.js");
const createJournal = require("./journal.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const createGovernanceBoardState = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-board-state.js"));
const createChainTransitionSigner = require("./chain-transition-signer.js");
const createConformanceAttestation = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-attestation.js"));
const { signTransition } = require("./chain-migration-signing.js");
const createQuestions = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/questions.js"));
const stateIo = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/state-io.js"));
const createGovernanceRepair = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-repair.js"));
const questionWriter = createQuestions({
  state,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  classifyQuestionOperationalType: createGovernanceRepair({}).classifyQuestionOperationalType,
  uniqueStrings: (values) => [...new Set(values)],
  todayIso: () => new Date().toISOString().slice(0, 10),
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
});
const sessionDiagnostics = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-session.js"))({}).formatGovernanceJournalUninitializedMessage;
const { signChainTransition } = createChainTransitionSigner({
  coordDir: COORD_DIR,
  resolveRuntimeDir: () => state.RUNTIME_DIR,
  createConformanceAttestation,
  signTransition,
});
const warningDriftPrefixes = [".runtime/agent_sessions.json", ".runtime/session-threads/"];
const boardStateProjection = createGovernanceBoardState({});
const journalOwner = createJournal({
  fail: (message) => { throw new u.GovernanceError(message); },
  relativeCoordPath: (filePath) => path.relative(COORD_DIR, filePath).replace(/\\/g, "/"),
  existingLockDirs: () => [state.LOCKS_DIR, state.LEGACY_LOCKS_DIR],
  writeFileAtomicSync: stateIo.writeFileAtomicSync,
  readJsonFileState: stateIo.readJsonFileState,
  formatJsonFileIssue: stateIo.formatJsonFileIssue,
  readLastNonEmptyLine: stateIo.readLastNonEmptyLine,
  withGovernanceRuntimeLock,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  buildQuestionRow: questionWriter.buildQuestionRow,
  appendQuestionRowText: questionWriter.appendQuestionRowText,
  parseQuestionRow: questionWriter.parseQuestionRow,
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
  ensureCurrentAgentIdentity: () => null,
  resolveEffectiveThreadId: () => null,
  readAgentSessions: (options = {}) => stateIo.readJsonArrayFileOrFail(state.AGENT_SESSIONS_PATH, "agent sessions file"),
  readCanonicalJsonFile: stateIo.readCanonicalJsonFile,
  getRows: boardStateProjection.getRows,
  formatGovernanceJournalUninitializedMessage: sessionDiagnostics,
  splitGovernanceProvenanceDrift: (files) => ({
    warnings: files.filter((file) => warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
    blocking: files.filter((file) => !warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
  }),
  signChainTransition,
  GovernanceError: u.GovernanceError,
});
u.sandboxProcessRuntime();
for (const key of ["CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "COORD_SESSION_ID", "GEMINI_THREAD_ID"]) delete process.env[key];
const question = ["log-question", "--from", "fixture", "--to", "orchestrator", "--question", "probe", "--answer", "fixture", "--resolved", "yes"];

function fixture(run) {
  return u.withGovernedSurfaceSandbox(({ promptsDir, logPath }) => {
    const target = path.join(promptsDir, "tickets", "TEST-715.md");
    const append = () => journalOwner.appendGovernanceEvent({
      ts: new Date().toISOString(), command: "fixture", ticket: null, changed_paths: [],
      snapshot: journalOwner.buildGovernanceSnapshot(),
    });
    fs.writeFileSync(target, "Requirement version one.\n"); append();
    const checkpoint = state.GOVERNANCE_SNAPSHOT_PATH;
    const older = fs.readFileSync(checkpoint);
    fs.writeFileSync(target, "Requirement version two.\n"); append();
    const latest = JSON.parse(fs.readFileSync(checkpoint)).digest;
    const artifact = digest => path.join(state.GOVERNANCE_SNAPSHOTS_DIR, `${digest}.json`);
    run({ target, logPath, checkpoint, older, latest, artifact,
      prune: () => fs.unlinkSync(artifact(latest)),
      select: () => journalOwner.readLatestGovernanceSnapshotSource() });
  }, { isolateBoardValidation: true });
}

test("COORD-715: matching checkpoint and present latest event artifact select the latest state", () => fixture(f => {
  assert.equal(f.select().source, "checkpoint");
  assert.equal(f.select().snapshot.digest, f.latest);
  fs.writeFileSync(f.checkpoint, f.older);
  assert.equal(f.select().source, "event-artifact");
  assert.equal(f.select().snapshot.digest, f.latest);
  // A rejected stale artifact must not be read before the valid event artifact.
  fs.writeFileSync(f.artifact(JSON.parse(f.older).digest), "corrupted stale cache");
  assert.equal(f.select().snapshot.digest, f.latest);
}));

test("COORD-715: mismatched checkpoint is never current when the event artifact was pruned", () => fixture(f => {
  fs.writeFileSync(f.checkpoint, f.older); f.prune();
  const selected = f.select();
  assert.equal(selected.snapshot, null);
  assert.equal(selected.pruned, true);
  assert.equal(selected.expectedDigest, f.latest);
  const state = journalOwner.detectGovernanceProvenanceDrift();
  assert.deepEqual(state.drift, [], "an unavailable baseline must not invent old-state drift");
  assert.equal(state.snapshotPruned, true);
  assert.equal(state.snapshotMatchesCurrent, true);
  const errors = [], warnings = [];
  journalOwner.appendGovernanceProvenanceIssues(errors, warnings);
  assert.deepEqual(errors, []);
  assert(warnings.some(w => /snapshot.*unavailable/i.test(w)));
  const result = u.executeCommand(question);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  assert(journalOwner.readGovernanceEventLog().some(e => e.details?.reason === "snapshot-pruned-recovery"));
}));

test("COORD-715: checkpoint-only legacy state works; missing and corrupted caches remain explicit", () => fixture(f => {
  fs.unlinkSync(f.logPath);
  assert.equal(f.select().snapshot.digest, f.latest);
  f.prune();
  assert.equal(f.select().pruned, true);
  assert.equal(journalOwner.detectGovernanceProvenanceDrift().snapshotPruned, true);
  fs.writeFileSync(f.artifact(f.latest), "bad json");
  assert.throws(f.select, /snapshot artifact/i);
}));

test("COORD-715: corrupted current checkpoint fails explicitly without accepting an older state", () => fixture(f => {
  fs.writeFileSync(f.checkpoint, "bad json");
  assert.throws(f.select, /snapshot checkpoint/i);
}));

test("COORD-715: missing checkpoint and legacy inline evidence obey the event digest", () => fixture(f => {
  const snapshot = JSON.parse(fs.readFileSync(f.artifact(f.latest)));
  fs.unlinkSync(f.checkpoint);
  assert.equal(f.select().source, "event-artifact");
  f.prune();
  assert.equal(f.select().pruned, true);
  fs.writeFileSync(f.logPath, JSON.stringify({ snapshot_digest: f.latest, snapshot }) + "\n");
  assert.equal(f.select().source, "legacy-event");
  fs.writeFileSync(f.logPath, JSON.stringify({ snapshot_digest: f.latest,
    snapshot: { ...snapshot, digest: JSON.parse(f.older).digest } }) + "\n");
  assert.equal(f.select().snapshot, null, "an inline snapshot cannot contradict its event digest either");
}));

test("COORD-1048: legacy chain anchoring preserves a pruned baseline through an approval refusal", () => fixture(f => {
  const expectedDigest = f.latest;
  const legacy = { ts: new Date().toISOString(), command: "legacy-fixture", ticket: null,
    changed_paths: [], snapshot_digest: expectedDigest };
  fs.writeFileSync(f.logPath, `${JSON.stringify(legacy)}\n`);
  fs.writeFileSync(f.checkpoint, JSON.stringify({ digest: expectedDigest, recorded_at: null }));
  f.prune();
  assert.deepEqual({ snapshot: f.select().snapshot, expectedDigest: f.select().expectedDigest },
    { snapshot: null, expectedDigest });

  journalOwner.appendGovernanceEvent({ event: "approval.refused", command: "reconcile", ticket: "control-plane",
    ts: new Date().toISOString(), changed_paths: [], subject_sha256: "fixture-subject" });

  const events = fs.readFileSync(f.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const anchor = events.find((event) => event.command === "chain-anchor");
  assert.ok(anchor, "first chained approval refusal inserts the explicit legacy anchor");
  assert.equal(anchor.snapshot_digest, expectedDigest);
  assert.equal(anchor.snapshot, undefined, "pruned baseline stays pruned; migration never seals current drift");
  assert.equal(fs.existsSync(f.artifact(expectedDigest)), false);
  assert.deepEqual({ snapshot: f.select().snapshot, expectedDigest: f.select().expectedDigest },
    { snapshot: null, expectedDigest }, "the original unavailable baseline remains selected after anchoring");
}));

test("COORD-715: actual CLI refuses unverified edits after pruning; explicit recovery is audited and retry-safe", () => {
  const f = createIsolatedGovernanceWorkspace({ prefix: "coord715-pruned-recovery-" });
  try {
    const state = f.governance.__testing;
    const target = path.join(f.coord, "prompts", "tickets", "TEST-715.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assert.equal(f.invoke(["agentid", "--assign"]).ok, true);
    fs.writeFileSync(target, "Requirement version one.\n");
    state.appendGovernanceEvent({ ts: new Date().toISOString(), command: "fixture", ticket: null, changed_paths: [], snapshot: state.buildGovernanceSnapshot() });
    const checkpoint = path.join(f.coord, ".runtime", "governance-latest-snapshot.json");
    const latest = JSON.parse(fs.readFileSync(checkpoint, "utf8")).digest;
    fs.rmSync(path.join(f.coord, ".runtime", "governance-snapshots", `${latest}.json`));
    fs.writeFileSync(target, "Out-of-band changed requirement.\n");
    const logPath = path.join(f.coord, ".runtime", "governance-events.ndjson");
    const before = fs.readFileSync(logPath, "utf8");
    const provenance = state.detectGovernanceProvenanceDrift();
    assert.equal(provenance.snapshotPruned, true);
    assert.equal(provenance.snapshotMatchesCurrent, false);
    const errors = [];
    state.appendGovernanceProvenanceIssues(errors, []);
    assert(errors.some(e => /snapshot.*unavailable/i.test(e) && /reconcile/.test(e)));
    const doctor = f.invoke(["doctor"]);
    assert.match(`${doctor.stdout}\n${doctor.error || ""}`, /Governance snapshot baseline unavailable/);
    const refused = f.invoke(question);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /snapshot.*unavailable/i);
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
    assert.throws(() => state.withGovernanceMutation({ command: "generic-repair", allowProvenanceDrift: true }, () => {}), /snapshot.*unavailable/i);
    assert.throws(() => state.withGovernanceMutation({ command: "no-baseline", ensureBaseline: false }, () => {}), /snapshot.*unavailable/i);
    const ordinary = f.invoke(["reconcile", "--reason", "ordinary repair"]);
    assert.equal(ordinary.ok, false);
    assert.match(ordinary.error, /human-admin-override/);
    const dry = f.invoke(["reconcile", "--reason", "inspect", "--dry-run"]);
    assert.equal(dry.ok, true, dry.error);
    assert.equal(JSON.parse(dry.stdout).requires_human_admin_override, true);
    assert.equal(JSON.parse(dry.stdout).snapshot_pruned, true);

    const approval = "Fixture administrator approves this exact requirement change after baseline inspection";
    const relative = path.relative(f.coord, target).split(path.sep).join("/");
    // COORD-935: rendering policy inputs are sealed snapshot paths, so the packet covers them too.
    const expectedPaths = ["board/tasks.json", "PLAN.md", relative, "QUESTIONS.md", "GOVERNANCE.md", "project.config.js", "board/tasks.schema.json", "board/plan.schema.json"].sort((a, b) => a.localeCompare(b));
    const expectedPacket = expectedPaths.map(file => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(f.coord, file))).digest("hex")} ${file}`);
    assert.deepEqual(JSON.parse(dry.stdout).expect_paths_packet, expectedPacket);
    const packetPath = path.join(f.root, "recovery.packet");
    fs.writeFileSync(packetPath, `${expectedPacket.join("\n")}\n`);
    const checkpointBefore = fs.readFileSync(checkpoint);
    const invalid = f.invoke(["reconcile", "UNKNOWN-715", "--reason", "fixture", "--human-admin-override", approval, "--expect-paths-file", packetPath]);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /requires a signed human-admin approval/);
    const assertRefusalOnly = (previous, result, ticket) => {
      const current = fs.readFileSync(logPath, "utf8");
      assert.equal(current.slice(0, previous.length), previous, "prior journal bytes are preserved");
      const appended = current.slice(previous.length).trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(appended.length, 1, "the failed request appends only its approval refusal");
      const { ts, prev_event_hash, ...audit } = appended[0];
      assert.ok(Number.isFinite(Date.parse(ts)));
      assert.match(prev_event_hash, /^[0-9a-f]{40,64}$/);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(result.error);
      const refusal = /refused: ([a-z-]+)\./.exec(result.error);
      assert.ok(digest, result.error);
      assert.ok(refusal, result.error);
      assert.deepEqual(audit, { event: "approval.refused", command: "reconcile", ticket,
        subject_sha256: digest[1], refused: refusal[1], override_reason: approval });
      assert.deepEqual(fs.readFileSync(checkpoint), checkpointBefore, "failed recovery cannot change the checkpoint");
      assert.equal(fs.existsSync(path.join(f.coord, ".runtime", "governance-snapshots", `${latest}.json`)), false);
      const unchanged = state.detectGovernanceProvenanceDrift();
      assert.equal(unchanged.snapshotPruned, true);
      assert.equal(unchanged.expectedSnapshotDigest, latest, "the refusal cannot select an older baseline");
      assert.equal(unchanged.currentSnapshot.digest, provenance.currentSnapshot.digest);
      assert.equal(fs.readFileSync(target, "utf8"), "Out-of-band changed requirement.\n");
      return digest[1];
    };
    assertRefusalOnly(before, invalid, "UNKNOWN-715");
    const approvedDigest = state.buildGovernanceSnapshot().digest;
    const args = ["reconcile", "--reason", "reviewed fixture recovery", "--human-admin-override", approval, "--expect-paths-file", packetPath];
    const signer = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    let recovered;
    try {
      recovered = withApprovalTestClient(f.coord, signer.client(), () => {
        const beforeApproval = fs.readFileSync(logPath, "utf8");
        const unsigned = f.invoke(args);
        assert.equal(unsigned.ok, false, "reason-only recovery must still refuse");
        assert.match(unsigned.error, /requires a signed human-admin approval/);
        const subject = assertRefusalOnly(beforeApproval, unsigned, "control-plane");
        signer.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: subject });
        return f.invoke(args);
      });
    } finally { signer.cleanup(); }
    assert.equal(recovered.ok, true, recovered.error);
    const event = state.readGovernanceEventLog().findLast(e => e.command === "manual-reconcile");
    assert.equal(event.details.human_admin_override, approval);
    assert.equal(event.details.snapshot_recovery.approved_digest, approvedDigest);
    assert.equal(event.details.snapshot_recovery.expected_digest, latest);
    assert.deepEqual(state.detectGovernanceProvenanceDrift().drift, []);
    const after = fs.readFileSync(logPath, "utf8");
    assert.equal(f.invoke(["reconcile", "--reason", "retry after recovery", "--human-admin-override", approval]).ok, true);
    assert.equal(fs.readFileSync(logPath, "utf8"), after, "recovery retry is a no-op");
    fs.writeFileSync(target, "Another unauthorized edit.\n");
    assert.equal(f.invoke(question).ok, false, "normal provenance guard remains active after recovery");
  } finally {
    f.cleanup();
  }
});

test("COORD-715: recovery approval cannot be reused for changed bytes under the mutation lock", () => fixture(f => {
  f.prune();
  fs.writeFileSync(f.target, "Reviewed correction.\n");
  const approvedDigest = journalOwner.buildGovernanceSnapshot().digest;
  fs.writeFileSync(f.target, "Different unreviewed correction.\n");
  const before = fs.readFileSync(f.logPath, "utf8");
  let ran = false;
  assert.throws(() => u.__testing.withGovernanceMutation({
    command: "manual-reconcile", allowProvenanceDrift: true,
    snapshotRecovery: { approval: "Fixture approval for earlier bytes", approvedDigest },
  }, () => { ran = true; }), /snapshot.*unavailable/i);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(f.logPath, "utf8"), before);
}));

test("COORD-722: the unavailable-snapshot message names the digest, or 'unknown' when the provenance has none", () => {
  const { createJournalSnapshots } = require("./journal-snapshots.js");
  const snapshots = createJournalSnapshots({ path, state: { GOVERNANCE_SNAPSHOTS_DIR: "/snapshots" } });
  assert.equal(snapshots.governanceSnapshotArtifactPath("abc"), path.join("/snapshots", "abc.json"));
  const named = snapshots.formatUnavailableSnapshotMessage({ expectedSnapshotDigest: "d".repeat(40) });
  assert.match(named, new RegExp(`^Governance snapshot baseline unavailable for digest ${"d".repeat(40)}; `));
  const unknown = snapshots.formatUnavailableSnapshotMessage({ expectedSnapshotDigest: null });
  assert.match(unknown, /^Governance snapshot baseline unavailable for digest unknown; current state cannot be verified\. /);
  assert.match(unknown, /--expect-paths-file <the approved path and sha256 packet>\.$/);
});


test("COORD-1048: snapshot serialization preserves input evidence and propagates artifact write failure", () => {
  const { serializeSnapshotEvent } = require("./journal-snapshots.js");
  const snapshot = Object.freeze({ digest: "a".repeat(64), files: Object.freeze([]) });
  const event = Object.freeze({ command: "fixture", snapshot, details: Object.freeze({ preserved: true }) });
  const written = [];
  assert.deepEqual(serializeSnapshotEvent(event, (value) => written.push(value)),
    { command: "fixture", snapshot_digest: snapshot.digest, details: { preserved: true } });
  assert.deepEqual(written, [snapshot]);
  assert.equal(event.snapshot, snapshot);
  const pruned = Object.freeze({ snapshot_digest: "b".repeat(64) });
  assert.deepEqual(serializeSnapshotEvent(pruned, () => { throw new Error("pruned snapshots must not be fabricated"); }), pruned);
  assert.throws(() => serializeSnapshotEvent(event, () => { throw new Error("artifact persistence failed"); }), /artifact persistence failed/);
  assert.equal(event.snapshot, snapshot, "failed persistence leaves the original evidence intact");
});
