# Changelog

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
