const test = require("node:test");
const assert = require("node:assert/strict");
const id = require("./identity-v2.js");

const TTL = 900_000; // 15m
const T0 = Date.parse("2026-05-19T12:00:00.000Z");

function ident(instanceId, sid = "sess-1") {
  return {
    provider: "claude-code",
    providerSessionId: sid,
    instanceId,
    transcriptPath: "/t.jsonl",
    present: true,
  };
}
const opts = { ttlMs: TTL };

test("missing durable identity fails closed with an actionable message", () => {
  const { decision } = id.assertCanMutate(
    id.emptyRegistry(),
    { present: false },
    { owner: "claudea11", ticketOwner: "claudea11" },
    T0
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, "no-identity");
  assert.match(decision.message, /explicit-claim-only/);
  assert.match(decision.message, /never inferred/);
});

test("one live instance runs repeated mutations without reclaiming", () => {
  let reg = id.emptyRegistry();
  const I = ident("inst-A");
  for (let k = 0; k < 5; k++) {
    const now = T0 + k * 60_000; // 1-min apart, all within TTL
    const r = id.assertCanMutate(
      reg,
      I,
      { owner: "claudea11", ticketOwner: "claudea11", ttlMs: TTL },
      now
    );
    reg = r.registry;
    assert.equal(r.decision.allowed, true, `call ${k}`);
    assert.ok(["acquired", "held"].includes(r.decision.action));
  }
});

test("two fresh instances for same owner fail closed (split-brain)", () => {
  let reg = id.emptyRegistry();
  reg = id.registerAndAcquire(reg, ident("inst-A", "sessA"), "claudea11", opts, T0).registry;
  // Different provider session, SAME owner, both fresh -> split-brain.
  const r = id.assertCanMutate(
    reg,
    ident("inst-B", "sessB"),
    { owner: "claudea11", ticketOwner: "claudea11", ttlMs: TTL },
    T0 + 30_000
  );
  assert.equal(r.decision.allowed, false);
  assert.equal(r.decision.action, "split-brain");
  assert.match(r.decision.message, /--handoff/);
});

test("one fresh + one stale instance succeeds (stale reaped, never blocks)", () => {
  let reg = id.emptyRegistry();
  reg = id.registerAndAcquire(reg, ident("inst-OLD", "sessOld"), "claudea11", opts, T0).registry;
  // inst-OLD goes stale; inst-NEW arrives well past TTL.
  const r = id.assertCanMutate(
    reg,
    ident("inst-NEW", "sessNew"),
    { owner: "claudea11", ticketOwner: "claudea11", ttlMs: TTL },
    T0 + TTL + 60_000
  );
  assert.equal(r.decision.allowed, true);
  assert.equal(r.decision.action, "acquired");
  const old = r.registry.instances.find((i) => i.instance_id === "inst-OLD");
  assert.equal(old.status, "ended");
  assert.equal(old.ended_reason, "stale-ttl");
});

test("crash without SessionEnd: same owner recovers after TTL with no handoff", () => {
  let reg = id.emptyRegistry();
  reg = id.registerAndAcquire(reg, ident("inst-CRASH"), "claudea11", opts, T0).registry;
  // No release/SessionEnd; restart 16m later (just past TTL).
  const r = id.registerAndAcquire(
    reg,
    ident("inst-RESTART"),
    "claudea11",
    opts,
    T0 + TTL + 1000
  );
  assert.equal(r.decision.allowed, true);
  assert.equal(r.decision.action, "acquired");
});

