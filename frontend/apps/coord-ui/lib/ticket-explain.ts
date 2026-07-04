import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH } from './coord-paths';
import { loadTicket } from './ticket';
import { loadBoard } from './board';
import { canonicalNextCommands } from './ticket-guidance';
import type { BoardRow, GovEvent, LockInfo, Status } from './types';

/**
 * UI-003 — operator explain panel data surface.
 *
 * Server-only, strictly read-only. Composes the same file-backed surfaces the
 * `gov explain <id>` command and the sibling coord-ui libs already read:
 *   - coord/board/tasks.json row + prompt_index / followup_exceptions /
 *     waiver_index / review_findings / pr_index / landing_index
 *   - coord/.runtime/plans/<id>.json (with legacy board/plans fallback, via
 *     loadTicket → coord-paths.PLAN_RECORDS_DIR)
 *   - coord/.runtime/governance-events.ndjson (via loadTicket)
 *   - coord/.runtime/locks/<id>.lock (via loadTicket)
 *   - repo gate artifacts referenced by the plan's repo_gates record
 *
 * It performs NO filesystem writes, NO gov mutations, and NO gate execution.
 * Derived "next safe commands" are returned as plain strings for display only.
 */

export type ReadinessLevel = 'ready' | 'blocked' | 'pending' | 'done' | 'na';

export interface ExplainSection<T = unknown> {
  level: ReadinessLevel;
  /** Human-readable one-line state, always non-scary when empty. */
  headline: string;
  detail?: T;
}

export interface LifecycleInfo {
  id: string;
  status: Status;
  repo?: string;
  type?: string;
  priority?: string;
  owner?: string;
  description?: string;
  promptPath?: string;
  /** Repo-relative prompt label, if a prompt is registered. */
  promptCoverage: boolean;
}

export interface LockView {
  present: boolean;
  owner?: string;
  agentId?: string;
  branch?: string;
  head?: string;
  worktree?: string;
  startedAt?: string;
  heartbeatAt?: string;
  sessionId?: string;
}

export interface DependencyBlocker {
  id: string;
  status: Status;
  blocking: boolean;
}

export interface ReviewCycle {
  cycle?: number;
  total?: number;
  lens?: string;
  verdict?: string;
  risks: string[];
  findings?: string;
  verification?: string;
}

export interface RequirementClosure {
  recorded: boolean;
  verdict?: string;
  lines: string[];
}

export interface FeatureProofItem {
  raw: string;
  placeholder: boolean;
}

export interface RepoGateItem {
  raw: string;
  placeholder: boolean;
}

export interface ReviewFindingView {
  id: string;
  severity: string;
  summary: string;
  status: string;
  round?: number;
  open: boolean;
}

export interface WaiverView {
  code: string;
  reason: string;
  recordedAt?: string;
  recordedBy?: string;
}

export interface FollowupExceptionView {
  parent?: string;
  type?: string;
}

export interface LandingView {
  present: boolean;
  method?: string;
  baseRef?: string;
  commitSha?: string;
  provenanceStatus?: string;
  recordedAt?: string;
  evidence: string[];
}

export interface TicketExplain {
  found: boolean;
  lifecycle: LifecycleInfo;
  lock: LockView;
  dependencies: ExplainSection<DependencyBlocker[]>;
  startReadiness: ExplainSection<string[]>;
  reviewReadiness: ExplainSection<{
    selfReviewComplete: boolean;
    cyclesRecorded: number;
    openFindings: number;
  }>;
  requirementClosure: ExplainSection<RequirementClosure>;
  featureProof: ExplainSection<FeatureProofItem[]>;
  repoGates: ExplainSection<RepoGateItem[]>;
  reviewCycles: ReviewCycle[];
  findings: ReviewFindingView[];
  prRefs: string[];
  landing: LandingView;
  waivers: WaiverView[];
  followupException: FollowupExceptionView | null;
  events: GovEvent[];
  nextCommands: string[];
}

const CLOSED_STATUSES: ReadonlySet<Status> = new Set<Status>(['done', 'superseded']);
const OPEN_STATUSES: ReadonlySet<Status> = new Set<Status>(['todo', 'blocked', 'unknown']);

function readBoardJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** TODO/scaffold placeholder lines emitted by `gov plan --seed`. */
function isPlaceholder(line: string): boolean {
  const v = line.trim();
  return v === '' || v.startsWith('TODO');
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function parseDependsOn(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '—' && s !== '-' && s.toLowerCase() !== 'none');
}

