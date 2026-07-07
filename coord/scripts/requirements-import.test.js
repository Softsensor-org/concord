"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const importer = require("./requirements-import.js");

test("parseMarkdownRequirements imports explicit requirement headings only", () => {
  const markdown = [
    "# Product Requirements",
    "",
    "## URS-001: Driver proof of delivery",
    "- Persona: driver, dispatcher",
    "- Workflow: delivery-completion",
    "- Screen: driver-delivery-detail",
    "- API: POST /api/deliveries/:id/proof",
    "- Security: role:driver, tenant-boundary",
    "- Evidence: test_gate, screenshot",
    "- Risk: high",
    "- Priority: P1",
    "",
    "Driver can submit proof of delivery after completing a stop.",
    "",
    "Acceptance Criteria:",
    "- Capture image evidence.",
    "- Record submitted timestamp.",
    "",
    "## Notes",
    "This heading should not import.",
  ].join("\n");

  const requirements = importer.parseMarkdownRequirements(markdown, {
    sourceId: "SRC-001",
    sourcePath: "docs/URS.md",
  });

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].id, "URS-001");
  assert.equal(requirements[0].title, "Driver proof of delivery");
  assert.equal(requirements[0].source.path, "docs/URS.md");
  assert.equal(requirements[0].source.line_start, 3);
  assert.match(requirements[0].source.block_hash, /^sha256:/);
  assert.deepEqual(requirements[0].dimensions.personas, ["driver", "dispatcher"]);
  assert.deepEqual(requirements[0].dimensions.screens, ["driver-delivery-detail"]);
  assert.deepEqual(requirements[0].dimensions.apis, ["POST /api/deliveries/:id/proof"]);
  assert.deepEqual(requirements[0].dimensions.security_controls, ["role:driver", "tenant-boundary"]);
  assert.deepEqual(requirements[0].dimensions.evidence_classes, ["test_gate", "screenshot"]);
  assert.equal(requirements[0].classification.risk_class, "high");
  assert.equal(requirements[0].classification.priority, "P1");
  assert.deepEqual(requirements[0].acceptance_criteria, ["Capture image evidence.", "Record submitted timestamp."]);
});

test("run emits deterministic registry json for direct and external markdown sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-import-"));
  fs.mkdirSync(path.join(dir, "coord/product"), { recursive: true });
  fs.mkdirSync(path.join(dir, "external"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord/product/REQUIREMENTS.md"),
    ["# Requirements", "", "### REQ-001: Local requirement", "Local statement."].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "external/URS.md"),
    ["# URS", "", "## DONOR-REQ-002: Candidate donor behavior", "- Risk: regulated", "Candidate statement."].join("\n")
  );

  const output = [];
  const result = importer.run(
    [
      "--dir",
      dir,
      "--project",
      "fixture",
      "--source",
      "coord/product/REQUIREMENTS.md",
      "--source",
      "external/URS.md",
      "--json",
    ],
    { cwd: dir, log: (line) => output.push(line) }
  );

  assert.equal(result.code, 0);
  const registry = JSON.parse(output.join("\n"));
  assert.equal(registry.kind, "concord.requirements.registry");
  assert.equal(registry.schema_version, 1);
  assert.equal(registry.project.name, "fixture");
  assert.deepEqual(registry.sources.map((source) => source.uri), ["coord/product/REQUIREMENTS.md", "external/URS.md"]);
  assert.deepEqual(registry.requirements.map((req) => req.id), ["DONOR-REQ-002", "REQ-001"]);
  assert.equal(registry.requirements[0].source.path, "external/URS.md");
  assert.equal(registry.requirements[0].classification.risk_class, "regulated");
});

test("run rejects missing sources and unexpected args without writing files", () => {
  const missing = [];
  const missingResult = importer.run(["--dir", os.tmpdir(), "--source", "missing.md"], {
    log: (line) => missing.push(line),
  });
  assert.equal(missingResult.code, 1);
  assert.match(missing.join("\n"), /source not found/);

  const bad = [];
  const badResult = importer.run(["--bad"], { log: (line) => bad.push(line) });
  assert.equal(badResult.code, 1);
  assert.match(bad.join("\n"), /Unexpected argument/);
});
