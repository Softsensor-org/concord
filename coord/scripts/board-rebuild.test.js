"use strict";

// COORD-091 (Wave 4 residual): behavior tests for the board-rebuild-from-journal
// surface (board-rebuild.js) — the rebuildBoardFromJournal /
// terminalJournalStatusForTicket / collectTicketsWithJournalDrift assertions
// relocated out of governance.test.js when the journal-replay repair layer was
// extracted from lifecycle.js. They reach the surface through the stable
// governance.js __testing facade (which re-exports the createBoardRebuild
// factory bindings) and drive it via the temp BOARD_PATH /
// GOVERNANCE_EVENT_LOG_PATH / QUESTIONS_PATH override seam, preserving the
// public test contract while co-locating the deep behavior coverage with the
// module it exercises (GOV-012).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;
const { withGovernedSurfaceSandbox, sandboxProcessRuntime } = require("./governance-test-utils.js");

// COORD-300: some tests below use a thin inline sandbox that rebinds RUNTIME_DIR /
// BOARD but NOT the agent registry, coarse locks, or plan-records dir, so their
// governed mutations wrote the LIVE coord/.runtime tree. Redirect the full runtime
// surface to a per-process os.tmpdir() sandbox so those stray writes land in tmp,
// letting board-rebuild.test.js leave the test-isolation-guard allowlist.
sandboxProcessRuntime();

// COORD-271: shared single-row board factory for the seal-opt-out coverage below.
function coord271BoardWithRow(status, owner) {
  return {
    version: 1,
    metadata: { title: "COORD-271 test board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-271 Regression",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: "MSRV-132", Repo: "B", Type: "feature", Pri: "P1", Status: status, Owner: owner, Description: "x", "Depends On": "" },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
}

function withTempSnapshotPaths(tempDir) {
  const runtimeDir = path.join(tempDir, ".runtime");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  // COORD-251: rebuildBoardFromJournal runs inside withGovernanceMutation, which
  // acquires the governance runtime lock at GOVERNANCE_EVENT_LOCK_DIR (an
  // absolute default, independent of RUNTIME_DIR). These tests rebound BOARD /
  // event-log / snapshot paths but NOT the runtime dir or lock dir, so every
  // rebuild here mkdir'd the LIVE coord/.runtime/governance.lock and serialized
  // against the rest of the parallel suite (intermittent 30s timeouts). Hand the
  // caller the sandbox runtime + lock dir so the mutation locks the throwaway
  // .runtime instead.
  const lockDir = path.join(runtimeDir, "governance.lock");
  return { snapshotPath, snapshotsDir, runtimeDir, lockDir };
}

function seedLatestSnapshot(snapshotPath, snapshotsDir) {
  const snapshot = __testing.buildGovernanceSnapshot();
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotsDir, `${snapshot.digest}.json`),
    JSON.stringify(snapshot, null, 2)
  );
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      digest: snapshot.digest,
      recorded_at: snapshot.recorded_at || null,
      ts: new Date().toISOString(),
      command: "test-baseline",
      ticket: null,
    }, null, 2)
  );
  return snapshot;
}

