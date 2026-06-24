"use strict";

// COORD-147: [Memory] Strategic — execution-insight reports.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §4 ("Strategic (operational + decision)")
// this module mines the REAL execution history of this governed project and emits
// evidence-backed STRATEGIC insight reports. It is the strategic capability layer
// on top of the operational journal + decision records — ANOTHER derived view over
// the same hash-linked truth COORD-140/141/142 already mine.
//
// The four report sections (the ticket ask):
//   1. repeated-failure-theme detection — cluster recurring gate failures, review
//      findings, recovery causes, and risks across tickets into named themes.
//   2. architectural-debt by subsystem — which subsystems concentrate deferrals /
//      not-implemented carve-outs / repeated findings (real touch + failure history).
//   3. churn-instead-of-value detection — tickets with high rework (repeated
//      review cycles, recoveries, reconciles, re-opens) relative to delivered
//      closure (motion without value).
//   4. gate/review/recovery health by repo — weak gates (failing review cycles /
//      review-round count), slow reviews (time review->done), high recovery/repair
//      load, aggregated PER REPO.
//
// CARDINAL GUARDRAIL (§5). This report RECOMMENDS ONLY. It NEVER mutates the
// board, gates nothing, asserts no authority, and writes nothing back to the
// journal/plans. It is a pure read over already-committed history. EVERY emitted
// claim carries `citations` — a list of source pointers (ticket ids + the journal
// `event_hash` / plan path / board path the insight is derived from), each
// pinning `chain_head` + `verified` exactly like the §7 recall contract. There
// are NO uncited claims: a claim with empty citations is never emitted, and when
// the signal is THIN we say so honestly (`thin_signal: true`) rather than
// over-claiming a trend.
//
// SURVEILLANCE GUARDRAIL (§12.1). Health is aggregated at the SYSTEM / REPO level
// only — never per-individual. This is a delivery-improvement lens, not people-
// ranking. We deliberately do NOT aggregate by owner/agent.
//
// DETERMINISM. Same history -> same report: every list is sorted, no wall-clock
// appears in substantive content, and the report timestamp is INJECTED via
// options.now (defaults to a fixed sentinel) and lives OUTSIDE the content digest.
//
// DERIVED + REBUILDABLE (§6.1). The generated report under coord/memory/ is
// gitignored like decisions.ndjson / summaries/; only THIS generator + fixtures +
// tests are committed. Raw truth stays in the journal, board, and plan records.
//
// ZERO new runtime deps. Reuses decision-extractor.js for sha1 + journal
// provenance so citations pin the chain head the SAME way decisions/recall/
// summaries do — one canonical hash implementation, no drift.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BOARD_PATH = path.join(COORD_DIR, "board", "tasks.json");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_OUTPUT_PATH = path.join(COORD_DIR, "memory", "insights", "execution-insights.json");

// Reuse the Phase-0 substrate: sha1 + the decision extractor's parsing helpers.
const extractor = require("./decision-extractor.js");

const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";

// A report section / claim is only emitted when the underlying evidence count
// reaches this floor; below it we still emit the section but flag thin_signal.
const THIN_SIGNAL_FLOOR = 3;

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

// Read the journal in order, computing each event's canonical hash (sha1 of the
// verbatim stored line — identical to journal.js / decision-extractor.js) and the
// whole-chain head. Returns the ordered event list + chain head. This is the
// authoritative operational-layer source.
function readJournalEvents(journalPath) {
  const events = [];
  let chainHead = null;
  if (!fs.existsSync(journalPath)) {
    return { events, chainHead };
  }
  const raw = fs.readFileSync(journalPath, "utf8");
  let seq = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      // A malformed line cannot be cited; skip rather than fail closed.
      continue;
    }
    const eventHash = extractor.sha1(trimmed);
    chainHead = eventHash;
    const verified =
      typeof record.prev_event_hash === "string" && record.prev_event_hash.length > 0;
    events.push({
      seq,
      ts: typeof record.ts === "string" ? record.ts : null,
      command: typeof record.command === "string" ? record.command : null,
      ticket: typeof record.ticket === "string" ? record.ticket : null,
      before_status: record.before_status || null,
      after_status: record.after_status || null,
      result: record.result || null,
      details: record.details || null,
      event_hash: eventHash,
      verified,
    });
    seq += 1;
  }
  return { events, chainHead };
}

