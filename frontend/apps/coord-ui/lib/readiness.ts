import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH, COORD_DIR, PROJECT_ROOT, READINESS_REPORT_PATH } from './coord-paths';

type FindingSeverity = 'blocker' | 'warning' | 'info' | string;

export interface ReadinessFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  evidence: string[];
  suggested_ticket: string | null;
}

export interface SetupDecisionsView {
  present: boolean;
  valid: boolean;
  path: string;
  profile: string;
  phase: string;
  tracks: string[];
  gates: string[];
}

export interface SuggestedTicketView {
  id: string;
  status: string;
  open: boolean;
}

export interface ReadinessView {
  found: boolean;
  readOnly: true;
  sourcePath: string;
  generatedCommand: string;
  enterpriseReadyClaim: false;
  recommendedProfile: string;
  recommendedPhase: string;
  defaultLane: string;
  detectedShape: string;
  detectedSignals: string[];
  packageManagers: string[];
  testCommands: string[];
  buildCommands: string[];
  setupDecisions: SetupDecisionsView;
  coordSetup: Record<string, boolean>;
  missingGovernanceArtifacts: string[];
  shimDrift: string[];
  requirementGaps: string[];
  testGateMaturity: string[];
  findings: ReadinessFinding[];
  suggestedTickets: SuggestedTicketView[];
  pilotBlockers: string[];
  enterpriseBlockers: string[];
  note: string;
}

interface RawReadinessReport {
  kind?: string;
  recommended_profile?: string;
  recommended_profile_details?: {
    default_lane?: string;
  } | null;
  recommended_phase?: string;
  package_managers?: string[];
  app_signals?: string[];
  commands?: {
    test?: Array<{ command?: string }>;
    build?: Array<{ command?: string }>;
  };
  coord_setup?: Record<string, boolean>;
  setup_decisions?: {
    path?: string;
    present?: boolean;
    valid?: boolean;
    decisions?: {
      adoption_profile?: { id?: string };
      governance_phase?: { id?: string };
      tracks?: string[];
      gates?: string[];
    } | null;
    detected_shape?: {
      shape?: string;
      signals?: string[];
    } | null;
  };
  findings?: ReadinessFinding[];
  suggested_tickets?: string[];
  pilot_blockers?: string[];
  enterprise_blockers?: string[];
}

interface BoardTicket {
  ID?: string;
  Status?: string;
}

