"use strict";

// COORD-894 — board push preflight and PR landing mode. Every gh call is a
// FAKE; nothing here reaches the network. The PR-landing tests use a REAL bare
// git remote, and the fake gh performs the merge for real on that remote, so
// "merged" is observed through git ancestry rather than asserted by a stub.

// COORD-950: the durable external-effect record writes under RUNTIME_DIR; sandbox it
// so these closeout tests never touch the live coord/.runtime (test-isolation-guard).
require("../../scripts/governance-test-utils.js").sandboxProcessRuntime();

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { gitFixture } = require("./test-git-fixture.js");

const preflight = require("./board-push-preflight.js");
const prLanding = require("./board-pr-landing.js");

const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr, extra = {}) => ({ status: 1, stdout: "", stderr, ...extra });

// A fake gh answering by argv prefix; unmatched calls fail loudly.
function fakeGh(routes, calls = []) {
  return (args, opts) => {
    calls.push({ args, opts });
    const key = args.join(" ");
    for (const [prefix, answer] of routes) {
      if (key.startsWith(prefix)) return typeof answer === "function" ? answer(args, opts) : answer;
    }
    return fail(`unexpected gh call: ${key}`);
  };
}

const RULES = "api repos/acme/acme-coord/rules/branches/main";
const CLASSIC = "api repos/acme/acme-coord/branches/main/protection";
const NOT_PROTECTED = fail("gh: Branch not protected (HTTP 404)");
const probe = (gh) => preflight.probeBoardPush({ owner: "acme", repo: "acme-coord", branch: "main", gh });

test("COORD-894: parseGitHubRemote reads https, ssh and scp remotes and rejects others", () => {
  for (const url of [
    "https://github.com/acme/acme-coord.git",
    "https://x-access-token:abc@github.com/acme/acme-coord",
    "git@github.com:acme/acme-coord.git",
    "ssh://git@github.com/acme/acme-coord.git\n",
  ]) {
    assert.deepEqual(preflight.parseGitHubRemote(url), { owner: "acme", repo: "acme-coord" }, url);
  }
  for (const url of ["https://gitlab.com/acme/acme-coord.git", "/srv/git/coord.git", "", null]) {
    assert.equal(preflight.parseGitHubRemote(url), null, String(url));
  }
});

test("COORD-894: an org pull-request ruleset with a PR-only bypass blocks the direct push, with remedies", () => {
  const calls = [];
  const gh = fakeGh([
    ["auth status", ok("")],
    [RULES, ok([
      { type: "pull_request", ruleset_id: 7, ruleset_source_type: "Organization", ruleset_source: "acme" },
      { type: "non_fast_forward", ruleset_id: 7 },
      { type: "required_status_checks", ruleset_id: 7 },
    ])],
    ["api repos/acme/acme-coord/rulesets/7", ok({ name: "default branches", current_user_can_bypass: "pull_requests_only" })],
    [CLASSIC, NOT_PROTECTED],
  ], calls);
  const result = probe(gh);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "direct_push_blocked");
  assert.deepEqual(result.findings.map((f) => f.type), ["pull_request", "required_status_checks"]);
  assert.equal(result.findings[0].source, 'ruleset "default branches" (Organization acme)');
  assert.equal(calls.filter((c) => c.args.join(" ").includes("rulesets/7")).length, 1, "each ruleset is read once");
  const lines = preflight.formatBoardPushPreflight({ ...result, board_landing: "push" });
  assert.match(lines[0], /acme\/acme-coord branch "main": BLOCKED — the first finalize push will be refused/);
  assert.match(lines.join("\n"), /pull_request requires a pull request \(your bypass: pull_requests_only\)/);
  assert.match(lines.join("\n"), /exclude the board repository from the ruleset/);
  assert.match(lines.join("\n"), /"Always" mode/);
  assert.match(lines.join("\n"), /boardLanding: "pr"/);
  assert.deepEqual(preflight.boardPushDoctorWarnings({ ...result, board_landing: "push" }), lines);
  const prMode = preflight.formatBoardPushPreflight({ ...result, board_landing: "pr" });
  assert.match(prMode[0], /boardLanding is "pr"/);
  assert.equal(prMode.some((line) => /Remedies/.test(line)), false);
  assert.deepEqual(preflight.boardPushDoctorWarnings({ ...result, board_landing: "pr" }), [], "PR mode does not need the direct push");
});

test("COORD-894: an Always-mode bypass actor or no blocking rule allows the direct push", () => {
  const bypassed = probe(fakeGh([
    ["auth status", ok("")],
    [RULES, ok([{ type: "pull_request", ruleset_id: 9 }, { type: "deletion", ruleset_id: 9 }])],
    ["api repos/acme/acme-coord/rulesets/9", ok({ name: "org", current_user_can_bypass: "always" })],
    [CLASSIC, NOT_PROTECTED],
  ]));
  assert.equal(bypassed.status, "allowed");
  assert.equal(bypassed.reason, "bypass_always");
  assert.match(preflight.formatBoardPushPreflight(bypassed)[0], /allowed \(this identity bypasses the rules in Always mode\)/);
  assert.deepEqual(preflight.boardPushDoctorWarnings(bypassed), []);
  const open = probe(fakeGh([["auth status", ok("")], [RULES, ok([])], [CLASSIC, NOT_PROTECTED]]));
  assert.equal(open.status, "allowed");
  assert.equal(open.reason, "no_blocking_rules");
  assert.match(preflight.formatBoardPushPreflight(open)[0], /allowed \(no blocking rules\)/);
});

