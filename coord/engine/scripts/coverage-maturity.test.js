"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-243: tests for the coverage-maturity DETECT / DO / TRIGGER split.
//   - DETECT (doctor's read-only check): fires the staleness line when
//     TEST_MATURITY is old by TIME or ACTIVITY, and PROVABLY mutates nothing /
//     runs no tool (we pass inline strings and a fixture dir and assert no write).
//   - DO (gov coverage-rollup): refreshes Last updated + a History row from real
//     fixture artifacts, and is idempotent (a same-date re-run reaches a byte-
//     stable fixpoint).
//   - TRIGGER (coverage-rollup-cron): invokes the DO verb (not doctor).

const test = require("node:test");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cm = require("./coverage-maturity.js");
const { evidenceRef, stableSupersessionId } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));

test("coverage rollups ignore a superseded gate result", () => {
  const old = "coverage=pass min=80 branch=old lowest=91.0";
  const successor = "TODO: coverage result not rerun";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const signals = cm.parseGateDimensionSignals({ ticket_id: "T-713", repo_gates: [old, successor], evidence_supersessions: [{
    id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
    successor_ref: successorRef, reason: "The result was tied to an old head.", actor: "fixture",
    timestamp: "2026-10-05T00:00:00.000Z",
  }] });
  assert.deepEqual(signals, []);
});

test("coverage maturity parses active coverage and mutation signals, including a missing mutation score", () => {
  const old = "coverage=pass min=80 branch=old lowest=99.0; mutation=pass min=60 score=90";
  const successor = "coverage=fail min=80 lines=91 branches=70 lowest=70.0; mutation=fail min=60";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  assert.deepEqual(cm.parseGateDimensionSignals({
    ticket_id: "T-713", repo_gates: [old, successor],
    evidence_supersessions: [{ id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
      successor_ref: successorRef, reason: "Old result is stale.", actor: "fixture", timestamp: "2026-10-05T00:00:00.000Z" }],
  }), [
    { ticket: "T-713", kind: "coverage", result: "fail", min: 80, lowest: 70 },
    { ticket: "T-713", kind: "mutation", result: "fail", min: 60, lowest: null },
  ]);
  assert.deepEqual(cm.parseGateDimensionSignals(null), []);
  assert.throws(() => cm.parseGateDimensionSignals({ ticket_id: "T-713", repo_gates: [{ coverage: "pass" }] }), /repo_gates must be an array of strings/);
});

test("activity counts distinct tickets from either landing event shape only", () => {
  const since = Date.parse("2026-06-30T00:00:00.000Z");
  const journalText = [
    { command: "mark-done", ticket: "T-1", ts: "2026-06-30T12:00:00.000Z" },
    { command: "finalize", ticket: "T-1", after_status: "done", ts: "2026-06-30T13:00:00.000Z" },
    { command: "reconcile", ticket: "T-2", after_status: "done", ts: "2026-06-30T14:00:00.000Z" },
    { command: "set-status", ticket: "T-3", after_status: "doing", ts: "2026-06-30T15:00:00.000Z" },
    { command: "reconcile", after_status: "done", ts: "2026-06-30T16:00:00.000Z" },
  ].map((event) => JSON.stringify(event)).join("\n");

  assert.equal(cm.countLandingsSince(journalText, since), 2,
    "a mark-done and another done transition count once per ticket; nonlandings and missing tickets do not count");
});

test("coverage-maturity CLI without a verb prints its usage", () => {
  const { execFileSync } = require("node:child_process");
  const stdout = execFileSync(process.execPath, [path.join(__dirname, "coverage-maturity.js")], { encoding: "utf8" });
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /detect/);
});

function coverageMaturityCliFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covmat-cli-"));
  const fixtureCoord = path.join(root, "coord");
  const fixtureMaturity = path.join(fixtureCoord, "TEST_MATURITY.md");
  const fixtureJournal = path.join(fixtureCoord, ".runtime", "governance-events.ndjson");
  const fixturePlans = path.join(fixtureCoord, ".runtime", "plans");
  const fixtureBoard = path.join(fixtureCoord, "board", "tasks.json");
  const preloadPath = path.join(root, "fixture-preload.cjs");
  fs.mkdirSync(fixturePlans, { recursive: true });
  fs.mkdirSync(path.dirname(fixtureJournal), { recursive: true });
  fs.mkdirSync(path.dirname(fixtureBoard), { recursive: true });
  fs.writeFileSync(fixtureMaturity, maturityFixture("2026-01-01"), "utf8");
  fs.writeFileSync(fixtureJournal, "", "utf8");
  fs.writeFileSync(fixtureBoard, JSON.stringify({ sections: [] }), "utf8");

  const donorPaths = {
    [path.resolve(__dirname, "..", "..", "TEST_MATURITY.md")]: fixtureMaturity,
    [path.resolve(__dirname, "..", "..", ".runtime", "governance-events.ndjson")]: fixtureJournal,
    [path.resolve(__dirname, "..", "..", ".runtime", "plans")]: fixturePlans,
    [path.resolve(__dirname, "..", "..", "board", "tasks.json")]: fixtureBoard,
  };
  fs.writeFileSync(preloadPath, `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const mappings = JSON.parse(process.env.COVMAT_FIXTURE_MAP || "{}");
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalReaddirSync = fs.readdirSync.bind(fs);
    function fixturePath(value) {
      const absolute = path.resolve(String(value));
      if (Object.prototype.hasOwnProperty.call(mappings, absolute)) return mappings[absolute];
      const plansRoot = ${JSON.stringify(path.resolve(__dirname, "..", "..", ".runtime", "plans"))};
      if (absolute.startsWith(plansRoot + path.sep)) {
        return path.join(mappings[plansRoot], path.relative(plansRoot, absolute));
      }
      return value;
    }
    fs.existsSync = (value) => originalExistsSync(fixturePath(value));
    fs.readFileSync = (value, ...args) => originalReadFileSync(fixturePath(value), ...args);
    fs.writeFileSync = (value, ...args) => originalWriteFileSync(fixturePath(value), ...args);
    fs.readdirSync = (value, ...args) => originalReaddirSync(fixturePath(value), ...args);
  `);
  return { root, fixtureMaturity, preloadPath, donorPaths, fixturePlans };
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  if (!fs.lstatSync(root).isDirectory()) return fs.readFileSync(root);
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => [
    name,
    snapshotTree(path.join(root, name)),
  ]));
}

function mutationPlanRecord(repoGate) {
  return {
    schema_version: 1,
    ticket_id: "COORD-713",
    startup_checklist: [],
    traceability_gate: [],
    governance: {
      expected_closeout: { method: "no_pr", base_ref: "main" },
      ticket_local_repairs: [],
    },
    baseline_reproduction: [],
    intended_files: [],
    change_summary: [],
    verification_commands: [],
    critical_invariants: [],
    requirement_closure: [],
    feature_proof: [],
    repo_gates: [repoGate],
    self_review_cycles: [],
    rollback_strategy: [],
  };
}

