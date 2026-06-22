# Next — What Should I Work On?

Start here every session. This wrapper should stay aligned with the thin operator facade rather than re-implementing board logic itself.

## Step 1: Bind or inspect the current identity

```bash
coord/scripts/gov whoami --assign
```

If this thread is blocked by a foreign same-handle session and must not disturb that foreign ticket state:
```bash
coord/scripts/gov agent-rebind --fresh
```

## Step 2: Inspect current health

```bash
coord/scripts/agent status
coord/scripts/agent check
```

If `agent check` reports ticket-scoped repair work, stop and suggest `/recover <ticket>` instead of picking new work.

## Step 3: Ask the shared facade for the next ready ticket

```bash
coord/scripts/agent next
```

Report:
- claimed identity and any warnings from `whoami`
- active `doing` or `review` work, if any
- the next recommended ticket from `coord/scripts/agent next`
- the suggested command: `/do <ticket-id>`

Rules:
- do not start or claim a new ticket from `/next`
- do not bypass the shared facade with a hand-rolled `pick` flow unless `coord/scripts/agent next` is unavailable
