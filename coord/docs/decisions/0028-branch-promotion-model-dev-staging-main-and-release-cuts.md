# ADR 0028: Branch promotion model (dev, staging, main, and release donor branches) with escalating gates

- **Status:** Accepted
- **Ticket:** COORD-970
- **Date:** 2026-11
- **Linked scope:** `coord/GOVERNANCE.md` section 7.1 (branch promotion), section 10.2 (revert and hotfix), section 11.0 (integration authority, COORD-915); ADR 0021 (tiered ceremony, integration authority); ADR 0022 (sharded full gates); ADR 0025 (full-suite triggers and per-PR impact radius, COORD-966); COORD-910 (run manifest bound to tree and policy); COORD-912 (0.2.0 release plan); COORD-946 (green dev baseline); COORD-942 (open PR #373 proposing ADR 0027); `release/build-public-release.sh`, `release/publish-enterprise-release.sh`, `release/scan-donor-refs.sh`, `release/scan-enterprise-refs.sh`; `coord/engine/test-policy.json` stages.

## Context

GOVERNANCE.md section 7.1 today recognises one promoted branch. Ticket branches land on `dev`, and `main` moves only through an explicit promotion step. Nothing in the repository models staging or the release cuts.

Facts observed on 2026-11-16 (origin/dev `4be6e96f`):

- `origin/main` is `f83266de` (2026-10-02). It is an ancestor of `origin/dev`. `origin/dev` is 2,655 commits ahead of it, and 591 of those commits are merges. Dev holds 927 merge commits in total.
- No `staging`, `concord-public-release` or `concord-enterprise-release` branch exists on the remote.
- Public releases are built by `release/build-public-release.sh` (Community, the default cut) and `release/publish-enterprise-release.sh` (Enterprise, `--enterprise`). They read from the coord-template donor tree and write a separate output directory (`concord`, `concord-enterprise`). No branch records which donor commit a release came from.
- Dev is currently on a red full-gate baseline (DEV-BASELINE, 30 failures). COORD-946 is the ticket that makes dev green, and COORD-970 depends on it so that promotion gates can pass.

Human-admin decisions:

- 2026-11-12: the branch model is dev -> staging -> main, then main -> concord-public-release (Community) and main -> concord-enterprise-release (Enterprise). concord-public-release and concord-enterprise-release are donor branches that record exactly which donor commit was released per edition. Gates escalate by edge. Per-PR gating is the impact radius on Node 22 only. The full suite runs at promotion and nightly. The Node 22 and 24 dual-lane matrix runs at nightly and release (ruling); the COORD-970 board row also assigns Node 22 and 24 to `staging -> main`. That conflict is open question 8.
- 2026-11-16: draft the ADR for review. Nothing below is in force until the human admin accepts it.

## Linked Scope

- Governs the promotion edges and their gates. It does not change the per-PR gate in ADR 0025, which the 2026-11-12 ruling already sets for PRs into dev.
- Governs who may promote. It relies on integration authority (GOVERNANCE 11.0, COORD-915) and adds a human-admin approval for release edges.
- Governs hotfix flow. It restates GOVERNANCE 10.2 in terms of the new model.
- Defines the provenance a release branch carries. It does not define the promotion command (proposed in COORD-970 acceptance item 2, not yet named or built) or the branch creation; those are later governed steps.
- Repos: coord-template only. The public `concord` repository and any downstream repository are outputs of the release edges, not governed here.

## Decision Criteria

- No promoted branch receives code that has not passed the gate for its edge, on that exact commit.
- Each edge is a fast-forward of an exact commit. A promotion never creates a merge commit and never rewrites a promoted branch.
- Release branches can only be reached from `main`. Community and Enterprise cuts can never be built from an unpromoted or unverified commit.
- The human admin keeps control of anything that leaves the repository. This covers public release, Enterprise distribution, branch creation on the remote and rulesets.
- The model must not force a stale `main` forward or back. The stale `main` is reconciled by promotion through the model.
- Each edge's gate is named in `coord/engine/test-policy.json` stages, so `gov gate-plan` and `gov test-policy run` can enforce it.

## Options Evaluated

1. **Keep dev -> main only, and add release branches as tags.** Smallest change. Gives no staging soak, and release provenance lives in tags, which are not promotion targets.
2. **Linear model: dev -> staging -> main, then main -> the two release donor branches (chosen for proposal).** Matches the human-admin decisions. Every release edge is a fast-forward from a commit `main` already holds.
3. **Branch per edition fed directly from dev.** Shortest path to a release, but it lets a release skip staging and the full main gate. Rejected by the no-skipping rule.
4. **Merge-based promotion (`git merge` of dev into staging, main, and so on).** Simple to reason about, but creates merge commits on promoted branches and makes "exact commit" ambiguous. Rejected by the fast-forward rule.

## Decision

### 1. Branch roles

| Branch | Role | Who writes it |
| --- | --- | --- |
| ticket branches | Ticket work. Land on `dev` through governed closeout. | Ticket owner, via `gov`. |
| `dev` | Canonical integration branch. Landing evidence, ancestry audit and feature-proof checks run against it. | Governed landing only. |
| `staging` | Promotion candidate. Holds the exact `dev` commit that passed the dev -> staging gate. | Integration authority, via promotion only. |
| `main` | Promoted, release-quality branch. Holds only commits that passed the staging -> main gate. | Integration authority, via promotion only. |
| `concord-public-release` | Donor branch for the Community edition. Its head is the exact `main` commit last released as Community. | Release promotion only. |
| `concord-enterprise-release` | Donor branch for the Enterprise edition. Its head is the exact `main` commit last released as Enterprise. | Release promotion only. |

### 2. Allowed promotion edges

Only these edges exist. Anything else is refused by the promotion verb and is forbidden by policy.

1. `dev -> staging`
2. `staging -> main`
3. `main -> concord-public-release`
4. `main -> concord-enterprise-release`

Forbidden, without exception:

- `dev -> main` (skips staging), and `dev -> concord-public-release` or `dev -> concord-enterprise-release`.
- `staging -> concord-public-release` or `staging -> concord-enterprise-release`. Release branches are only fed from `main`.
- Any edge that writes into `dev`, `staging` or `main` from a release branch, including back-merges of release branches. Release-branch commits do not flow back. A later fix that is needed on a release goes through `dev` first (section 6).
- Any edge that moves a promoted branch backwards or non-fast-forward, unless the ADR is superseded.

### 3. Gate per edge

| Edge or event | Gate | Notes |
| --- | --- | --- |
| Ticket PR into `dev` | Impact radius (`radius.sh direct-impact`) on Node 22.8.0. | Per the 2026-11-12 ruling and ADR 0025. Not the full suite. Recorded by `add-repo-gate`. |
| `dev -> staging` | Full suite, sharded, on Node 22 (ADR 0022). | Also a mandatory full-suite trigger under ADR 0025 (c). The sharded run's shard count and slowest file are recorded. |
| `staging -> main` | Full suite on Node 22 and Node 24, plus the coverage ratchet. | Node 24 runs here, not per PR. Matches the existing `promotion` stage in `test-policy.json` ("mandatory full-suite plus coverage ratchet"). |
| `main -> concord-public-release` | Public release gates: Community cut build (`release/build-public-release.sh`), hygiene and leak scans (`release/scan-donor-refs.sh`, release secret scan), dual-release verify, and fresh npm and SEA install canaries. | Human-admin approval for this edge (section 4). |
| `main -> concord-enterprise-release` | Enterprise cut build (`release/publish-enterprise-release.sh`) and Enterprise qualification, including `release/scan-enterprise-refs.sh`. | Human-admin approval for this edge (section 4). |

The gate for an edge must have passed on the exact commit being promoted. Evidence is a run manifest bound to the tree and to the policy (COORD-910). A manifest for a different commit, a stale tree or an older policy version is refused.

Full-suite triggers in ADR 0025 (ten landings since the last full run, a radius threshold, a red full run, and any change to the runner, selector, policy, shared fixtures, journal or integration-authority core) are additional. They can force a full run at a PR edge, but they never lower an edge's gate.

### 4. Who may promote

- **Dev -> staging and staging -> main:** integration authority (GOVERNANCE 11.0, COORD-915). The holder runs the promotion, and the verb refuses if the holder is not the integration authority.
- **Main -> concord-public-release and main -> concord-enterprise-release:** integration authority, plus explicit human-admin approval recorded for that specific commit and edition. A standing approval is not enough (see open question 4).
- Nobody promotes with `git push` to a promoted branch. Promotion goes through the governed verb or is blocked by branch rulesets (section 8).

### 5. Fast-forward promotion of an exact commit

- Every promotion moves the target branch with a fast-forward to the named commit. The promotion verb (proposed, not built here) takes `--from`, `--to` and `--commit`.
- The promotion never creates a merge commit. If the target is not an ancestor of the commit, the promotion is refused. Divergence is not resolved by merging.
- `--force-with-lease` is not used on any promoted branch. The ADR allows no forced push, so the default is fast-forward only.
- Dry-run is required before a real promotion: it reports the commit, the edge, the gate evidence it found, and the fast-forward distance.

### 6. Hotfixes

- Ordinary urgent fixes land on `dev` first, through the ticket path, then move through `staging` and `main` under the normal edges (GOVERNANCE 10.2).
- A release-only fix is still made on `dev`. It then promotes through staging and main, and the next release edge carries it.
- A direct `main` hotfix remains human-admin only (GOVERNANCE 10.2), records the override reason, and opens a follow-back ticket that replays or verifies the fix on `dev` before the next promotion.
- A hotfix never goes directly to a release branch.

### 7. Provenance of a cut, recorded on the release branch side

For each release edge, the promotion records:

- the donor commit: the exact `main` SHA promoted to the release branch;
- the cut tree digest: the digest of the tree the cut build produced from that donor commit;
- the manifests: the gate's run manifest (COORD-910), the release-gate evidence, and the scan reports;
- the journal entry for the promotion, with the identity of the approving human admin.

Where this is recorded is an open question (question 3). The proposal is that the release branch head is the donor commit itself, and that the provenance is an annotated tag and a journal record, not a commit on the release branch.

### 8. Branch setup and rulesets

- Creating `staging`, `concord-public-release` and `concord-enterprise-release` on the remote is outward-facing. It happens only after this ADR is accepted and with explicit human-admin approval at that step.
- GitHub rulesets are proposed as a reviewed change: no direct pushes to promoted branches; promotion only through the governed verb or required status checks; no force pushes or deletions on promoted branches.

### 9. Reconciling the stale `main`

- `main` is reconciled by promotion, not by force. The first movement is `dev -> staging` of a chosen dev commit, then `staging -> main` of the same commit, each under its gate.
- Because `f83266de` is an ancestor of dev, a fast-forward is possible. The size of that movement (2,655 commits, including 591 merges) is a human-admin decision (question 6).
- Until the first promotion, `main` remains at `f83266de`, and nothing reads it as current.

### 10. Required changes after acceptance (not done by this ADR)

- `GOVERNANCE.md` section 7.1 is replaced with the text in the block below.
- `GOVERNANCE.md` section 10.2 is updated to the hotfix flow in section 6 above.
- The release runbooks and `COORD-912` are updated to name the release branches and provenance.
- The promotion command (dry-run, edge refusal, gate binding, fast-forward enforcement, journal, release provenance) is built as a separate governed ticket, with the fixture end-to-end promotion dev -> staging -> main -> concord-public-release.

## Proposed GOVERNANCE.md Section 7.1 (not in force until this ADR is accepted)

The following text is the proposed replacement for `coord/GOVERNANCE.md` section 7.1. This ADR does not edit GOVERNANCE.md. The replacement is adopted only when the human admin accepts this ADR and the change is made as a governed edit.

> ## 7.1) Branch Promotion Model
>
> For governed repo work (any repo code except `X`):
> - ticket branches land on `dev`; `dev` is the canonical integration branch for landing evidence, ancestry audit and feature-proof checks
> - promoted branches, in order: `staging`, then `main`; release donor branches `concord-public-release` (Community) and `concord-enterprise-release` (Enterprise) are fed only from `main`
> - allowed promotion edges are only `dev -> staging`, `staging -> main`, `main -> concord-public-release`, and `main -> concord-enterprise-release`; any other edge is refused
> - the gate for each edge is: PRs into `dev` run the impact radius on Node 22; `dev -> staging` runs the full suite sharded on Node 22; `staging -> main` runs the full suite on Node 22 and Node 24 plus the coverage ratchet; `main -> concord-public-release` runs the public release gates; `main -> concord-enterprise-release` runs the Enterprise cut build and Enterprise qualification
> - every promotion is a fast-forward of an exact commit that passed the gate for its edge; promotions create no merge commits and no forced pushes
> - promotion goes only through the governed promotion verb, by the integration authority (GOVERNANCE 11.0); release edges also require explicit human-admin approval for that commit and edition
> - release donor branches record the donor commit, cut tree digest and manifests of each released edition (see ADR 0028)
> - no agent pushes to `main`, `staging`, `concord-public-release` or `concord-enterprise-release` directly; promoted-branch rulesets enforce this
> - `main` is not advanced as part of ticket closeout; it moves only by promotion after the relevant `dev` baseline has landed and stabilised

## Alternatives Rejected

- **Option 1 (tags only):** rejected because tags are not a promotion target, cannot carry a gate, and give no soak.
- **Option 3 (edition branches fed from dev):** rejected because it skips staging and the main gate.
- **Option 4 (merge-based promotion):** rejected because it creates merge commits on promoted branches and blurs what "the commit that passed the gate" is.
- **Force-pushing the stale `main` to match dev:** rejected by the brief. It loses the record of the `main` history and skips the gates.
- **Enterprise release from `dev` or `staging`:** rejected because the Enterprise cut must come from a promoted commit.

## Consequences

- Every release has a named donor commit on a branch. The cut can be rebuilt from that commit, and the build's provenance can be checked.
- Hotfixes take longer to reach a release, because they must pass dev, staging and main. That is intentional.
- Promotions are large while `main` is stale. The first reconciliation moves about 2,655 commits (question 6).
- Until COORD-946 makes dev green, the dev -> staging gate cannot pass. No promotion happens before that.
- The promotion command and the rulesets are real work after acceptance. This ADR records the model only.

## Revisit Trigger

- A promotion requires skipping an edge in an emergency and no human-admin path is acceptable.
- The Node 24 requirement at `staging -> main` is judged too slow for the promotion cadence, or it misses a failure the Node 22 run does not.
- The first reconciliation of `main` (section 9) shows that a fast-forward of that size cannot be reviewed.
- A downstream adopter needs a release edge other than the two named editions.

## Open Questions For The Human Admin

1. **Acceptance.** Accept this ADR as written, or accept it with changes? Until accepted, the model is a proposal and no branch is created. Resolved at acceptance (human admin, 2026-11-16): accepted as written, the Decision section as proposed. No branch is created by this acceptance.
2. **Radius threshold.** ADR 0025 leaves the radius threshold open (40%, 70%, 85% or none). The dev-PR gate here does not depend on it, but the full-suite trigger (b) does. Which threshold? Resolved: 70% of suites, per ADR 0025 accepted by the human admin on 2026-11-15. ADR 0028 proposes no threshold. ADR 0025 records its own radius threshold choice (70% of suites, human-admin decision of 2026-11-15, recorded under COORD-1024).
3. **Provenance location.** Should the cut's provenance be an annotated tag on the donor commit plus a journal record (proposed), or a provenance file committed on the release branch? A committed file is a commit the donor did not contain, which conflicts with "exact commit". Resolved at acceptance (human admin, 2026-11-16): "an annotated tag on the donor commit plus a journal record (proposed)". No provenance file is committed on the release branch.
4. **Release approval.** Is human-admin approval given per commit and per edition (proposed), or is a standing approval for an edition enough? Does a standing approval cover every subsequent promotion of that edition? Resolved at acceptance (human admin, 2026-11-16): "human-admin approval given per commit and per edition (proposed)". A standing approval is not enough (section 4).
5. **Merge commits.** The acceptance text says "no merge commits on promoted branches". Dev holds 927 merge commits, and 591 sit between `main` and dev. A fast-forward promotion carries those merges into the promoted branch's ancestry. Should the rule mean "the promotion creates no merge commit" (proposed) or "promoted branches are linear"? The second would need a linearised promotion, which this ADR does not propose. Resolved at acceptance (human admin, 2026-11-16): "the promotion creates no merge commit" (proposed).
6. **Reconciling `main`.** Approve the first promotion of about 2,655 commits (591 merges) from `f83266de`, and choose the dev commit to promote. Should it be a single dev snapshot that has passed the full suite, or a range? Still open at acceptance. ADR 0028 proposes no dev commit to promote and no answer on whether the first promotion is a single snapshot or a range. Resolved (human admin, 2026-11-16): main is first reconciled only after dev is green (COORD-946), by promoting one dev commit that passed the full sharded suite, with human-admin approval at that time.
7. **Dev baseline.** Promotion gates cannot pass while dev is red (DEV-BASELINE, 30 failures). Confirm that COORD-946 must close before the first `dev -> staging` promotion, and say whether the 2026-11-12 per-ticket red-baseline exception applies to promotions as well. Resolved at acceptance (human admin, 2026-11-16): COORD-946 must close before the first `dev -> staging` promotion, and no promotion happens before that (Consequences: "Until COORD-946 makes dev green, the dev -> staging gate cannot pass. No promotion happens before that."). Still open at acceptance. Whether the 2026-11-12 per-ticket red-baseline exception applies to promotions; this ADR does not answer it. Resolved (human admin, 2026-11-16): the 2026-11-12 per-ticket red-baseline exception does NOT apply to promotions; promote refuses on red.
8. **Node 24 at staging -> main.** Confirm that Node 24 runs at `staging -> main` and at release, and not on per-PR runs, as the 2026-11-12 ruling states. Resolved at acceptance (human admin, 2026-11-16): Node 24 runs at `staging -> main` and not on per-PR runs (section 3: "Node 24 runs here, not per PR"). Still open at acceptance. Whether Node 24 also runs at release; the gate table names no Node 24 gate for the release edges.
9. **Scope of the release edges.** The Community cut builds from `main` via `release/build-public-release.sh`, and the Enterprise cut via `release/publish-enterprise-release.sh`. Confirm that both builders are to take their input from the release donor branch, not from the working tree. Resolved at acceptance (human admin, 2026-11-16): the cut is built from the donor commit, and the release branch head is the donor commit itself (section 7: "the tree the cut build produced from that donor commit"; Consequences: "The cut can be rebuilt from that commit"). Still open at acceptance. The mechanism by which each builder reads the donor commit; this ADR names the builders but does not specify how they read it. Resolved (human admin, 2026-11-16): both builders take input only from the release donor branch, not from the working tree.
10. **Rulesets.** Confirm the proposed GitHub ruleset set (no direct pushes, required checks, no force push or delete on promoted branches) as a reviewed change before the remote branches are created. Resolved at acceptance (human admin, 2026-11-16): the proposed set in section 8: "no direct pushes to promoted branches; promotion only through the governed verb or required status checks; no force pushes or deletions on promoted branches". The remote branches and rulesets are created only after a separate human-admin approval at that step (section 8).

## Waiver Policy

Waivers are ticket-scoped and recorded in the ticket's closure. A waiver can let one promotion skip a gate only with explicit human-admin approval recorded in the journal, naming the edge, the commit and the reason. A waiver never permits a skipped edge, a non-fast-forward promotion or a release edge without human-admin approval. Repeated waivers require a superseding ADR.

## Approval State

Accepted by the human admin on 2026-11-16 (human-admin decision, given directly in the orchestrator session and recorded under COORD-1030). The Decision section is accepted as written. The ten questions under Open Questions For The Human Admin are answered as recorded above, each with the default the ADR proposes; where the ADR proposes no default, the question is marked still open. No branch, ruleset or GOVERNANCE.md change is made by this record: the remote branches and rulesets need their own human-admin approval (section 8), and the section 7.1 text is adopted only by a governed edit (section 10). Review by agents is not human approval.
