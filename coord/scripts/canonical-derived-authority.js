"use strict";

const AUTHORITY_CLASSES = Object.freeze({
  AUTHORITY: "authority",
  COMPATIBILITY_VIEW: "compatibility_view",
  DERIVED_VIEW: "derived_rebuildable_view",
  EPHEMERAL_EVIDENCE: "ephemeral_evidence",
  GENERATED_INDEX: "generated_index",
  UNKNOWN: "unknown",
});

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function classifyCoordPath(value) {
  const file = normalizePath(value);
  if (!file) return { path: file, authority: AUTHORITY_CLASSES.UNKNOWN, reason: "empty path" };
  if (file === "coord/board/tasks.json") {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "canonical board row store" };
  }
  if (/^coord\/\.runtime\/plans\/[A-Z]+-\d+\.json$/.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "canonical runtime plan record" };
  }
  if (file === "coord/.runtime/governance-events.ndjson") {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "hash-chained governance journal" };
  }
  if (/^coord\/attestations\//.test(file) || /^coord\/\.runtime\/snapshots\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "signed/checkpointed governance snapshot" };
  }
  if (file === "coord/PLAN.md") {
    return { path: file, authority: AUTHORITY_CLASSES.COMPATIBILITY_VIEW, reason: "markdown compatibility view over plan records" };
  }
  if (/^coord\/rendered\//.test(file) || file === "coord/rendered/TASKS.md") {
    return { path: file, authority: AUTHORITY_CLASSES.DERIVED_VIEW, reason: "rebuildable rendered view" };
  }
  if (/^coord\/product\/context-packs\//.test(file) || /^coord\/\.runtime\/context-packs\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.DERIVED_VIEW, reason: "derived context pack; advisory until promoted" };
  }
  if (/^coord\/memory\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.GENERATED_INDEX, reason: "derived memory/index materialization" };
  }
  if (/^coord\/evidence\//.test(file) || /^coord\/\.runtime\/evidence\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.EPHEMERAL_EVIDENCE, reason: "receipt/evidence artifact, governed by citation and retention policy" };
  }
  if (/^coord\/gates\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "gate policy/configuration source" };
  }
  if (/^coord\/product\//.test(file) || /^coord\/docs\//.test(file)) {
    return { path: file, authority: AUTHORITY_CLASSES.AUTHORITY, reason: "authored product/governance documentation" };
  }
  return { path: file, authority: AUTHORITY_CLASSES.UNKNOWN, reason: "not classified by coord authority table" };
}

function checkAuthorityInversions(input = {}) {
  const issues = [];
  for (const file of input.canonicalInputs || []) {
    const classified = classifyCoordPath(file);
    if ([AUTHORITY_CLASSES.DERIVED_VIEW, AUTHORITY_CLASSES.GENERATED_INDEX, AUTHORITY_CLASSES.COMPATIBILITY_VIEW].includes(classified.authority)) {
      issues.push({
        code: "derived_used_as_canonical",
        severity: "error",
        path: classified.path,
        message: `${classified.path} is ${classified.authority} and must not be used as canonical mutation input.`,
      });
    }
  }
  for (const op of input.operations || []) {
    const kind = String(op.kind || "");
    const source = classifyCoordPath(op.source || op.read || "");
    const target = classifyCoordPath(op.target || op.write || "");
    if (kind === "read_write" && source.path && target.path && source.path === target.path && source.authority !== AUTHORITY_CLASSES.AUTHORITY) {
      issues.push({
        code: "read_path_writes_derived",
        severity: "error",
        path: source.path,
        message: `read path ${source.path} writes a non-authoritative artifact; use an explicit repair/promotion command instead.`,
      });
    }
    if (source.authority === AUTHORITY_CLASSES.COMPATIBILITY_VIEW && target.authority === AUTHORITY_CLASSES.AUTHORITY && kind !== "explicit_repair") {
      issues.push({
        code: "compat_overwrites_authority",
        severity: "error",
        path: `${source.path} -> ${target.path}`,
        message: "compatibility markdown must not overwrite richer canonical JSON except through explicit governed repair.",
      });
    }
  }
  for (const file of input.committedArtifacts || []) {
    const classified = classifyCoordPath(file);
    if (classified.authority === AUTHORITY_CLASSES.EPHEMERAL_EVIDENCE && !input.allowCommittedEvidence) {
      issues.push({
        code: "ephemeral_evidence_committed",
        severity: "warning",
        path: classified.path,
        message: `${classified.path} is ephemeral evidence; commit only when retention policy requires it.`,
      });
    }
  }
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function parseArgs(argv = []) {
  const options = { canonicalInputs: [], committedArtifacts: [], operations: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--canonical-input") options.canonicalInputs.push(argv[++index]);
    else if (arg === "--committed-artifact") options.committedArtifacts.push(argv[++index]);
    else if (arg === "--operation") {
      const raw = argv[++index];
      try {
        options.operations.push(JSON.parse(raw));
      } catch (error) {
        return { error: `--operation expects JSON: ${error.message}` };
      }
    } else if (!String(arg).startsWith("--")) {
      options.canonicalInputs.push(arg);
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => process.stdout.write(String(line)));
  if (parsed.error) {
    log(`authority-check: ${parsed.error}\n`);
    return { code: 1 };
  }
  const result = checkAuthorityInversions(parsed.options);
  if (parsed.options.json) {
    log(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.issues.length === 0) {
    log("authority-check ok\n");
  } else {
    for (const issue of result.issues) {
      log(`[${issue.severity}] ${issue.code}: ${issue.message}\n`);
    }
  }
  return { code: result.ok ? 0 : 1, result };
}

module.exports = {
  AUTHORITY_CLASSES,
  checkAuthorityInversions,
  classifyCoordPath,
  parseArgs,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
