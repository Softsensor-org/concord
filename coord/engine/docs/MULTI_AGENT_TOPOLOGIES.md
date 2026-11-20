# Multi-Agent Topologies

coord supports running many agents against one board. Two topologies are
supported, and the only thing that differs between them — and between providers —
is **how each agent gets a distinct session identity**. Everything else (per-ticket
worktrees, per-ticket branches/PRs, the runtime lock that serializes board writes,
land-time rebase for same-repo conflicts) is identical across both.

What that machinery does and does not make safe is stated precisely — and pinned
to the code and to the COORD-224 burn-in — in
[Concurrency contract](#concurrency-contract--what-is-serialized-and-what-is-not)
below. Read it before running lanes concurrently; the short version is that local
governed-file mutations serialize, while Git working files and external effects
do not.

> This doc covers the **identity model**. For the *operating* runbook — the
> proven per-agent lifecycle recipe, done-check-first discipline, file-cluster
> sequencing, the repo-`X` no-isolation rule, two-board reconciliation, and the
> known sharp edges — see
> [`MULTI_AGENT_BURNIN_RUNBOOK.md`](./MULTI_AGENT_BURNIN_RUNBOOK.md).
>
> For the adoption boundary between today's identity/teamwork substrate and the
> future shared-continuity overlay, see
> [`CONTINUITY_CAPABILITY_MATRIX.md`](../../product/CONTINUITY_CAPABILITY_MATRIX.md).
>
> For a team-facing rollout guide that combines identity binding with
> warm-start/cold-finish, shared-vs-private memory, daily journal, cadence
> ownership, ADR links, question/decision handling, worktree/runtime isolation,
> and serialization points, see
> [`TEAM_CONTINUITY_ROLLOUT.md`](../../product/TEAM_CONTINUITY_ROLLOUT.md).

## The two topologies

1. **N independent agent sessions** — each agent is its own process / terminal /
   conversation (e.g. several `codex`, `gemini`, or `claude` CLIs, or separate
   browser conversations). Each carries its own provider-native session id, so
   coord isolates them automatically. This is the simplest and most-tested model.

2. **One orchestrator spawning N sub-agents** — a single conversation launches
   multiple sub-agents (e.g. the Claude Code Task/Agent tool). Here the sub-agents
   may *share* the orchestrator's session id, so identity must be asserted
   explicitly per sub-agent.

## Identity rule per provider

coord resolves "who am I" from a session anchor (see
`coord/engine/docs/IDENTITY_RUNTIME_EXTRACT.md`). The anchor priority is:

0. **`COORD_SESSION_ID`** — explicit, provider-agnostic, **authoritative**; overrides everything below.

### Claude governed-command permission shape

Claude Code must allow the stable leading command directly with
`Bash(coord/scripts/gov *)`. Keep the governance invocation as the first shell
command token; do not prefix it with `export`, `cd`, `&&`, or a generated
compound command. The session-start hook supplies the registered identity via
`CLAUDE_ENV_FILE`, so identity binding remains per session without a persistent
project-wide `COORD_SESSION_ID` override. If a direct `coord/scripts/gov
explain <ticket>` is denied, treat that as a governed capability blocker and
report it before attempting a closeout or handoff.
1. provider thread id — `CODEX_THREAD_ID` / `GEMINI_THREAD_ID` / `CLAUDE_CODE_SESSION_ID` (alias `CLAUDE_SESSION_ID`).
2. terminal/multiplexer env vars, then POSIX sid, then fail-closed.

| Provider | Topology 1 (independent sessions) | Topology 2 (orchestrator + sub-agents) |
|---|---|---|
| **Codex** | Works natively — each session has a distinct `CODEX_THREAD_ID`. | Set a distinct `COORD_SESSION_ID` per sub-agent if sub-agents share a thread id. |
| **Gemini** | Works natively — distinct `GEMINI_THREAD_ID` per session. | Set a distinct `COORD_SESSION_ID` per sub-agent if sub-agents share a thread id. |
| **Claude** | Works natively — two separate conversations have two distinct `CLAUDE_CODE_SESSION_ID`s. | **Requires `COORD_SESSION_ID`.** The Claude Code harness injects ONE identical `CLAUDE_CODE_SESSION_ID` into every sub-agent of a conversation, so without the override they collapse to one session and churn each other's claims. **`CLAUDE_SESSION_ID` does not help** — the harness sets it equal to `CLAUDE_CODE_SESSION_ID`, which is checked first. |

## Rules for concurrent agents (both topologies)

- Each concurrent agent must claim a **distinct registered handle**
  (`gov claim --owner <handle>`); handles are pre-registered in `coord/agents.json`.
- Each concurrent agent that needs an explicit identity must export
  `COORD_SESSION_ID` **on every `gov` invocation** (env does not persist between
  separate shell calls in some harnesses):

  ```sh
  COORD_SESSION_ID=agent-7 coord/scripts/gov claim --owner claudea42
  COORD_SESSION_ID=agent-7 coord/scripts/gov start TICKET-123
  ```

- Confirm isolation with `COORD_SESSION_ID=… coord/scripts/gov agentid` — it must
  report the handle you claimed, not a sibling's.
- Many tickets may run in the **same repo** concurrently: each gets its own
  `.worktrees/<handle>/<ticket>` checkout and its own branch/PR. If two same-repo
  PRs touch overlapping lines, the later one rebases onto the base ref and re-lands
  (see `coord/GOVERNANCE.md` §10.1).
- Linked worktrees are **ephemeral** authority contexts. They may read governance
  state and run local tests, but canonical board/journal/plan/snapshot mutation
  belongs to the integration tree and serialized merge-queue path. See
  [`ADR 0002`](../../docs/decisions/0002-canonical-ephemeral-runtime-boundary.md).

## Worked example — one orchestrator, three Claude sub-agents

```sh
# sub-agent 1
COORD_SESSION_ID=wave-a1 coord/scripts/gov claim --owner claudea41
COORD_SESSION_ID=wave-a1 coord/scripts/gov start TICKET-1
# sub-agent 2 (concurrent)
COORD_SESSION_ID=wave-a2 coord/scripts/gov claim --owner claudea42
COORD_SESSION_ID=wave-a2 coord/scripts/gov start TICKET-2
# sub-agent 3 (concurrent, same repo as 1 — fine)
COORD_SESSION_ID=wave-a3 coord/scripts/gov claim --owner claudea43
COORD_SESSION_ID=wave-a3 coord/scripts/gov start TICKET-3
```

Each resolves to its own handle and never churns the others.

## Operating model — mandatory registration + binding (enforced)

Every governed agent MUST register and bind **before** it runs any governed
mutation. The protocol, in order:

```sh
export COORD_SESSION_ID=<unique-per-agent>      # 1. distinct session identity
coord/scripts/gov agentid --assign              # 2. register a handle (claudeaNNN)
coord/scripts/gov start <ticket> --owner <registered-handle>   # 3. bind the ticket
```

This is now **enforced, fail-closed**. A governed *mutation*
(`commit`, `update-plan`, `move-review`, `finalize`, `heartbeat`,
`add-repo-gate`, `set-review-cycles`, …) refuses to proceed unless the acting
session is **both** a registered agent **and** the bound owner of the ticket.
An unregistered or unbound session is rejected with an actionable remediation:

> This session is not a registered agent / not the bound owner of `<ticket>`.
> Register with `coord/scripts/gov agentid --assign`, then bind with
> `coord/scripts/gov start <ticket> --owner <handle>` (or
> `coord/scripts/gov resume <ticket>` / `coord/scripts/gov agent-rebind --fresh`
> for handoff/collisions).

The guard is the shared `assertRegisteredBoundOwner` precondition in the engine
(`coord/engine/scripts/governance-session.js`). It closes the failure mode where work
was committed by a session that never registered/bound, so reconciliation could
not attribute the work and the ticket silently drifted back to
`todo`/`unassigned`. Read-only verbs (`explain`, `conform`, `doctor`,
`agents list`) and the binding/recovery verbs themselves (`start`, `claim`,
`resume`, `agent-rebind`, `agentid`, and administrative `recover`) are
deliberately **not** gated — they are how a session *becomes* a registered,
bound owner.

Recovery paths (all already supported):
- **Same-owner handoff / resume** — `coord/scripts/gov resume <ticket>`.
- **Identity collision / fresh rebind** — `coord/scripts/gov agent-rebind --fresh`.
- **Human-admin foreign-owner action** — `coord/scripts/gov recover <ticket>
  --human-admin-override "<reason>"` to repair while preserving the owner, or
  `coord/scripts/gov claim <ticket> --transfer-to <handle> --human-admin-override
  "<reason>"` to move it. These are the explicit paths in the collision policy
  (COORD-733); an override does not bypass live-holder checks.

## Cold-start and warm-resume protocol

Every topology uses the same boot contract. The only topology-specific
difference is how each agent gets a distinct session identity; retrieval,
planning, gates, and closeout evidence are shared.

Cold start:
1. Read the thin entry shim (`AGENTS.md`) and the tool shim for the active agent.
2. Resolve `coord/GOVERNANCE.md` authority order before following lower-level
   instructions.
3. Bind identity with `coord/scripts/gov agentid --assign`; for sub-agents that
   share provider identity, export a unique `COORD_SESSION_ID` on every `gov`
   call.
4. Claim, start, or resume through governance.
5. Retrieve minimum context before planning: `coord/scripts/gov explain
   <ticket>`, plan/prework or context-pack records, recall leads, accepted ADR
   references, requirements, business-discovery packs, and repo-local guides.
6. Plan from those artifacts, not from chat memory.
7. Execute through repo gates, review cycles, feature proofs, and closeout.

Warm resume:
- run `coord/scripts/gov resume <ticket>` or the tool-native resume command;
- rerun `coord/scripts/gov explain <ticket>`;
- read the current plan record and linked gates/proofs/decisions;
- continue only after the current owner, lock, worktree, and intended file scope
  match the session.

Durable handoff:
- chat memory is non-authoritative and must not be the only place where a
  decision, blocker, test result, ADR reference, or follow-up lives;
- write durable learning into plan records, review cycles, feature proofs, repo
  gates, ADR proposals or links, memory-claim proposals, and resolved
  questions/decisions/reflections;
- a cold-start agent tomorrow should be able to recover the ticket by reading
  governed artifacts only, without access to today's conversation.

## Implement-locally / orchestrator-publishes

Sub-agents frequently run in **sandboxed or policy-restricted** environments
where outbound network egress is blocked by design (sandbox DNS + exfiltration
classifier). In that setting a sub-agent **must not** attempt the remote publish
step. The division of labour is:

- **Sub-agent (sandboxed worker)**: do all the work, commit to a **local topic
  branch**, run the full local verification bar — but **do not** `git push` or
  `gh pr create`. Report the branch name and commit SHA back to the orchestrator.
  An attempted push will be blocked by environment policy; this is correct
  security behavior, not a bug.
- **Orchestrator (or a human)**: perform the single, approved remote operation —
  push the branch, open/merge the PR, and run closeout
  (`move-review` / `finalize`, or `finalize --already-landed` once the change is
  merged into the integration branch).

This decouples sandboxed *work* from approved external *publication*: the worker
proves the change locally; a trusted, supervised actor publishes it.

## Integration authority — one integrator per domain (COORD-915)

Registering a handle or owning a ticket never lets a session integrate. Each
coordination domain (one `coord/.runtime`) has one integration-authority holder,
recorded in `coord/.runtime/integration-authority.json`; `coord/GOVERNANCE.md`
Section 11.0 is the policy and lists what is not yet protected.

- **One orchestrator per board:** nothing changes. The orchestrator's first
  `sync`, `finalize` or `land` makes it the holder (journaled as
  `integration-grant`, `granted_via: implicit-first-integration-verb`). If any
  other agent can reach the same checkout (for example over SSH), keep it paused
  through the upgrade, run `coord/scripts/gov integration claim` as the
  orchestrator, check `coord/scripts/gov integration status`, then reopen access.
- **Orchestrator plus sub-agents or remote agents:** workers prepare in their own
  worktrees and may run their ticket verbs, but `gov sync`, the terminal verbs,
  `reconcile` and the other integration verbs refuse them, naming the holder.
  An SSH session into the canonical checkout is the same domain, not a new one.
  While the holder's operation is open (`gov integration begin <ticket>`, or a
  running terminal verb), every governed write by another session is refused.