test("rebuildBoardFromJournal repairs a regressed status row from the journal (GOV-012)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebuild-regressed-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const eventLogPath = path.join(tempDir, "governance-events.ndjson");
  // COORD-024: drift-logging now successfully appends to QUESTIONS.md (the
  // donor carries the ## Instructions anchor), so point QUESTIONS_PATH at a
  // temp file to keep this regression test from polluting the live log.
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const { snapshotPath, snapshotsDir, runtimeDir, lockDir } = withTempSnapshotPaths(tempDir);

  // Board has MSRV-132 stuck at todo; journal says it landed to done 5 minutes ago.
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "MSRV-132", Repo: "B", Type: "feature", Pri: "P1", Status: "todo", Owner: "unassigned", Description: "x", "Depends On": "" },
        ],
      },
    ],
  }, null, 2));
  const land_ts = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(eventLogPath,
    `${JSON.stringify({ ts: new Date(Date.now() - 20 * 60 * 1000).toISOString(), command: "journal-baseline", ticket: null, after_status: null, snapshot_digest: "deadbeef" })}\n` +
    `${JSON.stringify({ ts: new Date(Date.now() - 15 * 60 * 1000).toISOString(), command: "start-ticket", ticket: "MSRV-132", before_status: "todo", after_status: "doing", result: "succeeded", identity: { owner: "claudea62" } })}\n` +
    `${JSON.stringify({ ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), command: "move-review", ticket: "MSRV-132", before_status: "doing", after_status: "review", result: "succeeded", identity: { owner: "claudea62" } })}\n` +
    `${JSON.stringify({ ts: land_ts, command: "land", ticket: "MSRV-132", before_status: "review", after_status: "done", result: "succeeded", identity: { owner: "claudea62" } })}\n`
  );

  // COORD-290: sandbox the prompt + rendered surfaces — rebuild re-renders the
  // board, which otherwise wrote under the live coord/prompts + coord/rendered.
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;
  seedLatestSnapshot(snapshotPath, snapshotsDir);

  const stdoutLines = [];
  const originalLog = console.log;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };

  try {
    __testing.rebuildBoardFromJournal("MSRV-132");

    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const row = boardAfter.sections[0].rows[0];
    assert.equal(row.Status, "done", "status must be repaired from journal terminal event");
    assert.equal(row.Owner, "claudea62", "owner must be repaired from journal identity");

    const output = JSON.parse(stdoutLines.join("\n"));
    assert.equal(output.repaired.length, 1);
    assert.equal(output.repaired[0].ticket, "MSRV-132");
    assert.equal(output.repaired[0].before.Status, "todo");
    assert.equal(output.repaired[0].after.Status, "done");
    assert.equal(output.repaired[0].journal_event_command, "land");
  } finally {
    console.log = originalLog;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("rebuildBoardFromJournal is idempotent — second run reports no drift (GOV-012)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebuild-idempotent-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const eventLogPath = path.join(tempDir, "governance-events.ndjson");

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "MSRV-132", Repo: "B", Type: "feature", Pri: "P1", Status: "done", Owner: "claudea62", Description: "x", "Depends On": "" },
        ],
      },
    ],
  }, null, 2));
  fs.writeFileSync(eventLogPath,
    `${JSON.stringify({ ts: new Date().toISOString(), command: "journal-baseline", ticket: null, after_status: null, snapshot_digest: "deadbeef" })}\n` +
    `${JSON.stringify({ ts: new Date().toISOString(), command: "land", ticket: "MSRV-132", before_status: "review", after_status: "done", result: "succeeded", identity: { owner: "claudea62" } })}\n`
  );
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const { snapshotPath, snapshotsDir, runtimeDir, lockDir } = withTempSnapshotPaths(tempDir);

  // COORD-290: sandbox the prompt + rendered surfaces — rebuild re-renders the
  // board, which otherwise wrote under the live coord/prompts + coord/rendered.
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;
  seedLatestSnapshot(snapshotPath, snapshotsDir);

  const stdoutLines = [];
  const originalLog = console.log;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };

  try {
    __testing.rebuildBoardFromJournal("MSRV-132");
    const output = JSON.parse(stdoutLines.join("\n"));
    assert.equal(output.repaired.length, 0, "no repair needed when board already matches journal");
    assert.equal(output.unchanged.length, 1, "row reported as unchanged");
    assert.equal(output.unchanged[0].ticket, "MSRV-132");
  } finally {
    console.log = originalLog;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("rebuildBoardFromJournal fails with a clear error when the row is missing from board/tasks.json (GOV-012)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebuild-missing-row-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const eventLogPath = path.join(tempDir, "governance-events.ndjson");

  // Board has no row for MSRV-134; journal has an open-followup event for it.
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [] }] }, null, 2));
  fs.writeFileSync(eventLogPath,
    `${JSON.stringify({ ts: new Date().toISOString(), command: "journal-baseline", ticket: null, after_status: null, snapshot_digest: "deadbeef" })}\n` +
    `${JSON.stringify({ ts: new Date().toISOString(), command: "open-followup", ticket: "MSRV-134", before_status: null, after_status: "todo", result: "succeeded", identity: null })}\n`
  );
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const { snapshotPath, snapshotsDir, runtimeDir, lockDir } = withTempSnapshotPaths(tempDir);

  // COORD-290: sandbox the prompt + rendered surfaces — rebuild re-renders the
  // board, which otherwise wrote under the live coord/prompts + coord/rendered.
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;
  seedLatestSnapshot(snapshotPath, snapshotsDir);

  try {
    assert.throws(
      () => __testing.rebuildBoardFromJournal("MSRV-134"),
      /row is missing from board\/tasks\.json.*the journal alone does not carry the original repo\/type\/pri\/description metadata/,
      "must fail with a clear message about the journal's metadata limitation"
    );
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("rebuildBoardFromJournal --all repairs every regressed row best-effort (GOV-012)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebuild-all-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const eventLogPath = path.join(tempDir, "governance-events.ndjson");

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "MSRV-132", Repo: "B", Type: "feature", Pri: "P1", Status: "todo", Owner: "unassigned", Description: "x", "Depends On": "" },
          { ID: "RBAC-010", Repo: "B", Type: "feature", Pri: "P1", Status: "todo", Owner: "unassigned", Description: "y", "Depends On": "" },
          { ID: "FE-200", Repo: "F", Type: "bug", Pri: "P2", Status: "doing", Owner: "claudea60", Description: "z", "Depends On": "" },
        ],
      },
    ],
  }, null, 2));
  const now = new Date().toISOString();
  fs.writeFileSync(eventLogPath,
    `${JSON.stringify({ ts: now, command: "journal-baseline", ticket: null, after_status: null, snapshot_digest: "deadbeef" })}\n` +
    `${JSON.stringify({ ts: now, command: "land", ticket: "MSRV-132", before_status: "review", after_status: "done", result: "succeeded", identity: { owner: "claudea62" } })}\n` +
    `${JSON.stringify({ ts: now, command: "land", ticket: "RBAC-010", before_status: "review", after_status: "done", result: "succeeded", identity: { owner: "codexa00" } })}\n` +
    `${JSON.stringify({ ts: now, command: "start-ticket", ticket: "FE-200", before_status: "todo", after_status: "doing", result: "succeeded", identity: { owner: "claudea60" } })}\n`
  );
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const { snapshotPath, snapshotsDir, runtimeDir, lockDir } = withTempSnapshotPaths(tempDir);

  // COORD-290: sandbox the prompt + rendered surfaces — rebuild re-renders the
  // board, which otherwise wrote under the live coord/prompts + coord/rendered.
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;
  seedLatestSnapshot(snapshotPath, snapshotsDir);

  const stdoutLines = [];
  const originalLog = console.log;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };

  try {
    __testing.rebuildBoardFromJournal(null, { all: true });

    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const rows = Object.fromEntries(boardAfter.sections[0].rows.map((r) => [r.ID, r]));
    assert.equal(rows["MSRV-132"].Status, "done");
    assert.equal(rows["RBAC-010"].Status, "done");
    // FE-200 was already matching the journal (doing) — not repaired.
    assert.equal(rows["FE-200"].Status, "doing");
    assert.equal(rows["FE-200"].Owner, "claudea60");

    const output = JSON.parse(stdoutLines.join("\n"));
    assert.equal(output.mode, "all");
    assert.equal(output.repaired.length, 2, "two rows repaired (MSRV-132, RBAC-010)");
  } finally {
    console.log = originalLog;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

// --- COORD-271: the recovery/agent opt-out flag must be the spelling the seal +
// drift-question consumer (journal.js) actually reads (`allowProvenanceDrift`).
// Before the fix these sites set the misspelled `allowRecoverableProvenanceDrift`,
// which the consumer never reads — so the opt-out was DEAD: `gov rebuild-board`
// (a recovery verb for a board that drifted out of band from the journal) failed
// CLOSED on the COORD-220 seal at the exact moment it was needed, and the agent
// verbs lost their drift-question suppression. -----------------------------------

test("COORD-271: rebuildBoardFromJournal recovers an out-of-band drifted board through the allowProvenanceDrift seal opt-out", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    // Board + journal agree the ticket landed to done; baseline the journal at
    // that clean state. Every event carries a snapshot so the latest event is a
    // valid snapshot source (the seal/detector compares against it).
    fs.writeFileSync(boardPath, JSON.stringify(coord271BoardWithRow("done", "claudea62"), null, 2), "utf8");
    __testing.appendGovernanceEvent({
      ts: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      command: "journal-baseline",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      details: { reason: "coord271-test" },
      changed_paths: [],
      snapshot: __testing.buildGovernanceSnapshot(),
    });
    __testing.appendGovernanceEvent({
      ts: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      command: "land",
      ticket: "MSRV-132",
      before_status: "review",
      after_status: "done",
      identity: { owner: "claudea62" },
      result: "succeeded",
      changed_paths: [],
      snapshot: __testing.buildGovernanceSnapshot(),
    });

    // An out-of-band edit regresses the board row to todo — the recovery scenario
    // rebuild-board exists to repair.
    fs.writeFileSync(boardPath, JSON.stringify(coord271BoardWithRow("todo", "unassigned"), null, 2), "utf8");

    // The COORD-220 seal WOULD refuse any plain governed mutation now: the board
    // drifted from the journal baseline (this is the seal's precondition).
    assert.equal(
      __testing.detectOutOfBandBoardMutation().detected,
      true,
      "out-of-band board drift must be detected — without the opt-out the seal refuses the mutation"
    );

    // rebuild-board is a recovery verb: its allowProvenanceDrift opt-out must let
    // it run and repair the row, instead of failing closed on the very drift it
    // is supposed to repair.
    const stdoutLines = [];
    const originalLog = console.log;
    console.log = (...args) => { stdoutLines.push(args.join(" ")); };
    try {
      assert.doesNotThrow(
        () => __testing.rebuildBoardFromJournal("MSRV-132"),
        "rebuild-board must NOT fail closed on the out-of-band drift it repairs"
      );
    } finally {
      console.log = originalLog;
    }

    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(boardAfter.sections[0].rows[0].Status, "done", "row repaired from journal terminal status");
    assert.equal(boardAfter.sections[0].rows[0].Owner, "claudea62", "owner repaired from journal identity");
    const output = JSON.parse(stdoutLines.join("\n"));
    assert.equal(output.repaired.length, 1);
    assert.equal(output.repaired[0].ticket, "MSRV-132");
    assert.equal(output.repaired[0].after.Status, "done");
  });
});

