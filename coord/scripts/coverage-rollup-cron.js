"use strict";

// COORD-243 — the TRIGGER layer of the coverage-maturity DETECT/DO/TRIGGER split.
//
// Design rule: doctor DETECTS, a verb DOES, a scheduler decides WHEN. This is the
// "decides WHEN" piece kept DELIBERATELY THIN — it is NOT a heavy scheduler. It is
// a single-shot runner the existing cron / burn-in infra (or a post-landing hook)
// invokes on a cadence; the cadence itself is owned by whatever schedules it (a
// crontab line, a CI nightly, or a post-finalize hook — see
// coord/docs/TESTING_AND_GATES.md "Coverage-maturity refresh cadence").
//
// It just calls the DO verb body (coverage-maturity.rollup) once and reports
// whether the refresh changed anything. Because the DO verb is IDEMPOTENT, running
// this more often than needed is harmless: a no-op rollup writes nothing.
//
// Wiring options (documented; pick one per deployment — see the runbook):
//   - crontab:   0 6 * * 1  cd <repo> && node coord/scripts/coverage-rollup-cron.js
//   - post-landing hook: invoke this after `gov finalize` lands a batch of tickets.
//   - CI nightly: a scheduled job that runs this and commits the refreshed file
//     through the governed sync lane.
//
// ZERO new runtime deps; pure node + the coverage-maturity DO engine.

const engine = require("./coverage-maturity.js");

// Run one rollup. Returns the engine result. `now` is injectable for tests; the
// live cron uses the wall clock. `write` defaults true (the cron's whole purpose
// is to refresh the artifact on cadence).
function runScheduledRollup({ now = new Date().toISOString(), write = true } = {}) {
  return engine.rollup({ now, write });
}

module.exports = { runScheduledRollup };

if (require.main === module) {
  const result = runScheduledRollup({});
  process.stdout.write(
    `[coverage-rollup-cron] ${result.changed ? "refreshed TEST_MATURITY.md" : "no change (idempotent)"} ` +
      `— gate ${result.inputs.gate.failing_cycles}/${result.inputs.gate.total_cycles} failing, ` +
      `${result.inputs.recovery_events} recoveries.\n`
  );
}
