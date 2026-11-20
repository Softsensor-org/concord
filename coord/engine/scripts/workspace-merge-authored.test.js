"use strict";

// COORD-928 option (a) (human-admin 2026-11-13): the workspace merge removes an untracked
// overlapping file ONLY when it is an ADR 0020 authored class and its bytes equal the
// incoming blob, then merges. Anything else still refuses. Real git, os.tmpdir() fixtures.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  identicalUntrackedAuthoredOverlaps,
  removeIdenticalAuthoredOverlaps,
  restoreRemovedAuthoredOverlaps,
} = require("./workspace-merge-authored.js");
const { gitTry } = require("./git-ops.js");

const { gitFixture } = require("./test-git-fixture.js");

// dev is the integration branch in the canonical checkout; agent/x is a ticket branch
// that adds prompt and board files the canonical checkout does not have committed.
function makeMergeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-928-merge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  gitFixture(repo, ["init", "--initial-branch=dev"]);
  fs.mkdirSync(path.join(repo, "coord", "board"), { recursive: true });
  fs.writeFileSync(path.join(repo, "coord", "board", "tasks.json"), "{}\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-m", "base"]);
  gitFixture(repo, ["checkout", "-b", "agent/x"]);
  const incoming = {
    "coord/prompts/tickets/COORD-974.md": "# COORD-974\n\n## Acceptance\n\n- specific\n",
    "coord/docs/decisions/0099-test.md": "# ADR 0099\n",
    "coord/board/extra.json": "{\"x\":1}\n",
    "coord/prompts/tickets/COORD-975.md": "# COORD-975 incoming\n",
  };
  for (const [rel, body] of Object.entries(incoming)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-m", "ticket branch adds governed files"]);
  gitFixture(repo, ["checkout", "dev"]);
  const writeDev = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  return { repo, incoming, writeDev };
}

test("COORD-928(a): an untracked ADR 0020 file byte-identical to the incoming blob is removable", (t) => {
  const world = makeMergeWorld(t);
  world.writeDev("coord/prompts/tickets/COORD-974.md", world.incoming["coord/prompts/tickets/COORD-974.md"]);
  const overlap = ["coord/prompts/tickets/COORD-974.md"];
  const result = identicalUntrackedAuthoredOverlaps({ gitTry, repoRoot: world.repo, branch: "agent/x", overlap });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.removable.map((r) => r.path), overlap);
});

test("COORD-928(a): an untracked authored file whose bytes differ from the incoming blob is refused", (t) => {
  const world = makeMergeWorld(t);
  world.writeDev("coord/prompts/tickets/COORD-975.md", "# COORD-975 local, not the same bytes\n");
  const result = identicalUntrackedAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", overlap: ["coord/prompts/tickets/COORD-975.md"],
  });
  assert.deepEqual(result.removable, []);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /not byte-identical/);
});

test("COORD-928(a): an identical untracked file outside the ADR 0020 classes is refused", (t) => {
  const world = makeMergeWorld(t);
  world.writeDev("coord/board/extra.json", world.incoming["coord/board/extra.json"]);
  const result = identicalUntrackedAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", overlap: ["coord/board/extra.json"],
  });
  assert.deepEqual(result.removable, []);
  assert.match(result.refused[0].reason, /not an ADR 0020 authored class/);
});

test("COORD-928(a): a tracked, modified authored file is refused, never removed", (t) => {
  const world = makeMergeWorld(t);
  fs.mkdirSync(path.join(world.repo, "coord", "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(world.repo, "coord", "docs", "decisions", "0001.md"), "# ADR 1\n");
  gitFixture(world.repo, ["add", "."]);
  gitFixture(world.repo, ["commit", "-m", "adr 1"]);
  fs.writeFileSync(path.join(world.repo, "coord", "docs", "decisions", "0099-test.md"), world.incoming["coord/docs/decisions/0099-test.md"]);
  gitFixture(world.repo, ["add", "coord/docs/decisions/0099-test.md"]);
  gitFixture(world.repo, ["commit", "-m", "tracked on dev"]);
  fs.writeFileSync(path.join(world.repo, "coord", "docs", "decisions", "0099-test.md"), "# edited locally\n");
  const result = identicalUntrackedAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", overlap: ["coord/docs/decisions/0099-test.md"],
  });
  assert.deepEqual(result.removable, []);
  assert.match(result.refused[0].reason, /tracked or modified/);
});

