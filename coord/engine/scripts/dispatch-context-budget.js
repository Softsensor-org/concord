"use strict";
const DEFAULT_CONTEXT_BUDGET_BYTES = 1500000;
function contextBudgetBytes(tier, policy) {
  const configured = policy && policy.tiers && policy.tiers[tier] && policy.tiers[tier].context_budget_bytes;
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CONTEXT_BUDGET_BYTES;
}
function measureContextPack(pack, tier, policy) {
  const max_bytes = contextBudgetBytes(tier, policy);
  const measured_bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  return { max_bytes, measured_bytes, decision: measured_bytes <= max_bytes ? "accepted" : "rejected-over-budget" };
}
function budgetRecord(tier, policy) { return { max_bytes: contextBudgetBytes(tier, policy), measured_bytes: null, decision: "not-requested" }; }
// guard:dispatch-context-integrity
function assertContextBudget(ticket, pack, tier, policy) {
  const record = measureContextPack(pack, tier, policy);
  if (record.decision !== "accepted") throw new Error(`context pack for ${ticket} is ${record.measured_bytes} bytes, above the ${record.max_bytes}-byte ${tier} budget; reduce the pack or raise the reviewed tier policy budget`);
  return record;
}
module.exports = { assertContextBudget, budgetRecord, contextBudgetBytes, measureContextPack, DEFAULT_CONTEXT_BUDGET_BYTES };
