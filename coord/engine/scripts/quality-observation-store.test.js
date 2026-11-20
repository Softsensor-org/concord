"use strict";

// COORD-710: immutable observation store, the `gov observe` verb against fake
// governance deps, and source-mutation tests that prove the ingest-to-series
// wiring is load-bearing (digest verification, no-measurement refusal, attempt
// claims, comparable-attempt filtering and the journal cross-check).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("./quality-observation.js");
const observation = require("./quality-observation-store.js");

const FIXTURES = path.join(__dirname, "fixtures", "quality-observation");
const SHA = "a".repeat(40);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord710-"));
  t.after(() => {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function jest(results, extra = {}) {
  const assertionResults = results.map(([title, status, duration = 10]) => ({ ancestorTitles: ["S"], title, status, duration }));
  return JSON.stringify({ numTotalTests: assertionResults.length, testResults: [{ name: "a.test.js", assertionResults }], ...extra });
}

function artifact(overrides = {}, coreModule = core) {
  return coreModule.normalizeRun({
    format: "jest-json", repository: "X", suite: "unit", commitSha: SHA, runtime: "node-22", attempt: 1,
    ingestedAt: "2026-01-01T00:00:00.000Z", text: jest([["a", "passed"]]), ...overrides,
  });
}

class FakeGovernanceError extends Error {}

// A faithful stand-in for the journal seam: one event per committed mutation,
// idempotency keys honored, failed mutations append nothing.
function harness(t, overrides = {}) {
  const base = tempDir(t);
  const events = [];
  const output = [];
  let clock = 0;
  let skipMutationOnce = false;
  const deps = {
    fail: (message) => { throw new FakeGovernanceError(message); },
    withGovernanceMutation: (metadata, fn) => {
      if (skipMutationOnce) {
        skipMutationOnce = false;
        return undefined;
      }
      if (metadata.idempotencyKey && events.some((event) => event.details.idempotency_key === metadata.idempotencyKey)) return undefined;
      const result = fn();
      events.push({ command: metadata.command, ticket: metadata.ticket, identity: metadata.identity, details: { ...metadata.details, idempotency_key: metadata.idempotencyKey } });
      return result;
    },
    readGovernanceEventLog: () => [{ command: "journal-baseline", details: null }, ...events],
    ensureCurrentAgentIdentity: (options) => {
      assert.deepEqual(options, { allowAutoClaim: false, touchSession: false });
      return { agent: { handle: "claudea13" } };
    },
    runtimeState: { RUNTIME_DIR: path.join(base, ".runtime") },
    now: () => `2026-01-01T00:00:${String((clock += 1) % 60).padStart(2, "0")}.000Z`,
    log: (line) => output.push(line),
    core,
    ...overrides,
  };
  const { observe } = observation.createObservationCommands(deps);
  const storeRoot = path.join(base, "evidence", "observations");
  function write(name, text) {
    const file = path.join(base, name);
    fs.writeFileSync(file, text);
    return file;
  }
  function ingestArgs(report, extra = []) {
    return ["ingest", "--format", "jest-json", "--report", report, "--repo", "X", "--suite", "unit", "--commit", SHA, "--runtime", "node-22", ...extra];
  }
  return { base, events, output, observe, storeRoot, write, ingestArgs, deps, skipMutationOnce: () => { skipMutationOnce = true; } };
}

// --- store -------------------------------------------------------------------------

test("store persists one immutable canonical artifact per content digest and claims each attempt once", (t) => {
  const root = tempDir(t);
  const store = observation.createObservationStore({ root, core });
  const first = artifact();
  const stored = store.ingest(first);
  assert.equal(stored.status, "created");
  assert.equal(stored.path, `runs/${first.content_digest}.json`);
  assert.equal(fs.readFileSync(path.join(root, stored.path), "utf8"), core.artifactBytes(first));
  assert.equal(stored.artifact_digest, core.sha256Hex(core.artifactBytes(first)));
  const redelivered = artifact({ ingestedAt: "2026-05-05T00:00:00.000Z" });
  assert.equal(redelivered.content_digest, first.content_digest);
  const again = store.ingest(redelivered);
  assert.equal(again.status, "duplicate");
  assert.equal(again.artifact.provenance.ingested_at, first.provenance.ingested_at, "first delivery wins; later deliveries never rewrite");

  const otherAdapter = core.normalizeRun({
    format: "junit-xml", repository: "X", suite: "unit", commitSha: SHA, runtime: "node-22", attempt: 1,
    ingestedAt: "2026-01-01T00:00:00.000Z", text: "<testsuite><testcase name='a'/></testsuite>",
  });
  assert.notEqual(otherAdapter.content.adapter.id, first.content.adapter.id);
  assert.equal(store.ingest(otherAdapter).status, "created", "adapter identities have independent attempt claims");

  const conflict = artifact({ text: jest([["a", "failed"]]) });
  assert.throws(() => store.ingest(conflict), (error) => error.code === "attempt-conflict");
  assert.equal(store.listArtifacts().length, 2, "changed content within the same adapter and attempt remains a conflict");
  assert.deepEqual(fs.readdirSync(path.join(root, ".tmp")), [], "temporary files never outlive a write");
});

test("concurrent duplicate delivery from separate processes stores one artifact and one attempt", async (t) => {
  const root = tempDir(t);
  const item = artifact();
  const script = [
    "const core = require(process.argv[1]);",
    "const store = require(process.argv[2]).createObservationStore({ root: process.argv[3], core });",
    "const artifact = JSON.parse(process.argv[4]);",
    "process.stdout.write(store.ingest(artifact).status);",
  ].join("\n");
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, require.resolve("./quality-observation.js"), require.resolve("./quality-observation-store.js"), root, JSON.stringify(item)], { env });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve(out) : reject(new Error(`child exited ${status}`))));
  }));
  const statuses = await Promise.all(runs);
  assert.equal(statuses.filter((status) => status === "created").length, 1);
  assert.equal(statuses.filter((status) => status === "duplicate").length, 5);
  assert.equal(fs.readdirSync(path.join(root, "runs")).length, 1);
  assert.equal(fs.readdirSync(path.join(root, "attempts")).length, 1);
  assert.equal(observation.createObservationStore({ root, core }).rebuildSeries({ write: false }).series.suites[0].runs.length, 1);
});

