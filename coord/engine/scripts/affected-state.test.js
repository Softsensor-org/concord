"use strict";

// COORD-924: the affected-selection state is governed, journaled and shared:
// it lives on the canonical board and changes only through `gov selection`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const governed = require("./affected-state.js");
const shadow = require("./affected-shadow.js");
const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { state: governanceState } = require("./governance-context.js");

const POLICY = { initial_state: "active", policy_version: 1 };
const testOnly = { tier: "T0", decision: "selected", categories: ["test-only"], fallback_reasons: [], selected: [{ suite: "coord/a.test.js" }], always_required_checks: [] };

function asSession(id, fn) {
  const before = process.env.COORD_SESSION_ID;
  process.env.COORD_SESSION_ID = id;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.COORD_SESSION_ID;
    else process.env.COORD_SESSION_ID = before;
  }
}

function journal() {
  return fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("COORD-924: the governed selection state reads from the board and fails closed", (t) => {
  assert.deepEqual(governed.boardSelectionState(null, POLICY), { state: "shadow", source: "board unreadable: full gates", suspended_categories: {} });
  assert.deepEqual(governed.boardSelectionState({ metadata: {} }, POLICY), { state: "active", source: "policy default (v1)", policy_version: 1, suspended_categories: {} });
  assert.equal(governed.boardSelectionState({ metadata: {} }, { initial_state: "shadow" }).policy_version, null);
  assert.equal(governed.boardSelectionState({ metadata: { affected_selection: { state: "bogus" } } }, POLICY).source, "unknown state bogus: full gates");
  const meta = { state: "active", policy_version: 1, suspended_categories: { fixture: { since: "n" } }, resolutions: [{ at: "m" }] };
  assert.deepEqual(governed.boardSelectionState({ metadata: { affected_selection: meta } }, POLICY), { state: "active", source: "governed board", policy_version: 1, suspended_categories: meta.suspended_categories, resolutions: meta.resolutions });
  assert.deepEqual(governed.boardSelectionState({ metadata: { affected_selection: {} } }, POLICY), { state: "active", source: "governed board", policy_version: null, suspended_categories: {}, resolutions: [] });
  const newer = governed.boardSelectionState({ metadata: { affected_selection: meta } }, { ...POLICY, policy_version: 2 });
  assert.equal(newer.policy_version, 2);
  assert.match(newer.source, /supersedes board state v1/);
  assert.deepEqual(newer.suspended_categories, meta.suspended_categories, "a policy upgrade does not erase a regression suspension");
  assert.deepEqual(newer.resolutions, meta.resolutions);
  const rollback = governed.boardSelectionState({ metadata: { affected_selection: { state: "active", policy_version: 1 } } }, { initial_state: "shadow" });
  assert.equal(rollback.state, "shadow");
  assert.equal(rollback.policy_version, null);
  assert.deepEqual([rollback.suspended_categories, rollback.resolutions], [{}, []]);
  const oldMinimal = governed.boardSelectionState({ metadata: { affected_selection: { state: "shadow", policy_version: 1 } } }, { ...POLICY, policy_version: 2 });
  assert.equal(oldMinimal.state, "active");
  assert.deepEqual([oldMinimal.suspended_categories, oldMinimal.resolutions], [{}, []]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(governed.readSelectionState({ root: dir, policy: POLICY }).state, "shadow", "no board: full gates");
  assert.equal(governed.boardPathFor("/w"), path.join("/w", "coord", "board", "tasks.json"));
  assert.deepEqual(governed.currentMeta({ metadata: {} }, { initial_state: "active" }), { state: "active", policy_version: null, suspended_categories: {}, resolutions: [] });
});

test("COORD-924: suspensions and resolutions: an investigation and a tightened policy version are required", () => {
  const base = { state: "active", policy_version: 1, suspended_categories: {}, resolutions: [] };
  const all = governed.withSuspension(base, { categories: [], reason: "r", ref: "COORD-1", policyVersion: 1, now: "n" });
  assert.deepEqual(Object.keys(all.suspended_categories), [governed.ALL]);
  const held = governed.withSuspension(base, { categories: ["fixture"], reason: "r", ref: "COORD-1", now: "n" });
  assert.deepEqual(held.suspended_categories.fixture, { since: "n", reason: "r", ref: "COORD-1", policy_version: null });
  assert.throws(() => governed.withResolution(base, { category: "fixture", investigation: "x", policyVersion: 2 }), /refusing to resolve: change category fixture is not suspended/);
  const v1 = governed.withSuspension(base, { categories: ["fixture"], reason: "r", ref: "x", policyVersion: 1, now: "n" });
  assert.throws(() => governed.withResolution(v1, { category: "fixture", policyVersion: 2 }), /without --investigation/);
  assert.throws(() => governed.withResolution(v1, { category: "fixture", investigation: "x", policyVersion: 1 }), /tighten the criteria first \(policy version 1 is not newer than 1/);
  assert.throws(() => governed.withResolution(v1, { category: "fixture", investigation: "x" }), /policy version 0 is not newer than 1/);
  assert.throws(() => governed.withResolution(held, { category: "fixture", investigation: "x", policyVersion: 0 }), /policy version 0 is not newer than 0, the version that missed/);
  assert.equal(governed.withResolution(held, { category: "fixture", investigation: "x", policyVersion: 1, now: "m" }).policy_version, 1, "a suspension recorded without a version lifts under any versioned policy");
  const lifted = governed.withResolution(v1, { category: "fixture", investigation: "COORD-2", policyVersion: 2, now: "m" });
  assert.deepEqual([lifted.suspended_categories, lifted.policy_version, lifted.resolutions], [{}, 2, [{ category: "fixture", investigation: "COORD-2", policy_version: 2, at: "m" }]]);
  assert.deepEqual(governed.parseSelectionArgs(["--category", "a,b", "--category", "c", "--ref", "r"]), { category: ["a,b", "c"], ref: "r" });
  assert.throws(() => governed.parseSelectionArgs(["--bogus", "x"]), /unknown or valueless argument --bogus/);
  assert.throws(() => governed.parseSelectionArgs(["--ref"]), /valueless argument --ref/);
  assert.deepEqual(governed.splitCategories(["a,b", " c "]), ["a", "b", "c"]);
  assert.deepEqual(governed.splitCategories(undefined), []);
});

test("COORD-924: a suspension recorded in one session refuses selection in another session on the same board", () => {
  withRegisterPromptHarness("coord924-selection-", {}, ({ readBoard }) => {
    const suspended = asSession("session-a", () => executeCommand(["selection", "suspend", "--category", "test-only", "--ref", "COORD-999", "--reason", "nightly miss"]));
    assert.equal(suspended.ok, true, JSON.stringify(suspended));
    const event = journal().at(-1);
    assert.deepEqual([event.command, event.result, event.details.categories, event.details.ref], ["selection-suspend", "succeeded", ["test-only"], "COORD-999"]);
    assert.deepEqual(event.changed_paths.filter((p) => p.endsWith("tasks.json")).length, 1, "the governed board carries the state");
    assert.equal(readBoard().metadata.affected_selection.suspended_categories["test-only"].reason, "nightly miss");
    asSession("session-b", () => {
      const state = governed.readSelectionState({ root: "/unused", boardPath: governanceState.BOARD_PATH, policy: POLICY });
      assert.deepEqual(Object.keys(state.suspended_categories), ["test-only"], "the other session reads the same suspension");
      const gate = shadow.landingPolicy({ selection: testOnly, state: { ...state, state: "active" } });
      assert.deepEqual([gate.gate, gate.reason], ["full", "selection is suspended for test-only after a recorded miss"]);
      assert.deepEqual(shadow.landingPolicy({ selection: testOnly, state }), gate, "the active policy still enforces the recorded suspension");
      assert.match(shadow.landingPolicy({ selection: testOnly, state: { ...state, state: "shadow" } }).reason, /^affected selection is shadow/, "rollback independently requires the full gate");
      const shown = executeCommand(["selection", "state"]);
      assert.equal(shown.ok, true);
      assert.match(String(shown.stdout), /"test-only"/);
    });
    const noRef = executeCommand(["selection", "suspend", "--category", "x"]);
    assert.equal(noRef.ok, false);
    assert.match(String(noRef.error || noRef.stderr), /requires --ref/);
    const all = executeCommand(["selection", "suspend", "--ref", "COORD-998"]);
    assert.equal(all.ok, true);
    assert.ok(readBoard().metadata.affected_selection.suspended_categories.all);
  });
});

test("COORD-924: lifting a suspension without an investigation or a tightened policy is refused and changes nothing", () => {
  withRegisterPromptHarness("coord924-selection-resolve-", {}, ({ readBoard }) => {
    assert.equal(executeCommand(["selection", "suspend", "--category", "fixture", "--ref", "COORD-999"]).ok, true);
    const before = readBoard().metadata.affected_selection;
    const events = journal().length;
    const bare = executeCommand(["selection", "resolve", "--category", "fixture"]);
    assert.equal(bare.ok, false);
    assert.match(String(bare.error || bare.stderr), /refusing to resolve a suspension without --investigation/);
    const sameVersion = executeCommand(["selection", "resolve", "--category", "fixture", "--investigation", "COORD-1000"]);
    assert.equal(sameVersion.ok, false);
    assert.match(String(sameVersion.error || sameVersion.stderr), /tighten the criteria first/);
    assert.deepEqual(readBoard().metadata.affected_selection, before, "a refused lift leaves the governed state untouched");
    assert.equal(journal().filter((e) => e.command === "selection-resolve" && e.result === "succeeded").length, 0);
    assert.ok(journal().length >= events);
    const noCategory = executeCommand(["selection", "resolve", "--investigation", "x"]);
    assert.match(String(noCategory.error || noCategory.stderr), /requires --category/);
    const unknown = executeCommand(["selection", "bogus"]);
    assert.match(String(unknown.error || unknown.stderr), /selection requires a subcommand: state \| suspend \| resolve \| nightly/);
    const badFlag = executeCommand(["selection", "state", "--bogus", "x"]);
    assert.match(String(badFlag.error || badFlag.stderr), /unknown or valueless argument --bogus/);
  });
});

test("COORD-924: gov selection resolve lifts a suspension under a tightened policy, journaled", () => {
  const logs = [];
  let loads = 0;
  let board = { metadata: {} };
  const commands = governed.createSelectionCommands({
    withBoardTransaction: (mutation, fn) => { logs.push(mutation); return fn({ board }); },
    writeBoard: (next) => { board = JSON.parse(JSON.stringify(next)); },
    fail: (m) => { throw new Error(m); },
    loadPolicy: () => ({ ...POLICY, policy_version: (loads += 1) > 1 ? 2 : 1 }),
    root: "/unused", boardPath: "/unused/board.json", log: () => {}, now: () => "t",
  });
  commands.selectionCommand("suspend", ["--category", "fixture", "--ref", "COORD-1"]);
  commands.selectionCommand("resolve", ["--category", "fixture", "--investigation", "COORD-2"]);
  assert.deepEqual(logs.map((m) => [m.command, m.details.category || m.details.categories]), [["selection-suspend", ["fixture"]], ["selection-resolve", "fixture"]]);
  assert.deepEqual([board.metadata.affected_selection.suspended_categories, board.metadata.affected_selection.policy_version], [{}, 2]);
});

test("COORD-924: gov selection nightly journals the categories a full-run comparison missed", (t) => {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coord924-nightly-")), "full.json");
  t.after(() => fs.rmSync(path.dirname(report), { recursive: true, force: true }));
  fs.writeFileSync(report, JSON.stringify({ node_version: "v22.8.0", result: "fail", results: [{ failing_tests: ["no suite registers this title"] }] }));
  withRegisterPromptHarness("coord924-selection-nightly-", {}, ({ readBoard }) => {
    assert.match(String(executeCommand(["selection", "nightly"]).error), /requires --full-report/);
    assert.match(String(executeCommand(["selection", "nightly", "--full-report", report]).error), /requires --base/);
    const run = executeCommand(["selection", "nightly", "--full-report", report, "--base", "HEAD", "--head", "HEAD", "--ref", "nightly-1"]);
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.match(String(run.stdout), /selection: nightly gate=affected failures=1 missed=1/, "active selection still records the miss against the full-run comparison");
    const suspended = readBoard().metadata.affected_selection.suspended_categories;
    assert.deepEqual(Object.keys(suspended), [governed.ALL], "a range with no categories suspends everything");
    assert.equal(suspended.all.ref, "nightly-1");
    assert.equal(shadow.landingPolicy({ selection: testOnly, state: governed.boardSelectionState(readBoard(), POLICY) }).gate, "full", "the recorded miss suspends subsequent selected runs");
    assert.equal(journal().at(-1).command, "selection-suspend");
    assert.ok(fs.existsSync(path.join(governanceState.RUNTIME_DIR, "affected-selection", "refinement-report.md")));
  });
  const passing = governed.createSelectionCommands({
    withBoardTransaction: () => assert.fail("a clean comparison suspends nothing"), writeBoard: () => {}, fail: (m) => { throw new Error(m); },
    loadPolicy: () => POLICY, root: "/r", log: () => {}, compareFullRun: () => ({ at: "t", gate: "full", full_failures: [], missed: [], categories: [] }),
  });
  assert.equal(passing.selectionCommand("nightly", ["--full-report", report, "--base", "HEAD"]).gate, "full");
  const suspensions = [];
  const missing = governed.createSelectionCommands({
    withBoardTransaction: (mutation, fn) => { suspensions.push(mutation.details); return fn({ board: { metadata: {} } }); }, writeBoard: () => {},
    fail: (m) => { throw new Error(m); }, loadPolicy: () => POLICY, root: "/r", log: () => {}, now: () => "t",
    compareFullRun: () => ({ at: "2026-11-07", gate: "affected", full_failures: ["x"], missed: ["x"], categories: ["fixture"] }),
  });
  missing.selectionCommand("nightly", ["--full-report", report, "--base", "HEAD"]);
  assert.deepEqual(suspensions, [{ categories: ["fixture"], ref: "nightly 2026-11-07", reason: "nightly comparison missed: x" }]);
});
