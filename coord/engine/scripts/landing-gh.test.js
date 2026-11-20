"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const { __testing } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const landingGh = require("./landing-gh.js");
const { ROOT_DIR } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));

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

// COORD-1013: a ticket id inside another ticket's governed slug does not affiliate the PR.
test("COORD-1013: a merged PR for COORD-908 is not affiliated through another ticket's slug", () => {
  const merged = (headRefName) => () => ({ state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", headRefName });
  const url = "https://github.com/example-org/project-backend/pull/71";
  assert.equal(__testing.refsContainMergedPrForTicket("COORD-908", [url], merged("agent/h1-coord-908-x")), true);
  assert.equal(
    __testing.refsContainMergedPrForTicket("COORD-908", [url], merged("agent/h2-coord-1012-found-by-the-coord-908-y")),
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
    assert.equal(args[3], "--json");
    assert.match(args[4], /(?:^|,)headRefOid(?:,|$)/, "the immutable PR head OID must be requested");
    assert.match(args[4], /(?:^|,)mergeCommit(?:,|$)/, "the GitHub merge object must remain requested");
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

test("ghPrView stops after six transient failures and throws the sixth error", () => {
  const errors = Array.from({ length: 6 }, (_, index) => new Error(`HTTP 503 attempt ${index + 1}`));
  const sleeps = [];
  let calls = 0;
  __testing.setSleepSyncForTesting((ms) => { sleeps.push(ms); });
  __testing.setRunGhForTesting(() => { throw errors[calls++]; });
  try {
    assert.throws(() => __testing.ghPrView("https://github.com/acme/widget/pull/14"), (error) => error === errors[5]);
    assert.equal(calls, 6, "transient failures stop at the configured attempt limit");
    assert.deepEqual(sleeps, [1500, 3000, 4500, 6000, 7500], "there is no delay after the final attempt");
  } finally {
    __testing.resetRunGhForTesting();
    __testing.resetSleepSyncForTesting();
  }
});

test("verifyPrEvidence returns the exact authoritative payloads for PR refs and omits no-PR markers", () => {
  const firstUrl = "https://github.com/acme/widget/pull/7";
  const secondUrl = "https://github.com/acme/widget/pull/8";
  const first = {
    number: 7,
    url: firstUrl,
    state: "MERGED",
    mergedAt: "2026-01-01T00:00:00Z",
    headRefName: "agent/codexa755-coord-809-change",
    headRefOid: "c164000000000000000000000000000000000000",
    baseRefName: "dev",
    mergeCommit: { oid: "4f30000000000000000000000000000000000000" },
  };
  const second = { ...first, number: 8, url: secondUrl, headRefOid: "c165000000000000000000000000000000000000" };
  landingGh.setRunGhForTesting((_cwd, args) => {
    const url = args[2];
    if (url === firstUrl) return JSON.stringify(first);
    if (url === secondUrl) return JSON.stringify(second);
    assert.fail(`unexpected PR lookup ${url}`);
  });
  try {
    const result = landingGh.verifyPrEvidence(
      "COORD-809",
      [firstUrl, "local note (no PR)", secondUrl],
      { requireMerged: true, allowNoPr: true }
    );
    assert.deepEqual(result, [
      { ref: firstUrl, payload: first },
      { ref: secondUrl, payload: second },
    ]);
    assert.notEqual(result[0].payload, result[1].payload);
    assert.equal(result[0].payload.headRefOid, first.headRefOid);
    assert.equal(result[0].payload.mergeCommit.oid, first.mergeCommit.oid);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("verifyPrEvidence preserves unmerged and invalid-ref refusals when returning receipts", () => {
  const url = "https://github.com/acme/widget/pull/9";
  landingGh.setRunGhForTesting(() => JSON.stringify({ state: "OPEN", mergedAt: null }));
  try {
    assert.throws(
      () => landingGh.verifyPrEvidence("COORD-809", [url], { requireMerged: true }),
      /not merged/
    );
    assert.throws(
      () => landingGh.verifyPrEvidence("COORD-809", ["https://example.invalid/pull/9"], { requireMerged: true }),
      /must either be a merged GitHub PR URL/
    );
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("verifyPrEvidence keeps its default behavior for open and merged PR refs", () => {
  const openUrl = "https://github.com/acme/widget/pull/10";
  const mergedUrl = "https://github.com/acme/widget/pull/11";
  const open = { url: openUrl, state: "OPEN", mergedAt: null };
  const merged = { url: mergedUrl, state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" };
  landingGh.setRunGhForTesting((_cwd, args) =>
    JSON.stringify(args[2] === openUrl ? open : merged)
  );
  try {
    assert.deepEqual(landingGh.verifyPrEvidence("COORD-809", [openUrl, mergedUrl]), [
      { ref: openUrl, payload: open },
      { ref: mergedUrl, payload: merged },
    ]);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("verifyPrEvidence refuses closed, timestamp-less merged, and disallowed no-PR evidence", () => {
  const closedUrl = "https://github.com/acme/widget/pull/12";
  const timestampLessUrl = "https://github.com/acme/widget/pull/13";
  landingGh.setRunGhForTesting((_cwd, args) => JSON.stringify(
    args[2] === closedUrl
      ? { state: "CLOSED", mergedAt: null }
      : { state: "MERGED", mergedAt: null }
  ));
  try {
    assert.throws(
      () => landingGh.verifyPrEvidence("COORD-809", [closedUrl]),
      /neither open nor merged/
    );
    assert.throws(
      () => landingGh.verifyPrEvidence("COORD-809", [timestampLessUrl], { requireMerged: true }),
      /not merged/
    );
    assert.throws(
      () => landingGh.verifyPrEvidence("COORD-809", ["local note (no PR)"], { allowNoPr: false }),
      /must either be a merged GitHub PR URL/
    );
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("verifyPrEvidence returns an empty receipt for an empty ref list without calling gh", () => {
  landingGh.setRunGhForTesting(() => assert.fail("empty refs must not invoke gh"));
  try {
    assert.deepEqual(landingGh.verifyPrEvidence("COORD-809", []), []);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("ghRepoView resolves repository identity from the selected repo root", () => {
  const repoRoot = "/tmp/coord-809-control-plane";
  const calls = [];
  landingGh.setRunGhForTesting((cwd, args, options) => {
    calls.push({ cwd, args, options });
    return JSON.stringify({ nameWithOwner: "Softsensor-org/coord-template" });
  });
  try {
    assert.deepEqual(landingGh.ghRepoView(repoRoot), { nameWithOwner: "Softsensor-org/coord-template" });
    assert.deepEqual(calls, [{
      cwd: repoRoot,
      args: ["repo", "view", "--json", "nameWithOwner"],
      options: { capture: true },
    }]);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("ghRepoView defaults to the configured ROOT_DIR", () => {
  const calls = [];
  landingGh.setRunGhForTesting((cwd, args) => {
    calls.push({ cwd, args });
    return JSON.stringify({ nameWithOwner: "Softsensor-org/coord-template" });
  });
  try {
    assert.deepEqual(landingGh.ghRepoView(), { nameWithOwner: "Softsensor-org/coord-template" });
    assert.deepEqual(calls, [{
      cwd: ROOT_DIR,
      args: ["repo", "view", "--json", "nameWithOwner"],
    }]);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

test("ghRepoView propagates gh and malformed JSON failures", () => {
  const ghError = new Error("gh authentication unavailable");
  landingGh.setRunGhForTesting(() => { throw ghError; });
  try {
    assert.throws(() => landingGh.ghRepoView("/tmp/coord-809-control-plane"), (error) => error === ghError);
  } finally {
    landingGh.resetRunGhForTesting();
  }

  landingGh.setRunGhForTesting(() => "not-json");
  try {
    assert.throws(() => landingGh.ghRepoView("/tmp/coord-809-control-plane"), SyntaxError);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

// COORD-830 review (third pass), finding 2: `gh pr merge` must name the head
// that was qualified, so a push between the preflight and the merge is refused
// by GitHub instead of landing an unmeasured head.
test("mergePrUrl passes --match-head-commit equal to the qualified head", () => {
  const url = "https://github.com/acme/widget/pull/30";
  const head = "5ed0609fd455cea054d92c0f15b48414927e35d4";
  const run = (options, viewedHead = head) => {
    const calls = [];
    let merged = false;
    landingGh.setRunGhForTesting((_cwd, args) => {
      calls.push(args);
      if (args[1] === "merge") { merged = true; return ""; }
      return JSON.stringify(merged
        ? { url, state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefOid: viewedHead }
        : { url, state: "OPEN", mergedAt: null, mergeStateStatus: "CLEAN", headRefOid: viewedHead });
    });
    const log = console.log;
    console.log = () => {};
    try {
      return { result: landingGh.mergePrUrl(url, "merge", options, "/nonexistent"), merge: calls.find((args) => args[1] === "merge") };
    } finally {
      console.log = log;
      landingGh.resetRunGhForTesting();
    }
  };
  const explicit = run({ matchHeadCommit: head.toUpperCase() });
  const at = explicit.merge.indexOf("--match-head-commit");
  assert.ok(at > 0, "the argument is present");
  assert.equal(explicit.merge[at + 1], head, "and equals the qualified head");
  const viewed = run({});
  assert.equal(viewed.merge[viewed.merge.indexOf("--match-head-commit") + 1], head, "without a qualified head the viewed head is pinned");
  assert.throws(() => run({ matchHeadCommit: head }, "b".repeat(40)), new RegExp(`head is ${"b".repeat(40)}, not the reviewed head ${head}`));
  assert.equal(run({}, "").merge.includes("--match-head-commit"), false, "no full head OID: nothing to pin");
});

test("mergePrUrl refuses a qualified head when the PR view names no head", () => {
  const url = "https://github.com/acme/widget/pull/31";
  landingGh.setRunGhForTesting((_cwd, args) => {
    assert.notEqual(args[1], "merge", "nothing is merged");
    return JSON.stringify({ url, state: "OPEN", mergedAt: null, mergeStateStatus: "CLEAN" });
  });
  try {
    assert.throws(() => landingGh.mergePrUrl(url, "merge", { matchHeadCommit: "a".repeat(40) }, "/nonexistent"), /head is \(unknown\), not the reviewed head/);
  } finally {
    landingGh.resetRunGhForTesting();
  }
});

// COORD-830 review (fourth pass), finding 1: an already-merged PR whose merged
// head differs from the qualified head must refuse, not report already_merged
// (land would record the measured head as the source of a head nobody measured).
test("mergePrUrl refuses an already-merged PR merged at a head other than the qualified one", () => {
  const url = "https://github.com/acme/widget/pull/30";
  const reviewed = "5ed0609fd455cea054d92c0f15b48414927e35d4";
  const view = (headRefOid) => (_cwd, args) => {
    assert.notEqual(args[1], "merge", "nothing is merged");
    return JSON.stringify({ url, state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefOid, mergeCommit: { oid: "d".repeat(40) } });
  };
  const log = console.log;
  console.log = () => {};
  try {
    landingGh.setRunGhForTesting(view("c".repeat(40)));
    assert.throws(
      () => landingGh.mergePrUrl(url, "squash", { matchHeadCommit: reviewed }, "/nonexistent"),
      new RegExp(`already merged at head ${"c".repeat(40)}, not the reviewed head ${reviewed}[\\s\\S]*--source-commit ${"c".repeat(40)}`),
    );
    landingGh.setRunGhForTesting(view(undefined));
    assert.throws(
      () => landingGh.mergePrUrl(url, "squash", { matchHeadCommit: reviewed }, "/nonexistent"),
      /already merged at head \(unknown\)[\s\S]*--source-commit <merged head>/,
    );
    landingGh.setRunGhForTesting(view(reviewed.toUpperCase()));
    assert.equal(landingGh.mergePrUrl(url, "squash", { matchHeadCommit: reviewed }, "/nonexistent").status, "already_merged", "merged at the qualified head");
    landingGh.setRunGhForTesting(view("c".repeat(40)));
    assert.equal(landingGh.mergePrUrl(url, "squash", {}, "/nonexistent").status, "already_merged", "no qualified head: unchanged");
  } finally {
    console.log = log;
    landingGh.resetRunGhForTesting();
  }
});

// mergePrUrl refusal and merge-outcome paths. Each case drives the real
// function through the runGh seam: `views` are the successive `gh pr view`
// payloads, `merge` is what `gh pr merge` does (return or throw).
function driveMergePrUrl({ url = "https://github.com/acme/widget/pull/40", views, merge = () => "", options = {}, method = "merge", repoRoot }) {
  const calls = [];
  let viewIndex = 0;
  landingGh.setRunGhForTesting((cwd, args) => {
    calls.push({ cwd, args });
    if (args[1] === "merge") return merge(args);
    const payload = views[Math.min(viewIndex, views.length - 1)];
    viewIndex += 1;
    return JSON.stringify({ url, ...payload });
  });
  const log = console.log;
  console.log = () => {};
  try {
    return { result: landingGh.mergePrUrl(url, method, options, repoRoot), calls, error: null };
  } catch (error) {
    return { result: null, calls, error };
  } finally {
    console.log = log;
    landingGh.resetRunGhForTesting();
  }
}

test("mergePrUrl refuses a PR that is neither merged nor open, before any merge", () => {
  const { error, calls } = driveMergePrUrl({ views: [{ state: "CLOSED", mergedAt: null }] });
  assert.ok(error instanceof require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js")).GovernanceError, String(error));
  assert.match(error.message, /is in state CLOSED; only OPEN PRs can be merged/);
  assert.equal(calls.some(({ args }) => args[1] === "merge"), false, "nothing is merged");
});

test("mergePrUrl refuses a non-mergeable PR with the recovery that fits its mergeStateStatus", () => {
  const refuse = (mergeStateStatus) => {
    const { error, calls } = driveMergePrUrl({ views: [{ state: "OPEN", mergedAt: null, mergeStateStatus, baseRefName: "dev", headRefOid: "a".repeat(40) }] });
    assert.equal(calls.some(({ args }) => args[1] === "merge"), false, `${mergeStateStatus}: nothing is merged`);
    assert.ok(error, `${mergeStateStatus}: refused`);
    assert.match(error.message, new RegExp(`is not mergeable \\(mergeStateStatus=${mergeStateStatus}\\)\\. Recovery: `));
    return error.message;
  };
  for (const status of ["BEHIND", "DIRTY"]) {
    const message = refuse(status);
    assert.match(message, /Recovery: git fetch origin dev && git merge origin\/dev --no-edit/, `${status}: integrate the base`);
    assert.doesNotMatch(message, /Resolve merge conflicts/);
  }
  assert.match(refuse("BLOCKED"), /Recovery: Resolve failing status checks or required reviews before merging\.$/);
  const other = refuse("UNSTABLE");
  assert.match(other, /Recovery: Resolve merge conflicts: git fetch origin dev && git merge origin\/dev --no-edit/);
  assert.match(other, /git rebase origin\/dev && git push --force-with-lease/);
});

test("mergePrUrl runs gh pr merge from ROOT_DIR with --delete-branch and --admin when requested", () => {
  const head = "5ed0609fd455cea054d92c0f15b48414927e35d4";
  const { result, calls, error } = driveMergePrUrl({
    method: "squash",
    options: { deleteBranch: true, admin: true },
    views: [
      { state: "OPEN", mergedAt: null, mergeStateStatus: "MERGEABLE", headRefOid: head },
      { state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefOid: head },
    ],
  });
  assert.equal(error, null);
  const merge = calls.find(({ args }) => args[1] === "merge");
  assert.equal(merge.cwd, ROOT_DIR, "no repo root override: the engine root");
  assert.deepEqual(merge.args, ["pr", "merge", "https://github.com/acme/widget/pull/40", "--squash", "--match-head-commit", head, "--delete-branch", "--admin"]);
  assert.deepEqual(result, { pr_url: "https://github.com/acme/widget/pull/40", status: "merged", merged_at: "2026-10-14T00:00:00Z", method: "squash", delete_branch: true });
});

test("mergePrUrl tolerates only the checked-out-branch delete failure after a successful merge", () => {
  const { GovernanceError } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const deleteFailure = "failed to delete local branch agent/x-t-1: failed to run git: error: cannot delete branch 'agent/x-t-1' used by worktree at '/tmp/wt'";
  const open = { state: "OPEN", mergedAt: null, mergeStateStatus: "CLEAN", headRefOid: "a".repeat(40) };
  const mergedView = { state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefOid: "a".repeat(40) };
  const throwing = (message) => () => { throw new GovernanceError(message); };

  const tolerated = driveMergePrUrl({ options: { deleteBranch: true }, views: [open, mergedView], merge: throwing(deleteFailure) });
  assert.equal(tolerated.error, null);
  assert.deepEqual(tolerated.result, {
    pr_url: "https://github.com/acme/widget/pull/40", status: "merged", merged_at: "2026-10-14T00:00:00Z", method: "merge",
    delete_branch: false, delete_branch_skipped: true, delete_branch_reason: "local branch is still checked out by a governed worktree",
  });

  const otherFailure = driveMergePrUrl({ options: { deleteBranch: true }, views: [open, mergedView], merge: throwing("GraphQL: Pull request is not mergeable") });
  assert.equal(otherFailure.result, null);
  assert.equal(otherFailure.error.message, "GraphQL: Pull request is not mergeable", "any other gh failure is surfaced");

  const notMerged = driveMergePrUrl({ options: { deleteBranch: true }, views: [open, open], merge: throwing(deleteFailure) });
  assert.equal(notMerged.error.message, deleteFailure, "the delete failure is tolerated only when the PR did merge");

  const crash = new TypeError("stub crashed");
  const rethrown = driveMergePrUrl({ views: [open, mergedView], merge: () => { throw crash; } });
  assert.equal(rethrown.error, crash, "a non-governance error is rethrown unchanged");
  assert.equal(rethrown.calls.filter(({ args }) => args[1] === "view").length, 1, "and the PR is not re-viewed");
});

test("mergePrUrl refuses when gh pr merge returns but the PR did not reach MERGED", () => {
  const open = { state: "OPEN", mergedAt: null, mergeStateStatus: "CLEAN", headRefOid: "a".repeat(40) };
  const { error, result } = driveMergePrUrl({ views: [open, open], repoRoot: "/nonexistent" });
  assert.equal(result, null);
  assert.match(error.message, /did not reach MERGED state after gh pr merge/);
  const noTimestamp = driveMergePrUrl({ views: [open, { state: "MERGED", mergedAt: null }], repoRoot: "/nonexistent" });
  assert.match(noTimestamp.error.message, /did not reach MERGED state after gh pr merge/, "MERGED without mergedAt is not merged");
});

// COORD-982 (ARCH-AUDIT F-03): pin the real runGh and ghPrListMergedByBase call
// sites through a fake `gh` on PATH (no seam, real spawn of a fixture binary).
function withFakeGh(script, fn) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-982-fake-gh-"));
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    return fn(dir);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-982: ghPrListMergedByBase has exactly one definition and one export", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require("node:path").join(__dirname, "landing-gh.js"), "utf8");
  assert.equal((source.match(/^function ghPrListMergedByBase\(/gm) || []).length, 1);
  assert.equal((source.match(/^\s+ghPrListMergedByBase,$/gm) || []).length, 1);
});

test("COORD-982: ghPrListMergedByBase sends the merged-PR query for the base and parses the JSON result", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const argsFile = path.join(os.tmpdir(), `coord-982-args-${process.pid}-${Date.now()}.txt`);
  try {
    const rows = withFakeGh(`printf '%s\\n' "$@" > '${argsFile}'\necho '[{"number":7,"mergeCommit":{"oid":"abc"}}]'`, () =>
      landingGh.ghPrListMergedByBase(ROOT_DIR, "dev"));
    assert.deepEqual(rows, [{ number: 7, mergeCommit: { oid: "abc" } }]);
    const argv = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 7), ["pr", "list", "--base", "dev", "--state", "merged", "--limit"]);
    assert.match(argv.join(" "), /--json number,url,state,mergedAt,title,body,headRefName,baseRefName,isDraft,mergeCommit/);
  } finally {
    fs.rmSync(argsFile, { force: true });
  }
});

test("COORD-982: runGh returns stdout on success and throws the gh stderr on a non-zero exit (failure policy unchanged)", () => {
  assert.equal(withFakeGh("echo hello", () => landingGh.runGh(ROOT_DIR, ["repo", "view"], { capture: true })), "hello\n");
  assert.equal(withFakeGh("echo hidden", () => landingGh.runGh(ROOT_DIR, ["x"], { capture: false })), "");
  assert.equal(withFakeGh("exit 0", () => landingGh.runGh(ROOT_DIR, ["repo", "view"])), "");
  assert.throws(
    () => withFakeGh("exit 5", () => landingGh.runGh(ROOT_DIR, ["pr", "list"], { capture: false })),
    /gh pr list failed in /,
  );
  assert.throws(
    () => withFakeGh("echo 'boom from gh' >&2\nexit 3", () => landingGh.runGh(ROOT_DIR, ["pr", "list"], { capture: true })),
    (error) => /boom from gh/.test(error.message),
  );
  assert.throws(
    () => withFakeGh("exit 5", () => landingGh.runGh(ROOT_DIR, ["pr", "list"], { capture: true })),
    (error) => /gh pr list failed in /.test(error.message),
  );
});

test("merge affiliation requires a ticket and a matching governed or legacy branch", () => {
  const affiliate = landingGh.mergedPrAffiliatesWithTicket;
  assert.equal(affiliate(undefined, { headRefName: "topic-coord-123" }), false);
  assert.equal(affiliate("COORD-123", {}), false);
  assert.equal(affiliate("COORD-123", { headRefName: "topic-coord-123-follow-up" }), true);
  assert.equal(affiliate("COORD-123", { headRefName: "topic-coord-123" }), true);
  assert.equal(affiliate("COORD-123", { headRefName: "topic-coord-1234" }), false);
});
