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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const coordDir = args.coordDir;
  const board = readJson(path.join(coordDir, "board", "tasks.json"), null);
  if (!board) { console.error(`Cannot read board at ${coordDir}/board/tasks.json`); process.exit(2); }
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

  const pkg = {
    schema_version: 1,
    scope: args.tickets.length ? "ticket" : (args.scope || "all-done"),
    tickets,
    frameworks,
    summary: {
      ticket_count: tickets.length,
      tickets_with_gaps: tickets.filter((t) => !t.complete).length,
      controls_with_gaps: frameworks.reduce((n, f) => n + f.controls.filter((c) => c.status === "gap").length, 0),
    },
    integrity: { journal_sha256: journalSha, journal_event_count: rawLines.length },
  };

  const body = args.format === "md" ? renderMarkdown(pkg) : stableStringify(pkg);
  if (args.out) { fs.writeFileSync(args.out, body + "\n", "utf8"); console.error(`Wrote ${args.out}`); }
  else { process.stdout.write(body + "\n"); }
  // Non-zero exit if any gap, so CI can fail closed.
  if (pkg.summary.tickets_with_gaps > 0) process.exitCode = 3;
}

main();
