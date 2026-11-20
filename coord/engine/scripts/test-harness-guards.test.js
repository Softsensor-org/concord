"use strict";

// COORD-952 guards: the git-fixture isolation rule is enforced for the suites that
// were found to inherit host git config. A suite that makes git calls on temp repos
// must route them through test-git-fixture.js so host config cannot change the result.
// Extending the list to other suites is a deliberate change here, not a silent drift.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HELPER = "./test-git-fixture.js";
const GIT_FIXTURE_SUITES = [
  "integration-authority.test.js",
  "worktree-ops.test.js",
  "ticket-transitions.test.js",
  "lifecycle-repox-closeout.test.js",
];

for (const suite of GIT_FIXTURE_SUITES) {
  test(`COORD-952 guard: ${suite} isolates git config through the shared fixture helper`, () => {
    const source = fs.readFileSync(path.join(__dirname, suite), "utf8");
    assert.ok(source.includes(`require("${HELPER}")`), `${suite} must require ${HELPER}`);
    assert.ok(source.includes("gitFixtureEnv("), `${suite} must pass gitFixtureEnv() to its git fixture calls`);
  });
}

test("COORD-952 guard: the shared helper isolates the full git config surface", () => {
  const source = fs.readFileSync(path.join(__dirname, "test-git-fixture.js"), "utf8");
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    assert.ok(source.includes(key), `helper must set ${key}`);
  }
});

// COORD-952 ratchet: raw git-init fixtures. A raw fixture repo (git init, or a "init" argument
// on a git call) inherits host git config unless it uses test-git-fixture.js. The map below
// is the reviewed baseline of raw sites per test file at the time of COORD-952. The guard
// fails when a file's count grows or a file not in the map gains a raw site. New fixtures
// must call gitFixture / gitFixtureSpawn. Lowering a count is always allowed; raising one
// needs a reviewed change to this map. A file whose count reaches zero must leave the map.
const RAW_GIT_INIT_BASELINE = {
  "agent-commands.test.js": 1,
  "cli-surface.test.js": 1,
  "closeout.test.js": 10,
  "code-context.test.js": 1,
  "commit-scope.test.js": 1,
  "coord-ui-repo-scope.test.js": 1,
  "decomposition-proof-gate.test.js": 2,
  "doctor-report.test.js": 1,
  "engine-coverage.test.js": 1,
  "feature-proof-sibling-path.test.js": 1,
  "gate-artifact-schema.test.js": 1,
  "governance.test.js": 1,
  "integration-authority.test.js": 2,
  "journal.test.js": 2,
  "landing-corrections.test.js": 2,
  "landing-decision-packet.test.js": 1,
  "lifecycle-closeout-shims.test.js": 1,
  "lifecycle-repox-closeout.test.js": 4,
  "lifecycle-review-state.test.js": 1,
  "missing-ticket-lock.test.js": 2,
  "onboard.test.js": 4,
  "operator-policy-consistency.test.js": 1,
  "prodloc-attribution.test.js": 1,
  "prompt-paths.test.js": 1,
  "question-resolution.test.js": 1,
  "reconcile-packet.test.js": 1,
  "state-io.test.js": 3,
  "template-sync-discovery.test.js": 1,
  "test-runner.test.js": 2,
  "ticket-transitions.test.js": 1,
  "token-economics.test.js": 3,
  "workspace-container-witness.test.js": 1,
  "board/board.test.js": 1,
};

const RAW_GIT_INIT_DIRS = [__dirname, path.join(__dirname, "..", "..", "board")];
const RAW_GIT_INIT_LINE = /git[^\n]*["'`]init["'`]|\bgit init\b/;

function rawGitInitCounts() {
  const counts = {};
  for (const dir of RAW_GIT_INIT_DIRS) {
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.test\.(js|mjs)$/.test(entry) || entry === "test-harness-guards.test.js") continue;
      const lines = fs.readFileSync(path.join(dir, entry), "utf8").split("\n");
      const count = lines.filter((line) => RAW_GIT_INIT_LINE.test(line) && !/gitFixture/.test(line)).length;
      if (count > 0) {
        const key = dir === __dirname ? entry : `board/${entry}`;
        counts[key] = count;
      }
    }
  }
  return counts;
}

