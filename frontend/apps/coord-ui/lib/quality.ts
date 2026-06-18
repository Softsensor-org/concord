import 'server-only';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';
import { PROJECT_ROOT, coordRepo, productRepos } from './project-config';
import { BOARD_PATH } from './coord-paths';
import fs from 'node:fs';

/**
 * UI-004 — /quality cockpit data surface.
 *
 * Server-only, strictly read-only. Composes the SAME two coord libraries the
 * `gov quality-scan` / arch gate CLIs use, by importing their pure exported
 * APIs (no shelling out from the request path):
 *   - coord/scripts/arch-checks.js   → scanRepo({ root }) → { findings, summary }
 *   - coord/scripts/quality-scan.js  → planTickets({ findings, board, ... })
 *
 * RESOURCE DISCIPLINE: a full-repo arch scan reads + analyzes every .js/.mjs/
 * .cjs file, which is heavy. The arch-checks scan helper already excludes
 * node_modules/.git/.worktrees/artifacts/.next/tests via its ignore list. The
 * cockpit is therefore SCOPED to exactly ONE root per request (COORD-109): a
 * scope selector picks coord/ (default), a product repo (per project.config.js
 * REPO_ROOTS), or the whole template — but only the selected root is ever
 * scanned. We NEVER scan all roots at once on render, and a defensive file cap
 * (SCAN_FILE_CAP) bounds even a large product tree. We never write, never
 * apply, never spawn.
 *
 * The two source modules are CommonJS, so we load them with createRequire — the
 * same mechanism project-config.ts uses for coord/project.config.js.
 */

// --- scope model (COORD-109) -------------------------------------------------

/**
 * A single scannable root the /quality cockpit can target. Resolved from the
 * project.config.js repo registry (via project-config.ts) so the set is
 * config-driven, not a hardcoded layout. EXACTLY ONE scope is scanned per
 * request — the selector never triggers an all-roots scan.
 */
export interface QualityScope {
  /** URL/searchParam value (e.g. "coord", "backend", "frontend", "template"). */
  id: string;
  /** human label shown in the toggle + header (honest about what is scanned). */
  label: string;
  /** absolute root the arch scan walks. */
  root: string;
  /** repo-relative display label of the root. */
  rootLabel: string;
  /** true when the root does not exist on disk (graceful empty state). */
  missing: boolean;
}

/** The default scope id — preserves the pre-COORD-109 behavior (scan coord/). */
export const DEFAULT_SCOPE_ID = 'coord';

function relLabel(abs: string): string {
  const rel = path.relative(PROJECT_ROOT, abs).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : abs;
}

