"use strict";

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
// refs) — it needs no deps. REPO_ROOTS is injected by reference so the live
// `__testing.paths` registry mutations (and the facade's REPO_ROOTS setter,
// which mutates the same object in place) are reflected at call time exactly as
// before the move.
//
// lifecycle.js wires this factory (deferred `(...a)=>fn(...a)` wrappers for the
// function deps, by-reference for the value constants) and re-destructures the
// six returned functions back into its scope so the `commands` dispatch table,
// the `__testing` facade, and the testing-infra audit/classification call sites
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
    const normalized = String(value || "").trim().replace(/\\/g, "/");
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
