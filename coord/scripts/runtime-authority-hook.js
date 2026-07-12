#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { createEnvelope, deriveSubagentEnvelope, evaluateToolCall, finishSubagent, registerSubagent } = require("./runtime-authority.js");
const { appendEntry } = require("./auto-mode-ledger.js");

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function parse(value) { try { return JSON.parse(value); } catch { return {}; } }
function resolveCoordDir() {
  if (process.env.COORD_CANONICAL_DIR) return path.resolve(process.env.COORD_CANONICAL_DIR);
  for (const candidate of [process.cwd(), __dirname]) {
    const marker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;
    const index = candidate.indexOf(marker);
    if (index >= 0) return candidate.slice(0, index + `${path.sep}coord`.length);
  }
  return path.resolve(__dirname, "..");
}
function findLock(coordDir) {
  const dir = path.join(coordDir, ".runtime", "locks");
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".lock")).sort()) {
    const lock = parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    if (lock.status === "doing" && lock.worktree && (process.cwd() === lock.worktree || process.cwd().startsWith(`${lock.worktree}${path.sep}`))) return lock;
  }
  return null;
}

const payload = { ...parse(process.env.TOOL_INPUT || "{}"), ...parse(readStdin()) };
const root = resolveCoordDir();
const lock = findLock(root);
if (!lock) process.exit(0);
const envelope = createEnvelope({ ticket: lock.ticket, session: lock.session_id, provider: process.env.COORD_PROVIDER || "claude", worktree: lock.worktree, coverage: "partial" });
const supervisor = path.join(root, ".runtime", "subagents", `${lock.ticket}.json`);
const ledger = path.join(root, ".runtime", "action-ledgers", `${lock.ticket}.ndjson`);
fs.mkdirSync(path.dirname(ledger), { recursive: true });
if (process.argv.includes("--subagent-start")) {
  const session = String(payload.agent_id || payload.session_id || "").trim();
  if (!session) {
    process.stderr.write("CONCORD DENY: subagent start has no stable identity.\n");
    process.exit(2);
  }
  const child = deriveSubagentEnvelope(envelope, { session });
  registerSubagent(supervisor, envelope, child);
  appendEntry(ledger, { type: "subagent_start", ticket: lock.ticket, parent_session: envelope.session, actor_session: session, envelope_digest: child.digest });
  process.exit(0);
}
if (process.argv.includes("--subagent-stop")) {
  const session = String(payload.agent_id || payload.session_id || "").trim();
  const summary = String(payload.last_assistant_message || payload.summary || "").trim();
  try {
    finishSubagent(supervisor, session, { explained: Boolean(summary), action_digest: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
    appendEntry(ledger, { type: "subagent_stop", ticket: lock.ticket, parent_session: envelope.session, actor_session: session, explained: Boolean(summary) });
  } catch (error) {
    process.stderr.write(`CONCORD DENY: ${error.message}.\n`);
    process.exit(2);
  }
  process.exit(0);
}
const report = evaluateToolCall(envelope, payload);
appendEntry(ledger, { type: "action", ticket: lock.ticket, action_id: payload.tool_use_id || `${Date.now()}-${process.pid}`, parent_session: envelope.session, actor_session: payload.agent_id || envelope.session, tool: payload.tool_name || payload.tool || "unknown", decision: report.decision, reason: report.reason, envelope_digest: envelope.digest });
if (report.decision === "deny") {
  process.stderr.write(`CONCORD DENY: ${report.reason}. Ticket authority is fixed to ${lock.worktree}.\n`);
  process.exit(2);
}
