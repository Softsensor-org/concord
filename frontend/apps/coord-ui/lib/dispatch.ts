import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import { COORD_DIR, BOARD_PATH } from './coord-paths';
import { requireExternal } from './external-require';
import { latestPrecheckObservedPerTicket } from './events';
import { canonicalNextCommands } from './ticket-guidance';

/**
 * UI-005 / UI-008 — /dispatch multi-agent planning data surface.
 *
 * Server-only, strictly read-only. Composes the SAME deterministic dispatch
 * surface the `gov dispatch-plan` / `gov plan-waves` / `gov precheck` /
 * `gov context-pack` CLIs use, by instantiating the real coord factory and
 * calling its PURE, spawn-free exported functions in-process. The view NEVER
 * spawns a child process, never writes, never applies, never runs a gate.
 *
 *   coord/scripts/token-economics.js → createTokenEconomics(deps) →
 *     - planWaves({ status, repo, silent })   conflict-free wave schedule +
 *                                              repo-X / no-files serialization +
 *                                              excluded[] (no silent drops)
 *     - buildContextPack(id)                   readiness pointer (board reads)
 *     - resolveTicketTier / tierEvidenceMinimums / effectiveTierMinimum
 *                                              tier → model class + evidence depth
 *     - dispatchCachePrefixMarker()            stable cacheable prompt prefix
 *
 * UI-008 — READ-ONLY PRECHECK SOURCE: we deliberately do NOT call
 * dispatchActionForTicket()/dispatchPrecheckVerdict()/runPrecheckProbe(): those
 * shell out via spawnSync to run precheck "test" probes per scheduled ticket at
 * render time — a spawn-from-the-web-tier + OOM/resource concern flagged in
 * UI-005. Instead we read the LATEST `precheck.observed` journal event per
 * ticket (written by `gov precheck --record`, shape {ticket,verdict,probe_count})
 * from coord/.runtime/governance-events.ndjson (read-only, via lib/events.ts)
 * and map that RECORDED verdict → dispatch action with the EXACT mapping the CLI
 * uses (see dispatchActionForTicket): already-satisfied → SKIP; everything else
 * (partial / not-started / unknown) → SPAWN. A missing or ambiguous precheck
 * signal NEVER becomes a false skip. When no `precheck.observed` exists for a
 * ticket we render "precheck not recorded" plus the copyable
 * `gov precheck --record <id>` command and map to SPAWN — we never run a probe
 * live to fill the gap.
 *
 * Tier routing, evidence depth and the context-pack are still computed in-process
 * from the pure board-reading functions (no probes, no spawn). Output is stable
 * across reloads for the same board + journal (fixed sort/key order, no
 * timestamps/random ordering): determinism is preserved.
 *
 * The factory deps below are read-only-safe shims that read coord/board/
 * tasks.json directly (the raw uppercase board columns the factory expects).
 * The dispatch path never calls the mutation/identity deps, so they are
 * intentionally omitted.
 */

// --- mirrored shapes (load-bearing: must match token-economics.js) -----------

export type PrecheckVerdict =
  | 'already-satisfied'
  | 'partial'
  | 'not-started'
  | 'unknown';

export type DispatchAction = 'skip' | 'spawn';

/**
 * Recorded precheck verdict surfaced on the dispatch view. The verdict comes
 * from the latest `precheck.observed` journal event (read-only) — never a live
 * probe. `recorded === false` means NO verdict was recorded for the ticket; in
 * that case `verdict` is held at `unknown` (which maps to SPAWN, never a false
 * skip) and `recordCommand` carries the copyable `gov precheck --record` hint.
 */
export interface PrecheckView {
  verdict: PrecheckVerdict;
  /** whether a `precheck.observed` event was found for this ticket. */
  recorded: boolean;
  probeCount: number;
  /** ISO timestamp of the recording event (null when not recorded). */
  recordedAt: string | null;
  /** copyable `gov precheck --record <id>` command (set only when not recorded). */
  recordCommand: string | null;
}

export interface EvidenceDepth {
  reviewCycles: number;
  featureProofs: number;
  criticalInvariants: number;
}

