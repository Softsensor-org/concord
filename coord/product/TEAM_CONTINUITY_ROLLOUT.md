# Team Continuity Rollout

Status: Phase 1 rollout guide
Owner surface: `coord/product/`
Related docs:
- `coord/product/CONTINUITY_PROFILE.md`
- `coord/docs/MULTI_AGENT_TOPOLOGIES.md`
- `coord/docs/MEMORY_ARCHITECTURE.md`
- `coord/docs/decisions/README.md`
- `coord/GOVERNANCE.md`

## 1. Purpose

This guide shows how a team can use shared continuity in a multi-human,
multi-agent, multi-repo project without adding enterprise infrastructure. It
assumes a normal coord checkout, local terminals, local worktrees, and the
governed CLI already described by the project.

Continuity does not replace governance. It makes the handoff trail explicit so
another human or agent can resume work from governed artifacts instead of chat
memory. The minimum team promise is:

- every actor binds identity before governed mutation;
- every ticket has one current owner;
- every nontrivial session starts from governed context and finishes with
  governed evidence;
- shared memory is source-backed and attributable;
- private notes stay private until promoted through a governed path;
- runtime, worktree, board, journal, and cadence writes are serialized.

## 2. Rollout Shape

Use three layers:

| Layer | Owner | Purpose |
|---|---|---|
| Team operating agreement | Team lead or rotating coordinator | Names humans, agent handles, project boundaries, cadence owners, and serialization points. |
| Ticket execution | Bound ticket owner | Implements or reviews one ticket in an isolated worktree and records warm-start/cold-finish evidence. |
| Shared continuity | Shared governed artifacts | Carries daily journal entries, decisions, ADR links, cadence cursors, memory candidates, gates, and questions across humans and agents. |

The rollout is deliberately local-first. A team can start with one shared repo
family on one workstation or one hosted git remote. Jira, Slack, vector stores,
data warehouses, SSO, and centralized schedulers are optional integrations, not
prerequisites.

## 3. Before The First Team Run

1. Create or adopt the coord workspace.

   ```sh
   git clone <project-coord-repo> project-coord
   cd project-coord
   ```

2. Confirm the product repos are listed.

   ```sh
   sed -n '1,220p' coord/product/REPOS.md
   sed -n '1,220p' coord/project.config.js
   ```

3. Have each human choose their regular agent handles or allow first use to
   assign them.

   ```sh
   coord/scripts/gov agentid --assign
   coord/scripts/gov agents list
   ```

4. Agree on the shared surfaces before coding starts.

   ```text
   Shared: board rows, prompts, plan records, repo gates, feature proofs,
   accepted ADRs, resolved questions, promoted memory claims, cadence cursors.

   Private: personal scratch, unreviewed customer notes, secrets, local command
   history, private model transcripts, and any note whose owner has not promoted
   it into a governed artifact.
   ```

5. Name serialization owners.

   ```text
   Board and lifecycle: main coordinator
   Daily journal index: rotating continuity owner
   Cadence cursor: named cadence owner
   ADR acceptance: architecture owner or explicit reviewer
   Release/cutover: release owner
   ```

## 4. Scenario A: Team 1, Product Operations

Team 1 runs the `acme-ops` project with two repos:

| Repo code | Repo | Example work |
|---|---|---|
| `B` | `ops-api` | API routes, database migrations, background jobs. |
| `F` | `ops-web` | Operator console, queue views, evidence upload UI. |

Humans and agents:

| Human | Role | Typical agent |
|---|---|---|
| Dana | Product owner and cadence owner | Codex for docs and ticket grooming. |
| Ravi | Backend lead | Claude or Codex for API tickets. |
| Mei | Frontend lead | Gemini or Codex for UI tickets. |

Team 1 daily pattern:

1. Dana opens the day with a read-only warm-start pass for active tickets and
   stale cadence warnings.
2. Ravi starts one `ops-api` ticket in a backend worktree.
3. Mei starts one `ops-web` ticket in a frontend worktree.
4. Dana records product decisions or unresolved questions through governed
   artifacts, not chat.
5. The coordinator serializes board lifecycle moves and any shared journal or
   cadence cursor writes.

