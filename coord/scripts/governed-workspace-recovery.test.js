// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

// COORD-635 — governed workspace RECOVERY must never redirect an agent into the
// canonical tree.
//
// THE REGRESSION. A governed lock names a worktree inside the canonical tree
// (coord/.worktrees/<owner>/<TICKET>, <repo>/.worktrees/<owner>/<TICKET>). When
// that worktree was gone — directory AND registration — recovery produced
// something that was not a worktree:
//
//   `return-doing` Repo X : fs.mkdirSync(worktree)  -> a PLAIN DIRECTORY
//   `resume`              : nothing at all, exit 0  -> lock names a missing path
//
// Because the path is nested inside the canonical repository, `git -C <path>
// rev-parse --show-toplevel` walks UP and answers CANONICAL. An agent told
// "your worktree is <path>" then edits, stages and commits against canonical
// `main` while believing it is isolated. That is release-critical: it is the
// failure that corrupted three concurrent runs in one session.
//
// WHAT THESE TESTS PIN. Recovery has exactly two acceptable outcomes —
// RECONSTRUCT a real worktree, or FAIL CLOSED — and the isolation
// post-condition is asserted on the real filesystem every time, so
// canonical-tree fallback is IMPOSSIBLE rather than merely absent. The most
// important test here is the one where reconstruction LIES (a stub that makes a
// plain directory): the post-condition still refuses. That is what makes the
// guarantee structural.
//
// The product-repo path is covered by the same tests, because it shares the same
// code and the hazard is a property of worktree paths nested inside their own
// repository — which both repo kinds have.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const {
  createGovernedWorkspaceRecovery,
  assertGovernedWorktreeIsolated,
  ensureGovernedWorkspace,
  isOwnWorktreeToplevel,
  resolveWorktreeToplevel,
} = require("./governed-workspace-recovery.js");
const createWorktreeOps = require("./worktree-ops.js");
const { resolveControlPlaneLayout } = require("./control-plane-paths.js");
// COORD-670: the ADR-0008 container witness is owned by the control-plane
// engine, NOT borrowed from create-concord/ — that package is stripped from
// every published cut, so the old require made this whole guard unloadable in
// the artifact it protects. See coord/scripts/workspace-container-witness.js.
const {
  witnessWorkspaceContainer,
  CONTAINER_WITNESS_KEYS,
} = require("./workspace-container-witness.js");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "coord test",
  GIT_AUTHOR_EMAIL: "coord@test.invalid",
  GIT_COMMITTER_NAME: "coord test",
  GIT_COMMITTER_EMAIL: "coord@test.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

// COORD-631 witness (REUSED, not reinvented): .git presence / HEAD / branch /
// refs / INDEX digest / CONFIG digest. A `git status` comparison would miss a
// staged-then-restored write; the index digest is what "was anything staged?"
// actually means.
const WITNESS_KEYS = CONTAINER_WITNESS_KEYS;

// The canonical WORKING TREE, excluding .git (covered by the witness) and
// excluding .worktrees (where governed worktrees legitimately live).
function workingTreeSnapshot(dir) {
  const map = {};
  (function visit(current, prefix) {
    for (const name of fs.readdirSync(current).sort()) {
      if (name === ".git" || name === ".worktrees") continue;
      const abs = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        map[`${rel}/`] = "dir";
        visit(abs, rel);
      } else {
        map[rel] = `${st.size}:${crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`;
      }
    }
  })(dir, "");
  return map;
}

function canonicalWitness(repoRoot) {
  return { git: witnessWorkspaceContainer(repoRoot), tree: workingTreeSnapshot(repoRoot) };
}

function assertCanonicalUntouched(label, before, after) {
  for (const key of WITNESS_KEYS) {
    assert.deepEqual(
      after.git[key], before.git[key],
      `${label}: canonical Git witness key "${key}" moved (${JSON.stringify(before.git[key])} -> ${JSON.stringify(after.git[key])})`
    );
  }
  assert.deepEqual(after.tree, before.tree, `${label}: canonical working tree changed`);
}

// ---------------------------------------------------------------------------
// Fixtures: a control-plane repo and a product repo, each with the governed
// worktree path NESTED INSIDE ITSELF — the layout that creates the hazard.
// ---------------------------------------------------------------------------

function buildControlPlaneFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-cp-"));
  const coordDir = path.join(workspace, "coord");
  write(path.join(coordDir, "GOVERNANCE.md"), "# governance\n");
  write(path.join(coordDir, ".gitignore"), ".worktrees/\n.runtime/*\n");
  git(coordDir, "init", "--initial-branch=main", ".");
  git(coordDir, "add", "-A");
  git(coordDir, "commit", "--no-verify", "-m", "governance baseline");
  const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
  return {
    kind: "control-plane",
    workspace,
    canonicalRoot: coordDir,
    layout,
    row: { ID: "COORD-900", Repo: "X" },
    worktree: path.join(coordDir, ".worktrees", "claudea11", "COORD-900"),
    branch: "agent/claudea11-coord-900",
    repoRoots: {},
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

function buildProductRepoFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-prod-"));
  const coordDir = path.join(workspace, "coord");
  write(path.join(coordDir, "GOVERNANCE.md"), "# governance\n");
  git(coordDir, "init", "--initial-branch=main", ".");
  git(coordDir, "add", "-A");
  git(coordDir, "commit", "--no-verify", "-m", "governance baseline");

  const repoRoot = path.join(workspace, "backend");
  write(path.join(repoRoot, "src", "index.js"), "module.exports = 1;\n");
  write(path.join(repoRoot, ".gitignore"), ".worktrees/\n");
  git(repoRoot, "init", "--initial-branch=main", ".");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "--no-verify", "-m", "backend baseline");

  return {
    kind: "product-repo",
    workspace,
    canonicalRoot: repoRoot,
    layout: resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace }),
    row: { ID: "BE-900", Repo: "B" },
    worktree: path.join(repoRoot, ".worktrees", "claudea11", "BE-900"),
    branch: "agent/claudea11-be-900",
    repoRoots: { B: repoRoot },
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

function buildRecovery(fixture, overrides = {}) {
  const ops = createWorktreeOps({
    fail: (m) => { throw new Error(m); },
    configuredRepoArgDescription: () => "backend",
    getRepoRoot: (code) => fixture.repoRoots[code] || `/nonexistent/${code}`,
    getRows: () => [],
    rowsById: () => new Map(),
    isDoingStatus: (s) => String(s || "").startsWith("doing"),
    isRepoBackedCode: (code) => Boolean(fixture.repoRoots[code]),
    readBoard: () => ({}),
    readPlanRecord: () => null,
    repoCodeForCliRepoArg: (a) => a,
    repoNameForCode: (code) => (code === "X" ? "coord" : code),
    resolveTicketGitContext: () => ({ repoRoot: null, branch: null, worktree: null, lock: null }),
    controlPlaneLayout: () => fixture.layout,
  });
  return createGovernedWorkspaceRecovery({
    ensureTicketWorkspace: overrides.ensureTicketWorkspace || ((args) => ops.ensureTicketWorkspace(args)),
    listGitWorktrees: (root) => ops.listGitWorktrees(root),
    getRepoRoot: (code) => fixture.repoRoots[code] || `/nonexistent/${code}`,
    isRepoBackedCode: (code) => Boolean(fixture.repoRoots[code]),
    controlPlaneLayout: () => fixture.layout,
    fail: (m) => { throw new Error(m); },
  });
}

const FIXTURES = [buildControlPlaneFixture, buildProductRepoFixture];

// ===========================================================================
// 1. THE EXACT REGRESSION (requirement 6), for BOTH repo kinds (requirement 7).
// ===========================================================================

