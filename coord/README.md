# coord-template

Reusable coordination scaffold for multi-repo projects.

**Before adding/moving/deleting anything here, read [`DIRECTORY.md`](./DIRECTORY.md)** —
the map of canonical vs generated vs ephemeral state and the template-managed
paths that must not be restructured downstream.

This template provides:
- governance policy
- a canonical task board
- ticket prompts and shard notes
- shared planning and Q&A logs
- runtime coordination support under `.runtime/`
- stub templates for product, architecture, and domain specifications

## Adoption Stance

Concord is meant to be borrowed into an existing engineering system. It does not
require product code to move, CI to be replaced, or requirements to be rewritten.
Map the repos you already have, keep the gates they already run, and link the
PRD/URS/specification artifacts your team already trusts. Concord then adds the
governed execution layer: ownership, locks, per-ticket plans, evidence, review,
traceability, and an auditable journal.

The canonical repo map lives in `../coord/project.config.js` and is rendered into `product/REPOS.md`.
Template defaults assume sibling repos:
- `../backend`
- `../frontend`

If your repo names differ, update `../project.config.js` or rerun the template init with `--repo ...`.
`product/REPOS.md` and `scripts/preflight.sh` follow that config automatically.

## Specification Stubs

The following files start as stubs with purpose descriptions. Populate them with
project-specific content before major feature implementation, or use them as
pointers to existing PRD/URS/specification sources:

| Category | File | Purpose |
|---|---|---|
| Requirements | `product/REQUIREMENTS.md` | Product requirements (URS/PRD) |
| Coord UI | `product/COORD_UI_CONTRACT.md` | Read-only governance UI adoption contract |
| Screen index | `product/SCREEN_INDEX_CONTRACT.md` | Derived screen/requirement coverage method |
| Architecture | `product/ARCHITECTURE.md` | Runtime architecture and stack |
| Domain | `product/DOMAIN_MODEL.md` | Entity model and constraints |
| Release scope | `product/MVP_AND_PHASE_MATRIX.md` | Phase definitions and capability matrix |
| Configuration | `product/CONFIG_INHERITANCE_MODEL.md` | Config hierarchy and inheritance |
| Forms/Workflow | `product/FORMS_AND_WORKFLOW_CONTRACT.md` | Shared form and workflow contracts |
| Offline/Sync | `product/OFFLINE_SYNC_AND_CONFLICTS.md` | Sync strategy and conflict resolution |
| Security/DR | `product/SECURITY_AND_OPERABILITY.md` | Security, DR, and operability baseline |
| Onboarding | `product/ONBOARDING_AND_CUTOVER.md` | Tenant onboarding and migration |
| Testing | `product/TESTING_AND_GATES.md` | Quality gate policy |
| Automation | `product/LOCAL_AUTOMATION_AND_GATES.md` | Gate runner contract |
| Integration | `product/INTEGRATION.md` | Bounded-context and contract map |

## Borrowing Flow

1. Copy this directory into a project as `coord/`
2. Update repo names in `../project.config.js` (or via `init.sh --repo ...`) and confirm `product/REPOS.md`
3. Link or populate the specification stubs relevant to your project, especially PRD/URS and architecture
4. Replace the seed backlog in `board/tasks.json`, preserving references to external tickets when useful
5. Run `node coord/board/board.js sync`

## Start Here

- `GOVERNANCE.md`
- `docs/GCV4_ENGINE_CONFIG_SEAM.md`
- `product/REPOS.md`
- `board/tasks.json`
- `AGENT_PATHS.md`
