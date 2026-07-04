#!/usr/bin/env node
// coord/scripts/evidence-export.mjs (COORD-019)
//
// Control-mapped, read-only audit-record exporter over existing governed state.
//
// Concord already RECORDS the evidence (governance journal, plan records, board
// indexes). This tool PACKAGES and MAPS it to compliance controls (EU AI Act,
// NIST AI RMF). It invents no data; it fails closed by flagging gaps when a
// done ticket is missing required evidence, rather than omitting them silently.
// It never mutates governed state.
//
// Usage:
//   node coord/scripts/evidence-export.mjs --ticket <ID> [--ticket <ID> ...]
//   node coord/scripts/evidence-export.mjs --scope period --from <ISO> --to <ISO>
//   node coord/scripts/evidence-export.mjs --scope repo --repo <CODE>
//   node coord/scripts/evidence-export.mjs                # all done tickets
// Options:
//   --framework eu-ai-act|nist-ai-rmf|all   (default: all)
//   --format json|md                        (default: json)
//   --coord-dir <path>                       (default: ./coord)
//   --out <path>                             (default: stdout)
//
// A future `gov evidence-export` wrapper can shell to this script once the verb
// is added to the governed help/parity surface.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Control maps are shipped framework data. Resolve a project override under
 * <coordDir>/product/control-maps first, then fall back to the maps shipped
 * alongside this script (coord/product/control-maps). This lets the exporter run
 * against any coord (e.g. the bundled demo) without each project copying maps.
 */
function controlMapPath(coordDir, name) {
  const local = path.join(coordDir, "product", "control-maps", `${name}.json`);
  if (fs.existsSync(local)) return local;
  return path.join(SCRIPT_DIR, "..", "product", "control-maps", `${name}.json`);
}

function parseArgs(argv) {
  const a = { tickets: [], scope: null, framework: "all", format: "json", coordDir: "coord", out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--ticket") { a.tickets.push(v); i++; }
    else if (k === "--scope") { a.scope = v; i++; }
    else if (k === "--from") { a.from = v; i++; }
    else if (k === "--to") { a.to = v; i++; }
    else if (k === "--repo") { a.repo = v; i++; }
    else if (k === "--framework") { a.framework = v; i++; }
    else if (k === "--format") { a.format = v; i++; }
    else if (k === "--coord-dir") { a.coordDir = v; i++; }
    else if (k === "--out") { a.out = v; i++; }
  }
  return a;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function readBoardRows(board) {
  const rows = {};
  for (const s of board.sections || []) {
    if (s.kind === "table") for (const r of s.rows || []) rows[r.ID] = r;
  }
  return rows;
}

function readJournalByTicket(coordDir) {
  const p = path.join(coordDir, ".runtime", "governance-events.ndjson");
  const byTicket = {};
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch { return byTicket; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.ticket) continue;
    (byTicket[e.ticket] ||= []).push({ raw: line, ev: e });
  }
  return byTicket;
}

/** A plan_record list of "Key: value" strings -> { key: value }. */
function parseClosure(list) {
  const out = {};
  for (const item of list || []) {
    const idx = String(item).indexOf(":");
    if (idx > 0) out[String(item).slice(0, idx).trim().toLowerCase()] = String(item).slice(idx + 1).trim();
  }
  return out;
}

function gateResult(gateStr) {
  const m = /result=([a-z-]+)/i.exec(gateStr);
  if (m) return m[1].toLowerCase();
  if (/not-required/i.test(gateStr)) return "not-required";
  return "unknown";
}

const REQUIRED_CYCLES = (repo) => (repo === "X" ? 3 : 4);

/** Per-evidence-type status for a ticket: present | absent | not_applicable. */
function evidenceStatus(ticket) {
  const { repo, plan, journal, landing, pr } = ticket;
  const closure = parseClosure(plan.requirement_closure);
  const cycles = Array.isArray(plan.self_review_cycles) ? plan.self_review_cycles.length : 0;
  const proofs = Array.isArray(plan.feature_proof) ? plan.feature_proof.filter(Boolean).length : 0;
  const gates = Array.isArray(plan.repo_gates) ? plan.repo_gates : [];
  const gatesOk = gates.some((g) => ["pass", "not-required"].includes(gateResult(g)));

  return {
    journal_log: journal.length > 0 ? "present" : "absent",
    requirement_closure: (closure["closeout verdict"] || "").toLowerCase() === "complete" ? "present" : "absent",
    feature_proof: proofs > 0 ? "present" : (repo === "X" ? "not_applicable" : "absent"),
    review_cycles: cycles >= REQUIRED_CYCLES(repo) ? "present" : "absent",
    repo_gates: gatesOk ? "present" : "absent",
    landing_provenance: (landing || (Array.isArray(pr) && pr.length)) ? "present" : "absent",
    // Informational: recorded risk-acceptance. Never a gap on its own.
    waivers: "present",
  };
}

