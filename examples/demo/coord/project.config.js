// Demo project config for the bundled cockpit example.
module.exports = {
  repos: {
    B: { path: "backend", integrationBranch: "dev", origin: null, legacyAliases: [] },
    F: { path: "frontend", integrationBranch: "dev", origin: null, legacyAliases: [] },
  },
  requirements: { path: "product/REQUIREMENTS.md" },
};
