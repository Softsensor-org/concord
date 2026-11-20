"use strict";

// COORD-860: `gov record-managed-evidence <ticket>` — the governed writer for
// managed-auto execution evidence. It reconciles the ticket's local action
// ledger, its digest-bound declared policy, the worktree's Git state and the
// plan's declared files, then records ONLY the redacted summary in the plan
// record and the same summary in the journal event, inside one governed
// mutation (runtime mutex, rollback, journal). With --human-admin-override,
// --reason, --risk and --gaps it records a technical exception bound to that
// exact summary; the exception never changes the summary verdict and is not a
// legal waiver. Ordinary unmanaged tickets are refused and stay unmanaged.

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const { state: defaultState } = require("./governance-context.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const { isSensitiveText, secretValuesFromEnvironment } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/managed-auto-ledger.js"));
const { managedEvidencePaths } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/managed-auto-runner.js"));
const reconcile = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/managed-auto-reconcile.js"));
const record = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/managed-execution-record.js"));
const approvalVerifier = require("./approval-verifier.js");

function toList(value) {
  return [value ?? []].flat().flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

module.exports = function createManagedEvidenceCommand(deps = {}) {
  const {
    fail,
    readBoard,
    getTicketRef,
    readPlanState,
    updateCanonicalPlanState,
    withGovernanceMutation,
    inferTicketStatus,
    ensureCurrentAgentIdentity,
    ensureTicketMutationOwnership,
    resolveHumanAdminOverride,
    state = defaultState,
  } = deps;

  function buildException(ticketId, summary, options) {
    const approval = resolveHumanAdminOverride("record-managed-evidence technical exception", options, { allowLegacyForce: false }).reason;
    const reason = String(options.reason || "").trim();
    const residualRisk = String(options.risk || "").trim();
    if (!reason || !residualRisk) fail("record-managed-evidence: a technical exception requires --reason and --risk (the residual-risk statement).");
    if (summary.verdict === "complete") fail(`record-managed-evidence: ${ticketId} evidence is complete; there is nothing to except.`);
    const named = [...summary.gaps, ...summary.unexplained].sort();
    const gaps = [...new Set(toList(options.gaps))].sort();
    if (gaps.join(",") !== named.join(",")) {
      fail(`record-managed-evidence: --gaps must name exactly the current gaps and unexplained effects: ${named.join(",")}`);
    }
    const secrets = secretValuesFromEnvironment(process.env);
    if ([approval, reason, residualRisk].some((text) => isSensitiveText(text, secrets) || text.length > 500)) {
      fail("record-managed-evidence: exception text must be at most 500 characters and carry no secret or credential shape.");
    }
    return {
      schema: "coord.managed-execution-exception/v1", summary_digest: summary.summary_digest, chain_root: summary.chain_root, gaps,
      reason, residual_risk: residualRisk, approval, actor: null, recorded_at: null, legal_waiver: false,
    };
  }

  function bindActor(ticketId, exceptionRequested) {
    const ref = getTicketRef(readBoard(), ticketId);
    if (!ref) fail(`record-managed-evidence: unknown ticket ${ticketId}.`);
    // The owner records a computed summary; an exception is a human-admin act
    // recorded under the bound session that ran it.
    const identity = exceptionRequested
      ? ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false })
      : ensureTicketMutationOwnership(ticketId, ref.row, null, {});
    return identity;
  }

  function sameException(left, right) {
    const strip = (value) => value && JSON.stringify({
      ...value, actor: null, recorded_at: null, approval_record: null, approval_key_id: null,
      approval_subject_sha256: null, human_admin_session: null,
    });
    return strip(left) === strip(right);
  }

  function recordManagedEvidenceCommand(ticketId, options = {}) {
    if (!ticketId) fail("record-managed-evidence requires <ticket-id>.");
    const plan = readPlanState(ticketId);
    if (!plan) fail(`record-managed-evidence requires an existing plan record for ${ticketId}.`);
    const files = managedEvidencePaths(state.RUNTIME_DIR, ticketId);
    if (!reconcile.isManagedTicket(files, plan.managed_execution)) {
      fail(`record-managed-evidence: ${ticketId} has no managed-auto session or policy; it stays unmanaged and keeps its existing gates.`);
    }
    const reconcileNow = (current) => reconcile.reconcileManagedExecution({
      ticketId, runtimeDir: state.RUNTIME_DIR, baseCommit: options.base, declaredFiles: current.intended_files || [],
    });
    const { summary, diagnostics } = reconcileNow(plan);
    const exceptionRequested = [options.humanAdminOverride, options.reason, options.risk, options.gaps].some((value) => value !== undefined);
    const exception = exceptionRequested ? buildException(ticketId, summary, options) : null;
    const report = (status) => console.log(JSON.stringify({ status, ticket: ticketId, summary, exception, diagnostics, claim_limit: reconcile.CLAIM_LIMIT }, null, 2));
    if (options.dryRun) return report("dry-run");
    const existing = plan.managed_execution;
    if (existing && existing.summary.summary_digest === summary.summary_digest && (!exception || sameException(existing.exception, exception))) {
      return report("unchanged");
    }
    const mutation = {
      command: "record-managed-evidence",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      // The prior recorded digest is part of the intent, so a later return to
      // an earlier summary is a new write rather than a replay of the old one.
      idempotencyKey: stableIdempotencyKey("record-managed-evidence", ticketId, {
        previous: existing ? existing.summary.summary_digest : null, summary: summary.summary_digest, exception: exception && { ...exception, actor: null },
      }),
    };
    return withGovernanceMutation(mutation, () => {
      const identity = bindActor(ticketId, exceptionRequested);
      // Re-reconcile under the governance mutex: a ledger append, Git change or
      // scope edit between the first read and this write refuses the write.
      if (reconcileNow(readPlanState(ticketId)).summary.summary_digest !== summary.summary_digest) {
        fail("record-managed-evidence: the managed evidence changed during the write; nothing was recorded. Run it again.");
      }
      mutation.identity = identity;
      const actor = identity.agent.handle;
      const now = new Date().toISOString();
      const kept = existing && existing.summary.summary_digest === summary.summary_digest ? existing.exception : null;
      let approval = null;
      const value = {
        summary,
        exception: exception ? { ...exception, actor, recorded_at: now } : kept,
        recorded_at: now,
        actor,
      };
      if (exception) {
        approval = approvalVerifier.requireSignedOverride({
          commandName: "record-managed-evidence technical exception", ticketId,
          row: { summary, exception: { summary_digest: exception.summary_digest, chain_root: exception.chain_root,
            gaps: exception.gaps, reason: exception.reason, residual_risk: exception.residual_risk } },
          options, deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent: deps.appendGovernanceEvent,
            runtimeDir: state.RUNTIME_DIR },
        }).approval;
      }
      try {
        updateCanonicalPlanState(ticketId, { managedExecution: { [record.MANAGED_EXECUTION_WRITE]: true, value } });
      } catch (error) {
        fail(`record-managed-evidence: ${error.message}`);
      }
      // The journal carries the same redacted projection, anchored to the chain root.
      mutation.details = { summary, exception: value.exception,
        approval_record: approval?.record_id || null, approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
        approval_subject_sha256: approval?.subject_sha256 || null, human_admin_session: approval?.session_id || null };
      report("recorded");
      return value;
    });
  }

  return { recordManagedEvidenceCommand };
};
