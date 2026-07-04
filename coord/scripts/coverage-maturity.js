"use strict";

// COORD-243: periodic coverage-maturity refresh, split by COST PROFILE into the
// three layers the ticket mandates — DETECT / DO / TRIGGER. The design rule is
// "doctor DETECTS, a verb DOES, a scheduler decides WHEN", so this module owns
// the two NON-scheduler layers as a pure, dependency-light unit:
//
//   1. DETECT — `detectMaturityStaleness(...)`: a cheap, READ-ONLY, sub-second
//      staleness check `gov doctor` calls. It mirrors the existing
//      TEMPLATE_FEEDBACK>7day nag (governance-repair.js): parse a single
//      `Last updated:` date out of coord/TEST_MATURITY.md and flag staleness by
//      TIME (> N days) OR ACTIVITY (> M tickets landed since), plus surface a
//      "dimension below threshold" line when a recorded coverage/mutation signal
//      is under its gate minimum. It returns finding STRINGS only — it never runs
//      a tool and never writes a file. Doctor stays read-only/fast.
//
//   2. DO — `rollup(...)` / `applyRollup(...)`: the SEPARATE `gov coverage-rollup`
//      verb body (NOT doctor). It reads the REAL artifacts already produced by the
//      governed lane — the per-commit coverage gate signals recorded in plan
//      records (QGATE-003) and the `gov insights` gate/recovery health rollup —
//      and rewrites TEST_MATURITY.md's `Last updated`, the gate-health-derived
//      rows, and appends a History entry. It WRITES the artifact (that is its job)
//      and is IDEMPOTENT: re-running on unchanged inputs reproduces the same file.
//
// The TRIGGER layer (a scheduler/hook that decides the cadence) lives OUTSIDE this
// module in coverage-rollup-cron.js + the runbook — this module is only DETECT and
// DO, the two layers that must never be a scheduler.
//
// ZERO new runtime deps: plain node fs/path + the existing insight-reports.js and
// coverage-policy.js engines.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_MATURITY_PATH = path.join(COORD_DIR, "TEST_MATURITY.md");
const DEFAULT_PLANS_DIR = path.join(COORD_DIR, ".runtime", "plans");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");

// DETECT thresholds. Mirrors the TEMPLATE_FEEDBACK_STALE_MS cadence shape: a
// TIME budget (14 days) and an ACTIVITY budget (25 landed tickets). Either one
// tripping makes TEST_MATURITY.md "stale" and worth a refresh. Conservative so a
// healthy, recently-refreshed repo never nags.
const MATURITY_STALE_DAYS = 14;
const MATURITY_STALE_LANDINGS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// SHARED PARSING — read-only, used by BOTH detect and do.
// =============================================================================

