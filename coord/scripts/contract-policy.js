"use strict";

// COORD-082 (CONTRACT-002): CI-safe, path-independent API-contract policy.
//
// This module is the SINGLE SOURCE OF TRUTH for the template's contract
// generate/check policy: how a frontend repo RESOLVES the backend's OpenAPI
// artifact (config-driven, NOT a hardcoded sibling path), how it GENERATES a
// deterministic client/types stub from that artifact, and how `contract:check`
// decides whether the committed generated client is STALE relative to the
// source contract.
//
// The downstream problem this fixes: web had a hardcoded `contract:gen` path to
// `../<api-repo>/openapi.json`, which breaks in CI / whenever the repo layout
// differs. Here the source is resolved through `coord/project.config.js`
// (`repos.<F>.contract`) + the existing repo-registry path resolution
// (paths.js `repoRoots`), so it works regardless of absolute layout / in CI.
//
// Boundary: this module is pure policy + deterministic codegen + diff. It does
// NOT run a gate, touch the board, or write the generated client itself unless
// asked through the CLI (`gen`). The frontend `scripts/contract.js` shells the
// CLI; the gate (`frontend/scripts/gate.sh`) shells `contract:check` on the
// full/ci lanes and degrades gracefully. It mirrors audit-policy.js /
// coverage-policy.js (single-source the policy once, in Node, rather than
// re-typing it in bash on every repo).

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config resolution (the path-independence core)
// ---------------------------------------------------------------------------

// Validate the optional `contract` block on a repo config entry. Returns the
// block (or null when absent). Backward-compatible: an absent block is valid
// (most repos have no contract relationship). Throws on a malformed block.
//
//   contract: {
//     sourceRepo:    "B",                          // repo code whose OpenAPI artifact is the source of truth
//     sourcePath:    "contract/openapi.json",      // path to the OpenAPI artifact, relative to sourceRepo root
//     generatedPath: "src/generated/api-client.js" // committed generated client, relative to THIS repo root
//   }
function validateContractConfig(repoCode, entry) {
  const block = entry && entry.contract;
  if (block === undefined || block === null) return null;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`project.config.js: repos.${repoCode}.contract must be an object when provided`);
  }
  for (const key of ["sourceRepo", "sourcePath", "generatedPath"]) {
    if (typeof block[key] !== "string" || block[key].trim() === "") {
      throw new Error(
        `project.config.js: repos.${repoCode}.contract.${key} must be a non-empty string when contract is provided`
      );
    }
  }
  if (!/^[A-Z]$/.test(block.sourceRepo)) {
    throw new Error(
      `project.config.js: repos.${repoCode}.contract.sourceRepo "${block.sourceRepo}" must be a single uppercase repo code`
    );
  }
  return block;
}

// Resolve the absolute OpenAPI source path + the absolute committed generated
// client path for a repo, THROUGH coord's config + repo-registry path resolution
// (paths.repoRoots) rather than any hardcoded sibling/absolute path.
//
// `paths` is a createCoordPaths() result (or anything exposing `repoRoots` +
// `projectConfig`). `repoCode` is the consuming (frontend) repo.
//
// Returns null when the repo has no contract block. Otherwise returns
// { sourceRepo, sourceAbs, generatedAbs, config } — both paths absolute and
// layout-independent (they are joined onto repoRoots[...], so they resolve the
// same in CI or any checkout location).
function resolveContractPaths(paths, repoCode) {
  if (!paths || typeof paths !== "object") {
    throw new Error("resolveContractPaths requires a coord paths object");
  }
  const cfg = paths.projectConfig;
  const entry = cfg && cfg.repos && cfg.repos[repoCode];
  if (!entry) return null;
  const block = validateContractConfig(repoCode, entry);
  if (!block) return null;

  const repoRoot = paths.repoRoots && paths.repoRoots[repoCode];
  const sourceRoot = paths.repoRoots && paths.repoRoots[block.sourceRepo];
  if (!repoRoot) {
    throw new Error(`contract: repo code "${repoCode}" has no resolved root in paths.repoRoots`);
  }
  if (!sourceRoot) {
    throw new Error(
      `contract: contract.sourceRepo "${block.sourceRepo}" (for repo ${repoCode}) has no resolved root in paths.repoRoots`
    );
  }
  return {
    repoCode,
    sourceRepo: block.sourceRepo,
    sourceAbs: path.isAbsolute(block.sourcePath)
      ? block.sourcePath
      : path.join(sourceRoot, block.sourcePath),
    generatedAbs: path.isAbsolute(block.generatedPath)
      ? block.generatedPath
      : path.join(repoRoot, block.generatedPath),
    config: block,
  };
}

