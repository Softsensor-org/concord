#!/usr/bin/env node
"use strict";

const path = require("path");
const util = require("util");
const adrValidator = require("./adr-validator.js");
const lifecycle = require("./lifecycle.js");
const commandRegistry = require("./command-registry.js");
const runtimeEvidence = require("./runtime-evidence.js");
const { STATUS, legalStatusSet, legalFindingStatusSet } = require("./governance-constants.js");

const { GovernanceError, commands } = lifecycle;
const { withTemporaryExecutionContext } = lifecycle.__testing;
const {
  addFeatureProofCommand,
  addFinding,
  addRepoGateCommand,
  addReviewCycleCommand,
  agentsCommand,
  approveTicket,
  auditLandings,
  auditWorktrees,
  autoSyncAfterLifecycle,
  backfillPlanRecords,
  blockTicket,
  breakRuntimeLock,
  claim,
  claimAgent,
  cleanRuntime,
  cleanupHelperWorktrees,
  cleanupWorktree,
  commitTicket,
  conform,
  repairChain,
  migrateChainHash,
  verifyEngine,
  contextPack,
  costReport,
  dispatchPlan,
  doctor,
  dropFeatureProofCommand,
  explainTicket,
  fail,
  fleetGoldenPath,
  finalizeTicket,
  finishTicket,
  gatePlanCommand,
  heartbeat,
  landTicket,
  listTickets,
  lockAbandonTicket,
  logQuestion,
  fileTicket,
  markDone,
  moveReview,
  openFollowup,
  orchestratorCycle,
  otlpExport,
  pickTickets,
  planTicket,
  planWaves,
  sequencerPlan,
  mergeQueue,
  prCreate,
  prMerge,
  prView,
  precheck,
  printCounts,
  printCurrentAgentId,
  printHelp,
  printInitiate,
  printNextId,
  recallCommand,
  signJournalCommand,
  insightsCommand,
  coverageRollupCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  codeIndexCommand,
  codeSearchCommand,
  codeContextCommand,
  codeDiffCommand,
  rebindAgent,
  rebuildBoardFromJournal,
  recentEvents,
  recommendTickets,
  reapGateProcs,
  reconcileGovernance,
  recordCost,
  recoverTicket,
  releaseTerminalTicketSession,
  registerPrompt,
  releaseAgent,
  releaseLock,
  rejectTicket,
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
} = commands;

// COORD-074: status / finding-status enums sourced from the shared
// governance-constants module (byte-identical to the prior inline Sets).
const LEGAL_STATUSES = legalStatusSet();
const LEGAL_FINDING_STATUSES = legalFindingStatusSet();

function isLegalStatus(status) {
  if (LEGAL_STATUSES.has(status)) {
    return true;
  }
  return typeof status === "string" && /^doing \(blocked: .+\)$/.test(status);
}

// COORD-104: the command router repeats two arg-shape idioms across many cases:
// an OPTIONAL leading positional ticket id (present only when args[0] is not a
// flag), and the flags that follow it. Extracting them into these helpers moves
// the `&&`/ternary decision tokens out of the dispatchCommand switch body (where
// they inflated its cyclomatic count) into tiny, individually-trivial helpers,
// with byte-identical evaluation. The `case "<verb>":` labels are deliberately
// left intact so the COORD-007 verb-parity collector
// (verb-parity.js#collectDispatchCommandVerbs) still reads the live switch.
function hasLeadingPositional(args) {
  return Boolean(args[0]) && !String(args[0]).startsWith("--");
}

// Optional leading ticket id: args[0] when it is a positional (not a flag),
// else null. Mirrors `args[0] && !String(args[0]).startsWith("--") ? args[0] : null`.
function optionalLeadingId(args) {
  return hasLeadingPositional(args) ? args[0] : null;
}

// parseFlags over the args that follow an OPTIONAL leading positional id:
// slice past args[0] when it is positional, else parse all args. Mirrors
// `parseFlags(args[0] && !String(args[0]).startsWith("--") ? args.slice(1) : args)`.
function flagsAfterOptionalId(args) {
  return parseFlags(hasLeadingPositional(args) ? args.slice(1) : args);
}

// COORD-104 (annotated residual): dispatchCommand is the single CLI command
function runTerminalLifecycle(verb, ticketId, flags, fn) {
  const result = fn();
  try {
    autoSyncAfterLifecycle({ verb, ticketId, options: flags });
  } finally {
    try {
      releaseTerminalTicketSession(ticketId);
    } catch {
      // Best-effort runtime-ledger cleanup. Terminal closeout authority remains
      // the lifecycle mutation and journal; a session-ledger cleanup issue must
      // not roll back a completed ticket.
    }
  }
  return result;
}

