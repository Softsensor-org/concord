#!/usr/bin/env node
"use strict";

const { sha256Prefixed } = require("./lifecycle-utils.js");
const fs = require("node:fs");
const path = require("node:path");

const REQUIREMENT_HEADING_RE = /^(#{1,6})\s+((?:REQ|URS|PRD|SRS|FR|NFR|SEC|DONOR-REQ)-[A-Za-z0-9_.-]+)\s*(?::|-|--)?\s*(.*)$/i;
const METADATA_RE = /^\s*[-*]\s*([A-Za-z][A-Za-z0-9 _/-]{1,40})\s*:\s*(.+?)\s*$/;
const METADATA_CANDIDATE_RE = /^\s*([-*]\s*)?([A-Za-z][A-Za-z0-9 _/-]{1,40})\s*:\s*(.*?)\s*$/;
const METADATA_ALIASES = {
  kind: ["kind", "type"], priority: ["priority", "pri"], risk: ["risk", "risk_class"],
  criticality: ["criticality"], lifecycle: ["lifecycle", "status"],
  personas: ["persona", "personas"], workflows: ["workflow", "workflows"],
  screens: ["screen", "screens"], routes: ["route", "routes"], apis: ["api", "apis"],
  data_entities: ["data", "data_entities", "entities"], events: ["event", "events"],
  security_controls: ["security", "security_controls"],
  evidence_classes: ["evidence", "evidence_classes", "evidence_class"],
  coverage: ["coverage", "coverage_status"], confidence: ["confidence"],
  ticket_ids: ["ticket", "tickets", "ticket_ids"], waiver_ref: ["waiver", "waiver_ref"],
  defect_ref: ["defect", "defect_ref"],
  derived_from_requirement_ids: ["derived_from", "derived_from_requirement_ids"],
  reviewed_by: ["reviewed_by", "reviewers"], change_reason: ["change_reason"],
};
const CANONICAL_METADATA_KEY = new Map(Object.entries(METADATA_ALIASES)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])));
const METADATA_KEYS = new Set(CANONICAL_METADATA_KEY.keys());
const LIST_METADATA_FIELDS = new Set([
  "personas", "workflows", "screens", "routes", "apis", "data_entities", "events",
  "security_controls", "evidence_classes", "ticket_ids", "derived_from_requirement_ids", "reviewed_by",
]);

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitList(value) {
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRisk(value) {
  const risk = String(value || "").trim().toLowerCase();
  if (!risk) return "medium";
  if (["low", "medium", "high", "critical", "regulated"].includes(risk)) return risk;
  throw new Error(`unsupported Risk value "${value}"; expected low, medium, high, critical, or regulated`);
}

function normalizePriority(value) {
  const pri = String(value || "").trim().toUpperCase();
  if (!pri) return "P2";
  if (/^P[0-3]$/.test(pri)) return pri;
  throw new Error(`unsupported Priority value "${value}"; expected P0, P1, P2, or P3`);
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!kind) return "functional";
  const allowed = new Set([
    "functional",
    "nonfunctional",
    "security",
    "data",
    "integration",
    "workflow",
    "ux",
    "operational",
    "validation",
    "controlled_document",
  ]);
  if (allowed.has(kind)) return kind;
  throw new Error(`unsupported Kind value "${value}"; expected a kind from the requirements registry schema`);
}

function normalizeEnum(value, label, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (allowed.includes(normalized)) return normalized;
  throw new Error(`unsupported ${label} value "${value}"; expected ${allowed.join(", ")}`);
}

function normalizedMetadataKey(key) {
  return String(key).trim().toLowerCase().replace(/[\s/-]+/g, "_");
}

function metadataValue(metadata, names) {
  for (const name of names) {
    const key = normalizedMetadataKey(name);
    if (Object.prototype.hasOwnProperty.call(metadata, key)) return metadata[key];
  }
  return "";
}

