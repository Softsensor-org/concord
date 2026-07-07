"use strict";

// COORD-149: [Memory] Solving — auto evidence-backed CLOSEOUT SUMMARIES.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §4 ("Solving — all layers") this module
// AUTO-PRODUCES, for a landed/closing ticket, a closeout summary that is GROUNDED
// in that ticket's REAL artifacts — its journal events, its plan record, its
// source commit(s) / landing record, its repo-gate results, its review cycles,
// and any conformance attestation — so a closeout is EVIDENCE-BACKED rather than
// model-asserted. It is the bookend to the COORD-148 pre-work pack: the pre-work
// pack opens a ticket with cited prior context, this closes it with cited proof.
//
// It COMPOSES the landed substrate — it does NOT re-implement provenance or
// parsing:
//   - COORD-140 decision-extractor.js -> the canonical sha1 + journal-provenance
//     indexer + requirement_closure / self_review parsing. One canonical-hash
//     implementation flows through decisions/recall/insights/prework AND here, so
//     every citation pins event_hash + chain_head + verified the SAME way.
//   - COORD-147 insight-reports.js     -> readJournalEvents (the ordered, hashed
//     event list + chain head) is reused verbatim as the operational-layer source.
//
// THE SUMMARY — sections, EVERY claim SOURCE-CITED (§5):
//   1. ask_and_delivered   — what was asked + what was delivered, grounded in the
//                            plan record's requirement_closure (ticket_ask /
//                            implemented / not_implemented / verdict). Cited to the
//                            plan path + chain_head.
//   2. evidence_trail      — the proof the work happened + passed:
//                              * repo_gate results (plan repo_gates) — cited to plan.
//                              * review cycles (lens + verdict) — cited to plan.
//                              * source commit(s) / landing record — the journal
//                                commit + move-review + mark-done events, cited to
//                                their event_hash (verified by the hash chain).
//                              * conformance attestation, IF one anchors a chain
//                                head at/after the ticket landed — cited to the
//                                attestation file + its signed subject digest.
//   3. decisions           — key decisions + deferrals: the requirement_closure
//                            deferred_to follow-ups + not_implemented carve-outs +
//                            the self_review findings, each cited to the plan record.
//
// HARD GUARDRAIL (§5) — RECOMMENDS / REPORTS ONLY. The summary:
//   - is stamped { authority:false, recommends_only:true };
//   - NEVER closes, gates, finalizes, or mutates the ticket — closeout stays
//     governed by the normal finalize lane. It is an EVIDENCE ARTIFACT generated
//     as part of / after closeout, not an authority.
//   - is a PURE READ over already-committed artifacts (journal / plan / board /
//     attestations);
//   - emits NO uncited claim: a section claim with empty citations is NEVER
//     emitted — assertable via uncitedClaims(). If a claim cannot be grounded in
//     an artifact it does not appear (e.g. no attestation -> that evidence is
//     absent, NOT fabricated).
//
// DETERMINISM. Same ticket history -> same summary: every list is sorted, no
// wall-clock appears in substantive content, and the summary timestamp is INJECTED
// via options.now (defaults to a fixed sentinel) and lives OUTSIDE the content
// digest (mirrors insight-reports / prework-pack / summary-tiers).
//
// ZERO new runtime deps. No derived artifact is written by default (a closeout
// summary is produced on demand at/after finalize); --rebuild is intentionally
// NOT provided.

const fs = require("fs");
const path = require("path");

const extractor = require("./decision-extractor.js");
const insights = require("./insight-reports.js");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BOARD_PATH = path.join(COORD_DIR, "board", "tasks.json");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_ATTESTATIONS_DIR = path.join(COORD_DIR, ".runtime", "attestations");

const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";

// The lifecycle events that materially evidence a closeout, in the order a
// closeout flows. `commit` carries the source commit(s); move-review opens the
// review gate; mark-done lands the ticket.
const LANDING_COMMANDS = Object.freeze(["commit", "move-review", "mark-done"]);

// --- deterministic serialization (mirrors the substrate) ---------------------
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

// =============================================================================
// SOURCE INGESTION
// =============================================================================

