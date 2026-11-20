process.env.COORD_PROJECT_CONFIG = require("node:path").resolve(__dirname, "fixtures", "hermetic-project.config.js"); // COORD-967: hermetic board/integration branch defaults
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const resolve = (relativePath) => resolveEngineModule(path.resolve(__dirname, "..", ".."), relativePath);

const createPlanRecords = require("./plan-records.js");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const { mergeUniqueRefs } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/landing-gh.js"));
const createGovernancePlanShape = require("./governance-plan-shape.js");
const createGovernanceValidation = require("./governance-validation.js");
const { integerOrDefault, escapeRegex, toArray } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const { DEFAULT_INTEGRATION_BRANCH } = require("../../paths.js");
const { parseFeatureProofEntry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-resolution.js"));
const { createFeatureProofNormalization } = require(resolve("scripts/feature-proof-audit.js"));
const { createFeatureProofEntryValidator } = require(resolve("scripts/feature-proof-entry-validation.js"));
const { __testing, GovernanceError, withGovernedSurfaceSandbox, withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { state: governanceState, DEFAULT_PATHS } = require("./governance-context.js");
const { evidenceRef, stableSupersessionId, applyInvariantRetraction, resolvePlanEvidence } = require(resolve("scripts/plan-evidence-supersession.js"));
const validationOwner = createGovernanceValidation({
  GovernanceError,
  fail: (message) => { throw new GovernanceError(message); },
  integerOrDefault,
  escapeRegex,
  toArray,
  isMeaningfulText: (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return Boolean(normalized) && !normalized.includes("todo");
  },
});

// COORD-090/COORD-071: feature-proof normalization infers a ticket's repo from
// its id prefix. The relocated proof-normalization tests below pass no
// board/row context, so their ticket ids must use a prefix that maps to repo B
// under whichever config-matrix leg is running (default "MSRV", non-default
// "API"). Derive a B-mapped prefix from the active registry.
const B_TICKET_PREFIX =
  Object.entries(DEFAULT_PATHS.ticketPrefixToRepoCode || {}).find(([, code]) => code === "B")?.[0] || "MSRV";

function createReadonlyPlanRecordHarness(overrides = {}) {
  const repoCodeForTicket = (ticketId) => repoRegistryOwner.inferRepoCodeFromTicketId(ticketId);
  const planShape = createGovernancePlanShape({
    state: governanceState,
    REPO_INTEGRATION_BRANCHES: DEFAULT_PATHS.repoIntegrationBranches,
    DEFAULT_INTEGRATION_BRANCH,
    isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
    repoNameForCode: repoRegistryOwner.repoNameForCode,
    toArray,
  });
  const { normalizeFeatureProofEntryForTicket } = createFeatureProofNormalization({
    parseFeatureProofEntry,
    resolveRepoCodeForTicket: (ticketId, row) => row?.Repo || repoCodeForTicket(ticketId),
    repoPrefixesForCode: repoRegistryOwner.repoPrefixesForCode,
  });
  const { validateFeatureProofEntry } = createFeatureProofEntryValidator({
    fail: (message) => { throw new GovernanceError(message); },
  });
  return createPlanRecords({
    fail: (message) => {
      throw new GovernanceError(message);
    },
    resolveRepoCodeForTicket: repoCodeForTicket,
    buildDefaultGovernancePlan: planShape.buildDefaultGovernancePlan,
    normalizeGovernancePlanShape: planShape.normalizeGovernancePlanShape,
    formatGovernancePlanEntry: planShape.formatGovernancePlanEntry,
    formatGovernanceReviewProfileEntry: planShape.formatGovernanceReviewProfileEntry,
    formatGovernanceRepairEntry: planShape.formatGovernanceRepairEntry,
    parseGovernancePlanEntries: planShape.parseGovernancePlanEntries,
    scaffoldSelfReviewCycle: planShape.scaffoldSelfReviewCycle,
    resolveRepoIntegrationBranch: repoRegistryOwner.resolveRepoIntegrationBranch,
    isTestingInfrastructureTicket: () => false,
    todayIso: () => "2026-01-01",
    escapeTable: (value) => String(value || ""),
    toArray,
    normalizeSelfReviewCycleLine: validationOwner.normalizeSelfReviewCycleLine,
    parseSelfReviewCycles: validationOwner.parseSelfReviewCycles,
    validateRequirementClosureEntry: validationOwner.validateRequirementClosureEntry,
    validateFeatureProofEntry,
    normalizeFeatureProofEntryForTicket,
    isMeaningfulText: validationOwner.isMeaningfulText,
    escapeRegex,
    integerOrDefault,
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => null,
    inferRequiredReviewRound: validationOwner.inferRequiredReviewRound,
    normalizeOwnerValue: (value) => String(value || ""),
    repoNameForCode: repoRegistryOwner.repoNameForCode,
    ensurePlanStub: () => null,
    mergeUniqueRefs,
    isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
    ...overrides,
  });
}

const planRecordOwner = createReadonlyPlanRecordHarness();

function writePlanTargetRecord(recordsDir, ticketId, intendedFiles) {
  const block = [
    `## ${ticketId} — 2026-10-24T12:00:00Z`,
    "",
    "- Intended files:",
    ...intendedFiles.map((file) => `  - \`${file}\``),
    "- Change summary:",
    "  - Exercise coord-only review routing.",
    "- Security surface:",
    "  - no",
    "",
  ].join("\n");
  const record = planRecordOwner.parsePlanBlockToRecord(ticketId, block);
  fs.writeFileSync(path.join(recordsDir, `${ticketId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

test("planTargetsCoordOnlyArtifacts distinguishes empty, coord-only, and mixed intended paths", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord825-plan-targets-"));
  try {
    withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: recordsDir }, () => {
      writePlanTargetRecord(recordsDir, "DOC-825", []);
      writePlanTargetRecord(recordsDir, "DOC-826", ["coord/scripts/example.js", "coord"]);
      writePlanTargetRecord(recordsDir, "DOC-827", ["coord/board/tasks.json", "backend/src/index.js"]);

      assert.equal(planRecordOwner.planTargetsCoordOnlyArtifacts("DOC-825"), false,
        "empty intended paths do not qualify as a coord-only plan");
      assert.equal(planRecordOwner.planTargetsCoordOnlyArtifacts("DOC-826"), true,
        "every intended path under coord qualifies");
      assert.equal(planRecordOwner.planTargetsCoordOnlyArtifacts("DOC-827"), false,
        "one product-repo path prevents the coord-only classification");
    });
  } finally {
    fs.rmSync(recordsDir, { recursive: true, force: true });
  }
});

test("parsePlanBlockToRecord normalizes a markdown PLAN block into structured canonical state", () => {
  const block = `## IMP-221 — 2026-03-25T17:30:00Z

- Startup checklist:
  - completed
- Traceability gate:
  - closing-gap
- Review round:
  - 1
- Baseline reproduction:
  - Command: not-required
  - Outcome: governance drift already reproduced
- Intended files:
  - \`coord/board/plans/IMP-221.json\`
- Change summary:
  - Introduce structured plan records.
- Verification commands:
  - \`node --test coord/scripts/governance.test.js\`
- Critical invariants:
  - Canonical plan state must survive markdown drift.
- Repo gates:
  - not-required
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, parser mismatch; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass
- Rollback strategy:
  - revert
- Security surface:
  - no
`;

  const record = planRecordOwner.parsePlanBlockToRecord("IMP-221", block);
  assert.equal(record.schema_version, 1);
  assert.equal(record.ticket_id, "IMP-221");
  assert.deepEqual(record.startup_checklist, ["completed"]);
  assert.deepEqual(record.traceability_gate, ["closing-gap"]);
  assert.equal(record.review_round, 1);
  assert.deepEqual(record.intended_files, ["coord/board/plans/IMP-221.json"]);
  assert.deepEqual(record.verification_commands, ["node --test coord/scripts/governance.test.js"]);
  assert.equal(record.self_review_cycles.length, 1);
  assert.deepEqual(record.self_review_cycles[0].risks, ["state drift", "parser mismatch"]);
});

test("syncPlanRecordFromBlock writes a canonical per-ticket JSON record", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-record-"));
  const block = `## IMP-221 — 2026-03-25T17:31:00Z

- Startup checklist:
  - completed
- Traceability gate:
  - closing-gap
- Baseline reproduction:
  - Command: not-required
  - Outcome: already reproduced
- Intended files:
  - \`coord/board/plans/IMP-221.json\`
- Change summary:
  - Introduce structured plan records.
- Verification commands:
  - \`node --test coord/scripts/governance.test.js\`
- Critical invariants:
  - Canonical plan state must survive markdown drift.
- Repo gates:
  - not-required
- Rollback strategy:
  - revert
- Security surface:
  - no
`;

  withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: tempDir }, () => {
    planRecordOwner.syncPlanRecordFromBlock("IMP-221", block, tempDir);
  });
  const recordPath = path.join(tempDir, "IMP-221.json");
  assert.equal(fs.existsSync(recordPath), true);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(record.ticket_id, "IMP-221");
  assert.deepEqual(record.change_summary, ["Introduce structured plan records."]);
});

test("renderPlanRecordBlock rebuilds a compatible PLAN.md block from canonical state", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: coord/scripts/gov explain DEBT-043", "Outcome: bootstrap seam reproduced"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Repair canonical plan bootstrap fallback."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain the source of truth."],
    requirement_closure: ["Ticket ask: bootstrap", "Implemented: bootstrap", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 1,
        lens: "bootstrap",
        diff: "manual",
        risks: ["plan drift"],
        findings: "none",
        verification: "node --test coord/scripts/governance.test.js",
        verdict: "pass",
        raw: "lens=bootstrap; diff=manual; risks=plan drift; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      },
    ],
    rollback_strategy: ["revert bootstrap helper"],
    security_surface: "no",
  };

  const block = planRecordOwner.renderPlanRecordBlock(record);
  const reparsed = planRecordOwner.parsePlanBlockToRecord("DEBT-043", block);

  assert.equal(reparsed.ticket_id, "DEBT-043");
  assert.deepEqual(reparsed.startup_checklist, ["completed"]);
  assert.deepEqual(reparsed.traceability_gate, ["exempt"]);
  assert.deepEqual(reparsed.baseline_reproduction, ["Command: coord/scripts/gov explain DEBT-043", "Outcome: bootstrap seam reproduced"]);
  assert.deepEqual(reparsed.intended_files, ["coord/scripts/governance.js"]);
  assert.deepEqual(reparsed.verification_commands, ["node --test coord/scripts/governance.test.js"]);
  assert.equal(reparsed.self_review_cycles.length, 1);
});

// Mutation canary: rendering all stored strings as current makes the current
// gate assertion fail; dropping the archive join loses raw arrays on parse.
test("COORD-713: plan rendering separates active evidence from append-only history and round-trips storage", () => {
  const record = coord159BaseRecord("COORD-713");
  record.verification_commands = ["node --test old.test.js", "node --test current.test.js"];
  record.repo_gates = ["npm test [result=pass] old head", "npm run full-gate [result=pass]"];
  const sourceRef = evidenceRef("repo_gate", 1, record.repo_gates[0]);
  const successorRef = evidenceRef("repo_gate", 2, record.repo_gates[1]);
  record.evidence_supersessions = [{
    id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate",
    source_ref: sourceRef, successor_ref: successorRef,
    reason: "Prior result was recorded against an older reviewed head.\n- Repo gates:\n  - npm run injected [result=pass]\n- Verification commands:\n  - node --test injected.test.js | `table`",
    actor: "fixture|agent`alias", timestamp: "2026-10-05T00:00:00.000Z",
  }];
  const block = planRecordOwner.renderPlanRecordBlock(record);
  assert.match(block, /- Repo gates:\n  - npm run full-gate/);
  assert.doesNotMatch(block.split("- Repo gates:")[1].split("- Repo gate history")[0], /old head/);
  assert.match(block, /- Repo gate history \(append-only\):\n  - npm test \[result=pass\] old head/);
  assert.match(block, /Prior result was recorded against an older reviewed head/);
  assert.doesNotMatch(block, /\n- Repo gates:\n  - npm run injected/, "multiline provenance stays JSON-escaped on its history line");
  assert.doesNotMatch(block, /\n- Verification commands:\n  - node --test injected/);
  const reparsed = planRecordOwner.parsePlanBlockToRecord("COORD-713", block);
  assert.deepEqual(reparsed.repo_gates, record.repo_gates);
  assert.deepEqual(reparsed.verification_commands, record.verification_commands);
  assert.deepEqual(reparsed.evidence_supersessions, record.evidence_supersessions);
});

