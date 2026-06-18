import 'server-only';
import fs from 'node:fs';
import { BOARD_PATH } from './coord-paths';
import { loadTicket } from './ticket';
import { loadBoard } from './board';
import { eventsForTicket } from './events';
import type { BoardRow, GovEvent } from './types';

/**
 * UI-007 — /evidence operator view data surface.
 *
 * Server-only, strictly READ-ONLY. Mirrors the dossier the read-only exporter
 * coord/scripts/evidence-export.mjs produces (evidenceStatus / buildTicketEvidence)
 * by reading the SAME sources directly:
 *   - coord/board/tasks.json  → row + landing_index / pr_index / waiver_index /
 *     followup_exceptions / review_findings
 *   - coord/.runtime/plans/<id>.json (via loadTicket) → requirement_closure,
 *     feature_proof, repo_gates, self_review_cycles, critical_invariants
 *   - coord/.runtime/governance-events.ndjson (via eventsForTicket) → journal
 *
 * We re-derive (rather than `require`) because evidence-export.mjs is a CLI module
 * whose top-level main() reads argv, writes files, and sets process.exitCode — it
 * is not safe to import from the web tier. Re-deriving keeps the page free of any
 * write/exit surface while staying faithful to the exporter's completeness rules.
 *
 * It performs NO writes, NO mutations, NO git/spawn. The git-tip landing audits
 * (token-economics/landing-audit verify files at branch tip via git) are NOT
 * re-run here; instead the RECORDED landing-audit evidence and provenance status
 * already in landing_index are surfaced, so the page stays read-only.
 */

export type EvidenceState = 'present' | 'absent' | 'not_applicable';

/** Required self-review cycles, mirroring evidence-export REQUIRED_CYCLES. */
const REQUIRED_CYCLES = (repo: string): number => (repo === 'X' ? 3 : 4);

export interface MatrixRow {
  /** stable key for the dimension (e.g. "requirement_closure"). */
  key: string;
  /** human label. */
  label: string;
  state: EvidenceState;
  /** one-line, non-scary detail of what is / is not present. */
  detail: string;
}

export interface ReviewCycleLite {
  cycle?: number;
  lens?: string;
  verdict?: string;
}

export interface DossierFinding {
  id: string;
  severity: string;
  summary: string;
  status: string;
  open: boolean;
}

export interface TicketDossier {
  id: string;
  repo: string;
  type?: string;
  priority?: string;
  status: string;
  /** the per-ticket completeness matrix (the headline of the dossier). */
  matrix: MatrixRow[];
  /** evidence dimensions that are absent — actionable gaps, never blank. */
  gaps: string[];
  /** true when no required dimension is absent. */
  complete: boolean;
  requirementClosure: {
    ticketAsk: string | null;
    implemented: string | null;
    notImplemented: string | null;
    deferredTo: string | null;
    verdict: string | null;
    lines: string[];
  };
  featureProof: string[];
  reviewCycles: ReviewCycleLite[];
  reviewCycleCount: number;
  requiredCycles: number;
  criticalInvariants: string[];
  repoGates: string[];
  findings: DossierFinding[];
  prRefs: string[];
  landing: {
    present: boolean;
    method?: string;
    baseRef?: string;
    commitSha?: string;
    provenanceStatus?: string;
    recordedAt?: string;
    /** recorded landing-audit evidence lines (testing-infra / feature-proof). */
    evidence: string[];
  };
  waivers: { code: string; reason: string } | null;
  followupException: { parent?: string; type?: string } | null;
  /** the closeout verdict, surfaced separately for the dossier header. */
  closeoutVerdict: string | null;
}

export interface EvidenceIndexRow {
  id: string;
  repo: string;
  priority?: string;
  status: string;
  complete: boolean;
  gapCount: number;
  closeoutVerdict: string | null;
  reviewCycleCount: number;
  requiredCycles: number;
  landed: boolean;
}

export interface EvidenceIndex {
  /** done/superseded tickets, sorted; the dossier candidates. */
  rows: EvidenceIndexRow[];
  doneCount: number;
  withGaps: number;
  /** true when there are no closed tickets to build a dossier from. */
  empty: boolean;
}

