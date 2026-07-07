# Softsensor Concord

**The coordination and governance layer for multi-agent software development.**

Claude Code, Codex, Cursor, and human engineers can all work on the same codebase in parallel — without stomping each other's branches, losing ownership context, or shipping ungated changes. Concord gives every unit of work a lifecycle: claim → plan → implement → gate → review → land, with a tamper-evident journal of who did what and why.

Apache-2.0 · [Quickstart](QUICKSTART.md) · [User Manual](USER_MANUAL.md) · [Known Issues](KNOWN_ISSUES.md) · [Changelog](CHANGELOG.md)

> **Names:** the product is **Concord**. It installs as the `coord/` directory and is driven by the `gov` CLI (`coord/scripts/gov`). This repository is the distributable template.

---

## The Problem It Solves

When multiple agents (or humans and agents) work in the same repo concurrently:

- Branches get stomped or go stale
- No one knows who owns what or whether work was reviewed
- Quality gates get bypassed or forgotten
- There's no audit trail when something breaks

Concord solves this by adding a **governed execution layer** on top of your existing repos, CI, and ticketing system — without replacing any of them.

---

## Mental Model

Three things to internalize before you start:

```
Board (tasks.json)  ←→  gov CLI  ←→  Agent Skills (slash commands)
```

- **The board** (`coord/board/tasks.json`) is the single source of truth for ticket state. Never hand-edit ticket status — `gov` owns those fields.
- **The `gov` CLI** (`coord/scripts/gov`) drives every lifecycle transition: claiming a ticket, starting an isolated worktree/runtime, submitting for review, landing, etc.
- **Skills** (`.claude/commands/`) are the high-level slash commands your agents run. Skills call `gov` internally — they're the ergonomic layer, not a bypass.

### Ticket Lifecycle

```
todo → doing (gov start) → review (gov submit) → done (gov land)
```

Each transition is gated: `gov start` cuts a per-agent worktree and locks the ticket; `gov submit` requires passing gates and a plan record; `gov land` requires a completed review cycle. The journal records every event.

Fleet rule: do not run multiple governed agents from one shared checkout. `gov start` creates a ticket worktree by default, and repo `X` worktrees include their own gitignored `coord/.runtime/` scaffold. If a second heartbeat-fresh session is already bound to the same checkout/runtime, governance refuses the mutation and tells the operator to use a separate worktree. `--allow-shared-worktree` is an explicit local/single-agent escape hatch, not the fleet path.

For the operator runbook, see [Fleet Golden Path](coord/docs/FLEET_GOLDEN_PATH.md) or run:

```bash
coord/scripts/gov fleet-golden-path <ticket-id>
```

For first-time teams, use the guided adoption helpers before hand-wiring the
template:

```bash
coord/scripts/coord onboard . --dry-run     # adoption plan, no writes
coord/scripts/coord track-presets           # web/data/content/infra presets
coord/scripts/gov guided-closeout <ticket>  # exact closeout gaps + fixes
coord/scripts/gov publishability-check <ticket>
```

---

## Quickstart (5 minutes)

### 1. See it first

```bash
npm --prefix frontend/apps/coord-ui install && npm --prefix frontend/apps/coord-ui run demo
```

This launches the bundled read-only cockpit at <http://localhost:3002> against
the demo coord workspace. You'll see a real board: evidenced tickets, review
cycles, gate results, and the event timeline. Read the [demo walkthrough](DEMO.md)
for what to look at.

### 2. Install Concord

**One command — vendors the engine in-tree, no global install:**

```bash
# New project (fresh governed board):
npx create-concord my-project && cd my-project

# OR overlay onto an EXISTING repo — detects the repo shape, proposes a
# governance tier + track preset, and writes a tailored config + starter tickets:
cd my-existing-repo && npx create-concord . --from-existing
```

No Node on the box (devcontainer, WSL, CI, minimal image)? Use the standalone
**Linux binary** from the GitHub Release — same result, no runtime required:

