"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const createPrOps = require("./pr-ops.js");
const { GovernanceError } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const { __testing, withGovernedSurfaceSandbox } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));

function build(overrides = {}) {
  const row = { ID: "B-697", Repo: "B", Status: "doing" };
  const board = { pr_index: {}, sections: [{ rows: [row] }] };
  const calls = [];
  const effects = [];
  let listCalls = 0;
  const deps = {
    fail: (message) => { throw new GovernanceError(message); },
    assertCommittedReviewState: () => calls.push("committed"),
    assertTicketFence: () => {},
    decisionFenceForTicket: () => ({ status: "legacy-absent" }),
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
        if (options.beforePush) options.beforePush();
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
  const destructured = [...source.matchAll(/\n  const \{([\s\S]*?)\} = resolvedDeps;/g)];
  assert.equal(destructured.length, 1, "pr-ops must keep one explicit resolved-deps destructure");
  const names = destructured[0][1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(names, [...createPrOps.DEP_CONTRACT.callable].sort());
});

test("COORD-697: required pr-ops wiring refuses when omitted and ticket fences use canonical defaults", () => {
  const complete = Object.fromEntries(createPrOps.DEP_CONTRACT.callable.map((name) => [name, () => {}]));
  for (const name of createPrOps.DEP_CONTRACT.callable) {
    if (["assertTicketFence", "decisionFenceForTicket"].includes(name)) {
      const defaults = { ...complete };
      delete defaults[name];
      assert.doesNotThrow(() => createPrOps(defaults), `${name} resolves to integration-authority's implementation`);
      assert.throws(
        () => createPrOps({ ...complete, [name]: null }),
        (error) => error instanceof GovernanceError && error.missing_callable.includes(name),
        `${name} rejects an explicit non-function override`,
      );
      continue;
    }
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
    assertTicketFence: (ticket) => calls.push(`fence:${ticket}`),
    decisionFenceForTicket: (ticket) => ({ status: "captured", ticket, token: "T@0:abc" }),
  });
  assert.throws(
    () => ops.prCreate("B-697", { push: true, fill: true }),
    /local board write failed/,
  );
  assert.deepEqual(calls, [
    "review-plan",
    "committed",
    "branch-preflight",
    "fence:B-697",
    "effect:git_branch_push:pushed",
    "fence:B-697",
    "pr-create",
    "effect:github_pr_create:created",
  ]);
  assert.equal(effects[0].delivered, true);
  assert.equal(effects[1].pr_url, "https://github.com/acme/repo/pull/697");
});

