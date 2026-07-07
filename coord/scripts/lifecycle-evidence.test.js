"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createLifecycleEvidence = require("./lifecycle-evidence.js");
const lifecycleModule = require("./lifecycle.js");

// COORD-296: behavior tests for the lifecycle PR / EVIDENCE-RESOLUTION service
// extracted from lifecycle.js into lifecycle-evidence.js (lifecycle decomposition
// slice #5 per the COORD-291 boundary contract — the last slice before the COORD-297
// facade-shrink). The three functions are exercised DIRECTLY through the factory with
// injected fake deps so the PR/no-PR evidence-resolution decision tree and the
// git-context lock-first/worktree-fallback resolution are pinned byte-identically to
// the pre-move inline home (relocated from the lifecycle-level closeout coverage).

const GIT_HELP_DEFAULTS = {
  isRepoBackedCode: (code) => code === "B" || code === "F",
  getRepoRoot: (code) => `/repo/${code}`,
  listGitWorktrees: () => [],
  inferTicketIdFromPath: () => null,
  isGitHubPrUrl: (entry) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(String(entry || "")),
  ghPrListByBranch: () => [],
  verifyPrEvidence: () => {},
  mergeUniqueRefs: (base, extra) => {
    const out = [...(base || [])];
    for (const ref of extra || []) {
      if (!out.includes(ref)) {
        out.push(ref);
      }
    }
    return out;
  },
  toArray: (value) => (Array.isArray(value) ? value : value == null ? [] : [value]),
  findLockForTicket: () => null,
  fail: (message) => {
    throw new Error(message);
  },
};

function buildEvidence(overrides = {}) {
  return createLifecycleEvidence({ ...GIT_HELP_DEFAULTS, ...overrides });
}

// --- DI wiring guard: factory shape + lifecycle ownership decision ----------------

test("COORD-296 wiring: createLifecycleEvidence returns exactly the three public functions", () => {
  const evidence = buildEvidence();
  const expected = ["resolveTicketGitContext", "resolvePrUrlForTicket", "resolveLifecyclePrRefs"];
  assert.deepEqual(Object.keys(evidence).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof evidence[name], "function", `${name} must be a function`);
  }
});

test("COORD-296 wiring: review-state helpers stay in lifecycle.js (COORD-088 ownership honored)", () => {
  // BRACKET form (COORD-280 facade-scanner safe): readCommitSubject /
  // commitSubjectAffiliatesWithTicket / assertCommittedReviewState are review-STATE
  // verification — NOT PR/evidence resolution — so they keep resolving through the
  // lifecycle composition root's facade after the COORD-296 extraction.
  for (const name of ["readCommitSubject", "commitSubjectAffiliatesWithTicket", "assertCommittedReviewState"]) {
    assert.equal(
      typeof lifecycleModule.__testing[name],
      "function",
      `lifecycle __testing[${name}] still resolves (left in lifecycle.js)`
    );
  }
});

// --- resolveTicketGitContext ------------------------------------------------------

test("resolveTicketGitContext short-circuits for non-repo-backed (X) tickets", () => {
  const evidence = buildEvidence();
  assert.deepEqual(evidence.resolveTicketGitContext({ Repo: "X" }, "COORD-1"), {
    repoRoot: null,
    branch: null,
    worktree: null,
    lock: null,
  });
});

test("resolveTicketGitContext resolves lock-first when a lock exists", () => {
  const evidence = buildEvidence({
    findLockForTicket: () => ({ branch: "agent/x", worktree: "/wt/x" }),
    listGitWorktrees: () => {
      throw new Error("worktrees must not be consulted when a lock exists");
    },
  });
  assert.deepEqual(evidence.resolveTicketGitContext({ Repo: "B" }, "IMP-1"), {
    repoRoot: "/repo/B",
    branch: "agent/x",
    worktree: "/wt/x",
    lock: { branch: "agent/x", worktree: "/wt/x" },
  });
});

test("resolveTicketGitContext falls back to a matching worktree when no lock", () => {
  const evidence = buildEvidence({
    findLockForTicket: () => null,
    listGitWorktrees: () => [
      { path: "/wt/other", branch: "agent/other" },
      { path: "/wt/imp2", branch: "agent/imp2" },
    ],
    inferTicketIdFromPath: (p) => (p === "/wt/imp2" ? "IMP-2" : "OTHER"),
  });
  assert.deepEqual(evidence.resolveTicketGitContext({ Repo: "F" }, "IMP-2"), {
    repoRoot: "/repo/F",
    branch: "agent/imp2",
    worktree: "/wt/imp2",
    lock: null,
  });
});

