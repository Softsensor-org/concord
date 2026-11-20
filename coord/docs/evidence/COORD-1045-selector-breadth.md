# COORD-1045 evidence: affected-selector breadth and the COORD-953 dynamic-load rule

Status: evidence only. Human-admin decision, 2026-11-16 (relayed by the orchestrator): close
COORD-1045 and keep the current COORD-953 rule. No selector code changed by this ticket.

Scope of the measurement: the in-repo selector (`coord/engine/scripts/affected-selector.js`,
`affected-graph.js`) run on each ADR 0025 content commit against its parent. Method is the one
ADR 0025 uses: selected suites over the suite total. All five commits are T2 fallbacks
(`decision: full`), so the figures are the selected-set breadth, not the gate decision.

## 1. Breadth table

| Ticket (commit) | Dev 66604ad1 (before COORD-1031 landed) | Dev 645f617d (current dev) | Dev 645f617d, COORD-953 widening removed (upper bound) |
|---|---|---|---|
| COORD-947 (2e42c8da) | 260/389 (66.8%) | 265/389 (68.1%) | 243/389 (62.5%) |
| COORD-948 (1ac3b319) | 259/391 (66.2%) | 264/391 (67.5%) | 242/391 (61.9%) |
| COORD-950 (6cb14e4f) | 258/390 (66.2%) | 263/390 (67.4%) | 241/390 (61.8%) |
| COORD-968 (cf50c498) | 266/391 (68.0%) | 271/391 (69.3%) | 249/391 (63.7%) |
| COORD-969 (382d8cd2) | 260/392 (66.3%) | 265/392 (67.6%) | 243/392 (62.0%) |

- The 66604ad1 column reproduces the "after" column of ADR 0025 exactly. The COORD-1031 landing
  (PR #403, which adds the CLI-verb edges of `affected-cli-verbs.js`) raises breadth by about
  1.3 points on every commit.
- Target of the ticket (under 50%) is met in no column. The lowest measured figure is 61.8%.

## 2. Where the breadth comes from

- Unresolved dynamic loads (COORD-953 widening) account for about 256 suites of the selection
  on each commit. The 302 non-config dynamic sites sit in 111 files; about 17 of them are
  non-suite modules that other engine modules depend on, and they widen their readers.
- Removing that widening entirely (upper-bound column) still leaves 241 to 249 suites selected.
  Declaring dynamic loads cannot take breadth under 50%: the ceiling from that rule alone is
  about 62% on this tree.
- The remaining reach is static and mention edges through hub modules. Each of these changed
  files on the five commits reaches about 233 suites on its own:
  - `coord/engine/scripts/journal.js` (2cb: COORD-950, governance-side-effects.js with it)
  - `coord/engine/scripts/hooks/hook-lib.js` (COORD-948, COORD-969)
  - `coord/engine/scripts/gate-plan.js` (COORD-947)
  - `coord/engine/scripts/quality-scan.js` (COORD-947)
  - `coord/engine/scripts/doctor-report.js` (COORD-947)
  - `coord/engine/governance-guards.json` (COORD-948, COORD-969; T2 surface)
- Generated and governed files (`coord/TEMPLATE_SYNC_MANIFEST.json`, `coord/engine-pin.json`,
  `release/suite-inventory.json`) select only their checker suites by the generated-file rules,
  so they are not the source of the breadth.
- The mention edges through these modules are required by the COORD-953 soundness oracle
  (ADR 0025, Alternatives Rejected). Cutting them is out of scope for this ticket.

## 3. COORD-963 seeded check

Scratch tree: commit `7e08e065` plus the 19 surface files of `98579833` (COORD-963, wip-cap
retirement). The scratch commit is dangling (no branch). Result on the current dev selector:

- `missing-ticket-lock.test.js` IS selected (310 of 432 suites), via static reach to
  `ticket-transitions.js`, `followups.js`, `doctor-report.js` and `lifecycle-lock-commands.js`.
- With the COORD-953 widening removed (upper bound), it is still selected (291 of 432), through
  the same static edges. The COORD-963 regression is therefore caught without the widening.

## 4. Observation: unknown dynamic sites in `__fixtures__/`

An unresolved dynamic site inside a `__fixtures__/` directory (for example the generators in
`coord/engine/scripts/__fixtures__/`) forces a `dynamic_dependency` full fallback for every change
to any sibling file in that directory. On the COORD-963 scratch tree this fires on
`coord/engine/scripts/__fixtures__/wip-cap-golden.json`. The fallback makes the change a full gate
even when the selection is otherwise narrow. Recorded for a later ticket; this ticket makes no
change to it.

## 5. Decision and disposition

- Human-admin decision, 2026-11-16: keep the current COORD-953 rule.
- Per-PR gating uses the direct-impact radius (`radius.sh`, Node 22), per the 2026-11-12 ruling.
- The 70% radius trigger (ADR 0025) stays report-only. No gate-plan enforcement is added.
- Acceptance items of COORD-1045 are not implemented, superseded by the decision above:
  (1) declared dynamic-load map; (2) test on undeclared dynamic loads; (3) undeclared-only
  always-selection; (4) breadth under 50% with the COORD-963 check; (5) trigger enforcement in
  gate-plan. Item (4) is shown unreachable by item (1) to (3) alone (section 2, upper bound).
