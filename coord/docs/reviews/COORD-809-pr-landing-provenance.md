# COORD-809: PR-backed control-plane landing provenance

## Qualification repair status

The initial candidate `4ef4fcec709ed0c373d99395dcd0f73094f82d33` failed full Node 24 qualification in both the source run `37479065224` and PR run `37479154151`: 4,176 tests, 4,169 passes, three failures, four skips, and 35 new coverage identities. The three failures were a board-module `__testing.validateSchema` reference misclassified by the lifecycle facade scanner. The test now uses an explicit board-validator alias; neither the schema assertion nor the scanner was weakened.

The repair adds real Git resolver, missing-PR-index, invalid-board, planner refusal/attribution, and plan-path reader regressions. Successful `gitTry` calls capture UTF-8 output, and successful commit `rev-parse` emits an OID; unreachable empty-output fallbacks were removed at those narrow joins. GitHub retries now perform five retryable attempts followed by the sixth request, preserving the five backoff delays and exact final error while eliminating an unreachable loop epilogue.

The expanded supported focused suite at `/tmp/COORD-809-focused-snapshot-v9/` passes 330/330 on exact Node 22.8.0 and 24.21.0. Its remaining 14 focused-only gaps are in unchanged writer/publishability code and were covered in the earlier full measurement; this comparison is diagnostic, not a substitute for a new full run. `/tmp/COORD-809-mutations-v9/` retains the exact three mutant diffs and their intended semantic failures against the repaired source. Closeout source SHA-256 is `8d0311a8f1230b39a6740e08fc3ad5c439d28f9fa0064baa123ab6a2a5658cf8`; the landing writer remains `3d6697660689c98e311dbbeb85a7bce92a20c976cd5b1765334210dd6b1fce6d`. The independent source review found no scoped regression. Full qualification, review readiness, canonical engine loading, and terminal landing remain pending. The versioned evidence below records earlier attempts and must not be read as qualification of the repaired candidate.

The final test file (`7dace81ba781cb3d9c6f54f2d3c2b3aee887b481bf94b377f12b12f20cbe9936`) also reproduces the intended missing-landing assertion against unchanged old production in `/tmp/COORD-809-public-baseline-positive-v9/`. The final-source architecture ratchet against `7de78a5fc4425d01c26137b90d59adbf318f7f95` passes with zero production-LOC/composition-root violations and nine new advisory findings (`/tmp/COORD-809-v9-architecture.log`).

## Contract

A successful PR-backed Repo-X finalize records four separately verified facts:

- the canonical requested and returned GitHub PR identity and the configured control-plane repository;
- the selected base, merged state/time, ticket-affiliated PR head ref/OID, and GitHub merge OID;
- the normalized reviewed source OID, proven to be an ancestor of that immutable PR head;
- the governed workspace integration OID, proven after integration to contain the GitHub merge OID and then verified on the selected remote branch.

The source, PR head, GitHub merge, and governed integration are not interchangeable. A PR source is not required to be an ancestor of a squash-merge commit. The normal Repo-X PR path rejects multiple PRs because the CLI supplies one source OID and cannot safely associate it with several heads. It also rejects missing/mismatched repository, PR number, base, merge facts, ticket affiliation, source ancestry, or integration ancestry. These validations precede the workspace merge where possible; the integration-commit ancestry check follows that merge and precedes any optional landing push or terminal completion.

The schema stores one `pr_evidence` object on a `method: "pr"` landing record and keeps `source_commit_sha`, `commit_sha`, and `control_plane_verification` at the existing landing level. Exact replay compares semantic fields and preserves the original record; conflicting evidence refuses. A writer call cannot create a PR record from caller-shaped JSON: it requires the in-process verified proof produced by the preflight helper. Product-repo, no-PR, and explicit parent-fulfillment flows retain their existing meanings; a parent fulfillment is not forced to affiliate its parent's PR branch with the child ticket.

## Effect ordering

1. Resolve and validate the single PR tuple from the controlled GitHub adapter and independently query the configured control-plane repository identity.
2. Resolve the selected base and reviewed source; prove source-to-head ancestry using exact OIDs already present in the local object database. Missing objects fail closed; the helper does not fetch or publish.
3. The Repo-X planner resolves the current integration HEAD and every pending workspace branch tip once. Before its first merge, it requires the GitHub merge OID to be an ancestor of the current HEAD or at least one planned branch tip. This permits a squash commit while rejecting a valid but unrelated commit OID; the planner supplies its existing branch enumeration rather than closeout independently discovering worktrees.
4. Perform the explicitly requested governed workspace integration.
5. Prove the GitHub merge OID is an ancestor of the actual returned integration OID. Refusal here leaves an accurate journaled integration-effect receipt; it does not claim the integration was rolled back.
6. The landing writer independently repeats that ancestry proof before remote verification can opt-in to a push. Then verify actual integration ancestry on the selected remote branch, persist the schema-valid PR landing, and permit terminal `done` publication.

