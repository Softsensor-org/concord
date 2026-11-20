"use strict";

// App-local launcher for the read-only coord-ui cockpit. This script is copied
// into scaffolded apps under coord/engine/scripts/, so it must resolve paths from here,
// not from the donor coord-template checkout.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawn, spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = {
    host: process.env.COORD_UI_HOST || "127.0.0.1",
    port: process.env.COORD_UI_PORT || "3002",
    install: true,
    open: true,
    help: false,
    allowRemoteBind: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--allow-remote-bind") options.allowRemoteBind = true;
    else if (arg === "--host") options.host = argv[++i];
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--port") options.port = argv[++i];
    else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else throw new Error(`Unknown coord-ui option: ${arg}`);
  }
  return options;
}

// COORD-940: loopback hosts are the only binds that need no flag and carry the loopback scope.
const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

function isLoopbackBindHost(host) {
  return LOOPBACK_BIND_HOSTS.includes(String(host).trim().toLowerCase());
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
  const started = performance.now();
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
      if (performance.now() - started > timeoutMs) {
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
  process.stdout.write(`Usage: node coord/engine/scripts/coord-ui-launch.js [options]

Launch the app-local read-only coord-ui cockpit against this repo's coord/.

Options:
  --port <port>     Port to serve on. Default: 3002 or COORD_UI_PORT.
  --host <host>     Host to bind. Default: 127.0.0.1 or COORD_UI_HOST.
                    A non-loopback host requires --allow-remote-bind.
  --allow-remote-bind
                    Permit binding a non-loopback host. Requires an operator-configured
                    auth mode: COORD_UI_AUTH_MODE=proxy-header behind a trusted proxy, or
                    COORD_UI_AUTH_MODE=shared-token with COORD_UI_AUTH_TOKEN.
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

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const coordDir = path.join(repoRoot, "coord");
  const uiDir = path.join(repoRoot, "frontend", "apps", "coord-ui");
  const uiPackage = path.join(uiDir, "package.json");
  if (!fs.existsSync(uiPackage)) {
    console.error(`[coord-ui] Missing ${path.relative(repoRoot, uiPackage)}.`);
    console.error("[coord-ui] This workspace does not include the bundled UI. Re-run create-concord or upgrade the Concord bundle.");
    process.exit(1);
  }

  const loopbackBind = isLoopbackBindHost(options.host);
  if (!loopbackBind && !options.allowRemoteBind) {
    console.error(`[coord-ui] non-loopback host "${options.host}" requires --allow-remote-bind.`);
    console.error("[coord-ui] coord-ui is local-only by default. Pass --allow-remote-bind only behind an operator-configured auth mode.");
    process.exit(1);
  }
  if (!loopbackBind) {
    console.warn(`[coord-ui] WARNING: binding ${options.host} exposes governance detail beyond this machine.`);
    console.warn("[coord-ui] Required auth mode: COORD_UI_AUTH_MODE=proxy-header (only behind a trusted reverse proxy that sets the role header),");
    console.warn("[coord-ui] or COORD_UI_AUTH_MODE=shared-token with COORD_UI_AUTH_TOKEN set. Without one of these every request is denied.");
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
    // COORD-940: the marker is what lets the edge middleware trust a loopback peer. Only a
    // loopback bind sets it; a remote bind overrides any inherited value.
    env: { ...process.env, COORD_DIR: coordDir, COORD_UI_BIND_SCOPE: loopbackBind ? "loopback" : "remote" },
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

module.exports = { main, waitForReady };
