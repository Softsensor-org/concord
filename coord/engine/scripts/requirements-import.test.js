"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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
  assert.ok(registry.sources.every((source) => source.authority === "authoritative" && source.visibility === "public"));
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

test("COORD-525: bare or empty metadata fails import with its source line and no registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord525-metadata-"));
  try {
    const source = path.join(dir, "URS.md");
    for (const invalid of ["Kind: nonfunctional", "- Risk:", "- Risk high", "- Unknown Key: value"]) {
      fs.writeFileSync(source, `## URS-001: Example\n${invalid}\nThe system records a decision.\n`);
      const output = [];
      const result = importer.run(["--dir", dir, "--source", "URS.md", "--json"], {
        cwd: dir, log: (line) => output.push(line),
      });
      assert.equal(result.code, 1, invalid);
      assert.match(output.join("\n"), /requirements-import: URS\.md:2:/, invalid);
      assert.doesNotMatch(output.join("\n"), /"concord\.requirements\.registry"/, invalid);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-525: explicit unsupported classification values fail rather than becoming defaults", () => {
  for (const [field, value] of [["Kind", "non_functional"], ["Risk", "R4"], ["Priority", "P9"]]) {
    assert.throws(
      () => importer.parseMarkdownRequirements(`## URS-001: Example\n- ${field}: ${value}\nA statement.\n`, {
        sourcePath: "docs/URS.md",
      }),
      (error) => error.message.includes("docs/URS.md:1: URS-001") && error.message.includes(`unsupported ${field} value "${value}"`),
      `${field}: ${value}`
    );
  }
});

test("COORD-525: valid bullet metadata survives and omitted classifications retain documented defaults", () => {
  const requirements = importer.parseMarkdownRequirements([
    "## URS-001: Classified requirement",
    "- Kind: nonfunctional",
    "- Risk: regulated",
    "- Priority: P1",
    "- Evidence Class: test_gate",
    "",
    "The system records a decision.",
    "",
    "## URS-002",
    "Note: this is statement prose, not a metadata key.",
  ].join("\n"));
  assert.deepEqual(requirements[0].classification, {
    kind: "nonfunctional", priority: "P1", risk_class: "regulated", criticality: "standard", lifecycle: "draft",
  });
  assert.deepEqual(requirements[0].dimensions.evidence_classes, ["test_gate"]);
  assert.equal(requirements[1].title, "URS-002");
  assert.equal(requirements[1].statement, "Note: this is statement prose, not a metadata key.");
  assert.deepEqual(requirements[1].classification, {
    kind: "functional", priority: "P2", risk_class: "medium", criticality: "standard", lifecycle: "draft",
  });
});

test("COORD-525: CLI exits nonzero and never prints a success registry for invalid classifications", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord525-cli-"));
  try {
    fs.writeFileSync(path.join(dir, "URS.md"), "## URS-001: Example\n- Risk: R4\nA statement.\n");
    const result = spawnSync(process.execPath, [__dirname + "/requirements-import.js", "--dir", dir, "--source", "URS.md", "--json"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /URS\.md:1: URS-001: unsupported Risk value "R4"/);
    assert.doesNotMatch(result.stdout, /"concord\.requirements\.registry"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-525: metadata after prose, alias collisions, and malformed bullets fail closed", () => {
  const invalidBlocks = [
    ["A statement.", "- Risk: R4"],
    ["A statement.", "- Risk R4"],
    ["A statement.", "- Priorty: P1"],
    ["- Kind: functional", "- Type: security", "A statement."],
    ["- Unknown? Key: value", "A statement."],
    ["- Evidence: , ; |", "A statement."],
    ["- Ticket: , ; |", "A statement."],
  ];
  const errors = [
    /URS\.md:3: metadata "Risk" must appear before/, /bullet outside the metadata preamble/,
    /bullet outside the metadata preamble/, /duplicate metadata field "kind"/,
    /malformed or unsupported metadata bullet/, /empty list item/, /empty list item/,
  ];
  for (const [index, body] of invalidBlocks.entries()) {
    assert.throws(
      () => importer.parseMarkdownRequirements(["## URS-001: Example", ...body].join("\n"), { sourcePath: "URS.md" }),
      errors[index]
    );
  }
});

test("COORD-525: acceptance criteria may use labels that also name metadata fields", () => {
  const requirements = importer.parseMarkdownRequirements([
    "## URS-001: Example",
    "The system responds to a request.",
    "Acceptance Criteria:",
    "- API: responds with 200.",
    "- Risk: the reviewer sees a warning.",
  ].join("\n"), { sourcePath: "URS.md" });
  assert.deepEqual(requirements[0].acceptance_criteria, [
    "API: responds with 200.", "Risk: the reviewer sees a warning.",
  ]);
  assert.deepEqual(requirements[0].dimensions.apis, []);
  assert.equal(requirements[0].classification.risk_class, "medium");
});

test("COORD-525: every enum field in the registry schema rejects explicit unsupported values", () => {
  for (const [field, value] of [
    ["Criticality", "wild"], ["Lifecycle", "finished"], ["Coverage", "perfect"], ["Confidence", "certain"],
  ]) {
    assert.throws(
      () => importer.parseMarkdownRequirements(`## URS-001: Example\n- ${field}: ${value}\nA statement.\n`, {
        sourcePath: "URS.md",
      }),
      (error) => error.message.includes("URS.md:1: URS-001") && error.message.includes(`unsupported ${field} value "${value}"`)
    );
  }
});

test("COORD-786: valid explicit enum metadata survives import without falling back", () => {
  const [requirement] = importer.parseMarkdownRequirements([
    "## URS-001: Approved control",
    "- Criticality: safety_critical",
    "- Lifecycle: approved",
    "- Coverage: partial",
    "- Confidence: inferred",
    "A reviewer accepts the control.",
  ].join("\n"));
  assert.equal(requirement.classification.criticality, "safety_critical");
  assert.equal(requirement.classification.lifecycle, "approved");
  assert.equal(requirement.coverage.status, "partial");
  assert.equal(requirement.coverage.confidence, "inferred");
});