The PR head/merge payload is checked before integration. The new integration commit cannot be checked until the integration step produces it, so the later ancestry guard is intentionally a second validation stage.

## COORD-636 missing-record recovery design only

COORD-636 is already `done` and landed; its existing row and historical journal must remain intact. No recovery is implemented or executed by COORD-809. A future separately authorized recovery should expose a dry-run that reports the exact proposed record and the immutable evidence it joined, followed by an apply operation guarded by compare-and-swap under the ordinary governance mutation lock.

Before offering apply, the dry-run must independently establish all of the following from live artifacts rather than copy abbreviated prompt prose:

- the canonical COORD-636 row is still `done`, its PR index still names PR 144, and `landing_index[COORD-636]` remains absent;
- PR 144's canonical URL, repository, number, merged state/time, selected `dev` base, head ref/OID, and GitHub merge OID are retrieved from GitHub and the reviewed source `c16438fd92cf97ec316f2ab89a9f21a9eb70c769` is still provably related to the PR head;
- the actual governed integration merge (reported in the incident as `d7070e94`, to be resolved to and verified as a full OID) is supported by the existing governance journal/effect receipt and is an ancestor of the live `origin/dev`;
- the later post-closeout sync commit (`7de78a5fc4425d01c26137b90d59adbf318f7f95`) is treated as a separate event and is not substituted for the landing integration commit;
- no existing record or correction conflicts with the proposed tuple.

The apply step must require the reviewed dry-run digest plus expected canonical board digest and journal head; under the governance lock it rechecks every precondition, appends one recovery event with the evidence digests and actor, and writes only the missing structured landing record through a schema-valid board transaction. Stale state, absent source evidence, mismatch, ambiguity, or an occupied landing slot refuses without replacing historical evidence. The recovery event explains that it records a previously omitted receipt; it must not imply the original closeout wrote that receipt. A human-admin must separately authorize both implementation and execution of such a recovery. This document grants neither authorization nor a historical disposition.

## Self-hosting and qualification boundary

The ticket's linked worktree can implement and qualify this code, but its runner cannot write canonical authority. The current canonical engine cannot load code that has not yet been integrated, and a worktree merge does not restart the already-running process. The sanctioned fresh-canonical-runner bootstrap sequence remains unresolved; this implementation does not authorize a direct protected-branch merge, an ephemeral authority override, `--landed` misclassification, or an old-engine finalize followed by repair.

The public-command regression has an old-source red receipt at `/tmp/COORD-809-public-baseline-positive-v5/`: against production base `230ac89f`, the predecessor test hash `e1bb304392f6857c140f9e767b19060941a732f867ea87837b47e08b629a6460` records `result.ok: true` and a `done` board row, then `baseline.log` fails the deliberate assertion `successful PR-backed finalize must persist landing provenance`. This is the intended missing-record behavior, not a fixture/import/setup failure. The final test adds a repeat-finalize assertion after that same missing-record assertion; this v5 receipt is predecessor evidence, not a test-hash receipt for the final file.

## Historical v2 static review

The review checked the exact v2 callback and writer joins. The planner obtains current HEAD and every pending branch tip before its first merge, passes one complete candidate set to the closeout's internal callback, and reuses that discovered branch list for the merge. The callback accepts the GitHub merge OID only when it is already in current HEAD or at least one planned branch tip; the exact returned integration commit is still checked after the merge and before the landing writer. The writer independently checks that same returned commit before `evaluateControlPlaneLanding` can perform an opt-in push. The public and helper fixtures now use squash-style commits where the source and PR head are not ancestors of the squash commit, while the squash commit itself is carried into the governed integration. I found no scoped ancestry-ordering, ticket-binding, or no-PR/parent-fulfillment regression in this source review.