```bash
./concord-linux-x86_64 init .
```

`create-concord` vendors `coord/`, pins the engine in `coord/.coord-engine.json`,
writes the commit-vs-gitignore split + the `coord/WORKSPACE.md` runtime guide, and
wires `npm run gov` / `npm run concord` / `npm run coord-ui`. Upgrade later with
`npm run gov -- upgrade`.
Prefer a manual copy? See the [User Manual](USER_MANUAL.md#fallback--manual-copy).

After scaffolding an app, launch that app's own cockpit from the app root:

```bash
npm run coord-ui
```

### 3. Map your repos

`npx create-concord . --from-existing` already wrote a tailored config — just
review it. Otherwise edit `coord/project.config.js` to match your project, then
update `coord/product/REPOS.md`. The full checklist is in
`coord/SCAFFOLD_TAILORING_CHECKLIST.md`.

```js
// coord/project.config.js (minimal example — repos is an object keyed by code)
module.exports = {
  coordTicketPrefix: "COORD",
  repos: {
    B: { path: "backend",  integrationBranch: "main" },
    F: { path: "frontend", integrationBranch: "main" },
  },
};
```

### 4. Sync the board

```bash
node coord/board/board.js sync
```

### 5. Start your first governed session

```bash
# In Claude Code
/initiate
```

This claims an agent identity, runs health checks, and shows the board summary with a recommended next ticket.

---

## Working on Tickets

### The Standard Flow

```bash
/planner TICKET-001      # Understand the ticket, write a plan
/code-writer TICKET-001  # Implement → gate → submit → land
```

`/code-writer` handles the full lifecycle: `gov start` (cut worktree + lock), implement, run gates, `gov submit` (move to review), complete a review cycle, `gov land` (merge + close). You can also drive each step manually via `gov`:

```bash
coord/scripts/gov start  TICKET-001   # claim + cut worktree
coord/scripts/gov submit TICKET-001   # move to review (gates must pass)
coord/scripts/gov land   TICKET-001   # merge + close
```

### Creating a Ticket

Hand-edit `coord/board/tasks.json` to add a row with `"Status": "todo"` and `"Owner": "unassigned"`. That is the one allowed hand-edit. Then sync:

```bash
node coord/board/board.js sync
```

Example row:

```json
{
  "ID": "MYAPP-001",
  "Repo": "B",
  "Type": "feature",
  "Pri": "P1",
  "Status": "todo",
  "Owner": "unassigned",
  "Description": "Add user authentication endpoint."
}
```

`Repo` codes: `B` = backend, `F` = frontend, `X` = coord/cross-repo. Define yours in `coord/project.config.js`.

---

## Key Commands

### Board & Session

| Command | What it does |
|---------|-------------|
| `coord/scripts/gov list` | Show all tickets and their status |
| `coord/scripts/gov explain <ticket>` | Full ticket state: status, owner, plan, gates, blockers |
| `coord/scripts/gov doctor` | Diagnose governance health (stale locks, drift, missing gates) |
| `coord/scripts/gov context-pack <ticket>` | Build an agent context pack for a ticket (used by skills) |

### Ticket Lifecycle

| Command | What it does |
|---------|-------------|
| `gov start <ticket>` | Claim + lock + cut worktree |
| `gov submit <ticket>` | Move to review (gates must pass) |
| `gov land <ticket>` | Merge + close (review must be complete) |
| `gov unstart <ticket>` | Return to todo (same owner, no work committed) |
| `gov block <ticket> --reason "..."` | Mark blocked |
| `gov heartbeat <ticket>` | Refresh a doing lock (keep-alive for long-running work) |

### Code Index (token-efficient codebase exploration)

The code index stores compact symbol summaries so agents read API signatures (~200 tokens) instead of full source (~3,000 tokens):

| Command | What it does |
|---------|-------------|
| `gov code-index` | Build or refresh the symbol index (400+ files, incremental) |
| `gov code-index --git` | Fast refresh — only re-indexes git-modified files (<200ms; runs automatically as a PostToolUse hook) |
| `gov code-index --force` | Force full rebuild |
| `gov code-search "<query>"` | BM25 search over the index — returns ranked file symbol views |
| `gov code-search "<query>" --top 5` | Limit results |
| `gov code-context <file> [file...]` | Compact symbol view for specific files |
| `gov code-diff [<base-ref>]` | Symbol views for files changed vs a git ref (default: HEAD) |

The index is stored at `coord/memory/code-index.ndjson` (gitignored, rebuildable). Context packs automatically include file symbols when the index is built.

### Memory & Insights

| Command | What it does |
|---------|-------------|
| `gov recall "<query>"` | Search governed memory (journal + plan records) |
| `gov insights` | Strategic execution-insight report |
| `gov prework <ticket>` | Pre-work context pack: prior attempts, failed approaches, recommended decomposition |
| `gov closeout-summary <ticket>` | Evidence-backed summary of a closed ticket |

---

## Agent Skills Reference

Skills are slash commands that run multi-step governed workflows. They live in `.claude/commands/`.

### Start Here

| Skill | When to use |
|-------|-------------|
| `/initiate` | Start of every session — claims identity, health check, board summary |
| `/next` | "What should I work on?" — board health + recommended ticket |
| `/do <ticket>` | Full plan → build → ship pipeline for one ticket |

### Core Workflow

| Skill | When to use |
|-------|-------------|
| `/planner <ticket>` | Before implementing — validates scope, writes the plan |
| `/code-writer <ticket>` | Implement + self-review + submit + land |
| `/code-reviewer <ticket>` | Review another agent's submission |
| `/resume <ticket>` | Handoff — pick up an in-progress ticket in a new session |

### Quality

| Skill | When to use |
|-------|-------------|
| `/gate <repo-name>` | Run quality gates for a repo |
| `/manual-tester [scope]` | Targeted defect discovery |
| `/qa-review [scope]` | Full 5-perspective audit (defects, requirements, risk, regression, release) |
| `/business-analyst [scope]` | Requirement traceability, acceptance-criteria gaps |
| `/designer [scope]` | Design system adherence, WCAG 2.1 AA, interaction patterns |

### Governance

| Skill | When to use |
|-------|-------------|
| `/orchestrator status` | Board overview — active work, blockers, queue |
| `/orchestrator next` | Recommend next highest-priority unblocked ticket |
| `/check` | Governance health diagnostics |
| `/recover <ticket>` | Repair stuck governance state |
| `/review <ticket>` | Self or cross-agent review (`--codex`, `--gemini`) |
| `/land <ticket>` | Merge after a separate review completes |

### Track Skills

Concord supports multi-track work beyond code. Each track has its own proof harness and gate policy:

| Skill | Track | When to use |
|-------|-------|-------------|
| `/content-edit <page>` | Marketing | Plain-English content change, gated by the content gate-proc |
| `/seo-check [scope]` | Marketing | HTML validity, broken links, SEO checks |
| `/publish <change>` | Marketing | Gate, submit, and ship a content change |
| `/data-pipeline run\|certify` | Data & Analytics | Run and certify a pipeline against its data contract |
| `/data-contract <output>` | Data & Analytics | Author or check a per-output data contract |
| `/analytics-query` | Product-Eng | Bounded production-MCP read with a governed receipt |
| `/insight-analyst [scope]` | Product-Eng | Interpret receipted findings and route fixes |
| `/live-mcp-policy` | Product-Eng | Show a live operation's class, scope, and approval requirement |

### Operations

| Skill | When to use |
|-------|-------------|
| `/deploy <service> --env staging` | Build, gate, and deploy a service |
| `/migrate run\|create\|status` | Database migration management |
| `/seed-data <repo-name>` | Seed development data |
| `/db-status` | Database health and connection pool |
| `/health-check` | Check all services across the stack |

---

## Adopting Into an Existing Project

Concord is an overlay — your repos, CI, tickets, and PRD/URS artifacts stay exactly where they are. The fastest overlay is one command:

```bash
cd my-existing-repo && npx create-concord . --from-existing
```

This detects your repo shape, proposes a governance tier + track preset, and
writes a tailored `coord/project.config.js` + `setup.decisions.json` + starter
tickets. Review those, then continue below.

### What to configure

| File | What to do |
|------|-----------|
| `coord/project.config.js` | Set repo codes, paths, and integration branches |
| `coord/product/REPOS.md` | Update repo descriptions to match |
| `coord/product/REQUIREMENTS.md` | Link or paste your PRD/URS (or leave as a pointer) |
| `coord/product/ARCHITECTURE.md` | Link or paste your architecture doc |
| `coord/board/tasks.json` | Replace seed backlog with your first tickets |
| `CLAUDE.md` | Keep thin — just point at `coord/GOVERNANCE.md` |

### What NOT to do

- Do not hand-edit `Status`, `Owner`, or lock fields in `tasks.json` after the initial setup — `gov` owns those.
- Do not edit files under `coord/rendered/` — they're auto-generated.
- Do not edit `.runtime/` files — those are live governance state.

### MCP integrations (optional)

The template ships `.mcp.json` pre-wired for Sentry and Datadog. Fill in credentials and restart Claude Code:

```bash
# .mcp.json — set these env vars:
# SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
# DD_API_KEY, DD_APP_KEY
```

The built-in `governance` MCP server works out of the box — it exposes typed governance tools without shelling out.

---

## Directory Layout

```
your-project/
├── .claude/
│   ├── commands/           ← 27 governance + specialist skills
│   └── skills/             ← 5 operations skills
├── .mcp.json               ← MCP config (Sentry, Datadog, governance)
├── backend/                ← Your backend repo (mapped in project.config.js)
├── frontend/               ← Your frontend repo
└── coord/
    ├── board/
    │   └── tasks.json      ← Canonical ticket board (the only board source of truth)
    ├── memory/
    │   └── code-index.ndjson  ← Symbol index (gitignored, rebuilt by gov code-index)
    ├── scripts/
    │   └── gov             ← Governance CLI entry point
    ├── prompts/            ← Ticket-role prompts (auto-loaded by skills)
    ├── active/             ← Ticket-local plan notes (one .md per in-progress ticket)
    ├── rendered/           ← Auto-generated board views (do not edit)
    ├── .runtime/           ← Locks, sessions, journal (gitignored)
    ├── product/            ← Spec stubs: requirements, architecture, domain model, etc.
    ├── project.config.js   ← Repo map (the one file you edit to bind Concord to your repos)
    └── GOVERNANCE.md       ← The canonical governance policy
```

---

## Further Reading

| Document | When to read it |
|----------|----------------|
| [QUICKSTART.md](QUICKSTART.md) | Step-by-step first-time setup with more detail |
| [USER_MANUAL.md](USER_MANUAL.md) | The end-to-end reference: install channels, config, lifecycle, upgrade, Community→Enterprise, org rollup, troubleshooting |
| [DEVELOPER_NOTE.md](DEVELOPER_NOTE.md) | AI-assisted development methodology, workflow patterns, cost management |
| [coord/GOVERNANCE.md](coord/GOVERNANCE.md) | The canonical policy — authority order, lifecycle rules, canonical files |
| [coord/AGENTS.md](coord/AGENTS.md) | Agent-specific rules and constraints |
| [coord/VERB_CONTRACT.md](coord/VERB_CONTRACT.md) | Full `gov` CLI verb reference |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Current issues, status, and workarounds |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [DEMO.md](DEMO.md) | Walkthrough of the bundled demo |

---

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Softsensor-org.
