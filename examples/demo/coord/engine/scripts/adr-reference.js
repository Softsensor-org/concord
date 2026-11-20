"use strict";

// Shared with the existing ADR gate: plan-input validation must use the same
// identifier interpretation as review/closeout, including document references.
function normalizeAdrRef(value) {
  const match = String(value || "").match(/(?:ADR[-\s:]?)?([0-9]{4})\b/);
  return match ? match[1] : null;
}

module.exports = { normalizeAdrRef };
