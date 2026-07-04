# Requirements Assurance Protocol

This protocol defines how Concord turns existing PRD, URS, external tickets,
screen inventories, donor repositories, and controlled documents into governed
execution and evidence.

Concord does not replace the customer's requirements authoring system. It adds
assurance over that system: import, lint, traceability, evidence, conformance,
impact analysis, and governed mutation boundaries.

## Operating Principles

1. Existing sources remain authoritative.
2. Requirement ids are stable after publication.
3. Generated artifacts are rebuildable and source-cited.
4. Explicit links and inferred links are never collapsed.
5. Ticket mutation is single-writer and governed.
6. Sub-agent reviews are read-only until a synthesizer accepts changes through
   governance.
7. Private sources may be referenced by pointer/hash without copying private
   bodies into public artifacts.

## Source Documents

Supported source classes:

| Source | Role |
| --- | --- |
| PRD / URS / SRS markdown | Product intent and acceptance criteria |
| External tickets | Planning context from Jira, Linear, GitHub Issues, or similar tools |
| Screen index | Real UI surface inventory and route-to-requirement coverage |
| Donor repository | Candidate behavior and reusable control patterns |
| Controlled document | SOP, validation protocol, training, IQ/OQ/PQ, or operating evidence |
| Runtime/deploy receipt | Environment proof used for closure, not requirement authorship |
| Business discovery run | Source-backed discovery facts, questions, contradictions, and promotion candidates for existing repos |
| ADR / decision record | High-impact decision authority between requirements and tickets |

Each source should declare authority:

- `authoritative`: source of product intent;
- `supporting`: evidence or explanatory context;
- `legacy`: existing system behavior that may or may not survive;
- `donor`: reusable pattern source;
- `candidate`: unconfirmed requirement proposal.

## Stable Requirement IDs

Requirement ids use explicit prefixes:

- `REQ-*`: product requirement;
- `URS-*`: user requirement;
- `PRD-*`: product-document requirement;
- `SRS-*`: system/software requirement;
- `SEC-*`: security requirement;
- `NFR-*`: non-functional requirement;
- `DONOR-REQ-*`: donor-derived candidate.

Rules:

- Rename titles freely, but do not recycle ids.
- Retired requirements stay in history with retirement reason.
- Donor-derived ids remain candidate until human-confirmed.
- Imported requirements preserve source path, anchor, line range, and block hash.

## Profiles

### Base PRD/URS

Use for normal product engineering where requirements, tickets, tests, and
release evidence must line up.

Required coverage:

- source documents;
- stable requirement ids;
- requirement registry;
- ticket linkage;
- evidence linkage;
- generated traceability/conformance report.

### ADR / Decision Layer

Use an ADR when requirements or discovery produce a high-impact choice before
tickets should execute it. ADRs do not replace URS/PRD/SRS records; they explain
why one approach governs implementation and which alternatives were rejected.

ADR-required choices include architecture, security boundaries, data models,
deployment topology, memory/knowledge authority, cross-repo contracts, agent
operating protocols, deliberate deferrals, and material waivers. Ordinary
implementation tickets stay lightweight when they merely follow an existing ADR
or local pattern.

Accepted ADRs should link to affected requirements, epics, tickets, repos,
modules, tests/gates, business discovery records, and context packs. Deferred
ADRs must include a revisit trigger. Waivers are ticket-scoped and do not change
the ADR unless a superseding ADR is created.

### Regulated

Use when closure must be validation-grade rather than implementation-grade.

Adds:

- criticality and GxP/regulatory scope;
- approved baseline state;
- validation evidence class;
- QA/business/compliance signoff;
- controlled-document closure;
- deviation and waiver model;
- partial/defect states;
- compliance-critical sequencing.

### Persona / Surface

Use when the main risk is incomplete user, role, workflow, or screen coverage.

Adds:

- persona inventory;
- role/RBAC status;
- workflow list;
- surface/screen ownership;
- backend/frontend/API coverage;
- blocker tickets and stale blockers.

