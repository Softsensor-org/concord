process.env.COORD_PROJECT_CONFIG = require("node:path").resolve(__dirname, "fixtures", "hermetic-project.config.js"); // COORD-967: hermetic board/integration branch defaults
const { gitFixture, gitFixtureEnv } = require("./test-git-fixture.js"); // COORD-952
// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("../../scripts/governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const createWorktreeOps = require("./worktree-ops.js");
const { gitTry: realGitTry } = require("./git-ops.js");
const {
  createTempGitRepoWithOrigin,
  runGit,
  writeRepoFile,
  seedCoordRuntimeGitignoreFixture,
  withScopedGovernanceTestContext,
} = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { state, DEFAULT_PATHS } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));

// Stub the injected cross-module deps; the pure helpers below don't shell out.
function build(overrides = {}) {
  return createWorktreeOps({
    fail: (m) => { throw new Error(m); },
    configuredRepoArgDescription: () => "backend, frontend",
    getRepoRoot: (code) => `/repo/${code}`,
    getRows: () => [],
    rowsById: () => new Map(),
    isDoingStatus: (s) => s === "doing",
    isRepoBackedCode: (code) => code === "B" || code === "F",
    readBoard: () => ({}),
    readPlanRecord: () => null,
    repoCodeForCliRepoArg: (a) => a,
    repoNameForCode: (code) => ({ B: "backend", F: "frontend" }[code] || code),
    resolveTicketGitContext: () => ({ repoRoot: null, branch: null, worktree: null, lock: null }),
    ...overrides,
  });
}

test("factory returns the full worktree-ops surface", () => {
  const w = build();
  for (const fn of ["ensureGitWorktree", "cleanupWorktree", "runGit", "auditWorktrees",
    "withPreparedTicketWorkspace", "coordWorktreesRoot", "inferTicketIdFromPath"]) {
    assert.equal(typeof w[fn], "function", `${fn} should be exported`);
  }
});

test("inferTicketIdFromPath finds the ticket id segment, deepest-first", () => {
  const w = build();
  assert.equal(w.inferTicketIdFromPath(`/x/.worktrees/owner/FE-12`), "FE-12");
  assert.equal(w.inferTicketIdFromPath(`/x/COORD-7/.worktrees/o/BE-3`), "BE-3");
  assert.equal(w.inferTicketIdFromPath(`/x/y/z`), null);
});

test("defaultWorktreePath routes X to coord and codes to their repo root", () => {
  const w = build();
  assert.ok(w.defaultWorktreePath("X", "claudea11", "COORD-1").endsWith(path.join(".worktrees", "claudea11", "COORD-1")));
  assert.equal(w.defaultWorktreePath("B", "o", "BE-2"), path.join("/repo/B", ".worktrees", "o", "BE-2"));
});

test("isHelperWorktree flags tmp/merge/pr helper worktrees, not normal ones", () => {
  const w = build();
  assert.equal(w.isHelperWorktree({ path: "/tmp/whatever" }), true);
  assert.equal(w.isHelperWorktree({ path: "/x/merge-abc" }), true);
  assert.equal(w.isHelperWorktree({ path: "/x/FE-1", branch: "tmp/foo" }), true);
  assert.equal(w.isHelperWorktree({ path: "/x/.worktrees/o/FE-1", branch: "agent/o-fe-1" }), false);
});

test("repoBootstrapLabel maps X and unknown to coord, codes to repo name", () => {
  const w = build();
  assert.equal(w.repoBootstrapLabel("X"), "coord");
  assert.equal(w.repoBootstrapLabel("Z"), "coord");
  assert.equal(w.repoBootstrapLabel("B"), "backend");
});

test("COORD-697: PR branch publication reconciles a lost acknowledgement and skips retry", () => {
  const repo = createTempGitRepoWithOrigin("coord697-branch-push-", { "README.md": "seed\n" });
  const branch = "agent/codexa680-b-697";
  runGit(repo.repoRoot, ["checkout", "-b", branch]);
  writeRepoFile(repo.repoRoot, "feature.txt", "delta\n");
  runGit(repo.repoRoot, ["add", "feature.txt"]);
  runGit(repo.repoRoot, ["commit", "-m", "feature"]);
  const commitSha = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);

  const loseAckAfterRealPush = (repoRoot, args) => {
    const result = realGitTry(repoRoot, args);
    return args[0] === "push"
      ? { status: 128, stdout: "", stderr: "connection closed after remote update" }
      : result;
  };
  const receipts = [];
  const first = build().pushBranchToOrigin(repo.repoRoot, branch, {
    gitFn: loseAckAfterRealPush,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(first.status, "pushed");
  assert.equal(first.pushed, true);
  assert.equal(first.acknowledged, false);
  assert.equal(first.ack_lost, true);
  assert.equal(runGit(repo.remoteRoot, ["rev-parse", branch]), commitSha);
  assert.equal(runGit(repo.repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]), `origin/${branch}`);
  assert.equal(receipts.length, 1);

  const second = build().pushBranchToOrigin(repo.repoRoot, branch);
  assert.equal(second.status, "already_present");
  assert.equal(second.pushed, false);
  assert.equal(second.attempted, undefined);
  assert.equal(runGit(repo.remoteRoot, ["rev-parse", branch]), commitSha);
});