test("COORD-928(a): removal records a journal effect and the merge then lands the identical bytes", (t) => {
  const world = makeMergeWorld(t);
  const rel = "coord/prompts/tickets/COORD-974.md";
  world.writeDev(rel, world.incoming[rel]);
  const recorded = [];
  const result = removeIdenticalAuthoredOverlaps({
    gitTry,
    repoRoot: world.repo,
    branch: "agent/x",
    overlap: [rel],
    recordExternalSideEffect: (effect) => recorded.push(effect),
    ticketId: "COORD-928",
  });
  assert.deepEqual(result.removed, [rel]);
  assert.equal(fs.existsSync(path.join(world.repo, rel)), false, "the duplicate is removed before the merge");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "authored_untracked_identical_removed");
  assert.equal(recorded[0].path, rel);
  assert.ok(recorded[0].blob && recorded[0].blob.length >= 40, "the journal records the blob the bytes equal");
  gitFixture(world.repo, ["merge", "--no-ff", "--no-edit", "agent/x"]);
  assert.equal(fs.readFileSync(path.join(world.repo, rel), "utf8"), world.incoming[rel]);
});

test("COORD-928(a): when any overlap is refused, nothing is removed", (t) => {
  const world = makeMergeWorld(t);
  const same = "coord/prompts/tickets/COORD-974.md";
  const differs = "coord/prompts/tickets/COORD-975.md";
  world.writeDev(same, world.incoming[same]);
  world.writeDev(differs, "# not identical\n");
  const result = removeIdenticalAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", overlap: [same, differs],
    recordExternalSideEffect: () => {}, ticketId: "COORD-928",
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(path.join(world.repo, same)), true, "the identical file is kept too (all-or-nothing)");
  assert.equal(result.refused.length, 1);
});

// Abort path (orchestrator, 2026-11-13): a merge that aborts after the verified duplicates
// were removed must restore each one from its known incoming blob, journal the restoration,
// and leave the working tree exactly as it was before the removal.
test("COORD-928(a) abort: a merge that aborts after removal restores the duplicates byte-for-byte and the tree is unchanged", (t) => {
  const world = makeMergeWorld(t);
  const rel = "coord/prompts/tickets/COORD-974.md";
  // Force a merge conflict: both sides change coord/board/tasks.json.
  gitFixture(world.repo, ["checkout", "agent/x"]);
  fs.writeFileSync(path.join(world.repo, "coord", "board", "tasks.json"), "{\"ticket\":\"branch\"}\n");
  gitFixture(world.repo, ["commit", "-am", "branch changes board"]);
  gitFixture(world.repo, ["checkout", "dev"]);
  fs.writeFileSync(path.join(world.repo, "coord", "board", "tasks.json"), "{\"ticket\":\"dev\"}\n");
  gitFixture(world.repo, ["commit", "-am", "dev changes board"]);
  world.writeDev(rel, world.incoming[rel]);

  const before = { status: gitFixture(world.repo, ["status", "--porcelain", "--untracked-files=all"]), bytes: fs.readFileSync(path.join(world.repo, rel)) };
  const recorded = [];
  const removal = removeIdenticalAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", overlap: [rel],
    recordExternalSideEffect: (effect) => recorded.push(effect), ticketId: "COORD-928",
  });
  assert.deepEqual(removal.removed, [rel]);
  assert.equal(fs.existsSync(path.join(world.repo, rel)), false);

  const merge = gitTry(world.repo, ["merge", "--no-ff", "--no-edit", "agent/x"]);
  assert.notEqual(merge.status, 0, "the merge conflicts");
  gitTry(world.repo, ["merge", "--abort"]);

  const restored = restoreRemovedAuthoredOverlaps({
    gitTry, repoRoot: world.repo, branch: "agent/x", removedEntries: removal.removedEntries,
    recordExternalSideEffect: (effect) => recorded.push(effect), ticketId: "COORD-928",
  });
  assert.deepEqual(restored.restored, [rel]);
  assert.deepEqual(fs.readFileSync(path.join(world.repo, rel)), before.bytes, "bytes restored exactly");
  assert.equal(gitFixture(world.repo, ["status", "--porcelain", "--untracked-files=all"]), before.status, "working tree status is exactly as before the removal");
  assert.equal(recorded.filter((e) => e.type === "authored_untracked_identical_restored").length, 1, "the restoration is journaled");
});

