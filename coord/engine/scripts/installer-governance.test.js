"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createInstallerGovernance } = require("./installer-governance.js");

test("installer governance uses the target lifecycle and consumes transaction authority once", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "installer-governance-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const coord = path.join(workspace, "coord");
  const scripts = path.join(coord, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(coord, "project.config.js"), "module.exports = { repos: {} };\n");
  const snapshotPath = path.join(coord, ".runtime/governance-snapshots", `${"a".repeat(40)}.json`);
  const journalPath = path.join(coord, ".runtime/governance-events.ndjson");
  const latestPath = path.join(coord, ".runtime/governance-latest-snapshot.json");
  fs.writeFileSync(path.join(scripts, "lifecycle.js"), `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = ${JSON.stringify(coord)};
    let events = [];
    module.exports.installerGovernance = {
      buildSnapshot: () => ({ digest: ${JSON.stringify("a".repeat(40))}, files: [] }),
      snapshotArtifactPath: (digest) => path.join(root, ".runtime/governance-snapshots", digest + ".json"),
      readEventLog: () => events,
      verifyChain: (value) => ({
        ok: value.length > 0,
        chainedCount: value.filter((event) => event.command === "journal-baseline").length,
        preChainCount: value.filter((event) => event.command !== "journal-baseline").length,
      }),
      detectProvenanceDrift: () => ({ snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] }),
      ensureBaseline: () => {
        fs.mkdirSync(path.dirname(${JSON.stringify(snapshotPath)}), { recursive: true });
        fs.writeFileSync(${JSON.stringify(snapshotPath)}, "{}");
        fs.writeFileSync(${JSON.stringify(latestPath)}, "{}");
        events = [{ command: "journal-baseline", snapshot_digest: "a".repeat(40) }];
        fs.writeFileSync(${JSON.stringify(journalPath)}, JSON.stringify(events[0]) + "\\n");
        return true;
      },
      setEvents: (value) => { events = value; },
    };
  `);

  const api = createInstallerGovernance(workspace);
  const journal = api.inspectJournal();
  assert.equal(journal.status, "blocked");
  const authorized = [];
  const anchor = api.createGenesisAnchor((artifact, paths) => authorized.push({ artifact, paths }));
  assert.equal(anchor(), true);
  assert.equal(authorized.length, 1);
  assert.equal(authorized[0].artifact, snapshotPath);
  assert.deepEqual(authorized[0].paths.sort(), [
    "coord/.runtime/governance-events.ndjson",
    "coord/.runtime/governance-latest-snapshot.json",
    "coord/.runtime/governance-snapshots/" + "a".repeat(40) + ".json",
  ].sort());
  assert.equal(api.inspectJournal().status, "ready");
  require(path.join(scripts, "lifecycle.js")).installerGovernance.setEvents([
    { command: "legacy-record" },
    { command: "journal-baseline", snapshot_digest: "a".repeat(40) },
  ]);
  assert.equal(api.inspectJournal().status, "ready");
  assert.equal(api.inspectJournal().chain, "legacy-unverified");
  assert.throws(anchor, /already consumed/);

  const loader = path.resolve(__dirname, "installer-governance.js");
  const foreignConfig = path.resolve(__dirname, "../../project.config.js");
  const refusal = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(loader)}).createInstallerGovernance(${JSON.stringify(workspace)})`], {
    encoding: "utf8",
    env: { ...process.env, COORD_PROJECT_CONFIG: foreignConfig },
  });
  assert.notEqual(refusal.status, 0, "a donor config override cannot redirect target lifecycle services");
  assert.match(refusal.stderr, /COORD_PROJECT_CONFIG resolves outside this installed workspace/);
});

test("isolated target-local lifecycle services anchor two independent workspaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installer-governance-targets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceCoord = path.resolve(__dirname, "../..");
  const included = ["scripts", "engine", "board", "product", "prompts", "rendered", "paths.js", "project.config.js"];
  const workspaces = [path.join(root, "one"), path.join(root, "two")];
  for (const workspace of workspaces) {
    const targetCoord = path.join(workspace, "coord");
    fs.mkdirSync(targetCoord, { recursive: true });
    for (const item of included) {
      const source = path.join(sourceCoord, item);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(targetCoord, item), { recursive: true });
    }
  }

  const first = createInstallerGovernance(workspaces[0]);
  const second = createInstallerGovernance(workspaces[1]);
  const firstAnchor = first.createGenesisAnchor(() => {});
  const secondAnchor = second.createGenesisAnchor(() => {});
  assert.equal(firstAnchor(), true);
  assert.equal(secondAnchor(), true);
  const journals = workspaces.map((workspace) => fs.readFileSync(path.join(workspace, "coord/.runtime/governance-events.ndjson"), "utf8"));
  assert.notEqual(journals[0], "");
  assert.notEqual(journals[1], "");
  assert.equal(first.inspectJournal().status, "ready");
  assert.equal(second.inspectJournal().status, "ready");
  assert.equal(first.inspectJournal().event_count, 1);
  assert.equal(second.inspectJournal().event_count, 1);
});

test("readiness blocks a mapped repository symlink that resolves outside the workspace", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "installer-readiness-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "installer-readiness-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const coord = path.join(workspace, "coord");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "engine/scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "board"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workspace, "frontend"), "dir");
  fs.writeFileSync(path.join(coord, "project.config.js"), "module.exports = { repos: { F: { path: 'frontend' } } };\n");
  fs.writeFileSync(path.join(coord, "engine/scripts/lifecycle.js"), `module.exports.installerGovernance = {
    buildSnapshot: () => ({ digest: "d", files: [] }),
    snapshotArtifactPath: () => "${path.join(coord, ".runtime/d.json")}",
    readEventLog: () => [{ command: "journal-baseline", snapshot_digest: "d" }],
    verifyChain: () => ({ ok: true }),
    detectProvenanceDrift: () => ({ snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] }),
    ensureBaseline: () => false,
  };`);
  fs.writeFileSync(path.join(coord, "engine/scripts/static-config-declaration.js"), `module.exports.readDeclaredConfig = (file) => ({ status: "declared", declared: require(file) });`);
  fs.writeFileSync(path.join(coord, "paths.js"), "module.exports.validateProjectConfig = (config) => config;\n");
  fs.writeFileSync(path.join(coord, "board/board.js"), "module.exports.validateBoardState = () => true;\n");
  fs.writeFileSync(path.join(coord, "board/tasks.json"), JSON.stringify({ sections: [] }));

  const result = createInstallerGovernance(workspace).inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    {
      inside: (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`),
      coordRepoRoot: (root) => path.join(root, "coord"),
      captureRootGitState: (root) => ({ root, state: "established" }),
    },
  );
  assert.equal(result.checks.repo_mapping.status, "blocked");
  assert.match(result.checks.repo_mapping.invalid[0], /escapes workspace through a symlink/);
  assert.equal(result.status, "incomplete");
});

