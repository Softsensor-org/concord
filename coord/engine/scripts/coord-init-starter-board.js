"use strict";

// Canonical fresh-project board and the model-ticket adoption ladder.
function setupRows() {
  const rows = [
    ["SETUP-002", "P1", "Author knowledge baseline (REQUIREMENTS, ARCHITECTURE, and REPOS).", "SETUP-001"],
    ["SETUP-003", "P1", "Run source-backed discovery and promote accepted facts.", "SETUP-002"],
    ["SETUP-004", "P1", "Run the governed gap audit and file the founding backlog.", "SETUP-003"],
    ["SETUP-005", "P1", "Wire real per-repo gates and CI evidence.", "SETUP-004"],
    ["SETUP-006", "P2", "Record founding ADRs and validate the decision registry.", "SETUP-005"],
    ["SETUP-007", "P2", "Import the requirements registry and link tickets.", "SETUP-006"],
    ["SETUP-008", "P2", "Record the coverage and test-maturity baseline.", "SETUP-007"],
    ["SETUP-009", "P2", "Generate the readiness report and adoption handoff.", "SETUP-008"],
  ];
  return rows.map(([ID, Pri, Description, depends]) => ({ ID, Repo: "X", Type: "task", Pri, Status: "todo", Owner: "unassigned", Description, "Depends On": depends }));
}

function buildStarterBoard(version = 1) {
  return {
    version,
    metadata: {
      title: "Project Task Board",
      last_updated: "2026-01-01T00:00:00Z",
      canonical_references: ["coord/GOVERNANCE.md", "coord/AGENT_STARTUP_CHECKLIST.md", "coord/product/REPOS.md", "coord/product/REQUIREMENTS.md", "coord/product/ARCHITECTURE.md"],
      landing_index_required_from_ticket: "ZZZZ-999", pr_index_required_from_ticket: "ZZZZ-999", plan_records_required_from_ticket: "ZZZZ-999",
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: ["Before starting any ticket, complete coord/AGENT_STARTUP_CHECKLIST.md.", "Complete SETUP-001..009 in dependency order; each row has a registered prompt.", "Repo codes are defined in coord/project.config.js. Use X for cross-repo / coordination work."],
    },
    sections: [
      { kind: "markdown", level: 2, heading: "Getting Started", separator_before: false, body: ["This is a starter adoption ladder. Replace these model steps with evidence from your project.", "Each ticket flows todo -> doing -> review -> done via coord/scripts/gov."] },
      { kind: "table", level: 2, heading: "Backlog", separator_before: true, columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [{ ID: "SETUP-001", Repo: "X", Type: "docs", Pri: "P1", Status: "todo", Owner: "unassigned", Description: "Confirm coord/project.config.js repo map and ticket prefixes (configuration seam only).", "Depends On": "" }, ...setupRows()] },
    ],
    prompt_index: Object.fromEntries(Array.from({ length: 9 }, (_, index) => { const id = `SETUP-${String(index + 1).padStart(3, "0")}`; return [id, `coord/prompts/tickets/${id}.md`]; })),
    pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  };
}

function buildStarterPrompts() {
  const descriptions = [
    "Confirm coord/project.config.js with the real repo map and ticket prefixes; keep this ticket limited to configuration.",
    "Replace the product knowledge stubs with the requirements, architecture, and repository ownership baseline.",
    "Run source-backed business discovery, synthesize citations, and promote only accepted facts.",
    "Audit governed gaps and file the first real backlog tickets with prompt coverage and prechecks.",
    "Connect every product repo to a real gate and CI evidence path; remove missing-test-command blockers.",
    "Record and validate the founding architecture and operating decisions in the ADR registry.",
    "Import stable requirements and link ticket work to the requirements registry.",
    "Capture coverage and test-maturity evidence using the governed rollup commands.",
    "Generate and review the readiness report for the next adoption phase.",
  ];
  return Object.fromEntries(descriptions.map((description, index) => {
    const id = `SETUP-${String(index + 1).padStart(3, "0")}`;
    return [id, `# ${id}: Starter adoption step\n\n## Assignment\n\n${description}\n\n## Acceptance\n\n- Record source paths, commands, and gate results in the governed plan.\n- Preserve provenance; do not hand-edit board or plan state.\n- Record unresolved decisions as governed questions or follow-up tickets.\n`];
  }));
}

module.exports = { buildStarterBoard, buildStarterPrompts };
