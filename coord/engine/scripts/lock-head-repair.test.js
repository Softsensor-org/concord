// COORD-978: `gov repair-lock-head <ID>` realigns a ticket's lock head with its worktree HEAD.
// Owner repairs only to a commit containing every recorded head; anything else needs
// --human-admin-override. Preview is read-only and always allowed. Apply is journaled,
// expected-state guarded and safe to retry after a crash.
require("./test-runner.js").scrubIdentityEnv();
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { TICKET_A, THREAD_A, THREAD_B, wedgedFixture, orphanCommit } = require("./fixtures/lock-head-wedge.js");
const { gitFixtureSpawn } = require("./test-git-fixture.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function previewJson(out) {
  return JSON.parse(out.slice(out.indexOf("{")));
}

function snapshot(f) {
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  return { board: read(`${f.ws.coord}/board/tasks.json`), lock: read(f.lockPath(TICKET_A)), journal: read(f.journalPath) };
}

test("COORD-978 preview: read-only and always allowed, even for a non-owner", () => {
  const f = wedgedFixture("coord978-preview-");
  try {
    f.commitFixture();
    f.bindOwner(THREAD_B, f.ownerB);
    const before = snapshot(f);
    const preview = f.gov(THREAD_B, ["repair-lock-head", TICKET_A, "--dry-run"]);
    assert.equal(preview.status, 0, preview.out);
    const payload = previewJson(preview.out);
    assert.match(payload.expected_state_digest, /^[0-9a-f]{64}$/);
    assert.equal(payload.lock.head, f.lockA.head);
    assert.equal(payload.target, f.newHead);
    assert.equal(payload.containment.every((entry) => entry.contains === true), true);
    assert.deepEqual(snapshot(f), before, "preview must not change the board, lock or journal");
  } finally {
    f.cleanup();
  }
});

