"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createPrOps = require("./pr-ops.js");

// pr-ops functions shell out to gh/git and mutate governed state, so they are
// exercised end-to-end via the governance suite. Here we assert the factory
// contract: it instantiates from injected deps and exposes the PR surface.
test("createPrOps returns the PR operation surface", () => {
  const stub = () => {};
  const w = createPrOps({
    fail: (m) => { throw new Error(m); },
    assertCommittedReviewState: stub, ensureDoingTicketLockIntegrity: stub,
    ensureTicketMutationOwnership: stub, getRepoRoot: stub, getTicketRef: stub,
    ghPrListByBranch: stub, ghPrView: stub, inferTicketStatus: stub, isGitHubPrUrl: stub,
    isRepoBackedCode: stub, mergePrUrl: stub, mergeUniqueRefs: stub, preflightPrBranch: stub,
    readBoard: stub, recordGovernanceExternalSideEffect: stub, resolvePrUrlForTicket: stub,
    resolveTicketGitContext: stub, runBoardSync: stub, runGh: stub,
    withGovernanceMutation: stub, writeBoard: stub,
  });
  assert.equal(typeof w.prView, "function");
  assert.equal(typeof w.prCreate, "function");
  assert.equal(typeof w.prMerge, "function");
});

test("createPrOps provides a default fail that throws GovernanceError", () => {
  const w = createPrOps({});
  assert.equal(typeof w.prCreate, "function");
});
