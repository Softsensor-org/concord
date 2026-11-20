# Requirements Registry Schema

This document defines the canonical requirements registry shape for Concord
requirements assurance. It is a product contract, not a runtime implementation.
Follow-up tickets can implement import, lint, traceability, cockpit, and
conformance generators against this contract.

Concord remains an assurance layer over existing PRD, URS, Jira, Linear,
GitHub Issues, donor repositories, architecture packs, and regulated source
documents. It does not become the primary authoring tool for requirements.

## Design Goals

- Preserve existing source-of-truth documents and tools.
- Make every requirement addressable by a stable id.
- Preserve source provenance and block hashes so changes can be audited.
- Distinguish explicit source facts from inferred links.
- Connect requirements to personas, workflows, screens, APIs, data, security,
  evidence, tickets, and closeout.
- Support pilot products, enterprise products, and regulated URS/validation
  workflows without changing the core board lifecycle.
- Keep generated artifacts deterministic and source-cited.

## Artifact Locations

Recommended canonical and generated artifacts:

| Artifact | Path | Owner | Mutability |
| --- | --- | --- | --- |
| Registry contract | `coord/product/REQUIREMENTS_REGISTRY_SCHEMA.md` | template | edited by governed tickets |
| Direct requirements | `coord/product/REQUIREMENTS.md` | adopter | edited by governed tickets or imported from external source |
| Registry JSON | `coord/.runtime/requirements/registry.json` | generator | derived, regenerable |
| Traceability matrix | `coord/.runtime/requirements/traceability.json` | generator | derived, regenerable |
| Conformance report | `coord/rendered/requirements-conformance.md` | generator | derived, regenerable |
| Sequencing plan | `coord/.runtime/requirements/sequencing-plan.json` | generator | derived, regenerable |
| Surface conformance | `coord/.runtime/requirements/surface-conformance.json` | generator | derived, regenerable |
| Requirements cockpit model | `coord/.runtime/requirements/cockpit-model.json` | generator | derived, regenerable |
| Domain boundary report | `coord/.runtime/requirements/domain-boundary-report.json` | generator | derived, regenerable |
| Generalization audit | `coord/.runtime/requirements/generalization-audit-report.json` | generator | derived, regenerable |
| Import manifest | `coord/.runtime/requirements/import-manifest.json` | generator | derived, regenerable |

Projects may keep the authoritative PRD/URS outside the repo. In that case the
registry stores pointers, anchors, content hashes, and import metadata, not
private document bodies.

Authoritative PRD/URS/SRS sources should not embed delivery-state projections
such as delivered/open/status summaries. Those belong in generated conformance
artifacts (`concord.requirements.conformance_audit`) derived from the board,
plan records, traceability, and evidence policy reports. `requirements
conformance --check` compares generated artifacts with volatile
`generated_at_utc` metadata normalized.

## Registry Envelope

The derived registry JSON should use this top-level shape:

```json
{
  "kind": "concord.requirements.registry",
  "schema_version": 1,
  "project": {
    "name": "example",
    "profile": "product-engineering",
    "source_policy": "direct-or-imported"
  },
  "generated_at_utc": "2026-06-25T00:00:00.000Z",
  "generator": {
    "name": "requirements-import",
    "version": "0.1.0",
    "command": "coord/scripts/requirements import --json"
  },
  "sources": [],
  "requirements": [],
  "links": [],
  "findings": []
}
```

Rules:

- `generated_at_utc` is metadata only; deterministic tests should support a
  fixed clock or omit it from hash-stable comparisons.
- `schema_version` increments only for incompatible changes.
- `sources`, `requirements`, `links`, and `findings` are sorted by stable key.
- A generated registry must never hide source uncertainty. Use confidence and
  provenance fields instead.

## Source Model

Each requirement source declares where the intent came from.

```json
{
  "id": "SRC-001",
  "type": "markdown|external_ticket|donor_repo|pdf|spreadsheet|controlled_document|manual",
  "label": "Product URS",
  "uri": "coord/product/REQUIREMENTS.md",
  "authority": "authoritative|supporting|legacy|donor|candidate",
  "visibility": "public|internal|private_pointer_only",
  "owner": "product|business|quality|engineering|external",
  "version": "v1",
  "retrieved_at_utc": "2026-06-25T00:00:00.000Z",
  "content_hash": "sha256:<hash-or-null>",
  "notes": "Optional source note"
}
```

Rules:

- `private_pointer_only` means the registry can cite the source location and
  hash but must not copy sensitive content into public artifacts.
- Donor repositories are always `donor` or `candidate` authority until a human
  confirms that the derived requirement belongs in the new product.
- External ticket ids are source ids, not Concord ticket ids.

## Requirement Record

Each requirement record is a stable, source-cited statement of product intent.