test("COORD-894: classic branch protection is read too, and an unreadable answer is unknown, never a pass", () => {
  const classic = probe(fakeGh([
    ["auth status", ok("")],
    [RULES, ok([])],
    [CLASSIC, ok({ required_pull_request_reviews: {}, required_status_checks: {}, restrictions: {} })],
  ]));
  assert.equal(classic.status, "blocked");
  assert.deepEqual(classic.findings.map((f) => [f.source, f.type]), [
    ["classic protection", "pull_request"], ["classic protection", "required_status_checks"], ["classic protection", "update"],
  ]);
  const forbidden = probe(fakeGh([["auth status", ok("")], [RULES, ok([])], [CLASSIC, fail("gh: Must have admin rights (HTTP 403)")]]));
  assert.equal(forbidden.status, "unknown");
  assert.equal(forbidden.reason, "classic_protection_gh_error");
  assert.match(forbidden.detail, /HTTP 403/);
  const garbled = probe(fakeGh([["auth status", ok("")], [RULES, ok([])], [CLASSIC, ok("<html>")]]));
  assert.equal(garbled.status, "unknown");
  assert.equal(garbled.reason, "classic_protection_unreadable classic protection response");
  // A blocking ruleset still reports blocked even when classic protection is unreadable,
  // and a ruleset whose bypass cannot be read is treated as blocking.
  const blockedAnyway = probe(fakeGh([
    ["auth status", ok("")],
    [RULES, ok([{ type: "update", ruleset_id: 3 }, { type: "merge_queue" }])],
    ["api repos/acme/acme-coord/rulesets/3", fail("HTTP 404")],
    [CLASSIC, fail("gh: Must have admin rights (HTTP 403)")],
  ]));
  assert.equal(blockedAnyway.status, "blocked");
  assert.deepEqual(blockedAnyway.findings.map((f) => [f.source, f.bypass]), [["ruleset 3", null], ["ruleset (unnamed)", null]]);
});

test("COORD-894: gh missing, unauthenticated, offline or erroring degrades to a clear unknown", () => {
  const cases = [
    [fakeGh([["auth status", { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }]]), "gh_missing", /not installed/],
    [fakeGh([["auth status", fail("You are not logged into any GitHub hosts. To log in, run: gh auth login")]]), "gh_unauthenticated", /gh auth login/],
    [fakeGh([["auth status", ok("")], [RULES, fail("error connecting to api.github.com")]]), "offline", /offline/],
    [fakeGh([["auth status", { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }]]), "timeout", /UNKNOWN \(timeout\) — gh did not answer within the timeout/],
    [fakeGh([["auth status", ok("")], [RULES, fail("gh: Server Error (HTTP 500)")]]), "gh_error", /gh returned an error/],
    [fakeGh([["auth status", ok("")], [RULES, ok("not json")]]), "unreadable_rules_response", /could not be read/],
    [fakeGh([["auth status", ok("")], [RULES, ok({ message: "x" })]]), "unreadable_rules_response", /could not be read/],
    [fakeGh([["auth status", { status: null, error: { code: "TEST_RUNNER" } }]]), "gh_disabled", /test runner/],
    [() => null, "gh_error", /gh returned an error/],
  ];
  for (const [gh, reason, text] of cases) {
    const result = probe(gh);
    assert.equal(result.status, "unknown", reason);
    assert.equal(result.reason, reason);
    const [line] = preflight.formatBoardPushPreflight(result);
    assert.match(line, /UNKNOWN/);
    assert.match(line, text);
    assert.match(line, /This is not a pass/);
    assert.deepEqual(preflight.boardPushDoctorWarnings(result), [line]);
  }
  assert.match(preflight.formatBoardPushPreflight({ status: "unknown", reason: "brand_new_reason", branch: "main", repo: null })[0], /brand new reason/);
});

test("COORD-894: the default gh runner never runs under the test runner and passes cwd and a no-prompt env otherwise", () => {
  const refused = preflight.createDefaultGh({ env: { NODE_TEST_CONTEXT: "child-v8" }, spawn: () => assert.fail("must not spawn") })(["auth", "status"]);
  assert.equal(refused.error.code, "TEST_RUNNER");
  const seen = [];
  const gh = preflight.createDefaultGh({ env: { PATH: "/bin" }, timeoutMs: 5, spawn: (bin, args, opts) => { seen.push({ bin, args, opts }); return ok("x"); } });
  assert.equal(gh(["auth", "status"], { cwd: "/repo" }).stdout, "x");
  gh(["api", "x"]);
  assert.equal(seen[0].bin, "gh");
  assert.deepEqual(seen[0].args, ["auth", "status"]);
  assert.equal(seen[0].opts.cwd, "/repo");
  assert.equal(seen[0].opts.timeout, 5);
  assert.equal(seen[0].opts.env.GH_PROMPT_DISABLED, "1");
  assert.equal("cwd" in seen[1].opts, false);
  assert.equal(typeof preflight.createDefaultGh(), "function");
});

