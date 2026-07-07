# Continuity Profile

Status: Phase 0 product spec
Owner surface: `coord/product/`
Related docs:
- `coord/docs/MEMORY_ARCHITECTURE.md`
- `coord/product/BUSINESS_DISCOVERY_PROTOCOL.md`
- `coord/product/TEAM_CONTINUITY_ROLLOUT.md`
- `coord/product/POLICY_ENFORCEMENT_MATRIX.md`
- `coord/docs/decisions/README.md`
- `coord/GOVERNANCE.md`

## 1. Thesis

Continuity is the cross-track layer that makes ephemeral agent work accumulate
into durable capability.

An agent session is temporary. Its useful residue should not be. Continuity is
the obligation to leave the next human or agent with enough governed evidence to
resume, verify, challenge, or promote what happened without trusting chat
memory.

The core rule is:

> continuity is always owed; certification is earned

Continuity applies to every track and every session because every session can
lose context. Certification is narrower: it is the stronger claim that an
artifact, dataset, contract, release, gate, or control has met a defined
standard. Continuity preserves the trail. Certification proves a claim against a
standard.

## 2. Boundary

Continuity is not a new governance track, a replacement for memory, or a
knowledge graph initiative. It is a profile over existing governed artifacts:
board rows, prompts, plan records, journal events, questions, decisions, ADRs,
requirements, business-discovery outputs, repo gates, feature proofs, and git
history.

Continuity records may recommend follow-up work, promotion, demotion, or review,
but they do not decide ticket state, change policy, certify data contracts,
accept ADRs, or promote memory claims by themselves.

Continuity should stay source-backed and rebuildable wherever possible:

- canonical truth remains in governed artifacts named by `coord/GOVERNANCE.md`;
- `coord/memory/` remains derived-only and rebuildable;
- summaries, context packs, and readouts are pointers back to sources, not
  authority;
- vectors or graph views, if introduced later, are retrieval conveniences only.

## 3. Why It Exists

Concord already records much of the operational trail. Continuity names the
cross-cutting discipline for using that trail so work compounds instead of
evaporating between agents, days, review cycles, and customer contexts.

Continuity answers questions like:

- What was just learned that the next session must not rediscover?
- Which open question, decision, or cursor blocks the next useful action?
- Which scratch observation is worth promotion, and which should expire?
- Which prior claim is stale, superseded, rejected, or still robust?
- What must be read before pulling a new source or rerunning a cadence?

## 4. Continuity Objects

Continuity uses existing artifact families rather than creating one universal
object store.

| Object | Purpose | Canonical home |
|---|---|---|
| Daily journal | Short-lived scratch and exploration residue for a day or campaign. | Future governed artifact; source-backed, append-only, and scoped. |
| Warm-start note | Minimum resume context for a new agent or human. | Plan/context artifacts, ticket-local notes, and future templates. |
| Cold-finish note | Closure residue at handoff: what changed, what was proved, what remains. | Plan records, feature proofs, repo gates, questions, and closeout summaries. |
| Decision object | Operational choice with options, evidence, owner, scoped consequence, and resolution/promotion path. | Plan records, `coord/QUESTIONS.md`, ticket-local context, future continuity records; ADRs when high impact. |
| Cadence/cursor | Position and intent for recurring scans, audits, refreshes, reconciliations, and campaigns. | Future cadence records backed by journal/plan evidence. |
| Promotion candidate | A scratch/reflection/claim that may become memory, requirement, ADR, ticket, or policy. | Claim compiler output, discovery ledgers, review cycles. |
| Durability sweep | Read-only review that recommends promotions, demotions, tickets, ADRs, claims, or cursor cleanup. | Future readout/check command; never auto-mutates authority. |
| Continuity readout | Read-only operator view that assembles warm-start/cold-finish records, daily journal summaries, decisions, cadences/cursors, stale sources, promotion candidates, durability-sweep recommendations, and read-before-pull findings. | Derived helper/UI model over governed artifacts; links to governed commands for changes. |

The profile deliberately leaves exact schemas to implementation tickets such as
daily journal, cadence/cursor, promotion ladder, and durability sweep work. This
document defines the boundary those schemas must preserve.

### 4.1 Team Rollout Boundary

`coord/product/TEAM_CONTINUITY_ROLLOUT.md` is the operator guide for applying
this profile across multiple humans, agents, and product repos. It does not add
authority beyond this profile or `coord/GOVERNANCE.md`; it translates the same
continuity objects into team responsibilities:

- humans sponsor work and decisions;
- agents execute under bound identities and isolated worktrees;
- shared continuity carries source-backed handoff context, daily journal
  residue, cadence cursors, ADR links, questions, decisions, and verification
  evidence;
