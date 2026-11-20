"use strict";
// COORD-958: the merged engine-surface check replaces template-sync and engine-pin. These tests
// prove (1) every recorded refusal and admission of the two old guards is unchanged (golden
// equivalence, captured on origin/dev before the merge), (2) each must-still-cover incident keeps a
// regression that the merged check enforces, and (3) the regenerate-and-verify step can only touch
// its own target checkout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { gitFixture } = require("./test-git-fixture.js");
const engineSurface = require("./engine-surface-integrity.js");
const createEnginePin = require("./engine-pin.js");
const harness = require("./__fixtures__/engine-surface-equivalence-harness.js");
const golden = require("./__fixtures__/engine-surface-equivalence.json");

const sha = (text) => crypto.createHash("sha256").update(Buffer.from(text)).digest("hex");

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-958-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["add", "--all"]);
  return root;
}

function manifestWith(entries) {
  return JSON.stringify({ schema_version: 1, manifest_version: "t-1", items: entries.map(([p, c]) => ({ path: p, match_policy: "exact", checksum: { algo: "sha256", hex: sha(c), bytes: Buffer.byteLength(c) } })) }, null, 2) + "\n";
}

// 1. Golden equivalence: the merged code replays every recorded outcome of the two old guards.
test("COORD-958: every recorded template-sync and engine-pin outcome is unchanged (golden replay)", () => {
  const live = harness.runCases();
  assert.equal(live.length, golden.cases.length, "case count");
  for (let i = 0; i < golden.cases.length; i += 1) {
    assert.equal(live[i].name, golden.cases[i].name, `case ${i} name`);
    assert.deepEqual(live[i].outcome, golden.cases[i].outcome, `case ${i} differs: ${golden.cases[i].name}`);
  }
});

// 2. No protection lost: every old refusal case still refuses, every admission still admits.
test("COORD-958: each template-sync and engine-pin refusal still refuses and each admission still admits", () => {
  const refusals = golden.cases.filter((c) => (c.outcome.exit !== undefined && c.outcome.exit !== 0) || c.outcome.refused || c.outcome.threw || (Array.isArray(c.outcome.problems) && c.outcome.problems.length) || (Array.isArray(c.outcome.drifted_files) && c.outcome.drifted_files.length) || c.outcome.ok === false || (c.outcome.failures && c.outcome.failures.length));
  const admissions = golden.cases.filter((c) => !refusals.includes(c));
  assert.ok(refusals.length >= 20, `expected at least 20 refusal cases, got ${refusals.length}`);
  assert.ok(admissions.length >= 8, `expected at least 8 admission cases, got ${admissions.length}`);
  const live = new Map(harness.runCases().map((c) => [c.name, c.outcome]));
  for (const c of refusals) assert.deepEqual(live.get(c.name), c.outcome, `refusal no longer identical: ${c.name}`);
  for (const c of admissions) assert.deepEqual(live.get(c.name), c.outcome, `admission no longer identical: ${c.name}`);
});

// 3. COORD-606/607: an untracked engine-managed file fails the coverage audit (manifest-level guard).
test("COORD-606/607: an untracked engine-managed file still fails the coverage audit", () => {
  const golden607 = golden.cases.find((c) => c.name.startsWith("coverage: untracked"));
  assert.equal(golden607.outcome.exit, 1);
  assert.match(golden607.outcome.output, /\[UNTRACKED\] coord\/engine\/scripts\/journal\.js/);
});

// 4. COORD-677: the independent post-build pin check catches an engine file changed after the pin.
test("COORD-677: merged surface check refuses when an engine file drifts after pin (independent of the manifest)", () => {
  const root = tmpRepo({
    "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/engine/scripts/lifecycle.js", "a\n"]]),
    "coord/engine/scripts/lifecycle.js": "a\n",
  });
  try {
    const coordDir = path.join(root, "coord");
    createEnginePin({ coordDir }).pin();
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, true);
    fs.writeFileSync(path.join(root, "coord/engine/scripts/lifecycle.js"), "edited\n");
    const verdict = engineSurface.verifySurface({ coordDir });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("verify-engine drift: coord/engine/scripts/lifecycle.js (changed)")), verdict.problems.join(" | "));
    assert.ok(verdict.problems.some((p) => p.startsWith("check-template-sync drift: coord/engine/scripts/lifecycle.js (checksum-drift)")), verdict.problems.join(" | "));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 5. Failure mode A: a squash-merged manifest with a stale checksum cannot survive the step.
