---
description: Check database health, connection pool status, and table sizes for the backend.
argument-hint: [--env dev|staging|production]
---

# /db-status

Check the health and status of the backend database.

**Arguments:** `$ARGUMENTS`

## Checks

1. **Connection test**: Verify database is reachable
2. **Migration state**: Compare applied vs defined migrations
3. **Table sizes**: Report row counts and disk size for key tables
4. **Connection pool**: Report pool configuration (max connections, idle timeout)
5. **Active connections**: Check current connection count
6. **Slow queries**: Check for queries running longer than 5s

## Environment Resolution
- `dev` (default): Uses database URL from local shell environment
- `staging`/`production`: Requires explicit connection string — will prompt if not set

## Output Format
Report as a table with status indicators:
- Connection: OK / FAILED
- Migrations: N applied, M pending
- Tables: row counts
- Pool: configured max, current active
- Alerts: slow queries, high connection count

## Safety Rules
- **Read-only** — never modifies database state
- **No credentials in output** — masks connection strings
