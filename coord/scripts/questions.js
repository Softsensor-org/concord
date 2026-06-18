"use strict";

// Wave 2 (COORD-059): QUESTIONS.md question handling extracted from lifecycle.js
// — question row parse/classify (severity + aging), orchestrator-queue reads,
// explain-questions guidance, the log-question command, and the question-row
// append/remove writers. DI-factory; shared state/paths come from
// governance-context, and cross-module helpers (canonical text IO,
// operational-type classifier, table/shell formatting) are injected.

const fs = require("fs");
const {
  defaultFail,
  state,
} = require("./governance-context.js");

// Governance blocker codes that warrant a QUESTIONS.md closeout note when they
// were resolved during a ticket. Kept here with buildExplainQuestionsGuidance,
// its only consumer.
const QUESTIONS_WORTHY_BLOCKER_CODES = new Set([
  "prompt_coverage",
  "missing_plan_state",
  "startup_checklist",
  "traceability_gate",
  "baseline_reproduction",
  "missing_lock",
  "owner_mismatch",
  "session_mismatch",
  "critical_invariants",
  "repo_gates",
  "self_review_cycle_count",
  "self_review_cycle_placeholders",
  "self_review_cycle_lenses",
  "self_review_cycle_findings",
  "self_review_cycle_verification",
]);

