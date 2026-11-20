"use strict";

const path = require("node:path");

const DEFAULT_DENIED_PATTERNS = Object.freeze([
  /(^|[\\/])\.env(?:\.[^/\\]+)?$/i,
  /(^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(^|[\\/])\.aws(?:[\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud(?:[\\/]|$)/i,
  /(^|[\\/])(?:credentials?|secrets?|private[-_]?keys?)(?:[.\\/]|$)/i,
  /(^|[\\/])(?:keychains?|browser[-_ ]?profiles?)(?:[.\\/]|$)/i,
  /(^|[\\/])(?:\.claude|\.codex)(?:[\\/]|$)/i,
]);

function absolute(value) { return path.resolve(String(value)); }

function within(root, candidate) {
  const rel = path.relative(absolute(root), absolute(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function makePatterns(patterns = []) {
  return [...DEFAULT_DENIED_PATTERNS, ...patterns].map((entry) => entry instanceof RegExp ? entry : new RegExp(String(entry), "i"));
}

function evaluateSensitivePath(candidate, options = {}) {
  const normalized = absolute(candidate);
  const explicitExamples = (options.explicitExamples || [".env.example", ".env.sample", ".env.template"]).map((entry) => path.isAbsolute(entry) ? absolute(entry) : absolute(path.join(options.worktree || process.cwd(), entry)));
  if (explicitExamples.includes(normalized)) return { decision: "allow", reason: null, path: normalized };
  const patterns = makePatterns(options.patterns || options.deniedPatterns);
  const matched = patterns.find((pattern) => pattern.test(normalized));
  const configured = (options.sensitiveRoots || []).find((root) => within(root, normalized));
  const outside = options.worktree && !within(options.worktree, normalized);
  if (matched || configured || outside) {
    // guard:runtime-authority-hook
    return { decision: "deny", reason: matched ? "sensitive path" : configured ? "configured sensitive root" : "outside approved worktree", redacted_target: "[REDACTED_PATH]" };
  }
  return { decision: "allow", reason: null, path: normalized };
}

// guard:runtime-authority-hook
function assertSafePath(candidate, options = {}) {
  const result = evaluateSensitivePath(candidate, options);
  if (result.decision !== "allow") {
    const error = new Error(`managed-auto denied path: ${result.reason}`);
    error.code = "MANAGED_AUTO_PATH_DENIED";
    throw error;
  }
  return result.path;
}

module.exports = { DEFAULT_DENIED_PATTERNS, assertSafePath, evaluateSensitivePath, within };