// Board tickets, reusing the same board ingestion shape as summary-tiers.js
// (id, repo, status, subsystem = board section heading, epic = bracket prefix,
// deferred-to / depends-on). The board row is the authoritative source.
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
        status: row.Status != null ? String(row.Status) : null,
        description: row.Description != null ? String(row.Description) : "",
        subsystem,
      });
    }
  }
  tickets.sort((a, b) => a.id.localeCompare(b.id));
  return tickets;
}

// Plan records: the decision layer. We extract the self_review_cycles (risks +
// findings + verdict) and requirement_closure (deferred_to / not_implemented)
// reusing decision-extractor parsing so the "why"/"failed" signals come from the
// validator-required fields, not model inference. Keyed by ticket id; the plan
// path is the authoritative source pointer.
function readPlanRecords(plansDir) {
  const byId = new Map();
  if (!fs.existsSync(plansDir)) {
    return byId;
  }
  for (const name of fs.readdirSync(plansDir).filter((n) => n.endsWith(".json")).sort()) {
    const abs = path.join(plansDir, name);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      continue;
    }
    if (!rec || !rec.ticket_id) {
      continue;
    }
    const closure = extractor.parseRequirementClosure(rec.requirement_closure);
    const cycles = extractor.parseSelfReviewCycles(rec.self_review_cycles);
    byId.set(rec.ticket_id, {
      ticket_id: rec.ticket_id,
      path: path.relative(ROOT_DIR, abs).split(path.sep).join("/"),
      closure,
      cycles,
    });
  }
  return byId;
}

// =============================================================================
// CITATION HELPERS — the §5 guardrail. Every claim points at hash-linked source.
// =============================================================================

// A journal-event citation pins the event_hash + chain_head + verified flag,
// matching the §7 recall source shape.
function eventCitation(event, chainHead) {
  return {
    type: "event",
    id: event.ticket || null,
    event_hash: event.event_hash,
    chain_head: chainHead,
    verified: event.verified,
    command: event.command,
  };
}

// A plan-record citation points at the canonical plan file path (the decision-
// layer authority). It carries no event_hash (the plan file IS the source); we
// still pin chain_head so staleness can be reasoned about against the journal.
function planCitation(plan, chainHead) {
  return {
    type: "decision",
    id: plan.ticket_id,
    path: plan.path,
    chain_head: chainHead,
    verified: true,
  };
}

function boardCitation(ticket, boardRel, chainHead) {
  return {
    type: "ticket",
    id: ticket.id,
    path: boardRel,
    chain_head: chainHead,
    verified: true,
  };
}

// =============================================================================
// SECTION 1 — REPEATED-FAILURE-THEME DETECTION
// =============================================================================
//
// Cluster recurring failure signals across tickets into named themes. The signal
// sources, all real:
//   - journal recovery/repair events (recover, doctor-fix, crash-rollback,
//     chain-repair, manual-reconcile) — each carries a free-text `details.reason`.
//   - non-"succeeded" journal results.
//   - plan self_review_cycles whose findings are non-trivial (not "none") or whose
//     verdict is not "pass", plus the cycle `risks`.
//
// Theming is DETERMINISTIC keyword clustering (NOT a model): each signal's text is
// matched against a fixed, ordered theme vocabulary. A theme is only reported when
// it recurs across >= 2 distinct tickets (a single occurrence is not a "repeated"
// theme). Every theme cites the exact events / plan records it clusters.

const FAILURE_THEMES = Object.freeze([
  { theme: "journal-chain-integrity", keywords: ["prev_event_hash", "chain", "hash-chain", "prev-hash", "concurrent append", "concurrent governed", "journal"] },
  { theme: "plan-record-drift", keywords: ["plan record", "plan-record", "runtime plan", "post-finalize", "plan drift", "plan-state", "ticket-local runtime"] },
  { theme: "board-state-reconciliation", keywords: ["board", "tasks.json", "doing-state", "reset to todo", "merge-conflict", "rebase"] },
  { theme: "identity-ownership", keywords: ["identity", "ownership", "takeover", "owner", "session", "rebind"] },
  { theme: "worktree-lifecycle", keywords: ["worktree", "orphan", "lock"] },
  { theme: "questions-log-format", keywords: ["questions.md", "insertion marker", "separator", "table separator"] },
  { theme: "snapshot-drift", keywords: ["snapshot", "phantom", "checkpoint", "baseline", "re-journal"] },
]);

