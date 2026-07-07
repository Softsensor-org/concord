// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const createWorktreeOps = require("./worktree-ops.js");

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

test("COORD-358: repo-X ticket workspace is a real git worktree and cleanup removes branch", () => {
  const w = build();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-x-worktree-"));
  const worktree = path.join(tmp, "COORD-358");
  const branch = `test/coord-358-${process.pid}-${Date.now()}`;
  const prepared = w.ensureTicketWorkspace({
    repoCode: "X",
    worktree,
    branch,
    base: "HEAD",
  });
  try {
    assert.equal(prepared.createdWorktree, true);
    assert.equal(prepared.createdBranch, true);
    assert.equal(w.isInsideGitWorkTree(worktree), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", "scripts", "worktree-ops.js")), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", ".runtime", "locks")), true);
    assert.equal(fs.existsSync(path.join(worktree, "coord", ".runtime", "plans")), true);
    assert.equal(
      fs.readFileSync(path.join(worktree, "coord", ".runtime", ".gitignore"), "utf8"),
      "*\n!.gitignore\n"
    );
  } finally {
    w.cleanupPreparedTicketWorkspace(prepared);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const liveBranch = w.gitOutput(path.dirname(require("./governance-context.js").COORD_DIR), ["branch", "--list", branch]);
  assert.equal(String(liveBranch || "").trim(), "");
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
  const { state } = require("./governance-context.js");
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

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const { __testing } = require("./governance-test-utils.js");


test("resolveTicketBaseRef precedence: explicit > plan record > registry > dev (COORD-007)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-coord007-baseref-"));
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "development" };

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

  try {
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
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
});

// ===========================================================================
// COORD-125: configurable defaultStartBaseRef + fresh-from-origin start base.
// ===========================================================================

test("resolveTicketBaseRef precedence (COORD-125): per-repo startBaseRef > global defaultStartBaseRef > integrationBranch", () => {
  const original = {
    rib: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
    rsb: { ...__testing.paths.REPO_START_BASE_REFS },
    d: __testing.paths.DEFAULT_START_BASE_REF,
  };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "main", F: "main" };
  __testing.paths.REPO_START_BASE_REFS = { B: "release-b", F: null };
  __testing.paths.DEFAULT_START_BASE_REF = "develop";
  const r = __testing.resolveTicketBaseRef;
  try {
    // Per-repo startBaseRef beats the global default and integrationBranch.
    assert.equal(r("B-1", { Repo: "B" }, {}), "release-b");
    // No per-repo override -> global defaultStartBaseRef beats integrationBranch.
    assert.equal(r("F-1", { Repo: "F" }, {}), "develop");
    // Clear the global default -> falls back to per-repo integrationBranch.
    __testing.paths.DEFAULT_START_BASE_REF = null;
    assert.equal(r("F-1", { Repo: "F" }, {}), "main");
    // Explicit options.base still wins over all config layers.
    assert.equal(r("F-1", { Repo: "F" }, { base: "hotfix" }), "hotfix");
    // Unknown repo with no config -> engine "dev" default.
    __testing.paths.REPO_INTEGRATION_BRANCHES = {};
    __testing.paths.REPO_START_BASE_REFS = {};
    assert.equal(r("Z-1", { Repo: "Z" }, {}), "dev");
  } finally {
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.rib;
    __testing.paths.REPO_START_BASE_REFS = original.rsb;
    __testing.paths.DEFAULT_START_BASE_REF = original.d;
  }
});

// --- ensureGitWorktree fresh-from-origin + offline fallback (real git sandbox) ---

const { execFileSync } = require("child_process");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Builds: a bare "origin" repo with a `main` branch, plus a clone of it. The
// clone's local main is intentionally left BEHIND origin/main so we can prove
// `gov start` branches from the FRESH origin tip, not the stale local ref.
function makeOriginAndClone(tmp) {
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");
  const clone = path.join(tmp, "clone");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "-b", "main"]);

  fs.mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-b", "main"]);
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
    git(tmp, ["init", clone]);
    git(clone, ["remote", "add", "origin", path.join(tmp, "missing.git")]);
    const w = build({ getRepoRoot: () => clone });
    // A short explicit timeout: an unreachable remote returns false (not a hang).
    const ok = w.fetchRepoRef(clone, "main", { timeoutMs: 2000 });
    assert.equal(ok, false, "fetch of a missing remote must report failure, bounded by the timeout");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