test("COORD-952 ratchet: raw git-init fixture sites do not grow and new files use test-git-fixture.js", () => {
  const current = rawGitInitCounts();
  const grew = [];
  for (const [file, count] of Object.entries(current)) {
    const baseline = RAW_GIT_INIT_BASELINE[file];
    if (baseline === undefined) grew.push(`${file} (${count} raw site(s); new file)`);
    else if (count > baseline) grew.push(`${file} (${baseline} -> ${count})`);
  }
  assert.deepEqual(grew, [], "raw git-init fixtures grew; use gitFixture/gitFixtureSpawn from test-git-fixture.js");
});

test("COORD-952 ratchet: the baseline covers exactly the files that have raw sites", () => {
  const current = rawGitInitCounts();
  for (const file of Object.keys(RAW_GIT_INIT_BASELINE)) {
    assert.ok(current[file] !== undefined, `${file} is in the baseline but has no raw git-init site; remove it from the map`);
  }
});

// COORD-1038: suites that reach the governed done/supersede path (applyMarkDone,
// markDone, supersedeTicket, finishTicket) print "Marked ... synced board artifacts" and
// write a board. Each must create its board root under os.tmpdir() and must never name
// the repo board. The list is a reviewed ratchet: a new emitter fails until its root is
// confirmed temp and it is added here. test-runner.js and the fs isolation guard are unchanged.
const BOARD_MUTATOR_SUITES = [
  "closeout.test.js",
  "integration-authority.test.js",
  "landing-decision-packet.test.js",
  "ticket-transitions.test.js",
];
const BOARD_MUTATOR_CALL = /(?:\.|\b)(applyMarkDone|markDone|supersedeTicket|finishTicket)\(/;
const REPO_BOARD_REFERENCE = /(COORD_DIR|REPO_ROOT|COORD_ROOT_DIR|__dirname)[^;\n]*"board"/;
const TEMP_ROOT_MARKER = /os\.tmpdir\(\)|mkdtemp/;
const BOARD_MUTATOR_SCAN_DIRS = [__dirname, path.join(__dirname, "..", "..", "scripts")];

function boardMutatorSuites() {
  const found = [];
  for (const dir of BOARD_MUTATOR_SCAN_DIRS) {
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.test\.js$/.test(entry) || entry === "test-harness-guards.test.js") continue;
      const source = fs.readFileSync(path.join(dir, entry), "utf8");
      if (BOARD_MUTATOR_CALL.test(source)) found.push(path.relative(__dirname, path.join(dir, entry)));
    }
  }
  return found.sort();
}

test("COORD-1038 guard: the board-mutating suite set matches the reviewed list", () => {
  assert.deepEqual(
    boardMutatorSuites(),
    BOARD_MUTATOR_SUITES,
    "a suite that reaches applyMarkDone/markDone/supersedeTicket/finishTicket must confirm its board root is os.tmpdir() and be added to BOARD_MUTATOR_SUITES"
  );
});

for (const suite of BOARD_MUTATOR_SUITES) {
  test(`COORD-1038 guard: ${suite} creates its board root under os.tmpdir() and never names the repo board`, () => {
    const source = fs.readFileSync(path.join(__dirname, suite), "utf8");
    assert.ok(TEMP_ROOT_MARKER.test(source), `${suite} must create its board root under os.tmpdir() (mkdtemp)`);
    const offenders = source.split("\n").filter((line) => REPO_BOARD_REFERENCE.test(line));
    assert.deepEqual(offenders, [], `${suite} references the repo board root; use a temp fixture root`);
  });
}

test("COORD-1038 guard: the repo-board detector flags a canonical board root and passes a temp root", () => {
  assert.equal(REPO_BOARD_REFERENCE.test('const boardPath = path.join(COORD_DIR, "board", "tasks.json");'), true);
  assert.equal(REPO_BOARD_REFERENCE.test('const p = path.join(REPO_ROOT, "coord", "board", "tasks.json");'), true);
  assert.equal(REPO_BOARD_REFERENCE.test('const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));'), false);
});
