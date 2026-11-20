"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const { resolvePlanEvidence } = require(resolveEngineModule(__dirname + "/../..", "scripts/plan-evidence-supersession.js"));

const createTrackRegistry = require("./track-registry.js");
const { collectGatePlanReadinessIssues, gatePlanIsMissingOrStale } = require("./evidence-record.js");
const {
  DEFAULT_STALE_AFTER_DAYS,
  loadAffectedTargetMap,
  normalizePath,
  selectAffectedTargets,
  validateAffectedTargetMap,
} = require("./affected-targets.js");
const {
  HIGH_RISK_BOOTSTRAP_CLASSES,
  evaluateTrackEvidence,
  normalizeRiskClass,
  requiredEvidenceFor,
  riskGte,
} = require("./track-evidence-policy.js");

function defaultMapPath(coordDir = path.resolve(__dirname, "..", "..")) {
  return resolveEngineModule(coordDir, "gates/affected-targets.json");
}

const DEFAULT_MAP_PATH = defaultMapPath();

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.map(normalizePath).filter(Boolean))).sort();
}

function meaningful(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text);
}

// COORD-690 (review round 1): declared_files carries forward from the PREVIOUS
// receipt, so whatever lands here is permanent — a malformed entry survives
// every regeneration even after the plan record itself is corrected, which is
// evidence metadata that cannot be fixed by any sanctioned path. The writer
// side now splits comma-separated `--files` input, and collection re-splits
// defensively so an already-recorded blob resolves into the real paths it names
// instead of persisting as one uninterpretable entry. Splitting is chosen over
// dropping the carryover: no legitimately declared file is lost.
function collectPlanFiles(planState = {}) {
  return unique([
    ...toArray(planState.intended_files),
    ...toArray(planState.gate_plan?.declared_files),
  ].flatMap((entry) => String(entry || "").split(",")).map((entry) => entry.trim()).filter(Boolean));
}

function classifyRisk({ row = {}, planState = {}, track = {}, files = [] } = {}) {
  const activeEvidence = resolvePlanEvidence(planState);
  const text = [
    row.ID,
    row.Type,
    row.Pri,
    row.Description,
    track.name,
    ...(planState.change_summary || []),
    ...activeEvidence.critical_invariants,
    ...(planState.requirement_closure || []),
    ...(planState.security_surface ? [planState.security_surface] : []),
    ...files,
  ].join("\n");
  const bootstrapClass = String(planState.bootstrap_risk?.startup_work_class || "");
  const liveMcp = planState.live_mcp || null;
  if (
    HIGH_RISK_BOOTSTRAP_CLASSES.has(bootstrapClass) ||
    /\b(production|prod|deploy(?:ment)?|destructive|write_prod|rollback|kms|iam|network policy)\b/i.test(text) ||
    ["write_prod", "destructive"].includes(String(liveMcp?.operation_class || ""))
  ) {
    return "R4";
  }
  if (/auth|rbac|permission|journal|hash|signing|chain|board\/tasks\.json|plan\.schema|tenant|ledger|payment|invoice|schema|migration|contract/i.test(text)) {
    return "R3";
  }
  if (track.name === "data-analytics" || track.name === "product-engineering" || /shared|orchestration|state|runtime|api|integration/i.test(text)) {
    return "R2";
  }
  if (/^(docs|chore)$/i.test(String(row.Type || "")) && files.length > 0 && files.every((file) => /\.(md|txt)$/i.test(file))) {
    return "R0";
  }
  return "R1";
}

function loadMapForPlan(options = {}) {
  const mapPath = path.resolve(options.cwd || process.cwd(), options.mapPath);
  const loaded = loadAffectedTargetMap(mapPath);
  if (loaded.error) {
    return {
      map: null,
      status: {
        path: mapPath,
        ok: false,
        fallback: true,
        reason: loaded.error,
        issues: [{ code: "map_load", severity: "error", message: loaded.error }],
      },
    };
  }
  const validation = validateAffectedTargetMap(loaded.map, {
    requireUpdatedAt: true,
    now: options.now || new Date().toISOString(),
    staleAfterDays: options.staleAfterDays || DEFAULT_STALE_AFTER_DAYS,
  });
  const stale = validation.issues.some((issue) => issue.code === "map_stale");
  const fallback = !validation.ok || stale;
  return {
    map: fallback ? null : loaded.map,
    originalMap: loaded.map,
    status: {
      path: mapPath,
      ok: validation.ok && !stale,
      fallback,
      reason: fallback
        ? validation.issues.map((issue) => issue.message).join("; ")
        : "affected-target map valid",
      issues: validation.issues,
    },
  };
}

function buildSelectedGates({ track, affected }) {
  const gates = [{
    id: `track:${track.gateProc}`,
    kind: "track-gate",
    command: `coord gate-proc ${track.gateProc}`,
    reason: `${track.name} track default gate-proc`,
  }];
  for (const target of affected.selected || []) {
    gates.push({
      id: `affected:${target.id}`,
      kind: "affected-target",
      command: target.command,
      reason: target.reason,
    });
  }
  return gates;
}

