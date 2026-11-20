"use strict";
// COORD-1033: the real ADR registry must validate with zero findings. adr-validator.test.js
// only exercises fixture registries, so a non-conforming ADR merged to dev (ADR 0030 under
// COORD-996) without any test failing. This test runs the validator over every ADR under
// coord/docs/decisions and fails on any finding.
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const adr = require("./adr-validator.js");

test("COORD-1033: gov adr check reports 0 findings across every ADR in the real registry", () => {
  const decisions = path.join(COORD_ROOT_DIR, "docs", "decisions");
  const adrFiles = fs.readdirSync(decisions).filter((name) => /^[0-9]{4}-.+\.md$/.test(name));
  assert.ok(adrFiles.length > 0, "the real registry must contain ADRs");
  const report = adr.validate(decisions);
  const rendered = report.findings.map((finding) => `${finding.code} ${finding.id || ""}: ${finding.message}`);
  assert.deepEqual(rendered, [], `ADR findings:\n${rendered.join("\n")}`);
  assert.equal(report.summary.ok, true);
});
