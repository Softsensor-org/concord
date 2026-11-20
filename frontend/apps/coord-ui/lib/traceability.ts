import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_RECORDS_DIR } from './coord-paths';

const TODO_RE = /^\s*TODO\b/i;

export type TraceState = 'verified' | 'closing-gap' | 'exempt' | 'todo' | 'unknown';

export interface TicketTrace {
  ticket: string;
  traceState: TraceState;
  traceRaw: string[];
  requirementClosure: string[];
  hasRealClosure: boolean;
  priorFindings: number;
}

export interface TraceabilitySummary {
  tickets: TicketTrace[];
  total: number;
  verified: number;
  closingGap: number;
  exempt: number;
  todo: number;
  withRealClosure: number;
}

function classifyTrace(gate: unknown): { state: TraceState; raw: string[] } {
  const raw = Array.isArray(gate) ? gate.map(String) : gate ? [String(gate)] : [];
  const joined = raw.join(' ').toLowerCase();
  if (raw.some((x) => TODO_RE.test(x))) return { state: 'todo', raw };
  if (joined.includes('verified')) return { state: 'verified', raw };
  if (joined.includes('closing-gap') || joined.includes('closing gap'))
    return { state: 'closing-gap', raw };
  if (joined.includes('exempt')) return { state: 'exempt', raw };
  if (raw.length === 0) return { state: 'unknown', raw };
  return { state: 'unknown', raw };
}

export function loadTraceability(): TraceabilitySummary {
  const tickets: TicketTrace[] = [];
  if (fs.existsSync(PLAN_RECORDS_DIR)) {
    for (const file of fs.readdirSync(PLAN_RECORDS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PLAN_RECORDS_DIR, file), 'utf8'));
        const { state, raw } = classifyTrace(p.traceability_gate);
        const closure: string[] = Array.isArray(p.requirement_closure)
          ? p.requirement_closure.map(String)
          : [];
        const hasRealClosure = closure.some((x) => !TODO_RE.test(x)) && closure.length > 0;
        tickets.push({
          ticket: p.ticket_id || file.replace(/\.json$/, ''),
          traceState: state,
          traceRaw: raw,
          requirementClosure: closure,
          hasRealClosure,
          priorFindings: Array.isArray(p.prior_findings) ? p.prior_findings.length : 0
        });
      } catch {
        /* skip unreadable plan record */
      }
    }
  }

  const order: Record<TraceState, number> = {
    todo: 0,
    'closing-gap': 1,
    unknown: 2,
    verified: 3,
    exempt: 4
  };
  tickets.sort((a, b) => {
    if (order[a.traceState] !== order[b.traceState]) {
      return order[a.traceState] - order[b.traceState];
    }
    return a.ticket.localeCompare(b.ticket);
  });

  return {
    tickets,
    total: tickets.length,
    verified: tickets.filter((t) => t.traceState === 'verified').length,
    closingGap: tickets.filter((t) => t.traceState === 'closing-gap').length,
    exempt: tickets.filter((t) => t.traceState === 'exempt').length,
    todo: tickets.filter((t) => t.traceState === 'todo').length,
    withRealClosure: tickets.filter((t) => t.hasRealClosure).length
  };
}
