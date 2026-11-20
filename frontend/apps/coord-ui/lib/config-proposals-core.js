'use strict';

// Shared pure adapter for the UI proposal request and the governed CLI.
function proposalArgs({ target, value, baseDigest }) {
  return ['config', 'propose', '--target', target, '--base-digest', baseDigest, '--value-json', JSON.stringify(value)];
}

function parseProposalResult(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('config propose returned an unreadable response'); }
  if (!result || typeof result !== 'object' || typeof result.proposal_id !== 'string' || typeof result.target !== 'string' || typeof result.base_digest !== 'string' || !result.diff || result.refusal) {
    throw new Error(result?.refusal || 'config propose returned an invalid response');
  }
  return result;
}

function pendingProposals(events) {
  const terminal = new Set(events.filter((event) => ['config.applied', 'config.proposal_withdrawn'].includes(String(event.type))).map((event) => String(event.proposal_id)));
  return events.filter((event) => event.type === 'config.proposed' && !terminal.has(String(event.proposal_id))).map((event) => ({
    proposal_id: String(event.proposal_id), target: String(event.target), base_digest: String(event.base_digest),
    result_digest: String(event.result_digest), proposer: typeof event.proposer === 'string' ? event.proposer : null,
    created_at: String(event.created_at), diff: event.diff,
  }));
}

export { proposalArgs, parseProposalResult, pendingProposals };
