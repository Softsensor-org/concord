import Link from 'next/link';
import { loadFindings } from '../../lib/findings';

function sevClass(sev: string): string {
  if (sev === 'CRIT' || sev === 'HIGH') return 'sev sev--high';
  if (sev === 'MED') return 'sev sev--med';
  if (sev === 'LOW') return 'sev sev--low';
  return 'sev';
}

function statusClass(status: string): string {
  return status === 'resolved' || status === 'closed' || status === 'waived'
    ? 'fstatus fstatus--resolved'
    : 'fstatus fstatus--open';
}

export const dynamic = 'force-dynamic';

export default function IssuesPage() {
  const f = loadFindings();
  const sevChips = Object.entries(f.bySeverity)
    .sort()
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');

  return (
    <>
      <div className="board-meta">
        <span>
          findings: <strong>{f.total}</strong>
        </span>
        <span>
          open: <strong>{f.open}</strong>
        </span>
        <span>resolved: {f.resolved}</span>
        <span>{sevChips}</span>
        <span>tickets with findings: {f.ticketsWithFindings}</span>
      </div>

      {f.total === 0 ? (
        <div className="banner">No review findings recorded in board/tasks.json.</div>
      ) : (
        <div className="issues">
          {f.findings.map((it) => (
            <div key={it.id || `${it.ticket}-${it.summary.slice(0, 12)}`} className="issue">
              <span className={sevClass(it.severity)}>{it.severity}</span>
              <span className={statusClass(it.status)}>{it.status}</span>
              <span className="issue-ticket">
                <Link href={`/ticket/${it.ticket}`}>{it.ticket}</Link>
              </span>
              <span className="issue-id">{it.id}</span>
              <span className="issue-summary">
                {it.summary}
                {it.round ? <span className="issue-round"> · round {it.round}</span> : null}
                {it.qref ? <span className="issue-round"> · {it.qref}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
