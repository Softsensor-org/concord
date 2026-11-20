// COORD-923: reproduce the lock-head wedge in a disposable governed fixture (os.tmpdir()),
// pin the observed refusal scope, and check that recovery guidance does not present a
// lock re-pointed to a moved worktree HEAD as submittable.
require("./test-runner.js").scrubIdentityEnv();
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createIsolatedGovernanceWorkspace } = require("./fixtures/isolated-governance-workspace.js");

const TICKET_A = "DEBT-9231";
const TICKET_B = "DEBT-9232";
const THREAD_A = "thread-923-owner-a";
const THREAD_B = "thread-923-owner-b";

function setup() {
  const ws = createIsolatedGovernanceWorkspace({ prefix: "coord923-lock-head-" });
  const gov = (thread, args) => {
    const env = { ...process.env, CODEX_THREAD_ID: thread };
    delete env.COORD_SESSION_ID;
    const result = spawnSync(process.execPath, [path.join(ws.coord, "scripts/governance.js"), ...args], { cwd: ws.root, env, encoding: "utf8" });
    return { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
  };
  const ok = (thread, args) => {
    const result = gov(thread, args);
    assert.equal(result.status, 0, `gov ${args.join(" ")} failed: ${result.out}`);
    return result.out;
  };
  const git = (...args) => spawnSync("git", ["-C", ws.root, ...args], { encoding: "utf8" });
  const fileTicket = (thread, id) => {
    ok(thread, ["file-ticket", id, "--repo", "X", "--type", "chore", "--pri", "P2", "--description", `COORD-923 fixture ${id}`, "--with-prompt"]);
    const body = path.join(ws.root, `${id}-body.md`);
    fs.writeFileSync(body, `# ${id}: fixture\n\n## Acceptance Criteria\n\n- ${id} completes its fixture lane.\n`);
    ok(thread, ["register-prompt", id, "--body-file", body]);
  };
  const readLock = (id) => JSON.parse(fs.readFileSync(path.join(ws.coord, ".runtime", "locks", `${id}.lock`), "utf8"));
  const bindOwner = (thread, handle) => ok(thread, ["agentid", "--owner", handle]);
  return { ws, gov, ok, git, fileTicket, readLock, bindOwner, cleanup: () => ws.cleanup() };
}

// Two Repo X tickets, one owner each, both doing; then A's worktree HEAD moves out of band.
function wedgedFixture() {
  const f = setup();
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
  const moved = spawnSync("git", ["-C", lockA.worktree, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "out-of-band"], { encoding: "utf8" });
  assert.equal(moved.status, 0, moved.stderr);
  const newHead = spawnSync("git", ["-C", lockA.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(newHead, lockA.head);
  f.commitFixture = () => {
    f.git("add", "-A");
    const committed = f.git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-m", "fixture state");
    assert.equal(committed.status, 0, committed.stderr);
  };
  return { ...f, ownerA, ownerB, lockA, newHead, threadB: THREAD_B, threadA: THREAD_A };
}

// COORD-978 supersedes (human-admin decision 2026-11-13: scoped sync warning). The sync
// assertions below encode the new spec; every other assertion of the COORD-923 reproduction is kept.
test("COORD-923 reproduction: a lock-head mismatch on one ticket is a scoped sync warning and blocks nothing else", () => {
  const f = wedgedFixture();
  try {
    f.commitFixture();
    // The mismatched ticket's own mutations still refuse until repaired.
    f.bindOwner(f.threadA, f.ownerA);
    f.gov(f.threadA, ["resume", TICKET_A]);
    const own = f.gov(f.threadA, ["block", TICKET_A, "--reason", "COORD-978 own-mutation probe"]);
    assert.notEqual(own.status, 0, "A's own mutations must refuse while its lock head mismatches");
    assert.match(own.out, /lock head .+ does not match worktree HEAD/);
    f.ok(f.threadA, ["agent-release", f.ownerA, "--reason", "COORD-978 probe hand-off to owner B"]);
    // Board-wide sync: exits 0; the warning names the mismatched ticket and the repair verb.
    f.bindOwner(f.threadB, f.ownerB);
    const sync = f.gov(f.threadB, ["sync"]);
    assert.equal(sync.status, 0, sync.out);
    assert.match(sync.out, /DEBT-9231/);
    assert.match(sync.out, /repair-lock-head DEBT-9231/);
    // Ticket-scoped mutations of the unrelated ticket B are not refused by A's mismatch.
    f.ok(f.threadB, ["resume", TICKET_B]);
    f.ok(f.threadB, ["heartbeat", TICKET_B]);
    f.ok(f.threadB, ["block", TICKET_B, "--reason", "fixture scope probe"]);
    f.fileTicket(f.threadB, "DEBT-9233");
    assert.equal(f.readLock(TICKET_A).head, f.lockA.head, "the mismatch is not silently repaired by unrelated mutations");
  } finally {
    f.cleanup();
  }
});

test("COORD-923: recover does not present a re-pointed lock head as submittable guidance", () => {
  const f = wedgedFixture();
  try {
    f.bindOwner(f.threadA, f.ownerA);
    const recover = f.gov(f.threadA, ["recover", TICKET_A]);
    assert.equal(recover.status, 0, recover.out);
    const payload = JSON.parse(recover.out.slice(recover.out.indexOf("{")));
    assert.ok(
      payload.repairs.some((repair) => repair.type === "refreshed_lock_head" && repair.head === f.newHead),
      "recover still reports the head it re-pointed the lock to",
    );
    // Guidance must not steer the owner to submit a workspace whose HEAD recover never verified.
    assert.equal(
      payload.next_commands.some((command) => /\bgov submit\b/.test(command)),
      false,
      `next_commands must not recommend submit after a moved lock head: ${JSON.stringify(payload.next_commands)}`,
    );
    assert.equal(payload.lock_head_repointed.verified, false, "the re-pointed head is named as unverified");
    assert.equal(payload.lock_head_repointed.to, f.newHead);
    assert.equal(payload.lock_head_repointed.from, f.lockA.head);
    assert.match(payload.lock_head_repointed.guidance, /Do not submit/);
  } finally {
    f.cleanup();
  }
});

// COORD-978: scoped sync warnings and repair-verb guidance, on the shared lock-head wedge
// fixture (engine/scripts/fixtures/lock-head-wedge.js). COORD-923 tests above stay as landed.
const W978 = require("./fixtures/lock-head-wedge.js");
const { TICKET_A: T978A, TICKET_B: T978B, THREAD_A: H978A, THREAD_B: H978B } = W978;

test("COORD-978: a lock-head mismatch on ticket A is a scoped warning in sync and does not block ticket B", () => {
  const f = W978.wedgedFixture("coord978-sync-");
  try {
    f.commitFixture();
    f.bindOwner(H978B, f.ownerB);
    const sync = f.gov(H978B, ["sync"]);
    assert.equal(sync.status, 0, `sync must not be blocked board-wide by ${T978A}: ${sync.out}`);
    assert.match(sync.out, /DEBT-9231/, "the scoped warning names the mismatched ticket");
    assert.match(sync.out, /repair-lock-head DEBT-9231/, "the scoped warning names the repair verb");
    // Ticket B's own work proceeds past A's mismatch.
    f.ok(H978B, ["resume", T978B]);
    f.ok(H978B, ["heartbeat", T978B]);
  } finally {
    f.cleanup();
  }
});

test("COORD-978: the mismatched ticket's own mutations still refuse until its lock head is repaired", () => {
  const f = W978.wedgedFixture("coord978-own-");
  try {
    f.commitFixture();
    f.bindOwner(H978A, f.ownerA);
    f.gov(H978A, ["resume", T978A]);
    const block = f.gov(H978A, ["block", T978A, "--reason", "COORD-978 scope probe"]);
    assert.notEqual(block.status, 0, "A's own mutations must refuse while its lock head mismatches");
    assert.match(block.out, /lock head .+ does not match worktree HEAD/);
    assert.equal(f.readLock(T978A).head, f.lockA.head, "the mismatch is not silently repaired");
  } finally {
    f.cleanup();
  }
});

test("COORD-978: recover guidance for a re-pointed lock head names the repair verb and not submit", () => {
  const f = W978.wedgedFixture("coord978-guidance-");
  try {
    f.bindOwner(H978A, f.ownerA);
    const recover = f.gov(H978A, ["recover", T978A]);
    assert.equal(recover.status, 0, recover.out);
    const payload = JSON.parse(recover.out.slice(recover.out.indexOf("{")));
    assert.equal(payload.next_commands.some((command) => /\bgov submit\b/.test(command)), false);
    assert.ok(
      payload.next_commands.some((command) => /repair-lock-head DEBT-9231/.test(command)),
      `next_commands must name the repair verb: ${JSON.stringify(payload.next_commands)}`,
    );
    assert.match(payload.lock_head_repointed.guidance, /repair-lock-head DEBT-9231/);
  } finally {
    f.cleanup();
  }
});