test("store reads fail closed on tampered, misnamed, non-canonical or corrupt files", (t) => {
  const root = tempDir(t);
  const store = observation.createObservationStore({ root, core });
  const stored = store.ingest(artifact());
  const file = path.join(root, stored.path);
  const original = fs.readFileSync(file, "utf8");
  const check = () => assert.throws(() => store.listArtifacts(), (error) => error.code === "digest-mismatch");
  fs.writeFileSync(file, original.replace("\"passed\"", "\"failed\""));
  check();
  fs.writeFileSync(file, `${JSON.stringify(JSON.parse(original), null, 2)}\n`);
  check();
  fs.writeFileSync(file, "{");
  check();
  fs.writeFileSync(file, original);
  fs.renameSync(file, path.join(root, "runs", `${"0".repeat(64)}.json`));
  check();
  fs.rmSync(path.join(root, "runs"), { recursive: true });
  const claim = fs.readdirSync(path.join(root, "attempts"))[0];
  fs.writeFileSync(path.join(root, "attempts", claim), "not json");
  assert.throws(() => store.ingest(artifact()), (error) => error.code === "digest-mismatch");
  assert.deepEqual(store.listArtifacts(), []);
});

test("store write errors other than an existing file are not mistaken for duplicates", (t) => {
  const root = tempDir(t);
  const store = observation.createObservationStore({ root, core });
  fs.mkdirSync(path.join(root, "attempts"), { recursive: true });
  fs.chmodSync(path.join(root, "attempts"), 0o555);
  try {
    assert.throws(() => store.ingest(artifact()), (error) => error.code === "EACCES");
  } finally {
    fs.chmodSync(path.join(root, "attempts"), 0o755);
  }
});

test("quarantines and rejection receipts are stored once and rebuild into the series", (t) => {
  const root = tempDir(t);
  const store = observation.createObservationStore({ root, core });
  const record = core.validateQuarantine({
    repository: "X", suite: "unit", testId: core.canonicalize(["a.test.js", "S", "a"]), owner: "claudea13", reason: "flake",
    createdAt: "2025-12-31T00:00:00Z", expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7,
  });
  assert.equal(store.recordQuarantine(record), "created");
  assert.equal(store.recordQuarantine(record), "duplicate");
  assert.throws(() => store.recordQuarantine({ ...record, owner: "x" }), (error) => error.code === "digest-mismatch");
  store.ingest(artifact());
  const first = store.rebuildSeries({ write: true });
  assert.equal(first.stored_matches, null);
  const second = store.rebuildSeries({ write: false });
  assert.equal(second.stored_matches, true);
  assert.equal(second.series.quarantine_count, 1);
  assert.equal(second.series.suites[0].tests[0].observations[0].effective_outcome, "quarantined");
  const receipt = core.buildRejectionReceipt({ error: new core.ObservationError("malformed", "x"), rejectedAt: "t" });
  const receiptPath = store.writeRejection(receipt);
  assert.equal(store.writeRejection({ ...receipt, rejected_at: "later" }), receiptPath);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, receiptPath), "utf8")).rejected_at, "t");
});

// --- gov observe verb (fake governance deps) ---------------------------------------------

