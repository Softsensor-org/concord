# Provider Thread ID Sources

Metadata:
- Version: 0.1-draft
- Status: draft canonical provider-thread declaration
- Updated: 2026-04-12
- Owner: governance CLI maintainers
- Canonical consumers: `coord/GOVERNANCE.md#identity`, `coord/docs/IDENTITY_RUNTIME_EXTRACT.md`, `coord/docs/AGENT_ID_COLLISION_RECOVERY_POLICY.md`, provider startup shims

Changelog:
- `0.1-draft`: initial declaration of provider `thread_id` sources, runtime-detection signals, fallback order, and current stability guarantees from `coord/scripts/governance.js`

Purpose:
- declare the actual `thread_id` source for each supported provider
- document fallback behavior when the provider does not expose a stable native primitive
- make the current safety envelope explicit so same-thread resume rules do not assume stronger guarantees than the runtime provides

## 1. Global Rules

- `thread_id` matching is by exact string equality only.
- A missing, null, or fallback-only `thread_id` is not proof of same-thread ownership by itself.
- Provider-native environment variables outrank governance-generated fallback tokens.
- The generic `AGENT_THREAD_ID` fallback is accepted by all providers when explicitly supplied.
- When no provider-native primitive exists, governance falls back to a session token file under `coord/.runtime/session-threads/`.
- Governance-generated fallback tokens are sufficient for current-session continuity, but they are weaker than a provider-native stable conversation identifier.
- MCP callers may declare the calling conversation's thread id via `GOVERNANCE_MCP_THREAD_ID` in the spawn env. `coord/scripts/governance-mcp.js` promotes that value into `AGENT_THREAD_ID` on every CLI invocation so the same resolution rules apply; provider-native vars still outrank it when both are present.

Implementation reference:
- provider registry and resolution logic live in `coord/scripts/governance.js`
- relevant functions are `PROVIDER_REGISTRY`, `currentRuntimeThreadId()`, `detectRuntimeProvider()`, `resolveEffectiveThreadId()`, `getOrCreateSessionToken()`, and `sessionTokenPath()`
- the MCP thread-id promotion helper is `buildRunGovEnv()` in `coord/scripts/governance-mcp.js`

## 2. Provider Declarations

| Provider | Runtime family | Primary `thread_id` source | Runtime detection signal | Read-only fallback when primary is absent | Write-path fallback when primary is absent | Current stability guarantee | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | Codex | `CODEX_THREAD_ID` | `CODEX_THREAD_ID` present | Existing fresh scoped token under `coord/.runtime/session-threads/openai-*.json`; then single-session legacy token reuse; then single active provider-session reuse; otherwise `null` | Generate and persist a governance session token after checking for provider-session collisions | Stable when `CODEX_THREAD_ID` is present; otherwise stable only for the current runtime fingerprint or session-token scope until idle expiry | `AGENT_THREAD_ID` is accepted before file-token fallback |
| `anthropic` | Claude | `CLAUDE_SESSION_ID` | `CLAUDE_SESSION_ID` present, else `CLAUDECODE` present | Existing fresh scoped token under `coord/.runtime/session-threads/anthropic-*.json`; then single-session legacy token reuse; then single active provider-session reuse; otherwise `null` | Generate and persist a governance session token after checking for provider-session collisions | Stable when `CLAUDE_SESSION_ID` is present; otherwise stable only for the current runtime fingerprint or session-token scope until idle expiry | Current implementation can also key the fallback token from explicit `CLAUDE_SESSION_ID` when no broader runtime fingerprint exists |
| `google` | Gemini | `GEMINI_THREAD_ID` | `GEMINI_THREAD_ID` present, else `GEMINI_AGENT` present | Existing fresh scoped token under `coord/.runtime/session-threads/google-*.json`; then single-session legacy token reuse; then single active provider-session reuse; otherwise `null` | Generate and persist a governance session token after checking for provider-session collisions | Stable when `GEMINI_THREAD_ID` is present; otherwise stable only for the current runtime fingerprint or session-token scope until idle expiry | `AGENT_THREAD_ID` remains the generic explicit fallback |
| `xai` | Grok | `GROK_THREAD_ID` | `GROK_THREAD_ID` present, else `GROK_AGENT` present | Existing fresh scoped token under `coord/.runtime/session-threads/xai-*.json`; then single-session legacy token reuse; then single active provider-session reuse; otherwise `null` | Generate and persist a governance session token after checking for provider-session collisions | Stable when `GROK_THREAD_ID` is present; otherwise stable only for the current runtime fingerprint or session-token scope until idle expiry | `AGENT_THREAD_ID` remains the generic explicit fallback |

