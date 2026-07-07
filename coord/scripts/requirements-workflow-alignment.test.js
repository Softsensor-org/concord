"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workflow = require("./requirements-workflow-alignment.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("analyzeWorkflowAlignment classifies aligned, partial, deferred, outside, and addendum workflows", () => {
  const report = workflow.analyzeWorkflowAlignment(
    {
      workflows: [
        {
          id: "WF-001",
          title: "Approved intake",
          source_ref: "coord/product/URS.md#approved-intake",
          requirement_ids: ["REQ-001"],
          routes: ["/intake"],
          services: ["intakeService"],
          board_ticket_ids: ["COORD-001"],
        },
        {
          id: "WF-002",
          title: "Partial review",
          source_ref: "coord/product/URS.md#partial-review",
          requirement_ids: ["REQ-002"],
          routes: ["/review"],
        },
        {
          id: "WF-003",
          title: "Deferred export",
          source_ref: "coord/product/URS.md#export",
          requirement_ids: ["REQ-003"],
          urs_scope: "deferred",
        },
        {
          id: "WF-004",
          title: "Admin experiment",
          source_ref: "coord/product/design.md#admin-experiment",
          routes: ["/admin/experiment"],
        },
        {
          id: "WF-005",
          title: "Legacy-only report",
          source_ref: "coord/product/design.md#legacy-report",
          urs_scope: "outside",
        },
      ],
    },
    { requirements: [{ id: "REQ-001" }, { id: "REQ-002" }, { id: "REQ-003" }] }
  );

  assert.equal(report.kind, "concord.requirements.workflow_alignment_audit");
  assert.deepEqual(report.workflows.map((row) => [row.id, row.classification]), [
    ["WF-001", "aligned"],
    ["WF-002", "partial"],
    ["WF-003", "deferred_by_urs"],
    ["WF-004", "future_addendum_candidate"],
    ["WF-005", "outside_current_scope"],
  ]);
  assert.equal(report.summary.aligned, 1);
  assert.ok(report.gap_worklist.some((item) => item.workflow_id === "WF-002" && item.finding_code === "partial-workflow-gap"));
  assert.ok(report.gap_worklist.every((item) => item.dry_run === true));
});

test("analyzeWorkflowAlignment fails missing source citations and unknown requirement refs", () => {
  const report = workflow.analyzeWorkflowAlignment(
    {
      workflows: [
        {
          id: "WF-006",
          title: "Unknown requirement",
          requirement_ids: ["REQ-404"],
          routes: ["/unknown"],
        },
      ],
    },
    { requirements: [{ id: "REQ-001" }] }
  );
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    ["missing-source-citation", "partial-workflow-gap", "unknown-requirement-ref"]
  );
});

test("workflow alignment command writes only explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-workflow-alignment-"));
  const inventory = "coord/.runtime/requirements/workflow-inventory.json";
  const output = "coord/.runtime/requirements/workflow-urs-alignment.json";
  fs.mkdirSync(path.dirname(path.join(dir, inventory)), { recursive: true });
  fs.writeFileSync(path.join(dir, inventory), JSON.stringify({
    workflows: [
      { id: "WF-001", source_ref: "coord/product/URS.md#wf", requirement_ids: ["REQ-001"], routes: ["/wf"], board_ticket_ids: ["COORD-001"] },
    ],
  }));
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify({ requirements: [{ id: "REQ-001" }] }));
  const result = workflow.run(["--dir", dir, "--registry", "registry.json", "--json", "--output", output], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.workflows, 1);
  assert.equal(fs.existsSync(path.join(dir, "coord/board/tasks.json")), false);
});

test("product CLI routes requirements-workflow-alignment", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-workflow-alignment"].run, "function");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-workflow-alignment-cli-"));
  const inventory = "coord/.runtime/requirements/workflow-inventory.json";
  fs.mkdirSync(path.dirname(path.join(dir, inventory)), { recursive: true });
  fs.writeFileSync(path.join(dir, inventory), JSON.stringify({
    workflows: [
      { id: "WF-001", source_ref: "coord/product/URS.md#wf", requirement_ids: ["REQ-001"], routes: ["/wf"], board_ticket_ids: ["COORD-001"] },
    ],
  }));
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify({ requirements: [{ id: "REQ-001" }] }));
  const cap = capture();
  const result = dispatch(["requirements-workflow-alignment", "--dir", dir, "--registry", "registry.json", "--json"], {
    log: cap.log,
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(cap.text()).kind, "concord.requirements.workflow_alignment_audit");
});
