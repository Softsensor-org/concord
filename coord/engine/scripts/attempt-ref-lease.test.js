"use strict";

// COORD-899 / ADR 0023: attempt records, generation tokens and the exact-lease ref
// publish primitive. These run against a REAL bare remote and real clones, not a
// stubbed git, because the defect class is what the remote actually accepts.
// The test namespace root below is a fixture value only; ADR 0023 open question 1
// (the production prefix) is not decided by these tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { gitFixture } = require("./test-git-fixture.js");
const lease = require("./attempt-ref-lease.js");
const { assertGovernedPushArgv } = require("./control-plane-push.js");

const ROOT = "refs/coord-test/state/";
const TICKET = "COORD-899";

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coord-899-${label}-`));
}

function commit(repo, name) {
  fs.writeFileSync(path.join(repo, `${name}.txt`), name);
  gitFixture(repo, ["add", `${name}.txt`]);
  gitFixture(repo, ["commit", "-q", "-m", name]);
  return gitFixture(repo, ["rev-parse", "HEAD"]);
}

// One bare remote, a seeded first commit, and two independent clones (two domains).
function twoDomains(t = null) {
  const base = tempDir("race");
  if (t) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, "remote.git");
  gitFixture(base, ["init", "-q", "--bare", remote]);
  const seed = path.join(base, "seed");
  gitFixture(base, ["init", "-q", seed]);
  const root = commit(seed, "base");
  gitFixture(seed, ["push", "-q", remote, "HEAD:refs/heads/dev"]);
  const a = path.join(base, "domain-a");
  const b = path.join(base, "domain-b");
  gitFixture(base, ["clone", "-q", "-b", "dev", remote, a]);
  gitFixture(base, ["clone", "-q", "-b", "dev", remote, b]);
  return { base, remote, a, b, root };
}

function remoteRefs(remote, prefix) {
  const out = gitFixture(remote, ["for-each-ref", "--format=%(objectname) %(refname)", prefix]);
  return out ? out.split("\n").map((line) => line.split(" ")) : [];
}

test("attempt and canonical records validate and refuse malformed input", () => {
  const attempt = lease.makeAttemptRecord({
    ticket: TICKET,
    agent: { handle: "claudea808" },
    domainId: "domain-alpha-1",
    domainLabel: "laptop",
    journalTxId: "tx-1",
    baseSha: "a".repeat(40),
    branch: "agent/claudea808-coord-899",
    observedCanonical: { generation: 0 },
    now: "2026-11-16T00:00:00Z",
  });
  assert.equal(attempt.schema, lease.ATTEMPT_SCHEMA);
  assert.deepEqual(lease.validateAttemptRecord(attempt), []);
  assert.deepEqual(lease.validateAttemptRecord(null), ["attempt record must be an object"]);
  assert.deepEqual(lease.validateAttemptRecord({
    ...attempt,
    schema: "other",
    ticket: "unassigned",
    attempt_id: "pending",
    agent: {},
    domain_id: "",
    branch: "",
    state: "unknown",
  }), [
    `schema must be ${lease.ATTEMPT_SCHEMA}`,
    "ticket must be a PREFIX-NUMBER id",
    "attempt_id must be 32 lowercase hex characters",
    "agent.handle is required",
    "domain_id is required",
    "branch is required",
    "state must be one of active, submitted, withdrawn",
  ]);
  assert.throws(
    () => lease.makeAttemptRecord({ ticket: TICKET, agent: { handle: "x" }, domainId: "d", journalTxId: "t", baseSha: "not-an-oid", branch: "b", observedCanonical: { generation: 0 } }),
    /base_sha/
  );
  assert.ok(lease.validateCanonicalRecord({ schema: "wrong" }).length > 0);
});

test("attempt id is deterministic per domain transaction and differs across domains", () => {
  const first = lease.deriveAttemptId("domain-alpha-1", "tx-1");
  assert.equal(first, lease.deriveAttemptId("domain-alpha-1", "tx-1"));
  assert.notEqual(first, lease.deriveAttemptId("domain-beta-2", "tx-1"));
  assert.match(first, /^[0-9a-f]{32}$/);
});

test("generation token round-trips and refuses malformed tokens", () => {
  const oid = "b".repeat(40);
  const token = lease.formatGenerationToken(TICKET, 3, oid);
  assert.deepEqual(lease.parseGenerationToken(token), { ticket: TICKET, generation: 3, oid });
  assert.throws(() => lease.formatGenerationToken(TICKET, -1, oid), /non-negative/);
  assert.throws(() => lease.parseGenerationToken(`${TICKET}@03:${oid}`), /expected/);
  assert.throws(() => lease.formatGenerationToken(TICKET, 1, "short"), /full object id/);
});

test("no namespace root is supplied by default; a malformed root is refused", () => {
  for (const root of [undefined, "", "refs/heads/", "heads/state/", "refs/x/../y/", "refs/x//y/"]) {
    assert.throws(() => lease.assertNamespaceRoot(root), /namespace root|refs\/ path/, `root ${JSON.stringify(root)}`);
  }
  assert.throws(() => lease.attemptRef(undefined, TICKET, "d", "a"), /no namespace root/);
});

test("a ref outside the namespace, or a non-plain ref, is refused", () => {
  assert.throws(() => lease.assertRefInNamespace("refs/heads/main", ROOT), /outside the coordination namespace/);
  assert.throws(() => lease.assertRefInNamespace(`${ROOT}x/../main`, ROOT), /plain ref name/);
  assert.throws(() => lease.assertRefInNamespace(`${ROOT}x.lock`, ROOT), /plain ref name/);
  assert.equal(lease.canonicalRef(ROOT, TICKET), `${ROOT}canonical/${TICKET}`);
});

test("lease argv: create-only names an empty expected value; advance names the exact oid; no force refspec", () => {
  const ref = `${ROOT}canonical/${TICKET}`;
  const oid = "c".repeat(40);
  const next = "d".repeat(40);
  assert.deepEqual(
    lease.buildLeasedPushArgv({ remote: "origin", ref, root: ROOT, expectedOid: null, newOid: oid }),
    ["push", "--porcelain", `--force-with-lease=${ref}:`, "origin", `${oid}:${ref}`]
  );
  assert.deepEqual(
    lease.buildLeasedPushArgv({ remote: "origin", ref, root: ROOT, expectedOid: oid, newOid: next }),
    ["push", "--porcelain", `--force-with-lease=${ref}:${oid}`, "origin", `${next}:${ref}`]
  );
  assert.throws(() => lease.buildLeasedPushArgv({ remote: "origin", ref, root: ROOT, expectedOid: "main", newOid: next }), /explicit full object id/);
  assert.throws(() => lease.buildLeasedPushArgv({ remote: "origin", ref, root: ROOT, expectedOid: oid, newOid: oid }), /no-op/);
  assert.throws(() => lease.buildLeasedPushArgv({ remote: "-x", ref, root: ROOT, expectedOid: null, newOid: next }), /remote name/);
});

test("the COORD-691 governed-push guard still refuses every force form for the integration branch", () => {
  assert.throws(
    () => assertGovernedPushArgv(["push", "origin", "--force-with-lease=refs/heads/dev:abc", "HEAD:refs/heads/dev"]),
    /force|forc/i
  );
  assert.throws(() => assertGovernedPushArgv(["push", "origin", "+HEAD:refs/heads/dev"]), /forcing refspec/);
});

test("create-only race: the second domain is refused and names the holder", () => {
  const { remote, a, b } = twoDomains();
  const canonical = `${ROOT}canonical/${TICKET}`;
  const oidA = commit(a, "from-a");
  const oidB = commit(b, "from-b");
  assert.equal(
    lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: null, newOid: oidA }).status,
    "published"
  );
  const second = lease.publishWithLease(b, { remote: "origin", ref: canonical, root: ROOT, expectedOid: null, newOid: oidB });
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "lease-mismatch");
  assert.equal(second.holder, oidA);
  assert.deepEqual(remoteRefs(remote, canonical), [[oidA, canonical]]);
});

test("two domains publish attempts for one ticket concurrently; both are allowed and visible", () => {
  const { remote, a, b } = twoDomains();
  const attemptA = lease.attemptRef(ROOT, TICKET, "domain-alpha-1", lease.deriveAttemptId("domain-alpha-1", "tx-1"));
  const attemptB = lease.attemptRef(ROOT, TICKET, "domain-beta-2", lease.deriveAttemptId("domain-beta-2", "tx-9"));
  const oidA = commit(a, "attempt-a");
  const oidB = commit(b, "attempt-b");
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: attemptA, root: ROOT, expectedOid: null, newOid: oidA }).status, "published");
  assert.equal(lease.publishWithLease(b, { remote: "origin", ref: attemptB, root: ROOT, expectedOid: null, newOid: oidB }).status, "published");
  const visible = remoteRefs(remote, `${ROOT}attempts/${TICKET}/`).map((entry) => entry[1]).sort();
  assert.deepEqual(visible, [attemptA, attemptB].sort());
});

test("stale-holder canonical publish is refused by the fence; the current holder's value stands", () => {
  const { remote, a, b } = twoDomains();
  const canonical = `${ROOT}canonical/${TICKET}`;
  const g0 = gitFixture(a, ["rev-parse", "HEAD"]);
  const g1 = commit(a, "generation-1");
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: null, newOid: g0 }).status, "published");
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g0, newOid: g1 }).status, "published");
  // Domain B decided from generation 0 and is now stale.
  gitFixture(b, ["fetch", "-q", "origin"]);
  const staleNext = commit(b, "stale-decision");
  const refused = lease.publishWithLease(b, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g0, newOid: staleNext });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "lease-mismatch");
  assert.equal(refused.holder, g1);
  assert.deepEqual(remoteRefs(remote, canonical), [[g1, canonical]]);
});

test("an advance that does not descend from the lease value is refused before any push", () => {
  const { remote, a, b } = twoDomains();
  const canonical = `${ROOT}canonical/${TICKET}`;
  const g0 = gitFixture(a, ["rev-parse", "HEAD"]);
  lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: null, newOid: g0 });
  gitFixture(b, ["checkout", "-q", "--orphan", "unrelated"]);
  const unrelated = commit(b, "unrelated-history");
  assert.throws(
    () => lease.publishWithLease(b, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g0, newOid: unrelated }),
    /fast-forward only/
  );
  assert.deepEqual(remoteRefs(remote, canonical), [[g0, canonical]]);
});

test("crash windows: an unknown publish result is classified against the remote value", () => {
  const { remote, a } = twoDomains();
  const canonical = `${ROOT}canonical/${TICKET}`;
  const g0 = gitFixture(a, ["rev-parse", "HEAD"]);
  const g1 = commit(a, "window-next");
  // Window: the push applied but the result was lost (A2/C2, applied).
  lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: null, newOid: g0 });
  lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g0, newOid: g1 });
  assert.equal(lease.classifyUnknownPublish(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g0, newOid: g1 }).window, "published");
  // Window: the push was never applied (A2/C2, unapplied). Recovery is a retry that succeeds once.
  const g2 = commit(a, "window-unapplied");
  assert.equal(lease.classifyUnknownPublish(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g1, newOid: g2 }).window, "unapplied");
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g1, newOid: g2 }).status, "published");
  // Window: a foreign advance happened; recovery must refuse and report, never retry.
  const other = commit(a, "foreign");
  assert.equal(lease.classifyUnknownPublish(a, { remote: "origin", ref: canonical, root: ROOT, expectedOid: g1, newOid: other }).window, "foreign");
});


test("attempt and canonical validation reject malformed identity and selected-state fields", () => {
  assert.throws(() => lease.attemptRef(ROOT, "bad-ticket", "domain-alpha-1", "attempt-1"), /ticket id/);
  assert.throws(() => lease.canonicalRef(ROOT, "bad-ticket"), /ticket id/);
  assert.throws(() => lease.deriveAttemptId("", "tx-1"), /without a domain id and a journal transaction id/);
  assert.throws(() => lease.deriveAttemptId("domain-alpha-1", ""), /without a domain id and a journal transaction id/);
  const valid = lease.makeAttemptRecord({ ticket: TICKET, agent: { handle: "agent-a" }, domainId: "domain-alpha-1",
    journalTxId: "tx-1", baseSha: "a".repeat(40), branch: "agent/agent-a", observedCanonical: { generation: 0 } });
  assert.deepEqual(lease.validateAttemptRecord({ ...valid, observed_canonical: {} }),
    ["observed_canonical.generation must be an integer"]);
  assert.deepEqual(lease.validateCanonicalRecord(null), ["canonical record must be an object"]);
  assert.ok(lease.validateCanonicalRecord({ schema: lease.CANONICAL_SCHEMA, ticket: TICKET, generation: 0,
    status: "active", owner: "agent-a", selected_attempt: "not-an-attempt" }).includes("selected_attempt must be null or an attempt id"));
});

test("an absent canonical ref is a known CAS value, not a remote read error", (t) => {
  const { a, remote } = twoDomains(t);
  const canonical = lease.canonicalRef(ROOT, TICKET);
  assert.equal(lease.readRemoteRef(a, "origin", canonical), null);
  assert.equal(remoteRefs(remote, canonical).length, 0);
});

test("a ref advanced by a concurrent local Git writer between lease check and push is reported as lost-race", (t) => {
  const { remote, a, b } = twoDomains(t);
  const canonical = lease.canonicalRef(ROOT, TICKET);
  const expectedOid = gitFixture(a, ["rev-parse", "HEAD"]);
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT,
    expectedOid: null, newOid: expectedOid }).status, "published");
  const proposedOid = commit(a, "lease-proposal");
  const winningOid = commit(b, "concurrent-winner");
  const hookPath = path.join(a, ".git", "hooks", "pre-push");
  const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const localGitEnvNames = gitFixture(a, ["rev-parse", "--local-env-vars"]).split(/\r?\n/).filter(Boolean);
  const unsetLocalGitEnv = `for name in ${localGitEnvNames.map(shellQuote).join(" ")}; do unset "$name"; done`;
  fs.writeFileSync(hookPath, [
    "#!/bin/sh",
    "set -eu",
    unsetLocalGitEnv,
    `git -C ${shellQuote(b)} push -q origin ${shellQuote(`HEAD:${canonical}`)}`,
    "",
  ].join("\n"));
  fs.chmodSync(hookPath, 0o755);

  const result = lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT,
    expectedOid, newOid: proposedOid });
  assert.deepEqual(result, { status: "refused", reason: "lost-race", holder: winningOid });
  assert.deepEqual(remoteRefs(remote, canonical), [[winningOid, canonical]], "the competing writer remains canonical");
});

test("a pre-push failure with the expected remote oid unchanged is reported as an operational error", (t) => {
  const { remote, a } = twoDomains(t);
  const canonical = lease.canonicalRef(ROOT, TICKET);
  const expectedOid = gitFixture(a, ["rev-parse", "HEAD"]);
  assert.equal(lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT,
    expectedOid: null, newOid: expectedOid }).status, "published");
  const proposedOid = commit(a, "lease-proposal-error");
  const hookPath = path.join(a, ".git", "hooks", "pre-push");
  fs.writeFileSync(hookPath, ["#!/bin/sh", "echo 'fixture pre-push refusal' >&2", "exit 1", ""].join("\n"));
  fs.chmodSync(hookPath, 0o755);

  const result = lease.publishWithLease(a, { remote: "origin", ref: canonical, root: ROOT,
    expectedOid, newOid: proposedOid });
  assert.equal(result.status, "error");
  assert.match(result.stderr, /fixture pre-push refusal/);
  assert.deepEqual(remoteRefs(remote, canonical), [[expectedOid, canonical]], "failed local hook preserves the exact current lease value");
});

test("lease publication fails closed when Git cannot report the ref or writes rejection only to stdout", (t) => {
  const { base, remote, a, root } = twoDomains(t);
  const ref = lease.canonicalRef(ROOT, TICKET);
  const newOid = commit(a, "next");
  const options = { remote: "origin", ref, root: ROOT, expectedOid: root, newOid };
  assert.equal(lease.publishWithLease(a, { ...options, expectedOid: null, newOid: root }).status, "published");
  assert.throws(() => lease.publishWithLease(a, { ...options, newOid: "HEAD" }), /publish names an explicit full object id/);

  assert.throws(() => lease.publishWithLease(a, { ...options, remote: "missing-fixture-remote" }),
    /Could not read .*missing-fixture-remote/);

  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
case "$1" in
  ls-remote) if [ -f "$0.fail-read" ]; then exit 1; fi ;;
  push) exec "$COORD_LEASE_TEST_REAL_GIT" "$@" 2>/dev/null ;;
esac
exec "$COORD_LEASE_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGit = process.env.COORD_LEASE_TEST_REAL_GIT;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  process.env.COORD_LEASE_TEST_REAL_GIT = gitPath.stdout.trim();
  try {
    const marker = path.join(bin, "git.fail-read");
    fs.writeFileSync(marker, "");
    assert.throws(() => lease.publishWithLease(a, options), /ls-remote failed/);
    assert.deepEqual(remoteRefs(remote, ref), [[root, ref]]);
    fs.unlinkSync(marker);
    const rejected = lease.publishWithLease(a, options);
    assert.equal(rejected.status, "error");
    assert.match(rejected.stderr, /\[remote rejected\].*pre-receive hook declined/);
    assert.deepEqual(remoteRefs(remote, ref), [[root, ref]]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGit === undefined) delete process.env.COORD_LEASE_TEST_REAL_GIT;
    else process.env.COORD_LEASE_TEST_REAL_GIT = originalGit;
  }
});
