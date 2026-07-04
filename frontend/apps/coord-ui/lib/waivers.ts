import 'server-only';
import fs from 'node:fs';
import { BOARD_PATH } from './coord-paths';

export interface Waiver {
  ticket: string;
  code: string;
  reason: string;
  recordedAt?: string;
  recordedBy?: string;
}

export interface FollowupException {
  ticket: string;
  parent?: string;
  type?: string;
}

export interface WaiversSummary {
  waivers: Waiver[];
  exceptions: FollowupException[];
  waiverCount: number;
  exceptionCount: number;
  byCode: Record<string, number>;
  byExceptionType: Record<string, number>;
}

function readBoard(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function loadWaivers(): WaiversSummary {
  const board = readBoard();
  const waiverIndex = (board.waiver_index as Record<string, Record<string, unknown>>) || {};
  const followupExceptions =
    (board.followup_exceptions as Record<string, Record<string, unknown>>) || {};

  const waivers: Waiver[] = Object.entries(waiverIndex).map(([ticket, w]) => ({
    ticket,
    code: String(w.code ?? 'unknown'),
    reason: String(w.reason ?? ''),
    recordedAt: w.recorded_at ? String(w.recorded_at) : undefined,
    recordedBy: w.recorded_by ? String(w.recorded_by) : undefined
  }));

  const exceptions: FollowupException[] = Object.entries(followupExceptions).map(
    ([ticket, e]) => ({
      ticket,
      parent: e.parent ? String(e.parent) : undefined,
      type: e.type ? String(e.type) : undefined
    })
  );

  waivers.sort((a, b) => {
    const at = a.recordedAt ? new Date(a.recordedAt).getTime() : 0;
    const bt = b.recordedAt ? new Date(b.recordedAt).getTime() : 0;
    return bt - at;
  });
  exceptions.sort((a, b) => a.ticket.localeCompare(b.ticket));

  const byCode: Record<string, number> = {};
  for (const w of waivers) byCode[w.code] = (byCode[w.code] ?? 0) + 1;
  const byExceptionType: Record<string, number> = {};
  for (const e of exceptions) {
    const k = e.type ?? 'unknown';
    byExceptionType[k] = (byExceptionType[k] ?? 0) + 1;
  }

  return {
    waivers,
    exceptions,
    waiverCount: waivers.length,
    exceptionCount: exceptions.length,
    byCode,
    byExceptionType
  };
}