// ---------------------------------------------------------------------------
// Deterministic codegen
// ---------------------------------------------------------------------------

// A deliberately tiny, dependency-FREE OpenAPI -> JS client generator. Real
// projects swap this for openapi-typescript / orval / openapi-generator; what
// matters for the template is that generation is DETERMINISTIC (same contract
// in => byte-identical client out) so `contract:check` can diff regenerated
// output against the committed client to detect staleness. Generates one
// thin fetch wrapper per (method, path) keyed on operationId, plus a banner
// carrying the contract title/version so a contract bump is visible in the diff.
function generateClient(openapi) {
  if (!openapi || typeof openapi !== "object") {
    throw new Error("contract: OpenAPI document must be an object");
  }
  const info = openapi.info && typeof openapi.info === "object" ? openapi.info : {};
  const title = String(info.title || "API");
  const version = String(info.version || "0.0.0");
  const paths = openapi.paths && typeof openapi.paths === "object" ? openapi.paths : {};

  const ops = [];
  const httpMethods = ["get", "put", "post", "delete", "patch", "head", "options"];
  for (const route of Object.keys(paths).sort()) {
    const item = paths[route] || {};
    for (const method of httpMethods) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const opId =
        typeof op.operationId === "string" && op.operationId.trim()
          ? op.operationId.trim()
          : `${method}${route.replace(/[^a-zA-Z0-9]+/g, "_")}`;
      ops.push({ opId, method: method.toUpperCase(), route });
    }
  }
  ops.sort((a, b) => a.opId.localeCompare(b.opId));

  const lines = [];
  lines.push("// @generated by coord contract:gen — DO NOT EDIT BY HAND.");
  lines.push(`// Source contract: ${title} v${version}`);
  lines.push("// Regenerate with: npm run contract:gen");
  lines.push('"use strict";');
  lines.push("");
  lines.push("function createClient(baseUrl, fetchImpl) {");
  lines.push("  const _fetch = fetchImpl || (typeof fetch !== \"undefined\" ? fetch : null);");
  lines.push("  const base = String(baseUrl || \"\").replace(/\\/$/, \"\");");
  lines.push("  return {");
  for (const op of ops) {
    lines.push(`    // ${op.method} ${op.route}`);
    lines.push(`    ${op.opId}(options) {`);
    lines.push(`      return _fetch(base + ${JSON.stringify(op.route)}, Object.assign({ method: ${JSON.stringify(op.method)} }, options || {}));`);
    lines.push("    },");
  }
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push("module.exports = { createClient };");
  lines.push("");
  return lines.join("\n");
}