test("same-owner --handoff transfers lease, revokes prior, prior fails closed next", () => {
  let reg = id.emptyRegistry();
  reg = id.registerAndAcquire(reg, ident("inst-OLD"), "claudea11", opts, T0).registry;
  // Fast restart INSIDE ttl -> would be split-brain without --handoff.
  const ho = id.registerAndAcquire(
    reg,
    ident("inst-NEW"),
    "claudea11",
    { ttlMs: TTL, handoff: true, reason: "crash + 2m restart" },
    T0 + 120_000
  );
  reg = ho.registry;
  assert.equal(ho.decision.allowed, true);
  assert.equal(ho.decision.action, "handoff");
  assert.equal(ho.decision.handoff.from_instance, "inst-OLD");
  assert.equal(ho.decision.handoff.to_instance, "inst-NEW");
  const old = reg.instances.find((i) => i.instance_id === "inst-OLD");
  assert.equal(old.status, "revoked");
  assert.equal(old.revoked_to, "inst-NEW");

  // The revoked old terminal tries to mutate again -> fails closed, explicit.
  const blocked = id.assertCanMutate(
    reg,
    ident("inst-OLD"),
    { owner: "claudea11", ticketOwner: "claudea11", ttlMs: TTL },
    T0 + 180_000
  );
  assert.equal(blocked.decision.allowed, false);
  assert.equal(blocked.decision.action, "revoked");
  assert.match(blocked.decision.message, /revoked|handed off/);
});

test("--handoff refuses to displace a DIFFERENT owner (that path is admin-override)", () => {
  let reg = id.emptyRegistry();
  reg = id.registerAndAcquire(reg, ident("inst-X"), "claudea11", opts, T0).registry;
  // claudea22 trying to --handoff claudea11's lease: handoff is same-owner
  // only; registerAndAcquire is per-owner so claudea22 simply acquires its
  // OWN (absent) lease — it never touches claudea11's. The cross-owner
  // block happens at the ticket-owner layer:
  const r = id.assertCanMutate(
    reg,
    ident("inst-Y"),
    { owner: "claudea22", ticketOwner: "claudea11", ttlMs: TTL },
    T0 + 10_000
  );
  assert.equal(r.decision.allowed, false);
  assert.equal(r.decision.action, "foreign-owner");
  assert.match(r.decision.message, /--human-admin-override/);
});

test("foreign owner allowed only with --human-admin-override (reason recorded)", () => {
  let reg = id.emptyRegistry();
  const r = id.assertCanMutate(
    reg,
    ident("inst-Z"),
    {
      owner: "claudea22",
      ticketOwner: "claudea11",
      humanAdminOverride: "reassigning abandoned ticket per ops",
      ttlMs: TTL,
    },
    T0
  );
  assert.equal(r.decision.allowed, true);
  assert.equal(r.decision.action, "foreign-admin-override");
  assert.equal(r.decision.override_reason, "reassigning abandoned ticket per ops");
});

test("unowned ticket is not mutable unless allowUnownedStart", () => {
  const reg = id.emptyRegistry();
  const blocked = id.assertCanMutate(
    reg,
    ident("inst-S"),
    { owner: "claudea11", ticketOwner: null, ttlMs: TTL },
    T0
  );
  assert.equal(blocked.decision.allowed, false);
  assert.equal(blocked.decision.action, "unowned-ticket");

  const ok = id.assertCanMutate(
    id.emptyRegistry(),
    ident("inst-S"),
    { owner: "claudea11", ticketOwner: null, allowUnownedStart: true, ttlMs: TTL },
    T0
  );
  assert.equal(ok.decision.allowed, true);
});

test("readEnvIdentity only trusts the durable channel (no inference)", () => {
  assert.equal(id.readEnvIdentity({ CLAUDECODE: "1" }).present, false);
  const ok = id.readEnvIdentity({
    COORD_PROVIDER: "claude-code",
    COORD_INSTANCE_ID: "uuid-1",
    COORD_PROVIDER_SESSION_ID: "sess-1",
  });
  assert.equal(ok.present, true);
  assert.equal(ok.instanceId, "uuid-1");
});

