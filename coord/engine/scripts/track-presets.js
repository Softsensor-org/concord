"use strict";

const PRESETS = Object.freeze({
  "web-app": {
    label: "Web App",
    tracks: ["development", "marketing"],
    gates: ["unit tests", "build", "preview smoke", "accessibility smoke"],
    prefixes: ["WEB", "UI", "API"],
  },
  "data-service": {
    label: "Data Service",
    tracks: ["development", "data-analytics"],
    gates: ["unit tests", "data-contract", "row-count reconciliation"],
    prefixes: ["DATA", "PIPE"],
  },
  "content-site": {
    label: "Content Site",
    tracks: ["marketing"],
    gates: ["content-gate", "preview or skip", "seo metadata"],
    prefixes: ["WEB", "DOC"],
  },
  infra: {
    label: "Infrastructure",
    tracks: ["devops"],
    gates: ["infra-gate", "plan diff", "deploy smoke or non-runtime"],
    prefixes: ["OPS", "INFRA"],
  },
});

function listTrackPresets() {
  return Object.entries(PRESETS).map(([id, preset]) => ({ id, ...preset }));
}

function getTrackPreset(id) {
  const key = String(id || "").trim();
  return PRESETS[key] ? { id: key, ...PRESETS[key] } : null;
}

function suggestPresetFromSignals(signals = []) {
  const set = new Set(signals.map((signal) => String(signal).toLowerCase()));
  if (set.has("deployment-infra") || set.has("terraform")) return getTrackPreset("infra");
  if (set.has("requirements-source") && (set.has("node") || set.has("python"))) return getTrackPreset("web-app");
  if (set.has("python") && (set.has("database") || set.has("data"))) return getTrackPreset("data-service");
  if (set.has("node")) return getTrackPreset("web-app");
  return getTrackPreset("web-app");
}

function renderTrackPresets(presets = listTrackPresets()) {
  const lines = ["# Track Presets", ""];
  for (const preset of presets) {
    lines.push(`## ${preset.id}`);
    lines.push(`Label: ${preset.label}`);
    lines.push(`Tracks: ${preset.tracks.join(", ")}`);
    lines.push(`Gates: ${preset.gates.join(", ")}`);
    lines.push(`Prefixes: ${preset.prefixes.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function run(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  let json = false;
  let presetId = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--preset") {
      presetId = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      log("Usage: coord track-presets [--json] [--preset <id>]");
      return { code: 0 };
    } else {
      presetId = arg;
    }
  }
  const presets = presetId ? [getTrackPreset(presetId)].filter(Boolean) : listTrackPresets();
  if (presetId && presets.length === 0) {
    log(`track-presets: unknown preset ${presetId}`);
    return { code: 1 };
  }
  const report = { kind: "concord.track_presets", schema_version: 1, presets };
  log(json ? JSON.stringify(report, null, 2) : renderTrackPresets(presets));
  return { code: 0, report };
}

module.exports = {
  PRESETS,
  getTrackPreset,
  listTrackPresets,
  renderTrackPresets,
  run,
  suggestPresetFromSignals,
};
