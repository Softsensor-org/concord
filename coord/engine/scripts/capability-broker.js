"use strict";

const crypto = require("node:crypto");
const { redact } = require("./auto-mode-ledger.js");

const ALLOWED = new Set(["scm.read", "scm.submit", "package.registry"]);
// COORD-860: a bounded class for each capability's target, so a receipt can be
// reconciled by class and digest without retaining the raw target.
const TARGET_CLASSES = Object.freeze({ "scm.read": "scm-ref", "scm.submit": "scm-ref", "package.registry": "package" });
const BLOCKED = /(?:credential|token|secret|password|authorization|private.?key)/i;

function safeTarget(target) {
  const value = String(target || "");
  if (!value || BLOCKED.test(value) || /(?:production|deploy|release|cloud|delete|destroy)/i.test(value)) return null;
  return value.length > 200 ? value.slice(0, 200) : value;
}

function receipt(input) {
  return {
    schema: "coord.auto-mode.broker-receipt/v1", receipt_id: input.receipt_id,
    ticket: input.ticket, capability: input.capability, target: input.target,
    target_class: TARGET_CLASSES[input.capability] || "other",
    result: input.result, external_id: input.external_id || null,
  };
}

class CapabilityBroker {
  constructor(options = {}) {
    this.ticket = String(options.ticket || "");
    this.execute = options.execute;
    this.now = options.now || (() => Date.now());
    this.capabilities = new Set(options.capabilities || ALLOWED);
    // Idempotency-keyed responses: a replayed key returns its first receipt
    // and never executes the effect again.
    this.replays = new Map();
    if (!this.ticket || typeof this.execute !== "function") throw new TypeError("ticket and broker executor are required");
  }

  request(request = {}) {
    const capability = String(request.capability || "");
    const target = safeTarget(request.target);
    // guard:auto-mode-containment
    if (!this.capabilities.has(capability) || !target) return { decision: "deny", reason: "capability or target is not approved" };
    if (request.ticket && request.ticket !== this.ticket) return { decision: "deny", reason: "ticket mismatch" };
    if (request.approved !== true) return { decision: "approval_required", reason: "explicit broker approval is required" };
    const key = request.idempotency_key ? `${capability}:${target}:${request.idempotency_key}` : null;
    if (key && this.replays.has(key)) return { ...this.replays.get(key), replayed: true };
    const seed = key || this.now();
    const id = crypto.createHash("sha256").update(`${this.ticket}:${capability}:${target}:${seed}`).digest("hex").slice(0, 20);
    const brokerRequest = { ticket: this.ticket, capability, target, parameters: redact(request.parameters || {}), credential_ref: "broker-owned" };
    let output;
    // The executor ran (or may have run) and failed: the outcome is unknown,
    // which is never reported as a completed or a no-op effect.
    try { output = this.execute(brokerRequest); } catch { return { decision: "deny", reason: "broker execution failed", outcome: "unknown" }; }
    const result = output?.result || "completed";
    const response = { decision: "allow", receipt: receipt({ receipt_id: id, ticket: this.ticket, capability, target, result, external_id: output?.external_id }) };
    if (key) this.replays.set(key, response);
    return response;
  }
}

function requestCapability(broker, request) {
  if (!broker || typeof broker.request !== "function") throw new TypeError("a CapabilityBroker is required");
  return broker.request(request);
}

module.exports = { ALLOWED_CAPABILITIES: ALLOWED, CapabilityBroker, TARGET_CLASSES, receipt, requestCapability, safeTarget };