test("COORD-1047: a stale PR-create fence escapes lost-ack reconciliation before provider creation", () => {
  const { ops, calls, effects, listCalls } = build({
    assertTicketFence: () => { calls.push("fence-refused"); throw new GovernanceError("stale attempt fence"); },
  });
  assert.throws(() => ops.prCreate("B-697", { fill: true }), /stale attempt fence/);
  assert.deepEqual(calls, ["review-plan", "committed", "branch-preflight", "fence-refused"]);
  assert.equal(listCalls(), 1, "the stale fence is not caught and reconciled as a lost create acknowledgement");
  assert.equal(effects.some((effect) => effect.type === "github_pr_create"), false);
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

test("COORD-921: a re-submit that finds no open PR refuses to create one", () => {
  const refused = build({
    ghPrListByBranch: () => [],
    runGh: () => { throw new Error("must not create a PR on the re-submit path"); },
  });
  assert.throws(
    () => refused.ops.prCreate("B-697", { push: true, fill: true, base: "dev", requireExistingPr: true }),
    /refusing to create one while re-submitting/,
  );
  assert.equal(refused.calls.includes("pr-create"), false);
  assert.equal(refused.effects.length, 0, "nothing is published or recorded when the PR is not found");

  const existing = { url: "https://github.com/acme/repo/pull/697", state: "OPEN", headRefName: "agent/codexa680-b-697", baseRefName: "dev" };
  const reused = build({ ghPrListByBranch: () => [existing], runGh: () => { throw new Error("must not create a second PR"); } });
  reused.ops.prCreate("B-697", { push: true, fill: true, base: "dev", requireExistingPr: true });
  assert.deepEqual(reused.board.pr_index["B-697"], [existing.url]);
  assert.equal(reused.calls.includes("pr-create"), false);
});

test("COORD-1052: unreadable initial provider inventory refuses before branch publication", () => {
  const { ops, board, calls, effects } = build({ ghPrListByBranch: () => { throw new Error("fixture provider unavailable"); } });
  const before = JSON.stringify(board);
  assert.throws(() => ops.prCreate("B-697", { push: true, fill: true }), /fixture provider unavailable/);
  assert.equal(JSON.stringify(board), before);
  assert.equal(calls.includes("branch-preflight"), false);
  assert.equal(calls.includes("pr-create"), false);
  assert.deepEqual(effects, []);
});

test("COORD-1052: non-reusable provider evidence refuses without creating a replacement PR", () => {
  const valid = { url: "https://github.com/acme/repo/pull/697", state: "OPEN", headRefName: "agent/codexa680-b-697", baseRefName: "dev" };
  for (const entry of [null, { ...valid, url: "not a PR" }, { ...valid, headRefName: "another-branch" },
    { ...valid, baseRefName: "another-base" }, { ...valid, state: "CLOSED" }]) {
    const { ops, board, calls, effects } = build({ ghPrListByBranch: () => [entry] });
    const before = JSON.stringify(board);
    assert.throws(() => ops.prCreate("B-697", { push: true, fill: true, base: "dev" }), /non-reusable PR/);
    assert.equal(JSON.stringify(board), before);
    assert.equal(calls.includes("branch-preflight"), false);
    assert.equal(calls.includes("pr-create"), false);
    assert.deepEqual(effects, []);
  }
});

test("COORD-1052: invalid create acknowledgement plus failed reconciliation retains ambiguous delivery evidence", () => {
  for (const acknowledgement of [undefined, "provider returned incomplete output"]) {
    let queries = 0;
    const { ops, board, calls, effects } = build({
      ghPrListByBranch: () => {
        if (++queries === 1) return [];
        throw new Error("fixture reconciliation unavailable");
      },
      runGh: () => acknowledgement,
    });
    const before = JSON.stringify(board);
    assert.throws(() => ops.prCreate("B-697", { push: true, fill: true }), /invalid PR URL/);
    assert.equal(queries, 2);
    assert.equal(JSON.stringify(board), before);
    assert.equal(calls.includes("board-write"), false);
    assert.equal(calls.includes("board-sync"), false);
    const push = effects.find((effect) => effect.type === "git_branch_push");
    assert.ok(push, "retain the prior external push receipt even when PR delivery is unknown");
    const receipt = effects.find((effect) => effect.type === "github_pr_create");
    assert.equal(receipt.status, "ambiguous");
    assert.equal(receipt.attempted, true);
    assert.equal(receipt.acknowledged, false);
    assert.equal(Object.hasOwn(receipt, "delivered"), false);
    assert.match(receipt.detail, /invalid PR URL/);
    assert.match(receipt.detail, /provider reconciliation also failed: fixture reconciliation unavailable/);
  }
});


test("COORD-1052: PR eligibility refusals preserve board state before provider publication", () => {
  const cases = [
    { ticket: "", overrides: {}, expected: /requires <ticket-id>/ },
    { overrides: { getTicketRef: () => null }, expected: /Unknown ticket/ },
    { overrides: { isRepoBackedCode: () => false }, expected: /only supported for repo-backed tickets/ },
    { overrides: { getTicketRef: () => ({ row: { ID: "B-697", Repo: "B", Status: "review" } }) }, expected: /must be doing/ },
    { overrides: { ensureDoingTicketLockIntegrity: () => ({ worktree: "/tmp/review-worktree" }) }, expected: /no branch recorded/ },
  ];
  for (const scenario of cases) {
    const { ops, board, calls, effects } = build({
      ...scenario.overrides,
      ghPrListByBranch: () => assert.fail("ineligible tickets must not query provider PRs"),
    });
    const before = JSON.stringify(board);
    assert.throws(() => ops.prCreate(scenario.ticket ?? "B-697", { push: true, fill: true }), scenario.expected);
    assert.equal(JSON.stringify(board), before);
    assert.equal(calls.includes("branch-preflight"), false);
    assert.equal(calls.includes("board-write"), false);
    assert.equal(calls.includes("pr-create"), false);
    assert.deepEqual(effects, []);
  }
});

test("COORD-1052: multiple reusable provider PRs refuse without choosing or publishing one", () => {
  const prs = [697, 698].map((id) => ({ url: `https://github.com/acme/repo/pull/${id}`,
    state: "OPEN", headRefName: "agent/codexa680-b-697", baseRefName: "dev" }));
  const { ops, board, calls, effects } = build({ ghPrListByBranch: () => prs });
  const before = JSON.stringify(board);
  assert.throws(() => ops.prCreate("B-697", { push: true, fill: true, base: "dev" }), /multiple reusable PRs/);
  assert.equal(JSON.stringify(board), before);
  assert.equal(calls.includes("branch-preflight"), false);
  assert.equal(calls.includes("pr-create"), false);
  assert.deepEqual(effects, []);
});

test("PR preflight uses the repository for a legacy lock without a worktree and retains the push outcome", () => {
  const branch = "agent/fixture-legacy-lock";
  const { ops, effects, board } = build({
    ensureDoingTicketLockIntegrity: () => ({ branch }),
    preflightPrBranch: (root, head, base, options) => {
      assert.equal(options.pushCwd, root);
      assert.equal(head, branch);
      assert.equal(base, "dev");
      options.beforePush();
      const pushReceipt = {
        attempted: true, acknowledged: false, pushed: true, remote_moved: true,
        ack_lost: true, status: "pushed", detail: "confirmed by remote lookup",
      };
      options.onPushReceipt(pushReceipt);
      return { localAhead: 1, pushReceipt };
    },
  });
  ops.prCreate("B-697", { fill: true, push: true, base: "dev" });
  assert.deepEqual(board.pr_index["B-697"], ["https://github.com/acme/repo/pull/697"]);
  const receipt = effects.find(effect => effect.type === "git_branch_push");
  assert.equal(receipt.remote, "origin");
  assert.equal(receipt.worktree, null);
  assert.equal(receipt.remote_ref, null);
  assert.equal(receipt.commit_sha, null);
  assert.equal(receipt.ack_lost, true);
  assert.equal(receipt.acknowledged, false);
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.detail, "confirmed by remote lookup");
});

test("PR view requires a subject and refuses unknown ticket IDs without querying the provider", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { ops } = build({
    getTicketRef: () => null,
    ghPrView: () => assert.fail("unexpected provider view"),
    ghPrListByBranch: () => assert.fail("unexpected provider list"),
  });
  assert.throws(() => ops.prView("", {}), /pr-view requires <ticket-id\|pr-url>/);
  assert.throws(() => ops.prView("B-unknown", {}), /Unknown ticket "B-unknown"/);
  assert.equal(log.mock.callCount(), 0);
});

