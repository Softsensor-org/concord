// COORD-967: hermetic project config for governance tests that assert default
// branch resolution. Loaded through the COORD_PROJECT_CONFIG seam (paths.js), so
// the suite never depends on the live coord/project.config.js. It intentionally
// leaves `boardBranch` UNSET, so the engine default (main) applies. Keep it in
// step with the repo layout the suites assume (B and F, integration on dev).
module.exports = {
  coordTicketPrefix: "COORD",
  repos: {
    B: {
      path: "backend",
      integrationBranch: "dev",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: ["MSRV"],
      testCommand: "npm run test:ci",
    },
    F: {
      path: "frontend",
      integrationBranch: "dev",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: ["FE"],
      testCommand: "npm run test:ci",
      contract: {
        sourceRepo: "B",
        sourcePath: "contract/openapi.json",
        generatedPath: "src/generated/api-client.js",
      },
    },
  },
  requirements: {
    path: "product/REQUIREMENTS.md",
  },
};
