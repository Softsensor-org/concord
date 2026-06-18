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
