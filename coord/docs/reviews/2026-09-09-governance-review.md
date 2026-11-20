# Governance implementation review

Reviewed revision: 04a418f62ffef8b5850f29618fa97188c58aa939.

Remote verification: `git ls-remote origin refs/heads/main` returned the same revision during this review.

Scope: policy and authority, pick/dispatch/start, prompt preconditions, plan writers and readiness, lock classification, journal baseline selection, gate execution/receipts, closeout, orchestrator reporting, recent COORD-731/734/735/736 changes, and proposed COORD-737/738. This is a governance-engine review, not a certification of all product/frontend/enterprise functionality. Canonical source and ticket records were not modified.

## Findings

### R1 — High: COORD-731 rejects legitimate plan updates

Location: coord/scripts/cli.js:667-678; coord/scripts/plan-command.js:53-85; coord/scripts/plan-records.js:37.

The guard uses planCommandUpdateOptions as the acceptance authority, although updatePlanBlock forwards to updateCanonicalPlanState and its writer accepts additional fields. gatePlan and bootstrapRisk are absent from the forwarding helper. SPECIAL_FLAGS contains functions, not option keys, so iterating its values cannot discover replaceReviewCycle.

Read-only reproduction using the actual parser and guard rejects --gate-plan, --bootstrap-risk, and --replace-review-cycle; --verify succeeds. No plan mutation is needed to reproduce. The new regression test checks only verification/verify and misses these valid inputs. The implementation guards only update-plan, despite the ticket asking for per-verb coverage.

Repair through an attributed follow-up to COORD-731. Derive accepted keys from the actual consumer contract, cover special parsers, and test the public CLI before any side effects.

### R2 — High: failed and modified gate execution publishes a contradictory authoritative receipt

Location: coord/scripts/gate-runtime.js:241-249, 303-345, 367-380, 403-449.

A real temporary Git repository, npm install and gate execution reproduced this. The requested lane was default; the gate modified a committed file, emitted a receipt with lane=ci and result=pass, then exited 1. The wrapper exited 1 and reported status=fail, but persisted the receipt with result=pass, lane=ci, git.worktree_clean=true, complete=true and authority.status=authoritative. The runner overwrites clean provenance, retains an existing lane, and does not bind an emitted result to the observed exit status.

This proves contradictory receipt publication, not a proven downstream landing bypass. Receipt consumers require separate tracing. Reproducer: /tmp/coord-review-zefpHV/gate-probe.js. Output receipts: /tmp/coord-gate-review-lHdEVl/coord/artifacts/gates/product/.

Repair the existing runner; require consistent lane/result and tracked-content provenance. Distinguish a clean initial checkout from content actually tested. This is concrete scope for COORD-738 and contradicts COORD-736's claim of no remaining gate-contract gaps.

### R3 — High: unavailable precheck evidence becomes not-started

Location: coord/scripts/token-economics.js:379-416, 1584-1649.

The git-contains probe returns passed=false for an unavailable ref. classifyPrecheckVerdict([thatResult]) returns not-started. Dispatch further reduces results to passed booleans and routes every non-satisfied verdict to spawn. Thus unavailable evidence cannot remain distinguishable from confirmed absence. Local remote-tracking refs are not refreshed by this probe; it is not a remote sweep.

Read-only reproduction: ref=refs/remotes/missing-review-probe, commit=HEAD returns detail=no or unavailable and verdict=not-started. The COORD-735 test only checks passed=false for an unavailable ref. Its acceptance explicitly requires unknown for unavailable remote evidence and stale/inaccessible-remote coverage.

Repair this contract before reusing prechecks in more command entrypoints. Existing COORD-685 also records the security boundary of shell-executing test probes; making these automatic in doctor would introduce effects into a read-only path.

### R4 — Medium: the landed COORD-731 change breaches the architecture ratchet

Location: coord/scripts/lifecycle.js export added by c4e46448; coord/scripts/arch-checks.test.js:310-317.