test("ingest persists the artifact and appends exactly one compact journal event per run", (t) => {
  const h = harness(t);
  const many = Array.from({ length: 50 }, (_, i) => [`t${i}`, "passed"]);
  const report = h.write("report.json", jest(many));
  const result = h.observe(h.ingestArgs(report, ["--ticket", "COORD-710", "--attempt", "1"]));
  assert.equal(result.status, "created");
  assert.equal(result.passing_evidence, true);
  assert.equal(result.store, "evidence/observations");
  assert.equal(h.events.length, 1, "no per-test journal events");
  const [event] = h.events;
  assert.equal(event.command, "observe-ingest");
  assert.equal(event.ticket, "COORD-710");
  assert.equal(event.details.event_type, observation.INGEST_EVENT_TYPE);
  assert.equal(event.details.observation.content_digest, result.content_digest);
  assert.equal(event.details.observation.counts.tests, 50);
  assert.ok(JSON.stringify(event.details).length < 1500, "the journal carries a digest and pointer, not the run");
  const stored = fs.readFileSync(path.join(h.storeRoot, event.details.observation.artifact_path), "utf8");
  assert.equal(core.sha256Hex(stored), event.details.observation.artifact_digest);
  assert.equal(JSON.parse(h.output[0]).series_digest, result.series_digest);

  const repeat = h.observe(h.ingestArgs(report));
  assert.equal(repeat.status, "duplicate");
  assert.equal(repeat.artifact_digest, result.artifact_digest);
  assert.equal(h.events.length, 1, "repeated delivery is idempotent in the journal");
  assert.equal(observation.createObservationStore({ root: h.storeRoot, core }).listArtifacts().length, 1);
  assert.equal(fs.readdirSync(path.join(h.storeRoot, "attempts")).length, 1, "idempotent callback fallback reuses the existing attempt claim");
  assert.equal(fs.readdirSync(path.join(h.storeRoot, "runs")).length, 1, "idempotent callback fallback creates no orphan run");
});

test("malformed, truncated, duplicate and unsupported input fails closed with an attributable receipt", (t) => {
  const h = harness(t);
  const cases = [
    ["jest-json", "jest-malformed.json", "malformed"],
    ["node-test-tap", "node22-truncated.tap", "truncated"],
    ["node-test-tap", "node22-duplicate.tap", "duplicate-test-identity"],
    ["node-test-tap", "tap14-unsupported.tap", "unsupported-version"],
    ["go-json", "jest-basic.json", "unsupported-format"],
  ];
  for (const [format, input, expected] of cases) {
    const args = h.ingestArgs(path.join(FIXTURES, input));
    args[2] = format;
    assert.throws(() => h.observe(args), (error) => error instanceof FakeGovernanceError && error.message.includes(expected), input);
  }
  assert.equal(h.events.length, cases.length);
  for (const event of h.events) {
    assert.equal(event.details.event_type, observation.REJECT_EVENT_TYPE);
    const receipt = JSON.parse(fs.readFileSync(path.join(h.storeRoot, event.details.rejection.receipt_path), "utf8"));
    assert.equal(receipt.code, event.details.rejection.code);
    assert.equal(receipt.actor, "claudea13");
    assert.equal(receipt.commit_sha, SHA);
    assert.match(receipt.source_digest, /^[0-9a-f]{64}$/);
  }
  const before = h.events.length;
  assert.throws(() => h.observe(h.ingestArgs(path.join(FIXTURES, "jest-malformed.json"))), FakeGovernanceError);
  assert.equal(h.events.length, before, "a repeated refusal does not flood the journal");
  const binary = h.write("binary.json", Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(() => h.observe(h.ingestArgs(binary)), /malformed: report is not valid UTF-8/);
  assert.throws(() => h.observe(h.ingestArgs(h.base)), /unreadable-report/);
});

test("an expected but absent report is recorded as non-passing and the verb exits non-zero", (t) => {
  const h = harness(t);
  const missing = path.join(h.base, "never-written.json");
  assert.throws(() => h.observe(h.ingestArgs(missing, ["--expect-measurement"])), /measurement was expected but absent/);
  assert.equal(h.events.length, 1);
  const recorded = h.events[0].details.observation;
  assert.equal(recorded.run_status, "measurement-expected-but-absent");
  assert.equal(recorded.passing_evidence, false);
  assert.throws(() => h.observe(h.ingestArgs(missing)), /report-absent/, "nothing expected and nothing reported is refused");
  assert.equal(h.events.at(-1).details.event_type, observation.REJECT_EVENT_TYPE);
});

test("a corrupt store refuses a new ingestion before anything is written", (t) => {
  const h = harness(t);
  const first = h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]]))));
  fs.writeFileSync(path.join(h.storeRoot, first.artifact_path), "{");
  const before = fs.readdirSync(path.join(h.storeRoot, "attempts")).length;
  assert.throws(() => h.observe(h.ingestArgs(h.write("two.json", jest([["b", "passed"]])), ["--attempt", "2"])), /digest-mismatch/);
  assert.equal(fs.readdirSync(path.join(h.storeRoot, "attempts")).length, before, "no attempt claim was written");
  assert.equal(fs.readdirSync(path.join(h.storeRoot, "runs")).length, 1, "no orphan artifact was written");
  assert.equal(h.events.filter((event) => event.details.event_type === observation.INGEST_EVENT_TYPE).length, 1);
});

