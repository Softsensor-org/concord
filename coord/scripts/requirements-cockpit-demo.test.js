"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DEMO_PATH = path.join(__dirname, "..", "product", "demo", "requirements-cockpit-demo.json");

test("requirements cockpit demo payload is source-cited and public-safe", () => {
  const demo = JSON.parse(fs.readFileSync(DEMO_PATH, "utf8"));
  assert.equal(demo.kind, "concord.requirements.cockpit_demo");
  assert.equal(demo.scenario.name, "Existing repo plus existing URS");
  assert.ok(demo.source.requirements);
  assert.ok(demo.source.ui_contract);
  assert.ok(demo.requirements_coverage.explicit_vs_inferred_visible);
  assert.ok(demo.persona_blockers.length > 0);
  assert.ok(demo.screen_coverage.explicit_links.length > 0);
  assert.ok(demo.donor_derived_provenance.public_cut_safe);
  assert.ok(demo.stale_impacts.length > 0);
  assert.ok(demo.ticket_evidence_closeout.length > 0);
  assert.ok(demo.copyable_commands.every((command) => command.startsWith("coord requirements")));

  const text = JSON.stringify(demo).toLowerCase();
  for (const marker of ["customer_name", "patient_name", "secret_key", "api_key", "password"]) {
    assert.equal(text.includes(marker), false, `demo contains private marker ${marker}`);
  }
});
