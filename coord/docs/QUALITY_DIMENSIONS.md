# Quality Dimensions: the extensible enforcement harness

## 1. Thesis

concord is **not a fixed set of checkers**. It is an extensible enforcement
*harness*. The harness owns the parts that are hard to get right and identical
across every check — orchestration, baseline/ratchet accounting, evidence
emission, bounded subprocess execution, and the gate verdict. A **quality
dimension** is a pluggable check that owns only the part that is specific to it:
*detection*. Adding a dimension means writing a detector that emits findings in
a uniform shape and registering it; you never re-implement the gate machinery.

This division is deliberate. Static gates are excellent at catching **debt and
drift** — oversized files, rising complexity, dependency CVEs, broken import
boundaries, duplicated blocks, coverage regressions. They are mechanical,
repeatable, and cheap to run on every change. What they **cannot** do is judge
**semantic / domain correctness**: whether the code does the right thing for the
business. That class of judgement stays in the evidence-gated review cycle
(diverse, adversarial human/agent lenses recorded as auditable evidence). The
honest framing is: *static dimensions hold the line on debt and drift; semantic
correctness is carried by evidence-gated review.* This document specifies the
dimension contract and the roadmap of dimensions that extend the harness. It
describes the **existing** harness (arch-checks, the per-repo `gate.sh`,
coverage/audit policy, the gate artifact) and how to extend it — it does not
propose a parallel system.

The reference native dimension is `coord/scripts/arch-checks.js` (size,
complexity, imports, duplication, monolith, hardcoding, deadcode). Read it
first: every concept below is already implemented there.

## 2. The dimension contract

A quality dimension is a module that exposes a `scan` and emits **findings**.

### 2.1 `scan(repoRoot, opts) -> findings[]`

A dimension produces an array of findings. Each finding is a plain object with:

| field      | meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `check`    | the dimension/check name (e.g. `"complexity"`, `"sast"`)                 |
| `file`     | the file the finding is about (as given to the analyzer)                |
| `value`    | the measured value (LOC, complexity count, rule id, advisory id, …)     |
| `severity` | `"warn"` or `"fail"` (the configured severity for this check)           |
| `detail` / `message` | a human-readable explanation of the finding                   |

This is exactly the shape `arch-checks.js` already emits (see `makeFinding` and
the per-check producers such as `checkFileSize`, `checkComplexity`,
`checkImportBoundaries`, `checkDuplication`). Reuse it verbatim — every existing
consumer (`quality-scan.js`, the gate artifact, the cockpit) understands it.

### 2.2 The STABLE finding key

Every finding must be addressable by a key that is **stable across unrelated
churn**. A line shift, a LOC drift in a neighbouring function, or a reordering
must NOT change the key — otherwise ratchet mode (below) would reclassify a
pre-existing finding as "new" on every commit and the baseline would be
worthless.

The reference implementation is `arch-checks.stableFindingKey(finding)`:

```
`${finding.check}:${normalizeFindingFilePath(finding.file)}:${stableFindingDetail(finding)}`
```

The key is built from the **check name**, the **normalized file path**, and a
**stable detail** (`stableFindingDetail`) that intentionally omits line numbers
and other position-dependent data. A new dimension must define its own stable
detail with the same property: identity should track *the thing being flagged*,
not *where it currently sits in the file*. (Example choices appear in §3 and the
roadmap.)

### 2.3 Two implementation modes

**(a) NATIVE JS detector** — the dimension parses sources itself in-process and
emits findings. This is what `arch-checks.js` does: it reads files, walks them,
and produces findings with no external tool. Native detectors are pure and fast;
prefer them when the analysis is expressible in JS.

**(b) EXTERNAL-tool ADAPTER** — the dimension shells out to an external tool
(Semgrep, Stryker, Trivy, axe, Lighthouse, …), captures its stdout/JSON/SARIF,
and *parses that output into the same finding shape*. The harness already has
two worked adapters:

