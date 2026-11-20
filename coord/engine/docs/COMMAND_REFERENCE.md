# Concord Command Reference

Generated from the Concord command registry. Regenerate with `bash coord/scripts/coord commands --all > coord/engine/docs/COMMAND_REFERENCE.md`.

Role labels are discovery metadata, not authorization: operator covers common project operations, maintainer covers specialized project workflows, and admin covers governance lifecycle operations.

## governance:adr

Maturity: alpha
Role: admin
Safety: governance_mutation
Summary: List, show, validate, create, link, and supersede governed ADR records through the journaled mutation path.
Docs: coord/docs/decisions/README.md
UI palette: no
Entry point: coord/scripts/gov

## governance:finalize

Maturity: existing_lifecycle
Role: admin
Safety: governance_mutation
Summary: Finalize reviewed work and sync board artifacts.
Docs: coord/GOVERNANCE.md
UI palette: no
Entry point: coord/scripts/gov

## governance:governance-tier

Maturity: alpha
Role: admin
Safety: read_only
Summary: Show active progressive-disclosure governance tier and its required gates.
Docs: coord/GOVERNANCE.md
UI palette: no
Entry point: coord/scripts/gov

## governance:guided-closeout

Maturity: alpha
Role: admin
Safety: read_only_or_runtime_receipt
Summary: Report closeout evidence gaps and exact remediation commands before submit/finalize.
Docs: coord/GOVERNANCE.md
UI palette: no
Entry point: coord/scripts/gov

## governance:merge-queue

Maturity: alpha
Role: admin
Safety: governance_mutation
Summary: Inspect or record the contention-triggered merge queue for overlapping land/finalize work.
Docs: coord/scripts/README.md
UI palette: no
Entry point: coord/scripts/gov

## governance:publishability-check

Maturity: alpha
Role: admin
Safety: read_only
Summary: Determine whether touched files require release hygiene evidence at closeout.
Docs: coord/product/TESTING_AND_GATES.md
UI palette: no
Entry point: coord/scripts/gov

## governance:set-requirement-ids

Maturity: stable
Role: maintainer
Safety: journaled_write
Summary: Author explicit ticket-to-requirement links through the governed board transaction.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: no
Entry point: coord/scripts/gov

## governance:start

Maturity: existing_lifecycle
Role: admin
Safety: governance_mutation
Summary: Start a governed ticket and acquire its lock.
Docs: coord/GOVERNANCE.md
UI palette: no
Entry point: coord/scripts/gov

## governance:submit

Maturity: existing_lifecycle
Role: admin
Safety: governance_mutation
Summary: Move a ticket from doing to review after evidence gates pass.
Docs: coord/GOVERNANCE.md
UI palette: no
Entry point: coord/scripts/gov

## product:adr-validate

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Validate ADR registry numbering, index links, status vocabulary, required sections, and supersession consistency.
Docs: coord/docs/decisions/README.md
UI palette: yes
Entry point: coord/scripts/coord

## product:affected-targets

Maturity: alpha
Role: maintainer
Safety: read_only
Summary: Select dependency-affected gate targets from changed files with conservative full fallback.
Docs: coord/product/TESTING_AND_GATES.md
UI palette: yes
Entry point: coord/scripts/coord

## product:authority-check

Maturity: alpha
Role: maintainer
Safety: read_only
Summary: Detect canonical/derived state authority inversions such as rendered views used as mutation authority.
Docs: coord/product/CANONICAL_DERIVED_AUTHORITY.md
UI palette: yes
Entry point: coord/scripts/coord

## product:business-context-pack

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Generate ticket-specific business context packs from discovery synthesis artifacts.
Docs: coord/product/BUSINESS_DISCOVERY_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:business-discovery

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Run source-backed existing-repo business discovery into a derived artifact.
Docs: coord/product/BUSINESS_DISCOVERY_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:business-discovery-synthesize

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Synthesize a business-discovery run into cited context graph and promoted doc drafts.
Docs: coord/product/BUSINESS_DISCOVERY_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:commands

Maturity: stable
Role: operator
Safety: read_only
Summary: Generate the machine-readable command registry or markdown reference.
Docs: coord/scripts/README.md#product-cli-coord
UI palette: yes
Entry point: coord/scripts/coord

Example:

```sh
bash coord/scripts/coord commands --all --json
```

## product:conformance

Maturity: stable
Role: operator
Safety: read_only_or_local_attestation
Summary: Verify engine conformance (journal chain self-verify; --attest/--verify signed attestation).
Docs: coord/scripts/README.md#product-cli-coord
UI palette: yes
Entry point: coord/scripts/coord

Example:

```sh
bash coord/scripts/coord conformance --json
```

## product:doctor

Maturity: stable
Role: operator
Safety: read_only
Summary: Read-only repo adoption/readiness report (profile, gaps, suggested tickets).
Docs: coord/product/SOFTSENSORAI_DONOR_LESSONS.md
UI palette: yes
Entry point: coord/scripts/coord

