# Multi-Agent Burn-In Runbook

This is the *operating* runbook for driving a fleet of agents through the
governed ticket lifecycle — the companion to
[`MULTI_AGENT_TOPOLOGIES.md`](./MULTI_AGENT_TOPOLOGIES.md), which covers only the
session-identity model. The recipe below was proven in a multi-agent burn-in by
a multi-repo, main-integration, npm-based adopter: many concurrent agents landed
real PRs against a shared board. Everything here is sequencing and verification
discipline; none of it changes governance semantics.

> Conventions used below: `<handle>` is a registered agent handle, `<ID>` a
> ticket id, and `<integration-branch>` the repo's integration branch from
> `coord/project.config.js` (`integrationBranch`; the shipped template default
> is `main`, and this donor repo operates on a long-lived `feat/coord-gov-...`
> integration branch).

## 1. The proven per-agent lifecycle recipe (manual fallback)

> **Primary path:** prefer the **manifest-driven wired dispatch loop** in §7 —
> it computes waves, skips already-satisfied tickets, assembles the cache-shared
> prompt, routes the model by tier, and records cost from usage automatically.
> The hand-clustered recipe below is the **fallback** for when you are driving a
> single ticket by hand or the orchestrator is unavailable.

Run this once per agent, with a **distinct `COORD_SESSION_ID` per agent** so the
fleet stays isolated (see the topologies doc for why this is authoritative):

```sh
# 1. Bind this session to its agent and CONFIRM the binding took.
COORD_SESSION_ID=<sid> coord/scripts/gov claim --owner <handle> --force
COORD_SESSION_ID=<sid> coord/scripts/gov agentid     # must report <handle> — STOP if not

# 2. Start the ticket. Repo-backed code gets an isolated worktree automatically.
COORD_SESSION_ID=<sid> coord/scripts/gov start <ID>

# 3. DONE-CHECK FIRST (see §2), then implement to EVERY acceptance criterion.

# 4. Gate from the worktree root. Use the repo's documented command
#    (npm test / node --test / the repo's gate script). Make it pass.
npm test    # or the repo's actual test command

# 5. Record the plan with a REAL recorded gate. For code repos NEVER use a
#    `--not-required` gate — attribute pass/fail honestly:
COORD_SESSION_ID=<sid> coord/scripts/gov add-repo-gate <ID> \
  --command "<test cmd>" --result pass --base-result pass
#    plus requirement closure, feature proofs, review cycles, invariants.

# 6. Commit, then submit a PR against the integration branch.
COORD_SESSION_ID=<sid> coord/scripts/gov commit <ID> --all --message "<ID>: <subject>"
COORD_SESSION_ID=<sid> coord/scripts/gov submit <ID> --fill --base <integration-branch>

# 7. Wait for CI. Then rebase-on-DIRTY if the base moved (see §3), and land.
COORD_SESSION_ID=<sid> coord/scripts/gov land <ID> --method squash --delete-branch
```

The recorded gate is load-bearing: a code repo that closes out with a
`--not-required` gate has not actually been verified, and the audit trail will
say so. Record the exact command you ran.

## 2. Done-check-first discipline

**Before implementing, verify the ticket isn't already satisfied** in the
integration branch. Inspect the cited code sites / files named in the prompt; if
the acceptance criteria already hold, record a minimal plan citing the existing
code and close out as already-satisfied rather than rewriting working code.

External or custom boards drift from the coord board over time. A ticket that
looks open on a project's own tracker may already be landed on the integration
branch. Reconcile before launching (see §5) or you will redo landed work and
generate spurious conflicts for the agents that come after you.

## 3. File-cluster sequencing (the core fan-out rule)

Split agents by **repo + hot-file cluster**. Two agents editing the same file
will rebase-conflict; the recipe resolves that, but only cheaply if you sequence
them:

1. Identify the cluster of tickets that touch the same hot file(s).
2. Land the cluster **lead** first.
3. Fan out the siblings off the *updated* base. Siblings then only
   rebase-conflict with each other, which the recipe's rebase-on-DIRTY step
   handles (keep-both on append-only sections such as logs, indexes, and
   help-text lists).
