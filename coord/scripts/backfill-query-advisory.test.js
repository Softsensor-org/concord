"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { scanBackfillQueryText } = require("./backfill-query-advisory.js");

// COORD-162: advisory-only backfill query / volume-safety scan. These tests pin
// the ticket's required behaviors:
//   - true-positive boundary: obvious broad patterns (SELECT *, blob-column read
//     in a scan/backfill path, unbounded ORM read) are flagged;
//   - false-positive boundary: qualified/bounded variants are NOT flagged
//     (conservative; no false-block);
//   - it never blocks and never throws (no exit-code influence), mirroring
//     COORD-160's advisory contract.

function rules(result) {
  return result.findings.map((f) => f.rule);
}

// --- SELECT * ---------------------------------------------------------------

test("(tp) bare SELECT * is flagged", () => {
  const r = scanBackfillQueryText("SELECT * FROM events WHERE created_at < $1");
  assert.equal(r.triggered, true);
  assert.equal(r.blocking, false);
  assert.ok(rules(r).includes("select_star"));
});

test("(fp) count(*) and qualified t.* are NOT flagged", () => {
  assert.equal(scanBackfillQueryText("SELECT count(*) FROM events").triggered, false);
  // `select t.*` is a qualified star, not a bare projection star.
  const qualified = scanBackfillQueryText("SELECT id, name FROM users u");
  assert.equal(qualified.triggered, false);
});

// --- blob-column reads in scan/backfill paths -------------------------------

test("(tp) blob column inside a backfill/scan path is flagged", () => {
  const r = scanBackfillQueryText(
    "backfill job: for each row read the payload column from history"
  );
  assert.equal(r.triggered, true);
  assert.equal(r.blocking, false);
  assert.ok(rules(r).includes("blob_column_in_scan_path"));
});

test("(fp) a blob column with NO scan/backfill/listing context is NOT flagged", () => {
  // Reading one blob by id is fine — there is no broad-scan context here.
  const r = scanBackfillQueryText("return the document for the requested id");
  assert.equal(r.triggered, false);
});

// --- unbounded ORM reads ----------------------------------------------------

test("(tp) findAll() with no limit is flagged as unbounded", () => {
  const r = scanBackfillQueryText("const rows = await Event.findAll();");
  assert.equal(r.triggered, true);
  assert.equal(r.blocking, false);
  assert.ok(rules(r).includes("unbounded_orm_read"));
});

test("(fp) findMany with a limit/take is NOT flagged", () => {
  assert.equal(
    scanBackfillQueryText("await prisma.event.findMany({ take: 500 })").triggered,
    false
  );
  assert.equal(
    scanBackfillQueryText("await Event.findAll({ limit: 100, offset })").triggered,
    false
  );
  assert.equal(
    scanBackfillQueryText("stream rows in batches via findAll() with batch-size 500").triggered,
    false
  );
});

// --- composition & contract -------------------------------------------------

test("multiple obvious patterns in one input produce multiple findings", () => {
  const r = scanBackfillQueryText(
    "backfill: SELECT * including the payload blob; then Model.findAll()"
  );
  assert.equal(r.triggered, true);
  assert.equal(r.blocking, false);
  const found = rules(r);
  assert.ok(found.includes("select_star"));
  assert.ok(found.includes("blob_column_in_scan_path"));
  assert.ok(found.includes("unbounded_orm_read"));
});

test("clean bounded query produces no findings", () => {
  const r = scanBackfillQueryText(
    "SELECT id, status FROM events WHERE id > $1 ORDER BY id LIMIT 500"
  );
  assert.equal(r.triggered, false);
  assert.deepEqual(r.findings, []);
});

test("never blocks and never throws on degenerate input", () => {
  for (const input of [undefined, null, "", "   ", 0, {}, [], 42, "harmless prose"]) {
    let result;
    assert.doesNotThrow(() => {
      result = scanBackfillQueryText(input);
    });
    assert.equal(result.blocking, false, `blocking must be false for ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(result.findings));
  }
});

test("every finding carries severity=warning (advisory, never an error)", () => {
  const r = scanBackfillQueryText("SELECT * FROM t; Model.findAll(); payload backfill");
  assert.ok(r.findings.length > 0);
  for (const finding of r.findings) {
    assert.equal(finding.severity, "warning");
  }
});
