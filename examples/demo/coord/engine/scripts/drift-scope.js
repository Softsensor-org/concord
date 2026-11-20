"use strict";

// COORD-862 (COORD-516a): one partition for every drift detector.
//
// Three detectors report changed paths: the journal snapshot seal, the git
// status guard and doctor. Before this module each listed raw paths, so an
// operator facing "403 dirty paths" could not tell an engine hand-edit from
// ordinary uncommitted project work. Every path now lands in exactly one scope:
//
//   engine   - engine-managed surface (the COORD-607 discovery rule: the
//              engine-managed roots minus recorded exclusions, plus the
//              curated extras, or an explicit manifest set). Remedy: restore
//              it, or re-pin after an intentional engine change.
//   governed - project-owned authority and authored content: board, plan
//              records, prompts, decisions, QUESTIONS, docs, gates, evidence,
//              and any path outside coord/. Remedy: commit it, or reconcile it
//              with human-admin approval.
//   derived  - rebuildable views (rendered/, PLAN.md, context packs, memory
//              indexes). Remedy: regenerate with `gov sync`.
//   runtime  - session, lock, thread and other local runtime state. Remedy:
//              `gov recover` / `gov reconcile --reason`.
//
// Classification reuses classifyCoordPath (canonical-derived-authority.js) and
// isProjectOwnedPath (project-owned-state.js); it adds no second authority
// table. "Project" in operator messages means every non-engine scope.
//
// Authored content (prompts and decisions) is the only class the committed-
// state policy (ADR 0020) may adopt from HEAD; see isAuthoredContentPath.

const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");

const COORD_DIR = path.join(__dirname, "..", "..");
const discovery = require(resolveEngineModule(COORD_DIR, "scripts/template-sync-discovery.js"));
const { classifyCoordPath, AUTHORITY_CLASSES } = require(resolveEngineModule(COORD_DIR, "scripts/canonical-derived-authority.js"));

// project-owned-state.js is donor tooling shared by the installer and release
// builder; it is not part of the installed engine surface, so an installed
// workspace may not have it. Ownership is diagnostic only here (it never
// changes a scope), so its absence reports `project_owned: null`.
function loadProjectOwnership(coordDir) {
  const modulePath = path.join(coordDir, "project-owned-state.js");
  if (!fs.existsSync(modulePath)) return () => null;
  return require(modulePath).isProjectOwnedPath;
}
const isProjectOwned = loadProjectOwnership(COORD_DIR);

const DRIFT_SCOPES = Object.freeze({
  ENGINE: "engine",
  GOVERNED: "governed",
  DERIVED: "derived",
  RUNTIME: "runtime",
});
const SCOPE_ORDER = Object.freeze([DRIFT_SCOPES.ENGINE, DRIFT_SCOPES.GOVERNED, DRIFT_SCOPES.DERIVED, DRIFT_SCOPES.RUNTIME]);

const SCOPE_REMEDIES = Object.freeze({
  engine: "restore the engine file, or after an intentional engine change re-pin with `coord/scripts/gov verify-engine --pin`",
  governed: "commit project files, re-apply board, plan or QUESTIONS changes through a governed verb, or accept them with `gov reconcile --scope governed` and human-admin approval (a prompt or ADR committed on the integration branch is adopted automatically, ADR 0020)",
  derived: "regenerate it with `coord/scripts/gov sync`",
  runtime: "repair it with `coord/scripts/gov recover <ticket-id>` or `gov reconcile --scope runtime --reason \"<why>\"`",
});

// Authored-content roots: the only classes the committed-state policy may
// adopt from HEAD. The board, plan records, PLAN.md and QUESTIONS.md are never
// authored content and stay journal-only.
const AUTHORED_CONTENT_ROOTS = Object.freeze(["coord/prompts", "coord/docs/decisions"]);

const RUNTIME_FILES = new Set(["coord/agents.json", "coord/agent_sessions.json"]);
const RUNTIME_ROOTS = ["coord/locks", "coord/.worktrees"];

function normalizeRepoPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function under(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

function isAuthoredContentPath(value) {
  const file = normalizeRepoPath(value);
  return AUTHORED_CONTENT_ROOTS.some((root) => under(file, root));
}

function isRuleEngineManagedPath(file) {
  if (discovery.CURATED_ENGINE_EXTRAS.includes(file)) return true;
  if (!discovery.isUnderRoots(file)) return false;
  if (discovery.classifyExclusion(file)) return false;
  return !file.split("/").some((segment) => discovery.SKIP_DIRS.has(segment));
}

// `enginePaths`, when supplied, is the authoritative engine set (for example
// the TEMPLATE_SYNC_MANIFEST items); the discovery rule is the fallback.
function isEnginePath(file, enginePaths) {
  if (enginePaths && enginePaths.has(file)) return true;
  return isRuleEngineManagedPath(file);
}

function classifyDriftScope(value, options = {}) {
  const file = normalizeRepoPath(value);
  const authority = classifyCoordPath(file).authority;
  const base = { path: file, authority, project_owned: isProjectOwned(file), authored: isAuthoredContentPath(file) };
  if (!file) return { ...base, scope: DRIFT_SCOPES.GOVERNED, reason: "empty path" };
  if (isEnginePath(file, options.enginePaths)) {
    return { ...base, scope: DRIFT_SCOPES.ENGINE, reason: "engine-managed surface" };
  }
  if (under(file, "coord/.runtime")) {
    if (authority === AUTHORITY_CLASSES.AUTHORITY && !under(file, "coord/.runtime/snapshots")) {
      return { ...base, scope: DRIFT_SCOPES.GOVERNED, reason: "canonical runtime authority record" };
    }
    if (authority === AUTHORITY_CLASSES.DERIVED_VIEW) {
      return { ...base, scope: DRIFT_SCOPES.DERIVED, reason: "rebuildable runtime view" };
    }
    return { ...base, scope: DRIFT_SCOPES.RUNTIME, reason: "local runtime state" };
  }
  if (RUNTIME_FILES.has(file) || RUNTIME_ROOTS.some((root) => under(file, root)) || /\.lock$/.test(file)) {
    return { ...base, scope: DRIFT_SCOPES.RUNTIME, reason: "session or lock state" };
  }
  if ([AUTHORITY_CLASSES.DERIVED_VIEW, AUTHORITY_CLASSES.COMPATIBILITY_VIEW, AUTHORITY_CLASSES.GENERATED_INDEX].includes(authority)) {
    return { ...base, scope: DRIFT_SCOPES.DERIVED, reason: "rebuildable materialized view" };
  }
  if (!under(file, "coord")) {
    return { ...base, scope: DRIFT_SCOPES.GOVERNED, reason: "project content outside the control plane" };
  }
  return { ...base, scope: DRIFT_SCOPES.GOVERNED, reason: "project-owned control-plane content" };
}

function emptyPartition() {
  return { engine: [], governed: [], derived: [], runtime: [] };
}

function partitionDriftPaths(paths, options = {}) {
  const partition = emptyPartition();
  const classify = typeof options.classify === "function"
    ? options.classify
    : (entry) => classifyDriftScope(entry, options).scope;
  for (const entry of [...new Set(paths.map(normalizeRepoPath).filter(Boolean))].sort()) {
    partition[classify(entry)].push(entry);
  }
  return partition;
}

function projectPathCount(partition) {
  return partition.governed.length + partition.derived.length + partition.runtime.length;
}

function listPaths(paths, limit) {
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")} and ${paths.length - limit} more`;
}

// One verdict line: "engine intact, 403 project paths uncommitted" or
// "engine drift on 1 path: coord/scripts/x.js; 2 project paths uncommitted".
function summarizeDriftScopes(partition, options = {}) {
  const verb = options.verb || "uncommitted";
  const limit = options.limit || 10;
  const project = projectPathCount(partition);
  const engine = partition.engine.length === 0
    ? "engine intact"
    : `engine drift on ${partition.engine.length} path${partition.engine.length === 1 ? "" : "s"}: ${listPaths(partition.engine, limit)}`;
  const projectText = `${project} project path${project === 1 ? "" : "s"} ${verb}`;
  const breakdown = project === 0
    ? ""
    : ` (${SCOPE_ORDER.slice(1).filter((scope) => partition[scope].length).map((scope) => `${scope} ${partition[scope].length}`).join(", ")})`;
  return `${engine}, ${projectText}${breakdown}`;
}

function formatScopeRemedies(partition) {
  return SCOPE_ORDER.filter((scope) => partition[scope].length > 0)
    .map((scope) => `${scope}: ${SCOPE_REMEDIES[scope]}`)
    .join("; ");
}

function loadEngineManifestPaths(repoRoot) {
  try {
    const manifestPath = path.join(repoRoot, "coord", "TEMPLATE_SYNC_MANIFEST.json");
    const items = JSON.parse(fs.readFileSync(manifestPath, "utf8")).items;
    return new Set((Array.isArray(items) ? items : []).map((item) => Object(item).path).filter((entry) => typeof entry === "string"));
  } catch {
    return null;
  }
}

module.exports = {
  DRIFT_SCOPES,
  SCOPE_ORDER,
  SCOPE_REMEDIES,
  AUTHORED_CONTENT_ROOTS,
  normalizeRepoPath,
  isAuthoredContentPath,
  classifyDriftScope,
  partitionDriftPaths,
  projectPathCount,
  summarizeDriftScopes,
  formatScopeRemedies,
  loadEngineManifestPaths,
  loadProjectOwnership,
};
