"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sequencing = require("./requirements-sequencing.js");
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
            ID: "VAL-001",
            Type: "feature",
            Pri: "P2",
            Status: "todo",
            Description: "Implement validation package for URS-001",
            "Requirement IDs": "URS-001",
            "Depends On": "DOC-001",
          },
          {
            ID: "DOC-001",
            Type: "docs",
            Pri: "P1",
            Status: "todo",
            Description: "Approve controlled-document pack for URS-002",
            "Requirement IDs": "URS-002",
            "Depends On": "",
          },
          {
            ID: "RUN-001",
            Type: "feature",
            Pri: "P0",
            Status: "todo",
            Description: "Add runtime proof for URS-003",
            "Requirement IDs": "URS-003",
            "Expected Evidence Class": "runtime_receipt",
            "Depends On": "",
          },
          {
            ID: "FEAT-001",
            Type: "feature",
            Pri: "P0",
            Status: "todo",
            Description: "Build ordinary feature for PRD-004",
            "Requirement IDs": "PRD-004",
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
        id: "URS-001",
        classification: {
          risk_class: "regulated",
          criticality: "gxp_regulatory",
          inspection_blocker: true,
        },
        coverage: { status: "partial", ticket_ids: ["VAL-001"] },
      },
      {
        id: "URS-002",
        evidence_class_required: ["controlled_document"],
        classification: {
          risk_class: "high",
          criticality: "compliance_critical",
        },
        coverage: {
          status: "planned",
          ticket_ids: ["DOC-001"],
          controlled_documents: [
            {
              id: "SOP-1",
              type: "validation_protocol",
              status: "draft",
              doc_ref: "private://eqms/doc/SOP-1",
              owner: "qa",
              version: "0.1",
              evidence_refs: ["private://eqms/approval/SOP-1"],
            },
          ],
        },
      },
      {
        id: "URS-003",
        evidence_class_required: ["runtime_receipt", "data_contract"],
        classification: {
          risk_class: "medium",
          criticality: "operational",
        },
        coverage: { status: "planned", ticket_ids: ["RUN-001"] },
      },
      {
        id: "PRD-004",
        classification: {
          risk_class: "low",
          criticality: "ordinary_product",
        },
        coverage: { status: "planned", ticket_ids: ["FEAT-001"] },
      },
      {
        id: "URS-005",
        classification: {
          risk_class: "critical",
          criticality: "data_integrity",
        },
        coverage: { status: "planned", ticket_ids: [] },
      },
    ],
  };
}

test("buildSequencingPlan orders compliance risk before feature priority and explains dependencies", () => {
  const plan = sequencing.buildSequencingPlan(fixtureBoard(), fixtureRegistry(), [], { profile: "regulated", lane: "regulated" });
  assert.equal(plan.kind, "concord.requirements.sequencing_plan");
  assert.equal(plan.dry_run, true);

  const firstWave = plan.waves[0];
  assert.equal(firstWave.id, "inspection_blockers");
  const validationTicket = firstWave.items.find((item) => item.ticket_id === "VAL-001");
  assert.ok(validationTicket);
  assert.deepEqual(validationTicket.blocked_by_open, ["DOC-001"]);
  assert.match(validationTicket.reasons.join("\n"), /inspection\/compliance risk/);

  const featureItem = plan.waves.flatMap((wave) => wave.items).find((item) => item.ticket_id === "FEAT-001");
  assert.equal(featureItem.wave, "implementation_backlog");
  assert.match(featureItem.risk_order_explanation, /No compliance-risk driver/);

  const missingTicket = firstWave.items.find((item) => item.requirement_ids.includes("URS-005"));
  assert.equal(missingTicket.ticket_id, null);
  assert.match(missingTicket.recommended_action, /Create governed ticket/);
});

test("requirements-sequencing command writes only explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-sequencing-"));
  const registryPath = "coord/.runtime/requirements/registry.json";
  const boardPath = "coord/board/tasks.json";
  const output = "coord/.runtime/requirements/sequencing-plan.json";
  fs.mkdirSync(path.dirname(path.join(dir, registryPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(dir, boardPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, registryPath), JSON.stringify(fixtureRegistry()));
  fs.writeFileSync(path.join(dir, boardPath), JSON.stringify(fixtureBoard()));

  const result = sequencing.run(["--dir", dir, "--registry", registryPath, "--board", boardPath, "--json", "--output", output], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.requirements_without_tickets, 1);
  assert.equal(written.sequencing_policy.mutation_boundary.includes("governed ticket"), true);
});

test("product CLI and umbrella command route requirements sequencing", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-sequencing"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-sequencing-cli-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(fixtureRegistry()));
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(fixtureBoard()));

  const cap = capture();
  const result = dispatch(["requirements", "sequence", "--dir", dir, "--registry", "coord/.runtime/requirements/registry.json", "--json"], {
    cwd: dir,
    log: cap.log,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.sequencing_plan");
  assert.equal(parsed.waves[0].id, "inspection_blockers");
});
