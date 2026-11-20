"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule, verifyShimRegistry, loadShimRegistry, isStableEntrypoint } = require("../../paths.js");

// COORD-872 (COORD-589 batch 9): the Claude hooks, the runtime-authority
// barrier and its decision/subagent modules, mutation-policy,
// sensitive-path-policy and the COORD-875 batch-9 assignments (shell-cwd-targets,
// identity-v2, human-agent-platform) moved under coord/engine/scripts.
// .claude/settings.json and adopter settings run the legacy hook paths, so
// scripts/hooks/*.js and scripts/runtime-authority-hook.js are PERMANENT shims
// (already approved stable_entrypoints); the rest are removable.

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);
const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");

const PERMANENT_CLI = ["hooks/post-bash", "hooks/pre-bash-guard", "hooks/session-start", "runtime-authority-hook"];
const PERMANENT_LIBRARY = ["hooks/hook-lib", "hooks/hook-stdin"];
const REMOVABLE_CLI = ["mutation-policy"];
const REMOVABLE_LIBRARY = [
  "human-agent-platform",
  "identity-v2",
  "runtime-authority",
  "runtime-authority-decision",
  "runtime-authority-subagent",
  "sensitive-path-policy",
  "shell-cwd-targets",
];

test("COORD-872: every batch-9 module is a registered shim of the right kind at its legacy path", () => {
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  const all = [...PERMANENT_CLI, ...PERMANENT_LIBRARY, ...REMOVABLE_CLI, ...REMOVABLE_LIBRARY];
  for (const name of all) {
    const rel = `scripts/${name}.js`;
    const permanent = PERMANENT_CLI.includes(name) || PERMANENT_LIBRARY.includes(name);
    const shim = registry.shims.find((entry) => entry.path === rel);
    assert.ok(shim, `${rel} is registered`);
    assert.equal(shim.target, `engine/${rel}`);
    assert.equal(shim.kind, permanent ? "permanent" : "removable", rel);
    assert.equal(isStableEntrypoint(registry, rel), permanent, `${rel} stable-entrypoint status`);
    const engineFile = path.join(__dirname, `${name}.js`);
    assert.ok(fs.existsSync(engineFile), `engine module ${name}.js exists`);
    // Requiring a hook entrypoint must not run it: the hook reads stdin and exits.
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(engineFile), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, rel)));
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `engine-only:${rel}`)));
    if (PERMANENT_CLI.includes(name) || REMOVABLE_CLI.includes(name)) {
      assert.equal(typeof legacyModule.main, "function", `${name} exports main for its CLI shim`);
    }
  }
  assert.deepEqual(verifyShimRegistry(COORD_ROOT_DIR), [], "every registered shim delegates to its engine target");
});

test("COORD-872: the settings-configured hook commands still name existing legacy entrypoints", () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude", "settings.json"), "utf8"));
  const commands = JSON.stringify(settings.hooks || {}).match(/coord\/scripts\/[\w/.-]+\.js/g) || [];
  assert.ok(commands.length > 0, "settings name hook entrypoints");
  const registry = loadShimRegistry(COORD_ROOT_DIR);
  for (const command of new Set(commands)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, command)), `${command} exists`);
    assert.equal(isStableEntrypoint(registry, command.slice("coord/".length)), true, `${command} is a stable entrypoint`);
  }
});

test("COORD-872: legacy and engine CLI entrypoints run the same command line with the same exit codes", () => {
  const run = (file, args, input) => spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8", input });
  const pair = (name) => [path.join(LEGACY_DIR, `${name}.js`), path.join(__dirname, `${name}.js`)];
  const [legacyPolicy, enginePolicy] = pair("mutation-policy").map((file) => run(file, ["bogus-command"]));
  assert.equal(legacyPolicy.status, 2, "mutation-policy usage error exit code via the shim");
  assert.equal(legacyPolicy.status, enginePolicy.status);
  // COORD-991: the removable legacy shim adds exactly its deprecation line to the engine's stderr.
  assert.equal(legacyPolicy.stderr, `DEPRECATED: coord/scripts/mutation-policy.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/mutation-policy.js instead.\n${enginePolicy.stderr}`);
  const [legacyBarrier, engineBarrier] = pair("runtime-authority-hook").map((file) => run(file, [], "{}"));
  assert.equal(legacyBarrier.status, engineBarrier.status, "runtime-authority-hook exit code is the engine's");
});