test("PR view resolves direct URLs and indexed ticket URLs without listing the branch", (t) => {
  const direct = "https://github.com/acme/repo/pull/1";
  const indexed = "https://github.com/acme/repo/pull/2";
  const legacyRef = "agent/legacy-ref";
  const viewed = [];
  const listed = [];
  const log = t.mock.method(console, "log", () => {});
  const { ops, board } = build({
    isRepoBackedCode: (repo) => repo !== "X",
    ghPrListByBranch: (root, branch) => {
      listed.push([root, branch]);
      return [{ url: indexed }];
    },
    ghPrView: (url) => {
      viewed.push(url);
      return { url, state: "OPEN" };
    },
  });

  ops.prView(direct, {});
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), { url: direct, state: "OPEN" });

  const row = board.sections[0].rows[0];
  row.Repo = "X";
  board.pr_index["B-697"] = [legacyRef, indexed];
  ops.prView("B-697", {});
  assert.deepEqual(JSON.parse(log.mock.calls[1].arguments[0]), {
    ticket: row,
    branch: "agent/codexa680-b-697",
    repo_root: null,
    pr_refs: [legacyRef, indexed],
    prs: [{ url: indexed, state: "OPEN" }],
  });
  assert.deepEqual(viewed, [direct, indexed]);
  assert.deepEqual(listed, []);

  row.Repo = "B";
  delete board.pr_index;
  ops.prView("B-697", { branch: "agent/override" });
  assert.deepEqual(listed, [["/tmp/repo", "agent/override"]]);
  assert.deepEqual(JSON.parse(log.mock.calls[2].arguments[0]).prs, [{ url: indexed }]);
});

test("PR creation defaults the integration base and journals only attempted branch pushes", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const branch = "agent/fixture";
  const { ops, board, effects } = build({
    ensureDoingTicketLockIntegrity: () => ({ branch }),
    preflightPrBranch: (_root, head, base, options) => {
      assert.equal(head, branch);
      assert.equal(base, "dev");
      options.onPushReceipt({ attempted: false });
      options.onPushReceipt({ attempted: true, pushed: true });
      return { localAhead: 1 };
    },
    runGh: (_root, argv) => {
      assert.deepEqual(argv, ["pr", "create", "--head", branch, "--base", "dev", "--fill"]);
      return "https://github.com/acme/repo/pull/697";
    },
  });
  // The factory fixture accepts this repo, which has no per-repo base configured.
  board.sections[0].rows[0].Repo = "Z";
  ops.prCreate("B-697", { fill: true });
  assert.deepEqual(effects.map(({ type, status }) => [type, status]), [
    ["git_branch_push", "unknown"], ["github_pr_create", "created"],
  ]);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).branch_push, null);
});
