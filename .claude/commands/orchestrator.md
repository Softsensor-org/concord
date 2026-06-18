# Orchestrator — Board Coordination

You are the orchestrator for this project. Execute the requested coordination action.

**Action requested:** $ARGUMENTS

Parse the first word of the arguments to determine the action. Supported actions: `status`, `next`, `plan`, `unblock`, `decompose`, `check`, `takeover`.

---

## Action: `status`

Provide a board overview:

1. Read `coord/board/tasks.json` and compute:
   - Ticket counts by status: todo, doing, doing (blocked), review, done, deferred, superseded
   - Active work: list all `doing` tickets with owner, repo, and age
   - Blocked tickets with reasons and age
   - Tickets in `review` awaiting action

2. Run governance health check:
   ```bash
   coord/scripts/gov orch
   ```

3. Check for unresolved items in `coord/QUESTIONS.md` addressed to orchestrator.

4. Report:
   - Board summary (counts)
   - Active work details
   - Blockers and risks
   - Next recommended action

---

## Action: `next`

Recommend the highest-priority unblocked ticket:

1. Read `coord/board/tasks.json` — identify all `todo` tickets.

2. Check dependencies: a ticket is unblocked only if all its dependency tickets are `done`.

3. Apply priority ordering from the board's `Pri` field:
   - **P0**: Critical blockers, infrastructure, governance fixes
   - **P1**: Core delivery path
   - **P2**: Required but not on critical path
   - **P3**: Quality, polish, future-proofing

4. Within each priority tier, prefer:
   - Tickets with fewer unresolved dependencies
   - Tickets that unblock the most downstream work
   - Tickets in repos with less active contention

5. Report:
   - Recommended ticket ID, title, repo, and priority tier
   - Reasoning (why this ticket, what it unblocks)
   - Any caveats or prerequisites

---

## Action: `plan <ticket>`

Create an implementation plan for the specified ticket:

1. Read the ticket from `coord/board/tasks.json`.
2. Read the ticket prompt from `coord/prompts/` if mapped.
3. Read relevant requirement docs (`coord/product/REQUIREMENTS.md`, `coord/product/ARCHITECTURE.md`, `coord/product/DOMAIN_MODEL.md` — if populated).
4. Read the target repo's `AGENTS.md` for patterns and constraints.

5. Create a plan record at `coord/active/<ticket>.md` covering:
   - **Objective**: What the ticket asks for
   - **Approach**: How to implement it (high-level design)
   - **Files to touch**: Expected file creates/modifications
   - **Dependencies**: What must exist first
   - **Risks**: What could go wrong
   - **Verification**: How to confirm it works
   - **Requirement closure**: How to prove the ticket ask is met

6. If a plan record template exists at `coord/board/plans/`, create or update the JSON plan record too.

---

## Action: `unblock <ticket>`

Investigate and resolve blockers for a specific ticket:

1. Read the ticket from `coord/board/tasks.json` — confirm it is `doing (blocked: <reason>)`.
2. Read the blocker reason.
3. Investigate:
   - Is the blocker a dependency ticket? Check its status.
   - Is it a technical issue? Read relevant code/logs.
   - Is it a governance issue? Run `coord/scripts/gov doctor`.
   - Is it a question? Check `coord/QUESTIONS.md`.

4. Attempt resolution:
   - If dependency is now done: unblock via `coord/scripts/gov resume <ticket>`
   - If technical: propose a fix or workaround
   - If governance: run `coord/scripts/gov recover <ticket>` or `coord/scripts/gov reconcile`
   - If question: answer it or escalate

5. Report what was found and what action was taken.

---

## Action: `decompose <ticket>`

Break an epic or large ticket into sub-tickets:

1. Read the ticket from `coord/board/tasks.json`.
2. Read the ticket prompt and any referenced requirement docs.
3. Read the target repo's architecture and patterns.

4. Propose decomposition:
   - Each sub-ticket should be independently implementable and reviewable
   - Each sub-ticket should have a clear scope and acceptance criteria
   - Respect dependency ordering (later tickets depend on earlier ones)
   - Use the correct repo code (B/F/X)
   - Suggest ticket IDs following the existing naming convention

5. Present the decomposition for approval before making board changes.

---

## Action: `check`

Run governance health diagnostics:

1. Run the full orchestrator cycle:
   ```bash
   coord/scripts/gov orch
   ```

2. Run governance doctor:
   ```bash
   coord/scripts/gov doctor
   ```

3. Validate the board:
   ```bash
   node coord/board/board.js validate
   ```

4. Check for:
   - Stale locks (heartbeat > 24h)
   - Future-dated locks (heartbeat > 5m ahead)
   - Orphaned worktrees in coord (`coord/scripts/gov doctor --fix` handles these)
   - **Orphaned worktrees in governed repos** — scan `.worktrees/` dirs for tickets that are `done` or `superseded`:
     ```bash
     # List worktrees in each repo
     # Scan .worktrees/ in each governed repo (from coord/paths.js)
     # For each, check if the ticket is still doing — if not, it's orphaned
     ```
   - Dirty repo roots outside worktrees
   - Unresolved questions addressed to orchestrator

5. **Clean up orphaned repo worktrees** (with user confirmation):
   ```bash
   coord/scripts/gov cleanup-worktree <repo-name> <ticket-id> --yes --delete-branch
   coord/scripts/gov cleanup-worktree <repo-name> <ticket-id> --yes --delete-branch
   ```

6. Report all findings with severity and suggested remediation.

---

## Action: `takeover <ticket>`

Take over an in-progress ticket from another agent:

1. Take over the ticket only with explicit human-admin authorization:
   ```bash
   coord/scripts/gov takeover <ticket> --human-admin-override "<reason>"
   ```

2. Inspect the prior agent's progress:
   - Check the worktree for uncommitted work:
     ```bash
     cd <worktree-path> && git status --short
     ```
   - Check commits ahead of base:
     ```bash
     git log --oneline origin/dev..HEAD
     ```
   - Read the plan state:
     ```bash
     coord/scripts/gov explain <ticket>
     ```
   - Read `coord/active/<ticket>.md` for the implementation plan

3. Report:
   - What code exists (committed and uncommitted)
   - Plan state completeness (startup, invariants, review cycles, closure)
   - What remains to complete the ticket
   - Recommended next step

4. If the worktree base is stale, rebase:
   ```bash
   git stash && git fetch origin dev && git rebase origin/dev && git stash pop
   ```

---

## General Rules

- Use the governance CLI (`coord/scripts/gov ...`) for all state mutations — never hand-edit board, locks, or plan files.
- Run `node coord/board/board.js sync` after any board changes.
- Run `coord/scripts/gov orch` before and after any assignment or reconciliation batch.
- Do not assign additional work while `gov orch` is failing hard checks.
- Log unresolvable issues in `coord/QUESTIONS.md` with `To = orchestrator`.
- Authority order: human-admin > GOVERNANCE.md > ticket prompt > orchestrator decisions > agent judgment.
