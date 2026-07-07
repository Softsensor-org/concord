import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH, COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

/**
 * COORD-287 — /triage data surface.
 *
 * Server-only, strictly READ-ONLY (SEC-001/002). It reads the board exactly the
 * way the other board-projection libs do (findings.ts / quality.ts):
 * `fs.readFileSync(BOARD_PATH)` then parse — no `fs` writes, no `child_process`,
 * no governance mutation. The proposed-ticket projection itself is delegated to
 * the shared pure core `coord/scripts/triage-core.js` (loaded via the same
 * createRequire mechanism coord-paths.ts uses for the path-boundary core), so
 * the served view and the node:test gate cannot drift.
 *
 * Fail-closed: if the board cannot be read or parsed, this returns an empty
 * queue rather than crashing or writing anything. The view degrades to its
 * empty state; it NEVER mutates governance state.
 */

/** One proposed ticket projected for triage display (mirrors triage-core.js). */
export interface TriageItem {
  id: string;
  repo: string | null;
  type: string | null;
  priority: string | null;
  owner: string | null;
  dependsOn: string | null;
  title: string;
  /** the `[qkey:...]` dedup marker, or null for a hand-filed proposed ticket. */
  qkey: string | null;
  /** the parsed "Evidence:" finding line, or null. */
  finding: string | null;
  /** the parsed "Suggested fix:" framing, or null. */
  suggestedFix: string | null;
  /** the full (whitespace-tidied) description, for the reviewer. */
  description: string;
}

/** Plain-text governed CLI hints (display only — NEVER executed). */
export interface CliHint {
  approve: string;
  reject: string;
}

interface TriageCore {
  proposedTickets: (board: unknown) => TriageItem[];
  cliHint: (id: string) => CliHint;
}

function loadCore(): TriageCore {
  return requireExternal<TriageCore>(path.join(COORD_DIR, 'scripts', 'triage-core.js'));
}

function readBoard(): unknown {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch {
    // Fail closed: an unreadable board yields an empty triage queue, never a
    // crash and never a write.
    return { sections: [] };
  }
}

export interface TriageView {
  items: TriageItem[];
  total: number;
}

/** Load the read-only triage queue: every `proposed` ticket, projected. */
export function loadTriage(): TriageView {
  let core: TriageCore;
  try {
    core = loadCore();
  } catch {
    // COORD-432: degrade instead of 500 if the triage-core engine module is
    // missing/unloadable (a rename, or a release cut that strips it). Every other
    // engine-backed view degrades to an empty model; match that contract.
    return { items: [], total: 0 };
  }
  let items: TriageItem[] = [];
  try {
    const projected = core.proposedTickets(readBoard());
    items = Array.isArray(projected) ? projected : [];
  } catch {
    items = [];
  }
  return { items, total: items.length };
}

/** Plain-text governed CLI hints for a proposed ticket. Display only. */
export function triageCliHint(id: string): CliHint {
  return loadCore().cliHint(id);
}
