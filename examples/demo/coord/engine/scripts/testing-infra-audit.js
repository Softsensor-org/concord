"use strict";

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const { resolvePlanEvidence } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/plan-evidence-supersession.js"));
const TESTING_INFRA_DESCRIPTION_PATTERN = /\b(test(?:ing)? infrastructure|test[- ]lanes?|default\/full\/extended(?: gates?)?|architecture guards?|timing artifacts?|coverage thresholds?|vitest|msw|pre-push|hook flow|hook installer|gate automation|gate truthfulness|workspace alias resolver|automation contract)\b/i;

// COORD-283: the testing-infrastructure audit/classification helper cluster,
// extracted from lifecycle.js (lifecycle refactor #3, after COORD-281 and
// COORD-282) to keep the composition root under its arch monolith/size LOC
// budget. ONE cohesive boundary: the pure-ish helpers that decide whether a
// ticket touches testing infrastructure and the low-level reads that feed that
// decision — package-script extraction from gate commands, the
// classification-text builder, the testing-infra ticket classifier, audit-path
// normalization, and the two git-ref reads (commit-touched paths / json-from-ref)
// used to reconcile a ticket's declared vs actually-touched testing files.
//
// CRITICAL — this is a BEHAVIOR-PRESERVING move, NOT a rewrite. The six public
// functions (plus the two private helpers used ONLY by them —
// sanitizePackageScriptToken, isTestingInfrastructureClassificationPath) keep
// their exact logic. Everything external is INJECTED via the
// createTestingInfraAudit factory (NO `require()` of governance internals here):
//   - path/registry helpers : normalizePlanPathValue, repoPrefixesForCode,
//     escapeRegex, splitPlanPathValues, isTestingInfrastructureFilePath
//   - shell tokenizer        : tokenizeShellWords
//   - git-ref read           : gitTry
//   - value constants (by reference) : REPO_ROOTS, PNPM_BUILTIN_COMMANDS,
//     TESTING_INFRA_DESCRIPTION_PATTERN
//
// `buildTestingInfrastructureClassificationText` is genuinely PURE (no external
// refs) — it needs no deps. REPO_ROOTS is injected by reference so changes from
// the scoped governance test context are reflected at call time.
//
// lifecycle.js wires this factory (deferred `(...a)=>fn(...a)` wrappers for the
// function deps, by-reference for the value constants) and re-destructures the
// six returned functions back into its scope so the `commands` dispatch table
// and testing-infra audit/classification call sites
// (deriveTestingInfrastructureAudit, extractFileReferencesFromCommands) still
// resolve exactly as before the move.

