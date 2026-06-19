// coord/scripts/__fixtures__/project.config.nondefault.js
//
// COORD-010: synthetic NON-default project config for the CI config matrix.
//
// The governance suite is otherwise green only against coord-template's own
// default config (2 repos B/F, integration branch `dev`). That left the
// engine blind to config-sensitivity — the root cause behind COORD-005,
// COORD-006, and COORD-009. This fixture mirrors the structural shape of a
// real downstream workspace (acme):
//
//   - SEVEN repos (B..H), not two.
//   - A non-`dev` integration branch (`devx`).
//   - Repo `path` values whose basename is NOT the conventional
//     "backend"/"frontend" and is unrelated to the registry letter, so any
//     code that derives a repo name from the directory basename or assumes
//     the template layout is exercised.
//   - Per-repo `legacyAliases` so alias-normalization paths are covered.
//
// The full suite is run a second time with `COORD_PROJECT_CONFIG` pointed at
// this file (see coord/product/TESTING_AND_GATES.md and the GitHub Actions
// workflow). Any assertion that hardcodes `dev` or a two-repo layout fails
// the non-default matrix leg.
//
// NOTE: this is a test FIXTURE, never a real project config. The repo `path`
// values do not need to resolve on disk — tests that touch real repos
// redirect `paths.REPO_ROOTS` themselves; this fixture only drives the
// config-derived registry shape (repo codes, integration branches, aliases).
module.exports = {
  // COORD-071: non-default coord/X prefix + per-repo ticketPrefixes and
  // testCommand, so the de-hardcoded config-seam paths (ticket-id inference,
  // X-repo prefix matching, testing-baseline derivation) are exercised under a
  // layout that shares NO literals with the engine defaults (no "COORD",
  // "FE"/"MSRV", "backend"/"frontend", or "npm run test:ci").
  coordTicketPrefix: "OPS",
  repos: {
    B: { path: "services/api", integrationBranch: "devx", origin: null, legacyAliases: ["api", "msrv"], ticketPrefixes: ["API"], testCommand: "pnpm test:ci" },
    C: { path: "services/worker", integrationBranch: "devx", origin: null, legacyAliases: ["worker"], ticketPrefixes: ["WRK"], testCommand: "pnpm test:ci" },
    D: { path: "apps/web", integrationBranch: "devx", origin: null, legacyAliases: ["web", "frontend"], ticketPrefixes: ["WEB"], testCommand: "pnpm test:ci" },
    E: { path: "apps/admin", integrationBranch: "devx", origin: null, legacyAliases: ["admin"], ticketPrefixes: ["ADM"] },
    F: { path: "packages/shared", integrationBranch: "devx", origin: null, legacyAliases: ["shared"], ticketPrefixes: ["SHR"] },
    G: { path: "infra/terraform", integrationBranch: "devx", origin: null, legacyAliases: ["infra"], ticketPrefixes: ["INF"] },
    H: { path: "tools/cli", integrationBranch: "devx", origin: null, legacyAliases: ["cli", "tooling"], ticketPrefixes: ["CLI"] },
  },
  requirements: {
    path: "product/REQUIREMENTS.md",
  },
};
