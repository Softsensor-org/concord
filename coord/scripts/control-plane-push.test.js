"use strict";

// COORD-691 — the governed pre-closeout push.
//
// These tests run against REAL temporary git repositories with a REAL bare
// remote, not a mocked git. The defect this ticket exists to fix is entirely
// about what git actually does to a remote branch — whether a push
// fast-forwards, no-ops, or would need a force — and a stubbed git can be made
// to agree with any belief about that. The one place a stub IS used is the
// force-flag assertion, where the point is to inspect the argv without letting
// the command run.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  PUSH_STATUS,
  assertNoForceArgs,
  assertGovernedPushArgv,
  classifyPushNeed,
  nonForcePush,
  preCloseoutPushEnabled,
  pushControlPlaneIntegrationBranch,
} = require("./control-plane-push.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  }).trim();
}

function gitStatus(cwd, args) {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0 };
  } catch (error) {
    return { status: error.status || 1 };
  }
}

const realGitTry = require("./git-ops.js").gitTry;
const createSyncProvenance = require("./sync-provenance.js");

function commit(repo, message) {
  fs.appendFileSync(path.join(repo, "f.txt"), `${message}\n`);
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

// A throwaway remote plus a clone, mirroring the control-plane shape: a "main"
// integration branch on a bare remote that the local repository tracks.
function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-691-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  fs.mkdirSync(local);
  git(local, ["init", "--initial-branch=main"]);
  git(local, ["remote", "add", "origin", remote]);
  const first = commit(local, "base");
  git(local, ["push", "origin", "main:main"]);
  git(local, ["fetch", "origin", "main"]);
  return { root, remote, local, first };
}

test("COORD-691: a landing commit missing from the remote is pushed, and the receipt proves delivery", (t) => {
  const { local, remote } = makeWorld(t);
  const landed = commit(local, "landing");

  const receipt = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed });

  assert.equal(receipt.status, PUSH_STATUS.PUSHED);
  assert.equal(receipt.pushed, true);
  assert.equal(receipt.forced, false);
  assert.equal(receipt.commit_sha, landed);
  assert.equal(receipt.remote_sha_after, landed);
  assert.notEqual(receipt.remote_sha_before, landed, "the point of the push is that the remote did NOT have it");
  // Delivery asserted against the remote itself, not against the receipt.
  assert.equal(git(remote, ["rev-parse", "main"]), landed);
});

test("COORD-691: re-running against a remote that already has the commit is a no-op that SUCCEEDS", (t) => {
  const { local } = makeWorld(t);
  const landed = commit(local, "landing");
  const first = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed });
  assert.equal(first.status, PUSH_STATUS.PUSHED);

  // The retry-safety case: a re-run after a partial failure must converge, not
  // repeat the push and not fail.
  const second = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed });
  assert.equal(second.status, PUSH_STATUS.ALREADY_PRESENT);
  assert.equal(second.pushed, false, "a converged re-run must not push again");
  assert.equal(second.remote_sha_after, landed);

  const third = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed });
  assert.equal(third.status, PUSH_STATUS.ALREADY_PRESENT, "convergence is stable, not a one-time coincidence");
});

test("COORD-691: a DIVERGED remote is refused without pushing, and the remote is left untouched", (t) => {
  const { local, remote, root } = makeWorld(t);

  // Someone else advanced the remote.
  const other = path.join(root, "other");
  git(root, ["clone", remote, other]);
  const theirs = commit(other, "theirs");
  git(other, ["push", "origin", "main:main"]);

  const landed = commit(local, "ours");

  assert.throws(
    () => pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed }),
    /Refusing the governed pre-closeout push[\s\S]*holds commits the local main does not/,
  );
  // The refusal must be a refusal, not a slower failure: nothing moved.
  assert.equal(git(remote, ["rev-parse", "main"]), theirs, "a diverged remote must be left exactly as it was");
});

