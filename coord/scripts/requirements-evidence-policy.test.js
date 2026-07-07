"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const policy = require("./requirements-evidence-policy.js");

function fixtureBoard(rows) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-25T00:00:00Z", canonical_references: [] },
    sections: [{ kind: "table", level: 3, heading: "Rows", separator_before: false, columns: [], rows }],
  };
}

test("defaultRequiredEvidence strengthens high-risk requirements by dimension", () => {
  const req = {
    id: "REQ-018",
    classification: { risk_class: "high" },
    dimensions: {
      screens: ["admin-audit"],
      data_entities: ["AuditEvent"],
      security_controls: ["role:admin"],
    },
  };
  assert.deepEqual(policy.defaultRequiredEvidence(req), [
    "data_contract",
    "manual_review",
    "screenshot",
    "security_scan",
    "test_gate",
  ]);
});

test("analyzeEvidencePolicy fails high-risk requirement missing required evidence", () => {
  const board = fixtureBoard([
    {
      ID: "COORD-001",
      Repo: "X",
      Type: "feature",
      Status: "done",
      Description: "[REQ-001] High risk data workflow.",
      "Expected Evidence Class": "test_gate",
    },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-001",
        classification: { risk_class: "high" },
        dimensions: { data_entities: ["FactTable"] },
      },
    ],
  };
  const plans = [{ ticket_id: "COORD-001", repo_gates: ["node --test"], self_review_cycles: [] }];
  const report = policy.analyzeEvidencePolicy(board, registry, plans);
  assert.equal(report.ok, false);
  const finding = report.findings.find((item) => item.code === "missing-required-evidence");
  assert.equal(finding.severity, "fail");
  assert.deepEqual(finding.missing_evidence, ["data_contract", "manual_review"]);
  assert.equal(report.requirements[0].closure_strength, "partial");
  assert.equal(report.requirements[0].criticality, "ordinary_product");
});

test("analyzeEvidencePolicy passes when expected and plan evidence satisfy policy", () => {
  const board = fixtureBoard([
    {
      ID: "COORD-002",
      Repo: "X",
      Type: "feature",
      Status: "done",
      Description: "[REQ-002] Runtime workflow.",
      "Expected Evidence Class": "runtime_receipt, screenshot",
    },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-002",
        classification: { risk_class: "high", criticality: "business-critical" },
        coverage: { status: "satisfied" },
        dimensions: { routes: ["/orders"], screens: ["orders"] },
      },
    ],
  };
  const plans = [
    {
      ticket_id: "COORD-002",
      repo_gates: ["node --test"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["runtime receipt: observed /orders", "signed attestation: conformance digest"],
    },
  ];
  const report = policy.analyzeEvidencePolicy(board, registry, plans);
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.requirements[0].criticality, "business_critical");
  assert.equal(report.requirements[0].closure_strength, "validation_grade");
});

test("analyzeEvidencePolicy fails unknown risk and criticality vocabulary", () => {
  const board = fixtureBoard([
    { ID: "COORD-004", Repo: "X", Type: "feature", Status: "todo", Description: "[REQ-004] Unknown policy." },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-004",
        classification: { risk_class: "severe", criticality: "boardroom-only" },
      },
    ],
  };
  const report = policy.analyzeEvidencePolicy(board, registry, []);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    ["missing-required-evidence", "unknown-criticality", "unknown-risk-class"]
  );
});

test("analyzeEvidencePolicy validates waiver/deviation metadata", () => {
  const board = fixtureBoard([
    { ID: "COORD-005", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-005] waived." },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-005",
        classification: { risk_class: "regulated" },
        coverage: {
          status: "deviation",
          deviation: {
            classification: "regulated_deviation",
            reason: "accepted until replacement workflow lands",
            risk: "medium operational risk",
            approver: "qa-owner",
            approval_date: "2026-06-01",
            expires_at: "2026-12-31",
            compensating_control: "manual review checklist",
            evidence_refs: ["private://quality/deviations/REQ-005"],
          },
        },
      },
    ],
  };
  const report = policy.analyzeEvidencePolicy(board, registry, [], { asOfUtc: "2026-06-25T00:00:00.000Z" });
  assert.equal(report.requirements[0].closure_strength, "deviation");
  assert.equal(report.requirements[0].waiver_or_deviation.classification, "regulated_deviation");
  assert.equal(report.findings.some((finding) => finding.code.startsWith("waiver-")), false);
});