// --- resolvePrUrlForTicket --------------------------------------------------------

test("resolvePrUrlForTicket returns the single GitHub PR ref from the board index", () => {
  const evidence = buildEvidence();
  const board = { pr_index: { "IMP-3": ["https://github.com/o/r/pull/9", "not-a-pr"] } };
  assert.equal(
    evidence.resolvePrUrlForTicket(board, { Repo: "B" }, "IMP-3"),
    "https://github.com/o/r/pull/9"
  );
});

test("resolvePrUrlForTicket fails closed on multiple GitHub PR refs", () => {
  const evidence = buildEvidence();
  const board = { pr_index: { "IMP-4": ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"] } };
  assert.throws(
    () => evidence.resolvePrUrlForTicket(board, { Repo: "B" }, "IMP-4"),
    /multiple GitHub PR refs/
  );
});

test("resolvePrUrlForTicket discovers a PR by branch when the index is empty", () => {
  const evidence = buildEvidence({
    findLockForTicket: () => ({ branch: "agent/imp5", worktree: "/wt/imp5" }),
    ghPrListByBranch: (root, branch) => {
      assert.equal(root, "/repo/B");
      assert.equal(branch, "agent/imp5");
      return [{ url: "https://github.com/o/r/pull/55" }];
    },
  });
  assert.equal(
    evidence.resolvePrUrlForTicket({ pr_index: {} }, { Repo: "B" }, "IMP-5"),
    "https://github.com/o/r/pull/55"
  );
});

test("resolvePrUrlForTicket returns null when no branch/repo context is resolvable", () => {
  const evidence = buildEvidence();
  assert.equal(evidence.resolvePrUrlForTicket({ pr_index: {} }, { Repo: "X" }, "COORD-6"), null);
});

// --- resolveLifecyclePrRefs (PR / no-PR evidence parity) --------------------------

test("resolveLifecyclePrRefs prefers explicit --pr refs and verifies them with allowNoPr", () => {
  const verifyCalls = [];
  const evidence = buildEvidence({
    verifyPrEvidence: (ticketId, refs, opts) => verifyCalls.push({ ticketId, refs, opts }),
  });
  const refs = evidence.resolveLifecyclePrRefs("IMP-7", { Repo: "B" }, { pr_index: {} }, {
    pr: "https://github.com/o/r/pull/7",
  });
  assert.deepEqual(refs, ["https://github.com/o/r/pull/7"]);
  assert.equal(verifyCalls.length, 1);
  assert.deepEqual(verifyCalls[0].opts, { requireMerged: false, allowNoPr: true });
});

test("resolveLifecyclePrRefs falls back to existing board pr_index refs", () => {
  const evidence = buildEvidence();
  const board = { pr_index: { "IMP-8": ["https://github.com/o/r/pull/8"] } };
  assert.deepEqual(
    evidence.resolveLifecyclePrRefs("IMP-8", { Repo: "B" }, board, {}),
    ["https://github.com/o/r/pull/8"]
  );
});

test("resolveLifecyclePrRefs discovers a repo-backed branch PR when no refs are present", () => {
  const evidence = buildEvidence({
    findLockForTicket: () => ({ branch: "agent/imp9", worktree: "/wt/imp9" }),
    ghPrListByBranch: () => [{ url: "https://github.com/o/r/pull/99" }],
  });
  assert.deepEqual(
    evidence.resolveLifecyclePrRefs("IMP-9", { Repo: "B" }, { pr_index: {} }, {}),
    ["https://github.com/o/r/pull/99"]
  );
});

test("resolveLifecyclePrRefs fails closed for an X-lane (no_pr) ticket with no evidence", () => {
  // PR/no-PR parity: a non-repo-backed ticket skips branch discovery and fails closed
  // exactly as the PR-backed path does when no refs can be resolved — the --no-pr
  // finalize lane supplies evidence separately, never via this resolver.
  const evidence = buildEvidence();
  assert.throws(
    () => evidence.resolveLifecyclePrRefs("COORD-10", { Repo: "X" }, { pr_index: {} }, {}),
    /has no PR evidence/
  );
});

test("resolveLifecyclePrRefs fails closed for a repo-backed ticket when branch discovery finds nothing", () => {
  const evidence = buildEvidence({
    findLockForTicket: () => ({ branch: "agent/imp11", worktree: "/wt/imp11" }),
    ghPrListByBranch: () => [],
  });
  assert.throws(
    () => evidence.resolveLifecyclePrRefs("IMP-11", { Repo: "B" }, { pr_index: {} }, {}),
    /has no PR evidence/
  );
});