test("COORD-691: a commit that is not on the branch is refused — pushing would not deliver it", (t) => {
  const { local, remote } = makeWorld(t);
  const before = git(remote, ["rev-parse", "main"]);
  git(local, ["checkout", "-q", "-b", "side"]);
  const sideCommit = commit(local, "side work");
  git(local, ["checkout", "-q", "main"]);

  assert.throws(
    () => pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: sideCommit }),
    /is not reachable from main/,
  );
  assert.equal(git(remote, ["rev-parse", "main"]), before);
});

test("COORD-691: with no remote configured the push is a named no-op, not a failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-691-noremote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  const sha = commit(root, "only local");

  const receipt = pushControlPlaneIntegrationBranch({ repoRoot: root, branch: "main", commitSha: sha });
  assert.equal(receipt.status, PUSH_STATUS.NO_REMOTE);
  assert.equal(receipt.pushed, false);
});

test("COORD-691: a remote branch that does not exist yet is CREATED, and the receipt says so", (t) => {
  const { local, remote } = makeWorld(t);
  git(local, ["checkout", "-q", "-b", "release"]);
  const sha = commit(local, "release work");

  const receipt = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "release", commitSha: sha });
  assert.equal(receipt.status, PUSH_STATUS.PUSHED);
  assert.equal(receipt.created_remote_branch, true, "creating a branch is a different act from advancing one");
  assert.equal(git(remote, ["rev-parse", "release"]), sha);
});

test("COORD-691: NEVER force — every force spelling is refused before git runs", () => {
  for (const flag of ["--force", "-f", "--force-with-lease", "--force-with-lease=main", "--force-if-includes"]) {
    assert.throws(
      () => assertNoForceArgs(["push", "origin", "main:main", flag]),
      /Refusing to run a governed push with force\/destructive argument/,
      `${flag} must be refused`,
    );
  }
  assert.deepEqual(assertNoForceArgs(["push", "origin", "main:main"]), ["push", "origin", "main:main"]);
});

test("COORD-691: the push primitive hands git a plain non-force argv", () => {
  const calls = [];
  const gitFn = (repoRoot, args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  nonForcePush("/nowhere", ["origin", "main:main"], { gitFn });
  assert.deepEqual(calls, [["push", "origin", "main:main"]]);
  const argv = calls[0];
  assert.ok(!argv.some((a) => /force/.test(a)), "no force spelling may reach git");
  // The refspec is explicit: a bare `git push` obeys push.default and can send
  // a branch the caller never named.
  assert.ok(argv.includes("main:main"), "the refspec must be explicit, not implied by config");
});


// --- round 1 review, finding 1 ------------------------------------------------
//
// The first version of this module guaranteed "never force" with an argv
// blocklist. Two escapes were demonstrated in review, and both are pinned here
// as reproductions. The second is the one that matters: the forcing instruction
// was in git CONFIGURATION, so the argv contained nothing to block.

test("COORD-691 RED: git's force REFSPEC syntax (a leading +) is refused, not just the force flags", () => {
  assert.throws(
    () => assertGovernedPushArgv(["push", "origin", "+main:main"]),
    /forcing refspec[\s\S]*leading "\+" IS git's force syntax/,
  );
  // The narrow flag check alone does NOT catch it — which is exactly why the
  // full argv assertion exists. Pinning this keeps the two from being merged
  // back together on the assumption that one implies the other.
  assert.doesNotThrow(() => assertNoForceArgs(["push", "origin", "+main:main"]));
});

test("COORD-691 RED: an IMPLICIT push is refused, because remote.<name>.push can force without saying so", (t) => {
  const { local, remote, root } = makeWorld(t);

  // Configure the escape exactly as it was demonstrated in review.
  git(local, ["config", "remote.origin.push", "+refs/heads/main:refs/heads/main"]);

  // Someone else advances the remote: any push of our branch is now a rewrite.
  const other = path.join(root, "other");
  git(root, ["clone", remote, other]);
  const theirs = commit(other, "theirs");
  git(other, ["push", "origin", "main:main"]);

  commit(local, "ours");

  // The refusal happens before git runs: an argv with no refspec delegates the
  // decision to configuration, so the primitive will not issue it at all.
  assert.throws(
    () => nonForcePush(local, [], {}),
    /does not name exactly one remote and one refspec[\s\S]*remote\.origin\.push=\+refs\/heads\/main/,
  );
  assert.equal(
    git(remote, ["rev-parse", "main"]),
    theirs,
    "the remote must be untouched — this is the case that previously overwrote it and reported success",
  );

  // And the explicit form still refuses on its merits, by classification:
  // the remote has diverged, so there is no non-forcing way to advance it.
  assert.throws(
    () => pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: git(local, ["rev-parse", "HEAD"]) }),
    /holds commits the local main does not/,
  );
  assert.equal(git(remote, ["rev-parse", "main"]), theirs);
});

