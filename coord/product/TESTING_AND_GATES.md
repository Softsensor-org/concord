# Testing and Gate Policy

This document defines what good testing looks like in a project created from
this template. It is the policy layer that governance uses when deciding which
checks are required before `doing -> review` and before `review -> done`.

References below to release scripts and upstream CI workflows describe the
source repository that produces the release. Those tools and donor ticket
fixtures are intentionally omitted from public cuts; installed engine checks
remain available in the cut.

This file is intentionally distinct from:

- `/test-strategy`, which audits an instantiated codebase and recommends gaps
- [`coord/product/POLICY_ENFORCEMENT_MATRIX.md`](./POLICY_ENFORCEMENT_MATRIX.md),
  which records which gate policies are enforced, warning-first, advisory, or planned
- [`coord/TEST_MATURITY.md`](../TEST_MATURITY.md), which records the observed
  maturity snapshot over time
- [`coord/product/BOOTSTRAP_CONTRACT.md`](./BOOTSTRAP_CONTRACT.md), which
  defines the required per-repo gate runner interface
- [`coord/product/LOCAL_AUTOMATION_AND_GATES.md`](./LOCAL_AUTOMATION_AND_GATES.md),
  which explains how the gate runners are invoked

## Purpose

Derived projects should not treat testing as a single percentage target or a
single runner command. The governed question is:

- what risk does this change introduce
- which testing dimensions cover that risk
- which gate lane is proportionate for this ticket

The goal is not maximal test volume. The goal is repeatable confidence that the
change did not silently break the project along the dimensions the change
actually touches.

## Testing Philosophy

Projects instantiated from this template should follow these rules:

- prefer the cheapest test that can credibly detect the failure
- escalate to heavier tests only when lighter tests stop being trustworthy
- keep the link between risk, test evidence, and gate selection explicit in the
  ticket plan record
- treat testing debt as governed work, not as a hidden narrative note
- keep policy here generic and durable; put stack-specific commands and runner
  details in repo-local automation docs
- use `gov publishability-check <ticket>` when a ticket touches canonical,
  release, engine, or public documentation surfaces so closeout catches
  publishability work before the release pipeline does

The maturity dimensions tracked by [`coord/TEST_MATURITY.md`](../TEST_MATURITY.md)
are the default vocabulary for coverage decisions:

- Unit
- Contract
- Integration
- State
- Edge case
- Error path
- Visual regression
- Accessibility
- Offline/degraded
- Permission
- Performance
- Documentation adequacy

A ticket does not need evidence in every dimension. It needs evidence in the
dimensions its risk profile makes credible.

## Documentation Adequacy in Maturity Assessments

Testing-maturity audits must assess whether required documentation is accurate, complete for its intended audience, and usable against the assessed revision. Include architecture and interface explanations, setup and contributor workflows, user and operator procedures, failure and recovery behavior, requirements traceability, and document ownership and freshness.

Use source review for architectural claims and isolated procedure exercises for executable instructions. Record the document section, assessed revision, date, verification method, expected and observed outcomes, and evidence location. Presence, length, and working links alone are insufficient. Classify each required item as verified, partial, missing, incorrect, or unassessed; justify exclusions. Report verified items against the full required denominator and expose unassessed items. Do not treat unassessed documentation as passing or let strong code-test results conceal incorrect safety-critical guidance.

The test-strategy audit owns this assessment. Coverage-rollup may preserve it but must not infer documentation verification from coverage or gate-health signals. A changed dimension set requires an explicit scoring baseline before historical overall scores are compared. This assessment requirement does not claim a new automated closeout gate exists.

## Choosing Dimensions by Risk

Use the smallest set of dimensions that closes the real risk:

- choose **Unit** when the change is local logic with stable seams and the
  behavior can be proven without real infrastructure
- choose **Integration** when correctness depends on real wiring between
  modules, storage, queues, framework hooks, or runner configuration
- choose **Contract** when the change affects an API, schema, event payload,
  shared interface, or a cross-repo expectation that another component consumes
- choose **State** when correctness depends on lifecycle transitions, recovery,
  locking, caching, persistence, or replay of prior state
- choose **Permission** when behavior changes by role, identity, tenant, or
  auth context
- choose **Error path** and **Edge case** when the risky failure is not the
  happy path but malformed input, partial failure, empty state, retry, or
  bounded exhaustion
- choose **Visual regression** and **Accessibility** when the user-facing
  outcome is layout, semantics, navigation, or assistive-technology behavior
- choose **Offline/degraded** when the system must remain safe during network
  loss, dependency failure, or partial-service mode
- choose **Performance** when the ticket changes complexity, query shape,
  rendering volume, background cadence, or a hot path
  - for backfill, generated-data, or derived-data jobs, output-correctness tests
    are **not enough**: the query shape and the data volume must also be proven.
    Apply the [Backfill Query and Volume Safety Checklist](./SERVER_BOOTSTRAP_JOB_CONTRACT.md#backfill-query-and-volume-safety-checklist)
    (row-count estimate, batch size, streaming/pagination, blob-column access,
    DB pool impact, timeout/memory envelope, checkpoint interval, production-scale
    query-shape proof).

Do not add a dimension because it sounds thorough. Add it because the ticket
can fail there.

## Escalation: Unit vs Integration vs Contract

The normal escalation path is:

1. Start with unit evidence when the behavior is isolated and deterministic.
2. Escalate to integration evidence when mocks would hide the actual risk.
3. Escalate to contract evidence when another repo, service, or tool depends on
   the exact shape of the output.

Use these escalation rules:

- stay at **Unit** if the ticket changes pure logic, formatting, branching, or
  small helper behavior and the surrounding seams are already trusted
- move to **Integration** when the ticket changes persistence, orchestration,
  process boundaries, filesystem state, framework lifecycle, or multi-module
  coordination
- move to **Contract** when a consumer outside the edited module must continue
  to understand the same route, payload, schema, or artifact layout
- use **Unit + Integration** together when unit tests prove branches and
  integration tests prove the wiring
- use **Integration + Contract** together when the risk is both real system
  wiring and consumer-visible interface stability

When the system cannot support the needed heavier test yet, that is not an
excuse to omit the risk. It becomes explicit test debt that must be tracked.

## Test Ticket Sizing

Testing work should be sized like any other governed work:

- bundle test changes into the feature ticket when they are required evidence
  for the same behavior and keep the diff understandable
- split into a dedicated test or gate ticket when the work changes harnesses,
  shared fixtures, runners, contracts, or cross-module coverage strategy
- split when the test work is materially larger than the feature change
- split when the feature must land with a clearly recorded deferred test gap
- keep one ticket focused on one proof obligation; avoid “fix everything the
  audit found” tickets unless the work is intentionally infrastructure-wide

As a practical rule:

- feature-local assertions belong with the feature ticket
- shared harness changes belong in testing-infrastructure tickets
- broad backlog discovered by `/test-strategy` belongs in follow-up tickets
  recorded in the maturity tracker and board

## Deferred Failures and Test Debt

Not every missing test should block the current ticket, but no missing test
should disappear into prose.

Use this policy:

- block the current ticket when the missing evidence is required to prove the
  changed behavior is safe enough to review or land
- defer to a follow-up ticket when the missing evidence is real but not needed
  to validate the specific behavior being shipped now
- record deferred test debt explicitly in requirement closure and follow-up
  tracking; do not leave it as an implicit reviewer memory
- treat “test debt” as governed backlog, not as a supersede reason for landed
  work

The superseded `GOV-060` class of issue should be handled this way:

- describe the missing evidence concretely
- state why it is safe to defer for this ticket
- open or point to the follow-up ticket that owns the deferred test work
- let the maturity tracker surface the unresolved gap until it is closed

## Relationship to `/test-strategy` and `TEST_MATURITY.md`

The roles are different:

- this file says what good testing policy looks like
- `/test-strategy` inspects a concrete codebase and proposes coverage moves
- [`coord/TEST_MATURITY.md`](../TEST_MATURITY.md) records the current measured
  state, not the desired policy

Expected workflow:

1. Use this policy to decide which dimensions matter for the ticket.
2. Use `/test-strategy` when the repo needs an audit or when the right testing
   dimension is unclear.
3. Use `coord/TEST_MATURITY.md` to track whether the project is actually closing
   the gaps over time.
4. Open explicit tickets when the audit discovers material missing coverage or
   infrastructure work.

This separation prevents canonical drift:

- policy stays here
- audit method stays in `/test-strategy`
- measured snapshot stays in `TEST_MATURITY.md`

## Coverage-maturity refresh cadence (COORD-243)

The coverage **gate** (QGATE-003) and the COORD-126 ratchet run per-commit, and
`gov insights` auto-aggregates gate/recovery health — but the coverage-**maturity**
analysis in `TEST_MATURITY.md` does not refresh itself on a commit. COORD-243 wires
that refresh as three layers separated by cost profile, so heavy work never lands in
`gov doctor`:

| Layer | Where | Cost | What it does |
|-------|-------|------|--------------|
| **DETECT** | `gov doctor` (`coverage-maturity.detectMaturityStalenessFromDisk`) | sub-second, READ-ONLY | Flags `TEST_MATURITY.md` as stale by TIME (>14 days since `Last updated`) OR ACTIVITY (>25 tickets landed since), and surfaces a "dimension below threshold" line from recorded coverage/mutation gate signals. Emits ONE warning line per condition. **Never runs a tool, never writes a file.** |
| **DO** | `gov coverage-rollup` (`coverage-maturity.rollup`) | minutes-scale | Reads the real per-commit coverage gate signals (QGATE-003, recorded in plan records) + the `gov insights` gate/recovery health rollup and rewrites `TEST_MATURITY.md`'s `Last updated`, the gate-health-derived rows, and a History entry. **Writes the artifact** (that is its job). Idempotent: re-running on unchanged inputs is a no-op. `--dry-run` computes without writing. |
| **TRIGGER** | `coord/engine/scripts/coverage-rollup-cron.js` | thin | A single-shot runner the cadence owner invokes; it just calls the DO verb once. Because DO is idempotent, over-running is harmless. |

Design rule: **doctor DETECTS, a verb DOES, a scheduler decides WHEN.**

Wiring the TRIGGER (pick one per deployment — the runner is wired, the cadence is a
documented choice):

- **crontab** (e.g. weekly): `0 6 * * 1  cd <repo> && node coord/engine/scripts/coverage-rollup-cron.js`
- **post-landing hook**: invoke `node coord/engine/scripts/coverage-rollup-cron.js` after a
  `gov finalize` batch, then commit the refreshed file through the governed sync lane.
- **CI nightly**: a scheduled job that runs the runner and commits the result.

The refreshed `TEST_MATURITY.md` must still be committed through the governed lane —
the cron runner produces the artifact; it does not bypass single-writer governance.

## Gate Lane Policy

The accepted **executable** lane vocabulary — the names accepted by `gov gate
--lane`, implemented by every repo's `scripts/gate.sh`, and exercised by CI — is
`default | full | ci`. It is single-sourced in
`coord/engine/scripts/governance-constants.js` (`GATE_LANES`) so governance validation,
the template runners, and CI cannot drift (COORD-075 / QGATE-001).

## Affected-Target Gate Selection

Large agent fleets should not pay for full-suite validation when the affected
surface is narrow and the dependency map is known. Concord supports a
deterministic affected-target selector:

```bash
node coord/engine/scripts/gate-plan.js COORD-947 --files coord/engine/scripts/gate-plan.js --json
```

Engine changes (repo X, `coord/`) are selected by one selector: gate-plan calls the
COORD-924 module-graph selector (`affected-selector.js` over `affected-graph.js`), the
same code path `gov test-policy resolve --stage pr` uses. No engine map is read, so none
can go stale. Unknown or unattributable files, incomplete analysis and T2 surfaces fall
back to the full gate. `coord/engine/gates/affected-targets.json` and its legacy copy
`coord/gates/affected-targets.json` are DEPRECATED for engine selection. They are kept
byte-identical for upgrade compatibility (COORD-884 pins their hashes in `coord-upgrade.js`).
`coord/engine/scripts/affected-parity.test.js` checks that gate-plan's engine selection
equals the selector's own output over fixtures (changed suite, changed module, deleted,
unknown, T2).

