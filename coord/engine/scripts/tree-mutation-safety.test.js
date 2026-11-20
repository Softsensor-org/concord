"use strict";

// COORD-435: direct coverage for tree-mutation-safety.js — the git-tree scope
// guard that keeps a governed mutation from touching files outside its ticket
// scope. Previously exercised only via its 3 callers.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const tms = require("./tree-mutation-safety.js");

test("COORD-797: empty porcelain status has no changed paths", () => {
  assert.deepStrictEqual(tms.parsePorcelainStatusPaths(""), []);
});

test("COORD-654: own, foreign and unknown sessions change diagnostics, never refusal", () => {
  const messages = [];
  for (const [caller, lockSession, expected] of [
    ["one", "one", "own-session"],
    ["one", "two", "foreign-session"],
    [null, "one", "unknown-session"],
    ["one", null, "unknown-session"],
    ["", "", "unknown-session"],
  ]) {
    let reads = 0;
    const opts = {
      gitTry: () => ({ status: 0, stdout: " M coord/board/tasks.json\n" }),
      repoRoot: "/repo", allowedPaths: [], board: {},
      getRows: () => [{ ID: "T-1", Status: "doing", Owner: "same-handle" }],
      isDoingStatus: () => true,
      findLockForTicket: () => ({ owner: "same-handle", session_id: lockSession }),
      isStaleTicketLock: () => false,
      resolveCurrentAgentId: () => { reads += 1; return { identity: { session: { session_id: caller } } }; },
    };
    const hazard = tms.buildTreeMutationSafetyHazard(opts);
    assert.ok(hazard);
    assert.equal(reads, 1);
    const message = tms.formatTreeMutationSafetyHazard(hazard);
    assert.match(message, new RegExp(expected));
    assert.match(message, /Commit or stash.*non-derived/i);
    assert.doesNotMatch(message, /override|takeover|abandon/i);
    assert.throws(() => tms.assertNoUnsafeTreeMutation(opts), /Refusing tree-wide/);
    messages.push(message);
    assert.equal(tms.buildTreeMutationSafetyHazard({ ...opts, currentTicketId: "T-1" }), null);
    assert.equal(tms.buildTreeMutationSafetyHazard({ ...opts, isStaleTicketLock: () => true }), null);
  }
  assert.notEqual(messages[0], messages[1]);
});

test("COORD-654: unavailable identity never suppresses the conservative guard", () => {
  const hazard = tms.buildTreeMutationSafetyHazard({
    gitTry: () => ({ status: 0, stdout: " M outside.js\n" }),
    board: {}, getRows: () => [{ ID: "T-1", Status: "doing" }],
    isDoingStatus: () => true, findLockForTicket: () => ({ session_id: "one" }),
    resolveCurrentAgentId: () => { throw new Error("unclaimed"); },
  });
  assert.match(tms.formatTreeMutationSafetyHazard(hazard), /unknown-session/);
});

test("COORD-654: real lifecycle wires both diagnostic callers to read-only identity", () => {
  const names = [
    resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"),
    require.resolve("./sync-provenance.js"),
    resolveEngineModule(COORD_ROOT_DIR, "scripts/doctor-recovery.js"),
    resolveEngineModule(COORD_ROOT_DIR, "scripts/agent-commands.js"),
  ];
  const ids = names.map((name) => require.resolve(name));
  const saved = ids.map((id) => require.cache[id]);
  const savedExports = saved.map((entry) => entry?.exports);
  const captured = [];
  const identityCalls = [];
  try {
    for (const name of names.slice(1)) {
      const factory = require(name);
      require.cache[require.resolve(name)].exports = (deps) => {
        if (name === names[3]) {
          return factory({ ...deps, ensureCurrentAgentIdentity: (options) => {
            identityCalls.push(options);
            return { session: { session_id: "fixture-session" } };
          } });
        }
        captured.push(deps);
        return factory(deps);
      };
    }
    delete require.cache[ids[0]];
    require(names[0]);
    assert.equal(captured.length, 2);
    for (const deps of captured) assert.equal(deps.resolveCurrentAgentId().identity.session.session_id, "fixture-session");
    assert.deepEqual(identityCalls, [
      { allowAutoClaim: false, touchSession: false },
      { allowAutoClaim: false, touchSession: false },
    ], "real agent resolver must neither auto-claim nor touch session identity");
  } finally {
    ids.forEach((id, i) => {
      if (saved[i]) { saved[i].exports = savedExports[i]; require.cache[id] = saved[i]; }
      else delete require.cache[id];
    });
  }
});

test("COORD-654: mixed sessions retain every lock and clean paths never resolve identity", () => {
  let reads = 0;
  const options = {
    gitTry: () => ({ status: 0, stdout: " M outside.js\n" }), board: {},
    getRows: () => ["own", "foreign", "unknown"].map((ID) => ({ ID, Status: "doing" })),
    isDoingStatus: () => true,
    findLockForTicket: (ticket) => ({ session_id: ticket === "unknown" ? null : ticket }),
    resolveCurrentAgentId: () => { reads += 1; return { identity: { session: { session_id: "own" } } }; },
  };
  const hazard = tms.buildTreeMutationSafetyHazard(options);
  assert.equal(hazard.live_foreign_doing_locks.length, 3);
  assert.equal(reads, 1);
  const message = tms.formatTreeMutationSafetyHazard(hazard);
  for (const label of ["own-session", "foreign-session", "unknown-session"]) assert.ok(message.includes(label));
  assert.equal(tms.buildTreeMutationSafetyHazard({ ...options, allowedPaths: ["outside.js"] }), null);
  assert.equal(reads, 1, "no session lookup on derived-only/allowed paths");
});

