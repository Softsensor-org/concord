"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenizeNodeOptions, quoteNodeOption, withoutInheritedIsolationGuardOptions } = require("./test-node-options.js");

test("COORD-1050: inherited isolation guard require and coverage options are removed without losing unrelated options", () => {
  const options = [
    "--max-old-space-size=512",
    '--require "/old checkout/coord/engine/scripts/test-isolation-guard.js"',
    "-r=/another/coord/engine/scripts/test-isolation-guard.js",
    "-r/third/coord/engine/scripts/test-isolation-guard.js",
    '--test-coverage-exclude="/old checkout/coord/engine/scripts/test-isolation-guard.js"',
    "--test-coverage-exclude=/another/coord/engine/scripts/test-isolation-guard.js",
    '--require "/custom preload.js"',
    "--test-coverage-exclude=/custom/coverage-helper.js",
  ].join(" ");
  assert.equal(withoutInheritedIsolationGuardOptions(options), [
    "--max-old-space-size=512", '--require "/custom preload.js"', "--test-coverage-exclude=/custom/coverage-helper.js",
  ].join(" "));
});

test("COORD-1050: Node option tokenization handles quoted spaces and equals forms", () => {
  assert.deepEqual(tokenizeNodeOptions('--require="/path with spaces/preload.js" -r=/other/preload.js --trace-warnings'), [
    { raw: '--require="/path with spaces/preload.js"', value: "--require=/path with spaces/preload.js" },
    { raw: "-r=/other/preload.js", value: "-r=/other/preload.js" },
    { raw: "--trace-warnings", value: "--trace-warnings" },
  ]);
  assert.equal(quoteNodeOption("/path with spaces/preload.js"), '"/path with spaces/preload.js"');
});

test("COORD-1050: Node option tokenization preserves escaped and single-quoted characters", () => {
  const escapedDoubleQuote = String.raw`--title "double\"quote"`;
  assert.deepEqual(tokenizeNodeOptions("--title escaped\\ value --title 'single\\ value' " + escapedDoubleQuote), [
    { raw: "--title", value: "--title" },
    { raw: "escaped\\ value", value: "escaped value" },
    { raw: "--title", value: "--title" },
    { raw: "'single\\ value'", value: "single\\ value" },
    { raw: "--title", value: "--title" },
    { raw: String.raw`"double\"quote"`, value: 'double"quote' },
  ]);
  assert.deepEqual(tokenizeNodeOptions("--title trailing\\"), [
    { raw: "--title", value: "--title" },
    { raw: "trailing\\", value: "trailing\\" },
  ]);
  assert.deepEqual(tokenizeNodeOptions(""), []);
});

test("COORD-1050: inherited guard filtering handles separated and equals option forms", () => {
  const options = [
    "-r", '"/old checkout/test-isolation-guard.js"',
    "--require=/another/test-isolation-guard.js",
    "-r/third/test-isolation-guard.js",
    "--test-coverage-exclude", '"/old checkout/test-isolation-guard.js"',
    "--test-coverage-exclude=/another/test-isolation-guard.js",
    "--require=/custom/preload.js",
    "-r/custom/preload-2.js",
    "--test-coverage-exclude=/custom/coverage-helper.js",
  ].join(" ");
  assert.equal(withoutInheritedIsolationGuardOptions(options), [
    "--require=/custom/preload.js", "-r/custom/preload-2.js",
    "--test-coverage-exclude=/custom/coverage-helper.js",
  ].join(" "));
  assert.equal(quoteNodeOption("/path/without-spaces.js"), "/path/without-spaces.js");
});
