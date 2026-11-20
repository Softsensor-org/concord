"use strict";

// COORD-924: shadow runs, the journaled activation state with per-category
// the local evaluation log, and the landing policy. T2 and always-enforced checks never reduce.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sh = require("./affected-shadow.js");
const runManifest = require("./run-manifest.js");
const { initRepo } = require("./affected-evaluation.js");

function ledger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function selection(overrides = {}) {
  return {
    selector_version: 1, selector_digest: `sha256:${"a".repeat(64)}`, mode: "shadow", authorizes_landing: false,
    base: "HEAD", head: "HEAD", tier: "T1", categories: ["engine-module"], decision: "selected",
    fallback_reasons: [], selected: [{ suite: "coord/x.test.js", reasons: ["changed suite"] }],
    omitted: [{ suite: "coord/y.test.js", reason: "no changed file reaches this suite in the head or base graph" }],
    always_required_checks: ["owner-lease"], changes: [],
    ...overrides,
  };
}

function report(failing, durations = [100], result) {
  return {
    node_version: "v22.8.0", result: result || (failing.length ? "fail" : "pass"),
    results: durations.map((d, i) => ({ module: `m${i}`, duration_ms: d, failing_tests: i === 0 ? failing : [] })),
  };
}

const POLICY = { initial_state: "active", policy_version: 1 };

test("COORD-924: the activation journal is hash-chained and verified", (t) => {
  const dir = ledger(t);
  sh.transition(dir, { to: "active", event: "evaluated", reason: "first", policy: POLICY, now: "2026-11-06T00:00:00.000Z" });
  sh.transition(dir, { to: "shadow", event: "manual", reason: "second", policy: POLICY, now: "2026-11-06T00:00:01.000Z" });
  const entries = sh.readJournal(dir);
  assert.deepEqual(entries.map((e) => [e.seq, e.from_state, e.to_state]), [[1, "active", "active"], [2, "active", "shadow"]]);
  assert.equal(entries[1].prev_sha256, entries[0].sha256);
  assert.deepEqual(sh.verifyJournal(entries), { ok: true, head: entries[1].sha256 });
  const tampered = [entries[0], { ...entries[1], reason: "edited" }];
  assert.deepEqual(sh.verifyJournal(tampered), { ok: false, problem: "journal entry 2 does not verify" });
  assert.equal(sh.readState(dir, POLICY).state, "shadow");
  fs.writeFileSync(path.join(dir, sh.FILES.journal), tampered.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.throws(() => sh.transition(dir, { to: "active", event: "x", reason: "x" }), /journal is corrupt \(journal entry 2 does not verify\)/);
});

test("COORD-924: the local evaluation log starts from the policy; an unreadable or unverifiable log reads as shadow", (t) => {
  const dir = ledger(t);
  assert.deepEqual(sh.readState(dir, POLICY), { state: "active", source: "default (active, policy v1)", policy_version: 1, suspended_categories: {} });
  assert.deepEqual(sh.readState(dir), { state: "shadow", source: "default (shadow, policy v0)", policy_version: null, suspended_categories: {} });
  fs.writeFileSync(path.join(dir, sh.FILES.state), "{not json");
  assert.deepEqual(sh.readState(dir, POLICY), { state: "shadow", source: "state unreadable: full gates", suspended_categories: {} });
  fs.rmSync(path.join(dir, sh.FILES.state));
  sh.transition(dir, { to: "active", event: "evaluated", reason: "x", policy: POLICY });
  const state = JSON.parse(fs.readFileSync(path.join(dir, sh.FILES.state), "utf8"));
  assert.deepEqual([state.policy_version, state.suspended_categories], [1, {}]);
  fs.writeFileSync(path.join(dir, sh.FILES.state), JSON.stringify({ ...state, state: "bogus" }));
  assert.equal(sh.readState(dir, POLICY).source, "unknown state bogus: full gates");
  fs.writeFileSync(path.join(dir, sh.FILES.state), JSON.stringify({ ...state, journal_head: "sha256:other" }));
  assert.equal(sh.readState(dir, POLICY).source, "state does not match its journal (head differs): full gates");
  const legacy = { ...state };
  delete legacy.suspended_categories;
  fs.writeFileSync(path.join(dir, sh.FILES.state), JSON.stringify(legacy));
  assert.deepEqual(sh.readState(dir, POLICY).suspended_categories, {}, "a state written before categories has none suspended");
  const fromFallback = ledger(t);
  fs.writeFileSync(path.join(fromFallback, sh.FILES.state), JSON.stringify({ state: "bogus" }));
  sh.transition(fromFallback, { to: "shadow", event: "evaluated", reason: "recover", policy: POLICY });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fromFallback, sh.FILES.state), "utf8")).policy_version, null, "a transition out of a fallback state records no policy version");
  fs.writeFileSync(path.join(dir, sh.FILES.journal), "{broken\n");
  assert.equal(sh.readState(dir, POLICY).source, "state does not match its journal (journal unreadable): full gates");
});

