"use strict";

const crypto = require("node:crypto");

const SCHEMA_VERSION = "coord.auto-mode.action/v1";
const DECISIONS = new Set(["allow", "deny", "approval_required"]);
const ACTIONS = new Set(["command", "read", "write", "git", "network"]);

function meaningful(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function policyDigest(policy) {
  return crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, errors: ["policy must be an object"] };
  if (policy.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION}`);
  if (!meaningful(policy.ticket)) errors.push("ticket is required");
  if (!meaningful(policy.session)) errors.push("session is required");
  if (!meaningful(policy.worktree)) errors.push("worktree is required");
  if (!policy.capabilities || typeof policy.capabilities !== "object") errors.push("capabilities is required");
  return { ok: errors.length === 0, errors };
}

function validateAction(action) {
  const errors = [];
  if (!action || typeof action !== "object" || Array.isArray(action)) return { ok: false, errors: ["action must be an object"] };
  if (action.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION}`);
  if (!meaningful(action.id)) errors.push("id is required");
  if (!meaningful(action.ticket)) errors.push("ticket is required");
  if (!meaningful(action.session)) errors.push("session is required");
  if (!ACTIONS.has(action.kind)) errors.push(`kind must be one of ${Array.from(ACTIONS).join(", ")}`);
  if (!DECISIONS.has(action.decision)) errors.push("decision must be allow, deny, or approval_required");
  if (!Number.isInteger(action.sequence) || action.sequence < 1) errors.push("sequence must be a positive integer");
  if (action.decision !== "allow" && !meaningful(action.reason)) errors.push("reason is required for non-allow decisions");
  return { ok: errors.length === 0, errors };
}

function buildPolicy(input) {
  const policy = { schema: SCHEMA_VERSION, ...input };
  const result = validatePolicy(policy);
  if (!result.ok) throw new TypeError(result.errors.join("; "));
  return { ...policy, digest: policyDigest(policy) };
}

module.exports = { ACTIONS, DECISIONS, SCHEMA_VERSION, canonicalJson, policyDigest, validatePolicy, validateAction, buildPolicy };
