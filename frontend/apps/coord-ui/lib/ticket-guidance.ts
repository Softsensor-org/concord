import 'server-only';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

/**
 * COORD-106 — SINGLE SOURCE OF TRUTH for operator "what to run next" / closeout
 * commands surfaced by the coord-ui.
 *
 * The /ticket explain panel and /dispatch view used to RE-DERIVE governed
 * command strings in TypeScript (e.g. always advising `gov finalize <id> --pr`
 * for review/landing regardless of repo type). That is advisory drift: the
 * canonical closeout routing — open review_findings → repair; empty pr_index →
 * set-pr; no-PR evidence → finalize --no-pr; repo-X with PR → finalize --pr;
 * repo-BACKED with PR → `gov land` — lives ONLY in
 * coord/scripts/ticket-guidance.js `buildTicketNextCommands` (the canonical
 * planner, tested in ticket-guidance.test.js). A re-derivation in the UI can
 * (and did) advise an operator to close a ticket the WRONG way.
 *
 * Drift-proof fix: the UI RENDERS the output of the canonical
 * buildTicketNextCommands instead of re-deriving it. We instantiate the real
 * coord function in-process via createRequire (the same pattern dispatch.ts /
 * quality.ts use for CJS coord modules) and call its PURE, board-reading,
 * spawn-free function with the board/row/lock/blocker state the UI already
 * reads. NO child process is spawned, NO write/gate/mutation occurs — the
 * function only READS the arguments handed to it and returns guidance strings.
 *
 * We reach the function through the stable `governance.js` `__testing` facade,
 * which is exactly how the canonical contract is exercised in
 * ticket-guidance.test.js (`require("./governance.js").__testing
 * .buildTicketNextCommands`), so the UI and the test suite share one source.
 */

/** The (uppercase-column) board row shape buildTicketNextCommands reads. */
export interface CanonicalBoardRow {
  ID: string;
  Status: string;
  Repo?: string;
  Type?: string;
  Pri?: string;
  [k: string]: unknown;
}

/** Minimal board projection buildTicketNextCommands reads (findings + PRs). */
export interface CanonicalBoard {
  sections?: unknown[];
  review_findings?: Record<string, Array<{ status?: string; [k: string]: unknown }>>;
  pr_index?: Record<string, unknown[]>;
}

export interface CanonicalLock {
  ticket?: string;
  owner?: string;
  worktree?: string;
  [k: string]: unknown;
}

export interface NextCommandsArgs {
  board: CanonicalBoard;
  row: CanonicalBoardRow;
  ticketId: string;
  lock: CanonicalLock | null;
  /** governance provenance-drift paths (blocking drift → leading `gov doctor`). */
  provenanceDrift?: string[];
  /** start-readiness blockers (todo/deferred), each carrying next_steps[]. */
  startBlockers?: Array<{ next_steps?: string[]; [k: string]: unknown }>;
  /** submit-readiness blockers (doing), each carrying next_steps[]. */
  submitBlockers?: Array<{ next_steps?: string[]; [k: string]: unknown }>;
}

type BuildTicketNextCommands = (args: NextCommandsArgs) => string[];

interface GovernanceModule {
  __testing?: { buildTicketNextCommands?: BuildTicketNextCommands };
}

let cached: BuildTicketNextCommands | null = null;

function loadBuildTicketNextCommands(): BuildTicketNextCommands {
  if (cached) return cached;
  const gov = requireExternal<GovernanceModule>(
    path.join(COORD_DIR, 'scripts', 'governance.js')
  );
  const fn = gov.__testing?.buildTicketNextCommands;
  if (typeof fn !== 'function') {
    throw new Error('governance.js __testing.buildTicketNextCommands is unavailable');
  }
  cached = fn;
  return fn;
}

/**
 * Render the CANONICAL governed next/closeout commands for a ticket. Thin
 * pass-through to coord/scripts/ticket-guidance.js buildTicketNextCommands so
 * the UI can never drift from the CLI/governance routing. Display-only.
 */
export function canonicalNextCommands(args: NextCommandsArgs): string[] {
  return loadBuildTicketNextCommands()({
    provenanceDrift: [],
    startBlockers: [],
    submitBlockers: [],
    ...args
  });
}