test("COORD-807 prototype: invariant retraction preserves PLAN history and active projection", () => {
  const record = coord159BaseRecord("COORD-807");
  record.adr_refs = [];
  record.critical_invariants = ["timing probe 1", "Canonical journal state remains verifiable."];
  const retracted = applyInvariantRetraction(record, {
    entry: evidenceRef("critical_invariant", 1, record.critical_invariants[0]),
    reason: "This measurement label is not a correctness invariant.",
    actor: "fixture-agent",
    timestamp: "2026-10-06T00:00:00.000Z",
  }).record;
  assert.doesNotThrow(() => createReadonlyPlanRecordHarness().assertValidPlanRecord(retracted));
  const block = planRecordOwner.renderPlanRecordBlock(retracted);
  assert.match(block, /- Critical invariants:\n  - Canonical journal state remains verifiable\./);
  assert.match(block, /- Critical invariant history \(append-only\):\n  - timing probe 1/);
  assert.match(block, /\"disposition\":\"retracted\"/);
  const reparsed = planRecordOwner.parsePlanBlockToRecord("COORD-807", block);
  assert.deepEqual(reparsed.critical_invariants, retracted.critical_invariants, "the compatibility block retains the complete original string array");
  assert.deepEqual(reparsed.evidence_dispositions, retracted.evidence_dispositions);
  assert.deepEqual(resolvePlanEvidence(reparsed).critical_invariants, ["Canonical journal state remains verifiable."]);
});

test("COORD-713: legacy empty PLAN blocks render safely and malformed persisted supersession ledgers fail closed", () => {
  assert.throws(() => planRecordOwner.renderPlanRecordBlock(null), /without a canonical plan record/);
  const legacyBlock = planRecordOwner.renderPlanRecordBlock({ ticket_id: "COORD-713" });
  const parsedLegacy = planRecordOwner.parsePlanBlockToRecord("COORD-713", "");
  assert.match(legacyBlock, /^## COORD-713 — /);
  assert.deepEqual(parsedLegacy.verification_commands, []);
  assert.deepEqual(parsedLegacy.repo_gates, []);
  assert.equal(parsedLegacy.evidence_supersessions, undefined);

  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "__fixtures__", "plan-record.sample.json"), "utf8"));
  const malformed = { ...sample, ticket_id: "COORD-713", markdown_heading: "## COORD-713" };
  const source = evidenceRef("repo_gate", 1, "npm test old head");
  const successor = evidenceRef("repo_gate", 2, "npm test current head");
  malformed.repo_gates = ["npm test old head", "npm test current head"];
  malformed.evidence_supersessions = [{
    id: "supersession-wrong-id",
    kind: "repo_gate",
    source_ref: source,
    successor_ref: successor,
    reason: "the persisted correction ledger must be integrity checked",
    actor: "fixture-agent",
    timestamp: "2026-10-05T00:00:00.000Z",
  }];
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord713-malformed-ledger-"));
  fs.writeFileSync(path.join(recordsDir, "COORD-713.json"), `${JSON.stringify(malformed, null, 2)}\n`);
  assert.throws(
    () => planRecordOwner.readPlanRecord("COORD-713", { recordsDir }),
    (error) => error instanceof GovernanceError && /supersession.*id|stable identity/i.test(error.message)
  );
});

test("COORD-713: empty evidence appends preserve correction-bound ordinals and empty PLAN append is well formed", () => {
  const record = coord159BaseRecord("COORD-713");
  record.repo_gates = ["npm test old head", "npm test current head"];
  const sourceRef = evidenceRef("repo_gate", 1, record.repo_gates[0]);
  const successorRef = evidenceRef("repo_gate", 2, record.repo_gates[1]);
  record.evidence_supersessions = [{
    id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate",
    source_ref: sourceRef, successor_ref: successorRef,
    reason: "the source gate was run on an older head", actor: "fixture-agent",
    timestamp: "2026-10-05T00:00:00.000Z",
  }];
  const updated = planRecordOwner.applyPlanUpdateOptionsToRecord(record, { verify: "   ", repoGate: "" });
  assert.deepEqual(updated.repo_gates, record.repo_gates, "blank appends cannot strip scaffold values or shift correction identities");
  assert.deepEqual(updated.verification_commands, record.verification_commands);
  assert.deepEqual(updated.evidence_supersessions, record.evidence_supersessions);
  assert.equal(createReadonlyPlanRecordHarness().appendPlanBlock("", "## COORD-713 — fixture"), "## COORD-713 — fixture\n");
});

test("appendPlanBlock treats a falsey block as an empty compatibility section", () => {
  const appendPlanBlock = createReadonlyPlanRecordHarness().appendPlanBlock;
  assert.equal(appendPlanBlock("", null), "\n");
  assert.equal(appendPlanBlock("", undefined), "\n");
  assert.equal(appendPlanBlock("existing history", null), "existing history\n\n\n",
    "an empty rendered block does not discard existing PLAN history");
});

test("renderPlanRecordBlock round-trips gate_plan receipt without losing JSON-only fields", () => {
  const record = {
    schema_version: 1,
    ticket_id: "COORD-379",
    markdown_heading: "## COORD-379 — 2026-06-28T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: node --test coord/engine/scripts/gate-plan.test.js", "Outcome: pass"],
    prior_findings: [],
    intended_files: ["coord/engine/scripts/gate-plan.js"],
    change_summary: ["Add deterministic gate-plan receipts."],
    verification_commands: ["node --test coord/engine/scripts/gate-plan.test.js"],
    critical_invariants: ["Gate planning must not execute gates."],
    requirement_closure: ["Ticket ask: gate plan", "Implemented: gate plan", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: ["path:coord/engine/scripts/gate-plan.js"],
    repo_gates: ["node --test coord/engine/scripts/gate-plan.test.js"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 1,
        lens: "state authority",
        diff: "manual",
        risks: ["receipt drift", "markdown loss"],
        findings: "none",
        verification: "node --test coord/engine/scripts/gate-plan.test.js",
        verdict: "pass",
        raw: "lens=state authority; diff=manual; risks=receipt drift, markdown loss; findings=none; verification=node --test coord/engine/scripts/gate-plan.test.js; verdict=pass",
      },
    ],
    rollback_strategy: ["remove gate_plan field"],
    gate_plan: {
      schema_version: 1,
      planner_version: "gate-plan-v1",
      ticket_id: "COORD-379",
      risk_class: "R2",
      affected_targets: {
        mode: "slice",
        selected: [{ id: "coord:gate-planner", command: "node --test coord/engine/scripts/gate-plan.test.js" }],
      },
      required_evidence: ["executed repo gate or focused test evidence"],
    },
    security_surface: "no",
  };

  const block = planRecordOwner.renderPlanRecordBlock(record);
  const reparsed = planRecordOwner.parsePlanBlockToRecord("COORD-379", block);
  assert.deepEqual(reparsed.gate_plan, record.gate_plan);
});

// COORD-153: the optional live_mcp declaration round-trips through the markdown
// compatibility block as a single JSON-encoded line (mirroring bootstrap_risk),
// and is omitted entirely when absent so non-live-mcp records are unchanged.
test("renderPlanRecordBlock round-trips the optional live_mcp declaration and omits it when absent", () => {
  const baseRecord = {
    schema_version: 1,
    ticket_id: "LMCP-RT",
    markdown_heading: "## LMCP-RT — 2026-06-24T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["coord/scripts/example.js"],
    change_summary: ["example"],
    verification_commands: ["node --test"],
    critical_invariants: ["x"],
    requirement_closure: ["Ticket ask: x", "Implemented: x", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  };

  // Absent -> no "- Live-MCP:" section, reparses without the field.
  const plainBlock = planRecordOwner.renderPlanRecordBlock(baseRecord);
  assert.equal(/- Live-MCP:/.test(plainBlock), false);
  assert.equal(planRecordOwner.parsePlanBlockToRecord("LMCP-RT", plainBlock).live_mcp, undefined);

  // Present -> serialized + reparsed identically.
  const liveMcp = {
    adapter: "db",
    operation: "q",
    operation_class: "read_sensitive",
    environment: "prod",
    scope: "client=X",
    redaction: "masked",
    approval: "human-admin",
    receipt_path: "coord/evidence/live-mcp/q.json",
    cleanup_required: false,
    product_impact: true,
  };
  const block = planRecordOwner.renderPlanRecordBlock({ ...baseRecord, live_mcp: liveMcp });
  assert.ok(/- Live-MCP:/.test(block));
  const reparsed = planRecordOwner.parsePlanBlockToRecord("LMCP-RT", block);
  assert.deepEqual(reparsed.live_mcp, liveMcp);
});

test("renderPlanRecordBlock round-trips context_pack_ack and validates advisory-learning shape", () => {
  const record = {
    schema_version: 1,
    ticket_id: "CTX-348",
    markdown_heading: "## CTX-348 — 2026-06-27T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["coord/engine/scripts/governance-validation.js"],
    change_summary: ["enforce context-pack acknowledgement"],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: ["advisory memory must not govern implementation"],
    requirement_closure: ["Ticket ask: context pack enforcement", "Implemented: enforcement", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [],
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    context_pack_ack: {
      refs: ["coord/.runtime/context-packs/CTX-348.json"],
      considered: {
        active_constraints: ["confirmed/current constraints"],
        adrs: ["ADR-0001"],
        business_rules: ["none"],
        conflicts: ["handled: no active conflicts"],
        stale_warnings: ["none"],
        open_questions: ["none"],
      },
      authority: {
        constraints: ["ADR-0001"],
        advisory_only: ["BD-REC-CANDIDATE"],
      },
      closeout_learning: {
        decision: "scratch-only",
        promote: [],
        demote: [],
        scratch_only: ["ticket-local observation"],
        rationale: "No reusable rule was proven.",
      },
    },
    security_surface: "no",
  };

  const block = planRecordOwner.renderPlanRecordBlock(record);
  const reparsed = planRecordOwner.parsePlanBlockToRecord("CTX-348", block);

  assert.deepEqual(reparsed.context_pack_ack, record.context_pack_ack);
  assert.doesNotThrow(() => planRecordOwner.applyPlanUpdateOptionsToRecord(record, {}));
  assert.throws(
    () => planRecordOwner.applyPlanUpdateOptionsToRecord({
      ...record,
      context_pack_ack: {
        ...record.context_pack_ack,
        closeout_learning: { decision: "archive" },
      },
    }, {}),
    /closeout_learning\.decision/
  );
});


// ---------------------------------------------------------------------------
// COORD-090: relocated from governance.test.js (plan-records module behavior:
// parse/render/extract/replace canonical plan blocks, record normalization,
// applyPlanUpdateOptionsToRecord, scaffold-intended-file classification)
// ---------------------------------------------------------------------------

test("plan-record compat reader: runtime is canonical, legacy is read-only fallback (C6 Phase 2)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-c6p2-plan-compat-"));
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });

  // Clone a real schema-valid shard so assertValidPlanRecord passes. Sourced
  // from a durable test fixture rather than coord/board/plans/, which is
  // scrubbed to a clean seed in the copy-ready template (and whose shards
  // were relocated to .runtime/plans/ by C6-P2).
  const fixtureSource = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  const makeShard = (ticketId, marker) => ({
    ...fixtureSource,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — compat fixture (${marker})`,
  });

  return withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: runtimeDir, LEGACY_PLAN_RECORDS_DIR: legacyDir }, () => {
    try {
    // (1) A record written via the canonical writer lands in .runtime/plans.
    const runtimeWritePath = path.join(runtimeDir, "CMP-100.json");
    __testing.writeCanonicalJsonFile(runtimeWritePath, makeShard("CMP-100", "runtime-write"), {
      expectedRaw: "",
    });
    assert.equal(fs.existsSync(runtimeWritePath), true);
    assert.equal(
      fs.existsSync(path.join(legacyDir, "CMP-100.json")),
      false,
      "writes must never touch the legacy tracked location"
    );
    assert.equal(planRecordOwner.readPlanRecord("CMP-100").ticket_id, "CMP-100");

    // (2) A legacy-only shard with no runtime counterpart is still readable.
    fs.writeFileSync(
      path.join(legacyDir, "CMP-200.json"),
      `${JSON.stringify(makeShard("CMP-200", "legacy-only"), null, 2)}\n`
    );
    const legacyRead = planRecordOwner.readPlanRecord("CMP-200", { allowMissing: true });
    assert.ok(legacyRead, "legacy-only shard must resolve via the compat reader");
    assert.equal(legacyRead.ticket_id, "CMP-200");

    // (3) Runtime wins when both a runtime and a legacy copy exist.
    fs.writeFileSync(
      path.join(legacyDir, "CMP-300.json"),
      `${JSON.stringify(makeShard("CMP-300", "legacy-stale"), null, 2)}\n`
    );
    __testing.writeCanonicalJsonFile(
      path.join(runtimeDir, "CMP-300.json"),
      makeShard("CMP-300", "runtime-fresh"),
      { expectedRaw: "" }
    );
    const winner = planRecordOwner.readPlanRecord("CMP-300");
    assert.equal(winner.markdown_heading, "## CMP-300 — compat fixture (runtime-fresh)");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("normalizeLegacyPlanRecordShape upgrades stale generic governance defaults for repo-backed tickets", () => {
  const normalized = planRecordOwner.normalizeLegacyPlanRecordShape("FE-001", {
    schema_version: 1,
    ticket_id: "FE-001",
    markdown_heading: "## FE-001 — 2026-04-04T00:00:00.000Z",
    governance: {
      expected_closeout: {
        method: "no_pr",
        base_ref: "main",
        provenance_note: null,
      },
      ticket_local_repairs: [],
    },
  }).record;

  // COORD-006: the upgraded base_ref is the F repo's configured integration
  // branch — derived from the live registry, not the hardcoded template "dev".
  assert.deepEqual(normalized.governance, {
    expected_closeout: {
      method: "pr",
      base_ref: DEFAULT_PATHS.repoIntegrationBranches.F || "dev",
      provenance_note: null,
    },
    review_profile: "standard",
    ticket_local_repairs: [],
  });
});

// COORD-062: the buildNoPrCloseoutPlanUpdate fulfilled-by-vs-no-pr test moved to
// closeout.test.js with the extraction of closeout.js.

test("renderPlanRecordBlock and parsePlanBlockToRecord preserve governance plan metadata", () => {
  const record = {
    schema_version: 1,
    ticket_id: "FE-999",
    markdown_heading: "## FE-999 — 2026-04-04T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    governance: {
      expected_closeout: {
        method: "no_pr",
        base_ref: "dev",
        provenance_note: "local review expected",
      },
      review_profile: "bounded_repair",
      ticket_local_repairs: [
        {
          kind: "recover",
          required_question_logged: true,
          note: "ticket-local repair required before review",
        },
      ],
    },
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: [],
    intended_files: ["frontend/.worktrees/claudea11/FE-999/*"],
    change_summary: ["repair governance visibility"],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["invariant 1", "invariant 2"],
    adr_refs: ["ADR-0001"],
    requirement_closure: ["Ticket ask: demo", "Implemented: demo", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: ["path:coord/scripts/governance.js"],
    repo_gates: ["node --test coord/scripts/governance.test.js"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 4,
        lens: "contract/state invariants",
        diff: "manual",
        risks: ["risk 1", "risk 2"],
        findings: "none",
        verification: "node --test coord/scripts/governance.test.js",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=manual; risks=risk 1, risk 2; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    decision_required: {
      required: true,
      status: "required",
      reason: "governance policy change",
      adr_refs: ["0001"],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-04-04T00:00:00.000Z",
  };

  const beforeRender = structuredClone(record);
  const block = planRecordOwner.renderPlanRecordBlock(record, "FE-999");
  const reparsed = planRecordOwner.parsePlanBlockToRecord("FE-999", block);

  assert.match(block, /Self-review cycle 1\/1:/, "the compatibility view derives the current display denominator");
  assert.deepEqual(record, beforeRender, "rendering does not rewrite historical canonical totals");
  assert.deepEqual(reparsed.governance, record.governance);
  assert.deepEqual(reparsed.adr_refs, ["ADR-0001"]);
  assert.deepEqual(reparsed.decision_required, record.decision_required);
});

test("applyPlanUpdateOptionsToRecord rejects malformed closure and feature-proof entries", () => {
  const ticketId = `${B_TICKET_PREFIX}-999`;
  const record = {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId}`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: [],
    change_summary: [],
    verification_commands: [],
    critical_invariants: [],
    requirement_closure: [],
    feature_proof: [],
    repo_gates: [],
    rollback_strategy: [],
    self_review_cycles: [],
    governance: {
      expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-01-01T00:00:00.000Z",
  };

  assert.throws(
    () => planRecordOwner.applyPlanUpdateOptionsToRecord(record, { closure: ["Implemented route-management UI"] }),
    GovernanceError
  );
  assert.throws(
    () => planRecordOwner.applyPlanUpdateOptionsToRecord(record, { featureProof: ["path:apps/coord-ui/app/dispatch/page.tsx#Widget"] }),
    GovernanceError
  );
  assert.doesNotThrow(() => planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    closure: ["Implemented: route-management exposes dispatcher controls."],
    // COORD-690: a recorded proof is now resolved against a named ref, so this
    // fixture must cite files that actually exist. The assertion is unchanged —
    // well-formed entries are accepted — it just no longer leans on paths that
    // resolve nowhere, which is the state this ticket made refusable.
    // COORD-714: use the active registry and the same real B-repo producer as
    // the normalization test below; FE is not a prefix in the alternate config.
    featureProof: ["path:src/app.js", "symbol:src/app.js#createApp"],
  }));
});

