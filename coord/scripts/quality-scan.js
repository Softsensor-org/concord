"use strict";

// COORD-083 (QGATE capstone): code-quality automation + periodic
// quality-ticket generator.
//
// WHAT THIS IS
//   A schedulable coord audit that (1) runs the COORD-078 arch-checks library
//   over a target repo, (2) normalizes findings into proposed governed tickets
//   with a STABLE per-finding key, (3) DEDUPS against tickets already open on
//   the board, and (4) optionally FILES the survivors as governed follow-ups
//   via `gov open-followup` — the exact mechanism used manually for the
//   COORD-064..082 quality batch. This automates audit -> ticket on a cadence.
//
// SAFE BY DEFAULT
//   - Dry-run is the DEFAULT. Without --apply it prints what it WOULD file and
//     mutates nothing.
//   - A per-run CAP (default 5) prevents a noisy scan from flooding the board.
//     Capping is logged, never silent.
//   - A severity floor (default "fail") limits which findings become tickets.
//     The "fail" default only files ESCALATED findings; because arch-checks is
//     warning-first, the conservative ad-hoc default files nothing on a warn-only
//     board. The SCHEDULED cadence deliberately runs `--severity-floor warn`
//     (paired with a small --cap) to file warn-class debt in bounded batches.
//     See coord/product/QUALITY_AUTOMATION.md.
//   - Dedup: a finding whose stable key already has an OPEN (non-done /
//     non-superseded) ticket is skipped. The key is embedded in the ticket
//     description as a machine marker `[qkey:<key>]` so future runs recognize
//     their own output regardless of title wording.
//
// BOUNDARY
//   This module is the orchestration layer: arch-checks.js owns the analysis,
//   `gov open-followup` owns board mutation. We do not reimplement either. The
//   filing path SHELLS OUT to the gov CLI so every created ticket flows through
//   the same governed, validated, audit-logged mutation as a hand-filed one.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const archChecks = require("./arch-checks.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GOV_BIN = path.join(REPO_ROOT, "coord", "scripts", "gov");
const DEFAULT_BOARD = path.join(REPO_ROOT, "coord", "board", "tasks.json");

// Severity -> ticket priority. Documented mapping (overridable per-check below).
//   fail  -> P2 (must fix; escalated check fired)
//   warn  -> P3 (debt; track but lower urgency)
// monolith findings are bumped to P2 even at warn severity (architectural risk).
const SEVERITY_PRIORITY = Object.freeze({ fail: "P2", warn: "P3" });
const CHECK_PRIORITY_OVERRIDE = Object.freeze({ monolith: "P2" });

// Ordered so a higher floor excludes lower severities.
const SEVERITY_ORDER = Object.freeze(["warn", "fail"]);

const DEFAULT_OPTIONS = Object.freeze({
  root: REPO_ROOT,
  board: DEFAULT_BOARD,
  dependsOn: "COORD-083", // parent ticket: gives prompt-index coverage to followups
  repo: "X",
  type: "refactor",
  prefix: "QSCAN",
  severityFloor: "fail",
  cap: 5,
  apply: false,
});

// Machine marker embedded in every generated ticket description. The stable key
// round-trips through it so a later run can detect its own already-open tickets
// even if a human edits the human-readable title.
const QKEY_MARKER_RE = /\[qkey:([^\]]+)\]/g;

// ---------------------------------------------------------------------------
// Stable finding key. The SAME underlying issue must produce the SAME key
// across runs so dedup works. We normalize the file path (posix separators) and
// derive a per-check stable "detail" that ignores volatile measured values
// (e.g. the exact LOC count, which drifts as the file is edited) but keeps the
// identity (which file, which function, which duplicate region).
// Form: `check:file:detail`.
// ---------------------------------------------------------------------------
// COORD-126: the canonical stable-key logic now lives in arch-checks.js (the
// SOURCE of findings) so the board-dedup key here and the ratchet baseline-diff
// key there can never drift. These thin wrappers preserve this module's
// historical export names (stableDetail/stableFindingKey/normalizeFilePath)
// while delegating to the single source of truth.
const normalizeFilePath = archChecks.normalizeFindingFilePath;
const stableDetail = archChecks.stableFindingDetail;
const stableFindingKey = archChecks.stableFindingKey;

// ---------------------------------------------------------------------------
// Findings -> proposed tickets. One proposal per finding (each finding already
// represents one actionable issue at a specific site). Each proposal carries
// the stable key, a human title, evidence (file:line + value/threshold), the
// severity->priority mapping, and a suggested-fix framing.
// ---------------------------------------------------------------------------
function priorityFor(finding) {
  if (CHECK_PRIORITY_OVERRIDE[finding.check]) return CHECK_PRIORITY_OVERRIDE[finding.check];
  return SEVERITY_PRIORITY[finding.severity] || "P3";
}

