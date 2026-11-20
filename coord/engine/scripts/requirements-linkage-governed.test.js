"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const coordDir = path.resolve(__dirname, "../..");
const { resolveEngineModule } = require("../../paths.js");
const resolve = (relativePath) => resolveEngineModule(coordDir, relativePath);
const { state: governanceState } = require(resolve("engine/scripts/governance-context.js"));
const { __testing, withRegisterPromptHarness, executeCommand, coord006ScaffoldRecord } = require(resolve("scripts/governance-test-utils.js"));
const linkage = require(resolve("engine-only:scripts/requirements-linkage.js"));
const boardTesting = require(resolve("board/board.js")).__testing;
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function withFixture(prefix, options, body) {
  return withRegisterPromptHarness(prefix, options, (fixture) => {
    const original = {
      BOARD_PATH: boardTesting.paths.BOARD_PATH,
      LOCKS_DIR: boardTesting.paths.LOCKS_DIR,
      LEGACY_LOCKS_DIR: boardTesting.paths.LEGACY_LOCKS_DIR,
      GOVERNANCE_EVENT_LOG_PATH: boardTesting.paths.GOVERNANCE_EVENT_LOG_PATH,
      PLAN_RECORDS_DIR: boardTesting.paths.PLAN_RECORDS_DIR,
      LEGACY_PLAN_RECORDS_DIR: boardTesting.paths.LEGACY_PLAN_RECORDS_DIR,
    };
    boardTesting.paths.BOARD_PATH = governanceState.BOARD_PATH;
    boardTesting.paths.LOCKS_DIR = governanceState.LOCKS_DIR;
    boardTesting.paths.LEGACY_LOCKS_DIR = governanceState.LEGACY_LOCKS_DIR;
    boardTesting.paths.GOVERNANCE_EVENT_LOG_PATH = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    boardTesting.paths.PLAN_RECORDS_DIR = governanceState.PLAN_RECORDS_DIR;
    const validBoard = JSON.parse(fs.readFileSync(governanceState.BOARD_PATH, "utf8"));
    validBoard.metadata.last_updated = new Date().toISOString();
    validBoard.sections.forEach((section) => { section.separator_before = false; });
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(validBoard, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 isolated schema-valid board fixture");
    try { return body(fixture); }
    finally { for (const [key, value] of Object.entries(original)) boardTesting.paths[key] = value; }
  });
}

function run(args) {
  return executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "coord529-governed-cli" } });
}
function runSigned(args, verb, ticket) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    return withApprovalTestClient(coordDir, fixture.client(), () => {
      const first = run(args);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
      if (!digest) return first;
      fixture.login({ verb, ticket, subject_sha256: digest[1] });
      return run(args);
    });
  } finally { fixture.cleanup(); }
}
function snapshot(files) {
  return files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]);
}
function setupActor() {
  const result = run(["agentid", "--owner", "claudea11"]);
  assert.equal(result.ok, true, result.error);
}

test("public question writes in the shared prompt fixture leave the outside question log unchanged", () => {
  const outsidePath = governanceState.QUESTIONS_PATH;
  const before = snapshot([outsidePath]);
  withFixture("coord529-question-isolation-", { ticketId: "IMP-529" }, ({ tempDir }) => {
    setupActor();
    const result = run(["log-question", "--from", "claudea11", "--to", "orchestrator",
      "--question", "COORD-529 isolated fixture question", "--answer", "Fixture only", "--resolved", "yes"]);
    assert.equal(result.ok, true, result.error);
    assert.match(fs.readFileSync(path.join(tempDir, "QUESTIONS.md"), "utf8"), /COORD-529 isolated fixture question/);
    assert.deepEqual(snapshot([outsidePath]), before);
  });
  assert.equal(governanceState.QUESTIONS_PATH, outsidePath);
  assert.deepEqual(snapshot([outsidePath]), before);
});

