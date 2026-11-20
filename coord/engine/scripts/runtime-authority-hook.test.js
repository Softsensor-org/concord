"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "runtime-authority-hook.js");

// Exercise the real entrypoint's load-failure recovery without reading or
// modifying the operator's canonical runtime. Only this child process receives
// the failing dependency and an fs view of this test's lock directory.
function runBrokenInstall(t, { entries = {}, absent = false, unreadable = false, imported = false, plainFailure = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-hook-load-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const locks = path.join(root, "locks");
  if (!absent) {
    fs.mkdirSync(locks);
    for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(locks, name), text);
  }
  const preload = path.join(root, "load-failure.cjs");
  fs.writeFileSync(preload, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const original = Module._load;
const entry = process.env.CONCORD_HOOK_TEST_ENTRY;
const locks = process.env.CONCORD_HOOK_TEST_LOCKS;
const view = {
  ...fs,
  readdirSync(file, ...args) {
    if (!String(file).endsWith(path.join(".runtime", "locks"))) throw Error("unexpected runtime access");
    if (process.env.CONCORD_HOOK_TEST_UNREADABLE === "1") {
      const error = new Error("fixture permission denied"); error.code = "EACCES"; throw error;
    }
    return fs.readdirSync(locks, ...args);
  },
  readFileSync(file, ...args) {
    if (!String(path.dirname(file)).endsWith(path.join(".runtime", "locks"))) throw Error("unexpected runtime access");
    return fs.readFileSync(path.join(locks, path.basename(file)), ...args);
  },
};
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename === entry) {
    if (request === "node:fs") return view;
    if (request === "./runtime-authority.js") {
      if (process.env.CONCORD_HOOK_TEST_PLAIN === "1") throw "fixture engine dependency unavailable";
      throw new Error("fixture engine dependency unavailable");
    }
  }
  return original.call(this, request, parent, isMain);
};
`);
  const args = imported ? ["-e", "require(process.env.CONCORD_HOOK_TEST_ENTRY)"] : [HOOK];
  const result = spawnSync(process.execPath, ["--require", preload, ...args], {
    cwd: root,
    env: { ...process.env, CONCORD_HOOK_TEST_ENTRY: HOOK, CONCORD_HOOK_TEST_PLAIN: plainFailure ? "1" : "0", CONCORD_HOOK_TEST_LOCKS: locks, CONCORD_HOOK_TEST_UNREADABLE: unreadable ? "1" : "0" },
    input: "",
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (imported) {
    assert.match(result.stderr, /Error: fixture engine dependency unavailable/);
    assert.doesNotMatch(result.stderr, /CONCORD BARRIER ERROR/);
    return result;
  }
  assert.match(result.stderr, /cannot load the authority barrier's engine modules: fixture engine dependency unavailable/);
  assert.match(result.stderr, /OUT-OF-BAND RECOVERY/);
  assert.equal(result.stdout, "");
  return result;
}

test("authority entrypoint blocks missing engine dependencies when active lock evidence cannot be inspected", (t) => {
  for (const scenario of [
    { entries: { "T-1.lock": JSON.stringify({ status: "doing" }) } },
    { entries: { "T-1.lock": "{truncated" } },
    { unreadable: true, plainFailure: true },
  ]) {
    const result = runBrokenInstall(t, scenario);
    assert.equal(result.status, 2, result.stderr);
  }
});

test("authority entrypoint does not block a broken install without governed work in flight", (t) => {
  assert.equal(runBrokenInstall(t, { imported: true }).status, 1);
  for (const scenario of [
    { absent: true },
    { entries: {} },
    { entries: { "README.md": "not a lock", "T-1.lock": JSON.stringify({ status: "done" }), "T-2.lock": "null" } },
  ]) {
    const result = runBrokenInstall(t, scenario);
    assert.equal(result.status, 0, result.stderr);
  }
});
