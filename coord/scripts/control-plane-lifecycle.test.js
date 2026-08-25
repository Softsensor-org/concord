// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

// COORD-635 / ADR-0008 — the control-plane Git lifecycle against coord/.git.
//
// TOPOLOGY UNDER TEST (the adopter shape ADR-0008 mandates, which no existing
// suite exercised):
//
//   workspace/                 <- NOT a Git repository
//   ├── coord/.git/            <- the independent control-plane repository
//   ├── coord/.worktrees/      <- governed control-plane worktrees
//   ├── repo-one/.git/         <- independent sibling product repository
//   ├── repo-two/.git/
//   └── repo-three/.git/
//
// The donor's own layout (coord/ versioned by an enclosing repository) is
// covered alongside it, because the fix must not regress the tree it ships from.
//
// The lifecycle is driven through the REAL engine modules — worktree-ops'
// ensureTicketWorkspace / removeGovernedWorktree / auditRepoWorktrees /
// auditCoordWorktrees, control-plane-paths' layout + path translation, and
// control-plane-landing's evidence classes — against real git repositories.
// What is deliberately NOT re-run here is the installer itself
// (create-concord/container-install.test.js already proves installation), so
// the fixture builds the topology directly.
//
// PRODUCT-REPO AND CONTAINER NON-INTERFERENCE is proven with COORD-624's
// two-layer barrier, REUSED rather than reinvented:
//   layer 1  a deep content snapshot (size/mode/sha256 per file)
//   layer 2  install-plan.js's witnessWorkspaceContainer — .git presence, HEAD,
//            branch, refs digest, INDEX digest and CONFIG digest. The index is
//            what "was anything staged?" actually means, and a spawned `git` is
//            structurally invisible to any in-process fs hook, so this layer is
//            the only one that can see it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const createWorktreeOps = require("./worktree-ops.js");
const {
  resolveControlPlaneLayout,
  manifestPathForCoordRepoPath,
  coordRepoPathForManifestPath,
  coordWorktreeRuntimeDir,
  CONTROL_PLANE_TOPOLOGY,
} = require("./control-plane-paths.js");
const {
  evaluateControlPlaneLanding,
  assertControlPlaneLandingIntegrity,
  classifyControlPlaneLandingRecord,
  ensureControlPlaneLandingRecord,
  controlPlaneLandingVerificationClass,
  CONTROL_PLANE_VERIFICATION,
} = require("./control-plane-landing.js");
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

// Every git call is pinned to an explicit directory. COORD-631: resolving the
// right root does not help if a subprocess inherits the wrong cwd — a test
// helper that set cwd to the container is what initialized it by accident.
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

// Layer 1 of the barrier: byte-for-byte WORKING-TREE content, mode included.
// `.git/` is deliberately excluded and covered by layer 2 instead: reflogs and
// ORIG_HEAD move on reads and are never restored, so hashing them would make
// layer 1 noisy AND would mask the precise signal (HEAD / branch / refs /
// index / config) that layer 2 exists to give.
function deepSnapshot(dir, skip = new Set()) {
  const map = {};
  (function visit(current, prefix) {
    for (const name of fs.readdirSync(current).sort()) {
      if (name === ".git") continue;
      if (!prefix && skip.has(name)) continue;
      const abs = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        map[`${rel}/`] = "dir";
        visit(abs, rel);
      } else if (st.isSymbolicLink()) {
        map[rel] = `link:${fs.readlinkSync(abs)}`;
      } else {
        map[rel] = `${st.size}:${st.mode & 0o7777}:${crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`;
      }
    }
  })(dir, "");
  return map;
}

// Both layers, captured together for one protected root.
function fullWitness(dir, skip) {
  return { content: deepSnapshot(dir, skip), git: witnessWorkspaceContainer(dir) };
}

// The CONTAINER witness deliberately excludes coord/ — that is the control
// plane, the one directory this lifecycle is supposed to write to. Everything
// else in the container (root workspace assets, the sibling product repos as
// seen from above) must not move, and the container's Git witness must show it
// never became a repository.
const CONTAINER_SKIP = new Set(["coord"]);

function assertUntouched(label, before, after) {
  assert.deepEqual(after.content, before.content, `${label}: content must be byte-for-byte unchanged`);
  for (const key of CONTAINER_WITNESS_KEYS) {
    assert.deepEqual(
      after.git[key], before.git[key],
      `${label}: Git witness key "${key}" moved (${JSON.stringify(before.git[key])} -> ${JSON.stringify(after.git[key])})`
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture: a NON-GIT container with an independent coord/.git and N independent
// sibling product repositories.
// ---------------------------------------------------------------------------
function buildAdopterWorkspace({ productRepos = 3, coordGit = true } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp-lifecycle-"));
  const coordDir = path.join(workspace, "coord");

  write(path.join(workspace, "AGENTS.md"), "# workspace\n");
  write(path.join(coordDir, "GOVERNANCE.md"), "# governance\n");
  write(path.join(coordDir, "scripts", "worktree-ops.js"), "// engine\n");
  write(path.join(coordDir, "engine-pin.json"), "{}\n");
  write(path.join(coordDir, ".gitignore"), ".worktrees/\n.runtime/*\n");

  if (coordGit) {
    git(coordDir, "init", "--initial-branch=main", ".");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "--no-verify", "-m", "chore: concord governance baseline");
  }

  const repos = [];
  for (let i = 1; i <= productRepos; i += 1) {
    const repoPath = path.join(workspace, `repo-${i}`);
    write(path.join(repoPath, "src", "index.js"), `module.exports = ${i};\n`);
    write(path.join(repoPath, "README.md"), `# repo-${i}\n`);
    git(repoPath, "init", "--initial-branch=main", ".");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "--no-verify", "-m", `repo-${i} baseline`);
    repos.push({ name: `repo-${i}`, path: repoPath });
  }

  // The container itself is NOT a repository. That is the ADR-0008 invariant.
  assert.equal(fs.existsSync(path.join(workspace, ".git")), false);

  return { workspace, coordDir, repos };
}

// A bare repository standing in for the governance remote. A CONTROLLED
// fixture remote, never a live one: the ancestry guard must be provable
// without reaching the network.
function attachFixtureRemote(coordDir) {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "cp-remote-")) + "/origin.git";
  fs.mkdirSync(remote, { recursive: true });
  git(path.dirname(remote), "init", "--bare", "--initial-branch=main", remote);
  git(coordDir, "remote", "add", "origin", remote);
  git(coordDir, "push", "origin", "main");
  git(coordDir, "fetch", "origin", "main");
  return remote;
}

