# Changelog

## v0.1.7 — 2026-07-04

### Added
- **One-command install (`create-concord`)** — `npx create-concord <dir>` vendors
  the engine in-tree (GCV-4), pins the version in `coord/.coord-engine.json`,
  writes the commit-vs-gitignore split + a `coord/WORKSPACE.md` runtime guide, and
  wires `npm run gov` / `npm run concord`. `--from-existing` overlays onto an
  existing repo: it detects the repo shape and writes a tailored
  `coord/project.config.js` + starter tickets via the vendored `coord onboard`.
- **Standalone Linux binary (no Node required)** — a single self-contained
  executable (Node SEA) that carries the engine bundle inside it; `concord init .`
  scaffolds a workspace with **zero Node on `PATH`** (for devcontainers, WSL2,
  remote/SSH boxes, CI runners, minimal images). Built for x64 + arm64 on tag and
  attached to the GitHub Release. No code-signing/notarization needed for Linux.
- **GCV-4 upgrade contract (`gov upgrade`)** — records the upstream pin
  `coord/.coord-engine.json` (version/channel/ref/sha), distinct from
  `engine-pin.json` (in-tree integrity). `gov upgrade --check` reports **engine
  drift** (a hand-edited vendored file) separately from **project drift** (your own
  board/config/product — never flagged). Apply preserves board/journal/plans/config
  untouched and rolls back byte-exact on verify failure.
- **In-place Community → Enterprise** — `gov upgrade --channel enterprise
  --entitlement <token>` (fail-closed without the token) applies the additive
  enterprise engine over a Community repo, preserving the entire governed history
  (board, tamper-evident journal, plan records, decisions) and flipping the pinned
  channel in one commit — no re-scaffold, no data migration.
- **Grassroots org discovery + collect/verify (Enterprise)** — a `discover-boards`
  CLI enumerates repos holding a coord board (filesystem scan or an opt-in
  register), reports each board's engine version, channel, governance tier, ticket
  count, and **retroactive conformance** (each board's own vendored `conform`, so
  drift shows), and `--collect` ingests them into the org warehouse → rollup —
  **READ-ONLY**, no team change required.
- **Fresh-clone guarantee** — `release/verify-fresh-clone.sh` (+ a push/PR CI
  workflow) proves that a clone carrying only the committed governance artifacts
  (board + hash-chained journal + plan records) passes `board.js validate` +
  `gov conform` with no ephemeral state.
- **`USER_MANUAL.md`** — an end-to-end adopter reference (install channels, config,
  the governed lifecycle, upgrade, Community→Enterprise, org rollup, cockpit,
  troubleshooting, command reference).

### Changed
- **README install path** — leads with `npx create-concord` (+ `--from-existing`)
  and the standalone Linux binary; the `cp -R` scaffold is now a documented
  fallback. `coord/QUICKSTART.md` modernized to match.

### Fixed
- README `project.config.js` example corrected from the stale array form to the
  real object form (`repos: { B: {…} }`).

## v0.1.6 — 2026-06-24

### Added
- **Multi-track governance** — the governed lane now extends beyond code to
  non-code work via per-track gate-procs and skills:
  - **Marketing/content track** — content gate-proc (HTML validity + broken-link
    + SEO checks) and skills `/content-edit`, `/seo-check`, `/publish`.
  - **Data & analytics track** — a data-contract gate-proc (per-output contracts
    with hard-fail DQ gates: reconcile tolerance, baseline band, key-coverage) and
    skills `/data-pipeline`, `/data-contract`.
  - **Product-engineering track** — an evidence-only gate plus skills
    `/analytics-query`, `/insight-analyst`, `/live-mcp-policy` (bounded
    production-MCP reads with governed receipts).
  - Track → review-policy + RBAC posture mapping, a track registry, and
    borrowable profiles documented under `coord/product/`
    (`MULTI_TRACK_GOVERNANCE_PROFILE.md`, `CONTENT_SITE_GOVERNANCE_PROFILE.md`,
    `DATA_ANALYTICS_TRACK.md`, `PRODUCT_ENGINEERING_TRACK.md`).