function parseMetadata(lines, { sourcePath, lineStart }) {
  const metadata = {};
  const seenFields = new Set();
  let inPreamble = true;
  let inCriteria = false;
  for (const [offset, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (/^\s*(acceptance criteria|acceptance|criteria)\s*:?\s*$/i.test(line)) {
      inCriteria = true;
      continue;
    }
    if (inCriteria) continue;
    const candidate = line.match(METADATA_CANDIDATE_RE);
    const location = `${sourcePath}:${lineStart + offset + 1}`;
    if (!inPreamble) {
      if (candidate && METADATA_KEYS.has(normalizedMetadataKey(candidate[2]))) {
        throw new Error(`${location}: metadata "${candidate[2]}" must appear before the requirement statement`);
      }
      if (/^\s*[-*]\s+/.test(line)) {
        throw new Error(`${location}: bullet outside the metadata preamble or Acceptance Criteria is not imported`);
      }
      continue;
    }
    if (!candidate) {
      const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (bullet) {
        if (bullet[1].includes(":")) {
          throw new Error(`${location}: malformed or unsupported metadata bullet "${bullet[1]}"`);
        }
        throw new Error(`${location}: malformed or unparsed bullet "${bullet[1]}"; use - Key: value for metadata or put criteria after Acceptance Criteria:`);
      }
      inPreamble = false;
      continue;
    }
    const key = normalizedMetadataKey(candidate[2]);
    if (!METADATA_KEYS.has(key)) {
      if (!candidate[1]) {
        inPreamble = false; // A prose label begins the statement, not metadata.
        continue;
      }
      throw new Error(`${location}: unsupported metadata key "${candidate[2]}"`);
    }
    if (!candidate[1]) {
      throw new Error(`${location}: metadata "${candidate[2]}" must be a bullet (- Key: value)`);
    }
    if (!candidate[3].trim()) {
      throw new Error(`${location}: metadata "${candidate[2]}" requires a value`);
    }
    const field = CANONICAL_METADATA_KEY.get(key);
    if (seenFields.has(field)) {
      throw new Error(`${location}: duplicate metadata field "${field}" (including aliases)`);
    }
    if (LIST_METADATA_FIELDS.has(field) && candidate[3].split(/[,;|]/).some((part) => !part.trim())) {
      throw new Error(`${location}: metadata "${candidate[2]}" contains an empty list item`);
    }
    seenFields.add(field);
    metadata[key] = candidate[3].trim();
  }
  return metadata;
}

function extractAcceptanceCriteria(lines) {
  const criteria = [];
  let inCriteria = false;
  for (const line of lines) {
    if (/^\s*(acceptance criteria|acceptance|criteria)\s*:?\s*$/i.test(line)) {
      inCriteria = true;
      continue;
    }
    if (inCriteria) {
      const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (bullet) {
        criteria.push(bullet[1].trim());
        continue;
      }
      if (line.trim() && /^#{1,6}\s+/.test(line)) break;
      if (line.trim() && !/^\s{2,}/.test(line)) inCriteria = false;
    }
  }
  return criteria;
}

function extractStatement(lines) {
  const body = [];
  let skippingMetadata = true;
  for (const line of lines) {
    if (skippingMetadata && (!line.trim() || METADATA_RE.test(line))) continue;
    skippingMetadata = false;
    if (/^\s*(acceptance criteria|acceptance|criteria)\s*:?\s*$/i.test(line)) break;
    if (/^\s*[-*]\s+/.test(line)) break;
    if (!line.trim()) {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.trim());
  }
  return body.join(" ").trim();
}

function requirementSortKey(req) {
  return req.id;
}

function buildRequirement({ heading, title, bodyLines, sourceId, sourcePath, lineStart, lineEnd }) {
  const metadata = parseMetadata(bodyLines, { sourcePath, lineStart });
  const block = [heading, ...bodyLines].join("\n").trimEnd();
  const id = heading.match(REQUIREMENT_HEADING_RE)[2].toUpperCase();
  const headingTitle = title && title.trim() ? title.trim() : id;
  const sourceAnchor = slugify(`${id} ${headingTitle}`);
  const evidence = splitList(metadataValue(metadata, ["evidence", "evidence_classes", "evidence class"]));

  let classification;
  let coverageStatus;
  let coverageConfidence;
  try {
    classification = {
      kind: normalizeKind(metadataValue(metadata, ["kind", "type"])),
      priority: normalizePriority(metadataValue(metadata, ["priority", "pri"])),
      risk_class: normalizeRisk(metadataValue(metadata, ["risk", "risk_class"])),
      criticality: normalizeEnum(metadataValue(metadata, ["criticality"]), "Criticality", ["standard", "business_critical", "safety_critical", "compliance_critical"], "standard"),
      lifecycle: normalizeEnum(metadataValue(metadata, ["lifecycle", "status"]), "Lifecycle", ["draft", "approved", "implemented", "retired"], "draft"),
    };
    coverageStatus = normalizeEnum(metadataValue(metadata, ["coverage", "coverage_status"]), "Coverage", ["unlinked", "planned", "in_progress", "partial", "satisfied", "waived", "deviation", "defect", "stale", "retired"], "unlinked");
    coverageConfidence = normalizeEnum(metadataValue(metadata, ["confidence"]), "Confidence", ["explicit", "inferred", "candidate"], "explicit");
  } catch (error) {
    throw new Error(`${sourcePath}:${lineStart}: ${id}: ${error.message}`);
  }

  return {
    id,
    title: headingTitle,
    statement: extractStatement(bodyLines),
    acceptance_criteria: extractAcceptanceCriteria(bodyLines),
    source: {
      source_id: sourceId,
      path: sourcePath,
      anchor: sourceAnchor,
      line_start: lineStart,
      line_end: lineEnd,
      block_hash: sha256Prefixed(block),
      imported: true,
    },
    classification,
    dimensions: {
      personas: splitList(metadataValue(metadata, ["persona", "personas"])),
      workflows: splitList(metadataValue(metadata, ["workflow", "workflows"])),
      screens: splitList(metadataValue(metadata, ["screen", "screens"])),
      routes: splitList(metadataValue(metadata, ["route", "routes"])),
      apis: splitList(metadataValue(metadata, ["api", "apis"])),
      data_entities: splitList(metadataValue(metadata, ["data", "data_entities", "entities"])),
      events: splitList(metadataValue(metadata, ["event", "events"])),
      security_controls: splitList(metadataValue(metadata, ["security", "security_controls"])),
      evidence_classes: evidence.length ? evidence : ["manual_review"],
    },
    coverage: {
      status: coverageStatus,
      confidence: coverageConfidence,
      ticket_ids: splitList(metadataValue(metadata, ["ticket", "tickets", "ticket_ids"])),
      evidence_refs: [],
      waiver_ref: metadataValue(metadata, ["waiver", "waiver_ref"]) || null,
      defect_ref: metadataValue(metadata, ["defect", "defect_ref"]) || null,
      last_verified_at_utc: null,
    },
    provenance: {
      created_by: "import",
      created_from: [sourceId],
      derived_from_requirement_ids: splitList(metadataValue(metadata, ["derived_from", "derived_from_requirement_ids"])),
      reviewed_by: splitList(metadataValue(metadata, ["reviewed_by", "reviewers"])),
      change_reason: metadataValue(metadata, ["change_reason"]) || "markdown import",
    },
  };
}

function parseMarkdownRequirements(text, options = {}) {
  const sourcePath = options.sourcePath || "coord/product/REQUIREMENTS.md";
  const sourceId = options.sourceId || "SRC-001";
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const found = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(REQUIREMENT_HEADING_RE);
    if (!match) continue;

    const level = match[1].length;
    const bodyLines = [];
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const heading = lines[j].match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= level) break;
      bodyLines.push(lines[j]);
      end = j;
    }

    found.push(
      buildRequirement({
        heading: lines[i],
        title: match[3],
        bodyLines,
        sourceId,
        sourcePath,
        lineStart: i + 1,
        lineEnd: end + 1,
      })
    );
  }

  found.sort((a, b) => requirementSortKey(a).localeCompare(requirementSortKey(b)));
  return found;
}

