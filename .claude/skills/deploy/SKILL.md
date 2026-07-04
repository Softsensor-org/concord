---
description: Build, validate, and deploy services. Runs gates before deploy, checks environment config, and pushes to target.
argument-hint: [backend|frontend|all] [--env staging|production] [--skip-gate] [--dry-run]
---

# /deploy

Deploy services to the target environment.

**Arguments:** `$ARGUMENTS`

## Workflow

1. **Parse arguments** — determine target (backend, frontend, or all) and environment (default: staging).

2. **Pre-flight checks:**
   - Verify clean git state: `git -C <repo> status --short` must be empty
   - Verify on correct branch: `dev` for staging, `main` for production
   - Check environment variables are set for target env

3. **Run quality gate** (unless `--skip-gate`):
   - Run the repo's full gate
   - Abort if gate fails

4. **Build:**
   - Run the repo's build command

5. **Deploy:**
   - If `--dry-run`: report what would be deployed, stop
   - For staging: push to staging branch / trigger staging pipeline
   - For production: require explicit confirmation before pushing

6. **Post-deploy:**
   - Run health check against deployed environment
   - Report deploy status with commit SHA, timestamp, and environment

## Safety Rules

- **Never deploy to production without running the full gate**
- **Never deploy from a dirty working tree**
- **Always confirm before production deploys**
- **Report the deployed commit SHA for rollback reference**
