<!--
  output.contract.md — PER-OUTPUT DATA CONTRACT template.

  Emit one of these next to every certified output as `<name>.contract.md`.
  The data-contract gate-proc fills the test-results table and the certification
  stamp; the rest is sourced from the product's pipeline.yml registry entry.
  Replace every <PLACEHOLDER>. Delete this comment in the generated file.
-->

# Data contract — `<output_filename>.csv`

- **Analytic id:** `<id from pipeline.yml>`
- **Producing script:** `<script>`  (under `04_analytics/`)
- **Grain:** `<one row per ...>`
- **Primary key:** `<key — column or list>`
- **Period:** `<reporting period, e.g. Q1_2026>`
- **Currency basis:** `<USD | local | n/a>` — `<gross | net>`; FX rule per
  `lib/definitions.py`. (Monetary columns carry a currency suffix or are listed
  in `currency_exempt`.)
- **Certified:** `<true | false>`

## Purpose
`<one-line statement of the decision this output supports.>`

## Audience
`<who consumes this — e.g. ops lead / commercial / data governance.>`

## Inputs
- `<input file 1>`  — `<certified? non-superseded?>`
- `<input file 2>`

## Allowed use
- `<the decisions / diagnoses this output IS valid for.>`

## NOT allowed use
- `<the misuses this output must NOT be put to — e.g. individual scoring,
  margin/profitability claims, extrapolation beyond the sampled cohort.>`

## Caveats
- `<known limitation 1 — surface it whenever it affects a conclusion.>`
- `<known limitation 2.>`

## Contract tests (at certification)

| test | result |
|---|---|
| declared_outputs_present | `<pass/fail>` |
| row_count_positive | `<pass/fail>` |
| required_columns | `<pass/fail>` |
| no_duplicate_key | `<pass/fail>` |
| currency_suffix | `<pass/fail/n.a.>` |
| reconciles_to (±tol) | `<pass/fail/n.a.>` |
| reconciles_to_row_count (before/after) | `<pass/fail/n.a.>` |
| baseline_metric (band) | `<pass/fail/n.a.>` |
| key_coverage_with (ratio) | `<pass/fail/warn/n.a.>` |
| period_identity | `<pass/fail>` |

## Certification stamp

_Certified `<ISO-8601 timestamp>` by the data-contract gate from the
`07_orchestration/pipeline.yml` registry._
