"use strict";

// COORD-871 (COORD-589 batch 8): permanent compatibility shim (a stable adopter
// entrypoint in coord/engine/shim-registry.json stable_entrypoints). The module
// lives at coord/engine/scripts/governance-mcp.js.
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

const engine = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/governance-mcp.js"));
if (require.main === module) engine.main();
module.exports = engine;
