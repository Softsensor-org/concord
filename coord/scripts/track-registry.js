"use strict";

// COORD-181: track registry — resolves a ticket's TRACK (work-type) and the
// track's gate-proc / default lane / skills / review policy / operator.
//
// A TRACK is the work-type axis of the multi-track governance profile (see
// coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md). It is ORTHOGONAL to a gate
// LANE (the existing default/full/ci gate-intensity axis in
// governance-constants.js): a track SELECTS a default lane, it does not replace
// the lane concept.
//
// SEAM, NOT FORK: track definitions live in the project-owned `tracks` block of
// coord/project.config.js. The engine's config normalizer (paths.js
// normalizeProjectConfig) intentionally whitelists keys and does NOT carry
// `tracks` into DEFAULT_PATHS.projectConfig, so this module reads the RAW config
// directly (or an injected one for tests) rather than touching engine paths.js.
//
// NON-BREAKING BY CONSTRUCTION: the built-in `development` track is the fallback
// for any ticket whose prefix matches no configured track. With no `tracks`
// block at all, every ticket resolves to `development` + the `test` gate — the
// engine's pre-track behavior, unchanged.

const path = require("path");

// Built-in track definitions. A project's coord/project.config.js `tracks` block
// overrides/extends these by name (see mergeTrack). Prefixes are matched
// case-insensitively against the ticket-id prefix (everything before the final
// `-<number>`), so multi-segment prefixes like "LIVE-MCP" work.
const BUILTIN_TRACKS = Object.freeze({
  development: {
    gateProc: "test",
    defaultLane: "default",
    skills: ["planner", "code-writer", "code-reviewer", "qa-review", "test-strategy"],
    reviewPolicy: { approvers: 1, requiredArtifacts: ["gate-artifact"] },
    operator: "developer",
    prefixes: [],
  },
  marketing: {
    gateProc: "content",
    defaultLane: "default",
    skills: ["content-edit", "seo-check", "publish"],
    reviewPolicy: { approvers: 1, requiredArtifacts: ["preview-url", "seo-report"] },
    operator: "marketing",
    prefixes: ["WEB", "DOC"],
  },
  devops: {
    gateProc: "infra",
    defaultLane: "full",
    skills: ["gate", "land"],
    reviewPolicy: { approvers: 2, requiredArtifacts: ["infra-report", "deploy-smoke"] },
    operator: "devops",
    prefixes: ["OPS"],
  },
  "product-engineering": {
    gateProc: "evidence",
    defaultLane: "default",
    skills: ["live-mcp-policy", "analytics-query", "insight-analyst"],
    reviewPolicy: { approvers: 1, requiredArtifacts: ["live-mcp-receipt"] },
    operator: "product-engineer",
    prefixes: ["PE", "LIVE-MCP"],
  },
  "data-analytics": {
    gateProc: "data-contract",
    defaultLane: "default",
    skills: ["data-pipeline", "data-contract", "insight-analyst"],
    reviewPolicy: { approvers: 1, requiredArtifacts: ["data-contract", "certification"] },
    operator: "data-engineer",
    prefixes: ["DATA", "ANALYTICS"],
  },
});

const DEFAULT_TRACK_NAME = "development";

// Extract the prefix from a ticket id: everything before the trailing `-<number>`.
// "WEB-12" -> "WEB", "LIVE-MCP-007" -> "LIVE-MCP", "COORD-181" -> "COORD".
// Returns null when the id is not a recognizable ticket id.
function prefixOf(ticketId) {
  if (typeof ticketId !== "string") return null;
  const m = ticketId.trim().toUpperCase().match(/^(.+)-\d+$/);
  return m ? m[1] : null;
}