module.exports = function createTestingInfraAudit(deps = {}) {
  const {
    normalizePlanPathValue,
    repoPrefixesForCode,
    escapeRegex,
    splitPlanPathValues,
    isTestingInfrastructureFilePath,
    tokenizeShellWords,
    gitTry,
    // value constants (injected by reference)
    REPO_ROOTS,
    PNPM_BUILTIN_COMMANDS,
    TESTING_INFRA_DESCRIPTION_PATTERN,
  } = deps;

  function normalizeTestingInfraAuditPath(repoCode, ticketId, value) {
    let normalized = normalizePlanPathValue(value);
    if (!normalized) {
      return null;
    }
    const repoPrefixes = repoPrefixesForCode(repoCode);
    if (repoPrefixes.length === 0) {
      return null;
    }
    for (const repoPrefix of repoPrefixes) {
      const worktreePrefixPattern = new RegExp(`^${escapeRegex(repoPrefix)}\\.worktrees\\/[^/]+\\/${escapeRegex(ticketId)}\\/`);
      if (worktreePrefixPattern.test(normalized)) {
        normalized = normalized.replace(worktreePrefixPattern, "");
        break;
      }
      if (normalized.startsWith(repoPrefix)) {
        normalized = normalized.slice(repoPrefix.length);
        break;
      }
    }
    normalized = normalized.replace(/^\.\/+/, "");
    const allRepoPrefixes = Object.keys(REPO_ROOTS).flatMap((code) => repoPrefixesForCode(code));
    if (
      !normalized ||
      normalized === "*" ||
      normalized.endsWith("/*") ||
      normalized.includes("*") ||
      allRepoPrefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      return null;
    }
    return normalized;
  }

  function isTestingInfrastructureClassificationPath(value) {
    const normalized = String(value).trim().replace(/\\/g, "/");
    if (normalized === "package.json" || normalized === "README.md") {
      return false;
    }
    return isTestingInfrastructureFilePath(normalized);
  }

  function buildTestingInfrastructureClassificationText(row, planState = null) {
    return [
      row?.ID || "",
      row?.Description || "",
      ...(planState?.change_summary || []),
    ].join(" ");
  }

  function listCommitTouchedPaths(repoRoot, commitSha) {
    const result = gitTry(repoRoot, ["show", "--pretty=format:", "--name-only", commitSha]);
    if (result.status !== 0) {
      return [];
    }
    return String(result.stdout || "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function sanitizePackageScriptToken(value) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    return normalized
      .replace(/^["']+|["']+$/g, "")
      .replace(/[,:;.)\]}>]+$/, "");
  }

  function extractPackageScriptsFromCommands(commands) {
    const scripts = new Set();
    for (const command of commands || []) {
      const tokens = tokenizeShellWords(command);
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token !== "pnpm" && token !== "npm" && token !== "yarn") {
          continue;
        }
        let cursor = index + 1;
        if (token === "pnpm") {
          while (cursor < tokens.length) {
            const current = tokens[cursor];
            if (current === "-C" || current === "--dir" || current === "--filter") {
              cursor += 2;
              continue;
            }
            if (
              current === "-r" ||
              current === "--recursive" ||
              current === "--workspace-root" ||
              current.startsWith("-C=") ||
              current.startsWith("--dir=") ||
              current.startsWith("--filter=")
            ) {
              cursor += 1;
              continue;
            }
            break;
          }
          const subcommand = tokens[cursor];
          if (!subcommand) {
            continue;
          }
          if (subcommand === "run") {
            const scriptName = sanitizePackageScriptToken(tokens[cursor + 1]);
            if (scriptName) {
              scripts.add(scriptName);
            }
            continue;
          }
          const scriptName = sanitizePackageScriptToken(subcommand);
          if (scriptName && !PNPM_BUILTIN_COMMANDS.has(scriptName)) {
            scripts.add(scriptName);
          }
          continue;
        }
        if (token === "npm") {
          while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
            cursor += 1;
          }
          if (tokens[cursor] === "run") {
            const scriptName = sanitizePackageScriptToken(tokens[cursor + 1]);
            if (scriptName) {
              scripts.add(scriptName);
            }
          }
          continue;
        }
        const yarnScript = sanitizePackageScriptToken(tokens[cursor]);
        if (yarnScript && !["install", "add", "remove", "dlx", "exec"].includes(yarnScript)) {
          scripts.add(yarnScript);
        }
      }
    }
    return [...scripts];
  }

  function readJsonFileFromRef(repoRoot, refName, filePath) {
    const result = gitTry(repoRoot, ["show", `${refName}:${filePath}`]);
    if (result.status !== 0) {
      return null;
    }
    try {
      return JSON.parse(String(result.stdout || ""));
    } catch (_error) {
      return null;
    }
  }

  function isTestingInfrastructureTicket(row, planState = null) {
    const text = buildTestingInfrastructureClassificationText(row, planState);
    if (/^QGATE-/.test(String(row?.ID || ""))) {
      return true;
    }
    if (TESTING_INFRA_DESCRIPTION_PATTERN.test(text)) {
      return true;
    }
    const plannedFiles = splitPlanPathValues(planState?.intended_files || [])
      .map((entry) => normalizeTestingInfraAuditPath(row?.Repo, row?.ID, entry))
      .filter(Boolean);
    return plannedFiles.some((entry) => isTestingInfrastructureClassificationPath(entry));
  }

  return {
    extractPackageScriptsFromCommands,
    buildTestingInfrastructureClassificationText,
    isTestingInfrastructureTicket,
    normalizeTestingInfraAuditPath,
    listCommitTouchedPaths,
    readJsonFileFromRef,
  };
};