### Donor / Legacy Derivation

Use when an existing repo or legacy system is source material for a new product.

Adds:

- donor source inventory;
- reusable pattern extraction;
- generalization decision;
- scrub/leak findings;
- copied-behavior risk;
- dry-run derived backlog proposals.

## Traceability States

Traceability is not done/not-done. Use explicit states:

| State | Meaning |
| --- | --- |
| `unlinked` | Requirement has no ticket or evidence link |
| `planned` | Ticket exists but work has not started |
| `in_progress` | Work is active |
| `partial` | Code/evidence exists but closure is incomplete |
| `satisfied` | Required evidence is complete |
| `waived` | Accepted non-closure with risk owner and revisit condition |
| `deviation` | Regulated or policy deviation accepted under controls |
| `defect` | Implementation exists but behavior is wrong or incomplete |
| `stale` | Source changed after evidence or closure |
| `retired` | Requirement is no longer active but remains auditable |

## Evidence Classes

Use the shared vocabulary from `REQUIREMENTS_REGISTRY_SCHEMA.md`:

- `test_gate`;
- `manual_review`;
- `screenshot`;
- `runtime_receipt`;
- `deploy_receipt`;
- `data_contract`;
- `security_scan`;
- `attestation`;
- `controlled_document`;
- `waiver`.

Evidence class is selected by risk. A linked done ticket is not enough to mark a
requirement satisfied.

## Generated Artifacts

The protocol treats these as derived, rebuildable artifacts:

| Artifact | Purpose |
| --- | --- |
| Requirement registry | Source-cited requirement records |
| Traceability matrix | Requirement/ticket/evidence coverage |
| Generated conformance audit | Requirements closure status and gaps |
| Workflow alignment audit | Persona/workflow/surface completeness |
| Donor reuse matrix | Candidate reuse, replacement, isolation, migration, or rejection decisions |
| Stale-impact report | Changed requirements and impacted tickets/evidence/screens |
| Sequencing plan | Risk-aware execution order |

Generated artifacts must be deterministic for identical inputs.

The concrete artifact contract is emitted by
`coord requirements-artifacts --json`. Each artifact declares a stable `kind`,
default path, canonical source inputs, source-citation requirement, content-hash
expectation, generated-at handling, and public-cut safety posture. The validator
`coord requirements-artifacts --validate <artifact.json> --public` checks the
envelope without trusting the artifact as a source of truth.

Required generated artifact kinds:

| Artifact | Kind | Default path | Public-cut posture |
| --- | --- | --- | --- |
| Requirement registry | `concord.requirements.registry` | `coord/.runtime/requirements/registry.json` | pointer or scrubbed |
| Baseline presence gate | `concord.requirements.baseline_presence_gate` | `coord/.runtime/requirements/baseline-presence.json` | pointer or scrubbed |
| Traceability matrix | `concord.requirements.traceability_matrix` | `coord/.runtime/requirements/traceability.json` | scrubbed |
| Generated conformance audit | `concord.requirements.conformance_audit` | `coord/rendered/requirements-conformance.md` | scrubbed |
| Workflow alignment audit | `concord.requirements.persona_workflow_audit` | `coord/.runtime/requirements/workflow-alignment.json` | scrubbed |
| Workflow URS alignment audit | `concord.requirements.workflow_alignment_audit` | `coord/.runtime/requirements/workflow-urs-alignment.json` | scrubbed |
| Multi-agent review pack | `concord.requirements.multi_agent_review_pack` | `coord/.runtime/requirements/review-pack.json` | scrubbed |
| Requirements cockpit model | `concord.requirements.cockpit_model` | `coord/.runtime/requirements/cockpit-model.json` | scrubbed |
| Domain boundary report | `concord.requirements.domain_boundary_report` | `coord/.runtime/requirements/domain-boundary-report.json` | scrubbed |
| Business discovery run | `concord.business_discovery.run` | `coord/.runtime/discovery/run.json` | scrubbed |
| Generalization audit | `concord.requirements.generalization_audit` | `coord/.runtime/requirements/generalization-audit-report.json` | scrubbed |
| Surface conformance | `concord.requirements.surface_conformance` | `coord/.runtime/requirements/surface-conformance.json` | scrubbed |
| Donor reuse matrix | `concord.requirements.donor_reuse_matrix_report` | `coord/.runtime/requirements/donor-reuse-report.json` | private pointer only |
| Donor-to-derived analysis | `concord.requirements.donor_to_product_analysis` | `coord/.runtime/requirements/donor-derived-analysis.json` | private pointer only |
| Sequencing plan | `concord.requirements.sequencing_plan` | `coord/.runtime/requirements/sequencing-plan.json` | scrubbed |
| Stale-impact report | `concord.requirements.stale_impact_report` | `coord/.runtime/requirements/stale-impact.json` | scrubbed |

