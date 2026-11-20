"use strict";

// Each release shard installs from its own immutable checkout. No dependency
// directory is borrowed from the donor or another worker.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { defaultExec } = require("./release-gates.js");

function bootstrapWorkerUi({ workspaceRoot, timeoutSeconds = 300, env = process.env }) {
  const started = process.hrtime.bigint();
  const receipt = { status: "failed", package_sha256: null, lock_sha256: null,
    command: null, exit_code: null, duration_ms: 0, message: "" };
  const finish = (status, message) => ({ ...receipt, status, message,
    duration_ms: Number(process.hrtime.bigint() - started) / 1e6 });
  const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  try {
    const root = fs.realpathSync(workspaceRoot);
    const ui = path.join(root, "frontend", "apps", "coord-ui");
    // Check components before following them, including dangling symlinks.
    for (const relative of ["frontend", "frontend/apps", "frontend/apps/coord-ui",
      "frontend/apps/coord-ui/package.json", "frontend/apps/coord-ui/package-lock.json",
      "frontend/apps/coord-ui/node_modules"]) {
      const file = path.join(root, relative);
      if (exists(file) && fs.lstatSync(file).isSymbolicLink()) return finish("failed", `unsafe symlink: ${relative}`);
    }
    const manifest = path.join(ui, "package.json");
    const lock = path.join(ui, "package-lock.json");
    if (!exists(manifest) && !exists(lock)) return finish("skipped", "no UI package or lockfile in this worker");
    if (!exists(manifest) || !fs.statSync(manifest).isFile()) return finish("failed", "UI package.json is missing or not a regular file");
    if (!exists(lock) || !fs.statSync(lock).isFile()) return finish("failed", "UI package-lock.json is missing or not a regular file");
    const relativeUi = path.relative(root, fs.realpathSync(ui));
    if (relativeUi === ".." || relativeUi.startsWith(`..${path.sep}`) || path.isAbsolute(relativeUi)) return finish("failed", "UI package escapes the worker checkout");
    if (!/^[1-9][0-9]{0,2}$/.test(String(timeoutSeconds)) || Number(timeoutSeconds) > 900) {
      return finish("failed", "UI install timeout must be an integer from 1 through 900 seconds");
    }
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(`cannot inspect worker source: ${result.error?.message || result.stderr || result.status}`);
      return result.stdout.trim();
    };
    if (fs.realpathSync(git("rev-parse", "--show-toplevel")) !== root) return finish("failed", "worker must be its own Git workspace root");
    if (git("status", "--porcelain", "--untracked-files=all")) return finish("failed", "worker source is dirty before UI install");
    const commit = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    receipt.package_sha256 = digest(manifest);
    receipt.lock_sha256 = digest(lock);
    receipt.command = ["npm", "--prefix", ui, "ci", "--include=dev", "--no-audit", "--no-fund"];
    // Reuse the existing bounded process-group executor: output goes to a file,
    // timeout kills the direct child and its descendants, including inherited
    // stdout holders. A plain spawnSync timeout would leave npm grandchildren.
    const installed = defaultExec(receipt.command[0], receipt.command.slice(1), {
      cwd: root, env, timeout: Number(timeoutSeconds) * 1000,
    });
    receipt.exit_code = installed.status;
    if (installed.status !== 0) return finish("failed", `npm ci failed: ${installed.output.slice(-4096)}`);
    if (git("rev-parse", "HEAD") !== commit || git("rev-parse", "HEAD^{tree}") !== tree ||
        git("status", "--porcelain", "--untracked-files=all") ||
        digest(manifest) !== receipt.package_sha256 || digest(lock) !== receipt.lock_sha256) {
      return finish("failed", "UI install changed committed source, package inputs, or the working tree");
    }
    // Lifecycle scripts must not replace validated paths with links.
    for (const file of [ui, manifest, lock, path.join(ui, "node_modules")]) {
      if (exists(file) && fs.lstatSync(file).isSymbolicLink()) return finish("failed", "UI install replaced an input or dependency directory with a symlink");
    }
    return finish("passed", "locked UI dependencies installed in this worker");
  } catch (error) {
    return finish("failed", error.message);
  }
}

module.exports = { bootstrapWorkerUi };