- **Independent clones:** a clone with its own runtime is its own domain with its
  own holder. This record does not coordinate separate runtimes on other hosts or
  clones. Integrating their work into canonical goes through the canonical holder.
  An SSH session executing in the canonical checkout is not a separate domain: it
  is refused as a competing writer, which is the COORD-888 incident shape.
- **Changing integrators:** `coord/scripts/gov integration handoff --to <handle>
  --human-admin-override "<reason>"`, or `gov integration release` followed by the
  new holder's `gov integration claim`. An unfinished operation survives the
  handoff and must be verified with `gov integration recover` before the new
  holder integrates. Timeout or a vanished executor never transfers authority.

## Concurrency contract — what is serialized, and what is not

This section is the authoritative prose statement of the shared-runtime
contract, and it is kept in agreement with the executable proof
(`coord/scripts/concurrent-burnin.test.js`, COORD-224). If this section and that
test ever disagree, the test is right and this section is the defect.

### What IS serialized

Every governed mutation enters `withGovernanceMutation`
(`coord/engine/scripts/journal.js:1917`), whose first act is to take
`withGovernanceRuntimeLock`. That lock is a genuine cross-process mutex: an
`fs.mkdirSync` of `GOVERNANCE_EVENT_LOCK_DIR` that retries on `EEXIST` until it
wins or times out (`coord/engine/scripts/governance-context.js:1851-1876`). Two
governed writers on one `coord/.runtime` therefore **queue** on that mutex; they
do not interleave their journal appends.