4. **Do not dispatch overlapping umbrella tickets concurrently.** If two tickets
   own the same surface, they are a cluster, not parallel work.

When tickets are append-only against the same file (e.g. several tickets each
adding a row to an index or a case to a dispatch switch), resolve rebase
conflicts by keeping both sides — the conflict is positional, not semantic.

## 4. Worktree isolation is required for true fan-out

Real parallelism needs **per-agent worktrees**, which `gov start` creates
automatically for repo-backed code repos (`.worktrees/<handle>/<ID>`). Each
agent edits its own checkout on its own branch, so concurrent agents never step
on each other's working tree.

**Repo-`X` self-modification has no worktree isolation.** Tickets that edit the
framework itself (the `coord/` tree — governance scripts, board, docs) operate
directly on the shared donor tree. There is no per-ticket checkout to isolate
them, so **repo-`X` tickets that touch the same files MUST run strictly
sequentially**, each building on the prior commit. Do not fan them out
concurrently; serialize the cluster and land one before starting the next.

## 5. Two-board reconciliation

A project's own external tracker (e.g. a custom `tasks.json`, an issue tracker,
a spreadsheet) **is not the coord board**. Keep an explicit import/reconcile
step:

- Import the external tickets into the coord board (prompts on disk +
  registration — `gov register-prompt <ID>` registers an on-disk prompt; `gov
  start` auto-discovers `coord/prompts/tickets/<ID>.md` when present).
- Mark any work that is **already merged** on the integration branch as done on
  the coord board before launching the fleet.
- Treat the coord board as the single source of truth for lifecycle state once
  reconciled; reconcile again whenever the external board moves.

Skipping this step is the most common cause of redone work and phantom
conflicts.

## 6. Known sharp edges (with pointers)

- **git fetch-refspec for submit / land.** A repo-backed submit/land needs the
  base and the ticket branch present in the checkout doing the merge. Set the
  `gh` default repo to the correct origin/fork and fetch both the base ref and
  the branch ref before submitting; recover a partial submit by re-running with
  the existing PR URL (`--pr <url>`).
- **Jest / test-runner must ignore `.worktrees`.** Per-agent worktrees live
  under the repo (`.worktrees/<handle>/<ID>`); a test runner that globs the repo
  will otherwise descend into sibling worktrees and fail on their checked-out
  state. Add `.worktrees` to the runner's ignore patterns. (A package-manager-
  aware gate also matters: the clean-checkout gate detects pnpm/yarn/npm from the
  worktree lockfile — see `coord/scripts/governance.js`.)
- **`land` "no resolvable SHA" recovery.** If land cannot resolve a commit SHA
  for the ticket (e.g. the branch was force-updated or the source commit is not
  reachable from the checkout), re-fetch the branch ref and pass the explicit
  `--source-commit <sha>` so land has an unambiguous tip to merge.

## 7. Wired dispatch loop (manifest-driven — the primary path)

The five token-economics levers (`TOKEN_ECONOMICS.md`) are composed into one
deterministic **dispatch manifest** by `gov dispatch-plan`, and consumed by the
provider-agnostic reference harness `coord/scripts/dispatch.mjs`. This replaces
the hand-clustered recipe in §1 with a mechanical loop; coord still does **not**
spawn agents (it cannot and must not own execution) — the harness emits the
exact orchestrator actions, and your orchestrator runs them.

```sh
# Emit the manifest (deterministic, hash-stable; identical board -> identical bytes):
coord/scripts/gov dispatch-plan --json            # machine surface
coord/scripts/gov dispatch-plan --md              # human surface (context-pack by pointer)

# Or run the reference harness, which loads the manifest and prints the loop:
node coord/scripts/dispatch.mjs                   # human-readable per-wave actions
node coord/scripts/dispatch.mjs --json            # machine actions for your orchestrator
node coord/scripts/dispatch.mjs --wave 1          # one wave at a time
node coord/scripts/dispatch.mjs --manifest m.json # consume a saved manifest (offline/reproducible)
```

