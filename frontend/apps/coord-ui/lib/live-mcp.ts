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
  return typeof value === 'string' && value.trim().length > 0;
}

/** A required-evidence field → present/absent, with the detail masked for viewer. */
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
  if (!engine) return { state: 'unknown', result: null, path: null };
  try {
    // Prefer the latest recorded receipt; fall back to an author-declared path.
    let file = engine.latestReceipt('live-mcp', id, { coordDir: COORD_DIR });
    if (!file && meaningful(declaration.receipt_path)) {
      file = path.resolve(COORD_DIR, '..', declaration.receipt_path.trim());
    }
    if (!file || !fs.existsSync(file)) {
      // An inline embedded receipt still satisfies "recorded".
      const inline = declaration.receipt;
      if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
        const result = (inline as Record<string, unknown>).result;
        return {
          state: 'present',
          result: redacted ? null : meaningful(result) ? result : 'recorded',
          path: null
        };
      }
      return { state: 'absent', result: null, path: null };
    }
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
    // Unreadable / malformed receipt: surface "unknown" rather than throwing.
    return { state: 'unknown', result: null, path: null };
  }
}

function buildTicketView(
  id: string,
  planState: unknown,
  declaration: Record<string, unknown>,
  lifecycle: LiveMcpEngine,
  receipts: ReceiptEngine | null,
  redacted: boolean
): LiveMcpTicketView {
  const result = lifecycle.buildLiveMcpLifecycle({ planState });
  const linkedDev = declaration.development_ticket ?? declaration.linked_ticket;
  const deployedVerification = declaration.deployed_verification ?? declaration.deploy_receipt;
  return {
    id,
    status: boardStatus(id),
    adapter: meaningful(declaration.adapter) ? declaration.adapter.trim() : null,
    operation:
      meaningful(declaration.operation) && !redacted ? declaration.operation.trim() : null,
    environment: meaningful(declaration.environment) ? declaration.environment.trim() : null,
    operationClass: meaningful(declaration.operation_class)
      ? declaration.operation_class.trim()
      : null,
    scope: statusField(declaration.scope, redacted),
    approval: statusField(declaration.approval, redacted),
    redaction: statusField(declaration.redaction, redacted),
    cleanup: statusField(declaration.cleanup, redacted),
    promotion: statusField(declaration.promotion, redacted),
    receipt: receiptStatus(id, declaration, receipts, redacted),
    blockers: Array.isArray(result.issues) ? result.issues : [],
    linkedDevelopmentTicket: meaningful(linkedDev) ? linkedDev.trim() : null,
    deployedVerificationReceipt:
      meaningful(deployedVerification) && !redacted ? deployedVerification.trim() : null
  };
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
    const result = lifecycle.buildLiveMcpLifecycle({ planState });
    const r = receiptStatus(id, declaration, receipts, false);
    out.push({
      id,
      adapter: meaningful(declaration.adapter) ? declaration.adapter.trim() : null,
      operationClass: meaningful(declaration.operation_class)
        ? declaration.operation_class.trim()
        : null,
      environment: meaningful(declaration.environment) ? declaration.environment.trim() : null,
      receiptPath: r.path,
      unresolvedBlockers: Array.isArray(result.issues) ? result.issues : []
    });
  }
  return out;
}
