"use strict";

// COORD-148: [Memory] Solving — pre-work CONTEXT PACK + prevent-repeated-failed-
// approaches.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §4 ("Solving — all layers") this module
// produces, BEFORE an agent starts a ticket, a SOURCE-CITED pre-work context
// pack so the agent (a) sees the most relevant prior work, (b) is WARNED about
// already-failed approaches in the touched area so it does not repeat them, and
// (c) gets a RECOMMENDED safe work decomposition + test selection derived from
// the touched area + the area's failure history.
//
// It COMPOSES the landed substrate — it does NOT re-implement retrieval or
// failure-detection:
//   - COORD-141 recall.js            -> relevant prior tickets/decisions/files
//                                       (the §7 source-cited retrieval engine).
//   - COORD-140 decision-extractor.js-> per-ticket self_review risks/findings
//                                       (past failures) + journal provenance/sha1.
//   - COORD-147 insight-reports.js   -> repeated-failure-theme detection + the
//                                       journal recovery-event mining reused to
//                                       surface already-failed approaches.
// One canonical sha1 + journal-provenance implementation flows through all of
// them, so every citation here pins event_hash + chain_head + verified the SAME
// way recall (§7) does — NO drift.
//
// THE PACK — three sections, every item SOURCE-CITED (§5):
//   1. relevant_prior_work     — recall over the ticket's text (id + description)
//                                and/or a free-text scope: prior tickets /
//                                decisions / files / gates / fixes, ranked +
//                                cited (recall sources passthrough).
//   2. already_failed_approaches — for the TOUCHED AREA: mined from decision
//                                records' self_review risks/findings (failed
//                                verdicts + flagged risks) + journal recovery
//                                events + COORD-147 repeated-failure-themes that
//                                intersect the touched area. Each carries its
//                                hash-linked citation so the warning is
//                                traceable, never asserted.
//   3. recommended_plan        — a safe work decomposition + test selection: the
//                                touched-area test files/areas the agent should
//                                run GIVEN what historically broke here, each
//                                step cited to the failure/recall evidence that
//                                motivates it.
//
// CARDINAL GUARDRAIL (§5) — RECOMMENDS ONLY. The pack:
//   - is stamped { authority:false, recommends_only:true };
//   - NEVER gates, blocks, auto-starts, claims, or mutates anything;
//   - is a PURE READ over already-committed memory (journal/board/plans/files);
//   - emits NO uncited recommendation (a section item with empty citations is
//     never emitted) — assertable via uncitedItems().
// Execution stays gated by the normal lane; this is advisory input the agent
// reads at start-readiness time, alongside `gov explain`.
//
// DETERMINISM. Same history + same ticket -> same pack: every list is sorted, no
// wall-clock appears in substantive content, and the pack timestamp is INJECTED
// via options.now (defaults to a fixed sentinel) and lives OUTSIDE the content
// digest (mirrors insight-reports / summary-tiers).
//
// ZERO new runtime deps. Reuses recall.js + decision-extractor.js +
// insight-reports.js. No new derived artifact is written by default (the pack is
// produced on demand for a start-readiness surface); --rebuild is intentionally
// NOT provided (there is no per-ticket derived file to gitignore).

const fs = require("fs");
const path = require("path");

const recall = require("./recall.js");
const extractor = require("./decision-extractor.js");
const insights = require("./insight-reports.js");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BOARD_PATH = path.join(COORD_DIR, "board", "tasks.json");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_DECISIONS_PATH = recall.DEFAULT_DECISIONS_PATH;

const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";

// How many relevant prior-work hits to surface (recall top-k).
const DEFAULT_PRIOR_K = 6;

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
// SCOPE RESOLUTION — derive the "touched area" we retrieve + warn against.
// =============================================================================

