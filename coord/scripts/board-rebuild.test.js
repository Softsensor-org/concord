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

test("rebuildBoardFromJournal repairs a regressed status row from the journal (GOV-012)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebuild-regressed-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const eventLogPath = path.join(tempDir, "governance-events.ndjson");
  // COORD-024: drift-logging now successfully appends to QUESTIONS.md (the
  // donor carries the ## Instructions anchor), so point QUESTIONS_PATH at a
  // temp file to keep this regression test from polluting the live log.
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");

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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;

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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;

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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;

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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;

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
  }
});
