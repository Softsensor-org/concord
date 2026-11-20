"use strict";

// COORD-986 (ARCH-AUDIT F-05): the shared external-tool adapter skeleton. Red-first tests for the
// base module that the five quality policy adapters (a11y, mutation, perf-budget, sast,
// supply-chain) build on: binary lookup on PATH, override/local/PATH resolution, the
// table-driven tool selector, and the shared `classify` argv shell. Every external interaction is
// injected (fileExists, lookPath, env), so no real tool is required.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  defaultLookPath,
  resolveBin,
  selectTool,
  parseClassifyArgv,
} = require("./external-tool-adapter.js");

const sep = process.platform === "win32" ? ";" : ":";

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coord-986-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaultLookPath: returns the first PATH entry that holds the binary, skipping empty segments", (t) => {
  const first = tempDir(t, "first");
  const second = tempDir(t, "second");
  fs.writeFileSync(path.join(second, "semgrep"), "#!/bin/sh\n");
  const PATH = ["", first, second].join(sep);
  assert.equal(defaultLookPath("semgrep", { PATH }), path.join(second, "semgrep"));
});

test("defaultLookPath: returns null when no PATH entry holds the binary, and when PATH is absent", (t) => {
  const dir = tempDir(t, "empty");
  assert.equal(defaultLookPath("trivy", { PATH: dir }), null);
  assert.equal(defaultLookPath("trivy", {}), null);
  assert.equal(defaultLookPath("trivy", undefined), null);
});

test("defaultLookPath follows Windows PATH order past an unreadable entry to an executable", (t) => {
  const blocked = tempDir(t, "blocked");
  const empty = tempDir(t, "empty");
  const available = tempDir(t, "available");
  const executable = path.join(available, "scanner.exe");
  fs.writeFileSync(executable, "");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", (file) => {
    if (file === path.join(blocked, "scanner")) throw new Error("unreadable directory");
    return exists(file);
  });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    assert.equal(defaultLookPath("scanner", { PATH: [blocked, empty, available].join(";") }), executable);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("resolveBin: the override wins when it exists", () => {
  const got = resolveBin(
    { bin: "pa11y", overrideKey: "PA11Y_BIN" },
    "/repo",
    { fileExists: (p) => p === "/opt/pa11y", lookPath: () => "/usr/bin/pa11y", env: { PA11Y_BIN: "/opt/pa11y" } },
  );
  assert.equal(got, "/opt/pa11y");
});

test("resolveBin: a missing override falls through to the repo-local node_modules/.bin, then PATH", () => {
  const local = path.join("/repo", "node_modules", ".bin", "k6");
  const viaLocal = resolveBin(
    { bin: "k6", overrideKey: "K6_BIN" },
    "/repo",
    { fileExists: (p) => p === local, lookPath: () => "/usr/bin/k6", env: { K6_BIN: "/gone" } },
  );
  assert.equal(viaLocal, local);
  const viaPath = resolveBin(
    { bin: "k6", overrideKey: "K6_BIN" },
    "/repo",
    { fileExists: () => false, lookPath: (bin, environ) => (bin === "k6" && environ.PATH ? "/usr/bin/k6" : null), env: { PATH: "/usr/bin" } },
  );
  assert.equal(viaPath, "/usr/bin/k6");
});

test("resolveBin: the Windows .cmd shim is accepted after the plain local bin", () => {
  const cmd = path.join("/repo", "node_modules", ".bin", "axe") + ".cmd";
  const got = resolveBin({ bin: "axe", overrideKey: "AXE_BIN" }, "/repo", { fileExists: (p) => p === cmd, lookPath: () => null, env: {} });
  assert.equal(got, cmd);
});

test("resolveBin: onPath false never consults PATH (the Stryker shape)", () => {
  const got = resolveBin(
    { bin: "stryker", onPath: false },
    "/repo",
    { fileExists: () => false, lookPath: () => { throw new Error("PATH must not be consulted"); }, env: { PATH: "/usr/bin" } },
  );
  assert.equal(got, null);
});

test("resolveBin: without an overrideKey the environment is never read for an override", () => {
  const got = resolveBin({ bin: "stryker", onPath: false }, "/repo", { fileExists: (p) => p.endsWith("stryker"), env: { STRYKER_BIN: "/x" } });
  assert.equal(got, path.join("/repo", "node_modules", ".bin", "stryker"));
});

const TABLE = Object.freeze({
  preferEnv: "GATE_TEST_TOOL",
  tools: Object.freeze([
    Object.freeze({ name: "alpha", bin: "alpha-bin", overrideKey: "ALPHA_BIN" }),
    Object.freeze({ name: "beta", bin: "beta-bin", overrideKey: "BETA_BIN" }),
  ]),
  unavailable: "no test tool installed",
});

