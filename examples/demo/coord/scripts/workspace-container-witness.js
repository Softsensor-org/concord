"use strict";
process.stderr.write("DEPRECATED: coord/scripts/workspace-container-witness.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/workspace-container-witness.js instead.\n");
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

module.exports = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/workspace-container-witness.js"));
