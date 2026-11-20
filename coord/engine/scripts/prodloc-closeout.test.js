"use strict";
const { gitFixture, gitFixtureEnv } = require("./test-git-fixture.js"); // COORD-952
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const createCloseout = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/closeout.js"));
const createRepoCloseout = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-repox-closeout.js"));
const paths = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js"));
const ID = "TEST-674", FILE = "coord/scripts/budget-fixture.js";
const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
function fixture(t, donor = true, lines = 1200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-prodloc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord"), repo = donor ? root : coord;
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  const effects = [];
  let failedGitCommand = null;
  const gitTry = (dir, args, options = {}) => {
    if (args[0] === failedGitCommand) return { status: 128, stdout: "", stderr: "controlled Git failure" };
    if (args[0] === "merge") effects.push("merge");
    return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitFixtureEnv(env), ...options });
  };
  const git = (...args) => { const r = gitTry(repo, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  gitFixture(repo, ["init", "-b", "main"]); // COORD-952: fixture init uses the shared git env
  const write = count => fs.writeFileSync(path.join(coord, "scripts/budget-fixture.js"), Array.from({ length: count }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n");
  const commit = message => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  write(lines); commit("initial source");
  const layout = paths.resolveControlPlaneLayout({ coordDir: coord, workspaceRoot: root });
  paths.__testing.override(layout); t.after(() => paths.__testing.reset());
  const repoCloseout = createRepoCloseout({ COORD_DIR: coord, REPO_ROOTS: { X: repo }, controlPlaneLayout: layout,
    gitTry, getRepoRoot: () => repo, inferTicketIdFromPath: () => null, listGitWorktrees: () => [],
    readTicketFileSurface: () => [], repoDisplayNameForCode: code => code, recordExternalSideEffect: () => {},
    enginePin: { deriveManifestFingerprint: () => ({ manifest: { items: [] } }), verifyManifest: () => ({ ok: true }), verify: () => ({ ok: true }) } });
  const closeout = createCloseout({ assertReviewPlanReady() {}, verifyPrEvidence() {}, findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null, isRepoBackedCode: () => false,
    ensureRepoXCloseoutReady: repoCloseout.ensureRepoXCloseoutReady, cleanupTicketWorktree: () => effects.push("cleanup") });
  const row = { ID, Repo: "X", Status: "review" }, board = { sections: [{ rows: [row] }], pr_index: { [ID]: ["local-review (no PR)"] } };
  return { root, repo, coord, layout, git, write, commit, effects, board, row, failGit: command => { failedGitCommand = command; },
    close: options => closeout.prepareDoneCloseout(ID, board, { row }, { layout, base: "main", ...options }) };
}

for (const donor of [true, false]) {
  test(`real ${donor ? "donor" : "independent"} no-PR closeout refuses an already integrated breach even with no declared surface`, t => {
    const f = fixture(t, donor, 1201), before = structuredClone(f.board), head = f.git("rev-parse", "HEAD");
    assert.throws(() => f.close({ skipProdloc: true }), error => {
      assert.match(error.message, /prodloc/i); assert.ok(error.message.includes(FILE));
      assert.match(error.message, /1201/); assert.match(error.message, /1200/); return true;
    });
    assert.deepEqual(f.board, before); assert.deepEqual(f.effects, []); assert.equal(f.git("rev-parse", "HEAD"), head);
  });
  test(`real ${donor ? "donor" : "independent"} no-PR closeout admits exact budget and unused headroom`, t => {
    const f = fixture(t, donor, 1199); f.close(); assert.ok(f.board.landing_index[ID]);
    delete f.board.landing_index; f.effects.length = 0;
    f.write(1200); f.commit("exact budget"); f.close(); assert.deepEqual(f.effects, ["cleanup"]);
  });
  test(`real ${donor ? "donor" : "independent"} no-PR closeout refuses incoming breach before merge`, t => {
    const f = fixture(t, donor), head = f.git("rev-parse", "HEAD"), before = structuredClone(f.board);
    f.git("checkout", "-b", "agent/codexa1-test-674-breach"); f.write(1201); f.commit("incoming breach"); f.git("checkout", "main");
    assert.throws(() => f.close({ mergeWorkspace: true }), /prodloc.*1201.*1200|prodloc.*1200.*1201/is);
    assert.equal(f.git("rev-parse", "HEAD"), head); assert.deepEqual(f.effects, []); assert.deepEqual(f.board, before);
  });
}

test("combined changes that individually fit the budget refuse before any branch merge", t => {
  const f = fixture(t, true, 1198), base = f.git("rev-parse", "HEAD"), file = path.join(f.coord, "scripts/budget-fixture.js");
  f.git("checkout", "-b", "agent/codexa1-test-674-first");
  fs.writeFileSync(file, "const firstA = 1;\nconst firstB = 2;\n" + fs.readFileSync(file, "utf8")); f.commit("first addition");
  f.git("checkout", "-b", "agent/codexa1-test-674-second", base);
  fs.appendFileSync(file, "const secondA = 1;\nconst secondB = 2;\n"); f.commit("second addition"); f.git("checkout", "main");
  assert.throws(() => f.close({ mergeWorkspace: true }), /prodloc.*1202.*1200|prodloc.*1200.*1202/is);
  assert.equal(f.git("rev-parse", "HEAD"), base); assert.deepEqual(f.effects, []);
});

test("a shrink repair can land when the existing integration tree exceeds the cap", t => {
  const f = fixture(t, true, 1201);
  f.git("checkout", "-b", "agent/codexa1-test-674-repair"); f.write(1200); f.commit("repair budget"); f.git("checkout", "main");
  f.close({ mergeWorkspace: true });
  assert.ok(f.board.landing_index[ID]); assert.deepEqual(f.effects, ["merge", "cleanup"]);
});

for (const command of ["rev-parse", "ls-tree", "cat-file", "merge-tree", "commit-tree"]) test(`Git ${command} failure refuses before integration or cleanup`, t => {
  const f = fixture(t, true, 10), head = f.git("rev-parse", "HEAD");
  if (["merge-tree", "commit-tree"].includes(command)) {
    f.git("checkout", "-b", "agent/codexa1-test-674-one"); f.write(11); f.commit("one");
    f.git("checkout", "-b", "agent/codexa1-test-674-two"); f.write(12); f.commit("two"); f.git("checkout", "main");
  }
  f.failGit(command);
  assert.throws(() => f.close({ mergeWorkspace: true }), /controlled Git failure/);
  assert.deepEqual(f.effects, []); assert.equal(f.board.landing_index, undefined);
  f.failGit(null); assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("candidate production code is measured as data and never executed", t => {
  const f = fixture(t, true, 10), sentinel = path.join(f.root, "must-not-exist");
  fs.appendFileSync(path.join(f.coord, "scripts/budget-fixture.js"), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
  f.commit("untrusted candidate code"); f.close(); assert.equal(fs.existsSync(sentinel), false);
});

test("a production source symlink cannot hide the module's content from the immutable scan", t => {
  const f = fixture(t, true, 10), file = path.join(f.coord, "scripts/budget-fixture.js");
  fs.unlinkSync(file); fs.symlinkSync("../../outside.js", file); f.commit("unsupported source link");
  assert.throws(() => f.close(), /prodloc.*regular production source file/is); assert.deepEqual(f.effects, []);
});

test("uncommitted shrink cannot conceal an oversized committed implementation", t => {
  const f = fixture(t, true, 1201); f.write(10);
  assert.throws(() => f.close(), /prodloc.*1201/is); assert.deepEqual(f.effects, []);
});

test("multiple fitting branches land while preview commits never enter delivery history", t => {
  const f = fixture(t, true, 1196), base = f.git("rev-parse", "HEAD"), file = path.join(f.coord, "scripts/budget-fixture.js");
  f.git("checkout", "-b", "agent/codexa1-test-674-first");
  fs.writeFileSync(file, "const firstA = 1;\nconst firstB = 2;\n" + fs.readFileSync(file, "utf8")); f.commit("first addition");
  f.git("checkout", "-b", "agent/codexa1-test-674-second", base);
  fs.appendFileSync(file, "const secondA = 1;\nconst secondB = 2;\n"); f.commit("second addition"); f.git("checkout", "main");
  f.close({ mergeWorkspace: true }); assert.deepEqual(f.effects, ["merge", "merge", "cleanup"]);
  assert.equal(f.git("log", "--format=%s", "--grep=Unreferenced production LOC validation preview"), "");
  assert.equal(require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js")).countLoc(fs.readFileSync(file, "utf8")).loc, 1200);
});

test("all breaches are named so an existing violation cannot mask another", t => {
  const f = fixture(t, true, 1201);
  fs.writeFileSync(path.join(f.coord, "scripts/second-fixture.js"), "void 0;\n".repeat(1202)); f.commit("second breach");
  assert.throws(() => f.close(), error => {
    assert.match(error.message, /budget-fixture\.js: measured 1201 LOC, declared budget 1200/);
    assert.match(error.message, /second-fixture\.js: measured 1202 LOC, declared budget 1200/); return true;
  });
  assert.deepEqual(f.effects, []);
});

// COORD-871 (human-admin ruling 2026-11-04): modules migrated into coord/engine/scripts
// keep their size budgets, so closeout must also measure the engine scripts tree.
for (const donor of [true, false]) {
  test(`COORD-871: real ${donor ? "donor" : "independent"} closeout refuses an engine-scripts module over the budget`, t => {
    const f = fixture(t, donor, 1199), engineDir = path.join(f.coord, "engine", "scripts");
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, "budget-engine-fixture.js"), Array.from({ length: 1201 }, (_, i) => `const engine${i} = ${i};`).join("\n") + "\n");
    f.commit("engine module over budget");
    const head = f.git("rev-parse", "HEAD"), before = structuredClone(f.board);
    assert.throws(() => f.close(), error => {
      assert.match(error.message, /prodloc/i); assert.ok(error.message.includes("coord/engine/scripts/budget-engine-fixture.js"));
      assert.match(error.message, /1201/); assert.match(error.message, /1200/); return true;
    });
    assert.deepEqual(f.board, before); assert.deepEqual(f.effects, []); assert.equal(f.git("rev-parse", "HEAD"), head);
  });
}

// COORD-913: a budget carried through a registered shim move or a git rename applies at the
// new engine path. The candidate's own re-keyed number may only equal or undercut the trusted
// carried budget; raised and invented numbers are refused.
const { assertProductionLocForCloseout } = require("./prodloc-closeout.js");
const { loadShimRegistry } = require("../../paths.js");
const LEGACY = "coord/scripts/carry-legacy.js";
// COORD-991: the registered-shim fixture uses a permanent stable entrypoint, so it survives the
// 0.3.0 removal batches (removable shims are not spelled in live tests).
const REGISTERED_LEGACY = "coord/scripts/governance.js";
const REGISTERED_TARGET = "coord/engine/scripts/governance.js";
const lines = n => Array.from({ length: n }, (_, i) => `const carried${i} = ${i};`).join("\n") + "\n";
const declare = (entries) => "module.exports = {};\nconst opts = {\n  highWater: Object.freeze({\n" +
  Object.entries(entries).map(([k, v]) => `    "${k}": ${v},\n`).join("") + "  }),\n};\n";
function carryFixture(t, { trusted, legacyFile = LEGACY, legacyLines = 1500, candidate, onHead = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-carry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  const gitTry = (dir, args, options = {}) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitFixtureEnv(env), ...options });
  const git = (...args) => { const r = gitTry(root, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  gitFixture(root, ["init", "-b", "main"]); // COORD-952: fixture init uses the shared git env
  fs.writeFileSync(path.join(root, legacyFile), lines(legacyLines));
  git("add", "--all"); git("commit", "-m", "base");
  const layout = paths.resolveControlPlaneLayout({ coordDir: coord, workspaceRoot: root });
  const branch = "agent/codexa1-test-913-move";
  if (!onHead) git("checkout", "-b", branch);
  candidate({ root, coord, git });
  git("add", "--all"); git("commit", "-m", "candidate");
  if (!onHead) git("checkout", "main");
  const trustedConfig = { ...DEFAULT_CONFIG.checks.prodloc, highWater: { ...trusted } };
  return { run: (shimRegistry = loadShimRegistry(ENGINE_COORD_DIR).shims) =>
    assertProductionLocForCloseout(ID, { layout, gitTry, branches: onHead ? [] : [branch], trustedConfig, shimRegistry }) };
}
const { DEFAULT_CONFIG } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));
const moveEngine = (target, count, legacy = LEGACY) => ({ root, coord, git }) => {
  fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
  git("rm", "-q", legacy);
  fs.writeFileSync(path.join(root, target), lines(count));
};

test("COORD-913: a carried budget through a registered shim move passes at the unchanged budget", t => {
  const f = carryFixture(t, { trusted: { [REGISTERED_LEGACY]: 1500 }, legacyFile: REGISTERED_LEGACY,
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, REGISTERED_TARGET), lines(1500));
      fs.writeFileSync(path.join(root, REGISTERED_LEGACY), "module.exports = require('./shim');\n");
      fs.writeFileSync(path.join(root, "coord/engine/scripts/arch-checks.js"), declare({ [REGISTERED_TARGET]: 1500, "docs/example.md": 2000 }));
    } });
  assert.equal(f.run().result, "pass");
});

test("COORD-913: a carried budget through a git rename passes at the unchanged budget", t => {
  const f = carryFixture(t, { trusted: { [LEGACY]: 1500 }, candidate(context) {
    moveEngine("coord/engine/scripts/renamed-carry.js", 1500)(context);
    // An unrelated add precedes the rename in the name-status stream.
    fs.writeFileSync(path.join(context.root, "README.md"), "move the unchanged module\n");
    fs.writeFileSync(path.join(context.coord, "engine/scripts/arch-checks.js"), "module.exports = {};\n");
  } });
  assert.equal(f.run().result, "pass");
});

test("closeout refuses a truncated candidate budget declaration", (t) => {
  const f = carryFixture(t, { trusted: {}, candidate: ({ coord }) => {
    const scripts = path.join(coord, "engine", "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, "arch-checks.js"), 'const opts = { highWater: Object.freeze({ "partial.js": 2000');
  } });
  assert.throws(() => f.run(), /unterminated highWater budget declaration/);
});

test("COORD-913: a carried move whose candidate raises the re-keyed number is refused as budget raised", t => {
  const f = carryFixture(t, { trusted: { [REGISTERED_LEGACY]: 1500 }, legacyFile: REGISTERED_LEGACY,
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, REGISTERED_TARGET), lines(1500));
      fs.writeFileSync(path.join(root, REGISTERED_LEGACY), "module.exports = require('./shim');\n");
      fs.writeFileSync(path.join(root, "coord/engine/scripts/arch-checks.js"), declare({ [REGISTERED_TARGET]: 1600 }));
    } });
  assert.throws(() => f.run(), error => {
    assert.match(error.message, /budget raised/); assert.ok(error.message.includes(REGISTERED_TARGET));
    assert.match(error.message, /1600/); assert.match(error.message, /1500/);
    assert.doesNotMatch(error.message, /carried by a move/); assert.match(error.message, /do not raise/i); return true;
  });
});

