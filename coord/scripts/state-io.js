"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  COORD_DIR,
  ROOT_DIR,
  DEFAULT_PATHS,
  defaultFail,
  withCoordStateLock,
} = require("./governance-context.js");

const BOARD_RAW_SYMBOL = Symbol("boardRaw");

// COORD-072: shared GovernanceError thunk (was an inline `function fail`).
const fail = defaultFail;

function attachTrackedRaw(target, symbol, raw) {
  if (!target || typeof target !== "object") {
    return;
  }
  Object.defineProperty(target, symbol, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: raw,
  });
}

function readCanonicalTextFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    if (options.allowMissing) {
      return "";
    }
    fail(`Missing canonical file ${path.relative(ROOT_DIR, filePath)}.`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function fsyncDirectoryBestEffort(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms. Rename still keeps readers atomic.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function writeFileAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  fsyncDirectoryBestEffort(path.dirname(filePath));
}

function writeCanonicalTextFile(filePath, nextRaw, options = {}) {
  return withCoordStateLock(() => {
    const currentRaw = readCanonicalTextFile(filePath, { allowMissing: true });
    if (options.expectedRaw !== undefined && currentRaw !== options.expectedRaw) {
      fail(
        `Refusing to overwrite ${path.relative(ROOT_DIR, filePath)} because it changed during this command. ` +
        `Re-run against the latest coord state.`
      );
    }
    writeFileAtomicSync(filePath, nextRaw);
  });
}

function readCanonicalJsonFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    if (options.allowMissing) {
      return null;
    }
    fail(`Missing canonical file ${path.relative(ROOT_DIR, filePath)}.`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    attachTrackedRaw(parsed, BOARD_RAW_SYMBOL, raw);
    return parsed;
  } catch (error) {
    fail(`Invalid JSON in canonical file ${path.relative(ROOT_DIR, filePath)}: ${error.message}`);
  }
}