test("public gov router sets IDs, renders explicit-vs-inferred provenance and journals exact evidence", () => {
  withFixture("coord529-set-ids-", { ticketId: "IMP-529" }, ({ boardPath, tempDir, readBoard }) => {
    const output = path.join(tempDir, "rendered", "TASKS.md");
    const journal = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    setupActor();
    const result = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-CURRENT, urs-v1, REQ-CURRENT", "--reason", "Reviewed traceability mapping"]);
    assert.equal(result.ok, true, result.error);
    const row = readBoard().sections[0].rows[0];
    assert.equal(row["Requirement IDs"], "REQ-CURRENT, URS-V1");
    assert.equal(row.Owner, "unassigned", "authoring metadata must not claim the ticket");
    const report = linkage.analyzeLinkage({ sections: [{ kind: "table", rows: [row] }] }, { requirements: [] });
    assert.deepEqual(report.tickets[0].requirement_ids, ["REQ-CURRENT", "URS-V1"]);
    assert.deepEqual(report.tickets[0].inferred_requirement_ids, []);
    const rendered = fs.readFileSync(output, "utf8");
    assert.match(rendered, /Requirement IDs/);
    assert.match(rendered, /REQ-CURRENT, URS-V1/);
    const event = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse).findLast((item) => item.command === "set-requirement-ids");
    assert.equal(event.identity.owner, "claudea11");
    assert.deepEqual(event.details.before_requirement_ids, null);
    assert.deepEqual(event.details.after_requirement_ids, ["REQ-CURRENT", "URS-V1"]);
    assert.equal(event.details.reason, "Reviewed traceability mapping");
    assert.equal(event.details.actor, "claudea11");
    assert.ok(fs.readFileSync(boardPath, "utf8").includes('"Requirement IDs": "REQ-CURRENT, URS-V1"'));
  });
});

