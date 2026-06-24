#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const { gitTry } = require("./git-ops.js");
const { allBoardRepoCodes, DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const {
  STATUS,
  FINDING_STATUS,
  legalStatusSet,
  legalFindingStatusSet,
} = require("./governance-constants.js");
const identityV2 = require("./identity-v2.js");
const {
  SCRIPTS_DIR,
  COORD_DIR,
  ROOT_DIR,
  DEFAULT_PATHS,
  GovernanceError,
  state,
  readLockAgeMs,
  tryReclaimStaleDirectoryLock,
  describeDirectoryLockHolder,
  directoryLockMetadataPath,
  writeDirectoryLockMetadata,
  readDirectoryLockMetadata,
  withAgentStateLock,
  withCoordStateLock,
  withGovernanceRuntimeLock,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
  isProcessAlive,
} = require("./governance-context.js");
const {
  BoardValidationError,
  syncBoardArtifacts,
  validateBoardState,
} = require("../board/board.js");
const createTokenEconomics = require("./token-economics.js");
const createOtlpExport = require("./otlp-export.js");
const createPlanRecords = require("./plan-records.js");
const createJournal = require("./journal.js");
const createPromptCoverage = require("./prompt-coverage.js");
const createGovernanceSession = require("./governance-session.js");
const createGovernanceBoardState = require("./governance-board-state.js");
const createGovernanceValidation = require("./governance-validation.js");
const createRepoRegistry = require("./repo-registry.js");
const createLifecycleFlags = require("./lifecycle-flags.js");
const createWorktreeOps = require("./worktree-ops.js");
const createGovernanceRepair = require("./governance-repair.js");
const createPrOps = require("./pr-ops.js");
const createRuntimeCleanup = require("./runtime-cleanup.js");
const createGateRuntime = require("./gate-runtime.js");
const gateProcRegistry = require("./gate-proc-registry.js");
const createQuestions = require("./questions.js");
const createPlanCommand = require("./plan-command.js");
const createGates = require("./gates.js");
const createLandingAudit = require("./landing-audit.js");
const createTicketTransitions = require("./ticket-transitions.js");
const createCloseout = require("./closeout.js");
const createDoctorRecovery = require("./doctor-recovery.js");
const createDoctorReport = require("./doctor-report.js");
const createTicketGuidance = require("./ticket-guidance.js");
const createAgentCommands = require("./agent-commands.js");
const createLandingResolution = require("./landing-resolution.js");
const createBoardRebuild = require("./board-rebuild.js");
const createConformanceAttestation = require("./conformance-attestation.js");
const createEnginePin = require("./engine-pin.js");
const createConformanceVerbs = require("./conformance-verbs.js");
const {
  collectAgentFacadeVerbs,
  collectAgentWrapperFlags,
  collectDispatchCommandVerbs,
  collectParseFlagsFlags,
  parseDocumentedAgentVerbs,
  parseDocumentedGovVerbs,
  runVerbParityCheck,
} = require("./verb-parity.js");
const {
  slugify,
  integerOrDefault,
  inferNextRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
} = require("./lifecycle-utils.js");
const {
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  canonicalSyncablePaths,
  computeSyncDelta,
  ensureParentDir,
  formatJsonFileIssue,
  readCanonicalJsonFile,
  readCanonicalTextFile,
  readJsonArrayFileOrFail,
  readJsonFileState,
  readLastNonEmptyLine,
  safeReadJson,
  writeCanonicalJsonFile,
  writeCanonicalTextFile,
  writeFileAtomicSync,
  writeJsonFile,
} = require("./state-io.js");

const REPO_ROOTS = DEFAULT_PATHS.repoRoots;
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};
const AGENT_SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
const SESSION_FINGERPRINT_ENV_VARS = [
  "TERM_SESSION_ID",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "WT_SESSION",
  "KITTY_WINDOW_ID",
  "TAB_ID",
];
const TESTING_INFRA_LANDING_EVIDENCE_PREFIX = "testing-infra audit:";
const TESTING_INFRA_DESCRIPTION_PATTERN = /\b(test(?:ing)? infrastructure|test[- ]lanes?|default\/full\/extended(?: gates?)?|architecture guards?|timing artifacts?|coverage thresholds?|vitest|msw|pre-push|hook flow|hook installer|gate automation|gate truthfulness|workspace alias resolver|automation contract)\b/i;
const TESTING_INFRA_FILE_PATTERNS = [
  /^tools\/(?:gates|testing|hooks)\//,
  /^tests\/(?:arch|setup|components|contracts)\//,
  /^packages\/testkit\//,
  /^vitest\.config\.[cm]?[jt]sx?$/,
  /^package\.json$/,
  /^README\.md$/,
  /^\.github\/workflows\//,
  /^\.husky\//,
];
const PNPM_BUILTIN_COMMANDS = new Set([
  "add",
  "audit",
  "config",
  "dedupe",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "help",
  "import",
  "info",
  "init",
  "install",
  "list",
  "login",
  "logout",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "publish",
  "rebuild",
  "remove",
  "root",
  "setup",
  "store",
  "unlink",
  "update",
  "up",
  "why",
]);
const FEATURE_PROOF_EVIDENCE_PREFIX = "feature-proof audit:";

// COORD-074: status / finding-status enums sourced from the shared
// governance-constants module (byte-identical to the prior inline Sets).
const LEGAL_STATUSES = legalStatusSet();
const LEGAL_FINDING_STATUSES = legalFindingStatusSet();
const FOLLOWUP_RELATIONS = new Set([
  "blocking",
  "related",
  "closeout-blocker",
  "independent",
]);
const WAIVER_CODES = new Set([
  "prompt_coverage",
]);

function withTemporaryExecutionContext(options, fn) {
  const envOverrides = options?.env && typeof options.env === "object" ? options.env : null;
  const nextCwd = options?.cwd ? path.resolve(options.cwd) : null;
  const previousCwd = nextCwd ? process.cwd() : null;
  const envRestore = [];

  if (envOverrides) {
    const keys = new Set([
      ...Object.keys(process.env),
      ...Object.keys(envOverrides),
    ]);
    for (const key of keys) {
      const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
      const previousValue = process.env[key];
      const nextValue = envOverrides[key];
      if (nextValue === undefined) {
        if (hadValue) {
          delete process.env[key];
          envRestore.push({ key, hadValue, previousValue });
        }
        continue;
      }
      const normalizedNextValue = String(nextValue);
      if (!hadValue || previousValue !== normalizedNextValue) {
        process.env[key] = normalizedNextValue;
        envRestore.push({ key, hadValue, previousValue });
      }
    }
  }

  if (nextCwd && previousCwd !== nextCwd) {
    process.chdir(nextCwd);
  }

  try {
    return fn();
  } finally {
    if (nextCwd && previousCwd !== nextCwd) {
      process.chdir(previousCwd);
    }
    for (let index = envRestore.length - 1; index >= 0; index -= 1) {
      const { key, hadValue, previousValue } = envRestore[index];
      if (hadValue) {
        process.env[key] = previousValue;
      } else {
        delete process.env[key];
      }
    }
  }
}

function printHelp(options = {}) {
  if (!options.all) {
    console.log(`Governance helper CLI

Preferred workflow:
  coord/scripts/gov initiate
  coord/scripts/gov pick [all] --mode <backend|frontend|design|general> --limit 3
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim [<ticket-id>]
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov start <ticket-id>
  coord/scripts/gov block <ticket-id> --reason "<why work is paused>"
  coord/scripts/gov unblock <ticket-id>
  coord/scripts/gov commit <ticket-id> --message "Ticket commit message"
  coord/scripts/gov submit <ticket-id> [--fill]
  coord/scripts/gov finalize <ticket-id> --no-pr [--already-landed] --landed "<evidence>" [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov land <ticket-id> [--method <merge|squash|rebase>] [--delete-branch] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov supersede <ticket-id> [--reason "<why>"] [--consolidated-into <ticket-id>]

If review/governance state needs repair:
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov recover <ticket-id>
  coord/scripts/gov unstart <ticket-id>   # guarded same-owner wrong-start revert: doing -> todo, fails closed on review/landing/plan/workspace evidence
  coord/scripts/gov reconcile [<ticket-id>] --reason "<why the current drift is being accepted>"
  coord/scripts/gov open-followup [<new-ticket-id>|--prefix <PREFIX>] --depends-on <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>]
  coord/scripts/gov next-id <PREFIX>   # print the next free PREFIX-N ticket id
  coord/scripts/gov split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]   # one auto-allocated related followup per repo
  coord/scripts/gov set-followup-relation <ticket-id> [--depends-on <ticket-id>] --relation <blocking|related|closeout-blocker|independent>
  coord/scripts/gov set-priority <ticket-id> --pri <P0|P1|P2|P3>   # reprioritize a non-terminal ticket through gov (TASKS.md is a rendered view)
  coord/scripts/gov set-type <ticket-id> --type <feature|bug|chore|task|spike|refactor|docs|test>   # retype a non-terminal ticket through gov
  coord/scripts/gov repair <ticket-id> --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>

Clean-checkout gate execution:
  coord/scripts/gov gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]

Code-quality automation (COORD-083):
  coord/scripts/gov quality-scan [--apply] [--root <dir>] [--severity-floor warn|fail] [--cap <n>] [--depends-on <ticket>] [--repo <code>] [--prefix <PREFIX>]
      (runs the arch-checks library over <root>, dedups findings against open board tickets, and DRY-RUNS by default; --apply files governed follow-ups via open-followup. A per-run cap prevents board flooding. Schedulable via cron/CI — see coord/product/QUALITY_AUTOMATION.md)

Structured plan helpers:
  coord/scripts/gov add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  coord/scripts/gov set-review-cycles <ticket-id> --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
  coord/scripts/gov set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete>
  coord/scripts/gov add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] [--audit <summary>] | --not-required)
  coord/scripts/gov retire-stale-drift-notes [--dry-run]

Token-economics (TOKEN_ECONOMICS.md):
  coord/scripts/gov record-cost <ticket-id> --model <m> --input-tokens <n> --output-tokens <n> [--agent <h>] [--usd <amount>] [--phase start|implement|review|land]
      (append-only cost.observed journal event; if --usd omitted, estimates from coord/product/model-prices.json. Evidence, not a gate.)
  coord/scripts/gov cost [--ticket <id>] [--by ticket|agent|model] [--json]
      (read-only aggregate of the cost ledger: totals + breakdown; --json is deterministic/hash-stable; empty ledger -> zeros)
  coord/scripts/gov precheck <ticket-id> [--json] [--record]
      (cheap read-only probes -> verdict already-satisfied|partial|not-started|unknown; exit 0/10/20/30; NO required LLM call.
       Declare probes in coord/prompts/tickets/<ID>.precheck.json or a fenced 'precheck' JSON block in the prompt: types grep|test|file-exists, each with expect.
       No probes declared -> unknown, never a false satisfied. --record writes an auditable journal note.)
  coord/scripts/gov context-pack <ticket-id> [--json | --md]
      (deterministic, hash-stable per-ticket context pack: STABLE shared-preamble pointers (place in a prompt-cache prefix)
       + TICKET-SPECIFIC files/acceptance-criteria/spec-sections and prior feature-proofs+invariants intersecting the ticket files.
       Degrades gracefully when there are no prior proofs.)
  coord/scripts/gov insights [--json]
      (COORD-147 strategic execution-insight report mined from REAL history (journal + board + plan records):
       repeated-failure-themes, architectural-debt-by-subsystem, churn-instead-of-value, gate/review/recovery health BY REPO.
       RECOMMENDS ONLY — mutates/gates nothing; every claim is source-cited (ticket ids + event_hash + chain_head); thin signal flagged.
       Deterministic (identical history -> identical report). --json emits the structured report; default emits the readable text report.)
  coord/scripts/gov tier <ticket-id>
      (resolves the ticket tier (explicit board Tier column, else derived from Pri, else standard), the suggested model class,
       and the tier-appropriate required evidence depth. Tier policy is data-driven in coord/product/tier-policy.json.
       Relax-only safety: standard/absent and critical keep TODAY's flat minimums byte-identical; only lower tiers relax.)
  coord/scripts/gov plan-waves [--status todo] [--repo <code>] [--json]
      (conflict-free parallel schedule: wave N = tickets sharing no declared file AND with all dependsOn satisfied by earlier waves/done.
       No-files tickets are treated as potentially-conflicting (scheduled alone); repo-X tickets are not-parallelizable (one per wave).
       Deterministic (stable sort by ID); names per-ticket satisfied deps and lists any excluded ticket — no silent drops.)
  coord/scripts/gov dispatch-plan [--status todo] [--repo <code>] [--wave N] [--json | --md]
      (ONE deterministic dispatch manifest composing the levers: plan-waves schedule + per-ticket precheck verdict ->
       action skip (already-satisfied; includes the exact governed finalize-already-satisfied command) or spawn (everything else
       — unknown/no-probes NEVER yields a false skip); resolved tier -> suggested model class + tier-appropriate evidence depth;
       context-pack with its STABLE cacheable-prefix vs ticket-specific split preserved (--md emits a contextPackRef pointer).
       Read-only/additive; hash-stable (identical board -> byte-identical --json manifest).)

Observability (ENT-005):
  coord/scripts/gov otlp-export [--output <path> | --stdout] [--endpoint <url>]
      (emits the durable journal as OpenTelemetry OTLP/JSON: tickets-as-traces, lifecycle-verbs-as-spans,
       cost/tier/attribution as span attributes; non-ticket events as log records. Zero-dep + deterministic
       (identical journal -> byte-identical output). Default sink is stdout; --output writes a file; --endpoint
       opt-in POSTs to an HTTP OTLP endpoint (OFF by default, degrades gracefully, no network otherwise).
       READ-ONLY: never mutates the journal/board. Renders a fleet dashboard in Datadog/Grafana from journal export alone.)

Runtime lock repair:
  coord/scripts/gov runtime-lock-status
  coord/scripts/gov break-runtime-lock --yes
  coord/scripts/gov clean-runtime [--yes] [--force] [--include-ticket-state]

Deterministic regen of canonical derived artifacts:
  coord/scripts/gov sync [--commit "<message>"]
      (regenerates rendered/TASKS.md, rendered/PROMPT_INDEX.md, PLAN.md and reports drift;
       with --commit, creates a single commit limited to those paths — never sweeps with git add -A)

Useful inspection:
  coord/scripts/gov initiate
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim <ticket-id>
  coord/scripts/gov agent-status
  coord/scripts/gov ticket <ticket-id>
  coord/scripts/gov recent [<ticket-id>] --limit 10 [--full]
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov counts
  coord/scripts/gov doctor [--fix] [--ticket <ticket-id>]
  coord/scripts/gov conform [--json] [--attest] [--verify-attestation <file>]
  coord/scripts/gov repair-chain [--confirm --reason "<why>"] [--json]
  coord/scripts/gov verify-engine [--pin] [--json]
  coord/scripts/gov audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--write]

Notes:
  - "start" requires a claimed owner context (or explicit --owner) before ticket mutations begin.
  - "agentid" reports the current window's agent id when claimed, returns assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" is different from "start": it binds the current session to an agent, and only takes over an existing ticket owner/lock when --force is explicit.
  - "set-waiver" records machine-readable prompt-coverage waivers in board state; free-text QUESTIONS.md notes are optional narrative context, not the start gate authority.
  - "resume" is the preferred same-owner session handoff for an already-started doing/review ticket; it rebinds the governed ticket lock into the current claimed session.
  - "commit" stages and commits inside the governed worktree for a doing ticket.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, feature-proof, and structured self-review checks pass.
  - "finalize" is the shortcut for the common no-PR local-review closeout path; it moves to review and marks done once landing evidence is provided. Use --already-landed only to repair a no-PR ticket that was merged to dev before move-review. If the repo has a remote, prefer PR-backed landing unless no-PR is intentional.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "supersede" moves any ticket to superseded, removes active lock/worktree residue, and preserves its historical evidence without reopening it later. Pass --reason "<why>" and/or --consolidated-into <ticket-id> to record inline supersession provenance on the board row (Supersede Reason / Superseded By) so a retired ticket is never left without a reason or replacement pointer. It is not a substitute for review/done closeout when the work already landed on dev.
  - "recent" / "explain" / "recover" read from the append-only governance journal and are the supported way to diagnose or repair live drift.
  - "conform" is a read-only journal hash-chain self-verify: it verifies every event's prev_event_hash link end-to-end and prints the chain head plus a pass/fail verdict (--json for machine output). A broken link means the journal was reordered, tampered, or had an event dropped; legacy pre-chain events validate as accepted-but-unverified. "doctor" runs the same chain check board-wide and fails on a broken link. ENT-010: "conform --attest" ALSO emits a signed (local ed25519 keypair) conformance attestation over the engine-integrity inputs (engine version, TEMPLATE_SYNC_MANIFEST.json fingerprint, gate config + latest gate-artifact result/coverage/audit, RELEASE_PROVENANCE donor SHA when present, and the journal chain head) under coord/.runtime/attestations/ (private signing key stays gitignored under coord/.runtime/conformance-keys/). "conform --verify-attestation <file>" re-derives the live inputs, recomputes the digest, checks the signature, and flags drift/tamper. This is the Community per-team self-verify; the signed attestation is the exact input a future central re-hash service (ENT-007) would re-compute.
  - "repair-chain" (COORD-124) is a GUARDED, AUDITABLE repair for a journal hash-chain broken by crossed prev_event_hash links (e.g. two governed agents appending concurrently). With NO flags it is a DRY-RUN: it reports the broken links that WOULD be re-linked (offending indices/ids + claimed-vs-expected prev-hash) and writes NOTHING; it no-ops cleanly when the chain is already valid. With "--confirm --reason \"<why>\"" it APPLIES: it backs the pre-repair journal up to a timestamped .pre-repair-<ts> sidecar (gitignored off-chain evidence), appends an explicit on-chain "chain-repair" marker capturing the broken-link evidence + the human reason + actor + ts, and re-stamps prev_event_hash for every chained event from the first broken link forward (reusing the canonical hasher) so the chain is GENUINELY re-linked — after which "conform" PASSES and the verified chain permanently contains the marker (repair is visible, never silent). The marker does NOT relax the verifier: a chain broken WITHOUT a recorded repair still FAILS conform, so this cannot be used to launder tampering. (--json for machine output.)
  - "verify-engine" (ENT-011, Community per-team) PINS the engine surface to a known-good version and DETECTS drift from it WITHOUT signing (signing is the Enterprise half, ENT-008). "verify-engine --pin" snapshots the current surface (TEMPLATE_SYNC_MANIFEST manifest_version + its sha256 fingerprint, reusing ENT-010's conformance fingerprint, plus a per-file checksum snapshot of the exact-match engine files) into coord/engine-pin.json — the ONLY mutation. "verify-engine" (no flag) is READ-ONLY: it re-derives the live surface and reports IN-SYNC or DRIFTED with the offending file paths / whether the manifest fingerprint changed (--json for machine output). This is COMPLEMENTARY to check-template-sync: check-template-sync verifies internal manifest-vs-files consistency, while verify-engine verifies drift from a FROZEN pinned version (re-pin after an intentional engine bump).
  - "recent" omits full snapshot payloads by default; pass --full when you need the materialized snapshot body.
  - "gate" materializes a temporary clean worktree from the target repo's branch, runs the requested gate lane inside it, records branch and commit provenance in the artifact, and prevents branch-ref-only evidence from being treated as tested content. The worktree is removed after the run.
  - structured plan helpers exist for the strict fields so different agents do not have to hand-format fragile 'update-plan' strings for review cycles, requirement closure, feature proof, or repo gates.
  - runtime lock repair is explicit: use 'runtime-lock-status' to inspect the current holder and 'break-runtime-lock --yes' when interrupted governance left 'coord/.runtime/governance.lock' wedged.
  - "clean-runtime" is the supported safe replacement for ad hoc 'git clean/reset' inside coord: it enumerates only regenerable runtime scratch under coord/.runtime and deletes NOTHING without --yes; it never removes locks/, plans/ (ticket-local state), session files, the governance journal/snapshots, or any git-tracked board/docs; ticket-local state needs --include-ticket-state AND --yes; it refuses on rollback drift unless --force.
  - "doctor --fix" applies deterministic repairs: non-doing locks, stale locks (24h+), malformed locks (missing required fields on doing tickets), coord orphan worktrees, missing governed plan stubs, and retirement of stale governance drift-note rows whose "since" timestamp predates the current journal baseline snapshot.
  - "retire-stale-drift-notes" is the standalone admin form of that retirement step; it marks drift-note QUESTIONS.md rows resolved with an audit note once a later journaled baseline snapshot has absorbed the reported drift. Pass --dry-run to preview.
  - "add-repo-gate" accepts --result <pass|fail> and --base-result <pass|fail> to attribute a failing gate to new-on-ticket vs pre-existing-on-base vs fixed-on-ticket; attribution is encoded as an annotation on the recorded repo_gates entry. --audit <summary> records the dependency/security audit signal (QGATE-002) as an audit=... annotation on the same entry.
  - Closed tickets are not reopened; use "open-followup" for post-close findings.
  - Run "node coord/scripts/governance.js help --all" for advanced/admin commands.
`);
    return;
  }
  console.log(`Governance helper CLI

Usage:
  node coord/scripts/governance.js initiate
  node coord/scripts/governance.js agentid [--assign | --owner <handle|simple-id>]
  node coord/scripts/governance.js claim [<ticket-id>] [--owner <handle|simple-id>] [--handoff [--reason <text>]] [--human-admin-override "<reason>"]
      (same-owner recovery of a live lease: --handoff; cross-owner takeover: --human-admin-override "<reason>"; bare --force is a deprecated legacy alias only)
  node coord/scripts/governance.js resume <ticket-id>
  node coord/scripts/governance.js agents list
  node coord/scripts/governance.js agents register [--handle <handle>] [--id <simple-id>] [--provider <provider>] [--lane <lane>] [--default-repo <repo-code>] [--notes <text>]
  node coord/scripts/governance.js agents disable <handle|simple-id>
  node coord/scripts/governance.js agents enable <handle|simple-id>
  node coord/scripts/governance.js agent-claim <handle|simple-id> [--session-label <label>] [--host <host>] [--cwd <path>] [--force]
  node coord/scripts/governance.js agent-release <handle|simple-id|session-id> [--force]
  node coord/scripts/governance.js agent-rebind --fresh [--session-label <label>] [--host <host>] [--cwd <path>]
  node coord/scripts/governance.js rebuild-board <ticket-id> | --all
  node coord/scripts/governance.js agent-status [<handle|simple-id>]
  node coord/scripts/governance.js pick [all] [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js start <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js unstart <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js block <ticket-id> [--owner <owner>] --reason <text>
  node coord/scripts/governance.js unblock <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js plan <ticket-id> [--seed] [update-plan flags...]
  node coord/scripts/governance.js commit <ticket-id> --message <text> [--all] [--files <path> ...] [--owner <owner>]
  node coord/scripts/governance.js submit <ticket-id> [--pr <ref> ...] [--base <branch>] [--title <text> --body <text> | --fill] [--draft]
  node coord/scripts/governance.js review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js land <ticket-id> [--pr <ref> ...] [--landed <evidence> ...] [--method <merge|squash|rebase>] [--delete-branch] [--admin] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finalize <ticket-id> [--no-pr] [--already-landed] [--pr <ref> ...] [--landed <evidence> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js supersede <ticket-id> [--reason <text>]
  node coord/scripts/governance.js finish <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js close <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js repair <ticket-id> [--owner <owner>] --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>
  node coord/scripts/governance.js backfill-plan-records [--from <ticket-id>] [--status <review|done>] [--limit <n>]
  node coord/scripts/governance.js counts
  node coord/scripts/governance.js board-state
  node coord/scripts/governance.js recent [<ticket-id>] [--limit <n>] [--full]
  node coord/scripts/governance.js explain <ticket-id>
  node coord/scripts/governance.js recover <ticket-id>
  node coord/scripts/governance.js reconcile [<ticket-id>] --reason <text>
  node coord/scripts/governance.js list [--status <status>] [--repo <repo>] [--owner <owner>] [--pri <priority>]
  node coord/scripts/governance.js recommend [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js next-ticket [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js run-ticket-cycle <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js doctor [--fix] [--ticket <ticket-id>]
  node coord/scripts/governance.js audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--write]
  node coord/scripts/governance.js ticket <ticket-id>
  node coord/scripts/governance.js pr-view <ticket-id|pr-url>
  node coord/scripts/governance.js pr-create <ticket-id> [--base <branch>] [--title <text> --body <text> | --fill] [--draft]
  node coord/scripts/governance.js pr-merge <ticket-id|pr-url> [--method <merge|squash|rebase>] [--delete-branch] [--admin]
  node coord/scripts/governance.js mark-done <ticket-id> [--landed <evidence> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finish-ticket <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js move-review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js reopen-ticket <ticket-id>   # deprecated compatibility alias; now errors with guidance
  node coord/scripts/governance.js return-doing <ticket-id> [--owner <owner>] --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>
  node coord/scripts/governance.js start-ticket <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js commit-ticket <ticket-id> --message <text> [--all] [--files <path> ...] [--owner <owner>]
  node coord/scripts/governance.js open-followup [<new-ticket-id>|--prefix <PREFIX>] --depends-on <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>]
  node coord/scripts/governance.js next-id <PREFIX>
  node coord/scripts/governance.js split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]
  node coord/scripts/governance.js set-followup-relation <ticket-id> [--depends-on <ticket-id>] --relation <blocking|related|closeout-blocker|independent>
  node coord/scripts/governance.js set-waiver <ticket-id> --reason <text> [--clear]
  node coord/scripts/governance.js register-prompt <ticket-id> [<path>] [--path <path>] [--force]
  node coord/scripts/governance.js set-pr <ticket-id> --pr <ref> [--pr <ref> ...]
  node coord/scripts/governance.js add-finding <ticket-id> --severity <HIGH|MED|LOW> --summary <text> --qref <Lxx> [--round <n>]
  node coord/scripts/governance.js update-finding <ticket-id> --id <finding-id> --status <resolved|deferred|consolidated> [--deferred-to <ticket>] [--consolidated-into <ticket>]
  node coord/scripts/governance.js log-question --from <agent> --to <target> --question <text> --answer <text> --resolved <yes|no|n/a>
  node coord/scripts/governance.js heartbeat <ticket-id>
  node coord/scripts/governance.js update-plan <ticket-id> [--summary <text>] [--verify <cmd>] [--files <path>] [--security <yes|no>] [--startup <completed>] [--traceability <verified|closing-gap|exempt>] [--baseline <text>] [--invariant <text>] [--closure <text>] [--feature-proof <text>] [--repo-gate <text>] [--rollback <text>] [--closeout-method <pr|no_pr|fulfilled_by>] [--closeout-base-ref <ref>] [--provenance-note <text>] [--review-profile <standard|bounded_repair>] [--review-cycle <text>] [--replace-review-cycle <N> --review-cycle <text>] [--drop-review-cycle <N>]
  node coord/scripts/governance.js add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  node coord/scripts/governance.js set-review-cycles <ticket-id> --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
  node coord/scripts/governance.js set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete>
  node coord/scripts/governance.js add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] | --not-required)
  node coord/scripts/governance.js retire-stale-drift-notes [--dry-run]
  node coord/scripts/governance.js release-lock <ticket-id> [--force]
  node coord/scripts/governance.js lock-abandon <ticket-id> --human-admin-override "<reason>"
  node coord/scripts/governance.js runtime-lock-status
  node coord/scripts/governance.js break-runtime-lock --yes
  node coord/scripts/governance.js clean-runtime [--yes] [--force] [--include-ticket-state]
  node coord/scripts/governance.js audit-worktrees
  node coord/scripts/governance.js cleanup-helpers <repo-code|repo-name> --yes [--delete-branch]
  node coord/scripts/governance.js gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]
  node coord/scripts/governance.js cleanup-worktree <repo-code|repo-name> <ticket-id|path> --yes [--delete-branch]

Notes:
  - "initiate" is the session-start primer: it prints the current claim state, the do-not-edit rules, and the supported lifecycle commands for this board.
  - "agentid" reports the current window/thread identity when already claimed, returns structured assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" binds the current thread/session to an agent identity; with a ticket-id it only takes over another active owner/lock when --force is explicit.
  - "resume" is the preferred same-owner session rebind for an already-started doing/review ticket and avoids the common "claim --owner" vs ticket-lock confusion.
  - agent ownership is registry-backed and tied to the current governance board; mutating commands require explicit claim or --owner before lock/worktree mutation.
  - the same claimed agent identity may work across backend, frontend, and coord repos that share this board without changing names.
  - "pick" / "start" / "submit" / "land" / "repair" are the preferred top-level workflow verbs.
  - "unstart" is the guarded same-owner wrong-start exception: it reverts a doing/blocked ticket to todo and clears the owner, lock, and clean worktree. It fails closed once the ticket has accrued review, landing, plan, or workspace evidence that must remain auditable — use "move-review" or "supersede" instead. Foreign-owner cleanup stays an admin path ("lock-abandon").
  - "lock-abandon" is the foreign-owner admin counterpart of "unstart": with --human-admin-override "<reason>" it returns a stale foreign-locked doing ticket to todo and clears the owner, lock, and clean worktree. It rejects a ticket the current session owns (use "unstart") and fails closed on accrued review/landing/plan/workspace evidence (use "supersede" or "reconcile"). The override authorizes touching foreign ticket state, not destroying auditable work.
  - "block" / "unblock" toggle a doing ticket between "doing" and "doing (blocked: <reason>)" for the same owner; both are journaled lifecycle transitions and require the ticket to already be doing.
  - "pick" without arguments ranks work only for the current agent/session; "pick all" looks at idle active agent sessions and returns one option per agent.
  - "mark-done" is a guarded review -> done transition and re-checks review-plan gates, merged/manual landing evidence, source-vs-landed provenance, canonical-branch landing ancestry, feature-proof audit, clean worktree closeout, and any declared closeout-blocker follow-up tickets.
  - "recommend" / "next-ticket" ranks the best next open tickets from the canonical board.
  - "run-ticket-cycle" scaffolds the governed planner -> worker -> reviewer -> closer flow for one ticket.
  - "doctor" runs board validation plus extra governance audits; --fix applies only deterministic repairs and then prints what changed.
  - "audit-landings" classifies done backend/frontend landing records into explicit, fulfilled-by, legacy, and unknown buckets, and can backfill provenance_status plus commit_sha for legacy records that already resolve cleanly to a landed dev ancestor.
  - active doing-ticket lock/worktree drift is reported by "doctor" but does not block unrelated governed lifecycle mutations.
  - governed lifecycle mutations are journaled under coord/.runtime; unrelated provenance drift is logged to coord/QUESTIONS.md for orchestrator follow-up instead of blocking agents, while duplicate claim conflicts and direct write conflicts still fail closed.
  - the journal keeps compact event rows plus a latest-snapshot checkpoint; use "recent --full" only when you need the materialized snapshot body.
  - "pr-view" / "pr-create" / "pr-merge" keep GitHub PR actions inside the same guarded governance CLI; PR creation now requires a clean committed governed worktree.
  - "commit" / "commit-ticket" stage and create a non-interactive commit inside the governed worktree for a doing backend/frontend ticket. Repo X (coord-only) tickets do not have a product worktree; for those, use targeted "git add <files>" / "git commit" directly while keeping "coord/scripts/gov" for lifecycle/plan/review/closeout mutations.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, requirement-closure evidence, feature-proof evidence, and structured self-review checks pass.
  - "finalize" is the governed shortcut for local-review / no-PR closeout when you already have landing evidence; --already-landed is the repair path for a no-PR ticket that reached dev before move-review. Once a repo has a configured remote, prefer PR-backed landing unless no-PR is an intentional exception.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "move-review" performs the guarded doing -> review closeout, requires recorded repo gates plus explicit ask-vs-implementation closure evidence, feature-proof evidence, and structured self-review evidence (critical invariants, 4 cycles, distinct deep-review lenses for product repos), and releases the lock. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR. For no-PR tickets already landed on dev, use finalize --no-pr --already-landed instead of supersede.
  - "reopen" is a deprecated compatibility alias and now errors with guidance; closed tickets require follow-up tickets instead of reopen.
  - "finish-ticket" chains set-pr -> move-review -> mark-done when the gates pass. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR.
  - "return-doing" performs the guarded review -> doing transition, records a new finding, reacquires the lock, preserves the canonical plan record, and resets only the round-specific self-review evidence that must be refreshed.
  - "start-ticket" requires canonical plan state with startup/traceability attestations (and baseline reproduction for test tickets), then updates the board, creates a lock, and creates a canonical worktree.
  - "set-waiver" records structured prompt-coverage waivers in board state so start gating does not depend on free-text QUESTIONS.md scans.
  - "backfill-plan-records" synthesizes canonical per-ticket plan records for historical governed tickets that predate the new plan store, using surviving PLAN.md blocks when present and board lifecycle evidence otherwise.
  - "cleanup-helpers" removes helper/temp worktrees that are not canonical ticket worktrees.
  - "cleanup-worktree" is destructive and requires --yes.
  - "clean-runtime" is the supported safe alternative to ad hoc 'git clean/reset' for coord: dry-run by default, requires --yes to delete, only touches regenerable runtime scratch under coord/.runtime, never touches ticket-local state (locks/, plans/), session files, the journal/snapshots, or git-tracked board/docs, and refuses on rollback drift unless --force.
`);
}