function writeCanonicalJsonFile(filePath, nextValue, options = {}) {
  return withCoordStateLock(() => {
    const currentRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (options.expectedRaw !== undefined && currentRaw !== options.expectedRaw) {
      fail(
        `Refusing to overwrite ${path.relative(ROOT_DIR, filePath)} because it changed during this command. ` +
        `Re-run against the latest coord state.`
      );
    }
    writeFileAtomicSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`);
  });
}

function readJsonFileState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        raw: null,
        value: null,
        error: null,
      };
    }
    return {
      exists: false,
      raw: null,
      value: null,
      error,
    };
  }

  try {
    return {
      exists: true,
      raw,
      value: JSON.parse(raw),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      raw,
      value: null,
      error,
    };
  }
}

function safeReadJson(filePath) {
  return readJsonFileState(filePath).value;
}

function formatJsonFileIssue(filePath, label, state) {
  if (!state?.exists) {
    return `${label} at ${filePath} is missing.`;
  }
  if (state.error instanceof SyntaxError) {
    return `${label} at ${filePath} is not valid JSON: ${state.error.message}`;
  }
  if (state.error) {
    return `Could not read ${label} at ${filePath}: ${state.error.message}`;
  }
  return `${label} at ${filePath} is invalid.`;
}

function readJsonArrayFileOrFail(filePath, label) {
  const state = readJsonFileState(filePath);
  if (!state.exists || state.error) {
    fail(formatJsonFileIssue(filePath, label, state));
  }
  if (!Array.isArray(state.value)) {
    fail(`Invalid ${label} at ${filePath}. Expected a JSON array.`);
  }
  return state.value;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readLastNonEmptyLine(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    return null;
  }

  const fd = fs.openSync(filePath, "r");
  const chunkSize = 4096;
  let position = stat.size;
  let buffer = "";
  try {
    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      buffer = chunk.toString("utf8") + buffer;
      const lines = buffer
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 1 || (position === 0 && lines.length > 0)) {
        return lines[lines.length - 1];
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function canonicalSyncablePaths() {
  return [
    path.relative(COORD_DIR, DEFAULT_PATHS.renderedTasksMdPath),
    path.relative(COORD_DIR, DEFAULT_PATHS.renderedPromptIndexMdPath),
    path.relative(COORD_DIR, DEFAULT_PATHS.planPath),
    // ENT-001: the durable governance-evidence buckets. Un-ignored in
    // .gitignore (journal + canonical plan records), they join the
    // scope-limited sync commit set so each lifecycle boundary
    // (finalize/land/mark-done) durably commits the evidence a fresh clone needs
    // to validate its own board. These are DIRECTORY/FILE pathspecs — git
    // status/add scope to them recursively, so newly-written plan shards are
    // picked up. Locks/sessions/agents.json/gate-procs stay ignored and are
    // NEVER in this set. The board-predates-journal freshness advisory clears
    // because the journal is committed in the SAME sync commit as the board.
    //
    // COORD-105: the per-mutation governance-snapshots/ HISTORY bucket is
    // intentionally NOT in this set (nor tracked). board validate never reads
    // it, and tracking it caused unbounded git bloat (2427+ files / ~28MB, no
    // pruning, growing every mutation).
    //
    // COORD-108: governance-latest-snapshot.json (the single board-state-at-
    // last-mutation pointer) is likewise NOT in this set (nor tracked). It
    // MUTATES on every gov command, so tracking it left the worktree
    // perpetually dirty; it is a regenerable pointer that board validate /
    // fresh-clone never reads (the durable evidence is the journal + plan
    // records). It stays on local disk as recovery scratch.
    path.relative(COORD_DIR, DEFAULT_PATHS.governanceEventLogPath),
    path.relative(COORD_DIR, DEFAULT_PATHS.planRecordsDir),
  ].map((p) => p.split(path.sep).join("/"));
}

function computeSyncDelta(repoRoot, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const topResult = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" }
  );
  if (topResult.status !== 0) {
    fail(
      `git rev-parse --show-toplevel failed from ${repoRoot}: ` +
        String(topResult.stderr || "").trim()
    );
  }
  const topLevel = String(topResult.stdout || "").trim();
  const rel = path.relative(topLevel, repoRoot).split(path.sep).join("/");
  const prefix = rel === "" || rel === "." ? "" : `${rel}/`;
  // Map each git-reported (repo-top-relative) path back to the ORIGINAL
  // coord-relative pathspec the caller passed. A pathspec matches a reported
  // path when it is identical OR is a DIRECTORY ancestor of it. ENT-001: the
  // durable .runtime/plans bucket is a directory pathspec, so newly-written
  // plan shards are matched here.
  const prefixedToOriginal = new Map(); // exact-file pathspecs
  const dirPrefixes = []; // { prefixed: "<top-rel-dir>/", original }
  for (const p of paths) {
    const prefixed = `${prefix}${p}`;
    prefixedToOriginal.set(prefixed, p);
    dirPrefixes.push({ prefixed: `${prefixed}/`, original: p });
  }

  // `-uall` lists untracked files individually (otherwise git collapses an
  // untracked directory to a single `?? dir/` entry that matches no exact
  // pathspec) so directory pathspecs pick up their contents.
  const status = spawnSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain=v1", "-uall", "--", ...paths],
    { encoding: "utf8" }
  );
  if (status.status !== 0) {
    fail(
      `git status failed in ${repoRoot}: ` +
        String(status.stderr || "").trim()
    );
  }
  const set = new Set();
  for (const line of String(status.stdout || "").split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length < 4) continue;
    // Strip the 2-char XY status + space; git quotes paths with special
    // chars in double quotes — unquote so the map lookup matches.
    let p = trimmed.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    // Rename entries are "old -> new"; the new path is what's staged.
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    const exact = prefixedToOriginal.get(p);
    if (exact) {
      set.add(exact);
      continue;
    }
    const dirMatch = dirPrefixes.find((d) => p.startsWith(d.prefixed));
    if (dirMatch) set.add(dirMatch.original);
  }
  return [...set].sort();
}

module.exports = {
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  canonicalSyncablePaths,
  computeSyncDelta,
  ensureParentDir,
  formatJsonFileIssue,
  readCanonicalJsonFile,
  readCanonicalTextFile,
  readJsonArrayFileOrFail,
  readJsonFileState,
  readLastNonEmptyLine,
  safeReadJson,
  writeCanonicalJsonFile,
  writeCanonicalTextFile,
  writeFileAtomicSync,
  writeJsonFile,
};
