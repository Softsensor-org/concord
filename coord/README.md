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
- product, architecture, domain, and curated knowledge specifications

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

If your repo names differ, update `project.config.js` or run
`coord/scripts/coord onboard .. --dry-run` and apply its reviewed digest. The
installer does not accept repository mapping as an install-time mutation.
`product/REPOS.md` and `scripts/preflight.sh` follow that config automatically.

## Specifications And Knowledge Baseline

The template carries a Concord-specific baseline. Downstream projects should
replace product-specific content with their own reviewed material or pointers to
existing PRD/URS/specification sources. Generated discovery output is advisory
until it is curated into these canonical files.

| Category | File | Purpose |
|---|---|---|
| Requirements | `product/REQUIREMENTS.md` | Product requirements (URS/PRD) |
| Coord UI | `product/COORD_UI_CONTRACT.md` | Read-only governance UI adoption contract |
| Screen index | `product/SCREEN_INDEX_CONTRACT.md` | Derived screen/requirement coverage method |
| Architecture | `product/ARCHITECTURE.md` | Runtime architecture and stack |
| Domain | `product/DOMAIN_MODEL.md` | Entity model and constraints |
| Code review baseline | `product/CODE_REVIEW_BASELINE.md` | Current verified gaps, strengths, and critical path |
| Business context | `product/BUSINESS_CONTEXT.md` | Product purpose, users, value chain, and trust boundary |
| Business rules | `product/BUSINESS_RULES.md` | Accepted rules and explicitly proposed hardening |
| Workflows | `product/WORKFLOW_INVENTORY.md` | Governed end-to-end operating workflows |
| Downstream contracts | `product/DOWNSTREAM_CONTRACTS.md` | Provider/consumer contracts and compatibility rules |
| Decisions | `product/DECISION_LOG.md` | Product-facing index of accepted/deferred ADRs |
| Workarounds | `product/KNOWN_WORKAROUNDS.md` | Temporary guidance for verified open defects |
| Open questions | `product/OPEN_BUSINESS_QUESTIONS.md` | Curated product and operating decision queue |
| Preservation harness | `product/PRESERVATION_HARNESS_CANDIDATES.md` | Field-incident and public-boundary regression scenarios |
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
2. Update repo names in `../project.config.js` (or run `coord onboard` from the parent workspace) and confirm `product/REPOS.md`
3. Link or populate the specification stubs relevant to your project, especially PRD/URS and architecture
4. Replace the seed backlog in `board/tasks.json`, preserving references to external tickets when useful
5. Run `node coord/board/board.js sync`

## Start Here

- `GOVERNANCE.md`
- `docs/GCV4_ENGINE_CONFIG_SEAM.md`
- `product/REPOS.md`
- `board/tasks.json`
- `AGENT_PATHS.md`