test("applyPlanUpdateOptionsToRecord normalizes repo-prefixed feature-proof entries to repo-relative paths", () => {
  const tid = `${B_TICKET_PREFIX}-085`;
  const record = {
    schema_version: 1,
    ticket_id: tid,
    markdown_heading: `## ${tid} — 2026-01-01T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: [],
    change_summary: [],
    verification_commands: [],
    critical_invariants: [],
    requirement_closure: [],
    feature_proof: [],
    repo_gates: [],
    rollback_strategy: [],
    self_review_cycles: [],
    governance: {
      expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-01-01T00:00:00.000Z",
  };

  // Fixture must respect the active project config (GOV-015). In the
  // template B maps to "backend/"; in acme-ops B maps to "msrv/". Derive the
  // prefix at test time so the same test passes in both.
  const bPrefix = repoRegistryOwner.repoPrefixForCode("B");
  // COORD-690: cites files that exist, since a recorded proof is now resolved
  // against a named ref. What is under test is unchanged: the repo prefix is
  // stripped to a repo-relative entry.
  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    featureProof: [
      `path:${bPrefix}src/app.js`,
      `symbol:${bPrefix}src/app.js#createApp`,
    ],
  });

  assert.deepEqual(nextRecord.feature_proof, [
    "path:src/app.js",
    "symbol:src/app.js#createApp",
  ]);
});

