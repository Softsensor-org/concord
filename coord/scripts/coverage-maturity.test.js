"use strict";

// COORD-243: tests for the coverage-maturity DETECT / DO / TRIGGER split.
//   - DETECT (doctor's read-only check): fires the staleness line when
//     TEST_MATURITY is old by TIME or ACTIVITY, and PROVABLY mutates nothing /
//     runs no tool (we pass inline strings and a fixture dir and assert no write).
//   - DO (gov coverage-rollup): refreshes Last updated + a History row from real
//     fixture artifacts, and is idempotent (a same-date re-run reaches a byte-
//     stable fixpoint).
//   - TRIGGER (coverage-rollup-cron): invokes the DO verb (not doctor).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cm = require("./coverage-maturity.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function maturityFixture(lastUpdated) {
  return [
    "# Test Maturity Tracker",
    "",
    `Last updated: ${lastUpdated} (seed note)`,
    "",
    "## Dimension Coverage",
    "",
    "| Dimension | Covered | Required | Pct | Trend | Evidence |",
    "|-----------|---------|----------|-----|-------|----------|",
    "| Correctness (mutation) | ACTIVE | engine | 65.25% | baseline | journal.js |",
    "",
    "## History",
    "",
    "| Date | Score | Tickets Since Last | Top Gap Closed |",
    "|------|-------|--------------------|----------------|",
    "| 2026-06-01 | 68 | first run | baseline |",
    "",
  ].join("\n");
}

// A journal with N done events all stamped at `ts`.
function journalFixture(ts, count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({ command: "mark-done", ticket: `T-${i}`, after_status: "done", ts }));
  }
  return lines.join("\n") + "\n";
}

// =============================================================================
// DETECT
// =============================================================================

test("DETECT fires by TIME when Last updated is older than the day threshold", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture("2026-06-01"),
    journalText: "",
    now,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /TEST_MATURITY\.md stale/);
  assert.match(findings[0], /\d+d old/);
  assert.match(findings[0], /coverage-rollup/);
});

test("DETECT fires by ACTIVITY when many tickets landed since Last updated", () => {
  const lastUpdated = "2026-06-30";
  const now = Date.parse("2026-07-01T00:00:00.000Z"); // only 1 day old -> not time-stale
  const journalText = journalFixture("2026-06-30T12:00:00.000Z", 40); // 40 > 25 default
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture(lastUpdated),
    journalText,
    now,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /tickets landed since/);
});

test("DETECT stays silent for a fresh, low-activity maturity file", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture("2026-06-30"),
    journalText: journalFixture("2026-06-30T12:00:00.000Z", 3),
    now,
  });
  assert.deepEqual(findings, []);
});

test("DETECT surfaces a below-threshold coverage dimension as one actionable line", () => {
  const now = Date.parse("2026-06-30T00:00:00.000Z");
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture("2026-06-30"),
    journalText: "",
    now,
    gateSignals: [
      { ticket: "COORD-900", kind: "coverage", result: "fail", min: 80, lowest: 61.5 },
    ],
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /coverage dimension below threshold/);
  assert.match(findings[0], /COORD-900/);
});

test("DETECT flags a missing/empty maturity file", () => {
  const findings = cm.detectMaturityStaleness({ maturityText: "", now: Date.now() });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /missing or empty/);
});

test("DETECT from disk is READ-ONLY: it never writes the maturity file or any artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covmat-detect-"));
  const maturityPath = path.join(dir, "TEST_MATURITY.md");
  const journalPath = path.join(dir, "journal.ndjson");
  const plansDir = path.join(dir, "plans");
  fs.mkdirSync(plansDir);
  const before = maturityFixture("2026-01-01"); // very old -> would-be-stale
  fs.writeFileSync(maturityPath, before, "utf8");
  fs.writeFileSync(journalPath, journalFixture("2026-01-01T00:00:00.000Z", 30), "utf8");

  const beforeMtime = fs.statSync(maturityPath).mtimeMs;
  const findings = cm.detectMaturityStalenessFromDisk({
    maturityPath,
    journalPath,
    plansDir,
    now: Date.parse("2026-07-01T00:00:00.000Z"),
  });

  assert.ok(findings.length >= 1, "expected a staleness finding on an old file");
  // PROOF of read-only: contents byte-identical and mtime unchanged; no plan file created.
  assert.equal(fs.readFileSync(maturityPath, "utf8"), before);
  assert.equal(fs.statSync(maturityPath).mtimeMs, beforeMtime);
  assert.deepEqual(fs.readdirSync(plansDir), []);
});

test("DETECT from disk is fast (well under a second on a realistic fixture)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covmat-fast-"));
  const maturityPath = path.join(dir, "TEST_MATURITY.md");
  const journalPath = path.join(dir, "journal.ndjson");
  fs.writeFileSync(maturityPath, maturityFixture("2026-06-01"), "utf8");
  fs.writeFileSync(journalPath, journalFixture("2026-06-15T00:00:00.000Z", 500), "utf8");
  const start = process.hrtime.bigint();
  cm.detectMaturityStalenessFromDisk({ maturityPath, journalPath, plansDir: path.join(dir, "none"), now: Date.now() });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `DETECT took ${ms}ms, expected < 500ms`);
});

// =============================================================================
// DO — gov coverage-rollup
// =============================================================================

