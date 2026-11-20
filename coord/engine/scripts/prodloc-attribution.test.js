"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const arch = require("./arch-checks.js");
const file = "coord/scripts/fixture.js";
const checks = Object.fromEntries(arch.CHECKS.map(check => [check, { severity: check === "prodloc" ? "fail" : "off" }]));
const files = n => [{ file, source: "void 0;\n".repeat(n) }];
const absolute = n => arch.runChecks({ files: files(n), config: { checks } });
const ratchet = (before, after) => arch.runChecks({ files: files(after), config: { checks, archGate: "ratchet" }, baselineFindings: absolute(before).findings });

test("real ratchet consumer reports growth on inherited debt as new and blocks it", () => {
  const report = ratchet(1201, 1205);
  assert.equal(report.summary.result, "fail"); assert.equal(report.summary.new, 1);
  const delta = report.summary.prodloc_attribution[0];
  assert.equal(delta.file, file); assert.equal(delta.baseline_loc, 1201); assert.equal(delta.current_loc, 1205);
  assert.equal(delta.inherited_excess, 1); assert.equal(delta.added_loc, 4); assert.equal(delta.added_excess, 4);
  assert.equal(delta.classification, "new");
  const rendered = arch.formatArchSummary(report.summary);
  assert.ok(rendered.includes(file)); assert.match(rendered, /inherited=1/); assert.match(rendered, /added=4/);
});
test("unchanged and reduced inherited production debt remains blocking without grandfathering", () => {
  for (const after of [1205, 1203]) {
    const report = ratchet(1205, after);
    assert.equal(report.summary.result, "fail"); assert.equal(report.summary.new, 0); assert.equal(report.summary.preExisting, 1);
    assert.equal(report.summary.prodloc_attribution[0].added_loc, after - 1205);
  }
  assert.equal(ratchet(1205, 1200).summary.result, "pass");
});
test("attribution preserves stable identity, input records and other checks' existing policy", () => {
  const before = absolute(1201).findings, current = absolute(1205).findings;
  const snapshot = JSON.stringify([before, current]);
  const report = arch.classifyFindingsAgainstBaseline(current, before);
  assert.equal(report.newFindings.length, 1);
  assert.equal(arch.stableFindingKey(before[0]), arch.stableFindingKey(current[0]));
  assert.equal(JSON.stringify([before, current]), snapshot);
  const oldSize = { ...before[0], check: "size", severity: "warn" }, newSize = { ...current[0], check: "size", severity: "warn" };
  const size = arch.summarizeRatchet([newSize], arch.mergeConfig({ archGate: "ratchet" }), 1, [oldSize]);
  assert.equal(size.result, "pass"); assert.equal(size.preExisting, 1);
});
test("a newly breached file is new even without a prior over-budget finding", () => {
  const report = ratchet(1199, 1202);
  assert.equal(report.summary.result, "fail"); assert.equal(report.summary.new, 1);
  assert.equal(report.summary.prodloc_attribution[0].inherited_excess, 0);
  assert.equal(report.summary.prodloc_attribution[0].added_excess, 2);
  assert.equal(report.summary.prodloc_attribution[0].baseline_loc, null, "absence of a finding is not a measured baseline LOC");
});
test("a lowered threshold is distinguished from added source lines", () => {
  const before = absolute(1201).findings, current = [{ ...before[0], threshold: 1199 }];
  const classified = arch.classifyFindingsAgainstBaseline(current, before);
  const delta = classified.prodlocAttribution[0];
  assert.equal(classified.newFindings.length, 1); assert.equal(delta.inherited_excess, 1);
  assert.equal(delta.added_loc, 0); assert.equal(delta.added_excess, 0); assert.equal(delta.budget_excess_change, 1);
  assert.equal(delta.baseline_budget, 1200); assert.equal(delta.declared_budget, 1199);
});
test("real Git CLI reports the current contribution and returns failure on layered production debt", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-loc-delta-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args) => { const r = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(path.join(root, "coord/scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, file), files(1201)[0].source);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ checks }));
  git("init", "-b", "main"); git("add", "--all"); git("commit", "-m", "inherited breach"); const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, file), files(1205)[0].source);
  const result = spawnSync(process.execPath, [path.join(__dirname, "arch-checks.js"), "classify", "--root", root, "--config", path.join(root, "config.json"), "--ratchet", "--baseline", base], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /arch: fail/); assert.ok(result.stdout.includes(file));
  assert.match(result.stdout, /inherited=1/); assert.match(result.stdout, /added=4/);
  assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});