// --- helpers ------------------------------------------------------------------

function readBoardJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function isPlaceholder(line: string): boolean {
  const v = line.trim();
  return v === '' || v.startsWith('TODO');
}

/** "Key: value" closure lines → lowercased-key map, mirroring parseClosure. */
function parseClosure(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const idx = item.indexOf(':');
    if (idx > 0) out[item.slice(0, idx).trim().toLowerCase()] = item.slice(idx + 1).trim();
  }
  return out;
}

/** Parse a repo_gates entry like "... result=pass ..." → result token. */
function gateResult(gateStr: string): string {
  const m = /result=([a-z-]+)/i.exec(gateStr);
  if (m) return m[1].toLowerCase();
  if (/not-required/i.test(gateStr)) return 'not-required';
  return 'unknown';
}

function landingForTicket(board: Record<string, unknown>, id: string): TicketDossier['landing'] {
  const idx = (board.landing_index as Record<string, Record<string, unknown>>) || {};
  const rec = idx[id];
  if (!rec) return { present: false, evidence: [] };
  return {
    present: true,
    method: typeof rec.method === 'string' ? rec.method : undefined,
    baseRef: typeof rec.base_ref === 'string' ? rec.base_ref : undefined,
    commitSha: typeof rec.commit_sha === 'string' ? rec.commit_sha.slice(0, 9) : undefined,
    provenanceStatus: typeof rec.provenance_status === 'string' ? rec.provenance_status : undefined,
    recordedAt: typeof rec.recorded_at === 'string' ? rec.recorded_at : undefined,
    evidence: asStringArray(rec.evidence)
  };
}

function prRefsForTicket(board: Record<string, unknown>, id: string): string[] {
  const idx = (board.pr_index as Record<string, unknown>) || {};
  const v = idx[id];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null) return [];
  return [String(v)];
}

function findingsForTicket(board: Record<string, unknown>, id: string): DossierFinding[] {
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
      open: isOpen(status)
    };
  });
}

/**
 * Build the per-ticket completeness matrix. Mirrors evidenceStatus + the
 * exporter's gap rule: a dimension is `present`, `absent`, or `not_applicable`.
 * `gaps` are the absent (required) dimensions — they render as actionable text,
 * never a blank card.
 */
