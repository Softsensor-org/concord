"use strict";

// COORD-154: read-only live-case adapter REFERENCE (Production MCP P3).
//
// This module is a GENERIC, REUSABLE *reference pattern* — a template adopters
// copy and OWN — for narrow, read-only production/staging "case" reads. It is
// deliberately domain-neutral: a "case-management read" is only the motivating
// shape (a case has an owner, a client, a status, some payload). coord-template
// ships the PATTERN; the adopter owns the real wiring (the actual MCP/tool call,
// the real endpoint, the real credentials).
//
// HARD NON-GOALS (enforced by tests):
//   - NO committed customer data.
//   - NO real production credentials.
//   - NO real endpoint / network call. This module NEVER touches the network.
//     The adopter injects a `fetchCase` reader; tests inject a synthetic one.
//
// WHAT THE PATTERN ENFORCES (the four rules from the P3 ticket):
//   1. REQUIRE narrowing filters — a read must be scoped by client + date +
//      entity. A missing/blank/wildcard filter is REFUSED (no broad dump).
//   2. REJECT broad dumps — wildcards ("*", "all", "%") and absent filters fail
//      closed BEFORE the reader is ever invoked.
//   3. REDACT sensitive fields — configured sensitive keys are masked/removed in
//      the emitted evidence; raw values never reach the evidence record.
//   4. EMIT compact JSON evidence + a RECEIPT via the COORD-152 receipt writer
//      so the result satisfies COORD-153 live-MCP lifecycle enforcement.
//
// REUSE, do not reinvent: receipts go through runtime-evidence.js
// (`normalizeLiveMcpReceipt` / `validateLiveMcpReceipt`, the COORD-152
// substrate). A read-only case read maps to operation_class `read_sensitive`
// (production case payloads are sensitive), so redaction is REQUIRED and the
// receipt is structurally identical to what COORD-153 expects on a live_mcp
// declaration.

const {
  normalizeLiveMcpReceipt,
  validateLiveMcpReceipt,
} = require("../runtime-evidence.js");

// Read-only case reads are sensitive by default (they touch production case
// payloads). read_sensitive => approval=human, redaction=required, no cleanup.
const DEFAULT_OPERATION_CLASS = "read_sensitive";

// Domain-neutral default set of sensitive field names to redact. Adopters
// extend this with their own field names (SSN, raw_payload, phone, ...). The
// names below are illustrative and generic — NOT tied to any real schema.
const DEFAULT_SENSITIVE_FIELDS = Object.freeze([
  "name",
  "full_name",
  "email",
  "phone",
  "address",
  "ssn",
  "dob",
  "raw_payload",
  "notes",
  "contact",
]);

// Values that signal an UNNARROWED / broad request. Any filter equal to one of
// these (case-insensitive) is rejected as a broad dump.
const BROAD_TOKENS = Object.freeze(["*", "%", "all", "any", "everything", "*.*"]);

// The narrowing filters every read MUST carry. Missing any one => refusal.
const REQUIRED_FILTERS = Object.freeze(["client", "date", "entity"]);

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isBroadToken(value) {
  const text = String(value).trim().toLowerCase();
  if (!text) return false;
  if (BROAD_TOKENS.includes(text)) return true;
  // A bare wildcard anywhere (e.g. "case-*", "2026-*") is treated as broad: a
  // narrow read must name a concrete client/date/entity, not a glob.
  return text.includes("*") || text.includes("%");
}

class BroadReadRefusedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BroadReadRefusedError";
    this.code = "broad_read_refused";
    this.details = details || {};
  }
}

// validateScope — pure. Throws BroadReadRefusedError unless the filters are
// present AND narrow. Returns the normalized (trimmed) filters on success.
function validateScope(filters) {
  const safe = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
  const missing = [];
  const broad = [];
  const normalized = {};
  for (const key of REQUIRED_FILTERS) {
    const value = safe[key];
    if (isBlank(value)) {
      missing.push(key);
      continue;
    }
    if (isBroadToken(value)) {
      broad.push(key);
      continue;
    }
    normalized[key] = String(value).trim();
  }
  if (missing.length || broad.length) {
    const reasons = [];
    if (missing.length) reasons.push(`missing required filter(s): ${missing.join(", ")}`);
    if (broad.length) reasons.push(`broad/wildcard filter(s) refused: ${broad.join(", ")}`);
    throw new BroadReadRefusedError(
      `Refusing broad live-case read — ${reasons.join("; ")}. ` +
        `A live read must be narrowed by ${REQUIRED_FILTERS.join(" + ")}.`,
      { missing, broad }
    );
  }
  return normalized;
}

