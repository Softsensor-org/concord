const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { __testing } = require("./board.js");
const { createCoordPaths } = require("../paths.js");
const { evidenceRef, applyInvariantRetraction, applySupersession, readPlanEvidenceFromBlock, resolvePlanEvidence } = require("../engine/scripts/plan-evidence-supersession.js");
const { createTempGitRepo, seedCoordRuntimeGitignoreFixture } = require("../scripts/governance-test-utils.js");
const { withApprovedPacket } = require("../scripts/fixtures/approved-reconcile.js");
const { createApprovalFixture } = require("../engine/scripts/__fixtures__/approval-fixture.js");

// C6 Phase 2: plan shards are runtime-owned (.runtime/plans) with a temporary
// compatibility reader over the legacy tracked dir (board/plans). The existing
// fs-mock harnesses below intercept only the legacy dir (path.join(__dirname,
// "plans")); point the runtime dir at a path that never exists so the real
// repo's .runtime/plans cannot leak into those mocked unions. Compat-specific
// tests override these explicitly.
__testing.paths.PLAN_RECORDS_DIR = path.join(
  os.tmpdir(),
  "legacy-board-nonexistent-runtime-plans"
);
__testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(__dirname, "plans");

function runGit(cwd, args, env) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
  return String(result.stdout || "").trim();
}

function makePlanRecord(ticketId, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-03-25T17:48:38.165Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: baseline"],
    prior_findings: [],
    intended_files: ["coord/board/board.js"],
    change_summary: ["Render PLAN.md from canonical records."],
    verification_commands: ["node coord/board/board.js sync"],
    critical_invariants: ["Canonical render must be deterministic."],
    requirement_closure: [
      "Ticket ask: render markdown",
      "Implemented: rendered markdown",
      "Not implemented: none",
      "Deferred to: none",
      "Closeout verdict: complete",
    ],
    repo_gates: ["node coord/board/board.js validate"],
    self_review_cycles: [],
    rollback_strategy: ["revert renderer"],
    governance: {
      expected_closeout: {
        method: "no_pr",
        base_ref: "main",
        provenance_note: null,
      },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-03-25T17:55:00.000Z",
    ...overrides,
  };
}

test("writeCompatibilityCopy mirrors rendered outputs into the legacy root path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-compat-copy-"));
  const renderedPath = path.join(tempDir, "rendered", "TASKS.md");
  const compatibilityPath = path.join(tempDir, "TASKS.md");
  const content = "# Generated tasks board\n";

  __testing.writeCompatibilityCopy(renderedPath, compatibilityPath, content);

  assert.equal(fs.readFileSync(compatibilityPath, "utf8"), content);
});

test("renderPlanMarkdown uses board ticket order and suppresses redundant TODO placeholders", () => {
  const board = {
    metadata: {
      plan_markdown_render_statuses: ["doing", "review"],
    },
    sections: [
      {
        rows: [
          { ID: "IMP-222", Status: "review" },
          { ID: "IMP-200", Status: "done" },
        ],
      },
    ],
  };
  const planRecords = new Map([
    ["IMP-200", {
      ticket_id: "IMP-200",
      markdown_heading: "## IMP-200 — 2026-03-25T16:38:00Z",
      startup_checklist: ["completed"],
      traceability_gate: ["closing-gap"],
      review_round: 1,
      baseline_reproduction: ["Command: not-required", "Outcome: already reproduced"],
      prior_findings: [],
      intended_files: ["coord/example-a"],
      change_summary: ["older ticket"],
      verification_commands: ["node a"],
      critical_invariants: ["older invariant"],
      requirement_closure: ["Ticket ask: older ticket", "Implemented: older ticket", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      repo_gates: ["node a"],
      self_review_cycles: [],
      rollback_strategy: ["revert a"],
      security_surface: "no",
    }],
    ["IMP-222", {
      ticket_id: "IMP-222",
      markdown_heading: "## IMP-222 — 2026-03-25T17:48:38.165Z",
      startup_checklist: ["TODO: completed", "completed"],
      traceability_gate: ["TODO: verified | closing-gap | exempt", "closing-gap"],
      review_round: 1,
      baseline_reproduction: ["Command: not-required", "Outcome: renderer baseline"],
      prior_findings: [],
      intended_files: ["coord/board/board.js"],
      change_summary: ["TODO: describe the intended change.", "Render PLAN.md from canonical records."],
      verification_commands: ["TODO", "node coord/board/board.js sync"],
      critical_invariants: ["TODO: placeholder", "Canonical render must be deterministic."],
      requirement_closure: ["TODO: Ticket ask: <what the ticket said to deliver>", "Ticket ask: render plan markdown", "Implemented: rendered markdown", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      repo_gates: ["TODO: add executed repo gate(s)", "node coord/board/board.js validate"],
      self_review_cycles: [],
      rollback_strategy: ["TODO", "revert renderer"],
      security_surface: "no",
    }],
  ]);

  const rendered = __testing.renderPlanMarkdown(board, planRecords);

  assert.match(rendered, /## IMP-222/);
  assert.doesNotMatch(rendered, /## IMP-200/);
  assert.match(rendered, /- Startup checklist:\n  - completed/);
  assert.doesNotMatch(rendered, /TODO: completed/);
  assert.doesNotMatch(rendered, /TODO: describe the intended change\./);
  assert.match(rendered, /Render PLAN\.md from canonical records\./);
});

test("COORD-807 prototype: PLAN renderer separates active invariants from append-only retraction history", () => {
  const oldValue = "timing probe must not govern release";
  const record = applyInvariantRetraction({
    ticket_id: "IMP-807",
    critical_invariants: [oldValue, "Append-only history remains auditable."],
  }, {
    entry: evidenceRef("critical_invariant", 1, oldValue),
    reason: "The probe is not a behavioral constraint.",
    actor: "codexa756",
    timestamp: "2026-10-05T19:30:00.000Z",
  }).record;
  const rendered = __testing.renderPlanMarkdown({
    sections: [{ rows: [{ ID: "IMP-807", Status: "doing" }] }],
  }, new Map([["IMP-807", record]]));

  const activeSection = rendered.split("- Critical invariants:")[1]?.split("\n- ")[0] || "";
  const historySection = rendered.split("- Critical invariant history (append-only):")[1]?.split("\n- ")[0] || "";
  assert.match(activeSection, /Append-only history remains auditable/);
  assert.doesNotMatch(activeSection, /timing probe/);
  assert.match(historySection, /timing probe must not govern release/);
  assert.match(rendered, /The probe is not a behavioral constraint/);
});

// COORD-822: the board-rebuilt PLAN.md is the operator's view, so it shows the
// active projection, keeps the append-only history byte-exact (ordinals are
// identities), carries every correction ledger, and lists the stable refs.
test("COORD-822: PLAN renderer shows active evidence, exact history, all ledgers, and stable refs", () => {
  const correction = { actor: "codexa756", timestamp: "2026-10-13T00:00:00.000Z" };
  const restated = "Board writes stay single-writer.";
  let record = {
    ticket_id: "IMP-822",
    repo_gates: ["npm test - result=pass on stale head", "npm run gate - result=pass"],
    verification_commands: ["node --test old.test.js"],
    critical_invariants: [restated, "Journal state stays verifiable."],
  };
  record = applySupersession(record, { ...correction, kind: "repo_gate", entry: record.repo_gates[0], replacement: "npm test - result=pass on current head", reason: "stale head" }).record;
  record = applySupersession(record, { ...correction, kind: "verification_command", entry: record.verification_commands[0], replacement: "node --test current.test.js", reason: "renamed test" }).record;
  record = applyInvariantRetraction(record, { ...correction, entry: restated, reason: "restated below" }).record;
  record = { ...record, critical_invariants: [...record.critical_invariants, restated] };

  const rendered = __testing.renderPlanMarkdown({ sections: [{ rows: [{ ID: "IMP-822", Status: "doing" }] }] }, new Map([["IMP-822", record]]));
  const readList = (block, name) => {
    const lines = block.split("\n");
    const start = lines.indexOf(`- ${name}:`);
    if (start === -1) return [];
    const values = [];
    for (const line of lines.slice(start + 1)) {
      if (/^- /.test(line) || /^#/.test(line)) break;
      const match = /^  - (.*)$/.exec(line);
      if (match) values.push(match[1]);
    }
    return values;
  };
  assert.deepEqual(readList(rendered, "Repo gates"), ["npm test - result=pass on current head", "npm run gate - result=pass"]);
  assert.deepEqual(readList(rendered, "Verification commands"), ["`node --test current.test.js`"]);
  assert.deepEqual(readList(rendered, "Critical invariants"), ["Journal state stays verifiable.", restated]);
  assert.deepEqual(readList(rendered, "Critical invariant history (append-only)"), record.critical_invariants,
    "history keeps the re-added duplicate so stored ordinals still resolve");
  const parsed = readPlanEvidenceFromBlock(rendered, { readList, stripTicks: (value) => value.replace(/^`|`$/g, ""), fail: (message) => { throw new Error(message); } });
  assert.deepEqual(parsed, {
    repo_gates: record.repo_gates,
    verification_commands: record.verification_commands,
    critical_invariants: record.critical_invariants,
    evidence_supersessions: record.evidence_supersessions,
    evidence_dispositions: record.evidence_dispositions,
  }, "the rendered view round-trips every correction ledger");
  const identities = readList(rendered, "Evidence identities (derived)");
  for (const entry of Object.values(resolvePlanEvidence(record).current_entries).flat()) {
    assert.ok(identities.includes(`${entry.ref} = ${JSON.stringify(entry.value)}`), `missing identity for ${entry.ref}`);
  }
  assert.equal(identities.length, 5);
});

test("COORD-858: board-rebuilt PLAN.md retains the immutable review submission scope", () => {
  const submission = { repository: "backend", commit: "a".repeat(40) };
  const record = { ticket_id: "B-858", review_submission: submission, independent_reviews: [] };
  const rendered = __testing.renderPlanMarkdown(
    { sections: [{ rows: [{ ID: "B-858", Status: "review" }] }] },
    new Map([["B-858", record]])
  );
  assert.match(rendered, /- Review submission:\n  - \{"repository":"backend","commit":"a{40}"\}/);
});

test("COORD-822: review-gate repo-gate presence reads the active projection and fails closed on a bad ledger", () => {
  const correction = { actor: "codexa756", timestamp: "2026-10-13T00:00:00.000Z" };
  const executed = { repo_gates: ["npm test - result=pass"] };
  assert.equal(__testing.planRecordHasExecutedRepoGates(executed), true);
  assert.equal(__testing.planRecordHasExecutedRepoGates({}), false);
  const superseded = applySupersession(executed, { ...correction, kind: "repo_gate", entry: executed.repo_gates[0], replacement: "not-required: coord-only change", reason: "wrong repo" }).record;
  assert.equal(__testing.planRecordHasExecutedRepoGates(superseded), false, "a superseded pass is history, not an executed gate");
  assert.equal(__testing.planRecordHasExecutedRepoGates({ ...executed, evidence_supersessions: [{}] }), false);
});

test("collectBoardRenderState skips whole-board lifecycle validation during render-only passes", () => {
  const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
  const board = {
    metadata: {
      plan_markdown_render_statuses: ["doing", "review"],
      title: "Render-only board",
    },
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Render-only",
        separator_before: false,
        columns: ["ID", "Repo", "Status", "Owner"],
        rows: [
          { ID: "IMP-301", Repo: "X", Status: "doing", Owner: "unassigned" },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  };
  const currentPlanRecord = JSON.stringify(makePlanRecord("IMP-301"), null, 2);
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.existsSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath, ...rest);
    };
    fs.readdirSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-301.json", "ORPH-999.json"];
      }
      return originalReaddirSync(targetPath, ...rest);
    };
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-301.json")) {
        return currentPlanRecord;
      }
      if (targetPath === path.join(__dirname, "plans", "ORPH-999.json")) {
        return "{not valid json";
      }
      return originalReadFileSync(targetPath, ...rest);
    };

    const renderState = __testing.collectBoardRenderState(board, planSchema, {
      scopePlanRecordsToRenderedTickets: true,
    });
    assert.equal(renderState.ticketCount, 1);
    assert.equal(renderState.doingCount, 1);
    assert.equal(renderState.planRecords.size, 1);
    assert.equal(renderState.planRecords.get("IMP-301")?.ticket_id, "IMP-301");
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
  }

  assert.throws(
    () => __testing.validateBoard(board, { type: "object" }, { type: "object" }, {
      skipWorktreeValidation: true,
    }),
    /is doing but has no active owner/
  );
});