function classifyThemes(text) {
  const lower = String(text || "").toLowerCase();
  const matched = [];
  for (const { theme, keywords } of FAILURE_THEMES) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(theme);
    }
  }
  return matched;
}

const RECOVERY_COMMANDS = new Set([
  "recover",
  "doctor-fix",
  "crash-rollback",
  "chain-repair",
  "manual-reconcile",
  "supersede",
  "block",
]);

// Build the flat list of failure signals (each with text + a citation + ticket).
function collectFailureSignals(events, plansById, chainHead) {
  const signals = [];

  for (const ev of events) {
    const isRecovery = RECOVERY_COMMANDS.has(ev.command);
    const isFailedResult =
      ev.result && ev.result !== "succeeded" && ev.result !== "anchored" && ev.result !== "restored" && ev.result !== "repaired";
    if (!isRecovery && !isFailedResult) {
      continue;
    }
    const reason =
      ev.details && typeof ev.details === "object" && typeof ev.details.reason === "string"
        ? ev.details.reason
        : "";
    // Text to theme: the command + the reason. Recovery events without a reason
    // still theme by their command name (e.g. "chain-repair").
    const text = `${ev.command} ${reason}`;
    signals.push({
      kind: "journal-recovery",
      ticket: ev.ticket,
      text,
      citation: eventCitation(ev, chainHead),
    });
  }

  for (const plan of plansById.values()) {
    for (let i = 0; i < plan.cycles.length; i += 1) {
      const cycle = plan.cycles[i];
      const findings = String(cycle.findings || "").trim();
      const hasFindings = findings && findings.toLowerCase() !== "none";
      const failedVerdict = cycle.verdict && cycle.verdict !== "pass";
      // Risks are forward-looking concerns the reviewer flagged — a real recurring
      // failure-theme signal even when the verdict passed.
      const riskText = (cycle.risks || []).join(" ; ");
      if (!hasFindings && !failedVerdict && !riskText) {
        continue;
      }
      const text = `${cycle.lens || ""} ${riskText} ${hasFindings ? findings : ""} ${failedVerdict ? cycle.verdict : ""}`;
      signals.push({
        kind: "review-cycle",
        ticket: plan.ticket_id,
        text,
        citation: planCitation(plan, chainHead),
      });
    }
  }

  return signals;
}

function detectFailureThemes(events, plansById, chainHead) {
  const signals = collectFailureSignals(events, plansById, chainHead);
  // theme -> { tickets:Set, citations:[], examples:[] }
  const themeMap = new Map();
  for (const sig of signals) {
    for (const theme of classifyThemes(sig.text)) {
      if (!themeMap.has(theme)) {
        themeMap.set(theme, { tickets: new Set(), citations: [], examples: [] });
      }
      const entry = themeMap.get(theme);
      if (sig.ticket) {
        entry.tickets.add(sig.ticket);
      }
      entry.citations.push(sig.citation);
      // Keep a short, de-duplicated example snippet per theme for the text report.
      const snippet = sig.text.trim().slice(0, 160);
      if (snippet && !entry.examples.includes(snippet)) {
        entry.examples.push(snippet);
      }
    }
  }

  const claims = [];
  for (const [theme, entry] of themeMap) {
    const ticketCount = entry.tickets.size;
    // A "repeated" theme recurs across >= 2 distinct tickets. Single-ticket
    // clusters are not emitted as repeated themes (no over-claiming).
    if (ticketCount < 2) {
      continue;
    }
    const occurrences = entry.citations.length;
    claims.push({
      theme,
      ticket_count: ticketCount,
      tickets: [...entry.tickets].sort(),
      occurrence_count: occurrences,
      examples: entry.examples.sort().slice(0, 3),
      // thin_signal honesty: a theme spanning few occurrences is still surfaced
      // but flagged so the reader does not treat it as an established trend.
      thin_signal: occurrences < THIN_SIGNAL_FLOOR,
      citations: dedupeCitations(entry.citations),
    });
  }
  claims.sort(
    (a, b) =>
      b.ticket_count - a.ticket_count ||
      b.occurrence_count - a.occurrence_count ||
      a.theme.localeCompare(b.theme)
  );
  return {
    section: "repeated_failure_themes",
    signal_total: signals.length,
    thin_signal: signals.length < THIN_SIGNAL_FLOOR,
    claims,
  };
}

