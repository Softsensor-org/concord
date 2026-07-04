"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const backfill = require("./requirements-linkage-backfill.js");

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