test("COORD-913: a carried module over its carried budget is refused as budget carried by a move", t => {
  const f = carryFixture(t, { trusted: { [LEGACY]: 1500 }, candidate: moveEngine("coord/engine/scripts/renamed-over.js", 1501) });
  assert.throws(() => f.run(), error => {
    assert.match(error.message, /budget carried by a move/); assert.ok(error.message.includes("coord/engine/scripts/renamed-over.js"));
    assert.match(error.message, /1501/); assert.match(error.message, /1500/);
    assert.doesNotMatch(error.message, /budget raised/); assert.match(error.message, /split/i); return true;
  });
});

test("COORD-913: an unregistered copy gets the default budget, not the legacy budget", t => {
  const f = carryFixture(t, { trusted: { [LEGACY]: 1500 },
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "coord/engine/scripts/unregistered-copy.js"), lines(1201));
    } });
  assert.throws(() => f.run(), error => {
    assert.match(error.message, /unregistered-copy\.js: measured 1201 LOC, declared budget 1200/); return true;
  });
  for (const registry of [null, [null, {}, { path: "scripts/carry-legacy.js", target: "scripts/unregistered-copy.js" }]]) {
    assert.throws(() => f.run(registry), /unregistered-copy\.js: measured 1201 LOC, declared budget 1200/);
  }
});

