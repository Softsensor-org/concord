"use strict";

function normalizeIntent(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeIntent).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        const normalized = normalizeIntent(value[key]);
        if (normalized !== undefined && normalized !== null && normalized !== "") {
          out[key] = normalized;
        }
        return out;
      }, {});
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function stableIdempotencyKey(command, ticket, intent = {}) {
  const normalized = normalizeIntent(intent);
  return `gov:${command}:${ticket || "-"}:${JSON.stringify(normalized)}`;
}

module.exports = {
  normalizeIntent,
  stableIdempotencyKey,
};
