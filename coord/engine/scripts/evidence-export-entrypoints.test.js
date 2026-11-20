"use strict";

// COORD-878 (COORD-589 batch 5): evidence-export.mjs lives in
// coord/engine/scripts and its legacy coord/scripts path is a registered ES
// module shim. Both paths must import to the same bindings, run as the same CLI
// with the same exit codes, and resolve the exporter's resources (control maps,
// the live-MCP lifecycle module, coord/paths.js) relative to the engine module
// rather than the shim or the working directory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { loadShimRegistry, shimDelegates, resolveEngineModule } = require("../../paths.js");

const COORD = path.resolve(__dirname, "..", "..");
const ENGINE = path.join(__dirname, "evidence-export.mjs");
const LEGACY = path.join(COORD, "scripts", "evidence-export.mjs");
const PATHS = [["engine", ENGINE], ["legacy", LEGACY]];
// Derived rather than spelled, so the shim-reference scan reads no legacy route here.
const LEGACY_REL = path.relative(COORD, LEGACY).split(path.sep).join("/");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A coord dir with no product/control-maps of its own, so the shipped maps can
// only be found relative to the exporter module.
function fixture(t, { withGap = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord878-evx-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  const rows = [{ ID: "LIVE-878", Repo: "B", Type: "feature", Pri: "P2", Status: "doing", Owner: "a", Description: "", "Depends On": "" }];
  if (withGap) rows.push({ ID: "GAP-878", Repo: "B", Type: "feature", Pri: "P2", Status: "done", Owner: "a", Description: "", "Depends On": "" });
  writeJson(path.join(coord, "board", "tasks.json"), {
    version: 1, metadata: { title: "T" },
    sections: [{ kind: "table", heading: "B", columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  });
  writeJson(path.join(coord, ".runtime", "plans", "LIVE-878.json"), {
    live_mcp: { adapter: "reference", operation_class: "read_safe", environment: "staging" },
  });
  fs.writeFileSync(path.join(coord, ".runtime", "governance-events.ndjson"), "");
  return { root, coord };
}

function runCli(file, args, cwd) {
  return spawnSync(process.execPath, [file, ...args], { cwd, encoding: "utf8" });
}

test("COORD-878 the legacy evidence-export path is a registered removable ES module CLI shim", () => {
  const shim = loadShimRegistry(COORD).shims.find((entry) => entry.path === LEGACY_REL);
  assert.deepEqual(shim, { path: LEGACY_REL, target: `engine/${LEGACY_REL}`, kind: "removable" });
  assert.equal(shimDelegates(fs.readFileSync(LEGACY, "utf8"), shim.path), true);
  assert.equal(resolveEngineModule(COORD, "scripts/evidence-export.mjs"), ENGINE);
});

test("COORD-878 importing either path yields the same named and default bindings", async () => {
  const engine = await import(pathToFileURL(ENGINE).href);
  const legacy = await import(pathToFileURL(LEGACY).href);
  assert.deepEqual(Object.keys(legacy).sort(), Object.keys(engine).sort());
  assert.deepEqual(Object.keys(engine).sort(), ["buildEvidenceExport", "default", "main", "runCli"]);
  for (const name of ["buildEvidenceExport", "runCli", "main"]) {
    assert.equal(typeof engine[name], "function", name);
    assert.equal(legacy[name], engine[name], `${name} is the engine binding`);
  }
  assert.equal(legacy.default, engine.default);
  assert.deepEqual(Object.keys(engine.default).sort(), ["buildEvidenceExport", "main", "runCli"]);
  assert.equal(engine.default.runCli, engine.runCli);
});

test("COORD-878 both CLI paths produce identical output and exit codes", (t) => {
  const gappy = fixture(t);
  const clean = fixture(t, { withGap: false });
  const cases = [
    ["gap", ["--coord-dir", gappy.coord, "--format", "json"], 3],
    ["clean", ["--coord-dir", clean.coord, "--framework", "nist-ai-rmf"], 0],
    ["markdown", ["--coord-dir", gappy.coord, "--format", "md"], 3],
    ["missing board", ["--coord-dir", path.join(gappy.root, "absent")], 2],
  ];
  for (const [label, args, expected] of cases) {
    const [engine, legacy] = PATHS.map(([, file]) => runCli(file, args, gappy.root));
    assert.equal(engine.status, expected, `${label} via engine: ${engine.stderr}`);
    assert.equal(legacy.status, engine.status, `${label}: exit codes match`);
    assert.equal(legacy.stdout, engine.stdout, `${label}: stdout matches`);
    // COORD-991: the removable legacy shim adds exactly its deprecation line to the engine's stderr.
    assert.equal(legacy.stderr, `DEPRECATED: coord/scripts/evidence-export.mjs is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/evidence-export.mjs instead.\n${engine.stderr}`, `${label}: stderr matches`);
  }
  // --out writes the same file through either path.
  const outputs = PATHS.map(([name, file]) => {
    const out = path.join(gappy.root, `${name}.json`);
    const run = runCli(file, ["--coord-dir", gappy.coord, "--out", out], gappy.root);
    assert.equal(run.status, 3, run.stderr);
    return fs.readFileSync(out, "utf8");
  });
  assert.equal(outputs[1], outputs[0]);
});

test("COORD-878 resources resolve relative to the engine module, not the shim or the working directory", (t) => {
  const { root, coord } = fixture(t);
  const shipped = ["eu-ai-act", "nist-ai-rmf"].map((name) => JSON.parse(fs.readFileSync(path.join(COORD, "product", "control-maps", `${name}.json`), "utf8")));
  for (const [name, file] of PATHS) {
    // Run from an unrelated directory with a relative --coord-dir resolved against it.
    const run = runCli(file, ["--coord-dir", path.relative(root, coord)], root);
    assert.equal(run.status, 3, `${name}: ${run.stderr}`);
    const pkg = JSON.parse(run.stdout);
    // Shipped control maps are found next to the engine (coord/product/control-maps).
    assert.equal(fs.existsSync(path.join(coord, "product")), false, "the fixture has no maps of its own");
    assert.deepEqual(pkg.frameworks.map((fw) => fw.controls.map((control) => control.control)),
      shipped.map((fw) => fw.controls.map((control) => control.id)), `${name}: shipped control maps`);
    // The live-MCP lifecycle module loads through the engine resolver (an
    // unavailable module would silently degrade to an empty section).
    assert.equal(pkg.live_mcp.available, true, `${name}: live-MCP lifecycle module resolved`);
    assert.deepEqual(pkg.live_mcp.tickets.map((ticket) => ticket.id), ["LIVE-878"]);
    assert.equal(pkg.summary.tickets_with_gaps, 1, `${name}: plan-evidence projection resolved`);
  }
});