for (const build of FIXTURES) {
  const kind = build === buildControlPlaneFixture ? "control-plane" : "product-repo";

  test(`COORD-635 [${kind}]: missing directory AND missing registration -> recovery rebuilds a REAL isolated worktree`, () => {
    const fx = build();
    try {
      const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);

      // Create it, then destroy BOTH the directory and the registration — the
      // exact state that produced the hazard.
      ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "start",
      });
      git(fx.canonicalRoot, "worktree", "remove", "--force", fx.worktree);
      git(fx.canonicalRoot, "worktree", "prune");
      assert.equal(fs.existsSync(fx.worktree), false, "precondition: directory gone");
      assert.equal(
        git(fx.canonicalRoot, "worktree", "list").includes(fx.worktree), false,
        "precondition: registration gone"
      );

      const before = canonicalWitness(fx.canonicalRoot);

      // RECOVER.
      const result = ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
      });
      assert.equal(result.isolated, true);

      // Requirement 3 — asserted DIRECTLY, not inferred.
      assert.equal(
        path.resolve(git(fx.worktree, "rev-parse", "--show-toplevel")),
        path.resolve(fx.worktree),
        "the recovered worktree must resolve to ITSELF, never to the canonical tree"
      );
      assert.notEqual(
        path.resolve(git(fx.worktree, "rev-parse", "--show-toplevel")),
        path.resolve(fx.canonicalRoot),
        "the recovered worktree must NOT resolve to the canonical tree"
      );

      // Requirement 4.
      assert.ok(
        git(fx.canonicalRoot, "worktree", "list").includes(fx.worktree),
        "the recovered worktree must appear in `git worktree list`"
      );

      // Requirement 5 — canonical HEAD, branch, refs, INDEX and config, plus
      // the canonical working tree, all unchanged.
      assertCanonicalUntouched(`${kind} canonical`, before, canonicalWitness(fx.canonicalRoot));

      // And COMMITTING in the recovered worktree does not touch canonical.
      //
      // `refs_digest` is deliberately excluded from THIS comparison and only
      // this one: a worktree shares its repository's ref store, so committing
      // on the ticket branch advances a ref by design — that is what an
      // isolated worktree is for. What must not move is canonical's own
      // position and content: HEAD, branch, INDEX (was anything staged into
      // canonical?), config, and the canonical working tree. Those are exactly
      // the keys checked here, so excluding refs_digest weakens nothing that
      // matters.
      write(path.join(fx.worktree, "ISOLATED.md"), "written in the worktree\n");
      git(fx.worktree, "add", "--", "ISOLATED.md");
      git(fx.worktree, "commit", "--no-verify", "-m", "isolated commit");
      const after = canonicalWitness(fx.canonicalRoot);
      for (const key of WITNESS_KEYS.filter((k) => k !== "refs_digest")) {
        assert.deepEqual(
          after.git[key], before.git[key],
          `${kind} canonical after an isolated commit: witness key "${key}" moved`
        );
      }
      assert.deepEqual(after.tree, before.tree, `${kind} canonical working tree changed after an isolated commit`);
      assert.equal(fs.existsSync(path.join(fx.canonicalRoot, "ISOLATED.md")), false);
      // The ticket branch advanced; canonical HEAD did not follow it.
      assert.notEqual(git(fx.worktree, "rev-parse", "HEAD"), git(fx.canonicalRoot, "rev-parse", "HEAD"));
    } finally {
      fx.cleanup();
    }
  });

  test(`COORD-635 RED [${kind}]: a PLAIN DIRECTORY at the governed path is refused, and the refusal names the canonical tree`, () => {
    // This is the old `fs.mkdirSync(worktree)` behaviour, reproduced exactly.
    const fx = build();
    try {
      fs.mkdirSync(fx.worktree, { recursive: true });
      write(path.join(fx.worktree, "notes.md"), "someone's work\n");

      // The trap, demonstrated: git in that directory answers CANONICAL.
      assert.equal(
        path.resolve(git(fx.worktree, "rev-parse", "--show-toplevel")),
        path.resolve(fx.canonicalRoot),
        "precondition: a plain directory under the repo resolves to canonical — this is the hazard"
      );
      assert.equal(isOwnWorktreeToplevel(fx.worktree), false);

      const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
      const before = canonicalWitness(fx.canonicalRoot);

      // RED: refused, naming the hazard and the remediation. Non-empty, so it
      // is never deleted automatically.
      assert.throws(
        () => ensureGovernedWorkspaceForTicket({
          ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
        }),
        (error) => {
          assert.match(error.message, /is NOT a git worktree, and is not empty/);
          assert.match(error.message, /would edit the canonical tree/);
          assert.match(error.message, /gov resume/);
          return true;
        }
      );
      // The content it refused to understand is still there.
      assert.equal(fs.readFileSync(path.join(fx.worktree, "notes.md"), "utf8"), "someone's work\n");
      assertCanonicalUntouched(`${kind} canonical after refusal`, before, canonicalWitness(fx.canonicalRoot));

      // GREEN: remove the stray content and the SAME call now recovers. The
      // guard is not a blanket refusal.
      fs.rmSync(path.join(fx.worktree, "notes.md"));
      const result = ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
      });
      assert.equal(result.isolated, true);
      assert.equal(
        path.resolve(git(fx.worktree, "rev-parse", "--show-toplevel")), path.resolve(fx.worktree)
      );
    } finally {
      fx.cleanup();
    }
  });

  test(`COORD-635 RED [${kind}]: canonical-tree fallback is IMPOSSIBLE — even a reconstruction that lies is refused`, () => {
    // The negative assertion that matters. It is not enough that recovery
    // happened to produce a worktree this time; there must be NO path that
    // returns success while the directory resolves to canonical. Here
    // reconstruction is stubbed to do exactly what the old code did — create a
    // plain directory — and the post-condition still refuses.
    const fx = build();
    try {
      const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx, {
        ensureTicketWorkspace: ({ worktree }) => {
          fs.mkdirSync(worktree, { recursive: true }); // a lying "reconstruction"
          return { createdWorktree: true, worktree };
        },
      });
      const before = canonicalWitness(fx.canonicalRoot);

      assert.throws(
        () => ensureGovernedWorkspaceForTicket({
          ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
        }),
        (error) => {
          assert.match(error.message, /is NOT an isolated git worktree after resume/);
          assert.match(error.message, /Working there would edit and stage/);
          assert.match(error.message, new RegExp(fx.canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          return true;
        }
      );
      assertCanonicalUntouched(`${kind} canonical`, before, canonicalWitness(fx.canonicalRoot));
    } finally {
      fx.cleanup();
    }
  });

  test(`COORD-635 RED [${kind}]: a reconstruction that silently NO-OPS is refused, not reported as success`, () => {
    const fx = build();
    try {
      const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx, {
        ensureTicketWorkspace: () => ({ createdWorktree: false }), // does nothing
      });
      assert.throws(
        () => ensureGovernedWorkspaceForTicket({
          ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
        }),
        /does not exist after resume|Governance refuses to continue/
      );
    } finally {
      fx.cleanup();
    }
  });

  test(`COORD-635 RED [${kind}]: an UNREGISTERED worktree is refused even though it is its own toplevel`, () => {
    // Both halves of the post-condition are load-bearing and neither implies
    // the other: this directory IS its own repository (so show-toplevel passes)
    // but git does not know it as a worktree, so cleanup/doctor/prune cannot
    // see it and it becomes orphaned residue.
    const fx = build();
    try {
      fs.mkdirSync(fx.worktree, { recursive: true });
      git(fx.worktree, "init", "--initial-branch=main", ".");
      assert.equal(isOwnWorktreeToplevel(fx.worktree), true, "precondition: it is its own toplevel");

      const ops = createWorktreeOps({
        fail: (m) => { throw new Error(m); },
        configuredRepoArgDescription: () => "backend",
        getRepoRoot: (code) => fx.repoRoots[code] || `/nonexistent/${code}`,
        getRows: () => [], rowsById: () => new Map(),
        isDoingStatus: () => false,
        isRepoBackedCode: (code) => Boolean(fx.repoRoots[code]),
        readBoard: () => ({}), readPlanRecord: () => null,
        repoCodeForCliRepoArg: (a) => a,
        repoNameForCode: (code) => (code === "X" ? "coord" : code),
        resolveTicketGitContext: () => ({ repoRoot: null, branch: null, worktree: null, lock: null }),
        controlPlaneLayout: () => fx.layout,
      });

      assert.throws(
        () => assertGovernedWorktreeIsolated({
          ticketId: fx.row.ID,
          worktree: fx.worktree,
          repoRoot: fx.canonicalRoot,
          listGitWorktrees: (root) => ops.listGitWorktrees(root),
          fail: (m) => { throw new Error(m); },
          stage: "resume",
        }),
        /is not registered in .* after resume/
      );
    } finally {
      fx.cleanup();
    }
  });
}

