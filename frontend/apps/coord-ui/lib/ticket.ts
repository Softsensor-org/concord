import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE_DIR, PLAN_RECORDS_DIR, BOARD_PATH } from './coord-paths';
import { loadLock } from './board';
import { eventsForTicket } from './events';
import type { GovEvent, LockInfo } from './types';

export type TicketBoardRow = Record<string, string>;

export interface TicketDetail {
  id: string;
  spec: string | null;
  planRecord: unknown | null;
  lock: LockInfo | null;
  events: GovEvent[];
  boardRow: TicketBoardRow | null;
}

function readMd(id: string): string | null {
  const p = path.join(ACTIVE_DIR, `${id}.md`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function readPlanRecord(id: string): unknown | null {
  const p = path.join(PLAN_RECORDS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Looks the ticket up on the board (tasks.json) so a never-started ticket still resolves. */
function readBoardRow(id: string): TicketBoardRow | null {
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')) as {
      sections?: Array<{ kind?: string; rows?: TicketBoardRow[] }>;
    };
    for (const sec of board.sections ?? []) {
      if (sec.kind !== 'table' || !sec.rows) continue;
      for (const r of sec.rows) {
        if (r.ID === id) return r;
      }
    }
  } catch {
    /* no board / unreadable */
  }
  return null;
}

export function loadTicket(id: string): TicketDetail {
  return {
    id,
    spec: readMd(id),
    planRecord: readPlanRecord(id),
    lock: loadLock(id),
    events: eventsForTicket(id, 100),
    boardRow: readBoardRow(id)
  };
}