function lockView(lock: LockInfo | null): LockView {
  if (!lock) return { present: false };
  const raw = (lock.raw as Record<string, unknown>) || {};
  return {
    present: true,
    owner: lock.owner,
    agentId: lock.agentId,
    branch: lock.branch,
    head: lock.head,
    worktree: typeof raw.worktree === 'string' ? raw.worktree : undefined,
    startedAt: lock.startedAt ?? (typeof raw.started_at_utc === 'string' ? raw.started_at_utc : undefined),
    heartbeatAt: typeof raw.heartbeat_utc === 'string' ? raw.heartbeat_utc : undefined,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined
  };
}

function parseReviewCycles(plan: Record<string, unknown> | null): ReviewCycle[] {
  const arr = plan?.self_review_cycles;
  if (!Array.isArray(arr)) return [];
  return arr.map((c) => {
    const cy = (c ?? {}) as Record<string, unknown>;
    return {
      cycle: typeof cy.cycle === 'number' ? cy.cycle : undefined,
      total: typeof cy.total === 'number' ? cy.total : undefined,
      lens: typeof cy.lens === 'string' ? cy.lens : undefined,
      verdict: typeof cy.verdict === 'string' ? cy.verdict : undefined,
      risks: asStringArray(cy.risks),
      findings: typeof cy.findings === 'string' ? cy.findings : undefined,
      verification: typeof cy.verification === 'string' ? cy.verification : undefined
    };
  });
}

function deriveRequirementClosure(plan: Record<string, unknown> | null): RequirementClosure {
  const lines = asStringArray(plan?.requirement_closure).filter((l) => !isPlaceholder(l));
  const verdictLine = lines.find((l) => /closeout verdict/i.test(l));
  const verdict = verdictLine
    ? verdictLine.replace(/.*closeout verdict:\s*/i, '').trim()
    : undefined;
  return { recorded: lines.length > 0, verdict, lines };
}

function deriveSelfReviewComplete(plan: Record<string, unknown> | null, cycles: ReviewCycle[]): boolean {
  if (cycles.length === 0) return false;
  const expectedTotal = cycles.reduce((max, c) => Math.max(max, c.total ?? 0), 0) || 4;
  const passing = cycles.filter((c) => c.verdict === 'pass').length;
  return cycles.length >= expectedTotal && passing >= expectedTotal;
}

function findingsForTicket(board: Record<string, unknown>, id: string): ReviewFindingView[] {
  const raw = (board.review_findings as Record<string, unknown[]>) || {};
  const arr = Array.isArray(raw[id]) ? (raw[id] as Array<Record<string, unknown>>) : [];
  const isOpen = (s: string) => s !== 'resolved' && s !== 'closed' && s !== 'waived';
  return arr.map((f) => {
    const status = String(f.status ?? 'unknown');
    return {
      id: String(f.id ?? ''),
      severity: String(f.severity ?? 'UNKNOWN').toUpperCase(),
      summary: String(f.summary ?? ''),
      status,
      round: typeof f.round === 'number' ? f.round : undefined,
      open: isOpen(status)
    };
  });
}

function prRefsForTicket(board: Record<string, unknown>, id: string): string[] {
  const idx = (board.pr_index as Record<string, unknown>) || {};
  const v = idx[id];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null) return [];
  return [String(v)];
}

function landingForTicket(board: Record<string, unknown>, id: string): LandingView {
  const idx = (board.landing_index as Record<string, Record<string, unknown>>) || {};
  const rec = idx[id];
  if (!rec) return { present: false, evidence: [] };
  return {
    present: true,
    method: typeof rec.method === 'string' ? rec.method : undefined,
    baseRef: typeof rec.base_ref === 'string' ? rec.base_ref : undefined,
    commitSha:
      typeof rec.commit_sha === 'string' ? rec.commit_sha.slice(0, 9) : undefined,
    provenanceStatus:
      typeof rec.provenance_status === 'string' ? rec.provenance_status : undefined,
    recordedAt: typeof rec.recorded_at === 'string' ? rec.recorded_at : undefined,
    evidence: asStringArray(rec.evidence)
  };
}

/**
 * "Next safe command" hints. Display-only — never executed.
 *
 * COORD-106: the GOVERNED action commands (start / heartbeat / submit / repair /
 * set-pr / finalize --no-pr / finalize --pr / land / follow-up) come VERBATIM
 * from the canonical coord planner buildTicketNextCommands (ticket-guidance.js)
 * — the single source of truth for closeout routing — so the UI cannot drift
 * (e.g. wrongly advise `finalize --pr` for a repo-backed review ticket that must
 * `land`). We pass the LIVE board row (uppercase columns + the resolved live
 * status), the board's review_findings / pr_index, the lock, and the
 * start/submit blockers the UI already reads; the canonical function does the
 * per-status + repo-type routing. We keep a `gov explain` lead-in and a friendly
 * blocked/done annotation as pure UI affordances.
 */
