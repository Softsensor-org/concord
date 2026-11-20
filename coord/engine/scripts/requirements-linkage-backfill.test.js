"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const backfill = require("./requirements-linkage-backfill.js");
const { __testing, withGovernedSurfaceSandbox } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));

function board(rows) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-25T00:00:00Z", canonical_references: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Rows",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows,
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  };
}

function tempBoard(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-linkage-backfill-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), `${JSON.stringify(board(rows), null, 2)}\n`);
  return dir;
}

test("analyzeBoard proposes explicit requirement IDs from descriptions only", () => {
  const report = backfill.analyzeBoard(board([
    { ID: "A-001", Description: "[REQ-001] Build feature" },
    { ID: "A-002", Description: "No requirement" },
    { ID: "A-003", Description: "[REQ-002] Already linked", "Requirement IDs": "REQ-999" },
  ]));
  assert.equal(report.kind, "concord.requirements.linkage_backfill_report");
  assert.deepEqual(report.changes.map((change) => change.ticket_id), ["A-001"]);
  assert.equal(report.summary.proposed_updates, 1);
  assert.equal(report.summary.existing_metadata, 1);
  assert.equal(report.summary.no_explicit_requirement_id, 1);
});

test("analyzeBoard handles an ID row without a description as having no inferred links", () => {
  const report = backfill.analyzeBoard(board([{ ID: "A-004" }]));
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.skipped, [{ ticket_id: "A-004", reason: "no-explicit-requirement-id" }]);
});

test("public CLI help executes the requirements backfill entrypoint", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "requirements-linkage-backfill.js"), "--help"], {
    cwd: path.resolve(__dirname, "../../.."), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: requirements-linkage-backfill/);
});

test("backfill never overwrites an explicitly empty unlink", () => {
  const input = board([{ ID: "A-001", Description: "Historic REQ-001 context", "Requirement IDs": "" }]);
  const result = backfill.applyBackfill(input);
  assert.equal(result.report.summary.proposed_updates, 0);
  assert.equal(result.report.summary.existing_metadata, 1);
  assert.equal(Object.hasOwn(result.board.sections[0].rows[0], "Requirement IDs"), true);
  assert.equal(result.board.sections[0].rows[0]["Requirement IDs"], "");
});

test("applyBackfill is idempotent and marks rows it owns", () => {
  const original = board([
    { ID: "A-001", Description: "[REQ-001] Build feature" },
    { ID: "A-002", Description: "[REQ-002] Build second" },
  ]);
  const first = backfill.applyBackfill(original);
  assert.equal(first.report.summary.proposed_updates, 2);
  assert.equal(first.board.sections[0].rows[0]["Requirement IDs"], "REQ-001");
  assert.equal(first.board.sections[0].rows[0]["Requirements Backfill Stamp"], "COORD-248");

  const second = backfill.applyBackfill(first.board);
  assert.equal(second.report.summary.proposed_updates, 0);
  assert.equal(second.report.summary.already_backfilled, 2);
});

test("revertBackfill removes only migration-owned metadata", () => {
  const applied = backfill.applyBackfill(board([
    { ID: "A-001", Description: "[REQ-001] Build feature" },
    { ID: "A-002", Description: "[REQ-002] Existing owner", "Requirement IDs": "REQ-777" },
  ])).board;
  const reverted = backfill.revertBackfill(applied);
  const rows = reverted.board.sections[0].rows;
  assert.equal(rows[0]["Requirement IDs"], undefined);
  assert.equal(rows[0]["Requirements Backfill Stamp"], undefined);
  assert.equal(rows[1]["Requirement IDs"], "REQ-777");
  assert.equal(reverted.report.summary.proposed_updates, 1);
});

test("run dry-run writes a deterministic report without mutating the board", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const before = fs.readFileSync(path.join(dir, "coord/board/tasks.json"), "utf8");
  const result = backfill.run(["--dir", dir, "--json", "--output", "coord/.runtime/requirements/linkage-backfill.json"], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, "coord/board/tasks.json"), "utf8"), before);
  const report = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/requirements/linkage-backfill.json"), "utf8"));
  assert.equal(report.summary.proposed_updates, 1);
});

