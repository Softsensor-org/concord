# Runtime authority and subagent supervision

Concord fixes an execution authority envelope when a governed ticket starts.
The envelope identifies the ticket, session, provider, worktree, writable roots,
commands, network destinations, secret references, parent session, and observed
enforcement coverage. Its digest changes if any authority changes.

The default authority is deliberately small:

- writes are limited to the assigned ticket worktree;
- permanent deletion and destructive Git cleanup are denied;
- network and secret access are empty unless declared;
- a child session inherits the parent ticket and may request only a subset of
  the parent's paths, commands, network destinations, and secret references;
- active or unexplained child sessions block governed review and closeout.

Claude installations supplied by the template wire the runtime authority guard
into pre-tool and subagent lifecycle hooks. The guard denies recognized shell,
patch, and filesystem actions before execution and records child lifecycle state
under `coord/.runtime/subagents/`.

Provider coverage is reported as `complete`, `partial`, or `unmanaged`. Concord
does not infer complete coverage from the mere presence of a configuration file.
Codex workspace sandboxing currently counts as partial coverage unless a verified
pre-tool and subagent lifecycle mediation surface is available. High-risk auto
mode must not run with partial or unmanaged coverage.

This is a governance and supported-provider enforcement control. It reduces the
risk of silent authority expansion but is not an endpoint-security product, an
operating-system isolation guarantee, or a warranty. Full-access/bypass modes,
provider surfaces that do not expose interception, compromised host processes,
and separately authorized infrastructure remain outside Concord's enforcement
boundary and must be reported as such.

For recognized shell writes under an active lock, literal `cd` and `pushd`
commands in a simple `&&` chain change the directory used to classify subsequent
relative targets. Redirections on the directory-changing command itself still
use the preceding directory. Canonical paths and foreign worktrees retain the
same write restrictions after a directory change.

This is a bounded shell analysis. Directory changes combined with other control
flow, negation, unknown operands, `CDPATH`-dependent names, home expansion,
directory-stack operations, or unsupported options cause relative writes to be
refused with `shell_unresolved_cwd`. Use explicit absolute write targets or a
simple literal `cd /absolute/path && command` chain for an unambiguous operation.
Quoted command descriptions and heredoc data do not count as directory changes.
For compound syntax, a standalone directory-command token is treated
conservatively, including a quoted builtin name that the shell could execute. These
checks cover the guard's recognized write forms; they do not make arbitrary
shell programs or interpreter scripts an operating-system sandbox.

### Subagent parent identity

Subagent start and stop hooks resolve the caller through the existing v2 owner
lease. The durable provider and instance channel must identify exactly one fresh
active instance for the ticket lock owner, and that instance must hold the lease.
The hook reads identity without registering, refreshing, or transferring it.
Envelope and ledger `parent_session` values identify that live instance. Legacy
lock `session_id` and `thread_id` fields remain readable but grant no authority;
a legacy-shaped lock works when its owner has a valid current lease.

Missing, stale, revoked, conflicting, or mismatched identity produces a named
`subagent_identity_*` refusal before supervisor or action-ledger writes. Restore
the provider SessionStart identity channel and explicitly claim the ticket using
the owner named in the refusal. Resolve a competing live instance through the
governed handoff workflow. Editing a legacy lock session does not repair a lease.

## Hook failure modes (COORD-949)

The two PreToolUse entries fail closed. Exit 2 blocks in the Claude Code hook protocol.
Any other nonzero exit, including the exit 1 that an uncaught exception produces, is a
NON-blocking error, so the tool call would proceed. Every row below is covered by
`coord/engine/scripts/hooks/hook-failure-modes.test.js`.

| Failure | Barrier `runtime-authority-hook.js` | Guard `pre-bash-guard.js` |
| --- | --- | --- |
| Engine module fails to load (missing or syntax-broken) | exit 2 while a lock is active; exit 0 with none | exit 2 |
| `decide()` or `main()` throws or rejects | exit 2 while a lock is active; exit 0 with none | exit 2 |
| Payload empty, or not a JSON object (truncated, array, scalar, non-UTF-8) | exit 2 while a lock is active (`payload_unavailable`); exit 0 with none | exit 2 |
| Payload over 8 MiB (`too-large`) | exit 2 while a lock is active (`payload_unavailable`); exit 0 with none | exit 2 |

Every block names `OUT-OF-BAND RECOVERY`: a terminal outside the agent harness, because the
blocked shell is the one an in-session repair would need.

Timeouts. No PreToolUse hook in `.claude/settings.json` or in
`coord/engine/provider-hook-templates/claude.json` declares a `timeout`. The table lists the
reason for each. When the harness kills a hook at a timeout, the hook is killed and that outcome is non-blocking,
the same as an exit 1, so a timeout would turn a stalled guard into an allow. The hook bounds
its own wait instead: the payload read is capped at 5 seconds (`DEFAULT_STDIN_TIMEOUT_MS`) and
8 MiB (`MAX_STDIN_BYTES`). A harness kill that a hook does not cause is outside this repository's
control and is not verified here.

| Hook command | Timeout | Reason for none |
| --- | --- | --- |
| `node coord/scripts/hooks/pre-bash-guard.js` | no timeout | Its wait is bounded by hook-stdin (5 s); a harness kill is non-blocking, so a timeout would fail open. |
| `node coord/scripts/runtime-authority-hook.js` | no timeout | Same as above; with a lock active the barrier refuses on its own bounded read. |
