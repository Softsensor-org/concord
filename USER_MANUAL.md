# Concord User Manual

**Concord** is the coordination and governance layer for multi-agent software
development. It gives every unit of work a governed lifecycle — claim → plan →
implement → gate → review → land — with a tamper-evident journal of who did what
and why. This manual is the end-to-end reference for installing, configuring,
operating, upgrading, and (for enterprises) rolling Concord up across an org.

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
`Depends On`). You author *new* rows by hand; after that, lifecycle fields
(`Status`, `Owner`, locks) are owned by `gov` — never hand-edit them.

**2. `gov` drives every transition.** `coord/scripts/gov` (and its product-facing
twin `coord/scripts/coord`) is the CLI. Every lifecycle move — claim, start,
submit, land — goes through it and is journaled.

**3. The journal is tamper-evident.** `coord/.runtime/governance-events.ndjson`
is a hash-chained, append-only record of every governed event. It is committed to
git; a fresh clone can verify the entire history with `gov conform` and nothing
else. This is what makes governed history auditable and portable.

**4. The engine is vendored, not a dependency.** Concord installs its engine
*into your repo* under `coord/` (the "GCV-4" model). You get offline, in-tree,
auditable operation; you upgrade explicitly with `gov upgrade`, pinned by
`coord/.coord-engine.json`. There is no hidden `node_modules` engine to drift.

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
`coord/WORKSPACE.md` runtime guide, and wires `npm run gov` / `npm run concord`
scripts into your `package.json`.

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

### Channel B — standalone Linux binary (no Node required)

Best for the environments where agents actually run and Node isn't guaranteed:
devcontainers, WSL2, remote/SSH boxes, CI runners, minimal images. The binary is
a single self-contained executable (Node SEA) that carries the engine bundle
inside it — it scaffolds with **zero Node on `PATH`**.

```bash
# Download concord-linux-<arch> from the GitHub Release, then:
chmod +x concord-linux-x86_64
./concord-linux-x86_64 init my-project     # or: init .  (current repo)
./concord-linux-x86_64 init my-site --workflow-pack site-seo
```

The result is byte-identical to the `npx` scaffold (same vendored bundle).

### Fallback — manual copy

If you have neither npm nor the binary, copy the template tree directly:

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

Authoring a new backlog row is the one allowed hand-edit of `tasks.json`. Add a
row with `Status: todo` / `Owner: unassigned` to the right section, then sync — or
use the safe one-liner:

```bash
# Safe, atomic, journaled (recommended):
npm run gov -- file-ticket --repo B --type feature --pri P1 \
  --description "Add user authentication endpoint."

# Or hand-add the row, then:
node coord/board/board.js sync
```

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
bypass. The essentials:

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

**The fresh-clone guarantee.** A clone carrying only the committed artifacts
passes `board.js validate` + `gov conform` with no ephemeral state. If you ever
suspect the split has regressed, this proves it:

```bash
bash release/verify-fresh-clone.sh    # donor repos; validates the committed tree
```

Adopters get the same guarantee — validate any clean clone of your own repo.

---

## Part 7 — Upgrading the engine

The vendored engine is upgraded explicitly, never silently. `coord/.coord-engine.json`
records **where** your engine came from (version / channel / ref / sha);
`coord/engine-pin.json` fingerprints the in-tree surface for **integrity**.

```bash
# Check for drift (read-only): is the vendored engine surface untouched?
npm run gov -- upgrade --check

# Apply a new engine version from a release bundle/dir:
npm run gov -- upgrade --from <bundle-or-dir>
```

What `upgrade` does: diffs the source engine surface against yours, backs up every
file it will write, applies only engine-managed paths, **preserves your board /
journal / plans / project.config / product docs untouched**, re-pins, and
verifies. If verification fails it rolls back to the exact pre-upgrade bytes and
exits non-zero. Upgrading to the same version is a no-op.

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
npm run gov -- upgrade --from <enterprise-bundle> \
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
| `upgrade --check` reports engine drift | A vendored (manifest-tracked) file was hand-edited. Revert it, or re-apply the engine with `gov upgrade`. |
| Fresh clone fails `validate`/`conform` | An ephemeral file was committed, or a durable one was gitignored. Re-check the [commit split](#part-6--what-to-commit-vs-gitignore); run `verify-fresh-clone.sh`. |
| Stale lock after a crash | `gov doctor` diagnoses; `gov unstart <ticket>` (same owner, no committed work) or `/recover <ticket>` repairs. |
| `--channel enterprise` refused | Enterprise is licensed. Pass `--entitlement <token>` or set `CONCORD_ENTITLEMENT`. |

Run `gov doctor` first for any "governance feels stuck" situation — it reports
stale locks, drift, and missing gates with next-step commands.

---

## Part 12 — Command reference

`gov` and `coord` are the two entry points (`npm run gov -- <cmd>` /
`npm run concord -- <cmd>` after install). Most-used verbs:

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
| `coord upgrade --check` | Report engine drift vs the pin (READ-ONLY). |
| `coord upgrade --from <src>` | Apply a new engine version; re-pin + verify; rollback on failure. |
| `coord upgrade --from <src> --channel enterprise --entitlement <tok>` | In-place Community → Enterprise. |

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
