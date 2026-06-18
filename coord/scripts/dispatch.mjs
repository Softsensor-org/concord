#!/usr/bin/env node
// ---------------------------------------------------------------------------
// COORD-032: wired dispatch loop — reference harness (TOKEN_ECONOMICS.md).
//
// Provider-AGNOSTIC reference harness for the wired dispatch loop. It does NOT
// spawn agents — coord can't, and must not, own execution. It consumes the
// `gov dispatch-plan` manifest (COORD-031) and prints, per wave and per ticket,
// the EXACT orchestrator action so the token-economics savings are automatic
// rather than merely available:
//
//   SKIP  — precheck verdict already-satisfied. Prints the governed
//           finalize-already-satisfied command to close the ticket (no agent run).
//   SPAWN — everything else. Prints the suggested model class (from the tier
//           lever), the assembled prompt = a STABLE cached-prefix marker + the
//           ticket-specific context-pack body (so N agents in a wave share one
//           cached prefix), and the post-run `gov record-cost` template to call
//           with the agent's ACTUAL usage (the cost-from-usage convention).
//
// Read-only and deterministic: it invokes `gov dispatch-plan --json` through the
// governance module (itself hash-stable) or reads a manifest file; it never
// mutates board/lifecycle state.
//
// Usage:
//   node coord/scripts/dispatch.mjs [--status todo] [--repo <code>] [--wave N] [--json]
//   node coord/scripts/dispatch.mjs --manifest <path>      # consume a saved manifest
//
// The cost-from-usage convention (how a finished agent's usage maps to the
// ledger) is documented in coord/docs/MULTI_AGENT_BURNIN_RUNBOOK.md ("Wired
// dispatch loop"); the record-cost template below is the executable form of it.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOVERNANCE_JS = path.join(SCRIPT_DIR, "governance.js");
const require = createRequire(import.meta.url);

function dispatchError(message, status = 1) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseArgs(argv) {
  const opts = { json: false, status: null, repo: null, wave: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--status") opts.status = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--wave") opts.wave = argv[++i];
    else if (a === "--manifest") opts.manifest = argv[++i];
    else {
      throw dispatchError(`dispatch.mjs: unknown argument "${a}"`, 2);
    }
  }
  return opts;
}

function loadManifest(opts) {
  // Either consume a saved manifest (offline/reproducible) or invoke the
  // deterministic `gov dispatch-plan --json`. Both yield the same shape.
  if (opts.manifest) {
    return JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
  }
  const args = ["dispatch-plan", "--json"];
  if (opts.status) args.push("--status", opts.status);
  if (opts.repo) args.push("--repo", opts.repo);
  if (opts.wave) args.push("--wave", String(opts.wave));
  const governance = require(GOVERNANCE_JS);
  const result = governance.executeCommand(args);
  if (!result.ok) {
    throw dispatchError(result.stderr || result.error || "dispatch.mjs: gov dispatch-plan failed", 1);
  }
  return JSON.parse(result.stdout);
}

// The post-run cost-from-usage template. The orchestrator substitutes the
// agent's ACTUAL reported usage (input/output tokens, model) after the run, so
// the cost ledger fills automatically. Placeholders are explicit.
function recordCostTemplate(ticket, modelClass) {
  return (
    `coord/scripts/gov record-cost ${ticket} ` +
    `--agent <handle> --model <model-id:${modelClass}> ` +
    `--input-tokens <usage.input_tokens> --output-tokens <usage.output_tokens> ` +
    `--phase implement`
  );
}

// Render the ticket-specific context-pack body (the part appended AFTER the
// shared cached prefix). Stable, deterministic ordering — mirrors the
// context-pack markdown body so the harness needs no second gov call.
function renderTicketBody(pack) {
  if (!pack || !pack.ticket_specific) return "(no context pack)";
  const t = pack.ticket_specific;
  const lines = [];
  lines.push(`## Ticket context: ${t.ticket}`);
  if (t.description) lines.push(t.description);
  lines.push("");
  lines.push("Files:");
  if (!t.files || t.files.length === 0) lines.push("- (none declared)");
  else for (const f of t.files) lines.push(`- ${f}`);
  lines.push("");
  lines.push("Acceptance criteria:");
  for (const ac of t.acceptance_criteria || []) lines.push(`- ${ac}`);
  lines.push("");
  lines.push("Prior feature-proofs touching these files:");
  if (!t.prior_feature_proofs || t.prior_feature_proofs.length === 0) lines.push("- (none)");
  else for (const p of t.prior_feature_proofs) lines.push(`- [${p.ticket}] ${p.proof}`);
  return lines.join("\n");
}