- private memory remains private until an owning human promotes a redacted,
  cited claim through a governed path;
- board lifecycle, runtime locks, shared journal indexes, cadence cursor
  advancement, ADR acceptance, question resolution, and release/cutover choices
  are explicit serialization points.

Team examples in the rollout guide are illustrative. Their commands are local
recipes for normal governed operation, not a requirement for centralized
enterprise infrastructure.

## 5. Warm-Start And Cold-Finish

A warm start is the smallest sufficient read set before meaningful work begins.
It should point to governed artifacts, not transcript recollection:

- current board row and prompt;
- active plan/prework/context-pack records when present;
- relevant requirements, ADRs, questions, and business-discovery packs;
- prior repo gates, feature proofs, and review cycles;
- unresolved decisions, blockers, and cursors.

A cold finish is the obligation to leave durable residue before stopping:

- implemented and not-implemented scope;
- evidence commands and results;
- unresolved blockers or questions;
- decisions made or deferred;
- candidate follow-up tickets, claims, ADRs, requirements, or memory proposals;
- sensitivity classification for anything that might enter recall or context.

Warm-start and cold-finish templates may be specialized by session, ticket,
scratch, audit, cadence-run, or customer-discovery shape, but they must keep the
same source-backed contract.

### 5.1 Phase 1 Artifact Contract

Phase 1 defines continuity artifacts as advisory readouts over governed sources.
They are useful for handoff and resume, but they are not certified truth. A
nontrivial agent session may cite a warm-start or cold-finish artifact as
continuity evidence only when the citation preserves this boundary:

- the artifact identifies the governed sources it read or still needs to read;
- stale, missing, skipped, or low-confidence sources stay visible;
- claims that matter for code, policy, requirements, ADRs, tickets, customer
  context, privacy, or memory are verified against canonical sources before use;
- the artifact does not change ticket status, accept a decision, promote a
  memory claim, certify a contract, or replace a gate result.

Every Phase 1 continuity artifact has:

| Field | Meaning |
|---|---|
| `schema_version` | Template version, initially `continuity-phase1/v1`. |
| `shape` | One of `agent_session`, `ticket`, `scratch`, `audit`, or `cadence_run`. |
| `phase` | `warm_start` before work or `cold_finish` before handoff/stop. |
| `scope` | The bounded session, ticket, scratch thread, audit target, or cadence. |
| `authority` | Explicit statement that continuity is advisory and non-certifying. |
| `source_refs` / `evidence_refs` | Pointers to governed sources, commands, readouts, or source versions. |
| `verification_needed` | Truth claims or source gaps that must be checked before acting. |
| `sensitivity` | Classification and redaction guidance when any source may be private. |
| `attribution` | Multi-human/multi-agent attribution envelope defined in Section 5.2. |

Warm-start fields:

| Field | Captures |
|---|---|
| `prior_context` | What the next actor likely needs to know before planning. |
| `stale_sources` | Sources known or suspected to be outdated, skipped, partial, or superseded. |
| `open_decisions` | Pending choices, owners, consequences, and where they are recorded. |
| `cursor_state` | Current position for incremental work, scans, audits, or recurring pulls. |
| `dead_ends` | Explored paths that failed or should not be repeated without new evidence. |
| `prior_work` | Work already attempted, completed, deferred, or left half-finished. |
| `source_refs` | Governed artifacts and commands used to build the warm start; each ref that depends on a continuity record should preserve its `attribution` or cite the attributed record id. |
| `verification_needed` | Claims that need source verification before they become active context. |

### 5.1.1 Initial Seed Backfill

The first continuity seed is a derived read-only import over artifacts that
already exist. It may read board rows, plan records, requirement-closure fields,
self-review cycles, journal events, ADR files, `QUESTIONS.md`, canonical product
docs, and known derived recall/context outputs.

Seed facts must be conservative:

- every fact carries source provenance;
- every fact is marked `observed` when copied from a source or `inferred` when
  derived from a mechanical cue such as a board description prefix;
- the seed never invents customer, product, or business truth;
- reruns over the same inputs are deterministic;
- thin-history projects emit `sparse_memory_warning` and a prioritized
  `missing_context` list before a human or agent relies on the seed.

The seed is continuity evidence only. It does not mutate board state, accept a
decision, certify a requirement, or replace reading the cited governed sources.

Cold-finish fields:

