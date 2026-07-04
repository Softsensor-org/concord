import 'server-only';
import fs from 'node:fs';
import { BOARD_PATH } from './coord-paths';

export interface PipelineRow {
  ticket: string;
  pr: string;
  hasPr: boolean;
  landed: boolean;
  landedAt?: string;
  method?: string;
  baseRef?: string;
  commitSha?: string;
}

export interface PipelineSummary {
  rows: PipelineRow[];
  total: number;
  withRealPr: number;
  localReview: number;
  landed: number;
}

function readBoard(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function loadPipeline(): PipelineSummary {
  const board = readBoard();
  const prIndex = (board.pr_index as Record<string, unknown>) || {};
  const landingIndex = (board.landing_index as Record<string, Record<string, unknown>>) || {};

  const tickets = new Set<string>([...Object.keys(prIndex), ...Object.keys(landingIndex)]);
  const rows: PipelineRow[] = [];

  for (const ticket of tickets) {
    const prRaw = prIndex[ticket];
    const prText = Array.isArray(prRaw)
      ? String(prRaw[0] ?? '')
      : prRaw
        ? String(prRaw)
        : '';
    const landing = landingIndex[ticket];
    const hasPr = /https?:\/\/|#\d+|pull\/\d+/.test(prText);
    rows.push({
      ticket,
      pr: prText || '—',
      hasPr,
      landed: Boolean(landing),
      landedAt: landing?.recorded_at ? String(landing.recorded_at) : undefined,
      method: landing?.method ? String(landing.method) : undefined,
      baseRef: landing?.base_ref ? String(landing.base_ref) : undefined,
      commitSha:
        typeof landing?.commit_sha === 'string'
          ? (landing.commit_sha as string).slice(0, 9)
          : undefined
    });
  }

  rows.sort((a, b) => {
    const at = a.landedAt ? new Date(a.landedAt).getTime() : 0;
    const bt = b.landedAt ? new Date(b.landedAt).getTime() : 0;
    if (at !== bt) return bt - at;
    return a.ticket.localeCompare(b.ticket);
  });

  return {
    rows,
    total: rows.length,
    withRealPr: rows.filter((r) => r.hasPr).length,
    localReview: rows.filter((r) => !r.hasPr).length,
    landed: rows.filter((r) => r.landed).length
  };
}
