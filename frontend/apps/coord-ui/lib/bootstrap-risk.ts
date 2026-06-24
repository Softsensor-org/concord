import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR, PLAN_RECORDS_DIR, BOARD_PATH } from './coord-paths';
import { requireExternal } from './external-require';
import { shouldRedact, type Role } from './access';

/**
 * COORD-163 — READ-ONLY "/bootstrap-risk" cockpit data layer (Server bootstrap P5).
 *
 * Surfaces, per ticket that carries server-bootstrap / backfill / generated-data
 * risk, the COORD-159 `bootstrap_risk` plan field, the COORD-160/162 advisory
 * warnings, and the COORD-161 bootstrap receipt status — so an operator can see
 * which deployed startup/data-generation jobs declared their safety envelope and
 * which have an actual completion receipt.
 *
 * REUSE, DON'T RECOMPUTE (the risk is owned by the substrate, not this view):
 *   - The `bootstrap_risk` object is the COORD-159 plan field, read straight off
 *     the canonical plan record. A ticket appears here only when it declares that
 *     object (explicit detection — the SAME shape the contract documents), with
 *     a narrow fallback to the COORD-160 advisory for tickets that mention
 *     bootstrap work but have not yet recorded the field.
 *   - The unresolved warnings + missing-evidence list come from
 *     `buildBootstrapAdvisory` (coord/scripts/bootstrap-advisory.js, COORD-160).
 *     We do not re-derive which evidence is missing.
 *   - The optional broad-query warnings come from `scanBackfillQueryText`
 *     (coord/scripts/backfill-query-advisory.js, COORD-162) over the plan's
 *     declared data-access / query text. We do not reimplement the heuristics.
 *   - The receipt status is read with the COORD-161 receipt readers
 *     (latestReceipt / readReceipt for the `bootstrap` kind in
 *     coord/scripts/runtime-evidence.js). We do not reimplement receipt parsing.
 *
 * SERVER READINESS vs JOB COMPLETION (the core ticket requirement):
 *   - These are DISTINCT states and are modelled + labelled separately. The plan
 *     `bootstrap_risk` describes the job's DESIGN (runs-at-boot, shares-process,
 *     envelope, idempotency) — i.e. server-readiness posture. The COORD-161
 *     receipt is the only evidence of JOB COMPLETION. A ticket can be perfectly
 *     designed (readiness ok) with NO completion receipt (job not proven done),
 *     and the view never collapses one into the other: `serverReadiness` and
 *     `jobCompletion` are separate fields with separate states.
 *   - "Server started" / "/readyz" / "deploy success" is explicitly NOT job
 *     completion (the contract's hard rule). The advisory already refuses to
 *     count a readiness-only verification signal; we surface that as-is.
 *
 * STRICTLY READ-ONLY / fail-closed (SEC-001/SEC-002):
 *   - NO writes, NO process spawning, NO mutation, NO network, NO live cloud/API
 *     call, and NO job execution. It only READS the plan records, the board, and
 *     the recorded receipts and returns plain data. There is NO write/POST/run
 *     path: this view shows recorded evidence; it never runs a bootstrap job and
 *     never advances a ticket.
 *   - A missing engine module / unreadable receipt degrades gracefully (status
 *     becomes "unknown") rather than throwing — the same graceful community-cut
 *     degradation other engine-backed views use.
 *
 * ROLE-AWARE (ENT-012): viewer roles see REDACTED summaries only — the resource
 * envelope, idempotency/checkpoint, verification-signal, rollback/disable and
 * receipt-path DETAIL strings are masked and only the coarse present/absent
 * status is shown. operator/admin/local see the full operational detail.
 * Redaction is decided by the shared access core (shouldRedact), not here.
 *
 * The absence of any mutation/exec/network path is asserted by
 * coord/scripts/coord-ui-bootstrap-risk-view.test.js.
 */

// ---- COORD-160/162 advisory engines (loaded from disk, reused not reimplemented) ----

interface BootstrapAdvisory {
  triggered: boolean;
  blocking: boolean;
  matched_signals: string[];
  missing_evidence: string[];
  message: string | null;
  suppressed_reason?: string;
}
interface QueryFinding {
  rule: string;
  severity: string;
  message: string;
}
interface QueryAdvisory {
  triggered: boolean;
  blocking: boolean;
  findings: QueryFinding[];
}
interface AdvisoryEngine {
  buildBootstrapAdvisory: (args: { row?: unknown; planState?: unknown }) => BootstrapAdvisory;
}
interface QueryAdvisoryEngine {
  scanBackfillQueryText: (text: unknown) => QueryAdvisory;
}
interface ReceiptEngine {
  latestReceipt: (kind: string, ticket: string, options?: { coordDir?: string }) => string | null;
  readReceipt: (filePath: string, fail?: (msg: string) => never) => Record<string, unknown>;
}