function buildMatrix(args: {
  repo: string;
  journalCount: number;
  closure: Record<string, string>;
  featureProofReal: number;
  reviewCycleCount: number;
  requiredCycles: number;
  gatesOk: boolean;
  gatesRecorded: number;
  landingPresent: boolean;
  prCount: number;
  landingAuditLines: number;
  openFindings: number;
  waiverPresent: boolean;
}): { matrix: MatrixRow[]; gaps: string[] } {
  const {
    repo,
    journalCount,
    closure,
    featureProofReal,
    reviewCycleCount,
    requiredCycles,
    gatesOk,
    gatesRecorded,
    landingPresent,
    prCount,
    landingAuditLines,
    openFindings,
    waiverPresent
  } = args;
  const closeoutComplete = (closure['closeout verdict'] || '').toLowerCase() === 'complete';
  const featureProofState: EvidenceState =
    featureProofReal > 0 ? 'present' : repo === 'X' ? 'not_applicable' : 'absent';
  const landingState: EvidenceState = landingPresent || prCount > 0 ? 'present' : 'absent';

  const matrix: MatrixRow[] = [
    {
      key: 'requirement_closure',
      label: 'Requirement closure',
      state: closeoutComplete ? 'present' : 'absent',
      detail: closeoutComplete
        ? `closeout verdict: ${closure['closeout verdict']}`
        : 'no "complete" closeout verdict recorded'
    },
    {
      key: 'feature_proof',
      label: 'Feature proof',
      state: featureProofState,
      detail:
        featureProofState === 'present'
          ? `${featureProofReal} proof anchor(s)`
          : featureProofState === 'not_applicable'
          ? 'coordination ticket (repo X) — not required'
          : 'no feature-proof anchors recorded'
    },
    {
      key: 'repo_gates',
      label: 'Repo gates',
      state: gatesOk ? 'present' : 'absent',
      detail: gatesOk
        ? `${gatesRecorded} gate result(s); at least one pass/not-required`
        : gatesRecorded > 0
        ? `${gatesRecorded} gate result(s) recorded, none passing`
        : 'no repo gate result recorded'
    },
    {
      key: 'review_cycles',
      label: 'Self-review cycles',
      state: reviewCycleCount >= requiredCycles ? 'present' : 'absent',
      detail: `${reviewCycleCount} of ${requiredCycles} required cycle(s) recorded`
    },
    {
      key: 'review_findings',
      label: 'Review findings',
      // Findings are informational unless one is still open (then it is a gap).
      state: openFindings > 0 ? 'absent' : 'present',
      detail:
        openFindings > 0
          ? `${openFindings} open finding(s) — resolve before closeout`
          : 'no open review findings'
    },
    {
      key: 'pr_refs',
      label: 'PR references',
      // PR refs are informational: a no-PR landing is legitimate, so never a gap.
      state: prCount > 0 ? 'present' : 'not_applicable',
      detail: prCount > 0 ? `${prCount} PR reference(s)` : 'no PR ref (local / no-PR landing)'
    },
    {
      key: 'landing_provenance',
      label: 'Landing proof',
      state: landingState,
      detail:
        landingState === 'present'
          ? 'landing or PR provenance recorded'
          : 'no landing or PR provenance recorded'
    },
    {
      key: 'landing_audit',
      label: 'Landing audits (testing-infra / feature-proof)',
      // Informational: the git-tip audits (token-economics/landing-audit verify
      // files at branch tip) are NOT re-run in this read-only view, so a missing
      // recorded audit line is never a hard gap on its own — the landing_provenance
      // row above carries the actual landed-or-not gap.
      state: landingAuditLines > 0 ? 'present' : 'not_applicable',
      detail:
        landingAuditLines > 0
          ? `${landingAuditLines} recorded landing-audit evidence line(s)`
          : landingState === 'present'
          ? 'landed without explicit audit evidence lines (audits not re-run read-only)'
          : 'no landing record to audit'
    },
    {
      key: 'journal_log',
      label: 'Governance journal',
      state: journalCount > 0 ? 'present' : 'absent',
      detail: `${journalCount} journal event(s)`
    },
    {
      key: 'waivers',
      label: 'Waivers / risk acceptance',
      // Informational, never a gap (mirrors exporter: waivers always "present").
      state: 'present',
      detail: waiverPresent ? 'risk acceptance recorded' : 'none — clean'
    },
    {
      key: 'closeout_verdict',
      label: 'Closeout verdict',
      state: closeoutComplete ? 'present' : 'absent',
      detail: closeoutComplete ? `${closure['closeout verdict']}` : 'not marked complete'
    }
  ];

  // Gaps: dimensions that are absent. not_applicable / present never count.
  const gaps = matrix.filter((m) => m.state === 'absent').map((m) => m.key);
  return { matrix, gaps };
}

