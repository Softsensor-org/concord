"use strict";
// COORD-962 equivalence harness (fold of guard critical-invariants into requirement-closure, COORD-029).
// capture(WT) replays every critical_invariants refusal and admission through two production surfaces:
//   gate-level   gates/review-closeout.js createReviewCloseoutGate().collectClosureReadinessIssues
//                (product and non-product repo, tiers critical/standard/mechanical, light lane on and off,
//                invariants absent / empty / blank / below / at / above the minimum, repo gate on or off,
//                closure complete or incomplete)
//   caller-level governance.js __testing.collectReviewPlanReadinessIssues (the submit and closeout caller)
//                driven through plan records and a board on disk, as the token-economics suite does.
// The committed fixture is the capture taken on the unmodified origin/dev before the fold; the tree after
// the fold must reproduce it field for field.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

function capture(WT) {
  const ENGINE = path.join(WT, "coord", "engine", "scripts");
  const { createReviewCloseoutGate } = require(path.join(ENGINE, "gates", "review-closeout.js"));
  const normalize = (value) => JSON.parse(JSON.stringify(value).split(WT).join("<WT>"));
  const TIER_OF = { P0: "critical", P2: "standard", P3: "mechanical" };
  const MIN = { critical: 2, standard: 2, mechanical: 1 };
  const INVARIANT_SETS = [
    ["absent", undefined],
    ["empty array", []],
    ["blank entry", [""]],
    ["one invariant", ["the change keeps behaviour"]],
    ["two invariants", ["the change keeps behaviour", "the refusal stays"]],
    ["three invariants", ["a", "b", "c"]],
  ];
  const CLOSURE_OK = { ticket_ask: "ask", implemented: "done", not_implemented: "none", deferred_to: "none", closeout_verdict: "complete" };
  const CLOSURE_INCOMPLETE = { ...CLOSURE_OK, closeout_verdict: "incomplete" };
  const gate = createReviewCloseoutGate({
    coordDir: path.join(WT, "coord"),
    effectiveTierMinimum: (tier, key, fallback) => (key === "min_critical_invariants" ? MIN[tier] ?? fallback : (key === "min_feature_proofs" ? 0 : fallback)),
    fieldHasMeaningfulValue: (value) => Array.isArray(value) ? value.some((entry) => String(entry || "").trim()) : Boolean(String(value || "").trim()),
    isMeaningfulText: (value) => typeof value === "string" && value.trim().length > 0,
    isTestingInfrastructureTicket: () => false,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => false,
    resolveTicketTier: (row) => ({ tier: TIER_OF[row.Pri] }),
    classifyReviewLensBuckets: () => new Set(),
    normalizeReviewVerdict: (value) => value,
  });
  const gateCases = [];
  for (const productRepo of [true, false]) {
    for (const lightLane of [false, true]) {
      for (const pri of ["P0", "P2", "P3"]) {
        for (const [invName, invariants] of INVARIANT_SETS) {
          for (const repoGates of [undefined, ["npm test"], ["not-required"]]) {
            for (const [closeName, closure] of [["closure complete", CLOSURE_OK], ["closure incomplete", CLOSURE_INCOMPLETE]]) {
              const name = `gate: product=${productRepo} light=${lightLane} pri=${pri} invariants=${invName} repoGates=${repoGates === undefined ? "absent" : repoGates.join("|")} ${closeName}`;
              const planState = {};
              if (invariants !== undefined) planState.critical_invariants = invariants;
              if (repoGates !== undefined) planState.repo_gates = repoGates;
              const row = { ID: "COORD-962", Repo: productRepo ? "B" : "X", Type: "chore", Pri: pri };
              const issues = gate.collectClosureReadinessIssues("COORD-962", row, planState, { metadata: {} }, {
                productRepo, requirementClosure: closure, lightLane,
              });
              gateCases.push({ name, issues: normalize(issues.map((issue) => ({ code: issue.code, message: issue.message, next_steps: issue.next_steps }))) });
            }
          }
        }
      }
    }
  }

  // caller-level: the production readiness caller with plan records and a board on disk.
  const governance = require(path.join(ENGINE, "governance.js"));
  const { withScopedGovernanceTestContext } = require(path.join(WT, "coord", "scripts", "governance-test-utils.js"));
  const callerCases = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord962-golden-"));
  try {
    const recordsDir = path.join(root, "plans");
    fs.mkdirSync(recordsDir, { recursive: true });
    const boardPath = path.join(root, "tasks.json");
    const planPath = path.join(root, "PLAN.md");
    fs.writeFileSync(planPath, "", "utf8");
    fs.writeFileSync(boardPath, JSON.stringify({ version: 1, sections: [], review_findings: {}, pr_index: {}, landing_index: {} }, null, 2), "utf8");
    const lensCycles = [
      "lens=contract/state invariants; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
      "lens=auth/security/failure modes; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
    ];
    const seed = (ticketId, planExtra) => fs.writeFileSync(path.join(recordsDir, `${ticketId}.json`), JSON.stringify({
      schema_version: 1, ticket_id: ticketId, markdown_heading: `## ${ticketId}`,
      startup_checklist: ["completed"], traceability_gate: ["verified"], review_round: 1,
      baseline_reproduction: ["Command: npm test", "Outcome: reproduced"], prior_findings: [],
      intended_files: ["services/x.js"], change_summary: ["change"],
      verification_commands: ["npm test"],
      requirement_closure: ["Ticket ask: x", "Implemented: x", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      repo_gates: ["npm test"],
      self_review_cycles: lensCycles.map((raw, i) => ({ cycle: i + 1, total: lensCycles.length, raw, lens: raw.match(/lens=([^;]+)/)[1], diff: "d", risks: ["a", "b"], findings: "none", verification: "npm test", verdict: "pass" })),
      rollback_strategy: ["revert"], security_surface: "no", synced_from_markdown_at: "2026-06-10T00:00:00.000Z",
      ...planExtra,
    }, null, 2), "utf8");
    const callerInvariantSets = INVARIANT_SETS.map(([n, v]) => [n, v]);
    let callerSeq = 0;
    for (const [repoCode, productLabel] of [["B", "product"], ["X", "non-product"]]) {
      for (const pri of ["P0", "P2", "P3"]) {
        for (const [invName, invariants] of callerInvariantSets) {
          for (const [closeName, verdict] of [["complete", "complete"], ["incomplete", "incomplete"]]) {
            const ticketId = `GOLD-${String(++callerSeq).padStart(4, "0")}`;
            const extra = { requirement_closure: ["Ticket ask: x", "Implemented: x", "Not implemented: none", "Deferred to: none", `Closeout verdict: ${verdict}`] };
            if (invariants !== undefined) extra.critical_invariants = invariants;
            seed(ticketId, extra);
            const row = { ID: ticketId, Repo: repoCode, Type: "feature", Pri: pri };
            withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
              let issues;
              try {
                issues = governance.__testing.collectReviewPlanReadinessIssues(ticketId, row);
              } catch (error) {
                issues = [{ code: "THREW", message: String(error && error.message) }];
              }
              callerCases.push({ name: `caller: ${productLabel} repo=${repoCode} pri=${pri} invariants=${invName} ${closeName} (${ticketId})`, issues: normalize(issues.map((issue) => ({ code: issue.code, message: issue.message, next_steps: issue.next_steps }))) });
            });
          }
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { gate: gateCases, caller: callerCases };
}

module.exports = { capture };
if (require.main === module) {
  const WT = process.argv[2];
  process.stdout.write(JSON.stringify(capture(WT), null, 1) + "\n");
}
