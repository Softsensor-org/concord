"use strict";

// COORD-142: [Memory] Phase 2 — summary-tier generator.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 principle 5 ("summary tiers carry
// provenance") this module produces FOUR derived summary tiers under
// coord/memory/summaries/{tickets,epics,subsystems,repos}/ that roll the board +
// the Phase-0 decision records (coord/scripts/decision-extractor.js) up along the
// real tiering already present in the data:
//
//   tickets    -> one summary per board ticket (status + its decision record).
//   epics      -> roll up tickets sharing a bracketed "[Epic]" prefix
//                 (e.g. "[Memory]", "[Server bootstrap]", "[Production MCP]").
//   subsystems -> roll up tickets sharing a board SECTION heading (the code-area
//                 / subsystem grouping the board itself draws).
//   repos      -> roll up tickets sharing a Repo code (X / B / F).
//
// The tiering is DERIVED FROM REAL BOARD DATA — epic = the bracketed prefix,
// subsystem = the board section, repo = the Repo column — never hand-authored
// membership.
//
// CARDINAL GUARDRAIL (§5 + §10). A summary is a CONVENIENCE VIEW, NEVER EVIDENCE.
// Every record is explicitly stamped:
//   - kind: "summary"
//   - authority: false                 (NOT citable as evidence)
//   - invalid_if_source_changed: true  (a stale summary is refused, not trusted)
//   - sources: [ ... ]                 pointers to the AUTHORITATIVE hash-linked
//                                       sources (board rows + decision/plan
//                                       records) the summary merely points at.
// When source and summary disagree, the source wins and the summary is invalid.
//
// PROVENANCE / STALENESS (§6 principle 5). Each record carries:
//   - source_hashes: { <source-id>: <sha1-of-source-content> }  so any change to
//     an underlying source is detectable by recomputing + comparing.
//   - generated_at: an injectable timestamp (NOT part of the content digest, so
//     rebuilds stay byte-identical — see DETERMINISM below).
//   - chain_head: the journal hash-chain head at generation (the same whole-chain
//     anchor the conformance attestation signs, §2).
// `checkStaleness()` recomputes the current source hashes and flags any tier
// record whose recorded source_hashes no longer match -> "stale"/invalid.
//
// DERIVED + REBUILDABLE (§6 principle 1). Everything under
// coord/memory/summaries/ is gitignored (coord/.gitignore: `memory/summaries/`)
// exactly like decisions.ndjson. Only THIS generator + fixtures + tests are
// committed. Raw truth stays in the board, plans, journal, git. Losing the
// summaries loses no authority.
//
// DETERMINISM. The substantive content of each record is order-stable
// (stableStringify sorts keys; tickets/epics/etc. are emitted in sorted-id
// order; member id lists are sorted). `generated_at` is INJECTED (options.now),
// so callers/tests can pin it; and it is EXCLUDED from `content_hash`, so two
// rebuilds produce byte-identical content digests even across wall-clock drift.
//
// ZERO new runtime deps. Reuses decision-extractor.js for journal provenance +
// sha1 so summaries pin the chain head the SAME way decisions/recall do.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BOARD_PATH = path.join(COORD_DIR, "board", "tasks.json");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_SUMMARIES_DIR = path.join(COORD_DIR, "memory", "summaries");

// Reuse the Phase-0 substrate: sha1 + journal provenance + decision extraction.
// One canonical hash implementation across decisions / recall / summaries.
const extractor = require("./decision-extractor.js");

const TIERS = Object.freeze(["tickets", "epics", "subsystems", "repos"]);

// --- deterministic serialization (mirrors decision-extractor.stableStringify) -
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

