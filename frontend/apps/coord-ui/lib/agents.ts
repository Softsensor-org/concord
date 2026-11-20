import 'server-only';
import fs from 'node:fs';
import { AGENTS_PATH, AGENT_SESSIONS_PATH } from './coord-paths';
import { loadBoard } from './board';

// Matches AGENT_SESSION_IDLE_MS in coord/scripts/governance.js
const IDLE_MS = 4 * 60 * 60 * 1000;

export type AgentLiveness = 'live' | 'stale' | 'idle' | 'offline';

export interface AgentSession {
  session_id: string;
  agent_id: string;
  handle?: string;
  host?: string;
  thread_id?: string;
  claimed_at?: string;
  last_seen_at?: string;
  released_at?: string | null;
  status?: string;
}

export interface AgentView {
  id: string;
  handle: string;
  provider: string;
  rosterStatus: string;
  liveness: AgentLiveness;
  lastSeenAt?: string;
  lastSessionId?: string;
  threadId?: string;
  heldTicket?: string;
}

interface RosterEntry {
  id: string;
  handle: string;
  provider: string;
  status: string;
  aliases?: string[];
}

function readJsonArray<T>(p: string): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(parsed)) return parsed as T[];
    if (parsed && typeof parsed === 'object') return Object.values(parsed) as T[];
    return [];
  } catch {
    return [];
  }
}

function classify(session: AgentSession | undefined, now: number): AgentLiveness {
  if (!session) return 'offline';
  if (session.released_at || session.status === 'released' || session.status === 'expired') {
    return 'offline';
  }
  if (session.status !== 'active') return 'offline';
  const seen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
  if (!seen) return 'idle';
  const age = now - seen;
  if (age < IDLE_MS) return 'live';
  if (age < 24 * 60 * 60 * 1000) return 'stale';
  return 'idle';
}

export interface AgentsSummary {
  agents: AgentView[];
  live: number;
  stale: number;
  idle: number;
  offline: number;
  totalSessions: number;
}

export function loadAgents(): AgentsSummary {
  const roster = readJsonArray<RosterEntry>(AGENTS_PATH);
  const sessions = readJsonArray<AgentSession>(AGENT_SESSIONS_PATH);
  const now = Date.now();

  // Latest session per agent_id by claimed_at.
  const latestByAgent = new Map<string, AgentSession>();
  for (const s of sessions) {
    if (!s.agent_id) continue;
    const cur = latestByAgent.get(s.agent_id);
    const sTime = s.claimed_at ? new Date(s.claimed_at).getTime() : 0;
    const cTime = cur?.claimed_at ? new Date(cur.claimed_at).getTime() : -1;
    if (!cur || sTime >= cTime) latestByAgent.set(s.agent_id, s);
  }

  // Tickets currently locked, keyed by owning agent/owner.
  const board = loadBoard();
  const heldByOwner = new Map<string, string>();
  for (const lock of board.locks.values()) {
    if (lock.agentId) heldByOwner.set(lock.agentId, lock.id);
    if (lock.owner) heldByOwner.set(lock.owner, lock.id);
  }

  const agents: AgentView[] = roster.map((r) => {
    const session = latestByAgent.get(r.id);
    const liveness = classify(session, now);
    return {
      id: r.id,
      handle: r.handle,
      provider: r.provider,
      rosterStatus: r.status,
      liveness,
      lastSeenAt: session?.last_seen_at,
      lastSessionId: session?.session_id,
      threadId: session?.thread_id,
      heldTicket: heldByOwner.get(r.id) || heldByOwner.get(r.handle)
    };
  });

  const order: Record<AgentLiveness, number> = { live: 0, stale: 1, idle: 2, offline: 3 };
  agents.sort((a, b) => {
    if (order[a.liveness] !== order[b.liveness]) return order[a.liveness] - order[b.liveness];
    return a.handle.localeCompare(b.handle);
  });

  return {
    agents,
    live: agents.filter((a) => a.liveness === 'live').length,
    stale: agents.filter((a) => a.liveness === 'stale').length,
    idle: agents.filter((a) => a.liveness === 'idle').length,
    offline: agents.filter((a) => a.liveness === 'offline').length,
    totalSessions: sessions.length
  };
}
