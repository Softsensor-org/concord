# AI-Assisted Development with Claude Code

**Author:** Vivek Gupta
**Date:** 2026-04-09 (reviewed 2026-05-16 — current as of template v0.5.0; the `scripts/agent` facade, `gov plan --seed`, `gov rebuild-board`, and `gov agent-rebind --fresh` are the up-to-date workflow primitives)

A practical guide to using Claude Code as the primary development engine for multi-repo, multi-team software projects.

---

## The Approach

Instead of writing code in an IDE and using AI for autocomplete or chat assistance, I use Claude Code as the implementation engine and operate as the architect, reviewer, and decision-maker.

**The split:**
- **I do:** requirements, architecture decisions, priority calls, final review, course-correction
- **Claude does:** planning, implementation, testing, self-review, mechanical refactoring, codebase audits

This isn't "AI-assisted coding." It's AI-driven development with human governance.

---

## Workspace Setup

### Multi-Repo Structure

A typical workspace has multiple repos under one parent directory, plus a coordination layer:

```
~/projects/my-platform/
├── backend/              # API, workers, persistence
├── frontend/             # Web apps, mobile apps
├── coord/                # Governance, board, design docs
├── plugins/              # Shared Claude skills
├── .claude/              # Skills, memory, settings
├── .mcp.json             # External tool integrations
└── CLAUDE.md             # Project-level Claude instructions
```

The repos don't need to be a monorepo — they can be independent git repos. The coordination layer (`coord/`) ties them together.

### CLAUDE.md — The Entry Point

Every project needs a `CLAUDE.md` at the root. This is the first thing Claude reads on session start. Keep it short and authoritative:

```markdown
# CLAUDE.md

Project uses a governed development workflow.

Canonical sources:
- `coord/GOVERNANCE.md` — rules
- `coord/board/tasks.json` — ticket board

Repo-local guides:
- `backend/AGENTS.md`
- `frontend/AGENTS.md`

If any file conflicts with GOVERNANCE.md, governance wins.
```

---

## Slash Commands (Skills)

Skills are the primary interface. Instead of writing long prompts, you invoke named workflows:

### Governance Skills

Define these as markdown files in `plugins/governance/commands/` or `.claude/skills/`:

| Command | Purpose |
|---------|---------|
| `/orchestrator status` | Board overview — ticket counts, active work, blockers |
| `/orchestrator next` | Recommend next highest-priority unblocked ticket |
| `/planner <ticket>` | Create implementation plan with dependency audit |
| `/code-writer <ticket>` | Full implementation with self-review cycles |
| `/code-reviewer <ticket>` | Multi-pass code review with findings |
| `/gate` | Run quality gates |
| `/recover <ticket>` | Repair governance state |

### Operations Skills

| Command | Purpose |
|---------|---------|
| `/deploy <service> --env staging` | Build, gate, deploy |
| `/migrate run` | Run database migrations |
| `/seed-data` | Seed development data |
| `/db-status` | Database health check |
| `/health-check` | Check all services |

### Specialist Skills

| Command | Purpose |
|---------|---------|
| `/qa-review` | Multi-perspective QA audit |
| `/designer` | UX consistency and accessibility audit |
| `/business-analyst` | Requirement analysis and scope validation |
| `/manual-tester` | User-facing defect discovery |

### How to Create a Skill

Create a markdown file with YAML frontmatter:

```
.claude/skills/deploy/SKILL.md
```

```markdown
---
description: Build, validate, and deploy services.
argument-hint: [backend|frontend|all] [--env staging|production]
---

# /deploy

Deploy services to the target environment.

**Arguments:** `$ARGUMENTS`

## Workflow
1. Verify clean git state
2. Run quality gate
3. Build
4. Deploy (with confirmation for production)
5. Run post-deploy health check
```

Claude picks these up automatically on session start.

---

## The Governance Model

### Why Governance Matters

