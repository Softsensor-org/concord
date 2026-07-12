"use strict";

const path = require("node:path");

const DEFAULT_SECRET_PATHS = [/(^|\/)\.env(?:\.|$)/i, /(^|\/)\.ssh(\/|$)/i, /(^|\/)\.aws(\/|$)/i, /credentials?/i, /secrets?/i];
const SENSITIVE_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function evaluatePath(policy, candidate, mode = "read") {
  const normalized = path.resolve(candidate);
  const secretPatterns = policy.secret_paths || DEFAULT_SECRET_PATHS;
  if (secretPatterns.some((pattern) => pattern instanceof RegExp ? pattern.test(normalized) : normalized.includes(String(pattern)))) {
    return { decision: "deny", reason: "secret path", redacted_target: "[REDACTED_PATH]" };
  }
  if (mode === "write" && !inside(policy.worktree, normalized)) return { decision: "deny", reason: "write outside governed worktree" };
  if ((policy.protected_roots || []).some((root) => inside(root, normalized)) && !inside(policy.worktree, normalized)) {
    return { decision: "deny", reason: "protected product root" };
  }
  return { decision: "allow", reason: null };
}

function filterEnvironment(environment, allow = []) {
  const allowed = new Set(allow);
  const output = {};
  const removed = [];
  for (const [key, value] of Object.entries(environment || {})) {
    if (SENSITIVE_ENV.test(key) && !allowed.has(key)) removed.push(key);
    else output[key] = value;
  }
  return { environment: output, removed };
}

function evaluateNetwork(policy, target) {
  let url;
  try { url = new URL(target); } catch { return { decision: "deny", reason: "invalid network target" }; }
  const allow = new Set(policy.network_allow || []);
  return allow.has(url.hostname)
    ? { decision: "allow", reason: null }
    : { decision: "deny", reason: "network target not approved" };
}

function evaluateGit(policy, operation) {
  const verb = String(operation?.verb || "").toLowerCase();
  const branch = String(operation?.branch || "");
  const protectedBranches = new Set(policy.integration_branches || ["main", "master", "dev"]);
  if (["push", "merge", "rebase", "reset"].includes(verb) && protectedBranches.has(branch)) {
    return { decision: "deny", reason: "direct integration mutation" };
  }
  return { decision: "allow", reason: null };
}

module.exports = { DEFAULT_SECRET_PATHS, evaluateGit, evaluateNetwork, evaluatePath, filterEnvironment, inside };
