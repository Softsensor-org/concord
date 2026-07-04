"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cockpit = require("./requirements-cockpit-model.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("buildCockpitModel defines read-only requirements protocol views and copyable commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-cockpit-"));
  fs.mkdirSync(path.join(dir, "coord/product"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/product/demo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/product/REQUIREMENTS.md"), "# Requirements\n");
  fs.writeFileSync(path.join(dir, "coord/product/demo/requirements-cockpit-demo.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), "{}\n");

  const model = cockpit.buildCockpitModel({ cwd: dir, dir: "." });
  assert.equal(model.kind, "concord.requirements.cockpit_model");
  assert.equal(model.read_only_policy.web_tier_may_write, false);
  assert.ok(model.views.length >= 10);
  assert.ok(model.views.every((view) => view.read_only && view.command_mode === "copyable_text_only" && view.mutation_allowed === false));
  assert.ok(model.views.some((view) => view.id === "sequencing"));
  assert.ok(model.views.some((view) => view.id === "controlled_documents"));
  assert.ok(model.views.some((view) => view.id === "surface_conformance"));
  assert.ok(model.views.find((view) => view.id === "requirements_sources").available);
  assert.equal(model.demo_data.exists, true);
  assert.equal(model.demo_data.canonical_source, false);
});

test("requirements-cockpit-model writes only explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-cockpit-output-"));
  const output = "coord/.runtime/requirements/cockpit-model.json";
  const result = cockpit.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.kind, "concord.requirements.cockpit_model");
  assert.equal(written.summary.views, cockpit.VIEW_DEFS.length);
});

test("product CLI routes requirements-cockpit-model", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-cockpit-model"].run, "function");

  const cap = capture();
  const result = dispatch(["requirements-cockpit-model", "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.cockpit_model");
  assert.equal(parsed.read_only_policy.commands_are, "copyable_text_only");
  assert.equal(parsed.demo_data.path, "coord/product/demo/requirements-cockpit-demo.json");
});