test("refusal messages quote at most a bounded prefix of the offending input", (t) => {
  const h = harness(t);
  const report = h.write("huge.tap", `TAP version 13\n${"x".repeat(100000)}\n`);
  const args = h.ingestArgs(report);
  args[2] = "node-test-tap";
  assert.throws(() => h.observe(args), (error) => error.message.length < 2000 && /unrecognized TAP line 2/.test(error.message));
});

test("a different payload for an already-recorded attempt is refused and never counted", (t) => {
  const h = harness(t);
  h.observe(h.ingestArgs(h.write("one.json", jest([["a", "failed"]]))));
  assert.throws(() => h.observe(h.ingestArgs(h.write("two.json", jest([["a", "passed"]])))), /attempt-conflict/);
  assert.deepEqual(h.events.map((event) => event.details.event_type), [observation.INGEST_EVENT_TYPE, observation.REJECT_EVENT_TYPE]);
  const retry = h.observe(h.ingestArgs(h.write("three.json", jest([["a", "passed"]])), ["--attempt", "2"]));
  assert.equal(retry.status, "created");
  const series = h.observe(["series"]);
  assert.deepEqual(series.suites[0].flake, { flaky_groups: 1, evaluated_groups: 1, rate: "1.0000" });
  assert.equal(h.output.at(-1), observation.createObservationStore({ root: h.storeRoot, core }).rebuildSeries({ write: false }).bytes.trimEnd());
});

test("replay re-verifies every journaled digest and rebuilds a byte-identical series", (t) => {
  const h = harness(t);
  h.observe(h.ingestArgs(h.write("one.json", jest([["a", "failed"], ["b", "passed"]]))));
  h.observe(h.ingestArgs(h.write("two.json", jest([["a", "passed"], ["c", "passed"]])), ["--attempt", "2"]));
  const seriesFile = path.join(h.storeRoot, "series.json");
  const original = fs.readFileSync(seriesFile, "utf8");
  fs.rmSync(seriesFile);
  const rebuilt = h.observe(["replay"]);
  assert.equal(rebuilt.wrote_series, true);
  assert.equal(rebuilt.stored_series_matched, null);
  assert.equal(rebuilt.journal_events_verified, 2);
  assert.equal(fs.readFileSync(seriesFile, "utf8"), original, "replay rebuilds identical series bytes");
  const checked = h.observe(["replay", "--check"]);
  assert.equal(checked.stored_series_matched, true);
  assert.equal(checked.wrote_series, false);
  assert.equal(checked.series_digest, core.sha256Hex(original));

  fs.writeFileSync(seriesFile, "stale\n");
  assert.throws(() => h.observe(["replay", "--check"]), /does not match the rebuilt series/);
  h.observe(["replay"]);
  assert.equal(fs.readFileSync(seriesFile, "utf8"), original);
});

test("replay refuses tampered provenance, missing artifacts and artifacts with no journal receipt", (t) => {
  const h = harness(t);
  const result = h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]]))));
  const file = path.join(h.storeRoot, result.artifact_path);
  const original = fs.readFileSync(file, "utf8");
  const forged = JSON.parse(original);
  forged.provenance.ingested_at = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, core.artifactBytes(forged));
  assert.throws(() => h.observe(["replay", "--check"]), /bytes do not match the journaled digest/);
  fs.rmSync(file);
  assert.throws(() => h.observe(["replay", "--check"]), /is missing from the store/);
  fs.writeFileSync(file, original);
  const store = observation.createObservationStore({ root: h.storeRoot, core });
  store.ingest(artifact({ text: jest([["z", "passed"]]), attempt: 9 }));
  assert.throws(() => h.observe(["replay", "--check"]), /has no governance journal receipt/);
  fs.writeFileSync(file, "{");
  assert.throws(() => h.observe(["replay"]), /gov observe replay refused: digest-mismatch/);
});

test("series refuses provenance tampering before exposing a derived observation", (t) => {
  const h = harness(t);
  const result = h.observe(h.ingestArgs(h.write("one.json", jest([["a", "failed"]]))));
  const file = path.join(h.storeRoot, result.artifact_path);
  const forged = JSON.parse(fs.readFileSync(file, "utf8"));
  forged.provenance.ingested_at = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, core.artifactBytes(forged));
  const before = fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8");

  assert.throws(() => h.observe(["series"]), /gov observe series refused: digest-mismatch: artifact .* bytes do not match the journaled digest/);
  assert.equal(fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8"), before, "refusal does not rewrite the derived file");
  assert.equal(h.output.length, 1, "no derived series is emitted after the receipt mismatch");
});

