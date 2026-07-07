"use strict";

const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

const TIERS = Object.freeze({
  lite: {
    invariants: ["board", "ownership", "worktree isolation", "journal", "conform"],
    required_gates: ["prompt coverage or waiver", "repo gate evidence"],
    optional_gates: ["ADR", "business-context", "context-pack", "publishability"],
    upgrade_to: "standard",
  },
  standard: {
    invariants: ["board", "ownership", "worktree isolation", "journal", "conform", "review evidence"],
    required_gates: ["prompt coverage", "repo gates", "feature proof", "requirement closure", "review cycles"],
    optional_gates: ["ADR", "business-context", "publishability by touched surface"],
    upgrade_to: "full",
  },
  full: {
    invariants: ["board", "ownership", "worktree isolation", "journal", "conform", "review evidence", "publishability hygiene"],
    required_gates: ["prompt coverage", "repo gates", "feature proof", "requirement closure", "review cycles", "track evidence", "ADR/business-context when triggered"],
    optional_gates: [],
    upgrade_to: null,
  },
});

function normalizeTier(value) {
  const tier = String(value || "full").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
    throw new Error(`Unknown governance tier "${value}". Known tiers: ${Object.keys(TIERS).join(", ")}.`);
  }
  return tier;
}

function loadProjectConfig(root = ROOT) {
  const cfgPath = path.join(root, "coord", "project.config.js");
  try {
    delete require.cache[require.resolve(cfgPath)];
    return require(cfgPath) || {};
  } catch {
    return {};
  }
}

function resolveGovernanceTier(options = {}) {
  const config = options.projectConfig || loadProjectConfig(options.root);
  return normalizeTier(options.tier || config.governance?.tier || config.adoption?.tier || "full");
}

function buildGovernanceTierReport(options = {}) {
  const tier = resolveGovernanceTier(options);
  const def = TIERS[tier];
  return {
    kind: "concord.governance_tier",
    schema_version: 1,
    active_tier: tier,
    default_is_full: true,
    invariants: def.invariants,
    required_gates: def.required_gates,
    optional_gates: def.optional_gates,
    upgrade_to: def.upgrade_to,
    next_steps: def.upgrade_to
      ? [`Set governance.tier=${def.upgrade_to} in coord/project.config.js when the team is ready.`]
      : ["Already at full governance."],
  };
}

function renderGovernanceTier(report) {
  const lines = [
    "# Governance Tier",
    "",
    `Active tier: ${report.active_tier}`,
    "",
    "## Invariants",
    ...report.invariants.map((item) => `- ${item}`),
    "",
    "## Required Gates",
    ...report.required_gates.map((item) => `- ${item}`),
    "",
    "## Optional Gates",
    ...(report.optional_gates.length ? report.optional_gates.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Next Steps",
    ...report.next_steps.map((item) => `- ${item}`),
  ];
  return `${lines.join("\n")}\n`;
}

function governanceTierCommand(options = {}) {
  const report = buildGovernanceTierReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderGovernanceTier(report));
  }
  return report;
}

module.exports = {
  TIERS,
  buildGovernanceTierReport,
  governanceTierCommand,
  normalizeTier,
  renderGovernanceTier,
  resolveGovernanceTier,
};