function buildTicketEvidence(id, rows, plans, journalByTicket, board) {
  const row = rows[id] || { ID: id, Repo: "?", Status: "unknown" };
  const plan = plans[id] || {};
  const entries = (journalByTicket[id] || []).map((x) => x.ev);
  const ticket = {
    repo: row.Repo,
    plan,
    journal: entries,
    landing: (board.landing_index || {})[id] || null,
    pr: (board.pr_index || {})[id] || null,
  };
  const status = evidenceStatus(ticket);
  const closure = parseClosure(plan.requirement_closure);
  const gaps = Object.entries(status).filter(([, s]) => s === "absent").map(([k]) => k);
  return {
    id,
    repo: row.Repo,
    type: row.Type,
    priority: row.Pri,
    status: row.Status,
    requirement_closure: {
      ticket_ask: closure["ticket ask"] || null,
      implemented: closure["implemented"] || null,
      not_implemented: closure["not implemented"] || null,
      deferred_to: closure["deferred to"] || null,
      verdict: closure["closeout verdict"] || null,
    },
    feature_proof: plan.feature_proof || [],
    review_cycles: (plan.self_review_cycles || []).map((c) => ({ lens: c.lens, verdict: c.verdict })),
    review_cycle_count: (plan.self_review_cycles || []).length,
    critical_invariants: plan.critical_invariants || [],
    repo_gates: plan.repo_gates || [],
    landing_provenance: ticket.landing,
    pr_refs: ticket.pr,
    waivers: (board.waiver_index || {})[id] || null,
    followup_exceptions: (board.followup_exceptions || {})[id] || null,
    journal: entries.map((e) => ({
      ts: e.ts, command: e.command, before: e.before_status, after: e.after_status,
      actor: e.identity ? (e.identity.owner || e.identity.thread_id || null) : null, result: e.result,
    })),
    evidence_status: status,
    evidence_gaps: gaps,
    complete: gaps.length === 0,
  };
}

function controlMatrix(framework, tickets) {
  const controls = framework.controls.map((c) => {
    const perTicket = tickets.map((t) => {
      const statuses = c.evidence.map((e) => t.evidence_status[e]);
      const status = statuses.includes("absent") ? "gap"
        : statuses.every((s) => s === "not_applicable") ? "not_applicable" : "covered";
      return { ticket: t.id, status, evidence: c.evidence };
    });
    const anyGap = perTicket.some((p) => p.status === "gap");
    return { control: c.id, title: c.title, evidence: c.evidence, status: anyGap ? "gap" : "covered", per_ticket: perTicket };
  });
  return { framework: framework.framework, version: framework.version, controls };
}

function stableStringify(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    }
    return v;
  }, 2);
}

function selectTickets(args, rows, journalByTicket) {
  if (args.tickets.length) return args.tickets;
  const all = Object.values(rows);
  if (args.scope === "repo" && args.repo) {
    return all.filter((r) => r.Repo === args.repo && r.Status === "done").map((r) => r.ID).sort();
  }
  if (args.scope === "period" && args.from && args.to) {
    const ids = new Set();
    for (const [id, evs] of Object.entries(journalByTicket)) {
      if (evs.some((x) => x.ev.ts >= args.from && x.ev.ts <= args.to && x.ev.after === "done")) ids.add(id);
    }
    return [...ids].sort();
  }
  return all.filter((r) => r.Status === "done").map((r) => r.ID).sort();
}

