"use strict";
process.stderr.write("DEPRECATED: coord/scripts/requirements-walking-skeleton.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/requirements-walking-skeleton.js instead.\n");
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

const engine = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/requirements-walking-skeleton.js"));
if (require.main === module) engine.main();
module.exports = engine;
