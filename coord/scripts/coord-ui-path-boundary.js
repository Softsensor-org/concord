'use strict';

/**
 * SEC-002 — coord-ui path trust-boundary core.
 *
 * Zero-dependency, pure CJS module. SINGLE source of truth for the allowed-root
 * path semantics shared by lib/coord-paths.ts (the running app) and the
 * node:test suite (coord-ui-path-boundary.test.js) — exactly the in-process
 * core-module pattern SEC-001 used for coord-ui-access-core.js, so the served
 * behavior and the gate cannot drift.
 *
 * STRICTLY READ-ONLY logic: this module decides whether a *resolved* filesystem
 * path is permitted relative to a project root + an explicit allowlist. It
 * performs NO fs access, NO writes, and NO process spawning — it is pure path
 * arithmetic over strings, safe to evaluate on every read.
 *
 * Trust model
 * -----------
 *   - PROJECT_ROOT is the workspace boundary. coord-ui reads are expected to
 *     stay within it.
 *   - A candidate path is PERMITTED when it resolves to PROJECT_ROOT itself or
 *     a descendant of it (a "contained" path).
 *   - A candidate OUTSIDE PROJECT_ROOT is REJECTED by default with a clear
 *     error — this is the path-traversal / file-disclosure guard.
 *   - An operator may opt specific outside-root locations back in via an
 *     explicit allowlist (COORD_UI_PATH_ALLOWLIST, see lib/coord-paths.ts).
 *     Adding an allowlist entry is an explicit operator trust decision.
 */

const path = require('node:path');

/**
 * True when `candidate` is `root` itself or strictly contained within it.
 * Both inputs are resolved to absolute, normalized paths first so that
 * `..` traversal segments cannot escape the root undetected.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isWithinRoot(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  // Contained iff the relative path does not climb out (`..`) and is not
  // absolute (which happens on a different drive/root on some platforms).
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when `candidate` resolves to an allowlisted location: it equals, or is
 * contained within, any of the provided allowlist roots. Each allowlist entry
 * is itself resolved to absolute first.
 *
 * @param {string} candidate
 * @param {string[]} allowlist
 * @returns {boolean}
 */
function isAllowlisted(candidate, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || !entry) continue;
    if (isWithinRoot(entry, candidate)) return true;
  }
  return false;
}

/**
 * Decide whether a candidate path is permitted under the trust boundary.
 * Pure: returns a verdict object, never throws.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot   The workspace boundary (absolute or relative; resolved here).
 * @param {string} opts.candidate     The path under consideration (absolute or relative; resolved here).
 * @param {string[]} [opts.allowlist] Explicit opt-in outside-root roots.
 * @param {string}   [opts.label]     Human label for the env var / source, used in the error message.
 * @returns {{ allowed: boolean, resolved: string, reason: string, error: string|null }}
 */
function evaluatePath(opts) {
  const { projectRoot, candidate, allowlist = [], label = 'path' } = opts || {};
  const resolved = typeof candidate === 'string' && candidate ? path.resolve(candidate) : '';

  if (!resolved) {
    return {
      allowed: false,
      resolved,
      reason: 'empty',
      error: `coord-ui path-boundary: ${label} is empty or unresolvable.`,
    };
  }

  if (isWithinRoot(projectRoot, candidate)) {
    return { allowed: true, resolved, reason: 'within-root', error: null };
  }

  if (isAllowlisted(candidate, allowlist)) {
    return { allowed: true, resolved, reason: 'allowlisted', error: null };
  }

  return {
    allowed: false,
    resolved,
    reason: 'outside-root',
    error:
      `coord-ui path-boundary: ${label} resolves to "${resolved}", which is OUTSIDE ` +
      `the project root "${path.resolve(projectRoot || '')}". ` +
      `This is rejected by default to prevent disclosure of files outside the workspace. ` +
      `If this location is intentional, add it (or a parent dir) to COORD_UI_PATH_ALLOWLIST ` +
      `(an explicit operator trust decision).`,
  };
}

/**
 * Enforcing wrapper: returns the resolved path when permitted, throws a clear
 * Error when rejected. lib/coord-paths.ts uses this to fail loudly at module
 * load on an outside-root, non-allowlisted path.
 *
 * @param {object} opts — same shape as evaluatePath.
 * @returns {string} the resolved, permitted path.
 */
function assertWithinBoundary(opts) {
  const verdict = evaluatePath(opts);
  if (!verdict.allowed) {
    throw new Error(verdict.error);
  }
  return verdict.resolved;
}

/**
 * Parse a path allowlist from a delimited env string. Splits on the OS path
 * delimiter (`:` on POSIX, `;` on Windows) and also accepts commas, trims, and
 * drops empties. Pure — does not read the environment itself.
 *
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
function parseAllowlist(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[,]|[:;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * SEC-002 — validate project.config.js to the shape coord-ui consumes.
 *
 * project.config.js is trusted (engine config seam, edited only via reviewed
 * commits) but this is defense-in-depth: a malformed/unexpected config shape
 * degrades to a known `{ repos: {...} }` value with only string fields kept,
 * rather than leaking untyped values into the UI. Pure — does not require() or
 * read anything; the caller passes the already-loaded value.
 *
 * @param {unknown} raw
 * @returns {{ repos: Record<string, { path?: string, integrationBranch?: string }> }}
 */
function sanitizeProjectConfig(raw) {
  if (!raw || typeof raw !== 'object') return { repos: {} };
  const reposRaw = raw.repos;
  if (!reposRaw || typeof reposRaw !== 'object') return { repos: {} };
  const repos = {};
  for (const [code, cfg] of Object.entries(reposRaw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const entry = {};
    if (typeof cfg.path === 'string') entry.path = cfg.path;
    if (typeof cfg.integrationBranch === 'string') entry.integrationBranch = cfg.integrationBranch;
    repos[code] = entry;
  }
  return { repos };
}

module.exports = {
  isWithinRoot,
  isAllowlisted,
  evaluatePath,
  assertWithinBoundary,
  parseAllowlist,
  sanitizeProjectConfig,
};
