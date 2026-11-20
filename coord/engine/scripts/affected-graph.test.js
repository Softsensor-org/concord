"use strict";

// COORD-924: the module graph behind affected-test selection.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const g = require("./affected-graph.js");
const { initRepo, git } = require("./affected-evaluation.js");

function graphOf(sources, extra = []) {
  const files = [...new Set([...Object.keys(sources), ...extra])].sort();
  return g.buildGraph({ root: "/unused", files, sources: new Map(Object.entries(sources)) });
}

const edges = (graph, file) => [...graph.edges.get(file)].sort();

test("COORD-924: the graph resolves static requires, imports, shim-registry resolution and mentions", () => {
  const graph = graphOf({
    "coord/a.js": [
      "const b = require('./b');",
      "import c from './c.mjs';",
      "const d = import('./d.js');",
      "const e = require(resolveEngineModule(path.join(__dirname, '..'), 'scripts/e.js'));",
      "const f = require(resolveEngineModule(COORD, \"engine-only:scripts/f.js\"));",
      "const data = path.join(__dirname, 'g.json');",
      "spawn('bash', ['release/run.sh']);",
      "// a comment naming coord/z.js is not an edge",
      "require('node:fs'); require('left-pad');",
    ].join("\n"),
    "coord/b.js": "", "coord/c.mjs": "", "coord/d.js": "",
    "coord/engine/scripts/e.js": "", "coord/scripts/e.js": "", "coord/engine/scripts/f.js": "", "coord/scripts/f.js": "",
    "release/run.sh": "# runs coord/z.js only in this comment\nnode coord/h.js\n",
    "coord/h.js": "",
  }, ["coord/g.json", "coord/z.js", "coord/data.json"]);
  assert.deepEqual(edges(graph, "coord/a.js"), [
    "coord/b.js", "coord/c.mjs", "coord/d.js", "coord/engine/scripts/e.js", "coord/engine/scripts/f.js", "coord/g.json", "coord/scripts/e.js",
    "coord/scripts/f.js", "release/run.sh",
  ], "the engine-only spec also mentions scripts/f.js, which only selects more");
  assert.deepEqual(edges(graph, "release/run.sh"), ["coord/h.js"]);
  assert.deepEqual(edges(graph, "coord/data.json"), [], "JSON files are leaves");
  assert.ok(graph.reverse.get("coord/h.js").has("release/run.sh"));
});