test("requiresPlanRecordGovernance activates for modern governed tickets at or after the threshold", () => {
  const metadata = {
    plan_records_required_from_ticket: "IMP-120",
  };

  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "IMP-119", { Repo: "X" }), false);
  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "IMP-120", { Repo: "X" }), true);
  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "IMP-170", { Repo: "F" }), true);
  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "DES-025", { Repo: "X" }), false);
});

test("repo-scoped governance thresholds apply independently per repo prefix", () => {
  const metadata = {
    plan_records_required_from_ticket: {
      X: "ARCH-001",
      B: "MSRV-001",
      F: "FE-001",
    },
    pr_index_required_from_ticket: {
      B: "MSRV-001",
      F: "FE-001",
    },
    landing_index_required_from_ticket: {
      B: "MSRV-001",
      F: "FE-001",
    },
    feature_proof_required_from_ticket: {
      B: "MSRV-058",
      F: "FE-079",
    },
  };

  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "ARCH-001", { Repo: "X" }), true);
  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "MSRV-001", { Repo: "B" }), true);
  assert.equal(__testing.requiresPlanRecordGovernance(metadata, "FE-001", { Repo: "F" }), true);
  assert.equal(__testing.requiresPrIndexGovernance(metadata, "FE-001", { Repo: "F" }), true);
  assert.equal(__testing.requiresLandingGovernance(metadata, "FE-001", { Repo: "F" }), true);
  assert.equal(__testing.requiresFeatureProofGovernance(metadata, "MSRV-057", { Repo: "B" }), false);
  assert.equal(__testing.requiresFeatureProofGovernance(metadata, "MSRV-058", { Repo: "B" }), true);
  assert.equal(__testing.requiresFeatureProofGovernance(metadata, "FE-078", { Repo: "F" }), false);
  assert.equal(__testing.requiresFeatureProofGovernance(metadata, "FE-079", { Repo: "F" }), true);
  assert.equal(__testing.requiresPrIndexGovernance(metadata, "DEBT-049", { Repo: "X" }), false);
});

test("requiresPrIndexGovernance falls back to the landing cutoff when no explicit pr_index cutoff is configured", () => {
  const metadata = {
    landing_index_required_from_ticket: "IMP-120",
  };

  assert.equal(__testing.requiresPrIndexGovernance(metadata, "IMP-119", { Repo: "B" }), false);
  assert.equal(__testing.requiresPrIndexGovernance(metadata, "IMP-120", { Repo: "B" }), true);
  assert.equal(__testing.requiresPrIndexGovernance(metadata, "IMP-170", { Repo: "F" }), true);
  assert.equal(__testing.requiresPrIndexGovernance(metadata, "DEBT-049", { Repo: "X" }), false);
});

test("ticketHasHistoricalCloseoutEvidence treats PR, landing, and review-finding records as closed-ticket history", () => {
  assert.equal(__testing.ticketHasHistoricalCloseoutEvidence(["https://github.com/example/repo/pull/1"], null, []), true);
  assert.equal(__testing.ticketHasHistoricalCloseoutEvidence([], { evidence: ["merged sha"] }, []), true);
  assert.equal(__testing.ticketHasHistoricalCloseoutEvidence([], null, [{ id: "IMP-100-F1" }]), true);
  assert.equal(__testing.ticketHasHistoricalCloseoutEvidence([], null, []), false);
});

test("readPlanRecords validates record schema and returns canonical entries by ticket id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-plan-records-"));
  const planDir = path.join(tempDir, "plans");
  fs.mkdirSync(planDir, { recursive: true });

  fs.writeFileSync(path.join(planDir, "IMP-222.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-222",
    markdown_heading: "## IMP-222 — 2026-03-25T17:48:38.165Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: baseline"],
    prior_findings: [],
    intended_files: ["coord/board/board.js"],
    change_summary: ["Render PLAN.md from canonical records."],
    verification_commands: ["node coord/board/board.js sync"],
    critical_invariants: ["Canonical render must be deterministic."],
    requirement_closure: ["Ticket ask: render markdown", "Implemented: rendered markdown", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["node coord/board/board.js validate"],
    adr_refs: ["ADR-0001"],
    decision_required: {
      required: true,
      status: "investigating",
      reason: "Governance policy behavior is changing.",
      risk_class: "governance-policy",
      owner: "orchestrator",
      adr_refs: ["ADR-0001"],
    },
    self_review_cycles: [],
    rollback_strategy: ["revert renderer"],
    governance: {
      expected_closeout: {
        method: "no_pr",
        base_ref: "main",
        provenance_note: null,
      },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    security_surface: "no",
    synced_from_markdown_at: "2026-03-25T17:55:00.000Z",
  }, null, 2));

  const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
  const tickets = new Map([["IMP-222", { row: { ID: "IMP-222" } }]]);
  const errors = [];

  const originalReaddirSync = fs.readdirSync;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;

  try {
    fs.existsSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath, ...rest);
    };
    fs.readdirSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-222.json"];
      }
      return originalReaddirSync(targetPath, ...rest);
    };
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-222.json")) {
        return originalReadFileSync(path.join(planDir, "IMP-222.json"), ...rest);
      }
      return originalReadFileSync(targetPath, ...rest);
    };

    const records = __testing.readPlanRecords(planSchema, tickets, errors);
    assert.equal(errors.length, 0);
    assert.equal(records.get("IMP-222").ticket_id, "IMP-222");
    assert.equal(records.get("IMP-222").review_round, 1);
    assert.deepEqual(records.get("IMP-222").adr_refs, ["ADR-0001"]);
    assert.equal(records.get("IMP-222").decision_required.status, "investigating");
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("shouldIgnoreActiveLockValidationError ignores unrelated active lock drift during another ticket mutation", () => {
  assert.equal(
    __testing.shouldIgnoreActiveLockValidationError("DEBT-038", {
      ignoreActiveTicketLockErrors: true,
      currentTicketId: "IMP-237",
    }),
    true
  );
  assert.equal(
    __testing.shouldIgnoreActiveLockValidationError("IMP-237", {
      ignoreActiveTicketLockErrors: true,
      currentTicketId: "IMP-237",
    }),
    false
  );
});

test("readPlanRecords scopes ticket-scoped validation to the current ticket", () => {
  const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
  const tickets = new Map([
    ["IMP-222", { row: { ID: "IMP-222" } }],
    ["IMP-301", { row: { ID: "IMP-301" } }],
  ]);
  const originalReaddirSync = fs.readdirSync;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;

  try {
    fs.existsSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath, ...rest);
    };
    fs.readdirSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-222.json", "ORPH-999.json", "BROKEN-123.json"];
      }
      return originalReaddirSync(targetPath, ...rest);
    };
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-222.json")) {
        return JSON.stringify(makePlanRecord("IMP-222"), null, 2);
      }
      if (targetPath === path.join(__dirname, "plans", "ORPH-999.json")) {
        return JSON.stringify(makePlanRecord("ORPH-999"), null, 2);
      }
      if (targetPath === path.join(__dirname, "plans", "BROKEN-123.json")) {
        return "{not valid json";
      }
      return originalReadFileSync(targetPath, ...rest);
    };

    const scopedErrors = [];
    const scopedRecords = __testing.readPlanRecords(planSchema, tickets, scopedErrors, {
      ticketScopedValidation: true,
      currentTicketId: "IMP-222",
    });
    assert.deepEqual(scopedErrors, []);
    assert.deepEqual([...scopedRecords.keys()], ["IMP-222"]);

    const unscopedErrors = [];
    __testing.readPlanRecords(planSchema, tickets, unscopedErrors);
    assert.match(unscopedErrors.join("\n"), /unknown ticket "ORPH-999"|not valid JSON/);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("shouldIgnoreActiveLockValidationError only activates when explicitly requested", () => {
  assert.equal(
    __testing.shouldIgnoreActiveLockValidationError("DEBT-038", {
      ignoreActiveTicketLockErrors: false,
      currentTicketId: "IMP-237",
    }),
    false
  );
  assert.equal(
    __testing.shouldIgnoreActiveLockValidationError("DEBT-038", {}),
    false
  );
});