function buildOps(layout, overrides = {}) {
  return createWorktreeOps({
    fail: (m) => { throw new Error(m); },
    configuredRepoArgDescription: () => "repo-1, repo-2, repo-3",
    getRepoRoot: (code) => overrides.repoRoots?.[code] || `/nonexistent/${code}`,
    getRows: () => [],
    rowsById: () => new Map(),
    isDoingStatus: (s) => String(s || "").startsWith("doing"),
    isRepoBackedCode: (code) => Boolean(overrides.repoRoots?.[code]),
    readBoard: () => ({}),
    readPlanRecord: () => null,
    repoCodeForCliRepoArg: (a) => (overrides.repoRoots?.[a] ? a : null),
    repoNameForCode: (code) => (code === "X" ? "coord" : code),
    resolveTicketGitContext: () => ({ repoRoot: null, branch: null, worktree: null, lock: null }),
    controlPlaneLayout: () => layout,
    ...(overrides.deps || {}),
  });
}

// The engine resolves the control-plane worktrees root from state.QUESTIONS_PATH;
// point it at the fixture for the duration of a test.
function withCoordDir(coordDir, fn) {
  const { state } = require("./governance-context.js");
  const original = state.QUESTIONS_PATH;
  state.QUESTIONS_PATH = path.join(coordDir, "QUESTIONS.md");
  try {
    return fn();
  } finally {
    state.QUESTIONS_PATH = original;
  }
}

// ===========================================================================
// 1. Layout resolution — the three roots, and the topologies that must refuse.
// ===========================================================================

