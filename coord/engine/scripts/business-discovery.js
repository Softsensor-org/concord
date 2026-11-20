#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const domainAdapters = require("./domain-discovery-adapters.js");
const evidenceAuthority = require("./evidence-authority.js");
const staticConfigDeclaration = require("./static-config-declaration.js");
const sourceDiscovery = require("./business-discovery-source.js");

const ARTIFACT_KIND = "concord.business_discovery.run";
const DEFAULT_OUTPUT = "coord/.runtime/discovery/run.json";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);

const EXT_LANG = new Map([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".rb", "ruby"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".cs", "csharp"],
  [".php", "php"],
  [".sql", "sql"],
  [".prisma", "prisma"],
  [".graphql", "graphql"],
  [".gql", "graphql"],
  [".md", "markdown"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".json", "json"],
]);

const PACKAGE_FILES = new Map([
  ["package.json", "npm"],
  ["package-lock.json", "npm-lock"],
  ["pnpm-lock.yaml", "pnpm-lock"],
  ["yarn.lock", "yarn-lock"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python-requirements"],
  ["poetry.lock", "poetry-lock"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["Gemfile", "ruby"],
  ["pom.xml", "maven"],
  ["build.gradle", "gradle"],
  ["composer.json", "composer"],
]);

// COORD-582 — explicit bounds on file-derived records. One file may emit at
// most `perFile` records and `perFile` component relationships; all files
// together may emit at most `total` records, after which the remaining files
// are inventoried (language and package counts) but not analysed. Every bound
// that is reached is reported by a `record_cap` hypothesis record that states
// what was not emitted; nothing is dropped silently. Those truncation records,
// and the run-level records added after the file scan, are not counted.
const RECORD_LIMITS = Object.freeze({ perFile: 500, total: 10_000 });

// Source kinds counted in the inventory that the static parser does not read.
// Routes, workflows and components in these files are unknown, not absent.
const UNSUPPORTED_SOURCE_KINDS = new Map([
  [".py", "python"],
  [".rb", "ruby"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".cs", "csharp"],
  [".php", "php"],
  [".vue", "vue"],
  [".svelte", "svelte"],
]);

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

// Resolve prospective destinations through symlinked existing ancestors. Any
// path that cannot be resolved safely is rejected before a write is attempted.
function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    let exists = false;
    try {
      fs.lstatSync(current);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
    if (exists) return path.join(fs.realpathSync(current), ...missing.reverse());
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseArgs(argv = []) {
  const options = {
    dir: ".",
    output: null,
    json: false,
    maxFiles: 2500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--write-default") {
      options.output = DEFAULT_OUTPUT;
      options.json = true;
      continue;
    }
    if (["--dir", "--output", "--max-files"].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = key === "maxFiles" ? Number(value) : value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1) {
    return { error: "--max-files must be a positive integer" };
  }
  return { options };
}

function walk(root, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const files = [];
  function visit(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const relative = rel(root, full);
        if (relative === "coord/.runtime" || relative.startsWith("coord/.runtime/")) continue;
        if (relative === "coord/.worktrees" || relative.startsWith("coord/.worktrees/")) continue;
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  visit(root);
  return files;
}

// COORD-657 — the untrusted-adopter boundary.
//
// Discovery scans repositories Concord has never seen, so an adopter's
// `coord/project.config.js` is INPUT, not state (ADR-0010's class, applied to
// ADR-0007's "never execute adopter code" rule). It is READ STATICALLY and
// never required, evaluated, or compiled. Only the fields discovery actually
// consumes or reports are projected out of the declaration; every one is
// validated before it is believed, so a hostile or malformed config can neither
// run nor smuggle unrelated values into a discovery artifact.

// The single derived field list for the declared surface. Anything not named
// here never leaves this function, so unrelated keys an adopter parks in
// project.config.js (tokens, notes, absolute paths) cannot reach run.json.
const DECLARED_REPO_FIELDS = Object.freeze(["path", "integrationBranch"]);

function declaredString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectDeclaredSurface(declared) {
  const surface = { repos: {}, tracks: [], coord_ticket_prefix: null };
  if (!isPlainObject(declared)) return surface;

  if (isPlainObject(declared.repos)) {
    for (const [code, value] of Object.entries(declared.repos)) {
      // Repo CODES are adopter-declared. Discovery is not the config validator
      // (`coord/paths.js` is), but it will not carry a key that could be read
      // as a path or a control sequence into an artifact.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(code) || !isPlainObject(value)) continue;
      const repo = {};
      for (const field of DECLARED_REPO_FIELDS) repo[field] = declaredString(value[field]);
      surface.repos[code] = repo;
    }
  }
  if (isPlainObject(declared.tracks)) {
    surface.tracks = Object.keys(declared.tracks)
      .filter((name) => declaredString(name) && isPlainObject(declared.tracks[name]))
      .sort();
  }
  surface.coord_ticket_prefix = declaredString(declared.coordTicketPrefix);
  return surface;
}

function readProjectConfig(root) {
  const configPath = path.join(root, "coord/project.config.js");
  const result = staticConfigDeclaration.readDeclaredConfig(configPath, {
    displayPath: "coord/project.config.js",
    // The scanned root is the containment boundary: a config reached through a
    // symlinked parent that escapes it is refused, not read.
    containmentRoot: root,
  });
  if (result.status === "absent") {
    return { declaration: { status: "absent", path: null, code: null, message: null, remediation: null }, surface: null, path: null };
  }
  // guard:static-config-safety
  if (result.status === "refused") {
    return {
      declaration: {
        status: "refused",
        path: rel(root, result.path),
        code: result.code,
        message: result.message,
        remediation: result.remediation,
      },
      surface: null,
      path: result.path,
    };
  }
  return {
    declaration: { status: "declared", path: rel(root, result.path), code: null, message: null, remediation: null },
    surface: projectDeclaredSurface(result.declared),
    path: result.path,
  };
}

function createBuilder(root) {
  const sources = [];
  const sourceByPath = new Map();
  // Constant-time id lookups: a scan emits one source per cited location.
  const sourceById = new Map();
  const records = [];
  const recordById = new Map();
  const relationships = [];
  const questions = [];
  const questionLedger = [];
  const decisionLedger = [];
  const reflectionLedger = [];
  const promotionCandidates = [];

  function sourceFor(filePath, authority = "implementation", location = null) {
    const relativePath = rel(root, filePath);
    const key = `${relativePath}:${authority}:${location ? `${location.line_start}:${location.line_end}` : ""}`;
    if (sourceByPath.has(key)) return sourceByPath.get(key);
    const id = `SRC-${String(sources.length + 1).padStart(4, "0")}`;
    sourceByPath.set(key, id);
    const classification = evidenceAuthority.classifySource({ authority, visibility: "internal" });
    const source = {
      id,
      type: "file",
      path: relativePath,
      uri: relativePath,
      commit: null,
      line_start: location ? location.line_start : null,
      line_end: location ? location.line_end : null,
      event_hash: null,
      chain_head: null,
      source_hash: null,
      authority,
      freshness: classification.freshness,
      sensitivity: classification.sensitivity,
      visibility: "internal",
    };
    sources.push(source);
    sourceById.set(id, source);
    return id;
  }

  function recordFor(recordId) {
    return recordById.get(recordId);
  }

  function addRecord(kind, statement, filePath, extra = {}) {
    const id = `BD-REC-${String(records.length + 1).padStart(6, "0")}`;
    // Every private call supplies a concrete source, subject and predicate; sourceFor inserts the source synchronously.
    const sourceId = sourceFor(filePath, extra.authority || "implementation", extra.source_location);
    const source = sourceById.get(sourceId);
    const record = {
      id,
      kind,
      subject: extra.subject,
      predicate: extra.predicate,
      object: extra.object || null,
      statement,
      scope: {
        repos: extra.repos || [],
        bounded_context: extra.bounded_context || null,
        tenants: [],
        applies_when: extra.applies_when || null,
      },
      confidence: extra.confidence || "observed",
      status: extra.status || "candidate",
      classification: extra.classification || "internal",
      evidence: [{ source_id: sourceId, note: extra.note || null }],
      history: {
        effective_from: null,
        effective_to: null,
        supersedes: [],
        superseded_by: null,
        source_hashes: [],
      },
      review: {
        owner: extra.owner || null,
        review_required: extra.review_required !== false,
        reason: extra.review_reason || "Discovery output is candidate knowledge until promoted.",
      },
    };
    record.authority = evidenceAuthority.classifyRecordAuthority(record, [source]);
    record.confidence = record.authority.confidence;
    record.computed_confidence = record.authority.computed_confidence;
    record.confidence_score = record.authority.confidence_score;
    record.confidence_inputs = record.authority.confidence_inputs;
    records.push(record);
    recordById.set(id, record);
    return id;
  }

  function addQuestion(question, owner, blocks = [], extra = {}) {
    const id = `BD-Q-${String(questions.length + 1).padStart(4, "0")}`;
    const blockedRecords = blocks
      .map((recordId) => records.find((record) => record.id === recordId))
      .filter(Boolean);
    const evidence = blockedRecords.flatMap((record) => record.evidence || []);
    if (evidence.length === 0) evidence.push({ source_id: sourceFor(root, "runtime_observation"), note: "Discovery run-level question." });
    questions.push({
      id,
      question,
      owner: owner || null,
      status: "open",
      blocks,
    });
    questionLedger.push({
      id,
      question,
      owner: owner || null,
      status: "open",
      priority: extra.priority || (blocks.length > 0 ? "high" : "medium"),
      impact: blocks.length > 0
        ? "Blocks promotion of source-backed discovery records into requirements, memory, ADRs, or tickets."
        : "Improves discovery confidence before behavior-changing work.",
      ask_reason: "Human-light discovery asks only when source evidence cannot prove business intent.",
      evidence: evidence.slice(0, 10),
      blocks,
      decision_required: blocks.length > 0,
      generated_from: extra.generated_from || (blocks.length > 0 ? "missing_authority" : "scan_sanity"),
    });
    return id;
  }

  function addDecision({ questionId = null, subject, owner, status = "pending", decision = null, options = [], rationale, evidence = [], waiver = null }) {
    if (evidence.length === 0) evidence = [{ source_id: sourceFor(root, "runtime_observation"), note: "Discovery decision needs owner confirmation." }];
    const id = `BD-DEC-${String(decisionLedger.length + 1).padStart(4, "0")}`;
    decisionLedger.push({
      id,
      question_id: questionId,
      subject,
      owner: owner || null,
      status,
      decision,
      options,
      rationale,
      evidence: evidence.slice(0, 10),
      consequences: status === "pending"
        ? ["Dependent discovery claims remain non-governing until this decision or waiver is accepted."]
        : [],
      waiver,
    });
    return id;
  }

  function addReflection({ category, statement, evidence = [], related_records = [], adapter_id = null, recommendation = null, status = "candidate" }) {
    if (evidence.length === 0) evidence = [{ source_id: sourceFor(root, "runtime_observation"), note: "Discovery run-level reflection." }];
    const id = `BD-REFL-${String(reflectionLedger.length + 1).padStart(4, "0")}`;
    reflectionLedger.push({
      id,
      category,
      statement,
      evidence: evidence.slice(0, 10),
      related_records,
      adapter_id,
      recommendation,
      status,
    });
    return id;
  }

  function addPromotion(recordId, target, reason) {
    promotionCandidates.push({
      id: `BD-PROMO-${String(promotionCandidates.length + 1).padStart(4, "0")}`,
      record_id: recordId,
      target,
      status: "proposed",
      required_reviewer: "governed-synthesizer",
      reason,
    });
  }

  return {
    sources,
    records,
    relationships,
    questions,
    questionLedger,
    decisionLedger,
    reflectionLedger,
    promotionCandidates,
    addRecord,
    recordFor,
    addQuestion,
    addDecision,
    addReflection,
    addPromotion,
  };
}

// Read one sentinel byte beyond the supported source bound. Never load an
// arbitrary-size adopter file merely to discover that parsing must be skipped.
function readDiscoverySource(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(250_001);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function classifyPath(relativePath, source = "", parsedSource = null) {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  const parts = lower.split("/");
  const text = String(source || "");
  const tags = [];
  if (PACKAGE_FILES.has(path.basename(relativePath))) tags.push({ kind: "configuration_surface", label: `package manager: ${PACKAGE_FILES.get(path.basename(relativePath))}` });
  if (lower.includes("migration") || lower.includes("migrations") || base.includes("schema") || lower.endsWith(".sql") || lower.endsWith(".prisma")) tags.push({ kind: "data_dependency", label: "schema, migration, or ORM model" });
  const sourceFindings = parsedSource ? parsedSource.findings : /\.(?:c|m)?(?:js|ts|jsx|tsx)$/.test(lower) ? sourceDiscovery.inspectSource(text) : [];
  if (parts.some((part) => ["config", "configs"].includes(part)) || ["dockerfile", ".env.example"].includes(base) || /\.(ya?ml|toml|ini)$/.test(lower)) tags.push({ kind: "configuration_surface", label: "configuration or feature-flag surface" });
  if (lower.endsWith(".md") && /(?:contract|configuration|policy|process|workflow)/.test(base)) tags.push({ kind: "fact", label: "documentation source" });
  for (const finding of sourceFindings) tags.push({ ...finding, source_registration: true });
  return tags;
}

function emitSemanticRecords(builder, filePath, relativePath, source) {
  const text = String(source || "");
  // analyze() reads source text only for code and Prisma files, so text is
  // empty for every other extension.
  if (!text) return;

  const schema = relativePath.endsWith(".prisma")
    ? sourceDiscovery.inspectPrismaSchema(text)
    : sourceDiscovery.inspectMongooseSchemas(text);
  for (const model of schema.models) {
    const suffix = model.collection ? ` (collection ${model.collection})` : "";
    builder.addRecord(
      "business_object",
      `Discovered schema model ${model.name}${suffix} at ${relativePath}.`,
      filePath,
      { subject: model.name, predicate: "schema_model", object: relativePath, note: `declaration offset ${model.at}${model.collection ? `; collection ${model.collection}` : ""}`, confidence: "observed", review_reason: "A statically declared model is a candidate domain entity; its business meaning and storage mapping require owner review." }
    );
  }

  // Source offset of each field name the patterns below report, with the
  // constraint text reported for it, so the schema-scoped pass further down
  // adds only what these records do not already say.
  const reportedFields = [];
  const fieldRulePattern = /\b([A-Za-z_$][\w$]*)\s*:\s*([^\n,}]{0,220})/g;
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*\{([^{}]{1,220})\}/g)) {
    if (!/\b(?:required|unique|enum|minlength|maxlength|default)\s*:/i.test(match[2])) continue;
    reportedFields.push([match.index, match[2]]);
    builder.addRecord(
      "field_rule",
      `Discovered field constraint for ${match[1]} at ${relativePath}: ${match[2].trim()}.`,
      filePath,
      { subject: match[1], predicate: "field_constraint", object: match[2].trim(), confidence: "observed", review_reason: "Schema constraints are candidate field rules until owner review." }
    );
  }
  for (const match of text.matchAll(fieldRulePattern)) {
    const expression = match[2];
    if (!/(?:required|min(?:Length)?\s*\(|max(?:Length)?\s*\(|enum\s*[:(]|unique\s*[:(]|\.email\s*\(|\.uuid\s*\(|@(?:id|unique|default)\b)/i.test(expression)) continue;
    reportedFields.push([match.index, expression]);
    builder.addRecord(
      "field_rule",
      `Discovered field constraint for ${match[1]} at ${relativePath}: ${expression.trim()}.`,
      filePath,
      { subject: match[1], predicate: "field_constraint", object: expression.trim(), confidence: "observed", review_reason: "Validator and schema constraints are candidate field rules until reviewed by the domain owner." }
    );
  }
  for (const match of text.matchAll(/^\s*([A-Za-z_][\w]*)\s+[A-Za-z][\w\[\]?]*(?:\s+(@(?:id|unique|default|updatedAt)\b[^\n]*)+)/gm)) {
    reportedFields.push([match.index + match[0].search(/\S/), match[2]]);
    builder.addRecord(
      "field_rule",
      `Discovered schema constraint for ${match[1]} at ${relativePath}: ${match[2].trim()}.`,
      filePath,
      { subject: match[1], predicate: "field_constraint", object: match[2].trim(), confidence: "observed", review_reason: "Schema constraints are candidate field rules until reviewed by the domain owner." }
    );
  }

  // COORD-583 — schema-scoped constraints and named validators. The patterns
  // above read `key: expr` wherever it appears and miss numeric min/max
  // options, type-only fields, Prisma types and every validator. This pass
  // reads only the body of a Mongoose Schema({...}) or a Prisma model block,
  // so the same option keys outside a schema never become rules.
  const squash = (value) => value.replace(/\s+/g, "");
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  const emitted = new Set();
  for (const rule of schema.fieldRules) {
    const known = squash(reportedFields.filter(([offset]) => offset === rule.at).map(([, constraint]) => constraint).join(" "));
    const object = rule.constraints.filter((constraint) => !known.includes(squash(constraint))).join(", ").slice(0, 220);
    const key = `${rule.model}\u0000${rule.field}\u0000${object}`;
    if (!object || emitted.has(key)) continue;
    emitted.add(key);
    builder.addRecord(
      "field_rule",
      `Discovered field constraint for ${rule.field}${rule.model ? ` on ${rule.model}` : ""} at ${relativePath}: ${object}.`,
      filePath,
      { subject: rule.field, predicate: "field_constraint", object, bounded_context: rule.model, note: `line ${lineOf(rule.at)}`, confidence: "observed", review_reason: "Schema type and range constraints are candidate field rules until reviewed by the domain owner." }
    );
  }
  for (const validator of schema.validators) {
    const target = `${validator.model ? `${validator.model}.` : ""}${validator.field}`;
    const key = `${validator.name}\u0000${target}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    builder.addRecord(
      "business_rule",
      `Discovered named validator ${validator.name} for ${target} at ${relativePath}${validator.message ? `: ${validator.message}` : ""}.`,
      filePath,
      { subject: validator.name, predicate: "named_validator", object: target, bounded_context: validator.model, note: `line ${lineOf(validator.at)}`, confidence: "observed", review_reason: "A named validator attached to a schema field is a candidate business rule; what it enforces and when it applies require owner review." }
    );
  }

  const explicitRule = text.match(/\b(?:business[_ ]?rule|eligibility|invariant|approval[_ ]?policy|policy)\b[^\n;}]*/i);
  if (explicitRule) {
    builder.addRecord(
      "business_rule",
      `Discovered explicit policy/rule signal at ${relativePath}: ${explicitRule[0].trim()}.`,
      filePath,
      { subject: relativePath, predicate: "explicit_policy_signal", object: explicitRule[0].trim(), confidence: "inferred", review_reason: "Explicit policy names are candidate business rules; source authority and applicability require review." }
    );
  }

  for (const match of text.matchAll(/(?:CONTRADICTION|CONFLICT)\s*:\s*([^\n]+)/gi)) {
    builder.addRecord(
      "hypothesis",
      `Discovered an explicit conflict marker at ${relativePath}: ${match[1].trim()}.`,
      filePath,
      { subject: relativePath, predicate: "explicit_conflict_marker", object: match[1].trim(), confidence: "inferred", review_reason: "A source marker is only a candidate conflict signal; the scanner does not compare sources or establish a contradiction." }
    );
  }
}

function recordRefs(records, predicate, limit = 12) {
  return records
    .filter(predicate)
    .slice(0, limit)
    .map((record) => ({
      record_id: record.id,
      kind: record.kind,
      statement: record.statement,
      confidence: record.confidence,
      status: record.status,
      evidence: record.evidence || [],
    }));
}

function buildColdStartBaseline({ files, repoNames, languageCounts, packageManagers, builder, adapterSignals, signalRecordIds, maxFiles }) {
  const confirmedRecords = builder.records.filter((record) => record.confidence === "confirmed" && record.status === "accepted");
  const workflowKinds = new Set(["workflow", "ux_behavior"]);
  const ruleKinds = new Set(["business_rule", "field_rule", "configuration_surface", "integration_contract", "data_dependency", "hypothesis"]);
  const highSignalKinds = new Set(["data_dependency", "integration_contract", "workflow", "ux_behavior", "configuration_surface"]);
  const highSignalRecords = builder.records.filter((record) => highSignalKinds.has(record.kind));

  return {
    status: confirmedRecords.length === 0 ? "sparse_memory_baseline" : "partial_confirmed_baseline",
    sparse_memory: confirmedRecords.length === 0,
    authority_warning: confirmedRecords.length === 0
      ? "No accepted confirmed business-memory claims were found in this cold-start scan. Treat observed and inferred items as candidate context only."
      : "Confirmed records are present, but unaccepted observed and inferred items remain candidate context only.",
    confirmed_authority: {
      accepted_confirmed_records: confirmedRecords.length,
      may_claim_confirmed_memory: confirmedRecords.length > 0,
    },
    inventory_coverage: {
      files_scanned: files.length,
      scan_truncated: files.length >= (maxFiles || 2500),
      repos_seen: repoNames.length > 0 ? repoNames : ["root"],
      languages: Object.fromEntries(Array.from(languageCounts.entries()).sort()),
      package_managers: Array.from(packageManagers).sort(),
      high_signal_records: highSignalRecords.length,
      adapter_signals: adapterSignals.map((signal) => ({
        id: signal.id,
        label: signal.label,
        confidence: signal.confidence,
        matched_path_count: signal.matched_paths.length,
      })),
      gaps: [
        confirmedRecords.length === 0 ? "No accepted confirmed memory or owner-approved business rules were found." : null,
        signalRecordIds.length === 0 ? "No high-signal business paths were detected by starter classifiers." : null,
        files.length >= (maxFiles || 2500) ? "File scan reached max-files limit; inventory is incomplete." : null,
      ].filter(Boolean),
    },
    observed_workflows: recordRefs(builder.records, (record) => workflowKinds.has(record.kind) && record.confidence === "observed"),
    inferred_rules: recordRefs(builder.records, (record) => ruleKinds.has(record.kind) && record.confidence !== "confirmed"),
    known_unknowns: builder.questionLedger.map((question) => ({
      question_id: question.id,
      question: question.question,
      owner: question.owner,
      priority: question.priority,
      impact: question.impact,
      blocks: question.blocks || [],
      evidence: question.evidence || [],
    })),
    risky_workaround_candidates: [
      ...recordRefs(builder.records, (record) => record.kind === "hypothesis" || record.kind === "reflection"),
      ...adapterSignals.flatMap((signal) => (signal.risks || []).slice(0, 4).map((risk) => ({
        adapter_id: signal.id,
        label: signal.label,
        risk,
        confidence: signal.confidence,
        matched_paths: signal.matched_paths.slice(0, 5),
      }))),
    ].slice(0, 12),
    required_human_questions: builder.questionLedger
      .filter((question) => question.decision_required || question.priority === "high")
      .map((question) => ({
        question_id: question.id,
        question: question.question,
        owner: question.owner,
        priority: question.priority,
        decision_required: question.decision_required,
        blocks: question.blocks || [],
      })),
    initial_preservation_test_candidates: recordRefs(
      builder.records,
      (record) => ["workflow", "ux_behavior", "integration_contract", "data_dependency", "configuration_surface", "business_rule", "field_rule", "hypothesis"].includes(record.kind),
      16
    ).map((item) => ({
      ...item,
      approval_required: true,
      reason: "Candidate preservation harness only; do not convert to an implementation constraint until reviewed or promoted.",
    })),
  };
}

function analyze(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const { declaration, surface, path: configPath } = readProjectConfig(resolvedRoot);
  const files = walk(resolvedRoot, { maxFiles: options.maxFiles });
  const builder = createBuilder(resolvedRoot);
  const repoNames = [];

  if (configPath) {
    const configRecord = builder.addRecord(
      "configuration_surface",
      "Concord project config declares repo layout and governance tracks.",
      configPath,
      { subject: "coord/project.config.js", predicate: "declares", object: "repo layout", confidence: surface ? "observed" : "unknown" }
    );
    builder.addPromotion(configRecord, "question", "Repo layout should be reviewed before discovery findings govern tickets.");
    builder.addDecision({
      subject: "discovery_scope.repo_layout",
      owner: "repo-owner",
      rationale: "Discovery can scan configured repos, but a human owner must confirm whether the repo map is the intended business-system boundary.",
      options: [
        "accept configured repo map as discovery scope",
        "narrow discovery to a subsystem",
        "expand discovery to additional repos or external artifacts",
      ],
      // addRecord appends synchronously before returning its ID.
      evidence: builder.recordFor(configRecord).evidence,
    });
  }

  // COORD-657 — a configuration discovery cannot read statically fails CLOSED
  // and LOUDLY: a classified record, a decision-required question, and a
  // machine-readable `configuration_declaration` on the artifact. The previous
  // behavior (bare `catch {}` returning `{ config: null }`) left no trace at
  // all, which is exactly what made silent execution survivable.
  // guard:static-config-safety
  if (declaration.status === "refused") {
    const refusalRecord = builder.addRecord(
      "configuration_surface",
      `${declaration.message} ${declaration.remediation}`,
      configPath,
      {
        subject: "coord/project.config.js",
        predicate: "declaration_refused",
        object: declaration.code,
        confidence: "unknown",
        authority: "runtime_observation",
        review_reason: "Concord never executes an adopter configuration; an unreadable declaration must be resolved by an operator, not guessed.",
      }
    );
    const refusalQuestion = builder.addQuestion(
      `Concord refused to read coord/project.config.js without executing it (${declaration.code}). ${declaration.remediation}`,
      "repo-owner",
      [refusalRecord],
      { priority: "high", decision_required: true }
    );
    builder.addDecision({
      questionId: refusalQuestion,
      subject: "discovery_scope.configuration_declaration",
      owner: "repo-owner",
      rationale: "Discovery reads project.config.js statically and will not execute it. Until the declaration is readable, the repo map, integration branches, and tracks are UNKNOWN rather than assumed.",
      options: [
        "rewrite project.config.js as a static declaration",
        "run discovery from a root whose configuration is declarative",
        "supply the repo map to the operator out of band",
      ],
      // addRecord registers every id it returns with one source-backed evidence item.
      evidence: builder.recordFor(refusalRecord).evidence,
    });
  }

  for (const [code, repo] of Object.entries(surface?.repos || {})) {
    const repoPath = path.resolve(resolvedRoot, repo.path || "");
    repoNames.push(code);
    builder.addRecord(
      "configuration_surface",
      `Configured repo ${code} points to ${repo.path || "(missing path)"} and ${fs.existsSync(repoPath) ? "exists" : "is not present"} in this checkout.`,
      configPath,
      { subject: code, predicate: "repo_path", object: repo.path || null, confidence: fs.existsSync(repoPath) ? "observed" : "unknown", review_reason: "Configured repo paths describe setup, not a domain entity." }
    );
    if (repo.integrationBranch) {
      builder.addRecord(
        "configuration_surface",
        `Configured repo ${code} declares integration branch ${repo.integrationBranch}.`,
        configPath,
        { subject: code, predicate: "integration_branch", object: repo.integrationBranch, confidence: "observed", review_required: false, review_reason: "Integration branches are declared setup facts read statically from the configuration." }
      );
    }
  }

  for (const track of surface?.tracks || []) {
    builder.addRecord(
      "configuration_surface",
      `Configured governance track ${track} is declared for this project.`,
      configPath,
      { subject: track, predicate: "governance_track", object: track, confidence: "observed", review_required: false, review_reason: "Tracks are declared setup facts read statically from the configuration." }
    );
  }

  if (surface?.coord_ticket_prefix) {
    builder.addRecord(
      "configuration_surface",
      `Configured coord ticket prefix is ${surface.coord_ticket_prefix}.`,
      configPath,
      { subject: surface.coord_ticket_prefix, predicate: "coord_ticket_prefix", object: surface.coord_ticket_prefix, confidence: "observed", review_required: false }
    );
  }

  const languageCounts = new Map();
  const packageManagers = new Set();
  const signalRecordIds = [];
  const unsupportedSources = new Map();
  const perFileCap = options.maxRecordsPerFile || RECORD_LIMITS.perFile;
  const totalCap = options.maxFileRecords || RECORD_LIMITS.total;
  let fileRecordTotal = 0;
  let recordsTruncated = false;
  const unanalysedFiles = [];
  const relativeFiles = files.map((filePath) => rel(resolvedRoot, filePath));
  const adapterSignals = domainAdapters.detectAdapters(relativeFiles);

  for (const filePath of files) {
    const relativePath = rel(resolvedRoot, filePath);
    const ext = path.extname(relativePath).toLowerCase();
    if (EXT_LANG.has(ext)) {
      languageCounts.set(EXT_LANG.get(ext), (languageCounts.get(EXT_LANG.get(ext)) || 0) + 1);
    }
    const base = path.basename(relativePath);
    if (PACKAGE_FILES.has(base)) packageManagers.add(PACKAGE_FILES.get(base));
    if (UNSUPPORTED_SOURCE_KINDS.has(ext)) {
      const sourceKind = UNSUPPORTED_SOURCE_KINDS.get(ext);
      if (!unsupportedSources.has(sourceKind)) unsupportedSources.set(sourceKind, []);
      unsupportedSources.get(sourceKind).push(filePath);
    }

    if (fileRecordTotal >= totalCap) {
      unanalysedFiles.push(filePath);
      continue;
    }
    let fileRecords = 0;
    let fileRelationships = 0;
    let droppedRecords = 0;
    let droppedRelationships = 0;
    // Every record derived from this file goes through the caps; null means "counted, not emitted".
    const emitRecord = (kind, statement, sourcePath, extra) => {
      if (fileRecords >= perFileCap || fileRecordTotal >= totalCap) {
        droppedRecords += 1;
        return null;
      }
      fileRecords += 1;
      fileRecordTotal += 1;
      return builder.addRecord(kind, statement, sourcePath, extra);
    };

    let source = "";
    let sourceUnreadable = false;
    if (/\.(?:c|m)?(?:js|ts|jsx|tsx|vue|svelte|prisma)$/.test(relativePath)) {
      try {
        source = readDiscoverySource(filePath);
      } catch {
        sourceUnreadable = true;
      }
    }
    const parsedSource = /\.(?:c|m)?(?:js|ts|jsx|tsx)$/.test(relativePath.toLowerCase())
      ? sourceUnreadable ? { findings: [], relationships: [], parse_status: "unreadable", parse_error: null } : sourceDiscovery.inspectSourceDetailed(source) : null;
    if (parsedSource && parsedSource.parse_status !== "parsed") {
      emitRecord("hypothesis", `Source analysis at ${relativePath} is ${parsedSource.parse_status}; no registrations were inferred.`, filePath, {
        subject: relativePath, predicate: "source_parse_status", object: parsedSource.parse_status,
        note: parsedSource.parse_error, review_reason: "Source could not be statically parsed within the discovery bounds.",
      });
    }
    const componentIds = new Map();
    for (const tag of classifyPath(relativePath, source, parsedSource)) {
      const id = emitRecord(
        tag.kind,
        `Discovered ${tag.label} at ${relativePath}.`,
        filePath,
        {
          subject: tag.subject || relativePath,
          predicate: tag.source_registration ? "source_registration" : "path_classification",
          object: tag.label,
          source_location: tag.source_location,
          note: tag.source_registration ? JSON.stringify({ resolution_status: tag.resolution_status, source_location: tag.source_location }) : null,
          confidence: "observed",
          review_reason: tag.source_registration
            ? "Source syntax shows a candidate registration or component; inspect implementation and owner intent before promoting."
            : "Path-based discovery is a signal; inspect source before promoting.",
        }
      );
      if (id === null) continue;
      signalRecordIds.push(id);
      if (tag.kind === "ux_behavior" && tag.source_registration) componentIds.set(tag.subject, id);
      if (["data_dependency", "integration_contract", "workflow", "ux_behavior"].includes(tag.kind)) {
        builder.addPromotion(id, "question", "Candidate source evidence should be reviewed for business meaning before implementation changes.");
      }
    }
    if (parsedSource) for (const relationship of parsedSource.relationships) {
      const from = componentIds.get(relationship.from);
      const to = componentIds.get(relationship.to);
      // Both endpoints are JSX/component findings in this file; an edge is kept
      // only when both were emitted and the per-file edge bound has room.
      if (!from || !to || fileRelationships >= perFileCap) {
        droppedRelationships += 1;
        continue;
      }
      fileRelationships += 1;
      builder.relationships.push({ from, type: "depends_on", to,
        evidence: builder.recordFor(from).evidence });
    }
    if (Buffer.byteLength(source, "utf8") <= 250_000) emitSemanticRecords({ addRecord: emitRecord }, filePath, relativePath, source);
    if (droppedRecords > 0 || droppedRelationships > 0) {
      recordsTruncated = true;
      builder.addRecord(
        "hypothesis",
        `Discovery emitted ${fileRecords} candidate record(s) from ${relativePath} and did not emit ${droppedRecords} more record(s) and ${droppedRelationships} relationship(s) because a record cap was reached.`,
        filePath,
        {
          subject: relativePath,
          predicate: "record_cap",
          object: fileRecordTotal >= totalCap ? "total" : "per_file",
          confidence: "unknown",
          review_reason: "This file's inventory is incomplete; inspect it directly or narrow the scan before relying on absence.",
        }
      );
    }
  }

  if (unanalysedFiles.length > 0) {
    recordsTruncated = true;
    builder.addRecord(
      "hypothesis",
      `Discovery reached the total cap of ${totalCap} file-derived record(s); ${unanalysedFiles.length} file(s) starting at ${rel(resolvedRoot, unanalysedFiles[0])} were not analysed for records.`,
      unanalysedFiles[0],
      {
        subject: "discovery_run",
        predicate: "record_cap",
        object: "total",
        confidence: "unknown",
        review_reason: "The run stopped emitting file-derived records; narrow the scan to a subsystem to inventory the remaining files.",
      }
    );
  }

  // One record per unsupported source kind, not per file: the parser reads
  // JavaScript and TypeScript only, and silence must not read as "none found".
  for (const [sourceKind, kindFiles] of Array.from(unsupportedSources.entries()).sort()) {
    builder.addRecord(
      "hypothesis",
      `Discovery does not statically analyse ${sourceKind} source: ${kindFiles.length} ${sourceKind} file(s) were not inspected for routes, workflows or components, so their absence from this run is not evidence.`,
      kindFiles[0],
      {
        subject: sourceKind,
        predicate: "unsupported_source_kind",
        object: String(kindFiles.length),
        note: kindFiles.slice(0, 5).map((filePath) => rel(resolvedRoot, filePath)).join(", "),
        confidence: "unknown",
        review_reason: "Unsupported source kinds are an explicit coverage gap; inspect these files directly before relying on this inventory.",
      }
    );
  }

  for (const [language, count] of Array.from(languageCounts.entries()).sort()) {
    builder.addRecord(
      "fact",
      `Detected ${count} ${language} file(s) in the scanned repo tree.`,
      configPath || resolvedRoot,
      { subject: language, predicate: "file_count", object: String(count), confidence: "observed", review_required: false }
    );
  }
  for (const manager of Array.from(packageManagers).sort()) {
    builder.addRecord(
      "configuration_surface",
      `Detected package/dependency manager signal: ${manager}.`,
      configPath || resolvedRoot,
      { subject: manager, predicate: "package_manager", confidence: "observed", review_required: false }
    );
  }

  if (signalRecordIds.length === 0) {
    const questionId = builder.addQuestion("No high-signal business discovery paths were detected. Is the scan root correct?", "repo-owner");
    builder.addDecision({
      questionId,
      subject: "discovery_scope.scan_root",
      owner: "repo-owner",
      rationale: "A scan with no high-signal surfaces may mean the wrong root was scanned or the product uses conventions the starter classifier does not know yet.",
      options: ["confirm scan root", "rerun discovery from a different root", "add a domain discovery adapter"],
    });
    builder.addReflection({
      category: "assumption_disproved",
      statement: "The scan did not confirm the assumption that this root contains discoverable business, workflow, data, UI, or integration surfaces.",
      recommendation: "Confirm the root or add an adapter before using this discovery run for ticket planning.",
      status: "candidate",
    });
  } else {
    const blocks = signalRecordIds.slice(0, 20);
    const questionId = builder.addQuestion("Which discovered configuration, schema, workflow, and UI surfaces are authoritative for business behavior?", "business-domain-owner", blocks);
    builder.addDecision({
      questionId,
      subject: "business_authority.surface_precedence",
      owner: "business-domain-owner",
      rationale: "High-signal code paths reveal behavior but do not prove which surface is authoritative when frontend, backend, data, docs, and runtime disagree.",
      options: [
        "backend/domain service is authoritative",
        "database/configuration is authoritative",
        "external system contract is authoritative",
        "human process or policy document is authoritative",
        "case-by-case precedence is required",
      ],
      evidence: blocks
        .map((recordId) => builder.recordFor(recordId))
        .filter(Boolean)
        // Every ID in signalRecordIds was returned by addRecord, whose contract
        // always attaches at least one source-backed evidence item.
        .flatMap((record) => record.evidence)
        .slice(0, 10),
    });
    builder.addReflection({
      category: "pattern_confirmed",
      statement: `Discovery found ${signalRecordIds.length} high-signal source or configuration observation(s), so future runs should prioritize authority and precedence questions instead of asking broad exploratory questions.`,
      related_records: blocks,
      recommendation: "Use the question ledger to route only the highest-impact authority questions to humans.",
      status: "candidate",
    });
  }

  for (const signal of adapterSignals) {
    const firstPath = signal.matched_paths[0] ? path.join(resolvedRoot, signal.matched_paths[0]) : configPath || resolvedRoot;
    const id = builder.addRecord(
      "hypothesis",
      `Domain discovery adapter "${signal.label}" matched ${signal.matched_paths.length} path signal(s).`,
      firstPath,
      {
        subject: signal.id,
        predicate: "domain_adapter_signal",
        object: signal.label,
        confidence: signal.confidence,
        review_reason: "Domain adapters suggest investigation lenses only; they do not declare business truth.",
      }
    );
    builder.addPromotion(id, "question", `Review ${signal.label} probes before behavior-changing work.`);
    // detectAdapters returns the stable adapter contract, including arrays.
    for (const question of signal.questions) builder.addQuestion(question, "business-domain-owner", [id], { generated_from: "adapter" });
    builder.addReflection({
      category: "adapter_improvement",
      statement: `Adapter "${signal.label}" produced ${signal.probes.length} probe(s), ${signal.risks.length} risk(s), and ${signal.questions.length} question(s) from ${signal.matched_paths.length} matched path signal(s).`,
      evidence: builder.recordFor(id).evidence,
      related_records: [id],
      adapter_id: signal.id,
      recommendation: "Review answered questions and rejected probes after the run; promote durable adapter improvements only when repeated across repos.",
      status: "candidate",
    });
  }

  const coldStartBaseline = buildColdStartBaseline({
    files,
    repoNames,
    languageCounts,
    packageManagers,
    builder,
    adapterSignals,
    signalRecordIds,
    maxFiles: options.maxFiles,
  });
  if (recordsTruncated) {
    coldStartBaseline.inventory_coverage.gaps.push("A record cap was reached; record_cap hypothesis records state what was not emitted.");
  }

  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    project: {
      name: path.basename(resolvedRoot),
      scope: "existing-repo",
      repos: repoNames.length > 0 ? repoNames : ["root"],
    },
    // COORD-657: the machine-readable outcome of the untrusted-config boundary.
    // `status` is "declared" | "refused" | "absent"; a refusal carries a
    // classified code, a message naming the file, and operator remediation.
    // `surface` is the ONLY thing derived from an adopter configuration, and it
    // is a fixed projection — no other adopter-declared value reaches here.
    configuration_declaration: {
      status: declaration.status,
      path: declaration.path,
      code: declaration.code,
      message: declaration.message,
      remediation: declaration.remediation,
      executed: false,
      surface,
    },
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    generator: {
      name: "business-discovery",
      version: "0.1.0",
      command: "coord business-discovery --json",
    },
    sources: builder.sources,
    records: builder.records,
    relationships: builder.relationships,
    contradictions: [],
    questions: builder.questions,
    question_ledger: builder.questionLedger,
    decision_ledger: builder.decisionLedger,
    reflection_ledger: builder.reflectionLedger,
    promotion_candidates: builder.promotionCandidates,
    cold_start_baseline: coldStartBaseline,
    adapter_signals: adapterSignals.map((signal) => ({
      id: signal.id,
      label: signal.label,
      confidence: signal.confidence,
      matched_paths: signal.matched_paths,
      probes: signal.probes,
      risks: signal.risks,
      questions: signal.questions,
    })),
    summary: {
      files_scanned: files.length,
      records: builder.records.length,
      sources: builder.sources.length,
      questions: builder.questions.length,
      decisions: builder.decisionLedger.length,
      reflections: builder.reflectionLedger.length,
      promotion_candidates: builder.promotionCandidates.length,
      adapter_signals: adapterSignals.length,
      sparse_memory_baseline: coldStartBaseline.sparse_memory,
      package_managers: Array.from(packageManagers).sort(),
      languages: Object.fromEntries(Array.from(languageCounts.entries()).sort()),
      truncated: files.length >= (options.maxFiles || 2500) || recordsTruncated,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Business Discovery Run");
  lines.push("");
  lines.push(`Project: ${report.project.name}`);
  lines.push(`Files scanned: ${report.summary.files_scanned}`);
  lines.push(`Records: ${report.summary.records}`);
  lines.push(`Questions: ${report.summary.questions}`);
  lines.push("");
  lines.push("## Languages");
  for (const [language, count] of Object.entries(report.summary.languages)) lines.push(`- ${language}: ${count}`);
  if (Object.keys(report.summary.languages).length === 0) lines.push("None detected.");
  lines.push("");
  const declaration = report.configuration_declaration;
  if (declaration && declaration.status === "refused") {
    lines.push("## Configuration Declaration");
    lines.push(`- Status: refused (${declaration.code})`);
    lines.push(`- ${declaration.message}`);
    lines.push(`- Next step: ${declaration.remediation}`);
    lines.push("");
  }
  lines.push("## Records");
  for (const record of report.records.slice(0, 50)) lines.push(`- ${record.kind}: ${record.statement}`);
  if (report.records.length > 50) lines.push(`- ... ${report.records.length - 50} more`);
  return lines.join("\n");
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  const logError = deps.logError || ((line) => console.error(line));
  if (parsed.error) {
    log(`business-discovery: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: business-discovery [--dir <root>] [--json] [--output <path>] [--write-default] [--max-files <n>]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  let root = path.resolve(cwd, parsed.options.dir);
  let outputPath = null;
  let externalScan = false;
  if (parsed.options.output) {
    outputPath = path.resolve(cwd, parsed.options.output);
    try {
      const canonicalCwd = canonicalPath(cwd);
      root = canonicalPath(root);
      outputPath = canonicalPath(outputPath);
      externalScan = canonicalCwd !== root;
      if (externalScan && isPathInside(root, outputPath)) {
        // guard:discovery-output-boundary
        logError("business-discovery: Refused to write output inside the separately scanned root; choose a destination in the invoking workspace or elsewhere.");
        return { code: 1 };
      }
    } catch {
      logError("business-discovery: Refused output because its destination and scanned root could not be safely resolved.");
      return { code: 1 };
    }
  }
  const report = analyze(root, { maxFiles: parsed.options.maxFiles });
  const body = parsed.options.json || parsed.options.output ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (externalScan && isPathInside(root, outputPath)) {
      logError("business-discovery: Refused to write output inside the separately scanned root; choose a destination in the invoking workspace or elsewhere.");
      return { code: 1 };
    }
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  // COORD-657: fail closed and loudly. The artifact is still emitted (it is the
  // operator's evidence), but a configuration Concord refused to read without
  // executing it must never present as a clean run.
  //
  // The classified line goes to STDERR, never to stdout: under `--json` stdout
  // must remain exactly one parseable document, and the remediation already
  // travels inside `configuration_declaration`. In the human-readable lane the
  // refusal is also rendered into the body by renderMarkdown.
  const refusal = report.configuration_declaration;
  if (refusal && refusal.status === "refused") {
    logError(`business-discovery: ${refusal.code}: ${refusal.message} ${refusal.remediation}`);
    return { code: 1, report };
  }
  return { code: 0, report };
}

module.exports = {
  ARTIFACT_KIND,
  DEFAULT_OUTPUT,
  RECORD_LIMITS,
  analyze,
  classifyPath,
  parseArgs,
  renderMarkdown,
  run,
  main,
};

function main() {
  // Every return path of run() carries a numeric code.
  process.exit(run(process.argv.slice(2)).code);
}
if (require.main === module) main();
