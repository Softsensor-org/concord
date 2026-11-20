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
//           cached prefix), and phase-completion record-cost contracts for an
//           external adapter to call with actual usage or explicit unknown.
//
// Read-only and deterministic: it invokes `gov dispatch-plan --json` through the
// governance module (itself hash-stable) or reads a manifest file; it never
// mutates board/lifecycle state.
//
// Usage:
//   node coord/engine/scripts/dispatch.mjs [--status todo] [--repo <code>] [--wave N] [--execution-id <id>] [--json]
//   node coord/engine/scripts/dispatch.mjs --manifest <path>      # consume a saved manifest
//   node coord/engine/scripts/dispatch.mjs --review-manifest <path> [--json]
//       # assemble a bounded reviewer body from a supplied diff, active invariant
//       # projection, and plan record; it never scans the repository.
//
// This manifest remains read-only; it does not execute agents or observe provider
// responses. The external orchestrator must supply --execution-id and call the
// existing cost writer at each phase boundary. Missing telemetry is explicit
// unknown evidence, never a fabricated zero.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOVERNANCE_JS = path.join(SCRIPT_DIR, "governance.js");
const require = createRequire(import.meta.url);
const { resolveEngineModule } = require(path.join(SCRIPT_DIR, "..", "..", "paths.js"));
const COORD_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const ROOT_DIR = path.dirname(COORD_DIR);
const {
  normalizeContextMode,
  renderDispatchCachePrefix,
  buildDispatchCachePrefixMarker,
  resolveDispatchCachePrefixReferences,
} = require(resolveEngineModule(COORD_DIR, "scripts/dispatch-context.js"));
const { MAX_TEXT_INPUT_BYTES, createSafeTextInput } = require(resolveEngineModule(COORD_DIR, "scripts/safe-text-input.js"));
const { readUtf8TextFile } = createSafeTextInput();
const { resolvePlanEvidence } = require(resolveEngineModule(COORD_DIR, "scripts/plan-evidence-supersession.js"));

const PACK_ONLY_INSTRUCTIONS =
  "Context mode: pack_only. Work only from the governed context pack and explicitly declared files. " +
  // guard:dispatch-context-integrity
  "Before exploring any unlisted path, ask the orchestrator for the canonical checkout. Submit `gov request-context <ticket> --path <relative-path> --reason <reason>` there with that checkout's gov entrypoint, using your same already-registered owner session and ticket lock; the orchestrator coordinates and serializes execution. Never discover the canonical path by exploring. If that authorized path is unavailable, send the ticket, relative path, and reason to the orchestrator and wait for authorized owner-session execution plus a context supplement. The orchestrator must not substitute its identity, rebind you, or override the ephemeral-worktree guard. A refused ephemeral-worktree attempt is not a recorded request. Even after a successful request, wait for the supplement before accessing the path. " +
  "A request is an observation, not permission; do not access unlisted paths unless the orchestrator provides the requested material. This is an operating instruction, not a process sandbox.";

function dispatchError(message, status = 1) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateExecutionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw dispatchError("dispatch.mjs: --execution-id must be 1-128 safe identifier characters (letters, digits, dot, underscore, colon, hyphen)", 2);
  }
  return value;
}

function ticketExecutionId(dispatchId, ticketId) {
  if (!dispatchId) return null;
  return `dispatch-${crypto.createHash("sha256").update(`${dispatchId}\u0000${ticketId}`).digest("hex")}`;
}

function parseArgs(argv) {
  const opts = { json: false, status: null, repo: null, wave: null, manifest: null, reviewManifest: null, dispatchExecutionId: null };
  const supplied = new Set();
  const valueFor = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
      throw dispatchError(`dispatch.mjs: ${flag} requires a value`, 2);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--status") { opts.status = valueFor(a, i); supplied.add(a); i += 1; }
    else if (a === "--repo") { opts.repo = valueFor(a, i); supplied.add(a); i += 1; }
    else if (a === "--wave") { opts.wave = valueFor(a, i); supplied.add(a); i += 1; }
    else if (a === "--execution-id") { opts.dispatchExecutionId = validateExecutionId(valueFor(a, i)); i += 1; }
    else if (a === "--manifest") {
      opts.manifest = valueFor(a, i);
      i += 1;
    }
    else if (a === "--review-manifest") {
      if (opts.reviewManifest) {
        throw dispatchError("dispatch.mjs: --review-manifest may only be supplied once", 2);
      }
      opts.reviewManifest = valueFor(a, i);
      i += 1;
    }
    else {
      throw dispatchError(`dispatch.mjs: unknown argument "${a}"`, 2);
    }
  }
  if (opts.manifest && opts.reviewManifest) {
    throw dispatchError("dispatch.mjs: --manifest and --review-manifest are mutually exclusive", 2);
  }
  if (opts.reviewManifest && ["--status", "--repo", "--wave"].some((flag) => supplied.has(flag))) {
    throw dispatchError("dispatch.mjs: reviewer handoff does not accept dispatch filters", 2);
  }
  return opts;
}