COORD-224 proves this with 12 real OS child processes contending on one shared
sandbox runtime. It asserts exactly these five invariants, and no others:

1. **Zero duplicate ticket IDs** — every concurrent `reserveTicketId` returned a
   distinct id (`concurrent-burnin.test.js:278-284`).
2. **Zero hash-chain breaks** — `verifyGovernanceChain` PASSes on the resulting
   journal (`concurrent-burnin.test.js:297-302`).
3. **Zero lost or clobbered board rows** — every created row, plus the seed row,
   is present (`concurrent-burnin.test.js:286-295`).
4. **Every successful mutation journaled exactly once** — no duplicate and no
   missing events (`concurrent-burnin.test.js:304-318`).
5. **Out-of-band edits rejected** — a hand-edit injected mid-run trips the seal
   and is refused as a `GovernanceError`, leaving the chain intact
   (`concurrent-burnin.test.js:326-362`).

### What that proof does NOT cover

Each burn-in worker runs **one `withBoardTransaction` ticket-create shape** —
reserve an id, push one board row, write the board
(`coord/engine/scripts/concurrent-burnin-worker.js:57-80`). That single mutation shape
is the whole experiment, so the burn-in says nothing about:

- **identity and session-lease behaviour** — two fresh writers on one runtime
  still churn each other's `agent_sessions.json` leases and board claims. That
  churn, not chain corruption, is what the co-located-writer guard refuses. See
  COORD-689 for the measured un-reapable-session boundary: the guard is
  owner-independent and a finished sub-agent stays heartbeat-fresh for the full
  `AGENT_SESSION_IDLE_MS` window, blocking unrelated lanes.