/** context_pack ticket-specific section (the readiness pointer surface). */
export interface ContextPackView {
  /** sorted shared references — the cacheable prefix (identical across a wave). */
  sharedReferences: string[];
  description: string;
  files: string[];
  acceptanceCriteria: string[];
  specSections: string[];
  priorFeatureProofs: Array<{ ticket: string; proof: string }>;
  priorInvariants: Array<{ ticket: string; invariant: string }>;
}

export interface DispatchTicket {
  ticket: string;
  repo: string;
  /** false for repo-X and no-files tickets (must be visibly non-parallelizable). */
  parallelizable: boolean;
  /** wave scheduler note (repo-X / no-files serialization reason), if any. */
  waveNote: string | null;
  files: string[];
  /** dep id → where satisfied ("done" / "wave N" / "pending"). */
  satisfiedDeps: Record<string, string>;
  precheck: PrecheckView;
  action: DispatchAction;
  /** human-readable reason for the action (verbatim from the coord function). */
  reason: string;
  tier: string;
  tierSource: string;
  suggestedModelClass: string;
  evidenceDepth: EvidenceDepth;
  contextPack: ContextPackView | null;
  /** copyable governed commands (display only — never executed). */
  commands: DispatchCommand[];
  /** finalize template for an already-satisfied skip (verbatim), else null. */
  finalizeCommand: string | null;
}

export interface DispatchCommand {
  label: string;
  cmd: string;
}

export interface DispatchWave {
  wave: number;
  tickets: DispatchTicket[];
}

export interface ExcludedTicket {
  ticket: string;
  reason: string;
}

export interface DispatchFilters {
  status?: string;
  repo?: string;
  wave?: number;
}

export interface CachePrefix {
  id: string;
  description: string;
  sharedReferences: string[];
}

export interface DispatchPlanView {
  /** false only if the schedule itself could not be built (page degrades). */
  ok: boolean;
  error?: string;
  filters: DispatchFilters;
  /** the effective status the schedule ran at (echoed for display). */
  statusFilter: string;
  repoFilter: string | null;
  waveFilter: number | null;
  cachePrefix: CachePrefix;
  waveCount: number;
  waves: DispatchWave[];
  excluded: ExcludedTicket[];
  /** distinct statuses present on the board (for the status switcher). */
  statuses: string[];
  /** distinct repos present among the candidates (for the repo switcher). */
  repos: string[];
  /** total scheduled tickets across all (filtered) waves. */
  scheduledCount: number;
}

// --- coord factory raw shapes (only what we read) -----------------------------

interface RawContextPack {
  stable?: { shared_references?: string[] };
  ticket_specific?: {
    description?: string;
    files?: string[];
    acceptance_criteria?: string[];
    spec_sections?: string[];
    prior_feature_proofs?: Array<{ ticket?: string; proof?: string }>;
    prior_invariants?: Array<{ ticket?: string; invariant?: string }>;
  };
}

interface RawTierResolution {
  tier: string;
  source: string;
}

interface RawEvidenceMinimums {
  model_class?: string;
  flat_review_cycles?: number;
  flat_feature_proofs?: number;
  flat_critical_invariants?: number;
}

interface RawBoardRowLike {
  ID: string;
  [k: string]: unknown;
}

interface RawWaveTicket {
  ticket: string;
  repo?: string;
  files?: string[];
  parallelizable?: boolean;
  note?: string;
  satisfied_deps?: Record<string, string>;
}

interface RawSchedule {
  status_filter: string;
  repo_filter: string | null;
  wave_count: number;
  waves: Array<{ wave: number; tickets: RawWaveTicket[] }>;
  excluded: Array<{ ticket: string; reason: string }>;
}

interface TokenEconomics {
  planWaves: (opts: { status?: string; repo?: string; silent?: boolean }) => RawSchedule;
  // Pure, spawn-free composition primitives (board reads only). We deliberately
  // do NOT expose dispatchActionForTicket / dispatchPrecheckVerdict /
  // runPrecheckProbe here: those run live precheck probes (spawnSync) and must
  // never be on the render path (UI-008).
  buildContextPack: (id: string) => RawContextPack;
  readTierPolicy: () => unknown;
  resolveTicketTier: (row: RawBoardRowLike, policy?: unknown) => RawTierResolution;
  tierEvidenceMinimums: (
    tier: string,
    row: RawBoardRowLike,
    policy?: unknown
  ) => RawEvidenceMinimums;
  effectiveTierMinimum: (
    tier: string,
    fieldKey: string,
    flatValue: number,
    row: RawBoardRowLike,
    policy?: unknown
  ) => number;
  dispatchCachePrefixMarker: () => {
    id: string;
    description: string;
    shared_references: string[];
  };
}

