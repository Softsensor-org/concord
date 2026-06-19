# Coord UI Contract

Reusable contract for a read-only governance UI that can live in a product
frontend repo while reading the sibling `coord/` repo.

## Purpose

`coord-ui` is an operator cockpit over governance state. It may render board
state, active work, events, gates, traceability, requirements, and derived
screen-index coverage, but it is not an orchestration engine.

All mutations stay in governed tools such as `coord/scripts/gov` or a future
MCP surface that enforces the same lifecycle policy. The web tier must not
write to board state, runtime locks, requirements, product code, or generated
governance artifacts.

## Default Layout

The portable default is the coord-template sibling-repo layout:

```text
project/
|-- backend/
|-- frontend/
|   `-- apps/
|       `-- coord-ui/
`-- coord/
```

Projects with different repo names may still adopt the UI by configuring paths
with environment variables.

## Required Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `COORD_DIR` | no | Path to the `coord/` repo. Defaults to a sibling `coord/` discovered from the running app. |
| `COORD_REQUIREMENTS_PATH` | no | Product requirements/URS document. Relative values resolve from `COORD_DIR`. |
| `REQUIREMENTS_PATH` | no | Compatibility alias for `COORD_REQUIREMENTS_PATH`. |
| `URS_PATH` | no | Legacy compatibility alias for `COORD_REQUIREMENTS_PATH`. |
| `SCREEN_APPS_DIR` | no | Directory containing product apps to index. Defaults to the `apps/` directory that contains `coord-ui`. |

If no requirements path is configured, consumers should try these candidates in
order:

1. `coord/product/REQUIREMENTS.md`
2. `coord/product/LAST_MILE_OPS_URS.md`
3. `coord/REQUIREMENTS.md`
4. `coord/LAST_MILE_OPS_URS.md`

The first candidate is the coord-template canonical requirements path. The
acme-ops URS filename remains a downstream compatibility fallback only.

## Read Model

A conforming UI may read:

- `coord/board/tasks.json`
- `coord/active/*.md`
- `coord/.runtime/governance-latest-snapshot.json`
- `coord/.runtime/governance-events.ndjson`
- `coord/.runtime/agent_sessions.json`
- `coord/.runtime/screen-index.json`
- plan records and gate artifacts, when present
- product requirements under `coord/product/`

Missing runtime files must degrade to empty states or explicit warnings. A
fresh coord-template checkout should be viewable before any runtime journal
exists.

## Route Shape

The first portable route set is:

| Route | Purpose |
| --- | --- |
| `/` | Board overview |
| `/ticket/[id]` | Ticket detail and related events |
| `/agents` | Agent/session liveness |
| `/timeline` | Governance event log |
| `/gates` | Gate artifacts |
| `/tests` | Test maturity and evidence |
| `/health` | Derived governance health |
| `/pipeline` | PR/landing pipeline |
| `/urs` | Configured requirements document |
| `/screens` | Screen/requirement index and unlinked worklist |
| `/traceability` | Requirement and closure traceability |
| `/issues` | Review findings |
| `/waivers` | Waivers and follow-up exceptions |
| `/git` | Per-repo git state |

Projects may hide routes whose source artifacts do not exist yet, but they
should not change route semantics.

## Screen Index Integration

The `/screens` route consumes the method in
[`SCREEN_INDEX_CONTRACT.md`](./SCREEN_INDEX_CONTRACT.md). The generator writes
only the derived artifact at `coord/.runtime/screen-index.json`; the UI may
derive an in-memory index when the artifact is absent, but must not persist
from the web request path.

The requirement document label in screen-index refs should be relative to
`COORD_DIR` when possible, for example `product/REQUIREMENTS.md`.

## Adoption Steps

1. Place the UI package in a product frontend repo, commonly
   `frontend/apps/coord-ui`.
2. Configure `COORD_DIR` only when sibling discovery is not enough.
3. Configure `COORD_REQUIREMENTS_PATH` when the project does not use
   `coord/product/REQUIREMENTS.md`.
4. Configure `SCREEN_APPS_DIR` when user-facing apps do not share the same
   parent `apps/` directory as `coord-ui`.
5. Run the UI typecheck/build and the screen-index generator against a clean
   checkout.
6. Verify no web route calls `fs.write*`, `appendFile*`, `exec*`, git mutation,
   or `coord/scripts/gov` mutation commands.

## Non-Goals

- No write-through board editing.
- No browser-side agent spawning.
- No direct requirements edits from the UI.
- No project-specific product assumptions in reusable code.
- No dependence on acme-ops-only filenames, apps, or design tokens in the
  coord-template contract.