Product repositories keep a hand-written dependency map: `testPolicy.repoMaps.<code>` in
`coord/project.config.js`, or an explicit `gate-plan --map <file>`. A map must have a
current `updated_at` and list only files that exist. The quality scan
(`coord/engine/scripts/quality-scan.js`, scanner `affected-map`) reports a product map that
is stale (older than 90 days) or dangling (a target file is missing). `planTickets` files
one governed ticket to refresh it, deduplicated by its `[qkey:]` marker while the ticket is
open. `gov doctor` surfaces the same finding as a warning, from a cheap check that reads the
config and tests existence (no graph walk, no regeneration).

Policy:

- affected-target selection is an optimization, not a weakening of the gate;
- the selector must log selected targets, skipped targets, changed files,
  coverage mode, and fallback reason;
- unknown changed files, missing dependency maps, empty maps, or `--full` must
  select the full gate;
- selected slices may be used as `default` ticket evidence only when the map is
  current enough for the changed surface;
- `full` and `ci` lanes remain the authoritative fallback for release,
  dependency-graph uncertainty, or suspected semantic conflicts.

Migration note (COORD-936): the affected-target map is no longer a second
selector for engine code. For the engine, COORD-924's module-graph selector is
the one selector. A map in this format stays useful as a **product repository's
dependency map**: put it in `testPolicy.repoMaps.<repo code>` (see "Stage-Aware
Test Policy" below) and the one resolver uses it to select that repository's
checks. `gate-plan` keeps reading `--map` for its ticket receipts as before.

### Risk-based affected-test selection (COORD-924)

ADR 0021 tiers ceremony by risk. Under COORD-941 the existing COORD-936
stage-aware policy and COORD-924 selector are active for eligible T0/T1
landing evidence. The human-admin ruling was recorded by `gov amend-ticket
COORD-941` at `2026-11-06T20:54:10.266Z` (snapshot
`33304d5a58e60903cab044ec2ea83f09e0e5b3ed`): adopt the adaptive-testing path,
stop the in-progress C1 gate, and bootstrap with focused behavioral and
integration checks while preserving full-suite plus ratchet qualification for
promotion and normal high-risk/unknown fallbacks. This bootstrap direction is
not a permanent waiver. First-week measurements are pending until observed.
The policy lives in `coord/engine/test-policy.json` (`policy_version` 2,
`initial_state` `active`); the former
`coord/engine/affected-selection-policy.json` was migrated into its `selection`
section by COORD-936. The tool is `coord/engine/scripts/affected-evaluation.js`.

- **Selection** (`select --base <ref> [--head <ref>]`): a changed suite selects
  itself; other changed files select the suites that reach them in the module
  graph (`affected-graph.js`: static requires and imports, `resolveEngineModule`
  shim resolution, and path or file-name mentions in code, strings and shell
  scripts), in the head tree and, for deleted and renamed paths, the base tree;
  generated files select the suites that check them.
- **Tier:** T2 when a changed file is a T2 guard implementation in the COORD-914
  registry or a T2 policy path; T0 for suites, fixtures and docs only; T1
  otherwise.
- **The full gate is required, with a stated reason,** for T2, any
  always_enforced guard's implementation file, unknown dependents, an unknown
  dynamic load whose directory holds the file, incomplete analysis, dependency
  and lock files, config seams, coverage baselines, generated files no rule
  attributes, and changes to the selector or its policy.
- **T0 and T1 landings, once selection is active,** may use eligible fresh
  developer/PR policy evidence, which runs the selected suites plus
  `always_required_suites` and every configured mandatory check. Use
  `gov test-policy run --stage pr --base <ref> --out <dir>` and pass its
  `test-policy.manifest.json` to the landing verifier. The older
  `affected-evaluation.js run-selected` command does not run adopter or policy
  mandatory checks and is refused as landing evidence while the active
  stage-aware policy is enabled. Setting the policy state to `shadow` restores
  the full-gate rollback behavior.
  `gov add-repo-gate <ticket>
  --selection-manifest <dir>/test-policy.manifest.json --base <ref>` accepts it
  as the repo gate only when the manifest shows the exact tree and base
  (`check-reuse` at landing scope), the current policy version and selector, a
  pass, and every required suite; it refuses otherwise, and the full gate is
  recorded with `--command` as before. `gov gate-plan <ticket> --base <ref>`
  names the required landing gate in the receipt; in shadow it is `full`,
  and `would_gate`/`would_suites` record the selected plan for diagnosis.
- **Governed, shared state:** the activation state and the per-category
  suspensions live on the canonical board (`metadata.affected_selection` in
  `tasks.json`) and change only through `gov selection suspend|resolve|nightly`,
  each one journaled governance mutation. Every clone and session that reads
  the board sees the same state; a missing or unreadable board fails closed to full.
- **Evidence loop:** `gov selection nightly --full-report <report> --base <ref>`
  takes a full serial gate report of the same tree (nightly, release
  candidate), records what selection would have run and whether it would have
  caught every failure (failures are attributed to suites through
  `release/suite-inventory.json`; an unattributable failure counts as missed),
  journals every miss as a suspension of its change categories, and lists it in
  `refinement-report.md`. Scheduling is install configuration
  (`coord/product/INSTALLATION_RUNTIME.md`). The local `compare-full` and
  `shadow` commands report misses and exit non-zero without changing state.
- **Suspension:** `gov selection suspend --ref <ticket> [--category <c>]` for a
  miss found later (without a category everything is suspended). `gov selection
  resolve --category <c> --investigation <ref>` lifts it only under a higher
  `policy_version`, that is, after the criteria were tightened.
- **Re-check at closeout:** move-review, finalize and land re-validate every
  recorded `affected-selection run` repo gate at the reviewed head (the
  workspace HEAD at move-review): the recorded manifest, `check-reuse` for the
  head's tree and the recorded base, the policy version and selector, and the
  governed state. Code changed after the selected run, a newly suspended
  category or a policy change blocks the closeout until the gate is re-run.
- **Post-activation review criteria:** `evaluate` writes the evaluation report
  (fault suite, counted runs, categories, editions, Node lanes). These criteria
  inform monitoring and refinement after COORD-941 activation; reaching a run
  count is not an activation prerequisite or an automatic state change.
- **Fault suite** (`faults`): seeded faults in a temp repository and historical
  regressions (COORD-893 caught by COORD-689, COORD-871..888 finer arms,
  COORD-916, COORD-902 vs COORD-890) must each be selected or force the full gate.
- **Fail closed:** an unreadable board or an unknown state reads as shadow
  (every gate full). The local evaluation log (comparisons, evaluation report)
  lives in `coord/artifacts/affected-selection/` of the checkout that runs it.

### Stage-Aware Test Policy (COORD-936)

**Operating mode: activated by COORD-941.** Developer and PR checks use fresh
blast-radius selection and mandatory guards; eligible T0/T1 manifests can be
recorded as landing evidence by the existing verifier. Nightly is a conditional
cumulative full qualification, and promotion remains full-suite plus coverage
ratchet on the exact candidate. T2, unknown/incomplete impact, policy/selector
changes, and suspended categories fall back to full. Rollback is one policy
change: restore `operating_mode.landing_gates` to `unchanged` and
`selection.initial_state` to `shadow`. First-week observations remain pending
until actual runs have been collected. Exception-bearing policy runs are refused
as landing evidence until the ticket-bound exception is revalidated by the
landing verifier; the standard fresh policy run remains the landing receipt.

**Activation bootstrap evidence (2026-11-06).** Focused behavioral checks for
landing selection, policy resolution, scheduling, run manifests and promotion
qualification passed 33/33 on Node 22.8.0 and 33/33 on Node 24.22.1; no full gate
was run for activation. The earlier C1 gate 2 ratchet failed and its dual-release
run was interrupted after the secret scanner stalled; C1 gate 3 was stopped by
human instruction before a result. Those runs do not count as successful full
qualification. First-week measurements are pending and must be reported from
actual run manifests and schedule decisions.

**One selector, one policy, one runner.**

- The selector is COORD-924's (`affected-selector.js`), accepted by the governed
  landing verifier only when manifest and board-state checks pass.
- The policy is `coord/engine/test-policy.json`.
- The runner is `coord/scripts/test-runner.js`, driven by `gov test-policy run`.
- Local commands and CI call the same verb:

```bash
coord/scripts/gov test-policy resolve --stage pr --base origin/dev      # what would run, and why
coord/scripts/gov test-policy run --stage pr --base origin/dev          # run it, fresh
coord/scripts/gov test-policy run --stage nightly                       # the conditional scheduled full run (runs or skips, and says why)
coord/scripts/gov test-policy run --stage production                    # promotion: full qualification plus smoke
coord/scripts/gov test-policy compare --full-report <full report> --base <ref>   # shadow comparison
```

**Stages.** The policy has four base stages:

- `developer` and `pr` run the affected checks plus the mandatory guards: the
  would-be selection, the always-required suites and, for an ordinary document,
  the documentation checks.
- When a pinned file changes (any path in `coord/engine-pin.json`), developer
  and pr also run the pinned-file checks: the suites that verify the live tree
  against the engine pin and the template-sync manifest. This is a content-hash
  dependency the module graph cannot see. It was added from the pilot's own
  comparison, where a miss became a dependency-map correction.
- Coverage at `developer` and `pr` is **advisory**. The whole-suite ratchet is
  never applied to a partial run (the runner refuses `--engine-coverage` with
  `--file`). Teams may require more through policy.
- Before executing coverage suites, the runner requires 8 GiB available on each
  scratch filesystem for serial, shard-child and changed-since advisory runs,
  or 32 GiB for the sharded parent. The runner checks its temporary and report
  directories and any configured diagnostic or census output. Sharded runs
  create worker scratch alongside the report. Set `COORD_COVERAGE_MIN_FREE_GIB` to a positive
  integer to override the minimum per filesystem. The check refuses to start if
  space is insufficient or cannot be measured.
- `nightly` is the **conditional** scheduled full run, carrying the
  authoritative coverage ratchet:
  - When the install's scheduler invokes it, it compares the head with the last
    **successful** full run, examining the cumulative change rather than the
    latest commit.
  - It skips an unchanged tree and ordinary docs-only changes.
  - It runs when there is no previous success, or when a significance trigger
    fires: a T2 change, unknown impact, a shared library, at least
    `min_affected_suites` affected suites (25), or an unqualified change older
    than `max_unqualified_hours` (24). Commit count is never a trigger.
  - Every decision is recorded with its reason in
    `coord/.runtime/test-policy/schedule-decisions.ndjson`.
  - Only a passing qualifying run advances `last-qualified.json`. A failed,
    interrupted or skipped run never does, and a skip is recorded as
    `skipped`, never as a pass.
  - Teams tune `testPolicy.stages.nightly.triggers`.
- `promotion` (to staging, beta, production or release) **always** runs the
  full suite and the coverage ratchet on the exact candidate, plus the target
  environment's smoke checks:
  - A promotion of engine code fails if the full suite did not run, if the
    ratchet did not pass or was not measured, or if the candidate has
    uncommitted changes (guard `test-policy-qualification`).
  - No exception can reduce it, and no scheduled skip record counts as
    evidence.

The environment stages `staging`, `beta`, `production` and `release` map to
`promotion`. Branches map to nothing by default: `main` does not mean the
scheduled run. Branch promotion is separate from scheduled execution, and
teams map branches and their own stages in `testPolicy.stageMap`. Engine code
holds no adopter stage, command or host.

**The coverage trade-off, accepted explicitly.** A selected pr run can miss a
whole-suite coverage regression. The conditional scheduled full run detects
it, promotion prevents it from advancing, and high-risk or unknown-impact
changes still get the full gate at pr.

**Blast radius.** Selection follows the changed paths, their mapped transitive
consumers, the risk and the delivery stage:

- An ordinary document runs the documentation checks.
- Executable examples, policy documents and generated configuration select the
  suites that consume them, through the module graph and the generated-file
  rules.
- A T2 change (high risk) runs the full suite at developer and pr.
- Unknown impact also runs the full suite at pr: unknown dependents, dynamic
  loads, incomplete analysis or a selection fallback.
- `--trigger urgent-release` runs the full qualification at any stage.

**Engine and product stay apart.** The scope of a change decides which checks
can run:

- `engine`: an engine change in the engine's own repository.
- `product`: a product repository. Its checks are the targets its dependency
  map selects (affected-targets format, with transitive `depends_on`
  consumers), or else its `testCommand`. A product change never runs the
  Concord engine suite. A stale or invalid map, an unmapped path or an empty
  change runs that repository's full checks.
- `engine-upgrade`: engine files changed in an installed workspace. These run
  `gov verify-engine` against the pinned release, not the engine suite.
- `workspace`: coordination files. These run adopter checks only.

**Fresh runs.** Every selected check runs fresh, with a hard timeout
(`execution.timeout_seconds`).

- `--history <previous test-policy-report.json>` only orders the checks:
  previously failed first, then faster ones. It never removes a check and
  never credits an earlier pass.
- A failed suite or command is re-run once, only to classify it as `consistent`
  or `flaky`. The run still fails. A completed coverage-ratchet failure with
  no named failing tests is deterministic and is not retried; when the report
  also names failing tests, their suites are re-run only to classify those test
  failures.
- The results are a COORD-910 run manifest, `test-policy.manifest.json`, whose
  `inputs.gate_config.test_policy` records the stage, decision, policy digest,
  order and execution label. Beside it, `test-policy-report.json` holds the
  metrics.

**Adopter configuration.** Adopters configure the policy in the `testPolicy`
block of `coord/project.config.js`, the project-owned seam:

```js
testPolicy: {
  stageMap: { qa: "promotion", main: "nightly" },
  stages: {
    pr: { checks: [{ id: "lint", command: "npm run lint", scope: "product" }] },
    production: { smoke: [{ id: "prod-health", command: "./scripts/smoke.sh production" }] },
  },
  repoMaps: { A: { updated_at: "2026-11-06", full_gate: { commands: ["npm test"] }, targets: [ /* id, files, command, depends_on */ ] } },
  execution: { timeout_seconds: 1800 },
}
```

The engine-owned keys are refused: `operating_mode`, `selection`,
`engine_paths`, `checks` and `scopes`. Replacing or removing an engine check is
also refused. An invalid override is not applied; its errors are printed.
Because the override carries commands, it is read only from the coordination
workspace's own configuration, never from an incoming change.

**Human exceptions (item 8).** Selection is automatic: agents resolve and run
checks with no approval prompt. As an exception, an authorized human may ADD
checks or REDUCE the selected scope. These are distinct records:

```bash
coord/scripts/gov test-policy except --ticket <id> --base <ref> --add "perf=npm run perf" --human-admin-override "<reason>"
coord/scripts/gov test-policy except --ticket <id> --base <ref> --reduce <suite|check id> --human-admin-override "<reason>"
coord/scripts/gov test-policy except --ticket <id> --withdraw <exception id> --human-admin-override "<reason>"
```

- **When.** Exceptions are allowed during implementation as well as after
  submit. Before submit, the scope is the working tree: HEAD, its tree and a
  digest that includes the uncommitted changes. After submit, it is the
  immutable submission. Either way the scope digest binds the exception, and
  run manifests reference it (`inputs.gate_config.test_policy.exceptions`).
- **Recording.** Both kinds use the existing human-admin override path. Each
  is one journaled `test-policy-exception` board mutation (in
  `metadata.test_policy_exceptions`), recorded by a bound session. It holds:
  - **scope:** the ticket's immutable submission (the plan record's
    `review_submission`, which is the reviewed head), its tree, the base, the
    changed files and the recommended set;
  - **reason**;
  - **authority:** `human-admin-override` and the session that recorded it.