- `coord/scripts/audit-policy.js` parses an `npm audit --json` payload
  (`parseAuditCounts`) and classifies it against a severity threshold
  (`classifyAudit` / `severityRank`).
- `coord/scripts/coverage-policy.js` parses a `node --test` coverage report
  (`parseCoverageReport`) and classifies it against a minimum-% threshold
  (`classifyCoverage`).

An adapter's only job is **run tool X → parse → findings[]**. The verdict,
ratchet, and evidence are still the harness's job.

### 2.4 Verdict modes

A dimension's findings are turned into a pass/warn/fail verdict in one of three
modes:

- **`absolute`** (default) — fail if any finding has severity `fail`; warn if
  there are any findings; else pass. This is `arch-checks.summarizeFindings`.
- **`ratchet`** — fail only on findings that are **NEW relative to a base ref**
  (and carry severity `fail`); pre-existing findings (any severity) and
  warn-class new findings are informational. This is the frictionless-adoption
  path: a repo with legacy debt can turn the dimension on without going red, and
  the gate only blocks *added* debt. The reference implementation is
  `arch-checks.classifyFindingsAgainstBaseline(currentFindings, baseFindings)`
  (partitions current findings into `newFindings` / `preExistingFindings` keyed
  by `stableFindingKey`) feeding `arch-checks.summarizeRatchet(...)` (emits
  `{ mode:"ratchet", result, new, preExisting, newFailCount, newWarnCount }`).
  A new dimension reuses these two functions directly — it supplies the two
  finding arrays; it does not re-implement the diff. Ratchet is enabled via the
  CLI (`--ratchet` / `--baseline <ref>`) or config (`archGate: "ratchet"`).
- **`threshold`** — fail when a measured metric crosses a configured bound (e.g.
  coverage below a minimum, mutation score below a floor, bundle over budget).
  This is `coverage-policy.classifyCoverage` / `audit-policy.classifyAudit`.

Default is `absolute`. Ratchet is the recommended on-ramp for any dimension
applied to a repo that already carries debt in that dimension.

### 2.5 Evidence

A dimension's verdict must become **auditable evidence**, not just a console
line. The per-repo `gate.sh` already writes a complete gate artifact
(`artifacts/gates/<lane>.latest.json`, validated by
`coord/scripts/gate-runtime.js` against `coord/scripts/gate-artifact-schema.js`).
Existing dimensions land their summary as a named field in that artifact:
`coverage`, `audit`, and `arch` are all emitted there (with a skip-reason when
the dimension is unavailable, so a minimal repo still emits a *valid* artifact).
A new dimension adds its own summary field the same way. From the artifact the
verdict flows into the conformance / attestation layer
(`coord/scripts/conformance-attestation.js`,
`coord/scripts/conformance-verbs.js`) so each dimension's pass/fail is part of
the auditable record for a change.

### 2.6 Registration and bounded execution

A dimension plugs in at one (or both) of two points:

- **As a `gate.sh` step.** `frontend/scripts/gate.sh` and
  `backend/scripts/gate.sh` run the ordered lane steps (syntax, unit tests,
  lint/format, coverage, audit, arch). A new dimension is one more `step "..."`
  that runs the detector/adapter and folds its summary into the artifact. Follow
  the existing `arch-checks` step: it resolves the policy path, runs
  `node <policy> classify --root "$REPO_DIR" ...`, captures the summary JSON, and
  emits it under the `arch` artifact field (skipping with a reason if the policy
  is absent).
- **Into the quality scan.** `coord/scripts/quality-scan.js` consumes the same
  findings (via `arch-checks.runChecks`) and `planTickets` to file governed
  follow-up tickets for escalated findings. A native dimension that produces
  findings is automatically eligible for this path.