// ===========================================================================
// 2. The primitives, pinned directly.
// ===========================================================================

test("COORD-635: resolveWorktreeToplevel distinguishes a real worktree from a nested plain directory", () => {
  const fx = buildControlPlaneFixture();
  try {
    // A plain directory nested in the repo resolves UP to canonical.
    const stray = path.join(fx.canonicalRoot, ".worktrees", "stray");
    fs.mkdirSync(stray, { recursive: true });
    assert.equal(resolveWorktreeToplevel(stray), path.resolve(fx.canonicalRoot));
    assert.equal(isOwnWorktreeToplevel(stray), false);

    // A real worktree resolves to itself.
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    ensureGovernedWorkspaceForTicket({
      ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "start",
    });
    assert.equal(resolveWorktreeToplevel(fx.worktree), path.resolve(fx.worktree));
    assert.equal(isOwnWorktreeToplevel(fx.worktree), true);

    // A path that does not exist is not a worktree, and is not an exception.
    assert.equal(resolveWorktreeToplevel(path.join(fx.canonicalRoot, "nope")), null);
    assert.equal(isOwnWorktreeToplevel(path.join(fx.canonicalRoot, "nope")), false);
  } finally {
    fx.cleanup();
  }
});

test("COORD-635: an EMPTY stray directory is cleared and reconstructed — recovery is not a blanket refusal", () => {
  // The empty case is the common one (a partial cleanup, or the old resume
  // creating the owner directory). It must recover silently rather than force
  // the operator into manual git.
  const fx = buildControlPlaneFixture();
  try {
    fs.mkdirSync(fx.worktree, { recursive: true });
    assert.equal(isOwnWorktreeToplevel(fx.worktree), false);
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    const result = ensureGovernedWorkspaceForTicket({
      ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
    });
    assert.equal(result.isolated, true);
    assert.equal(path.resolve(git(fx.worktree, "rev-parse", "--show-toplevel")), path.resolve(fx.worktree));
  } finally {
    fx.cleanup();
  }
});

