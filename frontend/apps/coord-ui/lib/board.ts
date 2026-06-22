import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH, ACTIVE_DIR, LOCKS_DIR } from './coord-paths';
import type { BoardRow, LockInfo, Status } from './types';
import { latestEventPerTicket } from './events';

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

function normalizeStatus(raw: string | undefined): Status {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  if (v === 'todo' || v === 'doing' || v === 'review' || v === 'done' || v === 'blocked' || v === 'superseded') {
    return v;
  }
  return 'unknown';
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
      rows.push({
        id,
        repo: (r.Repo || '').trim(),
        type: r.Type,
        priority: r.Pri,
        status: normalizeStatus(r.Status),
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

const STATUS_PROMOTION: Record<string, Status> = {
  start: 'doing',
  'start-ticket': 'doing',
  commit: 'doing',
  'commit-ticket': 'doing',
  plan: 'doing',
  'update-plan': 'doing',
  heartbeat: 'doing',
  'add-review-cycle': 'doing',
  'set-requirement-closure': 'doing',
  'add-feature-proof': 'doing',
  'add-repo-gate': 'doing',
  'pr-create': 'doing',
  'set-pr': 'doing',
  submit: 'review',
  'move-review': 'review',
  land: 'done',
  'mark-done': 'done',
  close: 'done',
  finalize: 'done',
  finish: 'done',
  'finish-ticket': 'done',
  supersede: 'superseded',
  reopen: 'todo',
  'reopen-ticket': 'todo'
};

function deriveStatusFromEvent(command: string): Status | undefined {
  return STATUS_PROMOTION[command];
}

export function loadBoard(): BoardView {
  const boardRows = rowsFromBoard();
  const repoById = new Map(boardRows.filter((r) => r.repo).map((r) => [r.id, r.repo]));
  const activeRows = rowsFromActiveDir(repoById);
  const locks = readLocks();
  const latest = latestEventPerTicket();

  // Active dir is the live queue and wins over tasks.json. tasks.json only
  // contributes status (done/superseded) for tickets NOT in active/.
  const activeIds = new Set(activeRows.map((r) => r.id));
  const byId = new Map<string, BoardRow>();

  for (const r of activeRows) byId.set(r.id, { ...r });
  for (const r of boardRows) {
    if (activeIds.has(r.id)) {
      // Enrich the active row with metadata from the board (description,
      // priority, type, repo) but do not let tasks.json overwrite status.
      const cur = byId.get(r.id)!;
      cur.repo = cur.repo || r.repo;
      cur.type = cur.type || r.type;
      cur.priority = cur.priority || r.priority;
      cur.description = cur.description || r.description;
      cur.dependsOn = cur.dependsOn || r.dependsOn;
      cur.owner = cur.owner || r.owner;
    } else {
      byId.set(r.id, r);
    }
  }

  for (const row of byId.values()) {
    // 1. Lock present → doing (strongest signal).
    if (locks.has(row.id)) {
      row.status = 'doing';
      const lock = locks.get(row.id)!;
      if (!row.owner && lock.owner) row.owner = lock.owner;
      continue;
    }
    // 2. tasks.json done/superseded for non-active tickets → keep.
    if (!activeIds.has(row.id) && (row.status === 'done' || row.status === 'superseded')) {
      continue;
    }
    // 3. Last event implies a status.
    const ev = latest.get(row.id);
    if (ev) {
      const derived = deriveStatusFromEvent(ev.command);
      if (derived) {
        row.status = derived;
        if (!row.owner && ev.identity?.owner) row.owner = ev.identity.owner;
        continue;
      }
    }
    // 4. Active md file with no derived status → todo.
    if (activeIds.has(row.id)) {
      row.status = 'todo';
    }
  }

  const all = Array.from(byId.values());
  const byStatus: Record<Status, BoardRow[]> = {
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