Focused test fails: lifecycle.js measured 2430 logical lines, budget 2429. This is an independently reproduced code failure, not merely a sandbox failure. The new test-facade export adds one line. Board validity and engine-pin consistency both pass despite this.

The unrestricted aggregate run also fails governance-validation.test.js:1463, the positive decomposition-proof case. decomposition-proof-gate.js:146 requires the configured high-water value to equal the computed count, so the same drift invalidates that proof.

### R5 — Medium: COORD-734's regression does not exercise the repaired validator join

Location: coord/board/board.test.js:464-474 versus coord/board/board.js:916.

The new test calls an already-existing classification helper with synthetic roots. It never creates an E/C lock or invokes board validation for those codes. Restoring only the defective B/F condition at the validation call site leaves every assertion in that new test unchanged. The earlier run in this conversation in fact passed the helper test before the call-site fix was applied. Acceptance demanded agreement across start, board validation, doctor and closeout. The source fix is reasonable; the recorded proof is narrower than the acceptance.

### R6 — Medium: precondition checks occur before the start-time remote refresh

Location: coord/scripts/ticket-transitions.js:742-745; coord/scripts/prompt-coverage.js:431-454,490-520; coord/scripts/worktree-ops.js:456-488.

Start checks optional declared artifacts against cached integration refs, then worktree creation fetches. A newly landed dependency can be rejected against stale refs before the fetch, or a stale premise can pass before the new base is selected. This is a source-traced ordering issue; no full lifecycle reproduction was performed here. Reuse the existing refresh mechanism and verify against the commit used to create the worktree.

### R7 — Medium: checkpoint fallback repeats a rejected snapshot selection

Location: coord/scripts/journal.js:428-464. Existing ticket: COORD-715.

The initial branch rejects a checkpoint whose digest differs from the latest journal event. When the event artifact is missing, the fallback returns that same checkpoint without the digest comparison. This provides a specific explanation for some false drift reports; it does not justify the broader claim that every legitimate Git pull causes false tamper alarms. Reuse COORD-715.

### R8 — Medium: canonical policy contradicts durable-state and offline behavior

Location: coord/GOVERNANCE.md:68,255,277,586; coord/DIRECTORY.md:54-100; .gitignore; coord/scripts/worktree-ops.js:456-488.

Policy calls all runtime state ephemeral, but the journal is tracked and canonical plan records are durable. Policy describes explicit offline fallback while branch creation automatically warns and falls back when fetching fails. Its missing-journal guidance also contradicts the stricter reconciliation section. Existing COORD-485 owns policy/runtime durability alignment. Resolve policy choices explicitly and conformance-test the chosen behavior.

### R9 — High verification gap: recovery tests fail before reaching recovery

Location: coord/scripts/missing-ticket-lock.test.js:39; coord/scripts/session-lifecycle-worker.js:40; coord/scripts/doctor-recovery.js:548.

The unrestricted full runner fails 44 missing-lock cases during fixture initialization: `Reconcile requires --human-admin-override to establish a missing governance baseline.` The shared fixture calls reconcile with a reason alone against an empty baseline. Consequently the affected takeover, rollback, workspace-preservation, live-owner refusal and same-owner recovery cases do not reach the behavior they claim to verify. This is stale test setup against a correctly fail-closed production check, not evidence that every recovery implementation is broken. The session-lifecycle worker has the same initialization call and needs the same contract review.

Repair the isolated fixture authorization/setup, retain the production refusal, and rerun the complete recovery and lifecycle paths. Attribute this as a COORD-668 compatibility follow-up affecting COORD-712/716/728/729 proof, rather than dismissing the failures as environmental or weakening reconcile.

The unrestricted lifecycle case also times out at 180 seconds and retains the parent test process plus three IPC workers afterward. The async ready/done waits do not observe test cancellation; worker error handling sets exitCode without closing the IPC listener. The aggregate runner uses spawnSync without a module timeout, so a timed-out child case can stall the whole run and prevent report publication. Four verified review-only processes were terminated after the deadline to continue inventory execution. The separate shared-runtime conformance case did pass. This cleanup gap belongs with the lifecycle-test repair; cancellation must settle pending waits and reap workers in a bounded way.

