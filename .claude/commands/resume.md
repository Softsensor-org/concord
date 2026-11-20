# Resume — Re-enter An In-Flight Ticket

Use this when a ticket is already `doing` or `review` and this Claude session needs the governed context.

## Step 1: Inspect the current identity

```bash
coord/scripts/gov agentid
```

If this session has no bound identity yet, run the provider-neutral cold-start
contract first: `coord/scripts/agent bootstrap`.

If the current thread is blocked by a foreign same-handle session and must stay detached from that foreign ticket:

```bash
coord/scripts/gov agent-rebind --fresh
```

## Step 2: Resume through the thin facade

```bash
coord/scripts/agent resume $ARGUMENTS
```

This should bind the current session to the governed ticket context and return the canonical `explain` payload.

## Step 3: Report the resumed context

Report:
- claimed identity
- ticket status and owner
- governed worktree / branch (if any)
- remaining governance blockers from `explain`

Rules:
- use `coord/scripts/gov resume $ARGUMENTS` only when you need the raw governance command directly
- use `coord/scripts/gov claim <ticket> --transfer-to <current-agent-handle> --human-admin-override "<reason>"` or `coord/scripts/gov lock-abandon <ticket> --human-admin-override "<reason>"` only with explicit human-admin authorization
- do not use resume to seize a foreign ticket silently
