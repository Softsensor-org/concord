"use strict";

// COORD-936 item 9(b): the conditional scheduled full run.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tp = require("./test-policy.js");
const sched = require("./test-policy-schedule.js");
const { gitFixture } = require("./test-git-fixture.js");

const POLICY = tp.effectivePolicy();
const HOUR = 3600000;


function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord936-sched-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["config", "user.email", "t@example.com"]);
  gitFixture(root, ["config", "user.name", "t"]);
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  write("docs/a.md", "a\n");
  write("coord/pinned.md", "p\n");
  write("coord/engine/scripts/x.js", "1\n");
  write("coord/engine-pin.json", JSON.stringify({ files: { "coord/pinned.md": {} } }));
  gitFixture(root, ["add", "-A"]);
  gitFixture(root, ["commit", "-qm", "qualified"]);
  const commit = (rel, body, when) => { write(rel, body); gitFixture(root, ["add", "-A"]); gitFixture(root, ["commit", "-qm", `edit ${rel}`], when ? { env: { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } } : {}); return gitFixture(root, ["rev-parse", "HEAD"]); };
  return { root, last: { commit: gitFixture(root, ["rev-parse", "HEAD"]) }, commit };
}

const gate = (selection = {}, wouldGate = {}) => () => ({
  selection: { tier: "T1", categories: ["engine-module"], selected: [{ suite: "a" }], ...selection },
  wouldGate: { gate: "affected", reason: "complete", ...wouldGate },
});

test("COORD-936: the scheduled full run skips an unchanged tree and ordinary docs, and runs without a previous success", (t) => {
  const w = repo(t);
  const decide = (o) => sched.scheduleDecision({ root: w.root, policy: POLICY, landingGateFor: () => assert.fail("no selection needed"), ...o });
  assert.deepEqual([decide({ last: null }).decision, decide({ last: null }).reason], ["run", "no previous successful full run"]);
  assert.equal(decide({ last: { commit: "0".repeat(40) } }).decision, "run", "an unknown last-qualified commit is no previous success");
  const unknownHead = decide({ last: null, head: "missing-head" });
  assert.equal(unknownHead.head, null, "a missing head is not recorded as a commit");
  assert.equal(unknownHead.decision, "run");
  const off = tp.effectivePolicy({ override: { stages: { nightly: { triggers: { no_previous_success: false } } } } });
  assert.equal(sched.scheduleDecision({ root: w.root, policy: off, last: null }).reason, "no previous successful full run, and the trigger is off");
  const unchanged = decide({ last: w.last });
  assert.deepEqual([unchanged.decision, unchanged.reason, unchanged.last_qualified], ["skip", "unchanged tree since the last successful full run", w.last.commit]);
  w.commit("docs/a.md", "b\n");
  assert.deepEqual([decide({ last: w.last }).decision, decide({ last: w.last }).reason], ["skip", "ordinary docs-only changes (1 file(s))"]);
});

