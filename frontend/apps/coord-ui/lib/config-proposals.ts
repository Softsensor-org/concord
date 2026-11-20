import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { COORD_DIR, PROJECT_ROOT, RUNTIME_DIR } from './coord-paths';
import { proposalArgs, parseProposalResult, pendingProposals } from './config-proposals-core.js';

export const CONFIG_PROPOSAL_TARGETS = Object.freeze(['project.testPolicy']);

export interface ProposalResult {
  proposal_id: string;
  target: string;
  base_digest: string;
  diff: { target: string; before: unknown; after: unknown };
  refusal: null;
}

/**
 * Submit through the governed CLI so browser and CLI edits use the same
 * validation, journal event, diff and refusal text. This endpoint never writes
 * configuration itself; proposing appends only `config.proposed`.
 */
export function proposeConfig(target: string, value: unknown): ProposalResult {
  if (!CONFIG_PROPOSAL_TARGETS.includes(target)) {
    throw new Error(`config proposal target refused: ${target}; allowed: ${CONFIG_PROPOSAL_TARGETS.join(', ')}`);
  }
  const configPath = process.env.COORD_PROJECT_CONFIG
    ? path.resolve(process.env.COORD_PROJECT_CONFIG)
    : path.join(COORD_DIR, 'project.config.js');
  const source = fs.readFileSync(configPath);
  const baseDigest = createHash('sha256').update(source).digest('hex');
  const script = path.join(COORD_DIR, 'scripts', 'governance.js');
  const args = [script, ...proposalArgs({ target, value, baseDigest })];
  const child = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 128 * 1024,
  });
  if (child.error) throw new Error(`config propose could not run: ${child.error.message}`);
  if (child.status !== 0) {
    const refusal = (child.stderr || child.stdout || `config propose exited ${child.status}`).trim();
    throw new Error(refusal);
  }
  return parseProposalResult(child.stdout) as ProposalResult;
}

export interface PendingProposal {
  proposal_id: string; target: string; base_digest: string; result_digest: string;
  proposer: string | null; created_at: string; diff: unknown;
}

/** Read pending status from the append-only journal; this path never mutates it. */
export function loadPendingConfigProposals(): PendingProposal[] {
  const journal = path.join(RUNTIME_DIR, 'governance-events.ndjson');
  let text: string;
  try { text = fs.readFileSync(journal, 'utf8'); } catch { return []; }
  const events = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  return pendingProposals(events as Array<Record<string, unknown>>) as PendingProposal[];
}
