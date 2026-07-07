"use strict";

// COORD-140: [Memory] Phase 0 — decision-record extractor.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §3 (the Decision layer) this module
// performs a CHEAP TRANSFORM of fields the plan-record validator already
// requires — it does NOT infer anything with a model. For every canonical plan
// record (coord/.runtime/plans/<TICKET>.json) it extracts the "why it happened"
// fields:
//   - requirement_closure  -> ticket_ask / implemented / not_implemented /
//                             deferred_to / verdict
//   - self_review_cycles   -> per-cycle lens / risks / findings / verdict
//   - critical_invariants  -> the truths the change had to preserve
// and emits one decision record per line into coord/memory/decisions.ndjson.
//
// PROVENANCE (the Concord edge, §2 + §7). Each decision record pins a citation
// back to its hash-linked source:
//   - source_plan        the relative path to the canonical plan record
//   - event_hash         the canonical hash (sha1 of the verbatim stored journal
//                        line) of the LATEST journal event for this ticket, or
//                        null when the ticket has no journal event
//   - chain_head         the canonical hash of the LAST stored journal event
//                        (the whole-chain anchor the conformance attestation
//                        signs, §2)
//   - verified           true when the cited event is part of the verified
//                        hash-chain (carries a non-empty prev_event_hash);
//                        false for legacy pre-chain events (§6 principle 3:
//                        chained-and-attested outranks legacy-unverified).
// This is exactly the citation shape §7's `gov recall` contract expects, so
// Phase 1 (COORD-141) can consume decisions.ndjson directly.
//
// DERIVED + REBUILDABLE (§6 principle 1). decisions.ndjson is a derived view; the
// raw truth stays in the plan records + journal. `--rebuild` regenerates it
// deterministically from source (records sorted by ticket id; stable key order;
// no wall-clock in the output), so two rebuilds are byte-identical. The real
// output is gitignored like other coord/.runtime-style derived artifacts; only
// this generator + a small fixture are committed. Losing decisions.ndjson loses
// no authority.
//
// EXPLICIT NON-GOAL (§10). No retrieval, no recall surface, no vectors, no
// summaries — those are COORD-141..143. This module ONLY extracts + cites.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_OUTPUT_PATH = path.join(COORD_DIR, "memory", "decisions.ndjson");

// --- provenance: journal hashing (mirrors journal.js exactly) --------------
// The on-disk journal line is itself canonical (the exact string produced by
// JSON.stringify(record) at append time), so the canonical event hash is the
// sha1 of the verbatim stored line. We re-implement only this one-line hash so
// the extractor stays a zero-dependency leaf module; it is the same function as
// journal.js `hashGovernanceEventLine`.
function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

// COORD-289: SHA-256 companion for the SHA-256 journal era. Post-migration events
// carry `hash_alg: "sha256"`, so their cited line hash must be sha256 of the
// verbatim stored line (matching journal.js's era-aware hashing); pre-migration
// events keep the implicit sha1 citation byte-for-byte.
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Hash a verbatim journal line under the algorithm named by the record's
// `hash_alg` field (sha256 once migrated, else sha1).
function hashLineForRecord(line, record) {
  return record && record.hash_alg === "sha256" ? sha256(line) : sha1(line);
}

// Read the journal once and index, per ticket, the LATEST event's canonical
// hash + whether that event is part of the verified hash-chain. Also return the
// chain head (hash of the last stored event overall). Missing/empty journal is
// tolerated (graceful skip): every ticket then cites event_hash=null,
// verified=false.
function indexJournalProvenance(journalPath) {
  const index = new Map();
  let chainHead = null;
  if (!fs.existsSync(journalPath)) {
    return { index, chainHead };
  }
  const raw = fs.readFileSync(journalPath, "utf8");
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      // A malformed line cannot be cited; skip it rather than throw so the
      // extractor never fails closed on journal scratch state.
      continue;
    }
    // COORD-289: cite under the event's era (sha256 post-migration, sha1 pre).
    const eventHash = hashLineForRecord(trimmed, record);
    chainHead = eventHash;
    const ticket = record && typeof record.ticket === "string" ? record.ticket : null;
    if (!ticket) {
      continue;
    }
    const verified =
      typeof record.prev_event_hash === "string" && record.prev_event_hash.length > 0;
    // Keep the LATEST event for the ticket (last write wins as we walk in order).
    index.set(ticket, { event_hash: eventHash, verified });
  }
  return { index, chainHead };
}

