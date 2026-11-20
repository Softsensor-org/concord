# Data & Analytics — Ground Rules

Operating contract for any agent or engineer working on the **data & analytics
engineering** track in a project that has borrowed this scaffold. These rules are
**non-negotiable** unless the user explicitly overrides them in the current
conversation.

> Distilled from the reference data-platform build. Keep these hard rules;
> fill the `<engagement>` placeholders with your own scope, thesis, and
> denominators when you borrow the scaffold.

---

## 1. Scope discipline

- The engagement universe is `<state it — the in-scope segment/cohort/period>`.
  State explicitly what is **excluded**.
- **Scope is a consumption-layer guard, not a property of the data layer.**
  Certified outputs in `06_outputs/` are built broad on purpose. **Never build a
  deliverable or dashboard panel directly off a broad certified file** — scope it
  at read time via `lib/scope.py` (`cohort_filter`, `segment_only`).
- Cite a population base **by name, never a raw number** (see
  `lib/definitions.py` → `POPULATION_BASES`). The default denominator for any
  rate or sizing is `DEFAULT_DENOMINATOR`.

## 2. Answer-first — the "so what?"

- Start with the **decision**, not the dataset. If you do not know what action the
  answer changes, you are not ready to analyze — ask.
- **Lead every response with the conclusion in one sentence.**
- "So what?" is mandatory — every finding needs a business consequence.
- Every number needs a benchmark (vs plan / prior / peer). A bare number is not a
  finding.
- Triangulate across source / method / time / segment before calling something a
  finding. One source is a hypothesis, not a conclusion.

## 3. Uncertainty labelling

Name the uncertainty of every headline claim — one of:

| Label | Meaning |
|---|---|
| **Measured** | Directly observed in trustworthy source data |
| **Inferred** | Derived via a stated, defensible assumption |
| **Proxy** | Stands in for the true quantity (true value unavailable) |
| **Scenario** | Conditional on an unconfirmed input; not a fact |

A Proxy or Scenario number must never be presented as Measured.

## 4. Pipeline discipline

- Every analytic runs through the certified pipeline (orchestrator) +
  `07_orchestration/pipeline.yml` (registry).
- A new analytic = a new registry entry carrying: `key`, `tests`, `caveats`,
  `allowed_use`, `not_allowed_use`, `currency` (and `currency_exempt` for
  bare-money columns inherited from upstream).
- Certified outputs land at `06_outputs/<name>.csv` with a companion
  `<name>.contract.md` (from `templates/output.contract.md`).
- After any registry change, run the certify step — it must end
  **"N certified, 0 refused."**

## 5. Certification gates — hard-fail data quality

Use these gates on new outputs where applicable. They **hard-fail** the build —
a violation refuses the product; it does not warn-and-ship.

- **Always-on:** `row_count_positive`, `required_columns`, `no_duplicate_key`.
- `currency_suffix` — monetary columns must end in a currency suffix
  (`_usd` / `_<local>`) or be listed in `currency_exempt` with a basis.
- `reconciles_to` — a column sum must tie to a hard total or a sibling certified
  file within `tolerance` (catches denominator-binding mistakes).
- `baseline_metric` — a model-card metric must stay inside a declared `[min, max]`
  band (catches silent model regressions).
- `key_coverage_with` — cross-file join-key overlap must match the declared
  `ratio` (catches keyspace / ID-bridge drift).
- **period identity** — an output's period must match its declared `period` (no
  period bleed).

## 6. Certified-only-feeds-certified

- A `certified: true` product may only consume **certified, non-superseded**
  inputs. The gate cross-checks every input against `lifecycle.yml`.
- If you need an uncertified or retired input, the consumer cannot be certified —
  set `certified: false` and say why in its caveats.

## 7. Currency correctness

- Declare the currency of every monetary output. Convert only via the pinned FX
  rate in `lib/definitions.py` (`local_to_usd`). **Never present a local-currency
  figure as USD** (or vice-versa).
- State the basis (**gross / net**) explicitly. If margin/COGS is unavailable,
  say so — do not let a gross figure masquerade as economic value.

## 8. Retirement ledger

- Retired scripts / outputs are declared in `07_orchestration/lifecycle.yml`
  under `superseded:` with a `by:` successor and a `note:`.
- The lifecycle check must stay green — **no superseded item may feed a certified
  product.**
- Retired files physically move to `archive/retired_YYYY-MM-DD/` with a README
  entry naming the successor.
- **Never resurface a retired number** in any analysis, deck, or memo.

## 9. Deliverable style

- Final reports are **forward-looking**: no correction-trail, no version-history,
  no "what changed" section — unless the user explicitly asks.
- Self-check every draft for: reporting-without-comparing, averaging averages,
  correlation-as-causation, survivorship bias, and silently dropped outliers
  (detect → investigate → correct or flag — never silently drop).

## 10. Verification after changes

- Pipeline / registry change → run the certify step (0 refused).
- Retiring anything → run the lifecycle check (governance OK / green).
- Reproducible work only: prefer the project venv; commit or push only when asked.
