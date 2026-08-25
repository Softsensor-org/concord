import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { allRepos, type RepoModel } from './project-config';

export interface GitFileChange {
  code: string;
  file: string;
}

export interface GitRepoStatus {
  name: string;
  exists: boolean;
  /**
   * COORD-543 — 'ok' | 'unavailable' | 'out-of-scope'. Anything but 'ok' means
   * this repo's working tree was NOT inspected. It must never be counted as
   * clean: a governance dashboard reporting "clean" about a repo it is not
   * looking at is the defect this field exists to prevent.
   */
  status: RepoModel['status'];
  statusReason: string | null;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  changes: GitFileChange[];
  worktrees: string[];
  error?: string;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function parseAheadBehind(repoDir: string): { ahead?: number; behind?: number } {
  try {
    const out = git(repoDir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const [a, b] = out.split(/\s+/).map((n) => parseInt(n, 10));
    return { ahead: Number.isFinite(a) ? a : undefined, behind: Number.isFinite(b) ? b : undefined };
  } catch {
    return {};
  }
}

function listWorktrees(repoDir: string): string[] {
  try {
    const out = git(repoDir, ['worktree', 'list', '--porcelain']);
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.replace('worktree ', ''))
      .filter((p) => path.resolve(p) !== path.resolve(repoDir));
  } catch {
    return [];
  }
}

function statusForRepo(repo: RepoModel): GitRepoStatus {
  const { name, dir: repoDir } = repo;
  // COORD-543 — an unresolved repo is REPORTED, never inspected via a
  // substituted tree. Before this fix a sibling-layout repo was clamped to the
  // engine root, so the git view inspected the engine once per product repo and
  // rendered "working tree clean" for repos it had never looked at.
  if (repo.status !== 'ok' || !repoDir) {
    return {
      name,
      exists: false,
      status: repo.status,
      statusReason: repo.statusReason,
      changes: [],
      worktrees: []
    };
  }
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return {
      name,
      exists: false,
      status: 'unavailable',
      statusReason: `${repo.path} is not a git repository (no .git found).`,
      changes: [],
      worktrees: []
    };
  }
  try {
    const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(repoDir, ['rev-parse', '--short', 'HEAD']);
    const porcelain = git(repoDir, ['status', '--porcelain']);
    const changes: GitFileChange[] = porcelain
      ? porcelain.split('\n').map((line) => ({
          code: line.slice(0, 2).trim() || '??',
          file: line.slice(3)
        }))
      : [];
    const { ahead, behind } = parseAheadBehind(repoDir);
    return {
      name,
      exists: true,
      status: 'ok',
      statusReason: null,
      branch,
      head,
      ahead,
      behind,
      changes,
      worktrees: listWorktrees(repoDir)
    };
  } catch (err) {
    return {
      name,
      exists: true,
      status: 'ok',
      statusReason: null,
      changes: [],
      worktrees: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function loadGitStatus(): GitRepoStatus[] {
  return allRepos().map(statusForRepo);
}

export interface GitStatusSummary {
  repos: GitRepoStatus[];
  /** Repos whose working tree was actually read. */
  inspected: number;
  /** Repos that could not be resolved and were NOT inspected (COORD-543). */
  unresolved: number;
  /** Dirty repos, counted only among the inspected ones. */
  dirty: number;
}

/**
 * COORD-543 — the dirty-repo denominator must be the number of repos actually
 * INSPECTED, and unresolved repos must be surfaced separately. "0 dirty / 3"
 * while inspecting the engine three times is precisely the failure this ticket
 * exists to remove.
 */
export function summarizeGitStatus(repos: GitRepoStatus[] = loadGitStatus()): GitStatusSummary {
  const inspected = repos.filter((r) => r.exists);
  return {
    repos,
    inspected: inspected.length,
    unresolved: repos.filter((r) => r.status !== 'ok').length,
    dirty: inspected.filter((r) => r.changes.length > 0).length
  };
}
