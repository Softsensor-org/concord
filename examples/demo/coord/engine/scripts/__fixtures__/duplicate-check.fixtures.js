"use strict";

// COORD-975 fixtures for the duplicate-ticket check. The board rows are a snapshot of
// the canonical coord/board/tasks.json taken on 2026-11-14 (the nine tickets the audit
// proposals overlap), copied so the suite does not depend on live board state. The
// proposals are the 2026-11-13 architecture audit proposals (ARCH-AUDIT-2026-11-13.md,
// findings F-02, F-08, F-15) as worded there, plus one distinct-scope near miss and one
// unrelated ticket. This directory is skipped by the guard-registry scanner (__fixtures__).

const FIXTURE_ROWS = [
  {
    "ID": "COORD-898",
    "Status": "done",
    "Description": "[TAKEN OVER 2026-11-13 by human-admin direction: the reservation for claudea790 / the acme-coord downstream hand-off is released; this board (orchestrator claudea11) implements it in coord-template ONLY; no change is made in acme-coord or any downstream repository. The cited handoff bundles under /home/vgup are not present on this host, so work proceeds from the code paths and acceptance below.] [Field report] gov submit refuses \"Could not verify commit delta\" in a product clone that has origin/<integration branch> but no local branch of that name. Reported 2026-11-05 from a downstream adoption: COORD-028 was committed and passed every check, but submit failed in the fleet_rn_app and fleet_driver_rn_app clones, which had only origin/development. The operator created a local development ref pointing at origin/development to proceed. Cause (coord-template, verified in code): gov start branches from a fetched origin/<base> and only falls back to the local branch (coord/engine/scripts/worktree-ops.js ~491), but the submit/review-state delta check (coord/engine/scripts/lifecycle-review-state.js ~153, via resolveLandingBaseRef in landing-resolution.js) uses the bare local branch name when no landing commit is known yet, so `git rev-list <base>..HEAD` fails when the local ref is absent. The workaround is itself hazardous: a local pointer does not move on fetch, so once it lags origin the ahead-count includes upstream commits and the >=1-commit check can pass for a ticket with no commits of its own. Install/onboard/doctor never check for a usable integration-branch ref.\nAcceptance: (1) one shared base-ref resolver used by start, submit, PR creation, closeout and every delta/ancestry check: prefer a fresh origin/<base>, fall back to the local <base>, fail closed only when neither resolves, with an error that names both refs and the remedy; (2) the delta is computed against the same base the worktree was started from (record it on the lock if needed), so a stale local ref cannot inflate the ahead-count; (3) doctor and coord onboard report a product clone with no usable integration-branch ref, or a local ref that lags its origin, with the exact remedy; (4) regression tests: origin-only clone start -> commit -> submit passes; stale local ref does not count upstream commits as ticket commits; neither ref present fails closed with the named remedy; doctor findings for both conditions. Verification: lifecycle-review-state, landing-resolution, worktree-ops and doctor suites, a disposable install with an origin-only product clone, full gate on Node 22 and Node 24."
  },
  {
    "ID": "COORD-938",
    "Status": "done",
    "Description": "[Follow-up of COORD-901] Finish the umask-portability scope COORD-901 left open in stack B. COORD-901 normalized file modes in the engine pin only.\nAcceptance: (1) audit the other sites that record mode & 0o777 (create-concord/lib/install-plan.js payload records; coord/engine/scripts/tree-fingerprint.js with its modes option): for each, decide whether it is an integrity comparison that umask must not affect, and normalize it or document why the raw mode is intended; (2) doctor names the umask (and the remedy) when a remaining mode finding is explained by a group-writable umask; (3) a disposable install, upgrade and verify under umask 0002 passes, as under 0022. Verification: engine-pin, install-plan, tree-fingerprint and doctor suites; the umask 0002 install proof; full gate on Node 22 and Node 24.\n"
  },
  {
    "ID": "COORD-958",
    "Status": "doing",
    "Description": "[Simplification, guard merge, human-admin approved 2026-11-12] Merge guards template-sync + engine-pin into one regenerate-and-verify step. Proposed in the COORD-914 guard registry (coord/engine/governance-guards.json, review.proposed_merges id \"engine-surface-integrity\") under ADR 0021. Rationale: Every ticket regenerates both in the same final commit.\nAcceptance: (1) one implementation replaces the 2 guards; their refusal sites and blocker codes map to the merged check (old codes kept as aliases or documented as renamed); (2) every incident in must_still_cover keeps a regression test that fails without the merged check:\n- untracked engine-managed files (COORD-606, COORD-607)\n- the independent post-build pin check (COORD-677)\n(3) the guard registry and GUARD_REGISTRY.md are updated (merged entry, removed entries, the proposal marked done) and guard-registry check passes; (4) no protection is lost: a test enumerates each old guard's refusal cases and proves each still refuses; (5) fewer operator steps: record before and after the number of governed commands or blocker codes a ticket meets for this concern.\nAlso (field evidence 2026-11-12): the merged step must regenerate the manifest and pin of the ticket worktree it is run for, and refuse (or warn) when invoked against the canonical checkout while the target is a ticket worktree; four workers today re-pinned ROOT by running the canonical script, which left their branches stale and broke closeout tests.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-959",
    "Status": "todo",
    "Description": "[Simplification, guard merge, human-admin approved 2026-11-12] Merge guards repo-gate-record + gate-plan-receipt + closeout-landing-evidence into machine-verifiable run manifests (COORD-910). Proposed in the COORD-914 guard registry (coord/engine/governance-guards.json, review.proposed_merges id \"evidence-manifest\") under ADR 0021. Rationale: Prose evidence that a human reconciles goes stale; a manifest binds tree, base, policy, toolchain and edition.\nAcceptance: (1) one implementation replaces the 3 guards; their refusal sites and blocker codes map to the merged check (old codes kept as aliases or documented as renamed); (2) every incident in must_still_cover keeps a regression test that fails without the merged check:\n- a plan that records no executed gate (COORD-058, COORD-104)\n- an unmeasured merged head (COORD-703, COORD-830)\n(3) the guard registry and GUARD_REGISTRY.md are updated (merged entry, removed entries, the proposal marked done) and guard-registry check passes; (4) no protection is lost: a test enumerates each old guard's refusal cases and proves each still refuses; (5) fewer operator steps: record before and after the number of governed commands or blocker codes a ticket meets for this concern.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-960",
    "Status": "todo",
    "Description": "[Simplification, guard retirement, human-admin approved 2026-11-12] Retire guard \"legacy-entrypoints\" (COORD-914 registry, review.retirement_candidates) under ADR 0021. Rationale: Exists only for the COORD-589 shim deprecation window. Retire only once the COORD-589 shim deprecation window has closed and is recorded (COORD-868); until then the ticket documents the closing criteria and adds the regression test, and the retirement itself waits.\nAcceptance: (1) the guard is removed or folded as described, with coord/GOVERNANCE.md and docs updated where they name it; (2) every incident in must_still_cover keeps a regression test, or an explicit reviewed justification naming the guard that covers the risk instead:\n- adopters invoking coord/scripts/<module>.js paths until the window closes (COORD-868)\n(3) the guard registry and GUARD_REGISTRY.md are updated and guard-registry check passes; (4) the retirement criterion above is evidenced before removal.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-961",
    "Status": "todo",
    "Description": "[Simplification, guard retirement, human-admin approved 2026-11-12] Retire guard \"upgrade-bridge\" (COORD-914 registry, review.retirement_candidates) under ADR 0021. Rationale: Bridges v0.1.16 adopters only. Retire only after no supported adopter remains on v0.1.16 (record the evidence, e.g. after the 0.2.0 canary in COORD-912); keep the v0.1.16 rollback regression as an archived fixture test or document why it is no longer reachable.\nAcceptance: (1) the guard is removed or folded as described, with coord/GOVERNANCE.md and docs updated where they name it; (2) every incident in must_still_cover keeps a regression test, or an explicit reviewed justification naming the guard that covers the risk instead:\n- the v0.1.16 apply rollback (COORD-885, COORD-886)\n(3) the guard registry and GUARD_REGISTRY.md are updated and guard-registry check passes; (4) the retirement criterion above is evidenced before removal.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-962",
    "Status": "todo",
    "Description": "[Simplification, guard retirement, human-admin approved 2026-11-12] Retire guard \"critical-invariants\" (COORD-914 registry, review.retirement_candidates) under ADR 0021. Rationale: Overlaps requirement-closure; candidate to fold into it. Fold the invariant requirement into requirement-closure (one closure check that still refuses a product change with no stated invariant); migrate existing plan records without loss.\nAcceptance: (1) the guard is removed or folded as described, with coord/GOVERNANCE.md and docs updated where they name it; (2) every incident in must_still_cover keeps a regression test, or an explicit reviewed justification naming the guard that covers the risk instead:\n- product changes with no stated invariant (COORD-029)\n(3) the guard registry and GUARD_REGISTRY.md are updated and guard-registry check passes; (4) the retirement criterion above is evidenced before removal.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-963",
    "Status": "todo",
    "Description": "[Simplification, guard retirement, human-admin approved 2026-11-12] Retire guard \"wip-cap\" (COORD-914 registry, review.retirement_candidates) under ADR 0021. Rationale: Protects attention, not state; integration authority and dependency readiness cover the state risks. This changes coord/GOVERNANCE.md section 11 (WIP limit 5 hard check) and the orchestrator contract; update the policy text in the same ticket. Keep detection of one owner silently holding unrelated doing tickets as a doctor warning or orch report if the hard cap is removed.\nAcceptance: (1) the guard is removed or folded as described, with coord/GOVERNANCE.md and docs updated where they name it; (2) every incident in must_still_cover keeps a regression test, or an explicit reviewed justification naming the guard that covers the risk instead:\n- one owner silently holding unrelated doing tickets (COORD-008, COORD-558, COORD-692)\n(3) the guard registry and GUARD_REGISTRY.md are updated and guard-registry check passes; (4) the retirement criterion above is evidenced before removal.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  },
  {
    "ID": "COORD-964",
    "Status": "todo",
    "Description": "[Simplification, guard retirement, human-admin approved 2026-11-12] Retire guard \"adr-path-packet\" (COORD-914 registry, review.retirement_candidates) under ADR 0021. Rationale: For ADR metadata-only edits, once a decision-context record exists. Depends on the decision-context record (COORD-932): ADR metadata-only edits are then validated by that record, while ADR body changes still require review before reaching the integration branch.\nAcceptance: (1) the guard is removed or folded as described, with coord/GOVERNANCE.md and docs updated where they name it; (2) every incident in must_still_cover keeps a regression test, or an explicit reviewed justification naming the guard that covers the risk instead:\n- unreviewed ADR body changes reaching the integration branch (COORD-722, COORD-839)\n(3) the guard registry and GUARD_REGISTRY.md are updated and guard-registry check passes; (4) the retirement criterion above is evidenced before removal.\nVerification: the affected guard and lifecycle suites, guard-registry check, and the gate gate-plan names on Node 22 (human-admin lane ruling 2026-11-12).\n"
  }
];

const PROPOSALS = Object.freeze({
  // True duplicate: F-08 overlaps COORD-958..964 (guard merges and retirements).
  F08_GUARD_MERGES: "Apply the guard-registry merge and retirement proposals under ADR 0021, with per-merge coverage evidence. Merges: template-sync with engine-pin, repo-gate-record with gate-plan-receipt and closeout-landing-evidence. Retirements: legacy-entrypoints, upgrade-bridge, critical-invariants, wip-cap, adr-path-packet. Each merge keeps its refusal codes. Verification: guard-registry check.",
  // True duplicate: F-02 overlaps COORD-938 (mode handling in engine-pin and tree-fingerprint).
  F02_GITFILEMODE: "Make file-mode.js the only gitFileMode; engine-pin.js and tree-fingerprint.js import it. Acceptance: grep for the owner-execute-bit mode expression finds one hit, and the engine-pin and tree-fingerprint tests pass unchanged.",
  // True duplicate: F-15 overlaps COORD-898 (one shared base-ref resolver).
  F15_BASE_REF: "Characterisation tests for base-ref resolution across the six call sites, then one resolveBaseRef({repoRoot, base, explicit, mode}) used by ticket-commands.js and landing-resolution.js.",
  // Near miss, distinct scope: the same guard registry file, a different concern (answers hygiene, not merges).
  NEAR_MISS_ANSWERS: "Add a registry test that every guard answers entry in coord/engine/governance-guards.json names a COORD ticket that exists on the board.",
  // Unrelated: frontend presentation, no shared paths, guards, functions or verbs.
  UNRELATED_UI: "Show the coord-ui dashboard legend with accessible contrast in dark mode and keep the chart palette consistent across tiles.",
});

// Guard ids of coord/engine/governance-guards.json at bbe65e6e (COORD-975, 2026-11-14), the
// registry the F-02/F-08/F-15 proposals were audited against. The live registry has since
// retired or merged several of these ids (COORD-958 merged template-sync and engine-pin into
// engine-surface-integrity), so the suites must not read the live file for their guard facet.
const GUARD_IDS = Object.freeze([
 "prompt-record",
 "prompt-registration-integrity",
 "adr-requirement",
 "adr-compliance-closure",
 "adr-path-packet",
 "adr-record-validity",
 "business-context-status",
 "context-pack-ack",
 "review-cycles",
 "review-round",
 "subagent-supervision",
 "requirement-closure",
 "critical-invariants",
 "feature-proof-resolution",
 "repo-gate-record",
 "gate-plan-receipt",
 "decomposition-proof",
 "bounded-repair-eligibility",
 "managed-auto-evidence",
 "review-plan-blockers",
 "start-readiness",
 "dependency-readiness",
 "submit-readiness",
 "unstart-evidence",
 "wip-cap",
 "owner-lease",
 "forced-rebind-liveness",
 "bound-owner",
 "co-located-writer",
 "dry-run-unsupported",
 "identity-provider-match",
 "identity-recovery",
 "canonical-authority-write",
 "runtime-lock-order",
 "seal-journal-drift",
 "journal-genesis",
 "sync-unapproved-drift",
 "sync-derived-recovery-proof",
 "board-cli-journal-bypass",
 "tree-mutation-safety",
 "publish-board-refusal",
 "workspace-merge-guard",
 "integration-authority",
 "production-loc-budget",
 "closeout-pr-ancestry",
 "closeout-landing-evidence",
 "landing-record-integrity",
 "evidence-reuse",
 "affected-selection-activation",
 "affected-selection-evidence",
 "test-policy-override",
 "test-policy-exception-authority",
 "test-policy-qualification",
 "fulfillment-closeout",
 "control-plane-layout",
 "governed-push-safety",
 "board-push-preflight",
 "commit-scope",
 "reconcile-approved-packet",
 "runtime-lock-cleanup",
 "worktree-removal-safety",
 "workspace-recovery-safety",
 "state-write-race",
 "terminal-ticket-admin",
 "lock-normalization",
 "followup-relation-integrity",
 "ticket-id-allocation",
 "finding-correction-authority",
 "independent-review-record",
 "continuity-write-safety",
 "plan-record-schema",
 "static-config-safety",
 "onboard-overwrite-safety",
 "discovery-output-boundary",
 "upgrade-apply-safety",
 "requirements-live-board-safety",
 "quality-observation-ingest",
 "learned-rule-promotion",
 "memory-secret-refusal",
 "dispatch-context-integrity",
 "input-path-safety",
 "engine-wiring-invariants",
 "mcp-launch-environment",
 "live-case-adapter-safety",
 "deploy-identity",
 "auto-mode-containment",
 "runtime-authority-hook",
 "enterprise-policy-broker",
 "dual-release-verify",
 "governance-full-suite",
 "test-isolation",
 "coverage-ratchet",
 "arch-quality-ratchet",
 "suite-inventory",
 "git-prerequisite",
 "test-title-precheck",
 "template-sync",
 "engine-pin",
 "dual-release-hygiene",
 "legacy-entrypoints",
 "upgrade-bridge",
 "sharded-result-authority",
 "shard-cleanup-safety",
 "multi-pr-ref-uniqueness"
]);

module.exports = { FIXTURE_ROWS, PROPOSALS, GUARD_IDS };
