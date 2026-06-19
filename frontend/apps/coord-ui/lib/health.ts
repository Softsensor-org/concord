import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { LOCKS_DIR, RUNTIME_DIR, COORD_DIR } from './coord-paths';
import { loadGates } from './gates';

const STALLED_MS = 24 * 60 * 60 * 1000;

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface HealthReport {
  overall: CheckLevel;
  checks: HealthCheck[];
}

function lockChecks(): HealthCheck[] {
  if (!fs.existsSync(LOCKS_DIR)) {
    return [{ name: 'Locks', level: 'ok', detail: 'No locks directory — no active locks.' }];
  }
  const files = fs
    .readdirSync(LOCKS_DIR)
    .filter((f) => f.endsWith('.lock') || f.endsWith('.json'));
  if (files.length === 0) {
    return [{ name: 'Locks', level: 'ok', detail: 'No active locks.' }];
  }
  let stalled = 0;
  let malformed = 0;
  const now = Date.now();
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOCKS_DIR, f), 'utf8'));
      const started = raw.started_at ? new Date(raw.started_at).getTime() : 0;
      if (!raw.branch || raw.branch === 'main' || raw.branch === null) malformed++;
      if (started && now - started > STALLED_MS) stalled++;
    } catch {
      malformed++;
    }
  }
  const checks: HealthCheck[] = [
    {
      name: 'Active locks',
      level: 'ok',
      detail: `${files.length} active lock${files.length === 1 ? '' : 's'}.`
    }
  ];
  checks.push({
    name: 'Stalled locks (>24h)',
    level: stalled > 0 ? 'warn' : 'ok',
    detail: stalled > 0 ? `${stalled} lock(s) older than 24h.` : 'None.'
  });
  checks.push({
    name: 'Malformed locks',
    level: malformed > 0 ? 'fail' : 'ok',
    detail:
      malformed > 0
        ? `${malformed} lock(s) missing a canonical branch or unparseable.`
        : 'None.'
  });
  return checks;
}

function questionsCheck(): HealthCheck {
  const qp = path.join(COORD_DIR, 'QUESTIONS.md');
  if (!fs.existsSync(qp)) {
    return { name: 'QUESTIONS.md', level: 'ok', detail: 'Not present.' };
  }
  const stat = fs.statSync(qp);
  const text = fs.readFileSync(qp, 'utf8');
  const openMarkers = (text.match(/\b(OPEN|UNRESOLVED|PENDING)\b/g) || []).length;
  const ageH = Math.round((Date.now() - stat.mtimeMs) / 3_600_000);
  return {
    name: 'QUESTIONS.md drift log',
    level: openMarkers > 20 ? 'warn' : 'ok',
    detail: `${Math.round(stat.size / 1024)} KB · ~${openMarkers} open/unresolved markers · updated ${ageH}h ago (heuristic — open /timeline for authoritative drift)`
  };
}

function provenanceCheck(): HealthCheck {
  const snap = path.join(RUNTIME_DIR, 'governance-latest-snapshot.json');
  const log = path.join(RUNTIME_DIR, 'governance-events.ndjson');
  if (!fs.existsSync(log)) {
    return { name: 'Event log', level: 'fail', detail: 'governance-events.ndjson missing.' };
  }
  if (!fs.existsSync(snap)) {
    return {
      name: 'Snapshot pointer',
      level: 'warn',
      detail: 'governance-latest-snapshot.json missing — recover may be needed.'
    };
  }
  try {
    const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const ageH = s.ts ? Math.round((Date.now() - new Date(s.ts).getTime()) / 3_600_000) : null;
    return {
      name: 'Snapshot pointer',
      level: 'ok',
      detail: `latest command "${s.command ?? '?'}"${ageH != null ? ` · ${ageH}h ago` : ''}`
    };
  } catch {
    return { name: 'Snapshot pointer', level: 'fail', detail: 'Snapshot unreadable.' };
  }
}

function gateAuthorityCheck(): HealthCheck {
  const g = loadGates();
  if (g.missing === g.results.length) {
    return { name: 'Gate authority', level: 'warn', detail: 'No gate artifacts found.' };
  }
  if (g.failing > 0) {
    return {
      name: 'Gate authority',
      level: 'fail',
      detail: `${g.failing} gate lane(s) not passing.`
    };
  }
  if (g.nonAuthoritative > 0) {
    return {
      name: 'Gate authority',
      level: 'warn',
      detail: `${g.nonAuthoritative} gate(s) non-authoritative (dirty checkout).`
    };
  }
  return { name: 'Gate authority', level: 'ok', detail: `${g.passing} lane(s) passing.` };
}

export function loadHealth(): HealthReport {
  const checks: HealthCheck[] = [
    ...lockChecks(),
    provenanceCheck(),
    questionsCheck(),
    gateAuthorityCheck()
  ];
  const overall: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { overall, checks };
}
