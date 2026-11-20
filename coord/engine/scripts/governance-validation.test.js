const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  runGit,
  writeRepoFile,
  createTempGitRepo,
  createTempGitRepoWithOrigin,
  withScopedGovernanceTestContext,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { state, DEFAULT_PATHS } = require("./governance-context.js");
const { resolveEngineModule } = require("../../paths.js");
const { createGovernanceReadiness } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/governance-readiness.js"));
const { STATUS } = require("./governance-constants.js");
const { createReadinessGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/readiness.js"));
const createPromptCoverage = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/prompt-coverage.js"));
const { createReviewCloseoutGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/review-closeout.js"));
const {
  advanceCadenceCursor,
  buildContinuityReadOnlyReadout,
  computeContinuityGenerationHash,
  mergeAppendOnlyContinuityRecords,
  validateContinuityFreshRead,
} = require("./governance-context.js");
const { countLoc } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));
const createGovernanceValidation = require("./governance-validation.js");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const { integerOrDefault, toArray, escapeRegex } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const createTestingInfraPaths = require("./testing-infra-paths.js");
const { parseFeatureProofEntry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-resolution.js"));
const { createFeatureProofNormalization } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-audit.js"));
const { createFeatureProofEntryValidator } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-entry-validation.js"));
const createPlanRecords = require("./plan-records.js");
const planRecordOwner = createPlanRecords();
const { evidenceRef, stableSupersessionId, applySupersession, applyInvariantRetraction, resolvePlanEvidence } = require("./plan-evidence-supersession.js");

// COORD-098 (governance.test residual split, slice 3): validation / readiness
// behavior. Every subject here is DEFINED in governance-validation.js — the
// module that owns readiness evaluation and closeout/landing validation rules:
//   - deriveGovernanceReadiness / collectStartReadinessBlockers / evaluateReadiness
//   - collectReviewPlanReadinessIssues / assertReviewPlanReady / submitRequiresReviewPlanCheck
//   - deriveTestingInfrastructureAudit / deriveFeatureProofAudit / validateFeatureProofEntry
//   - assertAlreadyLandedNoPrReconcileReady / assertLandingIntegrity / classifyLandingRecord
//   - detectSupersedeLandingBypass
//   - replaceSelfReviewCycles / inferRequiredReviewRound (self-review-cycle helpers)
// Landing-side neighbors stay in their owning suites: landing-resolution.test.js
// keeps commit/base-ref resolution, landing-audit.test.js keeps audit/report
// writers, and lifecycle-owned validation (assertCommittedReviewState,
// appendReviewFollowupPlan, ensurePlanStub) plus the cross-module facade cases
// remain in governance.test.js.
//
// Hermetic session env: strip any ambient provider id the host injects (e.g.
// Claude Code exports CLAUDE_CODE_SESSION_ID) so it cannot leak into readiness
// fixtures that control identity explicitly.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

// COORD-071: feature-proof normalization infers a ticket's repo from its id
// prefix (project.config.js `ticketPrefixes`). The proof-normalization test
// below passes no board/row context, so its ticket id must use a prefix that
// maps to repo B under whichever config-matrix leg is running (default "MSRV",
// non-default "API"). Derive a B-mapped prefix from the active registry.
const B_TICKET_PREFIX =
  Object.entries(DEFAULT_PATHS.ticketPrefixToRepoCode || {}).find(([, code]) => code === "B")?.[0] || "MSRV";
const testingInfraPathsOwner = createTestingInfraPaths({
  normalizeTestingInfraAuditPath: (value) => value,
  toArray,
});
const validationLeaf = createGovernanceValidation({
  GovernanceError,
  escapeRegex,
  integerOrDefault,
  toArray,
  splitPlanPathValues: testingInfraPathsOwner.splitPlanPathValues,
});
const featureProofEntryOwner = createFeatureProofEntryValidator({
  fail: (message) => { throw new GovernanceError(message); },
});
const featureProofNormalizationOwner = createFeatureProofNormalization({
  parseFeatureProofEntry,
  resolveRepoCodeForTicket: (ticketId, row) => row?.Repo || repoRegistryOwner.inferRepoCodeFromTicketId(ticketId),
  repoPrefixesForCode: repoRegistryOwner.repoPrefixesForCode,
});

test("continuity cursor advancement uses compare-and-swap to reject stale concurrent writers", () => {
  const baseCadence = {
    id: "cadence.validation.weekly",
    owner: "ops",
    cursor: { type: "hash", value: "export:a" },
  };
  const observedHash = computeContinuityGenerationHash(baseCadence.cursor);
  const writerA = advanceCadenceCursor(
    baseCadence,
    { type: "hash", value: "export:b", evidence_ref: "journal:a" },
    { expected_cursor_hash: observedHash, advancedAtUtc: "2026-06-27T12:00:00.000Z" }
  );

  assert.equal(writerA.previous_cursor_hash, observedHash);
  assert.equal(writerA.cursor.value, "export:b");
  assert.throws(
    () => advanceCadenceCursor(
      writerA,
      { type: "hash", value: "export:c", evidence_ref: "journal:b" },
      { expected_cursor_hash: observedHash, advancedAtUtc: "2026-06-27T12:01:00.000Z" }
    ),
    /Stale cadence cursor.*Re-read the cadence cursor/
  );
});

test("continuity append-only merge allows independent appends and rejects record rewrites", () => {
  const existing = [
    { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["read current cursor"] },
  ];
  const merged = mergeAppendOnlyContinuityRecords(existing, [
    { id: "journal.2026-06-27.002", kind: "daily_journal", observations: ["new note"] },
    { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["read current cursor"] },
  ]);

  assert.deepEqual(merged.appended, ["journal.2026-06-27.002"]);
  assert.equal(merged.merged.length, 2);
  assert.equal(existing[0].record_hash, undefined);
  assert.throws(
    () => mergeAppendOnlyContinuityRecords(existing, [
      { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["rewritten note"] },
    ]),
    /append-only continuity conflict/
  );
});

test("continuity stale context checks fail with re-read guidance before cold-finish", () => {
  const observed = [
    { id: "context-pack:COORD-340", hash: "sha256:old" },
  ];
  const current = [
    { id: "context-pack:COORD-340", hash: "sha256:new" },
  ];
  const report = validateContinuityFreshRead(observed, current);

  assert.equal(report.ok, false);
  assert.match(report.guidance.join(" "), /Re-read the listed context-pack/);

  const validation = createGovernanceValidation({ GovernanceError });
  const issues = validation.collectContinuityWriteSafetyIssues({
    fresh_read: { observed, current },
  });
  assert.equal(issues[0].code, "continuity_stale_reread_required");
  assert.match(issues[0].next_steps.join(" "), /Regenerate the derived continuity readout/);
});

test("continuity derived-view generation hashes change without corrupting governance journal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-derived-journal-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  const originalJournal = JSON.stringify({ event: "prior", ticket: "COORD-340" }) + "\n";
  fs.writeFileSync(journalPath, originalJournal, "utf8");

  const firstInput = {
    ticket: { ID: "COORD-340" },
    warm_start_records: [{ id: "warm.COORD-340", source_refs: ["coord/scripts/gov explain COORD-340"] }],
    cold_finish_records: [{ id: "finish.COORD-340", evidence_refs: ["test:pending"] }],
    cadences: [{ id: "cadence.safe", cursor: { type: "hash", value: "a" }, freshness_policy: { status: "fresh" } }],
  };
  const secondInput = {
    ...firstInput,
    cadences: [{ id: "cadence.safe", cursor: { type: "hash", value: "b" }, freshness_policy: { status: "fresh" } }],
  };
  const first = buildContinuityReadOnlyReadout(firstInput, { generatedAtUtc: "2026-06-27T12:00:00.000Z" });
  const second = buildContinuityReadOnlyReadout(secondInput, { generatedAtUtc: "2026-06-27T12:00:00.000Z" });

  assert.notEqual(first.input_generation_hash, second.input_generation_hash);
  assert.notEqual(first.generation_hash, second.generation_hash);
  assert.equal(fs.readFileSync(journalPath, "utf8"), originalJournal);

  const validation = createGovernanceValidation({ GovernanceError });
  const issues = validation.collectContinuityWriteSafetyIssues({
    derived_view: {
      expected_input_generation_hash: first.input_generation_hash,
      current_inputs: secondInput,
    },
  });
  assert.equal(issues[0].code, "continuity_derived_view_stale");
  assert.match(issues[0].next_steps.join(" "), /Do not append derived readout output to the governance journal/);
});

test("COORD-653 coverage: dependency, review, closure, and continuity helpers report their public results", () => {
  const validation = createGovernanceValidation({
    GovernanceError,
    allowsFollowupDependencyReadinessException: () => false,
  });
  const unknownDependency = __testing.evaluateReadiness(
    { ID: "T-1", "Depends On": "MISSING" },
    new Map(),
    { followup_exceptions: {} },
  );
  const completedDependencyTrace = validation.traceDependencyReadiness(
    { ID: "T-1" },
    "DONE-1",
    new Map([["DONE-1", { ID: "DONE-1", Status: STATUS.DONE }]]),
    { followup_exceptions: {} },
    ["T-1"],
  );
  assert.deepEqual(completedDependencyTrace, {
    blocked: false,
    blockerChains: [],
    cycles: [],
    transitiveBlockedBy: [],
  });
  assert.deepEqual(unknownDependency, {
    deps: ["MISSING"],
    blockerChains: [],
    blockedBy: [],
    cycles: [],
    transitiveBlockedBy: [],
    ready: true,
  });
  assert.equal(validation.formatDependencyCycleList([["A", "B", "A"], ["A", "B", "A"], [], ["  ", "C"]]), "A -> B -> A; C");
  assert.equal(validation.formatTransitiveBlockerDetails([["A"], ["A", "B"], ["A", "B"], ["B", "C"]]), "A -> B; B -> C");

  assert.equal(validation.normalizeReviewVerdict(null), null);
  assert.equal(validation.normalizeReviewVerdict("  PASS after review  "), "pass");
  assert.equal(validation.normalizeReviewVerdict("FAIL: missing evidence"), "fail: missing evidence");
  assert.equal(validation.normalizeReviewVerdict("pending"), null);
  assert.deepEqual(validation.parseRequirementClosureEntries([
    null,
    "",
    "  Ticket ask: reconcile totals  ",
    "Implemented: exact fix",
    "Not implemented: none",
    "Deferred to: FE-2",
    "Closeout verdict: PASS",
    "Other: ignored",
  ]), {
    ticket_ask: "reconcile totals",
    implemented: "exact fix",
    not_implemented: "none",
    deferred_to: "FE-2",
    closeout_verdict: "pass",
  });
  assert.deepEqual(validation.parseRequirementClosureEntries(undefined), {
    ticket_ask: null,
    implemented: null,
    not_implemented: null,
    deferred_to: null,
    closeout_verdict: null,
  });

  const conflict = {
    append_only: {
      existing: [{ id: "j-1", text: "old" }],
      incoming: [{ id: "j-1", text: "rewritten" }],
    },
  };
  assert.deepEqual(validation.collectContinuityWriteSafetyIssues({
    append_only: { existing: [{ id: "j-1", text: "old" }], incoming: [{ id: "j-2", text: "new" }] },
  }), []);
  const conflictIssues = validation.collectContinuityWriteSafetyIssues(conflict);
  assert.equal(conflictIssues.length, 1);
  assert.equal(conflictIssues[0].code, "continuity_append_only_conflict");
  assert.match(conflictIssues[0].message, /append-only continuity conflict for j-1/);
  assert.deepEqual(conflictIssues[0].next_steps, [
    "coord/scripts/gov recent --limit 20 --full",
    "Append a new superseding record instead of rewriting an existing record id.",
    "Retry through the governed single-writer mutation path.",
  ]);
  const emptyHash = computeContinuityGenerationHash({});
  assert.deepEqual(validation.collectContinuityWriteSafetyIssues({
    derived_view: { expectedInputGenerationHash: emptyHash },
  }), []);
  assert.deepEqual(validation.collectContinuityWriteSafetyIssues({
    derived_view: { expected_input_generation_hash: "same", currentInputGenerationHash: "same" },
  }), []);
  assert.equal(validation.assertContinuityWriteSafe({}), undefined);
  assert.throws(
    () => validation.assertContinuityWriteSafe(conflict),
    (error) => error instanceof GovernanceError &&
      /Continuity write-safety blockers for continuity:/.test(error.message) &&
      /Retry through the governed single-writer mutation path/.test(error.message),
  );
});

test("COORD-653 review readiness blocks absent closure and repo gates and stale review rounds", () => {
  const cases = [
    { name: "plan round ahead of required round", planRound: 2, findings: [], repairRound: null },
    { name: "absent round defaults to zero", planRound: null, findings: [], repairRound: "--round 1" },
    { name: "required round ahead of plan", planRound: 1, findings: [{ round: 2 }], repairRound: "--round 1" },
  ];
  for (const [index, scenario] of cases.entries()) {
    const ticketId = `${B_TICKET_PREFIX}-${965 + index}`;
    const record = lightLaneDocsRecord(ticketId, ["src/service.ts"], {
      review_round: scenario.planRound,
      critical_invariants: ["Existing service authorization remains unchanged."],
      feature_proof: ["path:src/service.ts"],
      self_review_cycles: [LIGHT_LANE_VALID_CYCLE],
    });
    delete record.requirement_closure;
    delete record.repo_gates;
    const issues = withGovernanceFixturePaths({
      prefix: `coord653-review-readiness-${index}`,
      ticketId,
      review_findings: { [ticketId]: scenario.findings },
      record,
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "B",
      Type: "bug",
      Description: "Preserve internal service behavior.",
    }));
    const codes = issues.map((issue) => issue.code);
    assert.ok(codes.includes("review_round"), `${scenario.name} must block; got ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("requirement_closure"), `missing requirement closure must block; got ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("repo_gates"), `missing repository gates must block; got ${JSON.stringify(codes)}`);
    const message = issues.find((issue) => issue.code === "review_round").message;
    if (scenario.repairRound) {
      assert.match(message, new RegExp(`correct-finding-round ${ticketId} .*${scenario.repairRound.replaceAll(" ", "\\s+")}`));
    } else {
      assert.doesNotMatch(message, /correct-finding-round/);
    }
  }
});