- **Governed memory layer** — a deterministic, source-cited memory system over the
  repo's real execution history (zero external deps, no vectors required):
  - `gov recall "<query>"` — cited retrieval (exact id/path → BM25 →
    provenance-weighted ranking); every answer line traces to a hash-linked source;
    permission-aware.
  - `gov insights` — strategic execution-insight reports (recurring failure themes,
    arch-debt by subsystem, churn, gate/review/recovery health); recommends-only,
    aggregated by repo (never per-person).
  - `gov prework <ticket>` — pre-work context pack surfacing relevant prior work and
    already-failed approaches for the touched area.
  - `gov closeout-summary <ticket>` — evidence-backed closeout grounded in the
    ticket's journal/plan/commits with event-hash + chain-head citations.
  - `gov learned-rule` — routes learned procedural-rule changes through the governed
    review/land lane instead of silently rewriting agent behavior.
  - Derived decision records + summary tiers (ticket→epic→subsystem→repo) with
    source-hash staleness detection; memory classification
    (public/internal/sensitive/secret-prohibited); and an **optional, measured**
    semantic (graph + vector) layer that stays OFF unless it beats the deterministic
    baseline on the eval harness. See `coord/docs/MEMORY_ARCHITECTURE.md`.
- **Optional quality-dimension adapters** — external-tool adapters that **skip
  gracefully when the tool isn't installed (never fail the gate)** and ratchet on
  new-vs-baseline findings: mutation/property testing, SAST (Semgrep), supply chain
  (dependency-free CycloneDX SBOM + Trivy/Grype CVE scan), accessibility
  (axe/pa11y + visual regression), performance budgets (size-limit/Lighthouse/k6),
  and a shared package + cross-repo duplication-convergence gate; plus a
  diverse/adversarial review-lens catalog. See `coord/docs/QUALITY_DIMENSIONS.md`.
- **Live-MCP / runtime-operation governance** — lifecycle enforcement for tickets
  that declare a live/production-MCP operation (operation class, adapter, scope,
  approval, redaction, receipt, cleanup — closeout blocks until satisfied);
  reference adapter patterns (read-only narrowed case reads; temporary-access /
  cleanup receipts); a read-only `/live-mcp` cockpit view; and a bridge letting
  live-MCP receipts satisfy server-bootstrap job evidence.
- **Server-bootstrap / backfill safety** — optional `bootstrap_risk` plan fields,
  advisory (non-blocking) validation, a backfill query/volume safety checklist +
  scanner, and a read-only `/bootstrap-risk` cockpit view (server-readiness kept
  distinct from job-completion).
- **Per-event journal non-repudiation** — optional Merkle batch signing (ed25519)
  giving per-event inclusion proofs over the hash-chained journal, with a pluggable
  (KMS-ready) key provider. Backward compatible with existing journals.
- **Setup config UX** — `coord init --wizard` generates config-as-code for the user
  to review and commit (idempotent, no-clobber) + a read-only `/configuration`
  cockpit view. Config-as-code on the governed lifecycle, not a runtime admin console.
- **Docs light lane** — reference/design-doc tickets use a reduced-completeness
  governed lane; behavior-changing procedural docs (AGENTS.md, `.claude/`, CLAUDE.md,
  GOVERNANCE.md) still require the full reviewed lane.
- **Data-contract before/after proof** — a `reconciles_to_row_count` assertion on the
  data-analytics track that hard-fails backfill/reseed outputs lacking a row-count proof.
- Architecture Decision Records under `coord/docs/decisions/`.

### Fixed / Changed
- **`gov finalize` now commits the board-row status transition atomically** on the
  no-PR landing lane (previously the canonical board row was left uncommitted after
  finalize, requiring a manual follow-up commit).
- Content gate-proc real-site accuracy (sitemap root + asset link resolution).
- README de-staled: skill count corrected (19 → 27) and a Track Skills table added.

### Enterprise tier
- Production-MCP adapter hardening: RBAC per adapter/operation-class, service-account
  policy, SIEM audit-export shape, ed25519 adapter signing/versioning, a break-glass
  workflow for destructive operations, and tenant/repo-family scoping.

## v0.1.5 — 2026-06-22

