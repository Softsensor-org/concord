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
coord/scripts/coord upgrade [--dir <target>] [--channel <c>] [--json]
coord/scripts/coord upgrade --apply-plan <digest> [--dir <target>] [--json]
coord/scripts/coord upgrade --from <dir|bundle> [--dir <target>] [--channel <c>] [--entitlement <tok>] [--ref <r>] [--sha <s>] [--dry-run] [--json]
coord/scripts/coord upgrade --check [--dir <target>] [--json]
```

- `coord/engine/scripts/command-registry.js` (moved by COORD-873) — machine-readable command metadata for product
  commands and incrementally-adopted governance verbs: command name, namespace,
  maturity, safety posture, summary, docs link, and UI command-palette flag.
  `coord help` uses these summaries through `coord-cli.js`, and
  `coord commands --json` emits the same metadata for docs/UI consumers.
- `coord-cli.js` — extensible subcommand dispatcher. Runtime dispatch remains a
  map of `{ name -> { summary, run(args) } }`, but summaries come from
  `coord/engine/scripts/command-registry.js` so help/docs/UI can share one source of truth. Adding a
  product subcommand means adding metadata plus a registry entry; lifecycle
  governance dispatch remains separate.
- `coord/engine/scripts/coord-ui-launch.js` (moved by COORD-864) — app-local launcher wired by `create-concord` /
  `concord init` as `npm run coord-ui`. It resolves the repo root from its copied
  `coord/engine/scripts/` location, installs `frontend/apps/coord-ui` dependencies on
  first launch, sets `COORD_DIR` to this workspace's `coord/`, starts Next on
  port 3002, and tries to open the browser.
- `coord conformance` — one-shot, fail-closed conformance check. A PACKAGING
  command that COMPOSES the existing conformance engine (it reuses
  `coord/engine/scripts/conformance-verbs.js` `conform`/`verifyEngine`, the signed
  `coord/engine/scripts/conformance-attestation.js` producer, and `coord/engine/scripts/engine-pin.js` — no crypto or
  conformance logic is reimplemented). Default: run the journal hash-chain
  self-verify (ENT-002) and print a human summary, exit 0 on pass / non-zero on
  fail. `--json` emits the engine's machine report. `--attest` ALSO emits a
  signed ed25519 attestation over the engine-integrity inputs (ENT-010).
  `--verify [<file>]` verifies an existing attestation (an explicit path, or the
  most recent emitted one) — the load-bearing fail-closed gate — and reports the
  engine-pin drift check (ENT-011) as informational.
- `coord init` — idempotent, **no-clobber** zero→governed-board bootstrap for a
  target repo (default cwd, or `--dir <path>`): scaffolds the
  `coord/project.config.js` seam if missing, seeds the SETUP-001..009 starter
  adoption ladder if the board is absent, and ensures the `coord/product/` spec
  stubs exist. The default board contains no fictional sample or product tickets.
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
  then **re-pins** and **verifies** — REUSING `coord/engine/scripts/engine-pin.js`
  (`createEnginePin(...).pin()`/`.verify()`); no fingerprint/verify logic is
  reimplemented. It diffs the source surface against the target (add / update /
  mode / remove / unchanged), while board, `project.config.js`, and product files
  remain outside the managed surface. Locks, durable recovery journals, and
  redacted receipts live under `.runtime`. One exclusive target lock spans
  resolution through receipt publication. Automatic plan digests bind source
  identity, target hashes, modes where supported, and upstream-pin bytes; apply
  revalidates before mutation. POSIX modes are copied and verified. Windows
  skips POSIX execute-bit enforcement and preserves existing update modes.
  A retired exact-match file is removed only when its bytes still match the old
  manifest; a locally changed retired path is refused. The three COORD-587
  `coord/gates/` legacy copies of the `coord/engine/gates/` files (an explicit
  list; no other `coord/<x>` is treated as one) follow their engine copy while
  byte-identical to the installed engine copy or to a legacy copy the template
  shipped; a locally changed legacy copy is refused the same way (COORD-884).
  Failures attempt exact
  byte/mode rollback, and incomplete restores retain their durable journal for
  explicit recovery. Idempotent: upgrading to the same version is a no-op (exit
  0). `--dry-run` does not change engine or pin files; `--json` emits a
  machine-readable result.
  On success it also records the **GCV-4 upstream pin** `coord/.coord-engine.json`
  (`schema`/`engine_version`/`source.{repo,channel,ref,sha}`/`applied_at`) — the
  identity of WHERE the engine came from, distinct from `engine-pin.json` (in-tree
  integrity fingerprint). `--channel community|enterprise` records/switches the
  distribution channel; switching to **enterprise** is fail-closed and requires
  `--entitlement <token>` (or `CONCORD_ENTITLEMENT`) — the licensed in-place
  Community→Enterprise upgrade. `--ref`/`--sha` record the upstream ref/sha.
  `coord upgrade --check` is read-only: it reports **engine drift** (content or
  POSIX mode changes vs the pin, exit 1), active locks, and interrupted recovery
  journals separately from project drift, and surfaces the pinned
  version/channel.
- `coord/engine/scripts/coord-init-starter-board.js` (moved by COORD-870) — the canonical clean starter-board shape,
  reused by BOTH `coord init` and the public release builder's clean-board step,
  so init and the release cut never disagree on what a fresh board looks like.
- `coord authority-check` — read-only canonical/derived authority inversion
  checker. It flags rendered/compatibility/memory artifacts used as canonical
  mutation input and points to `coord/product/CANONICAL_DERIVED_AUTHORITY.md`.

## Governance Module Layout

`governance.js` is the stable public facade. It keeps compatibility for the
`gov` wrapper, MCP adapter, tests, and downstream template-sync consumers.

Current core modules are flat under `coord/scripts/`:

- `coord/engine/scripts/governance-context.js` (moved by COORD-873) — shared path state, lock-depth counters, path accessors, `GovernanceError`, `defaultFail`
- `coord/engine/scripts/git-ops.js` (moved by COORD-869) — single-sourced raw git invocation: `gitTry` (tolerant `{status,stdout,stderr}` primitive) plus generic-message `runGit`/`gitOutput` wrappers
- `coord/engine/scripts/state-io.js` (moved by COORD-873) — canonical state reads/writes, snapshots, atomic writes
- `coord/engine/scripts/governance-board-state.js` (moved by COORD-873) — board IO, row lookup, sync triggers, and simple index/status reducers
- `coord/engine/scripts/journal.js` (moved by COORD-868) — event log append/read/replay and journal repair primitives
- `coord/engine/scripts/plan-records.js` (moved by COORD-873) — plan record parsing, rendering, and IO
- `coord/engine/scripts/landing-gh.js` (moved by COORD-869) — GitHub PR transport and retry helpers
- `coord/engine/scripts/token-economics.js` (moved by COORD-871) — cost ledger, precheck, context-pack, plan-waves, sequencer-plan, merge-queue, dispatch-plan
- `coord/engine/scripts/followups.js` (moved by COORD-873) — follow-up relations and exceptions
- `coord/engine/scripts/governance-session.js` (moved by COORD-873) — agent/session registry, provider identity, liveness, and lock identity helpers
- `coord/engine/scripts/verb-parity.js` (moved by COORD-873) — documented verb/flag parity scanners
- `coord/engine/scripts/prompt-coverage.js` (moved by COORD-867) — prompt registration, likely-file seeding, and precondition checks
- `coord/engine/scripts/governance-validation.js` (moved by COORD-873) — readiness, review-plan, feature-proof, testing-infrastructure, and landing validation helpers
- `coord/engine/scripts/lifecycle-utils.js` (moved by COORD-888) — pure, dependency-free helpers (slugify, integerOrDefault, inferNextRound, todayIso, escapeTable, escapeRegex, shellEscape)
- `coord/engine/scripts/repo-registry.js` (moved by COORD-873) — repo-code resolution (roots, names, prefixes, CLI aliases, integration branches)
- `coord/engine/scripts/lifecycle-flags.js` (moved by COORD-888) — CLI flag parsing for lifecycle subcommands (`parseLifecycleFlags` + helpers)
- `coord/engine/scripts/worktree-ops.js` (moved by COORD-869) — git primitives plus worktree create/cleanup/audit (including closed-ticket workspace cleanup) and branch preflight/push
- `coord/engine/scripts/governance-repair.js` (moved by COORD-873) — read-only doctor report/classification helpers (template-feedback alerts, question-queue, drift guidance, stale-lock)
- `coord/engine/scripts/pr-ops.js` (moved by COORD-869) — GitHub PR operations (view/create/merge)
- `coord/engine/scripts/runtime-cleanup.js` (moved by COORD-873) — runtime lock status/break, rollback-drift detection, and clean-runtime scratch collection/removal
- `coord/engine/scripts/gate-runtime.js` (moved by COORD-867) — gate EXECUTION: gate script/invocation/artifact-dir resolution, package-manager detection, and the clean-checkout gate runner
- `coord/engine/scripts/gate-plan.js` (moved by COORD-867) — deterministic gate receipt planner (`gov gate-plan`): resolves
  ticket track, lane, risk class, affected-target slice/full fallback, selected
  and skipped gates, and required evidence. It is read-only unless `--write`
  records the receipt in the canonical plan record; it never executes gates.
- `coord/engine/scripts/gate-proc-registry.js` (moved by COORD-867) — gate PROCESS-orphan containment + provenance-scoped reaper (COORD-092): the pidfile registry under `coord/.runtime/gate-procs/<gate-run-id>.json` (gate-run-id, owning ticket/repo/lane, child PIDs/PGID, each PID's `/proc` start-time fingerprint = the PID-reuse guard, created-at), plus `detectOrphans` (read-only, used by `coord/engine/scripts/doctor-report.js`) and `reapOrphans` (mutating, used by `coord/engine/scripts/doctor-recovery.js`'s `doctor --fix` and the `gov reap-gate-procs` verb). The spawn-side `trap EXIT` in the template `*/scripts/gate.sh` registers + tears down tracked process groups so a clean run never leaks. The reaper signals ONLY recorded PIDs whose live start-time still byte-matches the recorded one — structurally never a process-name scan, so it cannot touch a process coord did not record. Also exposes a `register`/`cleanup`/`list`/`detect` CLI for the gate.sh shell to shell into
- `coord/engine/scripts/gates.js` (moved by COORD-867) — gate ATTRIBUTION + board-record surface: the `add-repo-gate` verb, `classifyGateAttribution`, and `formatRepoGateEntry`, as a DI factory (injects `updatePlanBlock` from `coord/engine/scripts/plan-command.js`; kept separate from `coord/engine/scripts/gate-runtime.js`'s execution surface)
- `coord/engine/scripts/track-evidence-policy.js` (moved by COORD-867) — shared cross-track evidence policy evaluator used
  by gate-plan and readiness checks. It centralizes marketing/devops/live-MCP/
  data/bootstrap evidence requirements and distinguishes advisory vs blocking
  findings by risk class.
- `coord/engine/scripts/canonical-derived-authority.js` (moved by COORD-870) — pure source-of-truth classifier/checker for
  coord artifacts. It powers `coord authority-check` and prevents derived views
  from becoming mutation authority.
- `coord/engine/scripts/decomposition-proof-gate.js` (moved by COORD-867) — fail-closed closeout/readiness gate for
  slimming/decomposition refactors. It parses `decomposition-proof:` evidence,
  recomputes `countLoc` for the named target, verifies before/after delta,
  target max, and prodloc ratchet budget, and blocks review when the measured
  outcome does not match the claim.
- `coord/engine/scripts/runtime-evidence.js` (moved by COORD-871) — production-MCP / deployment / server-bootstrap evidence receipts: operation-class policy, fail-closed receipt validators, local receipt writers, deployment artifact identity assertion, post-deploy runtime verification, and retroactive closure falsification. This module never calls production systems; adapters perform dangerous reads/writes and hand the resulting receipt to gov for validation/recording
- `coord/engine/scripts/landing-audit.js` (moved by COORD-869) — landing provenance / AUDIT surface, as a DI factory: the audit-report cluster (`collectLandingAuditReport`, `applyLandingAuditBackfill`, `formatLandingAuditSummary`, `collectLandingAuditCandidates`, `summarizeLandingAuditEntries`), the testing-infra / feature-proof landing audits (`ensureTestingInfrastructureLandingAudit`, `ensureFeatureProofLandingAudit`), and the landing-RECORD writers (`ensureLandingRecord`, `persistMergedPrLandingSnapshot`). Injects `classifyLandingRecord` / `deriveTestingInfrastructureAudit` / `deriveFeatureProofAudit` / `requiresLandingGovernance` from `coord/engine/scripts/governance-validation.js` (and injects `collectLandingAuditCandidates` back to it); `verifyPrEvidence` stays in `coord/engine/scripts/landing-gh.js`. Wired in `coord/engine/scripts/lifecycle.js` after `createGovernanceValidation`
- `coord/engine/scripts/questions.js` (moved by COORD-873) — QUESTIONS.md question handling: row parse/classify (severity + aging), orchestrator-queue reads, explain-questions guidance, `log-question`, and question-row append/remove writers
- `coord/engine/scripts/plan-command.js` (moved by COORD-873) — the `plan`/`update-plan` commands plus the plan-block mutation verbs (`add-review-cycle`, `set-review-cycles`, `set-requirement-closure`, `add-feature-proof`, `drop-feature-proof`), the start-seed builder, plan status/next-command payloads, and the plan-mutation authority gate (the `add-repo-gate` verb moved to `coord/engine/scripts/gates.js`)
- `coord/engine/scripts/ticket-transitions.js` (moved by COORD-873) — the ticket state machine (`start`, `submit`, `move-review`, `return-doing`, `mark-done`, `block`, `unblock`, `supersede`) plus the `applyMarkDone` and `persistReturnDoingState` transition primitives, as a DI factory (cross-module deps injected; consumed by the `coord/engine/scripts/closeout.js` land path and re-exported through `coord/engine/scripts/lifecycle.js`)
- `coord/engine/scripts/closeout.js` (moved by COORD-869) — the ticket closeout/land surface (`finalize`, `land`, `finishTicket`, `prepareDoneCloseout`) plus the closeout plan-update builders, as a DI factory; injects the `ticket-transitions` surface (`moveReview`/`markDone`/`applyMarkDone`) and provides `prepareDoneCloseout` back to transitions, so it is wired in `coord/engine/scripts/lifecycle.js` after `createTicketTransitions`
- `coord/engine/scripts/doctor-recovery.js` (moved by COORD-873) — the MUTATING governance repair/recovery surface (`doctorFix` behind `doctor --fix` and confirmed `doctor --repair-all`, `reconcileGovernance`, `recoverTicket`, plus the private session-mirror rebuild helper), as a DI factory; the read-only `doctor` report lives in `coord/engine/scripts/doctor-report.js` and delegates to the injected-back `doctorFix` only on `--fix` or `--repair-all` (dry-run by default; `--confirm` required to mutate)
- `coord/engine/scripts/doctor-report.js` (moved by COORD-873) — the READ-ONLY governance doctor REPORTING surface (`resolveDoctorScope`/`resolveDoctorOwnerScope`, the read-only `doctor()` report, and the `buildCanonicalDerivedDriftError` report builder), as a DI factory; injects `doctorFix` (from `coord/engine/scripts/doctor-recovery.js`) so the report can trigger repair on `--fix` without owning it, so it is wired in `coord/engine/scripts/lifecycle.js` after `createDoctorRecovery`
- `coord/engine/scripts/journal-retention.js` (moved by COORD-868) — read-only journal size/health classifier used by `coord/engine/scripts/doctor-report.js` to surface retention/rotation pressure before the append-only governance journal becomes an operability risk. It never rotates or compacts by itself; it reports event-count/byte thresholds, chain continuity metadata, and the policy pointer in `coord/product/JOURNAL_RETENTION_POLICY.md`
- `coord/engine/scripts/ticket-guidance.js` (moved by COORD-873) — the OPERATOR-GUIDANCE surface (`buildTicketNextCommands` per-status next-command planner, `explainTicket` read-only ticket explanation report, `runTicketCycle` recommended planner/worker/reviewer/closer cycle), as a DI factory; read-only (reads board/lock/plan/readiness state and emits guidance JSON, never mutates), so all cross-module deps — including the shared `buildPostCloseFollowupCommand` owned by `coord/engine/scripts/lifecycle.js` — are injected via deferred wrappers
- `coord/engine/scripts/fleet-golden-path.js` (moved by COORD-871) — read-only fleet rollout wrapper (`gov fleet-golden-path [ticket]`) that prints the safe multi-agent operating path: identity binding, prompt coverage, isolated worktree start, gate/context prework, closeout evidence wrappers, integration, and dry-run-first recovery.
- `coord/engine/scripts/guided-closeout.js` (moved by COORD-888) — read-only closeout guidance wrapper (`gov guided-closeout <ticket>`). It inspects the ticket plan, review cycles, repo gates, requirement closure, feature proofs, gate-plan receipt, and business-context disposition, then emits exact missing evidence and ready-to-paste repair commands. `--write` records a runtime guide receipt under `.runtime/closeout-guides/`.
- `coord/engine/scripts/context-pack-ack-contract.js` (moved by COORD-873) — the ONE `context_pack_ack` shape contract for lifecycle consumers. `contextPackAckViolation` delegates to the writer's own strict `assertValidContextPackAck` (no second rule set), and the review gate (`coord/engine/scripts/gates/context-pack-ack.js`, hence readiness, `guided-closeout`, `pr-create`, `submit` and closeout) and `claim` / `claim --transfer-to` all ask it before any side effect. Also holds the raw, non-normalizing stored-record read and the deterministic read-only scan.
- `coord/engine/scripts/context-pack-ack-commands.js` (moved by COORD-873) — operator surface over that contract: `gov scan-context-pack-acks [--json]` (read-only, exits 1 when any stored acknowledgement is malformed) and `gov repair-context-pack-ack <ticket> --context-pack-ack '<json>' [--confirm]` (dry-run unless `--confirm`; the replacement is always operator-authored and never derived from the stored value; the write goes through the journaled `update-plan` mutation). Also `gov set-context-pack-ack <ticket>`: read-only display of the cited packs' non-empty sections and item ids, per-section authoring (`--considered <section>=<text>` for all six sections, refs machine-filled, section text never taken from the pack), and the explicit `--not-applicable --reason` disposition recorded in the journal event. `assertContextPackAckWriteReady` (in the contract module, called by `coord/engine/scripts/plan-command.js`) makes every acknowledgement write run the review gate's own checks and refuse before anything is kept.
- `coord/engine/scripts/governance-tier.js` (moved by COORD-873) — progressive-disclosure tier resolver (`gov governance-tier`). It reports the active governance tier (`lite`, `standard`, `full`) from CLI flags or project config while keeping `full` as the default.
- `coord/engine/scripts/publishability-check.js` (moved by COORD-867) — closeout publishability wrapper (`gov publishability-check <ticket>`). It classifies touched surfaces and tells the closer which template-sync, prodloc, leak-scan, or dual-release checks are required before a ticket that affects releaseable surfaces can be considered publishable.
- `coord/engine/scripts/track-presets.js` (moved by COORD-866) — reusable track-preset definitions and repo-shape suggestions consumed by `coord track-presets` and `coord onboard`.
- `coord/engine/scripts/onboard.js` (moved by COORD-866) — one-command adoption wizard for existing repos, backed by the pure `coord/engine/scripts/coord-init-wizard.js` adoption scanner and `coord/engine/scripts/track-presets.js`.
- `coord/engine/scripts/agent-commands.js` (moved by COORD-871) — the AGENT-COMMAND / claim-orchestration surface (`agentsCommand` list/register/enable/disable, `printCurrentAgentId`/`resolveCurrentAgentId`/`formatCurrentAgentIdPayload` agentid resolver, the `claim`/`claimTicket`/`claimAgent`/`claimAgentSession` cluster, `resumeTicket`, `releaseAgent`, `rebindAgent`, `resolveHumanAdminOverride`, `detectCwdTicketClaimHazard`, and `showAgentStatus`/`buildAgentStatusPayload`), as a DI factory; the COMMAND LAYER above the `coord/engine/scripts/governance-session.js` session engine — it injects the session/registry readers+writers, identity resolution, owner-lease metadata (`PROVIDER_REGISTRY`), board readers, the mutation/lock wrappers and the journal appender rather than duplicating session semantics, with `findLockForTicket`/`getLockFiles` and the journal/board binds injected as deferred wrappers; wired in `coord/engine/scripts/lifecycle.js` after `createGovernanceSession`
- `coord/engine/scripts/landing-resolution.js` (moved by COORD-869) — the landing COMMIT-RESOLUTION surface (`extractCommitShas`, `refreshLandingBaseRef`, `resolveLandingBaseRef`/`resolvePrLandingBaseRef`, `pickBestLandingCommit`, `resolveSourceCommitSha`, `resolveFulfilledByLandingCommit`, `resolveLandingCommitSha`), as a DI factory; owns git-ancestry / base-ref / source-commit resolution ONLY — it injects git-ancestry helpers (`resolveCommitishInRepo`/`fetchRepoRef`/`isCommitAncestorOfRef`), the repo registry, the ticket git-context helpers, and the ONE GH read it needs (`ghPrView`, plus `mergeUniqueRefs`/`toArray`) from `coord/engine/scripts/landing-gh.js` rather than re-implementing transport; GitHub PR TRANSPORT stays in `coord/engine/scripts/landing-gh.js` and landing AUDIT/record behavior stays in `coord/engine/scripts/landing-audit.js` (COORD-070). The commit-subject affiliation helpers (`readCommitSubject`/`commitSubjectAffiliatesWithTicket`) stay in `coord/engine/scripts/lifecycle.js` (review-state verification, not resolution). Wired in `coord/engine/scripts/lifecycle.js` after `coord/engine/scripts/landing-gh.js` and before `createLandingAudit` (which consumes the resolvers)
- `coord/engine/scripts/board-rebuild.js` (moved by COORD-864) — the board-rebuild-from-journal surface (`rebuildBoardFromJournal`, `terminalJournalStatusForTicket`, `collectTicketsWithJournalDrift`), as a DI factory; replays the governance event journal to repair `board/tasks.json` rows whose Status/Owner drifted from the journal's terminal succeeded event (GOV-012). Reads the journal/board and writes the board only inside the injected `withGovernanceMutation` envelope; injects `readGovernanceEventLog`/`readBoard`/`getTicketRef`/`writeBoard`/`fail` rather than owning any wiring. Wired in `coord/engine/scripts/lifecycle.js` AFTER `createJournal` (for `readGovernanceEventLog`/`withGovernanceMutation`) and `createGovernanceBoardState` (COORD-091)
- `coord/engine/scripts/arch-checks.js` (moved by COORD-867) — zero-dep code-quality analyzer library (size/monolith/prodloc/compositionRoot/complexity/import-boundary/duplication/hardcoding/deadcode). The `size` check supports a justified per-file budget override (`checks.size.perFile`, keyed by basename) so a legitimately large composition root (e.g. `coord/engine/scripts/lifecycle.js`) can carry its own documented budget instead of nagging against the global one; the hard `monolith` ceiling ignores `perFile` (COORD-091). The `prodloc` check (COORD-378/395) is the fail-closed coord/scripts production-module LOC ratchet: new non-test modules under `coord/scripts/**` must stay at or below 1200 logical LOC, while tracked decomposition hotspots carry strict high-water budgets at their current measured size. Shrink-only extraction should lower those high-water caps so growth cannot silently return. The `compositionRoot` check (COORD-396) is the fail-closed append-free hub guard: in ratchet/diff-aware gate runs, newly-added non-wiring logic in `coord/engine/scripts/lifecycle.js` or `coord/engine/scripts/governance-validation.js` fails and points the author to a self-registering module. The `hardcoding` check (QSCAN-001) is a low-noise config-seam-leak detector: inline filesystem paths, repeated multi-word string literals (≥ `minRepeats` distinct sites → shared constant), and opt-in magic numbers (off by default), with obvious-OK literals (URLs, module specifiers, enum/flag vocabulary, single occurrences, test files) filtered out. The `deadcode` check (QSCAN-001) flags top-level functions/consts that are provably unreferenced across the corpus — it is dispatch/facade/export-aware (a def stays live if referenced by bare identifier OR string-key dispatch table OR exported), prefers false negatives, and is always advisory (`warn`, never auto-fail). For subtree scans pass `referenceRoot` (a broader tree) so a def referenced from a sibling subtree (e.g. `coord/board`) is not mis-flagged
- `coord/engine/scripts/conformance-verbs.js` (moved by COORD-870) — the ENT conformance / engine-integrity CLI verb surface (`gov conform` = ENT-002 journal hash-chain self-verify + ENT-010 signed conformance attestation emit/verify; `gov verify-engine` = ENT-011 engine version-pin + drift-check), as a DI factory. Pure presentation glue over the two injected factories (`createConformanceAttestation`, `createEnginePin`): it builds them from injected `coordDir`/`verifyGovernanceChain`/`fail` and returns `conform`/`verifyEngine` for the `commands` map + `coord/engine/scripts/cli.js` cases. READ-ONLY except writing `conform --attest`'s gitignored attestation artifact + first-run keypair and `verify-engine --pin`'s committed `coord/engine-pin.json`. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-107) to keep it under the documented 5000 composition-root size ceiling by EXTRACTION rather than a budget bump
- `coord/engine/scripts/lifecycle-help.js` (moved by COORD-888) — the lifecycle CLI presentation + thin command-wrapper surface (`printHelp`/`buildInitiateSummary`/`printInitiate` help text + session primer, plus the `recall`/`insights`/`coverage-rollup`/`prework`/`closeout-summary`/`learned-rule`/`sign-journal` thin wrappers — each validates args, lazily `require`s its own standalone engine, and emits output), as a DI factory. The only injected collaborators are `fail`, `ensureCurrentAgentIdentity`, the `GovernanceError` class, the live `state` config (by reference, so `__testing.paths` overrides propagate), and `COORD_DIR` — NO governance-mutation internals; `fs`/`path` are required directly. `coord/engine/scripts/lifecycle.js` wires it (deferred wrappers for `fail`/`ensureCurrentAgentIdentity`) and destructures the returns back into scope so the `commands` dispatch table and the `__testing` facade (`buildInitiateSummary`) resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-281) to hold the 5000 composition-root size ceiling by EXTRACTION, alongside deleting the dead `requiresPrIndexGovernance` copy
- `coord/engine/scripts/ticket-commands.js` (moved by COORD-873) — the ticket state-mutation command surface (`fileTicket`/`gov file-ticket`+`new`, `openFollowup`, `unstartTicket`, `lockAbandonTicket`, `commitTicket`, and the read-only `collectUnstartEvidenceBlockers` guard the two reverts share), as a DI factory. The create verbs keep riding the COORD-220 `withBoardTransaction` / single-writer path — `reserveTicketId` arrives from the injected transaction, it is NOT reimplemented here. Every collaborator is injected (transaction primitives, board/ticket helpers, identity/ownership, git, the unstart-evidence helpers) plus the value consts `STATUS`/`ALLOWED_TICKET_TYPES`/`ALLOWED_PRIORITIES` by reference; `fs` is required directly. `coord/engine/scripts/lifecycle.js` wires it (deferred `(...a)=>fn(...a)` wrappers for the function deps) and re-destructures the six returns back into scope so the `commands` dispatch table, the `__testing` facade, and `splitTicket` (which calls `openFollowup`) resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-282) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/testing-infra-audit.js` (moved by COORD-873) — the testing-infrastructure audit/classification helper cluster (`extractPackageScriptsFromCommands`, `buildTestingInfrastructureClassificationText`, `isTestingInfrastructureTicket`, `normalizeTestingInfraAuditPath`, `listCommitTouchedPaths`, `readJsonFileFromRef`, plus the private `sanitizePackageScriptToken`/`isTestingInfrastructureClassificationPath` helpers), as a DI factory. These decide whether a ticket touches testing infrastructure (description-pattern + planned-file classification) and the low-level git-ref reads (commit-touched paths / json-from-ref) and package-script extraction that feed that decision. `buildTestingInfrastructureClassificationText` is genuinely pure (no deps); the rest inject path/registry helpers (`normalizePlanPathValue`/`repoPrefixesForCode`/`escapeRegex`/`splitPlanPathValues`/`isTestingInfrastructureFilePath`), the shell tokenizer (`tokenizeShellWords`), and the git-ref read (`gitTry`) as deferred `(...a)=>fn(...a)` wrappers, with the value consts `REPO_ROOTS`/`PNPM_BUILTIN_COMMANDS`/`TESTING_INFRA_DESCRIPTION_PATTERN` injected by reference (`REPO_ROOTS` is mutated in place by the `__testing` registry setter, so the same object reference stays live). `coord/engine/scripts/lifecycle.js` wires it after the `createTicketCommands` block and re-destructures the six returns back into scope so the `commands` dispatch table, the `__testing` facade, and the audit call sites (`deriveTestingInfrastructureAudit`, `extractFileReferencesFromCommands`) resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-283) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/sync-provenance.js` (moved by COORD-870) — the sync / provenance-baseline service (`runSyncCommand`, `commitCanonicalDelta`, `buildAutoSyncMessage`, `pushOnFinalizeEnabled`, `pushAfterLifecycleSync`, `lifecycleSyncScopePaths`, `advanceProvenanceBaselineAfterLifecycle`, `autoSyncAfterLifecycle`), as a DI factory. Owns the scoped canonical-delta sync (`gov sync`) and the post-mutation provenance-baseline advance that every terminal lifecycle verb runs after its governed mutation flips the board row to `done`. CRITICAL: the COORD-275 scope-checked baseline advance (`advanceGovernanceProvenanceBaseline` from `coord/engine/scripts/journal.js`) is INJECTED, NOT reimplemented — `lifecycleSyncScopePaths` derives the authorized canonical-derived + board-json scope and `advanceProvenanceBaselineAfterLifecycle` forwards it unchanged, so a concurrent out-of-band edit landing in the advance window is preserved as detectable drift (never silently re-baselined). COORD-246 (no spurious post-finalize drift), COORD-196 (atomic terminal board-row commit via `includeBoardJson`) and ENT-001 (opt-in push-on-finalize) behavior unchanged. Every collaborator (`runBoardSync`/`canonicalSyncablePaths`/`computeSyncDelta`/`isInsideGitWorkTree`/`relativeCoordPath`/`gitTry`/`fail`) injected as deferred `(...a)=>fn(...a)` wrappers, with `COORD_DIR`/`DEFAULT_PATHS` by reference and `path` required directly. `coord/engine/scripts/lifecycle.js` wires it after the journal-factory destructure (so the injected provenance advance is live) and re-destructures the eight returns back into scope so the `commands` dispatch table, the `__testing` facade, and `coord/engine/scripts/cli.js` resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-292, decomposition slice #1 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/ticket-lock-service.js` (moved by COORD-873) — the ticket-lock service (`resolveLockHead`, `safeResolveLockHead`, `refreshLockHead`, `shouldUseLegacyLockCompatibility`, `existingLockDirs`, `resolveTicketLockPath`, `ensureDoingTicketLockIntegrity`), as a DI factory. Owns ticket-lock PATH resolution (new `.runtime/locks` vs legacy `locks` layout + opt-in legacy-lock promotion), lock-HEAD resolution/refresh, and the `doing`-ticket lock-integrity invariant (a `doing` ticket must always have a sound lock; when it has lost its lock the canonical worktree recreates it for the row's own owner). CRITICAL: NO lock behavior change — the governance-context lock-dir primitive (`state`, holding `LOCKS_DIR`/`LEGACY_LOCKS_DIR`) is INJECTED BY REFERENCE so the path helpers read live values at call time (tests swap them via `__testing.paths`), and the live-holder (COORD-270) + stale-lock primitives (the mkdir-mutex / `tryReclaimStaleDirectoryLock` / `writeDirectoryLockMetadata` in `coord/engine/scripts/governance-context.js`; `findLockForTicket` / `writeLock` / `moveFileIfNeeded` in `governance-session`/`lifecycle`) are INJECTED, NOT moved/reimplemented. Every collaborator injected as a deferred `(...a)=>fn(...a)` wrapper; `fs`/`path` are node builtins required directly. `coord/engine/scripts/lifecycle.js` wires it after the `createSyncProvenance` destructure and re-destructures the seven returns back into scope so the `commands` dispatch table, the `__testing` facade (`refreshLockHead`/`ensureDoingTicketLockIntegrity`), and the deferred wrappers other factories inject resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-293, decomposition slice #2 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/ticket-queue-service.js` (moved by COORD-873) — the ticket QUEUE / ranking / recommendation service (`listTickets`, `pickTickets`, `recommendTickets`, `recommendationModeForAgent`, `summarizeBusyActiveAgents`, `listIdleActiveAgentSessions`, `buildReleaseCandidates`, `scoreTicket`, `buildDownstreamCounts`), as a DI factory. Owns ticket listing, the `pick`/`recommend` candidate ranking (the private `pick*`/`buildRecommendationSet`/`printRankedTicketList`/`formatRankedTicket`/`assignTicketsToAgents` helpers), the scoring model (`scoreTicket` + `modeBiasScore` mode bias), the downstream/dependency unblocks counts (`buildDownstreamCounts`), the mode-bias resolver, the idle/busy active-agent summaries, and agent-release-candidate planning. CRITICAL: NO behavior change — `gov counts/list/pick/recommend` output is byte-identical and the COORD-285 `proposed` exclusion is preserved from BOTH the downstream/unblocks count AND the recommendation candidate set (`buildRecommendationSet` considers only `STATUS.TODO`); ranking is moved verbatim. The governance-context primitive (`state`, holding `BOARD_PATH`) and the `STATUS` constant map are INJECTED BY REFERENCE; every collaborator (board readers `readBoard`/`getRows`, identity/owner `resolveOwnerIdentity`/`ensureCurrentAgentIdentity`/`maybeCanonicalOwner`/`findDoingTicketForOwner`, agent-session readers `readAgentsRegistry`/`readAgentSessions`/`resolveAgentIdentifier`/`compareSessionsMostRecentFirst`/`resolveEffectiveThreadId`, readiness/scoring `evaluateReadiness`/`splitDependsOn`/`isRepoBackedCode`, blocker formatting `formatTransitiveBlockerDetails`/`formatDependencyCycleList`, plus `integerOrDefault`/`fail`) is injected as a deferred `(...a)=>fn(...a)` wrapper. `compareSessionsMostRecentFirst` STAYS in `coord/engine/scripts/lifecycle.js` (governance-session also consumes it) and is injected here. `coord/engine/scripts/lifecycle.js` wires it after the `createTicketLockService` destructure and re-destructures the nine public returns back into scope so the `commands` dispatch table and the deferred wrappers other factories inject resolve byte-identically. (COORD-297 later dropped the redundant `buildReleaseCandidates` `__testing` re-export — that behavior is owned by `ticket-queue-service.test.js` via `svc.buildReleaseCandidates`, and `coord/engine/scripts/agent-commands.js` consumes it through DI injection, not the facade.) Extracted from `coord/engine/scripts/lifecycle.js` (COORD-294, decomposition slice #3 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/governance-plan-shape.js` (moved by COORD-873) — the governance PLAN-SHAPE service (`scaffoldSelfReviewCycle`, `buildDefaultGovernancePlan`, `normalizeGovernancePlanShape`, `formatGovernancePlanEntry`, `formatGovernanceReviewProfileEntry`, `formatGovernanceRepairEntry`, `parseGovernancePlanEntries`, `buildScaffoldPlanRecord`, `ensurePlanStub`), as a DI factory. Owns governance-plan normalization (the `governance` sub-record shape) and scaffold-plan construction — distinct from `coord/engine/scripts/plan-records.js` (canonical plan record IO) and `coord/engine/scripts/plan-command.js` (the `gov plan`/`update-plan` verbs). CRITICAL: NO behavior change — plan JSON/markdown round-trips byte-stable where expected (`normalizeGovernancePlanShape`/`parseGovernancePlanEntries`/`formatGovernancePlanEntry` + the review-profile/repair sibling formatters produce byte-identical output) and `buildDefaultGovernancePlan`/`buildScaffoldPlanRecord`/`ensurePlanStub`/`scaffoldSelfReviewCycle` yield identical plan records. COORD-007: `buildDefaultGovernancePlan` seeds `expected_closeout.base_ref` from the LIVE `REPO_INTEGRATION_BRANCHES` map, injected BY REFERENCE so the `__testing.paths.REPO_INTEGRATION_BRANCHES` in-place mutation propagates. Primitives (`state`, `REPO_INTEGRATION_BRANCHES`, `DEFAULT_INTEGRATION_BRANCH`, `isRepoBackedCode`, `repoNameForCode`, `toArray`, the state-io canonical readers/writers `readCanonicalTextFile`/`writeCanonicalTextFile`/`writeCanonicalJsonFile`) injected BY REFERENCE; the plan-record IO collaborators wired LATER by `createPlanRecords` (`readPlanRecord`/`extractPlanBlock`/`renderPlanRecordBlock`/`appendPlanBlock`/`syncPlanRecordFromBlock`/`planRecordPath`/`writePlanCompatibilityBlockFromRecord`) injected as deferred `(...a)=>fn(...a)` wrappers. `coord/engine/scripts/lifecycle.js` wires it EARLY (before `createGovernanceValidation`/`createPlanRecords`, which inject these shape functions) and re-destructures the nine returns back into scope so the `commands` dispatch table, the `__testing` facade (`buildDefaultGovernancePlan`/`ensurePlanStub`), and the deferred wrappers other factories inject resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-295, decomposition slice #4 per the COORD-291 boundary contract) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/lifecycle-evidence.js` (moved by COORD-888) — the lifecycle PR / EVIDENCE-RESOLUTION service (`resolveTicketGitContext`, `resolvePrUrlForTicket`, `resolveLifecyclePrRefs`), as a DI factory. Owns resolving a ticket's git context (repo root / branch / worktree / lock, lock-first with a worktree fallback) and the closeout PR-ref decision tree — distinct from `coord/engine/scripts/landing-resolution.js` (commit-ancestry / base-ref / source-commit resolution) and `coord/engine/scripts/landing-audit.js` (provenance landing records), which stay SEPARATE modules wired alongside it (296 sits beside them, it does not absorb them). CRITICAL: NO behavior change — PR/no-PR evidence is byte-identical (the `--no-pr` X-lane and the PR-backed path resolve through the same `resolveLifecyclePrRefs` tree: explicit `--pr` refs → existing board `pr_index` refs → repo-backed branch PR discovery → fail-closed; `verifyPrEvidence` is INJECTED with `allowNoPr: true`, not reimplemented). The repo-registry/worktree-ops/landing-gh collaborators (`isRepoBackedCode`, `getRepoRoot`, `listGitWorktrees`, `inferTicketIdFromPath`, `isGitHubPrUrl`, `ghPrListByBranch`, `verifyPrEvidence`, `mergeUniqueRefs`, `toArray`) inject BY REFERENCE; the lifecycle-local hoisted `findLockForTicket`/`fail` inject as deferred `(...a)=>fn(...a)` wrappers. OWNERSHIP (COORD-088 re-confirmed): `readCommitSubject`/`commitSubjectAffiliatesWithTicket` are review-STATE verification used by `assertCommittedReviewState` (and `coord/engine/scripts/governance-validation.js`), NOT consumed by the three moved functions, so they were LEFT in `coord/engine/scripts/lifecycle.js` — `assertCommittedReviewState` is unchanged. `coord/engine/scripts/lifecycle.js` wires it after the repo-registry/worktree-ops/landing-gh destructures are live and re-destructures the three returns back into scope so the `commands` dispatch table and the deferred wrappers other factories inject (landing-resolution / worktree-ops / pr-ops / ticket-commands) resolve byte-identically. Extracted from `coord/engine/scripts/lifecycle.js` (COORD-296, decomposition slice #5 per the COORD-291 boundary contract — the last slice before the COORD-297 facade-shrink) to hold the 5000 composition-root size ceiling by EXTRACTION
- `coord/engine/scripts/lifecycle-board-commands.js`, `coord/engine/scripts/lifecycle-board-validate.js`, `coord/engine/scripts/lifecycle-gate-code-commands.js`, `coord/engine/scripts/lifecycle-journal-queries.js`, `coord/engine/scripts/lifecycle-landing-governance.js`, `coord/engine/scripts/lifecycle-lock-commands.js`, `coord/engine/scripts/lifecycle-maintenance-commands.js`, `coord/engine/scripts/lifecycle-repox-closeout.js`, `lifecycle-testing-paths.js`, `coord/engine/scripts/lifecycle-ticket-admin.js`, and `coord/engine/scripts/lifecycle-ticket-helpers.js` (moved by COORD-888) — COORD-397 residual lifecycle extraction modules. They move the remaining board/reporting, board-validation, gate-plan/code-context, journal-query, landing-threshold, lock, maintenance, Repo-X closeout, test-path, ticket-admin, and closeout-helper clusters out of `coord/engine/scripts/lifecycle.js` while preserving the same `commands` and `__testing` facade names. `coord/engine/scripts/lifecycle.js` is now ratcheted to 2599 logical LOC by `arch-checks` prodloc high-water.
- `coord/engine/scripts/lifecycle.js` (moved by COORD-873) — remaining orchestration hub: factory wiring and the residual lifecycle surface
- `coord/engine/scripts/cli.js` (moved by COORD-873) — command routing, flag parsing, `executeCommand()`, and `main()`

The remaining refactor work is to keep shrinking `coord/engine/scripts/lifecycle.js`, not to move the
public entry point. The target boundary — `coord/engine/scripts/lifecycle.js` as a **composition root
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
coord/scripts/gov set-review-cycles <ticket-id> --replace  # Replace all self-review cycles explicitly
coord/scripts/gov set-requirement-closure <ticket-id> # Set requirement closure evidence
coord/scripts/gov add-feature-proof <ticket-id>      # Add a feature proof entry
coord/scripts/gov drop-feature-proof <ticket-id>     # Remove a feature proof entry
coord/scripts/gov add-repo-gate <ticket-id>          # Add a repo gate entry
coord/scripts/gov set-context-pack-ack <ticket-id>   # Show what the acknowledgement must answer; author it per section or with --not-applicable --reason
coord/scripts/gov scan-context-pack-acks [--json]    # Read-only: list stored context_pack_ack objects that violate the schema
coord/scripts/gov repair-context-pack-ack <ticket-id> --context-pack-ack '<json>' [--confirm]  # Replace a malformed acknowledgement (dry-run without --confirm)
```

## Code Index and Search

```bash
coord/scripts/gov code-index [--repo <repo-code|path>] [--git] [--force] [--json]
coord/scripts/gov code-search "<query>" [--repo <repo-code>] [--top <N>] [--json]
coord/scripts/gov code-context <path> [--repo <repo-code>] [--json]
coord/scripts/gov code-diff [<base-ref>] [--repo <repo-code|path>] [--json]
```

The default index corpus is the coord scripts plus every repository in
`coord/project.config.js`. Records use a repo code and repo-relative path, so
identical paths in separate repositories remain distinct. `--git` refreshes
each configured Git root independently, and the sensitive-path policy applies
before any file is read.

## Orchestrator

```bash
coord/scripts/gov orch                               # Run orchestrator cycle
coord/scripts/gov orch --fix                         # Run with deterministic local auto-repairs; foreign cleanup stays report-only
coord/scripts/gov audit-landings [--write]           # Audit landing index provenance
```

## Diagnostics and Recovery

```bash
coord/scripts/gov doctor [--ticket <id>] [--fix]    # Check governance health
coord/scripts/gov recover <ticket-id> [--human-admin-override "<reason>"]  # Repair live lock/session drift (no restore flag exists; see the recovery notes below)
coord/scripts/gov recent [--full]                    # Show recent governance events
coord/scripts/gov runtime-lock-status                # Report runtime lock state
coord/scripts/gov break-runtime-lock                 # Remove a wedged runtime lock
```

## Quality Gates

```bash
coord/scripts/gov gate <repo-name|repo-code> [--lane <default|full|ci>] [--source <local|hook|ci>]
coord/scripts/gov commit-ticket <ticket-id> -m "TICKET-ID message" [--files <path> ...] [--all]
coord/scripts/preflight.sh [--ticket <ticket-id>]    # Run preflight validation checks
```

`commit-ticket` works for **every** governed worktree, product-repo (B, F) and
control-plane (X) alike. A Repo-X ticket is not a "scratch directory": `gov
start` cuts a real Git worktree of the **control-plane repository**, which under
ADR-0008 is `coord/` (`coord/.git`) in an adopter workspace, and the enclosing
repository in the donor. Commit control-plane work with the governed verb — do
not `git add` / `git commit` by hand:

```bash
coord/scripts/gov commit-ticket <ticket-id> -m "TICKET-ID message"
```

The only case `commit-ticket` refuses for Repo X is a workspace with **no
control-plane repository at all**; the refusal says so and names the consented
bootstrap that creates one. Control-plane Git operations resolve only to
`coord/` — the workspace container above it is never a Git repository (ADR-0008).

Cleaning up a governed worktree uses the same verb for both kinds, with `coord`
(or `X`) naming the control plane:

```bash
coord/scripts/gov cleanup-worktree <repo-name> <ticket-id> --yes [--delete-branch]
coord/scripts/gov cleanup-worktree coord <ticket-id> --yes [--delete-branch]
```

Cleanup **refuses a dirty worktree** rather than discarding uncommitted work,
and **deregisters** through `git worktree remove` (plus a prune) rather than
deleting the directory — a deleted-but-registered worktree is the stale-residue
class that used to need a manual `git worktree remove`. A successful closeout
performs the same governed removal automatically, for control-plane tickets as
well as product-repo tickets. `gov doctor` reports control-plane residue as
control-plane state naming `coord/`, never as backend/frontend state.

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
coord/scripts/gov sync                               # Journaled render of outputs from canonical board
node coord/board/board.js sync                       # Journalless bootstrap only; refuses on an initialized journal
node --test coord/board/board.test.js                # Run board tests
node --test coord/engine/scripts/governance.test.js         # Run governance tests
```

## Startup Notes

- `coord/scripts/gov start <ticket-id>` now bootstraps missing canonical plan state, auto-seeds the startup/traceability attestation, repairs owner-scoped scaffold placeholders, and refreshes `origin/<base>` before new repo-backed branch creation unless `--offline` is explicit.
- `coord/scripts/gov unstart <ticket-id>` is the explicit same-owner wrong-start escape hatch. It only succeeds while the ticket is still at scaffold/start state: no PR/landing/review evidence, no meaningful implementation-plan content, and no workspace changes or commits.
- When a board row regresses after `review` or `done` and no canonical `doing` lock remains, there is no automated restore. Read the journaled evidence with `coord/scripts/gov recent <ticket-id> --full`, run `coord/scripts/gov recover <ticket-id>` only for lock and session drift, and escalate the row repair to a human admin. Board-row repair is escalated to a human admin; there is no restore flag.
- `coord/scripts/gov agents register` now requires explicit `--handle` and `--id` values and rejects handles that do not match the canonical provider-prefix pattern for that simple id.
- Canonical `doing` lock creation now uses create-if-absent semantics. If another writer wins the lock-create race first, governance fails closed and tells you to re-read the existing lock instead of overwriting it.
- Test / contract / infra tickets still require explicit baseline reproduction before start. Use `coord/scripts/gov plan <ticket-id> --baseline "Command: ..." --baseline "Outcome: ..."` when start blocks on that evidence.
- Repo-backed starts fail closed if `origin/<base>` cannot be refreshed and `--offline` was not given. Offline mode falls back to locally available refs.
- Repo-backed starts also print manifest-driven dependency bootstrap guidance and the canonical `scripts/gate.sh default` entrypoint for that repo.
- `coord/scripts/gov commit` now validates that the commit subject already contains the ticket ID. It uses targeted staging by default and only broad-stages the full governed diff when `--all` is explicit.
- `coord/scripts/governance-mcp.js` speaks specification-compliant MCP stdio: newline-delimited UTF-8 JSON-RPC, one message per line, per the official transport spec (COORD-482). Stdout carries protocol messages only; all diagnostics go to stderr. The earlier LSP-style `Content-Length` framing was removed — real MCP stdio clients (Claude Code, the official SDK) never spoke it. Interoperability is proven by a real spawned-server smoke in `governance-mcp.test.js`: a spec-exact in-repo client always runs, and an official `@modelcontextprotocol/sdk` client smoke runs whenever the SDK is resolvable (`GOVERNANCE_MCP_SDK_DIR` may point at a directory whose `node_modules` contains it; the engine itself stays zero-dependency).
- Governance MCP troubleshooting — transport vs. project approval are SEPARATE failure classes. Transport/initialization failures mean the handshake itself broke: the server exits immediately, `initialize` gets no newline-terminated JSON-RPC response, or stdout contains non-JSON text (fix the server or the client config in `.mcp.json`). Claude project approval is different: the stdio handshake can succeed end-to-end and the `governance` server can still be unavailable in a conversation because the project has not approved the MCP server — approve it in the Claude Code project settings (`.mcp.json` servers require per-project user approval on first use). A successful `initialize`/`tools/list` probe therefore never proves a client conversation can use the server, and a missing-server symptom in Claude does not imply a transport bug.
- The governance MCP write surface stays read-only under identity v2 (GCV-1 O3): mutating tools (`gov_start`, `gov_commit`, `gov_submit`, `gov_land`, ...) fail closed with `v2_mcp_read_only`; run mutations through the `gov` CLI instead.
- When the governance MCP server is the active session host, it now runs a background heartbeat for the current `doing` ticket at the 5-minute target cadence while the governed worktree exists. Closing the MCP host process stops that timer and leaves the lock to age normally from its last heartbeat.
- Raw CLI or other non-MCP sessions still operate in mutation-triggered-only heartbeat mode unless a separate sidecar host is added.
- `coord/scripts/gov agent-rebind --fresh` now reserves a new handle with bounded retries and fails closed with a distinct exhaustion error if competing claims keep winning the reservation race.