test("COORD-635: recovery is idempotent — a healthy worktree is left exactly as it is", () => {
  const fx = buildControlPlaneFixture();
  try {
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    ensureGovernedWorkspaceForTicket({
      ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "start",
    });
    write(path.join(fx.worktree, "WIP.md"), "uncommitted work\n");
    const headBefore = git(fx.worktree, "rev-parse", "HEAD");

    const result = ensureGovernedWorkspaceForTicket({
      ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, base: "main", stage: "resume",
    });

    assert.equal(result.isolated, true);
    assert.equal(git(fx.worktree, "rev-parse", "HEAD"), headBefore);
    assert.equal(
      fs.readFileSync(path.join(fx.worktree, "WIP.md"), "utf8"), "uncommitted work\n",
      "recovery must never discard in-progress work in a healthy worktree"
    );
  } finally {
    fx.cleanup();
  }
});

test("COORD-635: recovery fails closed when there is no control-plane repository to rebuild from", () => {
  // Requirement 2's second acceptable outcome. A workspace with no coord/.git
  // cannot produce a control-plane worktree; recovery must say so rather than
  // leave a directory behind.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-norepo-"));
  try {
    const coordDir = path.join(workspace, "coord");
    write(path.join(coordDir, "GOVERNANCE.md"), "# g\n");
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    assert.equal(layout.coordRepoRoot, null, "precondition: no control-plane repository");

    const fx = {
      layout, repoRoots: {}, canonicalRoot: coordDir,
      row: { ID: "COORD-901", Repo: "X" },
      worktree: path.join(coordDir, ".worktrees", "claudea11", "COORD-901"),
      branch: "agent/claudea11-coord-901",
    };
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      /control-plane|coord/i
    );
    assert.equal(
      fs.existsSync(fx.worktree), false,
      "a failed recovery must not leave a plain directory behind — that is the hazard it exists to prevent"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: ensureGovernedWorkspace refuses without a reconstruction function rather than proceeding", () => {
  assert.throws(
    () => ensureGovernedWorkspace({
      ticketId: "COORD-902",
      repoCode: "X",
      worktree: path.join(os.tmpdir(), "gwr-missing-dep", "COORD-902"),
      fail: (m) => { throw new Error(m); },
      stage: "resume",
    }),
    /requires ensureTicketWorkspace/
  );
});

// ===========================================================================
// 2b. THE DELETION PATH. Clearing a stray path is the only destructive act in
//     recovery, and it sits directly under the guard whose purpose is "never
//     delete something we do not understand". The first cut inferred emptiness
//     from `catch { entries = [] }`, so EVERY inspection failure — a regular
//     file (ENOTDIR), an unreadable directory, a stale mount — read as empty
//     and was then deleted with rm -r --force. A symlink was followed by
//     readdir and unlinked if its TARGET was empty.
//
//     Each test below asserts the path SURVIVES UNCHANGED, not merely that the
//     call threw: a guard that refuses and deletes anyway is not a guard.
// ===========================================================================

test("COORD-635 RED: a REGULAR FILE at the governed path is refused and SURVIVES", () => {
  const fx = buildControlPlaneFixture();
  try {
    fs.mkdirSync(path.dirname(fx.worktree), { recursive: true });
    fs.writeFileSync(fx.worktree, "not a directory - real content\n", "utf8");
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    const before = canonicalWitness(fx.canonicalRoot);

    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      /is not a directory \(it is a regular file\)/
    );

    // SURVIVAL, byte for byte.
    assert.equal(fs.existsSync(fx.worktree), true, "the file must still exist");
    assert.equal(fs.lstatSync(fx.worktree).isFile(), true);
    assert.equal(fs.readFileSync(fx.worktree, "utf8"), "not a directory - real content\n");
    assertCanonicalUntouched("canonical", before, canonicalWitness(fx.canonicalRoot));
  } finally {
    fx.cleanup();
  }
});

