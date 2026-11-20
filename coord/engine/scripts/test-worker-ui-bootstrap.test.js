"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture } = require("./test-git-fixture.js");
const { bootstrapWorkerUi } = require("./test-worker-ui-bootstrap.js");

function fixture(t, { ui = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-worker-ui-")));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "coord-worker-ui-bin-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  const packageDir = path.join(root, "frontend/apps/coord-ui");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(root, "README.md"), "worker fixture\n");
  if (ui) {
    fs.mkdirSync(packageDir, { recursive: true });
    const dependencies = { "worker-local-dependency": "file:./local-package" };
    const localPackage = path.join(packageDir, "local-package");
    fs.mkdirSync(localPackage);
    fs.writeFileSync(path.join(localPackage, "package.json"), JSON.stringify({ name: "worker-local-dependency", version: "1.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(localPackage, "index.js"), 'module.exports = "installed in this worker";\n');
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "worker-fixture", version: "1.0.0", private: true, dependencies }));
    fs.writeFileSync(path.join(packageDir, "package-lock.json"), JSON.stringify({ name: "worker-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "worker-fixture", version: "1.0.0", dependencies },
        "local-package": { name: "worker-local-dependency", version: "1.0.0" },
        "node_modules/worker-local-dependency": { resolved: "local-package", link: true } } }));
  }
  gitFixture(root, ["init", "-q", "."]);
  gitFixture(root, ["add", "."]);
  gitFixture(root, ["commit", "-qm", "UI worker fixture"]);
  const shim = (source) => {
    fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  };
  return { root, bin, packageDir, shim, npmCache: path.join(bin, "cache") };
}

test("COORD-1052: worker UI bootstrap installs a locked local dependency in a fresh worker and records inputs", (t) => {
  const f = fixture(t);
  const result = bootstrapWorkerUi({ workspaceRoot: f.root, timeoutSeconds: 60, env: { ...process.env, npm_config_offline: "true", npm_config_cache: f.npmCache } });
  assert.equal(result.status, "passed", result.message);
  assert.equal(result.exit_code, 0);
  assert.equal(require(path.join(f.packageDir, "node_modules", "worker-local-dependency")), "installed in this worker");
  assert.match(result.package_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.lock_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.command, ["npm", "--prefix", f.packageDir, "ci", "--include=dev", "--no-audit", "--no-fund"]);
});

test("COORD-1052: absent UI is skipped but missing lockfiles, links and invalid bounds refuse before npm", (t) => {
  const absent = fixture(t, { ui: false });
  assert.equal(bootstrapWorkerUi({ workspaceRoot: absent.root }).status, "skipped");
  const f = fixture(t);
  const env = f.shim('throw new Error("npm must not be invoked");');
  for (const timeoutSeconds of [0, -1, 901, "1.5", "01", "infinite"]) {
    const result = bootstrapWorkerUi({ workspaceRoot: f.root, timeoutSeconds, env });
    assert.equal(result.status, "failed");
    assert.match(result.message, /integer from 1 through 900/);
    assert.equal(result.exit_code, null);
  }
  const lock = path.join(f.packageDir, "package-lock.json");
  fs.unlinkSync(lock);
  const missing = bootstrapWorkerUi({ workspaceRoot: f.root, env });
  assert.equal(missing.status, "failed");
  assert.match(missing.message, /lock.*missing/);
  fs.symlinkSync(path.join(f.packageDir, "package.json"), lock);
  const linked = bootstrapWorkerUi({ workspaceRoot: f.root, env });
  assert.equal(linked.status, "failed");
  assert.match(linked.message, /unsafe symlink/);
});

test("COORD-1052: worker UI bootstrap rejects install failure and source mutation", (t) => {
  const f = fixture(t);
  const failed = bootstrapWorkerUi({ workspaceRoot: f.root, env: f.shim('process.stderr.write("fixture npm failure"); process.exit(19);') });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exit_code, 19);
  assert.match(failed.message, /fixture npm failure/);
  const changed = bootstrapWorkerUi({ workspaceRoot: f.root,
    env: f.shim('require("node:fs").writeFileSync("README.md", "changed by lifecycle script");') });
  assert.equal(changed.status, "failed");
  assert.equal(changed.exit_code, 0);
  assert.match(changed.message, /changed committed source/);
});

