# Test Maturity Tracker

Updated by `/test-strategy` runs. Do not hand-edit — this is regenerated from codebase analysis.

Last updated: 2026-09-28 (gate-health: 61/2284 review cycles failing (fail_rate=0.0267), 123 recovery events; coverage pass lowest=90.91)

## Maturity Score

Overall: **68/100** — a heavily-tested governed engine, dragged down by surface
dimensions that are *plumbed but dormant* and reference repos that are skeletons by
design. Read the score as: the **product (`coord/scripts`) is strong; the activation
of the newer dimensions and the non-engine repos is where the gaps are.**

Method: 96 engine test files classified by dimension signal; gate suite 1332 pass / 0
fail; frontend/backend = 1 test each (FE-001/BE-001 reference skeletons meant to be
replaced by adopters); the six COORD-131..137 adapters confirmed running but in `skip`
(no external tool configured).

## Dimension Coverage

| Dimension | Covered | Required | Pct | Trend | Evidence / Gap |
|-----------|---------|----------|-----|-------|----------------|
| Unit | 96 | 96 | ~95% | baseline | 96 engine test files, 1332 tests, 0 fail |
| Contract | strong (engine) | engine + FE↔BE | ~70% | baseline | 67 files w/ schema/shape/round-trip; CONTRACT-002 CI-safe check. Gap: thin at the real FE↔BE network boundary (skeletons) |
| Integration | good | engine | ~60% | baseline | 30 files (dual-release, gate-runtime, governance integration) |
| State | strong | engine | ~85% | baseline | 83 files (lock/chain/journal/drift/concurrency) — the engine's core risk surface |
| Edge case | strong | engine | ~70% | baseline | 66 files (legacy round-trip, empty, byte-identical) |
| Error path | strong | engine | ~90% | baseline | 87 files (fail-closed / reject / guard) |
| Visual regression | dormant | coord-ui | 0% active | baseline | a11y-policy adapter (COORD-134) exists but `skip` — no visual baselines wired |
| Accessibility | dormant | coord-ui | 0% active | baseline | adapter `skip` (no axe/pa11y); engine is CLI (N/A) — gap is coord-ui only |
| Offline/degraded | n/a (engine) | coord-ui | — | baseline | not relevant to the CLI engine; coord-ui has none |
| Permission | strong | engine | ~85% | baseline | 45 files (ENT-012 RBAC, ownership guard, redaction) |
| Performance | partial/dormant | engine + ui | ~30% | baseline | 23 files (timeout-bounding); perf-budget adapter (COORD-135) `skip` (no size-limit/LH/k6) |
| Correctness (mutation) | **ACTIVE** (coord/engine/scripts/journal.js) | engine | **65.25%** (coord/engine/scripts/journal.js) | ↑ +18.69 | COORD-131 adapter ACTIVATED: Stryker wired (devDep + `coord/stryker.conf.json`) on the highest-value core module `coord/engine/scripts/journal.js` (hash-chain integrity). COORD-244 first scored baseline **47.72%**; COORD-245 hardened `journal.test.js` against the survived mutants → **65.25%** (939/1439 killed, 500 survived, 0 no-coverage) via `npm run mutation`, now ABOVE the GATE_MUTATION_MIN=60 break threshold (dimension flips fail→pass). Tests-only hardening pinned exact canonical serialization+hash values, chain-verification fail-closed reasons/fields, prev_event_hash stamping order, the append-time tip re-read, the legacy/chained boundary, and the exact text of every fail-closed message. Target set EXPANDS over time (plan-records.js, governance-validation.js next). |

## Gap Backlog

| Rank | Module / Area | Dimension | Risk | Ticket |
|------|---------------|-----------|------|--------|
| 1 | `coord/scripts` (engine) | Correctness (mutation) | ACTIVE — coord/engine/scripts/journal.js scored **65.25%** (500 survived); ABOVE the 60 gate min after COORD-245 hardening. Expand target set (plan-records.js, governance-validation.js) to grow coverage of the engine | **COORD-244** (DONE — Stryker activated on journal.js) → **COORD-245** (DONE — hardened journal.test.js: 47.72%→65.25%, dimension flips fail→pass) |
| 2 | `frontend/apps/coord-ui` | Accessibility + Visual | MED | activate COORD-134 (axe/pa11y + snapshot baseline) |
| 3 | self / this loop | Process | MED — TEST_MATURITY never auto-refreshes | **COORD-243** (doctor staleness + rollup) |
| 4 | FE↔BE boundary | Contract | MED (low until repos are real) | COORD-082 follow-up when FE/BE become real repos |
| 5 | `coord/scripts` + ui | Performance budgets | LOW-MED | activate COORD-135 (size-limit/LH/k6) |
| 6 | `coord/scripts` | Supply chain / SAST | LOW-MED | activate COORD-132 / COORD-133 (Semgrep / Trivy) |