// --- COORD-812: the registry reader fails closed on anything but first use ---
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withRuntimeDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idv2-reader-"));
  try {
    return body(dir, id.registryPath(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedRegistryFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function readFailure(dir) {
  try {
    id.readRegistry(dir);
  } catch (error) {
    return error;
  }
  return null;
}

test("COORD-812 only a genuinely absent registry reads as the empty first-use state", () => {
  withRuntimeDir((dir, file) => {
    assert.deepEqual(id.readRegistry(dir), id.emptyRegistry(), "no identity/ directory yet");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assert.deepEqual(id.readRegistry(dir), id.emptyRegistry(), "identity/ exists, registry file does not");
    assert.equal(fs.existsSync(file), false, "reading never creates the registry");
  });
});

test("COORD-812 a valid registry round-trips and a stale holder is still taken without handoff", () => {
  withRuntimeDir((dir) => {
    const held = id.registerAndAcquire(id.emptyRegistry(), ident("A"), "claudea11", opts, T0).registry;
    id.writeRegistry(dir, held);
    const onDisk = id.readRegistry(dir);
    assert.deepEqual(onDisk, held);
    assert.equal(id.registerAndAcquire(onDisk, ident("B"), "claudea11", opts, T0 + 1000).decision.action, "split-brain");
    const afterTtl = id.registerAndAcquire(id.readRegistry(dir), ident("B"), "claudea11", opts, T0 + TTL + 1);
    assert.equal(afterTtl.decision.action, "acquired", "TTL expiry, read from disk, is the only silent takeover");
  });
});

for (const [label, bytes] of [
  ["zero-byte file", ""],
  ["truncated JSON", '{ "version": 1, "instances": ['],
  ["non-JSON bytes", "{ malformed registry\n"],
]) {
  test(`COORD-812 ${label} is a corrupt registry, never an empty one`, () => {
    withRuntimeDir((dir, file) => {
      seedRegistryFile(file, bytes);
      const error = readFailure(dir);
      assert.ok(error instanceof id.OwnerLeaseRegistryError, "typed error, not an empty registry");
      assert.equal(error.code, "OWNER_LEASE_REGISTRY_CORRUPT");
      assert.equal(error.registryPath, file);
      assert.ok(error.message.includes(file), "names the artifact");
      assert.match(error.message, /left untouched/);
      assert.match(error.message, /do not delete, truncate or re-create/i);
      assert.match(error.message, /human admin/i);
      assert.equal(fs.readFileSync(file, "utf8"), bytes, "the corrupt artifact is preserved");
    });
  });
}

for (const [label, value] of [
  ["JSON null", null],
  ["an array", []],
  ["a string", "registry"],
  ["an unknown version", { version: 2, instances: [], leases: {} }],
  ["a missing version", { instances: [], leases: {} }],
  ["missing instances", { version: 1, leases: {} }],
  ["non-array instances", { version: 1, instances: {}, leases: {} }],
  ["a non-object instance", { version: 1, instances: ["A"], leases: {} }],
  ["missing leases", { version: 1, instances: [] }],
  ["array leases", { version: 1, instances: [], leases: [] }],
  ["a non-object lease", { version: 1, instances: [], leases: { claudea11: "A" } }],
]) {
  test(`COORD-812 ${label} is an unsupported registry structure`, () => {
    withRuntimeDir((dir, file) => {
      const bytes = JSON.stringify(value);
      seedRegistryFile(file, bytes);
      const error = readFailure(dir);
      assert.ok(error instanceof id.OwnerLeaseRegistryError);
      assert.equal(error.code, "OWNER_LEASE_REGISTRY_UNSUPPORTED");
      assert.equal(fs.readFileSync(file, "utf8"), bytes);
    });
  });
}

test("COORD-812 a registry path that is not a readable file is unreadable, not absent", () => {
  withRuntimeDir((dir, file) => {
    fs.mkdirSync(file, { recursive: true }); // a directory where the file belongs
    const error = readFailure(dir);
    assert.ok(error instanceof id.OwnerLeaseRegistryError);
    assert.equal(error.code, "OWNER_LEASE_REGISTRY_UNREADABLE");
    assert.equal(error.cause.code, "EISDIR");
    assert.equal(fs.statSync(file).isDirectory(), true);
  });
  withRuntimeDir((dir, file) => {
    fs.writeFileSync(path.dirname(file), "not a directory"); // identity is a file
    const error = readFailure(dir);
    assert.ok(error instanceof id.OwnerLeaseRegistryError);
    assert.equal(error.code, "OWNER_LEASE_REGISTRY_UNREADABLE");
    assert.equal(error.cause.code, "ENOTDIR");
  });
});

test("COORD-812 a read failure without an error code is still unreadable and names what it can", () => {
  for (const [thrown, detail] of [
    [new Error("injected codeless failure"), "injected codeless failure"],
    [new Error(""), "unknown error"],
  ]) {
    withRuntimeDir((dir, file) => {
      id.writeRegistry(dir, id.emptyRegistry());
      const originalRead = fs.readFileSync;
      fs.readFileSync = function (target, ...args) {
        if (String(target) === file) throw thrown;
        return originalRead.call(this, target, ...args);
      };
      let error;
      try {
        error = readFailure(dir);
      } finally {
        fs.readFileSync = originalRead;
      }
      assert.ok(error instanceof id.OwnerLeaseRegistryError);
      assert.equal(error.code, "OWNER_LEASE_REGISTRY_UNREADABLE");
      assert.equal(error.cause, thrown);
      assert.ok(error.message.includes(`could not be read (${detail})`), error.message);
    });
  }
});

for (const code of ["EACCES", "EIO", "EMFILE"]) {
  test(`COORD-812 an injected ${code} read failure is unreadable, never empty`, () => {
    withRuntimeDir((dir, file) => {
      const held = id.registerAndAcquire(id.emptyRegistry(), ident("A"), "claudea11", opts, T0).registry;
      id.writeRegistry(dir, held);
      const bytes = fs.readFileSync(file, "utf8");
      const originalRead = fs.readFileSync;
      fs.readFileSync = function (target, ...args) {
        if (String(target) === file) {
          throw Object.assign(new Error(`${code}: injected read failure`), { code });
        }
        return originalRead.call(this, target, ...args);
      };
      let error;
      try {
        error = readFailure(dir);
      } finally {
        fs.readFileSync = originalRead;
      }
      assert.ok(error instanceof id.OwnerLeaseRegistryError);
      assert.equal(error.code, "OWNER_LEASE_REGISTRY_UNREADABLE");
      assert.equal(error.cause.code, code);
      assert.equal(fs.readFileSync(file, "utf8"), bytes);
      assert.deepEqual(id.readRegistry(dir), held, "the registry is intact once the fault clears");
    });
  });
}

// --- COORD-824: governed, human-authorised recovery of an untrusted registry ---
const crypto = require("node:crypto");

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const ACTOR = { handle: "claudea11", session_id: "a11-session" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const recoveryDir = (dir) => path.join(dir, "identity", "recovery");

function seedCorrupt(dir, bytes) {
  const file = id.registryPath(dir);
  seedRegistryFile(file, bytes);
  return { file, bytes: Buffer.from(bytes), hash: sha(Buffer.from(bytes)) };
}

function recovery(dir, request, hooks = {}) {
  const journal = [];
  const run = () => id.recoverRegistry(dir, { reason: "restore known-good registry", actor: ACTOR, ...request },
    { now: NOW, journal: (event) => journal.push(event), authorize: () => ({ mode: "fixture-authorized" }), ...hooks });
  return { run, journal };
}

function assertRefused(dir, corrupt, request, pattern, hooks) {
  const { run, journal } = recovery(dir, request, hooks);
  assert.throws(run, pattern);
  assert.deepEqual(fs.readFileSync(corrupt.file), corrupt.bytes, "the corrupt registry is untouched");
  assert.equal(fs.existsSync(recoveryDir(dir)), false, "a refused request leaves no evidence directory");
  assert.equal(journal.length, 0, "nothing is journaled");
}

function writeReplacement(dir, value) {
  const file = path.join(dir, "known-good.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  return file;
}

test("COORD-824 the COORD-812 refusal names the governed recovery verb", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const error = readFailure(dir);
    assert.equal(error.problem, "is corrupt (not valid JSON)");
    assert.ok(error.message.includes(`${id.RECOVERY_VERB} --registry ${corrupt.file} --expect-sha256`), error.message);
    assert.match(error.message, /--restore-from <known-good copy> \| --approve-empty/);
    assert.match(error.message, /do not delete, truncate or re-create/i);
  });
});

test("COORD-824 recovery refuses without a complete human-admin authorization", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const base = { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true };
    assertRefused(dir, corrupt, { ...base, reason: undefined }, /requires --human-admin-override/);
    assertRefused(dir, corrupt, { ...base, reason: "   " }, /human-admin authority act/);
    assertRefused(dir, corrupt, { ...base, registry: undefined }, /requires --registry naming the exact registry file/);
    assertRefused(dir, corrupt, { ...base, registry: path.join(dir, "other.json") }, /exact registry file/);
    assertRefused(dir, corrupt, { ...base, approveEmpty: false }, /exactly one replacement/);
    assertRefused(dir, corrupt, { ...base, restoreFrom: path.join(dir, "x.json") }, /exactly one replacement/);
    assert.throws(() => id.recoverRegistry(dir, { ...base, reason: "valid reason", actor: ACTOR }, {
      now: NOW, journal: () => {},
    }), /requires an explicit signed-authorization callback/);
    assert.deepEqual(fs.readFileSync(corrupt.file), corrupt.bytes, "a missing verifier leaves corrupt bytes untouched");
    for (const authorization of [null, "unverified"]) {
      assert.throws(() => id.recoverRegistry(dir, { ...base, reason: "valid reason", actor: ACTOR }, {
        now: NOW,
        authorize: () => authorization,
        journal: () => assert.fail("unverified recovery must not be journaled"),
      }), /authorization did not return verified evidence/);
      assert.deepEqual(fs.readFileSync(corrupt.file), corrupt.bytes);
    }
    assert.equal(fs.existsSync(recoveryDir(dir)), false, "a missing verifier creates no evidence directory");
  });
});