test("run apply and revert mutate fixture boards but refuse live board by default", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const refused = backfill.run(["--dir", dir, "--apply", "--json"], { cwd: dir, log: () => {} });
  assert.equal(refused.code, 2);

  const boardPath = "fixture/tasks.json";
  fs.mkdirSync(path.join(dir, "fixture"), { recursive: true });
  fs.writeFileSync(path.join(dir, boardPath), `${JSON.stringify(board([{ ID: "A-001", Description: "[REQ-001] Build feature" }]), null, 2)}\n`);

  const applied = backfill.run(["--dir", dir, "--board", boardPath, "--apply", "--json"], { cwd: dir, log: () => {} });
  assert.equal(applied.code, 0);
  const afterApply = JSON.parse(fs.readFileSync(path.join(dir, boardPath), "utf8"));
  assert.equal(afterApply.sections[0].rows[0]["Requirement IDs"], "REQ-001");

  const reverted = backfill.run(["--dir", dir, "--board", boardPath, "--revert", "--json"], { cwd: dir, log: () => {} });
  assert.equal(reverted.code, 0);
  const afterRevert = JSON.parse(fs.readFileSync(path.join(dir, boardPath), "utf8"));
  assert.equal(afterRevert.sections[0].rows[0]["Requirement IDs"], undefined);
});

