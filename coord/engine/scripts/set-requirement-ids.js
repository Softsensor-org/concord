"use strict";

const STAMP_FIELD = "Requirements Backfill Stamp";
const approvalVerifier = require("./approval-verifier.js");

function parseRequest(ticketId, options, fail, linkage) {
  if (!ticketId) fail("set-requirement-ids requires <ticket-id>.");
  const hasIds = options.ids !== undefined;
  if (Number(hasIds) + Number(options.clear === true) !== 1) {
    fail("set-requirement-ids requires exactly one of --ids <list> or --clear.");
  }
  const reason = String(options.reason || "").trim();
  if (!reason) fail("set-requirement-ids requires a nonblank --reason.");
  let ids = [];
  if (hasIds) {
    try { ids = linkage.parseExplicitRequirementIds(options.ids); }
    catch (error) { fail(`set-requirement-ids: ${error.message}`); }
    if (ids.length === 0) fail("set-requirement-ids --ids requires at least one id; use --clear for explicit none.");
  }
  return { ids, reason, clear: options.clear === true };
}

function resolveMetadataIdentity(ticketId, row, lock, options, deps) {
  const signed = options.humanAdminOverride !== undefined
    ? approvalVerifier.requireSignedOverride({ commandName: "set-requirement-ids", ticketId,
      row: { ticket: row, lock: lock || null, requested_ids: options.ids ?? null, clear: options.clear === true, reason: options.reason },
      options, deps: { resolveHumanAdminOverride: deps.resolveHumanAdminOverride, fail: deps.fail,
        appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir } })
    : null;
  const override = signed ? { reason: signed.reason, approval: signed.approval } : null;
  const identity = override || (row.Status === "todo" && row.Owner === "unassigned")
    ? deps.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false })
    : deps.assertTicketMutationOwnership(ticketId, row, lock);
  return { identity, overrideReason: override?.reason || null, approval: override?.approval || null };
}

function applyExplicitLinks(row, request, identity, overrideReason, approval, mutation, linkage) {
  const beforePresent = Object.prototype.hasOwnProperty.call(row, "Requirement IDs");
  const beforeRaw = beforePresent ? String(row["Requirement IDs"] || "") : null;
  const before = beforePresent ? linkage.splitList(beforeRaw).map((id) => id.toUpperCase()).sort() : null;
  const after = request.clear ? [] : request.ids;
  const afterRaw = request.clear ? "" : request.ids.join(", ");
  const beforeStampPresent = Object.prototype.hasOwnProperty.call(row, STAMP_FIELD);
  const beforeStamp = beforeStampPresent ? row[STAMP_FIELD] : null;

  if (beforePresent && !beforeStampPresent && JSON.stringify(before) === JSON.stringify(after)) {
    return { changed: false };
  }
  row["Requirement IDs"] = afterRaw;
  // An intentional write takes authorship from the migration, even when the
  // requested IDs equal its inferred values. A later revert must preserve it.
  if (beforeStampPresent) delete row[STAMP_FIELD];
  mutation.details = {
    reason: request.reason,
    actor: identity.agent.handle,
    human_admin_override: overrideReason,
    human_admin_session: approval?.session_id || null,
    approval_record: approval?.record_id || null,
    approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
    before_requirement_ids: before,
    after_requirement_ids: after,
    backfill_stamp_before: beforeStamp,
    backfill_stamp_was_present: beforeStampPresent,
    backfill_stamp_after: null,
  };
  return { changed: true, after };
}

// Explicit requirement links are board metadata, so write them through the
// existing governance mutation and board-lock primitives supplied by the CLI.
module.exports = function createSetRequirementIds(deps) {
  const {
    fail,
    withGovernanceMutation,
    withCoordStateLock,
    runBoardSync,
    readBoard,
    writeBoard,
    getTicketRef,
    ensureCurrentAgentIdentity,
    assertTicketMutationOwnership,
    resolveHumanAdminOverride,
    findLockForTicket,
  } = deps;
  const { resolveEngineModule } = require("../../paths.js");
  const linkage = require(resolveEngineModule(
    require("node:path").resolve(__dirname, "../.."),
    "engine-only:scripts/requirements-linkage.js"
  ));

  return function setRequirementIds(ticketId, options = {}) {
    const request = parseRequest(ticketId, options, fail, linkage);
    const mutation = { command: "set-requirement-ids", ticket: ticketId };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const row = ref.row;
      const { identity, overrideReason, approval } = resolveMetadataIdentity(
        ticketId, row, findLockForTicket(ticketId), options, {
          ensureCurrentAgentIdentity, assertTicketMutationOwnership, resolveHumanAdminOverride,
          fail, appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir,
        }
      );
      mutation.identity = identity;
      const update = applyExplicitLinks(row, request, identity, overrideReason, approval, mutation, linkage);
      if (!update.changed) {
        console.log(`${ticketId} already has the requested Requirement IDs; no change recorded.`);
        return update;
      }
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(request.clear
        ? `Cleared explicit Requirement IDs for ${ticketId}; description inference is suppressed.`
        : `Set Requirement IDs for ${ticketId}: ${update.after.join(", ")}.`);
      return update;
    });
  };
};
