# COORD-630 dependency writer audit

## Scope and implementation provenance

The additive writer is already present on the starting commit `2f65e29f`,
delivered by COORD-673 (source `a71ce47b`, merge `dbc84354`). This ticket must
not claim to have implemented that fix again. `setFollowupRelation` validates
all IDs, reads and updates the board inside `withGovernanceMutation`, and takes
the coord-state lock for persistence and rendering. This is the same outer
runtime serialization used by `withBoardTransaction`; the narrower persistence
lock alone would not protect a read/modify/write sequence.

The additional fixture proofs exercise the public command dispatcher:

- Three successive blockers survive, including their readiness effects.
- Re-adding the middle blocker preserves order and does not duplicate it.
- Every response reports the complete resulting set.
- A replacement containing an unknown ID preserves the entire original board.
- Two OS-process writers share one initialized sandbox journal and board,
  rendezvous before dispatch, and preserve both additions. No live board is used.

Review found that the existing clear-all test requested a multi-parent `related`
exception, an operation the engine correctly refuses. It never checked that
setup result, so clearing an empty fixture passed vacuously. The revised test
successfully seeds two blockers and one exception, asserts their presence, then
checks removal. This exposed a real existing writer regression: the no-ID
independent branch returned `existing.join(", ")` despite documenting wholesale
removal. The one-line repair returns an empty dependency string. Before repair,
the corrected suite failed 1/15; after repair it passed 15/15. Child-process
waits are bounded and terminate stalled workers.

## Other set-* verbs

Inspected the dispatcher in `cli.js`, writers in `lifecycle-ticket-admin.js`,
`governance-board-state.js`, and `plan-command.js`:

| Verb | Actual update semantics | Assessment |
| --- | --- | --- |
| set-followup-relation | Additive ordered set; explicit --replace; independent removes named/all edges | COORD-673 fixed the reported silent loss; extended proofs here |
| set-priority / set-type | Replace one scalar field | Scalar setters, not an accumulating evidence list |
| set-waiver | Replace the ticket's one prompt-coverage waiver; explicit --clear | Single-slot metadata, not a historical waiver ledger |
| set-pr | Replace the complete pr_index array after evidence verification | Multi-reference replacement remains implicit; follow-up should assess explicit replacement and full-set output |
| set-review-cycles | Unconditionally forwards replaceAllReviewCycles=true | Known destructive collection setter remains; prefer add-review-cycle for incremental records |
| set-requirement-closure | Append by default; replace only with --supersede | Explicit replacement already exists |

No behavior of these sibling verbs is changed by this ticket. Review-cycle
replacement and PR-list replacement are filed as COORD-748 for a separate
compatibility-conscious change, not an unreviewed change to every setter.

## Historical release dependency graph

Live board inspection on 2026-09-10 found all nine rows already `done`.
The original chain is only partly intact: COORD-625 now depends on COORD-631
and COORD-626 on COORD-635. Those later, substantive blockers must be preserved.

Proposed post-landing migration, using only `gov set-followup-relation`:

| Ticket | Resulting direct dependencies | Reason |
| --- | --- | --- |
| COORD-624 | none (unchanged) | Container payload isolation is independent |
| COORD-625 | COORD-631 (unchanged) | Preserve later security prerequisite |
| COORD-626 | COORD-635 (unchanged) | Preserve later consent prerequisite |
| COORD-479 | none | Onboarding preview does not depend on capability consent repair |
| COORD-618 | none | Installer wrapper decision does not require onboarding preview |
| COORD-619 | COORD-618 (unchanged) | Correct documentation must reflect the surviving installer path |
| COORD-620 | none | Engine-version parity does not require documentation repair |
| COORD-617 | COORD-624, COORD-625, COORD-626, COORD-479, COORD-619, COORD-620 | Publication must retain install, safety, onboarding, documentation and parity prerequisites; COORD-618 remains transitive via COORD-619 |
| COORD-621 | COORD-617 (unchanged) | Released npm-command tests require publication |

This table is a **pending migration**, not a claim of execution. The prompt
requires migration after landing. Preserve the old graph until the ticket can
pass its gates and land; then inspect every affected row with `gov explain`.
Because these rows are done, empty live blockedBy arrays would show only their
current completion, not prove that a future unfinished prerequisite blocks
publication. A controlled fixture must also test that counterfactual.