All PR proof stages reuse the control-plane repository root resolved during preflight: repository lookup, source/head proof, planned-candidate proof, and actual integration proof share one captured root. `defaultControlPlaneLayout()` is memoized, so the prior fallback had no demonstrated runtime divergence; the captured root makes the repository binding explicit. The private workspace merger returns an array on every successful path and throws on failure, so its caller no longer applies an unreachable `|| []` fallback. The raw registered-PR URL guard remains independent of the verifier result to prevent a broken verification collaborator from downgrading PR evidence to no-PR.

The idempotence evidence has two distinct contracts. The landing-writer test proves exact semantic replay and conflicting-proof refusal without a second push. The public test repeats identical PR-backed `finalize` arguments and expects the established done-ticket refusal, unchanged board bytes/landing, and unchanged remote. This is not a successful public retry path: `finalizeTicket` routes it to `finishTicket`, which requires `doing` or `review`. The test does not broaden done-ticket semantics. Full native and packaged qualification are outside this static review and remain separate acceptance evidence.

The tests and qualification results must be reported separately from review, PR merge, canonical landing, and publication. In particular, a passing local-bare-remote regression proves the code path only; it does not resolve the self-hosting prerequisite or recover COORD-636.

## Independent v2 mutation-evidence review

I reviewed `/tmp/COORD-809-mutations-v2/results.json`, the three captured `test.log` files, `/tmp/COORD-809-mutation-probes.py`, and the frozen v2 focused snapshot. The v2 focused runner reports 206/206 passing on exact Node 22.8 and 24; those runs include the three regression names used by the probes. The mutations were applied to a disposable copy, each replacement asserted one exact production-source match, engine manifest/pin were restamped for that disposable source, and the script restores the original file bytes in `finally`.

All three failures are semantic and target the intended joins:

- `omit-pr-writer-join` removes the `prEvidence` spread passed from closeout to the landing writer. The public finalize test reaches its deliberate `successful PR-backed finalize must persist landing provenance` assertion, proving that successful completion without the evidence-threading join omits the record.
- `bypass-planned-ancestry` renames the callback option so the planner never invokes the pre-merge ancestry validation. The refusal regression then observes a changed local integration HEAD for the unrelated-but-resolvable merge OID, failing its no-integration assertion.
- `bypass-writer-ancestry` removes the writer's `assertGithubMergeInIntegration` call. The direct writer test reports `Missing expected exception`, showing that an unrelated merge could proceed past the writer boundary.

The receipt records distinct mutant hashes and exit 1 for the expected targeted assertion in each case. At the v2 review, the snapshot and worktree hashes matched: PR-evidence helper `3922477c14b2f1a7c56fac2de0603ef218499f231ec075ca2f34014b402bd099`, closeout `2b946e044a666c68c40307e26bc3da3cc464c6533f17fa9cf65e6dd23950ebdb`, landing writer `3d6697660689c98e311dbbeb85a7bce92a20c976cd5b1765334210dd6b1fce6d`, and Repo-X planner `308099bff33ef699f96d0325ec11e5b3711fae560cf43215518e8d36ed681fb2`. These are historical v2 identities, not hashes of the latest candidate. Subsequent changes have their own receipts above.

The disposable mutation script restores its source files but does not retain a per-mutant patch artifact, so the review relies on its exact single-occurrence replacement strings, recorded original/mutant hashes, logs, and restoration behavior rather than a saved diff. The v2 architecture ratchet also passed with zero production-LOC or composition-root failures; it reported seven new advisory findings. The subsequent v3 test-only planner-fixture attempt is a separate diagnostic: its injected Git failures occurred during the earlier legitimate prodloc preview, before the planner guard under test. The fixture has been corrected to fail on the planner's second observation; no test result for that correction is claimed here.

## Initial candidate pre-commit verification

The final public regression overlay (`closeout.test.js` SHA256 `3bacc0b3b31b7a21e98680bde5ab077718c38557be554269df8f295343d8853d`) reproduces the original missing-record failure against unchanged production base `230ac89ff456a756222beffcc3abb529adc47126`: `/tmp/COORD-809-public-baseline-positive-v6/`. The old command returns success and records `done` before the explicit missing-provenance assertion fails. The disposable baseline differs only in that test and its regenerated integrity metadata.

The supported focused runner at `/tmp/COORD-809-focused-snapshot-v7/` passes **240/240 tests on exact Node 22.8.0 and 24.21.0**, including the public squash-merge flow, repeated-command refusal without changed landing/remote state, planner refusal before the first merge, and writer refusal before an opt-in push. Source hashes, raw native coverage, LCOV and reports are retained there. The new proof helper has no uncovered measured identities. The selected-suite diagnostic still reports 36 gaps across the broader legacy modules; it is not a full engine coverage qualification. Failed fixture attempts remain preserved separately, including the incorrectly timed planner fault injections in snapshots v3/v4.

