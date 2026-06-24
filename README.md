# Softsensor Concord

**You've got Claude Code, Codex, and Cursor working across your repos — and they collide.** Branches stomped, half-finished work with no owner, flaky gates you can't trust, and no honest answer to *"which agent changed this, and was it reviewed?"*

**Concord is the coordination + governance layer for multi-agent development.** A shared, audited board where a fleet of AI agents work *without* colliding: per-ticket worktrees + lifecycle locks, track-specific proof harnesses, evidence-gated review, and a tamper-evident journal of who did what.

**See it in 2 minutes:** `npm run demo` (in `frontend/apps/coord-ui`) → open `localhost:3002` — a live cockpit of agents coordinating on a real board, with the full audit trail.

Apache-2.0 · [Quickstart](QUICKSTART.md) · [Editions](#editions) · [Known issues](KNOWN_ISSUES.md) · [Demo walkthrough](DEMO.md)

> **Naming:** the product is **Concord**. It installs as the **`coord/`** scaffold
> directory and is driven by the **`gov`** CLI (`coord/scripts/gov`). Those names
> are unchanged — `coord`/`gov` are the on-disk and command surfaces; *Concord* is
> the project. This repository is the distributable template. **New here?** Start
> with [QUICKSTART.md](QUICKSTART.md). **Upgrading?** See [CHANGELOG.md](CHANGELOG.md).
> **Contributing learnings?** See [CONTRIBUTING.md](CONTRIBUTING.md).

## Included Layout

```text
coord-template/
├── backend/      # placeholder sibling repo location
├── frontend/     # placeholder sibling repo location
└── coord/        # borrow this directory into a real project
```

## Borrowing

If you already have a project root with sibling repos, copy the `coord/` folder:

```bash
cp -R coord-template/coord /path/to/project/coord
```

Then update:
- `AGENTS.md` files if you want project-specific agent rules
- `coord/project.config.js` to set the canonical repo map
- `coord/product/REPOS.md`
- `coord/board/tasks.json`
- specification stubs in `coord/` (requirements, architecture, domain model, etc.)
- any project-specific prompts or integration notes

After tailoring it, run:

```bash
node coord/board/board.js sync
```

## Specification Stubs

The `coord/` directory includes stub templates for product, architecture, and domain specifications. Populate the ones relevant to your project before starting feature work. See `coord/README.md` for the full list.

## Agent Skills (`.claude/commands/`)

The template includes 27 slash-command skills for Claude Code (and adaptable for other agents):

### Governance & Workflow
| Skill | Command | Purpose |
|-------|---------|---------|
| Initiate | `/initiate` | Cold-start session, claim agent, health check |
| Orchestrator | `/orchestrator <action>` | Board status, pick, plan, unblock, decompose, check, takeover |
| Planner | `/planner <ticket>` | Pre-implementation design and plan seeding |
| Code Writer | `/code-writer <ticket>` | Full governed implementation (start → code → submit → land) |
| Code Reviewer | `/code-reviewer <ticket>` | Governed code review |
| Gate | `/gate <repo-name>` | Standalone quality gate execution |
| Recover | `/recover <ticket>` | Governance state repair |

### Quality & Analysis
| Skill | Command | Purpose |
|-------|---------|---------|
| Manual Tester | `/manual-tester [scope]` | Quick targeted defect discovery |
| QA Review | `/qa-review [scope]` | Full 5-perspective audit (defects, requirements, risk, regression, release) |
| Business Analyst | `/business-analyst [scope]` | Requirement traceability, acceptance criteria gaps, undocumented business rules |
| Designer | `/designer [scope]` | Design system adherence, accessibility (WCAG 2.1 AA), interaction patterns |

### Operator Verbs (high-level pipeline shortcuts)
| Skill | Command | Purpose |
|-------|---------|---------|
| Next | `/next` | Board health, active work, recommended next ticket — start here |
| Do | `/do <ticket>` | Full plan → build → ship pipeline for one ticket |
| Check | `/check` | Governance health diagnostics |
| Test | `/test` | Test gate + maturity check |
| Test Strategy | `/test-strategy` | Coverage evolution audit |
| Review | `/review <ticket>` | Self or cross-agent review (`--codex`, `--gemini`) |
| Land | `/land <ticket>` | Merge after a separate review |
| Resume | `/resume <ticket>` | Same-owner session handoff for an in-progress ticket |

### Track Skills (multi-track governance)

Beyond code, Concord uses **track-specific governed harnesses**: each work type
gets the right setup, proof artifact, gate-proc, review policy, and closeout
contract. Code work proves tests/contracts; content proves links/SEO/preview;
infra proves deployment safety; live-MCP work proves scoped, redacted receipts;
bootstrap/backfill work proves resource, idempotency, and runtime-success
evidence; data products prove data contracts, row-count reconciliation, and
lineage. The lifecycle and audit journal stay common. See the track profiles
under `coord/product/` (e.g. `CONTENT_SITE_GOVERNANCE_PROFILE.md`,
`MULTI_TRACK_GOVERNANCE_PROFILE.md`, `DATA_ANALYTICS_TRACK.md`,
`PRODUCT_ENGINEERING_TRACK.md`).

| Skill | Command | Track | Purpose |
|-------|---------|-------|---------|
| Content Edit | `/content-edit <page>` | Marketing | Plain-English content change, gated by the content gate-proc |
| SEO Check | `/seo-check [scope]` | Marketing | Run the content gate locally (HTML validity, broken links, SEO) |
| Publish | `/publish <change>` | Marketing | Gate, submit, and ship a content change |
| Data Pipeline | `/data-pipeline run\|certify` | Data & analytics | Run and certify a pipeline against its data contract |
| Data Contract | `/data-contract <output>` | Data & analytics | Author or check a per-output data contract (DQ gates) |
| Analytics Query | `/analytics-query` | Product-eng | Bounded production-MCP read with a governed receipt |
| Insight Analyst | `/insight-analyst [scope]` | Product-eng | Interpret receipted findings and route fixes |
| Live-MCP Policy | `/live-mcp-policy` | Product-eng | Show a live operation's class, scope, and approval requirement |

### Skill Workflow

```
/business-analyst <ticket>  → validate scope against requirements
/planner <ticket>           → create implementation plan
/code-writer <ticket>       → implement + submit + land
/qa-review <scope>          → full QA audit
/designer <surface>         → UX/a11y sweep
```

## Governance Enhancements

The governance system includes these learned improvements from production use:

### Code Writer Skill
- Reads planner output from `coord/active/<ticket>.md` to avoid redundant context gathering
- Rebases worktree onto `origin/dev` after `gov start` to avoid stale base branch
- Uses batch `set-review-cycles` instead of individual `add-review-cycle` calls (avoids silent dedup trap)

### Orchestrator Skill
- Includes `takeover <ticket>` action for claiming and inspecting another agent's in-progress work
- Force-claims, inspects worktree state, reads plan, reports progress and remaining work

### Known issues

Known CLI issues, their status, and workarounds are tracked in
**[KNOWN_ISSUES.md](./KNOWN_ISSUES.md)** — including the multi-agent topology fix
(COORD-015), `gov start` fresh-base resolution (COORD-125), baseline-aware
"ratchet" gating (COORD-126), and the concurrent-agent journal recovery path
(`gov repair-chain`, COORD-124).

## Operations Skills (`.claude/skills/`)

The template includes 5 operations skills for day-to-day development:

| Skill | Command | Purpose |
|-------|---------|---------|
| Deploy | `/deploy <service> --env staging` | Build, gate, and deploy services |
| Migrate | `/migrate run\|create\|status` | Database migration management |
| Seed Data | `/seed-data <repo-name>` | Seed development data |
| DB Status | `/db-status` | Database health and migration state |
| Health Check | `/health-check` | Check all services across the stack |

## MCP Integrations (`.mcp.json`)

Pre-configured with codeTree, Sentry, and Datadog:

| Server | Purpose | Config needed? |
|--------|---------|----------------|
| **governance** | typed governance tools — ticket lifecycle + runtime-evidence receipts, without shelling out (receipt-writing tools are mutation-gated; read-only checks stay open) | No — works out of the box |
| **codeTree** | AST-level codebase exploration — 25x token reduction for navigation | No — works out of the box |
| **Sentry** | Error tracking, issue search, release monitoring | Yes — auth token + org + project |
| **Datadog** | Metrics, logs, APM, dashboard queries | Yes — API key + app key |

Edit `.mcp.json` and set the environment variables. Restart Claude Code after editing. Add more MCP servers as needed (GitHub, Linear, Slack, PostgreSQL, etc.).

## Developer Note

See `DEVELOPER_NOTE.md` for a comprehensive guide to the AI-assisted development methodology — covers the full workflow, governance model, multi-agent coordination, test infrastructure, CI/CD, onboarding, incident handling, cost management, and practical tips.

## Editions

Concord comes in two editions:

- **Community (this repository)** — free and open under the Apache License 2.0.
  The full per-team governed workflow: a shared board, per-ticket worktrees,
  lifecycle locks, evidence-gated review, and a read-only local cockpit. A single
  team can run Concord this way for free, indefinitely. The Community edition
  stays Apache-2.0 — see [GOVERNANCE.md](./GOVERNANCE.md).
- **Enterprise** — for organizations adopting multi-agent development across many
  teams and repositories. Softsensor helps enterprises adopt multi-agent
  development at scale, with org-wide governance and support. If that's you, get
  in touch with the Softsensor team.

## Contributing

Contributions are welcome and entirely voluntary — you are never obligated to
send your changes upstream. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
fork-and-pull-request flow and the DCO sign-off, [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
for community expectations, [GOVERNANCE.md](./GOVERNANCE.md) for how decisions
are made, and [TRADEMARK.md](./TRADEMARK.md) for use of the Concord name and logo.

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


## Notes

- The `backend/` and `frontend/` folders here are starter defaults. The canonical repo map lives in `coord/project.config.js` and `coord/product/REPOS.md`.
- The `coord/` scaffold is designed to be reusable across projects — point `coord/project.config.js` at your repos and replace the specification stubs under `coord/product/`.

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Softsensor-org.