test("COORD-978: owner repair to a containing commit succeeds and is journaled", () => {
  const f = wedgedFixture("coord978-owner-");
  try {
    f.commitFixture();
    f.bindOwner(THREAD_A, f.ownerA);
    const digest = previewJson(f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--dry-run"]).out).expected_state_digest;
    const repair = f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--to", f.newHead, "--expect", digest]);
    assert.equal(repair.status, 0, repair.out);
    assert.equal(f.readLock(TICKET_A).head, f.newHead);
    assert.equal(f.journalEvents("repair-lock-head").length, 1, "exactly one journaled repair event");
  } finally {
    f.cleanup();
  }
});

test("COORD-978: owner repair to a non-containing commit is refused and writes nothing", () => {
  const f = wedgedFixture("coord978-noncontain-");
  try {
    f.commitFixture();
    const unrelated = orphanCommit(f.lockA.worktree);
    const moved = gitFixtureSpawn(f.lockA.worktree, ["checkout", "-B", f.lockA.branch, unrelated]);
    assert.equal(moved.status, 0, moved.stderr);
    f.bindOwner(THREAD_A, f.ownerA);
    const digest = previewJson(f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--dry-run"]).out).expected_state_digest;
    const before = snapshot(f);
    const repair = f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--to", unrelated, "--expect", digest]);
    assert.notEqual(repair.status, 0, "a non-containing target must be refused for the owner");
    assert.match(repair.out, /does not contain|--human-admin-override/);
    assert.deepEqual(snapshot(f), before, "a refused repair writes nothing");
  } finally {
    f.cleanup();
  }
});

test("COORD-978: human-admin override repairs to a non-containing commit and is journaled with its reason", () => {
  const f = wedgedFixture("coord978-override-");
  const approval = createApprovalFixture({ allowedVerbs: ["repair-lock-head"] });
  try {
    f.commitFixture();
    const unrelated = orphanCommit(f.lockA.worktree);
    const moved = gitFixtureSpawn(f.lockA.worktree, ["checkout", "-B", f.lockA.branch, unrelated]);
    assert.equal(moved.status, 0, moved.stderr);
    f.bindOwner(THREAD_B, f.ownerB);
    const digest = previewJson(f.gov(THREAD_B, ["repair-lock-head", TICKET_A, "--dry-run"]).out).expected_state_digest;
    const reason = "COORD-978 fixture: human-admin override";
    const args = ["repair-lock-head", TICKET_A, "--to", unrelated, "--expect", digest, "--human-admin-override", reason];
    const env = { ...process.env, CODEX_THREAD_ID: THREAD_B };
    delete env.COORD_SESSION_ID;
    const beforeRefusal = snapshot(f);
    const first = approval.runCli(f.ws.coord, args, { cwd: f.ws.root, env, encoding: "utf8" });
    const firstText = `${first.stdout || ""}${first.stderr || ""}`;
    assert.notEqual(first.status, 0, "an override reason without a signed record must be refused");
    assert.match(firstText, /requires a signed human-admin approval/);
    assert.deepEqual([snapshot(f).board, snapshot(f).lock], [beforeRefusal.board, beforeRefusal.lock],
      "unauthenticated refusal must not alter the board or governed lock");
    const subject = /Subject digest: ([0-9a-f]{64})/.exec(firstText);
    assert.ok(subject, firstText);
    approval.login({ verb: "repair-lock-head", ticket: TICKET_A, subject_sha256: subject[1] });
    const result = approval.runCli(f.ws.coord, args, { cwd: f.ws.root, env, encoding: "utf8" });
    const repair = { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
    assert.equal(repair.status, 0, repair.out);
    assert.equal(f.readLock(TICKET_A).head, unrelated);
    const events = f.journalEvents("repair-lock-head");
    const repaired = events.filter((event) => event.result === "succeeded");
    const approvals = events.filter((event) => event.event === "approval.verified");
    assert.equal(repaired.length, 1, "exactly one mutation event records the repaired lock");
    assert.equal(approvals.length, 1, "the signed approval is separately journaled exactly once");
    assert.match(JSON.stringify(repaired[0]), /human-admin-override/);
    assert.match(JSON.stringify(repaired[0]), /COORD-978 fixture: human-admin override/);
    assert.match(JSON.stringify(approvals[0]), /human_admin_session/);
  } finally {
    approval.cleanup();
    f.cleanup();
  }
});

test("COORD-978: a stale expected-state digest refuses the apply", () => {
  const f = wedgedFixture("coord978-stale-");
  try {
    f.commitFixture();
    f.bindOwner(THREAD_A, f.ownerA);
    const repair = f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--to", f.newHead, "--expect", "0".repeat(64)]);
    assert.notEqual(repair.status, 0);
    assert.match(repair.out, /expected state changed/);
    assert.equal(f.readLock(TICKET_A).head, f.lockA.head);
  } finally {
    f.cleanup();
  }
});

test("COORD-978: a crash between the lock write and the journal event is retried safely", () => {
  const f = wedgedFixture("coord978-crash-");
  try {
    f.commitFixture();
    f.bindOwner(THREAD_A, f.ownerA);
    const digest = previewJson(f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--dry-run"]).out).expected_state_digest;
    const crashed = f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--to", f.newHead, "--expect", digest], { COORD_LOCK_HEAD_REPAIR_FAULT: "after-lock-write" });
    assert.equal(crashed.status, 86, `the injected crash must fire after the lock write: ${crashed.out}`);
    const retried = f.gov(THREAD_A, ["repair-lock-head", TICKET_A, "--to", f.newHead, "--expect", digest]);
    assert.equal(retried.status, 0, retried.out);
    assert.equal(f.readLock(TICKET_A).head, f.newHead);
    assert.equal(f.journalEvents("repair-lock-head").length, 1, "the retry journals the repair exactly once");
  } finally {
    f.cleanup();
  }
});

// Exercise the canonical module directly: the CLI fixtures above intentionally
// copy an adopter workspace, so their source URLs cannot qualify engine coverage.
function withCanonicalLockRepair(run) {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-lock-repair-"));
  const repo = path.join(root, "repo"), locks = path.join(root, "locks"), plans = path.join(root, "plans");
  const runtimeDir = path.join(root, "runtime");
  for (const dir of [repo, locks, plans, runtimeDir]) fs.mkdirSync(dir);
  const git = (args) => {
    const result = gitFixtureSpawn(repo, args);
    assert.equal(result.status, 0, String(result.stderr));
    return String(result.stdout).trim();
  };
  const authority = require("./integration-authority.js");
  const originalCaller = authority.resolveCaller;
  const originalLog = console.log;
  const { withScopedGovernanceTestContext } = require("../../scripts/governance-test-utils.js");
  try {
    const init = gitFixtureSpawn(repo, ["init", "--initial-branch=repair-fixture"]);
    assert.equal(init.status, 0, String(init.stderr));
    fs.writeFileSync(path.join(repo, "content"), "first\n");
    git(["add", "content"]); git(["commit", "-m", "first"]);
    const oldHead = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "content"), "second\n");
    git(["commit", "-am", "second"]);
    const head = git(["rev-parse", "HEAD"]);
    const ticket = "COORD-1052", boardPath = path.join(root, "board.json"), lockPath = path.join(locks, `${ticket}.lock`);
    const lock = { owner: "fixture-owner", head: oldHead, branch: "repair-fixture", worktree: repo, heartbeat_utc: "2026-11-17T00:00:00.000Z" };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [{ ID: ticket, Status: "doing" }] }] }));
    let caller = "fixture-owner", beforeMutation = () => {};
    const mutations = [], output = [];
    authority.resolveCaller = () => caller ? { handle: caller } : null;
    console.log = (line) => output.push(JSON.parse(line));
    const approvalEvents = [];
    const service = require("./lock-head-repair.js").createLockHeadRepair({
      withGovernanceMutation: (metadata, fn) => { mutations.push(metadata); beforeMutation(); return fn(); },
      runtimeDir,
      resolveHumanAdminOverride: (_command, flags) => ({ reason: flags.humanAdminOverride }),
      appendGovernanceEvent: (event) => {
        approvalEvents.push(event);
        fs.appendFileSync(path.join(runtimeDir, "governance-events.ndjson"), `${JSON.stringify(event)}\n`);
      },
    });
    const fixturePaths = { BOARD_PATH: boardPath, LOCKS_DIR: locks, PLAN_RECORDS_DIR: plans };
    return withScopedGovernanceTestContext(fixturePaths, () => run({
      service, ticket, lock, lockPath, boardPath, plans, head, oldHead, repo, git, mutations, output, approvalEvents, fixturePaths,
      setCaller: (value) => { caller = value; },
      beforeMutation: (fn) => { beforeMutation = fn; },
      readLock: () => JSON.parse(fs.readFileSync(lockPath, "utf8")),
      writeLock: (value) => fs.writeFileSync(lockPath, JSON.stringify(value)),
      preview: (flags = {}) => { service.repairLockHead(ticket, { dryRun: true, ...flags }); return output.at(-1); },
    }));
  } finally {
    authority.resolveCaller = originalCaller;
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("COORD-1052: canonical repair preview is read-only and owner apply preserves every other lock field", () => {
  withCanonicalLockRepair((f) => {
    const before = fs.readFileSync(f.lockPath, "utf8");
    const preview = f.preview();
    assert.equal(preview.authority.path, "owner");
    assert.equal(preview.writes, "none");
    assert.equal(preview.target, f.head);
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), before);
    assert.equal(f.mutations.length, 0);
    const result = f.service.repairLockHead(f.ticket, { to: f.head, expect: preview.expected_state_digest });
    assert.equal(result.status, "repaired");
    assert.deepEqual(f.readLock(), { ...f.lock, head: f.head });
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].details.from, f.oldHead);
    assert.equal(f.mutations[0].details.to, f.head);
    assert.equal(f.mutations[0].details.human_admin_override, null);
    assert.equal(f.mutations[0].idempotentResult.status, "already-repaired");
    const after = f.preview();
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: after.expected_state_digest }), /already equals/);
    assert.deepEqual(f.readLock(), { ...f.lock, head: f.head });
  });
});

