"use strict";

const { execFileSync } = require("node:child_process");
const { resolveIntegrationBaseRef } = require("./integration-base-ref.js");
const { resolvePlanEvidence } = require("./plan-evidence-supersession.js");

// COORD-977: the submission diff decides whether the reuse lens applies. A ticket
// adds a reusable surface when its diff adds a non-test code module (new file), a
// helper (a new function declaration in non-test code), or a guard (a new
// `// guard:<id>` marker, or a new `"id"` entry in governance-guards.json).
// Existing code is not scanned; only added lines of the diff count.
const TEST_FILE_PATTERN = /\.test\.(?:m?js|cjs)$/;
const CODE_FILE_PATTERN = /\.(?:m?js|cjs)$/;
const GUARD_REGISTRY_FILE = "coord/engine/governance-guards.json";

function detectAddedReusableSurface(root, base) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // A worktree that cannot be read is a failure (the caller records it and blocks).
  if (!require("node:fs").existsSync(root)) throw new Error(`worktree ${root} does not exist`);
  // COORD-977 fail closed: the base resolves through the shared COORD-898 resolver
  // (origin/<base>, else local <base>). When neither exists the surface cannot be
  // measured, so the caller blocks with reuse_review_base_unresolved and the fetch remedy.
  let resolved;
  try {
    resolved = resolveIntegrationBaseRef(root, base);
  } catch (error) {
    const unresolved = new Error(error.message);
    unresolved.code = "reuse_review_base_unresolved";
    throw unresolved;
  }
  const range = `${resolved.ref}...HEAD`;
  const modules = git(["diff", "--name-only", "--diff-filter=A", "--no-color", range, "--"])
    .split("\n")
    .filter((file) => CODE_FILE_PATTERN.test(file) && !TEST_FILE_PATTERN.test(file));
  const guards = new Set();
  const helpers = new Set();
  let currentFile = null;
  for (const line of git(["diff", "-U0", "--no-color", range, "--"]).split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = line.startsWith("+++ b/") ? line.slice(6) : null;
      continue;
    }
    if (!line.startsWith("+") || !currentFile) continue;
    const text = line.slice(1);
    const marker = text.match(/\/\/\s*guard:([a-z0-9][a-z0-9-]*)/);
    if (marker) guards.add(marker[1]);
    if (currentFile === GUARD_REGISTRY_FILE) {
      const entry = text.match(/^\s*"id"\s*:\s*"([^"]+)"/);
      if (entry) guards.add(entry[1]);
      continue;
    }
    if (!CODE_FILE_PATTERN.test(currentFile) || TEST_FILE_PATTERN.test(currentFile)) continue;
    const helper = text.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (helper) helpers.add(helper[1]);
  }
  return {
    modules: [...new Set(modules)].sort(),
    guards: [...guards].sort(),
    helpers: [...helpers].sort(),
  };
}