test("analyzeEvidencePolicy flags missing and expired waiver/deviation metadata", () => {
  const board = fixtureBoard([
    { ID: "COORD-006", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-006] waiver." },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-006",
        classification: { risk_class: "regulated" },
        coverage: {
          status: "waived",
          waiver: {
            classification: "product_deferral",
            reason: "accepted for pilot",
            risk: "known gap",
            approval_date: "2026-01-01",
            expires_at: "2026-02-01",
            evidence_refs: [],
          },
        },
      },
    ],
  };
  const report = policy.analyzeEvidencePolicy(board, registry, [], { asOfUtc: "2026-06-25T00:00:00.000Z" });
  const waiverFindings = report.findings.filter((finding) => finding.code.startsWith("waiver-"));
  assert.deepEqual(waiverFindings.map((finding) => finding.code).sort(), [
    "waiver-expired",
    "waiver-missing-evidence",
    "waiver-missing-required-field",
    "waiver-missing-required-field",
  ]);
  assert.deepEqual(
    waiverFindings.filter((finding) => finding.code === "waiver-missing-required-field").map((finding) => finding.field).sort(),
    ["approver", "compensating_control"]
  );
});

test("analyzeEvidencePolicy accepts approved controlled-document closure", () => {
  const board = fixtureBoard([
    { ID: "COORD-007", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-007] SOP closure." },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-007",
        classification: { risk_class: "regulated" },
        dimensions: { evidence_classes: ["test_gate", "manual_review", "attestation", "controlled_document"] },
        coverage: {
          status: "satisfied",
          controlled_documents: [
            {
              id: "DOC-001",
              type: "operating_procedure",
              status: "site_approved",
              owner: "quality",
              doc_ref: "private://quality/sops/DOC-001",
              version: "1.0",
              evidence_refs: ["private://quality/approvals/DOC-001"],
            },
          ],
        },
      },
    ],
  };
  const plans = [
    {
      ticket_id: "COORD-007",
      repo_gates: ["node --test"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["signed attestation: conformance digest"],
    },
  ];
  const report = policy.analyzeEvidencePolicy(board, registry, plans);
  assert.equal(report.ok, true);
  assert.equal(report.requirements[0].closure_strength, "validation_grade");
  assert.equal(report.requirements[0].controlled_documents[0].status, "site_approved");
});

test("analyzeEvidencePolicy does not treat vendor templates as approved controlled documents", () => {
  const board = fixtureBoard([
    { ID: "COORD-008", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-008] SOP template." },
  ]);
  const registry = {
    requirements: [
      {
        id: "REQ-008",
        classification: { risk_class: "regulated" },
        dimensions: { evidence_classes: ["test_gate", "manual_review", "attestation", "controlled_document"] },
        coverage: {
          status: "partial",
          controlled_documents: [
            {
              id: "DOC-002",
              type: "sop_template",
              status: "vendor_template",
              owner: "vendor",
              doc_ref: "private://vendor/templates/DOC-002",
              version: "0.9",
              evidence_refs: ["private://vendor/templates/DOC-002"],
            },
          ],
        },
      },
    ],
  };
  const plans = [
    {
      ticket_id: "COORD-008",
      repo_gates: ["node --test"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["signed attestation: conformance digest"],
    },
  ];
  const report = policy.analyzeEvidencePolicy(board, registry, plans);
  assert.equal(report.ok, false);
  assert.equal(report.requirements[0].closure_strength, "partial");
  assert.ok(report.requirements[0].missing_evidence.includes("controlled_document"));
  assert.ok(report.findings.some((finding) => finding.code === "vendor-template-not-site-approved"));
});

test("run requires registry and writes deterministic json output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-evidence-policy-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/plans"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord/board/tasks.json"),
    JSON.stringify(fixtureBoard([{ ID: "COORD-003", Repo: "X", Type: "feature", Status: "todo", Description: "[REQ-003] Low risk." }]), null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "registry.json"),
    JSON.stringify({ requirements: [{ id: "REQ-003", classification: { risk_class: "low" } }] }, null, 2)
  );
  fs.writeFileSync(path.join(dir, "coord/.runtime/plans/COORD-003.json"), JSON.stringify({ ticket_id: "COORD-003", repo_gates: ["node --test"] }));
  const output = path.join(dir, "coord/.runtime/requirements/evidence-policy.json");
  const result = policy.run(["--dir", dir, "--registry", "registry.json", "--json", "--output", "coord/.runtime/requirements/evidence-policy.json"], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(written.kind, "concord.requirements.evidence_policy");
  assert.equal(written.summary.requirements_checked, 1);
});