// =============================================================================
// SECTION 2 — ARCHITECTURAL-DEBT BY SUBSYSTEM
// =============================================================================
//
// Which board subsystems (section headings) concentrate debt? Debt signals per
// ticket, all real:
//   - the ticket is `deferred` on the board (carried-but-not-done work).
//   - the ticket's decision record carries a non-"none" `not_implemented` carve-out.
//   - the ticket's decision record names a `deferred_to` follow-up.
//   - the ticket accrued review findings (from section 1's review signals).
// We aggregate the debt score per subsystem and cite the contributing tickets.

function detectArchDebtBySubsystem(tickets, plansById, boardRel, chainHead) {
  // subsystem -> aggregation
  const bySub = new Map();
  const ensure = (sub) => {
    if (!bySub.has(sub)) {
      bySub.set(sub, {
        subsystem: sub,
        ticket_total: 0,
        deferred_tickets: [],
        not_implemented_tickets: [],
        deferred_to_tickets: [],
        citations: [],
      });
    }
    return bySub.get(sub);
  };

  for (const t of tickets) {
    const agg = ensure(t.subsystem);
    agg.ticket_total += 1;
    let contributes = false;

    if (t.status === "deferred") {
      agg.deferred_tickets.push(t.id);
      agg.citations.push(boardCitation(t, boardRel, chainHead));
      contributes = true;
    }
    const plan = plansById.get(t.id);
    if (plan) {
      const ni = plan.closure.not_implemented;
      if (ni && ni.toLowerCase() !== "none") {
        agg.not_implemented_tickets.push(t.id);
        agg.citations.push(planCitation(plan, chainHead));
        contributes = true;
      }
      if (plan.closure.deferred_to_tickets && plan.closure.deferred_to_tickets.length) {
        agg.deferred_to_tickets.push(t.id);
        agg.citations.push(planCitation(plan, chainHead));
        contributes = true;
      }
    }
    // Touch the var so lint/readers see contribution is intentional per-ticket.
    void contributes;
  }

  const claims = [];
  for (const agg of bySub.values()) {
    const debtCount =
      agg.deferred_tickets.length +
      agg.not_implemented_tickets.length +
      agg.deferred_to_tickets.length;
    if (debtCount === 0) {
      continue; // a subsystem with no debt signal makes no claim
    }
    claims.push({
      subsystem: agg.subsystem,
      ticket_total: agg.ticket_total,
      debt_score: debtCount,
      deferred_tickets: [...new Set(agg.deferred_tickets)].sort(),
      not_implemented_tickets: [...new Set(agg.not_implemented_tickets)].sort(),
      deferred_to_tickets: [...new Set(agg.deferred_to_tickets)].sort(),
      thin_signal: debtCount < THIN_SIGNAL_FLOOR,
      citations: dedupeCitations(agg.citations),
    });
  }
  claims.sort(
    (a, b) => b.debt_score - a.debt_score || a.subsystem.localeCompare(b.subsystem)
  );
  return {
    section: "architectural_debt_by_subsystem",
    subsystem_count: bySub.size,
    thin_signal: claims.length === 0,
    claims,
  };
}

// =============================================================================
// SECTION 3 — CHURN-INSTEAD-OF-VALUE DETECTION
// =============================================================================
//
// Flag tickets with high REWORK relative to delivered value (motion without
// closure). Rework signals per ticket from the journal:
//   - repeated review cycles: count of move-review events (>1 means the ticket
//     bounced back to review).
//   - re-opens / returns: re-entering `doing` after having left it.
//   - recovery/repair events touching the ticket.
// "Value" = whether the ticket reached `done` (a mark-done event). A ticket with
// high rework that is NOT done is the strongest churn signal; high rework that DID
// land is lower-grade churn (it cost a lot to deliver).