// COORD-872 (human-admin ruling 2026-11-04): a hook shim whose engine copy is
// missing, broken, or whose resolver cannot load must BLOCK (exit 2), never exit 1
// (which the Claude hook runner treats as non-blocking, i.e. fail open).
const HOOK_SHIMS = [
  ...fs.readdirSync(path.join(LEGACY_DIR, "hooks")).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js")).map((name) => `hooks/${name}`),
  "runtime-authority-hook.js",
];

function hiddenEngineFixture(t, { engine = "missing", paths = true } = {}) {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-872-failclosed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  fs.mkdirSync(path.join(coord, "scripts", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(coord, "engine", "scripts", "hooks"), { recursive: true });
  if (paths) fs.copyFileSync(path.join(COORD_ROOT_DIR, "paths.js"), path.join(coord, "paths.js"));
  fs.copyFileSync(path.join(COORD_ROOT_DIR, "engine", "shim-registry.json"), path.join(coord, "engine", "shim-registry.json"));
  for (const rel of HOOK_SHIMS) {
    fs.copyFileSync(path.join(LEGACY_DIR, rel), path.join(coord, "scripts", rel));
    if (engine === "broken") fs.writeFileSync(path.join(coord, "engine", "scripts", rel), 'throw new Error("broken engine copy");\n');
  }
  return coord;
}

test("COORD-872: every legacy hook shim exits 2 (block) when its engine copy cannot load", (t) => {
  assert.ok(HOOK_SHIMS.includes("hooks/pre-bash-guard.js") && HOOK_SHIMS.includes("hooks/post-bash.js"));
  assert.equal(HOOK_SHIMS.length, 6, "five hooks/*.js entrypoints plus runtime-authority-hook.js");
  const cases = [
    ["engine copy missing", { engine: "missing" }, /engine-only module not found/],
    ["engine copy throws while loading", { engine: "broken" }, /broken engine copy/],
    ["resolver (paths.js) missing", { paths: false }, /Cannot find module/],
  ];
  for (const [label, options, reason] of cases) {
    const coord = hiddenEngineFixture(t, options);
    for (const rel of HOOK_SHIMS) {
      const result = spawnSync(process.execPath, [path.join(coord, "scripts", rel)], {
        cwd: path.dirname(coord), encoding: "utf8", input: JSON.stringify({ tool_input: { command: "git push origin main" } }),
      });
      // COORD-971: the barrier shim is lock-gated like runtime-authority-hook.js. This
      // fixture has no governed lock, so it allows (0) and still names the recovery; every
      // hooks/*.js shim (a required guard or hook library) keeps blocking (2).
      const barrier = rel === "runtime-authority-hook.js";
      assert.equal(result.status, barrier ? 0 : 2, `${rel} with ${label} must ${barrier ? "allow without a lock" : "block"} (stderr: ${result.stderr})`);
      assert.match(result.stderr, new RegExp(`BLOCKED \\(fail-closed\\): coord/scripts/${rel.replace(/\./g, "\\.")} cannot load its engine module`));
      assert.match(result.stderr, reason, `${rel} names why (${label})`);
      assert.ok(result.stderr.endsWith(` ${barrier ? BARRIER_OUT_OF_BAND : GUARD_OUT_OF_BAND}\n`), `${rel} names out-of-band recovery (${label}): ${result.stderr}`);
    }
  }
});

test("COORD-872: every legacy hook shim is the fail-closed template, and requiring it still surfaces the error", (t) => {
  const { renderShimSource } = require("../../paths.js");
  for (const rel of HOOK_SHIMS) {
    const text = fs.readFileSync(path.join(LEGACY_DIR, rel), "utf8");
    const body = (source) => source.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).join("\n");
    const rendered = [false, true].map((cli) => body(renderShimSource(`scripts/${rel}`, { cli, failClosed: true })));
    assert.ok(rendered.includes(body(text)), `${rel} uses the fail-closed shim template`);
  }
  const coord = hiddenEngineFixture(t, { engine: "missing" });
  assert.throws(() => require(path.join(coord, "scripts", "hooks", "hook-lib.js")), /engine-only module not found/,
    "a library caller requiring the shim gets the resolution error, not a process exit");
});

