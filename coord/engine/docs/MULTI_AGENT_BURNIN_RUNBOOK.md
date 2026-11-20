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

Run this once per agent, with a **distinct `COORD_SESSION_ID` per agent** and
from that agent's governed worktree/runtime so the fleet stays isolated (see
the topologies doc for why this is authoritative). Do not bind several agents
to one shared checkout/runtime; the co-located-session guard refuses that by
default. `--allow-shared-worktree` is only for deliberate single-agent/local or
orchestrator-controlled exceptions where the operator accepts the risk.

This worktree instruction applies to implementation and repo-local operations.
A pack-only `request-context` is a canonical-authority write: follow §7 and
ADR-0002, submit it from the orchestrator-provided canonical checkout with the
existing owner session, and do not attempt it from the ephemeral worktree.

```sh
# 1. Bind this session to its agent and CONFIRM the binding took.
COORD_SESSION_ID=<sid> coord/scripts/gov claim --owner <handle> --force
COORD_SESSION_ID=<sid> coord/scripts/gov agentid     # must report <handle> — STOP if not

# 2. Start the ticket. Repo-backed code gets an isolated worktree automatically;
#    repo-X coord work gets a real coord git worktree with its own coord/.runtime.
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

**Repo-`X` self-modification is split by surface.** Tickets that declare safe
coord code/doc surfaces, such as `coord/scripts/`, `coord/docs/`,
`coord/product/`, `coord/ui/`, or the root agent/governance guide files, may be
scheduled in the same wave when those declared files are disjoint. This gives
coord-owned framework work the same practical fan-out model product repos use.

Global coordination state remains single-writer. Tickets that touch the board,
journal/runtime state, locks, prompt registry files, rendered derived artifacts,
or tickets with no declared file surface are still scheduled alone. Do not fan
out those stateful repo-`X` changes; serialize the cluster and land one before
starting the next.

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
- **Nested ticket worktrees need `npm ci` before UI suites.** A ticket worktree
  under `coord/.worktrees/<handle>/<ID>/` does not carry installed dependencies.
  Run `cd <worktree>/frontend/apps/coord-ui && npm ci` before the coord-ui suites
  (`blocked-reason`, `board-counts`, `business-documents`, `requirements-overflow`
  and similar). Without it they fail with `ERR_MODULE_NOT_FOUND` (typescript,
  react-dom); that is an environment gap, not a product failure.
- **Engine pin and manifest regeneration run the worktree's own scripts.** Run
  them with the worktree as cwd, never ROOT's `coord/scripts/gov`:
  `cd <worktree> && node coord/scripts/template-sync-discovery.js --write` and
  `cd <worktree> && COORD_SESSION_ID=<sid> coord/scripts/gov verify-engine --pin`.
  The write commands target the coord directory of the script they invoke, so
  running ROOT's copies changes the canonical checkout. After running them, check
  `git -C <ROOT> status --short coord/engine-pin.json coord/TEMPLATE_SYNC_MANIFEST.json`
  and restore ROOT with `git -C <ROOT> checkout -- <those files>` if it changed.
- **Full-gate sharding uses the policy wrapper.** The raw runner
  (`node coord/scripts/test-runner.js`) refuses `--shards` unless it also gets
  `--qualification-stage` and `--policy-stage`. Shard the resolved full gate through
  the policy wrapper instead: `coord/scripts/gov test-policy run --stage <stage>
  --base origin/dev --shards auto --out <dir>`. `--shards` accepts `auto` or a
  positive integer and only applies to a complete resolved full gate or an exact
  resolved selection; the set is partitioned, never narrowed or expanded.
- **Gate duration.** A serial full gate takes about 37 minutes per Node lane
  (measured 2026-11-12 on the Node 22.8.0 lane at d393ce45). Two files dominate
  wall time: `coord/engine/scripts/missing-ticket-lock.test.js` (about 4.7 min) and
  `coord/engine/scripts/integration-authority.test.js` (about 4.2 min). Plan for that
  duration, and do not run a full gate inside a `gov` burst, which holds the
  host-wide lock for its whole run.

## 7. Wired dispatch loop (manifest-driven — the primary path)

The five token-economics levers (`TOKEN_ECONOMICS.md`) are composed into one
deterministic **dispatch manifest** by `gov dispatch-plan`, and consumed by the
provider-agnostic reference harness `coord/engine/scripts/dispatch.mjs`. This replaces
the hand-clustered recipe in §1 with a mechanical loop; coord still does **not**
spawn agents (it cannot and must not own execution) — the harness emits the
exact orchestrator actions, and your orchestrator runs them.

```sh
# Emit the manifest (deterministic, hash-stable; identical board -> identical bytes):
coord/scripts/gov dispatch-plan --json            # machine surface
coord/scripts/gov dispatch-plan --md              # human surface (context-pack by pointer)