test("COORD-691: destructive push MODES are refused even though none of them is a force flag", () => {
  for (const argv of [
    ["push", "--mirror", "origin"],
    ["push", "origin", "--delete", "main"],
    ["push", "--all", "origin"],
    ["push", "--prune", "origin", "main:main"],
  ]) {
    assert.throws(
      () => assertGovernedPushArgv(argv),
      /force\/destructive argument/,
      `${argv.join(" ")} must be refused`,
    );
  }
});

test("COORD-691: unrecognised options are refused rather than interpreted", () => {
  assert.throws(
    () => assertGovernedPushArgv(["push", "origin", "--receive-pack=evil", "main:main"]),
    /unrecognised option/,
  );
  // An allowlist that is argued with is a blocklist: only the named few pass.
  assert.doesNotThrow(() => assertGovernedPushArgv(["push", "--quiet", "origin", "main:main"]));
});

test("COORD-691: wildcard and deletion refspecs are refused", () => {
  for (const refspec of ["refs/heads/*:refs/heads/*", ":main", "main:"]) {
    assert.throws(() => assertGovernedPushArgv(["push", "origin", refspec]), /refspec/);
  }
});
test("COORD-691: classification sees the world before acting, and reports what it saw", (t) => {
  const { local } = makeWorld(t);
  const landed = commit(local, "landing");
  const need = classifyPushNeed({ repoRoot: local, branch: "main", commitSha: landed });
  assert.equal(need.status, "needed");
  assert.equal(need.local_sha, landed);
  assert.notEqual(need.remote_sha, landed);
});

test("COORD-691: the pre-closeout push is OPT-IN and never defaults on", () => {
  const saved = process.env.COORD_PUSH_BEFORE_CLOSEOUT;
  delete process.env.COORD_PUSH_BEFORE_CLOSEOUT;
  try {
    assert.equal(preCloseoutPushEnabled({}), false, "default must be off — a push is irreversible and outward");
    assert.equal(preCloseoutPushEnabled({ pushBeforeCloseout: true }), true);
    for (const off of ["0", "false", "", "  "]) {
      process.env.COORD_PUSH_BEFORE_CLOSEOUT = off;
      assert.equal(preCloseoutPushEnabled({}), false, `env ${JSON.stringify(off)} must not enable it`);
    }
    process.env.COORD_PUSH_BEFORE_CLOSEOUT = "1";
    assert.equal(preCloseoutPushEnabled({}), true);
  } finally {
    if (saved === undefined) delete process.env.COORD_PUSH_BEFORE_CLOSEOUT;
    else process.env.COORD_PUSH_BEFORE_CLOSEOUT = saved;
  }
});

// --- round 2 review, findings 1 and 2 ----------------------------------------