test("COORD-653: repair-question readiness follows resolved QUESTIONS truth, independent of repair entry flags", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-repair-question-"));
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  try {
    withScopedGovernanceTestContext({ QUESTIONS_PATH: questionsPath }, () => {
  const planState = {
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    repo_gates: ["pnpm test"],
    feature_proof: ["path:frontend/file.tsx"],
    governance: {
      expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [
        { kind: "return_doing", required_question_logged: false, note: "legacy unrelated repair entry" },
        { kind: "recover", required_question_logged: false, note: "legacy repair entry" },
      ],
    },
  };
  const derive = () => __testing.deriveGovernanceReadiness(
    "FE-999",
    { ID: "FE-999", Repo: "F", Type: "bug", Description: "test ticket" },
    { metadata: {}, sections: [] },
    null,
    planState,
    { required: false }
  );
    fs.writeFileSync(questionsPath, "# Questions\n| 2026-01-01 | owner | orchestrator | FE-999 governance issue resolved: repaired | evidence | yes |\n");
    assert.equal(derive().closeout.repair_ticket_local, true);
    assert.equal(derive().closeout.repair_question_logged, true, "a resolved question must override stale false flags across unrelated repair entries");

    fs.writeFileSync(questionsPath, "# Questions\n| 2026-01-01 | owner | orchestrator | FE-999 governance issue resolved: repaired | pending | no |\n");
    assert.equal(derive().closeout.repair_question_logged, false, "an unresolved question is not completion evidence");

    fs.writeFileSync(questionsPath, "# Questions\n");
    assert.equal(derive().closeout.repair_question_logged, false, "repair history without a matching resolved question remains incomplete");

    planState.governance.ticket_local_repairs = [];
    assert.equal(derive().closeout.repair_question_logged, true, "no repair history creates no outstanding repair-question requirement");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-653: extracted readiness preserves repair-event fallback filtering and canonical repair precedence", () => {
  let resolvedQuestion = false;
  let featureProofRequired = false;
  let isTestingInfrastructure = false;
  let gateHasMeaningfulText = false;
  let laneDecision = { eligible: false, reason: "procedural" };
  let reviewIssues = [];
  let events = [
    { command: "return-doing" },
    { command: "recover" },
    { command: "manual-reconcile" },
    { command: "reconcile" },
  ];
  const derive = createGovernanceReadiness({
    normalizeGovernancePlanShape: (governance) => ({
      expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null },
      ticket_local_repairs: governance?.ticket_local_repairs || [],
    }),
    resolveRepoCodeForTicket: () => "F",
    isMeaningfulText: (value) => Boolean(String(value || "").trim()),
    collectReviewPlanReadinessIssues: () => reviewIssues,
    resolveTicketLightLane: () => laneDecision,
    requiresFeatureProofGovernance: () => featureProofRequired,
    isTestingInfrastructureTicket: () => isTestingInfrastructure,
    collectTicketGovernanceIssueEvents: () => events,
    hasResolvedGovernanceRepairQuestion: () => resolvedQuestion,
    fieldHasMeaningfulValue: () => gateHasMeaningfulText,
    deriveDecisionRequiredGuidance: () => null,
  }).deriveGovernanceReadiness;
  const row = { ID: "FE-999", Repo: "F", Type: "bug", Description: "test ticket" };
  const board = { metadata: {}, sections: [] };
  const planState = { governance: { expected_closeout: {}, ticket_local_repairs: [] } };

  const unresolved = derive("FE-999", row, board, null, planState);
  assert.equal(unresolved.closeout.repair_question_logged, false);
  assert.deepEqual(unresolved.ticket_local_repairs, [
    {
      kind: "recover",
      required_question_logged: false,
      note: "ticket-local governance repair was required before lifecycle could proceed",
    },
    {
      kind: "manual-reconcile",
      required_question_logged: false,
      note: "ticket-local governance reconcile affected this ticket's closeout path",
    },
    {
      kind: "reconcile",
      required_question_logged: false,
      note: "ticket-local governance repair was required before lifecycle could proceed",
    },
  ]);

  resolvedQuestion = true;
  assert.equal(derive("FE-999", row, board, null, planState).closeout.repair_question_logged, true);

  events = [];
  resolvedQuestion = false;
  const emptyPlan = derive("FE-999", row, board, null, null);
  assert.deepEqual(emptyPlan.active_lane, { lane: "full", light_lane_eligible: false, reason: "procedural" });
  assert.deepEqual(emptyPlan.bootstrap, { startup_attested: false, traceability_status: "pending" });
  assert.deepEqual(emptyPlan.review_prep, {
    repo_gates_recorded: false,
    feature_proof_recorded: true,
    self_review_cycles_complete: true,
  });
  assert.equal(emptyPlan.closeout.repair_question_logged, true);
  assert.deepEqual(emptyPlan.ticket_local_repairs, []);

  const falsyBootstrapValues = derive("FE-999", row, board, null, {
    startup_checklist: [null, "", false, 0],
    traceability_gate: [null, "", false, 0],
    governance: { expected_closeout: {}, ticket_local_repairs: [] },
  });
  assert.equal(falsyBootstrapValues.bootstrap.startup_attested, false);
  assert.equal(falsyBootstrapValues.bootstrap.traceability_status, "pending");
  events = [{}];
  const missingRepairCommand = derive("FE-999", row, board, null, planState);
  assert.equal(missingRepairCommand.closeout.repair_ticket_local, false);
  assert.deepEqual(missingRepairCommand.ticket_local_repairs, []);
  events = [];

  featureProofRequired = true;
  laneDecision = { eligible: true, reason: "reference-doc" };
  reviewIssues = [{ code: "self_review_lens_coverage" }];
  events = [
    { command: "return-doing" },
    { command: "manual-reconcile" },
    { command: "reconcile" },
    { command: "unrelated" },
  ];
  const fallbackPlan = {
    startup_checklist: [" completed "],
    traceability_gate: ["closing-gap"],
    repo_gates: ["not-required"],
    feature_proof: ["todo later", "path:src/view.tsx"],
    governance: { expected_closeout: {}, ticket_local_repairs: [] },
  };
  const fallback = derive("FE-999", row, board, null, fallbackPlan);
  assert.deepEqual(fallback.active_lane, { lane: "light", light_lane_eligible: true, reason: "reference-doc" });
  assert.equal(fallback.bootstrap.startup_attested, true);
  assert.equal(fallback.bootstrap.traceability_status, "closing-gap");
  assert.equal(fallback.review_prep.repo_gates_recorded, true, "the not-required sentinel satisfies the gate with no meaningful-text result");
  assert.equal(fallback.review_prep.feature_proof_recorded, true, "non-TODO proof remains after scaffold filtering");
  assert.equal(fallback.review_prep.self_review_cycles_complete, false);
  assert.deepEqual(fallback.ticket_local_repairs.map((entry) => entry.kind), ["manual-reconcile", "reconcile"]);
  assert.equal(fallback.ticket_local_repairs[0].note, "ticket-local governance reconcile affected this ticket's closeout path");
  assert.equal(fallback.ticket_local_repairs[1].note, "ticket-local governance repair was required before lifecycle could proceed");
  assert.equal(fallback.closeout.repair_question_logged, false);
  const obsoleteGate = "npm test [result=pass] stale head";
  const pendingGate = "TODO: correction not executed";
  const obsoleteRef = evidenceRef("repo_gate", 1, obsoleteGate);
  const pendingRef = evidenceRef("repo_gate", 2, pendingGate);
  const supersededOnly = derive("FE-999", row, board, null, {
    repo_gates: [obsoleteGate, pendingGate],
    evidence_supersessions: [{ id: stableSupersessionId(obsoleteRef, pendingRef), kind: "repo_gate",
      source_ref: obsoleteRef, successor_ref: pendingRef, reason: "stale", actor: "fixture-agent",
      timestamp: "2026-10-05T00:00:00.000Z" }],
  });
  assert.equal(supersededOnly.review_prep.repo_gates_recorded, false);
  assert.equal(supersededOnly.current_plan_evidence.superseded_history[0].source.value, obsoleteGate);

  const canonicalRepairs = [{ kind: "return_doing", required_question_logged: false, note: "canonical" }];
  gateHasMeaningfulText = true;
  reviewIssues = [{ code: "unrelated" }];
  events = [{ command: "manual-reconcile" }];
  resolvedQuestion = true;
  const canonicalPlan = {
    traceability_gate: ["verified"],
    repo_gates: ["pnpm test"],
    feature_proof: ["todo later"],
    governance: { expected_closeout: {}, ticket_local_repairs: canonicalRepairs },
  };
  planState.governance.ticket_local_repairs = canonicalRepairs;
  events = [{ command: "recover" }];
  const canonical = derive("FE-999", row, board, null, canonicalPlan);
  assert.equal(canonical.ticket_local_repairs, canonicalRepairs, "canonical plan repairs take precedence over synthesized events");
  assert.equal(canonical.closeout.repair_question_logged, true, "resolved QUESTIONS truth controls status despite stale canonical flags");
  assert.equal(canonical.review_prep.repo_gates_recorded, true, "ordinary recorded gate covers the meaningful-text path");
  assert.equal(canonical.review_prep.feature_proof_recorded, false, "TODO-only proof stays incomplete when proof is required");
  assert.equal(canonical.review_prep.self_review_cycles_complete, true, "unrelated review issues do not block self-review completeness");

  isTestingInfrastructure = true;
  const infrastructurePlan = { ...canonicalPlan, feature_proof: [] };
  assert.equal(
    derive("FE-999", row, board, null, infrastructurePlan).review_prep.feature_proof_recorded,
    true,
    "testing-infrastructure work remains outside the feature-proof requirement",
  );
  isTestingInfrastructure = false;
  const falsyAndTodoProofs = { ...canonicalPlan, feature_proof: [null, "", false, 0, "todo later"] };
  assert.equal(
    derive("FE-999", row, board, null, falsyAndTodoProofs).review_prep.feature_proof_recorded,
    false,
    "falsy values and TODO placeholders do not satisfy required feature proof",
  );
  const validProof = { ...falsyAndTodoProofs, feature_proof: [...falsyAndTodoProofs.feature_proof, "path:src/view.tsx"] };
  assert.equal(
    derive("FE-999", row, board, null, validProof).review_prep.feature_proof_recorded,
    true,
    "a valid path proof remains sufficient after filtering falsy placeholders",
  );
});

test("deriveTestingInfrastructureAudit normalizes worktree paths and records branch-reachability evidence", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gate-audit-records-"));
  const { repoRoot, head } = createTempGitRepo("legacy-gate-audit-backend-", {
    "package.json": JSON.stringify({
      name: "@template/backend",
      scripts: {
        "gate:default": "node tools/gates/run-gate.mjs --lane default",
        "gate:full": "node tools/gates/run-gate.mjs --lane full",
        "gate:extended": "node tools/gates/run-gate.mjs --lane extended",
      },
    }, null, 2),
    "README.md": "# backend\n",
    "tools/gates/run-gate.mjs": "console.log('gate');\n",
    "tools/testing/run-test-lane.mjs": "console.log('lane');\n",
  }, "gate infra");
  fs.writeFileSync(path.join(recordsDir, "MSRV-041.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "MSRV-041",
    markdown_heading: "## MSRV-041 — 2026-04-02T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: pnpm gate:default", "Outcome: reproduced missing CI/hook wiring"],
    prior_findings: [],
    intended_files: [
      "backend/.worktrees/unassigned/MSRV-041/tools/gates/run-gate.mjs",
      "backend/.worktrees/unassigned/MSRV-041/README.md",
    ],
    change_summary: ["Wire backend gate automation and make the closeout contract auditable."],
    verification_commands: [
      "node tools/testing/run-test-lane.mjs",
      "pnpm gate:default",
      "pnpm gate:full",
      "pnpm gate:extended",
    ],
    critical_invariants: ["Default/full/extended lanes stay truthful.", "Canonical dev must carry the landed gate scripts."],
    requirement_closure: ["Ticket ask: auditing", "Implemented: auditing", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["pnpm gate:default", "pnpm gate:full", "pnpm gate:extended"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({
    PLAN_RECORDS_DIR: recordsDir,
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repoRoot },
  }, () => {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`local-review ${head}`],
    };
    const row = {
      ID: "MSRV-041",
      Repo: "B",
      Type: "infra",
      Description: "Wire the backend default/full/extended gates into CI and documented hook flow.",
    };

    const audit = __testing.deriveTestingInfrastructureAudit("MSRV-041", row, landing);

    assert.deepEqual(audit.requiredFiles, [
      "README.md",
      "package.json",
      "tools/gates/run-gate.mjs",
      "tools/testing/run-test-lane.mjs",
    ]);
    assert.deepEqual(audit.requiredScripts, [
      "gate:default",
      "gate:extended",
      "gate:full",
    ]);

    __testing.ensureTestingInfrastructureLandingAudit("MSRV-041", row, landing, { recordEvidence: true });
    assert.equal(
      landing.evidence.some((entry) => new RegExp(`testing-infra audit: commit .* is an ancestor of ${audit.repoLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/dev`).test(entry)),
      true
    );
  });
});

test("deriveTestingInfrastructureAudit ignores feature tickets with feed-runner wording and incidental package manifests", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gate-audit-backend051-"));
  const { repoRoot, head } = createTempGitRepo("legacy-gate-audit-feature-", {
    "apps/ingest-worker/src/feed-runner.ts": "export function createFeedRunner() { return 'ok'; }\n",
    "apps/ingest-worker/src/feed-runner.test.ts": "export {};\n",
    "apps/ingest-worker/src/main.ts": "export const main = true;\n",
    "apps/ingest-worker/package.json": JSON.stringify({
      name: "@template/ingest-worker",
      dependencies: {
        "@template/http-contracts": "workspace:*",
      },
    }, null, 2),
  }, "feature ticket with feed runner");
  fs.writeFileSync(path.join(recordsDir, "MSRV-051.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "MSRV-051",
    markdown_heading: "## MSRV-051 — 2026-04-03T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: [
      "backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/feed-runner.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/feed-runner.test.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/main.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/package.json",
    ],
    change_summary: [
      "Wire integration adapters to ingest-worker with feed-runner engine and dead-letter retry queue.",
    ],
    verification_commands: [
      "node --experimental-strip-types --test apps/ingest-worker/src/feed-runner.test.ts",
    ],
    critical_invariants: ["Feed jobs preserve retry count.", "Dedup still rejects duplicates."],
    requirement_closure: ["Ticket ask: feature", "Implemented: feature", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: [
      "git diff --check dev...HEAD: pass",
      "testing-infra audit: MSRV-051 is a feature ticket that touched apps/ingest-worker/package.json to add http-contracts dep. No testing infrastructure added. Feed-runner and dead-letter retry are ingest-worker domain features.",
    ],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({
    PLAN_RECORDS_DIR: recordsDir,
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repoRoot },
  }, () => {
    const row = {
      ID: "MSRV-051",
      Repo: "B",
      Type: "feature",
      Description: "Wire integration adapter feed jobs to the ingest-worker app and implement dead-letter retry.",
    };
    const planState = JSON.parse(fs.readFileSync(path.join(recordsDir, "MSRV-051.json"), "utf8"));
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`landing audit backfill: git merge-base --is-ancestor ${head} dev == true`],
    };

    // The classifier's owner suite covers the ticket predicate directly; this
    // assertion keeps the lifecycle audit composition contract exercised.
    assert.equal(__testing.deriveTestingInfrastructureAudit("MSRV-051", row, landing), null);
  });
});

test("deriveTestingInfrastructureAudit reports sparse plans and refuses unresolvable or empty obligations", () => {
  const calls = [];
  let planRecord = null;
  let planState = {};
  let resolvedSha = null;
  let integrationBranches = { B: "release/integration" };
  let touchedPaths = [];
  let commandFiles = [];
  let packageScripts = [];
  let presentFiles = new Set();
  let packageJson = null;
  const validation = createGovernanceValidation({
    GovernanceError,
    isRepoBackedCode: (repo) => repo === "B",
    readPlanRecord: () => planRecord,
    readPlanState: () => planState,
    isTestingInfrastructureTicket: () => true,
    getRepoRoot: () => "/fixture/backend",
    repoDisplayNameForCode: () => "backend",
    REPO_INTEGRATION_BRANCHES: integrationBranches,
    resolveCommitishInRepo: (...args) => {
      calls.push(["resolveCommitishInRepo", ...args]);
      return null;
    },
    resolveLandingCommitSha: (...args) => {
      calls.push(["resolveLandingCommitSha", ...args]);
      return resolvedSha;
    },
    mergeUniqueRefs: (...values) => [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []))],
    splitPlanPathValues: (values) => Array.isArray(values) ? values : [],
    normalizeTestingInfraAuditPath: (_repo, _ticket, value) => value,
    isTestingInfrastructureFilePath: (value) => value.startsWith("tools/"),
    extractFileReferencesFromCommands: () => commandFiles,
    listCommitTouchedPaths: (...args) => {
      calls.push(["listCommitTouchedPaths", ...args]);
      return touchedPaths;
    },
    extractPackageScriptsFromCommands: () => packageScripts,
    gitPathExistsAtRef: (_root, _ref, filePath) => presentFiles.has(filePath),
    readJsonFileFromRef: (...args) => {
      calls.push(["readJsonFileFromRef", ...args]);
      return packageJson;
    },
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX: "testing-infra audit:",
  });
  const derive = (landing, row = { ID: "MSRV-041", Repo: "B" }) =>
    validation.deriveTestingInfrastructureAudit("MSRV-041", row, landing);

  assert.equal(derive(null), null);
  assert.equal(derive({ base_ref: "dev", commit_sha: "abc123" }, { ID: "X-1", Repo: "X" }), null);
  assert.throws(
    () => derive({}),
    /testing-infrastructure audit could not resolve the landed commit SHA/,
  );
  assert.deepEqual(calls.find(([name]) => name === "resolveLandingCommitSha")[1], "MSRV-041");
  assert.deepEqual(calls.find(([name]) => name === "resolveLandingCommitSha").slice(2), [
    { ID: "MSRV-041", Repo: "B" },
    "manual",
    [],
    [],
    { baseRef: "release/integration" },
  ]);
  delete integrationBranches.B;
  assert.throws(
    () => derive({}),
    /testing-infrastructure audit could not resolve the landed commit SHA/,
  );
  assert.deepEqual(calls.filter(([name]) => name === "resolveLandingCommitSha").at(-1).at(-1), { baseRef: "dev" });

  resolvedSha = "abc123";
  planState = { intended_files: undefined, repo_gates: undefined, verification_commands: undefined };
  touchedPaths = ["tools/present.test.js", "tools/legacy.test.js"];
  packageScripts = ["test:ci"];
  presentFiles = new Set(["tools/present.test.js"]);
  packageJson = null;
  assert.deepEqual(derive({}), {
    ticketId: "MSRV-041",
    repoLabel: "backend",
    baseRef: "dev",
    commitSha: "abc123",
    requiredFiles: ["tools/legacy.test.js", "tools/present.test.js"],
    presentFiles: ["tools/present.test.js"],
    requiredScripts: ["test:ci"],
    missingFiles: ["tools/legacy.test.js"],
    missingScripts: ["test:ci"],
    evidence: "testing-infra audit: commit abc123 is an ancestor of backend/dev; verified files at tip: tools/present.test.js; legacy-missing files tolerated: tools/legacy.test.js; required scripts at tip: test:ci",
  });
  assert.ok(calls.some((entry) => entry[0] === "listCommitTouchedPaths" && entry[1] === "/fixture/backend" && entry[2] === "abc123"));
  assert.ok(calls.some((entry) => entry[0] === "readJsonFileFromRef" && entry[1] === "/fixture/backend" && entry[2] === "dev" && entry[3] === "package.json"));

  planState = {};
  touchedPaths = [];
  packageScripts = [];
  assert.throws(
    () => derive({}),
    /could not derive required files or scripts/,
  );

  planState = { intended_files: ["tools/missing.test.js"] };
  packageJson = { scripts: null };
  presentFiles = new Set();
  const filesOnly = derive({});
  assert.deepEqual(filesOnly.requiredFiles, ["tools/missing.test.js"]);
  assert.deepEqual(filesOnly.presentFiles, []);
  assert.deepEqual(filesOnly.missingFiles, ["tools/missing.test.js"]);
  assert.deepEqual(filesOnly.requiredScripts, []);
  assert.deepEqual(filesOnly.missingScripts, []);
  assert.match(filesOnly.evidence, /verified files at tip: none; legacy-missing files tolerated: tools\/missing\.test\.js; required scripts at tip: none$/);
});

test("deriveFeatureProofAudit verifies canonical path, symbol, and route proofs", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-feature-proof-records-"));
  const frontendRepo = createTempGitRepo("legacy-feature-proof-frontend-", {
    "apps/public-web/app/[flow]/page.tsx": "export function SecureLinkProofPage() { return '/proof'; }\n",
    "apps/public-web/app/page.tsx": "export default function PublicHome() { return null; }\n",
  }, "public flow");
  fs.writeFileSync(path.join(recordsDir, "FE-079.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "FE-079",
    markdown_heading: "## FE-079 — 2026-04-02T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test", "Outcome: public flow stub reproduced"],
    prior_findings: [],
    intended_files: ["frontend/apps/public-web/app/[flow]/page.tsx"],
    change_summary: ["Recover the public secure-link proof flow."],
    verification_commands: ["pnpm test:components"],
    critical_invariants: ["Secure-link proof route must exist.", "Public flow shell must be canonical."],
    requirement_closure: ["Ticket ask: recover FE-007 flow", "Implemented: public proof flow", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [
      "path:apps/public-web/app/[flow]/page.tsx",
      "symbol:apps/public-web/app/[flow]/page.tsx#SecureLinkProofPage",
      "route:/proof",
    ],
    repo_gates: ["pnpm test:components"],
    self_review_cycles: [],
    rollback_strategy: ["revert public flow"],
    security_surface: "yes",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({
    PLAN_RECORDS_DIR: recordsDir,
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: frontendRepo.repoRoot },
  }, () => {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: frontendRepo.head,
      evidence: [`local-review ${frontendRepo.head}`],
    };
    const row = {
      ID: "FE-079",
      Repo: "F",
      Type: "feature",
      Description: "Recover the public secure-link flow.",
    };

    const audit = __testing.deriveFeatureProofAudit("FE-079", row, landing, {
      feature_proof_required_from_ticket: {
        F: "FE-079",
      },
    });

    assert.deepEqual(audit.proofs, [
      "path:apps/public-web/app/[flow]/page.tsx",
      "symbol:apps/public-web/app/[flow]/page.tsx#SecureLinkProofPage",
      "route:/proof",
    ]);
    __testing.ensureFeatureProofLandingAudit("FE-079", row, landing, {
      feature_proof_required_from_ticket: {
        F: "FE-079",
      },
    }, { recordEvidence: true });
    assert.equal(
      landing.evidence.some((entry) => new RegExp(`feature-proof audit: commit .* verified 3 proof\\(s\\) on ${repoRegistryOwner.repoNameForCode("F").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/dev`).test(entry)),
      true
    );
  });
});