## Governed Mutation Boundary

Read-only or dry-run commands may inspect sources, generate reports, and propose
changes. Mutations require a governed ticket and single writer.

Allowed without mutation:

- import sources to stdout or an explicit derived artifact path;
- lint requirements;
- generate traceability/conformance reports;
- run sub-agent review lenses;
- propose board rows as dry-run JSON.

Requires governed mutation:

- editing canonical requirements;
- accepting inferred requirement links;
- adding or changing board rows;
- changing ticket dependencies or priority;
- marking requirement closure;
- approving waiver/deviation;
- updating controlled-document references.

## Command Contracts

The product-facing umbrella command is `coord requirements <verb>`. The command
contracts are emitted by `coord requirements --contracts` and are intentionally
read-only or dry-run by default.

| Verb | Status | Default | Contract |
| --- | --- | --- | --- |
| `baseline` | implemented | read-only | Check for a real requirements baseline, stable IDs, source declarations, or an external authoritative pointer before claiming requirements assurance. |
| `import` | implemented | read-only | Import explicit source requirements to stdout or an explicit derived registry artifact. |
| `lint` | implemented | read-only | Check board/registry linkage and vocabulary without mutating tickets. |
| `linkage-backfill` | implemented | dry-run | Backfill explicit `Requirement IDs` from existing ticket descriptions with idempotent apply/revert safeguards. |
| `trace` | implemented | read-only | Generate a deterministic requirement/ticket/evidence traceability matrix. |
| `conformance` | implemented | read-only | Generate requirements conformance from the board, registry, plan records, evidence policy, traceability, and optional PRD/URS/SRS source hygiene checks. |
| `workflow-audit` | implemented | read-only | Audit persona/workflow/surface blockers from a derived matrix. |
| `workflow-align` | implemented | read-only | Compare workflow inventory to URS anchors and emit a dry-run gap worklist. |
| `review-pack` | implemented | read-only | Emit the multi-agent review lenses and single-writer synthesizer contract. |
| `sequence` | implemented | dry-run | Generate risk-aware sequencing proposals; dependency/priority changes require governance. |
| `donor-analyze` | implemented | read-only | Validate donor/legacy reuse decisions and unsafe reuse findings from a derived matrix. |
| `donor-derive` | implemented | read-only | Analyze donor source inventories into generalized concepts, residue findings, evidence, and dry-run backlog proposals. |

