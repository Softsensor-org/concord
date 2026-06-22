---
description: Run, create, or check database migrations for the backend.
argument-hint: [run|create <name>|status|rollback-plan] [--env dev|staging|production]
---

# /migrate

Manage database migrations for the backend.

**Arguments:** `$ARGUMENTS`

## Actions

### `run` (default)
Run pending migrations against the target database.

1. Check current migration state — list all defined migrations
2. If database is reachable, query migrations table for applied state
3. Show pending migrations and ask for confirmation
4. Execute migrations (advisory lock protected, transaction-wrapped)
5. Report results: applied count, duration, any errors

### `create <name>`
Scaffold a new migration.

1. Read existing migrations to determine next sequence number
2. Add the migration SQL with the next number (e.g., `007_<name>`)
3. Report the new migration entry

### `status`
Show migration state without running anything.

1. List all defined migrations
2. If database is reachable, show applied vs pending
3. If database is unreachable, show defined migrations only

### `rollback-plan`
Generate a rollback plan for the last N migrations.

1. Read the migration SQL
2. Generate inverse DDL statements where possible
3. **Never execute rollback automatically** — output the plan for manual review

## Safety Rules

- **Never run migrations against production without explicit confirmation**
- **Always use advisory locks** to prevent concurrent migration runs
- **Each migration runs in its own transaction**
- **Rollback plans are advisory only — never auto-execute**