test("deriveFeatureProofAudit fails closed across missing plan and invalid or absent proof branches", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-feature-proof-boundaries-records-"));
  const repo = createTempGitRepo("legacy-feature-proof-boundaries-", {
    "src/feature.ts": "export const proof = true;\n",
  }, "feature proof boundaries");
  const ticketId = "FE-991";
  const row = { ID: ticketId, Repo: "F", Type: "feature", Description: "Feature proof audit boundaries." };
  const metadata = { feature_proof_required_from_ticket: { F: ticketId } };
  const landing = { base_ref: "dev", method: "no_pr", commit_sha: repo.head, evidence: [`local-review ${repo.head}`] };
  const originalBranches = { ...DEFAULT_PATHS.repoIntegrationBranches };
  const contextOverrides = {
    PLAN_RECORDS_DIR: recordsDir,
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, F: "dev" },
  };

  const writePlan = (featureProof, intendedFiles = ["frontend/src/feature.ts"]) => fs.writeFileSync(path.join(recordsDir, `${ticketId}.json`), JSON.stringify({
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-10-01T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: ["not-required"],
    prior_findings: [],
    intended_files: intendedFiles,
    change_summary: ["Cover feature proof audit boundaries."],
    verification_commands: ["node --test"],
    critical_invariants: ["Proof must exist at the landing ref."],
    requirement_closure: ["Closeout verdict: complete"],
    feature_proof: featureProof,
    repo_gates: ["node --test"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
      assert.equal(__testing.deriveFeatureProofAudit(ticketId, row, null, metadata), null);
    assert.equal(__testing.deriveFeatureProofAudit(ticketId, { ...row, Repo: "X" }, landing, metadata), null);
    assert.equal(__testing.deriveFeatureProofAudit(ticketId, row, landing, {
      feature_proof_required_from_ticket: { F: "FE-992" },
    }), null);
    assert.throws(
      () => __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata),
      /requires a canonical plan record/,
    );

    writePlan([]);
    assert.throws(
      () => __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata),
      /must record canonical .*Feature proof/,
    );
    assert.equal(featureProofNormalizationOwner.normalizeFeatureProofEntryForTicket("", ticketId), "");
    writePlan([""]);
    assert.throws(
      () => __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata),
      /must record canonical .*Feature proof/,
    );
    writePlan(["not-a-proof-entry"]);
    assert.throws(
      () => __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata),
      /has invalid feature-proof entries/,
    );
    for (const entry of [
      "coord:path:src/feature.ts",
      "coord:symbol:src/feature.ts#proof",
      "unknown:path:src/feature.ts",
    ]) {
      writePlan([entry]);
      const recordPath = path.join(recordsDir, `${ticketId}.json`);
      const before = fs.readFileSync(recordPath);
      assert.throws(
        () => __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata),
        /has invalid feature-proof entries:.*unsupported proof kind/,
        entry,
      );
      assert.deepEqual(fs.readFileSync(recordPath), before, "closeout audit refusal must not rewrite the canonical plan fixture");
    }
    writePlan(["path:src/missing.ts"]);
    let missingProofError;
    try {
      __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata);
    } catch (error) {
      missingProofError = error;
    }
    assert.ok(missingProofError, "missing proof must be refused");
    assert.match(missingProofError.message, /Missing at branch tip: path:src\/missing\.ts/);
    assert.doesNotMatch(missingProofError.message, /Use "coord:" prefix/);

    const infrastructureRow = { ...row, Type: "infra", Description: "Testing infrastructure validation." };
    writePlan([], ["frontend/tools/testing/run-test-lane.mjs"]);
    assert.equal(__testing.deriveFeatureProofAudit(ticketId, infrastructureRow, landing, metadata), null);

    writePlan(["path:src/feature.ts"]);
    const fulfilledBy = __testing.deriveFeatureProofAudit(ticketId, row, {
      base_ref: "dev",
      fulfilled_by_commit_sha: repo.head,
      evidence: [`fulfilled by ${repo.head}`],
    }, metadata);
    assert.equal(fulfilledBy.commitSha, repo.head);
    const evidenceResolved = __testing.deriveFeatureProofAudit(ticketId, row, {
      method: "no_pr",
      base_ref: "dev",
      evidence: [`local-review ${repo.head}`],
    }, metadata);
    assert.equal(evidenceResolved.commitSha, repo.head);
    let landingResolverCall;
    const unavailableResolver = createGovernanceValidation({
      GovernanceError,
      FEATURE_PROOF_EVIDENCE_PREFIX: "feature-proof audit:",
      REPO_INTEGRATION_BRANCHES: { F: "dev" },
      isRepoBackedCode: (repoCode) => repoCode === "F",
      readPlanRecord: () => JSON.parse(fs.readFileSync(path.join(recordsDir, `${ticketId}.json`), "utf8")),
      readPlanState: () => null,
      isTestingInfrastructureTicket: () => false,
      resolveRepoThresholdTicket: () => ticketId,
      isTicketAtOrAfter: () => true,
      getRepoRoot: () => repo.repoRoot,
      repoDisplayNameForCode: () => "frontend",
      resolveCommitishInRepo: () => null,
      resolveLandingCommitSha: (...args) => {
        landingResolverCall = args;
        return null;
      },
      resolveLandingBaseRef: (_root, baseRef) => ({ baseRef }),
      resolveRepoCodeForTicket: () => "F",
      repoPrefixesForCode: () => ["frontend/"],
      toArray: (value) => Array.isArray(value) ? value : value == null ? [] : [value],
    });
    // This isolated helper seam simulates unavailable commit resolvers; it
    // does not claim a public CLI path can succeed without landing evidence.
    const unbound = unavailableResolver.deriveFeatureProofAudit(ticketId, row, {}, metadata);
    assert.equal(unbound.commitSha, null);
    assert.match(unbound.evidence, /commit unknown/);
    assert.equal(landingResolverCall[2], "manual");
    assert.deepEqual(landingResolverCall[3], []);
    assert.equal(landingResolverCall[5].baseRef, "dev");

    const blankBase = __testing.deriveFeatureProofAudit(ticketId, row, {
      base_ref: "   ",
      commit_sha: repo.head,
      evidence: [`local-review ${repo.head}`],
    }, metadata);
    assert.equal(blankBase.baseRef, "dev");
    withScopedGovernanceTestContext({
      REPO_INTEGRATION_BRANCHES: Object.fromEntries(Object.entries(originalBranches).filter(([code]) => code !== "F")),
    }, () => {
      const blankDefaultBase = __testing.deriveFeatureProofAudit(ticketId, row, {
      base_ref: "   ",
      commit_sha: repo.head,
      evidence: [`local-review ${repo.head}`],
    }, metadata);
    assert.equal(blankDefaultBase.baseRef, "dev");
    const defaultBase = __testing.deriveFeatureProofAudit(ticketId, row, {
      method: "no_pr",
      commit_sha: repo.head,
      evidence: [`local-review ${repo.head}`],
    }, metadata);
      assert.equal(defaultBase.baseRef, "dev");
    });
    writePlan(["path:src/feature.ts"]);
    const validProof = __testing.deriveFeatureProofAudit(ticketId, row, landing, metadata);
    assert.deepEqual(validProof.proofs, ["path:src/feature.ts"]);
    assert.equal(validProof.commitSha, repo.head);
    });
  } finally {
    fs.rmSync(recordsDir, { recursive: true, force: true });
  }
});

