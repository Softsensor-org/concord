import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { productRepos, type RepoModel } from './project-config';
import { loadGates } from './gates';
import type { GateStep } from './gates';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.worktrees']);
const TEST_RE = /\.test\.(tsx?|mjs|jsx?)$/;

export interface RepoTestInventory {
  repo: string;
  exists: boolean;
  totalTestFiles: number;
  byExt: Record<string, number>;
}

export interface RepoLaneStatus {
  repo: string;
  lane: string;
  found: boolean;
  status?: string;
  steps: GateStep[];
}

export interface MaturityView {
  found: boolean;
  raw?: string;
  notRun: boolean;
}

export interface TestsSummary {
  inventory: RepoTestInventory[];
  laneStatuses: RepoLaneStatus[];
  maturity: MaturityView;
  totalTestFiles: number;
  failingLaneSteps: number;
}

function walkCount(dir: string, acc: { total: number; byExt: Record<string, number> }) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkCount(path.join(dir, e.name), acc);
    } else if (TEST_RE.test(e.name)) {
      acc.total += 1;
      const m = TEST_RE.exec(e.name);
      const ext = m ? `.test.${m[1]}` : 'other';
      acc.byExt[ext] = (acc.byExt[ext] ?? 0) + 1;
    }
  }
}

function inventoryFor(repo: RepoModel): RepoTestInventory {
  const name = repo.name;
  if (!fs.existsSync(repo.dir)) {
    return { repo: name, exists: false, totalTestFiles: 0, byExt: {} };
  }
  const acc = { total: 0, byExt: {} as Record<string, number> };
  walkCount(repo.dir, acc);
  return { repo: name, exists: true, totalTestFiles: acc.total, byExt: acc.byExt };
}

function loadMaturity(): MaturityView {
  const p = path.join(COORD_DIR, 'TEST_MATURITY.md');
  if (!fs.existsSync(p)) return { found: false, notRun: true };
  const raw = fs.readFileSync(p, 'utf8');
  const notRun = /not yet run|Overall:\s*—\/100/i.test(raw);
  return { found: true, raw, notRun };
}

export function loadTests(): TestsSummary {
  const inventory = productRepos().map(inventoryFor);
  const gates = loadGates();

  // Lane status comes from the default/full gate artifacts' test steps.
  const laneStatuses: RepoLaneStatus[] = gates.results
    .filter((g) => g.lane === 'default' || g.lane === 'full')
    .map((g) => ({
      repo: g.repo,
      lane: g.lane,
      found: g.found,
      status: g.status,
      steps: g.steps
    }));

  const failingLaneSteps = laneStatuses.reduce(
    (n, l) => n + l.steps.filter((s) => s.status && s.status !== 'pass').length,
    0
  );

  return {
    inventory,
    laneStatuses,
    maturity: loadMaturity(),
    totalTestFiles: inventory.reduce((n, i) => n + i.totalTestFiles, 0),
    failingLaneSteps
  };
}
