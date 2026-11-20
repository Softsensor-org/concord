"use strict";

// COORD-924: shadow runs, the local evaluation log, and the landing policy for
// affected-test selection (ADR 0021).
//
// A shadow run pairs a selection with the AUTHORITATIVE full-gate report of
// the same tree and records, in a COORD-910 run manifest, the selected and
// omitted suites, every failure the selection missed, and the time saved.
//
// The activation state and the per-category suspensions are governed state on
// the board (affected-state.js); the ledger here (journal.ndjson,
// activation-state.json) is the checkout's local, hash-chained evaluation log.
// landingPolicy reduces only an active, complete, unsuspended T0/T1 selection;
// a suspension of "all" suspends every category. T2 never reduces.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const runManifest = require("./run-manifest.js");

const STATES = Object.freeze(["shadow", "active"]);
const ALL = "all";
const DEFAULT_LEDGER_REL = "coord/artifacts/affected-selection";
const FILES = Object.freeze({ state: "activation-state.json", journal: "journal.ndjson", runs: "shadow-runs.ndjson", report: "evaluation-report.md" });

function sha256(text) { return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`; }

function readLines(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJournal(dir) { return readLines(path.join(dir, FILES.journal)); }

// The chain is valid when every entry's hash covers its body and the previous hash.
function verifyJournal(entries) {
  let prev = null;
  for (const [i, entry] of entries.entries()) {
    const { sha256: recorded, ...body } = entry;
    if (body.prev_sha256 !== prev || body.seq !== i + 1 || sha256(JSON.stringify(body)) !== recorded) {
      return { ok: false, problem: `journal entry ${i + 1} does not verify` };
    }
    prev = recorded;
  }
  return { ok: true, head: prev };
}

function readState(dir, policy = { initial_state: "shadow" }) {
  const fallback = (reason) => ({ state: "shadow", source: reason, suspended_categories: {} });
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dir, FILES.state), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return fallback("state unreadable: full gates");
    return { state: policy.initial_state, source: `default (${policy.initial_state}, policy v${policy.policy_version || 0})`, policy_version: policy.policy_version || null, suspended_categories: {} };
  }
  let journal;
  try {
    journal = verifyJournal(readJournal(dir));
  } catch {
    journal = { ok: false, problem: "journal unreadable" };
  }
  if (!STATES.includes(stored.state)) return fallback(`unknown state ${stored.state}: full gates`);
  if (!journal.ok || journal.head !== stored.journal_head) return fallback(`state does not match its journal (${journal.problem || "head differs"}): full gates`);
  return { suspended_categories: {}, ...stored, source: "state file" };
}

// Append a journaled transition and write the state it leads to.
function transition(dir, { to, event, reason, detail = null, extra = {}, policy = { initial_state: "shadow" }, now = new Date().toISOString() }) {
  const entries = readJournal(dir);
  const check = verifyJournal(entries);
  if (!check.ok) throw new Error(`affected-selection journal is corrupt (${check.problem}); repair it before any transition`);
  const previous = readState(dir, policy);
  const body = { seq: entries.length + 1, at: now, event, from_state: previous.state, to_state: to, reason, detail, prev_sha256: check.head || null };
  const entry = { ...body, sha256: sha256(JSON.stringify(body)) };
  appendLine(path.join(dir, FILES.journal), entry);
  const state = { schema_version: 1, state: to, since: now, reason, journal_head: entry.sha256,
    policy_version: previous.policy_version ?? null, suspended_categories: previous.suspended_categories, ...extra };
  fs.writeFileSync(path.join(dir, FILES.state), `${JSON.stringify(state, null, 2)}\n`);
  return entry;
}

function failingTests(report) {
  return [...new Set(((report && report.results) || []).flatMap((r) => r.failing_tests || []))].sort();
}

function totalDuration(report) {
  return ((report && report.results) || []).reduce((sum, r) => sum + (r.duration_ms || 0), 0);
}

// The shadow comparison. With a fallback nothing is omitted, so nothing can
// be missed and nothing is saved.
function compareShadow(selection, fullReport, selectedReport) {
  const full = failingTests(fullReport);
  const reduced = selection.decision === "selected";
  if (reduced && !selectedReport) throw new Error("a selected shadow run needs the report of the selected suites");
  const caught = new Set(reduced ? failingTests(selectedReport) : full);
  const fullMs = totalDuration(fullReport);
  const selectedMs = reduced ? totalDuration(selectedReport) : fullMs;
  return {
    full_failures: full,
    selected_failures: reduced ? [...caught].sort() : full,
    missed_failures: full.filter((name) => !caught.has(name)),
    wall_time_ms: { full: fullMs, selected: selectedMs, saved: reduced ? Math.max(0, fullMs - selectedMs) : 0 },
  };
}

function nodeMajor(version) { return Number(/^v?(\d+)\./.exec(version || "")?.[1]) || null; }

function shadowRecord(selection, comparison, { edition, nodeVersion }) {
  return {
    mode: "shadow",
    authorizes_landing: false,
    selector_version: selection.selector_version,
    selector_digest: selection.selector_digest,
    base: selection.base,
    head: selection.head,
    tier: selection.tier,
    categories: selection.categories,
    decision: selection.decision,
    fallback_reasons: selection.fallback_reasons,
    selected: selection.selected,
    omitted: selection.omitted,
    always_required_checks: selection.always_required_checks,
    edition,
    node_version: nodeVersion,
    ...comparison,
  };
}

// Record one shadow run: manifest, ledger line, and automatic suspension when
// the selection missed a failure the full gate found.
function recordShadowRun({ root, ledgerDir, selection, fullReport, fullReportPath, selectedReport = null, selectedReportPath = null, env = process.env, now = new Date().toISOString() }) {
  const comparison = compareShadow(selection, fullReport, selectedReport);
  const { inputs, host } = runManifest.collectInputs({ root, env, base: selection.base, gateConfig: { shadow: true, selector_digest: selection.selector_digest } });
  const record = shadowRecord(selection, comparison, { edition: inputs.edition, nodeVersion: fullReport.node_version || process.version });
  const lanes = [{ name: "full", exit_code: fullReport.result === "pass" ? 0 : 1, signal: null, duration_ms: comparison.wall_time_ms.full }];
  if (selectedReport) lanes.push({ name: "selected", exit_code: selectedReport.result === "pass" ? 0 : 1, signal: null, duration_ms: comparison.wall_time_ms.selected });
  const artifacts = [fullReportPath, selectedReportPath].filter(Boolean);
  const draft = runManifest.buildManifest({ tool: "affected-shadow", inputs, host, plan: { shards: [], selection: record }, lanes, generatedAt: now });
  const manifest = runManifest.finalizeManifest(draft, artifacts);
  const file = path.join(ledgerDir, "runs", `${now.replace(/[:.]/g, "-")}-${manifest.input_digest.slice(7, 15)}.manifest.json`);
  runManifest.writeManifest(file, manifest);
  const line = {
    at: now, manifest: file, input_digest: manifest.input_digest, selector_digest: selection.selector_digest,
    decision: selection.decision, tier: selection.tier, categories: selection.categories, edition: inputs.edition,
    node_major: nodeMajor(record.node_version), missed: comparison.missed_failures, wall_time_saved_ms: comparison.wall_time_ms.saved,
  };
  appendLine(path.join(ledgerDir, FILES.runs), line);
  // Misses are recorded in the governed state by the caller (gov selection suspend).
  return { manifest, file, line };
}

// The gate a landing must run. Reduced gates need an active state, a clean
// selection, a tier below T2 and no suspended category; they cover the
// selected suites plus the always-required suites.
function landingPolicy({ selection, state, alwaysRequired = [] }) {
  const always = selection.always_required_checks;
  const full = (reason) => ({ gate: "full", tier: selection.tier, reason, always_required_checks: always });
  if (selection.tier === "T2") return full("T2 changes always run the full relevant gate");
  if (state.state !== "active") return full(`affected selection is ${state.state} (${state.source || state.reason}); the full gate is required`);
  if (selection.decision !== "selected") return full(`selection fell back: ${[...new Set(selection.fallback_reasons.map((f) => f.code))].join(", ")}`);
  const suspended = Object.keys(state.suspended_categories || {}).filter((c) => c === ALL || selection.categories.includes(c));
  if (suspended.length) return full(`selection is suspended for ${suspended.join(", ")} after a recorded miss`);
  const suites = [...new Set([...selection.selected.map((s) => s.suite), ...alwaysRequired])].sort();
  return { gate: "affected", tier: selection.tier, reason: "T0/T1 change with a complete selection: the selected suites plus the always-required governance suites", suites, always_required_checks: always };
}

module.exports = {
  STATES, DEFAULT_LEDGER_REL, FILES,
  readJournal, verifyJournal, readState, transition, failingTests, compareShadow, nodeMajor, shadowRecord,
  recordShadowRun, landingPolicy,
};
