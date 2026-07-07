"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPublishabilityReport,
  classifyPublishability,
  renderPublishability,
  splitFileArgs,
} = require("./publishability-check.js");

test("publishability check requires release hygiene for canonical docs and release surfaces", () => {
  const report = buildPublishabilityReport({
    ticketId: "COORD-445",
    files: ["coord/product/TESTING_AND_GATES.md", "release/build-public-release.sh"],
  });
  assert.equal(report.needs_publishability, true);
  assert.ok(report.commands.includes("release/verify-dual-release.sh"));
  assert.match(renderPublishability(report), /Publishability Check/);
});

test("publishability check does not tax unrelated implementation files", () => {
  const result = classifyPublishability(["backend/src/app.js"]);
  assert.equal(result.needs_publishability, false);
  assert.equal(result.commands[0], "No publishability gate required from declared files.");
});

test("publishability check splits comma-separated file args", () => {
  assert.deepEqual(splitFileArgs(["README.md, coord/scripts/gov", "release/build-public-release.sh"]), [
    "README.md",
    "coord/scripts/gov",
    "release/build-public-release.sh",
  ]);
});
