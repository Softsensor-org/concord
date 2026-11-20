# ADR 0032: Qualify the immutable release candidate before donor promotion

- **Status:** Accepted
- **Ticket:** COORD-1056
- **Date:** 2026-11-18
- **Linked scope:** ADR 0028 (branch promotion and donor provenance), ADR 0031 (signed human approvals), COORD-912 (release qualification), COORD-1048 (signed approval enforcement), and COORD-1055 (release gate cache integrity).

## Context

The release edge requires green gates before moving an edition donor branch. A donor cut requires that the commit already be reachable from that branch. Developer cuts have no donor provenance, so the publication consumers correctly refuse them. Qualifying the old donor tip would test a different commit.

## Linked Scope

The governed promotion command, cut builders, release gate runner, local npm and SEA canaries, and independent post-publication checks are within scope. COORD-1056 records the decision and its implementation boundaries.

## Decision Criteria

Qualify the exact commit and both edition payloads under the full release policy before the first release ref moves. Preserve donor-only publication, explicit commit-and-edition approval, and separate post-publication installation evidence.

## Options Evaluated

1. Advance the donor ref before testing, or test an existing donor tip. This would advance an unqualified commit or qualify different bytes.
2. Simulate future donor refs and reuse publication attestations. This would treat a provisional cut as publishable before the governed promotion.
3. Build qualification cuts directly from the immutable candidate with their own validated purpose and schema. The human admin accepted this option on 2026-11-18.

## Decision

This supplements [ADR 0028](0028-branch-promotion-model-dev-staging-main-and-release-cuts.md) for the two release edges. Both edition qualifications use the same full candidate commit, its verified Git tree, and a clean detached snapshot after the required Node 22 and 24 source gates. The candidate must satisfy the existing source-ref and per-edge ancestry checks when promoted.

1. Build Community and Enterprise qualification cuts from that candidate. Record the commit, source tree, edition, policy digest, builder identity, toolchain, cut digests, and gate results. Run the complete cut hygiene and secret, private-reference, and donor-reference scans. Community must exclude Enterprise code and imports. Enterprise must independently prove the required subtree and registered shims. Run fresh local npm and SEA installation canaries bound to the qualification cut digests where the channel is required. Exercise the installed executable and scaffold.
2. Keep qualification attestations and artifacts nonpublishable. Their distinct schema carries an explicit qualification purpose. Qualification-only consumers verify the schema and artifact digests. Ordinary publication entrypoints reject the qualification schema even if a boolean is altered. No qualification artifact or attestation can be relabeled to publish it.
3. Permit each governed release edge only after its required gates pass. The integration authority verifies the qualification evidence belongs to that candidate and edition, checks the manifest and policy binding, and obtains the separate [ADR 0031](0031-human-admin-session-binds-approvals-to-a-tty-login.md) signed human approval before moving the donor ref. The ref moves only by the fast-forward allowed by ADR 0028.
4. Build the publication cut through the ordinary donor-only path from the promoted candidate. Rerun hygiene and publishability checks and compare shipped bytes with the qualified cut. Only explicitly enumerated provenance fields may differ. Unexplained payload differences block publication and require renewed qualification. Produce the applicable publication channels from the verified publication cut and verify digests and fresh local installs before publication under its own required approval.
5. Record download and installation of the actual published assets as a separate post-publication check. Withhold stable status if it fails. Local qualification or a local install cannot supply this evidence.

## Alternatives Rejected

Advancing a donor branch first would bypass the green-before-promotion rule. Qualifying the old tip could not prove the candidate's bytes. Simulated donor refs and publication attestations would overstate authority and confuse qualification with publication. Omitting install or cross-edition proof would leave the corresponding release checks unverified.

## Consequences

Qualification failure leaves release refs unchanged. A failed publication build after successful promotion leaves the audited donor ref intact and publishes nothing. A changed candidate must qualify again. Partial publication requires an incident record and an explicitly approved corrective release. Failures do not justify a forced ref update, a skipped check, or rewriting an attestation.

Missing remote staging or edition donor branches and their rulesets follow ADR 0028's separately approved bootstrap procedure. Runtime caches and build scratch belong to one qualification invocation. Retain compact evidence and necessary artifacts and remove disposable scratch when consumers finish.

## Verification

Implementation must exercise the immutable candidate on the required source and edition lanes and verify fresh installs. Regression tests must refuse a mismatched commit, tree, edition, or policy, a dirty snapshot, altered artifacts, missing gate evidence, a qualification attestation at a publication entrypoint, and unexplained publication payload differences. A disposable bare remote must prove failed qualification or missing commit-and-edition approval leaves refs unchanged. Test post-publication verification failure separately.

## Revisit Trigger

Revisit this ADR when a release edge cannot compare qualified and publication payloads with the finite provenance field list, or a new distribution channel cannot provide distinct local qualification and published-asset checks.

## Waiver Policy

Apply ADR 0028's promotion guards and ADR 0031's approval controls. Acceptance of this design authorizes implementation planning. Branch bootstrap, candidate promotion, tagging, and publication require their own governed actions and applicable human approvals.