test("COORD-894: runBoardPushPreflight resolves the board remote and is not applicable without one", () => {
  const remoteIs = (url) => (root, args) => {
    assert.deepEqual(args, ["remote", "get-url", "origin"]);
    return url === null ? { status: 2, stdout: "", stderr: "No such remote" } : { status: 0, stdout: `${url}\n` };
  };
  const none = preflight.runBoardPushPreflight({ repoRoot: null, branch: "main" });
  assert.equal(none.status, "not_applicable");
  assert.deepEqual(preflight.formatBoardPushPreflight(none), []);
  assert.deepEqual(preflight.boardPushDoctorWarnings(none), []);
  assert.deepEqual(preflight.boardPushDoctorWarnings(null), []);
  assert.deepEqual(preflight.formatBoardPushPreflight(null), []);
  assert.equal(preflight.runBoardPushPreflight({ repoRoot: "/r", branch: "main", gitFn: remoteIs(null) }).status, "not_applicable");
  const gitlab = preflight.runBoardPushPreflight({ repoRoot: "/r", branch: "main", gitFn: remoteIs("https://gitlab.com/a/b.git") });
  assert.equal(gitlab.status, "unknown");
  assert.equal(gitlab.reason, "not_a_github_remote");
  assert.match(preflight.formatBoardPushPreflight(gitlab)[0], /board remote branch "main": UNKNOWN \(not observed\) — the board remote is not a GitHub repository \(https:\/\/gitlab.com\/a\/b.git\)/);
  const blocked = preflight.runBoardPushPreflight({
    repoRoot: "/r", branch: "governance", boardLanding: "pr", gitFn: remoteIs("git@github.com:acme/acme-coord.git"),
    gh: fakeGh([
      ["auth status", ok("")],
      ["api repos/acme/acme-coord/rules/branches/governance", ok([{ type: "pull_request" }])],
      ["api repos/acme/acme-coord/branches/governance/protection", NOT_PROTECTED],
    ]),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.board_landing, "pr");
  assert.equal(blocked.repo, "acme/acme-coord");

  const defaultGh = preflight.runBoardPushPreflight({
    repoRoot: "/r", branch: "governance", gitFn: remoteIs("git@github.com:acme/acme-coord.git"),
  });
  assert.equal(defaultGh.status, "unknown");
  assert.equal(defaultGh.reason, "gh_disabled", "the default client refuses network access under node:test");
});

test("COORD-894: the refusal hint names the PR-mode setting and the remedies, and rule refusals are recognised", () => {
  const hint = preflight.boardPushRefusalHint("main");
  assert.match(hint, /refused a direct push to the board branch "main"/);
  assert.match(hint, /boardLanding: "pr" in coord\/project\.config\.js/);
  assert.match(hint, /exclude the board repository/);
  assert.match(hint, /"Always" mode/);
  assert.match(hint, /gov doctor/);
  for (const stderr of [
    "remote: error: GH013: Repository rule violations found for refs/heads/main.",
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
    "Changes must be made through a pull request.",
    "remote: Protected branch hook declined",
  ]) assert.equal(preflight.isRuleRefusal(stderr), true, stderr);
  for (const stderr of [
    "fatal: unable to access: Could not resolve host",
    " ! [remote rejected] main -> main (pre-receive hook declined)",
    "", null,
  ]) assert.equal(preflight.isRuleRefusal(stderr), false, String(stderr));
});

// ---------------------------------------------------------------------------
// PR landing mode against a fake remote.

function git(cwd, args) {
  return gitFixture(cwd, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo, message) {
  fs.appendFileSync(path.join(repo, "f.txt"), `${message}\n`);
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-894-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  fs.mkdirSync(remote);
  gitFixture(remote, ["init", "-q", "--bare", "--initial-branch=main"]);
  fs.mkdirSync(local);
  gitFixture(local, ["init", "-q", "--initial-branch=main"]);
  git(local, ["remote", "add", "origin", remote]);
  commit(local, "base");
  git(local, ["push", "-q", "origin", "main:main"]);
  git(local, ["fetch", "-q", "origin", "main"]);
  return { root, remote, local };
}

// A faithful fake GitHub: PRs live in memory; "merging" performs a real
// --no-ff merge of the head branch into the base on the bare remote.
function fakeGitHub(world, behaviour = {}) {
  const prs = [];
  const calls = [];
  const mergeOnRemote = (pr) => {
    const work = path.join(world.root, `merge-${pr.number}`);
    git(world.root, ["clone", "-q", world.remote, work]);
    git(work, ["checkout", "-q", pr.base]);
    if (behaviour.squash) {
      git(work, ["merge", "-q", "--squash", `origin/${pr.head}`]);
      git(work, ["commit", "-q", "-m", "squash"]);
    } else {
      git(work, ["merge", "-q", "--no-ff", "-m", `Merge pull request #${pr.number}`, `origin/${pr.head}`]);
    }
    git(work, ["push", "-q", "origin", `${pr.base}:${pr.base}`]);
    pr.state = "MERGED";
    pr.mergeCommit = { oid: git(work, ["rev-parse", "HEAD"]) };
  };
  const gh = (args, opts) => {
    calls.push({ args, cwd: opts && opts.cwd });
    const [a, b] = args;
    if (a === "pr" && b === "list") {
      if (behaviour.listFails) return fail("HTTP 502");
      const head = args[args.indexOf("--head") + 1];
      const state = args[args.indexOf("--state") + 1].toUpperCase();
      return ok(prs.filter((pr) => pr.head === head && pr.state === state).map((pr) => ({ url: pr.url, mergeCommit: pr.mergeCommit || null })));
    }
    if (a === "pr" && b === "create") {
      if (behaviour.createFails) return fail("GraphQL: No commits between main and coord-board/x");
      const pr = { number: prs.length + 1, base: args[args.indexOf("--base") + 1], head: args[args.indexOf("--head") + 1], state: "OPEN" };
      pr.url = `https://github.com/acme/acme-coord/pull/${pr.number}`;
      prs.push(pr);
      return ok(`Creating pull request...\n${pr.url}\n`);
    }
    if (a === "pr" && b === "merge") {
      if (behaviour.autoMergeFails) return fail("GraphQL: Auto merge is not allowed for this repository");
      return ok("");
    }
    if (a === "pr" && b === "view") {
      const pr = prs.find((p) => p.url === args[2]);
      behaviour.views = (behaviour.views || 0) + 1;
      if (behaviour.viewFails) return fail("HTTP 502");
      if (behaviour.closeOnView) pr.state = "CLOSED";
      else if (pr.state === "OPEN" && behaviour.views >= (behaviour.mergeOnView || 1) && !behaviour.neverMerge) mergeOnRemote(pr);
      return ok({ state: pr.state, mergeCommit: pr.mergeCommit || null, url: pr.url });
    }
    return fail(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, prs, calls, merge: (pr) => mergeOnRemote(pr) };
}

const isAncestor = (repo, a, b) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("COORD-894: a PR-mode landing pushes a governance-only head, enables auto-merge, waits, and lands a merge commit", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const hub = fakeGitHub(world, { mergeOnView: 2 });
  const sleeps = [];
  const receipt = prLanding.landBoardCommitViaPr({
    repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894",
    gh: hub.gh, sleep: (ms) => sleeps.push(ms), wait: { timeoutMs: 60000, intervalMs: 7 },
  });
  assert.equal(receipt.status, "merged");
  assert.equal(receipt.pr_url, "https://github.com/acme/acme-coord/pull/1");
  assert.equal(receipt.pr_created, true);
  assert.equal(receipt.auto_merge, true);
  assert.equal(receipt.head_branch, "coord-board/coord-894");
  assert.equal(git(world.remote, ["rev-parse", "coord-board/coord-894"]), landed, "the head branch carries exactly the landing commit");
  assert.equal(receipt.merge_commit_sha, git(world.remote, ["rev-parse", "main"]));
  assert.equal(isAncestor(world.local, landed, "origin/main"), true, "the merge commit keeps the landing commit an ancestor, and origin/main was fetched");
  assert.deepEqual(sleeps, [7], "it waited once between polls");
  assert.deepEqual(hub.calls.find((c) => c.args[1] === "merge").args, ["pr", "merge", receipt.pr_url, "--auto", "--merge"]);
  assert.ok(hub.calls.every((c) => c.cwd === world.local), "gh runs in the board repository");
  const effect = prLanding.boardPrLandingSideEffect("COORD-894", receipt);
  assert.equal(effect.type, "control_plane_pr_landing");
  assert.equal(effect.pr_url, receipt.pr_url);
  assert.equal(effect.merge_commit_sha, receipt.merge_commit_sha);
  assert.equal(effect.forced, false);
  assert.match(effect.summary, /board PR landing merged for COORD-894 via https:\/\/github.com\/acme\/acme-coord\/pull\/1 \(merge [0-9a-f]{12}\)/);
  assert.deepEqual(prLanding.boardPrLandingRecord(receipt), {
    status: "merged", pr_url: receipt.pr_url, merge_commit_sha: receipt.merge_commit_sha, head_branch: "coord-board/coord-894",
  });
});

test("COORD-894: a PR-mode retry reuses the open PR; pending, closed and failed outcomes are named", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const hub = fakeGitHub(world, { neverMerge: true, autoMergeFails: true });
  const run = (gh, extra = {}) => prLanding.landBoardCommitViaPr({
    repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894", gh, wait: { timeoutMs: 0, intervalMs: 0 }, ...extra,
  });
  const pending = run(hub.gh);
  assert.equal(pending.status, "pending");
  assert.equal(pending.auto_merge, false);
  assert.match(pending.auto_merge_detail, /Auto merge is not allowed/);
  assert.match(pending.detail, /not merged after 0s/);
  const again = run(hub.gh);
  assert.equal(again.pr_url, pending.pr_url, "the retry converges on the same PR");
  assert.equal(again.pr_created, false);
  assert.equal(hub.prs.length, 1);
  assert.match(prLanding.boardPrLandingSideEffect("COORD-894", again).summary, /^board PR landing pending for COORD-894 via \S+$/);

  const closed = run(fakeGitHub(world, { closeOnView: true }).gh);
  assert.equal(closed.status, "closed");
  const viewDown = run(fakeGitHub(world, { viewFails: true }).gh);
  assert.equal(viewDown.status, "pending", "an unreadable PR state is pending, never merged");
  assert.equal(run(fakeGitHub(world, { listFails: true }).gh).status, "failed");
  const garbled = run(fakeGh([
    ["pr list", ok("<html>")],
    ["pr create", ok("https://github.com/acme/acme-coord/pull/9\n")],
    ["pr merge", ok("")],
    ["pr view", ok("garbage")],
  ]));
  assert.equal(garbled.status, "pending", "unreadable gh answers never read as merged");
  assert.equal(garbled.pr_url, "https://github.com/acme/acme-coord/pull/9");
  const noPr = run(fakeGitHub(world, { createFails: true }).gh);
  assert.equal(noPr.status, "failed");
  assert.match(noPr.detail, /gh pr create failed: GraphQL: No commits/);
  assert.equal(prLanding.boardPrLandingSideEffect("COORD-894", noPr).summary, "board PR landing failed for COORD-894");
  const pushFailed = run(hub.gh, { gitFn: () => ({ status: 1, stderr: "" }) });
  assert.equal(pushFailed.status, "failed");
  assert.match(pushFailed.detail, /push of coord-board\/coord-894 failed: unknown error/);
  assert.throws(() => prLanding.boardPrHeadBranch("  "), /needs a ticket id/);
  assert.equal(prLanding.boardPrHeadBranch("ACME 12/x"), "coord-board/acme-12-x");
});

test("COORD-894: the default PR-landing wait sleeps between polls and gh defaults to the guarded runner", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const hub = fakeGitHub(world, { mergeOnView: 2 });
  const started = Date.now();
  const receipt = prLanding.landBoardCommitViaPr({
    repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894", gh: hub.gh, wait: { intervalMs: 1 },
  });
  assert.equal(receipt.status, "merged");
  assert.ok(Date.now() - started < prLanding.DEFAULT_WAIT.timeoutMs);
  // No gh injected: under the test runner the default runner refuses, so the landing fails closed.
  const guarded = prLanding.landBoardCommitViaPr({ repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894-b" });
  assert.equal(guarded.status, "failed");
  assert.match(guarded.detail, /gh is never invoked under the test runner/);
});

// ---------------------------------------------------------------------------
// Closeout integration: evaluateControlPlaneLanding in both landing modes.

const { evaluateControlPlaneLanding } = require("./control-plane-landing.js");
const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require("./governance-context.js");

function withMutationContext(fn) {
  const saved = governanceState.activeGovernanceMutationContext;
  const context = { externalSideEffects: [] };
  governanceState.activeGovernanceMutationContext = context;
  try {
    return { result: fn(), effects: context.externalSideEffects };
  } finally {
    governanceState.activeGovernanceMutationContext = saved;
  }
}

test("COORD-894: a PR-mode closeout completes only after the merge lands, and the journal records the PR and merge", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const hub = fakeGitHub(world, { mergeOnView: 2 });
  const layout = { coordRepoRoot: world.local, configuredBranch: "main" };
  const { result, effects } = withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, {
    layout, boardLanding: "pr", gh: hub.gh, sleep: () => {}, prWait: { timeoutMs: 60000, intervalMs: 0 },
  }));
  assert.equal(result.verification, "remote_ancestry");
  assert.equal(result.base_ref, "main");
  assert.equal(result.board_pr_landing.status, "merged");
  assert.equal(result.board_pr_landing.pr_url, "https://github.com/acme/acme-coord/pull/1");
  assert.equal(result.board_pr_landing.merge_commit_sha, git(world.remote, ["rev-parse", "main"]));
  assert.equal("pre_closeout_push" in result, false, "no direct push happened");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, "control_plane_pr_landing");
  assert.equal(effects[0].pr_url, result.board_pr_landing.pr_url);
  assert.equal(effects[0].merge_commit_sha, result.board_pr_landing.merge_commit_sha);
  assert.ok(effects[0].recorded_at);
});