Without governance, AI agents will:
- Edit files they shouldn't
- Skip tests to save time
- Merge without review
- Lose track of what's been done
- Conflict with other agents working on the same codebase

Governance replaces trust with verification.

### Ticket Board

One canonical board (JSON or any structured format) that all agents share:

```json
{
  "sections": [
    {
      "kind": "table",
      "heading": "Sprint Tickets",
      "rows": [
        {
          "ID": "BE-042",
          "Repo": "backend",
          "Type": "bug",
          "Pri": "P0",
          "Status": "todo",
          "Owner": "",
          "Description": "Fix race condition in order processing",
          "Depends On": ""
        }
      ]
    }
  ]
}
```

Status transitions are deterministic:

```
todo → doing → review → done
```

### Governance CLI

A simple CLI (bash scripts, Node.js, or Python) that enforces rules:

```bash
# Ticket lifecycle
gov start BE-042              # Acquire lock, move to doing
gov commit BE-042 -m "..."    # Governed commit with ticket ID
gov submit BE-042             # Move to review (requires self-review)
gov land BE-042 --pr "..."    # Merge PR, mark done

# Diagnostics
gov explain BE-042            # Show ticket state and readiness
gov doctor                    # Validate governance health
```

The key rule: **agents never hand-edit board state.** All mutations go through the CLI.

### Lock-Based Concurrency

When an agent starts work on a ticket, it acquires a lock:

```json
{
  "ticket": "BE-042",
  "owner": "claude-session-a11",
  "acquired_at": "2026-04-09T10:00:00Z",
  "last_heartbeat": "2026-04-09T10:30:00Z"
}
```

- Only one agent can hold a lock at a time
- Agents sync heartbeat after every commit
- Stale locks (heartbeat > 24h) are flagged by the orchestrator
- The CLI refuses to start a ticket if another agent holds the lock

### Worktree Isolation

Agents never work on the repo's main checkout. Each ticket gets its own git worktree:

```
backend/.worktrees/claude-a11/BE-042/
```

This prevents agents from stepping on each other's uncommitted changes and keeps the repo root clean for builds and gates.

---

## Multi-Agent Coordination

### Using Multiple AI Providers

Different AI providers have different strengths:

| Provider | Good For |
|----------|----------|
| **Claude** | Architecture, complex logic, nuanced review, governance design |
| **Codex** | Bulk implementation, test generation, mechanical refactors |
| **Gemini** | Feature implementation, integration work, large-context analysis |

All providers share the same board, same governance rules, same CLI. No provider gets special privileges.

### Agent Identity

Each agent session registers with a unique ID:

```json
{
  "handle": "claude-a11",
  "provider": "anthropic",
  "status": "active",
  "created_at": "2026-04-09T10:00:00Z"
}
```

This enables:
- Tracking who did what
- Preventing session collisions
- Auditing agent decisions
- Recycling agent slots when sessions end

### Parallel Execution

Multiple agents can work simultaneously because:

1. **Lock files** prevent double-claiming tickets
2. **Worktrees** isolate file changes
3. **The board** is the single source of truth (not local git state)
4. **The event log** is append-only and immutable

A typical parallel session:
```
Agent claude-a11: implementing BE-042 (backend bug fix)
Agent codex-a00:  implementing FE-089 (frontend feature)
Agent gemini-a21: implementing BE-043 (backend enhancement)
```

---

## Self-Review Protocol

Before code reaches review, the implementing agent completes self-review cycles. For code changes, 4 cycles are required:

### Cycle 1: Contract & State Invariants
- Do public APIs match their declared contracts?
- Are state transitions correct and complete?
- Are domain model constraints preserved?
- Are shared types consistent across repo boundaries?

### Cycle 2: Security & Failure Modes
- Injection risks (SQL, command, XSS)?
- Auth/authz bypass opportunities?
- Sensitive data in logs or responses?
- Error handling: graceful failures, correct propagation?
- Race conditions, TOCTOU, concurrency issues?

