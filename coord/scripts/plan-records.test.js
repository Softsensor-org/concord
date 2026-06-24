const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, GovernanceError } = require("./governance-test-utils.js");
const { DEFAULT_PATHS: ACTIVE_PATHS } = require("./governance-context.js");

// COORD-090/COORD-071: feature-proof normalization infers a ticket's repo from
// its id prefix. The relocated proof-normalization tests below pass no
// board/row context, so their ticket ids must use a prefix that maps to repo B
// under whichever config-matrix leg is running (default "MSRV", non-default
// "API"). Derive a B-mapped prefix from the active registry.
const B_TICKET_PREFIX =
  Object.entries(ACTIVE_PATHS.ticketPrefixToRepoCode || {}).find(([, code]) => code === "B")?.[0] || "MSRV";

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

  const record = __testing.parsePlanBlockToRecord("IMP-221", block);
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-plan-record-"));
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

  __testing.syncPlanRecordFromBlock("IMP-221", block, tempDir);
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

  const block = __testing.renderPlanRecordBlock(record);
  const reparsed = __testing.parsePlanBlockToRecord("DEBT-043", block);

  assert.equal(reparsed.ticket_id, "DEBT-043");
  assert.deepEqual(reparsed.startup_checklist, ["completed"]);
  assert.deepEqual(reparsed.traceability_gate, ["exempt"]);
  assert.deepEqual(reparsed.baseline_reproduction, ["Command: coord/scripts/gov explain DEBT-043", "Outcome: bootstrap seam reproduced"]);
  assert.deepEqual(reparsed.intended_files, ["coord/scripts/governance.js"]);
  assert.deepEqual(reparsed.verification_commands, ["node --test coord/scripts/governance.test.js"]);
  assert.equal(reparsed.self_review_cycles.length, 1);
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
  const plainBlock = __testing.renderPlanRecordBlock(baseRecord);
  assert.equal(/- Live-MCP:/.test(plainBlock), false);
  assert.equal(__testing.parsePlanBlockToRecord("LMCP-RT", plainBlock).live_mcp, undefined);

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
  const block = __testing.renderPlanRecordBlock({ ...baseRecord, live_mcp: liveMcp });
  assert.ok(/- Live-MCP:/.test(block));
  const reparsed = __testing.parsePlanBlockToRecord("LMCP-RT", block);
  assert.deepEqual(reparsed.live_mcp, liveMcp);
});


// ---------------------------------------------------------------------------
// COORD-090: relocated from governance.test.js (plan-records module behavior:
// parse/render/extract/replace canonical plan blocks, record normalization,
// applyPlanUpdateOptionsToRecord, scaffold-intended-file classification)
// ---------------------------------------------------------------------------

