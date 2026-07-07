# Multi-Track Governance Profile — Marketing, Development, DevOps, Product-Engineering, Data & Analytics

Status: **implemented (pilot)** (2026-06-24) · Owner: Softsensor · Supersedes the 3-track scope of
[`CONTENT_SITE_GOVERNANCE_PROFILE.md`](CONTENT_SITE_GOVERNANCE_PROFILE.md) by adding two engineering tracks.
Enforcement status by surface is tracked in
[`POLICY_ENFORCEMENT_MATRIX.md`](POLICY_ENFORCEMENT_MATRIX.md).

> A reusable extension to coord-template: a **multi-track governance profile** so one Concord-managed
> project governs several kinds of work — each with its own gate, skills, review policy, and operator —
> via the existing seams (config, gate-procs, skills, RBAC) with **no engine fork**.
>
> **Track** = work-type axis (selects gate-proc + default lane + skills + review policy + operator).
> **Lane** = gate-intensity axis (`default`/`full`/`ci`), the existing engine concept, unchanged.
>
> Put differently: a track is a **governed task harness**. It packages the
> setup, proof artifact, gate-proc, review policy, and closeout contract that
> fit the work. Code should not be verified like a production-MCP read, and a
> data product should not be verified like a marketing copy edit.

## The five tracks

| Track | Gate-proc | Default lane | Operator |
|---|---|---|---|
| **marketing** (content/docs) | `content` (HTML/links/SEO-meta/Lighthouse/preview) | default | marketing |
| **development** (code) | `test` (existing `testCommand`) | default→full | engineer / coding agent |
| **devops** (infra/deploy) | `infra` (config/workflow/security-headers/deploy-smoke) | full | devops |
| **product-engineering** (live production MCP) | `evidence` (operation-class + receipt + redaction validation) | default | product engineer / analyst |
| **data & analytics engineering** (pipelines + certified products) | `data-contract` (certification + hard-fail DQ gates + lifecycle) — reference data-platform model | default→full | data engineer / analyst |

Track resolves from ticket prefix via a `tracks` block in `coord/project.config.js`
(`WEB-`/`DOC-`→marketing, `DEV-`/`FE-`→development, `OPS-`→devops, `PE-`/`LIVE-MCP-`→product-engineering,
`DATA-`/`ANALYTICS-`→data&analytics), with a `gov start --track` override.

New teams do not have to design this map from a blank page. The product CLI
ships conservative track presets:

```bash
coord/scripts/coord track-presets
coord/scripts/coord onboard . --dry-run
```

Presets suggest repo aliases, ticket prefixes, default gates, proof artifacts,
and adoption notes for common starting shapes (`web-app`, `data-service`,
`content-site`, `infra`). They are setup guidance, not a separate track model;
the canonical track registry and gate policy still own enforcement.

## Communication shorthand

Use this in product copy and demos:

> One lifecycle, different proof harnesses.

The operator-facing translation:

- code changes prove tests, contracts, and landing evidence;
- content changes prove links, metadata, preview, and review;
- infra changes prove configuration, security headers, and deploy smoke;
- live-MCP work proves operation class, scope, approval, redaction, receipt, and cleanup;
- data products prove contracts, data-quality checks, lineage, row-count proof, and reconciliation.

## Recently landed overlays

The original five-track profile is now joined by several cross-cutting governed
harnesses that apply to one or more tracks:

| Overlay | What landed | Applies to |
|---|---|---|
| **Runtime evidence** | `gov live-mcp-record`, `bootstrap-record`, `deploy-record`, `deploy-check`, `verify`, `falsify`, receipt validation, cleanup proof | product-engineering, devops, bootstrap/backfill work |
| **Bootstrap/backfill safety** | advisory checks for boot-time work, leases/checkpoints, resource envelope, bounded reads, runtime success proof, live-MCP-assisted bootstrap investigation | development, devops, data & analytics |
| **Governed memory** | decision extraction, summary tiers, semantic recall, graph memory, closeout summaries, execution insights, learned-rule promotion | all tracks |
| **Quality dimensions** | architecture, contract, coverage, mutation, SAST, supply-chain, accessibility, performance-budget, and audit-policy checks | mainly development, with opt-in use by other tracks |
| **Operator cockpit** | read-only live-MCP, bootstrap-risk, configuration, quality, runtime, gates, evidence, waivers, agents, cost, and pipeline views | all tracks |

