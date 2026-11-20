# Installer runtime prerequisites

The npm installer requires Node.js 22.8.0 or newer and fails at entry with the
required and detected versions when the runtime is too old. The Linux SEA
installer uses the host `tar` command to extract its embedded bundle; it is not
a zero-dependency binary. Install `tar` before running `concord init` and treat
an unavailable command as an installation prerequisite failure.

## Scheduling the nightly affected-selection comparison (COORD-924)

Risk-based test selection (ADR 0021) is refined from a nightly comparison
against the full serial gate. The engine ships one host-independent command;
where and when it runs is install configuration, owned by the operator:

```bash
# 1. the authoritative full serial gate on the integration branch head
node coord/scripts/test-runner.js --report "$REPORT_DIR/full-report.json"
# 2. what selection would have run, and whether it would have caught every failure
coord/scripts/gov selection nightly --full-report "$REPORT_DIR/full-report.json" \
  --base "$INTEGRATION_BASE" [--head <ref>] [--inventory <suite-inventory.json>] [--ref <run id>]
```

- Run it from the canonical checkout of the coordination workspace, as a session
  with integration authority there: a miss is recorded as a journaled
  `selection-suspend` governance event on the board, which suspends selection
  for the missed change categories in every clone and session that reads the
  board.
- `REPORT_DIR`, `INTEGRATION_BASE` (for example the merge base of the
  integration branch and the previous nightly head) and the schedule itself
  are operator settings. Use whatever scheduler the install already has: a
  cron entry, a systemd timer, or a scheduled CI workflow. Run both Node lanes,
  and the Community and Enterprise cuts, when they are part of the install.
- The comparisons log and `refinement-report.md` are written to
  `coord/.runtime/affected-selection/` of the checkout that ran it.
- Lifting a suspension needs a recorded investigation and a raised
  `policy_version` in `coord/engine/test-policy.json` (its `selection` section):
  `coord/scripts/gov selection resolve --category <c> --investigation <ref>`.
- `coord/scripts/gov selection state` prints the governed state.

## Running the stage-aware test policy (COORD-936)

The test policy is a runnable pilot: it does not change the landing gates.
Developers, CI and the scheduler call the same command, so local and CI
resolution cannot drift:

```bash
coord/scripts/gov test-policy run --stage pr --base "$INTEGRATION_BASE"      # pull-request check
coord/scripts/gov test-policy run --stage nightly --out "$REPORT_DIR/nightly" # conditional: runs or skips by significance, and records why
coord/scripts/gov test-policy run --stage staging --out "$REPORT_DIR/staging" # promotion: full qualification plus smoke
```

- Workflow stages, smoke commands, product dependency maps and the timeout
  belong in the `testPolicy` block of `coord/project.config.js`; see
  `coord/product/TESTING_AND_GATES.md`, "Stage-Aware Test Policy". Provider
  and host details belong in those commands, never in engine code.
- Schedule the nightly run with the scheduler the install already has, as for
  the affected-selection comparison above. Feed its full runner report to
  `coord/scripts/gov test-policy compare --full-report <report> --base <ref>`
  to classify misses.
- Each run writes `test-policy-report.json` and `test-policy.manifest.json`
  (a COORD-910 run manifest) to `--out`, or by default under
  `coord/.runtime/test-policy/`.
