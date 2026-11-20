"use strict";

// COORD-928: a prompt_index entry may be published only when its prompt file is in
// the commit being published. Each test runs real git in an os.tmpdir() fixture
// repo with a local bare remote (never ROOT, never origin).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  promptIndexCommitGaps,
  assertPromptIndexCommittable,
  formatPromptIndexRefusal,
} = require("./prompt-index-commit.js");
const { gitTry } = require("./git-ops.js");

const { gitFixture } = require("./test-git-fixture.js");

// Workspace = repo root; coord/ sits inside it, as in ROOT.
function makeWorld(t, { commitBase = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-928-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const coord = path.join(repo, "coord");
  fs.mkdirSync(remote);
  fs.mkdirSync(repo);
  gitFixture(remote, ["init", "--bare", "--initial-branch=dev"]);
  gitFixture(repo, ["init", "--initial-branch=dev"]);
  gitFixture(repo, ["remote", "add", "origin", remote]);
  fs.mkdirSync(path.join(coord, "board"), { recursive: true });
  fs.writeFileSync(path.join(coord, "board", "tasks.json"), "{}\n");
  if (commitBase) {
    gitFixture(repo, ["add", "."]);
    gitFixture(repo, ["commit", "-m", "base"]);
    gitFixture(repo, ["push", "--set-upstream", "origin", "dev:dev"]);
  }
  const writePrompt = (ticket, { commit = false } = {}) => {
    const rel = `coord/prompts/tickets/${ticket}.md`;
    fs.mkdirSync(path.join(repo, "coord", "prompts", "tickets"), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), `# ${ticket}\n\n## Acceptance\n\n- specific\n`);
    if (commit) {
      gitFixture(repo, ["add", rel]);
      gitFixture(repo, ["commit", "-m", `prompt ${ticket}`]);
    }
    return rel;
  };
  return { root, remote, repo, coord, writePrompt };
}

// The COORD-887/913 shape: the board lists the prompt, the file is nowhere in the tree.
test("COORD-928: a prompt_index entry whose file is absent from the tree is a gap that names the path", (t) => {
  const world = makeWorld(t);
  const promptIndex = { "COORD-887": "coord/prompts/tickets/COORD-887.md" };
  const gaps = promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex });
  assert.deepEqual(gaps.map((g) => [g.ticket, g.path, g.reason]), [
    ["COORD-887", "coord/prompts/tickets/COORD-887.md", "absent"],
  ]);
  const message = formatPromptIndexRefusal(gaps);
  assert.match(message, /COORD-887 -> coord\/prompts\/tickets\/COORD-887\.md/);
  assert.match(message, /absent/);
  assert.match(message, /commit/i, "the refusal states the remedy");
});

// The COORD-971 shape: created by file-ticket --with-prompt, present on disk, never committed.
test("COORD-928: an untracked prompt file on disk is still a gap, because the commit does not carry it", (t) => {
  const world = makeWorld(t);
  const rel = world.writePrompt("COORD-971");
  const gaps = promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: { "COORD-971": rel } });
  assert.deepEqual(gaps.map((g) => [g.ticket, g.reason]), [["COORD-971", "untracked"]]);
});

test("COORD-928: a prompt file committed at HEAD is not a gap", (t) => {
  const world = makeWorld(t);
  const rel = world.writePrompt("COORD-913", { commit: true });
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: { "COORD-913": rel } }), []);
});

test("COORD-928: a prompt file that is part of the commit being made is not a gap", (t) => {
  const world = makeWorld(t);
  const rel = world.writePrompt("COORD-974");
  const gaps = promptIndexCommitGaps({
    gitTry,
    coordDir: world.coord,
    promptIndex: { "COORD-974": rel },
    stagedPaths: ["../" + rel],
  });
  assert.deepEqual(gaps, []);
});

test("COORD-928: first publication on an unborn branch counts only files in the commit", (t) => {
  const world = makeWorld(t, { commitBase: false });
  const rel = world.writePrompt("COORD-900");
  const index = { "COORD-900": rel };
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: index }).map((g) => g.reason), ["untracked"]);
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: index, stagedPaths: ["../" + rel] }), []);
});

test("COORD-928: an inspection failure refuses; it is never read as an empty HEAD", (t) => {
  const world = makeWorld(t);
  const failingGit = (dir, args, options) => {
    if (args[0] === "ls-tree") return { status: 128, stdout: "", stderr: "fatal: bad object HEAD" };
    return gitTry(dir, args, options);
  };
  assert.throws(
    () => promptIndexCommitGaps({
      gitTry: failingGit,
      coordDir: world.coord,
      promptIndex: { "COORD-913": "coord/prompts/tickets/COORD-913.md" },
    }),
    /could not inspect|inspection/i,
  );
});

test("COORD-1052: Git inspection errors without stderr still explain the failed operation", (t) => {
  const world = makeWorld(t);
  const failure = (dir, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { status: 128, stdout: "", stderr: "" };
    }
    return gitTry(dir, args, options);
  };
  assert.throws(() => promptIndexCommitGaps({ gitTry: failure, coordDir: world.coord,
    promptIndex: { "COORD-1052": "coord/prompts/tickets/COORD-1052.md" } }),
  /rev-parse --show-toplevel failed/);
  const promptIndex = { "COORD-1052": "coord/prompts/tickets/COORD-1052.md" };
  for (const [command, response, message] of [
    ["rev-parse --show-toplevel", { status: 0 }, /empty repository root/],
    ["symbolic-ref -q HEAD", { status: 0 }, /empty branch name/],
    ["rev-parse --verify -q HEAD^{commit}", null, /HEAD .* cannot be resolved/],
    ["ls-tree", null, /git ls-tree HEAD failed/],
  ]) {
    const fault = (dir, args) => args.join(" ") === command || args[0] === command
      ? response : gitTry(dir, args);
    assert.throws(() => promptIndexCommitGaps({ gitTry: fault, coordDir: world.coord, promptIndex }), message);
  }
});