test("COORD-936: significance, not commit count, triggers the scheduled run; every decision is recorded", (t) => {
  const w = repo(t);
  const now = Date.now();
  const decide = (landingGateFor, policy = POLICY) => sched.scheduleDecision({ root: w.root, policy, last: w.last, now, landingGateFor });
  w.commit("coord/pinned.md", "q\n");
  assert.match(decide(gate()).reason, /below every significance trigger: 1 file\(s\), 1 suite\(s\)/, "a pinned document is not an ordinary doc, but a small change stays below the triggers");
  assert.match(decide(gate({ tier: "T2" })).reason, /^t2_change: a high-risk change$/);
  assert.match(decide(gate({}, { gate: "full", reason: "selection fell back: unknown_dependents" })).reason, /^unknown_impact: selection fell back: unknown_dependents$/);
  assert.match(decide(gate({ categories: ["shared-helper"] })).reason, /^shared_helper: a shared library changed$/);
  assert.match(decide(gate({ selected: Array.from({ length: 25 }, (_, i) => ({ suite: `s${i}` })) })).reason, /^affected components: 25 suites reached \(trigger 25\)$/);
  const quiet = tp.effectivePolicy({ override: { stages: { nightly: { triggers: { t2_change: false, min_affected_suites: 1000 } } } } });
  assert.equal(decide(gate({ tier: "T2" }), quiet).decision, "skip", "triggers are team-configurable");
  const old = new Date(now - 30 * HOUR).toISOString();
  w.commit("coord/engine/scripts/x.js", "2\n", old);
  const aged = decide(gate());
  assert.equal(aged.decision, "run");
  assert.match(aged.reason, /max_unqualified_hours: the oldest unqualified change is 3\d(\.\d)? h old \(trigger 24 h\)/);
  assert.equal(sched.oldestUnqualifiedHours(w.root, "HEAD", "HEAD", now), 0);
  const dir = path.join(w.root, ".runtime-test");
  sched.recordDecision(dir, aged);
  sched.recordDecision(dir, { decision: "skip", reason: "r" });
  assert.deepEqual(fs.readFileSync(path.join(dir, sched.DECISIONS), "utf8").trim().split("\n").map((l) => JSON.parse(l).decision), ["run", "skip"]);
  assert.equal(sched.readLastQualified(dir), null);
  sched.writeLastQualified(dir, { commit: "c" });
  assert.deepEqual([sched.readLastQualified(dir).commit, sched.readLastQualified(null, path.join(dir, sched.LAST_QUALIFIED)).commit], ["c", "c"]);
});

test("COORD-936: an unreadable pin at the head means no file is treated as pinned; the real selector decides otherwise", (t) => {
  const w = repo(t);
  fs.writeFileSync(path.join(w.root, "coord/engine-pin.json"), "{broken");
  w.commit("docs/a.md", "c\n");
  assert.equal(sched.scheduleDecision({ root: w.root, policy: POLICY, last: w.last, landingGateFor: gate() }).decision, "skip");
  w.commit("coord/engine-pin.json", "{}");
  w.commit("coord/pinned.md", "r\n");
  const real = sched.scheduleDecision({ root: w.root, policy: POLICY, last: w.last });
  assert.match(real.reason, /^unknown_impact: selection fell back: incomplete_analysis/, "with the real COORD-924 selector and no guard registry, impact is unknown and the full run is due");
});

test("COORD-936: the scheduled decision examines the cumulative change since the last successful full run, not the latest commit", (t) => {
  const w = repo(t);
  // Each changed engine file reaches 15 suites: one alone is below the 25-suite trigger, two together are not.
  const byFiles = (o) => {
    const files = tp.changedFiles(w.root, o.base, o.head).filter((f) => f.endsWith(".js"));
    return { selection: { tier: "T1", categories: ["engine-module"], selected: files.flatMap((f) => Array.from({ length: 15 }, (_, i) => ({ suite: `${f}:${i}` }))) }, wouldGate: { gate: "affected", reason: "complete" } };
  };
  const first = w.commit("coord/engine/scripts/x.js", "2\n");
  const afterOne = sched.scheduleDecision({ root: w.root, policy: POLICY, last: w.last, landingGateFor: byFiles });
  assert.deepEqual([afterOne.decision, afterOne.affected_suites], ["skip", 15], "one small commit is below the trigger");
  w.commit("coord/engine/scripts/y.js", "1\n");
  const latestOnly = sched.scheduleDecision({ root: w.root, policy: POLICY, last: { commit: first }, landingGateFor: byFiles });
  assert.equal(latestOnly.decision, "skip", "judged from the latest commit alone the second change is small too");
  const cumulative = sched.scheduleDecision({ root: w.root, policy: POLICY, last: w.last, landingGateFor: byFiles });
  assert.deepEqual([cumulative.decision, cumulative.reason], ["run", "affected components: 30 suites reached (trigger 25)"], "together, since the last successful run, they trigger it");
});