test("exact public CLI retry is byte-identical and does not add a journal event", () => {
  withFixture("coord529-set-ids-retry-", { ticketId: "IMP-529" }, ({ tempDir }) => {
    setupActor();
    const args = ["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "same mapping"];
    assert.equal(run(args).ok, true);
    const files = [governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.PLAN_PATH, path.join(tempDir, "rendered", "TASKS.md")];
    const before = snapshot(files);
    const retry = run(args);
    assert.equal(retry.ok, true, retry.error);
    assert.match(retry.stdout, /no change recorded/);
    assert.deepEqual(snapshot(files), before);
  });
});

test("explicit setter takes authorship from a prior backfill even when values are equal", () => {
  const backfill = require(resolve("engine-only:scripts/requirements-linkage-backfill.js"));
  for (const [requestedId, label] of [["REQ-NEW", "changed-values"], ["REQ-OLD", "same-values"]]) {
    withFixture(`coord529-set-after-backfill-${label}-`, { ticketId: "IMP-529" }, ({ readBoard }) => {
      const original = readBoard();
      original.sections[0].rows[0].Description = "Historical [REQ-OLD] context";
      delete original.sections[0].rows[0]["Requirement IDs"];
      delete original.sections[0].rows[0]["Requirements Backfill Stamp"];
      const applied = backfill.applyBackfill(original).board;
      assert.equal(applied.sections[0].rows[0]["Requirements Backfill Stamp"], "COORD-248");
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(applied, null, 2)}\n`);
      __testing.advanceGovernanceProvenanceBaseline(`COORD-529 backfill-setter fixture ${label}`);
      setupActor();

      const result = run(["set-requirement-ids", "IMP-529", "--ids", requestedId, "--reason", "User explicitly reviewed linkage"]);
      assert.equal(result.ok, true, result.error);
      assert.doesNotMatch(result.stdout, /no change recorded/);
      const row = readBoard().sections[0].rows[0];
      assert.equal(row["Requirement IDs"], requestedId);
      assert.equal(Object.hasOwn(row, "Requirements Backfill Stamp"), false);
      const event = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse).findLast((item) => item.command === "set-requirement-ids");
      assert.equal(event.details.backfill_stamp_before, "COORD-248");
      assert.equal(event.details.backfill_stamp_was_present, true);
      assert.equal(event.details.backfill_stamp_after, null);

      const reverted = backfill.revertBackfill(readBoard());
      assert.equal(reverted.report.summary.proposed_updates, 0);
      assert.equal(reverted.board.sections[0].rows[0]["Requirement IDs"], requestedId);
      assert.equal(linkage.normalizeLinkage(reverted.board.sections[0].rows[0]).requirement_ids[0], requestedId);
    });
  }
});

test("public clear persists explicit empty and prevents prose reinference and backfill", () => {
  withFixture("coord529-set-ids-clear-", { ticketId: "IMP-529" }, ({ readBoard, tempDir }) => {
    const board = readBoard();
    board.sections[0].rows[0].Description = "Historical REQ-OLD context";
    board.sections[0].rows[0]["Requirement IDs"] = "REQ-CURRENT";
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 isolated explicit-link fixture");
    setupActor();
    const result = run(["set-requirement-ids", "IMP-529", "--clear", "--reason", "No active requirement link"]);
    assert.equal(result.ok, true, result.error);
    const row = readBoard().sections[0].rows[0];
    assert.equal(Object.hasOwn(row, "Requirement IDs"), true);
    assert.equal(row["Requirement IDs"], "");
    assert.deepEqual(linkage.normalizeLinkage(row).requirement_ids, []);
    assert.deepEqual(linkage.normalizeLinkage(row).inferred_requirement_ids, ["REQ-OLD"]);
    const backfill = require(resolve("engine-only:scripts/requirements-linkage-backfill.js")).applyBackfill(readBoard());
    assert.equal(backfill.report.summary.proposed_updates, 0);
    assert.equal(backfill.board.sections[0].rows[0]["Requirement IDs"], "");
    assert.match(fs.readFileSync(path.join(tempDir, "rendered", "TASKS.md"), "utf8"), /\(explicit none\)/);
    const legacyBoard = readBoard();
    delete legacyBoard.sections[0].rows[0]["Requirement IDs"];
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(legacyBoard, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 isolated legacy-clear fixture");
    const legacyClear = run(["set-requirement-ids", "IMP-529", "--clear", "--reason", "Explicitly no link"]);
    assert.equal(legacyClear.ok, true, legacyClear.error);
    assert.equal(Object.hasOwn(readBoard().sections[0].rows[0], "Requirement IDs"), true);
    assert.equal(readBoard().sections[0].rows[0]["Requirement IDs"], "");
  });
});

test("registered actor cannot author unassigned todo metadata without an active identity", () => {
  withFixture("coord529-set-ids-unbound-", { ticketId: "IMP-529" }, ({ tempDir }) => {
    const files = [governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.PLAN_PATH, path.join(tempDir, "rendered", "TASKS.md")];
    const before = snapshot(files);
    const result = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "No active identity"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /active|session|agentid/i);
    assert.deepEqual(snapshot(files), before);
  });
});

test("public CLI refuses malformed inputs atomically across board, journal, plan and rendered indexes", () => {
  withFixture("coord529-set-ids-invalid-", { ticketId: "IMP-529" }, ({ tempDir }) => {
    setupActor();
    const files = [
      governanceState.BOARD_PATH,
      governanceState.GOVERNANCE_EVENT_LOG_PATH,
      governanceState.PLAN_PATH,
      path.join(tempDir, "rendered", "TASKS.md"),
      path.join(tempDir, "rendered", "PROMPT_INDEX.md"),
      governanceState.AGENT_SESSIONS_PATH,
    ];
    const before = snapshot(files);
    for (const args of [
      ["set-requirement-ids", "IMP-529", "--ids", "REQ-001, nonsense", "--reason", "bad id"],
      ["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", " "],
      ["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--clear", "--reason", "both modes"],
      ["set-requirement-ids", "MISSING-529", "--ids", "REQ-001", "--reason", "missing row"],
      ["set-requirement-ids", "", "--ids", "REQ-001", "--reason", "missing ticket"],
      ["set-requirement-ids", "IMP-529", "--reason", "missing mode"],
      ["set-requirement-ids", "IMP-529", "--ids", "REQ-001"],
      ["set-requirement-ids", "IMP-529", "--ids", ",;|", "--reason", "no identifiers"],
    ]) {
      const result = run(args);
      assert.equal(result.ok, false, `${args.join(" ")} should refuse`);
      assert.deepEqual(snapshot(files), before,
        "invalid command leaves board, journal, plan, rendered prompt index, and agent sessions byte-identical");
    }
  });
});

test("replacing explicit empty requirement metadata records an empty prior value", () => {
  withFixture("coord529-set-ids-from-explicit-empty-", { ticketId: "IMP-529" }, ({ readBoard }) => {
    const board = readBoard();
    board.sections[0].rows[0]["Requirement IDs"] = "";
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 explicit-empty setter fixture");
    setupActor();

    const result = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "Replace explicit none"]);
    assert.equal(result.ok, true, result.error);
    assert.equal(readBoard().sections[0].rows[0]["Requirement IDs"], "REQ-001");
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse);
    const event = events.findLast((item) => item.command === "set-requirement-ids");
    assert.deepEqual(event.details.before_requirement_ids, []);
    assert.deepEqual(event.details.after_requirement_ids, ["REQ-001"]);
  });
});

test("foreign active owner is refused without override, then reasoned override is attributed", () => {
  withFixture("coord529-set-ids-owner-", { ticketId: "IMP-529" }, ({ readBoard, tempDir }) => {
    const agents = JSON.parse(fs.readFileSync(governanceState.AGENTS_PATH, "utf8"));
    agents.push({ id: "a99", handle: "claudea99", provider: "anthropic", status: "active", aliases: [] });
    fs.writeFileSync(governanceState.AGENTS_PATH, `${JSON.stringify(agents, null, 2)}\n`);
    const board = readBoard();
    Object.assign(board.sections[0].rows[0], { Status: "review", Owner: "claudea99" });
    board.pr_index["IMP-529"] = ["https://example.invalid/review/529"];
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`);
    const record = coord006ScaffoldRecord("IMP-529", "backend/src/example.js");
    record.repo_gates = ["node --test fixture [result=pass]"];
    record.self_review_cycles = record.self_review_cycles.map((cycle) => ({ ...cycle, verdict: "pass", findings: "none", verification: "node --test fixture" }));
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-529.json"), `${JSON.stringify(record, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-529", record);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 isolated foreign-owner fixture");
    setupActor();
    const files = [governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.PLAN_PATH, path.join(tempDir, "rendered", "TASKS.md")];
    const before = snapshot(files);
    const refused = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "unauthorized"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /owned by claudea99/);
    assert.deepEqual(snapshot(files), before);
    const bare = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "bare approval attempt", "--human-admin-override", "Bare text"]);
    assert.equal(bare.ok, false);
    assert.match(bare.error, /requires a signed human-admin approval/);
    assert.deepEqual(snapshot(files.filter((file) => file !== governanceState.GOVERNANCE_EVENT_LOG_PATH)),
      before.filter(([file]) => file !== governanceState.GOVERNANCE_EVENT_LOG_PATH));
    const allowed = runSigned(["set-requirement-ids", "IMP-529", "--ids", "REQ-001", "--reason", "authorized repair", "--human-admin-override", "Admin approved mapping"], "set-requirement-ids", "IMP-529");
    assert.equal(allowed.ok, true, allowed.error);
    const event = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse).findLast((item) => item.command === "set-requirement-ids");
    assert.equal(event.identity.owner, "claudea11");
    assert.equal(event.details.human_admin_override, "Admin approved mapping");
    assert.ok(event.details.approval_record);
    const cleared = runSigned(["set-requirement-ids", "IMP-529", "--clear", "--reason", "authorized removal", "--human-admin-override", "Admin approved empty mapping"], "set-requirement-ids", "IMP-529");
    assert.equal(cleared.ok, true, cleared.error);
    assert.equal(readBoard().sections[0].rows[0]["Requirement IDs"], "");
  });
});

