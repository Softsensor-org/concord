# Code Writer — Governed Implementation Workflow

You are an implementation agent for this project. Execute the full governed implementation workflow for ticket **$ARGUMENTS**.

## Phase 1: Startup Gate

1. Read these files (in parallel where possible):
   - `coord/GOVERNANCE.md`
   - `coord/AGENT_STARTUP_CHECKLIST.md`
   - `coord/board/tasks.json` — verify the ticket exists, note its current status, repo code (B=backend, F=frontend, X=coord), dependencies, and prompt mapping
   - `coord/product/REQUIREMENTS.md` — understand the requirement context
   - `coord/product/ARCHITECTURE.md` — understand architecture constraints
   - `coord/product/INTEGRATION.md` — understand cross-repo constraints when relevant
   - The ticket's prompt in `coord/prompts/` if one is mapped
   - `coord/QUESTIONS.md` — check for unresolved items related to this ticket
   - The repo-local `AGENTS.md` for the target repo (the repo-local `AGENTS.md` for the target repo)
   - `coord/active/$ARGUMENTS.md` — if this file exists, it contains the implementation plan from a prior `/planner` run. Use it to skip redundant context gathering and go straight to the planned approach.

2. Verify:
   - The ticket exists in the board
   - The status transition to `doing` is legal (must be `todo` or unblocked)
   - All dependency tickets are `done`
   - A prompt mapping exists (or record a waiver)

3. If any startup check fails, stop and report the issue. Do not proceed.

**Hard enforcement — do not skip these checks to save time.** Every skipped gate has caused real incidents:
- Skipping dependency check → implemented against missing foundation → rework
- Skipping plan read → re-invented logic that already existed → avoidable rework
- Skipping QUESTIONS.md check → hit a known blocker another agent already documented

## Phase 2: Plan Seeding + Lock + Worktree

1. **Seed the plan state first** — this prevents the common `missing_plan_state` rejection from `gov start`:
   ```bash
   coord/scripts/gov update-plan $ARGUMENTS --startup completed --traceability closing-gap
   ```

2. Verify plan seeding was accepted:
   ```bash
   coord/scripts/gov explain $ARGUMENTS
   ```
   Confirm `start_readiness` shows no blockers. If it does, address them before proceeding.

3. Acquire the lock and move to doing:
   ```bash
   coord/scripts/gov start $ARGUMENTS
   ```

4. Create the worktree in the correct repo:
   - For code-repo tickets: worktree under `<repo>/.worktrees/<agent>/$ARGUMENTS/`
   - For code-repo tickets: worktree under `<repo>/.worktrees/<agent>/$ARGUMENTS/`
   - For X (coord) tickets: work directly in `coord/`

5. **Rebase onto latest dev** — `gov start` may branch from a stale local ref:
   ```bash
   cd <worktree-path>
   git fetch origin dev && git rebase origin/dev
   ```

6. Verify the lock file exists at `coord/.runtime/locks/$ARGUMENTS.lock` and contains valid JSON with owner, ticket, repo, branch, worktree, and timestamps.

## Phase 3: Implementation

Follow the repo-specific patterns:

**Backend (backend):**
- TypeScript / Node patterns as established in the repo
- Keep contracts carrier-neutral — every user-facing label must come from a terminology token, not a string literal
- Tenant-aware, auth-aware
- Use shared packages from `packages/`

**Frontend (frontend):**
- React / Next.js / Expo patterns as established
- Mirror backend contracts — do not invent payload shapes
- Use shared packages from `packages/`
- Follow the design system tokens and component patterns

**Coord:**
- Governance scripts, board mutations, design docs
- Use `node coord/board/board.js sync` after board changes

**All repos:**
- Commit messages must contain the ticket ID: `$ARGUMENTS`
- Use targeted `git add <file>` — never `git add .` or `git add -A`
- Use the governance CLI for commits: `coord/scripts/gov commit $ARGUMENTS --message "<message>"`
- **After every `gov commit`, sync the lock HEAD:**
  ```bash
  coord/scripts/gov heartbeat $ARGUMENTS
  ```
  This prevents lock/head drift that causes `gov doctor` failures later.
- Work only within the assigned ticket scope
- Do not hard-code customer, carrier, or distributor-specific assumptions

**CRITICAL — Never merge to dev manually.** Do not run `git merge`, `git cherry-pick`, or `git push` to dev yourself. Use `gov land` or `gov finalize` to merge. Merging before the governed review gate causes sequence violations that require manual board repair (this has caused 7+ tickets to need emergency reconciliation).

## Phase 4: Self-Review (4 Cycles)

Before moving to review, perform 4 structured self-review cycles:

### Cycle 1 — Contract & State Invariants
- Do all public APIs match their contracts?
- Are state transitions correct and complete?
- Are domain model constraints preserved?
- Are shared types/interfaces consistent across boundaries?

### Cycle 2 — Security & Failure Modes
- Any injection risks (SQL, command, XSS)?
- Auth/authz checks in place?
- Sensitive data exposure?
- Error handling: are failures graceful? Do errors propagate correctly?
- Race conditions or concurrency issues?