test("COORD-358: repo-X ticket workspace is a real git worktree and cleanup removes branch", () => {
  const w = build();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-x-worktree-"));
  const worktree = path.join(tmp, "COORD-358");
  const branch = `test/coord-358-${process.pid}-${Date.now()}`;
  const prepared = w.ensureTicketWorkspace({
    repoCode: "X",
    worktree,
    branch,
  });
  try {
    assert.equal(prepared.createdWorktree, true);
    assert.equal(prepared.createdBranch, true);
    assert.equal(w.isInsideGitWorkTree(worktree), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", "scripts", "worktree-ops.js")), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", ".runtime", "locks")), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", ".runtime", "plans")), true);
    const runtimeIgnore = seedCoordRuntimeGitignoreFixture(path.join(worktree, "coord"));
    assert.equal(
      fs.readFileSync(runtimeIgnore.ignorePath, "utf8"),
      runtimeIgnore.contents,
      "the disposable ticket-worktree fixture must use the runtime ignore contract"
    );
    const planPath = path.join(runtimeIgnore.runtimeDir, "plans", "COORD-358-fixture.json");
    const lockPath = path.join(runtimeIgnore.runtimeDir, "locks", "COORD-358-fixture.lock");
    fs.writeFileSync(planPath, "{}\n");
    fs.writeFileSync(lockPath, "{}\n");
    const status = runGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    assert.match(status, /\?\? coord\/\.runtime\/plans\/COORD-358-fixture\.json/);
    assert.doesNotMatch(status, /COORD-358-fixture\.lock/);
  } finally {
    w.cleanupPreparedTicketWorkspace(prepared);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const liveBranch = w.gitOutput(path.dirname(require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js")).COORD_DIR), ["branch", "--list", branch]);
  assert.equal(String(liveBranch || "").trim(), "");
});

test("COORD-788: missing explicit Repo-X base refuses before creating its worktree", () => {
  const repo = createTempGitRepoWithOrigin("coord788-missing-base-", { "seed.txt": "seed\n" });
  const worktree = `${repo.repoRoot}-missing-base-worktree`;
  const branch = `test/coord-788-${process.pid}-${Date.now()}`;
  const worktreeOps = build({
    controlPlaneLayout: () => ({
      coordRepoRoot: repo.repoRoot,
      coordDir: repo.repoRoot,
      coordPathPrefix: "",
      topology: "coord_repository",
    }),
  });

  try {
    assert.throws(
      () => worktreeOps.ensureTicketWorkspace({
        repoCode: "X",
        worktree,
        branch,
        base: "missing-explicit-base",
      }),
      /missing-explicit-base is missing.*Refresh the canonical base first/s
    );
    assert.equal(fs.existsSync(worktree), false, "a missing explicit base must not create a worktree");
    assert.equal(git(repo.repoRoot, ["branch", "--list", branch]), "", "a missing explicit base must not create a branch");
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

// --- Closed-ticket workspace cleanup (relocated from lifecycle.js, COORD-089) ---

test("factory exposes the closed-ticket workspace-cleanup surface", () => {
  const w = build();
  for (const fn of ["cleanupTicketWorktree", "cleanupCoordTicketWorktrees", "cleanupClosedTicketWorkspace"]) {
    assert.equal(typeof w[fn], "function", `${fn} should be exported`);
  }
});

test("cleanupTicketWorktree is a no-op for non-repo-backed rows", () => {
  const w = build();
  assert.equal(w.cleanupTicketWorktree("COORD-1", { Repo: "X" }, {}), null);
  assert.equal(w.cleanupTicketWorktree("COORD-1", { Repo: "Z" }, {}), null);
});

test("cleanupTicketWorktree returns null when the repo-backed ticket has no live worktree", () => {
  const w = build({
    // No resolved worktree path -> nothing to remove; never shells out to git.
    resolveTicketGitContext: () => ({ repoRoot: "/repo/B", branch: "agent/x", worktree: null, lock: null }),
  });
  assert.equal(w.cleanupTicketWorktree("BE-1", { Repo: "B" }, {}), null);
});

test("cleanupClosedTicketWorkspace dispatches repo-backed -> worktree removal, X -> coord prune, else null", () => {
  const calls = [];
  const w = build({
    isRepoBackedCode: (code) => code === "B",
    // Repo-backed path delegates to cleanupTicketWorktree, which short-circuits
    // to null here because resolveTicketGitContext yields no worktree.
    resolveTicketGitContext: () => {
      calls.push("resolveTicketGitContext");
      return { repoRoot: "/repo/B", branch: null, worktree: null, lock: null };
    },
  });
  assert.equal(w.cleanupClosedTicketWorkspace("BE-9", { Repo: "B" }, {}), null);
  assert.ok(calls.includes("resolveTicketGitContext"), "repo-backed dispatch must consult git context");
  // Unknown repo code -> neither branch fires.
  assert.equal(w.cleanupClosedTicketWorkspace("Q-1", { Repo: "Z" }, {}), null);
});

test("cleanupCoordTicketWorktrees removes the ticket's coord worktree dir and reports it", () => {
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const originalQuestionsPath = state.QUESTIONS_PATH;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-coord-cleanup-"));
  // coordWorktreesRoot() = dirname(QUESTIONS_PATH)/.worktrees
  state.QUESTIONS_PATH = path.join(tmp, "QUESTIONS.md");
  try {
    const w = build();
    const ticketDir = path.join(tmp, ".worktrees", "claudea11", "COORD-200");
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, "scratch.txt"), "x", "utf8");

    const result = w.cleanupCoordTicketWorktrees("COORD-200");

    assert.deepEqual(result, { removed_worktrees: [ticketDir] });
    assert.equal(fs.existsSync(ticketDir), false, "ticket worktree dir must be removed");
    // pruneEmptyParents climbs to the now-empty owner dir.
    assert.equal(fs.existsSync(path.join(tmp, ".worktrees", "claudea11")), false, "empty owner parent must be pruned");

    // No matching worktree -> null.
    assert.equal(w.cleanupCoordTicketWorktrees("COORD-999"), null);
  } finally {
    state.QUESTIONS_PATH = originalQuestionsPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-786 parent pruning skips vanished levels and preserves occupied ancestors", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-prune-boundary-"));
  try {
    const owner = path.join(tmp, "owner");
    fs.mkdirSync(owner);
    fs.writeFileSync(path.join(owner, "keep.txt"), "keep\n");
    build().pruneEmptyParents(path.join(owner, "vanished", "ticket"), tmp);
    assert.equal(fs.readFileSync(path.join(owner, "keep.txt"), "utf8"), "keep\n");
    assert.equal(fs.existsSync(path.join(owner, "vanished")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-786 worktree audit skips files and directories without ticket IDs", () => {
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const originalQuestionsPath = state.QUESTIONS_PATH;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-audit-shape-"));
  state.QUESTIONS_PATH = path.join(tmp, "QUESTIONS.md");
  try {
    const root = path.join(tmp, ".worktrees");
    const owner = path.join(root, "owner");
    fs.mkdirSync(path.join(owner, "COORD-912"), { recursive: true });
    fs.mkdirSync(path.join(owner, "not-a-ticket"), { recursive: true });
    fs.writeFileSync(path.join(root, "stray-owner-file"), "ignored\n");
    fs.writeFileSync(path.join(owner, "stray-ticket-file"), "ignored\n");

    const worktrees = build({ controlPlaneLayout: () => null }).auditCoordWorktrees(new Map()).worktrees;
    assert.deepEqual(worktrees.map((entry) => entry.ticket), ["COORD-912"]);
    assert.equal(worktrees[0].path, path.join(owner, "COORD-912"));
  } finally {
    state.QUESTIONS_PATH = originalQuestionsPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-644: control-plane audit identifies only doing Repo-X rows without a worktree", () => {
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const originalQuestionsPath = state.QUESTIONS_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-missing-worktree-audit-"));
  state.QUESTIONS_PATH = path.join(tempDir, "QUESTIONS.md");
  const rows = [
    { ID: "DEBT-643", Repo: "X", Status: "doing", Owner: "codexa644" },
    { ID: "DEBT-644", Repo: "X", Status: "doing", Owner: "codexa644" },
    { ID: "COORD-644-REVIEW", Repo: "X", Status: "review", Owner: "codexa644" },
    { ID: "PRODUCT-644-DOING", Repo: "B", Status: "doing", Owner: "codexa644" },
  ];
  const statusChecks = [];
  const presentPath = path.join(tempDir, ".worktrees", "codexa644", "DEBT-644");
  fs.mkdirSync(presentPath, { recursive: true });
  try {
    const report = build({
      controlPlaneLayout: () => null,
      isDoingStatus: (status) => {
        statusChecks.push(status);
        return status === "doing";
      },
    }).auditCoordWorktrees(
      new Map(rows.map((row) => [row.ID, row])),
    );
    assert.deepEqual(report.missing_doing_worktrees, ["DEBT-643"],
      "doctor should diagnose only the absent worktree for an active Repo-X ticket");
    assert.deepEqual(report.worktrees.map((entry) => entry.ticket), ["DEBT-644"],
      "an unrelated existing coord worktree is discovered but does not conceal the missing ticket");
    assert.ok(statusChecks.includes("doing"),
      "the missing-worktree filter evaluates active Repo-X rows through the supplied status contract");
  } finally {
    state.QUESTIONS_PATH = originalQuestionsPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const { __testing } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));


test("resolveTicketBaseRef precedence: explicit > plan record > registry > dev (COORD-007)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord007-baseref-"));
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  // Plan record carrying its own expected_closeout.base_ref (B-700 maps to
  // the repo-backed "B" code so the record is read without normalization
  // overriding base_ref).
  fs.writeFileSync(
    path.join(recordsDir, "B-700.json"),
    JSON.stringify({
      schema_version: 1,
      ticket_id: "B-700",
      governance: { expected_closeout: { method: "pr", base_ref: "release-2.7.5" } },
    }, null, 2),
    "utf8"
  );
  // No plan record for B-701 — tier 2 misses, falls through to per-repo
  // registry (tier 3).

  withScopedGovernanceTestContext({
    PLAN_RECORDS_DIR: recordsDir,
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, B: "development" },
  }, () => {
    // 1. Explicit options.base wins over everything.
    assert.equal(
      __testing.resolveTicketBaseRef("B-700", { Repo: "B" }, { base: "hotfix" }),
      "hotfix"
    );
    // 2. Plan record's expected_closeout.base_ref wins over registry default.
    assert.equal(
      __testing.resolveTicketBaseRef("B-700", { Repo: "B" }, {}),
      "release-2.7.5"
    );
    // 3. Per-repo registry default when no plan record carries a base_ref.
    assert.equal(
      __testing.resolveTicketBaseRef("B-701", { Repo: "B" }, {}),
      "development"
    );
    // 4. Template "dev" fallback when registry has no entry for the repo.
    assert.equal(
      __testing.resolveTicketBaseRef("UNK-1", { Repo: "F" }, {}),
      "dev"
    );
    // 5. Empty options.base does not block fallback to plan record.
    assert.equal(
      __testing.resolveTicketBaseRef("B-700", { Repo: "B" }, { base: "" }),
      "release-2.7.5"
    );
    // 6. options.baseRef honored when options.base absent.
    assert.equal(
      __testing.resolveTicketBaseRef("B-700", { Repo: "B" }, { baseRef: "spike" }),
      "spike"
    );
  });
});

// ===========================================================================
// COORD-125: configurable defaultStartBaseRef + fresh-from-origin start base.
// ===========================================================================

test("resolveTicketBaseRef precedence (COORD-125): per-repo startBaseRef > global defaultStartBaseRef > integrationBranch", () => {
  withScopedGovernanceTestContext({
    REPO_INTEGRATION_BRANCHES: { B: "main", F: "main" },
    REPO_START_BASE_REFS: { B: "release-b", F: null },
    DEFAULT_START_BASE_REF: "develop",
  }, () => {
    const r = __testing.resolveTicketBaseRef;
    // Per-repo startBaseRef beats the global default and integrationBranch.
    assert.equal(r("B-1", { Repo: "B" }, {}), "release-b");
    // No per-repo override -> global defaultStartBaseRef beats integrationBranch.
    assert.equal(r("F-1", { Repo: "F" }, {}), "develop");
    // Clear the global default -> falls back to per-repo integrationBranch.
    withScopedGovernanceTestContext({ DEFAULT_START_BASE_REF: null }, () => {
      assert.equal(r("F-1", { Repo: "F" }, {}), "main");
      // Explicit options.base still wins over all config layers.
      assert.equal(r("F-1", { Repo: "F" }, { base: "hotfix" }), "hotfix");
    });
    withScopedGovernanceTestContext({
      REPO_INTEGRATION_BRANCHES: {},
      REPO_START_BASE_REFS: {},
      DEFAULT_START_BASE_REF: null,
    }, () => {
      // Unknown repo with no config -> engine "dev" default.
      assert.equal(r("Z-1", { Repo: "Z" }, {}), "dev");
    });
  });
});

test("Repo-X start base chooses main over stale dev with or without a seeded plan (COORD-787)", () => {
  // Model the incident: stale dev remains at the first commit while main has
  // advanced and is published as the control-plane remote's default branch.
  const repo = createTempGitRepoWithOrigin("coord787-start-base-", { "required.txt": "stale dev\n" });
  const worktreeOps = build({
    controlPlaneLayout: () => ({
      coordRepoRoot: repo.repoRoot,
      coordDir: repo.repoRoot,
      coordPathPrefix: "",
      topology: "coord_repository",
    }),
  });

  try {
    runGit(repo.repoRoot, ["checkout", "-b", "main"]);
    writeRepoFile(repo.repoRoot, "required.txt", "current main\n");
    runGit(repo.repoRoot, ["add", "required.txt"]);
    runGit(repo.repoRoot, ["commit", "-m", "advance main"]);
    runGit(repo.repoRoot, ["push", "origin", "main"]);
    runGit(repo.repoRoot, ["fetch", "origin", "main"]);
    runGit(repo.repoRoot, ["remote", "set-head", "origin", "main"]);

    assert.notEqual(runGit(repo.repoRoot, ["rev-parse", "dev"]), runGit(repo.repoRoot, ["rev-parse", "main"]));
    assert.equal(
      worktreeOps.resolveTicketBaseRef("COORD-787", { Repo: "X" }, {}),
      "main",
      "a first-start Repo-X ticket must use origin/HEAD's integration branch, not stale dev"
    );
    const plannedWorktreeOps = build({
      controlPlaneLayout: () => ({
        coordRepoRoot: repo.repoRoot,
        coordDir: repo.repoRoot,
        coordPathPrefix: "",
        topology: "coord_repository",
      }),
      readPlanRecord: () => ({
        governance: { expected_closeout: { base_ref: "main" } },
      }),
    });
    assert.equal(
      plannedWorktreeOps.resolveTicketBaseRef("COORD-787", { Repo: "X" }, {}),
      "main",
      "the canonical main closeout base must remain authoritative over stale dev"
    );

  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

// --- ensureGitWorktree fresh-from-origin + offline fallback (real git sandbox) ---


function git(cwd, args) {
  return gitFixture(cwd, args, { env: gitFixtureEnv() });
}

// Builds: a bare "origin" repo with a `main` branch, plus a clone of it. The
// clone's local main is intentionally left BEHIND origin/main so we can prove
// `gov start` branches from the FRESH origin tip, not the stale local ref.
function makeOriginAndClone(tmp) {
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");
  const clone = path.join(tmp, "clone");
  fs.mkdirSync(origin, { recursive: true });
  gitFixture(origin, ["init", "--bare", "-b", "main"]);

  fs.mkdirSync(seed, { recursive: true });
  gitFixture(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.email", "t@t.t"]);
  git(seed, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(seed, "f.txt"), "v1\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "c1"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main"]);

  git(tmp, ["clone", origin, clone]);
  git(clone, ["config", "user.email", "t@t.t"]);
  git(clone, ["config", "user.name", "t"]);

  // Advance origin/main by one commit (via seed) so the clone's local main +
  // its origin/main tracking ref are both behind the real remote tip.
  fs.writeFileSync(path.join(seed, "f.txt"), "v2\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "c2-fresh"]);
  const freshSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["push", "origin", "main"]);
  const staleSha = git(clone, ["rev-parse", "main"]);

  return { origin, clone, freshSha, staleSha };
}

test("ensureGitWorktree (COORD-125) branches a new ticket from the FRESH origin/<base>, not the stale local ref", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-coord125-fresh-"));
  try {
    const { clone, freshSha, staleSha } = makeOriginAndClone(tmp);
    assert.notEqual(freshSha, staleSha, "sandbox precondition: origin moved ahead of local");

    const w = build({ getRepoRoot: () => clone });
    const worktree = path.join(tmp, "wt-fresh");
    const result = w.ensureGitWorktree({
      repoCode: "B",
      worktree,
      branch: "agent/x-coord-125",
      base: "main",
    });
    assert.equal(result.createdBranch, true);
    // The new branch HEAD must equal the FRESH origin tip (freshened via fetch),
    // proving start did not cut from the stale local main.
    const headSha = git(worktree, ["rev-parse", "HEAD"]);
    assert.equal(headSha, freshSha, "new worktree must be based on the freshened origin/main");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureGitWorktree (COORD-125) offline fallback: warns + branches from LOCAL base when origin fetch fails (never hard-fails)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-coord125-offline-"));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  try {
    const { clone, staleSha } = makeOriginAndClone(tmp);
    // Break the remote so the bounded fetch fails -> offline path.
    git(clone, ["remote", "set-url", "origin", path.join(tmp, "does-not-exist.git")]);

    const w = build({ getRepoRoot: () => clone });
    const worktree = path.join(tmp, "wt-offline");
    const result = w.ensureGitWorktree({
      repoCode: "B",
      worktree,
      branch: "agent/x-coord-125-offline",
      base: "main",
    });
    assert.equal(result.createdBranch, true, "offline start must still create the branch (no hard-fail)");
    // Falls back to a local base ref (origin/main tracking ref, still at the stale sha).
    const headSha = git(worktree, ["rev-parse", "HEAD"]);
    assert.equal(headSha, staleSha, "offline fallback uses the local base ref");
    assert.ok(
      warnings.some((m) => /could not fetch origin main/i.test(m) && /LOCAL base/i.test(m)),
      "offline fallback must emit a clear staleness warning"
    );
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureGitWorktree (COORD-125) hard-fails only when neither origin nor any local base ref resolves", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-coord125-nobase-"));
  try {
    const { clone } = makeOriginAndClone(tmp);
    git(clone, ["remote", "set-url", "origin", path.join(tmp, "missing.git")]);

    const w = build({ getRepoRoot: () => clone });
    assert.throws(
      () => w.ensureGitWorktree({
        repoCode: "B",
        worktree: path.join(tmp, "wt-nobase"),
        branch: "agent/x-coord-125-nobase",
        base: "nonexistent-branch",
      }),
      /Cannot create governed .* worktree from .*nonexistent-branch/,
      "no origin AND no local base must fail closed"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetchRepoRef (COORD-125) is bounded by a fetch timeout and reports failure on a hung/missing remote", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wto-coord125-bound-"));
  try {
    const clone = path.join(tmp, "clone");
    gitFixture(tmp, ["init", clone]);
    git(clone, ["remote", "add", "origin", path.join(tmp, "missing.git")]);
    const w = build({ getRepoRoot: () => clone });
    // A short explicit timeout: an unreachable remote returns false (not a hang).
    const ok = w.fetchRepoRef(clone, "main", { timeoutMs: 2000 });
    assert.equal(ok, false, "fetch of a missing remote must report failure, bounded by the timeout");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-856: each worktree-ops command printed for an operator, built for a
// path with a space, parentheses, a dollar sign and a single quote, parses with
// a POSIX shell-word splitter (and /bin/sh) to the argv it intends.
const { HOSTILE_PATH_SEGMENT, hostileTempDir, splitPosixCommands, splitPosixShellWords, shellArgv } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/fixtures/posix-shell-words.js"));
function coord856Argv(command, expected) {
  assert.deepStrictEqual(splitPosixShellWords(command), expected, command);
  assert.deepStrictEqual(shellArgv(command), expected, `/bin/sh agrees: ${command}`);
}

test("COORD-856: bootstrap and missing-base guidance quote the worktree and repository paths", () => {
  const w = build();
  const worktree = `/tmp/${HOSTILE_PATH_SEGMENT}wt`;
  const guidance = w.buildDependencyBootstrapGuidance("B", worktree);
  coord856Argv(guidance.commands[0], ["git", "-C", "backend", "fetch", "origin", guidance.base_ref]);
  coord856Argv(guidance.commands[1], ["pnpm", "--dir", worktree, "install", "--frozen-lockfile"]);
  const repoRoot = `/srv/${HOSTILE_PATH_SEGMENT}coord`;
  const message = w.formatMissingStartBaseRefMessage("X", repoRoot, "main");
  coord856Argv(/^Refresh the canonical base first: (.+)$/m.exec(message)[1], ["git", "-C", repoRoot, "fetch", "origin", "main"]);
});

test("COORD-856: the offline start warning quotes the repository path in its refresh command", () => {
  const tmp = fs.realpathSync(hostileTempDir("wto-offline"));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  try {
    const { clone } = makeOriginAndClone(tmp);
    git(clone, ["remote", "set-url", "origin", path.join(tmp, "does-not-exist.git")]);
    build({ getRepoRoot: () => clone }).ensureGitWorktree({ repoCode: "B", worktree: path.join(tmp, "wt (offline)"), branch: "agent/x-coord-856", base: "main" });
    const refresh = /refresh with `([^`]+)`/.exec(warnings.join("\n"));
    assert.ok(refresh, warnings.join("\n"));
    coord856Argv(refresh[1], ["git", "-C", clone, "fetch", "origin", "main"]);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-856: the unpublished-branch and dirty-cleanup refusals quote the repository and worktree paths", () => {
  const repo = createTempGitRepoWithOrigin(`${HOSTILE_PATH_SEGMENT}pr-`, { "README.md": "seed\n" });
  try {
    runGit(repo.repoRoot, ["checkout", "-b", "agent/x-coord-856"]);
    writeRepoFile(repo.repoRoot, "feature.txt", "delta\n");
    runGit(repo.repoRoot, ["add", "feature.txt"]);
    runGit(repo.repoRoot, ["commit", "-m", "feature"]);
    const w = build();
    assert.throws(() => w.preflightPrBranch(repo.repoRoot, "agent/x-coord-856", "dev", {}), (error) => {
      const push = /Run `([^`]+)` or pass/.exec(error.message);
      assert.ok(push, error.message);
      coord856Argv(push[1], ["git", "-C", repo.repoRoot, "push", "-u", "origin", "agent/x-coord-856"]);
      return true;
    });
    runGit(repo.repoRoot, ["checkout", "dev"]);
    const worktree = path.join(repo.repoRoot, ".worktrees", "o", "COORD-856 $(x) 'y'");
    runGit(repo.repoRoot, ["worktree", "add", worktree, "agent/x-coord-856"]);
    writeRepoFile(worktree, "uncommitted.txt", "work\n");
    assert.throws(() => w.removeGovernedWorktree({ repoRoot: repo.repoRoot, worktree, branch: null, deleteBranch: false }), (error) => {
      const discard = /discard it deliberately \((.+)\), then retry/.exec(error.message);
      assert.ok(discard, error.message);
      assert.deepStrictEqual(splitPosixCommands(discard[1]), [["git", "-C", worktree, "checkout", "--", "."], ["git", "-C", worktree, "clean", "-fd"]], discard[1]);
      return true;
    });
    assert.equal(fs.existsSync(path.join(worktree, "uncommitted.txt")), true, "the refusal discarded nothing");
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

// COORD-856: the functions whose printed commands now quote their paths keep
// every branch exercised: base-ref fallbacks, reuse of an existing worktree, a
// pinned base commit, an unresolvable fetched base, the PR preflight outcomes
// and the governed-removal failure paths.
const { DEFAULT_INTEGRATION_BRANCH: COORD856_DEFAULT_BRANCH } = require("../../paths.js");

// Re-require worktree-ops against a git-ops whose gitTry is wrapped, so a test
// can make one git call answer as a failing or unusual git would (the
// COORD-562 doctor-report pattern). The real module is restored afterwards.
function withWrappedGitTry(wrap, run) {
  const gitOps = require("./git-ops.js");
  const realGitTry = gitOps.gitTry;
  const modulePath = require.resolve("./worktree-ops.js");
  const cached = require.cache[modulePath];
  try {
    gitOps.gitTry = (dir, args, options) => wrap(realGitTry, dir, args, options);
    delete require.cache[modulePath];
    const factory = require("./worktree-ops.js");
    return run((overrides = {}) => factory({
      fail: (m) => { throw new Error(m); },
      configuredRepoArgDescription: () => "backend, frontend",
      getRows: () => [], rowsById: () => new Map(), isDoingStatus: (s) => s === "doing",
      isRepoBackedCode: (code) => code === "B" || code === "F", readBoard: () => ({}), readPlanRecord: () => null,
      repoCodeForCliRepoArg: (a) => a, repoNameForCode: (code) => code,
      resolveTicketGitContext: () => ({ repoRoot: null, branch: null, worktree: null, lock: null }),
      ...overrides,
    }));
  } finally {
    gitOps.gitTry = realGitTry;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
}

function coord856Repo() {
  const tmp = fs.realpathSync(hostileTempDir("wto-branches"));
  const { clone } = makeOriginAndClone(tmp);
  return { tmp, clone };
}

test("COORD-856: a repo code with no configured integration branch falls back to the engine default", () => {
  const { tmp, clone } = coord856Repo();
  try {
    const w = build({ isRepoBackedCode: () => true, repoNameForCode: (code) => code, getRepoRoot: () => clone });
    assert.equal(w.buildDependencyBootstrapGuidance("Z", "/tmp/wt").base_ref, COORD856_DEFAULT_BRANCH);
    // An already-registered worktree path is reused as-is, whatever the base.
    assert.deepStrictEqual(w.ensureGitWorktree({ repoCode: "Z", worktree: clone, branch: "main" }),
      { createdWorktree: false, createdBranch: false, repoCode: "Z", worktree: clone, branch: "main" });
    // A pinned base commit cuts the new branch from exactly that commit.
    const pinned = git(clone, ["rev-parse", "HEAD"]);
    const worktree = path.join(tmp, "wt (pinned)");
    const result = w.ensureGitWorktree({ repoCode: "Z", worktree, branch: "agent/x-coord-856-pinned", base: "main", baseCommit: pinned });
    assert.deepStrictEqual(result, { createdWorktree: true, createdBranch: true, repoCode: "Z", worktree, branch: "agent/x-coord-856-pinned", base_commit: pinned });
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), pinned);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-856: a fetched base that leaves no origin ref refuses with the quoted missing-base guidance", () => {
  const { tmp, clone } = coord856Repo();
  try {
    withWrappedGitTry((real, dir, args, options) => (args[0] === "fetch" ? { status: 0, stdout: "", stderr: "" } : real(dir, args, options)), (make) => {
      const w = make({ getRepoRoot: () => clone });
      assert.throws(() => w.ensureGitWorktree({ repoCode: "X", worktree: path.join(tmp, "wt"), branch: "agent/x-coord-856-missing", base: "no-such-base" }), (error) => {
        coord856Argv(/^Refresh the canonical base first: (.+)$/m.exec(error.message)[1], ["git", "-C", clone, "fetch", "origin", "origin/no-such-base"]);
        return true;
      });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-856: PR preflight compares against a local base without an origin ref and accepts a published branch", () => {
  const { tmp, clone } = coord856Repo();
  try {
    const w = build();
    git(clone, ["branch", "local-base"]);
    git(clone, ["branch", "agent/x-coord-856-empty"]);
    assert.throws(() => w.preflightPrBranch(clone, "agent/x-coord-856-empty", "local-base", {}), /Branch agent\/x-coord-856-empty has no commits ahead of local-base\./);
    git(clone, ["checkout", "-q", "-b", "agent/x-coord-856-pub"]);
    fs.writeFileSync(path.join(clone, "f.txt"), "pub\n");
    git(clone, ["commit", "-qam", "pub"]);
    git(clone, ["push", "-q", "origin", "agent/x-coord-856-pub"]);
    assert.deepStrictEqual(w.preflightPrBranch(clone, "agent/x-coord-856-pub", "main", {}), { localAhead: 1, pushReceipt: null });
    // A remote branch that exists but carries nothing beyond the base refuses
    // before PR creation, even when the local branch is ahead.
    git(clone, ["push", "-q", "origin", "origin/main:refs/heads/agent/x-coord-856-stale"]);
    git(clone, ["fetch", "-q", "origin"]);
    git(clone, ["checkout", "-q", "-b", "agent/x-coord-856-stale", "origin/main"]);
    fs.writeFileSync(path.join(clone, "f.txt"), "local only\n");
    git(clone, ["commit", "-qam", "local only"]);
    assert.throws(() => w.preflightPrBranch(clone, "agent/x-coord-856-stale", "main", {}), /Branch origin\/agent\/x-coord-856-stale has no commits ahead of origin\/main\./);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-1047: PR branch push rechecks the attempt fence at the irreversible push boundary", () => {
  const { tmp, clone } = coord856Repo();
  try {
    const branch = "agent/coord-1047-fence";
    git(clone, ["checkout", "-q", "-b", branch]);
    fs.writeFileSync(path.join(clone, "fence.txt"), "candidate\n");
    git(clone, ["add", "fence.txt"]);
    git(clone, ["commit", "-qm", "candidate"]);
    const w = build();
    assert.throws(() => w.preflightPrBranch(clone, branch, "main", {
      push: true,
      beforePush: () => { throw new Error("stale attempt fence"); },
    }), /stale attempt fence/);
    assert.equal(git(clone, ["ls-remote", "--heads", "origin", branch]), "",
      "the callback refusal prevents the branch from reaching the bare remote");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-856: governed removal refuses an unverifiable status and a remove that leaves real work, and forces only clean residue", () => {
  const { tmp, clone } = coord856Repo();
  try {
    const addWorktree = (name) => {
      const worktree = path.join(tmp, name);
      git(clone, ["worktree", "add", "-q", "-b", `agent/${name.replace(/[^a-z0-9]/gi, "-")}`, worktree]);
      return fs.realpathSync(worktree);
    };
    const statusFails = addWorktree("status fails");
    withWrappedGitTry((real, dir, args, options) => (args[0] === "status" ? { status: 128, stdout: "", stderr: "index corrupt" } : real(dir, args, options)), (make) => {
      assert.throws(() => make().removeGovernedWorktree({ repoRoot: clone, worktree: statusFails }), /Could not verify worktree cleanliness for worktree .* in /);
    });
    // A toplevel probe that answers without output is not this worktree's own
    // toplevel, so no dirty check runs, and a failed plain remove whose
    // directory is already gone escalates to the forced removal.
    const vanished = addWorktree("vanished");
    withWrappedGitTry((real, dir, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { status: 0, stdout: null, stderr: "" };
      if (args[0] === "worktree" && args[1] === "remove" && args.length === 3) {
        fs.rmSync(args[2], { recursive: true, force: true });
        return { status: 1, stdout: "", stderr: "simulated" };
      }
      return real(dir, args, options);
    }, (make) => {
      make().removeGovernedWorktree({ repoRoot: clone, worktree: vanished });
    });
    assert.equal(git(clone, ["worktree", "list", "--porcelain"]).includes(vanished), false, "the vanished worktree is deregistered");
    // Work that appears after the cleanliness check makes the failed remove a refusal.
    const appeared = addWorktree("appeared");
    let statusCalls = 0;
    withWrappedGitTry((real, dir, args, options) => {
      if (args[0] === "status") {
        statusCalls += 1;
        return statusCalls === 1 ? real(dir, args, options) : { status: 0, stdout: "?? late.txt\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove" && args.length === 3) return { status: 1, stdout: "", stderr: "" };
      return real(dir, args, options);
    }, (make) => {
      assert.throws(() => make().removeGovernedWorktree({ repoRoot: clone, worktree: appeared }), /could not be removed from .*: git worktree remove failed/);
    });
    assert.equal(fs.existsSync(appeared), true, "nothing was force-removed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- COORD-892: governed product worktrees stay out of the product clone's status ---

const productWorktreeExclude = require("./product-worktree-exclude.js");

function coord892Tmp(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wto-coord892-${label}-`)));
}

function excludeLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
}

test("COORD-892: gov start's product worktree leaves a fresh product clone's status clean through info/exclude", () => {
  const tmp = coord892Tmp("fresh");
  try {
    const { clone } = makeOriginAndClone(tmp);
    const exclude = path.join(clone, ".git", "info", "exclude");
    assert.equal(git(clone, ["status", "--porcelain"]), "", "precondition: the fresh clone is clean");
    const w = build({ getRepoRoot: () => clone });
    const worktree = w.defaultWorktreePath("B", "claudea892", "BE-892");
    const prepared = w.ensureTicketWorkspace({ repoCode: "B", worktree, branch: "agent/claudea892-be-892", base: "main" });
    assert.equal(prepared.createdWorktree, true);
    assert.ok(fs.existsSync(path.join(worktree, "f.txt")), "the ticket worktree was provisioned inside the clone");
    // Without the fix the clone reports `?? .worktrees/`.
    assert.equal(git(clone, ["status", "--porcelain", "--untracked-files=all"]), "");
    assert.equal(fs.existsSync(path.join(clone, ".gitignore")), false, "no tracked ignore file is created");
    assert.equal(excludeLines(exclude).filter((line) => line === "/.worktrees/").length, 1);
    // Re-entry (resume / return-doing reuse the registered path) stays idempotent.
    w.ensureTicketWorkspace({ repoCode: "B", worktree, branch: "agent/claudea892-be-892", base: "main" });
    assert.equal(excludeLines(exclude).filter((line) => line === "/.worktrees/").length, 1);
    assert.equal(productWorktreeExclude.formatProductWorktreeExcludeWarning("backend",
      productWorktreeExclude.inspectProductWorktreeExclude({ repoRoot: clone })), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: a linked product checkout writes the exclude file of the shared common git dir", () => {
  const tmp = coord892Tmp("linked");
  try {
    const { clone } = makeOriginAndClone(tmp);
    const linked = path.join(tmp, "linked-checkout");
    git(clone, ["worktree", "add", "-b", "linked-main", linked, "main"]);
    const w = build({ getRepoRoot: () => linked });
    const worktree = w.defaultWorktreePath("B", "claudea892", "BE-893");
    w.ensureGitWorktree({ repoCode: "B", worktree, branch: "agent/claudea892-be-893", base: "main" });
    assert.ok(excludeLines(path.join(clone, ".git", "info", "exclude")).includes("/.worktrees/"));
    assert.equal(git(linked, ["status", "--porcelain"]), "");
    assert.equal(git(clone, ["status", "--porcelain"]), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: worktrees outside the product .worktrees root never touch the exclude file", () => {
  const tmp = coord892Tmp("outside");
  try {
    const { clone } = makeOriginAndClone(tmp);
    const exclude = path.join(clone, ".git", "info", "exclude");
    const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : null;
    build({ getRepoRoot: () => clone }).ensureGitWorktree({
      repoCode: "B", worktree: path.join(tmp, "elsewhere"), branch: "agent/claudea892-be-894", base: "main",
    });
    assert.equal(fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : null, before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: an unwritable exclude file warns and still provisions the worktree", () => {
  const tmp = coord892Tmp("unwritable");
  const originalWarn = console.warn;
  const warnings = [];
  try {
    const { clone } = makeOriginAndClone(tmp);
    const info = path.join(clone, ".git", "info");
    fs.rmSync(info, { recursive: true, force: true });
    fs.writeFileSync(info, "not a directory\n");
    console.warn = (...parts) => warnings.push(parts.join(" "));
    const w = build({ getRepoRoot: () => clone });
    const worktree = w.defaultWorktreePath("B", "claudea892", "BE-895");
    const prepared = w.ensureGitWorktree({ repoCode: "B", worktree, branch: "agent/claudea892-be-895", base: "main" });
    console.warn = originalWarn;
    assert.equal(prepared.createdWorktree, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not add \.worktrees\/ to the local Git exclude file of .*`gov doctor` reports the remedy/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: the exclude helper respects existing rules, anchors subdirectory products and never duplicates", () => {
  const tmp = coord892Tmp("helper");
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "backend", ".worktrees", "o"), { recursive: true });
    gitFixture(repo, ["init", "-q", "-b", "main"]);
    const exclude = path.join(repo, ".git", "info", "exclude");

    // A directory that is not inside any Git working tree has nothing to keep clean.
    const outside = path.join(tmp, "plain");
    fs.mkdirSync(outside);
    assert.deepStrictEqual(productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: outside }),
      { applicable: false, worktrees_root: path.join(outside, ".worktrees"), changed: false });

    // A product directory inside an enclosing repository gets an anchored prefix,
    // appended after a final line that had no newline.
    fs.writeFileSync(exclude, "# local\n*.swp");
    const backend = path.join(repo, "backend");
    const before = productWorktreeExclude.inspectProductWorktreeExclude({ repoRoot: backend });
    assert.equal(before.visible, true);
    assert.match(productWorktreeExclude.formatProductWorktreeExcludeWarning("backend", before),
      /\[worktree-visibility\] backend: .*printf '%s\\n' '?\/backend\/\.worktrees\/'? >> .*info\/exclude.*next gov start or resume/);
    const added = productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: backend });
    assert.equal(added.changed, true);
    assert.equal(added.pattern, "/backend/.worktrees/");
    assert.equal(fs.readFileSync(exclude, "utf8"),
      `# local\n*.swp\n${productWorktreeExclude.EXCLUDE_COMMENT}\n/backend/.worktrees/\n`);
    assert.equal(productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: backend }).changed, false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");

    // A tracked rule that already ignores the root is respected: nothing is written.
    const ignoredRepo = path.join(tmp, "ignored");
    fs.mkdirSync(ignoredRepo);
    gitFixture(ignoredRepo, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(ignoredRepo, ".gitignore"), ".worktrees/\n");
    const respected = productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: ignoredRepo });
    assert.equal(respected.ignored, true);
    assert.equal(respected.changed, false);
    assert.equal(excludeLines(path.join(ignoredRepo, ".git", "info", "exclude")).includes("/.worktrees/"), false);

    // A tracked negation outranks info/exclude: the line is written once, never
    // duplicated, and the warning names the re-including rule instead of the remedy.
    const negated = path.join(tmp, "negated");
    fs.mkdirSync(path.join(negated, ".worktrees", "o"), { recursive: true });
    gitFixture(negated, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(negated, ".gitignore"), "!.worktrees/\n");
    assert.equal(productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: negated }).changed, true);
    const second = productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: negated });
    assert.equal(second.changed, false);
    assert.equal(excludeLines(path.join(negated, ".git", "info", "exclude")).filter((line) => line === "/.worktrees/").length, 1);
    assert.match(productWorktreeExclude.formatProductWorktreeExcludeWarning("frontend", second),
      /already lists \/\.worktrees\/, so a higher-precedence rule .*re-includes it/);

    // Git answering anything other than ignored / not-ignored is not applicable.
    const odd = productWorktreeExclude.inspectProductWorktreeExclude({
      repoRoot: repo,
      gitTry: (_dir, args) => (args[0] === "check-ignore" ? { status: 128 } : { status: 0, stdout: args[1] === "--show-prefix" ? "\n" : ".git\n" }),
    });
    assert.equal(odd.applicable, false);
    assert.equal(productWorktreeExclude.formatProductWorktreeExcludeWarning("backend", odd), null);
    assert.equal(productWorktreeExclude.formatProductWorktreeExcludeWarning("backend", null), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: a missing exclude file is created with the rule, and an empty Git answer anchors at the clone root", () => {
  const tmp = coord892Tmp("missing");
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".worktrees", "o"), { recursive: true });
    gitFixture(repo, ["init", "-q", "-b", "main"]);
    const exclude = path.join(repo, ".git", "info", "exclude");
    fs.rmSync(exclude, { force: true });
    assert.equal(fs.existsSync(exclude), false, "precondition: the clone has no info/exclude file");

    // A gitTry that reports a successful empty answer without stdout (an
    // adapter that drops empty output) still reads as the empty prefix.
    const calls = [];
    const sparseGitTry = (dir, args) => {
      calls.push(args.join(" "));
      const result = realGitTry(dir, args);
      return result.status === 0 && String(result.stdout || "").trim() === "" ? { status: 0 } : result;
    };
    const inspected = productWorktreeExclude.inspectProductWorktreeExclude({ repoRoot: repo, gitTry: sparseGitTry });
    assert.ok(calls.includes("rev-parse --show-prefix"));
    assert.equal(inspected.applicable, true);
    assert.equal(inspected.pattern, "/.worktrees/");
    assert.equal(inspected.exclude_has_pattern, false, "an absent exclude file reads as empty");
    assert.equal(inspected.visible, true);

    const added = productWorktreeExclude.ensureProductWorktreeExclude({ repoRoot: repo, gitTry: sparseGitTry });
    assert.equal(added.changed, true);
    assert.equal(fs.readFileSync(exclude, "utf8"), `${productWorktreeExclude.EXCLUDE_COMMENT}\n/.worktrees/\n`,
      "no leading separator is written into a new file");
    assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=all"]), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COORD-892: the exclude helper defaults to the current directory when no repository root is given", () => {
  const dirs = [];
  const inspection = productWorktreeExclude.inspectProductWorktreeExclude({
    gitTry: (dir) => { dirs.push(dir); return { status: 128 }; },
  });
  assert.deepStrictEqual(inspection, { applicable: false, worktrees_root: path.join(process.cwd(), ".worktrees") });
  assert.ok(dirs.length > 0 && dirs.every((dir) => dir === process.cwd()));
  assert.equal(productWorktreeExclude.ensureProductWorktreeExclude({
    gitTry: () => ({ status: 128 }),
  }).changed, false);
});

// COORD-1015: git reports REAL paths. A caller that reaches the repository or a
// worktree through a symlinked parent (macOS /var, a symlinked TMPDIR) must get
// the same answers as the real path: an owned repo is audited, and a dirty
// worktree is refused rather than deleted.
test("COORD-1015 auditRepoWorktrees: an own repository reached through a symlinked parent is audited", () => {
  const repo = createTempGitRepoWithOrigin(`${HOSTILE_PATH_SEGMENT}audit-1015-`, { "README.md": "seed\n" });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-link-"));
  try {
    const link = path.join(linkParent, "repo");
    fs.symlinkSync(repo.repoRoot, link, "dir");
    const audit = build({ getRepoRoot: () => link }).auditRepoWorktrees("B", new Map());
    assert.equal(audit.is_own_repository, true, JSON.stringify(audit));
    assert.equal(audit.worktrees_audited, true, JSON.stringify(audit));
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

test("COORD-1015 removeGovernedWorktree: a dirty worktree reached through a symlinked parent is refused, not deleted", () => {
  const repo = createTempGitRepoWithOrigin(`${HOSTILE_PATH_SEGMENT}rm-1015-`, { "README.md": "seed\n" });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-link-"));
  try {
    runGit(repo.repoRoot, ["worktree", "add", "-q", "-b", "agent/x-coord-1015-dirty", path.join(repo.repoRoot, "wt-dirty")]);
    const worktree = path.join(repo.repoRoot, "wt-dirty");
    writeRepoFile(worktree, "uncommitted.txt", "work\n");
    fs.symlinkSync(repo.repoRoot, path.join(linkParent, "alias"), "dir");
    const viaLink = path.join(linkParent, "alias", "wt-dirty");
    assert.throws(() => build().removeGovernedWorktree({ repoRoot: repo.repoRoot, worktree: viaLink, branch: null, deleteBranch: false }), /is dirty at/);
    assert.equal(fs.existsSync(path.join(worktree, "uncommitted.txt")), true, "the dirty worktree was not discarded");
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

// COORD-1015 review F1: the donor exception excludes a product repository that sits
// INSIDE the control-plane coord/ directory (the operands are isWithin(coordDir, root)).
// Reached through a symlinked parent, coordDir is lexical while the root is canonical,
// so the containment test must canonicalize coordDir too, or the exclusion is lost.
test("COORD-1015 F1 auditRepoWorktrees: a product repo nested in coord/ is not a donor subtree when coord/ is reached through a symlink", () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-link-"));
  try {
    const donor = path.join(real, "donor");
    fs.mkdirSync(donor);
    gitFixture(donor, ["init", "-q"]);
    gitFixture(donor, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const coord = path.join(donor, "coord");
    const product = path.join(coord, "product");
    fs.mkdirSync(product, { recursive: true });
    fs.symlinkSync(real, path.join(linkParent, "alias"), "dir");
    const viaLink = path.join(linkParent, "alias", "donor", "coord", "product");
    const layout = (coordDir) => ({
      coordRepoRoot: donor,
      coordDir,
      workspaceRoot: donor,
      topology: "ancestor_repository",
    });
    const direct = build({ getRepoRoot: () => product, controlPlaneLayout: () => layout(coord) })
      .auditRepoWorktrees("B", new Map());
    assert.equal(direct.worktrees_audited, false, JSON.stringify(direct));
    const viaSymlink = build({ getRepoRoot: () => viaLink, controlPlaneLayout: () => layout(path.join(linkParent, "alias", "donor", "coord")) })
      .auditRepoWorktrees("B", new Map());
    assert.equal(viaSymlink.worktrees_audited, false, JSON.stringify(viaSymlink));
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

// COORD-1015 F1: the coord worktree audit keys registrations by git-reported paths. A
// caller root reached through a symlinked parent must still see its registered worktree
// as registered and its deleted registration as an orphan.
test("COORD-1015 F1 auditCoordWorktrees: registration and orphan checks hold through a symlinked parent", () => {
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const originalQuestionsPath = state.QUESTIONS_PATH;
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-coord-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-coord-link-"));
  try {
    const coord = path.join(real, "coord");
    fs.mkdirSync(coord);
    gitFixture(coord, ["init", "-q"]);
    gitFixture(coord, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const present = path.join(coord, ".worktrees", "owner", "COORD-1015");
    const orphan = path.join(coord, ".worktrees", "owner", "COORD-1016");
    const detached = path.join(coord, ".worktrees", "owner", "COORD-1017");
    fs.mkdirSync(path.dirname(present), { recursive: true });
    gitFixture(coord, ["worktree", "add", "-q", "-b", "agent/owner-coord-1015-present", present]);
    gitFixture(coord, ["worktree", "add", "-q", "-b", "agent/owner-coord-1015-orphan", orphan]);
    gitFixture(coord, ["worktree", "add", "-q", "--detach", detached, "HEAD"]);
    fs.rmSync(orphan, { recursive: true, force: true });
    fs.symlinkSync(real, path.join(linkParent, "alias"), "dir");
    state.QUESTIONS_PATH = path.join(linkParent, "alias", "coord", "QUESTIONS.md");
    const audit = build({ controlPlaneLayout: () => ({ coordRepoRoot: coord, coordDir: coord, topology: "coord_repository" }) })
      .auditCoordWorktrees(new Map());
    const byTicket = Object.fromEntries(audit.worktrees.map((entry) => [entry.ticket, entry]));
    assert.equal(byTicket["COORD-1015"].registered, true, JSON.stringify(audit.worktrees));
    assert.equal(byTicket["COORD-1015"].branch, "agent/owner-coord-1015-present");
    assert.equal(byTicket["COORD-1017"].registered, true, JSON.stringify(audit.worktrees));
    assert.equal(byTicket["COORD-1017"].branch, null);
    assert.deepEqual(audit.orphaned_registrations, [path.join(real, "coord", ".worktrees", "owner", "COORD-1016")], JSON.stringify(audit));
  } finally {
    state.QUESTIONS_PATH = originalQuestionsPath;
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

// COORD-1015 F1: a control-plane ticket worktree inside an own repository must stay out
// of that repository's product audit when the control-plane root is reached through a
// symlinked parent. Git reports the entry path canonically.
test("COORD-1015 F1 auditRepoWorktrees: control-plane worktrees stay out of the product audit through a symlinked parent", () => {
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const originalQuestionsPath = state.QUESTIONS_PATH;
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-cp-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-1015-f1-cp-link-"));
  try {
    const repo = path.join(real, "repo");
    fs.mkdirSync(repo);
    gitFixture(repo, ["init", "-q"]);
    gitFixture(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const controlWorktree = path.join(repo, ".worktrees", "owner", "COORD-1015");
    fs.mkdirSync(path.dirname(controlWorktree), { recursive: true });
    gitFixture(repo, ["worktree", "add", "-q", "-b", "agent/owner-coord-1015", controlWorktree]);
    fs.symlinkSync(real, path.join(linkParent, "alias"), "dir");
    const viaLink = path.join(linkParent, "alias", "repo");
    state.QUESTIONS_PATH = path.join(linkParent, "alias", "repo", "QUESTIONS.md");
    const audit = build({
      getRepoRoot: () => viaLink,
      controlPlaneLayout: () => ({ coordRepoRoot: repo, coordDir: repo, topology: "coord_repository" }),
    }).auditRepoWorktrees("X", new Map());
    assert.equal(audit.is_own_repository, true, JSON.stringify(audit));
    assert.deepEqual(audit.worktrees.map((entry) => entry.ticket), [], JSON.stringify(audit.worktrees));
  } finally {
    state.QUESTIONS_PATH = originalQuestionsPath;
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("donor product audit refuses malformed lock context and ambiguous registered worktrees", (t) => {
  const donor = fs.mkdtempSync(path.join(os.tmpdir(), "wt-donor-coverage-"));
  t.after(() => fs.rmSync(donor, { recursive: true, force: true }));
  const product = path.join(donor, "backend");
  const coord = path.join(donor, "coord");
  fs.mkdirSync(product);
  fs.mkdirSync(coord);
  gitFixture(donor, ["init", "-q"]);
  gitFixture(donor, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const head = gitFixture(donor, ["rev-parse", "HEAD"]);
  const ticket = "B-123";
  const owner = "codexa123";
  const branch = "agent/codexa123-b-123";
  const worktree = path.join(product, ".worktrees", owner, ticket);
  gitFixture(donor, ["worktree", "add", "-qb", branch, worktree]);
  const lock = { ticket, owner, branch, worktree, repo: "backend", head };
  let row = { ID: ticket, Owner: owner, Repo: "B", Status: "doing" };
  let resolve = () => ({ repoRoot: product, lock });
  const run = (factory = build) => factory({
    getRepoRoot: () => product,
    repoNameForCode: () => "backend",
    controlPlaneLayout: () => ({ coordRepoRoot: donor, coordDir: coord, workspaceRoot: donor, topology: "ancestor_repository" }),
    resolveTicketGitContext: () => resolve(),
  });
  const report = (ops) => ops.auditRepoWorktrees("B", new Map([[ticket, row]]));
  assert.equal(run().gitRefExists(worktree, "HEAD"), true);
  assert.equal(run().gitRefExists(worktree, "refs/heads/missing"), false);

  assert.deepEqual(report(run()).invalid_ticket_worktrees, []);
  withWrappedGitTry((realGit, cwd, args, options) =>
    cwd === worktree && args.join(" ") === "rev-parse HEAD"
      ? { status: 0, stdout: "" }
      : realGit(cwd, args, options), (factory) => {
    assert.match(report(run(factory)).invalid_ticket_worktrees[0].reason, /HEAD does not match/);
  });
  resolve = () => ({ repoRoot: product, lock: { ...lock, repo: undefined } });
  assert.match(report(run()).invalid_ticket_worktrees[0].reason, /lock repo \(missing\)/);

  row = { ...row, Owner: undefined };
  resolve = () => { throw "fixture context unavailable"; };
  assert.deepEqual(report(run()).invalid_ticket_worktrees, [{
    ticket, path: null, reason: "could not resolve ticket worktree context: fixture context unavailable", owner: null,
  }]);

  row = { ...row, Owner: owner };
  resolve = () => ({ repoRoot: product, lock });
  gitFixture(donor, ["worktree", "add", "-qb", "agent/other-b-123", path.join(product, ".worktrees", "other", ticket)]);
  const ambiguous = report(run());
  assert.match(ambiguous.invalid_ticket_worktrees[0].reason, /multiple registered worktrees/);
  assert.deepEqual(ambiguous.missing_doing_worktrees, [ticket]);
});
