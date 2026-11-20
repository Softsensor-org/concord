"use strict";

// Metadata correction preserves lifecycle evidence and never rewrites prompts.
const MAX_DESCRIPTION_BYTES = 4 * 1024 * 1024;
const OPTION_KEYS = new Set(["description", "pri", "reason", "humanAdminOverride"]);
const approvalVerifier = require("./approval-verifier.js");

module.exports = function createAmendTicket(deps) {
  const {
    fail, ALLOWED_PRIORITIES, withGovernanceMutation, withCoordStateLock,
    readBoard, writeBoard, runBoardSync, getTicketRef,
    ensureCurrentAgentIdentity, assertTicketMutationOwnership, findLockForTicket,
  } = deps;

  return function amendTicket(ticketId, options = {}) {
    if (typeof ticketId !== "string" || !/^[A-Z]+-\d+$/.test(ticketId)) {
      fail("amend-ticket requires an existing <ticket-id>.");
    }
    for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.has(key)) fail(`amend-ticket does not accept option "${key}".`);
    }
    const hasDescription = Object.hasOwn(options, "description");
    const hasPriority = Object.hasOwn(options, "pri");
    if (!hasDescription && !hasPriority) fail("amend-ticket requires --description or --pri.");
    if (typeof options.reason !== "string" || !options.reason.trim()) {
      fail("amend-ticket requires a nonblank --reason.");
    }
    if (hasDescription && (typeof options.description !== "string" ||
        !options.description.trim() || Buffer.byteLength(options.description, "utf8") > MAX_DESCRIPTION_BYTES)) {
      fail("amend-ticket --description must be nonblank text of at most 4 MiB UTF-8.");
    }
    const priority = hasPriority && typeof options.pri === "string" ? options.pri.trim().toUpperCase() : null;
    if (hasPriority && !ALLOWED_PRIORITIES.includes(priority)) {
      fail(`amend-ticket --pri must be one of ${ALLOWED_PRIORITIES.join(", ")}.`);
    }
    const override = options.humanAdminOverride;
    if (override !== undefined && (typeof override !== "string" || !override.trim())) {
      fail("amend-ticket --human-admin-override requires a nonblank approval reason.");
    }
    const mutation = { command: "amend-ticket", ticket: ticketId, preserveAgentState: true };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const row = ref.row;
      mutation.beforeStatus = row.Status;
      mutation.identity = override || (row.Status === "todo" && row.Owner === "unassigned")
        ? ensureCurrentAgentIdentity({ readOnly: true })
        : assertTicketMutationOwnership(ticketId, row, findLockForTicket(ticketId), { readOnly: true });
      const before = { Description: row.Description, Pri: row.Pri };
      const after = {
        Description: hasDescription ? options.description : row.Description,
        Pri: hasPriority ? priority : row.Pri,
      };
      const fields = Object.keys(before).filter(key => before[key] !== after[key]);
      if (!fields.length) {
        console.log(`Ticket ${ticketId} unchanged.`);
        return { ticket: ticketId, changed: false };
      }
      const approval = override ? approvalVerifier.requireSignedOverride({
        commandName: "amend-ticket", ticketId,
        row: { ticket: row, before, after, reason: options.reason }, options,
        deps: { resolveHumanAdminOverride: deps.resolveHumanAdminOverride, fail,
          appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir },
      }).approval : null;
      mutation.details = {
        reason: options.reason, human_admin_override: override || null,
        human_admin_session: approval?.session_id || null,
        approval_record: approval?.record_id || null,
        approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
        before, after, changed_fields: fields,
      };
      withCoordStateLock(() => {
        for (const key of fields) row[key] = after[key];
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Amended ${ticketId}: ${fields.join(", ")}.`);
      return { ticket: ticketId, changed: true, fields };
    });
  };
};
