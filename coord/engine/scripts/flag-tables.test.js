"use strict";

// COORD-984 (ARCH-AUDIT F-04): the CLI flag data tables have one definition each.
// The shared tables live in flag-tables.js. The effective cli.js and
// lifecycle-flags.js tables must still equal the pre-change golden snapshot, so
// every verb keeps accepting exactly the same flags with the same option keys.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "flag-tables-golden.json"), "utf8"));
const TABLE_NAMES = ["VALUE_FLAGS", "APPEND_FLAGS", "SCALAR_TEXT_FILE_FIELDS", "BOOL_FLAGS"];
const SHARED_EXPORT_NAMES = {
  VALUE_FLAGS: "SHARED_VALUE_FLAGS",
  APPEND_FLAGS: "SHARED_APPEND_FLAGS",
  SCALAR_TEXT_FILE_FIELDS: "SHARED_SCALAR_TEXT_FILE_FIELDS",
  BOOL_FLAGS: "SHARED_BOOL_FLAGS",
};
const LIFECYCLE_TABLE_HEADERS = {
  VALUE_FLAGS: "const LIFECYCLE_VALUE_FLAGS = Object.freeze({",
  APPEND_FLAGS: "const LIFECYCLE_APPEND_FLAGS = Object.freeze({",
  SCALAR_TEXT_FILE_FIELDS: "const LIFECYCLE_SCALAR_TEXT_FILE_FIELDS = Object.freeze({",
  BOOL_FLAGS: "const LIFECYCLE_BOOL_FLAGS = Object.freeze({",
};
const CLI_TABLE_HEADERS = {
  VALUE_FLAGS: "const VALUE_FLAGS = Object.freeze({",
  APPEND_FLAGS: "const APPEND_FLAGS = Object.freeze({",
  SCALAR_TEXT_FILE_FIELDS: "const SCALAR_TEXT_FILE_FIELDS = Object.freeze({",
  BOOL_FLAGS: "const BOOL_FLAGS = Object.freeze({",
};

const plain = (value) => JSON.parse(JSON.stringify(value));

// The flags both consumers define identically (same table, same option key).
function expectedShared(name) {
  return Object.fromEntries(
    Object.entries(GOLDEN.cli[name]).filter(([flag, key]) => GOLDEN.lifecycle[name][flag] === key),
  );
}

// Flag keys written as literals inside one data-table body of a source file.
function literalFlagKeys(sourceText, header) {
  const start = sourceText.indexOf(header);
  if (start < 0) return null;
  const end = sourceText.indexOf("\n});", start);
  assert.ok(end > start, `${header} has no recognizable end`);
  const body = sourceText.slice(start + header.length, end).replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"(-{1,2}[a-z0-9-]+)"\s*:/g)].map((match) => match[1]);
}

test("COORD-984 table-equivalence: cli.js effective flag tables equal the pre-change golden snapshot", () => {
  const cli = require("./cli.js");
  const effective = cli.__testing.FLAG_TABLES;
  assert.ok(effective, "cli.js must expose its effective flag tables to the table-equivalence test");
  for (const name of TABLE_NAMES) {
    assert.deepEqual(plain(effective[name]), GOLDEN.cli[name], `cli.js ${name} drifted from the pre-change table`);
  }
  assert.deepEqual(effective.SPECIAL_KEYS, GOLDEN.cli.SPECIAL_KEYS, "cli.js SPECIAL_FLAGS keys drifted");
});

test("COORD-984 table-equivalence: lifecycle-flags effective flag tables equal the pre-change golden snapshot", () => {
  const createLifecycleFlags = require("./lifecycle-flags.js");
  const effective = createLifecycleFlags({}).flagTables;
  assert.ok(effective, "lifecycle-flags.js must expose its effective flag tables to the table-equivalence test");
  for (const name of TABLE_NAMES) {
    assert.deepEqual(plain(effective[name]), GOLDEN.lifecycle[name], `lifecycle ${name} drifted from the pre-change table`);
  }
  assert.deepEqual(effective.SPECIAL_KEYS, GOLDEN.lifecycle.SPECIAL_KEYS, "lifecycle SPECIAL keys drifted");
});

test("COORD-984: flag-tables.js exports each shared table, frozen, holding exactly the flags both consumers define identically", () => {
  const shared = require("./flag-tables.js");
  for (const name of TABLE_NAMES) {
    const table = shared[SHARED_EXPORT_NAMES[name]];
    assert.ok(table && Object.isFrozen(table), `${SHARED_EXPORT_NAMES[name]} must be an exported frozen table`);
    assert.deepEqual(plain(table), expectedShared(name), `${SHARED_EXPORT_NAMES[name]} is not the identical cli/lifecycle intersection`);
  }
});

test("COORD-984: each shared flag has exactly one data definition, in flag-tables.js", () => {
  const cliText = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");
  const lifecycleText = fs.readFileSync(path.join(__dirname, "lifecycle-flags.js"), "utf8");
  const sharedKeys = new Set(TABLE_NAMES.flatMap((name) => Object.keys(expectedShared(name))));
  assert.ok(sharedKeys.size > 0);
  const repeated = [];
  for (const [label, text, headers] of [
    ["cli.js", cliText, CLI_TABLE_HEADERS],
    ["lifecycle-flags.js", lifecycleText, LIFECYCLE_TABLE_HEADERS],
  ]) {
    for (const name of TABLE_NAMES) {
      for (const flag of literalFlagKeys(text, headers[name]) || []) {
        if (sharedKeys.has(flag)) repeated.push(`${label} ${name} ${flag}`);
      }
    }
  }
  assert.deepEqual(repeated, [], `shared flags must not be redefined in a consumer table: ${repeated.join(", ")}`);
});