const FIX_FRAMING = Object.freeze({
  size: "Split this file into cohesive modules to bring it under the LOC budget.",
  monolith: "Decompose this monolith; extract sub-modules to halt unbounded growth.",
  complexity: "Refactor this function: extract helpers / flatten branching to reduce cyclomatic complexity.",
  imports: "Remove the disallowed cross-module import; route through the declared boundary instead.",
  duplication: "Extract the duplicated block into a shared helper and call it from both sites.",
  hardcoding: "Move this magic literal to config or a named shared constant (config-seam hygiene).",
  deadcode: "Confirm the symbol is truly unreferenced (incl. dispatch tables/tests), then delete it.",
});

function titleFor(finding) {
  const file = normalizeFilePath(finding.file);
  switch (finding.check) {
    case "size":
      return `Reduce file size: ${file} (${finding.value} LOC > ${finding.threshold})`;
    case "monolith":
      return `Decompose monolith: ${file} (${finding.value} LOC > ${finding.threshold})`;
    case "complexity": {
      const m = /function\s+(\S+)\s+in/.exec(String(finding.message || ""));
      const fn = m ? m[1] : `function@${finding.line}`;
      return `Reduce complexity: ${fn} in ${file} (~${finding.value} > ${finding.threshold})`;
    }
    case "imports":
      return `Fix import boundary: ${file} imports ${finding.value}`;
    case "duplication":
      return `De-duplicate code: ${finding.value}-line block in ${file}`;
    case "hardcoding":
      return `Extract hardcoded literal in ${file}${finding.line != null ? `:${finding.line}` : ""}`;
    case "deadcode":
      return `Remove or justify dead code: '${finding.value}' in ${file}`;
    default:
      return `Quality finding: ${finding.check} in ${file}`;
  }
}

function findingToProposal(finding) {
  const key = stableFindingKey(finding);
  const file = normalizeFilePath(finding.file);
  const where = finding.line != null ? `${file}:${finding.line}` : file;
  const title = titleFor(finding);
  const fix = FIX_FRAMING[finding.check] || "Address the flagged code-quality finding.";
  // The description is what gets filed. It embeds the qkey marker for dedup and
  // a structured evidence line so a human reviewer has full context.
  const description =
    `[auto-quality] ${title}. ` +
    `Evidence: ${where} value=${finding.value} threshold=${finding.threshold} severity=${finding.severity}. ` +
    `Detail: ${finding.message}. ` +
    `Suggested fix: ${fix} ` +
    `[qkey:${key}]`;
  return {
    key,
    check: finding.check,
    severity: finding.severity,
    pri: priorityFor(finding),
    file,
    line: finding.line != null ? finding.line : null,
    title,
    description,
    evidence: { where, value: finding.value, threshold: finding.threshold, message: finding.message },
  };
}

// Group proposals for display / reporting (by check). Filing is per-proposal,
// but the grouped view makes the dry-run output and report readable.
function groupProposals(proposals) {
  const byCheck = {};
  for (const p of proposals) {
    (byCheck[p.check] = byCheck[p.check] || []).push(p);
  }
  return byCheck;
}

// ---------------------------------------------------------------------------
// Dedup against the live board. We collect, from every OPEN ticket
// (non-done / non-superseded), the set of stable keys recorded in its
// description's [qkey:...] marker(s). A proposal whose key is in that set is a
// duplicate and is skipped.
// ---------------------------------------------------------------------------
function boardRows(board) {
  const rows = [];
  for (const section of board.sections || []) {
    if (Array.isArray(section.rows)) rows.push(...section.rows);
  }
  return rows;
}

const CLOSED_STATUSES = new Set(["done", "superseded"]);

function openTicketKeys(board) {
  const keys = new Set();
  for (const row of boardRows(board)) {
    const status = String(row.Status || "").toLowerCase();
    if (CLOSED_STATUSES.has(status)) continue;
    const desc = String(row.Description || "");
    let m;
    QKEY_MARKER_RE.lastIndex = 0;
    while ((m = QKEY_MARKER_RE.exec(desc)) !== null) {
      keys.add(m[1]);
    }
  }
  return keys;
}

function readBoard(boardPath) {
  return JSON.parse(fs.readFileSync(boardPath, "utf8"));
}

// ---------------------------------------------------------------------------
// Planning: turn findings into a filing plan honoring severity floor, dedup,
// and the cap. PURE — no fs, no board mutation. Caller supplies the loaded
// board + findings. Returns the full accounting so nothing is silently dropped.
// ---------------------------------------------------------------------------
function severityAtLeast(severity, floor) {
  const si = SEVERITY_ORDER.indexOf(severity);
  const fi = SEVERITY_ORDER.indexOf(floor);
  if (si === -1 || fi === -1) return false;
  return si >= fi;
}

