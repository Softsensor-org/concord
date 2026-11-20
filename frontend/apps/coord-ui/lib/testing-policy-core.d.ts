export type TestingPolicyIo = {
  exists(file: string): boolean;
  readText(file: string): string;
  listDir(dir: string): string[];
};
export type TestingPolicyPaths = {
  policyFile: string;
  boardFile: string;
  decisionsFile: string;
  lastQualifiedFile: string;
  runDir: string;
  join(...parts: string[]): string;
};
export type KeyValue = { key: string; value: string };
export type TestingStageView = {
  name: string;
  purpose: string;
  coverage: string;
  fullOn: string[];
  checks: { scope: string; checks: string[] }[];
  details: { key: string; value: string }[];
};
export type TestingExceptionRow = {
  id: string;
  ticket: string;
  kind: string;
  stage: string;
  items: string[];
  reason: string;
  approver: string | null;
  authorityKind: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  withdrawn: boolean;
  withdrawnAt: string | null;
  lapse: string;
  state: string;
};
export type ScheduleDecisionRow = { decision: string; reason: string; recordedAt: string | null; head: string | null };
export type TestingPolicyView = {
  readOnly: true;
  policy: null | {
    policyVersion: string;
    schemaVersion: string;
    landingGates: string;
    pilot: string;
    selection: KeyValue[];
    overrideKeys: string[];
  };
  warnings: string[];
  stages: TestingStageView[];
  stageAliases: { alias: string; stage: string }[];
  checks: { id: string; kind: string; source: string; description: string }[];
  exceptions: TestingExceptionRow[];
  runtime: {
    decisions: { total: number; unreadable: number; tail: ScheduleDecisionRow[] };
    lastQualified: KeyValue[] | null;
    lastQualifiedUnreadable: boolean;
    promotions: { run: string; stage: string; result: string }[];
  };
  settings: unknown[];
  governedChangeNote: string;
};
export type ResolvedView = {
  kind: 'ticket' | 'branch';
  ref: string;
  repo: string | null;
  status: string | null;
  rowFound: boolean;
  stages: { name: string; purpose: string; checks: { scope: string; checks: string[] }[]; fullOn: string[] }[];
  exceptions: TestingExceptionRow[];
  commands: { stage: string; command: string }[];
  note: string;
};
export const READ_IO_METHODS: readonly string[];
export const DECISION_TAIL: number;
export function isTicketRef(ref: unknown): boolean;
export function isBranchRef(ref: unknown): boolean;
export function assertReadOnlyIo(io: unknown): void;
export function loadTestingPolicyView(args: {
  io: TestingPolicyIo;
  paths: TestingPolicyPaths;
  override?: unknown;
  overrideError?: string | null;
  settings?: unknown[];
  governedChangeNote?: string;
}): TestingPolicyView;
export function buildResolvedView(args: {
  ref: string;
  rows?: { id: string; repo?: string | null; status?: string | null }[];
  boardJson?: unknown;
  policyView: TestingPolicyView | null;
}): ResolvedView | null;
