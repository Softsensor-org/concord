import 'server-only';
import path from 'node:path';
import { COORD_DIR, BOARD_PATH, PLAN_RECORDS_DIR } from './coord-paths';
import { requireExternal } from './external-require';

// COORD-110 / COORD_UI_CONTRACT "/adrs" — READ-ONLY decision-record cockpit.
//
// Reuses the canonical ADR cockpit model builder from the gov engine
// (coord/scripts/adr-validator.js `buildAdrCockpitModel`) rather than a parallel
// copy, exactly like lib/live-mcp.ts reuses the live-MCP lifecycle engine. The
// builder reads coord/docs/decisions/*.md plus the board + plan records to
// surface decision coverage, status mix, supersession, revisit triggers, and the
// non-terminal decision-required tickets that are missing an accepted ADR.

export interface AdrEntry {
  id: string;
  numeric_id: string;
  title: string;
  status: string;
  file: string;
  path: string;
  affected_repos: string[];
  affected_modules: string[];
  linked_tickets: string[];
  linked_requirements: string[];
  supersedes: string[];
  superseded_by: string | null;
  revisit_trigger?: string | null;
  commands: { show: string; link_ticket: string; supersede: string };
}

export interface AdrSupersessionChain {
  ids: string[];
  current: string;
  history: string[];
}

export interface AdrRevisitTrigger {
  id: string;
  title: string;
  trigger: string;
}

export interface MissingAdrTicket {
  ticket?: string;
  id?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface AdrCockpitModel {
  found: boolean;
  mode: string;
  summary: {
    adrs: number;
    accepted: number;
    deferred: number;
    superseded: number;
    missing_adr_tickets: number;
    findings: number;
  };
  adrs: AdrEntry[];
  supersession_chains: AdrSupersessionChain[];
  revisit_triggers: AdrRevisitTrigger[];
  decision_required_missing_adrs: MissingAdrTicket[];
  commands: Record<string, string>;
}

type AdrValidator = {
  buildAdrCockpitModel: (opts: {
    rootDir: string;
    boardPath: string;
    plansDir: string;
    demo?: boolean;
  }) => Omit<AdrCockpitModel, 'found'>;
};

let cached: AdrValidator | null = null;
function engine(): AdrValidator {
  if (!cached) {
    cached = requireExternal<AdrValidator>(path.join(COORD_DIR, 'scripts', 'adr-validator.js'));
  }
  return cached;
}

const EMPTY: AdrCockpitModel = {
  found: false,
  mode: 'read-only',
  summary: { adrs: 0, accepted: 0, deferred: 0, superseded: 0, missing_adr_tickets: 0, findings: 0 },
  adrs: [],
  supersession_chains: [],
  revisit_triggers: [],
  decision_required_missing_adrs: [],
  commands: {
    create_adr: 'coord/scripts/gov adr new --title "Decision title" --ticket <ticket-id>'
  }
};

export function loadAdrs(): AdrCockpitModel {
  const decisionsDir = path.join(COORD_DIR, 'docs', 'decisions');
  try {
    const model = engine().buildAdrCockpitModel({
      rootDir: decisionsDir,
      boardPath: BOARD_PATH,
      plansDir: PLAN_RECORDS_DIR
    });
    return { found: true, ...model };
  } catch {
    // No decisions dir / unreadable — degrade to an empty read-only model.
    return EMPTY;
  }
}