test("COORD-913: an unregistered copy at the default budget still lands", t => {
  const f = carryFixture(t, { trusted: { [LEGACY]: 1500 },
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "coord/engine/scripts/unregistered-copy.js"), lines(1200));
    } });
  assert.equal(f.run().result, "pass");
});

test("COORD-913: a candidate-invented budget for an unregistered path is refused", t => {
  const f = carryFixture(t, { trusted: { [LEGACY]: 1500 },
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "coord/engine/scripts/invented.js"), lines(1201));
      fs.writeFileSync(path.join(root, "coord/engine/scripts/arch-checks.js"), declare({ "coord/engine/scripts/invented.js": 1500 }));
    } });
  assert.throws(() => f.run(), error => {
    assert.match(error.message, /budget invented/); assert.ok(error.message.includes("coord/engine/scripts/invented.js"));
    assert.doesNotMatch(error.message, /carried by a move/); return true;
  });
});

test("COORD-913: a no-PR closeout of an already-landed registered move applies the same carried budget", t => {
  const f = carryFixture(t, { trusted: { [REGISTERED_LEGACY]: 1500 }, legacyFile: REGISTERED_LEGACY, onHead: true,
    candidate: ({ root, coord }) => {
      fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, REGISTERED_TARGET), lines(1501));
      fs.writeFileSync(path.join(root, REGISTERED_LEGACY), "module.exports = require('./shim');\n");
    } });
  assert.throws(() => f.run(), error => {
    assert.match(error.message, /budget carried by a move/); assert.match(error.message, /1501/); return true;
  });
});


