"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const traceability = require("./requirements-traceability.js");
const { evidenceRef, stableSupersessionId } = require("./plan-evidence-supersession.js");

test("traceability matrix excludes a superseded repo gate while preserving ticket links", () => {
  const old = "npm test [result=pass] against old head";
  const successor = "TODO: replacement has not been executed";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const matrix = traceability.buildTraceabilityMatrix(
    board([{ ID: "T-713", Repo: "X", Type: "feature", Status: "todo", Description: "[REQ-713] correction" }]),
    { requirements: [{ id: "REQ-713" }] },
    [{ ticket_id: "T-713", repo_gates: [old, successor],
      evidence_supersessions: [{ id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
        successor_ref: successorRef, reason: "stale head", actor: "fixture", timestamp: "2026-10-05T00:00:00.000Z" }] }]
  );
  assert.deepEqual(matrix.requirement_evidence[0].evidence[0].repo_gates, [successor]);
  assert.deepEqual(matrix.requirement_evidence[0].evidence[0].feature_proof, []);
  assert.deepEqual(matrix.requirement_evidence[0].evidence[0].verification_commands, []);
  assert.equal(matrix.requirement_evidence[0].evidence[0].review_cycles, 0);
  assert.equal(matrix.requirement_to_tickets[0].status, "planned", "a TODO successor is not proof of implementation");
});

test("traceability joins only explicit IDs when prose contains a historical requirement", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board([{ ID: "T-529", Repo: "X", Type: "feature", Status: "todo", Description: "Historical REQ-OLD mention", "Requirement IDs": "REQ-CURRENT" }]),
    { requirements: [{ id: "REQ-CURRENT" }, { id: "REQ-OLD" }] },
  );
  assert.deepEqual(matrix.requirement_to_tickets, [
    { requirement_id: "REQ-CURRENT", tickets: ["T-529"], status: "planned" },
    { requirement_id: "REQ-OLD", tickets: [], status: "missing-ticket-link" },
  ]);
  assert.deepEqual(matrix.ticket_to_requirements[0].requirement_ids, ["REQ-CURRENT"]);
  assert.deepEqual(matrix.ticket_to_requirements[0].inferred_requirement_ids, ["REQ-OLD"]);
  assert.equal(matrix.ticket_to_requirements[0].has_explicit_requirement_ids, true);
});

test("traceability retains explicit-none metadata without linking historical prose", () => {
  const matrix = traceability.buildTraceabilityMatrix(
    board([{ ID: "T-530", Repo: "X", Type: "feature", Status: "todo", Description: "Historical REQ-OLD mention", "Requirement IDs": "" }]),
    { requirements: [{ id: "REQ-OLD" }] },
  );
  assert.deepEqual(matrix.requirement_to_tickets[0].tickets, []);
  assert.equal(matrix.ticket_to_requirements[0].has_explicit_requirement_ids, true);
  assert.deepEqual(matrix.ticket_to_requirements[0].requirement_ids, []);
});

test("requirements-traceability CLI help is available before reading board artifacts", () => {
  const stdout = execFileSync(process.execPath, [path.join(__dirname, "requirements-traceability.js"), "--help"], { encoding: "utf8" });
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--board/);
});

test("requirements-traceability public CLI preserves refusal exit status", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "requirements-traceability.js"), "--unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unexpected argument: --unknown/);
});

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

test("run writes deterministic derived artifact only when --output is explicit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-traceability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