// --- requirement_closure parsing -------------------------------------------
// requirement_closure is an array of "Label: value" strings (see
// plan-records.js PLAN_SCAFFOLD_LIST_VALUES.requirement_closure). We pull the
// labelled fields out. Scaffold/placeholder lines ("TODO: ...") are dropped so a
// freshly-started, unworked ticket contributes no fake decision.
function isScaffoldLine(value) {
  return String(value || "").trim().toUpperCase().startsWith("TODO");
}

// requirement_closure is APPEND-ONLY: set-requirement-closure appends a fresh
// "Ticket ask / Implemented / Not implemented / Deferred to / Closeout verdict"
// block on every (re-)closure rather than replacing the old one (COORD-198). A
// takeover / re-closure therefore leaves BOTH the superseded block (e.g.
// "Closeout verdict: partial") and the newer block ("Closeout verdict: complete")
// in the ordered array. The DERIVED verdict/debt signals must respect verdict
// RECENCY: the LAST occurrence of a labelled line wins, so a partial verdict
// later superseded by a complete one reads as complete, and a "Not implemented: X"
// later superseded by "Not implemented: none" reads as none. Older lines stay in
// the record as history — only this derived read uses recency. We therefore scan
// the ordered list and keep the LAST match, not the first.
function matchLabel(entries, label) {
  const lowered = label.toLowerCase();
  let found = null;
  for (const entry of entries) {
    const text = String(entry || "").trim();
    if (isScaffoldLine(text)) {
      continue;
    }
    const idx = text.toLowerCase().indexOf(lowered + ":");
    if (idx === 0) {
      found = text.slice(label.length + 1).trim();
    }
  }
  return found;
}

// A "none"-class closure value: the field is present but carries NO real debt.
// The canonical scaffold writes the bare token "none", but a human/agent closeout
// frequently writes "none — full acceptance bar met" or "none, nothing deferred"
// (COORD-197 is the live example). All of these MEAN none, so the derived
// not-implemented / deferred carve-out signals must treat a leading "none" token
// (followed by end-of-string or a non-word separator like a dash, em-dash, comma,
// or colon) as none. Without this, a recency-correct verdict that landed at
// "Not implemented: none — ..." would still be mis-flagged as a carve-out.
// Shared so closeout-summary + insight-reports interpret "none" identically.
function isNoneClosureValue(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return true;
  }
  return /^none\b/.test(text) && !/^none\w/.test(text);
}

// Pull every "COORD-123"-style ticket id out of a free-text deferred-to value.
function extractTicketIds(text) {
  const ids = String(text || "").match(/\b[A-Z]+-\d+\b/g) || [];
  return [...new Set(ids)];
}

