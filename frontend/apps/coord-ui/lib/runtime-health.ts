import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR, RUNTIME_DIR, LOCKS_DIR } from './coord-paths';
import { requireExternal, uncacheExternal } from './external-require';
import { loadBoard } from './board';

/**
 * UI-006 — coord-ui runtime + gate-process health surface.
 *
 * Server-only, STRICTLY READ-ONLY. Surfaces process-orphan risk (the third leg
 * of orphan governance COORD-092 added next to disk-orphan and session-stub
 * reaping) before it becomes a timeout/OOM cascade, plus coarse lock/session/
 * runtime health.
 *
 * SAFETY / READ-ONLY CONTRACT (non-negotiable, the reason this lib exists):
 *   - We load coord/scripts/gate-proc-registry.js in-process and call ONLY its
 *     read-only primitives: listEntries() and detectOrphans()/classifyEntry().
 *   - We NEVER call reapOrphans(), signalMatched(), removeEntry(), writeEntry(),
 *     or any mutating verb. The web tier never kills, signals, spawns, or writes.
 *   - Orphan provenance is read STRICTLY from coord-recorded registry entries
 *     (recorded pid + start-time fingerprint). We never scan by process name and
 *     never infer ownership from anything but the recorded entry — mirroring the
 *     reaper's own PID-reuse guard. Reaping is the `gov reap-gate-procs` /
 *     `gov doctor --fix` path, NOT this view.
 *
 * The registry module is a zero-dependency CJS module; we instantiate it with
 * createRequire so the SAME classification logic the doctor/reaper use produces
 * this view (no re-implemented payload shapes, no drift).
 */

// --- mirrored shapes (load-bearing: must match gate-proc-registry.js) ---------

/** One recorded child process fingerprint inside a registry entry. */
export interface RegistryProc {
  pid: number;
  /** /proc starttime fingerprint (the PID-reuse guard). null on non-Linux hosts. */
  start_time: string | null;
  /** advisory cmdline captured at registration; never authoritative. */
  cmdline: string | null;
}

/** A coord/.runtime/gate-procs/<gate-run-id>.json entry. */
export interface RegistryEntry {
  schema: string;
  gate_run_id: string;
  ticket: string | null;
  repo: string | null;
  lane: string | null;
  pgid: number | null;
  procs: RegistryProc[];
  created_at: string | null;
}

/** classifyEntry() verdict (read-only orphan classification). */
interface ClassifyVerdict {
  entry: RegistryEntry;
  gateRunId: string;
  ownerLive: boolean;
  matchedProcs: RegistryProc[];
  orphan: boolean;
  reason: string;
}

interface GateProcRegistryModule {
  listEntries: (options?: Record<string, unknown>) => RegistryEntry[];
  classifyEntry: (entry: RegistryEntry, options?: Record<string, unknown>) => ClassifyVerdict;
  defaultRegistryDir: () => string;
  REGISTRY_SCHEMA: string;
}

function loadRegistryModule(): GateProcRegistryModule {
  const modPath = path.join(COORD_DIR, 'scripts', 'gate-proc-registry.js');
  // Bust the cache so a freshly-written registry module / edits are reflected
  // without a server restart in dev. Read-only require — never executes a verb.
  uncacheExternal(modPath);
  return requireExternal<GateProcRegistryModule>(modPath);
}

// --- view model --------------------------------------------------------------

/** A single recorded child PID, with its PID-reuse-guard status surfaced. */
export interface ProcView {
  pid: number;
  /**
   * 'guarded'  — start_time recorded AND live PID matches (verifiable owner).
   * 'gone'     — recorded but no live process matches (already dead / reaped).
   * 'reused'   — live PID exists but its start-time differs (PID recycled; the
   *              reaper would REFUSE to signal it). Surfaced, never hidden.
   * 'unguarded'— no start_time recorded (non-Linux host); the reaper fails safe
   *              and would not signal it. Surfaced, never hidden.
   */
  guard: 'guarded' | 'gone' | 'reused' | 'unguarded';
  startTime: string | null;
  cmdline: string | null;
}

