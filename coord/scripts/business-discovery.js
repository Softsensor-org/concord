#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const domainAdapters = require("./domain-discovery-adapters.js");
const evidenceAuthority = require("./evidence-authority.js");

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

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function hasText(value) {
  return String(value || "").trim().length > 0;
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

function readProjectConfig(root) {
  const configPath = path.join(root, "coord/project.config.js");
  if (!fs.existsSync(configPath)) return { config: null, path: null };
  try {
    delete require.cache[require.resolve(configPath)];
    return { config: require(configPath), path: configPath };
  } catch {
    return { config: null, path: configPath };
  }
}

function createBuilder(root) {
  const sources = [];
  const sourceByPath = new Map();
  const records = [];
  const relationships = [];
  const questions = [];
  const questionLedger = [];
  const decisionLedger = [];
  const reflectionLedger = [];
  const promotionCandidates = [];

  function sourceFor(filePath, authority = "implementation") {
    const relativePath = rel(root, filePath);
    const key = `${relativePath}:${authority}`;
    if (sourceByPath.has(key)) return sourceByPath.get(key);
    const id = `SRC-${String(sources.length + 1).padStart(4, "0")}`;
    sourceByPath.set(key, id);
    const classification = evidenceAuthority.classifySource({ authority, visibility: "internal" });
    sources.push({
      id,
      type: "file",
      path: relativePath,
      uri: relativePath,
      commit: null,
      line_start: null,
      line_end: null,
      event_hash: null,
      chain_head: null,
      source_hash: null,
      authority,
      freshness: classification.freshness,
      sensitivity: classification.sensitivity,
      visibility: "internal",
    });
    return id;
  }

  function addRecord(kind, statement, filePath, extra = {}) {
    const id = `BD-REC-${String(records.length + 1).padStart(6, "0")}`;
    const sourceId = filePath ? sourceFor(filePath, extra.authority || "implementation") : sourceFor(root, "runtime_observation");
    const source = sources.find((candidate) => candidate.id === sourceId);
    const record = {
      id,
      kind,
      subject: extra.subject || null,
      predicate: extra.predicate || null,
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
    record.authority = evidenceAuthority.classifyRecordAuthority(record, source ? [source] : []);
    record.confidence = record.authority.confidence;
    record.computed_confidence = record.authority.computed_confidence;
    record.confidence_score = record.authority.confidence_score;
    record.confidence_inputs = record.authority.confidence_inputs;
    records.push(record);
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
    addQuestion,
    addDecision,
    addReflection,
    addPromotion,
  };
}

function classifyPath(relativePath) {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  const parts = lower.split("/");
  const tags = [];
  if (PACKAGE_FILES.has(path.basename(relativePath))) tags.push({ kind: "configuration_surface", label: `package manager: ${PACKAGE_FILES.get(path.basename(relativePath))}` });
  if (lower.includes("migration") || lower.includes("migrations") || base.includes("schema") || lower.endsWith(".sql") || lower.endsWith(".prisma")) tags.push({ kind: "data_dependency", label: "schema, migration, or ORM model" });
  if (parts.some((part) => ["routes", "api", "controllers", "handlers", "endpoints"].includes(part))) tags.push({ kind: "integration_contract", label: "backend API/service route surface" });
  if (parts.some((part) => ["jobs", "workers", "tasks", "cron"].includes(part))) tags.push({ kind: "workflow", label: "background job or scheduled workflow" });
  if (parts.some((part) => ["pages", "screens", "components", "app"].includes(part)) && /\.(jsx|tsx|vue|svelte|html)$/.test(lower)) tags.push({ kind: "ux_behavior", label: "frontend route, screen, or component surface" });
  if (parts.some((part) => ["tests", "__tests__", "fixtures", "spec"].includes(part)) || /\.(test|spec)\.[jt]sx?$/.test(lower)) tags.push({ kind: "fact", label: "test or fixture evidence" });
  if (parts.some((part) => ["config", "configs"].includes(part)) || ["dockerfile", ".env.example"].includes(base) || /\.(ya?ml|toml|ini)$/.test(lower)) tags.push({ kind: "configuration_surface", label: "configuration or feature-flag surface" });
  if (parts.some((part) => ["docs", "doc"].includes(part)) || lower.endsWith(".md")) tags.push({ kind: "fact", label: "documentation source" });
  if (/(import|export|report|reports|csv|xlsx|adapter|connector)/.test(lower)) tags.push({ kind: "integration_contract", label: "import, export, report, or adapter surface" });
  return tags;
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
  const { config, path: configPath } = readProjectConfig(resolvedRoot);
  const files = walk(resolvedRoot, { maxFiles: options.maxFiles });
  const builder = createBuilder(resolvedRoot);
  const repoNames = [];

  if (configPath) {
    const configRecord = builder.addRecord(
      "configuration_surface",
      "Concord project config declares repo layout and governance tracks.",
      configPath,
      { subject: "coord/project.config.js", predicate: "declares", object: "repo layout", confidence: config ? "observed" : "unknown" }
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
      evidence: builder.records.find((record) => record.id === configRecord)?.evidence || [],
    });
  }

  for (const [code, repo] of Object.entries(config?.repos || {})) {
    const repoPath = path.resolve(resolvedRoot, repo.path || "");
    repoNames.push(code);
    builder.addRecord(
      "business_object",
      `Configured repo ${code} points to ${repo.path || "(missing path)"} and ${fs.existsSync(repoPath) ? "exists" : "is not present"} in this checkout.`,
      configPath || resolvedRoot,
      { subject: code, predicate: "repo_path", object: repo.path || null, confidence: fs.existsSync(repoPath) ? "observed" : "unknown", review_reason: "Configured repo paths are setup facts, not business intent." }
    );
  }

  const languageCounts = new Map();
  const packageManagers = new Set();
  const signalRecordIds = [];
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

    for (const tag of classifyPath(relativePath)) {
      const id = builder.addRecord(
        tag.kind,
        `Discovered ${tag.label} at ${relativePath}.`,
        filePath,
        {
          subject: relativePath,
          predicate: "path_classification",
          object: tag.label,
          confidence: "observed",
          review_reason: "Path-based discovery is a signal; inspect source before promoting.",
        }
      );
      signalRecordIds.push(id);
      if (["data_dependency", "integration_contract", "workflow", "ux_behavior"].includes(tag.kind)) {
        builder.addPromotion(id, "question", "High-signal path should be reviewed for business meaning before implementation changes.");
      }
    }
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
        .map((recordId) => builder.records.find((record) => record.id === recordId))
        .filter(Boolean)
        .flatMap((record) => record.evidence || [])
        .slice(0, 10),
    });
    builder.addReflection({
      category: "pattern_confirmed",
      statement: `Discovery found ${signalRecordIds.length} high-signal path classification(s), so future runs should prioritize authority and precedence questions instead of asking broad exploratory questions.`,
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
    for (const question of signal.questions || []) builder.addQuestion(question, "business-domain-owner", [id], { generated_from: "adapter" });
    builder.addReflection({
      category: "adapter_improvement",
      statement: `Adapter "${signal.label}" produced ${signal.probes.length} probe(s), ${signal.risks.length} risk(s), and ${signal.questions.length} question(s) from ${signal.matched_paths.length} matched path signal(s).`,
      evidence: builder.records.find((record) => record.id === id)?.evidence || [],
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

  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    project: {
      name: path.basename(resolvedRoot),
      scope: "existing-repo",
      repos: repoNames.length > 0 ? repoNames : ["root"],
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
      truncated: files.length >= (options.maxFiles || 2500),
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
  lines.push("## Records");
  for (const record of report.records.slice(0, 50)) lines.push(`- ${record.kind}: ${record.statement}`);
  if (report.records.length > 50) lines.push(`- ... ${report.records.length - 50} more`);
  return lines.join("\n");
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`business-discovery: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: business-discovery [--dir <root>] [--json] [--output <path>] [--write-default] [--max-files <n>]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const report = analyze(root, { maxFiles: parsed.options.maxFiles });
  const body = parsed.options.json || parsed.options.output ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, report };
}

module.exports = {
  ARTIFACT_KIND,
  DEFAULT_OUTPUT,
  analyze,
  classifyPath,
  parseArgs,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
