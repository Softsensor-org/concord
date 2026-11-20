# Softsensor Concord — Quickstart (First 5 Minutes)

> Concord installs as the `coord/` directory. Start discovery with
> `coord/scripts/coord help`; use `gov` for governed lifecycle transitions.
> It is an overlay for existing repos, CI, tickets, PRD/URS documents, and agent
> workflows — not a replacement for your SDLC.

> **What this does and does not do.** Concord coordinates the actions taken
> through `gov` — ticket ownership, lifecycle locks, per-ticket Git worktrees,
> gates, review cycles, and a hash-chained record of those lifecycle operations.
> It reduces collisions for governed actions; it does not stop an agent or a
> person with local access from working outside governance, and its journal does
> not cover provider tool calls, shell commands, or file reads. Worktrees give
> repository separation, not process, filesystem, network, provider, or secret
> isolation. Full statement: [README — What Concord Does and Does Not Do](README.md#what-concord-does-and-does-not-do)
> and `coord/product/PUBLIC_CLAIMS_POLICY.md`.

For a fuller existing-repo adoption path, see
`coord/product/EXISTING_REPO_ADOPTION_QUICKSTART.md`.

For the `business-discovery`, `knowledge-claim-compile`, and
`requirements-import` workflow, see the
[operator runbook](coord/product/DISCOVERY_REQUIREMENTS_KNOWLEDGE_RUNBOOK.md).

For teams running multiple humans and agents, use the fleet runbook in
`coord/engine/docs/FLEET_GOLDEN_PATH.md` or run:

```bash
coord/scripts/gov fleet-golden-path <ticket-id>
```

Default help presents stable operator tasks. Explicit advanced discovery retains
the complete registry for automation:

```bash
coord/scripts/coord help
coord/scripts/coord commands --all --json
```

See the [generated command reference](coord/engine/docs/COMMAND_REFERENCE.md) for
namespace-specific entrypoints. Discovery is not authorization; compatibility
commands remain available without appearing as ordinary defaults.

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
node coord/engine/scripts/evidence-export.mjs --coord-dir examples/demo/coord --format md
```

When you're ready to use it on your own project, continue below.

Concord requires Git 2.38.0 or newer for merge previews used by governed
closeout. Doctor, onboarding, installation, the test runner and release checks
show the detected and required versions when Git is too old. The release-cut
check also needs a GNU-compatible `timeout` (Linux coreutils; on macOS
`brew install coreutils`, which provides `gtimeout`).

## 1. Install Concord

**Recommended — reviewed two-step install (vendors the engine in-tree, no global install):**

```bash
# New project (fresh governed board): review, then apply the exact plan.
npx create-concord my-project --dry-run \
  --git-init --git-ignore-block --git-stage --git-baseline-commit --git-scope coord
npx create-concord my-project --apply-plan <digest-from-plan> \
  --git-init --git-ignore-block --git-stage --git-baseline-commit --git-scope coord
cd my-project

# OR overlay onto an EXISTING workspace — the reviewed install plan applies a
# tailored config + setup decisions + sanitized onboarding receipt. It previews
# 3 starter tickets but does not file them without a separate explicit approval:
cd my-existing-repo
npx create-concord . --from-existing --dry-run
npx create-concord . --from-existing --apply-plan <digest-from-plan>

# Optional operating-governance packs:
npx create-concord my-site --workflow-pack site-seo --dry-run
npx create-concord my-site --workflow-pack site-seo --apply-plan <digest-from-plan>
npx create-concord my-analytics --workflow-pack daily-analytics --dry-run
npx create-concord my-analytics --workflow-pack daily-analytics --apply-plan <digest-from-plan>
```

Use the digest emitted by the matching dry-run with the same release payload
and unchanged destination. Release builders default to the donor commit timestamp,
so rebuilding the same source preserves the payload and plan digest. Builders may
set `SOURCE_DATE_EPOCH` to an explicit release epoch; use the same value when
reproducing that build. Adopters using a bundled release do not need to set it.

The install receipt prints `readiness`. A fresh workspace can be fully ready
when you explicitly approve the separate `coord/` Git initialization, exact
staging, and baseline commit shown above. If you omit those approvals, the
receipt says `incomplete` and gives the matching reviewed-plan flags. If the
workspace contains sibling repositories that are not mapped yet, readiness is
`ready_with_operator_decision`. Choose the sibling repository codes and paths
with `coord/scripts/coord-cli.js init --wizard --non-interactive --repo B:backend:main --dry-run`
(repeat `--repo CODE:path` for each sibling; choose your own codes and paths),
then apply that reviewed config with the same command and `--confirm`. After
that, review
`npm run concord -- onboard . --dry-run` and apply its reviewed plan. Existing
customized boards and prompts are preserved and checked for structural
consistency; fresh starter prompts are compared with the shipped starter
assignments.

If the first `coord/scripts/agent bootstrap` reports only that
`.runtime/governance-events.ndjson` differs from `HEAD`, sync the recorded
identity event with `coord/scripts/gov sync --commit "chore(coord): sync initial setup"`
and retry bootstrap. For local-only review and landing, commit scoped ticket
files with `gov commit <ticket-id> --files <path> --message "..."`. Then
`gov finalize <ticket-id> --no-pr --base dev --merge-workspace --push-before-closeout`
pushes the reviewed integration branch to its configured `dev` remote before
closeout.

When a baseline commit is approved, the committed receipt records the truthful
pre-commit observation as `readiness_before_baseline_commit`. The installer
prints readiness again after Git setup; use that live result for current status.

If your donor checkout is dirty, release packaging refuses it. Build from a
clean checkout or a separate clean Git worktree, or install a published package
artifact. Do not discard or stash the checkout just to bypass the refusal.

No Node on the box (devcontainer, WSL, CI, minimal image)? Use the standalone
Linux binary from the GitHub Release. It **installs** with zero Node on `PATH`;
the scaffolded workspace's ongoing governance commands (`npm run gov` and
friends) still require Node >= 22.8, so plan for Node on any box that will
actually run governance:

```bash
concord init . --dry-run
concord init . --apply-plan <digest-from-plan>
concord init my-project --dry-run
concord init my-project --apply-plan <digest-from-plan>
concord init my-site --workflow-pack site-seo --dry-run
concord init my-site --workflow-pack site-seo --apply-plan <digest-from-plan>
```

`create-concord` vendors `coord/` in-tree (GCV-4), pins the engine version in
`coord/.coord-engine.json`, writes the commit-vs-gitignore split + the
`coord/WORKSPACE.md` runtime guide, and wires the four operator scripts —
`npm run concord` (product ops), `npm run gov` (governance lifecycle),
`npm run agent` (provider-neutral operator facade), and `npm run coord-ui`
(read-only cockpit) — with their ownership boundaries documented in
`coord/WORKSPACE.md`. Optional workflow packs copy `00-ops/...` and `data/...`
operating templates into the scaffolded app, so the work runs from that app
rather than from `coord-template`. Engine upgrades are product operations —
route them through `concord`, not raw lifecycle `gov`. Check and upgrade later
by reviewing the write-free plan and applying its exact digest:

```bash
npm run concord -- upgrade --check
npm run concord -- upgrade
npm run concord -- upgrade --apply-plan <digest-from-plan>
```

From the scaffolded app root, `npm run coord-ui` launches that app's own bundled
read-only cockpit against that app's `coord/`.

**Git bootstrap is consent-based (COORD-477), and it targets `coord/` only
(COORD-631 / ADR-0008).** Your workspace container is never a Git repository —
absence is the control, not consent, so no flag initializes it — and your
product repositories are independent siblings the installer never initializes.
Git-backed governance lives in an optional independent repository at
`<workspace>/coord`. The installer performs no Git mutation by default; each
step below is a separate explicit flag, previewed in the dry-run plan's
`git_actions` section (which lists every file proposed for staging):

```bash
npx create-concord my-project --dry-run \
  --git-init --git-ignore-block --git-stage --git-baseline-commit
# review the plan (git_actions + staging allowlist), then apply its digest:
npx create-concord my-project --apply-plan <digest> \
  --git-init --git-ignore-block --git-stage --git-baseline-commit
```

`--git-init` alone leaves `coord/` an unborn repo (no commit); staging is
always the exact plan allowlist, coord-relative (never `git add .`). Sibling
product repositories and workspace container assets live outside `coord/`, so
they are not merely ignored — they are unreachable from the repository doing
the staging. If you stop before the baseline commit, `coord/scripts/gov doctor`
reports `bootstrap-pending` for `coord/` with the exact next steps, and strict
diagnostics resume after your first committed baseline.

<details><summary>Manual recovery copy (not an installer)</summary>

This last-resort procedure has no reviewed plan, consent digest, collision
inventory, backup/rollback ledger, receipt, mode verification, or artifact
integrity proof. It may omit root-level assets or future files; use npm or the
SEA binary for normal installation.

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

File tickets through governance — atomic, journaled, and validated. Do not
hand-edit `coord/board/tasks.json`; `gov` owns board state (see
`coord/AGENTS.md` and `coord/DIRECTORY.md`):

```bash
npm run gov -- file-ticket --repo X --type chore --pri P2 \
  --description "Initial project setup and governance validation. Acceptance: gov doctor reports the workspace healthy." \
  --with-prompt
```

`file-ticket` reserves the next free ticket ID under a lock, writes the row
with `Status: todo` / `Owner: unassigned`, syncs the rendered board, and prints
the new ID. `--with-prompt` also creates and registers the ticket prompt at
`coord/prompts/tickets/<ID>.md` in the same journaled mutation, copying the
description's `Acceptance:` text into the prompt's acceptance criteria. With
that text the ticket is start-ready; without it `gov start` refuses the prompt
and names what to add (author it with
`coord/scripts/gov register-prompt <ID> --body-file <file>`). Without
`--with-prompt` the ticket needs prompt coverage or a waiver before it can start.

Before submitting the first real ticket, run the closeout guide. It reports the
exact missing evidence and ready-to-paste `gov` commands instead of forcing a
new team to discover closeout ceremony by trial and error:

```bash
coord/scripts/gov guided-closeout SETUP-001
coord/scripts/gov publishability-check SETUP-001
```

## 5. Start your first governed session

The cold start is provider-neutral — one bootstrap command binds your agent
identity, runs the health check, and recommends the next governed action. It
works the same for Claude, Codex, Gemini, and plain-shell operators:

```bash
npm run agent -- bootstrap
```

In Claude Code, the `/initiate` skill wraps this same contract and adds a board
summary:

```text
/initiate
```

This will:
- Claim an agent identity (only when the session is unbound)
- Run health checks
- Recommend the next ticket

## 6. Work on a ticket

Provider-neutral path (any agent, or no AI at all):

```bash
npm run agent -- do SETUP-001      # claim + lock + isolated worktree + explain payload
# ...implement and verify...
npm run gov -- submit SETUP-001    # move to review (gates must pass)
```

Started the wrong ticket? Recover through governance — never hand-edit the
board:

```bash
npm run gov -- unstart SETUP-001   # guarded same-owner revert: doing -> todo
```

In Claude Code, the native skills wrap the same lifecycle:

```text
/planner SETUP-001     # Plan the approach
/code-writer SETUP-001  # Implement it
```

Running several tickets at once? Concord's limits apply per owner, not per
repo. See section 12 of
[coord/product/EXISTING_REPO_ADOPTION_QUICKSTART.md](coord/product/EXISTING_REPO_ADOPTION_QUICKSTART.md#12-running-tickets-in-parallel).

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
│   └── .runtime/           ← Journal/plans tracked; locks, sessions and recovery snapshots ignored
├── CLAUDE.md               ← Claude agent config
├── CODEX.md                ← Codex agent config
├── GEMINI.md               ← Gemini agent config
├── AGENTS.md               ← Shared agent policy
└── DEVELOPER_NOTE.md       ← AI development methodology guide
```
