# Production LOC bounds and change attribution

COORD-675 decision: a production high-water value is an **upper bound**, not an
identity. Measured LOC may be below or equal to the existing cap. Unused headroom
does not require a manual cap edit. This matches the production budget check and
the default 1,200-line budget; it does not authorize increasing any cap.

Decomposition evidence still records the exact measured before/after values and
an honest reduction. The proof gate verifies the current count, claimed reduction,
declared target and budget, and the real configured high-water bound. A stale
measurement or an inflated proof budget cannot authorize a real cap breach. Two
successive root reductions can pass against the same unchanged bound without
hand-computing a new cap for each ticket. Downward budget changes remain available
through the existing shrink-only budget derivation; upward changes and grandfather
exemptions remain prohibited.

## Inherited debt and the current change

Finding identities remain stable for deduplication. Classification also compares
the measured production LOC, so an existing finding cannot hide additional growth.
For example, with a 1,200 cap, a baseline at 1,201 and a current count of 1,205
reports one inherited excess line and four added lines / four added excess lines.
That current finding is classified as **new**.

The actual quality consumer returns `summary.prodloc_attribution`, and the
architecture CLI appends the same per-file details to its summary:

- `baseline_loc`, `current_loc` and `declared_budget` identify the measurements.
- `inherited_excess` is the baseline violation against its baseline budget.
- `added_loc` is the current LOC minus baseline LOC; it can be negative.
- `added_excess` is additional excess attributable to source growth.
- `budget_excess_change` separately identifies the effect of a changed threshold.
- `classification` is `new` for new findings, added LOC or increased debt caused
  by a lower threshold; otherwise it is `pre-existing`.

If the baseline had no finding, its exact LOC is unavailable in that finding-only
comparison. `baseline_loc` and `added_loc` are null, while newly exceeded LOC is
reported. Absence of a finding is never presented as a measured zero-line file.

Production findings with fail severity remain blocking in ratchet mode even when
unchanged or reduced but still over budget. They cannot be grandfathered by their
classification. Other architecture dimensions retain their existing warning and
baseline policies. Repo-X closeout independently enforces the absolute production
budget through [the committed-tree gate](PRODLOC_CLOSEOUT.md).

## Verification history

The original decomposition consumer rejected measured 2,422 under an unchanged
2,423 cap. The original quality consumer returned ratchet PASS for 1,201 to 1,205
growth at a 1,200 cap, despite both absolute checks failing. Regression coverage
now exercises these consumers and the real Git-backed CLI, along with unchanged,
reduced, resolved and newly introduced debt. No production cap changed in this fix.