function renderMarkdown(pkg) {
  const L = [];
  L.push(`# Evidence Export\n`);
  L.push(`- Scope: **${pkg.scope}** · Tickets: **${pkg.tickets.length}** · Integrity (journal hash): \`${pkg.integrity.journal_sha256.slice(0, 16)}…\``);
  L.push(`- Gaps: **${pkg.summary.tickets_with_gaps}** ticket(s) with missing evidence\n`);
  for (const fw of pkg.frameworks) {
    L.push(`## ${fw.framework} ${fw.version}\n`);
    L.push(`| Control | Title | Status |`);
    L.push(`|---|---|---|`);
    for (const c of fw.controls) L.push(`| ${c.control} | ${c.title} | ${c.status === "gap" ? "⚠️ gap" : "✅ covered"} |`);
    L.push("");
  }
  if (pkg.live_mcp && pkg.live_mcp.total > 0) {
    L.push(`## Live-MCP\n`);
    L.push(`- Live-MCP tickets: **${pkg.live_mcp.total}** · with unresolved cleanup/promote blockers: **${pkg.live_mcp.with_unresolved_blockers}**\n`);
    for (const t of pkg.live_mcp.tickets) {
      const head = `### ${t.id} — ${t.operation_class || "?"} @ ${t.environment || "?"} (${t.status})`;
      L.push(t.unresolved_blockers.length ? `${head}  ⚠️ ${t.unresolved_blockers.length} unresolved blocker(s)` : head);
      L.push(`- Adapter: ${t.adapter || "—"} · receipt: ${t.receipt_present ? (t.receipt && t.receipt.path ? t.receipt.path : "recorded") : "⚠️ none"}`);
      for (const b of t.unresolved_blockers) L.push(`- ⚠️ ${b.code}: ${b.message}`);
      L.push("");
    }
  }
  L.push(`## Tickets\n`);
  for (const t of pkg.tickets) {
    L.push(`### ${t.id} — ${t.status}${t.complete ? "" : "  ⚠️ GAPS: " + t.evidence_gaps.join(", ")}`);
    L.push(`- Ask: ${t.requirement_closure.ticket_ask || "—"}`);
    L.push(`- Verdict: ${t.requirement_closure.verdict || "—"} · review cycles: ${t.review_cycle_count} · feature proofs: ${t.feature_proof.length}`);
    L.push(`- Landed: ${t.landing_provenance ? "yes" : (t.pr_refs ? JSON.stringify(t.pr_refs) : "—")}`);
    L.push("");
  }
  return L.join("\n");
}

/**
 * COORD-156 — live-MCP evidence section.
 *
 * The export must HONESTLY show production-MCP state: the recorded live-MCP
 * receipts AND any UNRESOLVED cleanup/promote (or other) closeout blockers, so a
 * dossier reader sees what is still pending rather than an implicitly-complete
 * picture. We REUSE the COORD-153 lifecycle gate (buildLiveMcpLifecycle /
 * readLiveMcpDeclaration) to detect live-MCP tickets and derive their blockers —
 * detection is explicit (a declared `live_mcp` plan object), never keyword fuzzy.
 *
 * Pure read: loads the lifecycle module from this script's own dir (it is a pure
 * function; it never calls a tool/network), reads plan records + recorded
 * receipts from the SCOPED coord dir, and degrades to an empty section when the
 * module or receipts are unavailable. It never mutates governed state.
 */
function loadLiveMcpModule() {
  try {
    return require(path.join(SCRIPT_DIR, "live-mcp-lifecycle.js"));
  } catch {
    return null;
  }
}