```json
{
  "id": "URS-001",
  "title": "Driver can submit proof of delivery",
  "statement": "A concise requirement statement.",
  "acceptance_criteria": [
    "Criterion 1",
    "Criterion 2"
  ],
  "source": {
    "source_id": "SRC-001",
    "path": "coord/product/REQUIREMENTS.md",
    "anchor": "urs-001-driver-proof-of-delivery",
    "line_start": 120,
    "line_end": 145,
    "block_hash": "sha256:<hash>",
    "imported": true
  },
  "classification": {
    "kind": "functional|nonfunctional|security|data|integration|workflow|ux|operational|validation|controlled_document",
    "priority": "P0|P1|P2|P3",
    "risk_class": "low|medium|high|critical|regulated",
    "criticality": "standard|business_critical|safety_critical|compliance_critical",
    "lifecycle": "draft|approved|implemented|retired"
  },
  "dimensions": {
    "personas": ["driver"],
    "workflows": ["delivery-completion"],
    "screens": ["driver-delivery-detail"],
    "routes": ["/driver/deliveries/:id"],
    "apis": ["POST /api/deliveries/:id/proof"],
    "data_entities": ["Delivery", "ProofOfDelivery"],
    "events": ["delivery.proof_submitted"],
    "security_controls": ["role:driver", "tenant-boundary"],
    "evidence_classes": ["test_gate", "screenshot", "runtime_receipt"]
  },
  "coverage": {
    "status": "unlinked|planned|in_progress|partial|satisfied|waived|deviation|defect|stale|retired",
    "confidence": "explicit|inferred|candidate",
    "ticket_ids": ["COORD-123"],
    "evidence_refs": [],
    "waiver_ref": null,
    "defect_ref": null,
    "last_verified_at_utc": null
  },
  "provenance": {
    "created_by": "import|human|synthesizer|donor_analyzer",
    "created_from": ["SRC-001"],
    "derived_from_requirement_ids": [],
    "reviewed_by": [],
    "change_reason": "initial import"
  }
}
```

Required fields:

- `id`
- `title`
- `source.source_id`
- `source.block_hash` for imported or direct markdown requirements
- `classification.kind`
- `classification.risk_class`
- `coverage.status`
- `coverage.confidence`

Rules:

- Requirement ids are stable after publication. Rename the title, not the id.
- `candidate` confidence cannot count as satisfied coverage.
- `inferred` links must appear in audit output until confirmed or rejected.
- `partial` means implementation evidence exists but required closure evidence
  is incomplete.
- `implemented` means implementation evidence exists for ordinary product
  closure, but validation-grade evidence is not being claimed.
- `validation-grade` means required evidence/signoff for the declared risk and
  criticality has been satisfied.
- `defect` means implementation exists but behavior is wrong or materially
  incomplete.
- Defect records should carry severity, category, evidence refs,
  reproduction/audit note, linked follow-up ticket, affected surface, and status
  so implemented-but-wrong behavior is not treated as complete.
- `waived` and `deviation` require a waiver/deviation reference; they are not
  equivalent to satisfied.
- `retired` requirements must retain source provenance and retirement reason.

## Link Model

Links connect requirements to other artifacts without overloading the board.

```json
{
  "id": "LINK-001",
  "from": {
    "kind": "requirement",
    "id": "URS-001"
  },
  "to": {
    "kind": "ticket|screen|api|test|runtime_receipt|deploy_receipt|controlled_document|external_ticket|donor_evidence",
    "id": "COORD-123"
  },
  "relationship": "satisfies|implements|tests|verifies|blocks|supersedes|derives_from|conflicts_with|waives|documents",
  "confidence": "explicit|inferred|candidate",
  "source": {
    "source_id": "SRC-001",
    "anchor": "urs-001-driver-proof-of-delivery",
    "block_hash": "sha256:<hash>"
  },
  "notes": "Optional explanation"
}
```

Rules:

- Explicit links come from source metadata, board fields, plan records, or human
  confirmation.
- Inferred links can inform review but cannot silently close requirements.
- A link to a closed ticket is not enough; evidence class and closeout quality
  still determine coverage.

## Evidence Classes

The registry uses a shared evidence vocabulary so high-risk requirements can
declare stronger closure needs.

Criticality vocabulary:

- `ordinary_product`
- `business_critical`
- `safety_critical`
- `compliance_critical`
- `gxp_regulatory`
- `security`
- `data_integrity`
- `operational`
- `ux`

Critical or regulated requirements can require stronger evidence than tests
alone. Code-present work should remain `partial` until runtime, data, security,
controlled-document, waiver/deviation, or attestation evidence required by the
criticality is present.

| Evidence class | Meaning |
| --- | --- |
| `test_gate` | Automated test or local gate result |
| `manual_review` | Structured human or agent review finding |
| `screenshot` | Rendered UI evidence |
| `runtime_receipt` | Runtime observation from deployed or local running system |
| `deploy_receipt` | Deployed artifact/version proof |
| `data_contract` | Data shape, migration, or backfill proof |
| `security_scan` | Dependency, secret, or security scan |
| `attestation` | Signed conformance or integrity proof |
| `controlled_document` | SOP, validation protocol, training, or approved operating artifact |
| `waiver` | Accepted non-closure with risk owner and revisit condition |

