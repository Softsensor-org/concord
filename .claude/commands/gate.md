# Gate — Standalone Quality Gate Execution

Run repo quality gates for this project.

**Arguments:** `$ARGUMENTS`

Parse the arguments to determine the target. Expected formats:
- `backend` — run backend gates
- `frontend` or `fe` — run frontend gates
- `backend --lane full` — run a specific lane
- `backend --branch <ref>` — run against a specific branch
- `<ticket-id>` — infer the repo from the ticket's repo code and run gates against its branch

## Phase 1: Resolve Target

1. If a ticket ID is provided, look it up in `coord/board/tasks.json`:
   - Repo code `B` = backend, `F` = frontend
   - Use the ticket's branch from the lock file if available
2. If a repo name is provided directly, use it.
3. Default lane is `default` unless specified.

## Phase 2: Run Gate

Execute the governed gate runner:
```bash
coord/scripts/gov gate <backend|frontend> --lane <default|full|extended> [--branch <ref>] --source local
```

The gate runner:
- Materializes a temporary clean worktree from the target branch
- Runs the requested lane inside it
- Records branch and commit provenance in the artifact
- Removes the worktree after the run

## Phase 3: Report Results

Report:
- **Target:** repo, branch, commit
- **Lane:** which lane was executed
- **Result:** pass or fail
- **Failures:** if any, list each failing check with its output
- **Artifact path:** where the gate artifact was written

If the gate fails:
- Identify which specific checks failed
- Suggest targeted fixes based on the error output
- Do not attempt fixes automatically — report and let the user decide

## Lane Reference

| Lane | Scope |
|------|-------|
| `default` | Fast pre-merge checks: lint, typecheck, unit tests |
| `full` | Default + integration tests, build verification |
| `extended` | Full + performance, architecture guards, coverage thresholds |

## Rules

- Always use `coord/scripts/gov gate` — do not run test commands directly, as the gate runner provides provenance and artifact tracking.
- Do not modify code during gate execution — this is a read-only verification step.
- If the gate runner itself fails (not a test failure but a runner error), check `coord/product/LOCAL_AUTOMATION_AND_GATES.md` and `coord/product/TESTING_AND_GATES.md` for configuration.