function loadAdvisoryEngine(): AdvisoryEngine | null {
  try {
    return requireExternal<AdvisoryEngine>(path.join(COORD_DIR, 'scripts', 'bootstrap-advisory.js'));
  } catch {
    return null;
  }
}

function loadQueryAdvisoryEngine(): QueryAdvisoryEngine | null {
  try {
    return requireExternal<QueryAdvisoryEngine>(
      path.join(COORD_DIR, 'scripts', 'backfill-query-advisory.js')
    );
  } catch {
    return null;
  }
}

function loadReceiptEngine(): ReceiptEngine | null {
  try {
    return requireExternal<ReceiptEngine>(path.join(COORD_DIR, 'scripts', 'runtime-evidence.js'));
  } catch {
    return null;
  }
}

// ---- Surfaced types ----

export type EvidenceState = 'present' | 'absent' | 'unknown';

/** A single masked-or-detail field: viewer sees only `state`, privileged see `detail`. */
export interface StatusField {
  /** Coarse, always-safe status. Shown to every role. */
  state: EvidenceState;
  /** The operational detail string. Null when redacted for the role or absent. */
  detail: string | null;
}

/** The job's declared resource envelope (COORD-159), masked for viewer. */
export interface ResourceEnvelope {
  state: EvidenceState;
  /** Human-readable summary of the declared envelope. Null when redacted/absent. */
  summary: string | null;
}

/**
 * SERVER READINESS — the job's DESIGN posture from the COORD-159 plan field.
 * This is NOT proof the job ran. It answers "is the startup/boot design safe?".
 */
export interface ServerReadiness {
  /** Declared work class (server_bootstrap_job, derived_data_job, ...). */
  workClass: string | null;
  /** Whether the job runs at boot. null when not declared. */
  runsAtBoot: boolean | null;
  /** Whether the job shares the API process. null when not declared. */
  sharesAppProcess: boolean | null;
  /** Coarse readiness verdict derived from the declared flags. */
  posture: 'declared-safe' | 'declared-risky' | 'undeclared';
}

/**
 * JOB COMPLETION — the COORD-161 receipt status. This is the ONLY evidence the
 * job actually finished. Deliberately separate from {@link ServerReadiness}:
 * "server ready" never implies "job complete".
 */
export interface JobCompletion {
  /** Whether a recorded bootstrap receipt was found. */
  state: EvidenceState;
  /** Receipt result (success|failed|partial|cleanup-pending|...). Redacted for viewer. */
  result: string | null;
  /** Repo-relative path to the receipt. Redacted for viewer. */
  path: string | null;
}

export interface BootstrapRiskTicketView {
  id: string;
  status: string;
  /** Why this ticket surfaced: it declares bootstrap_risk, or only the advisory triggered. */
  source: 'plan-field' | 'advisory-only';
  // ---- COORD-159 declared design (server-readiness posture) ----
  serverReadiness: ServerReadiness;
  resourceEnvelope: ResourceEnvelope;
  idempotency: StatusField;
  checkpoint: StatusField;
  verificationSignal: StatusField;
  rollbackOrDisable: StatusField;
  /** Observability requirements declared (list of labels). Redacted detail for viewer. */
  observability: { state: EvidenceState; items: string[] | null };
  dataAccessShape: StatusField;
  // ---- COORD-161 receipt (job-completion evidence) ----
  jobCompletion: JobCompletion;
  // ---- COORD-160 + COORD-162 unresolved warnings ----
  /** COORD-160 matched server-bootstrap signals. */
  matchedSignals: string[];
  /** COORD-160 missing-evidence fields (unresolved warnings). */
  missingEvidence: string[];
  /** COORD-160 advisory message. Null when not triggered. */
  advisoryMessage: string | null;
  /** COORD-162 broad-query findings over the declared data-access / query text. */
  queryWarnings: QueryFinding[];
}

export interface BootstrapRiskView {
  readOnly: true;
  /** Whether the advisory engine loaded; false → degraded (engine missing). */
  engineAvailable: boolean;
  /** Effective role driving redaction. */
  role: Role;
  /** True when viewer-level redaction is applied to detail strings. */
  redacted: boolean;
  tickets: BootstrapRiskTicketView[];
  /** Notice rendered at the top of the view (posture / degradation). */
  notice: string;
}

// ---- helpers ----

