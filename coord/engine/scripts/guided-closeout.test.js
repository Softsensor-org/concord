"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildGuidedCloseoutReport: buildReportWithoutInjectedReviewReadiness,
  businessContextDispositionPresent,
  guidedCloseoutCommand,
  renderGuidedCloseout,
  splitRequirementClosure,
  writeRuntimeReceipt,
} = require("./guided-closeout.js");
const { evidenceRef, stableSupersessionId, stableDispositionId } = require("./plan-evidence-supersession.js");

// Unit fixtures inject an explicit clear collector result. Public CLI wiring is
// covered separately; absence of the production adapter must fail closed.
function buildGuidedCloseoutReport(input) {
  return buildReportWithoutInjectedReviewReadiness({
    ...input,
    collectReviewPlanReadinessIssues: input.collectReviewPlanReadinessIssues || (() => []),
  });
}

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
  assert.ok(report.next_commands.some((cmd) => /set-review-cycles COORD-441 --replace --review-cycle/.test(cmd)));
  assert.match(renderGuidedCloseout(report), /Guided Closeout/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout cannot pass on a superseded repo gate and ignores a TODO successor", () => {
  const root = tmpRoot();
  const old = "node --test [result=pass] against stale head";
  const successor = "TODO: replacement gate has not run";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const report = buildGuidedCloseoutReport({
    ticketId: "COORD-441", root,
    plan: { ticket_id: "COORD-441", repo_gates: [old, successor, { malformed: true }], verification_commands: [null], evidence_supersessions: [{
      id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
      successor_ref: successorRef, reason: "Stale gate output.", actor: "fixture", timestamp: "2026-10-05T00:00:00.000Z",
    }] },
  });
  const check = report.checks.find((entry) => entry.id === "repo_gates");
  assert.equal(check.ok, false);
  assert.match(check.message, /required|gate/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout refuses valid JSON plan files whose value is null or false without writing state", (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = path.join(root, "coord", ".runtime", "plans", "COORD-441.json");
  fs.writeFileSync(planPath, "null");
  assert.throws(() => buildGuidedCloseoutReport({ ticketId: "COORD-441", root }), TypeError);
  assert.equal(fs.readFileSync(planPath, "utf8"), "null", "a malformed semantic plan value is never rewritten");
  fs.writeFileSync(planPath, "false");
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.ready, false);
  assert.equal(fs.readFileSync(planPath, "utf8"), "false", "a falsey valid JSON value is never rewritten");
});

