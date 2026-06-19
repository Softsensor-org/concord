import Link from 'next/link';
import { loadAgents } from '../../lib/agents';
import type { AgentLiveness } from '../../lib/agents';

const DOT: Record<AgentLiveness, string> = {
  live: 'dot dot--live',
  stale: 'dot dot--stale',
  idle: 'dot dot--idle',
  offline: 'dot dot--offline'
};

const LIVENESS_LABEL: Record<AgentLiveness, string> = {
  live: 'live (seen <4h)',
  stale: 'stale (4–24h)',
  idle: 'idle (>24h)',
  offline: 'offline'
};

function fmt(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return ts;
  }
}

export default function AgentsPage() {
  const a = loadAgents();
  return (
    <>
      <div className="board-meta">
        <span>
          running: <strong>{a.live}</strong>
        </span>
        <span>stale: {a.stale}</span>
        <span>idle: {a.idle}</span>
        <span>offline: {a.offline}</span>
        <span>roster: {a.agents.length}</span>
        <span>sessions logged: {a.totalSessions}</span>
      </div>

      <div className="agents">
        {a.agents.map((ag) => (
          <div key={ag.id} className="agent-row">
            <span className={DOT[ag.liveness]} title={LIVENESS_LABEL[ag.liveness]} />
            <span className="agent-handle">{ag.handle}</span>
            <span className="agent-id">{ag.id}</span>
            <span className="agent-provider">{ag.provider}</span>
            <span className="agent-liveness">{LIVENESS_LABEL[ag.liveness]}</span>
            <span className="agent-seen">{fmt(ag.lastSeenAt)}</span>
            <span className="agent-ticket">
              {ag.heldTicket ? (
                <Link href={`/ticket/${ag.heldTicket}`}>{ag.heldTicket}</Link>
              ) : (
                '—'
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
