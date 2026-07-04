"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const authority = require("./canonical-derived-authority.js");

test("classifies canonical, compatibility, derived, and ephemeral coord paths", () => {
  assert.equal(authority.classifyCoordPath("coord/board/tasks.json").authority, "authority");
  assert.equal(authority.classifyCoordPath("coord/.runtime/plans/COORD-379.json").authority, "authority");
  assert.equal(authority.classifyCoordPath("coord/PLAN.md").authority, "compatibility_view");
  assert.equal(authority.classifyCoordPath("coord/rendered/TASKS.md").authority, "derived_rebuildable_view");
  assert.equal(authority.classifyCoordPath("coord/evidence/live-mcp/receipt.json").authority, "ephemeral_evidence");
});

test("detects derived views used as canonical inputs", () => {
  const result = authority.checkAuthorityInversions({
    canonicalInputs: ["coord/rendered/TASKS.md", "coord/PLAN.md"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "derived_used_as_canonical",
    "derived_used_as_canonical",
  ]);
});

test("detects markdown compatibility overwriting canonical plan records", () => {
  const result = authority.checkAuthorityInversions({
    operations: [{
      kind: "sync",
      source: "coord/PLAN.md",
      target: "coord/.runtime/plans/COORD-379.json",
    }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "compat_overwrites_authority");
});

test("allows explicit repair from compatibility view to authority", () => {
  const result = authority.checkAuthorityInversions({
    operations: [{
      kind: "explicit_repair",
      source: "coord/PLAN.md",
      target: "coord/.runtime/plans/COORD-379.json",
    }],
  });
  assert.equal(result.ok, true);
});

test("warns for committed ephemeral evidence", () => {
  const result = authority.checkAuthorityInversions({
    committedArtifacts: ["coord/evidence/deploy/receipt.json"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues[0].severity, "warning");
});