- **directory-lock acquisition** — a lock directory created without its metadata
  is unreclaimable by ownership and wedges every governed mutation for the stale
  window (COORD-702).
- **writers that skip the runtime lock** — rollback restores only what it can
  reason about. Since COORD-698 a failed mutation rewrites a governed file only
  when its bytes actually differ, so an unchanged foreign lock keeps its bytes
  AND its filesystem identity (inode, mode, mtime, ctime) instead of being
  replaced by an atomic temp-and-rename. The delete sweep that removes files
  which appeared mid-transaction is sound only because
  `withGovernanceRuntimeLock` serializes governed mutations: atomicity is
  claimed strictly inside that boundary, and a process that mutates governed
  files without holding the runtime lock is outside the contract.
- **ticket locks, plan/render projection, or the complete start-to-closeout
  lifecycle** — none of which a single ticket-create exercises.
- **Git working files.** The transaction's restore point covers only governed
  coordination files — board, plan, questions, agents, sessions, plan records,
  prompts, rendered, and lock files (`coord/engine/scripts/journal.js:94-133`). Your
  source checkout, its index, its branches and its commits are **not** in that
  set and are **not** rolled back. Two agents editing one checkout will clobber
  each other's working files with no governance signal at all.
- **irreversible external effects.** A merged GitHub PR is recorded as an
  external side effect and explicitly survives the rollback: the governed files
  are restored, the merge is not, and the operator is told so
  (`coord/engine/scripts/journal.js:2064-2105`).