function buildSkippedGates({ affected }) {
  return (affected.skipped || []).map((target) => ({
    id: `affected:${target.id}`,
    command: target.command,
    reason: target.reason,
  }));
}

// COORD-947: engine changes are selected by the COORD-924 selector directly, the same
// code path `gov test-policy resolve --stage pr` uses. No engine map is read, so none
// can go stale. A fallback (unknown or unattributable file, incomplete analysis, T2)
// runs the full gate. A product repository keeps its hand-written map via --map.
const ENGINE_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function selectEngineAffected({ root = ENGINE_REPO_ROOT, base = "HEAD", changes = [], full = false } = {}) {
  const { DEFAULT_FULL_COMMAND } = require("./affected-targets.js");
  const fullSelection = (reason, extra = {}) => ({
    mode: "full",
    reason,
    selected: [{ id: "full-1", command: DEFAULT_FULL_COMMAND, reason }],
    skipped: [],
    unknown_files: [],
    ...extra,
  });
  if (full) {
    return { status: { path: null, ok: true, fallback: true, reason: "explicit full override", issues: [] }, affected: fullSelection("explicit full override") };
  }
  const selector = require("./affected-selector.js");
  const result = selector.selectAffected({ root, base, changes });
  const map = { path: null, ok: true, fallback: result.decision === "full", reason: "COORD-924 selector (engine)", issues: [] };
  if (result.decision === "full") {
    const reasons = result.fallback_reasons.map((f) => `${f.code}: ${f.path}`);
    return {
      status: map,
      affected: fullSelection(reasons.join("; "), {
        unknown_files: result.fallback_reasons.filter((f) => f.code === "unknown_dependents").map((f) => f.path),
        tier: result.tier,
        fallback_reasons: result.fallback_reasons,
      }),
    };
  }
  return {
    status: map,
    affected: {
      mode: "slice",
      reason: "COORD-924 selector selected suites",
      selected: result.selected.map((entry) => ({
        id: entry.suite,
        command: `node --test ${entry.suite}`,
        reason: entry.reasons.join("; "),
      })),
      skipped: [],
      omitted_count: result.omitted.length,
      unknown_files: [],
      tier: result.tier,
      always_required_checks: result.always_required_checks,
    },
  };
}

function buildGatePlanReceipt(input = {}) {
  const row = input.row || {};
  const ticketId = input.ticketId || row.ID;
  if (!ticketId) {
    throw new Error("gate plan requires a ticket id");
  }
  const planState = input.planState || {};
  const registry = input.registry || createTrackRegistry(input.registryDeps || {});
  const track = input.track || registry.resolveTrack(ticketId, input.trackOverride ? { override: input.trackOverride } : {});
  const declaredFiles = unique([
    ...collectPlanFiles(planState),
    ...toArray(input.declaredFiles),
  ]);
  const changedFiles = unique([
    ...toArray(input.changedFiles),
    ...toArray(input.files),
    ...(declaredFiles.length > 0 ? declaredFiles : []),
  ]);
  const riskClass = normalizeRiskClass(input.riskClass || classifyRisk({ row, planState, track, files: changedFiles }));
  let mapStatus;
  let affected;
  if (input.mapPath) {
    // A hand-written map (product repository or an explicit --map): the map selector.
    const map = loadMapForPlan(input);
    const forceFull = input.full === true || map.status.fallback;
    affected = selectAffectedTargets({ files: changedFiles, map: map.map, full: forceFull });
    if (map.status.fallback && !input.full) affected.reason = map.status.reason;
    mapStatus = map.status;
  } else {
    const engine = selectEngineAffected({
      root: input.root || ENGINE_REPO_ROOT,
      base: input.base || "HEAD",
      changes: input.changes || changedFiles.map((file) => ({ status: "M", path: file })),
      full: input.full === true,
    });
    affected = engine.affected;
    mapStatus = engine.status;
  }
  const selectedGates = buildSelectedGates({ track, affected });
  const skippedGates = buildSkippedGates({ affected });
  const requiredEvidence = requiredEvidenceFor({ track, riskClass, planState });
  const evidenceReport = evaluateTrackEvidence({
    ticketId,
    track,
    riskClass,
    planState,
    receipt: { selected_gates: selectedGates, required_evidence: requiredEvidence },
  });
  const enforcement = riskGte(riskClass, "R3") ? "blocking" : "warning-first";
  return {
    schema_version: 1,
    planner_version: "gate-plan-v1",
    ticket_id: ticketId,
    generated_at: input.now || new Date().toISOString(),
    track: {
      name: track.name,
      gate_proc: track.gateProc,
      default_lane: track.defaultLane,
      operator: track.operator,
    },
    risk_class: riskClass,
    enforcement,
    declared_files: declaredFiles,
    changed_files: changedFiles,
    affected_targets: {
      mode: affected.mode,
      reason: affected.reason,
      map: mapStatus,
      selected: affected.selected,
      skipped: affected.skipped,
      unknown_files: affected.unknown_files,
    },
    selected_gates: selectedGates,
    skipped_gates: skippedGates,
    required_evidence: requiredEvidence,
    evidence_issues: evidenceReport.issues,
    fallback_reason: affected.mode === "full" ? affected.reason : null,
    ...(input.landingGate ? { landing_gate: input.landingGate } : {}),
  };
}