### R10 — High: shared install-engine dependency is missing from the SEA bootstrap

Location: create-concord/lib/install-plan.js:25; release/sea/sea-entry.js:31-34; release/sea/sea-config.json:4-6. Introduced by 894a3915 (COORD-517).

The shared engine now requires ../../coord/project-owned-state.js. SEA still stages only install-plan.js into a fresh temporary directory and immediately requires it, before extracting its payload. That relative dependency does not exist there. Eight real SEA entrypoint tests fail with MODULE_NOT_FOUND, including dry-run, consent/apply, archive rejection and product-repository refusal. A separate unrestricted two-file rerun reproduces all eight. This is not a missing npm install: it is a source dependency omitted from the staging/asset contract.

Repair COORD-517's downstream composition by bundling or explicitly staging the shared module closure with a correct resolver. Keep the shared project-owned-state policy; do not fork the denylist. Reverify actual SEA staging, npm/SEA parity and negative archive/product-boundary cases. A built native binary was not executed in this review.

### R11 — Medium: public-claims inventory no longer follows the release builder

Location: release/check-public-claims.js:237-250; release/build-public-release.sh:337; release/check-public-claims.test.js:94,347.

The builder now removes project-owned donor records via PROJECT_OWNED_PATHS in JavaScript. The claims checker still discovers removed paths by parsing shell DELETE/rm syntax. It therefore inventories ticket prompts that the builder removes, and reports internal ticket text as public claims. Two unrestricted release tests reproduce this: the exclusion assertion fails and the donor-clean assertion lists eleven claims from non-shipping ticket prompts.

Consume the shared removal contract and retain a conformance check against the generated release. Do not silence the claims by rewriting historical tickets or adding broad exceptions. This is a COORD-517/488 integration repair, not evidence that those donor claims shipped publicly.

## Existing controls and backlog disposition

- The orchestrator already calls doctor and reports merged-but-not-done tickets from journaled github_pr_merge effects. It does not discover unjournaled external merges. With no unresolved questions it prints the count and returns before printing the individual candidates. Extend this existing report under COORD-737 rather than introduce a second competing model.
- Dispatch already consumes declared prechecks and produces skip/finalize guidance. pick uses its own recommendation path. start already enforces dependencies, prompt coverage, optional artifact preconditions and historical closeout evidence.
- The clean-checkout gate runner already materializes a commit in a temporary worktree. COORD-738 should address reproduced receipt/execution defects and routing through this runner. COORD-672 already covers ambient-state problems in linked-worktree tests.
- COORD-735 and COORD-736 are marked done but contain broader acceptance claims than their implementation and reproduced behavior support. Preserve historical records; any correction must be attributed through governance.
- The recurring defect is a producer/consumer mismatch concealed by tests of helpers or the presence of fields. New gates should not multiply until these contracts are corrected.

## Recommended disposition before expansion

| Work | Existing owner/surface | Review recommendation |
| --- | --- | --- |
| Valid CLI options and architecture regression | COORD-731 follow-up | Restore the supported writer contract; verify CLI behavior and full-runner acceptance. Do not raise the LOC budget simply to hide the regression. |
| Incorrect gate provenance/verdict | COORD-738; COORD-736 acceptance correction | Repair the existing runner and add a failing-gate/modified-source end-to-end witness. |
| Unknown and stale precheck evidence | COORD-735 follow-up | Preserve three-state evidence and bind checks to an identified integration commit before expanding consumers. |
| Arbitrary repository-code regression proof | COORD-734 follow-up | Exercise real locks through the repaired validator and lifecycle consumers; show reverting the call site fails. |
| External merged work discovery | COORD-737 | Extend the existing journal-based report and existing closeout recovery. Discovery is not permission to mark done. |
| Policy, journal, isolation, probe safety | COORD-485/715/672/685 | Reuse these tickets, distinguish their acceptance, and avoid duplicate initiatives. |
| SEA dependency closure and public inventory | COORD-517/488 follow-up | Wire both consumers to the shared policy and run release entrypoint tests before claiming delivery completeness. |

