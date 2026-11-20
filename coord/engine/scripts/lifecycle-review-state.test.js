"use strict";
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { resolveControlPlaneLayout } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js"));
const createReviewState = require("./lifecycle-review-state.js");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const lifecycle = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle.js"));
const { resolveEngineModule } = require("../../paths.js");
const coordDir = path.resolve(__dirname, "..", "..");
const independentReviews = require(resolveEngineModule(coordDir, "scripts/independent-reviews.js"));
const { countLoc, DEFAULT_CONFIG } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));

test("COORD-858: configured repository identities preserve absolute roots and reject traversal", () => {
  const repositorySchema = JSON.parse(fs.readFileSync(resolveEngineModule(coordDir, "board/plan.schema.json"), "utf8"))
    .properties.review_submission.properties.repository;
  const relativeAndAbsolute = [
    "backend",
    "packages/server",
    "/tmp/path with spaces/backend",
    "/tmp/repo\u00a0with internal whitespace",
    "C:\\work\\repo",
    "C:/work/repo",
    "\\\\server\\share\\repo",
    "/tmp/repo-one/backend",
    "/tmp/repo-two/backend",
  ];
  const invalid = [
    "../backend",
    "/tmp/../backend",
    "C:\\..\\backend",
    "\\\\server\\share\\..\\backend",
    "/tmp/line\nbreak",
    "/tmp/with\u0000nul",
    " /tmp/repo",
    "/tmp/repo ",
    "backend\t",
    "\u00a0/tmp/repo",
    "/tmp/repo\u2003",
    "\ufeff/tmp/repo",
    "/" + "x".repeat(200),
  ];
  const mirroredRepositorySchema = JSON.parse(fs.readFileSync(path.join(coordDir, "board/plan.schema.json"), "utf8"))
    .properties.review_submission.properties.repository;
  assert.deepEqual(mirroredRepositorySchema, repositorySchema, "engine and standalone plan schemas stay aligned");
  const schemaPattern = new RegExp(repositorySchema.pattern);
  const schemaExclusions = repositorySchema.not.anyOf.map(({ pattern }) => new RegExp(pattern));
  const schemaAccepts = (repository) => repository.length >= repositorySchema.minLength &&
    repository.length <= repositorySchema.maxLength && schemaPattern.test(repository) &&
    !schemaExclusions.some((pattern) => pattern.test(repository));
  for (const repository of relativeAndAbsolute) {
    assert.equal(independentReviews.isRepositoryIdentity(repository), true, repository);
    assert.equal(schemaAccepts(repository), true, repository);
    assert.deepEqual(independentReviews.validateReviewSubmission({ repository, commit: "a".repeat(40) }), {
      repository, commit: "a".repeat(40),
    });
  }
  for (const repository of invalid) {
    assert.equal(independentReviews.isRepositoryIdentity(repository), false, JSON.stringify(repository));
    assert.equal(schemaAccepts(repository), false, JSON.stringify(repository));
    assert.equal(independentReviews.validateReviewSubmission({ repository, commit: "a".repeat(40) }), null);
  }

  const firstRoot = "/tmp/repo-one/backend";
  const secondRoot = "/tmp/repo-two/backend";
  const absolute = createReviewState.createReviewSubmissionState({
    repoNameForCode: (code) => code === "B" ? firstRoot : "coord",
    repoCodeForLockRepoName: (name) => name === firstRoot ? "B" : name === "coord" ? "X" : null,
    isRepoBackedCode: (code) => code !== "X",
    getRepoRoot: () => firstRoot,
    resolveSourceCommitSha: () => "b".repeat(40),
    resolveCommitishInRepo: (_root, commit) => commit === "b".repeat(40) ? commit : null,
    fail: (message) => { throw new Error(message); },
  });
  assert.throws(() => absolute.resolveReviewSubmission("B-858", { Repo: "B" }, {
    repo: secondRoot, head: "b".repeat(40),
  }), /lock repository does not match/, "same basenames do not alias distinct configured absolute repositories");
  assert.deepEqual(absolute.resolveReviewSubmission("B-858", { Repo: "B" }, {
    repo: firstRoot, head: "b".repeat(40),
  }), {
    submission: { repository: firstRoot, commit: "b".repeat(40) }, unresolved_reason: null,
  });
});

