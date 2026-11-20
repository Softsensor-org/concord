"use strict";

// COORD-924: affected-test selection — ownership, graph, generated rules and
// every conservative fallback, with its stated reason.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sel = require("./affected-selector.js");
const { initRepo, git } = require("./affected-evaluation.js");
const fixtures = require("./__fixtures__/affected-selection-faults.js");
const runner = require("./test-runner.js");

const E = "coord/engine/scripts/";
const WORKSPACE = path.resolve(__dirname, "..", "..", "..");

function fixtureRepo(t) {
  const root = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord924-sel-")), fixtures.repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function pick(root, changes, extra = {}) {
  return sel.selectAffected({ root, base: "HEAD", head: null, changes, policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry, ...extra });
}

const codes = (r) => r.fallback_reasons.map((f) => f.code);
const suites = (r) => r.selected.map((s) => s.suite);

test("COORD-924: ownership and the module graph select suites; the rest are omitted with a reason", (t) => {
  const root = fixtureRepo(t);
  const r = pick(root, [{ status: "M", path: `${E}math.js` }]);
  assert.equal(r.decision, "selected");
  assert.equal(r.mode, "selection");
  assert.equal(r.policy_version, null, "the fixture policy is unversioned");
  assert.equal(r.authorizes_landing, false);
  // COORD-966: coord/scripts/fmt.js:2 resolves statically (its spec is a literal), so loader and
  // shim no longer reach an unresolved site and neither reaches math.js; only plugins/host.js:2
  // (a computed path) still widens (COORD-953).
  assert.deepEqual(suites(r), [`${E}math.test.js`, `${E}plugins.test.js`, `${E}report.test.js`]);
  assert.deepEqual(r.selected[0].reasons, [`reaches ${E}math.js (head graph)`]);
  assert.equal(r.omitted.length, 6);
  assert.equal(r.omitted[0].reason, "no changed file reaches this suite in the head or base graph");
  assert.deepEqual([r.tier, r.categories], ["T1", ["shared-helper"]]);
  assert.deepEqual(r.always_required_checks, ["fixture-owner"]);
  const own = pick(root, [{ status: "M", path: `${E}math.test.js` }]);
  // COORD-966: loader and shim are no longer unresolved readers (static fmt.js edge); plugins still widens (COORD-953)
  assert.deepEqual([suites(own), own.selected.find((s) => s.suite === `${E}math.test.js`).reasons[0], own.tier, own.categories], [[`${E}math.test.js`, `${E}plugins.test.js`], "changed suite", "T0", ["test-only"]]);
  const viaShim = pick(root, [{ status: "M", path: `${E}fmt.js` }]);
  // COORD-953: widened, plugins.test.js reaches the unresolved site in plugins/host.js (human-admin decision 2026-11-12)
  assert.deepEqual(suites(viaShim), [`${E}loader.test.js`, `${E}plugins.test.js`, `${E}shim.test.js`], "resolveEngineModule and the registered shim both reach fmt.js");
  const generated = pick(root, [{ status: "M", path: "coord/MANIFEST.json" }]);
  // COORD-953: widened, the manifest suite is looked up by name (the unresolved readers sort before it) (human-admin decision 2026-11-12)
  // COORD-966: a generated file selects its checker suite; a suite that only names the file in a string is not a dependent
  assert.deepEqual(generated.selected.find((s) => s.suite === `${E}manifest.test.js`).reasons, ["checks generated file coord/MANIFEST.json"]);
  const added = "coord/new-generated.json";
  const newArtifact = pick(root, [{ status: "A", path: added }], {
    policy: { ...fixtures.policy, generated_files: [{ path: added, suites: [`${E}manifest.test.js`] }] },
  });
  assert.deepEqual(newArtifact.selected.find((s) => s.suite === `${E}manifest.test.js`).reasons,
    [`checks generated file ${added}`]);
  const unattributed = pick(root, [{ status: "M", path: "coord/rendered/TASKS.md" }], { policy: { ...fixtures.policy, generated_patterns: ["^coord/rendered/"] } });
  assert.deepEqual([unattributed.decision, codes(unattributed), unattributed.categories], ["full", ["unattributed_generated"], ["generated"]]);
  const docs = pick(root, [{ status: "M", path: "README.md" }]);
  // COORD-953: widened, the unresolved-site readers are selected for a doc change too (human-admin decision 2026-11-12)
  // COORD-966: loader and shim reach no unresolved site any more (fmt.js:2 is static); plugins/host.js:2 still widens
  assert.deepEqual([docs.decision, suites(docs), docs.tier, docs.categories], ["selected", [`${E}plugins.test.js`], "T0", []]);
});

