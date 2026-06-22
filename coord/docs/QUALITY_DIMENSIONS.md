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

A sketch of adding **one** external-adapter dimension end to end. This is
pseudocode for orientation; it is **not implemented in this ticket**.

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
| 1 | **Correctness** | Coverage is a weak proxy for correctness — the #1 static gap | Stryker (mutation) + fast-check (property-based) | threshold + ratchet | COORD-131 |
| 2 | **SAST** | No security-focused static analysis (injection, taint, unsafe APIs) | Semgrep / CodeQL | ratchet | COORD-132 |
| 3 | **Supply chain** | No SBOM; no transitive-CVE scan beyond `npm audit` | CycloneDX (SBOM) + Trivy / Grype (CVE) | threshold + ratchet | COORD-133 |
| 4 | **Accessibility** | No a11y or visual-regression enforcement for frontends | axe-core / pa11y + visual regression | ratchet | COORD-134 |
| 5 | **Performance** | No enforced performance / size budgets | size-limit + Lighthouse CI + k6 | threshold + ratchet | COORD-135 |
| 6 | **Component-library convergence** | UI/logic divergence across repos | Shared package + extraction-tuned duplication gate | ratchet (duplication) | COORD-136 |
| 7 | **Review-lens hardening** | Semantic/domain correctness — the non-static gap | Diverse/adversarial review lenses (evidence) | n/a (evidence, not a gate) | COORD-137 |

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

- **Component libraries are a build/convergence concern, not a checker.**
  Divergent UI/logic across repos is solved by extracting a shared package and
  tuning the existing duplication dimension (lower `minLines`, a cross-repo
  reference corpus) to apply *extraction pressure* — not by inventing a new
  checker that asserts "use the library". Dimension #6 (COORD-136) captures this:
  the build provides the shared package; the duplication gate (in ratchet mode)
  keeps divergence from growing.
