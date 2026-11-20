"use strict";

// COORD-820: the governed correction path for a recorded finding severity.
// Human-admin policy (QUESTIONS.md row 810 point 4, reconfirmed 2026-10-14):
// "the owner or a reviewer may raise a severity, lowering requires approval by
// a different identity, prior values stay in history."
//   - RAISING stands on the requester's own authority when the bound session is
//     the ticket's board Owner, or a RECORDED REVIEWER of the ticket. Until
//     COORD-718 adds a governed reviewer role, a recorded reviewer is a bound
//     handle other than the Owner that the engine itself recorded as the
//     `added_by` author of a finding under this ticket (add-finding stamps it
//     from the bound session; it is never a flag). Anyone else needs the
//     human-admin override.
//   - LOWERING always requires approval by an identity other than the
//     requester. Today that is the human-admin override.
//   - The prior value is never overwritten without a trace: every correction
//     appends to finding.severity_history (from, to, actor, time, reason,
//     approval), the first correction pins finding.original_severity when an
//     older finding lacks it, and the change is journaled as an attributed
//     event. A refusal writes nothing.
// The actor always comes from the bound governed session, never from a flag.
const OPTION_KEYS = new Set(["id", "severity", "reason", "humanAdminOverride"]);
const HUMAN_ADMIN_APPROVER = "human-admin";
const approvalVerifier = require("./approval-verifier.js");

// Argument checks run before the governed transaction opens.
function parseRequest(ticketId, options, fail, ordered) {
  if (typeof ticketId !== "string" || !/^[A-Z]+-\d+$/.test(ticketId)) {
    fail("correct-finding-severity requires an existing <ticket-id>.");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(`correct-finding-severity does not accept option "${key}".`);
  }
  if (!options.id) fail("correct-finding-severity requires --id <finding-id>.");
  // The vocabulary runs most to least severe, so a smaller index is more severe.
  const afterRank = ordered.indexOf(options.severity);
  if (afterRank < 0) fail(`correct-finding-severity requires --severity <${ordered.join("|")}>.`);
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (!reason) fail("correct-finding-severity requires a nonblank --reason.");
  return { afterRank, reason };
}

// The raise authority the requester holds on their own, or null. A recorded
// reviewer is a non-owner handle the engine stamped as a finding's author.
function raiseAuthority({ actor, owner, findings }) {
  if (actor === owner) return "owner";
  return findings.some((entry) => entry && entry.added_by === actor) ? "reviewer" : null;
}

// The policy decision. Only an owner or recorded-reviewer raise stands on the
// requester's own authority; everything else names the missing approval.
function approvalRefusal({ direction, actor, owner, authority, findingId, before, after }) {
  if (direction === "raise" && authority) return null;
  if (direction === "raise") {
    return `Only the ticket owner (${owner}) or a recorded reviewer of the ticket may raise ${findingId}; ${actor} is ` +
      `neither (a recorded reviewer is a non-owner session the engine recorded as the author of a finding on this ` +
      `ticket). Any other raise needs --human-admin-override "<approval>" carrying the human admin's decision.`;
  }
  return `Lowering ${findingId} from ${before} to ${after} requires approval by an identity other than ` +
    `the requester (${actor}). Pass --human-admin-override "<approval>" carrying the human ` +
    `admin's decision. Independent-reviewer approval is not yet a governed record (COORD-718).`;
}

module.exports = function createCorrectFindingSeverity(deps) {
  const {
    fail, withGovernanceMutation, withCoordStateLock, readBoard, writeBoard,
    runBoardSync, getTicketRef, ensureCurrentAgentIdentity, resolveHumanAdminOverride,
    inferTicketStatus, ORDERED_FINDING_SEVERITIES,
  } = deps;

  return function correctFindingSeverity(ticketId, options = {}) {
    const { afterRank, reason } = parseRequest(ticketId, options, fail, ORDERED_FINDING_SEVERITIES);
    const mutation = {
      command: "correct-finding-severity",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      preserveAgentState: true,
    };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const identity = ensureCurrentAgentIdentity({ readOnly: true });
      mutation.identity = identity;
      const findings = board.review_findings[ticketId] || [];
      const finding = findings.find((entry) => entry.id === options.id);
      if (!finding) fail(`Finding ${options.id} does not exist under ${ticketId}.`);
      const before = finding.severity;
      if (before === options.severity) {
        fail(`Finding ${options.id} is already recorded as ${before}; nothing to correct.`);
      }
      const direction = afterRank < ORDERED_FINDING_SEVERITIES.indexOf(before) ? "raise" : "lower";
      const actor = identity.agent.handle;
      const authority = raiseAuthority({ actor, owner: ref.row.Owner, findings });
      const refusal = approvalRefusal({
        direction, actor, owner: ref.row.Owner, authority, findingId: options.id, before, after: options.severity,
      });
      // guard:finding-correction-authority
      if (refusal && options.humanAdminOverride === undefined) fail(refusal);
      let approval = null;
      if (options.humanAdminOverride !== undefined) {
        const verified = approvalVerifier.requireSignedOverride({ commandName: "correct-finding-severity", ticketId,
          row: { ticket: ref.row, finding: { ...finding }, before, after: options.severity, direction, actor, reason },
          options, deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir } });
        approval = { kind: "human-admin-override", approver: HUMAN_ADMIN_APPROVER, reason: verified.reason,
          session_id: verified.approval.session_id, record_id: verified.approval.record_id, key_id: verified.approval.key_id,
          subject_sha256: verified.approval.subject_sha256 };
      }
      const entry = { from: before, to: options.severity, direction, actor, at: new Date().toISOString(), reason, approval };
      mutation.details = {
        finding_id: options.id,
        before_severity: before,
        after_severity: options.severity,
        direction,
        actor,
        ticket_owner: ref.row.Owner,
        raise_authority: direction === "raise" ? authority : null,
        reason,
        approval,
        approval_record: approval?.record_id || null,
        approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
        approval_subject_sha256: approval?.subject_sha256 || null,
      };
      withCoordStateLock(() => {
        // Legacy findings predate original_severity: pin it on first correction.
        if (finding.original_severity === undefined) finding.original_severity = before;
        finding.severity = options.severity;
        finding.severity_history = [...(finding.severity_history || []), entry];
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(
        `Corrected ${options.id} on ${ticketId}: severity ${before} -> ${options.severity} (${direction}) by ` +
        `${actor}${approval ? `; approved by ${approval.approver}: ${approval.reason}` : ""}.`
      );
      return { ticket: ticketId, finding: options.id, before, after: options.severity, direction };
    });
  };
};

module.exports.__testing = { approvalRefusal, parseRequest, raiseAuthority };
