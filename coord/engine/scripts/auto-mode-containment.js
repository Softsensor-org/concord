"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SECRET_PATHS = [
  /(^|\/)\.env(?:\.|$)/i, /(^|\/)\.ssh(\/|$)/i, /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.kube\/config$/i, /(^|\/)\.docker\/config\.json$/i, /(^|\/)\.npmrc$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i, /\.(?:pem|key)$/i,
  /credentials?/i, /secrets?/i,
];

// Resolve the closest existing ancestor so prospective files are checked through
// symlinked directories. Broken symlinks and inaccessible ancestors fail closed.
function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
      continue;
    }
    return path.join(fs.realpathSync(current), ...missing.reverse());
  }
}

function inside(root, candidate) {
  try {
    const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function evaluatePath(policy, candidate, mode = "read") {
  const normalized = path.resolve(candidate);
  let canonical;
  // guard:auto-mode-containment
  try { canonical = canonicalPath(candidate); } catch { return { decision: "deny", reason: "path cannot be resolved" }; }
  const secretPatterns = policy.secret_paths || DEFAULT_SECRET_PATHS;
  const secret = (target) => secretPatterns.some((pattern) => pattern instanceof RegExp ? pattern.test(target) : target.includes(String(pattern)));
  if (secret(normalized) || secret(canonical)) {
    return { decision: "deny", reason: "secret path", redacted_target: "[REDACTED_PATH]" };
  }
  if (mode === "write" && !inside(policy.worktree, candidate)) return { decision: "deny", reason: "write outside governed worktree" };
  if ((policy.protected_roots || []).some((root) => inside(root, candidate)) && !inside(policy.worktree, candidate)) {
    return { decision: "deny", reason: "protected product root" };
  }
  return { decision: "allow", reason: null };
}

function filterEnvironment(environment, allow = []) {
  const allowed = new Set(allow);
  const output = {};
  const removed = [];
  for (const [key, value] of Object.entries(environment || {})) {
    if (allowed.has(key)) output[key] = value;
    else removed.push(key);
  }
  return { environment: output, removed };
}

function evaluateNetwork(policy, target) {
  let url;
  try { url = new URL(target); } catch { return { decision: "deny", reason: "invalid network target" }; }
  const allow = new Set((policy.network_allow || []).map((host) => String(host).toLowerCase()));
  return url.protocol === "https:" && (!url.port || url.port === "443") && !url.username && !url.password && allow.has(url.hostname)
    ? { decision: "allow", reason: null }
    : { decision: "deny", reason: "network target not approved" };
}

function evaluateGit(policy, operation) {
  const verb = String(operation?.verb || "").toLowerCase();
  const branch = String(operation?.branch || "").trim();
  const protectedBranches = new Set(policy.integration_branches || ["main", "master", "dev"]);
  const normalized = branch.replace(/^refs\/(?:heads|remotes)\//, "").replace(/^[^/]+\//, "");
  if (["push", "merge", "rebase", "reset"].includes(verb) && (!branch || /^HEAD(?:$|[~^@])/.test(branch) || protectedBranches.has(normalized))) {
    return { decision: "deny", reason: "direct integration mutation" };
  }
  return { decision: "allow", reason: null };
}

module.exports = { DEFAULT_SECRET_PATHS, evaluateGit, evaluateNetwork, evaluatePath, filterEnvironment, inside };
