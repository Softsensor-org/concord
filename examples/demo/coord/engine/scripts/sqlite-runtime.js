"use strict";

// The declared minimum is Node 22.8. SQLite was unflagged in 22.13 and 23.4.
// https://nodejs.org/download/release/v25.9.0/docs/api/cli.html#--no-experimental-sqlite
function sqliteNeedsFlag(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return (major === 22 && minor >= 8 && minor < 13) || (major === 23 && minor < 4);
}

function sqliteTestNodeOptions(options = "", version = process.versions.node) {
  if (!sqliteNeedsFlag(version)) return options;
  const flag = "--experimental-sqlite";
  if (options === flag || options.startsWith(`${flag} `)) return options;
  // Prepend, preserving the caller's entire suffix. Node itself interprets a
  // later explicit disable; do not parse or silently override caller options.
  return options ? `${flag} ${options}` : flag;
}

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch (error) {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    const failure = new Error(
      `SQLite is unavailable in Node ${process.version}. Concord requires Node >=22.8 with built-in SQLite. ` +
      "On Node 22.8-22.12 or 23.0-23.3, launch with node --experimental-sqlite <command> " +
      "or NODE_OPTIONS=--experimental-sqlite. On newer versions, check for an explicit " +
      "--no-experimental-sqlite option or a runtime built without SQLite.",
      { cause: error }
    );
    failure.code = "CONCORD_SQLITE_UNAVAILABLE";
    throw failure;
  }
}

module.exports = { sqliteNeedsFlag, sqliteTestNodeOptions, loadSqlite };