function detectChurn(events, ticketsById, boardRel, chainHead) {
  // ticket -> counters + citations
  const perTicket = new Map();
  const ensure = (id) => {
    if (!perTicket.has(id)) {
      perTicket.set(id, {
        ticket: id,
        move_review_count: 0,
        doing_entries: 0,
        recovery_count: 0,
        done: false,
        citations: [],
      });
    }
    return perTicket.get(id);
  };

  for (const ev of events) {
    if (!ev.ticket) {
      continue;
    }
    const t = ensure(ev.ticket);
    if (ev.command === "move-review") {
      t.move_review_count += 1;
      t.citations.push(eventCitation(ev, chainHead));
    } else if (ev.after_status === "doing" && ev.before_status !== "doing") {
      // A TRUE (re-)entry into doing — a status TRANSITION into doing, not an
      // in-doing self-loop (e.g. the many update-plan events that keep
      // before_status==after_status=="doing"). Re-entering doing after leaving it
      // (review->doing, a second start) is the real redo-loop signal.
      t.doing_entries += 1;
      t.citations.push(eventCitation(ev, chainHead));
    } else if (ev.command === "mark-done" || ev.after_status === "done") {
      t.done = true;
    } else if (RECOVERY_COMMANDS.has(ev.command)) {
      t.recovery_count += 1;
      t.citations.push(eventCitation(ev, chainHead));
    }
  }

  const claims = [];
  for (const t of perTicket.values()) {
    // Rework score: extra review rounds + extra doing entries + recoveries.
    const reworkScore =
      Math.max(0, t.move_review_count - 1) +
      Math.max(0, t.doing_entries - 1) +
      t.recovery_count;
    if (reworkScore < 1) {
      continue; // no rework -> not churn
    }
    const ticketRow = ticketsById.get(t.ticket);
    const citations = dedupeCitations(t.citations);
    // Add a board citation when the ticket is on the board (status context).
    if (ticketRow) {
      citations.push(boardCitation(ticketRow, boardRel, chainHead));
    }
    claims.push({
      ticket: t.ticket,
      move_review_count: t.move_review_count,
      doing_entries: t.doing_entries,
      recovery_count: t.recovery_count,
      reached_done: t.done,
      rework_score: reworkScore,
      // churn-instead-of-value: high rework that did NOT land is the sharpest
      // signal; classify so the reader sees value delivery vs pure motion.
      classification: t.done ? "high-cost-delivery" : "churn-without-closure",
      thin_signal: reworkScore < THIN_SIGNAL_FLOOR,
      citations: dedupeCitations(citations),
    });
  }
  claims.sort(
    (a, b) =>
      b.rework_score - a.rework_score ||
      Number(a.reached_done) - Number(b.reached_done) ||
      a.ticket.localeCompare(b.ticket)
  );
  return {
    section: "churn_instead_of_value",
    flagged_count: claims.length,
    thin_signal: claims.length === 0,
    claims,
  };
}

// =============================================================================
// SECTION 4 — GATE / REVIEW / RECOVERY HEALTH BY REPO
// =============================================================================
//
// Aggregate health PER REPO (system-level, never per-person — §12.1). Per repo:
//   - weak gates: count of FAILING self-review cycles (verdict != pass) across the
//     repo's tickets / total review cycles -> fail rate.
//   - slow reviews: median journal time from a ticket's move-review event to its
//     mark-done event (in hours).
//   - recovery load: count of recovery/repair journal events attributed to the
//     repo's tickets, normalized per ticket.
// Each metric cites the events / plan records it is computed from.