test("regenerate-and-verify repairs a stale checksum carried by a squash merge and re-verifies", () => {
  const root = tmpRepo({
    "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/engine/scripts/lifecycle.js", "old\n"]]),
    "coord/engine/scripts/lifecycle.js": "new squashed bytes\n",
  });
  try {
    const coordDir = path.join(root, "coord");
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, false, "stale checksum must be visible before the step");
    const result = engineSurface.regenerateAndVerify({ invokedRoot: root, targetRoot: root, useGit: true });
    assert.equal(result.ok, true);
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, true, "one step leaves both surfaces agreeing");
    const manifest = JSON.parse(fs.readFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), "utf8"));
    const item = manifest.items.find((i) => i.path === "coord/engine/scripts/lifecycle.js");
    assert.equal(item.checksum.hex, sha("new squashed bytes\n"));
    fs.unlinkSync(result.manifest_path);
    const rebuilt = engineSurface.regenerateAndVerify({ invokedRoot: root });
    assert.equal(rebuilt.pin_path, path.join(coordDir, "engine-pin.json"));
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, true);
    const recreated = JSON.parse(fs.readFileSync(rebuilt.manifest_path, "utf8"));
    assert.equal(recreated.items.find((entry) => entry.path === item.path).checksum.hex, item.checksum.hex);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 6. Failure mode B: an edit after the stamp is caught until the one step is re-run.
test("a post-merge edit is refused until regenerate-and-verify is re-run", () => {
  const root = tmpRepo({
    "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/engine/scripts/lifecycle.js", "a\n"]]),
    "coord/engine/scripts/lifecycle.js": "a\n",
  });
  try {
    const coordDir = path.join(root, "coord");
    engineSurface.regenerateAndVerify({ invokedRoot: root, targetRoot: root });
    fs.writeFileSync(path.join(root, "coord/engine/scripts/lifecycle.js"), "post-merge edit\n");
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, false, "unstamped edit must refuse");
    engineSurface.regenerateAndVerify({ invokedRoot: root, targetRoot: root });
    assert.equal(engineSurface.verifySurface({ coordDir }).ok, true, "re-running the one step re-stamps");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 7. The regenerate step tracks a new engine-managed file, so the COORD-607 refusal cannot survive it.
test("regenerate-and-verify tracks a new engine-managed file instead of leaving it untracked (COORD-607)", () => {
  const root = tmpRepo({
    "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/engine/scripts/lifecycle.js", "a\n"]]),
    "coord/engine/scripts/lifecycle.js": "a\n",
  });
  try {
    fs.writeFileSync(path.join(root, "coord/engine/scripts/brand-new.js"), "new\n");
    gitFixture(root, ["add", "--all"]);
    engineSurface.regenerateAndVerify({ invokedRoot: root, targetRoot: root });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "coord/TEMPLATE_SYNC_MANIFEST.json"), "utf8"));
    assert.ok(manifest.items.some((i) => i.path === "coord/engine/scripts/brand-new.js"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 8. Target safety: a ticket worktree is regenerated only by its own script copy.
test("regenerate refuses a ticket-worktree target when run from the canonical checkout", () => {
  const canon = tmpRepo({ "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/a.js", "a\n"]]), "coord/a.js": "a\n" });
  const wt = path.join(canon, "coord", ".worktrees", "claudea805", "COORD-958");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "x.txt"), "x\n");
  try {
    const before = fs.readFileSync(path.join(canon, "coord/TEMPLATE_SYNC_MANIFEST.json"), "utf8");
    assert.throws(
      () => engineSurface.regenerateAndVerify({ invokedRoot: canon, targetRoot: wt }),
      (error) => error instanceof engineSurface.EngineSurfaceRefusal && /is a ticket worktree/.test(error.message) && /canonical checkout/.test(error.message)
    );
    assert.equal(fs.readFileSync(path.join(canon, "coord/TEMPLATE_SYNC_MANIFEST.json"), "utf8"), before, "canonical manifest untouched");
  } finally {
    fs.rmSync(canon, { recursive: true, force: true });
  }
});

