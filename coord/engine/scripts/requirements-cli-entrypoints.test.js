"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
// COORD-991: a removable legacy shim adds exactly one deprecation line to stderr; a permanent entrypoint adds none.
const shimLine = (name) => require("../../paths.js").loadShimRegistry(COORD_ROOT_DIR).shims.some((s) => s.path === `scripts/${name}.js` && s.kind === "removable")
  ? `DEPRECATED: coord/scripts/${name}.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/${name}.js instead.\n` : "";

// COORD-865 (COORD-589 batch 2): the 22 requirements-* CLIs moved under
// coord/engine/scripts and their legacy coord/scripts paths became registered
// CLI shims. Every engine module now exports main(), which the shim re-dispatches
// when it is the process entrypoint. This suite runs both entrypoints of every
// module end to end, and checks that the shim, the engine module and the coord
// CLI dispatcher all reach the same engine code.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const MODULES = [
  "requirements-artifact-model",
  "requirements-baseline-gate",
  "requirements-cockpit-model",
  "requirements-command-contracts",
  "requirements-conformance",
  "requirements-domain-boundary",
  "requirements-donor-derived",
  "requirements-donor-reuse",
  "requirements-evidence-policy",
  "requirements-generalization-audit",
  "requirements-import",
  "requirements-linkage-backfill",
  "requirements-linkage",
  "requirements-persona-workflow",
  "requirements-review-pack",
  "requirements-screen-coverage",
  "requirements-sequencing",
  "requirements-stale-impact",
  "requirements-surface-conformance",
  "requirements-traceability",
  "requirements-walking-skeleton",
  "requirements-workflow-alignment",
];

const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);

function runNode(file, args, options = {}) {
  return spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8", ...options });
}

test("COORD-865: the batch covers every moved requirements-* module", () => {
  const moved = fs.readdirSync(__dirname)
    .filter((name) => /^requirements-.*\.js$/.test(name) && !name.endsWith(".test.js"))
    .map((name) => name.replace(/\.js$/, ""))
    .sort();
  assert.deepEqual(moved, [...MODULES].sort());
});

for (const name of MODULES) {
  test(`COORD-865: ${name} --help runs through the legacy CLI shim and the engine entrypoint`, () => {
    const engineFile = path.join(__dirname, `${name}.js`);
    const legacyFile = path.join(LEGACY_DIR, `${name}.js`);
    const engine = runNode(engineFile, ["--help"]);
    const legacy = runNode(legacyFile, ["--help"]);
    assert.ifError(engine.error);
    assert.ifError(legacy.error);
    assert.equal(engine.status, 0, engine.stderr);
    assert.equal(legacy.status, 0, legacy.stderr);
    if (name === "requirements-command-contracts") assert.match(engine.stdout, /^# Requirements Command Contracts/);
    else assert.match(engine.stdout, new RegExp(`^Usage: ${name === "requirements-artifact-model" ? "requirements-artifacts" : name} `));
    assert.equal(legacy.stdout, engine.stdout, "the shim re-dispatches the engine main");
    assert.equal(legacy.stderr, `${shimLine(name)}${engine.stderr}`);

    // Required as a module (not the entrypoint), the shim is the engine module
    // object and neither runs main.
    const legacyModule = require(legacyFile);
    assert.equal(legacyModule, require(engineFile));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `scripts/${name}.js`)));
    assert.equal(typeof legacyModule.main, "function");
    assert.equal(typeof legacyModule.run, "function");
  });
}

test("COORD-865: a failing CLI keeps its non-zero exit code through the shim", () => {
  for (const name of ["requirements-import", "requirements-linkage", "requirements-stale-impact"]) {
    const engine = runNode(path.join(__dirname, `${name}.js`), ["--definitely-unknown-option"]);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), ["--definitely-unknown-option"]);
    assert.notEqual(engine.status, 0, `${name}: ${engine.stdout}`);
    assert.equal(legacy.status, engine.status, name);
    assert.equal(legacy.stdout, engine.stdout, name);
  }
});

