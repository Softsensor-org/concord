"use strict";

// COORD-088 (Wave 4 slice 4): behavior tests for the landing COMMIT-RESOLUTION
// surface (landing-resolution.js) — the deep base-ref / git-ancestry /
// commit-sha resolution assertions relocated out of governance.test.js when the
// resolution layer was extracted from lifecycle.js. They reach the surface
// through the stable governance.js __testing facade (which re-exports the
// landing-resolution factory bindings), preserving the public test contract
// while co-locating the deep behavior coverage with the module it exercises.
//
// Scope here is RESOLUTION ONLY: which base ref ancestry is measured against
// (resolveLandingBaseRef / resolvePrLandingBaseRef, including the stale-local /
// origin-fallback decision), commit-sha extraction from free-text landing
// evidence (extractCommitShas), and the ancestry-based best-candidate pick
// (pickBestLandingCommit). The GitHub TRANSPORT tests (ghPrView retry, merge)
// stay with landing-gh coverage; the landing AUDIT / integrity tests
// (assertLandingIntegrity, audit-report) deliberately stay with
// governance.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;
const {
  runGit,
  writeRepoFile,
  createTempGitRepoWithOrigin,
} = require("./governance-test-utils.js");

// extractCommitShas / pickBestLandingCommit are NOT part of the frozen __testing
// facade contract (they are injected as deferred wrappers into the validation /
// audit factories, never re-exported on __testing). To assert them directly we
// instantiate the landing-resolution factory ourselves with the minimal real
// deps — the pure SHA extractor needs nothing, and the ancestry-based picker
// needs only the real git-ops-backed isCommitAncestorOfRef from worktree-ops.
const createLandingResolution = require("./landing-resolution.js");
const createWorktreeOps = require("./worktree-ops.js");
const { isCommitAncestorOfRef } = createWorktreeOps({});
const landingResolution = createLandingResolution({ isCommitAncestorOfRef });

test("resolvePrLandingBaseRef prefers origin/dev when a merged PR commit is missing from stale local dev", () => {
  const frontendRepo = createTempGitRepoWithOrigin("ebmr-pr-landing-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-900-pr-landing"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "remote-truth\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-900 merged PR landing"]);
  const mergedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", mergedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const resolution = __testing.resolvePrLandingBaseRef(frontendRepo.repoRoot, "dev", mergedCommit);
  assert.equal(resolution.baseRef, "origin/dev");
  assert.match(resolution.warning, /Local base ref dev is stale/i);

  // resolvePrLandingBaseRef is a thin wrapper over resolveLandingBaseRef; assert
  // the two agree on the stale-local fallback decision for the same input.
  const direct = __testing.resolveLandingBaseRef(frontendRepo.repoRoot, "dev", mergedCommit);
  assert.deepEqual(direct, resolution);

  // With no commit to anchor against, resolution short-circuits to the local
  // base ref with no warning (nothing to compare ancestry for).
  const noCommit = __testing.resolveLandingBaseRef(frontendRepo.repoRoot, "dev", null);
  assert.deepEqual(noCommit, { baseRef: "dev", warning: null });
});

test("resolvePrLandingBaseRef preserves an explicit local base override", () => {
  const frontendRepo = createTempGitRepoWithOrigin("ebmr-pr-landing-explicit-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-901-pr-landing"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "local-override\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-901 merged PR landing"]);
  const mergedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", mergedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const resolution = __testing.resolvePrLandingBaseRef(frontendRepo.repoRoot, "dev", mergedCommit, { explicitBase: true });
  assert.equal(resolution.baseRef, "dev");
  assert.equal(resolution.warning, null);

  // An already-remote base ref is likewise preserved verbatim (the origin/
  // fallback must not double-prefix it to origin/origin/dev).
  const remoteBase = __testing.resolveLandingBaseRef(frontendRepo.repoRoot, "origin/dev", mergedCommit);
  assert.equal(remoteBase.baseRef, "origin/dev");
  assert.equal(remoteBase.warning, null);
});

test("resolveLandingBaseRef prefers origin/dev when a no-PR landing commit is missing from stale local dev", () => {
  const frontendRepo = createTempGitRepoWithOrigin("ebmr-no-pr-landing-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-902-no-pr-landing"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "remote-truth-no-pr\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-902 no-pr landing"]);
  const landedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", landedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const resolution = __testing.resolveLandingBaseRef(frontendRepo.repoRoot, "dev", landedCommit);
  assert.equal(resolution.baseRef, "origin/dev");
  assert.match(resolution.warning, /Local base ref dev is stale/i);

  // extractCommitShas is the free-text → candidate-SHA seam that feeds the no-PR
  // resolveLandingCommitSha path: it pulls every 7-40 hex token and nothing else.
  const shas = landingResolution.extractCommitShas(
    `frontend/dev landed at ${landedCommit} via local-review (no PR); see deadbeef and the run log`
  );
  assert.ok(shas.includes(landedCommit), "the landed commit SHA is extracted from the evidence text");
  assert.ok(shas.includes("deadbeef"), "a short hex token in the same text is also extracted");
  assert.deepEqual(landingResolution.extractCommitShas(""), []);
  assert.deepEqual(landingResolution.extractCommitShas("no shas here, just prose"), []);

  // pickBestLandingCommit uses real git ancestry: the landed commit is an
  // ancestor of origin/dev so it survives the filter and is returned as the
  // single best landing commit.
  const best = landingResolution.pickBestLandingCommit(frontendRepo.repoRoot, [landedCommit], "origin/dev");
  assert.equal(best, landedCommit);
});