test("COORD-824 recovery refuses a stale or missing content hash and reports the current one", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const base = { registry: corrupt.file, approveEmpty: true };
    assertRefused(dir, corrupt, { ...base, expectSha256: sha("{ different bytes") },
      new RegExp(`is now ${corrupt.hash}`));
    assertRefused(dir, corrupt, base, /--expect-sha256 must be the sha256/);
    // The hash is the authorization, so its case is not.
    const { run } = recovery(dir, { ...base, expectSha256: corrupt.hash.toUpperCase() });
    assert.equal(run().corrupt_sha256, corrupt.hash);
  });
});

test("COORD-824 recovery refuses a registry that is absent, unreadable as bytes, or valid", () => {
  withRuntimeDir((dir) => {
    const file = id.registryPath(dir);
    const request = { registry: file, expectSha256: sha(""), approveEmpty: true };
    assert.throws(recovery(dir, request).run, /\(ENOENT\).*first use, not corruption/);
    assert.equal(fs.existsSync(file), false, "recovery never creates a missing registry");
    fs.mkdirSync(file, { recursive: true });
    assert.throws(recovery(dir, request).run, (error) => /\(EISDIR\)/.test(error.message) && !/first use/.test(error.message));
    fs.rmSync(file, { recursive: true });
    id.writeRegistry(dir, id.emptyRegistry());
    const valid = fs.readFileSync(file);
    assert.throws(recovery(dir, { ...request, expectSha256: sha(valid) }).run, /is valid, so there is nothing to recover/);
    assert.deepEqual(fs.readFileSync(file), valid);
    assert.equal(fs.existsSync(recoveryDir(dir)), false);
  });
});