### Cycle 3: Tests & Operability
- Test coverage for new/changed behavior?
- Performance: O(n^2), N+1 queries, unnecessary allocations?
- Logging and observability for production debugging?
- Backwards compatibility where applicable?

### Cycle 4: Requirement Closure
- Does the implementation satisfy the ticket ask?
- Draft closure evidence:
  - **Ticket ask:** what was requested
  - **Implemented:** what was built
  - **Not implemented:** what was deferred
  - **Closeout verdict:** complete / partial

Each cycle is recorded with findings and verdict. The governance CLI blocks submission until all cycles pass.

---

## Code Review Protocol

Reviews follow a 4-pass structure:

1. **Correctness & Contracts** — APIs, state machines, logic errors
2. **Security & Failure Modes** — injection, auth, data exposure
3. **Quality & Operability** — tests, performance, observability
4. **Requirement Closure** — does it actually do what was asked?

Findings format:
```
BE-042-F1 | HIGH | security | src/orders/processor.ts:142
  Missing tenant isolation check on bulk query.
  Suggestion: Add tenantId filter to the WHERE clause.
```

- **HIGH findings** block landing — ticket goes back to doing
- **MED/LOW findings** are recorded but don't block

---

## Quality Gates

Three tiers of automated validation:

| Tier | When | Budget | What |
|------|------|--------|------|
| **default** | Pre-push, inner loop | <=75s | Unit tests, contract tests, integration tests |
| **full** | Pre-merge | No limit | Default + typecheck, lint, architecture checks, prod build |
| **extended** | Pre-release | No limit | Full + migrations, performance tests, mobile builds |

Gate artifacts (JSON reports) are saved and referenced in plan records. The pre-push git hook enforces the default gate automatically.

---

## MCP Integrations

Connect Claude to external tools via Model Context Protocol:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server@latest"],
      "env": {
        "SENTRY_AUTH_TOKEN": "...",
        "SENTRY_ORG": "my-org",
        "SENTRY_PROJECT": "my-project"
      }
    },
    "datadog": {
      "command": "npx",
      "args": ["-y", "@anthropic/datadog-mcp-server@latest"],
      "env": {
        "DD_API_KEY": "...",
        "DD_APP_KEY": "..."
      }
    }
  }
}
```

Useful integrations:

| Server | What Claude Can Do With It |
|--------|---------------------------|
| **Sentry** | Search errors, view stack traces, check release health |
| **Datadog** | Query metrics, read logs, check APM traces |
| **GitHub** | Richer PR/issue automation beyond the `gh` CLI |
| **Linear/Jira** | Sync tickets to external trackers |
| **Slack** | Post updates, read channel history |
| **PostgreSQL** | Direct database queries (read-only recommended) |

---

## Memory System

Claude maintains persistent memory across sessions at `.claude/projects/<path>/memory/`:

| Type | What It Stores | Example |
|------|---------------|---------|
| **User** | Your role, preferences, expertise | "Senior engineer, prefers terse responses" |
| **Feedback** | Corrections and confirmed approaches | "Never merge to dev before finalize/land" |
| **Project** | Ongoing work, decisions, known issues | "Auth rewrite driven by compliance, not tech debt" |
| **Reference** | Where to find things externally | "Pipeline bugs tracked in Linear project INGEST" |

This means Claude doesn't start cold every session. It remembers:
- Past mistakes and how to avoid them
- Your working style and preferences
- Project context and active decisions
- Known issues and workarounds

### What Not to Save

- Code patterns (read the code instead)
- Git history (use `git log`)
- Fix recipes (the fix is in the code)
- Ephemeral task state (use tasks, not memory)

---

## Codebase Audits

Periodically run full codebase reviews to catch systemic issues:

```
/code-reviewer Review the full backend codebase — focus on architecture,
  code quality, patterns, potential bugs, security issues
