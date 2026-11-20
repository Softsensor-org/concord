const createSyncProvenance = require("./sync-provenance.js");
const { gitTry } = require("./git-ops.js");
// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { moveFileIfNeeded, computeSyncDelta } = require("./state-io.js");

const { __testing, GovernanceError } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

test("moveFileIfNeeded preserves missing and same-path sources and creates destination parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-state-io-move-"));
  try {
    const missing = path.join(root, "missing.txt");
    const missingTarget = path.join(root, "missing-target", "file.txt");
    assert.equal(moveFileIfNeeded(missing, missingTarget), missingTarget);
    assert.equal(fs.existsSync(missingTarget), false);

    const same = path.join(root, "same.txt");
    fs.writeFileSync(same, "preserve me\n");
    assert.equal(moveFileIfNeeded(same, same), same);
    assert.equal(fs.readFileSync(same, "utf8"), "preserve me\n");

    const source = path.join(root, "source.txt");
    const target = path.join(root, "nested", "destination.txt");
    fs.writeFileSync(source, "rename me\n");
    assert.equal(moveFileIfNeeded(source, target), target);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(target, "utf8"), "rename me\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("moveFileIfNeeded copies across EXDEV and propagates other rename failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-state-io-move-fallback-"));
  const originalRename = fs.renameSync;
  try {
    const source = path.join(root, "source.txt");
    const target = path.join(root, "cross-device", "destination.txt");
    fs.writeFileSync(source, "copy then remove\n");
    fs.renameSync = (from, to) => {
      if (from === source) {
        const error = new Error("cross-device fixture");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename.call(fs, from, to);
    };
    assert.equal(moveFileIfNeeded(source, target), target);
    assert.equal(fs.readFileSync(target, "utf8"), "copy then remove\n");
    assert.equal(fs.existsSync(source), false);

    const refusedSource = path.join(root, "refused.txt");
    const refusedTarget = path.join(root, "refused-dir", "destination.txt");
    fs.writeFileSync(refusedSource, "keep on failure\n");
    const failure = new Error("permission fixture");
    failure.code = "EACCES";
    fs.renameSync = (from, to) => {
      if (from === refusedSource) throw failure;
      return originalRename.call(fs, from, to);
    };
    assert.throws(() => moveFileIfNeeded(refusedSource, refusedTarget), (error) => error === failure);
    assert.equal(fs.readFileSync(refusedSource, "utf8"), "keep on failure\n");
    assert.equal(fs.existsSync(refusedTarget), false);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in state-io.js — canonical text read/write
// guards (writeCanonicalTextFile stale/fresh fencing) and the canonical
// syncable-paths surface (canonicalSyncablePaths). Exercised through the
// fully-wired `__testing` facade exactly as governance.test.js did.


test("writeCanonicalTextFile rejects stale coord overwrites", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-"));
  const tempFile = path.join(tempDir, "state.txt");
  fs.writeFileSync(tempFile, "alpha\n", "utf8");

  const original = __testing.readCanonicalTextFile(tempFile);
  fs.writeFileSync(tempFile, "beta\n", "utf8");

  assert.throws(
    () => __testing.writeCanonicalTextFile(tempFile, "gamma\n", { expectedRaw: original }),
    (error) => error instanceof GovernanceError && /changed during this command/i.test(error.message)
  );
  assert.equal(fs.readFileSync(tempFile, "utf8"), "beta\n");
});

test("writeCanonicalTextFile accepts fresh coord writes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-"));
  const tempFile = path.join(tempDir, "state.txt");
  fs.writeFileSync(tempFile, "alpha\n", "utf8");

  const original = __testing.readCanonicalTextFile(tempFile);
  __testing.writeCanonicalTextFile(tempFile, "beta\n", { expectedRaw: original });

  assert.equal(fs.readFileSync(tempFile, "utf8"), "beta\n");
});