test("COORD-924: every fallback states its reason, and a fallback omits nothing", (t) => {
  const root = fixtureRepo(t);
  const cases = [
    [`${E}upgrade.js`, "t2_surface", "implementation of T2 guard fixture-upgrade"],
    [`${E}owner.js`, "always_enforced_guard", "implementation of always_enforced guard fixture-owner"],
    ["coord/project.config.js", "config_seam", "policy fallback path ^coord/project\\.config\\.js$"],
    ["package-lock.json", "dependency_change", "policy fallback path (^|/)(package\\.json|package-lock\\.json)$"],
    [`${E}plugins/greet.js`, "dynamic_dependency", `unknown dynamic load at ${E}plugins/host.js:2 (path.join(__dirname, name));)`],
  ];
  for (const [file, code, detail] of cases) {
    const r = pick(root, [{ status: "M", path: file }]);
    assert.equal(r.decision, "full", file);
    assert.deepEqual(r.omitted, [], "the full gate omits nothing");
    assert.deepEqual(r.fallback_reasons[0], { code, path: file, detail }, file);
  }
  fs.writeFileSync(path.join(root, `${E}orphan.js`), "exports.x = 1;\n");
  git(root, ["add", "-A"]);
  const orphan = pick(root, [{ status: "A", path: `${E}orphan.js` }]);
  assert.deepEqual(codes(orphan), ["unknown_dependents"]);
  assert.match(orphan.fallback_reasons[0].detail, /may be loaded dynamically/);
  assert.equal(pick(root, [{ status: "M", path: `${E}upgrade.js` }]).tier, "T2");
});

