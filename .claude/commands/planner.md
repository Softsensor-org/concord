# Planner — Pre-Implementation Planning

You are the planner for this project. Create a governed implementation plan for ticket **$ARGUMENTS** before any code work begins.

## Phase 1: Context Gathering

Read these files in parallel:
- `coord/GOVERNANCE.md`
- `coord/board/tasks.json` — find the ticket, note its status, repo code, dependencies, and description
- `coord/product/REQUIREMENTS.md` — understand the requirement context
- `coord/product/ARCHITECTURE.md` — understand architecture constraints
- `coord/product/DOMAIN_MODEL.md` — understand domain model constraints
- The ticket's prompt mapping from `coord/prompts/` if one exists
- `coord/QUESTIONS.md` — check for unresolved items related to this ticket
- The repo-local `AGENTS.md` for the target repo

If the ticket references other design docs (e.g., FORMS_AND_WORKFLOW_CONTRACT.md, OFFLINE_SYNC_AND_CONFLICTS.md), read those too.

## Phase 2: Dependency Audit

1. List all dependency tickets from the `Depends On` field.
2. Check the status of each dependency:
   - If all are `done`: report "Dependencies satisfied."
   - If any are not `done`: report each unresolved dependency with its current status.
3. If dependencies are unresolved, flag this clearly. The user must either:
   - Complete the dependency first
   - Waive the dependency (human-admin override)
   - Fold the dependency work into this ticket's scope

## Phase 3: Codebase Exploration

Explore the target repo to understand the current state:

**For backend (backend) tickets:**
- Read relevant module code in `packages/modules/`
- Read relevant contracts in `packages/contracts/http/src/`
- Read the service registration and DI patterns
- Identify existing tests that will be affected
- Check the repo's `dev` branch for the latest landed state

**For frontend (frontend) tickets:**
- Read relevant app code in `apps/`
- Read shared packages in `packages/`
- Check component patterns and design token usage
- Identify existing tests that will be affected
- Check the repo's `dev` branch for the latest landed state

**For coord (X) tickets:**
- Read relevant governance scripts and board state
- Check for related design docs

## Phase 4: Plan Record

1. Seed the governed plan state so `gov start` will not reject:
   ```bash
   coord/scripts/gov update-plan $ARGUMENTS --startup completed --traceability closing-gap
   ```

2. Create or update `coord/active/$ARGUMENTS.md` with:

   ```markdown
   # $ARGUMENTS — Implementation Plan

   ## Objective
   <What the ticket asks for, traced to URS or design doc>

   ## Approach
   <High-level design: what to build, how it fits into the existing architecture>

   ## Files to Create/Modify
   <Expected file list with brief rationale for each>

   ## Dependencies
   <Dependency status and any waivers>

   ## Risks
   <What could go wrong, what edge cases to watch>

   ## Verification Strategy
   <How to confirm it works: specific test commands, manual checks>

   ## Testing Dimensions
   Which coverage dimensions does this ticket add or improve? (check coord/TEST_MATURITY.md for current gaps)
   - Unit: <yes/no — what functions>
   - Contract: <yes/no — what API shapes>
   - Integration: <yes/no — what cross-module flows>
   - State: <yes/no — what state transitions>
   - Edge case: <yes/no — what boundaries>
   - Error path: <yes/no — what failure modes>
   - Other: <visual regression, accessibility, offline, permission, performance — if applicable>

   ## Requirement Closure Preview
   - Ticket ask: <from ticket description>
   - Planned implementation: <what will be built>
   - Known gaps: <anything explicitly deferred>
   ```

3. Verify the plan state was accepted:
   ```bash
   coord/scripts/gov explain $ARGUMENTS
   ```

## Phase 5: Report

Present the plan to the user with:
- Objective and approach summary
- File list
- Dependency status
- Risks and mitigations
- Whether `gov start` is now ready to proceed
- Recommended next step (usually: `/do $ARGUMENTS`)

## Rules

- Do not start the ticket (`gov start`) — that is the `/do` wrapper's job.
- Do not write implementation code — only plan and explore.
- If the ticket has no prompt mapping, note that a waiver will be needed at start time.
- If the codebase state contradicts the ticket description (e.g., the thing to replace doesn't exist), flag it clearly.
- Keep the plan proportional to ticket complexity — a small bug fix needs a short plan, a major infrastructure ticket needs a thorough one.
