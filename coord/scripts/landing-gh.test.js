"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing } = require("./governance-test-utils.js");

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in landing-gh.js — the gh/PR helper layer:
// transient-error classification + retry (isTransientGhError / ghPrView),
// merged-PR ref affiliation (refsContainMergedPrForTicket), and the
// post-merge benign-failure tolerance (shouldIgnoreMergeFailureAfterSuccessfulMerge).
// Exercised through the fully-wired `__testing` facade.


test("shouldIgnoreMergeFailureAfterSuccessfulMerge only tolerates checked-out branch deletion failures after merge", () => {
  const message = "failed to delete local branch agent/codexa00-imp-240: failed to run git: error: cannot delete branch 'agent/codexa00-imp-240' used by worktree at '/tmp/worktree'";
  const mergedPayload = {
    state: "MERGED",
    mergedAt: "2026-03-29T11:42:18Z",
  };

  assert.equal(
    __testing.shouldIgnoreMergeFailureAfterSuccessfulMerge(message, mergedPayload, { deleteBranch: true }),
    true
  );
  assert.equal(
    __testing.shouldIgnoreMergeFailureAfterSuccessfulMerge(message, mergedPayload, { deleteBranch: false }),
    false
  );
  assert.equal(
    __testing.shouldIgnoreMergeFailureAfterSuccessfulMerge(
      "gh pr merge failed for conflict",
      mergedPayload,
      { deleteBranch: true }
    ),
    false
  );
  assert.equal(
    __testing.shouldIgnoreMergeFailureAfterSuccessfulMerge(
      message,
      { state: "OPEN", mergedAt: null },
      { deleteBranch: true }
    ),
    false
  );
});

test("refsContainMergedPrForTicket only accepts merged PR evidence affiliated with the same ticket", () => {
  assert.equal(
    __testing.refsContainMergedPrForTicket(
      "IMP-241",
      ["https://github.com/example-org/project-backend/pull/47"],
      () => ({
        state: "MERGED",
        mergedAt: "2026-03-27T04:29:21Z",
        headRefName: "agent/claudea12-imp-241-hold-time-enforcement-track-elapsed-hold",
      })
    ),
    true
  );
  assert.equal(
    __testing.refsContainMergedPrForTicket(
      "IMP-241",
      ["https://github.com/example-org/project-backend/pull/56"],
      () => ({
        state: "MERGED",
        mergedAt: "2026-03-29T01:44:29Z",
        headRefName: "agent/codexa04-imp-237-auto-deviation-on-fail-validation-when-a",
      })
    ),
    false
  );
});

test("isTransientGhError recognizes throttle/auth/5xx classes and ignores benign messages", () => {
  assert.equal(__testing.isTransientGhError("HTTP 401: Requires authentication"), true);
  assert.equal(__testing.isTransientGhError("You have exceeded a secondary rate limit"), true);
  assert.equal(__testing.isTransientGhError("HTTP 502 Bad Gateway"), true);
  assert.equal(__testing.isTransientGhError("GraphQL: something throttled"), true);
  assert.equal(__testing.isTransientGhError("could not resolve to a PullRequest"), false);
  assert.equal(__testing.isTransientGhError(""), false);
});

test("ghPrView retries a transient 401 then succeeds (stubbed gh, no real sleep)", () => {
  const url = "https://github.com/acme/widget/pull/7";
  const merged = { number: 7, url, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" };
  const sleeps = [];
  __testing.setSleepSyncForTesting((ms) => { sleeps.push(ms); });
  let calls = 0;
  __testing.setRunGhForTesting((cwd, args) => {
    calls += 1;
    assert.deepEqual(args.slice(0, 3), ["pr", "view", url], "must invoke gh pr view <url>");
    if (calls === 1) {
      throw new Error("HTTP 401: Requires authentication (https://api.github.com/graphql)");
    }
    return JSON.stringify(merged);
  });
  try {
    const payload = __testing.ghPrView(url);
    assert.equal(calls, 2, "ghPrView must retry exactly once after the transient 401");
    assert.deepEqual(payload, merged);
    assert.deepEqual(sleeps, [1500], "one backoff sleep (1500ms * attempt 1) before the retry");
  } finally {
    __testing.resetRunGhForTesting();
    __testing.resetSleepSyncForTesting();
  }
});