function mergeTrack(base, over) {
  base = base || {};
  over = over || {};
  return {
    gateProc: over.gateProc || base.gateProc || "test",
    defaultLane: over.defaultLane || base.defaultLane || "default",
    skills: Array.isArray(over.skills)
      ? over.skills.slice()
      : Array.isArray(base.skills)
        ? base.skills.slice()
        : [],
    reviewPolicy: Object.assign({}, base.reviewPolicy, over.reviewPolicy),
    operator: over.operator || base.operator || null,
    prefixes: Array.isArray(over.prefixes)
      ? over.prefixes.slice()
      : Array.isArray(base.prefixes)
        ? base.prefixes.slice()
        : [],
  };
}

// Load the raw project config (the one carrying `tracks`). Default location is
// coord/project.config.js, one level up from this scripts/ dir. Tolerant: a
// missing/broken config yields {} so the built-in tracks still resolve.
function loadRawProjectConfig() {
  try {
    const configPath = process.env.COORD_PROJECT_CONFIG
      ? path.resolve(process.env.COORD_PROJECT_CONFIG)
      : path.join(__dirname, "..", "project.config.js");
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(configPath) || {};
  } catch {
    return {};
  }
}

// createTrackRegistry({ projectConfig, builtinTracks }) -> registry
//
// projectConfig: the RAW project config object (with an optional `tracks` block).
//   Defaults to loading coord/project.config.js. Pass an object in tests.
function createTrackRegistry(deps = {}) {
  const builtins = deps.builtinTracks || BUILTIN_TRACKS;
  const projectConfig =
    deps.projectConfig !== undefined ? deps.projectConfig : loadRawProjectConfig();
  const overrides =
    projectConfig && projectConfig.tracks && typeof projectConfig.tracks === "object" && !Array.isArray(projectConfig.tracks)
      ? projectConfig.tracks
      : {};

  const tracks = {};
  for (const name of new Set([...Object.keys(builtins), ...Object.keys(overrides)])) {
    tracks[name] = mergeTrack(builtins[name], overrides[name]);
  }

  // prefix (uppercase) -> track name
  const prefixToTrack = {};
  for (const [name, def] of Object.entries(tracks)) {
    for (const pfx of def.prefixes || []) {
      prefixToTrack[String(pfx).trim().toUpperCase()] = name;
    }
  }

  function trackNameForTicket(ticketId) {
    const pfx = prefixOf(ticketId);
    if (pfx && Object.prototype.hasOwnProperty.call(prefixToTrack, pfx)) {
      return prefixToTrack[pfx];
    }
    return DEFAULT_TRACK_NAME;
  }

  // Resolve the full track for a ticket. An explicit `override` (e.g. from
  // `gov start --track <name>`) wins when it names a known track.
  function resolveTrack(ticketId, options = {}) {
    let name = trackNameForTicket(ticketId);
    if (options.override) {
      const requested = String(options.override).trim();
      if (!Object.prototype.hasOwnProperty.call(tracks, requested)) {
        throw new Error(
          `Unknown track "${requested}". Known tracks: ${Object.keys(tracks).sort().join(", ")}.`
        );
      }
      name = requested;
    }
    return Object.assign({ name }, tracks[name]);
  }

  function trackByName(name) {
    return Object.prototype.hasOwnProperty.call(tracks, name)
      ? Object.assign({ name }, tracks[name])
      : null;
  }

  function listTracks() {
    return Object.keys(tracks)
      .sort()
      .map((name) => Object.assign({ name }, tracks[name]));
  }

  return {
    resolveTrack,
    trackNameForTicket,
    trackByName,
    listTracks,
    gateProcForTicket: (ticketId, options) => resolveTrack(ticketId, options).gateProc,
    defaultLaneForTicket: (ticketId, options) => resolveTrack(ticketId, options).defaultLane,
    prefixToTrack: () => Object.assign({}, prefixToTrack),
  };
}

module.exports = createTrackRegistry;
module.exports.BUILTIN_TRACKS = BUILTIN_TRACKS;
module.exports.DEFAULT_TRACK_NAME = DEFAULT_TRACK_NAME;
module.exports.prefixOf = prefixOf;
module.exports.mergeTrack = mergeTrack;
