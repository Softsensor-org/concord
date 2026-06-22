#!/usr/bin/env node
"use strict";

const path = require("path");
const util = require("util");
const lifecycle = require("./lifecycle.js");
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
  verifyEngine,
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
    case "verify-engine":
      return verifyEngine(parseFlags(args));
    case "orch":
    case "orchestrator-cycle":
      return orchestratorCycle(parseFlags(args));
    case "audit-landings":
      return auditLandings(parseFlags(args));
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
      const result = landTicket(args[0], flags);
      autoSyncAfterLifecycle({ verb: "land", ticketId: args[0], options: flags });
      return result;
    }
    case "close": {
      // Reviewer finding #3: close/finish are documented terminal aliases
      // and call finishTicket -> markDone internally (bypassing the
      // dispatch wrapper on `mark-done`). They must auto-sync too,
      // otherwise the lifecycle-boundary invariant has a documented hole.
      const flags = parseFlags(args.slice(1));
      const result = finishTicket(args[0], flags);
      autoSyncAfterLifecycle({ verb: "close", ticketId: args[0], options: flags });
      return result;
    }
    case "finish": {
      const flags = parseFlags(args.slice(1));
      const result = finishTicket(args[0], flags);
      autoSyncAfterLifecycle({ verb: "finish", ticketId: args[0], options: flags });
      return result;
    }
    case "finalize": {
      const flags = parseFlags(args.slice(1));
      const result = finalizeTicket(args[0], flags);
      autoSyncAfterLifecycle({ verb: "finalize", ticketId: args[0], options: flags });
      return result;
    }
    case "mark-done": {
      const flags = parseFlags(args.slice(1));
      const result = markDone(args[0], flags);
      autoSyncAfterLifecycle({ verb: "mark-done", ticketId: args[0], options: flags });
      return result;
    }
    case "supersede":
      return supersedeTicket(args[0], parseFlags(args.slice(1)));
    case "finish-ticket": {
      // Documented terminal alias chaining through markDone. Same auto-sync
      // wrapper as close/finish/land/finalize/mark-done — leaving this case
      // un-wrapped was the residual hole in finding #3 (only close/finish
      // got wrapped on the first pass).
      const flags = parseFlags(args.slice(1));
      const result = finishTicket(args[0], flags);
      autoSyncAfterLifecycle({ verb: "finish-ticket", ticketId: args[0], options: flags });
      return result;
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
    case "tier":
      return tierCommand(args[0]);
    case "plan-waves":
      return planWaves(parseFlags(args));
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
  "--answer": "answer", "--security": "security", "--startup": "startup",
  "--traceability": "traceability", "--closeout-method": "closeoutMethod",
  "--closeout-base-ref": "closeoutBaseRef", "--provenance-note": "provenanceNote",
  "--review-profile": "reviewProfile", "--source-commit": "sourceCommit",
  "--fulfilled-by-ticket": "fulfilledByTicket",
  "--fulfilled-by-commit": "fulfilledByCommit", "--prompt": "prompt",
  "--section-heading": "sectionHeading", "--consolidated-into": "consolidatedInto",
  "--transfer-to": "transferTo", "--human-admin-override": "humanAdminOverride",
  "--commit": "commit", "--path": "path", "--agent": "agent", "--model": "model",
  "--input-tokens": "inputTokens", "--output-tokens": "outputTokens",
  "--usd": "usd", "--phase": "phase", "--by": "by", "--wave": "wave",
  "--class": "operationClass", "--operation-class": "operationClass",
  "--operation": "operation", "--adapter": "adapter", "--scope": "scope",
  "--redaction": "redaction", "--approval": "approval", "--cleanup": "cleanup",
  "--environment": "environment", "--env": "environment",
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
  "--no-sync": "noSync", "--force": "force", "--fix": "fix", "--fresh": "fresh",
  "--clear": "clear", "--yes": "yes", "--include-blocked": "includeBlocked",
  "--full": "full", "--write": "write", "--dry-run": "dryRun",
  "--scope-self": "scopeSelf", "--json": "json", "--md": "md",
  "--record": "record",
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