**Bounded subprocess execution is mandatory for any external adapter.** No
external tool may hang the gate. Follow the **COORD-129 process-group-kill
pattern**: spawn the tool as its own process *group* (`{ detached: true }`) so a
negative-pid `kill` reaches the whole tree including grandchildren, bound it with
a timeout, and SIGKILL the group on timeout. `gate.sh` additionally tracks heavy
children in the gate-proc registry (`coord/scripts/gate-proc-registry.js`,
`gate_spawn_tracked`) with a `trap … EXIT` cleanup, so an orphaned tool process
is detectable by `gov doctor` and reapable by `gov reap-gate-procs`. A new heavy
adapter launches under `gate_spawn_tracked` and must be bounded — a tool that can
run unboundedly is not gate-ready until it is wrapped this way.

## 3. Worked example — adding a SAST dimension (Semgrep)

A sketch of adding **one** external-adapter dimension end to end. The sketch
below is the original orientation pseudocode; the dimension is now **implemented**
in `coord/scripts/sast-policy.js` (COORD-132) — see the implemented note after
the COORD-131 block in §4.

**Adapter shape** (`coord/scripts/sast-policy.js`, mirroring `audit-policy.js`):

```js
// 1. run tool X (BOUNDED, own process group — COORD-129)
//    semgrep --json --config auto <repoRoot>   ->  captured stdout
// 2. parse output -> findings[]
function parseSemgrepFindings(sarifOrJson) {
  return (sarifOrJson.results || []).map((r) => ({
    check: "sast",
    file: r.path,
    value: r.check_id,                 // the rule id
    severity: r.extra.severity === "ERROR" ? "fail" : "warn",
    message: `${r.check_id}: ${r.extra.message} (${r.path})`,
  }));
}
```

**Stable key choice.** The dimension's identity is the *rule firing at a code
location*, independent of line drift. Define `stableFindingDetail` for `sast` as
the **rule id + normalized message** (omitting line/column), so
`stableFindingKey` becomes `sast:<normalized-path>:<rule-id>:<msg>`. A purely
cosmetic edit above the finding does not mint a new key.

**Ratchet wiring.** Compute the finding set on `HEAD` and on the base ref, then:

```js
const { newFindings, preExistingFindings } =
  classifyFindingsAgainstBaseline(current, base);   // reused from arch-checks
const summary = summarizeRatchet(current, cfg, fileCount, base);
// summary.result === "fail" only if a NEW finding has severity "fail"
```

The repo turns Semgrep on in `ratchet` mode; its existing findings are recorded
as pre-existing and the gate blocks only newly-introduced ones.

**gate.sh registration.** Add a `step "SAST (semgrep)"` that runs the adapter
under `gate_spawn_tracked` with a timeout, captures the summary JSON, and emits
it under a new `"sast"` field in the gate artifact (with a skip-reason when
Semgrep is not installed, exactly like the audit/coverage steps).

**Evidence.** The `sast` summary in the gate artifact flows into conformance so
the SAST verdict for a change is auditable alongside coverage/audit/arch.

## 4. Prioritized roadmap

Each dimension below is registered as a **deferred** backlog ticket. They follow
this contract: a stable-keyed finding shape, native or adapter implementation,
a verdict mode, ratchet on-ramp via COORD-126's
`classifyFindingsAgainstBaseline` / `summarizeRatchet`, evidence in the gate
artifact, and bounded execution per COORD-129.

| # | Dimension | Gap it closes | Suggested tool(s) | Verdict mode | Ticket |
|---|-----------|---------------|-------------------|--------------|--------|
| 1 | **Correctness** ✅ | Coverage is a weak proxy for correctness — the #1 static gap | Stryker (mutation) + fast-check (property-based) | threshold + ratchet | COORD-131 |
| 2 | **SAST** ✅ | No security-focused static analysis (injection, taint, unsafe APIs) | Semgrep / CodeQL | ratchet | COORD-132 |
| 3 | **Supply chain** ✅ | No SBOM; no transitive-CVE scan beyond `npm audit` | CycloneDX (SBOM) + Trivy / Grype (CVE) | threshold + ratchet | COORD-133 |
| 4 | **Accessibility** ✅ | No a11y or visual-regression enforcement for frontends | axe-core / pa11y + visual regression | ratchet | COORD-134 |
| 5 | **Performance** ✅ | No enforced performance / size budgets | size-limit + Lighthouse CI + k6 | threshold + ratchet | COORD-135 |
| 6 | **Component-library convergence** ✅ | UI/logic divergence across repos | Shared package + extraction-tuned duplication gate | ratchet (duplication) | COORD-136 |
| 7 | **Review-lens hardening** ✅ | Semantic/domain correctness — the non-static gap | Diverse/adversarial review lenses (evidence) | n/a (evidence, not a gate) | COORD-137 |