test("COORD-928: assertPromptIndexCommittable names every missing path and the remedy, then fails closed", (t) => {
  const world = makeWorld(t);
  const messages = [];
  const fail = (message) => { messages.push(message); throw new Error(message); };
  assert.throws(
    () => assertPromptIndexCommittable({
      gitTry,
      coordDir: world.coord,
      promptIndex: {
        "COORD-887": "coord/prompts/tickets/COORD-887.md",
        "COORD-913": "coord/prompts/tickets/COORD-913.md",
      },
      fail,
    }),
    /COORD-887.*COORD-913|COORD-913.*COORD-887/s,
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Refusing to publish/);
});

test("COORD-928: no prompt_index means nothing to check", (t) => {
  const world = makeWorld(t);
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: {} }), []);
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: null }), []);
});

void spawnSync;

// Live scenario reported by the orchestrator (2026-11-13): origin/dev's board lists
// COORD-971..974, whose prompt files exist only untracked in ROOT. Publication must
// refuse every one of them, naming each path.
test("COORD-928: the live COORD-971..974 shape (on disk, untracked, listed in prompt_index) is refused by name", (t) => {
  const world = makeWorld(t);
  const index = {};
  for (const ticket of ["COORD-971", "COORD-972", "COORD-973", "COORD-974"]) {
    index[ticket] = world.writePrompt(ticket);
  }
  const gaps = promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: index });
  assert.deepEqual(gaps.map((g) => [g.ticket, g.reason]), [
    ["COORD-971", "untracked"], ["COORD-972", "untracked"], ["COORD-973", "untracked"], ["COORD-974", "untracked"],
  ]);
  const message = formatPromptIndexRefusal(gaps);
  for (const ticket of ["COORD-971", "COORD-972", "COORD-973", "COORD-974"]) {
    assert.match(message, new RegExp(`${ticket} -> coord/prompts/tickets/${ticket}\\.md`));
  }
});

// COORD-1015: git reports the canonical toplevel. A coord/ reached through a symlinked
// parent must still resolve its prompt entries to repo-relative paths that the commit
// carries; otherwise a committed prompt is reported as an untracked gap.
test("COORD-1015: a committed prompt reached through a symlinked parent is not a gap", (t) => {
  const world = makeWorld(t);
  const rel = world.writePrompt("COORD-1015", { commit: true });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "coord-1015-link-"));
  t.after(() => fs.rmSync(linkParent, { recursive: true, force: true }));
  fs.symlinkSync(path.dirname(world.repo), path.join(linkParent, "alias"), "dir");
  const coordViaLink = path.join(linkParent, "alias", "repo", "coord");
  assert.deepEqual(promptIndexCommitGaps({ gitTry, coordDir: coordViaLink, promptIndex: { "COORD-1015": rel } }), []);
});


test("COORD-1052: prompt-index refuses Git identity and HEAD inspection failures, and reports invalid paths", (t) => {
  const world = makeWorld(t);
  const before = gitFixture(world.repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const failures = [
    ["toplevel", (args) => args[0] === "rev-parse" && args[1] === "--show-toplevel"
      ? { status: 128, stdout: "", stderr: "toplevel inspection failed" } : null],
    ["symbolic ref", (args) => args[0] === "symbolic-ref"
      ? { status: 128, stdout: "", stderr: "symbolic-ref inspection failed" } : null],
    ["unresolved HEAD and unverifiable ref", (args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}")
      ? { status: 1, stdout: "", stderr: "HEAD cannot be resolved" }
      : args[0] === "show-ref" ? { status: 128, stdout: "", stderr: "show-ref inspection failed" } : null],
  ];
  for (const [name, failCall] of failures) {
    const brokenGit = (dir, args, options) => failCall(args) || gitTry(dir, args, options);
    assert.throws(() => promptIndexCommitGaps({ gitTry: brokenGit, coordDir: world.coord,
      promptIndex: { "COORD-1052": "coord/prompts/tickets/COORD-1052.md" } }), /could not inspect git state/, name);
  }
  const invalid = promptIndexCommitGaps({ gitTry, coordDir: world.coord, promptIndex: { "COORD-1052": "  " } });
  assert.deepEqual(invalid, [{ ticket: "COORD-1052", path: "  ", gitPath: null, reason: "invalid-path" }]);
  assert.match(formatPromptIndexRefusal(invalid), /COORD-1052 ->\s+\(invalid-path\)/);
  assert.throws(() => assertPromptIndexCommittable({ gitTry, coordDir: world.coord,
    promptIndex: { "COORD-1052": "  " } }), /Refusing to publish/);
  assert.equal(gitFixture(world.repo, ["status", "--porcelain=v1", "--untracked-files=all"]), before,
    "refusal does not stage or otherwise modify the publication checkout");
});
