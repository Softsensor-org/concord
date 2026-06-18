import fs from 'node:fs';
import path from 'node:path';
import { requireExternal } from './external-require';

const ENV_COORD = process.env.COORD_DIR;

const ENV_REQUIREMENTS =
  process.env.COORD_REQUIREMENTS_PATH ?? process.env.REQUIREMENTS_PATH ?? process.env.URS_PATH;

// SEC-002 — path trust-boundary core. Pure, zero-dep CJS module loaded in
// process (the SEC-001 core-module pattern). It performs only string path
// arithmetic — no fs, no writes, no spawn — and is the single source of truth
// shared with coord/scripts/coord-ui-path-boundary.test.js so the served
// behavior and the gate cannot drift.
interface PathBoundaryCore {
  assertWithinBoundary: (opts: {
    projectRoot: string;
    candidate: string;
    allowlist?: string[];
    label?: string;
  }) => string;
  evaluatePath: (opts: {
    projectRoot: string;
    candidate: string;
    allowlist?: string[];
    label?: string;
  }) => { allowed: boolean; resolved: string; reason: string; error: string | null };
  parseAllowlist: (raw: string | undefined | null) => string[];
  sanitizeProjectConfig: (raw: unknown) => {
    repos: Record<string, { path?: string; integrationBranch?: string }>;
  };
}

function loadBoundaryCore(coordDir: string): PathBoundaryCore {
  const modPath = path.join(coordDir, 'scripts', 'coord-ui-path-boundary.js');
  return requireExternal<PathBoundaryCore>(modPath);
}

function findUpward(start: string, name: string): string | null {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, name);
    if (fs.existsSync(candidate)) return candidate;
    const next = path.dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
  return null;
}

function resolveCoordDir(): string {
  if (ENV_COORD && fs.existsSync(ENV_COORD)) return path.resolve(ENV_COORD);
  // From frontend/apps/coord-ui, the standard layout has coord/ as a sibling
  // of frontend/ — so two levels up plus '../coord'.
  const direct = path.resolve(process.cwd(), '../../../coord');
  if (fs.existsSync(direct)) return direct;
  const upward = findUpward(process.cwd(), 'coord');
  if (upward) return upward;
  throw new Error(
    `Could not locate coord/ directory. Set COORD_DIR env var. Tried cwd=${process.cwd()}, direct=${direct}.`
  );
}

export const COORD_DIR = resolveCoordDir();

// SEC-002 — the workspace boundary. PROJECT_ROOT is one level above coord/
// (the project.config.js contract); coord-ui reads are confined to it unless
// an explicit operator allowlist opts a location back in.
//
// Setting COORD_DIR is itself a documented operator TRUST DECISION: it selects
// which workspace coord-ui mirrors, and therefore defines PROJECT_ROOT. The
// path env vars below (requirements/URS doc, screen-apps dir) are the
// disclosure / path-traversal vectors that this boundary actually guards —
// they must resolve INSIDE PROJECT_ROOT (or an allowlisted root) or coord-ui
// refuses to load with a clear error.
export const PROJECT_ROOT = path.dirname(COORD_DIR);

const boundaryCore = loadBoundaryCore(COORD_DIR);
const PATH_ALLOWLIST = boundaryCore.parseAllowlist(process.env.COORD_UI_PATH_ALLOWLIST);

/**
 * Enforce the allowed-root boundary on an operator-supplied path. Returns the
 * resolved path when inside PROJECT_ROOT (or allowlisted); throws a clear error
 * otherwise. Pure delegation to the tested boundary core.
 */
function enforceBoundary(candidate: string, label: string): string {
  return boundaryCore.assertWithinBoundary({
    projectRoot: PROJECT_ROOT,
    candidate,
    allowlist: PATH_ALLOWLIST,
    label
  });
}

/**
 * SEC-002 — non-throwing boundary check for callers that filter rather than
 * fail (e.g. project-config.ts confining per-repo dirs). Returns true when
 * `candidate` resolves inside PROJECT_ROOT or an allowlisted root.
 */
export function isPathWithinWorkspace(candidate: string): boolean {
  return boundaryCore.evaluatePath({
    projectRoot: PROJECT_ROOT,
    candidate,
    allowlist: PATH_ALLOWLIST
  }).allowed;
}

