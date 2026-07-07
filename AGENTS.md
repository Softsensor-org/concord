# AGENTS.md

This workspace uses one shared governance policy for all coding agents:
- Codex
- Claude
- Gemini

Canonical policy:
- `coord/GOVERNANCE.md`

Repo-local agent guides:
- `coord/AGENTS.md`
- repo-local `AGENTS.md` files under the product repo directories listed in `coord/product/REPOS.md`

Tool-specific shim files:
- `CLAUDE.md`
- `CODEX.md`
- `GEMINI.md`

Rule precedence (matches `coord/GOVERNANCE.md` Section 3):
1. Human-admin
2. `coord/GOVERNANCE.md`
3. Ticket prompts in `coord/prompts/`
4. Repo-local `AGENTS.md` files
5. Tool-specific shim files (`CLAUDE.md`, `CODEX.md`, `GEMINI.md`)
6. Orchestrator cycle decisions
7. Agent judgment

Cold-start contract:
- Treat chat memory as helpful but non-authoritative. Resume from governed
  artifacts, not from transcript recollection.
- Read this thin shim first, then resolve `coord/GOVERNANCE.md`, ticket prompt,
  repo-local `AGENTS.md`, and tool shim precedence before making changes.
- For nontrivial tickets, retrieve the minimum governed context before planning:
  `coord/scripts/gov explain <ticket>`, active plan/prework records, relevant
  recall or ADR references, requirements, and business-discovery packs.
- Externalize durable learning into governed artifacts before closeout:
  plan records, review cycles, feature proofs, repo gates, ADR proposals or
  links, memory-claim proposals, and resolved questions/decisions/reflections.
