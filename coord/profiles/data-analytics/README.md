# Data & Analytics Engineering Profile — borrowable scaffold

A reusable governance scaffold for a **data-engineering & analytics**
project: certified data products, hard-fail data-quality gates, a dual control/
retirement registry, per-output data contracts, and scope-disciplined read-time
filtering.

> **Reference build:** these patterns are distilled from a real multi-agent
> data-analytics engagement that ran with ad-hoc procedural governance.
> This scaffold productizes those patterns into a **generic, domain-free template**
> a new data project can borrow. No domain content from the reference build is
> carried over — fill in your own.

This profile is the consumer-side half of the **data & analytics engineering** track
described in [`coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md`](../../product/MULTI_TRACK_GOVERNANCE_PROFILE.md).
That track's gate-proc is **`data-contract`** (certification + hard-fail DQ + lifecycle),
implemented by [`coord/scripts/data-contract-gate.js`](../../scripts/data-contract-gate.js).
Tickets prefixed `DATA-` / `ANALYTICS-` resolve to this track.

---

## What this profile gives you

| Pattern | File / dir | What it enforces |
|---|---|---|
| **Dual registry** | `07_orchestration/pipeline.yml` (control + contracts) and `07_orchestration/lifecycle.yml` (retirement) | One source of truth for every data product; a separate ledger for what has been retired |
| **Per-output data contract** | `templates/output.contract.md` | Each certified output ships a `<name>.contract.md` stating grain, key, currency, tests + results, allowed/not-allowed use |
| **Hard-fail DQ gates** | declared per-entry in `pipeline.yml`, run by the `data-contract` gate-proc | currency-suffix, `reconciles_to ±tol`, `baseline_metric` band, `key_coverage_with` ratio, period identity, no-duplicate-key |
| **Certified-only-feeds-certified** | `certified:` flag + lifecycle gate | a certified product may only consume certified / non-superseded inputs |
| **Scope guards** | `lib/scope.py` | read-time filtering — certified files stay broad; scope is applied at consumption, never baked silently into a deliverable |
| **Canonical definitions** | `lib/definitions.py` | one place for period bounds, FX/currency rule, segment normalizers |
| **Ground rules** | `GROUND_RULES.md` | a CLAUDE.md-style operating contract for any agent on the track |

---

## How to borrow it into a data project

1. **Copy** `coord/profiles/data-analytics/` into your data project (commonly as
   an `analysis/` root, or alongside your pipeline code).
2. **Rename** the stage folders only if you must — the `data-contract` gate-proc
   and the registry assume the `00_config … 08_tests` layout below.
3. **Fill the stubs:**
   - `07_orchestration/pipeline.yml` — replace the EXAMPLE entries with your real
     data products (one entry per output family).
   - `07_orchestration/lifecycle.yml` — list your canonical / support outputs;
     move retired ones under `superseded:`.
   - `lib/definitions.py` — set your real period bounds, FX rule, and normalizers
     (resolve the `TODO`s).
   - `lib/scope.py` — adapt the generic `cohort_filter` / `segment_only` guards to
     your channel/segment columns.
   - `GROUND_RULES.md` — keep the hard rules; swap in your engagement's scope,
     thesis, and denominators.
4. **Wire the gate:** point the `data-contract` gate-proc at your
   `07_orchestration/pipeline.yml`. On every change, the gate certifies each
   product and **hard-fails** on any declared DQ violation.
5. **Emit a contract per certified output** from `templates/output.contract.md`,
   landing it next to the data as `<name>.contract.md`.

---

## Stage-foldered layout

The pipeline is **importable and stage-foldered** so each stage is a clean
boundary and the orchestrator can run a single stage or the whole chain.

```
data-analytics/
├── README.md                     this file
├── GROUND_RULES.md               CLAUDE.md-style operating contract for the track
├── 00_config/                    constants, paths, run-config (no logic)
├── 01_ingest/                    raw → cached source frames (loaders, parsing)
├── 02_marts/                     conformed dimensions / facts (joins, grain fixes)
├── 03_quality/                   data-quality probes, reconciliation, join audits
├── 04_analytics/                 the analytic builders (one script per product family)
├── 05_dashboards/                consumption apps; scope applied here at read time
│   └── lib/  → see ../lib/scope.py, ../lib/definitions.py
├── 06_outputs/                   certified outputs + companion <name>.contract.md
├── 07_orchestration/             pipeline.yml (control+contracts) + lifecycle.yml (retirement)
├── 08_tests/                     pipeline / contract / smoke tests
├── lib/                          scope.py, definitions.py (shared, generic)
└── templates/                    output.contract.md template
```

(In the reference build the dashboards' `lib/` held `scope.py` and the canonical
definitions; here they are hoisted to a top-level `lib/` so any stage can import
them.)

---

## How it maps to the governance track + the data-contract gate

The `data-contract` gate-proc reads `07_orchestration/pipeline.yml` and, for each
entry, runs the **always-on** tests plus any **declared** gates, then stamps a
contract. The flow is:

```
edit a builder / registry entry
      │
      ▼
data-contract gate-proc  ──reads──▶  07_orchestration/pipeline.yml
      │                                     │
      │  per entry:                         ├─ always-on: row_count_positive,
      │                                     │             required_columns, no_duplicate_key
      │                                     ├─ declared:  currency_suffix, reconciles_to{±tol},
      │                                     │             baseline_metric{min,max}, key_coverage_with{ratio},
      │                                     │             period identity
      │                                     └─ certified-only-feeds-certified
      │                                          (cross-checked against lifecycle.yml superseded:)
      ▼
pass → stamp 06_outputs/<name>.contract.md   ·   any hard-fail → refuse (build red)
```

Certification ends with the **"N certified, 0 refused"** invariant. A retirement
(`label_lifecycle`-style) check enforces that **no `superseded:` item feeds a
certified product**. See `GROUND_RULES.md` §Certification and §Retirement for the
operating rules an agent must follow.
