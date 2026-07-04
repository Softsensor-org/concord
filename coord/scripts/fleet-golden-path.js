"use strict";

function buildFleetGoldenPath(ticketId = null) {
  const ticket = ticketId || "<ticket-id>";
  return {
    command: "fleet-golden-path",
    ticket,
    purpose: "Safe multi-agent Concord operation for non-expert fleet operators.",
    invariants: [
      "One governed writer per checkout/runtime; use ticket worktrees for concurrent agents.",
      "Derived views are regenerated, never used as mutation authority.",
      "Every ticket must record gate-plan, context-pack acknowledgement, repo gates, feature proof, review cycles, and requirement closure before submit.",
      "Recovery is dry-run first; destructive repairs require explicit confirmation.",
    ],
    setup: [
      "coord/scripts/gov agentid --owner <agent-handle>",
      "coord/scripts/gov register-prompt <ticket-id> --create --template ticket",
      "coord/scripts/gov start <ticket-id> --owner <agent-handle>",
    ],
    prework: [
      `coord/scripts/gov gate-plan ${ticket} --write`,
      `coord/scripts/coord business-context-pack --ticket ${ticket} --write-default`,
      `coord/scripts/gov explain ${ticket}`,
    ],
    closeout_wrappers: [
      `coord/scripts/gov guided-closeout ${ticket}`,
      `coord/scripts/gov update-plan ${ticket} --repo-gate "<executed checks>"`,
      `coord/scripts/gov set-review-cycles ${ticket} --review-cycle "lens=...; diff=...; risks=..., ...; findings=...; verification=...; verdict=pass"`,
      `coord/scripts/gov set-requirement-closure ${ticket} --ticket-ask "..." --implemented "..." --closeout-verdict complete`,
      `coord/scripts/gov add-feature-proof ${ticket} --proof-path <path>`,
      `coord/scripts/gov publishability-check ${ticket}`,
      `coord/scripts/gov submit ${ticket} --pr "local-review (no PR)"`,
    ],
    integration: [
      "Merge the source commit into the canonical branch.",
      "Rerun canonical gates on main.",
      `coord/scripts/gov finalize ${ticket} --no-pr --source-commit <sha> --landed "<merge-sha> <summary>"`,
      "Commit final governance residue: journal, prompt, and any synced board/rendered artifacts.",
    ],
    recovery: [
      "coord/scripts/gov doctor",
      "coord/scripts/gov doctor --repair-all",
      "coord/scripts/gov doctor --repair-all --confirm",
      "coord/scripts/gov repair-chain --confirm --reason \"<why>\"",
    ],
  };
}

function renderFleetGoldenPath(report) {
  const lines = [
    "# Concord Fleet Golden Path",
    "",
    `Ticket: ${report.ticket}`,
    "",
    "## Invariants",
    ...report.invariants.map((item) => `- ${item}`),
    "",
    "## Setup",
    ...report.setup.map((item) => `- \`${item}\``),
    "",
    "## Prework",
    ...report.prework.map((item) => `- \`${item}\``),
    "",
    "## Closeout Wrappers",
    ...report.closeout_wrappers.map((item) => `- \`${item}\``),
    "",
    "## Integration",
    ...report.integration.map((item) => `- ${item.startsWith("coord/") ? `\`${item}\`` : item}`),
    "",
    "## Recovery",
    ...report.recovery.map((item) => `- \`${item}\``),
  ];
  return `${lines.join("\n")}\n`;
}

function fleetGoldenPath(ticketId = null, options = {}) {
  const report = buildFleetGoldenPath(ticketId);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderFleetGoldenPath(report));
  }
  return report;
}

module.exports = {
  buildFleetGoldenPath,
  fleetGoldenPath,
  renderFleetGoldenPath,
};