## Reuse, don't reinvent

**Production-MCP machinery already in Concord** (powers product-engineering):
`runtime-evidence.js` (operation classes `read_safe`→`destructive`, receipt schema + `validate*`, evidence
classes), `governance-mcp.js` (`gov_live_mcp_*`; GCV-1 O3 → record via CLI), `PRODUCTION_MCP_ADAPTER_PLAN.md`
(adapter contract, 3-lane model), `followups.js` (cross-track handoff), `enterprise-rbac-policy.js` (roles).

**The prior data-platform build is the data & analytics blueprint** — built multi-agent with
*ad-hoc procedural governance, not coord-template*. Productize its patterns:
dual-registry (`pipeline.yml` control+contracts / `lifecycle.yml` retirement), per-output `*.contract.md`,
hard-fail DQ gates (currency-suffix, `reconciles_to ±tol`, `baseline_metric` band, key-coverage, period
identity), certified-only-feeds-certified, scope guards + canonical `definitions.py`, stage-foldered
importable pipeline, ground-rules docs. The reference data-platform pattern is batch/offline → its gate is **contract/certification**,
distinct from product-engineering's **receipt/operation-class** gate.

## Composition (tracks chain, not merge)

```
product-engineering (live MCP read) ──feeds──▶ data & analytics (pipeline + certified product)
        │                                              │
        └─ finding ─▶ development (code fix) ◀── insight ─┘   (all via gov open-followup)
```

## Confirmed decisions (2026-06-23)
1. Keep marketing — all prior tracks retained.
2. product-engineering is a **separate** track reusing the production-MCP machinery, handing off to
   development for code fixes. Not merged.
3. Analytics is first-class now, not deferred.
4. **Five tracks** — data & analytics engineering is its own track, split from product-engineering.
5. The reference data-platform pattern productized as a **borrowable scaffold + data-contract gate-proc**.

## Tickets

Phase A (upstream, coord-template) — implemented in the template:

| Ticket | Status | Type | Scope |
|---|---|---|---|
| COORD-181 | done | design | Track model + `tracks` config seam (now 5 tracks) + `gov start --track` |
| COORD-182 | done | feature | `content` gate-proc (marketing) |
| COORD-183 | done | feature | `infra` gate-proc (devops) |
| COORD-184 | done | feature | Marketing skills (`content-edit`/`seo-check`/`publish`) |
| COORD-185 | done | design | Track→review-policy + RBAC/operation-class mapping |
| COORD-186 | done | docs | Profile docs + opt-in toggle |
| COORD-187 | done | feature | `evidence` gate-proc (product-engineering) over `runtime-evidence.js` |
| COORD-188 | done | feature | Product-engineering skills (`live-mcp-policy`/`analytics-query`/`insight-analyst`) |
| COORD-189 | done | docs | `PRODUCT_ENGINEERING_TRACK.md` (adopts PRODUCTION_MCP_ADAPTER_PLAN) |
| COORD-190 | done | feature | Track-aware `gov open-followup` handoff (product-eng/data → development) |
| COORD-191 | done | feature | `data-contract` gate-proc (reference data-platform model) |
| COORD-192 | done | feature | Data & analytics skills (`data-pipeline`/`data-contract`) |
| COORD-193 | done | scaffold | Data-analytics borrowable scaffold `coord/profiles/data-analytics/` |
| COORD-194 | done | docs | `DATA_ANALYTICS_TRACK.md` (adopts the reference data-platform pattern) + update profile to 5 tracks |

Phase B (downstream): instantiate on consumer projects (e.g. `example-content-site` for marketing/devops;
a data project borrowing the data-analytics scaffold) — `WEB-`/`OPS-`/`DATA-` tickets on those boards.

## Current verification contract
- `cd coord && npm test` — new `track-registry` / `analytics-gate` / `data-contract-gate` tests pass;
  existing suite stays green.
- `node coord/board/board.js validate && node coord/board/board.js sync`.
- Smokes: product-eng evidence gate validates a `read_safe` receipt; data-contract gate hard-fails a
  fixture with a currency/reconcile violation then passes when fixed; `gov open-followup --relation
  blocking` spawns a development-track child.
- Backfill/data work that declares `reconciles_to_row_count` must provide before/after row-count proof and
  fail closed when the post-run count is absent or outside tolerance.