// Some historical records crammed several "Label: value" pairs into a single
// array element separated by embedded newlines. Flatten on newlines so each
// labelled pair is matchable independently, while preserving genuinely
// multi-line single values (they simply stay grouped under their label).
function flattenClosureEntries(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const piece of String(entry || "").split("\n")) {
      const trimmed = piece.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function parseRequirementClosure(entries) {
  const list = flattenClosureEntries(entries).filter((e) => !isScaffoldLine(e));
  const deferredToRaw = matchLabel(list, "Deferred to");
  const verdictRaw = matchLabel(list, "Closeout verdict");
  const notImplementedRaw = matchLabel(list, "Not implemented");
  return {
    ticket_ask: matchLabel(list, "Ticket ask"),
    implemented: matchLabel(list, "Implemented"),
    not_implemented: notImplementedRaw,
    // Recency-correct (COORD-198): true when the LATEST "Not implemented:" line
    // carries no real carve-out — either absent or a "none"-class value (bare
    // "none" or "none — ..."). Consumers should gate the not-implemented carve-out
    // signal on this rather than an exact === "none" check so a re-closure that
    // landed complete is not mis-flagged as debt.
    not_implemented_is_none: notImplementedRaw == null || isNoneClosureValue(notImplementedRaw),
    deferred_to: deferredToRaw,
    deferred_to_is_none: deferredToRaw == null || isNoneClosureValue(deferredToRaw),
    deferred_to_tickets:
      deferredToRaw && !isNoneClosureValue(deferredToRaw)
        ? extractTicketIds(deferredToRaw)
        : [],
    verdict: verdictRaw ? verdictRaw.toLowerCase() : null,
    present: list.length > 0,
  };
}

function parseSelfReviewCycles(cycles) {
  if (!Array.isArray(cycles)) {
    return [];
  }
  return cycles
    .filter((cycle) => cycle && typeof cycle === "object")
    // Drop scaffold-only cycles (raw still carries the TODO placeholder).
    .filter((cycle) => !String(cycle.raw || "").toLowerCase().includes("todo"))
    .map((cycle) => ({
      lens: cycle.lens || null,
      risks: Array.isArray(cycle.risks)
        ? cycle.risks.map((r) => String(r).trim()).filter(Boolean)
        : [],
      findings: cycle.findings || null,
      verdict: cycle.verdict ? String(cycle.verdict).toLowerCase() : null,
    }));
}

function cleanInvariants(invariants) {
  if (!Array.isArray(invariants)) {
    return [];
  }
  return invariants.map((i) => String(i).trim()).filter((i) => i && !isScaffoldLine(i));
}

const DECISION_OBJECT_SCHEMA_VERSION = "continuity-decision-object/v1";

const DECISION_OBJECT_FIELDS = Object.freeze([
  "id",
  "status",
  "type",
  "subject",
  "question",
  "why_now",
  "options",
  "recommendation",
  "owner",
  "needed_by",
  "resolution",
  "sources",
  "supersession",
  "linked",
]);

const OPEN_DECISION_STATUSES = new Set(["open", "proposed", "pending", "needs_decision"]);
const RESOLVED_DECISION_STATUSES = new Set(["resolved", "accepted", "rejected", "deferred"]);

function cleanString(value) {
  const text = String(value == null ? "" : value).trim();
  return text || null;
}

function cleanStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function normalizeDecisionOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => {
      if (typeof option === "string") {
        return { id: null, label: option.trim(), tradeoffs: [] };
      }
      if (!option || typeof option !== "object") {
        return null;
      }
      return {
        id: cleanString(option.id),
        label: cleanString(option.label || option.name || option.option),
        tradeoffs: cleanStringList(option.tradeoffs || option.risks || option.notes),
      };
    })
    .filter((option) => option && option.label);
}

function normalizeDecisionSources(sources) {
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources
    .map((source) => {
      if (typeof source === "string") {
        return { type: "ref", ref: source.trim() };
      }
      if (!source || typeof source !== "object") {
        return null;
      }
      return {
        type: cleanString(source.type) || "ref",
        ref: cleanString(source.ref || source.path || source.url || source.id),
        note: cleanString(source.note),
      };
    })
    .filter((source) => source && source.ref);
}

function normalizeDecisionSupersession(supersession) {
  const input = supersession && typeof supersession === "object" ? supersession : {};
  return {
    supersedes: cleanStringList(input.supersedes),
    superseded_by: cleanString(input.superseded_by),
    reason: cleanString(input.reason),
  };
}

function normalizeDecisionLinked(linked) {
  const input = linked && typeof linked === "object" ? linked : {};
  return {
    tickets: cleanStringList(input.tickets),
    cadences: cleanStringList(input.cadences),
  };
}

function normalizeDecisionResolution(resolution) {
  const input = resolution && typeof resolution === "object" ? resolution : {};
  return {
    answer: cleanString(input.answer),
    decided_at: cleanString(input.decided_at),
    decided_by: cleanString(input.decided_by),
    durable: Boolean(input.durable),
    promote_to: cleanStringList(input.promote_to),
    notes: cleanString(input.notes),
  };
}