test("COORD-1052: unreadable overlap evidence preserves all authored files and records no removal", (t) => {
  const world = makeMergeWorld(t);
  const overlap = ["coord/prompts/tickets/COORD-974.md", "coord/docs/decisions/0099-test.md"];
  for (const rel of overlap) world.writeDev(rel, world.incoming[rel]);
  const before = overlap.map((rel) => fs.readFileSync(path.join(world.repo, rel)));
  for (const command of ["status", "hash-object", "rev-parse"]) {
    for (const unavailable of [null, { status: 128, stderr: "fixture read failure" }, { status: 0 }]) {
      const recorded = [];
      const read = (cwd, args) => {
        const target = args.at(-1);
        if (args[0] === command && (target === overlap[1] || target === `agent/x:${overlap[1]}`)) return unavailable;
        return gitTry(cwd, args);
      };
      const result = removeIdenticalAuthoredOverlaps({ gitTry: read, repoRoot: world.repo,
        branch: "agent/x", overlap, recordExternalSideEffect: (effect) => recorded.push(effect) });
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.removedEntries, []);
      assert.equal(result.refused.length, 1);
      assert.equal(result.refused[0].path, overlap[1]);
      const readError = command === "status" ? /could not read the working-tree state/ : /could not compare with the incoming blob/;
      const emptyResponse = command === "status" ? /tracked or modified/ : /not byte-identical/;
      assert.match(result.refused[0].reason, unavailable?.status === 0 ? emptyResponse : readError);
      assert.deepEqual(recorded, []);
      for (let i = 0; i < overlap.length; i++) assert.deepEqual(fs.readFileSync(path.join(world.repo, overlap[i])), before[i]);
    }
  }
});

test("COORD-1052: unresolved repository root refuses before authored file mutation", (t) => {
  const world = makeMergeWorld(t);
  const rel = "coord/prompts/tickets/COORD-974.md";
  world.writeDev(rel, world.incoming[rel]);
  for (const result of [null, { status: 128, stderr: "fixture root unavailable" }]) {
    const recorded = [];
    assert.throws(() => removeIdenticalAuthoredOverlaps({ gitTry: () => result, repoRoot: world.repo,
      branch: "agent/x", overlap: [rel], recordExternalSideEffect: (effect) => recorded.push(effect) }), /could not resolve the repository top level/);
    assert.equal(fs.readFileSync(path.join(world.repo, rel), "utf8"), world.incoming[rel]);
    assert.deepEqual(recorded, []);
  }
});

test("COORD-1052: abort restoration never overwrites newer content and refuses missing blobs without a false receipt", (t) => {
  const world = makeMergeWorld(t);
  const rel = "coord/prompts/tickets/COORD-974.md";
  const recorded = [];
  const options = { gitTry, repoRoot: world.repo, branch: "agent/x", ticketId: "COORD-1052",
    removedEntries: [{ path: rel, blob: "0".repeat(40) }], recordExternalSideEffect: (effect) => recorded.push(effect) };
  world.writeDev(rel, "newer authored work\n");
  assert.deepEqual(restoreRemovedAuthoredOverlaps(options), { restored: [] });
  assert.equal(fs.readFileSync(path.join(world.repo, rel), "utf8"), "newer authored work\n");
  assert.deepEqual(recorded, []);
  fs.unlinkSync(path.join(world.repo, rel));
  assert.throws(() => restoreRemovedAuthoredOverlaps(options), /could not restore.*from 000000/);
  assert.equal(fs.existsSync(path.join(world.repo, rel)), false, "failed read must not fabricate an empty restored file");
  assert.deepEqual(recorded, [], "failed restoration must not report success");
});

test("authored overlap handling treats omitted entries as empty and refuses paths outside coord", (t) => {
  const world = makeMergeWorld(t);
  const args = { gitTry, repoRoot: world.repo, branch: "agent/x" };
  assert.deepEqual(identicalUntrackedAuthoredOverlaps(args), { removable: [], refused: [] });
  assert.deepEqual(identicalUntrackedAuthoredOverlaps({
    ...args, gitTry: () => ({ status: 0 }),
  }), { removable: [], refused: [] }, "an empty probe cannot authorize any removals");
  assert.deepEqual(restoreRemovedAuthoredOverlaps(args), { restored: [] });
  const outcome = identicalUntrackedAuthoredOverlaps({ ...args, overlap: ["other/prompts/ticket.md"] });
  assert.deepEqual(outcome.removable, []);
  assert.match(outcome.refused[0].reason, /not an ADR 0020 authored class/);
  t.mock.method(require("node:child_process"), "spawnSync", () => ({ status: null }));
  assert.throws(() => restoreRemovedAuthoredOverlaps({
    ...args, removedEntries: [{ path: "coord/prompts/missing.md", blob: "a".repeat(40) }],
  }), /could not restore coord\/prompts\/missing.md/);
});
