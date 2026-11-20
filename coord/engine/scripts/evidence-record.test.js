"use strict";
// COORD-959: evidence-record is the one check behind the retired guards repo-gate-record,
// gate-plan-receipt and closeout-landing-evidence. These tests prove (1) every refusal and
// admission of the three old guards is unchanged, against a fixture captured on the
// pre-merge tree, and (2) the must_still_cover incidents keep a regression that fails
// without the merged check.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const WT = path.resolve(__dirname, "..", "..", "..");
const ENGINE = __dirname;
const { capture } = require("./__fixtures__/evidence-record-equivalence-harness.js");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "evidence-record-equivalence.json"), "utf8"));
const evidence = require("./evidence-record.js");

test("COORD-959: the merged evidence-record check reproduces every pre-merge refusal and admission", () => {
  const live = capture(WT);
  assert.deepEqual(live.repo_gate_record, fixture.repo_gate_record, "repo-gate-record outcomes changed");
  assert.deepEqual(live.gate_plan_receipt, fixture.gate_plan_receipt, "gate-plan-receipt outcomes changed");
  assert.deepEqual(live.closeout_landing_evidence.runCloseoutPreflight, fixture.closeout_landing_evidence.runCloseoutPreflight,
    "closeout-landing-evidence preflight outcomes changed");
  assert.deepEqual(live.closeout_landing_evidence.mergePrUrl, fixture.closeout_landing_evidence.mergePrUrl,
    "closeout-landing-evidence merge outcomes changed");
});

test("COORD-058/COORD-104: a plan that records no executed gate is refused with the repo_gates code", () => {
  const product = evidence.repoGatesProductIssue("COORD-058");
  assert.equal(product.code, "repo_gates");
  assert.match(product.message, /must record actual repo gate\/test commands under "- Repo gates:" before move-review/);
  assert.deepEqual(product.next_steps, ['coord/scripts/gov update-plan COORD-058 --repo-gate "<executed gate command>"']);

  const nonProduct = evidence.repoGatesNonProductIssue("COORD-104");
  assert.equal(nonProduct.code, "repo_gates");
  assert.match(nonProduct.message, /either executed checks or "not-required" before move-review/);
  assert.deepEqual(nonProduct.next_steps, ['coord/scripts/gov update-plan COORD-104 --repo-gate "not-required"']);

  const { createReviewCloseoutGate } = require("./gates/review-closeout.js");
  const gate = createReviewCloseoutGate({
    coordDir: path.join(WT, "coord"),
    effectiveTierMinimum: (_tier, _key, fallback) => fallback,
    fieldHasMeaningfulValue: (value) => Array.isArray(value) && value.some((entry) => String(entry || "").trim()),
    isMeaningfulText: (value) => typeof value === "string" && value.trim().length > 0,
    isTestingInfrastructureTicket: () => false,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => false,
    resolveTicketTier: () => ({ tier: "standard" }),
    classifyReviewLensBuckets: () => new Set(),
    normalizeReviewVerdict: (value) => value,
  });
  const closure = { ticket_ask: "ask", implemented: "done", not_implemented: "none", deferred_to: "none", closeout_verdict: "complete" };
  const issues = gate.collectClosureReadinessIssues("COORD-058", { ID: "COORD-058", Repo: "X" }, { repo_gates: [] }, { metadata: {} }, {
    productRepo: true, requirementClosure: closure, lightLane: false,
  });
  assert.ok(issues.some((issue) => issue.code === "repo_gates"), "a plan with no executed gate is refused through the merged check");
});

test("COORD-703/COORD-830: an unmeasured merged head and unresolvable landed evidence are refused before the merge", () => {
  const landed = evidence.landedEvidenceUnresolvableMessage("COORD-703");
  assert.match(landed, /uses manual landing evidence but no resolvable commit SHA/);
  assert.match(landed, /Refusing before the merge \(COORD-703\)/);

  const merged = evidence.alreadyMergedUnmeasuredHeadMessage("https://github.com/o/r/pull/9", "a".repeat(40), "b".repeat(40));
  assert.match(merged, /already merged at head a{40}, not the reviewed head b{40}/);
  assert.match(merged, /--source-commit a{40}\./);

  const unmeasured = evidence.unmeasuredHeadMessage("https://github.com/o/r/pull/9", "", "c".repeat(40));
  assert.match(unmeasured, /head is \(unknown\), not the reviewed head c{40}/);
  assert.match(unmeasured, /re-run closeout with --source-commit <new head>\./);
});

test("COORD-058/COORD-703: the merged check is the one place these refusals are built", () => {
  const closeoutSource = fs.readFileSync(path.join(ENGINE, "closeout.js"), "utf8");
  const landingSource = fs.readFileSync(path.join(ENGINE, "landing-gh.js"), "utf8");
  assert.match(closeoutSource, /evidenceRecord\.landedEvidenceUnresolvableMessage/);
  assert.match(landingSource, /evidenceRecord\.unmeasuredHeadMessage/);
  assert.doesNotMatch(closeoutSource, /uses manual landing evidence but no resolvable commit SHA/, "the old inline message is gone");
});

test("COORD-959: the gate-plan receipt collector is one implementation, re-exported unchanged", () => {
  const gatePlan = require("./gate-plan.js");
  assert.equal(gatePlan.collectGatePlanReadinessIssues, evidence.collectGatePlanReadinessIssues);
  assert.equal(gatePlan.gatePlanIsMissingOrStale, evidence.gatePlanIsMissingOrStale);
  const issues = evidence.collectGatePlanReadinessIssues("COORD-959", { Description: "prod deploy" }, {}, {});
  assert.equal(issues[0].code, "gate_plan_receipt");
  assert.equal(issues[0].severity, "blocker");
});

test("gate-plan evidence uses the live clock and handles absent nested risk and blocking evidence", () => {
  const oldReceipt = {
    planner_version: "gate-plan-v1",
    generated_at: "2000-01-01T00:00:00.000Z",
    enforcement: "blocking",
  };
  assert.match(evidence.gatePlanIsMissingOrStale({ gate_plan: oldReceipt }).reason, /older than 14 days/);
  const advisory = evidence.collectGatePlanReadinessIssues("COORD-959", {}, { gate_plan: oldReceipt }, { includeAdvisory: true });
  assert.deepEqual(advisory.map(({ code, severity }) => [code, severity]), [["gate_plan_stale", "advisory"]]);
  const blocker = evidence.collectGatePlanReadinessIssues("COORD-959", {}, {
    gate_plan: oldReceipt,
    bootstrap_risk: { startup_work_class: "production_repair" },
  });
  assert.deepEqual(blocker.map(({ code, severity }) => [code, severity]), [["gate_plan_stale", "blocker"]]);
});