test("COORD-635: an adopter workspace resolves coordRepoRoot to coord/, not the container", () => {
  const { workspace, coordDir } = buildAdopterWorkspace();
  try {
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    assert.equal(layout.workspaceRoot, workspace);
    assert.equal(layout.coordDir, coordDir);
    // The defect this ticket exists to remove: coordRepoRoot must NOT be
    // path.dirname(COORD_DIR).
    assert.equal(layout.coordRepoRoot, coordDir);
    assert.notEqual(layout.coordRepoRoot, workspace);
    assert.equal(layout.coordPathPrefix, "");
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: the donor layout (coord/ inside its own repository) still resolves", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp-donor-"));
  try {
    const coordDir = path.join(workspace, "coord");
    write(path.join(coordDir, "GOVERNANCE.md"), "# g\n");
    git(workspace, "init", "--initial-branch=main", ".");
    git(workspace, "add", "-A");
    git(workspace, "commit", "--no-verify", "-m", "donor baseline");
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    assert.equal(layout.coordRepoRoot, workspace);
    assert.equal(layout.coordPathPrefix, "coord");
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.ANCESTOR_REPOSITORY);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 RED: an unrelated ENCLOSING repository is refused, not adopted", () => {
  // A workspace that happens to sit inside somebody else's repository is the
  // exact "resolved against the wrong repository" defect. `rev-parse
  // --show-toplevel` would hand it over; we refuse it.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "cp-outer-"));
  try {
    write(path.join(outer, "unrelated.txt"), "not governance\n");
    git(outer, "init", "--initial-branch=main", ".");
    git(outer, "add", "-A");
    git(outer, "commit", "--no-verify", "-m", "unrelated repo");

    const workspace = path.join(outer, "workspace");
    const coordDir = path.join(workspace, "coord");
    write(path.join(coordDir, "GOVERNANCE.md"), "# g\n");

    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.FOREIGN_ANCESTOR);
    assert.equal(layout.coordRepoRoot, null, "a foreign enclosing repository must never become coordRepoRoot");
    assert.equal(fs.realpathSync(layout.foreign_root), fs.realpathSync(outer));

    // And the refusal names coord/ and the fix.
    const ops = buildOps(layout);
    assert.throws(
      () => ops.coordRepoRoot("gov start"),
      (error) => {
        assert.match(error.message, /unrelated enclosing Git repository/);
        assert.match(error.message, /git -C .*coord init/);
        return true;
      }
    );
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("COORD-635 RED: with no control-plane repository, control-plane git verbs refuse with one actionable message", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1, coordGit: false });
  try {
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    assert.equal(layout.coordRepoRoot, null);
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.NONE);
    const ops = buildOps(layout);
    assert.throws(
      () => ops.coordRepoRoot("gov start for a control-plane (Repo X) ticket"),
      (error) => {
        assert.match(error.message, /gov start for a control-plane \(Repo X\) ticket requires/);
        assert.match(error.message, /--git-init/);
        assert.match(error.message, /container above coord\/ is never a Git repository/);
        return true;
      }
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ===========================================================================
// 2. Path-namespace reconciliation (defect 5).
// ===========================================================================

test("COORD-635: coord-repo paths translate to manifest paths in BOTH topologies", () => {
  const adopter = { coordDir: "/w/coord", coordRepoRoot: "/w/coord", coordPathPrefix: "" };
  const donor = { coordDir: "/w/coord", coordRepoRoot: "/w", coordPathPrefix: "coord" };

  // The adopter case is the one that silently missed control-plane changes:
  // git says "scripts/...", the manifest says "coord/scripts/...".
  assert.equal(manifestPathForCoordRepoPath(adopter, "scripts/worktree-ops.js"), "coord/scripts/worktree-ops.js");
  assert.equal(manifestPathForCoordRepoPath(donor, "coord/scripts/worktree-ops.js"), "coord/scripts/worktree-ops.js");

  // Round-trips.
  assert.equal(coordRepoPathForManifestPath(adopter, "coord/scripts/worktree-ops.js"), "scripts/worktree-ops.js");
  assert.equal(coordRepoPathForManifestPath(donor, "coord/scripts/worktree-ops.js"), "coord/scripts/worktree-ops.js");

  // A path outside coord/ is NOT control-plane content and must not be
  // force-fitted into the manifest namespace.
  assert.equal(manifestPathForCoordRepoPath(donor, "create-concord/lib/install-plan.js"), null);
  assert.equal(coordRepoPathForManifestPath(adopter, "create-concord/lib/install-plan.js"), null);
});

test("COORD-635 RED: without translation, an adopter control-plane change is NOT attributed", () => {
  // Demonstrates the defect the translation removes: comparing raw
  // coord-repo-relative git output against manifest paths matches nothing.
  const adopter = { coordDir: "/w/coord", coordRepoRoot: "/w/coord", coordPathPrefix: "" };
  const manifestPaths = new Set(["coord/scripts/worktree-ops.js", "coord/engine-pin.json"]);
  const rawGitOutput = "scripts/worktree-ops.js";

  assert.equal(manifestPaths.has(rawGitOutput), false, "the untranslated path misses — this is the defect");
  assert.equal(manifestPaths.has(manifestPathForCoordRepoPath(adopter, rawGitOutput)), true, "translated, it is attributed");
});

test("COORD-635: the worktree runtime directory follows coordRepoRoot, not a hardcoded coord/", () => {
  const adopter = { coordDir: "/w/coord", coordRepoRoot: "/w/coord", coordPathPrefix: "" };
  const donor = { coordDir: "/w/coord", coordRepoRoot: "/w", coordPathPrefix: "coord" };
  // A worktree OF the coord repository mirrors coordRepoRoot: governance state
  // is at <worktree>/.runtime, NOT <worktree>/coord/.runtime.
  assert.equal(coordWorktreeRuntimeDir(adopter, "/wt/COORD-1"), path.join("/wt/COORD-1", ".runtime"));
  assert.equal(coordWorktreeRuntimeDir(donor, "/wt/COORD-1"), path.join("/wt/COORD-1", "coord", ".runtime"));
});

// ===========================================================================
// 3. The full control-plane worktree lifecycle, with both barrier layers armed
//    over the container AND every sibling product repository.
// ===========================================================================

test("COORD-635: full control-plane lifecycle (start -> commit -> cleanup) leaves container and product repos untouched", () => {
  const { workspace, coordDir, repos } = buildAdopterWorkspace({ productRepos: 3 });
  try {
    withCoordDir(coordDir, () => {
      const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
      const ops = buildOps(layout, { repoRoots: Object.fromEntries(repos.map((r, i) => [String.fromCharCode(65 + i), r.path])) });

      const containerBefore = fullWitness(workspace, CONTAINER_SKIP);
      const reposBefore = repos.map((repo) => ({ repo, witness: fullWitness(repo.path) }));

      // --- start -------------------------------------------------------
      const worktree = path.join(coordDir, ".worktrees", "claudea11", "COORD-900");
      const prepared = ops.ensureTicketWorkspace({
        repoCode: "X",
        worktree,
        branch: "agent/claudea11-coord-900",
        base: "main",
      });
      assert.equal(prepared.createdWorktree, true);
      assert.equal(fs.existsSync(worktree), true);

      // It is a worktree OF coord/, registered in coord/.git — not of the container.
      const registered = ops.listGitWorktrees(coordDir).map((e) => path.resolve(e.path));
      assert.ok(registered.includes(path.resolve(worktree)), "the worktree must be registered in coord/.git");
      assert.equal(path.resolve(git(worktree, "rev-parse", "--show-toplevel")), path.resolve(worktree));

      // Runtime state at <worktree>/.runtime — the adopter shape (defect 3).
      assert.equal(fs.existsSync(path.join(worktree, ".runtime", "locks")), true);
      assert.equal(fs.existsSync(path.join(worktree, "coord", ".runtime")), false,
        "the donor-shaped <worktree>/coord/.runtime must NOT be created in an adopter workspace");

      // --- commit ------------------------------------------------------
      write(path.join(worktree, "scripts", "worktree-ops.js"), "// engine change\n");
      git(worktree, "add", "--", "scripts/worktree-ops.js");
      git(worktree, "commit", "--no-verify", "-m", "COORD-900: control-plane change");
      const head = git(worktree, "rev-parse", "HEAD");

      // Git reports the change coord-repo-relative; translation makes it
      // attributable against the manifest namespace.
      const changed = git(worktree, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean);
      assert.deepEqual(changed, ["scripts/worktree-ops.js"]);
      assert.equal(manifestPathForCoordRepoPath(layout, changed[0]), "coord/scripts/worktree-ops.js");

      // --- land into the control-plane integration branch ---------------
      git(coordDir, "merge", "--no-ff", "-m", "merge COORD-900", "agent/claudea11-coord-900");

      // --- cleanup after a SUCCESSFUL closeout ---------------------------
      const removed = ops.removeGovernedWorktree({
        repoRoot: layout.coordRepoRoot,
        worktree,
        branch: "agent/claudea11-coord-900",
        deleteBranch: true,
        label: "Ticket COORD-900 worktree",
      });
      assert.equal(removed.deregistered, true, "cleanup must DEREGISTER, not merely delete");
      assert.equal(fs.existsSync(worktree), false);

      // `git worktree list` is clean afterward — no orphan registration.
      const after = ops.listGitWorktrees(coordDir).map((e) => path.resolve(e.path));
      assert.deepEqual(after, [path.resolve(coordDir)], "only the coord repository root may remain registered");
      assert.equal(head.length, 40);

      // --- both barrier layers, over the container and every product repo ---
      assertUntouched("workspace container", containerBefore, fullWitness(workspace, CONTAINER_SKIP));
      for (const { repo, witness } of reposBefore) {
        assertUntouched(`product repository ${repo.name}`, witness, fullWitness(repo.path));
      }
      // And the container never became a repository.
      assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 RED: the barrier witness CATCHES a spawned git write into a product repository", () => {
  // Proves the guard can fail. A spawned `git branch` is structurally invisible
  // to any in-process fs hook — only the witness layer sees it. This is the
  // same class COORD-624 caught; re-armed here for the control-plane lifecycle.
  const { workspace, repos } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    const victim = repos[0];
    const before = fullWitness(victim.path);
    git(victim.path, "branch", "sneaky-branch");
    assert.throws(
      () => assertUntouched(`product repository ${victim.name}`, before, fullWitness(victim.path)),
      /Git witness key "refs_digest" moved/
    );
    // Restore, and confirm the witness agrees the repository is untouched again.
    git(victim.path, "branch", "-D", "sneaky-branch");
    assertUntouched(`product repository ${victim.name}`, before, fullWitness(victim.path));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 RED: the barrier witness CATCHES a staged-then-restored write (index digest)", () => {
  // A final-state comparison alone cannot distinguish write-then-restore from
  // "never touched". The INDEX digest is what "was anything staged?" means.
  const { workspace, repos } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    const victim = repos[0];
    const before = fullWitness(victim.path);
    fs.writeFileSync(path.join(victim.path, "src", "index.js"), "module.exports = 'tampered';\n");
    git(victim.path, "add", "-A");
    const during = fullWitness(victim.path);
    assert.notEqual(during.git.index_digest, before.git.index_digest, "the index must record the staging");
    assert.throws(() => assertUntouched("victim", before, during), /index_digest|content must be byte-for-byte/);
    // Restore fully.
    git(victim.path, "reset", "--hard", "HEAD");
    assertUntouched("victim after restore", before, fullWitness(victim.path));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. Cleanup: refuses a dirty worktree; deregisters rather than deleting;
//    and `gov cleanup-worktree coord` accepts the control-plane case at all.
// ===========================================================================

test("COORD-635 RED: cleanup REFUSES a dirty control-plane worktree, then succeeds once it is clean", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    withCoordDir(coordDir, () => {
      const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
      const ops = buildOps(layout);
      const worktree = path.join(coordDir, ".worktrees", "claudea11", "COORD-901");
      ops.ensureTicketWorkspace({ repoCode: "X", worktree, branch: "agent/claudea11-coord-901", base: "main" });

      // Uncommitted control-plane work.
      write(path.join(worktree, "IN-PROGRESS.md"), "work that must not be discarded\n");
      git(worktree, "add", "-A");

      // RED: refused, and the refusal names the governed way forward.
      assert.throws(
        () => ops.cleanupWorktree("coord", "COORD-901", { yes: true }),
        (error) => {
          assert.match(error.message, /is dirty/);
          assert.match(error.message, /refuses to discard uncommitted work/);
          assert.match(error.message, /gov commit-ticket/);
          return true;
        }
      );
      // The work is still there — nothing was discarded as a side effect.
      assert.equal(fs.existsSync(path.join(worktree, "IN-PROGRESS.md")), true);

      // GREEN: commit it, and the SAME command now succeeds. The fix is not a
      // blanket refusal.
      git(worktree, "commit", "--no-verify", "-m", "COORD-901: keep the work");
      ops.cleanupWorktree("coord", "COORD-901", { yes: true });
      assert.equal(fs.existsSync(worktree), false);
      assert.deepEqual(
        ops.listGitWorktrees(coordDir).map((e) => path.resolve(e.path)),
        [path.resolve(coordDir)],
        "the registration must be gone too"
      );
      // The committed work survives on its branch.
      assert.ok(git(coordDir, "log", "--format=%s", "-n", "1", "agent/claudea11-coord-901").includes("COORD-901"));
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: cleanup-worktree accepts the control-plane case (it used to refuse it outright)", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    withCoordDir(coordDir, () => {
      const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
      const ops = buildOps(layout);
      // Both aliases resolve to the control plane.
      assert.equal(ops.isControlPlaneRepoArg("coord"), true);
      assert.equal(ops.isControlPlaneRepoArg("X"), true);
      assert.equal(ops.isControlPlaneRepoArg("repo-1"), false);

      // An unknown repo arg still refuses, and now advertises `coord`.
      assert.throws(
        () => ops.cleanupWorktree("nope", "COORD-902", { yes: true }),
        /cleanup-worktree repo must be one of: .*coord\./
      );
      // The destructive-consent guard is untouched.
      assert.throws(() => ops.cleanupWorktree("coord", "COORD-902", {}), /rerun with --yes/);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: cleanup PRUNES an orphaned registration left by a directory-only delete", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    withCoordDir(coordDir, () => {
      const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
      const ops = buildOps(layout);
      const worktree = path.join(coordDir, ".worktrees", "claudea11", "COORD-903");
      ops.ensureTicketWorkspace({ repoCode: "X", worktree, branch: "agent/claudea11-coord-903", base: "main" });

      // Simulate the residue an older engine produced: delete the directory
      // WITHOUT deregistering. This is the state that required a manual
      // `git worktree remove` / `prune`.
      fs.rmSync(worktree, { recursive: true, force: true });
      const audit = ops.auditCoordWorktrees(new Map());
      assert.equal(audit.orphaned_registrations.length, 1, "the orphaned registration must be visible");

      ops.removeGovernedWorktree({ repoRoot: coordDir, worktree, branch: null, deleteBranch: false });
      assert.deepEqual(
        ops.listGitWorktrees(coordDir).map((e) => path.resolve(e.path)),
        [path.resolve(coordDir)],
        "the orphaned registration must be pruned"
      );
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: the ephemeral-runtime exclusion is narrow — it never hides real work", () => {
  const { significantWorktreeStatusEntries } = require("./control-plane-paths.js");
  const adopter = { coordDir: "/w/coord", coordRepoRoot: "/w/coord", coordPathPrefix: "" };
  const wt = "/wt/COORD-1";

  // Only the engine's own runtime scaffolding is excluded...
  assert.deepEqual(
    significantWorktreeStatusEntries(adopter, wt, "?? .runtime/\n?? .runtime/locks/x.lock\n M .runtime/.gitignore\n"),
    []
  );
  // ...and nothing else is. Tracked edits, untracked new files, staged
  // additions, deletions and renames all still count as work.
  const real = "?? NEW.md\n M scripts/worktree-ops.js\nA  docs/added.md\n D docs/gone.md\nR  a.md -> b.md\n";
  assert.equal(significantWorktreeStatusEntries(adopter, wt, real).length, 5);
  // A path that merely LOOKS like the runtime dir is not excluded.
  assert.equal(significantWorktreeStatusEntries(adopter, wt, "?? .runtimes/x\n?? my.runtime\n").length, 2);
  // Donor topology: the runtime dir sits under coord/, and the exclusion follows it.
  const donor = { coordDir: "/w/coord", coordRepoRoot: "/w", coordPathPrefix: "coord" };
  assert.deepEqual(significantWorktreeStatusEntries(donor, wt, "?? coord/.runtime/\n"), []);
  assert.equal(significantWorktreeStatusEntries(donor, wt, "?? .runtime/\n").length, 1,
    "in the donor topology a top-level .runtime/ is NOT the governed runtime dir");
});

// ===========================================================================
// 5. Doctor attribution: control-plane residue is coord/ state, never
//    backend/frontend state.
// ===========================================================================

test("COORD-635 RED: a product-repo directory that is not its own repository must NOT claim coord's worktrees", () => {
  // The reproduction of the misattribution: `git -C <dir> worktree list` walks
  // UP when <dir> is not a repository, and answers for the enclosing one. That
  // is how stale control-plane worktrees were reported as backend/frontend
  // state, sending the operator to the wrong repository.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp-misattr-"));
  try {
    const coordDir = path.join(workspace, "coord");
    write(path.join(coordDir, "GOVERNANCE.md"), "# g\n");
    write(path.join(coordDir, ".gitignore"), ".worktrees/\n");
    git(workspace, "init", "--initial-branch=main", ".");
    git(workspace, "add", "-A");
    git(workspace, "commit", "--no-verify", "-m", "donor baseline");

    // A configured product-repo directory that is NOT its own repository.
    const notARepo = path.join(workspace, "backend");
    fs.mkdirSync(notARepo, { recursive: true });

    withCoordDir(coordDir, () => {
      const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
      const ops = buildOps(layout, { repoRoots: { B: notARepo } });
      const worktree = path.join(coordDir, ".worktrees", "claudea11", "COORD-904");
      ops.ensureTicketWorkspace({ repoCode: "X", worktree, branch: "agent/claudea11-coord-904", base: "main" });

      // RED (the old behaviour, demonstrated directly): the raw git listing
      // taken from the non-repository DOES report the control-plane worktree.
      const raw = ops.listGitWorktrees(notARepo).map((e) => path.resolve(e.path));
      assert.ok(raw.includes(path.resolve(worktree)), "raw git listing misattributes — this is the defect");

      // GREEN: the audit refuses to answer for a directory that is not its own
      // repository, so nothing is attributed to backend.
      const audit = ops.auditRepoWorktrees("B", new Map());
      assert.equal(audit.is_own_repository, false);
      assert.deepEqual(audit.worktrees, []);
      assert.deepEqual(audit.stale_ticket_worktrees, []);

      // And the control-plane audit DOES see it, naming the control-plane repo.
      const coordAudit = ops.auditCoordWorktrees(new Map());
      assert.equal(path.resolve(coordAudit.control_plane_repo_root), path.resolve(workspace));
      assert.deepEqual(coordAudit.worktrees.map((e) => path.resolve(e.path)), [path.resolve(worktree)]);
      assert.equal(coordAudit.worktrees[0].registered, true);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ===========================================================================
// 6. Control-plane landing evidence, proven against a CONTROLLED fixture
//    remote — never a live one.
// ===========================================================================

test("COORD-635: a control-plane landing on the fixture remote is classified remote_ancestry", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const landed = git(coordDir, "rev-parse", "HEAD");

    const assessment = evaluateControlPlaneLanding("COORD-905", { evidence: [`landed ${landed}`] }, { layout });
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(assessment.commit_sha, landed);
    assert.equal(assessment.base_ref, "main");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 RED: a control-plane landing NOT on the remote is REFUSED, then accepted once pushed", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });

    // A commit that exists locally but has NOT been pushed. Under the old code
    // this recorded delivery with no verification at all.
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "--no-verify", "-m", "COORD-906: unpushed control-plane change");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    // RED.
    assert.throws(
      () => evaluateControlPlaneLanding("COORD-906", { evidence: [`landed ${unpushed}`] }, { layout }),
      (error) => {
        assert.match(error.message, /is not an ancestor of origin\/main/);
        assert.match(error.message, /COORD-635\/ADR-0008/);
        return true;
      }
    );

    // GREEN: push, and the SAME evidence is accepted. Not a blanket refusal.
    git(coordDir, "push", "origin", "main");
    git(coordDir, "fetch", "origin", "main");
    const assessment = evaluateControlPlaneLanding("COORD-906", { evidence: [`landed ${unpushed}`] }, { layout });
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(assessment.commit_sha, unpushed);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691: the SAME unpushed landing that COORD-635 refuses is delivered by the governed pre-closeout push", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });

    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");
    const evidence = { evidence: [`landed ${unpushed}`] };

    // RED — the refusal COORD-635 owns, and the state an agent could not clear:
    // it says "push the integration branch", and pre-bash-guard refuses a
    // hand-run push to a protected branch. The message must now also NAME the
    // governed way out, or the refusal is still a dead end.
    assert.throws(
      () => evaluateControlPlaneLanding("COORD-908", evidence, { layout }),
      (error) => {
        assert.match(error.message, /is not an ancestor of origin\/main/);
        assert.match(error.message, /--push-before-closeout/);
        return true;
      }
    );
    assert.notEqual(
      git(remote, "rev-parse", "main"),
      unpushed,
      "opt-out must mean no push happened — the flag is the whole authorization"
    );

    // GREEN — same evidence, same check, one flag. No hand-run git anywhere.
    const assessment = evaluateControlPlaneLanding("COORD-908", evidence, { layout, pushBeforeCloseout: true });
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(assessment.commit_sha, unpushed);
    // Delivery is confirmed against the remote itself, not against the receipt.
    assert.equal(git(remote, "rev-parse", "main"), unpushed);

    // The receipt is the citation required of the landing record.
    const receipt = assessment.pre_closeout_push;
    assert.ok(receipt, "a push performed during closeout must be cited on the assessment");
    assert.equal(receipt.status, "pushed");
    assert.equal(receipt.forced, false);
    assert.equal(receipt.commit_sha, unpushed);
    assert.equal(receipt.remote_sha_after, unpushed);
    assert.notEqual(receipt.remote_sha_before, unpushed);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691: the receipt reaches the BOARD, which is the tracked artifact", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    const board = { landing_index: {} };
    const row = { ID: "COORD-909", Repo: "X" };
    const record = ensureControlPlaneLandingRecord("COORD-909", board, row, {
      layout,
      landed: [`landed ${unpushed}`],
      pushBeforeCloseout: true,
    });

    assert.equal(record.control_plane_verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    // coord/.runtime/ is gitignored; the board is not. A receipt that survives
    // only in runtime state is not durable evidence — that is the trap found
    // while landing COORD-680.
    assert.ok(record.pre_closeout_push, "the landing record must CITE the push, not assert delivery");
    assert.equal(record.pre_closeout_push.status, "pushed");
    assert.equal(record.pre_closeout_push.forced, false);
    assert.equal(board.landing_index["COORD-909"].pre_closeout_push.commit_sha, unpushed);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 1 finding 2) RED: a push that succeeds before a later failure is journaled as an external side effect", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    // Stand in for the governed mutation closeout runs inside.
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };

    evaluateControlPlaneLanding("COORD-911", { evidence: [`landed ${unpushed}`] }, { layout, pushBeforeCloseout: true });

    // THE POINT: the remote is advanced, so the effect must be attached to the
    // transaction NOW. Everything after this in closeout — cleanup, mark-done —
    // is still fallible, and a rollback takes the board (and the in-memory
    // receipt) with it. The journal keeps the record of what cannot be undone.
    const effects = state.activeGovernanceMutationContext.externalSideEffects;
    assert.equal(effects.length, 1, "a push that advanced a real remote must be recorded as an external side effect");
    assert.equal(effects[0].type, "control_plane_push");
    assert.equal(effects[0].ticket, "COORD-911");
    assert.equal(effects[0].commit_sha, unpushed);
    assert.equal(effects[0].remote_sha_after, unpushed);
    assert.equal(effects[0].forced, false);
    assert.ok(effects[0].recorded_at, "the recorder stamps when the irreversible thing happened");
    assert.equal(git(remote, "rev-parse", "main"), unpushed);
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 1 finding 2): the retry does NOT push again and CITES the original push", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    // Attempt 1: pushes, records the effect, then (as far as this test is
    // concerned) closeout fails downstream and the board is rolled back.
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };
    evaluateControlPlaneLanding("COORD-912", { evidence: [`landed ${unpushed}`] }, { layout, pushBeforeCloseout: true });
    const effect = state.activeGovernanceMutationContext.externalSideEffects[0];
    const remoteAfterFirst = git(remote, "rev-parse", "main");

    // The rollback: the mutation is journaled WITH its external side effect.
    const journalPath = path.join(workspace, "journal-fixture.ndjson");
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ ts: effect.recorded_at, command: "land", ticket: "COORD-912", result: "failed", details: { external_side_effects: [effect] } })}\n`
    );
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };

    // Attempt 2, the retry.
    const assessment = evaluateControlPlaneLanding(
      "COORD-912",
      { evidence: [`landed ${unpushed}`] },
      { layout, pushBeforeCloseout: true, journalPath }
    );

    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(
      state.activeGovernanceMutationContext.externalSideEffects.length,
      0,
      "the retry must NOT push again — the commit is already on the remote"
    );
    assert.equal(git(remote, "rev-parse", "main"), remoteAfterFirst, "the remote must not move on the retry");

    // And the record must not read as "the remote always had it".
    const cited = assessment.pre_closeout_push;
    assert.ok(cited, "the retry must cite the push that actually delivered the commit");
    assert.equal(cited.status, "already_present");
    assert.equal(cited.pushed, false, "this closeout pushed nothing; it is citing an earlier act");
    assert.equal(cited.commit_sha, unpushed);
    assert.equal(cited.remote_sha_after, unpushed);
    assert.match(cited.detail, /earlier governed pre-closeout push/);
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 2 finding 2): a push whose ACK was lost is still recorded as an external side effect", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const { gitTry } = require("./git-ops.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };

    // The push really lands; git reports failure afterwards. Believing the exit
    // status here would record NOTHING while the remote had already moved —
    // and a downstream rollback would then leave no trace of an irreversible
    // act, which is round 1's finding 2 all over again.
    const gitFn = (repoRoot, args) => {
      const real = gitTry(repoRoot, args);
      // The push RUNS — that is the point: the ref update reaches the server and
      // only the acknowledgement is lost. Faking the failure without running it
      // would test a different (and harmless) situation.
      return args[0] === "push"
        ? { status: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" }
        : real;
    };

    const assessment = evaluateControlPlaneLanding(
      "COORD-913",
      { evidence: [`landed ${unpushed}`] },
      { layout, pushBeforeCloseout: true, gitFn }
    );

    assert.equal(git(remote, "rev-parse", "main"), unpushed, "fixture: the push really reached the remote");
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);

    const effects = state.activeGovernanceMutationContext.externalSideEffects;
    assert.equal(effects.length, 1, "an irreversible act must be recorded even when git said it failed");
    assert.equal(effects[0].type, "control_plane_push");
    assert.equal(effects[0].delivered, true);
    assert.equal(effects[0].remote_moved, true);
    assert.equal(effects[0].acknowledged, false, "the record must preserve that the local ack was lost");
    assert.equal(effects[0].ack_lost, true);
    assert.equal(effects[0].remote_sha_after, unpushed);
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 2 finding 2): even a FAILED attempt is recorded, because the attempt itself is the audit fact", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const { gitTry } = require("./git-ops.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const before = git(remote, "rev-parse", "main");
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };
    const gitFn = (repoRoot, args) =>
      args[0] === "push"
        ? { status: 128, stdout: "", stderr: "fatal: unable to access remote" }
        : gitTry(repoRoot, args);

    assert.throws(
      () => evaluateControlPlaneLanding("COORD-914", { evidence: [`landed ${unpushed}`] }, { layout, pushBeforeCloseout: true, gitFn }),
      /is not an ancestor of origin\/main/,
      "a failed push must not be laundered into a successful landing",
    );
    assert.equal(git(remote, "rev-parse", "main"), before, "nothing reached the remote");

    const effects = state.activeGovernanceMutationContext.externalSideEffects;
    assert.equal(effects.length, 1, "the ATTEMPT is recorded — an outward attempt is an audit fact even when it failed");
    assert.equal(effects[0].delivered, false);
    assert.equal(effects[0].remote_moved, false);
    assert.equal(effects[0].status, "failed");
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 3 finding 2): a LOST-ACK push then a rollback — the retry cites it and preserves the lost ack", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const { gitTry } = require("./git-ops.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    // Attempt 1: the push lands, the ack is lost, then closeout fails and the
    // board is rolled back. The journal keeps the effect.
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };
    const gitFn = (repoRoot, args) => {
      const real = gitTry(repoRoot, args);
      return args[0] === "push"
        ? { status: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" }
        : real;
    };
    evaluateControlPlaneLanding("COORD-915", { evidence: [`landed ${unpushed}`] }, { layout, pushBeforeCloseout: true, gitFn });
    const effect = state.activeGovernanceMutationContext.externalSideEffects[0];
    assert.equal(effect.ack_lost, true, "fixture: the first attempt must be the lost-ack shape");
    assert.equal(git(remote, "rev-parse", "main"), unpushed);

    const journalPath = path.join(workspace, "journal-lostack.ndjson");
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ ts: effect.recorded_at, command: "land", ticket: "COORD-915", result: "failed", details: { external_side_effects: [effect] } })}\n`
    );
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };

    // Attempt 2: the retry.
    const assessment = evaluateControlPlaneLanding(
      "COORD-915",
      { evidence: [`landed ${unpushed}`] },
      { layout, pushBeforeCloseout: true, journalPath }
    );

    const cited = assessment.pre_closeout_push;
    assert.ok(cited, "the retry must cite the push that delivered the commit");
    assert.equal(cited.status, "already_present");
    assert.equal(cited.pushed, false, "this closeout pushed nothing");
    assert.equal(cited.earlier_attempt.delivered, true);
    assert.equal(cited.earlier_attempt.acknowledged, false, "the lost ack must survive into the citation");
    assert.equal(cited.earlier_attempt.ack_lost, true);
    assert.match(cited.detail, /acknowledgement was lost/);
    assert.equal(state.activeGovernanceMutationContext.externalSideEffects.length, 0, "the retry must not push again");
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691 (round 3 finding 2) RED: a recorded FAILED attempt is never credited with a delivery it did not make", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  const { state } = require("./governance-context.js");
  const { gitTry } = require("./git-ops.js");
  const saved = state.activeGovernanceMutationContext;
  try {
    const remote = attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const before = git(remote, "rev-parse", "main");
    write(path.join(coordDir, "docs", "note.md"), "unpushed\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "-m", "chore: unpushed control-plane landing");
    const unpushed = git(coordDir, "rev-parse", "HEAD");

    // Attempt 1 genuinely FAILS: no push happens at all.
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };
    const failingGit = (repoRoot, args) =>
      args[0] === "push"
        ? { status: 128, stdout: "", stderr: "fatal: unable to access remote" }
        : gitTry(repoRoot, args);
    assert.throws(
      () => evaluateControlPlaneLanding("COORD-916", { evidence: [`landed ${unpushed}`] }, { layout, pushBeforeCloseout: true, gitFn: failingGit }),
      /is not an ancestor of origin\/main/,
    );
    const effect = state.activeGovernanceMutationContext.externalSideEffects[0];
    assert.equal(effect.delivered, false, "fixture: the recorded attempt must be a failure");
    assert.equal(effect.status, "failed");
    assert.equal(git(remote, "rev-parse", "main"), before, "fixture: nothing reached the remote");

    const journalPath = path.join(workspace, "journal-failed.ndjson");
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ ts: effect.recorded_at, command: "land", ticket: "COORD-916", result: "failed", details: { external_side_effects: [effect] } })}\n`
    );

    // The commit reaches the remote by an INDEPENDENT route — a human push, a
    // different lane, anything. The governed attempt still failed.
    git(coordDir, "push", "origin", "main");
    git(coordDir, "fetch", "origin", "main");
    state.activeGovernanceMutationContext = { externalSideEffects: [], metadata: {} };

    const assessment = evaluateControlPlaneLanding(
      "COORD-916",
      { evidence: [`landed ${unpushed}`] },
      { layout, pushBeforeCloseout: true, journalPath }
    );

    const cited = assessment.pre_closeout_push;
    assert.ok(cited, "the recorded attempt is still worth citing — it just did not deliver");
    assert.equal(cited.earlier_attempt.delivered, false, "a failed attempt must NOT be credited with the delivery");
    assert.equal(cited.earlier_attempt.status, "failed");
    assert.doesNotMatch(
      cited.detail,
      /^delivered by an earlier governed pre-closeout push/,
      "attributing delivery to a confirmed failed attempt is a false record of an irreversible act",
    );
    assert.match(cited.detail, /did NOT deliver it/);
  } finally {
    state.activeGovernanceMutationContext = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691: a landing already on the remote records NO push receipt — the flag does not manufacture one", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const landed = git(coordDir, "rev-parse", "HEAD");

    const assessment = evaluateControlPlaneLanding(
      "COORD-910",
      { evidence: [`landed ${landed}`] },
      { layout, pushBeforeCloseout: true }
    );
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(
      assessment.pre_closeout_push,
      undefined,
      "no push was needed and none is recorded in history, so there is nothing to cite; an empty receipt " +
        "would be evidence of an act that never happened. Absence is only meaningful BECAUSE the retry path " +
        "cites a recorded earlier push (see the finding-2 tests above) — without that, absence would be " +
        "ambiguous between 'never pushed' and 'pushed then rolled back'."
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: with no governance remote, evidence is local_only — recorded, never refused", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const assessment = evaluateControlPlaneLanding("COORD-907", { evidence: ["landed locally"] }, { layout });
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.equal(assessment.reason, "no_control_plane_remote");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: HISTORICAL control-plane landings are grandfathered as local_only, never invalidated and never levelled up", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });

    // A pre-COORD-635 record: no `control_plane_verification` field, and a
    // commit that is NOT on the remote. It must still validate.
    write(path.join(coordDir, "docs", "old.md"), "old\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "--no-verify", "-m", "old work");
    const notOnRemote = git(coordDir, "rev-parse", "HEAD");
    const historical = {
      recorded_at: "2026-07-01T00:00:00.000Z",
      method: "no_pr",
      commit_sha: notOnRemote,
      provenance_status: "explicit",
      evidence: ["landed on the workspace branch"],
    };

    assert.equal(controlPlaneLandingVerificationClass(historical), CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.doesNotThrow(
      () => assertControlPlaneLandingIntegrity("COORD-113", historical, { layout }),
      "a historical record must NOT be retroactively invalidated"
    );

    // It is classified, but NOT as remotely verified.
    const entry = classifyControlPlaneLandingRecord("COORD-113", { Repo: "X" }, historical, { layout });
    assert.equal(entry.provenance, "control_plane");
    assert.equal(entry.evidence_class, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.notEqual(entry.status, "merged", "local-only evidence must not be silently levelled up to merged");

    // A record that CLAIMS remote verification IS re-verified — and fails.
    const claiming = { ...historical, control_plane_verification: CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY, base_ref: "main" };
    assert.throws(
      () => assertControlPlaneLandingIntegrity("COORD-908", claiming, { layout }),
      /claims remote-verified delivery but is not an ancestor of origin\/main/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 RED: a STALE refs/remotes/origin ref with no configured remote is NOT a governance remote", () => {
  // Found by landing this very ticket: the donor's remote is named
  // `concord-pub`, yet a 29-commit-stale refs/remotes/origin/main still
  // resolves. Treating that leftover as a governance remote holds every
  // landing to an ancestry bar against a ref nothing can ever update — a
  // blanket refusal, not a guard.
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const staleTip = git(coordDir, "rev-parse", "refs/remotes/origin/main");
    // Rename the remote and leave refs/remotes/origin/main behind, exactly as
    // a long-lived clone accumulates it.
    git(coordDir, "remote", "rename", "origin", "concord-pub");
    git(coordDir, "update-ref", "refs/remotes/origin/main", staleTip);
    assert.equal(git(coordDir, "rev-parse", "--verify", "refs/remotes/origin/main"), staleTip,
      "the stale tracking ref must still resolve — that is the trap");
    assert.equal(spawnSync("git", ["-C", coordDir, "remote", "get-url", "origin"], { env: GIT_ENV }).status !== 0, true);

    // A commit that is NOT on the stale ref. Under the naive check this was refused.
    write(path.join(coordDir, "docs", "after.md"), "after\n");
    git(coordDir, "add", "-A");
    git(coordDir, "commit", "--no-verify", "-m", "COORD-912: work after the remote was renamed");
    const landed = git(coordDir, "rev-parse", "HEAD");

    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const assessment = evaluateControlPlaneLanding("COORD-912", { evidence: [`landed ${landed}`] }, { layout });
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.equal(assessment.reason, "no_control_plane_remote");
    assert.equal(assessment.commit_sha, landed);

    // Restore a real `origin` and the ancestry bar applies again — the guard is
    // suppressed by the ABSENCE of a remote, never disabled.
    git(coordDir, "remote", "rename", "concord-pub", "origin");
    assert.throws(
      () => evaluateControlPlaneLanding("COORD-912", { evidence: [`landed ${landed}`] }, { layout }),
      /is not an ancestor of origin\/main/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: prose-only evidence is recorded as local_only, NOT refused (the guard is not a blanket refusal)", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    // A legitimate control-plane closeout whose evidence names no commit. It
    // cannot be checked against the remote; that makes it WEAKER evidence, not
    // proof of non-delivery. Refusing it would block every prose-only
    // control-plane closeout the lifecycle accepts today.
    const assessment = evaluateControlPlaneLanding(
      "COORD-911",
      { evidence: ["landed on the control-plane integration branch"] },
      { layout }
    );
    assert.equal(assessment.verification, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.equal(assessment.reason, "no_resolvable_commit_sha");
    assert.equal(assessment.commit_sha, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635: ensureControlPlaneLandingRecord stamps the evidence class and never invents evidence", () => {
  const { workspace, coordDir } = buildAdopterWorkspace({ productRepos: 1 });
  try {
    attachFixtureRemote(coordDir);
    const layout = resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace });
    const landed = git(coordDir, "rev-parse", "HEAD");

    // No evidence -> no record, and no new refusal.
    const emptyBoard = { landing_index: {}, pr_index: {} };
    assert.equal(ensureControlPlaneLandingRecord("COORD-909", emptyBoard, { Repo: "X" }, { layout }), null);
    assert.deepEqual(emptyBoard.landing_index, {});

    const board = { landing_index: {}, pr_index: { "COORD-910": ["local-review (no PR)"] } };
    const record = ensureControlPlaneLandingRecord(
      "COORD-910", board, { Repo: "X" },
      { landed: `Merged to control-plane main as ${landed}`, layout }
    );
    assert.equal(record.control_plane_verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(record.commit_sha, landed);
    assert.equal(record.base_ref, "main");
    assert.ok(record.evidence.some((e) => e.includes(landed)));

    // Idempotent: an existing record with evidence is never rewritten.
    const again = ensureControlPlaneLandingRecord("COORD-910", board, { Repo: "X" }, { landed: "different", layout });
    assert.equal(again, record);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