// COORD-872: the crash handlers moved into each hook's exported runHook, which
// the permanent shims re-dispatch. Each is driven through a real child process
// of the ENGINE file and of its legacy shim, with the fault injected by a
// --require preload that replaces one dependency export before the hook loads
// (no production seam). The child keeps the parent env, so NODE_V8_COVERAGE
// still measures it.
const HOOK_IDENTITY_ENV = ["COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];

function faultFixture(t) {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-872-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "inject-fault.js");
  fs.writeFileSync(preload, [
    '"use strict";',
    "const target = require(process.env.COORD_872_FAULT_MODULE);",
    "const name = process.env.COORD_872_FAULT_EXPORT;",
    'if (typeof target[name] !== "function") throw new Error(`no function export ${name} to fault`);',
    'const value = process.env.COORD_872_FAULT_KIND === "string" ? process.env.COORD_872_FAULT_MESSAGE : new Error(process.env.COORD_872_FAULT_MESSAGE);',
    'target[name] = process.env.COORD_872_FAULT_ASYNC === "1" ? async () => { throw value; } : () => { throw value; };',
    "// Optional second fault (always a synchronous throw), for a handler that itself fails.",
    "if (process.env.COORD_872_FAULT2_MODULE) {",
    "  const second = require(process.env.COORD_872_FAULT2_MODULE);",
    "  const secondName = process.env.COORD_872_FAULT2_EXPORT;",
    '  if (typeof second[secondName] !== "function") throw new Error(`no function export ${secondName} to fault`);',
    "  second[secondName] = () => { throw new Error(process.env.COORD_872_FAULT2_MESSAGE); };",
    "}",
    "",
  ].join("\n"));
  return { dir, preload };
}

function runFaulted(preload, file, { module: faultModule, exportName, message, kind = "error", async = false, args = [], env = {}, input = "", second = null }) {
  const childEnv = { ...process.env };
  for (const key of [...HOOK_IDENTITY_ENV, "TOOL_INPUT", "TOOL_OUTPUT", "COORD_HOOK_ROOT", "COORD_CANONICAL_DIR"]) delete childEnv[key];
  Object.assign(childEnv, env, {
    COORD_872_FAULT_MODULE: faultModule,
    COORD_872_FAULT_EXPORT: exportName,
    COORD_872_FAULT_MESSAGE: message,
    COORD_872_FAULT_KIND: kind,
    COORD_872_FAULT_ASYNC: async ? "1" : "0",
  });
  if (second) Object.assign(childEnv, { COORD_872_FAULT2_MODULE: second.module, COORD_872_FAULT2_EXPORT: second.exportName, COORD_872_FAULT2_MESSAGE: second.message });
  return spawnSync(process.execPath, ["--require", preload, file, ...args], {
    cwd: REPO_ROOT, encoding: "utf8", env: childEnv, input, timeout: 30000,
  });
}

const ENGINE_HOOKS_DIR = path.join(__dirname, "hooks");
const HOOK_STDIN = path.join(ENGINE_HOOKS_DIR, "hook-stdin.js");
const HOOK_LIB = path.join(ENGINE_HOOKS_DIR, "hook-lib.js");
const DECISION = path.join(__dirname, "runtime-authority-decision.js");
// COORD-949: message names out-of-band recovery (acceptance 1). These are the exact
// recovery texts the fail-closed crash messages carry while a block is raised.
const BARRIER_OUT_OF_BAND = "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts and restart the session; or, if no governed work is in flight, release the active lock through the governance CLI.";
const GUARD_OUT_OF_BAND = "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts/hooks, restart the session, or land the change through governance (gov land / gov finalize) from that terminal.";

test("COORD-872: pre-bash-guard blocks (exit 2) and names the crash when its main rejects, via engine and legacy paths", (t) => {
  const { preload } = faultFixture(t);
  const cases = [
    // A risky push reaches the protected-branch lookup, which crashes.
    { module: HOOK_LIB, exportName: "loadProtectedBranches", message: "injected protected-branch crash", env: { TOOL_INPUT: "git push origin main" } },
    // A non-Error rejection is reported by its own text.
    { module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, kind: "string", message: "injected string rejection" },
  ];
  for (const file of [path.join(ENGINE_HOOKS_DIR, "pre-bash-guard.js"), path.join(LEGACY_DIR, "hooks", "pre-bash-guard.js")]) {
    for (const spec of cases) {
      const result = runFaulted(preload, file, spec);
      assert.equal(result.status, 2, `${file} ${spec.exportName}: ${result.stderr}`);
      // COORD-949: message names out-of-band recovery (acceptance 1).
      assert.equal(result.stderr.trim(), `BLOCKED (fail-closed): pre-bash-guard crashed: ${spec.message} ${GUARD_OUT_OF_BAND}`);
      assert.equal(result.stdout, "");
    }
  }
  // Control: without the fault, a non-git command is allowed, so the block above is the crash path.
  const clean = runFaulted(preload, path.join(ENGINE_HOOKS_DIR, "pre-bash-guard.js"),
    { module: HOOK_LIB, exportName: "isGovCommitCommand", message: "unused", env: { TOOL_INPUT: "ls" } });
  assert.equal(clean.status, 0, clean.stderr);
});

