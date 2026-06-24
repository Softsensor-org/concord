# Testing and Gate Policy

This document defines what good testing looks like in a project created from
this template. It is the policy layer that governance uses when deciding which
checks are required before `doing -> review` and before `review -> done`.

This file is intentionally distinct from:

- `/test-strategy`, which audits an instantiated codebase and recommends gaps
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

A ticket does not need evidence in every dimension. It needs evidence in the
dimensions its risk profile makes credible.

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

## Gate Lane Policy

The accepted **executable** lane vocabulary — the names accepted by `gov gate
--lane`, implemented by every repo's `scripts/gate.sh`, and exercised by CI — is
`default | full | ci`. It is single-sourced in
`coord/scripts/governance-constants.js` (`GATE_LANES`) so governance validation,
the template runners, and CI cannot drift (COORD-075 / QGATE-001).

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
  --json` parsing live in `coord/scripts/audit-policy.js`. The template runners
  (`backend|frontend/scripts/gate.sh`) shell out to
  `node coord/scripts/audit-policy.js classify`, so the threshold logic is never
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
  `coord/scripts/coverage-policy.js`. The template runners
  (`backend|frontend/scripts/gate.sh`) run `node --test
  --experimental-test-coverage` and shell out to
  `node coord/scripts/coverage-policy.js classify`, so the threshold logic is
  never re-typed in bash and cannot drift between the runner and coord-side
  tests.
- **Configurable threshold**: `GATE_COVERAGE_MIN` (env, default `80`) is the
  minimum line/branch/function coverage percentage. The lowest of the three
  metrics drives the decision: below `min` fails, at/above `min` passes. An
  optional `--warn-band` (default `0`, a hard cliff) lets near-misses warn
  instead of fail. The default lives in `DEFAULT_COVERAGE_MIN` in
  `coverage-policy.js`.
- **Summary format** (grep-friendly one-liner the runner prints and the board
  signal records):
  `coverage: <result> min=<pct> (lines=.. branches=.. functions=..) lowest=<pct>`
  — or `coverage: warn min=<pct> (no coverage data) lowest=n/a` when no report
  is produced.
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

- **Reusable check library**: `coord/scripts/arch-checks.js` is BOTH the policy
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
- **Finding shape (the COORD-083 contract)**: every check emits
  `{ check, file, value, threshold, severity, message, line? }`. `check` is one
  of `size | complexity | imports | duplication | monolith`. This shape is
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
  `pass`. The classify CLI exits non-zero ONLY on `fail`, so by default it
  records the signal without blocking.
- **Summary format** (grep-friendly one-liner the runner prints and the board
  signal records):
  `arch: <result> files=<N> findings=<M> (size=.. complexity=.. imports=.. dup=.. monolith=..)`
- **Governed signal**: the summary is recorded on the repo_gates board entry via
  `gov add-repo-gate --arch "<summary>"`, surfacing the architecture outcome
  alongside the gate result/attribution and the audit/coverage signals
  (`arch=...` annotation, mirroring `audit=...` / `coverage=...`). The runner
  also writes the summary into the complete gate artifact under the optional
  `arch` field (with a paired `arch_skip_reason` when skipped).
- **Self-knowledge**: run against the coord engine itself the `size` check
  flags `coord/scripts/lifecycle.js` (~3540 logical LOC, over the 1500 budget) as
  a WARNING — exactly the no-new-monolith signal — without failing the gate
  (warning-first honors existing debt).

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

- **Policy module** (`coord/scripts/contract-policy.js`): single-sources the
  config resolution, a **deterministic** (dependency-free) OpenAPI→client
  codegen, and the staleness diff. Mirrors `audit-policy.js` /
  `coverage-policy.js`. CLI: `node coord/scripts/contract-policy.js
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
workflow. The runner `coord/scripts/quality-scan.js` (verb: `gov quality-scan`)
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

- **Schema single-source**: `coord/scripts/gate-artifact-schema.js` is the one
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
`coord/scripts/governance-constants.js` — `CANONICAL_GATE_ENTRYPOINTS` (the
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

`coord/scripts/governance.test.js` includes a CI-enforced parity check that
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
`coord/scripts/governance.test.js` is executed under two registries:

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
  node --test coord/scripts/governance.test.js
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