function createReviewPlanReadiness(deps) {
  const {
    buildBootstrapViaLiveMcpLifecycle,
    buildLiveMcpLifecycle,
    buildReviewCycleSnapshots,
    collectBoundedRepairEligibilityIssues,
    collectClosureReadinessIssues,
    collectDecompositionProofIssues,
    collectGatePlanReadinessIssues,
    collectSelfReviewCycleIssues,
    COORD_DIR,
    formatGovernanceBlockers,
    getRepoRoot,
    GovernanceError,
    inferRequiredReviewRound,
    integerOrDefault,
    isRepoBackedCode,
    normalizeGovernancePlanShape,
    parseRequirementClosureEntries,
    readBoard,
    readLatestPlanBlock,
    readPlanRecord,
    readPlanState,
    resolveTicketGitContext,
    resolveTicketLightLane,
    reviewGateRegistry,
    state,
  } = deps;

  // COORD-924: a recorded selected-suite repo gate must still hold at the
  // reviewed head (finalize, land, closeout) or the workspace HEAD (move-review):
  // same tree, same policy, and a selection the governed state still accepts.
  function selectionEvidenceIssues(ticketId, row, repoGates, sourceCommit) {
    if (!repoGates.some((entry) => String(entry).startsWith("affected-selection run "))) return [];
    const landing = require(require("../../paths.js").resolveEngineModule(COORD_DIR, "scripts/affected-landing.js"));
    const context = resolveTicketGitContext ? resolveTicketGitContext(row, ticketId) || {} : {};
    const root = context.worktree || context.repoRoot || require("node:path").dirname(COORD_DIR);
    return landing.recheckSelectionEntries({ ticketId, repoGates, root, head: sourceCommit || "HEAD", boardPath: state?.BOARD_PATH });
  }

  // COORD-830: context.sourceCommit is the reviewed source commit a closeout
  // verb was handed; the decomposition-proof gate measures at it once the lock
  // is released, and only when context.resolveReviewedSource (durable PR or
  // landing provenance) names that exact commit.
  // guard:review-plan-blockers
  function collectReviewPlanReadinessIssues(ticketId, row, context = {}) {
    const block = readLatestPlanBlock(ticketId);
    const canonicalPlanRecord = readPlanRecord(ticketId, { allowMissing: true });
    const planState = canonicalPlanRecord || readPlanState(ticketId);
    const board = readBoard();
    if (!planState) {
      return [{
        code: "missing_plan_state",
        message: `Plan state missing for ${ticketId}. Canonical review evidence must exist before moving to review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --summary "<change summary>"`,
        ],
      }];
    }

    const issues = [];
    // COORD-977: the reuse surface comes from the caller when given (fixtures), else
    // from the ticket's own worktree diff against the board branch. No worktree means
    // no submission diff to inspect, so no reuse cycle is required.
    const reuseBase = board.metadata?.boardBranch || "dev";
    const reuseSurface = { addedSurface: context.addedSurface || null, surfaceError: null, surfaceCode: null, surfaceBase: reuseBase };
    if (!reuseSurface.addedSurface) {
      const gitContext = resolveTicketGitContext ? resolveTicketGitContext(row, ticketId) || {} : {};
      if (gitContext.worktree) {
        try {
          reuseSurface.addedSurface = detectAddedReusableSurface(gitContext.worktree, reuseBase);
        } catch (error) {
          reuseSurface.surfaceError = error.message;
          reuseSurface.surfaceCode = error.code || null;
        }
      }
    }
    const findings = board.review_findings?.[ticketId] || [];
    const requiredRound = inferRequiredReviewRound(findings);
    const planRound = integerOrDefault(planState.review_round, 0);
    if (planRound !== requiredRound) {
      issues.push({
        // guard:review-round
        code: "review_round",
        // COORD-649: when the REQUIRED round is ABOVE the plan round, no writer an
        // agent can reach produces it — `review_round` is written only by the
        // return-doing transition, which this very check blocks. That state means
        // a finding is filed under a round the ticket never reached, so the
        // message names the governed repair instead of leaving the caller in a
        // closed loop. The repair is appended to the existing message to keep
        // the blocker contract stable.
        message: `Plan state for ${ticketId} must record "- Review round:" as ${requiredRound} before move-review. Fresh review evidence is required for the current repair round.${requiredRound > planRound ? " A required round ABOVE the plan round means a finding is classified under a round " + ticketId + " never reached, and only return-doing writes review_round. Repair the classification with: coord/scripts/gov correct-finding-round " + ticketId + " --id <finding-id> --round " + (planRound || 1) + ' --human-admin-override "<why the finding was misclassified>"' : ""}`,
        next_steps: [`coord/scripts/gov explain ${ticketId}`],
      });
    }

    // Both readPlanRecord and readPlanState return validated, normalized list fields.
    const activeEvidence = resolvePlanEvidence(planState);
    // The gates below each re-resolve the state they are handed. The projected
    // lists no longer hold the corrected entries, so BOTH correction ledgers are
    // cleared with them; a ledger left behind would point at entries the
    // projection removed and make every gate throw.
    const effectivePlanState = { ...planState, ...activeEvidence, evidence_supersessions: [], evidence_dispositions: [] };
    const requirementClosure = parseRequirementClosureEntries(planState.requirement_closure);
    const repoGates = activeEvidence.repo_gates;
    const governance = normalizeGovernancePlanShape(planState.governance, row.Repo);
    const productRepo = isRepoBackedCode(row.Repo);
    // COORD-166: light-lane decision (docs/chore reference-doc tickets). Relaxes
    // PLAN COMPLETENESS only (feature-proof, full requirement_closure verdict, the
    // full self-review cycle ceremony); never weakens attribution, the bound-owner
    // guard, repo-gates, or the minimum-one structured self-review cycle.
    const lightLane = resolveTicketLightLane(ticketId, row, planState).eligible;
    issues.push(...collectGatePlanReadinessIssues(ticketId, row, effectivePlanState, { lightLane }), ...collectDecompositionProofIssues({
      ticketId, row, planState: effectivePlanState, coordDir: COORD_DIR,
      // COORD-826: measure the proof inside the ticket's locked worktree when one exists.
      locksDir: state?.LOCKS_DIR, repoRoot: productRepo ? getRepoRoot(row.Repo) : COORD_DIR,
      sourceCommit: context.sourceCommit, resolveReviewedSource: context.resolveReviewedSource,
    }));
    const boundedRepairRequested = productRepo && governance.review_profile === "bounded_repair";
    const boundedRepairEligibilityIssues = boundedRepairRequested
      ? collectBoundedRepairEligibilityIssues(effectivePlanState, requirementClosure)
      : [];
    if (boundedRepairEligibilityIssues.length > 0) {
      issues.push({
        // guard:bounded-repair-eligibility
        code: "bounded_repair_ineligible",
        message: `Plan state for ${ticketId} cannot use governance review_profile=bounded_repair until ticket-local repair constraints are satisfied: ${boundedRepairEligibilityIssues.join("; ")}.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --review-profile standard`,
          `coord/scripts/gov update-plan ${ticketId} --files "<narrow repo-relative path>" --verify "<direct regression command>" --repo-gate "<executed gate command>" --closure "Not implemented: none" --closure "Deferred to: none"`,
        ],
      });
    }
    issues.push(
      ...collectClosureReadinessIssues(ticketId, row, effectivePlanState, board, {
        productRepo,
        requirementClosure,
        repoGates,
        lightLane,
      }),
      ...selectionEvidenceIssues(ticketId, row, repoGates, context.sourceCommit),
    );

    const cycles = buildReviewCycleSnapshots(planState, canonicalPlanRecord, block);
    issues.push(
      ...collectSelfReviewCycleIssues(ticketId, row, cycles, {
        productRepo,
        boundedRepairRequested,
        boundedRepairEligibilityIssues,
        lightLane,
      })
    );
    issues.push(...reviewGateRegistry.run("review", { ticketId, row, planState: effectivePlanState, board, cycles, ...reuseSurface }));
    // COORD-153: live-MCP lifecycle enforcement. Scoped STRICTLY to tickets that
    // DECLARE a live-mcp operation (planState.live_mcp present); for every other
    // ticket buildLiveMcpLifecycle returns no issues, so normal/existing tickets
    // are completely unaffected. When declared, missing required evidence
    // (operation class, adapter, environment, scope, approval/redaction/cleanup
    // per the operation-class policy, a recorded receipt, and promotion for
    // product-impacting findings) BLOCKS move-review/closeout.
    issues.push(...buildLiveMcpLifecycle({ planState }).issues);
    // COORD-164: bootstrap-via-live-mcp coverage blocker. Fires ONLY when the plan
    // declares BOTH live_mcp AND bootstrap_risk (the explicit "this bootstrap job
    // ran as a live-MCP operation" signal). It does NOT re-check cleanup/redaction
    // — those stay with buildLiveMcpLifecycle above on the same live_mcp object;
    // this adds only the bootstrap-coverage requirement. Normal tickets,
    // bootstrap-only tickets, and live-mcp-only tickets all get zero issues here.
    issues.push(...buildBootstrapViaLiveMcpLifecycle({ planState }).issues);
    return issues;
  }

  // guard:review-plan-blockers
  function assertReviewPlanReady(ticketId, row, context = {}) {
    const issues = collectReviewPlanReadinessIssues(ticketId, row, context);
    if (issues.length > 0) {
      throw new GovernanceError(formatGovernanceBlockers(ticketId, issues, "Review-plan blockers for"));
    }
  }

  return { collectReviewPlanReadinessIssues, assertReviewPlanReady };
}

module.exports = { createReviewPlanReadiness, detectAddedReusableSurface };