# Or run the reference harness, which loads the manifest and prints the loop:
node coord/engine/scripts/dispatch.mjs --execution-id <stable-id>       # human-readable per-wave actions
node coord/engine/scripts/dispatch.mjs --json --execution-id <stable-id> # machine actions for your orchestrator
node coord/engine/scripts/dispatch.mjs --wave 1          # one wave at a time
node coord/engine/scripts/dispatch.mjs --manifest m.json # consume a saved manifest (offline/reproducible)
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
2. **context mode bounds the agent's operating instructions.** Every SPAWN
   carries the tier's `context_mode`. Shipped tiers use `open`; an older policy
   that omits the field remains `open`, while an unknown explicit value refuses
   manifest generation. In `pack_only`, the assembled ticket body directs the
   worker to stay within the governed context pack and declared files. Before
   unlisted exploration, the worker asks the orchestrator for the canonical
   checkout and submits `gov request-context <ID> --path <relative-path>
   --reason <text>` there using that checkout's gov entrypoint and the worker's
   same already-registered owner session and ticket lock. The orchestrator
   coordinates and serializes execution. The worker must not discover the
   canonical path by exploring. If authorized canonical execution is
   unavailable, the worker sends the ticket, relative path, and reason to the
   orchestrator and waits for authorized owner-session execution plus a
   context supplement. The orchestrator must not substitute its own identity,
   rebind the worker, or override the ephemeral-worktree guard. A refused
   ephemeral-worktree attempt is not a recorded request. Even after a
   successful request, the worker waits for the supplement before accessing
   that path. The request is a journaled observation, never an access grant.
   This is an orchestrator instruction, not an operating-system sandbox; the
   runner does not enforce filesystem isolation.
   The `context-requests --limit N` view bounds returned rows only. It currently
   reads and filters the full journal before applying the output limit, so the
   option does not bound journal scanning or memory use.
