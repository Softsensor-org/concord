"use strict";
const { resolveEngineModule } = require("../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..");

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
const governanceCommands = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/lifecycle.js")).commands;
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  executeCommand,
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

    const id = governanceCommands.fileTicket(null, {
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

test("COORD-662: file-ticket reads a bounded UTF-8 description literally into the row and generated prompt", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, []);
    seedJournalBaseline();
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-description-"));
    const inputPath = path.join(inputDir, "description.txt");
    const sentinelPath = path.join(inputDir, "shell-expanded.txt");
    const shellTrigger = `$(printf shell-expanded > '${sentinelPath}')`;
    const description = `Preserve ${shellTrigger}, \`printf backtick-expanded\`, $HOME, 'quotes', \"quotes\", and\nsecond line exactly.\n`;
    try {
      const shellText = description.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
      const oldShell = spawnSync("bash", ["-c", `printf '%s' \"${shellText}\"`], { encoding: "utf8" });
      assert.equal(oldShell.status, 0, oldShell.stderr || "the harmless old-shell reproduction should run");
      assert.equal(fs.readFileSync(sentinelPath, "utf8"), "shell-expanded");
      assert.match(oldShell.stdout, /backtick-expanded/);
      assert.notEqual(oldShell.stdout, description, "shell expansion changes the same prose before argv receives it");
      fs.rmSync(sentinelPath);

      fs.writeFileSync(inputPath, description, "utf8");
      const beforeEvents = countEvents(logPath);
      const filed = executeCommand([
        "file-ticket", "COORD-662", "--repo", "X", "--type", "chore", "--pri", "P2",
        "--description-file", inputPath, "--with-prompt",
      ]);
      assert.equal(filed.ok, true, filed.error || filed.stderr);
      const id = filed.value;

      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      const ticket = board.sections.flatMap((section) => section.rows || []).find((candidate) => candidate.ID === id);
      assert.equal(ticket.Description, description);
      const promptPath = promptAbsPath(board.prompt_index[id]);
      const prompt = fs.readFileSync(promptPath, "utf8");
      assert.ok(prompt.includes(`## Assignment\n\n${description}\n\n## Context`));
      assert.equal(fs.existsSync(sentinelPath), false, "the file-backed route leaves shell syntax as inert bytes");

      assert.equal(countEvents(logPath), beforeEvents + 1);
      const event = lastEvent(logPath);
      assert.equal(event.command, "file-ticket");
      assert.ok(event.changed_paths.some((entry) => entry.endsWith("/prompts/tickets/COORD-662.md")));
    } finally {
      fs.rmSync(inputDir, { recursive: true, force: true });
    }
  });
});

test("COORD-662: invalid file-ticket description input and conflicting channels refuse before mutation", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, []);
    seedJournalBaseline();
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-invalid-description-"));
    const blankPath = path.join(inputDir, "blank.txt");
    fs.writeFileSync(blankPath, " \n\t", "utf8");
    const boardBefore = fs.readFileSync(boardPath);
    const eventsBefore = countEvents(logPath);
    try {
      const blank = executeCommand([
        "file-ticket", "COORD-663", "--repo", "X", "--type", "chore", "--pri", "P2",
        "--description-file", blankPath,
      ]);
      assert.equal(blank.ok, false);
      assert.match(blank.error, /empty or whitespace-only/);
      const conflict = executeCommand([
        "file-ticket", "COORD-663", "--repo", "X", "--type", "chore", "--pri", "P2",
        "--description-file", blankPath, "--description", "inline",
      ]);
      assert.equal(conflict.ok, false);
      assert.match(conflict.error, /either --description or --description-file/);
      assert.deepEqual(fs.readFileSync(boardPath), boardBefore);
      assert.equal(countEvents(logPath), eventsBefore);
    } finally {
      fs.rmSync(inputDir, { recursive: true, force: true });
    }
  });
});

