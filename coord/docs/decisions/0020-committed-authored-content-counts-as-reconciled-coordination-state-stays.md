# ADR 0020: Committed authored content counts as reconciled; coordination state stays journal-only

- **Status:** Accepted
- **Ticket:** COORD-862
- **Date:** 2026-10-24
- **Linked scope:** `coord/engine/scripts/committed-state-adoption.js` (qualification rules); `coord/scripts/journal.js` (`withGovernanceMutation` adoption and `journal-baseline` event); `coord/engine/scripts/drift-scope.js` (authored-content classes); `coord/GOVERNANCE.md` section 10.8.

## Context

ADR 0002 makes the governance journal snapshot the only reconciled state. Any governed file whose bytes differ from the last journaled snapshot is drift, and the next governed mutation fails closed until `gov reconcile` adopts it with a human-admin override and an approved packet.

That rule also catches content that was reviewed and committed through Git. An agent edits a ticket prompt or an ADR in a ticket worktree, the change is reviewed in a pull request, and the merge reaches the integration branch. The canonical tree then holds bytes that Git reviewed but the journal never recorded, so every later governed mutation refuses until someone runs a manual reconcile. For authored text, this friction adds no integrity: Git's review and merge history already shows who changed the bytes and why.

The same shortcut would be unsafe for coordination state. The board, the plan records, `PLAN.md` and `QUESTIONS.md` are written only by governed transactions. A committed edit to them is the single-writer bypass the seal exists to catch (COORD-220), and Git history does not show that the transition was valid.

On 2026-10-24 the human admin decided: "Committed-state policy: Option B (narrow) — tracked content committed at HEAD counts as reconciled only for authored-content classes (prompts, decisions/ADRs); HEAD must be reachable from the integration branch; canonical tree only; every acceptance auto-appends a journal-baseline event citing the commit sha and paths; board, plan records, PLAN and QUESTIONS stay journal-only."

## Linked Scope

- Linked ticket: COORD-862.
- Governing ticket: COORD-862.
- Parent: COORD-516 (split into COORD-516a, which is COORD-862, and COORD-516b).
- Authored-content classes: files under the configured prompts directory (`coord/prompts/`) and the configured decisions directory (`coord/docs/decisions/`, including its `README.md` index).
- Journal-only classes: `coord/board/tasks.json`, plan records, `coord/PLAN.md`, `coord/QUESTIONS.md`, rendered views, sessions and locks.

## Decision Criteria

- No weakening of the single-writer seal for coordination state.
- An adopted path must have exactly the bytes committed at a HEAD that the integration branch contains.
- Every adoption is journaled, attributable to a commit, and reviewable afterwards.
- A path that does not qualify behaves exactly as before: it stays drift and the seal fails closed.

## Options Evaluated

1. **Option A (status quo):** only the journal snapshot counts as reconciled. This gives the strongest integrity, but reviewed, committed prompt and ADR edits keep failing closed until a manual reconcile.
2. **Option B (narrow):** committed state at HEAD counts as reconciled for authored content only, under the conditions below. Coordination state stays journal-only.
3. **Option B (broad):** any tracked file committed at HEAD counts as reconciled, including the board and plan records.

## Decision

Adopt option 2.

At the start of every governed mutation, before the out-of-band seal runs, the journal looks at the drift that is still unjournaled. For each drifted path in an authored-content class, the path is adopted only when ALL of the following hold:

1. The path is in an authored-content class: prompts or decisions. Membership is decided from the live configured directories.
2. The file is inside a Git checkout that is the canonical integration tree: its `.git` is a directory, and its runtime role marker does not name an ephemeral worktree. Linked ticket worktrees never adopt.
3. HEAD is a commit reachable from the local integration branch (`DEFAULT_INTEGRATION_BRANCH`, `dev` in this template). When a published `origin/<branch>` ref exists, HEAD must also be reachable from it.
4. The file exists, is tracked in the HEAD tree, and `git status` shows no staged, unstaged or untracked difference for it. The bytes on disk are therefore the committed bytes. A deleted path is never adopted.

The qualifying paths are adopted by one automatic `journal-baseline` event, appended before the seal. Its details record `reason: "committed-state-adoption"`, `policy: "ADR-0020"`, the triggering command, the HEAD commit sha, the integration branch, and the adopted coord-relative and repository-relative paths. Its `changed_paths` lists the adopted paths. The event's snapshot is the last journaled snapshot with only the adopted entries replaced, so all other drift stays detectable.

Paths that do not qualify are left as drift. The refusal message says why for each authored path (`differs_from_head`, `not_committed`, `deleted`, `non_canonical_tree`, `head_not_on_integration_branch`, `head_not_published`, and so on). It also names any journal-only path, noting that committing it does not reconcile it. `gov doctor` reports adoptable authored content as a pending warning rather than as a single-writer bypass.

Coordination state is unchanged: the board, plan records, `PLAN.md`, `QUESTIONS.md`, rendered views, sessions and locks are reconciled only by the journal (governed transactions, or `gov reconcile` with human-admin approval and an approved packet).

## Alternatives Rejected

- **Option A** keeps manual-reconcile friction on reviewed, merged authored text with no matching integrity gain.
- **Option B (broad)** would let a committed hand-edit of the board or a plan record pass as reconciled. This reopens the single-writer bypass (COORD-220) and breaks the journal's guarantee that each coordination-state transition was a governed one.
- **Adopting from any HEAD, or from a linked worktree**, would let unreviewed branch content, or a worktree's private state, become the canonical baseline.

## Consequences

- A reviewed prompt or ADR edit that reaches the integration branch no longer blocks the next governed mutation. The adoption is visible in the journal with its commit sha.
- The trust anchor for authored content becomes "committed on the integration branch". Anyone who can commit to the integration branch in the canonical tree can change authored content without a separate human-admin reconcile. The pre-bash guard and the PR flow remain the controls on that branch.
- Adoption calls Git only when authored drift exists, so a clean mutation pays no extra cost.
- Local-only commits on the integration branch that are not yet in `origin/<branch>` are not adopted while the published ref exists. They keep failing closed until they are pushed or journaled.
- ADR files that a `--merge-workspace` landing changes still need the COORD-839 approved packet at landing. This ADR changes only how drift that is already committed is treated afterwards.

## Revisit Trigger

Revisit if another authored-content class is proposed (for example product requirements), if the integration-branch model changes, if signed commits or a trusted-reviewer check become available to strengthen the anchor, or if an adopted change is later found to have bypassed review.

## Approval State

Proposed by claudea13 under COORD-862. This record restates the human-admin decision of 2026-10-24 quoted above. The human admin accepted this content on 2026-10-26, including the stricter `origin/<branch>` reachability check. The exact final bytes are approved through the landing packet.
