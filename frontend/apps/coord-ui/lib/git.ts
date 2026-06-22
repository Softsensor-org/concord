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
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return { name, exists: false, changes: [], worktrees: [] };
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
      changes: [],
      worktrees: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function loadGitStatus(): GitRepoStatus[] {
  return allRepos().map(statusForRepo);
}
