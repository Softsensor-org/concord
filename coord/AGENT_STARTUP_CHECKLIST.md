# Agent Startup Checklist

Derived from `coord/GOVERNANCE.md` Section 8 Start Gate. If rules conflict, `coord/GOVERNANCE.md` wins.

Use this checklist every time an agent picks up a ticket.

## Required Reads

1. `coord/GOVERNANCE.md`
2. `coord/product/REPOS.md`
3. `coord/board/tasks.json`
4. `coord/product/REQUIREMENTS.md` (if populated)
5. `coord/product/ARCHITECTURE.md` (if populated)
6. Assigned ticket prompt in `coord/prompts/`
7. `coord/QUESTIONS.md`
8. Any ticket-specific design or requirement document referenced by the board or prompt

Generated convenience outputs:
- `coord/TASKS.md`
- `coord/PROMPT_INDEX.md`

## Mandatory Pre-Start Actions

Use `coord/scripts/gov start <ticket>` as the normal entry path. The CLI acquires the lock, seeds the plan record, and syncs the board; treat the list below as the readiness checks you must satisfy before or immediately after start rather than manual file operations.

1. Confirm the ticket exists and the status transition is legal.
2. Confirm the ticket has a prompt mapping, or record a waiver.
3. Confirm the ticket prompt's declared `## Preconditions` (if any) still resolve on the target repo's integration branch (the start gate verifies this automatically and fails a stale prompt before lock/worktree creation).
4. For `test`, `contract`, and `infra` tickets, record baseline reproduction before start.
5. Refresh the relevant repo before paired code + coord mutations.
6. Confirm start produced the canonical `coord/.runtime/locks/<ticket>.lock`.
7. Confirm the ticket moved `todo -> doing`.
8. Confirm the canonical plan record / `PLAN.md` block exists and `node coord/board/board.js sync` completed.

## Ticket Prompt Structure

A ticket prompt may include an OPTIONAL `## Preconditions` section. Use it to
declare concrete artifacts the ticket claims **already exist** and will modify
or gate — for example an existing route a security ticket hardens, or an
existing symbol a refactor changes. The start gate verifies each declared
precondition against the target repo's integration branch with cheap git
lookups and fails a stale prompt before any lock or worktree is created.

```
## Preconditions

- path:src/routes/floor.ts
- route:/floor-workscreen
- symbol:src/screens/Call.tsx#CallCenterWorkscreen
```

Rules for prompt authors:
- The section is optional. Omit it when the ticket creates everything it touches.
- Declare an artifact only when the ticket premise is false without it.
- Use the `path:` / `route:` / `text:` / `symbol:<file>#<literal>` prefix form, or a bare token (a leading `/` is treated as a route literal; a path-shaped token is treated as a file path).
- `## Likely Files` are NOT preconditions — they are frequently files the ticket will create and never block a start.

After start, use `coord/scripts/gov explain <ticket-id>` to surface any remaining readiness blockers. Never hand-edit `coord/.runtime/locks/*.lock`, `coord/board/tasks.json`, or `coord/board/plans/*.json`.

## Session Identity Constraint

1. Treat one live Claude conversation per board as the supported interactive mode.
2. If a second Claude conversation must touch the same board, export a distinct `CLAUDE_SESSION_ID` before running `coord/scripts/gov`.
3. If governance reports ambiguous Anthropic session identity, stop and choose explicitly:
   - return to the original conversation, or
   - relaunch with an explicit `CLAUDE_SESSION_ID`, or
   - use a separate board.
4. Do not rely on inferred continuity or MCP attestation to distinguish multiple live Claude conversations on the same board.

## Shell Constraint

All commands must run non-interactively.
- No editor popups
- No interactive git modes
- Use explicit CLI arguments

## Loop-Break Rule

Stop and log in `coord/QUESTIONS.md` if:
1. the same verification command fails twice with no new failure signature,
2. more than one worktree recreation is attempted for the same ticket in one cycle,
3. more than 45 minutes pass with no net reduction in the failing surface.
