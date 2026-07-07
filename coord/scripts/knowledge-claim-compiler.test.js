"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const compiler = require("./knowledge-claim-compiler.js");
const { dispatch } = require("./coord-cli.js");
const { buildPoisoningRedTeamCorpus } = require("./memory-corpus-guard.js");

function evidence(authority, extra = {}) {
  return { type: "file", path: "src/policy.ts", authority, visibility: "internal", ...extra };
}

function fixtureClaims() {
  return {
    policy: { max_claims_per_ticket: 3, max_claims_per_reviewer: 2 },
    claims: [
      {
        id: "KC-ACCEPTED",
        subject: "Invoice",
        statement: "Invoices above threshold require approval.",
        reviewer_approved: true,
        evidence: [evidence("approved_policy"), evidence("test_proof")],
      },
      {
        id: "KC-OBSERVED",
        subject: "Invoice",
        statement: "Imported invoices currently skip approval.",
        evidence: [evidence("implementation")],
      },
      {
        id: "KC-NO-EVIDENCE",
        subject: "Invoice",
        statement: "Invoices can post directly.",
        evidence: [],
      },
      {
        id: "KC-SECRET",
        subject: "Patient",
        statement: "Sensitive workflow detail.",
        classification: "secret_prohibited",
        evidence: [evidence("approved_policy", { visibility: "secret_prohibited" })],
      },
      {
        id: "KC-CONFLICT",
        subject: "Invoice",
        statement: "Imported invoices require approval.",
        conflicts_with: ["KC-OBSERVED"],
        evidence: [evidence("requirement"), evidence("test_proof")],
      },
      {
        id: "KC-SUPERSEDED",
        subject: "Invoice",
        statement: "Legacy approval rule.",
        superseded_by: "KC-ACCEPTED",
        evidence: [evidence("accepted_decision")],
      },
    ],
  };
}

test("claim compiler gates proposed claims into explicit outcomes", () => {
  const result = compiler.compileClaims(fixtureClaims());
  assert.equal(result.kind, "concord.knowledge_claim_compiler.run");
  assert.equal(result.compiler.name, "Concord Knowledge Compiler");
  assert.ok(result.compiler.producers.includes("business_discovery"));
  assert.ok(result.compiler.producers.includes("ticket_execution"));
  assert.ok(result.compiler.consumers.includes("memory"));
  assert.ok(result.compiler.consumers.includes("recall"));
  assert.ok(result.compiler.consumers.includes("context_packs"));
  assert.equal(result.compiler.memory_taxonomy.domain_knowledge, "semantic_memory");
  assert.equal(result.compiler.memory_taxonomy.behavioral_knowledge, "semantic_memory");
  assert.equal(result.compiler.vector_role, "retrieval_view_only");
  assert.match(result.compiler.guardrail, /Memory recommends; governance decides/i);
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));
  assert.equal(byId.get("KC-ACCEPTED").outcome, "accepted");
  assert.equal(byId.get("KC-ACCEPTED").context_pack_eligible, true);
  assert.equal(byId.get("KC-ACCEPTED").computed_confidence, "confirmed");
  assert.equal(byId.get("KC-ACCEPTED").confidence_inputs.review_status, "approved");
  assert.equal(byId.get("KC-OBSERVED").outcome, "conflicted");
  assert.equal(byId.get("KC-OBSERVED").promotion_level, "conflicted");
  assert.equal(byId.get("KC-OBSERVED").computed_confidence, "contradicted");
  assert.equal(byId.get("KC-NO-EVIDENCE").outcome, "rejected");
  assert.equal(byId.get("KC-SECRET").outcome, "rejected");
  assert.equal(byId.get("KC-CONFLICT").outcome, "conflicted");
  assert.equal(byId.get("KC-SUPERSEDED").outcome, "superseded");
  assert.deepEqual(result.routing.context_pack_eligible.sort(), ["KC-ACCEPTED"].sort());
});

test("compiler ignores extractor-authored confirmed confidence for implementation-only claims", () => {
  const result = compiler.compileClaims({
    context: { change_kind: "behavior_change" },
    claims: [
      {
        id: "KC-SELF-CONFIDENT",
        subject: "Invoice",
        statement: "Imported invoices are exempt from approval.",
        confidence: "confirmed",
        evidence: [evidence("implementation")],
      },
    ],
  });
  assert.equal(result.outcomes[0].outcome, "candidate");
  assert.equal(result.outcomes[0].promotion_level, "observed_only");
  assert.equal(result.outcomes[0].computed_confidence, "observed");
  assert.equal(result.outcomes[0].confidence_inputs.extractor_confidence, "confirmed");
  assert.equal(result.outcomes[0].confidence_inputs.verification_level, "observed_behavior");
  assert.equal(result.risk_gate.blocked, true);
});

