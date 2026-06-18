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
