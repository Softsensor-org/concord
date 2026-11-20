#!/usr/bin/env node
"use strict";
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

const path = require("path");
const {
  SHARED_VALUE_FLAGS,
  SHARED_APPEND_FLAGS,
  SHARED_SCALAR_TEXT_FILE_FIELDS,
  SHARED_BOOL_FLAGS,
  appendValue,
  createSharedSpecialFlags,
  parseFlagTables,
} = require("./flag-tables.js");
const util = require("util");
const { resolveEngineModule } = require("../../paths.js");
const { createSafeTextInput } = require(resolveEngineModule(
  path.resolve(__dirname, "..", ".."),
  "scripts/safe-text-input.js",
));
const adrValidator = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/adr-validator.js"));
const lifecycle = require("./lifecycle.js");
const { state: governanceState, COORD_DIR, ROOT_DIR } = require("./governance-context.js");
const commandRegistry = require("./command-registry.js");
const integrationAuthority = require("./integration-authority.js");
const architectureAudit = require("./architecture-audit.js");
const runtimeEvidence = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/runtime-evidence.js"));
const {
  STATUS,
  legalStatusSet,
  legalFindingStatusSet,
} = require("./governance-constants.js");

// COORD-612: the help TEXT surface (buildHelpText / buildVerbHelpText /
// printVerbHelp) is dependency-free pure string building, so `gov <verb> --help`
// takes it straight from the module instead of threading three more names
// through the lifecycle composition root — which is under a shrink-only LOC
// budget that must not be spent on presentation wiring. printHelp keeps coming
// from `commands` so the existing help path is untouched.
const { buildHelpText, buildVerbHelpText, printVerbHelp } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-help.js"))({});

const { GovernanceError, commands } = lifecycle;
// COORD-989: cli-surface never requires cli.js back. The surface needs the live parser,
// so cli.js hands it a provider here, at the call site that prints the surface.
function printableSurface() {
  const surface = require("./cli-surface.js");
  surface.bindParser(() => module.exports.__testing.parseFlags);
  return surface;
}

// COORD-924: `gov selection` — the governed affected-selection state (activation,
// per-category suspensions) on the board, and the nightly comparison.
function selectionCommands() {
  const selectionState = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/affected-state.js"));
  const { loadPolicy } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/affected-selector.js"));
  // COORD-989: the comparison is injected here; affected-state never requires affected-landing.
  const landing = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/affected-landing.js"));
  const boardPath = governanceState.BOARD_PATH;
  const ledgerDir = path.join(governanceState.RUNTIME_DIR, "affected-selection");
  return selectionState.createSelectionCommands({
    withBoardTransaction: lifecycle.__testing.withBoardTransaction, writeBoard: lifecycle.__testing.writeBoard,
    fail, loadPolicy, root: path.dirname(ENGINE_COORD_DIR), boardPath, ledgerDir,
    compareFullRun: (options) => landing.compareFullRun({ ...options, boardPath, ledgerDir, policy: loadPolicy() }),
  });
}

const appendGovernanceEvent = (event) => lifecycle.__testing.appendGovernanceEvent(event);

// COORD-936: `gov test-policy` — the one stage-aware test policy: resolve and
// run a stage's checks fresh, and classify a full run against the selection.
function testPolicyCommand(sub, args) {
  const { createTestPolicyCommands } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/test-policy-run.js"));
  const handle = () => lifecycle.ensureCurrentAgentIdentity({ readOnly: true }).agent.handle;
  return createTestPolicyCommands({ root: path.dirname(ENGINE_COORD_DIR), fail, boardPath: governanceState.BOARD_PATH,
    ledgerDir: path.join(governanceState.RUNTIME_DIR, "affected-selection"), planRecordsDir: governanceState.PLAN_RECORDS_DIR,
    withBoardTransaction: lifecycle.__testing.withBoardTransaction, writeBoard: lifecycle.__testing.writeBoard,
    readJournalEvents: lifecycle.__testing.readGovernanceEventLog, readIntegrationRecord: integrationAuthority.readRecord,
    resolveHumanAdminOverride: lifecycle.__testing.resolveHumanAdminOverride, currentHandle: handle,
    appendGovernanceEvent, runtimeDir: governanceState.RUNTIME_DIR })(sub, args);
}

// COORD-1027: the UI and CLI share this governed command factory.
function configProposalCommand(args) {
  return require("./config-proposals.js").createConfigProposalCommand({
    coordDir: COORD_DIR, rootDir: ROOT_DIR, lifecycle,
    ensureCurrentAgentIdentity: (...identityArgs) => lifecycle.ensureCurrentAgentIdentity(...identityArgs), fail,
  })(args);
}