// Read one board ticket row by id (the authoritative description + repo +
// subsystem section). Returns null when the id is absent (free-text-only scope).
function readBoardTicket(boardPath, ticketId) {
  if (!ticketId || !fs.existsSync(boardPath)) {
    return null;
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch (error) {
    return null;
  }
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
          depends_on: row["Depends On"] != null ? String(row["Depends On"]) : "",
        };
      }
    }
  }
  return null;
}

// Resolve the scope query the pack retrieves over. A ticket id contributes its
// id + description + subsystem; a free-text scope is appended. We deliberately
// KEEP the id in the query so recall's exact-id pass surfaces the ticket's own
// decision record (and its prior failures) when one exists. Deterministic: the
// query is assembled in a fixed order.
function resolveScope(options) {
  const ticketId = options.ticketId ? String(options.ticketId).trim() : null;
  const freeText = options.scope ? String(options.scope).trim() : "";
  const ticket = readBoardTicket(options.boardPath || DEFAULT_BOARD_PATH, ticketId);
  const parts = [];
  if (ticketId) {
    parts.push(ticketId);
  }
  if (ticket && ticket.description) {
    parts.push(ticket.description);
  }
  if (ticket && ticket.subsystem && ticket.subsystem !== "(unsectioned)") {
    parts.push(ticket.subsystem);
  }
  if (freeText) {
    parts.push(freeText);
  }
  return {
    ticket_id: ticketId,
    ticket,
    free_text: freeText || null,
    subsystem: ticket ? ticket.subsystem : null,
    repo: ticket ? ticket.repo : null,
    query: parts.join(" ").trim(),
  };
}

// Generic governance / process / boilerplate vocabulary that appears on almost
// every ticket and recovery reason. Including these as AREA tokens would make
// "already-failed approaches" match nearly all history (every ticket "starts",
// every reason mentions "ticket"/"plan"/"board"). We strip them so the touched
// AREA is defined by the DISTINCTIVE domain tokens of the ticket, not the shared
// governance scaffolding. Deterministic, fixed list. NOTE: this is a relevance
// filter for SECTION 2 (failure mining) only — SECTION 1 recall keeps the full
// query (BM25 already down-weights common terms via idf).
const AREA_GENERIC_STOP = new Set([
  "memory", "ticket", "tickets", "plan", "plans", "board", "agent", "agents",
  "start", "starts", "started", "work", "works", "worked", "before", "after",
  "approach", "approaches", "retrieve", "surface", "recommend", "recommends",
  "recommended", "execution", "gated", "gate", "gates", "governance", "governed",
  "source", "sources", "cited", "citation", "capability", "layer", "layers",
  "feature", "docs", "doc", "code", "file", "files", "past", "prior", "relevant",
  "decision", "decisions", "fix", "fixes", "fixed", "test", "tests", "pre",
  "context", "pack", "subsystem", "coord", "per", "repeat", "repeated", "failed",
  "failure", "failures", "selection", "decomposition", "safe", "solving", "seed",
  "backlog", "phase", "phased",
  // common suffix-stripped stems the recall tokenizer also emits for the above,
  // plus low-signal area words that would over-match free-text reasons.
  "fail", "failur", "solv", "touch", "touched", "touched-area", "area", "stay",
  "stays", "most", "only", "all", "not", "already", "already-fail",
  "already-failed", "prevent", "prevent-repeated-failed-approach",
  "prevent-repeated-failed-approaches", "architecture", "memory_architecture",
  "pre-work", "govern", "recommend", "retriev", "surfac", "decomposit",
]);

// The set of tokens that define the "touched area" for failure mining — the
// query tokens (reusing recall's deterministic tokenizer so the area vocabulary
// matches the corpus vocabulary), MINUS the ticket id tokens (a failure on THIS
// exact id is not an "area" theme) and MINUS the generic governance vocabulary
// above (which would over-match). What remains is the ticket's distinctive
// domain area.
// Minimum area-token length. The recall tokenizer emits short suffix-stripped
// stems ("gat", "fil", "fail") and split fragments that match almost any text;
// requiring length >= 4 keeps only DISTINCTIVE domain words, so the area is
// meaningful (and unrelated failures are not pulled in on a 3-letter fragment).
const AREA_MIN_TOKEN_LEN = 4;