test("COORD-533: real canonical sync scope includes board source, views and durable evidence, never ephemeral runtime", () => {
  const paths = __testing.canonicalSyncablePaths();
  assert.deepEqual(paths.sort(), [
    ".runtime/governance-events.ndjson",
    ".runtime/plans",
    "PLAN.md",
    "board/tasks.json",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ]);
  // Every sync publishes source with its views and durable evidence, including
  // ordinary file-ticket intake; terminal-only inclusion was insufficient.
  for (const durable of [
    "board/tasks.json",
    ".runtime/governance-events.ndjson",
    ".runtime/plans",
  ]) {
    assert.equal(
      paths.includes(durable),
      true,
      `canonicalSyncablePaths must include durable bucket ${durable}`
    );
  }
  // COORD-105: the per-mutation governance-snapshots/ history bucket is NOT
  // syncable (unbounded git bloat; board validate never reads it).
  assert.equal(
    paths.includes(".runtime/governance-snapshots"),
    false,
    "canonicalSyncablePaths must NOT include the unbounded governance-snapshots history bucket"
  );
  // COORD-108: the mutating board-state-at-last-mutation pointer is NOT
  // syncable (it changes on every gov command -> perpetually-dirty worktree;
  // it is a regenerable pointer board validate never reads).
  assert.equal(
    paths.includes(".runtime/governance-latest-snapshot.json"),
    false,
    "canonicalSyncablePaths must NOT include the mutating governance-latest-snapshot pointer"
  );
  // Ephemeral runtime buckets (locks/sessions/agents) must NEVER be synced.
  for (const banned of [
    "active",
    "QUESTIONS.md",
    ".runtime/governance-snapshots",
    ".runtime/governance-latest-snapshot.json",
    ".runtime/locks",
    ".runtime/agent_sessions.json",
    ".runtime/agents.json",
    ".runtime/session-threads",
    ".runtime/gate-procs",
  ]) {
    assert.equal(
      paths.some((p) => p === banned || p.startsWith(`${banned}/`)),
      false,
      `canonicalSyncablePaths must NOT include ${banned}`
    );
  }
});

test("COORD-196: a terminal-boundary sync commit (board json in the path set) ATOMICALLY commits the row transition — no residual uncommitted board change; a sync WITHOUT it leaves the row dirty (the pre-fix defect)", () => {
  const { execFileSync } = require("node:child_process");

  // Helper: stand up a temp git repo with a committed board json, then mutate
  // the board row (simulating markDone flipping Status -> done before the
  // terminal-boundary sync runs) and exercise commitCanonicalDelta over the
  // delta computed for a given pathspec set.
  const withRepo = (fn) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord196-finalize-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
      // A committed board json + a committed rendered artifact (the derived
      // surface the sync always covers).
      fs.mkdirSync(path.join(repoRoot, "board"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "rendered"), { recursive: true });
      const boardRel = "board/tasks.json";
      const renderedRel = "rendered/TASKS.md";
      fs.writeFileSync(
        path.join(repoRoot, boardRel),
        JSON.stringify({ row: { Status: "doing", Owner: "agent" } }, null, 2) + "\n",
        "utf8"
      );
      fs.writeFileSync(path.join(repoRoot, renderedRel), "doing\n", "utf8");
      execFileSync("git", ["add", boardRel, renderedRel], { cwd: repoRoot });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: repoRoot });

      // Terminal boundary: the row was already flipped to done on disk (status
      // + Owner + landing_index) and the derived artifact re-rendered.
      fs.writeFileSync(
        path.join(repoRoot, boardRel),
        JSON.stringify(
          { row: { Status: "done", Owner: "agent", landing_index: { idx: 1 } } },
          null,
          2
        ) + "\n",
        "utf8"
      );
      fs.writeFileSync(path.join(repoRoot, renderedRel), "done\n", "utf8");

      const residualBoardDirty = () =>
        execFileSync("git", ["status", "--porcelain=v1", "--", boardRel], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim() !== "";

      const syncService = createSyncProvenance({
        withActiveCommandFence: (_command, run) => run(),
        gitTry,
        fail: (message) => { throw new Error(message); },
        COORD_DIR: repoRoot,
        DEFAULT_PATHS: { boardPath: path.join(repoRoot, boardRel) },
      });
      fn({ repoRoot, boardRel, renderedRel, residualBoardDirty, syncService });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  };

  // WITH the board json in the path set (the COORD-196 terminal-boundary path):
  // the row transition is committed atomically and NO residual board change
  // remains in the working tree.
  withRepo(({ repoRoot, boardRel, renderedRel, residualBoardDirty, syncService }) => {
    const delta = __testing.computeSyncDelta(repoRoot, [renderedRel, boardRel]);
    assert.ok(
      delta.includes(boardRel),
      "terminal-boundary delta must include the canonical board json"
    );
    syncService.commitCanonicalDelta(repoRoot, "chore: finalize sync", delta);
    assert.equal(
      residualBoardDirty(),
      false,
      "after the terminal-boundary sync commit the board row must be committed atomically with NO residual uncommitted change"
    );
  });

  // WITHOUT the board json (the standalone `gov sync` / pre-fix behavior): the
  // derived artifact is committed but the canonical board row stays DIRTY —
  // this is exactly the defect COORD-196 fixes, asserted as a negative.
  withRepo(({ repoRoot, boardRel, renderedRel, residualBoardDirty, syncService }) => {
    const delta = __testing.computeSyncDelta(repoRoot, [renderedRel]);
    assert.ok(
      !delta.includes(boardRel),
      "a sync without the board pathspec must not pick up the board json"
    );
    syncService.commitCanonicalDelta(repoRoot, "chore: derived-only sync", delta);
    assert.equal(
      residualBoardDirty(),
      true,
      "without the board json in the path set the row transition is left uncommitted (the pre-fix residual)"
    );
  });
});

