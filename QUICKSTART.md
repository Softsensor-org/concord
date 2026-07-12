# Softsensor Concord — Quickstart (First 5 Minutes)

> Concord installs as the `coord/` directory and is driven by the `gov` CLI.
> It is an overlay for existing repos, CI, tickets, PRD/URS documents, and agent
> workflows — not a replacement for your SDLC.

For a fuller existing-repo adoption path, see
`coord/product/EXISTING_REPO_ADOPTION_QUICKSTART.md`.

For teams running multiple humans and agents, use the fleet runbook in
`coord/docs/FLEET_GOLDEN_PATH.md` or run:

```bash
coord/scripts/gov fleet-golden-path <ticket-id>
```

## 0. See the cockpit first (2-minute demo)

Before setting anything up, run the bundled demo to see what governed agent work
looks like — a real board, requirement traceability, a timeline, and a
control-mapped evidence export:

```bash
npm --prefix frontend/apps/coord-ui install && npm --prefix frontend/apps/coord-ui run demo
```

You'll see one fully-evidenced `done` ticket, one in review, and one queued —
with closure, feature-proof, gates, and the event timeline. Then generate the
auditor-facing evidence from the same state:

```bash
# from the repo root
node coord/scripts/evidence-export.mjs --coord-dir examples/demo/coord --format md
```

When you're ready to use it on your own project, continue below.

## 1. Install Concord

**Recommended — one command (vendors the engine in-tree, no global install):**

```bash
# New project (fresh governed board):
npx create-concord my-project
cd my-project

# OR overlay onto an EXISTING repo — detects the repo shape, proposes a
# governance tier + track preset, and writes a tailored coord/project.config.js
# plus 3 starter tickets (skip step 2 below — onboarding already did it):
cd my-existing-repo
npx create-concord . --from-existing

# Optional operating-governance packs:
npx create-concord my-site --workflow-pack site-seo
npx create-concord my-analytics --workflow-pack daily-analytics
```

No Node on the box (devcontainer, WSL, CI, minimal image)? Use the standalone
Linux binary from the GitHub Release — same result, no runtime required:

```bash
concord init .            # or: concord init my-project
concord init my-site --workflow-pack site-seo
```

`create-concord` vendors `coord/` in-tree (GCV-4), pins the engine version in
`coord/.coord-engine.json`, writes the commit-vs-gitignore split + the
`coord/WORKSPACE.md` runtime guide, and wires `npm run gov` /
`npm run concord` / `npm run coord-ui`. Optional workflow packs copy
`00-ops/...` and `data/...` operating templates into the scaffolded app, so the
work runs from that app rather than from `coord-template`. Upgrade later by
reviewing the write-free plan and applying its exact digest:

```bash
npm run concord -- upgrade
npm run concord -- upgrade --apply-plan <digest-from-plan>
```

From the scaffolded app root, `npm run coord-ui` launches that app's own bundled
read-only cockpit against that app's `coord/`.

<details><summary>Manual copy (no npm/binary) — fallback</summary>

```bash
# From your project root (parent of your product repos)
cp -R /path/to/coord-template/coord ./coord
cp -R /path/to/coord-template/.claude ./.claude
cp /path/to/coord-template/CLAUDE.md ./CLAUDE.md
cp /path/to/coord-template/CODEX.md ./CODEX.md
cp /path/to/coord-template/GEMINI.md ./GEMINI.md
cp /path/to/coord-template/AGENTS.md ./AGENTS.md
```
</details>

## 2. Configure repo names

> `npx create-concord . --from-existing` already did this — skip to step 3.

Prefer the guided scanner first. It inspects the repo shape, recommends an
adoption tier and track preset, and writes nothing unless you explicitly ask it
to:

```bash
npm run concord -- onboard . --dry-run
npm run concord -- track-presets
```

If your repos are not using the template defaults, update the canonical repo map:

```bash
# Edit these files:
coord/project.config.js # Change repo paths / branches / aliases
coord/product/REPOS.md  # Update repo descriptions to match
```

For the complete adoption checklist (prompts, validation hooks, starter process
notes), see `coord/SCAFFOLD_TAILORING_CHECKLIST.md`.

## 3. Point Concord at your existing requirements

Use the specification stubs when you are starting fresh. If you already have a
PRD, URS, architecture doc, Jira epic, or regulated requirements pack, keep that
source and make Concord reference it:

```bash
# Common starting points:
coord/product/REQUIREMENTS.md  # PRD/URS or links to the source of truth
coord/product/ARCHITECTURE.md  # architecture decisions and constraints
coord/product/REPOS.md         # repo map and ownership
```

The goal is traceability: requirement -> ticket -> plan -> gate evidence ->
review -> runtime/deploy evidence when needed -> closeout.

## 4. Create your first ticket

> A fresh `create-concord` scaffold already seeds `SETUP-001` (and a `SAMPLE-001`
> example) on the board — you can skip straight to step 5 for your first run and
> come back here when you author your own tickets.

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

Before submitting the first real ticket, run the closeout guide. It reports the
exact missing evidence and ready-to-paste `gov` commands instead of forcing a
new team to discover closeout ceremony by trial and error:

```bash
coord/scripts/gov guided-closeout SETUP-001
coord/scripts/gov publishability-check SETUP-001
```

## 5. Start your first governed session

```bash
# In Claude Code:
/initiate
```

This will:
- Claim an agent identity
- Run health checks
- Show the board summary
- Recommend the next ticket

## 6. Work on a ticket

```bash
/planner SETUP-001     # Plan the approach
/code-writer SETUP-001  # Implement it
```

## 7. Populate or link spec stubs (when ready)

The `coord/` directory has stub files for requirements, architecture, domain
model, etc. Fill in the ones relevant to your project, or link them to existing
PRD/URS/specification sources before major feature work. See `coord/README.md`
for the full list.

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

## 8. Configure MCP integrations (optional)

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
│   ├── commands/           ← Governance skills (27 slash commands)
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
