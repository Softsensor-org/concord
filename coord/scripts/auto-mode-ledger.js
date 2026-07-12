"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { canonicalJson } = require("./auto-mode-policy.js");

const SENSITIVE_KEY = /(?:token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)/i;

function redact(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  }
  return value;
}

function entryHash(entry) {
  const unsigned = { ...entry };
  delete unsigned.hash;
  return crypto.createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function createEntry(input, previous = null) {
  const entry = redact({
    schema: "coord.auto-mode.ledger/v1",
    sequence: previous ? previous.sequence + 1 : 1,
    previous_hash: previous ? previous.hash : null,
    ...input,
  });
  return { ...entry, hash: entryHash(entry) };
}

function appendEntry(file, input) {
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
    const existing = readLedger(file);
    const entry = createEntry(input, existing.at(-1) || null);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return entry;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      fs.rmSync(lock, { force: true });
    }
  }
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function verifyLedger(entries) {
  const issues = [];
  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1) issues.push(`sequence mismatch at ${index + 1}`);
    const expectedPrevious = index === 0 ? null : entries[index - 1].hash;
    if (entry.previous_hash !== expectedPrevious) issues.push(`previous hash mismatch at ${index + 1}`);
    if (entry.hash !== entryHash(entry)) issues.push(`entry hash mismatch at ${index + 1}`);
  });
  return { ok: issues.length === 0, issues };
}

function reconcile(entries, observed) {
  const verification = verifyLedger(entries);
  const recordedIds = new Set(entries.filter((entry) => entry.type === "action").map((entry) => entry.action_id));
  const observedIds = new Set((observed.actions || []).map((action) => action.id));
  const missing = [...observedIds].filter((id) => !recordedIds.has(id));
  const unexplained = [...recordedIds].filter((id) => !observedIds.has(id));
  const declaredCoverage = observed.coverage || "unmanaged";
  const coverage = verification.ok && missing.length === 0 && unexplained.length === 0 && declaredCoverage === "complete"
    ? "complete"
    : declaredCoverage === "unmanaged" ? "unmanaged" : "partial";
  return { ok: verification.ok && missing.length === 0 && unexplained.length === 0, coverage, missing, unexplained, chain_issues: verification.issues };
}

function assertAuditComplete(report) {
  if (!report || !report.ok || report.coverage !== "complete") throw new Error("audit evidence is not complete");
  return true;
}

module.exports = { appendEntry, assertAuditComplete, createEntry, entryHash, readLedger, reconcile, redact, verifyLedger };
