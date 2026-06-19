# CLAUDE.md

Claude must follow the shared governance policy used by this project.

Canonical sources:
- `coord/GOVERNANCE.md`
- `AGENTS.md`

Repo-local agent guides:
- `coord/AGENTS.md`
- repo-local `AGENTS.md` files under the product repo directories listed in `coord/product/REPOS.md`

If any other markdown conflicts with `coord/GOVERNANCE.md`, governance wins.

## Skills

Agent skills are defined in `.claude/commands/`. Use them via slash commands:
- `/initiate` — start a governed session
- `/orchestrator status` — board overview
- `/planner <ticket>` — plan before implementing
- `/code-writer <ticket>` — full governed implementation
- `/manual-tester [scope]` — find bugs
- `/qa-review [scope]` — full QA audit
- `/business-analyst [scope]` — requirement analysis
- `/designer [scope]` — UX/accessibility audit

See `README.md` for the full skill reference.

## Session Discipline

- Start a fresh session for each ticket. Do not chain `/code-writer` calls in the same conversation — stale context from a prior ticket degrades quality and wastes tokens.
- If a session runs long (>30 min of active work), summarize progress and start fresh rather than accumulating context.
- Two Claude topologies are supported (full matrix in `coord/docs/MULTI_AGENT_TOPOLOGIES.md`):
  - **One conversation per board** (default): just work; identity is automatic.
  - **One orchestrator conversation spawning N Claude sub-agents**: each sub-agent MUST export a distinct `COORD_SESSION_ID` before any `gov` call, and claim a distinct registered handle. This is required because the Claude Code harness injects ONE identical `CLAUDE_CODE_SESSION_ID` into every sub-agent of a conversation — without the override they collapse to one session and churn each other's claims. **`CLAUDE_SESSION_ID` does NOT work for this** (the harness sets it equal to `CLAUDE_CODE_SESSION_ID`, which is checked first); use `COORD_SESSION_ID`, which overrides both.
- If governance reports ambiguous Anthropic session identity, stop and either return to the original conversation or relaunch with an explicit `COORD_SESSION_ID`.
- When resuming your own ticket from a prior session, use `/resume <ticket>` or `coord/scripts/gov resume <ticket>` to get a clean state summary. `takeover` remains the human-admin foreign-owner path.
