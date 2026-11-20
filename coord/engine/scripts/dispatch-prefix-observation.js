"use strict";

// Prefix-use reports are observations, never provider attestation or approval.
function createPrefixUseReporter(deps) {
  const { fail, ensureCurrentAgentIdentity, withGovernanceMutation, readBoard, getTicketRef } = deps;
  const PREFIX_USE_EVENT_TYPE = "dispatch.prefix_used";

  function reportPrefixUse(ticketId, options = {}) {
    if (!ticketId) fail("report-prefix-use requires <ticket-id>.");
    const expectedPrefixHash = String(options.expectedPrefixHash || "").trim().toLowerCase();
    const usedPrefixHash = String(options.usedPrefixHash || "").trim().toLowerCase();
    const hashPattern = /^[a-f0-9]{64}$/;
    if (!hashPattern.test(expectedPrefixHash)) fail("--expected-prefix-hash requires a 64-character SHA-256 hex digest.");
    if (!hashPattern.test(usedPrefixHash)) fail("--used-prefix-hash requires a 64-character SHA-256 hex digest.");
    const status = expectedPrefixHash === usedPrefixHash ? "match" : "mismatch";
    let identity = null;
    try {
      identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch {
      identity = null;
    }
    const prefixUse = {
      expected_prefix_hash: expectedPrefixHash,
      used_prefix_hash: usedPrefixHash,
      status,
      observation_only: true,
    };
    const mutation = {
      command: "report-prefix-use",
      ticket: ticketId,
      allowProvenanceDrift: true,
      forceLog: true,
      identity,
      details: { event_type: PREFIX_USE_EVENT_TYPE, prefix_use: prefixUse },
    };
    return withGovernanceMutation(mutation, () => {
      if (!getTicketRef(readBoard(), ticketId)) fail(`Unknown ticket "${ticketId}".`);
      const payload = {
        event_type: PREFIX_USE_EVENT_TYPE,
        ticket: ticketId,
        reported_by: identity?.agent?.handle || null,
        ...prefixUse,
      };
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    });
  }

  return reportPrefixUse;
}

module.exports = { createPrefixUseReporter };