test("expectedLockRepoForCode uses repoRegistry path before repoRoot basename", () => {
  const paths = {
    repoRegistry: { B: "packages/server" },
    repoRoots: { B: "/tmp/project/packages/server" },
  };

  assert.equal(__testing.expectedLockRepoForCode("B", paths), "packages/server");
  assert.equal(__testing.expectedLockRepoForCode("X", paths), "coord");
});

test("repo-backed lock validation follows arbitrary configured repo codes", () => {
  const configuredRepoRoots = {
    E: "/tmp/example-service",
    C: "/tmp/example-client",
  };

  assert.equal(__testing.isRepoBackedCode("E", configuredRepoRoots), true);
  assert.equal(__testing.isRepoBackedCode("C", configuredRepoRoots), true);
  assert.equal(__testing.isRepoBackedCode("X", configuredRepoRoots), false);
  assert.equal(__testing.isRepoBackedCode("Z", configuredRepoRoots), false);
});

test("COORD-644: board lock validation uses registered Repo X HEAD only in Git-backed control-plane layouts", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-repo-x-lock-"));
  const controlPlaneRepo = createTempGitRepo("legacy-board-repo-x-control-plane-", { "README.md": "Disposable control-plane Git root.\n" });
  const repoRoot = controlPlaneRepo.repoRoot;
  const worktree = path.join(tempRoot, "registered-worktree");
  const locksDir = path.join(tempRoot, "locks");
  const legacyLocksDir = path.join(tempRoot, "legacy-locks");
  const ticketId = "TEST-644";
  const owner = "codexa0001";
  const branch = `agent/${owner.toLowerCase()}-${ticketId.toLowerCase()}-board-fixture`;
  const lockPath = path.join(locksDir, `${ticketId}.lock`);
  const original = {
    locks: __testing.paths.LOCKS_DIR,
    legacyLocks: __testing.paths.LEGACY_LOCKS_DIR,
  };
  let worktreeAdded = false;

  fs.mkdirSync(locksDir, { recursive: true });
  try {
    runGit(repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    worktreeAdded = true;
    const head = runGit(worktree, ["rev-parse", "HEAD"]);
    const row = { ID: ticketId, Repo: "X", Status: "doing", Owner: owner };
    const tickets = new Map([[ticketId, { row, section: null }]]);
    const validate = (lock, options = {}) => {
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const errors = [];
      __testing.validateLocks(tickets, errors, {
        controlPlaneLayout: { coordRepoRoot: repoRoot },
        skipCanonicalLockLocationForTicket: ticketId,
        ...options,
      });
      return errors.join("\n");
    };
    const lock = {
      owner,
      ticket: ticketId,
      status: "doing",
      repo: __testing.expectedLockRepoForCode("X"),
      branch,
      head,
      worktree,
      started_at_utc: new Date().toISOString(),
      heartbeat_utc: new Date().toISOString(),
    };

    __testing.paths.LOCKS_DIR = locksDir;
    __testing.paths.LEGACY_LOCKS_DIR = legacyLocksDir;
    assert.equal(validate(lock), "", "a registered Repo X lock is anchored to its own worktree HEAD");
    assert.match(validate({ ...lock, head: "stale-head" }), /does not match worktree HEAD/);

    const unregistered = path.join(repoRoot, "ordinary-directory");
    fs.mkdirSync(unregistered);
    assert.match(
      validate({ ...lock, worktree: unregistered }),
      /not a registered control-plane worktree/,
      "an ordinary directory under an enclosing repository is not a Repo X worktree"
    );

    assert.equal(
      validate({ ...lock, head: "coord-no-git-head" }, { controlPlaneLayout: { coordRepoRoot: null } }),
      "",
      "no-repository Repo X topology retains the documented sentinel"
    );
    assert.match(
      validate(lock, { controlPlaneLayout: { coordRepoRoot: null } }),
      /must use head "coord-no-git-head"/,
      "a real Git hash is not accepted when Repo X has no control-plane repository"
    );
  } finally {
    __testing.paths.LOCKS_DIR = original.locks;
    __testing.paths.LEGACY_LOCKS_DIR = original.legacyLocks;
    if (worktreeAdded) {
      try { runGit(repoRoot, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
      try { runGit(repoRoot, ["branch", "-D", branch]); } catch { /* test cleanup */ }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("COORD-744: board lock consumer uses configured repo classification, never B/F literals", () => {
  const source = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
  assert.match(source, /if \(isRepoBackedCode\(ticketRow\.Repo\)\)/);
  assert.doesNotMatch(source, /ticketRow\.Repo\s*===\s*["']B["']\s*\|\|\s*ticketRow\.Repo\s*===\s*["']F["']/);
  const paths = { repoRegistry: { E: "services/api", C: "clients/web" }, repoRoots: { E: "/tmp/services/api", C: "/tmp/clients/web" } };
  assert.equal(__testing.expectedLockRepoForCode("E", paths), "services/api");
  assert.equal(__testing.expectedLockRepoForCode("C", paths), "clients/web");
  assert.equal(__testing.expectedLockRepoForCode("X", paths), "coord");
});

test("validateBoard allows a transfer-scoped canonical lock-location bypass for the active ticket only", () => {
  const ticketId = "MSRV-003";
  const owner = "claudea12";
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-transfer-bypass-"));
  const tempFrontendRepo = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-transfer-bypass-frontend-"));
  const runtimeLocksDir = path.join(path.dirname(__dirname), ".runtime", "locks");
  const legacyLocksDir = path.join(path.dirname(__dirname), "locks");
  const plansDir = path.join(__dirname, "plans");
  const governanceLogPath = path.join(path.dirname(__dirname), ".runtime", "governance-events.ndjson");
  // Derive both repoRoots AND repoRegistry from the live coord config so
  // the fixture's lock matches whatever the validator will compare against
  // (validateBoard checks lock.repo === repoRegistry[ticket.Repo]). Using
  // a hardcoded literal here only happened to pass on coord-template
  // because B=backend matched the literal coincidentally; once GCV-4
  // lands and a downstream project has B=msrv / B=acme-api / nested
  // paths, the literal mismatches and the test fires the wrong error.
  // Match board.js: its authority is the local project config, not the process override.
  const __coordPaths = createCoordPaths({ coordDir: path.dirname(__dirname), forceProjectConfig: true });
  const repoRoots = __coordPaths.repoRoots;
  const expectedLockRepo = __testing.expectedLockRepoForCode("B");
  const createdRepoRootLinks = [];
  const createdRepoRootParentDirs = [];
  const createdNamespaceWorktrees = [];
  const fakeLockPath = path.join(runtimeLocksDir, `${ticketId}.lock`);
  const worktreePath = tempRepo;
  // COORD-952: the namespace directory is created under the live repoRoots.B checkout
  // and removed in setup and cleanup. A fixed owner/ticket path is therefore shared by
  // every concurrent test process (and by other files that reuse claudea0000/MSRV-003),
  // so one run's cleanup raced another run's git init. A per-run owner gives each run
  // its own namespace; the wedge semantics (owner != namespace owner) are unchanged.
  const namespaceOwner = `claudea0000-${process.pid}-${require("node:crypto").randomBytes(4).toString("hex")}`;
  const namespaceWorktree = path.join(repoRoots.B, ".worktrees", namespaceOwner, ticketId);
  const branch = `agent/${namespaceOwner}-msrv-003-transfer-test`;

  runGit(tempRepo, ["init", "-b", "dev"]);
  runGit(tempRepo, ["config", "user.email", "board-tests@example.com"]);
  runGit(tempRepo, ["config", "user.name", "Board Tests"]);
  fs.writeFileSync(path.join(tempRepo, "package.json"), `${JSON.stringify({ name: "@template/backend" }, null, 2)}\n`, "utf8");
  runGit(tempRepo, ["add", "."]);
  runGit(tempRepo, ["commit", "-m", "seed"]);
  const head = runGit(tempRepo, ["rev-parse", "HEAD"]);
  runGit(tempFrontendRepo, ["init", "-b", "dev"]);
  runGit(tempFrontendRepo, ["config", "user.email", "board-tests@example.com"]);
  runGit(tempFrontendRepo, ["config", "user.name", "Board Tests"]);
  fs.writeFileSync(path.join(tempFrontendRepo, "package.json"), `${JSON.stringify({ name: "@template/frontend" }, null, 2)}\n`, "utf8");
  runGit(tempFrontendRepo, ["add", "."]);
  runGit(tempFrontendRepo, ["commit", "-m", "seed"]);

  for (const [repoCode, targetPath] of Object.entries({ B: tempRepo, F: tempFrontendRepo })) {
    const repoRoot = repoRoots[repoCode];
    if (!repoRoot || fs.existsSync(repoRoot)) {
      continue;
    }
    const parentDir = path.dirname(repoRoot);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      createdRepoRootParentDirs.push(parentDir);
    }
    fs.symlinkSync(targetPath, repoRoot, "dir");
    createdRepoRootLinks.push(repoRoot);
  }

  // Remove a prior interrupted fixture before filesystem readers are mocked.
  // Node 22's recursive remover requests Buffer directory entries, which the
  // deliberately string-only lock-directory test double below cannot provide.
  fs.mkdirSync(path.join(namespaceWorktree, ".git"), { recursive: true });
  fs.writeFileSync(path.join(namespaceWorktree, ".git", "interrupted"), "fixture\n", "utf8");
  fs.rmSync(namespaceWorktree, { recursive: true, force: true });

  const board = {
    version: 1,
    metadata: {
      title: "Board Validation Transfer Bypass",
      last_updated: new Date().toISOString(),
      canonical_references: ["coord/GOVERNANCE.md"],
      landing_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      pr_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_records_required_from_ticket: { X: "ARCH-999", B: "MSRV-999", F: "FE-999" },
      feature_proof_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Transfer Bypass",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: ticketId,
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: "doing",
            Owner: owner,
            Description: "Validate transfer-scoped canonical path bypass.",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {
      [ticketId]: "coord/board/README.md",
    },
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };

  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks.schema.json"), "utf8"));
  const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
  const lockJson = `${JSON.stringify({
    owner,
    ticket: ticketId,
    status: "doing",
    // Same source of truth as validateBoard: the board module's configured
    // expected lock repo for ticket.Repo.
    repo: expectedLockRepo,
    branch,
    head,
    worktree: worktreePath,
    started_at_utc: new Date().toISOString(),
    heartbeat_utc: new Date().toISOString(),
  }, null, 2)}\n`;
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;

  try {
    fs.existsSync = (targetPath, ...rest) => {
      if (targetPath === runtimeLocksDir) {
        return true;
      }
      if (targetPath === legacyLocksDir || targetPath === plansDir || targetPath === governanceLogPath) {
        return false;
      }
      return originalExistsSync(targetPath, ...rest);
    };
    fs.readdirSync = (targetPath, ...rest) => {
      if (targetPath === runtimeLocksDir) {
        return [`${ticketId}.lock`];
      }
      if (targetPath === legacyLocksDir || targetPath === plansDir) {
        return [];
      }
      return originalReaddirSync(targetPath, ...rest);
    };
    fs.readFileSync = (targetPath, ...rest) => {
      if (targetPath === fakeLockPath) {
        return lockJson;
      }
      return originalReadFileSync(targetPath, ...rest);
    };

    assert.throws(
      () => __testing.validateBoard(board, schema, planSchema, {
        ignoreActiveTicketLockErrors: true,
        currentTicketId: ticketId,
      }),
      /canonical worktree path|canonical branch prefix/
    );

    const validated = __testing.validateBoard(board, schema, planSchema, {
      ignoreActiveTicketLockErrors: true,
      currentTicketId: ticketId,
      skipCanonicalLockLocationForTicket: ticketId,
    });
    assert.equal(validated.ticketCount, 1);
    assert.equal(validated.doingCount, 1);

    // ---------------------------------------------------------------------
    // COORD-663. The suppression above is scoped to ONE mutation, so a lock
    // transferred through it stayed permanently non-canonical and every LATER
    // mutation failed. A transfer preserves the worktree and branch by design,
    // so the physical namespace must be carried as its own field rather than
    // derived from the (new) logical owner.
    // ---------------------------------------------------------------------
    // A real checkout: the validator resolves the worktree's git HEAD, so the
    // namespace path has to exist for these proofs to exercise the namespace
    // rules rather than the existence rules. repoRoots.B is only symlinked to a
    // temp repo when it does not already exist, so on a workspace that HAS a
    // real backend repo this lands inside it — create it clean and remove it in
    // the finally block. A leftover from a previous run makes the seed commit
    // find nothing to commit, which fails the whole test during setup.
    fs.mkdirSync(namespaceWorktree, { recursive: true });
    createdNamespaceWorktrees.push(namespaceWorktree);
    runGit(namespaceWorktree, ["init", "-b", "dev"]);
    runGit(namespaceWorktree, ["config", "user.email", "board-tests@example.com"]);
    runGit(namespaceWorktree, ["config", "user.name", "Board Tests"]);
    fs.writeFileSync(path.join(namespaceWorktree, "seed.txt"), "seed\n", "utf8");
    runGit(namespaceWorktree, ["add", "."]);
    runGit(namespaceWorktree, ["commit", "-m", "seed"]);
    const namespaceHead = runGit(namespaceWorktree, ["rev-parse", "HEAD"]);
    const baseLock = { ...JSON.parse(lockJson), owner, worktree: namespaceWorktree, branch, head: namespaceHead };
    const setLock = (value) => {
      fs.readFileSync = (targetPath, ...rest) => {
        if (targetPath === fakeLockPath) {
          return `${JSON.stringify(value, null, 2)}\n`;
        }
        return originalReadFileSync(targetPath, ...rest);
      };
    };
    const validateNow = () => __testing.validateBoard(board, schema, planSchema, {
      ignoreActiveTicketLockErrors: true,
      currentTicketId: ticketId,
    });

    // The wedge itself: owner claudea12 occupying claudea0000's namespace with
    // nothing recording why. Before the repair this was the state EVERY
    // transfer left behind; it must still fail, because an unexplained
    // mismatch is not a transfer.
    setLock(baseLock);
    assert.throws(validateNow, /canonical worktree path|canonical branch prefix/);

    // Proofs 1 and 2: with the namespace declared and the transfer attested,
    // the lock is valid with NO suppression — so update-finding, update-plan
    // and submit, which all run board sync, work after a transfer.
    const transferred = {
      ...baseLock,
      workspace_owner: namespaceOwner,
      transfer_provenance: [
        {
          from: namespaceOwner,
          to: owner,
          at: new Date().toISOString(),
          workspace_owner: namespaceOwner,
          reason: "human-admin authorized continuation after a session restart",
          previous_session_id: "a0000-prior",
        },
      ],
    };
    setLock(transferred);
    const afterTransfer = validateNow();
    assert.equal(afterTransfer.ticketCount, 1);
    assert.equal(afterTransfer.doingCount, 1);

    // The physical namespace is untouched — the property the repair exists to
    // preserve, and the reason renaming a merged branch is not the remedy.
    assert.equal(transferred.worktree, namespaceWorktree);
    assert.equal(transferred.branch, branch);

    // Proof 4: the history stays attributable.
    assert.equal(transferred.transfer_provenance.length, 1);
    assert.equal(transferred.transfer_provenance[0].from, namespaceOwner);
    assert.equal(transferred.transfer_provenance[0].to, owner);
    assert.match(transferred.transfer_provenance[0].reason, /human-admin/);

    // Proof 3, part one: declaring the namespace WITHOUT provenance is refused.
    setLock({ ...baseLock, workspace_owner: namespaceOwner });
    assert.throws(validateNow, /no recorded transfer provenance/);

    // Proof 3, part two: provenance that does not attest THIS namespace is
    // refused, so a fabricated entry cannot launder an arbitrary path.
    setLock({
      ...transferred,
      transfer_provenance: [
        { from: "claudea9999", to: owner, at: new Date().toISOString(), workspace_owner: "claudea9999" },
      ],
    });
    assert.throws(validateNow, /transfer provenance attests workspace namespace/);

    // Proof 3, part three: a chain that does not END at the lock's owner is
    // refused, so provenance cannot be replayed onto a different owner.
    setLock({
      ...transferred,
      transfer_provenance: [
        { from: namespaceOwner, to: "claudea777", at: new Date().toISOString(), workspace_owner: namespaceOwner },
      ],
    });
    assert.throws(validateNow, /transfer provenance ends at owner/);

    // Malformed provenance is treated as ABSENT rather than as permission.
    setLock({ ...baseLock, workspace_owner: namespaceOwner, transfer_provenance: [{ from: namespaceOwner }] });
    assert.throws(validateNow, /no recorded transfer provenance/);

  } finally {
    // COORD-700: RESTORE BEFORE CLEANUP. These stubs must not be live while
    // Node's own filesystem machinery runs. On Node 22 the recursive remove
    // reads directory entries through the PUBLIC fs.readdirSync, so it received
    // this stub's string entries where it expects Buffers and threw
    // ERR_INVALID_ARG_TYPE from Buffer.concat ("Received type string ('.git')").
    // Node 25 does not route through the public export, which is why the same
    // fixture passed there and the defect survived.
    //
    // Worse, the throw happened INSIDE this block, so the restores below never
    // ran and fs.readdirSync stayed patched for the REST OF THE FILE — the two
    // C6 compat-reader tests then failed on their own cleanup. One ordering
    // mistake, three failing tests.
    //
    // Main reached the same ordering independently in cd9aa67e ("support Node 22
    // hygiene gates"); this branch keeps the fuller account AND the arity fix
    // that ordering change does not include — see the ...rest forwarding below,
    // which main does not have.
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
    for (const namespaceDir of createdNamespaceWorktrees) {
      fs.rmSync(namespaceDir, { recursive: true, force: true });
    }
    for (const repoRoot of createdRepoRootLinks) {
      fs.rmSync(repoRoot, { force: true });
    }
    for (const parentDir of createdRepoRootParentDirs.reverse()) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  }
});

test("parseSelfReviewCyclesFromRecord accepts descriptive pass verdicts from canonical plan records", () => {
  const cycles = __testing.parseSelfReviewCyclesFromRecord({
    self_review_cycles: [
      { verdict: "pass - repaired 1 issue and restored strict UUID validation" },
      { verdict: "pass" },
      { verdict: "fail - needs rerun" },
      { verdict: null },
    ],
  });

  assert.deepEqual(cycles, ["pass", "pass", "fail", "fail"]);
});

test("validateBoard accepts related-followup exceptions as non-blocking follow-up metadata", () => {
  const errors = [];
  const tickets = new Map([
    ["IMP-245", { row: { ID: "IMP-245" } }],
    ["DEBT-042", { row: { ID: "DEBT-042" } }],
  ]);

  __testing.validateFollowupExceptions({
    "DEBT-042": {
      parent: "IMP-245",
      type: "related-followup",
    },
  }, tickets, errors);

  assert.deepEqual(errors, []);
});

test("validateWaiverIndex accepts structured prompt coverage waivers", () => {
  const errors = [];
  const tickets = new Map([
    ["DEBT-046", { row: { ID: "DEBT-046" } }],
  ]);

  __testing.validateWaiverIndex({
    "DEBT-046": {
      code: "prompt_coverage",
      reason: "Direct human instruction approved without prompt remap.",
      recorded_at: "2026-03-30T12:00:00.000Z",
      recorded_by: "codexa00",
    },
  }, tickets, errors);

  assert.deepEqual(errors, []);
});

test("validateBoard fails when the governance journal references a ticket missing from the board", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-journal-missing-ticket-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  fs.writeFileSync(journalPath, [
    JSON.stringify({
      ts: "2026-04-04T10:00:00.000Z",
      ticket: "FE-091",
      after_status: "review",
      result: "succeeded",
    }),
  ].join("\n"));

  const board = {
    metadata: {},
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Frontend",
        separator_before: false,
        columns: ["ID", "Repo", "Status", "Owner"],
        rows: [
          { ID: "FE-090", Repo: "F", Status: "todo", Owner: "unassigned" },
        ],
      },
    ],
  };

  const schema = { type: "object" };
  const planSchema = { type: "object" };

  assert.throws(
    () => __testing.validateBoard(board, schema, planSchema, {
      governanceEventLogPath: journalPath,
      skipWorktreeValidation: true,
    }),
    /coord\/board\/tasks\.json does not contain that ticket/
  );
});

test("COORD-285: validateBoard accepts the quarantined `proposed` status as a legal board status", () => {
  const board = {
    metadata: {},
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Work",
        separator_before: false,
        columns: ["ID", "Repo", "Status", "Owner"],
        rows: [
          { ID: "ENG-001", Repo: "X", Status: "todo", Owner: "unassigned" },
          // COORD-285: a proposed (machine-proposed, human-triage-pending) row.
          { ID: "ENG-002", Repo: "X", Status: "proposed", Owner: "unassigned" },
        ],
      },
    ],
  };
  const schema = { type: "object" };
  const planSchema = { type: "object" };

  // Point the journal-backed progression check at an empty journal so the live
  // repo journal does not bleed into this isolated board fixture.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord285-proposed-validate-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  fs.writeFileSync(journalPath, "", "utf8");
  // Scope validation to the fixture ticket so the live repo's in-flight locks
  // (e.g. the COORD-285 lock held while this very ticket is being implemented)
  // are out of scope and do not bleed into this isolated board fixture.
  const validateOpts = {
    skipWorktreeValidation: true,
    ignoreActiveTicketLockErrors: true,
    ticketScopedValidation: true,
    currentTicketId: "ENG-001",
    governanceEventLogPath: journalPath,
  };

  // Board-side acceptance: validateBoard's isLegalStatus gate (LEGAL_STATUSES)
  // must treat `proposed` as a valid status — no "invalid status" error.
  assert.doesNotThrow(() => __testing.validateBoard(board, schema, planSchema, validateOpts));
  const validated = __testing.validateBoard(board, schema, planSchema, validateOpts);
  assert.equal(validated.ticketCount, 2);

  // Schema-side acceptance: the canonical tasks.schema.json Status enum lists
  // `proposed`, so an on-disk board carrying a proposed row passes schema validation.
  const schemaOnDisk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "tasks.schema.json"), "utf8")
  );
  const statusConsts = JSON.stringify(schemaOnDisk);
  assert.match(statusConsts, /"const":\s*"proposed"/, "tasks.schema.json Status enum must include proposed");
});