Example commands for Ravi:

```sh
export COORD_SESSION_ID=team1-ravi-api-001
coord/scripts/gov agentid --assign
coord/scripts/gov start OPS-124 --owner <ravi-agent-handle>
coord/scripts/gov explain OPS-124
```

Ravi then works inside the governed `ops-api/.worktrees/<handle>/OPS-124/`
checkout printed by the start/explain output, runs repo gates, and records
cold-finish evidence before handoff.

Example commands for Mei:

```sh
export COORD_SESSION_ID=team1-mei-web-001
coord/scripts/gov agentid --assign
coord/scripts/gov start OPS-131 --owner <mei-agent-handle>
coord/scripts/gov explain OPS-131
```

Mei works inside `ops-web/.worktrees/<handle>/OPS-131/`. Ravi and Mei can run in
parallel because they own different tickets and separate repo-local worktrees.
They still serialize lifecycle, board, shared journal, cadence, and ADR writes
through the coordinator or the relevant named owner.

## 5. Scenario B: Team 2, Analytics Platform

Team 2 runs a separate `northstar-analytics` project with two repos:

| Repo code | Repo | Example work |
|---|---|---|
| `P` | `pipeline` | Extract/load jobs, dbt models, data-contract checks. |
| `D` | `dashboard` | Executive dashboards, embedded reports, alert panels. |

Humans and agents:

| Human | Role | Typical agent |
|---|---|---|
| Sofia | Data product owner | Codex for rollout and decisions. |
| Luis | Pipeline owner | Claude sub-agents for parallel data tasks. |
| Nia | Dashboard owner | Codex or Gemini for UI and QA. |

Team 2 uses one orchestrator that launches two sub-agents for pipeline work.
Because orchestrated sub-agents can share a provider-native session id, each
sub-agent gets an explicit `COORD_SESSION_ID`.

```sh
# pipeline sub-agent A
COORD_SESSION_ID=team2-pipeline-a coord/scripts/gov agentid --assign
COORD_SESSION_ID=team2-pipeline-a coord/scripts/gov start DATA-207 --owner <luis-agent-a>
COORD_SESSION_ID=team2-pipeline-a coord/scripts/gov explain DATA-207

# pipeline sub-agent B
COORD_SESSION_ID=team2-pipeline-b coord/scripts/gov agentid --assign
COORD_SESSION_ID=team2-pipeline-b coord/scripts/gov start DATA-214 --owner <luis-agent-b>
COORD_SESSION_ID=team2-pipeline-b coord/scripts/gov explain DATA-214
```

Nia runs a dashboard ticket independently:

```sh
export COORD_SESSION_ID=team2-nia-dashboard-001
coord/scripts/gov agentid --assign
coord/scripts/gov start DATA-219 --owner <nia-agent-handle>
coord/scripts/gov explain DATA-219
```

Team 2 serialization points:

- one cadence owner advances the weekly source cursor after reading the prior
  cursor and source freshness record;
- one ADR owner accepts or rejects data-contract architecture decisions;
- one coordinator performs lifecycle and board mutations;
- each ticket owner records gates and cold-finish evidence for their own ticket;
- dashboard and pipeline work may proceed in parallel only while their touched
  files, worktrees, and runtime artifacts are isolated.

## 6. Identity Binding And Ownership

Every actor needs two identities:

| Identity | Meaning |
|---|---|
| Human sponsor | The person, role, or team accountable for the work or decision. |
| Executing session | The registered agent handle plus provider or `COORD_SESSION_ID` that performed the work. |

Binding sequence for a normal independent session:

```sh
export COORD_SESSION_ID=<team>-<human-or-agent>-<purpose>-<nnn>
coord/scripts/gov agentid --assign
coord/scripts/gov start <ticket> --owner <registered-handle>
coord/scripts/gov explain <ticket>
```

Binding sequence for a handoff:

```sh
export COORD_SESSION_ID=<new-session-id>
coord/scripts/gov agentid --assign
coord/scripts/gov resume <ticket>
coord/scripts/gov explain <ticket>
```

Ownership rules:

