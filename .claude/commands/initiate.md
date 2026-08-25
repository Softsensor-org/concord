# Initiate — Governed Session Cold-Start

You are starting a new governed agent session for this project.

## Phase 1: Read Governance

Read these files in parallel:
- `coord/GOVERNANCE.md`
- `coord/AGENT_STARTUP_CHECKLIST.md`
- `coord/AGENT_PATHS.md`
- `coord/product/REPOS.md`
- `coord/docs/IDENTITY_RUNTIME_EXTRACT.md`
- The repo-local `AGENTS.md` for the target repo (the repo-local `AGENTS.md` for each governed repo)

## Phase 2: Bootstrap (identity + health + recommendation)

1. Run the provider-neutral cold-start contract. It binds the session identity
   (assigning one only when governance reports `needs_assignment: true`), runs
   the shared health check, and recommends the next governed action:
   ```bash
   coord/scripts/agent bootstrap
   ```

2. If the current thread is blocked by a foreign same-handle session and must not touch that foreign ticket state:
   ```bash
   coord/scripts/gov agent-rebind --fresh
   ```
   then re-run `coord/scripts/agent bootstrap`.

3. Verify identity binding succeeded — the identity payload should show `needs_assignment: false`. To re-inspect at any time:
   ```bash
   coord/scripts/gov agentid
   ```

## Phase 3: Health Check

`bootstrap` already ran the shared health check. For a board-count summary or a ticket-scoped recheck, use:
```bash
coord/scripts/agent status
coord/scripts/agent check
```

If governance reports issues, list them with severity. Do not attempt repairs unless asked — that is the `/recover` skill's job.

## Phase 4: Board Summary

1. Read `coord/rendered/TASKS.md` and report:
   - Count of tickets by status (todo, doing, blocked, review, done)
   - All `doing` tickets with owner and description
   - All `review` tickets awaiting action
   - Unresolved items in `coord/QUESTIONS.md` addressed to `orchestrator`

2. Identify the highest-priority unblocked `todo` ticket:
   - A ticket is unblocked only if all dependency tickets are `done`
   - Prefer P0 over P1 over P2
   - Within a priority tier, prefer tickets that unblock the most downstream work

3. Ask the thin facade for the next recommendation:
   ```bash
   coord/scripts/agent next
   ```

4. Report:
   - Agent identity claimed
   - Board health (`agent status` + `agent check` results)
   - Board summary
   - Recommended next ticket with reasoning

## Rules

- Do not start any ticket during initiate — just report readiness.
- Do not auto-fix doctor issues — report them and let the user decide.
- If `agent check` fails hard checks, report the failures clearly.
- This skill is read-only except for the agent identity claim.
