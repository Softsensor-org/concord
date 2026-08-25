# Concord User Manual

**Concord** is the coordination and governance layer for multi-agent software
development. It gives every unit of work a governed lifecycle — claim → plan →
implement → gate → review → land — with a hash-chained journal of each supported
lifecycle operation. This manual is the end-to-end reference for installing,
configuring, operating, upgrading, and (for enterprises) rolling Concord up
across an org.

> **Scope.** Concord coordinates actions taken through `gov`. It reduces
> collisions for governed actions rather than eliminating them, its journal
> covers lifecycle operations rather than all agent activity, and its worktrees
> provide repository separation rather than process, filesystem, network,
> provider, or secret isolation. The full statement of what is implemented,
> what is planned, and where the Apache-2.0 boundary lies is in
> [README — What Concord Does and Does Not Do](README.md#what-concord-does-and-does-not-do)
> and [coord/product/PUBLIC_CLAIMS_POLICY.md](coord/product/PUBLIC_CLAIMS_POLICY.md).

> **Naming.** The product is **Concord**. It installs as the `coord/` directory
> in your repo and is driven by the `gov` CLI. This repository is the
> distributable template / donor.

- New here? Read [Part 1](#part-1--concepts) then [Part 2](#part-2--installing).
- Just want the fastest path? [QUICKSTART.md](QUICKSTART.md).
- Want the full `gov` verb list? [coord/VERB_CONTRACT.md](coord/VERB_CONTRACT.md).

---

## Table of Contents

1. [Concepts](#part-1--concepts)
2. [Installing](#part-2--installing)
3. [Configuring your workspace](#part-3--configuring-your-workspace)
4. [The governed ticket lifecycle](#part-4--the-governed-ticket-lifecycle)
5. [Working with agents (skills)](#part-5--working-with-agents-skills)
6. [What to commit vs. gitignore](#part-6--what-to-commit-vs-gitignore)
7. [Upgrading the engine](#part-7--upgrading-the-engine)
8. [Community → Enterprise](#part-8--community--enterprise)
9. [Grassroots org rollup (Enterprise)](#part-9--grassroots-org-rollup-enterprise)
10. [The read-only cockpit](#part-10--the-read-only-cockpit)
11. [Troubleshooting](#part-11--troubleshooting)
12. [Command reference](#part-12--command-reference)

---

## Part 1 — Concepts

Internalize four things before you start.

**1. The board is the source of truth.** `coord/board/tasks.json` holds every
ticket as a row (`ID`, `Repo`, `Type`, `Pri`, `Status`, `Owner`, `Description`,
`Depends On`). You author *new* rows with `gov file-ticket` (atomic, journaled);
lifecycle fields (`Status`, `Owner`, locks) are owned by `gov` — never
hand-edit the board.

**2. `gov` drives every transition.** `coord/scripts/gov` (and its product-facing
twin `coord/scripts/coord`) is the CLI. Every lifecycle move — claim, start,
submit, land — goes through it and is journaled.

**3. The journal is tamper-evident.** `coord/.runtime/governance-events.ndjson`
is a hash-chained, append-only record of the governed lifecycle operations `gov`
performs. It is committed to git; a fresh clone can verify that chain with
`gov conform` and nothing else, which is what makes governed history auditable
and portable. Its scope is the lifecycle: provider tool calls, ad-hoc shell
commands, file reads and network requests happen outside `gov` and are not in it.

**4. The engine is vendored, not a dependency.** Concord installs its engine
*into your repo* under `coord/` (the "GCV-4" model). You get offline, in-tree,
auditable operation; you upgrade explicitly with `npm run concord -- upgrade`
(a *product* operation, routed through the `concord` CLI — not a lifecycle
`gov` verb), pinned by `coord/.coord-engine.json`. There is no hidden
`node_modules` engine to drift.

```
Board (tasks.json)  ←→   gov CLI   ←→   Agent skills (/slash commands)
     source of truth      driver          ergonomic layer (call gov internally)
```

**Repo codes.** A one-letter code maps a ticket to a repo + integration branch in
`coord/project.config.js`. `B` = backend, `F` = frontend by default; `X` is
reserved for coord-only / cross-repo work. Single-repo → multi-repo is a config
change only — no engine change.

---

## Part 2 — Installing

There are two signing-free install channels. Both vendor the **same** engine
bundle in-tree; pick by whether Node is available.

### Channel A — `npx create-concord` (recommended, needs Node)

Best for developers who already run agent CLIs (Claude Code, Codex, Cursor) —
Node is already present.

```bash
# New project: review a write-free plan, then apply its digest.
npx create-concord my-project --dry-run
npx create-concord my-project --apply-plan <digest-from-plan>
cd my-project

# OR overlay onto an EXISTING repo — detects the repo shape, proposes a
# governance tier + track preset, and writes a tailored coord/project.config.js
# plus starter tickets:
cd my-existing-repo
npx create-concord . --from-existing --dry-run
npx create-concord . --from-existing --apply-plan <digest-from-plan>

# Optional operating-governance packs:
npx create-concord my-site --workflow-pack site-seo --dry-run
npx create-concord my-site --workflow-pack site-seo --apply-plan <digest-from-plan>
```

`create-concord` vendors `coord/` in-tree, pins the engine version in
`coord/.coord-engine.json`, writes the commit-vs-gitignore split and the
`coord/WORKSPACE.md` runtime guide, and wires four operator scripts into your
`package.json` with distinct ownership boundaries:

| Script | Owns |
|--------|------|
| `npm run concord` | Product operations: onboard, upgrade, conformance, governance tier. |
| `npm run gov` | Governance lifecycle + admin/break-glass: file-ticket, start, submit, land, doctor. |
| `npm run agent` | The thin provider-neutral operator facade (`bootstrap`, `next`, `do`, `check`, …); orchestrates `gov`, never duplicates lifecycle logic. |
| `npm run coord-ui` | The read-only cockpit; never writes governed state. |

Flags:

| Flag | Effect |
|------|--------|
| `--from-existing` | Run shape-detecting onboarding (tier + preset + starter tickets) instead of a fresh board. |
| `--dry-run` | Print the deterministic plan and write no target bytes. |
| `--apply-plan <digest>` | Apply only the previously reviewed plan digest. |
| `--channel <c>` | Distribution channel to pin (default `community`). |
| `--workflow-pack <id[,id]>` | Copy optional operating-governance templates into the workspace. Current pack ids: `site-seo`, `daily-analytics`, or `all`. |

Workflow packs add files such as `00-ops/seo`, `00-ops/data`,
`00-ops/utilities`, and `data/raw` / `data/clean` templates. They are operating
contracts first, not engine-enforced validators by default. See
`coord/product/workflow-packs/README.md` after install.

### Channel B — standalone Linux binary (no Node required *to install*)

Best for the environments where agents actually run and Node isn't guaranteed:
devcontainers, WSL2, remote/SSH boxes, CI runners, minimal images. The binary is
a single self-contained executable (Node SEA) that carries the engine bundle
inside it — it **installs** with **zero Node on `PATH`**.

Scope of the claim (COORD-481): the binary hosts only the install-time commands
`init` / `create` / `recover`. It does **not** host the operational surface. The
workspace it lays down is the vendored Node engine, so everything you run
afterwards — `npm run gov` (lifecycle), `npm run concord` (product ops),
`npm run agent`, `npm run coord-ui` — requires **Node >= 22.8** on the box. Use
the binary to bootstrap a Node-less image; install Node before operating
governance there.

```bash
# Download concord-linux-<arch> from the GitHub Release, then:
chmod +x concord-linux-x86_64
./concord-linux-x86_64 init my-project     # or: init .  (current repo)
./concord-linux-x86_64 init my-site --workflow-pack site-seo
```

The result is byte-identical to the `npx` scaffold (same vendored bundle).

### Manual recovery copy (not an installer)

If you have neither npm nor the binary, you can recover a minimal command
surface by copying selected files from a trusted source checkout. This is **not**
the transactional installer: it has no reviewed plan, consent digest, collision
inventory, backup/rollback ledger, receipt, mode verification, or artifact
integrity proof, and it may omit root-level assets or future files. Prefer npm or
the SEA binary for every normal installation.

```bash
cp -R /path/to/coord-template/coord   ./coord
cp -R /path/to/coord-template/.claude ./.claude
cp /path/to/coord-template/CLAUDE.md  ./CLAUDE.md
cp /path/to/coord-template/AGENTS.md  ./AGENTS.md
node coord/scripts/coord-cli.js init
```

---

## Part 3 — Configuring your workspace

After install you have a `coord/` layer beside (or containing) your product repos.

### The one file you edit: `coord/project.config.js`

It maps repo **codes** to paths + integration branches. This is config-as-code —
review it, then commit it through the normal governed lane.

```js
// coord/project.config.js
module.exports = {
  coordTicketPrefix: "COORD",
  repos: {
    B: {
      path: "backend",
      integrationBranch: "main",
      ticketPrefixes: ["MSRV"],   // optional: prefixes that route to this repo
      testCommand: "npm test",
    },
    F: {
      path: "frontend",
      integrationBranch: "main",
      testCommand: "npm test",
    },
    // Add another repo — no engine change needed:
    // A: { path: "api", integrationBranch: "main" },
  },
};
```

> `repos` is an **object** keyed by repo code. `X` is reserved for coord-only /
> cross-repo work and must not appear in `repos`.

If you used `npx create-concord . --from-existing`, onboarding already wrote a
tailored `project.config.js` and a `setup.decisions.json` for you — just review
them.

### Point Concord at your requirements (optional but recommended)

`coord/product/` has stub files. Fill in the ones relevant to you, or make them
pointers to your existing PRD/URS/architecture source:

- `coord/product/REQUIREMENTS.md` — PRD/URS or a link to the source of truth.
- `coord/product/ARCHITECTURE.md` — architecture decisions and constraints.
- `coord/product/REPOS.md` — repo map + ownership.

The goal is traceability: requirement → ticket → plan → gate evidence → review →
closeout.

### Governance tiers

Concord supports `lite`, `standard`, and `full` tiers (progressively more gates).
The default is `full`; onboarding may suggest a lighter tier for a small repo.
Inspect and set with:

```bash
npm run concord -- governance-tier          # show the resolved tier + what it requires
npm run concord -- track-presets            # web/data/content/infra presets
```

---

## Part 4 — The governed ticket lifecycle

```
todo → doing (gov start) → review (gov submit) → done (gov land)
```

Each transition is gated. `gov start` cuts a per-agent worktree and locks the
ticket; `gov submit` requires passing gates + a plan record; `gov land` requires
a completed review cycle. Every event is journaled.

### 1. Create a ticket

File tickets through governance — atomic, journaled, validated, and it reserves
the next free ID under a lock. Do not hand-edit `coord/board/tasks.json`; `gov`
owns board state:

```bash
npm run gov -- file-ticket --repo B --type feature --pri P1 \
  --description "Add user authentication endpoint."
```

Add `--with-prompt` to create and register the start-ready ticket prompt at
`coord/prompts/tickets/<ID>.md` in the same journaled mutation.

### 2. Start it

```bash
npm run gov -- start MYAPP-001      # claim + lock + cut an isolated worktree
```

> **Run governed mutations from the repo root** — the canonical integration tree,
> where `.git` is a directory. `gov` refuses mutations from a linked worktree.
> Read-only commands (`explain`, `conform`, heartbeat) work anywhere.

### 3. Do the work, then submit

```bash
npm run gov -- submit MYAPP-001     # move to review (gates must pass)
```

### 4. Review and land

After a review cycle is recorded:

```bash
npm run gov -- land MYAPP-001       # merge + close
```

Stuck on what closeout evidence is missing? Ask for the exact gaps and
ready-to-paste commands:

```bash
npm run gov -- guided-closeout MYAPP-001
npm run gov -- publishability-check MYAPP-001
```

### Session discipline

- **One ticket per session.** Don't chain tickets in one conversation — stale
  context degrades quality.
- **Don't run multiple governed agents from one shared checkout.** `gov start`
  cuts a worktree per ticket; a second heartbeat-fresh session bound to the same
  checkout is refused. For a fleet, see
  [coord/docs/FLEET_GOLDEN_PATH.md](coord/docs/FLEET_GOLDEN_PATH.md).

---

## Part 5 — Working with agents (skills)

Skills are slash commands (in `.claude/commands/`) that run multi-step governed
workflows. They call `gov` internally — they're the ergonomic layer, not a
bypass. Codex, Gemini, and shell-only operators get the same cold-start via the
provider-neutral facade: `npm run agent -- bootstrap` (see `CODEX.md` /
`GEMINI.md`). The essentials:

| Skill | When |
|-------|------|
| `/initiate` | Start of every session — claims identity, health check, board summary. |
| `/next` | "What should I work on?" |
| `/planner <ticket>` | Validate scope + write the plan before implementing. |
| `/code-writer <ticket>` | Implement → gate → submit → land. |
| `/code-reviewer <ticket>` | Review another agent's submission. |
| `/resume <ticket>` | Pick up an in-flight ticket in a new session. |
| `/orchestrator status` | Board overview — active work, blockers, queue. |
| `/qa-review [scope]` | Full multi-perspective QA audit. |

The full skill catalogue (quality, governance, track, and operations skills) is
in the [README](README.md#agent-skills-reference).

---

## Part 6 — What to commit vs. gitignore

The scaffolder writes `coord/.gitignore` with the correct split; this is the
contract that makes a fresh clone verifiable.

**Commit** (the durable governed record):

- `coord/board/tasks.json` — the board.
- `coord/.runtime/governance-events.ndjson` — the hash-chained journal.
- `coord/.runtime/plans/` — per-ticket plan + closeout records.
- `coord/project.config.js` — your repo map.
- `coord/product/`, decisions, and rendered artifacts.

**Gitignore** (ephemeral, per-machine, regenerable):

- `coord/.runtime/locks/`, `snapshots/`, `sessions/`, `*.lock`.
- `coord/.worktrees/`.

**The fresh-clone check.** The tested invariant is that a clone carrying only the
committed artifacts passes `board.js validate` + `gov conform` with no ephemeral
state present. It is a check you run, not a promise the software makes; if you
suspect the commit-vs-gitignore split has regressed, run it: 

```bash
bash release/verify-fresh-clone.sh    # donor repos; validates the committed tree
```

Adopters run the same check — validate any clean clone of your own repo.

---

## Part 7 — Upgrading the engine

The vendored engine is upgraded explicitly, never silently. `coord/.coord-engine.json`
records **where** your engine came from (version / channel / ref / sha);
`coord/engine-pin.json` fingerprints the in-tree surface for **integrity**.

### Legacy bootstrap

For a pre-COORD-451 installation, the in-tree updater cannot provide automatic
resolution because that code is not installed yet. Obtain `concord-bootstrap.js`
from an immutable Community release commit (or the entitled Enterprise channel),
review it, and run:

```bash
node concord-bootstrap.js upgrade --target .
node concord-bootstrap.js upgrade --target . --apply-plan <digest-from-plan>
```

This bootstrap is independent of the installed engine. It identifies an absent
upstream pin as `unpinned` rather than file drift, detects the installed edition,
downloads an immutable source SHA into temporary storage, checks archive path and
link containment, runs the legacy `--from ... --dry-run` preview, and applies only
when the recomputed digest matches. It then invokes engine verification and writes
a mode-0600 receipt under `coord/.runtime/upgrade-receipts/`. A requested channel
that conflicts with the installed surface is refused; Enterprise requires an
entitlement token.

```bash
# Check for drift (read-only): is the vendored engine surface untouched?
npm run concord -- upgrade --check

# Resolve the configured channel to an immutable upstream commit and print a
# write-free plan. Review the paths and retain the digest it prints:
npm run concord -- upgrade

# Re-resolve the source and apply only if the upstream SHA and every before/after
# file hash still produce the reviewed digest:
npm run concord -- upgrade --apply-plan <digest-from-plan>

# Offline/operator-supplied source remains supported:
npm run concord -- upgrade --from <bundle-or-dir>
```

Automatic resolution reads the repository and channel from
`coord/.coord-engine.json`, resolves the channel head to an immutable Git commit,
downloads that exact archive into OS temporary storage, and rejects traversal,
absolute-path, symlink, and hard-link archive entries. Planning does not write to
the project. Applying rechecks the digest, diffs the source engine surface,
backs up every file it will write, applies only engine-managed paths,
**preserves your board / journal / plans / project.config / product docs and Git
state untouched**, re-pins, verifies, and writes a redacted receipt under
`coord/.runtime/upgrade-receipts/`. If verification fails it rolls back to the
exact pre-upgrade bytes and exits non-zero. Upgrading to the same version is a
no-op.

`upgrade --check` distinguishes **engine drift** (a vendored file was hand-edited
— fix it or re-apply) from **project drift** (changes to *your* board / config /
product — expected, never flagged).

---

## Part 8 — Community → Enterprise

The Enterprise engine is Community **plus** an additive enterprise scripts subtree
(org collector, rollup, command-center, RBAC/broker) — not a fork. Both
share the exact same board / journal / plan / config data model, so upgrading is
**in-place** and preserves your entire governed history.

```bash
# Licensed, fail-closed: requires an entitlement token.
npm run concord -- upgrade --from <enterprise-bundle> \
  --channel enterprise --entitlement <token>
# (or set CONCORD_ENTITLEMENT in the environment)
```

This fetches the enterprise bundle, applies only engine-managed paths (now a
superset that includes the enterprise subtree), preserves board + journal + plan
records + decisions + `project.config`, runs migrations + the governance suite,
and flips `.coord-engine.json` channel `community → enterprise` in one commit. No
re-scaffold, no data migration.

Without a valid entitlement token the switch is refused — a Community repo cannot
silently pull the private enterprise surface.

---

## Part 9 — Grassroots org rollup (Enterprise)

*Enterprise tier only.* The "start on a few teams, adopt org-wide later" path.
Because every board's board + journal + plan records are git-committed,
tamper-evident artifacts, an org can **discover and verify** teams' Community
boards centrally **without any team re-doing anything or upgrading** — read-only.

The `discover-boards` CLI ships in the Enterprise cut (run it with `node` from the
enterprise scripts subtree). It:

- **Discovers + verifies (READ-ONLY):** scans a directory tree (or an opt-in
  register) for coord boards and reports each board's engine version, channel,
  governance tier, ticket count, and retroactive conformance — running each
  board's OWN vendored `conform`, so a drifted engine shows rather than hides.
- **Collects + rolls up:** with `--collect`, ingests the discovered boards into
  the org warehouse and prints the first central, hash-chain-verified rollup.

```text
discover-boards <org-checkouts-dir>                       # discover + verify
discover-boards --register org-boards.json --json         # from an opt-in register
discover-boards <org-checkouts-dir> --collect --warehouse org.db   # + rollup
```

`--register` accepts a JSON file (a bare array of roots, `{ "roots": [...] }`, or
`{ "boards": [{ "path": "..." }] }`). Teams don't upgrade to be *seen*; they
enroll ([Part 8](#part-8--community--enterprise)) to get *enforcement* — RBAC,
central policy, the write service — going forward.

> **Maturity.** This is the CLI slice. The hosted, auto-discovering plane (a
> GitHub App that scans an org over the API and manages read access) is the T1–T5
> `PER_ORG_DEPLOYMENT_SPEC` work still in progress.

Exact invocation + the full flow are in the `DISCOVER_BOARDS` guide shipped with
the Enterprise distribution.

---

## Part 10 — The read-only cockpit

A web cockpit renders any workspace's board read-only — evidenced tickets, review
cycles, gate results, requirement traceability, and the event timeline.

```bash
# In a scaffolded app:
npm run coord-ui

# See the bundled demo first:
npm --prefix frontend/apps/coord-ui install && npm --prefix frontend/apps/coord-ui run demo

# Point it at your own workspace:
cd frontend/apps/coord-ui
COORD_DIR=/abs/path/to/your/coord npm run dev
```

---

## Part 11 — Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `gov` refuses a mutation from a worktree | You're in a linked worktree. Run governed writes from the **repo root** (canonical tree). |
| "cannot start without prompt coverage or a recorded waiver" | Record a waiver (`gov set-waiver <ticket> --reason "…"`) or add prompt coverage, then `gov start`. |
| Ambiguous session identity / churned claims | Multiple sub-agents share one Anthropic session id. Export a distinct `COORD_SESSION_ID` per sub-agent (not `CLAUDE_SESSION_ID`). |
| `upgrade --check` reports engine drift | A vendored (manifest-tracked) file was hand-edited. Revert it, or re-apply the engine with `npm run concord -- upgrade`. |
| Fresh clone fails `validate`/`conform` | An ephemeral file was committed, or a durable one was gitignored. Re-check the [commit split](#part-6--what-to-commit-vs-gitignore); run `verify-fresh-clone.sh`. |
| Stale lock after a crash | `gov doctor` diagnoses; `gov unstart <ticket>` (same owner, no committed work) or `/recover <ticket>` repairs. |
| `--channel enterprise` refused | Enterprise is licensed. Pass `--entitlement <token>` or set `CONCORD_ENTITLEMENT`. |

Run `gov doctor` first for any "governance feels stuck" situation — it reports
stale locks, drift, and missing gates with next-step commands.

---

## Part 12 — Command reference

Four entry points, four ownership boundaries: `npm run gov -- <cmd>`
(governance lifecycle + admin), `npm run concord -- <cmd>` (product ops),
`npm run agent -- <verb>` (provider-neutral operator facade), and
`npm run coord-ui` (read-only cockpit). Most-used verbs:

### Operator facade (provider-neutral)

| Command | What it does |
|---------|--------------|
| `agent bootstrap` | Cold start: bind identity, run the health check, recommend the next governed action. |
| `agent next` | Next recommended ready ticket. |
| `agent do <ticket>` | Create/refresh the governed execution context and return the explain payload. |
| `agent check [<ticket>]` | Governance health (`gov doctor`), optionally ticket-scoped. |

### Board & session

| Command | What it does |
|---------|--------------|
| `gov list` | Show all tickets and status. |
| `gov explain <ticket>` | Full ticket state: status, owner, plan, gates, blockers. |
| `gov doctor` | Diagnose governance health. |
| `gov conform` | Verify the journal hash-chain (READ-ONLY). |

### Lifecycle

| Command | What it does |
|---------|--------------|
| `gov file-ticket --repo <c> --type <t> --pri <P#> --description "…"` | File a backlog ticket (atomic, journaled). |
| `gov start <ticket>` | Claim + lock + cut worktree. |
| `gov submit <ticket>` | Move to review (gates must pass). |
| `gov land <ticket>` | Merge + close. |
| `gov unstart <ticket>` | Return to todo (same owner, no work committed). |
| `gov heartbeat <ticket>` | Refresh a doing lock (keep-alive). |
| `gov guided-closeout <ticket>` | Exact closeout gaps + fix commands. |

### Engine & packaging

| Command | What it does |
|---------|--------------|
| `concord upgrade --check` | Report engine drift vs the pin (READ-ONLY). |
| `concord upgrade --from <src>` | Apply a new engine version; re-pin + verify; rollback on failure. |
| `concord upgrade --from <src> --channel enterprise --entitlement <tok>` | In-place Community → Enterprise. |

### Enterprise org rollup (Enterprise cut)

| Command | What it does |
|---------|--------------|
| `discover-boards <root>…` | Discover + verify grassroots boards (READ-ONLY). |
| `discover-boards <root>… --collect --warehouse <db>` | Ingest → warehouse → org rollup. |

The complete verb contract is in
[coord/VERB_CONTRACT.md](coord/VERB_CONTRACT.md).

---

## Further reading

| Document | When to read it |
|----------|-----------------|
| [QUICKSTART.md](QUICKSTART.md) | The fastest first-run path. |
| [README.md](README.md) | Overview, mental model, full skill catalogue. |
| `coord/WORKSPACE.md` | The in-tree runtime contract — written into every scaffold (present in your workspace after install). |
| [coord/GOVERNANCE.md](coord/GOVERNANCE.md) | The canonical policy — authority order, lifecycle rules. |
| [coord/docs/GCV4_ENGINE_CONFIG_SEAM.md](coord/docs/GCV4_ENGINE_CONFIG_SEAM.md) | The vendored-engine + upgrade design of record. |
| [coord/docs/FLEET_GOLDEN_PATH.md](coord/docs/FLEET_GOLDEN_PATH.md) | Running many humans + agents. |
| [DEVELOPER_NOTE.md](DEVELOPER_NOTE.md) | AI-assisted development methodology + cost management. |

---

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Softsensor-org.
