#!/usr/bin/env node
"use strict";

// COORD-867 (COORD-589 batch 4): compatibility shim registered in
// coord/engine/shim-registry.json. The module lives at coord/engine/scripts/quality-propose-cron.js.
// COORD-879: a PERMANENT stable entrypoint (human-admin approval 2026-11-03).
// Adopter crontabs run this legacy path, and an engine upgrade cannot rewrite
// an adopter crontab, so this shim is never removable.
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

const engine = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:scripts/quality-propose-cron.js"));
if (require.main === module) engine.main();
module.exports = engine;