function meaningful(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function statusField(value: unknown, redacted: boolean): StatusField {
  if (!meaningful(value)) return { state: 'absent', detail: null };
  return { state: 'present', detail: redacted ? null : value.trim() };
}

function listPlanIds(): string[] {
  try {
    return fs
      .readdirSync(PLAN_RECORDS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function readPlanRecord(id: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PLAN_RECORDS_DIR, `${id}.json`), 'utf8')
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface BoardRow {
  ID?: string;
  Status?: string;
  Description?: string;
}

function boardRows(): BoardRow[] {
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')) as {
      sections?: Array<{ kind?: string; rows?: BoardRow[] }>;
    };
    const out: BoardRow[] = [];
    for (const sec of board.sections ?? []) {
      if (sec.kind !== 'table' || !sec.rows) continue;
      out.push(...sec.rows);
    }
    return out;
  } catch {
    return [];
  }
}

function asBootstrapRisk(planState: Record<string, unknown> | null): Record<string, unknown> | null {
  const v = planState && planState.bootstrap_risk;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/** Build the server-readiness posture from the declared design flags only. */
function serverReadiness(br: Record<string, unknown> | null): ServerReadiness {
  if (!br) {
    return { workClass: null, runsAtBoot: null, sharesAppProcess: null, posture: 'undeclared' };
  }
  const workClass = meaningful(br.startup_work_class) ? br.startup_work_class.trim() : null;
  const runsAtBoot = typeof br.runs_at_boot === 'boolean' ? br.runs_at_boot : null;
  const sharesAppProcess = typeof br.shares_app_process === 'boolean' ? br.shares_app_process : null;
  // Heavy work that runs at boot AND shares the API process is the contract's
  // headline anti-pattern; flag it as declared-risky. A job that explicitly does
  // NOT run at boot / does NOT share the process is declared-safe. Anything not
  // declared stays undeclared (surfaced, not hidden).
  let posture: ServerReadiness['posture'] = 'undeclared';
  if (runsAtBoot === true && sharesAppProcess === true) {
    posture = 'declared-risky';
  } else if (runsAtBoot === false || sharesAppProcess === false) {
    posture = 'declared-safe';
  }
  return { workClass, runsAtBoot, sharesAppProcess, posture };
}

/** Summarise the declared resource envelope (COORD-159), masked for viewer. */
function resourceEnvelope(
  br: Record<string, unknown> | null,
  redacted: boolean
): ResourceEnvelope {
  const env = br && br.resource_envelope;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { state: 'absent', summary: null };
  }
  const e = env as Record<string, unknown>;
  const parts: string[] = [];
  const push = (label: string, value: unknown, suffix = '') => {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      parts.push(`${label}=${String(value).trim()}${suffix}`);
    }
  };
  push('memory', e.memory_mb, 'mb');
  push('timeout', e.timeout_s, 's');
  push('rows', e.expected_rows);
  push('batch', e.batch_size);
  push('db', e.db_pool_impact);
  if (parts.length === 0) return { state: 'absent', summary: null };
  return { state: 'present', summary: redacted ? null : parts.join(', ') };
}

/** Read the COORD-161 bootstrap receipt — the ONLY job-completion evidence. */
function jobCompletion(id: string, engine: ReceiptEngine | null, redacted: boolean): JobCompletion {
  if (!engine) return { state: 'unknown', result: null, path: null };
  try {
    const file = engine.latestReceipt('bootstrap', id, { coordDir: COORD_DIR });
    if (!file || !fs.existsSync(file)) return { state: 'absent', result: null, path: null };
    const receipt = engine.readReceipt(file, (msg: string) => {
      throw new Error(msg);
    });
    const result = receipt.result;
    const rel = path.relative(path.dirname(COORD_DIR), file).split(path.sep).join('/');
    return {
      state: 'present',
      result: redacted ? null : meaningful(result) ? result : 'recorded',
      path: redacted ? null : rel
    };
  } catch {
    return { state: 'unknown', result: null, path: null };
  }
}

/** Text fed to the COORD-162 broad-query scan: the declared data-access shape. */
function queryScanText(br: Record<string, unknown> | null): string {
  if (!br) return '';
  const parts: string[] = [];
  for (const key of ['data_access_shape', 'checkpoint_strategy', 'idempotency_strategy']) {
    if (meaningful(br[key])) parts.push(br[key] as string);
  }
  const env = br.resource_envelope;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const dbImpact = (env as Record<string, unknown>).db_pool_impact;
    if (meaningful(dbImpact)) parts.push(dbImpact);
  }
  return parts.join('\n');
}

