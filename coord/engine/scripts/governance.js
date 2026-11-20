#!/usr/bin/env node
"use strict";

// Compatibility marker for existing precheck probes: function precheck now
// lives in token-economics.js and is reached through cli.js.

const cli = require("./cli.js");

module.exports = {
  GovernanceError: cli.GovernanceError,
  executeCommand: cli.executeCommand,
  __testing: cli.__testing,
};

function main() {
  try {
    cli.main();
  } catch (error) {
    if (error instanceof cli.GovernanceError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
if (require.main === module) main();
// COORD-873: the CLI shim at the legacy coord/scripts path re-dispatches this entry
// (same argv, same exit codes, same error handling).
module.exports.main = main;
