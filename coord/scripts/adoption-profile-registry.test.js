"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createRegistry = require("./adoption-profile-registry.js");
const {
  REQUIRED_PROFILE_FIELDS,
  loadCatalog,
  validateCatalog,
} = createRegistry;
const createTrackRegistry = require("./track-registry.js");

test("adoption profile catalog is valid and exposes required profiles", () => {
  const catalog = loadCatalog();
  const errors = validateCatalog(catalog);
  assert.deepEqual(errors, []);
  const registry = createRegistry();
  for (const id of [
    "solo-dev",
    "small-team",
    "product-engineering",
    "regulated",
    "enterprise",
    "production-mcp",
    "server-bootstrap",
  ]) {
    const profile = registry.getProfile(id);
    assert.equal(profile.id, id);
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in profile, `${id} missing ${field}`);
    }
  }
});

test("resolveProfile falls back to the default profile", () => {
  const registry = createRegistry({
    catalog: {
      schema_version: 1,
      default_profile: "solo-dev",
      profiles: {
        "solo-dev": {
          label: "Solo",
          intent: "x",
          default_lane: "default",
          recommended_tracks: ["development"],
          required_ticket_fields: [],
          required_evidence: [],
          closeout_expectations: [],
          allowed_adapter_classes: [],
          ui_labels: [],
        },
      },
    },
  });
  assert.equal(registry.resolveProfile("missing").id, "solo-dev");
});

test("validateCatalog reports missing required fields and invalid lanes", () => {
  const errors = validateCatalog({
    schema_version: 1,
    default_profile: "bad",
    profiles: {
      bad: {
        label: "Bad",
        intent: "bad",
        default_lane: "unsafe",
        recommended_tracks: "development",
      },
    },
  });
  assert.ok(errors.some((e) => /bad.default_lane/.test(e)));
  assert.ok(errors.some((e) => /bad.recommended_tracks must be an array/.test(e)));
  assert.ok(errors.some((e) => /bad missing required_evidence/.test(e)));
});

test("profiles stay separate from work-type tracks", () => {
  const profiles = createRegistry();
  const tracks = createTrackRegistry({ projectConfig: {} });
  assert.ok(profiles.getProfile("regulated"));
  assert.equal(tracks.trackByName("regulated"), null);
  assert.ok(tracks.trackByName("development"));
  assert.equal(profiles.getProfile("development"), null);
});
