# COORD-937: gate-timeout verification record

Scope: finishes the COORD-896 verification. Thresholds are unchanged:
stall 30 s on a quiet host, 120 s under host I/O or CPU pressure, 600 s hard ceiling.

## Status against the acceptance items

1. Reproducible synthetic load: DONE. `coord/engine/scripts/session-lifecycle-load.js`
   (`--cpu`, `--io`, `--io-mib`, `--seconds`, `--dir`). It prints pressure before, mid and
   after. Its unit test runs real children and checks they are stopped and their files removed.
2. Ten consecutive burn-in runs under synthetic load: PARTLY PROVEN. Five bounded runs were
   done (section "Bounded burn-in"). The full 10-run burn-in at the original 16 CPU + 16 I/O
   scale was stopped by the orchestrator (shared multi-user host, load average 55). It
   completed zero lane runs and is not counted. The full-scale burn-in belongs on the dedicated
   gate host (COORD-917). Not implemented here: "full-scale burn-in on gate host (COORD-917)".
3. Hang in the real lifecycle worker: DONE. `COORD_INJECT_LIFECYCLE_HANG=ready` makes the real
   worker stop silently before `ready`. The parent kills it at the stall limit with the
   documented message (test: "a hang injected into the real lifecycle worker ..."). Slow but
   progressing work under injected pressure is not killed (test: "a slow progressing step
   under host I/O pressure ..."). A progressing lane hits the hard ceiling (test: "a real lane
   that keeps progressing ..."). The ceiling is exact even when shorter than the stall limit
   (fake-clock test "shorter than its stall limit").

## Bounded burn-in (orchestrator limits: 4 CPU + 2 I/O children, 5 runs, 15 min cap)

Command: `node coord/engine/scripts/session-lifecycle-load.js --cpu 4 --io 2 --seconds 840 --io-mib 16`
with five runs of
`node --test --test-name-pattern "COORD-712: three isolated" coord/engine/scripts/session-lifecycle-conformance.test.js`
on Node 22.8.0. `COORD_LIFECYCLE_TIMING_FILE` records each run's per-lane largest silent gap.

Host (shared, 32 CPUs, 3 users logged in): load1 43.7 before, 39.1 at 25 s into the load,
14.5 after. The host was already at or above the CPU count before the load started.

| run | result | seconds | lane 1 max gap | lane 2 max gap | lane 3 max gap | load1 at end | io full avg10 at end | false stalls |
|---|---|---|---|---|---|---|---|---|
| 1 | pass | 81 | 5.6 s | 40.1 s | 39.7 s | 32.3 | 5.3 | 0 |
| 2 | pass | 104 | 12.8 s | 63.9 s | 62.4 s | 35.9 | 0.9 | 0 |
| 3 | pass | 97 | 9.9 s | 45.3 s | 45.5 s | 34.9 | 2.7 | 0 |
| 4 | pass | 89 | 5.5 s | 39.7 s | 40.2 s | 23.5 | 9.8 | 0 |
| 5 | pass | 80 | 5.9 s | 35.2 s | 36.7 s | 14.5 | 11.0 | 0 |

Reading the measurements:
- The largest silent gap in any run was 63.9 s. The quiet stall limit of 30 s would have
  killed that lane, but the host reading in run 2 was loaded (load1 at or above the CPU
  count), so the 120 s loaded limit applied and held with about 56 s of margin.
- The 600 s ceiling was never approached (runs took 80 to 104 s).
- No threshold was changed. A quiet-host reading during heavy load would be a false stall.
  That is a policy question for a human (for example, whether the quiet limit should also
  consider the I/O pressure trend). It is recorded here as a finding and is not acted on.

## Reproduce

    node --test coord/engine/scripts/session-lifecycle-test-utils.test.js coord/engine/scripts/session-lifecycle-load.test.js
    node --test --test-name-pattern "COORD-937" coord/engine/scripts/session-lifecycle-conformance.test.js
    node coord/engine/scripts/session-lifecycle-load.js --cpu 4 --io 2 --seconds 840 --io-mib 16 --dir <dir>   # run alongside the COORD-712 test