// --- read-only factory wiring -------------------------------------------------

interface BoardRow {
  ID: string;
  Repo?: string;
  Status?: string;
  Description?: string;
  [k: string]: unknown;
}
interface BoardJson {
  sections?: Array<{ rows?: BoardRow[] }>;
}

function readBoard(): BoardJson {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')) as BoardJson;
}
function getRows(board: BoardJson): BoardRow[] {
  return (board.sections || []).flatMap((s) => s.rows || []);
}
function getTicketRef(board: BoardJson, ticketId: string): { row: BoardRow } | null {
  for (const section of board.sections || []) {
    if (!Array.isArray(section.rows)) continue;
    const row = section.rows.find((r) => r.ID === ticketId);
    if (row) return { row };
  }
  return null;
}
function failShim(message: string): never {
  throw new Error(message);
}
function relativeCoordPath(filePath: string): string {
  return path.relative(COORD_DIR, filePath).split(path.sep).join('/');
}

function loadTokenEconomics(): TokenEconomics {
  // The dispatch tier-routing path (tierEvidenceMinimums) needs isRepoBackedCode
  // to distinguish product repos from coord (repo-X). Reuse the REAL repo
  // registry (createRepoRegistry) rather than re-deriving the predicate, so the
  // product/repo-X distinction stays in lockstep with project.config.js. The
  // registry only needs read-only readBoard/getTicketRef shims.
  const createRepoRegistry = requireExternal(
    path.join(COORD_DIR, 'scripts', 'repo-registry.js')
  ) as (deps: Record<string, unknown>) => { isRepoBackedCode: (code: string) => boolean };
  const registry = createRepoRegistry({ readBoard, getTicketRef });

  const createTokenEconomics = requireExternal(
    path.join(COORD_DIR, 'scripts', 'token-economics.js')
  ) as (deps: Record<string, unknown>) => TokenEconomics;
  return createTokenEconomics({
    fail: failShim,
    relativeCoordPath,
    readBoard,
    getRows,
    getTicketRef,
    isRepoBackedCode: registry.isRepoBackedCode
  });
}

// --- normalization ------------------------------------------------------------

const VERDICTS: ReadonlySet<string> = new Set([
  'already-satisfied',
  'partial',
  'not-started',
  'unknown'
]);

function normVerdict(v: unknown): PrecheckVerdict {
  const s = String(v ?? 'unknown');
  return (VERDICTS.has(s) ? s : 'unknown') as PrecheckVerdict;
}

interface ActionDecision {
  action: DispatchAction;
  reason: string;
  /** verbatim finalize command for an already-satisfied skip; else null. */
  finalizeCommand: string | null;
}

/**
 * Map a precheck verdict → dispatch action, mirroring dispatchActionForTicket()
 * in token-economics.js EXACTLY: SKIP only on `already-satisfied`; everything
 * else (partial / not-started / unknown) → SPAWN. `recorded === false` is the
 * "no precheck.observed event" case: held at unknown → SPAWN (never a false
 * skip), with a reason that points at the missing recording.
 */
function decideAction(
  ticketId: string,
  verdict: PrecheckVerdict,
  recorded: boolean,
  probeCount: number
): ActionDecision {
  if (!recorded) {
    return {
      action: 'spawn',
      reason: 'no recorded precheck.observed verdict -> spawn (never a false skip)',
      finalizeCommand: null
    };
  }
  if (verdict === 'already-satisfied') {
    return {
      action: 'skip',
      reason: `recorded precheck verdict already-satisfied (${probeCount} probe(s))`,
      // Mirrors the CLI's finalize template. probe_source is not part of the
      // recorded event shape, so the journal recording is cited instead.
      finalizeCommand:
        `coord/scripts/gov finalize ${ticketId} --no-pr --already-landed ` +
        `--landed "precheck already-satisfied (${probeCount} probe(s)); recorded via gov precheck --record"`
    };
  }
  if (verdict === 'unknown') {
    return {
      action: 'spawn',
      reason: 'recorded verdict unknown -> spawn (never a false skip)',
      finalizeCommand: null
    };
  }
  return {
    action: 'spawn',
    reason: `recorded precheck verdict ${verdict} -> spawn`,
    finalizeCommand: null
  };
}