test("ENT-001: computeSyncDelta matches DIRECTORY pathspecs against their untracked contents (not just collapsed `?? dir/`)", () => {
  const { execFileSync } = require("node:child_process");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ent001-delta-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    // Directory pathspec with brand-new (untracked) shards inside it.
    fs.mkdirSync(path.join(repoRoot, "plans"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "plans", "A.json"), "{}", "utf8");
    fs.writeFileSync(path.join(repoRoot, "plans", "B.json"), "{}", "utf8");
    // An exact-file pathspec that is unchanged (committed) -> not in delta.
    fs.writeFileSync(path.join(repoRoot, "PLAN.md"), "x", "utf8");
    execFileSync("git", ["add", "PLAN.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repoRoot });

    const delta = __testing.computeSyncDelta(repoRoot, ["plans", "PLAN.md"]);
    assert.deepEqual(
      delta,
      ["plans"],
      "directory pathspec with untracked shards must appear in the delta; unchanged exact file must not"
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ENT-001/COORD-105/COORD-108: .gitignore bucket policy — journal/plans are trackable; the per-mutation snapshots/ history bucket + the mutating latest-snapshot pointer + locks/sessions/agents/gate-procs stay ignored (git check-ignore in a temp repo)", () => {
  const { execFileSync } = require("node:child_process");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ent001-ignore-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    // Mirror the SHIPPED root .gitignore negation policy for coord/.runtime.
    const rootGitignore = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", ".gitignore"),
      "utf8"
    );
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), rootGitignore, "utf8");

    const mk = (rel) => {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "x", "utf8");
      return rel;
    };
    const isIgnored = (rel) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: repoRoot });
        return true; // exit 0 => ignored
      } catch {
        return false; // exit 1 => NOT ignored
      }
    };

    const tracked = [
      mk("coord/.runtime/governance-events.ndjson"),
      mk("coord/.runtime/plans/ENT-001.json"),
    ];
    const ignored = [
      // COORD-105: the per-mutation snapshot history bucket is ignored again
      // (unbounded git bloat; board validate never reads it).
      mk("coord/.runtime/governance-snapshots/abc.json"),
      // COORD-108: the mutating board-state-at-last-mutation pointer is ignored
      // again (perpetually-dirty worktree; board validate never reads it).
      mk("coord/.runtime/governance-latest-snapshot.json"),
      mk("coord/.runtime/locks/ENT-001.lock"),
      mk("coord/.runtime/agent_sessions.json"),
      mk("coord/.runtime/agents.json"),
      mk("coord/.runtime/session-instances.json"),
      mk("coord/.runtime/session-threads/t.json"),
      mk("coord/.runtime/gate-procs/p.json"),
    ];

    for (const rel of tracked) {
      assert.equal(isIgnored(rel), false, `durable bucket must be trackable: ${rel}`);
    }
    for (const rel of ignored) {
      assert.equal(isIgnored(rel), true, `ephemeral bucket must stay ignored: ${rel}`);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// A broken Git adapter may return a failure without stderr. A sync must refuse
// that failure instead of treating it as an empty/clean status result.
test("COORD-803: silent git status failure cannot be accepted as an empty sync delta", t => {
  const { spawnSync } = require("node:child_process");
  const { computeSyncDelta } = require("./state-io.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord803-silent-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitProbe = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(gitProbe.status, 0);
  const realGit = gitProbe.stdout.trim();
  const init = spawnSync(realGit, ["init", "-b", "main", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const shimDir = path.join(root, "bin");
  fs.mkdirSync(shimDir);
  const marker = path.join(root, "state.txt");
  fs.writeFileSync(marker, "unchanged\n");
  // Forward repository discovery to real Git; fail only the status boundary.
  const quotedGit = "'" + realGit.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(shimDir, "git"), `#!/bin/sh\nif [ "$3" = "status" ]; then exit 1; fi\nexec ${quotedGit} "$@"\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = shimDir;
    assert.throws(() => computeSyncDelta(root, ["state.txt"]), /git status failed/);
    assert.equal(fs.readFileSync(marker, "utf8"), "unchanged\n");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

// COORD-1012: git reports --show-toplevel as a realpath. A checkout reached through a symlinked
// parent (symlinked TMPDIR; macOS /var -> /private/var) must still surface its drift, both when
// coord is the repo root and when coord is a subdirectory of an outer repo. The fixture builds its
// own symlink, so the result does not depend on the host TMPDIR.
test("COORD-1012: computeSyncDelta reports canonical drift through a symlinked parent (repo-root and subdir layouts)", t => {
  const { gitFixture } = require("./test-git-fixture.js");
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1012-real-")));
  const linkParent = `${real}-link`;
  t.after(() => {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(linkParent, { force: true });
  });
  fs.symlinkSync(real, linkParent, "dir");
  const write = (root, rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, "utf8");
  };

  // Layout 1: coord is the repo root.
  const repo = path.join(real, "repo");
  fs.mkdirSync(repo);
  gitFixture(repo, ["init", "-q", "-b", "main"]);
  write(repo, "PLAN.md", "seed\n");
  write(repo, "rendered/TASKS.md", "seed\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "seed"]);
  const canonical = ["PLAN.md", "rendered/TASKS.md"];
  const repoViaLink = path.join(linkParent, "repo");
  assert.deepEqual(computeSyncDelta(repoViaLink, canonical), [], "clean tree through a symlink has no delta");
  write(repo, "PLAN.md", "drift\n");
  assert.deepEqual(
    computeSyncDelta(repoViaLink, canonical),
    ["PLAN.md"],
    "drift must not be dropped when the repo root is reached through a symlinked parent"
  );

  // Layout 2: coord is a subdirectory of an outer repo (git reports coord/PLAN.md).
  const outer = path.join(real, "outer");
  fs.mkdirSync(outer);
  gitFixture(outer, ["init", "-q", "-b", "main"]);
  write(outer, "coord/PLAN.md", "seed\n");
  write(outer, "coord/rendered/TASKS.md", "seed\n");
  gitFixture(outer, ["add", "."]);
  gitFixture(outer, ["commit", "-qm", "seed"]);
  const coordViaLink = path.join(linkParent, "outer", "coord");
  assert.deepEqual(computeSyncDelta(coordViaLink, canonical), [], "clean subdir through a symlink has no delta");
  write(outer, "coord/PLAN.md", "drift\n");
  assert.deepEqual(
    computeSyncDelta(coordViaLink, canonical),
    ["PLAN.md"],
    "drift must not be dropped when coord is a subdir of an outer repo reached through a symlinked parent"
  );
});

test("computeSyncDelta preserves literal Git paths and staged rename destinations", {
  skip: process.platform === "win32" && "the fixture uses POSIX filename characters",
}, (t) => {
  const { gitFixture } = require("./test-git-fixture.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-sync-literal-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => computeSyncDelta(root, ["state"]), /git rev-parse --show-toplevel failed/);
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["config", "core.quotePath", "true"]);
  const oldName = "before.json";
  const newName = "after -> destination.json";
  const quoted = '"quoted".json';
  const unicode = "évidence.json";
  const backslash = "state\\with-backslash.json";
  fs.writeFileSync(path.join(root, oldName), "rename only\n");
  gitFixture(root, ["add", "--", oldName]);
  gitFixture(root, ["commit", "-qm", "Fixture initial state"]);
  gitFixture(root, ["mv", "--", oldName, newName]);
  for (const name of [quoted, unicode, backslash]) fs.writeFileSync(path.join(root, name), "new state\n");
  assert.match(gitFixture(root, ["status", "--porcelain=v1"]), /^R\s/m, "the fixture includes an actual staged rename");
  assert.deepEqual(computeSyncDelta(root, [oldName, newName, quoted, unicode, backslash]), [newName, quoted, unicode, backslash].sort());
});

test("sync path inspection reports unavailable Git and canonicalization retains the lexical path if all probes fail", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-path-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    assert.throws(() => computeSyncDelta(root, ["state"]), /git rev-parse --show-toplevel failed/);
  } finally {
    process.env.PATH = previousPath;
  }
  const { canonicalCallerPath } = require("./canonical-path.js");
  const candidate = path.join(root, "not-created");
  const realpath = t.mock.method(fs, "realpathSync", () => { throw new Error("fixture filesystem unavailable"); });
  assert.equal(canonicalCallerPath(candidate), candidate);
  assert.equal(realpath.mock.calls.at(-1).arguments[0], path.parse(candidate).root);
});