test("refuseCanonicalTarget admits a worktree's own copy and any non-worktree target", () => {
  const wt = "/srv/ws/repo/coord/.worktrees/claudea805/COORD-958";
  assert.equal(engineSurface.isTicketWorktree(wt), true);
  assert.equal(engineSurface.isTicketWorktree("/srv/ws/repo"), false);
  assert.doesNotThrow(() => engineSurface.refuseCanonicalTarget(wt, wt));
  assert.doesNotThrow(() => engineSurface.refuseCanonicalTarget("/srv/ws/repo", "/srv/ws/repo"));
  assert.throws(() => engineSurface.refuseCanonicalTarget("/srv/ws/repo", wt), /is a ticket worktree/);
});

// 9. Operator shape: the merged step is one command and reports both surfaces.
test("the verify-engine flag map carries the single --regenerate step beside --pin", () => {
  const cli = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");
  assert.match(cli, /"--regenerate": "regenerate"/);
  assert.match(cli, /"--pin": "pin"/);
});

test("COORD-1052: engine root discovery resolves nested Git paths and declines a nonrepository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-surface-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(engineSurface.gitToplevel(root), null);
  gitFixture(root, ["init", "-q"]);
  const nested = path.join(root, "coord", "engine");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(engineSurface.gitToplevel(nested), fs.realpathSync(root));
  const spacedRoot = path.join(root, "nested repository ");
  fs.mkdirSync(spacedRoot);
  gitFixture(spacedRoot, ["init", "-q"]);
  assert.equal(engineSurface.gitToplevel(spacedRoot), fs.realpathSync(spacedRoot));
  assert.equal(engineSurface.gitToplevel(path.join(root, "missing")), null);
});

test("COORD-1052: invalid surface manifest entries refuse without rewriting the manifest or authored file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-surface-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "keep.js"), manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(source, "authored bytes\n");
  for (const [item, expected] of [[null, /missing a non-empty path/], [{ path: "keep.js" }, /valid sha256 checksum contract/]]) {
    const bytes = JSON.stringify({ schema_version: 1, items: [item] });
    fs.writeFileSync(manifestPath, bytes);
    assert.throws(() => engineSurface.evaluateTemplateSync({ repoRoot: root, manifestPath }), expected);
    assert.equal(fs.readFileSync(source, "utf8"), "authored bytes\n");
    assert.equal(fs.readFileSync(manifestPath, "utf8"), bytes);
  }
});

test("regeneration refuses when the post-stamp coverage audit detects an untracked file", (t) => {
  const root = tmpRepo({
    "coord/TEMPLATE_SYNC_MANIFEST.json": manifestWith([["coord/engine/scripts/lifecycle.js", "a\n"]]),
    "coord/engine/scripts/lifecycle.js": "a\n",
  });
  const discovery = require("./template-sync-discovery.js");
  const audit = discovery.auditCoverage;
  t.after(() => { discovery.auditCoverage = audit; fs.rmSync(root, { recursive: true, force: true }); });
  discovery.auditCoverage = () => ({ ok: false, untracked: ["coord/engine/scripts/late.js"] });
  assert.throws(() => engineSurface.regenerateAndVerify({ invokedRoot: root }), /untracked engine-managed file\(s\): coord\/engine\/scripts\/late\.js/);
});

test("surface evaluation reports an external manifest path and missing version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-external-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "surface-manifest-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); });
  const manifestPath = path.join(external, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, items: [{ path: "missing", checksum: { algo: "sha256", hex: sha(""), bytes: 0 } }] }));
  const { summary } = engineSurface.evaluateTemplateSync({ repoRoot: root, manifestPath });
  assert.equal(summary.manifest_path, manifestPath);
  assert.equal(summary.manifest_version, null);
  assert.equal(summary.failures[0].status, "missing");
});

test("engine surface discovery treats an empty successful Git probe as no toplevel", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-git-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    assert.equal(engineSurface.gitToplevel(root), null);
  } finally {
    process.env.PATH = previousPath;
  }
});
