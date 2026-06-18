"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createGovernanceRepair = require("./governance-repair.js");

function build() {
  return createGovernanceRepair({
    getRows: () => [],
    readCanonicalTextFile: () => "",
  });
}

test("isStaleTicketLock flags locks whose heartbeat is older than 24h", () => {
  const r = build();
  const now = Date.parse("2026-06-13T12:00:00Z");
  assert.equal(r.isStaleTicketLock({ heartbeat_utc: "2026-06-11T12:00:00Z" }, now), true);
  assert.equal(r.isStaleTicketLock({ heartbeat_utc: "2026-06-13T11:00:00Z" }, now), false);
  assert.equal(r.isStaleTicketLock({}, now), false);
});

test("isRecoverableGovernanceDriftPath matches session + lock paths only", () => {
  const r = build();
  assert.equal(r.isRecoverableGovernanceDriftPath(".runtime/agent_sessions.json"), true);
  assert.equal(r.isRecoverableGovernanceDriftPath("locks/FE-1.lock"), true);
  assert.equal(r.isRecoverableGovernanceDriftPath(".runtime/locks/FE-1.lock"), true);
  assert.equal(r.isRecoverableGovernanceDriftPath("board/tasks.json"), false);
});

test("extractTicketIdsFromGovernanceIssues pulls unique ticket ids from messages", () => {
  const r = build();
  assert.deepEqual(
    r.extractTicketIdsFromGovernanceIssues([
      "Ticket COORD-7 broken; see FE-12",
      "COORD-7 again",
    ]).sort(),
    ["COORD-7", "FE-12"]
  );
  assert.deepEqual(r.extractTicketIdsFromGovernanceIssues([]), []);
});

test("classifyQuestionOperationalType categorizes question rows", () => {
  const r = build();
  assert.equal(r.classifyQuestionOperationalType({ question: "Governance drift observed while running start" }), "drift-note");
  assert.equal(r.classifyQuestionOperationalType({ question: "COORD-5 governance issue resolved: fixed" }), "repair");
  assert.equal(r.classifyQuestionOperationalType({ question: "blocked on X", resolved: "no" }), "blocker");
  assert.equal(r.classifyQuestionOperationalType({ question: "fyi", resolved: "yes" }), "informational");
});

test("parseTemplateFeedbackRowsFromText reads markdown table rows", () => {
  const r = build();
  const rows = r.parseTemplateFeedbackRowsFromText(
    "| Date | Finding |\n| --- | --- |\n| 2026-06-13 | COORD-1 lesson |\n"
  );
  assert.ok(Array.isArray(rows));
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const { __testing } = require("./governance-test-utils.js");


test("isRecoverableGovernanceDriftPath accepts runtime and legacy session/lock paths", () => {
  assert.equal(__testing.isRecoverableGovernanceDriftPath(".runtime/agent_sessions.json"), true);
  assert.equal(__testing.isRecoverableGovernanceDriftPath(".runtime/locks/IMP-311.lock"), true);
  assert.equal(__testing.isRecoverableGovernanceDriftPath("agent_sessions.json"), true);
  assert.equal(__testing.isRecoverableGovernanceDriftPath("locks/IMP-311.lock"), true);
  assert.equal(__testing.isRecoverableGovernanceDriftPath(".runtime/session-threads/anthropic.json"), false);
});
