"use strict";

// B6 first cut: template-feedback governance-repair tests relocated out of the
// governance.test.js monolith into a module-owned file. They exercise the
// B5-extracted governance-repair helpers through their owning factory.
// The remaining governance.test.js split continues incrementally (COORD-053).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { GovernanceError, createTempGitRepoWithOrigin, withGovernedSurfaceSandbox, withScopedGovernanceTestContext } = require("./governance-test-utils.js");
const createGovernanceRepair = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-repair.js"));
const createGovernanceBoardState = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-board-state.js"));
const { resolveEngineModule } = require("../paths.js");
const createJournal = require(resolveEngineModule(path.resolve(__dirname, ".."), "scripts/journal.js"));
const boardStateProjection = createGovernanceBoardState({});
const createLifecycleBoardCommands = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/lifecycle-board-commands.js"));
const boardCommandOwner = createLifecycleBoardCommands();
const governanceRepair = createGovernanceRepair({});
const repair = createGovernanceRepair({ getRows: boardStateProjection.getRows, readCanonicalTextFile: () => "" });
const stateIo = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/state-io.js"));
const { COORD_DIR, state: journalState, withGovernanceRuntimeLock } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
const createQuestions = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/questions.js"));
const createChainTransitionSigner = require(resolveEngineModule(path.resolve(__dirname, ".."), "scripts/chain-transition-signer.js"));
const createConformanceAttestation = require(require("../paths.js").resolveEngineModule(path.resolve(__dirname, ".."), "scripts/conformance-attestation.js"));
const { signTransition } = require(resolveEngineModule(path.resolve(__dirname, ".."), "scripts/chain-migration-signing.js"));
const questionWriter = createQuestions({
  state: journalState,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  classifyQuestionOperationalType: governanceRepair.classifyQuestionOperationalType,
  uniqueStrings: (values) => [...new Set(values)],
  todayIso: () => new Date().toISOString().slice(0, 10),
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
});
const sessionDiagnostics = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-session.js"))({}).formatGovernanceJournalUninitializedMessage;
const { signChainTransition } = createChainTransitionSigner({
  coordDir: COORD_DIR,
  resolveRuntimeDir: () => journalState.RUNTIME_DIR,
  createConformanceAttestation,
  signTransition,
});
const warningDriftPrefixes = [".runtime/agent_sessions.json", ".runtime/session-threads/"];
const journalOwner = createJournal({
  fail: (message) => { throw new GovernanceError(message); },
  relativeCoordPath: (filePath) => path.relative(COORD_DIR, filePath).replace(/\\/g, "/"),
  existingLockDirs: () => [journalState.LOCKS_DIR, journalState.LEGACY_LOCKS_DIR],
  writeFileAtomicSync: stateIo.writeFileAtomicSync,
  readJsonFileState: stateIo.readJsonFileState,
  formatJsonFileIssue: stateIo.formatJsonFileIssue,
  readLastNonEmptyLine: stateIo.readLastNonEmptyLine,
  withGovernanceRuntimeLock,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  buildQuestionRow: questionWriter.buildQuestionRow,
  appendQuestionRowText: questionWriter.appendQuestionRowText,
  parseQuestionRow: questionWriter.parseQuestionRow,
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
  ensureCurrentAgentIdentity: () => null,
  resolveEffectiveThreadId: () => null,
  readAgentSessions: () => stateIo.readJsonArrayFileOrFail(journalState.AGENT_SESSIONS_PATH, "agent sessions file"),
  readCanonicalJsonFile: stateIo.readCanonicalJsonFile,
  getRows: boardStateProjection.getRows,
  formatGovernanceJournalUninitializedMessage: sessionDiagnostics,
  splitGovernanceProvenanceDrift: (files) => ({
    warnings: files.filter((file) => warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
    blocking: files.filter((file) => !warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
  }),
  signChainTransition,
  GovernanceError,
});
const lifecycle = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/lifecycle.js"));
const lifecycleCommands = lifecycle.commands;
const boardModule = require("../board/board.js");
const { DEFAULT_PATHS } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));

// COORD-071: the coord/X ticket-id prefix is config-driven (project.config.js
// `coordTicketPrefix`). Build fixture ticket ids from the active prefix so
// these tests pass under BOTH legs of the config matrix (default "COORD" and
// the non-default fixture's prefix).
const CP = DEFAULT_PATHS.coordTicketPrefix || "COORD";

test("parseTemplateFeedbackRowsFromText extracts real rows and ticket references", () => {
  const rows = repair.parseTemplateFeedbackRowsFromText(`# Template Feedback

## Governance

| Date | Finding | Severity | Status |
|------|---------|----------|--------|
| | | | |
| 2026-05-01 | ${CP}-006 added --review-round for stuck review gates | High | Backfilled |

## Skills

| Date | Skill | Change | Rationale |
|------|-------|--------|-----------|
| 2026-05-01 | /next | ${CP}-005 replaced gov whoami copy with gov agentid | Prevent stale aliases |

## Template Structure

| Date | Finding | Recommendation |
|------|---------|----------------|
| 2026-05-01 | ${CP}-007 found per-repo base-ref drift | Add registry |
`);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.section), ["governance", "skills", "template_structure"]);
  assert.deepEqual(rows[0].ticket_refs, [`${CP}-006`]);
  assert.deepEqual(rows[2].ticket_refs, [`${CP}-007`]);
});

