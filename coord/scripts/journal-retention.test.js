"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_JOURNAL_RETENTION_POLICY,
  buildJournalHealthReport,
  formatJournalHealthWarning,
} = require("./journal-retention.js");

test("journal health is ok below retention thresholds with a clean chain", () => {
  const report = buildJournalHealthReport({
    journalPath: "/tmp/missing-governance-events.ndjson",
    readGovernanceEventLog: () => [{ command: "a" }, { command: "b" }],
    verifyGovernanceChain: () => ({
      ok: true,
      chainedCount: 2,
      preChainCount: 0,
      chainHead: "abc123",
      chainHeadAlg: "sha256",
      broken: [],
    }),
    statSync: () => ({ size: 1024 }),
    policy: {
      ...DEFAULT_JOURNAL_RETENTION_POLICY,
      warning_events: 10,
      warning_bytes: 4096,
    },
  });

  assert.equal(report.status, "ok");
  assert.equal(report.event_count, 2);
  assert.equal(report.chained_events, 2);
  assert.equal(formatJournalHealthWarning(report), null);
});

test("journal health warns when event count crosses the retention threshold", () => {
  const report = buildJournalHealthReport({
    journalPath: "/tmp/governance-events.ndjson",
    readGovernanceEventLog: () => Array.from({ length: 5 }, (_, i) => ({ command: `event-${i}` })),
    verifyGovernanceChain: () => ({
      ok: true,
      chainedCount: 5,
      preChainCount: 0,
      chainHead: "def456",
      chainHeadAlg: "sha256",
      broken: [],
    }),
    statSync: () => ({ size: 2048 }),
    policy: {
      ...DEFAULT_JOURNAL_RETENTION_POLICY,
      warning_events: 5,
      critical_events: 20,
      warning_bytes: 4096,
      critical_bytes: 8192,
    },
  });

  assert.equal(report.status, "warning");
  assert.equal(report.rotation.recommended, true);
  const message = formatJournalHealthWarning(report);
  assert.match(message, /\[journal-retention\] warning/);
  assert.match(message, /event count 5 exceeds warning threshold 5/);
  assert.match(message, /coord\/product\/JOURNAL_RETENTION_POLICY\.md/);
  assert.match(message, /verify-engine \+ seal must pass/);
});

test("journal health is critical when the chain is broken", () => {
  const report = buildJournalHealthReport({
    readGovernanceEventLog: () => [{ command: "a" }],
    verifyGovernanceChain: () => ({ ok: false, chainedCount: 1, preChainCount: 0, broken: [{ index: 1 }] }),
    policy: DEFAULT_JOURNAL_RETENTION_POLICY,
  });

  assert.equal(report.status, "critical");
  assert.equal(report.rotation.required, true);
  assert.match(formatJournalHealthWarning(report), /hash-chain verification is not clean/);
});