function buildInitiateSummary() {
  let claimStatus = "- No active claimed agent session is bound to this thread yet.";
  try {
    const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    claimStatus =
      `- Current claimed session: ${identity.agent.handle} (${identity.agent.id})` +
      `${identity.session?.session_id ? ` via ${identity.session.session_id}` : ""}.`;
  } catch (error) {
    if (!(error instanceof GovernanceError)) {
      throw error;
    }
  }

  return [
    "Governance Session Primer",
    "",
    "Current session:",
    claimStatus,
    "",
    "Rules:",
    "- Use `coord/scripts/gov ...` for lifecycle mutations. Do not directly edit `coord/board/tasks.json`, `coord/PLAN.md`, `coord/.runtime/plans/*.json` (plan shards; legacy `coord/board/plans/*.json` is read-only compat), `coord/.runtime/agents.json`, `coord/agents.json`, lock files, or session files.",
    "- Start each session by claiming an owner with `coord/scripts/gov claim --owner <handle|simple-id>`, or use `coord/scripts/gov resume <ticket-id>` when you are re-entering an active ticket.",
    "- Normal flow is `pick` -> `plan --seed` or `start` -> `update-plan` -> `commit` -> `submit` -> `finalize` or `land`.",
    "- `coord/scripts/gov plan <ticket-id>` shows canonical plan readiness; `plan <ticket-id> --seed` creates the startup-ready plan state used by start. `start` auto-seeds the same fields, so `--seed` is mainly for previewing plan readiness before claiming.",
    "- Use `coord/scripts/gov update-plan <ticket-id> ...` (or `plan` with the same flags) for startup attestations, baseline evidence, invariants, requirement closure, repo gates, and review cycles. Do not patch plan JSON or PLAN.md by hand.",
    "- When governance blocks you, use `coord/scripts/gov explain <ticket-id>`, `coord/scripts/gov recent <ticket-id>`, and `coord/scripts/gov recover <ticket-id>` before considering any manual repair.",
    "",
    "Common commands:",
    "- `coord/scripts/gov pick --mode general --limit 3`",
    "- `coord/scripts/gov claim --owner <handle|simple-id>`",
    "- `coord/scripts/gov resume <ticket-id>`",
    "- `coord/scripts/gov explain <ticket-id>`",
    "- `coord/scripts/gov doctor`",
  ].join("\n");
}

function printInitiate(options = {}) {
  if (Object.keys(options).length > 0) {
    fail("initiate does not take options. Run it with no arguments to print the governance primer for this session.");
  }
  console.log(buildInitiateSummary());
}

const {
  applyTicketStatus,
  assignTicketOwner,
  clearTicketOwner,
  ensureLandingIndex,
  ensurePromptIndex,
  ensureReviewFindings,
  ensureWaiverIndex,
  getRows,
  rowsById,
  getTicketRef,
  isLegalStatus,
  readBoard,
  readTicketWaiver,
  runBoardSync,
  setTicketPrRefs,
  writeBoard,
} = createGovernanceBoardState({
  BOARD_RAW_SYMBOL,
  BoardValidationError,
  LEGAL_STATUSES,
  WAIVER_CODES,
  attachTrackedRaw,
  fail: (...args) => fail(...args),
  normalizeBoardIdentityReferences: (...args) => normalizeBoardIdentityReferences(...args),
  readCanonicalTextFile,
  state,
  syncBoardArtifacts,
  writeCanonicalTextFile,
});

const {
  repoPrefixForCode,
  repoPrefixesForCode,
  resolveRepoIntegrationBranch,
  inferRepoCodeFromTicketId,
  resolveRepoCodeForTicket,
  getRepoRoot,
  isRepoBackedCode,
  isProductRepo,
  repoNameForCode,
  repoDisplayNameForCode,
  repoCodeForLockRepoName,
  repoCliAliasesForCode,
  repoCodeForCliRepoArg,
  configuredRepoArgDescription,
} = createRepoRegistry({
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
});

const { parseLifecycleFlags } = createLifecycleFlags({
  fail: (...args) => fail(...args),
  isLegalStatus: (...args) => isLegalStatus(...args),
  LEGAL_FINDING_STATUSES,
});

