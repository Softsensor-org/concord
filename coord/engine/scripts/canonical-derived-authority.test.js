"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const authority = require("./canonical-derived-authority.js");

test("classifies canonical, compatibility, derived, and ephemeral coord paths", () => {
  assert.equal(authority.classifyCoordPath("coord/board/tasks.json").authority, "authority");
  assert.equal(authority.classifyCoordPath("coord/.runtime/plans/COORD-379.json").authority, "authority");
  assert.equal(authority.classifyCoordPath("coord/PLAN.md").authority, "compatibility_view");
  assert.equal(authority.classifyCoordPath("coord/rendered/TASKS.md").authority, "derived_rebuildable_view");
  assert.equal(authority.classifyCoordPath("coord/evidence/live-mcp/receipt.json").authority, "ephemeral_evidence");
});

test("COORD-678 authority classifier covers every registered authority family and unknown paths", () => {
  const cases = [
    ["", "unknown"],
    ["coord/board/tasks.json", "authority"],
    ["coord/.runtime/plans/COORD-717.json", "authority"],
    ["coord/.runtime/governance-events.ndjson", "authority"],
    ["coord/attestations/run.json", "authority"],
    ["coord/.runtime/snapshots/head.json", "authority"],
    ["coord/PLAN.md", "compatibility_view"],
    ["coord/rendered/TASKS.md", "derived_rebuildable_view"],
    ["coord/product/context-packs/COORD-717.json", "derived_rebuildable_view"],
    ["coord/.runtime/context-packs/COORD-717.md", "derived_rebuildable_view"],
    ["coord/memory/index.json", "generated_index"],
    ["coord/evidence/live-mcp/receipt.json", "ephemeral_evidence"],
    ["coord/.runtime/evidence/test/receipt.json", "ephemeral_evidence"],
    ["coord/gates/policy.json", "authority"],
    ["coord/product/ARCHITECTURE.md", "authority"],
    ["coord/docs/guide.md", "authority"],
    ["coord/.runtime/plans/not-a-ticket.json", "unknown"],
    ["outside/file.json", "unknown"],
  ];
  for (const [file, expected] of cases) {
    assert.equal(authority.classifyCoordPath(file).authority, expected, file || "empty path");
  }
});

test("COORD-678 public authority-check CLI reports both failures and clean JSON", () => {
  const script = path.join(__dirname, "canonical-derived-authority.js");
  let output;
  assert.throws(() => {
    execFileSync(process.execPath, [script, "--canonical-input", "coord/rendered/TASKS.md"], { encoding: "utf8" });
  }, (error) => {
    output = error.stdout;
    return error.status === 1;
  });
  assert.match(output, /derived_used_as_canonical/);
  output = execFileSync(process.execPath, [script, "--json", "coord/board/tasks.json"], { encoding: "utf8" });
  assert.match(output, /"ok": true/);
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

test("COORD-818 authority-check parser and reporter cover malformed and each advertised input form", () => {
  const parsed = authority.parseArgs([
    "--canonical-input", "coord/board/tasks.json",
    "--committed-artifact", "coord/evidence/deploy/receipt.json",
    "--operation", JSON.stringify({ kind: "sync", source: "coord/PLAN.md", target: "coord/.runtime/plans/COORD-1.json" }),
    "coord/rendered/TASKS.md", "--json",
  ]);
  assert.equal(parsed.options.canonicalInputs.length, 2);
  assert.equal(parsed.options.committedArtifacts.length, 1);
  assert.equal(parsed.options.operations.length, 1);
  assert.equal(parsed.options.json, true);

  const malformedOutput = [];
  const malformed = authority.run(["--operation", "{"], { log: (line) => malformedOutput.push(line) });
  assert.equal(malformed.code, 1);
  assert.match(malformedOutput.join(""), /--operation expects JSON/);

  const unexpectedOutput = [];
  assert.equal(authority.run(["--unknown"], { log: (line) => unexpectedOutput.push(line) }).code, 1);
  assert.match(unexpectedOutput.join(""), /Unexpected argument: --unknown/);

  const cleanOutput = [];
  assert.equal(authority.run([], { log: (line) => cleanOutput.push(line) }).code, 0);
  assert.match(cleanOutput.join(""), /authority-check ok/);

  const jsonOutput = [];
  assert.equal(authority.run(["--json", "coord/rendered/TASKS.md"], { log: (line) => jsonOutput.push(line) }).code, 1);
  assert.match(jsonOutput.join(""), /"derived_used_as_canonical"/);

  const issueOutput = [];
  assert.equal(authority.run(["coord/rendered/TASKS.md"], { log: (line) => issueOutput.push(line) }).code, 1);
  assert.match(issueOutput.join(""), /\[error\] derived_used_as_canonical/);
});
