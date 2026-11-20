"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry, isStableEntrypoint } = require("../../paths.js");

// COORD-888 (COORD-589 closeout batch): the lifecycle-* extraction modules (the
// lifecycle.js composition root's collaborators, which no batch 1-10 pattern
// named), guided-closeout and prodloc-closeout moved under
// coord/engine/scripts. Every legacy path is a removable shim; prodloc-closeout
// is a CLI, so its shim re-dispatches main. dispatch.mjs (named by COORD-871,
// which deferred it until COORD-878 added ES module shims) is a removable ES
// module CLI shim.

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const LIBRARY_MODULES = [
  "guided-closeout",
  "lifecycle-board-commands",
  "lifecycle-board-validate",
  "lifecycle-evidence",
  "lifecycle-execution-context",
  "lifecycle-flags",
  "lifecycle-gate-code-commands",
  "lifecycle-help",
  "lifecycle-journal-queries",
  "lifecycle-landing-governance",
  "lifecycle-lock-commands",
  "lifecycle-lock-lookup",
  "lifecycle-maintenance-commands",
  "lifecycle-review-state",
  "lifecycle-session-reaping",
  "lifecycle-ticket-admin",
  "lifecycle-ticket-helpers",
  "lifecycle-utils",
];
const CLI_MODULES = ["prodloc-closeout"];

test("COORD-888: every closeout-batch module is a registered removable shim at its legacy path", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  for (const name of [...LIBRARY_MODULES, ...CLI_MODULES]) {
    const rel = `scripts/${name}.js`;
    const shim = registry.shims.find((entry) => entry.path === rel);
    assert.ok(shim, `${rel} is registered`);
    assert.equal(shim.target, `engine/${rel}`);
    assert.equal(shim.kind, "removable", rel);
    assert.equal(isStableEntrypoint(registry, rel), false, `${rel} is not a stable entrypoint`);
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, rel)));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `engine-only:${rel}`)));
    if (CLI_MODULES.includes(name)) assert.equal(typeof legacyModule.main, "function", `${name} exports main for its CLI shim`);
  }
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-888: the lifecycle composition root loads the one engine copy of each lifecycle collaborator", () => {
  const lifecycle = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
  assert.equal(typeof lifecycle.commands, "object");
  for (const name of LIBRARY_MODULES.filter((item) => item.startsWith("lifecycle-"))) {
    const engineFile = path.join(__dirname, `${name}.js`);
    const legacyFile = path.join(LEGACY_DIR, `${name}.js`);
    assert.ok(require.cache[engineFile], `${name}: the engine copy is the loaded module`);
    if (require.cache[legacyFile]) {
      assert.equal(require.cache[legacyFile].exports, require.cache[engineFile].exports, `${name}: the legacy path only re-exports the engine copy`);
    }
  }
});

test("COORD-888: the legacy prodloc-closeout CLI dispatches the engine command line with its exit code and message", () => {
  const run = (file, args) => spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  const legacy = path.join(LEGACY_DIR, "prodloc-closeout.js");
  const engine = path.join(__dirname, "prodloc-closeout.js");
  const viaShim = run(legacy, ["unexpected-argument"]);
  const direct = run(engine, ["unexpected-argument"]);
  assert.equal(viaShim.status, 1, "a usage error exits 1");
  assert.equal(viaShim.status, direct.status);
  // COORD-991: the removable legacy shim adds exactly its deprecation line to the engine's stderr.
  assert.equal(viaShim.stderr, `DEPRECATED: coord/scripts/prodloc-closeout.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/prodloc-closeout.js instead.\n${direct.stderr}`);
  assert.equal(viaShim.stdout, "");
  assert.match(viaShim.stderr, /Usage: node coord\/engine\/scripts\/prodloc-closeout\.js/);
});

