"use strict";

const { normalizePath } = require("./lifecycle-utils.js");

const AUTHORITY_CLASSES = Object.freeze({
  AUTHORITY: "authority",
  COMPATIBILITY_VIEW: "compatibility_view",
  DERIVED_VIEW: "derived_rebuildable_view",
  EPHEMERAL_EVIDENCE: "ephemeral_evidence",
  GENERATED_INDEX: "generated_index",
  UNKNOWN: "unknown",
});

// One registry owns both classification and integrity projections. Paths enter
// through the configured seam; the checker never treats a view as authority.
const MATERIALIZED_VIEWS = Object.freeze([
  { path: "coord/PLAN.md", authority: AUTHORITY_CLASSES.COMPATIBILITY_VIEW, projection: "plans", key: "PLAN_PATH" },
  { path: "coord/rendered", authority: AUTHORITY_CLASSES.DERIVED_VIEW, projection: "tables", key: "RENDERED_DIR", directory: true },
  { path: "coord/product/context-packs", authority: AUTHORITY_CLASSES.DERIVED_VIEW, projection: "context", directory: true },
  { path: "coord/.runtime/context-packs", authority: AUTHORITY_CLASSES.DERIVED_VIEW, projection: "context", directory: true, runtime: true },
]);

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
  const view = MATERIALIZED_VIEWS.find((entry) => file === entry.path ||
    (entry.directory && file.startsWith(`${entry.path}/`)));
  if (view) return { path: file, authority: view.authority, reason: "registered rebuildable materialized view" };
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

function visibleMarkdownText(text) {
  let fence = null;
  let comment = false;
  return text.split(/\r?\n/).map((line) => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      return "";
    }
    // Comment delimiters inside fenced examples are literal, and fences inside
    // comments cannot begin an example. Preserve columns around hidden text so
    // deleting a comment cannot turn its suffix into a generated block header.
    const match = !comment && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match && (match[1][0] === "~" || !match[2].includes("`"))) {
      fence = match[1];
      return "";
    }
    let visible = "", offset = 0;
    while (offset < line.length) {
      if (comment) {
        const closing = line.indexOf("-->", offset);
        const end = closing < 0 ? line.length : closing + 3;
        visible += " ".repeat(end - offset);
        offset = end;
        comment = closing < 0;
      } else {
        const opening = line.indexOf("<!--", offset);
        if (opening < 0) { visible += line.slice(offset); break; }
        visible += line.slice(offset, opening);
        offset = opening;
        comment = true;
      }
    }
    return visible;
  }).join("\n");
}

function inspectMaterializedViews({ coordDir, paths, board }) {
  const fs = require("node:fs");
  const path = require("node:path");
  const rows = (board.sections || []).flatMap((section) => section.rows || []);
  const issues = [];
  const report = (file, missing, code = "derived_view_missing_records") => {
    issues.push({ code, severity: "error", path: file, missing,
      message: code === "derived_view_unverifiable"
        ? `${file}: cannot verify materialization without ${missing.join(", ")}; register its projection contract before accepting it.`
        : `${file}: required canonical records missing from materialized view: ${missing.join(", ")}. Regenerate from its canonical source, inspect the restored content, then use approved reconciliation.` });
  };
  const planIds = () => {
    const statuses = board.metadata?.plan_markdown_render_statuses;
    const allowed = new Set(Array.isArray(statuses) && statuses.length ? statuses : ["doing", "review"]);
    // Runtime records take precedence over the legacy compatibility store,
    // matching the projector. Unplanned backlog and unknown/orphan records
    // are not part of its projection (canonical validation owns the latter).
    return rows.filter((row) => allowed.has(String(row.Status).startsWith("doing (blocked:") ? "doing" : row.Status))
      .filter((row) => [paths.PLAN_RECORDS_DIR, paths.LEGACY_PLAN_RECORDS_DIR].filter(Boolean)
        .some((dir) => fs.existsSync(path.join(dir, `${row.ID}.json`))))
      .map((row) => row.ID);
  };
  const views = MATERIALIZED_VIEWS.filter((view) =>
    [AUTHORITY_CLASSES.DERIVED_VIEW, AUTHORITY_CLASSES.COMPATIBILITY_VIEW].includes(view.authority));
  for (const view of views) {
    const location = view.key ? paths[view.key] : view.runtime
      ? path.join(paths.RUNTIME_DIR, "context-packs") : path.join(coordDir, view.path.slice("coord/".length));
    if (!location) throw new Error(`Missing configured location for ${view.path}.`);
    const present = fs.existsSync(location);
    if (!present && view.projection === "context") continue;
    const listed = present && view.directory ? fs.readdirSync(location).filter((name) => !name.startsWith(".")) : [];
    const entries = view.projection === "tables" ? [...new Set(["TASKS.md", "PROMPT_INDEX.md", ...listed])]
      : view.directory ? listed : [null];
    for (const entry of entries) {
      const diskPath = entry === null ? location : path.join(location, entry);
      const label = entry === null ? view.path : `${view.path}/${entry}`;
      const exists = fs.existsSync(diskPath);
      if (exists && !fs.statSync(diskPath).isFile()) {
        report(label, ["regular materialized file"], "derived_view_unverifiable");
        continue;
      }
      const text = exists ? fs.readFileSync(diskPath, "utf8") : "";
      let expected, actual;
      if (view.projection === "plans") {
        expected = planIds();
        const blocks = visibleMarkdownText(text).split(/^## /m).slice(1);
        actual = new Set(blocks.flatMap((block) => {
          const match = /^([A-Z]+-\d+) — [^\n]+\n([\s\S]*)$/.exec(block);
          return match && match[2].trim() ? [match[1]] : [];
        }));
      } else if (view.projection === "tables" && ["TASKS.md", "PROMPT_INDEX.md"].includes(entry)) {
        expected = entry === "TASKS.md" ? rows.map((row) => row.ID) : Object.keys(board.prompt_index || {});
        actual = new Set([...visibleMarkdownText(text).matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gm)].map((match) => match[1]));
      } else if (view.projection === "context" && /^[A-Z]+-\d+\.(json|md)$/.test(entry)) {
        const id = entry.replace(/\.(json|md)$/, "");
        // The generator accepts a requested ticket scope even before a board
        // row exists; its envelope must still identify that requested scope.
        expected = [id];
        if (entry.endsWith(".json")) {
          try { actual = new Set([JSON.parse(text).ticket]); }
          catch { actual = new Set(); }
        } else {
          actual = new Set([...visibleMarkdownText(text).matchAll(/^# Business Context Pack: ([A-Z]+-\d+)$/gm)].map((match) => match[1]));
        }
      } else {
        // New materializations require an explicit projection contract; silently
        // treating an unknown format as healthy would reopen the same blind spot.
        report(label, ["registered projection contract"], "derived_view_unverifiable");
        continue;
      }
      const missing = [...new Set(expected)].filter((id) => !actual.has(id)).sort();
      if (missing.length) report(label, missing);
    }
  }
  return issues;
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
  inspectMaterializedViews,
  checkAuthorityInversions,
  classifyCoordPath,
  parseArgs,
  run,
};

function main() {
  const result = run(process.argv.slice(2));
  // Every run path returns a numeric code; do not mask a broken contract with
  // a fallback that the public command cannot reach.
  process.exitCode = result.code;
}

if (require.main === module) main();
module.exports.main = main;