**Implemented (COORD-131) — dimension #1, the FIRST external-tool adapter.**
`coord/scripts/mutation-policy.js` is the worked Stryker adapter, built exactly
on the §2.3(b)/§3 pattern (mirroring `audit-policy.js`/`coverage-policy.js`):
*detect → run (bounded) → parse → verdict → evidence*. Its non-negotiable
property is **optionality** — the engine has zero runtime deps and Stryker/
fast-check are NOT added to any `package.json`. `detectTool(repoRoot)` looks for a
`stryker.conf.*` config AND a resolvable `node_modules/.bin/stryker`; when either
is absent the adapter returns `result: "skip"` with a reason and **never fails the
gate**. The verdict is selectable (mirroring `archGate`): `threshold` (mutation
score below `GATE_MUTATION_MIN`, default 60, fails — `coverage-policy` style) or
`ratchet` (reusing COORD-126 `classifyFindingsAgainstBaseline` +
`summarizeRatchet` on the survived-mutant finding set, failing **only on NEW
survivors** vs the base ref's report). One finding is emitted per survived /
no-coverage mutant; its stable key resolves through `arch-checks.stableFindingKey`
to `mutation:<file>:<mutatorName>` (line omitted ⇒ churn-robust). The heavy
Stryker run is bounded by the **COORD-129 process-group-kill** pattern
(`runStrykerBounded` spawns `{ detached: true }` and `process.kill(-pid,
"SIGKILL")`s the whole group on a timeout, so a hung run is *skipped*, never a
hang/fail). The `mutation` summary is emitted as a new gate-artifact field by
both `backend|frontend/scripts/gate.sh` as an **opt-in** step (`GATE_MUTATION_ENABLED=1`),
so an adopter enables it via config and absent config ⇒ the step is skipped and
the default gate is unperturbed. fast-check is the companion *authoring* practice
(property tests run under the normal unit-test step); the mutation score is the
gate signal proving those tests are strong.

**Implemented (COORD-132) — dimension #2, SAST (the second external-tool adapter).**
`coord/scripts/sast-policy.js` is the worked Semgrep adapter, built on the same
§2.3(b)/§3 pattern as `mutation-policy.js`: *detect → run (bounded) → parse →
verdict → evidence*. Optionality is non-negotiable — the engine has zero runtime
deps and **Semgrep is NOT added to any `package.json`**. `detectTool(repoRoot)`
resolves the `semgrep` binary from `SEMGREP_BIN`, the repo-local
`node_modules/.bin`, or `PATH` (system install — pip/brew/CI image); when it does
not resolve the adapter returns `result: "skip"` with a reason and **never fails
the gate**. It parses Semgrep **SARIF** (`runs[].results`) — and the legacy
`--json` `results[]` shape — into the uniform finding shape (one finding per
result; `level: error ⇒ severity fail`, else `warn`). The stable key resolves
through `arch-checks.stableFindingKey` to
`sast:<file>:<rule-id>::<normalized-message>`: the identity packs `rule-id` +
`normalizeMessage(message)` into `finding.value`, where the message is normalized
(lowercased, quoted snippets / line-col / bare numbers stripped, whitespace
collapsed) so per-instance churn does not mint a new key — exactly the documented
`rule-id:file:normalized-message`, line/column omitted (churn-robust). The verdict
is **RATCHET BY DEFAULT** (reusing COORD-126 `classifyFindingsAgainstBaseline` +
`summarizeRatchet` on the finding set, failing **only on NEW fail-class findings**
vs the base ref's report) so a repo with legacy security debt opts in without
going red; an optional `threshold` severity-floor mode is also offered. The heavy
Semgrep run is bounded by the **COORD-129 process-group-kill** pattern
(`runSemgrepBounded` spawns `{ detached: true }` and `process.kill(-pid,
"SIGKILL")`s the whole group on a timeout, so a hung run is *skipped*, never a
hang/fail). The `sast` summary is emitted as a new gate-artifact field by both
`backend|frontend/scripts/gate.sh` as an **opt-in** step (`GATE_SAST_ENABLED=1`,
mode `GATE_SAST_MODE`, rule pack `GATE_SAST_CONFIG` default `auto`), so an adopter
enables it explicitly and absent config ⇒ the step is skipped and the default gate
is unperturbed.

**Implemented (COORD-133) — dimension #3, Supply chain (the third external-tool adapter).**
`coord/scripts/supply-chain-policy.js` is the worked CycloneDX-SBOM + Trivy/Grype
CVE adapter, built on the same §2.3(b)/§3 pattern as `mutation-policy.js` /
`sast-policy.js`: *detect → run (bounded) → parse → verdict → evidence*. It does
two things. **(a) SBOM emission** is a DEPENDENCY-FREE CycloneDX 1.4 BOM generated
directly from the repo's `package-lock.json` (`buildCycloneDxSbom` — handles
lockfileVersion 2/3 `packages` and legacy v1 `dependencies`, one `library`
component per package with a `pkg:npm/...` purl, deterministic purl-sorted order);
it needs no external tool and is therefore always best-effort available. **(b) CVE
scan** is strictly tool-gated: `detectTool(repoRoot)` resolves a `trivy` or `grype`
binary from `TRIVY_BIN`/`GRYPE_BIN`, the repo-local `node_modules/.bin`, or `PATH`
(`GATE_SUPPLY_CHAIN_SCANNER` forces one); when neither resolves the CVE verdict
returns `result: "skip"` with a reason and **never fails the gate**. It parses
**Trivy** (`Results[].Vulnerabilities[]`) and **Grype** (`matches[]`) JSON into the
uniform finding shape (one finding per advisory×package×version;
`HIGH`/`CRITICAL` ⇒ `severity fail`, else `warn`). The stable key resolves through
`arch-checks.stableFindingKey` to `supply_chain:<package>:<advisory-id>::<version>`
— the documented **advisory-id:package:version** three-tuple (advisory id
upper-cased, the same advisory on the same package@version deduped to one finding,
a different version kept distinct). The verdict supports BOTH modes: **RATCHET BY
DEFAULT** (reusing COORD-126 `classifyFindingsAgainstBaseline` +
`summarizeRatchet`, failing **only on NEW advisories** vs the base ref's report) so
a repo with legacy/un-upgradable transitive CVEs opts in without going red, and a
**THRESHOLD** severity-floor mode (default `high` ⇒ HIGH+CRITICAL fail) for repos
that want an absolute bar. The heavy scan is bounded by the **COORD-129
process-group-kill** pattern (`runScannerBounded` spawns `{ detached: true }` and
`process.kill(-pid, "SIGKILL")`s the whole group on a timeout, so a hung run is
*skipped*, never a hang/fail). The `supply_chain` summary is emitted as a new
gate-artifact field by both `backend|frontend/scripts/gate.sh` as an **opt-in**
step (`GATE_SUPPLY_CHAIN_ENABLED=1`, mode `GATE_SUPPLY_CHAIN_MODE`, floor
`GATE_SUPPLY_CHAIN_THRESHOLD`), so an adopter enables it explicitly and absent
config ⇒ the step is skipped and the default gate is unperturbed. The generated
SBOM is NEVER committed (the CLI's `--sbom-out` writes it only to a transient
path). **Security-audit roadmap cross-reference:** this dimension is the
gate-level half of the SBOM / dependency-finding receipts the enterprise security
& procurement hardening path calls for — see
`coord/product/ENTERPRISE_DEVELOPMENT_LANDSCAPE_PLAN.md` ("security scan outputs
such as SARIF, SBOM, dependency findings") and **COORD-180** (enterprise hardening
path), where these `supply_chain` summaries + emitted SBOMs flow into conformance
as auditable supply-chain evidence.

**Implemented (COORD-134) — dimension #4, Accessibility (the FRONTEND-targeted external-tool adapter).**
`coord/scripts/a11y-policy.js` is the worked pa11y/axe-core a11y-scan + visual-
regression adapter, built on the same §2.3(b)/§3 pattern as `mutation-policy.js` /
`sast-policy.js` / `supply-chain-policy.js`: *detect → run (bounded) → parse →
verdict → evidence*. It does two things. **(a) A11Y SCAN** wraps pa11y or an
axe-core runner (whichever resolves) and parses both shapes — pa11y `issues[]`
(type error/warning/notice) and axe-core `violations[].nodes[]` (impact
critical/serious/moderate/minor) — into the uniform finding shape (one finding per
rule×selector/route; error / critical / serious ⇒ `severity fail`, else `warn`).
**(b) VISUAL REGRESSION** is modelled as a snapshot-diff finding (route → changed
beyond threshold) under a synthetic `visual-regression` rule id, INGESTED from a
configured runner / fixture diff report and ratcheted TOGETHER with the a11y scan —
the actual image diffing stays tool-gated (NO pixel-diff library is bundled; an
absent report ⇒ the a11y scan stands alone). Optionality is non-negotiable — the
engine has zero runtime deps and **pa11y / axe-core / playwright are NOT added to
any `package.json`**. `detectTool(repoRoot)` resolves a `pa11y` or `axe` binary
from `PA11Y_BIN`/`AXE_BIN`, the repo-local `node_modules/.bin`, or `PATH`
(`GATE_A11Y_RUNNER` forces one); when neither resolves the adapter returns
`result: "skip"` with a reason and **never fails the gate** — a frontend with no
a11y tooling configured passes unchanged. The stable key resolves through
`arch-checks.stableFindingKey` to `a11y:<route>:<rule-id>::<normalized-selector>`
— the documented **rule-id:selector-or-route** identity (selector normalized:
volatile `:nth-child(N)` / `[N]` index detail and query-strings stripped, route
carried in `finding.file`), so a row reorder or numeric-id churn does not mint a
new key. The verdict is **RATCHET BY DEFAULT** (the ticket says ratchet — reusing
COORD-126 `classifyFindingsAgainstBaseline` + `summarizeRatchet`, failing **only on
NEW violations** vs the base ref's report) so a frontend with legacy a11y debt opts
in without going red; an optional `threshold` severity-floor mode is also offered.
The heavy scan is bounded by the **COORD-129 process-group-kill** pattern
(`runA11yBounded` spawns `{ detached: true }` and `process.kill(-pid, "SIGKILL")`s
the whole group — including headless-browser grandchildren — on a timeout, so a
hung run is *skipped*, never a hang/fail). The `a11y` summary is emitted as a new
gate-artifact field by `frontend/scripts/gate.sh` (FRONTEND gate only — this
dimension targets coord-ui + adopter frontends) as an **opt-in** step
(`GATE_A11Y_ENABLED=1`, mode `GATE_A11Y_MODE`, target `GATE_A11Y_TARGET`, visual
report `GATE_A11Y_VISUAL_REPORT`), so an adopter enables it explicitly and absent
config ⇒ the step is skipped and the default gate is unperturbed.

**Implemented (COORD-135) — dimension #5, Performance budgets (the FIFTH external-tool adapter).**
`coord/scripts/perf-budget-policy.js` is the worked size-limit + Lighthouse CI + k6
adapter, built on the same §2.3(b)/§3 pattern as `mutation-policy.js` /
`sast-policy.js` / `supply-chain-policy.js` / `a11y-policy.js`: *detect → run
(bounded) → parse → verdict → evidence*. It wraps THREE sub-tools, each modelled as
configurable BUDGETS the adapter checks against tool output: **(a) size-limit** —
BUNDLE-SIZE budgets (a named bundle's bytes vs a `sizeLimit` / configured max, parsed
from size-limit's `--json` `[{ name, size, sizeLimit }]` array); **(b) Lighthouse CI**
— WEB-VITAL budgets (LCP/CLS/TBT/FCP/TTI per route, parsed from LHCI
`assertionResults[]` `actual` vs `expected`, or a raw LHR `audits[metric].numericValue`
vs a configured budget); **(c) k6** — LOAD budgets (a metric aggregate like
`http_req_duration` `p(95)` per endpoint tag vs an SLO, parsed from the k6
`--summary-export` `metrics` map, with a failed k6 `thresholds` entry also marking the
budget over). Optionality is non-negotiable — the engine has zero runtime deps and
**none of size-limit / @lhci/cli / k6 is added to any `package.json`**.
`detectTool(repoRoot)` resolves whichever sub-tool(s) are configured + available from
their env overrides (`SIZE_LIMIT_BIN` / `LHCI_BIN` / `K6_BIN`), the repo-local
`node_modules/.bin`, or `PATH` (`GATE_PERF_TOOL` forces one); when NONE resolves the
adapter returns `result: "skip"` with a reason and **never fails the gate** — a repo
with no perf tooling configured passes unchanged. The stable key resolves through
`arch-checks.stableFindingKey` to `perf:<target>:<budget-name>::budget` — the
documented **budget-name:target** identity (e.g. `bundle-main:size` ⇒
`perf:size:bundle-main`, `lcp:/route`, `load-p95:/endpoint`), with the measured value
and budget number deliberately OMITTED from the identity so a value/budget drift does
not mint a new key (ratchet tracks the budget, not its current number). The verdict is
selectable: **THRESHOLD BY DEFAULT** (the natural primary for budgets — fail if any
measured value EXCEEDS its configured budget max) and **RATCHET** (regression vs base —
reusing COORD-126 `classifyFindingsAgainstBaseline` + `summarizeRatchet`, failing only
on a budget that became NEWLY over-budget vs the base ref's report, so a repo with a
legacy over-budget metric opts in without going red). The heavy Lighthouse/k6 run is
bounded by the **COORD-129 process-group-kill** pattern (`runPerfBounded` spawns
`{ detached: true }` and `process.kill(-pid, "SIGKILL")`s the whole group — including
headless-Chrome / k6-VU grandchildren — on a timeout, so a hung run is *skipped*, never
a hang/fail). The `perf` summary is emitted as a new gate-artifact field by both
`backend|frontend/scripts/gate.sh` as an **opt-in** step (`GATE_PERF_ENABLED=1`, mode
`GATE_PERF_MODE`, sub-tool `GATE_PERF_TOOL`, target `GATE_PERF_TARGET`, budgets map
`GATE_PERF_BUDGETS`), so an adopter enables it explicitly and absent config ⇒ the step
is skipped and the default gate is unperturbed.

**Implemented (COORD-136) — dimension #6, Component-library convergence (NOT an external-tool adapter — a build/convergence concern + an extraction-tuned native gate).**
Unlike COORD-131..135 this dimension is two halves working together, neither of
which is a new checker. **(a) The build/convergence half** is the
**`packages/shared`** package (`@coord/shared`): a real, zero-runtime-dependency
package that is the CANONICAL home for cross-repo shared utilities/components, so
currently-duplicated logic (the frontend, the coord-ui app, and the backend each
grow their own drifting copy of byte-formatting / truncation / result-wrapping
utilities) has *somewhere to go*. It exports `formatBytes` / `truncate` /
`pluralize` (`src/format.js`) and `ok` / `err` / `attempt` / `mapResult`
(`src/result.js`) as representative shared logic, with a README codifying the
convergence intent. **(b) The extraction-pressure half** is an EXTRACTION-TUNED
profile on the existing `arch-checks` **duplication** dimension — added WITHOUT
changing the default gate. The default stays exactly as shipped (`minLines: 12`,
single intra-repo corpus, warn); the tuned profile lives in a SEPARATE nested
`duplication.extractionTuned` config block (`{ minLines: 6, severity: "warn",
crossRepoOnly: true }`) consumed only via the new opt-in entry points
`extractionTunedConfig(override)` / `runCrossRepoDuplication({ files, config,
baselineFindings })` and the pure `checkCrossRepoDuplication(...)`. Two knobs
differ from the default: a **LOWER `minLines`** (more sensitive — catches the
smaller drifting copies the default misses) and a **CROSS-REPO corpus** — files
carry a `repo` tag (inferred from the leading path segment when omitted) and in
`crossRepoOnly` mode a duplicated region is flagged ONLY when its canonical copy
lives in a DIFFERENT repo (e.g. `frontend/` vs the coord-ui app vs `backend/`);
intra-repo duplication stays the default gate's job. Each cross-repo finding is
tagged `[cross-repo: A->B] — extract to packages/shared`. The verdict is
**RATCHET** (reusing COORD-126 `classifyFindingsAgainstBaseline` /
`summarizeRatchet` on the cross-repo finding set, keyed by the same
`stableFindingKey` region hash): pre-existing cross-repo divergence is
frictionless and the gate fails only on NEW cross-repo duplication, pressuring
that new logic toward `packages/shared`. The default arch gate, every existing
arch-checks test, and all default consumers (`quality-scan`, the cockpit) are
unperturbed.

## 5. The boundary

Two things are explicitly **out of scope** for static dimensions:

- **Semantic / domain correctness is not gate-able.** Whether a feature does the
  *right* thing for the business is not mechanically decidable. It is carried by
  the **evidence-gated review cycle** — diverse and adversarial review lenses
  (contract/state, auth/security/failure, tests/operability, requirement
  closure, adversarial misuse) recorded as auditable evidence. Dimension #7
  (COORD-137) hardens this path; it is *not* a checker, and no checker can
  replace it. The harness's honest claim is that it holds the line on debt and
  drift, and that semantic correctness is enforced by evidence, not by a gate.

  **Implemented (COORD-137).** The canonical lens set is now codified as data in
  `coord/scripts/review-lens-catalog.js` (`REVIEW_LENS_CATALOG`): the five
  diverse, adversarial lenses — contract/state invariants, auth/security/failure
  modes, tests/operability/performance, requirement closure, and (advisory)
  adversarial misuse — each with a short `probe` of what it must interrogate.
  `governance-validation.js` classifies recorded review cycles through that
  catalog (`classifyLensBuckets`), so the move-review lens-coverage signal and
  the catalog share one source of truth. The catalog also exposes an **advisory**
  `assessLensCoverage(cycles)` helper that reports covered vs. missing lenses
  (splitting required vs. advisory) without introducing any new hard gate — true
  to "carried as evidence, not a checker". The lenses are surfaced to reviewers
  via the `code-reviewer` skill (`.claude/commands/code-reviewer.md`), which adds
  a fifth adversarial-misuse review pass and points at the catalog.

- **Component libraries are a build/convergence concern, not a checker.**
  Divergent UI/logic across repos is solved by extracting a shared package and
  tuning the existing duplication dimension (lower `minLines`, a cross-repo
  reference corpus) to apply *extraction pressure* — not by inventing a new
  checker that asserts "use the library". Dimension #6 (COORD-136) captures this:
  the build provides the shared package; the duplication gate (in ratchet mode)
  keeps divergence from growing.