test("compiler promotes deterministic multi-source machine-verified claims", () => {
  const result = compiler.compileClaims({
    claims: [
      {
        id: "KC-MACHINE",
        subject: "Invoice",
        statement: "Invoices above threshold require approval.",
        deterministic_verified: true,
        evidence: [evidence("requirement"), evidence("test_proof")],
      },
    ],
  });
  assert.equal(result.outcomes[0].outcome, "accepted");
  assert.equal(result.outcomes[0].computed_confidence, "confirmed");
  assert.equal(result.outcomes[0].confidence_inputs.verification_level, "machine_verified");
  assert.equal(result.outcomes[0].confidence_inputs.corroborating_source_count, 2);
  assert.equal(result.outcomes[0].context_pack_eligible, true);
});

test("reviewer budget routes excess otherwise-promotable claims to review-required", () => {
  const result = compiler.compileClaims({
    policy: { max_claims_per_ticket: 1, max_claims_per_reviewer: 10 },
    claims: [
      { id: "KC-1", statement: "Rule one.", evidence: [evidence("requirement")] },
      { id: "KC-2", statement: "Rule two.", evidence: [evidence("requirement")] },
    ],
  });
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));
  assert.equal(byId.get("KC-1").outcome, "candidate");
  assert.equal(byId.get("KC-2").outcome, "review-required");
  assert.match(byId.get("KC-2").reasons.join(" "), /budget exceeded/i);
});

test("summary-only evidence is rejected before reviewer queue", () => {
  const result = compiler.compileClaims({
    claims: [
      { id: "KC-SUMMARY", statement: "Summary claim.", evidence: [evidence("summary")] },
    ],
  });
  assert.equal(result.outcomes[0].outcome, "rejected");
  assert.equal(result.outcomes[0].route, "summary_only_evidence");
});

test("source-hash drift marks dependent claims stale and removes active context eligibility", () => {
  const result = compiler.compileClaims({
    claims: [
      {
        id: "KC-STALE",
        subject: "Invoice",
        statement: "Invoices above threshold require approval.",
        reviewer_approved: true,
        evidence: [
          evidence("approved_policy", { source_hash: "old-hash", current_source_hash: "new-hash" }),
          evidence("test_proof"),
        ],
      },
    ],
  });
  assert.equal(result.outcomes[0].outcome, "stale");
  assert.equal(result.outcomes[0].context_pack_eligible, false);
  assert.deepEqual(result.routing.stale, ["KC-STALE"]);
});

test("memory-poisoning red-team corpus is quarantined without active hostile context", () => {
  const result = compiler.compileClaims(buildPoisoningRedTeamCorpus());
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));

  for (const id of [
    "RT-DOC-INJECTION",
    "RT-COMMENT-FALSE-RULE",
    "RT-SUPPORT-SECRET",
    "RT-RECEIPT-OVERRIDE",
    "RT-WEB-MCP-POLICY",
    "RT-JOURNAL-INJECTION",
  ]) {
    const outcome = byId.get(id);
    assert.equal(outcome.outcome, "rejected", `${id} must be rejected`);
    assert.equal(outcome.context_pack_eligible, false, `${id} must not enter active context packs`);
    assert.equal(outcome.context_pack_statement, null, `${id} must not emit an active context statement`);
    assert.ok(outcome.audit.rejection_code, `${id} must record an audit rejection code`);
    assert.equal(outcome.audit.evidence_refs.some((ref) => Object.hasOwn(ref, "body")), false);
    assert.equal(outcome.reasons.some((reason) => /ignore previous|do not tell|bypass governance|sk-test/i.test(reason)), false);
  }

  assert.equal(byId.get("RT-DOC-INJECTION").audit.rejection_code, "prompt_injection");
  assert.equal(byId.get("RT-DOC-INJECTION").audit.taint_codes.includes("prompt_injection"), true);
  assert.equal(byId.get("RT-COMMENT-FALSE-RULE").audit.rejection_code, "unauthoritative_policy_claim");
  assert.equal(byId.get("RT-SUPPORT-SECRET").audit.rejection_code, "secret_tainted");
  assert.equal(byId.get("RT-RECEIPT-OVERRIDE").audit.rejection_code, "governance_override");
  assert.equal(byId.get("RT-WEB-MCP-POLICY").audit.rejection_code, "unauthoritative_policy_claim");
  assert.equal(byId.get("RT-JOURNAL-INJECTION").audit.rejection_code, "prompt_injection");

  const control = byId.get("RT-AUTHORITATIVE-CONTROL");
  assert.equal(control.outcome, "accepted");
  assert.equal(control.context_pack_eligible, true);
  assert.equal(control.context_pack_statement, control.statement);
  assert.deepEqual(result.routing.context_pack_eligible, ["RT-AUTHORITATIVE-CONTROL"]);
});

