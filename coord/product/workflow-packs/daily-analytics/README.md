# Daily Analytics Governance Workflow Pack

Status: operating governance pack.

This pack turns recurring analytics work into registered, repeatable, and
reconciled operations without changing the Concord engine.

Coord owns the operating contract:

- which utilities exist and what they read/write;
- which data sources are authoritative for which decisions;
- where raw, staged, clean, mart, and report artifacts live;
- which recurring guidance rules analysts must apply;
- which pipelines ran and whether inputs changed;
- which findings are matched, directional, unresolved, or not comparable.

Adopter-owned data stays under the adopter's `data/` tree. Public pack examples
are synthetic only.

## Four Registers

| Register | Path | Purpose |
|---|---|---|
| Utility Register | `00-ops/utilities/utility-register.csv` | Scripts/tools agents create or use. |
| Data Register | `00-ops/data/DATA-REGISTER.csv` | Source systems, cadence, paths, truth role, cleaning and reconciliation rules. |
| Analytics Guidance | `00-ops/data/ANALYTICS-GUIDANCE.md` | Reusable rules such as directional versus product-truth sources. |
| Pipeline Register | `00-ops/data/PIPELINE-REGISTER.csv` | Repeatable source -> raw -> staged -> clean -> mart -> report flows. |
| Retention/Custody | `00-ops/data/DATA-RETENTION.md` | Local raw evidence retention classes and custody rules. |

## Flow

```text
source export/API
-> raw immutable snapshot
-> staged parsed copy
-> clean normalized table
-> reconciled/mart table
-> report / Coord journal / decision
```

## First-Step Boundary

Do not modify Concord lifecycle enforcement until these operating files are
stable. Later validation can flag unregistered data sources, unregistered
utilities, missing raw evidence, platform writes without approval, or reports
without reconciliation labels.
