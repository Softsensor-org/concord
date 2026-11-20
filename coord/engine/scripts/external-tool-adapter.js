"use strict";

// COORD-986 (ARCH-AUDIT F-05): the shared skeleton of the quality-dimension external-tool adapters
// (a11y, mutation, perf-budget, sast, supply-chain). Each adapter keeps its own parsing, policy,
// reason strings and output shape; this module owns only the parts that were byte-for-byte
// repeated: the PATH lookup, the override -> repo-local node_modules/.bin -> PATH binary chain, the
// table-driven "first available tool" selector, and the `classify` argv shell. Detection-only: no
// tool is executed here.
const fs = require("node:fs");
const path = require("node:path");

// Resolve a binary name against PATH without spawning anything. Pure fs.
function defaultLookPath(bin, environ) {
  const PATH = (environ && environ.PATH) || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      if (fs.existsSync(full)) return full;
      if (process.platform === "win32" && fs.existsSync(full + ".exe")) return full + ".exe";
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return null;
}

// Resolve one binary: the env override (when it exists), then the repo-local
// node_modules/.bin (or its .cmd shim), then PATH. `spec.onPath === false` skips PATH (a dev
// dependency the engine never looks up system-wide). Returns the resolved path or null.
function resolveBin(spec, repoRoot, { fileExists, lookPath, env } = {}) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  const environ = env || process.env;
  if (spec.overrideKey && environ[spec.overrideKey] && exists(environ[spec.overrideKey])) return environ[spec.overrideKey];
  const local = path.join(repoRoot, "node_modules", ".bin", spec.bin);
  if (exists(local)) return local;
  if (exists(local + ".cmd")) return local + ".cmd";
  if (spec.onPath === false) return null;
  const onPath = (lookPath || defaultLookPath)(spec.bin, environ);
  if (onPath) return onPath;
  return null;
}

// Pick the first tool that resolves. `table` = { preferEnv?, tools: [{ name, bin, overrideKey?, onPath? }],
// unavailable }. When `preferEnv` names a tool in the table (case-insensitive value of that env var),
// that tool is tried first; otherwise the table order applies. Returns { available, tool, bin, reason }.
function selectTool(table, repoRoot, deps = {}) {
  const environ = deps.env || process.env;
  const prefer = table.preferEnv ? String(environ[table.preferEnv] || "").toLowerCase() : "";
  const names = table.tools.map((t) => t.name);
  const order = names.includes(prefer) ? [prefer, ...names.filter((n) => n !== prefer)] : names.slice();
  for (const name of order) {
    const tool = table.tools.find((t) => t.name === name);
    const bin = resolveBin(tool, repoRoot, deps);
    if (bin) return { available: true, tool: name, bin, reason: null };
  }
  return { available: false, tool: null, bin: null, reason: table.unavailable };
}

// The shared `classify` argv shell. `flags` maps a flag to { key, number? }; a flag consumes the
// next argv token (converted with Number when `number` is set), exactly as the adapters' own loops
// did. Unknown tokens are ignored. Returns { opts } on success, or { code: 2 } after writing the
// usage text (non-classify verb) or the labelled --root refusal to `err`.
function parseClassifyArgv(argv, err, { label, usage, defaultMode, flags }) {
  if (argv[0] !== "classify") {
    err.write(usage);
    return { code: 2 };
  }
  const opts = { mode: defaultMode };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!Object.prototype.hasOwnProperty.call(flags, a)) continue;
    const { key, number } = flags[a];
    const value = argv[++i];
    opts[key] = number ? Number(value) : value;
  }
  if (!opts.repoRoot) {
    err.write(`${label}: ERROR --root <repo> is required\n`);
    return { code: 2 };
  }
  return { opts };
}

module.exports = { defaultLookPath, resolveBin, selectTool, parseClassifyArgv };
