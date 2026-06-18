# coord/scripts

Governance helper scripts for this coordination scaffold.

Shortcut:

```bash
coord/scripts/gov <command> ...
```

This wraps:

```bash
node coord/scripts/governance.js <command> ...
```

## Product CLI (`coord`)

Distinct from the per-ticket governance ENGINE verbs above (`gov`), the
product-facing `coord` CLI is the packaged product surface:

```bash
coord/scripts/coord <command> ...
coord/scripts/coord help               # list commands
coord/scripts/coord init [--dir <path>] [--dry-run]
coord/scripts/coord conformance [--json] [--attest] [--verify [<file>]]
coord/scripts/coord upgrade --from <dir|bundle> [--dir <target>] [--dry-run] [--json]
```

- `coord-cli.js` — extensible subcommand dispatcher. A command registry
  (`{ name -> { summary, run(args) } }`) with a pure-ish `dispatch()` for
  routing / `help` / unknown-command (exit 1). Adding a subcommand is a
  one-line registry entry plus a module. `init`, `conformance`, and `upgrade`
  are registered today.
- `coord conformance` — one-shot, fail-closed conformance check. A PACKAGING
  command that COMPOSES the existing conformance engine (it reuses
  `conformance-verbs.js` `conform`/`verifyEngine`, the signed
  `conformance-attestation.js` producer, and `engine-pin.js` — no crypto or
  conformance logic is reimplemented). Default: run the journal hash-chain
  self-verify (ENT-002) and print a human summary, exit 0 on pass / non-zero on
  fail. `--json` emits the engine's machine report. `--attest` ALSO emits a
  signed ed25519 attestation over the engine-integrity inputs (ENT-010).
  `--verify [<file>]` verifies an existing attestation (an explicit path, or the
  most recent emitted one) — the load-bearing fail-closed gate — and reports the
  engine-pin drift check (ENT-011) as informational.
- `coord init` — idempotent, **no-clobber** zero→governed-board bootstrap for a
  target repo (default cwd, or `--dir <path>`): scaffolds the
  `coord/project.config.js` seam if missing, seeds a clean SETUP-001/SAMPLE-001
  starter board if absent, and ensures the `coord/product/` spec stubs exist.
  It never overwrites an existing file (so there is no `--force`); re-running an
  already-initialized repo is a no-op that exits 0. `--dry-run` prints the plan
  and writes nothing.
- `coord upgrade` — managed engine-upgrade automation. Applies a NEW engine
  surface (`--from <dir|bundle>`: a tree containing the new `coord/scripts` +
  `coord/TEMPLATE_SYNC_MANIFEST.json`) into a target repo (`--dir`, default cwd),
  then **re-pins** and **verifies** — REUSING `engine-pin.js`
  (`createEnginePin(...).pin()`/`.verify()`); no fingerprint/verify logic is
  reimplemented. It diffs the source surface against the target (add / update /
  unchanged) and only ever writes the manifest-tracked exact-match surface (plus
  the manifest itself) — project-local files (the board, `project.config.js`,
  product specs, `.runtime`) are never touched. Safe by default: every file
  written is backed up first, so a verify failure triggers an **exact byte
  rollback** (restoring prior bytes, removing added files) and a non-zero exit.
  Idempotent: upgrading to the same version is a no-op (exit 0). `--dry-run`
  prints the plan and writes nothing; `--json` emits a machine-readable result.
- `coord-init-starter-board.js` — the canonical clean starter-board shape,
  reused by BOTH `coord init` and the public release builder's clean-board step,
  so init and the release cut never disagree on what a fresh board looks like.

## Governance Module Layout

`governance.js` is the stable public facade. It keeps compatibility for the
`gov` wrapper, MCP adapter, tests, and downstream template-sync consumers.

Current core modules are flat under `coord/scripts/`:

