# Coordination Agent Directives

- Use `coord/scripts/gov ...` for lifecycle and governance mutations.
- Never directly edit:
  - `coord/board/tasks.json`
  - `coord/board/plans/*.json`
  - `coord/PLAN.md`
  - `coord/TASKS.md`
  - `coord/PROMPT_INDEX.md`
  - `coord/rendered/TASKS.md`
  - `coord/rendered/PROMPT_INDEX.md`
  - `coord/.runtime/*`
  - `coord/locks/*.lock`
  - `coord/agents.json`
  - `coord/agent_sessions.json`
- If governance fails, prefer:
  - `coord/scripts/gov explain <ticket-id>`
  - `coord/scripts/gov recover <ticket-id>`
  - `coord/scripts/gov doctor`
- If a repo-backed ticket was merged to `dev` before `move-review`, repair it with `coord/scripts/gov finalize <ticket-id> --no-pr --already-landed --landed "<evidence>"`; do not use `supersede` and do not edit board files by hand.
- For governed repo-backed tickets, land work on `dev` only. Do not fast-forward or merge `main` during ordinary ticket closeout.
- Treat `main` as a promoted branch. Advance it only through an explicit human-requested promotion step after `dev` has already absorbed the ticket work.
- Treat `coord/board/tasks.json` as the canonical board and `coord/GOVERNANCE.md` as the canonical execution policy.
- Run `coord/scripts/gov sync` after successful governed board changes.
- Read `coord/AGENT_STARTUP_CHECKLIST.md` before starting a ticket.
- Cold-start sequence for any nontrivial ticket:
  1. Read the thin entry shim (`AGENTS.md`, then `CODEX.md`, `CLAUDE.md`, or
     `GEMINI.md` as applicable).
  2. Resolve canonical precedence from `coord/GOVERNANCE.md`.
  3. Bind identity with `coord/scripts/gov agentid --assign`, then claim,
     start, or resume the ticket through governance.
  4. Retrieve minimum context before planning: `coord/scripts/gov explain
     <ticket>`, plan/prework records, relevant recall, ADR references,
     requirements, and business-discovery packs.
  5. Plan, execute, verify, and move through review gates.
  6. Externalize durable learning into governed artifacts before closeout:
     plan records, review cycles, feature proofs, repo gates, ADR proposals or
     links, memory-claim proposals, questions, decisions, and reflections.
- Treat chat memory as non-authoritative. It may help locate likely context, but
  governed artifacts are the resume source for tomorrow's cold-start agent.
- Treat completed-ticket plans, dated plans, and archived proposals as historical
  evidence. They do not supersede the current board, accepted ADRs, or policy.
- Journal and plan records are tracked durable evidence. Recovery snapshots,
  locks, and session records are ignored local runtime state; see `DIRECTORY.md`.
- Keep ticket-local notes in `coord/active/<ticket>.md`; do not duplicate canonical status, owner, PR, or dependency data there.
- Periodically distill feedback-type memory notes into this file. If a governance pattern, CLI workaround, or workflow tip has been learned across 2+ sessions, promote it from agent memory to a directive here so all agents benefit.

## Engine boundary

Engine pin and manifest regeneration (`template-sync-discovery.js --write`,
`gov verify-engine --pin`) must run from the ticket worktree with that worktree's
own scripts, never the canonical checkout's. Details: `coord/engine/docs/MULTI_AGENT_BURNIN_RUNBOOK.md` section 6.

New engine-canonical files belong under `coord/engine/` and are synced as a
unit. Use `resolveEngineModule()` for migration-time module lookup; do not add
new hard-coded legacy paths. Project configuration and state stay outside the
engine tree and enter through the validated config seam.

## Plan and question debt at handoff

- Before handoff, audit active plan records and the active QUESTIONS queue. A passed test does not complete a plan or resolve a question by itself.
- Record specific remaining work and an incomplete closeout verdict until acceptance, review and landing are complete. Replace scaffold placeholders through governed plan helpers; never fabricate passing reviews to clear debt.
- When a question is answered or routed to an existing ticket, preserve its evidence and close the original queue entry. An appended resolved answer does not retire an earlier unresolved row in the current engine (COORD-695).
- Log informational evidence with resolved=yes when no decision is being requested. For unanswered questions, state the decision needed, responsible role, linked ticket and next review trigger. Do not repeatedly reopen the same issue or file duplicate tickets.
- Inspect original question rows with `gov resolve-question --dry-run`. Select the exact `row_digest` and run `gov resolve-question --expected-row-digest <sha256> --evidence "<actual disposition and evidence>"` as a bound agent. The command changes only that row's resolved cell and retains the original question, answer, authorship and date, with resolution actor, timestamp and evidence in history and the journal. Identical replay is read-only; stale, ambiguous or conflicting selections refuse. Do not infer an answer merely because a linked ticket is done, or discard unresolved decisions. Use `gov retire-stale-drift-notes` only for its supported historical-drift scope.
- Sanctioned question appends and resolutions are journaled and included by normal `gov sync --commit`. Do not hand-edit QUESTIONS or reconcile merely to commit it. Inspect genuine provenance drift before accepting any repair.
- Finish maintenance by committing reviewed non-derived records, running gov sync --commit, and verifying gov orch plus a clean checkout. Existing real implementation blockers remain on their tickets.
- Evidence and dispositions from the initial cleanup: [2026-09-07 debt review](docs/reviews/2026-09-07-plan-question-debt.md).
