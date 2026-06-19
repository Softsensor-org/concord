"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, GovernanceError } = require("./governance-test-utils.js");

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in state-io.js — canonical text read/write
// guards (writeCanonicalTextFile stale/fresh fencing) and the canonical
// syncable-paths surface (canonicalSyncablePaths). Exercised through the
// fully-wired `__testing` facade exactly as governance.test.js did.


test("writeCanonicalTextFile rejects stale coord overwrites", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-"));
  const tempFile = path.join(tempDir, "state.txt");
  fs.writeFileSync(tempFile, "alpha\n", "utf8");

  const original = __testing.readCanonicalTextFile(tempFile);
  __testing.writeCanonicalTextFile(tempFile, "beta\n", { expectedRaw: original });

  assert.equal(fs.readFileSync(tempFile, "utf8"), "beta\n");
});

test("ENT-001/COORD-105/COORD-108: canonicalSyncablePaths is the rendered+PLAN surface PLUS the durable .runtime evidence buckets (journal/plans); NOT the per-mutation snapshots/ history bucket NOR the mutating latest-snapshot pointer; never tasks.json/active/locks/sessions", () => {
  const paths = __testing.canonicalSyncablePaths();
  assert.deepEqual(paths.sort(), [
    ".runtime/governance-events.ndjson",
    ".runtime/plans",
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ]);
  // ENT-001: the durable evidence buckets are IN the set (so each finalize
  // commits the journal alongside the board, clearing the freshness advisory).
  for (const durable of [
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
    "board/tasks.json",
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
      path.join(__dirname, "..", "..", ".gitignore"),
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