function normalizeDecisionObject(decision, index = 0, fallbackTicketId = null) {
  if (!decision || typeof decision !== "object") {
    return null;
  }

  const id = cleanString(decision.id) || (fallbackTicketId ? `${fallbackTicketId}-D${index + 1}` : null);
  const statusRaw = (cleanString(decision.status) || "open").toLowerCase();
  const question = cleanString(decision.question);
  const subject = cleanString(decision.subject);
  if (!id || !question) {
    return null;
  }

  const linked = normalizeDecisionLinked(decision.linked || {
    tickets: decision.linked_tickets,
    cadences: decision.linked_cadences,
  });
  if (fallbackTicketId && linked.tickets.length === 0) {
    linked.tickets = [fallbackTicketId];
  }

  const resolution = normalizeDecisionResolution(decision.resolution);
  const resolved = RESOLVED_DECISION_STATUSES.has(statusRaw) || Boolean(resolution.answer);
  const status = resolved && OPEN_DECISION_STATUSES.has(statusRaw) ? "resolved" : statusRaw;
  const open = OPEN_DECISION_STATUSES.has(status) && !resolved;
  const scopeKind = open && (linked.tickets.length > 0 || linked.cadences.length > 0)
    ? "scoped_risky_work"
    : "none";

  return {
    schema_version: DECISION_OBJECT_SCHEMA_VERSION,
    id,
    status,
    type: cleanString(decision.type) || "operational",
    subject,
    question,
    why_now: cleanString(decision.why_now),
    options: normalizeDecisionOptions(decision.options),
    recommendation: cleanString(decision.recommendation),
    owner: cleanString(decision.owner),
    needed_by: cleanString(decision.needed_by),
    resolution,
    sources: normalizeDecisionSources(decision.sources),
    supersession: normalizeDecisionSupersession(decision.supersession),
    linked,
    blocking: {
      unresolved_blocks: scopeKind,
      rationale: open
        ? "Open decision is advisory for warm-start and blocks only risky work in its linked ticket/cadence scope."
        : "Resolved or non-open decision does not block execution.",
    },
  };
}

function normalizeDecisionObjects(planRecord) {
  const raw = Array.isArray(planRecord.decision_objects)
    ? planRecord.decision_objects
    : Array.isArray(planRecord.operational_decisions)
      ? planRecord.operational_decisions
      : [];
  return raw
    .map((decision, index) => normalizeDecisionObject(decision, index, planRecord.ticket_id))
    .filter(Boolean);
}

function decisionMatchesScope(decision, scope = {}) {
  const linked = decision.linked || {};
  if (scope.ticket_id && Array.isArray(linked.tickets) && linked.tickets.includes(scope.ticket_id)) {
    return true;
  }
  if (scope.cadence && Array.isArray(linked.cadences) && linked.cadences.includes(scope.cadence)) {
    return true;
  }
  return !scope.ticket_id && !scope.cadence;
}

