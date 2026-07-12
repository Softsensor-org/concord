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