test("applyPlanUpdateOptionsToRecord normalizes legacy-prefixed feature-proof entries after a repo rename", () => {
  const tid = `${B_TICKET_PREFIX}-090`;
  const record = {
    schema_version: 1,
    ticket_id: tid,
    markdown_heading: `## ${tid} — 2026-01-01T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: [],
    change_summary: [],
    verification_commands: [],
    critical_invariants: [],
    requirement_closure: [],
    feature_proof: [],
    repo_gates: [],
    rollback_strategy: [],
    self_review_cycles: [],
    governance: {
      expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-01-01T00:00:00.000Z",
  };

  return withScopedGovernanceTestContext({
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "msrv" },
    legacyRepoAliases: { ...DEFAULT_PATHS.legacyRepoAliases, B: ["backend"] },
  }, () => {
    // Simulate a project that renamed B from "backend" to "msrv" but still
    // has historical plan records that reference "backend/...". Both the
    // canonical prefix and the legacy alias must normalize to repo-relative.
    const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
      featureProof: [
        "path:msrv/src/app.js",
        "path:backend/src/config/env.js",
      ],
    });

    assert.deepEqual(nextRecord.feature_proof, [
      "path:src/app.js",
      "path:src/config/env.js",
    ]);
  });
});

test("plan list helpers stop at self-review cycle boundaries", () => {
  const block = `## IMP-185 — 2026-03-25T03:10:00Z

- Repo gates:
  - node coord/board/board.js validate
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, parser corruption; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Rollback strategy:
  - revert
`;

  assert.equal(planRecordOwner.isPlanSectionBoundary("- Self-review cycle 1/3: lens=..."), true);
  assert.deepEqual(planRecordOwner.readPlanListField(block, "Repo gates"), [
    "node coord/board/board.js validate",
  ]);

  const next = planRecordOwner.upsertListItem(block, "Repo gates", "`node --test coord/scripts/governance.test.js`");
  assert.match(
    next,
    /- Repo gates:\n  - node coord\/board\/board\.js validate\n  - `node --test coord\/scripts\/governance\.test\.js`\n- Self-review cycle 1\/3:/
  );
});

test("extractPlanBlock returns the latest block when duplicate ticket headings exist", () => {
  const raw = `## IMP-193 — 2026-03-25T03:20:00Z

- Startup checklist:
  - completed
- Traceability gate:
  - verified
- Repo gates:
  - node coord/board/board.js validate
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, parser corruption; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 2/3: lens=auth/security/failure modes; diff=manual; risks=auth drift, invalid transition; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 3/3: lens=tests/operability/performance; diff=manual; risks=parser regression, operability stall; findings=none; verification=node coord/board/board.js validate; verdict=pass

## IMP-193 — 2026-03-25T04:00:00Z

- Startup checklist:
  - TODO: completed
- Traceability gate:
  - TODO: verified | closing-gap | exempt
- Repo gates:
  - TODO: add executed repo gate(s) before move-review
`;

  assert.equal(planRecordOwner.extractPlanBlocks(raw, "IMP-193").length, 2);
  const block = planRecordOwner.extractPlanBlock(raw, "IMP-193");
  assert.match(block, /TODO: completed/);
  assert.doesNotMatch(block, /- Startup checklist:\n  - completed/);
});

test("replacePlanBlock updates the latest duplicate block even when earlier text is identical", () => {
  const raw = `## IMP-193 — 2026-03-25T03:20:00Z

- Startup checklist:
  - TODO: completed
- Traceability gate:
  - TODO: verified | closing-gap | exempt
- Repo gates:
  - TODO: add executed repo gate(s) before move-review

## IMP-193 — 2026-03-25T04:00:00Z

- Startup checklist:
  - TODO: completed
- Traceability gate:
  - TODO: verified | closing-gap | exempt
- Repo gates:
  - TODO: add executed repo gate(s) before move-review
`;
  const updated = `## IMP-193 — 2026-03-25T04:00:00Z

- Startup checklist:
  - completed
- Traceability gate:
  - verified
- Repo gates:
  - node coord/board/board.js validate
`;

  const next = planRecordOwner.replacePlanBlock(raw, "IMP-193", updated);
  const blocks = planRecordOwner.extractPlanBlocks(next, "IMP-193");
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /TODO: completed/);
  assert.match(blocks[1], /- Startup checklist:\n  - completed/);
});

test("applyPlanUpdateOptionsToRecord replaces scaffold self-review cycles in canonical state", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: coord/scripts/gov explain DEBT-043", "Outcome: bootstrap seam reproduced"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Repair canonical plan bootstrap fallback."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain the source of truth."],
    requirement_closure: ["Ticket ask: scaffold review cycles", "Implemented: scaffold review cycles", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "TODO contract/state invariants",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail",
        raw: "lens=TODO contract/state invariants; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail",
      },
      {
        cycle: 2,
        total: 3,
        lens: "TODO auth/security/failure modes",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail",
        raw: "lens=TODO auth/security/failure modes; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail",
      },
      {
        cycle: 3,
        total: 3,
        lens: "TODO tests/operability/performance",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail",
        raw: "lens=TODO tests/operability/performance; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail",
      },
    ],
    rollback_strategy: ["revert bootstrap helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    reviewCycle: [
      "lens=contract/state invariants; diff=git diff -- coord/scripts/governance.js; risks=state drift, bootstrap mismatch; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      "lens=auth/security/failure modes; diff=git diff -- coord/scripts/governance.js; risks=permission drift, unsafe fallback; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      "lens=tests/operability/performance; diff=git diff -- coord/scripts/governance.test.js; risks=coverage gap, compatibility drift; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
    ],
  });

  assert.equal(planRecordOwner.planRecordHasOnlyScaffoldSelfReviewCycles(record), true);
  assert.equal(nextRecord.self_review_cycles.length, 3);
  assert.equal(planRecordOwner.planRecordHasOnlyScaffoldSelfReviewCycles(nextRecord), false);
  assert.match(nextRecord.self_review_cycles[0].raw, /lens=contract\/state invariants;/);
  assert.doesNotMatch(nextRecord.self_review_cycles[0].raw, /TODO/);
});

test("applyPlanUpdateOptionsToRecord appends to a malformed cycle instead of silently replacing it (GOV-002)", () => {
  // Before GOV-002: when the only existing cycle was user-authored but shallow (e.g. single
  // risk), the next update-plan --review-cycle call wiped it and stored only the new cycle,
  // because planRecordHasOnlyMalformedSelfReviewCycles returned true. After GOV-002: shallow
  // user cycles append; submit-time validation surfaces the shallow-risks error instead.
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-044",
    markdown_heading: "## DEBT-044 — 2026-04-22T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: repro", "Outcome: repro"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["fix"],
    verification_commands: ["node --test"],
    critical_invariants: ["inv"],
    requirement_closure: ["Ticket ask: x", "Implemented: y", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 1,
        lens: "contract",
        diff: "real diff",
        risks: ["only one risk"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=contract; diff=real diff; risks=only one risk; findings=none; verification=node --test; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-04-22T00:00:00.000Z",
  };

  // Pre-check: the single existing cycle is not a scaffold TODO — it's real user content
  // that merely fails the shallow-risks validation (one risk instead of two).
  assert.equal(planRecordOwner.planRecordHasOnlyScaffoldSelfReviewCycles(record), false);

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    reviewCycle: [
      "lens=security; diff=real diff 2; risks=risk a, risk b; findings=none; verification=node --test; verdict=pass",
    ],
  });

  assert.equal(nextRecord.self_review_cycles.length, 2, "shallow cycle must be preserved, not replaced");
  assert.equal(nextRecord.self_review_cycles[0].lens, "contract");
  assert.equal(nextRecord.self_review_cycles[1].lens, "security");
});

test("applyPlanUpdateOptionsToRecord warns and skips when an incoming cycle duplicates an existing raw body (GOV-002)", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-045",
    markdown_heading: "## DEBT-045 — 2026-04-22T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: repro", "Outcome: repro"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["fix"],
    verification_commands: ["node --test"],
    critical_invariants: ["inv"],
    requirement_closure: ["Ticket ask: x", "Implemented: y", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract",
        diff: "diff-a",
        risks: ["risk 1", "risk 2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=contract; diff=diff-a; risks=risk 1, risk 2; findings=none; verification=node --test; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-04-22T00:00:00.000Z",
  };

  const originalError = console.error;
  const warnings = [];
  console.error = (...args) => { warnings.push(args.join(" ")); };
  try {
    const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
      reviewCycle: [
        // Duplicate raw body of cycle 1 — must be skipped with a visible warning.
        "lens=contract; diff=diff-a; risks=risk 1, risk 2; findings=none; verification=node --test; verdict=pass",
      ],
    });
    assert.equal(nextRecord.self_review_cycles.length, 1, "duplicate cycle must not be appended");
    assert.equal(warnings.length, 1, "dedup must emit exactly one warning");
    assert.match(warnings[0], /review cycle skipped/);
    assert.match(warnings[0], /DEBT-045/, "warning should name the ticket id");
    assert.match(warnings[0], /Use --replace-review-cycle/);
    assert.match(warnings[0], /set-review-cycles DEBT-045 --replace --review-cycle/);
  } finally {
    console.error = originalError;
  }
});

test("applyPlanUpdateOptionsToRecord drops the sole scaffold intended_files placeholder when concrete files are added", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    scaffold_placeholders: {
      intended_files: ["coord/.worktrees/codexa02/DEBT-043/*"],
    },
    intended_files: ["coord/.worktrees/codexa02/DEBT-043/*"],
    change_summary: ["Address review finding."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain consistent."],
    requirement_closure: ["Ticket ask: intended files", "Implemented: intended files", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    files: ["coord/scripts/governance.js"],
  });

  assert.deepEqual(nextRecord.intended_files, ["coord/scripts/governance.js"]);
  assert.equal(nextRecord.scaffold_placeholders, undefined);
});

test("applyPlanUpdateOptionsToRecord treats an untouched repair stub worktree root as an implicit scaffold placeholder", () => {
  const record = {
    schema_version: 1,
    ticket_id: "QGATE-001",
    markdown_heading: "## QGATE-001 — 2026-04-01T22:43:54.612Z",
    startup_checklist: ["TODO: completed"],
    traceability_gate: ["TODO: verified | closing-gap | exempt"],
    review_round: 3,
    baseline_reproduction: [
      "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
      "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
    ],
    prior_findings: ["QGATE-001-F3 — repair"],
    intended_files: ["coord/.worktrees/codexa02/QGATE-001/*"],
    change_summary: ["Address review return finding QGATE-001-F3."],
    verification_commands: ["TODO"],
    critical_invariants: [
      "TODO: list 2-5 truths this repair must preserve under normal, edge, and failure paths",
      "TODO: include at least one invariant about state/contract consistency",
    ],
    requirement_closure: ["TODO: Ticket ask: <what the ticket said to deliver>"],
    repo_gates: ["TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "TODO contract/state invariants",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
        raw: "lens=TODO contract/state invariants; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail — fixed N issues, re-cycling",
      },
      {
        cycle: 2,
        total: 3,
        lens: "TODO auth/security/failure modes",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
        raw: "lens=TODO auth/security/failure modes; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail — fixed N issues, re-cycling",
      },
      {
        cycle: 3,
        total: 3,
        lens: "TODO tests/operability/performance",
        diff: "TODO git diff origin/dev...HEAD -- <paths>",
        risks: ["TODO failure mode 1", "TODO failure mode 2"],
        findings: "TODO none or describe issues fixed",
        verification: "TODO command rerun",
        verdict: "TODO pass or fail — fixed N issues, re-cycling",
        raw: "lens=TODO tests/operability/performance; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail — fixed N issues, re-cycling",
      },
    ],
    rollback_strategy: ["TODO"],
    security_surface: "no",
    synced_from_markdown_at: "2026-04-01T22:43:54.612Z",
  };

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    files: ["coord/scripts/governance.js"],
  });

  assert.deepEqual(nextRecord.intended_files, ["coord/scripts/governance.js"]);
});

test("isScaffoldWorktreeIntendedFile accepts configured repo prefixes and legacy aliases", () => {
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: "/tmp/project/packages/server" },
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "packages/server" },
    legacyRepoAliases: { ...DEFAULT_PATHS.legacyRepoAliases, B: ["backend"] },
  }, () => {

    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("packages/server/.worktrees/unassigned/API-001/*"),
      true
    );
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("backend/.worktrees/unassigned/API-001/*"),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// COORD-006: the start-scaffold `intended_files` placeholder check must be
// stable under ANY repo registry. The guard used to derive the acceptable
// repo-name prefixes from the live registry and require a value-exact match,
// so a record seeded under one registry was mis-flagged as "authored content"
// once the prefix was no longer derivable from the current config — falsely
// failing `gov unstart` / `gov lock-abandon` on a freshly-started wrong-start.
// ---------------------------------------------------------------------------

test("COORD-006: isScaffoldWorktreeIntendedFile is structural and registry-agnostic", () => {
  return withScopedGovernanceTestContext({ REPO_ROOTS: {}, repoRegistry: {} }, () => {
    // Empty registry: the predicate must STILL recognize the scaffold shape.
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("anything/.worktrees/vg/SEC-010/*"),
      true,
      "the scaffold shape must be recognized without any registry entries"
    );
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("coord/.worktrees/vg/ARCH-001/*"),
      true,
      "coord-only scaffold worktrees stay recognized"
    );
    // Ticket-pinned form: the trailing segment must match the supplied id.
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/*", "SEC-010"),
      true
    );
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/*", "SEC-999"),
      false,
      "a placeholder for a different ticket must not match"
    );
    // Real authored paths are never the scaffold shape.
    assert.equal(planRecordOwner.isScaffoldWorktreeIntendedFile("src/index.ts"), false);
    assert.equal(planRecordOwner.isScaffoldWorktreeIntendedFile("backend/src/index.ts"), false);
    assert.equal(planRecordOwner.isScaffoldWorktreeIntendedFile(".worktrees/vg/SEC-010/*"), false);
    assert.equal(
      planRecordOwner.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/src/foo.ts"),
      false
    );
  });
});

test("applyPlanUpdateOptionsToRecord preserves a sole worktree root when no scaffold placeholder metadata marks it as disposable", () => {
  const record = {
    schema_version: 1,
    ticket_id: "MSRV-003",
    markdown_heading: "## MSRV-003 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["backend/.worktrees/unassigned/MSRV-003/*"],
    change_summary: ["Implement tenant-admin read paths."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Tenant-admin scope must remain tenant-safe."],
    requirement_closure: ["Ticket ask: tenant-admin read paths", "Implemented: tenant-admin read paths", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["pytest"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    files: ["packages/modules/tenant-admin/src/tenant-admin.core.ts"],
  });

  assert.deepEqual(nextRecord.intended_files, [
    "backend/.worktrees/unassigned/MSRV-003/*",
    "packages/modules/tenant-admin/src/tenant-admin.core.ts",
  ]);
});

test("applyPlanUpdateOptionsToRecord preserves an existing worktree root when concrete files are already tracked", () => {
  const record = {
    schema_version: 1,
    ticket_id: "MSRV-003",
    markdown_heading: "## MSRV-003 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: [
      "backend/.worktrees/unassigned/MSRV-003/*",
      "apps/api/src/http/tenant-admin.controller.ts",
    ],
    change_summary: ["Implement tenant-admin read paths."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Tenant-admin scope must remain tenant-safe."],
    requirement_closure: ["Ticket ask: tenant-admin read paths", "Implemented: tenant-admin read paths", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["pytest"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    files: ["packages/modules/tenant-admin/src/tenant-admin.core.ts"],
  });

  assert.deepEqual(nextRecord.intended_files, [
    "backend/.worktrees/unassigned/MSRV-003/*",
    "apps/api/src/http/tenant-admin.controller.ts",
    "packages/modules/tenant-admin/src/tenant-admin.core.ts",
  ]);
});

test("applyPlanUpdateOptionsToRecord preserves a scaffold-generated worktree root after explicit reaffirmation", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    scaffold_placeholders: {
      intended_files: ["coord/.worktrees/codexa02/DEBT-043/*"],
    },
    intended_files: ["coord/.worktrees/codexa02/DEBT-043/*"],
    change_summary: ["Address review finding."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain consistent."],
    requirement_closure: ["Ticket ask: worktree placeholder", "Implemented: worktree placeholder", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const reaffirmed = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    files: ["coord/.worktrees/codexa02/DEBT-043/*"],
  });
  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(reaffirmed, {
    files: ["coord/scripts/governance.js"],
  });

  assert.deepEqual(nextRecord.intended_files, [
    "coord/.worktrees/codexa02/DEBT-043/*",
    "coord/scripts/governance.js",
  ]);
  assert.equal(nextRecord.scaffold_placeholders, undefined);
});

test("parseFlags plus applyPlanUpdateOptionsToRecord supports dropping an intended file entry", () => {
  const record = {
    schema_version: 1,
    ticket_id: "QGATE-001",
    markdown_heading: "## QGATE-001 — 2026-04-01T22:43:54.612Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 3,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: ["QGATE-001-F3 — repair"],
    intended_files: [
      "coord/.worktrees/codexa02/QGATE-001/*",
      "coord/scripts/governance.js",
      "coord/scripts/governance.test.js",
    ],
    change_summary: ["Repair review return finding."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain consistent."],
    requirement_closure: ["Ticket ask: drop intended file", "Implemented: drop intended file", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["coord/scripts/gov doctor"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-04-01T22:43:54.612Z",
  };

  const options = __testing.parseFlags(["--drop-file", "coord/.worktrees/codexa02/QGATE-001/*"]);
  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, options);

  assert.deepEqual(nextRecord.intended_files, [
    "coord/scripts/governance.js",
    "coord/scripts/governance.test.js",
  ]);
});

test("parseFlags plus applyPlanUpdateOptionsToRecord supports rollback entries and strips scaffold TODO rollback text", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Repair canonical plan bootstrap fallback."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must remain the source of truth."],
    requirement_closure: ["Ticket ask: rollback update", "Implemented: rollback update", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["TODO"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:00:00.000Z",
  };

  const options = __testing.parseFlags(["--rollback", "revert helper", "--rollback", "re-run governance tests"]);
  const nextRecord = planRecordOwner.applyPlanUpdateOptionsToRecord(record, options);

  assert.deepEqual(nextRecord.rollback_strategy, ["revert helper", "re-run governance tests"]);
});

test("materializePlanBlockFromRecord restores PLAN.md compatibility blocks from canonical records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-materialize-plan-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(path.join(recordsDir, "DEBT-043.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:05:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: coord/scripts/gov explain DEBT-043", "Outcome: canonical record only"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Restore compatibility markdown."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan records must be editable even if PLAN.md was not rendered yet."],
    requirement_closure: ["Ticket ask: plan regeneration", "Implemented: plan regeneration", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:05:00.000Z",
  }, null, 2), "utf8");

  return withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    const result = planRecordOwner.materializePlanBlockFromRecord("DEBT-043");
    const planRaw = fs.readFileSync(planPath, "utf8");
    assert.equal(result.materialized, true);
    assert.match(planRaw, /## DEBT-043 — 2026-03-29T14:05:00\.000Z/);
    assert.match(planRaw, /Restore compatibility markdown\./);
  });
});

test("readPlanRecord rejects malformed canonical plan records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-record-invalid-"));
  const recordPath = path.join(tempDir, "IMP-221.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-221",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: already reproduced"],
    prior_findings: [],
    intended_files: ["coord/board/plans/IMP-221.json"],
    change_summary: ["Introduce structured plan records."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan state must survive markdown drift."],
    repo_gates: ["not-required"],
    self_review_cycles: [{ cycle: 1, total: 3, raw: "lens=contract; verdict=pass", risks: "not-an-array" }],
    rollback_strategy: ["revert"],
  }, null, 2));

  assert.throws(
    () => planRecordOwner.readPlanRecord("IMP-221", { recordsDir: tempDir }),
    (error) => error instanceof GovernanceError && /risks.*array of strings/i.test(error.message)
  );
});

test("readPlanRecordsReadonly lists canonical records without repair writes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-readonly-"));
  const samplePath = path.join(__dirname, "..", "..", "scripts", "__fixtures__", "plan-record.sample.json");
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const first = { ...sample, ticket_id: "RO-002", markdown_heading: "## RO-002" };
  const second = { ...sample, ticket_id: "RO-001", markdown_heading: "## RO-001" };
  fs.writeFileSync(path.join(tempDir, "RO-002.json"), `${JSON.stringify(first, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(tempDir, "RO-001.json"), `${JSON.stringify(second, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(tempDir, "notes.txt"), "ignored\n", "utf8");

  const planRecords = createReadonlyPlanRecordHarness();
  assert.deepEqual(planRecords.listPlanRecordIds(tempDir), ["RO-001", "RO-002"]);
  const before = fs.readFileSync(path.join(tempDir, "RO-001.json"), "utf8");
  const records = planRecords.readPlanRecordsReadonly({ recordsDir: tempDir });
  assert.deepEqual(records.map((record) => record.ticket_id), ["RO-001", "RO-002"]);
  assert.equal(fs.readFileSync(path.join(tempDir, "RO-001.json"), "utf8"), before);
});

test("readPlanRecordsReadonly does not normalize legacy records while reading", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-readonly-legacy-"));
  const legacy = {
    ticket_id: "RO-003",
    startup_checklist: [],
    traceability_gate: [],
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: [],
    change_summary: [],
    verification_commands: [],
    critical_invariants: [],
    adr_refs: [],
    requirement_closure: [],
    feature_proof: [],
    repo_gates: [],
    rollback_strategy: [],
    self_review_cycles: [],
  };
  const filePath = path.join(tempDir, "RO-003.json");
  fs.writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  const before = fs.readFileSync(filePath, "utf8");
  const records = createReadonlyPlanRecordHarness().readPlanRecordsReadonly({ recordsDir: tempDir });
  assert.equal(records[0].schema_version, 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
});

test("readPlanRecord repairs legacy missing fields but still preserves canonical content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-record-legacy-"));
  const recordPath = path.join(tempDir, "IMP-310.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-310",
    markdown_heading: "## IMP-310",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    change_summary: ["Context bar and page wrapper"],
    verification_commands: ["vitest run"],
    critical_invariants: ["done"],
    repo_gates: ["passed"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2));

  const before = fs.readFileSync(recordPath, "utf8");
  const record = planRecordOwner.readPlanRecord("IMP-310", { recordsDir: tempDir });

  // In-memory normalization: the RETURNED record has the missing fields filled.
  assert.deepEqual(record.baseline_reproduction, []);
  assert.deepEqual(record.intended_files, []);

  // COORD-373: the READ is PURE — it must NOT persist (no read-that-writes).
  assert.equal(fs.readFileSync(recordPath, "utf8"), before, "readPlanRecord must not write the file");

  // Explicit repair is the ONLY sanctioned read->write migration path.
  const result = withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: tempDir }, () =>
    planRecordOwner.repairPlanRecord("IMP-310", { recordsDir: tempDir })
  );
  assert.equal(result.persisted, true);
  const repaired = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.deepEqual(repaired.baseline_reproduction, []);
  assert.deepEqual(repaired.intended_files, []);
  // Repair must PRESERVE the rich canonical fields (no field loss on migrate).
  assert.equal(repaired.markdown_heading, "## IMP-310");
  assert.deepEqual(repaired.startup_checklist, ["completed"]);
  assert.deepEqual(repaired.traceability_gate, ["exempt"]);
});

test("COORD-373: reads are idempotent + pure; markdown sync cannot degrade canonical JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord373-"));
  const recordPath = path.join(tempDir, "IMP-373.json");
  const rich = {
    schema_version: 1, ticket_id: "IMP-373",
    markdown_heading: "## IMP-373", startup_checklist: ["completed"], traceability_gate: ["exempt"],
    review_round: 1, change_summary: ["x"], verification_commands: ["vitest run"],
    critical_invariants: ["done"], repo_gates: ["passed"], self_review_cycles: [],
    rollback_strategy: ["revert"], security_surface: "no",
    baseline_reproduction: [], intended_files: ["frontend/x.ts"],
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(rich, null, 2)}\n`);

  // (1) reading twice is byte-identical (idempotent, no mutation).
  const a = JSON.stringify(planRecordOwner.readPlanRecord("IMP-373", { recordsDir: tempDir }));
  const b = JSON.stringify(planRecordOwner.readPlanRecord("IMP-373", { recordsDir: tempDir }));
  assert.equal(a, b);
  // (2) reads did not write the file.
  assert.equal(fs.readFileSync(recordPath, "utf8"), `${JSON.stringify(rich, null, 2)}\n`);

  // (3) markdown sync onto an EXISTING canonical record is a no-op: the narrower
  // markdown view cannot drop the rich JSON-only fields (JSON is the authority).
  const narrowBlock = "## IMP-373\n\n### Change summary\n- x\n"; // markdown lacks most sections
  withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: tempDir }, () => {
    planRecordOwner.syncPlanRecordFromBlock("IMP-373", narrowBlock, tempDir);
  });
  const after = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(after.markdown_heading, "## IMP-373");
  assert.deepEqual(after.startup_checklist, ["completed"]);
  assert.deepEqual(after.traceability_gate, ["exempt"]);
  assert.deepEqual(after.intended_files, ["frontend/x.ts"]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("synthesizeHistoricalPlanRecord preserves board evidence when no markdown block survives", () => {
  const board = {
    pr_index: {
      "IMP-170": ["https://example.test/pr/170"],
    },
    landing_index: {
      "IMP-170": {
        recorded_at: "2026-03-25T18:00:00Z",
        evidence: ["frontend abc123 merged 2026-03-25T18:00:00Z"],
      },
    },
    review_findings: {
      "IMP-170": [
        { id: "IMP-170-F1", summary: "repair drift", round: 2, status: "resolved" },
      ],
    },
  };
  const row = {
    ID: "IMP-170",
    Repo: "F",
    Status: "done",
    Description: "Historical frontend redesign landing",
  };

  const record = planRecordOwner.synthesizeHistoricalPlanRecord("IMP-170", row, board);

  assert.equal(record.ticket_id, "IMP-170");
  assert.equal(record.review_round, 2);
  assert.match(record.markdown_heading, /^## IMP-170 — historical backfill /);
  assert.match(record.verification_commands.join("\n"), /example\.test\/pr\/170/);
  assert.match(record.verification_commands.join("\n"), /abc123 merged/);
  assert.deepEqual(record.prior_findings, ["IMP-170-F1 — repair drift"]);
  assert.equal(record.self_review_cycles.length, 1);
  assert.equal(record.self_review_cycles[0].lens, "historical backfill");
  assert.equal(record.governance.expected_closeout.base_ref, repoRegistryOwner.resolveRepoIntegrationBranch("F"));
});

test("COORD-693: composed historical synthesis preserves evidence and uses each configured branch", () => {
  for (const repo of ["B", "F", "X"]) {
    const id = "COORD-999993";
    const row = { ID: id, Repo: repo, Status: "done", Description: "Historical evidence" };
    const board = {
      pr_index: { [id]: ["https://example.test/pull/693"] },
      landing_index: { [id]: { commit_sha: "a".repeat(40), evidence: ["original landing evidence"] } },
      review_findings: { [id]: [{ id: "F1", summary: "original finding", round: 2, status: "resolved" }] },
    };
    const before = JSON.stringify({ row, board });
    const record = planRecordOwner.synthesizeHistoricalPlanRecord(id, row, board);
    assert.equal(record.governance.expected_closeout.base_ref,
      repo === "X" ? "main" : repoRegistryOwner.resolveRepoIntegrationBranch(repo));
    assert.equal(record.governance.expected_closeout.method, "fulfilled_by");
    assert.equal(record.governance.expected_closeout.provenance_note, `historical landing preserved at ${"a".repeat(40)}`);
    assert.deepEqual(record.verification_commands, [
      "historical evidence: https://example.test/pull/693", "historical evidence: original landing evidence",
    ]);
    assert.deepEqual(record.prior_findings, ["F1 — original finding"]);
    assert.equal(record.review_round, 2);
    assert.match(record.critical_invariants.join("\n"), /without inventing unavailable implementation detail/);
    assert.equal(JSON.stringify({ row, board }), before);
  }
});

test("applyPlanUpdateOptionsToRecord replaces malformed self-review cycles with structured review evidence", () => {
  const record = {
    schema_version: 1,
    ticket_id: "DEBT-044",
    markdown_heading: "## DEBT-044 — 2026-03-30T02:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: rg -n 'agentid' coord/scripts/governance.js", "Outcome: runtime/docs mismatch recorded."],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Align agentid assignment flow."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Unclaimed agentid remains read-only.", "Explicit assignment stays governed."],
    requirement_closure: ["Ticket ask: agentid alignment", "Implemented: agentid alignment", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "workflow paths",
        diff: null,
        risks: [],
        findings: null,
        verification: null,
        verdict: null,
        raw: "lens=workflow paths; command=coord/scripts/gov agentid; result=placeholder",
      },
      {
        cycle: 2,
        total: 3,
        lens: "unclaimed guidance",
        diff: null,
        risks: [],
        findings: null,
        verification: null,
        verdict: null,
        raw: "lens=unclaimed guidance; command=node --test coord/scripts/governance.test.js; result=placeholder",
      },
      {
        cycle: 3,
        total: 3,
        lens: "docs parity",
        diff: null,
        risks: [],
        findings: null,
        verification: null,
        verdict: null,
        raw: "lens=docs parity; command=rg -n 'agentid' coord/scripts/README.md; result=placeholder",
      },
    ],
    rollback_strategy: ["revert agentid command surface"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-30T02:00:00.000Z",
  };

  const next = planRecordOwner.applyPlanUpdateOptionsToRecord(record, {
    reviewCycle: [
      "lens=workflow paths; diff=plain agentid now returns structured guidance on unclaimed threads while claimed threads still report the active session; risks=unclaimed agentid could still throw, assignment modes could mutate the wrong session; findings=none; verification=coord/scripts/gov agentid; verdict=pass",
      "lens=assignment semantics; diff=agentid --assign and --owner now route through governed identity helpers and preserve explicit owner selection; risks=auto-assignment could allocate the wrong live id, explicit owner claim could bypass registry validation; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      "lens=docs parity; diff=CLI help and secondary README docs now describe the same assign-or-guidance behavior; risks=help text could still advertise the old hard-fail flow, board docs could omit the new flags; findings=none; verification=rg -n 'agentid' coord/scripts/README.md coord/board/README.md coord/scripts/governance.js; verdict=pass",
    ],
  });

  assert.equal(next.self_review_cycles.length, 3);
  assert.equal(next.self_review_cycles[0].diff.includes("structured guidance"), true);
  assert.deepEqual(next.self_review_cycles[1].risks, [
    "auto-assignment could allocate the wrong live id",
    "explicit owner claim could bypass registry validation",
  ]);
  assert.equal(next.self_review_cycles[2].verdict, "pass");
  assert.equal(next.self_review_cycles.some((cycle) => String(cycle.raw).includes("command=")), false);
});


// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const { coord006ScaffoldRecord } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));


test("updateCanonicalPlanState migrates a legacy-only, already-normalized shard to runtime (C6-P2 read/write-path token regression)", () => {
  // Regression: readPlanRecord reads via the C6-P2 compat reader, which may
  // resolve to the legacy board/plans path, but every WRITE lands at the
  // runtime path. BOARD_RAW_SYMBOL (passed back as `expectedRaw`) must describe
  // the runtime write target, not the legacy file. When the legacy shard is
  // already normalize-stable no repair-write fires, so the token was left
  // pointing at the legacy raw — and updateCanonicalPlanState then failed with
  // "Refusing to overwrite .runtime/plans/<id>.json because it changed".
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-c6p2-legacy-token-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });

  const fixtureSource = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  // Legacy-only shard, no runtime counterpart — exactly the state of a board
  // planned before the C6-P2 plan-shard relocation.
  fs.writeFileSync(
    path.join(legacyDir, "CMP-400.json"),
    `${JSON.stringify({ ...fixtureSource, ticket_id: "CMP-400" }, null, 2)}\n`
  );
  const legacyRawBefore = fs.readFileSync(path.join(legacyDir, "CMP-400.json"), "utf8");

  return withScopedGovernanceTestContext({
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: runtimeDir,
    LEGACY_PLAN_RECORDS_DIR: legacyDir,
  }, () => {
    try {
    // Must not throw "Refusing to overwrite ... because it changed".
    __testing.updateCanonicalPlanState("CMP-400", {
      summary: "Exercise the legacy-shard migration path.",
    });

    const runtimePath = path.join(runtimeDir, "CMP-400.json");
    assert.equal(fs.existsSync(runtimePath), true, "runtime shard must be created (migrated forward)");
    const migrated = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    assert.equal(migrated.ticket_id, "CMP-400");
    assert.ok(
      (migrated.change_summary || []).includes("Exercise the legacy-shard migration path."),
      "the plan update must be applied to the migrated record"
    );
    assert.equal(
      fs.readFileSync(path.join(legacyDir, "CMP-400.json"), "utf8"),
      legacyRawBefore,
      "writes must never touch the legacy tracked location"
    );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("COORD-006: freshly-started scaffold is not flagged as authored content under a non-default repo registry", () => {
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: "/srv/checkouts/acme-api-wt" },
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "acme-api" },
    legacyRepoAliases: { ...DEFAULT_PATHS.legacyRepoAliases, B: [] },
  }, () => {
    // acme-style registry: B is "acme-api", NOT the template default "backend",
    // and the repo root basename is unrelated to the registry name (a worktree
    // checkout dir). The record below was seeded while the registry still had
    // B -> "backend" (a GCV-4 config-seam upgrade happened between the wrong
    // start and the unstart attempt). Pre-fix, isScaffoldWorktreeIntendedFile
    // could not derive "backend" from the live registry and the freshly-started
    // ticket was mis-flagged as having authored content.

    // (a) The placeholder seeded under the OLD registry must still be recognized
    //     as the start scaffold — the check is structural, not registry-exact.
    const staleSeed = coord006ScaffoldRecord("SEC-010", "backend/.worktrees/claudea63/SEC-010/*");
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(staleSeed),
      true,
      "a freshly-started scaffold seeded under a different registry must NOT be flagged as authored content"
    );

    // (b) A placeholder seeded under the CURRENT customized registry is also fine.
    const currentSeed = coord006ScaffoldRecord("SEC-011", "acme-api/.worktrees/claudea63/SEC-011/*");
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(currentSeed),
      true
    );

    // (c) A multi-segment repo prefix (e.g. a nested repo path) is also fine.
    const nestedSeed = coord006ScaffoldRecord("SEC-012", "services/api/.worktrees/claudea63/SEC-012/*");
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(nestedSeed),
      true
    );
  });
});