// Parse the single `Last updated: <YYYY-MM-DD>` line out of TEST_MATURITY.md.
// Returns { dateText, dateMs } or null when absent/unparseable. Tolerant of the
// trailing parenthetical note the file carries (e.g. "2026-06-24 (mutation ...)").
function parseLastUpdated(maturityText) {
  if (typeof maturityText !== "string") return null;
  for (const raw of maturityText.split(/\r?\n/)) {
    const m = /^Last updated:\s*(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
    if (m) {
      const dateText = m[1];
      const dateMs = Date.parse(`${dateText}T00:00:00.000Z`);
      return { dateText, dateMs: Number.isFinite(dateMs) ? dateMs : null };
    }
  }
  return null;
}

// Count tickets that LANDED (reached done) in the journal at or after a cutoff
// timestamp. A landing is a mark-done command OR an after_status==="done"
// transition. De-duplicated per ticket so a re-finalized ticket counts once.
// Read-only: a single pass over the ndjson journal, no parsing of plan records.
function countLandingsSince(journalText, sinceMs) {
  if (typeof journalText !== "string" || !Number.isFinite(sinceMs)) return 0;
  const landed = new Set();
  for (const line of journalText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const isDone = rec.command === "mark-done" || rec.after_status === "done";
    if (!isDone || !rec.ticket) continue;
    const ts = typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
    if (Number.isFinite(ts) && ts >= sinceMs) {
      landed.add(rec.ticket);
    }
  }
  return landed.size;
}

// Parse the coverage / mutation gate signals recorded in a plan record's
// repo_gates entries (QGATE-003 writes `coverage=<result> min=<pct> (...) lowest=<n>`).
// Returns the list of { ticket, kind, result, min, lowest } below-or-at-threshold
// observations. Pure string parsing over already-recorded gate artifacts.
function parseGateDimensionSignals(planRecord) {
  const out = [];
  const ticket = planRecord && planRecord.ticket_id ? String(planRecord.ticket_id) : null;
  const gates = Array.isArray(planRecord && planRecord.repo_gates) ? planRecord.repo_gates : [];
  for (const g of gates) {
    const text = typeof g === "string" ? g : JSON.stringify(g || "");
    // coverage=pass min=80 (...) lowest=90.91   |   mutation=fail min=60 score=47.72
    const cov = /coverage=(\w+)\s+min=(\d+(?:\.\d+)?)[^]*?lowest=(\d+(?:\.\d+)?)/.exec(text);
    if (cov) {
      out.push({
        ticket,
        kind: "coverage",
        result: cov[1],
        min: Number(cov[2]),
        lowest: Number(cov[3]),
      });
    }
    const mut = /mutation=(\w+)\s+min=(\d+(?:\.\d+)?)(?:[^]*?score=(\d+(?:\.\d+)?))?/.exec(text);
    if (mut) {
      out.push({
        ticket,
        kind: "mutation",
        result: mut[1],
        min: Number(mut[2]),
        lowest: mut[3] != null ? Number(mut[3]) : null,
      });
    }
  }
  return out;
}

// Read every plan record and collect its gate dimension signals. Returns the flat
// list (most-recent-ticket bias is not needed — the DETECT line reports the
// presence of a below-threshold dimension, not a trend).
function collectGateDimensionSignals(plansDir) {
  const out = [];
  if (!fs.existsSync(plansDir)) return out;
  for (const name of fs.readdirSync(plansDir).filter((n) => n.endsWith(".json")).sort()) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(plansDir, name), "utf8"));
    } catch {
      continue;
    }
    for (const sig of parseGateDimensionSignals(rec)) {
      out.push(sig);
    }
  }
  return out;
}

// =============================================================================
// LAYER 1 — DETECT (read-only, sub-second). Doctor calls this.
// =============================================================================
//
// Returns an array of finding STRINGS (possibly empty). NEVER touches a tool and
// NEVER writes a file: the caller (doctor) passes in the already-read file
// contents + journal text so this function performs no IO of its own when given
// inline inputs. The `readFile` variant below is the thin IO wrapper doctor uses.
function detectMaturityStaleness({
  maturityText,
  journalText = "",
  now = Date.now(),
  staleDays = MATURITY_STALE_DAYS,
  staleLandings = MATURITY_STALE_LANDINGS,
  gateSignals = [],
} = {}) {
  const findings = [];
  const remedy = "run `/test-strategy` or `coord/scripts/gov coverage-rollup`";

  if (typeof maturityText !== "string" || maturityText.trim() === "") {
    // The artifact is missing/empty — the strongest staleness signal.
    findings.push(
      `coord/TEST_MATURITY.md is missing or empty (never rolled up) -> ${remedy} to generate the first scored baseline.`
    );
    return appendDimensionFindings(findings, gateSignals, remedy);
  }

  const lastUpdated = parseLastUpdated(maturityText);
  if (!lastUpdated || lastUpdated.dateMs == null) {
    findings.push(
      `coord/TEST_MATURITY.md has no parseable 'Last updated:' date -> ${remedy} to refresh it.`
    );
  } else {
    const ageDays = Math.floor((now - lastUpdated.dateMs) / DAY_MS);
    const landings = countLandingsSince(journalText, lastUpdated.dateMs);
    const reasons = [];
    if (ageDays >= staleDays) {
      reasons.push(`${ageDays}d old (>${staleDays}d)`);
    }
    if (landings >= staleLandings) {
      reasons.push(`${landings} tickets landed since (>${staleLandings})`);
    }
    if (reasons.length > 0) {
      findings.push(
        `coord/TEST_MATURITY.md stale (${reasons.join("; ")}) since ${lastUpdated.dateText} -> ${remedy} to fold the latest coverage artifacts into the maturity rollup.`
      );
    }
  }

  return appendDimensionFindings(findings, gateSignals, remedy);
}