test("COORD-635 RED: a SYMLINK at the governed path is refused, is NOT followed, and both link and target SURVIVE", () => {
  const fx = buildControlPlaneFixture();
  try {
    // A symlink whose TARGET is an empty directory: the shape that the old
    // stat-following emptiness check would have classified as "empty" and
    // removed. The target also carries a sibling file so any recursive removal
    // through the link would be visible.
    const linkTarget = path.join(fx.workspace, "link-target");
    fs.mkdirSync(linkTarget, { recursive: true });
    const guardedNeighbour = path.join(fx.workspace, "link-target-neighbour.txt");
    fs.writeFileSync(guardedNeighbour, "must survive\n", "utf8");

    fs.mkdirSync(path.dirname(fx.worktree), { recursive: true });
    fs.symlinkSync(linkTarget, fx.worktree, "dir");
    assert.equal(fs.lstatSync(fx.worktree).isSymbolicLink(), true, "precondition: it is a symlink");
    assert.equal(fs.readdirSync(fx.worktree).length, 0, "precondition: the TARGET is empty (the trap)");

    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    const before = canonicalWitness(fx.canonicalRoot);

    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      (error) => {
        assert.match(error.message, /is a SYMLINK, not a governed worktree/);
        assert.match(error.message, /may point anywhere/);
        return true;
      }
    );

    // SURVIVAL: the link itself, and everything it pointed at.
    assert.equal(fs.lstatSync(fx.worktree).isSymbolicLink(), true, "the symlink must still exist");
    assert.equal(fs.realpathSync(fx.worktree), fs.realpathSync(linkTarget), "it must still point where it did");
    assert.equal(fs.existsSync(linkTarget), true, "the target directory must survive");
    assert.equal(fs.readFileSync(guardedNeighbour, "utf8"), "must survive\n");
    assertCanonicalUntouched("canonical", before, canonicalWitness(fx.canonicalRoot));
  } finally {
    fx.cleanup();
  }
});