// Read + parse an OpenAPI artifact from disk. Throws a clear error if missing
// or unparseable (callers that want graceful-skip check existsSync first).
function readOpenApi(sourceAbs) {
  const raw = fs.readFileSync(sourceAbs, "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Check (staleness gate)
// ---------------------------------------------------------------------------

// Decide whether the committed generated client is current with the source
// contract. Returns one of:
//   { result: "skip", reason }                — no contract config / no source artifact
//   { result: "pass" }                        — regenerated output == committed client
//   { result: "fail", reason, generatedExists } — drift (stale) or missing committed client
//
// Pure: does NOT write anything. The frontend `contract:gen` (CLI) is what
// refreshes the committed client; this only diffs.
function checkContract(resolved) {
  if (!resolved) {
    return { result: "skip", reason: "no contract config for this repo" };
  }
  if (!fs.existsSync(resolved.sourceAbs)) {
    return {
      result: "skip",
      reason: `no OpenAPI source artifact at ${resolved.sourceAbs}`,
    };
  }
  let expected;
  try {
    expected = generateClient(readOpenApi(resolved.sourceAbs));
  } catch (err) {
    return { result: "fail", reason: `could not generate from source contract: ${err.message}` };
  }
  if (!fs.existsSync(resolved.generatedAbs)) {
    return {
      result: "fail",
      reason: `generated client missing at ${resolved.generatedAbs} (run contract:gen)`,
      generatedExists: false,
    };
  }
  const committed = fs.readFileSync(resolved.generatedAbs, "utf8");
  if (committed === expected) {
    return { result: "pass", generatedExists: true };
  }
  return {
    result: "fail",
    reason: "committed generated client is STALE vs source contract (run contract:gen)",
    generatedExists: true,
  };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
//   "contract: pass (src=B/contract/openapi.json -> src/generated/api-client.js)"
//   "contract: fail STALE ..."
//   "contract: skip no OpenAPI source artifact ..."
function formatContractSummary(check, resolved) {
  if (!check) return "contract: skip (no result)";
  if (check.result === "skip") {
    return `contract: skip ${check.reason}`;
  }
  const where = resolved
    ? ` (src=${resolved.sourceRepo}:${relForLog(resolved.sourceAbs)} -> ${relForLog(resolved.generatedAbs)})`
    : "";
  if (check.result === "pass") {
    return `contract: pass${where}`;
  }
  return `contract: fail ${check.reason}${where}`;
}

function relForLog(abs) {
  // Keep the summary stable/readable regardless of checkout location: show only
  // the last 3 path segments rather than the full absolute path.
  const parts = String(abs).split(path.sep).filter(Boolean);
  return parts.slice(-3).join("/");
}

// ---------------------------------------------------------------------------
// CLI: node contract-policy.js <gen|check> [--repo F]
// ---------------------------------------------------------------------------
// Exit codes: 0 pass/skip, 1 fail (stale/missing client), 2 usage error.
function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const sub = argv[0];
  if (sub !== "gen" && sub !== "check") {
    err.write("usage: contract-policy.js <gen|check> [--repo <CODE>]\n");
    return 2;
  }
  let repoCode = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) {
      repoCode = argv[i + 1];
      i += 1;
    }
  }

  // Resolve coord paths the same way the rest of the engine does.
  const createCoordPaths = deps.createCoordPaths || require("../paths.js").createCoordPaths;
  const paths = deps.paths || createCoordPaths();

  // Default the consuming repo to the only repo that declares a contract block.
  if (!repoCode) {
    const cfg = paths.projectConfig || {};
    const withContract = Object.entries(cfg.repos || {}).filter(([, e]) => e && e.contract);
    if (withContract.length === 1) {
      repoCode = withContract[0][0];
    } else if (withContract.length === 0) {
      out.write("contract: skip (no repo declares a contract block in project.config.js)\n");
      return 0;
    } else {
      err.write("contract: ERROR multiple repos declare a contract block; pass --repo <CODE>\n");
      return 2;
    }
  }

  let resolved;
  try {
    resolved = resolveContractPaths(paths, repoCode);
  } catch (e) {
    err.write(`contract: ERROR ${e.message}\n`);
    return 2;
  }

  if (sub === "gen") {
    if (!resolved) {
      out.write(`contract: skip (repo ${repoCode} has no contract block)\n`);
      return 0;
    }
    if (!fs.existsSync(resolved.sourceAbs)) {
      out.write(`contract: skip (no OpenAPI source artifact at ${relForLog(resolved.sourceAbs)})\n`);
      return 0;
    }
    let client;
    try {
      client = generateClient(readOpenApi(resolved.sourceAbs));
    } catch (e) {
      err.write(`contract: ERROR could not generate client: ${e.message}\n`);
      return 1;
    }
    fs.mkdirSync(path.dirname(resolved.generatedAbs), { recursive: true });
    fs.writeFileSync(resolved.generatedAbs, client);
    out.write(`contract: generated ${relForLog(resolved.generatedAbs)} from ${resolved.sourceRepo}:${relForLog(resolved.sourceAbs)}\n`);
    return 0;
  }

  // sub === "check"
  const check = checkContract(resolved);
  out.write(formatContractSummary(check, resolved) + "\n");
  return check.result === "fail" ? 1 : 0;
}

module.exports = {
  validateContractConfig,
  resolveContractPaths,
  generateClient,
  readOpenApi,
  checkContract,
  formatContractSummary,
  runCli,
};

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {});
}
