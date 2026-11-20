"use strict";

// COORD-975: duplicate-ticket check for `gov file-ticket`.
//
// Pure, deterministic scoring. No I/O except readFilingPolicy. A candidate is an
// existing board row that is open (or done within the recency window). Each row is
// scored on five facets of its text against the proposed description:
//   description  words (lowercased, stemmed, stopwords removed)          weight 0.30
//   paths        basenames of referenced source/doc files               weight 0.25
//   functions    camelCase identifiers (for example fileTicket)         weight 0.10
//   guards       guard ids from coord/engine/governance-guards.json     weight 0.25
//   verbs        `gov <verb>` mentions                                  weight 0.10
// Description words are IDF-weighted over the board; named facets are overlap
// coefficients |A∩B|/min(|A|,|B|). Only facets where both sides carry a token contribute. The score is the weighted sum (0..1).
// A candidate at or above DUPLICATE_THRESHOLD is "flagged".
//
// Enforcement is a policy switch (coord/engine/duplicate-check-policy.json). It stays
// "off" (advisory only) until ADR 0026 is Accepted by the human admin.

const fs = require("node:fs");

const DUPLICATE_THRESHOLD = 0.2;
const RECENT_DONE_DAYS = 90;
const TOP_CANDIDATES = 5;
const WEIGHTS = Object.freeze({ description: 0.3, paths: 0.25, functions: 0.1, guards: 0.25, verbs: 0.1 });
const ENFORCEMENT_MODES = Object.freeze(["off", "on"]);

const STOPWORDS = new Set((
  "a an and are as at be by for from in into is it of on or so that the this to with without " +
  "under per each all any not no only via when where which while than then their there these " +
  "those they also must should will would can may one two make use add new its each over more " +
  "after before back such other both does done ticket tickets"
).split(" "));

function stem(word) {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function textOf(value) {
  return String(value == null ? "" : value);
}

function descriptionTokens(text) {
  const out = new Set();
  for (const raw of textOf(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || !/^[a-z]/.test(raw) || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function pathTokens(text) {
  const out = new Set();
  const re = /[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs|json|md|sh|ts|tsx)\b/g;
  for (const match of textOf(text).matchAll(re)) {
    const base = match[0].split("/").pop().toLowerCase();
    if (base.length > 3) out.add(base);
  }
  return out;
}

function functionTokens(text) {
  const out = new Set();
  for (const match of textOf(text).matchAll(/\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g)) {
    out.add(match[0]);
  }
  return out;
}

function guardTokens(text, guardIds) {
  const out = new Set();
  const known = guardIds instanceof Set ? guardIds : new Set(guardIds || []);
  for (const match of textOf(text).matchAll(/guard:([a-z0-9][a-z0-9-]*)/gi)) {
    out.add(match[1].toLowerCase());
  }
  for (const match of textOf(text).toLowerCase().matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)) {
    if (known.has(match[0])) out.add(match[0]);
  }
  return out;
}

function verbTokens(text) {
  const out = new Set();
  for (const match of textOf(text).matchAll(/\bgov\s+([a-z][a-z-]*)/gi)) {
    out.add(match[1].toLowerCase());
  }
  return out;
}

function extractFacets(text, guardIds) {
  return {
    description: descriptionTokens(text),
    paths: pathTokens(text),
    functions: functionTokens(text),
    guards: guardTokens(text, guardIds),
    verbs: verbTokens(text),
  };
}

function intersection(a, b) {
  const out = [];
  for (const item of a) if (b.has(item)) out.push(item);
  return out.sort();
}

// Description words are weighted by inverse document frequency over the board rows
// and the proposal, so generic governance words ("gate", "guard", "plan") carry little
// weight and specific words ("landing", "resolution") carry more. Named evidence
// (paths, functions, guard ids, verbs) is a plain overlap coefficient: shared items
// over the smaller side, because a ticket that names one of the same files or guards
// is the signal even when the other ticket names many more.
function idfTable(sets) {
  const n = sets.length;
  const df = new Map();
  for (const set of sets) for (const word of set) df.set(word, (df.get(word) || 0) + 1);
  const table = new Map();
  for (const [word, count] of df) table.set(word, Math.log((n + 1) / (count + 1)) + 1);
  return table;
}

function weightOf(set, idf) {
  let total = 0;
  for (const word of set) total += idf.get(word) || 1;
  return total;
}

function scoreFacets(candidate, proposed, idf = new Map()) {
  let total = 0;
  const evidence = {};
  const contributing = {};
  for (const facet of Object.keys(WEIGHTS)) {
    const a = candidate[facet];
    const b = proposed[facet];
    if (a.size === 0 || b.size === 0) {
      evidence[facet] = [];
      contributing[facet] = 0;
      continue;
    }
    const shared = intersection(a, b);
    let ratio;
    if (facet === "description") {
      const denom = Math.min(weightOf(a, idf), weightOf(b, idf));
      ratio = denom > 0 ? Math.min(1, weightOf(shared, idf) / denom) : 0;
    } else {
      ratio = shared.length / Math.min(a.size, b.size);
    }
    evidence[facet] = shared;
    contributing[facet] = ratio;
    total += WEIGHTS[facet] * ratio;
  }
  return { score: Math.round(total * 1000) / 1000, evidence, contributing };
}

// Score a proposed description against existing board rows.
//   rows: array of board rows ({ ID, Status, Description })
//   guardIds: iterable of known guard ids
//   doneDates: optional Map or object of ticket id -> ISO date the ticket was landed/done
//   now: Date used for the recency window
// Returns candidates sorted by score (desc), then id, excluding score 0 and superseded rows.
function findCandidates({ description, rows, guardIds = [], doneDates = {}, now = new Date(), top = TOP_CANDIDATES } = {}) {
  const proposed = extractFacets(description, guardIds);
  const known = guardIds instanceof Set ? guardIds : new Set(guardIds);
  const idf = idfTable([proposed.description, ...(rows || []).map((row) => descriptionTokens(row && row.Description))]);
  const doneDateOf = (id) => (doneDates instanceof Map ? doneDates.get(id) : doneDates[id]);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const windowMs = RECENT_DONE_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.ID) continue;
    const status = String(row.Status || "").toLowerCase();
    if (status === "superseded") continue;
    if (status === "done") {
      const landed = doneDateOf(row.ID);
      if (landed) {
        const landedMs = Date.parse(landed);
        if (Number.isFinite(landedMs) && nowMs - landedMs > windowMs) continue;
      }
    }
    const facets = extractFacets(row.Description, known);
    const { score, evidence } = scoreFacets(facets, proposed, idf);
    if (score <= 0) continue;
    out.push({
      id: row.ID,
      status,
      score,
      flagged: score >= DUPLICATE_THRESHOLD,
      evidence,
    });
  }
  out.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out.slice(0, top);
}

function readFilingPolicy(policyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { enforcement: "off", source: "default" };
    throw error;
  }
  const parsed = JSON.parse(raw);
  return normalizePolicy(parsed, policyPath);
}

