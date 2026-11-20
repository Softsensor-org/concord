"use strict";

// B5 decomposition slice: read-only governance-repair report + classification
// helpers extracted from lifecycle.js (template-feedback alerts, question-queue
// classification, drift-path guidance, stale-lock detection). The mutating
// orchestrators (doctor, doctorFix, reconcile, recover) stay in lifecycle.js
// and call these via the destructured factory return.

const fs = require("fs");
const { state, DEFAULT_PATHS } = require("./governance-context.js");
const {
  STALLED_LOCK_MS,
  TEMPLATE_FEEDBACK_STALE_MS,
  TEMPLATE_FEEDBACK_TRIGGER_PATTERN,
  escapeRegExp,
  STATUS,
} = require("./governance-constants.js");

// The coord/cross-repo ("X") ticket-id prefix is project-configurable through
// coord/project.config.js (`coordTicketPrefix`, default "COORD"). Build the
// X-repo ticket-id matchers from it rather than hardcoding "COORD-".
const COORD_TICKET_PREFIX = DEFAULT_PATHS.coordTicketPrefix;
const COORD_TICKET_REF_PATTERN = new RegExp(`\\b${escapeRegExp(COORD_TICKET_PREFIX)}-\\d+\\b`, "g");
const COORD_TICKET_ID_PATTERN = new RegExp(`^${escapeRegExp(COORD_TICKET_PREFIX)}-\\d+$`);

// Lock/session drift is the class recover / doctor --fix / claim exist to repair
// and the only class `gov reconcile` accepts without a human-admin override.
function isRecoverableGovernanceDriftPath(relativePath) {
  return (
    relativePath === "agent_sessions.json" ||
    relativePath === ".runtime/agent_sessions.json" ||
    relativePath.startsWith("locks/") ||
    relativePath.startsWith(".runtime/locks/")
  );
}

// COORD-722: a drift-tolerant verb (`allowProvenanceDrift`: claim, agent-*,
// recover, doctor --fix, rebuild-board, record-cost, ...) skips the entry seal so
// it can repair sessions/locks on top of unrelated drift. It must not LAUNDER
// that drift: its event snapshot is the full on-disk state, so recording it
// as-is would make a tampered or never-adopted ADR (or any other semantic path)
// the new baseline with no override and no record. Semantic paths that were
// already drifted at entry and that the verb did not itself rewrite therefore
// keep their last journaled entry (or stay absent), so the drift survives the
// verb and the next ordinary mutation still refuses. Only `gov reconcile`
// (`adoptProvenanceDrift`, override-gated for semantic drift) adopts drift.
// COORD-862: a scoped reconcile (`adoptDriftPaths`) adopts only the listed
// semantic paths; every other pre-existing semantic drift path is retained.
function planDriftRetention(metadata, provenance, readBaselineSnapshot) {
  const eligible = metadata.allowProvenanceDrift === true && !provenance.uninitialized && !provenance.snapshotPruned;
  const scoped = Array.isArray(metadata.adoptDriftPaths) ? new Set(metadata.adoptDriftPaths) : null;
  const retainable = (entry) => !isRecoverableGovernanceDriftPath(entry) &&
    (metadata.adoptProvenanceDrift !== true || (scoped && !scoped.has(entry)));
  const paths = eligible && (metadata.adoptProvenanceDrift !== true || scoped)
    ? (provenance.drift || []).filter(retainable)
    : [];
  const baseline = paths.length > 0 ? readBaselineSnapshot() : null;
  const entryKey = (snapshot, filePath) => {
    const entry = snapshot.files.find((candidate) => candidate.path === filePath);
    return entry ? `${entry.exists}:${entry.digest}` : "missing";
  };
  return {
    seal(before, after, details, digest) {
      const retained = baseline ? paths.filter((entry) => entryKey(before, entry) === entryKey(after, entry)) : [];
      if (retained.length === 0) return { snapshot: after, details };
      const kept = new Set(retained);
      const files = after.files.filter((entry) => !kept.has(entry.path))
        .concat(baseline.files.filter((entry) => kept.has(entry.path)))
        .sort((left, right) => left.path.localeCompare(right.path));
      return {
        snapshot: { ...after, digest: digest(JSON.stringify(files)), files },
        details: { ...(details || {}), retained_preexisting_drift: retained },
      };
    },
  };
}