test("deriveFeatureProofAudit normalizes repo-prefixed proofs and prefers origin/dev when local dev is stale", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-feature-proof-origin-fallback-"));
  const backendRepo = createTempGitRepoWithOrigin("legacy-feature-proof-backend-", {
    "packages/platform/core/src/event-bus.ts": "export function emitEvent() { return true; }\n",
    "packages/modules/planning-dispatch/src/planning-dispatch.core.ts": "export function transitionRouteForActor() { return true; }\n",
    "apps/api/src/http/events.controller.ts": "export class EventsController {}\n",
  }, "event stream");
  const updaterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-feature-proof-origin-fallback-updater-"));
  runGit(path.dirname(updaterRoot), ["clone", backendRepo.remoteRoot, updaterRoot]);
  runGit(updaterRoot, ["checkout", "dev"]);
  runGit(updaterRoot, ["config", "user.email", "governance-tests@example.com"]);
  runGit(updaterRoot, ["config", "user.name", "Governance Tests"]);
  writeRepoFile(updaterRoot, "packages/platform/core/src/event-store.ts", "export function createStore() { return true; }\n");
  runGit(updaterRoot, ["add", "."]);
  runGit(updaterRoot, ["commit", "-m", "remote-only advance"]);
  runGit(updaterRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["fetch", "origin"]);

  const tid = `${B_TICKET_PREFIX}-085`;
  fs.writeFileSync(path.join(recordsDir, `${tid}.json`), JSON.stringify({
    schema_version: 1,
    ticket_id: tid,
    markdown_heading: `## ${tid} — 2026-04-06T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["not-required"],
    prior_findings: [],
    intended_files: [`${repoRegistryOwner.repoPrefixForCode("B")}packages/platform/core/src/event-bus.ts`],
    change_summary: ["Add backend event stream APIs."],
    verification_commands: ["pnpm gate:default"],
    critical_invariants: ["Events persist before broadcast.", "Replay cursors stay stable."],
    requirement_closure: ["Ticket ask: add SSE event APIs", "Implemented: event bus and store", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [
      `path:${repoRegistryOwner.repoPrefixForCode("B")}packages/platform/core/src/event-bus.ts`,
      `path:${repoRegistryOwner.repoPrefixForCode("B")}apps/api/src/http/events.controller.ts`,
      `symbol:${repoRegistryOwner.repoPrefixForCode("B")}packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor`,
    ],
    repo_gates: ["pnpm gate:default"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({
    PLAN_RECORDS_DIR: recordsDir,
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot },
  }, () => {
    const originHead = runGit(backendRepo.repoRoot, ["rev-parse", "origin/dev"]);
    const localHead = runGit(backendRepo.repoRoot, ["rev-parse", "dev"]);
    assert.notEqual(originHead, localHead);

    const landing = {
      base_ref: "dev",
      method: "pr",
      commit_sha: originHead,
      evidence: [`merged ${originHead}`],
    };
    const row = {
      ID: tid,
      Repo: "B",
      Type: "feature",
      Description: "Add backend event stream APIs.",
    };

    const audit = __testing.deriveFeatureProofAudit(tid, row, landing, {
      feature_proof_required_from_ticket: {
        B: tid,
      },
    });

    assert.equal(audit.baseRef, "origin/dev");
    assert.deepEqual(audit.proofs, [
      "path:packages/platform/core/src/event-bus.ts",
      "path:apps/api/src/http/events.controller.ts",
      "symbol:packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor",
    ]);
    // Evidence label is the registry-derived repo display name
    // (repoNameForCode = basename of REPO_ROOTS[code]); derive it the same way
    // so the assertion holds for any active registry (GOV-015).
    assert.match(audit.evidence, new RegExp(`on ${repoRegistryOwner.repoNameForCode("B").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/origin\\/dev:`));
  });
});

test("validateFeatureProofEntry accepts text and route proofs documented in governance", () => {
  assert.doesNotThrow(() => featureProofEntryOwner.validateFeatureProofEntry("text:actionTemplate"));
  assert.doesNotThrow(() => featureProofEntryOwner.validateFeatureProofEntry("route:/proof"));
  assert.doesNotThrow(() => featureProofEntryOwner.validateFeatureProofEntry("path:README.md"));
  assert.doesNotThrow(() => featureProofEntryOwner.validateFeatureProofEntry("symbol:README.md#Concord"));
  for (const entry of [
    "coord:path:README.md",
    "coord:symbol:README.md#Concord",
    "unknown:path:README.md",
  ]) {
    assert.throws(
      () => featureProofEntryOwner.validateFeatureProofEntry(entry),
      /Cross-repository proof prefixes are unsupported/,
      entry,
    );
  }
});

test("replaceSelfReviewCycles overwrites scaffold TODO review cycles with real entries", () => {
  const block = `## IMP-228 — 2026-03-28T00:00:00Z

- Repo gates:
  - pytest -q tests/test_reference_data.py
- Self-review cycle 1/3: lens=TODO contract/state invariants; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Self-review cycle 2/3: lens=TODO auth/security/failure modes; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Self-review cycle 3/3: lens=TODO tests/operability/performance; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Rollback strategy:
  - revert
`;

  assert.equal(validationLeaf.hasOnlyScaffoldSelfReviewCycles(block), true);

  const updated = validationLeaf.replaceSelfReviewCycles(block, [
    "lens=contract/state invariants; diff=git diff -- services/audit.py; risks=route bypass could still commit, helper could raise after persistence; findings=none; verification=pytest -q tests/test_form_types.py; verdict=pass",
    "lens=auth/security/failure modes; diff=git diff -- routes/users.py tests/test_integration.py; risks=signature scope mismatch, stale admin payloads could 422 before audit assertions; findings=repaired stale integration expectations; verification=pytest -q tests/test_integration.py -k s8_site_create_audited; verdict=pass",
    "lens=tests/operability/performance; diff=git diff -- tests/test_reference_data.py tests/test_users.py; risks=stable seam coverage could miss adapter regressions, full-suite debt could hide local confidence; findings=none; verification=pytest -q tests/test_reference_data.py tests/test_users.py; verdict=pass",
  ]);

  assert.equal(validationLeaf.hasOnlyScaffoldSelfReviewCycles(updated), false);
  assert.doesNotMatch(updated, /TODO contract\/state invariants/);
  assert.match(updated, /- Self-review cycle 1\/3: lens=contract\/state invariants;/);
  assert.match(updated, /- Self-review cycle 3\/3: lens=tests\/operability\/performance;/);
});

test("review round helpers default initial review to round 1 and honor latest finding round", () => {
  assert.equal(validationLeaf.inferRequiredReviewRound([]), 1);
  assert.equal(validationLeaf.inferRequiredReviewRound([{ id: "IMP-200-F1", round: 1 }]), 1);
  assert.equal(
    validationLeaf.inferRequiredReviewRound([
      { id: "IMP-200-F1", round: 1 },
      { id: "IMP-200-F2", round: 2 },
    ]),
    2
  );

  const block = `## IMP-200 — 2026-03-25T15:00:00Z

- Review round:
  - 2
`;
  assert.equal(planRecordOwner.readPlanScalarField(block, "Review round"), "2");
});

test("COORD-653: submit review-plan check remains active for doing tickets with existing or explicit PRs", () => {
  const row = {
    ID: "IMP-240",
    Status: "doing",
  };

  assert.equal(
    __testing.submitRequiresReviewPlanCheck({ pr_index: {} }, row, "IMP-240", {}),
    true
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck(
      { pr_index: { "IMP-240": ["https://github.com/example/repo/pull/57"] } },
      row,
      "IMP-240",
      {}
    ),
    true
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck(
      { pr_index: {} },
      row,
      "IMP-240",
      { pr: ["https://github.com/example/repo/pull/57"] }
    ),
    true
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck({ pr_index: {} }, { ID: "IMP-240", Status: "review" }, "IMP-240", {}),
    false
  );
});

test("COORD-797: ineligible start statuses fail before consulting startup evidence", () => {
  const gate = createReadinessGate({ STATUS });
  for (const status of ["proposed", STATUS.DOING, STATUS.REVIEW, STATUS.DONE, "superseded", "doing (blocked: external)"]) {
    // No other dependencies are supplied: invoking a startup collector fails.
    const blockers = gate.collectStartReadinessBlockers("T-1", { Status: status }, {});
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].code, "status");
    assert.ok(blockers[0].message.includes(status));
    assert.match(blockers[0].message, /todo.*deferred/);
    assert.deepEqual(blockers[0].next_steps, ["coord/scripts/gov explain T-1"]);
  }
});

function readinessGateFixture({ planState = null, traceabilityRequired = true, baselineRequired = true, gateIssues = [], ownershipIssue = { code: "ok" }, reviewIssues = [], dependencyReadiness = { cycles: [], blockedBy: [], deps: [], blockerChains: [] } } = {}) {
  const calls = { ownership: 0, review: 0, start: [] };
  // COORD-956: the prompt-record preflight is the production collector, bound to the same
  // fakes as this fixture (no waiver, no on-disk ticket prompt).
  const promptRecord = createPromptCoverage({
    ROOT_DIR: os.tmpdir(),
    COORD_DIR: os.tmpdir(),
    getPromptsDir: () => "/tmp/coord-prompts",
    readTicketWaiver: () => null,
  });
  const gate = createReadinessGate({
    GovernanceError,
    collectPromptRecordBlockers: (ticketId, board) => promptRecord.collectPromptRecordBlockers(ticketId, board),
    ROOT_DIR: os.tmpdir(),
    STATUS,
    buildDependencyRepairNextSteps: () => [],
    buildHistoricalCloseoutStartBlocker: () => null,
    buildPromptWaiverCommand: () => "coord/scripts/gov waive-prompt TICKET --reason <reason>",
    buildStartPlanBootstrapCommand: () => "coord/scripts/gov update-plan TICKET --startup completed",
    collectReviewPlanReadinessIssues: (...args) => { calls.review += 1; calls.reviewArgs = args; return reviewIssues; },
    defaultTicketPromptRelPath: () => "/tmp/missing-ticket-prompt.md",
    describeTicketMutationOwnershipIssue: (...args) => { calls.ownership += 1; calls.ownershipArgs = args; return ownershipIssue; },
    evaluateReadiness: (...args) => { calls.dependencies = args; return dependencyReadiness; },
    formatDependencyCycleList: (cycles) => cycles.map((chain) => chain.join(" -> ")).join("; "),
    formatGovernanceBlockers: (_ticketId, issues, label) => `${label}: ${issues.map((issue) => issue.message).join("; ")}`,
    formatTransitiveBlockerDetails: (chains) => chains.map((chain) => chain.join(" -> ")).join("; "),
    fs,
    hasPromptWaiver: () => false,
    path,
    readPlanState: () => planState,
    rowsById: () => new Map(),
    startGateRegistry: { run: (...args) => { calls.start.push(args); return gateIssues; } },
    state: { PROMPTS_DIR: "/tmp/coord-prompts" },
    ticketPromptRelPathExists: () => false,
    ticketRequiresBaseline: () => baselineRequired,
    ticketRequiresTraceability: () => traceabilityRequired,
    toArray: (value) => Array.isArray(value) ? value : value == null ? [] : [value],
  });
  return { gate, calls, planState };
}

test("COORD-797: start readiness retains dependency-cycle and incomplete-plan blockers", () => {
  const row = { ID: "CYCLE-1", Repo: "X", Type: "bug", Status: "todo", "Depends On": "CYCLE-2" };
  const board = {
    sections: [{ rows: [row, { ...row, ID: "CYCLE-2", "Depends On": "CYCLE-1" }] }],
    prompt_index: { "CYCLE-1": "coord/prompts/tickets/CYCLE-1.md" },
  };
  const cycle = __testing.collectStartReadinessBlockers(row.ID, row, board)
    .find((issue) => issue.code === "dependency_cycles");
  assert.ok(cycle);
  assert.match(cycle.message, /CYCLE-1/);
  assert.match(cycle.message, /CYCLE-2/);
  assert.ok(cycle.next_steps.length > 0);

  const required = { ...row, ID: "DEP-1", "Depends On": "DEP-2" };
  const dependencyBoard = { ...board, sections: [{ rows: [required, { ...required, ID: "DEP-2", "Depends On": "DEP-3" }, { ...required, ID: "DEP-3", "Depends On": "" }] }] };
  const transitive = __testing.collectStartReadinessBlockers(required.ID, required, dependencyBoard)
    .find((issue) => issue.code === "dependencies");
  assert.match(transitive.message, /Transitive blocker chains: DEP-2 -> DEP-3/);

  const { gate } = readinessGateFixture({ planState: {
    startup_checklist: ["", "pending"],
    traceability_gate: ["", "pending"],
    baseline_reproduction: [],
  } });
  const issues = gate.collectStartReadinessBlockers(row.ID, row, board);
  assert.ok(issues.some((issue) => issue.code === "startup_checklist"));
  assert.ok(issues.some((issue) => issue.code === "traceability_gate"));
  assert.ok(issues.some((issue) => issue.code === "baseline_reproduction"));
});

test("COORD-797: declared-file advisories preserve optional paths and existing prompt semantics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord797-advisories-"));
  const gate = createReadinessGate({ STATUS, fs, path, state: { PROMPTS_DIR: dir } });
  const row = { ID: "T-1", Repo: "X", Status: STATUS.TODO };
  try {
    fs.mkdirSync(path.join(dir, "tickets"));
    fs.writeFileSync(path.join(dir, "tickets", "T-1.md"), "# T-1\n\n## Assignment\nNo file list yet.\n");
    assert.equal(gate.collectStartReadinessAdvisories("T-1", row)[0].code, "repo_x_declared_files_missing");
    const declared = { ...row, "Declared Files": ["src/b.js", "src/a.js", "src/a.js"] };
    assert.deepEqual(gate.collectTicketDeclaredFiles("T-1", declared), ["src/a.js", "src/b.js"]);
    assert.deepEqual(gate.collectStartReadinessAdvisories("T-1", declared), []);
    for (const inapplicable of [null, { ...row, Status: STATUS.DOING }, { ...row, Repo: "B" }]) {
      assert.deepEqual(gate.collectStartReadinessAdvisories("T-1", inapplicable), []);
    }
    assert.equal(gate.normalizeDeclaredFilePath(null), "");
    assert.equal(gate.normalizeDeclaredFilePath(" ./src\\a.js "), "src/a.js");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-653: submit readiness short-circuits terminal states and combines ownership with review blockers", () => {
  const ownerFailure = { code: "wrong_owner", message: "not the lock owner", next_steps: ["recover ownership"] };
  const reviewFailure = { code: "self_review_cycle_incomplete", message: "review cycle is incomplete", next_steps: ["finish review"] };
  const { gate, calls } = readinessGateFixture({ ownershipIssue: ownerFailure, reviewIssues: [reviewFailure] });

  assert.deepEqual(gate.collectSubmitReadinessBlockers("T-1", { ID: "T-1", Status: STATUS.REVIEW }, {}, null), []);
  assert.equal(calls.ownership, 0, "already-review readiness remains idempotent");
  assert.equal(calls.review, 0);
  for (const status of [STATUS.TODO, STATUS.DEFERRED]) {
    const [blocker] = gate.collectSubmitReadinessBlockers("T-1", { ID: "T-1", Status: status }, {}, null);
    assert.equal(blocker.code, "status");
    assert.match(blocker.next_steps[0], /gov start T-1/);
  }
  const [doneBlocker] = gate.collectSubmitReadinessBlockers("T-1", { ID: "T-1", Status: STATUS.DONE }, {}, null);
  assert.match(doneBlocker.next_steps[0], /gov explain T-1/);
  const [missingLock] = gate.collectSubmitReadinessBlockers("T-1", { ID: "T-1", Status: STATUS.DOING }, {}, null);
  assert.equal(missingLock.code, "missing_lock");
  assert.equal(calls.ownership, 0, "missing-lock refusal does not query ownership or review evidence");

  assert.deepEqual(
    gate.collectSubmitReadinessBlockers("T-1", { ID: "T-1", Status: STATUS.DOING }, {}, { owner: "other" }),
    [ownerFailure, reviewFailure],
    "ownership and review blockers are both preserved for a doing ticket",
  );
  assert.equal(calls.ownership, 1);
  assert.equal(calls.review, 1);
  assert.deepEqual(calls.reviewArgs.slice(0, 2), ["T-1", { ID: "T-1", Status: STATUS.DOING }]);

  const ownedAndReady = readinessGateFixture({ ownershipIssue: { code: "ok" }, reviewIssues: [] });
  const doingRow = { ID: "T-1", Status: STATUS.DOING };
  assert.deepEqual(ownedAndReady.gate.collectSubmitReadinessBlockers("T-1", doingRow, {}, { owner: "current" }), []);
  assert.equal(ownedAndReady.calls.ownership, 1);
  assert.equal(ownedAndReady.calls.review, 1);
  assert.deepEqual(ownedAndReady.calls.reviewArgs.slice(0, 2), ["T-1", doingRow]);
});

test("COORD-796: submit readiness includes dependency chains and cycles without hiding other blockers", () => {
  const row = { ID: "T-1", Status: STATUS.DOING, "Depends On": "DEP-1" };
  const board = { sections: [] };
  const ownerFailure = { code: "wrong_owner", message: "not the lock owner", next_steps: [] };
  const reviewFailure = { code: "review_incomplete", message: "review missing", next_steps: [] };
  for (const detailed of [false, true]) {
    const { gate, calls } = readinessGateFixture({
      ownershipIssue: ownerFailure,
      reviewIssues: [reviewFailure],
      dependencyReadiness: {
        deps: ["DEP-1"], blockedBy: ["DEP-1"],
        blockerChains: detailed ? [["DEP-1", "DEP-2"]] : [],
        cycles: detailed ? [["DEP-1", "DEP-2", "DEP-1"]] : [],
      },
    });
    const blockers = gate.collectSubmitReadinessBlockers("T-1", row, board, { owner: "other" });
    const dependency = blockers.find((entry) => entry.code === "dependencies");
    assert.ok(dependency, "unmet dependencies must appear in submit-specific readiness");
    assert.match(dependency.message, /still has unmet dependencies: DEP-1/);
    assert.equal(dependency.message.includes("Transitive blocker chains:"), detailed);
    assert.equal(dependency.message.includes("Dependency cycle(s):"), detailed);
    if (detailed) assert.match(dependency.message, /DEP-1 -> DEP-2 -> DEP-1/);
    assert.ok(blockers.includes(ownerFailure));
    assert.ok(blockers.includes(reviewFailure));
    assert.equal(calls.dependencies[0], row);
    assert.equal(calls.dependencies[2], board);
  }
});

test("COORD-653: assertStartPlanReady enforces checklist, traceability, baseline, and registry contracts", () => {
  const row = { ID: "T-2", Repo: "F", Type: "bug" };
  const missing = readinessGateFixture({ planState: null });
  assert.throws(() => missing.gate.assertStartPlanReady("T-2", row), /Plan state missing/);

  const incomplete = readinessGateFixture({ planState: { startup_checklist: [" ", ""] } });
  assert.throws(() => incomplete.gate.assertStartPlanReady("T-2", row), /Startup checklist/);

  const traceability = readinessGateFixture({ planState: { startup_checklist: ["completed"], traceability_gate: ["", "pending"] } });
  assert.throws(() => traceability.gate.assertStartPlanReady("T-2", row), /Traceability gate/);

  for (const baseline_reproduction of [[], ["Command: pnpm test"], ["Outcome: reproduced"]]) {
    const baseline = readinessGateFixture({
      planState: { startup_checklist: ["completed"], traceability_gate: ["verified"], baseline_reproduction },
    });
    assert.throws(() => baseline.gate.assertStartPlanReady("T-2", row), /baseline reproduction Command and Outcome/);
  }

  const gateIssue = readinessGateFixture({
    planState: {
      startup_checklist: ["completed"],
      traceability_gate: ["exempt"],
      baseline_reproduction: ["Command: pnpm test", "Outcome: reproduced"],
    },
    gateIssues: [{ code: "context_pack", message: "context pack unresolved" }],
  });
  assert.throws(() => gateIssue.gate.assertStartPlanReady("T-2", row), /Start-plan blockers for: context pack unresolved/);
  assert.deepEqual(gateIssue.calls.start, [["start", { ticketId: "T-2", row, planState: gateIssue.planState }]]);

  const ready = readinessGateFixture({
    planState: { startup_checklist: ["completed"] },
    traceabilityRequired: false,
    baselineRequired: false,
    gateIssues: [],
  });
  assert.doesNotThrow(() => ready.gate.assertStartPlanReady("T-2", row));
  assert.deepEqual(ready.calls.start, [["start", { ticketId: "T-2", row, planState: ready.planState }]]);
});

test("assertAlreadyLandedNoPrReconcileReady validates explicit no-PR landing evidence against canonical dev", () => {
  const backendRepo = createTempGitRepo("legacy-already-landed-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-900-reconcile-path"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "recovered\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-900 recover merge-before-review closeout"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, B: "dev" },
  }, () => {
    const board = {
      sections: [],
      review_findings: {},
      pr_index: null,
      landing_index: {},
    };
    assert.equal(
      __testing.assertAlreadyLandedNoPrReconcileReady(
        "MSRV-900",
        board,
        { Repo: "B", Type: "feature" },
        ["local-review (no PR)"],
        {
          alreadyLanded: true,
          landed: [`backend/dev landed at ${sourceHead} via local-review no-pr closeout`],
          sourceCommit: sourceHead,
        }
      ),
      true
    );
    assert.equal(board.pr_index, null, "the no-PR preflight repairs its cloned index without mutating the canonical board");
  });
});

test("assertAlreadyLandedNoPrReconcileReady rejects invalid no-PR preconditions with actionable errors", () => {
  const board = { sections: [], pr_index: {}, landing_index: {} };
  const row = { ID: "FE-900", Repo: "F", Type: "feature" };
  const check = (refs, options) => __testing.assertAlreadyLandedNoPrReconcileReady("FE-900", board, row, refs, options);

  assert.equal(check([], {}), false, "ordinary flow leaves the special no-PR path untouched");
  assert.throws(
    () => __testing.assertAlreadyLandedNoPrReconcileReady("X-900", board, { Repo: "X" }, [], { alreadyLanded: true }),
    /only repo-backed tickets/,
  );
  assert.throws(() => check(["https://github.com/example/repo/pull/1"], { alreadyLanded: true }), /normal merged-PR submit/);
  assert.throws(() => check(["local review"], { alreadyLanded: true }), /without \"\(no PR\)\" closeout evidence/);
  assert.throws(() => check(["local review (no PR)"], { alreadyLanded: true }), /without landing evidence/);
});

test("assertLandingIntegrity accepts no-pr landing commits that are ancestors of origin/dev when local dev is stale", () => {
  const frontendRepo = createTempGitRepoWithOrigin("legacy-no-pr-integrity-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-903-no-pr-integrity"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "no-pr-integrity\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-903 no-pr landing"]);
  const landedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", landedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: frontendRepo.repoRoot },
  }, () => {
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("FE-903", { Repo: "F" }, {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: landedCommit,
      evidence: [`local-review ${landedCommit}`],
    }));
  });
});

test("classifyLandingRecord treats no-pr landing commits on origin/dev as merged when local dev is stale", () => {
  const frontendRepo = createTempGitRepoWithOrigin("legacy-no-pr-classify-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-904-no-pr-classify"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "no-pr-classify\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-904 no-pr landing"]);
  const landedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", landedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: frontendRepo.repoRoot },
  }, () => {
    const entry = __testing.classifyLandingRecord("FE-904", { Repo: "F" }, {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: landedCommit,
      evidence: [`local-review ${landedCommit}`],
    });
    assert.equal(entry.status, "merged");
    assert.equal(entry.base_ref, "origin/dev");
  });
});

test("COORD-653 coverage: landing audit helpers distinguish absent, unresolved, and unlanded evidence", () => {
  const repo = createTempGitRepo("legacy-landing-audit-boundaries-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "landing audit seed");
  const baseCommit = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(repo.repoRoot, ["checkout", "-b", "agent/unlanded-proof"]);
  writeRepoFile(repo.repoRoot, "feature.txt", "not merged to dev\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "FE-919 unlanded feature proof"]);
  const unlandedSha = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(repo.repoRoot, ["checkout", "dev"]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, F: "dev" },
  }, () => {
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("X-919", { Repo: "X" }, { commit_sha: "ignored" }));
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, null));
    assert.throws(
      () => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, { base_ref: "dev", method: "no_pr", commit_sha: "missing-sha", evidence: [] }),
      /no-PR landing evidence but no resolvable commit SHA/,
    );
    assert.throws(
      () => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, { method: "manual", evidence: [] }),
      /manual landing evidence but no resolvable commit SHA/,
    );
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, {
      fulfilled_by_commit_sha: baseCommit,
      evidence: ["fulfilled by prior canonical commit"],
    }));
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, {
      method: "no_pr",
      base_ref: "dev",
      evidence: [`local-review ${baseCommit}`],
    }));
    assert.throws(
      () => __testing.assertLandingIntegrity("FE-919", { Repo: "F" }, { base_ref: "dev", method: "no_pr", commit_sha: unlandedSha, evidence: [] }),
      /is not an ancestor of frontend\/dev/,
    );

    assert.equal(__testing.classifyLandingRecord("X-919", { Repo: "X" }, { evidence: ["unused"] }), null);
    assert.equal(__testing.classifyLandingRecord("FE-919", { Repo: "F" }, null).reason, "missing_landing_record");
    assert.equal(
      __testing.classifyLandingRecord("FE-919", { Repo: "F" }, { base_ref: "dev", evidence: [] }).reason,
      "missing_landing_evidence",
    );
    assert.equal(
      __testing.classifyLandingRecord("FE-919", { Repo: "F" }, { base_ref: "dev", evidence: ["local-review"], commit_sha: "missing-sha" }).reason,
      "unresolvable_commit_sha",
    );
    const notAncestor = __testing.classifyLandingRecord("FE-919", { Repo: "F" }, {
      base_ref: "dev",
      evidence: [`local-review ${unlandedSha}`],
      commit_sha: unlandedSha,
    });
    assert.equal(notAncestor.status, "not_ancestor");
    assert.equal(notAncestor.reason, "explicit_commit_not_ancestor");
  });
});

test("assertLandingIntegrity rejects local-only landing commits when origin has not received the branch", () => {
  const repo = createTempGitRepoWithOrigin("legacy-landing-audit-local-only-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "landing origin seed");
  runGit(repo.repoRoot, ["checkout", "-b", "agent/local-only-landing"]);
  writeRepoFile(repo.repoRoot, "feature.txt", "local-only landing\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "FE-920 local-only landing"]);
  const localOnlySha = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(repo.repoRoot, ["checkout", "dev"]);
  runGit(repo.repoRoot, ["merge", "--ff-only", localOnlySha]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, F: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, F: "dev" },
  }, () => {
    assert.throws(
      () => __testing.assertLandingIntegrity("FE-920", { Repo: "F" }, {
        base_ref: "dev",
        method: "no_pr",
        commit_sha: localOnlySha,
        evidence: [`local-review ${localOnlySha}`],
      }),
      /is an ancestor of local dev but not origin\/dev/,
    );
  });
});

test("detectSupersedeLandingBypass catches ticket-affiliated source commits that already landed on dev", () => {
  const backendRepo = createTempGitRepo("legacy-supersede-landed-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-901-supersede-guard"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "guard\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-901 land before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, B: "dev" },
  }, () => {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-901",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: sourceHead }
    );
    assert.deepEqual(detected, {
      kind: "source_commit",
      commitSha: sourceHead,
      baseRef: "dev",
    });
  });
});

test("detectSupersedeLandingBypass catches ticket-affiliated source commits already landed on origin/dev when local dev is stale", () => {
  const backendRepo = createTempGitRepoWithOrigin("legacy-supersede-remote-origin-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-903-supersede-guard"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "guard-remote\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-903 land before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);
  runGit(backendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, B: "dev" },
  }, () => {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-903",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: sourceHead }
    );
    assert.deepEqual(detected, {
      kind: "source_commit",
      commitSha: sourceHead,
      baseRef: "origin/dev",
    });
  });
});

test("detectSupersedeLandingBypass ignores base commits that do not affiliate with the ticket", () => {
  const backendRepo = createTempGitRepo("legacy-supersede-safe-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");

  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot },
  }, () => {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-902",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: backendRepo.head }
    );
    assert.equal(detected, null);
  });
});

test("collectStartReadinessBlockers avoids follow-up rewrite suggestions when multiple dependencies are present", () => {
  const blockers = __testing.collectStartReadinessBlockers(
    "DEBT-042",
    {
      ID: "DEBT-042",
      Repo: "X",
      Type: "infra",
      Status: "todo",
      Owner: "unassigned",
      Description: "Follow-up dependency repair",
      "Depends On": "IMP-245, IMP-246",
    },
    {
      sections: [
        {
          rows: [
            {
              ID: "DEBT-042",
              Repo: "X",
              Type: "infra",
              Status: "todo",
              Owner: "unassigned",
              Description: "Follow-up dependency repair",
              "Depends On": "IMP-245, IMP-246",
            },
            {
              ID: "IMP-245",
              Repo: "X",
              Type: "infra",
              Status: "doing",
              Owner: "codexa00",
              Description: "Parent one",
              "Depends On": "",
            },
            {
              ID: "IMP-246",
              Repo: "X",
              Type: "infra",
              Status: "review",
              Owner: "codexa01",
              Description: "Parent two",
              "Depends On": "",
            },
          ],
        },
      ],
      prompt_index: {
        "DEBT-042": "coord/prompts/DEBT-042.md",
      },
      followup_exceptions: {},
    }
  );

  const dependencyBlocker = blockers.find((entry) => entry.code === "dependencies");
  assert.ok(dependencyBlocker);
  assert.deepEqual(dependencyBlocker.next_steps, [
    "coord/scripts/gov explain IMP-245",
    "coord/scripts/gov explain IMP-246",
  ]);
});

test("collectStartReadinessBlockers blocks manual reopen attempts when historical closeout evidence exists", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: "IMP-100",
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: "todo",
            Owner: "unassigned",
            Description: "Legacy ticket manually reset after closeout",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {
      "IMP-100": ["https://github.com/example/repo/pull/100"],
    },
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
    waiver_index: {},
  };

  const blockers = __testing.collectStartReadinessBlockers("IMP-100", board.sections[0].rows[0], board);

  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "closed_ticket_history");
  assert.match(blockers[0].message, /cannot be restarted/i);
  assert.deepEqual(blockers[0].next_steps, [
    'coord/scripts/gov open-followup <NEW-FOLLOWUP-ID> --depends-on IMP-100 --repo B --type bug --pri P1 --description "Follow-up for post-close finding"',
  ]);
});

test("collectStartReadinessBlockers surfaces gov plan --seed when plan state is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-start-readiness-"));
  fs.mkdirSync(path.join(tempDir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "PLAN.md"), "", "utf8");
  withScopedGovernanceTestContext({ PLAN_PATH: path.join(tempDir, "PLAN.md"), PLAN_RECORDS_DIR: path.join(tempDir, "plans") }, () => {
    const blockers = __testing.collectStartReadinessBlockers(
      "DEBT-043",
      {
        ID: "DEBT-043",
        Repo: "B",
        Type: "test",
        Status: "todo",
        Owner: "unassigned",
        Description: "Bootstrap readiness",
        "Depends On": "",
      },
      {
        sections: [
          {
            rows: [
              {
                ID: "DEBT-043",
                Repo: "B",
                Type: "test",
                Status: "todo",
                Owner: "unassigned",
                Description: "Bootstrap readiness",
                "Depends On": "",
              },
            ],
          },
        ],
        prompt_index: {
          "DEBT-043": "coord/prompts/DEBT-043.md",
        },
      }
    );

    const missingPlan = blockers.find((entry) => entry.code === "missing_plan_state");
    assert.ok(missingPlan);
    assert.deepEqual(missingPlan.next_steps, [
      "coord/scripts/gov plan DEBT-043 --seed",
    ]);
  });
});

test("COORD-355: repo-X start readiness advises declared files without blocking", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "declared-files-advisory-"));
  withScopedGovernanceTestContext({ PROMPTS_DIR: path.join(tempDir, "prompts") }, () => {
    const row = { ID: "COORD-998", Repo: "X", Status: "todo", Owner: "unassigned", Description: "coord work" };
    const advisories = __testing.collectStartReadinessAdvisories("COORD-998", row);
    assert.equal(advisories.length, 1);
    assert.equal(advisories[0].code, "repo_x_declared_files_missing");
    assert.match(advisories[0].message, /plan-waves must schedule it alone/);
  });
});

test("COORD-355: declared files from board or prompt suppress repo-X advisory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "declared-files-present-"));
  const promptsDir = path.join(tempDir, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  withScopedGovernanceTestContext({ PROMPTS_DIR: promptsDir }, () => {
    const boardDeclared = {
      ID: "COORD-997",
      Repo: "X",
      Status: "todo",
      Owner: "unassigned",
      Description: "coord work",
      "Declared Files": "coord/engine/scripts/token-economics.js",
    };
    assert.deepEqual(__testing.collectStartReadinessAdvisories("COORD-997", boardDeclared), []);

    fs.writeFileSync(
      path.join(ticketsDir, "COORD-996.md"),
      [
        "# COORD-996",
        "",
        "## Likely Files",
        "",
        "- `coord/engine/docs/MULTI_AGENT_TOPOLOGIES.md`",
      ].join("\n"),
      "utf8"
    );
    const promptDeclared = { ID: "COORD-996", Repo: "X", Status: "todo", Owner: "unassigned", Description: "coord work" };
    assert.deepEqual(__testing.collectStartReadinessAdvisories("COORD-996", promptDeclared), []);
  });
});

test("collectStartReadinessBlockers offers governed follow-up relation repairs for a single blocking dependency", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-start-followup-repair-"));
  fs.mkdirSync(path.join(tempDir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "PLAN.md"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "plans", "DEBT-042.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-042",
    markdown_heading: "## DEBT-042 — 2026-03-29T17:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Repair follow-up guidance."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Follow-up repair guidance must stay governed."],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert guidance change"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T17:00:00.000Z",
  }, null, 2), "utf8");
  withScopedGovernanceTestContext({ PLAN_PATH: path.join(tempDir, "PLAN.md"), PLAN_RECORDS_DIR: path.join(tempDir, "plans") }, () => {
    const blockers = __testing.collectStartReadinessBlockers(
      "DEBT-042",
      {
        ID: "DEBT-042",
        Repo: "X",
        Type: "infra",
        Status: "todo",
        Owner: "unassigned",
        Description: "Follow-up dependency repair",
        "Depends On": "IMP-245",
      },
      {
        sections: [
          {
            rows: [
              {
                ID: "DEBT-042",
                Repo: "X",
                Type: "infra",
                Status: "todo",
                Owner: "unassigned",
                Description: "Follow-up dependency repair",
                "Depends On": "IMP-245",
              },
              {
                ID: "IMP-245",
                Repo: "X",
                Type: "infra",
                Status: "doing",
                Owner: "codexa00",
                Description: "Parent ticket",
                "Depends On": "",
              },
            ],
          },
        ],
        prompt_index: {
          "DEBT-042": "coord/prompts/DEBT-042.md",
        },
        followup_exceptions: {},
      }
    );

    const dependencyBlocker = blockers.find((entry) => entry.code === "dependencies");
    assert.ok(dependencyBlocker);
    assert.match(dependencyBlocker.message, /repair the relation with set-followup-relation/);
    assert.deepEqual(dependencyBlocker.next_steps, [
      "coord/scripts/gov explain IMP-245",
      "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation related",
      "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation closeout-blocker",
    ]);
  });
});

test("evaluateReadiness ignores related follow-up dependencies but still blocks normal ones", () => {
  const byId = new Map([
    ["IMP-245", { ID: "IMP-245", Status: "doing" }],
    ["IMP-246", { ID: "IMP-246", Status: "review" }],
  ]);

  const relatedReadiness = __testing.evaluateReadiness(
    { ID: "DEBT-042", "Depends On": "IMP-245" },
    byId,
    {
      followup_exceptions: {
        "DEBT-042": {
          parent: "IMP-245",
          type: "related-followup",
        },
      },
    }
  );
  assert.equal(relatedReadiness.ready, true);
  assert.deepEqual(relatedReadiness.blockedBy, []);

  const blockingReadiness = __testing.evaluateReadiness(
    { ID: "DEBT-042", "Depends On": "IMP-246" },
    byId,
    { followup_exceptions: {} }
  );
  assert.equal(blockingReadiness.ready, false);
  assert.deepEqual(blockingReadiness.blockedBy, ["IMP-246"]);
});

test("evaluateReadiness surfaces transitive blocker chains for nested dependency graphs", () => {
  const readiness = __testing.evaluateReadiness(
    { ID: "DEBT-047", "Depends On": "IMP-245" },
    new Map([
      ["DEBT-047", { ID: "DEBT-047", Status: "todo", "Depends On": "IMP-245" }],
      ["IMP-245", { ID: "IMP-245", Status: "review", "Depends On": "IMP-246" }],
      ["IMP-246", { ID: "IMP-246", Status: "todo", "Depends On": "" }],
    ]),
    { followup_exceptions: {} }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockedBy, ["IMP-245"]);
  assert.deepEqual(readiness.transitiveBlockedBy.sort(), ["IMP-245", "IMP-246"]);
  assert.deepEqual(readiness.blockerChains, [["IMP-245", "IMP-246"]]);
  assert.deepEqual(readiness.cycles, []);
});

test("evaluateReadiness detects circular dependencies and fails closed", () => {
  const readiness = __testing.evaluateReadiness(
    { ID: "DEBT-047", "Depends On": "DEBT-048" },
    new Map([
      ["DEBT-047", { ID: "DEBT-047", Status: "todo", "Depends On": "DEBT-048" }],
      ["DEBT-048", { ID: "DEBT-048", Status: "todo", "Depends On": "DEBT-047" }],
    ]),
    { followup_exceptions: {} }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockedBy, ["DEBT-048"]);
  assert.deepEqual(readiness.blockerChains, []);
  assert.deepEqual(readiness.cycles, [["DEBT-047", "DEBT-048", "DEBT-047"]]);
});

test("collectStartReadinessBlockers fails closed on a fresh feature stub until startup evidence is explicit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-start-stub-feature-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.ensurePlanStub("IMP-311", "F", "codexa00");
    const blockers = __testing.collectStartReadinessBlockers(
      "IMP-311",
      { ID: "IMP-311", Repo: "F", Type: "feature", Status: "todo" },
      { prompt_index: { "IMP-311": "coord/prompts/implementer.md" }, sections: [{ rows: [{ ID: "IMP-311" }] }] }
    );

    assert.deepEqual(blockers.map((blocker) => blocker.code), ["startup_checklist", "traceability_gate"]);
    const block = fs.readFileSync(planPath, "utf8");
    assert.match(block, /TODO: completed/);
    assert.match(block, /TODO: verified \| closing-gap \| exempt/);
  });
});

test("COORD-814: start baseline evidence requires nonblank Command and Outcome values or a reasoned not-required entry", () => {
  const row = { ID: "T-814", Repo: "X", Type: "test", Status: "todo" };
  const board = { sections: [{ rows: [row] }], prompt_index: { "T-814": "coord/prompts/tickets/T-814.md" } };
  const evaluate = (baseline_reproduction) => {
    const { gate } = readinessGateFixture({
      planState: { startup_checklist: ["completed"], traceability_gate: ["verified"], baseline_reproduction },
    });
    const blocked = gate.collectStartReadinessBlockers(row.ID, row, board)
      .some((issue) => issue.code === "baseline_reproduction");
    let threw = false;
    try {
      gate.assertStartPlanReady(row.ID, row);
    } catch (error) {
      assert.match(error.message, /baseline reproduction/);
      threw = true;
    }
    assert.equal(threw, blocked, `collect and assert paths must agree for ${JSON.stringify(baseline_reproduction)}`);
    return blocked;
  };

  const rejected = [
    ["Command:", "Outcome:"],
    ["Command: ", "Outcome: \t"],
    ["  Command:   ", "  Outcome:  "],
    ["Command: pnpm test", "Outcome:"],
    ["Command:   ", "Outcome: reproduced"],
    ["not-required"],
    ["Not-required:"],
    ["not-required:   "],
    ["Command:", "Outcome:", "Not-required:"],
    // A plan state with no baseline list at all, or with non-text entries, is
    // missing evidence: it must block rather than throw or pass.
    undefined,
    null,
    [null, undefined],
    [null, "Command: pnpm test"],
  ];
  for (const items of rejected) {
    assert.equal(evaluate(items), true, `expected baseline blocker for ${JSON.stringify(items)}`);
  }

  const accepted = [
    ["Command: pnpm test", "Outcome: reproduced"],
    ["command: pnpm test", "OUTCOME: 2 failing assertions"],
    ["Command:pnpm test", "Outcome:reproduced"],
    ["  Command: pnpm test", "  Outcome: reproduced"],
    ["Command:", "Command: pnpm test", "Outcome: reproduced"],
    ["Not-required: new suite; no prior behavior exists to reproduce"],
    ["not-required: docs-only infra note"],
    ["Command:", "Outcome:", "Not-required: nothing to reproduce on a greenfield lane"],
    [null, "Command: pnpm test", undefined, "Outcome: reproduced"],
  ];
  for (const items of accepted) {
    assert.equal(evaluate(items), false, `expected no baseline blocker for ${JSON.stringify(items)}`);
  }

  const { gate } = readinessGateFixture({
    planState: { startup_checklist: ["completed"], traceability_gate: ["verified"], baseline_reproduction: ["Command:", "Outcome:"] },
  });
  const blocker = gate.collectStartReadinessBlockers(row.ID, row, board)
    .find((issue) => issue.code === "baseline_reproduction");
  assert.match(blocker.message, /nonblank/);
  assert.ok(blocker.next_steps.some((step) => /--baseline "Not-required: <reason>"/.test(step)));
});

test("collectStartReadinessBlockers keeps baseline reproduction mandatory for test tickets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-start-stub-test-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.ensurePlanStub("TST-002", "B", "codexa00");
    const blockers = __testing.collectStartReadinessBlockers(
      "TST-002",
      { ID: "TST-002", Repo: "B", Type: "test", Status: "todo" },
      { prompt_index: { "TST-002": "coord/prompts/implementer.md" }, sections: [{ rows: [{ ID: "TST-002" }] }] }
    );

    assert.deepEqual(
      blockers.map((blocker) => blocker.code),
      ["startup_checklist", "traceability_gate", "baseline_reproduction"]
    );
    const block = fs.readFileSync(planPath, "utf8");
    assert.match(block, /TODO: completed/);
    assert.match(block, /TODO: verified \| closing-gap \| exempt/);
    assert.match(block, /TODO: Command: <required for test\/contract\/infra tickets/);
    assert.match(block, /TODO: Outcome: <required for test\/contract\/infra tickets/);
  });
});

test("assertReviewPlanReady fails closed when a canonical record exists but self-review cycles are missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-review-plan-ready-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const boardPath = path.join(tempDir, "tasks.json");
  fs.mkdirSync(recordsDir, { recursive: true });

  fs.writeFileSync(planPath, `## DEBT-021 — 2026-03-25T22:13:17.979Z

- Review round:
  - 1
- Critical invariants:
  - Canonical record should be authoritative.
  - Stale markdown must not satisfy review readiness.
- Repo gates:
  - not-required
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, stale evidence; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 2/3: lens=auth/security/failure modes; diff=manual; risks=auth drift, invalid fallback; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 3/3: lens=tests/operability/performance; diff=manual; risks=missing coverage, false readiness; findings=none; verification=node coord/board/board.js validate; verdict=pass
`, "utf8");

  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  const recordPath = path.join(recordsDir, "DEBT-021.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-021",
    markdown_heading: "## DEBT-021 — 2026-03-25T22:13:17.979Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: canonical record intentionally missing review cycles"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Remove markdown parser enforcement."],
    verification_commands: ["node coord/scripts/governance.test.js"],
    critical_invariants: [
      "Canonical record must remain authoritative once it exists.",
      "Missing canonical self-review cycles must fail closed.",
    ],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-25T22:13:17.983Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    assert.throws(
      () => __testing.assertReviewPlanReady("DEBT-021", { ID: "DEBT-021", Repo: "X", Type: "debt" }),
      (error) => error instanceof GovernanceError && /must record at least 3 self-review cycles/i.test(error.message)
    );
  });
});

// Mutation canary: replacing the production readiness projection with raw
// repo_gates makes the superseded stale pass satisfy this gate and fails below.
test("collectReviewPlanReadinessIssues reports the full missing review-plan stack", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-review-plan-blockers-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-245.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-245",
    markdown_heading: "## IMP-245 — 2026-03-29T22:13:17.979Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: ["Command: pytest -q tests/test_signatures.py", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["services/signature.py"],
    change_summary: ["Enforce functional-area separation of duties for signatures."],
    verification_commands: ["pytest -q tests/test_signatures.py"],
    critical_invariants: [],
    requirement_closure: [],
    repo_gates: ["npm test [result=pass] old head", "TODO: rerun required"],
    evidence_supersessions: (() => {
      const sourceRef = evidenceRef("repo_gate", 1, "npm test [result=pass] old head");
      const successorRef = evidenceRef("repo_gate", 2, "TODO: rerun required");
      return [{ id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
        successor_ref: successorRef, reason: "Old result is stale.", actor: "fixture-agent", timestamp: "2026-10-05T00:00:00.000Z" }];
    })(),
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-03-29T22:13:17.983Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-245", { ID: "IMP-245", Repo: "B", Type: "feature" });
    assert.deepEqual(
      issues.map((issue) => issue.code),
      [
        "critical_invariants",
        "repo_gates",
        "requirement_closure",
        "self_review_cycle_count",
      ]
    );
    assert.match(issues[0].next_steps[0], /--invariant/);
    assert.match(issues[1].next_steps[0], /--repo-gate/);
    assert.match(issues[2].next_steps[0], /--closure/);
    assert.match(issues[3].next_steps[0], /--review-cycle/);
  });
});

function gitShowHead(rel) {
  return require("node:child_process").execFileSync("git", ["show", `HEAD:${rel}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// COORD-830 review: the gate measures only a full SHA equal to the reviewed head
// durable provenance names, so fixtures hand in HEAD's full SHA and bind it.
function reviewedHeadContext() {
  const sha = require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { sourceCommit: sha, resolveReviewedSource: () => ({ sha, label: "the verified PR head" }) };
}

function decompositionRefactorRecord(ticketId, featureProof = []) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-29T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: node --test coord/scripts/governance-validation.test.js", "Outcome: reproduced closeout-proof behavior"],
    prior_findings: [],
    intended_files: ["coord/engine/scripts/lifecycle.js", "coord/engine/scripts/arch-checks.js"],
    change_summary: ["Slim lifecycle.js into a pure composition root by extracting command clusters."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: slim lifecycle composition root", "Implemented: extracted lifecycle helpers", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: featureProof,
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    governance: {},
  };
}

test("collectReviewPlanReadinessIssues blocks slimming refactors without computed decomposition proof", () => {
  const ticketId = "COORD-910";
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-missing",
    ticketId,
    record: decompositionRefactorRecord(ticketId),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }));

  assert.ok(issues.some((issue) => issue.code === "decomposition_proof_missing"));
});

test("collectReviewPlanReadinessIssues fail-closes stale decomposition proof using computed countLoc", () => {
  const ticketId = "COORD-911";
  const lifecyclePath = "coord/engine/scripts/lifecycle.js";
  // COORD-830: with no live lock the proof is measured at the named source commit.
  const actualAfter = countLoc(gitShowHead(lifecyclePath)).loc;
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-stale",
    ticketId,
    record: decompositionRefactorRecord(ticketId, [
      `decomposition-proof: file=${lifecyclePath}; before=3675; after=${actualAfter + 1}; claimed_reduction=1076; target_max=2600; budget=${actualAfter}; extracted=heartbeat, reapGateProcs`,
    ]),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }, reviewedHeadContext()));

  const blocker = issues.find((issue) => issue.code === "decomposition_proof_invalid");
  assert.ok(blocker, "stale proof should block closeout");
  assert.match(blocker.message, /does not match computed countLoc/);
});

