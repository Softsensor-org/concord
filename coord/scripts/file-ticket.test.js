"use strict";

// COORD-221: sanctioned low-ceremony ticket-create (`gov file-ticket` / `gov new`).
//
// Covers the differentiators from `open-followup` and the safety guarantees it
// inherits from the COORD-220 transaction primitive:
//   - files a valid todo row through withBoardTransaction with a reserved,
//     non-colliding ID and exactly ONE journal event,
//   - works with NO --prompt and NO --depends-on (the key requirement — neither
//     prompt coverage nor a parent dependency is mandatory),
//   - rejects invalid input and rolls back fully (no partial board state),
//   - rejects a duplicate explicit --id,
//   - the created row round-trips through board.js validate (runBoardSync).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  withGovernedSurfaceSandbox,
} = require("./governance-test-utils.js");

function seedJournalBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-06-24T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "coord221-test" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function writeBacklogBoard(boardPath, rows) {
  const board = {
    version: 1,
    metadata: { title: "COORD-221 test board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-221 Backlog",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows,
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
  fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
}

function row(id, deps = "") {
  return {
    ID: id,
    Repo: "X",
    Type: "chore",
    Pri: "P2",
    Status: "todo",
    Owner: "unassigned",
    Description: `row ${id}`,
    "Depends On": deps,
  };
}

function countEvents(logPath) {
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

function lastEvent(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function promptAbsPath(relPath) {
  return path.resolve(__dirname, "..", "..", relPath);
}

test("COORD-221: file-ticket reserves a non-colliding id and files a valid todo row with NO prompt and NO depends-on", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const before = countEvents(logPath);

    const id = __testing.fileTicket(null, {
      repo: "X",
      type: "feature",
      pri: "P1",
      description: "plain backlog ticket",
    });

    // Reserved off the live board: COORD-001 -> COORD-002, no collision.
    assert.equal(id, "COORD-002");
    assert.equal(countEvents(logPath), before + 1, "exactly one journal event");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const filed = after.sections[0].rows.find((r) => r.ID === "COORD-002");
    assert.ok(filed, "row was filed");
    assert.equal(filed.Status, "todo");
    assert.equal(filed.Owner, "unassigned");
    assert.equal(filed["Depends On"], "", "no forced parent dependency");
    assert.equal(filed.Type, "feature");
    assert.equal(filed.Pri, "P1");
    // No prompt linkage was created (none required).
    assert.equal(after.prompt_index["COORD-002"] ?? undefined, undefined);
  });
});

test("COORD-221: two back-to-back file-ticket calls reserve distinct, non-colliding ids", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const a = __testing.fileTicket(null, { repo: "X", type: "chore", pri: "P2", description: "first" });
    const b = __testing.fileTicket(null, { repo: "X", type: "chore", pri: "P2", description: "second" });

    assert.equal(a, "COORD-002");
    assert.equal(b, "COORD-003");
    assert.notEqual(a, b, "two reservations must not collide");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const ids = after.sections[0].rows.map((r) => r.ID).sort();
    assert.deepEqual(ids, ["COORD-001", "COORD-002", "COORD-003"]);
  });
});

test("COORD-285 CREATE-ACCEPTED: file-ticket --status proposed files a quarantined row that validates", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const before = countEvents(logPath);
    const id = __testing.fileTicket(null, {
      repo: "X",
      type: "chore",
      pri: "P2",
      status: "proposed",
      description: "machine-proposed debt awaiting human triage",
    });

    assert.equal(id, "COORD-002");
    assert.equal(countEvents(logPath), before + 1, "exactly one journal event");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const filed = after.sections[0].rows.find((r) => r.ID === "COORD-002");
    assert.ok(filed, "proposed row was filed");
    assert.equal(filed.Status, "proposed", "row is born in the quarantined proposed status");
    // The create transaction runs runBoardSync (board.js validate + schema) before
    // it commits + journals; a successful return (and the appended journal event
    // asserted above) means the proposed row passed board validation.
  });
});

test("COORD-285: file-ticket rejects an unsupported --status (only todo/proposed may be created)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();
    assert.throws(
      () => __testing.fileTicket(null, { repo: "X", type: "chore", pri: "P2", status: "doing", description: "bad status" }),
      (err) => err instanceof GovernanceError && /--status <todo\|proposed>/.test(err.message)
    );
  });
});