function buildRegistry(sources, requirements, options = {}) {
  const sortedSources = sources.slice().sort((a, b) => a.id.localeCompare(b.id));
  const sortedRequirements = requirements.slice().sort((a, b) => a.id.localeCompare(b.id));
  return {
    kind: "concord.requirements.registry",
    schema_version: 1,
    project: {
      name: options.projectName || "unknown",
      profile: options.profile || "product-engineering",
      source_policy: options.sourcePolicy || "direct-or-imported",
    },
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    generator: {
      name: "requirements-import",
      version: "0.1.0",
      command: "coord/engine/scripts/requirements-import.js",
    },
    sources: sortedSources,
    requirements: sortedRequirements,
    links: [],
    findings: [],
  };
}

function sourceRecord({ id, filePath, relativePath, text, authority, visibility }) {
  return {
    id,
    type: "markdown",
    label: path.basename(filePath),
    uri: relativePath,
    authority,
    visibility,
    owner: "product",
    version: null,
    retrieved_at_utc: null,
    content_hash: sha256Prefixed(text),
    notes: "Imported from explicit markdown requirement headings.",
  };
}

function parseArgs(argv) {
  const options = {
    sources: [],
    json: false,
    rootDir: process.cwd(),
    projectName: "unknown",
    sourceIdPrefix: "SRC",
    authority: "authoritative",
    visibility: "public",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--source") {
      const value = argv[++i];
      if (!value) return { error: "--source requires a path" };
      options.sources.push(value);
      continue;
    }
    if (arg === "--dir") {
      const value = argv[++i];
      if (!value) return { error: "--dir requires a path" };
      options.rootDir = value;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++i];
      if (!value) return { error: "--project requires a name" };
      options.projectName = value;
      continue;
    }
    if (arg === "--authority") {
      const value = argv[++i];
      if (!value) return { error: "--authority requires a value" };
      options.authority = value;
      continue;
    }
    if (arg === "--visibility") {
      const value = argv[++i];
      if (!value) return { error: "--visibility requires a value" };
      options.visibility = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }

  return { options };
}