### Added
- **Runtime-evidence core** — governed receipts for live/runtime operations:
  production-MCP, bootstrap-job, and deployment receipts, plus the `gov` verbs
  `live-mcp-policy`, `live-mcp-record`, `bootstrap-record`, `deploy-record`,
  `deploy-check`, `verify`, `falsify`, and `validate-receipt` (receipt-writing MCP
  tools are mutation-gated; read-only checks stay open). Real receipts are
  gitignored (`coord/evidence/**`) so they never ship.
- **`coord/package.json`** declaring the engine's Node baseline (`>=22.8`).
- **`MEMORY_ARCHITECTURE.md`** — the governed-memory design (4-layer model, the
  `gov recall` contract, and the optionality + config-as-code stance).

### Fixed / Changed
- Corrected the declared Node baseline (`engines` → `>=22.8`) across packages to
  match the engine's real requirement.
- Documentation hygiene: removed internal references from shipping docs; the
  README hero no longer references an unbuilt demo asset.

## v0.1.4 — 2026-06-19

### Fixed
- **Release verifier no longer hangs** — `verify-dual-release.sh` / the public
  hygiene suite could hang indefinitely because the gate tests' `spawnSync`
  timeout only signalled the direct `bash` child, while a `node` test/coverage
  grandchild kept the stdout pipe open. The gate now spawns detached and kills
  the whole process group on a bounded (60s) timeout (COORD-129).
- **coord-ui CI is deterministic on a clean checkout** — the public-CI coord-ui
  job now builds before typechecking, so Next's generated `.next/types` exist
  before `tsc` runs (COORD-129).

### Changed
- **Release attribution** — the published release commit is now authored by the
  lead maintainer (configurable via `RELEASE_AUTHOR_NAME`/`RELEASE_AUTHOR_EMAIL`)
  instead of a placeholder, so GitHub attributes the release correctly.

## v0.1.3 — 2026-06-18

Multi-agent reliability hardening.

### Added
- **Fail-closed ownership guard** — governed mutations (commit, update-plan,
  move-review, finalize, heartbeat, add-repo-gate, set-review-cycles) now refuse
  to run when the acting session is not a registered + bound owner, with
  actionable remediation. Governed state can no longer silently drift to
  todo/unassigned from unregistered work (COORD-128).
- **Operating-model docs** — `coord/docs/MULTI_AGENT_TOPOLOGIES.md` codifies the
  mandatory registration/binding protocol, the "sub-agents implement + commit
  locally; the orchestrator/human does the single approved remote push" pattern,
  and the never-share-a-worktree/runtime rule. `KNOWN_ISSUES.md` updated to match.

## v0.1.2 — 2026-06-18

### Changed
- **Maintainers** — named lead maintainer (Vivek Gupta) added to `MAINTAINERS.md`.
- **Contact domain** — Code of Conduct / Trademark / Security contact alias
  consolidated to `opensource@softsensor.ai` (was `.com`).

## v0.1.1 — 2026-06-18

Adopter-facing reliability + transparency follow-ups to v0.1.0.

### Added
- **`KNOWN_ISSUES.md`** — honest known-issues / workarounds list for adopters
  (COORD-127).
- **Configurable `defaultStartBaseRef`** — `gov start` now branches from a fresh
  `origin/<base>` (per-repo `startBaseRef` › global `defaultStartBaseRef` ›
  `integrationBranch`), with graceful offline fallback; no more manual
  fetch-and-rebase after start (COORD-125).
- **Baseline-aware "ratchet" gating** — the architecture/quality gate can fail
  only on findings *new* relative to a base ref, reporting pre-existing ones as
  informational (opt-in `--ratchet`/`--baseline` or `archGate: "ratchet"`;
  default stays absolute) (COORD-126).
- **`gov repair-chain`** — guarded, auditable recovery for a journal hash-chain
  break (e.g. from concurrent governed writes): re-links the chain and records an
  on-chain repair marker; unexplained breaks still fail `gov conform` (COORD-124).

### Changed
- README now points to `KNOWN_ISSUES.md` for CLI issue status/workarounds.

## v0.1.0 — 2026-06-18

First public release of **Softsensor Concord** — governed multi-agent coordination
for multi-repo teams. Early-stage (production-pilot) release under Apache-2.0.

### Added
- **Governance engine + `gov` CLI** — a shared, audited board with per-ticket
  worktrees, lifecycle locks (todo → doing → review → done), evidence-gated review,
  fail-closed gates, and a tamper-evident append-only journal.
