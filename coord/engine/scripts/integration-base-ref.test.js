"use strict";

// COORD-898: one shared integration base-ref resolver. These regressions drive the
// real submit-side delta gate (lifecycle-review-state assertCommittedReviewState)
// against real git repositories in os.tmpdir() fixtures, never the live project
// config (the integration branch is passed in directly).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitFixture } = require("./test-git-fixture.js");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");

const createReviewState = require("./lifecycle-review-state.js");
const createLandingResolution = require("./landing-resolution.js");
const createWorktreeOps = require("./worktree-ops.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../../paths.js");

const worktreeOps = createWorktreeOps({});
const landingResolution = createLandingResolution({
  DEFAULT_INTEGRATION_BRANCH,
  resolveCommitishInRepo: worktreeOps.resolveCommitishInRepo,
  fetchRepoRef: worktreeOps.fetchRepoRef,
  isCommitAncestorOfRef: worktreeOps.isCommitAncestorOfRef,
});

function gitTry(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function commitFile(cwd, name, message) {
  fs.writeFileSync(path.join(cwd, name), `${message}\n`, "utf8");
  gitFixture(cwd, ["add", name]);
  gitFixture(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message]);
  return gitFixture(cwd, ["rev-parse", "HEAD"]);
}

// Builds a bare origin with a `dev` integration branch, then a product clone of it.
// Returns { seed, remote, clone } with the clone checked out detached.
function makeRemoteAndClone(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord898-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "product");
  fs.mkdirSync(seed);
  gitFixture(seed, ["init", "-q", "-b", "dev"]);
  commitFile(seed, "base.txt", "COORD-000: seed");
  gitFixture(root, ["init", "-q", "--bare", remote]);
  gitFixture(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/dev"]);
  gitFixture(seed, ["remote", "add", "origin", remote]);
  gitFixture(seed, ["push", "-q", "origin", "dev"]);
  gitFixture(root, ["clone", "-q", remote, clone]);
  return { root, remote, seed, clone };
}

// The product clone the operator reports: origin/dev exists, no local dev branch.
function dropLocalDev(clone) {
  gitFixture(clone, ["checkout", "-q", "--detach", "origin/dev"]);
  gitFixture(clone, ["branch", "-D", "dev"]);
}

// A governed ticket worktree cut from origin/dev, the way `gov start --base origin/dev` does.
function ticketWorktree(clone, root, name) {
  const worktree = path.join(root, name);
  gitFixture(clone, ["worktree", "add", "-q", "-b", `agent/claudea802-${name}`, worktree, "origin/dev"]);
  return worktree;
}

function makeReviewState({ clone, planSource = null }) {
  return createReviewState({
    assertCurrentTicketLockIntegrity: () => {},
    fail: (message) => { throw new Error(message); },
    fs,
    getRepoRoot: () => clone,
    gitTry,
    isCommitAncestorOfRef: worktreeOps.isCommitAncestorOfRef,
    isRepoBackedCode: () => true,
    planTargetsCoordOnlyArtifacts: () => false,
    repoNameForCode: () => "product",
    resolveCommitishInRepo: worktreeOps.resolveCommitishInRepo,
    resolveLandingBaseRef: (repoRoot, baseRef, commitSha, options) =>
      landingResolution.resolveLandingBaseRef(repoRoot, baseRef, commitSha, options),
    resolveRepoIntegrationBranch: () => "dev",
    resolveSourceCommitSha: () => planSource,
  });
}

const ROW = { ID: "COORD-898", Repo: "B" };

test("COORD-898 origin-only clone: start -> commit -> submit delta passes without a local dev branch", (t) => {
  const { root, clone } = makeRemoteAndClone(t);
  dropLocalDev(clone);
  const worktree = ticketWorktree(clone, root, "origin-only-ticket");
  commitFile(worktree, "feature.txt", "COORD-898: ticket change");
  const service = makeReviewState({ clone });
  assert.doesNotThrow(() => service.assertCommittedReviewState("COORD-898", ROW, { worktree, repo: "product" }));
});

test("COORD-898 stale local dev does not count upstream commits as ticket commits", (t) => {
  const { root, seed, clone } = makeRemoteAndClone(t);
  // Local dev lags origin: upstream lands after the clone was made.
  commitFile(seed, "upstream.txt", "COORD-100: upstream landing");
  gitFixture(seed, ["push", "-q", "origin", "dev"]);
  gitFixture(clone, ["fetch", "-q", "origin", "dev"]);
  // The ticket worktree is cut from fresh origin/dev and has NO commits of its own.
  const worktree = ticketWorktree(clone, root, "stale-local-ticket");
  const service = makeReviewState({ clone });
  assert.throws(
    () => service.assertCommittedReviewState("COORD-898", ROW, { worktree, repo: "product" }),
    /no committed changes ahead of origin\/dev/
  );
});

