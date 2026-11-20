# COORD-1014 gate spawn analysis (2026-11-14)

Evidence only. No production code and no test assertion changed. Handle claudea802, session w1014-h-20261114, base origin/dev 34df9a65.

## 1. Before-table (Node 22.8.0, `test-runner.js --profile-costs --file`, one suite at a time, same host and session, one run each)

| suite | result | wall | child CLI spawns | child CLI time |
| --- | --- | --- | --- | --- |
| missing-ticket-lock.test.js | 64/64 pass | 337.7 s | 1,428 | 306.6 s (91%) |
| runtime-authority-lifecycle.test.js | 12/12 pass | 122.9 s | 1,884 | 122.3 s (99%) |
| governance-context.test.js | 62/62 pass | 78.6 s | 44 | 74.3 s (95%) |

Non-test time is under 40 ms per suite. No after-table exists because no conversion landed.

## 2. Static classification of missing-ticket-lock.test.js call sites

There are 87 `cli(...)` and `ok(...)` call sites. Counts by governed verb:

| verb | sites | class |
| --- | --- | --- |
| recover | 8 ok + 3 cli | state-changing (lock and owner writes, journal) |
| start | 6 ok + 4 cli | state-changing |
| agent-release | 6 ok + 6 cli | state-changing (session ledger) |
| claim | 6 ok + 3 cli | state-changing (owner, lock, session) |
| agentid | 5 ok | registry write, treated as state-changing |
| file-ticket | 4 ok | state-changing |
| sync | 3 ok | state-changing (board and derived views) |
| agent-status | 3 ok | read-only |
| plan | 2 ok | state-changing |
| resume | 1 ok | state-changing |
| register-prompt | 1 ok | state-changing |
| reconcile | 1 ok + 1 cli | state-changing (board authority) |

Only `agent-status` is read-only. Expected-refusal probes (`assert.notEqual(...status, 0)`) are also in this table and run the verb as a refusal. Each still reads and writes governed state on the refusal path, so none is proven read-only. Not classified per call: runtime-authority-lifecycle.test.js (its spawns come from the `gov()` helper, which runs `bash -c` around `node governance.js`, around line 241).

## 3. Existing in-process entry point

`coord/engine/scripts/cli.js`:
- `executeCommand(argv, {cwd, env})` runs `dispatchGovernedCommand` under `withTemporaryExecutionContext` (`lifecycle-execution-context.js`). It captures console output and returns `{ok, value, stdout, stderr, error}`. A `GovernanceError` maps to `ok: false`. Other errors are rethrown with captured streams attached.
- `__testing.dispatchGovernedCommand` and `__testing.dispatchCommand` are exported for tests.
- `dispatchGovernedCommand` applies the COORD-915 integration-authority guard and the dry-run policy, the same as `main()` used by the CLI.

Differences from the CLI that a characterization test would have to cover:
- CLI exit: `runMain` calls `process.exit(1)` on `GovernanceError`. `executeCommand` returns `ok: false`.
- stderr: the CLI writes `error.message` through `console.error`. `executeCommand` joins captured `console.error` output and does not add the message to stderr.
- env: `withTemporaryExecutionContext` deletes a key only when its override value is `undefined`. `bindFixture` `delete`s session keys from its env object instead, so the child env is correct but in-process `process.env` keeps the parent session keys.

## 4. Fixture-isolation blocker

- missing-ticket-lock and runtime-authority fixtures are real git repositories with worktrees, under a temporary root. `buildFixture` copies the engine (`scripts`, `engine`, `board`, and so on) into `<root>/coord`.
- `cli()` spawns `<root>/coord/scripts/governance.js`, so each call runs the fixture's engine copy against the fixture's board, locks and sessions.
- `executeCommand` runs the canonical engine module graph loaded from this checkout. Calling it would read and write the real checkout's board and locks, not the fixture.
- Converting therefore needs per-fixture module isolation (a fresh module graph rooted at the fixture coord directory) before any verb can move in process. This is not built.

## 5. governance-context finding

The 74.3 s of child time comes from 44 CLI spawns, about 1.7 s each. The in-process share of the suite is under 4 s (non-test time 30 ms, and the remainder is in-process test code). Reducing wall time here means reducing CLI spawns or the work per spawn, not moving work in process. `--profile-costs` already attributes 95% of the time to child processes, so `node --cpu-prof` was not run.

## 6. Named end-to-end spawn set (must keep spawning the CLI)

- COORD-880 and COORD-883 env-scrub cases.
- At least one full lifecycle per suite (claim, recover, start, sync), with exit codes and stderr asserted.
- The `reconcile` refusal that requires `--human-admin-override`.

## 7. Follow-up scope

- Per-call read-only versus state-changing table for runtime-authority-lifecycle.
- A fixture-root-aware in-process runner (per-fixture module graph, explicit env undefined for session keys).
- A characterization test comparing CLI and in-process results: exit status, stderr, journal events, board bytes and lock bytes. Convert only proven read-only and refusal probes.
- Reduce CLI invocations per test (fewer `agentid` and `agent-release` probes, or one shared fixture per file).