- **`coord` CLI** — `coord init` (idempotent repo bootstrap into a governed board),
  `coord conformance` (journal-chain self-verify + signed attestation), and
  `coord upgrade` (apply a new engine version, re-pin + verify, rollback on failure).
- **`coord-ui`** — a read-only, local, single-coord cockpit (board, dispatch,
  runtime, evidence, cost, quality views) with a fail-closed access boundary.
- **Agent skills** — `/initiate`, `/planner`, `/code-writer`, `/qa-review`,
  `/manual-tester`, `/business-analyst`, `/designer`, and more under `.claude/`.
- **Conformance & integrity** — `gov conform`/`attest` (signed ed25519
  attestations), engine-surface pinning (`gov verify-engine`), and OTLP export.

### Known scope (this release)
- `coord-ui` is a local read-only surface; there is no hosted/multi-tenant mode.
- The `gov` CLI is the complete verb surface; the MCP server exposes a subset.
- See `README.md` "Status and scope" for the full picture.

## Unreleased

### Added (base-aware base default · auto-id · gh retry · recovery polish)
- **Config-aware base default** — base-ref resolution that previously fell back to a literal `"dev"` now falls back to the repo's configured `REPO_INTEGRATION_BRANCHES[<repo>]` (then `"dev"`). Behaviour-preserving for `dev`-integrating projects (the template); a `main`-integrating downstream no longer has to pass `--base main` on every `submit`/`land`/`finalize`. Applied at the PR-create base + recorded base, `assertLandingIntegrity`, `ensureLandingRecord`, `detectSupersedeLandingBypass`, and the testing-infra / feature-proof `landing.base_ref` readers.
- **Auto-id ticket allocation** — `gov next-id <PREFIX>` prints the next free `PREFIX-N` (zero-padded to the widest existing width, min 3); `gov open-followup` accepts `--prefix <PREFIX>` to auto-allocate the id under the runtime lock instead of hand-numbering; `gov split-ticket <parent> --into <repo-codes>` creates one auto-allocated `--relation related` follow-up per repo for cross-repo umbrellas. Always yields schema-valid `^[A-Z]+-\d+$` ids.
- **`ghPrView` retry-with-backoff** — a bounded 6-attempt retry around the `gh pr view` read tolerates GitHub secondary-throttle bursts (intermittent `HTTP 401`/GraphQL/5xx) that previously failed a whole submit/move-review/land op. Read-only, so retry is safe.

### Changed (recovery hints · sync)
- **Merge-not-rebase recovery hint** — the DIRTY/BEHIND (and merge-conflict) mergeability hint now leads with the append-only `git merge` + normal-push path (`land --method squash` flattens it) and offers force-push only as an alternative, so sandboxed/auto-mode agents that are denied `--force-with-lease` have a usable recovery path.
- **Silent sync skip when coord/ isn't a git worktree** — `autoSyncAfterLifecycle` now quietly skips the benign "coord root isn't a git repo" case instead of emitting a loud best-effort-sync-failed warning.

### Added (crash atomicity — COORD-033)
- **Atomic canonical-state writes** — `writeFileAtomicSync` (temp file in the same directory + `fsync` + atomic rename + best-effort directory fsync) now backs `writeCanonicalTextFile`/`writeCanonicalJsonFile`, snapshot artifacts, the snapshot checkpoint, and restore-point file restores. A process killed mid-write can no longer leave a torn board, plan, QUESTIONS, agents, lock, snapshot, or checkpoint file.
- **Torn-journal-tail tolerance + journaled repair** — a crash mid-append previously left a partial trailing line that hard-failed every subsequent journal read (and with it drift detection and all mutations). `readGovernanceEventLog`/`readLatestGovernanceEvent` now tolerate exactly one torn trailing line (mid-file corruption still fails closed); the next `appendGovernanceEvent` truncates the torn tail atomically and journals a `journal-tail-repair` event carrying the discarded fragment. Journal appends are now fsynced through an explicit fd.
- **Crash-persistent restore points** — `withGovernanceMutation` persists its restore point to `coord/.runtime/governance-restore-point.json` (atomically, before any governed file is touched) and clears it on success or handled rollback. The next governance invocation auto-recovers an interrupted mutation: rolls governed files back, journals a `crash-rollback` event, and discards stale/torn restore points when state already matches the checkpoint. Upgrades mutations from "rollback on error" to "rollback across crashes".

