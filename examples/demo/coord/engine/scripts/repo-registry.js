"use strict";

// B2 decomposition slice: repo-code resolution extracted from lifecycle.js.
// Maps board repo codes (B/F/X/...) to roots, names, prefixes, CLI aliases,
// and integration branches, all derived from coord/project.config.js through
// coord/paths.js. Factory-injected so the one board-dependent resolver
// (resolveRepoCodeForTicket) can read canonical board state.
//
// COORD-486: the repo maps are a SCOPED context. `deps.context` defaults to
// the live DEFAULT_PATHS (which the governance test context scopes in place),
// but a test can pass its
// own { repoRoots, repoIntegrationBranches, repoRegistry, legacyRepoAliases,
// ticketPrefixToRepoCode } and get a registry that neither reads nor mutates
// process-global path state. All five maps are required.

const fs = require("fs");
const path = require("path");
const { DEFAULT_PATHS, GovernanceError } = require("./governance-context.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../../paths.js");

module.exports = function createRepoRegistry(deps = {}) {
  const { readBoard, getTicketRef, context = DEFAULT_PATHS } = deps;

  function fail(message) {
    throw new GovernanceError(message);
  }

  function repoPrefixForCode(repoCode) {
    // Returns the canonical repo-directory prefix for a given board repo code,
    // derived from coord/project.config.js through coord/paths.js (e.g.
    // "backend/" for "B" in the template; "msrv/" for "B" in acme-ops).
    // "X" is reserved for coord-only work and always maps to "coord/". Returns
    // null for unknown codes. Exported via __testing so tests can construct
    // fixtures that respect the active registry instead of hardcoding a
    // specific repo name (GOV-015).
    if (repoCode === "X") {
      return "coord/";
    }
    const repoName = context.repoRegistry[repoCode];
    if (!repoName) {
      return null;
    }
    const normalized = String(repoName).trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    return normalized ? `${normalized}/` : null;
  }

  function repoPrefixesForCode(repoCode) {
    // Returns the canonical prefix plus any project-level legacy aliases from
    // coord/project.config.js. Used by path normalization to
    // accept historical proof paths after a repo rename — e.g. acme-ops can map
    // B to "msrv/" while still recognizing legacy "backend/..." plan-record
    // entries authored before the rename.
    const prefixes = [];
    const addPrefix = (prefix) => {
      if (prefix && !prefixes.includes(prefix)) {
        prefixes.push(prefix);
      }
    };
    addPrefix(repoPrefixForCode(repoCode));
    const aliases = context.legacyRepoAliases[repoCode] || [];
    for (const alias of aliases) {
      const normalized = String(alias || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
      if (normalized) {
        addPrefix(`${normalized}/`);
      }
    }
    return prefixes;
  }

  function resolveRepoIntegrationBranch(repoCode) {
    return context.repoIntegrationBranches[repoCode] || DEFAULT_INTEGRATION_BRANCH;
  }

  function inferRepoCodeFromTicketId(ticketId) {
    // Map a foreign ticket id (e.g. "FE-123", "MSRV-7") to a board repo code
    // using the per-repo `ticketPrefixes` configured in project.config.js.
    // Unconfigured templates contribute no prefixes, so inference falls back
    // to "X" (coord/cross-repo) — preserving prior behavior for any id that
    // is not a configured product-repo prefix.
    const normalized = String(ticketId || "").trim().toUpperCase();
    const dashIndex = normalized.indexOf("-");
    if (dashIndex > 0) {
      const prefix = normalized.slice(0, dashIndex);
      const code = context.ticketPrefixToRepoCode[prefix];
      if (code) {
        return code;
      }
    }
    return "X";
  }

  function resolveRepoCodeForTicket(ticketId, row = null) {
    if (row && typeof row.Repo === "string" && row.Repo.trim()) {
      return row.Repo.trim();
    }
    try {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (ref?.row?.Repo && typeof ref.row.Repo === "string" && ref.row.Repo.trim()) {
        return ref.row.Repo.trim();
      }
    } catch (_) {
      // Fall back to the ticket-id heuristic when canonical board context is unavailable.
    }
    return inferRepoCodeFromTicketId(ticketId);
  }

  function getRepoRoot(repoCode) {
    const repoRoot = context.repoRoots[repoCode];
    if (!repoRoot) {
      fail(`Unsupported repo code "${repoCode}".`);
    }
    if (!fs.existsSync(repoRoot)) {
      fail(
        `Repo root for code "${repoCode}" does not exist at ${repoRoot}. ` +
        `Update coord/project.config.js if your repo directories have different names.`
      );
    }
    return repoRoot;
  }

  function isRepoBackedCode(repoCode) {
    return Boolean(repoCode && repoCode !== "X" && context.repoRoots[repoCode]);
  }

  function isProductRepo(rowOrRepoCode) {
    const repoCode = typeof rowOrRepoCode === "string" ? rowOrRepoCode : rowOrRepoCode?.Repo;
    return isRepoBackedCode(repoCode);
  }

  function repoNameForCode(repoCode) {
    if (repoCode === "X") {
      return "coord";
    }
    if (!isRepoBackedCode(repoCode)) {
      return String(repoCode || "unknown");
    }
    return context.repoRegistry[repoCode] || path.basename(getRepoRoot(repoCode));
  }

  function repoDisplayNameForCode(repoCode) {
    return repoNameForCode(repoCode);
  }

  function repoCodeForLockRepoName(repoName) {
    const normalized = String(repoName || "").trim();
    if (!normalized || normalized === "coord") {
      return "X";
    }
    for (const [repoCode, repoRoot] of Object.entries(context.repoRoots)) {
      if (repoCode === "X") {
        continue;
      }
      const configuredName = context.repoRegistry[repoCode];
      const legacyAliases = context.legacyRepoAliases[repoCode] || [];
      if (
        normalized === configuredName ||
        normalized === repoRoot ||
        path.basename(repoRoot) === normalized ||
        legacyAliases.includes(normalized)
      ) {
        return repoCode;
      }
    }
    return null;
  }

  function repoCliAliasesForCode(repoCode) {
    if (!isRepoBackedCode(repoCode)) {
      return [];
    }
    const aliases = new Set([repoCode]);
    const configuredName = context.repoRegistry[repoCode];
    if (configuredName) {
      aliases.add(configuredName);
    }
    // isRepoBackedCode above guarantees the root is configured.
    const repoRoot = context.repoRoots[repoCode];
    aliases.add(repoRoot);
    aliases.add(path.basename(repoRoot));
    for (const alias of context.legacyRepoAliases[repoCode] || []) {
      aliases.add(alias);
    }
    return [...aliases].filter(Boolean).sort();
  }

  function repoCodeForCliRepoArg(repoArg) {
    const normalized = String(repoArg || "").trim();
    if (!normalized) {
      return null;
    }
    if (/^[A-Z]$/.test(normalized) && isRepoBackedCode(normalized)) {
      return normalized;
    }
    return repoCodeForLockRepoName(normalized);
  }

  function configuredRepoArgDescription() {
    const choices = new Set();
    for (const repoCode of Object.keys(context.repoRoots).filter((code) => code !== "X").sort()) {
      for (const alias of repoCliAliasesForCode(repoCode)) {
        choices.add(alias);
      }
    }
    return [...choices].sort().join(", ");
  }

  return {
    repoPrefixForCode,
    repoPrefixesForCode,
    resolveRepoIntegrationBranch,
    inferRepoCodeFromTicketId,
    resolveRepoCodeForTicket,
    getRepoRoot,
    isRepoBackedCode,
    isProductRepo,
    repoNameForCode,
    repoDisplayNameForCode,
    repoCodeForLockRepoName,
    repoCliAliasesForCode,
    repoCodeForCliRepoArg,
    configuredRepoArgDescription,
  };
};