test("COORD-749: review subject resolution is fail-closed and uses the resolved commit", () => {
  let sha = null;
  let result = { status: 0, stdout: " COORD-749: repair\n" };
  const calls = [];
  const service = createReviewState({
    resolveCommitishInRepo: () => sha,
    gitTry: (...args) => { calls.push(args); return result; },
  });
  assert.equal(service.readCommitSubject("/repo", "branch"), null);
  assert.equal(calls.length, 0, "unresolved ref must not run git log");
  sha = "abc123";
  assert.equal(service.readCommitSubject("/repo", "branch"), "COORD-749: repair");
  assert.deepEqual(calls[0], ["/repo", ["log", "-1", "--format=%s", "abc123"]]);
  assert.equal(service.commitSubjectAffiliatesWithTicket("/repo", "branch", " coord-749 "), true);
  assert.equal(service.commitSubjectAffiliatesWithTicket("/repo", "branch", "COORD-750"), false);
  assert.equal(service.commitSubjectAffiliatesWithTicket("/repo", "branch", null), false);
  result = { status: 1, stdout: "COORD-749" };
  assert.equal(service.readCommitSubject("/repo", "branch"), null);
  assert.equal(service.commitSubjectAffiliatesWithTicket("/repo", "branch", "COORD-749"), false);
  result = { status: 0, stdout: " \n" };
  assert.equal(service.readCommitSubject("/repo", "branch"), null);
});

test("COORD-855: review refuses a missing governed worktree and dirty status before commit-range checks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord855-review-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, "missing-worktree");
  const dirty = path.join(root, "existing-worktree");
  fs.mkdirSync(dirty);
  const gitCalls = [];
  const service = createReviewState({
    assertCurrentTicketLockIntegrity: () => {},
    fs,
    fail: (message) => { throw new Error(message); },
    isRepoBackedCode: () => true,
    gitTry: (repo, args) => {
      gitCalls.push({ repo, args });
      return { status: 0, stdout: " M uncommitted.txt\n", stderr: "" };
    },
  });
  const row = { Repo: "B" };

  assert.throws(() => service.assertCommittedReviewState("B-855", row, { worktree: missing }), /no readable governed worktree/);
  assert.deepEqual(gitCalls, [], "a missing lock worktree refuses before running Git");

  assert.throws(() => service.assertCommittedReviewState("B-855", row, { worktree: dirty }), /uncommitted changes/);
  assert.deepEqual(gitCalls, [{ repo: dirty, args: ["status", "--porcelain"] }],
    "a dirty worktree refuses before resolving source or integration commits");
});