| Field | Captures |
|---|---|
| `changed` | Files, artifacts, behavior, requirements, or assumptions changed. |
| `learned` | Source-backed observations useful to the next agent or human. |
| `failed` | Commands, approaches, tests, pulls, assumptions, or dead ends that failed. |
| `promote_candidates` | Scratch that may deserve a ticket, ADR, requirement, memory claim, prompt, or policy update. |
| `invalidated` | Prior context, assumptions, sources, cursors, or claims that no longer hold. |
| `human_decision_needed` | Decisions that need explicit human review or ownership. |
| `evidence_refs` | Commands, gates, proofs, journal events, or source versions backing the finish; session evidence should show both human sponsor and executing agent/session when present. |
| `next_cursor` | Where the next run should resume and what must be read first. |

### 5.2 Attribution

Continuity records must preserve accountability across many humans and many
agents sharing one project memory. Attribution is not authority by itself; it is
the audit envelope that says who sponsored the work, which agent/session executed
it, and which project/team/ticket/worktree scope the record belongs to.

The standard attribution envelope is:

| Field | Meaning |
|---|---|
| `human_id` | Human sponsor, author, requester, reviewer, or owner for the record. Required before a private human note can be promoted into shared authority. |
| `agent_handle` | Registered governance agent handle that executed or recorded the work, when an agent was involved. |
| `provider_session_id` | Provider-native session/thread id such as `CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, `GEMINI_THREAD_ID`, or `GROK_THREAD_ID`, when available. |
| `coord_session_id` | Governance-effective session id, including explicit `COORD_SESSION_ID` overrides for orchestrated sub-agents. |
| `acting_for` | Human, role, team, or process the executing agent was acting for when different from the direct `human_id`. |
| `team_id` | Team boundary for team-scoped continuity and memory reuse. |
| `project_id` | Project memory boundary. Three humans may share one `project_id` memory only when each shared record keeps its own attribution. |
| `source_worktree` | Worktree or checkout that produced the record, for audit and collision diagnosis. |
| `ticket_id` | Governed ticket scope, when applicable. |

Attribution rules:

- daily journal entries show `human_id` and `agent_handle`/session ids when an
  agent records the entry; human-private entries cannot become shared authority
  for another human without governed promotion and citations;
- cold-finish records show the human sponsor plus executing agent/session,
  source worktree, ticket, and evidence refs;
- decision objects keep the deciding `human_id` separate from any
  `agent_handle` that drafted, summarized, or applied the decision;
- cadence runs record the responsible human/team/process in `human_id`,
  `acting_for`, or `team_id`, plus the executing agent/session and cursor
  evidence;
- memory candidates preserve the original attribution through promotion review;
  a candidate from `human-private` scope may be shared only after cited governed
  approval by the owning human or an authorized reviewer;
- context-pack citations must surface attribution next to cited continuity
  claims so readouts can distinguish the human sponsor from the executing
  agent/session.

Readouts that include continuity records must render attribution in two layers
when both exist: human sponsor (`human_id` / `acting_for` / `team_id`) and
execution (`agent_handle`, `provider_session_id`, `coord_session_id`,
`source_worktree`). Missing attribution should be shown as unknown, not inferred
from chat memory.

### 5.3 Phase 1 Shapes

| Shape | Warm-start read set | Cold-finish residue |
|---|---|---|
| Agent session | Entry shims, governance, active ticket explain output when scoped, active plan/context artifacts, recent events, and session/cursor records. | Session changes, lessons, failures, promotion candidates, invalidations, needed decisions, and next cursor across the session. |
| Ticket | Board row, prompt or waiver, plan/prework/context pack, ticket-local notes, requirements, ADRs, questions, review cycles, repo gates, and feature proofs. | Implemented and not-implemented scope, gate evidence, unresolved blockers, deferred decisions, follow-up candidates, and verification gaps. |
| Scratch | Daily journal or scratch ledger, source references, retrieval bounds, sensitivity, and expiry/revisit cues. | What was learned, what was discarded, what is worth promoting, what is stale, and when it should expire or be revisited. |
| Audit | Audit target contract, last readout, stale/skipped sources, open findings, waivers, and prior false positives. | Findings, non-findings, failures, invalidated prior findings, follow-up recommendations, and human decisions needed. |
| Cadence run | Cadence contract, cursor, last source version/hash/event index/timestamp/query bounds, and last emitted/skipped/promoted/rejected records. | Updated cursor, emitted/skipped/promoted/rejected records, source drift, failures, stale assumptions, and next read-before-pull requirements. |

### 5.4 Optional Gov Verbs

Phase 1 allows optional operator verbs without requiring lifecycle mutation:

| Verb | Purpose | Mutation boundary |
|---|---|---|
| `gov warm-start [<ticket>]` | Render the current advisory warm-start template/readout for a session or ticket. | Read-only unless a later ticket adds explicit artifact persistence. |
| `gov cold-finish [<ticket>]` | Render or validate the advisory cold-finish template before handoff. | Read-only unless a later ticket adds explicit artifact persistence. |
| `gov continuity scratch-start` / `scratch-finish` | Prepare or close scratch continuity with source and sensitivity fields. | Does not promote scratch by itself. |
| `gov continuity audit-start` / `audit-finish` | Prepare or close a read-only audit continuity artifact. | Does not accept findings or waive gates by itself. |
| `gov continuity cadence-start <cadence>` / `cadence-finish <cadence>` | Retrieve and update cadence/cursor-oriented continuity fields. | Cursor persistence requires its own governed implementation ticket. |

These verbs are contracts for future implementation. Until persistence lands,
agents should externalize durable learning through existing governed artifacts:
plan records, review cycles, feature proofs, repo gates, ADR proposals,
requirements updates, questions, decisions, and memory-claim proposals.

### 5.5 Read-Only Continuity Readout

The continuity readout is a derived view model, not a new authority surface. It
may combine warm-start notes, cold-finish notes, daily journal entries, open
decision objects, cadence/cursor state, stale-source warnings, durability-sweep
recommendations, and read-before-pull findings, but it must remain read-only.

Readout requirements:

- declare `read_only: true` and `no_mutations_performed: true`;
- show the governed commands an operator can run to make changes, such as
  `coord/scripts/gov explain <ticket>`, `coord/scripts/gov update-plan ...`,
  `coord/scripts/gov log-question ...`, `coord/scripts/gov adr ...`, and
  `coord/scripts/gov file-ticket ...`;
- preserve source refs and evidence refs beside recommendations;
- keep stale, missing, skipped, and unknown sources visible;
- keep open decisions unresolved until the owning governed artifact resolves
  them;
- render cadence/cursor records with read-before-pull findings before any
  recurring source is pulled;
- prove the next cold-start actor can resume from governed reads instead of
  redoing the prior session's exploration.

The helper-level pilot fixtures are public-safe examples only. They use generic
recurring validation and audit-remediate-reaudit scenarios with synthetic ticket
IDs, synthetic evidence refs, and no private project names, customer data,
secrets, or proprietary source bodies. Fixture readouts may demonstrate shape
and UX behavior, but they are not canonical evidence and cannot close tickets,
accept decisions, or certify remediation.

## 6. Daily Journal

The daily journal is the continuity layer for scratch work and exploratory
context that is useful but not yet durable knowledge.

Daily journal records are Phase 1 continuity artifacts with shape
`daily_journal_entry`. They are append-only, scoped to a day or exploration
campaign, and explicitly non-certified. They may feed warm-start context,
scratch handoff, cadence review, and durability-sweep recommendations, but they
do not become active policy, requirements, business rules, ADRs, ticket state,
or accepted memory without promotion through the existing governed artifacts
that own those claims.

Each entry has:

| Field | Meaning |
|---|---|
| `schema_version` | Template version, initially `continuity-daily-journal/v1`. |
| `shape` | Always `daily_journal_entry`. |
| `date` | Local journal date in `YYYY-MM-DD`; use UTC timestamps inside citations when needed. |
| `project_scope` | Project, repo, ticket, campaign, customer/discovery scope, audit target, or cadence the scratch belongs to. |
| `actor` | Human or agent identity that recorded the observation. |
| `mode` | Entry mode such as `scratch`, `exploration`, `audit_note`, `cadence_note`, `handoff_note`, or `durability_sweep_input`. |
| `workstream` | Named thread of work so related scratch can be grouped without becoming canonical state. |
| `observations` | Source-backed or clearly-labeled low-confidence notes learned during exploration. |
| `dead_ends` | Paths, commands, assumptions, or source reads that failed and should not be repeated without new evidence. |
| `decisions_needed` | Questions needing human, reviewer, ADR, requirement, ticket, or policy ownership. |
| `reuse_candidates` | Notes that may help a future warm-start, audit, cadence, implementation, or discovery pass. |
| `promotion_candidates` | Scratch that may deserve a ticket, ADR, requirement, memory claim, prompt, policy update, or business-rule proposal. |
| `source_freshness` | Source date/version/hash/query bounds, confidence, expiry, stale/skipped-source flags, and read-before-reuse cues. |
| `sensitivity` | Classification and handling guidance: `public`, `internal`, `sensitive`, or `secret_prohibited`; include redaction notes when needed. |
| `citations` | Pointers to governed artifacts, commands, source versions, URLs, hashes, or evidence snippets. |
| `authority` | Required non-certification and promotion boundary for the entry. |

Authority rules:

- append-only entries with source references and attribution;
- scope fields such as date, ticket, repo, campaign, customer, or cadence;
- classification fields such as public, internal, sensitive, or
  secret-prohibited;
- promotion state such as scratch, candidate, robust, stale, superseded, or
  rejected;
- explicit expiry or revisit cues for low-confidence observations.

A daily journal entry cannot create a rule, requirement, ADR, policy, or active
memory claim on its own. It is an input to later review, claim compilation,
decision-making, or ticket creation.

Daily journal data may be read by warm-start and durability-sweep tooling only
as advisory continuity context. Before reuse, the consumer must check
`source_freshness`, `sensitivity`, and `citations`; before promotion, the target
artifact owner must verify the claim against the canonical source named by
`coord/GOVERNANCE.md`.

Write-safety rules:

- journal entries are append-only records with stable ids and content hashes;
- a concurrent writer may append a new entry, but must not rewrite an existing
  entry id with different content;
- corrections, demotions, or supersessions are recorded as new entries that cite
  the prior entry id;
- shared journal indexes are single-writer governed coordination mutations, not
  ad hoc file rewrites.

## 7. Decision As Object

Continuity treats decisions as objects because "why" is usually what disappears
first during handoff.

Decision objects are for operational and human choices that need resume
visibility but are not necessarily ADRs. They are source-backed continuity
records, not free-floating memory. Their Phase 1 schema version is
`continuity-decision-object/v1`.

| Field | Meaning |
|---|---|
| `id` | Stable id unique within the governed source scope. |
| `status` | `open`, `proposed`, `pending`, `needs_decision`, `resolved`, `accepted`, `rejected`, `deferred`, or `superseded`. |
| `type` | Decision class such as `operational`, `human`, `product`, `cadence`, `memory`, or `adr_candidate`. |
| `subject` | Short label for scanability. |
| `question` | The concrete question being decided. |
| `why_now` | Why this decision matters for the next step, risk, cadence, or handoff. |
| `options` | Options considered, including tradeoffs when known. |
| `recommendation` | Current recommended answer, if there is one. |
| `owner` | Person, role, team, or process expected to decide. |
| `needed_by` | Date, ticket, cadence, milestone, or event needing the answer. |
| `resolution` | Answer, deciding actor/time, durability flag, promotion target, and notes. |
| `sources` | Governed files, commands, tickets, ADRs, questions, plans, or evidence refs. |
| `supersession` | Superseded or superseding decision ids and reason. |
| `linked` | Scoped `tickets` and `cadences` affected by the decision. |

Open decision objects feed warm-start through the `open_decisions` field for
their linked ticket or cadence scope. They must remain precise: include the
owner, why-now, source refs, and the exact linked scope so the next actor can
see what is pending without treating it as global policy.

Resolved decision objects feed cold-finish and durability-sweep promotion only
when they are source-backed and marked durable, or when their resolution names a
promotion target such as `memory`, `adr`, `requirement`, `ticket`, or `policy`.
Promotion remains governed by the target artifact owner. A resolved decision
object can recommend an ADR or memory claim; it cannot create one by itself.

Decision and promotion-candidate records follow the same append-only write
contract as journal entries. A second agent must either append a distinct
decision/promotion candidate id or append a superseding record that cites the
prior id. Reusing the same id with different content is a conflict, not a merge.

Unresolved decision objects block only scoped risky work. A pending rollout,
data deletion, policy change, migration, customer-impacting change, or cadence
pull that depends on the decision should stop until the linked decision is
resolved or waived. Ordinary tickets outside the linked `tickets`/`cadences`
scope, or non-risky work in the same area, may continue with the decision shown
as advisory context.

High-impact architecture, security, data model, coordination, memory-authority,
or operator-policy choices should promote to ADRs under
`coord/docs/decisions/README.md`.

## 8. Cadence And Cursor

A cadence is a recurring intent: scan, audit, refresh, reconcile, backfill, or
campaign follow-up. A cursor is the durable position that makes the next cadence
run incremental and idempotent.

Cadence/cursor records should answer:

- what recurring action is owed;
- what source was last read;
- which source version, hash, event index, timestamp, or query bounds were used;
- what was emitted, skipped, promoted, or rejected;
- what must be read before pulling again;
- when the cursor expires or needs human review.

Cadence/cursor state must not be inferred from chat memory. If it matters for a
future run, it needs a governed source or derived readout backed by one.

Phase 1 defines the cadence/cursor schema and warm-start/cold-finish readouts;
it does not require a scheduler, daemon, autonomous worker, or new lifecycle
state. A cadence can advance its cursor as continuity state without pretending
to be a feature ticket and without changing board status.

Cadence/cursor records use schema version `continuity-cadence-cursor/v1`.

| Field | Meaning |
|---|---|
| `id` | Stable cadence id unique within the governed source scope. |
| `owner` | Human, role, team, or process responsible for the recurring obligation. |
| `frequency` | Expected interval or trigger, such as daily, weekly, per-release, on-demand, or after a named source changes. |
| `cursor` | Position object with `type`, `value`, evidence reference, and advance timestamp when known. |
| `freshness_policy` | Maximum age, expiry rule, source-version expectation, status, and stale/unknown handling. |
| `inputs` | Sources, queries, repositories, tools, APIs, artifacts, sensitivity policy, and source contracts read by the cadence. |
| `operation_class` | One of `scan`, `audit`, `refresh`, `reconcile`, `backfill`, `campaign_follow_up`, or `audit_remediate_reaudit`. |
| `read_before_pull` | Required sources and evidence to inspect before fetching or ingesting new material. |
| `warm_start_required` | Whether the cadence must appear in warm-start before work begins. |
| `cold_finish_required` | Whether the cadence must leave cursor and evidence residue before handoff. |
| `last_run` | Last run timestamp, actor, source versions, emitted/skipped/promoted/rejected records, failures, and evidence refs. |
| `next_run` | Next expected run time, trigger, or review date when known. |
| `blocked_on_decisions` | Scoped decisions that must resolve before the next pull, promotion, or destructive action. |
| `promotion_triggers` | Conditions that should propose a ticket, ADR, requirement, memory claim, prompt, policy update, or human review. |
| `authority` | Non-certification, ticket-boundary, scheduler-boundary, and read-before-pull contract. |

Cursor types include `source_version`, `hash`, `event_index`, `timestamp`,
`query_bounds`, `compound`, `manual_checkpoint`, and `unknown`. Freshness status
is one of `fresh`, `stale`, `expired`, `unknown`, or `blocked`.

Warm-start must show stale, expired, blocked, or unknown cursor state explicitly.
Unknown cursor state is not a failure by itself in Phase 1, but it is a
read-before-pull warning: the next actor must find or rebuild the governed
source state before treating the cadence as incremental.

Cold-finish for a cadence run should record the next cursor, read-before-pull
evidence, source drift, failures, emitted/skipped/promoted/rejected records, and
any blocked decisions. Advancing the cursor records recurrence position only; it
does not certify findings, accept promotions, open or close tickets, or mutate
governance lifecycle state.

### 8.1 Write Safety

Cadence cursor advancement is compare-and-swap. The writer must include the
cursor generation hash or observed cursor value it read at warm-start. If the
current cursor differs, the advance fails with re-read guidance instead of
silently overwriting another agent's newer cursor.

Context-pack and cold-finish writers must carry source generation hashes for the
context they read. Before writing, they compare those hashes with the current
source hashes. Stale attempts fail closed and instruct the actor to re-read the
changed context pack, cadence, journal, decision, or derived readout, regenerate
the derived view, and retry through the governed single-writer path.

Derived continuity views, including warm-start, cold-finish, durability-sweep,
and read-only readouts, carry input generation hashes. If any canonical input
changes, the derived view must be regenerated; the derived output must never be
appended to the governance journal as authority.

Shared continuity indexes are coordination state. They must be mutated only by a
single governed writer under the coordination-state mutation path. Concurrent
humans and agents may contribute append-only records, but index regeneration and
cursor advancement must serialize through the governed path so two actors cannot
silently overwrite the same cursor or promotion candidate.

## 9. Promotion Ladder

Continuity preserves low-confidence residue without pretending it is truth.

The standard promotion ladder is:

| State | Meaning |
|---|---|
| Scratch | Useful local residue from a journal, cold-finish note, failed attempt, or experiment. It is retrievable for continuity, but never authoritative and never active context. |
| Observed | A current source, implementation, runtime receipt, test output, or human note shows behavior or a fact, but not intent. It can guide investigation and review, not implementation authority. |
| Candidate | Source-backed enough to show as advisory context or ask for review, but still missing accepted owner intent, enforcement corroboration, or conflict/staleness clearance. |
| Robust | Verified, deterministically corroborated, or reviewer-accepted for its declared scope with usable citations and no active conflict, staleness, or sensitivity blocker. |
| Promoted | A robust record has been moved through the governed path for its target artifact: requirement, ADR, accepted memory claim, prompt, policy, ticket, runbook, adapter, or cadence rule. |
| Stale | Source hash, source version, owner, freshness window, context, or time horizon no longer supports active use. |
| Superseded | Replaced by newer accepted context; history-only. |
| Rejected | Reviewed and found invalid, unsafe, unsupported, secret-tainted, duplicate, or out of scope. |

Promotion must use the governed path for the target artifact. A memory claim
passes through the Concord Knowledge Compiler. An ADR follows the ADR process. A
requirement changes the requirements source. A procedural rule changes governed
agent or governance docs through review.

Promotion evidence is cumulative:

- scratch becomes observed when it cites a current source, command, receipt,
  implementation location, journal entry, or human note that another actor can
  retrieve;
- observed becomes candidate when the record has a bounded statement, source
  refs, sensitivity classification, freshness notes, and a clear review or
  promotion question;
- candidate becomes robust when accepted owner intent, deterministic
  verification, reviewer approval, or intent-plus-enforcement evidence resolves
  the declared scope and clears conflict, staleness, and sensitivity checks;
- robust becomes promoted only through the target artifact owner: the knowledge
  compiler for memory claims, ADR review for ADRs, requirement edits for
  requirements, governed ticket filing for tickets, reviewed docs for runbooks,
  adapter ownership for adapters, and cadence/cursor ownership for cadence
  rules.

Demotion is as important as promotion. A record moves down or out of active use
when:

- a cited source hash, source version, query bound, owner, or freshness window
  changes without revalidation (`stale`);
- a newer robust or promoted record replaces the old one (`superseded`);
- two active records conflict and no reviewer has resolved or waived the
  conflict (`candidate`/conflict queue, not active authority);
- the record contains secret-tainted, prompt-injection, governance-override,
  summary-only, unsupported, duplicate, or out-of-scope material (`rejected`);
- an accepted owner narrows scope, revokes approval, or changes the target
  artifact so the old record no longer applies (`stale` or `superseded`).

Scratch, stale, superseded, and rejected records remain useful. They should stay
retrievable with citations and reasons so future agents can understand prior
work, avoid repeated dead ends, and see why a claim was not active. They must be
kept out of authoritative constraints and active context-pack fact sections.
Robust records may feed context packs only with citations and scope labels;
promoted records inherit authority from the canonical artifact they entered,
not from the continuity record itself.

## 10. Durability Sweep

A durability sweep is a read-only pass over continuity sources. It recommends
work; it does not perform the work.

A sweep may recommend:

- promote a candidate to memory, ADR, requirement, ticket, prompt, or policy;
- demote stale or superseded context;
- open a follow-up ticket;
- request human review;
- refresh a cadence/cursor;
- consolidate duplicate adapters or repeated lessons;
- quarantine sensitive or secret-tainted material.

Every recommendation needs a source reference and a reason. The command or
readout that performs a sweep must be safe to run repeatedly.

Phase 1 durability sweep readouts use schema version
`continuity-durability-sweep/v1` and are promotion recommendations only. They
may read daily journal entries, cold-finish notes, decision objects, cadence
records, quality scans, and repeated scratch outputs. They should look for:

- repeated dead ends or failed approaches;
- repeated source re-pulls that need cursor or freshness controls;
- duplicate scripts, tools, or adapters that should consolidate;
- repeated manual steps that deserve automation or a runbook;
- source freshness uncertainty, stale context, invalidations, or supersessions;
- pending decisions that need scoped decision ownership or ADR proposals;
- reusable artifacts that may become memory claims after verification.

Durability sweep output must be deduped by recommendation type, category, target,
and reason. Each recommendation must preserve source citations from the
underlying continuity artifacts. Ticket recommendations remain read-only: the
sweep never files tickets by itself, and a proposed ticket may be filed only
through explicit governed approval and the governed ticket-filing path.

## 11. Read-Before-Pull

Read-before-pull is the continuity rule for external or recurring sources: read
the current cursor, source contract, sensitivity policy, and last emitted
evidence before pulling fresh material.

It applies to cadence work such as:

- data and analytics refreshes;
- marketing-ops or CRM campaign pulls;
- customer discovery packs;
- external tracker imports;
- audit and quality scans;
- memory/context backfills.

The goal is to avoid duplicate ingestion, stale assumptions, privacy mistakes,
and source-of-truth drift.

Phase 2 makes this warning-first policy for cadence, data, analytics,
marketing-ops, and external-validation flows. Before a runner, agent, or human
revalidates an external source, it must check the declared canonical store,
prior outputs, freshness window, and cursor state for that flow. If the prior
output is still within its freshness policy and the cursor has not expired or
been invalidated, the default action is to reuse or skip the pull and record
why. A fresh pull is appropriate when the source is stale, the cursor is
unknown or expired, the canonical store declares a newer source version, the
flow is running in scratch mode, or an explicit waiver names the reason for
revalidation.

Every read-before-pull decision should leave evidence with the cadence or
continuity artifact:

| Decision | Required evidence |
|---|---|
| `reused` | Canonical store read, prior output id/version/hash, freshness window, cursor state, and actor/time. |
| `skipped` | Source considered, reason skipped, freshness or waiver basis, and actor/time. |
| `pulled` | Source contract, query bounds, prior cursor, new cursor or source version, emitted records, and stale/waiver reason. |

Durability sweeps must surface avoidable re-pulls as advisory findings when a
flow repeatedly fetches the same external source while the prior output was
fresh, the cursor was unchanged, or a canonical store already held the needed
result. The sweep may recommend a cursor fix, freshness policy, ticket, ADR, or
runbook update, but it must not mutate the source, advance the cursor, file a
ticket, or block work by itself.

Phase 2 remains advisory unless a specific track opts in to enforcement. Local
experimentation is not blocked: scratch mode may pull or revalidate external
sources when the actor records that the work is scratch, keeps sensitive
material out of durable context, and does not promote the result without
rechecking the canonical store and freshness policy. Enforcement requires an
explicit track-level opt-in that names the covered flow, canonical store,
freshness policy, waiver mechanism, and failure mode.

## 12. Privacy And Sensitivity

Continuity is a retention mechanism, so it must be conservative about private
or sensitive material.

Continuity records carry two related labels:

- **Memory scope**: where the record may be reused or govern context
  (`shared`, `team`, `human-private`, `local-only`, `sensitive`,
  `secret-prohibited`).
- **Permission classification**: who may see the value
  (`public`, `internal`, `sensitive`, `secret-prohibited`), with redaction
  handled by the memory classification/RBAC layer.

Project-shared by default:

- tickets and board rows;
- plan records and review cycles;
- accepted ADRs and ADR-linked decisions;
- confirmed business rules and accepted requirement changes;
- cadence/cursor records;
- durable decisions recorded in governed sources.

Team-scoped by default:

- team notes, runbooks, cadences, retrospectives, and team-owned decisions;
- records with a `team_id` or equivalent boundary;
- customer or workstream notes explicitly approved for that team only.

Human-private or local-only by default:

- personal human or agent notes;
- session/transcript notes;
- local worktree scratch;
- daily journal scratch that has not been promoted;
- unverified observations, preferences, and dead-end notes.

Rules:

- classify continuity artifacts before they enter recall or shared context;
- store pointers, hashes, and summaries instead of sensitive bodies when
  possible;
- keep `secret-prohibited` material out of active context packs and derived
  memory;
- keep human-private and local-only notes out of other agents' governing
  context unless they are promoted through a cited governed path;
- treat customer, employee, and vendor context as scoped and revocable;
- never use continuity for individual performance scoring;
- make retention, redaction, and right-to-forget implications explicit before
  broad rollout.

Human promotion is explicit. A human can promote useful personal/session
learning by extracting a bounded statement, adding current citations, selecting
the target governed artifact, classifying/redacting the content, and recording
review or approval. The target path then owns authority: a memory claim goes
through the knowledge compiler, an ADR follows ADR review, a business rule goes
through requirements or accepted decision evidence, a procedural rule changes
governed docs through review, and a ticket is filed through the governed board
path. The original private note remains private/local history unless separately
reclassified.

Continuity exists to improve delivery and handoff quality, not to surveil
people.

## 13. Relationship To Memory, ADR, And Discovery

### Memory

Memory is the governed recall and learning layer. Continuity supplies and
organizes candidate residue for memory, but memory claims still need source
references, compilation, conflict checks, staleness checks, sensitivity checks,
and permission-aware recall. `coord/memory/` stays derived-only.

### ADRs

ADRs are durable high-impact decisions. Continuity can surface the need for an
ADR, preserve rejected alternatives, and carry revisit triggers, but it cannot
accept or supersede an ADR by itself.

### Business Discovery

Business discovery produces source-backed observations, open questions,
decision candidates, and reflections. Continuity keeps those ledgers alive
between discovery runs and implementation sessions. Promoting discovery output
still follows the relevant target path: requirement, ADR, memory claim, ticket,
or prompt.

### Certification

Certification is an earned status for artifacts that pass explicit gates.
Continuity may retain evidence that supports certification, but the certification
gate remains the authority. This distinction is mandatory: continuity is always
owed; certification is earned.

## 14. Non-Goals

- Do not create a new track beside product, governance, memory, ADR,
  requirements, discovery, data, or quality work.
- Do not make continuity a knowledge graph project.
- Do not make `coord/memory/` canonical.
- Do not promote scratch notes directly into active context.
- Do not treat continuity recommendations as governance decisions.
- Do not store secrets or sensitive bodies just because they help handoff.
- Do not use continuity to rank individual humans or agents.
