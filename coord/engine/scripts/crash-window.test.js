"use strict";

// COORD-950: real-process kill tests. Every crash here is a real SIGKILL sent by
// this parent to a real child process (crash-window-child.js) that is blocked at
// a named crash point inside the production journal / side-effect code. The
// recovery and retry steps run in fresh child processes against the on-disk
// state the killed child left behind. Nothing is simulated by hand-built restore
// points, hand-seeded effects, or invented pids.

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { spawnKillable, signalGroup, killGroup, isAlive, waitUntil } = require("./__fixtures__/process-group-kill.js"); // COORD-1005

const CHILD = path.join(__dirname, "__fixtures__", "crash-window-child.js");
const SIDE_EFFECTS_SRC = path.join(__dirname, "governance-side-effects.js");
const JOURNAL_SRC = path.join(__dirname, "journal.js");
const TICKET = "COORD-950";
const IDEMPOTENCY_KEY = "coord-950-crash-probe";

// Every kill point, the file it lives in, and the window it opens. Each one is
// located by a `// kill-point:<id>` marker comment on the line directly above its
// crashPoint("<id>", ...) statement, never by a line number, so an edit above a
// kill site cannot move the target. assertKillPointMarkers() enforces that each
// name has exactly one marker and exactly one call, and that the marker sits on
// that call.
const KILL_POINTS = Object.freeze({
  "journal-record-written": { file: JOURNAL_SRC, window: "between the marker/anchor record and the event record of one multi-record append" },
  "journal-record-pre-write": { file: JOURNAL_SRC, window: "before a record of the batch is written (torn-record window)" },
  "journal-appended-pre-snapshot": { file: JOURNAL_SRC, window: "after the batch is fsynced, before the snapshot checkpoint is written" },
  "external-effect-recorded": { file: SIDE_EFFECTS_SRC, window: "after a provider side effect (PR merge / workspace merge) is recorded, before markDone" },
});
const KILL_MARKER = /^\s*\/\/ kill-point:([a-z-]+)\s*$/;
const CRASH_CALL = /crashPoint\("([a-z-]+)"/;

// Asserts that `file` carries exactly the kill points `names`, each marked once
// and called once, with the marker directly above its call. Throws on any drift.
function assertKillPointMarkers(file, names) {
  const base = path.basename(file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const markerAt = (name) => lines.flatMap((line, i) => (KILL_MARKER.exec(line)?.[1] === name ? [i] : []));
  for (const name of names) {
    const at = markerAt(name);
    assert.equal(at.length, 1, `${base}: kill point ${name} needs exactly one // kill-point:${name} marker, found ${at.length}`);
    const next = lines.slice(at[0] + 1).find((line) => line.trim() !== "") || "";
    assert.ok(next.includes(`crashPoint("${name}"`),
      `${base}: // kill-point:${name} must sit directly on crashPoint("${name}"), found: ${next.trim()}`);
    const calls = lines.filter((line) => line.includes(`crashPoint("${name}"`)).length;
    assert.equal(calls, 1, `${base}: crashPoint("${name}") must be called exactly once, found ${calls}`);
  }
  const calledNames = lines.filter((line) => !line.trim().startsWith("//")).map((line) => CRASH_CALL.exec(line)?.[1]).filter(Boolean);
  for (const called of calledNames) {
    assert.ok(names.includes(called), `${base}: crashPoint("${called}") is not a declared kill point`);
  }
  for (const line of lines) {
    const id = KILL_MARKER.exec(line)?.[1];
    if (id !== undefined) assert.ok(names.includes(id), `${base}: marker // kill-point:${id} is not a declared kill point`);
  }
}

function declaredKillPointNames(file) {
  return Object.keys(KILL_POINTS).filter((name) => KILL_POINTS[name].file === file);
}

function assertAllKillPointMarkers(sources = null) {
  for (const file of [JOURNAL_SRC, SIDE_EFFECTS_SRC]) {
    assertKillPointMarkers(sources?.get(file) ?? file, declaredKillPointNames(file));
  }
}

const createdSandboxes = [];
after(() => {
  for (const dir of createdSandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function sandboxDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord950-crash-"));
  createdSandboxes.push(dir);
  return dir;
}

function runChild(mode, dir, ...args) {
  const result = spawnSync(process.execPath, [CHILD, mode, dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `child ${mode} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// Start the scenario in a child that blocks at `point`, wait for it to reach
// that point, then SIGKILL it from here. Resolves once the process is dead.
async function killAtPoint(dir, scenario, point, { index = "", tear = false } = {}) {
  const reachedPath = path.join(dir, "reached.json");
  fs.rmSync(reachedPath, { force: true });
  const child = spawnKillable([CHILD, "kill", dir, scenario, point, String(index), tear ? "tear" : ""]);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(reachedPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before reaching ${point} (code ${child.exitCode}): ${stderr}`);
    }
    if (Date.now() > deadline) {
      signalGroup(child, "SIGKILL");
      throw new Error(`child never reached ${point}: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reached = JSON.parse(fs.readFileSync(reachedPath, "utf8"));
  signalGroup(child, "SIGKILL");
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL", "the parent must have killed the child");
  assert.equal(code, null);
  return { reached };
}

function succeededWithKey(inspect) {
  return inspect.events.filter((event) => event.result === "succeeded" && event.idempotency_key === IDEMPOTENCY_KEY);
}

function rawLogLines(dir) {
  const logPath = path.join(dir, ".runtime", "governance-events.ndjson");
  return fs.readFileSync(logPath, "utf8").split("\n").filter((line) => line.trim() !== "");
}

// ---------------------------------------------------------------------------
// Journal: multi-record append (journal.js:1086-1094)
// ---------------------------------------------------------------------------

test("COORD-950: kill source lines are the kill points this suite targets", () => {
  assertAllKillPointMarkers();
});

test("COORD-1004: the kill-point check is line-independent: shifted copies of the sources still locate every kill point", () => {
  const dir = sandboxDir();
  const shifted = new Map();
  for (const file of [JOURNAL_SRC, SIDE_EFFECTS_SRC]) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    // Insert blank lines above and inside the file so every kill site moves.
    const mid = Math.floor(lines.length / 2);
    const copy = [...Array(40).fill(""), ...lines.slice(0, mid), "", "", "", ...lines.slice(mid)];
    const copyPath = path.join(dir, path.basename(file));
    fs.writeFileSync(copyPath, copy.join("\n"), "utf8");
    shifted.set(file, copyPath);
  }
  assertAllKillPointMarkers(shifted);
});

// Writes `mutate(lines)` of `file` into a sandbox and returns its path.
function mutatedCopy(file, mutate) {
  const dir = sandboxDir();
  const lines = mutate(fs.readFileSync(file, "utf8").split("\n"));
  const copyPath = path.join(dir, path.basename(file));
  fs.writeFileSync(copyPath, lines.join("\n"), "utf8");
  return copyPath;
}

test("COORD-1004: the check refuses a duplicated kill-point marker", () => {
  const copy = mutatedCopy(JOURNAL_SRC, (lines) => {
    const at = lines.findIndex((line) => line.includes("// kill-point:journal-record-written"));
    assert.ok(at >= 0, "the marker must exist before it can be duplicated");
    return [...lines.slice(0, at), lines[at], ...lines.slice(at)];
  });
  assert.throws(() => assertKillPointMarkers(copy, declaredKillPointNames(JOURNAL_SRC)),
    /kill point journal-record-written needs exactly one .* found 2/);
});

test("COORD-1004: the check refuses a missing kill-point marker", () => {
  const copy = mutatedCopy(SIDE_EFFECTS_SRC, (lines) => lines.filter((line) => !line.includes("// kill-point:external-effect-recorded")));
  assert.throws(() => assertKillPointMarkers(copy, declaredKillPointNames(SIDE_EFFECTS_SRC)),
    /kill point external-effect-recorded needs exactly one .* found 0/);
});

test("COORD-1004: the check refuses a second crashPoint call for a declared kill point", () => {
  const copy = mutatedCopy(JOURNAL_SRC, (lines) => {
    const at = lines.findIndex((line) => line.includes('crashPoint("journal-appended-pre-snapshot"'));
    assert.ok(at >= 0, "the call must exist before it can be duplicated");
    return [...lines.slice(0, at + 1), lines[at], ...lines.slice(at + 1)];
  });
  assert.throws(() => assertKillPointMarkers(copy, declaredKillPointNames(JOURNAL_SRC)),
    /crashPoint\("journal-appended-pre-snapshot"\) must be called exactly once, found 2/);
});

test("COORD-950: kill between the legacy-migration anchor and the event record is recovered; chain verifies and the retry writes one succeeded event", async () => {
  const dir = sandboxDir();
  runChild("init", dir, "legacy-anchor");
  const { reached } = await killAtPoint(dir, "board", "journal-record-written", { index: 0 });
  assert.equal(reached.point, "journal-record-written");
  // The anchor reached disk, the event did not: a two-record batch was cut in half.
  const beforeRecovery = rawLogLines(dir).map((line) => JSON.parse(line));
  assert.equal(beforeRecovery.at(-1).result, "anchored", "the chain anchor is the surviving tip");
  assert.equal(beforeRecovery.some((event) => event.command === "crash-probe-board"), false, "the event record did not land");
  assert.equal(succeededWithKey(runChild("inspect", dir)).length, 0);

  const recovery = runChild("recover", dir);
  assert.ok(recovery.recovery, "recovery must run the real recovery path");
  const retry = runChild("retry", dir, "board");
  assert.equal(retry.retried, true);

  const inspect = runChild("inspect", dir);
  assert.deepEqual(inspect.chain.broken, [], "the hash chain must verify after recovery");
  assert.equal(succeededWithKey(inspect).length, 1, "the retried command must produce exactly one succeeded event");
});

test("COORD-950: kill mid-write of the event record leaves a torn tail; the COORD-033 repair path truncates it and the retry writes one succeeded event", async () => {
  const dir = sandboxDir();
  runChild("init", dir, "legacy-anchor");
  const { reached } = await killAtPoint(dir, "board", "journal-record-pre-write", { index: 1, tear: true });
  assert.equal(reached.index, 1);
  const lines = rawLogLines(dir);
  assert.throws(() => JSON.parse(lines.at(-1)), "the surviving last line must be a torn fragment");

  runChild("recover", dir);
  runChild("retry", dir, "board");

  const inspect = runChild("inspect", dir);
  assert.deepEqual(inspect.chain.broken, [], "the chain must verify after the torn tail is repaired");
  assert.equal(succeededWithKey(inspect).length, 1);
  for (const line of rawLogLines(dir)) JSON.parse(line);
});

test("COORD-950: kill after the append but before the snapshot checkpoint: the committed event is not replayed and the chain verifies", async () => {
  const dir = sandboxDir();
  runChild("init", dir);
  const { reached } = await killAtPoint(dir, "board", "journal-appended-pre-snapshot");
  assert.equal(reached.point, "journal-appended-pre-snapshot");
  assert.equal(succeededWithKey(runChild("inspect", dir)).length, 1, "the append itself landed before the kill");

  runChild("recover", dir);
  const retry = runChild("retry", dir, "board");
  assert.equal(retry.retried, true);

  const inspect = runChild("inspect", dir);
  assert.deepEqual(inspect.chain.broken, []);
  assert.equal(succeededWithKey(inspect).length, 1, "a retry after a landed append must not append a second succeeded event");
});

// ---------------------------------------------------------------------------
// External side effects held in memory (governance-side-effects.js:39)
// ---------------------------------------------------------------------------

test("COORD-950: kill after a fake-provider PR merge is recorded: the merge is durable before markDone, recovery journals it, and the retry never merges twice", async () => {
  const dir = sandboxDir();
  runChild("init", dir, "pr-merge");
  const { reached } = await killAtPoint(dir, "pr-merge", "external-effect-recorded");
  assert.equal(reached.point, "external-effect-recorded");
  assert.equal(runChild("inspect", dir).providerCalls.filter((call) => call.action === "merge").length, 1);

  // The merge must survive the kill on disk without any journal entry for the effect yet.
  const pending = path.join(dir, ".runtime", "governance-external-effects.ndjson");
  assert.ok(fs.existsSync(pending), "the external effect must be persisted before the kill, not held in memory");
  const durable = fs.readFileSync(pending, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(durable.length, 1);
  assert.equal(durable[0].type, "github_pr_merge");

  const recovery = runChild("recover", dir);
  assert.ok(recovery.recovery, "recovery must run");
  const afterRecovery = runChild("inspect", dir);
  const journaled = afterRecovery.events.filter((event) => (event.external_side_effects || []).some((effect) => effect.type === "github_pr_merge"));
  assert.equal(journaled.length, 1, "recovery must journal the PR merge with its merge SHA");
  const mergeSha = journaled[0].external_side_effects.find((effect) => effect.type === "github_pr_merge").merge_commit_sha;
  assert.match(mergeSha, /^pr-merge-1$/);

  const retry = runChild("retry", dir, "pr-merge");
  assert.equal(retry.reusedMergeSha, mergeSha, "the retry must take the merge SHA from the durable record");
  assert.equal(retry.mergedSha, undefined, "the retry must not merge a second time");
  const inspect = runChild("inspect", dir);
  assert.equal(inspect.providerCalls.filter((call) => call.action === "merge").length, 1, "exactly one merge on the provider");
  assert.deepEqual(inspect.chain.broken, []);
  assert.equal(succeededWithKey(inspect).length, 1);
});

test("COORD-950: kill after a real workspace merge commit is recorded: recovery journals the merge so the COORD-706 reader recovers its SHA, and the retry never merges again", async () => {
  const dir = sandboxDir();
  runChild("init", dir, "workspace-merge");
  const { reached } = await killAtPoint(dir, "workspace-merge", "external-effect-recorded");
  assert.equal(reached.point, "external-effect-recorded");
  assert.equal(runChild("inspect", dir).providerCalls.filter((call) => call.action === "merge").length, 1);

  runChild("recover", dir);
  const recovered = runChild("inspect", dir);
  const merge = recovered.events
    .flatMap((event) => event.external_side_effects || [])
    .find((effect) => effect.type === "control_plane_workspace_merge");
  assert.ok(merge, "recovery must journal the workspace merge");
  assert.equal(typeof merge.merge_commit_sha, "string");

  const retry = runChild("retry", dir, "workspace-merge");
  assert.equal(retry.reusedMergeSha, merge.merge_commit_sha, "the retry must reuse the journaled merge SHA");
  assert.equal(retry.mergedSha, undefined, "the retry must not perform a second workspace merge");
  const inspect = runChild("inspect", dir);
  assert.equal(inspect.providerCalls.filter((call) => call.action === "merge").length, 1);
  assert.deepEqual(inspect.chain.broken, []);
  assert.equal(succeededWithKey(inspect).length, 1);
});

test("COORD-950: an effect-only mutation (no governed file change, no idempotency key) still journals its external effect", () => {
  const dir = sandboxDir();
  runChild("init", dir);
  runChild("effect-only", dir);
  const inspect = runChild("inspect", dir);
  const journaled = inspect.events.flatMap((event) => event.external_side_effects || []);
  assert.ok(
    journaled.some((effect) => effect.type === "github_pr_merge" && effect.merge_commit_sha === "effect-only-sha"),
    "the effect must reach the journal even when no file changed"
  );
  assert.deepEqual(inspect.chain.broken, []);
});

// COORD-994: one kill helper for every harness child. Each child leads its own process group
// (detached), so a group signal reaches the child AND anything it spawned.
const ORPHAN_PARENT = `
  const fs = require("node:fs");
  const { spawn } = require("node:child_process");
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
`;

test("COORD-994: a kill reaches the killed child and its grandchild (no orphans)", async () => {
  const dir = sandboxDir();
  const pidsPath = path.join(dir, "pids.json");
  const child = spawnKillable(["-e", ORPHAN_PARENT, pidsPath]);
  let pids = null;
  try {
    assert.ok(await waitUntil(() => fs.existsSync(pidsPath), 10000), "the orphan parent must write its pids");
    pids = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
    assert.ok(isAlive(pids.child) && isAlive(pids.grandchild), "both processes must be running before the kill");
    await killGroup(child);
    await waitUntil(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 3000);
    assert.equal(isAlive(pids.child), false, "the killed child must be gone");
    assert.equal(isAlive(pids.grandchild), false, "the grandchild must be gone, not orphaned");
  } finally {
    if (pids) {
      for (const pid of [pids.child, pids.grandchild]) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
});

test("COORD-994: a group that ignores SIGTERM is escalated to SIGKILL after the grace period", async () => {
  const dir = sandboxDir();
  const readyPath = path.join(dir, "ready");
  const script = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(process.argv[1], "ready");
    setInterval(() => {}, 1000);`;
  const child = spawnKillable(["-e", script, readyPath]);
  assert.ok(await waitUntil(() => fs.existsSync(readyPath), 10000), "the child must install its SIGTERM handler first");
  await killGroup(child, 200);
  assert.equal(child.signalCode, "SIGKILL", "SIGTERM was ignored, so only the escalated SIGKILL can have ended the child");
});
