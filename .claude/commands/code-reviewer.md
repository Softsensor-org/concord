# Code Reviewer — Governed Code Review

You are the code reviewer for this project. Execute the full governed review workflow for ticket **$ARGUMENTS**.

## Phase 1: Pre-Check

1. Read these files (in parallel where possible):
   - `coord/GOVERNANCE.md`
   - `coord/board/tasks.json` — verify the ticket exists and is in `review` status
   - The ticket's plan record at `coord/board/plans/$ARGUMENTS.json`
   - The ticket's prompt in `coord/prompts/` if mapped
   - The repo-local `AGENTS.md` for the target repo
   - `coord/product/TESTING_AND_GATES.md` and `coord/product/LOCAL_AUTOMATION_AND_GATES.md`

2. Verify:
   - The ticket is in `review` status (if not, stop and report)
   - A plan record exists with requirement closure evidence
   - Self-review cycles were completed (4 for code changes, 3 for coord-only)

3. Read the diff:
   - Identify the ticket branch and target base (`dev`)
   - Review all changed files in the diff
   - If a PR exists, read it via `gh pr view` or the PR ref in the board

## Phase 2: Multi-Lens Review

Apply the canonical **review lenses** — the diverse, adversarial semantic-
correctness lenses codified in `coord/scripts/review-lens-catalog.js`
(`REVIEW_LENS_CATALOG`). Semantic / domain correctness is NOT statically gate-
able (see the boundary section of `coord/docs/QUALITY_DIMENSIONS.md`); these
lenses are how it is held to account, carried as review-cycle **evidence**, not a
checker. The first four are hard-required for move-review; the fifth
(adversarial misuse) is **advisory** — apply it, but it does not block.

### Pass 1 — Correctness & Contracts
- Do public APIs match their declared contracts?
- Are state transitions correct and complete?
- Off-by-one errors, null/undefined risks, logic errors?
- Domain model constraints preserved?
- Shared types consistent across repo boundaries?

### Pass 2 — Security & Failure Modes
- Injection risks (SQL, command, XSS)?
- Auth/authz bypass opportunities?
- Sensitive data exposure in logs, responses, or storage?
- Error handling: graceful failures, correct propagation?
- Race conditions, TOCTOU, concurrency issues?
- Input validation at system boundaries?

### Pass 3 — Quality & Operability
- Test coverage for new/changed behavior?
- Performance: O(n^2), N+1 queries, unnecessary allocations?
- Logging/observability for production debugging?
- Backwards compatibility where applicable?
- Domain neutrality: no hard-coded vendor or domain-specific assumptions in shared layers?

### Pass 4 — Requirement Closure (lens: `requirement closure`)
- Does the implementation satisfy the ticket ask from the plan record?
- Is the requirement closure evidence accurate (Ticket ask / Implemented / Not implemented / Deferred)?
- For feature-proof tickets (check `tasks.json` metadata for cutoff thresholds): are feature proofs present and valid?
- Were gate results recorded?
- Does the closeout verdict match the actual changes?

### Pass 5 — Adversarial Misuse (lens: `adversarial misuse`, advisory)
Think like a hostile or careless user, not the happy path:
- Malformed, oversized, or out-of-range input; boundary and overflow values.
- Out-of-order / replayed / concurrent calls that violate assumed sequencing.
- Intended-but-unstated misuse: what can a caller do that the code never
  expected but does not forbid?
- What breaks the invariants the happy path silently assumes?

This lens is **advisory** — record what you probed as evidence; it does not add a
hard move-review blocker.

> The lens names above are the canonical buckets from `REVIEW_LENS_CATALOG`. When
> you record self-review / review cycles, phrase each `lens=` so it classifies
> into a distinct bucket (the move-review gate checks coverage of the four
> required buckets via `classifyLensBuckets`). Run
> `node -e "const {REVIEW_LENS_CATALOG}=require('./coord/scripts/review-lens-catalog.js'); for (const l of REVIEW_LENS_CATALOG) console.log(l.bucket+' — '+l.probe)"`
> to print the catalog, or `coord/scripts/gov explain <ticket>` to see recorded
> lens coverage.

## Phase 3: Findings

Record each finding with:
- **ID**: `$ARGUMENTS-F<N>` (e.g., `CLM-042-F1`, `CLM-042-F2`)
- **Severity**: `HIGH` / `MED` / `LOW`
- **Category**: correctness | security | quality | requirement
- **File:line** reference
- **Description**: What the issue is
- **Suggestion**: How to fix it

Example:
```
$ARGUMENTS-F1 | HIGH | security | <repo>/src/auth/guard.ts:42
  Missing tenant isolation check on query endpoint.
  Suggestion: Add tenantId filter to the where clause.
```

## Phase 4: Verdict

### If no HIGH findings:

1. Record the review evidence and findings (if any MED/LOW) in the plan record.
2. Move the ticket to done with landing evidence:
   ```bash
   coord/scripts/gov land $ARGUMENTS --pr "<pr-ref>"
   ```
   Or if already landed:
   ```bash
   coord/scripts/gov mark-done $ARGUMENTS --landed "<commit sha and evidence>"
   ```
3. Sync the board:
   ```bash
   node coord/board/board.js sync
   ```

### If HIGH findings exist:

1. Record all findings in the plan record.
2. Move the ticket back to doing:
   ```bash
   coord/scripts/gov return-doing $ARGUMENTS
   ```
3. Report the HIGH findings clearly so the implementer can address them.
4. Do not land or close the ticket.

## Phase 5: Governance Compliance Check

Verify these governance requirements were met during implementation:
- [ ] Commit messages contain the ticket ID `$ARGUMENTS`
- [ ] Work was done in a governed worktree (not the repo root)
- [ ] Lock was properly acquired and released
- [ ] Branch targets `dev` (not `main`)
- [ ] Plan record has all required fields (invariants, closure, review cycles)
- [ ] Feature proofs present (if at/after cutoff per `tasks.json` metadata)
- [ ] Gate artifacts are authoritative (not stale or non-authoritative)

Flag any governance violations as findings.

## Rules

- Review the actual diff, not the entire codebase.
- Be specific: reference exact files, lines, variables, and functions.
- Be constructive: every criticism includes a suggestion.
- Be proportional: don't block on nits; reserve HIGH for real problems.
- Respect project conventions and domain-neutral design principles.
- Do not hand-edit board state — use the governance CLI.