test("COORD-888: dispatch.mjs is a registered removable ES module shim with the engine module's bindings", async () => {
  const { pathToFileURL } = require("node:url");
  const { shimDelegates } = require("../../paths.js");
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  const legacyFile = path.join(LEGACY_DIR, "dispatch.mjs");
  // Derived rather than spelled, so the shim-reference scan reads no legacy route here.
  const rel = path.relative(COORD_ROOT_DIR, legacyFile).split(path.sep).join("/");
  assert.deepEqual(registry.shims.find((entry) => entry.path === rel), { path: rel, target: `engine/${rel}`, kind: "removable" });
  assert.equal(isStableEntrypoint(registry, rel), false);
  assert.equal(shimDelegates(fs.readFileSync(legacyFile, "utf8"), rel), true, "the legacy file is the rendered ESM shim");
  const legacy = await import(pathToFileURL(legacyFile).href);
  const engine = await import(pathToFileURL(path.join(__dirname, "dispatch.mjs")).href);
  for (const name of ["buildLoop", "buildReviewerBody", "formatHuman", "loadManifest", "main", "parseArgs", "printHuman", "runDispatch"]) {
    assert.equal(typeof engine[name], "function", `engine exports ${name}`);
    assert.equal(legacy[name], engine[name], `${name}: the shim re-exports the engine binding`);
  }
  assert.equal(legacy.default, engine.default, "the default binding is re-exported");
});

test("COORD-888: the legacy dispatch.mjs CLI dispatches the engine command line with its exit codes and messages", () => {
  const run = (file, args) => spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  const legacy = path.join(LEGACY_DIR, "dispatch.mjs");
  const engine = path.join(__dirname, "dispatch.mjs");
  for (const args of [["--not-a-flag"], ["--manifest"], ["--manifest", "a.json", "--review-manifest", "b.json"]]) {
    const viaShim = run(legacy, args);
    const direct = run(engine, args);
    assert.equal(viaShim.status, 2, `${args.join(" ")} is a usage error`);
    assert.equal(viaShim.status, direct.status);
    // The harness prints the error with its stack, whose frames name the entry file; the message line is the contract.
    // COORD-991: the deprecation line comes first; the engine's own stderr follows it unchanged.
    const warning = "DEPRECATED: coord/scripts/dispatch.mjs is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/dispatch.mjs instead.\n";
    assert.ok(viaShim.stderr.startsWith(warning), viaShim.stderr);
    assert.equal(viaShim.stderr.slice(warning.length).split("\n")[0], direct.stderr.split("\n")[0]);
    assert.equal(viaShim.stdout, direct.stdout);
    assert.match(viaShim.stderr, /dispatch\.mjs: /);
  }
});

// The code-* commands of the gate/code collaborator lazily resolve the engine
// code-context.js through the moved module's two-level path hop, so each test
// below invokes one delegator on a disposable git fixture (outside coord/) and
// compares it with code-context's own command on the same inputs.
function codeCommandFixture(t) {
  const os = require("node:os");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-888-code-commands-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const src = path.join(root, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "alpha.js"), '"use strict";\n// Alpha parses zebrafish manifests.\nfunction parseZebrafish() {}\nmodule.exports = { parseZebrafish };\n');
  fs.writeFileSync(path.join(src, "beta.js"), '"use strict";\n// Beta renders zebrafish and quokka reports.\nfunction renderQuokka() {}\nmodule.exports = { renderQuokka };\n');
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  fs.appendFileSync(path.join(src, "beta.js"), "function renderWombat() {}\nmodule.exports.renderWombat = renderWombat;\n");
  git("commit", "-q", "-am", "change beta");
  const codeContext = require(path.join(__dirname, "code-context.js"));
  const commands = require(path.join(__dirname, "lifecycle-gate-code-commands.js"))({});
  return { root, src, baseSha, codeContext, commands };
}

function captureStdout(fn) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    return { result: fn(), output };
  } finally {
    process.stdout.write = original;
  }
}

