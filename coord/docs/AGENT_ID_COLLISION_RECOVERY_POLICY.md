# Agent ID Collision And Session-Binding Recovery Policy

Metadata:
- Version: 0.12-draft
- Status: draft target-state policy and implementation matrix
- Updated: 2026-04-11
- Owner: governance CLI maintainers
- Effective model: `Core Principle` in Section 12 is immediate guidance; other sections enter force individually when their enforcement-matrix rows and adoption criteria are satisfied
- Canonical destination on adoption: `coord/GOVERNANCE.md#identity`
- Propagation target:
  - `coord/AGENTS.md`, repo-local `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, and equivalent provider shims must link to the canonical section
  - agent-facing shims should consume a distilled runtime-behavior extract derived from Sections 5, 7, and 12 rather than inlining the full implementation matrix

Changelog:
- `0.12-draft`: closed enforcement-semantic gaps identified in the critique against `0.11-draft`: pinned `gov commit` lock-metadata atomicity against git-commit+lock-write sequencing (A); defined ticket-scope resolution for ticket-less `gov doctor`/`gov submit`/`gov land` invocations across one-doing, zero-doing, and ambiguous cases (B); added multi-lock fail-closed recovery path and candidate-lock enrichment to the audit schema (C); deprecated bare `--force` on foreign-touch commands in favor of mandatory `--human-admin-override` with transition alias (D); named the MCP server as the preferred heartbeat-timer host with sidecar and mutation-triggered fallbacks (F); left transaction-handle definition (E) and environment-failure-class glossary entry (G) to execution tickets
- `0.11-draft`: narrowed overlap semantics to governed worktree roots, made tier-1 matching thread-id-first with session-id fallback only for unknown thread ids, added Repo X `coord-no-git-head` carve-out, chose a session-bound heartbeat timer model, aligned `gov resume` and foreign-touch command surfaces, added lock corruption signals from observed log patterns, and tightened composed-transaction and verify-rollback rules
- `0.10-draft`: reconciled `6.4` around serializability vs multi-file atomicity; nested the ticket tx lock inside the repo-global governance runtime lock; mapped phases onto rollback steps; split validation from rendering; clarified rollback snapshots vs audit snapshots; defined bounded contention, release ordering, and external side-effect retry rules
- `0.9-draft`: made `complete lock` explicitly require `thread_id`, `session_id`, and `head`; defined `live branch binding`; gave `dormant session` operational meaning; tightened the minimum-safety cleanup row to require `--human-admin-override`
- `0.8-draft`: added transaction phase ordering, mid-transaction validation prohibition, scoped snapshot rule, and idempotency requirement to Section 6.4; added matching enforcement-matrix rows, minimum-safety rows, and regression tests
- `0.7-draft`: clarified tier-1 lock matching, fixed active-threshold semantics, added dormant-session definition, strengthened foreign-cleanup elevation, defined lock `head` semantics, added skill-versus-CLI enforcement note, added version-detection and adoption-status requirements
- `0.6-draft`: tightened thread-id safety semantics, defined complete lock and overlap tests, clarified heartbeat ownership and rebuild triggers, added foreign-thread `gov resume` tests, added grandfathering and partial-regression rules, added bounded handle-allocation exhaustion
- `0.5-draft`: classified session-binding files as runtime state, added `gov commit` and `gov heartbeat` lock-head sync contract, added explicit out-of-scope list, added matching enforcement and test rows
- `0.4-draft`: added bootstrap-assignment rule, narrowed liveness semantics, defined local-context scan, added `gov resume`, split recovery transaction model into its own subsection, added rollback note
- `0.3-draft`: added hard vs soft signals, reclaimable stalled-lock path, human-override mechanism, audit-event schema, handle-allocation race, heartbeat cadence, review-landing guards, explicit cleanup mode, partial adoption model
- `0.2-draft`: added enforcement matrix, adoption criteria, thread/session terminology, report-not-abort orchestration requirement
- `0.1-draft`: initial target-state note

Purpose:
- preserve active ticket work during live agent-id and session-binding failures
- prevent cross-ticket takeover during collision recovery
- distinguish enforceable CLI invariants from advisory operator guidance

This document is written primarily for CLI and governance implementers. Any rule without CLI backing is advisory until implemented.

## 1. Scope

This policy is about live multi-agent failures during active work:
- duplicate `agent_id` allocation
- lost or drifted session binding
- `gov pick` or `gov start` surfacing a foreign `doing` ticket
- phantom `doing` state with no lock
- partial lock writes and mid-write crashes
- create-lock, handle-allocation, and recovery races

This document is not primarily about a human returning many hours later and manually resuming work.

Observed log-backed incident classes that this policy is intended to address include:
- runtime session-binding drift noise around `.runtime/agent_sessions.json`
- lock-head drift after governed commits or rebases
- forced cross-session claim or resume attempts on foreign tickets
- Repo X missing-lock, incomplete-lock, and sentinel-head recovery behavior

Handle-space note:
- legacy handles such as `codexa00..10` and similar provider ranges already exist
- allocation above the legacy range has already begun ad hoc and should be formalized into provider-scoped pools
- this policy applies to all handles, not only future pools

Explicitly out of scope:
- missing or malformed plan-record state such as `missing_plan_state`
- dirty product-repo roots, main-checkout sanitation, or pre-push hook authority issues
- gate-selection and `gate:default` authority policy outside identity and session binding
- non-identity board or plan schema validator drift unless it directly changes ticket ownership or lock identity

Related governance backlog alignment:
- directly related backlog from `GOV-001` decomposition that this policy is intended to guide includes `GOV-006` (session rebinding and repo X repair ergonomics) and `GOV-008` (ticket-scoped validation isolation, gate attribution, preserved failure evidence, and stale drift-note cleanup)
- adjacent but intentionally separate backlog includes `GOV-007` (startup and planning ergonomics such as auto-seeding plan state and a first-class `gov plan` command), `GOV-005` (submit or pr-create pushing from repo root instead of the governed worktree), and `GOV-002` (`add-review-cycle` reliability)
- broader consolidation of ticket state into one canonical record is architectural governance work adjacent to this policy, not part of collision-recovery rules by itself

## 2. Rule Types

This document uses two rule classes:

- `Enforced invariant`: backed by CLI behavior, lock format, or command checks
- `Advisory convention`: target-state operator rule that is not yet reliably enforced

Policy text must not imply that an advisory convention is already enforced.

## 3. Terms

- `agent_id`: recyclable display handle such as `claudea57` or `codexa55`
- `preferred agent_id`: a handle requested because it was previously bound to the current session or because a human asked for that specific handle
- `currently unclaimed agent_id`: a recyclable handle that is not bound to an active session at the instant of successful atomic claim
- `thread_id`: stable per-window or per-conversation identity used to recognize logical resume across process restarts
- `unknown thread_id`: a null, empty, or fallback-sentinel thread identifier whose uniqueness has not been proven
- `session_id`: governance runtime binding for one live CLI process context
- `current session`: the currently executing CLI invocation together with its bound `thread_id` and `session_id`
- if only one of `thread_id` or `session_id` is bound, the current session is still well-defined for the bound field; precedence tiers that require the missing field fall through to the next tier
- `session binding`: runtime mapping between `thread_id`, `session_id`, and `agent_id`
- `ticket lock`: canonical on-disk record for one ticket's active governed work
- `complete lock`: a ticket lock that satisfies the full canonical lock schema, including the required ownership, `thread_id`, `session_id`, ticket, repo, branch, worktree, start, heartbeat, and `head` commit-anchor field; implementation helpers such as `isCompleteLockPayload(...)` are examples, not normative definitions
- `governed worktree`: prepared product-repo workspace for one ticket
- `managed repos`: the governed repo roots listed in `coord/product/REPOS.md` and exposed through the active governance repo registry
- `live branch binding`: the canonical branch identity for a governed worktree; when a complete lock exists, the lock's branch field is authoritative, otherwise the governed worktree metadata or VCS branch attached to the worktree is used; if sources conflict, the complete lock wins
- `active session`: a session whose heartbeat is newer than `2 x target_heartbeat_cadence`; under the current 5-minute cadence this means newer than 10 minutes
- `dormant session`: a session whose heartbeat is older than the active threshold but newer than the stalled threshold; dormant sessions are not active, but they are not reclaimable by default and still block handle reallocation
- `recent session`: a session whose heartbeat is newer than 24 hours
- `stalled lock`: see the authoritative definition in Section 8.2
- `ordinary session`: any session that has not passed the explicit authority flags described in Sections 7 and 9
- `collision recovery`: any invocation of `gov resume`, `gov agent-rebind --fresh`, or a command path that detects a Section 6.1 hard signal and enters the Section 6.3 recovery order
- `overlap`: any of:
  - same `ticket_id`
  - same governed branch name
  - a worktree path that is exactly equal to the current session's canonical governed worktree root
  - a descendant path that remains inside that same governed worktree root and therefore shares the same `<repo>/.worktrees/<handle>/<ticket>` governance prefix
- `explicit assignment`: one of:
  - a governed command successfully claims or resumes the ticket for the current session
  - a governed transfer or takeover command succeeds
  - a human-admin override flag such as `--human-admin-override "<reason>"` is supplied to a command that supports foreign-ticket action and the event is logged
  - during collision recovery only, a complete lock whose `thread_id` matches the current `thread_id` is treated as bootstrap assignment for same-ticket resume

Provider requirement:
- each supported provider must declare its `thread_id` source and fallback behavior in `coord/docs/provider-thread-id-sources.md`
- that file must list, for each supported provider:
  - the env var or runtime symbol used to derive `thread_id`
  - fallback behavior when the primitive is absent
  - the expected stability guarantee across process, window, and machine restarts
- until that file and primitive exist, same-thread resume logic remains partially advisory
- thread-id matching is by explicit equality only; an `unknown thread_id` on either side must never count as a same-thread match
- before same-thread rules become binding, provider thread sources must be shown non-colliding across concurrent sessions under supported runtimes

Runtime-state classification:
- session-binding stores such as `.runtime/agent_sessions.json` are runtime state, not canonical governed ticket state
- mutations to pure session-binding runtime metadata must not by themselves trigger governance-drift reconciliation
- governance drift should be reserved for canonical ticket artifacts such as ticket locks, board state, plan records, and other governed records

Human-admin precedence:
- human-admin instructions remain the highest authority per `coord/GOVERNANCE.md`
- however, foreign-ticket action should require an explicit override-bearing command path rather than agent self-certification

## 4. Authority And Precedence

General rule:
- durable on-disk artifacts outrank runtime metadata

Current-session identity precedence during collision recovery:
1. current session's own complete canonical ticket lock, matched first by lock-embedded `thread_id` when both sides have known thread ids, otherwise by exact `session_id`; no external binding artifact is required for tier 1
2. current session's governed product-repo worktree plus its live branch binding
3. current session's `thread_id` binding
4. current session's `session_id` binding
5. `agent_id`

Clarifications:
- the worktree is authoritative for what code to inspect and edit
- the worktree is not authoritative for ticket identity when it conflicts with the complete ticket lock
- a `session_id` match with a conflicting known `thread_id` is not ownership; it is a collision signal
- `agent_id` alone is never enough to disturb another ticket

Repo X exception:
- Repo X worktrees may be empty mkdir stubs
- an empty Repo X worktree does not prove ticket identity
- for Repo X, complete lock state and canonical governance metadata are authoritative

Bootstrapping gap:
- current CLI behavior does not always give the session a stable same-thread artifact during binding drift
- the target primitive is a session-local readable record containing at least `(thread_id, current_ticket, claimed_at_utc)`
- until that exists, tier 1 is the only binding precedence rule and tiers 2 through 5 remain advisory design intent
- operator aid such as `gov agentid` (alias: `gov whoami`) should expose the current session binding, owned tickets, and mismatch warnings so rebinding decisions do not require manual archaeology across locks, board state, and runtime metadata

Sub-agent rule:
- sub-agents and skills inherit the parent session binding
- they do not claim separate ownership
- governance mutation must serialize per parent session
- target mechanism: process-local mutation mutex plus cross-process advisory lock such as `.runtime/governance.lock`
- implication: parallel sub-agents may analyze or edit concurrently, but governance mutation should normally remain on the parent session unless a future scoped sub-lock model is adopted

## 5. Command Semantics

### 5.1 `gov pick`

Target meaning:
- `gov pick` is an idle-mode command, not a generic state probe

Load-bearing safety note:
- same-thread resume behavior is unsafe until `thread_id` is provider-declared, non-colliding under supported concurrency, and treated as foreign when the value is unknown
- until those conditions hold, same-thread matching must fall through to the collision path rather than the resume path unless the `session_id` match is exact

Observable-fact constraint:
- the CLI cannot reliably distinguish "human invoked" from "agent invoked"
- therefore the policy must not rely on that distinction unless the caller supplies an explicit signal

Allowed implementation strategies:
- add explicit idle intent such as `gov pick --idle-mode`
- make wrapper commands such as `/next` scan local context before invoking `gov pick`
- or make `gov pick` internally perform the same resume-versus-collision check

Required local-context scan, if wrapper-driven:
1. read the same-session artifact if it exists
2. walk `coord/.runtime/locks/*.lock` and look for a complete lock whose `thread_id` matches the current session, or whose exact `session_id` matches while `thread_id` is unknown on either side
3. walk governed worktree roots across managed repos rather than assuming the current handle path is correct, then confirm a live branch binding as defined in Section 3 for the same ticket
4. for Repo X, skip filesystem worktree heuristics and rely on complete lock or canonical governance metadata
5. if a same-session match is found, short-circuit into resume instead of running a fresh pick

Happy path:
- if `gov pick` finds a `doing` ticket whose complete lock matches the current `thread_id`, or whose `session_id` matches exactly while `thread_id` is unknown on either side, that is resume, not collision

Collision path:
- if the current session is locally idle and `gov pick` finds a foreign `doing` ticket for the same `agent_id`, that is collision or binding drift

### 5.2 `gov start`

Target behavior:
- if `gov start` fails because the owner already appears to hold another `doing` ticket, the message must name likely `agent_id` collision or binding drift
- the default guidance must be fresh rebind, not "repair that other ticket"
- the error text must include the canonical fresh-start path `gov agent-rebind --fresh` and, when the user intends to touch the foreign ticket, the authorized foreign path such as `gov takeover <ticket> --human-admin-override "<reason>"`
- example wording: `Possible agent_id collision on <handle>: another session appears to hold doing ticket <other-ticket> under this handle, but the current session does not match that lock. Recover with \`gov agent-rebind --fresh\`. Do not repair or take over <other-ticket> unless you are explicitly assigned to it; authorized foreign path: \`gov takeover <other-ticket> --human-admin-override "<reason>"\`.`

### 5.3 Wrapper And Landing Commands

- `/next` must not call `gov pick` blindly before checking for local resume context
- `/do <ticket>`, `/land`, and `gov land` must not land a `review` ticket unless that review state belongs to the current session or the current session is explicitly assigned to finish it
- the current `/do` prompt contract is inconsistent with this rule and must be updated before Section 5.3 can be treated as adopted
- transition rule: tickets that were already in `review` before the guard lands are grandfathered and may be landed by any explicitly assigned session; new review transitions must record the reviewing session for guard purposes
- defense-in-depth rule: the skill or harness layer enforces the user-facing behavior, and the CLI enforces the backstop at `gov pick`, `gov start`, and `gov land`; both layers must refuse for the rule to hold

### 5.4 `gov commit` And `gov heartbeat`

Target behavior:
- `gov commit <ticket>` and `gov heartbeat <ticket>` are governance mutations that must keep the canonical ticket lock synchronized with the live governed worktree state
- the lock-metadata write itself is atomic per Section 8.1 (temp-then-rename or equivalent replace-existing primitive); the `head` field is persisted as part of that single atomic lock-metadata write rather than as a separate follow-on mutation
- the combination of local git-commit creation and canonical lock-metadata persistence is **sequenced, not atomic**: for git-backed repos, a crash in the window between the local git commit succeeding and the lock-metadata write completing leaves observable lock-head drift and is recoverable via the documented lock-head rebuild path rather than silent success
- successful `gov commit` must not report success until the resulting SHA has been written to canonical lock `head` through the atomic lock-metadata write
- successful `gov commit` followed by `gov explain` or `gov doctor` must not leave the lock head behind the governed worktree commit
- successful `gov heartbeat` must refresh both heartbeat metadata and the canonical lock head for the unchanged owning ticket when the governed worktree has advanced, through the same atomic lock-metadata write
- lock-head drift after successful commit or heartbeat is forbidden; the only permissible drift window is the crash gap between git-commit creation and lock-metadata persistence above, and that window is never reported as success
- for Repo X tickets, canonical lock `head` must be the sentinel value `coord-no-git-head`; the git-`HEAD` equality predicate does not apply
- for git-backed repos, the observable predicate is: `gov explain <ticket>` must report `lock.head` equal to `git -C <worktree> rev-parse HEAD` when the governed worktree is on the canonical agent branch and not mid-rebase
- if a git-backed worktree is detached, mid-rebase, or otherwise diverged from the canonical branch binding, that is a Section 8.5 conflicting-durable-state halt condition for that ticket

### 5.5 `gov resume`

Target behavior:
- `gov resume <ticket>` is the preferred happy-path recovery command for same-thread drift
- it must rebind the current session to an existing complete lock for that ticket when the lock matches the current `thread_id`
- it may also rebind when the `session_id` matches exactly and `thread_id` is unknown on either side
- same `thread_id` with a different `session_id` is same-thread resume across process restart and must rebind without refusal
- same `session_id` with a different `thread_id` is resume only when the differing `thread_id` is unknown or otherwise disqualified; a conflicting known `thread_id` is a hard collision signal
- it must refuse silent takeover when a different active session already owns the same ticket with a different `thread_id`
- it must not require foreign-ticket repair as the default next step when the current thread already matches the lock
- plain `gov resume <ticket>` against a foreign-thread lock must fail closed and point to the authorized foreign-touch path instead of suggesting ad hoc workarounds such as `gov agents register`

### 5.6 Explicit Transfer And Takeover Commands

Single-ticket foreign-touch actions are distinct from batch foreign cleanup.

- single-ticket foreign-touch actions such as `gov takeover <ticket>` or `gov claim <ticket> --transfer-to <owner>` must require `--human-admin-override "<reason>"`
- they must fail closed when the caller omits the override or when the target ticket does not match the command's documented preconditions
- they must emit an audit event that records the override reason and the pre-transfer owner context
- Section 7 governs these single-ticket explicit takeover surfaces
- Section 9 governs batch or sweeping foreign cleanup surfaces such as `gov orch --cleanup-foreign`; those surfaces require both cleanup mode and human-admin override and must not be conflated with single-ticket takeover

`--force` deprecation:
- the legacy `--force` flag on foreign-touch commands such as `gov claim --transfer-to` must not be the authorization primitive going forward; it provides no override reason, no audit event, and no tiebreaking information, and is strictly weaker than `--human-admin-override`
- during a transition window, `--force` alone must be accepted only when the command can synthesize a default override reason such as `"<legacy --force migration>"` and emit the corresponding audit event as if `--human-admin-override` had been supplied; this preserves operator muscle memory while forcing the audit path to land
- after the transition window closes, `--force` without an accompanying `--human-admin-override "<reason>"` must be rejected with an error pointing at the new path
- `--force` combined with `--human-admin-override "<reason>"` is explicitly permitted: `--force` may continue to carry its traditional "bypass non-safety preconditions" meaning, while `--human-admin-override` carries the auditable foreign-touch authorization
- the transition window length belongs in an execution ticket rather than in this policy note; until that ticket lands, the transition alias behavior is the interim default

### 5.7 Ticket-Scoped Validation And Drift-Note Handling

Target behavior:
- `gov explain`, `gov doctor`, `gov submit`, and `gov land` should default to ticket-scoped validation for the current ticket rather than hard-blocking on unrelated foreign-ticket state
- unrelated foreign malformed locks, stale locks, or drift notes should warn by default and block only when they overlap under Section 3 or when the caller explicitly requests strict global validation
- commands that surface gate or validation failures should distinguish at least `new-on-ticket`, `pre-existing-on-base`, and `environment` failure classes when that comparison data is available
- drift notes that no longer reproduce under ticket-scoped doctor or orchestrator health checks should be eligible for explicit auto-resolution or aging-out rather than accumulating forever as unresolved noise

Current-ticket resolution for scope-aware commands:
- when the caller supplies an explicit `--ticket <id>` argument, that ticket is the validation scope
- when the argument is absent and the current session owns exactly one `doing` ticket (by complete lock match under the Section 4 precedence rules), that ticket is the default scope
- when the argument is absent and the current session owns zero or more than one `doing` ticket, the command runs in **unscoped mode**: it warns on any foreign state, never hard-blocks, and emits an explicit "scope is ambiguous" notice so the operator knows they must either own a ticket or pass `--ticket <id>` to get scoped validation
- strict global validation is opt-in via an explicit flag such as `--strict-global` and bypasses the default ticket scope for operators who need repo-wide health checks

## 6. Collision Signals And Recovery Rules

### 6.1 Hard Signals

Hard signals are deterministic CLI-observable facts and may trigger automatic fail-closed recovery:
- `gov pick` or `gov start` reports that this `agent_id` already has a `doing` ticket and the current session does not match that ticket's complete lock
- a lock file fails full-payload schema validation, for example via the current helper `isCompleteLockPayload(...)`
- a lock file exists but is incomplete under the lock schema
- board status is `doing` but there is no lock file and the associated runtime session-binding `last_seen` or equivalent runtime heartbeat, if present, has not advanced for at least 10 minutes; if no such runtime heartbeat exists, the missing lock plus missing runtime heartbeat is itself the hard signal
- a complete lock matches the current `session_id` while both sides have known `thread_id` values that differ
- more than one complete lock claims the current session by `thread_id` or `session_id` match

Partial locks are in-flight or corrupted state, not abandonment signals.

### 6.2 Soft Signals

Soft signals are inferred observations and should log plus prompt rather than auto-mutate:
- the same `agent_id` appears attached to two live sessions
- the current session loses its `agent_id` while its complete ticket lock or governed worktree still exists
- session binding points to a different ticket than the governed worktree
- runtime session-binding heartbeat for a ticket is fresh but the canonical ticket lock is missing
- warning-level findings from `gov doctor` or `gov orch` that suggest duplicate or suspicious session state but are not backed by hard signals

### 6.3 Recovery Order

Target recovery order:
0. emit `agent-id-collision-recovery-started`
1. if exactly one complete active lock matches the current session under the Section 4 tier-1 rule (`thread_id` match, or exact `session_id` while `thread_id` is unknown on either side), preserve that ticket and resume it
2. else if step 1 finds **more than one** complete lock claiming the current session, no ticket is preserved automatically: the session enters fail-closed recovery, the collision-recovery-failed event is emitted with the candidate lock set (see Section 6.5), and the operator must run an authorized foreign-touch command such as `gov takeover <ticket> --human-admin-override "<reason>"` against the chosen lock to disambiguate; the recovery path must not guess
3. else if no step-1 match exists and the current session has a governed worktree and live branch for one ticket, preserve that ticket and rebuild binding around it
4. else if a foreign `doing` ticket is reported for the current `agent_id`, do not disturb it
5. obtain a currently unclaimed `agent_id` using the atomic handle-allocation rule in Section 8.4; a previously preferred handle may be reused only if it is currently unclaimed, otherwise allocate any currently unclaimed handle; on loss, retry with a different handle
6. return control to the caller with a clean binding; the caller decides whether to re-invoke the original command
7. emit `agent-id-collision-recovery-succeeded` or `agent-id-collision-recovery-failed`

Current implementation gap:
- step 4 is not safely actionable until a command such as `gov agent-rebind --fresh` exists
- until then, ad hoc `gov agents register`, guessed `gov claim --owner ...`, or manual handle picking are not policy-compliant steady-state recovery

Stability aid:
- when rebinding, preserve or set a stable `thread_id`
- provider shims should expose the configured `thread_id` source explicitly rather than relying on inference

### 6.4 Recovery Transaction Model

Recovery tooling must be serializable and crash-recoverable even though it cannot be truly multi-file atomic across separate files.

This section does not promise cross-file atomicity. It promises:
- serializability under the governance runtime lock
- canonical write ordering for durable artifacts
- crash-consistent rollback and retry behavior
- fail-closed behavior when contention, verification, or recovery steps cannot complete safely

Canonical mutation set:
- ticket lock
- board state
- session binding
- worktree metadata

Canonical write order:
1. ticket lock
2. board state
3. session binding
4. worktree metadata

Fail-closed meaning:
- exit nonzero
- do not silently transfer ownership to the current session
- leave the canonical lock untouched if ownership is uncertain
- require explicit resume, cleanup-mode repair, or human-override follow-up rather than guessing

Commands that establish or change ownership, and commands that synchronize governed ticket state such as commit and heartbeat, must use this model or an equivalent stronger model.

Board-restoration scope:
- restoration from the canonical lock during recovery covers ticket ownership and status fields only
- recovery must not invent or overwrite unrelated board metadata such as plan content or narrative fields

Implementation alignment:
- in current `coord/scripts/governance.js` terms, this model refines `withGovernanceMutation(...)`; it does not replace `withGovernanceRuntimeLock(...)`
- transactions that can write shared governance artifacts such as `coord/board/tasks.json` must first acquire the repo-global governance runtime lock, then acquire any ticket-scoped advisory transaction lock inside that runtime-lock scope
- ticket-scoped advisory locks such as `.runtime/tx-locks/<ticket>.tx` are ephemeral serialization guards distinct from durable canonical ticket locks in `.runtime/locks/<ticket>.lock`
- governance or audit events should continue to flow through `appendGovernanceEvent(...)` or its successor sink

Implemented in COORD-223 (builds on the COORD-220 rollback + COORD-246 baseline + COORD-222 co-located guard):

- Canonical nested-lock acquisition order (deadlock-free invariant). The three process-coarse advisory locks have one fixed total order, asserted fail-closed in `coord/scripts/governance-context.js`:
  1. `withGovernanceRuntimeLock` — governance-runtime (outermost; held by `withGovernanceMutation`)
  2. `withCoordStateLock` — coord-state (board/plan/render writes inside the mutation body)
  3. `withAgentStateLock` — agent-state (innermost; registry/session-lease writes)
  A coarser lock may never be acquired while a strictly-finer lock is held; `assertLockOrder(...)` rejects the inversion with a `Lock-order violation` error before acquiring, so the order the code already follows can never silently regress into an intermittent deadlock. Re-entrant re-acquisition (depth counter) is always permitted.
- Idempotency on retry. A governed mutation may pass a stable `metadata.idempotencyKey` derived from its logical intent. After crash recovery reconciles any partial file writes, `withGovernanceMutation(...)` checks for a prior `succeeded` event carrying the same key (`findCommittedMutationByIdempotencyKey`); if one exists the retry is a clean no-op-or-resume — `fn` is not re-run and no duplicate succeeded event is appended. The key is stamped into the succeeded event's `details.idempotency_key`.
- Audited collision events. When a conflict is DETECTED — a reserved-ID duplicate (`reserveTicketId`/file-ticket/open-followup), a stale-write/per-ticket-lock fence, or the COORD-222 co-located-session refusal — `recordGovernanceCollision(...)` appends a journaled `collision-detected` event (`result: "detected"`, `details.conflict_type`, `details.contenders`) BEFORE failing closed. The event log is not part of the rollback snapshot set, so the record survives the rollback the refusal triggers, turning a silent race into an on-chain record queryable via `gov recent [<ticket>]` and `gov explain`. Emission is best-effort and never masks the underlying refusal.

Rollback and recovery protocol:

| Phase | Step | Mutation | If This Step Fails | Required Result |
| --- | --- | --- | --- | --- |
| `Acquire` | 0 | enter `withGovernanceRuntimeLock(...)`, then acquire a nested ticket-scoped advisory tx lock such as `.runtime/tx-locks/<ticket>.tx` | contention persists or a dead holder leaves stale tx-lock state | wait up to 5 seconds, then fail closed; the acquire path must be able to reclaim tx locks held by dead processes, or use an OS lock primitive that auto-releases on process death |
| `Read` / `Plan` | 0.5 | load canonical artifacts and compute planned artifact states from the in-memory view plus explicitly captured inputs such as current time, generated identifiers, and current git `HEAD` | preconditions or planning fail | no durable writes occur; exit nonzero; release acquired locks |
| `Write` | 1 | create or verify canonical ticket lock | no later state may be written | command exits nonzero; board, binding, and worktree metadata remain unchanged |
| `Write` | 2 | persist board owner and status from canonical lock, and render derived board artifacts from canonical state | board write or rendering fails after lock exists | first attempt restore owner and status from canonical lock; if restore also fails, mark board inconsistent and fail closed; do not advance binding |
| `Write` | 3 | persist session binding | binding write fails after lock and board succeeded | rebuild binding from canonical lock on next recovery attempt; do not mutate foreign lock; fail closed |
| `Write` | 4 | persist worktree metadata | worktree metadata write fails after lock, board, and binding succeeded | keep canonical lock and board authoritative; rebuild worktree metadata from lock on next recovery attempt; fail closed |
| `Verify` | 5 | run post-mutation verification, including schema validation of written artifacts plus cross-artifact consistency checks against the canonical lock | any artifact disagrees with canonical lock or planned post-state | first attempt rollback from the scoped rollback snapshot for artifacts written by this transaction; if rollback succeeds, exit nonzero and record a repair-needed event scoped to that ticket; if rollback fails, leave the canonical lock as tiebreaker, mark repair-needed, and fail closed |
| `Release` | 6 | durably append the corresponding governance or audit event, then release the nested tx lock and exit the runtime-lock scope | event append or lock release fails | committed `Write` artifacts remain authoritative and are not rolled back; do not report success without a durable event; leave or reclaim the tx lock via the next acquire path or explicit repair flow and record release failure as repair-needed |

Transaction phases:
- each transaction that uses this model proceeds in strict phase order: `Acquire`, `Read`, `Plan`, `Write`, `Verify`, `Release`
- `Acquire` first enters the repo-global governance runtime lock, then obtains a nested ticket-scoped advisory transaction lock such as `.runtime/tx-locks/<ticket>.tx` via an atomic create-if-absent or equivalent advisory-lock primitive; it waits up to 5 seconds on contention and then fails closed if it still cannot acquire
- `Read` loads all canonical artifacts the transaction will inspect or write into an in-memory view
- `Plan` computes the new artifact states from the in-memory view plus explicitly captured inputs such as current time, generated identifiers, and current git `HEAD`; no durable writes occur in `Plan`
- `Write` applies the planned writes in the canonical write order defined above, one artifact per step, using an atomic replace primitive per Section 8.1
- `Verify` re-reads the written artifacts and confirms that post-conditions match the plan
- `Verify` must re-read each artifact written in this transaction, validate each artifact against its schema, and confirm that the union of written artifacts is consistent with the canonical lock as tiebreaker per Section 8.5
- `Release` durably appends the corresponding governance or audit event before releasing the nested tx lock and leaving the runtime-lock scope
- a transaction that fails in any phase must enter the rollback and recovery protocol without writing any later-phase artifact
- phase-to-step mapping is fixed: `Acquire` is step 0, `Read` and `Plan` are step 0.5, `Write` covers steps 1 through 4, `Verify` is step 5, and `Release` is step 6

Validation placement:
- cross-artifact consistency validation such as "lock matches board" or "board matches worktree" runs only in the `Verify` phase, never between `Write` steps of the same transaction
- whole-repo integrity validators such as `validateBoardState` must not be invoked between write steps of a multi-artifact mutation; calling them mid-transaction makes the normal transition window observable as a consistency failure even though the mutation is internally consistent
- derived-artifact rendering such as `PLAN.md`, `coord/board/tasks.md`, or prompt-index regeneration may run during `Write` if it is computed from canonical in-memory state and does not perform cross-artifact validation or halt on transient intermediate mismatch
- implementation note: functions such as `runBoardSync` should be split into rendering and validation modes if they currently bundle both behaviors
- pre-conditions that can be evaluated from in-memory state must be evaluated during the `Plan` phase, not re-validated from disk between `Write` steps

Scoped snapshots:
- the rollback restore point captured before the `Write` phase must cover only the artifacts the transaction plans to write plus any durable state it reads as part of its pre-conditions
- capturing the full governed file set and restoring it on failure is forbidden for per-transaction rollback, because a full-set restore interleaves unrelated concurrent work and can undo mutations that were made by other tickets during this transaction's window
- this prohibition applies to rollback snapshots only; full-set snapshots used for audit or journal digests may remain full-set if they are not replayed as rollback primitives
- implementation note: the current `captureGovernanceRestorePoint` helper in `coord/scripts/governance.js` uses a full-set snapshot and is not a per-transaction rollback primitive under this section; `buildGovernanceSnapshot(...)` or equivalent audit-digest helpers may remain full-set when used only for journaling or reporting

Idempotency on retry:
- a transaction that fails in any phase after `Read` must be safe to retry from `Acquire` without producing divergent state
- given identical inputs, the terminal state of a clean run and the terminal state of a retry after partial failure must be equal for every artifact the transaction touches
- terminal-state equivalence is structural rather than byte-for-byte across every field: ownership, ticket identity, branch, worktree, `head`, and other non-ephemeral fields must converge to the same values; timestamp or monotonic-progress fields such as `started_at_utc`, `heartbeat_utc`, or equivalent counters may differ only by forward progression required to represent the later retry attempt
- commands whose flow drives external side effects such as `git push` or PR creation must not be retried blindly by the transaction layer after those side effects may have occurred
- acceptable models are:
  - a durable idempotency receipt or side-effect record that proves the external action already succeeded and allows retries to skip it safely
  - or fail-closed behavior that leaves the governance mutation committed but requires explicit caller or user re-invocation of the external side-effect step
- implementation note: the current in-memory `externalSideEffects` context in `withGovernanceMutation(...)` is not by itself a durable retry receipt and is therefore insufficient for blind automatic retry across process failure

Composed-command rule:
- commands that internally compose other governance mutations must pass a single transaction handle through the composition rather than re-entering `Acquire` for the same ticket
- reentrant tx-lock acquisition is not guaranteed by this policy
- if a composed command must cross a checkpoint that requires releasing and later reacquiring the transaction, the checkpoint must be explicit and the command must handle the race that another transaction may acquire during that gap

### 6.5 Audit Event Schema

Required audit events:
- `agent-id-collision-recovery-started`
- `agent-id-collision-recovery-succeeded`
- `agent-id-collision-recovery-failed`

Required fields:
- `ts_utc`
- `policy_version`
- `command`
- `ticket_id` with `null` allowed for pure rebind events that have no ticket target
- `session_id`
- `thread_id`
- `previous_agent_id`
- `new_agent_id` if allocated
- `preserved_ticket` if any
- `foreign_ticket` if any
- `trigger_signal`
- `outcome`
- `override_reason` if any

Conditional enrichment fields:
- when `outcome` is `failed` and `trigger_signal` is `multiple-locks-match-current-session` (see Section 6.3 step 2), the event must include `candidate_locks`, a list of objects containing at minimum `{ticket_id, claimed_at_utc, head, worktree, branch, thread_id, session_id}` for each lock that claimed the current session; this enrichment exists so an operator receiving the failed event can run the authorized foreign-touch command against the clearly-right lock without reading `.runtime/locks/` by hand
- when `outcome` is `failed` and the session entered fail-closed recovery because of conflicting durable state (Section 8.5), the event must include a `conflicting_artifacts` list naming the artifacts that disagreed with the canonical lock

Destination and retention:
- emit to the governance event log at one concrete runtime path declared by the governance implementation; until that path is declared, this section remains partially advisory
- retain under the canonical governance audit-retention policy; until that policy is defined, retain indefinitely

## 7. Non-Interference And Human Override

Default rule:
- another ticket's governance problems are informative only unless they overlap as defined in Section 3

Therefore unrelated foreign issues should not block current-ticket work by default:
- stale foreign lock
- malformed foreign lock
- missing foreign lock
- foreign orphaned owner
- foreign duplicate binding

Agents must not take over, repair, reclaim, or mutate another ticket unless one of the following is true:
- the current session is explicitly assigned to that ticket
- a foreign-touch command such as `gov takeover <ticket> --human-admin-override "<reason>"` succeeds

Anti-example:
- Agent Alice sees a stale `GOV-001` lock owned by Bob while Alice is trying to pick her own next ticket
- Alice's correct action is to log or surface the observation, continue her own pick path, and avoid mutating `GOV-001` unless she is using an explicit cleanup or takeover path

This section is the default safety rule, not a limit on direct human-admin authority.

## 8. Cleanup And Race Rules

### 8.1 Lock Safety

Required implementation properties:
- lock writes must be atomic
- use platform-appropriate atomic replace semantics, for example `rename(2)` within one filesystem on Unix-like systems or the equivalent replace-existing primitive on other supported platforms
- readers must validate the full required field set before trusting a lock
- partial locks must never be treated as stale abandonment

### 8.2 Heartbeat Cadence And Stale Threshold

Heartbeat cadence must be defined:
- heartbeat advances on every governance mutation
- heartbeat also advances periodically while a governed worktree exists without requiring a foreground governance command; target maximum interval is 5 minutes
- the periodic heartbeat must be emitted by a session-bound host process started when a session enters governed `doing` ownership and stopped when ownership is released or the ticket leaves `doing`
- short-lived foreground `gov` command invocations alone are insufficient to satisfy active-session semantics
- long-blocked or stalled agents are intentionally indistinguishable from crashed agents at the heartbeat layer; the 24-hour threshold is sized to tolerate long pauses without triggering premature reclaim

Heartbeat host — preferred and fallback:
- **preferred host**: the governance MCP server (for example `coord/scripts/governance-mcp.js` under the Claude Code harness) is a stdio-transported, long-lived, session-bound process whose lifecycle already matches a single agent session; the periodic heartbeat timer should run inside this process so heartbeat cadence is preserved for as long as the agent session is alive
- **Claude tab lifecycle note**: the MCP-hosted timer's lifetime is the Claude Code process, not the user's terminal shell; closing the Claude Code tab terminates the MCP server and therefore stops the heartbeat, even if the user's terminal remains open; the stall clock for Section 8.2 begins at that moment; this is intended behavior for reclaim timing and must be documented in operator-facing agent shims
- **fallback host for non-MCP sessions**: agent sessions without an MCP server surface (raw CLI usage, providers without MCP support) must either start a separate sidecar heartbeat process at `gov start` time and reap it on session end, or operate in a **mutation-triggered-only** mode where heartbeat advances only on explicit governance mutations; mutation-triggered-only mode is a deliberately weakened variant that makes active-session semantics weaker for that session and must be surfaced to the operator
- whichever host is chosen, the cadence target remains 5 minutes and the active-session threshold remains 10 minutes; mutation-triggered-only sessions will routinely fall below the active threshold between commands and must be recognized as such rather than treated as stalled

Current policy number:
- 24 hours is the stale threshold because it distinguishes dead or abandoned sessions from transient quiet periods
- at the target 5-minute cadence, 24 hours equals 288 missed heartbeats
- the active-session threshold is `2 x target_heartbeat_cadence`; under the current 5-minute cadence this is 10 minutes

Definition:
- stale cleanup is based on heartbeat age of complete state
- it is not based on last commit time or shell uptime

Stalled-lock handling:
- a complete active lock with no heartbeat advance for at least 24 hours is `stalled`, not live
- stalled locks are admin-reviewable and reclaimable only through explicit cleanup authority such as `gov orch --cleanup-foreign` or `gov lock-abandon <ticket> --human-admin-override "<reason>"`

Dormant-session handling:
- a complete lock with heartbeat older than the active threshold but newer than the stalled threshold is `dormant`
- a dormant session still owns its complete lock
- dormant state by itself is informative only; it is not a collision signal and not an auto-reclaim condition
- dormant sessions block handle reallocation for their bound `agent_id`; handles may be reclaimed only after the owning session becomes stalled or is garbage-collected

Idle-session GC:
- sessions with no complete active lock should be eligible for garbage collection on a shorter schedule than stalled locks
- target rule: idle recent sessions older than 60 minutes may be reaped without ticket cleanup authority because they do not carry ticket ownership

Required model:
- if the system wants "mark stale before delete", it must add an explicit stale marker or equivalent intermediate state
- until such a state exists, the implementation must describe direct stale cleanup honestly rather than implying a marker already exists

### 8.3 Create-Lock Race

Initial create-lock race is separate from recovery race.

Required rule:
- canonical ticket-lock creation must be atomic create-if-absent
- first successful creator wins the ticket claim
- loser must fail closed and re-read state rather than attempting repair
- if a creator crashes after writing the canonical lock but before rebuilding mirrored state such as the board, the canonical rebuild trigger is ticket-scoped `gov doctor --fix --ticket <ticket>`; explicit recover commands or cleanup-mode orchestrator cycles may provide equivalent repair as secondary paths

### 8.4 Handle-Allocation Race

Handle allocation has the same TOCTOU problem as lock creation.

Required rule:
- currently unclaimed handle allocation must use atomic test-and-set
- a loser must retry with a different handle rather than mutating the foreign binding it lost to
- retries must be bounded by the provider pool size; if the pool is exhausted, fail closed with a distinct exhaustion error rather than looping indefinitely

### 8.5 Conflicting Durable State

If conflicting durable state somehow exists anyway:
- canonical ticket lock beats mirrored metadata such as board owner or session binding
- if durable artifacts still disagree after that comparison, the CLI must halt for that ticket only and require explicit human or cleanup-mode repair rather than guessing
- unrelated tickets continue under the non-interference rule in Section 7

The system should prefer fail-closed over silent takeover.

## 9. Cleanup Authority

Cleanup authority must be explicit.

- `gov orch` is a command, not a separate daemon by default
- ordinary sessions do not implicitly gain authority to mutate foreign sessions
- Section 7 governs single-ticket foreign-touch commands; Section 9 governs batch or sweeping foreign cleanup surfaces and they must remain distinct
- foreign cleanup must require explicit cleanup mode such as `--cleanup-foreign` and an explicit override such as `--human-admin-override "<reason>"`
- report-only health checks must be the default
- any foreign cleanup mutation must emit an audit event that records command, operator session, target ticket or session, and `override_reason`
- today `gov orch` does not consistently provide this capability; Section 10 tracks that gap as broken or advisory until implemented

## 10. Enforcement Matrix

Tracking note:
- until decomposed into child governance tickets, the broken and advisory rows below are carried by `GOV-001` or an explicit successor ticket in the governance plan
- target dates belong in the execution tickets, not in this policy note
- row statuses may be `broken`, `advisory`, `partially enforced`, or `enforced`
- current backlog alignment: `GOV-006` primarily carries session-rebinding and repo X repair ergonomics, `GOV-008` primarily carries ticket-scoped validation isolation, gate attribution, and stale drift-note cleanup, while `GOV-007`, `GOV-005`, and `GOV-002` remain adjacent but mostly out of scope for collision-recovery rules

| Section | Rule | Status Today | CLI Backing Today | CLI Change Needed |
| --- | --- | --- | --- | --- |
| 3 | overlap is limited to the same governed worktree root or a descendant inside that same governance prefix, not arbitrary ancestors | broken | overlap semantics are not formalized at this precision | codify governed-worktree-root overlap checks and tests |
| 4 | tier-1 ownership is determined from lock-embedded `thread_id` first, with exact `session_id` fallback only when `thread_id` is unknown | advisory | lock fields exist but tier-1 semantics are not formalized | codify thread-id-first lock match logic, conflict handling, and tests |
| 4 | same-session artifact exists for resume identity | broken | none reliable | add stable readable same-thread artifact |
| 4 | operator identity introspection such as `gov agentid` (alias: `gov whoami`) exposes current binding, owned tickets, and mismatch warnings | advisory | identity is spread across multiple surfaces and requires manual synthesis | add a supported introspection command or equivalent MCP surface for current-session identity |
| 3 | same-thread matching uses explicit non-null, non-sentinel `thread_id` equality and treats unknown values as foreign | broken | unknown and fallback semantics are not formally defined | define matching semantics, sentinel handling, and collision tests |
| 3 | runtime session-binding state such as `.runtime/agent_sessions.json` is excluded from governance-drift reconciliation when ticket state is unchanged | broken | runtime churn is often reported as governance drift | classify session-binding files separately and suppress pure runtime drift noise |
| 4 | sub-agent mutation serialization uses process-local mutex plus advisory file lock | partially enforced | in-process serialization exists in some paths | add cross-process advisory lock and tests |
| 5.1 | `gov pick` is idle-mode or resume-aware | advisory | none reliable | add `--idle-mode` or internal same-thread resume check |
| 5.3 | `/next` performs the defined pre-pick local-context scan | broken | wrapper behavior is not guaranteed | implement the scan defined in Section 5.1 or call resume-aware `gov pick` |
| 5.2 | `gov start` identifies collision and points to fresh rebind | broken | owner-conflict check exists but message is wrong | change error text and add fresh-rebind path |
| 5.3 | `/do`, `/land`, and `gov land` refuse review landing on foreign-owned review ticket | broken | CLI and skill behavior both incomplete | update skill wrappers and add CLI ownership or explicit-assignment guard |
| 5.4 | `gov commit` updates canonical lock `head` for git-backed repos after local commit creation and treats post-commit/pre-lock crashes as recoverable lock-head drift | broken | commit paths can leave stale lock head drift | define git-backed commit sequencing and the corresponding lock-head recovery path |
| 5.4 | lock-metadata write is atomic per Section 8.1 as a single operation; the git-commit-plus-lock-write pair is sequenced rather than atomic and the crash window is recoverable as lock-head drift, never reported as success | broken | Section 5.4 earlier appeared to promise cross-file atomicity; atomicity scope is now scoped to the lock-metadata write alone | reword implementations and error messages to distinguish lock-metadata atomicity from git-commit-plus-lock sequencing |
| 5.4 | `gov heartbeat` refreshes heartbeat and canonical lock head together | broken | heartbeat behavior exists but lock-head sync is inconsistent | update heartbeat mutation flow to sync lock head and heartbeat together |
| 5.4 | Repo X tickets use sentinel lock head `coord-no-git-head` and are exempt from git-`HEAD` equality checks | partially enforced | coord lock-head sentinel behavior exists in validators and repair paths | codify the observable predicate carve-out and add Repo X tests |
| 5.5 | `gov resume` rebinds same-thread sessions without silent takeover, using exact `session_id` fallback only when `thread_id` is unknown | partially enforced | some resume behavior exists | codify same-thread semantics, exact-session fallback, conflicting-owner refusal, and guided error text |
| 5.6 | single-ticket foreign-touch commands exist, require `--human-admin-override`, and are distinct from batch cleanup surfaces | broken | examples and partial transfer surfaces exist, but command semantics are not fully codified | specify takeover or transfer command semantics and audit requirements |
| 5.6 | bare `--force` on foreign-touch commands is deprecated; during the transition window it is aliased to `--human-admin-override "<legacy --force migration>"` so the audit event still lands; after the window it is rejected without an explicit override reason | broken | `--force` currently provides no audit event and no override reason | alias during transition, reject after transition, keep `--force` + `--human-admin-override` combination for non-safety precondition bypass |
| 5.7 | `gov explain`, `gov doctor`, `gov submit`, and `gov land` default to ticket-scoped validation and warn rather than hard-block on unrelated foreign state unless overlap or strict mode applies | broken | some commands still surface unrelated foreign drift as blockers | implement ticket-scoped validation defaults plus explicit strict global mode |
| 5.7 | ticket-scope resolution for scope-aware commands: explicit `--ticket` wins, else the session's single owned `doing` ticket is the default scope, else the command runs unscoped (warn-only, never hard-block) with an ambiguous-scope notice | broken | scope resolution is not formalized and ticket-less invocations behave inconsistently | implement the three-case resolution and emit the ambiguous-scope notice when no current ticket context exists |
| 5.7 | gate and validation diagnostics distinguish `new-on-ticket`, `pre-existing-on-base`, and `environment` failure classes when comparison data exists | advisory | gate output is mostly binary pass/fail today | persist base-vs-ticket comparison artifacts and classify failure origin |
| 5.7 | stale drift notes that no longer reproduce are auto-resolved or aged out safely instead of accumulating indefinitely | advisory | drift notes accumulate even after ticket-local doctor is clean | add doctor or orch-driven stale-drift resolution or aging policy |
| 6.1 | partial lock is in-flight, not abandoned | partially enforced | `isCompleteLockPayload(...)` exists | require readers to fail closed on incomplete lock everywhere |
| 6.1 | `doing` status with missing lock and stale heartbeat is a collision or abandonment signal | broken | no consistent detector | add detector and surface it in doctor, pick, and orch |
| 6.1 | multiple complete locks matching the current session, or `session_id` matches with conflicting known `thread_id`, are hard collision signals | broken | no consistent detector | add conflict detection and fail-closed handling |
| 6.3 | multiple-lock matches enter fail-closed recovery at Section 6.3 step 2 without preserving any ticket; no automatic disambiguation is permitted | broken | no multi-match recovery path is defined | implement multi-match detection and fail-closed emission before step-1 preservation runs |
| 6.2 | fresh runtime heartbeat plus missing canonical lock is logged as a soft signal and never auto-mutates by itself | advisory | missing-lock handling does not distinguish fresh from stale runtime heartbeat | add soft-signal classification and operator prompts |
| 6.2 | soft signals are logged distinctly and never auto-mutate by themselves | advisory | signal severity is not formalized | add soft-signal logging path and operator prompts |
| 6.3 | preserve same-thread active lock before allocating new handle | advisory | some resume paths exist, but no single invariant | add stable same-thread artifact and short-circuit resume path |
| 6.3 | obtain currently unclaimed handle without touching foreign ticket | broken | manual `agent-release` and `claim` are possible | add `gov agent-rebind --fresh` |
| 6.4 | recovery follows documented write ordering and crash recovery rules | broken | no documented transaction boundary | implement canonical ordering, rollback, and lock-first rebuild behavior |
| 6.4 | transactions enter the repo-global governance runtime lock first and hold a nested ticket-scoped advisory tx lock with bounded wait | broken | `withGovernanceRuntimeLock(...)` exists, but there is no nested tx-lock primitive or bounded-wait rule | keep the global runtime lock, add nested `.runtime/tx-locks/<ticket>.tx`, and enforce bounded wait then fail-closed behavior |
| 6.4 | cross-artifact validation runs only in the `Verify` phase, while derived-artifact rendering may run during `Write` | broken | `claimTicket` and other paths invoke bundled `runBoardSync`/`validateBoardState` behavior between their own write steps | split rendering from validation and move cross-artifact validation to post-`Verify` only |
| 6.4 | per-transaction rollback snapshots are scoped to the mutation's target artifacts, while audit or journal snapshots may remain full-set | broken | `captureGovernanceRestorePoint` snapshots the full governed file set | introduce a scoped rollback snapshot primitive and keep full-set snapshots only for audit or journaling use |
| 6.4 | `Verify` failure attempts rollback from the scoped snapshot before failing closed | broken | verify-time rollback is not formalized | restore planned artifacts from the scoped snapshot on verify failure and add tests |
| 6.4 | partial transactions are idempotent on retry and external side effects use durable receipts or explicit caller re-invocation | advisory | no retry-equivalence contract or durable receipt model exists | add idempotency requirement, retry-equivalence tests, and external-side-effect receipt or fail-closed caller retry semantics |
| 6.4 | release persists the audit event before tx-lock release, and stale tx-locks are reclaimable on the next acquire path | broken | release ordering and stale-tx-lock recovery are not formalized | persist event before release and add dead-holder tx-lock reclaim logic or auto-release lock primitive |
| 6.4 | composed commands pass a single transaction handle rather than re-entering `Acquire` for the same ticket | advisory | command composition exists, but transaction-handle reuse is not formalized | thread a single transaction handle through composed governance commands and add tests |
| 6.5 | collision recovery audit events have defined schema and emit on every path | broken | no dedicated schema | define schema and log start, success, and failure events |
| 6.5 | failed events triggered by multiple-lock match include a `candidate_locks` list with each claiming lock's `ticket_id`, `claimed_at_utc`, `head`, `worktree`, `branch`, `thread_id`, and `session_id`, so operators can disambiguate without reading lock files by hand | broken | no enrichment for multi-match failures exists | persist candidate-lock enrichment in the failed event payload when the trigger is multi-match |
| 7 | foreign broken state must not block unrelated work | broken | `gov orch` can hard-abort on unrelated stale lock | make report-only default and gate mutation behind explicit flag |
| 7 | foreign-touch escape hatch exists and requires `--human-admin-override` | broken | no named mandatory path | add `gov takeover` or equivalent with mandatory override logging |
| 8.1 | atomic lock writes | advisory | not guaranteed by policy | write temp then rename; add tests |
| 8.2 | heartbeat cadence is hosted inside the governance MCP server by default for Claude Code sessions; non-MCP sessions fall back to an explicit sidecar process or a mutation-triggered-only mode surfaced to the operator | broken | no formalized host for the periodic timer | implement an MCP-hosted heartbeat timer bound to the Claude Code session lifecycle, provide a sidecar fallback for non-MCP providers, and emit an operator notice when running in mutation-triggered-only mode |
| 8.2 | MCP-hosted heartbeat timer lifetime matches the Claude Code process, not the user terminal; closing the Claude tab stops the heartbeat and begins the stall clock | advisory | lifetime semantics are not documented in operator-facing shims | document the tab-closure stall-clock behavior in agent-facing shims and operator runbooks |
| 8.2 | stalled complete locks are reclaimable only through explicit cleanup authority | broken | no explicit abandoned-lock path | add `gov orch --cleanup-foreign` and or `gov lock-abandon` |
| 8.2 | dormant sessions block handle reallocation until they stall or are garbage-collected | advisory | dormant-state semantics are not enforced | make handle allocation honor dormant ownership and add tests |
| 8.2 | idle session garbage collection is defined separately from stalled-lock cleanup | advisory | no separate idle-session GC rule | add shorter idle-session GC behavior and tests |
| 8.3 | create-lock race resolves by atomic create-if-absent | advisory | not documented as invariant | implement atomic create-if-absent and loser path |
| 8.3 | crash-after-lock inconsistency has a canonical rebuild trigger at ticket-scoped `gov doctor --fix` | broken | trigger is not formalized as canonical | make ticket-scoped `gov doctor --fix` the primary rebuild path and treat recover or cleanup-mode orch as secondary equivalents |
| 8.4 | handle allocation uses atomic test-and-set | advisory | not documented as invariant | implement atomic handle claim and retry path |
| 8.4 | handle-allocation exhaustion fails closed with a distinct error | advisory | exhaustion behavior undefined | bound retries to pool size and emit exhaustion error |
| 8.5 | conflicting durable state halts per-ticket only while unrelated tickets continue | advisory | fail-closed scope is not formalized | implement ticket-scoped halt behavior |
| 9 | cleanup mode is explicit, report-only is default, and foreign cleanup also requires `--human-admin-override` | advisory | `gov orch` actor semantics are implicit | add `--cleanup-foreign`, require override, and audit logging |
| 6.5 | audit log destination is declared as a single canonical runtime path | advisory | destination path not formalized | declare one concrete event-log path in governance runtime docs and implementation |
| 3 | provider thread-id sources are declared for all supported providers | broken | no canonical declaration file | add `coord/docs/provider-thread-id-sources.md` |
| 10 | provider-scoped pool expansion is formalized | advisory | allocator does not honor provider pool plan | add provider-aware allocator |
| 10 | `gov agents register` must not silently auto-allocate | broken | auto-allocation footgun exists | require explicit flags or reject |

## 11. Adoption Criteria

### 11.1 Partial Adoption Model

This policy is not all-or-nothing.

- Section 12 is immediate guidance
- any other section enters force only when its corresponding matrix rows are implemented and tested
- a partially adopted section must be labeled as such in the canonical governance doc
- claiming that Sections 4 through 9 are binding requires all minimum-safety rows, all additional preconditions, and all regression tests in this section to pass; anything less must be labeled partial adoption

### 11.2 Minimum Safety Rows For Collision Adoption

The following matrix rows are minimum prerequisites before claiming collision safety:
- Section 3 overlap semantics are restricted to the same governed worktree root or descendant path within that same governance prefix
- Section 4 tier-1 lock-embedded ownership matching
- Section 4 thread-id-first tier-1 matching with exact-session fallback only when `thread_id` is unknown
- Section 4 same-session artifact exists for resume identity
- Section 3 same-thread matching uses explicit non-null, non-sentinel equality
- Section 3 runtime session-binding classification
- Section 5.1 `gov pick` is idle-mode or resume-aware
- Section 5.2 `gov start` identifies collision and points to fresh rebind
- Section 5.3 `/next` pre-pick local-context scan
- Section 5.3 review-landing guard on `/do`, `/land`, and `gov land`
- Section 5.4 lock-head synchronization on `gov commit` and `gov heartbeat`
- Section 5.4 lock-metadata write is atomic per Section 8.1 while the git-commit-plus-lock-write pair is sequenced and recoverable as lock-head drift
- Section 5.4 Repo X sentinel-head carve-out for observable lock-head predicates
- Section 5.5 `gov resume` same-thread rebind and foreign-thread refusal
- Section 5.6 explicit single-ticket foreign-touch command semantics
- Section 5.6 bare `--force` deprecation with transition alias to `--human-admin-override`
- Section 5.7 ticket-scoped validation default for `gov explain`, `gov doctor`, `gov submit`, and `gov land`
- Section 5.7 ticket-scope resolution for ticket-less invocations: explicit-argument, single-owned-ticket default, and ambiguous unscoped-mode
- Section 6.1 partial lock fail-closed everywhere
- Section 6.1 `doing` with missing lock and stale heartbeat detector
- Section 6.1 conflicting known `thread_id` versus `session_id` match and multiple-lock hard-signal detection
- Section 6.3 multiple-lock match enters fail-closed recovery without automatic disambiguation
- Section 6.3 currently unclaimed handle acquisition via fresh rebind
- Section 6.4 documented write ordering and crash recovery
- Section 6.4 transaction phase ordering plus repo-global runtime lock and nested ticket-scoped tx lock with bounded wait
- Section 6.4 validation-placement rule: cross-artifact validation waits for `Verify`, while rendering may run during `Write`
- Section 6.4 scoped rollback snapshot primitive replaces full-set restore for rollback without forbidding full-set audit snapshots
- Section 6.4 verify failure rolls back from the scoped snapshot before failing closed
- Section 6.4 release ordering persists the audit event before tx-lock release and supports dead-holder tx-lock reclaim
- Section 6.4 composed commands reuse one transaction handle per ticket
- Section 6.5 audit event schema and emission
- Section 6.5 `candidate_locks` enrichment on failed events triggered by multi-lock match
- Section 7 foreign broken state does not block unrelated work
- Section 7 foreign-touch escape hatch with `--human-admin-override`
- Section 8.1 atomic lock writes
- Section 8.2 MCP-hosted heartbeat timer for Claude Code sessions with sidecar or mutation-triggered-only fallback for non-MCP providers
- Section 8.2 explicit stalled-lock cleanup path
- Section 8.2 dormant sessions block handle reallocation
- Section 8.3 create-lock atomic create-if-absent
- Section 8.3 canonical crash-after-lock rebuild trigger at ticket-scoped `gov doctor --fix`
- Section 8.4 handle-allocation atomic test-and-set
- Section 9 explicit cleanup mode with report-only default and required `--human-admin-override`
- Section 10 `gov agents register` explicit allocation behavior

### 11.3 Additional Preconditions

Before same-thread tests are meaningful:
- the bootstrapping gap in Section 4 must be closed with a stable readable same-thread artifact
- provider thread-id sources must be declared in `coord/docs/provider-thread-id-sources.md`
- provider thread sources must be validated as non-colliding across concurrent supported sessions
- unknown or fallback thread identifiers must be treated as foreign by default rather than matching by null-or-sentinel equality

Before foreign-touch commands are meaningful:
- `--human-admin-override` or equivalent must exist, be mandatory on foreign-touch paths, and be recorded in audit history

Before agent-facing rollout is called complete:
- shims and runtime-facing agent docs must publish a distilled runtime-behavior extract derived from Sections 5, 7, and 12 instead of forcing agents to re-derive behavior from the full policy matrix during execution

Adoption-status tracking:
- the canonical governance doc must expose a section-level adoption table, for example at `coord/GOVERNANCE.md#identity-adoption-status`, maintained by the governance CLI maintainers as matrix rows land

Before collision recovery can be called adopted:
- `gov agent-rebind --fresh` or an equivalent safe fresh-handle command must exist
- the recovery transaction model in Section 6.4 must be implemented, not only documented

### 11.4 Regression Tests

The CLI must have regression tests for at least these cases:
- same-thread resume is distinguished from foreign collision
- same governed-worktree-root overlap is recognized without treating shared ancestor directories as overlap across unrelated tickets
- unknown or fallback `thread_id` values never qualify as same-thread matches
- exact `session_id` match with conflicting known `thread_id` values is treated as a hard collision signal, not resume
- `gov resume` rebinds same-thread drift without silent takeover
- `gov resume` may use exact `session_id` fallback only when `thread_id` is unknown on either side
- same `thread_id` with a new `session_id` is treated as resume across process restart
- plain `gov resume <ticket>` fails on a foreign-thread lock and points to the authorized foreign-touch path rather than ad hoc workarounds
- foreign stale or malformed ticket state does not block unrelated `gov pick`
- wrapper commands such as `/next` or `/do <foreign-ticket>` refuse foreign-thread work without the required override path
- `gov explain`, `gov doctor`, `gov submit`, and `gov land` warn rather than hard-block on unrelated foreign-ticket state unless overlap or explicit strict mode applies
- scope-aware commands invoked with explicit `--ticket <id>` use that ticket as the validation scope
- scope-aware commands invoked without `--ticket` default to the session's single owned `doing` ticket when exactly one exists
- scope-aware commands invoked without `--ticket` and with zero or more than one owned `doing` tickets run in unscoped mode: they warn on foreign state, never hard-block, and emit an explicit ambiguous-scope notice
- `--strict-global` opts a scope-aware command into repo-wide validation regardless of current ticket ownership
- pure `.runtime/agent_sessions.json` churn without ticket-state change does not trigger governance-drift reconciliation
- partial lock is rejected as in-flight or corrupted, not reclaimed
- `doing` with missing lock is detected as collision or abandonment signal
- a fresh runtime heartbeat with missing canonical lock is logged as a soft signal and does not auto-mutate
- more than one complete lock matching the current session is detected as a hard signal and triggers fail-closed recovery
- multi-lock fail-closed recovery never guesses a preserved ticket and never preserves any of the conflicting claims automatically; the collision-recovery-failed event is emitted with `candidate_locks` enrichment containing each claiming lock's `ticket_id`, `claimed_at_utc`, `head`, `worktree`, `branch`, `thread_id`, and `session_id`; the operator disambiguates via an authorized foreign-touch command
- create-lock race has one winner and one fail-closed loser
- crash after canonical lock creation but before mirrored-state rebuild is recoverable via ticket-scoped `gov doctor --fix`
- handle-allocation race has one winner and one retrying loser
- handle-allocation exhaustion fails closed with a distinct exhaustion error
- a dormant session prevents handle reallocation for its bound `agent_id` until the session becomes stalled or is garbage-collected
- fresh rebind allocates a currently unclaimed handle without mutating foreign tickets
- landing from `review` fails when the review state belongs to another session unless explicit assignment is provided
- gate or validation diagnostics with base-comparison data classify `new-on-ticket`, `pre-existing-on-base`, and `environment` outcomes distinctly
- `gov commit` updates the canonical lock head atomically with the committed governed worktree state
- the lock-metadata write itself is atomic per Section 8.1 as a single replace-existing operation, with `head` persisted inside that same write rather than as a follow-on mutation
- a git-backed `gov commit` crash after local commit creation but before lock-head persistence is recoverable as lock-head drift without silent success; success is never reported when the crash gap is observable
- `gov heartbeat` refreshes heartbeat and canonical lock head together without leaving head drift
- Repo X tickets use `coord-no-git-head` as the observable `lock.head` value instead of git `HEAD`
- heartbeat advances on mutation and periodic cadence
- the session-bound heartbeat host advances heartbeats without requiring foreground `gov` invocations, regardless of whether the host is the MCP server, a sidecar process, or mutation-triggered-only fallback
- under the Claude Code harness, the MCP-hosted heartbeat timer is alive for the lifetime of the Claude Code process and stops when the Claude tab is closed; the test asserts that stall-clock timing begins at tab closure rather than terminal shell closure
- a non-MCP session running in mutation-triggered-only mode emits an operator-visible notice identifying the weakened cadence so active-session semantics are not silently degraded
- sub-agent mutation serialization prevents two parallel sub-agents from committing governance mutations simultaneously
- collision recovery emits started, succeeded, and failed audit events with the required schema
- simulated failure at Section 6.4 step 2 and step 3 leaves no later-step artifact committed and a subsequent recovery run reaches a consistent terminal state
- two concurrent `gov claim` or `gov claim --transfer-to` invocations on the same ticket serialize through the repo-global governance runtime lock plus the nested ticket-scoped advisory tx lock; one acquires, the other waits up to the bounded deadline and then fails closed without mutating the contested state
- whole-repo consistency validators such as `validateBoardState` are not invoked between write steps of any multi-artifact mutation, while derived-artifact rendering is still allowed during `Write`; a synthetic mutation that attempts to validate mid-transaction is rejected in tests
- `Verify` failure restores the scoped rollback snapshot for artifacts written by the transaction before the command exits nonzero
- a transaction that fails at any `Write` phase step restores only the artifacts it planned to write; unrelated concurrent mutations on other tickets during the same window are preserved and not rolled back
- a transaction interrupted between `Write` step `N` and step `N+1`, then retried from `Acquire` with identical inputs, reaches the same terminal state as a clean first run for every artifact the transaction touches
- a failure between audit-event persistence and tx-lock release does not report success prematurely, and the next acquire path can reclaim or auto-release the dead holder's tx lock
- a composed governance command uses one transaction handle per ticket and does not re-enter `Acquire` for the same ticket mid-composition
- commands with external side effects either skip a previously completed side effect via a durable receipt or fail closed and require explicit caller re-invocation; no blind transaction-layer replay occurs after uncertain external effects
- `gov claim --transfer-to` and `gov takeover` called with bare `--force` during the deprecation window are accepted, emit an audit event carrying the synthesized reason `"<legacy --force migration>"`, and surface a deprecation notice; after the transition window the same invocations are rejected unless `--human-admin-override "<reason>"` is supplied
- `--force` combined with `--human-admin-override "<reason>"` is accepted at all times with `--human-admin-override` as the authoritative override and `--force` carrying its existing non-safety precondition-bypass meaning
- stale drift notes that no longer reproduce under ticket-scoped doctor or orchestrator health checks can be auto-resolved or aged out under the documented cleanup policy

Until those criteria are met, this document is a target-state design note plus implementation checklist.

### 11.5 Rollback

Revoking or relaxing an adopted section requires:
- a new version of this document
- a corresponding notice in the canonical `coord/GOVERNANCE.md` changelog
- an explanation of which enforcement-matrix rows are no longer satisfied
- row-level regressions update the matrix and changelog inline; section-level rollback or policy-version rollback requires a new document version

### 11.6 Version Detection

Agents or provider shims that cache policy text must:
- read the metadata version at session start
- compare it to any cached version they are relying on
- surface an advisory notice when the cached and live versions differ

## 12. Core Principle

Active ticket work is more important than preserving a preferred `agent_id`.

If there is doubt:
- prefer the current ticket's durable state
- do not mutate the foreign ticket by default
- obtain a currently unclaimed handle rather than reclaiming a preferred one
- fail closed instead of silently taking over