```

Claude will spawn parallel exploration agents covering:
- Architecture and structure
- Security patterns (auth, injection, data exposure)
- Code quality (error handling, type safety, duplication)
- Performance (N+1 queries, missing pagination, large allocations)

Findings become tickets on the board with severity and priority.

---

## Test Infrastructure

### Lane-Based Test Classification

Instead of a flat test suite, classify tests into lanes. Each lane has a purpose, a budget, and a gate tier:

| Lane | Purpose | Examples | Gate Tier |
|------|---------|----------|-----------|
| **contract** | Verify public API surface matches declared types | HTTP endpoint contracts, event envelope shapes | default |
| **unit** | Test bounded-context core logic in isolation | Domain services, state machines, validators | default |
| **workflow** | Test operational state transitions end-to-end | Order lifecycle, approval chains, scheduling | default |
| **app-integration** | Test app bootstrap and request handling | Server startup, middleware, route wiring | default |
| **integration** | Test cross-cutting concerns with real dependencies | Database queries, external API calls | default |
| **architecture** | Enforce module boundaries and API stability | Forbidden imports, public export checks | full |
| **heavy** | Expensive tests excluded from inner loop | Large seed data, worker smoke tests, migrations | extended |

Each test file is assigned to exactly one lane. A lane coverage check ensures no test file is unclassified:

```bash
# Verify all .test.ts files belong to a lane
pnpm test:lane-coverage
```

### Test Seams

Design your code with test seams — interfaces that can be swapped for in-memory implementations during testing:

```
Production:  PostgreSQL -> PgSessionStore -> SessionService
Testing:     InMemoryMap -> MemorySessionStore -> SessionService
```

The service layer doesn't know which store it's using. This lets you run unit and workflow tests without a database, keeping the default gate under 75 seconds.

### Contract Tests

Contract tests verify that your API surface matches its declared types. They catch drift between what the code does and what consumers expect:

- **HTTP contracts**: Request/response shapes match TypeScript types
- **Event contracts**: Event envelope shapes match declared schemas
- **Cross-repo contracts**: Frontend SDK types match backend API responses

Run these on every push. They're fast and catch the most painful bugs.

### Coverage Gates

Enforce coverage thresholds on critical packages:

```bash
# Coverage required for: api, planning-dispatch, tenant-admin, workflow
pnpm test:coverage --threshold 80
```

Don't enforce coverage globally — it incentivizes meaningless tests. Target coverage on packages where bugs are expensive.

### Gate Artifacts

Every gate run produces a JSON artifact with timing, results, and metadata:

```json
{
  "gate": "default",
  "started_at": "2026-04-09T10:00:00Z",
  "duration_ms": 42000,
  "steps": [
    {"name": "contract", "passed": true, "duration_ms": 3200},
    {"name": "unit", "passed": true, "duration_ms": 18500},
    {"name": "workflow", "passed": true, "duration_ms": 12300}
  ],
  "result": "pass"
}
```

These artifacts are committed to git so you can track gate performance over time and detect regressions.

---

## Development Environment Setup

### Local Services

Define dev scripts that start all services in parallel:

```bash
# Backend
pnpm dev:api          # API server on :3001
pnpm dev:workflow     # Workflow worker
pnpm dev:ingest       # Ingest worker
pnpm dev:projector    # Projector (read models)