module.exports.TESTING_INFRA_DESCRIPTION_PATTERN = TESTING_INFRA_DESCRIPTION_PATTERN;

module.exports.createTestingInfrastructureLandingAudit = function createTestingInfrastructureLandingAudit(deps = {}) {
  const {
    DEFAULT_INTEGRATION_BRANCH,
    REPO_INTEGRATION_BRANCHES,
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
    extractFileReferencesFromCommands,
    extractPackageScriptsFromCommands,
    getRepoRoot,
    gitPathExistsAtRef,
    isRepoBackedCode,
    isTestingInfrastructureFilePath,
    isTestingInfrastructureTicket,
    listCommitTouchedPaths,
    mergeUniqueRefs,
    normalizeTestingInfraAuditPath,
    readJsonFileFromRef,
    readPlanRecord,
    readPlanState,
    repoDisplayNameForCode,
    resolveCommitishInRepo,
    resolveLandingCommitSha,
    splitPlanPathValues,
  } = deps;
  return { deriveTestingInfrastructureAudit(ticketId, row, landing) {
    if (!landing || !isRepoBackedCode(row.Repo)) return null;
    const plan = readPlanRecord(ticketId, { allowMissing: true }) || readPlanState(ticketId);
    if (!isTestingInfrastructureTicket(row, plan)) return null;
    const repoRoot = getRepoRoot(row.Repo);
    const repoLabel = repoDisplayNameForCode(row.Repo);
    const baseRef = String(landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim();
    const commitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha) ||
      resolveLandingCommitSha(ticketId, row, landing.method || "manual", landing.evidence || [], [], { baseRef });
    if (!commitSha) throw new Error(`Ticket ${ticketId} testing-infrastructure audit could not resolve the landed commit SHA.`);

    const active = resolvePlanEvidence(plan || {});
    const commands = mergeUniqueRefs(active.repo_gates, active.verification_commands);
    const plannedFiles = splitPlanPathValues(plan?.intended_files || [])
      .map((entry) => normalizeTestingInfraAuditPath(row.Repo, ticketId, entry))
      .filter((entry) => entry && isTestingInfrastructureFilePath(entry));
    const commandFiles = extractFileReferencesFromCommands(ticketId, row, commands);
    const fallbackFiles = listCommitTouchedPaths(repoRoot, commitSha)
      .map((entry) => normalizeTestingInfraAuditPath(row.Repo, ticketId, entry))
      .filter((entry) => entry && isTestingInfrastructureFilePath(entry));
    const requiredFiles = [...new Set([...plannedFiles, ...commandFiles, ...fallbackFiles])].sort();
    const requiredScripts = [...new Set(extractPackageScriptsFromCommands(commands))].sort();
    if (requiredFiles.length === 0 && requiredScripts.length === 0) {
      throw new Error(`Ticket ${ticketId} is a testing-infrastructure ticket, but governance could not derive required files or scripts from its canonical plan record and landing commit.`);
    }

    const presentFiles = requiredFiles.filter((filePath) => gitPathExistsAtRef(repoRoot, baseRef, filePath));
    const missingFiles = requiredFiles.filter((filePath) => !presentFiles.includes(filePath));
    const packageJson = readJsonFileFromRef(repoRoot, baseRef, "package.json") || {};
    const scripts = packageJson && typeof packageJson.scripts === "object" && packageJson.scripts ? packageJson.scripts : {};
    const missingScripts = requiredScripts.filter((scriptName) => !Object.prototype.hasOwnProperty.call(scripts, scriptName));
    const evidence =
      `${TESTING_INFRA_LANDING_EVIDENCE_PREFIX} commit ${commitSha} is an ancestor of ${repoLabel}/${baseRef}; ` +
      `verified files at tip: ${presentFiles.length > 0 ? presentFiles.join(", ") : "none"}; ` +
      `legacy-missing files tolerated: ${missingFiles.length > 0 ? missingFiles.join(", ") : "none"}; ` +
      `required scripts at tip: ${requiredScripts.length > 0 ? requiredScripts.join(", ") : "none"}`;
    return { ticketId, repoLabel, baseRef, commitSha, requiredFiles, presentFiles, requiredScripts, missingFiles, missingScripts, evidence };
  } };
};