test("COORD-783: committed validation accepts active rows without inventing runtime locks", () => {
  const board = {
    metadata: {}, prompt_index: {}, pr_index: {}, landing_index: {},
    review_findings: {}, waiver_index: {}, followup_exceptions: {},
    sections: [{
      kind: "table", level: 2, heading: "Work", separator_before: false,
      columns: ["ID", "Repo", "Status", "Owner"],
      rows: [{ ID: "ENG-999", Repo: "X", Status: "doing", Owner: "codexa01" }],
    }],
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord783-board-"));
  const journalPath = path.join(tempDir, "events.ndjson");
  fs.writeFileSync(journalPath, "");
  const options = {
    skipWorktreeValidation: true,
    ticketScopedValidation: true,
    currentTicketId: "ENG-999",
    governanceEventLogPath: journalPath,
  };
  const validate = (extra = {}) => __testing.validateBoard(
    board, { type: "object" }, { type: "object" }, { ...options, ...extra }
  );
  try {
    assert.throws(() => validate(), /doing but has no governed lock file/);
    assert.equal(validate({ committedArtifactsOnly: true }).ticketCount, 1);

    // Explicit committed mode must not be a shortcut around a live workspace.
    const locksDir = path.join(path.dirname(__dirname), ".runtime", "locks");
    const originalExistsSync = fs.existsSync;
    const originalReaddirSync = fs.readdirSync;
    try {
      fs.existsSync = (file, ...rest) => file === locksDir ? true : originalExistsSync(file, ...rest);
      fs.readdirSync = (file, ...rest) => file === locksDir ? ["ENG-999.lock"] : originalReaddirSync(file, ...rest);
      assert.throws(
        () => validate({ committedArtifactsOnly: true }),
        /Committed-artifact validation requires a checkout without runtime lock files/
      );
    } finally {
      fs.existsSync = originalExistsSync;
      fs.readdirSync = originalReaddirSync;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-783: new canonical plan records are visible to Git while locks stay ignored", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord783-ignore-"));
  try {
    runGit(tempDir, ["init", "-q"]);
    for (const file of [".gitignore", "coord/.gitignore"]) {
      const destination = path.join(tempDir, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(__dirname, "..", "..", file), destination);
    }
    seedCoordRuntimeGitignoreFixture(path.join(tempDir, "coord"));
    const planPath = path.join(tempDir, "coord/.runtime/plans/NEW-001.json");
    const lockPath = path.join(tempDir, "coord/.runtime/locks/NEW-001.lock");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(planPath, "{}\n");
    fs.writeFileSync(lockPath, "{}\n");
    const status = runGit(tempDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
    assert.match(status, /\?\? coord\/\.runtime\/plans\/NEW-001\.json/);
    assert.doesNotMatch(status, /NEW-001\.lock/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validateBoard fails when the board regresses behind a terminal governance journal status", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-journal-regression-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  fs.writeFileSync(journalPath, [
    JSON.stringify({
      ts: "2026-04-04T10:00:00.000Z",
      ticket: "MSRV-070",
      after_status: "doing",
      result: "succeeded",
    }),
    JSON.stringify({
      ts: "2026-04-04T10:05:00.000Z",
      command: "land",
      ticket: "MSRV-070",
      after_status: "done",
      result: "succeeded",
    }),
  ].join("\n"));

  const board = {
    metadata: {},
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Backend",
        separator_before: false,
        columns: ["ID", "Repo", "Status", "Owner"],
        rows: [
          { ID: "MSRV-070", Repo: "B", Status: "todo", Owner: "unassigned" },
        ],
      },
    ],
  };

  const schema = { type: "object" };
  const planSchema = { type: "object" };

  assert.throws(
    () => __testing.validateBoard(board, schema, planSchema, {
      governanceEventLogPath: journalPath,
      skipWorktreeValidation: true,
    }),
    /regressed in coord\/board\/tasks\.json/
  );
});

