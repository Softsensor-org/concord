"use strict";

// COORD-286 — the TRIGGER (WHEN) layer of the quality-scan auto-ticketing split,
// mirroring the COORD-243 detect/do/trigger separation.
//
// Design rule: arch-checks DETECTS, quality-scan DOES (files), a scheduler decides
// WHEN. This is the "decides WHEN" piece, kept DELIBERATELY THIN — it is NOT a
// daemon or a live scheduler. It is a single-shot runner that the existing cron /
// CI infra (or a post-landing hook) invokes on a cadence; the cadence itself is
// owned by whatever schedules it (a crontab line or a GH-Actions nightly — see
// coord/product/QUALITY_AUTOMATION.md "Cadence").
//
// It runs the scan-and-propose ONCE in the CADENCE shape:
//   gov quality-scan --severity-floor warn --cap <N> --apply --propose
// i.e. it surfaces the warn-class debt backlog as `proposed` (quarantined)
// tickets, in bounded batches, that a human must `gov approve` / `gov reject`.
// Because the filer DEDUPS (the [qkey:...] marker counts proposed rows too),
// running this more often than needed is harmless: an already-queued proposal is
// not re-filed.
//
// ZERO new runtime deps; pure node + the quality-scan DO engine.

const qs = require("./quality-scan.js");

// Run one scan-and-propose. Returns the runCli exit code (0 = ok, non-0 = a gov
// filing failed). `runner` and `io` are injectable for tests; the live cron uses
// the real spawnSync + process streams. Defaults match the documented cadence:
// warn floor, small cap, --apply, --propose.
function runScheduledProposal(
  { root, board, severityFloor = "warn", cap = 3, apply = true } = {},
  io = {},
  runner
) {
  const argv = ["--severity-floor", severityFloor, "--cap", String(cap), "--propose"];
  if (root) argv.push("--root", root);
  if (board) argv.push("--board", board);
  if (apply) argv.push("--apply");
  return runner ? qs.runCli(argv, io, runner) : qs.runCli(argv, io);
}

module.exports = { runScheduledProposal };

if (require.main === module) {
  process.exitCode = runScheduledProposal({});
}
