"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const conformance = require("./requirements-conformance.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function fixtureBoard() {
  return {
    sections: [
      {
        kind: "table",
        rows: [
          {
            ID: "REQ-101",
            Type: "feature",
            Pri: "P1",
            Status: "done",
            Description: "Implement URS-101",
            "Requirement IDs": "URS-101",
            "Depends On": "",
          },
          {
            ID: "REQ-102",
            Type: "feature",
            Pri: "P2",
            Status: "todo",
            Description: "Implement URS-102",
            "Requirement IDs": "URS-102",
            "Depends On": "",
          },
        ],
      },
    ],
  };
}

function fixtureRegistry() {
  return {
    kind: "concord.requirements.registry",
    requirements: [
      {
        id: "URS-101",
        title: "Signed audit trail",
        classification: { risk_class: "low", criticality: "ordinary_product" },
        coverage: { status: "satisfied", ticket_ids: ["REQ-101"] },
      },
      {
        id: "URS-102",
        title: "Runtime receipt",
        evidence_class_required: ["runtime_receipt"],
        classification: { risk_class: "medium", criticality: "operational" },
        coverage: { status: "planned", ticket_ids: ["REQ-102"] },
      },
      {
        id: "URS-103",
        title: "Unlinked requirement",
        classification: { risk_class: "high", criticality: "compliance_critical" },
        coverage: { status: "planned", ticket_ids: [] },
      },
    ],
  };
}

function fixturePlans() {
  return [
    {
      ticket_id: "REQ-101",
      repo_gates: ["node --test audit.test.js"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["path:src/audit.js"],
      requirement_closure: ["Closeout verdict: complete"],
    },
  ];
}

test("scanRequirementsSource rejects delivered/open/status projections in URS docs", () => {
  const findings = conformance.scanRequirementsSource([
    "# URS",
    "## URS-101: Signed audit trail",
    "- Delivered: yes",
    "- Status: implemented",
    "The system shall record audit events.",
  ].join("\n"), { sourcePath: "docs/URS.md" });

  assert.deepEqual(findings.map((finding) => finding.code).sort(), [
    "delivered-projection",
    "delivered-projection",
    "status-projection",
  ]);
});

test("buildConformanceReport uses board, traceability, and evidence instead of source status prose", () => {
  const report = conformance.buildConformanceReport(fixtureBoard(), fixtureRegistry(), fixturePlans(), {
    sourceFindings: [],
    boardPath: "coord/board/tasks.json",
    registryPath: "coord/.runtime/requirements/registry.json",
  });

  assert.equal(report.kind, "concord.requirements.conformance_audit");
  assert.equal(report.requirements.find((row) => row.requirement_id === "URS-101").conformance_state, "conforming");
  assert.equal(report.requirements.find((row) => row.requirement_id === "URS-102").conformance_state, "partial");
  assert.equal(report.requirements.find((row) => row.requirement_id === "URS-103").conformance_state, "nonconforming");
  assert.equal(report.summary.requirements, 3);
  assert.equal(report.source_hygiene.ok, true);
});

test("requirements-conformance command writes derived output and check ignores generated timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-conformance-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/product"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(fixtureBoard()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(fixtureRegistry()));
  fs.writeFileSync(path.join(dir, "coord/product/URS.md"), "# URS\n\n## URS-101: Signed audit trail\nThe system shall record audit events.\n");

  const output = "coord/.runtime/requirements/conformance.json";
  const result = conformance.run([
    "--dir", dir,
    "--registry", "coord/.runtime/requirements/registry.json",
    "--source", "coord/product/URS.md",
    "--json",
    "--output", output,
  ], { cwd: dir, log: () => {} });
  assert.equal(result.code, 2, "fixture has missing evidence/unlinked requirement, so report is generated but nonconforming");
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  written.generated_at_utc = "2026-06-25T00:00:00.000Z";
  fs.writeFileSync(path.join(dir, output), JSON.stringify(written, null, 2));

  const check = conformance.run([
    "--dir", dir,
    "--registry", "coord/.runtime/requirements/registry.json",
    "--source", "coord/product/URS.md",
    "--json",
    "--check", output,
  ], { cwd: dir, log: () => {} });
  assert.equal(check.code, 2, "check matches, but conformance failures still return 2");
  assert.deepEqual(conformance.normalizeForCheck(written), conformance.normalizeForCheck(check.report));
});

test("product CLI and umbrella command route requirements conformance", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-conformance"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-conformance-cli-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(fixtureBoard()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(fixtureRegistry()));

  const cap = capture();
  const result = dispatch(["requirements", "conformance", "--dir", dir, "--registry", "coord/.runtime/requirements/registry.json", "--json"], {
    cwd: dir,
    log: cap.log,
  });
  assert.equal(result.code, 2);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.conformance_audit");
});