// The ticket's plan record (the decision-layer authority). Returns null when no
// plan record exists (a ticket with no plan cannot ground ask/delivered claims —
// honest: those sections are then absent, not fabricated). The relative path is
// the citation pin.
function readPlanRecord(plansDir, ticketId, rootDir) {
  if (!ticketId) {
    return null;
  }
  const abs = path.join(plansDir, `${ticketId}.json`);
  if (!fs.existsSync(abs)) {
    return null;
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (error) {
    return null;
  }
  if (!rec || !rec.ticket_id) {
    return null;
  }
  return {
    ticket_id: rec.ticket_id,
    path: path.relative(rootDir, abs).split(path.sep).join("/"),
    closure: extractor.parseRequirementClosure(rec.requirement_closure),
    cycles: extractor.parseSelfReviewCycles(rec.self_review_cycles),
    invariants: extractor.cleanInvariants(rec.critical_invariants),
    // repo_gates is an array of "command - result" strings recorded by
    // gov add-repo-gate; we surface them verbatim (the result IS the evidence).
    repo_gates: Array.isArray(rec.repo_gates)
      ? rec.repo_gates.map((g) => String(g).trim()).filter(Boolean)
      : [],
    feature_proof: Array.isArray(rec.feature_proof)
      ? rec.feature_proof.map((p) => String(p).trim()).filter(Boolean)
      : [],
    expected_closeout:
      rec.governance && typeof rec.governance === "object"
        ? rec.governance.expected_closeout || null
        : null,
  };
}

// The ticket's own ordered lifecycle events (the operational-layer authority),
// each carrying its canonical event_hash + verified flag. Filtered from the full
// journal to just this ticket. The chain head is the whole-journal anchor.
function readTicketEvents(journalPath, ticketId) {
  const { events, chainHead } = insights.readJournalEvents(journalPath);
  const ticketEvents = ticketId
    ? events.filter((e) => e.ticket === ticketId)
    : [];
  return { events: ticketEvents, chainHead };
}

// Read board row for the ticket (final status context). null when absent.
function readBoardRow(boardPath, ticketId, rootDir) {
  if (!ticketId || !fs.existsSync(boardPath)) {
    return null;
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch (error) {
    return null;
  }
  const rel = path.relative(rootDir, boardPath).split(path.sep).join("/");
  for (const section of Array.isArray(board.sections) ? board.sections : []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) {
      continue;
    }
    for (const row of section.rows) {
      if (row && String(row.ID) === String(ticketId)) {
        return {
          id: String(row.ID),
          repo: row.Repo != null ? String(row.Repo) : null,
          type: row.Type != null ? String(row.Type) : null,
          status: row.Status != null ? String(row.Status) : null,
          description: row.Description != null ? String(row.Description) : "",
          subsystem: section.heading || "(unsectioned)",
          board_path: rel,
        };
      }
    }
  }
  return null;
}

// Find the conformance attestation, if any, that anchors this ticket's closeout.
// An attestation's signed subject pins `journal_chain_head.head` (§2). We treat an
// attestation as ANCHORING the closeout when its chain head equals the canonical
// hash of one of the ticket's OWN events (i.e. an attestation was emitted right at
// a point where the ticket's event is the chain head) OR equals the current chain
// head while the ticket reached done. We are deliberately CONSERVATIVE: when no
// attestation's head matches a ticket event hash we emit NO attestation claim
// (honest absence, never fabricated). Returns the matching attestation descriptor
// or null. Read-only directory scan, sorted for determinism.
function findAnchoringAttestation(attestationsDir, ticketEventHashes) {
  if (!fs.existsSync(attestationsDir) || !ticketEventHashes.size) {
    return null;
  }
  let names;
  try {
    names = fs.readdirSync(attestationsDir).filter((n) => n.endsWith(".json")).sort();
  } catch (error) {
    return null;
  }
  for (const name of names) {
    const abs = path.join(attestationsDir, name);
    let att;
    try {
      att = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      continue;
    }
    const head =
      att && att.subject && att.subject.journal_chain_head
        ? att.subject.journal_chain_head.head
        : null;
    if (head && ticketEventHashes.has(head)) {
      return {
        file: name,
        subject_digest: att.subject_digest || null,
        chain_head: head,
        algorithm: att.signature && att.signature.algorithm ? att.signature.algorithm : null,
      };
    }
  }
  return null;
}

// =============================================================================
// CITATION HELPERS — the §5 guardrail. Reuse the §7 recall source shape exactly.
// =============================================================================

// A plan-record citation points at the canonical plan file path (decision-layer
// authority). It carries no event_hash (the plan file IS the source); chain_head
// is pinned so staleness can be reasoned about against the journal. Mirrors
// insight-reports.planCitation.
function planCitation(plan, chainHead) {
  return {
    type: "decision",
    id: plan.ticket_id,
    path: plan.path,
    event_hash: null,
    chain_head: chainHead,
    verified: true,
  };
}

// A journal-event citation pins the event_hash + chain_head + verified flag,
// matching the §7 recall source shape and insight-reports.eventCitation.
function eventCitation(event, chainHead) {
  return {
    type: "event",
    id: event.ticket || null,
    path: null,
    event_hash: event.event_hash,
    chain_head: chainHead,
    verified: event.verified,
    command: event.command,
  };
}

function boardCitation(row, chainHead) {
  return {
    type: "ticket",
    id: row.id,
    path: row.board_path,
    event_hash: null,
    chain_head: chainHead,
    verified: true,
  };
}

// An attestation citation pins the attestation file + its signed subject digest.
// The attestation IS a signed artifact (ed25519 over a subject including the chain
// head, §2), so verified:true; chain_head is the head the attestation signed.
function attestationCitation(att) {
  return {
    type: "attestation",
    id: null,
    path: `coord/.runtime/attestations/${att.file}`,
    event_hash: att.subject_digest,
    chain_head: att.chain_head,
    verified: true,
  };
}

// =============================================================================
// SECTION 1 — ASK & DELIVERED (grounded in requirement_closure)
// =============================================================================
//
// Each claim is emitted ONLY when the underlying plan field is present + non-
// scaffold (decision-extractor already drops TODO scaffold). A ticket with no
// plan record contributes nothing here — the section is empty, not fabricated.

function buildAskAndDelivered(plan, chainHead) {
  const claims = [];
  if (!plan) {
    return { claims, present: false };
  }
  const c = plan.closure;
  const cite = [planCitation(plan, chainHead)];
  if (c.ticket_ask) {
    claims.push({ field: "ticket_ask", text: c.ticket_ask, citations: cite });
  }
  if (c.implemented) {
    claims.push({ field: "implemented", text: c.implemented, citations: cite });
  }
  // COORD-198: gate on the recency-correct not_implemented_is_none flag (shared
  // none-class interpretation) so a re-closure that landed at "Not implemented:
  // none — ..." is not surfaced as a leftover carve-out.
  if (c.not_implemented && !c.not_implemented_is_none) {
    claims.push({ field: "not_implemented", text: c.not_implemented, citations: cite });
  }
  if (c.verdict) {
    claims.push({ field: "closeout_verdict", text: c.verdict, citations: cite });
  }
  return { claims, present: claims.length > 0 };
}

// =============================================================================
// SECTION 2 — EVIDENCE TRAIL (gates + reviews + commits/landing + attestation)
// =============================================================================

function buildEvidenceTrail(plan, ticketEvents, attestation, chainHead) {
  const gate_results = [];
  const review_cycles = [];
  const landing = [];
  let conformance = null;

  // (a) repo-gate results — cited to the plan record that recorded them.
  if (plan) {
    const cite = [planCitation(plan, chainHead)];
    for (const g of plan.repo_gates) {
      gate_results.push({ result: g, citations: cite });
    }
    // (b) review cycles — lens + verdict, cited to the plan record.
    for (const cyc of plan.cycles) {
      review_cycles.push({
        lens: cyc.lens || "(unnamed lens)",
        verdict: cyc.verdict || null,
        findings: cyc.findings && cyc.findings.toLowerCase() !== "none" ? cyc.findings : null,
        citations: cite,
      });
    }
  }

  // (c) source commit(s) / landing record — the ticket's OWN lifecycle events,
  // cited to their event_hash (verified by the hash chain). We surface the
  // commit / move-review / mark-done events; each is real and hash-linked.
  for (const ev of ticketEvents) {
    if (!LANDING_COMMANDS.includes(ev.command)) {
      continue;
    }
    const detail =
      ev.details && typeof ev.details === "object"
        ? ev.details
        : null;
    // Surface a source-commit sha when the commit event carries one.
    let commit = null;
    if (detail) {
      commit = detail.commit || detail.sha || detail.source_commit || detail.head || null;
    }
    landing.push({
      command: ev.command,
      transition: `${ev.before_status || "?"} -> ${ev.after_status || "?"}`,
      commit: commit ? String(commit) : null,
      ts: ev.ts || null,
      citations: [eventCitation(ev, chainHead)],
    });
  }

  // (d) conformance attestation — ONLY when one anchors this ticket's closeout.
  // Absent attestation -> conformance stays null (honest, not fabricated).
  if (attestation) {
    conformance = {
      file: `coord/.runtime/attestations/${attestation.file}`,
      algorithm: attestation.algorithm,
      subject_digest: attestation.subject_digest,
      citations: [attestationCitation(attestation)],
    };
  }

  return {
    gate_results,
    review_cycles,
    landing,
    conformance,
    // Honest emptiness: when there is no gate / review / landing evidence we say
    // so rather than implying the work was proven.
    has_evidence:
      gate_results.length > 0 ||
      review_cycles.length > 0 ||
      landing.length > 0 ||
      Boolean(conformance),
  };
}

// =============================================================================
// SECTION 3 — KEY DECISIONS + DEFERRALS (grounded in requirement_closure +
// self_review)
// =============================================================================

function buildDecisions(plan, chainHead) {
  const claims = [];
  if (!plan) {
    return { claims, present: false };
  }
  const cite = [planCitation(plan, chainHead)];
  const c = plan.closure;

  // Deferrals: explicit deferred_to follow-up tickets (COORD-198: none-class
  // interpretation so "none — ..." is not surfaced as a deferral).
  if (c.deferred_to && !c.deferred_to_is_none) {
    claims.push({
      kind: "deferral",
      text: c.deferred_to,
      deferred_to_tickets: c.deferred_to_tickets || [],
      citations: cite,
    });
  }

  // Invariants the change had to preserve are a key decision record.
  for (const inv of plan.invariants) {
    claims.push({ kind: "invariant", text: inv, citations: cite });
  }

  // Self-review findings (non-trivial) are recorded decisions about what was
  // checked + concluded.
  for (const cyc of plan.cycles) {
    const findings = String(cyc.findings || "").trim();
    if (findings && findings.toLowerCase() !== "none") {
      claims.push({
        kind: "review-finding",
        lens: cyc.lens || null,
        text: findings,
        citations: cite,
      });
    }
  }

  return { claims, present: claims.length > 0 };
}

// =============================================================================
// SUMMARY ASSEMBLY
// =============================================================================

function buildSummary(options = {}) {
  const ticketId = options.ticketId ? String(options.ticketId).trim() : null;
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const plansDir = options.plansDir || DEFAULT_PLANS_DIR;
  const attestationsDir = options.attestationsDir || DEFAULT_ATTESTATIONS_DIR;
  const rootDir = options.rootDir || ROOT_DIR;
  const generatedAt = options.now || DEFAULT_GENERATED_AT;

  const plan = readPlanRecord(plansDir, ticketId, rootDir);
  const { events: ticketEvents, chainHead } = readTicketEvents(journalPath, ticketId);
  const boardRow = readBoardRow(boardPath, ticketId, rootDir);

  const ticketEventHashes = new Set(ticketEvents.map((e) => e.event_hash));
  const attestation = findAnchoringAttestation(attestationsDir, ticketEventHashes);

  const ask_and_delivered = buildAskAndDelivered(plan, chainHead);
  const evidence_trail = buildEvidenceTrail(plan, ticketEvents, attestation, chainHead);
  const decisions = buildDecisions(plan, chainHead);

  return {
    kind: "closeout-summary",
    // The guardrail, machine-checkable: this REPORTS only; it closes/gates/mutates
    // nothing. Closeout stays governed by the normal finalize lane.
    authority: false,
    recommends_only: true,
    generated_at: generatedAt,
    ticket_id: ticketId,
    chain_head: chainHead,
    subject: boardRow
      ? {
          id: boardRow.id,
          repo: boardRow.repo,
          type: boardRow.type,
          status: boardRow.status,
          subsystem: boardRow.subsystem,
          // The board row itself is a cited source (final status authority).
          citations: [boardCitation(boardRow, chainHead)],
        }
      : null,
    // Honest grounding flags: which authority artifacts backed this summary.
    grounded_in: {
      plan_record: Boolean(plan),
      journal_events: ticketEvents.length,
      board_row: Boolean(boardRow),
      conformance_attestation: Boolean(attestation),
    },
    sections: {
      ask_and_delivered,
      evidence_trail,
      decisions,
    },
  };
}

// =============================================================================
// THE §5 INVARIANT — no uncited claim
// =============================================================================

// Every cited claim across every section + the subject (for the no-uncited
// invariant + tests). A "claim" is any object carrying a `citations` array.
function allClaims(summary) {
  const out = [];
  const push = (section, item) => out.push({ section, item });
  if (summary.subject) {
    push("subject", summary.subject);
  }
  for (const c of summary.sections.ask_and_delivered.claims || []) {
    push("ask_and_delivered", c);
  }
  const ev = summary.sections.evidence_trail;
  for (const c of ev.gate_results || []) {
    push("evidence_trail.gate_results", c);
  }
  for (const c of ev.review_cycles || []) {
    push("evidence_trail.review_cycles", c);
  }
  for (const c of ev.landing || []) {
    push("evidence_trail.landing", c);
  }
  if (ev.conformance) {
    push("evidence_trail.conformance", ev.conformance);
  }
  for (const c of summary.sections.decisions.claims || []) {
    push("decisions", c);
  }
  return out;
}

// The §5 invariant, callable: claims carrying NO citation. Valid iff empty.
function uncitedClaims(summary) {
  return allClaims(summary)
    .filter(({ item }) => !Array.isArray(item.citations) || item.citations.length === 0)
    .map(({ section, item }) => ({ section, item }));
}

// Content digest excluding generated_at (byte-stable across wall-clock drift).
function contentDigest(summary) {
  const { generated_at, ...rest } = summary;
  return extractor.sha1(stableStringify(rest));
}

// =============================================================================
// RENDERING — readable text (every line traces to a cited claim)
// =============================================================================

function renderCitations(citations) {
  const shown = (citations || []).slice(0, 3).map((c) => {
    if (c.event_hash && c.type === "event") {
      return `${c.id || "?"}@${c.event_hash.slice(0, 8)}`;
    }
    if (c.type === "attestation") {
      return `attestation:${(c.path || "").split("/").pop()}`;
    }
    return `${c.id || c.path || "?"}`;
  });
  const more =
    citations && citations.length > shown.length ? ` (+${citations.length - shown.length})` : "";
  return `cites: ${shown.join(", ")}${more}`;
}

function renderText(summary) {
  const lines = [];
  const p = (s) => lines.push(s);
  p(`CLOSEOUT SUMMARY (COORD-149) — ${summary.ticket_id || "(no ticket)"} — REPORTS ONLY. Closes/gates/mutates nothing.`);
  if (summary.subject) {
    p(
      `subject: ${summary.subject.id} repo=${summary.subject.repo || "?"} ` +
        `type=${summary.subject.type || "?"} status=${summary.subject.status || "?"} ` +
        `subsystem=${summary.subject.subsystem || "?"}`
    );
  }
  p(
    `grounded in: plan_record=${summary.grounded_in.plan_record} ` +
      `journal_events=${summary.grounded_in.journal_events} ` +
      `board_row=${summary.grounded_in.board_row} ` +
      `attestation=${summary.grounded_in.conformance_attestation} ` +
      `chain_head=${(summary.chain_head || "(none)").slice(0, 12)}`
  );
  p("");

  // Section 1
  const s1 = summary.sections.ask_and_delivered;
  p(`1. ASK & DELIVERED (${s1.claims.length} grounded claims)`);
  if (!s1.claims.length) {
    p("   (no plan requirement_closure to ground ask/delivered — absent, not asserted)");
  }
  for (const c of s1.claims) {
    p(`   - ${c.field}: ${String(c.text).slice(0, 200)}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");

  // Section 2
  const s2 = summary.sections.evidence_trail;
  p(`2. EVIDENCE TRAIL (${s2.has_evidence ? "grounded" : "NO cited evidence found"})`);
  if (s2.gate_results.length) {
    p(`   repo gates (${s2.gate_results.length}):`);
    for (const g of s2.gate_results) {
      p(`     * ${g.result}`);
      p(`       ${renderCitations(g.citations)}`);
    }
  }
  if (s2.review_cycles.length) {
    p(`   review cycles (${s2.review_cycles.length}):`);
    for (const r of s2.review_cycles) {
      p(`     * ${r.lens} -> verdict=${r.verdict || "?"}`);
      p(`       ${renderCitations(r.citations)}`);
    }
  }
  if (s2.landing.length) {
    p(`   source commit(s) / landing record (${s2.landing.length}):`);
    for (const l of s2.landing) {
      p(`     * ${l.command} ${l.transition}${l.commit ? ` commit=${l.commit}` : ""}`);
      p(`       ${renderCitations(l.citations)}`);
    }
  }
  if (s2.conformance) {
    p(`   conformance attestation:`);
    p(`     * ${s2.conformance.file} (${s2.conformance.algorithm}) subject_digest=${(s2.conformance.subject_digest || "").slice(0, 12)}`);
    p(`       ${renderCitations(s2.conformance.citations)}`);
  } else {
    p("   conformance attestation: (none anchors this closeout — absent, not asserted)");
  }
  p("");

  // Section 3
  const s3 = summary.sections.decisions;
  p(`3. KEY DECISIONS & DEFERRALS (${s3.claims.length} grounded claims)`);
  if (!s3.claims.length) {
    p("   (no cited decision / deferral in the plan record)");
  }
  for (const c of s3.claims) {
    const label = c.kind === "review-finding" && c.lens ? `${c.kind} [${c.lens}]` : c.kind;
    p(`   - ${label}: ${String(c.text).slice(0, 200)}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");
  p("NOTE: This summary REPORTS only. It does not close, gate, finalize, or mutate");
  p("the ticket; closeout stays governed by the normal finalize lane. Authority is");
  p("the hash-linked journal / plan / board / attestation cited above (source wins).");
  return lines.join("\n");
}

module.exports = {
  stableStringify,
  readPlanRecord,
  readTicketEvents,
  readBoardRow,
  findAnchoringAttestation,
  planCitation,
  eventCitation,
  boardCitation,
  attestationCitation,
  buildAskAndDelivered,
  buildEvidenceTrail,
  buildDecisions,
  buildSummary,
  allClaims,
  uncitedClaims,
  contentDigest,
  renderText,
  LANDING_COMMANDS,
  DEFAULT_BOARD_PATH,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_PLANS_DIR,
  DEFAULT_ATTESTATIONS_DIR,
  DEFAULT_GENERATED_AT,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let asJson = false;
  let ticketId = null;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      asJson = true;
    } else if (String(a).startsWith("--")) {
      // ignore unknown flags
    } else {
      positional.push(a);
    }
  }
  if (positional.length) {
    ticketId = positional[0];
  }
  if (!ticketId) {
    process.stdout.write(
      [
        "coord/scripts/closeout-summary.js — auto evidence-backed closeout summary (COORD-149).",
        "",
        "Usage:",
        "  node coord/scripts/closeout-summary.js <ticket-id> [--json]",
        "",
        "Produces a SOURCE-CITED closeout summary GROUNDED in the ticket's real",
        "artifacts: requirement_closure (ask/delivered), repo-gate results, review",
        "cycles, source commit(s)/landing events, and any conformance attestation —",
        "every claim cited with event_hash + chain_head. REPORTS ONLY: it does not",
        "close, gate, finalize, or mutate the ticket. Composes decision-extractor.js",
        "+ insight-reports.js. Deterministic; no derived artifact is written.",
        "",
      ].join("\n")
    );
  } else {
    const summary = buildSummary({ ticketId, now: new Date().toISOString() });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderText(summary)}\n`);
    }
  }
}