function relToProject(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function flattenBoardTickets(raw: unknown): BoardTicket[] {
  if (!raw || typeof raw !== 'object') return [];
  const board = raw as { sections?: Array<{ tickets?: BoardTicket[] }>; tickets?: BoardTicket[] };
  if (Array.isArray(board.tickets)) return board.tickets;
  if (!Array.isArray(board.sections)) return [];
  return board.sections.flatMap((section) => Array.isArray(section.tickets) ? section.tickets : []);
}

function ticketStatuses(): Map<string, string> {
  const raw = readJson<unknown>(BOARD_PATH);
  const map = new Map<string, string>();
  for (const ticket of flattenBoardTickets(raw)) {
    if (ticket.ID) map.set(ticket.ID, ticket.Status ?? 'unknown');
  }
  return map;
}

function findingCodes(report: RawReadinessReport, pattern: RegExp): string[] {
  return (report.findings ?? [])
    .filter((finding) => pattern.test(finding.code))
    .map((finding) => finding.code)
    .sort();
}

function buildFromReport(report: RawReadinessReport): ReadinessView {
  const setup = report.setup_decisions;
  const setupDecisions = setup?.decisions;
  const statuses = ticketStatuses();
  const suggestedTickets = (report.suggested_tickets ?? []).map((id) => {
    const status = statuses.get(id) ?? 'not-on-board';
    return { id, status, open: !['done', 'superseded', 'closed'].includes(status) };
  });
  const detectedShape =
    setup?.detected_shape?.shape ??
    ((report.app_signals ?? []).length > 0 ? 'detected-signals' : 'unknown');
  const detectedSignals = Array.from(new Set([
    ...(report.app_signals ?? []),
    ...(setup?.detected_shape?.signals ?? []),
  ])).sort();

  return {
    found: true,
    readOnly: true,
    sourcePath: relToProject(READINESS_REPORT_PATH),
    generatedCommand:
      'coord/scripts/coord doctor --dir . --json --output coord/.runtime/readiness-report.json',
    enterpriseReadyClaim: false,
    recommendedProfile: report.recommended_profile ?? 'unknown',
    recommendedPhase: report.recommended_phase ?? 'unknown',
    defaultLane: report.recommended_profile_details?.default_lane ?? 'unknown',
    detectedShape,
    detectedSignals,
    packageManagers: report.package_managers ?? [],
    testCommands: (report.commands?.test ?? []).map((cmd) => cmd.command ?? '').filter(Boolean),
    buildCommands: (report.commands?.build ?? []).map((cmd) => cmd.command ?? '').filter(Boolean),
    setupDecisions: {
      present: Boolean(setup?.present),
      valid: Boolean(setup?.valid),
      path: setup?.path ?? 'coord/setup.decisions.json',
      profile: setupDecisions?.adoption_profile?.id ?? 'unknown',
      phase: setupDecisions?.governance_phase?.id ?? 'unknown',
      tracks: setupDecisions?.tracks ?? [],
      gates: setupDecisions?.gates ?? [],
    },
    coordSetup: report.coord_setup ?? {},
    missingGovernanceArtifacts: Object.entries(report.coord_setup ?? {})
      .filter(([, present]) => !present)
      .map(([name]) => name)
      .sort(),
    shimDrift: findingCodes(report, /shim/i),
    requirementGaps: findingCodes(report, /requirement|project-config|setup-decisions/i),
    testGateMaturity: [
      ...findingCodes(report, /test|gate|github-actions/i),
      ...((report.commands?.test ?? []).length > 0 ? ['test-command-present'] : []),
      ...((report.commands?.build ?? []).length > 0 ? ['build-command-present'] : []),
    ].sort(),
    findings: report.findings ?? [],
    suggestedTickets,
    pilotBlockers: report.pilot_blockers ?? [],
    enterpriseBlockers: report.enterprise_blockers ?? [],
    note:
      'Read-only readiness mirror. This route displays generated readiness evidence; it does not claim enterprise readiness or run scanner/repair commands.',
  };
}

function emptyReadinessView(detectedShape: string, note: string): ReadinessView {
  const generatedCommand =
    'coord/scripts/coord doctor --dir . --json --output coord/.runtime/readiness-report.json';
  return {
    found: false,
    readOnly: true,
    sourcePath: relToProject(READINESS_REPORT_PATH),
    generatedCommand,
    enterpriseReadyClaim: false,
    recommendedProfile: 'unknown',
    recommendedPhase: 'unknown',
    defaultLane: 'unknown',
    detectedShape,
    detectedSignals: [],
    packageManagers: [],
    testCommands: [],
    buildCommands: [],
    setupDecisions: {
      present: false,
      valid: false,
      path: 'coord/setup.decisions.json',
      profile: 'unknown',
      phase: 'unknown',
      tracks: [],
      gates: [],
    },
    coordSetup: {},
    missingGovernanceArtifacts: [],
    shimDrift: [],
    requirementGaps: [],
    testGateMaturity: [],
    findings: [],
    suggestedTickets: [],
    pilotBlockers: [],
    enterpriseBlockers: [],
    note,
  };
}

export function loadReadinessView(): ReadinessView {
  const generatedCommand =
    'coord/scripts/coord doctor --dir . --json --output coord/.runtime/readiness-report.json';
  if (!fs.existsSync(READINESS_REPORT_PATH)) {
    return emptyReadinessView(
      'artifact-missing',
      `Read-only readiness artifact missing. Generate it outside the UI with ${generatedCommand}; the web tier will not write ${COORD_DIR}.`
    );
  }

  const report = readJson<RawReadinessReport>(READINESS_REPORT_PATH);
  if (!report || report.kind !== 'coord-readiness-report') {
    return emptyReadinessView(
      'artifact-invalid',
      `Readiness artifact exists at ${relToProject(READINESS_REPORT_PATH)} but is not a coord-readiness-report. Regenerate it with ${generatedCommand}.`
    );
  }
  return buildFromReport(report);
}