test("COORD-894: the board landing record cites the merged PR in the shape the board schema allows", (t) => {
  const { ensureControlPlaneLandingRecord } = require("./control-plane-landing.js");
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const board = { landing_index: {}, pr_index: {} };
  const { result } = withMutationContext(() => ensureControlPlaneLandingRecord("COORD-894", board, { ID: "COORD-894", Repo: "X" }, {
    layout: { coordRepoRoot: world.local, configuredBranch: "main" }, boardLanding: "pr", commitSha: landed,
    landed: "board commit published through a governance-only PR", gh: fakeGitHub(world).gh, sleep: () => {}, prWait: { timeoutMs: 60000, intervalMs: 0 },
  }));
  assert.equal(result, board.landing_index["COORD-894"]);
  assert.equal(result.control_plane_verification, "remote_ancestry");
  assert.equal(result.board_pr_landing.status, "merged");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "board", "tasks.schema.json"), "utf8"));
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.properties && node.properties.board_pr_landing) return node.properties.board_pr_landing;
    for (const value of Object.values(node)) { const hit = find(value); if (hit) return hit; }
    return null;
  };
  const shape = find(schema);
  assert.equal(shape.additionalProperties, false);
  assert.deepEqual(Object.keys(result.board_pr_landing).sort(), Object.keys(shape.properties).sort());
  assert.ok(shape.properties.status.enum.includes(result.board_pr_landing.status));
});

