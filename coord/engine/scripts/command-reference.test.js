"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");

const coord = path.resolve(__dirname, "../..");
const { createCommandReference } = require(resolveEngineModule(coord, "scripts/command-reference.js"));
const { filterCommandMetadata, renderCommandReference } = createCommandReference();

const commands = [
  { name: "doctor", namespace: "product", maturity: "stable", role: "operator", safety: "read_only", summary: "Doctor", docs: "doctor.md", ui_palette: true, entrypoint: "coord" },
  { name: "inspect", namespace: "product", maturity: "alpha", role: "maintainer", safety: "read_only", summary: "Inspect", docs: "inspect.md", ui_palette: true, entrypoint: "coord" },
  { name: "admin", namespace: "governance", maturity: "existing_lifecycle", role: "admin", safety: "governance_mutation", summary: "Admin", docs: "admin.md", ui_palette: false, entrypoint: "coord/scripts/gov" },
  { name: "planned", namespace: "product", maturity: "planned_surface", role: "maintainer", safety: "read_only", summary: "Planned", docs: "planned.md", ui_palette: true, entrypoint: "coord/scripts/coord" },
  { name: "unknown-maturity", namespace: "product", maturity: "future_value", role: "operator", safety: "read_only", summary: "Unknown maturity", docs: "unknown.md", ui_palette: true, entrypoint: "coord/scripts/coord" },
  { name: "missing-maturity", namespace: "product", role: "operator", safety: "read_only", summary: "Missing maturity", docs: "missing.md", ui_palette: true, entrypoint: "coord/scripts/coord" },
];

test("command metadata defaults to stable operator entries and returns serializable copies", () => {
  const result = filterCommandMetadata(commands);
  assert.deepEqual(result.map((entry) => entry.name), ["doctor"]);
  assert.equal(result[0].advanced, false);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(Object.hasOwn(commands[0], "advanced"), false);
});

test("advanced and dimension filters are deterministic intersections", () => {
  assert.deepEqual(filterCommandMetadata(commands, { includeAdvanced: true }).map((entry) => entry.name), ["admin", "doctor", "inspect", "missing-maturity", "planned", "unknown-maturity"]);
  const advanced = filterCommandMetadata(commands, { includeAdvanced: true });
  assert.equal(advanced.find((entry) => entry.name === "unknown-maturity").advanced, true);
  assert.equal(advanced.find((entry) => entry.name === "missing-maturity").advanced, true);
  assert.deepEqual(filterCommandMetadata(commands, { includeAdvanced: true, namespace: "governance", safety: "governance_mutation" }).map((entry) => entry.name), ["admin"]);
  assert.deepEqual(filterCommandMetadata(commands, { includeAdvanced: true, role: "maintainer", maturity: "alpha" }).map((entry) => entry.name), ["inspect"]);
  assert.deepEqual(filterCommandMetadata(commands, { includeAdvanced: true, safety: "missing" }), []);
});

test("generated reference omits planned surfaces and only emits registered executable examples", () => {
  const markdown = renderCommandReference(commands.map((entry) => ({ ...entry, ...(entry.name === "doctor" ? { example: "bash coord/scripts/coord doctor --json" } : {}) })));
  assert.match(markdown, /## product:doctor/);
  assert.match(markdown, /Entry point: coord/);
  assert.match(markdown, /bash coord\/scripts\/coord doctor --json/);
  assert.match(markdown, /Entry point: coord\/scripts\/gov/);
  assert.doesNotMatch(markdown, /## product:planned|Planned surfaces/);
});

test("filter and renderer reject malformed input rather than silently inventing metadata", () => {
  assert.throws(() => filterCommandMetadata(null), /commands must be an array/);
  assert.throws(() => renderCommandReference(null), /Cannot read properties|filter/);
});
