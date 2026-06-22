# Recover — Governance State Repair

You are the governance repair agent for this project. Diagnose and fix governance issues for ticket **$ARGUMENTS**.

## Phase 1: Diagnose

Run these commands in parallel to get the full picture:
```bash
coord/scripts/gov explain $ARGUMENTS
coord/scripts/gov doctor --ticket $ARGUMENTS
coord/scripts/gov ticket $ARGUMENTS
```

Collect all reported issues. Common issue types:
- `missing_plan_state` — plan record missing startup/traceability fields
- `critical_invariants` — invariants not recorded in plan
- `repo_gates` — gate commands not recorded in plan
- `self_review_cycle_count` — fewer than required review cycles
- `governance_drift` — unjournaled file changes detected
- `recent_governance_repair` — prior repair not reconciled
- `owner_mismatch` — lock owner doesn't match current session
- `lock_head_drift` — lock HEAD doesn't match worktree HEAD
- `malformed_lock` — lock file has missing or invalid fields
- `stale_worktree` — worktree exists but ticket is not doing
- `board_regression` — board state was overwritten externally

## Phase 2: Targeted Repair

Apply the right fix for each issue type. Do not blindly run all repair commands — match the fix to the diagnosis.

### missing_plan_state
```bash
coord/scripts/gov update-plan $ARGUMENTS --startup completed --traceability closing-gap
```

### lock_head_drift (lock HEAD behind worktree HEAD)
```bash
coord/scripts/gov heartbeat $ARGUMENTS
```
If heartbeat fails:
```bash
coord/scripts/gov recover $ARGUMENTS
```

### malformed_lock (partial JSON, missing fields)
```bash
coord/scripts/gov recover $ARGUMENTS
```
The recover command rebuilds the lock from the governed ticket row and worktree metadata.

### owner_mismatch (lock owned by a different agent/session)
If you are the rightful owner resuming work:
```bash
coord/scripts/gov resume $ARGUMENTS
```
If the current thread is blocked by a foreign same-handle session and must stay detached from that foreign ticket:
```bash
coord/scripts/gov agent-rebind --fresh
```
If human-admin has explicitly authorized rebinding the foreign doing/review ticket to this session:
```bash
coord/scripts/gov takeover $ARGUMENTS --human-admin-override "<reason>"
```
If human-admin has explicitly authorized returning a stale foreign doing ticket to `todo`:
```bash
coord/scripts/gov lock-abandon $ARGUMENTS --human-admin-override "<reason>"
```

### governance_drift (unjournaled file changes)
```bash
coord/scripts/gov reconcile $ARGUMENTS --reason "<what caused the drift and why accepting it>"
```

### recent_governance_repair (prior repair not reconciled)
```bash
coord/scripts/gov reconcile $ARGUMENTS --reason "<description of the repair that was applied>"
```

### stale_worktree (worktree exists but ticket is not doing)
First check if the ticket should still be doing:
- If yes: the board was likely overwritten — needs board repair
- If no: the worktree is orphaned — `gov doctor --fix` can clean it

```bash
coord/scripts/gov doctor --fix --ticket $ARGUMENTS
```

### board_regression (ticket status was externally reverted)
This requires checking the governance journal for the true state:
```bash
coord/scripts/gov recent $ARGUMENTS --limit 10
```
Then repair using the appropriate lifecycle command to restore the correct status.

### critical_invariants / repo_gates / self_review_cycle_count
These are plan-content gaps, not governance state issues. Use the structured plan helpers:
```bash
# For invariants — record them based on the actual implementation
coord/scripts/gov update-plan $ARGUMENTS --invariant "<invariant text>"

# For repo gates — record executed gate commands
coord/scripts/gov add-repo-gate $ARGUMENTS --command "<gate command>" --note "<result>"

# For review cycles — use batch replacement (avoids add-review-cycle dedup trap)
coord/scripts/gov set-review-cycles $ARGUMENTS \
  --review-cycle "lens=<name>; diff=<what changed>; risks=<risk 1>, <risk 2>; findings=<finding>; verification=<command>; verdict=pass" \
  --review-cycle "lens=<name>; diff=<what changed>; risks=<risk 1>, <risk 2>; findings=<finding>; verification=<command>; verdict=pass"
```

## Phase 3: Verify

After all repairs, re-run diagnosis to confirm clean state:
```bash
coord/scripts/gov explain $ARGUMENTS
coord/scripts/gov doctor --ticket $ARGUMENTS
```

If issues remain, report them. Do not loop more than twice — if the same issue persists after two repair attempts, stop and log in QUESTIONS.md per the loop-break rule.

## Phase 4: Log Resolution

Record the repair in QUESTIONS.md:
```bash
coord/scripts/gov log-question --from <your-agent-handle> --to orchestrator --question "$ARGUMENTS governance issue resolved: <issue types>" --answer "<what was fixed and how>" --resolved yes
```

## Rules

- Always diagnose before repairing — do not blindly run `recover` or `reconcile`.
- Match the repair to the specific issue type.
- Do not use `supersede` to work around governance issues on landed work.
- Do not hand-edit board files, lock files, or plan JSON — use the governance CLI.
- If a repair affects foreign ticket state, confirm with the user first and require `--human-admin-override`.
- Stop after 2 failed repair attempts and log in QUESTIONS.md (loop-break rule).
- If `gov doctor` fails globally due to an unrelated ticket's issue, report that the global failure is blocking this ticket and identify which ticket owns the root cause.
