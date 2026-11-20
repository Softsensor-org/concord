"use strict";
process.stderr.write("DEPRECATED: coord/scripts/concurrent-burnin-worker.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/concurrent-burnin-worker.js instead.\n");
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

const engine = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/concurrent-burnin-worker.js"));
if (require.main === module) engine.main();
module.exports = engine;
