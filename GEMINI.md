# GEMINI.md

Gemini must follow the shared governance policy used by this template.

Canonical sources:
- `coord/GOVERNANCE.md`
- `AGENTS.md`

Repo-local agent guides:
- `coord/AGENTS.md`
- repo-local `AGENTS.md` files under the product repo directories listed in `coord/product/REPOS.md`

If any other markdown conflicts with `coord/GOVERNANCE.md`, governance wins.
For the full rule-precedence order see `AGENTS.md` and `coord/AGENT_PATHS.md`.

Cold start:
- Keep this shim thin. Use it to find the canonical governance sources, not as a
  replacement for them.
- Chat memory is non-authoritative. Resume from `coord/scripts/gov explain
  <ticket>`, plan/prework records, relevant ADR/requirements references, and the
  governed artifacts named in `coord/GOVERNANCE.md` Section 3.2.

## Multi-agent sessions

Gemini isolates concurrent sessions natively via a distinct `GEMINI_THREAD_ID` per
session, so independent Gemini agents on one board need no extra setup. If you run
sub-agents that share one thread id, give each a distinct `COORD_SESSION_ID` (the
authoritative session override) and a distinct claimed handle. Full matrix:
`coord/docs/MULTI_AGENT_TOPOLOGIES.md`.