/**
 * SEC-002 — re-export the shared, tested config-shape validator so
 * project-config.ts validates project.config.js through the single source of
 * truth (coord/scripts/coord-ui-path-boundary.js) rather than a parallel copy.
 */
export function sanitizeProjectConfig(raw: unknown): {
  repos: Record<string, { path?: string; integrationBranch?: string }>;
} {
  return boundaryCore.sanitizeProjectConfig(raw);
}

export const RUNTIME_DIR = path.join(COORD_DIR, '.runtime');
export const LOCKS_DIR = path.join(RUNTIME_DIR, 'locks');
export const EVENT_LOG_PATH = path.join(RUNTIME_DIR, 'governance-events.ndjson');
export const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'governance-latest-snapshot.json');
export const AGENTS_PATH = path.join(RUNTIME_DIR, 'agents.json');
export const AGENT_SESSIONS_PATH = path.join(RUNTIME_DIR, 'agent_sessions.json');
export const BOARD_PATH = path.join(COORD_DIR, 'board', 'tasks.json');
export const ACTIVE_DIR = path.join(COORD_DIR, 'active');

// Plan records moved to the coord runtime plans dir; older workspaces still
// keep them under the legacy board plans dir. Prefer runtime, fall back to
// legacy, and default to the runtime path when neither exists so readers
// degrade to an empty dir.
function resolvePlanRecordsDir(): string {
  const runtimePlans = path.join(RUNTIME_DIR, 'plans');
  if (fs.existsSync(runtimePlans)) return runtimePlans;
  const legacyPlans = path.join(COORD_DIR, 'board', 'plans');
  if (fs.existsSync(legacyPlans)) return legacyPlans;
  return runtimePlans;
}

export const PLAN_RECORDS_DIR = resolvePlanRecordsDir();

// Derived screen/requirement index artifact (runtime; written by the
// generator, read by the dashboard — never written from the web tier).
export const SCREEN_INDEX_PATH = path.join(RUNTIME_DIR, 'screen-index.json');

function resolveFromCoord(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(COORD_DIR, value);
}

function defaultRequirementCandidates(): string[] {
  return [
    path.join(COORD_DIR, 'product', 'REQUIREMENTS.md'),
    path.join(COORD_DIR, 'product', 'LAST_MILE_OPS_URS.md'),
    path.join(COORD_DIR, 'REQUIREMENTS.md'),
    path.join(COORD_DIR, 'LAST_MILE_OPS_URS.md')
  ];
}

function resolveRequirementsPath(): string {
  if (ENV_REQUIREMENTS) {
    // SEC-002 — operator-supplied requirements/URS doc must stay inside the
    // workspace (or be allowlisted), else refuse with a clear error.
    return enforceBoundary(
      resolveFromCoord(ENV_REQUIREMENTS),
      'COORD_REQUIREMENTS_PATH/REQUIREMENTS_PATH/URS_PATH'
    );
  }

  const candidates = defaultRequirementCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function coordRelativeLabel(filePath: string): string {
  const rel = path.relative(COORD_DIR, filePath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : filePath;
}

export const REQUIREMENTS_PATH = resolveRequirementsPath();
export const REQUIREMENTS_DOC_LABEL = coordRelativeLabel(REQUIREMENTS_PATH);

// Backwards-compatible alias for downstream callers that still say "URS".
// The configured requirements document is the canonical source.
export const URS_PATH = REQUIREMENTS_PATH;

// Frontend apps directory (sibling of coord-ui). Resolved from the running
// coord-ui package so it works in worktrees and deploys alike.
function resolveFrontendAppsDir(): string {
  const env = process.env.SCREEN_APPS_DIR;
  if (env && fs.existsSync(env)) {
    // SEC-002 — operator-supplied screen-apps dir must stay inside the
    // workspace (or be allowlisted), else refuse with a clear error.
    return enforceBoundary(path.resolve(env), 'SCREEN_APPS_DIR');
  }
  const sibling = path.resolve(process.cwd(), '..');
  if (fs.existsSync(path.join(sibling, 'coord-ui'))) return sibling;
  const upward = findUpward(process.cwd(), 'apps');
  if (upward && fs.existsSync(path.join(upward, 'coord-ui'))) return upward;
  return sibling;
}

export const FRONTEND_APPS_DIR = resolveFrontendAppsDir();
