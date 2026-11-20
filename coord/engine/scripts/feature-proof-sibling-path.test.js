"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveFeatureProofReachability } = require("./feature-proof-resolution.js");

function fixture(t, nested = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proof768-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  fs.mkdirSync(path.join(root, "frontend"));
  const git = (...args) => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, "coord", "engine.js"), "function engineMarker() {}\n");
  fs.writeFileSync(path.join(root, "frontend", "view.js"), "function committedView() {}\n");
  git("add", "-A"); git("commit", "--quiet", "-m", "canonical");
  const canonical = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "feature");
  fs.appendFileSync(path.join(root, "frontend", "view.js"), "function branchView() {}\n");
  git("add", "-A"); git("commit", "--quiet", "-m", "branch proof");
  const branch = git("rev-parse", "HEAD");
  fs.appendFileSync(path.join(root, "frontend", "view.js"), "function dirtyView() {}\n");
  fs.writeFileSync(path.join(temp, "outside.js"), "function outsideMarker() {}\n");
  const repoRoot = nested ? path.join(root, "coord") : root;
  const prefix = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-prefix"], { encoding: "utf8" });
  if (prefix.error) throw prefix.error;
  assert.equal(prefix.status, 0);
  const candidates = [
    { ref: "main", ref_kind: "canonical", repoRoot, pathPrefix: prefix.stdout.trim() },
    { ref: "feature", ref_kind: "branch", repoRoot, pathPrefix: prefix.stdout.trim() },
    { ref: root, ref_kind: "worktree", repoRoot: root, pathPrefix: prefix.stdout.trim() },
  ];
  return { root, temp, canonical, branch, resolve: proof => resolveFeatureProofReachability("COORD-768", proof, { candidates }) };
}

test("COORD-768: real Git resolves nested sibling paths at the correct committed ref", t => {
  const f = fixture(t);
  for (const spelling of ["../frontend/view.js", "./../frontend/view.js", "coord/../frontend/view.js"]) {
    for (const proof of [`path:${spelling}`, `symbol:${spelling}#committedView`]) {
      const r = f.resolve(proof);
      assert.equal(r.resolved, true);
      assert.equal(r.ref_kind, "canonical");
      assert.equal(r.sha, f.canonical);
    }
  }
  const branch = f.resolve("symbol:../frontend/view.js#branchView");
  assert.equal(branch.ref_kind, "branch"); assert.equal(branch.sha, f.branch);
  const dirty = f.resolve("symbol:../frontend/view.js#dirtyView");
  assert.equal(dirty.ref_kind, "worktree"); assert.equal(dirty.sha, null);
  assert.equal(f.resolve("symbol:../frontend/view.js#missingView").resolved, false);
  assert.equal(f.resolve("path:../frontend/missing.js").resolved, false);
});

test("COORD-768: standalone roots retain committed and uncommitted provenance", t => {
  const f = fixture(t, false);
  assert.equal(f.resolve("symbol:frontend/./view.js#committedView").sha, f.canonical);
  assert.equal(f.resolve("symbol:frontend/view.js#branchView").sha, f.branch);
  assert.equal(f.resolve("symbol:frontend/view.js#dirtyView").ref_kind, "worktree");
  const directory = f.resolve("symbol:coord#dirtyView");
  assert.equal(directory.resolved, false, "a directory cannot supply worktree symbol bytes");
  assert.match(directory.attempted.at(-1).reason, /^unreadable path coord$/);
});

test("COORD-768: traversal outside the Git root cannot become worktree evidence", t => {
  for (const nested of [true, false]) {
    const f = fixture(t, nested);
    const outside = `${nested ? "../../" : "../"}outside.js`;
    for (const proof of [`path:${outside}`, `symbol:${outside}#outsideMarker`, `symbol:${path.join(f.temp, "outside.js")}#outsideMarker`]) {
      const r = f.resolve(proof);
      assert.equal(r.resolved, false, proof);
      assert.equal(r.sha, null);
      assert.match(r.reason, /outside|escape|absolute/i);
      assert.ok(r.attempted.every(attempt => /^(proof path escapes|absolute proof paths)/.test(attempt.reason)), "every ref rejects out-of-root paths before Git can reinterpret them");
    }
  }
});

test("COORD-768: worktree symbol reads reject escaping symlinks and permit internal links", t => {
  const f = fixture(t);
  fs.symlinkSync("../../outside.js", path.join(f.root, "coord", "outside-link.js"));
  fs.symlinkSync("../frontend/view.js", path.join(f.root, "coord", "inside-link.js"));
  assert.equal(f.resolve("symbol:outside-link.js#outsideMarker").resolved, false);
  const internal = f.resolve("symbol:inside-link.js#dirtyView");
  assert.equal(internal.resolved, true); assert.equal(internal.ref_kind, "worktree"); assert.equal(internal.sha, null);
});