test("COORD-635 RED: a DANGLING SYMLINK is refused, SURVIVES, and reconstruction is never attempted", () => {
  // The classification gap: fs.existsSync() is FALSE for a dangling symlink
  // even though the link exists. Asking it skipped the safety guard entirely
  // AND satisfied the `!exists -> reconstruct` test, so `git worktree add` ran
  // straight through the link. Pointed at the canonical tree, that is the very
  // redirection this ticket exists to prevent.
  const fx = buildControlPlaneFixture();
  try {
    // The hostile shape: the link resolves INTO the canonical tree, and its
    // target does not exist yet — so a following mkdir/worktree-add would
    // CREATE it there.
    const hostileTarget = path.join(fx.canonicalRoot, "victim-created-by-following-the-link");
    fs.mkdirSync(path.dirname(fx.worktree), { recursive: true });
    fs.symlinkSync(hostileTarget, fx.worktree, "dir");

    // Preconditions: this is exactly the state the old predicate misread.
    assert.equal(fs.existsSync(fx.worktree), false, "precondition: existsSync says ABSENT (the trap)");
    assert.equal(fs.lstatSync(fx.worktree).isSymbolicLink(), true, "precondition: lstat says SYMLINK");
    assert.equal(fs.existsSync(hostileTarget), false, "precondition: the link target does not exist yet");

    let reconstructions = 0;
    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx, {
      ensureTicketWorkspace: () => { reconstructions += 1; },
    });
    const before = canonicalWitness(fx.canonicalRoot);

    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      (error) => {
        assert.match(error.message, /is a SYMLINK, not a governed worktree/);
        assert.match(error.message, /may point anywhere/);
        return true;
      }
    );

    // The decisive assertion: reconstruction was never even ATTEMPTED. A guard
    // that refused only after calling ensureTicketWorkspace would have already
    // built through the link before raising.
    assert.equal(reconstructions, 0, "ensureTicketWorkspace must never be called for a symlinked path");

    // SURVIVAL: the link is intact, unfollowed, and its target was NOT created.
    assert.equal(fs.lstatSync(fx.worktree).isSymbolicLink(), true, "the dangling symlink must still exist");
    assert.equal(fs.readlinkSync(fx.worktree), hostileTarget, "it must still point where it did");
    assert.equal(fs.existsSync(hostileTarget), false, "nothing may be created at the link target");
    assertCanonicalUntouched("canonical", before, canonicalWitness(fx.canonicalRoot));
  } finally {
    fx.cleanup();
  }
});

test("COORD-635 RED: an INSPECTION FAILURE fails closed and the path SURVIVES (lstat and readdir both)", () => {
  // The precise defect: a thrown inspection must never be read as "empty".
  // Simulated by making the syscall throw for this path only — EACCES on an
  // unreadable directory, and EIO on a stale mount, are the real-world shapes.
  for (const [syscall, code] of [["lstatSync", "EACCES"], ["readdirSync", "EIO"]]) {
    const fx = buildControlPlaneFixture();
    const original = fs[syscall];
    try {
      fs.mkdirSync(fx.worktree, { recursive: true });
      const canary = path.join(fx.worktree, "canary.txt");
      fs.writeFileSync(canary, "content the guard must not destroy\n", "utf8");

      fs[syscall] = function patched(p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(fx.worktree)) {
          const error = new Error(`${code}: simulated ${syscall} failure`);
          error.code = code;
          throw error;
        }
        return original.call(this, p, ...rest);
      };

      const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
      assert.throws(
        () => ensureGovernedWorkspaceForTicket({
          ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
        }),
        (error) => {
          // Names the path and the reason.
          assert.match(error.message, new RegExp(fx.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(error.message, new RegExp(code));
          // The lstat refusal now fires BEFORE the removal guard (it is the
          // presence decision itself, and its risk is building OVER the path);
          // the readdir refusal still fires inside it. Both must fail closed
          // and say which question they could not answer.
          assert.match(
            error.message,
            /refuses to (treat a path it cannot identify as absent|remove a path it cannot verify is empty)/
          );
          return true;
        }
      );

      fs[syscall] = original;
      // SURVIVAL: an uninspectable path is the one we know least about, so it
      // is the last thing that may be deleted automatically.
      assert.equal(fs.existsSync(fx.worktree), true, `${syscall}: the path must survive`);
      assert.equal(
        fs.readFileSync(canary, "utf8"), "content the guard must not destroy\n",
        `${syscall}: contents must survive`
      );
    } finally {
      fs[syscall] = original;
      fx.cleanup();
    }
  }
});

test("COORD-635 RED: a NON-EMPTY directory is refused and every entry SURVIVES", () => {
  const fx = buildControlPlaneFixture();
  try {
    fs.mkdirSync(path.join(fx.worktree, "nested"), { recursive: true });
    fs.writeFileSync(path.join(fx.worktree, "work.md"), "hours of work\n", "utf8");
    fs.writeFileSync(path.join(fx.worktree, "nested", "deep.txt"), "nested work\n", "utf8");

    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    const before = canonicalWitness(fx.canonicalRoot);

    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      /is NOT a git worktree, and is not empty \(2 entries\)/
    );

    assert.equal(fs.readFileSync(path.join(fx.worktree, "work.md"), "utf8"), "hours of work\n");
    assert.equal(fs.readFileSync(path.join(fx.worktree, "nested", "deep.txt"), "utf8"), "nested work\n");
    assertCanonicalUntouched("canonical", before, canonicalWitness(fx.canonicalRoot));
  } finally {
    fx.cleanup();
  }
});