const { withTemporaryExecutionContext } = lifecycle.__testing;
const {
  addFeatureProofCommand,
  addFinding,
  correctFindingRound,
  correctFindingSeverity,
  normalizeLock,
  addRepoGateCommand,
  addReviewCycleCommand,
  agentsCommand,
  approveTicket,
  auditLandings,
  reconcileLandings,
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
  requestContext,
  contextRequests,
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
  resolveQuestion,
  fileTicket,
  amendTicket,
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
  recordLifecycleCostBoundary,
  reportPrefixUse,
  observe,
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
  publishBoardState,
  runTicketCycle,
  runtimeLockStatus,
  setFollowupRelation,
  setPrRefs,
  setRequirementClosureCommand,
  setReviewCyclesCommand,
  supersedePlanEvidenceCommand,
  recordIndependentReviewCommand,
  recordManagedEvidenceCommand,
  setTicketPriority,
  setRequirementIds,
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
const { readUtf8TextFile } = createSafeTextInput({ fail });

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
function runTerminalLifecycle(verb, ticketId, flags, fn, dependencies = {}) {
  const syncAfterLifecycle = dependencies.autoSyncAfterLifecycle || autoSyncAfterLifecycle;
  const releaseSession = dependencies.releaseTerminalTicketSession || releaseTerminalTicketSession;
  const result = fn();
  // Persist the advisory closeout observation before normal publication so a
  // governed push carries the same journal evidence as the landing record.
  if (["land", "close", "finish", "finalize", "mark-done", "finish-ticket"].includes(verb)) {
    recordLifecycleCostBoundary(ticketId, "review", ["land", "mark-done"]);
  }
  let terminalSync = {
    session_release_safe: false,
    publication: { status: "sync-did-not-complete", published: false },
  };
  try {
    terminalSync = syncAfterLifecycle({ verb, ticketId, options: flags });
  } finally {
    try {
      const release = releaseSession(ticketId, { terminalSync });
      if (release && release.reason === "canonical-publication-unverified") {
        const publication = release.publication || {};
        console.warn(
          `[gov ${verb}] retained the active agent session: canonical publication is ${publication.status || "unverified"}. ` +
          "Resolve the upstream state and retry the governed terminal verb with --push-after-sync."
        );
      }
    } catch {
      // Best-effort runtime-ledger cleanup. Terminal closeout authority remains
      // the lifecycle mutation and journal; a session-ledger cleanup issue must
      // not roll back a completed ticket.
    }
  }
  return result;
}

// COORD-988 (F-12): close, finish and finish-ticket share one terminal body. The typed verb
// is the journal label, so each alias keeps its own label and only the body is shared.
function runTerminalAliasVerb(verb, args, handler, dependencies = {}) {
  const flags = parseFlags(args.slice(1));
  return runTerminalLifecycle(verb, args[0], flags, () => handler(args[0], flags), dependencies);
}

// COORD-915: every dispatched verb passes the integration-authority guard
// (classification, holder check, operation reservation) before its handler.
function dispatchGovernedCommand(command, args = []) {
  // COORD-922: reject unsupported previews before COORD-915 can reserve and
  // journal integration authority. The inner router check remains as a guard
  // for direct dispatchCommand callers.
  require("./dry-run-policy.js").assertDryRunSupported(command, args, fail);
  return integrationAuthority.guardCommand(command, args, () => dispatchCommand(command, args));
}


const ROUTE_ROWS = require("./command-declaration.js").ROWS;
// COORD-1021 (a): the route table. Each entry is the body of one former dispatchCommand arm, keyed by
// its semantic handler id (command-declaration.js ROWS.handler). The spellings that reach an entry are
// declared there (aliasOf), and ROUTES below maps every declared spelling to its entry. Bodies are moved
// verbatim: a handler receives the typed command and the raw args, exactly as the former switch arm did.
const ROUTE_HANDLERS = Object.freeze({
  "counts": (command, args) => printCounts(),
  "pick": (command, args) => pickTickets(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "list": (command, args) => listTickets(parseFlags(args)),
  "recommend": (command, args) => recommendTickets(parseFlags(args)),
  "run-ticket-cycle": (command, args) => runTicketCycle(args[0], parseFlags(args.slice(1))),
  "fleet-golden-path": (command, args) => fleetGoldenPath(args[0], parseFlags(args.slice(1))),
  "guided-closeout": (command, args) => commandRegistry.runAdoptionGovernanceCommand(command, args, parseFlags, { collectReviewPlanReadinessIssues: lifecycle.collectReviewPlanReadinessIssues }),
  "agents": (command, args) => agentsCommand(args),
  "agentid": (command, args) => printCurrentAgentId(parseFlags(args)),
  "initiate": (command, args) => printInitiate(parseFlags(args)),
  "claim": (command, args) => claim(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "agent-claim": (command, args) => claimAgent(args[0], parseFlags(args.slice(1))),
  "agent-release": (command, args) => releaseAgent(args[0], parseFlags(args.slice(1))),
  "agent-rebind": (command, args) => rebindAgent(parseFlags(args)),
  "rebuild-board": (command, args) => rebuildBoardFromJournal(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "agent-status": (command, args) => showAgentStatus(args[0]),
  "doctor": (command, args) => {
    const flags = parseFlags(args);
    return flags.recoverRuns ? recoverRunsCommand(flags) : doctor(flags);
  },
  "conform": (command, args) => conform(parseFlags(args)),
  "repair-chain": (command, args) => repairChain(parseFlags(args)),
  "migrate-chain-hash": (command, args) => migrateChainHash(parseFlags(args)),
  "verify-engine": (command, args) => verifyEngine(parseFlags(args)),
  "orch": (command, args) => orchestratorCycle(parseFlags(args)),
  "audit-landings": (command, args) => auditLandings(parseFlags(args)),
  "reconcile-landings": (command, args) => reconcileLandings(parseFlags(args)),
  "adr": (command, args) => {
    return adrValidator.govAdr(args, {
      decisionsDir: governanceState.DECISIONS_DIR,
      withGovernanceMutation: lifecycle.__testing.withGovernanceMutation,
      ensureCurrentAgentIdentity: lifecycle.ensureCurrentAgentIdentity,
      fail,
    });
  },
  // COORD-1026 / ADR 0028: gov promote <edge> moves a promoted branch fast-forward only.
  // COORD_PROMOTE_REPO is a test seam: the fixture points promote at its bare-remote repo. Unset, the
  // verb promotes in the repository that owns this engine.
  "promote": (command, args) => {
    const result = require("./promote.js").runPromote(args, {
      repo: process.env.COORD_PROMOTE_REPO || path.dirname(ENGINE_COORD_DIR),
      fail,
      resolveCaller: () => integrationAuthority.resolveCaller(),
      readRecord: () => integrationAuthority.readRecord(),
      appendGovernanceEvent,
      // COORD-1043: the journaled producer events that bind each gate manifest.
      readJournal: () => lifecycle.__testing.readGovernanceEventLog(),
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  },
  "selection": (command, args) => selectionCommands().selectionCommand(args[0], args.slice(1)),
  "test-policy": (command, args) => testPolicyCommand(args[0], args.slice(1)),
  "config": (command, args) => configProposalCommand(args),
  "ticket": (command, args) => showTicket(args[0]),
  "recent": (command, args) => recentEvents(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "explain": (command, args) => explainTicket(args[0]),
  "recover": (command, args) => recoverTicket(args[0], parseFlags(args.slice(1))),
  "resume": (command, args) => resumeTicket(args[0], parseFlags(args.slice(1))),
  "reconcile": (command, args) => reconcileGovernance(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "reap-gate-procs": (command, args) => reapGateProcs(parseFlags(args)),
  "repair-lock-head": (command, args) => {
    // COORD-978: governed lock-head repair (owner: containing commit only; else --human-admin-override).
    return require("./lock-head-repair.js").createLockHeadRepair({
      withGovernanceMutation: lifecycle.__testing.withGovernanceMutation,
      resolveHumanAdminOverride: lifecycle.__testing.resolveHumanAdminOverride,
      appendGovernanceEvent,
      runtimeDir: governanceState.RUNTIME_DIR,
    }).repairLockHead(args[0], parseFlags(args.slice(1)));
  },
  "pr-view": (command, args) => prView(args[0], parseFlags(args.slice(1))),
  "pr-create": (command, args) => prCreate(args[0], parseFlags(args.slice(1))),
  "pr-merge": (command, args) => prMerge(args[0], parseFlags(args.slice(1))),
  "submit": (command, args) => submitTicket(args[0], parseFlags(args.slice(1))),
  "land": (command, args) => {
    // GCV-3 slice 2: terminal lifecycle boundary -> best-effort auto sync
    // of canonical derived artifacts so the git tree cannot lag the
    // journal. `--no-sync` opts out. landTicket runs first; its result
    // is what we return, sync is a best-effort side-effect afterwards.
    const flags = parseFlags(args.slice(1));
    const result = runTerminalLifecycle("land", args[0], flags, () => landTicket(args[0], flags));
    return result;
  },
  // Reviewer finding #3: close/finish are documented terminal aliases and call
  // finishTicket -> markDone internally (bypassing the dispatch wrapper on
  // `mark-done`). They must auto-sync too. COORD-988: one shared body; the typed
  // alias stays the journal label.
  "close": (command, args) => runTerminalAliasVerb(command, args, finishTicket),
  "finalize": (command, args) => {
    const flags = parseFlags(args.slice(1));
    const result = runTerminalLifecycle("finalize", args[0], flags, () => finalizeTicket(args[0], flags));
    return result;
  },
  "mark-done": (command, args) => {
    const flags = parseFlags(args.slice(1));
    const result = runTerminalLifecycle("mark-done", args[0], flags, () => markDone(args[0], flags));
    return result;
  },
  "supersede": (command, args) => supersedeTicket(args[0], parseFlags(args.slice(1))),
  "review": (command, args) => {
    const result = moveReview(args[0], parseFlags(args.slice(1)));
    recordLifecycleCostBoundary(args[0], "implement", ["move-review"]);
    return result;
  },
  "reopen": (command, args) => reopenTicket(args[0], parseFlags(args.slice(1))),
  "repair": (command, args) => returnDoing(args[0], parseFlags(args.slice(1))),
  "start": (command, args) => {
    const result = startTicket(args[0], parseFlags(args.slice(1)));
    recordLifecycleCostBoundary(args[0], "plan", ["start"]);
    // COORD-1047 (d): publish the attempt OUTSIDE the runtime lock; best-effort, never blocks start.
    if (result && result.ticket) {
      const published = require("./attempt-coordination.js").publishStartAttempt(path.dirname(governanceState.RUNTIME_DIR), {
        runtimeDir: governanceState.RUNTIME_DIR, ticket: result.ticket, handle: result.handle,
        branch: result.branch, baseSha: result.base_sha, baseRef: result.base_ref,
      });
      if (published.warning) console.warn(`[warning] ${published.warning}`);
    }
    return result;
  },
  "unstart": (command, args) => unstartTicket(args[0], parseFlags(args.slice(1))),
  "lock-abandon": (command, args) => lockAbandonTicket(args[0], parseFlags(args.slice(1))),
  "block": (command, args) => blockTicket(args[0], parseFlags(args.slice(1))),
  "unblock": (command, args) => unblockTicket(args[0], parseFlags(args.slice(1))),
  "plan": (command, args) => planTicket(args[0], parseFlags(args.slice(1))),
  "commit": (command, args) => commitTicket(args[0], parseFlags(args.slice(1))),
  "open-followup": (command, args) => openFollowup(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "file-ticket": (command, args) => fileTicket(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "amend-ticket": (command, args) => amendTicket(args[0], parseFlags(args.slice(1))),
  "next-id": (command, args) => printNextId(args[0]),
  "split-ticket": (command, args) => splitTicket(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "set-followup-relation": (command, args) => setFollowupRelation(args[0], parseFlags(args.slice(1))),
  "set-priority": (command, args) => setTicketPriority(args[0], parseFlags(args.slice(1))),
  "set-requirement-ids": (command, args) => setRequirementIds(args[0], parseFlags(args.slice(1))),
  "set-type": (command, args) => setTicketType(args[0], parseFlags(args.slice(1))),
  "approve": (command, args) => approveTicket(args[0], parseFlags(args.slice(1))),
  "reject": (command, args) => rejectTicket(args[0], parseFlags(args.slice(1))),
  "set-waiver": (command, args) => setWaiver(args[0], parseFlags(args.slice(1))),
  "register-prompt": (command, args) => {
    const [registerTicket, ...registerRest] = args;
    // Accept an optional positional path arg in addition to --path (the
    // published usage is `register-prompt <ticket-id> [<path>]`). It is taken
    // off BEFORE parseFlags, which refuses any non-flag token; --path wins.
    const positionalPath = hasLeadingPositional(registerRest) ? registerRest[0] : null;
    const registerFlags = parseFlags(positionalPath ? registerRest.slice(1) : registerRest);
    if (!registerFlags.path && positionalPath) {
      registerFlags.path = positionalPath;
    }
    return registerPrompt(registerTicket, registerFlags);
  },
  "set-pr": (command, args) => setPrRefs(args[0], parseFlags(args.slice(1))),
  "add-finding": (command, args) => addFinding(args[0], parseFlags(args.slice(1))),
  "correct-finding-round": (command, args) => correctFindingRound(args[0], parseFlags(args.slice(1))),
  "correct-finding-severity": (command, args) => correctFindingSeverity(args[0], parseFlags(args.slice(1))),
  "normalize-lock": (command, args) => normalizeLock(args[0], parseFlags(args.slice(1))),
  "update-finding": (command, args) => updateFinding(args[0], parseFlags(args.slice(1))),
  "log-question": (command, args) => logQuestion(parseFlags(args)),
  "resolve-question": (command, args) => resolveQuestion(parseFlags(args)),
  "heartbeat": (command, args) => heartbeat(args[0]),
  "update-plan": (command, args) => {
    const options = parseFlags(args.slice(1));
    rejectUnsupportedUpdatePlanOptions(options);
    return updatePlanBlock(args[0], options);
  },
  // COORD-723: self-contained module, required lazily like guided-closeout so
  // the composition root gains no wiring for it.
  "scan-context-pack-acks": (command, args) => require("./context-pack-ack-commands.js").scanContextPackAcksCommand(parseFlags(args)),
  "repair-context-pack-ack": (command, args) => require("./context-pack-ack-commands.js").repairContextPackAckCommand(args[0], parseFlags(args.slice(1)), { updatePlanBlock }),
  "set-context-pack-ack": (command, args) => require("./context-pack-ack-commands.js").setContextPackAckCommand(args[0], parseFlags(args.slice(1)), { updatePlanBlock }),
  "supersede-plan-evidence": (command, args) => supersedePlanEvidenceCommand(args[0], parseFlags(args.slice(1))),
  "record-independent-review": (command, args) => recordIndependentReviewCommand(args[0], parseFlags(args.slice(1))),
  "record-managed-evidence": (command, args) => recordManagedEvidenceCommand(args[0], parseFlags(args.slice(1))),
  "add-review-cycle": (command, args) => addReviewCycleCommand(args[0], parseFlags(args.slice(1))),
  "set-requirement-closure": (command, args) => setRequirementClosureCommand(args[0], parseFlags(args.slice(1))),
  "add-feature-proof": (command, args) => addFeatureProofCommand(args[0], parseFlags(args.slice(1))),
  "drop-feature-proof": (command, args) => dropFeatureProofCommand(args[0], parseFlags(args.slice(1))),
  "add-repo-gate": (command, args) => addRepoGateCommand(args[0], parseFlags(args.slice(1))),
  "record-cost": (command, args) => recordCost(args[0], parseFlags(args.slice(1))),
  "report-prefix-use": (command, args) => reportPrefixUse(args[0], parseFlags(args.slice(1))),
  "observe": (command, args) => observe(args),
  "cost": (command, args) => costReport(parseFlags(args)),
  "precheck": (command, args) => precheck(args[0], parseFlags(args.slice(1))),
  "context-pack": (command, args) => contextPack(args[0], parseFlags(args.slice(1))),
  "request-context": (command, args) => requestContext(args[0], args.slice(1)),
  "context-requests": (command, args) => contextRequests(args),
  "gate-plan": (command, args) => gatePlanCommand(args[0], parseFlags(args.slice(1))),
  "recall": (command, args) => {
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
  },
  "sign-journal": (command, args) => {
    const { sub, opts } = parseSignJournalArgs(args);
    return signJournalCommand(sub, opts);
  },
  "insights": (command, args) => {
    // COORD-147: `gov insights [--json]` — Strategic execution-insight reports
    // (RECOMMENDS only; source-cited; mutates/gates nothing).
    return insightsCommand(parseFlags(args));
  },
  "coverage-rollup": (command, args) => {
    // COORD-243: `gov coverage-rollup [--json] [--dry-run]` — the DO layer of
    // the coverage-maturity DETECT/DO/TRIGGER split. SEPARATE from `gov doctor`
    // (doctor only DETECTS). Refreshes coord/TEST_MATURITY.md from the real
    // per-commit coverage gate artifacts (QGATE-003) + `gov insights` gate
    // health. Idempotent; WRITES the artifact (that is its job).
    return coverageRollupCommand(parseFlags(args));
  },
  "prework": (command, args) => {
    // COORD-148: `gov prework <ticket> [--scope "<text>"] [--role <role>]
    // [--json]` — [Memory] Solving pre-work context pack (RECOMMENDS only;
    // source-cited; mutates/gates/auto-starts nothing). The optional leading
    // positional is the ticket id; --scope adds free text.
    return preworkCommand(optionalLeadingId(args), flagsAfterOptionalId(args));
  },
  "closeout-summary": (command, args) => {
    // COORD-149: `gov closeout-summary <ticket> [--json]` — [Memory] Solving
    // auto evidence-backed closeout summary (REPORTS only; source-cited;
    // closes/gates/finalizes/mutates nothing — closeout stays governed by the
    // normal finalize lane). The leading positional is the ticket id.
    return closeoutSummaryCommand(args[0], parseFlags(args.slice(1)));
  },
  "learned-rule": (command, args) => {
    // COORD-145: `gov learned-rule capture|list|promote` — governed procedural-
    // memory promotion. ROUTES learned behavioral rules to the FULL reviewed
    // lane (never edits a procedural file directly). The leading positional is
    // the subcommand; remaining args flow through verbatim to the engine CLI
    // (which parses --rule / --target / --citation / --rationale / --json).
    return learnedRuleCommand(args[0], args.slice(1));
  },
  "code-index": (command, args) => {
    // Build or refresh the code symbol index at coord/memory/code-index.ndjson.
    // gov code-index [--repo <path>] [--ext .js,.ts] [--force] [--json]
    return codeIndexCommand(parseFlags(args));
  },
  "code-search": (command, args) => {
    // BM25 search over the code index.
    // gov code-search <query> [--top <N>] [--json]
    const positional = [];
    const flagArgs = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === "--json") {
        flagArgs.push(a);
      } else if (a === "--top") {
        flagArgs.push(a, args[i + 1]);
        i += 1;
      } else if (String(a).startsWith("--")) {
        flagArgs.push(a);
      } else {
        positional.push(a);
      }
    }
    return codeSearchCommand(positional.join(" "), parseFlags(flagArgs));
  },
  "code-context": (command, args) => {
    // Compact symbol view for specific file paths.
    // gov code-context <file1> [file2 ...] [--json]
    return codeContextCommand(
      args.filter(a => !String(a).startsWith("--")),
      parseFlags(args.filter(a => String(a).startsWith("--")))
    );
  },
  "code-diff": (command, args) => {
    // Compact views of files changed vs a git ref.
    // gov code-diff [<base-ref>] [--json]
    const baseRef = hasLeadingPositional(args) ? args[0] : null;
    const diffFlags = parseFlags(baseRef ? args.slice(1) : args);
    return codeDiffCommand(baseRef, diffFlags);
  },
  "tier": (command, args) => tierCommand(args[0]),
  "plan-waves": (command, args) => planWaves(parseFlags(args)),
  "sequencer-plan": (command, args) => sequencerPlan(parseFlags(args)),
  "merge-queue": (command, args) => mergeQueue(parseFlags(args)),
  "dispatch-plan": (command, args) => dispatchPlan(parseFlags(args)),
  "otlp-export": (command, args) => otlpExport(parseFlags(args)),
  "set-review-cycles": (command, args) => setReviewCyclesCommand(args[0], parseFlags(args.slice(1))),
  "backfill-plan-records": (command, args) => backfillPlanRecords(parseFlags(args)),
  "integration": (command, args) => require("./integration-commands.js").createIntegrationCommands({
    appendGovernanceEvent,
    runtimeDir: governanceState.RUNTIME_DIR,
  }).integrationCommand(args),
  "release-lock": (command, args) => releaseLock(args[0], parseFlags(args.slice(1))),
  "audit-worktrees": (command, args) => auditWorktrees(),
  // COORD-976: read-only architecture report; writes files only with --out; never files tickets.
  "audit-architecture": (command, args) => {
    const result = architectureAudit.run(args);
    if (result.code) process.exitCode = result.code;
    return result;
  },
  "cleanup-helpers": (command, args) => cleanupHelperWorktrees(args[0], parseFlags(args.slice(1))),
  "cleanup-worktree": (command, args) => cleanupWorktree(args[0], args[1], parseFlags(args.slice(2))),
  "clean-runtime": (command, args) => cleanRuntime(parseFlags(args)),
  "sync": (command, args) => runSyncCommand(parseFlags(args)),
  "publish-board": (command, args) => publishBoardState(parseFlags(args)),
  "runtime-lock-status": (command, args) => runtimeLockStatus(parseFlags(args)),
  "break-runtime-lock": (command, args) => breakRuntimeLock(parseFlags(args)),
  "gate": (command, args) => runCleanCheckoutGate(args[0], parseFlags(args.slice(1))),
  "retire-stale-drift-notes": (command, args) => retireStaleDriftNotes(parseFlags(args)),
  "quality-scan": (command, args) => {
    // COORD-083: thin passthrough to the standalone quality-scan CLI. Args
    // flow through verbatim (dry-run by default; --apply files governed
    // follow-ups via this same gov binary). Kept out of lifecycle.js: this
    // is an orchestration entrypoint, not a board-state mutation.
    const { spawnSync } = require("child_process");
    const scanCli = resolveEngineModule(ENGINE_COORD_DIR, "scripts/quality-scan.js");
    const res = spawnSync(process.execPath, [scanCli, ...args], { stdio: "inherit" });
    process.exitCode = res.status == null ? 1 : res.status;
    return;
  },
  "live-mcp-policy": (command, args) => runtimeEvidence.printPolicy(parseFlags(args)),
  "live-mcp-record": (command, args) => runtimeEvidence.liveMcpRecord(args[0], parseFlags(args.slice(1))),
  "bootstrap-record": (command, args) => runtimeEvidence.bootstrapRecord(args[0], parseFlags(args.slice(1))),
  "deploy-record": (command, args) => runtimeEvidence.deployRecord(args[0], parseFlags(args.slice(1))),
  "deploy-check": (command, args) => runtimeEvidence.deployCheck(optionalLeadingId(args), flagsAfterOptionalId(args)),
  "verify": (command, args) => runtimeEvidence.verifyRuntime(args[0], parseFlags(args.slice(1))),
  "falsify": (command, args) => runtimeEvidence.falsify(args[0], parseFlags(args.slice(1))),
  "validate-receipt": (command, args) => runtimeEvidence.validateReceiptCommand(parseFlags(args)),
  "surface": (command, args) => {
    // COORD-572: the GENERATED machine-facing surface — every dispatched verb,
    // the alias groups that make one capability findable under the name a
    // caller guesses, every accepted flag with the option key the live parser
    // produces, the enum literals the parser itself advertises, and the
    // snake_case/camelCase spellings of the JSON plan fields. Read-only.
    return printableSurface().printSurface(parseFlags(args));
  },
  "help": (command, args) => printHelp({ all: args.includes("--all") }),
});

// COORD-1021: spelling -> route, derived from the declaration. A Map, so a prototype-named
// spelling (constructor, __proto__) is unknown rather than a route.
const ROUTES = new Map(ROUTE_ROWS.map((row) => {
  const route = ROUTE_HANDLERS[row.handler];
  if (typeof route !== "function") throw new Error(`cli.js has no route for handler ${row.handler}`);
  return [row.spelling, route];
}));

// ROUTER (COORD-1021): the spelling is resolved through the declaration-derived ROUTES map; the --help,
// dry-run and integration-authority guards run before any route (see dispatchGovernedCommand).
function dispatchCommand(command, args = []) {
  // COORD-612: `gov <verb> --help` prints the verb's published usage instead of
  // being parsed as a positional/flag. Before this, `gov update-plan --help`
  // answered `Unknown ticket "--help"`, so the only place a flag could be
  // discovered was the ~200-line `gov help --all` dump — and `--context-pack-ack`
  // was in neither. An undiscoverable-but-required flag manufactures forbidden
  // hand-edits of governed plan state, so discoverability is a governance
  // property, not a cosmetic one. Intercepted here, before the router, because
  // `--help` is never a legal value for any governed verb.
  if (command && command !== "help" && (args.includes("--help") || args.includes("-h"))) {
    return printVerbHelp(command);
  }
  // COORD-922: --dry-run is honoured only by the verbs declared in
  // dry-run-policy.js; every other verb refuses it here, before any effect.
  require("./dry-run-policy.js").assertDryRunSupported(command, args, fail);
  if (command === undefined) return printHelp({ all: false });
  const route = ROUTES.get(command);
  if (route) return route(command, args);
  // COORD-572: a capability must be findable by the name a caller is LIKELY
  // TO GUESS. `add-prompt` was filed as a missing verb (COORD-511) while it
  // had already shipped as `register-prompt --create`; the refusal named no
  // near-match, so absence-from-the-name read as absence-from-the-product.
  // Suggestions are ranked by shared word-parts first, so a differently
  // prefixed synonym still resolves.
  fail(
    `Unknown command "${command}".` +
    formatSuggestions(require("./cli-surface.js").suggestVerbs(command)) +
    ` Run "node coord/scripts/governance.js help", or "coord/scripts/gov surface" for the generated verb/flag/enum inventory.`
  );
}

// COORD-731: parseFlags is global because several verbs share its vocabulary,
// but a parsed option is only valid when the selected handler consumes it.
// Derive update-plan's accepted keys from its live consumer so unsupported
// flags fail before ownership, journal, or plan mutation.
function rejectUnsupportedUpdatePlanOptions(options = {}) {
  const { PLAN_UPDATE_OPTION_KEYS, PLAN_UPDATE_PACKET_KEYS } = require("./plan-update-options.js");
  const accepted = new Set([...PLAN_UPDATE_OPTION_KEYS, ...PLAN_UPDATE_PACKET_KEYS]);
  const unsupported = Object.keys(options).filter((key) => !accepted.has(key));
  if (unsupported.length === 0) return;
  const flag = `--${unsupported[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  const suggestion = unsupported[0] === "verification" ? " Did you mean: --verify?" : "";
  fail(`update-plan does not accept ${flag}.${suggestion}`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  return dispatchGovernedCommand(command, args);
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
    let unexpectedError;
    try {
      const value = dispatchGovernedCommand(command, args);
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
      unexpectedError = error;
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
    throw unexpectedError;
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
  ...SHARED_VALUE_FLAGS,
  "--duplicate-of": "duplicateOf", "--distinct-from": "distinctFrom",
  "--expect": "expect",
  "--arch": "arch",
  "--disposition": "disposition",
  // COORD-718: record-independent-review.
  "--repository": "repository", "--review-key": "reviewKey", "--supersedes": "supersedes", "--corrects": "corrects",
  // COORD-860: record-managed-evidence technical exception names its gaps.
  "--gaps": "gaps",
  // COORD-557: set-context-pack-ack authoring flags.
  // COORD-572: bootstrap_risk and decision_required are schema-declared,
  // gate-READ plan fields whose only writer (applyPlanUpdateOptionsToRecord)
  // was unreachable — no flag token produced their option key, so the gates
  // could only advise "update the canonical plan record" by hand. Registered
  // here so the mechanism the advice names actually exists.
  "--prompt-template": "promptTemplate", "--template": "template",
  "--execution-id": "dispatchExecutionId",
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
  // --endpoint opt-in POSTs to an HTTPS OTLP endpoint (OFF by default).
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
  ...SHARED_APPEND_FLAGS,
  "--finding": "finding",
  "--meta": "meta",
});

const SCALAR_TEXT_FILE_FIELDS = SHARED_SCALAR_TEXT_FILE_FIELDS;

// Boolean flags: `--flag` -> parsed[key] = true.
const BOOL_FLAGS = Object.freeze({
  ...SHARED_BOOL_FLAGS,
  // COORD-667: opt in to the in-process control-plane workspace merge during a
  // Repo-X closeout. Default stays fail-closed per the COORD-512 ruling (never
  // auto-advance an adopter's live integration branch); this is the operator
  // asking for it, and it replaces the hand-run `git merge` that
  // pre-bash-guard.js refuses under head-on-protected-branch (COORD-664).
  "--repair-all": "repairAll",
  "--git": "git",
  "--show-template-feedback": "showTemplateFeedback",
  // COORD-894: `gov doctor --offline` skips the remote board-push rules check (reported as unknown).
  "--offline": "offline",
  "--allow-command-probes": "allowCommandProbes",
  "--sweep-staging": "sweepStaging",
  // COORD-905: dead-run recovery and lock staging report (dry-run unless --yes).
  "--recover-runs": "recoverRuns",
  "--with-prompt": "withPrompt", "--create": "create", "--replace": "replace",
  // ENT-005: explicit stdout sink for the OTLP exporter (also the default when
  // no sink flag is given).
  "--stdout": "stdout",
  "--allow-insecure-transport": "allowInsecureTransport",
  // ENT-001/COORD-696: opt-in push of durable journal/plans/snapshots to the
  // coord remote, including canonical commits stranded by an earlier terminal
  // attempt. NOT default; never force.
  // Env equivalent: COORD_PUSH_ON_FINALIZE=1.
  "--push-after-sync": "pushAfterSync",
  "--push-before-closeout": "pushBeforeCloseout",
  // ENT-010: `gov conform --attest` emits a signed conformance attestation over
  // the engine-integrity inputs (in addition to the journal chain self-verify).
  "--attest": "attest",
  // ENT-011: `gov verify-engine --pin` (re)pins the current engine surface
  // (manifest version + fingerprint + per-file snapshot) to coord/engine-pin.json.
  // Without it, `gov verify-engine` is a read-only drift check against the pin.
  "--pin": "pin",
  // COORD-958: `gov verify-engine --regenerate` is the one regenerate-and-verify step (re-stamp the manifest,
  // re-pin, verify both surfaces) for the cwd checkout; a ticket worktree must run its own copy.
  "--regenerate": "regenerate",
  // COORD-124: `gov repair-chain --confirm` applies the guarded chain repair
  // (with `--reason "<why>"`). Without it, repair-chain is a read-only dry-run.
  "--confirm": "confirm",
  // COORD-222: opt out of the fail-closed "one governed writer per
  // checkout/runtime" guard on `gov start` / `gov claim`. DEFAULT is fail-closed;
  // pass this only when deliberately running the documented orchestrator-spawns-
  // N-subagents topology (each sub-agent SHOULD still use a separate worktree).
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
// (parsed, arg, next). The shared parser advances past the value.
const commonFlagHandlers = createSharedSpecialFlags({ fail, requireValue, isLegalStatus, LEGAL_FINDING_STATUSES });
const SPECIAL_FLAGS = Object.freeze({
  "--status": commonFlagHandlers.status,
  "--base": commonFlagHandlers.base,
  "--reason": commonFlagHandlers.reason,
  "--note": commonFlagHandlers.note,
  "--selection-manifest": commonFlagHandlers.selectionManifest,
  "--result": commonFlagHandlers.result,
  "--base-result": commonFlagHandlers.baseResult,
  "--replace-review-cycle": commonFlagHandlers.replaceReviewCycle,
  "--drop-review-cycle": commonFlagHandlers.dropReviewCycle,
  "--severity": commonFlagHandlers.severity,
  // COORD-673: --depends-on/--parent are BOTH a plain value flag (dependsOn keeps
  // its last-wins shape for the single-parent consumers: open-followup,
  // file-ticket, split-ticket) AND repeatable (dependsOnAll accumulates every
  // occurrence). set-followup-relation reads dependsOnAll so passing the flag
  // twice records both edges instead of silently keeping only the last.
  "--depends-on": dependsOnFlag,
  "--parent": dependsOnFlag,
});

function dependsOnFlag(parsed, arg, next) {
  requireValue(arg, next);
  parsed.dependsOn = next;
  appendValue(parsed, "dependsOnAll", next);
  return true;
}

// COORD-972: argv parser for `gov sign-journal`, extracted unchanged from the
// dispatch case so its flags can be dry-checked (verb-flag-parity). Returns the
// subcommand and options that signJournalCommand receives.
function parseSignJournalArgs(args) {
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
    } else if (["--out", "--file", "--event", "--trust-anchor"].includes(a)) {
      requireValue(a, rest[i + 1]);
      const value = rest[++i];
      if (a === "--trust-anchor") opts.trustAnchor = [...(opts.trustAnchor || []), value];
      else opts[a.slice(2)] = value;
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
  return { sub, opts };
}

// COORD-905: `gov doctor --recover-runs`. Lists manifests of provably dead runners and
// lock staging dirs no live lock references, with age and remedy. Dry-run unless --yes.
function recoverRunsCommand(flags) {
  const runOwnership = require("./run-ownership.js");
  const coordDir = path.resolve(__dirname, "..", "..");
  const result = runOwnership.recoverRuns({
    dir: runOwnership.defaultRunsDir(coordDir),
    apply: flags.yes === true,
    stagingLocks: [
      { kind: "governance-runtime", path: governanceState.GOVERNANCE_EVENT_LOCK_DIR, staleMs: 60 * 1000 },
      { kind: "agent-state", path: governanceState.AGENT_STATE_LOCK_DIR, staleMs: 60 * 1000 },
      { kind: "coord-state", path: governanceState.COORD_STATE_LOCK_DIR, staleMs: 60 * 1000 },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function parseFlags(args) {
  return parseFlagTables(args, {
    valueFlags: VALUE_FLAGS, appendFlags: APPEND_FLAGS, boolFlags: BOOL_FLAGS,
    scalarTextFields: SCALAR_TEXT_FILE_FIELDS, specialFlags: SPECIAL_FLAGS,
    fail, requireValue, readUtf8TextFile,
    unknownSuffix: (arg) => formatSuggestions(suggestFlagsSafely(arg)),
  });
}

// COORD-572: " Did you mean: a, b?" — appended, never substituted, so every
// existing refusal keeps its exact leading sentence.
function formatSuggestions(candidates) {
  return candidates && candidates.length > 0 ? ` Did you mean: ${candidates.join(", ")}?` : "";
}

// The suggester reads cli.js's own tables; a failure to build them must never
// turn an ordinary "unknown flag" refusal into an internal error.
function suggestFlagsSafely(flag) {
  try {
    return require("./cli-surface.js").suggestFlags(flag);
  } catch {
    return [];
  }
}

function requireValue(flag, value) {
  if (!value) {
    fail(`${flag} requires a value.`);
  }
}

module.exports = {
  GovernanceError,
  main,
  executeCommand,
  __testing: {
    ...lifecycle.__testing,
    dispatchCommand,
    dispatchGovernedCommand,
    withTemporaryExecutionContext,
    parseFlags,
    runTerminalAliasVerb,
    // COORD-1021: the declaration-derived spelling -> route map, for the route-equality tests.
    ROUTES,
    ROUTE_HANDLERS,
    // COORD-984: effective flag tables, for the table-equivalence test.
    FLAG_TABLES: {
      VALUE_FLAGS,
      APPEND_FLAGS,
      SCALAR_TEXT_FILE_FIELDS,
      BOOL_FLAGS,
      SPECIAL_KEYS: Object.keys(SPECIAL_FLAGS),
    },
    parseSignJournalArgs,
    rejectUnsupportedUpdatePlanOptions,
    runTerminalLifecycle,
    recordLifecycleCostBoundary,
    // COORD-612: help text builders, so the flag-coverage guard asserts against
    // the same single source of truth the CLI prints.
    buildHelpText,
    buildVerbHelpText,
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

function runMain() {
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
if (require.main === module) runMain();
// COORD-873: the CLI shim at the legacy coord/scripts path re-dispatches this entry
// (same argv, same exit codes, same error handling).
module.exports.main = runMain;
