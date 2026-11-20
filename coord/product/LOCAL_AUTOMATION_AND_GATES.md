# Local Automation and Gate Contract

This is the canonical local automation and gate runner contract for the project.

Replace this stub with your project-specific gate runner configuration.

## Purpose

This file defines how quality gates from `coord/product/TESTING_AND_GATES.md` are executed locally by agents and in CI. It is referenced by `coord/GOVERNANCE.md` Section 9 (Review Gate).

## Governed ADR Command Paths

`gov adr list|show|check|new|link|supersede` defaults to `docs/decisions`
inside the governed `coord` installation containing the invoked CLI, independent
of the caller's current directory. Run the canonical CLI for canonical writes;
this path selection does not bypass the ephemeral-worktree write barrier.
Read-only `list|show|check` commands accept an explicit caller-relative or
absolute `--dir`, including `--dir coord/docs/decisions`. Mutating `new|link|supersede`
commands accept an explicit directory only when it resolves to the configured
governed decisions directory; callers cannot use `--dir` to write outside the
journaled ADR tree. The standalone product `adr-validate` command retains its
project-directory interface. No ADR records are migrated or approved by
selecting a directory.

When upgrading a workspace whose last journal snapshot predates ADR tracking,
the first governed mutation may report the existing ADR files and registry as
unproven drift. Start with the read-only `gov doctor`, then run
`gov reconcile --dry-run --reason "inspect pre-upgrade ADR baseline"`. Inspect
every reported path and its current bytes or SHA-256 against the reviewed ADR
inventory, and resolve any unexpected or changed file before proceeding. The
dry run's `expect_paths_packet` lists every path the reconcile would adopt as
`<sha256|absent> <coord-relative path>`; that list (or a markdown evidence
packet whose table has `path` and `sha256` columns with repo-relative
`coord/...` paths, such as
`coord/docs/evidence/COORD-722-adr-baseline-packet.md`) is the approval
packet. A human administrator approves that exact packet, and the reconcile
binds to it:
`gov reconcile --reason "adopt reviewed pre-upgrade ADR baseline"
--human-admin-override "<approval for these exact changes>"
--expect-paths-file <approved packet>`. The packet is REQUIRED whenever the
override is (semantic drift or a missing baseline): an override without it is
refused, and the reconcile also refuses, adopting nothing, if any drifted path
is missing from the packet, any packet path is not drifted, or any byte
differs from the approved SHA-256. Lock/session-only drift still reconciles
with `--reason` alone. Run `gov doctor` again and verify the seal is clean
before the next governed write. This is an explicit one-time adoption of the
reviewed bytes; the system never silently adopts them, and later out-of-band
changes still require the same review.

## Prompt reference paths

`gov register-prompt --path` (or `--prompt`) and `gov file-ticket --prompt`
store workspace-relative prompt-index references, independent of the control-plane
Git root. Unqualified `coord/prompts/...` is a reserved installed-workspace
namespace from every cwd, even when its target is missing. A different existing
caller-relative candidate makes that spelling ambiguous and is refused, including
with `--force`; the command never guesses which existing file was intended.
Use `./...`, `../...`, or an absolute path to select a caller-relative or absolute
target explicitly. Other relative paths remain caller-relative. Canonical
references cannot traverse outside `coord/prompts`; use an explicit path instead.

Without a path, prompt creation uses the installed canonical ticket prompt
directory, not cwd. Existing registration mappings and deliberate remap/replace
guards remain in force. `file-ticket --prompt` without `--with-prompt` or a prompt
template only records the normalized reference: it never creates a file, and
normal board validation still requires an existing prompt. These rules do not
change ADR `--dir` semantics or
authorize repairing a registry based on a missing or wrongly rooted read.

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
(single-sourced in `coord/engine/scripts/governance-constants.js` `GATE_LANES`).
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
`coord/engine/scripts/governance-constants.js`); `default` is rejected as weaker than
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