test("COORD-435: parsePorcelainStatusPaths strips the status prefix and drops blanks", () => {
  const out = [
    " M coord/engine/scripts/lifecycle.js",
    "?? coord/scripts/new.js",
    "A  coord/board/tasks.json",
    "",
  ].join("\n");
  const paths = tms.parsePorcelainStatusPaths(out);
  // The parser dedups and sorts the paths.
  assert.deepEqual(paths, [
    "coord/board/tasks.json",
    "coord/engine/scripts/lifecycle.js",
    "coord/scripts/new.js",
  ]);
});

test("COORD-435: pathMatchesScope matches an in-scope path and rejects an out-of-scope one", () => {
  const scope = ["coord/engine/scripts/lifecycle.js", "coord/board/"];
  assert.equal(tms.pathMatchesScope("coord/engine/scripts/lifecycle.js", scope), true);
  assert.equal(tms.pathMatchesScope("coord/scripts/other.js", scope), false);
});

test("COORD-435: dirtyPathsOutsideScope returns only the paths outside the allowed scope", () => {
  const gitTry = () => ({
    status: 0,
    stdout: " M coord/engine/scripts/lifecycle.js\n M coord/scripts/rogue.js\n",
  });
  const outside = tms.dirtyPathsOutsideScope({
    gitTry,
    repoRoot: "/repo",
    allowedPaths: ["coord/engine/scripts/lifecycle.js"],
  });
  assert.deepEqual(outside, ["coord/scripts/rogue.js"]);
});

test("COORD-435: dirtyPathsOutsideScope is safe when git is unavailable or errors", () => {
  assert.deepEqual(tms.dirtyPathsOutsideScope({ gitTry: undefined }), []);
  assert.deepEqual(
    tms.dirtyPathsOutsideScope({ gitTry: () => ({ status: 1, stdout: "" }), repoRoot: "/r", allowedPaths: [] }),
    []
  );
});

// COORD-862 (COORD-516a): the field refusal listed 403 raw paths. The scoped
// verdict now says whether the engine is intact and counts project work.
function scopedHazard(stdout) {
  return tms.buildTreeMutationSafetyHazard({
    gitTry: () => ({ status: 0, stdout }),
    repoRoot: "/repo", allowedPaths: ["coord/board/tasks.json"], board: {},
    getRows: () => [{ ID: "T-1", Status: "doing", Owner: "other" }],
    isDoingStatus: () => true,
    findLockForTicket: () => ({ owner: "other", session_id: "s" }),
    isStaleTicketLock: () => false,
  });
}

test("COORD-862 (c): 381 untracked + 22 modified project paths read 'engine intact, 403 project paths uncommitted'", () => {
  const lines = [];
  for (let i = 0; i < 381; i += 1) lines.push(`?? frontend/src/generated/file-${String(i).padStart(3, "0")}.js`);
  for (let i = 0; i < 22; i += 1) lines.push(` M coord/prompts/tickets/COORD-${900 + i}.md`);
  lines.push(" M coord/board/tasks.json"); // in the allowed scope: never counted
  const hazard = scopedHazard(`${lines.join("\n")}\n`);
  assert.equal(hazard.dirty_non_derived_paths.length, 403);
  assert.equal(hazard.scope_summary, "engine intact, 403 project paths uncommitted (governed 403)");
  assert.deepEqual(hazard.dirty_by_scope.engine, []);
  const message = tms.formatTreeMutationSafetyHazard(hazard);
  assert.match(message, /Scope: engine intact, 403 project paths uncommitted \(governed 403\)\./);
  assert.match(message, /and 378 more\./, "the raw list is capped");
  assert.match(message, /Remedy by scope: governed: /);
  assert.doesNotMatch(message, /engine:/);
});

test("COORD-862 (a): an engine hand-edit in the dirty tree is named as engine drift", () => {
  const hazard = scopedHazard(" M coord/engine/scripts/lifecycle.js\n?? backend/new.js\n M coord/rendered/TASKS.md\n");
  assert.deepEqual(hazard.dirty_by_scope.engine, ["coord/engine/scripts/lifecycle.js"]);
  const message = tms.formatTreeMutationSafetyHazard(hazard);
  assert.match(message, /Scope: engine drift on 1 path: coord\/engine\/scripts\/lifecycle\.js, 2 project paths uncommitted \(governed 1, derived 1\)\./);
  assert.match(message, /engine: restore the engine file.*verify-engine --pin/);
  // A pre-COORD-862 hazard object without the partition still formats.
  assert.match(tms.formatTreeMutationSafetyHazard({ dirty_non_derived_paths: ["coord/scripts/x.js"], live_foreign_doing_locks: [] }),
    /engine drift on 1 path: coord\/scripts\/x\.js/);
});

test("COORD-862: the guard and its formatter tolerate sparse inputs", () => {
  const base = {
    gitTry: () => ({ status: 0, stdout: " M backend/a.js\n" }),
    repoRoot: "/repo", allowedPaths: [], board: {}, isDoingStatus: (status) => status === "doing",
    isStaleTicketLock: () => false,
  };
  assert.equal(tms.buildTreeMutationSafetyHazard({ ...base, getRows: () => null, findLockForTicket: () => null }), null);
  assert.equal(tms.buildTreeMutationSafetyHazard({
    ...base,
    getRows: () => [{ ID: "T-1", Status: "todo" }, { ID: "T-2", Status: "doing" }],
    findLockForTicket: () => null,
  }), null, "a non-doing row and a doing row without a lock are not live locks");
  assert.equal(tms.formatTreeMutationSafetyHazard(null), "");
  assert.match(tms.formatTreeMutationSafetyHazard({}), /exist \(unknown-session\).*path\(s\): unknown\. Scope: engine intact, 0 project paths uncommitted\./);
});