test("COORD-006: genuinely authored plan content still fails the start-scaffold guard closed", () => {
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: "/srv/checkouts/acme-api-wt" },
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "acme-api" },
  }, () => {

    // A real authored intended_files entry — a concrete repo-relative source
    // path that is NOT in the recorded start seed (`scaffold_placeholders`
    // still holds only the worktree placeholder). This MUST be detected as
    // authored content so unstart fails closed and the work stays on the
    // board. COORD-009: the start seed lives in
    // `scaffold_placeholders.intended_files`; a path outside it is agent work.
    const authoredFile = coord006ScaffoldRecord("SEC-020", "acme-api/.worktrees/claudea63/SEC-020/*");
    authoredFile.intended_files = ["src/auth/session.ts"];
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredFile),
      false,
      "a concrete authored intended_files path must NOT be treated as a start scaffold"
    );

    // Authored verification content (TODO scaffold replaced) is real work even
    // when intended_files still carries the scaffold placeholder.
    const authoredVerify = coord006ScaffoldRecord("SEC-021", "acme-api/.worktrees/claudea63/SEC-021/*");
    authoredVerify.verification_commands = ["node --test coord/scripts/governance.test.js"];
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredVerify),
      false,
      "authored verification_commands content must fail the scaffold guard closed"
    );

    // Authored critical invariants are likewise real work.
    const authoredInvariants = coord006ScaffoldRecord("SEC-023", "acme-api/.worktrees/claudea63/SEC-023/*");
    authoredInvariants.critical_invariants = ["Session tokens never outlive their grant window."];
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredInvariants),
      false,
      "authored critical_invariants content must fail the scaffold guard closed"
    );

    // A second, genuinely-authored intended_files entry (more than one path)
    // is also real work — the scaffold only ever has exactly one placeholder.
    const twoFiles = coord006ScaffoldRecord("SEC-022", "acme-api/.worktrees/claudea63/SEC-022/*");
    twoFiles.intended_files = [
      "acme-api/.worktrees/claudea63/SEC-022/*",
      "src/auth/session.ts",
    ];
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(twoFiles),
      false
    );
  });
});

