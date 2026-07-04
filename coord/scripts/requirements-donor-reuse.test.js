"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const donorReuse = require("./requirements-donor-reuse.js");

test("analyzeDonorReuse passes explicit scrubbed generalized reuse pattern", () => {
  const report = donorReuse.analyzeDonorReuse({
    entries: [
      {
        id: "DR-001",
        source_system: "legacy-system-a",
        source_ref: "private://legacy/auth#rbac",
        control_pattern: "role-based approval boundary",
        target_requirement_ids: ["REQ-025"],
        reuse_decision: "reuse pattern",
        provenance_refs: ["private://legacy/auth#rbac"],
        confidence: "explicit",
        scrub_status: "scrubbed",
        generalization_status: "generalized",
        compliance_controls: ["audit-trail"],
      },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.reusable_patterns, 1);
  assert.deepEqual(report.findings, []);
});

test("analyzeDonorReuse fails blind reuse that still needs scrub and generalization", () => {
  const report = donorReuse.analyzeDonorReuse({
    entries: [
      {
        id: "DR-002",
        source_system: "legacy-system-b",
        control_pattern: "approval workflow",
        reuse_decision: "migrate",
        confidence: "candidate",
        scrub_status: "needs_scrub",
        generalization_status: "needs_generalization",
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "missing-provenance",
    "unsafe-reuse-needs-generalization",
    "unsafe-reuse-needs-scrub",
    "missing-target-requirement",
  ]);
});

test("analyzeDonorReuse fails private content and unknown decision/status", () => {
  const report = donorReuse.analyzeDonorReuse({
    entries: [
      {
        id: "DR-003",
        source_system: "legacy-system-c",
        control_pattern: "tenant seed data",
        reuse_decision: "copy",
        provenance_refs: ["private://seed"],
        confidence: "explicit",
        scrub_status: "raw",
        generalization_status: "generalized",
        customer_names: ["private customer"],
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "private-content-present",
    "unknown-reuse-decision",
    "unknown-scrub-status",
  ]);
});

test("run writes deterministic json report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-donor-reuse-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord/.runtime/requirements/donor-reuse-matrix.json"),
    JSON.stringify({
      entries: [
        {
          id: "DR-004",
          source_system: "legacy-system-d",
          control_pattern: "e-signature attestation",
          reuse_decision: "reuse_pattern",
          target_requirement_ids: ["REQ-025"],
          provenance_refs: ["private://legacy/esign"],
          confidence: "explicit",
          scrub_status: "private_pointer_only",
          generalization_status: "generalized",
        },
      ],
    })
  );
  const output = "coord/.runtime/requirements/donor-reuse-report.json";
  const result = donorReuse.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.kind, "concord.requirements.donor_reuse_matrix_report");
  assert.equal(written.summary.entries, 1);
});