Example:

```sh
bash coord/scripts/coord doctor --json
```

## product:exploration-promote

Maturity: alpha
Role: maintainer
Safety: dry_run
Summary: Promote exploration findings into governed ticket specs without board mutation.
Docs: coord/product/SOFTSENSORAI_DONOR_LESSONS.md
UI palette: yes
Entry point: coord/scripts/coord

## product:init

Maturity: stable
Role: operator
Safety: no_clobber_write
Summary: Bootstrap a repo into a governed-board layout (idempotent, no-clobber).
Docs: coord/scripts/README.md#product-cli-coord
UI palette: yes
Entry point: coord/scripts/coord

Example:

```sh
bash coord/scripts/coord init --help
```

## product:knowledge-claim-compile

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Gate proposed knowledge claims into accepted, candidate, rejected, conflicted, superseded, or review-required outcomes.
Docs: coord/engine/docs/MEMORY_ARCHITECTURE.md
UI palette: yes
Entry point: coord/scripts/coord

## product:onboard

Maturity: alpha
Role: maintainer
Safety: dry_run_or_no_clobber_write
Summary: Generate an adoption plan for an existing repo, including repo shape, track preset, starter tickets, and setup artifacts.
Docs: QUICKSTART.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-artifacts

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Emit or validate the Requirements Assurance Protocol artifact model.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-baseline-gate

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Check whether a repo has a real requirements baseline, stable IDs, source declarations, or an external authoritative pointer.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-cockpit-model

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Emit the read-only Requirements Assurance cockpit view model and copyable command catalog.
Docs: coord/product/COORD_UI_CONTRACT.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-conformance

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Generate requirements conformance from board, plans, evidence, traceability, and requirements-source hygiene.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-domain-boundary

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Lint domain ontology, decision authority, source evidence, contradictions, and investigation workflow coverage.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-donor-derived

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Analyze donor repo-family inventories into generalized concepts, residue findings, evidence, and dry-run backlog proposals.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-donor-reuse

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Validate donor/legacy reuse decisions, provenance, scrub, and generalization status.
Docs: coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-evidence-policy

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Evaluate requirement evidence classes against risk/profile policy.
Docs: coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-generalization-audit

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Audit donor/legacy residue against owning abstractions, scrub status, provenance, and governed worklist.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-import

Maturity: alpha
Role: maintainer
Safety: read_only_stdout
Summary: Import explicit markdown PRD/URS requirement headings into registry JSON.
Docs: coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-linkage

Maturity: alpha
Role: maintainer
Safety: read_only
Summary: Validate ticket-to-requirement links from board fields and requirement labels.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-linkage-backfill

Maturity: alpha
Role: maintainer
Safety: dry_run_or_guarded_write
Summary: Backfill explicit Requirement IDs from existing ticket descriptions with idempotent apply/revert safeguards.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: no
Entry point: coord/scripts/coord

## product:requirements-persona-workflow

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Audit persona/workflow matrix coverage and blocker references.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-review-pack

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Emit the read-only multi-agent requirements review lenses and governed synthesizer contract.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-screen-coverage

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Report screen-to-requirement coverage from a derived screen index.
Docs: coord/product/SCREEN_INDEX_CONTRACT.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-sequencing

Maturity: alpha
Role: maintainer
Safety: dry_run_or_explicit_output
Summary: Generate a risk-before-feature-value requirements sequencing plan with dependency reasons.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-stale-impact

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Compare baseline/current requirement block hashes and report impacted tickets, screens, and evidence.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-surface-conformance

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Generate cross-surface conformance and shared-contract gaps for persona/app requirement sources.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PROTOCOL.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-traceability

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Generate deterministic requirements traceability matrix artifacts.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-walking-skeleton

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Run the fixture-backed requirements import/link/trace/readout proof.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:requirements-workflow-alignment

Maturity: alpha
Role: maintainer
Safety: read_only_or_explicit_output
Summary: Audit workflow inventories against URS requirement anchors and emit a dry-run gap worklist.
Docs: coord/product/REQUIREMENTS_ASSURANCE_PLAN.md
UI palette: yes
Entry point: coord/scripts/coord

## product:track-presets

Maturity: alpha
Role: maintainer
Safety: read_only
Summary: List ready-made governance track presets for web app, data service, content site, and infra projects.
Docs: coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md
UI palette: yes
Entry point: coord/scripts/coord

## product:upgrade

Maturity: stable
Role: operator
Safety: managed_write_with_rollback
Summary: Plan the latest pinned-channel engine update, apply only its reviewed digest, re-pin + verify, and roll back on failure.
Docs: coord/scripts/README.md#product-cli-coord
UI palette: no
Entry point: coord/scripts/coord

Example:

```sh
bash coord/scripts/coord upgrade --help
```