// COORD-722: the crash-rollback event's snapshot. The restore point was captured
// at the interrupted verb's entry, so restoring it reinstates whatever drift
// existed then (a drift-tolerant verb such as claim enters with it). That drift
// was never journaled; every non-recoverable path still drifted after the
// restore keeps its last journaled entry, so the next ordinary mutation refuses.
function sealCrashRollbackSnapshot(provenance, readBaselineSnapshot, digest) {
  const current = provenance.currentSnapshot;
  return planDriftRetention({ allowProvenanceDrift: true }, provenance, readBaselineSnapshot).seal(current, current, null, digest).snapshot;
}

// COORD-722: fields for a diagnostic journal event (collision-detected) that
// must NOT advance the provenance baseline: it re-records the current baseline
// snapshot, or only its digest when the artifact was pruned, never on-disk state.
function baselineEventFields({ snapshot, expectedDigest } = {}) {
  if (snapshot) return { snapshot };
  return expectedDigest ? { snapshot_digest: expectedDigest } : {};
}

module.exports = function createGovernanceRepair(deps = {}) {
  const { getRows, readCanonicalTextFile } = deps;

  function classifyQuestionOperationalType(row) {
    const question = String(row?.question || "");
    if (/governance drift observed while running/i.test(question)) {
      return "drift-note";
    }
    if (/governance issue resolved:/i.test(question)) {
      return "repair";
    }
    if (String(row?.resolved || "").toLowerCase() === "no") {
      return "blocker";
    }
    return "informational";
  }
  
  function buildQuestionQueueReport(rows = []) {
    const report = {
      total: rows.length,
      by_type: {},
      by_severity: {},
      by_aging: {},
      oldest: [],
    };
    for (const row of rows) {
      report.by_type[row.operational_type] = (report.by_type[row.operational_type] || 0) + 1;
      report.by_severity[row.severity] = (report.by_severity[row.severity] || 0) + 1;
      report.by_aging[row.aging_bucket] = (report.by_aging[row.aging_bucket] || 0) + 1;
    }
    const agingOrder = new Map([
      ["stale", 0],
      ["aging", 1],
      ["same-day", 2],
      ["unknown", 3],
    ]);
    const severityOrder = new Map([
      ["high", 0],
      ["medium", 1],
      ["low", 2],
    ]);
    report.oldest = [...rows]
      .sort((left, right) => {
        const agingDelta = (agingOrder.get(left.aging_bucket) ?? 99) - (agingOrder.get(right.aging_bucket) ?? 99);
        if (agingDelta !== 0) {
          return agingDelta;
        }
        const severityDelta = (severityOrder.get(left.severity) ?? 99) - (severityOrder.get(right.severity) ?? 99);
        if (severityDelta !== 0) {
          return severityDelta;
        }
        return String(left.date).localeCompare(String(right.date));
      })
      .slice(0, 5);
    return report;
  }
  
  function parseTemplateFeedbackRowsFromText(text) {
    const rows = [];
    let section = null;
    const lines = String(text || "").split(/\r?\n/);
  
    for (const line of lines) {
      const heading = /^##\s+(.+?)\s*$/.exec(line);
      if (heading) {
        const label = heading[1].trim().toLowerCase();
        if (label === "governance") section = "governance";
        else if (label === "skills") section = "skills";
        else if (label === "template structure") section = "template_structure";
        else section = null;
        continue;
      }
  
      const trimmed = line.trim();
      if (!section || !trimmed.startsWith("|") || /^\|\s*-/.test(trimmed)) {
        continue;
      }
  
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length < 3 || /^date$/i.test(cells[0] || "")) {
        continue;
      }
      if (cells.every((cell) => cell.length === 0)) {
        continue;
      }
  
      const raw = cells.join(" | ");
      rows.push({
        section,
        cells,
        raw,
        ticket_refs: [...new Set(raw.match(COORD_TICKET_REF_PATTERN) || [])],
        waiver: /\b(project-local|waiv(?:e|ed|er)|human-admin)\b/i.test(raw),
      });
    }
  
    return rows;
  }
  
  function readTemplateFeedbackRows() {
    if (!fs.existsSync(state.TEMPLATE_FEEDBACK_PATH)) {
      return [];
    }
    return parseTemplateFeedbackRowsFromText(readCanonicalTextFile(state.TEMPLATE_FEEDBACK_PATH));
  }
  
  function ticketNeedsTemplateFeedback(row) {
    if (!row || row.Repo !== "X" || !COORD_TICKET_ID_PATTERN.test(String(row.ID || ""))) {
      return false;
    }
    if (row.Status !== STATUS.DONE) {
      return false;
    }
    return TEMPLATE_FEEDBACK_TRIGGER_PATTERN.test(`${row.Description || ""} ${row.Type || ""}`);
  }
  
  function latestDoneTimestampByTicket(events = []) {
    const byTicket = new Map();
    for (const event of events || []) {
      if (!event || !event.ticket) {
        continue;
      }
      if (event.after_status !== STATUS.DONE) {
        continue;
      }
      const parsed = Date.parse(event.ts);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      const current = byTicket.get(event.ticket);
      if (!current || parsed > current.getTime()) {
        byTicket.set(event.ticket, new Date(parsed));
      }
    }
    return byTicket;
  }
  
  function collectTemplateFeedbackAlerts(board, events = [], options = {}) {
    const feedbackRows = Array.isArray(options.feedbackRows)
      ? options.feedbackRows
      : readTemplateFeedbackRows();
    const doneByTicket = latestDoneTimestampByTicket(events);
    const now = options.now instanceof Date ? options.now : new Date();
    const scopedRows = Array.isArray(options.rows) ? options.rows : getRows(board);
    const alerts = [];
  
    for (const row of scopedRows) {
      if (!ticketNeedsTemplateFeedback(row)) {
        continue;
      }
      const ticketId = row.ID;
      const matchingFeedback = feedbackRows.filter((entry) => entry.ticket_refs.includes(ticketId));
      if (matchingFeedback.length > 0) {
        continue;
      }
      const doneAt = doneByTicket.get(ticketId) || null;
      const ageMs = doneAt ? Math.max(0, now.getTime() - doneAt.getTime()) : null;
      alerts.push({
        ticket: ticketId,
        description: row.Description || "",
        done_at: doneAt ? doneAt.toISOString() : null,
        age_days: ageMs === null ? null : Math.floor(ageMs / 86400000),
        stale: ageMs !== null && ageMs >= TEMPLATE_FEEDBACK_STALE_MS,
      });
    }
  
    return alerts;
  }
  
  function collectStaleTemplateFeedbackErrors(board, events = [], options = {}) {
    return collectTemplateFeedbackAlerts(board, events, options)
      .filter((alert) => alert.stale)
      .map(
        (alert) =>
          `Ticket ${alert.ticket} is a done COORD governance/template ticket older than 7 days but has no TEMPLATE_FEEDBACK.md row or project-local waiver.`
      );
  }
  
  function isStaleTicketLock(lock, now = Date.now()) {
    const heartbeatAt = Date.parse(lock?.heartbeat_utc || "");
    return Number.isFinite(heartbeatAt) && now - heartbeatAt > STALLED_LOCK_MS;
  }
  
  function extractTicketIdsFromGovernanceIssues(errors = []) {
    const ticketIds = new Set();
    for (const error of errors || []) {
      for (const match of String(error || "").matchAll(/\b[A-Z]+-\d+\b/g)) {
        ticketIds.add(match[0]);
      }
    }
    return [...ticketIds];
  }
  
  function buildDoctorResolutionGuidance(errors = []) {
    const ticketIds = extractTicketIdsFromGovernanceIssues(errors);
    if (ticketIds.length === 0) {
      return "";
    }
    return (
      "\n\nTicket-scoped governance issues must be closed with a recorded resolution in coord/QUESTIONS.md.\n" +
      `Affected tickets: ${ticketIds.join(", ")}\n` +
      "After fixing the issue, record it with:\n" +
      'coord/scripts/gov log-question --from <agent> --to orchestrator --question "<ticket-id> governance issue resolved: <what was wrong>" --answer "<how it was fixed>" --resolved yes'
    );
  }
  return {
    classifyQuestionOperationalType, buildQuestionQueueReport,
    parseTemplateFeedbackRowsFromText, readTemplateFeedbackRows,
    ticketNeedsTemplateFeedback, latestDoneTimestampByTicket,
    collectTemplateFeedbackAlerts, collectStaleTemplateFeedbackErrors,
    isStaleTicketLock, isRecoverableGovernanceDriftPath,
    extractTicketIdsFromGovernanceIssues, buildDoctorResolutionGuidance,
  };
};
module.exports.planDriftRetention = planDriftRetention;
module.exports.baselineEventFields = baselineEventFields;
module.exports.sealCrashRollbackSnapshot = sealCrashRollbackSnapshot;
module.exports.isRecoverableGovernanceDriftPath = isRecoverableGovernanceDriftPath;