test("readiness blocks mappings that alias or overlap the Concord control-plane root", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "installer-readiness-coord-alias-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const coord = path.join(workspace, "coord");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "engine/scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "board"), { recursive: true });
  fs.writeFileSync(path.join(coord, "project.config.js"), "module.exports = { repos: { B: { path: 'coord' } } };\n");
  fs.writeFileSync(path.join(coord, "engine/scripts/lifecycle.js"), `module.exports.installerGovernance = {
    buildSnapshot: () => ({ digest: "d", files: [] }),
    snapshotArtifactPath: () => "${path.join(coord, ".runtime/d.json")}",
    readEventLog: () => [{ command: "journal-baseline", snapshot_digest: "d" }],
    verifyChain: () => ({ ok: true }),
    detectProvenanceDrift: () => ({ snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] }),
    ensureBaseline: () => false,
  };`);
  fs.writeFileSync(path.join(coord, "engine/scripts/static-config-declaration.js"), `module.exports.readDeclaredConfig = (file) => ({ status: "declared", declared: require(file) });`);
  fs.writeFileSync(path.join(coord, "paths.js"), "module.exports.validateProjectConfig = (config) => config;\n");
  fs.writeFileSync(path.join(coord, "board/board.js"), "module.exports.validateBoardState = () => true;\n");
  fs.writeFileSync(path.join(coord, "board/tasks.json"), JSON.stringify({ sections: [] }));
  fs.symlinkSync(coord, path.join(workspace, "control-alias"), "dir");

  const api = createInstallerGovernance(workspace);
  const inspect = () => api.inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    {
      inside: (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`),
      coordRepoRoot: (root) => path.join(root, "coord"),
      captureRootGitState: (root) => ({ root, state: "established" }),
    },
  );
  const direct = inspect();
  assert.equal(direct.checks.repo_mapping.status, "blocked");
  assert.match(direct.checks.repo_mapping.invalid[0], /overlaps the Concord control-plane root/);
  assert.equal(direct.status, "incomplete");

  fs.writeFileSync(path.join(coord, "project.config.js"), "module.exports = { repos: { B: { path: 'control-alias' } } };\n");
  const alias = inspect();
  assert.equal(alias.checks.repo_mapping.status, "blocked");
  assert.match(alias.checks.repo_mapping.invalid[0], /overlaps the Concord control-plane root/);
  assert.equal(alias.status, "incomplete");
});

// COORD-873: lifecycle.js now ships at coord/engine/scripts. A workspace installed from a
// post-873 engine is loaded from there; the test above keeps the pre-873 legacy layout.
test("COORD-873: installer governance loads the target lifecycle from coord/engine/scripts", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "installer-governance-engine-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const coord = path.join(workspace, "coord");
  fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(coord, "project.config.js"), "module.exports = { repos: {} };\n");
  fs.writeFileSync(path.join(coord, "engine", "scripts", "lifecycle.js"), `
    module.exports.installerGovernance = {
      buildSnapshot: () => ({ digest: "b".repeat(40), files: [] }),
      snapshotArtifactPath: (digest) => digest + ".json",
      readEventLog: () => [{ command: "journal-baseline", snapshot_digest: "b".repeat(40), from: "engine-layout" }],
      verifyChain: () => ({ ok: true, chainedCount: 1, preChainCount: 0 }),
      detectProvenanceDrift: () => ({ snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] }),
      ensureBaseline: () => true,
    };
  `);
  const journal = createInstallerGovernance(workspace).inspectJournal();
  assert.equal(journal.status, "ready");
  assert.equal(journal.chain, "verified");
  assert.equal(journal.event_count, 1);
});