function buildReviewerBody(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw dispatchError("dispatch.mjs: reviewer manifest must be an object", 2);
  }
  const allowedKeys = new Set(["schema_version", "ticket_id", "diff", "declared_invariants", "plan_record", "plan_record_sha256"]);
  if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) {
    throw dispatchError("dispatch.mjs: reviewer manifest contains an unsupported field", 2);
  }
  if (manifest.schema_version !== 1) {
    throw dispatchError("dispatch.mjs: reviewer manifest schema_version must be 1", 2);
  }
  const ticketId = manifest.ticket_id;
  const diff = manifest.diff;
  const planRecord = manifest.plan_record;
  if (typeof ticketId !== "string" || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticketId)) {
    throw dispatchError("dispatch.mjs: reviewer manifest requires a valid ticket_id", 2);
  }
  if (typeof diff !== "string" || diff.trim().length === 0) {
    throw dispatchError("dispatch.mjs: reviewer manifest requires a non-empty diff string", 2);
  }
  if (!planRecord || typeof planRecord !== "object" || Array.isArray(planRecord)) {
    throw dispatchError("dispatch.mjs: reviewer manifest requires a plan_record object", 2);
  }
  if (planRecord.ticket_id !== ticketId) {
    throw dispatchError("dispatch.mjs: reviewer manifest ticket_id must match plan_record.ticket_id", 2);
  }
  if (typeof manifest.plan_record_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.plan_record_sha256) ||
      crypto.createHash("sha256").update(JSON.stringify(planRecord), "utf8").digest("hex") !== manifest.plan_record_sha256) {
    throw dispatchError("dispatch.mjs: plan_record_sha256 must match the supplied parsed plan_record bytes", 2);
  }
  if (!Array.isArray(planRecord.critical_invariants) ||
      planRecord.critical_invariants.some((item) => typeof item !== "string")) {
    throw dispatchError("dispatch.mjs: plan_record.critical_invariants must be an array of strings", 2);
  }
  if (!Array.isArray(manifest.declared_invariants) ||
      manifest.declared_invariants.some((item) => typeof item !== "string" || !item.trim())) {
    throw dispatchError("dispatch.mjs: declared_invariants must be an array of non-empty strings", 2);
  }
  // COORD-807: declared invariants are checked against the ACTIVE projection.
  // A retracted or superseded invariant is still recorded in the plan record's
  // append-only history, so matching the raw list would hand it to a reviewer
  // as current.
  let evidence;
  try {
    evidence = resolvePlanEvidence(planRecord);
  } catch (error) {
    throw dispatchError(`dispatch.mjs: plan_record correction ledger is invalid: ${error.message}`, 2);
  }
  for (const item of manifest.declared_invariants) {
    if (evidence.critical_invariants.includes(item)) continue;
    const corrected = evidence.critical_invariant_history.find((entry) => entry.value === item);
    throw dispatchError(corrected
      ? `dispatch.mjs: declared invariant ${JSON.stringify(item)} is ${corrected.status} in the supplied plan_record; declare active invariants only`
      : "dispatch.mjs: every declared invariant must appear in the supplied plan_record", 2);
  }

  const invariants = manifest.declared_invariants;
  const delimited = (text, language, marker = "`") => {
    const content = String(text);
    let longest = 0;
    const runs = content.matchAll(new RegExp(`${marker === "`" ? "`" : "~"}+`, "g"));
    for (const [run] of runs) longest = Math.max(longest, run.length);
    const fence = marker.repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
  };
  return [
    `# Reviewer handoff: ${ticketId}`,
    "",
    "## Diff",
    delimited(diff, "diff", "~"),
    "",
    "## Declared invariants",
    delimited(JSON.stringify(invariants, null, 2), "json"),
    "",
    "## Plan record",
    delimited(JSON.stringify(planRecord, null, 2), "json"),
  ].join("\n");
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
  if (opts.dispatchExecutionId) args.push("--execution-id", opts.dispatchExecutionId);
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
function recordCostTemplate(ticket, modelClass, executionId, phase) {
  const execution = executionId || "<dispatch-execution-id>";
  return (
    `coord/scripts/gov record-cost ${ticket} ` +
    `--agent <handle> --model <model-id:${modelClass}> ` +
    `--dispatch-execution-id ${execution} --attempt-id <stable-provider-attempt-id> ` +
    `--measurement-source provider_reported --usage-scope phase_delta ` +
    `--input-tokens <usage.input_tokens> --output-tokens <usage.output_tokens> ` +
    `--phase ${phase}`
  );
}

