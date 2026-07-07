"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const traceability = require("./requirements-traceability.js");

function board(rows, waiverIndex = {}) {
  return {
    version: 1,
    metadata: { title: "Fixture", last_updated: "2026-06-25T00:00:00Z", canonical_references: [] },
    sections: [{ kind: "table", level: 3, heading: "Rows", separator_before: false, columns: [], rows }],
    waiver_index: waiverIndex,
  };
}

test("buildTraceabilityMatrix maps requirements to tickets and evidence", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board([
      { ID: "T-001", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-001] linked" },
      { ID: "T-002", Repo: "X", Type: "feature", Status: "todo", Description: "missing" },
    ]),
    { requirements: [{ id: "REQ-001" }, { id: "REQ-002" }] },
    [{ ticket_id: "T-001", feature_proof: ["path:a.js"], repo_gates: ["node --test"], self_review_cycles: [{ verdict: "pass" }] }]
  );
  assert.deepEqual(matrix.requirement_to_tickets, [
    { requirement_id: "REQ-001", tickets: ["T-001"], status: "implemented" },
    { requirement_id: "REQ-002", tickets: [], status: "missing-ticket-link" },
  ]);
  assert.deepEqual(matrix.ticket_to_requirements[0].requirement_ids, ["REQ-001"]);
  assert.equal(matrix.requirement_evidence[0].evidence[0].feature_proof[0], "path:a.js");
  assert.equal(matrix.missing_links.some((item) => item.kind === "requirement-without-ticket" && item.requirement_id === "REQ-002"), true);
});

test("matrix identifies waiver-only and closed-with-weak-evidence rows", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board(
      [
        { ID: "T-001", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-001] weak" },
        { ID: "T-002", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-002] waiver" },
      ],
      { "T-002": { reason: "accepted" } }
    ),
    { requirements: [{ id: "REQ-001" }, { id: "REQ-002" }] },
    [
      { ticket_id: "T-001", feature_proof: [], repo_gates: [], self_review_cycles: [] },
      { ticket_id: "T-002", requirement_closure: ["Waiver: accepted"], feature_proof: [], repo_gates: [], self_review_cycles: [] },
    ]
  );
  assert.deepEqual(matrix.closed_with_weak_evidence.map((item) => item.ticket_id), ["T-001", "T-002"]);
  assert.deepEqual(matrix.waiver_only, [{ requirement_id: "REQ-002", tickets: ["T-002"] }]);
  assert.deepEqual(matrix.requirement_to_tickets.map((row) => [row.requirement_id, row.status]), [
    ["REQ-001", "planned"],
    ["REQ-002", "waived"],
  ]);
});

test("matrix treats deviation-only closure as waived-style non-implementation", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board([{ ID: "T-004", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-004] deviation" }]),
    { requirements: [{ id: "REQ-004", classification: { risk_class: "regulated" } }] },
    [{ ticket_id: "T-004", requirement_closure: ["Deviation: accepted risk until replacement"], feature_proof: [], repo_gates: [], self_review_cycles: [] }]
  );
  assert.deepEqual(matrix.waiver_only, [{ requirement_id: "REQ-004", tickets: ["T-004"] }]);
  assert.equal(matrix.requirement_to_tickets[0].status, "waived");
});

test("matrix distinguishes implemented from partial validation-grade closure", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board([
      { ID: "T-001", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-001] ordinary implemented" },
      { ID: "T-002", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-002] high risk partial" },
      { ID: "T-003", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-003] satisfied" },
    ]),
    {
      requirements: [
        { id: "REQ-001", classification: { risk_class: "low" } },
        { id: "REQ-002", classification: { risk_class: "high" } },
        { id: "REQ-003", classification: { risk_class: "regulated" }, coverage: { status: "satisfied" } },
      ],
    },
    [
      { ticket_id: "T-001", feature_proof: ["path:a.js"], repo_gates: ["node --test"], self_review_cycles: [] },
      { ticket_id: "T-002", feature_proof: ["path:b.js"], repo_gates: ["node --test"], self_review_cycles: [] },
      { ticket_id: "T-003", feature_proof: ["path:c.js"], repo_gates: ["node --test"], self_review_cycles: [{ verdict: "pass" }] },
    ]
  );
  assert.deepEqual(matrix.requirement_to_tickets.map((row) => [row.requirement_id, row.status]), [
    ["REQ-001", "implemented"],
    ["REQ-002", "partial"],
    ["REQ-003", "validation-grade"],
  ]);
});

test("run writes deterministic derived artifact only when --output is explicit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-traceability-"));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/plans"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord/board/tasks.json"),
    JSON.stringify(board([{ ID: "T-001", Repo: "X", Type: "feature", Status: "done", Description: "[REQ-001] linked" }]), null, 2)
  );
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify({ requirements: [{ id: "REQ-001" }] }, null, 2));
  fs.writeFileSync(
    path.join(dir, "coord/.runtime/plans/T-001.json"),
    JSON.stringify({ ticket_id: "T-001", feature_proof: ["path:a"], repo_gates: ["node --test"], self_review_cycles: [] }, null, 2)
  );
  const output = [];
  const result = traceability.run(
    ["--dir", dir, "--registry", "registry.json", "--output", "coord/.runtime/requirements/traceability.json", "--json"],
    { cwd: dir, log: (line) => output.push(line) }
  );
  assert.equal(result.code, 0);
  assert.equal(output.length, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/requirements/traceability.json"), "utf8"));
  assert.equal(written.kind, "concord.requirements.traceability_matrix");
  assert.equal(written.summary.requirements, 1);
});
