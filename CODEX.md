# CODEX.md

Codex must follow the shared governance policy used by this template.

Canonical sources:
- `coord/GOVERNANCE.md`
- `AGENTS.md`

Repo-local agent guides:
- `coord/AGENTS.md`
- repo-local `AGENTS.md` files under the product repo directories listed in `coord/product/REPOS.md`

If any other markdown conflicts with `coord/GOVERNANCE.md`, governance wins.
For the full rule-precedence order see `AGENTS.md` and `coord/AGENT_PATHS.md`.

## Multi-agent sessions

Codex isolates concurrent sessions natively via a distinct `CODEX_THREAD_ID` per
session, so independent Codex agents on one board need no extra setup. If you run
sub-agents that share one thread id, give each a distinct `COORD_SESSION_ID` (the
authoritative session override) and a distinct claimed handle. Full matrix:
`coord/docs/MULTI_AGENT_TOPOLOGIES.md`.