// COORD-099: parsePromptLikelyFiles unit test relocated to
// prompt-coverage.test.js (its owning module).

test("COORD-009: unstart scaffold guard treats start-seeded Likely Files intended_files as scaffold", () => {
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: "/srv/checkouts/acme-api-wt" },
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "acme-api" },
  }, () => {
    // acme-shaped non-default registry to confirm registry independence.

    // A freshly-started, completely unworked code ticket: `gov start` seeded
    // five prompt-derived "Likely Files" paths into `intended_files` and
    // recorded the SAME values (plus the worktree placeholder) into
    // `scaffold_placeholders.intended_files`.
    const seed = [
      "acme-api/.worktrees/claudea63/SEC-010/*",
      "src/auth/session.ts",
      "src/auth/token.ts",
      "src/auth/index.ts",
      "services/api/middleware/auth.ts",
      "services/api/routes/login.ts",
    ];
    const startSeeded = coord006ScaffoldRecord("SEC-010", "acme-api/.worktrees/claudea63/SEC-010/*");
    startSeeded.intended_files = [...seed];
    startSeeded.scaffold_placeholders = { intended_files: [...seed] };
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(startSeeded),
      true,
      "start-seeded Likely Files intended_files must be recognized as scaffold so unstart can proceed"
    );

    // An entry that is neither the worktree placeholder nor in the recorded
    // start seed — an agent added it via `gov update-plan --file`. The guard
    // must still fail closed.
    const agentEdited = coord006ScaffoldRecord("SEC-010", "acme-api/.worktrees/claudea63/SEC-010/*");
    agentEdited.intended_files = [...seed, "src/auth/NEW-agent-authored.ts"];
    agentEdited.scaffold_placeholders = { intended_files: [...seed] };
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(agentEdited),
      false,
      "intended_files edited beyond the recorded start seed must still fail the guard closed"
    );

    // The realistic post-edit shape: `update-plan --file` strips the recorded
    // scaffold values, leaving only the authored path and an emptied seed.
    const postEdit = coord006ScaffoldRecord("SEC-010", "acme-api/.worktrees/claudea63/SEC-010/*");
    postEdit.intended_files = ["src/auth/NEW-agent-authored.ts"];
    postEdit.scaffold_placeholders = {};
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(postEdit),
      false,
      "an authored path with no recorded seed must fail the guard closed"
    );

    // readRecordedIntendedFilesScaffoldSeed reads only off scaffold_placeholders
    // and never falls back to the implicit-worktree heuristic.
    assert.deepEqual(
      planRecordOwner.readRecordedIntendedFilesScaffoldSeed(startSeeded),
      seed
    );
    assert.deepEqual(
      planRecordOwner.readRecordedIntendedFilesScaffoldSeed(postEdit),
      []
    );
  });
});

test("updateCanonicalPlanState regenerates PLAN.md from canonical record state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-update-plan-record-first-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "## IMP-001 — 2026-03-25T00:00:00.000Z\n\n- Change summary:\n  - unrelated\n", "utf8");
  fs.writeFileSync(path.join(recordsDir, "DEBT-043.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-043",
    markdown_heading: "## DEBT-043 — 2026-03-29T14:05:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: coord/scripts/gov explain DEBT-043", "Outcome: canonical record only"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Restore compatibility markdown."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical plan records must be editable even if PLAN.md was not rendered yet."],
    requirement_closure: ["Ticket ask: plan regeneration", "Implemented: plan regeneration", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert helper"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T14:05:00.000Z",
  }, null, 2), "utf8");

  return withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.updateCanonicalPlanState("DEBT-043", {
      summary: "Update canonical state before rendering markdown.",
      verify: "node --test coord/scripts/governance.test.js",
      files: "coord/scripts/governance.js",
    });

    const record = JSON.parse(fs.readFileSync(path.join(recordsDir, "DEBT-043.json"), "utf8"));
    const planRaw = fs.readFileSync(planPath, "utf8");

    assert.deepEqual(record.change_summary, [
      "Restore compatibility markdown.",
      "Update canonical state before rendering markdown.",
    ]);
    assert.deepEqual(record.verification_commands, ["node --test coord/scripts/governance.test.js"]);
    assert.deepEqual(record.intended_files, ["coord/scripts/governance.js"]);
    assert.match(planRaw, /## DEBT-043 — 2026-03-29T14:05:00\.000Z/);
    assert.match(planRaw, /Update canonical state before rendering markdown\./);
    assert.match(planRaw, /`node --test coord\/scripts\/governance\.test\.js`/);
    assert.match(planRaw, /`coord\/scripts\/governance\.js`/);
  });
});

test("ensurePlanBlockForUpdate bootstraps missing plan state from the board row when no record or markdown block exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-bootstrap-update-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        heading: "Debt",
        kind: "table",
        level: 2,
        rows: [
          {
            ID: "DEBT-043",
            Repo: "X",
            Type: "infra",
            Pri: "P1",
            Status: "todo",
            Owner: "unassigned",
            Description: "Bootstrap missing plan state",
            "Depends On": "",
          },
        ],
      },
    ],
  }, null, 2), "utf8");

  return withScopedGovernanceTestContext({
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: recordsDir,
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
  }, () => {
    const result = __testing.ensurePlanBlockForUpdate("DEBT-043");
    const planRaw = fs.readFileSync(planPath, "utf8");
    const record = planRecordOwner.readPlanRecord("DEBT-043", { recordsDir });

    assert.equal(result.source, "new-stub");
    assert.match(planRaw, /## DEBT-043 — /);
    assert.doesNotMatch(planRaw, /coord\/\.worktrees\/unassigned\/DEBT-043/);
    assert.equal(record.ticket_id, "DEBT-043");
  });
});

test("updateCanonicalPlanState upgrades legacy markdown-only plan state into canonical JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-update-plan-legacy-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, `## IMP-221 — 2026-03-25T17:31:00Z

- Startup checklist:
  - completed
- Traceability gate:
  - closing-gap
- Baseline reproduction:
  - Command: not-required
  - Outcome: already reproduced
- Intended files:
  - \`coord/board/plans/IMP-221.json\`
- Change summary:
  - Introduce structured plan records.
- Verification commands:
  - \`node --test coord/scripts/governance.test.js\`
- Critical invariants:
  - Canonical plan state must survive markdown drift.
- Repo gates:
  - not-required
- Rollback strategy:
  - revert
- Security surface:
  - no
`, "utf8");

  return withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.updateCanonicalPlanState("IMP-221", {
      summary: "Promote markdown-only plan state into the canonical record.",
      verify: "node coord/board/board.js validate",
    });

    const record = JSON.parse(fs.readFileSync(path.join(recordsDir, "IMP-221.json"), "utf8"));
    const planRaw = fs.readFileSync(planPath, "utf8");

    assert.deepEqual(record.change_summary, [
      "Introduce structured plan records.",
      "Promote markdown-only plan state into the canonical record.",
    ]);
    assert.deepEqual(record.verification_commands, [
      "node --test coord/scripts/governance.test.js",
      "node coord/board/board.js validate",
    ]);
    assert.match(planRaw, /Promote markdown-only plan state into the canonical record\./);
    assert.match(planRaw, /`node coord\/board\/board\.js validate`/);
  });
});

test("COORD-014: a freshly-started ticket with start-RESOLVED startup/traceability is unstartable scaffold", () => {
  // gov start RESOLVES startup_checklist -> ["completed"] and traceability_gate
  // -> ["exempt"] (coord/X) / ["verified"|"closing-gap"]. These are not agent
  // authoring, so a bare start must still register as the start scaffold so the
  // documented wrong-start `unstart` path works. Pre-fix these resolved values
  // were misread as "authored content beyond the start scaffold".
  const intended = "coord/.worktrees/claudea11/COORD-700/*";

  const resolvedExempt = coord006ScaffoldRecord("COORD-700", intended);
  resolvedExempt.startup_checklist = ["completed"];
  resolvedExempt.traceability_gate = ["exempt"];
  assert.equal(
    planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(resolvedExempt),
    true,
    "a bare start with start-resolved startup/traceability must register as scaffold",
  );

  for (const grade of ["verified", "closing-gap"]) {
    const rec = coord006ScaffoldRecord("COORD-701", intended);
    rec.startup_checklist = ["completed"];
    rec.traceability_gate = [grade];
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(rec),
      true,
      `start-resolved traceability "${grade}" must register as scaffold`,
    );
  }

  // Authored content alongside the resolved start fields must STILL fail closed.
  const authored = coord006ScaffoldRecord("COORD-702", intended);
  authored.startup_checklist = ["completed"];
  authored.traceability_gate = ["exempt"];
  authored.critical_invariants = ["Real invariant the agent authored."];
  assert.equal(
    planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authored),
    false,
    "authored plan content must still fail the start-scaffold guard closed",
  );

  // A non-scaffold, non-resolved startup_checklist value is authored content.
  const authoredStartup = coord006ScaffoldRecord("COORD-703", intended);
  authoredStartup.startup_checklist = ["something an agent typed"];
  authoredStartup.traceability_gate = ["exempt"];
  assert.equal(
    planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredStartup),
    false,
    "a non-resolved, non-placeholder startup_checklist value is authored content",
  );
});

// ---------------------------------------------------------------------------
// COORD-159: optional server-bootstrap / startup / backfill / derived-data risk
// fields on plan records. Advisory metadata only — existing plan records without
// these fields must remain valid and round-trip byte-identically, and populated
// fields must survive render -> parse without data loss.
// ---------------------------------------------------------------------------

// assertValidPlanRecord is not exported on __testing; applyPlanUpdateOptionsToRecord
// normalizes and runs the same assertValidPlanRecord validation at the end, so it
// is the available seam to exercise plan-record validation (including bootstrap_risk)
// from tests.
function coord159AssertValid(record) {
  return planRecordOwner.applyPlanUpdateOptionsToRecord(record, {});
}