/** Build a full dossier for one ticket from the live sources. */
export function loadTicketDossier(id: string): TicketDossier | null {
  const detail = loadTicket(id);
  const boardJson = readBoardJson();
  const boardView = loadBoard();
  const row: BoardRow | undefined = boardView.rows.find((r) => r.id === id);
  const plan = (detail.planRecord as Record<string, unknown> | null) ?? null;

  const found = Boolean(plan || detail.boardRow || row);
  if (!found) return null;

  const repo = row?.repo || detail.boardRow?.Repo || 'X';
  const status = row?.status ?? 'unknown';

  const closureLines = asStringArray(plan?.requirement_closure).filter((l) => !isPlaceholder(l));
  const closure = parseClosure(closureLines);

  const featureProof = asStringArray(plan?.feature_proof).filter((l) => !isPlaceholder(l));
  const repoGates = asStringArray(plan?.repo_gates).filter((l) => !isPlaceholder(l));
  const gatesOk = repoGates.some((g) => ['pass', 'not-required'].includes(gateResult(g)));
  const criticalInvariants = asStringArray(plan?.critical_invariants).filter((l) => !isPlaceholder(l));

  const cyclesRaw = Array.isArray(plan?.self_review_cycles)
    ? (plan?.self_review_cycles as Array<Record<string, unknown>>)
    : [];
  const reviewCycles: ReviewCycleLite[] = cyclesRaw.map((c) => ({
    cycle: typeof c.cycle === 'number' ? c.cycle : undefined,
    lens: typeof c.lens === 'string' ? c.lens : undefined,
    verdict: typeof c.verdict === 'string' ? c.verdict : undefined
  }));
  const requiredCycles = REQUIRED_CYCLES(repo);

  const events: GovEvent[] = eventsForTicket(id, 1000);
  const findings = findingsForTicket(boardJson, id);
  const openFindings = findings.filter((f) => f.open).length;
  const prRefs = prRefsForTicket(boardJson, id);
  const landing = landingForTicket(boardJson, id);

  const waiverIdx = (boardJson.waiver_index as Record<string, Record<string, unknown>>) || {};
  const waiverRec = waiverIdx[id];
  const waivers = waiverRec
    ? { code: String(waiverRec.code ?? 'unknown'), reason: String(waiverRec.reason ?? '') }
    : null;
  const exIdx = (boardJson.followup_exceptions as Record<string, Record<string, unknown>>) || {};
  const exRec = exIdx[id];
  const followupException = exRec
    ? {
        parent: exRec.parent ? String(exRec.parent) : undefined,
        type: exRec.type ? String(exRec.type) : undefined
      }
    : null;

  const { matrix, gaps } = buildMatrix({
    repo,
    journalCount: events.length,
    closure,
    featureProofReal: featureProof.length,
    reviewCycleCount: reviewCycles.length,
    requiredCycles,
    gatesOk,
    gatesRecorded: repoGates.length,
    landingPresent: landing.present,
    prCount: prRefs.length,
    landingAuditLines: landing.evidence.length,
    openFindings,
    waiverPresent: Boolean(waivers)
  });

  return {
    id,
    repo,
    type: row?.type,
    priority: row?.priority,
    status,
    matrix,
    gaps,
    complete: gaps.length === 0,
    requirementClosure: {
      ticketAsk: closure['ticket ask'] || null,
      implemented: closure['implemented'] || null,
      notImplemented: closure['not implemented'] || null,
      deferredTo: closure['deferred to'] || null,
      verdict: closure['closeout verdict'] || null,
      lines: closureLines
    },
    featureProof,
    reviewCycles,
    reviewCycleCount: reviewCycles.length,
    requiredCycles,
    criticalInvariants,
    repoGates,
    findings,
    prRefs,
    landing,
    waivers,
    followupException,
    closeoutVerdict: closure['closeout verdict'] || null
  };
}

/**
 * Index of closed (done/superseded) tickets — the dossier candidates. Sorted by
 * id for determinism. Empty when there are no closed tickets at all.
 */
export function loadEvidenceIndex(): EvidenceIndex {
  const board = loadBoard();
  const closed = board.rows
    .filter((r) => r.status === 'done' || r.status === 'superseded')
    .sort((a, b) => a.id.localeCompare(b.id));

  const rows: EvidenceIndexRow[] = closed.map((r) => {
    const d = loadTicketDossier(r.id);
    return {
      id: r.id,
      repo: r.repo || 'X',
      priority: r.priority,
      status: r.status,
      complete: d ? d.complete : false,
      gapCount: d ? d.gaps.length : 0,
      closeoutVerdict: d ? d.closeoutVerdict : null,
      reviewCycleCount: d ? d.reviewCycleCount : 0,
      requiredCycles: d ? d.requiredCycles : REQUIRED_CYCLES(r.repo || 'X'),
      landed: d ? d.landing.present || d.prRefs.length > 0 : false
    };
  });

  return {
    rows,
    doneCount: rows.length,
    withGaps: rows.filter((r) => !r.complete).length,
    empty: rows.length === 0
  };
}
