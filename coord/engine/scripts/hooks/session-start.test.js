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

// COORD-872: the hook moved from coord/scripts/hooks to coord/engine/scripts/hooks,
// so its runtime directory is now resolved three levels up instead of two. The
// registry must still be the one coord/.runtime file every governance reader
// uses. main() is driven in-process with fs intercepted at the registry and
// env-file paths only, so the test never writes the real coord/.runtime.
test("COORD-872: main() still reads and writes the coord/.runtime session registry after the engine move", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { main } = require("./session-start.js");
  const coordRoot = path.resolve(__dirname, "..", "..", "..");
  assert.equal(path.basename(coordRoot), "coord");
  const runtimeDir = path.join(coordRoot, ".runtime");
  const registryPath = path.join(runtimeDir, "session-instances.json");
  const envFile = path.join(require("node:os").tmpdir(), `coord-872-session-start-${process.pid}.env`);

  const original = {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
  };
  const reads = [];
  const writes = [];
  const mkdirs = [];
  const appends = [];
  const prior = { [SID]: { instance_id: "live-instance-872", transcript_path: "/prior.jsonl" } };
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (file === 0) return JSON.stringify({ session_id: SID, transcript_path: "/t.jsonl", source: "compact" });
    if (file === registryPath) { reads.push(file); return JSON.stringify(prior); }
    return original.readFileSync.call(fs, file, ...rest);
  });
  t.mock.method(fs, "mkdirSync", (dir, ...rest) => {
    if (dir === runtimeDir) { mkdirs.push(dir); return undefined; }
    return original.mkdirSync.call(fs, dir, ...rest);
  });
  t.mock.method(fs, "writeFileSync", (file, data, ...rest) => {
    if (file === registryPath) { writes.push([file, data]); return undefined; }
    return original.writeFileSync.call(fs, file, data, ...rest);
  });
  t.mock.method(fs, "appendFileSync", (file, data, ...rest) => {
    if (file === envFile) { appends.push(data); return undefined; }
    return original.appendFileSync.call(fs, file, data, ...rest);
  });
  const savedEnvFile = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = envFile;
  t.after(() => {
    if (savedEnvFile === undefined) delete process.env.CLAUDE_ENV_FILE;
    else process.env.CLAUDE_ENV_FILE = savedEnvFile;
  });

  main();

  assert.deepEqual(reads, [registryPath], "the prior registry is read from coord/.runtime");
  assert.deepEqual(mkdirs, [runtimeDir], "coord/.runtime is the directory created");
  assert.equal(writes.length, 1, "the registry is written exactly once");
  assert.equal(writes[0][0], registryPath);
  const written = JSON.parse(writes[0][1]);
  assert.equal(written[SID].instance_id, "live-instance-872", "compaction preserved the instance read from that registry");
  assert.equal(written[SID].last_source, "compact");
  assert.equal(appends.length, 1);
  assert.match(appends[0], /^COORD_INSTANCE_ID=live-instance-872$/m);
  assert.match(appends[0], new RegExp(`^CLAUDE_SESSION_ID=${SID}$`, "m"));
});