function selectWarmStartDecisionObjects(decisionRecords, scope = {}) {
  const out = [];
  for (const record of Array.isArray(decisionRecords) ? decisionRecords : []) {
    for (const decision of record.decision_objects || []) {
      if (OPEN_DECISION_STATUSES.has(decision.status) && decisionMatchesScope(decision, scope)) {
        out.push(decision);
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function selectResolvedDurableDecisionObjects(decisionRecords) {
  const out = [];
  for (const record of Array.isArray(decisionRecords) ? decisionRecords : []) {
    for (const decision of record.decision_objects || []) {
      const promotes = decision.resolution && decision.resolution.promote_to;
      if (
        RESOLVED_DECISION_STATUSES.has(decision.status) &&
        decision.resolution &&
        (decision.resolution.durable || (Array.isArray(promotes) && promotes.length > 0))
      ) {
        out.push(decision);
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function decisionBlocksScopedRiskyWork(decision, scope = {}) {
  if (!decision || !OPEN_DECISION_STATUSES.has(decision.status)) {
    return false;
  }
  if (!decisionMatchesScope(decision, scope)) {
    return false;
  }
  return Boolean(scope.risky) && decision.blocking && decision.blocking.unresolved_blocks === "scoped_risky_work";
}

// Build the decision record for one plan record. Returns null when the record
// carries no real decision content (pure scaffold / unworked ticket) so the
// derived view never asserts an uncited or empty decision.
function buildDecisionRecord(planRecord, sourcePlanRel, provenanceIndex, chainHead) {
  if (!planRecord || typeof planRecord !== "object") {
    return null;
  }
  const ticketId = planRecord.ticket_id;
  if (!ticketId) {
    return null;
  }
  const closure = parseRequirementClosure(planRecord.requirement_closure);
  const selfReview = parseSelfReviewCycles(planRecord.self_review_cycles);
  const invariants = cleanInvariants(planRecord.critical_invariants);
  const decisionObjects = normalizeDecisionObjects(planRecord);

  const hasContent =
    Boolean(closure.ticket_ask || closure.implemented) ||
    selfReview.length > 0 ||
    invariants.length > 0 ||
    decisionObjects.length > 0;
  if (!hasContent) {
    return null;
  }

  const prov = provenanceIndex.get(ticketId) || { event_hash: null, verified: false };

  const record = {
    ticket_id: ticketId,
    requirement_closure: {
      ticket_ask: closure.ticket_ask,
      implemented: closure.implemented,
      not_implemented: closure.not_implemented,
      // COORD-198: the recency-correct none-class flag travels with the derived
      // record so downstream consumers of decisions.ndjson interpret a re-closure's
      // latest "Not implemented: none — ..." as no carve-out, the SAME way the
      // closeout/insight in-process parse does.
      not_implemented_is_none: closure.not_implemented_is_none,
      deferred_to: closure.deferred_to,
      deferred_to_is_none: closure.deferred_to_is_none,
      deferred_to_tickets: closure.deferred_to_tickets,
      verdict: closure.verdict,
    },
    self_review: selfReview,
    critical_invariants: invariants,
    source: {
      type: "decision",
      id: ticketId,
      path: sourcePlanRel,
      event_hash: prov.event_hash,
      chain_head: chainHead,
      verified: prov.verified,
    },
  };
  if (decisionObjects.length > 0) {
    record.decision_objects = decisionObjects;
  }
  return record;
}

// stableStringify: deterministic key order so rebuilds are byte-identical and
// diffs are reviewable.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function listPlanRecordFiles(plansDir) {
  if (!fs.existsSync(plansDir)) {
    return [];
  }
  return fs
    .readdirSync(plansDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(plansDir, name));
}

// extractDecisions: pure function — reads sources, returns the ordered array of
// decision records. Deterministic: plan records are processed in sorted-filename
// order and the output carries no wall-clock timestamp.
function extractDecisions(options = {}) {
  const plansDir = options.plansDir || DEFAULT_PLANS_DIR;
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const rootDir = options.rootDir || ROOT_DIR;
  const { index, chainHead } = indexJournalProvenance(journalPath);

  const decisions = [];
  for (const file of listPlanRecordFiles(plansDir)) {
    let planRecord;
    try {
      planRecord = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      continue;
    }
    const sourcePlanRel = path.relative(rootDir, file).split(path.sep).join("/");
    const record = buildDecisionRecord(planRecord, sourcePlanRel, index, chainHead);
    if (record) {
      decisions.push(record);
    }
  }
  // Already sorted by filename, but pin the ticket-id order explicitly so the
  // contract is independent of filesystem readdir behavior.
  decisions.sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
  return decisions;
}

function serializeDecisions(decisions) {
  if (decisions.length === 0) {
    return "";
  }
  return `${decisions.map(stableStringify).join("\n")}\n`;
}

function rebuild(options = {}) {
  const decisions = extractDecisions(options);
  const outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serializeDecisions(decisions), "utf8");
  return { outputPath, count: decisions.length };
}

module.exports = {
  sha1,
  indexJournalProvenance,
  isNoneClosureValue,
  parseRequirementClosure,
  parseSelfReviewCycles,
  cleanInvariants,
  DECISION_OBJECT_SCHEMA_VERSION,
  DECISION_OBJECT_FIELDS,
  OPEN_DECISION_STATUSES,
  RESOLVED_DECISION_STATUSES,
  normalizeDecisionObject,
  normalizeDecisionObjects,
  selectWarmStartDecisionObjects,
  selectResolvedDurableDecisionObjects,
  decisionBlocksScopedRiskyWork,
  buildDecisionRecord,
  stableStringify,
  serializeDecisions,
  extractDecisions,
  rebuild,
  DEFAULT_PLANS_DIR,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_OUTPUT_PATH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--rebuild" || cmd === "rebuild") {
    const { outputPath, count } = rebuild();
    process.stdout.write(
      `Rebuilt ${path.relative(ROOT_DIR, outputPath)} — ${count} decision record(s).\n`
    );
  } else if (cmd === "--print" || cmd === "print") {
    process.stdout.write(serializeDecisions(extractDecisions()));
  } else {
    process.stdout.write(
      [
        "coord/scripts/decision-extractor.js — Phase 0 decision-record extractor (COORD-140).",
        "",
        "Usage:",
        "  node coord/scripts/decision-extractor.js --rebuild   regenerate coord/memory/decisions.ndjson (derived)",
        "  node coord/scripts/decision-extractor.js --print     write the derived records to stdout",
        "",
        "decisions.ndjson is a DERIVED, REBUILDABLE view of plan records + journal provenance.",
        "Raw truth stays in coord/.runtime/plans + the journal. No retrieval/recall here (COORD-141).",
        "",
      ].join("\n")
    );
  }
}