Every mutation path escalates to a governed ticket. Protocol commands may write
only explicit derived artifacts such as JSON reports when `--output` is supplied;
they must not edit canonical requirements, board rows, dependencies, waivers, or
closure state directly.
The direct product command `coord requirements-surface-conformance` generates
cross-surface conformance for split persona/app/surface requirement sources and
shared cross-cutting contracts.
The direct product command `coord requirements-cockpit-model` emits the
read-only cockpit view model, artifact sources, and copyable command catalog for
operators.
The direct product command `coord requirements-domain-boundary` lints declared
domain ontology, decision authority, source evidence, contradictions, missing
documents, and investigation workflow coverage from a structured manifest.
Business discovery is the source-backed pre-requirements protocol for existing
repos with unclear domain intent. It is defined in
`coord/product/BUSINESS_DISCOVERY_PROTOCOL.md`; its derived artifact kind is
`concord.business_discovery.run`. Requirement records may be promoted from
business-discovery records only when the candidate carries evidence, confidence,
status, and review authority sufficient for the target profile.
The direct product command `coord business-discovery --json` emits this read-only
artifact and writes it only when `--output` or `--write-default` is explicit.
The direct product command `coord requirements-generalization-audit` validates
donor/legacy residue findings against owning abstractions, provenance, scrub
status, requirement links, and a dry-run governed worklist.
The direct product command `coord requirements-stale-impact` compares baseline
and current requirement block hashes and reports impacted tickets, screens,
evidence, and revalidation/waiver actions.
The direct product command `coord requirements-baseline-gate` and umbrella verb
`coord requirements baseline` emit
`concord.requirements.baseline_presence_gate`. The gate classifies the
requirements baseline as `missing`, `stub`, `weak`, `present`,
`external_declared`, or `sample_only`. Enterprise, regulated, GxP, and audit
tracks fail closed on missing/stub/weak baselines; pilot and product-engineering
tracks warn so adoption can start while the baseline is repaired. Community/demo
repos can declare sample-only status explicitly, but must not claim full
requirements assurance from that state.

External authoritative baselines are declared by pointer, hash, version, and
stable ID policy. Concord does not fetch private PRD/URS/eQMS/Jira bodies in
this gate. A valid pointer manifest can live at
`coord/.runtime/requirements/baseline-sources.json`:

```json
{
  "sources": [
    {
      "id": "URS-V1",
      "authority": "authoritative",
      "private_ref": "private://eqms/urs-v1",
      "content_hash": "sha256:...",
      "stable_id_policy": "URS-*"
    }
  ]
}
```

Generated conformance must preserve a first-class `defect` state for
implemented-but-wrong requirements. Defect rows should include requirement ID,
severity, category, evidence refs, reproduction or audit note, linked follow-up
ticket, affected surface, and status. A defect can be repaired, superseded, or
waived/deviated through normal governance evidence, but it must not be counted
as conforming while open or risk-accepted.

URS addendum to ticket batch is a governed workflow contract, not a direct
mutation command. A future generator may emit a dry-run artifact such as
`coord/.runtime/requirements/urs-addendum-ticket-batch.json` containing source
hashes, proposed board rows, prompt bodies or hashes, dependencies, repo/owner
mapping, traceability, expected evidence classes, and regeneration proof. One
governed writer must accept any batch; reviewers and sub-agents remain read-only
until acceptance.

## Sub-Agent Review Model

Sub-agents should be read-only reviewers. Recommended lenses:

- requirements completeness;
- persona/workflow coverage;
- screen/route coverage;
- backend/API/data/event coverage;
- security/RBAC/audit coverage;
- evidence/test/runtime/deploy coverage;
- donor/generalization review.

The synthesizer is the only writer. It converts findings into governed doc edits,
ticket updates, or dry-run backlog proposals.

`coord requirements review-pack --json` and the product alias
`coord requirements-review-pack --json` emit the canonical pack as
`concord.requirements.multi_agent_review_pack`. The pack is safe to hand to
parallel reviewers because each lens is read-only and the finding schema requires
source citations. Accepted changes still flow through one governed synthesizer
ticket.

## Public Boundary

Public communication may say Concord makes existing requirements enforceable and
auditable. It must not say Concord:

- replaces PRD/URS authoring;
- replaces Jira/Linear/GitHub Issues;
- validates inferred requirements without human confirmation;
- stores private customer requirements in public artifacts;
- provides regulated quality-system-of-record controls by itself.