So: **local governed-file mutations are serializable; Git working state and
external effects are not.** No override makes the full lifecycle atomic.

### The rule

- **Default (supported, and what you should do):** each concurrent agent gets a
  distinct registered handle, a distinct `COORD_SESSION_ID`, a distinct ticket, a
  distinct worktree, and preferably its own `coord/.runtime`. `gov start` creates
  the worktree for you.
- **`--allow-shared-worktree` is an orchestrator-controlled exception**, never a
  general safety claim. It opts out of the co-located-writer guard and nothing
  else. Under it the local board and journal mutations are still serialized by
  the runtime lock, but every risk listed above — lease/claim churn,
  working-file collisions, irreversible external effects — remains fully in
  play. Use it for a deliberate single-agent/local case, or when an orchestrator
  is sequencing the lanes itself, and still give each sub-agent its own worktree.
- **The guard posture is unchanged.** `gov start` and `gov claim` fail closed on
  a co-located heartbeat-fresh foreign session unless the override is passed.
- **A stray session is released, not routed around (COORD-893).** When the
  co-located session is a stray that holds no ticket lock (for example one a
  sub-agent bound under an invented `COORD_SESSION_ID`), run
  `gov agent-release <session-id> --human-admin-override "<reason>"` with its exact
  session id. Releasing a foreign session always needs the override (COORD-689);
  releasing your own session does not. It reports that the session holds no work,
  releases it, and journals the release with the reason. Without the override it
  refuses, naming any locks the session holds. Do not pass
  `--allow-shared-worktree` for this case.
- **`--force` and `--handoff` never take a handle from another live session
  (COORD-893).** `gov claim --owner <handle> --force|--handoff` (and
  `gov agent-claim`) refuses when the handle is bound to a live session on
  another thread, unless `--human-admin-override "<reason>"` is given with
  signed approval for `agent claim --human-admin-override`. Every
  forced rebind is journaled on the claim event as `details.forced_rebind`
  (`kind: "agent-forced-rebind"`) with the displaced and the new session ids.
  For `--handoff`, "live" is the v2 owner lease (15-minute TTL) when v2
  identity is present, otherwise the 4-hour session idle window; once that
  has lapsed, `--handoff` needs no override.

`coord/scripts/gov repair-chain` is a break-glass path for a genuinely broken
chain. Concurrent governed mutation on one runtime is **not** a reason to run
it, and running it as routine cleanup after concurrency is wrong: the chain is
protected by the runtime lock, so a real break means something bypassed that
lock and needs diagnosis, not restamping.

## Recovering across an agent session gap