test("COORD-894: a pending, squashed or failed board PR refuses the closeout with the reason", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const layout = { coordRepoRoot: world.local, configuredBranch: "main" };
  const attempt = (behaviour) => () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, {
    layout, boardLanding: "pr", gh: fakeGitHub(world, behaviour).gh, sleep: () => {}, prWait: { timeoutMs: 0, intervalMs: 0 },
  }));
  assert.throws(attempt({ neverMerge: true }), /boardLanding is "pr": the board PR https:\/\/github.com\/acme\/acme-coord\/pull\/1 is pending \(not merged after 0s\) with auto-merge enabled; closeout completes only after it merges/);
  assert.throws(attempt({ createFails: true }), /boardLanding is "pr": the board PR landing failed \(gh pr create failed: [^)]*\); nothing landed/);
  assert.throws(attempt({ closeOnView: true }), /the board PR landing closed https:\/\/\S+ \(the PR was closed without merging\)/);
  assert.throws(attempt({ squash: true }), /the board PR https:\/\/\S+ merged as [0-9a-f]{40} but the landing commit is not on the board branch; merge board PRs with a merge commit/);
  // A pending receipt without auto-merge still says how to finish.
  assert.throws(attempt({ neverMerge: true, autoMergeFails: true }), /is pending \(not merged after 0s\); closeout completes only after it merges/);
});

test("COORD-894: in push mode a rule-refused direct push names the PR-mode setting and the remedies", (t) => {
  const world = makeWorld(t);
  const hook = path.join(world.remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'error: GH013: Repository rule violations found for refs/heads/main.' >&2\necho '- Changes must be made through a pull request.' >&2\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  const landed = commit(world.local, "board commit");
  const layout = { coordRepoRoot: world.local, configuredBranch: "main" };
  assert.throws(
    () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout, boardLanding: "push", pushBeforeCloseout: true })),
    (error) => {
      assert.match(error.message, /The governed pre-closeout push ran and did not deliver it: status=failed/);
      assert.match(error.message, /GH013/);
      assert.match(error.message, /set boardLanding: "pr" in coord\/project\.config\.js/);
      assert.match(error.message, /"Always" mode/);
      return true;
    }
  );
  // A push failure that is NOT a rule refusal keeps the old text.
  fs.writeFileSync(hook, "#!/bin/sh\necho 'disk quota exceeded' >&2\nexit 1\n");
  assert.throws(
    () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout, boardLanding: "push", pushBeforeCloseout: true })),
    (error) => !/boardLanding/.test(error.message) && /status=failed/.test(error.message)
  );
});

test("COORD-894: boardLanding defaults to the project config (push) when no option overrides it", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  git(world.local, ["push", "-q", "origin", "main:main"]);
  const result = evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout: { coordRepoRoot: world.local, configuredBranch: "main" } });
  assert.equal(result.verification, "remote_ancestry");
  assert.equal("board_pr_landing" in result, false);
  const unpushed = commit(world.local, "unpushed");
  assert.throws(
    () => evaluateControlPlaneLanding("COORD-894", { commit_sha: unpushed }, { layout: { coordRepoRoot: world.local, configuredBranch: "main" } }),
    /A governed push is available: re-run with --push-before-closeout/
  );
});

test("COORD-894: a rule-refused post-sync push names the PR-mode setting; other failures do not", () => {
  const createSyncProvenance = require("./sync-provenance.js");
  const svc = createSyncProvenance({ withActiveCommandFence: (_command, run) => run(), gitTry: require("./git-ops.js").gitTry, COORD_DIR: os.tmpdir(), canonicalSyncablePaths: () => [], DEFAULT_PATHS: { boardBranch: "governance" } });
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const refused = svc.pushAfterLifecycleSync({
      verb: "finalize",
      pushFn: () => ({ status: 1, stderr: "remote: error: GH013: Repository rule violations found for refs/heads/main." }),
    });
    assert.equal(refused.failed, true);
    const other = svc.pushAfterLifecycleSync({ verb: "finalize", pushFn: () => ({ status: 1, stderr: "fatal: early EOF" }) });
    assert.equal(other.failed, true);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warned[0], /GH013/);
  assert.match(warned[0], /set boardLanding: "pr" in coord\/project\.config\.js/);
  assert.match(warned[0], /direct push to the board branch "governance"/);
  assert.doesNotMatch(warned[1], /boardLanding/);
});