test("COORD-1052: repair refuses missing, invalid and stale preview inputs without changing the lock", () => {
  withCanonicalLockRepair((f) => {
    const before = fs.readFileSync(f.lockPath, "utf8");
    assert.throws(() => f.service.repairLockHead(), /requires <ticket-id>/);
    assert.throws(() => f.service.repairLockHead("COORD-MISSING"), /no governed lock/);
    assert.throws(() => f.service.repairLockHead(f.ticket), /previewed state/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: "invalid" }), /64-hex/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: "0".repeat(64) }), /state changed/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { to: "short", expect: "0".repeat(64) }), /full commit SHA/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { to: f.oldHead, expect: "0".repeat(64) }), /not the live worktree HEAD/);
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), before);
    fs.writeFileSync(f.boardPath, JSON.stringify({ sections: [{ rows: [null, { ID: "OTHER" }] }] }));
    assert.throws(() => f.preview(), /Unknown ticket/);
  });
});

test("COORD-1052: repair rechecks branch and state after entering the mutation", () => {
  withCanonicalLockRepair((f) => {
    const preview = f.preview();
    f.beforeMutation(() => f.writeLock({ ...f.lock, branch: "changed-branch" }));
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: preview.expected_state_digest }), /branch precondition fails/);
    assert.deepEqual(f.readLock(), { ...f.lock, branch: "changed-branch" });
    f.writeLock(f.lock);
    f.beforeMutation(() => f.writeLock({ ...f.lock, owner: "new-owner" }));
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: preview.expected_state_digest }), /state changed since the preview/);
    assert.deepEqual(f.readLock(), { ...f.lock, owner: "new-owner" });
  });
});

