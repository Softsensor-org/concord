"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getTrackPreset,
  listTrackPresets,
  renderTrackPresets,
  suggestPresetFromSignals,
} = require("./track-presets.js");

test("track presets expose common project shapes", () => {
  const ids = listTrackPresets().map((preset) => preset.id);
  assert.deepEqual(ids.sort(), ["content-site", "data-service", "infra", "web-app"].sort());
  assert.equal(getTrackPreset("web-app").tracks.includes("development"), true);
  assert.match(renderTrackPresets(), /Track Presets/);
});

test("track presets can be inferred from repo signals", () => {
  assert.equal(suggestPresetFromSignals(["deployment-infra"]).id, "infra");
  assert.equal(suggestPresetFromSignals(["node"]).id, "web-app");
});
