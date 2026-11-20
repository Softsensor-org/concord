"use strict";

// COORD-978: shared disposable governed fixture for the lock-head wedge. Reuses the
// COORD-923 reproduction: two Repo X tickets, one owner each, both doing; ticket A's
// worktree HEAD then moves out of band, so A's lock head no longer matches HEAD.
// Everything runs in os.tmpdir(); nothing touches the canonical checkout.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { createIsolatedGovernanceWorkspace } = require("./isolated-governance-workspace.js");
const { gitFixtureSpawn } = require("../test-git-fixture.js");

const TICKET_A = "DEBT-9231";
const TICKET_B = "DEBT-9232";
const THREAD_A = "thread-978-owner-a";
const THREAD_B = "thread-978-owner-b";

function setup(prefix = "coord978-lock-head-") {
  const ws = createIsolatedGovernanceWorkspace({ prefix });
  const gov = (thread, args, extraEnv = {}) => {
    const env = { ...process.env, CODEX_THREAD_ID: thread, ...extraEnv };
    delete env.COORD_SESSION_ID;
    const result = spawnSync(process.execPath, [path.join(ws.coord, "scripts/governance.js"), ...args], { cwd: ws.root, env, encoding: "utf8" });
    return { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
  };
  const ok = (thread, args) => {
    const result = gov(thread, args);
    assert.equal(result.status, 0, `gov ${args.join(" ")} failed: ${result.out}`);
    return result.out;
  };
  const git = (...args) => gitFixtureSpawn(ws.root, args);
  const fileTicket = (thread, id) => {
    ok(thread, ["file-ticket", id, "--repo", "X", "--type", "chore", "--pri", "P2", "--description", `COORD-978 fixture ${id}`, "--with-prompt"]);
    const body = path.join(ws.root, `${id}-body.md`);
    fs.writeFileSync(body, `# ${id}: fixture\n\n## Acceptance Criteria\n\n- ${id} completes its fixture lane.\n`);
    ok(thread, ["register-prompt", id, "--body-file", body]);
  };
  const lockPath = (id) => path.join(ws.coord, ".runtime", "locks", `${id}.lock`);
  const readLock = (id) => JSON.parse(fs.readFileSync(lockPath(id), "utf8"));
  const bindOwner = (thread, handle) => ok(thread, ["agentid", "--owner", handle]);
  const commitFixture = () => {
    git("add", "-A");
    const committed = git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-m", "fixture state");
    assert.equal(committed.status, 0, committed.stderr);
  };
  const journalPath = path.join(ws.coord, ".runtime", "governance-events.ndjson");
  const journalEvents = (command) => fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.command === command)
    : [];
  return { ws, gov, ok, git, fileTicket, lockPath, readLock, bindOwner, commitFixture, journalPath, journalEvents, cleanup: () => ws.cleanup() };
}

// Two Repo X tickets, one owner each, both doing; then A's worktree HEAD moves out of band.
function wedgedFixture(prefix) {
  const f = setup(prefix);
  f.ok(THREAD_A, ["agentid", "--assign"]);
  const ownerA = JSON.parse(f.ok(THREAD_A, ["agentid"]).replace(/^[^{]*/, "")).handle;
  f.fileTicket(THREAD_A, TICKET_A);
  f.ok(THREAD_A, ["start", TICKET_A, "--base", "dev"]);
  f.ok(THREAD_A, ["agent-release", ownerA, "--reason", "fixture hand-off to owner B"]);
  f.ok(THREAD_B, ["agentid", "--assign"]);
  const ownerB = JSON.parse(f.ok(THREAD_B, ["agentid"]).replace(/^[^{]*/, "")).handle;
  f.fileTicket(THREAD_B, TICKET_B);
  f.ok(THREAD_B, ["start", TICKET_B, "--base", "dev"]);
  f.ok(THREAD_B, ["agent-release", ownerB, "--reason", "fixture hand-off"]);
  const lockA = f.readLock(TICKET_A);
  // Out-of-band HEAD move: the ticket's worktree advances without a governed commit.
  const moved = gitFixtureSpawn(lockA.worktree, ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "out-of-band"]);
  assert.equal(moved.status, 0, moved.stderr);
  const newHead = gitFixtureSpawn(lockA.worktree, ["rev-parse", "HEAD"]).stdout.trim();
  assert.notEqual(newHead, lockA.head);
  return { ...f, ownerA, ownerB, lockA, newHead, threadA: THREAD_A, threadB: THREAD_B, ticketA: TICKET_A, ticketB: TICKET_B };
}

// A commit with no ancestry: it cannot contain the ticket's recorded lock head.
function orphanCommit(worktree) {
  const emptyTree = gitFixtureSpawn(worktree, ["mktree"], { input: "" });
  assert.equal(emptyTree.status, 0, emptyTree.stderr);
  const made = gitFixtureSpawn(worktree, ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit-tree", emptyTree.stdout.trim(), "-m", "unrelated"]);
  assert.equal(made.status, 0, made.stderr);
  return made.stdout.trim();
}

module.exports = { TICKET_A, TICKET_B, THREAD_A, THREAD_B, setup, wedgedFixture, orphanCommit };