test("COORD-1052: worker UI bootstrap bounds a hanging npm process", (t) => {
  const f = fixture(t);
  const result = bootstrapWorkerUi({ workspaceRoot: f.root, timeoutSeconds: 1,
    env: f.shim('setInterval(() => {}, 1000);') });
  assert.equal(result.status, "failed");
  assert.notEqual(result.exit_code, 0);
  assert.match(result.message, /npm ci failed/);
});

test("worker UI bootstrap refuses missing packages, dirty source and nested Git roots before install", (t) => {
  const f = fixture(t);
  const env = f.shim('throw new Error("npm must not be invoked");');
  const manifest = path.join(f.packageDir, "package.json");
  const inputs = fs.readFileSync(manifest);
  fs.unlinkSync(manifest);
  const missing = bootstrapWorkerUi({ workspaceRoot: f.root, env });
  assert.equal(missing.status, "failed");
  assert.equal(missing.command, null);
  assert.match(missing.message, /package\.json is missing/);

  fs.writeFileSync(manifest, inputs);
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "work in progress");
  const dirty = bootstrapWorkerUi({ workspaceRoot: f.root, env });
  assert.equal(dirty.status, "failed");
  assert.equal(dirty.command, null);
  assert.match(dirty.message, /source is dirty before UI install/);

  const nested = path.join(f.root, "nested");
  fs.cpSync(path.join(f.root, "frontend"), path.join(nested, "frontend"), { recursive: true });
  const nestedRoot = bootstrapWorkerUi({ workspaceRoot: nested, env });
  assert.equal(nestedRoot.status, "failed");
  assert.equal(nestedRoot.command, null);
  assert.match(nestedRoot.message, /must be its own Git workspace root/);
});

test("worker UI bootstrap rejects install-created dependency symlinks and unreadable inputs", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".gitignore"), "node_modules\n");
  gitFixture(f.root, ["commit", "-qam", "Ignore generated dependency path"]);
  const link = path.join(f.packageDir, "node_modules");
  const linked = bootstrapWorkerUi({ workspaceRoot: f.root, env: f.shim(`
    require("node:fs").symlinkSync("local-package", ${JSON.stringify(link)}, "dir");
  `) });
  assert.equal(linked.status, "failed");
  assert.equal(linked.exit_code, 0);
  assert.match(linked.message, /replaced an input or dependency directory with a symlink/);
  assert.equal(gitFixture(f.root, ["status", "--porcelain", "--untracked-files=all"]), "");

  const missingRoot = bootstrapWorkerUi({ workspaceRoot: path.join(f.root, "missing-root") });
  assert.equal(missingRoot.status, "failed");
  assert.equal(missingRoot.command, null);
  assert.match(missingRoot.message, /ENOENT/);

  const notDirectory = bootstrapWorkerUi({ workspaceRoot: path.join(f.root, "README.md") });
  assert.equal(notDirectory.status, "failed");
  assert.equal(notDirectory.command, null);
  assert.match(notDirectory.message, /ENOTDIR/);
});

test("worker UI refuses a failed Git source probe and a package resolving outside the checkout", (t) => {
  const f = fixture(t);
  const missingGit = bootstrapWorkerUi({
    workspaceRoot: f.root, env: { ...process.env, PATH: f.root },
  });
  assert.equal(missingGit.command, null);
  assert.equal(missingGit.status, "failed");
  assert.match(missingGit.message, /cannot inspect worker source/);

  for (const diagnostic of ["source probe failed", ""]) {
    const gitPath = path.join(f.bin, "git");
    fs.writeFileSync(gitPath, `#!/bin/sh\necho -n "${diagnostic}" >&2\nexit 17\n`, { mode: 0o755 });
    const refused = bootstrapWorkerUi({ workspaceRoot: f.root, env: { ...process.env, PATH: f.bin } });
    assert.equal(refused.status, "failed");
    assert.equal(refused.command, null);
    assert.equal(refused.message, `cannot inspect worker source: ${diagnostic || 17}`);
  }

  const realpathSync = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (file, ...args) => file === f.packageDir
    ? path.dirname(f.root)
    : realpathSync(file, ...args));
  const escaped = bootstrapWorkerUi({ workspaceRoot: f.root });
  assert.equal(escaped.command, null);
  assert.equal(escaped.status, "failed");
  assert.match(escaped.message, /UI package escapes the worker checkout/);
});