## v0.6.0 (2026-06-09)

### Added (evidence)
- **`coord/scripts/evidence-export.mjs`** (COORD-019) — control-mapped, read-only audit-record exporter over existing governed state (journal, plan records, landing/pr/waiver indexes). Emits deterministic, hash-stable JSON or a markdown report; fails closed (non-zero exit) on any ticket with missing required evidence. Data-driven control maps in `coord/product/control-maps/` (`eu-ai-act.json`, `nist-ai-rmf.json`). Spec: `coord/product/EVIDENCE_EXPORT.md`.

### Changed (naming)
- **Public product name is now "Softsensor Concord"** (COORD-017). The `coord/` scaffold directory, the `gov` CLI, and all board paths are **unchanged** — only the public-facing name/branding is added in `README.md` and `QUICKSTART.md`. "Concord" = the project; `coord`/`gov` = the on-disk and command surfaces.

### Added
- **`COORD_SESSION_ID` authoritative session anchor** (COORD-015) — explicit, provider-agnostic session id that overrides the harness-injected provider thread id on *both* the fingerprint and effective-thread-id binding paths. Enables the Claude **orchestrator + sub-agents** multi-agent topology, which previously collapsed all sub-agents onto one session (the Claude Code harness injects one identical `CLAUDE_CODE_SESSION_ID` into every sub-agent; `CLAUDE_SESSION_ID` could not override it). Codex/Gemini already isolated natively via their own per-agent thread ids. Unset → identity resolution is unchanged.
- **`coord/docs/MULTI_AGENT_TOPOLOGIES.md`** — per-provider matrix documenting the two supported topologies (N independent sessions; one orchestrator + N sub-agents) and the `COORD_SESSION_ID` rule for each provider.
- **`LICENSE`** — Apache-2.0 (Copyright 2026 Softsensor-org); referenced from `README.md`.