test("allowed canonical apply and revert are journaled and leave the next mutation usable", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const rows = [{
      ID: "TEST-001", Repo: "X", Type: "chore", Pri: "P2", Status: "todo",
      Owner: "unassigned", Description: "[REQ-001] Build feature", "Depends On": "",
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board(rows), null, 2)}\n`);
    __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command: "fixture-baseline", ticket: null,
      before_status: null, after_status: null, identity: null, details: {},
      changed_paths: [], snapshot: __testing.buildGovernanceSnapshot(),
    });
    const run = (...flags) => backfill.run(["--board", boardPath, ...flags, "--allow-live-board"], { log: () => {} });
    const applied = run("--apply");
    assert.equal(applied.code, 0);
    assert.equal(applied.report.summary.proposed_updates, 1);
    assert.equal(JSON.parse(fs.readFileSync(boardPath, "utf8")).sections[0].rows[0]["Requirement IDs"], "REQ-001");

    const reverted = run("--revert");
    assert.equal(reverted.code, 0, "the next governed mutation must not trip the provenance seal");
    assert.equal(JSON.parse(fs.readFileSync(boardPath, "utf8")).sections[0].rows[0]["Requirement IDs"], undefined);
    const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.slice(-2).map((event) => event.command), [
      "requirements-linkage-backfill", "requirements-linkage-backfill",
    ]);
  }, { isolateBoardValidation: true });
});

test("governed mutation failure is reported without writing board or journal state", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    fs.writeFileSync(boardPath, `${JSON.stringify(board([{ ID: "TEST-001", Description: "[REQ-001] Build feature" }]), null, 2)}\n`);
    __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command: "fixture-baseline", ticket: null,
      before_status: null, after_status: null, identity: null, details: {},
      changed_paths: [], snapshot: __testing.buildGovernanceSnapshot(),
    });
    const beforeBoard = fs.readFileSync(boardPath, "utf8");
    const beforeJournal = fs.readFileSync(logPath, "utf8");
    const { commands } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
    const original = commands.backfillRequirementLinks;
    commands.backfillRequirementLinks = () => { throw new Error("fixture governed writer failure"); };
    const messages = [];
    try {
      const result = backfill.run(["--board", boardPath, "--apply", "--allow-live-board"], {
        log: (message) => messages.push(message),
      });
      assert.equal(result.code, 1);
      assert.match(messages.join("\n"), /governed mutation failed: fixture governed writer failure/);
      assert.equal(fs.readFileSync(boardPath, "utf8"), beforeBoard);
      assert.equal(fs.readFileSync(logPath, "utf8"), beforeJournal);
    } finally {
      commands.backfillRequirementLinks = original;
    }
  }, { isolateBoardValidation: true });
});

test("canonical-looking board outside the governance context cannot be written", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const file = path.join(dir, "coord/board/tasks.json");
  const before = fs.readFileSync(file, "utf8");
  const messages = [];
  const result = backfill.run(["--dir", dir, "--apply", "--allow-live-board"], { log: (message) => messages.push(message) });
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.match(messages.join("\n"), /outside the installed governance context/);
});

test("report output cannot overwrite the selected board", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const file = path.join(dir, "coord/board/tasks.json");
  const before = fs.readFileSync(file, "utf8");
  const result = backfill.run(["--dir", dir, "--output", "coord/board/tasks.json"], { log: () => {} });
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("report output cannot overwrite the governance journal", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const original = fs.readFileSync(boardPath, "utf8");
    const result = backfill.run(["--board", boardPath, "--output", logPath], { log: () => {} });
    assert.equal(result.code, 2);
    assert.equal(fs.readFileSync(boardPath, "utf8"), original);
    assert.equal(fs.existsSync(logPath), false);
  }, { isolateBoardValidation: true });
});

test("report output is refused inside each governed state directory", () => {
  withGovernedSurfaceSandbox(({ tempDir, boardPath }) => {
    const state = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js")).state;
    const protectedDirs = [state.PLAN_RECORDS_DIR, state.PROMPTS_DIR, state.RENDERED_DIR, state.LOCKS_DIR];
    const original = fs.readFileSync(boardPath, "utf8");
    for (const directory of protectedDirs) {
      const output = path.join(directory, "report.json");
      const result = backfill.run(["--dir", tempDir, "--board", boardPath, "--output", output], { log: () => {} });
      assert.equal(result.code, 2, `report output under ${directory} must be refused`);
      assert.equal(fs.existsSync(output), false, `refused output under ${directory} must not be created`);
      assert.equal(fs.readFileSync(boardPath, "utf8"), original);
    }
  }, { isolateBoardValidation: true });
});

test("canonical target resolution terminates when every ancestor is reported absent", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const boardPath = path.join(dir, "coord/board/tasks.json");
  const output = path.join(dir, "report/report.json");
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (target) => path.resolve(String(target)) === boardPath;
  try {
    const result = backfill.run(["--dir", dir, "--board", boardPath, "--json", "--output", output], { log: () => {} });
    assert.equal(result.code, 0);
    assert.ok(fs.statSync(output).size > 0);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hard-link alias of the canonical board uses the governed transaction", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath, tempDir }) => {
    const rows = [{
      ID: "TEST-001", Repo: "X", Type: "chore", Pri: "P2", Status: "todo",
      Owner: "unassigned", Description: "[REQ-001] Build feature", "Depends On": "",
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board(rows), null, 2)}\n`);
    const alias = path.join(tempDir, "board-hardlink.json");
    fs.linkSync(boardPath, alias);
    __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command: "fixture-baseline", ticket: null,
      before_status: null, after_status: null, identity: null, details: {},
      changed_paths: [], snapshot: __testing.buildGovernanceSnapshot(),
    });
    const messages = [];
    const result = backfill.run(["--board", alias, "--apply", "--allow-live-board"], { log: (message) => messages.push(message) });
    assert.equal(result.code, 0, messages.join("\n"));
    assert.equal(JSON.parse(fs.readFileSync(boardPath, "utf8")).sections[0].rows[0]["Requirement IDs"], "REQ-001");
    const event = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1));
    assert.equal(event.command, "requirements-linkage-backfill");
  }, { isolateBoardValidation: true });
});

test("report output through a symlinked parent cannot overwrite the board", () => {
  const dir = tempBoard([{ ID: "A-001", Description: "[REQ-001] Build feature" }]);
  const boardPath = path.join(dir, "coord/board/tasks.json");
  const aliasDir = path.join(dir, "alias");
  fs.symlinkSync(path.dirname(boardPath), aliasDir, "dir");
  const original = fs.readFileSync(boardPath, "utf8");
  const result = backfill.run(["--dir", dir, "--output", "alias/tasks.json"], { log: () => {} });
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(boardPath, "utf8"), original);
});
