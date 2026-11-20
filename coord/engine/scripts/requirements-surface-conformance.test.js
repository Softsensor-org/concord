"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const surfaceConformance = require("./requirements-surface-conformance.js");
const { buildRegistry, dispatch } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function fixtureRegistry() {
  return {
    requirements: [
      {
        id: "PAT-001",
        title: "Patient request intake",
        classification: { risk_class: "low", criticality: "ordinary_product" },
        coverage: { status: "satisfied", ticket_ids: ["SURF-001"] },
      },
      {
        id: "PROV-001",
        title: "Provider review",
        classification: { risk_class: "low", criticality: "ordinary_product" },
        coverage: { status: "planned", ticket_ids: ["SURF-002"] },
      },
      {
        id: "SEC-001",
        title: "Tenant security",
        classification: { risk_class: "high", criticality: "security" },
        coverage: { status: "planned", ticket_ids: ["SURF-003"] },
      },
      {
        id: "PRIV-001",
        title: "Privacy boundary",
        classification: { risk_class: "medium", criticality: "security" },
        coverage: { status: "planned", ticket_ids: ["SURF-004"] },
      },
    ],
  };
}

function fixtureBoard() {
  return {
    sections: [
      {
        kind: "table",
        rows: [
          { ID: "SURF-001", Type: "feature", Pri: "P1", Status: "done", Description: "PAT-001", "Requirement IDs": "PAT-001" },
          { ID: "SURF-002", Type: "feature", Pri: "P1", Status: "todo", Description: "PROV-001", "Requirement IDs": "PROV-001" },
          { ID: "SURF-003", Type: "feature", Pri: "P0", Status: "todo", Description: "SEC-001", "Requirement IDs": "SEC-001" },
          { ID: "SURF-004", Type: "feature", Pri: "P0", Status: "todo", Description: "PRIV-001", "Requirement IDs": "PRIV-001" },
        ],
      },
    ],
  };
}

function fixturePlans() {
  return [
    {
      ticket_id: "SURF-001",
      repo_gates: ["node --test patient.test.js"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["path:src/patient.js"],
      requirement_closure: ["Closeout verdict: complete"],
    },
  ];
}

function fixtureMatrix() {
  return {
    surfaces: [
      {
        id: "patient-mobile",
        persona: "patient",
        app: "mobile",
        source_refs: ["private://prd/patient.md"],
        requirement_ids: ["PAT-001"],
        workflows: ["request-intake"],
      },
      {
        id: "provider-web",
        persona: "provider",
        app: "web",
        source_refs: ["private://prd/provider.md"],
        requirement_ids: ["PROV-001"],
        shared_requirement_ids: ["SEC-001"],
        workflows: ["review"],
        delivery_status: "open",
      },
    ],
    shared_requirements: [
      { id: "SEC-001", contract_area: "security", applies_to: ["patient-mobile", "provider-web"] },
      { id: "PRIV-001", contract_area: "privacy", applies_to: ["patient-mobile", "provider-web"] },
    ],
  };
}

test("analyzeSurfaceConformance models split surfaces and shared requirements", () => {
  const report = surfaceConformance.analyzeSurfaceConformance(
    fixtureMatrix(),
    fixtureRegistry(),
    fixtureBoard(),
    fixturePlans(),
    { requiredContractAreas: ["security", "privacy"] }
  );

  assert.equal(report.kind, "concord.requirements.surface_conformance");
  assert.equal(report.summary.surfaces, 2);
  assert.equal(report.summary.shared_requirements, 2);
  const patient = report.surfaces.find((surface) => surface.surface_id === "patient-mobile");
  assert.deepEqual(patient.shared_requirement_ids, ["PRIV-001", "SEC-001"]);
  assert.deepEqual(patient.covered_contract_areas, ["privacy", "security"]);
  assert.ok(patient.gaps.some((gap) => gap.requirement_id === "SEC-001"));
  assert.ok(report.findings.some((finding) => finding.code === "surface-delivery-status-projection"));
});

test("requirements-surface-conformance command writes explicit derived output", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-surface-conformance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(fixtureBoard()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(fixtureRegistry()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/surface-requirements.json"), JSON.stringify(fixtureMatrix()));

  const registryPath = "coord/.runtime/requirements/registry.json";
  const output = "coord/.runtime/requirements/surface-conformance.json";
  const refusedInputs = [
    [["--unknown"], "Unexpected argument: --unknown"],
    [[], "--registry is required"],
    [["--registry", "missing-registry.json"], "registry not found: missing-registry.json"],
    [["--registry", registryPath, "--board", "missing-board.json"], "board not found: missing-board.json"],
  ];
  for (const [flags, message] of refusedInputs) {
    const cap = capture();
    const result = surfaceConformance.run(["--dir", dir, "--output", output, ...flags], { log: cap.log });
    assert.deepEqual(result, { code: 1 });
    assert.equal(cap.text(), `requirements-surface-conformance: ${message}`);
    assert.equal(fs.existsSync(path.join(dir, output)), false);
  }
  const result = surfaceConformance.run([
    "--dir", dir,
    "--registry", registryPath,
    "--json",
    "--output", output,
    "--required-contract-areas", "security,privacy",
  ], { cwd: dir, log: () => {} });

  assert.equal(result.code, 2);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.surfaces, 2);
  assert.equal(written.source.matrix, "coord/.runtime/requirements/surface-requirements.json");
});

test("product CLI routes requirements-surface-conformance", (t) => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-surface-conformance"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-surface-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(fixtureBoard()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(fixtureRegistry()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/surface-requirements.json"), JSON.stringify(fixtureMatrix()));

  const cap = capture();
  const result = dispatch([
    "requirements-surface-conformance",
    "--dir", dir,
    "--registry", "coord/.runtime/requirements/registry.json",
    "--json",
  ], { cwd: dir, log: cap.log });

  assert.equal(result.code, 2);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.surface_conformance");
  assert.ok(parsed.findings.some((finding) => finding.code === "surface-delivery-status-projection"));

  const matrix = fixtureMatrix();
  delete matrix.surfaces[1].delivery_status;
  const matrixPath = path.join(dir, "coord/.runtime/requirements/surface-requirements.json");
  fs.writeFileSync(matrixPath, JSON.stringify(matrix));
  const markdown = capture();
  const compliant = dispatch([
    "requirements-surface-conformance",
    "--dir", dir,
    "--registry", "coord/.runtime/requirements/registry.json",
    "--required-contract-areas", "security,privacy",
  ], { cwd: dir, log: markdown.log });
  assert.equal(compliant.code, 0, markdown.text());
  assert.match(markdown.text(), /^# Requirements Surface Conformance\n/);
  assert.match(markdown.text(), /- provider-web: persona=provider app=web gaps=\d+ shared=PRIV-001, SEC-001/);
  assert.match(markdown.text(), /## Findings\nNone\.$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(matrixPath, "utf8")), matrix);
});

test("Markdown identifies incomplete surfaces and unknown shared requirements", () => {
  const matrix = {
    surfaces: [{}],
    shared_requirements: [{ id: "UNKNOWN-001", contract_area: "security", applies_to: ["web"] }],
  };
  const report = surfaceConformance.analyzeSurfaceConformance(matrix, fixtureRegistry(), fixtureBoard(), fixturePlans());
  const markdown = surfaceConformance.renderMarkdown(report);
  assert.match(markdown, /persona=unknown app=unknown gaps=0 shared=none/);
  assert.match(markdown, /FAIL : missing-surface-id/);
  assert.match(markdown, /FAIL UNKNOWN-001: unknown-shared-requirement/);
});