const {
  resolveCommitishInRepo,
  fetchRepoRef,
  isCommitAncestorOfRef,
  gitPathExistsAtRef,
  auditWorktrees,
  auditCoordWorktrees,
  cleanupWorktree,
  cleanupHelperWorktrees,
  resolveTicketBaseRef,
  gitCommitishExists,
  ensureGitWorktree,
  ensureTicketWorkspace,
  cleanupPreparedTicketWorkspace,
  withPreparedTicketWorkspace,
  auditRepoWorktrees,
  listGitWorktrees,
  resolveCleanupTarget,
  isHelperWorktree,
  gitRefExists,
  gitRemoteBranchExists,
  countCommitsAhead,
  assertCommitAheadCount,
  pushBranchToOrigin,
  preflightPrBranch,
  isInsideGitWorkTree,
  runGit,
  gitOutput,
  defaultWorktreePath,
  coordWorktreesRoot,
  pruneEmptyParents,
  formatMissingStartBaseRefMessage,
  buildDependencyBootstrapGuidance,
  repoBootstrapLabel,
  inferTicketIdFromPath,
  cleanupTicketWorktree,
  cleanupCoordTicketWorktrees,
  cleanupClosedTicketWorkspace,
} = createWorktreeOps({
  fail: (...args) => fail(...args),
  configuredRepoArgDescription: (...args) => configuredRepoArgDescription(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  readBoard: (...args) => readBoard(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  repoCodeForCliRepoArg: (...args) => repoCodeForCliRepoArg(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  // Deferred wrapper: resolveTicketGitContext is a hoisted lifecycle function
  // (depends on the lifecycle-local lock registry) defined far below this call.
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
});

const {
  classifyQuestionOperationalType,
  buildQuestionQueueReport,
  parseTemplateFeedbackRowsFromText,
  readTemplateFeedbackRows,
  ticketNeedsTemplateFeedback,
  latestDoneTimestampByTicket,
  collectTemplateFeedbackAlerts,
  collectStaleTemplateFeedbackErrors,
  isStaleTicketLock,
  isRecoverableGovernanceDriftPath,
  extractTicketIdsFromGovernanceIssues,
  buildDoctorResolutionGuidance,
} = createGovernanceRepair({
  getRows: (...args) => getRows(...args),
  readCanonicalTextFile,
});

const {
  classifyQuestionSeverity,
  classifyQuestionAgingBucket,
  parseQuestionRow,
  readQuestionRows,
  readOrchestratorQuestionRows,
  isActiveOrchestratorQuestionRow,
  readActiveOrchestratorQuestionRows,
  extractDriftMutationStage,
  buildExplainQuestionsGuidance,
  hasResolvedGovernanceRepairQuestion,
  logQuestion,
  appendQuestionRow,
  buildQuestionRow,
  appendQuestionRowText,
  removeQuestionRowText,
} = createQuestions({
  fail: (...args) => fail(...args),
  readCanonicalTextFile,
  writeCanonicalTextFile,
  classifyQuestionOperationalType: (...args) => classifyQuestionOperationalType(...args),
  uniqueStrings: (...args) => uniqueStrings(...args),
  todayIso,
  escapeTable,
});

const {
  runtimeLockStatus,
  breakRuntimeLock,
  detectRollbackDrift,
  collectCleanRuntimeTargets,
  cleanRuntime,
} = createRuntimeCleanup({
  fail: (...args) => fail(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  relativeCoordPath: (...args) => relativeCoordPath(...args),
});

const {
  readPackageScripts,
  resolveGateScript,
  resolveGateInvocation,
  resolveGateArtifactDir,
  detectGatePackageManager,
  runCleanCheckoutGate,
} = createGateRuntime({
  fail: (...args) => fail(...args),
  configuredRepoArgDescription: (...args) => configuredRepoArgDescription(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  repoCodeForCliRepoArg: (...args) => repoCodeForCliRepoArg(...args),
  repoDisplayNameForCode: (...args) => repoDisplayNameForCode(...args),
  readJsonFileFromRef: (...args) => readJsonFileFromRef(...args),
});

const { prView, prCreate, prMerge } = createPrOps({
  fail: (...args) => fail(...args),
  assertCommittedReviewState: (...args) => assertCommittedReviewState(...args),
  ensureDoingTicketLockIntegrity: (...args) => ensureDoingTicketLockIntegrity(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  ghPrListByBranch: (...args) => ghPrListByBranch(...args),
  ghPrView: (...args) => ghPrView(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  isGitHubPrUrl: (...args) => isGitHubPrUrl(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  mergePrUrl: (...args) => mergePrUrl(...args),
  mergeUniqueRefs: (...args) => mergeUniqueRefs(...args),
  preflightPrBranch: (...args) => preflightPrBranch(...args),
  readBoard: (...args) => readBoard(...args),
  recordGovernanceExternalSideEffect: (...args) => recordGovernanceExternalSideEffect(...args),
  resolvePrUrlForTicket: (...args) => resolvePrUrlForTicket(...args),
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  runGh: (...args) => runGh(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  writeBoard: (...args) => writeBoard(...args),
});

function resolveRepoThresholdTicket(threshold, repo) {
  if (!threshold) {
    return null;
  }
  if (typeof threshold === "string") {
    return threshold;
  }
  if (typeof threshold === "object" && repo && typeof threshold[repo] === "string") {
    return threshold[repo];
  }
  return null;
}

function printCounts() {
  const board = readBoard();
  const rows = getRows(board);
  const countsByStatus = {};
  const countsByRepo = {};

  for (const row of rows) {
    increment(countsByStatus, row.Status);
    increment(countsByRepo, row.Repo);
  }

  const supersededRows = rows.filter((row) => row.Status === STATUS.SUPERSEDED);
  const closedRows = rows.filter((row) => row.Status === STATUS.DONE || row.Status === STATUS.SUPERSEDED);
  const openRows = rows.filter((row) => row.Status !== STATUS.DONE && row.Status !== STATUS.SUPERSEDED);
  const activeRows = rows.filter((row) => isDoingStatus(row.Status) || row.Status === STATUS.REVIEW);

  console.log(`Board: ${board.metadata?.title || "Task Board"}`);
  console.log(`Tickets: ${rows.length}`);
  console.log(`Open: ${openRows.length} (excludes done and superseded)`);
  console.log(`Closed: ${closedRows.length}`);
  console.log(`Superseded: ${supersededRows.length}`);
  console.log("");
  console.log("By Status:");
  printObjectLines(countsByStatus);
  console.log("");
  console.log("By Repo:");
  printObjectLines(countsByRepo);
  console.log("");
  console.log("Active:");
  if (activeRows.length === 0) {
    console.log("  none");
  } else {
    for (const row of activeRows) {
      console.log(`  ${row.ID}  ${row.Status}  ${row.Owner}  ${row.Description}`);
    }
  }
  console.log("");
  console.log("Doing Locks:");
  const doingLocks = getLockFiles()
    .map((lockPath) => safeReadJson(lockPath))
    .filter(Boolean)
    .filter((lock) => lock.status === STATUS.DOING);
  if (doingLocks.length === 0) {
    console.log("  none");
  } else {
    for (const lock of doingLocks) {
      console.log(`  ${lock.ticket}  ${lock.owner}  ${lock.repo}  ${lock.worktree}`);
    }
  }
}

function listTickets(filters) {
  const board = readBoard();
  let rows = getRows(board);
  const ownerFilter = filters.owner ? maybeCanonicalOwner(filters.owner) : null;

  if (filters.status) {
    rows = rows.filter((row) => row.Status === filters.status);
  }
  if (filters.repo) {
    rows = rows.filter((row) => row.Repo === filters.repo);
  }
  if (ownerFilter) {
    rows = rows.filter((row) => row.Owner === ownerFilter);
  } else if (filters.owner) {
    rows = rows.filter((row) => row.Owner === filters.owner);
  }
  if (filters.pri) {
    rows = rows.filter((row) => row.Pri === filters.pri);
  }

  if (rows.length === 0) {
    console.log("No matching tickets.");
    return;
  }

  for (const row of rows) {
    console.log(`${row.ID}\t${row.Status}\t${row.Repo}\t${row.Pri}\t${row.Owner}\t${row.Description}`);
  }
}

function pickTickets(scope, filters) {
  if (scope && scope !== "all") {
    fail(`Unknown pick scope "${scope}". Use "pick" or "pick all".`);
  }
  if (scope === "all") {
    return pickAllTickets(filters);
  }
  return pickCurrentAgentTickets(filters);
}

function pickCurrentAgentTickets(filters) {
  const identity = filters.owner
    ? resolveOwnerIdentity(filters.owner, { allowAutoClaim: false, touchSession: false })
    : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
  const owner = identity.agent.handle;
  const board = readBoard();
  const ownerDoing = findDoingTicketForOwner(board, owner);
  if (ownerDoing) {
    console.log(`Current agent ${identity.agent.id} (${owner}) already owns active doing ticket ${ownerDoing.ID}.`);
    return;
  }

  const scored = buildRecommendationSet(filters, {
    board,
    mode: recommendationModeForAgent(identity.agent, filters),
  });
  if (filters.why) {
    const match = scored.scored.find((item) => item.row.ID === filters.why);
    if (!match) {
      fail(`Ticket ${filters.why} was not found in the current pick candidate set for ${owner}.`);
    }
    console.log(JSON.stringify({
      agent: {
        id: identity.agent.id,
        handle: identity.agent.handle,
        lane: identity.agent.lane || null,
        default_repo: identity.agent.default_repo || null,
      },
      ticket: match.row,
      readiness: match.readiness,
      score: match.breakdown,
      has_prompt: match.hasPrompt,
      downstream_open_dependents: match.downstreamOpen,
    }, null, 2));
    return;
  }

  const limit = integerOrDefault(filters.limit, 5);
  const top = scored.visible.slice(0, limit);
  if (top.length === 0) {
    console.log(`No matching recommended tickets for ${owner}.`);
    return;
  }

  console.log(
    `Current agent: ${identity.agent.id}\t${owner}\tlane:${identity.agent.lane || "general"}\tdefault-repo:${identity.agent.default_repo || "X"}`
  );
  printRankedTicketList(`Ordered ticket list for ${owner}`, top, scored.visible.length);
}

function pickAllTickets(filters) {
  if (filters.owner) {
    fail('"pick all" does not accept --owner. Use plain "pick" for one agent or "recommend" for raw board scoring.');
  }
  if (filters.why) {
    fail('"pick all" does not support --why. Use plain "pick --why <ticket-id>" or "recommend --why <ticket-id>".');
  }

  const board = readBoard();
  const idleAgents = listIdleActiveAgentSessions(board);
  if (idleAgents.length === 0) {
    let currentIdentity = null;
    try {
      currentIdentity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch {
      currentIdentity = null;
    }
    const busyAgents = summarizeBusyActiveAgents(board);
    if (!currentIdentity) {
      console.log("No idle active agents are available for pick all, and the current thread is not claimed.");
      console.log("Next: coord/scripts/gov claim --owner <handle|simple-id>");
    } else {
      console.log(`No idle active agents are available for pick all. Current thread is claimed as ${currentIdentity.agent.handle} (${currentIdentity.agent.id}).`);
    }
    if (busyAgents.length > 0) {
      console.log("Active agents already holding doing tickets:");
      for (const entry of busyAgents) {
        console.log(`- ${entry.agent.id}/${entry.agent.handle}\t${entry.ticket.ID}\t${entry.ticket.Repo}\t${entry.ticket.Pri}\t${entry.ticket.Description}`);
      }
    }
    return;
  }

  const recommendationPools = idleAgents.map((entry) => ({
    ...entry,
    mode: recommendationModeForAgent(entry.agent, filters),
    scored: buildRecommendationSet(filters, {
      board,
      mode: recommendationModeForAgent(entry.agent, filters),
    }).visible,
  }));
  const limit = Math.max(1, integerOrDefault(filters.limit, 5));
  const assignments = assignTicketsToAgents(recommendationPools, limit);
  if (assignments.length === 0) {
    console.log("No matching recommended tickets are available for the current idle active agents.");
    return;
  }

  console.log(`Idle active agents (${idleAgents.length}): ${idleAgents.map((entry) => `${entry.agent.id}/${entry.agent.handle}`).join(", ")}`);
  console.log(`Ordered multi-agent picks (${assignments.length}/${Math.min(limit, idleAgents.length)} shown):`);
  for (const [index, assignment] of assignments.entries()) {
    console.log(
      `${index + 1}. ${assignment.agent.id}\t${assignment.agent.handle}\tmode:${assignment.mode}\t-> ${formatRankedTicket(assignment.item)}`
    );
  }
}

function recommendTickets(filters) {
  const scored = buildRecommendationSet(filters);

  if (filters.why) {
    const match = scored.scored.find((item) => item.row.ID === filters.why);
    if (!match) {
      fail(`Ticket ${filters.why} was not found in the current recommendation candidate set.`);
    }
    console.log(JSON.stringify({
      ticket: match.row,
      readiness: match.readiness,
      score: match.breakdown,
      has_prompt: match.hasPrompt,
      downstream_open_dependents: match.downstreamOpen,
    }, null, 2));
    return;
  }

  const limit = integerOrDefault(filters.limit, 5);
  const top = scored.visible.slice(0, limit);
  if (top.length === 0) {
    console.log("No matching recommended tickets.");
    return;
  }

  printRankedTicketList("Ordered ticket list", top, scored.visible.length);
}

function buildRecommendationSet(filters, options = {}) {
  const board = options.board || readBoard();
  const rows = options.rows || getRows(board);
  const byId = options.byId || new Map(rows.map((row) => [row.ID, row]));
  const downstreamCounts = options.downstreamCounts || buildDownstreamCounts(rows);
  const mode = options.mode || filters.mode || inferModeFromRepo(filters.repo);

  let candidates = rows.filter((row) => row.Status === STATUS.TODO);
  if (filters.repo) {
    candidates = candidates.filter((row) => row.Repo === filters.repo);
  }
  if (filters.pri) {
    candidates = candidates.filter((row) => row.Pri === filters.pri);
  }

  const scored = candidates.map((row) => {
    const readiness = evaluateReadiness(row, byId, board);
    const downstreamOpen = downstreamCounts.get(row.ID) || 0;
    const hasPrompt = Boolean(board.prompt_index?.[row.ID]);
    const breakdown = scoreTicket(row, readiness, {
      downstreamOpen,
      hasPrompt,
      mode,
    });
    return {
      row,
      readiness,
      downstreamOpen,
      hasPrompt,
      breakdown,
      score: breakdown.total,
    };
  });

  const visible = filters.includeBlocked
    ? scored
    : scored.filter((item) => item.readiness.ready);

  visible.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.row.ID.localeCompare(b.row.ID);
  });

  return { board, rows, byId, mode, scored, visible };
}

function printRankedTicketList(title, items, totalVisible) {
  console.log(`${title} (${items.length}/${totalVisible} shown):`);
  for (const [index, item] of items.entries()) {
    console.log(`${index + 1}. ${formatRankedTicket(item)}`);
  }
}

function formatRankedTicket(item) {
  const transitiveDetails = formatTransitiveBlockerDetails(item.readiness.blockerChains);
  const blockedNote = item.readiness.ready
    ? "ready"
    : item.readiness.cycles.length > 0
      ? `blocked by cycle ${formatDependencyCycleList(item.readiness.cycles)}`
      : transitiveDetails
        ? `blocked by ${item.readiness.blockedBy.join(", ") || "dependency state"} via ${transitiveDetails}`
        : `blocked by ${item.readiness.blockedBy.join(", ") || "dependency state"}`;
  const promptNote = item.hasPrompt ? "prompt" : "no-prompt";
  return `${item.row.ID}\t${item.row.Repo}\t${item.row.Pri}\t${blockedNote}\tunblocks:${item.downstreamOpen}\t${promptNote}\tscore:${item.score}\t${item.row.Description}`;
}

function recommendationModeForAgent(agent, filters) {
  if (filters.mode) {
    return filters.mode;
  }
  if (agent?.lane && agent.lane !== "general") {
    return agent.lane;
  }
  if (filters.repo) {
    return inferModeFromRepo(filters.repo);
  }
  if (agent?.default_repo) {
    return inferModeFromRepo(agent.default_repo);
  }
  return "general";
}

function summarizeBusyActiveAgents(board, options = {}) {
  const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
  const sessions = Array.isArray(options.sessions) ? options.sessions : readAgentSessions();
  return sessions
    .filter((session) => session.status === "active" && session.board_path === state.BOARD_PATH)
    .sort(compareSessionsMostRecentFirst)
    .map((session) => {
      const resolved = resolveAgentIdentifier(session.handle, agents);
      if (!resolved || resolved.agent.status !== "active") {
        return null;
      }
      const doing = findDoingTicketForOwner(board, resolved.agent.handle);
      if (!doing) {
        return null;
      }
      return {
        agent: resolved.agent,
        session,
        ticket: doing,
      };
    })
    .filter(Boolean);
}

function listIdleActiveAgentSessions(board, options = {}) {
  const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
  const sessions = (Array.isArray(options.sessions) ? options.sessions : readAgentSessions())
    .filter((session) => session.status === "active" && session.board_path === state.BOARD_PATH)
    .sort(compareSessionsMostRecentFirst);
  const deduped = [];
  const seenHandles = new Set();
  for (const session of sessions) {
    if (!session.handle || seenHandles.has(session.handle)) {
      continue;
    }
    seenHandles.add(session.handle);
    const resolved = resolveAgentIdentifier(session.handle, agents);
    if (!resolved || resolved.agent.status !== "active") {
      continue;
    }
    if (findDoingTicketForOwner(board, resolved.agent.handle)) {
      continue;
    }
    deduped.push({ agent: resolved.agent, session });
  }
  deduped.sort((left, right) => left.agent.id.localeCompare(right.agent.id));
  return deduped;
}

function buildReleaseCandidates(board, options = {}) {
  const effectiveThread = Object.prototype.hasOwnProperty.call(options, "effectiveThread")
    ? options.effectiveThread
    : resolveEffectiveThreadId();
  return listIdleActiveAgentSessions(board, options).map(({ agent, session }) => ({
    agent,
    session,
    is_current_thread: Boolean(effectiveThread && session.thread_id === effectiveThread),
    reason: "active session has no doing ticket",
    release_commands: [
      `coord/scripts/gov agent-release ${session.session_id}`,
      `coord/scripts/gov agent-release ${agent.id}`,
    ],
  }));
}

function reapIdleAutoClaimedProviderStubs(options = {}) {
  const provider = options.provider || null;
  const board = options.board || readBoard();
  const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
  const sessions = Array.isArray(options.sessions) ? options.sessions : readAgentSessions();
  const protectedThread = options.protectedThread || null;
  const includeManualStaleAfterMs = Number.isFinite(options.includeManualStaleAfterMs)
    ? options.includeManualStaleAfterMs
    : null;
  const idle = listIdleActiveAgentSessions(board, { agents, sessions });
  const released = [];
  const now = new Date().toISOString();
  const nowMs = Date.now();
  for (const { agent, session } of idle) {
    if (provider && agent.provider !== provider) {
      continue;
    }
    if (!session.auto_claimed) {
      if (includeManualStaleAfterMs === null) {
        continue;
      }
      const lastSeenMs = Date.parse(session.last_seen_at || session.claimed_at || 0);
      if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs < includeManualStaleAfterMs) {
        continue;
      }
    }
    if (protectedThread && session.thread_id === protectedThread) {
      continue;
    }
    session.status = "released";
    session.released_at = now;
    session.last_seen_at = now;
    released.push({ session_id: session.session_id, handle: session.handle, agent_id: agent.id });
  }
  if (released.length > 0 && options.persist !== false) {
    writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
  }
  return { released, sessions };
}

function compareSessionsMostRecentFirst(left, right) {
  const leftTs = Date.parse(left.last_seen_at || left.claimed_at || 0);
  const rightTs = Date.parse(right.last_seen_at || right.claimed_at || 0);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && rightTs !== leftTs) {
    return rightTs - leftTs;
  }
  return String(right.claimed_at || "").localeCompare(String(left.claimed_at || ""));
}

function assignTicketsToAgents(recommendationPools, limit) {
  const usedTickets = new Set();
  const usedAgents = new Set();
  const assignments = [];
  const cap = Math.min(limit, recommendationPools.length);

  while (assignments.length < cap) {
    let best = null;
    for (const pool of recommendationPools) {
      if (usedAgents.has(pool.agent.handle)) {
        continue;
      }
      const nextItem = pool.scored.find((item) => !usedTickets.has(item.row.ID));
      if (!nextItem) {
        continue;
      }
      const candidate = {
        agent: pool.agent,
        session: pool.session,
        mode: pool.mode,
        item: nextItem,
      };
      if (!best || compareAssignedCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
    if (!best) {
      break;
    }
    assignments.push(best);
    usedAgents.add(best.agent.handle);
    usedTickets.add(best.item.row.ID);
  }

  return assignments;
}

function compareAssignedCandidates(left, right) {
  if (right.item.score !== left.item.score) {
    return right.item.score - left.item.score;
  }
  const ticketCmp = left.item.row.ID.localeCompare(right.item.row.ID);
  if (ticketCmp !== 0) {
    return ticketCmp;
  }
  return left.agent.id.localeCompare(right.agent.id);
}

function showTicket(ticketId) {
  if (!ticketId) {
    fail("ticket command requires <ticket-id>.");
  }

  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) {
    fail(`Unknown ticket "${ticketId}".`);
  }

  const payload = {
    ticket: ref.row,
    prompt: board.prompt_index?.[ticketId] || null,
    waiver: readTicketWaiver(board, ticketId),
    pr_refs: board.pr_index?.[ticketId] || [],
    landing: board.landing_index?.[ticketId] || null,
    review_findings: board.review_findings?.[ticketId] || [],
    lock: findLockForTicket(ticketId),
  };
  console.log(JSON.stringify(payload, null, 2));
}


// COORD-091 (Wave 4 residual): rebuildBoardFromJournal / terminalJournalStatus-
// ForTicket / collectTicketsWithJournalDrift were extracted to board-rebuild.js
// (createBoardRebuild factory, wired below after createJournal /
// createGovernanceBoardState) to bring this composition root back under the
// arch size budget. The bindings are re-destructured from the factory and
// re-exported on commands / __testing / cli.js so the public contract is
// unchanged.

function orchestratorCycle(options = {}) {
  doctor(options);
  const unresolved = readActiveOrchestratorQuestionRows();
  const board = readBoard();
  const governanceEvents = readGovernanceEventLog();
  const exceptionSlo = buildOrchestratorExceptionSloReport(board, unresolved, governanceEvents);
  const templateFeedbackAlerts = collectTemplateFeedbackAlerts(board, governanceEvents);
  if (unresolved.length === 0) {
    console.log("Orchestrator cycle OK: no unresolved orchestrator questions.");
    console.log(
      `Exception SLO: blockers=${exceptionSlo.unresolved_blocker_count}; ` +
      `stale=${exceptionSlo.unresolved_aging.stale || 0}; ` +
      `merged_but_not_done=${exceptionSlo.merged_but_not_done.length}; ` +
      `drift_stages=${formatBucketCounts(exceptionSlo.drift_counts_by_stage, Object.keys(exceptionSlo.drift_counts_by_stage).sort()) || "none"}`
    );
    for (const line of formatTemplateFeedbackAlerts(templateFeedbackAlerts)) {
      console.log(line);
    }
    return;
  }
  console.log(`Orchestrator cycle OK: ${unresolved.length} unresolved orchestrator question(s) remain in QUESTIONS.md.`);
  const report = buildQuestionQueueReport(unresolved);
  console.log(
    `Queue by type: ${formatBucketCounts(report.by_type, ["blocker", "repair", "drift-note", "informational"])}`
  );
  console.log(
    `Queue by severity: ${formatBucketCounts(report.by_severity, ["high", "medium", "low"])}`
  );
  console.log(
    `Queue by aging: ${formatBucketCounts(report.by_aging, ["same-day", "aging", "stale"])}`
  );
  if (report.oldest.length > 0) {
    console.log("Oldest queue items:");
    for (const row of report.oldest) {
      console.log(
        `  ${row.date} [${row.aging_bucket}/${row.severity}/${row.operational_type}] ${row.question}`
      );
    }
  }
  console.log(
    `Exception SLO: blockers=${exceptionSlo.unresolved_blocker_count}; ` +
    `stale=${exceptionSlo.unresolved_aging.stale || 0}; ` +
    `merged_but_not_done=${exceptionSlo.merged_but_not_done.length}; ` +
    `drift_stages=${formatBucketCounts(exceptionSlo.drift_counts_by_stage, Object.keys(exceptionSlo.drift_counts_by_stage).sort()) || "none"}`
  );
  for (const line of formatTemplateFeedbackAlerts(templateFeedbackAlerts)) {
    console.log(line);
  }
  if (exceptionSlo.merged_but_not_done.length > 0) {
    console.log("Merged but not done:");
    for (const entry of exceptionSlo.merged_but_not_done) {
      console.log(`  ${entry.ticket} status=${entry.status} merged_at=${entry.merged_at || "unknown"} pr=${entry.pr_url}`);
    }
  }
}

function formatTemplateFeedbackAlerts(alerts = []) {
  if (!alerts.length) {
    return [];
  }
  const lines = [`Template feedback alerts: ${alerts.length} COORD ticket(s) need TEMPLATE_FEEDBACK.md rows.`];
  for (const alert of alerts.slice(0, 10)) {
    const age = alert.age_days === null ? "age=unknown" : `age=${alert.age_days}d`;
    lines.push(`  ${alert.ticket} ${age}: add TEMPLATE_FEEDBACK.md row or human-admin project-local waiver.`);
  }
  if (alerts.length > 10) {
    lines.push(`  ... ${alerts.length - 10} more`);
  }
  return lines;
}

function formatBucketCounts(counts = {}, order = []) {
  return order
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key}=${counts[key]}`)
    .join(", ");
}

function buildMergedButNotDoneReport(board, events = []) {
  const latestByTicket = new Map();
  for (const event of events) {
    if (!event || !event.ticket) {
      continue;
    }
    const sideEffects = Array.isArray(event.details?.external_side_effects)
      ? event.details.external_side_effects
      : Array.isArray(event.external_side_effects)
      ? event.external_side_effects
      : [];
    const merge = sideEffects.find((entry) => entry?.type === "github_pr_merge");
    if (!merge) {
      continue;
    }
    latestByTicket.set(event.ticket, {
      ticket: event.ticket,
      merged_at: merge.merged_at || null,
      pr_url: merge.pr_url || null,
      status: getRows(board).find((row) => row.ID === event.ticket)?.Status || null,
    });
  }
  return [...latestByTicket.values()]
    .filter((entry) => entry.status !== STATUS.DONE)
    .sort((left, right) => String(left.ticket).localeCompare(String(right.ticket)));
}

function buildOrchestratorExceptionSloReport(board, unresolvedRows = [], events = []) {
  const driftCountsByStage = {};
  for (const row of unresolvedRows) {
    const stage = extractDriftMutationStage(row.question);
    if (stage) {
      driftCountsByStage[stage] = (driftCountsByStage[stage] || 0) + 1;
    }
  }
  return {
    unresolved_total: unresolvedRows.length,
    unresolved_blocker_count: unresolvedRows.filter((row) => row.operational_type === "blocker").length,
    unresolved_aging: buildQuestionQueueReport(unresolvedRows).by_aging,
    unresolved_by_severity: buildQuestionQueueReport(unresolvedRows).by_severity,
    drift_counts_by_stage: driftCountsByStage,
    merged_but_not_done: buildMergedButNotDoneReport(board, events),
  };
}

function splitGovernanceProvenanceDrift(drift = []) {
  const warningPrefixes = [
    ".runtime/agent_sessions.json",
    ".runtime/session-threads/",
  ];
  const blocking = [];
  const warnings = [];
  for (const filePath of drift) {
    if (warningPrefixes.some((prefix) => String(filePath || "").startsWith(prefix))) {
      warnings.push(filePath);
    } else {
      blocking.push(filePath);
    }
  }
  return { blocking, warnings };
}

function inspectCanonicalLockMirrorState({ board, row, lock, sessions = [] }) {
  const issues = [];
  const conflicts = [];
  if (!row || !lock || !isCompleteLockPayload(lock) || lock.status !== STATUS.DOING) {
    return {
      canonicalOwner: null,
      agent: null,
      issues,
      conflicts,
      boardRepairNeeded: false,
      sessionRepair: null,
      requiresRepair: false,
    };
  }

  const canonicalOwner = normalizeOwnerValue(lock.owner);
  const agent = canonicalOwner ? resolveAgentIdentifier(canonicalOwner, readAgentsRegistry())?.agent || null : null;
  let boardRepairNeeded = false;
  let sessionRepair = null;

  if (!canonicalOwner) {
    conflicts.push(`Ticket ${row.ID} canonical lock is missing owner metadata.`);
  } else {
    if (!isDoingStatus(row.Status)) {
      issues.push(`Ticket ${row.ID} has canonical doing lock but board status is "${row.Status}".`);
      boardRepairNeeded = true;
    }
    if (!ownerMatches(row.Owner, canonicalOwner)) {
      issues.push(`Ticket ${row.ID} board owner ${row.Owner} does not match canonical lock owner ${canonicalOwner}.`);
      boardRepairNeeded = true;
    }
    if (!agent) {
      conflicts.push(`Ticket ${row.ID} canonical lock owner ${canonicalOwner} is not a registered agent handle.`);
    }
    const doingConflict = board ? findDoingTicketForOwner(board, canonicalOwner, row.ID) : null;
    if (doingConflict && !canOwnerHoldConcurrentDoing(board, row.ID, doingConflict.ID)) {
      conflicts.push(`Ticket ${row.ID} canonical lock owner ${canonicalOwner} conflicts with active doing ticket ${doingConflict.ID}.`);
    }
  }

  if (lock.session_id) {
    const scopedSessions = (sessions || []).filter((session) => session.board_path === state.BOARD_PATH);
    const bySessionId = scopedSessions.filter((session) => session.session_id === lock.session_id);
    if (bySessionId.length > 1) {
      conflicts.push(`Ticket ${row.ID} canonical lock session ${lock.session_id} has multiple session mirror rows.`);
    }
    const activeOwnerSessions = canonicalOwner
      ? scopedSessions.filter((session) =>
        session.handle === canonicalOwner &&
        session.status === "active" &&
        session.session_id !== lock.session_id
      )
      : [];
    if (activeOwnerSessions.length > 0) {
      conflicts.push(
        `Ticket ${row.ID} canonical lock session ${lock.session_id} conflicts with active session binding(s) for ${canonicalOwner}: ` +
        `${activeOwnerSessions.map((session) => session.session_id).join(", ")}.`
      );
    }
    if (bySessionId.length === 1) {
      const existing = bySessionId[0];
      const expectedAgentId = agent?.id || null;
      const expectedThreadId = typeof lock.thread_id === "string" && lock.thread_id.trim() ? lock.thread_id.trim() : null;
      const sessionMatches =
        existing.handle === canonicalOwner &&
        existing.status === "active" &&
        existing.board_root === COORD_DIR &&
        existing.board_path === state.BOARD_PATH &&
        (expectedAgentId === null || existing.agent_id === expectedAgentId) &&
        (expectedThreadId === null || existing.thread_id === expectedThreadId);
      if (!sessionMatches) {
        issues.push(`Ticket ${row.ID} session binding for ${lock.session_id} does not match canonical lock metadata.`);
        sessionRepair = { mode: "normalize", existing };
      }
    } else if (bySessionId.length === 0) {
      issues.push(`Ticket ${row.ID} lock session ${lock.session_id} is missing from agent session state.`);
      sessionRepair = { mode: "create" };
    }
  }

  return {
    canonicalOwner,
    agent,
    issues,
    conflicts,
    boardRepairNeeded,
    sessionRepair,
    requiresRepair: issues.length > 0,
  };
}

function recentEvents(ticketId, options = {}) {
  const limit = Math.max(1, integerOrDefault(options.limit, 10));
  const full = options.full === true;
  let events = readGovernanceEventLog();
  if (ticketId) {
    events = events.filter((event) => event.ticket === ticketId);
  }
  const visible = events.slice(-limit).reverse().map((event) =>
    full ? materializeGovernanceEvent(event) : summarizeGovernanceEvent(event)
  );
  console.log(JSON.stringify({
    ticket: ticketId || null,
    limit,
    full,
    total_events: events.length,
    events: visible,
  }, null, 2));
}

function findLatestTicketGovernanceEvent(ticketId) {
  const events = readGovernanceEventLog().filter((event) => event.ticket === ticketId);
  return events.length > 0 ? events[events.length - 1] : null;
}

function summarizeGovernanceEvent(event) {
  if (!event) {
    return null;
  }
  const externalSideEffects = Array.isArray(event.details?.external_side_effects)
    ? event.details.external_side_effects
    : [];
  return {
    ts: event.ts || null,
    command: event.command || null,
    ticket: event.ticket || null,
    result: event.result || "succeeded",
    before_status: event.before_status ?? null,
    after_status: event.after_status ?? null,
    identity: event.identity || null,
    changed_paths: event.changed_paths || [],
    changed_path_count: Array.isArray(event.changed_paths) ? event.changed_paths.length : 0,
    snapshot_digest: event.snapshot_digest || event.snapshot?.digest || null,
    external_side_effects: externalSideEffects,
    details: event.details || null,
  };
}

function materializeGovernanceEvent(event) {
  if (!event) {
    return null;
  }
  if (event.snapshot) {
    return event;
  }
  if (!event.snapshot_digest) {
    return event;
  }
  return {
    ...event,
    snapshot: readGovernanceSnapshotArtifact(event.snapshot_digest),
  };
}

const QUESTIONS_WORTHY_EVENT_COMMANDS = new Set([
  "recover",
  "repair",
  "manual-reconcile",
  "resume",
]);

function uniqueStrings(values = []) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function collectTicketGovernanceIssueEvents(ticketId, limit = 5) {
  return readGovernanceEventLog()
    .filter((event) => event.ticket === ticketId && QUESTIONS_WORTHY_EVENT_COMMANDS.has(event.command))
    .slice(-limit)
    .reverse()
    .map((event) => ({
      command: event.command,
      ts: event.ts || null,
    }));
}

// COORD-022: per-repo integration branch resolution. The integration branch
// is a project-owned config seam (project.config.js `integrationBranch`,
// surfaced engine-side as REPO_INTEGRATION_BRANCHES). It defaults to "dev"
// when a repo omits it, so the donor's own dev-default repos are byte-identical
// to the prior hardcoded behavior. A `main`-integration adopter now resolves
// "main" here instead of getting the wrong "dev" base ref.
function buildStartPlanBootstrapCommand(ticketId, row) {
  return `coord/scripts/gov plan ${ticketId} --seed`;
}

const {
  PROVIDER_REGISTRY,
  allocateAgentSimpleId,
  allocateLiveSessionId,
  assertRuntimeProviderMatchesAgent,
  assertRegisteredBoundOwner,
  assertTicketMutationOwnership,
  assertTicketRepairOwnership,
  buildActiveSameOwnerOtherThreadMessage,
  buildDefaultAgentHandle,
  buildSessionId,
  canOwnerHoldConcurrentDoing,
  canonicalizeOwnerOrFail,
  collectReferencedAgentIdNumbers,
  currentRuntimeThreadId,
  defaultAgentRegistry,
  defaultHostLabel,
  describeTicketMutationOwnershipIssue,
  detectActiveSameOwnerOtherThread,
  detectRuntimeProvider,
  ensureAgentFiles,
  ensureCurrentAgentIdentity,
  ensureTicketMutationOwnership,
  findActiveProviderSessions,
  findActiveSessionForHandle,
  findDoingTicketForOwner,
  formatAgentSimpleId,
  formatGovernanceJournalUninitializedMessage,
  getOrCreateSessionToken,
  heartbeatAgeMsForSession,
  isCompleteLockPayload,
  isDoingStatus,
  isRegisteredAgentHandle,
  maybeCanonicalOwner,
  normalizeAgentSessions,
  normalizeBoardIdentityReferences,
  normalizeLockIdentityReferences,
  normalizeOwnerValue,
  ownerMatches,
  parseAgentSimpleIdNumber,
  providerConfig,
  providerThreadEnvNames,
  providerThreadIdValue,
  readAgentSessions,
  readAgentsRegistry,
  rebindTicketLock,
  resolveAgentIdentifier,
  resolveEffectiveThreadId,
  resolveLegacyAgentsCompatibilityPath,
  resolveOrCreateEffectiveThreadId,
  resolveOwnerIdentity,
  runtimeHasStableSessionIdentity,
  runtimeSessionFingerprint,
  sessionTokenPath,
  shouldUseLegacyAgentSessionsCompatibility,
  summarizeRecentOwnerLeaseEvidence,
  touchActiveSession,
  writeAgentRegistryFile,
  writeLock,
} = createGovernanceSession({
  AGENT_SESSION_IDLE_MS,
  COORD_DIR,
  GovernanceError,
  SESSION_FINGERPRINT_ENV_VARS,
  compareSessionsMostRecentFirst,
  ensureParentDir,
  ensureWaiverIndex,
  fail,
  findLatestTicketGovernanceEvent: (...args) => findLatestTicketGovernanceEvent(...args),
  formatJsonFileIssue,
  getRows,
  getTicketRef,
  identityV2,
  isRepoBackedCode,
  moveFileIfNeeded,
  readJsonArrayFileOrFail,
  readJsonFileState,
  reapIdleAutoClaimedProviderStubs: (...args) => reapIdleAutoClaimedProviderStubs(...args),
  repoNameForCode,
  resolveLockHead: (...args) => resolveLockHead(...args),
  safeReadJson,
  state,
  summarizeGovernanceEvent: (...args) => summarizeGovernanceEvent(...args),
  withAgentStateLock,
  writeJsonFile,
});

const createFollowups = require("./followups.js");
const {
  buildDependencyRepairNextSteps,
  normalizeFollowupRelation,
  followupRelationToExceptionType,
  applyFollowupRelation,
  nextTicketId,
  printNextId,
  resolveFollowupPromptPath,
  allowsFollowupDependencyReadinessException,
  findOutstandingCloseoutBlockerFollowups,
} = createFollowups({
  fail,
  getRows,
  readBoard,
  uniqueStrings,
  isDoingStatus,
});



const {
  mergedPrAffiliatesWithTicket,
  refsContainMergedPrForTicket,
  mergeUniqueRefs,
  verifyPrEvidence,
  isGitHubPrUrl,
  ghPrIsMerged,
  isTransientGhError,
  sleepSyncMs,
  setRunGhForTesting,
  resetRunGhForTesting,
  setSleepSyncForTesting,
  resetSleepSyncForTesting,
  ghPrView,
  isCheckedOutLocalBranchDeleteFailure,
  shouldIgnoreMergeFailureAfterSuccessfulMerge,
  ghPrListByBranch,
  mergePrUrl,
  buildLandCloseoutAnswer,
  runGh,
} = require("./landing-gh.js");

// COORD-088 (Wave 4 slice 4): landing COMMIT-RESOLUTION surface (git-ancestry /
// base-ref / source-commit resolution) extracted from lifecycle.js. Wired AFTER
// the git-ops factory (resolveCommitishInRepo / fetchRepoRef /
// isCommitAncestorOfRef) and the repo registry (getRepoRoot / isRepoBackedCode)
// are live, and AFTER landing-gh.js (ghPrView / mergeUniqueRefs / toArray are
// injected, not re-implemented), but BEFORE createLandingAudit below — the
// audit factory consumes resolveLandingBaseRef / resolveLandingCommitSha /
// resolveSourceCommitSha / resolveFulfilledByLandingCommit / extractCommitShas.
// resolveTicketGitContext / resolveLockHead are hoisted lifecycle functions
// injected as deferred wrappers so wiring order never matters at call time.
const {
  extractCommitShas,
  refreshLandingBaseRef,
  resolveLandingBaseRef,
  resolvePrLandingBaseRef,
  pickBestLandingCommit,
  resolveSourceCommitSha,
  resolveFulfilledByLandingCommit,
  resolveLandingCommitSha,
} = createLandingResolution({
  fail: (...args) => fail(...args),
  fs,
  DEFAULT_INTEGRATION_BRANCH,
  resolveCommitishInRepo,
  fetchRepoRef,
  isCommitAncestorOfRef,
  getRepoRoot,
  isRepoBackedCode,
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
  resolveLockHead: (...args) => resolveLockHead(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  ghPrView,
  mergeUniqueRefs,
  toArray,
});

const {
  assertAlreadyLandedNoPrReconcileReady,
  assertLandingIntegrity,
  assertReviewPlanReady,
  assertStartPlanReady,
  classifyLandingRecord,
  collectReviewPlanReadinessIssues,
  collectStartReadinessBlockers,
  collectSubmitReadinessBlockers,
  deriveFeatureProofAudit,
  deriveGovernanceReadiness,
  deriveTestingInfrastructureAudit,
  evaluateReadiness,
  fieldHasMeaningfulValue,
  formatDependencyCycleList,
  formatGovernanceBlockers,
  formatTransitiveBlockerDetails,
  gitRefContainsLiteral,
  hasOnlyScaffoldSelfReviewCycles,
  inferRequiredReviewRound,
  isLightLaneEligible,
  isProceduralDocPath,
  resolveTicketLightLane,
  isMeaningfulText,
  normalizeFeatureProofEntryForTicket,
  normalizeSelfReviewCycleLine,
  parseFeatureProofEntry,
  parseSelfReviewCycles,
  readTextFileFromRef,
  replaceSelfReviewCycles,
  requiresFeatureProofGovernance,
  splitDependsOn,
  submitRequiresReviewPlanCheck,
  ticketRequiresBaseline,
  ticketRequiresTraceability,
  validateFeatureProofEntry,
  validateRequirementClosureEntry,
  detectSupersedeLandingBypass,
} = createGovernanceValidation({
  COORD_DIR,
  DEFAULT_PATHS,
  FEATURE_PROOF_EVIDENCE_PREFIX,
  GovernanceError,
  PNPM_BUILTIN_COMMANDS,
  REPO_INTEGRATION_BRANCHES,
  REPO_ROOTS,
  TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
  allowsFollowupDependencyReadinessException: (...args) => allowsFollowupDependencyReadinessException(...args),
  buildDependencyRepairNextSteps: (...args) => buildDependencyRepairNextSteps(...args),
  buildHistoricalCloseoutStartBlocker: (...args) => buildHistoricalCloseoutStartBlocker(...args),
  buildPromptWaiverCommand: (...args) => buildPromptWaiverCommand(...args),
  buildStartPlanBootstrapCommand,
  commitSubjectAffiliatesWithTicket: (...args) => commitSubjectAffiliatesWithTicket(...args),
  // COORD-070: collectLandingAuditCandidates moved to landing-audit.js; injected
  // back (deferred) for classifyLandingRecord, which stays in this module.
  collectLandingAuditCandidates: (...args) => collectLandingAuditCandidates(...args),
  collectTicketGovernanceIssueEvents: (...args) => collectTicketGovernanceIssueEvents(...args),
  describeTicketMutationOwnershipIssue: (...args) => describeTicketMutationOwnershipIssue(...args),
  effectiveTierMinimum: (...args) => effectiveTierMinimum(...args),
  ensureLandingRecord: (...args) => ensureLandingRecord(...args),
  escapeRegex: (...args) => escapeRegex(...args),
  extractFileReferencesFromCommands: (...args) => extractFileReferencesFromCommands(...args),
  extractPackageScriptsFromCommands: (...args) => extractPackageScriptsFromCommands(...args),
  fail: (...args) => fail(...args),
  getRepoRoot,
  getRows,
  rowsById,
  ghPrView,
  gitPathExistsAtRef,
  hasPromptWaiver: (...args) => hasPromptWaiver(...args),
  isCommitAncestorOfRef,
  isGitHubPrUrl,
  isRepoBackedCode,
  isTestingInfrastructureFilePath: (...args) => isTestingInfrastructureFilePath(...args),
  isTestingInfrastructureTicket: (...args) => isTestingInfrastructureTicket(...args),
  isTicketAtOrAfter: (...args) => isTicketAtOrAfter(...args),
  listCommitTouchedPaths: (...args) => listCommitTouchedPaths(...args),
  mergeUniqueRefs,
  mergedPrAffiliatesWithTicket,
  normalizeGovernancePlanShape,
  pickBestLandingCommit,
  readBoard,
  readJsonFileFromRef,
  readLatestPlanBlock: (...args) => readLatestPlanBlock(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  readPlanState: (...args) => readPlanState(...args),
  refreshLandingBaseRef: (...args) => refreshLandingBaseRef(...args),
  repoDisplayNameForCode,
  repoNameForCode,
  repoPrefixesForCode: (...args) => repoPrefixesForCode(...args),
  resolveCommitishInRepo,
  resolveLandingBaseRef,
  resolveLandingCommitSha: (...args) => resolveLandingCommitSha(...args),
  resolveRepoThresholdTicket,
  resolveRepoCodeForTicket,
  resolveSourceCommitSha,
  resolveTicketTier: (...args) => resolveTicketTier(...args),
  state,
  splitPlanPathValues,
  normalizeTestingInfraAuditPath: (...args) => normalizeTestingInfraAuditPath(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
  hasResolvedGovernanceRepairQuestion: (...args) => hasResolvedGovernanceRepairQuestion(...args),
  integerOrDefault,
  ticketPromptRelPathExists: (...args) => ticketPromptRelPathExists(...args),
  defaultTicketPromptRelPath: (...args) => defaultTicketPromptRelPath(...args),
  toArray,
});

// COORD-070 (Wave 3, slice B): landing provenance / audit surface. Wired AFTER
// createGovernanceValidation so the injected classify/derive/requires-landing
// deps are live. The audit-report cluster, the testing-infra / feature-proof
// landing audits, and the landing-RECORD writers were consolidated here out of
// governance-validation.js + lifecycle.js. Mutual deps are bridged with deferred
// wrappers: this module injects classifyLandingRecord / deriveTestingInfrastructure-
// Audit / deriveFeatureProofAudit / requiresLandingGovernance from validation, and
// validation injects collectLandingAuditCandidates back for classifyLandingRecord.
// verifyPrEvidence stays in landing-gh.js (GH-specific) and is NOT moved.
const {
  collectLandingAuditCandidates,
  summarizeLandingAuditEntries,
  collectLandingAuditReport,
  applyLandingAuditBackfill,
  formatLandingAuditSummary,
  ensureTestingInfrastructureLandingAudit,
  ensureFeatureProofLandingAudit,
  ensureLandingRecord,
  persistMergedPrLandingSnapshot,
} = createLandingAudit({
  STATUS,
  REPO_ROOTS,
  REPO_INTEGRATION_BRANCHES,
  TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
  FEATURE_PROOF_EVIDENCE_PREFIX,
  GovernanceError,
  fail: (...args) => fail(...args),
  toArray,
  mergeUniqueRefs,
  extractCommitShas: (...args) => extractCommitShas(...args),
  isRepoBackedCode,
  isGitHubPrUrl,
  getRepoRoot,
  repoNameForCode,
  resolveCommitishInRepo,
  resolveLandingBaseRef: (...args) => resolveLandingBaseRef(...args),
  resolveLandingCommitSha: (...args) => resolveLandingCommitSha(...args),
  resolveSourceCommitSha: (...args) => resolveSourceCommitSha(...args),
  resolveFulfilledByLandingCommit: (...args) => resolveFulfilledByLandingCommit(...args),
  getRows,
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  ensureLandingIndex: (...args) => ensureLandingIndex(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  ghPrView,
  classifyLandingRecord: (...args) => classifyLandingRecord(...args),
  deriveTestingInfrastructureAudit: (...args) => deriveTestingInfrastructureAudit(...args),
  deriveFeatureProofAudit: (...args) => deriveFeatureProofAudit(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
});

const {
  legacyPlanRecordDefaults,
  normalizeLegacyPlanRecordShape,
  planRecordPath,
  resolvePlanRecordReadPath,
  readPlanRecordSchema,
  stripMarkdownCodeTicks,
  parsePlanBlockToRecord,
  normalizePlanMarkdownHeading,
  pushPlanListSection,
  formatSelfReviewCycleForPlanRecord,
  renderPlanRecordBlock,
  appendPlanBlock,
  assertValidPlanRecord,
  readPlanRecord,
  synthesizeHistoricalPlanRecord,
  syncPlanRecordFromBlock,
  readPlanState,
  ensurePlanBlockForUpdate,
  ensurePlanRecordForUpdate,
  appendUniquePlanRecordValue,
  readPlanRecordScaffoldPlaceholders,
  planRecordFieldHasOnlyScaffoldValues,
  planRecordFieldIsStartScaffoldOrResolved,
  isScaffoldWorktreeIntendedFile,
  readRecordedIntendedFilesScaffoldSeed,
  planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
  writePlanRecordScaffoldPlaceholders,
  stripPlanScaffoldValues,
  planRecordHasOnlyScaffoldSelfReviewCycles,
  planRecordHasOnlyMalformedSelfReviewCycles,
  normalizePlanRecordSelfReviewCycle,
  applyPlanUpdateOptionsToRecord,
  writePlanCompatibilityBlockFromRecord,
  updateCanonicalPlanState,
  materializePlanBlockFromRecord,
  extractPlanBlock,
  extractPlanBlockEntries,
  extractPlanBlocks,
  upsertListItem,
  replaceScalarField,
  replacePlanBlock,
  readLatestPlanBlock,
  readPlanListField,
  readPlanScalarField,
  isPlanSectionBoundary,
  normalizePlanPathValue,
  planTargetsCoordOnlyArtifacts,
} = createPlanRecords({
  fail,
  resolveRepoCodeForTicket,
  buildDefaultGovernancePlan,
  normalizeGovernancePlanShape,
  formatGovernancePlanEntry,
  formatGovernanceReviewProfileEntry,
  formatGovernanceRepairEntry,
  parseGovernancePlanEntries,
  scaffoldSelfReviewCycle,
  resolveRepoIntegrationBranch,
  isTestingInfrastructureTicket,
  todayIso,
  escapeTable,
  toArray,
  normalizeSelfReviewCycleLine,
  parseSelfReviewCycles,
  validateRequirementClosureEntry,
  validateFeatureProofEntry,
  normalizeFeatureProofEntryForTicket,
  isMeaningfulText,
  escapeRegex,
  integerOrDefault,
  readBoard,
  getTicketRef,
  inferRequiredReviewRound,
  normalizeOwnerValue,
  repoNameForCode,
  ensurePlanStub,
  mergeUniqueRefs,
  isRepoBackedCode,
});

const {
  assertPromptPreconditionsResolve,
  buildPromptWaiverCommand,
  classifyPreconditionArtifact,
  defaultTicketPromptRelPath,
  ensurePromptCoverageOrDiscover,
  hasPromptWaiver,
  parsePromptLikelyFiles,
  parsePromptPreconditions,
  registerPrompt,
  seedStartIntendedFilesFromPrompt,
  ticketPromptRelPathExists,
  verifyPromptPreconditions,
} = createPromptCoverage({
  ROOT_DIR,
  COORD_DIR,
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  fail,
  getRepoRoot,
  getTicketRef,
  gitCommitishExists,
  gitPathExistsAtRef,
  gitRefContainsLiteral,
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  isRepoBackedCode,
  planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
  planRecordPath,
  readBoard,
  readPlanRecord,
  readTicketWaiver,
  repoDisplayNameForCode,
  resolveTicketBaseRef,
  runBoardSync,
  uniqueStrings,
  withCoordStateLock,
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  writeBoard,
  writeCanonicalJsonFile,
  writePlanCompatibilityBlockFromRecord,
  writePlanRecordScaffoldPlaceholders,
});


function buildPostCloseFollowupCommand(ticketId, row, description = "Follow-up for post-close finding") {
  // <NEW-FOLLOWUP-ID> is a placeholder the operator must replace with a
  // schema-valid ID (^[A-Z]+-\d+$) before running. Earlier this template
  // emitted "${ticketId}-FIX" which looks plausible but fails the board
  // ID regex and gets rejected by gov open-followup itself.
  return `coord/scripts/gov open-followup <NEW-FOLLOWUP-ID> --depends-on ${ticketId} --repo ${row.Repo} --type ${row.Type} --pri ${row.Pri} --description "${description}"`;
}

function ticketHasHistoricalCloseoutEvidence(board, ticketId) {
  const prRefs = board?.pr_index?.[ticketId] || [];
  if (Array.isArray(prRefs) && prRefs.length > 0) {
    return true;
  }
  const landingEvidence = board?.landing_index?.[ticketId]?.evidence || [];
  if (Array.isArray(landingEvidence) && landingEvidence.length > 0) {
    return true;
  }
  const findings = board?.review_findings?.[ticketId] || [];
  return Array.isArray(findings) && findings.length > 0;
}

function buildHistoricalCloseoutStartBlocker(ticketId, row, board) {
  if ((row.Status !== STATUS.TODO && row.Status !== STATUS.DEFERRED) || !ticketHasHistoricalCloseoutEvidence(board, ticketId)) {
    return null;
  }
  return {
    code: "closed_ticket_history",
    message:
      `Ticket ${ticketId} has historical closeout evidence in pr_index, landing_index, or review_findings and cannot be restarted from "${row.Status}". ` +
      `Closed tickets stay closed; create a follow-up ticket instead of reopening through board edits.`,
    next_steps: [buildPostCloseFollowupCommand(ticketId, row)],
  };
}

// COORD-086 (Wave 4 slice 2): the OPERATOR-GUIDANCE surface —
// buildTicketNextCommands (per-status "what to run next" planner), explainTicket
// (read-only ticket explanation report) and runTicketCycle (recommended
// planner/worker/reviewer/closer cycle) — lives in ticket-guidance.js. These
// read board / lock / plan / readiness state and emit guidance JSON; they never
// mutate governance state. Every cross-module primitive is injected as a
// deferred `(...args) => fn(...args)` wrapper so hoisting / wiring order does
// not matter at call time (several deps — collectStartReadinessBlockers,
// deriveGovernanceReadiness, etc. — are produced by factories wired earlier,
// and buildPostCloseFollowupCommand stays owned here and is injected back).
// buildTicketNextCommands / explainTicket / runTicketCycle are re-destructured
// back into lifecycle scope because the cli.js dispatch, module.exports and the
// __testing facade (consumed by cli.js / governance-mcp) still reference them.
const {
  buildTicketNextCommands,
  explainTicket,
  runTicketCycle,
} = createTicketGuidance({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  rowsById: (...args) => rowsById(...args),
  readPlanState: (...args) => readPlanState(...args),
  readTicketWaiver: (...args) => readTicketWaiver(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  collectStartReadinessBlockers: (...args) => collectStartReadinessBlockers(...args),
  collectSubmitReadinessBlockers: (...args) => collectSubmitReadinessBlockers(...args),
  deriveGovernanceReadiness: (...args) => deriveGovernanceReadiness(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  resolveOwnerIdentity: (...args) => resolveOwnerIdentity(...args),
  detectGovernanceProvenanceDrift: (...args) => detectGovernanceProvenanceDrift(...args),
  splitGovernanceProvenanceDrift: (...args) => splitGovernanceProvenanceDrift(...args),
  buildQuestionQueueReport: (...args) => buildQuestionQueueReport(...args),
  readActiveOrchestratorQuestionRows: (...args) => readActiveOrchestratorQuestionRows(...args),
  buildExplainQuestionsGuidance: (...args) => buildExplainQuestionsGuidance(...args),
  collectTicketGovernanceIssueEvents: (...args) => collectTicketGovernanceIssueEvents(...args),
  findLatestTicketGovernanceEvent: (...args) => findLatestTicketGovernanceEvent(...args),
  summarizeGovernanceEvent: (...args) => summarizeGovernanceEvent(...args),
  buildPostCloseFollowupCommand: (...args) => buildPostCloseFollowupCommand(...args),
  shellEscape: (...args) => shellEscape(...args),
});

// COORD-087 (Wave 4 slice 3): the AGENT-COMMAND / claim-orchestration surface —
// the agents list/register/enable/disable verbs, agentid resolve+format, the
// claim / claim-ticket / claim-agent / claim-agent-session cluster, resume,
// release, rebind, the human-admin override resolver, the cwd-claim hazard
// detector and the agent-status report builder — lives in agent-commands.js.
// governance-session.js stays the lower-level SESSION ENGINE; agent-commands.js
// is the command layer above it and INJECTS the session/registry readers+
// writers, identity resolution, owner-lease metadata, board-state readers, the
// mutation/lock wrappers and the journal appender. findLockForTicket /
// getLockFiles are defined later in this file, so they (and other cross-module
// primitives) are injected as deferred `(...args) => fn(...args)` wrappers; the
// returned commands are re-destructured back into lifecycle scope because the
// cli.js dispatch, module.exports and the __testing facade still reference them.
const {
  agentsCommand,
  listAgents,
  printCurrentAgentId,
  resolveCurrentAgentId,
  formatCurrentAgentIdPayload,
  buildUnclaimedAgentIdPayload,
  isNoActiveClaimedSessionError,
  registerAgent,
  claim,
  resumeTicket,
  resolveHumanAdminOverride,
  claimPayloadFromCurrentIdentity,
  claimTicket,
  setAgentRegistryStatus,
  claimAgent,
  detectCwdTicketClaimHazard,
  claimAgentSession,
  releaseAgent,
  rebindAgent,
  showAgentStatus,
  buildAgentStatusPayload,
} = createAgentCommands({
  fail: (...args) => fail(...args),
  state,
  COORD_DIR,
  identityV2,
  PROVIDER_REGISTRY,
  GovernanceError,
  STATUS,
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  withAgentStateLock: (...args) => withAgentStateLock(...args),
  appendGovernanceEvent: (...args) => appendGovernanceEvent(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  getLockFiles: (...args) => getLockFiles(...args),
  rebindTicketLock: (...args) => rebindTicketLock(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  buildActiveSameOwnerOtherThreadMessage: (...args) => buildActiveSameOwnerOtherThreadMessage(...args),
  normalizeLockIdentityReferences: (...args) => normalizeLockIdentityReferences(...args),
  readAgentsRegistry: (...args) => readAgentsRegistry(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  writeAgentRegistryFile: (...args) => writeAgentRegistryFile(...args),
  writeJsonFile: (...args) => writeJsonFile(...args),
  resolveAgentIdentifier: (...args) => resolveAgentIdentifier(...args),
  allocateAgentSimpleId: (...args) => allocateAgentSimpleId(...args),
  buildDefaultAgentHandle: (...args) => buildDefaultAgentHandle(...args),
  buildSessionId: (...args) => buildSessionId(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  detectRuntimeProvider: (...args) => detectRuntimeProvider(...args),
  providerConfig: (...args) => providerConfig(...args),
  assertRuntimeProviderMatchesAgent: (...args) => assertRuntimeProviderMatchesAgent(...args),
  runtimeHasStableSessionIdentity: (...args) => runtimeHasStableSessionIdentity(...args),
  findActiveProviderSessions: (...args) => findActiveProviderSessions(...args),
  defaultHostLabel: (...args) => defaultHostLabel(...args),
  currentRuntimeThreadId: (...args) => currentRuntimeThreadId(...args),
  resolveEffectiveThreadId: (...args) => resolveEffectiveThreadId(...args),
  resolveOrCreateEffectiveThreadId: (...args) => resolveOrCreateEffectiveThreadId(...args),
  summarizeBusyActiveAgents: (...args) => summarizeBusyActiveAgents(...args),
  listIdleActiveAgentSessions: (...args) => listIdleActiveAgentSessions(...args),
  buildReleaseCandidates: (...args) => buildReleaseCandidates(...args),
  safeReadJson: (...args) => safeReadJson(...args),
  parseLifecycleFlags: (...args) => parseLifecycleFlags(...args),
});


// COORD-088: extractCommitShas + refreshLandingBaseRef moved to
// landing-resolution.js (injected via the createLandingResolution factory).

function readCommitSubject(repoRoot, commitish) {
  const commitSha = resolveCommitishInRepo(repoRoot, commitish);
  if (!commitSha) {
    return null;
  }
  const result = gitTry(repoRoot, ["log", "-1", "--format=%s", commitSha]);
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "").trim() || null;
}

function commitSubjectAffiliatesWithTicket(repoRoot, commitish, ticketId) {
  const subject = readCommitSubject(repoRoot, commitish);
  const normalizedTicketId = String(ticketId || "").trim().toLowerCase();
  if (!subject || !normalizedTicketId) {
    return false;
  }
  return subject.toLowerCase().includes(normalizedTicketId);
}

// COORD-088: resolveLandingBaseRef / resolvePrLandingBaseRef / pickBestLanding-
// Commit / resolveSourceCommitSha / resolveFulfilledByLandingCommit /
// resolveLandingCommitSha moved to landing-resolution.js (injected via the
// createLandingResolution factory above).

function auditLandings(options = {}) {
  const ticketId = options.ticket ? String(options.ticket).trim() : null;
  const repo = options.repo ? String(options.repo).trim() : null;
  const supportedRepos = Object.keys(REPO_ROOTS).filter((repoCode) => repoCode !== "X").sort();
  if (repo && !supportedRepos.includes(repo)) {
    fail(`Unsupported repo code "${repo}". Use ${supportedRepos.join(", ")}.`);
  }

  const mutation = {
    command: "audit-landings",
    ticket: ticketId || null,
    allowProvenanceDrift: true,
  };
  const runner = () => {
    const board = readBoard();
    if (ticketId && !getTicketRef(board, ticketId)) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const report = options.write
      ? applyLandingAuditBackfill(board, { ticket: ticketId, repo })
      : collectLandingAuditReport(board, { ticket: ticketId, repo });
    if (options.write && report.backfilled.length > 0) {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    }
    console.log(JSON.stringify(report, null, 2));
  };

  if (options.write) {
    return withGovernanceMutation(mutation, runner);
  }
  return runner();
}

function tokenizeShellWords(value) {
  return (String(value || "").match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^\s]+/g) || [])
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function splitPlanPathValues(values) {
  return toArray(values)
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeTestingInfraAuditPath(repoCode, ticketId, value) {
  let normalized = normalizePlanPathValue(value);
  if (!normalized) {
    return null;
  }
  const repoPrefixes = repoPrefixesForCode(repoCode);
  if (repoPrefixes.length === 0) {
    return null;
  }
  for (const repoPrefix of repoPrefixes) {
    const worktreePrefixPattern = new RegExp(`^${escapeRegex(repoPrefix)}\\.worktrees\\/[^/]+\\/${escapeRegex(ticketId)}\\/`);
    if (worktreePrefixPattern.test(normalized)) {
      normalized = normalized.replace(worktreePrefixPattern, "");
      break;
    }
    if (normalized.startsWith(repoPrefix)) {
      normalized = normalized.slice(repoPrefix.length);
      break;
    }
  }
  normalized = normalized.replace(/^\.\/+/, "");
  const allRepoPrefixes = Object.keys(REPO_ROOTS).flatMap((code) => repoPrefixesForCode(code));
  if (
    !normalized ||
    normalized === "*" ||
    normalized.endsWith("/*") ||
    normalized.includes("*") ||
    allRepoPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    return null;
  }
  return normalized;
}

function isTestingInfrastructureFilePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return TESTING_INFRA_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isTestingInfrastructureClassificationPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (normalized === "package.json" || normalized === "README.md") {
    return false;
  }
  return isTestingInfrastructureFilePath(normalized);
}

function buildTestingInfrastructureClassificationText(row, planState = null) {
  return [
    row?.ID || "",
    row?.Description || "",
    ...(planState?.change_summary || []),
  ].join(" ");
}

function listCommitTouchedPaths(repoRoot, commitSha) {
  const result = gitTry(repoRoot, ["show", "--pretty=format:", "--name-only", commitSha]);
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractPackageScriptsFromCommands(commands) {
  const scripts = new Set();
  for (const command of commands || []) {
    const tokens = tokenizeShellWords(command);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token !== "pnpm" && token !== "npm" && token !== "yarn") {
        continue;
      }
      let cursor = index + 1;
      if (token === "pnpm") {
        while (cursor < tokens.length) {
          const current = tokens[cursor];
          if (current === "-C" || current === "--dir" || current === "--filter") {
            cursor += 2;
            continue;
          }
          if (
            current === "-r" ||
            current === "--recursive" ||
            current === "--workspace-root" ||
            current.startsWith("-C=") ||
            current.startsWith("--dir=") ||
            current.startsWith("--filter=")
          ) {
            cursor += 1;
            continue;
          }
          break;
        }
        const subcommand = tokens[cursor];
        if (!subcommand) {
          continue;
        }
        if (subcommand === "run") {
          const scriptName = sanitizePackageScriptToken(tokens[cursor + 1]);
          if (scriptName) {
            scripts.add(scriptName);
          }
          continue;
        }
        const scriptName = sanitizePackageScriptToken(subcommand);
        if (scriptName && !PNPM_BUILTIN_COMMANDS.has(scriptName)) {
          scripts.add(scriptName);
        }
        continue;
      }
      if (token === "npm") {
        while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
          cursor += 1;
        }
        if (tokens[cursor] === "run") {
          const scriptName = sanitizePackageScriptToken(tokens[cursor + 1]);
          if (scriptName) {
            scripts.add(scriptName);
          }
        }
        continue;
      }
      const yarnScript = sanitizePackageScriptToken(tokens[cursor]);
      if (yarnScript && !["install", "add", "remove", "dlx", "exec"].includes(yarnScript)) {
        scripts.add(yarnScript);
      }
    }
  }
  return [...scripts];
}

function sanitizePackageScriptToken(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/^["']+|["']+$/g, "")
    .replace(/[,:;.)\]}>]+$/, "");
}

// COORD: gov gate bash fallback. Many real repos gate via `bash scripts/gate.sh
// <lane>` and expose NO `gate:<lane>` npm script, which made `gov gate` unusable
// (agents had to run scripts/gate.sh by hand). This resolver FIRST tries the
// existing npm-script resolution (preserving today's behavior exactly) and only
// falls back to a bash invocation when no gate script exists for the lane AND
// scripts/gate.sh is present in the worktree/repo. resolveGateScript itself is
// left intact (its tests depend on the hard fail); we wrap it and catch the
// GovernanceError it throws when no script matches.
function extractFileReferencesFromCommands(ticketId, row, commands) {
  const files = new Set();
  for (const command of commands || []) {
    const tokens = tokenizeShellWords(command);
    for (const token of tokens) {
      const cleaned = String(token || "")
        .replace(/^[([{"'`]+/, "")
        .replace(/[)\]}",;:'`]+$/, "")
        .trim();
      if (!cleaned || /^https?:\/\//.test(cleaned) || !/\.[A-Za-z0-9]+$/.test(cleaned)) {
        continue;
      }
      const normalized = normalizeTestingInfraAuditPath(row.Repo, ticketId, cleaned);
      if (normalized && isTestingInfrastructureFilePath(normalized)) {
        files.add(normalized);
      }
    }
  }
  return [...files];
}

function readJsonFileFromRef(repoRoot, refName, filePath) {
  const result = gitTry(repoRoot, ["show", `${refName}:${filePath}`]);
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(String(result.stdout || ""));
  } catch (_error) {
    return null;
  }
}

function isTestingInfrastructureTicket(row, planState = null) {
  const text = buildTestingInfrastructureClassificationText(row, planState);
  if (/^QGATE-/.test(String(row?.ID || ""))) {
    return true;
  }
  if (TESTING_INFRA_DESCRIPTION_PATTERN.test(text)) {
    return true;
  }
  const plannedFiles = splitPlanPathValues(planState?.intended_files || [])
    .map((entry) => normalizeTestingInfraAuditPath(row?.Repo, row?.ID, entry))
    .filter(Boolean);
  return plannedFiles.some((entry) => isTestingInfrastructureClassificationPath(entry));
}

// cleanupTicketWorktree / cleanupCoordTicketWorktrees / cleanupClosedTicketWorkspace
// moved to worktree-ops.js (Wave 4 slice 5, COORD-089). They are pure worktree
// mechanics (remove/prune a ticket's worktree); the closeout/superseded decision
// of WHEN to clean stays at the lifecycle/transitions/closeout call-sites. They
// are destructured from createWorktreeOps above and re-exposed via the deferred
// wrappers into the transitions/closeout factories and the module.exports/__testing
// facade below. worktree-ops gets resolveTicketGitContext injected as a deferred
// wrapper because that helper depends on the lifecycle-local lock registry.

function requiresLandingGovernance(board, ticketId, row) {
  if (!row || !isRepoBackedCode(row.Repo)) {
    return false;
  }
  const threshold = resolveRepoThresholdTicket(board?.metadata?.landing_index_required_from_ticket, row.Repo);
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

function requiresPrIndexGovernance(board, ticketId, row) {
  if (!row || !isRepoBackedCode(row.Repo)) {
    return false;
  }
  const threshold =
    resolveRepoThresholdTicket(board?.metadata?.pr_index_required_from_ticket, row.Repo) ||
    resolveRepoThresholdTicket(board?.metadata?.landing_index_required_from_ticket, row.Repo) ||
    null;
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

function isTicketAtOrAfter(ticketId, thresholdTicketId) {
  const ticketParts = parseTicketParts(ticketId);
  const thresholdParts = parseTicketParts(thresholdTicketId);
  if (!ticketParts || !thresholdParts || ticketParts.prefix !== thresholdParts.prefix) {
    return false;
  }
  return ticketParts.number >= thresholdParts.number;
}

function parseTicketParts(ticketId) {
  const match = /^([A-Z]+)-(\d+)$/.exec(String(ticketId || ""));
  if (!match) {
    return null;
  }
  return {
    prefix: match[1],
    number: Number.parseInt(match[2], 10),
  };
}


function reopenTicket(ticketId, options) {
  if (!ticketId) {
    fail("reopen-ticket requires <ticket-id>.");
  }

  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) {
    fail(`Unknown ticket "${ticketId}".`);
  }

  fail(
    `reopen-ticket no longer reopens closed or review tickets. ` +
    `Use "open-followup" for post-close findings and "return-doing" for review -> doing with recorded findings.`
  );
}

// COORD-005: resolve the ref a governed worktree's HEAD is measured against
// for workspace-evidence detection. Prefer the remote-tracking ref
// origin/<base> — the local <base> branch can lag the remote, which would
// false-positive the commits-ahead guard. Fall back to the local branch
// name when no remote-tracking ref resolves.
function resolveWorktreeBaseCompareRef(worktree, base) {
  const resolves = (ref) => {
    const r = gitTry(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.status === 0 && Boolean(String(r.stdout || "").trim());
  };
  if (resolves(`origin/${base}`)) return `origin/${base}`;
  return base;
}

// COORD-003: guarded wrong-start exception (`doing -> todo`). GOVERNANCE.md §4
// allows `gov unstart` ONLY when the ticket carries no auditable evidence — any
// review, landing, plan, or workspace evidence must keep the ticket on the
// board for an explicit, recorded transition (move-review / supersede) instead.
function collectUnstartEvidenceBlockers(ticketId, row, board) {
  const blockers = [];

  // Review evidence: recorded findings, PR refs, or a plan past its first round.
  const findings = board.review_findings?.[ticketId];
  if (Array.isArray(findings) && findings.length > 0) {
    blockers.push(`review findings recorded (${findings.length})`);
  }
  const prRefs = board.pr_index?.[ticketId];
  if (Array.isArray(prRefs) && prRefs.length > 0) {
    blockers.push(`pr_index evidence recorded (${prRefs.join(", ")})`);
  }

  // Landing evidence: any landing_index record at all.
  if (board.landing_index && Object.prototype.hasOwnProperty.call(board.landing_index, ticketId)) {
    blockers.push("landing_index evidence recorded");
  }

  // Plan evidence: a plan record that is more than the start-time scaffold.
  const planRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
  if (planRecord) {
    const reviewRound = integerOrDefault(planRecord.review_round, 0);
    if (reviewRound > 1) {
      blockers.push(`plan record advanced to review round ${reviewRound}`);
    } else if (!planRecordHasImplicitIntendedFilesScaffoldPlaceholder(planRecord)) {
      blockers.push("plan record has authored content beyond the start scaffold");
    }
  }

  // Workspace evidence: the ticket worktree exists with commits ahead of base
  // or uncommitted changes.
  const context = resolveTicketGitContext(row, ticketId);
  if (context.worktree && fs.existsSync(context.worktree)) {
    if (isRepoBackedCode(row.Repo)) {
      const statusResult = gitTry(context.worktree, ["status", "--porcelain"]);
      if (statusResult.status === 0 && String(statusResult.stdout || "").trim()) {
        blockers.push(`worktree ${context.worktree} has uncommitted changes`);
      }
      const base = resolveTicketBaseRef(ticketId, row, {});
      if (base) {
        // COORD-005: governed worktrees are created from origin/<base> (GCV-2);
        // measure commits-ahead against the remote-tracking ref so a stale
        // local <base> branch cannot false-positive the guard.
        const compareRef = resolveWorktreeBaseCompareRef(context.worktree, base);
        const aheadResult = gitTry(context.worktree, ["rev-list", "--count", `${compareRef}..HEAD`]);
        const ahead = aheadResult.status === 0
          ? Number.parseInt(String(aheadResult.stdout || "").trim(), 10)
          : 0;
        if (Number.isInteger(ahead) && ahead > 0) {
          blockers.push(`worktree ${context.worktree} has ${ahead} commit(s) ahead of ${compareRef}`);
        }
      }
    } else if (row.Repo === "X") {
      // Repo X worktrees are plain scratch directories with no git history;
      // treat any non-empty residue as workspace evidence.
      let entries = [];
      try {
        entries = fs.readdirSync(context.worktree);
      } catch {
        entries = [];
      }
      if (entries.length > 0) {
        blockers.push(`coord worktree ${context.worktree} is not empty`);
      }
    }
  }

  return blockers;
}

function unstartTicket(ticketId, options = {}) {
  const mutation = {
    command: "unstart",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("unstart requires <ticket-id>.");
    }
    const identity = resolveOwnerIdentity(options.owner);
    mutation.identity = identity;

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (!isDoingStatus(ref.row.Status)) {
      fail(
        `Ticket ${ticketId} must be doing or doing (blocked: ...) to unstart; current status is "${ref.row.Status}". ` +
        `unstart only reverts a wrong start; it is not a general status-revert path.`
      );
    }

    // SAME-OWNER ONLY: the wrong-start exception belongs to the agent that
    // started the ticket. Foreign stale-state cleanup stays an explicit admin
    // path (GOVERNANCE.md §4).
    const lock = findLockForTicket(ticketId);
    const expectedOwner = canonicalizeOwnerOrFail(ref.row.Owner);
    if (identity.agent.handle !== expectedOwner) {
      fail(
        `Ticket ${ticketId} is owned by ${expectedOwner}; ${identity.agent.handle} cannot unstart it. ` +
        `unstart is same-owner only. For foreign stale-state cleanup use an admin path: ` +
        `\`coord/scripts/gov release-lock ${ticketId} --force\` to abandon the lock, ` +
        `or \`coord/scripts/gov claim ${ticketId} --human-admin-override "<reason>"\` to take over.`
      );
    }
    mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);

    // FAIL CLOSED on any auditable evidence — that work belongs on the board.
    const blockers = collectUnstartEvidenceBlockers(ticketId, ref.row, board);
    if (blockers.length > 0) {
      fail(
        `Ticket ${ticketId} cannot be unstarted; it has accrued auditable evidence: ${blockers.join("; ")}. ` +
        `unstart is only for an unworked wrong start. Use \`coord/scripts/gov move-review ${ticketId}\` ` +
        `to keep the work on the board, or \`coord/scripts/gov supersede ${ticketId} --reason "<why>"\` ` +
        `to retire it while preserving its history.`
      );
    }

    const previousStatus = ref.row.Status;
    const cleaned = cleanupClosedTicketWorkspace(ticketId, ref.row, {});
    const lockPath = lock?.path || resolveTicketLockPath(ticketId, { promoteLegacy: true });

    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.TODO);
      clearTicketOwner(ref);
      writeBoard(board);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });

    mutation.afterStatus = STATUS.TODO;
    mutation.details = {
      previous_status: previousStatus,
      cleaned_workspace: cleaned || null,
    };
    console.log(
      `Unstarted ${ticketId}: ${previousStatus} -> todo, cleared owner ${expectedOwner}, ` +
      `removed lock and clean workspace residue.`
    );
  });
}

// GOVERNANCE.md §10.3 foreign-owner recovery: lock-abandon is the FOREIGN/admin
// counterpart of `unstart`. It returns a doing ticket the current session does
// NOT own back to `todo` after a stale foreign lock. The `--human-admin-override`
// flag authorizes touching foreign-owned ticket state; it does NOT authorize
// silent destruction of accrued auditable evidence — that still fails closed.
function lockAbandonTicket(ticketId, options = {}) {
  const mutation = {
    command: "lock-abandon",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("lock-abandon requires <ticket-id>.");
    }

    // The override flag is the authorization gate for touching a ticket the
    // current session does not own. Require an explicit, non-empty reason.
    const overrideReason = String(options.humanAdminOverride || "").trim();
    if (!overrideReason) {
      fail(
        `lock-abandon requires --human-admin-override "<reason>". ` +
        `This admin verb returns a stale foreign-locked doing ticket to todo; ` +
        `the override authorizes touching a ticket the current session does not own.`
      );
    }

    // Identify the current session (NOT --owner): lock-abandon is specifically
    // for a ticket owned by some OTHER session.
    const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false });
    mutation.identity = identity;

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (!isDoingStatus(ref.row.Status)) {
      fail(
        `Ticket ${ticketId} must be doing or doing (blocked: ...) to lock-abandon; current status is "${ref.row.Status}". ` +
        `lock-abandon only clears a stale doing lock; it is not a general status-revert path.`
      );
    }

    // FOREIGN-OWNER ONLY: if the current session owns the ticket, this is the
    // lighter same-owner wrong-start path and needs no override.
    const lock = findLockForTicket(ticketId);
    const expectedOwner = canonicalizeOwnerOrFail(ref.row.Owner);
    if (identity.agent.handle === expectedOwner) {
      fail(
        `Ticket ${ticketId} is owned by the current session (${expectedOwner}); ` +
        `lock-abandon is the foreign-owner admin path. ` +
        `Use \`coord/scripts/gov unstart ${ticketId}\` — the same-owner wrong-start revert needs no override.`
      );
    }

    // FAIL CLOSED on any auditable evidence — abandoning accrued review/landing/
    // plan/workspace evidence to todo would orphan auditable work. The override
    // authorizes the foreign-ownership aspect, NOT silent evidence destruction.
    const blockers = collectUnstartEvidenceBlockers(ticketId, ref.row, board);
    if (blockers.length > 0) {
      fail(
        `Ticket ${ticketId} cannot be lock-abandoned; it has accrued auditable evidence: ${blockers.join("; ")}. ` +
        `--human-admin-override authorizes touching foreign ticket state, not destroying auditable work. ` +
        `Use \`coord/scripts/gov supersede ${ticketId} --reason "<why>"\` to retire it while preserving its history, ` +
        `or \`coord/scripts/gov reconcile ${ticketId} --reason "<why>"\` to record the accepted drift.`
      );
    }

    const previousStatus = ref.row.Status;
    const cleaned = cleanupClosedTicketWorkspace(ticketId, ref.row, {});
    const lockPath = lock?.path || resolveTicketLockPath(ticketId, { promoteLegacy: true });

    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.TODO);
      clearTicketOwner(ref);
      writeBoard(board);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });

    mutation.afterStatus = STATUS.TODO;
    mutation.details = {
      previous_status: previousStatus,
      previous_owner: expectedOwner,
      previous_session_id: lock?.session_id || null,
      human_admin_override_reason: overrideReason,
      cleaned_workspace: cleaned || null,
    };
    console.log(
      `Lock-abandoned ${ticketId}: ${previousStatus} -> todo, cleared stale foreign owner ${expectedOwner}, ` +
      `removed lock and clean workspace residue. Human-admin override reason: ${overrideReason}`
    );
  });
}

