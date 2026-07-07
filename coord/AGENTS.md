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
- Run `node coord/board/board.js sync` after successful governed board changes.
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
- Keep ticket-local notes in `coord/active/<ticket>.md`; do not duplicate canonical status, owner, PR, or dependency data there.
- Periodically distill feedback-type memory notes into this file. If a governance pattern, CLI workaround, or workflow tip has been learned across 2+ sessions, promote it from agent memory to a directive here so all agents benefit.
