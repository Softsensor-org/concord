# Data & Analytics Track — Governed Pipelines & Certified Analytical Products

Status: **implemented (pilot)** · Part of the [Multi-Track Governance Profile](MULTI_TRACK_GOVERNANCE_PROFILE.md).
Patterns distilled from a prior multi-agent data-platform build (governed procedurally, outside coord);
this track productizes those patterns into the engine + a borrowable scaffold.

## What this track is

The **data & analytics engineering** track governs building data pipelines and shipping **certified
analytical products** (marts, scorecards, model cards, insight tables). Its defining axis is **data-product
trustworthiness**, so its gate is **data-contract certification + hard-fail data-quality checks** — not a
test suite (development) and not a live-MCP receipt (product-engineering).

Ticket prefixes: `DATA-`, `ANALYTICS-` (see the `tracks` block in `coord/project.config.js`).

## The gate: data-contract certification

`coord/scripts/data-contract-gate.js` (COORD-191) evaluates a registry of products against their declared
contracts and runs hard-fail DQ checks, plus two lifecycle invariants:

- `row_count_positive`, `required_columns`, `no_duplicate_key`
- `currency_suffix` — monetary columns must end `_sar`/`_usd` (or be exempt) — never present one currency as another
- `reconciles_to` — a column sum ties to a published total within tolerance
- `reconciles_to_row_count` (COORD-195) — the post-run row count ties to the declared pre-run baseline within tolerance (% and/or absolute). Makes the **before/after row-count proof** mandatory for backfill/reseed work *on this track*; hard-fails if the post-run count is absent or out of band. Optional — outputs that do not declare it are unaffected.
- `baseline_metric` — a model-quality metric stays in its declared band (e.g. AUC ∈ [0.70, 0.80])
- `key_coverage_with` — join-key overlap meets a declared ratio (catches keyspace drift)
- `period_identity` — the product's period matches the declared period
- **certified-only-feeds-certified** — a certified product may consume only certified products
- **no-superseded-feeds-certified** — a retired product may never feed a certified one

```
node coord/scripts/data-contract-gate.js <registry.json> --json
```

The gate is pure-node and operates on a machine-readable registry (the structured form of the scaffold's
`pipeline.yml` plus measured "facts"). Hard-fail: any failed check fails the gate — nothing reaches a deck
or dashboard on drift.

## Borrowable scaffold (COORD-193)

`coord/profiles/data-analytics/` is a reusable profile a data project copies in:

- `07_orchestration/pipeline.yml` — registry: per-product `id, script, grain, key, currency, inputs,
  outputs, tests, certified, allowed_use/not_allowed_use`.
- `07_orchestration/lifecycle.yml` — canonical / support / **superseded** retirement ledger.
- `templates/output.contract.md` — per-output data-contract template.
- `lib/scope.py`, `lib/definitions.py` — read-time scope guards + canonical definitions (period, FX, segments).
- stage-foldered layout (`00_config` → `08_tests`) + `GROUND_RULES.md` (answer-first, certification gates,
  currency correctness, uncertainty labelling).

## Review policy (documented posture — COORD-185)

| Track | Approvers | Required evidence |
|---|---|---|
| data & analytics | 1 | passing data-contract gate + per-output `*.contract.md` |

Pilot posture is convention + review; harden to engine-enforced RBAC later (see
[`release/ENTERPRISE_RBAC_MODEL.md`](release/ENTERPRISE_RBAC_MODEL.md)).

## Skills (`.claude/commands/`, COORD-192)
- `/data-pipeline` — run + certify the pipeline (idempotent stages; certified-only-feeds-certified), then gate.
- `/data-contract` — author/check a per-output `*.contract.md` and run the data-contract gate.
- Reuses the built-in `data-engineer` (build/move/validate data) and `insight-analyst` ("so what?") skills.

## How it chains with the other tracks
A product-engineering live-MCP read can feed a pipeline here; a certified insight that implies a code change
opens a development-track child:

```
product-engineering (live read) ──▶ data & analytics (certified product) ──▶ development (code fix)
                                          via  gov open-followup --relation blocking
```
