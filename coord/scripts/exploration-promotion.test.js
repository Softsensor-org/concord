"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const promotion = require("./exploration-promotion.js");
const { buildRegistry } = require("./coord-cli.js");

function artifact() {
  return {
    id: "EXP-001",
    kind: "rendered_ui_qa",
    source: { uri: "private://review/rendered-site", label: "Rendered QA" },
    evidence_classes: ["manual_review", "screenshot"],
    confidence: "explicit",
    findings: [
      {
        id: "F-001",
        title: "Checkout CTA is hidden on mobile",
        summary: "Rendered review found mobile CTA below fold.",
        proposed_ticket: { repo: "F", type: "bug", pri: "P1", title: "Fix mobile checkout CTA visibility" },
      },
      {
        id: "F-002",
        title: "Rejected color experiment",
        rejected: true,
        rejection_reason: "Not supported by buyer review evidence.",
      },
    ],
  };
}

test("promoteExplorationArtifact emits dry-run ticket specs with evidence", () => {
  const report = promotion.promoteExplorationArtifact(artifact());
  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.proposed_tickets.length, 1);
  assert.equal(report.proposed_tickets[0].source_evidence.source_uri, "private://review/rendered-site");
  assert.equal(report.unpromoted_findings[0].authoritative, false);
});

test("invalid artifacts fail without producing authoritative tickets", () => {
  const report = promotion.promoteExplorationArtifact({ kind: "mystery", findings: [{ title: "x" }] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => finding.code), ["unknown-exploration-kind", "missing-source"]);
  assert.equal(report.proposed_tickets[0].dry_run, true);
});

test("run reads artifact and writes explicit output only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exploration-promotion-"));
  fs.writeFileSync(path.join(dir, "exploration.json"), JSON.stringify(artifact(), null, 2));
  const out = "promotion.json";
  const result = promotion.run(["--artifact", "exploration.json", "--output", out, "--json"], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, out), "utf8"));
  assert.equal(written.kind, "concord.exploration.promotion_report");
  assert.equal(written.summary.proposed_tickets, 1);
});

test("coord CLI registers exploration-promote", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry["exploration-promote"]);
});
