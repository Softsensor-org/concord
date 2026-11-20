"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

test("normalizeLinkage tolerates absent identity and description fields on a direct legacy row", () => {
  const normalized = linkage.normalizeLinkage({});
  assert.equal(normalized.ticket_id, "");
  assert.deepEqual(normalized.requirement_ids, []);
  assert.deepEqual(normalized.inferred_requirement_ids, []);
});

test("public CLI help executes the requirements linkage entrypoint", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "requirements-linkage.js"), "--help"], {
    cwd: path.resolve(__dirname, "../../.."), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: requirements-linkage/);
});

test("explicit field overrides historical description IDs but preserves inference diagnostics", () => {
  const normalized = linkage.normalizeLinkage({
    ID: "COORD-529", Description: "Historical mention REQ-OLD", "Requirement IDs": "REQ-CURRENT",
  });
  assert.deepEqual(normalized.requirement_ids, ["REQ-CURRENT"]);
  assert.deepEqual(normalized.explicit_requirement_ids, ["REQ-CURRENT"]);
  assert.deepEqual(normalized.inferred_requirement_ids, ["REQ-OLD"]);
});

test("present empty metadata means explicit none while absent metadata preserves legacy inference", () => {
  const explicitNone = linkage.normalizeLinkage({ ID: "A-1", Description: "REQ-OLD is background", "Requirement IDs": "" });
  const legacy = linkage.normalizeLinkage({ ID: "A-2", Description: "REQ-OLD is background" });
  assert.deepEqual(explicitNone.requirement_ids, []);
  assert.equal(explicitNone.has_explicit_requirement_ids, true);
  assert.deepEqual(explicitNone.inferred_requirement_ids, ["REQ-OLD"]);
  assert.deepEqual(legacy.requirement_ids, ["REQ-OLD"]);
  assert.equal(legacy.has_explicit_requirement_ids, false);
});

test("historically accepted array metadata remains an explicit list", () => {
  const normalized = linkage.normalizeLinkage({ ID: "A-3", Description: "REQ-OLD", "Requirement IDs": ["URS-2", "REQ-1"] });
  assert.deepEqual(normalized.requirement_ids, ["REQ-1", "URS-2"]);
  assert.deepEqual(normalized.inferred_requirement_ids, ["REQ-OLD"]);
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

test("analyzeLinkage preserves non-linkable rows without reporting them as missing links", () => {
  const board = fixtureBoard([
    { ID: "A-005", Repo: "X", Type: "chore", Status: "todo", Description: "No requirement link" },
  ]);
  const report = linkage.analyzeLinkage(board, { requirements: [] });
  assert.equal(report.tickets.length, 1);
  assert.equal(report.findings.some((finding) => finding.code === "missing-requirement-link"), false);
});

test("explicit none is diagnosed as intentional and schema rejects malformed authored IDs", () => {
  const report = linkage.analyzeLinkage(fixtureBoard([
    { ID: "A-004", Repo: "X", Type: "feature", Status: "todo", Description: "Historic REQ-OLD context", "Requirement IDs": "" },
  ]), { requirements: [] });
  assert.equal(report.findings[0].message, "Ticket explicitly declares no requirement IDs.");

  const boardTest = require(resolveEngineModule(COORD_ROOT_DIR, "board/board.js")).__testing;
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../board/tasks.schema.json"), "utf8"));
  const requirementIdsSchema = schema.properties.sections.items.properties.rows.items.properties["Requirement IDs"];
  const engineSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../board/tasks.schema.json"), "utf8"));
  assert.deepEqual(engineSchema, schema, "engine and board schema copies must remain identical");
  for (const metadata of ["", "req-1, URS-2", ["REQ-1", "donor-req-2"]]) {
    const errors = [];
    boardTest.validateSchema(requirementIdsSchema, metadata, "Requirement IDs", errors);
    assert.deepEqual(errors, [], `valid metadata should pass: ${JSON.stringify(metadata)}`);
  }
  for (const metadata of ["REQ bad", ["REQ-OK", "bad"], [""]]) {
    const errors = [];
    boardTest.validateSchema(requirementIdsSchema, metadata, "Requirement IDs", errors);
    assert.ok(errors.some((error) => error.includes("does not satisfy any allowed schema")), JSON.stringify(metadata));
  }
  for (const metadata of ["REQ-1-", "REQ-1.", ["REQ-1-"], ["REQ-1."]]) {
    const errors = [];
    boardTest.validateSchema(requirementIdsSchema, metadata, "Requirement IDs", errors);
    assert.ok(errors.some((error) => error.includes("does not satisfy any allowed schema")),
      `schema must reject IDs the anchored parser cannot extract: ${JSON.stringify(metadata)}`);
  }
  for (const metadata of ["REQ-1", "REQ-1_a", ["REQ-1"], ["REQ-1_a"]]) {
    const errors = [];
    boardTest.validateSchema(requirementIdsSchema, metadata, "Requirement IDs", errors);
    assert.deepEqual(errors, [], `parser-compatible IDs should pass schema: ${JSON.stringify(metadata)}`);
  }
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

test("run emits json and returns code 2 for regulated missing links", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-linkage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
