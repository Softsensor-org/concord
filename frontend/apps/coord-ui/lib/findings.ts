import 'server-only';
import fs from 'node:fs';
import { BOARD_PATH } from './coord-paths';

export interface ReviewFinding {
  id: string;
  ticket: string;
  severity: string;
  summary: string;
  status: string;
  round?: number;
  qref?: string;
}

export interface FindingsSummary {
  findings: ReviewFinding[];
  total: number;
  open: number;
  resolved: number;
  bySeverity: Record<string, number>;
  ticketsWithFindings: number;
}

const SEV_ORDER: Record<string, number> = { CRIT: 0, HIGH: 1, MED: 2, LOW: 3, INFO: 4 };

export function loadFindings(): FindingsSummary {
  let raw: Record<string, unknown[]> = {};
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
    raw = board.review_findings || {};
  } catch {
    raw = {};
  }

  const findings: ReviewFinding[] = [];
  for (const ticket of Object.keys(raw)) {
    const arr = Array.isArray(raw[ticket]) ? raw[ticket] : [];
    for (const f of arr as Array<Record<string, unknown>>) {
      findings.push({
        id: String(f.id ?? ''),
        ticket,
        severity: String(f.severity ?? 'UNKNOWN').toUpperCase(),
        summary: String(f.summary ?? ''),
        status: String(f.status ?? 'unknown'),
        round: typeof f.round === 'number' ? f.round : undefined,
        qref: f.qref ? String(f.qref) : undefined
      });
    }
  }

  const isOpen = (s: string) => s !== 'resolved' && s !== 'closed' && s !== 'waived';

  findings.sort((a, b) => {
    const oa = isOpen(a.status) ? 0 : 1;
    const ob = isOpen(b.status) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const sa = SEV_ORDER[a.severity] ?? 9;
    const sb = SEV_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });

  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  return {
    findings,
    total: findings.length,
    open: findings.filter((f) => isOpen(f.status)).length,
    resolved: findings.filter((f) => !isOpen(f.status)).length,
    bySeverity,
    ticketsWithFindings: Object.keys(raw).length
  };
}