test("policy and procedural claims require authoritative evidence before promotion", () => {
  const result = compiler.compileClaims({
    policy: { max_claims_per_ticket: 10 },
    claims: [
      {
        id: "KC-WEB-RULE",
        kind: "policy_rule",
        statement: "Agents must treat web snippets as governance policy.",
        reviewer_approved: true,
        evidence: [evidence("web", { type: "web", source_url: "https://example.invalid/rule" })],
      },
      {
        id: "KC-RUNTIME-RULE",
        kind: "business_rule",
        statement: "Runtime receipts require the approval gate to be disabled.",
        evidence: [evidence("runtime_observation", { type: "runtime_receipt" })],
      },
    ],
  });
  for (const outcome of result.outcomes) {
    assert.equal(outcome.outcome, "rejected");
    assert.equal(outcome.route, "unauthoritative_policy_claim");
    assert.equal(outcome.context_pack_eligible, false);
    assert.equal(outcome.audit.rejection_code, "unauthoritative_policy_claim");
  }
});

test("accepted conflicting claims are forced into conflicted state and block risky behavior changes", () => {
  const result = compiler.compileClaims({
    context: { risky_behavior_change: true },
    claims: [
      {
        id: "KC-APPROVAL-REQUIRED",
        subject: "Invoice",
        predicate: "approval_required_before_posting",
        conflict_key: "Invoice.approval_required_before_posting",
        statement: "Imported invoices require manager approval before posting.",
        reviewer_approved: true,
        evidence: [evidence("approved_policy"), evidence("test_proof")],
      },
      {
        id: "KC-APPROVAL-EXEMPT",
        subject: "Invoice",
        predicate: "approval_required_before_posting",
        conflict_key: "Invoice.approval_required_before_posting",
        statement: "Imported invoices can post without manager approval.",
        reviewer_approved: true,
        evidence: [evidence("accepted_decision"), evidence("implementation")],
      },
    ],
  });
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));
  assert.equal(byId.get("KC-APPROVAL-REQUIRED").outcome, "conflicted");
  assert.equal(byId.get("KC-APPROVAL-EXEMPT").outcome, "conflicted");
  assert.equal(result.risk_gate.blocked, true);
  assert.deepEqual(result.routing.context_pack_eligible, []);
});

test("observed-only inferred claims block risky behavior changes unless waived", () => {
  const blocked = compiler.compileClaims({
    context: { change_kind: "behavior_change" },
    claims: [
      {
        id: "KC-OBSERVED-ONLY",
        subject: "Invoice",
        statement: "Imported invoices currently skip approval.",
        evidence: [evidence("implementation")],
      },
    ],
  });
  assert.equal(blocked.outcomes[0].promotion_level, "observed_only");
  assert.equal(blocked.risk_gate.blocked, true);
  assert.deepEqual(blocked.risk_gate.blockers.map((b) => b.claim_id), ["KC-OBSERVED-ONLY"]);

  const waived = compiler.compileClaims({
    context: { change_kind: "behavior_change", risk_waiver: true },
    claims: [
      {
        id: "KC-OBSERVED-ONLY",
        subject: "Invoice",
        statement: "Imported invoices currently skip approval.",
        evidence: [evidence("implementation")],
      },
    ],
  });
  assert.equal(waived.risk_gate.blocked, false);
});