Controlled-document records:

```json
{
  "coverage": {
    "controlled_documents": [
      {
        "id": "DOC-001",
        "type": "sop_template|validation_protocol|iq_oq_pq|training_artifact|role_authorization|operating_procedure",
        "status": "vendor_template|draft|site_approved|customer_approved|effective|retired",
        "owner": "quality-or-business-owner",
        "doc_ref": "private://quality/sops/DOC-001",
        "version": "1.0",
        "evidence_refs": ["private://quality/approvals/DOC-001"]
      }
    ]
  }
}
```

Rules:

- `vendor_template` is not equivalent to `site_approved`,
  `customer_approved`, or `effective`.
- Controlled-document closure requires a document reference, owner/approver,
  version, and approval evidence reference.
- Approved controlled documents can satisfy `controlled_document` evidence when
  the requirement policy declares that evidence class.

Waiver/deviation records:

```json
{
  "coverage": {
    "status": "waived|deviation",
    "waiver_ref": "private://quality/waivers/REQ-001",
    "waiver": {
      "classification": "product_deferral|regulated_deviation|accepted_risk",
      "reason": "why normal closure is not possible now",
      "risk": "accepted risk statement",
      "approver": "role-or-person",
      "approval_date": "YYYY-MM-DD",
      "expires_at": "YYYY-MM-DD",
      "revisit_condition": "what forces re-review",
      "compensating_control": "manual check, SOP, monitoring, or other control",
      "evidence_refs": ["private://quality/waivers/REQ-001"]
    }
  }
}
```

Rules:

- `waived` and `deviation` never count as implemented or validation-grade.
- Missing approver, approval date, risk, reason, compensating control, evidence,
  or expiry/revisit condition is a coverage gap.
- Expired waivers/deviations must be reported as gaps until renewed or replaced.

Default closure guidance:

| Risk class | Minimum evidence |
| --- | --- |
| `low` | `test_gate` or `manual_review` |
| `medium` | `test_gate` plus review or screenshot/runtime evidence when user-facing |
| `high` | `test_gate` plus runtime/data/security evidence matching the dimension |
| `critical` | high-risk evidence plus explicit reviewer or attestation |
| `regulated` | validation-grade evidence, controlled document or protocol where applicable, and waiver/deviation tracking |

The read-only `requirements-evidence-policy` command implements the first
coverage policy against this vocabulary. It evaluates requirement risk,
dimension-specific proof needs, ticket-declared expected evidence, and plan
records. Unknown evidence class names fail the report instead of being silently
accepted.

## Validation Rules

A requirements validator should report:

- duplicate requirement ids;
- missing or unstable source ids;
- missing block hashes for imported/direct markdown requirements;
- private source content copied into public artifacts;
- `candidate` or `inferred` links counted as satisfied;
- high-risk requirements without required evidence classes;
- `waived` or `deviation` status without waiver metadata;
- `defect` status without defect reference;
- linked tickets that do not exist on the board;
- done tickets whose requirement evidence is weaker than declared risk;
- screens, APIs, or workflows with no requirement link;
- requirements whose source block hash changed after closure;
- donor-derived requirements without scrub/generalization status.

## Donor/Legacy Reuse Decision Matrix

Donor-derived work should carry a separate reuse decision matrix. The generated
report shape is `concord.requirements.donor_reuse_matrix_report`; the default
input lives at `coord/.runtime/requirements/donor-reuse-matrix.json`.

Each entry should include:

| Field | Purpose |
| --- | --- |
| `source_system` | Generic donor or legacy system label; public artifacts should avoid customer-specific names. |
| `source_ref` | Private pointer, file anchor, external doc id, or donor evidence reference. |
| `control_pattern` | The reusable pattern being evaluated, such as RBAC, audit, e-signature, workflow, data contract, or UI surface. |
| `target_requirement_ids` | Requirements that may reuse, replace, isolate, migrate, defer, or reject the pattern. |
| `reuse_decision` | One of `reuse_pattern`, `replace`, `isolate`, `migrate`, `defer`, or `reject`. |
| `provenance_refs` | Source pointers or evidence references proving where the pattern came from. |
| `confidence` | `explicit`, `inferred`, or `candidate`. |
| `scrub_status` | `scrubbed`, `needs_scrub`, `private_pointer_only`, or `not_applicable`. |
| `generalization_status` | `generalized`, `needs_generalization`, `intentional_product_default`, or `not_applicable`. |
| `compliance_controls` | Controls carried forward or intentionally replaced. |

Validation fails when reusable or migrated material lacks provenance, still
needs scrub/generalization, carries private content into public artifacts, or
uses decision/status values outside the shared vocabulary.

## Public Communication Boundary

Public docs may say Concord provides requirements assurance and traceability over
existing PRD/URS sources. They must not claim:

- Concord replaces the customer's requirements authoring system.
- Inferred or donor-derived requirements are confirmed without human review.
- A requirement is satisfied only because a linked ticket is done.
- Private customer requirements are copied into a public registry.