test("collectReviewPlanReadinessIssues accepts computed decomposition proof with ratcheted budget", () => {
  const ticketId = "COORD-912";
  const lifecyclePath = "coord/engine/scripts/lifecycle.js";
  // COORD-830: with no live lock the proof is measured at the named source commit.
  const actualAfter = countLoc(gitShowHead(lifecyclePath)).loc;
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-valid",
    ticketId,
    record: decompositionRefactorRecord(ticketId, [
      `decomposition-proof: file=${lifecyclePath}; before=3675; after=${actualAfter}; claimed_reduction=${3675 - actualAfter}; target_max=2600; budget=${actualAfter}; extracted=heartbeat, reapGateProcs, withTemporaryExecutionContext`,
    ]),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }, reviewedHeadContext()));

  const codes = issues.map((issue) => issue.code);
  assert.equal(codes.includes("decomposition_proof_missing"), false);
  assert.equal(codes.includes("decomposition_proof_invalid"), false);
  assert.equal(codes.includes("decomposition_proof_source_unavailable"), false);
});

test("COORD-830: review readiness and assertReviewPlanReady hand the reviewed source commit to the decomposition gate", () => {
  const ticketId = "COORD-914";
  const lifecyclePath = "coord/engine/scripts/lifecycle.js";
  const headLoc = countLoc(gitShowHead(lifecyclePath)).loc;
  const row = { ID: ticketId, Repo: "X", Type: "refactor", Description: "Slim lifecycle.js to a pure composition root by extracting command clusters." };
  const fixture = {
    prefix: "decomp-source",
    ticketId,
    record: { ...decompositionRefactorRecord(ticketId), repo_gates: [
      `decomposition-proof: file=${lifecyclePath}; before=${headLoc + 1}; after=${headLoc}; claimed_reduction=1; budget=${headLoc}; extracted=helpers moved`,
    ] },
  };
  const decompositionCodes = (issues) => issues.map((issue) => issue.code).filter((code) => code.startsWith("decomposition_proof"));
  const unlocked = withGovernanceFixturePaths(fixture, () => __testing.collectReviewPlanReadinessIssues(ticketId, row));
  assert.deepEqual(decompositionCodes(unlocked), ["decomposition_proof_source_unavailable"], "no lock and no source commit refuses");
  const sourced = withGovernanceFixturePaths(fixture, () => __testing.collectReviewPlanReadinessIssues(ticketId, row, reviewedHeadContext()));
  assert.deepEqual(decompositionCodes(sourced), []);
  const symbolic = withGovernanceFixturePaths(fixture, () => __testing.collectReviewPlanReadinessIssues(ticketId, row, { ...reviewedHeadContext(), sourceCommit: "HEAD" }));
  assert.deepEqual(decompositionCodes(symbolic), ["decomposition_proof_source_unavailable"], "HEAD is not reviewed-source evidence");
  const foreign = withGovernanceFixturePaths(fixture, () => __testing.collectReviewPlanReadinessIssues(ticketId, row, { ...reviewedHeadContext(), resolveReviewedSource: () => ({ sha: "f".repeat(40) }) }));
  assert.match(foreign.find((issue) => issue.code === "decomposition_proof_source_unavailable").message, /is not the reviewed head f{40}/, "the readiness collector forwards the provenance resolver to the gate");
  const message = (context) => {
    try {
      withGovernanceFixturePaths(fixture, () => __testing.assertReviewPlanReady(ticketId, row, context));
      return "";
    } catch (error) {
      return error.message;
    }
  };
  assert.match(message(undefined), /Decomposition-proof for COORD-914 cannot be qualified/);
  assert.doesNotMatch(message(reviewedHeadContext()), /Decomposition-proof|decomposition-proof/);
});

test("COORD-826: collectReviewPlanReadinessIssues measures a locked ticket's decomposition proof in its worktree", (t) => {
  const ticketId = "COORD-913";
  const lifecyclePath = "coord/engine/scripts/lifecycle.js";
  const canonicalLoc = countLoc(fs.readFileSync(path.join(process.cwd(), lifecyclePath), "utf8")).loc;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "concord-826-wiring-"));
  const worktree = path.join(workspace, "worktree"), locksDir = path.join(workspace, "locks");
  fs.mkdirSync(path.dirname(path.join(worktree, lifecyclePath)), { recursive: true });
  fs.mkdirSync(locksDir);
  fs.writeFileSync(path.join(worktree, lifecyclePath), "void 0;\n".repeat(canonicalLoc - 68));
  fs.writeFileSync(path.join(locksDir, `${ticketId}.lock`), JSON.stringify({ ticket: ticketId, worktree }));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const issues = withScopedGovernanceTestContext({ LOCKS_DIR: locksDir }, () => withGovernanceFixturePaths({
    prefix: "decomp-worktree",
    ticketId,
    record: { ...decompositionRefactorRecord(ticketId), repo_gates: [
      `decomposition-proof: file=${lifecyclePath}; before=${canonicalLoc}; after=${canonicalLoc - 68}; claimed_reduction=68; budget=${canonicalLoc}; extracted=helpers moved`,
    ] },
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  })));

  assert.deepEqual(issues.filter((issue) => issue.code.startsWith("decomposition_proof")), []);
});

// COORD-153: live-MCP lifecycle enforcement is wired into the move-review /
// closeout readiness gate (collectReviewPlanReadinessIssues). It must (a) add
// live_mcp blockers ONLY when the plan declares a live_mcp operation, and (b)
// leave a normal ticket's readiness byte-identical (no new requirements).
test("collectReviewPlanReadinessIssues enforces live-MCP evidence only for declared live-mcp tickets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-live-mcp-readiness-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  // A complete coord/X (non-product-repo) plan record that otherwise passes the
  // readiness gate, so any extra issue must come from the live-MCP enforcement.
  const baseRecord = {
    schema_version: 1,
    markdown_heading: "## LMCP-1 — 2026-06-24T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    governance: {
      expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["coord/scripts/example.js"],
    change_summary: ["Example coord change."],
    verification_commands: ["node --test coord/scripts/example.test.js"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: example", "Implemented: example"],
    feature_proof: [],
    repo_gates: ["node --test coord/scripts/example.test.js"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract/state invariants",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
      {
        cycle: 2,
        total: 3,
        lens: "auth/security/failure modes",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=auth/security/failure modes; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
      {
        cycle: 3,
        total: 3,
        lens: "tests/operability/performance",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=tests/operability/performance; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    security_surface: "coord-only",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
  };

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    // (a) NORMAL ticket (no live_mcp): readiness has zero issues, and crucially
    // no live_mcp_* code is ever introduced.
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-1.json"),
      JSON.stringify({ ...baseRecord, ticket_id: "LMCP-1" }, null, 2),
      "utf8"
    );
    const normalIssues = __testing.collectReviewPlanReadinessIssues("LMCP-1", { ID: "LMCP-1", Repo: "X", Type: "feature" });
    assert.deepEqual(normalIssues, []);
    assert.equal(normalIssues.filter((issue) => issue.code.startsWith("live_mcp")).length, 0);

    // (b) DECLARED live-mcp ticket missing required evidence: the same gate now
    // lists the missing live-MCP items as blockers.
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-2.json"),
      JSON.stringify({
        ...baseRecord,
        ticket_id: "LMCP-2",
        markdown_heading: "## LMCP-2 — 2026-06-24T00:00:00.000Z",
        live_mcp: { operation_class: "read_sensitive", adapter: "db", operation: "q", environment: "prod", scope: "client=X" },
      }, null, 2),
      "utf8"
    );
    const liveIssues = __testing.collectReviewPlanReadinessIssues("LMCP-2", { ID: "LMCP-2", Repo: "X", Type: "feature" });
    const liveCodes = liveIssues.map((issue) => issue.code);
    // read_sensitive with no redaction and no receipt -> both required.
    assert.ok(liveCodes.includes("live_mcp_redaction"));
    assert.ok(liveCodes.includes("live_mcp_receipt"));

    // (c) DECLARED live-mcp ticket with full evidence -> ready (no live_mcp codes).
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-3.json"),
      JSON.stringify({
        ...baseRecord,
        ticket_id: "LMCP-3",
        markdown_heading: "## LMCP-3 — 2026-06-24T00:00:00.000Z",
        live_mcp: {
          operation_class: "read_sensitive",
          adapter: "db",
          operation: "q",
          environment: "prod",
          scope: "client=X",
          redaction: "masked",
          approval: "human-admin",
          receipt_path: "coord/evidence/live-mcp/q.json",
        },
        context_pack_ack: contextPackAck({
          considered: {
            active_constraints: ["live-MCP operation constraints checked"],
            open_questions: ["none"],
          },
          closeout_learning: {
            decision: "scratch-only",
            scratch_only: ["live-MCP receipt is ticket-local evidence only"],
          },
        }),
      }, null, 2),
      "utf8"
    );
    const readyIssues = __testing.collectReviewPlanReadinessIssues("LMCP-3", { ID: "LMCP-3", Repo: "X", Type: "feature" });
    assert.deepEqual(readyIssues, []);
  });
});

