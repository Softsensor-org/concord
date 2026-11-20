"use strict";

// B1 decomposition slice: pure, dependency-free helpers extracted from
// lifecycle.js. These functions close over no module state and are safe to
// import directly. Keep this module free of governance/state coupling so it
// stays trivially testable and reusable across the engine.
//
// COORD-980 (ARCH-AUDIT F-01): this is also the engine's shared home for
// exact-duplicate JSON, digest and path helpers. Each function below replaces
// a byte-identical per-module copy; add new shared helpers here, not as copies.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Prefixed(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// The derived graph, summaries and reports use the same sorted ticket census
// while projecting different authoritative source fields.
function mapBoardTableRows(boardPath, projectRow) {
  if (!fs.existsSync(boardPath)) return [];
  const board = readJson(boardPath, {});
  const rows = [];
  for (const section of Array.isArray(board.sections) ? board.sections : []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (row && typeof row === "object" && row.ID) rows.push(projectRow(row, section));
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function readJsonStrict(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}


function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "work";
}

function integerOrDefault(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

// The round a ticket ADVANCES INTO when a reviewer returns it to doing. This is
// the only round-advancing step in the lifecycle: `return-doing` writes this
// number onto BOTH the new finding and the plan record's `review_round`, so the
// pair stays consistent by construction.
function inferNextRound(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  return Math.max(...findings.map((finding) => finding.round || 1)) + 1;
}

// COORD-649: the round a ticket is CURRENTLY IN — what a finding recorded right
// now belongs to. `inferNextRound` was previously used for both questions, so
// recording N findings from ONE review auto-incremented them to rounds 1..N.
// Because the review-readiness check requires the plan's `review_round` to equal
// max(finding rounds), and the ONLY writer of `review_round` is the
// `return-doing` transition (which requires status=review — precisely what the
// check blocks), that produced an unsatisfiable closed loop.
//
// The plan record is AUTHORITATIVE when it carries a usable round: it is written
// only by the governed round-advancing transition, so it states how many repair
// rounds actually happened. Findings are a fallback for tickets with no plan
// record yet, and deliberately use max() (not max()+1) — an existing finding is
// evidence of the round the ticket is in, not of a round it has moved past.
function currentReviewRound(planRecord, findings) {
  const planRound = integerOrDefault(planRecord && planRecord.review_round, null);
  if (Number.isInteger(planRound) && planRound >= 1) {
    return planRound;
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  const observed = Math.max(
    ...findings.map((finding) => {
      const round = integerOrDefault(finding && finding.round, 1);
      return Number.isInteger(round) && round >= 1 ? round : 1;
    })
  );
  return Number.isInteger(observed) && observed >= 1 ? observed : 1;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  toArray,
  slugify,
  integerOrDefault,
  inferNextRound,
  currentReviewRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
  stableStringify,
  sha1,
  sha256Hex,
  sha256Text,
  sha256Prefixed,
  readJson,
  mapBoardTableRows,
  readJsonStrict,
  readJsonIfExists,
  isPlainObject,
  normalizePath,
  toPosix,
};
