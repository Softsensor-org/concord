# Gate profile, 2026-11-14 (COORD-1006)

Evidence for COORD-1006 (batch 2 of COORD-997). No code change in this record.

## Method

- Command, one suite per run, in the foreground:
  `node coord/scripts/test-runner.js --profile-costs --file <suite> --report <json>`
- Host: this shared server, Node 22.8.0 (`/mnt/disk/shared/node/v22/bin`). Same host and same session for all rows.
- Base: `origin/dev` at af77c938 (the worktree base). Later dev commits do not change these suites' sources.
- Columns: `wall_ms` is the process wall time; `child_cli_count` is the number of child CLI spawns recorded by `test-cost-probe` (nested spawns count at each level).
- Load was about 4.5 to 5.1 (1-minute average) during the runs. Timings are therefore indicative, not benchmark-grade.

## Before table (9 suites)

| Suite (ticket) | Wall (s) | Child CLI spawns | Tests pass/total | Notes |
|---|---|---|---|---|
| coord/engine/scripts/missing-ticket-lock.test.js (COORD-997 / COORD-767) | 316.1 | 1,428 | 64/64 | Slice 1 shared fixture already applied |
| coord/engine/scripts/runtime-authority-lifecycle.test.js (COORD-798) | 120.2 | 1,884 | 12/12 | Full governed lifecycles through the CLI |
| coord/engine/scripts/governance-context.test.js (COORD-570, COORD-754) | 78.6 | 44 | 62/62 | Time is in-process work, not spawns |
| coord/scripts/context-pack-ack-authoring.test.js (COORD-557) | 26.8 | 130 | pass | |
| coord/engine/scripts/session-lifecycle-mutations.test.js (COORD-857) | 23.3 | 198 | 6/9 | 3 failures are on DEV-BASELINE.md (COORD-852 x2, COORD-857) |
| coord/engine/scripts/test-runner.test.js (COORD-754) | 15.9 | 333 | pass | |
| coord/engine/scripts/agent-commands.test.js (COORD-723) | 7.6 | 715 | 65/65 | |
| coord/engine/scripts/coord-ui-launch.test.js (COORD-754) | 3.2 | 22 | 7/7 | |
| coord/engine/scripts/runtime-cleanup.test.js (COORD-570) | 1.1 | 25 | 36/36 | |

Not profiled: coord/scripts/context-pack-ack-lifecycle.test.js (COORD-723 sibling).

Totals for the nine profiled suites: about 630 s of wall time and about 4,060 child CLI spawns. missing-ticket-lock and runtime-authority-lifecycle account for about 70 percent of the wall time.

## Spawn analysis of missing-ticket-lock

- The file has 64 tests in 15 or so groups. Almost every spawn is a governed verb: `claim`, `recover`, `reconcile`, `start`, `file-ticket`, `agent-release`, `plan`, `register-prompt`, `sync`, `resume`, `agentid`.
- Most tests check the resulting journal, lock and board state after the call, not only the exit status, so they are state-changing checks.
- Read-only spawns are few: `agent-status` (three call sites). Assertions that check exit codes or stderr are on refusal paths.
- The fixture seed (COORD-997) already removes the repeated setup from each test.
- Converting a spawn to a direct call requires a verified in-process entry point for that verb, plus proof that the test's assertions keep their meaning. That was not verified in this batch, so no conversion was made.

## Candidates for the next batch

1. **runtime-authority-lifecycle.test.js**: 1,884 spawns and 120 s. Its 12 tests drive full governed lifecycles through a `spawnSync` helper. A named end-to-end set (exit codes, stderr, the COORD-880/883 env scrub and at least one full lifecycle) should stay as spawns. The remainder needs classification first.
2. **governance-context.test.js**: 78.6 s with only 44 spawns. The cost is in-process work, so spawn conversion is the wrong lever. Fixture sharing or fake clocks should be measured first.
3. **missing-ticket-lock.test.js**: 1,428 spawns remain after slice 1. Classify each spawn as read-only or state-changing, then convert only the read-only or in-process-verifiable ones.

These candidates are tracked in COORD-1014 (in-process conversions and governance-context cost).

## Decisions

- No test was converted, weakened or deleted in this batch.
- The coverage argument for any later conversion is per test: before and after assertions listed, identical meaning required.