test("coverage-maturity public CLI detects, refreshes, and reaches an idempotent rollup on isolated fixture paths", (t) => {
  const fixture = coverageMaturityCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = Object.fromEntries(Object.keys(fixture.donorPaths).map((file) => [file, snapshotTree(file)]));
  const run = (verb) => spawnSync(process.execPath, ["--require", fixture.preloadPath, path.join(__dirname, "coverage-maturity.js"), verb], {
    cwd: fixture.root,
    encoding: "utf8",
    env: { ...process.env, COVMAT_FIXTURE_MAP: JSON.stringify(fixture.donorPaths) },
    timeout: 15000,
  });

  const detect = run("detect");
  assert.equal(detect.status, 0, detect.stderr);
  assert.match(detect.stdout, /TEST_MATURITY\.md.*stale/i);
  const rollup = run("rollup");
  assert.equal(rollup.status, 0, rollup.stderr);
  assert.match(rollup.stdout, /^coverage-rollup: refreshed /);
  assert.doesNotMatch(rollup.stdout, /, mutation /, "rollup omits the optional mutation suffix when no mutation artifact exists");
  assert.match(fs.readFileSync(fixture.fixtureMaturity, "utf8"), /^Last updated: \d{4}-\d{2}-\d{2}/m);

  // A complete plan record supplies the optional mutation summary consumed by
  // the source-preserving CLI path, including the output suffix in main().
  const planPath = path.join(fixture.fixturePlans, "COORD-713.json");
  fs.writeFileSync(planPath, JSON.stringify(
    mutationPlanRecord("node --test [result=pass; mutation=pass min=60 score=72.5]"),
    null,
    2
  ) + "\n", "utf8");
  const mutationRollup = run("rollup");
  assert.equal(mutationRollup.status, 0, mutationRollup.stderr);
  assert.match(mutationRollup.stdout, /^coverage-rollup: refreshed /);
  assert.match(mutationRollup.stdout, /, mutation pass\./, "a real mutation artifact is included in CLI rollup output");
  assert.match(fs.readFileSync(fixture.fixtureMaturity, "utf8"), /mutation pass score=72\.5/);

  // A mutation result without a score still appears in the health note, but
  // must not rewrite the mutation dimension's existing score or trend.
  const maturityAfterScoredPass = fs.readFileSync(fixture.fixtureMaturity, "utf8");
  const mutationRow = (text) => text.split("\n").find((line) => /^\|\s*Correctness \(mutation\)/.test(line));
  fs.writeFileSync(planPath, JSON.stringify(
    mutationPlanRecord("node --test [result=pass; mutation=pass min=60]"),
    null,
    2
  ) + "\n", "utf8");
  const unscoredMutationRollup = run("rollup");
  assert.equal(unscoredMutationRollup.status, 0, unscoredMutationRollup.stderr);
  assert.match(unscoredMutationRollup.stdout, /, mutation pass\./);
  const maturityAfterUnscoredMutation = fs.readFileSync(fixture.fixtureMaturity, "utf8");
  assert.match(maturityAfterUnscoredMutation, /gate-health: .*; mutation pass\)/);
  assert.doesNotMatch(maturityAfterUnscoredMutation, /gate-health: .*; mutation pass score=/);
  assert.equal(mutationRow(maturityAfterUnscoredMutation), mutationRow(maturityAfterScoredPass),
    "an unscored mutation result preserves the existing mutation dimension row");
  const fresh = run("detect");
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /TEST_MATURITY\.md is fresh/);

  // A scored failure updates all live mutation cells while preserving the
  // source-cited Evidence cell from the maturity tracker.
  fs.writeFileSync(planPath, JSON.stringify(
    mutationPlanRecord("node --test [result=fail; mutation=fail min=60 score=45]"),
    null,
    2
  ) + "\n", "utf8");
  const failedMutationRollup = run("rollup");
  assert.equal(failedMutationRollup.status, 0, failedMutationRollup.stderr);
  assert.match(failedMutationRollup.stdout, /, mutation fail\./);
  const maturityAfterFailedMutation = fs.readFileSync(fixture.fixtureMaturity, "utf8");
  assert.match(maturityAfterFailedMutation, /gate-health: .*; mutation fail score=45\)/);
  const failedMutationLine = mutationRow(maturityAfterFailedMutation);
  assert.ok(failedMutationLine, "the mutation coverage row remains present");
  const failedMutationCells = failedMutationLine.split("|");
  assert.equal(failedMutationCells[2].trim(), "BELOW MIN");
  assert.equal(failedMutationCells[4].trim(), "**45%**");
  assert.equal(failedMutationCells[5].trim(), "↓ (min 60)");
  assert.equal(failedMutationCells[6].trim(), "coord/engine/scripts/journal.js", "the source-cited Evidence cell remains unchanged");
  const belowThreshold = run("detect");
  assert.equal(belowThreshold.status, 0, belowThreshold.stderr);
  assert.match(belowThreshold.stdout, /coverage maturity: mutation dimension below threshold \(COORD-713: 45 < min 60\)/);
  assert.match(belowThreshold.stdout, /run `\/test-strategy` or `coord\/scripts\/gov coverage-rollup` and harden the failing dimension\./);
  const repeated = run("rollup");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /^coverage-rollup: no change \(idempotent\)/);
  assert.match(repeated.stdout, /, mutation fail\./);
  for (const [file, before] of Object.entries(sourceBefore)) {
    assert.deepEqual(snapshotTree(file), before, `public CLI must leave donor path unchanged: ${file}`);
  }
});

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
    "| Correctness (mutation) | ACTIVE | engine | 65.25% | baseline | coord/engine/scripts/journal.js |",
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

test("DETECT flags a measured below-min score even when the gate result says pass", () => {
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture("2026-06-30"),
    now: Date.parse("2026-06-30T12:00:00.000Z"),
    gateSignals: [
      { ticket: "COORD-901", kind: "mutation", result: "pass", min: 60, lowest: 45 },
    ],
  });

  assert.equal(findings.length, 1);
  assert.match(findings[0], /mutation dimension below threshold \(COORD-901: 45 < min 60\)/);
});

test("DETECT does not infer a below-threshold result when score or minimum is unknown", () => {
  const findings = cm.detectMaturityStaleness({
    maturityText: maturityFixture("2026-06-30"),
    now: Date.parse("2026-06-30T12:00:00.000Z"),
    gateSignals: [
      { ticket: "COORD-902", kind: "mutation", result: "pass", min: 60, lowest: null },
      { ticket: "COORD-903", kind: "coverage", result: "pass", min: null, lowest: 45 },
    ],
  });

  assert.deepEqual(findings, [], "a threshold alert needs either an explicit fail result or both comparable numeric values");
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

test("COORD-866: DO refuses a missing maturity document instead of fabricating one", () => {
  const { maturityPath, plansDir, journalPath } = writeRollupFixture();
  const missingPath = path.join(path.dirname(maturityPath), "MISSING_MATURITY.md");
  assert.throws(() => cm.rollup({
    maturityPath: missingPath,
    plansDir,
    journalPath,
    insightsReport: fixtureInsightsReport(),
    now: "2026-06-25T00:00:00.000Z",
    write: false,
  }), /TEST_MATURITY\.md is missing\/empty; seed it via \/test-strategy/);
  assert.equal(fs.existsSync(missingPath), false, "a refused rollup never creates the file");
});