test("COORD-872: post-bash reports a rejected main as an ADVISORY skip and still exits 0, via engine and legacy paths", (t) => {
  const { preload } = faultFixture(t);
  const cases = [
    { module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, message: "injected payload crash" },
    { module: HOOK_LIB, exportName: "readHookPayload", kind: "string", message: "injected string throw" },
  ];
  for (const file of [path.join(ENGINE_HOOKS_DIR, "post-bash.js"), path.join(LEGACY_DIR, "hooks", "post-bash.js")]) {
    for (const spec of cases) {
      const result = runFaulted(preload, file, { ...spec, env: { TOOL_INPUT: "ls", TOOL_OUTPUT: "ok" } });
      assert.equal(result.status, 0, `${file} ${spec.exportName}: ${result.stderr}`);
      assert.equal(result.stdout, `ADVISORY skipped (post-bash): ${spec.message}\n`);
      assert.equal(result.stderr, "");
    }
  }
});

function barrierFixture(t, locks) {
  const os = require("node:os");
  const coord = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coord-872-barrier-")), "coord");
  t.after(() => fs.rmSync(path.dirname(coord), { recursive: true, force: true }));
  fs.mkdirSync(path.join(coord, ".runtime"), { recursive: true });
  installBarrier(coord);
  const locksDir = path.join(coord, ".runtime", "locks");
  if (locks === "doing") {
    fs.mkdirSync(locksDir);
    fs.writeFileSync(path.join(locksDir, "TEST-872.lock"), JSON.stringify({ ticket: "TEST-872", status: "doing", owner: "claudea1", worktree: path.join(path.dirname(coord), "wt") }));
  } else if (locks === "done") {
    fs.mkdirSync(locksDir);
    fs.writeFileSync(path.join(locksDir, "TEST-872.lock"), JSON.stringify({ ticket: "TEST-872", status: "done", worktree: "/x" }));
  } else if (locks === "unreadable-dir") {
    fs.writeFileSync(locksDir, "not a directory\n"); // readdir fails with ENOTDIR: activity we cannot see
  } else if (locks === "lock-is-directory") {
    fs.mkdirSync(path.join(locksDir, "TEST-872.lock"), { recursive: true }); // readFileSync fails with EISDIR
  }
  return coord;
}

// COORD-930: the canonical coord dir of a barrier is its own install location, so
// each fixture installs BOTH the entry hook and the legacy shim under its own coord.
// Every other engine module is a symlink to the real file.
function installBarrier(coord) {
  const scripts = path.join(coord, "engine", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const entry of fs.readdirSync(__dirname)) {
    if (entry !== "runtime-authority-hook.js") fs.symlinkSync(path.join(__dirname, entry), path.join(scripts, entry));
  }
  fs.copyFileSync(path.join(__dirname, "runtime-authority-hook.js"), path.join(scripts, "runtime-authority-hook.js"));
  fs.symlinkSync(path.join(__dirname, "..", "..", "paths.js"), path.join(coord, "paths.js"));
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(LEGACY_DIR, "runtime-authority-hook.js"), path.join(coord, "scripts", "runtime-authority-hook.js"));
}
function barrierFiles(coord) {
  return [path.join(coord, "engine", "scripts", "runtime-authority-hook.js"), path.join(coord, "scripts", "runtime-authority-hook.js")];
}

test("COORD-872: a crash inside the barrier's decide() fails closed only while a governed lock is active", (t) => {
  const { preload } = faultFixture(t);
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "touch x" } });
  for (const [locks, expected] of [["doing", 2], ["none", 0], ["done", 0]]) {
      const coord = barrierFixture(t, locks);
      for (const file of barrierFiles(coord)) {
      const result = runFaulted(preload, file, {
        module: DECISION, exportName: "decide", message: "injected decide crash",
        env: { TOOL_INPUT: payload },
      });
      assert.equal(result.status, expected, `${locks} via ${file}: ${result.stderr}`);
      // COORD-949: message names out-of-band recovery (acceptance 1) while a lock is active.
      const suffix = expected === 2 ? ` ${BARRIER_OUT_OF_BAND}` : "";
      assert.equal(result.stderr, `CONCORD BARRIER ERROR: injected decide crash (coord/engine/scripts/runtime-authority-decision.js)${suffix}\n`);
      assert.equal(fs.existsSync(path.join(coord, ".runtime", "action-ledgers")), false, "no verdict, so no ledger entry");
    }
  }
});

