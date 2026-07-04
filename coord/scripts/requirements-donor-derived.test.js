"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const donorDerived = require("./requirements-donor-derived.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("analyzeDonorDerived extracts concepts, evidence, and dry-run backlog proposals", () => {
  const report = donorDerived.analyzeDonorDerived({
    sources: [
      {
        id: "SRC-001",
        source_ref: "private://donor/repos/case-management#screens/intake",
        generalized_concepts: ["case intake", "review queue"],
        requirement_candidates: ["REQ-INTAKE-001"],
        implementation_evidence: ["src/routes/intake.tsx", "tests/intake.spec.ts"],
        confidence: "explicit",
        scrub_status: "private_pointer_only",
        proposed_tickets: [
          {
            title: "Implement generalized case intake",
            provenance_refs: ["private://donor/repos/case-management#screens/intake"],
          },
        ],
      },
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.kind, "concord.requirements.donor_to_product_analysis");
  assert.deepEqual(report.generalized_concepts, ["case intake", "review queue"]);
  assert.deepEqual(report.requirement_candidates, ["REQ-INTAKE-001"]);
  assert.equal(report.proposed_tickets[0].dry_run, true);
  assert.equal(report.summary.proposed_tickets, 1);
});

test("analyzeDonorDerived fails customer-specific residue and sensitive markers", () => {
  const report = donorDerived.analyzeDonorDerived({
    sources: [
      {
        id: "SRC-002",
        source_ref: "private://donor/repos/legacy#workflow",
        generalized_concepts: ["approval workflow"],
        customer_specific_residue: ["tenant-specific approval label"],
        scrub_status: "needs_scrub",
      },
      {
        id: "SRC-003",
        source_ref: "private://donor/repos/legacy#config",
        generalized_concepts: ["configuration handoff"],
        notes: "contains secret marker and must be pointer-only",
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    [
      "customer-specific-residue-needs-scrub",
      "missing-implementation-evidence",
      "missing-implementation-evidence",
      "sensitive-marker-present",
    ]
  );
});

test("donor-derived command writes only explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-donor-derived-"));
  const inventory = "coord/.runtime/requirements/donor-source-inventory.json";
  const output = "coord/.runtime/requirements/donor-derived-analysis.json";
  fs.mkdirSync(path.dirname(path.join(dir, inventory)), { recursive: true });
  fs.writeFileSync(path.join(dir, inventory), JSON.stringify({
    sources: [
      {
        id: "SRC-001",
        source_ref: "private://donor/repos/case-management#service",
        generalized_concepts: ["assignment rules"],
        implementation_evidence: ["src/services/assignment.ts"],
        scrub_status: "private_pointer_only",
      },
    ],
  }));

  const result = donorDerived.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.sources, 1);
  assert.equal(fs.existsSync(path.join(dir, "coord/board/tasks.json")), false);
});

test("product CLI routes requirements-donor-derived", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-donor-derived"].run, "function");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-donor-derived-cli-"));
  const inventory = "coord/.runtime/requirements/donor-source-inventory.json";
  fs.mkdirSync(path.dirname(path.join(dir, inventory)), { recursive: true });
  fs.writeFileSync(path.join(dir, inventory), JSON.stringify({
    sources: [
      {
        id: "SRC-001",
        source_ref: "private://donor/repos/case-management#route",
        generalized_concepts: ["case route"],
        implementation_evidence: ["src/routes/case.tsx"],
        scrub_status: "private_pointer_only",
      },
    ],
  }));
  const cap = capture();
  const result = dispatch(["requirements-donor-derived", "--dir", dir, "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.donor_to_product_analysis");
});
