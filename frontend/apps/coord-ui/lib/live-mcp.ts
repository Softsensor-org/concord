import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR, PLAN_RECORDS_DIR, BOARD_PATH } from './coord-paths';
import { requireExternal } from './external-require';
import { shouldRedact, type Role } from './access';

/**
 * COORD-156 — READ-ONLY "/live-mcp" cockpit data layer (Production MCP P5).
 *
 * Surfaces, per live-MCP ticket, the COORD-153 lifecycle status (adapter,
 * environment, operation class, approval / redaction / cleanup / promotion
 * evidence + the BLOCKING closeout issues) and the COORD-152 receipt status.
 *
 * REUSE, DON'T RECOMPUTE:
 *   - The lifecycle status + blockers come from `buildLiveMcpLifecycle`
 *     (coord/scripts/live-mcp-lifecycle.js, COORD-153). We do not re-derive the
 *     operation-class policy or the required-evidence rules.
 *   - The receipt is read with the COORD-152 receipt readers
 *     (latestReceipt / readReceipt in coord/scripts/runtime-evidence.js). We do
 *     not reimplement receipt parsing or path conventions.
 *   - A live-MCP ticket is one whose canonical plan record carries a structured
 *     `live_mcp` object — the SAME explicit detection the enforcement gate uses
 *     (readLiveMcpDeclaration). Description keyword heuristics are NOT used.
 *
 * STRICTLY READ-ONLY / fail-closed (SEC-001/SEC-002):
 *   - NO writes, NO process spawning, NO mutation, NO network. It only READS the
 *     plan records, the board, and the recorded receipts and returns plain data.
 *   - There is NO write/POST/toggle path. This view shows the recorded evidence;
 *     it never executes a live tool and never advances a ticket.
 *   - A missing engine module / unreadable receipt degrades gracefully (the
 *     row's status fields become "unknown") rather than throwing — the same
 *     graceful community-cut degradation other engine-backed views use.
 *
 * ROLE-AWARE (ENT-012): viewer roles see REDACTED summaries only — the operation
 * scope, approval, redaction, cleanup and promotion DETAIL strings are masked
 * and only the coarse present/absent status is shown. operator/admin/local see
 * the full operational detail. Redaction is decided by the shared access core
 * (shouldRedact), not reimplemented here.
 *
 * The absence of any mutation path is asserted by
 * coord/scripts/coord-ui-live-mcp-view.test.js.
 */

// ---- COORD-153 lifecycle engine (loaded from disk, reused not reimplemented) ----

interface LifecycleIssue {
  code: string;
  message: string;
  next_steps?: string[];
}
interface LifecycleResult {
  declared: boolean;
  issues: LifecycleIssue[];
}
interface LiveMcpEngine {
  buildLiveMcpLifecycle: (args: { planState?: unknown }) => LifecycleResult;
  readLiveMcpDeclaration: (planState: unknown) => Record<string, unknown> | null;
}
interface ReceiptEngine {
  latestReceipt: (kind: string, ticket: string, options?: { coordDir?: string }) => string | null;
  readReceipt: (filePath: string, fail?: (msg: string) => never) => Record<string, unknown>;
}
interface LiveMcpViewModelCore {
  meaningful: (value: unknown) => value is string;
  statusField: (value: unknown, redacted: boolean) => StatusField;
  receiptStatus: (args: {
    id: string;
    declaration: Record<string, unknown>;
    engine: ReceiptEngine | null;
    redacted: boolean;
    coordDir: string;
    projectRoot: string;
  }) => ReceiptStatus;
  buildTicketView: (args: {
    id: string;
    status: string;
    planState: unknown;
    declaration: Record<string, unknown>;
    lifecycle: LiveMcpEngine;
    receipts: ReceiptEngine | null;
    redacted: boolean;
    coordDir: string;
    projectRoot: string;
  }) => LiveMcpTicketView;
  collectLiveMcpExportTicket: (args: {
    id: string;
    planState: unknown;
    declaration: Record<string, unknown>;
    lifecycle: LiveMcpEngine;
    receipts: ReceiptEngine | null;
    coordDir: string;
    projectRoot: string;
  }) => LiveMcpExportTicket;
}

