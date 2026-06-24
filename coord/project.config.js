// coord/project.config.js — project-owned config seam (GCV-4 slice 1).
//
// This file is the only seam a project edits to bind coord to its repo
// layout. Engine files (paths.js, scripts/*, board/board.js, schemas) are
// engine-managed and must not be hand-edited; upgrading the engine is the
// supported path of change. See coord/docs/GCV4_ENGINE_CONFIG_SEAM.md.
//
// Rules:
//   - "X" is reserved for cross-repo / coord-only work and MUST NOT appear
//     in `repos`.
//   - Each repo code is a single uppercase letter.
//   - `path` is relative to the project root (one level above coordDir)
//     unless absolute.
//   - `integrationBranch` is the per-repo integration base. The shipped
//     template default is "main" (the clean, conventional default a fresh
//     adopter expects). When the key is omitted entirely, the engine
//     resolution fallback is still "dev" (DEFAULT_INTEGRATION_BRANCH in
//     paths.js) — set it explicitly to whatever your repo actually uses.
//   - `startBaseRef` (optional, per-repo) is the base ref new governed work
//     for that repo is branched off when `gov start` cuts a fresh worktree.
//     `defaultStartBaseRef` (optional, top-level) is the project-wide
//     fallback. When BOTH are unset, the base defaults to that repo's
//     `integrationBranch` — today's behavior. Precedence (highest first):
//       1. an explicit `gov start --base <ref>` / plan-record base_ref
//       2. per-repo `startBaseRef`
//       3. top-level `defaultStartBaseRef`
//       4. per-repo `integrationBranch`
//       5. engine default ("dev")
//     `gov start` then FRESHENS the resolved base from origin (fetch +
//     branch from `origin/<base>`) so new work never starts off a stale
//     local checkout; if origin is unreachable it falls back to the local
//     base with a warning (offline workflows are never hard-failed).
//   - `origin` is optional audit/upgrade metadata; it does not replace the
//     local git remote.
//   - `legacyAliases` are historical directory prefixes still accepted
//     when normalizing older proof/audit paths.
//   - `ticketPrefixes` are optional ticket-id prefixes (e.g. "FE", "MSRV")
//     that map a foreign ticket id to this repo code when no canonical board
//     row is available. Unconfigured repos contribute nothing and ticket-id
//     inference falls back to the reserved "X" (coord) code.
//   - `coordTicketPrefix` is the ticket-id prefix for coord/cross-repo ("X")
//     work; defaults to "COORD".
//   - `requirements.path` defaults to "product/REQUIREMENTS.md".
//
// The coord-template default below is intentionally the minimal
// two-repo shape (B=backend, F=frontend). Downstream consumers replace
// this with their own layout (see coord/docs/GCV4_ENGINE_CONFIG_SEAM.md
// "acme should therefore be config, not a custom engine fork").
module.exports = {
  coordTicketPrefix: "COORD",
  repos: {
    B: {
      path: "backend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: ["MSRV"],
      testCommand: "npm run test:ci",
    },
    F: {
      path: "frontend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: ["FE"],
      testCommand: "npm run test:ci",
      // COORD-082 (CONTRACT-002): config-driven, CI-safe contract source. The
      // frontend generates its API client from the BACKEND's OpenAPI artifact,
      // resolved through coord's repo-registry path resolution (repoRoots["B"])
      // — NOT a hardcoded sibling path like ../backend/openapi.json. This makes
      // `contract:gen` / `contract:check` work regardless of absolute layout or
      // in CI. The staleness gate (frontend/scripts/gate.sh, full/ci lanes)
      // fails when the committed generated client drifts from this source.
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
  // COORD-181: multi-track governance profile (see
  // coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md). A TRACK is the work-type
  // axis — it selects a gate-proc, a default gate LANE (the existing
  // default/full/ci intensity axis, unchanged), a skill set, a review policy,
  // and an operator persona. Tracks are resolved from a ticket-id prefix by
  // coord/scripts/track-registry.js, which reads THIS block directly (the engine
  // config normalizer does not carry `tracks`, by design — config seam, not
  // engine fork). Any ticket whose prefix matches no track falls back to
  // `development` + the `test` gate, so omitting/removing this block restores the
  // engine's pre-track behavior exactly.
  //
  // Engine ships built-in defaults for these five tracks (track-registry.js
  // BUILTIN_TRACKS); the block below is the explicit, project-tunable shape.
  // Override a field per track (e.g. prefixes, reviewPolicy.approvers) as needed.
  tracks: {
    marketing: { gateProc: "content", defaultLane: "default", prefixes: ["WEB", "DOC"], operator: "marketing", reviewPolicy: { approvers: 1 } },
    development: { gateProc: "test", defaultLane: "default", prefixes: ["DEV", "FE", "MSRV", "BE"], operator: "developer", reviewPolicy: { approvers: 1 } },
    devops: { gateProc: "infra", defaultLane: "full", prefixes: ["OPS"], operator: "devops", reviewPolicy: { approvers: 2 } },
    "product-engineering": { gateProc: "evidence", defaultLane: "default", prefixes: ["PE", "LIVE-MCP"], operator: "product-engineer", reviewPolicy: { approvers: 1 } },
    "data-analytics": { gateProc: "data-contract", defaultLane: "default", prefixes: ["DATA", "ANALYTICS"], operator: "data-engineer", reviewPolicy: { approvers: 1 } },
  },
};