test("plan-record compat reader: runtime is canonical, legacy is read-only fallback (C6 Phase 2)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-c6p2-plan-compat-"));
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });

  // Clone a real schema-valid shard so assertValidPlanRecord passes. Sourced
  // from a durable test fixture rather than coord/board/plans/, which is
  // scrubbed to a clean seed in the copy-ready template (and whose shards
  // were relocated to .runtime/plans/ by C6-P2).
  const fixtureSource = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  const makeShard = (ticketId, marker) => ({
    ...fixtureSource,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — compat fixture (${marker})`,
  });

  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_RECORDS_DIR = runtimeDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = legacyDir;
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
    assert.equal(__testing.readPlanRecord("CMP-100").ticket_id, "CMP-100");

    // (2) A legacy-only shard with no runtime counterpart is still readable.
    fs.writeFileSync(
      path.join(legacyDir, "CMP-200.json"),
      `${JSON.stringify(makeShard("CMP-200", "legacy-only"), null, 2)}\n`
    );
    const legacyRead = __testing.readPlanRecord("CMP-200", { allowMissing: true });
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
    const winner = __testing.readPlanRecord("CMP-300");
    assert.equal(winner.markdown_heading, "## CMP-300 — compat fixture (runtime-fresh)");
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normalizeLegacyPlanRecordShape upgrades stale generic governance defaults for repo-backed tickets", () => {
  const normalized = __testing.normalizeLegacyPlanRecordShape("FE-001", {
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
      base_ref: __testing.paths.REPO_INTEGRATION_BRANCHES.F || "dev",
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
    security_surface: "no",
    synced_from_markdown_at: "2026-04-04T00:00:00.000Z",
  };

  const block = __testing.renderPlanRecordBlock(record, "FE-999");
  const reparsed = __testing.parsePlanBlockToRecord("FE-999", block);

  assert.deepEqual(reparsed.governance, record.governance);
});

test("applyPlanUpdateOptionsToRecord rejects malformed closure and feature-proof entries", () => {
  const record = {
    schema_version: 1,
    ticket_id: "FE-999",
    markdown_heading: "## FE-999",
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
    () => __testing.applyPlanUpdateOptionsToRecord(record, { closure: ["Implemented route-management UI"] }),
    GovernanceError
  );
  assert.throws(
    () => __testing.applyPlanUpdateOptionsToRecord(record, { featureProof: ["path:apps/ops-web/app/page.tsx#Widget"] }),
    GovernanceError
  );
  assert.doesNotThrow(() => __testing.applyPlanUpdateOptionsToRecord(record, {
    closure: ["Implemented: route-management exposes dispatcher controls."],
    featureProof: ["path:apps/ops-web/app/route-management/page.tsx", "symbol:packages/api-sdk/src/planning-dispatch.ts#PlanningStopTransferRequest"],
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
  const bPrefix = __testing.repoPrefixForCode("B");
  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
    featureProof: [
      `path:${bPrefix}packages/platform/core/src/event-bus.ts`,
      `symbol:${bPrefix}packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor`,
    ],
  });

  assert.deepEqual(nextRecord.feature_proof, [
    "path:packages/platform/core/src/event-bus.ts",
    "symbol:packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor",
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

  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    // Simulate a project that renamed B from "backend" to "msrv" but still
    // has historical plan records that reference "backend/...". Both the
    // canonical prefix and the legacy alias must normalize to repo-relative.
    __testing.paths.repoRegistry = { ...originalRegistry, B: "msrv" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: ["backend"] };

    const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
      featureProof: [
        "path:msrv/packages/platform/core/src/event-bus.ts",
        "path:backend/apps/api/src/http/events.controller.ts",
      ],
    });

    assert.deepEqual(nextRecord.feature_proof, [
      "path:packages/platform/core/src/event-bus.ts",
      "path:apps/api/src/http/events.controller.ts",
    ]);
  } finally {
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
});

test("plan list helpers stop at self-review cycle boundaries", () => {
  const block = `## IMP-185 — 2026-03-25T03:10:00Z

- Repo gates:
  - node coord/board/board.js validate
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, parser corruption; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Rollback strategy:
  - revert
`;

  assert.equal(__testing.isPlanSectionBoundary("- Self-review cycle 1/3: lens=..."), true);
  assert.deepEqual(__testing.readPlanListField(block, "Repo gates"), [
    "node coord/board/board.js validate",
  ]);

  const next = __testing.upsertListItem(block, "Repo gates", "`node --test coord/scripts/governance.test.js`");
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

  assert.equal(__testing.extractPlanBlocks(raw, "IMP-193").length, 2);
  const block = __testing.extractPlanBlock(raw, "IMP-193");
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

  const next = __testing.replacePlanBlock(raw, "IMP-193", updated);
  const blocks = __testing.extractPlanBlocks(next, "IMP-193");
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

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
    reviewCycle: [
      "lens=contract/state invariants; diff=git diff -- coord/scripts/governance.js; risks=state drift, bootstrap mismatch; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      "lens=auth/security/failure modes; diff=git diff -- coord/scripts/governance.js; risks=permission drift, unsafe fallback; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      "lens=tests/operability/performance; diff=git diff -- coord/scripts/governance.test.js; risks=coverage gap, compatibility drift; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
    ],
  });

  assert.equal(__testing.planRecordHasOnlyScaffoldSelfReviewCycles(record), true);
  assert.equal(nextRecord.self_review_cycles.length, 3);
  assert.equal(__testing.planRecordHasOnlyScaffoldSelfReviewCycles(nextRecord), false);
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
  assert.equal(__testing.planRecordHasOnlyScaffoldSelfReviewCycles(record), false);

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
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
    const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
      reviewCycle: [
        // Duplicate raw body of cycle 1 — must be skipped with a visible warning.
        "lens=contract; diff=diff-a; risks=risk 1, risk 2; findings=none; verification=node --test; verdict=pass",
      ],
    });
    assert.equal(nextRecord.self_review_cycles.length, 1, "duplicate cycle must not be appended");
    assert.equal(warnings.length, 1, "dedup must emit exactly one warning");
    assert.match(warnings[0], /review cycle skipped/);
    assert.match(warnings[0], /DEBT-045/, "warning should name the ticket id");
    assert.match(warnings[0], /--replace-review-cycle|set-review-cycles/);
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

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
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

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
    files: ["coord/scripts/governance.js"],
  });

  assert.deepEqual(nextRecord.intended_files, ["coord/scripts/governance.js"]);
});

test("isScaffoldWorktreeIntendedFile accepts configured repo prefixes and legacy aliases", () => {
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    __testing.paths.REPO_ROOTS = { ...originalRoots, B: "/tmp/project/packages/server" };
    __testing.paths.repoRegistry = { ...originalRegistry, B: "packages/server" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: ["backend"] };

    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("packages/server/.worktrees/unassigned/API-001/*"),
      true
    );
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("backend/.worktrees/unassigned/API-001/*"),
      true
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
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
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  try {
    // Empty registry: the predicate must STILL recognize the scaffold shape.
    __testing.paths.REPO_ROOTS = {};
    __testing.paths.repoRegistry = {};
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("anything/.worktrees/vg/SEC-010/*"),
      true,
      "the scaffold shape must be recognized without any registry entries"
    );
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("coord/.worktrees/vg/ARCH-001/*"),
      true,
      "coord-only scaffold worktrees stay recognized"
    );
    // Ticket-pinned form: the trailing segment must match the supplied id.
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/*", "SEC-010"),
      true
    );
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/*", "SEC-999"),
      false,
      "a placeholder for a different ticket must not match"
    );
    // Real authored paths are never the scaffold shape.
    assert.equal(__testing.isScaffoldWorktreeIntendedFile("src/index.ts"), false);
    assert.equal(__testing.isScaffoldWorktreeIntendedFile("backend/src/index.ts"), false);
    assert.equal(__testing.isScaffoldWorktreeIntendedFile(".worktrees/vg/SEC-010/*"), false);
    assert.equal(
      __testing.isScaffoldWorktreeIntendedFile("acme-api/.worktrees/vg/SEC-010/src/foo.ts"),
      false
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
  }
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

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
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

  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, {
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

  const reaffirmed = __testing.applyPlanUpdateOptionsToRecord(record, {
    files: ["coord/.worktrees/codexa02/DEBT-043/*"],
  });
  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(reaffirmed, {
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
  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, options);

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
  const nextRecord = __testing.applyPlanUpdateOptionsToRecord(record, options);

  assert.deepEqual(nextRecord.rollback_strategy, ["revert helper", "re-run governance tests"]);
});

test("materializePlanBlockFromRecord restores PLAN.md compatibility blocks from canonical records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-materialize-plan-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };

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

  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;

  try {
    const result = __testing.materializePlanBlockFromRecord("DEBT-043");
    const planRaw = fs.readFileSync(planPath, "utf8");
    assert.equal(result.materialized, true);
    assert.match(planRaw, /## DEBT-043 — 2026-03-29T14:05:00\.000Z/);
    assert.match(planRaw, /Restore compatibility markdown\./);
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
});

test("readPlanRecord rejects malformed canonical plan records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-plan-record-invalid-"));
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
    () => __testing.readPlanRecord("IMP-221", { recordsDir: tempDir }),
    (error) => error instanceof GovernanceError && /risks.*array of strings/i.test(error.message)
  );
});

test("readPlanRecord repairs legacy missing fields but still preserves canonical content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-plan-record-legacy-"));
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

  const record = __testing.readPlanRecord("IMP-310", { recordsDir: tempDir });

  assert.deepEqual(record.baseline_reproduction, []);
  assert.deepEqual(record.intended_files, []);

  const repaired = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.deepEqual(repaired.baseline_reproduction, []);
  assert.deepEqual(repaired.intended_files, []);
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

  const record = __testing.synthesizeHistoricalPlanRecord("IMP-170", row, board);

  assert.equal(record.ticket_id, "IMP-170");
  assert.equal(record.review_round, 2);
  assert.match(record.markdown_heading, /^## IMP-170 — historical backfill /);
  assert.match(record.verification_commands.join("\n"), /example\.test\/pr\/170/);
  assert.match(record.verification_commands.join("\n"), /abc123 merged/);
  assert.deepEqual(record.prior_findings, ["IMP-170-F1 — repair drift"]);
  assert.equal(record.self_review_cycles.length, 1);
  assert.equal(record.self_review_cycles[0].lens, "historical backfill");
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

  const next = __testing.applyPlanUpdateOptionsToRecord(record, {
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

const { coord006ScaffoldRecord } = require("./governance-test-utils.js");


test("updateCanonicalPlanState migrates a legacy-only, already-normalized shard to runtime (C6-P2 read/write-path token regression)", () => {
  // Regression: readPlanRecord reads via the C6-P2 compat reader, which may
  // resolve to the legacy board/plans path, but every WRITE lands at the
  // runtime path. BOARD_RAW_SYMBOL (passed back as `expectedRaw`) must describe
  // the runtime write target, not the legacy file. When the legacy shard is
  // already normalize-stable no repair-write fires, so the token was left
  // pointing at the legacy raw — and updateCanonicalPlanState then failed with
  // "Refusing to overwrite .runtime/plans/<id>.json because it changed".
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-c6p2-legacy-token-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });

  const fixtureSource = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  // Legacy-only shard, no runtime counterpart — exactly the state of a board
  // planned before the C6-P2 plan-shard relocation.
  fs.writeFileSync(
    path.join(legacyDir, "CMP-400.json"),
    `${JSON.stringify({ ...fixtureSource, ticket_id: "CMP-400" }, null, 2)}\n`
  );
  const legacyRawBefore = fs.readFileSync(path.join(legacyDir, "CMP-400.json"), "utf8");

  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = runtimeDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = legacyDir;
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
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-006: freshly-started scaffold is not flagged as authored content under a non-default repo registry", () => {
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    // acme-style registry: B is "acme-api", NOT the template default "backend",
    // and the repo root basename is unrelated to the registry name (a worktree
    // checkout dir). The record below was seeded while the registry still had
    // B -> "backend" (a GCV-4 config-seam upgrade happened between the wrong
    // start and the unstart attempt). Pre-fix, isScaffoldWorktreeIntendedFile
    // could not derive "backend" from the live registry and the freshly-started
    // ticket was mis-flagged as having authored content.
    __testing.paths.REPO_ROOTS = { ...originalRoots, B: "/srv/checkouts/acme-api-wt" };
    __testing.paths.repoRegistry = { ...originalRegistry, B: "acme-api" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: [] };

    // (a) The placeholder seeded under the OLD registry must still be recognized
    //     as the start scaffold — the check is structural, not registry-exact.
    const staleSeed = coord006ScaffoldRecord("SEC-010", "backend/.worktrees/claudea63/SEC-010/*");
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(staleSeed),
      true,
      "a freshly-started scaffold seeded under a different registry must NOT be flagged as authored content"
    );

    // (b) A placeholder seeded under the CURRENT customized registry is also fine.
    const currentSeed = coord006ScaffoldRecord("SEC-011", "acme-api/.worktrees/claudea63/SEC-011/*");
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(currentSeed),
      true
    );

    // (c) A multi-segment repo prefix (e.g. a nested repo path) is also fine.
    const nestedSeed = coord006ScaffoldRecord("SEC-012", "services/api/.worktrees/claudea63/SEC-012/*");
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(nestedSeed),
      true
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
});

test("COORD-006: genuinely authored plan content still fails the start-scaffold guard closed", () => {
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  try {
    __testing.paths.REPO_ROOTS = { ...originalRoots, B: "/srv/checkouts/acme-api-wt" };
    __testing.paths.repoRegistry = { ...originalRegistry, B: "acme-api" };

    // A real authored intended_files entry — a concrete repo-relative source
    // path that is NOT in the recorded start seed (`scaffold_placeholders`
    // still holds only the worktree placeholder). This MUST be detected as
    // authored content so unstart fails closed and the work stays on the
    // board. COORD-009: the start seed lives in
    // `scaffold_placeholders.intended_files`; a path outside it is agent work.
    const authoredFile = coord006ScaffoldRecord("SEC-020", "acme-api/.worktrees/claudea63/SEC-020/*");
    authoredFile.intended_files = ["src/auth/session.ts"];
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredFile),
      false,
      "a concrete authored intended_files path must NOT be treated as a start scaffold"
    );

    // Authored verification content (TODO scaffold replaced) is real work even
    // when intended_files still carries the scaffold placeholder.
    const authoredVerify = coord006ScaffoldRecord("SEC-021", "acme-api/.worktrees/claudea63/SEC-021/*");
    authoredVerify.verification_commands = ["node --test coord/scripts/governance.test.js"];
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredVerify),
      false,
      "authored verification_commands content must fail the scaffold guard closed"
    );

    // Authored critical invariants are likewise real work.
    const authoredInvariants = coord006ScaffoldRecord("SEC-023", "acme-api/.worktrees/claudea63/SEC-023/*");
    authoredInvariants.critical_invariants = ["Session tokens never outlive their grant window."];
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredInvariants),
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
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(twoFiles),
      false
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
  }
});

// COORD-099: parsePromptLikelyFiles unit test relocated to
// prompt-coverage.test.js (its owning module).

test("COORD-009: unstart scaffold guard treats start-seeded Likely Files intended_files as scaffold", () => {
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  try {
    // acme-shaped non-default registry to confirm registry independence.
    __testing.paths.REPO_ROOTS = { ...originalRoots, B: "/srv/checkouts/acme-api-wt" };
    __testing.paths.repoRegistry = { ...originalRegistry, B: "acme-api" };

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
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(startSeeded),
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
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(agentEdited),
      false,
      "intended_files edited beyond the recorded start seed must still fail the guard closed"
    );

    // The realistic post-edit shape: `update-plan --file` strips the recorded
    // scaffold values, leaving only the authored path and an emptied seed.
    const postEdit = coord006ScaffoldRecord("SEC-010", "acme-api/.worktrees/claudea63/SEC-010/*");
    postEdit.intended_files = ["src/auth/NEW-agent-authored.ts"];
    postEdit.scaffold_placeholders = {};
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(postEdit),
      false,
      "an authored path with no recorded seed must fail the guard closed"
    );

    // readRecordedIntendedFilesScaffoldSeed reads only off scaffold_placeholders
    // and never falls back to the implicit-worktree heuristic.
    assert.deepEqual(
      __testing.readRecordedIntendedFilesScaffoldSeed(startSeeded),
      seed
    );
    assert.deepEqual(
      __testing.readRecordedIntendedFilesScaffoldSeed(postEdit),
      []
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
  }
});

test("updateCanonicalPlanState regenerates PLAN.md from canonical record state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-update-plan-record-first-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };

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

  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;

  try {
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
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
});

test("ensurePlanBlockForUpdate bootstraps missing plan state from the board row when no record or markdown block exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-bootstrap-update-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
  };

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

  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;

  try {
    const result = __testing.ensurePlanBlockForUpdate("DEBT-043");
    const planRaw = fs.readFileSync(planPath, "utf8");
    const record = __testing.readPlanRecord("DEBT-043", { recordsDir });

    assert.equal(result.source, "new-stub");
    assert.match(planRaw, /## DEBT-043 — /);
    assert.match(planRaw, /coord\/\.worktrees\/unassigned\/DEBT-043/);
    assert.equal(record.ticket_id, "DEBT-043");
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
  }
});

test("updateCanonicalPlanState upgrades legacy markdown-only plan state into canonical JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-update-plan-legacy-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };

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

  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;

  try {
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
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
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
    __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(resolvedExempt),
    true,
    "a bare start with start-resolved startup/traceability must register as scaffold",
  );

  for (const grade of ["verified", "closing-gap"]) {
    const rec = coord006ScaffoldRecord("COORD-701", intended);
    rec.startup_checklist = ["completed"];
    rec.traceability_gate = [grade];
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(rec),
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
    __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authored),
    false,
    "authored plan content must still fail the start-scaffold guard closed",
  );

  // A non-scaffold, non-resolved startup_checklist value is authored content.
  const authoredStartup = coord006ScaffoldRecord("COORD-703", intended);
  authoredStartup.startup_checklist = ["something an agent typed"];
  authoredStartup.traceability_gate = ["exempt"];
  assert.equal(
    __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(authoredStartup),
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
  return __testing.applyPlanUpdateOptionsToRecord(record, {});
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
    intended_files: ["coord/scripts/plan-records.js"],
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
    feature_proof: ["path:coord/scripts/plan-records.js"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
  };
}

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

  const block = __testing.renderPlanRecordBlock(record, record.ticket_id);
  assert.match(block, /- Bootstrap risk:/);
  const reparsed = __testing.parsePlanBlockToRecord(record.ticket_id, block);
  assert.deepEqual(reparsed.bootstrap_risk, COORD159_FULL_BOOTSTRAP_RISK);
  assert.doesNotThrow(() => coord159AssertValid(reparsed));
});

test("COORD-159: a legacy plan record with no bootstrap risk stays valid and round-trips byte-identically", () => {
  const record = coord159BaseRecord("COORD-700");
  assert.equal("bootstrap_risk" in record, false);
  assert.doesNotThrow(() => coord159AssertValid(record));

  const block = __testing.renderPlanRecordBlock(record, record.ticket_id);
  // The optional section must be entirely absent for legacy records.
  assert.doesNotMatch(block, /Bootstrap risk/);

  const reparsed = __testing.parsePlanBlockToRecord(record.ticket_id, block);
  assert.equal("bootstrap_risk" in reparsed, false, "absent field must not be materialized on reparse");

  // Render is stable across a second pass (markdown round-trip is byte-identical).
  const reparsedForRender = { ...reparsed, markdown_heading: record.markdown_heading };
  const block2 = __testing.renderPlanRecordBlock(reparsedForRender, record.ticket_id);
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

  const block = __testing.renderPlanRecordBlock(record, record.ticket_id);
  const reparsed = __testing.parsePlanBlockToRecord(record.ticket_id, block);
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
    fs.readFileSync(path.join(__dirname, "__fixtures__", "plan-record.sample.json"), "utf8")
  );
  assert.ok(fixture.bootstrap_risk, "sample fixture must include a populated bootstrap_risk example");
  assert.equal(fixture.bootstrap_risk.startup_work_class, "server_bootstrap_job");
  assert.doesNotThrow(() => coord159AssertValid(fixture));
});