function loadLifecycleEngine(): LiveMcpEngine | null {
  try {
    const modPath = path.join(COORD_DIR, 'scripts', 'live-mcp-lifecycle.js');
    return requireExternal<LiveMcpEngine>(modPath);
  } catch {
    return null;
  }
}

function loadReceiptEngine(): ReceiptEngine | null {
  try {
    const modPath = path.join(COORD_DIR, 'scripts', 'runtime-evidence.js');
    return requireExternal<ReceiptEngine>(modPath);
  } catch {
    return null;
  }
}

function loadViewModelCore(): LiveMcpViewModelCore {
  return requireExternal<LiveMcpViewModelCore>(
    path.join(COORD_DIR, 'scripts', 'coord-ui-live-mcp-view-model.js')
  );
}

const viewModelCore = loadViewModelCore();

// ---- Surfaced types ----

export type EvidenceState = 'present' | 'absent' | 'unknown';

/** A single masked-or-detail field: viewer sees only `state`, privileged see `detail`. */
export interface StatusField {
  /** Coarse, always-safe status. Shown to every role. */
  state: EvidenceState;
  /** The operational detail string. Null when redacted for the role or absent. */
  detail: string | null;
}

export interface ReceiptStatus {
  /** Whether a recorded receipt was found. */
  state: EvidenceState;
  /** Receipt result (observed|pass|...). Redacted detail for viewer. */
  result: string | null;
  /** Repo-relative path to the receipt. Redacted for viewer. */
  path: string | null;
}

export interface LiveMcpTicketView {
  id: string;
  status: string;
  /** The declared MCP adapter. */
  adapter: string | null;
  /** The declared operation (redacted for viewer). */
  operation: string | null;
  /** Target environment (local|staging|prod). */
  environment: string | null;
  /** Operation class — selects approval/redaction/cleanup policy. */
  operationClass: string | null;
  /** Explicit operation scope (redacted for viewer — may name resources). */
  scope: StatusField;
  approval: StatusField;
  redaction: StatusField;
  cleanup: StatusField;
  promotion: StatusField;
  receipt: ReceiptStatus;
  /** Unresolved BLOCKING closeout issues from buildLiveMcpLifecycle. */
  blockers: LifecycleIssue[];
  /** Linked development ticket reference (COORD-165 prep), when present. */
  linkedDevelopmentTicket: string | null;
  /** Deployed-verification receipt reference (COORD-165 prep), when present. */
  deployedVerificationReceipt: string | null;
}

export interface LiveMcpView {
  readOnly: true;
  /** Whether the engine modules loaded; false → degraded (engine missing). */
  engineAvailable: boolean;
  /** Effective role driving redaction. */
  role: Role;
  /** True when the viewer-level redaction is applied to detail strings. */
  redacted: boolean;
  tickets: LiveMcpTicketView[];
  /** Notice rendered at the top of the view (posture / degradation). */
  notice: string;
}

// ---- helpers ----

function meaningful(value: unknown): value is string {
  return viewModelCore.meaningful(value);
}

/** A required-evidence field → present/absent, with the detail masked for viewer. */
function statusField(value: unknown, redacted: boolean): StatusField {
  return viewModelCore.statusField(value, redacted);
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

function readPlanRecord(id: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLAN_RECORDS_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function boardStatus(id: string): string {
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')) as {
      sections?: Array<{ kind?: string; rows?: Array<Record<string, string>> }>;
    };
    for (const sec of board.sections ?? []) {
      if (sec.kind !== 'table' || !sec.rows) continue;
      for (const r of sec.rows) if (r.ID === id) return r.Status || 'unknown';
    }
  } catch {
    /* unreadable board */
  }
  return 'unknown';
}