// --- board ingestion ---------------------------------------------------------
// Tickets live in the board's `table` sections as `rows`. We read each ticket
// row + the section heading it belongs to (the subsystem grouping). The row is
// the AUTHORITATIVE source; its source hash is the sha1 of its canonical
// stringification, so any field change (status, description, owner...) is
// detectable.
function readBoardTickets(boardPath) {
  if (!fs.existsSync(boardPath)) {
    return [];
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch (error) {
    return [];
  }
  const tickets = [];
  for (const section of Array.isArray(board.sections) ? board.sections : []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) {
      continue;
    }
    const subsystem = section.heading || "(unsectioned)";
    for (const row of section.rows) {
      if (!row || typeof row !== "object" || !row.ID) {
        continue;
      }
      tickets.push({
        id: String(row.ID),
        repo: row.Repo != null ? String(row.Repo) : null,
        type: row.Type != null ? String(row.Type) : null,
        priority: row.Pri != null ? String(row.Pri) : null,
        status: row.Status != null ? String(row.Status) : null,
        owner: row.Owner != null ? String(row.Owner) : null,
        description: row.Description != null ? String(row.Description) : "",
        depends_on: row["Depends On"] != null ? String(row["Depends On"]) : "",
        subsystem,
        epic: epicOf(row.Description),
        // The canonical source-content hash for this ticket row. Changing any
        // field changes this hash -> staleness becomes detectable.
        source_hash: extractor.sha1(stableStringify(row)),
        // The authoritative source pointer (board path + the ticket id).
        source_path: relFromRoot(boardPath),
      });
    }
  }
  // Pin a stable order independent of board layout.
  tickets.sort((a, b) => a.id.localeCompare(b.id));
  return tickets;
}

// epic = the leading bracketed prefix in a description ("[Memory] ..." -> "Memory").
// Tickets without a bracket prefix are grouped under "(unclassified)".
function epicOf(description) {
  const match = String(description || "").match(/^\s*\[([^\]]+)\]/);
  return match ? match[1].trim() : "(unclassified)";
}

function relFromRoot(absPath) {
  return path.relative(ROOT_DIR, absPath).split(path.sep).join("/");
}

// --- decision-record index (the "why") --------------------------------------
// Index the Phase-0 decision records by ticket id so each ticket summary can
// roll up its decision (verdict + ticket_ask), and so rollups can count how many
// members carry a worked decision. The decision record's own `source` pin is the
// authoritative citation we point at (NEVER the summary).
function indexDecisions(options) {
  const decisions = extractor.extractDecisions({
    plansDir: options.plansDir || DEFAULT_PLANS_DIR,
    journalPath: options.journalPath || DEFAULT_JOURNAL_PATH,
    rootDir: options.rootDir || ROOT_DIR,
  });
  const byId = new Map();
  for (const d of decisions) {
    byId.set(d.ticket_id, d);
  }
  return byId;
}

// --- record builders ---------------------------------------------------------
// Common provenance envelope. `authority:false` + `invalid_if_source_changed`
// + `kind:summary` make the guardrail explicit and machine-checkable.
function makeEnvelope(tier, key, sources, generatedAt, chainHead) {
  const sourceHashes = {};
  for (const s of sources) {
    sourceHashes[s.id] = s.source_hash;
  }
  return {
    kind: "summary",
    authority: false,
    invalid_if_source_changed: true,
    tier,
    key,
    generated_at: generatedAt,
    chain_head: chainHead,
    source_hashes: sourceHashes,
    // Authoritative pointers — what a citation MUST point at instead of this
    // summary. Each names the source id + its path + (for decisions) the
    // hash-linked event citation.
    sources,
  };
}

function decisionPointer(decision) {
  // The authoritative citation for a ticket's "why" is the decision record's own
  // source pin (path + event_hash + chain_head + verified). A summary points at
  // it; it never replaces it.
  if (!decision || !decision.source) {
    return null;
  }
  return {
    type: "decision",
    id: decision.ticket_id,
    path: decision.source.path,
    event_hash: decision.source.event_hash || null,
    chain_head: decision.source.chain_head || null,
    verified: Boolean(decision.source.verified),
  };
}

function buildTicketSummary(ticket, decision, generatedAt, chainHead) {
  // A ticket summary's sources: the board row (authoritative for status/fields)
  // and, when present, the decision record (authoritative for the "why").
  const sources = [
    {
      type: "ticket",
      id: ticket.id,
      path: ticket.source_path,
      source_hash: ticket.source_hash,
      verified: true,
    },
  ];
  const decisionPtr = decisionPointer(decision);
  if (decisionPtr) {
    sources.push({ ...decisionPtr, source_hash: ticket.source_hash });
  }
  const envelope = makeEnvelope("tickets", ticket.id, sources, generatedAt, chainHead);
  const rc = decision && decision.requirement_closure ? decision.requirement_closure : null;
  envelope.summary = {
    id: ticket.id,
    repo: ticket.repo,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    epic: ticket.epic,
    subsystem: ticket.subsystem,
    has_decision: Boolean(decision),
    // The "why", rolled from the decision record when worked. Convenience only;
    // the authority is the cited decision record above.
    decision_verdict: rc ? rc.verdict || null : null,
    ticket_ask: rc ? rc.ticket_ask || null : null,
  };
  return envelope;
}

