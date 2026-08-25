"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const createPrOps = require("./pr-ops.js");
const { GovernanceError } = require("./governance-context.js");
const { __testing, withGovernedSurfaceSandbox } = require("./governance-test-utils.js");

function build(overrides = {}) {
  const row = { ID: "B-697", Repo: "B", Status: "doing" };
  const board = { pr_index: {}, sections: [{ rows: [row] }] };
  const calls = [];
  const effects = [];
  let listCalls = 0;
  const deps = {
    fail: (message) => { throw new GovernanceError(message); },
    assertCommittedReviewState: () => calls.push("committed"),
    assertReviewPlanReady: () => calls.push("review-plan"),
    ensureDoingTicketLockIntegrity: () => ({ branch: "agent/codexa680-b-697", worktree: "/tmp/review-worktree" }),
    ensureTicketMutationOwnership: () => ({}),
    evaluateReadiness: () => ({ blockedBy: [], blockerChains: [], cycles: [] }),
    formatDependencyCycleList: () => "",
    formatTransitiveBlockerDetails: () => "",
    getRepoRoot: () => "/tmp/repo",
    getTicketRef: () => ({ row }),
    ghPrListByBranch: () => { listCalls += 1; return []; },
    ghPrView: () => ({}),
    inferTicketStatus: () => "doing",
    isGitHubPrUrl: (value) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(String(value || "")),
    isRepoBackedCode: () => true,
    mergePrUrl: () => ({}),
    mergeUniqueRefs: (existing, additions) => [...new Set([...(existing || []), ...(additions || [])])],
    preflightPrBranch: (_root, _branch, _base, options) => {
      calls.push("branch-preflight");
      if (options.push) {
        const receipt = {
          status: "pushed", attempted: true, acknowledged: true, pushed: true,
          remote_moved: true, forced: false, remote: "origin", remote_ref: "origin/agent/codexa680-b-697",
          commit_sha: "abc", remote_sha_before: null, remote_sha_after: "abc",
        };
        options.onPushReceipt(receipt);
        return { localAhead: 1, pushReceipt: receipt };
      }
      return { localAhead: 1, pushReceipt: null };
    },
    readBoard: () => board,
    recordGovernanceExternalSideEffect: (effect) => { effects.push(effect); calls.push(`effect:${effect.type}:${effect.status}`); },
    resolvePrUrlForTicket: () => null,
    resolveTicketGitContext: () => ({ branch: "agent/codexa680-b-697", repoRoot: "/tmp/repo" }),
    rowsById: () => new Map([[row.ID, row]]),
    runBoardSync: () => calls.push("board-sync"),
    runGh: () => { calls.push("pr-create"); return "https://github.com/acme/repo/pull/697"; },
    withGovernanceMutation: (_mutation, fn) => fn(),
    writeBoard: () => calls.push("board-write"),
    ...overrides,
  };
  return {
    ops: createPrOps(deps), board, calls, effects,
    listCalls: () => listCalls,
  };
}

// pr-ops functions shell out to gh/git and mutate governed state, so they are
// exercised end-to-end via the governance suite. Here we assert the factory
// contract: it instantiates from injected deps and exposes the PR surface.
test("createPrOps returns the PR operation surface", () => {
  const w = build().ops;
  assert.equal(typeof w.prView, "function");
  assert.equal(typeof w.prCreate, "function");
  assert.equal(typeof w.prMerge, "function");
});

test("COORD-697: createPrOps fails closed on incomplete production wiring", () => {
  assert.throws(
    () => createPrOps({}),
    (error) => error instanceof GovernanceError && error.code === "governance_factory_dependency_missing",
  );
});