### Cycle 3 — Tests & Operability
- Are new/changed behaviors covered by tests?
- Do existing tests still pass?
- **Which testing dimensions does this ticket improve?** Check the plan's "Testing Dimensions" section (if it exists). At minimum, every ticket that adds business logic should add or verify unit + error path coverage. Tickets crossing network boundaries should add contract tests.
- Performance: any O(n^2), N+1 queries, unnecessary allocations?
- Logging/observability adequate for production debugging?

### Cycle 4 — Requirement Closure
- Does the implementation satisfy the ticket ask?
- What was implemented vs. not implemented vs. deferred?
- Draft the requirement closure evidence:
  - `Ticket ask: ...`
  - `Implemented: ...`
  - `Not implemented: ...`
  - `Deferred to: <ticket-id or none>`
  - `Closeout verdict: complete`

Fix any issues found during self-review before proceeding.

## Phase 5: Pre-Submit Validation

**Before attempting `gov submit` or `gov move-review`, run a pre-flight check to catch all plan gaps at once** — this prevents the iterative submit-reject loop where each attempt fails for a different missing field:

1. Run `coord/scripts/gov explain $ARGUMENTS` and check `submit_readiness`:
   - `missing_plan_state` — seed with `gov update-plan`
   - `critical_invariants` — record invariants with `gov update-plan`
   - `repo_gates` — record gate commands:
     ```bash
     coord/scripts/gov add-repo-gate $ARGUMENTS --command "<gate command>" --note "<result>"
     ```
   - `self_review_cycle_count` — record all 4 cycles in one batch command (avoids session-drift issues with individual `add-review-cycle` calls):
     ```bash
     coord/scripts/gov set-review-cycles $ARGUMENTS \
       --review-cycle "lens=Contract and state invariants; diff=<what changed>; risks=<r1>, <r2>; findings=<f>; verification=<cmd>; verdict=pass" \
       --review-cycle "lens=Security and failure modes; diff=<what changed>; risks=<r1>, <r2>; findings=<f>; verification=<cmd>; verdict=pass" \
       --review-cycle "lens=Tests and operability; diff=<what changed>; risks=<r1>, <r2>; findings=<f>; verification=<cmd>; verdict=pass" \
       --review-cycle "lens=Requirement closure; diff=<what changed>; risks=<r1>, <r2>; findings=<f>; verification=<cmd>; verdict=pass"
     ```
   - `requirement_closure` — record closure:
     ```bash
     coord/scripts/gov set-requirement-closure $ARGUMENTS --ticket-ask "<ask>" --implemented "<what>" --closeout-verdict complete
     ```

2. For governed code-repo tickets at or after the feature-proof cutoff (check board metadata), record feature proofs.

   **IMPORTANT: Feature proof paths must be repo-relative, not repo-prefixed.**
   - Correct: `path:packages/modules/auth/src/auth.service.ts`
   - Wrong: `path:<repo>/src/auth/auth.service.ts`

   ```bash
   coord/scripts/gov add-feature-proof $ARGUMENTS --proof-path <repo-relative-path>
   coord/scripts/gov add-feature-proof $ARGUMENTS --proof-symbol <repo-relative-file>#<symbol>
   ```

3. Re-run `coord/scripts/gov explain $ARGUMENTS` and confirm `submit_readiness.ready=true` before proceeding.

## Phase 6: Review Gate

1. Run the relevant repo quality gates:
   ```bash
   # For backend tickets:
   coord/scripts/gov gate backend --lane default

   # For frontend tickets:
   coord/scripts/gov gate frontend --lane default
   ```

2. Record verification commands and results in the plan record.

3. Move the ticket to review:
   ```bash
   coord/scripts/gov submit $ARGUMENTS [--fill]
   ```
   Or if no PR is needed:
   ```bash
   coord/scripts/gov move-review $ARGUMENTS --pr "<pr-ref>"
   ```

4. Sync the board:
   ```bash
   node coord/board/board.js sync
   ```

## Hard Rules (violations require QUESTIONS.md incident log)

These are not guidelines. Breaking any of these has caused real production incidents in prior projects:

- **NEVER merge to dev manually** — always use `gov land` or `gov finalize`. (7+ emergency repairs caused by manual merges)
- **NEVER skip the plan read** — if `coord/active/$ARGUMENTS.md` exists, read it. (Re-inventing donor logic cost 2+ hours per incident)
- **NEVER submit without `explain` confirming `submit_readiness.ready=true`** — (Silent evidence gaps caused 15+ submit-reject loops)
- **NEVER chain tickets in one session** — start fresh. (Context pollution caused wrong-ticket code edits)
- **ALWAYS rebase after `gov start`** — (Stale base caused merge conflicts on every ticket this session)
- **ALWAYS use `set-review-cycles` (batch)** — not individual `add-review-cycle` calls. (Silent dedup dropped cycles)

## Operational Rules

- If the same verification command fails twice with no new failure signature, stop and log in `coord/QUESTIONS.md`.
- If more than one worktree recreation is attempted, stop and log.
- If more than 45 minutes pass with no progress on the failing surface, stop and log.
- Land governed code-repo work to `dev` — never advance `main` during ticket closeout.
- Keep the platform carrier-neutral: prefer config-driven terminology, forms, and feature flags over branches in business logic.
- Never merge to dev manually — always use `gov land` or `gov finalize`.
- After every `gov commit`, run `gov heartbeat` to keep the lock HEAD in sync.
- Validate all plan fields with `gov explain` before attempting submit.
- Feature proof paths are repo-relative, not repo-prefixed.