function commitTicket(ticketId, options) {
  const mutation = {
    command: "commit",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("commit-ticket requires <ticket-id>.");
    }
    if (!options.message) {
      fail('commit-ticket requires --message "<text>".');
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (ref.row.Status !== STATUS.DOING) {
      fail(`Ticket ${ticketId} must be doing before commit; current status is "${ref.row.Status}".`);
    }
    if (!isRepoBackedCode(ref.row.Repo)) {
      fail(`Ticket ${ticketId} is repo ${ref.row.Repo}; commit-ticket is only supported for repo-backed git worktrees.`);
    }

    const lock = findLockForTicket(ticketId);
    if (!lock) {
      fail(`Ticket ${ticketId} is doing but has no active lock.`);
    }
    mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
    if (!lock.worktree || !fs.existsSync(lock.worktree)) {
      fail(`Ticket ${ticketId} lock points to missing worktree ${lock.worktree}.`);
    }

    const files = toArray(options.files);
    if (files.length === 0 || options.all) {
      runGit(lock.worktree, ["add", "-A"]);
    } else {
      runGit(lock.worktree, ["add", "--", ...files]);
    }

    const staged = gitOutput(lock.worktree, ["diff", "--cached", "--name-only"]).trim();
    if (!staged) {
      fail(`Ticket ${ticketId} has no staged changes to commit in ${lock.worktree}.`);
    }

    runGit(lock.worktree, ["commit", "-m", options.message]);
    const head = gitOutput(lock.worktree, ["rev-parse", "HEAD"]).trim();
    refreshLockHead(ticketId, head);
    console.log(JSON.stringify({
      ticket: ticketId,
      worktree: lock.worktree,
      branch: lock.branch || null,
      head,
      staged_files: staged.split("\n").filter(Boolean),
      committed: true,
    }, null, 2));
  });
}

