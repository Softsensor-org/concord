# Data Governance

## Folder Contract

| Folder | Rule |
|---|---|
| `data/raw/` | Immutable source exports or API snapshots. Never edit in place. |
| `data/staged/` | Parsed copies with source fields preserved. |
| `data/clean/` | Normalized tables with consistent naming, typing, and caveats. |
| `data/marts/` | Reconciled decision tables, joins, and rollups. |
| `data/reports/` | Human-readable reports and review notes. |

## Source Registration

Every recurring source is registered in `DATA-REGISTER.csv` before it is used in
a recurring report.

Required fields:

- source system;
- access method;
- refresh cadence;
- raw path;
- clean path;
- owner ticket;
- source-of-truth role;
- cleaning rules;
- reconciliation rules;
- last updated;
- known caveats.

## Raw Evidence

Reports link to raw evidence by path. Do not paste raw private exports into
Coord docs or public examples.