export interface GateRunView {
  gateRunId: string;
  ticket: string | null;
  repo: string | null;
  lane: string | null;
  pgid: number | null;
  createdAt: string | null;
  ageMinutes: number | null;
  procs: ProcView[];
  /** true when classifyEntry marks the owning gate-run gone / ticket no longer doing. */
  orphan: boolean;
  /** coord's own classification reason string (verbatim, never re-worded). */
  reason: string;
  /** how many recorded procs still pass the PID-reuse guard. */
  matchedCount: number;
  /** heavy lanes (full/ci) carry resource-heavy children — repeated for guidance. */
  heavyLane: boolean;
}

export interface LockHealth {
  count: number;
  stalled: number;
  malformed: number;
}

export interface SessionHealth {
  /** present-and-readable flags for the session/runtime journal artifacts. */
  agentSessionsPresent: boolean;
  sessionInstancesPresent: boolean;
  eventLogPresent: boolean;
  snapshotPresent: boolean;
}

export type RuntimeLevel = 'ok' | 'warn';

export interface RuntimeHealthView {
  /** false only when the registry module itself could not be loaded. */
  ok: boolean;
  error: string | null;
  /** absolute registry dir, surfaced so an operator knows exactly what was read. */
  registryDir: string;
  /** true when the registry dir is absent — a clean, expected zero state. */
  registryDirPresent: boolean;
  registrySchema: string;
  activeRuns: GateRunView[];
  orphans: GateRunView[];
  cleanResidue: GateRunView[];
  totalEntries: number;
  locks: LockHealth;
  sessions: SessionHealth;
  /** overall posture: 'warn' iff any orphan exists, else 'ok'. */
  level: RuntimeLevel;
  generatedAt: string;
}

const HEAVY_LANES = new Set(['full', 'ci']);
const STALLED_LOCK_MS = 24 * 60 * 60 * 1000;

function classifyProc(p: RegistryProc, verdict: ClassifyVerdict): ProcView {
  const matched = verdict.matchedProcs.some((m) => m.pid === p.pid);
  let guard: ProcView['guard'];
  if (matched) {
    guard = 'guarded';
  } else if (p.start_time == null) {
    // No recorded start-time → the reuse guard cannot verify it; the reaper
    // fails safe and would never signal it. Distinct from a dead PID.
    guard = 'unguarded';
  } else if (isLiveButUnmatched(p)) {
    guard = 'reused';
  } else {
    guard = 'gone';
  }
  return { pid: p.pid, guard, startTime: p.start_time, cmdline: p.cmdline };
}

// A recorded proc is "reused" iff its PID currently maps to a LIVE process whose
// start-time differs from the recorded one. Read-only /proc probe; never signals.
function isLiveButUnmatched(p: RegistryProc): boolean {
  if (!Number.isInteger(p.pid) || p.pid <= 0) return false;
  try {
    const raw = fs.readFileSync(path.join('/proc', String(p.pid), 'stat'), 'utf8');
    const rparen = raw.lastIndexOf(')');
    if (rparen === -1) return false;
    const rest = raw.slice(rparen + 1).trim().split(/\s+/);
    const liveStart = rest[19];
    if (liveStart === undefined) return false;
    // Live process exists; it is "reused" iff its start-time differs.
    return String(liveStart) !== String(p.start_time);
  } catch {
    // No live process at that PID → not reused (it is simply gone).
    return false;
  }
}

function toGateRunView(verdict: ClassifyVerdict): GateRunView {
  const e = verdict.entry;
  const created = e.created_at ? new Date(e.created_at).getTime() : 0;
  const ageMinutes = created ? Math.round((Date.now() - created) / 60000) : null;
  return {
    gateRunId: e.gate_run_id,
    ticket: e.ticket,
    repo: e.repo,
    lane: e.lane,
    pgid: e.pgid,
    createdAt: e.created_at,
    ageMinutes,
    procs: (e.procs || []).map((p) => classifyProc(p, verdict)),
    orphan: verdict.orphan,
    reason: verdict.reason,
    matchedCount: verdict.matchedProcs.length,
    heavyLane: e.lane != null && HEAVY_LANES.has(e.lane)
  };
}

