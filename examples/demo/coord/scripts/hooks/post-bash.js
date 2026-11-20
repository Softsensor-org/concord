"use strict";
const path = require("node:path");
let engine;
try {
  engine = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "engine-only:scripts/hooks/post-bash.js"));
} catch (error) {
  if (require.main !== module) throw error;
  process.stderr.write(`BLOCKED (fail-closed): coord/scripts/hooks/post-bash.js cannot load its engine module: ${(error && error.message) || error} OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent harness, restore the engine copy under coord/engine/scripts/hooks, restart the session, or land the change through governance (gov land / gov finalize) from that terminal.\n`);
  process.exit(2);
}
if (require.main === module) engine.main();
module.exports = engine;