test("COORD-635: clearing an empty stray directory uses a NON-RECURSIVE rmdir, so a late arrival is refused not deleted", () => {
  // Closes the check-then-act race by construction. rmdirSync refuses
  // atomically (ENOTEMPTY) if content appeared after the readdir; rm -r would
  // have deleted it. Simulated by having readdir report empty while the
  // directory is in fact not.
  const fx = buildControlPlaneFixture();
  const originalReaddir = fs.readdirSync;
  try {
    fs.mkdirSync(fx.worktree, { recursive: true });
    fs.writeFileSync(path.join(fx.worktree, "arrived-late.txt"), "raced in\n", "utf8");
    fs.readdirSync = function patched(p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(fx.worktree)) {
        return []; // stale "empty" observation
      }
      return originalReaddir.call(this, p, ...rest);
    };

    const { ensureGovernedWorkspaceForTicket } = buildRecovery(fx);
    assert.throws(
      () => ensureGovernedWorkspaceForTicket({
        ticketId: fx.row.ID, row: fx.row, worktree: fx.worktree, branch: fx.branch, stage: "resume",
      }),
      (error) => {
        assert.match(error.message, /could not be removed \(ENOTEMPTY\)/);
        assert.match(error.message, /Content appeared while recovery was inspecting it/);
        return true;
      }
    );
    fs.readdirSync = originalReaddir;
    assert.equal(
      fs.readFileSync(path.join(fx.worktree, "arrived-late.txt"), "utf8"), "raced in\n",
      "content that raced in must survive — this is what non-recursive rmdir buys"
    );
  } finally {
    fs.readdirSync = originalReaddir;
    fx.cleanup();
  }
});

// ===========================================================================
// 3. The defect site itself: no code path may create a plain directory as a
//    governed worktree (requirement 1), proven over the source.
// ===========================================================================

test("COORD-635: no engine code creates a plain directory as a governed worktree", () => {
  // Derivation over a hand-maintained list: scan the engine for the exact
  // construct that caused this (`fs.mkdirSync(<worktree-ish>)`). The original
  // defect was ticket-transitions.js doing `fs.mkdirSync(worktree, ...)` on the
  // Repo-X branch of return-doing.
  const scriptsDir = __dirname;
  const offenders = [];
  for (const name of fs.readdirSync(scriptsDir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    // worktree-ops legitimately creates the PARENT directory before handing off
    // to `git worktree add`, which is not the same thing.
    // Strip comments first: several modules DESCRIBE the old construct in prose
    // (that is how the defect is documented), and a scanner that cannot tell
    // code from commentary is a false-positive generator, not a guard.
    const source = fs.readFileSync(path.join(scriptsDir, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const match of source.matchAll(/fs\.mkdirSync\(\s*([A-Za-z_][\w.]*)\s*[,)]/g)) {
      const variable = match[1];
      if (/^(worktree|targetWorktree|lock\.worktree|context\.worktree)$/.test(variable)) {
        offenders.push(`${name}: fs.mkdirSync(${variable})`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    "a governed worktree must be created by `git worktree add` (ensureTicketWorkspace), never by mkdirSync — " +
    "a plain directory under the canonical tree resolves to CANONICAL and silently redirects the agent there"
  );
});
