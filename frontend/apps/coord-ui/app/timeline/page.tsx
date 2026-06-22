import Link from 'next/link';
import { listEvents, eventCommands } from '../../lib/events';
import type { GovEvent } from '../../lib/types';
import { requireRole, redact, type Role } from '../../lib/access';

// SEC-001: the event log carries owner/session identifiers. Redacted for
// low-privilege (viewer) roles; operator+ sees the full owner attribution.
export const dynamic = 'force-dynamic';

const RESULT_CLASS: Record<string, string> = {
  succeeded: 'event__result--succeeded',
  failed: 'event__result--failed',
  error: 'event__result--error'
};

function fmtTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return ts;
  }
}

function EventRow({ ev, role }: { ev: GovEvent; role: Role }) {
  const cls = ev.result ? `event__result ${RESULT_CLASS[ev.result] || ''}` : 'event__result';
  return (
    <div className="event">
      <span className="event__ts">{fmtTs(ev.ts)}</span>
      <span className="event__cmd">{ev.command}</span>
      <span className="event__ticket">
        {ev.ticket ? (
          <Link href={`/ticket/${ev.ticket}`} className="event__ticket">
            {ev.ticket}
          </Link>
        ) : (
          '—'
        )}
      </span>
      <span className="event__owner">
        {ev.identity?.owner ? String(redact('identity', ev.identity.owner, role)) : ''}
      </span>
      <span className={cls}>{ev.result ?? ''}</span>
    </div>
  );
}

interface SearchParams {
  ticket?: string;
  command?: string;
  owner?: string;
  limit?: string;
}

export default async function TimelinePage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const role = await requireRole();
  const sp = await searchParams;
  const limit = Math.min(Math.max(parseInt(sp.limit ?? '200', 10) || 200, 10), 1000);
  const events = listEvents({
    ticket: sp.ticket || undefined,
    command: sp.command || undefined,
    owner: sp.owner || undefined,
    limit
  });
  const commands = eventCommands();

  return (
    <>
      <div className="board-meta">
        <span>
          events shown: <strong>{events.length}</strong>
        </span>
        <span>most recent first</span>
      </div>

      <div className="timeline-toolbar">
        <form method="get">
          <input
            type="text"
            name="ticket"
            placeholder="ticket id"
            defaultValue={sp.ticket ?? ''}
          />
          <select name="command" defaultValue={sp.command ?? ''}>
            <option value="">all commands</option>
            {commands.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="owner"
            placeholder="owner (e.g. claudea62)"
            defaultValue={sp.owner ?? ''}
          />
          <input
            type="number"
            name="limit"
            min={10}
            max={1000}
            step={10}
            defaultValue={String(limit)}
            style={{ width: '6rem' }}
          />
          <button type="submit">filter</button>
          <Link href="/timeline" className="coord-nav__link" style={{ marginLeft: '0.5rem' }}>
            clear
          </Link>
        </form>
      </div>

      <div className="timeline">
        {events.length === 0 ? (
          <div className="banner">No events match the current filter.</div>
        ) : (
          events.map((ev, i) => <EventRow key={`${ev.ts}-${i}`} ev={ev} role={role} />)
        )}
      </div>
    </>
  );
}