test("COORD-271: the recovery/agent allowProvenanceDrift opt-out suppresses the spurious provenance-drift QUESTIONS note", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    // Clean baseline.
    fs.writeFileSync(boardPath, JSON.stringify(coord271BoardWithRow("todo", "unassigned"), null, 2), "utf8");
    __testing.appendGovernanceEvent({
      ts: new Date().toISOString(),
      command: "journal-baseline",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      details: { reason: "coord271-test" },
      changed_paths: [],
      snapshot: __testing.buildGovernanceSnapshot(),
    });

    // Pre-existing NON-coordination tracked drift (PLAN.md): it reaches the
    // drift-question but is NOT a coordination-state class, so the COORD-220 seal
    // stays out of the way. This isolates the drift-question suppression — the
    // exact behavior the agent verbs (claim/agent-release/agent-rebind) rely on
    // when they legitimately operate on session state.
    fs.writeFileSync(__testing.paths.PLAN_PATH, "plan drifted out of band\n", "utf8");
    assert.equal(
      __testing.detectOutOfBandBoardMutation().detected,
      false,
      "PLAN.md drift is not coordination-state: the seal must not short-circuit the drift-question check"
    );

    const questionsBefore = fs.readFileSync(__testing.paths.QUESTIONS_PATH, "utf8");

    // An agent/recovery verb opts out via the correct flag: NO spurious drift note.
    __testing.withGovernanceMutation(
      { command: "agent-release", ticket: null, allowProvenanceDrift: true },
      () => {}
    );
    assert.equal(
      fs.readFileSync(__testing.paths.QUESTIONS_PATH, "utf8"),
      questionsBefore,
      "allowProvenanceDrift must suppress the drift QUESTIONS note"
    );

    // Control: the SAME mutation carrying ONLY the dead misspelled flag does NOT
    // suppress the note — proving the consumer honors only the correct spelling,
    // i.e. the rename is load-bearing. Re-introduce drift first (the successful
    // opt-out mutation advanced the baseline, absorbing the earlier PLAN.md edit).
    fs.writeFileSync(__testing.paths.PLAN_PATH, "plan drifted again out of band\n", "utf8");
    __testing.withGovernanceMutation(
      { command: "agent-release", ticket: null, allowRecoverableProvenanceDrift: true },
      () => {}
    );
    assert.match(
      fs.readFileSync(__testing.paths.QUESTIONS_PATH, "utf8"),
      /Governance drift observed while running/,
      "the misspelled flag is dead: with it the drift note is NOT suppressed"
    );
  });
});

test("COORD-271: recovery and agent mutation sites use the correct allowProvenanceDrift flag (no misspelling)", () => {
  for (const file of ["agent-commands.js", "board-rebuild.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(
      !/allowRecoverableProvenanceDrift/.test(src),
      `${file} must not reintroduce the dead misspelled opt-out flag`
    );
    assert.match(
      src,
      /allowProvenanceDrift:\s*true/,
      `${file} must opt recovery/agent mutations out via the flag the seal/drift-question consumer actually reads`
    );
  }
});