## 3. Fallback Algorithm

When a provider-native `thread_id` is absent, current governance runtime behavior is:

1. Check provider-native thread env vars in `PROVIDER_REGISTRY`.
2. Check the generic explicit override `AGENT_THREAD_ID`.
3. Detect the runtime provider from provider-native env vars or provider detect vars.
4. Reuse a fresh scoped token file under `coord/.runtime/session-threads/` when one already exists.
5. Reuse the legacy provider token only when there is at most one active session for that provider on this board.
6. Reuse a single active provider session only when exactly one active session for that provider is present.
7. On write paths, generate a new governance session token and persist it.

Scoped token naming currently prefers:

1. runtime fingerprint env vars
2. explicit session digest from `CLAUDE_SESSION_ID` or `AGENT_THREAD_ID` when available
3. provider-ancestor fingerprint from Linux `/proc`
4. cwd plus board-path digest as the last resort

The cwd-plus-board fallback is intentionally weak. Two terminals in the same project can share it. That is why explicit provider-native thread ids remain preferred.

## 4. Safety Notes

- Same-thread resume rules should prefer provider-native `thread_id` values over governance-generated fallback tokens.
- Unknown or fallback-only identities must be treated conservatively in collision recovery.
- Current fallback tokens are board-local coordination aids, not globally unique provider conversation proofs.
- If a provider introduces a stronger native conversation primitive, update this file and the provider registry together.

## 5. Maintenance Rule

Any change to:

- `PROVIDER_REGISTRY`
- provider detection env vars
- session-token fallback order
- stability guarantees claimed in policy or shims

must update this file in the same change.

## 6. O4 — GCV-1 env-propagation verification (2026-05-19)

This is a
**conservative, documentation-grounded closure with a stated fidelity
caveat**, not a full three-runtime bench test — the spec's constraint 6
(unverified ⇒ explicit-claim-only / fail-closed, never silent fallback)
makes that a legitimate closure.

### Fidelity caveat (scope of what was actually observed)

Only the locally available runtime was probed. `claude -p`/print could be
*invoked* (CLI present, v2.1.144) but a nested non-interactive spawn from
inside a running agent does **not** faithfully reproduce a real
`SessionStart`→`CLAUDE_ENV_FILE` lifecycle, so it is treated as
**unverified**. The Agent SDK and IDE-extension legs are
**documentation-derived only**, not observed.

### Observed (this Claude Code harness, interactive agent context)

| Signal | Observed | Implication |
|---|---|---|
| `CLAUDECODE` | `=1` (present) | provider *detection* is reliable |
| `CLAUDE_SESSION_ID` | **unset** | durable identity NOT auto-present |
| `CLAUDE_ENV_FILE` | **unset** | the GCV-1 durable channel is **not guaranteed even in an "interactive" session** in every harness/version |

This directly explains the friction this whole effort addressed: the
durable channel was simply absent, so every separate process lost binding.
It also proves the conservative rule empirically — **presence of
`CLAUDE_ENV_FILE` is runtime/mode/version-dependent and must be treated as
a capability to detect, never an assumption.**

### Per-mode ruling (GCV-1 authority)

| Mode | Channel status | GCV-1 ruling |
|---|---|---|
| Interactive TTY **with** `CLAUDE_ENV_FILE` set + `SessionStart` firing | durable channel available | v2 durable identity path active |
| Interactive **without** `CLAUDE_ENV_FILE` (observed here) | channel absent | **explicit-claim-only; fail closed** with actionable "hook/env not present" message — never inferred authority |
| `claude -p` / print | unverified (non-interactive, one-shot) | **explicit-claim-only; fail closed** until bench-verified |
| Agent SDK | unverified (doc-derived) | **explicit-claim-only; fail closed** until bench-verified |
| IDE extension | unverified (doc-derived) | **explicit-claim-only; fail closed** until bench-verified |

**Rule of record:** the v2 gate detects whether the durable channel is
actually present (`CLAUDE_ENV_FILE` writable + identity vars populated by
the hook). If not, the mode is explicit-claim-only and the gate **fails
closed with a clear message**; it never invents or infers authority
(constraint 6). True bench verification of `-p`/SDK/IDE is a recorded,
low-risk follow-up — it is **not** a coding blocker, because every
unverified mode is already fail-closed by rule.