- `governance-context.js` — shared path state, lock-depth counters, path accessors, `GovernanceError`, `defaultFail`
- `git-ops.js` — single-sourced raw git invocation: `gitTry` (tolerant `{status,stdout,stderr}` primitive) plus generic-message `runGit`/`gitOutput` wrappers
- `state-io.js` — canonical state reads/writes, snapshots, atomic writes
- `governance-board-state.js` — board IO, row lookup, sync triggers, and simple index/status reducers
- `journal.js` — event log append/read/replay and journal repair primitives
- `plan-records.js` — plan record parsing, rendering, and IO
- `landing-gh.js` — GitHub PR transport and retry helpers
- `token-economics.js` — cost ledger, precheck, context-pack, plan-waves, dispatch-plan
- `followups.js` — follow-up relations and exceptions
- `governance-session.js` — agent/session registry, provider identity, liveness, and lock identity helpers
- `verb-parity.js` — documented verb/flag parity scanners
- `prompt-coverage.js` — prompt registration, likely-file seeding, and precondition checks
- `governance-validation.js` — readiness, review-plan, feature-proof, testing-infrastructure, and landing validation helpers
- `lifecycle-utils.js` — pure, dependency-free helpers (slugify, integerOrDefault, inferNextRound, todayIso, escapeTable, escapeRegex, shellEscape)
- `repo-registry.js` — repo-code resolution (roots, names, prefixes, CLI aliases, integration branches)
- `lifecycle-flags.js` — CLI flag parsing for lifecycle subcommands (`parseLifecycleFlags` + helpers)
- `worktree-ops.js` — git primitives plus worktree create/cleanup/audit (including closed-ticket workspace cleanup) and branch preflight/push
- `governance-repair.js` — read-only doctor report/classification helpers (template-feedback alerts, question-queue, drift guidance, stale-lock)
- `pr-ops.js` — GitHub PR operations (view/create/merge)
- `runtime-cleanup.js` — runtime lock status/break, rollback-drift detection, and clean-runtime scratch collection/removal
- `gate-runtime.js` — gate EXECUTION: gate script/invocation/artifact-dir resolution, package-manager detection, and the clean-checkout gate runner
- `gate-proc-registry.js` — gate PROCESS-orphan containment + provenance-scoped reaper (COORD-092): the pidfile registry under `coord/.runtime/gate-procs/<gate-run-id>.json` (gate-run-id, owning ticket/repo/lane, child PIDs/PGID, each PID's `/proc` start-time fingerprint = the PID-reuse guard, created-at), plus `detectOrphans` (read-only, used by `doctor-report.js`) and `reapOrphans` (mutating, used by `doctor-recovery.js`'s `doctor --fix` and the `gov reap-gate-procs` verb). The spawn-side `trap EXIT` in the template `*/scripts/gate.sh` registers + tears down tracked process groups so a clean run never leaks. The reaper signals ONLY recorded PIDs whose live start-time still byte-matches the recorded one — structurally never a process-name scan, so it cannot touch a process coord did not record. Also exposes a `register`/`cleanup`/`list`/`detect` CLI for the gate.sh shell to shell into
- `gates.js` — gate ATTRIBUTION + board-record surface: the `add-repo-gate` verb, `classifyGateAttribution`, and `formatRepoGateEntry`, as a DI factory (injects `updatePlanBlock` from `plan-command.js`; kept separate from `gate-runtime.js`'s execution surface)
- `landing-audit.js` — landing provenance / AUDIT surface, as a DI factory: the audit-report cluster (`collectLandingAuditReport`, `applyLandingAuditBackfill`, `formatLandingAuditSummary`, `collectLandingAuditCandidates`, `summarizeLandingAuditEntries`), the testing-infra / feature-proof landing audits (`ensureTestingInfrastructureLandingAudit`, `ensureFeatureProofLandingAudit`), and the landing-RECORD writers (`ensureLandingRecord`, `persistMergedPrLandingSnapshot`). Injects `classifyLandingRecord` / `deriveTestingInfrastructureAudit` / `deriveFeatureProofAudit` / `requiresLandingGovernance` from `governance-validation.js` (and injects `collectLandingAuditCandidates` back to it); `verifyPrEvidence` stays in `landing-gh.js`. Wired in `lifecycle.js` after `createGovernanceValidation`
- `questions.js` — QUESTIONS.md question handling: row parse/classify (severity + aging), orchestrator-queue reads, explain-questions guidance, `log-question`, and question-row append/remove writers
- `plan-command.js` — the `plan`/`update-plan` commands plus the plan-block mutation verbs (`add-review-cycle`, `set-review-cycles`, `set-requirement-closure`, `add-feature-proof`, `drop-feature-proof`), the start-seed builder, plan status/next-command payloads, and the plan-mutation authority gate (the `add-repo-gate` verb moved to `gates.js`)
- `ticket-transitions.js` — the ticket state machine (`start`, `submit`, `move-review`, `return-doing`, `mark-done`, `block`, `unblock`, `supersede`) plus the `applyMarkDone` and `persistReturnDoingState` transition primitives, as a DI factory (cross-module deps injected; consumed by the `closeout.js` land path and re-exported through `lifecycle.js`)
- `closeout.js` — the ticket closeout/land surface (`finalize`, `land`, `finishTicket`, `prepareDoneCloseout`) plus the closeout plan-update builders, as a DI factory; injects the `ticket-transitions` surface (`moveReview`/`markDone`/`applyMarkDone`) and provides `prepareDoneCloseout` back to transitions, so it is wired in `lifecycle.js` after `createTicketTransitions`
- `doctor-recovery.js` — the MUTATING governance repair/recovery surface (`doctorFix` behind `doctor --fix`, `reconcileGovernance`, `recoverTicket`, plus the private session-mirror rebuild helper), as a DI factory; the read-only `doctor` report lives in `doctor-report.js` and delegates to the injected-back `doctorFix` only on `--fix`
- `doctor-report.js` — the READ-ONLY governance doctor REPORTING surface (`resolveDoctorScope`/`resolveDoctorOwnerScope`, the read-only `doctor()` report, and the `buildCanonicalDerivedDriftError` report builder), as a DI factory; injects `doctorFix` (from `doctor-recovery.js`) so the report can trigger repair on `--fix` without owning it, so it is wired in `lifecycle.js` after `createDoctorRecovery`
- `ticket-guidance.js` — the OPERATOR-GUIDANCE surface (`buildTicketNextCommands` per-status next-command planner, `explainTicket` read-only ticket explanation report, `runTicketCycle` recommended planner/worker/reviewer/closer cycle), as a DI factory; read-only (reads board/lock/plan/readiness state and emits guidance JSON, never mutates), so all cross-module deps — including the shared `buildPostCloseFollowupCommand` owned by `lifecycle.js` — are injected via deferred wrappers
- `agent-commands.js` — the AGENT-COMMAND / claim-orchestration surface (`agentsCommand` list/register/enable/disable, `printCurrentAgentId`/`resolveCurrentAgentId`/`formatCurrentAgentIdPayload` agentid resolver, the `claim`/`claimTicket`/`claimAgent`/`claimAgentSession` cluster, `resumeTicket`, `releaseAgent`, `rebindAgent`, `resolveHumanAdminOverride`, `detectCwdTicketClaimHazard`, and `showAgentStatus`/`buildAgentStatusPayload`), as a DI factory; the COMMAND LAYER above the `governance-session.js` session engine — it injects the session/registry readers+writers, identity resolution, owner-lease metadata (`PROVIDER_REGISTRY`), board readers, the mutation/lock wrappers and the journal appender rather than duplicating session semantics, with `findLockForTicket`/`getLockFiles` and the journal/board binds injected as deferred wrappers; wired in `lifecycle.js` after `createGovernanceSession`
- `landing-resolution.js` — the landing COMMIT-RESOLUTION surface (`extractCommitShas`, `refreshLandingBaseRef`, `resolveLandingBaseRef`/`resolvePrLandingBaseRef`, `pickBestLandingCommit`, `resolveSourceCommitSha`, `resolveFulfilledByLandingCommit`, `resolveLandingCommitSha`), as a DI factory; owns git-ancestry / base-ref / source-commit resolution ONLY — it injects git-ancestry helpers (`resolveCommitishInRepo`/`fetchRepoRef`/`isCommitAncestorOfRef`), the repo registry, the ticket git-context helpers, and the ONE GH read it needs (`ghPrView`, plus `mergeUniqueRefs`/`toArray`) from `landing-gh.js` rather than re-implementing transport; GitHub PR TRANSPORT stays in `landing-gh.js` and landing AUDIT/record behavior stays in `landing-audit.js` (COORD-070). The commit-subject affiliation helpers (`readCommitSubject`/`commitSubjectAffiliatesWithTicket`) stay in `lifecycle.js` (review-state verification, not resolution). Wired in `lifecycle.js` after `landing-gh.js` and before `createLandingAudit` (which consumes the resolvers)
- `board-rebuild.js` — the board-rebuild-from-journal surface (`rebuildBoardFromJournal`, `terminalJournalStatusForTicket`, `collectTicketsWithJournalDrift`), as a DI factory; replays the governance event journal to repair `board/tasks.json` rows whose Status/Owner drifted from the journal's terminal succeeded event (GOV-012). Reads the journal/board and writes the board only inside the injected `withGovernanceMutation` envelope; injects `readGovernanceEventLog`/`readBoard`/`getTicketRef`/`writeBoard`/`fail` rather than owning any wiring. Wired in `lifecycle.js` AFTER `createJournal` (for `readGovernanceEventLog`/`withGovernanceMutation`) and `createGovernanceBoardState` (COORD-091)
- `arch-checks.js` — zero-dep code-quality analyzer library (size/monolith/complexity/import-boundary/duplication/hardcoding/deadcode). The `size` check supports a justified per-file budget override (`checks.size.perFile`, keyed by basename) so a legitimately large composition root (e.g. `lifecycle.js`) can carry its own documented budget instead of nagging against the global one; the hard `monolith` ceiling ignores `perFile` (COORD-091). The `hardcoding` check (QSCAN-001) is a low-noise config-seam-leak detector: inline filesystem paths, repeated multi-word string literals (≥ `minRepeats` distinct sites → shared constant), and opt-in magic numbers (off by default), with obvious-OK literals (URLs, module specifiers, enum/flag vocabulary, single occurrences, test files) filtered out. The `deadcode` check (QSCAN-001) flags top-level functions/consts that are provably unreferenced across the corpus — it is dispatch/facade/export-aware (a def stays live if referenced by bare identifier OR string-key dispatch table OR exported), prefers false negatives, and is always advisory (`warn`, never auto-fail). For subtree scans pass `referenceRoot` (a broader tree) so a def referenced from a sibling subtree (e.g. `coord/board`) is not mis-flagged
- `conformance-verbs.js` — the ENT conformance / engine-integrity CLI verb surface (`gov conform` = ENT-002 journal hash-chain self-verify + ENT-010 signed conformance attestation emit/verify; `gov verify-engine` = ENT-011 engine version-pin + drift-check), as a DI factory. Pure presentation glue over the two injected factories (`createConformanceAttestation`, `createEnginePin`): it builds them from injected `coordDir`/`verifyGovernanceChain`/`fail` and returns `conform`/`verifyEngine` for the `commands` map + `cli.js` cases. READ-ONLY except writing `conform --attest`'s gitignored attestation artifact + first-run keypair and `verify-engine --pin`'s committed `coord/engine-pin.json`. Extracted from `lifecycle.js` (COORD-107) to keep it under the documented 5000 composition-root size ceiling by EXTRACTION rather than a budget bump
- `lifecycle.js` — remaining orchestration hub: factory wiring and the residual lifecycle surface
- `cli.js` — command routing, flag parsing, `executeCommand()`, and `main()`

The remaining refactor work is to keep shrinking `lifecycle.js`, not to move the
public entry point.

## Session and Identity

```bash
coord/scripts/gov agentid                           # Show or resolve current agent identity
coord/scripts/gov claim --owner <handle>             # Claim a session for an explicit owner
coord/scripts/gov agents register --handle codexa42 --id a42 [--provider openai]
coord/scripts/gov agents list                        # List registered agents
coord/scripts/gov agents status                      # Show agent status and idle sessions
```

## Ticket Lifecycle

```bash
coord/scripts/gov start <ticket-id> [--offline]      # Move todo -> doing, auto-seed startup attestation, acquire lock
coord/scripts/gov unstart <ticket-id>                # Guarded same-owner doing -> todo rollback for true wrong-start cases
coord/scripts/gov ticket <ticket-id>                 # Show ticket status and next steps
coord/scripts/gov explain <ticket-id>                # Explain governance state for a ticket
coord/scripts/gov move-review <ticket-id>            # Move doing -> review
coord/scripts/gov mark-done <ticket-id>              # Move review -> done
coord/scripts/gov finalize <ticket-id> --no-pr --landed "<evidence>"
coord/scripts/gov finalize <ticket-id> --no-pr --already-landed --landed "<evidence>"
coord/scripts/gov land <ticket-id> [--method <merge|squash|rebase>] [--delete-branch]
coord/scripts/gov resume <ticket-id>                 # Resume a ticket in the current session
```

## Plan Record Management

```bash
coord/scripts/gov plan <ticket-id> [options]         # Preferred plan bootstrap/update surface
coord/scripts/gov update-plan <ticket-id> [options]  # Compatibility alias for direct plan updates
coord/scripts/gov add-review-cycle <ticket-id>       # Add a structured self-review cycle
coord/scripts/gov set-review-cycles <ticket-id>      # Replace all self-review cycles
coord/scripts/gov set-requirement-closure <ticket-id> # Set requirement closure evidence
coord/scripts/gov add-feature-proof <ticket-id>      # Add a feature proof entry
coord/scripts/gov drop-feature-proof <ticket-id>     # Remove a feature proof entry
coord/scripts/gov add-repo-gate <ticket-id>          # Add a repo gate entry
```

## Orchestrator

```bash
coord/scripts/gov orch                               # Run orchestrator cycle
coord/scripts/gov orch --fix                         # Run with deterministic local auto-repairs; foreign cleanup stays report-only
coord/scripts/gov orch --cleanup-foreign --human-admin-override "<reason>"  # Explicit batch cleanup for foreign stale state
coord/scripts/gov audit-landings [--write]           # Audit landing index provenance
```

## Diagnostics and Recovery

```bash
coord/scripts/gov doctor [--ticket <id>] [--fix]    # Check governance health
coord/scripts/gov recover <ticket-id> [--snapshot-restore]  # Repair live lock/session drift, or explicitly restore non-live review/done state
coord/scripts/gov recent-events [--full]             # Show recent governance events
coord/scripts/gov runtime-lock-status                # Report runtime lock state
coord/scripts/gov break-runtime-lock                 # Remove a wedged runtime lock
```

## Quality Gates

```bash
coord/scripts/gov gate <repo-name|repo-code> [--lane <default|full|ci>] [--source <local|hook|ci>]
coord/scripts/gov commit-ticket <ticket-id> -m "TICKET-ID message" [--files <path> ...] [--all]
coord/scripts/gov push <ticket-id>                   # Push ticket branch to remote
coord/scripts/preflight.sh [--ticket <ticket-id>]    # Run preflight validation checks
```

`commit-ticket` is only supported for product-repo tickets (B, F) — those are the
ones with a governed git worktree. Repo X (coord-only) tickets do not have a
worktree to commit into; for those, stage and commit coord changes with targeted
`git add <files>` / `git commit` directly, and continue using
`coord/scripts/gov` for lifecycle, plan, review, and closeout mutations.

## Board Validation

```bash
node coord/board/board.js validate                   # Validate board against schema
node coord/board/board.js sync                       # Render outputs from canonical board
node --test coord/board/board.test.js                # Run board tests
node --test coord/scripts/governance.test.js         # Run governance tests
```

## Startup Notes

- `coord/scripts/gov start <ticket-id>` now bootstraps missing canonical plan state, auto-seeds the startup/traceability attestation, repairs owner-scoped scaffold placeholders, and refreshes `origin/<base>` before new repo-backed branch creation unless `--offline` is explicit.
- `coord/scripts/gov unstart <ticket-id>` is the explicit same-owner wrong-start escape hatch. It only succeeds while the ticket is still at scaffold/start state: no PR/landing/review evidence, no meaningful implementation-plan content, and no workspace changes or commits.
- `coord/scripts/gov recover <ticket-id> --snapshot-restore` is the explicit non-live recovery path when a board row regresses after `review` or `done` and no canonical `doing` lock remains. It replays the strongest ticket-scoped restore payload recorded in the governance journal and fails closed if the historical evidence is incomplete.
- `coord/scripts/gov agents register` now requires explicit `--handle` and `--id` values and rejects handles that do not match the canonical provider-prefix pattern for that simple id.
- Canonical `doing` lock creation now uses create-if-absent semantics. If another writer wins the lock-create race first, governance fails closed and tells you to re-read the existing lock instead of overwriting it.
- Test / contract / infra tickets still require explicit baseline reproduction before start. Use `coord/scripts/gov plan <ticket-id> --baseline "Command: ..." --baseline "Outcome: ..."` when start blocks on that evidence.
- Repo-backed starts fail closed if `origin/<base>` cannot be refreshed and `--offline` was not given. Offline mode falls back to locally available refs.
- Repo-backed starts also print manifest-driven dependency bootstrap guidance and the canonical `scripts/gate.sh default` entrypoint for that repo.
- `coord/scripts/gov commit` now validates that the commit subject already contains the ticket ID. It uses targeted staging by default and only broad-stages the full governed diff when `--all` is explicit.
- `coord/scripts/governance-mcp.js` now speaks standard MCP stdio framing with `Content-Length` headers instead of newline-delimited JSON, so generic MCP clients can interoperate without a transport shim.
- When the governance MCP server is the active session host, it now runs a background heartbeat for the current `doing` ticket at the 5-minute target cadence while the governed worktree exists. Closing the MCP host process stops that timer and leaves the lock to age normally from its last heartbeat.
- Raw CLI or other non-MCP sessions still operate in mutation-triggered-only heartbeat mode unless a separate sidecar host is added.
- `coord/scripts/gov agent-rebind --fresh` now reserves a new handle with bounded retries and fails closed with a distinct exhaustion error if competing claims keep winning the reservation race.