# Frontend
pnpm dev              # All web apps + mobile (parallel via Turbo)
```

Create a `/health-check` skill that verifies everything is running:

```
/health-check
# Output:
# API server:     UP (127.0.0.1:3001, 12ms)
# Workflow worker: UP (pid 4521)
# ops-web:        UP (localhost:3001, 45ms)
# public-web:     UP (localhost:3000, 38ms)
# PostgreSQL:     UP (5 migrations applied, 0 pending)
```

### Database Setup

For local development:

1. **PostgreSQL** for integration tests and full-stack dev
2. **In-memory stores** for unit tests (no DB required)
3. **Migration runner** with advisory lock protection

```bash
/migrate status       # Show applied vs pending migrations
/migrate run          # Apply pending migrations
/seed-data backend    # Seed reference data for local testing
```

### Dev Actors

For apps that require authentication, define dev actors that bypass real auth:

| Actor | Surface | Permissions | Use Case |
|-------|---------|-------------|----------|
| `admin-demo` | web | Full permissions | Testing admin flows |
| `operator-demo` | web | Standard operator | Testing daily operations |
| `driver-demo` | mobile | Driver permissions | Testing mobile app |

Dev actors are only available when an explicit environment variable is set. Production builds must never fall back to dev actors.

### Environment Variables

Document all environment variables in a deployment contract:

```markdown
## Required
NEXT_PUBLIC_API_URL     # Frontend API target (build-time)
DATABASE_URL            # PostgreSQL connection string
SESSION_SECRET          # HMAC secret for session tokens

## Optional
ENABLE_DEV_SESSIONS=false   # Allow dev actor sessions
LOG_LEVEL=info              # Structured log verbosity
```

The key rule: **deployed builds must never use default/fallback values for secrets.** Throw on missing secrets in production.

---

## CI/CD Pipeline Integration

### Pre-Push Hook

Install a git hook that runs the default gate before every push:

```bash
# .husky/pre-push or tools/hooks/pre-push
pnpm gate:default:hook
```

This catches broken code before it reaches the remote. The hook should run the same gate the governance CLI uses.

### PR Checks

Configure CI to run the full gate on every PR:

```yaml
# .github/workflows/gate.yml
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm gate:full
```

The full gate includes everything the default gate does, plus typecheck, lint, architecture checks, and production build validation.

### Merge Rules

- PRs require passing gate check before merge
- PRs require at least one approval (human or governed review)
- Squash merge to keep history clean
- Branch protection on `dev` and `main`

### Deployment Pipeline

```
dev branch    -> staging (auto-deploy on merge)
main branch   -> production (manual promotion with gate)
```

The `/deploy` skill wraps this:

```bash
/deploy backend --env staging      # Gate + build + deploy to staging
/deploy frontend --env production  # Gate + build + confirm + deploy to prod
```

---

## Architecture Documentation

### Spec-Driven Development

Before writing code, write specs. Keep them in `coord/` alongside the board:

| Document | Purpose |
|----------|---------|
| `ARCHITECTURE.md` | Service boundaries, domain ownership, tech stack decisions |
| `DOMAIN_MODEL.md` | Entity relationships, aggregate boundaries, invariants |
| `REQUIREMENTS.md` | User Requirements Specification — what the system must do |
| `SECURITY_AND_OPERABILITY.md` | Auth model, data protection, disaster recovery |
| `TESTING_AND_GATES.md` | Test strategy, gate tiers, timing budgets |
| `CONFIG_INHERITANCE_MODEL.md` | How configuration cascades through tenant hierarchy |

These documents are the source of truth for architecture decisions. When an agent plans a ticket, it reads the relevant specs first.

### Design Records

For significant decisions, create design records that capture:

- **Context**: What problem are we solving?
- **Decision**: What did we choose?
- **Alternatives**: What did we consider and reject?
- **Consequences**: What are the tradeoffs?

Store these in `coord/active/` or `coord/design/`. They prevent agents from re-litigating settled decisions.

### Ticket Prompts

For complex tickets, write a detailed prompt that goes beyond the one-line description:

```markdown
# BE-042: Fix race condition in order processing

## Context
Orders can be submitted concurrently for the same customer.
The current code reads inventory, validates, then writes — classic TOCTOU.

## Requirements
- Serialize order writes per customer using advisory locks
- Return 409 Conflict if lock acquisition times out
- Add integration test proving concurrent orders are safe