test("manual-reconcile rollback notes do not override the last real lifecycle state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-journal-manual-reconcile-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  fs.writeFileSync(journalPath, [
    JSON.stringify({
      ts: "2026-04-04T10:00:00.000Z",
      command: "move-review",
      ticket: "FE-037",
      after_status: "review",
      result: "succeeded",
    }),
    JSON.stringify({
      ts: "2026-04-04T10:05:00.000Z",
      command: "manual-reconcile",
      ticket: "FE-037",
      after_status: "todo",
      result: "succeeded",
      details: {
        reason: "board/tasks.json was externally overwritten after move-review succeeded",
      },
    }),
  ].join("\n"));

  const journalState = __testing.readLatestLifecycleStatesFromGovernanceJournal({
    governanceEventLogPath: journalPath,
  });

  assert.equal(journalState.get("FE-037")?.status, "review");
});

test("ticket-scoped helpers only include the current ticket", () => {
  assert.equal(
    __testing.isTicketInScope("FE-073", {
      currentTicketId: "FE-073",
      ticketScopedValidation: true,
    }),
    true
  );
  assert.equal(
    __testing.isTicketInScope("MSRV-033", {
      currentTicketId: "FE-073",
      ticketScopedValidation: true,
    }),
    false
  );
  assert.equal(
    __testing.isTicketInScope("MSRV-033", {
      currentTicketId: "FE-073",
      ticketScopedValidation: false,
    }),
    true
  );
});

