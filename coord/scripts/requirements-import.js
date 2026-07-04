#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIREMENT_HEADING_RE = /^(#{1,6})\s+((?:REQ|URS|PRD|SRS|FR|NFR|SEC|DONOR-REQ)-[A-Za-z0-9_.-]+)\s*(?::|-|--)?\s*(.*)$/i;
const METADATA_RE = /^\s*[-*]\s*([A-Za-z][A-Za-z0-9 _/-]{1,40})\s*:\s*(.+?)\s*$/;

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

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
  if (["low", "medium", "high", "critical", "regulated"].includes(risk)) return risk;
  return "medium";
}

function normalizePriority(value) {
  const pri = String(value || "").trim().toUpperCase();
  if (/^P[0-3]$/.test(pri)) return pri;
  return "P2";
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase().replace(/[^a-z_]/g, "_");
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
  return allowed.has(kind) ? kind : "functional";
}

function metadataValue(metadata, names) {
  for (const name of names) {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(metadata, key)) return metadata[key];
  }
  return "";
}

function parseMetadata(lines) {
  const metadata = {};
  for (const line of lines) {
    const match = line.match(METADATA_RE);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    metadata[key] = match[2].trim();
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
  const metadata = parseMetadata(bodyLines);
  const block = [heading, ...bodyLines].join("\n").trimEnd();
  const id = heading.match(REQUIREMENT_HEADING_RE)[2].toUpperCase();
  const headingTitle = title && title.trim() ? title.trim() : id;
  const sourceAnchor = slugify(`${id} ${headingTitle}`);
  const evidence = splitList(metadataValue(metadata, ["evidence", "evidence_classes", "evidence class"]));

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
      block_hash: sha256(block),
      imported: true,
    },
    classification: {
      kind: normalizeKind(metadataValue(metadata, ["kind", "type"])),
      priority: normalizePriority(metadataValue(metadata, ["priority", "pri"])),
      risk_class: normalizeRisk(metadataValue(metadata, ["risk", "risk_class"])),
      criticality: metadataValue(metadata, ["criticality"]) || "standard",
      lifecycle: metadataValue(metadata, ["lifecycle", "status"]) || "draft",
    },
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
      status: metadataValue(metadata, ["coverage", "coverage_status"]) || "unlinked",
      confidence: metadataValue(metadata, ["confidence"]) || "explicit",
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
      command: "coord/scripts/requirements-import.js",
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
    authority: authority || "authoritative",
    visibility: visibility || "public",
    owner: "product",
    version: null,
    retrieved_at_utc: null,
    content_hash: sha256(text),
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
    const parsedReqs = parseMarkdownRequirements(text, { sourceId: id, sourcePath: relativePath });
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
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
