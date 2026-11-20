"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const HOOK = path.join(__dirname, "post-bash.js");
const TRUSTED_ROOT = path.resolve(__dirname, "../../../..");

// Run the real canonical hook and its real parsers. Only filesystem/config and
// process-launch boundaries are injected: no heartbeat can reach live runtime.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-post-bash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loader = path.join(dir, "io.cjs");
  fs.writeFileSync(loader, `
const Module = require("node:module"), fs = require("node:fs"), path = require("node:path");
const load = Module._load;
const spec = JSON.parse(process.env.POST_BASH_FIXTURE);
const entry = process.env.POST_BASH_ENTRY;
const root = path.resolve(path.dirname(entry), "../../../..");
const maturity = path.join(root, "coord", "TEST_MATURITY.md");
const board = path.join(spec.dir, "board.json");
const calls = [];
process.on("exit", () => fs.writeFileSync(spec.calls, JSON.stringify(calls)));
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename === entry) {
    if (request === "node:fs") return { ...fs,
      existsSync(file) { return file === maturity ? spec.maturity !== null : fs.existsSync(file); },
      readFileSync(file, options) {
        if (file === maturity) {
          if (spec.maturityError === "string") throw "fixture maturity read failure as text";
          if (spec.maturityError) throw new Error("fixture maturity read failure");
          return spec.maturity;
        }
        if (file === board) return spec.invalidBoard ? "{" : JSON.stringify(spec.board);
        return fs.readFileSync(file, options);
      },
    };
    if (request === "node:child_process") return {
      spawnSync(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, timeout: options.timeout, stdio: options.stdio });
        if (command === process.execPath && args[1] === "heartbeat") {
          if (spec.heartbeatError === "string") throw "fixture heartbeat launch failure as text";
          if (spec.heartbeatError) throw new Error("fixture heartbeat launch failure");
          return { status: spec.heartbeatStatus };
        }
        if (command === "git" && args[0] === "rev-parse") return { status: spec.hasRemote ? 0 : 1, stdout: "" };
        if (command === "git" && args[0] === "diff") return { status: spec.diffStatus, stdout: spec.diff };
        throw new Error("unexpected fixture process launch");
      },
    };
    if (request === path.join(root, "coord", "paths.js")) return {
      createCoordPaths() { return { boardPath: board, repoRoots: spec.roots, repoIntegrationBranches: spec.branches }; },
    };
  }
  return load.call(this, request, parent, isMain);
};
`);
  return (command, overrides = {}, output = '{"status":"merged"}') => {
    const callsPath = path.join(dir, "calls.json");
    const spec = { dir, calls: callsPath, maturity: `Last updated: ${new Date().toISOString()}\n`,
      board: { sections: [{ rows: [{ ID: "COORD-1052", Repo: "B" }] }] },
      roots: { B: path.join(dir, "backend") }, branches: { B: "integration-fixture" },
      heartbeatStatus: 0, hasRemote: true, diffStatus: 0, diff: "src/main.js\n", ...overrides };
    const result = spawnSync(process.execPath, ["--require", loader, HOOK], {
      cwd: dir, input: "", encoding: "utf8", timeout: 15000,
      env: { ...process.env, TOOL_INPUT: command, TOOL_OUTPUT: output,
        POST_BASH_ENTRY: HOOK, POST_BASH_FIXTURE: JSON.stringify(spec) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return { ...result, calls: JSON.parse(fs.readFileSync(callsPath, "utf8")), spec };
  };
}

test("COORD-1052: post-bash heartbeat uses trusted governance root and never blocks on failure", (t) => {
  const run = fixture(t);
  const success = run("coord/scripts/gov commit COORD-1052");
  assert.equal(success.stdout, "");
  assert.deepEqual(success.calls, [{ command: process.execPath,
    args: [path.join(TRUSTED_ROOT, "coord", "scripts", "governance.js"), "heartbeat", "COORD-1052"],
    cwd: TRUSTED_ROOT, timeout: 30000, stdio: "ignore" }]);
  assert.match(run("gov commit").stdout, /ADVISORY skipped \(heartbeat\): no ticket id/);
  assert.match(run("gov commit COORD-1052", { heartbeatStatus: 7 }).stdout, /heartbeat COORD-1052 exited 7/);
  assert.match(run("gov commit COORD-1052", { heartbeatStatus: null }).stdout, /exited abnormally/);
  assert.match(run("gov commit COORD-1052", { heartbeatError: true }).stdout, /ADVISORY skipped \(heartbeat\): fixture heartbeat launch failure/);
  assert.match(run("gov commit COORD-1052", { heartbeatError: "string" }).stdout, /ADVISORY skipped \(heartbeat\): fixture heartbeat launch failure as text/);
});

test("COORD-1052: post-bash advises only merged land commands and reports missing payloads", (t) => {
  const run = fixture(t);
  assert.equal(run("git status").stdout, "");
  assert.equal(run("gov land COORD-1052", {}, '{"status":"failed"}').stdout, "");
  const missing = run("");
  assert.match(missing.stdout, /ADVISORY skipped \(payload\)/);
  assert.deepEqual(missing.calls, []);
  assert.match(run("gov land").stdout, /ADVISORY skipped \(landed-diff\): no ticket id/);
});

test("COORD-1052: post-bash maturity advice distinguishes missing, stale, recent and unreadable audits", (t) => {
  const run = fixture(t);
  for (const maturity of [null, "Last updated: not yet run\n"]) {
    assert.match(run("gov land COORD-1052", { maturity }).stdout, /Test maturity has never been audited/);
  }
  assert.match(run("gov land COORD-1052", { maturity: "Last updated: invalid-time\n" }).stdout, /ADVISORY skipped \(test-maturity\): unparseable/);
  const old = `Last updated: ${new Date(Date.now() - 30 * 86400000).toISOString()}\n`;
  assert.match(run("gov land COORD-1052", { maturity: old }).stdout, /Test maturity last audited 30 days ago/);
  const failedRead = run("gov land COORD-1052", { maturityError: true });
  assert.match(failedRead.stdout, /ADVISORY skipped \(test-maturity\): fixture maturity read failure/);
  assert.match(failedRead.stdout, /diff has no test files/, "a maturity failure must not suppress independent diff advice");
  assert.match(run("gov land COORD-1052", { maturityError: "string" }).stdout, /ADVISORY skipped \(test-maturity\): fixture maturity read failure as text/);
  assert.doesNotMatch(run("gov land COORD-1052").stdout, /Test maturity/);
});

test("COORD-1052: post-bash uses configured integration branch and test filenames for diff advice", (t) => {
  const run = fixture(t);
  for (const hasRemote of [true, false]) {
    const result = run("gov land COORD-1052", { hasRemote });
    const ref = hasRemote ? "origin/integration-fixture" : "integration-fixture";
    assert.deepEqual(result.calls.map((call) => call.args), [
      ["rev-parse", "--verify", "--quiet", "origin/integration-fixture"],
      ["diff", `${ref}~1..${ref}`, "--name-only"],
    ]);
    assert.ok(result.calls.every((call) => call.cwd === result.spec.roots.B));
    assert.match(result.stdout, /Last landed ticket \(COORD-1052\) diff has no test files/);
  }
  assert.equal(run("gov land COORD-1052", { diff: "src/main.test.js\n" }).stdout, "");
  assert.match(run("gov land COORD-1052", { diff: null }).stdout, /diff has no test files/);
  assert.match(run("gov land COORD-1052", { diffStatus: 1 }).stdout, /ADVISORY skipped \(landed-diff\): git diff.*failed/);
});

test("COORD-1052: post-bash skips coord and unknown tickets and exposes unusable repository configuration", (t) => {
  const run = fixture(t);
  for (const board of [{}, { sections: [{}] }, { sections: [{ rows: [{ ID: "COORD-1052", Repo: "X" }] }] }]) {
    const result = run("gov land COORD-1052", { board });
    assert.equal(result.stdout, "");
    assert.deepEqual(result.calls, []);
  }
  for (const overrides of [{ roots: {} }, { branches: {} }, { branches: null }]) {
    assert.match(run("gov land COORD-1052", overrides).stdout, /ADVISORY skipped \(landed-diff\): no configured root\/integrationBranch/);
  }
  const broken = run("gov land COORD-1052", { invalidBoard: true });
  assert.match(broken.stdout, /ADVISORY skipped \(landed-diff\)/);
  assert.deepEqual(broken.calls, []);
});