// Surface a single "dimension below threshold" actionable line when any recorded
// coverage/mutation gate signal failed (result==="fail" or lowest < min). One
// line, naming the worst offender — mirrors the single-line nag discipline.
function appendDimensionFindings(findings, gateSignals, remedy) {
  const below = (gateSignals || []).filter(
    (s) => s.result === "fail" || (s.lowest != null && s.min != null && s.lowest < s.min)
  );
  if (below.length === 0) return findings;
  // Pick the worst gap (lowest - min, most negative first; nulls last).
  const worst = below
    .slice()
    .sort((a, b) => {
      const ga = a.lowest != null ? a.lowest - a.min : Infinity;
      const gb = b.lowest != null ? b.lowest - b.min : Infinity;
      return ga - gb;
    })[0];
  const scoreText = worst.lowest != null ? `${worst.lowest} < min ${worst.min}` : `below min ${worst.min}`;
  findings.push(
    `coverage maturity: ${worst.kind} dimension below threshold (${worst.ticket || "?"}: ${scoreText}) -> ${remedy} and harden the failing dimension.`
  );
  return findings;
}

// The IO wrapper doctor uses: read the file + journal + plan signals from disk,
// then run the pure detector. Kept tiny and synchronous so doctor stays
// sub-second. Any read failure degrades to "no finding" rather than wedging
// doctor (the detector is advisory, never fail-closed).
function detectMaturityStalenessFromDisk({
  maturityPath = DEFAULT_MATURITY_PATH,
  journalPath = DEFAULT_JOURNAL_PATH,
  plansDir = DEFAULT_PLANS_DIR,
  now = Date.now(),
} = {}) {
  let maturityText = "";
  let journalText = "";
  let gateSignals = [];
  try {
    maturityText = fs.existsSync(maturityPath) ? fs.readFileSync(maturityPath, "utf8") : "";
  } catch {
    maturityText = "";
  }
  try {
    journalText = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
  } catch {
    journalText = "";
  }
  try {
    gateSignals = collectGateDimensionSignals(plansDir);
  } catch {
    gateSignals = [];
  }
  return detectMaturityStaleness({ maturityText, journalText, now, gateSignals });
}

// =============================================================================
// LAYER 2 — DO (`gov coverage-rollup`). Reads real artifacts, WRITES the file.
// =============================================================================

// Render a `Last updated:` line value from a date + the gate-health summary so
// the refresh is self-describing. Deterministic given inputs.
function buildLastUpdatedLine(dateText, healthNote) {
  const note = healthNote ? ` (${healthNote})` : "";
  return `Last updated: ${dateText}${note}`;
}

// Compute the rollup INPUTS from real artifacts: the `gov insights` gate-health
// rollup (system-level, source-cited) + the recorded coverage/mutation gate
// signals. Returns a plain, deterministic summary object the writer folds in.
function computeRollupInputs({
  insightsReport,
  gateSignals,
  journalText,
  sinceMs,
} = {}) {
  const health = insightsReport && insightsReport.sections
    ? insightsReport.sections.gate_review_recovery_health_by_repo
    : null;
  const repoClaims = health && Array.isArray(health.claims) ? health.claims : [];
  // Aggregate gate-health across repos into the maturity-relevant scalars.
  let totalCycles = 0;
  let failingCycles = 0;
  let recoveryEvents = 0;
  for (const c of repoClaims) {
    totalCycles += (c.gate && c.gate.total_review_cycles) || 0;
    failingCycles += (c.gate && c.gate.failing_review_cycles) || 0;
    recoveryEvents += (c.recovery && c.recovery.recovery_events) || 0;
  }
  const gateFailRate = totalCycles ? Math.round((failingCycles / totalCycles) * 10000) / 10000 : 0;

  // Latest coverage + mutation observations (highest signal: the most recent
  // below/above-threshold reading per kind).
  const coverage = pickLatestSignal(gateSignals, "coverage");
  const mutation = pickLatestSignal(gateSignals, "mutation");
  const landingsSince = Number.isFinite(sinceMs) ? countLandingsSince(journalText, sinceMs) : null;

  return {
    chain_head: insightsReport ? insightsReport.chain_head || null : null,
    gate: { total_cycles: totalCycles, failing_cycles: failingCycles, fail_rate: gateFailRate },
    recovery_events: recoveryEvents,
    coverage,
    mutation,
    landings_since: landingsSince,
  };
}