test("series fails closed on a missing receipt, malformed receipt, or conflicting receipt digests", (t) => {
  const missing = harness(t);
  const store = observation.createObservationStore({ root: missing.storeRoot, core });
  store.ingest(artifact({ attempt: 9 }));
  assert.throws(() => missing.observe(["series"]), /artifact .* has no governance journal receipt/);

  const malformed = harness(t);
  malformed.events.push({ details: { event_type: observation.INGEST_EVENT_TYPE } });
  assert.throws(() => malformed.observe(["series"]), /journaled observation receipt is malformed/);

  const conflicting = harness(t);
  const result = conflicting.observe(conflicting.ingestArgs(conflicting.write("one.json", jest([["a", "passed"]]))));
  const matchingReceipt = conflicting.events[0];
  conflicting.events.push({ details: matchingReceipt.details });
  assert.equal(conflicting.observe(["series"]).suites.length, 1, "identical duplicate receipts remain compatible");
  conflicting.events.push({ details: {
    event_type: observation.INGEST_EVENT_TYPE,
    observation: { store: "evidence/observations", content_digest: result.content_digest, artifact_digest: "0".repeat(64) },
  } });
  assert.throws(() => conflicting.observe(["series"]), /conflicting artifact digests/);

  const invalidDigest = harness(t);
  invalidDigest.events.push({ details: {
    event_type: observation.INGEST_EVENT_TYPE,
    observation: { store: "evidence/observations", content_digest: "bad", artifact_digest: "bad" },
  } });
  assert.throws(() => invalidDigest.observe(["series"]), /has invalid digests/);
});

test("ingest refuses a tampered existing artifact before claiming or writing a new run", (t) => {
  const h = harness(t);
  const first = h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]]))));
  const file = path.join(h.storeRoot, first.artifact_path);
  const forged = JSON.parse(fs.readFileSync(file, "utf8"));
  forged.provenance.ingested_at = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, core.artifactBytes(forged));
  const before = {
    attempts: fs.readdirSync(path.join(h.storeRoot, "attempts")).sort(),
    runs: fs.readdirSync(path.join(h.storeRoot, "runs")).sort(),
    series: fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8"),
    ingestEvents: h.events.filter((event) => event.details.event_type === observation.INGEST_EVENT_TYPE).length,
  };

  assert.throws(() => h.observe(h.ingestArgs(h.write("two.json", jest([["b", "passed"]])), ["--attempt", "2"])),
    /gov observe ingest refused \(digest-mismatch: artifact .* bytes do not match the journaled digest/);
  assert.deepEqual(fs.readdirSync(path.join(h.storeRoot, "attempts")).sort(), before.attempts, "no attempt claim is added");
  assert.deepEqual(fs.readdirSync(path.join(h.storeRoot, "runs")).sort(), before.runs, "no run artifact is added");
  assert.equal(fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8"), before.series, "series remains unchanged");
  assert.equal(h.events.filter((event) => event.details.event_type === observation.INGEST_EVENT_TYPE).length, before.ingestEvents);
});

test("replay ignores journal events that belong to another store", (t) => {
  const h = harness(t);
  const other = path.join(h.base, "other-store");
  h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]])), ["--store", other]));
  const replayed = h.observe(["replay"]);
  assert.equal(replayed.run_count, 0);
  assert.equal(replayed.journal_events_verified, 0);
  assert.equal(h.observe(["replay", "--store", other]).journal_events_verified, 1);
});

