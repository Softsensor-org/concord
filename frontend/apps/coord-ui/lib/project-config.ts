import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import {
  COORD_DIR,
  PROJECT_ROOT,
  WORKSPACE_ROOT,
  resolveRepoScope,
  sanitizeProjectConfig,
  type RepoScopeStatus
} from './coord-paths';
import { requireExternal, uncacheExternal } from './external-require';

/**
 * SEC-002 — executable-config trust posture.
 *
 * `coord/project.config.js` is loaded via `createRequire` (executable JS),
 * which means evaluating it runs server-side code. We KEEP `createRequire`
 * deliberately: project.config.js is the coord ENGINE's canonical config seam
 * — paths.js, the board, and the scripts all `require()` the very same file as
 * executable config. Forking coord-ui onto a divergent data-only loader would
 * break that single-source contract. The file therefore lives at the SAME
 * TRUST LEVEL as engine code: it is part of the repo's trusted surface, edited
 * only through reviewed commits, never from any request/UNTRUSTED input.
 *
 * What SEC-002 adds on top of that trust assumption (defense in depth):
 *   1. The require path is a FIXED, in-workspace location (COORD_DIR/
 *      project.config.js). No request data, query param, or header ever reaches
 *      the require() argument — there is no dynamic module path.
 *   2. The fields coord-ui actually consumes are VALIDATED to a known shape
 *      after load (sanitizeConfig) — a malformed/unexpected config degrades to
 *      empty rather than propagating untyped values into the UI.
 *   3. Every resolved repo `dir` is CONFINED by the SEC-002 repo boundary to the
 *      explicitly CONFIGURED repository roots — canonicalized through realpath,
 *      bounded by the coord workspace, and opt-in-extendable only via an
 *      explicit operator allowlist — so even a trusted-but-wrong config edit
 *      cannot point the git/dirty-repo views at arbitrary paths. A repo that
 *      fails that test is REPORTED as unavailable/out-of-scope (COORD-543); it
 *      is never silently replaced with a different tree.
 *   4. This module performs NO writes and NO process spawning — load is a pure
 *      read + validate.
 */

// Repo model derived from coord/project.config.js. The UI is config-driven:
// repo codes, paths, display names, roots, and integration branches all come
// from here rather than from any hardcoded project layout.
export interface RepoModel {
  code: string; // single-letter repo code (e.g. "B", "F"); "X" for coord
  path: string; // path relative to the project root
  /**
   * Absolute, realpath-canonicalized directory to inspect — or `null` when the
   * repo is unavailable/out-of-scope. COORD-543: `null` is load-bearing. Callers
   * MUST branch on it and surface the status; there is deliberately no fallback
   * directory, because substituting one is what made the cockpit report
   * confident numbers about a tree it was not looking at.
   */
  dir: string | null;
  name: string; // display name (directory basename)
  integrationBranch: string;
  /** 'ok' | 'unavailable' | 'out-of-scope' (COORD-543). */
  status: RepoScopeStatus;
  /** Operator-facing explanation when `status !== 'ok'`. */
  statusReason: string | null;
}

interface RawRepoConfig {
  path?: string;
  integrationBranch?: string;
}

interface RawProjectConfig {
  repos?: Record<string, RawRepoConfig>;
}

const DEFAULT_INTEGRATION_BRANCH = 'dev';

// PROJECT_ROOT and the path boundary are owned by coord-paths.ts (SEC-002);
// re-export PROJECT_ROOT for backwards compatibility with existing importers.
export { PROJECT_ROOT };
const CONFIG_PATH = path.join(COORD_DIR, 'project.config.js');

function loadRawConfig(): RawProjectConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    // FIXED in-workspace require path — never built from request input (SEC-002).
    // Bust the require cache so edits are reflected without a restart in dev.
    uncacheExternal(CONFIG_PATH);
    // Validate to the consumed shape via the shared, tested core (SEC-002).
    return sanitizeProjectConfig(requireExternal(CONFIG_PATH)) as RawProjectConfig;
  } catch {
    return {};
  }
}

// Re-export the workspace bound for diagnostics/config views (COORD-543).
export { WORKSPACE_ROOT };

// Product repos declared in project.config.js. "X" is reserved for cross-repo /
// coord-only work and is excluded here.
//
// COORD-543: each declared repo is resolved through the shared SEC-002 repo
// boundary (allowlist of the configured roots, realpath-canonicalized, bounded
// by the coord workspace). A repo that cannot be resolved comes back with
// `dir: null` and an explicit status — NEVER clamped to PROJECT_ROOT.
export function productRepos(): RepoModel[] {
  const repos = loadRawConfig().repos ?? {};
  const productOnly: Record<string, RawRepoConfig> = {};
  for (const [code, cfg] of Object.entries(repos)) {
    if (code.toUpperCase() === 'X') continue;
    productOnly[code] = cfg ?? {};
  }

  const scope = resolveRepoScope(productOnly);
  return scope.entries.map((entry) => {
    const cfg = productOnly[entry.code] ?? {};
    return {
      code: entry.code,
      path: entry.declaredPath,
      dir: entry.dir,
      name: path.basename(entry.declaredPath),
      integrationBranch:
        typeof cfg?.integrationBranch === 'string' && cfg.integrationBranch
          ? cfg.integrationBranch
          : DEFAULT_INTEGRATION_BRANCH,
      status: entry.status,
      statusReason: entry.status === 'ok' ? null : entry.reason
    };
  });
}

// The coord governance repo is not listed in `repos` (X is reserved) but is a
// real repo on disk that the git / dirty-repo views care about.
export function coordRepo(): RepoModel {
  const rel = path.relative(PROJECT_ROOT, COORD_DIR) || path.basename(COORD_DIR);
  return {
    code: 'X',
    path: rel,
    dir: COORD_DIR,
    name: path.basename(COORD_DIR),
    integrationBranch: DEFAULT_INTEGRATION_BRANCH,
    status: 'ok',
    statusReason: null
  };
}

/**
 * COORD-543 — repos the cockpit could NOT resolve. Views render these
 * explicitly so an operator sees "not inspected, and here is why" instead of a
 * confident number computed from the wrong tree.
 */
export function unresolvedRepos(): RepoModel[] {
  return productRepos().filter((r) => r.status !== 'ok');
}

// Product repos plus the coord governance repo — the full set inspected for
// git status and the dirty-repo denominator.
export function allRepos(): RepoModel[] {
  return [...productRepos(), coordRepo()];
}
