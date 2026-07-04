# Live-MCP Policy — Show Operation Class, Scope & Approval (product-engineering track)

Show the production-MCP **operation-class policy** and the scope/approval that applies to a
`PE-`/`LIVE-MCP-` ticket **before** any live read is run. This skill is **read-only** — it explains
policy, it does not touch production.

**Arguments:** `$ARGUMENTS` — a `PE-`/`LIVE-MCP-` ticket id (e.g. `LIVE-MCP-007`), optionally
`--class <operation-class>` to focus on one class.

## Phase 1: Show the operation-class policy

```bash
coord/scripts/gov live-mcp-policy $ARGUMENTS
```

This prints the operation classes from `runtime-evidence.js`, ordered from least to most
privileged:

| Class | Approval | Receipt | Redaction | Cleanup |
|---|---|---|---|---|
| `read_safe` | ticket | required | recommended | no |
| `read_sensitive` | human | required | **required** | no |
| `write_low` | human | required | recommended | no |
| `write_prod` | human | required | **required** | yes |
| `destructive` | human_admin | required | **required** | yes |

The product-engineering track is read-oriented: most work is `read_safe` / `read_sensitive`.
Anything mutating (`write_*` / `destructive`) needs explicit human approval and is usually a
hand-off to the **development** track, not done here.

## Phase 2: Explain this ticket's scope & approval

```bash
coord/scripts/gov explain $ARGUMENTS
```

Report, for this ticket:
- the **operation class** it is authorized for and the **approval** that satisfies it
- the **bounded scope** (adapter, dataset/operation, row/time limits) it may read
- the **redaction** obligation for that class
- whether any required approval is still **missing** (blocks the read)

## Rules

- Read-only. This skill never performs a production-MCP operation and never records a receipt.
- It is the pre-flight for `/analytics-query`: confirm class, scope, and approval here first.
- If the ticket asks for a `write_*`/`destructive` operation, flag it — that is out of scope for a
  read and should be routed to development via `/insight-analyst` → `gov open-followup`.
