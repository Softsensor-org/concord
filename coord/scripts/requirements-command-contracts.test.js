"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const contracts = require("./requirements-command-contracts.js");
const { buildRegistry } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("contractReport defines the required protocol verbs and mutation boundary", () => {
  const report = contracts.contractReport();
  assert.equal(report.kind, "concord.requirements.command_contracts");
  assert.deepEqual(report.commands.map((command) => command.verb), [
    "baseline",
    "import",
    "lint",
    "linkage-backfill",
    "trace",
    "conformance",
    "workflow-audit",
    "workflow-align",
    "review-pack",
    "sequence",
    "donor-analyze",
    "donor-derive",
  ]);
  assert.match(report.mutation_escalation, /governed ticket/);
  for (const command of report.commands) {
    assert.ok(["read_only", "dry_run"].includes(command.default_mode));
    assert.ok(command.mutation_path);
  }
});

test("run emits deterministic json contracts", () => {
  const cap = capture();
  const result = contracts.run(["--contracts", "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const report = JSON.parse(cap.text());
  assert.equal(report.commands.length, 12);
  assert.equal(report.commands.find((command) => command.verb === "baseline").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "linkage-backfill").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "conformance").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "sequence").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "review-pack").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "donor-derive").status, "implemented");
  assert.equal(report.commands.find((command) => command.verb === "workflow-align").status, "implemented");
});

test("sequence routes to dry-run planner without mutation", () => {
  const cap = capture();
  const result = contracts.run(["sequence", "--json"], { log: cap.log });
  assert.equal(result.code, 1);
  assert.match(cap.text(), /--registry is required/);
});

test("unknown verbs fail with known verb guidance", () => {
  const cap = capture();
  const result = contracts.run(["mutate-board"], { log: cap.log });
  assert.equal(result.code, 1);
  assert.match(cap.text(), /unknown verb 'mutate-board'/);
  assert.match(cap.text(), /donor-analyze/);
});

test("coord CLI registers requirements umbrella command", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry.requirements);
  assert.equal(typeof registry.requirements.run, "function");
});
