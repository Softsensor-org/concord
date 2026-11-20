"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeUnionFind, sequencerGroupId, gateModeForReasons } = require("./sequencer-grouping.js");

test("COORD-749: transitive overlap groups preserve disjoint components and idempotence", () => {
  const groups = makeUnionFind(["A", "B", "C", "D"]);
  groups.union("A", "B");
  groups.union("B", "C");
  groups.union("C", "A");
  assert.equal(groups.find("A"), groups.find("C"));
  assert.equal(groups.find("B"), groups.find("C"));
  assert.notEqual(groups.find("A"), groups.find("D"));
});

test("COORD-749: sequencer group IDs retain the established digest format", () => {
  const a = { ticket: "A", files: ["one.js"], reasons: [{ code: "overlap" }] };
  const b = { ticket: "B", files: ["two.js"], reasons: [] };
  const expected = "sha256:" + crypto.createHash("sha256").update("A:one.js:overlap|B:two.js:").digest("hex").slice(0, 16);
  assert.equal(sequencerGroupId([b, a]), expected);
  assert.equal(sequencerGroupId([a, b]), expected);
  assert.notEqual(sequencerGroupId([{ ...a, files: ["changed.js"] }, b]), expected);
  assert.equal(gateModeForReasons([]), "slice");
  assert.equal(gateModeForReasons([{ gate_mode: "slice" }, { gate_mode: "full" }]), "full");
});