test("selectTool: takes the first resolvable tool in table order", () => {
  const d = selectTool(TABLE, "/repo", { fileExists: () => false, lookPath: (bin) => (bin === "beta-bin" ? "/usr/bin/beta-bin" : null), env: {} });
  assert.deepEqual(d, { available: true, tool: "beta", bin: "/usr/bin/beta-bin", reason: null });
  const first = selectTool(TABLE, "/repo", { fileExists: () => false, lookPath: () => "/usr/bin/x", env: {} });
  assert.deepEqual(first, { available: true, tool: "alpha", bin: "/usr/bin/x", reason: null });
});

test("selectTool: the preferEnv value (case-insensitive) moves that tool first", () => {
  const deps = { fileExists: () => false, lookPath: () => "/usr/bin/x", env: { GATE_TEST_TOOL: "BETA" } };
  assert.equal(selectTool(TABLE, "/repo", deps).tool, "beta");
});

test("selectTool: an unknown preference keeps table order", () => {
  const deps = { fileExists: () => false, lookPath: () => "/usr/bin/x", env: { GATE_TEST_TOOL: "gamma" } };
  assert.equal(selectTool(TABLE, "/repo", deps).tool, "alpha");
});

test("selectTool: when nothing resolves it reports the table's unavailable reason with null fields", () => {
  const d = selectTool(TABLE, "/repo", { fileExists: () => false, lookPath: () => null, env: {} });
  assert.deepEqual(d, { available: false, tool: null, bin: null, reason: "no test tool installed" });
});

test("parseClassifyArgv: a non-classify verb writes the usage text and refuses with 2", () => {
  const chunks = [];
  const err = { write: (s) => chunks.push(s) };
  const r = parseClassifyArgv([], err, { label: "test", usage: "usage: test classify\n", defaultMode: "ratchet", flags: {} });
  assert.deepEqual(r, { code: 2 });
  assert.deepEqual(chunks, ["usage: test classify\n"]);
});

test("parseClassifyArgv: flags map to option keys, numbers are converted, and the default mode applies", () => {
  const err = { write: () => {} };
  const flags = {
    "--root": { key: "repoRoot" },
    "--timeout-ms": { key: "timeoutMs", number: true },
    "--mode": { key: "mode" },
  };
  const r = parseClassifyArgv(["classify", "--root", "/r", "--timeout-ms", "250"], err, { label: "test", usage: "u\n", defaultMode: "threshold", flags });
  assert.deepEqual(r, { opts: { mode: "threshold", repoRoot: "/r", timeoutMs: 250 } });
  const withMode = parseClassifyArgv(["classify", "--mode", "ratchet", "--root", "/r"], err, { label: "test", usage: "u\n", defaultMode: "threshold", flags });
  assert.equal(withMode.opts.mode, "ratchet");
});

test("parseClassifyArgv: a missing --root writes the labelled refusal and refuses with 2", () => {
  const chunks = [];
  const err = { write: (s) => chunks.push(s) };
  const r = parseClassifyArgv(["classify", "--mode", "ratchet"], err, { label: "perf", usage: "u\n", defaultMode: "threshold", flags: { "--mode": { key: "mode" }, "--root": { key: "repoRoot" } } });
  assert.deepEqual(r, { code: 2 });
  assert.deepEqual(chunks, ["perf: ERROR --root <repo> is required\n"]);
});

test("parseClassifyArgv: unknown flags are ignored and a flag never consumes an unrelated prototype key", () => {
  const err = { write: () => {} };
  const flags = { "--root": { key: "repoRoot" } };
  const r = parseClassifyArgv(["classify", "--bogus", "x", "--root", "/r", "constructor"], err, { label: "t", usage: "u\n", defaultMode: "ratchet", flags });
  assert.deepEqual(r, { opts: { mode: "ratchet", repoRoot: "/r" } });
  const proto = parseClassifyArgv(["classify", "--root", "/r", "--constructor", "y"], err, { label: "t", usage: "u\n", defaultMode: "ratchet", flags });
  assert.equal(proto.opts.constructor, Object);
  assert.equal(Object.prototype.hasOwnProperty.call(proto.opts, "constructor"), false);
});

test("structure: each adapter imports the shared base and defines defaultLookPath nowhere else (F-05 ratchet)", () => {
  const adapters = ["a11y-policy.js", "mutation-policy.js", "perf-budget-policy.js", "sast-policy.js", "supply-chain-policy.js"];
  for (const name of adapters) {
    const src = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.ok(src.includes('require("./external-tool-adapter.js")'), `${name} must use the shared base`);
    assert.equal(/function defaultLookPath\(/.test(src), false, `${name} must not re-define defaultLookPath`);
  }
  const base = fs.readFileSync(path.join(__dirname, "external-tool-adapter.js"), "utf8");
  assert.equal((base.match(/function defaultLookPath\(/g) || []).length, 1, "defaultLookPath exists once");
});
