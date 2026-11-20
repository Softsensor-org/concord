"use strict";
const path = require("node:path");
const fs = require("node:fs");
let engine;
try {
  engine = require(require("../paths.js").resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/runtime-authority-hook.js"));
} catch (error) {
  if (require.main !== module) throw error;
  process.stderr.write(`BLOCKED (fail-closed): coord/scripts/runtime-authority-hook.js cannot load its engine module: ${(error && error.message) || error} OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts and restart the session; or, if no governed work is in flight, release the active lock through the governance CLI.\n`);
// COORD-971: engine-free copy of the barrier's locksActiveWithoutEngine(). Coord dir: the
// canonical one for a worktree copy, else this shim's own coord dir.
function lockDirectory() {
  const marker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;
  const index = __dirname.indexOf(marker);
  const coord = index >= 0 ? __dirname.slice(0, index + `${path.sep}coord`.length) : path.resolve(__dirname, "..");
  return path.join(coord, ".runtime", "locks");
}
function governedWorkInFlight() {
  const dir = lockDirectory();
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) { return !(error && error.code === "ENOENT"); }
  return names.filter((name) => name.endsWith(".lock")).some((name) => {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return Boolean(lock) && lock.status === "doing";
    } catch { return true; }
  });
}
  process.exit(governedWorkInFlight() ? 2 : 0);
}
if (require.main === module) engine.main();
module.exports = engine;
