"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { executeCommand } = require("./cli.js");
const lifecycle = require("./lifecycle.js");

test("gov dispatch exposes adoption-friction helper commands", () => {
  const tier = executeCommand(["governance-tier", "--json"]);
  assert.equal(tier.ok, true, tier.error || tier.stderr);
  assert.match(tier.stdout, /concord\.governance_tier/);

  const publish = executeCommand(["publishability-check", "COORD-445", "--json", "--files", "coord/product/TESTING_AND_GATES.md"]);
  assert.equal(publish.ok, true, publish.error || publish.stderr);
  assert.match(publish.stdout, /concord\.publishability_check/);
});

test("adoption helper commands are not lifecycle composition-root exports", () => {
  assert.equal(Object.hasOwn(lifecycle.commands, "guidedCloseoutCommand"), false);
  assert.equal(Object.hasOwn(lifecycle.commands, "governanceTierCommand"), false);
  assert.equal(Object.hasOwn(lifecycle.commands, "publishabilityCheckCommand"), false);
});