test("COORD-865: requirements-import through the shim names the engine generator and defaults the project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-865-import-"));
  try {
    fs.writeFileSync(path.join(dir, "URS.md"), "## URS-001: Import works\nThe system shall import requirements.\n");
    const result = runNode(path.join(LEGACY_DIR, "requirements-import.js"), ["--dir", dir, "--source", "URS.md", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const registry = JSON.parse(result.stdout);
    assert.equal(registry.generator.command, "coord/engine/scripts/requirements-import.js");
    assert.equal(registry.project.name, "unknown");
    assert.equal(registry.requirements.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-865: the coord CLI dispatches requirements commands to the engine modules", () => {
  const cli = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
  const lines = [];
  const result = cli.dispatch(["requirements-import", "--help"], { log: (line) => lines.push(String(line)) });
  assert.equal(result.code, 0);
  assert.match(lines.join("\n"), /^Usage: requirements-import /);
  const spawned = runNode(path.join(LEGACY_DIR, "coord-cli.js"), ["requirements-linkage", "--help"]);
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(spawned.stdout, runNode(path.join(__dirname, "requirements-linkage.js"), ["--help"]).stdout);
});

// COORD-865 follow-up: the move wrapped each module's former require.main block
// in main(), so the refusal branches at the top of run() (missing input files,
// malformed options) and two pure rendering fallbacks lost their move-aware
// coverage credit. They are exercised here directly, through run() with an
// empty sandbox directory, instead of being written back into the baselines.

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function withEmptyDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-865-empty-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Each entry: the module, the argv that reaches its first missing-input check in
// an empty directory, and the refusal line run() must log before returning code 1.
const MISSING_INPUT_REFUSALS = [
  ["requirements-conformance", ["--registry", "registry.json"], /^requirements-conformance: board not found: coord\/board\/tasks\.json$/],
  ["requirements-domain-boundary", [], /^requirements-domain-boundary: manifest not found: coord\/\.runtime\/requirements\/domain-boundary\.json$/],
  ["requirements-donor-derived", [], /^requirements-donor-derived: inventory not found: /],
  ["requirements-donor-reuse", [], /^requirements-donor-reuse: matrix not found: /],
  ["requirements-generalization-audit", [], /^requirements-generalization-audit: audit not found: coord\/\.runtime\/requirements\/generalization-audit\.json$/],
  ["requirements-linkage-backfill", [], /^requirements-linkage-backfill: board not found: /],
  ["requirements-linkage", ["--lane", "full"], /^requirements-linkage: board not found: coord\/board\/tasks\.json$/],
  ["requirements-persona-workflow", [], /^requirements-persona-workflow: matrix not found: /],
  ["requirements-screen-coverage", [], /^requirements-screen-coverage: screen index not found: /],
  ["requirements-sequencing", ["--registry", "registry.json"], /^requirements-sequencing: board not found: coord\/board\/tasks\.json$/],
  ["requirements-surface-conformance", ["--registry", "registry.json"], /^requirements-surface-conformance: matrix not found: /],
  ["requirements-workflow-alignment", [], /^requirements-workflow-alignment: inventory not found: /],
];

for (const [name, extraArgs, refusal] of MISSING_INPUT_REFUSALS) {
  test(`COORD-865: ${name} run() refuses a missing input file with code 1 and names the path`, () => {
    withEmptyDir((dir) => {
      const { run } = require(path.join(__dirname, `${name}.js`));
      const out = capture();
      const result = run(["--dir", dir, ...extraArgs], { log: out.log, cwd: dir });
      assert.equal(result.code, 1, out.text());
      assert.match(out.text(), refusal);
      assert.equal(out.text().split("\n").length, 1, "exactly one refusal line, no report");
      assert.deepEqual(fs.readdirSync(dir), [], "a refused run writes nothing");
    });
  });
}

test("COORD-865: requirements-linkage-backfill run() refuses a flag without its value before touching the board", () => {
  withEmptyDir((dir) => {
    const { run } = require("./requirements-linkage-backfill.js");
    const out = capture();
    const result = run(["--board"], { log: out.log, cwd: dir });
    assert.equal(result.code, 1);
    assert.equal(out.text(), "requirements-linkage-backfill: --board requires a value");
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("COORD-865: requirements-linkage run() takes --lane and refuses a --lane without a value", () => {
  withEmptyDir((dir) => {
    const { run } = require("./requirements-linkage.js");
    const refused = capture();
    assert.equal(run(["--dir", dir, "--lane"], { log: refused.log, cwd: dir }).code, 1);
    assert.equal(refused.text(), "requirements-linkage: --lane requires a value");
    const accepted = capture();
    assert.equal(run(["--dir", dir, "--lane", "quick"], { log: accepted.log, cwd: dir }).code, 1);
    assert.equal(accepted.text(), "requirements-linkage: board not found: coord/board/tasks.json");
  });
});

test("COORD-865: requirements-command-contracts renders a contract-only stub when a command has no implementation", () => {
  const { renderContracts, contractReport, CONTRACTS } = require("./requirements-command-contracts.js");
  const report = contractReport();
  assert.ok(CONTRACTS.every((command) => command.implementation), "every real contract names its implementation");
  const stub = {
    ...report,
    commands: [{ ...report.commands[0], verb: "stubbed", implementation: undefined }],
  };
  const rendered = renderContracts(stub);
  assert.match(rendered, /^## requirements stubbed$/m);
  assert.match(rendered, /^Implementation: contract-only stub$/m);
  assert.match(renderContracts(report), new RegExp(`^Implementation: ${report.commands[0].implementation.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
});

test("COORD-865: requirements-import buildRegistry defaults the project name, profile and source policy", () => {
  const { buildRegistry } = require("./requirements-import.js");
  const registry = buildRegistry([], [], {});
  assert.equal(registry.project.name, "unknown");
  assert.equal(registry.project.profile, "product-engineering");
  assert.equal(registry.project.source_policy, "direct-or-imported");
  assert.equal(registry.generated_at_utc, "1970-01-01T00:00:00.000Z");
  const named = buildRegistry([], [], { projectName: "demo" });
  assert.equal(named.project.name, "demo");
});
