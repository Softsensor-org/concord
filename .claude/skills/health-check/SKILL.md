---
description: Check the health of all services — API, workers, frontend apps, and database.
argument-hint: [--env dev|staging|production] [--verbose]
---

# /health-check

Run a comprehensive health check across all services.

**Arguments:** `$ARGUMENTS`

## Checks

### 1. Backend Services
- **API server**: Hit the /health endpoint
- **Workers**: Check processes are running

### 2. Frontend Apps
- **Web apps**: Check dev servers responding
- **Mobile app**: Check Expo dev server responding (if applicable)

### 3. Database
- Connection test
- Migration state (pending count)

### 4. External Dependencies
- GitHub API reachable (for governance CLI)
- Package registry reachable (for installs)

## Output
Table with service name, status (UP/DOWN/DEGRADED), response time, and notes.

## For Non-Dev Environments
- Replace localhost URLs with environment-specific endpoints
- Check deployed health endpoints
- Report SSL certificate expiry if applicable

## Safety Rules
- **Read-only** — only performs GET requests and process checks
- **No credentials exposed** in output