function pickLatestSignal(gateSignals, kind) {
  const matching = (gateSignals || []).filter((s) => s.kind === kind);
  if (matching.length === 0) return null;
  // Plan-record scan order is ticket-id sorted; the last is the highest-numbered
  // ticket, a deterministic "latest" proxy without wall-clock.
  return matching[matching.length - 1];
}

// Deterministically rewrite TEST_MATURITY.md from real rollup inputs. IDEMPOTENT:
// given the same inputs + date, produces byte-identical output. Refreshes:
//   - the `Last updated:` line (date + a gate-health note),
//   - the Correctness (mutation) + (when present) coverage-derived Dimension rows
//     with the latest recorded gate score,
//   - appends a single History entry for this rollup (collapsing a same-date,
//     same-content prior rollup row so re-runs do not grow the table).
function applyRollup({ maturityText, inputs, dateText }) {
  if (typeof maturityText !== "string" || maturityText.trim() === "") {
    throw new Error(
      "coverage-rollup: coord/TEST_MATURITY.md is missing/empty; seed it via /test-strategy before an automated rollup."
    );
  }
  const healthNote =
    `gate-health: ${inputs.gate.failing_cycles}/${inputs.gate.total_cycles} review cycles failing` +
    ` (fail_rate=${inputs.gate.fail_rate}), ${inputs.recovery_events} recovery events` +
    (inputs.coverage ? `; coverage ${inputs.coverage.result} lowest=${inputs.coverage.lowest}` : "") +
    (inputs.mutation ? `; mutation ${inputs.mutation.result}${inputs.mutation.lowest != null ? ` score=${inputs.mutation.lowest}` : ""}` : "");

  const lines = maturityText.split("\n");

  // 1. Refresh the `Last updated:` line.
  for (let i = 0; i < lines.length; i += 1) {
    if (/^Last updated:/.test(lines[i].trim())) {
      lines[i] = buildLastUpdatedLine(dateText, healthNote);
      break;
    }
  }

  // 2. Refresh the mutation Dimension Coverage row's Pct from the latest recorded
  //    mutation gate score, when both the row and a signal exist. Source-cited by
  //    preserving the existing Evidence/Gap cell; only the live Pct + Trend update.
  if (inputs.mutation && inputs.mutation.lowest != null) {
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\|\s*Correctness \(mutation\)/.test(lines[i])) {
        const cells = lines[i].split("|");
        // | Dimension | Covered | Required | Pct | Trend | Evidence |
        if (cells.length >= 7) {
          const passFail = inputs.mutation.result === "fail" ? "fail" : "pass";
          cells[2] = ` ${passFail === "pass" ? "**ACTIVE**" : "BELOW MIN"} `;
          cells[4] = ` **${inputs.mutation.lowest}%** `;
          cells[5] = ` ${passFail === "pass" ? "↑" : "↓"} (min ${inputs.mutation.min}) `;
          lines[i] = cells.join("|");
        }
        break;
      }
    }
  }

  // 3. Append a History entry for this rollup, collapsing an immediately-prior
  //    same-date rollup row so repeated runs on the same day stay idempotent.
  const historyRow =
    `| ${dateText} | rollup | ${inputs.landings_since != null ? inputs.landings_since : "—"} | ` +
    `auto coverage-rollup: ${healthNote} |`;
  const result = [];
  let inHistory = false;
  let lastWasSameRollup = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+History/.test(line)) inHistory = true;
    // Drop a previously-appended same-date auto rollup row (idempotency).
    if (inHistory && new RegExp(`^\\| ${dateText} \\| rollup \\|`).test(line)) {
      lastWasSameRollup = true;
      continue;
    }
    result.push(line);
  }
  void lastWasSameRollup;
  // Insert the fresh rollup row at the end of the History table (after the last
  // table row, before any trailing blank lines / non-table content).
  const finalLines = insertHistoryRow(result, historyRow);
  let out = finalLines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