3. **context-pack as a cached prefix (lever #3).** A SPAWN's assembled prompt is
   `STABLE cached-prefix marker` + `ticket-specific body`. The stable prefix
   (governance docs, this runbook, the spec, repo conventions) is **identical
   across every ticket in a wave** — place it ONCE in a prompt-cache prefix so N
   agents share one cached preamble instead of each re-paying discovery. The
   harness exposes the marker (`coord-dispatch-stable-vN`) and references
   separately from the per-ticket body precisely so you can cache the split.
4. **tier routes the model (lever #4).** Each SPAWN carries a
   `suggestedModelClass` (`standard` vs `frontier`) and the tier-appropriate
   `evidenceDepth` (review-cycle / feature-proof / invariant minimums). Route a
   mechanical low-tier ticket to a cheaper model with lighter evidence; keep full
   rigor and a frontier model on `critical` tier.
5. **cost recorded at phase completion (lever #1).** Supply a stable execution
   id for this dispatch invocation, start each ticket with the distinct derived
   execution id shown in its manifest entry, and have the external orchestrator submit a cost callback when plan,
   implementation, and review each finish. The reference harness remains
   read-only: it does not start agents, observe provider responses, or submit
   usage itself. Use actual provider-reported usage when available. The
   corresponding governance lifecycle boundary records explicit unknown usage
   if no actual callback arrived. Unknown is not zero and does not block work.

Waves themselves come from lever #5 (`plan-waves`): wave N contains only tickets
that share no declared file and whose deps are satisfied earlier; repo-`X`
tickets are scheduled one-per-wave (no worktree isolation); unschedulable
tickets are listed in `excluded[]` — no silent drops. Land each wave before
starting the next, exactly as §3 prescribes.

### Cost-from-usage convention

The manifest prints an actual-usage callback and identifies the lifecycle
boundary that records unknown usage for each of the `plan`, `implement`, and
`review` phases. The external adapter assigns a stable
`--attempt-id` to each provider attempt. Re-delivery of the same attempt and
payload is idempotent; a new provider attempt gets a new id; changing a payload
under an existing attempt id is refused. A lifecycle-boundary unknown uses its
own `boundary:<event-id>` attempt id, so telemetry recovered later can be
submitted under the provider attempt id and resolve that phase's advisory.
The invocation id is combined with each ticket id to derive a stable,
ticket-specific `--dispatch-execution-id`; reuse that derived id across all
phases and recovery deliveries for that ticket run.

Map actual provider-reported usage into the command as follows:

| Agent-reported usage | `gov record-cost` flag |
|---|---|
| ticket id | `<ticket-id>` (positional) |
| agent handle that ran | `--agent <handle>` |
| concrete model id (the SPAWN's `suggestedModelClass` resolved to a real id) | `--model <model-id>` |
| `usage.input_tokens` (prompt/input tokens, incl. cached-prefix input) | `--input-tokens <n>` |
| `usage.output_tokens` (completion/output tokens) | `--output-tokens <n>` |
| lifecycle phase | `--phase plan|implement|review` |
| dispatch run id | `--dispatch-execution-id <stable-id>` |
| stable provider attempt id, reused for delivery retries | `--attempt-id <stable-id>` |
| attribution and usage semantics | `--measurement-source provider_reported --usage-scope phase_delta` |

```sh
# Template (the SPAWN entry prints this; substitute the agent's REAL usage):
coord/scripts/gov record-cost <ID> --agent <handle> --model <model-id> \
  --dispatch-execution-id <stable-id> --attempt-id <provider-attempt-id> \
  --measurement-source provider_reported --usage-scope phase_delta \
  --input-tokens <usage.input_tokens> --output-tokens <usage.output_tokens> --phase implement
```

When phase usage is unavailable, the `start`, `move-review`, or successful
landing/closeout command records null counters with the reason and
`lifecycle_boundary` provenance. Do not also submit a manual unknown event for
that boundary. Do not pass zero, estimate tokens from transcript size, or split
a combined total across phases. If a provider reports cumulative snapshots, mark them
`--usage-scope execution_cumulative`; reports select the latest snapshot per
execution and keep it separate from phase-delta totals. Combined-only usage uses
`--usage-scope combined_only` and stays unallocated. Prices are estimated only
when both token counters and a valid documented matching model rate are known;
an absent model, missing/unmatched rate, or unavailable usage leaves attributed
USD null. Explicitly reported USD keeps explicit-measurement provenance. Actual
usage and estimated USD remain separate fields.

`record-cost` writes the existing append-only `cost.observed` journal event —
**evidence, not a gate** — and never mutates lifecycle state. `gov cost` supports
ticket, agent, model, and phase views; it preserves unknown values and exposes
cumulative/combined accounting separately. `gov explain` shows missing or
unknown phases as advisory-only. If a run is interrupted, reuse its execution
id. Re-submit recovered payloads with their original provider attempt id. If a
phase has not reached its lifecycle boundary, explain shows it as missing; its
eventual boundary records unknown if actual telemetry is still unavailable.
That unknown record does not erase or conflict with later actual telemetry.

The repository currently has no production provider-usage callback. Tests can
exercise this contract through a simulated orchestrator adapter, but that is not
evidence that an external provider integration has adopted it.

### Bounded reviewer artifact handoff

The reference harness can assemble a reviewer body from a version-1 review
manifest without opening or scanning the checkout:

```sh
node coord/engine/scripts/dispatch.mjs --review-manifest artifacts/<ID>.review.json
```

The orchestrator prepares that manifest from the exact review diff, the active
invariant projection for the ticket, and the canonical plan record. Its fields
are `schema_version: 1`, `ticket_id`, `diff`, `declared_invariants`,
`plan_record`, and `plan_record_sha256`. The digest is SHA-256 over the exact
UTF-8 bytes of `JSON.stringify(parsedPlanRecord)` (the JavaScript serialization
of the manifest's parsed `plan_record` object); it detects a mismatch between
the manifest's record and digest but does not authenticate canonical provenance. Each
declared invariant must also occur in the supplied plan record. If the active
projection is missing, cannot be resolved, or conflicts with the record, stop
and ask the orchestrator to resolve the artifact; do not substitute raw
historical claims. The dispatcher refuses additional manifest fields and does
not discover the diff, plan, repository files, PR metadata, approvals, or
conversation context. The reviewer prompt treats the body as the complete
handoff and preserves the existing governed review and approval authority.

## 7.5 Automated concurrency burn-in (the SEALED-protocol acceptance proof)

Sections 1–7 are the *operating* runbook for driving a real fleet. This section
is the **automated proof** that the single-writer board protocol actually holds
under genuine concurrency — the acceptance gate for COORD-224. It is not a manual
recipe; it is a test the runner executes.

### What it proves

The single-writer protocol is built from these sealed pieces:

- **COORD-220** — `withBoardTransaction` / `reserveTicketId` reserve ticket IDs
  INSIDE the governance runtime lock, plus the fail-closed out-of-band bypass seal.
- **COORD-221** — `gov file-ticket` governed creator.
- **COORD-222** — the co-located-session guard refuses a second fresh governed
  writer bound to one runtime (`--allow-shared-worktree` override).
- **COORD-223** — canonical nested-lock order, idempotency-on-retry, and audited
  `collision-detected` events.
- **COORD-246** — the seal is fail-closed AND self-baselining (a completed
  mutation's own post-journal sync does not trip the next mutation).

The burn-in (`coord/scripts/concurrent-burnin.test.js`, with the child-process
mutator `coord/engine/scripts/concurrent-burnin-worker.js`) spawns **N concurrent
governed mutators as real OS child processes** (default `N=12`, in the 10–20
target band) against **ONE shared sandbox runtime** — its own `.runtime` + board
under `os.tmpdir()`, **never the live coord board/journal**. Every worker binds
the SAME `GOVERNANCE_EVENT_LOCK_DIR`, so the mkdir-based cross-process mutex
genuinely serializes them.

Each worker performs **exactly one `withBoardTransaction` ticket-create shape**:
reserve an id, push one board row, write the board
(`coord/engine/scripts/concurrent-burnin-worker.js:57-80`). That one mutation shape is
the entire experiment — read the guarantees below as scoped to it, and read
"What it does NOT prove" before generalising. It asserts these five protocol
guarantees, and no others:

1. **Zero duplicate ticket IDs** — every concurrent reservation got a distinct ID
   (`reserveTicketId`-under-lock).
2. **Zero hash-chain breaks** — `verifyGovernanceChain` PASS on the resulting
   journal (proves the runtime lock serialized appends — the original
   COORD-115/123 chain-corruption failure mode).
3. **Zero lost/clobbered board rows** — every successful create's row is present
   (no last-writer-wins clobber).
4. **Every mutation journaled exactly once** — no duplicate / missing events
   (ties to COORD-223 idempotency).
5. **Out-of-band edits rejected** — a hand-edit injected mid-burn-in trips the
   seal and is refused with a `GovernanceError`, leaving the chain intact
   (COORD-220/246 fail-closed).

### What it does NOT prove

The burn-in is a proof about **one mutation shape against local governed files**.
It is not a general licence for a shared runtime, and it does not make the
lifecycle atomic. Out of scope, explicitly:

- **Identity / session-lease behaviour.** Two fresh writers on one runtime still
  churn each other's `agent_sessions.json` leases and board claims. That churn —
  not chain corruption — is what the co-located-writer guard refuses. Known
  boundary: **COORD-689** (the guard is owner-independent and a finished
  sub-agent stays heartbeat-fresh for the whole `AGENT_SESSION_IDLE_MS` window,
  blocking unrelated lanes).
- **Directory-lock acquisition.** Known boundary: **COORD-702** — a lock
  directory created without its metadata is unreclaimable by ownership and wedges
  governed mutations for the stale window.
- **Rollback metadata.** Fixed by **COORD-698**: a failed governed mutation now
  rewrites a governed file only when its bytes actually differ, so an unchanged
  foreign lock keeps its bytes and its filesystem identity (inode, mode, mtime,
  ctime). Remaining boundary: the sweep that deletes files which appeared during
  the transaction is sound only because the runtime lock serializes governed
  mutations — atomicity is claimed inside that boundary and nowhere else, so a
  writer that does not hold the runtime lock is not protected.
- **Ticket locks, plan/render projection, and the complete start-to-closeout
  lifecycle** — none of which a single ticket-create exercises.
- **Git working files.** The transaction's restore point covers only governed
  coordination files — board, plan, questions, agents, sessions, plan records,
  prompts, rendered, lock files (`coord/engine/scripts/journal.js:94-133`). Your source
  checkout, index, branches and commits are not in that set and are not rolled
  back. Concurrent agents sharing one checkout clobber each other's working files
  with no governance signal.
- **Irreversible external effects.** A merged GitHub PR is recorded as an
  external side effect and survives the rollback by design: governed files are
  restored, the merge is not (`coord/engine/scripts/journal.js:2064-2105`).

Local governed-file mutations are serializable. Git working state and external
effects are not. See the concurrency contract in
[`MULTI_AGENT_TOPOLOGIES.md`](./MULTI_AGENT_TOPOLOGIES.md) for the operator-facing
statement of the same boundary.

It covers **both** guard postures:

- **(a) override-forced concurrency** — N concurrent governed mutators against one
  runtime → guarantees 1–4 hold under real contention. This deliberately
  exercises the LOWER protections (runtime-lock serialization, ID reservation,
  chain integrity) — the safety net beneath the guard.
- **(b) guard-refuses** — WITHOUT the override, a co-located fresh governed writer
  is REFUSED by the COORD-222 guard (the first line of defense). The caller's own
  session (same thread) is never a false-block.

### Running it

```sh
# Part of the standard test gate (the runner globs coord/scripts/*.test.js):
env -u COORD_SESSION_ID node --test coord/scripts/concurrent-burnin.test.js

# Bound the agent count anywhere in the 10–20 band (default 12):
env -u COORD_SESSION_ID COORD_BURNIN_N=16 node --test coord/scripts/concurrent-burnin.test.js
```

> The `env -u COORD_SESSION_ID` prefix matters: a `COORD_SESSION_ID` exported for
> a governed session leaks into the test runner's child processes and perturbs
> identity resolution. Strip it when running the gate.

### Why it is CI-reliable (no flakes)

The assertions are on the **deterministic invariants** — the distinct-id set, the
chain-PASS verdict, all-rows-present, exactly-once events — which hold regardless
of how the OS schedules the N processes. Scheduling varies run to run; the
invariants do not. The burn-in is **bounded** (a ~12-agent, few-second run, not a
1000-agent soak), so it is fast and stable in CI. A flaky burn-in would be worse
than none, so it never asserts on timing or ordering — only on the protocol
guarantees that must hold under ANY interleaving.

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
