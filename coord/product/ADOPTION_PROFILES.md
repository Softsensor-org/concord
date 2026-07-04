# Adoption Profiles

Status: implemented (catalog) · Owner: Softsensor · Date: 2026-06-25

## Purpose

Adoption profiles model governance strictness and maturity. They answer:

> How much evidence, review, runtime proof, and enterprise discipline should
> Concord expect for this repo or ticket family?

Profiles are deliberately separate from tracks.

- **Track** = work type: development, devops, product-engineering, data
  analytics, marketing.
- **Profile** = governance posture: solo-dev, regulated, enterprise,
  production-mcp, server-bootstrap.

The machine-readable source is
[`adoption-profiles.json`](adoption-profiles.json).

## Profiles

| Profile | Intent | Default lane |
| --- | --- | --- |
| `solo-dev` | Lightweight governance for one developer or prototype repo | `default` |
| `small-team` | Shared repo governance for multiple developers or agents | `default` |
| `product-engineering` | Product delivery with requirements, tests, release evidence, and runtime awareness | `full` |
| `regulated` | URS/SRS, validation, audit-facing, or compliance-sensitive delivery | `full` |
| `enterprise` | Enterprise repo-family rollout or central development command center | `full` |
| `production-mcp` | Governed deployed-system observation or investigation through MCP-style adapters | `full` |
| `server-bootstrap` | Startup, seed, migration, replay, backfill, and generated-data work | `full` |

## Mapping

Each profile declares:

- required ticket fields;
- required evidence classes;
- closeout expectations;
- allowed adapter classes;
- recommended tracks;
- UI labels.

The catalog is advisory until a consuming gate enforces a profile. The immediate
consumer is `coord doctor`, which recommends a catalog-backed profile id in its
readiness report.

Governance phase is reported separately. See
[`GOVERNANCE_PHASES.md`](GOVERNANCE_PHASES.md) for the exploration, prototype,
pilot, production, and regulated-production phase model.

## Rules

1. Do not overload `track-registry.js` with maturity semantics.
2. Do not use a profile to weaken existing ticket closeout requirements.
3. Use `production-mcp` and `server-bootstrap` when runtime evidence is central.
4. Use `regulated` when requirements traceability or validation-grade closure is
   required.
5. Use `enterprise` only as a rollout/readiness posture; do not claim enterprise
   security controls unless SSO/RBAC/KMS/tenant controls are actually deployed.
