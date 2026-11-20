"use strict";

// COORD-949 — the governance hooks fail CLOSED when the hook itself crashes, fails
// to load, or receives a malformed or oversized payload.
//
// Every case runs the hook as a real child process, the way the harness runs a
// `"type": "command"` hook: a fresh node, the payload on stdin, TOOL_INPUT unset.
// Each case runs against a SANDBOXED coord root with a real `doing` lock file
// (or without one, for the "no governed work in flight" side of the policy), so
// the barrier's own lock-scoped decision is what is measured.
//
// Injection goes through the existing seams only: a `--require` preload patches
// the exported `decide` of runtime-authority-decision.js (the same seam
// runtime-authority-wiring.test.js uses for its capture shim) or the exported
// `acquireHookPayload` of hooks/hook-stdin.js. No shipped file is edited at test
// time. Load failures are produced by removing or corrupting a module inside the
// sandbox copy.
//
// Exit codes: 2 = block (the Claude Code PreToolUse blocking code); 0 = allow;
// anything else (notably 1) is a NON-blocking hook error to the harness, which is
// the fail-open window these tests exist to close.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENGINE_SCRIPTS = path.resolve(__dirname, "..");
const REAL_HOOKS = __dirname;
const REAL_COORD = path.resolve(__dirname, "..", "..", "..");
const REAL_BARRIER = path.join(ENGINE_SCRIPTS, "runtime-authority-hook.js");
const REAL_GUARD = path.join(REAL_HOOKS, "pre-bash-guard.js");
const REAL_SHIM = path.join(REAL_COORD, "scripts", "runtime-authority-hook.js");
const REAL_PATHS = path.join(REAL_COORD, "paths.js");
const REAL_DOCS = path.join(REAL_COORD, "engine", "docs", "RUNTIME_AUTHORITY.md");
const REAL_TEMPLATE = path.join(REAL_COORD, "engine", "provider-hook-templates", "claude.json");
const REAL_SETTINGS = path.join(REAL_COORD, "..", ".claude", "settings.json");

const RECOVERY = "OUT-OF-BAND RECOVERY";
const SIZE_REASON = /exceeded the hook payload size limit/;
const ONE_MIB = 1024 * 1024;

const TOOL_EVENT = {
  session_id: "6f1c2f4e-0d3a-4a11-9d2e-0d1f2a3b4c5d",
  hook_event_name: "PreToolUse",
  tool_use_id: "toolu_949FailureModes",
  tool_name: "Bash",
  tool_input: { command: "ls" },
};

// The payload kinds the ticket names. Each must be refused while a lock is active.
const MALFORMED = {
  "truncated JSON": Buffer.from('{"tool_name":"Write","tool_input":{"file_path":"/x","content":"y"'),
  "JSON array": Buffer.from("[]"),
  "JSON scalar": Buffer.from('"rm -rf x"'),
  "non-UTF-8 bytes": Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]),
};

// ---------------------------------------------------------------------------
// Sandbox: a coord root whose engine copy is the real code, except the entry
// file (copied, so its __dirname is the sandbox) and any module a case breaks.
// ---------------------------------------------------------------------------

