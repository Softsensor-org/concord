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

test("feedback alerts distinguish unknown completion dates, future clocks, and stale completion", () => {
  const rows = [
    { ID: "COORD-901", Repo: "X", Status: "done", Type: "bug", Description: "Governance repair" },
    { ID: "COORD-902", Repo: "X", Status: "done", Type: "bug", Description: "Governance repair" },
    { ID: "COORD-903", Repo: "X", Status: "done", Type: "bug", Description: "Governance repair" },
  ];
  const r = createGovernanceRepair({ getRows: () => rows, readCanonicalTextFile: () => "" });
  const events = [
    { ticket: "COORD-902", after_status: "done", ts: "2026-01-11T00:00:00Z" },
    { ticket: "COORD-903", after_status: "done", ts: "2026-01-01T00:00:00Z" },
  ];
  const options = { now: new Date("2026-01-10T00:00:00Z"), feedbackRows: [] };
  const alerts = r.collectTemplateFeedbackAlerts({}, events, options);
  assert.deepEqual(alerts.map(({ ticket, done_at, age_days, stale }) => ({ ticket, done_at, age_days, stale })), [
    { ticket: "COORD-901", done_at: null, age_days: null, stale: false },
    { ticket: "COORD-902", done_at: "2026-01-11T00:00:00.000Z", age_days: 0, stale: false },
    { ticket: "COORD-903", done_at: "2026-01-01T00:00:00.000Z", age_days: 9, stale: true },
  ]);
  assert.deepEqual(r.collectTemplateFeedbackAlerts({}, events, {
    ...options, feedbackRows: [{ ticket_refs: ["COORD-901", "COORD-902", "COORD-903"] }],
  }), []);
});

test("feedback diagnostics normalize absent descriptions in malformed historical metadata", () => {
  const r = build();
  const alerts = r.collectTemplateFeedbackAlerts({}, [], {
    rows: [{ ID: "COORD-904", Repo: "X", Status: "done", Type: "governance" }],
    feedbackRows: [], now: new Date("2026-01-10T00:00:00Z"),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].description, "");
  assert.equal(alerts[0].done_at, null);
});

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

test("isRecoverableGovernanceDriftPath accepts runtime and legacy session/lock paths", () => {
  assert.equal(build().isRecoverableGovernanceDriftPath(".runtime/agent_sessions.json"), true);
  assert.equal(build().isRecoverableGovernanceDriftPath(".runtime/locks/IMP-311.lock"), true);
  assert.equal(build().isRecoverableGovernanceDriftPath("agent_sessions.json"), true);
  assert.equal(build().isRecoverableGovernanceDriftPath("locks/IMP-311.lock"), true);
  assert.equal(build().isRecoverableGovernanceDriftPath(".runtime/session-threads/anthropic.json"), false);
});

test("COORD-722: baselineEventFields re-records the baseline snapshot, else its digest, else nothing", () => {
  const snapshot = { digest: "a".repeat(40), files: [] };
  assert.deepStrictEqual(createGovernanceRepair.baselineEventFields({ snapshot, expectedDigest: "b".repeat(40) }), { snapshot });
  assert.deepStrictEqual(createGovernanceRepair.baselineEventFields({ snapshot: null, expectedDigest: "b".repeat(40) }),
    { snapshot_digest: "b".repeat(40) });
  // An uninitialized journal has neither a snapshot nor a digest: the event
  // carries no baseline field rather than adopting on-disk state.
  assert.deepStrictEqual(createGovernanceRepair.baselineEventFields({ snapshot: null, expectedDigest: null }), {});
  assert.deepStrictEqual(createGovernanceRepair.baselineEventFields(), {});
});