// Auto-allocate the next free ticket id for a prefix. Scans the board for the
// highest PREFIX-N and returns PREFIX-(N+1), zero-padded to the widest existing
// width (min 3). Always yields a schema-valid ^[A-Z]+-\d+$ id. Race-safe when
// called inside the runtime-lock mutation.
// Cross-repo splitter: one auto-allocated followup per repo, each --relation
// related to the umbrella (ready immediately, no parent-dep deadlock).
function splitTicket(parentId, options) {
  if (!parentId) fail("split-ticket requires <parent-ticket-id>.");
  if (!options.into) fail('split-ticket requires --into <repo-codes>, e.g. --into B,F.');
  const board = readBoard();
  const parentRef = getTicketRef(board, parentId);
  if (!parentRef) fail(`Parent ticket ${parentId} does not exist.`);
  const repos = String(options.into).split(/[,\s]+/).filter(Boolean);
  const prefix = (options.prefix || (parentId.match(/^([A-Z]+)-/) || [])[1] || "").toUpperCase();
  if (!prefix) fail("Could not derive a prefix from the parent id; pass --prefix <PREFIX>.");
  const pri = options.pri || parentRef.row.Pri || "P2";
  const type = options.type || "feature";
  const roleFor = (r) => ({ B: "Backend", F: "Frontend", C: "Legacy" }[r] || `repo ${r}`);
  const parentDesc = String(parentRef.row.Description || "").replace(/\s+/g, " ").slice(0, 500);
  for (const repo of repos) {
    const desc = options.description
      ? `${roleFor(repo)} half of ${parentId}: ${options.description}`
      : `${roleFor(repo)} half of cross-repo ${parentId}. Parent intent: ${parentDesc} — implement the ${roleFor(repo)} portion only; the other half(s) are sibling splits. FILL IN repo-specific acceptance criteria + tests.`;
    openFollowup(null, { prefix, dependsOn: parentId, repo, type, pri, description: desc, relation: "related" });
  }
  console.log(`Split ${parentId} -> ${repos.length} ${prefix}-* halves (${repos.join(", ")}), each related to ${parentId} (ready now). After both land, close the umbrella: gov finalize ${parentId} --no-pr --fulfilled-by-ticket <a-half> --landed "<both PRs>".`);
}

function openFollowup(newTicketId, options) {
  const mutation = { command: "open-followup", ticket: newTicketId || `(auto:${options.prefix || "?"})` };
  return withGovernanceMutation(mutation, () => {
    if (!options.dependsOn) {
      fail("open-followup requires --depends-on <ticket-id>.");
    }
    if (!options.repo || !options.type || !options.pri || !options.description) {
      fail("open-followup requires --repo, --type, --pri, and --description.");
    }

    const board = readBoard();
    if (!newTicketId && options.prefix) {
      newTicketId = nextTicketId(board, options.prefix);
      mutation.ticket = newTicketId;
    }
    if (!newTicketId) {
      fail("open-followup requires <new-ticket-id> or --prefix <PREFIX> to auto-allocate.");
    }
    if (getTicketRef(board, newTicketId)) {
      fail(`Ticket ${newTicketId} already exists.`);
    }

    const parentRef = getTicketRef(board, options.dependsOn);
    if (!parentRef) {
      fail(`Depends-on ticket ${options.dependsOn} does not exist.`);
    }

    const followupPrompt = resolveFollowupPromptPath({
      board,
      parentTicketId: options.dependsOn,
      explicitPrompt: options.prompt,
    });

    const supportedRepos = allBoardRepoCodes();
    if (!supportedRepos.includes(options.repo)) {
      fail(`Unsupported repo code "${options.repo}". Use ${supportedRepos.join(", ")}.`);
    }
    const relation = normalizeFollowupRelation(options, "blocking");
    if (relation === "independent") {
      fail('open-followup does not support --relation independent; use blocking, related, or closeout-blocker.');
    }

    const newRow = {
      ID: newTicketId,
      Repo: options.repo,
      Type: options.type,
      Pri: options.pri,
      Status: STATUS.TODO,
      Owner: options.owner ? canonicalizeOwnerOrFail(options.owner) : "unassigned",
      Description: options.description,
      "Depends On": applyFollowupRelation(board, newTicketId, options.dependsOn, relation),
    };

    const targetSection = options.sectionHeading
      ? board.sections.find((section) => section.heading === options.sectionHeading)
      : parentRef.section;

    if (!targetSection || !Array.isArray(targetSection.rows)) {
      fail("Could not find a target table section for the follow-up ticket.");
    }

    const insertIndex = options.sectionHeading
      ? targetSection.rows.length
      : parentRef.rowIndex + 1;

    targetSection.rows.splice(insertIndex, 0, newRow);
    ensurePromptIndex(board)[newTicketId] = followupPrompt;

    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Created ${relation} follow-up ticket ${newTicketId} after ${options.dependsOn}.`);
  });
}

function setFollowupRelation(ticketId, options) {
  const mutation = { command: "set-followup-relation", ticket: ticketId };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("set-followup-relation requires <ticket-id>.");
    }
    const relation = normalizeFollowupRelation(options, "blocking");
    if (relation !== "independent" && !options.dependsOn) {
      fail(`set-followup-relation ${ticketId} requires --depends-on <ticket-id> unless --relation independent is used.`);
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (relation !== "independent") {
      const parentRef = getTicketRef(board, options.dependsOn);
      if (!parentRef) {
        fail(`Depends-on ticket ${options.dependsOn} does not exist.`);
      }
      if (parentRef.row.ID === ticketId) {
        fail(`Ticket ${ticketId} cannot depend on itself.`);
      }
    }

    ref.row["Depends On"] = applyFollowupRelation(board, ticketId, options.dependsOn, relation);

    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(
      relation === "independent"
        ? `Cleared follow-up dependency metadata for ${ticketId}.`
        : `Set follow-up relation for ${ticketId}: ${relation} -> ${options.dependsOn}.`
    );
  });
}

// Grooming verbs: reprioritize / retype a non-terminal ticket. Pri/Type are
// non-lifecycle backlog metadata, but TASKS.md is a rendered view of canonical
// board state, so they must be mutated through gov (a hand-edit is clobbered by
// the next board write). Guarded + lock-protected, mirroring setFollowupRelation.
const ALLOWED_PRIORITIES = ["P0", "P1", "P2", "P3"];
const ALLOWED_TICKET_TYPES = ["feature", "bug", "chore", "task", "spike", "refactor", "docs", "test"];

function setTicketPriority(ticketId, options) {
  const mutation = { command: "set-priority", ticket: ticketId };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) fail("set-priority requires <ticket-id>.");
    const pri = String(options.pri || "").toUpperCase().trim();
    if (!ALLOWED_PRIORITIES.includes(pri)) fail(`set-priority requires --pri <${ALLOWED_PRIORITIES.join("|")}>.`);
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) fail(`Unknown ticket "${ticketId}".`);
    const status = String(ref.row.Status || "").toLowerCase();
    if (status === STATUS.DONE || status === STATUS.SUPERSEDED) fail(`Refusing to reprioritize ${ticketId} in terminal status "${status}".`);
    const prev = ref.row.Pri;
    if (prev === pri) { console.log(`${ticketId} already ${pri}.`); return; }
    ref.row.Pri = pri;
    withCoordStateLock(() => { writeBoard(board); runBoardSync({ ignoreActiveTicketLockErrors: true }); });
    console.log(`Set priority for ${ticketId}: ${prev} -> ${pri}.`);
  });
}

function setTicketType(ticketId, options) {
  const mutation = { command: "set-type", ticket: ticketId };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) fail("set-type requires <ticket-id>.");
    const type = String(options.type || "").toLowerCase().trim();
    if (!ALLOWED_TICKET_TYPES.includes(type)) fail(`set-type requires --type <${ALLOWED_TICKET_TYPES.join("|")}>.`);
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) fail(`Unknown ticket "${ticketId}".`);
    const status = String(ref.row.Status || "").toLowerCase();
    if (status === STATUS.DONE || status === STATUS.SUPERSEDED) fail(`Refusing to retype ${ticketId} in terminal status "${status}".`);
    const prev = ref.row.Type;
    if (prev === type) { console.log(`${ticketId} already type ${type}.`); return; }
    ref.row.Type = type;
    withCoordStateLock(() => { writeBoard(board); runBoardSync({ ignoreActiveTicketLockErrors: true }); });
    console.log(`Set type for ${ticketId}: ${prev} -> ${type}.`);
  });
}

function setWaiver(ticketId, options) {
  const mutation = {
    command: "set-waiver",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("set-waiver requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    const waiverIndex = ensureWaiverIndex(board);
    if (options.clear) {
      delete waiverIndex[ticketId];
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Cleared waiver for ${ticketId}.`);
      return;
    }

    if (!options.reason) {
      fail("set-waiver requires --reason <text> unless --clear is used.");
    }

    const identity = options.owner
      ? resolveOwnerIdentity(options.owner, { allowAutoClaim: false, touchSession: false })
      : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });

    waiverIndex[ticketId] = {
      code: "prompt_coverage",
      reason: options.reason,
      recorded_at: new Date().toISOString(),
      recorded_by: identity.agent?.handle || maybeCanonicalOwner(options.owner) || options.owner || "unknown",
    };

    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Recorded prompt-coverage waiver for ${ticketId}.`);
  });
}

function setPrRefs(ticketId, options) {
  const mutation = {
    command: "set-pr",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("set-pr requires <ticket-id>.");
    }
    const refs = toArray(options.pr);
    if (refs.length === 0) {
      fail("set-pr requires at least one --pr <ref>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    verifyPrEvidence(ticketId, refs, {
      requireMerged: ref.row.Status === STATUS.DONE,
      allowNoPr: true,
    });
    withCoordStateLock(() => {
      setTicketPrRefs(board, ticketId, refs);
      writeBoard(board);
      if (!options.skipSync) {
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      }
    });
    console.log(`Updated pr_index for ${ticketId}.`);
  });
}

function addFinding(ticketId, options) {
  const mutation = {
    command: "add-finding",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("add-finding requires <ticket-id>.");
    }
    if (!options.severity || !options.summary || !options.qref) {
      fail("add-finding requires --severity, --summary, and --qref.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const findings = ensureReviewFindings(board, ticketId);
    const nextFindingNumber = findings.reduce((maxValue, finding) => {
      const match = String(finding.id || "").match(/-F(\d+)$/);
      if (!match) {
        return maxValue;
      }
      const value = Number(match[1]);
      return Number.isFinite(value) ? Math.max(maxValue, value) : maxValue;
    }, 0) + 1;
    const finding = {
      id: `${ticketId}-F${nextFindingNumber}`,
      severity: options.severity,
      summary: options.summary,
      status: options.status || "open",
      round: integerOrDefault(options.round, inferNextRound(findings)),
      qref: options.qref,
    };
    if (options.deferredTo) {
      finding.deferred_to = options.deferredTo;
    }
    if (options.consolidatedInto) {
      finding.consolidated_into = options.consolidatedInto;
    }
    findings.push(finding);
    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Added finding ${finding.id} to ${ticketId}.`);
  });
}