test("COORD-824 recovery refuses a replacement the strict reader would refuse", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const base = { registry: corrupt.file, expectSha256: corrupt.hash };
    assertRefused(dir, corrupt, { ...base, restoreFrom: path.join(dir, "missing.json") },
      /could not be read \(ENOENT\); nothing was changed/);
    assertRefused(dir, corrupt, { ...base, restoreFrom: writeReplacement(dir, "{ also malformed") },
      /OWNER_LEASE_REGISTRY_CORRUPT: is corrupt \(not valid JSON\)/);
    assertRefused(dir, corrupt, { ...base, restoreFrom: writeReplacement(dir, { version: 1, instances: [] }) },
      /OWNER_LEASE_REGISTRY_UNSUPPORTED: has no leases object.*was not written/);
  });
});

test("COORD-824 restoring a known-good copy preserves the corrupt bytes and lists every lease it drops or changes", () => {
  withRuntimeDir((dir) => {
    const before = {
      version: 2, // unsupported: refused by every consumer, yet its leases are still visible
      instances: [],
      leases: {
        kept: { instance_id: "K", acquired_at: "t0" },
        moved: { instance_id: "A", acquired_at: "t0" },
        reacquired: { instance_id: "R", acquired_at: "t0" },
        gone: { instance_id: "G", acquired_at: "t0" },
        garbled: "not-an-object",
        nulled: null,
      },
    };
    const corrupt = seedCorrupt(dir, JSON.stringify(before));
    const restored = {
      version: 1,
      instances: [],
      leases: {
        kept: { instance_id: "K", acquired_at: "t0" },
        moved: { instance_id: "B", acquired_at: "t0" },
        reacquired: { instance_id: "R", acquired_at: "t1" },
        fresh: { instance_id: "F", acquired_at: "t1" },
      },
    };
    const restoreFrom = writeReplacement(dir, restored);
    const replacementBytes = fs.readFileSync(restoreFrom);
    const { run, journal } = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, restoreFrom });
    const event = run();

    assert.deepEqual(fs.readFileSync(corrupt.file), replacementBytes, "the validated copy is written byte for byte");
    assert.deepEqual(id.readRegistry(dir), id.normalizeRegistry(restored));
    assert.deepEqual(fs.readFileSync(event.evidence.bytes_path), corrupt.bytes, "corrupt bytes preserved exactly");
    assert.ok(event.evidence.dir.startsWith(recoveryDir(dir)));
    const record = JSON.parse(fs.readFileSync(event.evidence.record_path, "utf8"));
    assert.equal(record.corrupt_sha256, corrupt.hash);
    assert.equal(record.corrupt_size_bytes, corrupt.bytes.length);
    assert.equal(record.corrupt_error_code, "OWNER_LEASE_REGISTRY_UNSUPPORTED");
    assert.deepEqual(record.actor, ACTOR);
    assert.equal(record.recorded_at, new Date(NOW).toISOString());
    assert.equal(record.human_admin_override_reason, "restore known-good registry");
    assert.deepEqual(record.authorization, { mode: "fixture-authorized" });
    assert.deepEqual(record.replacement, { source: restoreFrom, sha256: sha(replacementBytes) });
    assert.deepEqual(journal, [event], "exactly one journaled event, carrying the paths");
    assert.equal(event.registry_path, corrupt.file);

    const { leases } = event;
    assert.equal(leases.before_known, true);
    assert.deepEqual(leases.dropped.map((l) => l.owner), ["garbled", "gone", "nulled"]);
    assert.deepEqual(leases.dropped.find((l) => l.owner === "garbled"), { owner: "garbled", instance_id: null, acquired_at: null });
    assert.deepEqual(leases.changed.map((c) => [c.owner, c.before.instance_id, c.after.instance_id, c.after.acquired_at]),
      [["moved", "A", "B", "t0"], ["reacquired", "R", "R", "t1"]]);
    assert.deepEqual(leases.added.map((l) => l.owner), ["fresh"]);
    assert.deepEqual(leases.after.map((l) => l.owner), ["fresh", "kept", "moved", "reacquired"]);
    assert.match(leases.warning, /3 lease\(s\) dropped and 2 changed/);
    assert.deepEqual(record.leases, leases);
  });
});