test("quarantine verb records a governed object once and applies it to derived series", (t) => {
  const h = harness(t, { ensureCurrentAgentIdentity: () => { throw new Error("no session"); } });
  const testId = core.canonicalize(["a.test.js", "S", "a"]);
  const args = ["quarantine", "--repo", "X", "--suite", "unit", "--test-id", testId, "--owner", "claudea13", "--reason", "known flake",
    "--created-at", "2025-12-31T00:00:00Z", "--expires-at", "2026-01-05T00:00:00Z", "--max-age-days", "7"];
  const recorded = h.observe(args);
  assert.equal(recorded.status, "created");
  assert.equal(h.events[0].details.event_type, observation.QUARANTINE_EVENT_TYPE);
  assert.equal(h.events[0].details.quarantine.quarantine_id, recorded.quarantine_id);
  assert.equal(h.events[0].identity, null, "an unbound session is recorded as an unattributed actor, not invented");
  assert.equal(h.observe(args).status, "duplicate");
  assert.equal(h.events.length, 1);
  h.observe(h.ingestArgs(h.write("one.json", jest([["a", "failed"]]))));
  assert.equal(h.events[1].identity, null);
  assert.equal(h.observe(["series"]).suites[0].tests[0].observations[0].effective_outcome, "quarantined");
  const defaulted = h.observe(["quarantine", "--repo", "X", "--suite", "unit", "--test-id", testId, "--owner", "o", "--reason", "r",
    "--expires-at", "2026-01-03T00:00:00Z", "--max-age-days", "7"]);
  assert.match(defaulted.created_at, /^2026-01-01T00:00:/);
  assert.throws(() => h.observe(["quarantine", "--repo", "X"]), /gov observe quarantine refused \(invalid-quarantine/);
});

test("an unjournaled self-hashed quarantine cannot hide a failed observation", (t) => {
  const h = harness(t);
  h.observe(h.ingestArgs(h.write("failed.json", jest([["a", "failed"]]))));
  const store = observation.createObservationStore({ root: h.storeRoot, core });
  const record = core.validateQuarantine({
    repository: "X", suite: "unit", testId: core.canonicalize(["a.test.js", "S", "a"]),
    owner: "o", reason: "forged without a governed receipt", createdAt: "2025-12-31T00:00:00Z",
    expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7,
  });
  store.recordQuarantine(record);
  const forgedSeries = store.rebuildSeries({ write: false }).series;
  assert.equal(forgedSeries.suites[0].tests[0].observations[0].effective_outcome, "quarantined",
    "the raw derivation would let a valid-looking orphan mask the failure");
  const before = fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8");

  assert.throws(() => h.observe(["series"]), /gov observe series refused: .*quarantine .* has no governance journal receipt/);
  assert.equal(fs.readFileSync(path.join(h.storeRoot, "series.json"), "utf8"), before, "refusal leaves derived evidence untouched");
  assert.equal(h.events.filter((event) => event.details.event_type === observation.QUARANTINE_EVENT_TYPE).length, 0);
});

test("quarantine receipts must match a stored record before a new quarantine mutates the store", (t) => {
  const h = harness(t);
  const record = core.validateQuarantine({
    repository: "X", suite: "unit", testId: "test-a", owner: "o", reason: "journaled but absent",
    createdAt: "2025-12-31T00:00:00Z", expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7,
  });
  h.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE, quarantine: { store: "evidence/observations", ...record } } });
  assert.throws(() => h.observe(["quarantine", "--repo", "X", "--suite", "unit", "--test-id", "test-b", "--owner", "o",
    "--reason", "should refuse", "--created-at", "2026-01-01T00:00:00Z", "--expires-at", "2026-01-02T00:00:00Z", "--max-age-days", "1"]),
  /digest-mismatch: journaled quarantine .* is missing from the store/);
  assert.equal(fs.existsSync(path.join(h.storeRoot, "quarantines")), false, "receipt validation precedes the first write");
  assert.equal(h.events.filter((event) => event.details.event_type === observation.QUARANTINE_EVENT_TYPE).length, 1);
});

test("quarantine receipts for another store do not contaminate the local series", (t) => {
  const h = harness(t);
  const record = core.validateQuarantine({ repository: "X", suite: "unit", testId: "test-a", owner: "o", reason: "other store",
    createdAt: "2025-12-31T00:00:00Z", expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7 });
  h.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE, quarantine: { store: "another/store", ...record } } });

  const series = h.observe(["series"]);
  assert.deepEqual(series.suites, []);
  assert.equal(h.output.length, 1, "the unrelated valid receipt does not refuse local derivation");
});

test("a stored quarantine whose canonical record differs from its receipt fails closed", (t) => {
  // With the real verifier, changing any record field also changes its ID.
  // Bypass only that primitive here to exercise the journal-vs-store equality
  // guard against a malformed or otherwise untrusted injected core.
  const testCore = { ...core, verifyQuarantine: (record) => record };
  const h = harness(t, { core: testCore });
  const stored = core.validateQuarantine({ repository: "X", suite: "unit", testId: "test-a", owner: "o", reason: "stored",
    createdAt: "2025-12-31T00:00:00Z", expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7 });
  observation.createObservationStore({ root: h.storeRoot, core: testCore }).recordQuarantine(stored);
  h.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE,
    quarantine: { store: "evidence/observations", ...stored, reason: "receipt differs" } } });

  assert.throws(() => h.observe(["series"]), /does not match its journal receipt/);
  assert.equal(h.output.length, 0, "no series is exposed after the mismatch");
});

test("malformed quarantine receipts and invalid quarantine digests fail closed", (t) => {
  const malformed = harness(t);
  malformed.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE, quarantine: null } });
  assert.throws(() => malformed.observe(["series"]), /journaled quarantine receipt is malformed/);

  const invalidId = harness(t);
  invalidId.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE, quarantine: { store: "evidence/observations", quarantine_id: "bad" } } });
  assert.throws(() => invalidId.observe(["series"]), /has an invalid quarantine_id/);

  const changed = harness(t);
  const record = core.validateQuarantine({ repository: "X", suite: "unit", testId: "test-a", owner: "o", reason: "original",
    createdAt: "2025-12-31T00:00:00Z", expiresAt: "2026-01-05T00:00:00Z", maxAgeDays: 7 });
  changed.events.push({ details: { event_type: observation.QUARANTINE_EVENT_TYPE,
    quarantine: { store: "evidence/observations", ...record, reason: "changed after receipt" } } });
  assert.throws(() => changed.observe(["series"]), /does not match its quarantine_id/);
});