function makeScope(id: string, label: string, root: string): QualityScope {
  return {
    id,
    label,
    root,
    rootLabel: relLabel(root) || path.basename(root),
    missing: !safeIsDir(root)
  };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The full set of scopes the cockpit can offer, in display order: coord/
 * (default) first, then each product repo from REPO_ROOTS, then the whole
 * template. Roots resolve through project-config.ts (coordRepo/productRepos),
 * so a downstream's layout is honored without code changes. Building the list
 * only stats roots — it does NOT scan any of them.
 */
export function qualityScopes(): QualityScope[] {
  const scopes: QualityScope[] = [makeScope(DEFAULT_SCOPE_ID, 'coord governance', COORD_DIR)];
  for (const repo of productRepos()) {
    // selector id is the repo's directory name (e.g. "backend"/"frontend") for
    // a readable URL; resolveScope also accepts the single-letter code as alias.
    scopes.push(makeScope(repo.name.toLowerCase(), `${repo.name} (repo ${repo.code})`, repo.dir));
  }
  scopes.push(makeScope('template', 'whole template', PROJECT_ROOT));
  return scopes;
}

/**
 * Resolve a requested scope id to a scope descriptor. Accepts the canonical id
 * (e.g. "coord", "f", "template") OR a product repo's directory name (e.g.
 * "frontend") OR its single-letter code. An unknown id falls back to the
 * DEFAULT scope (coord/) so the page never crashes on a bad param.
 */
export function resolveScope(requested?: string): QualityScope {
  const scopes = qualityScopes();
  const want = (requested ?? '').trim().toLowerCase();
  if (!want) return scopes[0];
  // direct id match (coord / template / repo-code).
  const byId = scopes.find((s) => s.id === want);
  if (byId) return byId;
  // product-repo single-letter code alias (e.g. "f" -> repo F / frontend).
  const repo = productRepos().find((r) => r.code.toLowerCase() === want);
  if (repo) return makeScope(repo.name.toLowerCase(), `${repo.name} (repo ${repo.code})`, repo.dir);
  return scopes[0];
}

// --- mirrored shapes (load-bearing: must match arch-checks/quality-scan) -----

/** arch-checks finding (makeFinding shape in coord/scripts/arch-checks.js). */
export interface ArchFinding {
  check: string;
  file: string;
  value: number | string;
  threshold: number | string;
  severity: 'warn' | 'fail' | string;
  message: string;
  line?: number;
}

/** arch-checks summarizeFindings shape. */
export interface ArchSummary {
  result: 'pass' | 'warn' | 'fail' | string;
  files: number;
  findings: number;
  failCount: number;
  warnCount: number;
  byCheck: Record<string, number>;
}

/** quality-scan findingToProposal shape (the proposed ticket card). */
export interface Proposal {
  key: string;
  check: string;
  severity: string;
  pri: string;
  file: string;
  line: number | null;
  title: string;
  description: string;
  evidence: { where: string; value: number | string; threshold: number | string; message: string };
}

/** quality-scan planTickets accounting counts (the dry-run picture). */
export interface PlanCounts {
  findings: number;
  belowFloor: number;
  skippedOpen: number;
  skippedInRun: number;
  duplicate: number;
  eligible: number;
  toFile: number;
  capped: number;
}

export interface FileFindingGroup {
  file: string;
  total: number;
  byCheck: Record<string, number>;
  fail: number;
  warn: number;
  findings: ArchFinding[];
}

export interface ComplexityHotspot {
  file: string;
  fn: string;
  value: number;
  threshold: number;
  line?: number;
  severity: string;
}

export interface DuplicationGroup {
  /** short hash (8 chars) parsed from the finding message. */
  hash: string;
  /** the duplicate site (file:line) the finding is filed against. */
  file: string;
  line?: number;
  span: number;
  /** the canonical source the duplicate is attributed to (parsed from message). */
  canonical?: string;
  severity: string;
}

export interface HardcodingCandidate {
  file: string;
  line?: number;
  value: string;
  message: string;
  severity: string;
}

export interface ScanFilters {
  check?: string;
  file?: string;
}

export interface QualityCockpit {
  /** false only if the scan itself failed to run (so the page can degrade). */
  ok: boolean;
  error?: string;
  /** the active scope (which root was scanned + the full selector set). */
  scope: QualityScope;
  /** all selectable scopes (for the server-rendered toggle). */
  scopes: QualityScope[];
  /** true when the active scope's root does not exist (graceful empty state). */
  missingRoot: boolean;
  /** repo-relative label of the scanned root (display only). */
  scanRoot: string;
  /** total .js/.mjs/.cjs files scanned. */
  fileCount: number;
  summary: ArchSummary;
  /** the active filter (echoed back so the page can highlight + clear it). */
  filters: ScanFilters;
  /** total findings before filtering (so a filtered empty state reads right). */
  totalFindings: number;
  /** findings after applying the active filter. */
  findings: ArchFinding[];
  /** distinct check names present in the unfiltered scan (for filter chips). */
  checks: string[];
  /** distinct files present in the unfiltered scan (for filter chips). */
  files: string[];
  /** per-file grouping of the (filtered) findings. */
  byFile: FileFindingGroup[];
  /** top complexity hotspots (unfiltered; highest cyclomatic first). */
  complexityHotspots: ComplexityHotspot[];
  /** duplication groups with corrected canonical-source attribution. */
  duplicationGroups: DuplicationGroup[];
  /** hardcoding (config-seam) candidates. */
  hardcodingCandidates: HardcodingCandidate[];
  /** quality-scan dry-run accounting at the cadence floor (warn) + display cap. */
  plan: {
    severityFloor: string;
    cap: number;
    counts: PlanCounts;
    proposals: Proposal[];
    /** proposals that survive floor+dedup but exceed the cap (would NOT file). */
    capped: Proposal[];
  };
}

// --- helpers -----------------------------------------------------------------

const COMPLEXITY_FN_RE = /function\s+(\S+)\s+in/;
const DUP_HASH_RE = /hash\s+([0-9a-f]+)/;
const DUP_CANONICAL_RE = /duplicates\s+(\S+?)(?:\s+\(hash|$)/;

/** Default cadence floor + display cap. Mirrors the SCHEDULED quality-scan run
 * documented in coord/product/QUALITY_AUTOMATION.md (warn floor + small cap). A
 * larger display cap than the filing default is used so the cockpit shows the
 * full "would file vs capped" split rather than truncating prematurely. */
const PLAN_SEVERITY_FLOOR = 'warn';
const PLAN_CAP = 10;

/**
 * Defensive bound on the number of source files a single scope scan will read,
 * on top of arch-checks' own node_modules/.next/artifacts/tests ignore rules.
 * A downstream product repo can be large; this keeps a request-time scan from
 * blowing memory. When tripped, the cockpit reports a truncated scan honestly
 * rather than OOM-ing. Only ONE root is ever scanned per request regardless.
 */
const SCAN_FILE_CAP = 4000;

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeFinding(raw: Record<string, unknown>): ArchFinding {
  return {
    check: String(raw.check ?? ''),
    file: String(raw.file ?? '').replace(/\\/g, '/'),
    value: typeof raw.value === 'number' ? raw.value : String(raw.value ?? ''),
    threshold: typeof raw.threshold === 'number' ? raw.threshold : String(raw.threshold ?? ''),
    severity: String(raw.severity ?? 'warn'),
    message: String(raw.message ?? ''),
    line: typeof raw.line === 'number' ? raw.line : undefined
  };
}

function readBoard(): { sections: unknown[] } {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    return { sections: [] };
  }
}

function complexityHotspots(findings: ArchFinding[]): ComplexityHotspot[] {
  return findings
    .filter((f) => f.check === 'complexity')
    .map((f) => {
      const m = COMPLEXITY_FN_RE.exec(f.message);
      return {
        file: f.file,
        fn: m ? m[1] : `function@${f.line ?? '?'}`,
        value: toNum(f.value),
        threshold: toNum(f.threshold),
        line: f.line,
        severity: f.severity
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

function duplicationGroups(findings: ArchFinding[]): DuplicationGroup[] {
  return findings
    .filter((f) => f.check === 'duplication')
    .map((f) => {
      const hm = DUP_HASH_RE.exec(f.message);
      const cm = DUP_CANONICAL_RE.exec(f.message);
      return {
        hash: hm ? hm[1] : '—',
        file: f.file,
        line: f.line,
        span: toNum(f.value),
        canonical: cm ? cm[1] : undefined,
        severity: f.severity
      };
    });
}

function hardcodingCandidates(findings: ArchFinding[]): HardcodingCandidate[] {
  return findings
    .filter((f) => f.check === 'hardcoding')
    .map((f) => ({
      file: f.file,
      line: f.line,
      value: String(f.value),
      message: f.message,
      severity: f.severity
    }));
}

function groupByFile(findings: ArchFinding[]): FileFindingGroup[] {
  const map = new Map<string, FileFindingGroup>();
  for (const f of findings) {
    let g = map.get(f.file);
    if (!g) {
      g = { file: f.file, total: 0, byCheck: {}, fail: 0, warn: 0, findings: [] };
      map.set(f.file, g);
    }
    g.total += 1;
    g.byCheck[f.check] = (g.byCheck[f.check] || 0) + 1;
    if (f.severity === 'fail') g.fail += 1;
    else g.warn += 1;
    g.findings.push(f);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || (a.file < b.file ? -1 : 1));
}

function applyFilters(findings: ArchFinding[], filters: ScanFilters): ArchFinding[] {
  return findings.filter((f) => {
    if (filters.check && f.check !== filters.check) return false;
    if (filters.file && f.file !== filters.file) return false;
    return true;
  });
}

interface ArchChecksModule {
  scanRepo: (opts: { root: string }) => { findings: Record<string, unknown>[]; summary: ArchSummary };
  collectFiles: (root: string, cfg: unknown) => string[];
  mergeConfig: (cfg?: unknown) => unknown;
  CHECKS: string[];
}

/** A zero-state cockpit for a given scope: graceful empty (missing root /
 * over-cap) or a hard scan error. Always returns the full selector set so the
 * page can still render the toggle. */
function emptyCockpit(
  scope: QualityScope,
  scopes: QualityScope[],
  checks: string[],
  filters: ScanFilters,
  opts: { ok: boolean; error?: string; missingRoot?: boolean } = { ok: true }
): QualityCockpit {
  return {
    ok: opts.ok,
    error: opts.error,
    scope,
    scopes,
    missingRoot: opts.missingRoot ?? scope.missing,
    scanRoot: scope.rootLabel,
    fileCount: 0,
    summary: {
      result: 'pass',
      files: 0,
      findings: 0,
      failCount: 0,
      warnCount: 0,
      byCheck: Object.fromEntries((checks || []).map((c) => [c, 0]))
    },
    filters,
    totalFindings: 0,
    findings: [],
    checks: [],
    files: [],
    byFile: [],
    complexityHotspots: [],
    duplicationGroups: [],
    hardcodingCandidates: [],
    plan: {
      severityFloor: PLAN_SEVERITY_FLOOR,
      cap: PLAN_CAP,
      counts: {
        findings: 0,
        belowFloor: 0,
        skippedOpen: 0,
        skippedInRun: 0,
        duplicate: 0,
        eligible: 0,
        toFile: 0,
        capped: 0
      },
      proposals: [],
      capped: []
    }
  };
}

/**
 * Run the cockpit scan for ONE scope (COORD-109). Imports the pure arch-checks
 * + quality-scan APIs and scans the SELECTED root only (default coord/) —
 * never all roots at once, bounded by SCAN_FILE_CAP on top of arch-checks'
 * own ignore rules; no shell, no writes. A missing root or an over-cap tree
 * yields a graceful empty cockpit rather than crashing or OOM-ing. `filters`
 * narrows the findings list by check and/or file for the filterable findings
 * view; the summary, hotspots, duplication, hardcoding, and plan accounting are
 * always computed over the FULL unfiltered scan so the headline picture is
 * stable regardless of the active filter.
 */
export function loadQualityCockpit(
  filters: ScanFilters = {},
  scopeId?: string
): QualityCockpit {
  const archChecks = requireExternal<ArchChecksModule>(path.join(COORD_DIR, 'scripts', 'arch-checks.js'));
  const qualityScan = requireExternal(path.join(COORD_DIR, 'scripts', 'quality-scan.js')) as {
    planTickets: (opts: {
      findings: unknown[];
      board: unknown;
      severityFloor: string;
      cap: number;
    }) => {
      toFile: Proposal[];
      capped: Proposal[];
      counts: PlanCounts;
    };
  };

  const scopes = qualityScopes();
  const scope = resolveScope(scopeId);
  const checks = archChecks.CHECKS || [];

  // Missing-root scope → graceful empty (never crash). Downstream product
  // repos vary; the template stubs are small.
  if (scope.missing) {
    return emptyCockpit(scope, scopes, checks, filters, { ok: true, missingRoot: true });
  }

  const emptySummary: ArchSummary = {
    result: 'pass',
    files: 0,
    findings: 0,
    failCount: 0,
    warnCount: 0,
    byCheck: Object.fromEntries(checks.map((c) => [c, 0]))
  };

  // BOUNDING: pre-count collectable files with arch-checks' OWN ignore rules
  // (cheap dir walk, no file-content reads). If the selected root exceeds the
  // cap, skip the heavy per-file analysis and report a truncated state. This
  // is what keeps a large product tree from OOM-ing the request.
  let rawFindings: Record<string, unknown>[] = [];
  let summary: ArchSummary = emptySummary;
  try {
    const cfg = archChecks.mergeConfig();
    const fileList = archChecks.collectFiles(scope.root, cfg);
    if (fileList.length > SCAN_FILE_CAP) {
      return emptyCockpit(scope, scopes, checks, filters, {
        ok: false,
        error: `Scope "${scope.id}" has ${fileList.length} scannable files (> ${SCAN_FILE_CAP} cap). Skipped to stay bounded — narrow the scope or raise SCAN_FILE_CAP.`
      });
    }
    const scan = archChecks.scanRepo({ root: scope.root });
    rawFindings = Array.isArray(scan.findings) ? scan.findings : [];
    summary = scan.summary ?? emptySummary;
  } catch (err) {
    return emptyCockpit(scope, scopes, checks, filters, {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const findings = rawFindings.map(normalizeFinding);

  // Plan accounting against the LIVE board (same call the CLI makes), at the
  // cadence floor so the cockpit shows warn-class debt the dry-run would file.
  let counts: PlanCounts = {
    findings: findings.length,
    belowFloor: 0,
    skippedOpen: 0,
    skippedInRun: 0,
    duplicate: 0,
    eligible: 0,
    toFile: 0,
    capped: 0
  };
  let proposals: Proposal[] = [];
  let cappedProposals: Proposal[] = [];
  try {
    const plan = qualityScan.planTickets({
      findings: rawFindings,
      board: readBoard(),
      severityFloor: PLAN_SEVERITY_FLOOR,
      cap: PLAN_CAP
    });
    counts = plan.counts;
    proposals = Array.isArray(plan.toFile) ? plan.toFile : [];
    cappedProposals = Array.isArray(plan.capped) ? plan.capped : [];
  } catch {
    // Leave the conservative empty accounting; the page renders zero-state.
  }

  const presentChecks = [...new Set(findings.map((f) => f.check))].sort();
  const files = [...new Set(findings.map((f) => f.file))].sort();
  const filtered = applyFilters(findings, filters);

  return {
    ok: true,
    scope,
    scopes,
    missingRoot: false,
    scanRoot: scope.rootLabel,
    fileCount: summary.files ?? 0,
    summary,
    filters,
    totalFindings: findings.length,
    findings: filtered,
    checks: presentChecks,
    files,
    byFile: groupByFile(filtered),
    complexityHotspots: complexityHotspots(findings),
    duplicationGroups: duplicationGroups(findings),
    hardcodingCandidates: hardcodingCandidates(findings),
    plan: {
      severityFloor: PLAN_SEVERITY_FLOOR,
      cap: PLAN_CAP,
      counts,
      proposals,
      capped: cappedProposals
    }
  };
}

/**
 * Copyable governed CLI commands for the proposed tickets. Display-only — never
 * executed, never applied. Mirrors the documented dry-run + cadence invocations.
 */
export function planCommands(cockpit: QualityCockpit): string[] {
  const floor = cockpit.plan.severityFloor;
  const cap = cockpit.plan.counts.toFile + cockpit.plan.counts.capped || cockpit.plan.cap;
  return [
    `coord/scripts/gov quality-scan --severity-floor ${floor} --cap ${cap}`,
    `# dry-run is the default — review the plan, then re-run with --apply to file`,
    `coord/scripts/gov quality-scan --severity-floor ${floor} --cap ${cap} --apply`
  ];
}
