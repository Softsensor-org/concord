"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildGuidedCloseoutReport,
  renderGuidedCloseout,
  writeRuntimeReceipt,
} = require("./guided-closeout.js");

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guided-closeout-"));
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", ".runtime", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), JSON.stringify({
    sections: [{ rows: [{ ID: "COORD-441", Status: "doing", Repo: "X", Type: "feature", Pri: "P1" }] }],
  }));
  return root;
}

test("guided closeout reports exact blockers and remediation commands", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [{ lens: "TODO", risks: ["one"] }],
    repo_gates: [],
    requirement_closure: [],
    feature_proof: [],
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((entry) => entry.id === "review_cycles"));
  assert.ok(report.next_commands.some((cmd) => /set-review-cycles COORD-441/.test(cmd)));
  assert.match(renderGuidedCloseout(report), /Guided Closeout/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout recognizes a complete closeout record and can write a runtime receipt", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["node --test coord/scripts/guided-closeout.test.js: pass"],
    requirement_closure: [
      "Ticket ask: add guided closeout",
      "Implemented: helper reports closeout gaps",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
    business_context_disposition: "not required",
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.ready, true);
  const receipt = writeRuntimeReceipt(report, root);
  assert.ok(fs.existsSync(receipt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout accepts explicit not-required repo gate dispositions", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["not-required"],
    requirement_closure: [
      "Ticket ask: add guided closeout",
      "Implemented: helper reports closeout gaps",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.checks.find((entry) => entry.id === "repo_gates").ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout recognizes business-context disposition in invariants", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    critical_invariants: [
      "business-context investigation: not-required; governance tooling only",
      "decision status: not-required; no new ADR",
    ],
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["not-required"],
    requirement_closure: [
      "Ticket ask: add guided closeout",
      "Implemented: helper reports closeout gaps",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.advisories.length, 0);
  assert.equal(report.checks.find((entry) => entry.id === "business_context_disposition").ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout accepts review findings that mention not required decisions", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: n === 3 ? "New ADR: not required for bounded helper wiring" : "none",
      verification: "node --test coord/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["not-required"],
    requirement_closure: [
      "Ticket ask: add guided closeout",
      "Implemented: helper reports closeout gaps",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
    critical_invariants: ["decision status: not-required; no new ADR"],
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.checks.find((entry) => entry.id === "review_cycles").ok, true);
  assert.equal(report.ready, true);
  fs.rmSync(root, { recursive: true, force: true });
});
