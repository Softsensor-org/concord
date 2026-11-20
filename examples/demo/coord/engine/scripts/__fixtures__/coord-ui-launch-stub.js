"use strict";

// COORD-864: `node --require` preload that stands in for the processes, files
// and network coord-ui-launch.js touches, so its main can run end to end in a
// test without npm, Next.js or a browser. The scenario arrives as JSON in
// COORD_UI_LAUNCH_STUB; every intercepted call is logged as a "STUB ..." line.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");

const scenario = JSON.parse(process.env.COORD_UI_LAUNCH_STUB || "{}");
const log = (...parts) => process.stdout.write(`STUB ${parts.join(" ")}\n`);

if (scenario.platform) Object.defineProperty(process, "platform", { value: scenario.platform });

const realExists = fs.existsSync;
const existsRules = [
  ["frontend/apps/coord-ui/package.json", "ui"],
  ["node_modules/next/package.json", "next"],
  ["/mnt/c/Windows/System32/cmd.exe", "winCmd"],
  ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "powerShell"],
];
fs.existsSync = (candidate) => {
  const rule = existsRules.find(([suffix]) => String(candidate).endsWith(suffix));
  return rule ? Boolean((scenario.exists || {})[rule[1]]) : realExists(candidate);
};

childProcess.spawnSync = (command, args) => {
  log("spawnSync", command, ...args);
  const result = (scenario.spawnSync || {})[command] || { status: 1 };
  return result.error ? { error: new Error(result.error), status: null } : { status: result.status };
};

childProcess.spawn = (command, args, options) => {
  log("spawn", command, ...args, `COORD_DIR=${options.env.COORD_DIR ? "set" : "unset"}`, `BIND_SCOPE=${options.env.COORD_UI_BIND_SCOPE || "unset"}`);
  const child = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => {
    log("child.kill", signal);
    child.killed = true;
  };
  const behaviour = scenario.child || {};
  setTimeout(() => {
    if (behaviour.signals) {
      process.emit("SIGINT");
      process.emit("SIGTERM");
    }
    if (behaviour.error) child.emit("error", new Error(behaviour.error));
    else child.emit("exit", behaviour.code === undefined ? null : behaviour.code, behaviour.signal || null);
  }, 100);
  return child;
};

http.get = (url, onResponse) => {
  log("http.get", url);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => {};
  setImmediate(() => {
    if (scenario.http === "error") {
      // Jump past the readiness deadline so the retry rejects at once.
      const now = performance.now.bind(performance);
      let offset = 0;
      performance.now = () => now() + (offset += 61000);
      req.emit("error", new Error("refused"));
    } else onResponse({ statusCode: 200, resume() {} });
  });
  return req;
};

process.kill = (pid, signal) => {
  log("process.kill", signal);
  process.exit(99);
};
