"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadShimRegistry } = require("../../paths.js");

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function decodeSource(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

function readBaselineCoverageSources({ workspaceRoot, contentRoot, sourceCommit, file, expectedCurrentHash, historyRoot, historyHead = "HEAD" }) {
  const pinnedHistory = !historyRoot || (path.isAbsolute(historyRoot) && /^[0-9a-f]{40}$/.test(historyHead));
  if (typeof workspaceRoot !== "string" || typeof contentRoot !== "string" || !pinnedHistory ||
      !/^[0-9a-f]{40}$/.test(sourceCommit || "") || typeof file !== "string" ||
      file.includes("\\") || file.includes(":") || file.startsWith("/") ||
      file.split("/").some((part) => part === "" || part === "." || part === "..")) return null;

  let workspace;
  let content;
  try {
    workspace = fs.realpathSync(path.resolve(workspaceRoot));
    content = fs.realpathSync(path.resolve(contentRoot));
  } catch {
    return null;
  }
  if (!isWithin(workspace, content)) return null;

  const relativeContent = path.relative(workspace, content).split(path.sep).join("/");
  const read = (name) => readBaselineBlob(historyRoot || workspace, sourceCommit, [relativeContent, name].filter(Boolean).join("/"));

  const currentPath = path.resolve(content, ...file.split("/"));

  let currentBuffer;
  try {
    if (!fs.lstatSync(currentPath).isFile()) return null;
    if (!isWithin(content, fs.realpathSync(currentPath))) return null;
    currentBuffer = fs.readFileSync(currentPath);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(expectedCurrentHash || "") ||
      crypto.createHash("sha256").update(currentBuffer).digest("hex") !== expectedCurrentHash) return null;
  const currentSource = decodeSource(currentBuffer);
  if (currentSource === null) return null;

  let baselineSource = read(file);
  // Only a blob that is ABSENT at the baseline commit may fall back to a
  // registered move's legacy path; a present but undecodable blob fails closed.
  if (baselineSource === BLOB_ABSENT) {
    const legacy = registeredLegacyPath(content, file);
    baselineSource = legacy === null ? null : read(legacy);
  }
  if (typeof baselineSource !== "string") return null;
  return { currentSource, baselineSource, baselineHistory: () => baselineHistory(historyRoot || workspace, content, sourceCommit, relativeContent, file, historyHead) };
}

const BLOB_ABSENT = Symbol("blob absent at baseline commit");

// Returns the decoded source, null when the blob exists but is not valid
// UTF-8, or BLOB_ABSENT when Git has no such blob at the commit.
function readBaselineBlob(workspace, sourceCommit, sourcePath) {
  const blob = spawnSync("git", ["--no-replace-objects", "cat-file", "blob", `${sourceCommit}:${sourcePath}`], {
    cwd: workspace,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (blob.error || blob.status !== 0) return BLOB_ABSENT;
  return decodeSource(blob.stdout);
}

// COORD-864 (human-admin decision 2026-10-27): a module the COORD-589
// migration moved under engine/ has no source at its engine path in a baseline
// measured before the move. Only when the shim registry records that exact move
// (legacy path -> this engine target) is the legacy path at the baseline commit
// its baseline source; an unregistered move, or an unreadable registry, stays
// unavailable and fails closed.
function registeredLegacyPath(contentRoot, file) {
  if (!file.startsWith("engine/")) return null;
  let registry;
  try {
    registry = loadShimRegistry(contentRoot);
  } catch {
    return null;
  }
  const shim = registry.shims.find((entry) => entry.target === file);
  return shim ? shim.path : null;
}

module.exports = { readBaselineCoverageSources, registeredLegacyPath };

// COORD-881: a scoped baseline splice (COORD-864..868) records a moved file's
// findings measured on a commit after source_commit, so the source_commit blob
// cannot be the relocation anchor for that file. Offer every committed version
// of the file since source_commit, newest first; the ratchet adopts one only if
// it reproduces every baseline range digest recorded for the file.
const BASELINE_HISTORY_LIMIT = 64;
function baselineHistory(workspace, content, sourceCommit, relativeContent, file, head = "HEAD") {
  const legacy = registeredLegacyPath(content, file);
  const paths = [file, legacy].filter(Boolean).map((item) => [relativeContent, item].filter(Boolean).join("/"));
  const log = spawnSync("git", ["--no-replace-objects", "log", "--format=%H", "-n", String(BASELINE_HISTORY_LIMIT), `${sourceCommit}..${head}`, "--", ...paths],
    { cwd: workspace, encoding: "utf8" });
  if (log.error || log.status !== 0) return [];
  const sources = [];
  for (const commit of log.stdout.split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line))) {
    const source = paths.map((item) => readBaselineBlob(workspace, commit, item)).find((blob) => typeof blob === "string");
    if (source !== undefined && !sources.includes(source)) sources.push(source);
  }
  return sources;
}
module.exports.baselineHistory = baselineHistory;