function updateFinding(ticketId, options) {
  const mutation = {
    command: "update-finding",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("update-finding requires <ticket-id>.");
    }
    if (!options.id || !options.status) {
      fail("update-finding requires --id <finding-id> and --status <status>.");
    }

    const board = readBoard();
    const findings = ensureReviewFindings(board, ticketId);
    const finding = findings.find((candidate) => candidate.id === options.id);
    if (!finding) {
      fail(`Finding ${options.id} does not exist under ${ticketId}.`);
    }

    finding.status = options.status;
    if (options.deferredTo) {
      finding.deferred_to = options.deferredTo;
    }
    if (options.consolidatedInto) {
      finding.consolidated_into = options.consolidatedInto;
    }
    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Updated ${options.id} on ${ticketId} to status=${options.status}.`);
  });
}

function heartbeat(ticketId) {
  const mutation = {
    command: "heartbeat",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("heartbeat requires <ticket-id>.");
    }
    const lockPath = resolveTicketLockPath(ticketId);
    const lock = readLockFileOrFail(ticketId, lockPath);
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
    lock.heartbeat_utc = new Date().toISOString();
    const lockRepoCode = repoCodeForLockRepoName(lock.repo) || ref.row.Repo;
    if (isRepoBackedCode(lockRepoCode) && lock.worktree && fs.existsSync(lock.worktree)) {
      lock.head = resolveLockHead(lockRepoCode, lock.worktree);
    }
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    touchActiveSession(lock.owner, lock.session_id);
    console.log(`Updated heartbeat for ${ticketId}.`);
  });
}

// ---------------------------------------------------------------------------
// COORD-026: cost-ledger (TOKEN_ECONOMICS.md lever #1).
// Records per-ticket/agent/model token + estimated-$ accounting as append-only
// `cost.observed` journal events, and reports them via `gov cost`. Pure
// additive: it is evidence, not a gate, and touches neither lifecycle/verdict
// semantics nor the canonical gov-sync surface. Prices come from the
// data-driven coord/product/model-prices.json table — never hardcoded here.
// Compatibility marker for existing precheck probes: function precheck now
// lives in token-economics.js and is wired below.
// ---------------------------------------------------------------------------

const {
  collectGovernedSnapshotFilePaths,
  buildGovernanceSnapshot,
  captureGovernanceRestorePoint,
  restoreGovernanceRestorePoint,
  governanceRestorePointPath,
  persistGovernanceRestorePoint,
  clearPersistedGovernanceRestorePoint,
  recoverCrashedGovernanceMutation,
  diffGovernanceSnapshots,
  readGovernanceEventLog,
  parseGovernanceEventLogLine,
  governanceSnapshotArtifactPath,
  readGovernanceSnapshotArtifact,
  writeGovernanceSnapshotArtifact,
  readGovernanceSnapshotCheckpoint,
  writeGovernanceSnapshotCheckpoint,
  readLatestGovernanceSnapshotSource,
  readLatestGovernanceEvent,
  ensureGovernanceJournalBaseline,
  detectGovernanceProvenanceDrift,
  gitIgnoredDriftPaths,
  isRuntimeLedgerDriftPath,
  formatGovernanceDriftMessage,
  describeGovernanceMutation,
  detectGovernanceQuestionAuthor,
  buildGovernanceDriftQuestion,
  appendGovernanceDriftQuestion,
  extractDriftSinceTimestamp,
  planStaleDriftNoteRetirement,
  findLatestGovernanceBaselineTimestamp,
  retireStaleDriftNotes,
  applyRetireStaleDriftNotes,
  appendGovernanceEvent,
  repairTornGovernanceEventLogTail,
  hashGovernanceEventRecord,
  verifyGovernanceChain,
  planGovernanceChainRepair,
  repairGovernanceChain,
  summarizeIdentityForEvent,
  recordGovernanceExternalSideEffect,
  formatGovernanceExternalSideEffect,
  withGovernanceMutation,
  inferTicketStatus,
  appendGovernanceProvenanceIssues,
} = createJournal({
  fail,
  relativeCoordPath,
  existingLockDirs,
  writeFileAtomicSync,
  readJsonFileState,
  formatJsonFileIssue,
  readLastNonEmptyLine,
  withGovernanceRuntimeLock,
  readCanonicalTextFile,
  writeCanonicalTextFile,
  buildQuestionRow,
  appendQuestionRowText,
  parseQuestionRow,
  escapeTable,
  ensureCurrentAgentIdentity,
  resolveEffectiveThreadId,
  readAgentSessions,
  readCanonicalJsonFile,
  getRows,
  formatGovernanceJournalUninitializedMessage,
  splitGovernanceProvenanceDrift,
  GovernanceError,
});

// COORD-091: board-rebuild-from-journal surface. Wired AFTER createJournal so
// the injected readGovernanceEventLog / withGovernanceMutation bindings are
// live; readBoard / writeBoard / getTicketRef come from createGovernanceBoardState
// (wired earlier). Deferred wrappers keep call-time resolution order-independent.
const {
  rebuildBoardFromJournal,
  terminalJournalStatusForTicket,
  collectTicketsWithJournalDrift,
} = createBoardRebuild({
  fail: (...args) => fail(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  writeBoard: (...args) => writeBoard(...args),
});

// COORD-060: plan-command surface. Wired after createJournal so the injected
// withGovernanceMutation/inferTicketStatus bindings are live.
const {
  buildStartPlanSeedUpdate,
  planCommandUpdateOptions,
  mergePlanCommandOptions,
  hasPlanCommandUpdates,
  buildPlanNextCommands,
  buildPlanStatusPayload,
  planTicket,
  updatePlanBlock,
  addReviewCycleCommand,
  setReviewCyclesCommand,
  setRequirementClosureCommand,
  addFeatureProofCommand,
  buildFeatureProofEntriesFromOptions,
  dropFeatureProofCommand,
  assertTicketPlanMutationAuthority,
} = createPlanCommand({
  fail: (...args) => fail(...args),
  toArray: (...args) => toArray(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  readPlanState: (...args) => readPlanState(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  collectStartReadinessBlockers: (...args) => collectStartReadinessBlockers(...args),
  collectReviewPlanReadinessIssues: (...args) => collectReviewPlanReadinessIssues(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  resolveHumanAdminOverride: (...args) => resolveHumanAdminOverride(...args),
  defaultStartTraceabilityValue: (...args) => defaultStartTraceabilityValue(...args),
  ticketRequiresBaseline: (...args) => ticketRequiresBaseline(...args),
});

// COORD-069: repo-gate attribution / board-record surface. Wired after
// createPlanCommand so the injected updatePlanBlock binding is live.
const {
  addRepoGateCommand,
  classifyGateAttribution,
  formatRepoGateEntry,
} = createGates({
  fail: (...args) => fail(...args),
  updatePlanBlock: (...args) => updatePlanBlock(...args),
});

// COORD-061: ticket state-machine transitions. Wired after createJournal (for
// withGovernanceMutation/inferTicketStatus) and createPlanCommand (for
// buildStartPlanSeedUpdate). All other deps are function declarations (hoisted)
// or factory-produced bindings; they are injected as deferred wrappers so the
// lookup resolves at call time. moveReview / markDone / applyMarkDone are
// re-destructured into lifecycle scope because finalize/land/finishTicket
// (which stay here) still call them. COORD-062's closeout module is expected to
// inject this same surface.
const {
  startTicket,
  submitTicket,
  moveReview,
  returnDoing,
  markDone,
  applyMarkDone,
  blockTicket,
  unblockTicket,
  supersedeTicket,
  persistReturnDoingState,
} = createTicketTransitions({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  applyTicketStatus: (...args) => applyTicketStatus(...args),
  assignTicketOwner: (...args) => assignTicketOwner(...args),
  clearTicketOwner: (...args) => clearTicketOwner(...args),
  setTicketPrRefs: (...args) => setTicketPrRefs(...args),
  isLegalStatus: (...args) => isLegalStatus(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  runBoardValidate: (...args) => runBoardValidate(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  resolveOwnerIdentity: (...args) => resolveOwnerIdentity(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  assertTicketMutationOwnership: (...args) => assertTicketMutationOwnership(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  resolveTicketLockPath: (...args) => resolveTicketLockPath(...args),
  ensureDoingTicketLockIntegrity: (...args) => ensureDoingTicketLockIntegrity(...args),
  ensureGitWorktree: (...args) => ensureGitWorktree(...args),
  withPreparedTicketWorkspace: (...args) => withPreparedTicketWorkspace(...args),
  cleanupClosedTicketWorkspace: (...args) => cleanupClosedTicketWorkspace(...args),
  writeLock: (...args) => writeLock(...args),
  defaultWorktreePath: (...args) => defaultWorktreePath(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  formatTransitiveBlockerDetails: (...args) => formatTransitiveBlockerDetails(...args),
  formatDependencyCycleList: (...args) => formatDependencyCycleList(...args),
  findDoingTicketForOwner: (...args) => findDoingTicketForOwner(...args),
  canOwnerHoldConcurrentDoing: (...args) => canOwnerHoldConcurrentDoing(...args),
  resolveLifecyclePrRefs: (...args) => resolveLifecyclePrRefs(...args),
  assertReviewPlanReady: (...args) => assertReviewPlanReady(...args),
  assertAlreadyLandedNoPrReconcileReady: (...args) => assertAlreadyLandedNoPrReconcileReady(...args),
  assertCommittedReviewState: (...args) => assertCommittedReviewState(...args),
  refsContainMergedPrForTicket: (...args) => refsContainMergedPrForTicket(...args),
  prCreate: (...args) => prCreate(...args),
  appendReviewFollowupPlan: (...args) => appendReviewFollowupPlan(...args),
  inferNextRound: (...args) => inferNextRound(...args),
  prepareDoneCloseout: (...args) => prepareDoneCloseout(...args),
  buildStartOwnershipRaceMessage: (...args) => buildStartOwnershipRaceMessage(...args),
  buildHistoricalCloseoutStartBlocker: (...args) => buildHistoricalCloseoutStartBlocker(...args),
  ensurePromptCoverageOrDiscover: (...args) => ensurePromptCoverageOrDiscover(...args),
  assertPromptPreconditionsResolve: (...args) => assertPromptPreconditionsResolve(...args),
  ensurePlanStub: (...args) => ensurePlanStub(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  buildStartPlanSeedUpdate: (...args) => buildStartPlanSeedUpdate(...args),
  seedStartIntendedFilesFromPrompt: (...args) => seedStartIntendedFilesFromPrompt(...args),
  assertStartPlanReady: (...args) => assertStartPlanReady(...args),
  buildStartPlanBootstrapCommand: (...args) => buildStartPlanBootstrapCommand(...args),
  detectSupersedeLandingBypass: (...args) => detectSupersedeLandingBypass(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  repoDisplayNameForCode: (...args) => repoDisplayNameForCode(...args),
  resolveTicketBaseRef: (...args) => resolveTicketBaseRef(...args),
  toArray: (...args) => toArray(...args),
  slugify: (...args) => slugify(...args),
  integerOrDefault: (...args) => integerOrDefault(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
});

// COORD-062: ticket closeout / land surface. Wired AFTER createTicketTransitions
// because finalize/land/finish call its moveReview / markDone / applyMarkDone,
// which are injected here. The near-circular edge — transitions.markDone needs
// prepareDoneCloseout, which lives in this module — is resolved by injecting
// closeout's prepareDoneCloseout into the transitions factory above as a
// deferred `(...args) => prepareDoneCloseout(...args)` wrapper that resolves at
// call time (the const below is in scope by then). All other deps are hoisted
// function declarations or factory-produced bindings, injected as deferred
// wrappers. finalizeTicket / finishTicket / landTicket / prepareDoneCloseout are
// re-destructured into lifecycle scope because the __testing facade and the
// command dispatch still reference them.
const {
  finalizeTicket,
  finishTicket,
  landTicket,
  prepareDoneCloseout,
  buildPrCloseoutPlanUpdate,
  buildNoPrCloseoutPlanUpdate,
} = createCloseout({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  setPrRefs: (...args) => setPrRefs(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  moveReview: (...args) => moveReview(...args),
  markDone: (...args) => markDone(...args),
  applyMarkDone: (...args) => applyMarkDone(...args),
  prMerge: (...args) => prMerge(...args),
  persistMergedPrLandingSnapshot: (...args) => persistMergedPrLandingSnapshot(...args),
  refreshLandingBaseRef: (...args) => refreshLandingBaseRef(...args),
  resolvePrUrlForTicket: (...args) => resolvePrUrlForTicket(...args),
  ensureLandingRecord: (...args) => ensureLandingRecord(...args),
  assertLandingIntegrity: (...args) => assertLandingIntegrity(...args),
  ensureTestingInfrastructureLandingAudit: (...args) => ensureTestingInfrastructureLandingAudit(...args),
  ensureFeatureProofLandingAudit: (...args) => ensureFeatureProofLandingAudit(...args),
  verifyPrEvidence: (...args) => verifyPrEvidence(...args),
  assertReviewPlanReady: (...args) => assertReviewPlanReady(...args),
  findOutstandingCloseoutBlockerFollowups: (...args) => findOutstandingCloseoutBlockerFollowups(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  ensureRepoXCloseoutReady: (...args) => ensureRepoXCloseoutReady(...args),
  cleanupTicketWorktree: (...args) => cleanupTicketWorktree(...args),
  resolveLifecyclePrRefs: (...args) => resolveLifecyclePrRefs(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  buildQuestionRow: (...args) => buildQuestionRow(...args),
  buildLandCloseoutAnswer: (...args) => buildLandCloseoutAnswer(...args),
  appendQuestionRowText: (...args) => appendQuestionRowText(...args),
  removeQuestionRowText: (...args) => removeQuestionRowText(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  resolveRepoIntegrationBranch: (...args) => resolveRepoIntegrationBranch(...args),
  mergeUniqueRefs: (...args) => mergeUniqueRefs(...args),
  toArray: (...args) => toArray(...args),
});

// COORD-063 (final Wave 2 slice): the MUTATING governance repair / recovery
// surface. doctorFix / reconcileGovernance / recoverTicket all funnel through
// withGovernanceMutation + the board-state mutators, so this factory is wired
// after createJournal / createGovernanceBoardState. Every dep is a hoisted
// function declaration or factory-produced binding injected as a deferred
// `(...args) => fn(...args)` wrapper that resolves at call time. doctorFix is
// re-destructured back into lifecycle scope because the read-only `doctor`
// report delegates to it on `--fix`; reconcileGovernance / recoverTicket are
// re-destructured because the cli.js dispatch + the module.exports surface
// still reference them. The read-only doctor diagnostics stay in lifecycle.js.
const {
  doctorFix,
  reconcileGovernance,
  recoverTicket,
} = createDoctorRecovery({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  withAgentStateLock: (...args) => withAgentStateLock(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  resolveDoctorScope: (...args) => resolveDoctorScope(...args),
  buildTicketNextCommands: (...args) => buildTicketNextCommands(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  writeJsonFile: (...args) => writeJsonFile(...args),
  defaultHostLabel: (...args) => defaultHostLabel(...args),
  resolveEffectiveThreadId: (...args) => resolveEffectiveThreadId(...args),
  reapIdleAutoClaimedProviderStubs: (...args) => reapIdleAutoClaimedProviderStubs(...args),
  reapGateProcOrphans: (...args) => gateProcRegistry.reapOrphans(...args),
  readAgentsRegistry: (...args) => readAgentsRegistry(...args),
  resolveAgentIdentifier: (...args) => resolveAgentIdentifier(...args),
  findActiveSessionForHandle: (...args) => findActiveSessionForHandle(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  assertTicketRepairOwnership: (...args) => assertTicketRepairOwnership(...args),
  inspectCanonicalLockMirrorState: (...args) => inspectCanonicalLockMirrorState(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  isStaleTicketLock: (...args) => isStaleTicketLock(...args),
  getLockFiles: (...args) => getLockFiles(...args),
  resolveTicketLockPath: (...args) => resolveTicketLockPath(...args),
  readLockFileState: (...args) => readLockFileState(...args),
  isCompleteLockPayload: (...args) => isCompleteLockPayload(...args),
  writeLock: (...args) => writeLock(...args),
  resolveLockHead: (...args) => resolveLockHead(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  ensurePlanStub: (...args) => ensurePlanStub(...args),
  applyRetireStaleDriftNotes: (...args) => applyRetireStaleDriftNotes(...args),
  auditCoordWorktrees: (...args) => auditCoordWorktrees(...args),
  pruneEmptyParents: (...args) => pruneEmptyParents(...args),
  coordWorktreesRoot: (...args) => coordWorktreesRoot(...args),
  defaultWorktreePath: (...args) => defaultWorktreePath(...args),
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
  detectGovernanceProvenanceDrift: (...args) => detectGovernanceProvenanceDrift(...args),
  isRecoverableGovernanceDriftPath: (...args) => isRecoverableGovernanceDriftPath(...args),
  formatGovernanceDriftMessage: (...args) => formatGovernanceDriftMessage(...args),
  safeReadJson: (...args) => safeReadJson(...args),
  relativeCoordPath: (...args) => relativeCoordPath(...args),
  readDirectoryLockMetadata: (...args) => readDirectoryLockMetadata(...args),
  isProcessAlive: (...args) => isProcessAlive(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  slugify: (...args) => slugify(...args),
  identityV2,
});

// COORD-085 (Wave 4 slice 1): the READ-ONLY governance doctor REPORTING
// surface. resolveDoctorScope / resolveDoctorOwnerScope / the read-only
// doctor() report + buildCanonicalDerivedDriftError live in doctor-report.js;
// the MUTATING repair (doctorFix) lives in doctor-recovery.js. This factory is
// wired AFTER createDoctorRecovery so doctorFix is in scope to inject for the
// read-only doctor()'s `--fix` delegation. The recovery factory above injects
// resolveDoctorScope via a deferred `(...args) => fn(...args)` wrapper, which
// resolves to the report-produced binding below at call time (the mutual
// report<->repair reference is the documented cyclic seam). Every dep is a
// deferred wrapper so hoisting / wiring order does not matter at call time.
// doctor / orchestratorCycle / resolveDoctorScope / resolveDoctorOwnerScope /
// buildCanonicalDerivedDriftError are re-destructured back into lifecycle scope
// because orchestratorCycle, the cli.js dispatch, module.exports and the
// __testing facade still reference them.
const {
  doctor,
  resolveDoctorScope,
  resolveDoctorOwnerScope,
  buildCanonicalDerivedDriftError,
} = createDoctorReport({
  fail: (...args) => fail(...args),
  doctorFix: (...args) => doctorFix(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  runBoardValidate: (...args) => runBoardValidate(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  formatDependencyCycleList: (...args) => formatDependencyCycleList(...args),
  formatTransitiveBlockerDetails: (...args) => formatTransitiveBlockerDetails(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
  hasPromptWaiver: (...args) => hasPromptWaiver(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  isStaleTicketLock: (...args) => isStaleTicketLock(...args),
  safeResolveLockHead: (...args) => safeResolveLockHead(...args),
  inspectCanonicalLockMirrorState: (...args) => inspectCanonicalLockMirrorState(...args),
  auditRepoWorktrees: (...args) => auditRepoWorktrees(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  isNoActiveClaimedSessionError: (...args) => isNoActiveClaimedSessionError(...args),
  isRegisteredAgentHandle: (...args) => isRegisteredAgentHandle(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  assertLandingIntegrity: (...args) => assertLandingIntegrity(...args),
  ensureTestingInfrastructureLandingAudit: (...args) => ensureTestingInfrastructureLandingAudit(...args),
  collectLandingAuditReport: (...args) => collectLandingAuditReport(...args),
  formatLandingAuditSummary: (...args) => formatLandingAuditSummary(...args),
  appendGovernanceProvenanceIssues: (...args) => appendGovernanceProvenanceIssues(...args),
  detectRollbackDrift: (...args) => detectRollbackDrift(...args),
  computeSyncDelta: (...args) => computeSyncDelta(...args),
  canonicalSyncablePaths: (...args) => canonicalSyncablePaths(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
  collectStaleTemplateFeedbackErrors: (...args) => collectStaleTemplateFeedbackErrors(...args),
  buildQuestionQueueReport: (...args) => buildQuestionQueueReport(...args),
  readActiveOrchestratorQuestionRows: (...args) => readActiveOrchestratorQuestionRows(...args),
  formatBucketCounts: (...args) => formatBucketCounts(...args),
  buildDoctorResolutionGuidance: (...args) => buildDoctorResolutionGuidance(...args),
  detectGateProcOrphans: (...args) => gateProcRegistry.detectOrphans(...args),
});

// COORD-092: MUTATING gate process-orphan reaper. Kills ONLY processes recorded
// in the gate-proc registry whose owning gate-run/ticket is gone, AND only after
// the PID-reuse guard (recorded PID start-time == live start-time) confirms the
// live PID is still the same process coord recorded. Then removes the registry
// entry. Provenance-scoped by recorded PID+start-time — structurally never a
// process-name scan. Surfaced as `gov reap-gate-procs` and reused by the
// doctorFix repair pass. The owning-ticket liveness is decided against the board
// (a ticket is "doing" iff its row has a doing status).
function reapGateProcs(options = {}) {
  const board = readBoard();
  const byId = rowsById(board);
  const isTicketDoing = (ticketId) => {
    const row = byId.get(ticketId);
    return Boolean(row && isDoingStatus(row.Status));
  };
  const result = gateProcRegistry.reapOrphans({
    isTicketDoing,
    dryRun: Boolean(options.dryRun),
  });
  console.log(JSON.stringify({
    status: result.reaped.length > 0 ? "reaped" : "noop",
    ...result,
  }, null, 2));
  return result;
}

// COORD-107: the ENT conformance / engine-integrity CLI verb surface
// (`gov conform` ENT-002/ENT-010 + `gov verify-engine` ENT-011) extracted to
// conformance-verbs.js. lifecycle.js remains the composition root: it requires
// the two factory CREATORS and injects them (plus the journal chain verifier,
// the GovernanceError `fail`, and COORD_DIR) so the extracted module stays a
// thin DI wrapper. `conform`/`verifyEngine` are destructured back out for the
// `commands` dispatch map + cli.js case wiring, preserving behavior parity.
const {
  conform,
  repairChain,
  verifyEngine,
} = createConformanceVerbs({
  coordDir: COORD_DIR,
  fail,
  verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
  repairGovernanceChain: (...args) => repairGovernanceChain(...args),
  // COORD-124: best-effort actor identity for the on-chain repair marker. Never
  // auto-claims / touches sessions; falls back to null so the verb still works in
  // a clean-env (no session) invocation.
  resolveRepairIdentity: () => {
    try {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch {
      return null;
    }
  },
  createConformanceAttestation,
  createEnginePin,
});

const {
  readModelPrices,
  resolveModelPrice,
  estimateCostUsd,
  recordCost,
  collectCostObservations,
  aggregateCost,
  costReport,
  loadTicketPrecheckProbes,
  runPrecheckProbe,
  classifyPrecheckVerdict,
  precheck,
  parseTicketPromptSections,
  minePriorProofsAndInvariants,
  ticketFilesIntersect,
  buildContextPack,
  contextPack,
  readTierPolicy,
  resolveTicketTier,
  tierEvidenceMinimums,
  effectiveTierMinimum,
  tierCommand,
  parseTicketDependsOn,
  planWaves,
  dispatchCachePrefixMarker,
  dispatchPrecheckVerdict,
  dispatchActionForTicket,
  dispatchPlan,
} = createTokenEconomics({
  fail,
  relativeCoordPath,
  ensureCurrentAgentIdentity,
  withGovernanceMutation,
  readBoard,
  getRows,
  getTicketRef,
  readGovernanceEventLog,
  readPlanRecord,
  isRepoBackedCode,
});

// ENT-005: OTLP exporter (COMMUNITY tier). Reads the durable journal and emits
// it as OTLP/JSON (tickets-as-traces, lifecycle-verbs-as-spans, cost/tier/
// attribution as span attributes; non-ticket events as log records). Zero-dep +
// deterministic. Wired here so it shares the live journal/board/tier deps; it is
// READ-ONLY (writes only to its own output file/stdout, or POSTs when
// --endpoint is given) and never enters withGovernanceMutation.
const {
  otlpExport,
} = createOtlpExport({
  fail,
  readGovernanceEventLog,
  readBoard,
  getRows,
  resolveTicketTier,
});

function backfillPlanRecords(options = {}) {
  const mutation = { command: "backfill-plan-records" };
  return withGovernanceMutation(mutation, () => {
    const board = readBoard();
    const rows = getRows(board);
    const statuses = new Set(
      toArray(options.status).length > 0
        ? toArray(options.status)
        : [STATUS.REVIEW, STATUS.DONE]
    );
    const limit = options.limit ? integerOrDefault(options.limit, null) : null;

    const boardRepoCodes = new Set(allBoardRepoCodes());
    const candidates = rows
      .filter((row) => boardRepoCodes.has(row.Repo))
      .filter((row) => statuses.has(row.Status))
      .filter((row) => {
        const threshold =
          resolveRepoThresholdTicket(options.from, row.Repo) ||
          resolveRepoThresholdTicket(board.metadata?.plan_records_required_from_ticket, row.Repo) ||
          resolveRepoThresholdTicket(board.metadata?.landing_index_required_from_ticket, row.Repo);
        return !threshold || isTicketAtOrAfter(row.ID, threshold);
      })
      .filter((row) => !readPlanRecord(row.ID, { allowMissing: true }))
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : undefined);

    const created = [];
    withCoordStateLock(() => {
      for (const row of candidates) {
        const block = readLatestPlanBlock(row.ID);
        if (block) {
          syncPlanRecordFromBlock(row.ID, block);
          created.push({ ticket: row.ID, mode: "markdown" });
          continue;
        }
        const record = synthesizeHistoricalPlanRecord(row.ID, row, board);
        writeCanonicalJsonFile(planRecordPath(row.ID), record, { expectedRaw: "" });
        created.push({ ticket: row.ID, mode: "synthetic" });
      }
      if (created.length > 0) {
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      }
    });

    console.log(JSON.stringify({
      statuses: [...statuses],
      created,
      created_count: created.length,
    }, null, 2));
  });
}

function releaseLock(ticketId, options) {
  const mutation = {
    command: "release-lock",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("release-lock requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    const lockPath = resolveTicketLockPath(ticketId);
    if (!fs.existsSync(lockPath)) {
      fail(`No lock file exists for ${ticketId}.`);
    }

    if (ref && ref.row.Status === STATUS.DOING && !options.force) {
      fail(`Ticket ${ticketId} is still doing. Use --force only for recovery/stale-lock cleanup.`);
    }

    fs.unlinkSync(lockPath);
    console.log(`Released lock ${path.relative(ROOT_DIR, lockPath)}.`);
  });
}

// COORD-022: detect the package manager for the clean-checkout gate from the
// lockfile present in the worktree, so npm/yarn adopters are not forced onto
// pnpm. Returns the binary, the frozen/ci install args, and a runScriptArgs
// builder for invoking a package.json script. Falls back to pnpm (the donor
// default) when no recognized lockfile is present, preserving prior behavior.
// Phase 4 (repair-path hardening): detect when a destructive operation could
// silently discard newer governance state. Pure and fully guarded: never
// throws on a missing git binary, missing remote, offline fetch state, or a
// missing/unreadable journal/board. Reused by `clean-runtime` (refuses without
// --force) and surfaced as non-fatal doctor warnings.
// Phase 4 (repair-path hardening): enumerate conservatively-classified
// regenerable runtime cruft under state.RUNTIME_DIR. NEVER includes ticket-local
// state (locks/, plans/), session files, the governance journal/snapshots,
// or anything tracked by git. Returns { candidates, protected }.
// Phase 4 (repair-path hardening): supported, safe replacement for ad hoc
// `git clean/reset` inside coord. By default it deletes NOTHING — it
// enumerates candidates and requires --yes to act (mirrors cleanup-worktree's
// "rerun with --yes" guard). It refuses entirely when rollback drift is
// detected unless --force, and never removes ticket-local state without an
// explicit --include-ticket-state AND --yes.
// Resolve the integration branch (--base) for a ticket. Order:
//   1. explicit options.base / options.baseRef (caller override)
//   2. plan record's governance.expected_closeout.base_ref
//   3. per-repo default from REPO_INTEGRATION_BRANCHES (paths.js)
//   4. historical fallback "dev"
// Prevents start/return-doing/commit from defaulting to "dev" when a repo's
// actual integration branch is configured differently in paths.js.
// Registry-generalized: derive the human-facing repo label from the registry
// (M1 repoNameForCode) instead of hardcoding board codes to repo names.
function assertCommittedReviewState(ticketId, row, lock, options = {}) {
  if (!lock || !isRepoBackedCode(row.Repo)) {
    return;
  }
  assertCurrentTicketLockIntegrity(ticketId, row, lock);
  if (!lock.worktree || !fs.existsSync(lock.worktree)) {
    fail(`Ticket ${ticketId} has no readable governed worktree to verify commit state.`);
  }

  const statusResult = gitTry(lock.worktree, ["status", "--porcelain"]);
  if (statusResult.status !== 0) {
    fail(`Could not verify git status for ${ticketId} in ${lock.worktree}.`);
  }
  if (String(statusResult.stdout || "").trim()) {
    fail(`Ticket ${ticketId} has uncommitted changes in ${lock.worktree}. Commit the work before review/PR creation.`);
  }

  const repoRoot = getRepoRoot(row.Repo);
  const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);
  // COORD-022: compare against this repo's configured integration branch
  // (default "dev"), not a hardcoded "dev", so main-integration adopters get
  // a correct ahead-count delta.
  const compareBaseRef = resolveLandingBaseRef(repoRoot, resolveRepoIntegrationBranch(row.Repo), sourceCommitSha, {
    explicitBase: options.baseExplicit === true,
  }).baseRef;

  const aheadResult = gitTry(lock.worktree, ["rev-list", "--count", `${compareBaseRef}..HEAD`]);
  if (aheadResult.status !== 0) {
    fail(`Could not verify commit delta for ${ticketId} against ${compareBaseRef} in ${lock.worktree}.`);
  }
  const aheadCount = Number.parseInt(String(aheadResult.stdout || "").trim(), 10);
  if (!Number.isFinite(aheadCount) || aheadCount < 1) {
    if (options.allowMergedPrReconcile === true) {
      return;
    }
    if (options.allowAlreadyLandedNoPrReconcile === true) {
      return;
    }
    if (planTargetsCoordOnlyArtifacts(ticketId)) {
      return;
    }
    if (
      sourceCommitSha &&
      isCommitAncestorOfRef(repoRoot, sourceCommitSha, compareBaseRef) &&
      commitSubjectAffiliatesWithTicket(repoRoot, sourceCommitSha, ticketId)
    ) {
      fail(
        `Ticket ${ticketId} has no committed changes ahead of ${compareBaseRef} because its governed source commit ${sourceCommitSha} ` +
        `already appears landed on ${repoNameForCode(row.Repo)}/${compareBaseRef}. ` +
        `Use \`coord/scripts/gov finalize ${ticketId} --no-pr --already-landed --landed "<canonical-branch closeout proof>"\` instead of supersede.`
      );
    }
    fail(
      `Ticket ${ticketId} has no committed changes ahead of ${compareBaseRef}. Commit the work before review/PR creation. ` +
      `If the ticket was already landed on ${compareBaseRef} before review, use ` +
      `\`coord/scripts/gov finalize ${ticketId} --no-pr --already-landed --landed "<canonical-branch closeout proof>"\`.`
    );
  }
}

function assertCurrentTicketLockIntegrity(ticketId, row, lock) {
  if (!lock || !isRepoBackedCode(row.Repo)) {
    return;
  }
  const expectedPrefix = `${getRepoRoot(row.Repo)}/.worktrees/`;
  if (!String(lock.worktree || "").startsWith(expectedPrefix)) {
    fail(`Ticket ${ticketId} lock points to non-canonical worktree path ${lock.worktree}.`);
  }
  const liveHead = safeResolveLockHead(row.Repo, lock.worktree);
  if (!liveHead) {
    fail(`Ticket ${ticketId} lock points to worktree without a readable git HEAD.`);
  }
  if (lock.head !== liveHead) {
    fail(`Ticket ${ticketId} lock head ${lock.head || "(missing)"} does not match worktree HEAD ${liveHead}.`);
  }
}

function scaffoldSelfReviewCycle(cycleNumber, totalCycles, {
  lens,
  diff,
  risks,
  findings,
  verification,
  verdict,
} = {}) {
  const raw = [
    `lens=${lens || "TODO"}`,
    `diff=${diff || "TODO"}`,
    `risks=${Array.isArray(risks) && risks.length > 0 ? risks.join(", ") : "TODO"}`,
    `findings=${findings || "TODO"}`,
    `verification=${verification || "TODO"}`,
    `verdict=${verdict || "TODO"}`,
  ].join("; ");
  return {
    cycle: cycleNumber,
    total: totalCycles,
    lens: lens || "TODO",
    diff: diff || "TODO",
    risks: Array.isArray(risks) && risks.length > 0 ? risks : ["TODO"],
    findings: findings || "TODO",
    verification: verification || "TODO",
    verdict: verdict || "TODO",
    raw,
  };
}

function buildDefaultGovernancePlan(repoCode) {
  const isRepoBacked = isRepoBackedCode(repoCode);
  // COORD-007: seed expected_closeout.base_ref from REPO_INTEGRATION_BRANCHES so
  // new plan records pick up the repo's configured integration branch instead
  // of always defaulting to "dev".
  const integrationBranch = isRepoBacked
    ? (REPO_INTEGRATION_BRANCHES[repoCode] || DEFAULT_INTEGRATION_BRANCH)
    : "main";
  return {
    expected_closeout: {
      method: isRepoBacked ? "pr" : "no_pr",
      base_ref: integrationBranch,
      provenance_note: null,
    },
    review_profile: "standard",
    ticket_local_repairs: [],
  };
}

function normalizeGovernancePlanShape(governance, repoCode) {
  const defaults = buildDefaultGovernancePlan(repoCode);
  const genericDefaults = buildDefaultGovernancePlan("X");
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) {
    return defaults;
  }
  const expectedCloseout = governance.expected_closeout &&
    typeof governance.expected_closeout === "object" &&
    !Array.isArray(governance.expected_closeout)
      ? governance.expected_closeout
      : {};
  const repairs = Array.isArray(governance.ticket_local_repairs) ? governance.ticket_local_repairs : [];
  const normalized = {
    expected_closeout: {
      method: String(expectedCloseout.method || defaults.expected_closeout.method),
      base_ref: String(expectedCloseout.base_ref || defaults.expected_closeout.base_ref),
      provenance_note: expectedCloseout.provenance_note == null ? null : String(expectedCloseout.provenance_note),
    },
    review_profile:
      String(governance.review_profile || defaults.review_profile).trim() === "bounded_repair"
        ? "bounded_repair"
        : defaults.review_profile,
    ticket_local_repairs: repairs
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => ({
        kind: String(entry.kind || "").trim(),
        required_question_logged: Boolean(entry.required_question_logged),
        note: entry.note == null ? null : String(entry.note),
      }))
      .filter((entry) => entry.kind),
  };
  if (
    isRepoBackedCode(repoCode) &&
    normalized.expected_closeout.method === genericDefaults.expected_closeout.method &&
    normalized.expected_closeout.base_ref === genericDefaults.expected_closeout.base_ref &&
    normalized.review_profile === genericDefaults.review_profile &&
    normalized.expected_closeout.provenance_note == null &&
    normalized.ticket_local_repairs.length === 0
  ) {
    return defaults;
  }
  return normalized;
}

function formatGovernancePlanEntry(value) {
  return `expected_closeout: method=${value.expected_closeout.method}; base_ref=${value.expected_closeout.base_ref}; provenance_note=${value.expected_closeout.provenance_note || "none"}`;
}

function formatGovernanceReviewProfileEntry(value) {
  return `review_profile: ${value.review_profile || "standard"}`;
}

function formatGovernanceRepairEntry(entry) {
  return `ticket_local_repair: kind=${entry.kind}; required_question_logged=${entry.required_question_logged ? "yes" : "no"}; note=${entry.note || "none"}`;
}

function parseGovernancePlanEntries(values, repoCode = "X") {
  const governance = buildDefaultGovernancePlan(repoCode);
  for (const rawValue of values || []) {
    const value = String(rawValue || "").trim();
    if (!value) {
      continue;
    }
    if (/^expected_closeout:/i.test(value)) {
      const method = /method=([^;]+)/i.exec(value)?.[1]?.trim();
      const baseRef = /base_ref=([^;]+)/i.exec(value)?.[1]?.trim();
      const provenanceNote = /provenance_note=(.+)$/i.exec(value)?.[1]?.trim();
      if (method) {
        governance.expected_closeout.method = method;
      }
      if (baseRef) {
        governance.expected_closeout.base_ref = baseRef;
      }
      governance.expected_closeout.provenance_note =
        provenanceNote && provenanceNote.toLowerCase() !== "none" ? provenanceNote : null;
      continue;
    }
    if (/^review_profile:/i.test(value)) {
      const reviewProfile = value.replace(/^review_profile:\s*/i, "").trim();
      governance.review_profile = reviewProfile === "bounded_repair" ? "bounded_repair" : "standard";
      continue;
    }
    if (/^ticket_local_repair:/i.test(value)) {
      const kind = /kind=([^;]+)/i.exec(value)?.[1]?.trim();
      if (!kind) {
        continue;
      }
      const requiredQuestionLogged = /required_question_logged=([^;]+)/i.exec(value)?.[1]?.trim().toLowerCase() === "yes";
      const note = /note=(.+)$/i.exec(value)?.[1]?.trim();
      governance.ticket_local_repairs.push({
        kind,
        required_question_logged: requiredQuestionLogged,
        note: note && note.toLowerCase() !== "none" ? note : null,
      });
    }
  }
  return governance;
}