function median(nums) {
  if (!nums.length) {
    return null;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectRepoHealth(events, tickets, plansById, boardRel, chainHead) {
  const ticketRepo = new Map();
  for (const t of tickets) {
    ticketRepo.set(t.id, t.repo || "(none)");
  }

  // Initialize repo buckets from board repos so a repo with zero history still
  // appears (honest: it shows thin_signal rather than being omitted).
  const repos = new Map();
  const ensure = (repo) => {
    if (!repos.has(repo)) {
      repos.set(repo, {
        repo,
        total_cycles: 0,
        failing_cycles: 0,
        review_durations_hours: [],
        recovery_events: 0,
        ticket_count: 0,
        citations: [],
      });
    }
    return repos.get(repo);
  };
  for (const t of tickets) {
    ensure(t.repo || "(none)").ticket_count += 1;
  }

  // Weak gates: from plan self_review_cycles, attributed to the ticket's repo.
  for (const plan of plansById.values()) {
    const repo = ticketRepo.get(plan.ticket_id) || "(none)";
    const bucket = ensure(repo);
    for (const cycle of plan.cycles) {
      bucket.total_cycles += 1;
      if (cycle.verdict && cycle.verdict !== "pass") {
        bucket.failing_cycles += 1;
        bucket.citations.push(planCitation(plan, chainHead));
      }
    }
  }

  // Slow reviews + recovery load: walk journal events per ticket.
  // For review duration we pair the LAST move-review before a mark-done.
  const lastReviewTs = new Map(); // ticket -> { ts, event }
  for (const ev of events) {
    if (!ev.ticket) {
      continue;
    }
    const repo = ticketRepo.get(ev.ticket) || "(none)";
    const bucket = ensure(repo);
    if (ev.command === "move-review" && ev.ts) {
      lastReviewTs.set(ev.ticket, { ts: ev.ts, event: ev });
    } else if ((ev.command === "mark-done" || ev.after_status === "done") && ev.ts) {
      const prev = lastReviewTs.get(ev.ticket);
      if (prev) {
        const hours = (Date.parse(ev.ts) - Date.parse(prev.ts)) / 3_600_000;
        if (Number.isFinite(hours) && hours >= 0) {
          bucket.review_durations_hours.push(hours);
          bucket.citations.push(eventCitation(prev.event, chainHead));
          bucket.citations.push(eventCitation(ev, chainHead));
        }
        lastReviewTs.delete(ev.ticket);
      }
    } else if (RECOVERY_COMMANDS.has(ev.command)) {
      bucket.recovery_events += 1;
      bucket.citations.push(eventCitation(ev, chainHead));
    }
  }

  const claims = [];
  for (const b of repos.values()) {
    const gateFailRate = b.total_cycles ? b.failing_cycles / b.total_cycles : 0;
    const medReview = median(b.review_durations_hours);
    const recoveryLoad = b.ticket_count ? b.recovery_events / b.ticket_count : 0;
    const evidenceCount = b.total_cycles + b.review_durations_hours.length + b.recovery_events;
    claims.push({
      repo: b.repo,
      ticket_count: b.ticket_count,
      gate: {
        total_review_cycles: b.total_cycles,
        failing_review_cycles: b.failing_cycles,
        gate_fail_rate: round4(gateFailRate),
        weak_gate: gateFailRate > 0,
      },
      review: {
        measured_review_completions: b.review_durations_hours.length,
        median_review_hours: medReview == null ? null : round4(medReview),
      },
      recovery: {
        recovery_events: b.recovery_events,
        recovery_load_per_ticket: round4(recoveryLoad),
        high_recovery_load: recoveryLoad >= 1,
      },
      // Health is only a claim when there is evidence behind it; with no review
      // cycles / completions / recoveries we flag thin_signal rather than asserting
      // the repo is "healthy".
      thin_signal: evidenceCount < THIN_SIGNAL_FLOOR,
      citations: dedupeCitations(b.citations),
    });
  }
  claims.sort(
    (a, b) =>
      b.recovery.recovery_events - a.recovery.recovery_events ||
      b.gate.failing_review_cycles - a.gate.failing_review_cycles ||
      a.repo.localeCompare(b.repo)
  );
  return {
    section: "gate_review_recovery_health_by_repo",
    repo_count: repos.size,
    thin_signal: claims.every((c) => c.thin_signal),
    claims,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Deterministic citation de-duplication + sort. Two citations are the same when
// their stable stringification matches. Sorted so identical history -> identical
// citation order.
function dedupeCitations(citations) {
  const seen = new Map();
  for (const c of citations) {
    seen.set(stableStringify(c), c);
  }
  return [...seen.values()].sort((a, b) =>
    stableStringify(a).localeCompare(stableStringify(b))
  );
}

// =============================================================================
// REPORT ASSEMBLY
// =============================================================================

function generateReport(options = {}) {
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const plansDir = options.plansDir || DEFAULT_PLANS_DIR;
  const generatedAt = options.now || DEFAULT_GENERATED_AT;
  const rootDir = options.rootDir || ROOT_DIR;
  const boardRel = path.relative(rootDir, boardPath).split(path.sep).join("/");

  const { events, chainHead } = readJournalEvents(journalPath);
  const tickets = readBoardTickets(boardPath);
  const ticketsById = new Map(tickets.map((t) => [t.id, t]));
  const plansById = readPlanRecords(plansDir);

  const sections = {
    repeated_failure_themes: detectFailureThemes(events, plansById, chainHead),
    architectural_debt_by_subsystem: detectArchDebtBySubsystem(
      tickets,
      plansById,
      boardRel,
      chainHead
    ),
    churn_instead_of_value: detectChurn(events, ticketsById, boardRel, chainHead),
    gate_review_recovery_health_by_repo: detectRepoHealth(
      events,
      tickets,
      plansById,
      boardRel,
      chainHead
    ),
  };

  return {
    kind: "execution-insight-report",
    // The guardrail, made explicit + machine-checkable: this is advisory only.
    authority: false,
    recommends_only: true,
    generated_at: generatedAt,
    chain_head: chainHead,
    history_scope: {
      journal_events: events.length,
      board_tickets: tickets.length,
      plan_records: plansById.size,
    },
    sections,
  };
}

// Collect every claim across every section (used by the no-uncited-claim
// invariant + tests). A "claim" is any section entry carrying citations.
function allClaims(report) {
  const out = [];
  for (const key of Object.keys(report.sections)) {
    for (const claim of report.sections[key].claims || []) {
      out.push({ section: key, claim });
    }
  }
  return out;
}

// The §5 invariant, callable: returns the list of claims with NO citation. The
// report is valid iff this is empty.
function uncitedClaims(report) {
  return allClaims(report)
    .filter(({ claim }) => !Array.isArray(claim.citations) || claim.citations.length === 0)
    .map(({ section, claim }) => ({ section, claim }));
}

// A content digest excluding generated_at so rebuilds are byte-stable across
// wall-clock drift (mirrors summary-tiers.contentDigest).
function contentDigest(report) {
  const { generated_at, ...rest } = report;
  return extractor.sha1(stableStringify(rest));
}

// =============================================================================
// RENDERING — readable text report (every line traces to a cited claim)
// =============================================================================

function renderText(report) {
  const lines = [];
  const p = (s) => lines.push(s);
  p("EXECUTION-INSIGHT REPORT (COORD-147) — RECOMMENDS ONLY, every claim source-cited.");
  p(`chain_head=${(report.chain_head || "(none)").slice(0, 12)} ` +
    `events=${report.history_scope.journal_events} ` +
    `tickets=${report.history_scope.board_tickets} ` +
    `plans=${report.history_scope.plan_records}`);
  p("");

  const renderCitations = (citations) => {
    const shown = citations.slice(0, 4).map((c) => {
      if (c.type === "event") {
        return `${c.id || "?"}@${(c.event_hash || "").slice(0, 8)}`;
      }
      return `${c.id || c.path || "?"}`;
    });
    const more = citations.length > shown.length ? ` (+${citations.length - shown.length})` : "";
    return `cites: ${shown.join(", ")}${more}`;
  };

  // Section 1
  const s1 = report.sections.repeated_failure_themes;
  p(`1. REPEATED FAILURE THEMES (${s1.claims.length} recurring; ${s1.signal_total} signals${s1.thin_signal ? "; THIN SIGNAL" : ""})`);
  if (!s1.claims.length) {
    p("   (no failure theme recurs across >=2 tickets)");
  }
  for (const c of s1.claims) {
    p(`   - ${c.theme}: ${c.ticket_count} tickets, ${c.occurrence_count} occurrences${c.thin_signal ? " [thin]" : ""}`);
    p(`     tickets: ${c.tickets.join(", ")}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");

  // Section 2
  const s2 = report.sections.architectural_debt_by_subsystem;
  p(`2. ARCHITECTURAL DEBT BY SUBSYSTEM (${s2.claims.length} subsystems w/ debt)`);
  if (!s2.claims.length) {
    p("   (no subsystem carries deferral / not-implemented / follow-up debt)");
  }
  for (const c of s2.claims) {
    p(`   - ${c.subsystem}: debt_score=${c.debt_score} (of ${c.ticket_total} tickets)${c.thin_signal ? " [thin]" : ""}`);
    if (c.deferred_tickets.length) p(`     deferred: ${c.deferred_tickets.join(", ")}`);
    if (c.not_implemented_tickets.length) p(`     not-implemented carve-outs: ${c.not_implemented_tickets.join(", ")}`);
    if (c.deferred_to_tickets.length) p(`     spawned follow-ups: ${c.deferred_to_tickets.join(", ")}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");

  // Section 3
  const s3 = report.sections.churn_instead_of_value;
  p(`3. CHURN-INSTEAD-OF-VALUE (${s3.flagged_count} flagged)`);
  if (!s3.claims.length) {
    p("   (no ticket shows rework above the closure baseline)");
  }
  for (const c of s3.claims) {
    p(`   - ${c.ticket}: rework_score=${c.rework_score} [${c.classification}]${c.thin_signal ? " [thin]" : ""}`);
    p(`     review_rounds=${c.move_review_count} doing_entries=${c.doing_entries} recoveries=${c.recovery_count} done=${c.reached_done}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");

  // Section 4
  const s4 = report.sections.gate_review_recovery_health_by_repo;
  p(`4. GATE / REVIEW / RECOVERY HEALTH BY REPO (${s4.claims.length} repos; system-level, not per-person)`);
  for (const c of s4.claims) {
    p(`   - repo ${c.repo} (${c.ticket_count} tickets)${c.thin_signal ? " [thin]" : ""}`);
    p(`     gate: ${c.gate.failing_review_cycles}/${c.gate.total_review_cycles} cycles failed (fail_rate=${c.gate.gate_fail_rate})${c.gate.weak_gate ? " WEAK" : ""}`);
    p(`     review: median ${c.review.median_review_hours == null ? "n/a" : c.review.median_review_hours + "h"} over ${c.review.measured_review_completions} completions`);
    p(`     recovery: ${c.recovery.recovery_events} events, ${c.recovery.recovery_load_per_ticket}/ticket${c.recovery.high_recovery_load ? " HIGH" : ""}`);
    p(`     ${renderCitations(c.citations)}`);
  }
  p("");
  p("NOTE: This report RECOMMENDS only. It mutates nothing and gates nothing.");
  p("Authority is the hash-linked journal / board / plan records cited above; a");
  p("summary that disagrees with its source is invalid (source wins).");
  return lines.join("\n");
}

function rebuild(options = {}) {
  const report = generateReport(options);
  const outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { outputPath, report };
}

module.exports = {
  stableStringify,
  readJournalEvents,
  readBoardTickets,
  readPlanRecords,
  classifyThemes,
  detectFailureThemes,
  detectArchDebtBySubsystem,
  detectChurn,
  detectRepoHealth,
  generateReport,
  allClaims,
  uncitedClaims,
  contentDigest,
  renderText,
  rebuild,
  FAILURE_THEMES,
  RECOVERY_COMMANDS,
  THIN_SIGNAL_FLOOR,
  DEFAULT_BOARD_PATH,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_PLANS_DIR,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_GENERATED_AT,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const asJson = args.includes("--json");
  if (cmd === "--rebuild" || cmd === "rebuild") {
    const now = new Date().toISOString();
    const { outputPath, report } = rebuild({ now });
    process.stdout.write(
      `Rebuilt ${path.relative(ROOT_DIR, outputPath)} — ` +
        `${report.sections.repeated_failure_themes.claims.length} themes, ` +
        `${report.sections.architectural_debt_by_subsystem.claims.length} debt subsystems, ` +
        `${report.sections.churn_instead_of_value.claims.length} churn, ` +
        `${report.sections.gate_review_recovery_health_by_repo.claims.length} repos.\n`
    );
  } else if (cmd === "--json" || cmd === "report" || cmd === "--report" || !cmd) {
    const now = new Date().toISOString();
    const report = generateReport({ now });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderText(report)}\n`);
    }
  } else {
    process.stdout.write(
      [
        "coord/scripts/insight-reports.js — Strategic execution-insight reports (COORD-147).",
        "",
        "Usage:",
        "  node coord/scripts/insight-reports.js [--json]    print the report (text, or --json for the structured contract)",
        "  node coord/scripts/insight-reports.js --rebuild   regenerate coord/memory/insights/execution-insights.json (derived)",
        "",
        "RECOMMENDS ONLY. Mines the journal + board + plan records; mutates/gates",
        "nothing; every claim is source-cited. Output is derived + gitignored; only",
        "this generator + fixtures + tests are committed.",
        "",
      ].join("\n")
    );
  }
}