test("COORD-888: codeIndexCommand delegates to code-context with its options and writes the same index", (t) => {
  const { root, src, codeContext, commands } = codeCommandFixture(t);
  const viaIndex = path.join(root, "via.ndjson");
  const directIndex = path.join(root, "direct.ndjson");
  const via = captureStdout(() => commands.codeIndexCommand({ repo: src, indexPath: viaIndex, ext: "js", json: true }));
  const direct = captureStdout(() => codeContext.codeIndexCommand({ repo: src, indexPath: directIndex, ext: "js", json: true }));
  assert.equal(via.result.index_path, viaIndex, "the indexPath option reached code-context");
  assert.equal(via.result.indexed, 2, "both fixture files were indexed");
  assert.deepEqual(via.result.errors, []);
  assert.deepEqual(JSON.parse(via.output), via.result, "the json option reached code-context");
  assert.deepEqual({ ...via.result, index_path: null }, { ...direct.result, index_path: null });
  const keys = (file) => [...codeContext.__testing.loadIndex(file).keys()].sort();
  assert.deepEqual(keys(viaIndex), keys(directIndex));
  assert.equal(keys(viaIndex).length, 2);
});

test("COORD-888: codeSearchCommand delegates to code-context with its query and options", (t) => {
  const { root, src, codeContext, commands } = codeCommandFixture(t);
  const indexPath = path.join(root, "index.ndjson");
  codeContext.buildIndex({ repo: src, indexPath, ext: "js" });
  const via = captureStdout(() => commands.codeSearchCommand("quokka", { indexPath, top: 1, json: true }));
  const direct = captureStdout(() => codeContext.codeSearchCommand("quokka", { indexPath, top: 1, json: true }));
  assert.equal(via.result.query, "quokka", "the query reached code-context");
  assert.equal(via.result.total_indexed, 2, "the indexPath option reached code-context");
  assert.equal(via.result.results.length, 1, "the top option reached code-context");
  assert.match(via.result.results[0].path, /src\/beta\.js$/);
  assert.deepEqual(via.result, direct.result);
  assert.equal(via.output, direct.output);
  const other = captureStdout(() => commands.codeSearchCommand("parseZebrafish", { indexPath, top: 1, json: true }));
  assert.match(other.result.results[0].path, /src\/alpha\.js$/, "a different query ranks a different file");
});

test("COORD-888: codeContextCommand delegates to code-context with its file paths and options", (t) => {
  const { root, src, codeContext, commands } = codeCommandFixture(t);
  const indexPath = path.join(root, "index.ndjson");
  codeContext.buildIndex({ repo: src, indexPath, ext: "js" });
  const alpha = path.relative(REPO_ROOT, path.join(src, "alpha.js")).split(path.sep).join("/");
  const filePaths = [alpha, "src/not-indexed.js"];
  const via = captureStdout(() => commands.codeContextCommand(filePaths, { indexPath, json: true }));
  const direct = captureStdout(() => codeContext.codeContextCommand(filePaths, { indexPath, json: true }));
  assert.deepEqual(via.result.results.map((item) => item.exports.map((entry) => entry.name)), [["parseZebrafish"]]);
  assert.deepEqual(via.result.missing, ["src/not-indexed.js"], "every file path reached code-context");
  assert.equal(via.result.total_indexed, 2);
  assert.deepEqual(via.result, direct.result);
  assert.equal(via.output, direct.output);
});

test("COORD-888: codeDiffCommand delegates to code-context with its base ref and options", (t) => {
  const { root, src, baseSha, codeContext, commands } = codeCommandFixture(t);
  const indexPath = path.join(root, "index.ndjson");
  codeContext.buildIndex({ repo: src, indexPath, ext: "js" });
  const via = captureStdout(() => commands.codeDiffCommand(baseSha, { repo: root, indexPath, json: true }));
  const direct = captureStdout(() => codeContext.codeDiffCommand(baseSha, { repo: root, indexPath, json: true }));
  assert.equal(via.result.base_ref, baseSha, "the base ref reached code-context");
  assert.equal(via.result.total_changed, 1, "the repo option reached code-context");
  assert.match(via.result.results[0].path, /src\/beta\.js$/);
  assert.ok(via.result.results[0].exports.some((entry) => entry.name === "renderWombat"));
  assert.deepEqual(via.result, direct.result);
  assert.equal(via.output, direct.output);
  const head = captureStdout(() => commands.codeDiffCommand("HEAD", { repo: root, indexPath, json: true }));
  assert.equal(head.result.total_changed, 0, "a different base ref yields a different diff");
});