test("COORD-221: invalid input fails closed and rolls back — no partial board state", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const boardBefore = fs.readFileSync(boardPath, "utf8");
    const journalBefore = fs.readFileSync(logPath, "utf8");

    assert.throws(
      () => __testing.fileTicket(null, { repo: "X", type: "not-a-type", pri: "P1", description: "bad type" }),
      (err) => err instanceof GovernanceError && /--type/.test(err.message)
    );

    assert.equal(fs.readFileSync(boardPath, "utf8"), boardBefore, "board must be restored on invalid input");
    assert.equal(
      fs.readFileSync(logPath, "utf8"),
      journalBefore,
      "journal must not gain a succeeded event for a rolled-back create"
    );
  });
});

test("COORD-221: missing required fields fails closed", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    assert.throws(
      () => __testing.fileTicket(null, { repo: "X", type: "chore", description: "no pri" }),
      (err) => err instanceof GovernanceError && /--repo, --type, --pri, and --description/.test(err.message)
    );
  });
});

test("COORD-221: a duplicate explicit --id is rejected", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    assert.throws(
      () =>
        __testing.fileTicket("COORD-001", {
          repo: "X",
          type: "chore",
          pri: "P2",
          description: "dup id",
        }),
      (err) => err instanceof GovernanceError && /already exists/.test(err.message)
    );
  });
});

test("COORD-221: explicit --id and optional --depends-on / --prompt are honored", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const id = __testing.fileTicket("COORD-050", {
      repo: "X",
      type: "task",
      pri: "P3",
      description: "explicit id with optional parent + prompt",
      dependsOn: "COORD-001",
      prompt: "coord/prompts/tickets/COORD-050.md",
    });
    assert.equal(id, "COORD-050");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const filed = after.sections[0].rows.find((r) => r.ID === "COORD-050");
    assert.equal(filed["Depends On"], "COORD-001", "optional parent recorded when supplied");
    assert.equal(after.prompt_index["COORD-050"], "coord/prompts/tickets/COORD-050.md");
  });
});

test("COORD-221: a non-existent --depends-on is rejected", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    assert.throws(
      () =>
        __testing.fileTicket(null, {
          repo: "X",
          type: "chore",
          pri: "P2",
          description: "bad parent",
          dependsOn: "COORD-999",
        }),
      (err) => err instanceof GovernanceError && /does not exist/.test(err.message)
    );
  });
});

test("COORD-221: filed row round-trips through board validate (runBoardSync renders without error)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    // If the row were schema-invalid, runBoardSync's validate would throw and the
    // transaction would roll back. A successful, persisted row proves validation.
    __testing.fileTicket(null, { repo: "X", type: "bug", pri: "P0", description: "validate me" });

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.ok(after.sections[0].rows.some((r) => r.ID === "COORD-002" && r.Status === "todo"));
  });
});

test("COORD-350: file-ticket --with-prompt creates prompt file and prompt_index in one journaled mutation", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath, promptsDir }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();
    const promptPath = path.join(promptsDir, "tickets", "COORD-050.md");

    const before = countEvents(logPath);
    const id = __testing.fileTicket("COORD-050", {
      repo: "X",
      type: "feature",
      pri: "P1",
      description: "start-ready ticket",
      withPrompt: true,
      prompt: promptPath,
    });

    assert.equal(id, "COORD-050");
    assert.equal(countEvents(logPath), before + 1, "ticket + prompt should be one governance event");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(after.prompt_index["COORD-050"].endsWith("/prompts/tickets/COORD-050.md"), true);
    assert.equal(fs.existsSync(promptAbsPath(after.prompt_index["COORD-050"])), true, "prompt file was created");

    const event = lastEvent(logPath);
    assert.equal(event.command, "file-ticket");
    assert.equal(event.result, "succeeded");
    assert.ok(
      event.changed_paths.some((p) => String(p).endsWith("/prompts/tickets/COORD-050.md")),
      "journal snapshot includes the created prompt file"
    );
    assert.equal(event.details.prompt.created, true);
  });
});

test("COORD-350: file-ticket without --with-prompt remains low-ceremony and does not create prompt coverage", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const id = __testing.fileTicket("COORD-060", {
      repo: "X",
      type: "chore",
      pri: "P2",
      description: "plain ticket",
    });

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(id, "COORD-060");
    assert.equal(after.prompt_index["COORD-060"] ?? null, null);
  });
});