function reportPrefixUseTemplate(ticket, expectedHash) {
  return (
    `coord/scripts/gov report-prefix-use ${ticket} ` +
    `--expected-prefix-hash ${expectedHash} --used-prefix-hash <agent-reported-sha256>`
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

function buildLoop(manifest, options = {}) {
  // Reshape the manifest into the orchestrator-facing loop instructions.
  const sourcePrefix = manifest.cache_prefix;
  // New manifests carry the digest and byte count. For a saved COORD-032
  // manifest from before COORD-771, derive those additive fields from the
  // original marker shape so existing saved manifests remain consumable.
  let cachePrefix = sourcePrefix;
  if (!Array.isArray(cachePrefix.resolved_references)) {
    const resolved = resolveDispatchCachePrefixReferences(cachePrefix.shared_references || [], ROOT_DIR);
    cachePrefix = buildDispatchCachePrefixMarker(cachePrefix.shared_references || [], resolved);
  } else if (!cachePrefix.sha256 || !Number.isSafeInteger(cachePrefix.byte_length)) {
    cachePrefix = buildDispatchCachePrefixMarker(cachePrefix.shared_references || [], cachePrefix.resolved_references);
  }
  const cachePrefixText = renderDispatchCachePrefix(cachePrefix);
  const rawExecutionId = options.dispatchExecutionId || manifest.dispatch_execution_id || null;
  const dispatchExecutionId = rawExecutionId ? validateExecutionId(rawExecutionId) : null;
  const resolvedPrefixBytes = Buffer.from(cachePrefixText, "utf8");
  const resolvedPrefixHash = crypto.createHash("sha256").update(resolvedPrefixBytes).digest("hex");
  if (resolvedPrefixHash !== cachePrefix.sha256 || resolvedPrefixBytes.length !== cachePrefix.byte_length) {
    throw dispatchError("dispatch.mjs: cache_prefix digest does not match the resolved prefix bytes");
  }
  const waves = manifest.waves.map((w) => ({
    wave: w.wave,
    tickets: w.tickets.map((t) => {
      const contextMode = normalizeContextMode(t.context_mode);
      if (t.action === "skip") {
        return {
          ticket: t.ticket,
          action: "SKIP",
          reason: t.reason,
          context_mode: contextMode,
          finalize_command: t.finalize_command,
        };
      }
      const ticketDispatchExecutionId = ticketExecutionId(dispatchExecutionId, t.ticket);
      return {
        ticket: t.ticket,
        action: "SPAWN",
        reason: t.reason,
        suggested_model_class: t.suggested_model_class,
        tier: t.tier,
        context_mode: contextMode,
        evidence_depth: t.evidence_depth,
        assembled_prompt: {
          // The STABLE cached prefix: identical across every ticket in the wave.
          // Place ONCE in a prompt-cache prefix; do not re-send per ticket.
          cache_prefix_marker: cachePrefix.id,
          cache_prefix_references: cachePrefix.shared_references,
          cache_prefix_sha256: cachePrefix.sha256,
          cache_prefix_byte_length: cachePrefix.byte_length,
          // The ticket-specific body: appended AFTER the cached prefix.
          ticket_body: contextMode === "pack_only"
            ? [t.context_pack ? renderTicketBody(t.context_pack) : (t.context_pack_ref || null), PACK_ONLY_INSTRUCTIONS.replace("<ticket>", t.ticket)]
              .filter(Boolean).join("\n\n")
            : (t.context_pack ? renderTicketBody(t.context_pack) : (t.context_pack_ref || null)),
        },
        dispatch_execution_id: ticketDispatchExecutionId,
        start_command_template: `coord/scripts/gov start ${t.ticket} --dispatch-execution-id ${ticketDispatchExecutionId || "<ticket-dispatch-execution-id>"}`,
        cost_phase_callbacks: ["plan", "implement", "review"].map((phase) => ({
          phase,
          actual_usage_command: recordCostTemplate(t.ticket, t.suggested_model_class, ticketDispatchExecutionId, phase),
          unknown_usage_action: "the matching gov lifecycle boundary records explicit unknown usage automatically when no actual callback arrived",
        })),
        record_cost_template: recordCostTemplate(t.ticket, t.suggested_model_class, ticketDispatchExecutionId, "implement"),
        report_prefix_use_template: reportPrefixUseTemplate(t.ticket, cachePrefix.sha256),
      };
    }),
  }));
  return {
    schema_version: 1,
    dispatch_execution_id: dispatchExecutionId,
    cache_prefix: {
      id: cachePrefix.id,
      references: cachePrefix.shared_references,
      sha256: cachePrefix.sha256,
      byte_length: cachePrefix.byte_length,
      text: cachePrefixText,
    },
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
  out.push(`Prefix SHA-256: ${loop.cache_prefix.sha256} (${loop.cache_prefix.byte_length} bytes)`);
  for (const r of loop.cache_prefix.references) out.push(`  - ${r}`);
  out.push("");
  out.push("Exact shared prefix text (the markers below are not included in its SHA-256):");
  const prefixStart = "----- BEGIN CACHE PREFIX TEXT -----\n";
  const prefixEnd = "\n----- END CACHE PREFIX TEXT -----";
  const body = [];
  for (const w of loop.waves) {
    body.push("");
    body.push(`=== Wave ${w.wave} ===`);
    for (const t of w.tickets) {
      body.push("");
      if (t.action === "SKIP") {
        body.push(`[SKIP] ${t.ticket} — ${t.reason}`);
        body.push(`  finalize (no agent run): ${t.finalize_command}`);
      } else {
        body.push(`[SPAWN] ${t.ticket} — ${t.reason}`);
        body.push(`  context mode: ${t.context_mode}`);
        body.push(`  model class: ${t.suggested_model_class} (tier ${t.tier}); evidence depth: ` +
          `${t.evidence_depth.review_cycles} review / ${t.evidence_depth.feature_proofs} proof(s) / ${t.evidence_depth.critical_invariants} invariant(s)`);
        body.push(`  assembled prompt:`);
        body.push(`    [cached prefix marker] ${t.assembled_prompt.cache_prefix_marker}`);
        body.push(`    [ticket-specific body]`);
        for (const line of String(t.assembled_prompt.ticket_body || "").split("\n")) {
          body.push(`      ${line}`);
        }
        body.push(`  phase-completion cost callbacks (actual usage; lifecycle records unavailable usage as unknown):`);
        body.push(`    dispatch execution: ${t.dispatch_execution_id || "<supply --execution-id>"}`);
        for (const callback of t.cost_phase_callbacks) {
          body.push(`    ${callback.phase} actual: ${callback.actual_usage_command}`);
          body.push(`    ${callback.phase} unavailable: ${callback.unknown_usage_action}`);
        }
        body.push(`  report the agent/harness-used prefix hash (observation only):`);
        body.push(`    ${t.report_prefix_use_template}`);
      }
    }
  }
  if (loop.excluded.length > 0) {
    body.push("");
    body.push("Excluded (no silent drops):");
    for (const e of loop.excluded) body.push(`  ${e.ticket}: ${e.reason}`);
  }
  return `${out.join("\n")}\n${prefixStart}${loop.cache_prefix.text}${prefixEnd}\n${body.join("\n")}\n`;
}

function printHuman(loop) {
  process.stdout.write(formatHuman(loop));
}

function runDispatch(argv = []) {
  try {
    const opts = parseArgs(argv);
    if (opts.reviewManifest) {
      const manifestText = readUtf8TextFile(opts.reviewManifest, "review manifest");
      if (Buffer.byteLength(manifestText, "utf8") > MAX_TEXT_INPUT_BYTES) {
        throw dispatchError(`dispatch.mjs: reviewer manifest exceeds the ${MAX_TEXT_INPUT_BYTES}-byte limit`, 2);
      }
      const manifest = JSON.parse(manifestText);
      const reviewerBody = buildReviewerBody(manifest);
      const output = opts.json
        ? `${JSON.stringify({ schema_version: 1, ticket_id: manifest.ticket_id, plan_record_sha256: manifest.plan_record_sha256, reviewer_body: reviewerBody })}\n`
        : `${reviewerBody}\n`;
      return { status: 0, stdout: output, stderr: "" };
    }
    const manifest = loadManifest(opts);
    const loop = buildLoop(manifest, opts);
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
  buildReviewerBody,
  formatHuman,
  loadManifest,
  main,
  parseArgs,
  printHuman,
  runDispatch,
};

// COORD-888: the default export lets the registered ESM shim at the legacy
// coord/scripts path re-export both the named and the default bindings; the
// shim re-dispatches main when it is the process entrypoint.
export default { buildLoop, buildReviewerBody, formatHuman, loadManifest, main, parseArgs, printHuman, runDispatch };
