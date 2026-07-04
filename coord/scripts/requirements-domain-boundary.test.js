"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const domain = require("./requirements-domain-boundary.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function completeManifest() {
  return {
    product_class: "decision_support",
    decision_mode: "recommends",
    automated_decision_making: false,
    human_reviewer_required: true,
    glossary_terms: [
      { term: "eligibility", definition: "Review-specific eligibility criteria.", source_refs: ["private://source/glossary#eligibility"] },
    ],
    authority_boundaries: [
      {
        id: "review-recommendation",
        mode: "recommends",
        human_owner: "reviewer",
        source_refs: ["private://source/authority#review"],
      },
    ],
    source_evidence: [{ id: "SRC-001", ref: "private://source/urs" }],
    no_missing_documents_or_contradictions: true,
    investigation_workflows: [
      { id: "investigate-missing-source", steps: ["inspect source", "escalate gap"], escalation: "quality-owner" },
    ],
  };
}

test("analyzeDomainBoundary passes complete decision-support manifest", () => {
  const report = domain.analyzeDomainBoundary(completeManifest());
  assert.equal(report.kind, "concord.requirements.domain_boundary_report");
  assert.equal(report.ok, true);
  assert.equal(report.coverage.glossary_terms, 1);
  assert.equal(report.profile.decision_mode, "recommends");
});

test("analyzeDomainBoundary flags missing ontology, authority, evidence, and investigation workflow", () => {
  const report = domain.analyzeDomainBoundary({ product_class: "decision_support" });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity === "fail").map((finding) => finding.code).sort(),
    [
      "missing-authority-boundary",
      "missing-decision-mode",
      "missing-glossary",
      "missing-investigation-workflow",
      "missing-source-evidence",
    ]
  );
});

test("analyzeDomainBoundary distinguishes automated decision-making authority", () => {
  const manifest = completeManifest();
  manifest.decision_mode = "decides";
  manifest.automated_decision_making = true;
  delete manifest.automation_authority_basis;
  const report = domain.analyzeDomainBoundary(manifest);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "missing-automation-authority-basis"));
});

test("requirements-domain-boundary command writes explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-domain-boundary-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/domain-boundary.json"), JSON.stringify(completeManifest()));
  const output = "coord/.runtime/requirements/domain-boundary-report.json";
  const result = domain.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.failures, 0);
});

test("product CLI routes requirements-domain-boundary", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-domain-boundary"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-domain-cli-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/domain-boundary.json"), JSON.stringify(completeManifest()));
  const cap = capture();
  const result = dispatch(["requirements-domain-boundary", "--dir", dir, "--json"], { cwd: dir, log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.domain_boundary_report");
});
