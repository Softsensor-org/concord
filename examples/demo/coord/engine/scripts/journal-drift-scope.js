"use strict";

// COORD-862 (COORD-516a): the journal side of scoped drift verdicts and of the
// ADR 0020 committed-state policy. journal.js only wires this module in; it
// keeps the seal, the snapshot format and the event append.
//
// Journal drift paths are coord-relative and may sit in redirected test
// sandboxes, so the LIVE configured surfaces classify first and the shared
// drift-scope partition classifies everything else. The governed snapshot
// never covers engine files.

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");

const COORD_DIR = path.join(__dirname, "..", "..");
const driftScope = require(resolveEngineModule(COORD_DIR, "scripts/drift-scope.js"));
const { planCommittedStateAdoption } = require(resolveEngineModule(COORD_DIR, "scripts/committed-state-adoption.js"));

function defaultGitRun(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  // A spawn failure (no git, missing cwd) leaves status null and no output.
  return { status: result.status, stdout: result.stdout || "" };
}

function within(value, specs) {
  return specs.some((spec) => value === spec || value.startsWith(`${spec}/`));
}

// Only `state` and `relativeCoordPath` are needed to classify; the remaining
// collaborators serve committed-state adoption.
module.exports = function createJournalDriftScope(deps) {
  const {
    state, relativeCoordPath, collectGovernedSnapshotFilePaths, readLatestGovernanceSnapshotSource,
    appendGovernanceEvent, detectGovernanceProvenanceDrift, sha1, rootDir, detectCheckoutRuntimeRole,
    integrationBranch, gitRun = defaultGitRun,
  } = deps;
  const rel = (entries) => entries.filter(Boolean).map(relativeCoordPath);

  function journalDriftScope(relativePath) {
    const value = String(relativePath || "");
    if (within(value, rel([state.AGENTS_PATH, state.AGENT_SESSIONS_PATH, state.LOCKS_DIR, state.LEGACY_LOCKS_DIR]))) {
      return driftScope.DRIFT_SCOPES.RUNTIME;
    }
    if (within(value, rel([state.PLAN_PATH, state.RENDERED_DIR]))) return driftScope.DRIFT_SCOPES.DERIVED;
    // Governed roots win over the `.lock` suffix: a prompt named `x.lock` is authored content.
    if (within(value, rel([state.BOARD_PATH, state.QUESTIONS_PATH, state.PLAN_RECORDS_DIR, state.PROMPTS_DIR, state.DECISIONS_DIR]))) {
      return driftScope.DRIFT_SCOPES.GOVERNED;
    }
    if (/\.lock$/.test(value)) return driftScope.DRIFT_SCOPES.RUNTIME;
    return driftScope.classifyDriftScope(`coord/${value}`).scope;
  }

  function partitionJournalDrift(paths) {
    return driftScope.partitionDriftPaths(paths, { classify: journalDriftScope });
  }

  function isAuthoredDriftPath(relativePath) {
    return within(String(relativePath || ""), rel([state.PROMPTS_DIR, state.DECISIONS_DIR]));
  }

  // The role marker belongs to the checkout that holds the files: the live
  // engine checkout uses the configured marker, any other checkout its own.
  function detectRole(checkoutRoot) {
    const markerPath = path.resolve(checkoutRoot) === path.resolve(rootDir)
      ? state.RUNTIME_ROLE_MARKER_PATH
      : path.join(checkoutRoot, "coord", ".runtime", "runtime-role.json");
    return detectCheckoutRuntimeRole({ rootDir: checkoutRoot, markerPath }).role;
  }

  // Which drifted authored paths qualify for adoption. Reads Git and the
  // filesystem only; null when there is no authored drift to consider.
  function planCommittedAuthoredAdoption(provenance) {
    if (!provenance || provenance.uninitialized || provenance.snapshotPruned) return null;
    const keys = (provenance.drift || []).filter(isAuthoredDriftPath);
    if (keys.length === 0) return null;
    const absoluteByKey = new Map(collectGovernedSnapshotFilePaths().map((filePath) => [relativeCoordPath(filePath), filePath]));
    return planCommittedStateAdoption({
      candidates: keys.map((key) => ({ key, absolute: absoluteByKey.get(key) || null })),
      gitRun, integrationBranch, detectRole,
      // The journal snapshot digests a file's UTF-8 text; digest the exact bytes
      // that were verified against HEAD the same way.
      contentDigest: (bytes) => sha1(bytes.toString("utf8")),
    });
  }

  // Adopt exactly the qualifying paths, recording the digest of the bytes that
  // were verified against HEAD (not a separately sampled read). The baseline
  // keeps every other entry of the last journaled snapshot, so all remaining
  // drift, including any edit made after verification, stays detectable.
  function adoptCommittedAuthoredDrift(provenance, metadata = {}) {
    const plan = planCommittedAuthoredAdoption(provenance);
    const baseline = plan && plan.adopted.length > 0 ? readLatestGovernanceSnapshotSource().snapshot : null;
    if (!baseline) return provenance;
    const adopted = new Set(plan.adopted);
    const files = baseline.files.filter((entry) => !adopted.has(entry.path))
      .concat(plan.adopted.map((key) => ({ path: key, exists: true, digest: plan.digests[key] })))
      .sort((left, right) => left.path.localeCompare(right.path));
    appendGovernanceEvent({
      ts: new Date().toISOString(),
      command: "journal-baseline",
      ticket: metadata.ticket || null,
      before_status: null,
      after_status: null,
      identity: null,
      details: {
        reason: "committed-state-adoption",
        policy: "ADR-0020",
        trigger_command: metadata.command || null,
        commit: plan.commit,
        integration_branch: plan.integration_branch,
        paths: plan.adopted,
        repo_paths: plan.repo_paths,
      },
      changed_paths: plan.adopted,
      snapshot: { recorded_at: new Date().toISOString(), digest: sha1(JSON.stringify(files)), files },
    });
    return detectGovernanceProvenanceDrift();
  }

  // Why remaining authored drift was not adopted; Git is consulted only when
  // the out-of-band set holds authored content.
  function explainCommittedState(provenance, paths) {
    return paths.some(isAuthoredDriftPath) ? planCommittedAuthoredAdoption({ ...provenance, drift: paths }) : null;
  }

  // The scoped sentences the out-of-band refusal inserts after its path list.
  function formatOutOfBandScopeText(report) {
    const paths = report.paths || [];
    if (paths.length === 0) return "";
    const scopes = report.scopes || partitionJournalDrift(paths);
    const notes = [`Scope: ${driftScope.summarizeDriftScopes(scopes, { verb: "unjournaled" })}. Remedy by scope: ${driftScope.formatScopeRemedies(scopes)}.`];
    const journalOnly = paths.filter((entry) => !isAuthoredDriftPath(entry));
    if (journalOnly.length > 0) {
      notes.push(`Journal-only under ADR 0020 (committing them does not reconcile them): ${journalOnly.join(", ")}.`);
    }
    const plan = report.committedState;
    if (plan && plan.rejected.length > 0) {
      const reasons = plan.rejected.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
      // guard:seal-journal-drift
      notes.push(`Committed-state adoption (ADR 0020) declined: ${reasons}${plan.refusal ? `; ${plan.refusal.message}` : ""}. ` +
        "Authored content is adopted only when it is committed at a HEAD the integration branch contains, in the canonical tree.");
    }
    return `${notes.join(" ")} `;
  }

  return {
    journalDriftScope,
    partitionJournalDrift,
    isAuthoredDriftPath,
    planCommittedAuthoredAdoption,
    adoptCommittedAuthoredDrift,
    explainCommittedState,
    formatOutOfBandScopeText,
  };
};

module.exports.defaultGitRun = defaultGitRun;