test("COORD-691 RED (r2f1): with NO upstream the post-sync push SKIPS — it does not invent origin/<branch>", (t) => {
  const { local, remote } = makeWorld(t);
  // A branch nobody has ever pushed: no upstream, and no remote branch of the
  // same name. The historical `git push` skipped here. The round-1 repair
  // pushed to origin/<local-branch> and CREATED it.
  git(local, ["checkout", "-q", "-b", "orphan"]);
  commit(local, "orphan work");

  const svc = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local, canonicalSyncablePaths: () => [] });
  const result = svc.pushAfterLifecycleSync({ verb: "land", repoRoot: local });

  assert.equal(result.pushed, false, "with no upstream there is nothing to push to");
  assert.equal(result.reason, "no-upstream-or-remote");
  assert.equal(
    gitStatus(remote, ["rev-parse", "--verify", "--quiet", "orphan"]).status !== 0,
    true,
    "no remote branch may be created for a branch that has no upstream",
  );
});

test("COORD-691 RED (r2f1): a branch tracking an upstream under ANOTHER name pushes to THAT ref", (t) => {
  const { local, remote } = makeWorld(t);
  // main tracks origin/trunk. The destination is trunk, not main.
  git(local, ["push", "origin", "main:trunk"]);
  git(local, ["fetch", "origin", "trunk"]);
  git(local, ["branch", "--set-upstream-to=origin/trunk", "main"]);
  const trunkBefore = git(remote, ["rev-parse", "trunk"]);
  const mainBefore = git(remote, ["rev-parse", "main"]);
  const landed = commit(local, "work for trunk");

  const svc = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local, canonicalSyncablePaths: () => [] });
  const result = svc.pushAfterLifecycleSync({ verb: "land", repoRoot: local });

  assert.equal(result.pushed, true);
  assert.equal(git(remote, ["rev-parse", "trunk"]), landed, "the UPSTREAM ref must advance");
  assert.notEqual(trunkBefore, landed);
  assert.equal(
    git(remote, ["rev-parse", "main"]),
    mainBefore,
    "origin/main must NOT move: pushing <local>:<local> would have advanced it and left trunk stale — the measured regression",
  );
});

test("COORD-691 RED (r2f2): a LOST ACKNOWLEDGEMENT is post-verified, not believed", (t) => {
  const { local, remote } = makeWorld(t);
  const landed = commit(local, "landing");

  // Simulate the dangerous shape: the push really happens, and git then reports
  // failure (dropped connection after the ref update, lost ack). Only the push
  // invocation is faked; the fetch/rev-parse/merge-base calls run for real, so
  // the post-verification observes the true state of the remote.
  const gitFn = (repoRoot, args) => {
    const out = realGitTry(repoRoot, args);
    if (args[0] === "push") {
      return { status: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" };
    }
    return out;
  };

  const receipt = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed, gitFn });

  assert.equal(git(remote, ["rev-parse", "main"]), landed, "fixture: the push really did reach the remote");
  assert.equal(receipt.status, PUSH_STATUS.PUSHED, "the REMOTE is the authority on delivery, not the exit status");
  assert.equal(receipt.pushed, true);
  assert.equal(receipt.acknowledged, false, "the receipt must not hide that git reported failure");
  assert.equal(receipt.ack_lost, true);
  assert.equal(receipt.attempted, true);
  assert.equal(receipt.remote_moved, true);
  assert.match(receipt.detail, /NOT acknowledged locally/);
});

test("COORD-691 (r2f2): a genuinely failed push is still FAILED, and says so", (t) => {
  const { local, remote } = makeWorld(t);
  const before = git(remote, ["rev-parse", "main"]);
  const landed = commit(local, "landing");

  // No push happens at all.
  const gitFn = (repoRoot, args) =>
    args[0] === "push"
      ? { status: 128, stdout: "", stderr: "fatal: unable to access remote" }
      : realGitTry(repoRoot, args);

  const receipt = pushControlPlaneIntegrationBranch({ repoRoot: local, branch: "main", commitSha: landed, gitFn });

  assert.equal(receipt.status, PUSH_STATUS.FAILED);
  assert.equal(receipt.pushed, false);
  assert.equal(receipt.attempted, true, "an attempt that failed is still an attempt, and the caller must record it");
  assert.equal(receipt.remote_moved, false);
  assert.equal(receipt.ack_lost, undefined);
  assert.equal(git(remote, ["rev-parse", "main"]), before);
});