function makeSandbox({ lock }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-949-")));
  const coord = path.join(base, "coord");
  const scripts = path.join(coord, "engine", "scripts");
  const hooks = path.join(scripts, "hooks");
  const worktree = path.join(coord, ".worktrees", "claudea805", "COORD-949");
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(coord, "board"), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.symlinkSync(REAL_PATHS, path.join(coord, "paths.js"));
  for (const entry of fs.readdirSync(ENGINE_SCRIPTS)) {
    if (entry !== "hooks") fs.symlinkSync(path.join(ENGINE_SCRIPTS, entry), path.join(scripts, entry));
  }
  for (const entry of fs.readdirSync(REAL_HOOKS)) fs.symlinkSync(path.join(REAL_HOOKS, entry), path.join(hooks, entry));
  fs.rmSync(path.join(scripts, "runtime-authority-hook.js"));
  fs.copyFileSync(REAL_BARRIER, path.join(scripts, "runtime-authority-hook.js"));
  fs.rmSync(path.join(hooks, "pre-bash-guard.js"));
  fs.copyFileSync(REAL_GUARD, path.join(hooks, "pre-bash-guard.js"));
  if (lock) {
    fs.writeFileSync(
      path.join(coord, ".runtime", "locks", "COORD-949.lock"),
      `${JSON.stringify({ ticket: "COORD-949", owner: "claudea805", status: "doing", worktree, session_id: "w949-fixture" }, null, 2)}\n`
    );
  }
  return {
    base,
    coord,
    scripts,
    hooks,
    worktree,
    barrier: path.join(scripts, "runtime-authority-hook.js"),
    guard: path.join(hooks, "pre-bash-guard.js"),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// Replace a sandbox module with a corrupted copy, or remove it (mode "missing").
function breakModule(file, mode) {
  fs.rmSync(file);
  if (mode === "syntax") fs.writeFileSync(file, "\"use strict\";\nconst broken = ;\n");
}

// A `--require` preload that patches an existing exported seam before the hook
// loads, so the hook's own destructuring or property access sees the injected fault.
function writePreload(sb, body) {
  const file = path.join(sb.base, "inject.js");
  fs.writeFileSync(file, `"use strict";\n${body}\n`);
  return file;
}
const DECIDE_THROWS = (sb) =>
  `const d = require(${JSON.stringify(path.join(sb.scripts, "runtime-authority-decision.js"))});\n` +
  "d.decide = function injected() { throw new Error('injected decide failure'); };";
const ACQUIRE_REJECTS = (sb) =>
  `const s = require(${JSON.stringify(path.join(sb.hooks, "hook-stdin.js"))});\n` +
  "s.acquireHookPayload = async function injected() { throw new Error('injected acquire failure'); };";

function run(entry, sb, { input, preload = null, cwd = sb.worktree, args = [] }) {
  const env = {
    ...process.env,
    COORD_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    COORD_PROVIDER: "",
    COORD_INSTANCE_ID: "",
    TOOL_INPUT: "",
    NODE_OPTIONS: preload ? `--require ${JSON.stringify(preload)}` : "",
  };
  return spawnSync(process.execPath, [entry, ...args], { cwd, env, input, encoding: "utf8", timeout: 30000, maxBuffer: 64 * ONE_MIB });
}

const toolInput = (obj = TOOL_EVENT) => Buffer.from(JSON.stringify(obj));

// ---------------------------------------------------------------------------
// (1) Crash, load failure, and require-time failure, with an active lock.
// ---------------------------------------------------------------------------

test("COORD-949: barrier decide() throwing with an active lock exits 2 and names out-of-band recovery", () => {
  const sb = makeSandbox({ lock: true });
  try {
    const res = run(sb.barrier, sb, { input: toolInput(), preload: writePreload(sb, DECIDE_THROWS(sb)) });
    assert.equal(res.status, 2, `expected block, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stderr, /CONCORD BARRIER ERROR: injected decide failure/);
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    sb.cleanup();
  }
});

test("COORD-949: barrier main() rejecting with an active lock exits 2 and names out-of-band recovery", () => {
  const sb = makeSandbox({ lock: true });
  try {
    const res = run(sb.barrier, sb, { input: toolInput(), preload: writePreload(sb, ACQUIRE_REJECTS(sb)) });
    assert.equal(res.status, 2, `expected block, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stderr, /injected acquire failure/);
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    sb.cleanup();
  }
});

test("COORD-949: guard main() rejecting exits 2 and names out-of-band recovery", () => {
  const sb = makeSandbox({ lock: true });
  try {
    const res = run(sb.guard, sb, { input: toolInput(), preload: writePreload(sb, ACQUIRE_REJECTS(sb)) });
    assert.equal(res.status, 2, `expected block, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stderr, /injected acquire failure/);
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    sb.cleanup();
  }
});

test("COORD-949: barrier with a required module missing exits 2 with an active lock, and 0 with none", () => {
  const locked = makeSandbox({ lock: true });
  try {
    breakModule(path.join(locked.hooks, "hook-stdin.js"), "missing");
    const res = run(locked.barrier, locked, { input: toolInput() });
    assert.equal(res.status, 2, `expected block, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    locked.cleanup();
  }
  const idle = makeSandbox({ lock: false });
  try {
    breakModule(path.join(idle.hooks, "hook-stdin.js"), "missing");
    const res = run(idle.barrier, idle, { input: toolInput() });
    assert.equal(res.status, 0, `no governed work in flight must not brick the workspace; stderr: ${res.stderr}`);
  } finally {
    idle.cleanup();
  }
});

test("COORD-949: guard with a syntax-broken required module exits 2 and names out-of-band recovery", () => {
  const sb = makeSandbox({ lock: true });
  try {
    breakModule(path.join(sb.hooks, "hook-lib.js"), "syntax");
    const res = run(sb.guard, sb, { input: toolInput() });
    assert.equal(res.status, 2, `a required guard must block, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    sb.cleanup();
  }
});

test("COORD-949: the wired coord/scripts shim exits 2 when its engine module cannot load", () => {
  // The shim is the entrypoint .claude/settings.json actually runs. It already
  // fails closed on a load error; this pins that so a later change cannot unwire it.
  const sb = makeSandbox({ lock: true });
  try {
    fs.copyFileSync(REAL_SHIM, path.join(sb.coord, "scripts", "runtime-authority-hook.js"));
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(path.join(sb.coord, "scripts", "runtime-authority-hook.js"), sb, { input: toolInput() });
    assert.equal(res.status, 2, `wired shim must block on a load failure; stderr: ${res.stderr}`);
    assert.match(res.stderr, /BLOCKED \(fail-closed\)/);
    // COORD-971: the shim names out-of-band recovery in the barrier wording.
    assert.match(res.stderr, new RegExp(RECOVERY));
  } finally {
    sb.cleanup();
  }
});

// COORD-971: the generated shims follow the engine entrypoints' rule and wording.
// The texts are the exact OUT_OF_BAND_RECOVERY strings of runtime-authority-hook.js
// (barrier) and hooks/pre-bash-guard.js (guard).
const BARRIER_RECOVERY = "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts and restart the session; or, if no governed work is in flight, release the active lock through the governance CLI.";
const GUARD_RECOVERY = "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts/hooks, restart the session, or land the change through governance (gov land / gov finalize) from that terminal.";
const WIRED_BARRIER = path.join("scripts", "runtime-authority-hook.js");

function wireShim(sb, rel) {
  const file = path.join(sb.coord, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(REAL_COORD, rel), file);
  return file;
}

test("COORD-971: the wired barrier shim exits 2 on a load failure while a governed lock is active", () => {
  const sb = makeSandbox({ lock: true });
  try {
    const shim = wireShim(sb, WIRED_BARRIER);
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 2, `active lock must block; stderr: ${res.stderr}`);
    assert.match(res.stderr, /^BLOCKED \(fail-closed\): coord\/scripts\/runtime-authority-hook\.js cannot load its engine module: /);
    assert.ok(res.stderr.endsWith(` ${BARRIER_RECOVERY}\n`), `barrier recovery wording; stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

test("COORD-971: the wired barrier shim exits 0 on a load failure with no governed lock, and still names recovery", () => {
  const sb = makeSandbox({ lock: false });
  try {
    const shim = wireShim(sb, WIRED_BARRIER);
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 0, `no governed work in flight must not brick the workspace; stderr: ${res.stderr}`);
    assert.ok(res.stderr.endsWith(` ${BARRIER_RECOVERY}\n`), `barrier recovery wording; stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

test("COORD-971: a done lock is not governed work, so the wired barrier shim exits 0 on a load failure", () => {
  const sb = makeSandbox({ lock: false });
  try {
    fs.writeFileSync(path.join(sb.coord, ".runtime", "locks", "COORD-949.lock"), JSON.stringify({ ticket: "COORD-949", status: "done", worktree: sb.worktree }));
    const shim = wireShim(sb, WIRED_BARRIER);
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 0, `done lock; stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

test("COORD-971: an unreadable lock file counts as governed work, so the wired barrier shim exits 2", () => {
  const sb = makeSandbox({ lock: false });
  try {
    fs.writeFileSync(path.join(sb.coord, ".runtime", "locks", "COORD-949.lock"), "{ not json");
    const shim = wireShim(sb, WIRED_BARRIER);
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 2, `unreadable lock must block; stderr: ${res.stderr}`);
    assert.ok(res.stderr.endsWith(` ${BARRIER_RECOVERY}\n`), `stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

test("COORD-971: an unreadable lock directory counts as governed work, so the wired barrier shim exits 2", () => {
  const sb = makeSandbox({ lock: false });
  try {
    const locks = path.join(sb.coord, ".runtime", "locks");
    fs.rmSync(locks, { recursive: true, force: true });
    fs.writeFileSync(locks, "not a directory\n");
    const shim = wireShim(sb, WIRED_BARRIER);
    breakModule(path.join(sb.hooks, "hook-stdin.js"), "missing");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 2, `unreadable lock dir must block; stderr: ${res.stderr}`);
    assert.ok(res.stderr.endsWith(` ${BARRIER_RECOVERY}\n`), `stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

test("COORD-971: the wired guard shim exits 2 on a load failure with no governed lock, and names guard recovery", () => {
  const sb = makeSandbox({ lock: false });
  try {
    const shim = wireShim(sb, path.join("scripts", "hooks", "pre-bash-guard.js"));
    breakModule(path.join(sb.hooks, "hook-lib.js"), "syntax");
    const res = run(shim, sb, { input: toolInput() });
    assert.equal(res.status, 2, `a required guard never fails open; stderr: ${res.stderr}`);
    assert.match(res.stderr, /^BLOCKED \(fail-closed\): coord\/scripts\/hooks\/pre-bash-guard\.js cannot load its engine module: /);
    assert.ok(res.stderr.endsWith(` ${GUARD_RECOVERY}\n`), `guard recovery wording; stderr: ${res.stderr}`);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (2) Malformed payloads: refused with an active lock, unchanged without one.
// ---------------------------------------------------------------------------

for (const [kind, body] of Object.entries(MALFORMED)) {
  test(`COORD-949: barrier refuses a ${kind} payload while a lock is active (exit 2)`, () => {
    const sb = makeSandbox({ lock: true });
    try {
      const res = run(sb.barrier, sb, { input: body });
      assert.equal(res.status, 2, `${kind} must be refused, got ${res.status}; stderr: ${res.stderr}`);
      assert.match(res.stderr, /payload_unavailable/);
      assert.match(res.stderr, new RegExp(RECOVERY));
    } finally {
      sb.cleanup();
    }
  });

  test(`COORD-949: barrier keeps today's behaviour for a ${kind} payload with no lock (exit 0)`, () => {
    const sb = makeSandbox({ lock: false });
    try {
      const res = run(sb.barrier, sb, { input: body });
      assert.equal(res.status, 0, `no governed work in flight must not be bricked; stderr: ${res.stderr}`);
    } finally {
      sb.cleanup();
    }
  });
}

test("COORD-949: guard refuses every malformed payload kind, with and without a lock (exit 2)", () => {
  for (const lock of [true, false]) {
    const sb = makeSandbox({ lock });
    try {
      for (const [kind, body] of Object.entries(MALFORMED)) {
        const res = run(sb.guard, sb, { input: body });
        assert.equal(res.status, 2, `guard must block ${kind} (lock=${lock}), got ${res.status}; stderr: ${res.stderr}`);
      }
    } finally {
      sb.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// (3) Oversized payloads through the real entrypoints.
// ---------------------------------------------------------------------------

test("COORD-949: an oversized payload through the real barrier entrypoint is refused with an active lock, allowed with none", () => {
  const big = Buffer.from(`{"tool_name":"Bash","tool_input":{"command":"${"a".repeat(9 * ONE_MIB)}"}}`);
  const locked = makeSandbox({ lock: true });
  try {
    const res = run(locked.barrier, locked, { input: big });
    assert.equal(res.status, 2, `oversized payload must be refused; stderr: ${res.stderr}`);
    assert.match(res.stderr, /payload_unavailable/);
    assert.match(res.stderr, SIZE_REASON);
  } finally {
    locked.cleanup();
  }
  const idle = makeSandbox({ lock: false });
  try {
    const res = run(idle.barrier, idle, { input: big });
    assert.equal(res.status, 0, `no lock: oversized payload stays out of the way; stderr: ${res.stderr}`);
  } finally {
    idle.cleanup();
  }
});

test("COORD-949: an oversized payload through the real guard entrypoint is refused with the documented reason", () => {
  const big = Buffer.from(`{"tool_input":{"command":"${"a".repeat(9 * ONE_MIB)}"}}`);
  const sb = makeSandbox({ lock: true });
  try {
    const res = run(sb.guard, sb, { input: big });
    assert.equal(res.status, 2, `oversized guard payload must block; stderr: ${res.stderr}`);
    assert.match(res.stderr, SIZE_REASON);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) Timeouts, and the recorded behaviour when the harness kills a hook.
// ---------------------------------------------------------------------------

function preToolUseCommands(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = (doc.hooks && doc.hooks.PreToolUse) || [];
  return entries.flatMap((entry) => (entry.hooks || []).map((hook) => ({ command: hook.command, timeout: hook.timeout })));
}

test("COORD-949: every PreToolUse hook declares a timeout or a documented reason for none, and the harness-kill behaviour is recorded", () => {
  const docs = fs.readFileSync(REAL_DOCS, "utf8");
  assert.match(docs, /^## Hook failure modes \(COORD-949\)$/m, "RUNTIME_AUTHORITY.md must carry the hook failure modes section");
  assert.match(docs, /harness/i);
  assert.match(docs, /killed/i, "the docs must say what happens when the harness kills a hook");
  assert.match(docs, /non-blocking/i, "the docs must name the non-blocking outcome of a killed or crashed hook");

  const hooks = [...preToolUseCommands(REAL_SETTINGS), ...preToolUseCommands(REAL_TEMPLATE)];
  assert.ok(hooks.some((h) => /runtime-authority-hook\.js/.test(h.command)), "the barrier must be in the PreToolUse set");
  assert.ok(hooks.some((h) => /pre-bash-guard\.js/.test(h.command)), "the guard must be in the PreToolUse set");
  for (const hook of hooks) {
    if (Number.isFinite(hook.timeout) && hook.timeout > 0) continue;
    const row = docs.split("\n").find((line) => line.includes(`\`${hook.command}\``) && /no timeout/i.test(line));
    assert.ok(row, `PreToolUse hook has no timeout and no documented reason in RUNTIME_AUTHORITY.md: ${hook.command}`);
  }
});

test("COORD-1052: the authority barrier preserves refusal and audit behavior for an incomplete harness envelope", (t) => {
  const sb = makeSandbox({ lock: true });
  t.after(sb.cleanup);
  const runtime = path.join(sb.coord, ".runtime");
  const worktreeMarker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;
  const worktreeOffset = REAL_COORD.indexOf(worktreeMarker);
  const canonicalCoord = worktreeOffset < 0
    ? REAL_COORD
    : path.join(REAL_COORD.slice(0, worktreeOffset), "coord");
  // Run the shipped entrypoint with real lock and ledger I/O confined to the
  // fixture. The child inherits no writable reference to the live runtime
  // through any of the hook's filesystem calls.
  const preload = writePreload(sb, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const installedRuntime = ${JSON.stringify(path.join(canonicalCoord, ".runtime"))};`,
    `const fixtureRuntime = ${JSON.stringify(runtime)};`,
    "for (const method of ['existsSync', 'readdirSync', 'readFileSync', 'mkdirSync', 'openSync', 'appendFileSync', 'rmSync']) {",
    "  const original = fs[method];",
    "  fs[method] = function (file, ...args) {",
    "    if (typeof file === 'string' && (file === installedRuntime || file.startsWith(installedRuntime + path.sep))) {",
    "      file = path.join(fixtureRuntime, path.relative(installedRuntime, file));",
    "    }",
    "    return original.call(this, file, ...args);",
    "  };",
    "}",
  ].join("\n"));

  const absent = run(REAL_BARRIER, sb, { preload, input: "" });
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /payload_unavailable.*no tool payload reached/);
  assert.match(absent.stderr, new RegExp(RECOVERY));

  const incomplete = toolInput({ command: "rmdir placeholder" });
  const denied = run(REAL_BARRIER, sb, { preload, input: incomplete });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /CONCORD DENY \[destructive_shell\]/);
  const ledgerDir = path.join(runtime, "action-ledgers");
  const ledger = path.join(ledgerDir, "_authority-barrier.ndjson");
  const entries = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.map(({ code }) => code), ["payload_unavailable", "destructive_shell"]);
  assert.equal(entries[1].ticket, null);
  assert.equal(entries[1].tool, "unknown");
  assert.match(entries[1].action_id, /^\d+-\d+$/);

  const outsideLock = run(REAL_BARRIER, sb, {
    preload, cwd: sb.base, args: ["--subagent-start"], input: toolInput({ agent_id: "fixture-child" }),
  });
  assert.equal(outsideLock.status, 0, outsideLock.stderr);
  assert.equal(fs.existsSync(path.join(runtime, "subagents")), false);
  assert.deepEqual(fs.readdirSync(ledgerDir), [path.basename(ledger)]);

  fs.rmSync(ledgerDir, { recursive: true });
  fs.writeFileSync(ledgerDir, "an obstruction at the ledger directory");
  const unauditable = run(REAL_BARRIER, sb, { preload, input: incomplete });
  assert.equal(unauditable.status, 2, unauditable.stderr);
  assert.match(unauditable.stderr, /CONCORD DENY \[destructive_shell\]/);
  assert.equal(fs.readFileSync(ledgerDir, "utf8"), "an obstruction at the ledger directory");
});
