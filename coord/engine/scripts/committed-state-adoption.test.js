"use strict";

// COORD-862 (COORD-516a): ADR 0020 committed-state policy, qualification rules.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { planCommittedStateAdoption } = require("./committed-state-adoption.js");

function gitRun(cwd, args) {
  const result = gitFixtureSpawn(cwd, args);
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function git(cwd, ...args) {
  const result = gitRun(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function withRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-adopt-"));
  try {
    gitFixture(root, ["init", "-q", "-b", "dev"]);
    fs.mkdirSync(path.join(root, "coord", "prompts", "tickets"), { recursive: true });
    fs.mkdirSync(path.join(root, "coord", "docs", "decisions"), { recursive: true });
    fs.writeFileSync(path.join(root, "coord", "prompts", "tickets", "T-1.md"), "# T-1\n");
    fs.writeFileSync(path.join(root, "coord", "docs", "decisions", "0001-x.md"), "# ADR 0001\n");
    commit(root, "base");
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const canonical = () => "canonical_integration_tree";
const prompt = (root) => ({ key: "prompts/tickets/T-1.md", absolute: path.join(root, "coord", "prompts", "tickets", "T-1.md") });
const adr = (root) => ({ key: "docs/decisions/0001-x.md", absolute: path.join(root, "coord", "docs", "decisions", "0001-x.md") });
const plan = (root, candidates, extra = {}) => planCommittedStateAdoption({
  candidates, gitRun, integrationBranch: "dev", detectRole: canonical, ...extra,
});

test("COORD-862: committed authored content at an integration HEAD is adopted with its commit", () => {
  withRepo((root) => {
    fs.writeFileSync(prompt(root).absolute, "# T-1 reviewed edit\n");
    fs.writeFileSync(adr(root).absolute, "# ADR 0001 amended\n");
    const sha = commit(root, "reviewed authored edits");
    const result = plan(root, [prompt(root), adr(root)]);
    assert.equal(result.refusal, null);
    assert.equal(result.commit, sha);
    assert.equal(result.integration_branch, "dev");
    assert.deepEqual(result.adopted, ["prompts/tickets/T-1.md", "docs/decisions/0001-x.md"]);
    assert.deepEqual(result.repo_paths, ["coord/prompts/tickets/T-1.md", "coord/docs/decisions/0001-x.md"]);
    assert.deepEqual(result.rejected, []);
  });
});

test("COORD-862: uncommitted, staged, untracked and deleted authored paths are not adopted", () => {
  withRepo((root) => {
    const untracked = { key: "prompts/tickets/T-2.md", absolute: path.join(root, "coord", "prompts", "tickets", "T-2.md") };
    const deleted = { key: "prompts/tickets/T-3.md", absolute: path.join(root, "coord", "prompts", "tickets", "T-3.md") };
    fs.writeFileSync(prompt(root).absolute, "# T-1 unreviewed\n");
    fs.writeFileSync(adr(root).absolute, "# ADR staged\n");
    git(root, "add", adr(root).absolute);
    fs.writeFileSync(untracked.absolute, "# T-2\n");
    const result = plan(root, [prompt(root), adr(root), untracked, deleted, { key: "prompts/none.md", absolute: null }]);
    assert.deepEqual(result.adopted, []);
    assert.deepEqual(Object.fromEntries(result.rejected.map((entry) => [entry.path, entry.reason])), {
      "prompts/tickets/T-1.md": "differs_from_head",
      "docs/decisions/0001-x.md": "differs_from_head",
      "prompts/tickets/T-2.md": "not_committed",
      "prompts/tickets/T-3.md": "deleted",
      "prompts/none.md": "deleted",
    });
    assert.deepEqual(plan(root, [deleted]).rejected, [{ path: "prompts/tickets/T-3.md", reason: "deleted" }]);
    assert.deepEqual(plan(root, []).adopted, []);
  });
});

test("COORD-862: HEAD must be reachable from the local and the published integration branch", () => {
  withRepo((root) => {
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(prompt(root).absolute, "# feature-only\n");
    const featureSha = commit(root, "feature edit");
    let result = plan(root, [prompt(root)]);
    assert.equal(result.refusal.code, "head_not_on_integration_branch");
    assert.equal(result.commit, featureSha);
    assert.deepEqual(result.adopted, []);
    assert.equal(plan(root, [prompt(root)], { integrationBranch: "missing" }).refusal.code, "head_not_on_integration_branch");

    git(root, "checkout", "-q", "dev");
    git(root, "merge", "-q", "--ff-only", "feature");
    git(root, "update-ref", "refs/remotes/origin/dev", base);
    result = plan(root, [prompt(root)]);
    assert.equal(result.refusal.code, "head_not_published");
    git(root, "update-ref", "refs/remotes/origin/dev", featureSha);
    assert.deepEqual(plan(root, [prompt(root)]).adopted, ["prompts/tickets/T-1.md"]);
  });
});

test("COORD-862: adoption runs only in the canonical integration tree", () => {
  withRepo((root) => {
    const roles = [];
    const result = plan(root, [prompt(root)], { detectRole: (rootDir) => { roles.push(rootDir); return "ephemeral_worktree"; } });
    assert.equal(result.refusal.code, "non_canonical_tree");
    assert.match(result.refusal.message, /ephemeral_worktree/);
    assert.equal(fs.realpathSync(roles[0]), fs.realpathSync(root));
    assert.equal(plan(root, [prompt(root)], { detectRole: null }).refusal.code, "non_canonical_tree");
  });
});

test("COORD-862: missing prerequisites refuse every candidate", () => {
  withRepo((root) => {
    assert.equal(plan(root, [prompt(root)], { gitRun: null }).refusal.code, "git_unavailable");
    assert.equal(plan(root, [prompt(root)], { integrationBranch: " " }).refusal.code, "integration_branch_unknown");
    assert.equal(plan(root, [prompt(root)], { integrationBranch: undefined }).refusal.code, "integration_branch_unknown");
    const noTop = (cwd, args) => (args.includes("--show-toplevel") ? { status: 128, stdout: "" } : gitRun(cwd, args));
    assert.equal(plan(root, [prompt(root)], { gitRun: noTop }).refusal.code, "not_a_git_checkout");
    // A candidate outside the checkout that holds the first candidate is refused.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-elsewhere-"));
    try {
      fs.writeFileSync(path.join(elsewhere, "p.md"), "x\n");
      const mixed = plan(root, [prompt(root), { key: "prompts/p.md", absolute: path.join(elsewhere, "p.md") }]);
      assert.deepEqual(mixed.rejected, [{ path: "prompts/p.md", reason: "outside_repository" }]);
      assert.deepEqual(mixed.adopted, ["prompts/tickets/T-1.md"]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-nogit-"));
    try {
      fs.writeFileSync(path.join(outside, "p.md"), "x\n");
      const result = plan(root, [{ key: "prompts/p.md", absolute: path.join(outside, "p.md") }]);
      // A temp directory may itself sit inside some repository; either way it is refused.
      assert.ok(["not_a_git_checkout", "non_canonical_tree", "head_unavailable", "head_not_on_integration_branch"].includes(result.refusal?.code) ||
        result.rejected.some((entry) => entry.reason === "outside_repository" || entry.reason === "not_committed"));
      assert.deepEqual(result.adopted, []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    const failing = (cwd, args) => (args[0] === "--literal-pathspecs" ? { status: 1, stdout: "" } : gitRun(cwd, args));
    assert.equal(plan(root, [prompt(root)], { gitRun: failing }).refusal.code, "git_query_failed");
    const failingStatus = (cwd, args) => (args.includes("status") ? { status: 1, stdout: "" } : gitRun(cwd, args));
    assert.equal(plan(root, [prompt(root)], { gitRun: failingStatus }).refusal.code, "git_query_failed");
    const noHead = (cwd, args) => (args[0] === "rev-parse" && args[2] === "HEAD^{commit}" ? { status: 128, stdout: "" } : gitRun(cwd, args));
    assert.equal(plan(root, [prompt(root)], { gitRun: noHead }).refusal.code, "head_unavailable");
  });
});

test("COORD-862: a renamed authored path counts as differing from HEAD", () => {
  withRepo((root) => {
    const moved = { key: "prompts/tickets/T-9.md", absolute: path.join(root, "coord", "prompts", "tickets", "T-9.md") };
    git(root, "mv", prompt(root).absolute, moved.absolute);
    const result = plan(root, [moved]);
    assert.deepEqual(result.adopted, []);
    assert.equal(result.rejected[0].reason, "not_committed");
    fs.writeFileSync(path.join(root, "coord", "prompts", "tickets", "T-1.md"), "# T-1\n");
    // With both sides of the staged rename in the pathspec, status reports the
    // rename record and its source; neither path is adopted.
    const both = plan(root, [prompt(root), moved]);
    assert.deepEqual(both.adopted, []);
    assert.deepEqual(both.rejected.map((entry) => entry.reason).sort(), ["differs_from_head", "not_committed"]);
  });
});

test("COORD-862 review B1: assume-unchanged and skip-worktree edits are refused by blob comparison", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    withRepo((root) => {
      git(root, "update-index", flag, "coord/prompts/tickets/T-1.md");
      fs.writeFileSync(prompt(root).absolute, `# T-1 hidden edit (${flag})\n`);
      assert.equal(git(root, "status", "--porcelain"), "", `${flag} hides the edit from git status`);
      const result = plan(root, [prompt(root)]);
      assert.deepEqual(result.adopted, [], flag);
      assert.deepEqual(result.rejected, [{ path: "prompts/tickets/T-1.md", reason: "bytes_differ_from_head" }], flag);
    });
  }
});

test("COORD-862: adopted paths report the caller's digest of the verified bytes", () => {
  withRepo((root) => {
    const result = plan(root, [prompt(root)], { contentDigest: (bytes) => `len:${bytes.length}` });
    assert.deepEqual(result.adopted, ["prompts/tickets/T-1.md"]);
    assert.deepEqual(result.digests, { "prompts/tickets/T-1.md": "len:6" });
    assert.deepEqual(plan(root, [prompt(root)]).digests, { "prompts/tickets/T-1.md": null });
    // A sha256 object format is honored when Git reports it.
    const sha256 = (cwd, args) => (args.includes("--show-object-format") ? { status: 0, stdout: "sha256\n" } : gitRun(cwd, args));
    assert.equal(plan(root, [prompt(root)], { gitRun: sha256 }).rejected[0].reason, "bytes_differ_from_head");
  });
});

test("COORD-862 review B2: a real linked worktree is refused even when its role claims canonical", () => {
  withRepo((root) => {
    const linked = `${root}-linked`;
    try {
      git(root, "worktree", "add", "-q", "--detach", linked);
      const candidate = { key: "prompts/tickets/T-1.md", absolute: path.join(linked, "coord", "prompts", "tickets", "T-1.md") };
      const result = plan(root, [candidate], { detectRole: () => "canonical_integration_tree" });
      assert.equal(result.refusal.code, "linked_checkout");
      assert.deepEqual(result.adopted, []);
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });
});

test("COORD-862 review: a symlinked authored path is refused before it is resolved", (t) => {
  withRepo((root) => {
    const link = { key: "prompts/tickets/L.md", absolute: path.join(root, "coord", "prompts", "tickets", "L.md") };
    try {
      fs.symlinkSync(prompt(root).absolute, link.absolute);
    } catch (error) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    commit(root, "track a symlink");
    const result = plan(root, [link]);
    assert.deepEqual(result.rejected, [{ path: "prompts/tickets/L.md", reason: "not_a_regular_file" }]);
  });
});

test("COORD-862: a top level without a .git entry is refused as a linked checkout", () => {
  withRepo((root) => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-nogitdir-"));
    try {
      const fakeTop = (cwd, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${bare}\n` } : gitRun(cwd, args));
      assert.equal(plan(root, [prompt(root)], { gitRun: fakeTop }).refusal.code, "linked_checkout");
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
