"use strict";

const fs = require("node:fs");

const DEFAULT_JOURNAL_RETENTION_POLICY = Object.freeze({
  policy_path: "coord/product/JOURNAL_RETENTION_POLICY.md",
  warning_events: 5000,
  critical_events: 25000,
  warning_bytes: 5 * 1024 * 1024,
  critical_bytes: 25 * 1024 * 1024,
});

function integerOrZero(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function readFileSize(path, statSync = fs.statSync) {
  if (!path) {
    return 0;
  }
  try {
    return integerOrZero(statSync(path).size);
  } catch {
    return 0;
  }
}

function summarizeChain(chain = {}) {
  const chainHead =
    chain.chainHead ||
    chain.head ||
    chain.latestEventHash ||
    chain.latest_event_hash ||
    chain.lastEventHash ||
    null;
  const chainHeadAlg =
    chain.chainHeadAlg ||
    chain.hashAlg ||
    chain.eventHashAlg ||
    chain.alg ||
    null;
  return {
    ok: chain.ok !== false,
    chained_events: integerOrZero(chain.chainedCount ?? chain.chained_events),
    pre_chain_events: integerOrZero(chain.preChainCount ?? chain.pre_chain_events),
    broken_events: Array.isArray(chain.broken) ? chain.broken.length : 0,
    chain_head: chainHead,
    chain_head_alg: chainHeadAlg,
  };
}

function classifyJournalHealth({ eventCount, bytes, chain, policy }) {
  const warnings = [];
  let status = "ok";

  function flag(level, message) {
    warnings.push({ level, message });
    if (level === "critical") {
      status = "critical";
    } else if (status === "ok") {
      status = "warning";
    }
  }

  if (!chain.ok || chain.broken_events > 0) {
    flag("critical", "journal hash-chain verification is not clean");
  }
  if (eventCount >= policy.critical_events) {
    flag("critical", `journal event count ${eventCount} exceeds critical threshold ${policy.critical_events}`);
  } else if (eventCount >= policy.warning_events) {
    flag("warning", `journal event count ${eventCount} exceeds warning threshold ${policy.warning_events}`);
  }
  if (bytes >= policy.critical_bytes) {
    flag("critical", `journal byte size ${bytes} exceeds critical threshold ${policy.critical_bytes}`);
  } else if (bytes >= policy.warning_bytes) {
    flag("warning", `journal byte size ${bytes} exceeds warning threshold ${policy.warning_bytes}`);
  }

  return { status, warnings };
}

function buildJournalHealthReport(options = {}) {
  const {
    journalPath,
    readGovernanceEventLog,
    verifyGovernanceChain,
    statSync = fs.statSync,
    policy = DEFAULT_JOURNAL_RETENTION_POLICY,
  } = options;

  const events = typeof readGovernanceEventLog === "function" ? readGovernanceEventLog() : [];
  const eventCount = Array.isArray(events) ? events.length : 0;
  const chain = summarizeChain(typeof verifyGovernanceChain === "function" ? verifyGovernanceChain() : {});
  const bytes = readFileSize(journalPath, statSync);
  const { status, warnings } = classifyJournalHealth({ eventCount, bytes, chain, policy });

  return {
    status,
    event_count: eventCount,
    bytes,
    ...chain,
    warnings,
    policy,
    rotation: {
      required: status === "critical",
      recommended: status !== "ok",
      policy_path: policy.policy_path,
      chain_continuity_required: true,
      frozen_fixture_required: true,
    },
  };
}

function formatJournalHealthWarning(report) {
  if (!report || report.status === "ok") {
    return null;
  }
  const warningText = (report.warnings || [])
    .map((warning) => warning.message || String(warning))
    .filter(Boolean)
    .join("; ");
  const chainText = report.chain_head
    ? ` chain head ${report.chain_head_alg ? `${report.chain_head_alg}:` : ""}${report.chain_head}.`
    : "";
  return (
    `[journal-retention] ${report.status}: ${warningText || "journal retention threshold reached"}. ` +
    `${report.event_count} event(s), ${report.bytes} byte(s). ` +
    `Use ${report.policy?.policy_path || DEFAULT_JOURNAL_RETENTION_POLICY.policy_path} for rotation/compaction rules; ` +
    `verify-engine + seal must pass after any rotation.${chainText}`
  );
}

module.exports = {
  DEFAULT_JOURNAL_RETENTION_POLICY,
  buildJournalHealthReport,
  classifyJournalHealth,
  formatJournalHealthWarning,
  summarizeChain,
};