test("COORD-824 an approved empty registry over unparseable bytes reports the prior leases as unknown", () => {
  withRuntimeDir((dir) => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80, 0x0a]); // not UTF-8, not JSON
    const corrupt = seedCorrupt(dir, binary);
    const event = recovery(dir, { registry: corrupt.file, expectSha256: sha(binary), approveEmpty: true }).run();
    assert.deepEqual(fs.readFileSync(event.evidence.bytes_path), binary, "byte-for-byte, not a UTF-8 round trip");
    assert.equal(event.corrupt_error_code, "OWNER_LEASE_REGISTRY_CORRUPT");
    assert.equal(event.replacement.source, "approved-empty");
    assert.deepEqual(id.readRegistry(dir), id.emptyRegistry());
    assert.equal(event.leases.before_known, false);
    assert.equal(event.leases.before, null);
    assert.deepEqual(event.leases.after, []);
    assert.match(event.leases.warning, /do not show which leases were held/);
  });
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, JSON.stringify({ version: 1, instances: "x", leases: {} }));
    const event = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true }).run();
    assert.equal(event.leases.before_known, true);
    assert.equal(event.leases.warning, null, "no lease was held, so none is lost");
  });
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "[1]");
    const event = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true }).run();
    assert.equal(event.leases.before_known, false, "JSON without a leases object does not say");
  });
});

