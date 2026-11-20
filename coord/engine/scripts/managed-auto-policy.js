"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { evaluateGit, evaluateNetwork, evaluatePath, filterEnvironment } = require("./auto-mode-containment.js");
const { DEFAULT_DENIED_PATTERNS, evaluateSensitivePath } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/sensitive-path-policy.js"));
const { canonicalJson } = require("./auto-mode-policy.js");

const DESTRUCTIVE = /^(?:rm|rmdir|del|format|mkfs|kill|pkill|shutdown|reboot|git\s+(?:reset|clean|push|merge|rebase)|(?:npm|pnpm|yarn)\s+publish|docker\s+(?:push|rm|system\s+prune)|kubectl\s+(?:delete|apply)|terraform\s+(?:apply|destroy))\b/i;
const REMOTE = /(?:push|merge|release|deploy|publish|production|cloud|delete|destroy)/i;
// COORD-860 (ADR-0017 amendment): the digest is deep-canonical over the full
// declared policy, excluding only its own derived digest field, so a nested
// scope change (network allowlist, secret references, limits) changes it.
function policyDigest(value) {
  const { digest, ...body } = value || {};
  // The JSON round trip matches the persisted form (undefined members vanish).
  return crypto.createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(body)))).digest("hex");
}

// Declared secret references: bounded identifiers and purpose classes only.
function secretReferences(list) {
  return (list || []).map((entry) => ({ ref: String(entry.ref), purposes: [...(entry.purposes || [])].map(String).sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function createManagedAutoPolicy(input = {}) {
  const worktree = path.resolve(String(input.worktree || ""));
  if (!worktree || worktree === path.parse(worktree).root) throw new TypeError("an approved worktree is required");
  const controls = input.controls || {};
  const provider = input.provider || {};
  const enforceable = provider.enforceable || [];
  const supported = provider.supported === true && controls.hooks === true && controls.sandbox === true && controls.environment === true;
  const coverage = supported ? "complete" : provider.supported ? "partial" : "unmanaged";
  const body = {
    schema: "coord.auto-mode.managed-policy/v1",
    ticket: String(input.ticket || ""), session: String(input.session || ""), owner: String(input.owner || ""),
    provider: String(provider.name || input.provider_name || ""), adapter_version: String(provider.version || ""),
    worktree, base_sha: String(input.base_sha || ""),
    read_roots: [worktree], write_roots: [worktree], denied_paths: input.denied_paths || DEFAULT_DENIED_PATTERNS.map(String),
    command_classes: ["source", "test", "lint", "build", "git-local", "governance-submit"],
    child_process_egress: input.network_allow?.length ? "allowlisted" : "deny",
    network_allow: [...(input.network_allow || [])], provider_control_plane: input.provider_control_plane || { separate: true },
    secret_reference_policy: { mode: "broker-only", raw_credentials: "never-agent-visible" },
    secret_references: secretReferences(input.secret_references),
    broker_capabilities: [...(input.broker_capabilities || [])].map(String).sort(),
    // ADR-0017 amendment section 6: declared broker targets per capability.
    broker_targets: (input.broker_targets || []).map((entry) => ({ capability: String(entry.capability), target: String(entry.target) }))
      .sort((a, b) => `${a.capability}\u0000${a.target}`.localeCompare(`${b.capability}\u0000${b.target}`)),
    git_remote_actions: { mode: "broker-only", direct_push: "deny" },
    approval_boundaries: { expansion: "approval_required", remote_side_effect: "broker-only" },
    limits: input.limits || { max_duration_ms: 30 * 60 * 1000 }, evidence_coverage: coverage,
    label: supported && enforceable.length ? "managed-auto" : undefined,
    controls: { ...controls },
  };
  if (!body.ticket || !body.session || !body.owner || !body.provider || !body.adapter_version || !body.base_sha) throw new TypeError("ticket, session, owner, provider, adapter version, and base SHA are required");
  return { ...body, digest: policyDigest(body) };
}

function evaluateCommand(policy, command) {
  const value = String(command || "").trim();
  if (!value) return { decision: "deny", reason: "empty command" };
  if (DESTRUCTIVE.test(value) || REMOTE.test(value) || /(?:git\s+(?:config|credential)|\b(?:curl|wget|ssh|scp|nc|netcat)\b|(?:^|\s)(?:sudo|su)\b|(?:^|\s)(?:>|>>)\s*|\b(?:kill|pkill)\b)/i.test(value)) return { decision: "deny", reason: "destructive or remote operation" };
  return { decision: "allow", reason: null };
}

function evaluateManagedAction(policy, action = {}) {
  // guard:auto-mode-containment
  if (!policy || policy.evidence_coverage === "unmanaged") return { decision: "deny", reason: "containment unavailable" };
  if (action.kind === "command") return evaluateCommand(policy, action.command);
  if (["read", "write"].includes(action.kind)) {
    const pathResult = evaluateSensitivePath(action.path, { worktree: policy.worktree, sensitiveRoots: policy.sensitive_roots, patterns: policy.denied_paths });
    if (pathResult.decision !== "allow") return pathResult;
    // evaluateSensitivePath already denies any path outside the worktree.
    return evaluatePath(policy, action.path, action.kind);
  }
  if (action.kind === "network") return evaluateNetwork(policy, action.target);
  if (action.kind === "git") return evaluateGit(policy, action);
  return { decision: "deny", reason: "unsupported action" };
}

function sanitizeEnvironment(environment, allowlist = []) { return filterEnvironment(environment, allowlist); }

module.exports = { createManagedAutoPolicy, createPolicy: createManagedAutoPolicy, evaluateCommand, evaluateManagedAction, enforceAction: evaluateManagedAction, policyDigest, sanitizeEnvironment };
