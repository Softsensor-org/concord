"use strict";

// COORD-162: ADVISORY-ONLY backfill query / volume-safety scan.
//
// This is the P4 sibling of the server-bootstrap chain:
//   - COORD-158  coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md (the canonical
//                vocabulary, including the "Backfill Query and Volume Safety
//                Checklist" section this scanner backs).
//   - COORD-159  the optional `bootstrap_risk` object on plan records.
//   - COORD-160  coord/scripts/bootstrap-advisory.js — advisory-only surfacing
//                of MISSING bootstrap_risk evidence in `gov explain`.
//
// COORD-160 answers "did the author DECLARE the safety envelope?". This module
// answers a complementary, narrower question: "does some text/diff/SQL-ish input
// contain an OBVIOUS broad query pattern that the checklist warns against?"
// (e.g. `SELECT *`, a blob-column read in a backfill/listing path, an unbounded
// ORM read). It exists so the checklist has an optional automatable nudge.
//
// CONTRACT — WARNING-FIRST, mirrors COORD-160 exactly. It must NEVER block:
//   - It never fails a gate, never adds a start/submit blocker, never changes an
//     exit code, never rejects a ticket. Every returned object carries
//     `blocking: false` as a load-bearing assertion. `scanBackfillQueryText`
//     never throws on bad input.
//   - The hard requirement (COORD-162 non-goal) is "no default blocking gate"
//     and "be conservative to avoid false positives". When in doubt it
//     under-warns.
//
// EXPLICIT NON-GOAL — this is a HEURISTIC regex/substring matcher, NOT a SQL or
// ORM parser. It does not tokenize, build an AST, resolve aliases, or understand
// scope. It matches obvious literal shapes only. Anything subtler is out of
// scope by design (COORD-162: "No full SQL parser", "No ORM-specific exhaustive
// analyzer").

// --- Heuristic 1: SELECT * --------------------------------------------------
// Matches `select *` / `SELECT  *` (any whitespace). Conservative: a qualified
// star like `select count(*)` or `select t.*` is NOT flagged — only a bare
// `select *` projection, which is the obvious broad-read shape the checklist
// warns against.
const SELECT_STAR_RE = /\bselect\s+\*(?!\s*\))/i;

// --- Heuristic 2: blob-column reads in backfill/listing paths ---------------
// Two-part heuristic: a blob-ish column name AND a backfill/listing context in
// the same input. We do NOT flag a blob column on its own (reading one blob by
// id is fine) — only when the surrounding text also signals a broad
// scan/backfill/listing path, which is when blob reads blow up memory.
const BLOB_COLUMN_RE =
  /\b(?:payload|blob|body|raw_?(?:json|data|payload|body)?|document|content|attachment|file_?(?:data|bytes|content)|image_?data|bytes|data_?blob)\b/i;
const BACKFILL_OR_LISTING_CONTEXT_RE =
  /\bback[\s-]?fill\b|\blist(?:ing|all)?\b|\bscan\b|\bexport\b|\bfind[\s-]?all\b|\bfind[\s-]?many\b|\bselect\b|\bfor\s+each\s+row\b|\biterate\b/i;

// --- Heuristic 3: unbounded ORM reads ---------------------------------------
// Obvious unbounded collection reads: findAll(...) / findMany(...) / .all() with
// no limit/take/first nearby, or a Sequelize/TypeORM-style call. Conservative:
// if a limit/take/first/pagination token appears anywhere in the same input we
// treat the read as bounded and do NOT flag it.
const UNBOUNDED_ORM_CALL_RE =
  /\b(?:findAll|findMany|\.all|fetchAll|getAll|selectAll|scanAll|queryAll)\s*\(/i;
const BOUNDING_TOKEN_RE =
  /\blimit\b|\btake\b|\bfirst\b|\bpaginat|\bcursor\b|\bbatch[\s-]?size\b|\bchunk\b|\bstream\b|\boffset\b|\bslice\b|\bpage[\s-]?size\b/i;

function normalizeText(value) {
  return String(value == null ? "" : value);
}

// The stable inert (no-findings) result. Always the same keys so consumers get a
// stable contract regardless of input.
function inertResult(extra = {}) {
  return {
    triggered: false,
    blocking: false,
    findings: [],
    ...extra,
  };
}

// scanBackfillQueryText — pure. Given any text/diff/SQL-ish string, return an
// advisory result describing obvious broad-query patterns. NEVER throws and
// NEVER blocks; `blocking: false` is a contract assertion downstream code may
// rely on.
function scanBackfillQueryText(input) {
  const text = normalizeText(input);
  if (!text.trim()) {
    return inertResult();
  }

  const findings = [];

  if (SELECT_STAR_RE.test(text)) {
    findings.push({
      rule: "select_star",
      severity: "warning",
      message:
        "Obvious `SELECT *` projection found. Backfill/listing queries should " +
        "select only the columns they need; `SELECT *` pulls every column " +
        "(including large blob columns) into memory. (Heuristic, not a parser.)",
    });
  }

  if (BLOB_COLUMN_RE.test(text) && BACKFILL_OR_LISTING_CONTEXT_RE.test(text)) {
    findings.push({
      rule: "blob_column_in_scan_path",
      severity: "warning",
      message:
        "A blob/payload-style column appears in a backfill/listing/scan path. " +
        "Reading large blob columns across uncontrolled history can exhaust " +
        "memory; select the blob only when needed and bound the row set. " +
        "(Heuristic, not a parser.)",
    });
  }

  if (UNBOUNDED_ORM_CALL_RE.test(text) && !BOUNDING_TOKEN_RE.test(text)) {
    findings.push({
      rule: "unbounded_orm_read",
      severity: "warning",
      message:
        "An ORM bulk read (findAll/findMany/.all/...) appears with no nearby " +
        "limit/take/first/pagination token. Unbounded reads load the full table " +
        "into memory; paginate or stream. (Heuristic, not a parser.)",
    });
  }

  if (findings.length === 0) {
    return inertResult();
  }

  return {
    triggered: true,
    blocking: false,
    findings,
  };
}

module.exports = {
  scanBackfillQueryText,
  // exported for unit tests / reuse
  SELECT_STAR_RE,
  BLOB_COLUMN_RE,
  BACKFILL_OR_LISTING_CONTEXT_RE,
  UNBOUNDED_ORM_CALL_RE,
  BOUNDING_TOKEN_RE,
};
