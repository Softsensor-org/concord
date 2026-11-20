"use strict";

// Finding identity stays stable for deduplication. Attribution is a separate
// measurement: an existing finding cannot erase growth in its measured value.
function productionLocAttribution(current, baseline) {
  if (current?.check !== "prodloc" || !Number.isFinite(current.value) || !Number.isFinite(current.threshold)) return null;
  const before = Number.isFinite(baseline?.value) ? baseline.value : null;
  const beforeBudget = Number.isFinite(baseline?.threshold) ? baseline.threshold : current.threshold;
  const excess = Math.max(0, current.value - current.threshold);
  const inherited = before === null ? 0 : Math.max(0, before - beforeBudget);
  const budgetChange = before === null ? 0 : Math.max(0, before - current.threshold) - inherited;
  return {
    file: current.file,
    baseline_loc: before,
    baseline_budget: before === null ? null : beforeBudget,
    current_loc: current.value,
    declared_budget: current.threshold,
    inherited_excess: inherited,
    added_loc: before === null ? null : current.value - before,
    added_excess: Math.max(0, excess - inherited - budgetChange),
    budget_excess_change: budgetChange,
    classification: before === null || current.value > before || budgetChange > 0 ? "new" : "pre-existing",
  };
}

function formatProductionLocAttribution(entries = []) {
  return entries.map(entry => ` prodloc[file=${JSON.stringify(entry.file)} classification=${entry.classification}` +
    ` inherited=${entry.inherited_excess} added=${entry.added_loc === null ? "unknown" : entry.added_loc}` +
    ` added-excess=${entry.added_excess} budget-change=${entry.budget_excess_change} current=${entry.current_loc} budget=${entry.declared_budget}]`).join("");
}

module.exports = { productionLocAttribution, formatProductionLocAttribution };