function coord159BaseRecord(ticketId = "COORD-159") {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-24T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    governance: {
      expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: [],
    intended_files: ["coord/engine/scripts/plan-records.js"],
    change_summary: ["Add bootstrap risk fields."],
    verification_commands: ["node --test coord/scripts/plan-records.test.js"],
    critical_invariants: ["Existing plan records must remain valid."],
    requirement_closure: [
      "Ticket ask: bootstrap risk fields",
      "Implemented: bootstrap risk fields",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    feature_proof: ["path:coord/engine/scripts/plan-records.js"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
  };
}

test("COORD-571 acknowledgement compatibility cannot relax the surrounding record contract", () => {
  // Exercise the record boundary independently of the normalizer. A malformed
  // dependency result must still be refused by the validator in either mode.
  const records = createReadonlyPlanRecordHarness({ normalizeGovernancePlanShape: value => value });
  const base = () => ({ ...coord159BaseRecord("ACK-571"), adr_refs: [], context_pack_ack: {} });
  const bad = [];
  for (const value of [null, "record", 1]) bad.push([value, /must be an object/]);
  const missing = base(); delete missing.ticket_id;
  bad.push([missing, /missing required field/]);
  for (const ticket_id of [null, "not-a-ticket"]) bad.push([{ ...base(), ticket_id }, /valid ticket_id/]);
  bad.push([{ ...base(), schema_version: 2 }, /Unsupported.*schema_version/]);
  for (const review_round of [0, 1.5, "1"]) bad.push([{ ...base(), review_round }, /review_round/]);
  for (const governance of [null, "governance", []]) bad.push([{ ...base(), governance }, /governance.*object/]);
  const governanceCase = (patch, error) => bad.push([{ ...base(), governance: { ...base().governance, ...patch } }, error]);
  for (const expected_closeout of [null, "closeout", []]) governanceCase({ expected_closeout }, /expected_closeout.*object/);
  const closeoutCase = (patch, error) => governanceCase({ expected_closeout: { ...base().governance.expected_closeout, ...patch } }, error);
  for (const method of [null, "invalid"]) closeoutCase({ method }, /expected_closeout.method/);
  for (const base_ref of [0, ""]) closeoutCase({ base_ref }, /expected_closeout.base_ref/);
  closeoutCase({ provenance_note: 1 }, /provenance_note/);
  for (const review_profile of [null, "invalid"]) governanceCase({ review_profile }, /review_profile/);
  governanceCase({ ticket_local_repairs: null }, /ticket_local_repairs.*array/);
  for (const repair of [null, [], "repair", { kind: "", required_question_logged: true },
    { kind: 1, required_question_logged: true }, { kind: "recover", required_question_logged: "yes" },
    { kind: "recover", required_question_logged: true, note: 1 }]) {
    governanceCase({ ticket_local_repairs: [repair] }, /ticket_local_repairs/);
  }
  for (const scaffold_placeholders of [null, [], "scaffold", { intended_files: "file" }, { intended_files: [1] }]) {
    bad.push([{ ...base(), scaffold_placeholders }, /scaffold_placeholders/]);
  }
  for (const value of ["command", [1]]) bad.push([{ ...base(), verification_commands: value }, /verification_commands/]);
  bad.push([{ ...base(), self_review_cycles: null }, /self_review_cycles.*array/]);
  for (const value of [null, [], "cycle", { cycle: 0, total: 1, raw: "review", risks: [] },
    { cycle: 1, total: 0, raw: "review", risks: [] }, { cycle: 1, total: 1, raw: 1, risks: [] },
    { cycle: 1, total: 1, raw: "review", risks: "risk" }, { cycle: 1, total: 1, raw: "review", risks: [1] }]) {
    bad.push([{ ...base(), self_review_cycles: [value] }, /self_review_cycles/]);
  }
  for (const gate_plan of [null, "receipt", []]) bad.push([{ ...base(), gate_plan }, /gate_plan.*object/]);
  for (const legacyAcknowledgementRead of [false, true]) {
    const options = { legacyAcknowledgementRead };
    assert.doesNotThrow(() => records.assertValidPlanRecord(base(), options));
    for (const [record, error] of bad) {
      assert.throws(() => records.assertValidPlanRecord(record, options), error);
    }
  }
});

test("COORD-571 partial schema metadata cannot bypass record version validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord571-schema-boundary-"));
  const original = DEFAULT_PATHS.planRecordSchemaPath;
  try {
    const schemaPath = path.join(dir, "plan.schema.json");
    // The factory captures its schema path at creation. Redirect that factory
    // alone to a disposable file; never change the pinned engine schema bytes.
    DEFAULT_PATHS.planRecordSchemaPath = schemaPath;
    const records = createReadonlyPlanRecordHarness();
    DEFAULT_PATHS.planRecordSchemaPath = original;
    for (const schema of [{}, { properties: {} }, { properties: { schema_version: { const: 1 } } }]) {
      fs.writeFileSync(schemaPath, JSON.stringify(schema));
      assert.throws(() => records.assertValidPlanRecord({ ...coord159BaseRecord("ACK-571"), schema_version: 2 }), /Unsupported.*schema_version/);
    }
  } finally {
    DEFAULT_PATHS.planRecordSchemaPath = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-571 legacy acknowledgement reads preserve bytes while every persistence path refuses them", () => {
  const records = createReadonlyPlanRecordHarness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord571-legacy-ack-"));
  const legacyValues = [
    { considered: { open_questions: "none" } },
    { notes: ["historical note"] },
    { authority: { rejected_authority: "old source" } },
    { closeout_learning: { decision: ["none"] } },
  ];
  const replacement = { considered: { open_questions: [] }, closeout_learning: { decision: null, rationale: null } };
  try {
    for (const [index, acknowledgement] of legacyValues.entries()) {
      const id = `ACK-${index}`;
      const record = { ...coord159BaseRecord(id), context_pack_ack: acknowledgement };
      const file = path.join(dir, `${id}.json`);
      const original = `${JSON.stringify(record, null, 2)}\n`;
      fs.writeFileSync(file, original);
      const read = records.readPlanRecord(id, { recordsDir: dir });
      assert.deepEqual(read.context_pack_ack, acknowledgement);
      assert.equal(fs.readFileSync(file, "utf8"), original, "pure read cannot rewrite a legacy acknowledgement");
      assert.throws(() => records.applyPlanUpdateOptionsToRecord(read, { summary: "unrelated change" }), /--context-pack-ack/);
      assert.throws(() => records.repairPlanRecord(id, { recordsDir: dir }), /--context-pack-ack/);
      const bootstrapId = `BOOT-${index}`;
      const block = records.renderPlanRecordBlock({ ...record, ticket_id: bootstrapId });
      assert.throws(() => records.syncPlanRecordFromBlock(bootstrapId, block, dir), /--context-pack-ack/);
      assert.equal(fs.existsSync(path.join(dir, `${bootstrapId}.json`)), false);
      assert.equal(fs.readFileSync(file, "utf8"), original, "refused persistence must preserve legacy bytes");
      const repaired = records.applyPlanUpdateOptionsToRecord(read, { contextPackAck: JSON.stringify(replacement) });
      assert.deepEqual(repaired.context_pack_ack, replacement);
      assert.doesNotThrow(() => records.assertValidPlanRecord(repaired));
      fs.writeFileSync(file, JSON.stringify({ ...record, unknown_record_field: true }));
      assert.throws(() => records.readPlanRecord(id, { recordsDir: dir }), /unknown_record_field/, "legacy acknowledgement compatibility cannot disable other record validation");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const COORD159_FULL_BOOTSTRAP_RISK = {
  startup_work_class: "server_bootstrap_job",
  runs_at_boot: false,
  shares_app_process: false,
  resource_envelope: {
    memory_mb: 1024,
    timeout_s: 900,
    expected_rows: 100000,
    batch_size: 500,
    db_pool_impact: "one read cursor, one writer",
  },
  idempotency_strategy: "lease + checkpoint + completion marker",
  checkpoint_strategy: "row-id watermark every batch",
  verification_signal: "job receipt + marker row + metric",
  rollback_or_disable: "feature flag off by default; rerun from checkpoint",
  observability_requirements: ["logs", "task status", "metrics", "failure reason"],
  data_access_shape: "paginated",
};

test("COORD-159: a plan record with all bootstrap risk fields round-trips through render/parse", () => {
  const record = coord159BaseRecord();
  record.bootstrap_risk = JSON.parse(JSON.stringify(COORD159_FULL_BOOTSTRAP_RISK));

  // Schema/validation accepts the populated optional object.
  assert.doesNotThrow(() => coord159AssertValid(record));

  const block = planRecordOwner.renderPlanRecordBlock(record, record.ticket_id);
  assert.match(block, /- Bootstrap risk:/);
  const reparsed = planRecordOwner.parsePlanBlockToRecord(record.ticket_id, block);
  assert.deepEqual(reparsed.bootstrap_risk, COORD159_FULL_BOOTSTRAP_RISK);
  assert.doesNotThrow(() => coord159AssertValid(reparsed));
});

test("COORD-159: a legacy plan record with no bootstrap risk stays valid and round-trips byte-identically", () => {
  const record = coord159BaseRecord("COORD-700");
  assert.equal("bootstrap_risk" in record, false);
  assert.doesNotThrow(() => coord159AssertValid(record));

  const block = planRecordOwner.renderPlanRecordBlock(record, record.ticket_id);
  // The optional section must be entirely absent for legacy records.
  assert.doesNotMatch(block, /Bootstrap risk/);

  const reparsed = planRecordOwner.parsePlanBlockToRecord(record.ticket_id, block);
  assert.equal("bootstrap_risk" in reparsed, false, "absent field must not be materialized on reparse");

  // Render is stable across a second pass (markdown round-trip is byte-identical).
  const reparsedForRender = { ...reparsed, markdown_heading: record.markdown_heading };
  const block2 = planRecordOwner.renderPlanRecordBlock(reparsedForRender, record.ticket_id);
  assert.equal(block2, block, "legacy plan record markdown must round-trip byte-identically");
});

test("COORD-159: a partial subset of bootstrap risk fields validates and round-trips", () => {
  const record = coord159BaseRecord("COORD-701");
  record.bootstrap_risk = {
    startup_work_class: "startup_work",
    runs_at_boot: true,
    data_access_shape: "single-row lookup",
  };
  assert.doesNotThrow(() => coord159AssertValid(record));

  const block = planRecordOwner.renderPlanRecordBlock(record, record.ticket_id);
  const reparsed = planRecordOwner.parsePlanBlockToRecord(record.ticket_id, block);
  assert.deepEqual(reparsed.bootstrap_risk, record.bootstrap_risk);

  // An empty resource_envelope subset is also accepted.
  const record2 = coord159BaseRecord("COORD-702");
  record2.bootstrap_risk = { resource_envelope: { memory_mb: 256 } };
  assert.doesNotThrow(() => coord159AssertValid(record2));
});

test("COORD-159: malformed bootstrap risk field types are rejected", () => {
  const badWorkClass = coord159BaseRecord("COORD-703");
  badWorkClass.bootstrap_risk = { startup_work_class: "not_a_class" };
  assert.throws(() => coord159AssertValid(badWorkClass), GovernanceError);

  const badBoolean = coord159BaseRecord("COORD-704");
  badBoolean.bootstrap_risk = { runs_at_boot: "yes" };
  assert.throws(() => coord159AssertValid(badBoolean), GovernanceError);

  const badEnvelope = coord159BaseRecord("COORD-705");
  badEnvelope.bootstrap_risk = { resource_envelope: { memory_mb: "lots" } };
  assert.throws(() => coord159AssertValid(badEnvelope), GovernanceError);

  const badObservability = coord159BaseRecord("COORD-706");
  badObservability.bootstrap_risk = { observability_requirements: "logs" };
  assert.throws(() => coord159AssertValid(badObservability), GovernanceError);

  const unknownField = coord159BaseRecord("COORD-707");
  unknownField.bootstrap_risk = { not_a_field: true };
  assert.throws(() => coord159AssertValid(unknownField), GovernanceError);

  const notAnObject = coord159BaseRecord("COORD-708");
  notAnObject.bootstrap_risk = ["server_bootstrap_job"];
  assert.throws(() => coord159AssertValid(notAnObject), GovernanceError);
});

test("COORD-159: the sample plan fixture carries a valid populated bootstrap risk example", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  assert.ok(fixture.bootstrap_risk, "sample fixture must include a populated bootstrap_risk example");
  assert.equal(fixture.bootstrap_risk.startup_work_class, "server_bootstrap_job");
  assert.doesNotThrow(() => coord159AssertValid(fixture));
});

// COORD-569: an investigation-shaped --invariant whose status is outside the
// gate's closed enum must be REFUSED at write time (it would be recorded
// successfully and then silently ignored by the business-context gate — the
// operator believes a disposition exists and discovers otherwise at closeout).
// The enum literals are shared from coord/engine/scripts/gates/business-context.js so the writer,
// the recognizer, and the gate's printed remediation cannot drift.
test("update-plan invariant guard refuses an investigation status outside the closed enum (COORD-569)", () => {
  const records = createReadonlyPlanRecordHarness();
  const record = { critical_invariants: [] };
  assert.throws(
    () => records.applyPlanUpdateOptionsToRecord(record, {
      invariant: "business-context investigation: claudea11/complete — no product rules touched",
    }),
    (error) => {
      assert.match(error.message, /silently ignored \(COORD-569\)/);
      assert.match(error.message, /investigating \| investigated \| not-required \| unknown \| blocked \| pending/);
      assert.match(error.message, /business-context investigation: not-required/);
      return true;
    }
  );
});

test("update-plan invariant guard accepts every enum literal, including literal-then-free-text (COORD-569)", () => {
  const { BUSINESS_CONTEXT_INVESTIGATION_STATUSES } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  const records = createReadonlyPlanRecordHarness();
  for (const status of BUSINESS_CONTEXT_INVESTIGATION_STATUSES) {
    const next = records.applyPlanUpdateOptionsToRecord(coord159BaseRecord("COORD-569"), {
      invariant: `business-context investigation: ${status} by claudea11 — rationale text`,
    });
    assert.ok(
      next.critical_invariants.some((line) => line.includes(status)),
      `status "${status}" must be accepted`
    );
  }
});

test("update-plan invariant guard leaves non-investigation invariants untouched (COORD-569)", () => {
  const records = createReadonlyPlanRecordHarness();
  const base = coord159BaseRecord("COORD-569");
  const baselineCount = base.critical_invariants.length;
  const next = records.applyPlanUpdateOptionsToRecord(base, {
    invariant: "business-context: coord/.runtime/context-packs/COORD-542.json",
  });
  assert.equal(next.critical_invariants.length, baselineCount + 1);
});

test("gate remediation names only executable commands and the real enum (COORD-569)", () => {
  const { createBusinessContextGate, BUSINESS_CONTEXT_INVESTIGATION_PATTERN } =
    require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  const gate = createBusinessContextGate({});
  const issues = gate.collectBusinessContextGateIssues(
    "COORD-999",
    { ID: "COORD-999", Repo: "X", Type: "bug", Description: "adjusts the billing workflow" },
    {},
    { sections: [] }
  );
  assert.equal(issues.length, 1);
  const steps = issues[0].next_steps.join("\n");
  // The suggested literal must satisfy the recognizer that emitted it.
  assert.match(steps, /business-context investigation: not-required/);
  assert.ok(BUSINESS_CONTEXT_INVESTIGATION_PATTERN.test('business-context investigation: not-required'));
  // The old trap placeholder must be gone.
  assert.ok(!steps.includes("<owner/status>"), "placeholder <owner/status> must not be suggested");
  assert.match(steps, /closed enum/);
});

test("COORD-554: infrastructure prose keywords do not trigger business-context risk", () => {
  const { createBusinessContextGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  const gate = createBusinessContextGate({});
  const ambiguousInfrastructureTerms = [
    "report",
    "reports",
    "workflow",
    "workflows",
    "integration",
    "integrations",
    "approval",
    "permission",
    "permissions",
  ];

  for (const term of ambiguousInfrastructureTerms) {
    assert.equal(
      gate.ticketTouchesBusinessContextRisk(
        { Type: "bug", Description: `The infrastructure ${term} is healthy.` },
        {
          intended_files: [],
          change_summary: [`The ${term} only checks governance metadata.`],
          critical_invariants: [],
          requirement_closure: [],
        }
      ),
      false,
      `infrastructure use of "${term}" must not trigger the business-context gate`
    );
  }
});

test("COORD-554: retained business-domain terms still trigger business-context risk", () => {
  const { createBusinessContextGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  const gate = createBusinessContextGate({});

  for (const term of ["business rule", "invoice", "billing", "pricing", "clinical"]) {
    assert.equal(
      gate.ticketTouchesBusinessContextRisk(
        { Type: "bug", Description: `Change to ${term} behavior.` },
        {}
      ),
      true,
      `business-domain term "${term}" must continue to fail closed`
    );
  }
});

test("COORD-647: historical stamped reviews render consistently without mutating frozen evidence", () => {
  const record = coord159BaseRecord("COORD-647");
  record.self_review_cycles = Object.freeze([3, 3, 3, 4].map((total, i) => Object.freeze({
    cycle: i + 1, total, lens: `historical lens ${i + 1}`, diff: "historical diff",
    risks: Object.freeze(["retained risk"]), findings: "retained findings", verification: "retained verification", verdict: "pass",
    raw: `lens=historical lens ${i + 1}; diff=historical diff; risks=retained risk; findings=retained findings; verification=retained verification; verdict=pass`,
  })));
  Object.freeze(record);
  const before = JSON.stringify(record);
  const records = createReadonlyPlanRecordHarness();
  const first = records.renderPlanRecordBlock(record);
  const second = records.renderPlanRecordBlock(record);
  assert.equal(second, first);
  assert.deepEqual([...first.matchAll(/Self-review cycle (\d+)\/(\d+):/g)].map(m => [Number(m[1]), Number(m[2])]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.equal(JSON.stringify(record), before);
});


test("normalizeLegacyPlanRecordShape preserves malformed inputs and seeds missing ticket ids (COORD-748 helper contract)", () => {
  for (const value of [null, "legacy", []]) {
    assert.deepEqual(
      planRecordOwner.normalizeLegacyPlanRecordShape("COORD-748", value),
      { record: value, changed: false },
      "helper-level normalization leaves non-record legacy inputs untouched",
    );
  }
  const normalized = planRecordOwner.normalizeLegacyPlanRecordShape("COORD-748", {}).record;
  assert.equal(normalized.ticket_id, "COORD-748");
  assert.equal(normalized.schema_version, 1);
  assert.deepEqual(normalized.feature_proof, []);
  assert.deepEqual(normalized.self_review_cycles, []);

  // This pure transform normalizes defensively, but a writer payload without a
  // ticket identity remains invalid and must fail schema validation.
  for (const value of [null, [], {}]) {
    assert.throws(
      () => planRecordOwner.applyPlanUpdateOptionsToRecord(value, {}),
      GovernanceError,
      "helper-level malformed records are rejected before any caller can persist them",
    );
  }
});

test("updateCanonicalPlanState refuses missing raw concurrency metadata before writing (dependency-fault seam)", () => {
  withGovernedSurfaceSandbox(() => {
    const ticketId = "COORD-748";
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`);
    const record = coord159BaseRecord(ticketId);
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const recordBefore = fs.readFileSync(recordPath, "utf8");
    const planBefore = fs.readFileSync(governanceState.PLAN_PATH, "utf8");

    const stateIoPath = require.resolve("./state-io.js");
    const planRecordsPath = require.resolve("./plan-records.js");
    const lifecyclePath = require.resolve("./lifecycle.js");
    const stateIo = require(stateIoPath);
    const originalAttach = stateIo.attachTrackedRaw;
    const originalRead = stateIo.readCanonicalJsonFile;
    const originalPlanRecordsModule = require.cache[planRecordsPath];
    const originalLifecycleModule = require.cache[lifecyclePath];
    let isolatedLifecycle;
    try {
      stateIo.attachTrackedRaw = (target, symbol, raw) =>
        symbol === stateIo.BOARD_RAW_SYMBOL ? undefined : originalAttach(target, symbol, raw);
      stateIo.readCanonicalJsonFile = (...args) => {
        const value = originalRead(...args);
        if (value && typeof value === "object") delete value[stateIo.BOARD_RAW_SYMBOL];
        return value;
      };
      delete require.cache[planRecordsPath];
      delete require.cache[lifecyclePath];
      isolatedLifecycle = require("./lifecycle.js");
    } finally {
      stateIo.attachTrackedRaw = originalAttach;
      stateIo.readCanonicalJsonFile = originalRead;
      if (originalPlanRecordsModule) require.cache[planRecordsPath] = originalPlanRecordsModule;
      if (originalLifecycleModule) require.cache[lifecyclePath] = originalLifecycleModule;
    }

    assert.throws(
      () => isolatedLifecycle.__testing.updateCanonicalPlanState(ticketId, { changeSummary: "fault injection" }),
      (error) => error instanceof GovernanceError && /raw concurrency token is unavailable/.test(error.message),
    );
    assert.equal(fs.readFileSync(recordPath, "utf8"), recordBefore, "missing raw metadata refuses before the record write");
    assert.equal(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), planBefore, "refusal also preserves compatibility text");
  });
});

test("COORD-748: existing plan-record option arms preserve the public writer contract", () => {
  const original = coord159BaseRecord("COORD-748");
  original.gate_plan = { planner_version: "gate-plan-v1" };
  const originalBytes = JSON.stringify(original);

  const cleared = planRecordOwner.applyPlanUpdateOptionsToRecord(original, { gatePlan: "none" });
  assert.equal(cleared.gate_plan, undefined, "the documented `none` value clears optional JSON-object metadata");
  assert.equal(JSON.stringify(original), originalBytes, "the pure record transformer leaves its input untouched");

  const fromJson = planRecordOwner.applyPlanUpdateOptionsToRecord(coord159BaseRecord("COORD-748"), {
    gatePlan: '{"planner_version":"gate-plan-v1"}',
  });
  assert.deepEqual(fromJson.gate_plan, { planner_version: "gate-plan-v1" });
  const fromObject = planRecordOwner.applyPlanUpdateOptionsToRecord(coord159BaseRecord("COORD-748"), {
    gatePlan: { planner_version: "gate-plan-v1" },
  });
  assert.deepEqual(fromObject.gate_plan, { planner_version: "gate-plan-v1" });

  const unchanged = coord159BaseRecord("COORD-748");
  const beforeInvalid = JSON.stringify(unchanged);
  assert.throws(() => planRecordOwner.applyPlanUpdateOptionsToRecord(unchanged, { gatePlan: "{" }),
    /--gate-plan expects a JSON object/);
  assert.throws(() => planRecordOwner.applyPlanUpdateOptionsToRecord(unchanged, { gatePlan: "[]" }),
    /--gate-plan expects a JSON object/);
  assert.equal(JSON.stringify(unchanged), beforeInvalid, "invalid JSON leaves the caller's record unchanged");

  const security = planRecordOwner.applyPlanUpdateOptionsToRecord(coord159BaseRecord("COORD-748"), {
    security: "fixture contains no production credentials",
    baseline: ["Command: node --test plan-records", "Outcome: focused fixture passed"],
  });
  assert.equal(security.security_surface, "fixture contains no production credentials");
  assert.deepEqual(security.baseline_reproduction.slice(-2), [
    "Command: node --test plan-records",
    "Outcome: focused fixture passed",
  ]);
});

test("COORD-748: review-cycle drop and replacement-count guards preserve cycle numbering", () => {
  const cycles = [
    "lens=contract; diff=first; risks=lost state, stale refs; findings=none; verification=fixture; verdict=pass",
    "lens=auth; diff=second; risks=wrong owner, missed refusal; findings=none; verification=fixture; verdict=pass",
    "lens=operations; diff=third; risks=stale plan, silent loss; findings=none; verification=fixture; verdict=pass",
  ];
  const seeded = planRecordOwner.applyPlanUpdateOptionsToRecord(coord159BaseRecord("COORD-748"), {
    replaceAllReviewCycles: true,
    reviewCycle: cycles,
  });
  const dropped = planRecordOwner.applyPlanUpdateOptionsToRecord(seeded, { dropReviewCycle: 2 });
  assert.deepEqual(dropped.self_review_cycles.map((cycle) => [cycle.cycle, cycle.total, cycle.diff]), [
    [1, 2, "first"],
    [2, 2, "third"],
  ]);
  assert.throws(() => planRecordOwner.applyPlanUpdateOptionsToRecord(seeded, { dropReviewCycle: 4 }),
    /Cannot drop review cycle 4/);
  assert.throws(() => planRecordOwner.applyPlanUpdateOptionsToRecord(seeded, {
    replaceReviewCycle: 1,
    reviewCycle: [cycles[0], cycles[1]],
  }), /requires exactly one --review-cycle value/);
  assert.equal(seeded.self_review_cycles.length, 3, "refused edits keep the original full collection intact");
});


test("COORD-807: updates after retraction preserve historical scaffold entries and allow explicit reintroduction", () => {
  const original = coord159BaseRecord("COORD-807");
  original.critical_invariants = ["TODO: old placeholder", "The journal remains verifiable."];
  const retracted = applyInvariantRetraction(original, {
    entry: evidenceRef("critical_invariant", 1, original.critical_invariants[0]),
    reason: "This placeholder is not a correctness condition.",
    actor: "fixture-reviewer", timestamp: "2026-10-13T00:00:00Z",
  }).record;
  const next = createReadonlyPlanRecordHarness().applyPlanUpdateOptionsToRecord(retracted, {
    invariant: "Protected outputs cannot overwrite governed records.",
  });
  assert.deepEqual(next.critical_invariants.slice(0, 2), original.critical_invariants);
  assert.deepEqual(next.evidence_dispositions, retracted.evidence_dispositions);
  assert.deepEqual(resolvePlanEvidence(next).critical_invariants, [
    "The journal remains verifiable.", "Protected outputs cannot overwrite governed records.",
  ]);
  const removed = applyInvariantRetraction(next, {
    entry: "The journal remains verifiable.", reason: "Replace this later after review.",
    actor: "fixture-reviewer", timestamp: "2026-10-13T00:00:01Z",
  }).record;
  const restored = createReadonlyPlanRecordHarness().applyPlanUpdateOptionsToRecord(removed, {
    invariant: "The journal remains verifiable.",
  });
  assert.equal(restored.critical_invariants.length, removed.critical_invariants.length + 1);
  assert.deepEqual(restored.evidence_dispositions, removed.evidence_dispositions);
  assert.deepEqual(resolvePlanEvidence(restored).critical_invariants, [
    "Protected outputs cannot overwrite governed records.", "The journal remains verifiable.",
  ]);
});

// COORD-1000: follow-up of COORD-932. An invalid closure entry in a legacy
// PLAN.md block must refuse before the canonical plan shard is written.
test("COORD-1000: an invalid closure entry in a legacy PLAN.md block cannot materialize a plan shard", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c1000-legacy-shard-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  try {
    const record = coord159BaseRecord("COORD-807");
    record.requirement_closure = ["Ticket ask: legacy shard probe", "Closeout verdict: complete"];
    const block = planRecordOwner.renderPlanRecordBlock(record);
    const poisoned = block.replace("- Requirement closure:\n", "- Requirement closure:\n  - Bogus closure entry without a recognized prefix\n");
    assert.notEqual(poisoned, block, "the fixture must carry the invalid closure entry");
    fs.writeFileSync(planPath, `${poisoned}`, "utf8");
    const shardPath = path.join(recordsDir, "COORD-807.json");
    withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
      assert.throws(
        () => planRecordOwner.updateCanonicalPlanState("COORD-807", { summary: "legacy shard probe" }),
        /Requirement closure entry "Bogus closure entry/,
      );
    });
    assert.equal(fs.existsSync(shardPath), false, "no plan shard may be materialized from an invalid closure entry");
    assert.equal(fs.readFileSync(planPath, "utf8"), poisoned, "PLAN.md must be left unchanged");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("canonical plan bootstrap refuses unknown tickets and verifies that stub creation persisted", () => {
  withGovernedSurfaceSandbox(() => {
    const ticket = "COORD-99001";
    const records = createReadonlyPlanRecordHarness();
    assert.throws(() => records.ensurePlanRecordForUpdate(ticket), /Unknown ticket "COORD-99001"/);

    for (const owner of [undefined, " "]) {
      const calls = [];
      const missingStub = createReadonlyPlanRecordHarness({
        getTicketRef: () => ({ row: { Repo: "X", Owner: owner } }),
        normalizeOwnerValue: (value) => value.trim(),
        ensurePlanStub: (...args) => calls.push(args),
      });
      assert.throws(() => missingStub.ensurePlanRecordForUpdate(ticket), /Could not bootstrap canonical plan state/);
      assert.deepEqual(calls, [[ticket, "X", "unassigned"]]);
      assert.equal(fs.existsSync(path.join(governanceState.PLAN_RECORDS_DIR, ticket + ".json")), false);
    }
  });
});
