# Walking Skeleton URS

## URS-001: Capture governed requirement evidence
- Persona: product owner
- Workflow: requirements-assurance
- Evidence: test_gate, manual_review
- Risk: medium

The product owner can see whether a requirement has a linked delivery ticket.

Acceptance Criteria:
- A linked ticket appears in the traceability readout.
- Evidence status is derived from plan records.

## URS-002: Surface requirements traceability gaps
- Persona: engineering lead
- Workflow: delivery-review
- Evidence: test_gate, manual_review
- Risk: medium

The engineering lead can see whether the walking-skeleton requirements are
covered by linked tickets.

Acceptance Criteria:
- Two fixture tickets link to imported requirements.
- The readout reports linked requirements and linked tickets.