A session ending is not the same as losing a ticket, and neither is the same as
losing a workspace. Keep the three separate — most bad recoveries come from
treating one as another.

| What is gone | What is still true | What to run |
| --- | --- | --- |
| Your session (terminal verb released it, or it idled out) | You still own the ticket; the lock and worktree are intact | `gov agentid --owner <handle>` then `gov resume <ticket>` |
| Nothing: a stray session holds your handle but no ticket lock | Your tickets, locks and worktrees are intact | `gov agent-release <stray-session-id> --human-admin-override "<reason>"`, then `gov agentid --owner <handle>` |
| The ticket's lock file, ticket still `doing` | The owner is unchanged; the worktree still holds the work | `gov recover <ticket>` as the owner, or `gov recover <ticket> --human-admin-override "<reason>"` as an admin |
| The owner is gone for good and the work must move | The worktree and its uncommitted bytes are intact | `gov claim <ticket> --transfer-to <handle> --human-admin-override "<reason>"` |

Notes that are easy to get wrong:

- **`gov agentid --owner <handle>` is the verb that binds a session.** A refusal
  after a terminal verb advises `claim --owner`, which does not mint one. Binding
  is idempotent, so running it before a governed mutation is free.
- **`recover --human-admin-override` does not take the ticket.** It repairs a
  foreign ticket while preserving its owner and status, and journals
  `owner_preserved` with the override reason (COORD-725).
- **A lock is only ever rebuilt from the ticket's own registered, non-detached
  worktree** — for every repo including `X` (COORD-728). An unregistered
  directory at the expected path is refused, and the rebuilt lock records the
  branch git actually reports rather than one derived from the description.
- **A transfer is refused while the owner holds a heartbeat-fresh session on
  another thread** (COORD-729). An override authorises acting on a foreign
  ticket, not displacing a live holder. The way past it is to end the competing
  session, not to force the transfer: let it finish, or release it explicitly
  with `gov agent-release` using the required authority, and only then transfer
  through the explicit `gov claim --transfer-to` path.
- **Uncommitted work is preserved** across a transfer and across a transfer that
  fails and rolls back — modified tracked files and untracked files both
  (COORD-729). Do not "rescue" a worktree by hand first.
- **Do not reach for `gov lock-abandon`.** It discards accrued evidence and can
  clean workspaces. Prefer recover or an explicit transfer; abandon only when
  the workspace is genuinely worthless and a human admin says so.

Verify a recovery landed correctly by reading the lock and the journal rather
than by re-running the verb:

```
coord/scripts/gov explain <ticket>
cat coord/.runtime/locks/<ticket>.lock
```

The lock's `owner`, `branch` and `worktree` must match the ticket's real
workspace, and the journal's last entry for the ticket carries the override
reason when an override was used.

## Team continuity overlay

The topology rules above are the identity and isolation substrate for shared
continuity. A team rollout should keep these extra boundaries visible:

- identity binding names the executing session; continuity attribution also
  records the human sponsor, team, project, ticket, and worktree scope;
- ticket ownership remains one active owner at a time, even when several humans
  or agents contribute review notes;
- warm-start reads must come from governed artifacts, not transcript memory;
- cold-finish evidence must leave enough changed-file, gate, decision, question,
  ADR, and next-cursor context for a different actor to resume later;
- shared memory must be source-backed, attributable, classified, and fresh
  enough for its scope; private notes and sensitive customer context are not
  shared authority until explicitly promoted through a governed path;
- daily journal entries and decision objects are append-only continuity inputs,
  not lifecycle or policy authority;
- cadence cursor advancement, shared journal indexes, ADR acceptance, question
  resolution, board lifecycle, and runtime/journal writes serialize through one
  named owner;
- parallel code work stays in separate repo-local worktrees and never shares one
  live `coord/.runtime` among concurrently governed agents.

The concrete Team 1 and Team 2 rollout examples live in the product guide:
[`coord/product/TEAM_CONTINUITY_ROLLOUT.md`](../../product/TEAM_CONTINUITY_ROLLOUT.md).