function buildLoop(manifest) {
  // Reshape the manifest into the orchestrator-facing loop instructions.
  const cachePrefix = manifest.cache_prefix;
  const waves = manifest.waves.map((w) => ({
    wave: w.wave,
    tickets: w.tickets.map((t) => {
      if (t.action === "skip") {
        return {
          ticket: t.ticket,
          action: "SKIP",
          reason: t.reason,
          finalize_command: t.finalize_command,
        };
      }
      return {
        ticket: t.ticket,
        action: "SPAWN",
        reason: t.reason,
        suggested_model_class: t.suggested_model_class,
        tier: t.tier,
        evidence_depth: t.evidence_depth,
        assembled_prompt: {
          // The STABLE cached prefix: identical across every ticket in the wave.
          // Place ONCE in a prompt-cache prefix; do not re-send per ticket.
          cache_prefix_marker: cachePrefix.id,
          cache_prefix_references: cachePrefix.shared_references,
          // The ticket-specific body: appended AFTER the cached prefix.
          ticket_body: t.context_pack ? renderTicketBody(t.context_pack) : (t.context_pack_ref || null),
        },
        record_cost_template: recordCostTemplate(t.ticket, t.suggested_model_class),
      };
    }),
  }));
  return {
    schema_version: 1,
    cache_prefix: { id: cachePrefix.id, references: cachePrefix.shared_references },
    wave_count: waves.length,
    waves,
    excluded: manifest.excluded || [],
  };
}

function formatHuman(loop) {
  const out = [];
  out.push(`Wired dispatch loop — ${loop.wave_count} wave(s)`);
  out.push("");
  out.push(`Cache prefix (cache ONCE per wave): ${loop.cache_prefix.id}`);
  for (const r of loop.cache_prefix.references) out.push(`  - ${r}`);
  for (const w of loop.waves) {
    out.push("");
    out.push(`=== Wave ${w.wave} ===`);
    for (const t of w.tickets) {
      out.push("");
      if (t.action === "SKIP") {
        out.push(`[SKIP] ${t.ticket} — ${t.reason}`);
        out.push(`  finalize (no agent run): ${t.finalize_command}`);
      } else {
        out.push(`[SPAWN] ${t.ticket} — ${t.reason}`);
        out.push(`  model class: ${t.suggested_model_class} (tier ${t.tier}); evidence depth: ` +
          `${t.evidence_depth.review_cycles} review / ${t.evidence_depth.feature_proofs} proof(s) / ${t.evidence_depth.critical_invariants} invariant(s)`);
        out.push(`  assembled prompt:`);
        out.push(`    [cached prefix marker] ${t.assembled_prompt.cache_prefix_marker}`);
        out.push(`    [ticket-specific body]`);
        for (const line of String(t.assembled_prompt.ticket_body || "").split("\n")) {
          out.push(`      ${line}`);
        }
        out.push(`  after the run, record cost from the agent's ACTUAL usage:`);
        out.push(`    ${t.record_cost_template}`);
      }
    }
  }
  if (loop.excluded.length > 0) {
    out.push("");
    out.push("Excluded (no silent drops):");
    for (const e of loop.excluded) out.push(`  ${e.ticket}: ${e.reason}`);
  }
  return out.join("\n") + "\n";
}

function printHuman(loop) {
  process.stdout.write(formatHuman(loop));
}

function runDispatch(argv = []) {
  try {
    const opts = parseArgs(argv);
    const manifest = loadManifest(opts);
    const loop = buildLoop(manifest);
    return {
      status: 0,
      stdout: opts.json ? `${JSON.stringify(loop)}\n` : formatHuman(loop),
      stderr: "",
    };
  } catch (error) {
    return {
      status: Number.isInteger(error?.status) ? error.status : 1,
      stdout: "",
      stderr: `${error?.stack || error?.message || String(error)}\n`,
    };
  }
}

function main() {
  const result = runDispatch(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

export {
  buildLoop,
  formatHuman,
  loadManifest,
  parseArgs,
  printHuman,
  runDispatch,
};