COORD-737/738 prompts still have generic acceptance and TODO verification sections. Low-ceremony filing is supported; these are not execution-ready specifications. Add concrete negative cases and identify production consumers before starting them.

For command roles: keep pick advisory and inexpensive; let start revalidate the selected ticket against the actual selected base before acquiring/committing work; keep ordinary doctor diagnostic and make external discovery explicit and bounded. A common result structure should preserve satisfied/not-satisfied/unknown and evidence identity. Do not execute arbitrary shell prechecks merely by invoking doctor, turn a network outage into a false absence claim, or auto-close on ticket-shaped text.

## Verification

- Canonical board validation: passes, 762 tickets, 0 doing.
- Engine pin: IN-SYNC.
- Strict template-sync and discovery coverage: 549 pass, 0 warnings, 0 failures; no untracked engine-managed files.
- Read-only parser/precheck reproductions: R1 and R3 confirmed.
- Real temporary Git/npm gate execution: R2 confirmed, with failure exit preserved.
- Focused architecture test: R4 confirmed (2430 > 2429).
- Sandboxed inventory run: all 247 files across 7 modules attempted; reported 215 passing files and 32 failing files. These are file-level counts, not individual assertion counts. Lifecycle workers exceeded the 180-second test deadline and were terminated at approximately 261 seconds to let subsequent files run. This result is not a cleanly completed conformance run. Report: /tmp/concord-test-report-1789002761530-2.json.
- Separate unrestricted focused run of architecture, business-discovery and code-context: 169 tests, 168 passed, 1 failed (architecture). This confirms that some sandboxed failures are environmental; it does not make the aggregate green.
- Unrestricted authoritative runner, isolated shallow clone, Node 25.8.1: 7 modules / 247 files; 3292 reported tests; 3232 passed, 56 failed, 1 cancelled, 3 skipped. Board, hooks, gates, enterprise and packaging passed. Core: 46 failed (2 architecture/decomposition + 44 missing-baseline fixture failures), 1 cancelled lifecycle case. Release: 10 failed (8 SEA dependency failures + 2 public-inventory failures). No governed-tree fingerprint violations. Lifecycle processes needed manual termination after their timeout, so this is a failed/interrupted conformance case, not a clean normal completion. Machine-readable report: /tmp/coord-review-zefpHV/full-report.json.
- Unrestricted release rerun (check-public-claims.test.js and sea/sea-entry.test.js): 29 tests, 19 passed, the same 10 failed. Error evidence: /tmp/coord-review-zefpHV/release-rerun.tap.
- Limits: no native SEA binary execution, no Node 22/24 matrix, no deployment qualification, no complete UI/product security audit, and no end-to-end landing bypass claim. Source-traced findings are distinguished from reproduced behavior above. Canonical working tree remains clean; source, tickets, ownership and locks were not changed.

## Execution disposition (2026-09-09)

Preserved original COORD-737/738 prompts and descriptions as P3 future backlog, gated on the repairs. COORD-746 retains the shared pick/start/doctor design and broader per-verb input-contract rollout remains future work. Immediate tickets: COORD-739 CLI/writer and lifecycle LOC; COORD-740 SEA dependency closure and claims inventory; COORD-741 recovery fixtures and worker cancellation; COORD-742 gate receipt consistency; COORD-743 precheck unknown/freshness; COORD-744 arbitrary-code integration proof; COORD-745 precondition/base ordering. Reuse COORD-715 checkpoint repair, COORD-485 policy alignment, COORD-685 shell-probe safety and COORD-672 ambient isolation.

Subsequent complete LOC sweep found token-economics.js at 1535 against 1515, previously masked by the first lifecycle assertion. This is additional existing COORD-735 debt assigned to COORD-743, not an allowance to raise its budget.

