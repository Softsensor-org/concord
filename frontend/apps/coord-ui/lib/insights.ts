import 'server-only';
import path from 'node:path';
import { COORD_DIR, BOARD_PATH, PLAN_RECORDS_DIR, EVENT_LOG_PATH } from './coord-paths';
import { requireExternal } from './external-require';

// COORD-415 "/insights" — READ-ONLY view of the gov insights strategic-execution
// report (insight-reports.js generateReport), mined from real journal + board +
// plan history. Reuses the engine report (no parallel mining). Recommends-only,
// never authority — the small sibling to /discovery.

export type InsightClaim = Record<string, unknown>;

export interface InsightSection {
  section: string;
  signalTotal: number;
  thinSignal: boolean;
  claims: InsightClaim[];
}

export interface InsightsModel {
  found: boolean;
  recommendsOnly: boolean;
  chainHead: string;
  historyScope: { journal_events: number; board_tickets: number; plan_records: number };
  sections: InsightSection[];
}

type InsightsEngine = {
  generateReport: (o: { boardPath: string; journalPath: string; plansDir: string }) => Record<string, unknown>;
  DEFAULT_BOARD_PATH?: string;
};

let cached: InsightsEngine | null = null;
function engine(): InsightsEngine {
  if (!cached) {
    cached = requireExternal<InsightsEngine>(path.join(COORD_DIR, 'scripts', 'insight-reports.js'));
  }
  return cached;
}

const EMPTY: InsightsModel = {
  found: false,
  recommendsOnly: true,
  chainHead: '',
  historyScope: { journal_events: 0, board_tickets: 0, plan_records: 0 },
  sections: []
};

export function loadInsights(): InsightsModel {
  try {
    const r = engine().generateReport({
      boardPath: BOARD_PATH,
      journalPath: EVENT_LOG_PATH,
      plansDir: PLAN_RECORDS_DIR
    });
    const rawSections = r.sections && typeof r.sections === 'object' ? Object.values(r.sections as Record<string, unknown>) : [];
    const sections: InsightSection[] = rawSections
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        section: String(s.section ?? ''),
        signalTotal: typeof s.signal_total === 'number' ? s.signal_total : 0,
        thinSignal: s.thin_signal === true,
        claims: Array.isArray(s.claims) ? (s.claims as InsightClaim[]) : []
      }));
    const scope = (r.history_scope as InsightsModel['historyScope'] | undefined) ?? EMPTY.historyScope;
    return {
      found: true,
      recommendsOnly: r.recommends_only !== false,
      chainHead: String(r.chain_head ?? ''),
      historyScope: scope,
      sections
    };
  } catch {
    return EMPTY;
  }
}

// Best-effort human label + headline metric for a claim, across section shapes.
export function claimLabel(c: InsightClaim): string {
  return String(c.theme ?? c.subsystem ?? c.ticket ?? c.repo ?? c.id ?? '—');
}

export function claimMetrics(c: InsightClaim): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' && k !== 'thin_signal') parts.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }
  return parts.slice(0, 3).join(' · ');
}