function buildScaffoldPlanRecord(ticketId, repoCode, owner, options = {}) {
  const repoPrefix = repoNameForCode(repoCode);
  const intendedFilesPlaceholder = `${repoPrefix}/.worktrees/${owner}/${ticketId}/*`;
  const now = new Date().toISOString();
  const reviewRound = Number.isInteger(options.reviewRound) && options.reviewRound > 0
    ? options.reviewRound
    : 1;
  const totalCycles = isRepoBackedCode(repoCode) ? 4 : 3;
  const priorFindings = toArray(options.priorFindings).filter(Boolean);
  const changeSummary = toArray(options.changeSummary).filter(Boolean);

  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — ${now}`,
    startup_checklist: ["TODO: completed"],
    traceability_gate: ["TODO: verified | closing-gap | exempt"],
    governance: buildDefaultGovernancePlan(repoCode),
    review_round: reviewRound,
    baseline_reproduction: [
      "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
      "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
    ],
    prior_findings: priorFindings,
    scaffold_placeholders: {
      intended_files: [intendedFilesPlaceholder],
    },
    intended_files: [intendedFilesPlaceholder],
    change_summary: changeSummary.length > 0 ? changeSummary : ["TODO: describe the intended change."],
    verification_commands: ["TODO"],
    critical_invariants: [
      "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
      "TODO: include at least one invariant about state/contract consistency",
    ],
    requirement_closure: [
      "TODO: Ticket ask: <what the ticket said to deliver>",
      "TODO: Implemented: <what is actually delivered in this change>",
      "TODO: Not implemented: <residual gap or none>",
      "TODO: Deferred to: <ticket-id or none>",
      "TODO: Closeout verdict: complete | incomplete",
    ],
    feature_proof: [
      "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
      "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
    ],
    repo_gates: ["TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets"],
    self_review_cycles: [
      scaffoldSelfReviewCycle(1, totalCycles, {
        lens: "TODO contract/state invariants",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
      }),
      scaffoldSelfReviewCycle(2, totalCycles, {
        lens: "TODO auth/security/failure modes",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
      }),
      scaffoldSelfReviewCycle(3, totalCycles, {
        lens: "TODO tests/operability/performance",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
      }),
      ...(totalCycles > 3 ? [scaffoldSelfReviewCycle(4, totalCycles, {
        lens: "TODO requirement closure",
        diff: "TODO ticket ask vs implemented vs deferred scope",
        risks: ["TODO omitted requirement", "TODO incorrect closeout claim"],
        findings: "TODO none or describe scope gaps fixed",
        verification: "TODO compare ticket ask, files, and follow-up tickets",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
      })] : []),
    ],
    rollback_strategy: ["TODO"],
    security_surface: "no",
    synced_from_markdown_at: now,
  };
}

function ensurePlanStub(ticketId, repoCode, owner) {
  const plan = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
  const existingRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
  const existingBlock = extractPlanBlock(plan, ticketId);
  if (existingRecord) {
    if (existingBlock) {
      return { createdMarkdownBlock: false, source: "existing-record-and-block" };
    }
    const block = renderPlanRecordBlock(existingRecord, ticketId);
    writeCanonicalTextFile(state.PLAN_PATH, appendPlanBlock(plan, block), { expectedRaw: plan });
    return { createdMarkdownBlock: true, source: "canonical-record" };
  }
  if (existingBlock) {
    syncPlanRecordFromBlock(ticketId, existingBlock);
    return { createdMarkdownBlock: false, source: "existing-block" };
  }

  const record = buildScaffoldPlanRecord(ticketId, repoCode, owner);
  writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw: "" });
  writePlanCompatibilityBlockFromRecord(ticketId, record);
  return { createdMarkdownBlock: true, source: "new-stub" };
}

function defaultStartTraceabilityValue(row) {
  return ticketRequiresTraceability(row) ? "closing-gap" : "exempt";
}

function appendReviewFollowupPlan(ticketId, findingId, summary, repoCode, owner, round = 1) {
  const existingRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
  const record = existingRecord
    ? JSON.parse(JSON.stringify(existingRecord))
    : buildScaffoldPlanRecord(ticketId, repoCode, owner, {
        reviewRound: round,
        priorFindings: [],
        changeSummary: [],
      });
  const normalizedGovernance = normalizeGovernancePlanShape(record.governance, repoCode);
  const priorFindingEntry = `${findingId} — ${summary}`;
  record.review_round = round;
  record.prior_findings = appendUniquePlanRecordValue(record.prior_findings || [], priorFindingEntry);
  record.change_summary = appendUniquePlanRecordValue(
    stripPlanScaffoldValues("change_summary", record.change_summary || [], {
      ticketId,
      incomingValue: `Address review return finding ${findingId}.`,
      scaffoldValues: readPlanRecordScaffoldPlaceholders(record, "change_summary"),
    }),
    `Address review return finding ${findingId}.`
  );
  normalizedGovernance.ticket_local_repairs = [
    ...(Array.isArray(normalizedGovernance.ticket_local_repairs) ? normalizedGovernance.ticket_local_repairs : []),
    {
      kind: "return_doing",
      required_question_logged: false,
      note: `Repair round ${round} started for ${findingId}.`,
    },
  ];
  record.governance = normalizedGovernance;
  record.self_review_cycles = buildScaffoldPlanRecord(ticketId, repoCode, owner, {
    reviewRound: round,
    priorFindings: record.prior_findings,
    changeSummary: record.change_summary,
  }).self_review_cycles;
  const expectedRaw = existingRecord?.[BOARD_RAW_SYMBOL] ?? "";
  writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw });
  writePlanCompatibilityBlockFromRecord(ticketId, record);
}

function getLockFiles() {
  const filesByName = new Map();
  for (const dirPath of existingLockDirs()) {
    for (const fileName of fs.readdirSync(dirPath).filter((entry) => entry.endsWith(".lock")).sort()) {
      if (!filesByName.has(fileName)) {
        filesByName.set(fileName, path.join(dirPath, fileName));
      }
    }
  }
  return [...filesByName.values()];
}

function findLockForTicket(ticketId) {
  for (const lockPath of getLockFiles()) {
    const lock = normalizeLockIdentityReferences(safeReadJson(lockPath));
    if (lock && lock.ticket === ticketId) {
      return { path: lockPath, ...lock };
    }
  }
  return null;
}

function readLockFileState(lockPath) {
  const state = readJsonFileState(lockPath);
  return {
    ...state,
    value: normalizeLockIdentityReferences(state.value),
  };
}

function describeLockFileIssue(ticketId, lockPath, state) {
  const relativePath = relativeCoordPath(lockPath);
  if (!state?.exists) {
    return `No lock file exists for ${ticketId}.`;
  }
  if (state.error instanceof SyntaxError) {
    return `Lock file ${relativePath} for ${ticketId} is not valid JSON: ${state.error.message}`;
  }
  if (state.error) {
    return `Could not read lock file ${relativePath} for ${ticketId}: ${state.error.message}`;
  }
  return `Lock file ${relativePath} for ${ticketId} must contain a JSON object.`;
}

function readLockFileOrFail(ticketId, lockPath, options = {}) {
  const state = readLockFileState(lockPath);
  if (!state.exists) {
    if (options.allowMissing === true) {
      return null;
    }
    fail(describeLockFileIssue(ticketId, lockPath, state));
  }
  if (state.error || !state.value || typeof state.value !== "object" || Array.isArray(state.value)) {
    fail(describeLockFileIssue(ticketId, lockPath, state));
  }
  return state.value;
}

function buildStartOwnershipRaceMessage(ticketId, row) {
  const owner = row?.Owner && row.Owner !== "unassigned" ? canonicalizeOwnerOrFail(row.Owner) : null;
  const status = String(row?.Status || "").trim() || "unknown";
  if (!owner) {
    return `Ticket ${ticketId} must be todo or deferred to start; current status is "${status}".`;
  }
  const activeSession = findActiveSessionForHandle(owner);
  const sessionText = activeSession?.session_id ? ` active_session=${activeSession.session_id}.` : "";
  if (status === STATUS.DOING || status === STATUS.REVIEW) {
    return (
      `Ticket ${ticketId} is already ${status} under ${owner}.${sessionText} ` +
      `Another agent likely won the race to claim it. ` +
      `Run \`coord/scripts/gov explain ${ticketId}\` to inspect the live state, or pick another ticket.`
    );
  }
  return `Ticket ${ticketId} must be todo or deferred to start; current status is "${status}" under owner ${owner}.`;
}


// GCV-3 — deterministic regen + scope-limited commit of canonical
// derived artifacts. Replaces the heavy-handed `git add -A` "board-sync"
// pattern with a scope-frozen single commit on ONLY the C6-classified
// canonical tracked-derived paths. First slice: standalone command.
// Lifecycle-boundary auto-trigger (post-`land`) is the next commit;
// `gov doctor` invariant tightening is the third. Propagation to
// acme-ops/coord and acme stays held (downstream-gated per spec).

// COORD-022: detect whether a directory is inside a git work tree. The
// canonical multi-repo-workspace shape places coord/ outside any git repo;
// in that legitimate shape gov sync has no repo to commit into and must skip
// quietly (clear single-line info) rather than emit a scary failure warning.
function runSyncCommand(options = {}) {
  // Step 0: the canonical sync surface is git-backed. When the coord root is
  // not inside a git work tree (the off-git multi-repo-workspace shape), there
  // is nothing to commit — skip with a clear single-line info message and a
  // success status instead of regenerating + failing on the git commit.
  if (!isInsideGitWorkTree(COORD_DIR)) {
    const summary = {
      command: "sync",
      repo_root: relativeCoordPath(COORD_DIR),
      skipped: true,
      reason: "coord root is not inside a git work tree",
    };
    if (options.quiet !== true) {
      console.log("[gov sync] coord root is not inside a git work tree; skipping canonical sync (nothing to commit).");
    }
    return summary;
  }

  // Step 1: regenerate the canonical derived artifacts from current state.
  runBoardSync({ ticketScopedValidation: false });

  // Step 2: detect which canonical paths (and only those) now differ from
  // git HEAD. The path set is small and explicit — no ambient sweep.
  const repoRoot = COORD_DIR;
  // COORD-196: the standalone `gov sync` surface deliberately EXCLUDES the
  // canonical board json (board/tasks.json) — see canonicalSyncablePaths():
  // on a non-terminal mutation the row is mid-flight (todo/doing/review) and
  // committing it would freeze an in-progress transition. But terminal
  // lifecycle boundaries (finalize/land/mark-done/finish) flip the row to its
  // FINAL `done` state (status + Owner + landing_index) BEFORE this sync runs,
  // so on those boundaries the board json MUST join the same scope-limited sync
  // commit — otherwise the canonical source of truth reads not-done until a
  // manual corrective commit. `includeBoardJson` is the opt-in seam those
  // terminal callers (autoSyncAfterLifecycle) set; standalone `gov sync` never
  // sets it and keeps its frozen surface.
  const paths = canonicalSyncablePaths();
  if (options.includeBoardJson === true) {
    const boardRel = path
      .relative(COORD_DIR, DEFAULT_PATHS.boardPath)
      .split(path.sep)
      .join("/");
    if (!paths.includes(boardRel)) {
      paths.push(boardRel);
    }
  }
  const delta = computeSyncDelta(repoRoot, paths);
  const quiet = options.quiet === true;
  const emit = (payload) => {
    if (!quiet) console.log(JSON.stringify(payload, null, 2));
  };

  const summary = {
    command: "sync",
    repo_root: relativeCoordPath(repoRoot),
    canonical_paths: paths,
    delta,
    committed: false,
  };

  if (delta.length === 0) {
    summary.note = "No drift on canonical derived paths; nothing to commit.";
    emit(summary);
    return summary;
  }
  if (!options.commit) {
    summary.note =
      "Drift detected on canonical derived paths. Re-run with " +
      '`--commit "<message>"` to create a deterministic single commit ' +
      "limited to these paths.";
    emit(summary);
    return summary;
  }

  // Step 3: scope-limited commit on the delta paths only.
  const message =
    String(options.commit).trim() ||
    "chore(coord): deterministic gov sync of canonical derived artifacts";
  commitCanonicalDelta(repoRoot, message, delta);
  summary.committed = true;
  summary.message = message;
  emit(summary);
  return summary;
}

// Stage and commit exactly the given delta paths in repoRoot. The commit
// is scope-limited via pathspec — even if the index has UNRELATED staged
// files, they are NOT included in this commit. That closes reviewer
// finding #2 on PR #4: a `git commit -m <msg>` without pathspec would
// have included any pre-existing staged files alongside the auto-sync
// after a lifecycle action, silently breaking the "single commit limited
// to canonical derived paths" claim.
function commitCanonicalDelta(repoRoot, message, delta) {
  if (!Array.isArray(delta) || delta.length === 0) {
    fail("commitCanonicalDelta requires a non-empty delta list.");
  }
  const stage = gitTry(repoRoot, ["add", "--", ...delta]);
  if (stage.status !== 0) {
    fail(
      `git add failed in ${repoRoot}: ` +
        String(stage.stderr || "").trim()
    );
  }
  // pathspec on commit is what actually enforces the scope-limit; the
  // pre-emptive `git add` stays as defense-in-depth so new/untracked
  // delta files are explicitly staged first.
  const commit = gitTry(repoRoot, ["commit", "-m", message, "--", ...delta]);
  if (commit.status !== 0) {
    fail(
      `git commit failed in ${repoRoot}: ` +
        String(commit.stderr || "").trim()
    );
  }
}

// GCV-3 slice 2 — best-effort auto-trigger at terminal lifecycle
// boundaries (post-land / finalize / mark-done). A sync failure does NOT
// unwind the lifecycle action (which may have already merged a PR / closed
// a ticket / made other irreversible side-effects); we log a clear warning
// and let `gov doctor` (slice 3) enforce the journal-vs-board invariant.
// `syncFn` is injectable so unit tests don't have to touch live COORD_DIR.
function buildAutoSyncMessage(verb, ticketId) {
  const v = String(verb || "").trim() || "lifecycle";
  const t = String(ticketId || "").trim();
  return `chore(coord): sync canonical derived artifacts (post-${v}${t ? ` ${t}` : ""})`;
}

// ENT-001: opt-in push of the post-finalize canonical-sync commit so the
// durable journal/plans/snapshots reach the coord remote without a manual
// step. This is OPT-IN (flag `--push-after-sync` or env COORD_PUSH_ON_FINALIZE)
// and NEVER the default. It does a plain (non-force) `git push` of the current
// branch to its configured upstream; if there is no upstream / no remote it
// skips with a clear reason rather than failing the lifecycle action (which
// already succeeded). `pushFn` is injectable for tests.
function pushOnFinalizeEnabled(options = {}) {
  if (options && options.pushAfterSync === true) return true;
  const env = process.env.COORD_PUSH_ON_FINALIZE;
  return typeof env === "string" && env.trim() !== "" && env.trim() !== "0" && env.trim().toLowerCase() !== "false";
}

function pushAfterLifecycleSync({ verb, repoRoot = COORD_DIR, pushFn } = {}) {
  const doPush = typeof pushFn === "function" ? pushFn : (root) => gitTry(root, ["push"]);
  const result = doPush(repoRoot);
  if (result && result.status === 0) {
    return { pushed: true };
  }
  const stderr = String((result && result.stderr) || "").trim();
  // No upstream configured / no remote: opt-in push has nothing to push to.
  if (/no upstream|no configured push destination|does not appear to be a git repository|No such remote/i.test(stderr)) {
    return { pushed: false, reason: "no-upstream-or-remote", detail: stderr };
  }
  console.warn(
    `[gov sync] opt-in post-${verb} push failed: ${stderr || "unknown error"}\n` +
    `The ${verb} action and local sync commit succeeded; the durable journal/` +
    `plans/snapshots are committed locally. Push manually with \`git push\`.`
  );
  return { pushed: false, failed: true, detail: stderr };
}

function autoSyncAfterLifecycle({ verb, ticketId, options = {}, syncFn, pushFn } = {}) {
  if (options && options.noSync === true) {
    return { skipped: true, reason: "--no-sync" };
  }
  const sync = typeof syncFn === "function" ? syncFn : runSyncCommand;
  const message = buildAutoSyncMessage(verb, ticketId);
  try {
    // COORD-196: every caller of this helper is a TERMINAL lifecycle boundary
    // (finalize/land/close/finish/mark-done/finish-ticket) — by the time we run,
    // the board row has already been flipped to its final `done` state on disk.
    // Include the canonical board json (board/tasks.json) in the same
    // scope-limited sync commit so the row transition lands ATOMICALLY with the
    // derived-artifact sync; without this the source of truth reads not-done
    // until a manual corrective commit (observed across the X-lane finalizes).
    const result = sync({ commit: message, quiet: true, includeBoardJson: true });
    // ENT-001: opt-in push only when something was actually committed, so a
    // no-op sync doesn't push an unrelated already-tracked tip.
    let push = { pushed: false, reason: "not-requested" };
    if (pushOnFinalizeEnabled(options)) {
      push = result && result.committed
        ? pushAfterLifecycleSync({ verb, pushFn })
        : { pushed: false, reason: "no-commit-to-push" };
    }
    return { skipped: false, result, push };
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    // Benign: a coord/ checkout that isn't itself a git worktree can't be
    // synced; that's expected and not a drift signal, so skip quietly.
    if (/not a git repository|show-toplevel failed|rev-parse --show-toplevel/i.test(reason)) {
      return { skipped: true, reason: "coord-root-not-a-git-repo" };
    }
    // Best-effort: never throw out of this helper. The lifecycle action
    // already succeeded by the time we get here.
    console.warn(
      `[gov sync] best-effort post-${verb} sync failed: ${reason}\n` +
      `The ${verb} action itself succeeded; canonical derived artifacts ` +
      `may now lag the journal. Run \`gov sync --commit "<msg>"\` ` +
      `manually, or rely on \`gov doctor\` to surface persistent drift.`
    );
    return { skipped: false, failed: true, error: reason };
  }
}

function runBoardValidate(options = {}) {
  try {
    validateBoardState({
      ...options,
      ticketScopedValidation:
        options.ticketScopedValidation ??
        Boolean(state.activeGovernanceMutationContext?.metadata?.ticket),
      currentTicketId: options.currentTicketId || state.activeGovernanceMutationContext?.metadata?.ticket || null,
    });
  } catch (error) {
    if (error instanceof BoardValidationError) {
      fail(error.message);
    }
    throw error;
  }
}

function resolveLockHead(repoCode, worktree) {
  if (!isRepoBackedCode(repoCode)) {
    return "coord-no-git-head";
  }
  const result = gitTry(worktree, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    fail(`Could not resolve HEAD for worktree ${worktree}.`);
  }
  return String(result.stdout || "").trim();
}

function safeResolveLockHead(repoCode, worktree) {
  try {
    return resolveLockHead(repoCode, worktree);
  } catch (_) {
    return null;
  }
}

function refreshLockHead(ticketId, head = null) {
  const lockPath = resolveTicketLockPath(ticketId, { promoteLegacy: true });
  const lock = readLockFileOrFail(ticketId, lockPath);
  const repoCode = repoCodeForLockRepoName(lock.repo);
  if (isRepoBackedCode(repoCode)) {
    lock.head = head || resolveLockHead(repoCode, lock.worktree);
  } else {
    lock.head = "coord-no-git-head";
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function relativeCoordPath(filePath) {
  return path.relative(COORD_DIR, filePath).replace(/\\/g, "/");
}

function shouldUseLegacyLockCompatibility() {
  return path.basename(state.LOCKS_DIR) === "locks" && path.basename(path.dirname(state.LOCKS_DIR)) === ".runtime";
}

function existingLockDirs() {
  const dirs = [];
  if (fs.existsSync(state.LOCKS_DIR)) {
    dirs.push(state.LOCKS_DIR);
  }
  if (
    shouldUseLegacyLockCompatibility() &&
    state.LEGACY_LOCKS_DIR !== state.LOCKS_DIR &&
    fs.existsSync(state.LEGACY_LOCKS_DIR)
  ) {
    dirs.push(state.LEGACY_LOCKS_DIR);
  }
  return dirs;
}

function moveFileIfNeeded(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath || sourcePath === destinationPath || !fs.existsSync(sourcePath)) {
    return destinationPath;
  }
  ensureParentDir(destinationPath);
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    fs.rmSync(sourcePath, { force: true });
  }
  return destinationPath;
}

function resolveTicketLockPath(ticketId, options = {}) {
  const fileName = `${ticketId}.lock`;
  const preferred = path.join(state.LOCKS_DIR, fileName);
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  const legacy = path.join(state.LEGACY_LOCKS_DIR, fileName);
  if (shouldUseLegacyLockCompatibility() && legacy !== preferred && fs.existsSync(legacy)) {
    if (options.promoteLegacy === true) {
      return moveFileIfNeeded(legacy, preferred);
    }
    return legacy;
  }
  return preferred;
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function collectTicketWorktreeResidue(ticketId, worktreesByRepo) {
  const residue = [];
  for (const [repoCode, worktrees] of Object.entries(worktreesByRepo || {})) {
    for (const entry of worktrees || []) {
      if (!entry || !entry.path || inferTicketIdFromPath(entry.path) !== ticketId) {
        continue;
      }
      residue.push({
        repoCode,
        repoLabel: repoDisplayNameForCode(repoCode),
        path: entry.path,
        branch: entry.branch || null,
      });
    }
  }
  return residue;
}

function findTicketProductWorktreeResidue(ticketId) {
  const worktreesByRepo = {};
  for (const repoCode of Object.keys(REPO_ROOTS).filter((code) => code !== "X")) {
    const repoRoot = getRepoRoot(repoCode);
    worktreesByRepo[repoCode] = listGitWorktrees(repoRoot).filter((entry) => entry.path !== repoRoot);
  }
  return collectTicketWorktreeResidue(ticketId, worktreesByRepo);
}

function ensureRepoXCloseoutReady(ticketId) {
  const residue = findTicketProductWorktreeResidue(ticketId);
  if (residue.length === 0) {
    return null;
  }

  const details = residue
    .map((entry) => `${entry.repoLabel}:${entry.path}${entry.branch ? ` (${entry.branch})` : ""}`)
    .join(", ");
  throw new Error(
    `Ticket ${ticketId} is Repo X but still has governed backend/frontend worktree residue: ${details}. ` +
    `Repo X closeout cannot hide product-repo delivery; split that work into B/F tickets or land and clean the repo worktrees before mark-done.`
  );
}

function scoreTicket(row, readiness, context) {
  const parts = {
    ready_bonus: readiness.ready ? 1000 : 0,
    priority_bonus: row.Pri === "P0" ? 300 : row.Pri === "P1" ? 200 : row.Pri === "P2" ? 100 : 0,
    repo_bonus: isRepoBackedCode(row.Repo) ? 30 : row.Repo === "X" ? 10 : 0,
    downstream_bonus: Math.min(200, (context.downstreamOpen || 0) * 25),
    prompt_bonus: context.hasPrompt ? 25 : -60,
    dependency_bonus: readiness.deps.length === 0 ? 20 : Math.max(0, 20 - readiness.deps.length * 5),
    mode_bonus: modeBiasScore(row, context.mode),
    mode: context.mode,
  };
  const total =
    parts.ready_bonus +
    parts.priority_bonus +
    parts.repo_bonus +
    parts.downstream_bonus +
    parts.prompt_bonus +
    parts.dependency_bonus +
    parts.mode_bonus;
  return {
    ...parts,
    total,
  };
}

function buildDownstreamCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.Status === STATUS.DONE || row.Status === STATUS.SUPERSEDED) {
      continue;
    }
    for (const dep of splitDependsOn(row["Depends On"])) {
      counts.set(dep, (counts.get(dep) || 0) + 1);
    }
  }
  return counts;
}

function inferModeFromRepo(repo) {
  if (repo === "B") {
    return "backend";
  }
  if (repo === "F") {
    return "frontend";
  }
  if (repo === "X") {
    return "design";
  }
  return "general";
}

