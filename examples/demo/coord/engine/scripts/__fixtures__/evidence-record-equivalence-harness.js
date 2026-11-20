"use strict";
// COORD-959 equivalence harness. Replays every refusal and admission of the three evidence guards
// (repo-gate-record, gate-plan-receipt, closeout-landing-evidence) through the production surfaces:
//   repo-gate-record          gates/review-closeout.js collectClosureReadinessIssues
//   gate-plan-receipt         gate-plan.js collectGatePlanReadinessIssues
//   closeout-landing-evidence closeout.js __testing.runCloseoutPreflight, landing-gh.js mergePrUrl (gh faked)
// capture(worktreeRoot) returns the observable outcome of each case. The committed fixture is the
// capture taken on the unmodified tree before the merge; the merged tree must reproduce it exactly.
const path = require("node:path");

function capture(WT) {
  const ENGINE = path.join(WT, "coord", "engine", "scripts");
  const { createReviewCloseoutGate } = require(path.join(ENGINE, "gates", "review-closeout.js"));
  const gatePlan = require(path.join(ENGINE, "gate-plan.js"));
  const createCloseout = require(path.join(ENGINE, "closeout.js"));
  const landingGh = require(path.join(ENGINE, "landing-gh.js"));
  const normalize = (message) => String(message).replace(/lock file at \S+/, "lock file at <LOCK>");

  // ---- repo-gate-record ----
  const CLOSURE = { ticket_ask: "ask", implemented: "done", not_implemented: "none", deferred_to: "none", closeout_verdict: "complete" };
  const REPO_CASES = [
    ["product repo, repo_gates absent", true, false, undefined],
    ["product repo, repo_gates empty array", true, false, []],
    ["product repo, repo_gates blank string", true, false, [""]],
    ["product repo, repo_gates not-required (refused)", true, false, ["not-required"]],
    ["product repo, executed gate recorded (admitted)", true, false, ["node --test x.test.js"]],
    ["product repo, light lane, no gate (refused)", true, true, []],
    ["product repo, light lane, executed gate (admitted)", true, true, ["npm test"]],
    ["non-product repo, repo_gates absent (refused)", false, false, undefined],
    ["non-product repo, repo_gates empty (refused)", false, false, []],
    ["non-product repo, not-required (admitted)", false, false, ["not-required"]],
    ["non-product repo, executed gate (admitted)", false, false, ["node --test y.test.js"]],
  ];
  const reviewGate = () => createReviewCloseoutGate({
    coordDir: path.join(WT, "coord"),
    effectiveTierMinimum: (_tier, key, fallback) => (key === "min_critical_invariants" ? 0 : (key === "min_feature_proofs" ? 0 : fallback)),
    fieldHasMeaningfulValue: (value) => Array.isArray(value) ? value.some((entry) => String(entry || "").trim()) : Boolean(String(value || "").trim()),
    isMeaningfulText: (value) => typeof value === "string" && value.trim().length > 0,
    isTestingInfrastructureTicket: () => false,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => false,
    resolveTicketTier: () => ({ tier: "standard" }),
    classifyReviewLensBuckets: () => new Set(),
    normalizeReviewVerdict: (value) => value,
  });
  const repoGateRecord = REPO_CASES.map(([name, productRepo, lightLane, repoGates]) => {
    const planState = repoGates === undefined ? {} : { repo_gates: repoGates };
    const issues = reviewGate().collectClosureReadinessIssues("COORD-959", { ID: "COORD-959", Repo: "X", Type: "chore", Pri: "P2" }, planState, { metadata: {} }, {
      productRepo, requirementClosure: CLOSURE, lightLane,
    });
    return { name, issues: issues.map((issue) => ({ code: issue.code, message: issue.message, next_steps: issue.next_steps })) };
  });

  // ---- gate-plan-receipt ----
  const NOW = "2026-11-14T00:00:00.000Z";
  const FRESH = "2026-11-13T00:00:00.000Z";
  const OLD = "2026-10-01T00:00:00.000Z";
  const goodReceipt = (over = {}) => ({ planner_version: "gate-plan-v1", generated_at: FRESH, risk_class: "R1", enforcement: "warning-first",
    affected_targets: { mode: "full", selected: [] }, evidence_issues: [], ...over });
  const GATE_CASES = [
    ["no receipt, plain row (advisory, filtered)", {}, { Description: "docs tweak", Type: "chore", Pri: "P2" }, {}],
    ["no receipt, prod-risk row (blocker gate_plan_receipt)", {}, { Description: "prod deploy", Type: "chore", Pri: "P2" }, {}],
    ["no receipt, prod-risk row, light lane (no issue)", {}, { Description: "prod deploy", Type: "chore", Pri: "P2" }, { lightLane: true }],
    ["no receipt, advisory included", {}, { Description: "docs tweak", Type: "chore", Pri: "P2" }, { includeAdvisory: true }],
    ["receipt wrong planner_version (gate_plan_stale blocker)", { gate_plan: goodReceipt({ planner_version: "gate-plan-v0" }) }, { Description: "prod deploy" }, {}],
    ["receipt older than 14 days, prod-risk (gate_plan_stale blocker)", { gate_plan: goodReceipt({ generated_at: OLD }) }, { Description: "prod deploy" }, { now: NOW }],
    ["receipt older than 14 days, plain (advisory filtered)", { gate_plan: goodReceipt({ generated_at: OLD }) }, { Description: "docs" }, { now: NOW }],
    ["receipt older than 14 days, plain, advisory included", { gate_plan: goodReceipt({ generated_at: OLD }) }, { Description: "docs" }, { now: NOW, includeAdvisory: true }],
    ["receipt fresh, valid, full mode (admitted)", { gate_plan: goodReceipt() }, { Description: "docs" }, { now: NOW }],
    ["receipt slice mode without selected array (gate_plan_slice_receipt blocker)", { gate_plan: goodReceipt({ affected_targets: { mode: "slice" } }) }, { Description: "docs" }, { now: NOW }],
    ["receipt slice mode with selected array (admitted)", { gate_plan: goodReceipt({ affected_targets: { mode: "slice", selected: ["a"] } }) }, { Description: "docs" }, { now: NOW }],
    ["blocking receipt, blocker evidence issue (passthrough)", { gate_plan: goodReceipt({ enforcement: "blocking", evidence_issues: [{ code: "x_evidence", message: "missing x", severity: "blocker" }] }) }, { Description: "docs" }, { now: NOW }],
    ["blocking receipt, advisory evidence issue (filtered)", { gate_plan: goodReceipt({ enforcement: "blocking", evidence_issues: [{ code: "y_evidence", message: "soft y", severity: "advisory" }] }) }, { Description: "docs" }, { now: NOW }],
    ["warning-first receipt, R3 risk, blocker evidence (passthrough)", { gate_plan: goodReceipt({ risk_class: "R3", evidence_issues: [{ code: "z_evidence", message: "missing z", severity: "blocker" }] }) }, { Description: "docs" }, { now: NOW }],
    ["warning-first receipt, R1, blocker evidence (filtered)", { gate_plan: goodReceipt({ evidence_issues: [{ code: "w_evidence", message: "missing w", severity: "blocker" }] }) }, { Description: "docs" }, { now: NOW }],
    ["receipt array-shaped (treated as missing)", { gate_plan: [] }, { Description: "docs" }, { now: NOW }],
  ];
  const gatePlanReceipt = GATE_CASES.map(([name, planState, row, options]) => {
    const issues = gatePlan.collectGatePlanReadinessIssues("COORD-959", row, planState, options);
    return { name, issues: issues.map((issue) => ({ code: issue.code, message: issue.message, next_steps: issue.next_steps, severity: issue.severity })) };
  });

  // ---- closeout-landing-evidence: runCloseoutPreflight ----
  const SHA = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const RESOLVABLE = { [SHA.slice(0, 7)]: SHA, [SHA_B.slice(0, 7)]: SHA_B, abc1234: SHA };
  const ticket = "COORD-959";
  const closeoutWith = (extra = {}) => createCloseout({
    fail: (message) => { throw new Error(message); },
    assertReviewPlanReady: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    isRepoBackedCode: (code) => code === "B" || code === "F",
    getRepoRoot: (code) => `/fake/${code}`,
    resolveCommitishInRepo: (_root, commitish) => (RESOLVABLE[String(commitish).toLowerCase()] || null),
    ...extra,
  });
  const board = (over = {}) => ({ pr_index: { [ticket]: ["https://github.com/o/r/pull/9"] }, review_findings: {}, landing_index: {}, ...over });
  const repoRow = (over = {}) => ({ row: { ID: ticket, Repo: "B", Status: "review", Owner: "claudea805", ...over } });
  const PRE_CASES = [
    ["status not review (refused)", {}, {}, { Status: "doing" }, {}, null],
    ["no pr_index evidence (refused)", {}, { pr_index: {} }, {}, {}, null],
    ["empty pr_index list (refused)", {}, { pr_index: { [ticket]: [] } }, {}, {}, null],
    ["open review finding (refused)", {}, { review_findings: { [ticket]: [{ status: "open", id: "F1" }] } }, {}, {}, null],
    ["outstanding follow-up (refused)", { findOutstandingCloseoutBlockerFollowups: () => [{ ID: "COORD-990", Status: "todo" }] }, {}, {}, {}, null],
    ["lock present, not closeoutFromDoing (refused)", { findLockForTicket: () => ({ path: "/fake/coord/.runtime/locks/COORD-959.lock" }) }, {}, {}, {}, null],
    ["lock present, closeoutFromDoing (admitted)", { findLockForTicket: () => ({ path: "/x" }) }, {}, {}, { closeoutFromDoing: true }, null],
    ["landed unresolvable sha (refused)", {}, {}, {}, { landed: "deadbee landed by hand" }, null],
    ["landed text with no sha token (refused)", {}, {}, {}, { landed: "landed by hand, no sha" }, null],
    ["landed resolvable sha (admitted)", {}, {}, {}, { landed: `${SHA.slice(0, 7)} landed by hand` }, null],
    ["landed empty array (admitted, no check)", {}, {}, {}, { landed: [] }, null],
    ["landed multi with one resolvable (admitted)", {}, {}, {}, { landed: ["zzz", `${SHA.slice(0, 7)} ok`] }, null],
    ["sourceCommit unresolvable, product repo (refused)", {}, {}, {}, { sourceCommit: "1234567" }, null],
    ["sourceCommit resolvable (admitted, explicit)", {}, {}, {}, { sourceCommit: SHA_B.slice(0, 7) }, null],
    ["no sourceCommit, resolveSourceCommitSha supplied (admitted)", { resolveSourceCommitSha: () => SHA }, {}, {}, {}, null],
    ["no sourceCommit, no resolver (admitted, null)", {}, {}, {}, {}, null],
    ["Repo X ticket, landed refused by early return (admitted)", {}, {}, { Repo: "X" }, { landed: "nothing" }, "https://github.com/o/r/pull/9"],
    ["Repo X ticket, no resolution (admitted)", { resolveSourceCommitSha: () => SHA }, {}, { Repo: "X" }, { sourceCommit: "zzz" }, null],
    ["plan-ready fake throws (passthrough)", { assertReviewPlanReady: () => { throw new Error("plan not ready"); } }, {}, {}, {}, null],
  ];
  const runCloseoutPreflight = PRE_CASES.map(([name, cdeps, boardOver, refOver, options, commandPr]) => {
    try {
      const receipt = closeoutWith(cdeps).__testing.runCloseoutPreflight(ticket, board(boardOver), repoRow(refOver), options, commandPr);
      return { name, result: "admitted", receipt };
    } catch (error) {
      return { name, result: "refused", message: normalize(error.message) };
    }
  });

  // ---- closeout-landing-evidence: mergePrUrl (gh faked through the runGh seam) ----
  const PR_URL = "https://github.com/o/r/pull/9";
  const view = (over = {}) => ({ number: 9, url: PR_URL, state: "OPEN", mergedAt: null, headRefOid: SHA, baseRefName: "dev", mergeStateStatus: "CLEAN", ...over });
  const MERGE_CASES = [
    ["already merged at other head than qualified (refused)", view({ state: "MERGED", mergedAt: "2026-11-13T00:00:00Z", headRefOid: SHA }), { matchHeadCommit: SHA_B }],
    ["already merged at qualified head (admitted, already_merged)", view({ state: "MERGED", mergedAt: "2026-11-13T00:00:00Z", headRefOid: SHA }), { matchHeadCommit: SHA }],
    ["already merged, no matchHeadCommit (admitted, already_merged)", view({ state: "MERGED", mergedAt: "2026-11-13T00:00:00Z", headRefOid: SHA }), {}],
    ["state CLOSED (refused)", view({ state: "CLOSED" }), {}],
    ["not mergeable BEHIND (refused)", view({ mergeStateStatus: "BEHIND" }), {}],
    ["not mergeable BLOCKED (refused)", view({ mergeStateStatus: "BLOCKED" }), {}],
    ["head moved since qualified (refused)", view({ headRefOid: SHA }), { matchHeadCommit: SHA_B }],
    ["qualified head matches, CLEAN (admitted, merge issued)", view({ headRefOid: SHA }), { matchHeadCommit: SHA }],
  ];
  const mergePrUrl = MERGE_CASES.map(([name, prView, options]) => {
    const calls = [];
    let merged = false;
    landingGh.setRunGhForTesting((_cwd, args) => {
      calls.push(args.slice(0, 2).join(" "));
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify(merged ? { ...prView, state: "MERGED", mergedAt: "2026-11-14T00:00:00Z" } : prView);
      if (args[0] === "pr" && args[1] === "merge") { merged = true; return ""; }
      return "";
    });
    const realLog = console.log;
    console.log = () => {};
    try {
      const result = landingGh.mergePrUrl(PR_URL, "squash", options, WT);
      return { name, result: "admitted", value: result ? { status: result.status, pr_url: result.pr_url } : null, gh_merge_calls: calls.filter((c) => c === "pr merge").length };
    } catch (error) {
      return { name, result: "refused", message: normalize(error.message), gh_merge_calls: calls.filter((c) => c === "pr merge").length };
    } finally {
      console.log = realLog;
      landingGh.resetRunGhForTesting();
    }
  });

  return { repo_gate_record: repoGateRecord, gate_plan_receipt: gatePlanReceipt, closeout_landing_evidence: { runCloseoutPreflight, mergePrUrl } };
}

module.exports = { capture };

if (require.main === module) {
  const fs = require("node:fs");
  const [WT, OUT] = process.argv.slice(2);
  const golden = capture(WT);
  fs.writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`);
  process.stdout.write(`golden written ${OUT}: repo=${golden.repo_gate_record.length} plan=${golden.gate_plan_receipt.length} preflight=${golden.closeout_landing_evidence.runCloseoutPreflight.length} merge=${golden.closeout_landing_evidence.mergePrUrl.length}\n`);
}
