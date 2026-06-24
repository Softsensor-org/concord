# Data Contract — Author or Check a Per-Output Contract (data & analytics track)

Author or verify a per-output **`*.contract.md`** for a `DATA-`/`ANALYTICS-` ticket and run the
hard-fail **data-contract gate**. Every certified output carries one contract; the gate enforces it.

**Arguments:** `$ARGUMENTS` — a `DATA-`/`ANALYTICS-` ticket id, optionally the output/contract to
focus on (e.g. `DATA-021` or `DATA-021 --output revenue_by_region`).

## Phase 1: Author or locate the contract

Each certified output has a sibling `*.contract.md`. Author a new one or open the existing one and
confirm it declares, at minimum:
- **currency suffix** on every monetary field (e.g. `_usd`)
- **`reconciles_to`** — the source-of-truth it must tie back to, with a tolerance
- **`baseline_metric`** — the expected band the metric should fall within
- **key fields** the output is keyed on (for key-coverage)
- the **period** the output covers (for the period-identity check)
- declared **feeds** (each of which must itself be certified)

## Phase 2: Run the data-contract gate

```bash
node coord/scripts/data-contract-gate.js $ARGUMENTS
```

The gate **hard-fails** (not warns) on any of:
- **currency suffix** — a monetary field missing its currency suffix
- **`reconciles_to` ± tolerance** — output doesn't tie to its source within tolerance
- **`baseline_metric` band** — metric falls outside the declared band
- **key-coverage** — declared keys not fully covered / duplicated
- **period identity** — output's period doesn't match the contract's declared period
- **no superseded feed feeds a certified output** — a certified output consuming a retired/superseded feed

## Phase 3: Report

Report per check: pass / **hard-fail**, the offending output/field, the expected vs. actual value
(e.g. "reconciles_to off by 3.1%, tolerance 1%"), and the artifact path. On any hard-fail the
output is **not** certified — fix the contract or the pipeline (see `/data-pipeline`) and re-run.

## Rules

- The contract is the source of truth for an output's DQ; the gate is non-negotiable and hard-fails.
- Don't loosen a tolerance/band just to pass — fix the data or reconcile the definition.
- No superseded/retired feed may feed a certified output — keep `lifecycle.yml` honest.
- Authoring/checking a contract is governed work: do it inside the ticket's worktree (`/data-pipeline`
  → `coord/scripts/agent do`), not by hand-editing certified state.
