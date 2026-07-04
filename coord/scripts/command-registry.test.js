"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const commandRegistry = require("./command-registry.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("product metadata includes current stable coord commands", () => {
  const names = commandRegistry.PRODUCT_COMMANDS.map((command) => command.name);
  for (const name of ["init", "conformance", "upgrade"]) {
    assert.ok(names.includes(name), `${name} should be registered`);
  }
});

test("product CLI registry and command metadata do not drift", () => {
  const runtime = buildRegistry({ log: () => {} });
  const metadata = commandRegistry.productCommandMetadataByName();
  assert.deepEqual(Object.keys(runtime).sort(), Array.from(metadata.keys()).sort());
  for (const [name, entry] of Object.entries(runtime)) {
    assert.equal(entry.summary, metadata.get(name).summary, `summary drift for ${name}`);
  }
});

test("coord help is backed by command metadata summaries", () => {
  const cap = capture();
  const result = dispatch(["help"], { log: cap.log });
  assert.equal(result.code, 0);
  assert.match(cap.text(), new RegExp(commandRegistry.productSummary("init").replace(/[()]/g, "\\$&")));
  assert.match(cap.text(), /requirements-walking-skeleton/);
});

test("commands command emits machine-readable registry and governance metadata", () => {
  const cap = capture();
  const result = commandRegistry.run(["--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const report = JSON.parse(cap.text());
  assert.equal(report.kind, "concord.command_registry");
  assert.ok(report.commands.some((command) => command.namespace === "governance" && command.name === "start"));
  assert.ok(report.commands.every((command) => command.summary && command.safety && command.maturity));
});

test("adoption governance helper commands have registry-level dispatch", () => {
  assert.deepEqual(
    commandRegistry.ADOPTION_GOVERNANCE_COMMAND_NAMES,
    ["guided-closeout", "governance-tier", "publishability-check"]
  );
  assert.equal(typeof commandRegistry.runAdoptionGovernanceCommand, "function");
});

test("coord commands is routed through the product CLI", () => {
  const cap = capture();
  const result = dispatch(["commands", "--product-only", "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const report = JSON.parse(cap.text());
  assert.ok(report.commands.every((command) => command.namespace === "product"));
});
