'use strict';
// COORD-904: opt-in cost probe. Preloaded with --require only under
// test-runner --profile-costs. It appends one JSON line per child process a test
// spawns (wall ms, command) to COORD_TEST_COST_LOG. It never changes a result:
// the original child_process function is always called and its return value kept.
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

const logPath = process.env.COORD_TEST_COST_LOG;
if (logPath) {
  const record = (command, args, ms, status) => {
    const line = JSON.stringify({
      cmd: String(command),
      args: args.slice(0, 3).map(String),
      ms: Number(ms.toFixed(3)),
      status: status == null ? null : status,
    });
    try { fs.appendFileSync(logPath, line + '\n'); } catch { /* profiling must never fail a test */ }
  };
  const firstArgs = (rest) => (Array.isArray(rest[0]) ? rest[0] : []);
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function spawnSyncProfiled(command, ...rest) {
    const started = performance.now();
    const result = originalSpawnSync.call(this, command, ...rest);
    record(command, firstArgs(rest), performance.now() - started, result && result.status);
    return result;
  };
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function execFileSyncProfiled(command, ...rest) {
    const started = performance.now();
    try {
      return originalExecFileSync.call(this, command, ...rest);
    } finally {
      record(command, firstArgs(rest), performance.now() - started, null);
    }
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function spawnProfiled(command, ...rest) {
    const started = performance.now();
    const child = originalSpawn.call(this, command, ...rest);
    if (child && typeof child.once === 'function') {
      child.once('close', (status) => record(command, firstArgs(rest), performance.now() - started, status));
    }
    return child;
  };
}