// Insert a history row immediately after the last `|`-delimited table row that
// follows the `## History` heading. Falls back to appending at EOF if no table
// is found.
function insertHistoryRow(lines, historyRow) {
  let historyHeadingIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+History/.test(lines[i])) {
      historyHeadingIdx = i;
      break;
    }
  }
  if (historyHeadingIdx === -1) {
    return [...lines, "", historyRow];
  }
  let lastTableRow = -1;
  for (let i = historyHeadingIdx + 1; i < lines.length; i += 1) {
    if (/^\|/.test(lines[i].trim())) lastTableRow = i;
  }
  if (lastTableRow === -1) {
    return [...lines, historyRow];
  }
  const out = lines.slice();
  out.splice(lastTableRow + 1, 0, historyRow);
  return out;
}

// The DO entry point: read real artifacts, compute the rollup, write the file.
// Returns { outputPath, changed, inputs }. `now` (ISO) controls the date so tests
// are deterministic; defaults to the wall clock for the live verb.
function rollup({
  maturityPath = DEFAULT_MATURITY_PATH,
  plansDir = DEFAULT_PLANS_DIR,
  journalPath = DEFAULT_JOURNAL_PATH,
  insightsReport,
  now = new Date().toISOString(),
  write = true,
} = {}) {
  const dateText = String(now).slice(0, 10);
  const maturityText = fs.existsSync(maturityPath) ? fs.readFileSync(maturityPath, "utf8") : "";
  const journalText = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
  const gateSignals = collectGateDimensionSignals(plansDir);

  // Source the gate-health rollup from the REAL `gov insights` engine unless a
  // report is injected (tests inject a fixture report).
  let report = insightsReport;
  if (!report) {
    const engine = require("./insight-reports.js");
    report = engine.generateReport({ now });
  }

  const prior = parseLastUpdated(maturityText);
  const inputs = computeRollupInputs({
    insightsReport: report,
    gateSignals,
    journalText,
    sinceMs: prior && prior.dateMs != null ? prior.dateMs : NaN,
  });

  const next = applyRollup({ maturityText, inputs, dateText });
  const changed = next !== maturityText;
  if (write && changed) {
    fs.writeFileSync(maturityPath, next, "utf8");
  }
  return { outputPath: maturityPath, changed, inputs, content: next };
}

module.exports = {
  // shared
  parseLastUpdated,
  countLandingsSince,
  parseGateDimensionSignals,
  collectGateDimensionSignals,
  // DETECT
  detectMaturityStaleness,
  detectMaturityStalenessFromDisk,
  // DO
  computeRollupInputs,
  applyRollup,
  rollup,
  // constants
  MATURITY_STALE_DAYS,
  MATURITY_STALE_LANDINGS,
  DEFAULT_MATURITY_PATH,
  DEFAULT_PLANS_DIR,
  DEFAULT_JOURNAL_PATH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "detect") {
    const findings = detectMaturityStalenessFromDisk({ now: Date.now() });
    if (findings.length === 0) {
      process.stdout.write("coverage-maturity: TEST_MATURITY.md is fresh; no staleness finding.\n");
    } else {
      process.stdout.write(findings.join("\n") + "\n");
    }
  } else if (cmd === "rollup" || cmd === "--rollup") {
    const res = rollup({ now: new Date().toISOString() });
    process.stdout.write(
      `coverage-rollup: ${res.changed ? "refreshed" : "no change (idempotent)"} ` +
        `${path.relative(ROOT_DIR, res.outputPath)} — ` +
        `gate ${res.inputs.gate.failing_cycles}/${res.inputs.gate.total_cycles} failing, ` +
        `${res.inputs.recovery_events} recoveries` +
        (res.inputs.mutation ? `, mutation ${res.inputs.mutation.result}` : "") +
        ".\n"
    );
  } else {
    process.stdout.write(
      [
        "coord/scripts/coverage-maturity.js — COORD-243 coverage-maturity DETECT + DO.",
        "",
        "Usage:",
        "  node coord/scripts/coverage-maturity.js detect    print TEST_MATURITY staleness findings (read-only)",
        "  node coord/scripts/coverage-maturity.js rollup     refresh coord/TEST_MATURITY.md from real artifacts (writes)",
        "",
        "DETECT is what `gov doctor` calls (read-only, sub-second). DO is the",
        "`gov coverage-rollup` verb body. The TRIGGER (cadence) lives in",
        "coverage-rollup-cron.js + coord/docs/TESTING_AND_GATES.md.",
        "",
      ].join("\n")
    );
  }
}