test("collectReviewPlanReadinessIssues allows bounded repair tickets to pass with three focused review cycles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-review-plan-bounded-pass-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-246.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-246",
    markdown_heading: "## IMP-246 — 2026-04-04T20:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    governance: {
      expected_closeout: {
        method: "pr",
        base_ref: "dev",
        provenance_note: null,
      },
      review_profile: "bounded_repair",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test:reports", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["apps/ops-web/app/reports/data.ts", "apps/ops-web/app/reports/data.test.ts"],
    change_summary: ["Repair report fallback handling without widening product scope."],
    verification_commands: ["pnpm test:reports"],
    critical_invariants: ["business-context investigation: not-required", "Fallback reports must not throw without an actor.", "Report defaults must still use tenant-local date boundaries."],
    requirement_closure: ["Ticket ask: fix reports fallback", "Implemented: fixed fallback guard", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        active_constraints: ["report fallback constraints checked"],
        business_rules: ["business-context investigation: not-required"],
      },
      closeout_learning: {
        decision: "none",
        rationale: "No new durable business learning was produced.",
      },
    }),
    feature_proof: ["path:apps/ops-web/app/reports/data.ts"],
    repo_gates: ["pnpm test:reports"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract/state invariants",
        diff: "git diff -- apps/ops-web/app/reports/data.ts",
        risks: ["fallback state drift", "timezone regression"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=git diff -- apps/ops-web/app/reports/data.ts; risks=fallback state drift, timezone regression; findings=none; verification=pnpm test:reports; verdict=pass",
      },
      {
        cycle: 2,
        total: 3,
        lens: "auth/security/failure modes",
        diff: "git diff -- apps/ops-web/app/reports/data.ts",
        risks: ["unauthenticated crash", "permission bypass"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=auth/security/failure modes; diff=git diff -- apps/ops-web/app/reports/data.ts; risks=unauthenticated crash, permission bypass; findings=none; verification=pnpm test:reports; verdict=pass",
      },
      {
        cycle: 3,
        total: 3,
        lens: "tests/operability/performance",
        diff: "git diff -- apps/ops-web/app/reports/data.test.ts",
        risks: ["regression gap", "test runtime drift"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=tests/operability/performance; diff=git diff -- apps/ops-web/app/reports/data.test.ts; risks=regression gap, test runtime drift; findings=none; verification=pnpm test:reports; verdict=pass",
      },
    ],
    rollback_strategy: ["revert reports fallback repair"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-04-04T20:00:00.000Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-246", { ID: "IMP-246", Repo: "F", Type: "bug" });
    assert.deepEqual(issues, []);
  });
});

test("collectReviewPlanReadinessIssues rejects bounded repair profile when the repair scope is not actually bounded", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-review-plan-bounded-reject-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-247.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-247",
    markdown_heading: "## IMP-247 — 2026-04-04T20:30:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    governance: {
      expected_closeout: {
        method: "pr",
        base_ref: "dev",
        provenance_note: null,
      },
      review_profile: "bounded_repair",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    change_summary: ["Broader change still marked as bounded repair."],
    verification_commands: ["pnpm test old head", "TODO: rerun on the reviewed head"],
    critical_invariants: ["invariant 1", "invariant 2"],
    requirement_closure: ["Ticket ask: broader change", "Implemented: broader change", "Not implemented: follow-up", "Deferred to: FE-999", "Closeout verdict: complete"],
    feature_proof: ["path:a.ts"],
    repo_gates: ["pnpm test old head", "TODO: rerun repo gate on the reviewed head"],
    evidence_supersessions: (() => {
      const source = evidenceRef("verification_command", 1, "pnpm test old head");
      const successor = evidenceRef("verification_command", 2, "TODO: rerun on the reviewed head");
      const gateSource = evidenceRef("repo_gate", 1, "pnpm test old head");
      const gateSuccessor = evidenceRef("repo_gate", 2, "TODO: rerun repo gate on the reviewed head");
      return [{ id: stableSupersessionId(source, successor), kind: "verification_command", source_ref: source,
        successor_ref: successor, reason: "The result used a stale reviewed head.", actor: "fixture-agent",
        timestamp: "2026-10-05T00:00:00.000Z" },
      { id: stableSupersessionId(gateSource, gateSuccessor), kind: "repo_gate", source_ref: gateSource,
        successor_ref: gateSuccessor, reason: "The result used a stale reviewed head.", actor: "fixture-agent",
        timestamp: "2026-10-05T00:00:01.000Z" }];
    })(),
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-04-04T20:30:00.000Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-247", { ID: "IMP-247", Repo: "F", Type: "bug" });
    assert.equal(issues[0].code, "bounded_repair_ineligible");
    assert.match(issues[0].message, /1-3 intended files/);
    assert.match(issues[0].message, /Not implemented: none/);
    assert.match(issues[0].message, /Deferred to: none/);
    assert.match(issues[0].message, /direct regression verification commands/, "a superseded stale command cannot satisfy the bounded-repair verification requirement");
  });
});

test("COORD-713: bounded-repair profile rejects empty scope and superseded-only current evidence", () => {
  const record = lightLaneDocsRecord("IMP-248", [], {
    governance: { expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null }, review_profile: "bounded_repair", ticket_local_repairs: [] },
    verification_commands: ["node --test old.test.js", "TODO: rerun verification"],
    repo_gates: ["npm test old head", "TODO: rerun gate"],
    evidence_supersessions: (() => {
      const verifySource = evidenceRef("verification_command", 1, "node --test old.test.js");
      const verifyNext = evidenceRef("verification_command", 2, "TODO: rerun verification");
      const gateSource = evidenceRef("repo_gate", 1, "npm test old head");
      const gateNext = evidenceRef("repo_gate", 2, "TODO: rerun gate");
      return [
        { id: stableSupersessionId(verifySource, verifyNext), kind: "verification_command", source_ref: verifySource, successor_ref: verifyNext, reason: "stale", actor: "fixture-agent", timestamp: "2026-10-05T00:00:00.000Z" },
        { id: stableSupersessionId(gateSource, gateNext), kind: "repo_gate", source_ref: gateSource, successor_ref: gateNext, reason: "stale", actor: "fixture-agent", timestamp: "2026-10-05T00:00:01.000Z" },
      ];
    })(),
  });
  const issues = withGovernanceFixturePaths({ prefix: "coord713-bounded-empty", ticketId: "IMP-248", record }, () =>
    __testing.collectReviewPlanReadinessIssues("IMP-248", { ID: "IMP-248", Repo: "F", Type: "bug" }));
  const eligibility = issues.find((issue) => issue.code === "bounded_repair_ineligible");
  assert.ok(eligibility, "empty repair scope must fail the selected bounded-repair profile");
  assert.match(eligibility.message, /1-3 intended files/);
  assert.match(eligibility.message, /direct regression verification commands/);
  assert.match(eligibility.message, /recorded repo gates/);
  assert.ok(issues.some((issue) => issue.code === "repo_gates"), "superseded stale gate cannot satisfy the current closeout gate");
});

test("COORD-713: review-closeout factory accepts legacy plans with omitted optional arrays", () => {
  const gate = createReviewCloseoutGate({
    coordDir: path.join(__dirname, "..", "..", "scripts"),
    effectiveTierMinimum: (_tier, _field, fallback) => fallback,
    fieldHasMeaningfulValue: (value) => Array.isArray(value) ? value.some((entry) => String(entry || "").trim()) : Boolean(String(value || "").trim()),
    isMeaningfulText: (value) => Boolean(String(value || "").trim()),
    isTestingInfrastructureTicket: () => false,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => true,
    resolveTicketTier: () => ({ tier: "standard" }),
    classifyReviewLensBuckets: () => [],
    normalizeReviewVerdict: (value) => String(value || "").toLowerCase(),
  });
  const bounded = gate.collectBoundedRepairEligibilityIssues({}, {
    not_implemented: "none", deferred_to: "none",
  });
  assert.ok(bounded.some((issue) => /1-3 intended files/.test(issue)), "missing intended_files is an ineligible bounded repair");
  assert.ok(bounded.some((issue) => /direct regression verification commands/.test(issue)));
  assert.ok(bounded.some((issue) => /recorded repo gates/.test(issue)));

  const closure = {
    ticket_ask: "the requested behavior", implemented: "the change is implemented",
    not_implemented: "none", deferred_to: "none", closeout_verdict: "complete",
  };
  const common = { ticketId: "IMP-248", row: { ID: "IMP-248", Repo: "F", Type: "bug" },
    planState: {}, board: { metadata: {} }, requirementClosure: closure };
  const fullLane = gate.collectClosureReadinessIssues(common.ticketId, common.row, common.planState, common.board, {
    productRepo: true, requirementClosure: closure, lightLane: false,
  });
  assert.ok(fullLane.some((issue) => issue.code === "critical_invariants"), "omitted critical_invariants defaults to an empty list");
  assert.ok(fullLane.some((issue) => issue.code === "feature_proof"), "omitted feature_proof defaults to an empty list");
  const lightLane = gate.collectClosureReadinessIssues(common.ticketId, common.row, common.planState, common.board, {
    productRepo: true, requirementClosure: closure, lightLane: true,
  });
  assert.equal(lightLane.some((issue) => issue.code === "critical_invariants"), false, "light lane uses the reduced invariant minimum");
  const closureWithoutRationale = gate.collectRequirementClosureIssues(common.ticketId, common.row, {}, { lightLane: true });
  assert.match(closureWithoutRationale.closureIssues[0].message, /must record a one-line rationale/);
  const implementationRationale = gate.collectRequirementClosureIssues(common.ticketId, common.row,
    { implemented: "Clarified the setup guide." }, { lightLane: true });
  assert.deepEqual(implementationRationale.closureIssues, []);
});

// ===========================================================================
// COORD-166: type:docs / chore LIGHT LANE — reduced plan-completeness for
// reference/design docs, with a HARD carve-out for procedural-doc surfaces.
// ===========================================================================

function withGovernanceFixturePaths(fixture, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `legacy-${fixture.prefix}-`));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: fixture.metadata || {},
    sections: fixture.sections || [],
    review_findings: fixture.review_findings || {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(recordsDir, `${fixture.ticketId}.json`), JSON.stringify(fixture.record, null, 2), "utf8");

  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, fn);
}

test("review readiness enforces configured feature proofs and keeps supported exemptions", () => {
  const ticketId = "FE-998";
  const metadata = { feature_proof_required_from_ticket: { F: "FE-990" } };
  const makeRecord = (id, overrides = {}) => businessContextGateRecord(id, {
    intended_files: ["src/feature.ts"],
    critical_invariants: ["The feature contract remains stable.", "Invalid feature input is rejected."],
    feature_proof: [],
    ...overrides,
  });
  const row = {
    ID: ticketId,
    Repo: "F",
    Type: "feature",
    Description: "Implement the feature contract.",
  };

  withGovernanceFixturePaths({
    prefix: "review-closeout-proof-required",
    ticketId,
    metadata,
    record: makeRecord(ticketId),
  }, () => {
    const missing = __testing.collectReviewPlanReadinessIssues(ticketId, row);
    const proofIssue = missing.find((issue) => issue.code === "feature_proof");
    assert.ok(proofIssue, "an after-threshold product feature without proofs must block move-review");
    assert.match(proofIssue.message, /canonical.*Feature proof/i);
    assert.ok(proofIssue.next_steps.some((step) => step.includes("--feature-proof")));

    fs.writeFileSync(
      path.join(state.PLAN_RECORDS_DIR, `${ticketId}.json`),
      JSON.stringify(makeRecord(ticketId, { feature_proof: ["path:src/feature.ts"] }), null, 2),
      "utf8",
    );
    const valid = __testing.collectReviewPlanReadinessIssues(ticketId, row);
    assert.equal(valid.some((issue) => issue.code === "feature_proof"), false,
      "a meaningful canonical proof satisfies the configured requirement");
  });

  withGovernanceFixturePaths({
    prefix: "review-closeout-proof-before-threshold",
    ticketId: "FE-989",
    metadata,
    record: makeRecord("FE-989"),
  }, () => {
    const beforeThreshold = __testing.collectReviewPlanReadinessIssues("FE-989", {
      ...row,
      ID: "FE-989",
    });
    assert.equal(beforeThreshold.some((issue) => issue.code === "feature_proof"), false,
      "the cutoff does not impose proof on an earlier product ticket");
  });

  withGovernanceFixturePaths({
    prefix: "review-closeout-proof-testing-infrastructure",
    ticketId,
    metadata,
    record: makeRecord(ticketId),
  }, () => {
    const infrastructure = __testing.collectReviewPlanReadinessIssues(ticketId, {
      ...row,
      Description: "Add testing infrastructure for the supported test lanes.",
    });
    assert.equal(infrastructure.some((issue) => issue.code === "feature_proof"), false,
      "the real testing-infrastructure classifier exempts infrastructure work");
  });

  withGovernanceFixturePaths({
    prefix: "review-closeout-proof-light-lane",
    ticketId,
    metadata,
    record: makeRecord(ticketId, { intended_files: ["README.md"], repo_gates: [] }),
  }, () => {
    const referenceDoc = __testing.collectReviewPlanReadinessIssues(ticketId, {
      ...row,
      Type: "docs",
      Description: "Clarify the feature reference documentation.",
    });
    assert.equal(referenceDoc.some((issue) => issue.code === "feature_proof"), false,
      "product-repo reference documentation remains in the approved light lane");
    assert.equal(referenceDoc.some((issue) => issue.code === "repo_gates"), true,
      "the light lane still blocks when the valid empty repo-gate list has no disposition");
  });
});

// A minimal but VALID single self-review cycle (structured, non-shallow,
// passing) — the floor the light lane still requires.
const LIGHT_LANE_VALID_CYCLE = {
  cycle: 1,
  total: 1,
  lens: "requirement closure",
  diff: "git diff -- coord/docs/SOME_DESIGN.md",
  risks: ["stale reference", "broken internal link"],
  findings: "none",
  verification: "node coord/board/board.js validate",
  verdict: "pass",
  raw: "lens=requirement closure; diff=git diff -- coord/docs/SOME_DESIGN.md; risks=stale reference, broken internal link; findings=none; verification=node coord/board/board.js validate; verdict=pass",
};