function planTickets({ findings = [], board = { sections: [] }, severityFloor = "fail", cap = 5 } = {}) {
  const openKeys = openTicketKeys(board);

  const belowFloor = [];
  const candidates = [];
  for (const finding of findings) {
    if (!severityAtLeast(finding.severity, severityFloor)) {
      belowFloor.push(finding);
      continue;
    }
    candidates.push(findingToProposal(finding));
  }

  // Dedup: two distinct skip reasons, tracked separately so the report does
  // not conflate them. skippedOpen = key already has an OPEN board ticket;
  // skippedInRun = a duplicate WITHIN this same scan run (two findings
  // collapsing to one key -> file once).
  const skippedOpen = [];
  const skippedInRun = [];
  const seenThisRun = new Set();
  const deduped = [];
  for (const p of candidates) {
    if (openKeys.has(p.key)) {
      skippedOpen.push(p);
      continue;
    }
    if (seenThisRun.has(p.key)) {
      skippedInRun.push(p);
      continue;
    }
    seenThisRun.add(p.key);
    deduped.push(p);
  }

  // Cap: deterministically prefer higher-priority (P2 before P3) then by key.
  deduped.sort((a, b) => (a.pri < b.pri ? -1 : a.pri > b.pri ? 1 : a.key < b.key ? -1 : 1));
  const toFile = deduped.slice(0, cap);
  const capped = deduped.slice(cap);

  return {
    toFile,
    capped,
    skippedOpen,
    skippedInRun,
    // Combined accessor: preserved so consumers that only care about the total
    // number of deduped-away proposals keep working.
    get skippedDuplicate() {
      return [...skippedOpen, ...skippedInRun];
    },
    belowFloor,
    counts: {
      findings: findings.length,
      belowFloor: belowFloor.length,
      skippedOpen: skippedOpen.length,
      skippedInRun: skippedInRun.length,
      // Combined count: total deduped-away (open + in-run), preserved for
      // backward compatibility.
      duplicate: skippedOpen.length + skippedInRun.length,
      eligible: deduped.length,
      toFile: toFile.length,
      capped: capped.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Scan: run arch-checks over the target root and return its findings.
// ---------------------------------------------------------------------------
function scan({ root, config } = {}) {
  return archChecks.scanRepo({ root, config });
}

// ---------------------------------------------------------------------------
// Filing: shell each surviving proposal through `gov open-followup`. Returns
// the created ticket ids (parsed from gov output) and any failures. Only called
// under --apply.
// ---------------------------------------------------------------------------
function fileTicket(proposal, opts, runner = spawnSync) {
  const args = [
    "open-followup",
    "--prefix", opts.prefix,
    "--depends-on", opts.dependsOn,
    "--repo", opts.repo,
    "--type", opts.type,
    "--pri", proposal.pri,
    "--description", proposal.description,
    "--relation", "related",
  ];
  const env = Object.assign({}, process.env);
  if (!env.COORD_SESSION_ID) env.COORD_SESSION_ID = "coord-quality-scan";
  const res = runner(GOV_BIN, args, { cwd: REPO_ROOT, encoding: "utf8", env });
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  if (res.status !== 0) {
    return { ok: false, proposal, error: (stderr || stdout || `exit ${res.status}`).trim() };
  }
  const m = /follow-up ticket (\S+) after/.exec(stdout);
  return { ok: true, proposal, ticket: m ? m[1] : null, output: stdout.trim() };
}

function applyPlan(plan, opts, runner = spawnSync) {
  const created = [];
  const failed = [];
  for (const proposal of plan.toFile) {
    const result = fileTicket(proposal, opts, runner);
    if (result.ok) created.push(result);
    else failed.push(result);
  }
  return { created, failed };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function formatPlan(plan, opts, summary) {
  const lines = [];
  lines.push(archChecks.formatArchSummary(summary));
  lines.push(
    `quality-scan: mode=${opts.apply ? "APPLY" : "dry-run"} floor=${opts.severityFloor} cap=${opts.cap} ` +
    `findings=${plan.counts.findings} below-floor=${plan.counts.belowFloor} ` +
    `skipped-open=${plan.counts.skippedOpen} skipped-in-run=${plan.counts.skippedInRun} ` +
    `eligible=${plan.counts.eligible} ` +
    `to-file=${plan.counts.toFile} capped=${plan.counts.capped}`
  );
  if (plan.toFile.length) {
    lines.push(opts.apply ? "Filing (apply):" : "Would file (dry-run):");
    for (const p of plan.toFile) {
      lines.push(`  [${p.pri}] ${p.title}`);
      lines.push(`        key=${p.key}`);
    }
  }
  if (plan.skippedOpen.length) {
    lines.push(`Skipped (already open): ${plan.skippedOpen.length}`);
    for (const p of plan.skippedOpen) lines.push(`  - ${p.key}`);
  }
  if (plan.skippedInRun.length) {
    lines.push(`Skipped (duplicate within scan): ${plan.skippedInRun.length}`);
    for (const p of plan.skippedInRun) lines.push(`  - ${p.key}`);
  }
  if (plan.capped.length) {
    lines.push(`Capped (not filed this run, will resurface next run): ${plan.capped.length}`);
    for (const p of plan.capped) lines.push(`  - [${p.pri}] ${p.key}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = Object.assign({}, DEFAULT_OPTIONS);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case "--apply": opts.apply = true; break;
      case "--dry-run": opts.apply = false; break;
      case "--root": opts.root = next(); break;
      case "--board": opts.board = next(); break;
      case "--depends-on": opts.dependsOn = next(); break;
      case "--repo": opts.repo = next(); break;
      case "--type": opts.type = next(); break;
      case "--prefix": opts.prefix = next(); break;
      case "--severity-floor": opts.severityFloor = next(); break;
      case "--cap": opts.cap = parseInt(next(), 10); break;
      case "--config": opts.configPath = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    }
  }
  return opts;
}

const USAGE = `usage: quality-scan.js [--apply] [--root <dir>] [--board <path>]
  [--depends-on <ticket>] [--repo <code>] [--type <type>] [--prefix <PREFIX>]
  [--severity-floor warn|fail] [--cap <n>] [--config <json>]

Runs the arch-checks code-quality library over <root>, dedups findings against
open tickets on <board>, and (with --apply) files governed follow-up tickets
via 'gov open-followup'. DRY-RUN IS THE DEFAULT: without --apply nothing is
written. A per-run cap (default ${DEFAULT_OPTIONS.cap}) prevents board flooding.

SEVERITY FLOOR — two intended modes:
  --severity-floor fail  (DEFAULT): files only ESCALATED, fail-severity findings.
      arch-checks is warning-first (size/complexity/duplication/monolith/
      hardcoding/deadcode all default to severity "warn"), so on a board with
      only warn-class debt this conservative default files NOTHING. That is the
      intended ad-hoc/interactive default: do not surprise an interactive caller
      by mass-filing debt tickets.
  --severity-floor warn  (the CADENCE mode): files warn-class debt too. This is
      the floor the SCHEDULED run uses (see QUALITY_AUTOMATION.md) so real,
      residual debt is surfaced in bounded batches. ALWAYS pair with a small
      --cap; the cap + dedup are what keep the board from flooding.`;

function runCli(argv, { stdout, stderr } = {}, runner = spawnSync) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err.write(`quality-scan: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    out.write(USAGE + "\n");
    return 0;
  }
  if (!SEVERITY_ORDER.includes(opts.severityFloor)) {
    err.write(`quality-scan: invalid --severity-floor ${opts.severityFloor} (use warn|fail)\n`);
    return 2;
  }
  if (!Number.isInteger(opts.cap) || opts.cap < 0) {
    err.write(`quality-scan: invalid --cap (need a non-negative integer)\n`);
    return 2;
  }

  let config;
  if (opts.configPath) {
    try {
      config = JSON.parse(fs.readFileSync(opts.configPath, "utf8"));
    } catch (e) {
      err.write(`quality-scan: could not read --config ${opts.configPath}: ${e.message}\n`);
      return 2;
    }
  }

  let board;
  try {
    board = readBoard(opts.board);
  } catch (e) {
    err.write(`quality-scan: could not read --board ${opts.board}: ${e.message}\n`);
    return 2;
  }

  const { findings, summary } = scan({ root: opts.root, config });
  const plan = planTickets({
    findings,
    board,
    severityFloor: opts.severityFloor,
    cap: opts.cap,
  });

  out.write(formatPlan(plan, opts, summary) + "\n");

  if (!opts.apply) {
    return 0; // dry-run: no mutation, success exit.
  }

  const { created, failed } = applyPlan(plan, opts, runner);
  for (const c of created) out.write(`FILED ${c.ticket || "(id?)"}: ${c.proposal.title}\n`);
  for (const f of failed) err.write(`FAILED to file ${f.proposal.key}: ${f.error}\n`);
  out.write(`quality-scan: filed=${created.length} failed=${failed.length}\n`);
  return failed.length > 0 ? 1 : 0;
}

module.exports = {
  DEFAULT_OPTIONS,
  SEVERITY_PRIORITY,
  CHECK_PRIORITY_OVERRIDE,
  normalizeFilePath,
  stableDetail,
  stableFindingKey,
  priorityFor,
  titleFor,
  findingToProposal,
  groupProposals,
  boardRows,
  openTicketKeys,
  severityAtLeast,
  planTickets,
  scan,
  fileTicket,
  applyPlan,
  formatPlan,
  parseArgs,
  runCli,
};

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {});
}