test("COORD-221: two back-to-back file-ticket calls reserve distinct, non-colliding ids", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const a = governanceCommands.fileTicket(null, { repo: "X", type: "chore", pri: "P2", description: "first" });
    const b = governanceCommands.fileTicket(null, { repo: "X", type: "chore", pri: "P2", description: "second" });

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
    const id = governanceCommands.fileTicket(null, {
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
      () => governanceCommands.fileTicket(null, { repo: "X", type: "chore", pri: "P2", status: "doing", description: "bad status" }),
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
      () => governanceCommands.fileTicket(null, { repo: "X", type: "not-a-type", pri: "P1", description: "bad type" }),
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
      () => governanceCommands.fileTicket(null, { repo: "X", type: "chore", description: "no pri" }),
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
        governanceCommands.fileTicket("COORD-001", {
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

    const id = governanceCommands.fileTicket("COORD-050", {
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
        governanceCommands.fileTicket(null, {
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
    governanceCommands.fileTicket(null, { repo: "X", type: "bug", pri: "P0", description: "validate me" });

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
    const id = governanceCommands.fileTicket("COORD-050", {
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

test("COORD-813: file-ticket --with-prompt lifts Description acceptance so the prompt is start-ready, and refuses with guidance without it", () => {
  const { inspectPromptContent } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/prompt-coverage.js"));
  withGovernedSurfaceSandbox(({ boardPath, promptsDir }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();
    const generate = (id, description) => {
      governanceCommands.fileTicket(id, {
        repo: "X", type: "feature", pri: "P1", description, withPrompt: true,
        prompt: path.join(promptsDir, "tickets", `${id}.md`),
      });
      return fs.readFileSync(path.join(promptsDir, "tickets", `${id}.md`), "utf8");
    };

    const ready = generate("COORD-051", "Add a health endpoint. Acceptance: GET /health returns 200 with the build SHA.");
    assert.match(ready, /## Acceptance Criteria\n\n- GET \/health returns 200 with the build SHA\.\n/);
    assert.doesNotMatch(ready, /Ticket scope is implemented/);
    assert.deepEqual(inspectPromptContent(ready), []);

    const unready = generate("COORD-052", "Add a health endpoint.");
    const issues = inspectPromptContent(unready);
    assert.equal(issues.length, 2, JSON.stringify(issues));
    assert.ok(issues.some((issue) => issue.includes("gov register-prompt COORD-052 --body-file <file>")));

    // A blank first line keeps the generated title fallback; acceptance on a
    // later line is still lifted.
    const untitled = generate("COORD-053", "\nAcceptance: the prompt title falls back to the ticket id.");
    assert.match(untitled, /^# COORD-053: COORD-053 implementation prompt\n/);
    assert.deepEqual(inspectPromptContent(untitled), []);
  });
});

test("COORD-350: file-ticket without --with-prompt remains low-ceremony and does not create prompt coverage", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const id = governanceCommands.fileTicket("COORD-060", {
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

// COORD-975: duplicate-ticket check before filing (advisory first; enforcement behind a
// policy switch that stays off until ADR 0026 is accepted). --duplicate-of and
// --distinct-from are journaled; the fixtures are the 2026-11-13 audit proposals.
const { FIXTURE_ROWS, PROPOSALS, GUARD_IDS } = require("../engine/scripts/__fixtures__/duplicate-check.fixtures.js");
const createTicketCommands = require("../engine/scripts/ticket-commands.js");

function boardRow(fixtureId) {
  const source = FIXTURE_ROWS.find((candidate) => candidate.ID === fixtureId);
  return { Repo: "X", Type: "chore", Pri: "P2", Owner: "unassigned", "Depends On": "", ...source };
}

function buildHistoricalDuplicateFactory(rows) {
  const board = {
    sections: [{ kind: "table", columns: ["ID"], rows: rows.map((row) => ({ ...row })) }],
    prompt_index: {},
    landing_index: {},
  };
  const state = { writes: 0, syncs: 0, mutation: null, guardProviderCalls: 0 };
  const commands = createTicketCommands({
    ALLOWED_PRIORITIES: ["P2"],
    ALLOWED_TICKET_TYPES: ["feature", "chore"],
    CREATABLE_STATUSES: ["todo", "proposed"],
    STATUS: { TODO: "todo", PROPOSED: "proposed" },
    allBoardRepoCodes: () => ["X"],
    canonicalizeOwnerOrFail: (owner) => owner,
    fail: (message) => { throw new GovernanceError(message); },
    getDuplicateGuardIds: () => { state.guardProviderCalls += 1; return GUARD_IDS; },
    getTicketRef: (candidate, id) => {
      const row = candidate.sections.flatMap((section) => section.rows || []).find((entry) => entry.ID === id);
      return row ? { row } : null;
    },
    recordGovernanceCollision: () => {},
    runBoardSync: () => { state.syncs += 1; },
    stableIdempotencyKey: () => "file-ticket-test",
    withBoardTransaction: (mutation, run) => {
      state.mutation = mutation;
      return run({ board, reserveTicketId: () => "COORD-960" });
    },
    withCoordStateLock: (run) => run(),
    writeBoard: () => { state.writes += 1; },
  });
  return { commands, board, state };
}

function readBoard(boardPath) {
  return JSON.parse(fs.readFileSync(boardPath, "utf8"));
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = fn();
    return { value, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("COORD-975: historical duplicate factory ignores per-call guard ids", () => {
  const harness = buildHistoricalDuplicateFactory([boardRow("COORD-958"), boardRow("COORD-959")]);
  const { value: id, output } = captureLog(() => harness.commands.fileTicket(null, {
    repo: "X", type: "feature", pri: "P2", description: PROPOSALS.F08_GUARD_MERGES,
    duplicatePolicy: { enforcement: "off" }, guardIds: [],
  }));
  assert.equal(id, "COORD-960", "advisory does not block: the ticket is filed");
  assert.match(output, /Duplicate check: \d+ likely duplicate candidate/);
  assert.match(output, /COORD-958 \[\w+\] score \d\.\d{3} \(likely duplicate\)/);
  assert.match(output, /shared description: .*guards: engine-pin, template-sync/);
  assert.ok(harness.board.sections[0].rows.find((candidate) => candidate.ID === "COORD-960"), "row is filed");
  assert.equal(harness.state.mutation.details.duplicate_check.decision, "advisory");
  assert.ok(harness.state.mutation.details.duplicate_check.flagged.includes("COORD-958"));
  assert.ok(harness.state.mutation.details.duplicate_check.flagged.includes("COORD-959"));
  assert.equal(harness.state.guardProviderCalls, 1, "the trusted factory provider supplies the historical registry snapshot");
});

test("COORD-975: live registry advisory is persisted in the governance journal", () => {
  const liveGuard = "engine-surface-integrity";
  const proposal = `Regenerate the engine manifest and pin together through guard:${liveGuard}; verify every engine-managed file is included and matching.`;
  const rows = ["COORD-958", "COORD-959"].map((id) => ({
    ...boardRow(id),
    Description: `Use guard:${liveGuard} as the single engine manifest and pin regeneration step; verify every engine-managed file is included and matching.`,
  }));
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, rows);
    seedJournalBaseline();
    const { value: id, output } = captureLog(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: proposal,
    }));
    assert.equal(id, "COORD-960", "advisory does not block: the ticket is filed");
    assert.match(output, /Duplicate check: \d+ likely duplicate candidate/);
    assert.match(output, /COORD-958 \[\w+\] score \d\.\d{3} \(likely duplicate\)/);
    assert.match(output, /shared description: .*engine-surface-integrity/);
    const event = lastEvent(logPath);
    assert.equal(event.details.duplicate_check.decision, "advisory");
    assert.ok(event.details.duplicate_check.flagged.includes("COORD-958"));
    assert.ok(event.details.duplicate_check.flagged.includes("COORD-959"));
  });
});

test("COORD-975: an unrelated proposal files with no duplicate advisory", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [boardRow("COORD-958"), boardRow("COORD-938")]);
    seedJournalBaseline();
    const { value: id, output } = captureLog(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: PROPOSALS.UNRELATED_UI,
    }));
    assert.ok(id);
    assert.doesNotMatch(output, /Duplicate check/);
    assert.equal(lastEvent(logPath).details.duplicate_check.decision, "none");
  });
});

test("COORD-975: --duplicate-of does not file the ticket and adds a note to the existing ticket, journaled", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [boardRow("COORD-958")]);
    seedJournalBaseline();
    const before = readBoard(boardPath).sections[0].rows.length;
    const result = captureLog(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: PROPOSALS.F08_GUARD_MERGES, duplicateOf: "COORD-958",
    }));
    assert.equal(result.value, null, "no new ticket id is returned");
    assert.match(result.output, /Not filed: duplicate of COORD-958/);
    const board = readBoard(boardPath);
    assert.equal(board.sections[0].rows.length, before, "the board gained no row");
    assert.equal(board.duplicate_index, undefined, "no board field is written (the board schema is engine-owned)");
    const event = lastEvent(logPath);
    assert.equal(event.ticket, "COORD-958", "the journal event is attached to the existing ticket");
    assert.equal(event.details.duplicate_note.on, "COORD-958");
    assert.match(event.details.duplicate_note.proposed_description, /Apply the guard-registry merge/);
  });
});

test("COORD-975: --distinct-from without --reason refuses before any write", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [boardRow("COORD-958")]);
    seedJournalBaseline();
    const boardBefore = fs.readFileSync(boardPath);
    const eventsBefore = countEvents(logPath);
    assert.throws(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: PROPOSALS.NEAR_MISS_ANSWERS, distinctFrom: "COORD-958",
    }), /--distinct-from requires --reason/);
    assert.deepEqual(fs.readFileSync(boardPath), boardBefore);
    assert.equal(countEvents(logPath), eventsBefore);
  });
});

