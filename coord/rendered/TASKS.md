# Project Task Board

Generated from `coord/board/tasks.json`. Do not hand-edit.
Regenerate with `node coord/board/board.js sync`.

Before starting any ticket, complete coord/AGENT_STARTUP_CHECKLIST.md.
Complete SETUP-001..009 in dependency order; each row has a registered prompt.
Repo codes are defined in coord/project.config.js. Use X for cross-repo / coordination work.

## Getting Started

This is a starter adoption ladder. Replace these model steps with evidence from your project.
Each ticket flows todo -> doing -> review -> done via coord/scripts/gov.

---

## Backlog

| ID | Repo | Type | Pri | Status | Owner | Description | Depends On |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SETUP-001 | X | docs | P1 | todo | unassigned | Confirm coord/project.config.js repo map and ticket prefixes (configuration seam only). |  |
| SETUP-002 | X | task | P1 | todo | unassigned | Author knowledge baseline (REQUIREMENTS, ARCHITECTURE, and REPOS). | SETUP-001 |
| SETUP-003 | X | task | P1 | todo | unassigned | Run source-backed discovery and promote accepted facts. | SETUP-002 |
| SETUP-004 | X | task | P1 | todo | unassigned | Run the governed gap audit and file the founding backlog. | SETUP-003 |
| SETUP-005 | X | task | P1 | todo | unassigned | Wire real per-repo gates and CI evidence. | SETUP-004 |
| SETUP-006 | X | task | P2 | todo | unassigned | Record founding ADRs and validate the decision registry. | SETUP-005 |
| SETUP-007 | X | task | P2 | todo | unassigned | Import the requirements registry and link tickets. | SETUP-006 |
| SETUP-008 | X | task | P2 | todo | unassigned | Record the coverage and test-maturity baseline. | SETUP-007 |
| SETUP-009 | X | task | P2 | todo | unassigned | Generate the readiness report and adoption handoff. | SETUP-008 |