function normContextPack(raw: RawContextPack | null | undefined): ContextPackView | null {
  if (!raw) return null;
  const ts = raw.ticket_specific ?? {};
  return {
    sharedReferences: [...(raw.stable?.shared_references ?? [])],
    description: String(ts.description ?? ''),
    files: [...(ts.files ?? [])],
    acceptanceCriteria: [...(ts.acceptance_criteria ?? [])],
    specSections: [...(ts.spec_sections ?? [])],
    priorFeatureProofs: (ts.prior_feature_proofs ?? []).map((p) => ({
      ticket: String(p.ticket ?? ''),
      proof: String(p.proof ?? '')
    })),
    priorInvariants: (ts.prior_invariants ?? []).map((i) => ({
      ticket: String(i.ticket ?? ''),
      invariant: String(i.invariant ?? '')
    }))
  };
}

/**
 * COORD-106 (F2): the post-landing closeout verb is REPO-TYPE-dependent and must
 * come from the canonical planner, not a hardcoded `finalize --pr`. A repo-X
 * (coord / cross-repo) ticket with PR evidence closes via `finalize --pr` (no
 * GitHub merge target — `land` is a dead-end); a repo-BACKED ticket with PR
 * evidence closes via `gov land`. We render the canonical buildTicketNextCommands
 * output for the ticket projected into `review` with a placeholder PR URL, so the
 * UI advises the SAME verb the CLI/governance would. Display-only.
 */
function canonicalCloseoutCommand(ticketId: string, repo: string): { label: string; cmd: string } {
  const placeholderPr = '<url>';
  let cmd = `coord/scripts/gov finalize ${ticketId} --pr ${placeholderPr}`;
  try {
    const canonical = canonicalNextCommands({
      board: {
        sections: [],
        review_findings: { [ticketId]: [] },
        pr_index: { [ticketId]: [placeholderPr] }
      } as never,
      row: { ID: ticketId, Status: 'review', Repo: repo },
      ticketId,
      lock: null
    });
    if (canonical.length > 0) cmd = canonical[0];
  } catch {
    // fall back to the conservative finalize --pr template on any factory error.
  }
  return { label: 'closeout (after PR lands)', cmd };
}

/**
 * Copyable governed commands for a ticket. Display-only — the web tier NEVER
 * executes these. They mirror the documented multi-agent dispatch flow:
 * dispatch-plan (this ticket's wave), context-pack, the spawn instruction,
 * canonical closeout / record-cost templates, and gov explain. For an
 * already-satisfied skip, the verbatim finalize command from the coord function
 * is surfaced instead of a spawn instruction.
 */
function buildCommands(
  t: DispatchTicket,
  statusFilter: string,
  wave: number
): DispatchCommand[] {
  const statusFlag = statusFilter ? ` --status ${statusFilter}` : '';
  const cmds: DispatchCommand[] = [
    {
      label: 'dispatch-plan (this wave)',
      cmd: `coord/scripts/gov dispatch-plan${statusFlag} --wave ${wave} --md`
    },
    { label: 'precheck', cmd: `coord/scripts/gov precheck ${t.ticket}` },
    { label: 'context-pack', cmd: `coord/scripts/gov context-pack ${t.ticket} --md` },
    { label: 'gov explain', cmd: `coord/scripts/gov explain ${t.ticket}` }
  ];
  // When no precheck was recorded, surface the copyable record-it command FIRST
  // (the view never runs the probe live — the operator records it on the CLI).
  if (!t.precheck.recorded && t.precheck.recordCommand) {
    cmds.push({ label: 'record precheck (not recorded yet)', cmd: t.precheck.recordCommand });
  }
  if (t.action === 'skip' && t.finalizeCommand) {
    cmds.push({ label: 'finalize (already-satisfied skip)', cmd: t.finalizeCommand });
  } else {
    cmds.push({
      label: 'spawn instruction',
      cmd: `coord/scripts/gov start ${t.ticket}  # then implement per context-pack`
    });
    cmds.push(canonicalCloseoutCommand(t.ticket, t.repo));
  }
  cmds.push({
    label: 'record cost',
    cmd: `coord/scripts/gov record-cost ${t.ticket} --phase implement --model ${
      t.suggestedModelClass || '<model>'
    } --input-tokens <n> --output-tokens <n>`
  });
  return cmds;
}

