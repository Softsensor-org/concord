"use strict";

// App-local launcher for the read-only coord-ui cockpit. This script is copied
// into scaffolded apps under coord/scripts/, so it must resolve paths from here,
// not from the donor coord-template checkout.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = {
    host: process.env.COORD_UI_HOST || "0.0.0.0",
    port: process.env.COORD_UI_PORT || "3002",
    install: true,
    open: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--host") options.host = argv[++i];
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--port") options.port = argv[++i];
    else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else throw new Error(`Unknown coord-ui option: ${arg}`);
  }
  return options;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function waitForReady(url, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if ((res.statusCode || 500) < 500) {
          resolve();
        } else {
          retry();
        }
      });
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`coord-ui did not become ready within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(attempt, 750);
    };
    attempt();
  });
}

function commandExists(commandPath) {
  if (path.isAbsolute(commandPath)) return fs.existsSync(commandPath);
  const probe = process.platform === "win32"
    ? ["where", [commandPath]]
    : ["sh", ["-c", `command -v ${JSON.stringify(commandPath)}`]];
  const result = spawnSync(probe[0], probe[1], { stdio: "ignore" });
  return result.status === 0;
}

function openUrl(url) {
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(["cmd.exe", ["/c", "start", "", url]]);
  } else {
    const winCmd = "/mnt/c/Windows/System32/cmd.exe";
    const powerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    if (fs.existsSync(winCmd)) candidates.push([winCmd, ["/c", "start", "", url]]);
    if (fs.existsSync(powerShell)) candidates.push([powerShell, ["-NoProfile", "-Command", "Start-Process", url]]);
    candidates.push(["wslview", [url]]);
    candidates.push(["xdg-open", [url]]);
  }

  for (const [command, args] of candidates) {
    if (!commandExists(command)) continue;
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function printHelp() {
  process.stdout.write(`Usage: node coord/scripts/coord-ui-launch.js [options]

Launch the app-local read-only coord-ui cockpit against this repo's coord/.

Options:
  --port <port>     Port to serve on. Default: 3002 or COORD_UI_PORT.
  --host <host>     Host to bind. Default: 0.0.0.0 or COORD_UI_HOST.
  --no-install      Do not install coord-ui dependencies first.
  --no-open         Do not try to open a browser.
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(__dirname, "..", "..");
  const coordDir = path.join(repoRoot, "coord");
  const uiDir = path.join(repoRoot, "frontend", "apps", "coord-ui");
  const uiPackage = path.join(uiDir, "package.json");
  if (!fs.existsSync(uiPackage)) {
    console.error(`[coord-ui] Missing ${path.relative(repoRoot, uiPackage)}.`);
    console.error("[coord-ui] This workspace does not include the bundled UI. Re-run create-concord or upgrade the Concord bundle.");
    process.exit(1);
  }

  const npm = npmCommand();
  const nextPackage = path.join(uiDir, "node_modules", "next", "package.json");
  if (options.install && !fs.existsSync(nextPackage)) {
    console.log("[coord-ui] Installing coord-ui dependencies...");
    runChecked(npm, ["install"], { cwd: uiDir });
  }

  const browserUrl = `http://localhost:${options.port}`;
  console.log(`[coord-ui] COORD_DIR=${coordDir}`);
  console.log(`[coord-ui] Serving ${browserUrl}`);

  const child = spawn(npm, ["exec", "--", "next", "dev", "-p", String(options.port), "-H", String(options.host)], {
    cwd: uiDir,
    env: { ...process.env, COORD_DIR: coordDir },
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(`[coord-ui] Failed to start: ${err.message}`);
    process.exit(1);
  });

  if (options.open) {
    waitForReady(browserUrl)
      .then(() => {
        if (!openUrl(browserUrl)) {
          console.warn(`[coord-ui] Browser auto-open failed. Open ${browserUrl} manually.`);
        }
      })
      .catch((err) => console.warn(`[coord-ui] ${err.message}. Open ${browserUrl} manually if it is running.`));
  }

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
}

if (require.main === module) main();
