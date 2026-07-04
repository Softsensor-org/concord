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
coord/scripts/coord commands [--json]  # command metadata/reference
coord/scripts/coord init [--dir <path>] [--dry-run]
coord/scripts/coord onboard [<repo-path>] [--dry-run] [--write]
coord/scripts/coord track-presets [--json]
coord/scripts/coord authority-check [--canonical-input <path>] [--json]
coord/scripts/coord conformance [--json] [--attest] [--verify [<file>]]
coord/scripts/coord upgrade --from <dir|bundle> [--dir <target>] [--channel <c>] [--entitlement <tok>] [--ref <r>] [--sha <s>] [--dry-run] [--json]
coord/scripts/coord upgrade --check [--dir <target>] [--json]
```

- `command-registry.js` — machine-readable command metadata for product
  commands and incrementally-adopted governance verbs: command name, namespace,
  maturity, safety posture, summary, docs link, and UI command-palette flag.
  `coord help` uses these summaries through `coord-cli.js`, and
  `coord commands --json` emits the same metadata for docs/UI consumers.
- `coord-cli.js` — extensible subcommand dispatcher. Runtime dispatch remains a
  map of `{ name -> { summary, run(args) } }`, but summaries come from
  `command-registry.js` so help/docs/UI can share one source of truth. Adding a
  product subcommand means adding metadata plus a registry entry; lifecycle
  governance dispatch remains separate.
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
- `coord onboard` — guided adoption scanner for existing repos. It detects repo
  shape, recommends a governance tier, suggests a track preset, and prints the
  next setup steps. Default mode is dry-run/read-only; `--write` writes
  `coord/project.config.js` and `coord/setup.decisions.json` without clobbering
  existing files unless `--force` is also supplied.
- `coord track-presets` — prints the built-in adoption presets for common
  starting shapes (`web-app`, `data-service`, `content-site`, `infra`) so teams
  can pick a track profile before editing config.
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
  On success it also records the **GCV-4 upstream pin** `coord/.coord-engine.json`
  (`schema`/`engine_version`/`source.{repo,channel,ref,sha}`/`applied_at`) — the
  identity of WHERE the engine came from, distinct from `engine-pin.json` (in-tree
  integrity fingerprint). `--channel community|enterprise` records/switches the
  distribution channel; switching to **enterprise** is fail-closed and requires
  `--entitlement <token>` (or `CONCORD_ENTITLEMENT`) — the licensed in-place
  Community→Enterprise upgrade. `--ref`/`--sha` record the upstream ref/sha.
  `coord upgrade --check` is read-only: it reports **engine drift** (a
  manifest-tracked vendored file was hand-edited vs the pin, exit 1) separately
  from project drift (your own board/config/product/`.runtime` — yours to change,
  never flagged), and surfaces the pinned version/channel.
- `coord-init-starter-board.js` — the canonical clean starter-board shape,
  reused by BOTH `coord init` and the public release builder's clean-board step,
  so init and the release cut never disagree on what a fresh board looks like.
- `coord authority-check` — read-only canonical/derived authority inversion
  checker. It flags rendered/compatibility/memory artifacts used as canonical
  mutation input and points to `coord/product/CANONICAL_DERIVED_AUTHORITY.md`.

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
- `token-economics.js` — cost ledger, precheck, context-pack, plan-waves, sequencer-plan, merge-queue, dispatch-plan
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
- `gate-plan.js` — deterministic gate receipt planner (`gov gate-plan`): resolves
  ticket track, lane, risk class, affected-target slice/full fallback, selected
  and skipped gates, and required evidence. It is read-only unless `--write`
  records the receipt in the canonical plan record; it never executes gates.
- `gate-proc-registry.js` — gate PROCESS-orphan containment + provenance-scoped reaper (COORD-092): the pidfile registry under `coord/.runtime/gate-procs/<gate-run-id>.json` (gate-run-id, owning ticket/repo/lane, child PIDs/PGID, each PID's `/proc` start-time fingerprint = the PID-reuse guard, created-at), plus `detectOrphans` (read-only, used by `doctor-report.js`) and `reapOrphans` (mutating, used by `doctor-recovery.js`'s `doctor --fix` and the `gov reap-gate-procs` verb). The spawn-side `trap EXIT` in the template `*/scripts/gate.sh` registers + tears down tracked process groups so a clean run never leaks. The reaper signals ONLY recorded PIDs whose live start-time still byte-matches the recorded one — structurally never a process-name scan, so it cannot touch a process coord did not record. Also exposes a `register`/`cleanup`/`list`/`detect` CLI for the gate.sh shell to shell into
- `gates.js` — gate ATTRIBUTION + board-record surface: the `add-repo-gate` verb, `classifyGateAttribution`, and `formatRepoGateEntry`, as a DI factory (injects `updatePlanBlock` from `plan-command.js`; kept separate from `gate-runtime.js`'s execution surface)
- `track-evidence-policy.js` — shared cross-track evidence policy evaluator used
  by gate-plan and readiness checks. It centralizes marketing/devops/live-MCP/
  data/bootstrap evidence requirements and distinguishes advisory vs blocking
  findings by risk class.
- `canonical-derived-authority.js` — pure source-of-truth classifier/checker for
  coord artifacts. It powers `coord authority-check` and prevents derived views
  from becoming mutation authority.
- `decomposition-proof-gate.js` — fail-closed closeout/readiness gate for
  slimming/decomposition refactors. It parses `decomposition-proof:` evidence,
  recomputes `countLoc` for the named target, verifies before/after delta,
  target max, and prodloc ratchet budget, and blocks review when the measured
  outcome does not match the claim.
- `runtime-evidence.js` — production-MCP / deployment / server-bootstrap evidence receipts: operation-class policy, fail-closed receipt validators, local receipt writers, deployment artifact identity assertion, post-deploy runtime verification, and retroactive closure falsification. This module never calls production systems; adapters perform dangerous reads/writes and hand the resulting receipt to gov for validation/recording
- `landing-audit.js` — landing provenance / AUDIT surface, as a DI factory: the audit-report cluster (`collectLandingAuditReport`, `applyLandingAuditBackfill`, `formatLandingAuditSummary`, `collectLandingAuditCandidates`, `summarizeLandingAuditEntries`), the testing-infra / feature-proof landing audits (`ensureTestingInfrastructureLandingAudit`, `ensureFeatureProofLandingAudit`), and the landing-RECORD writers (`ensureLandingRecord`, `persistMergedPrLandingSnapshot`). Injects `classifyLandingRecord` / `deriveTestingInfrastructureAudit` / `deriveFeatureProofAudit` / `requiresLandingGovernance` from `governance-validation.js` (and injects `collectLandingAuditCandidates` back to it); `verifyPrEvidence` stays in `landing-gh.js`. Wired in `lifecycle.js` after `createGovernanceValidation`
- `questions.js` — QUESTIONS.md question handling: row parse/classify (severity + aging), orchestrator-queue reads, explain-questions guidance, `log-question`, and question-row append/remove writers
- `plan-command.js` — the `plan`/`update-plan` commands plus the plan-block mutation verbs (`add-review-cycle`, `set-review-cycles`, `set-requirement-closure`, `add-feature-proof`, `drop-feature-proof`), the start-seed builder, plan status/next-command payloads, and the plan-mutation authority gate (the `add-repo-gate` verb moved to `gates.js`)
- `ticket-transitions.js` — the ticket state machine (`start`, `submit`, `move-review`, `return-doing`, `mark-done`, `block`, `unblock`, `supersede`) plus the `applyMarkDone` and `persistReturnDoingState` transition primitives, as a DI factory (cross-module deps injected; consumed by the `closeout.js` land path and re-exported through `lifecycle.js`)
- `closeout.js` — the ticket closeout/land surface (`finalize`, `land`, `finishTicket`, `prepareDoneCloseout`) plus the closeout plan-update builders, as a DI factory; injects the `ticket-transitions` surface (`moveReview`/`markDone`/`applyMarkDone`) and provides `prepareDoneCloseout` back to transitions, so it is wired in `lifecycle.js` after `createTicketTransitions`
- `doctor-recovery.js` — the MUTATING governance repair/recovery surface (`doctorFix` behind `doctor --fix` and confirmed `doctor --repair-all`, `reconcileGovernance`, `recoverTicket`, plus the private session-mirror rebuild helper), as a DI factory; the read-only `doctor` report lives in `doctor-report.js` and delegates to the injected-back `doctorFix` only on `--fix` or `--repair-all` (dry-run by default; `--confirm` required to mutate)
- `doctor-report.js` — the READ-ONLY governance doctor REPORTING surface (`resolveDoctorScope`/`resolveDoctorOwnerScope`, the read-only `doctor()` report, and the `buildCanonicalDerivedDriftError` report builder), as a DI factory; injects `doctorFix` (from `doctor-recovery.js`) so the report can trigger repair on `--fix` without owning it, so it is wired in `lifecycle.js` after `createDoctorRecovery`
- `journal-retention.js` — read-only journal size/health classifier used by `doctor-report.js` to surface retention/rotation pressure before the append-only governance journal becomes an operability risk. It never rotates or compacts by itself; it reports event-count/byte thresholds, chain continuity metadata, and the policy pointer in `coord/product/JOURNAL_RETENTION_POLICY.md`
- `ticket-guidance.js` — the OPERATOR-GUIDANCE surface (`buildTicketNextCommands` per-status next-command planner, `explainTicket` read-only ticket explanation report, `runTicketCycle` recommended planner/worker/reviewer/closer cycle), as a DI factory; read-only (reads board/lock/plan/readiness state and emits guidance JSON, never mutates), so all cross-module deps — including the shared `buildPostCloseFollowupCommand` owned by `lifecycle.js` — are injected via deferred wrappers
- `fleet-golden-path.js` — read-only fleet rollout wrapper (`gov fleet-golden-path [ticket]`) that prints the safe multi-agent operating path: identity binding, prompt coverage, isolated worktree start, gate/context prework, closeout evidence wrappers, integration, and dry-run-first recovery.
- `guided-closeout.js` — read-only closeout guidance wrapper (`gov guided-closeout <ticket>`). It inspects the ticket plan, review cycles, repo gates, requirement closure, feature proofs, gate-plan receipt, and business-context disposition, then emits exact missing evidence and ready-to-paste repair commands. `--write` records a runtime guide receipt under `.runtime/closeout-guides/`.
- `governance-tier.js` — progressive-disclosure tier resolver (`gov governance-tier`). It reports the active governance tier (`lite`, `standard`, `full`) from CLI flags or project config while keeping `full` as the default.
- `publishability-check.js` — closeout publishability wrapper (`gov publishability-check <ticket>`). It classifies touched surfaces and tells the closer which template-sync, prodloc, leak-scan, or dual-release checks are required before a ticket that affects releaseable surfaces can be considered publishable.
- `track-presets.js` — reusable track-preset definitions and repo-shape suggestions consumed by `coord track-presets` and `coord onboard`.
- `onboard.js` — one-command adoption wizard for existing repos, backed by the pure `coord-init-wizard.js` adoption scanner and `track-presets.js`.
- `agent-commands.js` — the AGENT-COMMAND / claim-orchestration surface (`agentsCommand` list/register/enable/disable, `printCurrentAgentId`/`resolveCurrentAgentId`/`formatCurrentAgentIdPayload` agentid resolver, the `claim`/`claimTicket`/`claimAgent`/`claimAgentSession` cluster, `resumeTicket`, `releaseAgent`, `rebindAgent`, `resolveHumanAdminOverride`, `detectCwdTicketClaimHazard`, and `showAgentStatus`/`buildAgentStatusPayload`), as a DI factory; the COMMAND LAYER above the `governance-session.js` session engine — it injects the session/registry readers+writers, identity resolution, owner-lease metadata (`PROVIDER_REGISTRY`), board readers, the mutation/lock wrappers and the journal appender rather than duplicating session semantics, with `findLockForTicket`/`getLockFiles` and the journal/board binds injected as deferred wrappers; wired in `lifecycle.js` after `createGovernanceSession`
- `landing-resolution.js` — the landing COMMIT-RESOLUTION surface (`extractCommitShas`, `refreshLandingBaseRef`, `resolveLandingBaseRef`/`resolvePrLandingBaseRef`, `pickBestLandingCommit`, `resolveSourceCommitSha`, `resolveFulfilledByLandingCommit`, `resolveLandingCommitSha`), as a DI factory; owns git-ancestry / base-ref / source-commit resolution ONLY — it injects git-ancestry helpers (`resolveCommitishInRepo`/`fetchRepoRef`/`isCommitAncestorOfRef`), the repo registry, the ticket git-context helpers, and the ONE GH read it needs (`ghPrView`, plus `mergeUniqueRefs`/`toArray`) from `landing-gh.js` rather than re-implementing transport; GitHub PR TRANSPORT stays in `landing-gh.js` and landing AUDIT/record behavior stays in `landing-audit.js` (COORD-070). The commit-subject affiliation helpers (`readCommitSubject`/`commitSubjectAffiliatesWithTicket`) stay in `lifecycle.js` (review-state verification, not resolution). Wired in `lifecycle.js` after `landing-gh.js` and before `createLandingAudit` (which consumes the resolvers)
- `board-rebuild.js` — the board-rebuild-from-journal surface (`rebuildBoardFromJournal`, `terminalJournalStatusForTicket`, `collectTicketsWithJournalDrift`), as a DI factory; replays the governance event journal to repair `board/tasks.json` rows whose Status/Owner drifted from the journal's terminal succeeded event (GOV-012). Reads the journal/board and writes the board only inside the injected `withGovernanceMutation` envelope; injects `readGovernanceEventLog`/`readBoard`/`getTicketRef`/`writeBoard`/`fail` rather than owning any wiring. Wired in `lifecycle.js` AFTER `createJournal` (for `readGovernanceEventLog`/`withGovernanceMutation`) and `createGovernanceBoardState` (COORD-091)
- `arch-checks.js` — zero-dep code-quality analyzer library (size/monolith/prodloc/compositionRoot/complexity/import-boundary/duplication/hardcoding/deadcode). The `size` check supports a justified per-file budget override (`checks.size.perFile`, keyed by basename) so a legitimately large composition root (e.g. `lifecycle.js`) can carry its own documented budget instead of nagging against the global one; the hard `monolith` ceiling ignores `perFile` (COORD-091). The `prodloc` check (COORD-378/395) is the fail-closed coord/scripts production-module LOC ratchet: new non-test modules under `coord/scripts/**` must stay at or below 1200 logical LOC, while tracked decomposition hotspots carry strict high-water budgets at their current measured size. Shrink-only extraction should lower those high-water caps so growth cannot silently return. The `compositionRoot` check (COORD-396) is the fail-closed append-free hub guard: in ratchet/diff-aware gate runs, newly-added non-wiring logic in `lifecycle.js` or `governance-validation.js` fails and points the author to a self-registering module. The `hardcoding` check (QSCAN-001) is a low-noise config-seam-leak detector: inline filesystem paths, repeated multi-word string literals (≥ `minRepeats` distinct sites → shared constant), and opt-in magic numbers (off by default), with obvious-OK literals (URLs, module specifiers, enum/flag vocabulary, single occurrences, test files) filtered out. The `deadcode` check (QSCAN-001) flags top-level functions/consts that are provably unreferenced across the corpus — it is dispatch/facade/export-aware (a def stays live if referenced by bare identifier OR string-key dispatch table OR exported), prefers false negatives, and is always advisory (`warn`, never auto-fail). For subtree scans pass `referenceRoot` (a broader tree) so a def referenced from a sibling subtree (e.g. `coord/board`) is not mis-flagged
- `conformance-verbs.js` — the ENT conformance / engine-integrity CLI verb surface (`gov conform` = ENT-002 journal hash-chain self-verify + ENT-010 signed conformance attestation emit/verify; `gov verify-engine` = ENT-011 engine version-pin + drift-check), as a DI factory. Pure presentation glue over the two injected factories (`createConformanceAttestation`, `createEnginePin`): it builds them from injected `coordDir`/`verifyGovernanceChain`/`fail` and returns `conform`/`verifyEngine` for the `commands` map + `cli.js` cases. READ-ONLY except writing `conform --attest`'s gitignored attestation artifact + first-run keypair and `verify-engine --pin`'s committed `coord/engine-pin.json`. Extracted from `lifecycle.js` (COORD-107) to keep it under the documented 5000 composition-root size ceiling by EXTRACTION rather than a budget bump
- `lifecycle-help.js` — the lifecycle CLI presentation + thin command-wrapper surface (`printHelp`/`buildInitiateSummary`/`printInitiate` help text + session primer, plus the `recall`/`insights`/`coverage-rollup`/`prework`/`closeout-summary`/`learned-rule`/`sign-journal` thin wrappers — each validates args, lazily `require`s its own standalone engine, and emits output), as a DI factory. The only injected collaborators are `fail`, `ensureCurrentAgentIdentity`, the `GovernanceError` class, the live `state` config (by reference, so `__testing.paths` overrides propagate), and `COORD_DIR` — NO governance-mutation internals; `fs`/`path` are required directly. `lifecycle.js` wires it (deferred wrappers for `fail`/`ensureCurrentAgentIdentity`) and destructures the returns back into scope so the `commands` dispatch table and the `__testing` facade (`buildInitiateSummary`) resolve byte-identically. Extracted from `lifecycle.js` (COORD-281) to hold the 5000 composition-root size ceiling by EXTRACTION, alongside deleting the dead `requiresPrIndexGovernance` copy
- `ticket-commands.js` — the ticket state-mutation command surface (`fileTicket`/`gov file-ticket`+`new`, `openFollowup`, `unstartTicket`, `lockAbandonTicket`, `commitTicket`, and the read-only `collectUnstartEvidenceBlockers` guard the two reverts share), as a DI factory. The create verbs keep riding the COORD-220 `withBoardTransaction` / single-writer path — `reserveTicketId` arrives from the injected transaction, it is NOT reimplemented here. Every collaborator is injected (transaction primitives, board/ticket helpers, identity/ownership, git, the unstart-evidence helpers) plus the value consts `STATUS`/`ALLOWED_TICKET_TYPES`/`ALLOWED_PRIORITIES` by reference; `fs` is required directly. `lifecycle.js` wires it (deferred `(...a)=>fn(...a)` wrappers for the function deps) and re-destructures the six returns back into scope so the `commands` dispatch table, the `__testing` facade, and `splitTicket` (which calls `openFollowup`) resolve byte-identically. Extracted from `lifecycle.js` (COORD-282) to hold the 5000 composition-root size ceiling by EXTRACTION
- `testing-infra-audit.js` — the testing-infrastructure audit/classification helper cluster (`extractPackageScriptsFromCommands`, `buildTestingInfrastructureClassificationText`, `isTestingInfrastructureTicket`, `normalizeTestingInfraAuditPath`, `listCommitTouchedPaths`, `readJsonFileFromRef`, plus the private `sanitizePackageScriptToken`/`isTestingInfrastructureClassificationPath` helpers), as a DI factory. These decide whether a ticket touches testing infrastructure (description-pattern + planned-file classification) and the low-level git-ref reads (commit-touched paths / json-from-ref) and package-script extraction that feed that decision. `buildTestingInfrastructureClassificationText` is genuinely pure (no deps); the rest inject path/registry helpers (`normalizePlanPathValue`/`repoPrefixesForCode`/`escapeRegex`/`splitPlanPathValues`/`isTestingInfrastructureFilePath`), the shell tokenizer (`tokenizeShellWords`), and the git-ref read (`gitTry`) as deferred `(...a)=>fn(...a)` wrappers, with the value consts `REPO_ROOTS`/`PNPM_BUILTIN_COMMANDS`/`TESTING_INFRA_DESCRIPTION_PATTERN` injected by reference (`REPO_ROOTS` is mutated in place by the `__testing` registry setter, so the same object reference stays live). `lifecycle.js` wires it after the `createTicketCommands` block and re-destructures the six returns back into scope so the `commands` dispatch table, the `__testing` facade, and the audit call sites (`deriveTestingInfrastructureAudit`, `extractFileReferencesFromCommands`) resolve byte-identically. Extracted from `lifecycle.js` (COORD-283) to hold the 5000 composition-root size ceiling by EXTRACTION
- `sync-provenance.js` — the sync / provenance-baseline service (`runSyncCommand`, `commitCanonicalDelta`, `buildAutoSyncMessage`, `pushOnFinalizeEnabled`, `pushAfterLifecycleSync`, `lifecycleSyncScopePaths`, `advanceProvenanceBaselineAfterLifecycle`, `autoSyncAfterLifecycle`), as a DI factory. Owns the scoped canonical-delta sync (`gov sync`) and the post-mutation provenance-baseline advance that every terminal lifecycle verb runs after its governed mutation flips the board row to `done`. CRITICAL: the COORD-275 scope-checked baseline advance (`advanceGovernanceProvenanceBaseline` from `journal.js`) is INJECTED, NOT reimplemented — `lifecycleSyncScopePaths` derives the authorized canonical-derived + board-json scope and `advanceProvenanceBaselineAfterLifecycle` forwards it unchanged, so a concurrent out-of-band edit landing in the advance window is preserved as detectable drift (never silently re-baselined). COORD-246 (no spurious post-finalize drift), COORD-196 (atomic terminal board-row commit via `includeBoardJson`) and ENT-001 (opt-in push-on-finalize) behavior unchanged. Every collaborator (`runBoardSync`/`canonicalSyncablePaths`/`computeSyncDelta`/`isInsideGitWorkTree`/`relativeCoordPath`/`gitTry`/`fail`) injected as deferred `(...a)=>fn(...a)` wrappers, with `COORD_DIR`/`DEFAULT_PATHS` by reference and `path` required directly. `lifecycle.js` wires it after the journal-factory destructure (so the injected provenance advance is live) and re-destructures the eight returns back into scope so the `commands` dispatch table, the `__testing` facade, and `cli.js` resolve byte-identically. Extracted from `lifecycle.js` (COORD-292, decomposition slice #1 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `ticket-lock-service.js` — the ticket-lock service (`resolveLockHead`, `safeResolveLockHead`, `refreshLockHead`, `shouldUseLegacyLockCompatibility`, `existingLockDirs`, `resolveTicketLockPath`, `ensureDoingTicketLockIntegrity`), as a DI factory. Owns ticket-lock PATH resolution (new `.runtime/locks` vs legacy `locks` layout + opt-in legacy-lock promotion), lock-HEAD resolution/refresh, and the `doing`-ticket lock-integrity invariant (a `doing` ticket must always have a sound lock; when it has lost its lock the canonical worktree recreates it for the row's own owner). CRITICAL: NO lock behavior change — the governance-context lock-dir primitive (`state`, holding `LOCKS_DIR`/`LEGACY_LOCKS_DIR`) is INJECTED BY REFERENCE so the path helpers read live values at call time (tests swap them via `__testing.paths`), and the live-holder (COORD-270) + stale-lock primitives (the mkdir-mutex / `tryReclaimStaleDirectoryLock` / `writeDirectoryLockMetadata` in `governance-context.js`; `findLockForTicket` / `writeLock` / `moveFileIfNeeded` in `governance-session`/`lifecycle`) are INJECTED, NOT moved/reimplemented. Every collaborator injected as a deferred `(...a)=>fn(...a)` wrapper; `fs`/`path` are node builtins required directly. `lifecycle.js` wires it after the `createSyncProvenance` destructure and re-destructures the seven returns back into scope so the `commands` dispatch table, the `__testing` facade (`refreshLockHead`/`ensureDoingTicketLockIntegrity`), and the deferred wrappers other factories inject resolve byte-identically. Extracted from `lifecycle.js` (COORD-293, decomposition slice #2 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `ticket-queue-service.js` — the ticket QUEUE / ranking / recommendation service (`listTickets`, `pickTickets`, `recommendTickets`, `recommendationModeForAgent`, `summarizeBusyActiveAgents`, `listIdleActiveAgentSessions`, `buildReleaseCandidates`, `scoreTicket`, `buildDownstreamCounts`), as a DI factory. Owns ticket listing, the `pick`/`recommend` candidate ranking (the private `pick*`/`buildRecommendationSet`/`printRankedTicketList`/`formatRankedTicket`/`assignTicketsToAgents` helpers), the scoring model (`scoreTicket` + `modeBiasScore` mode bias), the downstream/dependency unblocks counts (`buildDownstreamCounts`), the mode-bias resolver, the idle/busy active-agent summaries, and agent-release-candidate planning. CRITICAL: NO behavior change — `gov counts/list/pick/recommend` output is byte-identical and the COORD-285 `proposed` exclusion is preserved from BOTH the downstream/unblocks count AND the recommendation candidate set (`buildRecommendationSet` considers only `STATUS.TODO`); ranking is moved verbatim. The governance-context primitive (`state`, holding `BOARD_PATH`) and the `STATUS` constant map are INJECTED BY REFERENCE; every collaborator (board readers `readBoard`/`getRows`, identity/owner `resolveOwnerIdentity`/`ensureCurrentAgentIdentity`/`maybeCanonicalOwner`/`findDoingTicketForOwner`, agent-session readers `readAgentsRegistry`/`readAgentSessions`/`resolveAgentIdentifier`/`compareSessionsMostRecentFirst`/`resolveEffectiveThreadId`, readiness/scoring `evaluateReadiness`/`splitDependsOn`/`isRepoBackedCode`, blocker formatting `formatTransitiveBlockerDetails`/`formatDependencyCycleList`, plus `integerOrDefault`/`fail`) is injected as a deferred `(...a)=>fn(...a)` wrapper. `compareSessionsMostRecentFirst` STAYS in `lifecycle.js` (governance-session also consumes it) and is injected here. `lifecycle.js` wires it after the `createTicketLockService` destructure and re-destructures the nine public returns back into scope so the `commands` dispatch table and the deferred wrappers other factories inject resolve byte-identically. (COORD-297 later dropped the redundant `buildReleaseCandidates` `__testing` re-export — that behavior is owned by `ticket-queue-service.test.js` via `svc.buildReleaseCandidates`, and `agent-commands.js` consumes it through DI injection, not the facade.) Extracted from `lifecycle.js` (COORD-294, decomposition slice #3 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `governance-plan-shape.js` — the governance PLAN-SHAPE service (`scaffoldSelfReviewCycle`, `buildDefaultGovernancePlan`, `normalizeGovernancePlanShape`, `formatGovernancePlanEntry`, `formatGovernanceReviewProfileEntry`, `formatGovernanceRepairEntry`, `parseGovernancePlanEntries`, `buildScaffoldPlanRecord`, `ensurePlanStub`), as a DI factory. Owns governance-plan normalization (the `governance` sub-record shape) and scaffold-plan construction — distinct from `plan-records.js` (canonical plan record IO) and `plan-command.js` (the `gov plan`/`update-plan` verbs). CRITICAL: NO behavior change — plan JSON/markdown round-trips byte-stable where expected (`normalizeGovernancePlanShape`/`parseGovernancePlanEntries`/`formatGovernancePlanEntry` + the review-profile/repair sibling formatters produce byte-identical output) and `buildDefaultGovernancePlan`/`buildScaffoldPlanRecord`/`ensurePlanStub`/`scaffoldSelfReviewCycle` yield identical plan records. COORD-007: `buildDefaultGovernancePlan` seeds `expected_closeout.base_ref` from the LIVE `REPO_INTEGRATION_BRANCHES` map, injected BY REFERENCE so the `__testing.paths.REPO_INTEGRATION_BRANCHES` in-place mutation propagates. Primitives (`state`, `REPO_INTEGRATION_BRANCHES`, `DEFAULT_INTEGRATION_BRANCH`, `isRepoBackedCode`, `repoNameForCode`, `toArray`, the state-io canonical readers/writers `readCanonicalTextFile`/`writeCanonicalTextFile`/`writeCanonicalJsonFile`) injected BY REFERENCE; the plan-record IO collaborators wired LATER by `createPlanRecords` (`readPlanRecord`/`extractPlanBlock`/`renderPlanRecordBlock`/`appendPlanBlock`/`syncPlanRecordFromBlock`/`planRecordPath`/`writePlanCompatibilityBlockFromRecord`) injected as deferred `(...a)=>fn(...a)` wrappers. `lifecycle.js` wires it EARLY (before `createGovernanceValidation`/`createPlanRecords`, which inject these shape functions) and re-destructures the nine returns back into scope so the `commands` dispatch table, the `__testing` facade (`buildDefaultGovernancePlan`/`ensurePlanStub`), and the deferred wrappers other factories inject resolve byte-identically. Extracted from `lifecycle.js` (COORD-295, decomposition slice #4 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `lifecycle-evidence.js` — the lifecycle PR / EVIDENCE-RESOLUTION service (`resolveTicketGitContext`, `resolvePrUrlForTicket`, `resolveLifecyclePrRefs`), as a DI factory. Owns resolving a ticket's git context (repo root / branch / worktree / lock, lock-first with a worktree fallback) and the closeout PR-ref decision tree — distinct from `landing-resolution.js` (commit-ancestry / base-ref / source-commit resolution) and `landing-audit.js` (provenance landing records), which stay SEPARATE modules wired alongside it (296 sits beside them, it does not absorb them). CRITICAL: NO behavior change — PR/no-PR evidence is byte-identical (the `--no-pr` X-lane and the PR-backed path resolve through the same `resolveLifecyclePrRefs` tree: explicit `--pr` refs → existing board `pr_index` refs → repo-backed branch PR discovery → fail-closed; `verifyPrEvidence` is INJECTED with `allowNoPr: true`, not reimplemented). The repo-registry/worktree-ops/landing-gh collaborators (`isRepoBackedCode`, `getRepoRoot`, `listGitWorktrees`, `inferTicketIdFromPath`, `isGitHubPrUrl`, `ghPrListByBranch`, `verifyPrEvidence`, `mergeUniqueRefs`, `toArray`) inject BY REFERENCE; the lifecycle-local hoisted `findLockForTicket`/`fail` inject as deferred `(...a)=>fn(...a)` wrappers. OWNERSHIP (COORD-088 re-confirmed): `readCommitSubject`/`commitSubjectAffiliatesWithTicket` are review-STATE verification used by `assertCommittedReviewState` (and `governance-validation.js`), NOT consumed by the three moved functions, so they were LEFT in `lifecycle.js` — `assertCommittedReviewState` is unchanged. `lifecycle.js` wires it after the repo-registry/worktree-ops/landing-gh destructures are live and re-destructures the three returns back into scope so the `commands` dispatch table and the deferred wrappers other factories inject (landing-resolution / worktree-ops / pr-ops / ticket-commands) resolve byte-identically. Extracted from `lifecycle.js` (COORD-296, decomposition slice #5 per the COORD-291 boundary contract — the last slice before the COORD-297 facade-shrink) to hold the 5000 composition-root size ceiling by EXTRACTION
- `lifecycle-board-commands.js`, `lifecycle-board-validate.js`, `lifecycle-gate-code-commands.js`, `lifecycle-journal-queries.js`, `lifecycle-landing-governance.js`, `lifecycle-lock-commands.js`, `lifecycle-maintenance-commands.js`, `lifecycle-repox-closeout.js`, `lifecycle-testing-paths.js`, `lifecycle-ticket-admin.js`, and `lifecycle-ticket-helpers.js` — COORD-397 residual lifecycle extraction modules. They move the remaining board/reporting, board-validation, gate-plan/code-context, journal-query, landing-threshold, lock, maintenance, Repo-X closeout, test-path, ticket-admin, and closeout-helper clusters out of `lifecycle.js` while preserving the same `commands` and `__testing` facade names. `lifecycle.js` is now ratcheted to 2599 logical LOC by `arch-checks` prodloc high-water.
- `lifecycle.js` — remaining orchestration hub: factory wiring and the residual lifecycle surface
- `cli.js` — command routing, flag parsing, `executeCommand()`, and `main()`

The remaining refactor work is to keep shrinking `lifecycle.js`, not to move the
public entry point. The target boundary — `lifecycle.js` as a **composition root
only** (requires + DI wiring + `commands` dispatch + `__testing` facade, no inline
domain logic) — and the explicit contracts for the next extraction slices are
defined in `coord/GOVERNANCE_ARCHITECTURE.md` § "Lifecycle composition-root
boundary (COORD-291)". Planned slices: `sync/provenance` (COORD-292), `lock`
(COORD-293), `queue`/ranking (COORD-294), `plan-shape` (COORD-295), `evidence`
(COORD-296), and `__testing` facade-shrink (COORD-297).

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

## Runtime, Deployment, And Production-MCP Evidence

These commands govern the boundary after code lands: production-MCP inspection,
server bootstrap/backfill jobs, deployment identity, runtime verification, and
later evidence that falsifies a prior closeout. They write local JSON receipts
under `coord/evidence/<kind>/`; receipt JSON is gitignored by default because it
can contain environment and deployment metadata. Teams that want to commit
sanitized receipts can change that policy deliberately.

```bash
coord/scripts/gov live-mcp-policy [--json]
coord/scripts/gov live-mcp-record <ticket-id> \
  --class <read_safe|read_sensitive|write_low|write_prod|destructive> \
  --adapter <adapter-name> --operation <operation> --scope <bounded-scope> \
  --redaction "<redaction-summary>" --approval "<approval-ref>" \
  --cleanup "<cleanup-ref>" --evidence "<receipt evidence>" --receipt-result observed

coord/scripts/gov bootstrap-record <ticket-id> \
  --job <job-name> --execution-mode <one-off-task|migration-runner|worker> \
  --resource-envelope "<cpu/memory/time budget>" \
  --idempotency "<claim/lease/checkpoint behavior>" \
  --observability "<marker/metric/log proof>" \
  --disable-rollback "<flag/rollback path>" \
  --evidence "<runtime proof>"

coord/scripts/gov deploy-record <ticket-id> \
  --environment <env> --commit <landed-sha> --build-source <build-sha> \
  --artifact <image-or-artifact-id> --running-artifact <deployed-artifact-id> \
  --deploy-id <taskdef-or-release-id> --operator <who-or-ci> \
  --rollback <previous-artifact-or-release>
coord/scripts/gov deploy-check <ticket-id> [--receipt <path>] [--json]

coord/scripts/gov verify <ticket-id> \
  --environment <env> --evidence-class <runtime|mcp-oracle|deploy|bootstrap|gate|fixture> \
  --receipt-result <pass|fail|observed|blocked> --claim "<claim being verified>" \
  --evidence "<runtime/oracle proof>"

coord/scripts/gov falsify <ticket-id> --by <incident-or-followup-ticket> \
  --reason "<what later evidence disproved>" --evidence "<runtime proof>"
coord/scripts/gov validate-receipt --receipt <path> [--json]
```

Fail-closed rules:

- `read_sensitive`, `write_prod`, and `destructive` production-MCP receipts
  require approval and redaction.
- `write_prod` and `destructive` receipts require cleanup evidence.
- deployment receipts fail if the running artifact differs from the recorded
  artifact or if the build source differs from the landed commit.
- server bootstrap receipts reject heavy/risky `api-startup` execution and
  idempotency claims that write the marker only after work completes.
- runtime closeout claims require an explicit evidence class; fixture/gate
  evidence is not interchangeable with runtime or MCP-oracle evidence.

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