/**
 * Compose a DispatchTicket entry from:
 *   - the wave schedule entry (read-only planWaves output),
 *   - the RECORDED precheck verdict (latest precheck.observed journal event;
 *     `recorded` undefined ⇒ not recorded ⇒ unknown → spawn),
 *   - tier/evidence/context-pack from the PURE board-reading functions.
 * NO precheck probe is run; nothing is spawned.
 */
function normTicket(
  te: TokenEconomics,
  row: BoardRow,
  waveTicket: RawWaveTicket,
  recorded: { verdict: string; probeCount: number; recordedAt: string } | undefined,
  statusFilter: string,
  wave: number
): DispatchTicket {
  const ticketId = waveTicket.ticket;

  // Verdict strictly from the recorded journal event (read-only). Absent ⇒
  // held at unknown so it maps to spawn (never a false skip).
  const isRecorded = recorded !== undefined;
  const verdict: PrecheckVerdict = isRecorded ? normVerdict(recorded.verdict) : 'unknown';
  const probeCount = isRecorded ? Number(recorded.probeCount ?? 0) : 0;
  const decision = decideAction(ticketId, verdict, isRecorded, probeCount);

  // Tier routing + evidence depth from the pure, spawn-free functions.
  const policy = te.readTierPolicy();
  const rowLike = row as unknown as RawBoardRowLike;
  const resolvedTier = te.resolveTicketTier(rowLike, policy);
  const mins = te.tierEvidenceMinimums(resolvedTier.tier, rowLike, policy);
  const evidenceDepth: EvidenceDepth = {
    reviewCycles: te.effectiveTierMinimum(
      resolvedTier.tier,
      'min_review_cycles',
      Number(mins.flat_review_cycles ?? 0),
      rowLike,
      policy
    ),
    featureProofs: te.effectiveTierMinimum(
      resolvedTier.tier,
      'min_feature_proofs',
      Number(mins.flat_feature_proofs ?? 0),
      rowLike,
      policy
    ),
    criticalInvariants: te.effectiveTierMinimum(
      resolvedTier.tier,
      'min_critical_invariants',
      Number(mins.flat_critical_invariants ?? 0),
      rowLike,
      policy
    )
  };

  const t: DispatchTicket = {
    ticket: ticketId,
    repo: String(waveTicket.repo ?? ''),
    parallelizable: Boolean(waveTicket.parallelizable),
    waveNote: waveTicket.note ?? null,
    files: [...(waveTicket.files ?? [])],
    satisfiedDeps: { ...(waveTicket.satisfied_deps ?? {}) },
    precheck: {
      verdict,
      recorded: isRecorded,
      probeCount,
      recordedAt: isRecorded ? recorded.recordedAt : null,
      // COORD-106 (F1): the CLI takes the ticket from args[0] BEFORE flags
      // (cli.js argv parse), so `precheck --record <id>` parses the TICKET as the
      // --record value. The ticket id MUST precede the flag.
      recordCommand: isRecorded ? null : `coord/scripts/gov precheck ${ticketId} --record`
    },
    action: decision.action,
    reason: decision.reason,
    tier: String(resolvedTier.tier ?? ''),
    tierSource: String(resolvedTier.source ?? ''),
    suggestedModelClass: String(mins.model_class ?? ''),
    evidenceDepth,
    contextPack: normContextPack(te.buildContextPack(ticketId)),
    commands: [],
    finalizeCommand: decision.finalizeCommand
  };
  t.commands = buildCommands(t, statusFilter, wave);
  return t;
}

