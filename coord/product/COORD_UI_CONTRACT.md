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
- `coord/.runtime/readiness-report.json`
- plan records and gate artifacts, when present
- `coord/docs/decisions/README.md` and ADR files under
  `coord/docs/decisions/`
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
| `/readiness` | Adoption profile, phase, repo shape, setup decisions, gaps, suggested tickets, and pilot-vs-enterprise blockers from the generated readiness report |
| `/pipeline` | PR/landing pipeline |
| `/urs` | Configured requirements document |
| `/screens` | Screen/requirement index and unlinked worklist |
| `/traceability` | Requirement and closure traceability |
| `/requirements/sources` | Requirements baseline presence, external authoritative source declarations, registry, and import status |
| `/requirements/profile` | Requirements Assurance Protocol profile and command contract status |
| `/requirements/conformance` | Generated requirements conformance and source-hygiene findings |
| `/requirements/surfaces` | Persona/app/surface conformance and shared cross-cutting gaps |
| `/requirements/domain-boundary` | Domain ontology, decision authority, citation, contradiction, and investigation workflow coverage |
| `/requirements/generalization` | Donor/legacy residue, owning abstraction, scrub status, and governed worklist |
| `/requirements/workflows` | Workflow and URS alignment gaps |
| `/requirements/donor-reuse` | Donor reuse provenance and unsafe reuse findings |
| `/requirements/deviations-waivers` | Waiver/deviation closure metadata and expiry findings |
| `/requirements/controlled-documents` | Controlled-document closure records and vendor-template warnings |
| `/requirements/sequencing` | Risk-aware sequencing recommendations |
| `/requirements/stale-impact` | Requirement block-hash changes and impacted tickets/screens/evidence |
| `/adrs` | ADR cockpit/readout with decision coverage, status mix, affected repos/modules, linked tickets/requirements, supersession, revisit triggers, and non-terminal decision-required tickets missing accepted ADRs |
| `/continuity` | Read-only continuity readout with warm-start/cold-finish records, daily journal summaries, open decisions, cadences/cursors, stale sources, promotion candidates, durability-sweep recommendations, and read-before-pull findings |
| `/issues` | Review findings |
| `/waivers` | Waivers and follow-up exceptions |
| `/git` | Per-repo git state |

Projects may hide routes whose source artifacts do not exist yet, but they
should not change route semantics.

## Readiness Cockpit

The `/readiness` route is a read-only adoption surface over the generated
readiness artifact:

```bash
coord/scripts/coord doctor --dir . --json --output coord/.runtime/readiness-report.json
```

The UI consumes `coord/.runtime/readiness-report.json`; it must not reimplement
the readiness scanner in the web tier and must not run `coord doctor` from a
request path. When the artifact is missing or invalid, the route renders the
copyable generation command and an explicit missing/invalid state.

The route may show:

- recommended adoption profile and governance phase;
- detected repo shape and package/test/build signals;
- setup decisions from `coord/setup.decisions.json` as reported by the doctor;
- missing governance artifacts, shim drift, requirement/doc gaps, and
  test/gate maturity findings;
- suggested tickets and their board status;
- pilot blockers and enterprise blockers.

The route must not claim enterprise readiness. It may only present the
artifact-backed blockers and implemented controls.

## Requirements Cockpit

The requirements cockpit is a read-only lens over generated Requirements
Assurance Protocol artifacts. The executable view model is emitted by
`coord requirements-cockpit-model --json --output coord/.runtime/requirements/cockpit-model.json`.
It lists each route, data sources, artifact availability, and a copyable command
string that an operator can run outside the UI. The UI must render those
commands as text only; it must not execute import, conformance, evidence,
sequencing, donor, waiver, or controlled-document commands from the web tier.

Required requirements views:

- sources and profile status;
- traceability and generated conformance;
- persona/surface conformance and workflow alignment;
- domain ontology and decision-boundary coverage;
- donor/legacy generalization audit coverage;
- donor reuse and donor-derived analysis;
- deviations, waivers, and controlled-document closure;
- risk-aware sequencing recommendations;
- stale requirement impact after PRD/URS changes.

Demo/walkthrough data lives at
`coord/product/demo/requirements-cockpit-demo.json`. It is a public-safe,
source-cited sample of how the cockpit presents requirements coverage, persona
blockers, screen coverage, donor-derived provenance, stale impacts, and
ticket/evidence closeout over an existing repo plus existing URS. It is not a
canonical requirement source and must not be used to close tickets. Cockpit
routes may render it only as demo/readout data when real generated artifacts are
absent.

## ADR Cockpit

The `/adrs` route is a read-only decision-record surface over the generated ADR
cockpit/readout:

```bash
coord/scripts/coord adr-validate --cockpit --json --output coord/.runtime/adr-cockpit.json
```

The UI consumes the generated artifact when present. If it is missing, the UI
may render a missing-artifact state with the copyable generation command above,
or derive the same view model in memory from `coord/docs/decisions/*.md`,
`coord/docs/decisions/README.md`, `coord/board/tasks.json`, and plan records
when available. It must not persist that derived model from a request path.

The route may show:

- ADR index, status mix, and validation findings;
- affected repos/modules from ADR linked scope;
- linked tickets and requirement ids;
- supersession chains and history-only superseded decisions;
- deferred ADR revisit triggers;
- non-terminal decision-required tickets that lack an accepted ADR, explicit
  waiver, or investigation status;
- copyable governed commands such as `coord/scripts/gov adr new`,
  `coord/scripts/gov adr link`, and `coord/scripts/gov adr supersede`.

The route must remain read-only. It must render commands as text only and must
not execute ADR creation, ticket linking, supersession, plan updates, board
edits, runtime writes, or lifecycle mutations from the web tier. The generated
readout's `--demo` mode includes public-safe accepted, deferred, superseded, and
missing-ADR cases for walkthroughs; demo data is not canonical decision
evidence.

## Continuity Readout

The `/continuity` route is a read-only handoff and resume surface. It may render
the model produced by the continuity helpers in
`coord/scripts/governance-context.js`, including public-safe pilot fixture data
when no real continuity artifact exists yet.

The route may show:

- warm-start records and the governed sources they require before planning;
- cold-finish records and evidence refs from the previous session or run;
- daily journal summaries with observations, dead ends, decisions needed, and
  promotion candidates;
- open decisions with owner/source refs and copyable governed commands for
  resolution;
- active cadence/cursor state, stale or unknown cursor warnings, and
  read-before-pull findings;
- stale sources and invalidated assumptions;
- durability-sweep promotion, demotion, ADR, ticket, memory-claim, cadence, and
  adapter-consolidation recommendations;
- a cold-start resume proof that lists the first reads tomorrow's agent should
  perform.

The route must remain read-only. It must render commands as text only and must
not execute `coord/scripts/gov`, mutate board state, advance cursors, append
journals, resolve decisions, file tickets, create ADRs, update memory claims, or
persist derived fixture data from a request path. Changes must be routed through
governed commands such as `coord/scripts/gov explain <ticket>`,
`coord/scripts/gov update-plan ...`, `coord/scripts/gov log-question ...`,
`coord/scripts/gov adr ...`, or `coord/scripts/gov file-ticket ...`.

Public-safe pilot fixtures must stay generic. The recurring validation and
audit-remediate-reaudit examples use synthetic tickets and evidence refs only;
they must not include private project names, customer data, secrets, or
proprietary source bodies, and they must not be treated as canonical evidence.

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
