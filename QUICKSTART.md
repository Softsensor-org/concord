# Softsensor Concord — Quickstart (First 5 Minutes)

> Concord installs as the `coord/` directory and is driven by the `gov` CLI.

## 0. See the cockpit first (2-minute demo)

Before setting anything up, run the bundled demo to see what governed agent work
looks like — a real board, requirement traceability, a timeline, and a
control-mapped evidence export:

```bash
cd frontend/apps/coord-ui
npm install
npm run demo        # opens the cockpit on http://localhost:3002 against examples/demo/coord
```

You'll see one fully-evidenced `done` ticket, one in review, and one queued —
with closure, feature-proof, gates, and the event timeline. Then generate the
auditor-facing evidence from the same state:

```bash
# from the repo root
node coord/scripts/evidence-export.mjs --coord-dir examples/demo/coord --format md
```

When you're ready to use it on your own project, continue below.

## 1. Copy the template

```bash
# From your project root (parent of your product repos)
cp -R /path/to/coord-template/coord ./coord
cp -R /path/to/coord-template/.claude ./.claude
cp /path/to/coord-template/CLAUDE.md ./CLAUDE.md
cp /path/to/coord-template/CODEX.md ./CODEX.md
cp /path/to/coord-template/GEMINI.md ./GEMINI.md
cp /path/to/coord-template/AGENTS.md ./AGENTS.md
```

## 2. Configure repo names

If your repos are not using the template defaults, update the canonical repo map:

```bash
# Edit these files:
coord/project.config.js # Change repo paths / branches / aliases
coord/product/REPOS.md  # Update repo descriptions to match
```

For the complete adoption checklist (prompts, validation hooks, starter process
notes), see `coord/SCAFFOLD_TAILORING_CHECKLIST.md`.

## 3. Create your first ticket

Authoring a **new backlog row** by hand is the supported way to create a
ticket. This is the one allowed hand-edit of `coord/board/tasks.json`: add a
row with `Status: todo` / `Owner: unassigned`, then sync. After that, the
ticket's lifecycle fields (status, owner, locks) are owned by `gov` — never
hand-edit those (see `coord/AGENTS.md` and `coord/DIRECTORY.md`).

Add a ticket to the relevant `sections[].rows[]`:

```json
{
  "sections": [
    {
      "title": "Setup",
      "rows": [
        {
          "ID": "SETUP-001",
          "Repo": "X",
          "Type": "infra",
          "Pri": "P0",
          "Status": "todo",
          "Owner": "unassigned",
          "Description": "Initial project setup and governance validation.",
          "Depends On": ""
        }
      ]
    }
  ]
}
```

Then sync:

```bash
node coord/board/board.js sync
```

## 4. Start your first governed session

```bash
# In Claude Code:
/initiate
```

This will:
- Claim an agent identity
- Run health checks
- Show the board summary
- Recommend the next ticket

## 5. Work on a ticket

```bash
/planner SETUP-001     # Plan the approach
/code-writer SETUP-001  # Implement it
```

## 6. Populate spec stubs (when ready)

The `coord/` directory has stub files for requirements, architecture, domain model, etc. Fill in the ones relevant to your project before starting feature work. See `coord/README.md` for the full list.

## Available Skills

### Governance Skills

| Command | Purpose |
|---------|---------|
| `/initiate` | Start a governed session |
| `/orchestrator status` | Board overview |
| `/orchestrator next` | Recommend next ticket |
| `/planner <ticket>` | Plan before implementing |
| `/code-writer <ticket>` | Full implementation workflow |
| `/code-reviewer <ticket>` | Code review |
| `/recover <ticket>` | Fix governance issues |
| `/gate <repo-name>` | Run quality gates |

### Specialist Skills

| Command | Purpose |
|---------|---------|
| `/manual-tester [scope]` | Find bugs |
| `/qa-review [scope]` | Full QA audit |
| `/business-analyst [scope]` | Requirement analysis |
| `/designer [scope]` | UX/accessibility audit |

### Operations Skills

| Command | Purpose |
|---------|---------|
| `/deploy <service> --env staging` | Build, gate, deploy |
| `/migrate run\|create\|status` | Database migrations |
| `/seed-data <repo-name>` | Seed development data |
| `/db-status` | Database health check |
| `/health-check` | Check all services |

## 7. Configure MCP integrations (optional)

The template includes `.mcp.json` pre-configured for Sentry and Datadog. Fill in your credentials to connect:

```bash
# Edit .mcp.json and set:
# Sentry: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
# Datadog: DD_API_KEY, DD_APP_KEY
```

Restart Claude Code after editing. See `DEVELOPER_NOTE.md` for the full list of available MCP servers.

Exact repo names come from `coord/project.config.js` and `coord/product/REPOS.md`. The block below shows the default two-repo shape:

## Directory Structure After Setup

```
your-project/
├── .claude/
│   ├── commands/           ← Governance skills (19 slash commands)
│   └── skills/             ← Operations skills (5 slash commands)
│       ├── deploy/
│       ├── migrate/
│       ├── seed-data/
│       ├── db-status/
│       └── health-check/
├── .mcp.json               ← MCP server config (Sentry, Datadog)
├── backend/                ← Example default `B` repo
├── frontend/               ← Example default `F` repo
├── coord/                  ← Governance, board, plans
│   ├── board/tasks.json    ← Canonical task board
│   ├── scripts/gov         ← Governance CLI
│   ├── prompts/            ← Ticket role prompts
│   ├── active/             ← Ticket-local implementation notes
│   └── .runtime/           ← Locks, sessions, journal (gitignored)
├── CLAUDE.md               ← Claude agent config
├── CODEX.md                ← Codex agent config
├── GEMINI.md               ← Gemini agent config
├── AGENTS.md               ← Shared agent policy
└── DEVELOPER_NOTE.md       ← AI development methodology guide
```
