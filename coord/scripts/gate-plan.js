"use strict";

const fs = require("node:fs");
const path = require("node:path");

const createTrackRegistry = require("./track-registry.js");
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

const DEFAULT_MAP_PATH = path.join(__dirname, "..", "gates", "affected-targets.json");

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

function collectPlanFiles(planState = {}) {
  return unique([
    ...toArray(planState.intended_files),
    ...toArray(planState.gate_plan?.declared_files),
  ]);
}

function classifyRisk({ row = {}, planState = {}, track = {}, files = [] } = {}) {
  const text = [
    row.ID,
    row.Type,
    row.Pri,
    row.Description,
    track.name,
    ...(planState.change_summary || []),
    ...(planState.critical_invariants || []),
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
  const mapPath = options.mapPath
    ? path.resolve(options.cwd || process.cwd(), options.mapPath)
    : DEFAULT_MAP_PATH;
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
  const map = loadMapForPlan(input);
  const forceFull = input.full === true || map.status.fallback;
  const affected = selectAffectedTargets({
    files: changedFiles,
    map: map.map,
    full: forceFull,
  });
  if (map.status.fallback && !input.full) {
    affected.reason = map.status.reason || affected.reason;
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
      map: map.status,
      selected: affected.selected,
      skipped: affected.skipped,
      unknown_files: affected.unknown_files,
    },
    selected_gates: selectedGates,
    skipped_gates: skippedGates,
    required_evidence: requiredEvidence,
    evidence_issues: evidenceReport.issues,
    fallback_reason: affected.mode === "full" ? affected.reason : null,
  };
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

function gatePlanIsMissingOrStale(planState = {}, options = {}) {
  const receipt = planState.gate_plan;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { missing: true, stale: false, reason: "missing gate-plan receipt" };
  }
  if (receipt.planner_version !== "gate-plan-v1") {
    return { missing: false, stale: true, reason: "unsupported gate-plan planner_version" };
  }
  const maxAgeDays = Number(options.maxAgeDays || 14);
  const generated = Date.parse(receipt.generated_at);
  const now = Date.parse(options.now || new Date().toISOString());
  if (!Number.isNaN(generated) && !Number.isNaN(now) && now - generated > maxAgeDays * 24 * 60 * 60 * 1000) {
    return { missing: false, stale: true, reason: `gate-plan receipt is older than ${maxAgeDays} days` };
  }
  return { missing: false, stale: false, reason: null };
}

function collectGatePlanReadinessIssues(ticketId, row, planState = {}, options = {}) {
  const status = gatePlanIsMissingOrStale(planState, options);
  const lightLane = options.lightLane === true;
  const issues = [];
  if ((status.missing || status.stale) && !lightLane) {
    const riskText = [
      row?.Description,
      row?.Type,
      row?.Pri,
      planState?.bootstrap_risk?.startup_work_class,
      planState?.live_mcp?.operation_class,
    ].join("\n");
    const hardMissing = /prod|deploy|server_bootstrap_job|derived_data_job|production_repair|write_prod|destructive|auth|rbac|journal|signing/i.test(riskText);
    issues.push({
      code: status.missing ? "gate_plan_receipt" : "gate_plan_stale",
      message: `Plan state for ${ticketId} ${status.reason}; record deterministic selected/skipped gate evidence before review.`,
      next_steps: [`coord/scripts/gov gate-plan ${ticketId} --write`],
      severity: hardMissing ? "blocker" : "advisory",
    });
  }

  const receipt = planState.gate_plan;
  if (receipt && typeof receipt === "object") {
    const mode = String(receipt.affected_targets?.mode || "");
    if (mode === "slice" && !Array.isArray(receipt.affected_targets?.selected)) {
      issues.push({
        code: "gate_plan_slice_receipt",
        message: `Plan state for ${ticketId} claims affected-target slice mode without selected target receipt details.`,
        next_steps: [`coord/scripts/gov gate-plan ${ticketId} --write`],
        severity: "blocker",
      });
    }
    const receiptBlocks =
      receipt.enforcement === "blocking" ||
      riskGte(receipt.risk_class, "R3");
    const blockingEvidence = receiptBlocks
      ? (receipt.evidence_issues || []).filter((issue) => issue.severity === "blocker")
      : [];
    for (const issue of blockingEvidence) {
      issues.push({
        code: issue.code,
        message: issue.message,
        next_steps: issue.next_steps || [`coord/scripts/gov gate-plan ${ticketId} --write`],
        severity: "blocker",
      });
    }
  }
  return issues.filter((issue) => issue.severity !== "advisory" || options.includeAdvisory === true);
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
  });
  log(options.md ? renderMarkdown(receipt) : `${JSON.stringify(receipt, null, 2)}\n`);
  return { code: 0, receipt };
}

module.exports = {
  DEFAULT_MAP_PATH,
  buildGatePlanReceipt,
  classifyRisk,
  collectGatePlanReadinessIssues,
  gatePlanIsMissingOrStale,
  parseArgs,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
