// coord/project.config.workspace.js — the WORKSPACE-mode variant of the
// project-owned config seam (COORD-624).
//
// The installer emits this file AS `coord/project.config.js` when it installs in
// `workspace` mode (the default and THE adoption model). The full-scaffold mode
// emits the sample-product variant instead. Which one you get is declared in
// `coord/install-surfaces.json` and visible in the reviewed install plan — the
// installer never guesses, and never ships both.
//
// Concord lives as a SIBLING of the repositories it governs:
//
//     project-workspace/
//     ├── coord/          <- the control plane (this file lives here)
//     ├── .claude/        <- workspace-level agent integration
//     ├── AGENTS.md
//     ├── repo-one/       <- an independent product Git repository
//     ├── repo-two/       <- an independent product Git repository
//     └── repo-three/
//
// `repos` starts EMPTY on purpose. Your repositories are yours: the installer
// records nothing about them and writes nothing into them. Map them with
//
//     npm run concord -- onboard . --write
//
// which discovers the sibling repositories beside `coord/` and writes an entry
// per repository using its RELATIVE SIBLING PATH — never "." and never an
// absolute path. Onboarding only RECORDS a repository; it never initializes it,
// never onboards it, and never writes into it. A product repository is touched
// only later, by governed ticket execution, through an explicitly claimed
// ticket, its own branch/worktree, and that repository's own gates.
//
// The full field reference (integrationBranch, startBaseRef, ticketPrefixes,
// testCommand, contract, conformance, tracks) is in
// `coord/docs/GCV4_ENGINE_CONFIG_SEAM.md`. The reserved code "X" is coord-only /
// cross-repo work and MUST NOT appear in `repos`.
module.exports = {
  coordTicketPrefix: "COORD",

  // Populated by `concord onboard` — one entry per sibling product repository:
  //
  //   repos: {
  //     A: { path: "api-service", integrationBranch: "main", testCommand: "npm test" },
  //     W: { path: "web-client",  integrationBranch: "main", testCommand: "npm test" },
  //   }
  repos: {},

  requirements: {
    path: "product/REQUIREMENTS.md",
  },

  // COORD-181: multi-track governance profile. Tracks map a ticket-id prefix to
  // a gate-proc, a default gate lane, a skill set, a review policy and an
  // operator persona. Removing this block restores the engine's built-in
  // defaults (see coord/scripts/track-registry.js BUILTIN_TRACKS).
  tracks: {
    marketing: { gateProc: "content", defaultLane: "default", prefixes: ["WEB", "DOC"], operator: "marketing", reviewPolicy: { approvers: 1 } },
    development: { gateProc: "test", defaultLane: "default", prefixes: ["DEV"], operator: "developer", reviewPolicy: { approvers: 1 } },
    devops: { gateProc: "infra", defaultLane: "full", prefixes: ["OPS"], operator: "devops", reviewPolicy: { approvers: 2 } },
    "product-engineering": { gateProc: "evidence", defaultLane: "default", prefixes: ["PE", "LIVE-MCP"], operator: "product-engineer", reviewPolicy: { approvers: 1 } },
    "data-analytics": { gateProc: "data-contract", defaultLane: "default", prefixes: ["DATA", "ANALYTICS"], operator: "data-engineer", reviewPolicy: { approvers: 1 } },
  },
};
