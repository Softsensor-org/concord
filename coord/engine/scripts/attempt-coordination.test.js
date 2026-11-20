"use strict";

// COORD-1028 / ADR 0023: attempt publishing, the canonical fence and integration
// selection, run against a REAL bare remote with two independent clones (two
// coordination domains). Uses the same fixture pattern as attempt-ref-lease.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture } = require("./test-git-fixture.js");
const lease = require("./attempt-ref-lease.js");
const coordination = require("./attempt-coordination.js");

const TICKET = "COORD-1028";
const ROOT = coordination.COORD_STATE_ROOT;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coord-1028-${label}-`));
}

function commit(repo, name) {
  fs.writeFileSync(path.join(repo, `${name}.txt`), name);
  gitFixture(repo, ["add", `${name}.txt`]);
  gitFixture(repo, ["commit", "-q", "-m", name]);
  return gitFixture(repo, ["rev-parse", "HEAD"]);
}

function twoDomains(t) {
  const base = tempDir("domains");
  if (t) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, "remote.git");
  gitFixture(base, ["init", "-q", "--bare", remote]);
  const seed = path.join(base, "seed");
  gitFixture(base, ["init", "-q", seed]);
  const baseSha = commit(seed, "base");
  gitFixture(seed, ["push", "-q", remote, "HEAD:refs/heads/dev"]);
  const a = path.join(base, "domain-a");
  const b = path.join(base, "domain-b");
  gitFixture(base, ["clone", "-q", "-b", "dev", remote, a]);
  gitFixture(base, ["clone", "-q", "-b", "dev", remote, b]);
  return { base, remote, a, b, baseSha };
}

function attemptFor(repo, remote, domainId, handle, journalTxId, baseSha) {
  return coordination.publishAttempt(repo, {
    remote: "origin", ticket: TICKET, domainId, domainLabel: handle, journalTxId,
    agent: { handle }, baseSha, branch: `agent/${handle}-${TICKET}`,
    observedCanonical: { generation: 0 }, now: "2026-11-16T10:00:00.000Z",
  });
}

test("domain ids are minted once per runtime and stay stable", () => {
  const runtime = tempDir("runtime");
  const first = coordination.mintDomainId(runtime, { label: "domain-a" });
  const second = coordination.mintDomainId(runtime, { label: "ignored" });
  assert.match(first.domain_id, /^[0-9a-f]{32}$/);
  assert.equal(second.domain_id, first.domain_id);
  const other = coordination.mintDomainId(tempDir("runtime-b"));
  assert.notEqual(other.domain_id, first.domain_id);
});

test("two domains publish concurrent attempts on one ticket; both are visible and neither is refused", () => {
  const { remote, a, b, baseSha } = twoDomains();
  const idA = coordination.mintDomainId(tempDir("ra")).domain_id;
  const idB = coordination.mintDomainId(tempDir("rb")).domain_id;
  const pubA = attemptFor(a, remote, idA, "claudea801", "tx-a-1", baseSha);
  const pubB = attemptFor(b, remote, idB, "claudea802", "tx-b-1", baseSha);
  assert.equal(pubA.status, "published");
  assert.equal(pubB.status, "published");
  const listed = coordination.listAttempts(a, { remote: "origin", ticket: TICKET });
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((x) => x.record.domain_id).sort(), [idA, idB].sort());
  assert.equal(listed.every((x) => x.ref.startsWith(`${ROOT}attempts/${TICKET}/`)), true);
  assert.equal(listed.every((x) => x.record.state === "active"), true);
});

test("a retried attempt publish from the same journal transaction converges on one ref", () => {
  const { remote, a, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("retry")).domain_id;
  const first = attemptFor(a, remote, id, "claudea801", "tx-retry", baseSha);
  const second = attemptFor(a, remote, id, "claudea801", "tx-retry", baseSha);
  assert.equal(first.status, "published");
  assert.equal(second.status, "already-published");
  assert.equal(second.attempt_id, first.attempt_id);
  assert.equal(coordination.listAttempts(a, { remote: "origin", ticket: TICKET }).length, 1);
});

test("an attempt never changes canonical state: publishing attempts leaves no canonical ref", () => {
  const { remote, a, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("noc")).domain_id;
  attemptFor(a, remote, id, "claudea801", "tx-noc", baseSha);
  assert.equal(coordination.readCanonical(a, { remote: "origin", ticket: TICKET }), null);
});

test("selection advances canonical under the fence; a stale holder is refused by token and lease", () => {
  const { remote, a, b, baseSha } = twoDomains();
  const idA = coordination.mintDomainId(tempDir("sa")).domain_id;
  const idB = coordination.mintDomainId(tempDir("sb")).domain_id;
  const attA = attemptFor(a, remote, idA, "claudea801", "tx-sel-a", baseSha);
  attemptFor(b, remote, idB, "claudea802", "tx-sel-b", baseSha);
  const epoch = "claudea11@2026-11-16T09:00:00.000Z";

  // Integrator (domain A) bootstraps generation 0 and selects its own attempt.
  const genesis = coordination.bootstrapCanonical(a, { remote: "origin", ticket: TICKET, owner: "unassigned", status: "todo", authorityEpoch: epoch });
  assert.equal(genesis.bootstrapped, true);
  const genesisToken = coordination.tokenFor(TICKET, genesis.record, genesis.oid);

  // Domain B, a stale or disconnected holder, decided from the same generation 0.
  const staleView = coordination.readCanonical(b, { remote: "origin", ticket: TICKET });
  assert.equal(staleView.record.generation, 0);

  const next = coordination.canonicalRecord({
    ticket: TICKET, generation: 1, owner: "claudea801", status: "doing", selected: attA.attempt_id,
    rejected: [], integrator: { handle: "claudea11", session_id: "s", domain_id: idA }, authorityEpoch: epoch,
    txn: "itx-test", now: "2026-11-16T10:05:00.000Z",
  });
  const advanced = coordination.publishCanonicalTransition(a, { remote: "origin", ticket: TICKET, expected: genesis, next });
  assert.equal(advanced.status, "published");

  // Fence: the generation-0 token no longer verifies; the current one does.
  assert.deepEqual(
    { ok: coordination.verifyFence(b, { remote: "origin", ticket: TICKET, token: genesisToken, authorityEpoch: epoch }).ok,
      reason: coordination.verifyFence(b, { remote: "origin", ticket: TICKET, token: genesisToken, authorityEpoch: epoch }).reason },
    { ok: false, reason: "stale" });
  const current = coordination.verifyFence(b, { remote: "origin", ticket: TICKET, token: coordination.tokenFor(TICKET, next, advanced.oid), authorityEpoch: epoch });
  assert.equal(current.ok, true);

  // The stale holder's own publish from generation 0 is refused by the exact lease.
  const staleNext = coordination.canonicalRecord({
    ticket: TICKET, generation: 1, owner: "claudea802", status: "doing", selected: coordination.listAttempts(b, { remote: "origin", ticket: TICKET })[1].record.attempt_id,
    rejected: [], integrator: { handle: "claudea802", session_id: "s2", domain_id: idB }, authorityEpoch: epoch,
    txn: "itx-stale", now: "2026-11-16T10:06:00.000Z",
  });
  const refused = coordination.publishCanonicalTransition(b, { remote: "origin", ticket: TICKET, expected: staleView, next: staleNext });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "lease-mismatch");
  assert.equal(refused.holder, advanced.oid);
});

test("an epoch change makes the fence refuse a token that was current under the old authority", () => {
  const { remote, a, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("ep")).domain_id;
  attemptFor(a, remote, id, "claudea801", "tx-ep", baseSha);
  const genesis = coordination.bootstrapCanonical(a, { remote: "origin", ticket: TICKET, owner: "unassigned", status: "todo", authorityEpoch: "old-epoch" });
  const token = coordination.tokenFor(TICKET, genesis.record, genesis.oid);
  const result = coordination.verifyFence(a, { remote: "origin", ticket: TICKET, token, authorityEpoch: "new-epoch" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "epoch");
});

test("a token for another ticket and an absent canonical record are both refused", () => {
  const { remote, a } = twoDomains();
  assert.equal(coordination.verifyFence(a, { remote: "origin", ticket: TICKET, token: "COORD-9@0:" + "a".repeat(40) }).reason, "wrong-ticket");
  assert.equal(coordination.verifyFence(a, { remote: "origin", ticket: TICKET, token: "COORD-1028@0:" + "a".repeat(40) }).reason, "absent");
  assert.ok(remote);
});

test("the coordination namespace root is refused when it is a whole branch namespace", () => {
  const { remote, a } = twoDomains();
  assert.throws(() => coordination.listAttempts(a, { remote: "origin", root: "refs/heads/", ticket: TICKET }), /namespace/);
  assert.throws(() => coordination.listAttempts(a, { remote: "origin", ticket: "bad" }), /PREFIX-NUMBER/);
  assert.ok(lease);
});

// COORD-1041 (c): the 72 h stale, 14 d orphan and 30 d terminal-retention classes. Pure and
// report-only: nothing here reads or deletes a ref.
test("COORD-1041 (c) classification: 72 h stale, 14 d orphan and 30 d retention are report-only", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const hours = (h) => new Date(now - h * 3600 * 1000).toISOString();
  const attempt = (updated, state = "active", id = "a".repeat(32)) => ({
    ref: "x", record: { attempt_id: id, state, updated_at: updated },
  });
  const canonical = (status, selected = null, updated = hours(1)) => ({
    record: { status, selected_attempt: selected, updated_at: updated },
  });
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(71)), null, now).classes, [], "71 hours is not yet stale");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(73)), null, now).classes, ["attempt-stale"], "73 hours is stale");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(24 * 15)), null, now).classes, ["attempt-stale", "attempt-orphaned"], "15 days is orphaned");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(1)), canonical("done"), now).classes, ["attempt-orphaned"], "a terminal canonical ticket orphans an active attempt");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(1)), canonical("doing", "b".repeat(32)), now).classes, ["attempt-orphaned"], "an attempt not selected while another was selected is orphaned");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(1), "active", "b".repeat(32)), canonical("doing", "b".repeat(32)), now).classes, [], "the selected attempt is not orphaned");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(24 * 40), "withdrawn"), null, now).classes, [], "a withdrawn attempt is never stale or orphaned");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(1)), canonical("done", null, hours(24 * 31)), now).classes, ["attempt-orphaned", "retention-eligible"], "31 days after a terminal decision the attempt is retention-eligible");
  assert.deepEqual(coordination.classifyAttempt(attempt(hours(1)), canonical("done", null, hours(24 * 29)), now).classes, ["attempt-orphaned"], "29 days after a terminal decision is not yet retention-eligible");
  assert.deepEqual(coordination.classifyAttempt({ ref: "x", record: { attempt_id: "c".repeat(32), state: "active", updated_at: "not-a-date" } }, null, now).classes, ["timestamp-invalid"]);
  assert.equal(coordination.ATTEMPT_STALE_MS, 72 * 3600 * 1000);
  assert.equal(coordination.ATTEMPT_ORPHAN_MS, 14 * 24 * 3600 * 1000);
  assert.equal(coordination.TERMINAL_RETENTION_MS, 30 * 24 * 3600 * 1000);
});

// COORD-1047 (d): attempt publish at gov start, best-effort, outside the runtime lock.
test("COORD-1047 (d): gov start publishes an active attempt; a retry converges and a failure only warns", () => {
  const { remote, a, baseSha } = twoDomains();
  const runtime = tempDir("start-runtime");
  const first = coordination.publishStartAttempt(a, { remote: "origin", runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/claudea801-COORD-1028", baseSha });
  assert.equal(first.status, "published");
  assert.equal(first.warning, null);
  assert.match(first.attempt_id, /^[0-9a-f]{32}$/);
  const again = coordination.publishStartAttempt(a, { remote: "origin", runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/claudea801-COORD-1028", baseSha });
  assert.equal(again.status, "already-published");
  assert.equal(again.attempt_id, first.attempt_id);
  const listed = coordination.listAttempts(a, { remote: "origin", ticket: TICKET });
  assert.equal(listed.length, 1);
  assert.equal(coordination.readCanonical(a, { remote: "origin", ticket: TICKET }), null, "start never creates canonical state");
  const missing = coordination.publishStartAttempt(a, { remote: "no-such-remote", runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/x", baseSha });
  assert.equal(missing.status, "failed");
  assert.match(missing.warning, /not published/);
  const noBase = coordination.publishStartAttempt(a, { remote: "origin", runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/x", baseSha: null });
  assert.equal(noBase.status, "skipped");
  assert.match(noBase.warning, /no base commit/);
});

// COORD-1047 (b) and (c): report-only attempt health for doctor and explain.
test("COORD-1047 (b): attempt health reports stale and orphaned attempts and never writes a ref", () => {
  const { remote, a, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("health")).domain_id;
  attemptFor(a, remote, id, "claudea803", "tx-health-1", baseSha);
  const before = lease.readRemoteRef(a, "origin", `${ROOT}attempts/${TICKET}/${id}/${coordination.listAttempts(a, { remote: "origin", ticket: TICKET })[0].record.attempt_id}`);
  const fourDaysLater = Date.parse("2026-11-20T10:00:00.000Z");
  const health = coordination.attemptHealth(a, { remote: "origin", tickets: [TICKET], now: fourDaysLater });
  assert.equal(health.skipped, null);
  assert.deepEqual(health.findings.map((f) => f.class), ["attempt-stale"]);
  assert.equal(health.findings[0].attempt_id.length, 32);
  const listedAfter = coordination.listAttempts(a, { remote: "origin", ticket: TICKET, now: fourDaysLater });
  assert.equal(listedAfter.length, 1);
  assert.equal(before, lease.readRemoteRef(a, "origin", `${ROOT}attempts/${TICKET}/${id}/${listedAfter[0].record.attempt_id}`));
});

test("COORD-1047 (b): a done canonical ticket makes its active attempts orphaned, and no remote means no findings", () => {
  const { remote, a, b, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("orphan")).domain_id;
  attemptFor(a, remote, id, "claudea804", "tx-orphan-1", baseSha);
  const boot = coordination.bootstrapCanonical(b, { remote: "origin", ticket: TICKET, owner: "claudea804", authorityEpoch: 1, now: "2026-11-16T10:00:00.000Z" });
  assert.equal(boot.bootstrapped, true);
  const done = coordination.canonicalRecord({ ticket: TICKET, generation: 1, owner: "claudea804", status: "done", selected: null, rejected: [], integrator: null, authorityEpoch: 1, txn: "tx-done", now: "2026-11-16T10:00:00.000Z" });
  coordination.publishCanonicalTransition(b, { remote: "origin", ticket: TICKET, expected: boot, next: done });
  const health = coordination.attemptHealth(a, { remote: "origin", tickets: [TICKET], now: Date.parse("2026-11-16T11:00:00.000Z") });
  assert.deepEqual(health.findings.map((f) => f.class), ["attempt-orphaned"]);
  const bare = tempDir("no-remote");
  gitFixture(bare, ["init", "-q"]);
  assert.deepEqual(coordination.attemptHealth(bare, { remote: "origin", tickets: [TICKET] }), { skipped: "no-remote", findings: [], problems: [] });
});

// COORD-1047 (c): explain lists a ticket's attempts through a read-only helper.
test("COORD-1047 (c): listTicketAttempts lists a published attempt and reports skipped without a remote", () => {
  const { remote, a, baseSha } = twoDomains();
  const id = coordination.mintDomainId(tempDir("listing")).domain_id;
  attemptFor(a, remote, id, "claudea805", "tx-listing-1", baseSha);
  const listed = coordination.listTicketAttempts(a, {
    remote: "origin", ticket: TICKET, now: Date.parse("2026-11-16T10:00:00.000Z"),
  });
  assert.equal(listed.skipped, null);
  assert.equal(listed.attempts.length, 1);
  assert.equal(listed.attempts[0].agent, "claudea805");
  assert.equal(listed.attempts[0].state, "active");
  assert.deepEqual(listed.attempts[0].classes, []);
  const bare = tempDir("listing-no-remote");
  gitFixture(bare, ["init", "-q"]);
  assert.deepEqual(coordination.listTicketAttempts(bare, { ticket: TICKET }), { skipped: "no-remote", attempts: [], problems: [] });
});

test("COORD-1052: corrupt persistent domain identity is refused without replacing ownership", (t) => {
  const runtime = tempDir("invalid-domain");
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const file = path.join(runtime, coordination.DOMAIN_FILE);
  for (const bytes of ['{"domain_id":"not-a-domain"}\n', '{broken json\n']) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => coordination.mintDomainId(runtime), bytes.startsWith('{broken') ? SyntaxError : /invalid domain_id/);
    assert.equal(fs.readFileSync(file, "utf8"), bytes, "an invalid identity requires recovery, never a new random owner");
  }
});

test("COORD-1052: configured but unavailable attempt remote is a diagnostic problem, never an empty healthy listing", (t) => {
  const world = twoDomains(t);
  const before = gitFixture(world.remote, ["show-ref"]);
  gitFixture(world.a, ["remote", "set-url", "origin", path.join(world.base, "missing.git")]);
  assert.throws(() => coordination.listAttempts(world.a, { remote: "origin", ticket: TICKET }), /Could not list refs/);
  const listed = coordination.listTicketAttempts(world.a, { ticket: TICKET });
  assert.equal(listed.skipped, null, "configured but unreadable differs from absent remote");
  assert.deepEqual(listed.attempts, []);
  assert.equal(listed.problems.length, 1);
  assert.equal(listed.problems[0].ticket, TICKET);
  assert.match(listed.problems[0].message, /Could not list refs/);
  const health = coordination.attemptHealth(world.a, { tickets: [TICKET] });
  assert.deepEqual(health.findings, []);
  assert.equal(health.problems.length, 1);
  assert.equal(health.skipped, null);
  assert.equal(gitFixture(world.remote, ["show-ref"]), before);

  t.mock.method(lease, "assertNamespaceRoot", () => { throw new Error(); });
  const messageFree = coordination.listTicketAttempts(world.a, { ticket: TICKET });
  assert.deepEqual(messageFree, { skipped: null, attempts: [], problems: [{ ticket: TICKET, message: "Error" }] });
  assert.equal(gitFixture(world.remote, ["show-ref"]), before);
});

test("COORD-1052: malformed fetched canonical JSON refuses fence verification and preserves remote ownership", (t) => {
  const world = twoDomains(t);
  fs.writeFileSync(path.join(world.a, coordination.RECORD_FILE), "{malformed canonical record\n");
  gitFixture(world.a, ["add", coordination.RECORD_FILE]);
  gitFixture(world.a, ["commit", "-q", "-m", "fixture malformed canonical record"]);
  const oid = gitFixture(world.a, ["rev-parse", "HEAD"]);
  const ref = lease.canonicalRef(ROOT, TICKET);
  gitFixture(world.a, ["push", "-q", "origin", `HEAD:${ref}`]);
  const before = gitFixture(world.remote, ["show-ref"]);
  assert.throws(() => coordination.readCanonical(world.b, { remote: "origin", ticket: TICKET }), SyntaxError);
  assert.throws(() => coordination.verifyFence(world.b, { remote: "origin", ticket: TICKET,
    token: lease.formatGenerationToken(TICKET, 0, oid) }), SyntaxError);
  const listed = coordination.listTicketAttempts(world.b, { ticket: TICKET });
  assert.equal(listed.skipped, null);
  assert.equal(listed.problems.length, 1);
  assert.deepEqual(listed.attempts, []);
  assert.equal(gitFixture(world.remote, ["show-ref"]), before, "diagnostics must not repair, replace or delete canonical ownership");
});

test("COORD-1052: start resolves a base ref and observes the existing canonical generation", (t) => {
  const world = twoDomains(t);
  const runtime = path.join(world.base, "runtime");
  const boot = coordination.bootstrapCanonical(world.a, { remote: "origin", ticket: TICKET, owner: "unassigned", authorityEpoch: "epoch" });
  const next = coordination.canonicalRecord({ ticket: TICKET, generation: 1, owner: "claudea801", status: "doing", selected: null, rejected: [], integrator: null, authorityEpoch: "epoch", txn: "tx", now: "2026-11-16T10:00:00.000Z" });
  assert.equal(coordination.publishCanonicalTransition(world.a, { remote: "origin", ticket: TICKET, expected: boot, next }).status, "published");
  const started = coordination.publishStartAttempt(world.a, { runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/a", baseRef: "dev" });
  assert.equal(started.status, "published");
  const record = coordination.listAttempts(world.a, { remote: "origin", ticket: TICKET })[0].record;
  assert.equal(record.base_sha, world.baseSha);
  assert.equal(record.observed_canonical.generation, 1);
  assert.equal(coordination.publishStartAttempt(world.a, { runtimeDir: runtime, ticket: TICKET, handle: "claudea801", branch: "agent/a", baseRef: "missing" }).status, "skipped");
});

test("COORD-1052: invalid canonical state and generation transitions are refused", (t) => {
  const world = twoDomains(t);
  const fields = { ticket: TICKET, generation: 0, owner: "unassigned", status: "todo", selected: null, rejected: [], integrator: null, authorityEpoch: "epoch", txn: null, now: "2026-11-16T10:00:00.000Z" };
  assert.throws(() => coordination.canonicalRecord({ ...fields, status: "unknown" }), /Refusing canonical status/);
  assert.throws(() => coordination.canonicalRecord({ ...fields, generation: -1 }), /invalid canonical record/);
  const boot = coordination.bootstrapCanonical(world.a, { remote: "origin", ticket: TICKET, owner: "unassigned", authorityEpoch: "epoch" });
  const again = coordination.bootstrapCanonical(world.a, { remote: "origin", ticket: TICKET, owner: "other", authorityEpoch: "epoch" });
  assert.equal(again.bootstrapped, false);
  assert.equal(again.oid, boot.oid);
  assert.throws(() => coordination.publishCanonicalTransition(world.a, { remote: "origin", ticket: TICKET, expected: boot, next: boot.record }), /generation must step/);
  assert.equal(coordination.readCanonical(world.a, { remote: "origin", ticket: TICKET }).oid, boot.oid);
});

test("domain identity mint adopts a concurrent winner and propagates other write failures", (t) => {
  const dir = tempDir("mint-contention");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wonPath = path.join(dir, "winner", coordination.DOMAIN_FILE);
  const failedPath = path.join(dir, "denied", coordination.DOMAIN_FILE);
  const winner = { domain_id: "a".repeat(32), domain_label: "winner", minted_at: "2026-11-16T10:00:00.000Z" };
  const write = fs.writeFileSync;
  const denied = Object.assign(new Error("identity write denied"), { code: "EACCES" });
  t.mock.method(fs, "writeFileSync", (file, body, options) => {
    if (file === wonPath) write(file, JSON.stringify(winner), { flag: "wx" });
    if (file === failedPath) throw denied;
    return write(file, body, options);
  });

  assert.deepEqual(coordination.mintDomainId(path.dirname(wonPath), { label: "loser" }), winner);
  assert.deepEqual(JSON.parse(fs.readFileSync(wonPath, "utf8")), winner);
  assert.throws(() => coordination.mintDomainId(path.dirname(failedPath)), (error) => error === denied);
  assert.equal(fs.existsSync(failedPath), false);
});

test("attempt publication refuses record creation, fetch and lease failures without moving a ref", (t) => {
  const world = twoDomains(t);
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawnSync;
  let failedCommand;
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "git" && args[0] === failedCommand) {
      return { status: 1, stdout: "", stderr: "fixture Git operation refused" };
    }
    return spawn(command, args, options);
  });

  // Install the fault at the subprocess boundary so record fabrication and
  // remote ref reads still use the real attempt and lease code.
  const filename = require.resolve("./attempt-coordination.js");
  const original = require.cache[filename];
  delete require.cache[filename];
  let subject;
  try { subject = require(filename); }
  finally { require.cache[filename] = original; }

  const before = gitFixture(world.remote, ["show-ref"]);
  const attempt = {
    remote: "origin", ticket: TICKET, domainId: "a".repeat(32), journalTxId: "failed-record",
    agent: { handle: "claudea801" }, baseSha: world.baseSha, branch: "agent/fixture",
    observedCanonical: { generation: 0 },
  };
  for (const [command, detail] of [["hash-object", "store the record blob"], ["mktree", "build the record tree"], ["commit-tree", "write the record commit"]]) {
    failedCommand = command;
    assert.throws(() => subject.publishAttempt(world.a, attempt), new RegExp(`Could not ${detail}: fixture Git operation refused`));
    assert.equal(gitFixture(world.remote, ["show-ref"]), before);
  }

  failedCommand = null;
  const published = subject.publishAttempt(world.a, attempt);
  assert.equal(published.status, "published");
  const withAttempt = gitFixture(world.remote, ["show-ref"]);
  failedCommand = "fetch";
  assert.throws(() => subject.publishAttempt(world.b, attempt), /Could not fetch .* fixture Git operation refused/);
  assert.equal(gitFixture(world.remote, ["show-ref"]), withAttempt);

  failedCommand = null;
  t.mock.method(lease, "publishWithLease", () => ({ status: "lease-mismatch", reason: "concurrent writer" }));
  assert.throws(() => subject.bootstrapCanonical(world.a, {
    remote: "origin", ticket: TICKET, owner: "claudea801", authorityEpoch: 1,
  }), /Canonical bootstrap .* was not published: .*lease-mismatch/);
  assert.equal(gitFixture(world.remote, ["show-ref"]), withAttempt);
});

test("attempt reads reject a mismatched identity and a canonical commit lacking its record", (t) => {
  const world = twoDomains(t);
  const domainId = "a".repeat(32);
  const transaction = "expected-identity";
  const attemptRef = lease.attemptRef(ROOT, TICKET, domainId, lease.deriveAttemptId(domainId, transaction));
  const canonicalRef = lease.canonicalRef(ROOT, TICKET);
  fs.writeFileSync(path.join(world.a, coordination.RECORD_FILE), JSON.stringify({
    domain_id: domainId, attempt_id: "b".repeat(32),
  }));
  gitFixture(world.a, ["add", coordination.RECORD_FILE]);
  gitFixture(world.a, ["commit", "-q", "-m", "fixture mismatched attempt identity"]);
  gitFixture(world.a, ["push", "-q", "origin", `HEAD:${attemptRef}`, `${world.baseSha}:${canonicalRef}`]);

  const before = gitFixture(world.remote, ["show-ref"]);
  assert.throws(() => coordination.publishAttempt(world.b, {
    remote: "origin", ticket: TICKET, domainId, journalTxId: transaction,
    agent: { handle: "claudea801" }, baseSha: world.baseSha, branch: "agent/fixture",
    observedCanonical: { generation: 0 },
  }), /Attempt id collision/);
  assert.throws(() => coordination.readCanonical(world.b, { remote: "origin", ticket: TICKET }), /Could not read .* at /);
  assert.equal(gitFixture(world.remote, ["show-ref"]), before);
});

test("attempt health does not treat an invalid timestamp as stale or orphaned", (t) => {
  const world = twoDomains(t);
  const malformed = coordination.publishAttempt(world.a, {
    remote: "origin", ticket: TICKET, domainId: "a".repeat(32), journalTxId: "legacy-timestamp",
    agent: { handle: "claudea801" }, baseSha: world.baseSha, branch: "agent/fixture",
    observedCanonical: { generation: 0 }, now: "unknown",
  });
  assert.equal(malformed.status, "published");
  const before = gitFixture(world.remote, ["show-ref"]);
  const listed = coordination.listTicketAttempts(world.b, { ticket: TICKET });
  assert.deepEqual(listed.problems, []);
  assert.deepEqual(listed.attempts.map(({ age_ms, classes }) => [age_ms, classes]), [[null, ["timestamp-invalid"]]]);
  const health = coordination.attemptHealth(world.b, { tickets: [TICKET] });
  assert.deepEqual(health, { skipped: null, findings: [], problems: [] });
  assert.equal(gitFixture(world.remote, ["show-ref"]), before);
});