## Constraints
- Must not add >5ms latency to the happy path
- Must not block orders for different customers
```

Store prompts in `coord/prompts/` and map them to tickets in the board's `prompt_index`.

---

## Ticket Decomposition

### From Epic to Tickets

When Claude runs `/orchestrator decompose <epic>`, it should:

1. Read the relevant specs (architecture, domain model, URS)
2. Identify the work units needed
3. Map dependencies between them
4. Assign priority based on dependency order and risk

A good decomposition follows these rules:

- **Each ticket is independently implementable** — no ticket requires partial work from another
- **Each ticket is independently testable** — has its own test cases and gate criteria
- **Dependencies are explicit** — the `Depends On` field in the board
- **Types are accurate** — `design`, `feature`, `bug`, `refactor`, `security`, `enhancement`

### Dependency Graphs

Tickets should form a DAG (directed acyclic graph). The orchestrator uses this to recommend the next ticket:

```
ARCH-001 (design)
  ├── BE-001 (feature) ──> BE-005 (feature)
  ├── BE-002 (feature) ──> BE-006 (enhancement)
  └── FE-001 (feature) ──> FE-003 (feature)
```

A ticket is "unblocked" when all its dependencies are done. The orchestrator surfaces the highest-priority unblocked ticket.

### Followup Tickets

When implementation reveals new work, create followup tickets instead of scope-creeping the current one:

```json
{
  "BE-043": {
    "parent": "BE-042",
    "type": "related-followup"
  }
}
```

This keeps tickets focused and the board honest about scope.

---

## Onboarding New Agents and Developers

### Agent Startup Checklist

Every agent (human or AI) must complete a checklist before picking up work:

1. Read `GOVERNANCE.md` — understand the rules
2. Read `AGENTS.md` for the target repo — understand repo-specific patterns
3. Read the board — understand what's in progress and what's blocked
4. Read the URS — understand what the system is supposed to do
5. Check `QUESTIONS.md` — understand open blockers
6. Confirm the ticket exists and is in a legal status for the intended action

### Repo-Specific Agent Guides

Each repo has an `AGENTS.md` that covers:

- **Worktree location**: Where to create isolated workspaces
- **Build commands**: How to build, test, lint
- **Architecture patterns**: Module boundaries, naming conventions, shared types
- **Gate commands**: Which gate lane to run
- **Feature proof cutoff**: Which ticket number starts requiring feature proofs

### For Human Developers

If a human developer joins the project:

1. Clone the workspace and run `/health-check` to verify setup
2. Read `GOVERNANCE.md` to understand the workflow
3. Use `/orchestrator status` to see the board state
4. Use `/orchestrator next` to find a good first ticket
5. Follow the same plan -> implement -> review -> land cycle

The governance system works the same for humans and AI. The CLI doesn't care who's running it.

---

## Incident and Hotfix Workflow

### When Production Breaks

For urgent production issues that can't wait for the normal governance cycle:

1. **Create a P0 ticket** on the board with type `bug`
2. **Skip the planning phase** — go directly to implementation
3. **Implement the fix** on a hotfix branch from `main` (not `dev`)
4. **Run the default gate** — never skip tests, even for hotfixes
5. **Land directly to main** with `gov land --base main`
6. **Cherry-pick to dev** to keep branches in sync
7. **Create a followup ticket** for any proper fix needed (the hotfix may be a band-aid)

The governance CLI supports this with:

```bash
gov start BE-099 --hotfix          # Branch from main instead of dev
gov land BE-099 --base main        # Merge to main
```

### Post-Incident Review

After the hotfix lands, run a codebase audit on the affected area:

```
/code-reviewer Review the order processing module for similar issues
```

Create tickets for any systemic problems found. The hotfix fixes the symptom; the follow-up tickets fix the cause.

---

## Cost and Efficiency

### Token Usage Patterns

AI-driven development consumes tokens. Here's how to manage it:

| Activity | Token Cost | Frequency |
|----------|-----------|-----------|
| Planning a ticket | Medium | Once per ticket |
| Implementation | High | Once per ticket |
| Self-review (4 cycles) | Medium-High | Once per ticket |
| Code review | Medium | Once per ticket |
| Codebase audit | Very High | Weekly/monthly |
| `/orchestrator status` | Low | Multiple times daily |

### When to Use Which Model

| Model | When |
|-------|------|
| **Opus/Large** | Architecture decisions, complex implementation, nuanced review |
| **Sonnet/Medium** | Standard implementation, self-review, gate running |
| **Haiku/Small** | Quick lookups, status checks, simple edits |

### Reducing Waste

- **Skills over free-form prompts** — skills are focused and don't waste tokens on prompt interpretation
- **Memory over re-explanation** — save decisions so you don't re-explain context every session
- **Parallel agents over sequential** — run independent work concurrently instead of waiting
- **Targeted audits over full audits** — audit the module you changed, not the entire codebase
- **Gate tiers** — run the default gate (75s) for inner-loop work, save the full gate for pre-merge

---

## Monitoring AI Quality Over Time

### Track Review Findings

Keep a running tally of review findings by category and severity:

| Month | HIGH | MED | LOW | Top Category |
|-------|------|-----|-----|-------------|
| Jan | 8 | 23 | 15 | security |
| Feb | 5 | 19 | 12 | correctness |
| Mar | 3 | 14 | 8 | quality |

Decreasing HIGH findings over time means the agents are learning (via memory) and the codebase is improving.

### Detect Governance Drift

Run `/orchestrator check` periodically to detect:

- Stale locks (agent abandoned work without releasing)
- Tickets in `doing` for too long (stuck or forgotten)
- Plan records missing required fields
- Branches that diverged from `dev`

### Audit Agent Decisions

Periodically review the governance event log:

```bash
# Last 50 governance events
tail -50 coord/.runtime/governance-events.ndjson | jq .
```

Look for:
- Tickets that bounced between doing and review multiple times (implementation quality issue)
- Self-review cycles that always pass with no findings (rubber-stamping)
- Tickets that were deferred repeatedly (unclear requirements)

### Regression Detection

Compare gate timing across runs:

```bash
# Gate duration trend
jq '.duration_ms' artifacts/gates/default.latest.json
```

If gate duration is creeping up, investigate:
- Are tests getting slower? (N+1 queries, missing mocks)
- Are there more tests? (good, but may need lane rebalancing)
- Is the build getting larger? (bundle splitting needed)

---

## Getting Started with coord-template

If you want to adopt this workflow, use `coord-template` as the starting point. It's a ready-to-use coordination directory with everything pre-wired:

```bash
# Copy the template into your workspace
cp -r coord-template/ ~/projects/my-platform/coord/

