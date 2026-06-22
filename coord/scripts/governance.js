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

if (require.main === module) {
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
