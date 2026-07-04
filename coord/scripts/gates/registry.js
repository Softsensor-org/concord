"use strict";

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.filter((check) => typeof check === "function");
}

function runGatePipeline(checks, ctx = {}) {
  const issues = [];
  for (const check of normalizeChecks(checks)) {
    const result = check(ctx);
    if (Array.isArray(result)) {
      issues.push(...result);
    }
  }
  return issues;
}

function createGateRegistry(phases = {}) {
  const byPhase = new Map();
  for (const [phase, checks] of Object.entries(phases || {})) {
    byPhase.set(String(phase), normalizeChecks(checks));
  }
  return {
    checks(phase) {
      return [...(byPhase.get(String(phase)) || [])];
    },
    run(phase, ctx = {}) {
      return runGatePipeline(byPhase.get(String(phase)) || [], {
        ...ctx,
        phase: ctx.phase || String(phase),
      });
    },
  };
}

module.exports = {
  createGateRegistry,
  runGatePipeline,
};
