"use strict";

// COORD-710: production-path wiring of `gov observe` through the real CLI
// dispatcher, the real governance mutation wrapper and the real hash-chained
// journal (all relocated to a per-test sandbox).
require("./governance-test-utils.js").sandboxProcessRuntime();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { executeCommand, __testing } = require("./governance.js");
const { withScopedGovernanceTestContext } = require("./governance-test-utils.js");
const { buildHelpText } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/lifecycle-help.js"))({});
const core = require("../engine/scripts/quality-observation.js");

const FIXTURES = path.join(__dirname, "..", "engine", "scripts", "fixtures", "quality-observation");
const SHA = "a".repeat(40);
const BOARD = {
  metadata: { title: "Observation Test Board" },
  sections: [{ rows: [{ ID: "C-001", Repo: "X", Status: "doing", Owner: "concord1", Description: "observation ticket" }] }],
};
function withObservationSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord710-cli-"));
  const runtimeDir = path.join(root, ".runtime");
  fs.mkdirSync(path.join(runtimeDir, "locks"), { recursive: true });
  const boardPath = path.join(root, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(BOARD, null, 2));
  const paths = {
    BOARD_PATH: boardPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    LOCKS_DIR: path.join(runtimeDir, "locks"),
  };
  return withScopedGovernanceTestContext(paths, () => {
    try {
      __testing.ensureGovernanceJournalBaseline("COORD-710 observation fixture");
      const journal = () => fs.readFileSync(paths.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return fn({ root, store: path.join(root, "evidence", "observations"), journal });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

function ingest(report, extra = []) {
  return executeCommand(["observe", "ingest", "--format", "node-test-tap", "--report", report, "--repo", "X", "--suite", "unit",
    "--commit", SHA, "--runtime", "node-22/linux-x64", ...extra]);
}

test("COORD-710: gov observe ingest persists a normalized artifact linked to one hash-chained journal receipt", () => {
  withObservationSandbox(({ store, journal }) => {
    const before = journal().length;
    const result = ingest(path.join(FIXTURES, "node22-basic.tap"), ["--ticket", "C-001"]);
    assert.equal(result.ok, true, result.error);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "created");
    assert.equal(payload.store, "evidence/observations", "the default store sits beside the redirected runtime, never the live tree");
    const golden = core.normalizeRun({ format: "node-test-tap", text: fs.readFileSync(path.join(FIXTURES, "node22-basic.tap"), "utf8"),
      repository: "X", suite: "unit", commitSha: SHA, runtime: "node-22/linux-x64", ingestedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(payload.content_digest, golden.content_digest, "the CLI path normalizes exactly as the conformance contract does");
    assert.equal(payload.passing_evidence, false, "a run with a failing test is not passing evidence");
    const events = journal().slice(before);
    assert.equal(events.length, 1, "one compact event per ingestion, never one per test case");
    const [event] = events;
    assert.equal(event.command, "observe-ingest");
    assert.equal(event.ticket, "C-001");
    assert.equal(event.result, "succeeded");
    assert.equal(event.details.event_type, "quality.observation_ingested");
    assert.equal(event.details.idempotency_key, `observe-ingest:evidence/observations:${payload.content_digest}`);
    const stored = fs.readFileSync(path.join(store, event.details.observation.artifact_path), "utf8");
    assert.equal(core.sha256Hex(stored), event.details.observation.artifact_digest, "journal receipt and artifact are linked by digest");
    assert.equal(core.verifyArtifact(JSON.parse(stored)).content_digest, event.details.observation.content_digest);
    assert.equal(__testing.verifyGovernanceChain().ok, true, "the observation event extends the hash chain");

    const repeat = ingest(path.join(FIXTURES, "node24-basic.tap"));
    assert.equal(repeat.ok, true, repeat.error);
    assert.equal(JSON.parse(repeat.stdout).status, "duplicate", "node 24 delivery of the same run content is the same observation");
    assert.equal(journal().length, before + 1, "repeated delivery appends nothing");

    const replay = executeCommand(["observe", "replay", "--check"]);
    assert.equal(replay.ok, true, replay.error);
    assert.equal(JSON.parse(replay.stdout).journal_events_verified, 1);
    assert.equal(JSON.parse(replay.stdout).stored_series_matched, true);
  });
});

test("COORD-710: refusals and absent measurements are journaled once and exit non-zero through the CLI", () => {
  withObservationSandbox(({ root, journal }) => {
    const before = journal().length;
    const truncated = ingest(path.join(FIXTURES, "node22-truncated.tap"));
    assert.equal(truncated.ok, false);
    assert.match(truncated.error, /refused \(truncated: TAP diagnostic block/);
    const absent = ingest(path.join(root, "never-written.tap"), ["--expect-measurement"]);
    assert.equal(absent.ok, false);
    assert.match(absent.error, /measurement was expected but absent/);
    const events = journal().slice(before);
    assert.deepEqual(events.map((event) => event.details.event_type), ["quality.observation_rejected", "quality.observation_ingested"]);
    assert.equal(events[1].details.observation.passing_evidence, false);
    assert.equal(events[1].details.observation.run_status, "measurement-expected-but-absent");
    assert.equal(__testing.verifyGovernanceChain().ok, true);
  });
});

test("COORD-710: gov observe is listed in the CLI help", () => {
  assert.match(buildHelpText(), /coord\/scripts\/gov observe ingest --format/);
  const unknown = executeCommand(["observe", "nope"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown subcommand "nope"/);
});

test("COORD-710: journal-bound provenance is checked by series and subsequent ingestion", () => {
  withObservationSandbox(({ store, journal }) => {
    const report = path.join(FIXTURES, "node22-basic.tap");
    const first = ingest(report);
    assert.equal(first.ok, true, first.error);
    const receipt = JSON.parse(first.stdout);
    const artifactPath = path.join(store, receipt.artifact_path);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    artifact.provenance.ingested_at = "2030-01-01T00:00:00.000Z";
    fs.writeFileSync(artifactPath, core.artifactBytes(artifact));
    const beforeRuns = fs.readdirSync(path.join(store, "runs"));
    const beforeSeries = fs.readFileSync(path.join(store, "series.json"), "utf8");
    const beforeIngests = journal().filter((event) => event.command === "observe-ingest").length;

    const series = executeCommand(["observe", "series"]);
    assert.equal(series.ok, false);
    assert.match(series.error, /digest-mismatch|journaled digest/);
    const next = ingest(report, ["--attempt", "2"]);
    assert.equal(next.ok, false);
    assert.match(next.error, /digest-mismatch|journaled digest/);
    assert.deepEqual(fs.readdirSync(path.join(store, "runs")), beforeRuns);
    assert.equal(fs.readFileSync(path.join(store, "series.json"), "utf8"), beforeSeries);
    assert.equal(journal().filter((event) => event.command === "observe-ingest").length, beforeIngests);
    assert.equal(__testing.verifyGovernanceChain().ok, true);
  });
});

test("COORD-710: malformed passing runner metadata produces only a rejection receipt", () => {
  withObservationSandbox(({ root, journal }) => {
    const report = path.join(root, "malformed-jest.json");
    fs.writeFileSync(report, JSON.stringify({ numTotalTests: 0, testResults: [{ name: "a.test.js", assertionResults: [
      { ancestorTitles: ["suite"], title: "passes", status: "passed", duration: 1 },
    ] }] }));
    const before = journal().length;
    const result = executeCommand(["observe", "ingest", "--format", "jest-json", "--report", report,
      "--repo", "X", "--suite", "unit", "--commit", SHA, "--runtime", "node-22/linux-x64"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /malformed|inconsistent/);
    assert.deepEqual(journal().slice(before).map((event) => event.details.event_type), ["quality.observation_rejected"]);
    assert.equal(__testing.verifyGovernanceChain().ok, true);
  });
});