test("COORD-1052: unbound non-owner preview is read-only and apply is refused", () => {
  withCanonicalLockRepair((f) => {
    f.setCaller(null);
    const preview = f.preview();
    assert.equal(preview.authority.allowed, false);
    assert.match(preview.authority.reason, /unbound/);
    assert.match(preview.next_commands[0], /human-admin-override/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: preview.expected_state_digest }), /not the owner/);
    assert.deepEqual(f.readLock(), f.lock);
  });
});

test("COORD-1052: repair considers review, PR and finding heads and refuses missing recorded commits", () => {
  withCanonicalLockRepair((f) => {
    const missing = "f".repeat(40);
    fs.writeFileSync(f.boardPath, JSON.stringify({ sections: [{ rows: [{ ID: f.ticket }] }],
      pr_index: { [f.ticket]: [null, "url", { head_sha: f.oldHead }, { headRefOid: f.head }] },
      review_findings: { [f.ticket]: [null, "note", { commit: missing }, { head: f.head }] },
    }));
    fs.writeFileSync(`${f.plans}/${f.ticket}.json`, JSON.stringify({ review_submission: { commit: f.head.toUpperCase() } }));
    const preview = f.preview();
    assert.deepEqual(preview.recorded_heads, [
      { kind: "lock_head", commit: f.oldHead }, { kind: "review_submission", commit: f.head }, { kind: "finding_head", commit: missing },
    ]);
    assert.equal(preview.authority.allowed, false);
    assert.match(preview.containment.at(-1).reason, /not present/);
    assert.throws(() => f.service.repairLockHead(f.ticket, { expect: preview.expected_state_digest }), /does not contain every recorded head/);
    assert.deepEqual(f.readLock(), f.lock);
    const api = f.service.__testing;
    assert.deepEqual(api.recordedHeads(f.ticket, { head: "coord-no-git-head" }, {}, null), []);
    assert.equal(api.containment(f.repo, [{ kind: "future", commit: f.head }], f.oldHead)[0].contains, false);
    assert.match(api.containment(f.repo, [{ kind: "future", commit: f.head }], "invalid-target")[0].reason, /merge-base failed/);
  });
});

test("canonical repair refuses incomplete boards and a lock pointing at a non-Git directory", () => {
  withCanonicalLockRepair((f) => {
    const board = fs.readFileSync(f.boardPath, "utf8");
    const lock = fs.readFileSync(f.lockPath, "utf8");
    for (const incomplete of [{}, { sections: [{ heading: "Notes" }] }]) {
      const pending = JSON.stringify(incomplete);
      fs.writeFileSync(f.boardPath, pending);
      assert.throws(() => f.preview(), /Unknown ticket/);
      assert.equal(fs.readFileSync(f.boardPath, "utf8"), pending);
      assert.equal(fs.readFileSync(f.lockPath, "utf8"), lock);
    }
    fs.writeFileSync(f.boardPath, board);
    f.writeLock({ ...f.lock, worktree: f.plans });
    const unreadable = fs.readFileSync(f.lockPath, "utf8");
    assert.throws(() => f.preview(), /worktree without a readable git HEAD/);
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), unreadable);
    assert.equal(fs.readFileSync(f.boardPath, "utf8"), board);
    assert.equal(f.mutations.length, 0);
    assert.deepEqual(f.approvalEvents, []);
  });
});

