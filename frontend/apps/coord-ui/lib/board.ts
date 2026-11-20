import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH, ACTIVE_DIR, LOCKS_DIR } from './coord-paths';
import type { BoardRow, GovEvent, LockInfo, Status } from './types';
import { listEvents } from './events';
import { mergeBoardRows, normalizeStatus } from './board-state.js';

interface TasksJson {
  sections?: Array<{
    kind: string;
    heading?: string;
    columns?: string[];
    rows?: Array<Record<string, string>>;
  }>;
}

function readJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function rowsFromBoard(): BoardRow[] {
  const board = readJsonSafe<TasksJson>(BOARD_PATH);
  if (!board?.sections) return [];
  const rows: BoardRow[] = [];
  for (const sec of board.sections) {
    if (sec.kind !== 'table' || !sec.rows) continue;
    for (const r of sec.rows) {
      const id = (r.ID || '').trim();
      if (!id) continue;
      const parsedStatus = normalizeStatus(r.Status);
      rows.push({
        id,
        repo: (r.Repo || '').trim(),
        type: r.Type,
        priority: r.Pri,
        status: parsedStatus.status as Status,
        blockedReason: parsedStatus.blockedReason,
        owner: r.Owner,
        description: r.Description,
        dependsOn: r['Depends On'],
        source: 'tasks.json'
      });
    }
  }
  return rows;
}

function rowsFromActiveDir(repoById: Map<string, string>): BoardRow[] {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  const out: BoardRow[] = [];
  for (const entry of fs.readdirSync(ACTIVE_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const id = entry.replace(/\.md$/, '');
    // Skip non-ticket markdown like README, TEMPLATE, PLATFORM_REPORT, design audits.
    if (!/^[A-Z]{2,8}-\d+$/.test(id)) continue;
    // Repo comes from the board row when the ticket is on tasks.json; active
    // markdown without a board row falls back to "X" (cross-repo / coord).
    const repo = repoById.get(id) || 'X';
    out.push({ id, repo, status: 'unknown', source: 'active' });
  }
  return out;
}

function readLocks(): Map<string, LockInfo> {
  const m = new Map<string, LockInfo>();
  if (!fs.existsSync(LOCKS_DIR)) return m;
  for (const entry of fs.readdirSync(LOCKS_DIR)) {
    if (!entry.endsWith('.lock') && !entry.endsWith('.json')) continue;
    const id = entry.replace(/\.(lock|json)$/, '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOCKS_DIR, entry), 'utf8'));
      m.set(id, {
        id,
        owner: raw.owner,
        agentId: raw.agent_id,
        branch: raw.branch,
        head: raw.head,
        startedAt: raw.started_at,
        raw
      });
    } catch {
      m.set(id, { id });
    }
  }
  return m;
}

export interface BoardView {
  rows: BoardRow[];
  locks: Map<string, LockInfo>;
  byStatus: Record<Status, BoardRow[]>;
  closedCount: number;
}

export function loadBoard(): BoardView {
  const boardRows = rowsFromBoard();
  const repoById = new Map(boardRows.filter((r) => r.repo).map((r) => [r.id, r.repo]));
  const activeRows = rowsFromActiveDir(repoById);
  const locks = readLocks();
  const eventsByTicket = new Map<string, GovEvent[]>();
  for (const event of listEvents({ limit: Number.MAX_SAFE_INTEGER })) {
    if (!event.ticket) continue;
    const events = eventsByTicket.get(event.ticket) ?? [];
    events.push(event);
    eventsByTicket.set(event.ticket, events);
  }
  const all = mergeBoardRows({ boardRows, activeRows, locks, eventsByTicket }) as BoardRow[];
  const byStatus: Record<Status, BoardRow[]> = {
    proposed: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
    blocked: [],
    superseded: [],
    unknown: []
  };
  let closedCount = 0;
  for (const r of all) {
    byStatus[r.status].push(r);
    if (r.status === 'done' || r.status === 'superseded') closedCount++;
  }

  const priOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  for (const k of Object.keys(byStatus) as Status[]) {
    byStatus[k].sort((a, b) => {
      const pa = priOrder[a.priority || ''] ?? 9;
      const pb = priOrder[b.priority || ''] ?? 9;
      if (pa !== pb) return pa - pb;
      return a.id.localeCompare(b.id);
    });
  }

  return { rows: all, locks, byStatus, closedCount };
}

export function loadLock(ticketId: string): LockInfo | null {
  return readLocks().get(ticketId) || null;
}
