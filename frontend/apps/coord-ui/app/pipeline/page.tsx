import Link from 'next/link';
import { loadPipeline } from '../../lib/pipeline';

function fmt(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return ts;
  }
}

export const dynamic = 'force-dynamic';

export default function PipelinePage() {
  const p = loadPipeline();
  return (
    <>
      <div className="board-meta">
        <span>
          tracked: <strong>{p.total}</strong>
        </span>
        <span>
          landed: <strong>{p.landed}</strong>
        </span>
        <span>real PR: {p.withRealPr}</span>
        <span>local-review (no PR): {p.localReview}</span>
      </div>

      <div className="trace-table">
        <div className="trace-row trace-row--head" style={{ gridTemplateColumns: '110px 1fr 90px 90px 110px' }}>
          <span>ticket</span>
          <span>pr / review</span>
          <span>landed</span>
          <span>method</span>
          <span>date · sha</span>
        </div>
        {p.rows.slice(0, 400).map((r) => (
          <div
            key={r.ticket}
            className="trace-row"
            style={{ gridTemplateColumns: '110px 1fr 90px 90px 110px' }}
          >
            <span className="trace-ticket">
              <Link href={`/ticket/${r.ticket}`}>{r.ticket}</Link>
            </span>
            <span className="trace-detail" style={{ WebkitLineClamp: 1 }}>
              {r.hasPr ? (
                <span className="trace-pill trace-pill--verified">PR</span>
              ) : (
                <span className="trace-pill trace-pill--exempt">no PR</span>
              )}{' '}
              {r.pr}
            </span>
            <span className="trace-closure">{r.landed ? '✓' : '—'}</span>
            <span className="agent-seen">{r.method ?? '—'}</span>
            <span className="agent-seen">
              {fmt(r.landedAt)}
              {r.commitSha ? ` · ${r.commitSha}` : ''}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
