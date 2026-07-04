'use strict';

/**
 * COORD-287 — coord-ui /triage projection core.
 *
 * Zero-dependency, pure CJS module. SINGLE source of truth for the
 * "proposed-ticket triage" projection shared by the running app
 * (frontend/apps/coord-ui/lib/triage.ts) and the node:test suite
 * (coord/scripts/triage-core.test.js) — exactly the in-process core-module
 * pattern SEC-001/SEC-002 use for coord-ui-path-boundary.js, so the served
 * behavior and the gate cannot drift.
 *
 * STRICTLY READ-ONLY logic. This module does pure, in-memory data shaping over
 * a board object that the caller already read. It performs NO fs access, NO
 * writes, NO process spawning, and exposes NO mutation/approve/reject path — the
 * `gov approve` / `gov reject` ACTIONS live exclusively in the governed CLI
 * (coord/scripts/gov). The triage view only DISPLAYS the approval queue; the
 * copyable CLI hints it renders are produced by {@link cliHint} as plain text.
 *
 * What it does
 * ------------
 *   - Walk the board's table sections and select rows whose Status is
 *     `proposed` (the COORD-285 approval-gated quarantine: machine-proposed
 *     debt awaiting a human `gov approve`/`gov reject`).
 *   - For each, parse the structured fields a reviewer needs out of the
 *     ticket Description: the `[qkey:<key>]` dedup marker, the human title, the
 *     evidence/finding line, and the "Suggested fix:" framing — all written by
 *     coord/scripts/quality-scan.js findingToProposal(). Parsing is graceful:
 *     a hand-filed `proposed` ticket with a free-text description still renders
 *     (qkey/finding/suggested-fix degrade to null, never throw).
 */

// Mirrors quality-scan.js QKEY_MARKER_RE — the stable dedup key round-trips
// through the description as `[qkey:<key>]`.
const QKEY_RE = /\[qkey:([^\]]+)\]/;

// "Suggested fix: <text>" up to the qkey marker or end of string. The fix
// framing is the last structured sentence quality-scan writes before the
// marker (see FIX_FRAMING / findingToProposal).
const SUGGESTED_FIX_RE = /Suggested fix:\s*([\s\S]*?)\s*(?:\[qkey:[^\]]+\]\s*)?$/;

// "Evidence: <text>. Detail: ..." — the machine evidence line. We keep it as
// the human-readable "finding".
const EVIDENCE_RE = /Evidence:\s*([\s\S]*?)(?:\.\s*Detail:|\.\s*Suggested fix:|\s*\[qkey:|$)/;

// "[auto-quality] <title>. Evidence:" — the generated human title sits between
// the source tag and the evidence line.
const AUTO_TITLE_RE = /^\s*\[auto-quality\]\s*([\s\S]*?)\.\s*Evidence:/;

const PROPOSED_STATUS = 'proposed';

/** Trim + collapse internal whitespace/newlines for tidy single-line display. */
function tidy(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Pull the `[qkey:<key>]` marker, or null when absent. */
function parseQkey(description) {
  const m = QKEY_RE.exec(description || '');
  return m ? tidy(m[1]) : null;
}

/** Pull the "Suggested fix:" framing, or null when the description has none. */
function parseSuggestedFix(description) {
  const text = String(description || '');
  if (!/Suggested fix:/.test(text)) return null;
  const m = SUGGESTED_FIX_RE.exec(text);
  const fix = m ? tidy(m[1]) : '';
  return fix || null;
}

/** Pull the "Evidence:" finding line, or null when absent. */
function parseFinding(description) {
  const text = String(description || '');
  if (!/Evidence:/.test(text)) return null;
  const m = EVIDENCE_RE.exec(text);
  const finding = m ? tidy(m[1]) : '';
  return finding || null;
}

/**
 * Best-effort human title for a proposed ticket. Prefers the generated
 * `[auto-quality] <title>.` form; falls back to the leading sentence of the
 * description (before Evidence:/qkey marker) so a hand-filed proposed ticket
 * still shows something meaningful. Never empty for a non-empty description.
 */
function deriveTitle(description) {
  const text = String(description || '');
  const auto = AUTO_TITLE_RE.exec(text);
  if (auto) return tidy(auto[1]);
  // Strip the qkey marker, then take the text before the first structured
  // section or sentence break.
  const stripped = text.replace(QKEY_RE, '').trim();
  const beforeSection = stripped.split(/\.\s*(?:Evidence:|Detail:|Suggested fix:)/)[0];
  const firstSentence = beforeSection.split(/(?<=\.)\s/)[0];
  return tidy(firstSentence) || tidy(stripped) || '';
}

/**
 * Project a single board row (a plain {ID,Repo,Type,Pri,Status,Owner,
 * Description,...} object) into a triage item. Returns null for non-proposed
 * rows or rows without an ID so callers can flat-map.
 */
function toTriageItem(row) {
  if (!row || typeof row !== 'object') return null;
  const status = tidy(row.Status).toLowerCase();
  if (status !== PROPOSED_STATUS) return null;
  const id = tidy(row.ID);
  if (!id) return null;
  const description = typeof row.Description === 'string' ? row.Description : '';
  return {
    id,
    repo: tidy(row.Repo) || null,
    type: tidy(row.Type) || null,
    priority: tidy(row.Pri) || null,
    owner: tidy(row.Owner) || null,
    dependsOn: tidy(row['Depends On']) || null,
    title: deriveTitle(description),
    qkey: parseQkey(description),
    finding: parseFinding(description),
    suggestedFix: parseSuggestedFix(description),
    description: tidy(description)
  };
}

/**
 * Select every `proposed` ticket from a parsed board object, projected into
 * triage items and sorted by priority (P0..P3 first) then id. Pure: the board
 * object is read, never mutated. A malformed/empty board yields [].
 */
function proposedTickets(board) {
  const sections = board && Array.isArray(board.sections) ? board.sections : [];
  const items = [];
  for (const sec of sections) {
    if (!sec || sec.kind !== 'table' || !Array.isArray(sec.rows)) continue;
    for (const row of sec.rows) {
      const item = toTriageItem(row);
      if (item) items.push(item);
    }
  }
  const priOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  items.sort((a, b) => {
    const pa = priOrder[a.priority] ?? 9;
    const pb = priOrder[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
  return items;
}

/**
 * Plain-text governed CLI hints for one proposed ticket. DISPLAY ONLY — this
 * returns strings the UI renders verbatim for an operator to copy; it NEVER
 * executes them. The approve/reject ACTIONS remain in coord/scripts/gov.
 */
function cliHint(id) {
  const safe = tidy(id) || '<id>';
  return {
    approve: `coord/scripts/gov approve ${safe}`,
    reject: `coord/scripts/gov reject ${safe} --reason "..."`
  };
}

module.exports = {
  PROPOSED_STATUS,
  proposedTickets,
  toTriageItem,
  deriveTitle,
  parseQkey,
  parseFinding,
  parseSuggestedFix,
  cliHint
};
