import Link from 'next/link';
import { loadWaivers } from '../../lib/waivers';

function fmt(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return ts;
  }
}

export default function WaiversPage() {
  const w = loadWaivers();
  const codeChips = Object.entries(w.byCode)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  const exChips = Object.entries(w.byExceptionType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');

  return (
    <>
      <div className="board-meta">
        <span>
          waivers: <strong>{w.waiverCount}</strong>
        </span>
        <span>
          follow-up exceptions: <strong>{w.exceptionCount}</strong>
        </span>
        <span>{codeChips}</span>
      </div>

      <h3 className="section-h">Waivers ({w.waiverCount})</h3>
      <div className="issues">
        {w.waivers.map((it) => (
          <div
            key={`${it.ticket}-${it.code}`}
            className="issue"
            style={{ gridTemplateColumns: '110px 150px 130px 1fr' }}
          >
            <span className="issue-ticket">
              <Link href={`/ticket/${it.ticket}`}>{it.ticket}</Link>
            </span>
            <span className="trace-pill trace-pill--exempt">{it.code}</span>
            <span className="agent-seen">
              {fmt(it.recordedAt)}
              {it.recordedBy ? ` · ${it.recordedBy}` : ''}
            </span>
            <span className="issue-summary">{it.reason}</span>
          </div>
        ))}
      </div>

      <h3 className="section-h">Follow-up exceptions ({w.exceptionCount})</h3>
      <div className="issues">
        {w.exceptions.slice(0, 300).map((e) => (
          <div
            key={e.ticket}
            className="issue"
            style={{ gridTemplateColumns: '110px 150px 110px 1fr' }}
          >
            <span className="issue-ticket">
              <Link href={`/ticket/${e.ticket}`}>{e.ticket}</Link>
            </span>
            <span className="trace-pill trace-pill--gap">{e.type ?? 'unknown'}</span>
            <span className="agent-seen">parent</span>
            <span className="issue-summary">
              {e.parent ? (
                <Link href={`/ticket/${e.parent}`} className="event__cmd">
                  {e.parent}
                </Link>
              ) : (
                '—'
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="board-meta" style={{ marginTop: '0.5rem' }}>
        <span>exception types — {exChips}</span>
      </div>
    </>
  );
}
