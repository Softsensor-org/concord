"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EVENT_SCHEMA_VERSION, validateAction, validatePolicy } = require("./auto-mode-policy.js");

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
  const missingControls = options.requireManagedAuto
    ? [!options.providerVersion && "provider version", !options.hooks && "hooks", !options.sandbox && "sandbox"].filter(Boolean)
    : [];
  const coverage = settings.length === 0 ? "unmanaged" : unsupported.length > 0 || definition.unmanaged.length > 0 || missingControls.length > 0 ? "partial" : "complete";
  return {
    provider,
    supported: settings.length > 0,
    coverage,
    settings,
    observable: [...definition.observable],
    enforceable: [...definition.enforceable],
    unmanaged: Array.from(new Set([...definition.unmanaged, ...unsupported])),
    provider_version: options.providerVersion || null,
    controls: { hooks: !!options.hooks, sandbox: !!options.sandbox },
    managed_auto_label: coverage === "complete" && missingControls.length === 0,
  };
}

function canLabelManagedAuto(probe) {
  return !!probe && probe.coverage === "complete" && probe.supported && probe.managed_auto_label === true && !!probe.provider_version && probe.controls?.hooks === true && probe.controls?.sandbox === true;
}

function normalizeEvent(provider, raw = {}, context = {}) {
  const kind = String(raw.kind || raw.type || "command").toLowerCase();
  const classMap = { command: "shell", shell: "shell", read: "file", write: "file", edit: "file", mcp: "mcp", governance: "governance", remote: "remote_side_effect", network: "remote_side_effect" };
  const status = ["attempted", "allowed", "denied", "completed", "failed", "interrupted"].includes(raw.status) ? raw.status : "attempted";
  const resource = String(raw.resource || raw.path || raw.command || "provider-action").replace(/^[/\\]+/, "");
  const summary = String(raw.redacted_summary || raw.summary || raw.command || kind).replace(/(?:token|secret|password|authorization|api[_-]?key)\s*=\s*[^\s]+/gi, "$1=[REDACTED]");
  return { schema: EVENT_SCHEMA_VERSION, id: String(raw.id || `${provider}-${context.sequence || 1}`), ticket: context.ticket, session: context.session, policy_digest: context.policy_digest, provider, class: classMap[kind] || "shell", status, resource, redacted_summary: summary.slice(0, 240), sequence: context.sequence || 1 };
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

module.exports = { PROVIDERS, canLabelManagedAuto, enforceAction, normalizeEvent, probeProvider };