// redactRecord — pure. Returns a shallow-redacted copy of a single case record.
// Sensitive keys are replaced with a stable masked marker (never the raw value,
// never a reversible hash of it). Non-sensitive scalars pass through; nested
// objects/arrays are summarized as "[redacted:object]" so no sensitive nested
// payload can leak through accidentally.
function redactRecord(record, sensitiveFields) {
  const sensitive = new Set((sensitiveFields || DEFAULT_SENSITIVE_FIELDS).map((f) => String(f).toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (sensitive.has(String(key).toLowerCase())) {
      out[key] = "[redacted]";
      continue;
    }
    if (value !== null && typeof value === "object") {
      // Don't emit nested raw structures — they may carry sensitive payloads.
      out[key] = Array.isArray(value) ? `[redacted:array(${value.length})]` : "[redacted:object]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

// buildCompactEvidence — pure. Turns redacted records into the compact JSON
// evidence record that gets embedded in the receipt and (optionally) written to
// disk by the adopter. "Compact" = a small, customer-safe summary: counts, the
// narrowing scope, and the redacted rows (already stripped of sensitive fields).
function buildCompactEvidence(scope, redactedRecords) {
  return {
    scope,
    record_count: redactedRecords.length,
    redacted: true,
    records: redactedRecords,
  };
}

// readLiveCase — the reference entry point.
//
// Inputs:
//   ticket        — governing ticket id (required; the read must map to a ticket)
//   adapter       — adapter name string (default "live-case-readonly")
//   filters       — { client, date, entity } narrowing scope (REQUIRED, narrow)
//   fetchCase     — adopter-injected reader: (normalizedFilters) => array of raw
//                   case records. THIS is where the adopter wires the real MCP
//                   tool call. The reference NEVER calls the network itself.
//   sensitiveFields — optional override list of field names to redact
//   approval      — approval evidence string (read_sensitive needs human approval)
//   operation     — operation name for the receipt (default "read_case")
//   recordReceipt — optional injection point for the COORD-152 receipt writer
//                   (defaults to normalizeLiveMcpReceipt; tests can pass through)
//
// Behavior:
//   - Validates + narrows scope (refuses broad dumps BEFORE reading).
//   - Invokes the injected reader with the normalized scope.
//   - Redacts sensitive fields out of every record.
//   - Builds compact JSON evidence.
//   - Normalizes a COORD-152 live-mcp receipt (operation_class=read_sensitive)
//     that embeds a one-line evidence pointer + the compact evidence inline, and
//     validates it via validateLiveMcpReceipt so it satisfies COORD-153.
//
// Returns { scope, evidence, receipt }. The receipt is ready to embed in a
// `live_mcp` plan declaration (as live_mcp.receipt) or to hand to
// `gov live-mcp-record` for on-disk persistence.
function readLiveCase(options = {}) {
  const ticket = options.ticket;
  if (isBlank(ticket)) {
    throw new Error("readLiveCase requires a governing ticket id.");
  }
  if (typeof options.fetchCase !== "function") {
    throw new Error(
      "readLiveCase requires an adopter-injected fetchCase reader. " +
        "coord-template ships the pattern; the adopter owns the real tool call."
    );
  }

  const adapter = isBlank(options.adapter) ? "live-case-readonly" : String(options.adapter).trim();
  const operation = isBlank(options.operation) ? "read_case" : String(options.operation).trim();
  const sensitiveFields = options.sensitiveFields || DEFAULT_SENSITIVE_FIELDS;

  // 1+2. REQUIRE narrowing filters / REJECT broad dumps (fails closed here).
  const scope = validateScope(options.filters);

  // Invoke the adopter reader only after the scope is proven narrow.
  const rawRecords = options.fetchCase(scope) || [];
  if (!Array.isArray(rawRecords)) {
    throw new Error("fetchCase must return an array of case records.");
  }

  // 3. REDACT sensitive fields.
  const redactedRecords = rawRecords.map((r) => redactRecord(r, sensitiveFields));

  // 4. EMIT compact JSON evidence.
  const evidence = buildCompactEvidence(scope, redactedRecords);

  // Compact, customer-safe scope string for the receipt.
  const scopeText = `client=${scope.client} date=${scope.date} entity=${scope.entity}`;
  const evidenceLine =
    `${operation}: ${evidence.record_count} record(s), sensitive fields redacted ` +
    `(${(Array.isArray(sensitiveFields) ? sensitiveFields : DEFAULT_SENSITIVE_FIELDS).length} field rules)`;

  const normalize = typeof options.recordReceipt === "function" ? options.recordReceipt : normalizeLiveMcpReceipt;

  // Build a COORD-152 receipt. read_sensitive => approval + redaction required.
  const receipt = normalize(ticket, {
    adapter,
    operationClass: DEFAULT_OPERATION_CLASS,
    operation,
    scope: scopeText,
    redaction: `masked/removed sensitive fields and nested payloads (${evidence.record_count} record(s))`,
    approval: isBlank(options.approval)
      ? "ticket-scoped read approval pending — adopter records the human approver"
      : String(options.approval).trim(),
    evidence: [evidenceLine],
    meta: [`record_count=${evidence.record_count}`, "redacted=true"],
    receiptResult: "observed",
  });

  // Belt-and-suspenders: confirm the receipt satisfies COORD-152 validation so a
  // misconfigured adopter fails here, not at the COORD-153 closeout gate.
  validateLiveMcpReceipt(receipt);

  return { scope, evidence, receipt };
}

module.exports = {
  DEFAULT_OPERATION_CLASS,
  DEFAULT_SENSITIVE_FIELDS,
  REQUIRED_FILTERS,
  BroadReadRefusedError,
  validateScope,
  redactRecord,
  buildCompactEvidence,
  readLiveCase,
};