// ROUTER — one switch over ~96 governed verbs, each arm a thin delegation to a
// lifecycle/board handler. Its residual cyclomatic count (~102) is dominated by
// the case-per-verb count, which is irreducible for a router of this surface.
// The cheap wins were taken: the repeated optional-leading-id / following-flags
// ternary idioms were hoisted into optionalLeadingId/flagsAfterOptionalId above
// (-26 decision points, 128 -> 102), with byte-identical dispatch results. A
// data-table rewrite was deliberately NOT done: the COORD-007 verb-parity
// guardrail (verb-parity.js#collectDispatchCommandVerbs) statically scans this
// body for `case "<verb>":` labels, so collapsing the switch into a lookup map
// would require a parallel, higher-risk change to that core drift detector for
// no behavioral gain. Annotated and accepted per the ticket's router carve-out.
function dispatchCommand(command, args = []) {
  switch (command) {
    case "counts":
    case "board-state":
      return printCounts();
    case "pick":
      return pickTickets(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "list":
      return listTickets(parseFlags(args));
    case "recommend":
    case "next-ticket":
      return recommendTickets(parseFlags(args));
    case "run-ticket-cycle":
    case "ticket-cycle":
      return runTicketCycle(args[0], parseFlags(args.slice(1)));
    case "fleet-golden-path":
      return fleetGoldenPath(args[0], parseFlags(args.slice(1)));
    case "guided-closeout":
    case "governance-tier":
    case "publishability-check":
      return commandRegistry.runAdoptionGovernanceCommand(command, args, parseFlags);
    case "agents":
      return agentsCommand(args);
    case "agentid":
      return printCurrentAgentId(parseFlags(args));
    case "initiate":
      return printInitiate(parseFlags(args));
    case "claim":
      return claim(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "agent-claim":
      return claimAgent(args[0], parseFlags(args.slice(1)));
    case "agent-release":
      return releaseAgent(args[0], parseFlags(args.slice(1)));
    case "agent-rebind":
      return rebindAgent(parseFlags(args));
    case "rebuild-board":
      return rebuildBoardFromJournal(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "agent-status":
      return showAgentStatus(args[0]);
    case "doctor":
      return doctor(parseFlags(args));
    case "conform":
      return conform(parseFlags(args));
    case "repair-chain":
      return repairChain(parseFlags(args));
    case "migrate-chain-hash":
      return migrateChainHash(parseFlags(args));
    case "verify-engine":
      return verifyEngine(parseFlags(args));
    case "orch":
    case "orchestrator-cycle":
      return orchestratorCycle(parseFlags(args));
    case "audit-landings":
      return auditLandings(parseFlags(args));
    case "adr":
      return adrValidator.govAdr(args, {
        withGovernanceMutation: lifecycle.__testing.withGovernanceMutation,
        fail,
      });
    case "ticket":
      return showTicket(args[0]);
    case "recent":
      return recentEvents(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "explain":
      return explainTicket(args[0]);
    case "recover":
      return recoverTicket(args[0], parseFlags(args.slice(1)));
    case "resume":
      return resumeTicket(args[0], parseFlags(args.slice(1)));
    case "reconcile":
      return reconcileGovernance(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "reap-gate-procs":
      return reapGateProcs(parseFlags(args));
    case "pr-view":
      return prView(args[0], parseFlags(args.slice(1)));
    case "pr-create":
      return prCreate(args[0], parseFlags(args.slice(1)));
    case "pr-merge":
      return prMerge(args[0], parseFlags(args.slice(1)));
    case "submit":
      return submitTicket(args[0], parseFlags(args.slice(1)));
    case "land": {
      // GCV-3 slice 2: terminal lifecycle boundary -> best-effort auto sync
      // of canonical derived artifacts so the git tree cannot lag the
      // journal. `--no-sync` opts out. landTicket runs first; its result
      // is what we return, sync is a best-effort side-effect afterwards.
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("land", args[0], flags, () => landTicket(args[0], flags));
    }
    case "close": {
      // Reviewer finding #3: close/finish are documented terminal aliases
      // and call finishTicket -> markDone internally (bypassing the
      // dispatch wrapper on `mark-done`). They must auto-sync too,
      // otherwise the lifecycle-boundary invariant has a documented hole.
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("close", args[0], flags, () => finishTicket(args[0], flags));
    }
    case "finish": {
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("finish", args[0], flags, () => finishTicket(args[0], flags));
    }
    case "finalize": {
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("finalize", args[0], flags, () => finalizeTicket(args[0], flags));
    }
    case "mark-done": {
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("mark-done", args[0], flags, () => markDone(args[0], flags));
    }
    case "supersede":
      return supersedeTicket(args[0], parseFlags(args.slice(1)));
    case "finish-ticket": {
      // Documented terminal alias chaining through markDone. Same auto-sync
      // wrapper as close/finish/land/finalize/mark-done — leaving this case
      // un-wrapped was the residual hole in finding #3 (only close/finish
      // got wrapped on the first pass).
      const flags = parseFlags(args.slice(1));
      return runTerminalLifecycle("finish-ticket", args[0], flags, () => finishTicket(args[0], flags));
    }
    case "review":
      return moveReview(args[0], parseFlags(args.slice(1)));
    case "move-review":
      return moveReview(args[0], parseFlags(args.slice(1)));
    case "reopen":
    case "reopen-ticket":
      return reopenTicket(args[0], parseFlags(args.slice(1)));
    case "repair":
      return returnDoing(args[0], parseFlags(args.slice(1)));
    case "return-doing":
      return returnDoing(args[0], parseFlags(args.slice(1)));
    case "start":
      return startTicket(args[0], parseFlags(args.slice(1)));
    case "start-ticket":
      return startTicket(args[0], parseFlags(args.slice(1)));
    case "unstart":
      return unstartTicket(args[0], parseFlags(args.slice(1)));
    case "unstart-ticket":
      return unstartTicket(args[0], parseFlags(args.slice(1)));
    case "lock-abandon":
      return lockAbandonTicket(args[0], parseFlags(args.slice(1)));
    case "abandon-lock":
      return lockAbandonTicket(args[0], parseFlags(args.slice(1)));
    case "block":
      return blockTicket(args[0], parseFlags(args.slice(1)));
    case "unblock":
      return unblockTicket(args[0], parseFlags(args.slice(1)));
    case "plan":
      return planTicket(args[0], parseFlags(args.slice(1)));
    case "commit":
    case "commit-ticket":
      return commitTicket(args[0], parseFlags(args.slice(1)));
    case "open-followup":
      return openFollowup(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "file-ticket":
    case "new":
      return fileTicket(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "next-id":
      return printNextId(args[0]);
    case "split-ticket":
      return splitTicket(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "set-followup-relation":
      return setFollowupRelation(args[0], parseFlags(args.slice(1)));
    case "set-priority":
      return setTicketPriority(args[0], parseFlags(args.slice(1)));
    case "set-type":
      return setTicketType(args[0], parseFlags(args.slice(1)));
    case "approve":
      return approveTicket(args[0], parseFlags(args.slice(1)));
    case "reject":
      return rejectTicket(args[0], parseFlags(args.slice(1)));
    case "set-waiver":
      return setWaiver(args[0], parseFlags(args.slice(1)));
    case "register-prompt": {
      const [registerTicket, ...registerRest] = args;
      const registerFlags = parseFlags(registerRest);
      // Accept an optional positional path arg in addition to --path.
      if (!registerFlags.path && registerRest[0] && !String(registerRest[0]).startsWith("-")) {
        registerFlags.path = registerRest[0];
      }
      return registerPrompt(registerTicket, registerFlags);
    }
    case "set-pr":
      return setPrRefs(args[0], parseFlags(args.slice(1)));
    case "add-finding":
      return addFinding(args[0], parseFlags(args.slice(1)));
    case "update-finding":
      return updateFinding(args[0], parseFlags(args.slice(1)));
    case "log-question":
      return logQuestion(parseFlags(args));
    case "heartbeat":
      return heartbeat(args[0]);
    case "update-plan":
      return updatePlanBlock(args[0], parseFlags(args.slice(1)));
    case "add-review-cycle":
      return addReviewCycleCommand(args[0], parseFlags(args.slice(1)));
    case "set-requirement-closure":
      return setRequirementClosureCommand(args[0], parseFlags(args.slice(1)));
    case "add-feature-proof":
      return addFeatureProofCommand(args[0], parseFlags(args.slice(1)));
    case "drop-feature-proof":
      return dropFeatureProofCommand(args[0], parseFlags(args.slice(1)));
    case "add-repo-gate":
      return addRepoGateCommand(args[0], parseFlags(args.slice(1)));
    case "record-cost":
      return recordCost(args[0], parseFlags(args.slice(1)));
    case "cost":
      return costReport(parseFlags(args));
    case "precheck":
      return precheck(args[0], parseFlags(args.slice(1)));
    case "context-pack":
      return contextPack(args[0], parseFlags(args.slice(1)));
    case "gate-plan":
      return gatePlanCommand(args[0], parseFlags(args.slice(1)));
    case "recall": {
      // COORD-141: `gov recall "<query>" [--role <role>] [--json]`. The query is
      // every non-flag positional joined with spaces (so an unquoted multi-word
      // query still works); --role / --json are parsed off the remaining flags.
      const positional = [];
      const flagArgs = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === "--json") {
          flagArgs.push(a);
        } else if (a === "--role") {
          flagArgs.push(a, args[i + 1]);
          i += 1;
        } else if (String(a).startsWith("--")) {
          flagArgs.push(a);
        } else {
          positional.push(a);
        }
      }
      return recallCommand(positional.join(" "), parseFlags(flagArgs));
    }
    case "sign-journal": {
      // COORD-146: `gov sign-journal sign|verify` — [Memory] cross-cutting batch
      // signing for per-event NON-REPUDIATION (folded into the KMS roadmap). The
      // leading positional is the subcommand. Flags are parsed inline (a self-
      // contained surface, like `recall`): `sign [--out <file>] [--json]`,
      // `verify <batch-file> [--event <hash>] [--json]`. Backward compatible /
      // OPTIONAL: extends the hash-chain + chain-head attestation, never replaces.
      const sub = args[0];
      const rest = args.slice(1);
      const opts = {};
      const positional = [];
      for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i];
        if (a === "--json") {
          opts.json = true;
        } else if (a === "--out") {
          requireValue(a, rest[i + 1]);
          opts.out = rest[++i];
        } else if (a === "--event") {
          requireValue(a, rest[i + 1]);
          opts.event = rest[++i];
        } else if (a === "--file") {
          requireValue(a, rest[i + 1]);
          opts.file = rest[++i];
        } else if (String(a).startsWith("--")) {
          fail(`Unknown flag "${a}".`);
        } else {
          positional.push(a);
        }
      }
      // For verify, the bundle/batch file may be supplied positionally.
      if (!opts.file && positional.length > 0) {
        opts.file = positional[0];
      }
      return signJournalCommand(sub, opts);
    }
    case "insights":
      // COORD-147: `gov insights [--json]` — Strategic execution-insight reports
      // (RECOMMENDS only; source-cited; mutates/gates nothing).
      return insightsCommand(parseFlags(args));
    case "coverage-rollup":
      // COORD-243: `gov coverage-rollup [--json] [--dry-run]` — the DO layer of
      // the coverage-maturity DETECT/DO/TRIGGER split. SEPARATE from `gov doctor`
      // (doctor only DETECTS). Refreshes coord/TEST_MATURITY.md from the real
      // per-commit coverage gate artifacts (QGATE-003) + `gov insights` gate
      // health. Idempotent; WRITES the artifact (that is its job).
      return coverageRollupCommand(parseFlags(args));
    case "prework":
      // COORD-148: `gov prework <ticket> [--scope "<text>"] [--role <role>]
      // [--json]` — [Memory] Solving pre-work context pack (RECOMMENDS only;
      // source-cited; mutates/gates/auto-starts nothing). The optional leading
      // positional is the ticket id; --scope adds free text.
      return preworkCommand(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "closeout-summary":
      // COORD-149: `gov closeout-summary <ticket> [--json]` — [Memory] Solving
      // auto evidence-backed closeout summary (REPORTS only; source-cited;
      // closes/gates/finalizes/mutates nothing — closeout stays governed by the
      // normal finalize lane). The leading positional is the ticket id.
      return closeoutSummaryCommand(args[0], parseFlags(args.slice(1)));
    case "learned-rule":
      // COORD-145: `gov learned-rule capture|list|promote` — governed procedural-
      // memory promotion. ROUTES learned behavioral rules to the FULL reviewed
      // lane (never edits a procedural file directly). The leading positional is
      // the subcommand; remaining args flow through verbatim to the engine CLI
      // (which parses --rule / --target / --citation / --rationale / --json).
      return learnedRuleCommand(args[0], args.slice(1));
    case "code-index":
      // Build or refresh the code symbol index at coord/memory/code-index.ndjson.
      // gov code-index [--repo <path>] [--ext .js,.ts] [--force] [--json]
      return codeIndexCommand(parseFlags(args));
    case "code-search": {
      // BM25 search over the code index.
      // gov code-search <query> [--top <N>] [--json]
      const positional = [];
      const flagArgs = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === "--json") {
          flagArgs.push(a);
        } else if (a === "--top" || a === "--n") {
          flagArgs.push(a, args[i + 1]);
          i += 1;
        } else if (String(a).startsWith("--")) {
          flagArgs.push(a);
        } else {
          positional.push(a);
        }
      }
      return codeSearchCommand(positional.join(" "), parseFlags(flagArgs));
    }
    case "code-context":
      // Compact symbol view for specific file paths.
      // gov code-context <file1> [file2 ...] [--json]
      return codeContextCommand(
        args.filter(a => !String(a).startsWith("--")),
        parseFlags(args.filter(a => String(a).startsWith("--")))
      );
    case "code-diff": {
      // Compact views of files changed vs a git ref.
      // gov code-diff [<base-ref>] [--json]
      const baseRef = hasLeadingPositional(args) ? args[0] : null;
      const diffFlags = parseFlags(baseRef ? args.slice(1) : args);
      return codeDiffCommand(baseRef, diffFlags);
    }
    case "tier":
      return tierCommand(args[0]);
    case "plan-waves":
      return planWaves(parseFlags(args));
    case "sequencer-plan":
      return sequencerPlan(parseFlags(args));
    case "merge-queue":
      return mergeQueue(parseFlags(args));
    case "dispatch-plan":
      return dispatchPlan(parseFlags(args));
    case "otlp-export":
      return otlpExport(parseFlags(args));
    case "set-review-cycles":
      return setReviewCyclesCommand(args[0], parseFlags(args.slice(1)));
    case "backfill-plan-records":
      return backfillPlanRecords(parseFlags(args));
    case "release-lock":
      return releaseLock(args[0], parseFlags(args.slice(1)));
    case "audit-worktrees":
      return auditWorktrees();
    case "cleanup-helpers":
      return cleanupHelperWorktrees(args[0], parseFlags(args.slice(1)));
    case "cleanup-worktree":
      return cleanupWorktree(args[0], args[1], parseFlags(args.slice(2)));
    case "clean-runtime":
      return cleanRuntime(parseFlags(args));
    case "sync":
      return runSyncCommand(parseFlags(args));
    case "runtime-lock-status":
      return runtimeLockStatus(parseFlags(args));
    case "break-runtime-lock":
      return breakRuntimeLock(parseFlags(args));
    case "gate":
      return runCleanCheckoutGate(args[0], parseFlags(args.slice(1)));
    case "retire-stale-drift-notes":
      return retireStaleDriftNotes(parseFlags(args));
    case "quality-scan": {
      // COORD-083: thin passthrough to the standalone quality-scan CLI. Args
      // flow through verbatim (dry-run by default; --apply files governed
      // follow-ups via this same gov binary). Kept out of lifecycle.js: this
      // is an orchestration entrypoint, not a board-state mutation.
      const { spawnSync } = require("child_process");
      const scanCli = path.join(__dirname, "quality-scan.js");
      const res = spawnSync(process.execPath, [scanCli, ...args], { stdio: "inherit" });
      process.exitCode = res.status == null ? 1 : res.status;
      return;
    }
    case "live-mcp-policy":
      return runtimeEvidence.printPolicy(parseFlags(args));
    case "live-mcp-record":
      return runtimeEvidence.liveMcpRecord(args[0], parseFlags(args.slice(1)));
    case "bootstrap-record":
      return runtimeEvidence.bootstrapRecord(args[0], parseFlags(args.slice(1)));
    case "deploy-record":
      return runtimeEvidence.deployRecord(args[0], parseFlags(args.slice(1)));
    case "deploy-check":
      return runtimeEvidence.deployCheck(optionalLeadingId(args), flagsAfterOptionalId(args));
    case "verify":
      return runtimeEvidence.verifyRuntime(args[0], parseFlags(args.slice(1)));
    case "falsify":
      return runtimeEvidence.falsify(args[0], parseFlags(args.slice(1)));
    case "validate-receipt":
      return runtimeEvidence.validateReceiptCommand(parseFlags(args));
    case "help":
      return printHelp({ all: args.includes("--all") });
    case undefined:
      return printHelp({ all: false });
    default:
      fail(`Unknown command "${command}". Run "node coord/scripts/governance.js help".`);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  return dispatchCommand(command, args);
}

function executeCommand(argv, options = {}) {
  const commandArgs = Array.isArray(argv) ? argv : [];
  const [command, ...args] = commandArgs;
  return withTemporaryExecutionContext(options, () => {
    const stdout = [];
    const stderr = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const writeStdout = (...values) => {
      stdout.push(util.format(...values));
    };
    const writeStderr = (...values) => {
      stderr.push(util.format(...values));
    };

    console.log = writeStdout;
    console.error = writeStderr;
    console.warn = writeStderr;
    try {
      const value = dispatchCommand(command, args);
      return {
        ok: true,
        value,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      };
    } catch (error) {
      if (error instanceof GovernanceError) {
        return {
          ok: false,
          error: error.message,
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
        };
      }
      error.capturedStdout = stdout.join("\n");
      error.capturedStderr = stderr.join("\n");
      throw error;
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });
}

// COORD-094: parseFlags was a ~650-line / ~130-case switch where the vast
// majority of arms were one of three identical shapes. The repetition both
// inflated the per-function cyclomatic complexity (the top arch hotspot) and
// was the largest duplication cluster. The flag spec is now DATA: three tables
// keyed by flag string. Behavior is byte-for-byte preserved — including
// first-wins for any flag listed twice (object literals keep the first key's
// definition order but Object spread/assignment here uses a single literal so
// the LAST literal key would win; we therefore keep each flag in exactly one
// table and route true duplicates through it once). The handful of flags with
// bespoke logic (validation, parseInt coercion, multi-key, side-flags) stay in
// a small explicit handler map.

// Simple value flags: `--flag value` -> parsed[key] = value.
const VALUE_FLAGS = Object.freeze({
  "--repo": "repo", "--mode": "mode", "--owner": "owner", "--handle": "handle",
  "--provider": "provider", "--lane": "lane", "--default-repo": "defaultRepo",
  "--notes": "notes", "--session-label": "sessionLabel", "--host": "host",
  "--cwd": "cwd", "--id": "id", "--ticket": "ticket", "--pri": "pri",
  "--limit": "limit", "--why": "why", "--branch": "branch", "--title": "title",
  "--body": "body", "--method": "method", "--worktree": "worktree",
  "--source": "source", "--topic": "topic", "--depends-on": "dependsOn",
  "--parent": "dependsOn", "--relation": "relation", "--type": "type",
  "--prefix": "prefix", "--into": "into", "--description": "description",
  "--summary": "summary", "--message": "message", "-m": "message",
  "--severity": "severity", "--qref": "qref", "--round": "round",
  "--resolved": "resolved", "--from": "from", "--to": "to",
  "--question": "question", "--lens": "lens", "--diff": "diff",
  "--findings": "findings", "--verification": "verification",
  "--verdict": "verdict", "--ticket-ask": "ticketAsk",
  "--implemented": "implemented", "--not-implemented": "notImplemented",
  "--deferred-to": "deferredTo", "--closeout-verdict": "closeoutVerdict",
  "--proof-path": "proofPath", "--proof-symbol": "proofSymbol",
  "--proof-text": "proofText", "--proof-route": "proofRoute",
  "--command": "commandText", "--audit": "audit", "--coverage": "coverage",
  "--answer": "answer", "--security": "security", "--live-mcp": "liveMcp", "--startup": "startup",
  "--traceability": "traceability", "--closeout-method": "closeoutMethod",
  "--closeout-base-ref": "closeoutBaseRef", "--provenance-note": "provenanceNote",
  "--review-profile": "reviewProfile", "--context-pack-ack": "contextPackAck",
  "--gate-plan": "gatePlan",
  "--source-commit": "sourceCommit",
  "--fulfilled-by-ticket": "fulfilledByTicket",
  "--fulfilled-by-commit": "fulfilledByCommit", "--prompt": "prompt",
  "--prompt-template": "promptTemplate", "--template": "template",
  "--section-heading": "sectionHeading", "--consolidated-into": "consolidatedInto",
  "--transfer-to": "transferTo", "--human-admin-override": "humanAdminOverride",
  "--commit": "commit", "--path": "path", "--agent": "agent", "--model": "model",
  "--input-tokens": "inputTokens", "--output-tokens": "outputTokens",
  "--usd": "usd", "--phase": "phase", "--by": "by", "--wave": "wave",
  "--tier": "tier",
  "--class": "operationClass", "--operation-class": "operationClass",
  "--operation": "operation", "--adapter": "adapter", "--scope": "scope",
  "--redaction": "redaction", "--approval": "approval", "--cleanup": "cleanup",
  // COORD-141: `gov recall --role <role>` opts into ENT-012 RBAC redaction.
  "--role": "role",
  // code-context: `gov code-search <q> --top <N>` limits results; `gov code-index --ext .js,.ts` filters extensions.
  "--top": "top", "--ext": "ext",
  "--environment": "environment", "--env": "environment",
  "--map": "mapPath", "--risk-class": "riskClass", "--track": "trackOverride",
  "--artifact": "artifact", "--running-artifact": "runningArtifact",
  "--build-source": "buildSource", "--deploy-id": "deployId",
  "--operator": "operator", "--receipt": "receipt",
  "--receipt-result": "receiptResult",
  "--evidence-class": "evidenceClass", "--claim": "claim",
  "--job": "job", "--execution-mode": "executionMode",
  "--resource-envelope": "resourceEnvelope", "--idempotency": "idempotency",
  "--query-shape": "queryShape", "--observability": "observability",
  "--disable-rollback": "disableRollback",
  // ENT-005: OTLP exporter sink flags. --output writes OTLP/JSON to a file;
  // --endpoint opt-in POSTs to an HTTP OTLP endpoint (OFF by default).
  "--output": "output", "--endpoint": "endpoint",
  // ENT-010: `gov conform --verify-attestation <file>` re-derives the engine
  // inputs, checks the signature, and flags drift/tamper.
  "--verify-attestation": "verifyAttestation",
  // COORD-272: `gov conform --verify-attestation <file> --trust-anchor <pem|fingerprint>`
  // pins an org trust root so verify rejects an attestation whose signing key is
  // not trusted (closes the forge-with-your-own-key authenticity bypass). Also
  // configurable via project.config.js `conformance.trustedAttestationKeys` or
  // the CONFORMANCE_TRUST_ANCHOR env. Optional — unset = self-hosting community.
  "--trust-anchor": "trustAnchor",
});

// Append (repeatable) value flags: `--flag value` -> parsed[key].push(value).
const APPEND_FLAGS = Object.freeze({
  "--risk": "risk", "--verify": "verify", "--files": "files",
  "--baseline": "baseline", "--invariant": "invariant", "--closure": "closure",
  "--feature-proof": "featureProof", "--drop-feature-proof": "dropFeatureProof",
  "--repo-gate": "repoGate", "--rollback": "rollback",
  "--review-cycle": "reviewCycle", "--drop-file": "dropFile", "--pr": "pr",
  "--landed": "landed", "--evidence": "evidence", "--meta": "meta",
});

// Boolean flags: `--flag` -> parsed[key] = true.
const BOOL_FLAGS = Object.freeze({
  "--assign": "assign", "--no-pr": "noPr", "--not-required": "notRequired",
  "--already-landed": "alreadyLanded", "--delete-branch": "deleteBranch",
  "--draft": "draft", "--closeout-blocker": "closeoutBlocker", "--fill": "fill",
  "--push": "push", "--autofill-startup": "autofillStartup", "--seed": "seed",
  "--all": "all", "--admin": "admin", "--handoff": "handoff",
  "--repair-all": "repairAll",
  "--no-sync": "noSync", "--force": "force", "--fix": "fix", "--fresh": "fresh", "--git": "git",
  "--clear": "clear", "--yes": "yes", "--include-blocked": "includeBlocked",
  "--full": "full", "--write": "write", "--dry-run": "dryRun",
  "--scope-self": "scopeSelf", "--json": "json", "--md": "md",
  "--record": "record",
  "--force-live": "forceLive",
  "--with-prompt": "withPrompt", "--create": "create", "--replace": "replace",
  // ENT-005: explicit stdout sink for the OTLP exporter (also the default when
  // no sink flag is given).
  "--stdout": "stdout",
  // ENT-001: opt-in push of the post-finalize canonical-sync commit (durable
  // journal/plans/snapshots) to the coord remote. NOT default; never force.
  // Env equivalent: COORD_PUSH_ON_FINALIZE=1.
  "--push-after-sync": "pushAfterSync",
  // ENT-010: `gov conform --attest` emits a signed conformance attestation over
  // the engine-integrity inputs (in addition to the journal chain self-verify).
  "--attest": "attest",
  // ENT-011: `gov verify-engine --pin` (re)pins the current engine surface
  // (manifest version + fingerprint + per-file snapshot) to coord/engine-pin.json.
  // Without it, `gov verify-engine` is a read-only drift check against the pin.
  "--pin": "pin",
  // COORD-124: `gov repair-chain --confirm` applies the guarded chain repair
  // (with `--reason "<why>"`). Without it, repair-chain is a read-only dry-run.
  "--confirm": "confirm",
  // COORD-222: opt out of the fail-closed "one governed writer per
  // checkout/runtime" guard on `gov start` / `gov claim`. DEFAULT is fail-closed;
  // pass this only when deliberately running the documented orchestrator-spawns-
  // N-subagents topology (each sub-agent SHOULD still use a separate worktree).
  "--allow-shared-worktree": "allowSharedWorktree",
  // COORD-198: `gov set-requirement-closure --supersede` REPLACES the prior
  // requirement_closure block instead of appending. requirement_closure is
  // append-only by default; a re-closure (e.g. partial -> complete after a
  // takeover) otherwise leaves BOTH blocks in the ordered array. The derived
  // verdict/debt read uses recency (last block wins) regardless, so this is a
  // record-hygiene convenience, not a correctness requirement.
  "--supersede": "supersede",
});

// Flags whose handling is not a plain table assignment: validation, integer
// coercion, multi-key, or a value flag that also sets a side flag. Each takes
// (parsed, arg, next) and returns true if it consumed the value (so the index
// advances). Kept tiny + explicit — this is the irreducible part of the parser.
const SPECIAL_FLAGS = Object.freeze({
  "--status": (parsed, arg, next) => {
    requireValue(arg, next);
    if (!isLegalStatus(next) && !LEGAL_FINDING_STATUSES.has(next)) {
      fail(`Invalid status "${next}".`);
    }
    parsed.status = next;
    return true;
  },
  "--base": (parsed, arg, next) => {
    requireValue(arg, next);
    parsed.base = next;
    parsed.baseExplicit = true;
    return true;
  },
  "--reason": (parsed, arg, next) => { requireValue(arg, next); parsed.reason = next; return true; },
  "--note": (parsed, arg, next) => { requireValue(arg, next); parsed.note = next; return true; },
  "--result": (parsed, arg, next) => {
    requireValue(arg, next);
    if (next !== "pass" && next !== "fail") fail(`--result must be "pass" or "fail".`);
    parsed.gateResult = next;
    return true;
  },
  "--base-result": (parsed, arg, next) => {
    requireValue(arg, next);
    if (next !== "pass" && next !== "fail") fail(`--base-result must be "pass" or "fail".`);
    parsed.gateBaseResult = next;
    return true;
  },
  "--replace-review-cycle": (parsed, arg, next) => {
    requireValue(arg, next);
    parsed.replaceReviewCycle = parseInt(next, 10);
    return true;
  },
  "--drop-review-cycle": (parsed, arg, next) => {
    requireValue(arg, next);
    parsed.dropReviewCycle = parseInt(next, 10);
    return true;
  },
});

function parseFlags(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (Object.prototype.hasOwnProperty.call(SPECIAL_FLAGS, arg)) {
      SPECIAL_FLAGS[arg](parsed, arg, next);
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, arg)) {
      requireValue(arg, next);
      parsed[VALUE_FLAGS[arg]] = next;
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(APPEND_FLAGS, arg)) {
      requireValue(arg, next);
      appendValue(parsed, APPEND_FLAGS[arg], next);
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, arg)) {
      parsed[BOOL_FLAGS[arg]] = true;
    } else if (arg === "--plan-update") {
      fail(
        'Unknown flag "--plan-update". ' +
        `Plan fields are updated separately: use \`coord/scripts/gov update-plan <ticket-id> --summary "..."\`, ` +
        `\`--invariant "..."\`, \`--feature-proof "..."\`, \`--repo-gate "..."\`, and \`--review-cycle "..."\` before commit/submit.`
      );
    } else {
      fail(`Unknown flag "${arg}".`);
    }
  }
  return parsed;
}

function requireValue(flag, value) {
  if (!value) {
    fail(`${flag} requires a value.`);
  }
}

function appendValue(obj, key, value) {
  if (!obj[key]) {
    obj[key] = [];
  }
  obj[key].push(value);
}

module.exports = {
  GovernanceError,
  main,
  executeCommand,
  __testing: {
    ...lifecycle.__testing,
    dispatchCommand,
    withTemporaryExecutionContext,
    parseFlags,
    // COORD-066: expose the closeout/land exec surface on the test facade so the
    // transitions<->closeout deferred-wiring guard test can drive a ticket
    // through finalize/finish end-to-end. These cross the near-circular DI seam
    // (closeout.finishTicket -> deferred markDone -> deferred prepareDoneCloseout)
    // that nothing else in the suite invokes.
    finalizeTicket,
    finishTicket,
    landTicket,
    markDone,
    moveReview,
  },
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof GovernanceError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
