---
description: Seed or reset development data for backend and frontend apps.
argument-hint: [backend|frontend|all] [--reset] [--tenant <id>] [--actor <key>]
---

# /seed-data

Seed development data for local testing.

**Arguments:** `$ARGUMENTS`

## Workflow

### Backend Seeding
1. Check if backend dev server is running
2. Issue a dev session for the target actor
3. Use the session to call bootstrap and admin APIs
4. Seed reference data: tenants, users, sample entities
5. Report seeded entity counts

### Frontend Seeding
1. Frontend apps typically use seeded bootstrap data
2. If `--reset`: clear any local state (offline queue, cached data)
3. Restart dev server with fresh bootstrap

### Combined (`all`)
1. Seed backend first
2. Then restart frontend dev servers to pick up new data

## Safety Rules
- **Only runs against local dev environment** — refuses if API URL is not localhost
- **`--reset` wipes local state** — confirm before proceeding
- Seeding is idempotent — safe to run multiple times