test("COORD-975: --distinct-from with --reason files the ticket and records the distinction on the new row", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [boardRow("COORD-958")]);
    seedJournalBaseline();
    const id = captureLog(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: PROPOSALS.NEAR_MISS_ANSWERS,
      distinctFrom: "COORD-958", reason: "answers hygiene, not guard merges",
    })).value;
    const board = readBoard(boardPath);
    assert.ok(board.sections[0].rows.find((candidate) => candidate.ID === id), "the ticket is filed");
    const event = lastEvent(logPath);
    assert.equal(event.ticket, id);
    assert.equal(event.details.distinct_record.ticket, id);
    assert.deepEqual(event.details.distinct_record.distinct_from, ["COORD-958"]);
    assert.equal(event.details.distinct_record.reason, "answers hygiene, not guard merges");
    assert.ok(event.details.distinct_record.recorded_by);
    assert.deepEqual(event.details.duplicate_check.distinct_from, ["COORD-958"]);
  });
});

test("COORD-975: unknown ids in --duplicate-of or --distinct-from refuse before any write", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [boardRow("COORD-958")]);
    seedJournalBaseline();
    const boardBefore = fs.readFileSync(boardPath);
    const eventsBefore = countEvents(logPath);
    assert.throws(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: "x", duplicateOf: "COORD-999",
    }), /COORD-999 does not exist/);
    assert.throws(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: "x", distinctFrom: "COORD-958,COORD-998", reason: "r",
    }), /COORD-998 does not exist/);
    assert.deepEqual(fs.readFileSync(boardPath), boardBefore);
    assert.equal(countEvents(logPath), eventsBefore);
  });
});

