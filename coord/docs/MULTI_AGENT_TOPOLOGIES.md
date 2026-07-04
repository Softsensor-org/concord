# Multi-Agent Topologies

coord supports running many agents against one board. Two topologies are
supported, and the only thing that differs between them — and between providers —
is **how each agent gets a distinct session identity**. Everything else (per-ticket
worktrees, per-ticket branches/PRs, the runtime lock that serializes board writes,
land-time rebase for same-repo conflicts) is identical and already concurrency-safe.

> This doc covers the **identity model**. For the *operating* runbook — the
> proven per-agent lifecycle recipe, done-check-first discipline, file-cluster
> sequencing, the repo-`X` no-isolation rule, two-board reconciliation, and the
> known sharp edges — see
> [`MULTI_AGENT_BURNIN_RUNBOOK.md`](./MULTI_AGENT_BURNIN_RUNBOOK.md).
>
> For the adoption boundary between today's identity/teamwork substrate and the
> future shared-continuity overlay, see
> [`CONTINUITY_CAPABILITY_MATRIX.md`](../product/CONTINUITY_CAPABILITY_MATRIX.md).
>
> For a team-facing rollout guide that combines identity binding with
> warm-start/cold-finish, shared-vs-private memory, daily journal, cadence
> ownership, ADR links, question/decision handling, worktree/runtime isolation,
> and serialization points, see
> [`TEAM_CONTINUITY_ROLLOUT.md`](../product/TEAM_CONTINUITY_ROLLOUT.md).

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
`coord/docs/IDENTITY_RUNTIME_EXTRACT.md`). The anchor priority is:

0. **`COORD_SESSION_ID`** — explicit, provider-agnostic, **authoritative**; overrides everything below.
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
  [`ADR 0002`](./decisions/0002-canonical-ephemeral-runtime-boundary.md).

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
(`coord/scripts/governance-session.js`). It closes the failure mode where work
was committed by a session that never registered/bound, so reconciliation could
not attribute the work and the ticket silently drifted back to
`todo`/`unassigned`. Read-only verbs (`explain`, `conform`, `doctor`,
`agents list`) and the binding/recovery verbs themselves (`start`, `claim`,
`resume`, `agent-rebind`, `agentid`, and the human-admin `takeover`) are
deliberately **not** gated — they are how a session *becomes* a registered,
bound owner.

Recovery paths (all already supported):
- **Same-owner handoff / resume** — `coord/scripts/gov resume <ticket>`.
- **Identity collision / fresh rebind** — `coord/scripts/gov agent-rebind --fresh`.
- **Human-admin foreign-owner takeover** — `coord/scripts/gov takeover <ticket>`.

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

## Never run governed sub-agents concurrently in a shared worktree/runtime

Two governed agents sharing one checkout and one `coord/.runtime` will interleave
writes to the hash-chained journal and corrupt the chain. The rule:

- **One governed agent at a time per checkout**, OR
- **Separate worktrees with separate `coord/.runtime`** per concurrent agent.

If the chain is crossed (e.g. concurrent sub-agents in one runtime), recover with
`coord/scripts/gov repair-chain`.

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
[`coord/product/TEAM_CONTINUITY_ROLLOUT.md`](../product/TEAM_CONTINUITY_ROLLOUT.md).