test("signed canonical repair binds a non-containing legacy PR head and journals the verified reason", (t) => {
  const approval = createApprovalFixture({ allowedVerbs: ["repair-lock-head"] });
  t.after(approval.cleanup);
  withCanonicalLockRepair((f) => {
    const prHead = orphanCommit(f.repo);
    const board = JSON.stringify({
      sections: [{ rows: [{ ID: f.ticket }] }],
      pr_index: { [f.ticket]: [{ head: prHead }] },
    });
    fs.writeFileSync(f.boardPath, board);
    f.setCaller("fixture-nonowner");
    const reason = "approved legacy PR head recovery";
    const initialLock = fs.readFileSync(f.lockPath, "utf8");
    const preview = f.preview({ humanAdminOverride: `  ${reason}  ` });
    assert.equal(preview.authority.path, "human-admin-override");
    assert.deepEqual(preview.containment.at(-1), {
      kind: "pr_head", commit: prHead, contains: false, reason: "target does not contain this recorded head",
    });
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), initialLock);
    assert.deepEqual(f.approvalEvents, []);

    const apply = () => f.service.repairLockHead(f.ticket, {
      expect: preview.expected_state_digest,
      humanAdminOverride: `  ${reason}  `,
    });
    withApprovalTestClient(path.resolve(__dirname, "../.."), approval.client(), () => {
      let subject;
      assert.throws(apply, (error) => {
        assert.match(error.message, /requires a signed human-admin approval/);
        subject = /Subject digest: ([0-9a-f]{64})/.exec(error.message)?.[1];
        assert.ok(subject, error.message);
        return true;
      });
      assert.equal(fs.readFileSync(f.lockPath, "utf8"), initialLock);
      assert.equal(f.mutations[0].details, undefined);
      approval.login({ verb: "repair-lock-head", ticket: f.ticket, subject_sha256: subject });
      const repair = apply();
      assert.equal(repair.authority, "human-admin-override");
      assert.deepEqual(f.readLock(), { ...f.lock, head: f.head });
      assert.equal(fs.readFileSync(f.boardPath, "utf8"), board);
      const verified = f.approvalEvents.filter((event) => event.event === "approval.verified");
      assert.equal(verified.length, 1);
      const details = f.mutations.at(-1).details;
      assert.equal(details.human_admin_override, reason);
      assert.equal(details.approval.record_id, verified[0].approval_record);
      assert.equal(details.approval.subject_sha256, subject);
      assert.deepEqual(details.containment, preview.containment);
    });
  });
});

test("a real process crash interrupts canonical repair after the lock write and before mutation completion", () => {
  withCanonicalLockRepair((f) => {
    const expected = f.preview().expected_state_digest;
    const marker = path.join(f.plans, "mutation-completed");
    const script = `
      const fs = require("node:fs");
      const { withScopedGovernanceTestContext } = require(${JSON.stringify(require.resolve("../../scripts/governance-test-utils.js"))});
      const authority = require(${JSON.stringify(require.resolve("./integration-authority.js"))});
      const { createLockHeadRepair } = require(${JSON.stringify(require.resolve("./lock-head-repair.js"))});
      authority.resolveCaller = () => ({ handle: ${JSON.stringify(f.lock.owner)} });
      const service = createLockHeadRepair({ withGovernanceMutation: (_metadata, fn) => {
        fn();
        fs.writeFileSync(${JSON.stringify(marker)}, "completed");
      } });
      withScopedGovernanceTestContext(${JSON.stringify(f.fixturePaths)}, () =>
        service.repairLockHead(${JSON.stringify(f.ticket)}, { expect: ${JSON.stringify(expected)} }));
    `;
    const board = fs.readFileSync(f.boardPath, "utf8");
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: f.repo,
      env: { ...process.env, COORD_LOCK_HEAD_REPAIR_FAULT: "after-lock-write" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 86, child.stdout + child.stderr);
    assert.deepEqual(f.readLock(), { ...f.lock, head: f.head });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(f.boardPath, "utf8"), board);
  });
});

test("an interrupted Git ancestry check cannot authorize a lock repair", () => {
  withCanonicalLockRepair((f) => {
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
    assert.equal(gitPath.status, 0, gitPath.stderr);
    const shim = path.join(f.plans, "git");
    fs.writeFileSync(shim, [
      "#!/bin/sh",
      'if [ "$3" = merge-base ]; then kill -TERM "$$"; fi',
      'exec "$LOCK_HEAD_FIXTURE_REAL_GIT" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });

    const originalPath = process.env.PATH;
    const originalGit = process.env.LOCK_HEAD_FIXTURE_REAL_GIT;
    process.env.PATH = f.plans + path.delimiter + originalPath;
    process.env.LOCK_HEAD_FIXTURE_REAL_GIT = gitPath.stdout.trim();
    try {
      const preview = f.preview();
      assert.equal(preview.authority.allowed, false);
      assert.deepEqual(preview.containment, [{
        kind: "lock_head", commit: f.oldHead, contains: false, reason: "merge-base failed: ",
      }]);
      assert.throws(() => f.service.repairLockHead(f.ticket, { expect: preview.expected_state_digest }),
        /does not contain every recorded head/);
      assert.deepEqual(f.readLock(), f.lock);
      assert.equal(f.mutations.at(-1).details, undefined);
      assert.deepEqual(f.approvalEvents, []);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalGit === undefined) delete process.env.LOCK_HEAD_FIXTURE_REAL_GIT;
      else process.env.LOCK_HEAD_FIXTURE_REAL_GIT = originalGit;
    }
  });
});