test("COORD-924: incomplete analysis falls back: no registry, an unreadable tree, a bad ref", (t) => {
  const root = fixtureRepo(t);
  const noRegistry = pick(root, [{ status: "M", path: `${E}math.js` }], { registry: null });
  assert.deepEqual(codes(noRegistry), ["incomplete_analysis"]);
  assert.match(noRegistry.fallback_reasons[0].detail, /guard registry unreadable/);
  const badRef = sel.selectAffected({ root, base: "no-such-ref", head: "HEAD", policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry });
  assert.deepEqual([badRef.decision, codes(badRef)], ["full", ["incomplete_analysis"]]);
  assert.deepEqual(badRef.changes, []);
  const badHead = sel.selectAffected({ root, base: "HEAD", head: "no-such-ref", changes: [{ status: "M", path: "README.md" }], policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry });
  assert.ok(codes(badHead).every((c) => c === "incomplete_analysis") && codes(badHead).length >= 1);
  const broken = path.join(root, `${E}loader.js`);
  fs.rmSync(broken);
  const unreadable = pick(root, [{ status: "M", path: `${E}fmt.js` }]);
  assert.ok(codes(unreadable).includes("incomplete_analysis"), "a tracked file that cannot be read makes the analysis incomplete");
  const fromHead = sel.selectAffected({ root, base: "HEAD", head: "HEAD", changes: [{ status: "M", path: "README.md" }], policy: fixtures.policy });
  assert.deepEqual(codes(fromHead), ["incomplete_analysis"], "the fixture has no guard registry at head");
  const fromTree = sel.selectAffected({ root, base: "HEAD", head: null, changes: [{ status: "M", path: "README.md" }], policy: fixtures.policy });
  assert.ok(fromTree.fallback_reasons.some((f) => /guard registry unreadable/.test(f.detail)), "nor in its working tree");
  fs.mkdirSync(path.join(root, "coord/engine"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord/engine/governance-guards.json"), JSON.stringify(fixtures.registry));
  const withTree = sel.selectAffected({ root, base: "HEAD", head: null, changes: [{ status: "M", path: "README.md" }], policy: fixtures.policy, shimRegistry: null });
  assert.deepEqual(withTree.always_required_checks, ["fixture-owner"], "the working-tree registry is read when head is the working tree");
});

test("COORD-924: renames and deletes are judged on the base graph, with move categories", (t) => {
  const root = fixtureRepo(t);
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["mv", `${E}fmt.js`, `${E}format.js`]);
  git(root, ["rm", "-q", `${E}__fixtures__/table.json`]);
  git(root, [...["-c", "user.email=t@example.invalid", "-c", "user.name=t"], "commit", "-qm", "move"]);
  const r = sel.selectAffected({ root, base, head: "HEAD", policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry });
  assert.deepEqual(r.changes, [
    { status: "D", path: `${E}__fixtures__/table.json` },
    { status: "R", old_path: `${E}fmt.js`, path: `${E}format.js` },
  ]);
  assert.equal(r.decision, "selected");
  // COORD-953: widened, suite reaching unresolved site plugins/host.js:2 added (human-admin decision 2026-11-12)
  // COORD-966: the rename of fmt.js still reaches loader and shim through static edges
  assert.deepEqual(suites(r), [`${E}loader.test.js`, `${E}plugins.test.js`, `${E}report.test.js`, `${E}shim.test.js`]);
  assert.deepEqual(r.categories, ["engine-module", "fixture", "rename-move-delete", "shared-helper", "shim-registered-move"]);
  const deletedSuite = sel.selectAffected({ root, base, head: "HEAD", changes: [{ status: "D", path: `${E}math.test.js` }], policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry });
  // COORD-953: widened, the readers of unresolved sites are selected for the deletion too (human-admin decision 2026-11-12)
  assert.deepEqual([deletedSuite.decision, suites(deletedSuite)], ["selected", [`${E}plugins.test.js`]], "a deleted suite needs no run of its own; only the unresolved reader (plugins/host.js) still runs (COORD-966: loader and shim have no unresolved site and do not reach math.js)");
  const universe = pick(root, [{ status: "M", path: `${E}math.js` }], { universe: [`${E}math.test.js`, `${E}limits.test.js`] });
  assert.deepEqual([suites(universe), universe.omitted.map((o) => o.suite)], [[`${E}math.test.js`], [`${E}limits.test.js`]], "a cut's inventory bounds the suites");
});

test("COORD-924: changed paths come from git with rename detection", (t) => {
  const root = fixtureRepo(t);
  fs.writeFileSync(path.join(root, "README.md"), "# edited\n");
  fs.writeFileSync(path.join(root, "new.md"), "# new\n");
  git(root, ["add", "-A"]);
  assert.deepEqual(sel.changedPaths(root, "HEAD", null), [{ status: "M", path: "README.md" }, { status: "A", path: "new.md" }]);
  assert.throws(() => sel.changedPaths(root, "nope", null), /git diff/);
});

test("COORD-924: the real policy, registry and inventory drive the selector's surfaces", () => {
  const policy = sel.loadPolicy();
  assert.deepEqual([policy.initial_state, policy.policy_version], ["active", 2], "the real policy reflects COORD-941 activation");
  const fallback = (rel) => (sel.matchFallback(policy, rel) || {}).reason || null;
  assert.equal(fallback("frontend/apps/coord-ui/package-lock.json"), "dependency_change");
  assert.equal(fallback("coord/project.config.js"), "config_seam");
  assert.equal(fallback(`${E}engine-coverage-baseline-node22.json`), "coverage_baseline");
  assert.equal(fallback("release/verify-dual-release.sh"), "t2_surface");
  assert.equal(fallback("release/suite-titles.test.js"), null, "release suites are test-only");
  assert.equal(fallback(`${E}coord-upgrade-bridge.js`), "t2_surface");
  assert.equal(fallback("coord/docs/decisions/0021-x.md"), "t2_surface");
  assert.equal(fallback(`${E}affected-selector.js`), "selector_change");
  assert.equal(fallback("coord/engine/test-policy.json"), "selector_change", "a policy change forces the full gate");
  assert.equal(fallback("coord/engine/scripts/test-policy-run.js"), "selector_change", "a resolver change forces the full gate");
  assert.equal(fallback(`${E}math.js`), null);
  const registry = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "coord/engine/governance-guards.json"), "utf8"));
  const surfaces = sel.registrySurfaces(registry);
  assert.ok(surfaces.always.has(`${E}test-runner.js`) && surfaces.always.has(`${E}enterprise/development-policy-broker.js`));
  assert.ok(surfaces.t2.has(`${E}coord-upgrade.js`));
  assert.deepEqual(sel.registrySurfaces(null), { t2: new Map(), always: new Map(), alwaysIds: [] });
  assert.deepEqual(sel.registrySurfaces({ guards: [{ id: "x", tier: "T2" }] }).t2, new Map(), "a guard without locations names no file");
  assert.deepEqual([...sel.shimPaths(null)], []);
  const shims = sel.shimPaths(JSON.parse(fs.readFileSync(path.join(WORKSPACE, "coord/engine/shim-registry.json"), "utf8")));
  assert.ok(shims.has("coord/scripts/governance.js") && shims.has(`${E}governance.js`));
  const inventory = runner.buildInventory().modules.flatMap((m) => m.files).sort();
  const tracked = git(WORKSPACE, ["ls-files"]).split("\n").filter(sel.isSuite).sort();
  assert.deepEqual(tracked.filter((f) => !inventory.includes(f)), [], "every selectable suite is in the runner inventory");
});