function lightLaneDocsRecord(ticketId, intendedFiles, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-24T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: docs change"],
    prior_findings: [],
    intended_files: intendedFiles,
    change_summary: ["Update reference/design documentation."],
    verification_commands: ["node coord/board/board.js validate"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: refresh the design doc"],
    feature_proof: [],
    repo_gates: ["node coord/board/board.js validate"],
    self_review_cycles: [LIGHT_LANE_VALID_CYCLE],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

function standardCoordReviewCycles() {
  return [
    {
      cycle: 1,
      total: 3,
      lens: "contract/state invariants",
      diff: "git diff -- coord/engine/scripts/governance-validation.js",
      risks: ["missing context gate", "false positive blocker"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=contract/state invariants; diff=git diff -- coord/engine/scripts/governance-validation.js; risks=missing context gate, false positive blocker; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
    {
      cycle: 2,
      total: 3,
      lens: "auth/security/failure modes",
      diff: "git diff -- coord/engine/scripts/governance-validation.js",
      risks: ["implementation accident treated as intent", "uncertain finding becomes todo"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=auth/security/failure modes; diff=git diff -- coord/engine/scripts/governance-validation.js; risks=implementation accident treated as intent, uncertain finding becomes todo; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
    {
      cycle: 3,
      total: 3,
      lens: "tests/operability/performance",
      diff: "git diff -- coord/scripts/governance-validation.test.js",
      risks: ["stale pack path", "board intake status drift"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=tests/operability/performance; diff=git diff -- coord/scripts/governance-validation.test.js; risks=stale pack path, board intake status drift; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
  ];
}

function contextPackAck(overrides = {}) {
  return {
    refs: [],
    considered: {
      active_constraints: ["none"],
      adrs: ["none"],
      business_rules: ["none"],
      conflicts: ["none"],
      stale_warnings: ["none"],
      open_questions: ["none"],
      ...(overrides.considered || {}),
    },
    authority: {
      constraints: ["confirmed/current sources only"],
      advisory_only: ["candidate, inferred, stale, private, rejected, and conflicted claims kept advisory"],
      ...(overrides.authority || {}),
    },
    closeout_learning: {
      decision: "none",
      promote: [],
      demote: [],
      scratch_only: [],
      rationale: "No reusable learning created.",
      ...(overrides.closeout_learning || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["considered", "authority", "closeout_learning"].includes(key))),
  };
}

function businessContextGateRecord(ticketId, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-27T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: ["backend/src/invoices/post.ts"],
    change_summary: ["Change invoice approval workflow behavior."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: ["Approval behavior must preserve business intent.", "Unknown business rules must not govern implementation."],
    requirement_closure: ["Ticket ask: change invoice workflow", "Implemented: added behavior", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        active_constraints: ["invoice approval constraints checked"],
        business_rules: ["confirmed/current invoice rules only"],
      },
    }),
    feature_proof: ["path:coord/engine/scripts/governance-validation.js"],
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function adrDecisionRecord(ticketId, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-27T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: ["coord/engine/scripts/governance-validation.js"],
    change_summary: ["Change governance policy for high-impact decisions."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: ["High-impact governance policy changes must be backed by decision evidence."],
    adr_refs: [],
    requirement_closure: ["Ticket ask: change governance policy", "Implemented: added guidance", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        adrs: ["decision surface checked"],
      },
    }),
    feature_proof: ["path:coord/engine/scripts/governance-validation.js"],
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

test("collectReviewPlanReadinessIssues blocks high-risk behavior tickets without business context evidence", () => {
  const ticketId = "BCTX-001";
  const issues = withGovernanceFixturePaths({
    prefix: "business-context-gate-",
    ticketId,
    record: businessContextGateRecord(ticketId, { context_pack_ack: undefined }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.ok(issues.some((issue) => issue.code === "business_context_gate"));
  assert.ok(issues.some((issue) => issue.code === "context_pack_ack"));
});

test("collectReviewPlanReadinessIssues ignores tickets without business-context risk signals", () => {
  const ticketId = "BCTX-002";
  const issues = withGovernanceFixturePaths({
    prefix: "business-context-safe-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      intended_files: ["coord/docs/README.md"],
      change_summary: ["Refresh developer documentation wording."],
      critical_invariants: ["Docs remain readable.", "Links stay valid."],
      requirement_closure: ["Ticket ask: docs wording", "Implemented: docs wording", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Refresh developer documentation wording.",
  }));
  assert.equal(issues.some((issue) => issue.code === "business_context_gate"), false);
  assert.equal(issues.some((issue) => issue.code === "business_context_proposed_intake"), false);
});

test("collectReviewPlanReadinessIssues routes uncertain business-context findings through proposed intake", () => {
  const ticketId = "BCTX-003";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-ref-"));
  const packPath = path.join(dir, "BCTX-003.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    proposed_ticket_recommendations: [
      {
        source_record_id: "BD-REC-CONFLICT",
        suggested_type: "spike",
        suggested_priority: "P1",
        statement: "Imported invoices can skip approval.",
      },
    ],
  }, null, 2), "utf8");

  const missingProposalIssues = withGovernanceFixturePaths({
    prefix: "business-context-proposed-missing-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.ok(missingProposalIssues.some((issue) => issue.code === "business_context_proposed_intake"));

  const proposedRows = [{
    name: "Proposed",
    rows: [
      {
        ID: "BCTX-PROP-1",
        Repo: "X",
        Type: "spike",
        Pri: "P1",
        Status: "proposed",
        Owner: "unassigned",
        Description: "BD-REC-CONFLICT: investigate imported invoice approval exception.",
      },
    ],
  }];
  const proposedIssues = withGovernanceFixturePaths({
    prefix: "business-context-proposed-present-",
    ticketId,
    sections: proposedRows,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.equal(proposedIssues.some((issue) => issue.code === "business_context_proposed_intake"), false);
});

test("COORD-367: an explicit investigation disposition neutralizes proposed-ticket findings", () => {
  const ticketId = "BCTX-367";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord367-"));
  const packPath = path.join(dir, "BCTX-367.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    proposed_ticket_recommendations: [
      { source_record_id: "BD-REC-CONFLICT", suggested_type: "spike", suggested_priority: "P1", statement: "Imported invoices can skip approval." },
    ],
  }, null, 2), "utf8");

  // A pack ref but NO disposition -> the proposed-ticket finding still blocks.
  const blocked = withGovernanceFixturePaths({
    prefix: "coord367-nodisp-", ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [`business-context: ${packPath}`, "Unknown business rules must not govern implementation."],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, { ID: ticketId, Repo: "X", Type: "feature", Description: "Change invoice approval workflow." }));
  assert.ok(blocked.some((i) => i.code === "business_context_proposed_intake"), "no disposition -> findings block");

  // The SAME pack with an explicit investigation disposition -> findings neutralized.
  const neutralized = withGovernanceFixturePaths({
    prefix: "coord367-disp-", ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "business-context investigation: not-required",
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, { ID: ticketId, Repo: "X", Type: "feature", Description: "Change invoice approval workflow." }));
  assert.equal(neutralized.some((i) => i.code === "business_context_proposed_intake"), false, "explicit disposition neutralizes proposed-ticket findings");
});

// COORD-807: the gates each re-resolve the plan state they are handed, so the
// state readiness projects once must stay resolvable. These run the REAL
// readiness path with the REAL gate registry on plans corrected by the real
// writers; calling one gate in isolation cannot see a projected state.
test("COORD-807 review readiness assesses a retracted plan end to end instead of throwing", () => {
  const ticketId = "RETR-001";
  const row = { ID: ticketId, Repo: "X", Type: "feature", Description: "Change invoice approval workflow." };
  const disposition = "business-context investigation: not-required";
  const correction = { actor: "fixture-agent", timestamp: "2026-10-13T00:00:00.000Z" };
  const base = businessContextGateRecord(ticketId, {
    critical_invariants: [disposition, "decision status: investigating fixture-owner", "Approval behavior must preserve business intent.", "Unknown business rules must not govern implementation."],
    repo_gates: ["node --test stale-head.test.js"],
    self_review_cycles: standardCoordReviewCycles().map((cycle, index) => (index === 0 ? { ...cycle, findings: "new ADR: not required" } : cycle)),
  });
  const readiness = (record, prefix, ticketRow = row) => withGovernanceFixturePaths({ prefix, ticketId, record }, () =>
    __testing.collectReviewPlanReadinessIssues(ticketId, ticketRow));
  const codes = (issues) => issues.map((issue) => issue.code);

  assert.deepEqual(readiness(base, "coord807-uncorrected"), [], "the uncorrected fixture is review-ready");

  // The ONLY invariant carrying the business-context disposition is retracted:
  // it stays in history but no longer satisfies the gate that required it.
  const onlyMatchRetracted = applyInvariantRetraction(base, { ...correction, entry: disposition, reason: "investigation is required after all" }).record;
  assert.equal(onlyMatchRetracted.critical_invariants.includes(disposition), true, "retraction is append-only");
  assert.equal(resolvePlanEvidence(onlyMatchRetracted).critical_invariants.includes(disposition), false);
  assert.deepEqual(codes(readiness(onlyMatchRetracted, "coord807-only-match")), ["business_context_gate"]);

  // On a product repo, retracting below the tier minimum reports the count gap:
  // the retracted entries are still recorded but do not count toward it.
  const productRow = { ...row, Repo: "B" };
  const belowMinimum = ["Approval behavior must preserve business intent.", "Unknown business rules must not govern implementation."]
    .reduce((record, entry) => applyInvariantRetraction(record, { ...correction, entry, reason: "wrong scope" }).record, base);
  assert.equal(belowMinimum.critical_invariants.length, 4);
  assert.equal(resolvePlanEvidence(belowMinimum).critical_invariants.length, 2);
  const productBaseline = codes(readiness(base, "coord807-product-uncorrected", productRow));
  assert.equal(productBaseline.includes("critical_invariants"), false);
  assert.deepEqual(codes(readiness(belowMinimum, "coord807-product-at-minimum", productRow)), productBaseline);
  const oneActive = applyInvariantRetraction(belowMinimum, { ...correction, entry: "decision status: investigating fixture-owner", reason: "decision made" }).record;
  assert.ok(codes(readiness(oneActive, "coord807-below-minimum", productRow)).includes("critical_invariants"),
    "one active invariant cannot meet the two-invariant minimum however many are recorded");

  // A retraction that leaves the requirement satisfied stays review-ready, also
  // when the same plan carries a supersession.
  const harmless = applyInvariantRetraction({ ...base, critical_invariants: [...base.critical_invariants, "Retired invariant."] },
    { ...correction, entry: "Retired invariant.", reason: "no longer applies" }).record;
  assert.deepEqual(readiness(harmless, "coord807-harmless"), []);
  const both = applySupersession(harmless, { ...correction, kind: "repo_gate", entry: "node --test stale-head.test.js", replacement: "node --test current-head.test.js", reason: "rerun on the current head" }).record;
  assert.equal(both.evidence_supersessions.length, 1);
  assert.equal(both.evidence_dispositions.length, 1);
  assert.deepEqual(readiness(both, "coord807-both"), []);
  const bothMissing = applyInvariantRetraction(both, { ...correction, entry: disposition, reason: "investigation is required after all" }).record;
  assert.deepEqual(codes(readiness(bothMissing, "coord807-both-missing")), ["business_context_gate"]);
});

test("COORD-348 requires context-pack acknowledgement for high-risk work", () => {
  const ticketId = "CTXACK-001";
  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-ack-missing-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: undefined,
      critical_invariants: [
        "business-context investigation: investigated by product owner",
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_ack"));
});

test("COORD-348 requires explicit handling of context-pack conflict, stale, and open-question sections", () => {
  const ticketId = "CTXACK-002";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-mandatory-"));
  const packPath = path.join(dir, "CTXACK-002.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    sections: {
      conflicts: { items: [{ id: "BD-REC-CONFLICT", statement: "approval rule conflicts" }] },
      stale_sources: { items: [{ id: "BD-REC-STALE", statement: "old approval source" }] },
      open_questions: { items: [{ id: "BD-Q-1", statement: "who owns exception approval?" }] },
    },
  }, null, 2), "utf8");

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-ack-mandatory-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: contextPackAck({
        refs: [packPath],
        considered: {
          active_constraints: ["confirmed/current invoice approval constraints"],
          business_rules: ["confirmed/current approval rules"],
          conflicts: ["none"],
          stale_warnings: ["none"],
          open_questions: ["none"],
        },
      }),
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  const mandatory = issues.find((issue) => issue.code === "context_pack_ack_mandatory_sections");
  assert.ok(mandatory, `expected mandatory section blocker, got ${JSON.stringify(issues.map((issue) => issue.code))}`);
  assert.match(mandatory.message, /conflicts/);
  assert.match(mandatory.message, /stale_warnings/);
  assert.match(mandatory.message, /open_questions/);
});

test("COORD-348 blocks advisory memory when cited as implementation authority", () => {
  const ticketId = "CTXACK-003";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-advisory-"));
  const packPath = path.join(dir, "CTXACK-003.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    sections: {
      conflicts: { items: [{ id: "BD-REC-CONFLICT", statement: "approval rule conflicts" }] },
      stale_sources: { items: [] },
      open_questions: { items: [] },
    },
  }, null, 2), "utf8");

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-advisory-authority-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: contextPackAck({
        refs: [packPath],
        considered: {
          conflicts: ["handled: kept advisory pending proposed spike"],
        },
        authority: {
          constraints: ["BD-REC-CONFLICT"],
          advisory_only: [],
        },
      }),
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_advisory_authority"));
});

test("COORD-348 requires closeout learning disposition in context-pack acknowledgement", () => {
  const ticketId = "CTXACK-004";
  const ack = contextPackAck();
  delete ack.closeout_learning;

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-closeout-learning-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: ack,
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_closeout_learning"));
});

test("COORD-322 blocks high-impact decision tickets without accepted ADR refs or waiver", () => {
  const ticketId = "ADRREQ-001";
  const issues = withGovernanceFixturePaths({
    prefix: "adr-required-missing-",
    ticketId,
    record: adrDecisionRecord(ticketId),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change governance policy for high-impact tickets.",
  }));
  const issue = issues.find((entry) => entry.code === "adr_required");
  assert.ok(issue, `expected adr_required issue, got ${JSON.stringify(issues.map((entry) => entry.code))}`);
  assert.match(issue.message, /accepted ADR ref/i);
});

test("COORD-322 accepts explicit decision waiver or investigation status for high-impact work", () => {
  const waiverTicket = "ADRREQ-002";
  const waiverIssues = withGovernanceFixturePaths({
    prefix: "adr-required-waiver-",
    ticketId: waiverTicket,
    record: adrDecisionRecord(waiverTicket, {
      decision_required: {
        required: true,
        status: "waived",
        reason: "security boundary change is intentionally waived for one ticket",
        waiver: "human-admin approved ticket-scoped waiver",
      },
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(waiverTicket, {
    ID: waiverTicket,
    Repo: "X",
    Type: "feature",
    Description: "Change security boundary policy.",
  }));
  assert.equal(waiverIssues.some((entry) => entry.code === "adr_required"), false);

  const investigationTicket = "ADRREQ-003";
  const investigationIssues = withGovernanceFixturePaths({
    prefix: "adr-required-investigation-",
    ticketId: investigationTicket,
    record: adrDecisionRecord(investigationTicket, {
      decision_required: {
        required: true,
        status: "investigating",
        reason: "cross-repo contract decision still in discovery",
        owner: "architecture-owner",
      },
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(investigationTicket, {
    ID: investigationTicket,
    Repo: "X",
    Type: "spike",
    Description: "Investigate cross-repo contract options.",
  }));
  assert.equal(investigationIssues.some((entry) => entry.code === "adr_required"), false);
});

test("COORD-322 accepts an ADR ref only when the registry record is accepted", () => {
  const decisionsReadmePath = path.join(__dirname, "..", "..", "docs", "decisions", "README.md");
  const adrPath = path.join(__dirname, "..", "..", "docs", "decisions", "0001-resource-aware-multi-agent-test-architecture.md");
  const originalReadme = fs.readFileSync(decisionsReadmePath, "utf8");
  const originalAdr = fs.readFileSync(adrPath, "utf8");
  try {
    fs.writeFileSync(adrPath, originalAdr.replace("- **Status:** Deferred", "- **Status:** Accepted"), "utf8");
    fs.writeFileSync(
      decisionsReadmePath,
      originalReadme.replace("| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Deferred |", "| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Accepted |"),
      "utf8"
    );
    const ticketId = "ADRREQ-004";
    const issues = withGovernanceFixturePaths({
      prefix: "adr-required-accepted-",
      ticketId,
      record: adrDecisionRecord(ticketId, { adr_refs: ["ADR-0001"] }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.equal(issues.some((entry) => entry.code === "adr_required"), false);
  } finally {
    fs.writeFileSync(adrPath, originalAdr, "utf8");
    fs.writeFileSync(decisionsReadmePath, originalReadme, "utf8");
  }
});

test("COORD-324 requires ADR-aware review answers and closeout citation for decision-required work", () => {
  const decisionsReadmePath = path.join(__dirname, "..", "..", "docs", "decisions", "README.md");
  const adrPath = path.join(__dirname, "..", "..", "docs", "decisions", "0001-resource-aware-multi-agent-test-architecture.md");
  const originalReadme = fs.readFileSync(decisionsReadmePath, "utf8");
  const originalAdr = fs.readFileSync(adrPath, "utf8");
  try {
    fs.writeFileSync(adrPath, originalAdr.replace("- **Status:** Deferred", "- **Status:** Accepted"), "utf8");
    fs.writeFileSync(
      decisionsReadmePath,
      originalReadme.replace("| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Deferred |", "| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Accepted |"),
      "utf8"
    );

    const ticketId = "ADRREQ-324";
    const missingIssues = withGovernanceFixturePaths({
      prefix: "adr-aware-review-missing-",
      ticketId,
      record: adrDecisionRecord(ticketId, { adr_refs: ["ADR-0001"] }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.ok(missingIssues.some((entry) => entry.code === "adr_review_cycle"));
    assert.ok(missingIssues.some((entry) => entry.code === "adr_closeout_citation"));

    const readyIssues = withGovernanceFixturePaths({
      prefix: "adr-aware-review-ready-",
      ticketId,
      record: adrDecisionRecord(ticketId, {
        adr_refs: ["ADR-0001"],
        requirement_closure: [
          "Ticket ask: change governance policy",
          "Implemented: added guidance",
          "Not implemented: none",
          "Deferred to: none",
          "ADR compliance: follows ADR-0001 by preserving exact-commit landing evidence.",
          "Closeout verdict: complete",
        ],
        self_review_cycles: [
          ...standardCoordReviewCycles(),
          {
            cycle: 4,
            total: 4,
            lens: "ADR compliance",
            diff: "governance decision gate",
            risks: ["ADR drift", "rejected alternative regression"],
            findings: "ADR compliance: follows ADR-0001. Rejected alternatives: does not violate rejected shared-evidence broker. Revisit trigger: not triggered. New ADR: not required.",
            verification: "node --test coord/scripts/governance-validation.test.js",
            verdict: "pass",
            raw: "lens=ADR compliance; diff=governance decision gate; risks=ADR drift, rejected alternative regression; findings=ADR compliance: follows ADR-0001. Rejected alternatives: does not violate rejected shared-evidence broker. Revisit trigger: not triggered. New ADR: not required.; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
          },
        ],
      }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.equal(readyIssues.some((entry) => entry.code === "adr_required"), false);
    assert.equal(readyIssues.some((entry) => entry.code === "adr_review_cycle"), false);
    assert.equal(readyIssues.some((entry) => entry.code === "adr_closeout_citation"), false);
  } finally {
    fs.writeFileSync(adrPath, originalAdr, "utf8");
    fs.writeFileSync(decisionsReadmePath, originalReadme, "utf8");
  }
});

test("COORD-324 leaves ordinary low-risk tickets free of ADR review ceremony", () => {
  const ticketId = "ADRSAFE-324";
  const issues = withGovernanceFixturePaths({
    prefix: "adr-safe-low-risk-",
    ticketId,
    record: adrDecisionRecord(ticketId, {
      intended_files: ["coord/docs/README.md"],
      change_summary: ["Local wording maintenance."],
      critical_invariants: ["Existing behavior is preserved."],
      requirement_closure: ["Ticket ask: docs wording", "Implemented: docs wording", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "docs",
    Description: "Local wording maintenance.",
  }));
  assert.equal(issues.some((entry) => entry.code === "adr_review_cycle"), false);
  assert.equal(issues.some((entry) => entry.code === "adr_closeout_citation"), false);
});

test("COORD-322 leaves ordinary bug docs and test tickets unblocked by ADR guidance", () => {
  for (const type of ["bug", "docs", "test"]) {
    const suffix = { bug: "001", docs: "002", test: "003" }[type];
    const ticketId = `ADRSAFE-${suffix}`;
    const issues = withGovernanceFixturePaths({
      prefix: `adr-safe-${type}-`,
      ticketId,
      record: adrDecisionRecord(ticketId, {
        intended_files: ["coord/docs/README.md"],
        change_summary: ["Local wording or regression-only maintenance."],
        critical_invariants: ["Existing behavior is preserved."],
        requirement_closure: ["Ticket ask: local maintenance", "Implemented: local maintenance", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: type,
      Description: "Local maintenance.",
    }));
    assert.equal(issues.some((entry) => entry.code === "adr_required"), false, `${type} should not require ADR`);
  }
});

test("COORD-322 deriveGovernanceReadiness surfaces missing ADR guidance in explain output", () => {
  const readiness = __testing.deriveGovernanceReadiness(
    "ADRREQ-005",
    { ID: "ADRREQ-005", Repo: "X", Type: "feature", Description: "Change RBAC permission model." },
    { metadata: {}, sections: [] },
    null,
    adrDecisionRecord("ADRREQ-005", {
      change_summary: ["Change RBAC permission model."],
    })
  );
  assert.equal(readiness.decision_required.required, true);
  assert.equal(readiness.decision_required.satisfied, false);
  assert.match(readiness.decision_required.reason, /RBAC|rbac|permission/i);
});

test("COORD-166 isLightLaneEligible: docs ticket touching reference/design docs is light-lane eligible", () => {
  const decision = validationLeaf.isLightLaneEligible(
    { Type: "docs" },
    ["README.md", "CHANGELOG.md", "coord/engine/docs/MEMORY_ARCHITECTURE.md"]
  );
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /reference-doc/i);
});

test("COORD-166 isLightLaneEligible: chore touching only a reference doc is eligible", () => {
  assert.equal(validationLeaf.isLightLaneEligible({ Type: "chore" }, ["coord/engine/docs/QUALITY_DIMENSIONS.md"]).eligible, true);
});

test("COORD-166 isLightLaneEligible: HARD carve-out — procedural-doc surfaces are NOT eligible", () => {
  for (const procedural of [
    "AGENTS.md",
    "coord/AGENTS.md",
    "CLAUDE.md",
    "coord/GOVERNANCE.md",
    ".claude/commands/code-writer.md",
    "frontend/AGENTS.md",
  ]) {
    const decision = validationLeaf.isLightLaneEligible({ Type: "docs" }, ["README.md", procedural]);
    assert.equal(decision.eligible, false, `${procedural} must force the full lane`);
    assert.match(decision.reason, /procedural/i);
  }
});

test("COORD-166 isLightLaneEligible: non-docs/chore ticket is never light-lane eligible", () => {
  for (const type of ["feature", "bug", "task", "spike", "refactor", "test"]) {
    assert.equal(validationLeaf.isLightLaneEligible({ Type: type }, ["README.md"]).eligible, false);
  }
});

test("COORD-166 isLightLaneEligible: fails toward FULL lane when no changed paths are recorded", () => {
  const decision = validationLeaf.isLightLaneEligible({ Type: "docs" }, []);
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /no changed/i);
});

test("COORD-166 isProceduralDocPath matches behavior-defining surfaces and not plain reference docs", () => {
  assert.equal(validationLeaf.isProceduralDocPath("AGENTS.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath("coord/AGENTS.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath("CLAUDE.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath("coord/GOVERNANCE.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath(".claude/commands/planner.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath("nested/.claude/x.md"), true);
  assert.equal(validationLeaf.isProceduralDocPath("README.md"), false);
  assert.equal(validationLeaf.isProceduralDocPath("CHANGELOG.md"), false);
  assert.equal(validationLeaf.isProceduralDocPath("coord/engine/docs/MEMORY_ARCHITECTURE.md"), false);
});

test("COORD-166 (a) docs reference-doc ticket passes review readiness under the reduced light lane", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-light-pass",
    ticketId: "DOC-900",
    record: lightLaneDocsRecord("DOC-900", ["README.md", "coord/engine/docs/MEMORY_ARCHITECTURE.md", "CHANGELOG.md"]),
  }, () => __testing.collectReviewPlanReadinessIssues("DOC-900", { ID: "DOC-900", Repo: "X", Type: "docs" }));
  assert.deepEqual(issues, [], `light-lane docs ticket should have no blockers, got: ${JSON.stringify(issues)}`);
});

test("COORD-166 (b) docs ticket touching a procedural-doc surface is NOT eligible and requires the FULL lane", () => {
  // Same reduced evidence as the passing light-lane case, but the intended
  // files include GOVERNANCE.md / AGENTS.md / .claude — this MUST fall back to
  // the full lane and therefore block on the missing full self-review ceremony.
  for (const procedural of ["coord/GOVERNANCE.md", "coord/AGENTS.md", ".claude/commands/code-writer.md", "CLAUDE.md"]) {
    const issues = withGovernanceFixturePaths({
      prefix: "coord166-procedural-full",
      ticketId: "DOC-901",
      record: lightLaneDocsRecord("DOC-901", ["README.md", procedural]),
    }, () => __testing.collectReviewPlanReadinessIssues("DOC-901", { ID: "DOC-901", Repo: "X", Type: "docs" }));
    const codes = issues.map((i) => i.code);
    assert.ok(
      codes.includes("self_review_cycle_count"),
      `procedural surface ${procedural} must require the full self-review ceremony; got codes ${JSON.stringify(codes)}`
    );
  }
});

test("COORD-166 (c) feature/code ticket is unaffected — full lane enforced exactly as before", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-feature-unaffected",
    ticketId: "IMP-902",
    metadata: { feature_proof_required_from_ticket: { B: "IMP-900" } },
    record: {
      schema_version: 1,
      ticket_id: "IMP-902",
      markdown_heading: "## IMP-902 — 2026-06-24T00:00:00.000Z",
      startup_checklist: ["completed"],
      traceability_gate: ["verified"],
      review_round: 1,
      baseline_reproduction: ["Command: pytest -q", "Outcome: reproduced"],
      prior_findings: [],
      intended_files: ["services/widget.py"],
      change_summary: ["Add widget."],
      verification_commands: ["pytest -q"],
      critical_invariants: [],
      requirement_closure: [],
      repo_gates: [],
      self_review_cycles: [],
      rollback_strategy: ["revert"],
      security_surface: "yes",
      synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
    },
  }, () => __testing.collectReviewPlanReadinessIssues("IMP-902", { ID: "IMP-902", Repo: "B", Type: "feature" }));
  // Byte-identical to the pre-existing full-lane "missing stack" expectation.
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["critical_invariants", "repo_gates", "requirement_closure", "feature_proof", "self_review_cycle_count"]
  );
  assert.match(issues.find((issue) => issue.code === "feature_proof").next_steps[0], /--feature-proof/);
});

test("COORD-166 (d) the light lane never removes attribution/repo-gate — a docs ticket with NO repo gate still blocks", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-light-keeps-gate",
    ticketId: "DOC-903",
    record: lightLaneDocsRecord("DOC-903", ["README.md", "coord/docs/SOME_DESIGN.md"], { repo_gates: [] }),
  }, () => __testing.collectReviewPlanReadinessIssues("DOC-903", { ID: "DOC-903", Repo: "X", Type: "docs" }));
  assert.ok(
    issues.some((i) => i.code === "repo_gates"),
    `light lane must still require a repo-gate equivalent; got ${JSON.stringify(issues.map((i) => i.code))}`
  );
});

test("COORD-166 deriveGovernanceReadiness surfaces the active_lane decision in explain output", () => {
  const lightRow = { ID: "DOC-904", Repo: "X", Type: "docs", Description: "doc" };
  const lightReadiness = __testing.deriveGovernanceReadiness(
    "DOC-904",
    lightRow,
    { metadata: {}, sections: [] },
    null,
    { startup_checklist: ["completed"], intended_files: ["README.md", "coord/docs/X.md"], repo_gates: ["node coord/board/board.js validate"], self_review_cycles: [LIGHT_LANE_VALID_CYCLE], governance: {} }
  );
  assert.equal(lightReadiness.active_lane.lane, "light");
  assert.equal(lightReadiness.active_lane.light_lane_eligible, true);

  const proceduralReadiness = __testing.deriveGovernanceReadiness(
    "DOC-905",
    { ID: "DOC-905", Repo: "X", Type: "docs", Description: "doc" },
    { metadata: {}, sections: [] },
    null,
    { startup_checklist: ["completed"], intended_files: ["coord/GOVERNANCE.md"], governance: {} }
  );
  assert.equal(proceduralReadiness.active_lane.lane, "full");
  assert.match(proceduralReadiness.active_lane.reason, /procedural/i);
});

test("COORD-924: finalize and land re-check a recorded selected-suite repo gate at the reviewed head", () => {
  const ticketId = "COORD-924";
  const entry = `affected-selection run /nonexistent/selection.manifest.json - result=pass tier=T1 suites=3 tree=${"a".repeat(40)} base=${"b".repeat(40)} input_digest=sha256:${"c".repeat(64)}`;
  const record = { ...decompositionRefactorRecord(ticketId), repo_gates: [entry] };
  const issues = withGovernanceFixturePaths({ prefix: "selection-recheck", ticketId, record }, () =>
    __testing.collectReviewPlanReadinessIssues(ticketId, { ID: ticketId, Repo: "X", Type: "feature", Description: "selection evidence" }, reviewedHeadContext()));
  const blocker = issues.find((issue) => issue.code === "affected_selection_evidence");
  assert.ok(blocker, JSON.stringify(issues.map((i) => i.code)));
  assert.match(blocker.message, /no longer holds at [0-9a-f]{40}: the recorded selection manifest \/nonexistent\/selection\.manifest\.json cannot be read\. Re-run the gate\./);
  const row = { ID: ticketId, Repo: "X", Type: "feature", Description: "selection evidence" };
  const atHead = withGovernanceFixturePaths({ prefix: "selection-recheck-head", ticketId, record }, () =>
    __testing.collectReviewPlanReadinessIssues(ticketId, row, { resolveReviewedSource: () => null }));
  assert.match(atHead.find((issue) => issue.code === "affected_selection_evidence").message, /no longer holds at HEAD: /, "without a reviewed source the workspace HEAD is re-checked");
  const noGates = { ...record };
  delete noGates.repo_gates;
  const none = withGovernanceFixturePaths({ prefix: "selection-recheck-none", ticketId, record: noGates }, () =>
    __testing.collectReviewPlanReadinessIssues(ticketId, row, reviewedHeadContext()));
  assert.equal(none.some((issue) => issue.code === "affected_selection_evidence"), false, "no repo gates, nothing to re-check");

  // The composition root may have no locked workspace after submit. Keep the
  // selection bound to the best available repository rather than the caller cwd.
  const { createReviewPlanReadiness } = require("./review-plan-readiness.js");
  const landing = require("./affected-landing.js");
  const originalRecheck = landing.recheckSelectionEntries;
  const calls = [];
  landing.recheckSelectionEntries = (options) => { calls.push(options); return []; };
  try {
    const coordDir = path.resolve(__dirname, "..", "..");
    const deps = {
      COORD_DIR: coordDir, readLatestPlanBlock: () => null,
      readPlanRecord: () => ({ review_round: 0, repo_gates: [entry] }),
      readBoard: () => ({}), inferRequiredReviewRound: () => 0,
      integerOrDefault: (value) => value, parseRequirementClosureEntries: () => [],
      normalizeGovernancePlanShape: () => ({}), isRepoBackedCode: () => false,
      resolveTicketLightLane: () => ({ eligible: false }),
      collectGatePlanReadinessIssues: () => [], collectDecompositionProofIssues: () => [],
      collectClosureReadinessIssues: () => [], buildReviewCycleSnapshots: () => [],
      collectSelfReviewCycleIssues: () => [], reviewGateRegistry: { run: () => [] },
      buildLiveMcpLifecycle: () => ({ issues: [] }),
      buildBootstrapViaLiveMcpLifecycle: () => ({ issues: [] }),
    };
    for (const [context, expectedRoot] of [
      [{ worktree: "/private/ticket", repoRoot: "/private/repo" }, "/private/ticket"],
      [{ repoRoot: "/private/repo" }, "/private/repo"],
      [{}, path.dirname(coordDir)],
      [null, path.dirname(coordDir)],
    ]) {
      const readiness = createReviewPlanReadiness({ ...deps, resolveTicketGitContext: () => context });
      assert.deepEqual(readiness.collectReviewPlanReadinessIssues(ticketId, row), []);
      assert.equal(calls.at(-1).root, expectedRoot);
      assert.equal(calls.at(-1).head, "HEAD");
      assert.equal(calls.at(-1).boardPath, undefined);
    }
    createReviewPlanReadiness(deps).collectReviewPlanReadinessIssues(ticketId, row, { sourceCommit: "reviewed-source" });
    assert.equal(calls.at(-1).root, path.dirname(coordDir));
    assert.equal(calls.at(-1).head, "reviewed-source");
  } finally {
    landing.recheckSelectionEntries = originalRecheck;
  }
});

// COORD-977: a ticket that adds a non-test module, helper or guard must carry a
// lens=reuse self-review cycle that names a searched module and a reuse verdict.
function reuseReviewCycle(findings, overrides = {}) {
  const cycle = {
    cycle: 4,
    total: 4,
    lens: "reuse",
    diff: "new reuse probe module",
    risks: ["duplicate helper", "missed existing guard"],
    findings,
    verification: "node --test coord/scripts/governance-validation.test.js",
    verdict: "pass",
    ...overrides,
  };
  return { ...cycle, raw: `lens=${cycle.lens}; diff=${cycle.diff}; risks=${cycle.risks.join(", ")}; findings=${cycle.findings}; verification=${cycle.verification}; verdict=${cycle.verdict}` };
}

function reuseFixtureRecord(ticketId, cycles) {
  return adrDecisionRecord(ticketId, {
    intended_files: ["coord/engine/scripts/reuse-probe.js"],
    change_summary: ["Add a reuse probe module."],
    self_review_cycles: cycles,
  });
}

const REUSE_ADDED_SURFACE = Object.freeze({ modules: ["coord/engine/scripts/reuse-probe.js"], guards: [], helpers: [] });

function reuseIssuesFor(ticketId, record, addedSurface) {
  return withGovernanceFixturePaths({
    prefix: `reuse-${ticketId.toLowerCase()}-`,
    ticketId,
    record,
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Add reuse probe helper.",
  }, { addedSurface })).filter((issue) => issue.code.startsWith("reuse_review_cycle"));
}

test("COORD-977 requires a lens=reuse self-review cycle when the ticket adds a non-test module", () => {
  const issues = reuseIssuesFor("REUSE-001", reuseFixtureRecord("REUSE-001", standardCoordReviewCycles()), REUSE_ADDED_SURFACE);
  assert.deepEqual(issues.map((issue) => issue.code), ["reuse_review_cycle"]);
  assert.match(issues[0].message, /reuse-probe\.js/);
});

test("COORD-977 accepts a compliant reuse cycle that names a searched module and a reuse verdict", () => {
  const compliant = reuseReviewCycle("searched: coord/engine/scripts/gates/adr.js and coord/engine/scripts/review-lens-catalog.js; reused: the ADR gate cycle shape");
  const issues = reuseIssuesFor("REUSE-002", reuseFixtureRecord("REUSE-002", [...standardCoordReviewCycles(), compliant]), REUSE_ADDED_SURFACE);
  assert.deepEqual(issues, []);
});

test("COORD-977 reports a shallow reuse cycle that names no searched module or no verdict", () => {
  const noModule = reuseReviewCycle("looked around the gates; reused the existing pattern");
  const noModuleIssues = reuseIssuesFor("REUSE-003", reuseFixtureRecord("REUSE-003", [...standardCoordReviewCycles(), noModule]), REUSE_ADDED_SURFACE);
  assert.deepEqual(noModuleIssues.map((issue) => issue.code), ["reuse_review_cycle_shallow"]);

  const noVerdict = reuseReviewCycle("searched: coord/engine/scripts/gates/adr.js; all good");
  const noVerdictIssues = reuseIssuesFor("REUSE-004", reuseFixtureRecord("REUSE-004", [...standardCoordReviewCycles(), noVerdict]), REUSE_ADDED_SURFACE);
  assert.deepEqual(noVerdictIssues.map((issue) => issue.code), ["reuse_review_cycle_shallow"]);
});

test("COORD-977 treats a new-module verdict as deep only when it states why nothing existing fits", () => {
  const bareNew = reuseReviewCycle("searched: coord/engine/scripts/gates/adr.js; new");
  const bareNewIssues = reuseIssuesFor("REUSE-005", reuseFixtureRecord("REUSE-005", [...standardCoordReviewCycles(), bareNew]), REUSE_ADDED_SURFACE);
  assert.deepEqual(bareNewIssues.map((issue) => issue.code), ["reuse_review_cycle_shallow"]);

  const reasonedNew = reuseReviewCycle("searched: coord/engine/scripts/gates/adr.js; new because no existing gate parses the probe shape");
  const reasonedIssues = reuseIssuesFor("REUSE-006", reuseFixtureRecord("REUSE-006", [...standardCoordReviewCycles(), reasonedNew]), REUSE_ADDED_SURFACE);
  assert.deepEqual(reasonedIssues, []);
});

test("COORD-977 requires no reuse cycle when the diff adds no non-test module, helper or guard", () => {
  const issues = reuseIssuesFor("REUSE-007", reuseFixtureRecord("REUSE-007", standardCoordReviewCycles()), { modules: [], guards: [], helpers: [] });
  assert.deepEqual(issues, []);
});

test("COORD-977 detects added modules, guards and helpers from the submission diff only", () => {
  const { detectAddedReusableSurface } = require("./review-plan-readiness.js");
  const { gitFixture } = require("./test-git-fixture.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-surface-"));
  const env = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (args) => gitFixture(repo, args, { env });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text, "utf8");
  };
  gitFixture(repo, ["init", "-q", "-b", "dev"], { env });
  write("coord/engine/scripts/existing.js", "const x = 1;\n");
  write("coord/engine/scripts/deleted.js", "// guard:removed-marker\nfunction removedHelper() {}\n");
  write("coord/engine/governance-guards.json", "{\n  \"guards\": []\n}\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  git(["checkout", "-q", "-b", "ticket"]);
  git(["rm", "coord/engine/scripts/deleted.js"]);
  write("coord/engine/scripts/reuse-probe.js", "function probeHelper() { return 1; }\nmodule.exports = { probeHelper };\n");
  write("coord/engine/scripts/reuse-probe.test.js", "module.exports = {};\n");
  write("coord/engine/scripts/existing.js", "const x = 1;\n// guard:reuse-probe-marker\nfunction addedHelper() { return x; }\n");
  write("coord/engine/governance-guards.json", "{\n  \"guards\": [\n    {\n      \"id\": \"reuse-probe-guard\"\n    }\n  ]\n}\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "ticket"]);
  try {
    const surface = detectAddedReusableSurface(repo, "origin/dev");
    assert.deepEqual(surface.modules, ["coord/engine/scripts/reuse-probe.js"]);
    assert.deepEqual(surface.guards, ["reuse-probe-guard", "reuse-probe-marker"]);
    assert.deepEqual(surface.helpers, ["addedHelper", "probeHelper"]);

    // COORD-977 fail-closed: an unresolvable base is a blocker naming the remedy, never an empty surface.
    assert.throws(() => detectAddedReusableSurface(repo, "origin/no-such-branch"), (error) => {
      assert.equal(error.code, "reuse_review_base_unresolved");
      assert.match(error.message, /git fetch origin no-such-branch/);
      return true;
    });
    assert.throws(() => detectAddedReusableSurface(path.join(repo, "missing-worktree"), "origin/dev"));

    git(["checkout", "-q", "-b", "docs-only", "origin/dev"]);
    write("coord/docs/notes.md", "# notes\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "docs"]);
    assert.deepEqual(detectAddedReusableSurface(repo, "origin/dev"), { modules: [], guards: [], helpers: [] });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("COORD-977 reuses the shared integration base resolver: local fallback works, a fully unresolved base fails closed", () => {
  const { detectAddedReusableSurface } = require("./review-plan-readiness.js");
  const { gitFixture } = require("./test-git-fixture.js");
  const env = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const commitFile = (repo, rel, text, message) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text, "utf8");
    gitFixture(repo, ["add", "-A"], { env });
    gitFixture(repo, ["commit", "-q", "-m", message], { env });
  };
  const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-base-local-"));
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-base-none-"));
  try {
    // Local dev only, no origin/dev: the shared resolver falls back to the local branch.
    gitFixture(localRepo, ["init", "-q", "-b", "dev"], { env });
    commitFile(localRepo, "base.txt", "base\n", "base");
    gitFixture(localRepo, ["checkout", "-q", "-b", "ticket"], { env });
    commitFile(localRepo, "coord/engine/scripts/local-fallback.js", "module.exports = {};\n", "ticket");
    assert.deepEqual(detectAddedReusableSurface(localRepo, "origin/dev").modules, ["coord/engine/scripts/local-fallback.js"]);

    // Neither origin/dev nor local dev exists: fail closed with the shared remedy.
    gitFixture(emptyRepo, ["init", "-q", "-b", "ticket"], { env });
    commitFile(emptyRepo, "coord/engine/scripts/orphan.js", "module.exports = {};\n", "ticket");
    assert.throws(() => detectAddedReusableSurface(emptyRepo, "origin/dev"), (error) => {
      assert.equal(error.code, "reuse_review_base_unresolved");
      assert.match(error.message, /git fetch origin dev/);
      return true;
    });
  } finally {
    fs.rmSync(localRepo, { recursive: true, force: true });
    fs.rmSync(emptyRepo, { recursive: true, force: true });
  }
});

test("COORD-977 gate blocks with reuse_review_base_unresolved and the fetch remedy", () => {
  const gate = createReviewCloseoutGate({
    coordDir: path.join(__dirname, "..", ".."),
    effectiveTierMinimum: () => 3,
    fieldHasMeaningfulValue: () => true,
    isMeaningfulText: (value) => Boolean(String(value || "").trim()),
    isTestingInfrastructureTicket: () => false,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => false,
    resolveTicketTier: () => ({ tier: "standard" }),
    classifyReviewLensBuckets: () => [],
    normalizeReviewVerdict: () => "pass",
  });
  const issues = gate.collectReuseReviewCycleIssues({
    ticketId: "REUSE-008",
    cycles: [],
    surfaceError: "Cannot resolve integration branch dev: neither origin/dev nor local dev exists. Remedy: `git fetch origin dev`",
    surfaceCode: "reuse_review_base_unresolved",
  });
  assert.deepEqual(issues.map((issue) => issue.code), ["reuse_review_base_unresolved"]);
  assert.match(issues[0].next_steps.join("\n") + issues[0].message, /git fetch origin dev/);

  const incompleteRecords = gate.collectReuseReviewCycleIssues({
    ticketId: "REUSE-008",
    cycles: [{ findings: "searched coord/engine/scripts/gates/adr.js; reused" }, { lens: "reuse" }],
    addedSurface: REUSE_ADDED_SURFACE,
  });
  assert.deepEqual(incompleteRecords.map((issue) => issue.code), ["reuse_review_cycle_shallow"]);
});