test("collectTemplateFeedbackAlerts reports matching done coord tickets without feedback rows", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: `${CP}-100`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance session lock drift.",
          },
          {
            ID: `${CP}-101`,
            Repo: "X",
            Status: "done",
            Type: "docs",
            Description: "Project-local wording cleanup.",
          },
          {
            ID: "WEB-100",
            Repo: "F",
            Status: "done",
            Type: "feature",
            Description: "Frontend governance text.",
          },
        ],
      },
    ],
  };
  const events = [
    {
      ticket: `${CP}-100`,
      after_status: "done",
      ts: "2026-04-25T00:00:00.000Z",
    },
  ];

  const alerts = repair.collectTemplateFeedbackAlerts(board, events, {
    now: new Date("2026-05-06T00:00:00.000Z"),
    feedbackRows: [],
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ticket, `${CP}-100`);
  assert.equal(alerts[0].age_days, 11);
  assert.equal(alerts[0].stale, true);
  assert.match(boardCommandOwner.formatTemplateFeedbackAlerts(alerts)[0], /Template feedback alerts: 1/);
});

test("collectStaleTemplateFeedbackErrors honors feedback rows and project-local waivers", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: `${CP}-100`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance session lock drift.",
          },
          {
            ID: `${CP}-101`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance CLI typo.",
          },
          {
            ID: `${CP}-102`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance local-only edge.",
          },
        ],
      },
    ],
  };
  const events = [`${CP}-100`, `${CP}-101`, `${CP}-102`].map((ticket) => ({
    ticket,
    after_status: "done",
    ts: "2026-04-25T00:00:00.000Z",
  }));
  const feedbackRows = repair.parseTemplateFeedbackRowsFromText(`
## Governance
| Date | Finding | Severity | Status |
|------|---------|----------|--------|
| 2026-05-01 | ${CP}-101 fixed template-worthy bug | High | Backfilled |
| 2026-05-01 | ${CP}-102 local-only | Low | human-admin project-local waiver |
`);

  const errors = repair.collectStaleTemplateFeedbackErrors(board, events, {
    now: new Date("2026-05-06T00:00:00.000Z"),
    feedbackRows,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`${CP}-100`));
});

