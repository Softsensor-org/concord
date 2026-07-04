# Local Automation and Gate Contract

This is the canonical local automation and gate runner contract for the project.

Replace this stub with your project-specific gate runner configuration.

## Purpose

This file defines how quality gates from `coord/product/TESTING_AND_GATES.md` are executed locally by agents and in CI. It is referenced by `coord/GOVERNANCE.md` Section 9 (Review Gate).

## Gate Runner Interface

Each governed repo exposes the lane-based gate interface defined in
[`coord/product/BOOTSTRAP_CONTRACT.md`](./BOOTSTRAP_CONTRACT.md). The canonical
entry point per repo is:

```bash
<repo>/scripts/gate.sh <lane>
```

Where `<lane>` is one of `default`, `full`, or `ci`. Exit code 0 = pass,
non-zero = fail. Derived projects replace the skeleton runner shipped with the
template with a real implementation that dispatches to the project's chosen
stack.

## Gate Lanes

| Lane | When to use | Source |
|---|---|---|
| `default` | Before every `doing -> review` transition | local or CI |
| `full` | Before landing or when default is insufficient | local or CI |
| `ci` | In CI pipelines for the same repo | CI |

The accepted lane vocabulary is `default | full | ci` — the same set validated by
`gov gate --lane`, implemented by `<repo>/scripts/gate.sh`, and exercised by CI
(single-sourced in `coord/scripts/governance-constants.js` `GATE_LANES`).
`extended` is a *policy* concept (deeper/release-cut coverage; see
[`TESTING_AND_GATES.md`](./TESTING_AND_GATES.md)), not an accepted `--lane`
value — a project folds that coverage into its `ci`/`full` lanes.

## Affected-Target Selection

Projects with a maintained dependency map may run an affected-target planning
step before invoking their gate runner:

```bash
coord affected-targets --files <changed-file-a,changed-file-b> \
  --map <repo>/coord/affected-targets.json --json
```

The command returns `mode=slice` only when every changed file maps to known
targets. If the map is missing, empty, stale for the changed file, or `--full`
is passed, it returns `mode=full` with the full-gate command list. Gate runners
may consume the selected commands, but they must record the selector output as
evidence so reviewers can see what was run and what was skipped.

## Artifact Storage

- Gate artifacts (reports, coverage, logs) should be stored under `coord/artifacts/gates/<repo>/`
- Artifacts are ephemeral and should not be committed to version control

## Deploy gates mirror the PR gate (QGATE-005)

A deploy pipeline runs the **same** gate contract as the PR pipeline and is
never weaker. It invokes the canonical entrypoint — `bash <repo>/scripts/gate.sh
full` (or `ci`), or `coord/scripts/gov gate <repo> --lane full` — before any
deploy step, never a hand-maintained partial command list. The accepted deploy
lanes are `full | ci` (`DEPLOY_GATE_LANES` in
`coord/scripts/governance-constants.js`); `default` is rejected as weaker than
the PR gate. The template ships:

- `.github/workflows/deploy.yml.template` — gate-contract-first deploy workflow
  (rename to `deploy.yml`, wire a real deploy target, adjust the repo matrix).
- `coord/scripts/deploy-gate-contract.test.js` — the anti-drift check that
  fails if a deploy workflow hand-rolls a partial command list instead of
  calling the canonical gate runner.

See [`TESTING_AND_GATES.md`](./TESTING_AND_GATES.md) "Deploy Gates Mirror the
PR Gate (QGATE-005)" for the full contract.

## Server bootstrap jobs are separate evidence

A deploy gate proves that the code gate ran before deployment. It does not prove
that a server-side bootstrap job, historical backfill, generated-data replay, or
startup-launched task completed safely.

Such work is governed by
[`SERVER_BOOTSTRAP_JOB_CONTRACT.md`](./SERVER_BOOTSTRAP_JOB_CONTRACT.md). In
particular, `/readyz`, "deploy succeeded", or "server started" is not sufficient
feature proof for a background/bootstrap job. The ticket must record a
job-specific receipt, marker/checkpoint evidence, rollback or disable path, and
observability evidence.

## Read-Before-Pull advisory checks (COORD-333)

Cadence, data, analytics, marketing-ops, and external-validation automation
should integrate the read-before-pull policy from
[`CONTINUITY_PROFILE.md`](./CONTINUITY_PROFILE.md) before fetching external
sources. In Phase 2 this is advisory and warning-first unless a track explicitly
opts in to enforcement.

An advisory check should read the flow's declared canonical store, prior output,
freshness window, and cursor state before a pull. It should record one of:

- `reused` when the prior output is still fresh and the cursor/source version
  supports reuse;
- `skipped` when the pull is intentionally avoided because the source is fresh,
  out of scope, waived, or scratch-only;
- `pulled` when the source is stale, unknown, expired, invalidated, explicitly
  waived, or being used for scratch exploration.

Gate and cadence readouts should include the evidence needed to audit the
decision: source contract, canonical-store reference, prior output id/version or
hash, freshness status, old and new cursor when applicable, actor/time, and
waiver or scratch-mode reason. Durability-sweep readouts should warn on
avoidable re-pulls, such as repeated external fetches with an unchanged cursor
or a still-fresh canonical output.

Local experimentation remains allowed. A local scratch run may pull or
revalidate external sources without failing gates when it is labeled scratch,
does not promote the result as durable evidence, and rechecks canonical store
and freshness policy before any promotion. Blocking behavior requires an
explicit track opt-in that names the covered flow, canonical store, freshness
policy, waiver mechanism, and gate failure mode.

## Pre-push hook and `--no-verify` (COORD-055)

A local pre-push hook may run the full `gate.sh ci` lane, which can take several
minutes. A push that appears hung is usually the hook running that lane, not a
network stall.

`git push --no-verify` bypasses the **local hook**, not governance evidence. It
is sanctioned **only** when equivalent authoritative verification has already
been run and recorded — i.e. `gov gate` (or the documented governed gate) plus
the ticket's full end-to-end verification — so the evidence exists independently
of the hook. Using `--no-verify` to skip verification that was never run is a
governance violation; using it to avoid re-running a slow hook after the same
checks already passed and were recorded is the intended operator path.

## Closing PR-backed repo-`X` (coord / cross-repo) tickets (COORD-055)

`gov land` performs a real GitHub merge (`prMerge`) and only supports
repo-backed tickets. A repo-`X` (coord-owned / cross-repo, e.g. TRUST-style)
ticket can carry PR evidence but has no repo to merge into, so `land` is a
dead-end for it. The governed closeout is:

```
coord/scripts/gov finalize <ticket-id> --pr "<pr-url>"
```

which records the PR/landing evidence and marks the ticket done with no GitHub
merge and no board hand-edits. `gov explain` recommends this command for that
state; `--no-pr --already-landed` remains the repair path for ordinary no-PR
repo-backed tickets and is **not** used here.

## Governance Integration

This file is referenced in:
- `coord/GOVERNANCE.md` Section 9 (Review Gate)
- `coord/product/TESTING_AND_GATES.md` (policy-level gate definitions)
