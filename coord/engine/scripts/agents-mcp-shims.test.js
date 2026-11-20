"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry, isStableEntrypoint } = require("../../paths.js");

// COORD-871 (COORD-589 batch 8): the auto-mode, managed-auto, capability-broker,
// live-MCP / runtime-evidence and agent-command modules plus the COORD-875
// batch-8 assignments moved under coord/engine/scripts. Every legacy path is a
// removable shim; auto-mode-policy.js and concurrent-burnin-worker.js are CLIs,
// so their shims re-dispatch main. governance-mcp.js and mcp-optional-launcher.js
// are PERMANENT CLI shims: adopter-owned .mcp.json files spell their literal path
// (human-admin approval 2026-11-04, stable_entrypoints). dispatch.mjs waited for
// ESM shim support (COORD-878) and moved with COORD-888 (lifecycle-closeout-shims).

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const LIBRARY_MODULES = [
  "agent-commands",
  "auto-mode-adapters",
  "auto-mode-containment",
  "auto-mode-ledger",
  "backfill-query-advisory",
  "bootstrap-advisory",
  "bootstrap-via-live-mcp",
  "capability-broker",
  "code-context",
  "dispatch-context-budget",
  "fleet-golden-path",
  "live-mcp-lifecycle",
  "managed-auto-ledger",
  "managed-auto-policy",
  "managed-auto-runner",
  "missing-ticket-lock",
  "runtime-evidence",
  "sequencer-grouping",
  "token-economics",
];
const CLI_MODULES = ["auto-mode-policy", "concurrent-burnin-worker"];
const PERMANENT_CLI = ["governance-mcp", "mcp-optional-launcher"];
const NOT_MOVED = [];

test("COORD-871: every batch-8 module is a registered removable shim at its legacy path", () => {
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
  for (const name of PERMANENT_CLI) {
    const rel = `scripts/${name}.js`;
    const shim = registry.shims.find((entry) => entry.path === rel);
    assert.deepEqual(shim, { path: rel, target: `engine/${rel}`, kind: "permanent" }, `${rel} is a permanent shim`);
    assert.equal(isStableEntrypoint(registry, rel), true, `${rel} is an approved stable entrypoint`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(typeof legacyModule.main, "function", `${name} exports main for its CLI shim`);
  }
  for (const file of NOT_MOVED) {
    assert.ok(fs.existsSync(path.join(LEGACY_DIR, file)), `${file} stays at coord/scripts`);
    assert.equal(registry.shims.some((entry) => entry.path === `scripts/${file}`), false, `${file} is not a shim`);
  }
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-871: the legacy auto-mode-policy CLI dispatches the engine command line with its exit codes", () => {
  const run = (args) => spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-871-"));
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    for (const file of [path.join(LEGACY_DIR, "auto-mode-policy.js"), path.join(__dirname, "auto-mode-policy.js")]) {
      const usage = run([file]);
      assert.equal(usage.status, 2, `${file} usage error exit code`);
      assert.match(usage.stderr, /usage: auto-mode-policy\.js validate\|render <json>/);
      const parse = run([file, "validate", bad]);
      assert.equal(parse.status, 2, `${file} unreadable policy exit code`);
      const invalid = path.join(dir, "invalid.json");
      fs.writeFileSync(invalid, JSON.stringify({ schema: "not-a-schema" }));
      const result = run([file, "validate", invalid]);
      assert.equal(result.status, 1, `${file} invalid policy exit code`);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-871: adopter .mcp.json launcher paths still dispatch with the same exit codes and messages", () => {
  const example = JSON.parse(fs.readFileSync(path.join(COORD_ROOT_DIR, "examples", "mcp", "sentry.mcp.json"), "utf8"));
  const spelled = Object.values(example.mcpServers).map((server) => server.args[0]);
  assert.deepEqual(spelled, ["coord/scripts/mcp-optional-launcher.js"], "the reviewed example spells the legacy launcher path");
  const env = { ...process.env };
  delete env.SENTRY_ACCESS_TOKEN;
  const run = (file, args) => spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8", env });
  const legacy = path.join(REPO_ROOT, spelled[0]);
  const engine = path.join(__dirname, "mcp-optional-launcher.js");
  for (const args of [["sentry"], ["no-such-connector"], []]) {
    const viaShim = run(legacy, args);
    const direct = run(engine, args);
    assert.equal(viaShim.status, 2, `launcher ${args.join(" ") || "(no args)"} refuses before starting a package manager`);
    assert.equal(viaShim.status, direct.status);
    assert.equal(viaShim.stderr, direct.stderr);
    assert.equal(viaShim.stdout, "");
  }
  assert.match(run(legacy, ["sentry"]).stderr, /missing required environment variable\(s\): SENTRY_ACCESS_TOKEN/);
});

test("COORD-871: the .mcp.json governance server path answers an MCP initialize over stdio", async () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".mcp.json"), "utf8"));
  const server = config.mcpServers.governance;
  assert.deepEqual(server.args, ["coord/scripts/governance-mcp.js"]);
  const { spawn } = require("node:child_process");
  const child = spawn(server.command, server.args, { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const response = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`no initialize response; stderr: ${stderrText}`)), 15000);
      let stderrText = "";
      child.stderr.on("data", (chunk) => { stderrText += chunk; });
      child.on("error", reject);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const line = buffer.split("\n").find((item) => item.trim());
        if (line && buffer.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coord-871", version: "0" } } }) + "\n");
    });
    assert.equal(response.id, 1);
    assert.ok(response.result && response.result.serverInfo, "initialize returns serverInfo");
  } finally {
    child.kill();
  }
});