function fixtureInsightsReport({ totalCycles = 100, failingCycles = 3, recoveries = 2 } = {}) {
  return {
    chain_head: "deadbeef",
    sections: {
      gate_review_recovery_health_by_repo: {
        claims: [
          {
            repo: "X",
            gate: { total_review_cycles: totalCycles, failing_review_cycles: failingCycles },
            recovery: { recovery_events: recoveries },
          },
        ],
      },
    },
  };
}

function writeRollupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covmat-rollup-"));
  const maturityPath = path.join(dir, "TEST_MATURITY.md");
  const plansDir = path.join(dir, "plans");
  const journalPath = path.join(dir, "journal.ndjson");
  fs.mkdirSync(plansDir);
  fs.writeFileSync(maturityPath, maturityFixture("2026-06-01"), "utf8");
  fs.writeFileSync(journalPath, journalFixture("2026-06-10T00:00:00.000Z", 7), "utf8");
  // A real-shaped plan record carrying a QGATE-003 coverage gate signal.
  fs.writeFileSync(
    path.join(plansDir, "COORD-077.json"),
    JSON.stringify({
      ticket_id: "COORD-077",
      repo_gates: ["node --test [result=pass; coverage=pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91]"],
    }),
    "utf8"
  );
  return { dir, maturityPath, plansDir, journalPath };
}

test("DO refreshes Last updated + appends a History row from real fixture artifacts", () => {
  const { maturityPath, plansDir, journalPath } = writeRollupFixture();
  const res = cm.rollup({
    maturityPath,
    plansDir,
    journalPath,
    insightsReport: fixtureInsightsReport(),
    now: "2026-06-25T00:00:00.000Z",
  });
  assert.equal(res.changed, true);
  const text = fs.readFileSync(maturityPath, "utf8");
  assert.match(text, /^Last updated: 2026-06-25 \(gate-health:/m);
  // History row from real data: 7 landings since 2026-06-01.
  assert.match(text, /\| 2026-06-25 \| rollup \| 7 \| auto coverage-rollup:/);
  // Sourced the coverage signal from the plan record.
  assert.match(text, /coverage pass lowest=90\.91/);
});

test("DO is idempotent: a same-date re-run reaches a byte-stable fixpoint", () => {
  const { maturityPath, plansDir, journalPath } = writeRollupFixture();
  const opts = {
    maturityPath,
    plansDir,
    journalPath,
    insightsReport: fixtureInsightsReport(),
    now: "2026-06-25T00:00:00.000Z",
  };
  cm.rollup(opts); // run 1: moves Last updated to 2026-06-25
  cm.rollup(opts); // run 2: now-stable window
  const after2 = fs.readFileSync(maturityPath, "utf8");
  cm.rollup(opts); // run 3
  const after3 = fs.readFileSync(maturityPath, "utf8");
  assert.equal(after3, after2, "rollup must reach a byte-stable fixpoint");
  // The History table must not grow on re-run: exactly one rollup row for the date.
  const rollupRows = after3.split("\n").filter((l) => /^\| 2026-06-25 \| rollup \|/.test(l));
  assert.equal(rollupRows.length, 1);
});

test("DO --dry-run computes without writing", () => {
  const { maturityPath, plansDir, journalPath } = writeRollupFixture();
  const before = fs.readFileSync(maturityPath, "utf8");
  const res = cm.rollup({
    maturityPath,
    plansDir,
    journalPath,
    insightsReport: fixtureInsightsReport(),
    now: "2026-06-25T00:00:00.000Z",
    write: false,
  });
  assert.equal(res.changed, true); // content WOULD change
  assert.equal(fs.readFileSync(maturityPath, "utf8"), before); // but file untouched
});

test("DO refuses to roll up a missing/empty maturity file (must be seeded by /test-strategy first)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covmat-empty-"));
  const maturityPath = path.join(dir, "TEST_MATURITY.md");
  fs.writeFileSync(maturityPath, "", "utf8");
  assert.throws(
    () => cm.rollup({ maturityPath, plansDir: path.join(dir, "p"), journalPath: path.join(dir, "j"), insightsReport: fixtureInsightsReport(), now: "2026-06-25T00:00:00.000Z" }),
    /missing\/empty/
  );
});

// =============================================================================
// TRIGGER — coverage-rollup-cron
// =============================================================================

test("TRIGGER (cron runner) invokes the DO verb, not doctor", () => {
  const { maturityPath } = writeRollupFixture();
  // Monkeypatch the DO engine's rollup to assert the trigger calls IT.
  const engine = require("./coverage-maturity.js");
  const original = engine.rollup;
  let called = null;
  engine.rollup = (opts) => {
    called = opts;
    return { outputPath: maturityPath, changed: false, inputs: { gate: { failing_cycles: 0, total_cycles: 0 }, recovery_events: 0 } };
  };
  try {
    const cron = require("./coverage-rollup-cron.js");
    const res = cron.runScheduledRollup({ now: "2026-06-25T00:00:00.000Z" });
    assert.ok(called, "cron must call the DO rollup engine");
    assert.equal(called.now, "2026-06-25T00:00:00.000Z");
    assert.equal(called.write, true);
    assert.equal(res.changed, false);
  } finally {
    engine.rollup = original;
  }
});