For each wave, in order, the loop tells the orchestrator exactly what to do per
ticket — and each step is a lever:

1. **precheck gates spawn (lever #2).** A ticket whose precheck verdict is
   `already-satisfied` is a **SKIP**: no agent runs. The manifest hands you the
   exact governed close-out command, so the skip is auditable, not silent:
   `coord/scripts/gov finalize <ID> --no-pr --already-landed --landed "<precheck evidence>"`.
   **Every other verdict — `partial`, `not-started`, `unknown`, no probes, or an
   unparseable probe file — is a SPAWN.** A missing or ambiguous signal NEVER
   produces a false skip.
2. **context-pack as a cached prefix (lever #3).** A SPAWN's assembled prompt is
   `STABLE cached-prefix marker` + `ticket-specific body`. The stable prefix
   (governance docs, this runbook, the spec, repo conventions) is **identical
   across every ticket in a wave** — place it ONCE in a prompt-cache prefix so N
   agents share one cached preamble instead of each re-paying discovery. The
   harness exposes the marker (`coord-dispatch-stable-vN`) and references
   separately from the per-ticket body precisely so you can cache the split.
3. **tier routes the model (lever #4).** Each SPAWN carries a
   `suggestedModelClass` (`standard` vs `frontier`) and the tier-appropriate
   `evidenceDepth` (review-cycle / feature-proof / invariant minimums). Route a
   mechanical low-tier ticket to a cheaper model with lighter evidence; keep full
   rigor and a frontier model on `critical` tier.
4. **cost recorded from usage (lever #1).** After each agent finishes, record its
   **actual** reported usage into the ledger using the template the SPAWN entry
   provides (see the convention below). The ledger then fills automatically and
   proves the savings in the same evidence trail.

Waves themselves come from lever #5 (`plan-waves`): wave N contains only tickets
that share no declared file and whose deps are satisfied earlier; repo-`X`
tickets are scheduled one-per-wave (no worktree isolation); unschedulable
tickets are listed in `excluded[]` — no silent drops. Land each wave before
starting the next, exactly as §3 prescribes.

### Cost-from-usage convention

Map a finished agent's reported usage into `gov record-cost` so the ledger fills
after every run. The field mapping:

| Agent-reported usage | `gov record-cost` flag |
|---|---|
| ticket id | `<ticket-id>` (positional) |
| agent handle that ran | `--agent <handle>` |
| concrete model id (the SPAWN's `suggestedModelClass` resolved to a real id) | `--model <model-id>` |
| `usage.input_tokens` (prompt/input tokens, incl. cached-prefix input) | `--input-tokens <n>` |
| `usage.output_tokens` (completion/output tokens) | `--output-tokens <n>` |
| lifecycle phase (start/implement/review/land) | `--phase implement` |

```sh
# Template (the SPAWN entry prints this; substitute the agent's REAL usage):
coord/scripts/gov record-cost <ID> --agent <handle> --model <model-id> \
  --input-tokens <usage.input_tokens> --output-tokens <usage.output_tokens> --phase implement
```

`record-cost` estimates USD from `coord/product/model-prices.json` when `--usd`
is omitted, so you only need the token counts and the model id. It is an
append-only `cost.observed` journal event — **evidence, not a gate** — and never
mutates board or lifecycle state. Read it back with `gov cost [--by ticket|agent|model] [--json]`.

## 8. Pre-flight checklist

- [ ] Each agent has a distinct `COORD_SESSION_ID`, and `gov agentid` confirms
      the bound handle.
- [ ] The external board is reconciled into the coord board; already-merged work
      is marked done.
- [ ] Tickets are split by repo + hot-file cluster; cluster leads identified.
- [ ] Repo-`X` (framework self-edit) tickets are sequenced, never fanned out.
- [ ] The test runner ignores `.worktrees`.
- [ ] Every code-repo ticket closes out with a REAL recorded gate, not
      `--not-required`.
