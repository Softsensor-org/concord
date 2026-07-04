"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const audit = require("./requirements-persona-workflow.js");

function board(rows) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-25T00:00:00Z", canonical_references: [] },
    sections: [{ kind: "table", level: 3, heading: "Rows", separator_before: false, columns: [], rows }],
  };
}

test("analyzePersonaWorkflow flags open, stale done, and unknown blockers", () => {
  const report = audit.analyzePersonaWorkflow(
    {
      personas: [
        {
          persona: "driver",
          role_rbac_status: "defined",
          primary_surface: "mobile",
          workflows: ["complete delivery"],
          backend_coverage: "partial",
          frontend_coverage: "partial",
          blocker_tickets: ["T-001", "T-002", "T-999"],
        },
      ],
    },
    board([
      { ID: "T-001", Status: "todo" },
      { ID: "T-002", Status: "done" },
    ])
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => finding.code), ["unknown-blocker-ref", "open-blocker", "stale-done-blocker"]);
});

test("analyzePersonaWorkflow flags missing surface/workflow/rbac", () => {
  const report = audit.analyzePersonaWorkflow({ personas: [{ persona: "admin" }] }, board([]));
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((finding) => finding.code), ["missing-primary-surface", "missing-workflow", "unknown-rbac-status"]);
});

test("run writes output only when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-persona-workflow-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/persona-workflow-matrix.json"), JSON.stringify({ personas: [{ persona: "driver", primary_surface: "mobile", workflows: ["deliver"], blocker_tickets: [] }] }, null, 2));
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(board([]), null, 2));
  const out = [];
  const result = audit.run(["--dir", dir, "--output", "coord/.runtime/requirements/persona-workflow.json", "--json"], {
    cwd: dir,
    log: (line) => out.push(line),
  });
  assert.equal(result.code, 0);
  assert.equal(out.length, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/requirements/persona-workflow.json"), "utf8"));
  assert.equal(written.kind, "concord.requirements.persona_workflow_audit");
  assert.equal(written.summary.personas, 1);
});