function lockHealth(): LockHealth {
  if (!fs.existsSync(LOCKS_DIR)) return { count: 0, stalled: 0, malformed: 0 };
  const files = fs.readdirSync(LOCKS_DIR).filter((f) => f.endsWith('.lock') || f.endsWith('.json'));
  let stalled = 0;
  let malformed = 0;
  const now = Date.now();
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOCKS_DIR, f), 'utf8'));
      const started = raw.started_at ? new Date(raw.started_at).getTime() : 0;
      if (started && now - started > STALLED_LOCK_MS) stalled++;
    } catch {
      malformed++;
    }
  }
  return { count: files.length, stalled, malformed };
}

function sessionHealth(): SessionHealth {
  const exists = (p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  return {
    agentSessionsPresent: exists(path.join(RUNTIME_DIR, 'agent_sessions.json')),
    sessionInstancesPresent: exists(path.join(RUNTIME_DIR, 'session-instances.json')),
    eventLogPresent: exists(path.join(RUNTIME_DIR, 'governance-events.ndjson')),
    snapshotPresent: exists(path.join(RUNTIME_DIR, 'governance-latest-snapshot.json'))
  };
}

/**
 * Build the runtime-health view. The ONLY registry calls are listEntries() and
 * classifyEntry() — both read-only. We pass an isTicketDoing predicate (derived
 * from the live board's doing set) so the "gate outlived its ticket" orphan
 * class is detected exactly as the doctor would, with no mutation.
 */
export function loadRuntimeHealth(): RuntimeHealthView {
  const generatedAt = new Date().toISOString();
  let reg: GateProcRegistryModule;
  try {
    reg = loadRegistryModule();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      registryDir: path.join(COORD_DIR, 'scripts'),
      registryDirPresent: false,
      registrySchema: '',
      activeRuns: [],
      orphans: [],
      cleanResidue: [],
      totalEntries: 0,
      locks: lockHealth(),
      sessions: sessionHealth(),
      level: 'ok',
      generatedAt
    };
  }

  const registryDir = reg.defaultRegistryDir();
  const registryDirPresent = (() => {
    try {
      return fs.existsSync(registryDir);
    } catch {
      return false;
    }
  })();

  // Live "doing" set, used as the read-only isTicketDoing predicate so a gate
  // that outlived its owning ticket is classified as an orphan.
  let doing: Set<string>;
  try {
    doing = new Set(loadBoard().byStatus.doing.map((r) => r.id));
  } catch {
    doing = new Set();
  }
  const isTicketDoing = (ticket: string): boolean => doing.has(ticket);

  const entries = reg.listEntries();
  const verdicts = entries.map((entry) => reg.classifyEntry(entry, { isTicketDoing }));

  const activeRuns: GateRunView[] = [];
  const orphans: GateRunView[] = [];
  const cleanResidue: GateRunView[] = [];

  for (const v of verdicts) {
    const view = toGateRunView(v);
    if (view.orphan) {
      orphans.push(view);
    } else {
      activeRuns.push(view);
    }
    // Clean-exit residue: a non-orphan entry whose recorded procs are ALL gone
    // (matchedCount 0) is a registry file left behind after a clean exit dropped
    // its trap — informational, not scary. (Orphans already captured above.)
    if (!view.orphan && view.matchedCount === 0 && view.procs.length > 0) {
      cleanResidue.push(view);
    }
  }

  const sortByRun = (a: GateRunView, b: GateRunView) => a.gateRunId.localeCompare(b.gateRunId);
  activeRuns.sort(sortByRun);
  orphans.sort(sortByRun);
  cleanResidue.sort(sortByRun);

  return {
    ok: true,
    error: null,
    registryDir,
    registryDirPresent,
    registrySchema: reg.REGISTRY_SCHEMA,
    activeRuns,
    orphans,
    cleanResidue,
    totalEntries: entries.length,
    locks: lockHealth(),
    sessions: sessionHealth(),
    level: orphans.length > 0 ? 'warn' : 'ok',
    generatedAt
  };
}
