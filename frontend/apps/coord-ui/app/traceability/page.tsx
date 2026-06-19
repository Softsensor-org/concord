import Link from 'next/link';
import { loadTraceability } from '../../lib/traceability';
import type { TraceState } from '../../lib/traceability';

const TRACE_CLASS: Record<TraceState, string> = {
  verified: 'trace-pill trace-pill--verified',
  'closing-gap': 'trace-pill trace-pill--gap',
  exempt: 'trace-pill trace-pill--exempt',
  todo: 'trace-pill trace-pill--todo',
  unknown: 'trace-pill'
};

export default function TraceabilityPage() {
  const t = loadTraceability();
  return (
    <>
      <div className="board-meta">
        <span>
          plans: <strong>{t.total}</strong>
        </span>
        <span>verified: {t.verified}</span>
        <span>closing-gap: {t.closingGap}</span>
        <span>exempt: {t.exempt}</span>
        <span>todo: {t.todo}</span>
        <span>
          requirement closure: <strong>{t.withRealClosure}</strong>/{t.total}
        </span>
      </div>

      <div className="trace-table">
        <div className="trace-row trace-row--head">
          <span>ticket</span>
          <span>trace gate</span>
          <span>closure</span>
          <span>requirement closure (ticket ask → implemented)</span>
        </div>
        {t.tickets.map((row) => (
          <div key={row.ticket} className="trace-row">
            <span className="trace-ticket">
              <Link href={`/ticket/${row.ticket}`}>{row.ticket}</Link>
            </span>
            <span>
              <span className={TRACE_CLASS[row.traceState]}>{row.traceState}</span>
            </span>
            <span className="trace-closure">
              {row.hasRealClosure ? '✓' : '—'}
              {row.priorFindings > 0 ? ` · ${row.priorFindings} prior` : ''}
            </span>
            <span className="trace-detail">
              {row.requirementClosure.length > 0
                ? row.requirementClosure.slice(0, 3).join(' · ')
                : 'no requirement closure recorded'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
