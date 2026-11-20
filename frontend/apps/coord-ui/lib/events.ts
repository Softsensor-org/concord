import 'server-only';
import fs from 'node:fs';
import { EVENT_LOG_PATH } from './coord-paths';
import type { GovEvent } from './types';

const MAX_BYTES_READ = 4 * 1024 * 1024; // last 4 MB by default

function tailRead(filePath: string, maxBytes: number): string {
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
  const start = stat.size - maxBytes;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, start);
    let text = buf.toString('utf8');
    const firstNl = text.indexOf('\n');
    if (firstNl >= 0) text = text.slice(firstNl + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text: string): GovEvent[] {
  const out: GovEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export interface EventQuery {
  limit?: number;
  ticket?: string;
  command?: string;
  owner?: string;
  agent?: string;
}

let cached: { events: GovEvent[]; mtimeMs: number; size: number } | null = null;

function loadAllEvents(): GovEvent[] {
  if (!fs.existsSync(EVENT_LOG_PATH)) return [];
  const stat = fs.statSync(EVENT_LOG_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.events;
  }
  const text = tailRead(EVENT_LOG_PATH, MAX_BYTES_READ);
  const events = parseLines(text);
  cached = { events, mtimeMs: stat.mtimeMs, size: stat.size };
  return events;
}

export function listEvents(query: EventQuery = {}): GovEvent[] {
  const all = loadAllEvents();
  const filtered = all.filter((e) => {
    if (query.ticket && e.ticket !== query.ticket) return false;
    if (query.command && e.command !== query.command) return false;
    if (query.owner && e.identity?.owner !== query.owner) return false;
    if (query.agent && e.identity?.agent_id !== query.agent) return false;
    return true;
  });
  const limit = query.limit ?? 200;
  return filtered.slice(-limit).reverse();
}

export function eventCommands(): string[] {
  const all = loadAllEvents();
  const set = new Set<string>();
  for (const e of all) {
    if (e.command) set.add(e.command);
  }
  return Array.from(set).sort();
}

export function latestEventPerTicket(): Map<string, GovEvent> {
  const all = loadAllEvents();
  const map = new Map<string, GovEvent>();
  for (const e of all) {
    if (!e.ticket) continue;
    map.set(e.ticket, e);
  }
  return map;
}

export function eventsForTicket(ticket: string, limit = 100): GovEvent[] {
  return listEvents({ ticket, limit });
}

/** A recorded `precheck.observed` journal verdict (from `gov precheck --record`). */
export interface RecordedPrecheck {
  ticket: string;
  verdict: string;
  probeCount: number;
  /** ISO timestamp of the recording event (for "as of" display / debugging). */
  recordedAt: string;
}

interface PrecheckObservedDetails {
  event_type?: string;
  precheck?: { ticket?: string; verdict?: string; probe_count?: number };
}

/**
 * Latest recorded `precheck.observed` verdict per ticket, read-only from the
 * governance journal. Events are scanned in file (chronological) order, so the
 * last write for a ticket wins — matching the CLI's "latest recorded verdict"
 * semantics. Tickets with no recorded precheck are simply absent from the map
 * (callers must treat absence as "not recorded", NEVER as a skip).
 */
export function latestPrecheckObservedPerTicket(): Map<string, RecordedPrecheck> {
  const all = loadAllEvents();
  const map = new Map<string, RecordedPrecheck>();
  for (const e of all) {
    const details = e.details as PrecheckObservedDetails | undefined;
    if (!details || details.event_type !== 'precheck.observed') continue;
    const pc = details.precheck;
    if (!pc) continue;
    const ticket = String(pc.ticket ?? e.ticket ?? '');
    if (!ticket || typeof pc.verdict !== 'string') continue;
    map.set(ticket, {
      ticket,
      verdict: pc.verdict,
      probeCount: Number(pc.probe_count ?? 0),
      recordedAt: String(e.ts ?? '')
    });
  }
  return map;
}