function renderMarkdown(registry) {
  const lines = [];
  lines.push("# Requirements Import");
  lines.push("");
  lines.push(`Project: ${registry.project.name}`);
  lines.push(`Sources: ${registry.sources.length}`);
  lines.push(`Requirements: ${registry.requirements.length}`);
  lines.push("");
  for (const req of registry.requirements) {
    lines.push(`- ${req.id}: ${req.title} (${req.source.path}:${req.source.line_start}, ${req.source.block_hash})`);
  }
  return lines.join("\n");
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;

  if (parsed.error) {
    log(`requirements-import: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-import --source <markdown> [--source <markdown> ...] [--dir <root>] [--project <name>] [--json]");
    return { code: 0 };
  }

  const options = parsed.options;
  if (!options.sources.length) {
    options.sources.push("coord/product/REQUIREMENTS.md");
  }

  const rootDir = path.resolve(cwd, options.rootDir);
  const sources = [];
  const requirements = [];

  for (let index = 0; index < options.sources.length; index += 1) {
    const sourceArg = options.sources[index];
    const filePath = path.resolve(rootDir, sourceArg);
    if (!fsImpl.existsSync(filePath)) {
      log(`requirements-import: source not found: ${sourceArg}`);
      return { code: 1 };
    }
    const id = `${options.sourceIdPrefix}-${String(index + 1).padStart(3, "0")}`;
    // Single read: the source text is read once via the injected fs and reused
    // for both requirement parsing and the source content hash (no second
    // module-fs read inside sourceRecord).
    const text = fsImpl.readFileSync(filePath, "utf8");
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
    let parsedReqs;
    try {
      parsedReqs = parseMarkdownRequirements(text, { sourceId: id, sourcePath: relativePath });
    } catch (error) {
      log(`requirements-import: ${error.message}`);
      return { code: 1 };
    }
    sources.push(
      sourceRecord({
        id,
        filePath,
        relativePath,
        text,
        authority: options.authority,
        visibility: options.visibility,
      })
    );
    requirements.push(...parsedReqs);
  }

  // Fail closed on duplicate requirement IDs rather than silently merging or
  // overwriting two distinct requirement blocks that share an id.
  const seenIds = new Map();
  for (const req of requirements) {
    if (seenIds.has(req.id)) {
      const firstPath = seenIds.get(req.id);
      log(
        `requirements-import: duplicate requirement id ${req.id} (defined in ${firstPath} and ${req.source.path}); ids must be unique across imported sources`
      );
      return { code: 1 };
    }
    seenIds.set(req.id, req.source.path);
  }

  const registry = buildRegistry(sources, requirements, {
    projectName: options.projectName,
  });
  log(options.json ? JSON.stringify(registry, null, 2) : renderMarkdown(registry));
  return { code: 0, registry };
}

module.exports = {
  buildRegistry,
  parseMarkdownRequirements,
  renderMarkdown,
  main,
  run,
};

function main() {
  const result = run(process.argv.slice(2));
  process.exit(result.code);
}
if (require.main === module) main();
