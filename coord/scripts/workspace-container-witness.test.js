"use strict";

// COORD-670: behaviour tests for the control-plane engine's ADR-0008
// workspace-container Git witness.
//
// These run in EVERY published cut. That is the point of the ticket: before
// COORD-670 the container witness was only exercised through
// create-concord/lib/install-plan.js, which release/build-public-release.sh
// strips from every artifact, so no published cut could execute a single
// container assertion.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const {
  witnessWorkspaceContainer,
  changedWitnessKeys,
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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function repoWithCommit(prefix) {
  const dir = tmpDir(prefix);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "one");
  return dir;
}

// ---------------------------------------------------------------------------
// The instrument itself
// ---------------------------------------------------------------------------

test("COORD-670: the witness module depends on node builtins ONLY (it can never re-acquire a stripped dependency)", () => {
  // Recorded at RUNTIME, not by scanning source text. A textual scan cannot tell
  // a real import from a specifier quoted inside a comment or a fixture string —
  // that is exactly the false-positive class this ticket had to disentangle (and
  // the first draft of this very test tripped on the specifier named in the
  // module's own header comment). Hooking Module._load records what the file
  // ACTUALLY requires.
  const probe = [
    'const Module = require("node:module");',
    "const target = process.argv[1];",
    "const seen = [];",
    "const original = Module._load;",
    "Module._load = function (request, parent, isMain) {",
    "  if (parent && parent.filename === target) seen.push(request);",
    "  return original.apply(this, arguments);",
    "};",
    "require(target);",
    "process.stdout.write(JSON.stringify(seen));",
  ].join("\n");
  const target = path.join(__dirname, "workspace-container-witness.js");
  const out = execFileSync(process.execPath, ["-e", probe, target], { encoding: "utf8" });
  const specifiers = JSON.parse(out);
  assert.ok(specifiers.length > 0, "expected the module to require something");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:"),
      `workspace-container-witness.js must require only node: builtins, found "${specifier}"`
    );
  }
});

test("COORD-670: a non-existent container reports exists=false and no Git state", () => {
  const missing = path.join(tmpDir("coord-witness-missing-"), "nope");
  const witness = witnessWorkspaceContainer(missing);
  assert.equal(witness.exists, false);
  assert.equal(witness.is_git_repository, false);
  assert.equal(witness.head, null);
  assert.equal(witness.index_digest, null);
  assert.equal(witness.config_digest, null);
});

test("COORD-670: a plain directory is NOT a Git repository and carries no Git state", () => {
  const dir = tmpDir("coord-witness-plain-");
  const witness = witnessWorkspaceContainer(dir);
  assert.equal(witness.exists, true);
  assert.equal(witness.git_dir_present, false);
  assert.equal(witness.is_git_repository, false);
  for (const key of ["head", "branch", "refs_digest", "index_digest", "config_digest"]) {
    assert.equal(witness[key], null, `${key} must be null outside a repository`);
  }
});

test("COORD-670: a repository is witnessed with HEAD, branch, refs, index and config", () => {
  const dir = repoWithCommit("coord-witness-repo-");
  const witness = witnessWorkspaceContainer(dir);
  assert.equal(witness.is_git_repository, true);
  assert.equal(witness.git_dir_present, true);
  assert.equal(witness.branch, "main");
  assert.match(witness.head, /^[0-9a-f]{40}$/);
  assert.match(witness.refs_digest, /^[0-9a-f]{64}$/);
  assert.equal(witness.index_present, true);
  assert.equal(witness.config_present, true);
  assert.match(witness.config_digest, /^[0-9a-f]{64}$/);
});

