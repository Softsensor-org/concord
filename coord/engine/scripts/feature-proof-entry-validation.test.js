"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createFeatureProofEntryValidator } = require("./feature-proof-entry-validation.js");

class FixtureValidationError extends Error {}

function validator() {
  return createFeatureProofEntryValidator({
    fail(message) {
      throw new FixtureValidationError(message);
    },
  }).validateFeatureProofEntry;
}

test("feature proof syntax accepts each supported ticket-repository kind", () => {
  const validate = validator();
  for (const entry of [
    "path:README.md",
    "path:src/feature.ts",
    "symbol:src/feature.ts#Feature",
    "text:public action label",
    "route:/workspace/feature",
  ]) {
    assert.doesNotThrow(() => validate(entry), entry);
  }
});

test("feature proof syntax rejects unsupported prefixes and malformed supported kinds", () => {
  const validate = validator();
  for (const entry of [
    "",
    "path:src/feature.ts#symbol",
    "symbol:src/feature.ts",
    "symbol:#Feature",
    "coord:path:README.md",
    "coord:symbol:README.md#Concord",
    "unknown:path:README.md",
    "other:README.md",
  ]) {
    assert.throws(
      () => validate(entry),
      (error) => error instanceof FixtureValidationError,
      entry,
    );
  }
  assert.throws(
    () => validate("coord:path:README.md"),
    /Cross-repository proof prefixes are unsupported/,
  );
});