- one ticket has one active owner;
- the owner is responsible for warm-start reads, scoped edits, verification, and
  cold-finish evidence;
- another actor may review, advise, or prepare notes, but must not mutate the
  ticket unless governance has rebound or transferred ownership;
- shared continuity records preserve both the human sponsor and executing
  agent/session so later readers can tell who decided, who executed, and what
  evidence supports the claim.

## 7. Warm-Start And Cold-Finish

Warm-start is the minimum read set before meaningful work:

```sh
coord/scripts/gov explain <ticket>
sed -n '1,220p' coord/prompts/tickets/<ticket>.md
sed -n '1,220p' coord/product/REPOS.md
sed -n '1,220p' coord/docs/decisions/README.md
```

Also read the current plan/context pack, linked ADRs, linked requirements,
open questions, prior gates, and repo-local `AGENTS.md` for every repo the
ticket touches.

Cold-finish is the durable residue before stopping:

```text
Changed: files, behavior, contracts, assumptions.
Verified: commands, gates, screenshots, receipts, review cycles.
Deferred: known non-goals and follow-up candidates.
Questions: unresolved blockers with owners and needed-by dates.
Decisions: choices made or still pending, with ADR links when high impact.
Next cursor: exact next file, command, source version, or ticket state to read.
```

For a local-only worker, cold-finish can be reported to the coordinator when the
worker is not allowed to mutate lifecycle artifacts. The coordinator then
records plan, journal, gate, question, and lifecycle evidence through the
governed path.

## 8. Shared And Private Memory

Use this split:

| Scope | Allowed use | Promotion path |
|---|---|---|
| Private human memory | Personal notes, unreviewed customer context, sensitive reasoning, private transcripts. | Human explicitly promotes a redacted, cited claim. |
| Agent scratch | Dead ends, command observations, tentative hypotheses. | Daily journal or cold-finish candidate with citations and sensitivity. |
| Shared continuity | Source-backed handoff context, decisions, cadence cursors, ADR links, resolved questions, gate evidence. | Already governed, but still advisory unless promoted to an authoritative artifact. |
| Authoritative memory | Accepted memory claim, requirement, ADR, policy, prompt, or ticket. | Target artifact owner accepts it through the governed path. |

Rules:

- do not treat chat memory as current truth;
- never promote secrets or private notes into shared context;
- every shared claim needs source refs, attribution, freshness, and sensitivity;
- stale or superseded memory remains useful as history but must not become
  active implementation authority.

## 9. Daily Journal

Use the daily journal for scratch that matters tomorrow but is not yet policy,
requirement, ADR, or ticket state.

Recommended entry shape:

```text
date: 2026-06-28
project_scope: acme-ops / OPS-124
actor: Dana + codexa17
mode: handoff_note
workstream: billing-retry-rollout
observations: retry failures cluster around idempotency token reuse
dead_ends: old migration note was stale; do not reuse without DB proof
decisions_needed: decide whether retry policy needs ADR
promotion_candidates: add data-contract gate ticket for duplicate token scan
source_freshness: API log sample through 2026-06-28T13:00Z
sensitivity: internal
citations: OPS-124 explain output, gate receipt, linked incident
authority: advisory continuity only
```

Append entries; do not rewrite another actor's entry. Corrections, demotions,
or supersessions should be new entries that cite the old entry.

## 10. Cadence Ownership

A cadence is recurring work such as weekly source refresh, quality scan, audit,
customer-discovery follow-up, release readiness review, or memory durability
sweep. Every cadence needs a named owner.

Cadence owner duties:

- read the prior cursor before pulling a source;
- check source freshness and sensitivity policy;
- record whether the run reused, skipped, or pulled fresh data;
- advance the cursor only through the governed single-writer path;
- route promotion candidates to tickets, ADRs, requirements, or memory review.

Example local cadence run:

```sh
coord/scripts/gov explain CADENCE-QUALITY
coord/scripts/gov quality-scan --severity-floor warn --cap 10
```

If the cursor or journal changed since warm-start, stop, re-read, and rerun the
derived readout. Cursor advancement is a serialization point, not a background
best effort.

