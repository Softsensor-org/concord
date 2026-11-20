"use strict";

// COORD-862 (COORD-516a): scoped drift verdicts.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { resolveEngineModule } = require("../../paths.js");

const COORD_DIR = path.join(__dirname, "..", "..");
const scope = require("./drift-scope.js");
const createEnginePin = require(resolveEngineModule(COORD_DIR, "scripts/engine-pin.js"));
const { parsePorcelainStatusPaths } = require(resolveEngineModule(COORD_DIR, "scripts/tree-mutation-safety.js"));
const { buildEngineDriftWarning } = require(resolveEngineModule(COORD_DIR, "scripts/doctor-report.js"));

function git(cwd, ...args) {
  const result = gitFixtureSpawn(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

test("COORD-862: every path lands in exactly one drift scope", () => {
  const cases = [
    ["coord/engine/scripts/lifecycle.js", "engine"],
    ["coord/engine/scripts/drift-scope.js", "engine"],
    ["coord/board/board.js", "engine"],
    ["coord/install-surfaces.json", "engine"],
    ["coord/board/tasks.json", "governed"],
    ["coord/board/plans/COORD-1.json", "governed"],
    ["coord/.runtime/plans/COORD-1.json", "governed"],
    ["coord/.runtime/governance-events.ndjson", "governed"],
    ["coord/prompts/tickets/COORD-1.md", "governed"],
    ["coord/docs/decisions/0001-x.md", "governed"],
    ["coord/QUESTIONS.md", "governed"],
    ["backend/src/app.js", "governed"],
    ["coord/rendered/TASKS.md", "derived"],
    ["coord/PLAN.md", "derived"],
    ["coord/.runtime/context-packs/x.json", "derived"],
    ["coord/memory/index.json", "derived"],
    ["coord/.runtime/agent_sessions.json", "runtime"],
    ["coord/.runtime/session-threads/t.json", "runtime"],
    ["coord/.runtime/locks/COORD-1.lock", "runtime"],
    ["coord/.runtime/snapshots/x.json", "runtime"],
    ["coord/locks/COORD-1.lock", "runtime"],
    ["coord/agents.json", "runtime"],
    ["coord/.worktrees/a/COORD-1/x.js", "runtime"],
    ["coord/scripts/node_modules/x/index.js", "governed"],
  ];
  for (const [file, expected] of cases) {
    assert.equal(scope.classifyDriftScope(file).scope, expected, file);
  }
  // Windows separators and a leading ./ normalize to the same verdict.
  assert.equal(scope.classifyDriftScope(".\\coord\\scripts\\sample-module.js").path, "coord/scripts/sample-module.js");
  // An explicit manifest set marks curated engine files outside the roots.
  assert.equal(scope.classifyDriftScope(".claude/settings.json").scope, "governed");
  assert.equal(scope.classifyDriftScope(".claude/settings.json", { enginePaths: new Set([".claude/settings.json"]) }).scope, "engine");
  assert.equal(scope.classifyDriftScope("").scope, "governed");
});

test("COORD-862: only prompts and decisions are authored content", () => {
  assert.equal(scope.isAuthoredContentPath("coord/prompts/tickets/COORD-1.md"), true);
  assert.equal(scope.isAuthoredContentPath("coord/docs/decisions/0020-x.md"), true);
  assert.equal(scope.isAuthoredContentPath("coord/docs/decisions/README.md"), true);
  for (const file of ["coord/board/tasks.json", "coord/.runtime/plans/COORD-1.json", "coord/PLAN.md", "coord/QUESTIONS.md", "coord/rendered/PROMPT_INDEX.md", "coord/promptsx/a.md", "coord/docs/GOVERNANCE.md"]) {
    assert.equal(scope.isAuthoredContentPath(file), false, file);
  }
  const verdict = scope.classifyDriftScope("coord/prompts/tickets/COORD-1.md");
  assert.equal(verdict.authored, true);
  assert.equal(verdict.project_owned, true);
});

test("COORD-862 (a): an engine hand-edit is named in the verdict, apart from project work", () => {
  const partition = scope.partitionDriftPaths(["backend/a.js", "coord/engine/scripts/lifecycle.js", "coord/rendered/TASKS.md", "backend/a.js"]);
  assert.deepEqual(partition.engine, ["coord/engine/scripts/lifecycle.js"]);
  assert.equal(scope.projectPathCount(partition), 2);
  assert.equal(
    scope.summarizeDriftScopes(partition),
    "engine drift on 1 path: coord/engine/scripts/lifecycle.js, 2 project paths uncommitted (governed 1, derived 1)"
  );
  assert.match(scope.formatScopeRemedies(partition), /^engine: .*verify-engine --pin.*; governed: .*; derived: .*gov sync/);
  const many = scope.partitionDriftPaths(Array.from({ length: 12 }, (_, i) => `coord/scripts/m${String(i).padStart(2, "0")}.js`));
  assert.match(scope.summarizeDriftScopes(many), /engine drift on 12 paths: .*m09\.js and 2 more, 0 project paths uncommitted$/);
  assert.equal(scope.summarizeDriftScopes(scope.partitionDriftPaths([])), "engine intact, 0 project paths uncommitted");
  assert.equal(scope.formatScopeRemedies(scope.partitionDriftPaths([])), "");
  assert.equal(
    scope.summarizeDriftScopes(scope.partitionDriftPaths(["coord/.runtime/agent_sessions.json"]), { verb: "unjournaled" }),
    "engine intact, 1 project path unjournaled (runtime 1)"
  );
});

test("COORD-862 (a)+(b): engine scope agrees with verify-engine on a real pinned checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-scope-"));
  try {
    const coordDir = path.join(root, "coord");
    fs.mkdirSync(path.join(coordDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(coordDir, "prompts", "tickets"), { recursive: true });
    fs.writeFileSync(path.join(coordDir, "scripts", "alpha.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(coordDir, "prompts", "tickets", "T-1.md"), "# T-1\n");
    fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), `${JSON.stringify({
      schema_version: 1, manifest_version: "coord862", items: [{ path: "coord/scripts/alpha.js", match_policy: "exact" }],
    })}\n`);
    const pin = createEnginePin({ coordDir, fail: (message) => { throw new Error(message); } });
    pin.pin();
    gitFixture(root, ["init", "-q"]);
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
    const enginePaths = scope.loadEngineManifestPaths(root);
    assert.deepEqual([...enginePaths], ["coord/scripts/alpha.js"]);
    const dirty = () => parsePorcelainStatusPaths(git(root, "status", "--porcelain", "--untracked-files=normal"));

    // (b) uncommitted project paths stay in project scope; the engine pin holds.
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(path.join(root, "backend", "new.js"), "x\n");
    fs.writeFileSync(path.join(coordDir, "prompts", "tickets", "T-1.md"), "# T-1 edited\n");
    let partition = scope.partitionDriftPaths(dirty(), { enginePaths });
    assert.deepEqual(partition.engine, []);
    // `--untracked-files=normal` collapses a new directory to one entry.
    assert.deepEqual(partition.governed, ["backend", "coord/prompts/tickets/T-1.md"]);
    assert.equal(scope.summarizeDriftScopes(partition), "engine intact, 2 project paths uncommitted (governed 2)");
    assert.equal(buildEngineDriftWarning(dirty(), { enginePaths }), null);
    assert.equal(pin.verify().ok, true);

    // (a) an engine hand-edit is engine drift naming the file, and verify-engine agrees.
    fs.writeFileSync(path.join(coordDir, "scripts", "alpha.js"), "module.exports = 2;\n");
    partition = scope.partitionDriftPaths(dirty(), { enginePaths });
    assert.deepEqual(partition.engine, ["coord/scripts/alpha.js"]);
    const warning = buildEngineDriftWarning(dirty(), { enginePaths });
    assert.match(warning, /^\[engine-drift\] engine drift on 1 path: coord\/scripts\/alpha\.js, 2 project paths uncommitted/);
    assert.match(warning, /verify-engine/);
    const verdict = pin.verify();
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.drifted_files.map((entry) => entry.path), ["coord/scripts/alpha.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-862: a missing or invalid manifest falls back to the discovery rule", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord862-manifest-"));
  try {
    assert.equal(scope.loadEngineManifestPaths(root), null);
    fs.mkdirSync(path.join(root, "coord"));
    fs.writeFileSync(path.join(root, "coord", "TEMPLATE_SYNC_MANIFEST.json"), "{not json");
    assert.equal(scope.loadEngineManifestPaths(root), null);
    fs.writeFileSync(path.join(root, "coord", "TEMPLATE_SYNC_MANIFEST.json"), "{}");
    assert.deepEqual([...scope.loadEngineManifestPaths(root)], []);
    fs.writeFileSync(path.join(root, "coord", "TEMPLATE_SYNC_MANIFEST.json"), JSON.stringify({ items: [null, { path: 3 }, { path: "coord/scripts/a.js" }] }));
    assert.deepEqual([...scope.loadEngineManifestPaths(root)], ["coord/scripts/a.js"]);
    // An installed workspace without project-owned-state.js reports ownership as unknown.
    assert.equal(scope.loadProjectOwnership(root)("coord/prompts/x.md"), null);
    assert.equal(scope.loadProjectOwnership(COORD_DIR)("coord/prompts/tickets/x.md"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