function deriveNextCommands(args: {
  id: string;
  status: Status;
  repo?: string;
  type?: string;
  priority?: string;
  blocked: boolean;
  planSeeded: boolean;
  board: Record<string, unknown>;
  lock: LockInfo | null;
  landingPresent: boolean;
}): string[] {
  const { id, status, repo, type, priority, blocked, planSeeded, board, lock, landingPresent } = args;
  const cmds: string[] = [`coord/scripts/gov explain ${id}`];
  if (blocked) {
    cmds.push(`# blocked by dependencies — resolve blockers before start`);
    return cmds;
  }
  if (status === 'superseded') {
    cmds.push(`# superseded — no further action`);
    return cmds;
  }
  // UI affordance: a not-yet-seeded plan must be seeded before start. The
  // canonical planner's own start-blockers (collectStartReadinessBlockers) carry
  // this step server-side; the read-only UI surfaces the seed hint here and lets
  // the canonical planner emit the governed start verb.
  if (status === 'todo' && !planSeeded) {
    cmds.push(`coord/scripts/gov plan ${id} --seed`);
  }

  // The GOVERNED commands (start / heartbeat / submit / repair / set-pr /
  // finalize --no-pr / finalize --pr / land / follow-up) come VERBATIM from the
  // canonical planner, which reads row.Status / row.Repo + the board's
  // review_findings / pr_index. Hand it the LIVE status (not the possibly-stale
  // board column). startBlockers/submitBlockers are left empty: the UI does not
  // re-derive canonical blocker next_steps, so the planner emits the clean
  // governed verb for the live state.
  const canonical = canonicalNextCommands({
    board: board as never,
    row: {
      ID: id,
      Status: status,
      Repo: repo,
      Type: type,
      Pri: priority
    },
    ticketId: id,
    lock: lock ? ((lock.raw as Record<string, unknown>) ?? { ticket: id }) : null
  });
  cmds.push(...canonical);

  if (status === 'done') {
    cmds.push(landingPresent ? `# done — landing evidence recorded` : `# done — no landing record yet`);
  }
  return cmds;
}