test("COORD-924: dynamic loads are known when the file names loadable code or reads a config, unknown otherwise", () => {
  const graph = graphOf({
    "coord/known.js": "const RUNNER = path.join(__dirname, 'b.js');\nmodule.exports = () => require(RUNNER);\n",
    "coord/config.js": "const cfg = require(configPath);\n",
    "coord/unknown.js": "exports.load = (name) => require(name);\nexports.lazy = () => import(spec);\nrequire();\n",
    "coord/b.js": "",
  });
  const sites = graph.dynamic.map((d) => [d.file, d.line, d.known, d.config]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
  assert.deepEqual(sites, [
    ["coord/config.js", 1, true, true],
    ["coord/known.js", 2, true, false],
    ["coord/unknown.js", 1, false, false],
    ["coord/unknown.js", 2, false, false],
  ]);
  assert.equal(graph.dynamic.find((d) => d.file === "coord/unknown.js").argument, "name);");
});

test("COORD-924: a code fixture keeps its requires but its path strings are data, not edges", () => {
  const graph = graphOf({
    "coord/x/__fixtures__/cases.js": "require('../lib.js');\nmodule.exports = [{ changes: ['coord/x/lib.js', 'coord/x/other.js'] }];\n",
    "coord/x/lib.js": "", "coord/x/other.js": "",
  });
  assert.deepEqual(edges(graph, "coord/x/__fixtures__/cases.js"), ["coord/x/lib.js"]);
});

test("COORD-924: dependents walk reverse edges inclusively and stop at suites", () => {
  const graph = graphOf({
    "coord/helper.js": "require('./core.js');",
    "coord/core.js": "",
    "coord/a.test.js": "require('./helper.js');",
    "coord/census.test.js": "const src = fs.readFileSync('a.test.js');",
    "coord/meta.test.js": "read('census.test.js');",
  });
  assert.deepEqual([...g.dependentsOf(graph, ["coord/core.js"])].sort(), ["coord/a.test.js", "coord/core.js", "coord/helper.js"],
    "census.test.js only reads a.test.js, whose text did not change");
  assert.deepEqual([...g.dependentsOf(graph, ["coord/census.test.js"])].sort(), ["coord/census.test.js", "coord/meta.test.js"], "a changed suite's readers are affected");
  assert.deepEqual([...g.dependentsOf(graph, ["coord/absent.js"])], []);
  graph.loadEdges.delete("coord/census.test.js");
  assert.deepEqual([...g.dependentsOf(graph, ["coord/core.js"])].sort(),
    ["coord/a.test.js", "coord/core.js", "coord/helper.js"], "missing load evidence does not turn a mention into an import");
});

test("COORD-924: mentions resolve by suffix, by relative path and by base name, never to the file itself", () => {
  const index = g.createIndex(["coord/a/x.js", "coord/b/x.js", "coord/a/y.js", "release/run.sh"]);
  assert.deepEqual(g.resolveMention(index, "x.js", "coord/a/x.js"), ["coord/b/x.js"]);
  assert.deepEqual(g.resolveMention(index, "a/x.js", "coord/a/y.js"), ["coord/a/x.js"]);
  assert.deepEqual(g.resolveMention(index, "./x.js", "coord/a/y.js"), ["coord/a/x.js"]);
  assert.deepEqual(g.resolveMention(index, "release/run.sh/", "coord/a/y.js"), ["release/run.sh"]);
  assert.deepEqual(g.resolveMention(index, "/release/run.sh", "coord/a/y.js"), ["release/run.sh"]);
  assert.deepEqual(g.resolveMention(index, "/", "coord/a/y.js"), []);
  assert.deepEqual(g.resolveEngineSpec(g.createIndex(["coord/scripts/q.js"]), "scripts/q.js"), ["coord/scripts/q.js"]);
  assert.deepEqual(g.resolveRelative(index, "coord/a/y.js", "../b/x"), ["coord/b/x.js"]);
  assert.equal(g.toPosix(["a", "b"].join(path.sep)), "a/b");
});

test("COORD-924: files and sources are read at a ref or from the working tree; unreadable files are recorded", (t) => {
  const root = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord924-graph-")), {
    "coord/a.js": "require('./b.js');\n", "coord/b.js": "module.exports = 1;\n", "notes.md": "# n\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "coord/a.js"), "// working tree edit\n");
  const atHead = g.buildGraph({ root, ref: "HEAD" });
  assert.deepEqual(edges(atHead, "coord/a.js"), ["coord/b.js"]);
  assert.deepEqual(g.listFiles(root, "HEAD"), ["coord/a.js", "coord/b.js", "notes.md"]);
  const worktree = g.buildGraph({ root });
  assert.deepEqual(edges(worktree, "coord/a.js"), []);
  const missing = g.readSources(root, "HEAD", ["coord/a.js", "coord/gone.js"]);
  assert.equal(missing.get("coord/gone.js"), null);
  assert.match(missing.get("coord/a.js"), /require/);
  fs.rmSync(path.join(root, "coord/b.js"));
  assert.equal(g.readSources(root, null, ["coord/b.js"]).get("coord/b.js"), null);
  const unreadable = g.buildGraph({ root, files: ["coord/b.js"], sources: new Map([["coord/b.js", null]]) });
  assert.deepEqual(unreadable.unreadable, ["coord/b.js"]);
  assert.throws(() => g.listFiles(root, "no-such-ref"), /git ls-tree/);
  assert.throws(() => g.listFiles(path.join(root, "no-such-dir")), { message: "git ls-files -z failed: " }, "git that cannot start reports no stderr");
  assert.equal(git(root, ["rev-parse", "--is-inside-work-tree"]), "true");
});

// COORD-966 (human-admin decision 2026-11-13): the paths.js shim-template exemption.
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXEMPT_FUNCTIONS = new Set(g.TEXT_EXEMPTIONS.filter((e) => e.file === "coord/paths.js").map((e) => e.function));

// The name of the top-level function whose definition precedes `line` (1-based), or null.
function enclosingFunction(lines, line) {
  for (let i = line - 1; i >= 0; i--) {
    const m = /^function (\w+)\(/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

test("COORD-966: the exemption hides only the template-text sites of the shim renderers; every other site in paths.js stays", () => {
  const rel = "coord/paths.js";
  const text = fs.readFileSync(path.join(WORKSPACE_ROOT, rel), "utf8");
  const index = g.createIndex(g.listFiles(WORKSPACE_ROOT));
  const lines = text.split("\n");
  const exempted = g.extractEdges(index, rel, text, []).dynamic;
  const kept = g.extractEdges(index, rel, text).dynamic;
  const keyOf = (d) => `${d.line}\0${d.argument}`;
  const keptKeys = new Set(kept.map(keyOf));
  const removed = exempted.filter((d) => !keptKeys.has(keyOf(d)));
  // the exemption removes sites, and only sites the renderers own
  assert.ok(removed.length >= 2, `the renderer template sites must be exempt, got ${removed.length}`);
  for (const d of removed) {
    assert.ok(EXEMPT_FUNCTIONS.has(enclosingFunction(lines, d.line)), `exempt site outside the renderers: ${d.line} ${d.argument}`);
  }
  // every site outside the exempt functions survives
  const outside = exempted.filter((d) => !EXEMPT_FUNCTIONS.has(enclosingFunction(lines, d.line)));
  assert.deepEqual(outside.map(keyOf).sort(), kept.map(keyOf).sort(), "a site outside the renderers was hidden");
  // the exemption is pinned to paths.js: the same text under another name is not exempt
  const renamed = g.extractEdges(index, "coord/paths-copy.js", text).dynamic;
  assert.equal(renamed.length, exempted.length, "the exemption applies to coord/paths.js only");

  for (const malformed of ["function render(", "function render()\n", "function render() {"]) {
    assert.equal(g.functionBodyRange(malformed, g.maskCode(malformed), "render"), null, malformed);
  }
  const fixture = [
    "function render(spec) {",
    "  return `const implementation = resolveEngineModule(root, spec);" +
      "spawnSync(process.execPath, [path.join(__dirname, spec)]);`;",
    "}",
    "resolveEngineModule(root, runtimeSpec);",
    "spawnSync(process.execPath, [path.join(__dirname, 'target.js')]);",
    "spawnSync(process.execPath, [path.join(__dirname, runtimeSpec)]);",
  ].join("\n");
  const edges = g.extractEdges(g.createIndex([rel, "coord/target.js"]), rel, fixture, [{ file: rel, function: "render" }]);
  assert.deepEqual(edges.dynamic.map((site) => site.line), [4, 6], "the template is exempt and the spawn target is static");
  assert.ok(edges.loads.has("coord/target.js"));
});

test("COORD-966: every generated JS shim matches a renderer output (the repo's normalized definition) and keeps its edge to its engine target", () => {
  // The registered shims carry a header comment and blank lines that the renderer does not emit, so
  // exact bytes differ; shimDelegates (the repo's own definition, used by verify-shim-registry) compares
  // after normalization, and that is the premise the exemption rests on.
  const { shimDelegates } = require(path.join(WORKSPACE_ROOT, "coord", "paths.js"));
  const registry = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, "coord", "engine", "shim-registry.json"), "utf8"));
  const index = g.createIndex(g.listFiles(WORKSPACE_ROOT));
  const jsShims = registry.shims.filter((s) => /\.(?:c|m)?js$/.test(s.path) && !s.path.endsWith(".mjs"));
  assert.ok(jsShims.length >= 10, `the shim registry must hold JS shims, got ${jsShims.length}`);
  for (const shim of jsShims) {
    const file = `coord/${shim.path}`;
    const text = fs.readFileSync(path.join(WORKSPACE_ROOT, file), "utf8");
    assert.ok(shimDelegates(text, shim.path, shim.kind), `${file} no longer matches a renderShimSource output: the exemption's premise no longer holds`);
    const targets = g.extractEdges(index, file, text).targets;
    assert.ok(targets.has(`coord/${shim.target}`), `${file} lost its static edge to coord/${shim.target}`);
  }
});
