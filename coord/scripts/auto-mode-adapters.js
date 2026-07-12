"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateAction, validatePolicy } = require("./auto-mode-policy.js");

const PROVIDERS = Object.freeze({
  claude: {
    settings: [".claude/settings.json", ".claude/settings.local.json"],
    observable: ["command", "read", "write"],
    enforceable: ["command", "read", "write"],
    unmanaged: ["network"],
  },
  codex: {
    settings: [".codex/config.toml"],
    observable: ["command", "read", "write", "network"],
    enforceable: ["command", "read", "write", "network"],
    unmanaged: [],
  },
});

function probeProvider(provider, root, options = {}) {
  const definition = PROVIDERS[provider];
  if (!definition) return { provider, coverage: "unmanaged", supported: false, reason: "unknown provider" };
  const exists = options.exists || fs.existsSync;
  const settings = definition.settings.filter((entry) => exists(path.join(root, entry)));
  const declared = options.declaredCapabilities || [];
  const unsupported = declared.filter((capability) => !definition.enforceable.includes(capability));
  const coverage = settings.length === 0 ? "unmanaged" : unsupported.length > 0 || definition.unmanaged.length > 0 ? "partial" : "complete";
  return {
    provider,
    supported: settings.length > 0,
    coverage,
    settings,
    observable: [...definition.observable],
    enforceable: [...definition.enforceable],
    unmanaged: Array.from(new Set([...definition.unmanaged, ...unsupported])),
  };
}

function enforceAction(policy, action, probe) {
  const policyResult = validatePolicy(policy);
  const actionResult = validateAction(action);
  if (!policyResult.ok || !actionResult.ok) {
    return { decision: "deny", reason: [...policyResult.errors, ...actionResult.errors].join("; "), coverage: probe?.coverage || "unmanaged" };
  }
  if (!probe?.supported || !probe.enforceable.includes(action.kind)) {
    return { decision: "deny", reason: `provider cannot prove enforcement for ${action.kind}`, coverage: probe?.coverage || "unmanaged" };
  }
  if (policy.digest !== action.policy_digest) {
    return { decision: "deny", reason: "policy digest mismatch", coverage: probe.coverage };
  }
  return { decision: action.decision, reason: action.reason || null, coverage: probe.coverage };
}

module.exports = { PROVIDERS, enforceAction, probeProvider };