export function loadTicketExplain(id: string): TicketExplain {
  const detail = loadTicket(id);
  const board = readBoardJson();
  const plan = (detail.planRecord as Record<string, unknown> | null) ?? null;

  const found = Boolean(
    detail.spec || detail.lock || detail.events.length > 0 || plan || detail.boardRow
  );

  // Resolve the live status via the same board derivation the home board uses,
  // so a lock or last-event promotes a board-only "todo" row consistently.
  const boardView = loadBoard();
  const liveRow: BoardRow | undefined = boardView.rows.find((r) => r.id === id);
  const row = detail.boardRow;
  const status: Status = liveRow?.status ?? 'unknown';

  const promptIndex = (board.prompt_index as Record<string, string>) || {};
  const promptPath = promptIndex[id];

  const lifecycle: LifecycleInfo = {
    id,
    status,
    repo: liveRow?.repo || row?.Repo,
    type: liveRow?.type || row?.Type,
    priority: liveRow?.priority || row?.Pri,
    owner: liveRow?.owner || row?.Owner || detail.lock?.owner,
    description: liveRow?.description || row?.Description,
    promptPath,
    promptCoverage: Boolean(promptPath)
  };

  const lock = lockView(detail.lock);

  // Dependencies / blockers — read Depends On from the board row and look up
  // the dependency's live status. A dep is "blocking" until it is closed.
  const depIds = parseDependsOn(row?.['Depends On'] || liveRow?.dependsOn);
  const depBlockers: DependencyBlocker[] = depIds.map((depId) => {
    const depRow = boardView.rows.find((r) => r.id === depId);
    const depStatus = depRow?.status ?? 'unknown';
    return { id: depId, status: depStatus, blocking: !CLOSED_STATUSES.has(depStatus) };
  });
  const blocked = depBlockers.some((d) => d.blocking);
  const dependencies: ExplainSection<DependencyBlocker[]> = {
    level: depBlockers.length === 0 ? 'na' : blocked ? 'blocked' : 'ready',
    headline:
      depBlockers.length === 0
        ? 'No dependencies'
        : blocked
        ? `Blocked by ${depBlockers.filter((d) => d.blocking).map((d) => d.id).join(', ')}`
        : 'All dependencies closed',
    detail: depBlockers
  };

  // Start readiness — only meaningful before work begins. Surfaces missing
  // plan state and unresolved blockers as the gating reasons.
  const planSeeded = Boolean(plan);
  const startBlockers: string[] = [];
  if (blocked) startBlockers.push('Unresolved dependency blockers');
  if (!planSeeded) startBlockers.push('Plan state not seeded (gov plan --seed)');
  const isOpenLifecycle = OPEN_STATUSES.has(status);
  const startReadiness: ExplainSection<string[]> = {
    level: !isOpenLifecycle ? 'done' : startBlockers.length === 0 ? 'ready' : 'blocked',
    headline: !isOpenLifecycle
      ? 'Work already started'
      : startBlockers.length === 0
      ? 'Ready to start'
      : 'Not startable yet',
    detail: startBlockers
  };

  // Review readiness.
  const reviewCycles = parseReviewCycles(plan);
  const findings = findingsForTicket(board, id);
  const openFindings = findings.filter((f) => f.open).length;
  const selfReviewComplete = deriveSelfReviewComplete(plan, reviewCycles);
  const reviewReadiness: ExplainSection<{
    selfReviewComplete: boolean;
    cyclesRecorded: number;
    openFindings: number;
  }> = {
    level:
      reviewCycles.length === 0
        ? 'pending'
        : openFindings > 0
        ? 'blocked'
        : selfReviewComplete
        ? 'ready'
        : 'pending',
    headline:
      reviewCycles.length === 0
        ? 'No self-review cycles recorded yet'
        : openFindings > 0
        ? `${openFindings} open review finding${openFindings === 1 ? '' : 's'}`
        : selfReviewComplete
        ? 'Self-review complete'
        : `${reviewCycles.length} review cycle${reviewCycles.length === 1 ? '' : 's'} recorded (incomplete)`,
    detail: { selfReviewComplete, cyclesRecorded: reviewCycles.length, openFindings }
  };

  // Requirement closure.
  const closure = deriveRequirementClosure(plan);
  const requirementClosure: ExplainSection<RequirementClosure> = {
    level: closure.recorded ? (closure.verdict === 'complete' ? 'ready' : 'pending') : 'pending',
    headline: closure.recorded
      ? closure.verdict
        ? `Requirement closure: ${closure.verdict}`
        : 'Requirement closure recorded'
      : 'No requirement closure recorded yet',
    detail: closure
  };

  // Feature proof.
  const featureProofItems: FeatureProofItem[] = asStringArray(plan?.feature_proof).map((raw) => ({
    raw,
    placeholder: isPlaceholder(raw)
  }));
  const realFeatureProof = featureProofItems.filter((f) => !f.placeholder);
  const featureProof: ExplainSection<FeatureProofItem[]> = {
    level: realFeatureProof.length > 0 ? 'ready' : 'pending',
    headline:
      realFeatureProof.length > 0
        ? `${realFeatureProof.length} feature proof anchor${realFeatureProof.length === 1 ? '' : 's'}`
        : 'No feature proof recorded yet',
    detail: featureProofItems
  };

  // Repo gates (recorded in the plan; references the repo gate artifacts).
  const repoGateItems: RepoGateItem[] = asStringArray(plan?.repo_gates).map((raw) => ({
    raw,
    placeholder: isPlaceholder(raw)
  }));
  const realRepoGates = repoGateItems.filter((g) => !g.placeholder);
  const repoGates: ExplainSection<RepoGateItem[]> = {
    level: realRepoGates.length > 0 ? 'ready' : 'pending',
    headline:
      realRepoGates.length > 0
        ? `${realRepoGates.length} repo gate result${realRepoGates.length === 1 ? '' : 's'} recorded`
        : 'No repo gate recorded yet',
    detail: repoGateItems
  };

  const prRefs = prRefsForTicket(board, id);
  const landing = landingForTicket(board, id);

  // Waivers / follow-up exceptions for this ticket.
  const waiverIdx = (board.waiver_index as Record<string, Record<string, unknown>>) || {};
  const waiverRec = waiverIdx[id];
  const waivers: WaiverView[] = waiverRec
    ? [
        {
          code: String(waiverRec.code ?? 'unknown'),
          reason: String(waiverRec.reason ?? ''),
          recordedAt: waiverRec.recorded_at ? String(waiverRec.recorded_at) : undefined,
          recordedBy: waiverRec.recorded_by ? String(waiverRec.recorded_by) : undefined
        }
      ]
    : [];
  const exIdx = (board.followup_exceptions as Record<string, Record<string, unknown>>) || {};
  const exRec = exIdx[id];
  const followupException: FollowupExceptionView | null = exRec
    ? {
        parent: exRec.parent ? String(exRec.parent) : undefined,
        type: exRec.type ? String(exRec.type) : undefined
      }
    : null;

  const nextCommands = deriveNextCommands({
    id,
    status,
    repo: lifecycle.repo,
    type: lifecycle.type,
    priority: lifecycle.priority,
    blocked,
    planSeeded,
    board,
    lock: detail.lock,
    landingPresent: landing.present
  });

  return {
    found,
    lifecycle,
    lock,
    dependencies,
    startReadiness,
    reviewReadiness,
    requirementClosure,
    featureProof,
    repoGates,
    reviewCycles,
    findings,
    prRefs,
    landing,
    waivers,
    followupException,
    events: detail.events.slice(0, 12),
    nextCommands
  };
}