test("committed review uses the recorded ancestor and requires explicit reconciliation for a zero delta", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-review-delta-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const noRepo = path.join(root, "uninitialized");
  fs.mkdirSync(repo);
  fs.mkdirSync(noRepo);
  const git = (...args) => gitFixture(repo, args);
  gitFixture(repo, ["init", "-qb", "dev"]);
  git("commit", "--allow-empty", "-qm", "original integration commit");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "ticket");
  git("commit", "--allow-empty", "-qm", "B-855: implement change");
  git("branch", "-f", "dev", "HEAD");

  const ticket = "B-855";
  const row = { Repo: "B" };
  let integrationRef = "dev";
  let missingCountOutput = false;
  const service = createReviewState({
    assertCurrentTicketLockIntegrity: () => {},
    fs,
    fail: (message) => { throw new Error(message); },
    getRepoRoot: () => repo,
    gitTry: (cwd, args) => missingCountOutput && args[0] === "rev-list" ? { status: 0 } : gitFixtureSpawn(cwd, args),
    isRepoBackedCode: () => true,
    planTargetsCoordOnlyArtifacts: () => false,
    resolveLandingBaseRef: () => ({ baseRef: integrationRef }),
    resolveRepoIntegrationBranch: () => "dev",
    resolveSourceCommitSha: () => null,
  });

  assert.doesNotThrow(() => service.assertCommittedReviewState(ticket, row, { worktree: repo, base_commit: base }),
    "an advancing integration ref cannot erase the ticket's commits since start");
  const unrelatedCommit = git("commit-tree", "HEAD^{tree}", "-m", "stale integration history");
  const staleLock = { worktree: repo, base_commit: unrelatedCommit };
  assert.throws(() => service.assertCommittedReviewState(ticket, row, staleLock), /no committed changes ahead of dev/);
  assert.throws(() => service.assertCommittedReviewState(ticket, row, { worktree: repo }), /no committed changes ahead of dev/);
  for (const reconcile of ["allowMergedPrReconcile", "allowAlreadyLandedNoPrReconcile"]) {
    assert.doesNotThrow(() => service.assertCommittedReviewState(ticket, row, staleLock, { [reconcile]: true }));
    assert.throws(() => service.assertCommittedReviewState(ticket, row, { worktree: noRepo }, { [reconcile]: true }),
      /Could not verify git status/);
  }

  missingCountOutput = true;
  assert.throws(() => service.assertCommittedReviewState(ticket, row, staleLock), /no committed changes ahead of dev/);
  missingCountOutput = false;

  integrationRef = "deleted-integration-ref";
  assert.throws(() => service.assertCommittedReviewState(ticket, row, staleLock, { allowMergedPrReconcile: true }),
    /Could not verify commit delta .* against deleted-integration-ref/);
  assert.equal(git("status", "--porcelain"), "");
});