test("guided closeout recognizes a complete closeout record and can write a runtime receipt", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/engine/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/engine/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["node --test coord/engine/scripts/guided-closeout.test.js: pass"],
    requirement_closure: [
      "Ticket ask: add guided closeout",
      "Implemented: helper reports closeout gaps",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
    business_context_disposition: "not required",
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.ready, true);
  const receipt = writeRuntimeReceipt(report, root);
  assert.ok(fs.existsSync(receipt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout is not ready when canonical review readiness is not injected", () => {
  const root = tmpRoot();
  const report = buildReportWithoutInjectedReviewReadiness({ ticketId: "COORD-441", root });
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((entry) => entry.id === "review_plan").ok, false);
  assert.match(report.checks.find((entry) => entry.id === "review_plan").message, /not assessed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout treats an invalid canonical review collector result as unassessed", () => {
  const root = tmpRoot();
  const report = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    collectReviewPlanReadinessIssues: () => undefined,
  });
  const check = report.checks.find((entry) => entry.id === "review_plan");
  assert.equal(check.ok, false);
  assert.equal(check.assessed, false);
  assert.equal(report.ready, false);
  assert.match(check.message, /invalid result/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout preserves canonical gate codes and messages", () => {
  const root = tmpRoot();
  const report = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    collectReviewPlanReadinessIssues: () => [{
      code: "context_pack_ack",
      message: "Plan state for COORD-441 must record a structured context_pack_ack before review.",
      next_steps: ["coord/scripts/gov update-plan COORD-441 --context-pack-ack '<json>'"],
    }],
  });
  const check = report.checks.find((entry) => entry.id === "review_plan");
  assert.equal(check.ok, false);
  assert.deepEqual(check.issues.map((issue) => issue.code), ["context_pack_ack"]);
  assert.match(check.issues[0].message, /structured context_pack_ack/);
  assert.deepEqual(check.issues[0].next_steps, ["coord/scripts/gov update-plan COORD-441 --context-pack-ack '<json>'"]);
  assert.ok(report.next_commands.includes("coord/scripts/gov update-plan COORD-441 --context-pack-ack '<json>'"));
  assert.match(renderGuidedCloseout(report), /Gate context_pack_ack: Plan state/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout reports unknown status and renders review issues without next steps", () => {
  const root = tmpRoot();
  const report = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    row: { ID: "COORD-441", Repo: "X", Type: "feature" },
    collectReviewPlanReadinessIssues: () => [{
      code: "fixture_review_gate",
      message: "This fixture issue has no remediation command.",
    }],
  });
  const status = report.checks.find((entry) => entry.id === "finalize_status");
  const review = report.checks.find((entry) => entry.id === "review_plan");
  assert.equal(report.status, "unknown");
  assert.match(status.message, /status unknown is not eligible for finalize/);
  assert.equal(report.ready, false);
  assert.deepEqual(review.issues, [{
    code: "fixture_review_gate",
    message: "This fixture issue has no remediation command.",
    next_steps: [],
  }]);
  assert.equal(report.next_commands.includes(undefined), false);
  const rendered = renderGuidedCloseout(report);
  assert.match(rendered, /Gate fixture_review_gate: This fixture issue has no remediation command/);
  assert.doesNotMatch(rendered, /Next:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout helper handles empty, seeded, and unmatched canonical inputs", () => {
  const root = tmpRoot();
  const emptyClosure = splitRequirementClosure({
    requirement_closure: "",
    scaffold_placeholders: { requirement_closure: [null, "Internal placeholder"] },
  });
  assert.deepEqual(emptyClosure, {});
  assert.deepEqual(splitRequirementClosure({
    scaffold_placeholders: { requirement_closure: ["Ticket ask: fixture scaffold"] },
    requirement_closure: [
      "Ticket ask: fixture scaffold",
      "Implemented: retained real implementation",
    ],
  }), { implemented: "retained real implementation" });

  const report = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    board: { sections: [{}] },
    plan: { repo_gates: "not-required", feature_proof: [null, "path:<placeholder>"] },
    collectReviewPlanReadinessIssues: () => {
      throw new Error("an unmatched canonical ticket must not be assessed");
    },
  });
  assert.equal(report.checks.find((entry) => entry.id === "ticket_exists").ok, false);
  assert.equal(report.checks.find((entry) => entry.id === "repo_gates").ok, true);
  assert.equal(report.checks.find((entry) => entry.id === "review_plan").assessed, false);
  assert.throws(() => buildReportWithoutInjectedReviewReadiness({ root }), /requires a ticket id/);
  const missingSections = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    board: {},
    plan: { repo_gates: [null] },
    collectReviewPlanReadinessIssues: () => [],
  });
  assert.equal(missingSections.checks.find((entry) => entry.id === "ticket_exists").ok, false);
  assert.equal(missingSections.checks.find((entry) => entry.id === "repo_gates").ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("business-context disposition checks each supported source and rejects empty claims", () => {
  assert.equal(businessContextDispositionPresent({}), false);
  assert.equal(businessContextDispositionPresent({ business_context_disposition: "not-required" }), true);
  assert.equal(businessContextDispositionPresent({ context_pack_ack: { business_context: "investigated" } }), true);
  assert.equal(businessContextDispositionPresent({ context_pack_ack: { decision: "no ADR required" } }), true);
});

test("guided closeout renders ready reports and supports text and JSON receipts", () => {
  const ticketId = "COORD-545-CLOSEOUT-FIXTURE";
  const board = { sections: [{ rows: [{ ID: ticketId, Status: "doing" }] }] };
  const plan = {
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`, diff: "fixture", risks: ["risk one", "risk two"],
      findings: "none", verification: "node --test", verdict: "pass",
    })),
    repo_gates: ["node --test: pass"],
    requirement_closure: [
      "Ticket ask: exercise the ready rendering path",
      "Implemented: report contracts have meaningful edge coverage",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js", "path:<placeholder>"],
    gate_plan: { selected_gates: [] },
    business_context_disposition: "not required",
  };
  const report = buildReportWithoutInjectedReviewReadiness({
    ticketId,
    board,
    plan,
    row: board.sections[0].rows[0],
    collectReviewPlanReadinessIssues: () => [],
  });
  assert.equal(report.ready, true);
  assert.match(renderGuidedCloseout(report), /Ready: yes/);
  const renderedWithoutNextSteps = renderGuidedCloseout({
    ticket_id: ticketId,
    mode: "ordinary_finalize_precheck",
    readiness_scope: "A caller-supplied report fixture.",
    ready: false,
    checks: [{
      id: "review_plan",
      ok: false,
      severity: "blocker",
      message: "An externally supplied review report may omit optional remediation steps.",
      issues: [{ code: "fixture", message: "No next step was supplied." }],
    }],
  });
  assert.match(renderedWithoutNextSteps, /Gate fixture: No next step was supplied/);

  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), JSON.stringify(board));
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", `${ticketId}.json`), JSON.stringify(plan));
  const originalWrite = process.stdout.write;
  let textOutput = "";
  process.stdout.write = (value) => { textOutput += String(value); return true; };
  try {
    const textReport = guidedCloseoutCommand(ticketId, { root }, {
      collectReviewPlanReadinessIssues: () => [],
    });
    assert.equal(textReport.ready, true);
    assert.match(textOutput, /Ready: yes/);
  } finally {
    process.stdout.write = originalWrite;
  }
  const originalLog = console.log;
  let jsonOutput = "";
  console.log = (value) => { jsonOutput = value; };
  try {
    const written = guidedCloseoutCommand(ticketId, { root, json: true, write: true }, {
      collectReviewPlanReadinessIssues: () => [],
    });
    assert.equal(written.ready, true);
    assert.match(written.receipt_path, /closeout-guides/);
    assert.equal(JSON.parse(jsonOutput).ticket_id, ticketId);
    assert.equal(fs.existsSync(path.join(root, "coord", ".runtime", "closeout-guides", `${ticketId}.json`)), true);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

});

test("guided closeout distinguishes ordinary, blocked, unknown, and recovery-only statuses", () => {
  const root = tmpRoot();
  const buildForStatus = (status, rowId = "COORD-441") => buildGuidedCloseoutReport({
    ticketId: "COORD-441",
    root,
    row: { ID: rowId, Status: status, Repo: "X", Type: "feature" },
    collectReviewPlanReadinessIssues: () => [],
  });
  assert.equal(buildForStatus("doing").checks.find((entry) => entry.id === "finalize_status").ok, true);
  assert.equal(buildForStatus("review").checks.find((entry) => entry.id === "finalize_status").ok, true);
  const blocked = buildForStatus("doing (blocked: fixture)");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.checks.find((entry) => entry.id === "finalize_status").ok, false);
  const done = buildForStatus("done");
  assert.equal(done.ready, false, "done must not report ordinary finalize readiness");
  assert.equal(done.mode, "idempotent_plan_recovery_only");
  assert.equal(done.checks.find((entry) => entry.id === "finalize_status").ok, false);
  assert.equal(done.checks.find((entry) => entry.id === "finalize_status").recovery_only, true);
  assert.equal(done.checks.find((entry) => entry.id === "review_plan").ok, true);
  let unknownCollectorCalled = false;
  const unknown = buildReportWithoutInjectedReviewReadiness({
    ticketId: "COORD-441",
    root,
    row: { ID: "OTHER-1", Status: "doing", Repo: "X", Type: "feature" },
    collectReviewPlanReadinessIssues: () => {
      unknownCollectorCalled = true;
      throw new Error("unknown ticket must not enter the collector");
    },
  });
  assert.equal(unknown.ready, false);
  assert.equal(unknownCollectorCalled, false);
  assert.equal(unknown.checks.find((entry) => entry.id === "ticket_exists").ok, false);
  assert.match(renderGuidedCloseout(done), /idempotent plan recovery only/);
  assert.match(renderGuidedCloseout(blocked), /Git, remote, ownership, lock, PR, and landing/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout accepts explicit not-required repo gate dispositions", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/engine/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/engine/scripts/guided-closeout.test.js",
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
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
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
      diff: "coord/engine/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/engine/scripts/guided-closeout.test.js",
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
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.advisories.length, 0);
  assert.equal(report.checks.find((entry) => entry.id === "business_context_disposition").ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guided closeout ignores a retracted historical business-context disposition", () => {
  const value = "business-context investigation: not-required; obsolete decision";
  const sourceRef = evidenceRef("critical_invariant", 1, value);
  const report = buildGuidedCloseoutReport({
    ticketId: "COORD-441",
    board: { sections: [{ rows: [{ ID: "COORD-441", Status: "doing", Repo: "X" }] }] },
    plan: {
      ticket_id: "COORD-441",
      critical_invariants: [value],
      evidence_dispositions: [{
        id: stableDispositionId(sourceRef, "retracted"),
        kind: "critical_invariant",
        source_ref: sourceRef,
        disposition: "retracted",
        reason: "The investigation disposition was recorded on the wrong ticket.",
        actor: "codexa756",
        timestamp: "2026-10-05T19:30:00.000Z",
      }],
    },
  });
  assert.equal(report.checks.find((entry) => entry.id === "business_context_disposition").ok, false);
});

test("guided closeout accepts review findings that mention not required decisions", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/engine/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: n === 3 ? "New ADR: not required for bounded helper wiring" : "none",
      verification: "node --test coord/engine/scripts/guided-closeout.test.js",
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
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
    critical_invariants: ["decision status: not-required; no new ADR"],
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.checks.find((entry) => entry.id === "review_cycles").ok, true);
  assert.equal(report.ready, true);
  fs.rmSync(root, { recursive: true, force: true });
});

// COORD-690: the closeout gate used to PASS a requirement_closure block that was
// still, verbatim, the scaffold the engine itself wrote at `gov start`. These are
// the RED tests for that: they fail against the pre-COORD-690 splitter, which
// stripped the "TODO: " marker and then asked only whether the remainder was
// non-empty and did not itself start with "todo".
test("guided closeout FAILS on an untouched requirement_closure scaffold", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    self_review_cycles: [1, 2, 3].map((n) => ({
      lens: `lens ${n}`,
      diff: "coord/engine/scripts/guided-closeout.js",
      risks: ["risk one", "risk two"],
      findings: "none",
      verification: "node --test coord/engine/scripts/guided-closeout.test.js",
      verdict: "pass",
    })),
    repo_gates: ["node --test coord/engine/scripts/guided-closeout.test.js: pass"],
    // Byte-for-byte the block writePlanRecordScaffoldPlaceholders seeds.
    requirement_closure: [
      "TODO: Ticket ask: <what the ticket said to deliver>",
      "TODO: Implemented: <what is actually delivered in this change>",
      "TODO: Not implemented: <residual gap or none>",
      "TODO: Deferred to: <ticket-id or none>",
      "TODO: Closeout verdict: complete | incomplete",
    ],
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
    gate_plan: { selected_gates: [] },
    business_context_disposition: "not required",
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((entry) => entry.id === "requirement_closure"));
  fs.rmSync(root, { recursive: true, force: true });
});

// Removing the marker is not the same as answering the question. The gate must
// judge the VALUE, or "fixing" the scaffold becomes a search-and-replace.
test("guided closeout FAILS on scaffold values whose TODO marker was stripped", () => {
  const plan = {
    requirement_closure: [
      "Ticket ask: <what the ticket said to deliver>",
      "Implemented: <what is actually delivered in this change>",
      "Closeout verdict: complete | incomplete",
    ],
  };
  assert.deepEqual(splitRequirementClosure(plan), {});
});

// A scaffold line appended after a real one must not overwrite it: the block is
// append-only and read by recency.
test("a trailing scaffold line does not displace a real closure value", () => {
  const plan = {
    requirement_closure: [
      "Ticket ask: close the presence-not-content gap",
      "TODO: Ticket ask: <what the ticket said to deliver>",
    ],
  };
  assert.deepEqual(splitRequirementClosure(plan), {
    "ticket ask": "close the presence-not-content gap",
  });
});

// The complement of the RED tests: real closure prose — including a verdict that
// qualifies itself in free text, which the board holds several of — still passes.
test("guided closeout still accepts real closure text and a qualified verdict", () => {
  const plan = {
    requirement_closure: [
      "Ticket ask: reject scaffold placeholders at closeout",
      "Implemented: content and reachability validation in the closeout gate",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete for the gate surface; the COORD-679 census stays open",
    ],
  };
  const closure = splitRequirementClosure(plan);
  assert.equal(closure["ticket ask"], "reject scaffold placeholders at closeout");
  assert.match(closure["closeout verdict"], /^complete for the gate surface/);
});

// The feature_proof check has the same shape of hole: the scaffold's angle-bracket
// template names no file, so it is not proof of anything.
test("guided closeout FAILS on a feature proof that is still the scaffold template", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    feature_proof: [
      "path:<repo-relative-file-that-must-exist-on-canonical-branch>",
      "symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
    ],
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.ok(report.blockers.some((entry) => entry.id === "feature_proof"));
  fs.rmSync(root, { recursive: true, force: true });
});

// COORD-690 (review round 1): a proof resolved only in the ticket's dirty
// worktree must not reach review as evidence. Recording it there is legitimate
// mid-flight; carrying it into closeout is not, because the citation then points
// at bytes that exist in one uncommitted directory and nowhere else.
test("guided closeout BLOCKS a feature proof that resolved only in the working tree", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    feature_proof: ["path:coord/engine/scripts/guided-closeout.js"],
    feature_proof_refs: {
      "path:coord/engine/scripts/guided-closeout.js": { ref: "/tmp/wt", ref_kind: "worktree", sha: null },
    },
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  const check = report.checks.find((entry) => entry.id === "feature_proof_committed");
  assert.equal(check.ok, false);
  assert.match(check.command, /re-record/);
  assert.match(check.command, /worktree/);
  fs.rmSync(root, { recursive: true, force: true });
});

// "No ref was searchable" must not quietly become "verified" by surviving to
// closeout unexamined.
test("guided closeout BLOCKS a feature proof recorded as unverifiable", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify({
    ticket_id: "COORD-441",
    feature_proof: ["path:src/app.js"],
    feature_proof_refs: {
      "path:src/app.js": { ref: null, ref_kind: "unverifiable", sha: null },
    },
  }));
  const report = buildGuidedCloseoutReport({ ticketId: "COORD-441", root });
  assert.equal(report.checks.find((entry) => entry.id === "feature_proof_committed").ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a proof resolved at a committed ref passes, and a record predating the field is not penalized", () => {
  const root = tmpRoot();
  const committed = {
    ticket_id: "COORD-441",
    feature_proof: ["path:src/app.js"],
    feature_proof_refs: {
      "path:src/app.js": { ref: "agent/some-branch", ref_kind: "branch", sha: "abc123" },
    },
  };
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify(committed));
  assert.equal(
    buildGuidedCloseoutReport({ ticketId: "COORD-441", root })
      .checks.find((entry) => entry.id === "feature_proof_committed").ok,
    true
  );
  // Legacy: 1097 proofs were recorded across the board before feature_proof_refs
  // existed. The field's absence is not evidence that a proof is uncommitted.
  delete committed.feature_proof_refs;
  fs.writeFileSync(path.join(root, "coord", ".runtime", "plans", "COORD-441.json"), JSON.stringify(committed));
  assert.equal(
    buildGuidedCloseoutReport({ ticketId: "COORD-441", root })
      .checks.find((entry) => entry.id === "feature_proof_committed").ok,
    true
  );
  fs.rmSync(root, { recursive: true, force: true });
});


test("COORD-748: guided-closeout defaults stay read-only and report missing identity/state honestly", () => {
  assert.throws(() => buildGuidedCloseoutReport({}), /requires a ticket id/);
  const report = buildGuidedCloseoutReport({
    ticketId: "COORD-748",
    board: { sections: [] },
    plan: {
      requirement_closure: [
        "Ticket ask: preserve a user-authored evidence set",
        "Implemented: defaulted report construction remains read-only",
        "Closeout verdict: complete for this bounded helper",
      ],
    },
  });
  assert.equal(report.status, "unknown", "a missing board row does not invent a lifecycle status");
  const laterSection = buildGuidedCloseoutReport({
    ticketId: "COORD-748",
    board: { sections: [
      { rows: [{ ID: "COORD-001", Status: "done" }] },
      { rows: [{ ID: "COORD-748", Status: "doing" }] },
    ] },
    plan: {},
  });
  assert.equal(laterSection.status, "doing",
    "the row lookup continues past sections that do not hold the ticket instead of reporting another row's status");
  assert.equal(report.checks.find((check) => check.id === "requirement_closure").ok, true);
  assert.equal(report.checks.find((check) => check.id === "plan_record").ok, true);
  const incomplete = buildGuidedCloseoutReport({
    ticketId: "COORD-748",
    board: { sections: [] },
    plan: { requirement_closure: [
      "Ticket ask: preserve a user-authored evidence set",
      "Implemented: defaulted report construction remains read-only",
      "Closeout verdict: pending",
    ] },
  });
  assert.equal(incomplete.checks.find((check) => check.id === "requirement_closure").ok, false,
    "complete ask and implementation text still require an accepted closeout verdict");
  const absentVerdict = buildGuidedCloseoutReport({
    ticketId: "COORD-748",
    board: { sections: [] },
    plan: { requirement_closure: [
      "Ticket ask: preserve a user-authored evidence set",
      "Implemented: defaulted report construction remains read-only",
    ] },
  });
  assert.equal(absentVerdict.checks.find((check) => check.id === "requirement_closure").ok, false,
    "missing verdict is handled as an empty value and remains a blocker");
});
