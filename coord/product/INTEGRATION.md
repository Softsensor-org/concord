# Cross-Repo Integration Map

This file describes the contract boundaries for a project using this coordination scaffold.

## Source of Truth

| Concern | Owner |
|---|---|
| Product requirements | `coord/product/REQUIREMENTS.md` |
| Runtime architecture and stack | `coord/product/ARCHITECTURE.md` |
| Domain model constraints | `coord/product/DOMAIN_MODEL.md` |
| Shared forms/workflow contract | `coord/product/FORMS_AND_WORKFLOW_CONTRACT.md` |
| Offline and sync policy | `coord/product/OFFLINE_SYNC_AND_CONFLICTS.md` |
| Governance and workflow state | `coord/GOVERNANCE.md` |
| This bounded-context and contract map | `coord/product/INTEGRATION.md` |
| Backend API payload implementation | `backend/` |
| Frontend UI and client consumption | `frontend/` |

## Contract Rules

1. `backend` owns API payload shapes, event names, and persistence semantics.
2. `frontend` mirrors backend contracts and must not drift from them.
3. Shared configuration, feature flags, and contract conventions should stay explicitly modeled and versioned (see `coord/product/CONFIG_INHERITANCE_MODEL.md`).
4. Major capabilities should be separated into modules with explicit boundaries (see `coord/product/ARCHITECTURE.md`).
5. Cross-module communication should happen through explicit command/query interfaces or published events, not direct repository access.
6. Frontend-facing DTOs should be owned by the API layer, not persistence models.

## Bounded Contexts

The template starts with three scaffold-level contexts:

- Governance control plane in `coord/`
- Backend product context in `backend/`
- Frontend product context in `frontend/`

Each bounded context should declare:
- what it owns (tables, commands, events)
- its public seams (APIs, read models, published events)
- which other contexts it may call synchronously
- which events it publishes and consumes
- forbidden direct dependencies

## Interaction Patterns

The following interaction patterns should be used consistently:

### Synchronous Command

Use when the caller must know whether the write committed before returning.

### Declared Query

Use when the caller needs read-only data owned by another module.

### Published Event

Use when downstream work may happen after the originating request returns.

### Temporal Workflow

Use when the process spans time, retries, approvals, or compensating actions.

## Current Coord-Template Note

`coord/product/REQUIREMENTS.md` and
`coord/product/MVP_AND_PHASE_MATRIX.md` now carry the imported coord-template
productization baseline. Product runtime delivery in downstream projects still
requires project-specific bounded contexts, integration seams, and acceptance
gates before feature tickets depend on them.