/** Read the recorded live-mcp receipt for a ticket via the COORD-152 readers. */
function receiptStatus(
  id: string,
  declaration: Record<string, unknown>,
  engine: ReceiptEngine | null,
  redacted: boolean
): ReceiptStatus {
  return viewModelCore.receiptStatus({
    id,
    declaration,
    engine,
    redacted,
    coordDir: COORD_DIR,
    projectRoot: path.dirname(COORD_DIR)
  });
}

function buildTicketView(
  id: string,
  planState: unknown,
  declaration: Record<string, unknown>,
  lifecycle: LiveMcpEngine,
  receipts: ReceiptEngine | null,
  redacted: boolean
): LiveMcpTicketView {
  return viewModelCore.buildTicketView({
    id,
    status: boardStatus(id),
    planState,
    declaration,
    lifecycle,
    receipts,
    redacted,
    coordDir: COORD_DIR,
    projectRoot: path.dirname(COORD_DIR)
  });
}

/**
 * Build the read-only /live-mcp view for the given role. Lists every ticket
 * whose plan record declares a `live_mcp` object, sourcing its lifecycle status
 * from COORD-153 and its receipt status from COORD-152. NO writes / spawn /
 * mutation. Viewer roles receive redacted detail.
 */
export function loadLiveMcpView(role: Role): LiveMcpView {
  const lifecycle = loadLifecycleEngine();
  const receipts = loadReceiptEngine();
  const redacted = shouldRedact(role);

  if (!lifecycle) {
    return {
      readOnly: true,
      engineAvailable: false,
      role,
      redacted,
      tickets: [],
      notice:
        'Live-MCP lifecycle engine (coord/scripts/live-mcp-lifecycle.js) is unavailable in ' +
        'this build. This view is read-only and surfaces nothing rather than a partial state.'
    };
  }

  const tickets: LiveMcpTicketView[] = [];
  for (const id of listPlanIds()) {
    const planState = readPlanRecord(id);
    const declaration = lifecycle.readLiveMcpDeclaration(planState);
    if (!declaration) continue; // not a live-MCP ticket — explicit detection only
    tickets.push(buildTicketView(id, planState, declaration, lifecycle, receipts, redacted));
  }

  const notice = redacted
    ? 'Read-only live-MCP cockpit. You are viewing REDACTED summaries: operation, scope, ' +
      'approval/redaction/cleanup/promotion detail and receipt paths are masked. Operator/admin ' +
      'roles see operational detail. This view never executes a live tool and never mutates a ticket.'
    : 'Read-only live-MCP cockpit. Lifecycle status is sourced from the COORD-153 enforcement ' +
      'gate and receipts from the COORD-152 substrate. This view never executes a live tool and ' +
      'never mutates a ticket.';

  return { readOnly: true, engineAvailable: true, role, redacted, tickets, notice };
}

/**
 * Unresolved live-MCP closeout blockers across all declared live-MCP tickets,
 * for the evidence export. Each entry is a ticket + its unresolved cleanup /
 * promote (and other) lifecycle blockers. Pure read; reuses the COORD-153 gate.
 */
export interface LiveMcpExportTicket {
  id: string;
  adapter: string | null;
  operationClass: string | null;
  environment: string | null;
  receiptPath: string | null;
  unresolvedBlockers: LifecycleIssue[];
}

export function collectLiveMcpExport(): LiveMcpExportTicket[] {
  const lifecycle = loadLifecycleEngine();
  const receipts = loadReceiptEngine();
  if (!lifecycle) return [];
  const out: LiveMcpExportTicket[] = [];
  for (const id of listPlanIds()) {
    const planState = readPlanRecord(id);
    const declaration = lifecycle.readLiveMcpDeclaration(planState);
    if (!declaration) continue;
    out.push(viewModelCore.collectLiveMcpExportTicket({
      id,
      planState,
      declaration,
      lifecycle,
      receipts,
      coordDir: COORD_DIR,
      projectRoot: path.dirname(COORD_DIR)
    }));
  }
  return out;
}