### Changed
- `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, and `coord/docs/IDENTITY_RUNTIME_EXTRACT.md` reconciled with the actual identity resolution: the stale "export `CLAUDE_SESSION_ID`" guidance (which does not work for Claude in-conversation sub-agents) is corrected to `COORD_SESSION_ID`, and the fingerprint anchor priority now lists `COORD_SESSION_ID` as authoritative (priority 0).

## v0.5.0 (2026-05-16)

### Added
- **`gov plan` as a first-class command + `--seed`** (GOV-014) — tool-agnostic plan seeding; planning is no longer hidden in a Claude-only skill
- **`gov rebuild-board`** (GOV-012) — journal-driven board drift repair
- **`gov agent-rebind --fresh`** (GOV-013) — session-collision recovery
- **`/proc/self/stat` session-id auto-anchor + fail-closed session guard** — deterministic POSIX session fingerprint with graceful macOS/BSD/WSL1 fallback; refuses to proceed without a stable identity when ≥1 active provider session exists
- **`scripts/agent` facade** (GOV-070) — thin pre-core identity-safe adapter
- **`coord/DIRECTORY.md`** — authoritative map of the three state buckets (canonical / generated / ephemeral), the template-managed untouchable path set, and the directory index
- **`coord/COORD_REPO_RESTRUCTURE_PROPOSAL.md`** — proposed canonical/derived/ephemeral split (pending template-first execution)
- **8 previously-undocumented operator-verb skills** surfaced in README/QUICKSTART: `/next`, `/do`, `/check`, `/test`, `/test-strategy`, `/review`, `/land`, `/resume` (skill count corrected 11 → 19)

### Fixed
- **`add-review-cycle` silent failure modes** (GOV-002) — `set-review-cycles` remains the recommended batch path
- **`gov submit`/`pr-create` push routed through the governed worktree** (GOV-005)
- **Sticky-session fallback removed** from `resolveEffectiveThreadId` (GOV-009)
- **Registry-derived repo-prefix helpers + REPO_REGISTRY data block** (GOV-010, GOV-015) — downstream repo-code overrides are data, not forks
- **Governance MCP** switched to a direct command adapter with machine-readable results and standardized stdio framing (GOV-053/055/057/058)
- **Identity runtime hardening** — runtime crash/regression fixes, canonical-lock thread_id reconciliation, continuity-inference removal (GOV-069/074/075/076/077)
- **Docs de-staled** — MCP tool count corrected 27 → 30; version-of-record reconciled (`GOVERNANCE.md` ↔ `CHANGELOG.md`); QUICKSTART ticket-creation clarified to not contradict the "never hand-edit tasks.json" rule (new backlog rows are the one allowed hand-edit; lifecycle fields stay gov-owned)

### Notes
- `TEMPLATE_LEARNINGS_TODO.md` backlog fully landed (2026-05-04)

## v0.4.0 (2026-04-09)

### Added
- **Session discipline** in CLAUDE.md — fresh session per ticket, 30-min context reset guidance
- **WIP limit of 5** concurrent `doing` tickets in orchestrator hard checks (GOVERNANCE.md)
- **Auto-heartbeat hook** in `.claude/settings.json` — auto-syncs lock HEAD after every `gov commit`
- **Memory distillation** directive in `coord/AGENTS.md` — promote cross-session learnings to shared directives
- **5 operations skills** in `.claude/skills/`: deploy, migrate, seed-data, db-status, health-check
- **Governance MCP server** (`coord/scripts/governance-mcp.js`) — 27 typed MCP tools wrapping the governance CLI. Any MCP-capable agent gets structured governance without shelling out. Eliminates flag parsing bugs, quoting traps, and silent failures. Makes the template truly agent-agnostic.
- **codeTree MCP** in `.mcp.json` — zero-config AST-level codebase exploration, ~25x token reduction for navigation on unfamiliar codebases
- **MCP integrations** in `.mcp.json` — pre-configured for Sentry and Datadog
- **Token efficiency guidance** in exploration-heavy skills (manual-tester, qa-review, designer) — prefer AST queries over full file reads
- **DEVELOPER_NOTE.md** — comprehensive AI-assisted development methodology guide

### Improved
- QUICKSTART.md expanded with operations skills and MCP setup sections
- README.md updated with operations skills table and MCP section

## v0.3.0 (2026-04-09)

### Added
- **11 agent skills** in `.claude/commands/`:
  - Governance: `initiate`, `orchestrator`, `planner`, `code-writer`, `code-reviewer`, `gate`, `recover`
  - Quality: `manual-tester`, `qa-review`, `business-analyst`, `designer`
- **Orchestrator `takeover` action** for claiming in-progress tickets from other agents
- **Donor parity artifacts**: `DONOR_SOURCE_INDEX.md`, `DONOR_FEATURE_COVERAGE.md`, `EPIC_BOARD.md` (all optional stubs)
- **Generalization pipeline** in planner (Phase 2b) and code-writer (Phase 2b) — blocks carrier-specific porting from donor repos
- **QUICKSTART.md** — first-5-minutes adoption guide
- **CONTRIBUTING.md** — feedback loop for syncing learnings back to template
- **TEMPLATE_FEEDBACK.md** stub — per-project learning log
- **CHANGELOG.md** — this file

### Improved
- **code-writer skill**: reads planner output from `coord/active/`, rebases onto `origin/dev` after start, uses batch `set-review-cycles`
- **planner skill**: reads donor coverage and epic board during context gathering
- **business-analyst skill**: reads donor parity artifacts for requirement traceability
- **CLAUDE.md**: added skills reference section
- **README.md**: added full skill reference table, governance enhancements, known issues

### Documented
- Known CLI issues: `add-review-cycle` silent dedup, stale dev branch, session drift, binary gate failures
- Governance safety properties section in `GOVERNANCE.md` (lock atomicity, journal integrity, feature proof verification)

## v0.2.0 (2026-03-31)

### Initial template release
- Governance policy with ticket lifecycle, locks, worktrees, branch promotion
- Board CLI (`board.js`) with sync, validate, and rendering
- Governance CLI (`governance.js`) with full ticket lifecycle management
- 3 ticket prompts: implementer, planner, reviewer
- 12 specification stubs
- Multi-agent session management
- Orchestrator contract with hard checks and passive alerts