function findLatestLiveMcpReceipt(coordDir, ticketId) {
  const base = path.join(coordDir, "evidence", "live-mcp");
  let files;
  try {
    files = fs.readdirSync(base);
  } catch {
    return null;
  }
  const slug = String(ticketId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const matches = files
    .filter((name) => name.endsWith(".json") && name.includes(`-${slug}-`))
    .sort();
  return matches.length ? path.join(base, matches[matches.length - 1]) : null;
}

function buildLiveMcpEvidence(coordDir, plans, rows) {
  const mod = loadLiveMcpModule();
  if (!mod || typeof mod.buildLiveMcpLifecycle !== "function") {
    return { tickets: [], total: 0, with_unresolved_blockers: 0, available: false };
  }
  const tickets = [];
  for (const [id, plan] of Object.entries(plans)) {
    const declaration = mod.readLiveMcpDeclaration(plan);
    if (!declaration) continue; // not a live-MCP ticket — explicit detection only
    const result = mod.buildLiveMcpLifecycle({ planState: plan });
    const blockers = Array.isArray(result.issues) ? result.issues : [];
    const receiptFile = findLatestLiveMcpReceipt(coordDir, id);
    let receipt = null;
    if (receiptFile) {
      const parsed = readJson(receiptFile, null);
      if (parsed) {
        receipt = {
          path: path.relative(path.dirname(coordDir), receiptFile).split(path.sep).join("/"),
          result: parsed.result || null,
          operation_class: parsed.operation_class || null,
        };
      }
    } else if (declaration.receipt && typeof declaration.receipt === "object") {
      receipt = { path: null, result: declaration.receipt.result || null, embedded: true };
    } else if (typeof declaration.receipt_path === "string" && declaration.receipt_path.trim()) {
      receipt = { path: declaration.receipt_path.trim(), result: null };
    }
    tickets.push({
      id,
      status: (rows[id] || {}).Status || "unknown",
      adapter: typeof declaration.adapter === "string" ? declaration.adapter : null,
      operation_class:
        typeof declaration.operation_class === "string" ? declaration.operation_class : null,
      environment: typeof declaration.environment === "string" ? declaration.environment : null,
      receipt,
      receipt_present: Boolean(receipt),
      unresolved_blockers: blockers,
    });
  }
  tickets.sort((a, b) => a.id.localeCompare(b.id));
  return {
    available: true,
    total: tickets.length,
    with_unresolved_blockers: tickets.filter((t) => t.unresolved_blockers.length > 0).length,
    tickets,
  };
}

export function buildEvidenceExport(args) {
  const coordDir = args.coordDir;
  const board = readJson(path.join(coordDir, "board", "tasks.json"), null);
  if (!board) throw new Error(`Cannot read board at ${coordDir}/board/tasks.json`);
  const rows = readBoardRows(board);
  const journalByTicket = readJournalByTicket(coordDir);
  const plansDir = path.join(coordDir, ".runtime", "plans");
  const plans = {};
  try { for (const f of fs.readdirSync(plansDir)) if (f.endsWith(".json")) plans[f.replace(/\.json$/, "")] = readJson(path.join(plansDir, f), {}); } catch { /* none */ }

  const ids = selectTickets(args, rows, journalByTicket);
  const tickets = ids.map((id) => buildTicketEvidence(id, rows, plans, journalByTicket, board));

  // Integrity: stable hash over the sorted raw journal lines included in scope.
  const rawLines = ids.flatMap((id) => (journalByTicket[id] || []).map((x) => x.raw)).sort();
  const journalSha = crypto.createHash("sha256").update(rawLines.join("\n"), "utf8").digest("hex");

  const frameworks = [];
  const want = args.framework === "all" ? ["eu-ai-act", "nist-ai-rmf"] : [args.framework];
  for (const name of want) {
    const fw = readJson(controlMapPath(coordDir, name), null);
    if (fw) frameworks.push(controlMatrix(fw, tickets));
  }

  // Live-MCP evidence is surveyed across ALL plan records (not just in-scope
  // done tickets): an unresolved cleanup/promote blocker most often lives on a
  // not-yet-done live-MCP ticket, and the export must show it honestly.
  const liveMcp = buildLiveMcpEvidence(coordDir, plans, rows);

  const pkg = {
    schema_version: 1,
    scope: args.tickets.length ? "ticket" : (args.scope || "all-done"),
    tickets,
    live_mcp: liveMcp,
    frameworks,
    summary: {
      ticket_count: tickets.length,
      tickets_with_gaps: tickets.filter((t) => !t.complete).length,
      controls_with_gaps: frameworks.reduce((n, f) => n + f.controls.filter((c) => c.status === "gap").length, 0),
      live_mcp_tickets: liveMcp.total,
      live_mcp_with_unresolved_blockers: liveMcp.with_unresolved_blockers,
    },
    integrity: { journal_sha256: journalSha, journal_event_count: rawLines.length },
  };

  return {
    pkg,
    body: args.format === "md" ? renderMarkdown(pkg) : stableStringify(pkg),
    exitCode: pkg.summary.tickets_with_gaps > 0 ? 3 : 0,
  };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv);
    const result = buildEvidenceExport(args);
    if (args.out) {
      fs.writeFileSync(args.out, result.body + "\n", "utf8");
      err.write(`Wrote ${args.out}\n`);
    } else {
      out.write(result.body + "\n");
    }
    return result.exitCode;
  } catch (e) {
    err.write((e && e.message ? e.message : String(e)) + "\n");
    return 2;
  }
}

function main() {
  process.exitCode = runCli(process.argv.slice(2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
