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
    const eventHash = sha1(trimmed);
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

function matchLabel(entries, label) {
  const lowered = label.toLowerCase();
  for (const entry of entries) {
    const text = String(entry || "").trim();
    if (isScaffoldLine(text)) {
      continue;
    }
    const idx = text.toLowerCase().indexOf(lowered + ":");
    if (idx === 0) {
      return text.slice(label.length + 1).trim();
    }
  }
  return null;
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
  return {
    ticket_ask: matchLabel(list, "Ticket ask"),
    implemented: matchLabel(list, "Implemented"),
    not_implemented: matchLabel(list, "Not implemented"),
    deferred_to: deferredToRaw,
    deferred_to_tickets:
      deferredToRaw && deferredToRaw.toLowerCase() !== "none"
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

  const hasContent =
    Boolean(closure.ticket_ask || closure.implemented) ||
    selfReview.length > 0 ||
    invariants.length > 0;
  if (!hasContent) {
    return null;
  }

  const prov = provenanceIndex.get(ticketId) || { event_hash: null, verified: false };

  return {
    ticket_id: ticketId,
    requirement_closure: {
      ticket_ask: closure.ticket_ask,
      implemented: closure.implemented,
      not_implemented: closure.not_implemented,
      deferred_to: closure.deferred_to,
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
  parseRequirementClosure,
  parseSelfReviewCycles,
  cleanInvariants,
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