test("readPlanRecords compat reader: legacy-only shard is still resolved (C6 Phase 2)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-plan-compat-legacy-"));
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "IMP-901.json"),
    `${JSON.stringify(makePlanRecord("IMP-901"), null, 2)}\n`
  );

  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_RECORDS_DIR = runtimeDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = legacyDir;
  try {
    const planSchema = JSON.parse(
      fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8")
    );
    const tickets = new Map([["IMP-901", { row: { ID: "IMP-901" } }]]);
    const errors = [];
    const records = __testing.readPlanRecords(planSchema, tickets, errors);
    assert.deepEqual(errors, []);
    assert.equal(records.size, 1);
    assert.equal(records.get("IMP-901").ticket_id, "IMP-901");
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-895: a plan record without governance defaults its closeout base to the configured board branch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord895-board-plan-"));
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const record = makePlanRecord("IMP-895");
  delete record.governance;
  fs.writeFileSync(path.join(runtimeDir, "IMP-895.json"), `${JSON.stringify(record, null, 2)}\n`);
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_RECORDS_DIR = runtimeDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(tempDir, "absent");
  try {
    const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
    const errors = [];
    const records = __testing.readPlanRecords(planSchema, new Map([["IMP-895", { row: { ID: "IMP-895" } }]]), errors);
    const configured = require("../paths.js").createCoordPaths({ coordDir: path.resolve(__dirname, ".."), forceProjectConfig: true }).boardBranch;
    assert.equal(records.get("IMP-895").governance.expected_closeout.base_ref, configured);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readPlanRecords compat reader: runtime shard wins over legacy on id collision (C6 Phase 2)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-board-plan-compat-collision-"));
  const runtimeDir = path.join(tempDir, ".runtime", "plans");
  const legacyDir = path.join(tempDir, "board", "plans");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "IMP-902.json"),
    `${JSON.stringify(makePlanRecord("IMP-902", { change_summary: ["legacy copy"] }), null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(runtimeDir, "IMP-902.json"),
    `${JSON.stringify(makePlanRecord("IMP-902", { change_summary: ["runtime copy"] }), null, 2)}\n`
  );

  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_RECORDS_DIR = runtimeDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = legacyDir;
  try {
    const planSchema = JSON.parse(
      fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8")
    );
    const tickets = new Map([["IMP-902", { row: { ID: "IMP-902" } }]]);
    const errors = [];
    const records = __testing.readPlanRecords(planSchema, tickets, errors);
    assert.deepEqual(errors, []);
    assert.equal(records.size, 1);
    assert.deepEqual(records.get("IMP-902").change_summary, ["runtime copy"]);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- COORD-687: ticket-scoped reads must not narrow the GLOBAL PLAN.md render -
//
// Every function in this path is correct alone. `normalizePlanRecordScope`
// narrows to one id for ticket-scoped VALIDATION (right: a mutation on one
// ticket must not fail on another ticket's broken record), `readPlanRecords`
// honours that scope, and `renderPlanMarkdown` renders what it is handed. The
// defect was the composition: validateBoard's scoped record Map went straight
// to the renderer, which re-materializes the WHOLE file from it.
//
// Measured twice, at two scopes. Scoped to a ticket with NO record, PLAN.md
// went 37,789 bytes -> 0. Scoped to a ticket that HAS one, 33,919 -> 4,046 —
// non-empty, parseable, valid heading, missing every other non-terminal
// ticket's block. The second is why these assertions are BYTE-EQUALITY against
// the unscoped render rather than a size or presence check: a byte floor passes
// the 4,046-byte case, and "contains the scoped ticket" passes it too.
//
// The fixture is built here rather than read from the live board: this suite
// also runs in clean clones, where coord/.runtime/plans does not exist at all,
// and a corpus-dependent test would pass vacuously there — the exact shape this
// ticket exists to remove.

function coord687Fixture() {
  const contextState = require("../engine/scripts/governance-context.js").state;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "coord-687-"));
  const recordsDir = path.join(sandbox, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  const board = {
    metadata: { plan_markdown_render_statuses: ["doing", "review"] },
    sections: [
      {
        kind: "table",
        heading: "In Progress",
        columns: ["ID", "Repo", "Status", "Owner", "Description"],
        rows: [
          { ID: "MSRV-701", Repo: "X", Status: "doing", Owner: "claudea0000", Description: "holds a record" },
          { ID: "MSRV-702", Repo: "X", Status: "review", Owner: "claudea0000", Description: "also holds a record" },
          { ID: "MSRV-703", Repo: "X", Status: "todo", Owner: "unassigned", Description: "brand new, no record" },
        ],
      },
    ],
  };
  for (const ticketId of ["MSRV-701", "MSRV-702"]) {
    fs.writeFileSync(
      path.join(recordsDir, `${ticketId}.json`),
      `${JSON.stringify(makePlanRecord(ticketId), null, 2)}\n`
    );
  }

  const saved = {
    RENDERED_DIR: contextState.RENDERED_DIR,
    PLAN_PATH: contextState.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
  };
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(sandbox, "legacy-plans-absent");
  contextState.RENDERED_DIR = path.join(sandbox, "rendered");
  contextState.PLAN_PATH = path.join(sandbox, "PLAN.md");

  return {
    board,
    sandbox,
    planPath: path.join(sandbox, "PLAN.md"),
    planSchema: readPlanSchemaForTests(),
    restore() {
      contextState.RENDERED_DIR = saved.RENDERED_DIR;
      contextState.PLAN_PATH = saved.PLAN_PATH;
      __testing.paths.PLAN_RECORDS_DIR = saved.PLAN_RECORDS_DIR;
      __testing.paths.LEGACY_PLAN_RECORDS_DIR = saved.LEGACY_PLAN_RECORDS_DIR;
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

function readPlanSchemaForTests() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "plan.schema.json"), "utf8"));
}

test("COORD-687 RED: a write scoped to a ticket with NO plan record must not truncate PLAN.md", () => {
  const fx = coord687Fixture();
  try {
    // The 2026-08-14 shape: `gov file-ticket` for a BRAND-NEW ticket, scoped to
    // an id that has no record at all, drove the file to zero bytes.
    const scoped = { ticketScopedValidation: true, currentTicketId: "MSRV-703" };
    const scopedState = __testing.collectBoardRenderState(fx.board, fx.planSchema, scoped);
    assert.equal(scopedState.planRecords.size, 0, "fixture: the scoped validation sees no records at all");

    __testing.writeRenderedArtifacts(scopedState);
    const written = fs.readFileSync(fx.planPath, "utf8");

    const unscopedState = __testing.collectBoardRenderState(fx.board, fx.planSchema, {});
    const expected = __testing.renderPlanMarkdown(fx.board, unscopedState.planRecords);
    assert.equal(written, expected, "a scoped write must produce the same PLAN.md as an unscoped render");
    assert.ok(written.includes("## MSRV-701"), "MSRV-701 is doing with a record; its block must survive");
    assert.ok(written.includes("## MSRV-702"), "MSRV-702 is review with a record; its block must survive");
  } finally {
    fx.restore();
  }
});

test("COORD-687 RED: a write scoped to a ticket that HAS a record must not drop the others", () => {
  const fx = coord687Fixture();
  try {
    // The 33,919 -> 4,046 shape. A naive fix passes the zero-byte case and
    // fails this one: the survivor here is non-empty and parses.
    const scoped = { ticketScopedValidation: true, currentTicketId: "MSRV-701" };
    const scopedState = __testing.collectBoardRenderState(fx.board, fx.planSchema, scoped);
    assert.equal(scopedState.planRecords.size, 1, "fixture: the scoped validation sees exactly its own record");

    __testing.writeRenderedArtifacts(scopedState);
    const written = fs.readFileSync(fx.planPath, "utf8");

    const unscopedState = __testing.collectBoardRenderState(fx.board, fx.planSchema, {});
    assert.equal(
      written,
      __testing.renderPlanMarkdown(fx.board, unscopedState.planRecords),
      "scoping to a ticket that HAS a record must not narrow the render either"
    );
    assert.ok(written.includes("## MSRV-702"), "the OTHER non-terminal ticket's block is the one that used to vanish");
  } finally {
    fx.restore();
  }
});

test("COORD-687: the RENDER reads every record while VALIDATION stays scoped", () => {
  const fx = coord687Fixture();
  try {
    const scoped = { ticketScopedValidation: true, currentTicketId: "MSRV-701" };
    const scopedState = __testing.collectBoardRenderState(fx.board, fx.planSchema, scoped);
    // Validation scope is deliberately narrow and must STAY narrow: widening it
    // would make one ticket's mutation fail on another ticket's broken record.
    assert.deepEqual([...scopedState.planRecords.keys()], ["MSRV-701"]);

    const forRender = __testing.planRecordsForRender(fx.board);
    assert.deepEqual(
      [...forRender.keys()].sort(),
      ["MSRV-701", "MSRV-702"],
      "the render input must be the full record set regardless of validation scope"
    );
  } finally {
    fx.restore();
  }
});

test("COORD-687: a broken record belonging to ANOTHER ticket does not fail a scoped mutation", () => {
  const fx = coord687Fixture();
  try {
    // Acceptance (d), the direction that is easy to break while fixing this:
    // the render now reads more records, and it must NOT import their
    // validation errors into the scoped mutation's gate.
    fs.writeFileSync(path.join(__testing.paths.PLAN_RECORDS_DIR, "MSRV-702.json"), "{ this is not json");

    const scoped = { ticketScopedValidation: true, currentTicketId: "MSRV-701" };
    assert.doesNotThrow(
      () => __testing.writeRenderedArtifacts(
        __testing.collectBoardRenderState(fx.board, fx.planSchema, scoped)
      ),
      "another ticket's unreadable record must not fail this ticket's mutation"
    );

    const written = fs.readFileSync(fx.planPath, "utf8");
    assert.ok(written.includes("## MSRV-701"), "the scoped ticket still renders");
    assert.ok(
      !written.includes("## MSRV-702"),
      "an unreadable record renders nothing — skipped, exactly as the unscoped renderer already skips it"
    );
  } finally {
    fx.restore();
  }
});

// --- COORD-687 round 1, finding 2: exercise the REAL mutation boundary -------
//
// The tests above compose collectBoardRenderState + writeRenderedArtifacts by
// hand. That pins the contract but not the path a governed mutation actually
// takes: `syncBoardArtifacts(options)` validates and writes in one step, and it
// is the function governance calls. A fix that satisfied the hand-composed
// tests while leaving that entry point wired to the scoped map would ship the
// defect.
//
// syncBoardArtifacts reads a board path pinned to its own module location
// (forceProjectConfig, deliberately — the validator must not be redirectable),
// so the only honest way to drive it against a fixture is to give it a coord
// tree of its own. The tree is COPIED and the copy's board.js is required, so
// the module resolves every path inside the sandbox and the real canonical
// tree is never read or written.

function initIntegrationRepository(dir, branch, env) {
  runGit(dir, ["init", "--initial-branch=" + branch, "."], env);
  // Own every writer before native cleanup; these are disposable repositories.
  runGit(dir, ["config", "maintenance.autoDetach", "false"], env);
  runGit(dir, ["config", "gc.autoDetach", "false"], env);
}

function copyCoordTreeForIntegration(gitEnv) {
  const realCoord = path.dirname(__dirname);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "coord-687-e2e-"));
  const coordDir = path.join(sandbox, "coord");
  fs.cpSync(realCoord, coordDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(realCoord, src);
      return !rel.startsWith(".worktrees") && !rel.startsWith(".runtime") && !rel.includes("node_modules");
    },
  });
  // The repo root matters: paths.js derives it from the coord dir's parent, and
  // the validator resolves the product repo roots declared in project.config.js
  // against it. They only need to exist.
  fs.writeFileSync(path.join(sandbox, "package.json"), '{"name":"coord-687-sandbox"}\n');
  // They must be real git repositories: the validator lists worktrees in each.
  for (const repoDir of ["backend", "frontend"]) {
    const dir = path.join(sandbox, repoDir);
    fs.mkdirSync(dir, { recursive: true });
    initIntegrationRepository(dir, "dev", gitEnv);
    fs.writeFileSync(path.join(dir, "README.md"), `${repoDir}\n`);
    runGit(dir, ["add", "-A"], gitEnv);
    runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--no-verify", "-m", "baseline"], gitEnv);
  }
  return { sandbox, coordDir };
}

function seedIntegrationBoard(coordDir) {
  const boardPath = path.join(coordDir, "board", "tasks.json");
  // COORD-750: this fixture owns its board. Never inherit real active rows
  // without their locks, or terminalize donor tickets to make validation pass.
  const rows = ["COORD-001", "COORD-002"].map((ID) => ({
    ID, Repo: "X", Type: "chore", Pri: "P2", Status: "review",
    Owner: "claudea0000", Description: "Isolated render fixture", "Depends On": "",
  }));
  const board = {
    version: 1,
    metadata: { title: "Isolated integration board", last_updated: "2026-09-10", canonical_references: [] },
    sections: [{ kind: "table", level: 2, heading: "Fixture", separator_before: false, columns: Object.keys(rows[0]), rows }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
  };
  fs.mkdirSync(path.join(coordDir, "prompts", "tickets"), { recursive: true });
  for (const row of rows) {
    const prompt = `coord/prompts/tickets/${row.ID}.md`;
    fs.writeFileSync(path.join(coordDir, "..", prompt), `# ${row.ID}\n\nIsolated render fixture.\n`);
    board.prompt_index[row.ID] = prompt;
    board.pr_index[row.ID] = ["local-review (no PR)"];
  }
  // Both are put in `review` rather than one in `doing`: a doing ticket needs a
  // governed lock file, and manufacturing locks would make this fixture about
  // lock plumbing instead of about the render.
  for (const row of rows) {
    row.Status = "review";
    row.Owner = "claudea0000";
  }
  // A third id that is NOT on the board and has no record: the zero-byte scope.
  fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);

  const plansDir = path.join(coordDir, ".runtime", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  for (const row of rows) {
    // A `review` row needs at least three self-review cycles to pass the
    // canonical validator; the fixture satisfies the real gate rather than
    // routing around it.
    const record = {
      ...makePlanRecord(row.ID),
      self_review_cycles: [1, 2, 3].map((n) => ({
        cycle: n,
        total: 3,
        lens: `fixture ${n}`,
        diff: "none",
        risks: ["none", "none"],
        findings: "none",
        verification: "none",
        verdict: "pass",
        raw: `lens=fixture ${n}; diff=none; risks=none, none; findings=none; verification=none; verdict=pass`,
      })),
    };
    fs.writeFileSync(path.join(plansDir, `${row.ID}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  return { withRecords: rows.map((row) => row.ID) };
}

function syncInCopiedTree(coordDir, options) {
  // Fresh module instance per call: board.js caches nothing across requires
  // here, but the copy's own path constants must be the ones in play.
  const modulePath = path.join(coordDir, "board", "board.js");
  delete require.cache[require.resolve(modulePath)];
  const sandboxBoard = require(modulePath);
  sandboxBoard.syncBoardArtifacts(options);
  return fs.readFileSync(path.join(coordDir, "PLAN.md"), "utf8");
}

test("COORD-687 integration: a scoped syncBoardArtifacts with NO record renders the same PLAN.md as an unscoped one", () => {
  const { sandbox, coordDir } = copyCoordTreeForIntegration();
  try {
    const { withRecords } = seedIntegrationBoard(coordDir);

    const unscoped = syncInCopiedTree(coordDir, {});
    assert.ok(unscoped.includes(`## ${withRecords[0]}`), "fixture: the unscoped render carries both blocks");
    assert.ok(unscoped.includes(`## ${withRecords[1]}`));

    // The 2026-08-14 shape, through the real entry point.
    const scoped = syncInCopiedTree(coordDir, {
      ticketScopedValidation: true,
      currentTicketId: "MSRV-000-NOT-ON-BOARD",
    });
    assert.equal(scoped, unscoped, "the governed scoped sync must not narrow the rendered view");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("COORD-687 integration: a scoped syncBoardArtifacts for a ticket that HAS a record keeps the others", () => {
  const { sandbox, coordDir } = copyCoordTreeForIntegration();
  try {
    const { withRecords } = seedIntegrationBoard(coordDir);
    const unscoped = syncInCopiedTree(coordDir, {});

    // The 33,919 -> 4,046 shape, through the real entry point: the survivor is
    // non-empty and parses, so only equality catches it.
    const scoped = syncInCopiedTree(coordDir, {
      ticketScopedValidation: true,
      currentTicketId: withRecords[0],
    });
    assert.equal(scoped, unscoped);
    assert.ok(
      scoped.includes(`## ${withRecords[1]}`),
      "the OTHER non-terminal ticket's block is the one that used to vanish"
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
// --- COORD-700: an fs stub must be transparent to Node's own machinery -------
//
// Node 22's recursive remove reads directory entries through the PUBLIC
// fs.readdirSync, asking for Buffers. A stub written as `(targetPath) => ...`
// silently DROPS that request and hands back strings, and rimraf then throws
// ERR_INVALID_ARG_TYPE from Buffer.concat. Node 25 does not route through the
// public export, so the same fixture passed there and the defect shipped.
//
// The failure also cascaded: the throw happened inside a `finally`, so the
// restores below it never ran and fs.readdirSync stayed patched for the rest of
// the file. One ordering-and-arity mistake, three failing tests.
//
// These two tests guard the CLASS. The first proves the correct pattern works
// under the machinery that exposed it; the second fails if any stub in this
// file is written the old way, which is what stops the next one being added.

test("COORD-700: a correctly-written fs stub stays transparent to a recursive remove", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-700-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

  const originalReaddirSync = fs.readdirSync;
  try {
    // The house pattern: intercept what the test cares about, forward
    // EVERYTHING else — arguments included, because the caller may be Node.
    fs.readdirSync = (targetPath, ...rest) => {
      if (targetPath === "/coord-700/never") return [];
      return originalReaddirSync(targetPath, ...rest);
    };
    assert.doesNotThrow(
      () => fs.rmSync(dir, { recursive: true, force: true }),
      "a recursive remove must survive an installed stub — it asks readdir for Buffers"
    );
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-700: no fs stub in this file drops the arguments it was given", () => {
  const source = fs.readFileSync(__filename, "utf8");
  // A stub declared with a fixed parameter list cannot forward what it does not
  // accept. This is asserted against the SOURCE because the defect is invisible
  // at runtime on the Node version most people develop against.
  const droppingDeclarations = [
    ...source.matchAll(/fs\.(readdirSync|existsSync|readFileSync|statSync|lstatSync)\s*=\s*\(([^)]*)\)\s*=>/g),
  ].filter(([, , params]) => !params.includes("...rest"));
  assert.deepEqual(
    droppingDeclarations.map(([, name, params]) => `fs.${name} = (${params})`),
    [],
    "an fs stub must accept ...rest and forward it; Node's own filesystem machinery passes options these would drop (COORD-700)"
  );

  // Matched to end of line, not to the first ")": a legitimate fallthrough may
  // nest a call in its arguments (path.join(...)), and a regex that stops at the
  // inner paren reports it as dropping. Caught while writing this test.
  const droppingFallthroughs = [
    ...source.matchAll(/return original(ReaddirSync|ExistsSync|ReadFileSync)\((.*)\);/g),
  ].filter(([, , args]) => !args.includes("...rest"));
  assert.deepEqual(
    droppingFallthroughs.map(([, name, args]) => `original${name}(${args})`),
    [],
    "a stub's fallthrough must pass the original arguments through unchanged (COORD-700)"
  );
});

test('COORD-668: missing active record cannot replace any previously rendered artifact', () => {
  const fx = coord687Fixture();
  try {
    __testing.writeRenderedArtifacts({board:fx.board,planRecords:new Map()});
    const before = fs.readFileSync(fx.planPath, 'utf8');
    fs.unlinkSync(path.join(fx.sandbox,'plans','MSRV-701.json'));
    assert.throws(()=>__testing.writeRenderedArtifacts({board:fx.board,planRecords:new Map()}), /active.*MSRV-701|MSRV-701.*active/i);
    assert.equal(fs.readFileSync(fx.planPath,'utf8'),before);
  } finally { fx.restore(); }
});

test('COORD-668 integration: CLI filing preserves active plans; question and sync converge without reconciliation', () => {
  const { sandbox, coordDir } = copyCoordTreeForIntegration();
  const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
  try {
    seedIntegrationBoard(coordDir);
    const before = syncInCopiedTree(coordDir, {});
    initIntegrationRepository(sandbox, "main");
    runGit(sandbox, ['config', 'user.name', 'Fixture']);
    runGit(sandbox, ['config', 'user.email', 'fixture@example.invalid']);
    const rawCli = (args) => approval.runCli(coordDir, args, {
      cwd: sandbox, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: sandbox },
    });
    const cli = (args) => {
      let result = rawCli(args);
      if (args[0] === "reconcile" && result.status !== 0) {
        const text = `${result.stdout || ""}\n${result.stderr || ""}`;
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(text);
        const ticket = /--ticket ([^\s]+)/.exec(text);
        if (digest && ticket) {
          approval.login({ verb: "reconcile", ticket: ticket[1], subject_sha256: digest[1] });
          result = rawCli(args);
        }
      }
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout;
    };
    cli(withApprovedPacket(['reconcile','--reason','initialize isolated fixture','--human-admin-override','Fixture administrator approves seeded baseline'], cli));
    runGit(sandbox,['add','.']);
    runGit(sandbox,['commit','-m','fixture baseline']);
    cli(['file-ticket','COORD-999','--repo','X','--type','bug','--pri','P2','--description','Isolated unrelated filing','--with-prompt']);
    assert.equal(fs.readFileSync(path.join(coordDir,'PLAN.md'),'utf8'),before);
    cli(['log-question','--from','fixture','--to','orchestrator','--question','Observed fixture result','--answer','Verified active plan preservation','--resolved','yes']);
    cli(['sync','--commit','commit sanctioned generated outputs']);
    assert.equal(runGit(sandbox,['status','--porcelain','--','coord/PLAN.md','coord/QUESTIONS.md','coord/.runtime/governance-events.ndjson']).trim(),'');
    const script = `const {__testing:t}=require(${JSON.stringify(path.join(coordDir,'scripts','governance.js'))}); process.stdout.write(JSON.stringify(t.detectGovernanceProvenanceDrift().drift));`;
    const drift = require('node:child_process').execFileSync(process.execPath,['-e',script],{cwd:sandbox,encoding:'utf8',env:{PATH:process.env.PATH,HOME:sandbox}});
    assert.deepEqual(JSON.parse(drift),[]);
  } finally { approval.cleanup(); fs.rmSync(sandbox,{recursive:true,force:true}); }
});

for (const target of ["root", "backend", "frontend"]) {
  test(`COORD-695 qualification: ${target} board fixture owns actual Git maintenance until commit returns`, (t) => {
    const proof = fs.mkdtempSync(path.join(os.tmpdir(), "coord695-board-maintenance-"));
    const trace = path.join(proof, "trace.json");
    const globalConfig = path.join(proof, "global.config");
    fs.writeFileSync(globalConfig, "[gc]\n autoDetach = true\n[maintenance]\n autoDetach = true\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TRACE2_EVENT: trace };
    let fixture, completed = false;
    try {
      fixture = copyCoordTreeForIntegration(env);
      const repo = target === "root" ? fixture.sandbox : path.join(fixture.sandbox, target);
      if (target === "root") initIntegrationRepository(repo, "main", env);
      runGit(repo, ["config", "gc.auto", "1"], env);
      runGit(repo, ["config", "maintenance.geometric-repack.auto", "1"], env);
      runGit(repo, ["config", "pack.threads", "1"], env);
      runGit(repo, ["config", "pack.window", "10"], env);
      const input = path.join(repo, "maintenance-input");
      fs.mkdirSync(input);
      const crypto = require("node:crypto");
      for (let i = 0; i < 2048; i++) {
        fs.writeFileSync(path.join(input, String(i)), crypto.createHash("sha256").update(String(i)).digest("hex").repeat(16) + "\n");
      }
      runGit(repo, ["add", "maintenance-input"], env);
      runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "Actual fixture maintenance"], env);
      const raw = fs.readFileSync(trace, "utf8");
      const events = raw.slice(0, raw.lastIndexOf("\n")).split("\n").filter(Boolean).map(JSON.parse);
      const commit = events.filter(e => e.event === "cmd_name" && e.name === "commit").at(-1);
      assert.ok(commit, "actual parent commit must be traced");
      const parentExit = events.findIndex(e => e.sid === commit.sid && e.event === "exit");
      assert.ok(parentExit >= 0, "actual parent commit must have exited");
      const children = events.filter(e => e.event === "cmd_name" && e.sid.startsWith(commit.sid + "/") &&
        ["maintenance", "gc", "repack", "pack-objects"].includes(e.name));
      assert.ok(children.some(e => e.name === "pack-objects"), "genuine packing must run");
      for (const child of children) {
        const exit = events.findIndex(e => e.sid === child.sid && e.event === "exit");
        assert.ok(exit >= 0 && exit < parentExit, `${child.name} must finish before parent commit returns`);
        assert.equal(events[exit].code, 0, `${child.name} must exit successfully`);
      }
      completed = true;
    } finally {
      if (completed) {
        fs.rmSync(fixture.sandbox, { recursive: true, force: true });
        fs.rmSync(proof, { recursive: true, force: true });
      } else {
        t.diagnostic(`Retained Git lifetime evidence ${proof}; fixture ${fixture?.sandbox || "setup failed"}`);
      }
    }
  });
}

test("COORD-801: schema type unions enforce supported primitive types and structural constraints", () => {
  const errorsFor = (schema, value) => {
    const errors = [];
    __testing.validateSchema(schema, value, "fixture", errors);
    return errors;
  };

  assert.deepEqual(errorsFor({ type: ["string", "null"] }, "text"), []);
  assert.deepEqual(errorsFor({ type: ["string", "null"] }, null), []);
  assert.notDeepEqual(errorsFor({ type: ["string", "null"] }, 1), []);
  assert.deepEqual(errorsFor({ type: "null" }, null), []);
  assert.notDeepEqual(errorsFor({ type: "null" }, "null"), []);
  for (const value of [false, {}, []]) {
    assert.notDeepEqual(errorsFor({ type: ["string", "null"] }, value), []);
  }

  const mixedPrimitiveUnion = { type: ["boolean", "string", "null"] };
  for (const value of [true, false, "text", null]) {
    assert.deepEqual(errorsFor(mixedPrimitiveUnion, value), []);
  }
  assert.notDeepEqual(errorsFor(mixedPrimitiveUnion, 1), []);

  assert.deepEqual(errorsFor({ type: ["integer", "null"] }, 3), []);
  assert.deepEqual(errorsFor({ type: ["integer", "null"] }, null), []);
  assert.notDeepEqual(errorsFor({ type: ["integer", "null"] }, 3.5), []);
  assert.deepEqual(errorsFor({ type: ["number", "null"] }, 3.5), []);
  assert.deepEqual(errorsFor({ type: ["number", "null"] }, null), []);
  assert.notDeepEqual(errorsFor({ type: ["number", "null"] }, Number.POSITIVE_INFINITY), []);
  assert.notDeepEqual(errorsFor({ type: ["number", "null"] }, Number.NaN), []);

  assert.notDeepEqual(errorsFor({ type: "unsupported" }, "text"), []);
  assert.notDeepEqual(errorsFor({ type: ["string", "unsupported"] }, "text"), []);
  assert.notDeepEqual(errorsFor({ type: ["unsupported", "string"] }, "text"), []);
  assert.notDeepEqual(errorsFor({ type: [] }, "text"), []);

  const objectUnion = {
    type: ["object", "null"],
    required: ["name"],
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  assert.deepEqual(errorsFor(objectUnion, null), []);
  assert.deepEqual(errorsFor(objectUnion, { name: "Ada" }), []);
  assert.notDeepEqual(errorsFor(objectUnion, {}), [], "required applies to an object alternative");
  assert.notDeepEqual(errorsFor(objectUnion, { name: 7 }), [], "nested property types apply to an object alternative");
  assert.notDeepEqual(errorsFor(objectUnion, { name: "Ada", extra: true }), [], "additionalProperties applies to an object alternative");

  const arrayUnion = {
    type: ["array", "null"],
    minItems: 1,
    items: { type: ["integer", "null"] },
  };
  assert.deepEqual(errorsFor(arrayUnion, null), []);
  assert.deepEqual(errorsFor(arrayUnion, [1, null]), []);
  assert.notDeepEqual(errorsFor(arrayUnion, []), [], "minItems applies to an array alternative");
  assert.notDeepEqual(errorsFor(arrayUnion, [1.5]), [], "items applies to an array alternative");
});

test("COORD-801: public board validate accepts rationale string/null and rejects invalid union values", () => {
  const { sandbox, coordDir } = copyCoordTreeForIntegration();
  try {
    seedIntegrationBoard(coordDir);
    const planPath = path.join(coordDir, ".runtime", "plans", "COORD-001.json");
    const boardPath = path.join(coordDir, "board", "tasks.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.context_pack_ack = {
      considered: {
        active_constraints: ["fixture constraint"],
        adrs: ["none"],
        business_rules: ["fixture rule"],
        conflicts: ["none"],
        stale_warnings: ["none"],
        open_questions: ["none"],
      },
      authority: { constraints: ["fixture authority"], advisory_only: ["none"] },
      closeout_learning: { decision: "none", rationale: "valid string" },
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const boardCli = path.join(coordDir, "board", "board.js");
    const validationPaths = [
      boardPath,
      planPath,
      path.join(coordDir, "PLAN.md"),
      path.join(coordDir, ".runtime", "governance-events.ndjson"),
    ];
    const validationSnapshot = () => validationPaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
    ]);
    const validateBoard = () => spawnSync(process.execPath, [boardCli, "validate"], {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, HOME: sandbox },
    });
    for (const rationale of ["valid string", null]) {
      plan.context_pack_ack.closeout_learning.rationale = rationale;
      fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      const before = validationSnapshot();
      const result = validateBoard();
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(validationSnapshot(), before, "public validation does not write canonical fixture paths");
    }

    for (const rationale of [1, false, {}, []]) {
      plan.context_pack_ack.closeout_learning.rationale = rationale;
      fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      const before = validationSnapshot();
      const result = validateBoard();
      assert.equal(result.status, 1, `invalid rationale ${JSON.stringify(rationale)} must fail board.js validate`);
      assert.match(result.stderr, /context_pack_ack\.closeout_learning\.rationale.*must be string or null/);
      assert.deepEqual(validationSnapshot(), before, "failed public validation does not write canonical fixture paths");
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