function buildTicketView(
  id: string,
  row: BoardRow | undefined,
  planState: Record<string, unknown> | null,
  source: 'plan-field' | 'advisory-only',
  advisory: BootstrapAdvisory,
  queryEngine: QueryAdvisoryEngine | null,
  receipts: ReceiptEngine | null,
  redacted: boolean
): BootstrapRiskTicketView {
  const br = asBootstrapRisk(planState);
  const obs = br && br.observability_requirements;
  const obsItems = Array.isArray(obs) ? obs.filter((x): x is string => meaningful(x)) : [];
  const scanText = queryScanText(br);
  const queryWarnings =
    queryEngine && scanText.trim() ? queryEngine.scanBackfillQueryText(scanText).findings : [];

  return {
    id,
    status: meaningful(row && row.Status) ? (row as BoardRow).Status!.trim() : 'unknown',
    source,
    serverReadiness: serverReadiness(br),
    resourceEnvelope: resourceEnvelope(br, redacted),
    idempotency: statusField(br && br.idempotency_strategy, redacted),
    checkpoint: statusField(br && br.checkpoint_strategy, redacted),
    verificationSignal: statusField(br && br.verification_signal, redacted),
    rollbackOrDisable: statusField(br && br.rollback_or_disable, redacted),
    observability: {
      state: obsItems.length > 0 ? 'present' : 'absent',
      items: obsItems.length === 0 ? null : redacted ? null : obsItems
    },
    dataAccessShape: statusField(br && br.data_access_shape, redacted),
    jobCompletion: jobCompletion(id, receipts, redacted),
    matchedSignals: Array.isArray(advisory.matched_signals) ? advisory.matched_signals : [],
    missingEvidence: Array.isArray(advisory.missing_evidence) ? advisory.missing_evidence : [],
    advisoryMessage: advisory.triggered ? advisory.message : null,
    queryWarnings
  };
}

/**
 * Build the read-only /bootstrap-risk view for the given role. Lists every
 * ticket that carries server-bootstrap risk — either it declares the COORD-159
 * `bootstrap_risk` plan field, or the COORD-160 advisory triggered on its
 * description/plan text. Surfaces declared design (server-readiness posture),
 * receipt status (job-completion), and unresolved COORD-160/162 warnings. NO
 * writes / spawn / mutation / network / job execution. Viewer roles see redacted
 * detail.
 */
export function loadBootstrapRiskView(role: Role): BootstrapRiskView {
  const advisoryEngine = loadAdvisoryEngine();
  const queryEngine = loadQueryAdvisoryEngine();
  const receipts = loadReceiptEngine();
  const redacted = shouldRedact(role);

  if (!advisoryEngine) {
    return {
      readOnly: true,
      engineAvailable: false,
      role,
      redacted,
      tickets: [],
      notice:
        'Bootstrap advisory engine (coord/scripts/bootstrap-advisory.js) is unavailable in this ' +
        'build. This view is read-only and surfaces nothing rather than a partial state.'
    };
  }

  const rowsById = new Map<string, BoardRow>();
  for (const r of boardRows()) if (meaningful(r.ID)) rowsById.set(r.ID!.trim(), r);

  const tickets: BootstrapRiskTicketView[] = [];
  for (const id of listPlanIds()) {
    const planState = readPlanRecord(id);
    const br = asBootstrapRisk(planState);
    const row = rowsById.get(id);
    const advisory = advisoryEngine.buildBootstrapAdvisory({ row, planState });
    // A ticket surfaces when it DECLARES bootstrap_risk (the explicit, primary
    // detection) OR when the COORD-160 advisory triggered on its text (a ticket
    // that mentions bootstrap work but has not yet recorded the field — exactly
    // the unresolved-warning case the operator needs to see).
    if (!br && !advisory.triggered) continue;
    const source: 'plan-field' | 'advisory-only' = br ? 'plan-field' : 'advisory-only';
    tickets.push(
      buildTicketView(id, row, planState, source, advisory, queryEngine, receipts, redacted)
    );
  }

  const notice = redacted
    ? 'Read-only bootstrap/backfill risk surface. You are viewing REDACTED summaries: resource ' +
      'envelope, idempotency/checkpoint, verification signal, rollback/disable and receipt paths ' +
      'are masked. Operator/admin roles see operational detail. SERVER READINESS (the job design) ' +
      'and JOB COMPLETION (the receipt) are shown separately — a ready server is NOT a finished ' +
      'job. This view never runs a bootstrap job and never mutates a ticket.'
    : 'Read-only bootstrap/backfill risk surface. Declared design comes from the COORD-159 ' +
      'bootstrap_risk plan field, unresolved warnings from the COORD-160/162 advisories, and ' +
      'job-completion from the COORD-161 receipt. SERVER READINESS (the job design) and JOB ' +
      'COMPLETION (the receipt) are distinct states and are labelled separately — a ready server ' +
      'is NOT a finished job. This view never runs a bootstrap job and never mutates a ticket.';

  return { readOnly: true, engineAvailable: true, role, redacted, tickets, notice };
}
