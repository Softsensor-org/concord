"use strict";

// COORD-116: canonical CLEAN STARTER BOARD shape.
//
// This is the single source of truth for "what a fresh coord board looks like":
// the SETUP-001 / SAMPLE-001 two-row starter board. It is reused by:
//   - `coord init` (coord-init.js) — seeds it when a target repo has no board.
//   - the public release builder (release/build-public-release.sh step 6) — the
//     clean-board step produces this same shape when cutting a release.
//
// Keeping the shape here (rather than duplicating the literal in both places)
// means `coord init` and the release cut can never disagree on the starter
// board. If the starter shape changes, it changes in ONE place.
//
// `version` is parameterized so the release builder can preserve the donor
// board's schema version when it rewrites the board in place; `coord init`
// seeds a fresh board at version 1.
function buildStarterBoard(version = 1) {
  return {
    version,
    metadata: {
      title: "Project Task Board",
      last_updated: "2026-01-01T00:00:00Z",
      canonical_references: [
        "coord/GOVERNANCE.md",
        "coord/AGENT_STARTUP_CHECKLIST.md",
        "coord/product/REPOS.md",
        "coord/product/REQUIREMENTS.md",
        "coord/product/ARCHITECTURE.md",
      ],
      landing_index_required_from_ticket: "ZZZZ-999",
      pr_index_required_from_ticket: "ZZZZ-999",
      plan_records_required_from_ticket: "ZZZZ-999",
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [
        "Before starting any ticket, complete coord/AGENT_STARTUP_CHECKLIST.md.",
        "Replace the example tickets below with your project work.",
        "Repo codes are defined in coord/project.config.js. Use X for cross-repo / coordination work.",
      ],
    },
    sections: [
      {
        kind: "markdown",
        level: 2,
        heading: "Getting Started",
        separator_before: false,
        body: [
          "This is a starter board. Replace these example rows with real tickets.",
          "Each ticket flows todo -> doing -> review -> done via coord/scripts/gov.",
          "From a scaffolded app root, run `npm run coord-ui` to open the read-only cockpit for this board.",
        ],
      },
      {
        kind: "table",
        level: 2,
        heading: "Backlog",
        separator_before: true,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "SETUP-001",
            Repo: "X",
            Type: "docs",
            Pri: "P1",
            Status: "todo",
            Owner: "unassigned",
            Description:
              "Configure coord/project.config.js with your repo map and populate the coord/product/ specification stubs.",
            "Depends On": "",
          },
          {
            ID: "SAMPLE-001",
            Repo: "B",
            Type: "feature",
            Pri: "P2",
            Status: "todo",
            Owner: "unassigned",
            Description: "Example backend ticket. Replace with your first real unit of work.",
            "Depends On": "SETUP-001",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
    waiver_index: {},
  };
}

module.exports = { buildStarterBoard };