## Initial verification and blocked snapshot

The final corrected dispatcher suite passed 15/15 with subprocess permissions;
the production followups helper suite passed 6/6. `git diff --check` passed.
The sandboxed aggregate was interrupted after permission-related failures;
it is not valid zero-failure evidence. Isolated elevated reruns passed
code-context (56/56) and check-template-sync (4/4).

An elevated architecture rerun failed 1/86: `lifecycle.js` counts 2440 LOC
against a high-water budget of 2429. Neither file is changed by this ticket.
The starting tree therefore already violates a required full-suite check.
No limit was raised, no test skipped, and no done/landing claim is made.
The elevated aggregate began before the clear-all repair, reproduced that red
case, the budget failure, and several fixture authority refusals, and was
interrupted rather than presented as a completed run of the final patch.
An independent `governance-context.test.js` rerun passed 30/31: the lock-order
fixture redirects the lock but retains canonical state paths, so the linked
worktree authority guard correctly refuses it. This is not evidence that
production lock ordering is broken. Logs are retained locally in
`/tmp/coord630-full-unsandboxed.log` and `/tmp/coord630-context.log` (temporary,
not durable gate receipts).

The canonical plan records focused evidence, failed readiness review, and an
incomplete closure. COORD-674 already tracks the class of publishability-gate
escape; do not silently broaden COORD-630 into that repair. No graph migration,
engine integrity restamp, submission, or landing has been performed.

Prerequisite backlog records: COORD-749 repairs the current 2440/2429 budget
breach without relaxing limits; COORD-750 isolates the linked-worktree fixture
authority failures. Historical source measurements attribute three added LOC
to start-base wiring (`d898382f`) and eight to landing reconciliation
(`12cc7c39`); their parent measurements were 2429 and 2432 respectively.
Both prerequisites are recorded as blocking edges on COORD-630.

## Prerequisite repair and final verification

The preceding section preserves the initial failure evidence, not the current
prerequisite state. COORD-749 landed actual decomposition: lifecycle.js is now
2423 LOC with its cap lowered to 2423; token-economics.js is 1505 LOC with its
cap lowered to 1505. No budget was raised or disabled. COORD-750 landed isolated
governance-context, journal and board integration fixtures; its focused suite
passed 171/171 in both a linked worktree and an ordinary clone. COORD-751 repairs
the remaining recovery fixture setup through explicit synthetic-fixture approval,
retaining production refusal of unapproved reconciliation.

The prerequisite relationships were corrected through governance to the supported
closeout-blocker relation, permitting sequential repairs without weakening the
parent's closeout requirements. COORD-748 remains separate backlog work.

The expanded final dependency checks pass 23/23. They additionally prove each
of the six direct publication prerequisites independently blocks publication,
all-done permits readiness, and COORD-621 retains the transitive installer chain.
These counterfactuals use the real writer and readiness consumer on isolated
fixtures, rather than inferring correctness from already-done production rows.
The complete authoritative aggregate `npm test --prefix coord` passed on frozen
source `d6d39ed407d5738f2157d3fdbe51ee3cce6b2e5e` in an ordinary isolated clone:
7 modules, 250 files, 3312 tests, 3309 passed, 0 failed, 3 skipped, 0 cancelled.
All seven module processes exited zero; the governed-tree fingerprint reported
no violations. The checkout stayed intact until process completion and was clean
afterward. No test-selection filter or guard override was used.

The local machine report is `/tmp/concord-test-report-1789063585485-34703.json`,
SHA-256 `5a6256278a5c9e73af2a94a0ecf2471e4645c2b40d54ad0ca767afb8b0acadd1`.
The temporary report is not a published release artifact; this committed summary
preserves the command, exact source and result. The three pre-existing skips
remain skips, not passing tests. An earlier COORD-750 aggregate was invalidated
by removing its working checkout during governed cleanup; none of its later
ENOENT results is used as acceptance evidence.

Only this verification narrative changes after the frozen-source aggregate;
production code and tests remain identical. Post-landing graph migration must
still execute through the canonical verb and be recorded in the governed plan
before reporting this ticket's work complete to the operator.
