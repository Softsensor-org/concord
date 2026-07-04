# Identity Runtime Extract

Metadata:
- Version: 0.3-draft
- Status: startup-sized quick-reference extract
- Updated: 2026-05-05
- Owner: governance CLI maintainers
- Canonical parent policy: `coord/GOVERNANCE.md`
- Derived primarily from `coord/docs/AGENT_ID_COLLISION_RECOVERY_POLICY.md` Sections 5, 7, and 12
- Companion docs:
  - `coord/docs/AGENT_ID_COLLISION_RECOVERY_POLICY.md`
  - `coord/docs/provider-thread-id-sources.md`

Use this file for startup-time identity, resume, collision, and recovery rules.
Provider shims should link or embed this extract instead of inlining the full collision policy.

## Current Quick Rules

- use `coord/GOVERNANCE.md` as the canonical policy surface
- use `coord/docs/provider-thread-id-sources.md` as the canonical declaration of provider-native `thread_id` sources and fallback guarantees
- `.runtime/agent_sessions.json` is runtime state, not canonical ticket ownership by itself
- when runtime session state conflicts with a valid governed ticket lock, the ticket lock and board state win
- exact `thread_id` equality is stronger than fallback-only session heuristics
- fallback-only identities are coordination aids, not proof of same-thread ownership
- for Claude, the supported interactive rule is one live conversation per board unless the operator injects a distinct `COORD_SESSION_ID` (multi-agent topologies: `coord/docs/MULTI_AGENT_TOPOLOGIES.md`)
- runtime fingerprint (`runtimeSessionFingerprint`) anchors in this priority order:
  0. **`COORD_SESSION_ID` (COORD-015)** — explicit operator/orchestrator override. If set it is **authoritative and short-circuits every anchor below, including the provider thread id**. Required for the Claude orchestrator+sub-agents topology: the harness injects one identical `CLAUDE_CODE_SESSION_ID` into every sub-agent, so without the override they collapse to one fingerprint and churn claims. `CLAUDE_SESSION_ID` does NOT achieve this (the harness sets it equal to `CLAUDE_CODE_SESSION_ID`, checked first). Unset → resolution is unchanged.
  1. provider thread id — `CLAUDE_CODE_SESSION_ID` (alias `CLAUDE_SESSION_ID`), `CODEX_THREAD_ID`, `GEMINI_THREAD_ID`, `GROK_THREAD_ID`; stable per conversation, injected by the harness.
  2. terminal/multiplexer env vars (`TERM_SESSION_ID`, `TMUX_PANE`, `WEZTERM_PANE`, `WT_SESSION`, `KITTY_WINDOW_ID`, `TAB_ID`) — explicit, deterministic
  3. self-sid (`/proc/self/stat` field 6) — works for plain shells (bash, codex CLI) where every subprocess inherits the same controlling-terminal session id. **Does not anchor on Claude Code** because the Bash tool spawns each shell as a new session leader; that is why the claude-ancestor branch above takes precedence.
  4. fail closed — non-procfs platforms (macOS, BSD, locked-down /proc) get null fingerprint and `getOrCreateSessionToken` refuses to mint when an active session already exists.
- for coord-owned tickets, the lock `head` sentinel is `coord-no-git-head`
- for MCP-backed sessions, `coord/scripts/governance-mcp.js` is the preferred heartbeat host
- the MCP host emits a session-bound heartbeat for the current `doing` ticket at the 5-minute target cadence while the governed worktree still exists
- when the MCP host exits, heartbeat stops and the stale-lock clock runs from the last recorded heartbeat
- non-MCP sessions remain mutation-triggered-only unless a separate sidecar heartbeat host is added

## Current Command Guidance

- `coord/scripts/gov claim --owner <handle>` binds the current session explicitly
- if multiple Claude conversations — or multiple concurrent sub-agents under one orchestrating conversation — must touch the same board, export a distinct `COORD_SESSION_ID` before running `coord/scripts/gov` (overrides the harness provider thread id; `CLAUDE_SESSION_ID` is insufficient on Claude Code, see anchor priority 0). Each concurrent agent must also claim a distinct registered handle.
- `coord/scripts/gov agentid` (alias: `coord/scripts/gov whoami`) shows the current claimed session, active owned tickets, and mismatch warnings when governance already sees drift
- `coord/scripts/gov agent-rebind --fresh` is the safe fresh-handle path when the current thread is blocked by a foreign same-handle session and must not touch that foreign ticket state; governance now reserves the new handle with bounded retries and fails closed if every candidate is claimed first
- `coord/scripts/gov takeover <ticket-id> --human-admin-override "<reason>"` is the explicit foreign-ticket takeover path when human-admin has authorized rebinding a doing/review ticket to the current claimed session
- `coord/scripts/gov lock-abandon <ticket-id> --human-admin-override "<reason>"` is the explicit stale-lock cleanup path when human-admin has authorized returning a foreign doing ticket to `todo`
- `coord/scripts/gov resume <ticket-id>` is the preferred same-owner re-entry path
- `coord/scripts/gov explain <ticket-id>` is the supported diagnostic surface for ticket-scoped identity and governance drift
- `coord/scripts/gov recover <ticket-id>` is the supported repair path when governed state must be rebuilt from canonical evidence
- `coord/scripts/gov doctor` is the supported general governance-health check
- under the MCP-backed Claude/Codex/Gemini path, heartbeat should happen automatically once a governed `doing` ticket exists; do not rely on foreground `gov` mutations to keep the lock fresh

## Safety Rules

- do not treat a foreign `doing` ticket as yours unless governance ownership was resumed or explicitly reclaimed
- do not release a foreign same-handle session just to free a handle; use `coord/scripts/gov agent-rebind --fresh` for the current thread instead
- do not overwrite a ticket lock that another writer created first; canonical lock creation is create-if-absent and the loser must re-read the existing lock
- do not use `takeover` or `lock-abandon` without an explicit human-admin reason recorded via `--human-admin-override`
- do not invent ownership from a matching worktree path alone
- do not treat unknown or fallback-only `thread_id` values as strong same-thread proof
- do not use provider-specific wrappers as shadow authorities over the governed CLI or MCP layer
- do not revive MCP attestation or continuity-inference shortcuts to distinguish ambiguous Claude subprocess identity; explicit operator choice is the current policy
- when collisions are suspected, prefer governed recovery and explanation commands over manual board or lock edits

## Escalate To The Full Companion When

Read `coord/docs/AGENT_ID_COLLISION_RECOVERY_POLICY.md` when:
- identity or session binding appears inconsistent across surfaces
- a ticket lock is missing, malformed, duplicated, or foreign-owned
- you need recovery-order, transaction, audit-event, or enforcement-matrix details
- you are changing governance runtime behavior rather than only following it