test("COORD-749: review helpers stay owned by the extracted service while root shrinks", () => {
  const service = createReviewState({
    resolveCommitishInRepo: (_repo, commitish) => commitish,
    gitTry: () => ({ status: 0, stdout: "COORD-749: owner module\n", stderr: "" }),
    fail: (message) => { throw new Error(message); },
  });
  assert.equal(service.readCommitSubject("/repo", "abc123"), "COORD-749: owner module");
  assert.equal(service.commitSubjectAffiliatesWithTicket("/repo", "abc123", "COORD-749"), true);
  for (const name of ["readCommitSubject", "commitSubjectAffiliatesWithTicket", "assertCommittedReviewState"]) {
    assert.equal(lifecycle.__testing[name], undefined);
  }
  assert.equal(typeof lifecycle.__testing.appendReviewFollowupPlan, "function",
    "plan-writing integration coverage still exercises the lifecycle-owned transition collaborator");
  const file = "coord/engine/scripts/lifecycle.js";
  const source = fs.readFileSync(path.resolve(__dirname, "../../..", file), "utf8");
  const { loc } = countLoc(source);
  assert.ok(loc < 2429, `root must shrink, measured ${loc}`);
  assert.ok(DEFAULT_CONFIG.checks.prodloc.highWater[file] <= 2429, "never increase the prior limit");
  assert.ok(loc <= DEFAULT_CONFIG.checks.prodloc.highWater[file], "root must remain within its production budget");
  assert.doesNotMatch(source, /function (?:readCommitSubject|commitSubjectAffiliatesWithTicket)\(/);
});

test("COORD-858: submitted scope uses declared commits and actual Repo X topology", () => {
  const sha = "a".repeat(40);
  const base = {
    repoNameForCode: (code) => code === "B" ? "backend" : "coord",
    repoCodeForLockRepoName: (name) => name === "backend" ? "B" : name === "coord" ? "X" : null,
    isRepoBackedCode: (code) => code !== "X",
    getRepoRoot: () => "/repos/backend",
    resolveSourceCommitSha: () => sha,
    resolveCommitishInRepo: (_root, commit) => commit === sha ? sha : null,
    fail: (message) => { throw new Error(message); },
  };
  const productService = createReviewState.createReviewSubmissionState(base);
  assert.deepEqual(productService.resolveReviewSubmission("B-858", { Repo: "B" }, { repo: "backend", head: sha }), {
    submission: { repository: "backend", commit: sha }, unresolved_reason: null,
  });
  assert.throws(() => productService.resolveReviewSubmission("B-858", { Repo: "B" }, { repo: "frontend", head: sha }), /lock repository does not match/);
  assert.throws(() => productService.resolveReviewSubmission("B-858", { Repo: "B" }, { repo: "backend" }), /no committed head/);
  assert.throws(() => productService.resolveReviewSubmission("B-858", { Repo: "B" }, { repo: "backend", head: "abc123" }), /full commit/);
  const missingRootService = createReviewState.createReviewSubmissionState({
    ...base,
    getRepoRoot: () => null,
  });
  assert.throws(() => missingRootService.resolveReviewSubmission("B-858", { Repo: "B" }, { repo: "backend", head: sha }), /Could not resolve the declared repository root/);

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord-858-topology-"));
  const coordDir = path.join(workspaceRoot, "coord");
  fs.mkdirSync(coordDir);
  try {
    const noGitLayout = resolveControlPlaneLayout({ coordDir, workspaceRoot });
    assert.equal(noGitLayout.topology, "none");
    assert.equal(noGitLayout.coordRepoRoot, null);
    const noGitService = createReviewState.createReviewSubmissionState({
      ...base,
      controlPlaneLayout: () => noGitLayout,
    });
    assert.deepEqual(noGitService.resolveReviewSubmission("COORD-858", { Repo: "X" }, { repo: "coord", head: "coord-no-git-head" }), {
      submission: null, unresolved_reason: "control-plane repository topology has no Git commit identity",
    });

    execFileSync("git", ["-C", coordDir, "init", "--quiet"]);
    const gitLayout = resolveControlPlaneLayout({ coordDir, workspaceRoot });
    assert.equal(gitLayout.topology, "coord_repository");
    assert.equal(gitLayout.coordRepoRoot, coordDir);
    execFileSync("git", ["-C", coordDir, "config", "user.email", "coord858@example.test"]);
    execFileSync("git", ["-C", coordDir, "config", "user.name", "COORD-858 fixture"]);
    fs.writeFileSync(path.join(coordDir, "scope.txt"), "committed Repo X scope\n");
    execFileSync("git", ["-C", coordDir, "add", "scope.txt"]);
    execFileSync("git", ["-C", coordDir, "commit", "--quiet", "-m", "COORD-858 scope fixture"]);
    const coordHead = execFileSync("git", ["-C", coordDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const gitService = createReviewState.createReviewSubmissionState({
      ...base,
      controlPlaneLayout: () => gitLayout,
      resolveCommitishInRepo: (root, commit) => root === coordDir && commit === coordHead ? coordHead : null,
    });
    assert.deepEqual(gitService.resolveReviewSubmission("COORD-858", { Repo: "X" }, { repo: "coord", head: coordHead }), {
      submission: { repository: "coord", commit: coordHead }, unresolved_reason: null,
    }, "Repo X records an actual committed coord head when that Git topology exists");
    assert.throws(() => gitService.resolveReviewSubmission("COORD-858", { Repo: "X" }, { repo: "coord", head: "coord-no-git-head" }), /outside a verified no-Git/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("COORD-858: submission scope replacement uses canonical plan CAS and removes scope for no-Git sentinel", () => {
  const raw = "canonical-plan-bytes";
  const rawSymbol = Symbol("raw");
  let record = { [rawSymbol]: raw, review_submission: { repository: "backend", commit: "b".repeat(40) }, independent_reviews: [{ id: "keep" }] };
  const writes = [];
  const service = createReviewState.createReviewSubmissionState({
    BOARD_RAW_SYMBOL: rawSymbol,
    readPlanRecord: () => record,
    planRecordPath: () => "/plans/B-858.json",
    writeCanonicalJsonFile: (file, next, options) => { writes.push(["json", file, next, options]); record = { ...next, [rawSymbol]: JSON.stringify(next) }; },
    writePlanCompatibilityBlockFromRecord: (_ticket, next) => writes.push(["markdown", next]),
    fail: (message) => { throw new Error(message); },
  });
  const replacement = { submission: { repository: "backend", commit: "c".repeat(40) }, unresolved_reason: null };
  assert.deepEqual(service.persistReviewSubmission("B-858", replacement), replacement);
  assert.deepEqual(record.review_submission, replacement.submission);
  assert.deepEqual(record.independent_reviews, [{ id: "keep" }]);
  assert.deepEqual(writes[0][3], { expectedRaw: raw });
  assert.equal(writes[1][0], "markdown");
  const writesAfterReplacement = writes.length;
  assert.deepEqual(service.persistReviewSubmission("B-858", replacement), replacement,
    "persisting the same immutable scope is an idempotent no-op");
  assert.equal(writes.length, writesAfterReplacement);
  assert.deepEqual(service.persistReviewSubmission("B-858", { submission: null, unresolved_reason: "no Git head" }), {
    submission: null, unresolved_reason: "no Git head",
  });
  assert.equal(Object.hasOwn(record, "review_submission"), false);
  const writesAfterRemoval = writes.length;
  const unresolved = { submission: null, unresolved_reason: "no Git head" };
  assert.deepEqual(service.persistReviewSubmission("B-858", unresolved), unresolved,
    "repeating an unresolved no-Git submission is an idempotent no-op");
  assert.equal(writes.length, writesAfterRemoval);

  const unsafeWrites = [];
  const missingRawService = createReviewState.createReviewSubmissionState({
    BOARD_RAW_SYMBOL: rawSymbol,
    readPlanRecord: () => ({ review_submission: { repository: "backend", commit: "b".repeat(40) } }),
    planRecordPath: () => "/plans/B-858.json",
    writeCanonicalJsonFile: (...args) => unsafeWrites.push(["json", ...args]),
    writePlanCompatibilityBlockFromRecord: (...args) => unsafeWrites.push(["markdown", ...args]),
    fail: (message) => { throw new Error(message); },
  });
  assert.throws(() => missingRawService.persistReviewSubmission("B-858", replacement), /verify the canonical plan bytes/);
  assert.deepEqual(unsafeWrites, [], "without the raw-byte CAS token, neither projection is written");

  let emptyRecord = { [rawSymbol]: "empty-canonical-plan" };
  const initialWrites = [];
  const initialService = createReviewState.createReviewSubmissionState({
    BOARD_RAW_SYMBOL: rawSymbol,
    readPlanRecord: () => emptyRecord,
    planRecordPath: () => "/plans/B-858.json",
    writeCanonicalJsonFile: (_file, next, options) => {
      initialWrites.push(["json", options]);
      emptyRecord = { ...next, [rawSymbol]: JSON.stringify(next) };
    },
    writePlanCompatibilityBlockFromRecord: (_ticket, next) => initialWrites.push(["markdown", next.review_submission]),
    fail: (message) => { throw new Error(message); },
  });
  assert.deepEqual(initialService.persistReviewSubmission("B-858", replacement), replacement);
  assert.deepEqual(emptyRecord.review_submission, replacement.submission);
  assert.deepEqual(initialWrites.map(([kind]) => kind), ["json", "markdown"],
    "a first submission is written to both canonical plan projections");
});