// --- entry point --------------------------------------------------------------

/**
 * Build the deterministic dispatch plan view. Mirrors `gov dispatch-plan`
 * (status/repo/wave filters) without emitting anything or mutating state.
 * Output is stable across reloads for the same board (the coord functions sort
 * by ID and use a fixed key order; no timestamps/random ordering).
 */
export function loadDispatchPlan(filters: DispatchFilters = {}): DispatchPlanView {
  const cachePrefixEmpty: CachePrefix = {
    id: 'coord-dispatch-stable-v1',
    description: '',
    sharedReferences: []
  };
  let te: TokenEconomics;
  try {
    te = loadTokenEconomics();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      filters,
      statusFilter: filters.status ?? 'todo',
      repoFilter: filters.repo ?? null,
      waveFilter: filters.wave ?? null,
      cachePrefix: cachePrefixEmpty,
      waveCount: 0,
      waves: [],
      excluded: [],
      statuses: [],
      repos: [],
      scheduledCount: 0
    };
  }

  // Distinct statuses/repos for the switchers (read straight off the board).
  let statuses: string[] = [];
  try {
    const rows = getRows(readBoard());
    statuses = [...new Set(rows.map((r) => String(r.Status ?? '')).filter(Boolean))].sort();
  } catch {
    statuses = [];
  }

  const rawCachePrefix = te.dispatchCachePrefixMarker();
  const cachePrefix: CachePrefix = {
    id: rawCachePrefix.id,
    description: rawCachePrefix.description,
    sharedReferences: [...(rawCachePrefix.shared_references ?? [])]
  };

  let schedule: RawSchedule;
  try {
    schedule = te.planWaves({
      status: filters.status,
      repo: filters.repo,
      silent: true
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      filters,
      statusFilter: filters.status ?? 'todo',
      repoFilter: filters.repo ?? null,
      waveFilter: filters.wave ?? null,
      cachePrefix,
      waveCount: 0,
      waves: [],
      excluded: [],
      statuses,
      repos: [],
      scheduledCount: 0
    };
  }

  const wantWave =
    typeof filters.wave === 'number' && Number.isInteger(filters.wave) && filters.wave >= 1
      ? filters.wave
      : null;

  const repos = [
    ...new Set(
      schedule.waves.flatMap((w) => w.tickets.map((t) => String(t.repo ?? '')).filter(Boolean))
    )
  ].sort();

  // Recorded precheck verdicts (latest precheck.observed per ticket), read-only
  // from the governance journal — the ONLY precheck source on the render path.
  // No probe is run; nothing is spawned. Tickets absent from this map render as
  // "not recorded" → spawn (never a false skip).
  let recordedPrechecks: Map<string, { verdict: string; probeCount: number; recordedAt: string }>;
  try {
    recordedPrechecks = latestPrecheckObservedPerTicket();
  } catch {
    recordedPrechecks = new Map();
  }

  // One board read for the whole render (tier routing needs the raw row).
  const boardRows = (() => {
    try {
      return getRows(readBoard());
    } catch {
      return [] as BoardRow[];
    }
  })();
  const rowById = new Map(boardRows.map((r) => [r.ID, r] as const));

  const waves: DispatchWave[] = [];
  let scheduledCount = 0;
  for (const w of schedule.waves) {
    if (wantWave !== null && w.wave !== wantWave) continue;
    const tickets = w.tickets.map((wt) => {
      const row = rowById.get(wt.ticket) ?? ({ ID: wt.ticket } as BoardRow);
      return normTicket(
        te,
        row,
        wt,
        recordedPrechecks.get(wt.ticket),
        schedule.status_filter,
        w.wave
      );
    });
    scheduledCount += tickets.length;
    waves.push({ wave: w.wave, tickets });
  }

  return {
    ok: true,
    filters,
    statusFilter: schedule.status_filter,
    repoFilter: schedule.repo_filter,
    waveFilter: wantWave,
    cachePrefix,
    waveCount: waves.length,
    waves,
    excluded: schedule.excluded.map((e) => ({
      ticket: String(e.ticket),
      reason: String(e.reason)
    })),
    statuses,
    repos,
    scheduledCount
  };
}
