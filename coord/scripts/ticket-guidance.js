"use strict";

// Wave 4 slice 2 (COORD-086): the OPERATOR-GUIDANCE surface extracted from
// lifecycle.js — buildTicketNextCommands (the per-status "what should I run
// next" planner), explainTicket (the read-only ticket explanation report) and
// runTicketCycle (the recommended planner/worker/reviewer/closer cycle).
//
// These are operator-guidance behaviors, not lifecycle wiring: they only READ
// board / lock / plan / readiness state and emit guidance JSON; they never
// mutate governance state. Every cross-module primitive (board-state readers,
// readiness / blocker collectors, lock + identity helpers, provenance / queue /
// event helpers, the post-close follow-up command builder) is dependency-
// injected rather than re-implemented here, mirroring the prior Wave-2/3/4
// extraction discipline (doctor-report.js / doctor-recovery.js / landing-audit).
//
// STATUS and FINDING_STATUS are required directly from governance-constants so
// this module observes the SAME frozen status vocabulary lifecycle does.

const { defaultFail } = require("./governance-context.js");
const { STATUS, FINDING_STATUS } = require("./governance-constants.js");

module.exports = function createTicketGuidance(deps = {}) {
  const fail = deps.fail || defaultFail;

  const {
    // board-state readers
    readBoard,
    getTicketRef,
    rowsById,
    readPlanState,
    readTicketWaiver,
    // readiness / blocker collectors
    evaluateReadiness,
    collectStartReadinessBlockers,
    collectSubmitReadinessBlockers,
    deriveGovernanceReadiness,
    // status / repo predicates
    isDoingStatus,
    isRepoBackedCode,
    // locks + identity
    findLockForTicket,
    detectActiveSameOwnerOtherThread,
    resolveOwnerIdentity,
    // provenance / questions / events
    detectGovernanceProvenanceDrift,
    splitGovernanceProvenanceDrift,
    buildQuestionQueueReport,
    readActiveOrchestratorQuestionRows,
    buildExplainQuestionsGuidance,
    collectTicketGovernanceIssueEvents,
    findLatestTicketGovernanceEvent,
    summarizeGovernanceEvent,
    // follow-up command builder (shared; owned by lifecycle, injected back)
    buildPostCloseFollowupCommand,
    // misc
    shellEscape,
  } = deps;

  function buildTicketNextCommands({ board, row, ticketId, lock, provenanceDrift, startBlockers = [], submitBlockers = [] }) {
    const commands = [];
    if (splitGovernanceProvenanceDrift(provenanceDrift).blocking.length > 0) {
      commands.push("coord/scripts/gov doctor");
    }

    if (row.Status === STATUS.TODO || row.Status === STATUS.DEFERRED) {
      if (startBlockers.length > 0) {
        for (const blocker of startBlockers) {
          for (const step of blocker.next_steps || []) {
            if (!commands.includes(step)) {
              commands.push(step);
            }
          }
        }
      } else {
        commands.push(`coord/scripts/gov start ${ticketId}`);
      }
      return commands;
    }

    if (isDoingStatus(row.Status)) {
      if (!lock) {
        commands.push(`coord/scripts/gov recover ${ticketId}`);
        return commands;
      }
      if (submitBlockers.length > 0) {
        for (const blocker of submitBlockers) {
          for (const step of blocker.next_steps || []) {
            if (!commands.includes(step)) {
              commands.push(step);
            }
          }
        }
        return commands;
      }
      commands.push(`coord/scripts/gov heartbeat ${ticketId}`);
      if (isRepoBackedCode(row.Repo)) {
        commands.push(`coord/scripts/gov commit ${ticketId} --message "<message>"`);
      }
      const existingPrRefs = board.pr_index?.[ticketId] || [];
      if (row.Repo === "X" && existingPrRefs.length === 0) {
        commands.push(`coord/scripts/gov submit ${ticketId} --pr "local-review (no PR)"`);
      } else {
        commands.push(`coord/scripts/gov submit ${ticketId}`);
      }
      return commands;
    }

    if (row.Status === STATUS.REVIEW) {
      const findings = board.review_findings?.[ticketId] || [];
      const openFindings = findings.filter((finding) => finding.status === FINDING_STATUS.OPEN);
      if (openFindings.length > 0) {
        commands.push(`coord/scripts/gov repair ${ticketId} --summary "<summary>" --severity MED --qref Lxx`);
        return commands;
      }
      const prRefs = board.pr_index?.[ticketId] || [];
      const hasNoPrEvidence = prRefs.some((entry) => /\(no PR\)/.test(String(entry)));
      if (prRefs.length === 0) {
        commands.push(`coord/scripts/gov set-pr ${ticketId} --pr "local-review (no PR)"`);
        return commands;
      }
      if (hasNoPrEvidence) {
        commands.push(`coord/scripts/gov finalize ${ticketId} --no-pr --landed "<landing-evidence>"`);
        return commands;
      }
      if (!isRepoBackedCode(row.Repo)) {
        // COORD-055: repo-X (coord / cross-repo, e.g. TRUST-style) tickets can carry
        // PR evidence but have no repo to merge into, so `land` -> prMerge fails for
        // non-repo-backed codes — a dead-end. The governed closeout is a PR-backed
        // finalize: it records the PR evidence and marks the ticket done without a
        // GitHub merge or board hand-edits.
        const prUrl = prRefs.find((entry) => /^https?:\/\//.test(String(entry))) || prRefs[0];
        commands.push(`coord/scripts/gov finalize ${ticketId} --pr "${prUrl}"`);
        return commands;
      }
      commands.push(`coord/scripts/gov land ${ticketId}`);
      return commands;
    }

    if (row.Status === STATUS.DONE) {
      commands.push(buildPostCloseFollowupCommand(ticketId, row));
      return commands;
    }

    return commands;
  }

  function explainTicket(ticketId) {
    if (!ticketId) {
      fail("explain requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    const lock = findLockForTicket(ticketId);
    const readiness = evaluateReadiness(ref.row, rowsById(board), board);
    const findings = board.review_findings?.[ticketId] || [];
    const prRefs = board.pr_index?.[ticketId] || [];
    const landing = board.landing_index?.[ticketId] || null;
    const latestEvent = findLatestTicketGovernanceEvent(ticketId);
    const provenance = detectGovernanceProvenanceDrift();
    const provenanceIssues = splitGovernanceProvenanceDrift(provenance.drift);
    const queueDebt = buildQuestionQueueReport(readActiveOrchestratorQuestionRows());
    const startBlockers = collectStartReadinessBlockers(ticketId, ref.row, board);
    const submitBlockers = collectSubmitReadinessBlockers(ticketId, ref.row, board, lock);
    const questionsGuidance = buildExplainQuestionsGuidance({
      ticketId,
      startBlockers,
      submitBlockers,
      provenanceDrift: provenanceIssues.blocking,
      recentIssueEvents: collectTicketGovernanceIssueEvents(ticketId),
    });
    const governanceReadiness = deriveGovernanceReadiness(ticketId, ref.row, board, lock, readPlanState(ticketId), questionsGuidance);

    console.log(JSON.stringify({
      ticket: ref.row,
      readiness,
      prompt: board.prompt_index?.[ticketId] || null,
      waiver: readTicketWaiver(board, ticketId),
      lock,
      active_same_owner_other_thread: detectActiveSameOwnerOtherThread(ticketId, lock),
      pr_refs: prRefs,
      landing,
      findings,
      latest_event: summarizeGovernanceEvent(latestEvent),
      governance_drift: provenanceIssues.blocking,
      governance_warnings: {
        provenance_drift: provenanceIssues.warnings,
      },
      queue_debt: {
        total: queueDebt.total,
        by_type: queueDebt.by_type,
        by_severity: queueDebt.by_severity,
        by_aging: queueDebt.by_aging,
        oldest: queueDebt.oldest,
      },
      start_readiness: {
        ready: startBlockers.length === 0,
        blockers: startBlockers,
      },
      submit_readiness: {
        ready: submitBlockers.length === 0,
        blockers: submitBlockers,
      },
      governance_readiness: governanceReadiness,
      questions_guidance: questionsGuidance,
      next_commands: buildTicketNextCommands({
        board,
        row: ref.row,
        ticketId,
        lock,
        provenanceDrift: provenanceIssues.blocking,
        startBlockers,
        submitBlockers,
      }),
    }, null, 2));
  }

  function runTicketCycle(ticketId, options) {
    if (!ticketId) {
      fail("run-ticket-cycle requires <ticket-id>.");
    }
    const identity = resolveOwnerIdentity(options.owner, { allowAutoClaim: false, touchSession: false });
    const owner = identity.agent.handle;

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    const lock = findLockForTicket(ticketId);
    const prompt = board.prompt_index?.[ticketId] || null;
    const prRefs = board.pr_index?.[ticketId] || [];
    const landing = board.landing_index?.[ticketId] || null;
    const findings = board.review_findings?.[ticketId] || [];
    const openFindings = findings.filter((finding) => finding.status === FINDING_STATUS.OPEN);
    const planExists = Boolean(readPlanState(ticketId));

    const steps = [];

    if (ref.row.Status === STATUS.TODO || ref.row.Status === STATUS.DEFERRED) {
      steps.push({
        phase: "planner",
        command: `coord/scripts/gov start-ticket ${ticketId} --owner ${owner}${options.topic ? ` --topic ${shellEscape(options.topic)}` : ""}${options.base ? ` --base ${shellEscape(options.base)}` : ""}`,
        purpose: identity.autoClaimed
          ? `Create worktree/lock, move ticket to doing, and ensure a PLAN stub exists. Auto-assigned owner=${owner} (${identity.agent.id}).`
          : "Create worktree/lock, move ticket to doing, and ensure a PLAN stub exists.",
      });
    } else if (ref.row.Status === STATUS.DOING) {
      steps.push({
        phase: "planner",
        command: "(already started)",
        purpose: `Ticket is already doing under owner=${ref.row.Owner}; active lock=${lock ? "yes" : "no"}.`,
      });
    } else if (ref.row.Status === STATUS.REVIEW) {
      steps.push({
        phase: "planner",
        command: "(review state already active)",
        purpose: `Ticket is already in review; PR refs=${prRefs.length}.`,
      });
    } else if (ref.row.Status === STATUS.DONE) {
      steps.push({
        phase: "planner",
        command: buildPostCloseFollowupCommand(ticketId, ref.row),
        purpose: "Closed tickets stay closed; create a follow-up ticket for any post-close finding.",
      });
    }

    steps.push({
      phase: "worker",
      command: lock
        ? `coord/scripts/gov heartbeat ${ticketId}`
        : `coord/scripts/gov ticket ${ticketId}`,
      purpose: planExists
        ? "Maintain heartbeat while implementing and use update-plan/log-question as needed."
        : "Inspect ticket and add a plan stub before implementation work.",
    });

    steps.push({
      phase: "reviewer",
      command: openFindings.length > 0
        ? `coord/scripts/gov update-finding ${ticketId} --id ${openFindings[0].id} --status resolved`
        : `coord/scripts/gov add-finding ${ticketId} --severity MED --summary "<review finding>" --qref Lxx`,
      purpose: "Record review findings in review_findings instead of freehand notes.",
    });

    steps.push({
      phase: "closer",
      command: ref.row.Status === STATUS.DOING
        ? `coord/scripts/gov move-review ${ticketId} --pr "local-review (no PR)"`
        : ref.row.Status === STATUS.REVIEW
          ? `coord/scripts/gov mark-done ${ticketId} --landed "<merged-sha-or-no-pr-closeout-evidence>"`
          : `coord/scripts/gov set-pr ${ticketId} --pr "<pr-or-no-pr-evidence>"`,
      purpose: "Advance the lifecycle through the governed transitions only after gates pass.",
    });

    console.log(JSON.stringify({
      ticket: ref.row,
      prompt,
      plan_exists: planExists,
      lock,
      pr_refs: prRefs,
      landing,
      open_findings: openFindings,
      recommended_cycle: steps,
    }, null, 2));
  }

  return {
    buildTicketNextCommands,
    explainTicket,
    runTicketCycle,
  };
};