test("COORD-924: the shadow comparison finds missed failures and the wall time saved", () => {
  const sel = selection();
  const caught = sh.compareShadow(sel, report(["a", "b"], [100, 50]), report(["a", "b"], [30]));
  assert.deepEqual(caught, { full_failures: ["a", "b"], selected_failures: ["a", "b"], missed_failures: [], wall_time_ms: { full: 150, selected: 30, saved: 120 } });
  const missed = sh.compareShadow(sel, report(["a", "b"]), report(["a"], [200]));
  assert.deepEqual([missed.missed_failures, missed.wall_time_ms.saved], [["b"], 0]);
  const full = sh.compareShadow(selection({ decision: "full" }), report(["a"]), null);
  assert.deepEqual([full.missed_failures, full.wall_time_ms], [[], { full: 100, selected: 100, saved: 0 }]);
  assert.throws(() => sh.compareShadow(sel, report([]), null), /needs the report of the selected suites/);
  assert.deepEqual(sh.failingTests(null), []);
  assert.deepEqual(sh.failingTests({}), []);
  assert.deepEqual(sh.failingTests({ results: [{ module: "m" }] }), [], "a module entry without failures");
  assert.equal(sh.compareShadow(selection({ decision: "full" }), { results: [{ module: "m" }] }).wall_time_ms.full, 0, "a module entry without a duration");
  assert.equal(sh.compareShadow(selection({ decision: "full" }), {}).wall_time_ms.full, 0, "a report without results");
  assert.deepEqual([sh.nodeMajor("v24.22.1"), sh.nodeMajor("x"), sh.nodeMajor(undefined)], [24, null, null]);
});

test("COORD-924: a shadow run is recorded in a valid run manifest and reports its misses", (t) => {
  const dir = ledger(t);
  const root = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord924-shadow-repo-")), { "coord/a.js": "\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fullPath = path.join(dir, "full.json");
  fs.writeFileSync(fullPath, "{}");
  const clean = sh.recordShadowRun({ root, ledgerDir: dir, selection: selection(), fullReport: report([]), fullReportPath: fullPath, selectedReport: report([], [10]), selectedReportPath: fullPath, env: {}, now: "2026-11-06T01:00:00.000Z" });
  const manifest = JSON.parse(fs.readFileSync(clean.file, "utf8"));
  assert.deepEqual(runManifest.validateManifest(manifest), []);
  assert.equal(manifest.plan.selection.mode, "shadow");
  assert.deepEqual(manifest.plan.selection.omitted, selection().omitted);
  assert.deepEqual(manifest.lanes.map((l) => l.name), ["full", "selected"]);
  assert.deepEqual([clean.line.edition, clean.line.node_major, clean.line.wall_time_saved_ms, clean.line.missed], ["Community", 22, 90, []]);
  const miss = sh.recordShadowRun({ root, ledgerDir: dir, selection: selection(), fullReport: report(["regression"]), fullReportPath: fullPath, selectedReport: report([]), env: {}, now: "2026-11-06T02:00:00.000Z" });
  assert.deepEqual([miss.line.missed, miss.manifest.lanes[0].exit_code], [["regression"], 1]);
  assert.deepEqual(sh.readJournal(dir), [], "a miss is reported to the caller, which records it in the governed state");
  const fallback = sh.recordShadowRun({ root, ledgerDir: dir, selection: selection({ decision: "full" }), fullReport: report([]), fullReportPath: fullPath, env: {}, now: "2026-11-06T03:00:00.000Z" });
  assert.deepEqual(fallback.manifest.lanes.map((l) => l.name), ["full"]);
  const noVersion = { ...report(["a"]) };
  delete noVersion.node_version;
  const failedSelected = sh.recordShadowRun({ root, ledgerDir: dir, selection: selection(), fullReport: noVersion, selectedReport: report(["a"]), env: {}, now: "2026-11-06T04:00:00.000Z" });
  assert.deepEqual([failedSelected.manifest.lanes[1].exit_code, failedSelected.line.node_major, failedSelected.manifest.artifacts], [1, sh.nodeMajor(process.version), []]);
  assert.equal(fs.readFileSync(path.join(dir, sh.FILES.runs), "utf8").trim().split("\n").length, 4);
});

test("COORD-924: the landing policy reduces only active, complete, unsuspended T0/T1 selections", () => {
  const active = { state: "active", source: "state file", suspended_categories: {} };
  const t2 = sh.landingPolicy({ selection: selection({ tier: "T2" }), state: active });
  assert.deepEqual([t2.gate, t2.reason, t2.tier], ["full", "T2 changes always run the full relevant gate", "T2"]);
  assert.match(sh.landingPolicy({ selection: selection(), state: { state: "shadow", source: "state unreadable: full gates" } }).reason, /affected selection is shadow \(state unreadable: full gates\)/);
  assert.match(sh.landingPolicy({ selection: selection(), state: { state: "shadow", reason: "manual" } }).reason, /shadow \(manual\)/);
  const fell = sh.landingPolicy({ selection: selection({ decision: "full", fallback_reasons: [{ code: "config_seam" }, { code: "config_seam" }] }), state: active });
  assert.deepEqual([fell.gate, fell.reason], ["full", "selection fell back: config_seam"]);
  const held = sh.landingPolicy({ selection: selection(), state: { ...active, suspended_categories: { "engine-module": {} } } });
  assert.deepEqual([held.gate, held.reason], ["full", "selection is suspended for engine-module after a recorded miss"]);
  assert.equal(sh.landingPolicy({ selection: selection(), state: { ...active, suspended_categories: { all: {} } } }).gate, "full");
  assert.equal(sh.landingPolicy({ selection: selection(), state: { state: "active" } }).gate, "affected", "a state without a suspension map suspends nothing");
  const reduced = sh.landingPolicy({ selection: selection(), state: active, alwaysRequired: ["coord/z.test.js", "coord/x.test.js"] });
  assert.deepEqual([reduced.gate, reduced.tier, reduced.suites, reduced.always_required_checks], ["affected", "T1", ["coord/x.test.js", "coord/z.test.js"], ["owner-lease"]]);
  assert.deepEqual(sh.landingPolicy({ selection: selection(), state: active }).suites, ["coord/x.test.js"]);
});
