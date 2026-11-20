# ADR 0013: Governance engine and project state use an explicit filesystem seam

- **Status:** Accepted
- **Ticket:** COORD-513, COORD-871
- **Date:** 2026-09
- **Linked scope:** `coord/engine/`, COORD-514, COORD-515, COORD-516, `coord/project.config.js`

## Context

The governance engine, project configuration, durable board state, generated
views, and runtime evidence currently share the `coord/` tree. `engine-pin.json`
and `TEMPLATE_SYNC_MANIFEST.json` identify reusable files by checksum, but an
agent cannot determine ownership from a path. This makes template sync and
upgrade drift reports combine engine edits with project edits, and it makes a
configuration read look like an engine dependency on arbitrary project files.

The prior state-bucket restructure solved canonical, derived, and runtime
state. It did not define the code/config seam. The complete path inventory for
this decision is machine-readable in
`coord/docs/architecture/COORD-513-seam-inventory.json` and classifies all
1,725 tracked `coord/` paths plus the pinned root settings surface with no
unclassified or duplicate entry.

## Linked Scope

- Linked ticket: COORD-871.
- COORD-514 moves engine files using compatibility resolvers.
- COORD-515 moves project-owned configuration and state references behind the
  seam and updates generated/install surfaces.
- COORD-516 derives engine pinning and sync checks from the new boundary.
- `coord/paths.js`, project configuration, board state, gates, and runtime
  evidence are the first seam consumers.

## Decision Criteria

- Engine code must be reusable without reading arbitrary project-owned paths.
- Project-specific values must remain editable without changing engine files.
- Existing installations must continue to work during migration and rollback.
- Every tracked path must have one of the three inventory classifications:
  `engine-canonical`, `project-owned`, or `mixed-needs-config-seam`.
- Pinning and sync checks must be able to report engine drift separately from
  project drift.

## Options Evaluated

- **Directory boundary with a validated config seam (chosen).** Put reusable
  code, schemas, gates, and engine documentation under `coord/engine/`; keep
  project configuration and state outside it; expose only a typed seam object.
- **Checksum manifests only.** Rejected because checksums do not communicate
  ownership at read time and cannot prevent a new engine call from reaching
  project state.
- **Separate repository for the engine.** Rejected for this migration because
  it adds distribution and version coupling before the filesystem contract is
  explicit; it remains a later packaging option.
- **Copy engine files into each project.** Rejected because it preserves the
  same ambiguous ownership and makes upgrades depend on uncontrolled copies.

## Decision

The target tree is:

```text
coord/
  engine/                 # reusable governance implementation and schemas
  project.config.js       # project-owned declaration consumed through seam
  product/                # project requirements and architecture
  prompts/tickets/        # project backlog prompts
  board/tasks.json        # project lifecycle state
  rendered/               # derived project views
  .runtime/               # durable evidence and ephemeral runtime state
```

The config-seam interface is a validated, immutable `ProjectContext` supplied
by the control-plane entry point. It contains resolved repository roots,
integration branches, ticket-prefix/requirements metadata, enabled tracks,
and the state/evidence roots. Engine modules receive this object explicitly;
they do not call `require`, walk parent directories, or infer project paths.
The adapter reads the declarative project config through the existing static
reader, validates paths as workspace-contained, and returns a refusal with an
operator action when the declaration is missing, dynamic, or unsafe.

`mixed-needs-config-seam` means the reusable shape migrates under `engine/`
while project values remain outside it. The inventory records the rationale
for every currently mixed sync surface; no mixed path is silently treated as
engine-canonical.

## Alternatives Rejected

- A global environment-variable convention is too implicit and cannot provide
  the validated repository/state roots needed by board and gate code.
- A symlink-only boundary is rejected because it leaves ownership ambiguous and
  permits path traversal unless every consumer repeats containment checks.
- A one-shot move without compatibility readers is rejected because installed
  workspaces may still contain `board/plans/` and old generated paths.

## Consequences

COORD-514 introduces compatibility readers first, then moves engine modules and
schemas while retaining old entry points. COORD-515 moves config and state
lookups to `ProjectContext` and adds seam tests. COORD-516 makes engine pin and
template-sync discovery derive from the inventory and reports project drift
separately. Each phase has a rollback checkpoint: restore the prior resolver,
retain the inventory, and leave project-owned bytes untouched. The temporary
compatibility reader follows the existing `board/plans/` to `.runtime/plans/`
pattern and is removed only after a clean migration receipt proves no legacy
consumer remains.

## Revisit Trigger

Revisit when packaging requires a separately versioned engine repository, when
new project-owned roots are introduced, or when a migration finds a path that
cannot be classified without a fourth ownership class.

## Waiver Policy

Only the human administrator may waive the seam for a named ticket. The waiver
must name the path, owner, expiry/revisit trigger, and drift evidence; it does
not change the inventory or permit engine code to read arbitrary project paths.
