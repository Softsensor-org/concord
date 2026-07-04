"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const linkage = require("./requirements-linkage.js");

function fixtureBoard(rows) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-25T00:00:00Z", canonical_references: [] },
    sections: [{ kind: "table", level: 3, heading: "Rows", separator_before: false, columns: [], rows }],
  };
}

test("normalizeLinkage reads explicit board fields and description requirement ids", () => {
  const row = {
    ID: "COORD-200",
    Repo: "X",
    Type: "feature",
    Status: "todo",
    Description: "[REQ-013] Link tickets to requirements.",
    "Requirement IDs": "URS-001, REQ-013",
    "Expected Evidence Class": "test_gate, manual_review",
    "External Refs": "JIRA-12; GH-34",
  };
  const normalized = linkage.normalizeLinkage(row);
  assert.deepEqual(normalized.requirement_ids, ["REQ-013", "URS-001"]);
  assert.deepEqual(normalized.explicit_requirement_ids, ["REQ-013", "URS-001"]);
  assert.deepEqual(normalized.inferred_requirement_ids, ["REQ-013"]);
  assert.deepEqual(normalized.expected_evidence_classes, ["manual_review", "test_gate"]);
  assert.deepEqual(normalized.external_refs, ["GH-34", "JIRA-12"]);
});

test("analyzeLinkage warns in product profile and fails in regulated profile for missing links", () => {
  const board = fixtureBoard([
    { ID: "A-001", Repo: "X", Type: "feature", Status: "todo", Description: "No requirement link" },
    { ID: "A-002", Repo: "X", Type: "feature", Status: "todo", Description: "[REQ-001] Linked" },
  ]);
  const registry = { requirements: [{ id: "REQ-001" }] };
  const product = linkage.analyzeLinkage(board, registry, { profile: "product-engineering", lane: "full" });
  assert.equal(product.ok, true);
  assert.equal(product.findings.find((finding) => finding.code === "missing-requirement-link").severity, "warning");

  const regulated = linkage.analyzeLinkage(board, registry, { profile: "regulated", lane: "full" });
  assert.equal(regulated.ok, false);
  assert.equal(regulated.findings.find((finding) => finding.code === "missing-requirement-link").severity, "fail");
});

test("analyzeLinkage reports unknown requirement ids and evidence classes", () => {
  const board = fixtureBoard([
    {
      ID: "A-003",
      Repo: "X",
      Type: "feature",
      Status: "todo",
      Description: "[REQ-999] Unknown",
      "Expected Evidence Class": "test_gate, vibes",
    },
  ]);
  const report = linkage.analyzeLinkage(board, { requirements: [{ id: "REQ-001" }] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((finding) => finding.code), ["unknown-evidence-class", "unknown-requirement-id"]);
});

test("run emits json and returns code 2 for regulated missing links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-linkage-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord/board/tasks.json"),
    JSON.stringify(fixtureBoard([{ ID: "A-001", Repo: "X", Type: "feature", Status: "todo", Description: "No link" }]), null, 2)
  );
  const output = [];
  const result = linkage.run(["--dir", dir, "--profile", "regulated", "--json"], { cwd: dir, log: (line) => output.push(line) });
  assert.equal(result.code, 2);
  const report = JSON.parse(output.join("\n"));
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].severity, "fail");
});