function modeBiasScore(row, mode) {
  switch (mode) {
    case "backend":
      if (row.Repo === "B") {
        return 180;
      }
      if (row.Repo === "X") {
        return 15;
      }
      return -120;
    case "frontend":
      if (row.Repo === "F") {
        return 180;
      }
      if (row.Repo === "X") {
        return 15;
      }
      return -120;
    case "design":
      if (row.Repo === "X") {
        return 200;
      }
      return -80;
    case "general":
    default:
      return 0;
  }
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function resolveTicketGitContext(row, ticketId) {
  if (!isRepoBackedCode(row.Repo)) {
    return {
      repoRoot: null,
      branch: null,
      worktree: null,
      lock: null,
    };
  }

  const repoRoot = getRepoRoot(row.Repo);
  const lock = findLockForTicket(ticketId);
  if (lock) {
    return {
      repoRoot,
      branch: lock.branch || null,
      worktree: lock.worktree || null,
      lock,
    };
  }

  const worktrees = listGitWorktrees(repoRoot);
  const match = worktrees.find((entry) => inferTicketIdFromPath(entry.path) === ticketId);
  return {
    repoRoot,
    branch: match?.branch || null,
    worktree: match?.path || null,
    lock: null,
  };
}

function ensureDoingTicketLockIntegrity(ticketId, row, options = {}) {
  if (!isDoingStatus(row?.Status)) {
    return findLockForTicket(ticketId);
  }
  let lock = findLockForTicket(ticketId);
  if (lock) {
    return lock;
  }
  const owner = row?.Owner && row.Owner !== "unassigned"
    ? canonicalizeOwnerOrFail(row.Owner)
    : null;
  if (!owner) {
    fail(`Ticket ${ticketId} is doing but has no active lock and no assigned owner.`);
  }
  const identity = ensureTicketMutationOwnership(ticketId, row, null, options);
  if (identity?.agent?.handle !== owner) {
    fail(`Ticket ${ticketId} is owned by ${owner} and cannot auto-recreate its lock for ${identity?.agent?.handle || "unknown"}.`);
  }
  const context = resolveTicketGitContext(row, ticketId);
  if (!context.worktree || !fs.existsSync(context.worktree)) {
    fail(`Ticket ${ticketId} is doing but has no active lock and no canonical worktree to recreate it from.`);
  }
  if (!context.branch) {
    fail(`Ticket ${ticketId} worktree ${context.worktree} has no governed branch association; run recover before continuing.`);
  }
  writeLock({
    ticketId,
    owner,
    repoCode: row.Repo,
    branch: context.branch,
    worktree: context.worktree,
    session: identity.session || findActiveSessionForHandle(owner),
  });
  return findLockForTicket(ticketId);
}

function resolvePrUrlForTicket(board, row, ticketId) {
  const prRefs = board.pr_index?.[ticketId] || [];
  const prUrls = prRefs.filter((entry) => isGitHubPrUrl(entry));
  if (prUrls.length === 1) {
    return prUrls[0];
  }
  if (prUrls.length > 1) {
    fail(`Ticket ${ticketId} has multiple GitHub PR refs; pass --pr <url> explicitly.`);
  }

  const ticketContext = resolveTicketGitContext(row, ticketId);
  if (!ticketContext.branch || !ticketContext.repoRoot) {
    return null;
  }
  const prs = ghPrListByBranch(ticketContext.repoRoot, ticketContext.branch);
  if (prs.length === 1) {
    return prs[0].url;
  }
  if (prs.length > 1) {
    fail(`Ticket ${ticketId} has multiple PRs for branch ${ticketContext.branch}; pass --pr <url> explicitly.`);
  }
  return null;
}

function resolveLifecyclePrRefs(ticketId, row, board, options) {
  const explicitRefs = toArray(options.pr);
  if (explicitRefs.length > 0) {
    verifyPrEvidence(ticketId, explicitRefs, {
      requireMerged: false,
      allowNoPr: true,
    });
    return mergeUniqueRefs([], explicitRefs);
  }

  const existingRefs = board.pr_index?.[ticketId] || [];
  if (existingRefs.length > 0) {
    verifyPrEvidence(ticketId, existingRefs, {
      requireMerged: false,
      allowNoPr: true,
    });
    return mergeUniqueRefs([], existingRefs);
  }

  if (isRepoBackedCode(row.Repo)) {
    const prUrl = resolvePrUrlForTicket(board, row, ticketId);
    if (prUrl) {
      return [prUrl];
    }
  }

  fail(`Ticket ${ticketId} has no PR evidence. Pass --pr <ref>, or create/link a PR first.`);
}





function increment(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function printObjectLines(obj) {
  for (const [key, value] of Object.entries(obj)) {
    console.log(`  ${key}: ${value}`);
  }
}

function fail(message) {
  throw new GovernanceError(message);
}

// COORD-141: `gov recall "<query>"` — Phase 1 deterministic memory recall.
// Thin CLI wrapper over the standalone recall engine (coord/scripts/recall.js):
// id/path -> BM25 -> provenance weighting, source-cited, permission-aware via
// ENT-012 (best-effort; community-cut safe). The query is the leading
// positional arg(s); --role <role> opts into RBAC redaction; --json emits the
// raw §7 contract. The engine is required lazily so the rest of lifecycle.js
// stays independent of the memory layer.
function recallCommand(query, options = {}) {
  const recallEngine = require("./recall.js");
  const text = query == null ? "" : String(query);
  if (!text.trim()) {
    fail('recall requires a query: coord/scripts/gov recall "<query>" [--role <role>] [--json]');
  }
  const result = recallEngine.recall(text, { role: options.role || null });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Q: ${result.query}`);
  console.log("");
  console.log(result.answer);
  console.log("");
  console.log(`confidence=${result.confidence} staleness=${result.staleness}`);
  console.log("");
  console.log("Sources:");
  for (const s of result.sources) {
    console.log(
      `  - [${s.type}] ${s.id || ""} ${s.path || ""} ` +
        `verified=${s.verified} event_hash=${(s.event_hash || "").slice(0, 12)} ` +
        `chain_head=${(s.chain_head || "").slice(0, 12)}`
    );
  }
  return result;
}

// COORD-147: `gov insights` — Strategic execution-insight reports. Thin CLI
// wrapper over the standalone generator (coord/scripts/insight-reports.js). It
// RECOMMENDS only: a pure read over the journal + board + plan records that
// mutates/gates nothing and emits only source-cited claims. --json emits the
// structured report; default emits the readable text report. The engine is
// required lazily so the rest of lifecycle.js stays independent of the memory
// layer.
function insightsCommand(options = {}) {
  const engine = require("./insight-reports.js");
  const report = engine.generateReport({ now: new Date().toISOString() });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(engine.renderText(report));
  return report;
}

// COORD-148: `gov prework <ticket> [--scope "<text>"] [--role <role>] [--json]`
// — the [Memory] Solving pre-work CONTEXT PACK. Thin CLI wrapper over the
// standalone generator (coord/scripts/prework-pack.js). It RECOMMENDS only: a
// pure read over governed memory (journal + board + plan records + decision
// records + indexed files) that surfaces, BEFORE an agent starts, the relevant
// prior work + already-failed approaches in the touched area + a recommended
// safe decomposition / test selection — every item source-cited, mutating and
// gating nothing. Complements `gov explain` start-readiness (advisory input the
// agent reads at work-start). Composes recall.js / decision-extractor.js /
// insight-reports.js; required lazily so lifecycle.js stays independent of the
// memory layer. The leading positional is the ticket id (optional when --scope
// supplies a free-text area); --scope adds free text; --role opts into ENT-012
// redaction; --json emits the structured pack.
function preworkCommand(ticketId, options = {}) {
  const engine = require("./prework-pack.js");
  const scope = options.scope || null;
  if ((ticketId == null || String(ticketId).trim() === "") && !scope) {
    fail(
      'prework requires a ticket id or --scope: coord/scripts/gov prework <ticket-id> [--scope "<text>"] [--json]'
    );
  }
  const pack = engine.buildPack({
    ticketId: ticketId && String(ticketId).trim() ? String(ticketId).trim() : null,
    scope,
    role: options.role || null,
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(pack, null, 2));
    return pack;
  }
  console.log(engine.renderText(pack));
  return pack;
}

// COORD-149: `gov closeout-summary <ticket> [--json]` — the [Memory] Solving
// auto evidence-backed CLOSEOUT SUMMARY. Thin CLI wrapper over the standalone
// generator (coord/scripts/closeout-summary.js). It REPORTS only: a pure read
// over the closing/landed ticket's REAL artifacts (its plan record, journal
// events, board row, and any anchoring conformance attestation) that produces a
// source-cited summary — what was asked + delivered, the evidence trail
// (repo-gate results, review cycles, source commit(s)/landing record,
// attestation), and key decisions + deferrals — every claim pinning event_hash +
// chain_head. It does NOT close, gate, finalize, or mutate the ticket: closeout
// stays governed by the normal finalize lane; this is an evidence artifact, not an
// authority. Composes decision-extractor.js + insight-reports.js; required lazily
// so lifecycle.js stays independent of the memory layer. --json emits the
// structured summary; default emits the readable text summary.
function closeoutSummaryCommand(ticketId, options = {}) {
  const engine = require("./closeout-summary.js");
  if (ticketId == null || String(ticketId).trim() === "") {
    fail(
      "closeout-summary requires a ticket id: coord/scripts/gov closeout-summary <ticket-id> [--json]"
    );
  }
  const summary = engine.buildSummary({
    ticketId: String(ticketId).trim(),
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  console.log(engine.renderText(summary));
  return summary;
}

// COORD-145: `gov learned-rule capture|list|promote` — governed procedural-
// memory promotion. Thin CLI wrapper over the standalone engine
// (coord/scripts/learned-rule-promotion.js). It RECOMMENDS / ROUTES only: a
// learned behavioral rule is CAPTURED as a candidate (the only write is an
// append to the derived, gitignored candidates queue), then PROMOTED into a
// governed-change SPEC routed to the FULL reviewed lane (asserted via the
// COORD-166 isProceduralDocPath). It NEVER edits a procedural file — the
// procedural surface (.claude/, AGENTS.md, CLAUDE.md, GOVERNANCE.md) changes
// ONLY through the reviewed/landed lifecycle. Every candidate carries §7
// citations (no uncited rule). The engine is required lazily so the rest of
// lifecycle.js stays independent of the memory layer.
function learnedRuleCommand(sub, args = []) {
  const engine = require("./learned-rule-promotion.js");
  if (!sub || !["capture", "list", "promote"].includes(sub)) {
    fail(
      'learned-rule requires a subcommand: capture | list | promote. ' +
        'e.g. coord/scripts/gov learned-rule promote <PRC-id> [--json]'
    );
  }
  return engine.runCli([sub, ...args]);
}

// COORD-146: `gov sign-journal sign|verify` — [Memory] cross-cutting per-event /
// batch signing for memory NON-REPUDIATION (folded into the KMS / key-custody
// roadmap). Thin CLI wrapper over the standalone engine
// (coord/scripts/journal-signing.js). It EXTENDS — never replaces — the existing
// hash-chain + single chain-head attestation: it ed25519-signs ONE Merkle batch
// over the per-event leaf hashes (the same canonical event_hash the journal +
// decision-extractor already cite), binding the merkle_root to the journal
// chain_head, so any individual event's non-repudiation is provable via a compact
// Merkle inclusion proof WITHOUT a signature per line. Backward compatible:
// read-only over the journal, writes only its own signed-batch artifact under the
// gitignored coord/.runtime/ tree, never mutates events, never weakens
// verifyGovernanceChain. The signing key SOURCE is pluggable (a key provider) so
// an adopter backs it with a KMS/HSM; coord ships only the local-key default
// (private key gitignored) and does NOT reimplement a KMS (explicit non-goal).
//
//   sign   [--out <file>]              — sign the current journal as one batch,
//                                        write the signed-batch artifact (default
//                                        under coord/.runtime/journal-signatures/).
//   verify <batch-file> [--event <hash>] — verify the batch (signature + merkle_root
//                                        rebuild + chain-head bind to the live
//                                        journal); with --event, ALSO prove that
//                                        event's per-event non-repudiation
//                                        (signature valid + Merkle inclusion).
// The engine is required lazily so the rest of lifecycle.js stays independent of
// the memory layer.
function signJournalCommand(sub, options = {}) {
  const engine = require("./journal-signing.js");
  if (!sub || !["sign", "verify"].includes(sub)) {
    fail(
      "sign-journal requires a subcommand: sign | verify. " +
        'e.g. coord/scripts/gov sign-journal sign [--out <file>] | ' +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }

  const journalPath = state.GOVERNANCE_EVENT_LOG_PATH;
  const events = engine.readJournalEvents(journalPath);
  const liveChainHead = engine.chainHeadOf(events);
  const liveEventHashes = events.map((e) => engine.eventHashFromLine(e.line));

  if (sub === "sign") {
    const { batch, tree } = engine.buildSignedBatch({
      events,
      coordDir: COORD_DIR,
    });
    const dir = path.join(state.RUNTIME_DIR, "journal-signatures");
    fs.mkdirSync(dir, { recursive: true });
    const tag = (batch.subject.chain_head || "no-chain-head").slice(0, 16);
    const outPath =
      options.out || path.join(dir, `${tag}.${batch.subject_digest.slice(0, 12)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(batch, null, 2) + "\n");
    const result = {
      status: "signed",
      path: outPath,
      event_count: batch.subject.event_count,
      merkle_root: batch.subject.merkle_root,
      chain_head: batch.subject.chain_head,
      subject_digest: batch.subject_digest,
      // The root must round-trip from any leaf's inclusion proof.
      merkle_levels: tree.levels.length,
    };
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Journal batch signed:");
      console.log(`  path:        ${result.path}`);
      console.log(`  events:      ${result.event_count}`);
      console.log(`  merkle_root: ${result.merkle_root}`);
      console.log(`  chain_head:  ${result.chain_head || "(empty journal)"}`);
      console.log(`  digest:      ${result.subject_digest}`);
    }
    return result;
  }

  // verify
  const batchFile = options.file;
  if (!batchFile) {
    fail(
      "sign-journal verify requires a batch file: " +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }
  if (!fs.existsSync(batchFile)) {
    fail(`Signed-batch file not found: ${batchFile}`);
  }
  let batch = null;
  try {
    batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
  } catch (error) {
    fail(`Signed-batch file is not valid JSON: ${batchFile} (${error.message})`);
  }

  const report = engine.verifySignedBatch(batch, {
    liveChainHead,
    liveEventHashes,
  });

  // Optional per-event non-repudiation proof.
  let eventReport = null;
  if (options.event) {
    const targetHash = String(options.event);
    const index = (Array.isArray(batch.event_hashes) ? batch.event_hashes : []).indexOf(
      targetHash
    );
    if (index < 0) {
      eventReport = {
        ok: false,
        event_hash: targetHash,
        included: false,
        problems: [
          { code: "event_not_in_batch", detail: "event hash is not among the batch event_hashes" },
        ],
      };
    } else {
      const tree = engine.buildMerkleTree(batch.event_hashes);
      const proof = engine.buildInclusionProof(tree, index);
      eventReport = engine.verifyEventInclusion(batch, targetHash, proof);
    }
  }

  const result = {
    status: report.ok ? "valid" : report.verdict,
    verdict: report.verdict,
    batch_ok: report.ok,
    signature_valid: report.signature_valid,
    merkle_root_matches: report.merkle_root_matches,
    chain_head_matches: report.chain_head_matches,
    event_count: report.event_count,
    problems: report.problems,
    event_inclusion: eventReport,
  };
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Journal batch verification: ${report.ok ? "VALID" : report.verdict.toUpperCase()}`);
    console.log(`  signature valid:    ${report.signature_valid}`);
    console.log(`  merkle_root match:  ${report.merkle_root_matches}`);
    console.log(`  chain_head bind:    ${report.chain_head_matches}`);
    console.log(`  events:             ${report.event_count}`);
    if (report.problems.length > 0) {
      console.log(`  problems (${report.problems.length}):`);
      for (const p of report.problems) {
        console.log(`    - ${p.code}: ${p.detail}`);
      }
    }
    if (eventReport) {
      console.log(`  event ${String(options.event).slice(0, 12)} non-repudiation: ${eventReport.ok ? "PROVEN" : "FAILED"}`);
      console.log(`    included under signed root: ${eventReport.included}`);
      if (eventReport.problems && eventReport.problems.length > 0) {
        for (const p of eventReport.problems) {
          console.log(`    - ${p.code}: ${p.detail}`);
        }
      }
    }
  }
  if (!report.ok || (eventReport && !eventReport.ok)) {
    fail(
      `Journal batch verification FAILED: verdict=${report.verdict}` +
        (eventReport && !eventReport.ok ? ", event non-repudiation could not be proven" : "") +
        ". The signed batch was tampered with, is stale, or the event is not provably included."
    );
  }
  return result;
}

const commands = {
  recallCommand,
  signJournalCommand,
  insightsCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  addFeatureProofCommand,
  addFinding,
  addRepoGateCommand,
  addReviewCycleCommand,
  agentsCommand,
  auditLandings,
  auditWorktrees,
  autoSyncAfterLifecycle,
  pushOnFinalizeEnabled,
  pushAfterLifecycleSync,
  backfillPlanRecords,
  blockTicket,
  breakRuntimeLock,
  claim,
  claimAgent,
  cleanRuntime,
  cleanupHelperWorktrees,
  cleanupWorktree,
  commitTicket,
  contextPack,
  costReport,
  dispatchPlan,
  doctor,
  dropFeatureProofCommand,
  explainTicket,
  fail,
  finalizeTicket,
  finishTicket,
  heartbeat,
  landTicket,
  listTickets,
  lockAbandonTicket,
  logQuestion,
  markDone,
  moveReview,
  openFollowup,
  orchestratorCycle,
  otlpExport,
  pickTickets,
  planTicket,
  planWaves,
  prCreate,
  prMerge,
  prView,
  precheck,
  printCounts,
  printCurrentAgentId,
  printHelp,
  printInitiate,
  printNextId,
  conform,
  repairChain,
  verifyEngine,
  rebindAgent,
  rebuildBoardFromJournal,
  recentEvents,
  recommendTickets,
  reapGateProcs,
  reconcileGovernance,
  recordCost,
  recoverTicket,
  registerPrompt,
  releaseAgent,
  releaseLock,
  reopenTicket,
  resumeTicket,
  retireStaleDriftNotes,
  returnDoing,
  runCleanCheckoutGate,
  runSyncCommand,
  runTicketCycle,
  runtimeLockStatus,
  setFollowupRelation,
  setPrRefs,
  setRequirementClosureCommand,
  setReviewCyclesCommand,
  setTicketPriority,
  setTicketType,
  setWaiver,
  showAgentStatus,
  showTicket,
  splitTicket,
  startTicket,
  submitTicket,
  supersedeTicket,
  tierCommand,
  unblockTicket,
  unstartTicket,
  updateFinding,
  updatePlanBlock,
};

module.exports = {
  GovernanceError,
  commands,
  __testing: {
    resumeTicket,
    explainTicket,
    detectActiveSameOwnerOtherThread,
    withTemporaryExecutionContext,
    collectTicketWorktreeResidue,
    extractPlanBlock,
    extractPlanBlockEntries,
    extractPlanBlocks,
    ensurePlanStub,
    inferRequiredReviewRound,
    inferTicketIdFromPath,
    isPlanSectionBoundary,
    isRecoverableGovernanceDriftPath,
    buildInitiateSummary,
    buildStartOwnershipRaceMessage,
    buildDefaultGovernancePlan,
    resolveRepoCodeForTicket,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
    buildAgentStatusPayload,
    buildReleaseCandidates,
    reapIdleAutoClaimedProviderStubs,
    rebindAgent,
    rebuildBoardFromJournal,
    terminalJournalStatusForTicket,
    collectTicketsWithJournalDrift,
    repoPrefixForCode,
    repoPrefixesForCode,
    isRepoBackedCode,
    isProductRepo,
    repoNameForCode,
    repoDisplayNameForCode,
    repoCliAliasesForCode,
    repoCodeForCliRepoArg,
    resolveTicketBaseRef,
    gitCommitishExists,
    repoBootstrapLabel,
    buildDependencyBootstrapGuidance,
    formatMissingStartBaseRefMessage,
    repoCodeForLockRepoName,
    normalizeTestingInfraAuditPath,
    buildDoctorResolutionGuidance,
    buildExplainQuestionsGuidance,
    deriveGovernanceReadiness,
    isLightLaneEligible,
    isProceduralDocPath,
    resolveTicketLightLane,
    classifyQuestionOperationalType,
    classifyQuestionSeverity,
    classifyQuestionAgingBucket,
    parseQuestionRow,
    readQuestionRows,
    readOrchestratorQuestionRows,
    readActiveOrchestratorQuestionRows,
    isActiveOrchestratorQuestionRow,
    buildQuestionQueueReport,
    parseTemplateFeedbackRowsFromText,
    readTemplateFeedbackRows,
    ticketNeedsTemplateFeedback,
    latestDoneTimestampByTicket,
    collectTemplateFeedbackAlerts,
    formatTemplateFeedbackAlerts,
    collectStaleTemplateFeedbackErrors,
    formatBucketCounts,
    splitGovernanceProvenanceDrift,
    extractDriftMutationStage,
    buildMergedButNotDoneReport,
    buildOrchestratorExceptionSloReport,
    buildPromptWaiverCommand,
    buildStartPlanBootstrapCommand,
    buildStartPlanSeedUpdate,
    buildPlanStatusPayload,
    planTicket,
    buildTicketNextCommands,
    collectGovernedSnapshotFilePaths,
    collectStartReadinessBlockers,
    auditCoordWorktrees,
    diffGovernanceSnapshots,
    doctorFix,
    recoverTicket,
    evaluateReadiness,
    parsePlanBlockToRecord,
    renderPlanRecordBlock,
    persistReturnDoingState,
    readPlanListField,
    readAgentsRegistry,
    readPlanRecord,
    readPlanScalarField,
    readAgentSessions,
    normalizeLegacyPlanRecordShape,
    normalizeSelfReviewCycleLine,
    detectGovernanceProvenanceDrift,
    gitIgnoredDriftPaths,
    writeFileAtomicSync,
    repairTornGovernanceEventLogTail,
    readGovernanceEventLog,
    appendGovernanceEvent,
    verifyGovernanceChain,
    planGovernanceChainRepair,
    repairGovernanceChain,
    hashGovernanceEventRecord,
    readLatestGovernanceEvent,
    governanceRestorePointPath,
    persistGovernanceRestorePoint,
    recoverCrashedGovernanceMutation,
    buildGovernanceSnapshot,
    captureGovernanceRestorePoint,
    ensureCurrentAgentIdentity,
    resolveCurrentAgentId,
    findDoingTicketForOwner,
    findActiveProviderSessions,
    hasPromptWaiver,
    defaultTicketPromptRelPath,
    ticketPromptRelPathExists,
    ensurePromptCoverageOrDiscover,
    registerPrompt,
    appendQuestionRowText,
    hasOnlyScaffoldSelfReviewCycles,
    isDoingStatus,
    getOrCreateSessionToken,
    detectCwdTicketClaimHazard,
    resolveEffectiveThreadId,
    resolveOwnerIdentity,
    describeTicketMutationOwnershipIssue,
    assertRegisteredBoundOwner,
    assertTicketMutationOwnership,
    ensureTicketMutationOwnership,
    assertTicketRepairOwnership,
    ensureDoingTicketLockIntegrity,
    runtimeSessionFingerprint,
    validateRequirementClosureEntry,
    validateFeatureProofEntry,
    normalizeFeatureProofEntryForTicket,
    resolveGateScript,
    resolveGateInvocation,
    resolveGateArtifactDir,
    resolveRepoIntegrationBranch,
    detectGatePackageManager,
    isInsideGitWorkTree,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
    preflightPrBranch,
    refreshLockHead,
    readJsonFileState,
    readLockFileOrFail,
    tryReclaimStaleDirectoryLock,
    describeDirectoryLockHolder,
    readModelPrices,
    resolveModelPrice,
    estimateCostUsd,
    collectCostObservations,
    aggregateCost,
    loadTicketPrecheckProbes,
    runPrecheckProbe,
    classifyPrecheckVerdict,
    precheck,
    parseTicketPromptSections,
    minePriorProofsAndInvariants,
    ticketFilesIntersect,
    buildContextPack,
    contextPack,
    readTierPolicy,
    resolveTicketTier,
    tierEvidenceMinimums,
    effectiveTierMinimum,
    tierCommand,
    parseTicketDependsOn,
    planWaves,
    dispatchCachePrefixMarker,
    dispatchPrecheckVerdict,
    dispatchActionForTicket,
    dispatchPlan,
    runtimeLockStatus,
    breakRuntimeLock,
    detectRollbackDrift,
    collectCleanRuntimeTargets,
    cleanRuntime,
    withPreparedTicketWorkspace,
    cleanupPreparedTicketWorkspace,
    writeLock,
    rebindTicketLock,
    canonicalSyncablePaths,
    computeSyncDelta,
    runSyncCommand,
    buildCanonicalDerivedDriftError,
    commitCanonicalDelta,
    autoSyncAfterLifecycle,
    pushOnFinalizeEnabled,
    pushAfterLifecycleSync,
    buildAutoSyncMessage,
    collectReviewPlanReadinessIssues,
    collectSubmitReadinessBlockers,
    submitRequiresReviewPlanCheck,
    shouldIgnoreMergeFailureAfterSuccessfulMerge,
    readCanonicalTextFile,
    readCanonicalJsonFile,
    resolveFollowupPromptPath,
    replacePlanBlock,
    restoreGovernanceRestorePoint,
    synthesizeHistoricalPlanRecord,
    syncPlanRecordFromBlock,
    replaceSelfReviewCycles,
    upsertListItem,
    withGovernanceMutation,
    writeCanonicalTextFile,
    writeCanonicalJsonFile,
    readGovernanceSnapshotArtifact,
    readGovernanceSnapshotCheckpoint,
    readLatestGovernanceEvent,
    summarizeGovernanceEvent,
    materializeGovernanceEvent,
    recordGovernanceExternalSideEffect,
    recentEvents,
    assertCurrentTicketLockIntegrity,
    mergedPrAffiliatesWithTicket,
    refsContainMergedPrForTicket,
    readCommitSubject,
    commitSubjectAffiliatesWithTicket,
    resolveCommitishInRepo,
    resolveSourceCommitSha,
    isCommitAncestorOfRef,
    resolveLandingBaseRef,
    resolvePrLandingBaseRef,
    assertAlreadyLandedNoPrReconcileReady,
    detectSupersedeLandingBypass,
    applyFollowupRelation,
    appendReviewFollowupPlan,
    addReviewCycleCommand,
    setReviewCyclesCommand,
    setRequirementClosureCommand,
    addFeatureProofCommand,
    dropFeatureProofCommand,
    addRepoGateCommand,
    classifyGateAttribution,
    formatRepoGateEntry,
    extractDriftSinceTimestamp,
    planStaleDriftNoteRetirement,
    applyRetireStaleDriftNotes,
    findLatestGovernanceBaselineTimestamp,
    retireStaleDriftNotes,
    applyPlanUpdateOptionsToRecord,
    isScaffoldWorktreeIntendedFile,
    applyLandingAuditBackfill,
    ensurePlanBlockForUpdate,
    ensurePlanRecordForUpdate,
    classifyLandingRecord,
    collectLandingAuditReport,
    deriveFeatureProofAudit,
    deriveTestingInfrastructureAudit,
    ensureFeatureProofLandingAudit,
    ensureTestingInfrastructureLandingAudit,
    assertLandingIntegrity,
    persistMergedPrLandingSnapshot,
    assertCommittedReviewState,
    formatLandingAuditSummary,
    isTestingInfrastructureTicket,
    isCompleteLockPayload,
    materializePlanBlockFromRecord,
    normalizeFollowupRelation,
    planRecordHasOnlyScaffoldSelfReviewCycles,
    resolveDoctorScope,
    resolveDoctorOwnerScope,
    requiresFeatureProofGovernance,
    updateCanonicalPlanState,
    writePlanCompatibilityBlockFromRecord,
    allocateAgentSimpleId,
    allocateLiveSessionId,
    collectReferencedAgentIdNumbers,
    claimTicket,
    resolveHumanAdminOverride,
    nextTicketId,
    printNextId,
    splitTicket,
    openFollowup,
    ghPrView,
    isTransientGhError,
    runGh,
    setRunGhForTesting,
    resetRunGhForTesting,
    setSleepSyncForTesting,
    resetSleepSyncForTesting,
    readBoard,
    writeBoard,
    unstartTicket,
    lockAbandonTicket,
    blockTicket,
    unblockTicket,
    supersedeTicket,
    collectUnstartEvidenceBlockers,
    resolveWorktreeBaseCompareRef,
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
    parsePromptLikelyFiles,
    seedStartIntendedFilesFromPrompt,
    readRecordedIntendedFilesScaffoldSeed,
    parseDocumentedGovVerbs,
    parseDocumentedAgentVerbs,
    collectDispatchCommandVerbs,
    collectParseFlagsFlags,
    collectAgentFacadeVerbs,
    collectAgentWrapperFlags,
    runVerbParityCheck,
    parsePromptPreconditions,
    classifyPreconditionArtifact,
    verifyPromptPreconditions,
    assertPromptPreconditionsResolve,
    paths: {
      get BOARD_PATH() {
        return state.BOARD_PATH;
      },
      set BOARD_PATH(value) {
        state.BOARD_PATH = value;
      },
      get PLAN_PATH() {
        return state.PLAN_PATH;
      },
      set PLAN_PATH(value) {
        state.PLAN_PATH = value;
      },
      get PLAN_RECORDS_DIR() {
        return state.PLAN_RECORDS_DIR;
      },
      set PLAN_RECORDS_DIR(value) {
        state.PLAN_RECORDS_DIR = value;
      },
      get LEGACY_PLAN_RECORDS_DIR() {
        return state.LEGACY_PLAN_RECORDS_DIR;
      },
      set LEGACY_PLAN_RECORDS_DIR(value) {
        state.LEGACY_PLAN_RECORDS_DIR = value;
      },
      get LOCKS_DIR() {
        return state.LOCKS_DIR;
      },
      set LOCKS_DIR(value) {
        state.LOCKS_DIR = value;
      },
      get LEGACY_LOCKS_DIR() {
        return state.LEGACY_LOCKS_DIR;
      },
      set LEGACY_LOCKS_DIR(value) {
        state.LEGACY_LOCKS_DIR = value;
      },
      get QUESTIONS_PATH() {
        return state.QUESTIONS_PATH;
      },
      set QUESTIONS_PATH(value) {
        state.QUESTIONS_PATH = value;
      },
      get TEMPLATE_FEEDBACK_PATH() {
        return state.TEMPLATE_FEEDBACK_PATH;
      },
      set TEMPLATE_FEEDBACK_PATH(value) {
        state.TEMPLATE_FEEDBACK_PATH = value;
      },
      get AGENTS_PATH() {
        return state.AGENTS_PATH;
      },
      set AGENTS_PATH(value) {
        state.AGENTS_PATH = value;
      },
      get LEGACY_AGENTS_PATH() {
        return state.LEGACY_AGENTS_PATH;
      },
      set LEGACY_AGENTS_PATH(value) {
        state.LEGACY_AGENTS_PATH = value;
      },
      get AGENT_SESSIONS_PATH() {
        return state.AGENT_SESSIONS_PATH;
      },
      set AGENT_SESSIONS_PATH(value) {
        state.AGENT_SESSIONS_PATH = value;
      },
      get LEGACY_AGENT_SESSIONS_PATH() {
        return state.LEGACY_AGENT_SESSIONS_PATH;
      },
      set LEGACY_AGENT_SESSIONS_PATH(value) {
        state.LEGACY_AGENT_SESSIONS_PATH = value;
      },
      get RUNTIME_DIR() {
        return state.RUNTIME_DIR;
      },
      set RUNTIME_DIR(value) {
        state.RUNTIME_DIR = value;
      },
      get GOVERNANCE_EVENT_LOG_PATH() {
        return state.GOVERNANCE_EVENT_LOG_PATH;
      },
      set GOVERNANCE_EVENT_LOG_PATH(value) {
        state.GOVERNANCE_EVENT_LOG_PATH = value;
      },
      get GOVERNANCE_SNAPSHOT_PATH() {
        return state.GOVERNANCE_SNAPSHOT_PATH;
      },
      set GOVERNANCE_SNAPSHOT_PATH(value) {
        state.GOVERNANCE_SNAPSHOT_PATH = value;
      },
      get GOVERNANCE_SNAPSHOTS_DIR() {
        return state.GOVERNANCE_SNAPSHOTS_DIR;
      },
      set GOVERNANCE_SNAPSHOTS_DIR(value) {
        state.GOVERNANCE_SNAPSHOTS_DIR = value;
      },
      get GOVERNANCE_EVENT_LOCK_DIR() {
        return state.GOVERNANCE_EVENT_LOCK_DIR;
      },
      set GOVERNANCE_EVENT_LOCK_DIR(value) {
        state.GOVERNANCE_EVENT_LOCK_DIR = value;
      },
      get MODEL_PRICES_PATH() {
        return state.MODEL_PRICES_PATH;
      },
      set MODEL_PRICES_PATH(value) {
        state.MODEL_PRICES_PATH = value;
      },
      get TIER_POLICY_PATH_OVERRIDE() {
        return state.TIER_POLICY_PATH_OVERRIDE;
      },
      set TIER_POLICY_PATH_OVERRIDE(value) {
        state.TIER_POLICY_PATH_OVERRIDE = value;
      },
      get REPO_ROOTS() {
        return REPO_ROOTS;
      },
      set REPO_ROOTS(value) {
        for (const key of Object.keys(REPO_ROOTS)) {
          delete REPO_ROOTS[key];
        }
        Object.assign(REPO_ROOTS, value || {});
      },
      get REPO_INTEGRATION_BRANCHES() {
        return REPO_INTEGRATION_BRANCHES;
      },
      set REPO_INTEGRATION_BRANCHES(value) {
        for (const key of Object.keys(REPO_INTEGRATION_BRANCHES)) {
          delete REPO_INTEGRATION_BRANCHES[key];
        }
        Object.assign(REPO_INTEGRATION_BRANCHES, value || {});
      },
      // COORD-125: configurable start-base seam (per-repo + global default).
      // worktree-ops reads these LIVE off the shared DEFAULT_PATHS reference, so
      // in-place mutation here propagates to resolveTicketBaseRef.
      get REPO_START_BASE_REFS() {
        return DEFAULT_PATHS.repoStartBaseRefs;
      },
      set REPO_START_BASE_REFS(value) {
        for (const key of Object.keys(DEFAULT_PATHS.repoStartBaseRefs)) {
          delete DEFAULT_PATHS.repoStartBaseRefs[key];
        }
        Object.assign(DEFAULT_PATHS.repoStartBaseRefs, value || {});
      },
      get DEFAULT_START_BASE_REF() {
        return DEFAULT_PATHS.defaultStartBaseRef;
      },
      set DEFAULT_START_BASE_REF(value) {
        DEFAULT_PATHS.defaultStartBaseRef = value === undefined ? null : value;
      },
      get repoRegistry() {
        return DEFAULT_PATHS.repoRegistry;
      },
      set repoRegistry(value) {
        for (const key of Object.keys(DEFAULT_PATHS.repoRegistry)) {
          delete DEFAULT_PATHS.repoRegistry[key];
        }
        Object.assign(DEFAULT_PATHS.repoRegistry, value || {});
      },
      get legacyRepoAliases() {
        return DEFAULT_PATHS.legacyRepoAliases;
      },
      set legacyRepoAliases(value) {
        for (const key of Object.keys(DEFAULT_PATHS.legacyRepoAliases)) {
          delete DEFAULT_PATHS.legacyRepoAliases[key];
        }
        Object.assign(DEFAULT_PATHS.legacyRepoAliases, value || {});
      },
    },
    assertReviewPlanReady,
  },
};