test("same-owner active ticket accepts metadata without admin override", () => {
  withFixture("coord529-set-ids-same-owner-", { ticketId: "IMP-529" }, ({ readBoard }) => {
    const board = readBoard();
    Object.assign(board.sections[0].rows[0], { Status: "review", Owner: "claudea11" });
    board.pr_index["IMP-529"] = ["https://example.invalid/review/529"];
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`);
    const record = coord006ScaffoldRecord("IMP-529", "backend/src/example.js");
    record.repo_gates = ["node --test fixture [result=pass]"];
    record.self_review_cycles = record.self_review_cycles.map((cycle) => ({ ...cycle, verdict: "pass", findings: "none", verification: "node --test fixture" }));
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-529.json"), `${JSON.stringify(record, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-529", record);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 isolated same-owner fixture");
    setupActor();
    const result = run(["set-requirement-ids", "IMP-529", "--ids", "URS-V1", "--reason", "Owner verified link"]);
    assert.equal(result.ok, true, result.error);
    assert.equal(readBoard().sections[0].rows[0]["Requirement IDs"], "URS-V1");
  });
});

test("owned done ticket accepts metadata while preserving historical closeout evidence", () => {
  withFixture("coord529-set-ids-landed-", { ticketId: "IMP-529" }, ({ readBoard }) => {
    const board = readBoard();
    Object.assign(board.sections[0].rows[0], { Status: "done", Owner: "claudea11" });
    board.pr_index["IMP-529"] = ["https://example.invalid/review/529"];
    board.landing_index["IMP-529"] = {
      recorded_at: "2026-06-01T12:00:00.000Z",
      evidence: ["fixture merge evidence"],
      commit_sha: "abcdef1234567",
      provenance_status: "explicit",
    };
    fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-529 landed-ticket linkage fixture");
    setupActor();

    const result = run(["set-requirement-ids", "IMP-529", "--ids", "REQ-LANDED", "--reason", "Trace existing landed work"]);
    assert.equal(result.ok, true, result.error);
    const after = readBoard();
    assert.equal(after.sections[0].rows[0].Status, "done");
    assert.equal(after.sections[0].rows[0].Owner, "claudea11");
    assert.equal(after.sections[0].rows[0]["Requirement IDs"], "REQ-LANDED");
    assert.deepEqual(after.pr_index["IMP-529"], board.pr_index["IMP-529"]);
    assert.deepEqual(after.landing_index["IMP-529"], board.landing_index["IMP-529"]);
  });
});