test("COORD-872: a rejected barrier main exits 2 when active or unreadable locks exist, else 0", (t) => {
  const { preload } = faultFixture(t);
  const message = "injected barrier main crash";
  for (const [locks, expected] of [["doing", 2], ["unreadable-dir", 2], ["lock-is-directory", 2], ["none", 0], ["done", 0]]) {
      const coord = barrierFixture(t, locks);
      for (const file of barrierFiles(coord)) {
      const result = runFaulted(preload, file, {
        module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, message,
        env: { TOOL_INPUT: "{}" },
      });
      assert.equal(result.status, expected, `${locks} via ${file}: ${result.stderr}`);
      // COORD-949: message names out-of-band recovery (acceptance 1) while a lock is active.
      const suffix = expected === 2 ? ` ${BARRIER_OUT_OF_BAND}` : "";
      assert.equal(result.stderr, `CONCORD BARRIER ERROR: ${message} (coord/scripts/runtime-authority-hook.js)${suffix}\n`);
      assert.equal(fs.existsSync(path.join(coord, ".runtime", "action-ledgers")), false);
    }
  }
  // A non-Error rejection is reported by its own text, and still fails closed.
  const stringCoord = barrierFixture(t, "doing");
  for (const file of barrierFiles(stringCoord)) {
    const result = runFaulted(preload, file, {
      module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, kind: "string", message: "injected string rejection",
      env: { TOOL_INPUT: "{}" },
    });
    assert.equal(result.status, 2, `string rejection via ${file}: ${result.stderr}`);
    // COORD-949: message names out-of-band recovery (acceptance 1); a lock is active here.
    assert.equal(result.stderr, `CONCORD BARRIER ERROR: injected string rejection (coord/scripts/runtime-authority-hook.js) ${BARRIER_OUT_OF_BAND}\n`);
  }
});

test("COORD-872: a lock entry the subagent path cannot read rejects the barrier main and fails closed (no injected fault)", (t) => {
  const coord = barrierFixture(t, "lock-is-directory");
  for (const file of barrierFiles(coord)) {
    const env = { ...process.env };
    for (const key of [...HOOK_IDENTITY_ENV, "TOOL_INPUT"]) delete env[key];
    const result = spawnSync(process.execPath, [file, "--subagent-start"], {
      cwd: REPO_ROOT, encoding: "utf8", env, input: JSON.stringify({ agent_id: "sub-872" }), timeout: 30000,
    });
    assert.equal(result.status, 2, result.stderr);
    // COORD-949: message names out-of-band recovery (acceptance 1); a lock is active here.
    assert.equal(result.stderr, `CONCORD BARRIER ERROR: EISDIR: illegal operation on a directory, read (coord/scripts/runtime-authority-hook.js) ${BARRIER_OUT_OF_BAND}\n`);
    assert.equal(fs.existsSync(path.join(coord, ".runtime", "subagents")), false, "no subagent was registered");
    assert.equal(fs.existsSync(path.join(coord, ".runtime", "action-ledgers")), false);
  }
});

test("COORD-872: when the crash handler cannot enumerate locks it does not brick the workspace and exits 0", (t) => {
  const { preload } = faultFixture(t);
  const message = "injected barrier main crash";
  // A doing lock is present, so a handler that DID enumerate would exit 2: exit 0
  // here is the lock-enumeration fallback, not an empty workspace.
  const enumCoord = barrierFixture(t, "doing");
  for (const file of barrierFiles(enumCoord)) {
    const coord = enumCoord;
    const result = runFaulted(preload, file, {
      module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, message,
      second: { module: DECISION, exportName: "enumerateLocks", message: "injected lock enumeration crash" },
      env: { TOOL_INPUT: "{}" },
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.equal(result.stderr, `CONCORD BARRIER ERROR: ${message} (coord/scripts/runtime-authority-hook.js)\n`,
      "only the barrier error is reported; the enumeration failure is swallowed");
    assert.equal(fs.existsSync(path.join(coord, ".runtime", "action-ledgers")), false);
    assert.equal(fs.readdirSync(path.join(coord, ".runtime", "locks")).join(","), "TEST-872.lock", "the lock is left as it was");
  }
  // Control: the same doing lock without the enumeration fault fails closed (exit 2).
  const controlCoord = barrierFixture(t, "doing");
  const control = runFaulted(preload, barrierFiles(controlCoord)[0], {
    module: HOOK_STDIN, exportName: "acquireHookPayload", async: true, message,
    env: { TOOL_INPUT: "{}" },
  });
  assert.equal(control.status, 2, control.stderr);
});