// Roll a set of member tickets up into one tier record (epics/subsystems/repos).
// `members` are ticket objects already filtered to this group.
function buildRollup(tier, key, members, decisionsById, generatedAt, chainHead) {
  const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
  // Sources: every member ticket row (authoritative). The roll-up's validity
  // depends on ALL of them — change any member row and the rollup is stale.
  const sources = sorted.map((t) => ({
    type: "ticket",
    id: t.id,
    path: t.source_path,
    source_hash: t.source_hash,
    verified: true,
  }));
  const envelope = makeEnvelope(tier, key, sources, generatedAt, chainHead);

  const statusCounts = {};
  let decided = 0;
  for (const t of sorted) {
    const st = t.status || "(unknown)";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (decisionsById.has(t.id)) {
      decided += 1;
    }
  }
  envelope.summary = {
    key,
    member_count: sorted.length,
    members: sorted.map((t) => t.id),
    status_counts: statusCounts,
    decided_member_count: decided,
    repos: [...new Set(sorted.map((t) => t.repo).filter(Boolean))].sort(),
  };
  return envelope;
}

// --- generation --------------------------------------------------------------
// generateSummaries: pure function — reads sources, returns
// { tickets:[], epics:[], subsystems:[], repos:[], chain_head }. Deterministic
// substantive content; `generated_at` injected via options.now (defaults to a
// fixed sentinel so omitting it never injects wall-clock into content).
const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";

function generateSummaries(options = {}) {
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  const generatedAt = options.now || DEFAULT_GENERATED_AT;
  const { chainHead } = extractor.indexJournalProvenance(
    options.journalPath || DEFAULT_JOURNAL_PATH
  );

  const tickets = readBoardTickets(boardPath);
  const decisionsById = indexDecisions(options);

  const ticketRecords = tickets.map((t) =>
    buildTicketSummary(t, decisionsById.get(t.id), generatedAt, chainHead)
  );

  const epicRecords = groupRollups("epics", tickets, (t) => t.epic, decisionsById, generatedAt, chainHead);
  const subsystemRecords = groupRollups(
    "subsystems",
    tickets,
    (t) => t.subsystem,
    decisionsById,
    generatedAt,
    chainHead
  );
  const repoRecords = groupRollups(
    "repos",
    tickets,
    (t) => t.repo || "(none)",
    decisionsById,
    generatedAt,
    chainHead
  );

  return {
    tickets: ticketRecords,
    epics: epicRecords,
    subsystems: subsystemRecords,
    repos: repoRecords,
    chain_head: chainHead,
  };
}

function groupRollups(tier, tickets, keyFn, decisionsById, generatedAt, chainHead) {
  const groups = new Map();
  for (const t of tickets) {
    const key = keyFn(t);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  return keys.map((key) =>
    buildRollup(tier, key, groups.get(key), decisionsById, generatedAt, chainHead)
  );
}

// --- staleness / invalidation ------------------------------------------------
// Recompute the current source hashes from live sources and compare against each
// summary record's recorded source_hashes. Any mismatch (or a vanished source)
// flips the record to invalid/stale. This is the "invalid if source changed"
// mechanism — a stale summary is refused, not silently trusted.
function currentSourceHashes(options = {}) {
  const tickets = readBoardTickets(options.boardPath || DEFAULT_BOARD_PATH);
  const map = new Map();
  for (const t of tickets) {
    map.set(t.id, t.source_hash);
  }
  return map;
}

// Evaluate one summary record against the current source hashes.
// Returns { key, tier, valid, stale, reasons[] }.
function evaluateRecord(record, currentHashes) {
  const reasons = [];
  const recorded = record.source_hashes || {};
  for (const id of Object.keys(recorded)) {
    if (!currentHashes.has(id)) {
      reasons.push(`source ${id} no longer exists`);
      continue;
    }
    if (currentHashes.get(id) !== recorded[id]) {
      reasons.push(`source ${id} changed`);
    }
  }
  const valid = reasons.length === 0;
  return {
    tier: record.tier,
    key: record.key,
    valid,
    stale: !valid,
    reasons,
  };
}

// checkStaleness: load the written tier files (or accept an in-memory generated
// set) and evaluate every record against current sources. Returns a flat list of
// per-record validity verdicts.
function checkStaleness(options = {}) {
  const currentHashes = currentSourceHashes(options);
  const records = options.records || loadAllSummaries(options);
  return records.map((r) => evaluateRecord(r, currentHashes));
}

// --- writing / loading derived files -----------------------------------------
// Each tier is written as an ndjson file under summaries/<tier>/<tier>.ndjson
// (one record per line, sorted). Derived + gitignored. Determinism: sorted keys,
// sorted records, generated_at excluded from the content digest.
function serializeRecords(records) {
  if (!records.length) {
    return "";
  }
  return `${records.map(stableStringify).join("\n")}\n`;
}

// A content digest that EXCLUDES generated_at so two rebuilds across wall-clock
// drift produce the same digest (the substantive content is what must be stable).
function contentDigest(records) {
  const stripped = records.map((r) => {
    const { generated_at, ...rest } = r;
    return rest;
  });
  return extractor.sha1(stableStringify(stripped));
}

function tierFilePath(summariesDir, tier) {
  return path.join(summariesDir, tier, `${tier}.ndjson`);
}

function rebuild(options = {}) {
  const summariesDir = options.summariesDir || DEFAULT_SUMMARIES_DIR;
  const generated = generateSummaries(options);
  const counts = {};
  for (const tier of TIERS) {
    const records = generated[tier];
    const outPath = tierFilePath(summariesDir, tier);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serializeRecords(records), "utf8");
    counts[tier] = records.length;
  }
  return { summariesDir, counts, chain_head: generated.chain_head };
}

