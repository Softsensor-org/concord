import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { productRepos, type RepoModel } from './project-config';

// COORD-075 (QGATE-001): canonical gate-lane vocabulary. Must stay in sync with
// coord/scripts/governance-constants.js GATE_LANES (the single source of truth
// validated by gov gate --lane and implemented by the template scripts/gate.sh
// runners). `extended` was a documented-but-unimplemented phantom and is no
// longer an accepted lane; `ci` is the real transport lane.
const LANES = ['default', 'full', 'ci'] as const;

export interface GateStep {
  name: string;
  status: string;
  duration_ms?: number;
}

export interface GateResult {
  repo: string;
  lane: string;
  found: boolean;
  status?: string;
  source?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  budgetTargetMs?: number | null;
  budgetStatus?: string;
  branch?: string;
  commit?: string;
  worktreeClean?: boolean;
  authorityStatus?: string;
  authorityReason?: string;
  steps: GateStep[];
  ageHours?: number;
}

export interface GatesSummary {
  results: GateResult[];
  passing: number;
  failing: number;
  missing: number;
  nonAuthoritative: number;
}

function readGate(repo: RepoModel, lane: string): GateResult {
  const repoName = repo.name;
  const file = path.join(repo.dir, 'artifacts', 'gates', `${lane}.latest.json`);
  if (!fs.existsSync(file)) {
    return { repo: repoName, lane, found: false, steps: [] };
  }
  try {
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ended = g.ended_at ? new Date(g.ended_at).getTime() : 0;
    return {
      repo: repoName,
      lane,
      found: true,
      status: g.status,
      source: g.source,
      startedAt: g.started_at,
      endedAt: g.ended_at,
      durationMs: g.duration_ms,
      budgetTargetMs: g.budget?.target_ms ?? null,
      budgetStatus: g.budget?.status,
      branch: g.git?.branch,
      commit: typeof g.git?.commit === 'string' ? g.git.commit.slice(0, 9) : undefined,
      worktreeClean: g.git?.worktree_clean,
      authorityStatus: g.authority?.status,
      authorityReason: g.authority?.reason,
      steps: Array.isArray(g.steps)
        ? g.steps.map((s: Record<string, unknown>) => ({
            name: String(s.name ?? ''),
            status: String(s.status ?? ''),
            duration_ms: typeof s.duration_ms === 'number' ? s.duration_ms : undefined
          }))
        : [],
      ageHours: ended ? Math.round(((Date.now() - ended) / 3_600_000) * 10) / 10 : undefined
    };
  } catch (err) {
    return {
      repo: repoName,
      lane,
      found: true,
      status: 'unreadable',
      steps: [],
      authorityReason: err instanceof Error ? err.message : String(err)
    };
  }
}

export function loadGates(): GatesSummary {
  const results: GateResult[] = [];
  for (const repo of productRepos()) for (const lane of LANES) results.push(readGate(repo, lane));
  return {
    results,
    passing: results.filter((r) => r.status === 'pass').length,
    failing: results.filter((r) => r.found && r.status && r.status !== 'pass').length,
    missing: results.filter((r) => !r.found).length,
    nonAuthoritative: results.filter(
      (r) => r.found && r.authorityStatus && r.authorityStatus !== 'authoritative'
    ).length
  };
}