- **Replanning.** On every later plan of the ticket the exception is
  re-evaluated. Within its scope, both kinds still apply. When the change
  expands (new files, paths outside the bound set, or newly affected
  consumers), a reduction lapses and selection reverts to the policy until it
  is re-authorized; an addition is kept unless withdrawn.
- **Guards.** A ticket exception can never reduce the mandatory guards (the
  policy's always-required suites), and a promotion can never be reduced. Only
  a governed change to the policy itself can change what is mandatory.
- **Labels.** Plans, reports and run manifests label the execution: `policy`,
  or `policy + exception: <kind> <id>, ...`. A lapsed reduction is listed with
  its reason.

**Maturity measurement.** A report shows the selection scope, the fallback
reasons, the feedback time, the flaky failures, the selection misses and the
promotion outcomes. These come from `test-policy-report.json` and from
`gov test-policy compare`, not from test counts or coverage alone.

`compare` records the comparison through COORD-924's `compareFullRun`, which
keeps `would_gate` and `would_suites`. It then classifies each full-run failure
by test identity (suite and title) and reason:

- `caught`;
- `detection-miss`, with the dependency correction it implies (a graph edge,
  or the files of a `repoMaps` target);
- `environmental`: a signal, a killed lane or an infrastructure error;
- `not-reproduced`: the selected run passed it.

Omitted passing suites are reported as skipped work. Nightly misses feed the
dependency-map corrections.

Maturity is demonstrated capability, measured as follows:

| Capability | What to measure |
| --- | --- |
| Repeatable baseline | clean-checkout reproducibility, failure reasons, timeout and interruption rates |
| Scoped feedback | selected versus omitted, unknown-path fallbacks, developer feedback median and p95 |
| Dependency-aware testing | consumer coverage, mapping misses found by the nightly comparison, escaped regressions |
| Promotion qualification | full qualification on actual promotion candidates and its outcomes |
| Continuous improvement | failure-first ordering, duration trend, flaky-test ownership, resolved selection misses |

A check is never narrowed because it has passed often.

Governance also reasons about an `extended` **policy** concept (deeper /
release-cut coverage). `extended` is *not* an accepted `--lane` value and is not
a `scripts/gate.sh` case: a project folds that coverage into its `ci` (or
`full`) lane. The lanes below are described as policy intent:

### `default`

Use before every `doing -> review` transition.

The `default` lane should answer:

- did the edited behavior pass the smallest credible set of checks
- are the tests fast enough to run on every review handoff
- is the ticket ready for a reviewer to trust the claimed scope

`default` is the minimum blocking lane for routine ticket progression.

### `full`

Use before landing, and earlier whenever the change is too risky for `default`
alone.

Typical triggers:

- shared infrastructure or framework changes
- contract surface changes
- permission or state-lifecycle changes
- tickets that touched multiple repos or multiple maturity dimensions
- cases where a reviewer or planner explicitly judged `default` insufficient

`full` is the pre-landing confidence lane.

### `extended` (policy concept, not an accepted `--lane`)

Periodic, release-cut, or intentionally deeper validation. This is not the
every-ticket default, and it is not a separately-invokable lane: there is no
`gate.sh extended` and `gov gate --lane extended` is rejected. Projects realize
this coverage inside their `ci` (or `full`) lane.

Typical triggers:

- release candidate or promotion readiness
- large dependency upgrades
- wide refactors
- flaky-system investigation
- soak, load, visual, or broader scenario sweeps that are too expensive for
  normal ticket cadence

`extended` is where projects put the expensive confidence checks that still
matter, just not on every ticket.

### `ci`

The repo runner contract in [`coord/product/BOOTSTRAP_CONTRACT.md`](./BOOTSTRAP_CONTRACT.md)
requires `scripts/gate.sh <lane>` with `default`, `full`, and `ci`.

For derived projects:

- `ci` is the transport lane exposed to automation, and is a first-class
  accepted `--lane` value (`gov gate --lane ci`, `gate.sh ci`)
- it should map to the project’s chosen CI policy
- it may mirror `default`, mirror `full`, or fold in the deeper `extended`
  policy coverage depending on repo cost and release needs

This document defines the policy expectations. The repo-local runner defines the
exact command mapping.

### Per-PR direct impact, full-suite triggers and promotion gates (COORD-974, ADR 0025)

**Per-PR gate (human-admin ruling 2026-11-12).** A PR into dev runs the impact-radius selection for its
change on Node 22: the direct-impact suites (changed tests, direct requirers, exact-path namers and
regenerated-file checkers, with one transitive hop through production modules). The full suite does not
run on each PR. A T2 change keeps its automatic full fallback at the PR stage, as the tier policy states.

**Full-suite triggers (ADR 0025, accepted 2026-11-15).** The full suite, sharded (`--shards auto`, ADR 0022),
is due when either holds:

- the landed-ticket counter: at least 10 tickets have landed on dev since the last passing full run
  (board `landing_index` entries recorded after `coord/.runtime/test-policy/last-qualified.json`; with no
  recorded full run every landing counts, so the counter reports due);
- the radius threshold: the affected suites exceed 70 percent of the suite total (strictly above; 70.0
  percent does not fire);
- the unknown selector fallback: the selector cannot establish the impact (`dynamic_dependency`,
  `unknown_dependents`, `incomplete_analysis`, `unattributed_generated`). A T2 surface or an always-enforced
  guard is not unknown impact.

`gov test-policy resolve` reports the trigger state on every plan: the counter (landed, threshold),
the radius (affected, total, share, threshold, or not evaluated), and the trigger that fired with its reason.
The thresholds live in `coord/engine/test-policy.json` under `full_suite_triggers`. **The triggers are reported
only.** Acceptance of ADR 0025 does not switch the PR gate, and the resolved decision is unchanged by them;
enforcing them is a separate governed change. The ADR 0025 core-surface clause (a change to the runner, the
selector, the policy, shared fixtures, the journal or the integration-authority core) is not yet a reported
trigger; those changes already fall back to the full gate at the PR stage as T2 surfaces.

**Promotion and nightly.** Promotion (dev to staging and the other delivery environments) always runs the
sharded full suite and the coverage ratchet on the exact clean candidate. Nightly keeps the full dual-lane matrix
and the coverage ratchet. Nothing in this section changes them. A red full run suspends selection until it is fixed.

**Sharded full-run wall time (ADR 0022).** Measured on the 32-thread host with `test-runner.js --shards auto`
(see the COORD-974 closure for the measured figure, shard count and slowest file). A sharded run from the runner
alone is provisional until the donor receipt (`gov test-policy verify-shard-result`) is issued.

## Gate Execution Rules

Every derived project should preserve these gate properties:

- gates run non-interactively
- failures are reproducible from the recorded command
- failures name what broke and where to start
- ticket plan records capture the exact verification commands used
- heavier lanes are chosen deliberately, not by habit

When a project tailors the scaffold, it should update repo-local gate runners
and automation docs without changing the policy vocabulary here unless the
governance model itself changed.

Heavy lanes are kept proportionate by lane choice and contained by
process-orphan reaping, rather than by a cross-agent scheduler. The deliberate
decision *not* to build a resource-aware dispatch + shared test-evidence broker
(and what was adopted instead) is recorded in
[`coord/docs/decisions/0001-resource-aware-multi-agent-test-architecture.md`](../docs/decisions/0001-resource-aware-multi-agent-test-architecture.md).

## Dependency / Security Audit Signal (QGATE-002)

The `full` and `ci` lanes run a dependency/security audit as a governed gate
signal. It is deliberately excluded from `default` so routine `doing -> review`
handoffs stay fast; the audit is a pre-landing / CI confidence check.

- **Policy single-source**: the pass/warn/fail decision and the `npm audit
  --json` parsing live in `coord/engine/scripts/audit-policy.js`. The template runners
  (`backend|frontend/scripts/gate.sh`) shell out to
  `node coord/engine/scripts/audit-policy.js classify`, so the threshold logic is never
  re-typed in bash and cannot drift between the runner and coord-side tests.
- **Configurable threshold**: `GATE_AUDIT_THRESHOLD` (env, default `high`)
  selects the minimum severity that FAILS the gate. Vulnerabilities at or above
  the threshold fail; lower severities warn (printed, non-blocking). Severity
  ladder: `info < low < moderate < high < critical`.
- **Graceful degradation**: with no npm lockfile, no `npm` on PATH, or no audit
  output, the step prints a `SKIP` note and does not fail. This keeps minimal /
  zero-dependency repos green while still shipping the step so it activates the
  moment real dependencies (and a lockfile) land. Non-npm stacks substitute their
  own audit command but keep the same fail/warn/skip contract.
- **Governed signal**: the one-line summary
  (`audit: <result> threshold=<sev> total=N (critical=.. high=.. ...) blocking=N`)
  is recorded on the repo_gates board entry via
  `gov add-repo-gate --audit "<summary>"`, surfacing the audit outcome alongside
  the gate result/attribution.

## Test-Coverage Signal & Artifacts (QGATE-003)

The `full` and `ci` lanes generate test coverage as a governed gate signal and
store the report as a gate artifact. Like the audit signal it is excluded from
`default` so routine `doing -> review` handoffs stay fast; coverage is a
pre-landing / CI confidence check.

- **Policy single-source**: the pass/warn/fail decision and the parsing of
  Node's `--experimental-test-coverage` report live in
  `coord/engine/scripts/coverage-policy.js`. The template runners
  (`backend|frontend/scripts/gate.sh`) run `node --test
  --experimental-test-coverage` and shell out to
  `node coord/engine/scripts/coverage-policy.js classify`, so the threshold logic is
  never re-typed in bash and cannot drift between the runner and coord-side
  tests.
- **Configurable threshold**: `GATE_COVERAGE_MIN` (env, default `80`) is the
  minimum line/branch/function coverage percentage. The lowest of the three
  metrics drives the decision: below `min` fails, at/above `min` passes. An
  optional `--warn-band` (default `0`, a hard cliff) lets near-misses warn
  instead of fail. The default lives in `DEFAULT_COVERAGE_MIN` in
  `coverage-policy.js`.
- **Absence of measurement is not a pass (COORD-705)**: the graceful-skip path
  used to collapse every "no coverage data" outcome into one green `warn`, so
  "coverage was measured and met the minimum" and "coverage was never measured"
  were the same result — an impossible `min=101` could still be reported PASS,
  which is proof the threshold was never evaluated against data. The graceful
  contract is kept but it is now a NAMED outcome, discriminated by the test-count
  line in the report:
  - **zero tests** (`tests 0`) → `warn`, `reason=no-tests`, `measured=no`.
    GREEN: a minimal skeleton with nothing to measure still cannot fail this
    step. The vacuous all-100% report Node emits for an empty suite no longer
    *clears* a minimum either, and a genuine below-minimum measurement is never
    upgraded into this state.
  - **tests ran, no coverage data** → `missing`,
    `reason=measurement-expected-but-absent`, `measured=no`. NON-PASSING: the
    classify CLI exits 1 and `gate.sh` prints `COVERAGE MISSING` and fails.
  - The runner passes `--expect-coverage` whenever `GATE_COVERAGE_MIN` is
    explicitly set, so a coverage run that dies without printing anything at all
    (no test count either) is still caught: an explicitly requested minimum is
    the operator saying measurement is expected.
- **Summary format** (grep-friendly one-liner the runner prints and the board
  signal records):
  `coverage: <result> min=<pct> (lines=.. branches=.. functions=..) lowest=<pct> measured=<yes|no> tests=<n|unknown> [reason=<slug>]`
  — or `coverage: warn min=<pct> (no coverage data) lowest=n/a measured=no tests=0 reason=no-tests`
  when there was nothing to measure, and
  `coverage: missing min=<pct> (no coverage data) lowest=n/a measured=no tests=<n> reason=measurement-expected-but-absent`
  when a measurement was expected and did not arrive.
- **Artifact fields**: the gate artifact carries `coverage_status`,
  `coverage_measured` (boolean) and `coverage_reason` alongside the prose
  `coverage` summary, so a consumer reading the ARTIFACT alone — never stdout,
  never the exit code — can tell measured-and-met from never-measured.
- **Artifacts**: the textual coverage report is written under
  `coord/artifacts/gates/<repo>/coverage-<lane>.txt` — the canonical
  gate-artifact directory (`resolveGateArtifactDir` in `gate-runtime.js`,
  `coord/artifacts/gates/<repo>/`). The runner prints the `report:` path. These
  are runtime outputs and are NOT committed.
- **Graceful degradation**: with no coverage policy present the step prints a
  `SKIP` note; with no tests Node emits a vacuous report and the step stays
  green. The classifier never fails on missing coverage data (warn), so
  minimal / zero-dependency skeletons stay green while the step ships ready for
  the moment real tests land.
- **Governed signal**: the summary is recorded on the repo_gates board entry via
  `gov add-repo-gate --coverage "<summary>"`, surfacing the coverage outcome
  alongside the gate result/attribution and the audit signal (`coverage=...`
  annotation, mirroring `audit=...`).

## Architecture / Complexity Guardrails (QGATE-004)

The `full` and `ci` lanes run a lightweight static architecture gate as a
governed signal. Like the audit and coverage signals it is excluded from
`default` so routine `doing -> review` handoffs stay fast; the arch scan is a
pre-landing / CI confidence check. It is **WARNING-FIRST**: by default every
check warns (non-blocking) so it never turns the gate red on a repo's existing
module debt — escalate specific checks to `fail` per-config when the team is
ready to enforce.

- **Reusable check library**: `coord/engine/scripts/arch-checks.js` is BOTH the policy
  layer for the gate AND an importable, dependency-injection-friendly library.
  COORD-083's code-quality ticket generator imports it directly to turn findings
  into tickets, so the module is consumed as an API, not just a CLI. It is
  zero-dependency (no AST / no vendored analyzer).
- **Checks** (each config-driven with a threshold + a severity, each returning
  the structured finding shape below):
  - **size** — max LOC per file (the no-new-monolith absolute-budget signal;
    default budget `1500`). Comments/blank lines are stripped before counting.
  - **complexity** — per-function cyclomatic complexity, estimated by counting
    decision points (`if`/`for`/`while`/`case`/`catch`/`&&`/`||`/`??`/ternary)
    plus one (default budget `15`).
  - **imports** — declared import-boundary policy. Each rule is
    `{ from, denyImport, message }`; a file under `from` may not import a
    specifier matching `denyImport` (substring or RegExp). Empty by default so
    the template stays green; a derived repo declares its boundaries.
  - **duplication** — repeated normalized N-line blocks across files via a
    sliding-window hash (default `minLines` `12`). Overlapping windows collapse
    into one finding per duplicated region so a long clone is reported once per
    occurrence, not once per offset.
  - **monolith** — the no-new-monolith hard budget (default `5000` LOC), above
    the `size` warn budget. Absolute-budget form; `runChecks`/`scanRepo` accept
    an optional `baseline` map for layering growth-over-baseline.
  - **prodloc** — fail-closed production-module LOC budget for non-test
    `coord/scripts/**` modules (default `1200`, with explicit high-risk engine
    high-water budgets owned by the decomposition plan). A tracked hotspot that
    grows beyond its recorded high-water cap fails with ticket-attribution
    guidance; shrink-only decomposition should lower the cap using
    `deriveProductionModuleLocBudgets()` so the win is permanent.
    A high-water cap is an upper bound: measured LOC below or equal to it is
    valid, and unused headroom does not require a cap edit. Decomposition proof
    measurements must still be exact. Ratchet reports distinguish inherited
    excess from added LOC; failing production debt remains blocking even when
    pre-existing. No cap increases or grandfather exemptions are authorized.
    See [production LOC policy](../engine/docs/PRODLOC_POLICY.md) and the mandatory
    [Repo-X closeout gate](../engine/docs/PRODLOC_CLOSEOUT.md).
  - **compositionRoot** — fail-closed append-free hub guard for
    `coord/engine/scripts/lifecycle.js` and `coord/engine/scripts/governance-validation.js`.
    In diff-aware ratchet gate runs, newly-added non-wiring logic in either root
    fails; imports, destructuring, registry entries, exports, comments, and
    punctuation-only wiring are allowed. New feature logic should live in a
    self-registering module.
- **Finding shape (the COORD-083 contract)**: every check emits
  `{ check, file, value, threshold, severity, message, line? }`. `check` is one
  of `size | complexity | imports | duplication | monolith | prodloc |
  compositionRoot | hardcoding | deadcode`. This shape is
  load-bearing for the ticket generator — do not change it without updating
  COORD-083.
- **Policy / thresholds**: defaults live in `DEFAULT_CONFIG` in
  `arch-checks.js` (WARNING-FIRST — every check `severity: "warn"`). Override
  per-repo / per-check by passing a JSON config to the runner via the
  `GATE_ARCH_CONFIG` env var, e.g.
  `{"checks":{"size":{"maxLoc":1200,"severity":"fail"}}}`. `mergeConfig` merges
  overrides field-by-field onto the defaults. `severity: "off"` disables a check.
- **Classification**: the overall result is `fail` only if at least one finding
  has `severity: "fail"`; otherwise `warn` if there are any findings; otherwise
  `pass`. A completed scan exits non-zero ONLY on `fail` (exit 1), so by default
  it records the signal without blocking.
- **Corpus completeness** (COORD-817, fail-closed): a scan that cannot
  enumerate or read its corpus is a failed scan, not an empty one. An absent or
  non-directory `--root`, an unreadable root or in-scope subdirectory, an
  unreadable in-scope source file, or an unreadable `referenceRoot` makes
  `scanRepo`/`collectFiles` throw `ARCH_CORPUS_UNREADABLE` (path + OS error) and
  the classify CLI print `arch: ERROR ...` on stderr, print NO summary line, and
  exit 2 — in absolute and ratchet modes alike. Ignored paths (`ignore`
  fragments, `.git`, `node_modules`) are skipped before traversal, so their
  readability is never required. A readable directory with no in-scope source
  is a genuine empty corpus and still reports `arch: pass files=0`. The one
  tolerated absence is a ratchet baseline whose scanned subtree does not exist
  at the base ref: its baseline is empty, so everything in it counts as new.
- **Summary format** (grep-friendly one-liner the runner prints and the board
  signal records):
  `arch: <result> files=<N> findings=<M> (size=.. complexity=.. imports=.. dup=.. monolith=.. prodloc=.. compositionRoot=.. hardcoding=.. deadcode=..)`
- **Governed signal**: the summary is recorded on the repo_gates board entry via
  `gov add-repo-gate <ID> --command "<cmd>" --arch "<summary>"` (`--arch` is accepted
  alongside the gate's `--command`, `--result` and `--base-result`), surfacing the architecture outcome
  alongside the gate result/attribution and the audit/coverage signals
  (`arch=...` annotation, mirroring `audit=...` / `coverage=...`). The runner
  also writes the summary into the complete gate artifact under the optional
  `arch` field (with a paired `arch_skip_reason` when skipped).
- **Self-knowledge**: run against the coord engine itself the `size` check
  flags `coord/engine/scripts/lifecycle.js` (~3540 logical LOC, over the 1500 budget) as
  a WARNING — exactly the no-new-monolith signal — without failing the gate
  (warning-first honors existing debt).
- **Monolith/size PREVENTION ratchet (COORD-284)**: `size` and `monolith` are
  RATCHETED at the per-ticket `full`/`ci` submit gate so file-size debt cannot
  grow unnoticed. The policy:
  - **Existing over-budget files are GRANDFATHERED.** A finding already present on
    the baseline is PRE-EXISTING and never fails the gate — pre-existing module
    debt stays warning-first.
  - **A change that grows a file PAST its budget FAILS its own gate.** Any `size`
    or `monolith` finding that is NEW relative to the baseline (a file that
    crosses the budget it was under before, or a brand-new over-budget file)
    turns the arch step RED (`classify` exits 1 → `gate.sh` sets `fail=1`).
  - **Baseline is `origin/main`** (override with the `GATE_ARCH_BASELINE` env var;
    falls back to `main`). The baseline finding set is computed in an isolated,
    bounded `git worktree` checked out at the ref, scanning the SAME relative
    subtree the live scan covers. If NO baseline ref is reachable (offline,
    shallow, detached) the gate falls back to a NON-failing absolute pass with a
    logged `WARNING` — it never bricks on a missing ref.
  - **Wiring / seam**: this is the `GATE_ARCH_CONFIG` config seam, NOT hard-coded.
    The checked-in `coord/config/arch-gate.ratchet.json`
    (`{"archGate":"ratchet","ratchetFailOnNew":["monolith","size"]}`) is the
    DEFAULT `GATE_ARCH_CONFIG` for the `full`/`ci` arch step in
    `backend|frontend/scripts/gate.sh`; an explicit `GATE_ARCH_CONFIG` still wins.
    `ratchetFailOnNew` escalates the listed checks to a HARD FAIL **only when NEW
    under ratchet mode** — their own severity stays `warn`, so plain (absolute)
    `classify` and the no-baseline fallback remain warning-first. `archGate`
    defaults to `absolute` and `ratchetFailOnNew` defaults to `[]`, so a bare
    `--ratchet` (no config) does not silently start failing.

## Lint + Format Enforcement (QUALITY-001 / COORD-081)

Every repo generated from this template inherits **ESLint + Prettier**. The
template stubs ship the config so a derived project gets lint/format enforcement
on day one instead of bolting it on later, which is how unused code, risky
patterns, inconsistent formatting, and inert `eslint-disable` comments drift in
ungated.

- **Config, per stub** (`backend/`, `frontend/`):
  - `eslint.config.js` — ESLint **flat config** (the version-9+ default). Uses
    the `@eslint/js` recommended rule set plus a small low-friction hygiene layer
    (`no-unused-vars` with an `^_` ignore for intentionally-unused args,
    `eqeqeq` smart, `no-var`, `prefer-const`). The frontend config additionally
    carries an **opt-in TypeScript block** that activates automatically if a
    derived project installs `typescript-eslint`, so `.ts`/`.tsx` get covered
    with zero gate changes. The frontend `apps/**` reference app keeps its own
    `tsc --noEmit` typecheck lint and is ignored by the skeleton config.
  - `.prettierrc.json` — formatting policy (100 print width, 2-space, semicolons,
    double quotes, `trailingComma: all`). Prettier owns formatting; ESLint owns
    code-quality rules — they do not fight.
  - `.prettierignore` — excludes build output (`node_modules/`, `artifacts/`,
    `coverage/`, `.next/`, lockfiles) and leaves Markdown + `.env*` to project
    conventions rather than the JS formatter.
- **npm scripts** (each `package.json`): `lint` (`eslint .`),
  `format` (`prettier --write .`), `format:check` (`prettier --check .`).
- **Gate wiring**: `scripts/gate.sh` runs `npm run lint` + `npm run format:check`
  on the **`full` and `ci`** lanes only — excluded from `default` so routine
  `doing -> review` handoffs stay fast (layout + syntax + unit tests), matching
  the audit/coverage/arch signals. A `fail` from either eslint or prettier fails
  the lane.
- **Graceful degradation**: the bare template stubs have no `node_modules`, so
  eslint/prettier are not installed. The lint step **skips-with-note** (it never
  fails the template's own gate) when `node_modules` / the eslint binary is
  absent — mirroring the audit/coverage no-lockfile skip. The summary (or null +
  a paired `lint_skip_reason`) is written into the complete gate artifact under
  the optional `lint` field.
- **The stubs are clean against their own config**: the skeleton sources pass a
  fresh `eslint .` (0 problems) and `prettier --check .` once deps are installed,
  so a generated repo does not start life with lint-failing example code.
- **How a derived project runs it**: `npm install` (which pulls the declared
  `eslint`, `@eslint/js`, `prettier` devDependencies), then `npm run lint` /
  `npm run format:check`, or just `bash scripts/gate.sh full`. Tighten the rule
  set as the codebase matures; the gate enforces it from then on.

## CI-Safe API-Contract Check (CONTRACT-002 / COORD-082)

Every repo generated from this template inherits a **path-independent, CI-safe
API-contract check**. A frontend repo generates its API client/types from the
**backend's OpenAPI artifact**, and the gate **fails when the committed
generated client is stale** relative to that source contract.

The anti-pattern this fixes: downstream web had a HARDCODED `contract:gen` path
to a sibling `../<api-repo>/openapi.json`, which breaks in CI and whenever the
repo layout differs. Here the source is resolved through **config**, never a
hardcoded sibling path.

- **Config-driven source path** (`coord/project.config.js`,
  `repos.<F>.contract`):
  - `sourceRepo` — the repo CODE whose OpenAPI artifact is the source of truth
    (the backend, e.g. `"B"`).
  - `sourcePath` — the OpenAPI artifact path, **relative to the source repo
    root** (e.g. `contract/openapi.json`).
  - `generatedPath` — the committed generated client, **relative to this repo
    root** (e.g. `src/generated/api-client.js`).
  The block is **optional and backward-compatible** — a repo without it simply
  has no contract check. The source is resolved by joining onto the existing
  repo-registry path resolution (`paths.js` `repoRoots[sourceRepo]`), so the
  path is the same in any checkout location or in CI — never a `../sibling`.

- **Policy module** (`coord/engine/scripts/contract-policy.js`): single-sources the
  config resolution, a **deterministic** (dependency-free) OpenAPI→client
  codegen, and the staleness diff. Mirrors `audit-policy.js` /
  `coverage-policy.js`. CLI: `node coord/engine/scripts/contract-policy.js
  <gen|check> [--repo <CODE>]`.

- **npm scripts** (frontend `package.json`), delegating to
  `scripts/contract.js`:
  - `contract:gen` — regenerate the committed client from the resolved OpenAPI
    source.
  - `contract:check` — regenerate in memory and **diff** against the committed
    client; non-zero exit (gate fail) when stale.

- **Gate wiring**: `frontend/scripts/gate.sh` runs `npm run contract:check` on
  the **`full` / `ci`** lanes only (off `default` for speed), exactly like the
  audit/coverage/arch/lint signals. A `fail` (stale or missing committed client)
  fails the gate. It **skips-with-note** (never fails the bare template's own
  gate) when no coord policy is vendored or **no OpenAPI source artifact exists
  yet**. The grep-friendly one-liner (or `null` + a paired
  `contract_skip_reason`) is written into the gate artifact under the **optional
  `contract` field** — additive, NOT in the COORD-080 `REQUIRED_FIELDS`
  completeness set (like `arch`/`lint`).

- **Concrete example shipped**: `backend/contract/openapi.json` (minimal source
  contract) + `frontend/src/generated/api-client.js` (committed generated
  client) make the pattern real and testable. To bump the contract: edit the
  OpenAPI artifact, run `npm run contract:gen` in the frontend, commit both.
  Forgetting to regenerate is exactly what `contract:check` catches.

- **How a derived project runs it**: `bash frontend/scripts/gate.sh full`, or
  `npm run contract:check` directly. Swap the deterministic stub codegen for a
  real generator (openapi-typescript / orval / openapi-generator) — the
  config-resolution + staleness-gate contract is unchanged.

> **WEB-006 is an EXTERNAL follow-up, not implemented here.** The downstream
> frontend typing migration around `main.tsx` / loaders / legacy state has **no
> analog in the empty template stub** and remains a follow-up for the downstream
> product board. This ticket delivers only the template-side, path-independent
> contract scaffold + governed gate.

## Code-Quality Automation + Ticket Generator (COORD-083, QGATE capstone)

The arch-checks library is also the engine of a **scheduled audit that
auto-files governed quality tickets**, automating the manual audit -> ticket
workflow. The runner `coord/engine/scripts/quality-scan.js` (verb: `gov quality-scan`)
scans a target repo, normalizes findings into proposed tickets with a STABLE
per-finding key (`check:file:normalized-detail`), **dedups** against open board
tickets via a `[qkey:...]` description marker, and (with `--apply`) files the
survivors through `gov open-followup`. It is **dry-run by default**, with a
per-run **cap** to prevent flooding and a configurable **severity floor**. Full
operations + cron / GitHub-Actions schedule recipes: `coord/product/QUALITY_AUTOMATION.md`.

## Gate-Artifact Completeness Schema (QGATE-006)

Clean-checkout gate runs (`gov gate --lane <lane>`) used to SYNTHESIZE a thin
artifact whenever a repo's gate runner emitted none — `duration: unknown`,
`budget: unknown`, no coverage, no command list. That kept the downstream
annotate/record/provenance path alive but silently papered over incompleteness:
a thin synthesized artifact and a fully-instrumented one looked the same. The
completeness schema makes that MEASURED and surfaced.

- **Schema single-source**: `coord/engine/scripts/gate-artifact-schema.js` is the one
  source of truth for the artifact shape. `REQUIRED_FIELDS` lists the fields a
  COMPLETE gate artifact must populate and `validateGateArtifact(artifact)`
  returns `{ complete, missing, present }`. The schema id is
  `coord.gate-artifact/v1`.
- **Required fields** (the documented/reported order):
  - `lane` — the gate lane that ran (`default | full | ci`).
  - `commit` — the commit sha the gate ran against (real, from `git rev-parse`).
  - `result` — the gate verdict (`pass | fail`).
  - `duration_ms` — real wall-clock duration in ms (a number; never `"unknown"`).
  - `command_list` — the ordered list of step/command labels the lane executed.
  - `coverage` — the QGATE-003 coverage one-liner, OR `null` **with** a
    `coverage_skip_reason` (a skipped signal is allowed, a silently-dropped one
    is not).
  - `audit` — the QGATE-002 audit one-liner, OR `null` **with** an
    `audit_skip_reason`.
  - `artifact_paths` — the list of files written under
    `coord/artifacts/gates/<repo>/`.
- **Emission**: the template runners (`backend|frontend/scripts/gate.sh`) now
  emit a complete JSON artifact at `artifacts/gates/<lane>.latest.json` — timing
  the run, accumulating the command list, capturing the coverage/audit summaries
  (or recording a skip reason), and reading the commit via `git rev-parse HEAD`.
- **Validate-vs-synthesize**: `gate-runtime.js` reads the emitted artifact, adds
  clean-checkout provenance + the authoritative commit/`artifact_paths`, then
  validates it and records `complete` + `incomplete_fields` ON the artifact. A
  runner that emits the complete contract validates as complete; a bash runner
  that emits nothing still gets a **synthesize-with-warning** artifact (it keeps
  the fields it can, marks coverage/audit as skipped, and is flagged
  `complete: false` with the missing-field list). Rationale: failing the run
  would break the long-standing graceful path for older `gate.sh` runners and
  the minimal zero-dependency template stubs; surfacing incompleteness on the
  board is the acceptance criterion, not a hard stop.
- **Surfaced signal**: the runner prints a grep-friendly one-liner —
  `artifact: complete fields=8/8` or
  `artifact: incomplete fields=5/8 missing=duration_ms,command_list,coverage` —
  and the JSON result carries `artifact_complete` + `incomplete_fields`. The
  artifacts themselves are runtime output under `coord/artifacts/gates/<repo>/`
  and are NOT committed.

## Portability canary (COORD-908)

The matrix definition is `release/portability-matrix.json`; the runner is
`release/portability-canary.sh` (contract in `release/portability-canary.js`).
Release docs reference the matrix file, not a copy of it.

Run it from the donor root, in the foreground, one variant at a time:

```
COORD_PORTABILITY_NODE22_BIN=<bin dir with node 22> \
COORD_PORTABILITY_NODE24_BIN=<bin dir with node 24> \
release/portability-canary.sh --out <new results dir>
```

`--list` and `--dry-run` resolve variants without running anything.
`--variant <id>` (repeatable) runs a subset. `--summarize <dir>` rewrites
`ready-to-file.md` from an existing `summary.json`.

Each runnable variant runs the same small suite set (the COORD-901, 902 and 903
tests: `git-prerequisite.test.js`, `engine-pin.test.js`,
`governance.test.js`, `release/check-public-release.test.js`) through
`coord/scripts/test-runner.js`, then the release-cut check subset
(`git_prerequisite`, `engine_pin`, `template_sync`, `board`) from
`release/check-public-release.sh`. Each suite writes its runner report, and
each variant writes a COORD-910 run manifest (`run-manifest.json`) recording
umask, TMPDIR facts, Node and Git.

Variants on Linux: `linux-node22-default`, `linux-umask-0002`,
`linux-tmpdir-outside-tmp`, `linux-tmpdir-symlink`, `linux-node24-default`
and `linux-git-minimum`. `linux-git-minimum` needs a Git exactly at the
declared floor (2.38.0, from `coord/engine/scripts/git-prerequisite.js`),
supplied through `COORD_PORTABILITY_GIT_MINIMUM_DIR`; without it the variant
is reported `unavailable`, never passed. `darwin-node22-default` is
`not-implemented` on this host.

Results: `summary.json` gives each variant `pass`, `fail`, `unavailable` or
`not-implemented`. A failing variant writes `ready-to-file.md` (title,
failing steps, failing tests, environment, reproduce command). The canary
files no tickets itself: the owner files or updates the ticket with that report.
The runner exits 1 on any failure, 0 otherwise; `overall: incomplete` in the
summary means some variant could not run.

Schedule hook (not wired): run the command above on the schedule and before
each release cut, and keep the results directory with the release evidence.
Hosted CI or scheduler wiring needs the release-policy change in COORD-926.
Not implemented here: macOS, hosted scheduling, and a full built-cut check per
variant (the builder runs the whole governance suite, so the canary checks the
donor tree with the subset above; the full cut check stays with the release).

## Run Manifests and Evidence Reuse (COORD-910)

Every run of `coord/scripts/test-runner.js`, every clean-checkout repo gate
(`gov gate`) and every `release/verify-dual-release.sh` run writes a run
manifest (schema `coord/engine/run-manifest.schema.json`, tool
`coord/engine/scripts/run-manifest.js`). ADR 0021 decision 3 binds evidence
reuse to it.

- **Where:** the runner writes `<report>.manifest.json` (or `--manifest
  <path>`) and its report names it in `run_manifest` (path, schema version,
  input digest); a repo gate writes `<lane>.<source>.<timestamp>.manifest.json`
  beside its artifact and names it the same way; dual-release writes
  `<out-root>/run-manifest.json`, including for a failing run. An artifact that
  names a manifest must name it completely or it validates as incomplete.
- **Inputs (bind reuse):** source commit, tree, base (`--base` or
  `COORD_RUN_BASE`) and dirty-tree digest; engine pin and tool digests; policy
  digest (GOVERNANCE.md, project config, guard registry, shim registry); gate
  configuration (arguments, coverage baselines, suite inventory); dependency
  lock digests; Node and Git versions; edition; platform, arch, umask, TMPDIR
  symlink and filesystem type, timeout variables and the scrubbed-env list.
  `input_digest` is the sha256 of their canonical JSON.
- **Host facts (recorded, never binding):** TMPDIR path and realpath, kernel.
- **Results:** the shard plan, per-lane exit codes and durations, and the
  sha256 of every produced artifact and report.
- **Commands:** `run-manifest.js validate <m>`; `compare <a> <b> [--json]`
  lists result differences, then environment differences, host facts and the
  remaining inputs; `check-reuse <evidence> <current> [--intermediate
  --batching-ruling <text> --ticket-commit <sha>]` refuses reuse when any
  input differs, when the evidence failed, was dirty or has no known source,
  or when landing changes the tested tree or base.
- **Stacked evidence:** evidence from a top-of-stack tree is reused for an
  intermediate ticket only under a recorded batching ruling (in the manifest
  from `COORD_BATCHING_RULING`, or passed to `check-reuse`), the ticket commit
  must be an ancestor of the tested commit, and the landed tree and base must
  still equal the tested ones.

## Deploy Gates Mirror the PR Gate (QGATE-005)

A deploy pipeline MUST run the **same governed gate contract** as the PR gate,
and it must never be **weaker** than the PR gate. Deploy pipelines that
hand-maintain a partial list of test/build commands (`npm test && npm run
build && ...`) inevitably rot and end up weaker than the PR gate, so coord
stops being the single source of truth for what "passing" means.

The rule:

- A workflow that gates a deploy (or runs CI for a repo) **invokes the
  canonical gate runner** — `bash <repo>/scripts/gate.sh <lane>` (the
  BOOTSTRAP_CONTRACT entrypoint) or the governed clean-checkout form
  `coord/scripts/gov gate <repo> --lane <lane>` — instead of re-listing the
  underlying commands.
- It runs on a **deploy-strength lane**: `full` or `ci`, **never** the cheap
  `default` lane. `default` omits the audit/coverage/arch signals, so a deploy
  gate at `default` would be weaker than the pre-landing PR gate. The accepted
  deploy lanes are `DEPLOY_GATE_LANES = full | ci`.
- Deploy runs **only after** the gate stage passes for every governed repo.

**Single-source**: the canonical gate-invocation expectation lives in
`coord/engine/scripts/governance-constants.js` — `CANONICAL_GATE_ENTRYPOINTS` (the
accepted entrypoint patterns) and `DEPLOY_GATE_LANES` (the allowed lanes). The
template deploy workflow, the drift-check, and this doc all read from there so
they cannot silently drift.

- **Template deploy workflow**: `.github/workflows/deploy.yml.template` — a
  gate-contract-first deploy. Generated repos rename it to `deploy.yml`, adjust
  the repo matrix, and wire a real deploy target into the (stubbed) `deploy`
  job. The `gate` job runs `bash <repo>/scripts/gate.sh full` for every repo
  before any deploy step. The `.yml.template` suffix keeps GitHub Actions from
  running it in coord-template itself (which has no real deploy target).
- **Anti-drift contract check**: `coord/scripts/deploy-gate-contract.test.js`
  is the durable artifact. `checkDeployGateContract(workflowText)` asserts a
  deploy workflow invokes a `CANONICAL_GATE_ENTRYPOINT` on a `DEPLOY_GATE_LANE`,
  and the test proves a hand-rolled partial-command workflow FAILS the check
  (and that gating on `default` is rejected as weaker-than-PR). A generated
  repo can reuse the exported checker against its own `deploy.yml`.

This is NOT a separate CI system. It is the same `scripts/gate.sh full`/`ci`
contract the PR pipeline already runs, reused at deploy time so the deploy gate
can never drift below the PR gate.

> Note on this repo's own verification: coord-template uses local gates as the
> release authority. The engine self-test can be run locally with `node --test`
> under the default and non-default registries; it is not shipped as GitHub CI.

## Governance Doc/Engine Parity Check

The governance engine is self-hosting: `coord/GOVERNANCE.md` and
`coord/VERB_CONTRACT.md` document a lifecycle-verb and flag surface that
`coord/scripts/governance.js` and `coord/scripts/agent` must actually
implement. When the docs and the engine drift, an operator only discovers it
when a documented command is rejected live.

`coord/engine/scripts/governance.test.js` includes a CI-enforced parity check that
fails the regression suite on that drift. It:

- parses every backtick-quoted `gov <verb>` / `coord/scripts/gov <verb>` and
  `agent <verb>` reference out of the governance docs (prose mentions of the
  words are ignored — only complete inline-code spans count);
- fails if a documented `gov <verb>` has no `case` in the `dispatchCommand`
  switch, or a documented `agent <verb>` is not exposed by the `agent` facade;
- fails if a flag the `coord/scripts/agent` wrapper passes to the engine is not
  handled by `parseFlags`;
- reports any lifecycle verb that has no regression test.

This check is part of the `default` lane expectation for any ticket that
touches the governance CLI surface, its documentation, or the `agent` wrapper.
Treat a parity failure as a blocking drift, not a flake: either implement the
documented surface or correct the doc.

## Governance Config Matrix (registry-sensitivity)

The governance engine is parameterized by the project's repo registry —
`coord/project.config.js` declares the repo codes, their directories, and
their integration branches. coord-template's own config is intentionally
minimal: two repos (`B`/`F`) on integration branch `dev`. Historically the
governance suite ran only against that default, so engine code that silently
assumed `dev` or a two-repo layout passed CI and only broke later in a
structurally different downstream workspace (the COORD-005 / COORD-006 /
COORD-009 class of bug).

The suite is therefore run as a **config matrix** — the same
`coord/engine/scripts/governance.test.js` is executed under two registries:

- **default** — `coord/project.config.js` (the coord-template baseline).
- **non-default** — a synthetic 7-repo registry on a non-`dev` integration
  branch, fixture file
  `coord/scripts/__fixtures__/project.config.nondefault.js`.

### The config-swap mechanism

`coord/paths.js` resolves the project config through `resolveProjectConfig`
/ `loadProjectConfig`. The loader honors a `COORD_PROJECT_CONFIG` environment
variable: when set, it points at the project-config file to load **instead
of** `coord/project.config.js` (absolute, or relative to the process CWD). An
unset/empty var preserves the default discovery exactly.

Run the suite under the non-default registry locally with:

```
COORD_PROJECT_CONFIG=coord/scripts/__fixtures__/project.config.nondefault.js \
  node --test coord/engine/scripts/governance.test.js
```

The full suite must pass green under **both** legs. A test that legitimately
pins the config-discovery default behavior wraps itself in the
`withDefaultProjectConfigEnv` helper (it clears the override for the duration
of that test). The board validator (`coord/board/board.js`) deliberately
**ignores** `COORD_PROJECT_CONFIG` — it is constructed with
`createCoordPaths({ forceProjectConfig: true })` so it always validates the
real coord board against this checkout's real registry, never a fixture.

### Local enforcement

Run both matrix legs before publishing changes under `coord/scripts/`,
`coord/board/board.js`, `coord/paths.js`, or `coord/project.config.js`. A
config-sensitive assumption (hardcoded `dev`, a two-repo assumption) should fail
the non-default leg locally rather than late in a downstream proving ground.
When adding engine code, derive integration branches and repo sets from the
registry (`REPO_INTEGRATION_BRANCHES`, `REPO_ROOTS`) — never hardcode `dev` or
`B`/`F`.

## Journal Hash-Chain Migration (SHA-1 → SHA-256, COORD-289)

The journal hash-chain is versioned (see
[`coord/GOVERNANCE_ARCHITECTURE.md`](../GOVERNANCE_ARCHITECTURE.md) →
"Journal Hash-Chain Era Model"). Testing rules for it:

- **Never mutate the live journal in tests.** All era/migration tests use
  ISOLATED sandbox journals (`withJournalSandbox`) or hand-built fixtures. The
  live `coord/.runtime/governance-events.ndjson` is the audit substrate and is
  off-limits to the test suite.
- **Back-compat is a gate invariant.** A pre-migration (untouched) repo must
  append byte-identically to before — no `hash_alg` field, sha1 link. A
  regression test asserts this; treat any change to pre-migration stored-line
  bytes as a breaking failure, not a refresh.
- **The migration is a one-time, human-only, irreversible cutover.** `gov
  migrate-chain-hash` (default DRY-RUN; `--confirm` to apply) appends the single
  signed `hash-alg-migration` bridge event. It preconditions `gov conform` PASS,
  refuses a second migration (idempotent), and is the ONLY way the bridge event is
  created. After it runs, `gov conform` reports `headAlg = sha256` and a non-zero
  SHA-256 era while the full SHA-1 history still verifies as historical fact.
- **Run the gate serially.** Use
  `env -u COORD_SESSION_ID node --test --test-concurrency=1 coord/scripts/*.test.js
  coord/board/*.test.js`; `COORD_SESSION_ID` must be unset for the runner (it
  leaks into ownership tests) and the chain/era tests are deterministic only when
  serial.

## Test-Harness Isolation: never write the live `coord/` tree (COORD-290, COORD-299, COORD-606)

Tests that mutate `coord/` fixtures MUST run in isolated temp dirs / dedicated
sandboxes — **NEVER against the live governed runtime.** Writing transient
fixtures under the SEALED `coord/` tree (e.g. `coord/prompts/tickets/*.tmp`,
re-rendered `coord/rendered/*`, `coord/PLAN.md`) trips the COORD-220 out-of-band
seal + COORD-222 co-located guard for the NEXT governed command during concurrent
governed mutations. The seal is correctly flagging out-of-band mutation — a test
that leaks live writes is the defect, not the seal.

Four further isolation rules keep a suite's result independent of the host and of
concurrent runs (COORD-952). They are enforced by the suites named below and by
`test-harness-guards.test.js`.

- **Engine pin.** A fixture that runs a real closeout path must not read the live
  engine pin (`coord/engine-pin.json` and the manifest fingerprint) of the checkout
  that runs it. An unrelated engine edit in progress would otherwise turn unrelated
  fixtures red. `closeout.test.js` installs a fixture pin through the test-only seam
  `setEngineIntegrityPinOverride` on `lifecycle-repox-closeout.js`. Its manifest surface
  is live, but its verdict is the pinned state. `lifecycle-repox-closeout.test.js`
  proves the outcome with a deliberately drifted live pin seam.
- **Clock.** Lock-age and stale-threshold tests derive their clock from the stored
  mtime or an injected `Date.now`, not from a wall-clock sample taken before a
  filesystem call. Elapsed-time bounds use the consumer's own budget, not a fixed
  number of milliseconds that host load can exceed.
- **Global fs.** A test that replaces `fs.statSync`, `fs.lstatSync` or `fs.renameSync`
  restores the original in a `finally` block that also covers setup. A patch is
  scoped to the single test that installs it.
- **Git config.** Every git call against a temp fixture repo goes through
  `coord/engine/scripts/test-git-fixture.js` (`gitFixtureEnv`), which sets
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1`. A host `commit.gpgsign`, `core.hooksPath` or alias must not
  change fixture commits.
  `test-harness-guards.test.js` ratchets the raw `git init` sites: a file's count may
  not grow, and a new file must use the helper. Lowering a count is allowed.
- **Frontend dependencies.** The coord-ui lib tests load `typescript` and `react-dom`
  through `frontend/apps/coord-ui/lib/coord-ui-deps.mjs`. A worktree without
  `cd frontend/apps/coord-ui && npm ci` fails loudly with that command. It never skips.

Lane waits in the session-lifecycle harness use the progress deadline
(`createLaneTracker`); a fixed deadline reports the host I/O and load state when it
expires.
The progress deadline's hard ceiling is exact even when it is shorter than the stall limit.
Real-worker fault injection is test-only (`COORD_INJECT_LIFECYCLE_HANG`,
`COORD_INJECT_LIFECYCLE_SLOW_MS`, `COORD_INJECT_LIFECYCLE_SLOW_ONCE_MS`). Synthetic host
pressure comes from `session-lifecycle-load.js`. Burn-in evidence and its limits are in
`coord/docs/evidence/COORD-937-gate-timeout-burn-in.md`.

Real Git fixtures also need to own their subprocess lifetime (COORD-767).
A successful synchronous `git commit` can leave detached maintenance writing
to `.git`; deleting that repository can then race the writer. The
`missing-ticket-lock.test.js` fixture sets `maintenance.autoDetach=false` and
`gc.autoDetach=false` in both of its temporary repositories before their first
commit. Maintenance still runs, but finishes before the invoking Git command
returns. These are repository-local fixture settings, not user or production
Git defaults.

Its regression triggers real packing and checks Trace2 event order: maintenance
children must exit successfully before the parent commit exits. An idle
maintenance check is insufficient evidence. Native cleanup and rollback
assertions remain enabled; do not replace this lifetime contract with cleanup
retries, suppressed errors, or sleeps. A failed lifetime regression retains its
temporary repository and trace for diagnosis rather than deleting a writer's
active files.

Rules:

- **Sandbox every write via `os.tmpdir()` + the `__testing.paths` override.** Mirror
  a well-behaved helper: `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, then point
  the relevant registry entries (`BOARD_PATH`, `PROMPTS_DIR`, `RENDERED_DIR`,
  `PLAN_PATH`, `RUNTIME_DIR`, plan-records / lock / snapshot dirs) at the sandbox,
  and restore them in `finally`. Production paths must resolve through this
  registry (not a module-level constant) so the override actually takes effect —
  e.g. `coord/board/board.js` resolves its rendered/PLAN output paths from the
  registry at render time, and `token-economics.js` resolves prompts via
  `state.PROMPTS_DIR`.
- **The harness guard enforces this.** `coord/engine/scripts/test-isolation-guard.js` is a
  `--require` preload (loaded by `coord/scripts/test-runner.js`, the authoritative
  entrypoint behind `coord/scripts/check-test-isolation.sh`) that
  THROWS the instant any test writes under the live `coord/prompts/**` /
  `coord/rendered/**` (seal class), the live-runtime class (see COORD-299 below),
  or the governed-state class (see COORD-606 below)
  outside its sandbox — catching transient write-then-restore leaks that a
  post-suite `git status` cannot see. A future test cannot silently regress the
  rule. `coord/engine/scripts/test-isolation-guard.test.js` unit-covers all three
  classifiers and proves the runtime and governed classes fail-closed.
- **Governed-state class (COORD-606).** The guard also fails-closed on the tracked
  governed coordination state the first two classes left open: `coord/board/**`
  (the live board, its schemas and `board.js`), `coord/PLAN.md`,
  `coord/QUESTIONS.md` and `coord/active/**`. Sandbox through `__testing.paths`
  (`BOARD_PATH` / `PLAN_PATH` / `QUESTIONS_PATH`). Staged with the same vocabulary
  as the runtime class via `COORD_TEST_ISOLATION_GOVERNED`
  (`enforce` default | `detect` | `off`); an unknown value fails closed.
- **What the isolation guarantee actually is, and what it is not (COORD-606).**
  COORD-480 advertised "the runner fails if a test writes outside its allowed
  temporary roots". That claim was wider than the enforcement: the guard is an
  in-process `fs` hook, so it could neither see writes to the board/plan/questions
  (not guarded at all) nor writes made by a SPAWNED process (`git`, a shell script,
  a `gov` child) — which is the most likely way a test corrupts the tree. The
  guarantee is now enforced in two halves and stated at its true width:
  1. the `fs` hook above, covering in-process writes to the three guarded classes;
  2. a GOVERNED-TREE FINGERPRINT taken by `coord/scripts/test-runner.js` before and
     after EVERY module — content hashes of `coord/board/**`, `coord/prompts/**`,
     `coord/rendered/**`, `coord/active/**`, `coord/PLAN.md` and
     `coord/QUESTIONS.md`. A module that leaves the tree changed fails the run, the
     changed paths are printed, and they are recorded in the run report under
     `governed_tree_violations`. This is what catches subprocess mutations.

  The guarantee is therefore: **no test run may leave the governed tracked surfaces
  changed.** It is NOT a general "no write outside a temp root" guarantee — a test
  writing to engine source (`coord/scripts/**`) or to a path outside `coord/` is
  still not intercepted by either half. `coord/.runtime/**` is covered by the hook
  only (it is gitignored, legitimately churning state, so it is deliberately not
  fingerprinted). Corollary, unchanged: never run the suite concurrently with
  governed mutations — a concurrent `gov` write is indistinguishable from a leaking
  test, and the fingerprint will (correctly) fail the run.
- **Allowlist (kept tiny and conservative).** `withCanonicalTicketPrompt`
  legitimately provisions the REAL canonical ticket prompt
  (`coord/prompts/tickets/COORD-023.md`, `COORD-024.md`) to exercise canonical
  path resolution; it only writes in a STRIPPED public checkout (no-op in the
  donor) and removes only what it created. These exact paths are the documented
  guard exception. Prefer sandboxing over extending the allowlist.
- **Live-runtime class (COORD-299).** The guard now ALSO fails-closed on the
  gitignored shared-worktree runtime: `coord/.runtime/**` (journal, snapshots, plan
  + ticket-lock shards, attestations, conformance-keys, gate-procs), the two coarse
  directory locks `coord/.coord-state.lock` / `coord/.agent-state.lock`, and
  `coord/memory/**`. This is the second of the two guarded classes
  (`isRuntimeViolation`); the seal class (`isViolation`) is unchanged. To make the
  full runtime sandboxable, the `__testing.paths` registry gained
  `COORD_STATE_LOCK_DIR`, `AGENT_STATE_LOCK_DIR`, and `MEMORY_DIR` overrides (the two
  coarse locks resolve LIVE off `state` in `governance-context.js`, like
  `RUNTIME_DIR` / `GOVERNANCE_EVENT_LOCK_DIR`). The shared sandbox helpers
  (`withJournalSandbox`, `withGovernedSurfaceSandbox`, `withCleanRuntimeFixture`,
  `setupCoord003Workspace`, `withRegisterPromptHarness`) redirect these new keys
  alongside `RUNTIME_DIR`. A test file whose governed calls would only ACQUIRE the
  ephemeral coarse locks as a side effect can call
  `governance-test-utils.sandboxProcessRuntimeLocks()` once at the top to relocate
  this worker's lock + memory dirs to an `os.tmpdir()` sandbox (process-scoped; the
  locks are transient and never asserted on).
- **Runtime allowlist (COORD-299, conservative + tracked).** Two layers:
  `RUNTIME_ALLOWLIST` (specific live paths — currently empty) and
  `RUNTIME_ALLOWLIST_FILES` (test/worker files whose live-runtime writes are not yet
  sandboxed). The latter currently holds the staged residual — `agent-commands`,
  `board-rebuild`, `governance`, `journal` (real `.runtime` content / conformance
  keys), `recall` + `memory-eval` (live `coord/memory` corpus pending `MEMORY_DIR`
  wiring into the memory modules), `concurrent-burnin` (deliberately contends on the
  LIVE coarse lock), and `gate-proc-registry` (child writes live gate-procs pidfiles).
  Each is exempted from ENFORCEMENT only (the classifier still flags its paths); the
  guard still fails-closed for every file OUTSIDE the list, so no NEW offender can
  regress in. Draining this list (bespoke sandboxes + `MEMORY_DIR` wiring) is the
  COORD-300 follow-up. `COORD_TEST_ISOLATION_RUNTIME=detect` re-enumerates all
  offenders to a report file without failing.
- **Gate-then-mutate; never run the suite concurrently with governed mutations.**
  Run the ONE authoritative entrypoint (COORD-480): `node
  coord/scripts/test-runner.js` — equivalently `npm test --prefix coord`, or the
  `coord/scripts/check-test-isolation.sh` shim, which now delegates to it. The
  runner owns the whole execution contract, so no consumer maintains a test glob:
  it normalizes the test root from its own location (so the same command works
  from the repository root, from `coord/`, and from a packed artifact), discovers
  every suite recursively and deterministically (a nested suite cannot dodge
  `--list`), runs serially (`--test-concurrency=1`), STRIPS ambient session
  identity from the child environment, preloads this guard, fingerprints the
  governed tree around every module, and writes a JSON report
  with the aggregate execution order + environment needed to reproduce
  order-dependent defects. An aggregate failure is never forgiven because an
  isolated rerun passes. Identity stripping is PROVIDER-COMPLETE (COORD-606):
  every `envThread`/alias in the `governance-session.js` `PROVIDER_REGISTRY`
  (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`,
  `GEMINI_THREAD_ID`, `GROK_THREAD_ID`), the provider-neutral `AGENT_THREAD_ID` /
  `GOVERNANCE_MCP_THREAD_ID`, and the coord identity variables (`COORD_SESSION_ID`,
  `COORD_PROVIDER_SESSION_ID`, `COORD_INSTANCE_ID`) are named explicitly, and a
  shape-based sweep (`*_SESSION_ID` / `*_THREAD_ID` / `*_INSTANCE_ID`) removes
  anything a future provider adds before the list is updated;
  `test-runner.test.js` fails if a registry variable is missing from the
  enumeration. The run REPORT is the gate's evidence: if it cannot be persisted the
  run exits non-zero and prints `result=FAIL` + `report=NOT-WRITTEN` rather than
  claiming PASS against a path that does not exist (COORD-606).
- **Product test and gate children are scrubbed too (COORD-909).** The provider-complete
  identity list and its shape pattern live in ONE module,
  `coord/engine/scripts/agent-identity-env.js` (`STRIPPED_ENV_VARS`, `IDENTITY_ENV_PATTERN`,
  `isIdentityEnvVar`, `scrubIdentityEnv`, which returns a COPY). `test-runner.js`,
  `gate-runtime.js` and `test-policy-run.js` use it. The governance process keeps its own
  identity and still records the gate; only child environment copies are scrubbed.
  Credentials (`*_TOKEN`, `*_KEY`), proxy and network variables (`HTTP(S)_PROXY`,
  `NO_PROXY`, SSL/CA variables), `PATH`, `NODE_OPTIONS` and toolchain settings pass through.
  Child environment per execution path:

  | Path | Spawn | Child environment before COORD-909 | After COORD-909 |
  |---|---|---|---|
  | `gov gate` clean-checkout dependency install | `gate-runtime.js` `spawnSync(pkgManager.bin, installArgs)` | inherits full `process.env`, including identity (leak) | `productChildEnv()`: identity-free copy |
  | `gov gate` bash fallback (`scripts/gate.sh <lane>`) | `gate-runtime.js` `spawnSync("bash", ["scripts/gate.sh", lane])` | inherits full `process.env` (leak) | identity-free copy |
  | `gov gate` package-manager gate script | `gate-runtime.js` `spawnSync(pkgManager.bin, runScriptArgs(script))` | inherits full `process.env` (leak) | identity-free copy |
  | `gov test-policy run` product command units | `test-policy-run.js` `commandUnit` via `spawn` | inherits caller env (leak) | `scrubIdentityEnv(env)` copy |
  | `gov test-policy run` runner units, test-sharding executor, affected-landing runner | `test-policy-run.js` `runnerUnit`, `test-sharding.js` executor, `affected-landing.js` | coord suite invocations; the runner strips identity from every suite child | unchanged: the runner scrubs its own children (COORD-480/606/880/883) |
  | Coord governance suite children | `test-runner.js` `buildChildEnv` | identity stripped | same list, now from the shared module |

  Gate-plan execution and submit-time gates reach the three product spawns through
  `lifecycle.js` `createGateRuntime`, so they inherit the fix. The gate evidence is recorded
  by the governance process, so the artifact and its journal event are attributed to the
  bound governance identity (the artifact carries no child identity). Regression coverage:
  `gate-runtime.test.js` runs a fixture product repo through `runCleanCheckoutGate` (a real
  disposable `npm ci` install, then a fixture `scripts/gate.sh` that prints its environment)
  and asserts identity is absent while proxy, credential and PATH variables are present;
  `agent-identity-env.test.js` pins the shared list and the preserved set.
- **The runner is under integrity coverage (COORD-606).** `test-runner.js`,
  `test-runner.test.js`, `test-isolation-guard.js` and
  `test-isolation-guard.test.js` are tracked in `coord/TEMPLATE_SYNC_MANIFEST.json`
  and pinned in `coord/engine-pin.json`, so `check-template-sync.sh` and `gov
  verify-engine` fail on drift in the entrypoint that publication is fail-closed
  on. They were missed originally because the manifest is a HAND-CURATED list
  seeded from a static maintainer inventory snapshot — there is no discovery
  rule, so any engine file created later stays untracked until it is added by hand.
  `coord/scripts/check-template-sync.sh --audit-coverage` reports the untracked
  remainder (report-only; it never changes the exit code). Focused local iteration: `--module <name>` / `--file
  <path>` (npm: `test:core`, `test:board`, `test:hooks`, `test:gates`,
  `test:enterprise`, `test:packaging`). The same entrypoint is what active PR CI
  (`.github/workflows/governance-suite.yml`), public-cut hygiene
  (`release/check-public-release.sh`), and binary verification call.

### SQLite on the minimum Node runtime

The declared minimum remains Node 22.8. The authoritative test runner activates
built-in SQLite for child processes on Node 22.8–22.12 and 23.0–23.3, where Node
requires `--experimental-sqlite`. Existing caller options, an explicit disable,
the isolation guard and identity stripping are preserved. Minimum-runtime
qualification must execute SQLite tests; a newer-runtime pass or skipped
persistence tests do not qualify that lane. See
[SQLite runtime requirements](../engine/docs/SQLITE_RUNTIME.md) for production CLI
invocations and prerequisite diagnostics.

## Governance Integration

This file is the policy source referenced by:

- [`coord/GOVERNANCE.md`](../GOVERNANCE.md) Section 9 Review Gate
- [`coord/GOVERNANCE.md`](../GOVERNANCE.md) Section 10.6 Testing Infrastructure
  Identification
- [`coord/GOVERNANCE.md`](../GOVERNANCE.md) Section 10.7 Pre-Landing Checks
- [`coord/product/LOCAL_AUTOMATION_AND_GATES.md`](./LOCAL_AUTOMATION_AND_GATES.md)
  for lane invocation details
- [`coord/product/BOOTSTRAP_CONTRACT.md`](./BOOTSTRAP_CONTRACT.md) for the repo
  runner interface

If this file and a repo-local automation doc disagree, this file defines the
policy expectation and the repo-local file must be updated to match it.
