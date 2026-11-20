"use strict";

const { gitTry } = require("./git-ops.js");
const { defaultControlPlaneLayout, resolveControlPlaneIntegrationBranch } = require("./control-plane-paths.js");

function resolveCommit(root, value) {
  const ref = String(value || "").trim();
  if (!ref) return null;
  const result = gitTry(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}
function isAncestor(root, sha, ref) {
  return gitTry(root, ["merge-base", "--is-ancestor", sha, ref]).status === 0;
}

// Resolve only explicit fulfillment selectors. A reviewed source or a commit
// mentioned in prose is never a substitute for a declared existing landing.
function resolveFulfillment(ticketId, board, row, options, evaluateLanding) {
  const ticket = String(options.fulfilledByTicket || "").trim();
  const explicit = String(options.fulfilledByCommit || "").trim();
  if (!ticket && !explicit) return null;
  const refuse = message => { throw new Error(`Ticket ${ticketId} fulfilled-by closeout refused: ${message}`); };
  if (ticket && explicit) refuse("choose one selector: --fulfilled-by-ticket or --fulfilled-by-commit.");
  if (row.Repo !== "X") refuse("this resolver requires a control-plane ticket.");
  let declared = explicit;
  if (ticket) {
    if (ticket === ticketId) refuse("a ticket cannot fulfill itself.");
    const target = (board.sections || []).flatMap(section => section.rows || []).find(entry => entry.ID === ticket);
    if (!target) refuse(`unknown fulfillment ticket ${ticket}; name an existing ticket with landing evidence.`);
    if (target.Repo !== row.Repo) refuse(`fulfillment ticket ${ticket} belongs to a different repository.`);
    const record = board.landing_index?.[ticket];
    declared = record?.fulfilled_by_commit_sha || record?.commit_sha;
    if (!declared) refuse(`ticket ${ticket} has no structured landing commit; use --fulfilled-by-commit with an independently verified existing implementation SHA.`);
  }
  const layout = options.layout || defaultControlPlaneLayout();
  const root = layout?.coordRepoRoot;
  if (!root) refuse("there is no control-plane repository in which to verify an existing implementation.");
  const commitSha = resolveCommit(root, declared);
  if (!commitSha) refuse(`commit ${declared} does not resolve in the control-plane repository.`);
  const base = resolveControlPlaneIntegrationBranch(layout, {
    base: options.base, configuredBranch: options.configuredBranch,
  });
  if (!isAncestor(root, commitSha, `refs/heads/${base}`)) refuse(`commit ${commitSha} is not an ancestor of local ${base}; land the implementation first.`);
  if (options.sourceCommit) {
    const source = resolveCommit(root, options.sourceCommit);
    if (!source || !isAncestor(root, source, commitSha)) refuse("the reviewed source commit must resolve and be an ancestor of the declared fulfillment commit.");
  }
  // This mode describes an already published implementation. It cannot turn
  // --push-before-closeout into publication of an otherwise unlanded claim.
  if (gitTry(root, ["remote", "get-url", "origin"]).status === 0) {
    const refresh = gitTry(root, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (refresh.status !== 0) refuse(`cannot verify the current origin/${base}; restore remote access and publish the integration branch before retrying.`);
  }
  const assessment = evaluateLanding(commitSha, { ...options, layout, configuredBranch: base, requireExistingLanding: true });
  if (assessment.reason === "no_control_plane_remote_branch") refuse(`the configured remote has no verifiable ${base} branch; publish through the normal governed landing path first.`);
  return Object.freeze({ commitSha, ticket: ticket || null, assessment });
}

module.exports = { resolveFulfillment };