test("COORD-894: a closeout retry after the earlier PR merged cites that PR and opens no second one", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const hub = fakeGitHub(world, { neverMerge: true });
  const layout = { coordRepoRoot: world.local, configuredBranch: "main" };
  const options = { layout, boardLanding: "pr", gh: hub.gh, sleep: () => {}, prWait: { timeoutMs: 0, intervalMs: 0 } };
  assert.throws(() => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, options)), /is pending/);
  hub.merge(hub.prs[0]); // merged by a reviewer after the first run timed out
  const { result, effects } = withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, options));
  assert.equal(result.verification, "remote_ancestry");
  assert.deepEqual(result.board_pr_landing, {
    status: "merged", pr_url: hub.prs[0].url, merge_commit_sha: hub.prs[0].mergeCommit.oid, head_branch: "coord-board/coord-894",
  });
  assert.equal(hub.prs.length, 1, "no second PR");
  assert.equal(hub.calls.filter((c) => c.args[1] === "create").length, 1);
  assert.equal(effects[0].resumed, true);
  assert.equal(effects[0].pr_url, hub.prs[0].url);
  // Delivered some other way (no merged PR carries it): nothing is cited, nothing opened.
  git(world.local, ["merge", "-q", "--ff-only", "origin/main"]);
  const direct = commit(world.local, "direct");
  git(world.local, ["push", "-q", "origin", "main:main"]);
  const plain = withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: direct }, options));
  assert.equal("board_pr_landing" in plain.result, false);
  assert.deepEqual(plain.effects, []);
});

test("COORD-894: findMergedBoardPr only cites a merged PR whose merge commit contains the landing commit", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const base = git(world.local, ["rev-parse", "HEAD~1"]);
  const find = (gh) => prLanding.findMergedBoardPr({ repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894", gh });
  assert.equal(find(() => fail("HTTP 502")), null);
  assert.equal(find(() => ok("garbage")), null);
  assert.equal(find(() => ok([{ url: "u1" }, { mergeCommit: { oid: landed } }, { url: "u2", mergeCommit: { oid: base } }])), null);
  const hit = find(() => ok([{ url: "u3", mergeCommit: { oid: landed } }]));
  assert.equal(hit.pr_url, "u3");
  assert.equal(hit.resumed, true);
  assert.equal(find(undefined), null, "the guarded default runner answers nothing under the test runner");
  assert.deepEqual(prLanding.prWaitFromSeconds(30), { timeoutMs: 30000 });
  assert.deepEqual(prLanding.prWaitFromSeconds(undefined), {});
});

test("COORD-894: a timed-out PR-mode closeout is resumable and names the command and the wait setting", (t) => {
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const original = governanceDefaultPaths.boardLandingWaitSeconds;
  governanceDefaultPaths.boardLandingWaitSeconds = 0; // project.config.js boardLandingWaitSeconds: 0
  try {
    assert.throws(
      () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, {
        layout: { coordRepoRoot: world.local, configuredBranch: "main" }, boardLanding: "pr", gh: fakeGitHub(world, { neverMerge: true }).gh,
      })),
      (error) => /pending \(not merged after 0s\)/.test(error.message) &&
        /resumable/.test(error.message) &&
        /`coord\/scripts\/gov finalize COORD-894`/.test(error.message) &&
        /no second PR is opened/.test(error.message) &&
        /boardLandingWaitSeconds/.test(error.message)
    );
  } finally {
    governanceDefaultPaths.boardLandingWaitSeconds = original;
  }
});

function syncService(boardLanding = "pr", withActiveCommandFence = (_command, run) => run()) {
  const createSyncProvenance = require("./sync-provenance.js");
  return createSyncProvenance({
    withActiveCommandFence,
    gitTry: require("./git-ops.js").gitTry, COORD_DIR: os.tmpdir(), canonicalSyncablePaths: () => [],
    DEFAULT_PATHS: { boardBranch: "main", boardLanding, boardLandingWaitSeconds: 0 },
  });
}

function quietWarn(fn) {
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    return { result: fn(), warned };
  } finally {
    console.warn = originalWarn;
  }
}

