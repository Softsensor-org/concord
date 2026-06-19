"use strict";

// Wave 2 (COORD-060): plan-command tests relocated out of governance.test.js
// into a module-owned file. Exercise the plan-seed builder and the structured
// plan-block mutation verbs (requirement closure, feature proofs, review
// cycles) via the governance __testing surface. Wave 3 (COORD-069): the
// dedicated repo-gate attribution/formatting helper tests moved to
// gates.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __testing } = require("./governance-test-utils.js");

test("buildStartPlanSeedUpdate seeds startup and traceability and adds baseline only for tickets that require it", () => {
  const seedTest = __testing.buildStartPlanSeedUpdate({
    ID: "DEBT-043",
    Repo: "B",
    Type: "test",
  });
  assert.equal(seedTest.startup, "completed");
  assert.equal(seedTest.traceability, "closing-gap");
  assert.deepEqual(seedTest.baseline, [
    "Command: <repro command>",
    "Outcome: <observed result>",
  ]);

  const seedFeature = __testing.buildStartPlanSeedUpdate({
    ID: "DEBT-041",
    Repo: "X",
    Type: "feature",
  });
  assert.equal(seedFeature.startup, "completed");
  assert.equal(seedFeature.traceability, "exempt");
  assert.equal(seedFeature.baseline, undefined);
});

test("structured plan helper commands write canonical review evidence without raw update-plan strings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-plan-helpers-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  try {
    __testing.ensurePlanStub("IMP-201", "X", "codexa02");
    __testing.setRequirementClosureCommand("IMP-201", {
      ticketAsk: "normalize governance plan entry UX",
      implemented: "structured helper commands for strict plan fields",
      notImplemented: "none",
      deferredTo: "none",
      closeoutVerdict: "complete",
    });
    __testing.addFeatureProofCommand("IMP-201", { proofText: "add-review-cycle" });
    __testing.addRepoGateCommand("IMP-201", { commandText: "node --test coord/scripts/governance.test.js", note: "structured helper regression" });
    __testing.addReviewCycleCommand("IMP-201", {
      lens: "contract/state invariants",
      diff: "structured helper command output",
      risk: ["missing field mapping", "duplicate cycle formatting"],
      findings: "none",
      verification: "node --test coord/scripts/governance.test.js",
      verdict: "pass",
    });

    const record = __testing.readPlanRecord("IMP-201", { recordsDir });
    assert.equal(record.requirement_closure[0], "Ticket ask: normalize governance plan entry UX");
    assert.equal(record.feature_proof.includes("text:add-review-cycle"), true);
    assert.equal(record.repo_gates.includes("node --test coord/scripts/governance.test.js - structured helper regression"), true);
    assert.equal(record.self_review_cycles.length, 1);
    assert.equal(record.self_review_cycles[0].lens, "contract/state invariants");
    assert.deepEqual(record.self_review_cycles[0].risks, ["missing field mapping", "duplicate cycle formatting"]);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("setReviewCyclesCommand replaces the full self-review cycle set in one governed write", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-set-review-cycles-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  try {
    __testing.ensurePlanStub("IMP-202", "X", "codexa02");
    __testing.setReviewCyclesCommand("IMP-202", {
      reviewCycle: [
        "lens=contract/state invariants; diff=manual one; risks=state drift, parser mismatch; findings=none; verification=node test1; verdict=pass",
        "lens=auth/security/failure modes; diff=manual two; risks=auth drift, fallback failure; findings=none; verification=node test2; verdict=pass",
        "lens=tests/operability/performance; diff=manual three; risks=coverage gap, runtime stall; findings=none; verification=node test3; verdict=pass",
      ],
    });
    let record = __testing.readPlanRecord("IMP-202", { recordsDir });
    assert.equal(record.self_review_cycles.length, 3);
    assert.equal(record.self_review_cycles[0].lens, "contract/state invariants");

    __testing.setReviewCyclesCommand("IMP-202", {
      reviewCycle: [
        "lens=contract/state invariants; diff=replaced one; risks=contract drift, stale state; findings=none; verification=node new1; verdict=pass",
        "lens=auth/security/failure modes; diff=replaced two; risks=access drift, invalid fallback; findings=none; verification=node new2; verdict=pass",
        "lens=tests/operability/performance; diff=replaced three; risks=coverage loss, slow path; findings=none; verification=node new3; verdict=pass",
      ],
    });
    record = __testing.readPlanRecord("IMP-202", { recordsDir });
    assert.equal(record.self_review_cycles.length, 3);
    assert.equal(record.self_review_cycles[0].diff, "replaced one");
    assert.equal(record.self_review_cycles[2].verification, "node new3");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("dropFeatureProofCommand removes a canonical feature-proof entry without editing plan JSON by hand", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-drop-feature-proof-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  try {
    __testing.ensurePlanStub("IMP-203", "X", "codexa02");
    __testing.addFeatureProofCommand("IMP-203", { proofPath: "coord/scripts/governance.js" });
    __testing.addFeatureProofCommand("IMP-203", { proofText: "structured-helper" });
    let record = __testing.readPlanRecord("IMP-203", { recordsDir });
    assert.equal(record.feature_proof.includes("path:scripts/governance.js"), true);
    assert.equal(record.feature_proof.includes("text:structured-helper"), true);

    __testing.dropFeatureProofCommand("IMP-203", { proofText: "structured-helper" });
    record = __testing.readPlanRecord("IMP-203", { recordsDir });
    assert.equal(record.feature_proof.includes("path:scripts/governance.js"), true);
    assert.equal(record.feature_proof.includes("text:structured-helper"), false);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});