// COORD-924: with --base, the receipt names the landing gate the affected
// selection policy requires: "affected" (selected suites plus the always-required
// suites, accepted through add-repo-gate --selection-manifest) or "full".
function landingGateSummary({ base, head = "HEAD", root = path.resolve(__dirname, "..", "..", ".."), boardPath, landing = require("./affected-landing.js") }) {
  const { gate, wouldGate = gate } = landing.landingGateFor({ root, base, head, boardPath });
  // In shadow gate is "full" and would_* records what an active selection would run.
  return { gate: gate.gate, tier: gate.tier, reason: gate.reason, suites: gate.suites || [], would_gate: wouldGate.gate, would_suites: wouldGate.suites || [] };
}

function renderMarkdown(receipt) {
  const lines = [
    `# Gate plan: ${receipt.ticket_id}`,
    "",
    `- Track: ${receipt.track.name}`,
    `- Gate proc: ${receipt.track.gate_proc}`,
    `- Default lane: ${receipt.track.default_lane}`,
    `- Risk class: ${receipt.risk_class}`,
    `- Enforcement: ${receipt.enforcement}`,
    `- Affected-target mode: ${receipt.affected_targets.mode}`,
    `- Reason: ${receipt.affected_targets.reason}`,
    "",
    "## Selected Gates",
  ];
  for (const gate of receipt.selected_gates) {
    lines.push(`- ${gate.id}: \`${gate.command}\` (${gate.reason})`);
  }
  if (receipt.skipped_gates.length > 0) {
    lines.push("", "## Skipped Gates");
    for (const gate of receipt.skipped_gates) {
      lines.push(`- ${gate.id}: ${gate.reason}`);
    }
  }
  if (receipt.required_evidence.length > 0) {
    lines.push("", "## Required Evidence");
    for (const item of receipt.required_evidence) {
      lines.push(`- ${item}`);
    }
  }
  if (receipt.evidence_issues.length > 0) {
    lines.push("", "## Evidence Issues");
    for (const issue of receipt.evidence_issues) {
      lines.push(`- ${issue.severity}: ${issue.code} - ${issue.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}


function parseArgs(argv = []) {
  const options = { files: [], json: false, md: false, write: false, full: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--md") options.md = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--map") options.mapPath = argv[++index];
    else if (arg === "--risk") options.riskClass = argv[++index];
    else if (arg === "--track") options.trackOverride = argv[++index];
    else if (arg === "--files") options.files.push(...toArray(argv[++index]));
    else if (arg === "--base") options.base = argv[++index];
    else if (!options.ticketId && !String(arg).startsWith("--")) options.ticketId = arg;
    else return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => process.stdout.write(String(line)));
  if (parsed.error) {
    log(`gate-plan: ${parsed.error}\n`);
    return { code: 1 };
  }
  const options = parsed.options;
  const receipt = buildGatePlanReceipt({
    ...options,
    ticketId: options.ticketId,
    row: deps.row,
    planState: deps.planState,
    cwd: deps.cwd,
    now: deps.now,
    registry: deps.registry,
    landingGate: options.base ? (deps.landingGateSummary || landingGateSummary)({ base: options.base }) : null,
  });
  log(options.md ? renderMarkdown(receipt) : `${JSON.stringify(receipt, null, 2)}\n`);
  return { code: 0, receipt };
}

module.exports = {
  DEFAULT_MAP_PATH,
  buildGatePlanReceipt,
  classifyRisk,
  collectGatePlanReadinessIssues,
  defaultMapPath,
  gatePlanIsMissingOrStale,
  landingGateSummary,
  parseArgs,
  renderMarkdown,
  run,
};

// COORD-876: a leading --help prints the usage on stdout and exits 0.
const USAGE = "usage: gate-plan.js <ticket-id> [--files <path[,path...]>]... [--map <path>] [--risk <R0|R1|R2|R3|R4>] " +
  "[--track <track>] [--full] [--base <ref>] [--json | --md]\n";
function main() {
  if (process.argv[2] === "--help") { process.stdout.write(USAGE); process.exitCode = 0; return; }
  const result = run(process.argv.slice(2));
  process.exitCode = result.code;
}
if (require.main === module) main();
module.exports.main = main;