test("sync publication without a caller verb uses the sync fence on every write", (t) => {
  const world = makeWorld(t);
  git(world.local, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
  const operations = [];
  let active = false;
  const fence = (command, run) => {
    assert.equal(command, "sync");
    assert.equal(active, false);
    active = true;
    try {
      const result = run();
      operations.push(command);
      return result;
    } finally {
      active = false;
    }
  };
  const direct = syncService("push", fence);
  const directCommit = commit(world.local, "direct sync");
  assert.deepEqual(direct.pushAfterLifecycleSync({ repoRoot: world.local }), { pushed: true });
  assert.equal(git(world.remote, ["rev-parse", "main"]), directCommit);
  assert.deepEqual(operations, ["sync"]);
  assert.deepEqual(direct.pushAfterLifecycleSync({
    repoRoot: world.local,
    pushFn: () => { assert.equal(active, true); return { status: 0 }; },
  }), { pushed: true });

  const prCommit = commit(world.local, "PR sync");
  const hub = fakeGitHub(world, { mergeOnView: 1 });
  const pr = {
    gh(args, options) {
      if (args[0] === "pr" && ["create", "merge"].includes(args[1])) assert.equal(active, true);
      return hub.gh(args, options);
    },
    sleep: () => {},
    wait: { timeoutMs: 60_000, intervalMs: 0 },
  };
  operations.length = 0;
  const result = syncService("pr", fence).pushAfterLifecycleSync({ repoRoot: world.local, pr });
  assert.equal(result.status, "merged");
  assert.equal(result.pushed, true);
  assert.deepEqual(operations, ["sync", "sync", "sync"], "fences the head push, PR creation and merge request");
  assert.equal(isAncestor(world.remote, prCommit, "main"), true);
});

test("COORD-894: in PR mode the post-sync push goes through the governance-only PR, and a re-run converges", (t) => {
  const world = makeWorld(t);
  git(world.local, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
  const synced = commit(world.local, "sync canonical derived artifacts");
  const hub = fakeGitHub(world, { mergeOnView: 1 });
  const svc = syncService();
  const pr = { gh: hub.gh, sleep: () => {}, wait: { timeoutMs: 60000, intervalMs: 0 } };
  const { result } = quietWarn(() => svc.pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894", pr }));
  assert.equal(result.pushed, true);
  assert.equal(result.mode, "pr");
  assert.equal(result.status, "merged");
  assert.equal(result.head_branch, "coord-board/coord-894-sync");
  assert.equal(result.pr_url, hub.prs[0].url);
  assert.equal(isAncestor(world.remote, synced, "main"), true, "the sync commit is on the board branch via the merge");
  const again = svc.pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894", pr });
  assert.deepEqual(again, { pushed: true, mode: "pr", status: "already_present", pr_url: hub.prs[0].url, merge_commit_sha: hub.prs[0].mergeCommit.oid });
  assert.equal(hub.prs.length, 1, "no second PR");
  // Without a ticket id the head is named from the commit.
  const loose = commit(world.local, "another sync");
  const unnamed = quietWarn(() => svc.pushAfterLifecycleSync({ verb: "sync", repoRoot: world.local, pr })).result;
  assert.equal(unnamed.head_branch, `coord-board/sync-${loose.slice(0, 12)}-sync`);
  assert.equal(unnamed.pushed, true);
});

test("COORD-894: a PR-mode post-sync push that is pending, squashed or has no upstream is reported, never claimed", (t) => {
  const world = makeWorld(t);
  const svc = syncService();
  const none = svc.pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894", pr: { gh: () => assert.fail("no gh without an upstream") } });
  assert.equal(none.pushed, false);
  assert.equal(none.reason, "no-upstream-or-remote");
  git(world.local, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
  commit(world.local, "sync");
  const hub = fakeGitHub(world, { neverMerge: true });
  const { result, warned } = quietWarn(() => svc.pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894", pr: { gh: hub.gh } }));
  assert.equal(result.pushed, false);
  assert.equal(result.failed, true);
  assert.equal(result.status, "pending");
  assert.match(warned[0], /boardLanding "pr": the post-finalize sync commit is not yet on the board branch \(PR https:\/\/\S+: pending, not merged after 0s\)/);
  assert.match(warned[0], /re-run the governed terminal verb with `--push-after-sync`; the open PR is reused/);
  const squashed = quietWarn(() => svc.pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894", pr: { gh: fakeGitHub(world, { squash: true }).gh } }));
  assert.equal(squashed.result.pushed, false);
  assert.match(squashed.result.detail, /merge commits only/);
  const noPr = quietWarn(() => svc.pushAfterLifecycleSync({ verb: "land", repoRoot: world.local, ticketId: "COORD-894-x", pr: { gh: fakeGitHub(world, { createFails: true }).gh } }));
  assert.match(noPr.warned[0], /PR not opened: failed, gh pr create failed/);
  // push mode is unchanged: the injected pushFn path still applies.
  assert.deepEqual(syncService("push").pushAfterLifecycleSync({ verb: "land", repoRoot: world.local, pushFn: () => ({ status: 0 }) }), { pushed: true });
});

// ---------------------------------------------------------------------------
// Sparse gh/git answers: empty stdout, a null body, nameless rulesets, a
// spawn timeout with no stderr. Each must degrade to a named answer.

test("COORD-894: the preflight reads empty, null and nameless gh answers as unknown or unnamed, never as a pass", () => {
  const AUTH = ["auth status", ok("")];
  const empty = probe(fakeGh([AUTH, [RULES, { status: 0 }]]));
  assert.equal(empty.status, "unknown");
  assert.equal(empty.reason, "unreadable_rules_response");
  const timedOut = probe(fakeGh([AUTH, [RULES, { status: null, error: { code: "ETIMEDOUT" } }]]));
  assert.equal(timedOut.status, "unknown");
  assert.equal(timedOut.reason, "timeout");
  assert.equal("detail" in timedOut, false, "no stderr means no detail, not an empty one");
  const nullClassic = probe(fakeGh([AUTH, [RULES, ok([])], [CLASSIC, ok("null")]]));
  assert.equal(nullClassic.status, "allowed");
  assert.equal(nullClassic.reason, "no_blocking_rules");
  const classicTimeout = probe(fakeGh([AUTH, [RULES, ok([])], [CLASSIC, { status: null, error: { code: "ETIMEDOUT" } }]]));
  assert.equal(classicTimeout.status, "unknown");
  assert.equal(classicTimeout.reason, "classic_protection_timeout");
  assert.equal("detail" in classicTimeout, false);
  const nameless = probe(fakeGh([
    AUTH,
    [RULES, ok([{ type: "pull_request", ruleset_id: 7, ruleset_source: "acme" }])],
    ["api repos/acme/acme-coord/rulesets/7", ok({})],
    [CLASSIC, NOT_PROTECTED],
  ]));
  assert.equal(nameless.status, "blocked");
  assert.deepEqual(nameless.findings, [{ source: "ruleset 7 (source acme)", type: "pull_request", effect: "requires a pull request", bypass: null }]);
  const noUrl = preflight.runBoardPushPreflight({ repoRoot: os.tmpdir(), branch: "main", gitFn: () => ({ status: 0 }), gh: () => assert.fail("gh is not consulted for a non-GitHub remote") });
  assert.equal(noUrl.status, "unknown");
  assert.equal(noUrl.reason, "not_a_github_remote");
  assert.equal("detail" in noUrl, false);
});

test("COORD-894: a PR landing reads empty gh output and a merge without a merge commit without inventing values", (t) => {
  assert.throws(() => prLanding.boardPrHeadBranch(undefined), /needs a ticket id/);
  const find = (answer) => prLanding.findMergedBoardPr({ repoRoot: os.tmpdir(), branch: "main", commitSha: "0".repeat(40), ticketId: "COORD-894", gh: () => answer, gitFn: () => assert.fail("no merge commit to test") });
  assert.equal(find({ status: 0 }), null, "an empty list answer cites nothing");
  assert.equal(find(ok({ url: "not-a-list" })), null, "a non-list answer cites nothing");
  const world = makeWorld(t);
  const landed = commit(world.local, "board commit");
  const run = (routes) => prLanding.landBoardCommitViaPr({
    repoRoot: world.local, branch: "main", commitSha: landed, ticketId: "COORD-894", gh: fakeGh(routes), sleep: () => {}, wait: { timeoutMs: 0, intervalMs: 0 },
  });
  const silentCreate = run([["pr list", ok([])], ["pr create", { status: 0 }]]);
  assert.equal(silentCreate.status, "failed");
  assert.equal(silentCreate.detail, "gh pr create failed: unknown error");
  const noMergeCommit = run([
    ["pr list", ok([])], ["pr create", ok("https://github.com/acme/acme-coord/pull/5\n")], ["pr merge", ok("")], ["pr view", ok({ state: "MERGED" })],
  ]);
  assert.equal(noMergeCommit.status, "merged");
  assert.equal(noMergeCommit.merge_commit_sha, null);
  assert.equal(prLanding.boardPrLandingSideEffect("COORD-894", noMergeCommit).summary, "board PR landing merged for COORD-894 via https://github.com/acme/acme-coord/pull/5");
});

test("COORD-894: the PR-mode sync push names a detached HEAD, cites no PR it cannot find, and needs no PR options", (t) => {
  assert.deepEqual(prLanding.publishSyncCommitViaPr({ repoRoot: os.tmpdir(), gitFn: () => ({ status: 0 }), gh: () => assert.fail("no gh without a branch") }), {
    pushed: false, reason: "no-upstream-or-remote", detail: "no upstream configured for a detached HEAD",
  });
  const world = makeWorld(t);
  // boardLanding "pr" from the project config alone (no pr options): the PR path, not the direct push.
  assert.deepEqual(syncService().pushAfterLifecycleSync({ verb: "finalize", repoRoot: world.local, ticketId: "COORD-894" }), {
    pushed: false, reason: "no-upstream-or-remote", detail: "no upstream configured for main",
  });
  git(world.local, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
  const calls = [];
  const published = prLanding.publishSyncCommitViaPr({ repoRoot: world.local, ticketId: "COORD-894", gh: fakeGh([["pr list", ok([])]], calls) });
  assert.deepEqual(published, { pushed: true, mode: "pr", status: "already_present" }, "HEAD is already on the board branch and no merged PR carried it");
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["pr", "list"]], "nothing is opened");
});

test("COORD-894: closeout refusals stay well-formed without a push detail or a merge commit, and boardLanding falls back to push", (t) => {
  const world = makeWorld(t);
  const layout = { coordRepoRoot: world.local, configuredBranch: "main" };
  const landed = commit(world.local, "board commit");
  // The push primitive sees no governance remote: the receipt has a status and no detail.
  const noRemoteView = (cwd, args) => (args.length === 1 && args[0] === "remote" ? { status: 0, stdout: "" } : require("./git-ops.js").gitTry(cwd, args));
  assert.throws(
    () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout, boardLanding: "push", pushBeforeCloseout: true, gitFn: noRemoteView })),
    (error) => /The governed pre-closeout push ran and did not deliver it: status=no_remote \(COORD-691\)\.$/.test(error.message)
  );
  // A PR reported merged with no merge commit, while the board branch lacks the landing commit.
  const gh = fakeGh([
    ["pr list", ok([])], ["pr create", ok("https://github.com/acme/acme-coord/pull/5\n")], ["pr merge", ok("")], ["pr view", ok({ state: "MERGED" })],
  ]);
  assert.throws(
    () => withMutationContext(() => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout, boardLanding: "pr", gh, sleep: () => {}, prWait: { timeoutMs: 0, intervalMs: 0 } })),
    /the board PR https:\/\/github\.com\/acme\/acme-coord\/pull\/5 merged but the landing commit is not on the board branch/
  );
  // No boardLanding in the options or the project paths: push mode.
  const original = governanceDefaultPaths.boardLanding;
  governanceDefaultPaths.boardLanding = undefined;
  try {
    assert.throws(
      () => evaluateControlPlaneLanding("COORD-894", { commit_sha: landed }, { layout, gh: () => assert.fail("push mode never consults gh") }),
      /A governed push is available: re-run with --push-before-closeout/
    );
  } finally {
    governanceDefaultPaths.boardLanding = original;
  }
});

// COORD-982 (ARCH-AUDIT F-03): the board push default gh keeps its timeout,
// no-prompt env and result-returning (non-throwing) failure policy.
test("COORD-982: createDefaultGh defaults to a 5000 ms timeout and GH_PROMPT_DISABLED, and returns non-zero results instead of throwing", () => {
  const seen = [];
  const failed = { status: 1, stdout: "", stderr: "GH001", error: undefined };
  const gh = preflight.createDefaultGh({ env: { PATH: "/bin" }, spawn: (bin, args, opts) => { seen.push({ bin, args, opts }); return failed; } });
  assert.equal(gh(["api", "repos/x"]), failed);
  assert.equal(seen[0].opts.timeout, 5000);
  assert.equal(seen[0].opts.env.GH_PROMPT_DISABLED, "1");
  assert.equal(seen[0].opts.env.PATH, "/bin");
  assert.equal(seen[0].opts.encoding, "utf8");
});
