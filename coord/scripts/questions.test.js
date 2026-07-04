// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

// Wave 2 (COORD-059): questions tests relocated out of governance.test.js into a
// module-owned file. Exercise question-row parse/classify, orchestrator-queue
// reads, explain-questions guidance, and the QUESTIONS.md append writer via the
// governance __testing surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __testing } = require("./governance-test-utils.js");

test("buildExplainQuestionsGuidance marks real governance blockers for QUESTIONS logging", () => {
  const guidance = __testing.buildExplainQuestionsGuidance({
    ticketId: "IMP-245",
    startBlockers: [
      {
        code: "dependencies",
        message: "Ticket IMP-245 cannot start until IMP-240 lands.",
        next_steps: ["coord/scripts/gov explain IMP-240"],
      },
    ],
    submitBlockers: [
      {
        code: "session_mismatch",
        message: "Lock for IMP-245 is bound to an older session.",
        next_steps: ["coord/scripts/gov resume IMP-245"],
      },
      {
        code: "repo_gates",
        message: "Plan state for IMP-245 must record repo gates before move-review.",
        next_steps: ['coord/scripts/gov update-plan IMP-245 --repo-gate "pytest -q tests/test_signatures.py"'],
      },
    ],
    provenanceDrift: [
      ".runtime/locks/IMP-245.lock",
      ".runtime/locks/IMP-311.lock",
    ],
    recentIssueEvents: [
      {
        command: "recover",
        ts: "2026-03-29T13:00:00.000Z",
      },
    ],
  });

  assert.equal(guidance.required, true);
  assert.deepEqual(guidance.issue_codes, [
    "session_mismatch",
    "repo_gates",
    "governance_drift",
    "recent_governance_repair",
  ]);
  assert.equal(guidance.suggested_repair_steps.includes("coord/scripts/gov resume IMP-245"), true);
  assert.equal(guidance.suggested_repair_steps.includes("coord/scripts/gov explain IMP-240"), false);
  assert.match(guidance.why, /Current governance blockers or ticket-scoped governance drift/);
  assert.match(guidance.question_template, /IMP-245 governance issue resolved:/);
  assert.match(guidance.log_command, /coord\/scripts\/gov log-question/);
});

test("buildExplainQuestionsGuidance keeps a reusable optional template for clean tickets", () => {
  const guidance = __testing.buildExplainQuestionsGuidance({
    ticketId: "DEBT-043",
  });

  assert.equal(guidance.required, false);
  assert.deepEqual(guidance.issue_codes, []);
  assert.match(guidance.why, /No current governance blocker is detected/);
  assert.equal(guidance.suggested_repair_steps.length, 0);
  assert.match(guidance.question_template, /DEBT-043 governance issue resolved: <what was wrong>/);
});

test("parseQuestionRow classifies governance question rows by type, severity, and aging", () => {
  const now = new Date("2026-04-04T12:00:00.000Z");
  const blocker = __testing.parseQuestionRow(
    "| 2026-04-01 | codexa00 | orchestrator | Starting MSRV-002 exposed repo-state drift in `backend`. | Needs reconciliation. | no |",
    now
  );
  assert.equal(blocker.operational_type, "blocker");
  assert.equal(blocker.severity, "high");
  assert.equal(blocker.aging_bucket, "stale");

  const drift = __testing.parseQuestionRow(
    "| 2026-04-04 | codexa00 | orchestrator | Governance drift observed while running move-review FE-017: QUESTIONS.md | Detected unjournaled drift. | no |",
    now
  );
  assert.equal(drift.operational_type, "drift-note");
  assert.equal(drift.severity, "medium");
  assert.equal(drift.aging_bucket, "same-day");

  const repair = __testing.parseQuestionRow(
    "| 2026-04-03 | codexa00 | orchestrator | FE-002 governance issue resolved: recent_governance_repair | Reconciled and verified. | yes |",
    now
  );
  assert.equal(repair.operational_type, "repair");
  assert.equal(repair.severity, "low");
  assert.equal(repair.aging_bucket, "aging");

  const informational = __testing.parseQuestionRow(
    "| 2026-04-03 | codexa00 | all | FE-002 landed through governance. | Merged and closed. | yes |",
    now
  );
  assert.equal(informational.operational_type, "informational");
  assert.equal(informational.severity, "low");
  assert.equal(informational.aging_bucket, "aging");
});

