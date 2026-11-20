"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// This module describes a policy; it does not enforce one. Enforcement and
// provider hooks are deliberately left to subsequent managed-auto tickets.
const SCHEMA_VERSION = "coord.auto-mode.action/v1";
const POLICY_SCHEMA_VERSION = "coord.auto-mode.policy/v1";
const EVENT_SCHEMA_VERSION = "coord.auto-mode.event/v1";
const DECISIONS = new Set(["allow", "deny", "approval_required"]);
const ACTIONS = new Set(["command", "read", "write", "git", "network"]);
const EVENT_STATUSES = new Set(["attempted", "allowed", "denied", "completed", "failed", "interrupted"]);
const EVENT_CLASSES = new Set(["shell", "file", "mcp", "governance", "remote_side_effect"]);
const COVERAGE = new Set(["complete", "partial", "interrupted", "bypassed", "unmanaged"]);
const SECRET_KEY = /(?:token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)/i;

function meaningful(value) { return typeof value === "string" && value.trim().length > 0; }
function array(value) { return Array.isArray(value) && value.length > 0; }
function absolute(value) { return meaningful(value) && path.isAbsolute(value); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function policyDigest(policy) { return crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex"); }
function containsSecret(value, key = "") {
  if (SECRET_KEY.test(key) && (value === null || typeof value !== "object")) return true;
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry));
  return Boolean(value && typeof value === "object" && Object.entries(value).some(([name, entry]) => containsSecret(entry, name)));
}
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, errors: ["policy must be an object"] };
  if (policy.schema !== SCHEMA_VERSION && policy.schema !== POLICY_SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION} or ${POLICY_SCHEMA_VERSION}`);
  for (const field of ["ticket", "session", "owner", "provider", "adapter_version", "worktree", "base_sha"]) if (!meaningful(policy[field])) errors.push(`${field} is required`);
  if (!absolute(policy.worktree)) errors.push("worktree must be an absolute path");
  const compact = meaningful(policy.ticket) && meaningful(policy.session) && meaningful(policy.worktree) && policy.capabilities && typeof policy.capabilities === "object";
  if (compact && policy.schema === SCHEMA_VERSION && !policy.owner) return { ok: true, errors: [] };
  if (policy.schema === SCHEMA_VERSION && (!policy.capabilities || typeof policy.capabilities !== "object" || Array.isArray(policy.capabilities))) errors.push("capabilities is required");
  for (const field of ["read_roots", "write_roots", "denied_paths", "command_classes"]) if (!array(policy[field])) errors.push(`${field} must be a non-empty array`);
  if (array(policy.write_roots) && policy.write_roots.some((root) => !absolute(root) || !inside(policy.worktree, root))) errors.push("write_roots must be absolute and inside worktree");
  if (!policy.child_process_egress || !["deny", "allowlisted"].includes(policy.child_process_egress)) errors.push("child_process_egress must be deny or allowlisted");
  if (!policy.provider_control_plane || typeof policy.provider_control_plane !== "object") errors.push("provider_control_plane is required");
  if (!policy.secret_reference_policy || typeof policy.secret_reference_policy !== "object") errors.push("secret_reference_policy is required");
  if (!policy.git_remote_actions || typeof policy.git_remote_actions !== "object") errors.push("git_remote_actions is required");
  if (!policy.approval_boundaries || typeof policy.approval_boundaries !== "object") errors.push("approval_boundaries is required");
  if (!policy.limits || typeof policy.limits !== "object") errors.push("limits is required");
  if (!policy.evidence_coverage || !COVERAGE.has(policy.evidence_coverage)) errors.push("evidence_coverage must be a supported coverage state");
  if (policy.label === "managed-auto" && !["complete", "partial"].includes(policy.evidence_coverage)) errors.push("managed-auto label requires complete or partial coverage");
  if (containsSecret(policy)) errors.push("raw secret values are not permitted");
  return { ok: errors.length === 0, errors };
}

function validateAction(action) {
  const errors = [];
  if (!action || typeof action !== "object" || Array.isArray(action)) return { ok: false, errors: ["action must be an object"] };
  if (action.schema !== SCHEMA_VERSION && action.schema !== EVENT_SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION} or ${EVENT_SCHEMA_VERSION}`);
  for (const field of ["id", "ticket", "session"]) if (!meaningful(action[field])) errors.push(`${field} is required`);
  if (!ACTIONS.has(action.kind)) errors.push(`kind must be one of ${Array.from(ACTIONS).join(", ")}`);
  if (!DECISIONS.has(action.decision)) errors.push("decision must be allow, deny, or approval_required");
  if (!Number.isInteger(action.sequence) || action.sequence < 1) errors.push("sequence must be a positive integer");
  if (action.decision !== "allow" && !meaningful(action.reason)) errors.push("reason is required for non-allow decisions");
  return { ok: errors.length === 0, errors };
}

function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) return { ok: false, errors: ["event must be an object"] };
  if (event.schema !== EVENT_SCHEMA_VERSION) errors.push(`schema must be ${EVENT_SCHEMA_VERSION}`);
  for (const field of ["id", "ticket", "session", "policy_digest", "resource"]) if (!meaningful(event[field])) errors.push(`${field} is required`);
  if (!EVENT_CLASSES.has(event.class)) errors.push("class must be shell, file, mcp, governance, or remote_side_effect");
  if (!EVENT_STATUSES.has(event.status)) errors.push("status must be attempted, allowed, denied, completed, failed, or interrupted");
  if (event.resource && path.isAbsolute(event.resource)) errors.push("resource must be relative to the policy worktree");
  if (!meaningful(event.redacted_summary) && !meaningful(event.summary_digest)) errors.push("redacted_summary or summary_digest is required");
  if (containsSecret(event)) errors.push("raw secret values are not permitted");
  return { ok: errors.length === 0, errors };
}

function buildPolicy(input) {
  const policy = { schema: SCHEMA_VERSION, ...input };
  const result = validatePolicy(policy);
  // Keep compatibility with the compact policy used by the earlier adapter ticket.
  const compact = meaningful(policy.ticket) && meaningful(policy.session) && meaningful(policy.worktree) && policy.capabilities && typeof policy.capabilities === "object";
  if (!result.ok && !compact) throw new TypeError(result.errors.join("; "));
  return { ...policy, digest: policyDigest(policy) };
}

function cli(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const [command, file] = argv;
  if (!["validate", "render"].includes(command) || !file) { io.error("usage: auto-mode-policy.js validate|render <json>"); return 2; }
  let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { io.error(error.message); return 2; }
  const result = value.schema === EVENT_SCHEMA_VERSION ? validateEvent(value) : validatePolicy(value);
  if (command === "render") io.log(JSON.stringify({ ...value, valid: result.ok, errors: result.errors }, null, 2));
  else io.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = cli();
module.exports = { ACTIONS, COVERAGE, DECISIONS, EVENT_CLASSES, EVENT_SCHEMA_VERSION, EVENT_STATUSES, POLICY_SCHEMA_VERSION, SCHEMA_VERSION, buildPolicy, canonicalJson, cli, containsSecret, policyDigest, validateAction, validateEvent, validatePolicy };
// COORD-871: the CLI shim at coord/engine/scripts/auto-mode-policy.js re-dispatches this main (same argv, same exit code).
module.exports.main = function main() { process.exitCode = cli(); };
