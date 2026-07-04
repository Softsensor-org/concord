#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const requirementsConformance = require("./requirements-conformance.js");
const traceability = require("./requirements-traceability.js");

const DEFAULT_REQUIRED_CONTRACT_AREAS = ["security", "privacy", "reliability"];
const CROSS_CUTTING_AREAS = new Set(["safety", "privacy", "api", "consent", "security", "reliability"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeArea(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function registryRequirementIds(registry) {
  return new Set((registry.requirements || []).map((req) => String(req.id || "").toUpperCase()).filter(Boolean));
}

function normalizeSurfaces(matrix = {}) {
  return (matrix.surfaces || matrix.persona_surfaces || []).map((surface) => ({
    id: normalizeId(surface.id || surface.surface || surface.name),
    persona: normalizeId(surface.persona || surface.role),
    app: normalizeId(surface.app || surface.client_app || surface.product_surface),
    source_refs: splitList(surface.source_refs || surface.sources || surface.source_ref),
    requirement_ids: uniqueSorted(splitList(surface.requirement_ids || surface.requirements).map((id) => id.toUpperCase())),
    shared_requirement_ids: uniqueSorted(splitList(surface.shared_requirement_ids || surface.shared_requirements).map((id) => id.toUpperCase())),
    workflows: splitList(surface.workflows),
    status_projection: surface.status || surface.delivery_status || surface.implementation_status || null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSharedRequirements(matrix = {}) {
  return (matrix.shared_requirements || matrix.cross_cutting_requirements || []).map((row) => ({
    id: String(row.id || row.requirement_id || "").toUpperCase(),
    contract_area: normalizeArea(row.contract_area || row.area || row.kind),
    applies_to: uniqueSorted(splitList(row.applies_to || row.surfaces || row.surface_ids)),
    source_ref: normalizeId(row.source_ref || row.source || ""),
  })).filter((row) => row.id).sort((a, b) => a.id.localeCompare(b.id));
}

function buildSharedCoverage(sharedRequirements, surfaces) {
  const coverage = new Map(surfaces.map((surface) => [surface.id, []]));
  for (const shared of sharedRequirements) {
    const targets = shared.applies_to.length > 0 ? shared.applies_to : surfaces.map((surface) => surface.id);
    for (const surfaceId of targets) {
      if (!coverage.has(surfaceId)) coverage.set(surfaceId, []);
      coverage.get(surfaceId).push(shared);
    }
  }
  return coverage;
}

function requirementStateMap(conformanceReport) {
  return new Map((conformanceReport.requirements || []).map((row) => [row.requirement_id, row]));
}

function analyzeSurfaceConformance(matrix, registry = {}, board = {}, planRecords = [], options = {}) {
  const surfaces = normalizeSurfaces(matrix);
  const sharedRequirements = normalizeSharedRequirements(matrix);
  const registryIds = registryRequirementIds(registry);
  const requiredAreas = uniqueSorted(splitList(options.requiredContractAreas || DEFAULT_REQUIRED_CONTRACT_AREAS).map(normalizeArea));
  const conformance = requirementsConformance.buildConformanceReport(board, registry, planRecords, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    boardPath: options.boardPath,
    registryPath: options.registryPath,
    plansDir: options.plansDir,
  });
  const states = requirementStateMap(conformance);
  const sharedCoverage = buildSharedCoverage(sharedRequirements, surfaces);
  const findings = [];

  for (const shared of sharedRequirements) {
    if (!CROSS_CUTTING_AREAS.has(shared.contract_area)) {
      findings.push({
        severity: "warning",
        code: "unknown-cross-cutting-contract-area",
        requirement_id: shared.id,
        contract_area: shared.contract_area,
        message: "Shared requirement contract area is outside the cross-cutting vocabulary.",
      });
    }
    if (registryIds.size > 0 && !registryIds.has(shared.id)) {
      findings.push({
        severity: "fail",
        code: "unknown-shared-requirement",
        requirement_id: shared.id,
        message: "Shared requirement is not present in the requirements registry.",
      });
    }
  }

  const surfaceRows = surfaces.map((surface) => {
    if (!surface.id) {
      findings.push({ severity: "fail", code: "missing-surface-id", surface_id: "", message: "Surface row is missing id/surface/name." });
    }
    if (surface.source_refs.length === 0) {
      findings.push({ severity: "warning", code: "missing-surface-source", surface_id: surface.id, message: "Surface has no PRD/URS/SRS source reference." });
    }
    if (surface.status_projection) {
      findings.push({
        severity: "fail",
        code: "surface-delivery-status-projection",
        surface_id: surface.id,
        message: "Surface matrix includes delivery/status projection; conformance must be generated from board/evidence state.",
      });
    }
    for (const reqId of surface.requirement_ids.concat(surface.shared_requirement_ids)) {
      if (registryIds.size > 0 && !registryIds.has(reqId)) {
        findings.push({ severity: "fail", code: "unknown-surface-requirement", surface_id: surface.id, requirement_id: reqId, message: "Surface references a requirement not present in the registry." });
      }
    }
    for (const reqId of surface.shared_requirement_ids) {
      if (surface.requirement_ids.includes(reqId)) {
        findings.push({ severity: "warning", code: "shared-requirement-duplicated-as-direct", surface_id: surface.id, requirement_id: reqId, message: "Shared requirement is also listed as a direct surface requirement; reference it once through shared_requirement_ids." });
      }
    }
    const sharedForSurface = sharedCoverage.get(surface.id) || [];
    const coveredAreas = uniqueSorted(sharedForSurface.map((shared) => shared.contract_area));
    for (const area of requiredAreas) {
      if (!coveredAreas.includes(area)) {
        findings.push({ severity: "warning", code: "missing-cross-cutting-contract-area", surface_id: surface.id, contract_area: area, message: `Surface has no shared ${area} requirement.` });
      }
    }
    const requirementIds = uniqueSorted(surface.requirement_ids.concat(surface.shared_requirement_ids).concat(sharedForSurface.map((shared) => shared.id)));
    const gaps = requirementIds
      .map((id) => states.get(id) || { requirement_id: id, conformance_state: "nonconforming", missing_evidence: [] })
      .filter((row) => row.conformance_state !== "conforming");
    return {
      surface_id: surface.id,
      persona: surface.persona,
      app: surface.app,
      source_refs: surface.source_refs,
      workflows: surface.workflows,
      direct_requirement_ids: surface.requirement_ids,
      shared_requirement_ids: uniqueSorted(surface.shared_requirement_ids.concat(sharedForSurface.map((shared) => shared.id))),
      covered_contract_areas: coveredAreas,
      gaps: gaps.map((gap) => ({
        requirement_id: gap.requirement_id,
        conformance_state: gap.conformance_state,
        missing_evidence: gap.missing_evidence || [],
      })),
    };
  });

  const sortedFindings = findings.sort((a, b) => `${a.severity}:${a.code}:${a.surface_id || ""}:${a.requirement_id || ""}`.localeCompare(`${b.severity}:${b.code}:${b.surface_id || ""}:${b.requirement_id || ""}`));
  const failures = sortedFindings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.surface_conformance",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      matrix: options.matrixPath || "coord/.runtime/requirements/surface-requirements.json",
      registry: options.registryPath || null,
      board: options.boardPath || "coord/board/tasks.json",
      plans: options.plansDir || "coord/.runtime/plans",
    },
    policy: {
      source_grouping: "persona/role/surface/app/workflow requirement sources may be split; delivery status remains generated.",
      cross_cutting_areas: Array.from(CROSS_CUTTING_AREAS).sort(),
      required_contract_areas: requiredAreas,
    },
    surfaces: surfaceRows,
    shared_requirements: sharedRequirements,
    findings: sortedFindings,
    summary: {
      surfaces: surfaceRows.length,
      shared_requirements: sharedRequirements.length,
      surface_gaps: surfaceRows.reduce((total, surface) => total + surface.gaps.length, 0),
      findings: sortedFindings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Surface Conformance");
  lines.push("");
  lines.push(`Surfaces: ${report.summary.surfaces}`);
  lines.push(`Shared requirements: ${report.summary.shared_requirements}`);
  lines.push(`Surface gaps: ${report.summary.surface_gaps}`);
  lines.push("");
  for (const surface of report.surfaces) {
    lines.push(`- ${surface.surface_id}: persona=${surface.persona || "unknown"} app=${surface.app || "unknown"} gaps=${surface.gaps.length} shared=${surface.shared_requirement_ids.join(", ") || "none"}`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.surface_id || finding.requirement_id || ""}: ${finding.code} - ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    matrix: "coord/.runtime/requirements/surface-requirements.json",
    registry: null,
    board: "coord/board/tasks.json",
    plans: "coord/.runtime/plans",
    output: null,
    json: false,
    profile: "product-engineering",
    lane: "full",
    requiredContractAreas: DEFAULT_REQUIRED_CONTRACT_AREAS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--matrix", "--registry", "--board", "--plans", "--output", "--profile", "--lane"].includes(arg)) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    if (arg === "--required-contract-areas") {
      const value = argv[++i];
      if (!value) return { error: "--required-contract-areas requires a value" };
      options.requiredContractAreas = splitList(value);
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-surface-conformance: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-surface-conformance [--dir <root>] --registry <path> [--matrix <path>] [--board <path>] [--plans <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const matrixPath = path.resolve(root, parsed.options.matrix);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fs.existsSync(matrixPath)) {
    log(`requirements-surface-conformance: matrix not found: ${parsed.options.matrix}`);
    return { code: 1 };
  }
  if (!parsed.options.registry) {
    log("requirements-surface-conformance: --registry is required");
    return { code: 1 };
  }
  const registryPath = path.resolve(root, parsed.options.registry);
  if (!fs.existsSync(registryPath)) {
    log(`requirements-surface-conformance: registry not found: ${parsed.options.registry}`);
    return { code: 1 };
  }
  if (!fs.existsSync(boardPath)) {
    log(`requirements-surface-conformance: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  const matrix = readJson(matrixPath);
  const registry = readJson(registryPath);
  const board = readJson(boardPath);
  const plans = traceability.listPlanRecords(path.resolve(root, parsed.options.plans));
  const report = analyzeSurfaceConformance(matrix, registry, board, plans, {
    matrixPath: parsed.options.matrix,
    registryPath: parsed.options.registry,
    boardPath: parsed.options.board,
    plansDir: parsed.options.plans,
    profile: parsed.options.profile,
    lane: parsed.options.lane,
    requiredContractAreas: parsed.options.requiredContractAreas,
  });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  analyzeSurfaceConformance,
  normalizeSharedRequirements,
  normalizeSurfaces,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