test("conflicting duplicate quarantine receipts fail closed", (t) => {
  const testCore = { ...core, verifyQuarantine: () => {} };
  const h = harness(t, { core: testCore });
  const sharedId = "a".repeat(64);
  h.events.push(
    { details: { event_type: observation.QUARANTINE_EVENT_TYPE,
      quarantine: { store: "evidence/observations", quarantine_id: sharedId, reason: "first" } } },
    { details: { event_type: observation.QUARANTINE_EVENT_TYPE,
      quarantine: { store: "evidence/observations", quarantine_id: sharedId, reason: "second" } } },
  );
  assert.throws(() => h.observe(["series"]), /conflicting receipt records/);
});

test("a skipped first-quarantine callback cannot create an unjournaled masking record", (t) => {
  const h = harness(t);
  h.skipMutationOnce();
  assert.throws(() => h.observe(["quarantine", "--repo", "X", "--suite", "unit", "--test-id", "test-a", "--owner", "o",
    "--reason", "should not be applied", "--created-at", "2026-01-01T00:00:00Z", "--expires-at", "2026-01-02T00:00:00Z", "--max-age-days", "1"]),
  /idempotent quarantine .* has no existing journaled record to replay/);
  assert.equal(fs.existsSync(path.join(h.storeRoot, "quarantines")), false);
  assert.equal(fs.existsSync(path.join(h.storeRoot, "series.json")), false);
  assert.equal(h.events.length, 0);
});

test("observe argument parsing refuses unknown subcommands, flags, positionals and missing values", (t) => {
  const h = harness(t);
  assert.throws(() => h.observe([]), /unknown subcommand undefined/);
  assert.throws(() => h.observe(["publish"]), /unknown subcommand "publish"/);
  assert.throws(() => h.observe(["ingest", "--bogus", "x"]), /unexpected argument "--bogus"/);
  assert.throws(() => h.observe(["ingest", "stray"]), /unexpected argument "stray"/);
  assert.throws(() => h.observe(["ingest", "--format"]), /--format requires a value/);
  assert.throws(() => h.observe(["ingest", "--format", "--report"]), /--format requires a value/);
  assert.throws(() => h.observe(["ingest", "--format", "jest-json"]), /requires --format and --report/);
  assert.equal(h.events.length, 0);
});

test("programming errors inside ingestion propagate instead of being filed as input refusals", (t) => {
  const broken = { ...core, normalizeRun: () => { throw new TypeError("bug"); } };
  const h = harness(t, { core: broken });
  assert.throws(() => h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]])))), TypeError);
  assert.equal(h.events.length, 0);
});

test("an idempotent journal replay still reports the stored artifact", (t) => {
  const h = harness(t);
  const report = h.write("one.json", jest([["a", "passed"]]));
  const original = h.observe(h.ingestArgs(report));
  assert.equal(original.status, "created");
  h.skipMutationOnce(); // models the real wrapper skipping an already-journaled idempotency key
  const replay = h.observe(h.ingestArgs(report));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.artifact_digest, original.artifact_digest);
  const quarantined = h.observe(["quarantine", "--repo", "X", "--suite", "unit", "--test-id", "t", "--owner", "o", "--reason", "r",
    "--created-at", "2026-01-01T00:00:00Z", "--expires-at", "2026-01-02T00:00:00Z", "--max-age-days", "1"]);
  assert.equal(quarantined.status, "created");
});

test("a skipped first-ingest callback cannot create an artifact without its journal receipt", (t) => {
  const h = harness(t);
  h.skipMutationOnce();
  assert.throws(() => h.observe(h.ingestArgs(h.write("one.json", jest([["a", "passed"]])))),
    /idempotent ingestion .* has no existing journaled artifact to replay/);
  assert.equal(fs.existsSync(path.join(h.storeRoot, "attempts")), false, "no attempt claim is created");
  assert.equal(fs.existsSync(path.join(h.storeRoot, "runs")), false, "no run artifact is created");
  assert.equal(fs.existsSync(path.join(h.storeRoot, "series.json")), false, "no unreceipted series is created");
  assert.equal(h.events.filter((event) => event.details.event_type === observation.INGEST_EVENT_TYPE).length, 0);
});

// --- mutation tests --------------------------------------------------------------------------

// Compile a mutant of a real engine module under a sibling filename that does
// not exist on disk, so relative requires resolve exactly as in production but
// the coverage census (which only measures on-disk production files) ignores it.
function loadMutant(realPath, replacements) {
  let source = fs.readFileSync(realPath, "utf8");
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `mutation anchor must occur exactly once: ${from}`);
    source = source.replace(from, to);
  }
  const filename = realPath.replace(/\.js$/, ".mutant.js");
  const mutant = new Module(filename, module);
  mutant.filename = filename;
  mutant.paths = Module._nodeModulePaths(path.dirname(filename));
  mutant._compile(source, filename);
  return mutant.exports;
}