test("COORD-697: pr-ops dependency contract exhaustively classifies its destructured wiring", () => {
  const source = fs.readFileSync(require.resolve("./pr-ops.js"), "utf8");
  const destructured = source.match(/\n  const \{\n([\s\S]*?)\n  \} = deps;/);
  assert.ok(destructured, "pr-ops must keep one explicit deps destructure");
  const names = destructured[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(names, [...createPrOps.DEP_CONTRACT.callable].sort());
});

test("COORD-697: every classified pr-ops dependency is refused by name when omitted", () => {
  const complete = Object.fromEntries(createPrOps.DEP_CONTRACT.callable.map((name) => [name, () => {}]));
  for (const name of createPrOps.DEP_CONTRACT.callable) {
    assert.throws(
      () => createPrOps({ ...complete, [name]: undefined }),
      (error) => error instanceof GovernanceError && error.missing_callable.includes(name),
      name,
    );
  }
});

test("COORD-697: required PR arguments fail before branch publication", () => {
  const { ops, calls, effects } = build();
  assert.throws(
    () => ops.prCreate("B-697", { push: true }),
    /requires either --fill or both --title/,
  );
  assert.deepEqual(calls, ["review-plan"]);
  assert.deepEqual(effects, []);
});

test("COORD-697: direct pr-create checks ticket dependencies before branch publication", () => {
  const { ops, calls, effects } = build({
    evaluateReadiness: () => ({ blockedBy: ["B-1"], blockerChains: [], cycles: [] }),
  });
  assert.throws(
    () => ops.prCreate("B-697", { push: true, fill: true }),
    /unmet dependencies: B-1/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(effects, []);
});

test("COORD-697: push and PR receipts precede a fallible local board write", () => {
  const { ops, calls, effects } = build({
    writeBoard: () => { throw new Error("local board write failed"); },
  });
  assert.throws(
    () => ops.prCreate("B-697", { push: true, fill: true }),
    /local board write failed/,
  );
  assert.deepEqual(calls, [
    "review-plan",
    "committed",
    "branch-preflight",
    "effect:git_branch_push:pushed",
    "pr-create",
    "effect:github_pr_create:created",
  ]);
  assert.equal(effects[0].delivered, true);
  assert.equal(effects[1].pr_url, "https://github.com/acme/repo/pull/697");
});

test("COORD-697: retry adopts one existing provider PR without creating a duplicate", () => {
  const existing = {
    url: "https://github.com/acme/repo/pull/697",
    state: "OPEN",
    headRefName: "agent/codexa680-b-697",
    baseRefName: "dev",
  };
  const { ops, board, calls, effects } = build({
    ghPrListByBranch: () => [existing],
    runGh: () => { throw new Error("must not create a second PR"); },
  });
  ops.prCreate("B-697", { push: true, fill: true, base: "dev" });
  assert.deepEqual(board.pr_index["B-697"], [existing.url]);
  assert.equal(calls.includes("pr-create"), false);
  assert.equal(effects.at(-1).status, "already_present");
  assert.equal(effects.at(-1).attempted, false);
});

test("COORD-697: lost PR-create acknowledgement is reconciled from provider state", () => {
  const existing = {
    url: "https://github.com/acme/repo/pull/698",
    state: "OPEN",
    headRefName: "agent/codexa680-b-697",
    baseRefName: "dev",
  };
  let queries = 0;
  const { ops, board, effects } = build({
    ghPrListByBranch: () => {
      queries += 1;
      return queries === 1 ? [] : [existing];
    },
    runGh: () => { throw new Error("connection closed after create"); },
  });
  ops.prCreate("B-697", { push: true, fill: true, base: "dev" });
  assert.deepEqual(board.pr_index["B-697"], [existing.url]);
  const receipt = effects.find((effect) => effect.type === "github_pr_create");
  assert.equal(receipt.status, "created_ack_lost");
  assert.equal(receipt.acknowledged, false);
  assert.equal(receipt.delivered, true);
  assert.match(receipt.detail, /provider state confirms/);
});

test("COORD-697: an unconfirmed PR-create attempt is recorded as ambiguous, not rolled back", () => {
  const { ops, effects } = build({
    runGh: () => { throw new Error("provider timeout"); },
  });
  assert.throws(
    () => ops.prCreate("B-697", { push: true, fill: true }),
    /provider timeout/,
  );
  const receipt = effects.find((effect) => effect.type === "github_pr_create");
  assert.equal(receipt.status, "ambiguous");
  assert.equal(receipt.attempted, true);
  assert.equal(receipt.acknowledged, false);
  assert.equal(Object.hasOwn(receipt, "delivered"), false);
});

test("COORD-697: a post-create local failure durably journals both external receipts", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    __testing.ensureGovernanceJournalBaseline("coord697-pr-receipt-test");
    const { ops } = build({
      withGovernanceMutation: (...args) => __testing.withGovernanceMutation(...args),
      recordGovernanceExternalSideEffect: (...args) => __testing.recordGovernanceExternalSideEffect(...args),
      writeBoard: () => { throw new Error("local board write failed"); },
    });
    assert.throws(
      () => ops.prCreate("B-697", { push: true, fill: true }),
      /external side effects already occurred/,
    );
    const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    const failed = events.findLast((event) => event.command === "pr-create" && event.result === "failed");
    assert.ok(failed, "failed pr-create event must survive rollback");
    assert.deepEqual(
      failed.details.external_side_effects.map((effect) => effect.type),
      ["git_branch_push", "github_pr_create"],
    );
    assert.equal(failed.details.external_side_effects[1].pr_url, "https://github.com/acme/repo/pull/697");
    assert.equal(failed.details.rollback.status, "restored");
  });
});
