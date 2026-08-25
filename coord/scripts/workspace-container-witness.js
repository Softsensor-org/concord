"use strict";

// COORD-670: the ADR-0008 workspace-container Git witness, owned by the
// control-plane engine.
//
// WHY THIS MODULE EXISTS (packaging boundary — read before "de-duplicating" it).
//
// ADR-0008 says the workspace container is NEVER a Git repository: Git-backed
// governance lives in the independent control-plane repository at coord/, and
// product repositories are independent siblings. Two DIFFERENT operations have
// to uphold that invariant, and they belong to two different artifacts:
//
//   1. INSTALLATION — create-concord/lib/install-plan.js, the scaffolder engine.
//      It samples the container before/after every install phase so a spawned
//      `git init` cannot slip past the in-process fs barrier.
//   2. GOVERNED OPERATION — this engine. Every worktree cut, control-plane
//      landing and workspace recovery must likewise leave the container's Git
//      state exactly where it found it.
//
// Until COORD-670 the governed-operation tests borrowed the installer's witness
// via `require("../../create-concord/lib/install-plan.js")`. That require is
// unsatisfiable in every published cut: release/build-public-release.sh strips
// create-concord/ by design ("the scaffolder package (it vendors THIS cut; must
// never be inside it)"). The result was a guard that could not run in the
// artifact it was supposed to protect — control-plane-lifecycle.test.js and
// governed-workspace-recovery.test.js died at module load inside a built
// Community cut. Relocating the instrument here makes those assertions EXECUTE
// in the shipped artifact.
//
// WHY THE INSTALLER KEEPS ITS OWN COPY instead of requiring this one:
//   • install-plan.js depends on node builtins ONLY, and is packed as
//     create-concord with a GENERATED template/coord bundle. Requiring the
//     witness out of that bundle would mean the installer sources its own
//     safety barrier FROM THE PAYLOAD IT IS INSTALLING — a broken or hostile
//     bundle could then neuter the very guard meant to police it. The thing
//     that must not trust the payload cannot import from the payload.
//   • So the two implementations are independent BY DESIGN, and bound against
//     drift by a donor-only behavioural parity test:
//     create-concord/container-witness-parity.test.js (module `packaging`),
//     which fails if the two witnesses ever disagree on identical fixtures.
//
// This module therefore depends on node builtins ONLY. It must never acquire a
// dependency that any published cut lacks — that is the defect it exists to
// close. release/audit-shipped-module-graph.js enforces that for every shipped
// file, so the class cannot come back.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// Explicit allowlist: nothing from the parent environment — credentials,
// tokens, cloud keys — leaks into a witness subprocess.
const SUBPROCESS_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"];

function gitEnv() {
  const env = {};
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Never prompt, never consult credential helpers or system config.
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// The witness keys that constitute "the container's Git state". Exported so a
// caller cannot silently assert a SUBSET: a new key added here is immediately
// covered by every comparison built on changedWitnessKeys().
const CONTAINER_WITNESS_KEYS = Object.freeze([
  "git_dir_present",
  "is_git_repository",
  "head",
  "branch",
  "refs_digest",
  "index_digest",
  "index_present",
  "config_present",
  "config_digest",
]);

// `git init` is a SPAWNED process, invisible to an in-process fs hook, so the
// container carries a refs/HEAD/branch/index/config witness instead. Sampling it
// before and after an operation catches a write-then-restore in the window it
// existed — a final-state comparison alone could not distinguish that from
// "never touched".
function witnessWorkspaceContainer(targetDir) {
  const dir = path.resolve(targetDir);
  const gitDir = path.join(dir, ".git");
  const gitDirPresent = fs.existsSync(gitDir);
  const witness = {
    path: dir,
    exists: fs.existsSync(dir),
    git_dir_present: gitDirPresent,
    is_git_repository: false,
    head: null,
    branch: null,
    refs_digest: null,
    // The INDEX, not the working tree. `git status` would also report the
    // untracked files a legitimate operation writes into a pre-existing
    // container repository; the index is what "was anything staged?" means.
    index_digest: null,
    index_present: false,
    config_present: false,
    config_digest: null,
  };
  if (!witness.exists) return witness;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", env: gitEnv() });
  const toplevel = top.status === 0 ? path.resolve(String(top.stdout || "").trim()) : null;
  witness.is_git_repository = gitDirPresent || toplevel === dir;
  if (!witness.is_git_repository) return witness;
  const read = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
    return result.status === 0 ? String(result.stdout || "") : null;
  };
  const head = read(["rev-parse", "HEAD"]);
  const branch = read(["rev-parse", "--abbrev-ref", "HEAD"]);
  const refs = read(["for-each-ref", "--format=%(refname) %(objectname)"]);
  const index = read(["ls-files", "--stage"]);
  witness.head = head === null ? null : head.trim();
  witness.branch = branch === null ? null : branch.trim();
  witness.refs_digest = refs === null ? null : hash(refs);
  witness.index_digest = index === null ? null : hash(index);
  witness.index_present = fs.existsSync(path.join(gitDir, "index"));
  witness.config_present = fs.existsSync(path.join(gitDir, "config"));
  // Digest, never content: a credential helper, remote or identity change in a
  // pre-existing container repository must be detectable without the witness
  // ever emitting what it read.
  let configBytes = null;
  try {
    configBytes = fs.readFileSync(path.join(gitDir, "config"), "utf8");
  } catch {
    configBytes = null;
  }
  witness.config_digest = configBytes === null ? null : hash(configBytes);
  return witness;
}

// The witness keys that MOVED between two samples. Returns [] when the Git state
// is byte-identical. Callers own their own failure prose (a lifecycle violation
// and an install violation do not read the same), but they must not own the key
// list.
function changedWitnessKeys(before, after) {
  if (!before || !after) return [];
  return CONTAINER_WITNESS_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

module.exports = {
  CONTAINER_WITNESS_KEYS,
  changedWitnessKeys,
  witnessWorkspaceContainer,
};
