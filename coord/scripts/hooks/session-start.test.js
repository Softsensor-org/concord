const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSessionEnv, envFileBody } = require("./session-start.js");

const SID = "sess-abc";

test("GCV-1: startup mints a fresh COORD_INSTANCE_ID", () => {
  const { env, nextRegistry } = computeSessionEnv(
    { session_id: SID, transcript_path: "/t.jsonl", source: "startup" },
    {}
  );
  assert.equal(env.COORD_PROVIDER, "claude-code");
  assert.equal(env.COORD_PROVIDER_SESSION_ID, SID);
  assert.equal(env.CLAUDE_SESSION_ID, SID);
  assert.match(env.COORD_INSTANCE_ID, /[0-9a-f-]{36}/);
  assert.equal(nextRegistry[SID].instance_id, env.COORD_INSTANCE_ID);
});

test("GCV-1: resume is a genuine new attach -> new instance id", () => {
  const prior = { [SID]: { instance_id: "old-instance" } };
  const { env } = computeSessionEnv(
    { session_id: SID, source: "resume" },
    prior
  );
  assert.notEqual(env.COORD_INSTANCE_ID, "old-instance");
});

test("GCV-1: compaction PRESERVES COORD_INSTANCE_ID (no self split-brain)", () => {
  const prior = { [SID]: { instance_id: "live-instance-1" } };
  const { env, reusedInstance } = computeSessionEnv(
    { session_id: SID, source: "compact" },
    prior
  );
  assert.equal(env.COORD_INSTANCE_ID, "live-instance-1");
  assert.equal(reusedInstance, true);
});

test("GCV-1: /clear PRESERVES COORD_INSTANCE_ID", () => {
  const prior = { [SID]: { instance_id: "live-instance-2" } };
  const { env } = computeSessionEnv({ session_id: SID, source: "clear" }, prior);
  assert.equal(env.COORD_INSTANCE_ID, "live-instance-2");
});

test("GCV-1: compaction with no prior registry still mints (cannot preserve nothing)", () => {
  const { env } = computeSessionEnv({ session_id: SID, source: "compact" }, {});
  assert.match(env.COORD_INSTANCE_ID, /[0-9a-f-]{36}/);
});

test("GCV-1: unknown source is treated as preserve (conservative)", () => {
  const prior = { [SID]: { instance_id: "keep-me" } };
  const { env } = computeSessionEnv({ session_id: SID, source: "weird" }, prior);
  assert.equal(env.COORD_INSTANCE_ID, "keep-me");
});

test("GCV-1: envFileBody emits KEY=VALUE lines and drops empties", () => {
  const body = envFileBody({ A: "1", B: "", C: "3", D: null });
  assert.equal(body, "A=1\nC=3\n");
});