> Note (first run): the six COORD-131..137 dimensions are **plumbed and graceful-skip
> verified**, but catch nothing until a real tool is configured per repo. Closing the
> backlog above is mostly *activation* (wire one tool), not *building* — the adapters
> already exist. Gap items are tracked here rather than spawned as board tickets, to
> avoid board churn; promote a row to a ticket when you commit to activating it.

## History

| Date | Score | Tickets Since Last | Top Gap Closed |
|------|-------|--------------------|----------------|
| 2026-06-24 | 68 | first run (~225 tickets of prior history) | — (baseline established; the loop itself was the top gap → COORD-243 filed) |
| 2026-06-24 | 68 | COORD-244 | mutation dimension activated on `scripts/journal.js`, score 47.72% (664 survived mutants) — gap backlog #1 dormant→ACTIVE; COORD-131 adapter flipped skip→scoring |
| 2026-06-24 | 68 | COORD-245 | `journal.js` mutation score hardened 47.72%→**65.25%** (500 survived) — now ABOVE the GATE_MUTATION_MIN=60 break threshold, so the correctness dimension flips fail→pass on the engine's highest-risk module. Tests-only: pinned exact serialization/hash, chain fail-closed reasons/fields, prev_event_hash linkage, append-time tip re-read, legacy/chained boundary. |
| 2026-06-25 | rollup | 5 | auto coverage-rollup: gate-health: 20/826 review cycles failing (fail_rate=0.0242), 7 recovery events; coverage pass lowest=90.91 |
| 2026-06-27 | rollup | 82 | auto coverage-rollup: gate-health: 35/1072 review cycles failing (fail_rate=0.0326), 14 recovery events; coverage pass lowest=90.91 |
| 2026-09-21 | rollup | 301 | auto coverage-rollup: gate-health: 61/2084 review cycles failing (fail_rate=0.0293), 106 recovery events; coverage pass lowest=90.91 |
| 2026-09-28 | rollup | 50 | auto coverage-rollup: gate-health: 61/2284 review cycles failing (fail_rate=0.0267), 123 recovery events; coverage pass lowest=90.91 |
| 2026-11-12 | new baseline | — | Test-strategy audit (12-dimension set): code-test 62/100, docs 19/35 verified; not comparable to the 68/100 of 2026-06-24 (see below) |

## 2026-11-12 Baseline (new 12-dimension set; NOT comparable to 68/100)

Source: section 7 of the 2026-11-12 test-strategy audit, run read-only on revision 769bb3d6 (gate baseline d393ce45). The dimension set and method changed, so the earlier 68/100 cannot be compared with this number. Treat this as a new baseline; future trends are measured from here.

- **Overall (code-test dimensions): 62/100.** Mean of the 11 code dimensions over 9 assessed subsystems; covered = 1, partial = 0.5.
- **Documentation adequacy: 19 verified / 35 required** (54%). 5 partial, 4 missing, 4 incorrect (3 safety-relevant), 3 unassessed (DCO enforcement, npm registry fetch, security-report channels; each needs an external service).

| Dimension | Covered / required subsystems | Pct |
|-----------|-------------------------------|-----|
| Unit | 9 / 9 | 100% |
| Contract | 8 / 9 (B, H partial) | 89% |
| Integration | 7.5 / 9 (G, H, I partial) | 83% |
| State | 7.5 / 9 (B, D, H partial: no multi-process same-owner or transition races) | 83% |
| Edge case | 8 / 9 (A, B partial: clock skew) | 89% |
| Error path | 6.5 / 9 (A, C, D, E, H partial: no real-kill or hook-crash tests) | 72% |
| Visual regression | 0 / 1 (coord-ui) | 0% |
| Accessibility | 0 / 1 (coord-ui: one aria-label string check only) | 0% |
| Offline/degraded | 3.5 / 5 | 70% |
| Permission | 7.5 / 9 (E bypasses, H middleware, I matrix) | 83% |
| Performance | 1 / 7 (only shard balancing and one UI parse budget) | 14% |
| Documentation adequacy | 19 verified / 35 required | 54% |

Open items from the audit: the `--snapshot-restore` and `takeover` documentation was corrected under COORD-965. The dangling affected-target example reference in `coord/product/TESTING_AND_GATES.md` is owned by COORD-947 and remains open. The S3 coord-ui loopback exposure is tracked under COORD-940. The gate is red on dev (COORD-946).