test("COORD-924: the selector digest covers its own files and policy", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-digest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const empty = sel.selectorDigest(dir);
  fs.writeFileSync(path.join(dir, "affected-graph.js"), "x");
  assert.notEqual(sel.selectorDigest(dir), empty);
  assert.match(sel.selectorDigest(), /^sha256:[0-9a-f]{64}$/);
  assert.equal(sel.selectorDigest(), sel.selectorDigest());
});

// COORD-1031 (ADR 0025 decision 2(b)): the core-surface clause. A change to the test runner, the
// journal, the integration-authority core or a shared fixture is a full-suite fallback with the
// core_surface reason; a change to an ordinary engine module is not.
test("COORD-1031 core surface: test runner, journal, integration authority and shared fixtures fall back to full", () => {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const policy = sel.loadPolicy();
  const registry = { guards: [] };
  const shimRegistry = { shims: [] };
  const core = [
    "coord/engine/scripts/test-runner.js",
    "coord/scripts/test-runner.js",
    "coord/engine/scripts/journal.js",
    "coord/engine/scripts/journal-chain.js",
    "coord/engine/scripts/integration-authority.js",
    "coord/engine/scripts/fixtures/fixture-governance-runner.js",
    "coord/scripts/fixtures/approved-reconcile.js",
  ];
  for (const rel of core) {
    const r = sel.selectAffected({ root: repo, base: "HEAD", head: null, changes: [{ status: "M", path: rel }], policy, registry, shimRegistry });
    assert.equal(r.decision, "full", rel);
    assert.ok(r.fallback_reasons.some((f) => f.code === "core_surface"), `${rel}: core_surface reason`);
  }
  const plain = sel.selectAffected({ root: repo, base: "HEAD", head: null, changes: [{ status: "M", path: "coord/engine/scripts/lifecycle-utils.js" }], policy, registry, shimRegistry });
  assert.equal(plain.fallback_reasons.some((f) => f.code === "core_surface"), false, "an ordinary module is not a core surface");
});
