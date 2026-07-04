const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { __testing } = require("./board.js");
const { createCoordPaths } = require("../paths.js");

// C6 Phase 2: plan shards are runtime-owned (.runtime/plans) with a temporary
// compatibility reader over the legacy tracked dir (board/plans). The existing
// fs-mock harnesses below intercept only the legacy dir (path.join(__dirname,
// "plans")); point the runtime dir at a path that never exists so the real
// repo's .runtime/plans cannot leak into those mocked unions. Compat-specific
// tests override these explicitly.
__testing.paths.PLAN_RECORDS_DIR = path.join(
  os.tmpdir(),
  "ebmr-board-nonexistent-runtime-plans"
);
__testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(__dirname, "plans");

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-compat-copy-"));
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
    fs.existsSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath);
    };
    fs.readdirSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-301.json", "ORPH-999.json"];
      }
      return originalReaddirSync(targetPath);
    };
    fs.readFileSync = (targetPath, encoding) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-301.json")) {
        return currentPlanRecord;
      }
      if (targetPath === path.join(__dirname, "plans", "ORPH-999.json")) {
        return "{not valid json";
      }
      return originalReadFileSync(targetPath, encoding);
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-plan-records-"));
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
    fs.existsSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath);
    };
    fs.readdirSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-222.json"];
      }
      return originalReaddirSync(targetPath);
    };
    fs.readFileSync = (targetPath, encoding) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-222.json")) {
        return originalReadFileSync(path.join(planDir, "IMP-222.json"), encoding);
      }
      return originalReadFileSync(targetPath, encoding);
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
    fs.existsSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return true;
      }
      return originalExistsSync(targetPath);
    };
    fs.readdirSync = (targetPath) => {
      if (targetPath === path.join(__dirname, "plans")) {
        return ["IMP-222.json", "ORPH-999.json", "BROKEN-123.json"];
      }
      return originalReaddirSync(targetPath);
    };
    fs.readFileSync = (targetPath, encoding) => {
      if (targetPath === path.join(__dirname, "plans", "IMP-222.json")) {
        return JSON.stringify(makePlanRecord("IMP-222"), null, 2);
      }
      if (targetPath === path.join(__dirname, "plans", "ORPH-999.json")) {
        return JSON.stringify(makePlanRecord("ORPH-999"), null, 2);
      }
      if (targetPath === path.join(__dirname, "plans", "BROKEN-123.json")) {
        return "{not valid json";
      }
      return originalReadFileSync(targetPath, encoding);
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

test("validateBoard allows a transfer-scoped canonical lock-location bypass for the active ticket only", () => {
  const ticketId = "MSRV-003";
  const owner = "claudea12";
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-transfer-bypass-"));
  const tempFrontendRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-transfer-bypass-frontend-"));
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
  const __coordPaths = createCoordPaths({ coordDir: path.dirname(__dirname) });
  const repoRoots = __coordPaths.repoRoots;
  const expectedLockRepo = __testing.expectedLockRepoForCode("B");
  const createdRepoRootLinks = [];
  const createdRepoRootParentDirs = [];
  const fakeLockPath = path.join(runtimeLocksDir, `${ticketId}.lock`);
  const worktreePath = tempRepo;
  const branch = "agent/claudea0000-msrv-003-transfer-test";

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
    fs.existsSync = (targetPath) => {
      if (targetPath === runtimeLocksDir) {
        return true;
      }
      if (targetPath === legacyLocksDir || targetPath === plansDir || targetPath === governanceLogPath) {
        return false;
      }
      return originalExistsSync(targetPath);
    };
    fs.readdirSync = (targetPath) => {
      if (targetPath === runtimeLocksDir) {
        return [`${ticketId}.lock`];
      }
      if (targetPath === legacyLocksDir || targetPath === plansDir) {
        return [];
      }
      return originalReaddirSync(targetPath);
    };
    fs.readFileSync = (targetPath, encoding) => {
      if (targetPath === fakeLockPath) {
        return lockJson;
      }
      return originalReadFileSync(targetPath, encoding);
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
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-journal-missing-ticket-"));
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

test("validateBoard fails when the board regresses behind a terminal governance journal status", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-journal-regression-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-journal-manual-reconcile-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-plan-compat-legacy-"));
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

test("readPlanRecords compat reader: runtime shard wins over legacy on id collision (C6 Phase 2)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-board-plan-compat-collision-"));
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
