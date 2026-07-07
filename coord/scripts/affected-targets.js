"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FULL_COMMAND = "node --test";
const DEFAULT_STALE_AFTER_DAYS = 90;

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pathMatches(pattern, file) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedFile = normalizePath(file);
  if (!normalizedPattern || !normalizedFile) return false;
  if (normalizedPattern.endsWith("/")) return normalizedFile.startsWith(normalizedPattern);
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function normalizeTarget(raw, index) {
  const id = String(raw?.id || raw?.name || `target-${index + 1}`).trim();
  return {
    id,
    command: String(raw?.command || raw?.cmd || "").trim(),
    files: toArray(raw?.files || raw?.sources),
    depends_on: toArray(raw?.depends_on || raw?.dependsOn || raw?.deps),
  };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateAffectedTargetMap(map, options = {}) {
  const issues = [];
  const error = (code, message) => issues.push({ code, severity: "error", message });
  const warn = (code, message) => issues.push({ code, severity: "warning", message });

  if (!isPlainObject(map)) {
    error("map_shape", "affected-target map must be a JSON object.");
    return { ok: false, issues };
  }

  const full = fullCommands(map);
  if (!Array.isArray(full) || full.length === 0 || full.some((command) => !String(command || "").trim())) {
    error("full_gate", "affected-target map must declare at least one non-empty full_gate command.");
  }

  const rawTargets = Array.isArray(map.targets) ? map.targets : [];
  if (rawTargets.length === 0) {
    error("targets_empty", "affected-target map must declare at least one target.");
  }

  const targets = rawTargets.map(normalizeTarget);
  const ids = new Set();
  for (const [index, target] of targets.entries()) {
    if (!target.id) {
      error("target_id", `target at index ${index} must declare id.`);
    }
    if (/\s/.test(target.id)) {
      error("target_id", `target "${target.id}" id must not contain whitespace.`);
    }
    if (ids.has(target.id)) {
      error("target_duplicate", `duplicate target id "${target.id}".`);
    }
    ids.add(target.id);
    if (!target.command) {
      error("target_command", `target "${target.id}" must declare command.`);
    }
    if (target.files.length === 0) {
      error("target_files", `target "${target.id}" must declare at least one file/glob prefix.`);
    }
    for (const file of target.files) {
      if (!normalizePath(file)) {
        error("target_file", `target "${target.id}" has an empty file pattern.`);
      }
    }
  }

  for (const target of targets) {
    for (const dep of target.depends_on) {
      if (!ids.has(dep)) {
        error("target_dep", `target "${target.id}" depends on unknown target "${dep}".`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(targets.map((target) => [target.id, target]));
  function visit(id, pathStack = []) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = pathStack.indexOf(id);
      const cycle = pathStack.slice(cycleStart).concat(id).join(" -> ");
      error("target_dep_cycle", `affected-target dependency cycle: ${cycle}`);
      return;
    }
    visiting.add(id);
    const target = byId.get(id);
    for (const dep of target?.depends_on || []) {
      if (byId.has(dep)) {
        visit(dep, pathStack.concat(id));
      }
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const target of targets) {
    visit(target.id, []);
  }

  if (options.requireUpdatedAt && !map.updated_at) {
    warn("map_freshness", "affected-target map has no updated_at timestamp.");
  }
  if (map.updated_at && options.now) {
    const updated = Date.parse(map.updated_at);
    const now = Date.parse(options.now);
    if (Number.isNaN(updated)) {
      warn("map_freshness", `affected-target map updated_at is not parseable: ${map.updated_at}`);
    } else if (!Number.isNaN(now)) {
      const staleAfterDays = Number(options.staleAfterDays || DEFAULT_STALE_AFTER_DAYS);
      const ageMs = now - updated;
      if (ageMs > staleAfterDays * 24 * 60 * 60 * 1000) {
        warn("map_stale", `affected-target map is older than ${staleAfterDays} days.`);
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function loadAffectedTargetMap(mapPath) {
  if (!mapPath || !fs.existsSync(mapPath)) {
    return { map: null, path: mapPath || null, error: mapPath ? "map file missing" : "map path absent" };
  }
  try {
    return {
      map: JSON.parse(fs.readFileSync(mapPath, "utf8")),
      path: mapPath,
      error: null,
    };
  } catch (error) {
    return {
      map: null,
      path: mapPath,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function fullCommands(map) {
  const commands = toArray(map?.full_gate?.commands || map?.fullGate?.commands || map?.full_commands);
  return commands.length > 0 ? commands : [DEFAULT_FULL_COMMAND];
}

function selectAffectedTargets({ files = [], map = null, full = false } = {}) {
  const changedFiles = toArray(files).map(normalizePath).filter(Boolean).sort();
  const mapTargets = Array.isArray(map?.targets) ? map.targets.map(normalizeTarget) : [];

  if (full) {
    return {
      mode: "full",
      reason: "explicit full override",
      changed_files: changedFiles,
      selected: fullCommands(map).map((command, index) => ({ id: `full-${index + 1}`, command, reason: "full override" })),
      skipped: mapTargets.map((target) => ({ id: target.id, command: target.command, reason: "full override supersedes slice accounting" })),
      unknown_files: [],
    };
  }

  if (!map || mapTargets.length === 0) {
    return {
      mode: "full",
      reason: "missing or empty dependency map",
      changed_files: changedFiles,
      selected: fullCommands(map).map((command, index) => ({ id: `full-${index + 1}`, command, reason: "missing dependency map" })),
      skipped: [],
      unknown_files: changedFiles,
    };
  }

  const targetById = new Map(mapTargets.map((target) => [target.id, target]));
  const initiallyAffected = new Set();
  const matchedFiles = new Set();

  for (const target of mapTargets) {
    for (const file of changedFiles) {
      if (target.files.some((pattern) => pathMatches(pattern, file))) {
        initiallyAffected.add(target.id);
        matchedFiles.add(file);
      }
    }
  }

  const unknownFiles = changedFiles.filter((file) => !matchedFiles.has(file));
  if (unknownFiles.length > 0) {
    return {
      mode: "full",
      reason: `unknown changed file(s): ${unknownFiles.join(", ")}`,
      changed_files: changedFiles,
      selected: fullCommands(map).map((command, index) => ({ id: `full-${index + 1}`, command, reason: "unknown file fallback" })),
      skipped: mapTargets.map((target) => ({ id: target.id, command: target.command, reason: "full fallback selected" })),
      unknown_files: unknownFiles,
    };
  }

  const affected = new Set(initiallyAffected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of mapTargets) {
      if (affected.has(target.id)) continue;
      if (target.depends_on.some((dep) => affected.has(dep))) {
        affected.add(target.id);
        changed = true;
      }
    }
  }

  const selected = mapTargets
    .filter((target) => affected.has(target.id))
    .map((target) => ({
      id: target.id,
      command: target.command,
      reason: initiallyAffected.has(target.id) ? "direct file match" : "transitive dependency",
    }));
  const skipped = mapTargets
    .filter((target) => !affected.has(target.id))
    .map((target) => ({
      id: target.id,
      command: target.command,
      reason: "not affected by changed files",
    }));

  return {
    mode: "slice",
    reason: "dependency map resolved affected targets",
    changed_files: changedFiles,
    selected,
    skipped,
    unknown_files: [],
  };
}

function parseArgs(argv = []) {
  const options = { files: [], mapPath: null, json: false, full: false, validate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--validate") {
      options.validate = true;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--files") {
      options.files.push(...toArray(argv[++i]));
      continue;
    }
    if (arg === "--map") {
      options.mapPath = argv[++i];
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function renderText(result) {
  const lines = [];
  lines.push(`Affected-target mode: ${result.mode}`);
  lines.push(`Reason: ${result.reason}`);
  lines.push("Selected:");
  for (const target of result.selected) lines.push(`- ${target.id}: ${target.command} (${target.reason})`);
  if (result.selected.length === 0) lines.push("- none");
  lines.push("Skipped:");
  for (const target of result.skipped) lines.push(`- ${target.id}: ${target.command} (${target.reason})`);
  if (result.skipped.length === 0) lines.push("- none");
  return `${lines.join("\n")}\n`;
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => process.stdout.write(String(line)));
  if (parsed.error) {
    log(`affected-targets: ${parsed.error}\n`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: affected-targets --files <a,b> [--map <json>] [--full] [--validate] [--json]\n");
    return { code: 0 };
  }
  let map = null;
  if (parsed.options.mapPath) {
    const mapPath = path.resolve(deps.cwd || process.cwd(), parsed.options.mapPath);
    const loaded = loadAffectedTargetMap(mapPath);
    if (loaded.error) {
      log(`affected-targets: ${loaded.error}\n`);
      return { code: 1 };
    }
    map = loaded.map;
  }
  if (parsed.options.validate) {
    const validation = validateAffectedTargetMap(map, {
      requireUpdatedAt: true,
      now: deps.now || new Date().toISOString(),
    });
    log(parsed.options.json ? `${JSON.stringify(validation, null, 2)}\n` : `${validation.ok ? "ok" : "invalid"}\n`);
    return { code: validation.ok ? 0 : 1, result: validation };
  }
  const result = selectAffectedTargets({ files: parsed.options.files, map, full: parsed.options.full });
  log(parsed.options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
  return { code: 0, result };
}

module.exports = {
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_FULL_COMMAND,
  loadAffectedTargetMap,
  normalizePath,
  pathMatches,
  parseArgs,
  renderText,
  run,
  selectAffectedTargets,
  validateAffectedTargetMap,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