function loadTier(summariesDir, tier) {
  const p = tierFilePath(summariesDir, tier);
  if (!fs.existsSync(p)) {
    return [];
  }
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch (error) {
      // skip malformed
    }
  }
  return out;
}

function loadAllSummaries(options = {}) {
  const summariesDir = options.summariesDir || DEFAULT_SUMMARIES_DIR;
  const out = [];
  for (const tier of TIERS) {
    out.push(...loadTier(summariesDir, tier));
  }
  return out;
}

module.exports = {
  TIERS,
  stableStringify,
  readBoardTickets,
  epicOf,
  indexDecisions,
  generateSummaries,
  buildTicketSummary,
  buildRollup,
  currentSourceHashes,
  evaluateRecord,
  checkStaleness,
  serializeRecords,
  contentDigest,
  rebuild,
  loadTier,
  loadAllSummaries,
  DEFAULT_BOARD_PATH,
  DEFAULT_PLANS_DIR,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_SUMMARIES_DIR,
  DEFAULT_GENERATED_AT,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--rebuild" || cmd === "rebuild") {
    const now = new Date().toISOString();
    const { summariesDir, counts } = rebuild({ now });
    process.stdout.write(
      `Rebuilt summary tiers under ${path.relative(ROOT_DIR, summariesDir)} — ` +
        `${TIERS.map((t) => `${t}=${counts[t]}`).join(", ")}.\n`
    );
  } else if (cmd === "--check" || cmd === "check") {
    const verdicts = checkStaleness({});
    const stale = verdicts.filter((v) => v.stale);
    for (const v of stale) {
      process.stdout.write(`STALE [${v.tier}] ${v.key}: ${v.reasons.join("; ")}\n`);
    }
    process.stdout.write(
      `Checked ${verdicts.length} summary record(s); ${stale.length} stale.\n`
    );
    process.exitCode = stale.length ? 1 : 0;
  } else if (cmd === "--print" || cmd === "print") {
    const generated = generateSummaries({});
    for (const tier of TIERS) {
      process.stdout.write(serializeRecords(generated[tier]));
    }
  } else {
    process.stdout.write(
      [
        "coord/scripts/summary-tiers.js — Phase 2 summary-tier generator (COORD-142).",
        "",
        "Usage:",
        "  node coord/scripts/summary-tiers.js --rebuild   regenerate coord/memory/summaries/{tickets,epics,subsystems,repos} (derived)",
        "  node coord/scripts/summary-tiers.js --check     flag summaries whose source_hashes no longer match current sources (stale)",
        "  node coord/scripts/summary-tiers.js --print     write the derived tier records to stdout",
        "",
        "Summaries are DERIVED, REBUILDABLE CONVENIENCE VIEWS — NEVER evidence",
        "(kind:summary, authority:false, invalid_if_source_changed:true). The",
        "hash-linked source (board rows + decision/plan records + journal) remains",
        "the authority. Output is gitignored like decisions.ndjson; only this",
        "generator + fixtures + tests are committed.",
        "",
      ].join("\n")
    );
  }
}