test("COORD-824 recovery never writes over an earlier recovery's evidence", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const stamp = new Date(NOW).toISOString().replace(/[:.]/g, "-");
    const earlier = path.join(recoveryDir(dir), `${stamp}-${corrupt.hash.slice(0, 12)}`);
    fs.mkdirSync(earlier, { recursive: true });
    const { run, journal } = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true });
    const event = run();
    assert.equal(event.evidence.dir, `${earlier}-1`, "a distinct directory, not the earlier one");
    assert.deepEqual(fs.readdirSync(earlier), [], "the earlier evidence directory is untouched");
    assert.deepEqual(journal, [event]);
  });
});

test("COORD-824 two recoveries of the same bytes in the same millisecond keep separate evidence", () => {
  withRuntimeDir((dir) => {
    const dirs = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const corrupt = seedCorrupt(dir, "{ malformed");
      const event = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true }).run();
      assert.deepEqual(fs.readFileSync(event.evidence.bytes_path), corrupt.bytes);
      dirs.push(path.basename(event.evidence.dir));
    }
    const base = `${new Date(NOW).toISOString().replace(/[:.]/g, "-")}-${sha("{ malformed").slice(0, 12)}`;
    assert.deepEqual(dirs, [base, `${base}-1`, `${base}-2`]);
    assert.deepEqual(fs.readdirSync(recoveryDir(dir)).sort(), [base, `${base}-1`, `${base}-2`]);
  });
});

test("COORD-824 a replacement naming unknown holders is accepted but lists each one", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const restoreFrom = writeReplacement(dir, {
      version: 1,
      instances: [{ instance_id: "K", owner: "known" }, { instance_id: "S", owner: "stranger" }],
      leases: {
        known: { instance_id: "K", acquired_at: "t0" },
        stranger: { instance_id: "S", acquired_at: "t0" },
        dangling: { instance_id: "X", acquired_at: "t0" },
        ghost: { instance_id: "Y", acquired_at: "t0" },
      },
    });
    const { run, journal } = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, restoreFrom },
      { knownHandles: ["known", "dangling"] });
    const event = run();
    assert.deepEqual(fs.readFileSync(corrupt.file), fs.readFileSync(restoreFrom), "never blocked: the replacement is written");
    assert.deepEqual(event.unknown_holders.leases.map((l) => [l.owner, l.instance_id, l.reasons]), [
      ["dangling", "X", ["instance_not_registered"]],
      ["ghost", "Y", ["handle_not_registered", "instance_not_registered"]],
      ["stranger", "S", ["handle_not_registered"]],
    ]);
    assert.match(event.unknown_holders.warning, /^3 lease\(s\) in the replacement name a holder the engine does not know/);
    assert.deepEqual(journal[0].unknown_holders, event.unknown_holders, "journaled, not only printed");
    assert.deepEqual(JSON.parse(fs.readFileSync(event.evidence.record_path, "utf8")).unknown_holders, event.unknown_holders);
  });
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const event = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true }).run();
    assert.deepEqual(event.unknown_holders, { leases: [], warning: null }, "an empty registry names no holder");
  });
});