// The kill suite runs the REAL ingest-to-series path (verb -> store -> core ->
// journal seam) and returns the names of the guarantees that held.
function killSuite(t, { coreModule = core, storeModule = observation } = {}) {
  const failures = [];
  const guard = (name, fn) => {
    try {
      fn();
    } catch (error) {
      failures.push(`${name}: ${error.message.split("\n")[0]}`);
    }
  };
  const base = tempDir(t);
  const events = [];
  const { observe } = storeModule.createObservationCommands({
    fail: (message) => { throw new FakeGovernanceError(message); },
    withGovernanceMutation: (metadata, fn) => {
      if (events.some((event) => event.key === metadata.idempotencyKey)) return undefined;
      const result = fn();
      events.push({ key: metadata.idempotencyKey, details: metadata.details });
      return result;
    },
    readGovernanceEventLog: () => events,
    ensureCurrentAgentIdentity: () => null,
    runtimeState: { RUNTIME_DIR: path.join(base, ".runtime") },
    now: () => "2026-01-01T00:00:00.000Z",
    log: () => {},
    core: coreModule,
  });
  const write = (name, text) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const args = (report, extra = []) => ["ingest", "--format", "jest-json", "--report", report, "--repo", "X", "--suite", "unit", "--commit", SHA, "--runtime", "node-22", ...extra];
  guard("absent measurement is refused as non-passing", () => {
    assert.throws(() => observe(args(path.join(base, "missing.json"), ["--expect-measurement", "--attempt", "7"])), /expected but absent/);
    assert.equal(events.at(-1).details.observation.passing_evidence, false);
  });
  guard("tampered artifact is refused on replay", () => {
    const stored = observe(args(write("pass.json", jest([["a", "passed"]])), ["--attempt", "1"]));
    const file = path.join(base, "evidence", "observations", stored.artifact_path);
    const bytes = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, bytes.replace("\"passed\"", "\"failed\""));
    try {
      assert.throws(() => observe(["replay", "--check"]), /does not match recomputed/);
    } finally {
      fs.writeFileSync(file, bytes);
    }
  });
  guard("a second payload for one attempt is refused", () => {
    assert.throws(() => observe(args(write("clash.json", jest([["a", "failed"]])), ["--attempt", "1"])), /attempt-conflict/);
  });
  guard("cancelled runs never enter a flake denominator", () => {
    observe(args(write("cancel.json", jest([["a", "failed"]], { wasInterrupted: true })), ["--attempt", "2"]));
    const unit = observe(["series"]).suites[0];
    assert.deepEqual(unit.tests.find((entry) => entry.name_path.at(-1) === "a").flake.evaluated_groups, 0);
  });
  guard("forged provenance is refused against the journal digest", () => {
    const dir = path.join(base, "evidence", "observations", "runs");
    const [name] = fs.readdirSync(dir).filter((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")).content.run_status === "completed");
    const file = path.join(dir, name);
    const bytes = fs.readFileSync(file, "utf8");
    const forged = JSON.parse(bytes);
    forged.provenance.ingested_at = "2020-01-01T00:00:00.000Z";
    fs.writeFileSync(file, coreModule.artifactBytes(forged));
    try {
      assert.throws(() => observe(["replay", "--check"]), /journaled digest/);
    } finally {
      fs.writeFileSync(file, bytes);
    }
  });
  return failures;
}

const CORE_PATH = require.resolve("./quality-observation.js");
const STORE_PATH = require.resolve("./quality-observation-store.js");

test("mutation: the unmutated ingest-to-series path satisfies every kill-suite guarantee", (t) => {
  assert.deepEqual(killSuite(t), []);
});

test("mutation: every load-bearing guard in the real wiring is killed by the kill suite", (t) => {
  const mutants = [
    { name: "digest verification disabled", module: "core",
      replacements: [["if (recomputed !== artifact.content_digest) {", "if (false) {"]] },
    { name: "absent measurement classified as completed", module: "core",
      replacements: [["  if (measurement.reason !== null) return measurement.reason;\n", ""]] },
    { name: "comparable-attempt filter ignores run status", module: "core",
      replacements: [["if (observation.run_status !== \"completed\" || (", "if (("]] },
    { name: "attempt claim conflict ignored", module: "store",
      replacements: [["      if (claimed !== artifact.content_digest) {", "      if (false) {"]] },
    { name: "journal artifact digest cross-check removed", module: "store",
      replacements: [["    else if (entry.artifact_digest !== artifactDigest) problems.push", "    else if (false) problems.push"]] },
    { name: "absent measurement exits zero", module: "store",
      replacements: [["    if (result.run_status === \"measurement-expected-but-absent\") {", "    if (false) {"]] },
  ];
  for (const mutant of mutants) {
    let failures;
    if (mutant.module === "core") {
      const mutantCore = loadMutant(CORE_PATH, mutant.replacements);
      failures = killSuite(t, { coreModule: mutantCore });
    } else {
      failures = killSuite(t, { storeModule: loadMutant(STORE_PATH, mutant.replacements) });
    }
    assert.ok(failures.length > 0, `mutant survived: ${mutant.name}`);
  }
});