## 11. ADR Links And Decisions

Use decision objects for scoped choices that need handoff visibility. Promote to
an ADR when the choice changes durable architecture, security, data model,
operator policy, memory authority, or cross-repo coordination.

Decision handling:

```text
Question: Should Team 2 enforce pipeline schema drift in CI or as a nightly audit?
Owner: Sofia
Needed by: DATA-207 closeout
Options: CI gate, nightly audit, both
Recommendation: CI gate for breaking drift; nightly audit for warnings
Sources: DATA-207 plan, pipeline gate output, dashboard incident
Promotion: ADR candidate if accepted
```

Commands an operator can use in a normal governed session:

```sh
sed -n '1,220p' coord/docs/decisions/README.md
coord/scripts/gov log-question <ticket> "<question and owner>"
coord/scripts/gov update-plan <ticket> --note "<decision or ADR link>"
```

Keep questions and decisions scoped. A pending decision should block only the
tickets, cadences, migrations, releases, or policies that depend on it.

## 12. Worktree And Runtime Isolation

Parallelism is safe only when isolation is explicit:

- product repo code uses repo-local worktrees such as
  `<repo>/.worktrees/<handle>/<ticket>/`;
- coord-owned doc/code tickets may run in parallel only when declared file
  surfaces are disjoint;
- global coordination state is single-writer: board, runtime, rendered files,
  prompts, plan ledger, questions, locks, shared indexes, and cadence cursors;
- do not run two governed agents concurrently in the same checkout and same
  `coord/.runtime`;
- do not copy runtime state between projects;
- do not delete locks or runtime files as a cleanup shortcut on an active board.

For local worker arrangements, use this split:

| Actor | Allowed local work | Must hand back |
|---|---|---|
| Worker agent | Edit owned files, run local checks, report diff and evidence. | Lifecycle, board, journal, plan, question, and git mutations. |
| Main coordinator | Serialize governed mutations and publication. | Enough context for workers to avoid overlapping file surfaces. |

## 13. Serialization Points

Serialize these actions through one named owner at a time:

| Point | Why it serializes |
|---|---|
| Board lifecycle and ownership | Prevents conflicting ticket state and owner claims. |
| Runtime locks and journal chain | Prevents corrupted event ordering. |
| Shared journal index | Prevents two writers from assigning or rewriting the same record id. |
| Cadence cursor advancement | Prevents duplicate pulls and lost source positions. |
| ADR acceptance or supersession | Prevents contradictory architecture authority. |
| Question resolution | Prevents one actor from resolving another owner's blocker invisibly. |
| Release/cutover decisions | Prevents partial deployment or evidence drift. |
| Same-file or same-line edits | Prevents merge conflicts from being hidden until closeout. |

Everything else can usually run in parallel when each actor has a distinct
ticket, handle, worktree, and file scope.

## 14. First Week Checklist

Day 1:

- choose project id, team ids, human owners, and agent handles;
- verify repo map and repo-local `AGENTS.md` files;
- pick serialization owners;
- run one low-risk ticket per repo.

Day 2:

- require warm-start and cold-finish notes for every nontrivial ticket;
- start daily journal entries for dead ends and reuse candidates;
- link any architecture or policy decision to an ADR candidate.

Day 3:

- add one cadence owner and cursor for a recurring scan or source refresh;
- practice a handoff by resuming one ticket from governed artifacts only.

Day 4:

- review private-vs-shared memory boundaries;
- demote or reject stale scratch instead of letting it become active context.

Day 5:

- run a durability sweep over the week's continuity residue;
- file follow-up tickets only through the governed path;
- document which serialization points worked and which need clearer ownership.

## 15. Minimum Done Bar

A team rollout is usable when a new actor can:

- identify the project, repos, humans, agent handles, and cadence owners;
- bind identity and start or resume a ticket;
- find the right worktree and avoid global runtime conflicts;
- read warm-start context from governed artifacts;
- distinguish shared continuity from private memory and authoritative claims;
- find open questions, decisions, ADR links, and cadence cursors;
- cold-finish with changed files, verification, risks, and next cursor;
- know which actions must wait for the coordinator or another named owner.