for (const [corruptAt, invalid] of [
  ["candidate", "{invalid candidate"],
  ["candidate", ""],
  ["base", "{invalid baseline"],
]) test(`COORD-1052: ${invalid ? "malformed" : "empty"} ${corruptAt} ratchet refuses closeout without landing or cleanup`, t => {
  const f = fixture(t, true, 10);
  const file = path.join(f.coord, "engine", "architecture-ratchet.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const valid = JSON.stringify({ schema_version: 1, ticket: "COORD-976",
    values: { guards: 0, production_modules: 0, production_loc: 0 }, growth: [] });
  fs.writeFileSync(file, corruptAt === "base" ? invalid : valid);
  const base = f.commit("baseline ratchet");
  f.git("checkout", "-b", "agent/codexa1-test-674-ratchet");
  fs.writeFileSync(file, corruptAt === "candidate" ? invalid : valid);
  const candidate = f.commit("candidate ratchet");
  f.git("checkout", "main");
  const before = structuredClone(f.board), bytes = fs.readFileSync(file, "utf8");
  assert.throws(() => f.close({ mergeWorkspace: true }), /architecture-ratchet\.json is not valid JSON/);
  assert.deepEqual(f.board, before);
  assert.deepEqual(f.effects, [], "refuse before merge or workspace cleanup");
  assert.equal(f.git("rev-parse", "HEAD"), base);
  assert.equal(f.git("rev-parse", "agent/codexa1-test-674-ratchet"), candidate);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(f.git("status", "--porcelain"), "");
});
