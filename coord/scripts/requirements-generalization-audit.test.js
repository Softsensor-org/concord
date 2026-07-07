"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const generalization = require("./requirements-generalization-audit.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function auditInput() {
  return {
    findings: [
      {
        id: "GEN-001",
        residue_type: "hardcoded_label",
        summary: "Legacy status label remains product default.",
        owning_abstraction: "terminology_token",
        provenance_refs: ["private://donor/repo#labels"],
        scrub_status: "private_pointer_only",
        requirement_ids: ["REQ-001"],
      },
      {
        id: "GEN-002",
        residue_type: "branded_seed_data",
        summary: "Sample data still uses branded identity.",
        owning_abstraction: "configuration_pack",
        provenance_refs: ["private://donor/repo#seed"],
        scrub_status: "needs_scrub",
      },
    ],
  };
}

test("analyzeGeneralizationAudit maps residue to abstractions and worklist", () => {
  const report = generalization.analyzeGeneralizationAudit(auditInput());
  assert.equal(report.kind, "concord.requirements.generalization_audit");
  assert.equal(report.summary.findings_input, 2);
  assert.equal(report.governed_worklist.length, 2);
  assert.equal(report.governed_worklist[0].owning_abstraction, "terminology_token");
  assert.ok(report.findings.some((finding) => finding.code === "residue-needs-scrub"));
  assert.ok(report.findings.some((finding) => finding.code === "branded-seed-data-leaks-default"));
});

test("analyzeGeneralizationAudit requires known residue type, abstraction, provenance, and scrub status", () => {
  const report = generalization.analyzeGeneralizationAudit({
    findings: [
      { id: "GEN-003", residue_type: "unknown", owning_abstraction: "", scrub_status: "strange" },
    ],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    ["missing-donor-provenance", "missing-owning-abstraction", "unknown-residue-type", "unknown-scrub-status"]
  );
});

test("requirements-generalization-audit command writes explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-generalization-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/generalization-audit.json"), JSON.stringify(auditInput()));
  const output = "coord/.runtime/requirements/generalization-audit-report.json";
  const result = generalization.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 2);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.governed_worklist, 2);
});

test("product CLI routes requirements-generalization-audit", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-generalization-audit"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-generalization-cli-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/generalization-audit.json"), JSON.stringify({
    findings: [
      {
        id: "GEN-001",
        residue_type: "threshold",
        owning_abstraction: "policy",
        provenance_refs: ["private://donor/repo#threshold"],
        scrub_status: "scrubbed",
        followup_ticket: "COORD-999",
      },
    ],
  }));
  const cap = capture();
  const result = dispatch(["requirements-generalization-audit", "--dir", dir, "--json"], { cwd: dir, log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.generalization_audit");
});