test("COORD-898 neither origin/dev nor local dev fails closed and names both refs and the remedy", (t) => {
  const { root, clone } = makeRemoteAndClone(t);
  dropLocalDev(clone);
  const worktree = ticketWorktree(clone, root, "neither-ref-ticket");
  commitFile(worktree, "feature.txt", "COORD-898: ticket change");
  // The worktree already exists; now neither integration ref resolves in the clone.
  gitFixture(clone, ["update-ref", "-d", "refs/remotes/origin/dev"]);
  const service = makeReviewState({ clone });
  assert.throws(
    () => service.assertCommittedReviewState("COORD-898", ROW, { worktree, repo: "product" }),
    (error) => {
      const message = String(error.message);
      assert.match(message, /origin\/dev/);
      assert.match(message, /\bdev\b/);
      assert.match(message, /git fetch origin dev/);
      return true;
    }
  );
});

test("COORD-898 resolver prefers origin/<base> over a stale local <base> and names both refs when neither exists", (t) => {
  const { integrationBaseRefFindings, resolveIntegrationBaseRef } = require("./integration-base-ref.js");
  const { root, seed, clone } = makeRemoteAndClone(t);
  assert.deepEqual(resolveIntegrationBaseRef(clone, "dev"), { ref: "origin/dev", source: "origin" });
  assert.deepEqual(integrationBaseRefFindings(clone, "dev"), []);
  // Local dev lags origin: the resolver still uses origin, doctor reports the lag.
  commitFile(seed, "upstream.txt", "COORD-101: upstream");
  gitFixture(seed, ["push", "-q", "origin", "dev"]);
  gitFixture(clone, ["fetch", "-q", "origin", "dev"]);
  assert.equal(resolveIntegrationBaseRef(clone, "dev").ref, "origin/dev");
  const lag = integrationBaseRefFindings(clone, "dev");
  assert.equal(lag.length, 1);
  assert.equal(lag[0].code, "integration-base-ref-lags-origin");
  assert.match(lag[0].remedy, /git branch -D dev/);
  // Neither ref: fail closed, naming both refs and the remedy.
  gitFixture(clone, ["update-ref", "-d", "refs/remotes/origin/dev"]);
  gitFixture(clone, ["update-ref", "-d", "refs/heads/dev"]);
  assert.throws(() => resolveIntegrationBaseRef(clone, "dev"), (error) => {
    assert.match(error.message, /origin\/dev/);
    assert.match(error.message, /local dev/);
    assert.match(error.message, /git fetch origin dev/);
    return true;
  });
  const missing = integrationBaseRefFindings(clone, "dev");
  assert.equal(missing[0].code, "integration-base-ref-missing");
  assert.equal(missing[0].severity, "high");
  assert.match(missing[0].remedy, /git fetch origin dev/);
  void root;
});

test("COORD-898 onboard discovery accepts an origin-only product clone and reports a missing ref with the remedy", (t) => {
  const { discoverRepoMetadata } = require("./onboard.js");
  const { root, clone } = makeRemoteAndClone(t);
  dropLocalDev(clone);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.renameSync(clone, path.join(workspace, "product"));
  const meta = discoverRepoMetadata(workspace, "product");
  assert.equal(meta.git.integration_branch, "dev");
  assert.deepEqual(meta.git.integration_ref_findings, []);
  gitFixture(path.join(workspace, "product"), ["update-ref", "-d", "refs/remotes/origin/dev"]);
  const broken = discoverRepoMetadata(workspace, "product");
  assert.equal(broken.git.integration_ref_findings[0].code, "integration-base-ref-missing");
  // Detection falls back to main when no integration ref exists; the remedy names it.
  assert.equal(broken.git.integration_branch, "main");
  assert.match(broken.git.integration_ref_findings[0].remedy, /git fetch origin main/);
});

test("integration base resolution rejects an empty name and a Git probe with no object ID", (t) => {
  const { resolveIntegrationBaseRef } = require("./integration-base-ref.js");
  const { root, clone } = makeRemoteAndClone(t);
  for (const empty of [undefined, "", "  origin/  "]) {
    assert.throws(() => resolveIntegrationBaseRef(clone, empty), /empty integration branch name/);
  }

  const bin = path.join(root, "empty-git-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    assert.throws(() => resolveIntegrationBaseRef(clone, "dev"), /neither origin\/dev nor local dev exists/);
  } finally {
    process.env.PATH = previousPath;
  }
});