test("COORD-975: with enforcement on, an unlinked likely duplicate is refused; a linked one files", () => {
  const liveGuard = "engine-surface-integrity";
  const proposal = `Regenerate the engine manifest and pin together through guard:${liveGuard}; verify every engine-managed file is included and matching.`;
  const rows = ["COORD-958", "COORD-959"].map((id) => ({
    ...boardRow(id),
    Description: `Use guard:${liveGuard} as the single engine manifest and pin regeneration step; verify every engine-managed file is included and matching.`,
  }));
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, rows);
    seedJournalBaseline();
    const boardBefore = fs.readFileSync(boardPath);
    const eventsBefore = countEvents(logPath);
    assert.throws(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: proposal, duplicatePolicy: { enforcement: "on" },
    }), /likely duplicate of COORD-958.*--duplicate-of.*--distinct-from/);
    assert.deepEqual(fs.readFileSync(boardPath), boardBefore, "blocked filing preserves the actual board bytes");
    assert.equal(countEvents(logPath), eventsBefore, "blocked filing appends no governance journal event");
  });

  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, rows);
    seedJournalBaseline();
    const id = captureLog(() => governanceCommands.fileTicket(null, {
      repo: "X", type: "feature", pri: "P2", description: proposal,
      duplicatePolicy: { enforcement: "on" }, distinctFrom: "COORD-958", reason: "a different merge set",
    })).value;
    assert.equal(id, "COORD-960");
    const event = lastEvent(logPath);
    assert.equal(event.details.duplicate_check.decision, "linked");
    assert.deepEqual(event.details.duplicate_check.distinct_from, ["COORD-958"]);
    assert.ok(readBoard(boardPath).sections[0].rows.find((candidate) => candidate.ID === id), "linked filing creates the board row");
  });
});
