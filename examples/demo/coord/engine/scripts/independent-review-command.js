"use strict";

// COORD-718: `gov record-independent-review <ticket>` — the governed writer for
// independent review evidence. The reviewer is the bound, registered session
// running the command; it never claims, locks, re-owns or edits the board row
// of the reviewed ticket. The record lands in the ticket's plan record through
// the canonical plan writer inside one governed mutation (runtime mutex,
// rollback, journal), so concurrent reviewers serialize and a refused write
// leaves no bytes behind.

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const { DEFAULT_PATHS } = require("./governance-context.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const reviews = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/independent-reviews.js"));

// --finding is repeatable (array); --findings takes a comma list (string).
function toList(value) {
  return [value ?? []].flat().flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

module.exports = function createIndependentReviewCommand(deps = {}) {
  const {
    fail,
    readBoard,
    getTicketRef,
    readPlanState,
    updateCanonicalPlanState,
    withGovernanceMutation,
    inferTicketStatus,
    ensureCurrentAgentIdentity,
    context = DEFAULT_PATHS,
    controlPlaneLayout = () => require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js")).defaultControlPlaneLayout(),
    gitCommitExists = (root, commit) => spawnSync("git", ["-C", root, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" }).status === 0,
  } = deps;

  function repositoryRoot(repository) {
    if (repository === "coord") return controlPlaneLayout().coordRepoRoot;
    const code = Object.keys(context.repoRegistry).find((candidate) => context.repoRegistry[candidate] === repository);
    return code ? context.repoRoots[code] : null;
  }

  // guard:independent-review-record
  function assertReviewedCommitExists(repository, commit) {
    const root = repositoryRoot(repository);
    if (!root) fail(`record-independent-review cannot resolve repository "${repository}"; use coord or a configured repo name.`);
    if (!gitCommitExists(root, commit)) {
      fail(`record-independent-review: commit ${commit} does not exist in ${repository}; review an immutable commit that the repository contains.`);
    }
  }

  function bindReviewer(ticketId) {
    let identity;
    try {
      identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch (error) {
      fail(`record-independent-review requires a bound reviewer session: ${error.message}`);
    }
    const agent = identity.agent;
    if (agent.status !== "active") fail(`record-independent-review: reviewer ${agent.handle} is not an active registered agent.`);
    const ref = getTicketRef(readBoard(), ticketId);
    if (!ref) fail(`record-independent-review: unknown ticket ${ticketId}.`);
    const owner = reviews.reviewOwnerOf(ref.row.Owner);
    if (owner === agent.handle) {
      fail(`record-independent-review: ${agent.handle} owns ${ticketId}; an owner's review is self-review (use --review-cycle).`);
    }
    return { identity, row: ref.row, owner };
  }

  function buildReview(ticketId, bound, options) {
    const { identity, row, owner } = bound;
    try {
      return reviews.buildIndependentReview({
        ticketId,
        reviewer: {
          handle: identity.agent.handle,
          agent_id: identity.agent.id,
          session_id: identity.session.session_id,
          thread_id: identity.session.thread_id,
        },
        ownerAtReview: owner,
        repository: options.repository || reviews.repositoryForRepoCode(row.Repo, context.repoRegistry),
        commit: options.commit,
        method: options.method,
        findings: [...toList(options.finding), ...toList(options.findings)],
        verdict: options.verdict,
        summary: options.summary,
        reviewKey: options.reviewKey,
        supersedes: options.supersedes,
        corrects: options.corrects,
        reason: options.reason,
      });
    } catch (error) {
      return fail(`record-independent-review: ${error.message}`);
    }
  }

  function recordIndependentReviewCommand(ticketId, options = {}) {
    if (!ticketId) fail("record-independent-review requires <ticket-id>.");
    if (options.owner !== undefined || options.humanAdminOverride !== undefined) {
      fail("record-independent-review takes no --owner or --human-admin-override; the bound session is the reviewer.");
    }
    const plan = readPlanState(ticketId);
    if (!plan) fail(`record-independent-review requires an existing plan record for ${ticketId}.`);
    const review = buildReview(ticketId, bindReviewer(ticketId), options);
    assertReviewedCommitExists(review.repository, review.commit);
    // Identical retry is decided from the plan record before any mutation
    // opens, so it never journals; a conflicting id is refused below.
    if (reviews.isIdenticalIndependentReview(plan, review)) {
      console.log(JSON.stringify({ status: "unchanged", ticket: ticketId, review_id: review.id }, null, 2));
      return undefined;
    }
    const reviewer = review.reviewer;
    // The retry identity excludes time, session evidence and owner snapshot.
    const intent = { ...review, timestamp: undefined, owner_at_review: undefined, reviewer: reviewer.handle };
    const mutation = {
      command: "record-independent-review",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("record-independent-review", ticketId, intent),
    };
    return withGovernanceMutation(mutation, () => {
      const bound = bindReviewer(ticketId);
      if (bound.identity.agent.handle !== reviewer.handle) fail("record-independent-review: reviewer identity changed during the write.");
      mutation.identity = bound.identity;
      let result;
      try {
        result = updateCanonicalPlanState(ticketId, {
          independentReview: { [reviews.INDEPENDENT_REVIEW_WRITE]: true, review: { ...review, owner_at_review: bound.owner } },
        });
      } catch (error) {
        fail(`record-independent-review: ${error.message}`);
      }
      const stored = result.record.independent_reviews?.find((entry) => entry.id === review.id);
      if (!stored) fail("record-independent-review: the canonical plan writer did not keep the review.");
      mutation.details = { review_id: stored.id, reviewer: stored.reviewer.handle, repository: stored.repository, commit: stored.commit, verdict: stored.verdict };
      console.log(JSON.stringify({ status: "recorded", ticket: ticketId, review: stored }, null, 2));
      return result;
    });
  }

  return { recordIndependentReviewCommand };
};