test("public orchestrator cycle reports a completed coord ticket missing template feedback", (t) => {
  withGovernedSurfaceSandbox(({ boardPath, logPath, planPath, questionsPath, renderedDir, snapshotPath, tempDir }) => {
    const ticketId = `${CP}-100`;
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.metadata.plan_markdown_render_statuses = ["doing", "review"];
    board.metadata.preamble = [];
    board.sections = [{
      kind: "table",
      level: 2,
      heading: "Completed template work",
      separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [
        {
          ID: ticketId,
          Repo: "X",
          Type: "bug",
          Pri: "P2",
          Status: "done",
          Owner: "unassigned",
          Description: "Fix governance documentation for the coordination template.",
          "Depends On": "",
        },
        {
          ID: `${CP}-101`,
          Repo: "X",
          Type: "bug",
          Pri: "P2",
          Status: "todo",
          Owner: "unassigned",
          Description: "Review the fixture merge receipt.",
          "Depends On": "",
        },
        {
          ID: `${CP}-102`,
          Repo: "X",
          Type: "bug",
          Pri: "P2",
          Status: "todo",
          Owner: "unassigned",
          Description: "Review the fixture merge receipt without a merge timestamp.",
          "Depends On": "",
        },
      ],
    }];
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");

    const feedbackPath = path.join(tempDir, "TEMPLATE_FEEDBACK.md");
    const productRoots = {};
    for (const code of ["B", "F"]) {
      const { repoRoot, remoteRoot } = createTempGitRepoWithOrigin("coord-feedback-product-", { "README.md": "fixture\n" });
      t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
      t.after(() => fs.rmSync(remoteRoot, { recursive: true, force: true }));
      productRoots[code] = repoRoot;
    }
    return withScopedGovernanceTestContext({
      TEMPLATE_FEEDBACK_PATH: feedbackPath,
      REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, ...productRoots },
      REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, B: "dev", F: "dev" },
    }, () => {
      fs.writeFileSync(feedbackPath, "# Template Feedback\n", "utf8");
      boardModule.renderBoardArtifacts();
      lifecycle.ensureGovernanceJournalBaseline("template-feedback orchestrator fixture");
      journalOwner.appendGovernanceEvent({
        ts: "2026-05-06T00:00:00.000Z",
        command: "fixture-merge-receipt",
        ticket: `${CP}-101`,
        result: "succeeded",
        details: {
          external_side_effects: [{
            type: "github_pr_merge",
            merged_at: "2026-05-05T18:00:00.000Z",
            pr_url: "https://github.com/example/coord/pull/101",
          }],
        },
        changed_paths: [],
      });

      const protectedPaths = [
        boardPath,
        planPath,
        questionsPath,
        logPath,
        snapshotPath,
        path.join(renderedDir, "TASKS.md"),
        feedbackPath,
      ];
      const before = protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      }));
      const output = [];
      const originalLog = console.log;
      try {
        console.log = (...values) => output.push(values.join(" "));
        lifecycleCommands.orchestratorCycle();
      } finally {
        console.log = originalLog;
      }

      const report = output.join("\n");
      assert.match(report, /Template feedback alerts: 1 COORD ticket\(s\) need TEMPLATE_FEEDBACK\.md rows\./);
      assert.match(report, new RegExp(`${ticketId} age=unknown: add TEMPLATE_FEEDBACK\\.md row`));
      assert.match(report, /Exception SLO: blockers=0; stale=0; merged_but_not_done=1; drift_stages=none/);
      assert.deepEqual(protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      })), before, "the public read-only cycle must preserve its sandboxed board, plan, questions, journal, and feedback bytes");

      const queueDate = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(questionsPath, [
        "# Agent Q&A Log",
        "",
        "## Format",
        "",
        "| Date | From | To | Question | Answer | Resolved |",
        "|------|------|----|----------|--------|----------|",
        `| ${queueDate} | fixture | orchestrator | blocked on the fixture queue item | | no |`,
        "",
      ].join("\n"), "utf8");
      journalOwner.appendGovernanceEvent({
        ts: "2026-05-06T00:01:00.000Z",
        command: "fixture-questions-baseline",
        ticket: null,
        result: "succeeded",
        details: { reason: "seed the unresolved queue row for the read-only orchestrator cycle" },
        changed_paths: [questionsPath],
        snapshot: journalOwner.buildGovernanceSnapshot(),
      });
      const beforeQueuedCycle = protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      }));
      const queuedOutput = [];
      try {
        console.log = (...values) => queuedOutput.push(values.join(" "));
        lifecycleCommands.orchestratorCycle();
      } finally {
        console.log = originalLog;
      }

      const queuedReport = queuedOutput.join("\n");
      assert.match(queuedReport, /1 unresolved orchestrator question\(s\) remain in QUESTIONS\.md/);
      assert.match(queuedReport, /Queue by type: blocker=1/);
      assert.match(queuedReport, /Exception SLO: blockers=1; stale=0; merged_but_not_done=1; drift_stages=none/);
      assert.match(queuedReport, /Template feedback alerts: 1 COORD ticket\(s\) need TEMPLATE_FEEDBACK\.md rows\./);
      assert.match(queuedReport, /Merged but not done:/);
      assert.match(queuedReport, new RegExp(`${CP}-101 status=todo merged_at=2026-05-05T18:00:00\\.000Z pr=https://github\\.com/example/coord/pull/101`));
      assert.deepEqual(protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      })), beforeQueuedCycle, "the public queued cycle must preserve the sandboxed board, plan, questions, journal, and feedback bytes");

      journalOwner.appendGovernanceEvent({
        ts: "2026-05-06T00:02:00.000Z",
        command: "fixture-merge-receipt-without-merged-at",
        ticket: `${CP}-102`,
        result: "succeeded",
        details: {
          external_side_effects: [{
            type: "github_pr_merge",
            pr_url: "https://github.com/example/coord/pull/102",
          }],
        },
        changed_paths: [],
      });
      const beforeFallbackCycle = protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      }));
      const fallbackOutput = [];
      try {
        console.log = (...values) => fallbackOutput.push(values.join(" "));
        lifecycleCommands.orchestratorCycle();
      } finally {
        console.log = originalLog;
      }

      const fallbackReport = fallbackOutput.join("\n");
      assert.match(fallbackReport, /Exception SLO: blockers=1; stale=0; merged_but_not_done=2; drift_stages=none/);
      assert.match(fallbackReport, /Merged but not done:/);
      assert.match(fallbackReport, new RegExp(`${CP}-101 status=todo merged_at=2026-05-05T18:00:00\\.000Z pr=https://github\\.com/example/coord/pull/101`));
      assert.match(fallbackReport, new RegExp(`${CP}-102 status=todo merged_at=unknown pr=https://github\\.com/example/coord/pull/102`));
      assert.deepEqual(protectedPaths.map((file) => ({
        exists: fs.existsSync(file),
        contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      })), beforeFallbackCycle, "the public fallback cycle must preserve the sandboxed board, plan, questions, journal, and feedback bytes");
    });
  }, { isolateBoardValidation: true });
});
