# Softsensor Concord

**The coordination and governance layer for multi-agent software development.**

Claude Code, Codex, Cursor, and human engineers can work on the same codebase in parallel through one governed lifecycle: claim → plan → implement → gate → review → land. Each unit of work gets an owner, a lock, its own Git worktree, and a hash-chained journal entry for every lifecycle transition — so parallel work is coordinated rather than accidental, and who changed what is recoverable afterwards.

Concord coordinates the actions that go **through** it. It does not stop an agent or a human with local access from editing files, running git, or calling a provider outside governance — it makes those bypasses visible rather than impossible. See [What Concord does and does not do](#what-concord-does-and-does-not-do).

Apache-2.0 · [Quickstart](QUICKSTART.md) · [User Manual](USER_MANUAL.md) · [Known Issues](KNOWN_ISSUES.md) · [Changelog](CHANGELOG.md)

> **Names:** the product is **Concord**. It installs as the `coord/` directory and is driven by the `gov` CLI (`coord/scripts/gov`). This repository is the distributable template.

---

## The Problem It Solves

When multiple agents (or humans and agents) work in the same repo concurrently:

- Branches get stomped or go stale
- No one knows who owns what or whether work was reviewed
- Quality gates get bypassed or forgotten
- There's no audit trail when something breaks

Concord addresses this by adding a **governed execution layer** on top of your existing repos, CI, and ticketing system — without replacing any of them.

---

## What Concord Does and Does Not Do

Concord is local-first developer tooling under the Apache License 2.0. This
section states the boundary precisely so you can decide what it is worth to you.
The wording rules behind it are in
[coord/product/PUBLIC_CLAIMS_POLICY.md](coord/product/PUBLIC_CLAIMS_POLICY.md).

**What it does, as implemented and covered by the shipped test suite:**

- **Coordinates governed actions.** One owner per in-flight ticket, a lifecycle
  lock per ticket, a per-ticket Git worktree, gates that must pass before
  `gov submit`, and a review cycle that must exist before `gov land`. Governance
  refuses a second heartbeat-fresh session bound to the same checkout.
- **Records supported lifecycle operations.** `coord/.runtime/governance-events.ndjson`
  is an append-only, hash-chained journal of the lifecycle verbs Concord runs
  (`start`, `commit`, `submit`, `land`, `heartbeat`, findings, …). A break in the
  chain is detectable by `gov conform`.
- **Keeps evidence with the work.** Plan records, requirement closure, repo-gate
  results, review cycles and feature proofs are stored per ticket and exported
  with a control map.
- **Verifies its own integrity.** `coord/engine-pin.json` fingerprints the
  installed engine surface, and `gov verify-engine` reports drift against it.

**What it does not do:**

- **It does not eliminate collisions.** It reduces them for actions taken through
  `gov`. Two people editing the same file outside governance, a `git push --force`,
  or an agent writing to a path it does not own will still conflict. Concord is
  designed so that such a conflict is visible after the fact, not prevented.
- **Worktrees give repository separation, not isolation.** A worktree is a second
  checkout of the same repository. It is not an OS process, filesystem, network,
  provider, or secret boundary; an agent running in a worktree can read the rest
  of the machine exactly as your shell can.
- **The journal is not a complete activity record.** It covers Concord lifecycle
  operations. Provider tool calls, arbitrary shell commands, file reads, and
  network requests are outside it, and no shipped Concord version observes them.
- **It does not manage your secrets.** Concord does not require secrets in
  governance artifacts, and the release build refuses to ship secret-shaped
  payload paths. What an agent can reach at runtime is decided by your
  environment and your provider configuration, not by Concord.
- **It does not stop a determined bypass.** Anyone with local access can edit
  files, run git, or call a provider directly. Governance state is designed to
  make that detectable — through the hash-chained journal, the single-writer
  guard, and engine-pin drift — not to make it unavailable.

**Planned, and not implemented in this release.** Do not plan around these; they
are backlog items with no shipped behavior:

- managed auto-mode profiles and provider-side action interception;
- local containment controls (protected roots, worktree-only writes,
  environment filtering, network/egress policy);
- a redacted action ledger covering non-lifecycle agent activity;
- hosted or multi-tenant operation of the cockpit.

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

Each transition is gated: `gov start` cuts a per-agent worktree and locks the ticket; `gov submit` requires passing gates and a plan record; `gov land` requires a completed review cycle. The journal records each of these supported lifecycle operations — not every provider tool call, shell command, file read, or network request the agent makes.

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

**Two-step reviewed install — no global install:**

```bash
# New project: first print a write-free plan, then apply that exact digest.
npx create-concord my-project --dry-run
npx create-concord my-project --apply-plan <digest-from-plan>
cd my-project

# OR overlay onto an EXISTING workspace — the reviewed install plan also
# applies the deterministic onboarding config/decision/receipt transaction.
# Starter tickets remain proposed-only and are not filed without a separate
# explicit --approve-starters decision:
cd my-existing-repo
npx create-concord . --from-existing --dry-run
npx create-concord . --from-existing --apply-plan <digest-from-plan>
```

No Node on the box (devcontainer, WSL, CI, minimal image)? When a release
publishes the standalone **Linux binary** asset, it performs the install with no
Node on `PATH` (it hosts `init` / `create` / `recover` only). The workspace it
scaffolds is the vendored Node engine: **operating** it afterwards (`npm run gov`,
`npm run concord`, `npm run agent`, `npm run coord-ui`) requires Node >= 22.8.
The binary is built from the same verified cut as the npm package; check the
release page for whether the asset is present for the version you want.

```bash
./concord-linux-x86_64 init . --dry-run
./concord-linux-x86_64 init . --apply-plan <digest-from-plan>
```

`create-concord` vendors `coord/`, pins the engine in `coord/.coord-engine.json`,
writes the commit-vs-gitignore split + the `coord/WORKSPACE.md` runtime guide, and
wires the four operator scripts with documented ownership boundaries:
`npm run concord` (product ops: onboard/upgrade/conformance), `npm run gov`
(governance lifecycle + admin), `npm run agent` (the provider-neutral operator
facade), and `npm run coord-ui` (read-only cockpit). Engine upgrades route
through `concord` — a product operation, not a lifecycle `gov` verb. Upgrade
later with an inspected, digest-bound plan:

```bash
npm run concord -- upgrade --check
npm run concord -- upgrade
npm run concord -- upgrade --apply-plan <digest-from-plan>
```
The upgrade plan binds the immutable release, target engine hashes, and current
upstream-pin bytes. Apply holds one target lock through verification and receipt
publication. On POSIX it also copies and verifies executable modes; on Windows
POSIX execute-bit enforcement is skipped. A file retired from the new managed
manifest is removed only if its live bytes still match the old manifest, so a
locally changed retired path is refused rather than deleted. Interrupted applies
retain a local recovery journal and are reconciled before the next upgrade.
See [Installer behavior and risk boundary](coord/docs/INSTALLER_BEHAVIOR.md).

Need a last-resort recovery copy? See the [User Manual](USER_MANUAL.md#manual-recovery-copy-not-an-installer).
It is not equivalent to either transactional installer.

After scaffolding an app, launch that app's own cockpit from the app root:

```bash
npm run coord-ui
```

### Legacy installation bootstrap

Installations that predate automatic release resolution cannot update themselves
with a command they do not yet contain. Download `concord-bootstrap.js` from an
immutable Concord commit, inspect it, then run it outside the vendored engine:

```bash
node concord-bootstrap.js upgrade --target .
node concord-bootstrap.js upgrade --target . --apply-plan <digest-from-plan>
```

The bootstrap detects `community` versus `enterprise` from the pin and installed
surface, refuses conflicting edition evidence, requires Enterprise entitlement,
and delegates to the legacy `coord-cli.js upgrade --from` only after the source
SHA and target-state digest still match. The direct Node CLI is canonical;
`npm run concord` is an installer-provided convenience alias.

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
# Provider-neutral (Claude, Codex, Gemini, or plain shell):
npm run agent -- bootstrap

# In Claude Code the /initiate skill wraps the same contract:
/initiate
```

This claims an agent identity (only when the session is unbound), runs health checks, and recommends the next governed action.

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

File tickets through governance — atomic, journaled, and validated. Do not hand-edit `coord/board/tasks.json`; `gov` owns board state:

```bash
coord/scripts/gov file-ticket --repo B --type feature --pri P1 \
  --description "Add user authentication endpoint."
```

`file-ticket` reserves the next free ID under a lock, writes the `todo` / `unassigned` row, and syncs the rendered board. Add `--with-prompt` to create and register the start-ready ticket prompt in the same journaled mutation.

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
| `gov file-ticket --repo <c> --type <t> --pri <P#> --description "..."` | File a backlog ticket (atomic, journaled) |
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

Concord is an overlay — your repos, CI, tickets, and PRD/URS artifacts stay exactly where they are. Review the write-free plan before applying it:

```bash
cd my-existing-repo
npx create-concord . --from-existing --dry-run
npx create-concord . --from-existing --apply-plan <digest-from-plan>
```

This reads only an allowlisted metadata surface, records explicit repo/branch,
tier, phase, track and gate decisions, and writes a tailored
`coord/project.config.js`, `coord/setup.decisions.json`, and
`coord/onboarding.receipt.json` in the install transaction. It previews three
starter-ticket proposals but does not file them unless an operator separately
reviews the onboarding digest and passes `--approve-starters`; filed items enter
as `proposed`, never directly as schedulable `todo` work.

### What to configure

| File | What to do |
|------|-----------|
| `coord/project.config.js` | Set repo codes, paths, and integration branches |
| `coord/product/REPOS.md` | Update repo descriptions to match |
| `coord/product/REQUIREMENTS.md` | Link or paste your PRD/URS (or leave as a pointer) |
| `coord/product/ARCHITECTURE.md` | Link or paste your architecture doc |
| `coord/board/tasks.json` | Replace seed backlog with your first tickets (file them via `gov file-ticket`) |
| `CLAUDE.md` | Keep thin — just point at `coord/GOVERNANCE.md` |

### What NOT to do

- Do not hand-edit `Status`, `Owner`, or lock fields in `tasks.json` after the initial setup — `gov` owns those.
- Do not edit files under `coord/rendered/` — they're auto-generated.
- Do not edit `.runtime/` files — those are live governance state.

### MCP integrations (optional)

The shipped `.mcp.json` contains only the local `governance` server and performs
no package installation or external connection. Sentry and Datadog are explicit
opt-ins; see `coord/docs/MCP_CONFIGURATION.md` for the credential-gated,
version-pinned Sentry example and vendor-supported Datadog setup.

The built-in `governance` MCP server works out of the box — it exposes typed governance tools without shelling out. It speaks standard MCP stdio (newline-delimited JSON-RPC; protocol on stdout, diagnostics on stderr). Note: Claude requires a one-time per-project approval of `.mcp.json` servers — if the `governance` server does not appear in a conversation even though `node coord/scripts/governance-mcp.js` handshakes fine, approve the server in the project's MCP settings; that is an approval issue, not a transport failure (troubleshooting split in `coord/scripts/README.md`).

---

## Directory Layout

```
your-project/
├── .claude/
│   ├── commands/           ← 27 governance + specialist skills
│   └── skills/             ← 5 operations skills
├── .mcp.json               ← local-only governance MCP config
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
| [coord/product/PUBLIC_CLAIMS_POLICY.md](coord/product/PUBLIC_CLAIMS_POLICY.md) | How these documents word capability claims, and what is implemented vs planned |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Current issues, status, and workarounds |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [DEMO.md](DEMO.md) | Walkthrough of the bundled demo |

---

## Editions

Concord comes in two editions:

- **Community (this repository)** — free and open source. The full per-team
  governed workflow: a shared board, per-ticket worktrees, lifecycle locks,
  evidence-gated review, and a read-only local cockpit. A single team can run
  Concord this way for free, indefinitely. That the Community edition stays open
  source is a governance commitment — see [GOVERNANCE.md](./GOVERNANCE.md) for how
  that is decided. The terms themselves are stated once, in the
  [License](#license) section below.
- **Enterprise** — for organizations adopting multi-agent development across many
  teams and repositories. Softsensor helps enterprises adopt multi-agent
  development at scale, with org-wide governance and support. If that's you, get
  in touch with the Softsensor team.

## Contributing

Contributions are welcome and entirely voluntary — you are never obligated to
send your changes upstream. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
fork-and-pull-request flow and the DCO sign-off, [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
for community expectations, and [GOVERNANCE.md](./GOVERNANCE.md) for how
decisions are made. What this software's terms do and do not cover — including
use of the Concord name and logo — is stated once, in the
[License](#license) section below.

## Status and scope

Concord ships the repo-local governed workflow that exists today, including the
packaged `coord` CLI:

- **Packaged product CLI (`coord`)** — `coord init` (idempotent, no-clobber
  bootstrap into a governed-board layout), `coord conformance` (one-shot,
  fail-closed conformance / attestation check), and `coord upgrade` (managed
  engine-upgrade automation that re-pins, verifies, and rolls back on failure)
  all ship today. The packaged-installer / managed-upgrade gap is closed; see
  [QUICKSTART.md](./QUICKSTART.md) to get started.
- **Runtime evidence (`gov` receipts)** — governed, journaled receipts for
  *live/runtime* operations: production-MCP reads, bootstrap/backfill jobs, and
  deployments, with `gov verify` / `gov falsify` and deploy-identity checks.
  Receipt-writing is mutation-gated and real receipts are gitignored
  (`coord/evidence/**`), so they never ship. This extends the tamper-evident
  audit trail from code work to deploy/production operations.

A few things remain intentionally out of scope for the Community edition:

- **Hosted / multi-tenant UI** — the `coord-ui` cockpit is a read-only **local**
  surface, not a hosted service.
- **Live enterprise deployment** — standing the central server up inside a
  customer's boundary (behind their SSO, against a production datastore) is the
  explicit config / runtime boundary; it is not a turnkey live deployment.

---

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Softsensor-org.

### License boundary

The [LICENSE](./LICENSE) file is the whole agreement for this software. Reading
this repository, running it, or reading any report it produces adds nothing to
it — there are no separate click-through terms.

- Apache-2.0 Section 7 supplies the AS-IS disclaimer and Section 8 the limitation
  of liability. Nothing in this documentation adds a warranty, a certification, a
  support commitment, a service-level commitment, an indemnity, or a promise about
  how an AI agent will behave.
- Verification output — `gov conform`, `gov verify-engine`, gate results, the
  evidence export and its control map — is a **technical observation about the
  bytes and state on your machine at the moment it ran**. It is evidence you can
  re-run and inspect, not an attestation by Softsensor about your system, and it
  is not a compliance certification for any framework it maps to.
- The Apache-2.0 grant covers this software. It does not extend to the Concord
  name or logo — see [TRADEMARK.md](./TRADEMARK.md).

How capability claims in these documents are worded, and how that wording is
enforced at release time, is described in
[coord/product/PUBLIC_CLAIMS_POLICY.md](coord/product/PUBLIC_CLAIMS_POLICY.md).