test("readActiveOrchestratorQuestionRows excludes historical drift-note logger rows from queue debt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-questions-queue-"));
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, `# Questions

| Date | From | To | Question | Answer | Resolved |
|------|------|----|----------|--------|----------|
| 2026-04-01 | codexa00 | orchestrator | Starting MSRV-002 exposed repo-state drift in \`backend\`. | Needs reconciliation. | no |
| 2026-04-04 | codexa00 | orchestrator | Governance drift observed while running submit IMP-311: board/tasks.json | Detected unjournaled drift. | no |
| 2026-04-03 | codexa00 | orchestrator | FE-002 governance issue resolved: recent_governance_repair | Reconciled and verified. | yes |
| 2026-04-03 | codexa00 | all | FE-002 landed through governance. | Merged and closed. | yes |

## Instructions
`, "utf8");

  const originalQuestionsPath = __testing.paths.QUESTIONS_PATH;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  try {
    const rows = __testing.readOrchestratorQuestionRows({ now: new Date("2026-04-04T12:00:00.000Z") });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.operational_type), ["blocker", "drift-note", "repair"]);

    const activeRows = __testing.readActiveOrchestratorQuestionRows({ now: new Date("2026-04-04T12:00:00.000Z") });
    assert.equal(activeRows.length, 1);
    assert.deepEqual(activeRows.map((row) => row.operational_type), ["blocker"]);

    const report = __testing.buildQuestionQueueReport(activeRows);
    assert.equal(report.total, 1);
    assert.deepEqual(report.by_type, { blocker: 1 });
    assert.deepEqual(report.by_severity, { high: 1 });
    assert.deepEqual(report.by_aging, { stale: 1 });
    assert.equal(report.oldest[0].operational_type, "blocker");
    assert.equal(__testing.formatBucketCounts(report.by_type, ["blocker", "repair", "drift-note", "informational"]), "blocker=1");
  } finally {
    __testing.paths.QUESTIONS_PATH = originalQuestionsPath;
  }
});

// ---------------------------------------------------------------------------
// COORD-024: QUESTIONS closeout robustness — scaffold marker + append-at-end
// fallback when the "## Instructions" anchor is absent.
// ---------------------------------------------------------------------------

function withQuestionsFile(prefix, initialContent, body) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, initialContent, "utf8");
  const original = __testing.paths.QUESTIONS_PATH;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  try {
    return body({ questionsPath, read: () => fs.readFileSync(questionsPath, "utf8") });
  } finally {
    __testing.paths.QUESTIONS_PATH = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("COORD-024: appendQuestionRowText inserts before the marker when present", () => {
  const initial = [
    "# Agent Q&A Log",
    "",
    "## Format",
    "",
    "| Date | From | To | Question | Answer | Resolved |",
    "|------|------|----|----------|--------|----------|",
    "",
    "## Instructions",
    "",
    "Keep this heading.",
    "",
  ].join("\n");
  withQuestionsFile("coord024-marker-", initial, ({ read }) => {
    const row = "| 2026-06-10 | concord1 | log | a question | an answer | yes |";
    __testing.appendQuestionRowText(row);
    const out = read();
    assert.ok(out.includes(row), "row must be written");
    // Inserted BEFORE the Instructions section.
    assert.ok(out.indexOf(row) < out.indexOf("## Instructions"), "row must precede the marker");
    // Marker preserved.
    assert.ok(out.includes("## Instructions"), "marker preserved");
    // Well-formed: no doubled blank-line corruption around the row.
    assert.ok(out.includes(`${row}\n`), "row terminated by a newline");
  });
});

test("COORD-024: appendQuestionRowText appends at end of file when the marker is absent", () => {
  const initial = [
    "# Agent Q&A Log",
    "",
    "## Format",
    "",
    "| Date | From | To | Question | Answer | Resolved |",
    "|------|------|----|----------|--------|----------|",
    "",
  ].join("\n");
  withQuestionsFile("coord024-nomarker-", initial, ({ read }) => {
    const row = "| 2026-06-10 | concord1 | log | fresh-install question | recorded | yes |";
    __testing.appendQuestionRowText(row); // must NOT throw
    const out = read();
    assert.ok(out.includes(row), "row must be appended even without a marker");
    assert.ok(out.endsWith(`${row}\n`), "row must land at end of file with exactly one trailing newline");
  });
});

test("COORD-024: appendQuestionRowText keeps spacing well-formed when the file lacks a trailing newline", () => {
  // No trailing newline and no marker — append must add the separating newline.
  const initial = "# Agent Q&A Log\n\n## Format\n\n| Date | From | To | Question | Answer | Resolved |\n|------|------|----|----------|--------|----------|";
  withQuestionsFile("coord024-notrail-", initial, ({ read }) => {
    const row = "| 2026-06-10 | concord1 | log | q | a | yes |";
    __testing.appendQuestionRowText(row);
    const out = read();
    assert.ok(out.includes(`|------|------|----|----------|--------|----------|\n${row}\n`),
      "the prior last line and the new row must be separated by exactly one newline");
  });
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


// ---------------------------------------------------------------------------
// gov gate bash fallback: resolveGateInvocation prefers npm gate scripts and
// falls back to `bash scripts/gate.sh <lane>` when none exists but the repo
// ships scripts/gate.sh.
// ---------------------------------------------------------------------------

test("COORD-024: the donor coord/QUESTIONS.md carries the canonical ## Instructions anchor", () => {
  const donor = fs.readFileSync("coord/QUESTIONS.md", "utf8");
  assert.match(donor, /\n## Instructions\n/, "donor QUESTIONS.md must contain the insertion anchor from first run");
});