The production refinement captures one preflight repository root for all later proof stages and removes the private merger's unreachable array fallback. The raw PR URL predicate remains independent of adapter-return length; its equivalent falsy-string fallback was removed without weakening URL recognition. Full hosted gates, sanctioned canonical loading, PR merge, terminal closeout and any historical recovery remain separate future steps.

Final-source mutation probes at `/tmp/COORD-809-mutations-v7/` retain each exact mutant diff and all three intended semantic failures. The original final closeout hash is `e8ac8bbb928e3bf7508b97dbca2ca287189d3a7c963bf09e8f9952831d5031b9`; the writer hash is `3d6697660689c98e311dbbeb85a7bce92a20c976cd5b1765334210dd6b1fce6d`. Each probe restored its original production bytes. This supplements, rather than relabels, the earlier v2 proof.

## Pre-existing integration HEAD provenance

When a verified GitHub PR merge is already an ancestor of canonical control-plane `HEAD` before the closeout transaction and there are no incoming workspace ticket branches, the PR preflight may use that exact observed `HEAD` as the integration commit. Closeout re-resolves `HEAD` after its no-op integration step and requires it to equal the captured preflight OID before writing the landing. The record keeps the three identities distinct: reviewed source in `source_commit_sha`, GitHub's merge in `pr_evidence.merge_sha`, and the pre-existing canonical integration commit in `commit_sha`.

This observed-head path does not create or imply a `control_plane_workspace_merge` receipt. A fresh or recovered lifecycle workspace merge remains preferred and supplies its own returned/recovered commit. If planned incoming branches existed, an actual merge OID is missing, a recovery receipt is present, or `HEAD` changed after preflight, closeout does not substitute the observed starting commit. No-PR and fulfillment closeouts continue through their existing paths.

## Round-two bootstrap repair evidence

The observed-HEAD repair is recorded in `coord/scripts/closeout.js` (SHA256 `c1da71c7a3ab627d01dcf7545636f5663a34623b06eb80219347367bbfa87666`). Focused snapshot v10 (`/tmp/COORD-809-focused-snapshot-v10/results.json`) passed 332/332 tests on Node 22.8 and Node 24.21.0. Root added a refusal assertion for an unavailable current HEAD to the helper matrix without changing production code; the current test file hash is `9f5dad9086bda2d3d32e54bc6ba42fd17a04d0210fbf2d4571a241ef3b91bfe7`. Snapshot v11 is running, so no v11 result is claimed here. The independent source review is `/tmp/COORD-809-bootstrap-repair-independent-review.md`.

The architecture ratchet was evaluated against base `1553d7a3dc0c34f428fc18a6544ae081e558ad9d`, with current `closeout.js` source hash above. Its JSON diagnostic is retained at `/tmp/COORD-809-round2-architecture-review.md`; it reports three new warning findings and zero new failures: duplication advisories for 53-line and 23-line blocks involving `examples/demo/coord/scripts/closeout.js`, and the repeated `local-review (no PR)` literal in `coord/scripts/closeout.js:327`. The configured ratchet escalates only new monolith and size findings, so these warning classes do not fail the architecture gate; `prodloc=0` and `compositionRoot=0`. This is static architecture evidence, not full candidate qualification.

The baseline regression and semantic mutation evidence for this repair are still pending. Full hosted/native qualification and this ticket's final review/landing remain pending; the v10 focused results and architecture warning do not close those gates.

Final round-two focused evidence: snapshot v11 passes 332/332 tests with no skips, cancellations, governed-tree violations or coverage-source violations on both exact Node 22.8.0 and 24.21.0. The changed closeout module has zero newly uncovered identities in the focused diagnostic; fourteen omissions remain in unchanged writer/publishability paths, so the diagnostic is not a full coverage-gate pass. Old production at `1553d7a3dc0c34f428fc18a6544ae081e558ad9d`, with only the new test and disposable integrity stamps overlaid, fails the new public regression with the observed full-40-character-OID error. Disabling only the repaired fallback return makes the same public regression fail with the missing-verified-integration error. Both semantic checks are recorded in `/tmp/COORD-809-round2-red-mutation-20261006T184407Z-2671015/result.json`; production and test hashes are retained there. Full hosted qualification and final governed landing remain pending.