function withFailingRename(file, body) {
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to, ...rest) {
    if (String(to) === file) throw Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
    return originalRename.call(this, from, to, ...rest);
  };
  try {
    return body();
  } finally {
    fs.renameSync = originalRename;
  }
}

test("COORD-824 an injected write failure leaves the corrupt registry in place and its evidence kept", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const { run, journal } = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true });
    withFailingRename(corrupt.file, () => assert.throws(run, /replacement registry was not written \(EIO: injected rename failure\).*no lease changed/));
    assert.deepEqual(fs.readFileSync(corrupt.file), corrupt.bytes, "atomic: the old bytes, never a torn file");
    assert.deepEqual(fs.readdirSync(path.dirname(corrupt.file)).sort(), ["instances.json", "recovery"], "no temp file left");
    const [evidenceDir] = fs.readdirSync(recoveryDir(dir));
    assert.deepEqual(fs.readFileSync(path.join(recoveryDir(dir), evidenceDir, "instances.json.corrupt")), corrupt.bytes);
    assert.equal(journal.length, 0);
  });
});

test("COORD-824 a recovery that cannot be journaled is rolled back to the corrupt bytes", () => {
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    const journalDown = () => { throw new Error("journal append failed"); };
    const { run } = recovery(dir, { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true }, { journal: journalDown });
    assert.throws(run, /could not be journaled \(journal append failed\)\. The replacement was rolled back/);
    assert.deepEqual(fs.readFileSync(corrupt.file), corrupt.bytes);
    assert.equal(readFailure(dir).code, "OWNER_LEASE_REGISTRY_CORRUPT", "consumers still refuse");
  });
  withRuntimeDir((dir) => {
    const corrupt = seedCorrupt(dir, "{ malformed");
    let journalAttempted = false;
    const journalDown = () => {
      journalAttempted = true;
      throw new Error("journal append failed");
    };
    const request = { registry: corrupt.file, expectSha256: corrupt.hash, approveEmpty: true };
    const originalRename = fs.renameSync;
    let renames = 0;
    fs.renameSync = function (from, to, ...rest) {
      renames += 1;
      if (renames > 1) throw new Error("injected rollback failure");
      return originalRename.call(this, from, to, ...rest);
    };
    try {
      assert.throws(recovery(dir, request, { journal: journalDown }).run,
        /Rolling the replacement back ALSO failed \(injected rollback failure\).*unjournaled replacement/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(journalAttempted, true);
    assert.deepEqual(id.readRegistry(dir), id.emptyRegistry(), "the unjournaled replacement is what remains");
  });
});

test("COORD-824 diffLeases reports nothing lost when the replacement keeps every lease", () => {
  const leases = [{ owner: "a", instance_id: "A", acquired_at: "t0" }];
  assert.deepEqual(id.diffLeases(leases, leases), {
    before_known: true, before: leases, after: leases, dropped: [], changed: [], added: [], warning: null,
  });
});

// COORD-951 (2): a heartbeat more than one TTL in the future is not fresh forever. A future
// heartbeat within one TTL is fresh (symmetric skew tolerance); beyond that it is stale.
test("COORD-951 T1: a future heartbeat is fresh within one TTL and stale beyond it", () => {
  const ttlMs = 900_000;
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const at = (offsetMs) => ({ status: "active", heartbeat_at: new Date(now + offsetMs).toISOString() });
  assert.equal(id.isFresh(at(-1000), ttlMs, now), true, "a past heartbeat inside the TTL is fresh");
  assert.equal(id.isFresh(at(ttlMs - 1000), ttlMs, now), true, "TTL-1s in the future is fresh");
  assert.equal(id.isFresh(at(ttlMs + 1000), ttlMs, now), false, "TTL+1s in the future is stale");
  assert.equal(id.isFresh(at(-ttlMs - 1000), ttlMs, now), false, "a past heartbeat beyond the TTL stays stale");
  assert.equal(id.isFresh({ status: "active", heartbeat_at: "unparseable" }, ttlMs, now), false);
});