# What's included:
coord/
├── GOVERNANCE.md              # Governance policy (customize for your team)
├── AGENT_STARTUP_CHECKLIST.md # Agent onboarding checklist
├── TESTING_AND_GATES.md       # Test strategy and gate tiers
├── board/
│   ├── tasks.json             # Empty board, ready for tickets
│   ├── tasks.schema.json      # Board JSON schema
│   ├── plan.schema.json       # Plan record schema
│   └── board.js               # Board sync and validation tool
├── scripts/
│   └── gov                    # Governance CLI
├── .runtime/                  # Runtime state (locks, agents, events)
├── prompts/                   # Ticket prompt files
└── plugins/
    └── governance/commands/   # Skill definitions
```

Then:
1. Add a `CLAUDE.md` at the workspace root pointing to `coord/GOVERNANCE.md`
2. Add an `AGENTS.md` to each repo with repo-specific patterns
3. Create your first tickets in `coord/board/tasks.json`
4. Run `/orchestrator status` to verify everything is wired up
5. Run `/orchestrator next` to pick your first ticket

---

## Practical Tips

### 1. Start Small
Don't build the full governance system on day one. Start with:
- `CLAUDE.md` with project context
- A few custom skills (`/deploy`, `/health-check`)
- Memory for key decisions

Add governance, board, and multi-agent coordination as the project grows.

### 2. Keep Skills Focused
Each skill should do one thing well. A `/deploy` skill that also runs migrations and seeds data is too broad. Split them.

### 3. Trust the Loop
The workflow is: **define -> plan -> implement -> self-review -> code-review -> gate -> land.** Every step catches different issues. Don't short-circuit it for speed.

### 4. Use Memory for Surprising Things
Don't save obvious patterns. Save things like:
- "The team prefers one bundled PR over many small ones for refactors"
- "Never put a colon after script names in --repo-gate flags"
- "Auth middleware rewrite is legal-driven, not tech debt"

### 5. Run Parallel Agents for Independent Work
If you have two unrelated tickets, spawn two agents. They'll work in separate worktrees with separate locks and won't conflict.

### 6. Review the Reviews
Claude's self-review catches real bugs, but it can also be formulaic. Periodically review the review findings to ensure they're substantive, not just pattern-matching.

### 7. Keep the Board Clean
Delete stale branches regularly. Prune done tickets after a while. A cluttered board creates noise for the orchestrator.

### 8. Version Your Governance
The governance policy, board schema, and CLI should be versioned alongside the code. When the rules change, the change is tracked in git like any other code change.

---

## File Structure Reference

```
~/projects/my-platform/
├── CLAUDE.md                           # Entry point for Claude
├── .mcp.json                           # MCP server config
├── .claude/
│   ├── skills/
│   │   ├── deploy/SKILL.md             # /deploy command
│   │   ├── migrate/SKILL.md            # /migrate command
│   │   ├── seed-data/SKILL.md          # /seed-data command
│   │   ├── db-status/SKILL.md          # /db-status command
│   │   └── health-check/SKILL.md       # /health-check command
│   └── projects/<path>/memory/
│       ├── MEMORY.md                   # Memory index
│       ├── user_role.md                # Who you are
│       ├── feedback_*.md               # Corrections and preferences
│       └── project_*.md                # Active context
├── plugins/
│   └── governance/commands/
│       ├── orchestrator.md             # /orchestrator command
│       ├── planner.md                  # /planner command
│       ├── code-writer.md              # /code-writer command
│       ├── code-reviewer.md            # /code-reviewer command
│       ├── gate.md                     # /gate command
│       └── recover.md                  # /recover command
├── coord/
│   ├── GOVERNANCE.md                   # Canonical rules
│   ├── board/
│   │   ├── tasks.json                  # Ticket board
│   │   ├── plans/                      # Plan records per ticket
│   │   └── board.js                    # Board sync/validate
│   ├── scripts/
│   │   └── gov                         # Governance CLI
│   ├── .runtime/
│   │   ├── locks/                      # Ticket lock files
│   │   ├── agents.json                 # Agent registry
│   │   └── governance-events.ndjson    # Immutable event log
│   └── prompts/                        # Ticket prompt files
├── backend/
│   ├── AGENTS.md                       # Repo-specific agent guide
│   └── .worktrees/                     # Isolated agent workspaces
└── frontend/
    ├── AGENTS.md
    └── .worktrees/
```

---

## Summary

| Aspect | How It Works |
|--------|-------------|
| **Role split** | Human = architect + reviewer. AI = planner + implementer. |
| **Governance** | CLI-enforced lifecycle. No hand-edits. All mutations auditable. |
| **Concurrency** | Lock files + worktrees + single board = safe parallel execution. |
| **Quality** | 4-cycle self-review + 4-pass code review + 3-tier gates. |
| **Multi-agent** | Any AI provider, same rules. Board is the single source of truth. |
| **Memory** | Persistent across sessions. Corrections, preferences, and context survive. |
| **Skills** | Named slash commands for repeatable workflows. Markdown files, not code. |
| **Integrations** | MCP servers for Sentry, Datadog, GitHub, Slack, etc. |

The goal is not to replace developers. It's to let developers operate at a higher level of abstraction — defining what to build, verifying it was built correctly, and making the judgment calls that require human context. The AI handles the volume.