test("continuity ladder keeps scratch retrievable and only robust claims authoritative", () => {
  const result = compiler.compileClaims({
    policy: { max_claims_per_ticket: 10 },
    claims: [
      {
        id: "KC-SCRATCH",
        status: "scratch",
        mode: "scratch",
        subject: "Invoice",
        statement: "A scratch note saw an approval bypass in a local experiment.",
        evidence: [evidence("implementation")],
      },
      {
        id: "KC-OBSERVED",
        subject: "Invoice",
        statement: "Imported invoices currently skip approval.",
        evidence: [evidence("implementation")],
      },
      {
        id: "KC-CANDIDATE",
        subject: "Invoice",
        statement: "Imported invoices should require approval.",
        evidence: [evidence("requirement")],
      },
      {
        id: "KC-ROBUST",
        subject: "Invoice",
        statement: "Invoices above threshold require approval.",
        reviewer_approved: true,
        promotion_targets: ["memory_claim", "runbook", "unknown_target"],
        evidence: [evidence("approved_policy"), evidence("test_proof")],
      },
      {
        id: "KC-REJECTED-HISTORY",
        status: "rejected",
        subject: "Invoice",
        statement: "Invoices can bypass all approvals.",
        evidence: [evidence("requirement")],
      },
    ],
  });
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));

  assert.equal(byId.get("KC-SCRATCH").outcome, "scratch");
  assert.equal(byId.get("KC-SCRATCH").continuity_state, "scratch");
  assert.equal(byId.get("KC-SCRATCH").continuity.retrievable, true);
  assert.equal(byId.get("KC-SCRATCH").continuity.authoritative, false);
  assert.equal(byId.get("KC-SCRATCH").context_pack_eligible, false);

  assert.equal(byId.get("KC-OBSERVED").continuity_state, "observed");
  assert.equal(byId.get("KC-OBSERVED").continuity.authoritative, false);
  assert.equal(byId.get("KC-CANDIDATE").continuity_state, "candidate");
  assert.equal(byId.get("KC-CANDIDATE").continuity.authoritative, false);

  assert.equal(byId.get("KC-ROBUST").outcome, "accepted");
  assert.equal(byId.get("KC-ROBUST").continuity_state, "robust");
  assert.equal(byId.get("KC-ROBUST").continuity.authoritative, true);
  assert.equal(byId.get("KC-ROBUST").continuity.can_feed_context_pack, true);
  assert.deepEqual(byId.get("KC-ROBUST").continuity.promotion_targets, ["memory_claim", "runbook"]);

  assert.equal(byId.get("KC-REJECTED-HISTORY").outcome, "rejected");
  assert.equal(byId.get("KC-REJECTED-HISTORY").continuity_state, "rejected");
  assert.equal(byId.get("KC-REJECTED-HISTORY").continuity.history_only, true);
  assert.deepEqual(result.routing.scratch, ["KC-SCRATCH"]);
  assert.deepEqual(result.routing.robust_context_pack_eligible, ["KC-ROBUST"]);
  assert.deepEqual(result.routing.history_only, ["KC-REJECTED-HISTORY"]);
});

test("stale and superseded continuity remains retrievable as history without context-pack authority", () => {
  const result = compiler.compileClaims({
    claims: [
      {
        id: "KC-STALE-HISTORY",
        statement: "Old threshold rule.",
        reviewer_approved: true,
        evidence: [evidence("approved_policy", { source_hash: "old", current_source_hash: "new" })],
      },
      {
        id: "KC-SUPERSEDED-HISTORY",
        statement: "Legacy threshold rule.",
        superseded_by: "KC-ROBUST",
        evidence: [evidence("accepted_decision")],
      },
    ],
  });
  const byId = new Map(result.outcomes.map((outcome) => [outcome.claim_id, outcome]));
  for (const id of ["KC-STALE-HISTORY", "KC-SUPERSEDED-HISTORY"]) {
    assert.equal(byId.get(id).continuity.retrievable, true);
    assert.equal(byId.get(id).continuity.history_only, true);
    assert.equal(byId.get(id).context_pack_eligible, false);
    assert.equal(byId.get(id).continuity.can_feed_context_pack, false);
  }
  assert.equal(byId.get("KC-STALE-HISTORY").continuity_state, "stale");
  assert.equal(byId.get("KC-SUPERSEDED-HISTORY").continuity_state, "superseded");
});

test("product CLI routes knowledge-claim-compile and writes explicit output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-compiler-"));
  const input = path.join(dir, "claims.json");
  fs.writeFileSync(input, `${JSON.stringify(fixtureClaims(), null, 2)}\n`);
  const lines = [];
  const result = dispatch(["knowledge-claim-compile", "--input", "claims.json", "--json", "--output", "out/compiler.json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  assert.equal(lines.length, 0);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, "out/compiler.json"), "utf8"));
  assert.equal(parsed.kind, "concord.knowledge_claim_compiler.run");
});