test("COORD-670: the config is DIGESTED, never emitted — a secret in .git/config cannot leak through the witness", () => {
  const dir = repoWithCommit("coord-witness-secret-");
  git(dir, "config", "--local", "http.extraheader", "AUTHORIZATION: basic c3VwZXItc2VjcmV0");
  const witness = witnessWorkspaceContainer(dir);
  const serialized = JSON.stringify(witness);
  assert.equal(serialized.includes("c3VwZXItc2VjcmV0"), false, "witness must not carry config content");
  assert.equal(serialized.includes("extraheader"), false, "witness must not carry config keys");
  assert.match(witness.config_digest, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// The invariant the instrument exists to enforce (ADR-0008)
// ---------------------------------------------------------------------------

test("COORD-670/COORD-631: a SPAWNED `git init` on the container is caught (invisible to any in-process fs hook)", () => {
  const container = tmpDir("coord-witness-init-");
  const before = witnessWorkspaceContainer(container);
  assert.equal(before.is_git_repository, false);

  // A spawned subprocess — exactly the write an in-process barrier cannot see.
  git(container, "init", "-q", "-b", "main");

  const after = witnessWorkspaceContainer(container);
  assert.equal(after.is_git_repository, true);
  const changed = changedWitnessKeys(before, after);
  assert.ok(changed.includes("is_git_repository"), `expected is_git_repository to move, got ${changed.join(", ")}`);
  assert.ok(changed.includes("git_dir_present"));
});

test("COORD-670/COORD-631: a staged-then-RESTORED write is caught by the index digest (a final-state diff would miss it)", () => {
  const dir = repoWithCommit("coord-witness-staged-");
  const before = witnessWorkspaceContainer(dir);

  fs.writeFileSync(path.join(dir, "sneaky.txt"), "staged\n");
  git(dir, "add", "sneaky.txt");
  const during = witnessWorkspaceContainer(dir);
  assert.ok(
    changedWitnessKeys(before, during).includes("index_digest"),
    "staging must move the index digest"
  );

  // Restore: unstage and remove. The FINAL state matches the initial one...
  git(dir, "rm", "-q", "--cached", "sneaky.txt");
  fs.rmSync(path.join(dir, "sneaky.txt"));
  const after = witnessWorkspaceContainer(dir);
  assert.deepEqual(
    changedWitnessKeys(before, after),
    [],
    "after restore the witness agrees the repository is untouched"
  );
  // ...which is precisely why the witness must be sampled DURING, not only after.
});

test("COORD-670: an untracked working-tree file is NOT a container violation (the index is the control, not `git status`)", () => {
  const dir = repoWithCommit("coord-witness-untracked-");
  const before = witnessWorkspaceContainer(dir);
  fs.writeFileSync(path.join(dir, "legitimate-output.txt"), "written by a legitimate operation\n");
  const after = witnessWorkspaceContainer(dir);
  assert.deepEqual(changedWitnessKeys(before, after), [], "untracked files must not register as Git movement");
});

test("COORD-670: a config change in a PRE-EXISTING container repository is caught (ADR-0008 forbids touching it)", () => {
  const dir = repoWithCommit("coord-witness-config-");
  const before = witnessWorkspaceContainer(dir);
  git(dir, "config", "--local", "remote.origin.url", "https://example.invalid/x.git");
  const after = witnessWorkspaceContainer(dir);
  assert.deepEqual(changedWitnessKeys(before, after), ["config_digest"]);
});

test("COORD-670: changedWitnessKeys covers the canonical key list and is empty for identical samples", () => {
  assert.deepEqual(
    CONTAINER_WITNESS_KEYS.slice(),
    [
      "git_dir_present", "is_git_repository", "head", "branch",
      "refs_digest", "index_digest", "index_present", "config_present", "config_digest",
    ],
    "the canonical witness key list is a contract — changing it changes what every caller asserts"
  );
  assert.ok(Object.isFrozen(CONTAINER_WITNESS_KEYS), "the key list must not be mutable by a caller");
  const dir = repoWithCommit("coord-witness-stable-");
  const a = witnessWorkspaceContainer(dir);
  const b = witnessWorkspaceContainer(dir);
  assert.deepEqual(changedWitnessKeys(a, b), [], "two samples of an unchanged repository must agree");
  // A partial sample must not silently pass: every key participates.
  assert.deepEqual(changedWitnessKeys(a, { ...b, head: "0".repeat(40) }), ["head"]);
});