function normalizePolicy(policy, source = "override") {
  const enforcement = policy && policy.enforcement === undefined ? "off" : policy && policy.enforcement;
  if (!ENFORCEMENT_MODES.includes(enforcement)) {
    throw new Error(`duplicate-check policy: enforcement must be one of ${ENFORCEMENT_MODES.join(", ")} (got ${JSON.stringify(enforcement)}).`);
  }
  return { enforcement, source };
}

// Decide what file-ticket does with the candidates.
//   links: { duplicateOf, distinctFrom: [ids], reason }
// Returns { decision, flagged }:
//   "none"     no candidate reached the threshold
//   "advisory" flagged, no links, enforcement off: report and file
//   "linked"   flagged, and --duplicate-of or --distinct-from(with reason) given
//   "blocked"   flagged, no links, enforcement on
function evaluateFiling({ candidates = [], links = {}, policy = { enforcement: "off" } } = {}) {
  const flagged = candidates.filter((candidate) => candidate.flagged);
  const hasLinks = Boolean(links.duplicateOf) || (Array.isArray(links.distinctFrom) && links.distinctFrom.length > 0);
  if (flagged.length === 0) return { decision: "none", flagged };
  if (hasLinks) return { decision: "linked", flagged };
  if (policy.enforcement === "on") return { decision: "blocked", flagged };
  return { decision: "advisory", flagged };
}

function formatAdvisory(candidates) {
  const lines = [];
  for (const candidate of candidates) {
    const shared = Object.entries(candidate.evidence)
      .filter(([, values]) => values.length > 0)
      .map(([facet, values]) => `${facet}: ${values.slice(0, 6).join(", ")}`);
    lines.push(
      `  ${candidate.id} [${candidate.status}] score ${candidate.score.toFixed(3)}${candidate.flagged ? " (likely duplicate)" : ""}` +
      (shared.length ? `\n      shared ${shared.join("; ")}` : "\n      no shared evidence")
    );
  }
  return lines;
}

module.exports = {
  DUPLICATE_THRESHOLD,
  RECENT_DONE_DAYS,
  WEIGHTS,
  ENFORCEMENT_MODES,
  extractFacets,
  scoreFacets,
  findCandidates,
  readFilingPolicy,
  normalizePolicy,
  evaluateFiling,
  formatAdvisory,
};
