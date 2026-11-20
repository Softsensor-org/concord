"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const { withScopedGovernanceTestContext } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const governanceContext = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));

const {
  DEFAULT_JOURNAL_RETENTION_POLICY,
  buildJournalHealthReport,
  classifyJournalHealth,
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

test("journal retention warning prints a chain head when the legacy report lacks its algorithm", () => {
  const message = formatJournalHealthWarning({
    status: "warning",
    warnings: [{ message: "retention threshold reached" }],
    event_count: 10,
    bytes: 4096,
    chain_head: "legacy-head",
    policy: { policy_path: "coord/product/JOURNAL_RETENTION_POLICY.md" },
  });
  assert.match(message, /chain head legacy-head\./);
  assert.doesNotMatch(message, /chain head [^ ]+:/, "no algorithm prefix is invented when absent");
});

// --- COORD-703 round 3: production WIRING, not a hand-supplied path ----------
//
// Every test above calls buildJournalHealthReport with an explicit journalPath,
// so all of them keep passing when the composition root stops supplying one —
// which is exactly what happened: dropping `journalPath` from lifecycle.js made
// the wired report return bytes: 0, and a 5,419,235-byte journal stopped
// tripping a 5 MiB warning threshold that should have been firing. The doctor
// tests could not catch it either, because they stub the health report whole
// rather than exercising the wiring that builds it.
//
// This test invokes the REAL composition-root closure, but supplies its own
// journal through the existing test path seam. Releases deliberately strip the
// donor journal, so existence and threshold coverage cannot depend on it.
test("COORD-703: the composition root wires a real journal path into the health report", () => {
  const doctorReportPath = resolveEngineModule(COORD_ROOT_DIR, "scripts/doctor-report.js");
  const lifecyclePath = resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js");
  const realCreateDoctorReport = require(doctorReportPath);
  const cachedLifecycle = require.cache[lifecyclePath];
  const defaults = governanceContext.DEFAULT_PATHS;
  const originalDefaultJournal = defaults.governanceEventLogPath;
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord753-journal-"));
  const journalPath = path.join(dir, "governance-events.ndjson");
  let wired = null;
  return withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOG_PATH: journalPath }, () => {
    try {
    require.cache[doctorReportPath].exports = (deps) => {
      wired = deps;
      return realCreateDoctorReport(deps);
    };
    delete require.cache[lifecyclePath];
    require(lifecyclePath);
    // The production byte-size closure reads configured DEFAULT_PATHS, while
    // journal readers use runtime state. Bind both to this one private fixture.
    defaults.governanceEventLogPath = journalPath;
    assert.ok(wired, "lifecycle.js must construct the actual doctor dependency object");
    assert.equal(typeof wired.buildJournalHealthReport, "function");
    // Exercise BOTH sides of the byte threshold rather than whichever side
    // today's donor history happens to occupy.
    for (const padding of [0, DEFAULT_JOURNAL_RETENTION_POLICY.warning_bytes + 256]) {
      fs.writeFileSync(journalPath, JSON.stringify({ command: "fixture", note: "x".repeat(padding) }) + "\n");
      const actualBytes = fs.statSync(journalPath).size;
      const report = wired.buildJournalHealthReport();
      assert.ok(actualBytes > 0);
      assert.equal(report.bytes, actualBytes, "removing the production journalPath injection must fail");
      const byteWarnings = report.warnings.filter((warning) => /journal byte size/.test(warning.message));
      assert.equal(byteWarnings.length, actualBytes >= report.policy.warning_bytes ? 1 : 0);
      if (byteWarnings.length) assert.ok(byteWarnings[0].message.includes(String(actualBytes)));
      const unwired = classifyJournalHealth({
        eventCount: 0, bytes: 0, chain: { ok: true, broken_events: 0 }, policy: report.policy,
      });
      assert.deepEqual(unwired.warnings.filter((warning) => /journal byte size/.test(warning.message)), []);
    }
    } finally {
      defaults.governanceEventLogPath = originalDefaultJournal;
      require.cache[doctorReportPath].exports = realCreateDoctorReport;
      if (cachedLifecycle) require.cache[lifecyclePath] = cachedLifecycle;
      else delete require.cache[lifecyclePath];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