function touchedAreaTokens(scope) {
  const raw = recall.tokenize(scope.query);
  const idTokens = new Set(
    scope.ticket_id ? recall.tokenize(scope.ticket_id) : []
  );
  return new Set(
    raw.filter(
      (t) =>
        t.length >= AREA_MIN_TOKEN_LEN &&
        !idTokens.has(t) &&
        !AREA_GENERIC_STOP.has(t)
    )
  );
}

// Does a free-text blob intersect the touched area? Deterministic token overlap.
// A match requires at least one shared NON-trivial area token, so unrelated
// failures (no shared vocabulary) are NOT surfaced.
function intersectsArea(text, areaTokens) {
  if (!areaTokens.size) {
    return false;
  }
  const toks = new Set(recall.tokenize(text));
  for (const t of toks) {
    if (areaTokens.has(t)) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// SECTION 1 — RELEVANT PRIOR WORK (compose recall.js)
// =============================================================================
//
// Delegate retrieval wholesale to the COORD-141 recall engine over the resolved
// scope query. recall already returns §7 source-cited hits (tickets/decisions/
// files) ranked id->BM25->provenance. We surface its sources verbatim (the
// citation shape we re-emit everywhere) plus the matched snippet text, and carry
// recall's own confidence/staleness through.
function buildRelevantPriorWork(scope, options) {
  if (!scope.query) {
    return { items: [], confidence: "low", staleness: "fresh", recall_query: "" };
  }
  const result = recall.recall(scope.query, {
    topK: options.priorK || DEFAULT_PRIOR_K,
    // role passthrough so a permission-scoped caller gets redacted citations.
    role: options.role || null,
    // Allow tests to inject a fixture corpus / paths.
    corpus: options.corpus,
    decisionsPath: options.decisionsPath,
    journalPath: options.journalPath,
    rootDir: options.rootDir,
  });
  const snippetLines = result.answer ? result.answer.split("\n\n") : [];
  const items = result.sources.map((source, i) => ({
    // The recall source IS the citation (already §7-shaped). We wrap it so each
    // prior-work item carries exactly one citation, like every other section.
    summary: snippetLines[i] || labelForSource(source),
    citations: [normalizeCitation(source)],
  }));
  return {
    items,
    confidence: result.confidence,
    staleness: result.staleness,
    recall_query: scope.query,
  };
}

function labelForSource(source) {
  if (source.id) {
    return `${source.id}${source.path ? ` (${source.path})` : ""}`;
  }
  return source.path || "(source)";
}

// Normalize a citation to the shared §7 shape so all three sections cite
// identically. Tolerates the recall `source` shape and the insight `citation`
// shape (which omits event_hash on plan-path citations).
function normalizeCitation(c) {
  return {
    type: c.type || "decision",
    id: c.id != null ? c.id : null,
    path: c.path != null ? c.path : null,
    event_hash: c.event_hash != null ? c.event_hash : null,
    chain_head: c.chain_head != null ? c.chain_head : null,
    verified: Boolean(c.verified),
  };
}

// =============================================================================
// SECTION 2 — ALREADY-FAILED APPROACHES (compose decision-extractor + journal
// recovery mining + COORD-147 failure-themes), filtered to the touched area.
// =============================================================================
//
// Three real, hash-linked failure signal sources, each filtered to the touched
// area so an UNRELATED failure (no shared area vocabulary) is NOT surfaced:
//
//   (a) decision-record self_review: a cycle whose verdict != "pass" (a failed
//       review round) OR whose risks name a hazard — the canonical "we tried X
//       and it broke / we flagged X as dangerous" record. Cited to the decision
//       record (path + chain_head + verified), reusing decision-extractor's
//       parse so the signal comes from validator-required fields, not inference.
//   (b) journal recovery/repair events (recover, manual-reconcile, chain-repair,
//       doctor-fix, crash-rollback): a concrete past breakage + its `reason`.
//       Cited to the event_hash (verified by the hash chain).
//   (c) COORD-147 repeated-failure-themes that intersect the touched area: a
//       cross-ticket pattern ("this class of thing keeps breaking here"). Cited
//       to the theme's underlying citations.
//
// Determinism: every list sorted; the area filter is pure token overlap.

const RECOVERY_COMMANDS = insights.RECOVERY_COMMANDS;

function readDecisionRecords(decisionsPath) {
  // Reuse recall's decision corpus reader indirectly: read the same NDJSON the
  // extractor emits. We parse here (not via recall) because we need the raw
  // self_review array + closure, not the BM25 doc shape.
  const out = [];
  if (!fs.existsSync(decisionsPath)) {
    return out;
  }
  const raw = fs.readFileSync(decisionsPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (rec && rec.ticket_id && rec.source) {
      out.push(rec);
    }
  }
  return out;
}

function minePastReviewFailures(decisions, areaTokens, currentTicketId) {
  const items = [];
  for (const rec of decisions) {
    // A ticket's OWN record is allowed as prior context, but if it is the ticket
    // we are starting we skip its self-failures (it hasn't been worked yet; any
    // record present is stale/seed). The pack is about OTHER prior work.
    if (currentTicketId && rec.ticket_id === currentTicketId) {
      continue;
    }
    for (const cycle of rec.self_review || []) {
      const findings = String(cycle.findings || "").trim();
      const hasFindings = findings && findings.toLowerCase() !== "none";
      const failedVerdict = cycle.verdict && cycle.verdict !== "pass";
      const riskText = (cycle.risks || [])
        .map((r) => String(r).trim())
        .filter((r) => r && r.toLowerCase() !== "none")
        .join("; ");
      if (!hasFindings && !failedVerdict && !riskText) {
        continue;
      }
      const text = `${cycle.lens || ""} ${riskText} ${hasFindings ? findings : ""}`;
      if (!intersectsArea(text, areaTokens)) {
        continue;
      }
      const warning = failedVerdict
        ? `${rec.ticket_id}: a review cycle FAILED — ${hasFindings ? findings : riskText}`
        : `${rec.ticket_id}: flagged risk — ${riskText || findings}`;
      items.push({
        kind: "review-failure",
        ticket: rec.ticket_id,
        approach: (cycle.lens || "review").trim(),
        warning: warning.slice(0, 240),
        citations: [normalizeCitation(rec.source)],
      });
    }
  }
  return items;
}

function minePastRecoveries(events, areaTokens, chainHead) {
  const items = [];
  for (const ev of events) {
    if (!RECOVERY_COMMANDS.has(ev.command)) {
      continue;
    }
    const reason =
      ev.details && typeof ev.details === "object" && typeof ev.details.reason === "string"
        ? ev.details.reason
        : "";
    const text = `${ev.command} ${reason}`;
    if (!intersectsArea(text, areaTokens)) {
      continue;
    }
    items.push({
      kind: "recovery",
      ticket: ev.ticket || null,
      approach: ev.command,
      warning: `${ev.command}${ev.ticket ? ` on ${ev.ticket}` : ""}: ${reason || "recovery/repair was required here"}`.slice(0, 240),
      citations: [
        normalizeCitation({
          type: "event",
          id: ev.ticket || null,
          path: null,
          event_hash: ev.event_hash,
          chain_head: chainHead,
          verified: ev.verified,
        }),
      ],
    });
  }
  return items;
}

function mineAreaFailureThemes(report, areaTokens) {
  const items = [];
  const themes = report.sections.repeated_failure_themes.claims || [];
  for (const theme of themes) {
    // A theme name + its example snippets define its vocabulary; surface it only
    // when it intersects the touched area.
    const themeText = `${theme.theme.replace(/-/g, " ")} ${(theme.examples || []).join(" ")}`;
    if (!intersectsArea(themeText, areaTokens)) {
      continue;
    }
    items.push({
      kind: "repeated-theme",
      ticket: null,
      approach: theme.theme,
      warning:
        `recurring failure theme "${theme.theme}" across ${theme.ticket_count} tickets ` +
        `(${theme.tickets.join(", ")}) — do not repeat the approaches that triggered it`,
      citations: (theme.citations || []).map(normalizeCitation),
    });
  }
  return items;
}

function buildAlreadyFailedApproaches(scope, sources) {
  const areaTokens = touchedAreaTokens(scope);
  const items = [
    ...minePastReviewFailures(sources.decisions, areaTokens, scope.ticket_id),
    ...minePastRecoveries(sources.events, areaTokens, sources.chainHead),
    ...mineAreaFailureThemes(sources.insightReport, areaTokens),
  ]
    // Drop any item that somehow has no citation (§5: no uncited claim).
    .filter((it) => Array.isArray(it.citations) && it.citations.length > 0);

  items.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      String(a.ticket || "").localeCompare(String(b.ticket || "")) ||
      a.approach.localeCompare(b.approach) ||
      a.warning.localeCompare(b.warning)
  );
  // De-dupe identical (kind+ticket+warning) rows that distinct sources can both
  // produce, keeping the first (sorted) occurrence.
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = `${it.kind}|${it.ticket}|${it.warning}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(it);
  }
  return {
    items: deduped,
    // Honest: with a thin area we say so rather than implying "nothing ever
    // broke here" is a guarantee.
    thin_signal: deduped.length < insights.THIN_SIGNAL_FLOOR,
  };
}

// =============================================================================
// SECTION 3 — RECOMMENDED SAFE WORK DECOMPOSITION + TEST SELECTION
// =============================================================================
//
// Derived from the touched area + its past failures. Each step is CITED to the
// evidence that motivates it (a failure record, a recall hit, or the board row),
// so there is no uncited recommendation.
//
// Test selection: the touched-area test files the agent should run. We map area
// tokens to the repo test files that actually exist + carry those tokens (a
// deterministic scan of the *.test.js basenames under coord/scripts +
// coord/board), and ALWAYS include the test files of the tickets named in the
// already-failed-approaches section (run what historically broke here). Each
// recommended test cites the failure/recall source that put it on the list.

function listRepoTestFiles(rootDir) {
  const dirs = [
    path.join(rootDir, "coord", "scripts"),
    path.join(rootDir, "coord", "board"),
  ];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".test.js")) {
        out.push({
          rel: path.relative(rootDir, path.join(dir, name)).split(path.sep).join("/"),
          base: name.replace(/\.test\.js$/, ""),
        });
      }
    }
  }
  return out;
}

function buildRecommendedPlan(scope, failed, prior, sources, options) {
  const rootDir = options.rootDir || ROOT_DIR;
  const areaTokens = touchedAreaTokens(scope);
  const steps = [];
  const boardCitation = scope.ticket
    ? normalizeCitation({
        type: "ticket",
        id: scope.ticket.id,
        path: relBoard(options),
        chain_head: sources.chainHead,
        verified: true,
      })
    : null;

  // Step 1 — read the relevant prior work first (cited to its top hit).
  if (prior.items.length) {
    steps.push({
      step: "Read the cited prior work below before writing code — reuse, do not re-derive.",
      citations: [prior.items[0].citations[0]],
    });
  }

  // Step 2..k — one decomposition step per already-failed approach: "guard
  // against <approach>", cited to that failure.
  for (const fail of failed.items) {
    steps.push({
      step: `Guard against the known failure in "${fail.approach}": ${fail.warning}`,
      citations: fail.citations.slice(0, 2),
    });
  }

  // Final step — land through the normal gated lane (cited to the board row when
  // present; this is advice, not a gate).
  if (boardCitation) {
    steps.push({
      step: "Decompose into the smallest reviewable change, then land through the normal gated lane (this pack does not gate or auto-start).",
      citations: [boardCitation],
    });
  }

  // --- test selection ---
  const testFiles = listRepoTestFiles(rootDir);
  const recommendedTests = [];
  const pushTest = (rel, reason, citations) => {
    const existing = recommendedTests.find((t) => t.path === rel);
    if (existing) {
      // Merge reasons/citations deterministically.
      if (!existing.reasons.includes(reason)) {
        existing.reasons.push(reason);
        existing.reasons.sort();
      }
      for (const c of citations) {
        if (!existing.citations.some((e) => stableStringify(e) === stableStringify(c))) {
          existing.citations.push(c);
        }
      }
      existing.citations.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
      return;
    }
    recommendedTests.push({ path: rel, reasons: [reason], citations: [...citations] });
  };

  // (a) area-token match: a test file whose basename shares an area token.
  for (const tf of testFiles) {
    const baseTokens = new Set(recall.tokenize(tf.base));
    let matched = false;
    for (const t of baseTokens) {
      if (areaTokens.has(t)) {
        matched = true;
        break;
      }
    }
    if (matched && boardCitation) {
      pushTest(tf.rel, "touched-area test (basename matches the ticket's area)", [boardCitation]);
    } else if (matched && prior.items.length) {
      pushTest(tf.rel, "touched-area test (basename matches the ticket's area)", [prior.items[0].citations[0]]);
    }
  }

  // (b) ALWAYS include the test files of tickets named in failed-approaches: run
  // what historically broke here. We map a ticket to its decision-record source
  // path's sibling test when the source is a *.js under coord/scripts.
  for (const fail of failed.items) {
    for (const c of fail.citations) {
      if (!c.path) {
        continue;
      }
      const testRel = sourcePathToTest(c.path, testFiles);
      if (testRel) {
        pushTest(testRel, `historically-broke here (${fail.approach})`, [c]);
      }
    }
  }

  recommendedTests.sort((a, b) => a.path.localeCompare(b.path));

  return {
    steps,
    recommended_tests: recommendedTests,
    // The full-suite fallback is ALWAYS sound advice and is cited to the board
    // row (or omitted when there is no ticket + no prior work to anchor it).
    full_suite_command:
      "env -u COORD_SESSION_ID node --test coord/scripts/*.test.js coord/board/*.test.js",
    thin_signal: recommendedTests.length === 0,
  };
}

// Map a cited source path to a sibling test file path that actually exists in
// the repo test list. e.g. coord/.runtime/plans/COORD-141.json -> the test for
// the module COORD-141 touched is unknown from the plan path, so this only fires
// for *.js source citations (recall file hits) — a plan-path citation returns
// null (no spurious test mapping).
function sourcePathToTest(srcPath, testFiles) {
  if (!srcPath.endsWith(".js") || srcPath.endsWith(".test.js")) {
    return null;
  }
  const candidate = srcPath.replace(/\.js$/, ".test.js");
  const hit = testFiles.find((t) => t.rel === candidate);
  return hit ? hit.rel : null;
}

function relBoard(options) {
  const rootDir = options.rootDir || ROOT_DIR;
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  return path.relative(rootDir, boardPath).split(path.sep).join("/");
}

// =============================================================================
// PACK ASSEMBLY
// =============================================================================

function buildPack(options = {}) {
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const plansDir = options.plansDir || DEFAULT_PLANS_DIR;
  const decisionsPath = options.decisionsPath || DEFAULT_DECISIONS_PATH;
  const generatedAt = options.now || DEFAULT_GENERATED_AT;

  const scope = resolveScope({ ...options, boardPath });

  // Shared source ingestion (composed from the substrate), read ONCE.
  const { events, chainHead } = insights.readJournalEvents(journalPath);
  const decisions = readDecisionRecords(decisionsPath);
  const insightReport = insights.generateReport({
    boardPath,
    journalPath,
    plansDir,
    rootDir: options.rootDir,
    now: generatedAt,
  });
  const sources = { events, chainHead, decisions, insightReport };

  const relevant_prior_work = buildRelevantPriorWork(scope, options);
  const already_failed_approaches = buildAlreadyFailedApproaches(scope, sources);
  const recommended_plan = buildRecommendedPlan(
    scope,
    already_failed_approaches,
    relevant_prior_work,
    sources,
    options
  );

  return {
    kind: "prework-context-pack",
    // The guardrail, machine-checkable: advisory only, mutates/gates nothing.
    authority: false,
    recommends_only: true,
    generated_at: generatedAt,
    chain_head: chainHead,
    scope: {
      ticket_id: scope.ticket_id,
      repo: scope.repo,
      subsystem: scope.subsystem,
      free_text: scope.free_text,
      query: scope.query,
      resolved: Boolean(scope.ticket) || Boolean(scope.free_text),
    },
    sections: {
      relevant_prior_work,
      already_failed_approaches,
      recommended_plan,
    },
  };
}

// Every cited item across every section (for the §5 no-uncited invariant).
function allItems(pack) {
  const out = [];
  for (const it of pack.sections.relevant_prior_work.items || []) {
    out.push({ section: "relevant_prior_work", item: it });
  }
  for (const it of pack.sections.already_failed_approaches.items || []) {
    out.push({ section: "already_failed_approaches", item: it });
  }
  for (const it of pack.sections.recommended_plan.steps || []) {
    out.push({ section: "recommended_plan.steps", item: it });
  }
  for (const it of pack.sections.recommended_plan.recommended_tests || []) {
    out.push({ section: "recommended_plan.tests", item: it });
  }
  return out;
}

// The §5 invariant, callable: items carrying NO citation. Valid iff empty.
function uncitedItems(pack) {
  return allItems(pack)
    .filter(({ item }) => !Array.isArray(item.citations) || item.citations.length === 0)
    .map(({ section, item }) => ({ section, item }));
}

// Content digest excluding generated_at (byte-stable across wall-clock drift).
function contentDigest(pack) {
  const { generated_at, ...rest } = pack;
  return extractor.sha1(stableStringify(rest));
}

// =============================================================================
// RENDERING — readable text (every line traces to a cited item)
// =============================================================================

function renderCitations(citations) {
  const shown = (citations || []).slice(0, 3).map((c) => {
    if (c.event_hash) {
      return `${c.id || "?"}@${c.event_hash.slice(0, 8)}`;
    }
    return `${c.id || c.path || "?"}`;
  });
  const more =
    citations && citations.length > shown.length ? ` (+${citations.length - shown.length})` : "";
  return `cites: ${shown.join(", ")}${more}`;
}

function renderText(pack) {
  const lines = [];
  const p = (s) => lines.push(s);
  p("PRE-WORK CONTEXT PACK (COORD-148) — RECOMMENDS ONLY. Mutates/gates nothing.");
  p(
    `scope: ${pack.scope.ticket_id || "(free-text)"} ` +
      `repo=${pack.scope.repo || "?"} subsystem=${pack.scope.subsystem || "?"} ` +
      `chain_head=${(pack.chain_head || "(none)").slice(0, 12)}`
  );
  if (pack.scope.query) {
    p(`retrieval scope: ${pack.scope.query.slice(0, 160)}`);
  }
  p("");

  const s1 = pack.sections.relevant_prior_work;
  p(`1. RELEVANT PRIOR WORK (${s1.items.length} hits; confidence=${s1.confidence} staleness=${s1.staleness})`);
  if (!s1.items.length) {
    p("   (no governed memory matched this scope — nothing to cite)");
  }
  for (const it of s1.items) {
    p(`   - ${it.summary.split("\n")[0]}`);
    p(`     ${renderCitations(it.citations)}`);
  }
  p("");

  const s2 = pack.sections.already_failed_approaches;
  p(`2. ALREADY-FAILED APPROACHES in this area (${s2.items.length}${s2.thin_signal ? "; THIN SIGNAL" : ""}) — do NOT repeat`);
  if (!s2.items.length) {
    p("   (no cited prior failure intersects this area — absence of evidence, not a guarantee)");
  }
  for (const it of s2.items) {
    p(`   - [${it.kind}] ${it.warning}`);
    p(`     ${renderCitations(it.citations)}`);
  }
  p("");

  const s3 = pack.sections.recommended_plan;
  p(`3. RECOMMENDED SAFE DECOMPOSITION + TEST SELECTION (${s3.steps.length} steps, ${s3.recommended_tests.length} tests)`);
  for (const st of s3.steps) {
    p(`   - ${st.step}`);
    p(`     ${renderCitations(st.citations)}`);
  }
  if (s3.recommended_tests.length) {
    p("   Run these touched-area / historically-broke tests first:");
    for (const t of s3.recommended_tests) {
      p(`     * ${t.path} — ${t.reasons.join("; ")}`);
      p(`       ${renderCitations(t.citations)}`);
    }
  }
  p(`   Full suite: ${s3.full_suite_command}`);
  p("");
  p("NOTE: This pack RECOMMENDS only. It does not gate, block, auto-start, claim,");
  p("or mutate anything; execution stays gated by the normal lane. Authority is the");
  p("hash-linked journal / board / plan records cited above (source wins).");
  return lines.join("\n");
}

module.exports = {
  stableStringify,
  readBoardTicket,
  resolveScope,
  touchedAreaTokens,
  intersectsArea,
  buildRelevantPriorWork,
  readDecisionRecords,
  minePastReviewFailures,
  minePastRecoveries,
  mineAreaFailureThemes,
  buildAlreadyFailedApproaches,
  buildRecommendedPlan,
  buildPack,
  allItems,
  uncitedItems,
  contentDigest,
  renderText,
  normalizeCitation,
  AREA_GENERIC_STOP,
  DEFAULT_BOARD_PATH,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_PLANS_DIR,
  DEFAULT_DECISIONS_PATH,
  DEFAULT_GENERATED_AT,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let asJson = false;
  let role = null;
  let scope = "";
  let ticketId = null;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      asJson = true;
    } else if (a === "--role") {
      role = argv[i + 1] || null;
      i += 1;
    } else if (a === "--scope") {
      scope = argv[i + 1] || "";
      i += 1;
    } else if (String(a).startsWith("--")) {
      // ignore unknown flags
    } else {
      positional.push(a);
    }
  }
  if (positional.length) {
    ticketId = positional[0];
  }
  if (!ticketId && !scope) {
    process.stdout.write(
      [
        "coord/scripts/prework-pack.js — pre-work context pack (COORD-148).",
        "",
        "Usage:",
        "  node coord/scripts/prework-pack.js <ticket-id> [--scope \"<free text>\"] [--role <role>] [--json]",
        "  node coord/scripts/prework-pack.js --scope \"<free text>\" [--json]",
        "",
        "Produces a SOURCE-CITED pre-work pack: relevant prior work + already-failed",
        "approaches in the touched area + a recommended safe decomposition / test",
        "selection. RECOMMENDS ONLY — mutates/gates nothing. Composes recall.js,",
        "decision-extractor.js, and insight-reports.js.",
        "",
      ].join("\n")
    );
  } else {
    const pack = buildPack({ ticketId, scope, role, now: new Date().toISOString() });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderText(pack)}\n`);
    }
  }
}
