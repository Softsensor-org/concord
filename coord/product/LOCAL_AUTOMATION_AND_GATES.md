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