function escapeDoubleQuotedShellArg(value) {
  return String(value || "").replace(/["\\$`]/g, "\\$&");
}

module.exports = function createQuestions(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    readCanonicalTextFile,
    writeCanonicalTextFile,
    classifyQuestionOperationalType,
    uniqueStrings,
    todayIso,
    escapeTable,
  } = deps;

  function classifyQuestionSeverity(row, operationalType) {
    const resolved = String(row?.resolved || "").toLowerCase();
    if (operationalType === "blocker") {
      return resolved === "no" ? "high" : "medium";
    }
    if (operationalType === "drift-note") {
      return resolved === "no" ? "medium" : "low";
    }
    if (operationalType === "repair") {
      return resolved === "no" ? "medium" : "low";
    }
    return "low";
  }

  function classifyQuestionAgingBucket(row, now = new Date()) {
    const parsed = Date.parse(`${String(row?.date || "").trim()}T00:00:00Z`);
    if (!Number.isFinite(parsed)) {
      return "unknown";
    }
    const ageDays = Math.max(0, Math.floor((now.getTime() - parsed) / 86400000));
    if (ageDays === 0) {
      return "same-day";
    }
    if (ageDays <= 2) {
      return "aging";
    }
    return "stale";
  }

  function parseQuestionRow(line, now = new Date()) {
    const trimmed = String(line || "").trim();
    if (!trimmed.startsWith("|") || /^\|\s*-/.test(trimmed)) {
      return null;
    }
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 6 || cells[0] === "Date") {
      return null;
    }
    const row = {
      date: cells[0],
      from: cells[1],
      to: cells[2].toLowerCase(),
      question: cells[3],
      answer: cells[4],
      resolved: cells[5].toLowerCase(),
    };
    row.operational_type = classifyQuestionOperationalType(row);
    row.severity = classifyQuestionSeverity(row, row.operational_type);
    row.aging_bucket = classifyQuestionAgingBucket(row, now);
    return row;
  }

  function readQuestionRows(options = {}) {
    if (!fs.existsSync(state.QUESTIONS_PATH)) {
      return [];
    }
    const now = options.now instanceof Date ? options.now : new Date();
    const lines = readCanonicalTextFile(state.QUESTIONS_PATH).split(/\r?\n/);
    const rows = [];
    for (const line of lines) {
      const parsed = parseQuestionRow(line, now);
      if (parsed) {
        rows.push(parsed);
      }
    }
    return rows;
  }

  function readOrchestratorQuestionRows(options = {}) {
    return readQuestionRows(options).filter((row) => row.to === "orchestrator");
  }

  function isActiveOrchestratorQuestionRow(row) {
    if (!row || row.to !== "orchestrator") {
      return false;
    }
    if (String(row.resolved || "").toLowerCase() === "yes") {
      return false;
    }
    // Governance drift rows are logger/history entries. They should be
    // preserved for auditability, but they should not count as active queue debt.
    if (row.operational_type === "drift-note") {
      return false;
    }
    return true;
  }

  function readActiveOrchestratorQuestionRows(options = {}) {
    return readOrchestratorQuestionRows(options).filter((row) => isActiveOrchestratorQuestionRow(row));
  }

  function extractDriftMutationStage(question = "") {
    const match = /Governance drift observed while running ([^:]+)/i.exec(String(question || ""));
    if (!match) {
      return null;
    }
    return String(match[1] || "").trim().split(/\s+/)[0] || null;
  }

  function buildExplainQuestionsGuidance({
    ticketId,
    startBlockers = [],
    submitBlockers = [],
    provenanceDrift = [],
    recentIssueEvents = [],
  }) {
    const relevantBlockers = [...startBlockers, ...submitBlockers].filter((blocker) =>
      QUESTIONS_WORTHY_BLOCKER_CODES.has(blocker.code)
    );
    const ticketDrift = (provenanceDrift || []).filter((entry) => String(entry || "").includes(ticketId));
    const issueCodes = uniqueStrings([
      ...relevantBlockers.map((blocker) => blocker.code),
      ...(ticketDrift.length > 0 ? ["governance_drift"] : []),
      ...(recentIssueEvents.length > 0 ? ["recent_governance_repair"] : []),
    ]);
    const issueSummary = [
      ...relevantBlockers.map((blocker) => blocker.message),
      ...ticketDrift.map((entry) => `Ticket-scoped governance drift: ${entry}`),
      ...recentIssueEvents.map((event) => `Recent governance repair command: ${event.command}${event.ts ? ` at ${event.ts}` : ""}.`),
    ];
    const suggestedRepairSteps = uniqueStrings(relevantBlockers.flatMap((blocker) => blocker.next_steps || []));
    const verificationCommands = uniqueStrings([
      `coord/scripts/gov explain ${ticketId}`,
      "coord/scripts/gov doctor",
    ]);
    const required = issueCodes.length > 0;
    const questionTemplate = required
      ? `${ticketId} governance issue resolved: ${issueCodes.join(", ")}`
      : `${ticketId} governance issue resolved: <what was wrong>`;
    const answerTemplate = required
      ? `Describe how the governance issue was fixed, note the command(s) used, and record the verification result. Suggested verification: ${verificationCommands.join("; ")}.`
      : `Describe what governance issue was fixed, the command(s) used, and the verification result.`;
    let why = "No current governance blocker is detected for this ticket. Use the template below only if you had to repair governance state while working it.";
    if (relevantBlockers.length > 0 || ticketDrift.length > 0) {
      why = "Current governance blockers or ticket-scoped governance drift should be recorded in coord/QUESTIONS.md once resolved.";
    } else if (recentIssueEvents.length > 0) {
      why = "Recent governance repair commands were recorded for this ticket. If those repairs are not already captured in coord/QUESTIONS.md, record them now.";
    }

    return {
      required,
      why,
      issue_codes: issueCodes,
      issue_summary: issueSummary,
      suggested_repair_steps: suggestedRepairSteps,
      verification_commands: verificationCommands,
      question_template: questionTemplate,
      answer_template: answerTemplate,
      log_command:
        `coord/scripts/gov log-question --from <agent> --to orchestrator ` +
        `--question "${escapeDoubleQuotedShellArg(questionTemplate)}" ` +
        `--answer "${escapeDoubleQuotedShellArg(answerTemplate)}" --resolved yes`,
    };
  }

  function hasResolvedGovernanceRepairQuestion(ticketId) {
    const raw = readCanonicalTextFile(state.QUESTIONS_PATH, { allowMissing: true });
    if (!raw) {
      return false;
    }
    return raw
      .split("\n")
      .some((line) => line.includes(`| ${ticketId} governance issue resolved:`) && /\|\s*yes\s*\|?\s*$/.test(line));
  }

  function logQuestion(options) {
    if (!options.from || !options.to || !options.question || !options.answer || !options.resolved) {
      fail("log-question requires --from, --to, --question, --answer, and --resolved.");
    }

    appendQuestionRow(options);
    console.log(`Appended QUESTIONS.md row.`);
  }

  function appendQuestionRow(options) {
    appendQuestionRowText(buildQuestionRow(options));
  }

  function buildQuestionRow(options) {
    return `| ${todayIso()} | ${escapeTable(options.from)} | ${escapeTable(options.to)} | ${escapeTable(options.question)} | ${escapeTable(options.answer)} | ${escapeTable(options.resolved)} |`;
  }

  function appendQuestionRowText(row) {
    const raw = readCanonicalTextFile(state.QUESTIONS_PATH);
    const marker = "\n## Instructions\n";
    const insertAt = raw.indexOf(marker);
    let next;
    if (insertAt === -1) {
      // COORD-024: the scaffolded / fresh-install QUESTIONS.md may not carry the
      // "## Instructions" anchor that the donor's own copy has. Rather than fail
      // and leave a brand-new project unable to log a closeout note, append the
      // row at end of file with correct spacing (exactly one trailing newline,
      // and a separating newline if the file does not already end in one).
      const base = raw.endsWith("\n") ? raw : `${raw}\n`;
      next = `${base}${row}\n`;
    } else {
      next = `${raw.slice(0, insertAt)}${row}\n${raw.slice(insertAt)}`;
    }
    writeCanonicalTextFile(state.QUESTIONS_PATH, next, { expectedRaw: raw });
  }

  function removeQuestionRowText(row) {
    const raw = readCanonicalTextFile(state.QUESTIONS_PATH);
    const target = `${row}\n`;
    const index = raw.indexOf(target);
    if (index === -1) {
      return;
    }
    const next = `${raw.slice(0, index)}${raw.slice(index + target.length)}`;
    writeCanonicalTextFile(state.QUESTIONS_PATH, next, { expectedRaw: raw });
  }

  return {
    classifyQuestionSeverity,
    classifyQuestionAgingBucket,
    parseQuestionRow,
    readQuestionRows,
    readOrchestratorQuestionRows,
    isActiveOrchestratorQuestionRow,
    readActiveOrchestratorQuestionRows,
    extractDriftMutationStage,
    buildExplainQuestionsGuidance,
    hasResolvedGovernanceRepairQuestion,
    logQuestion,
    appendQuestionRow,
    buildQuestionRow,
    appendQuestionRowText,
    removeQuestionRowText,
  };
};
