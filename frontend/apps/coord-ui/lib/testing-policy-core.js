// COORD-939: READ-ONLY data core for the coord-ui testing-policy views.
//
// Pure and filesystem-free: every file read goes through an `io` object that
// offers exactly three read methods (exists, readText, listDir). The Next data
// layer (testing-policy-view.ts) supplies the real fs read methods; the node:test
// suite supplies a fake io whose every other member throws, so a write path is
// not reachable from this module by construction.
//
// Nothing here writes, spawns, fetches or mutates. Changing policy, configuration
// or exceptions is a governed command the view only renders (gov test-policy ...,
// gov test-policy except ..., config-as-code commit). The diff-dependent part of
// "what would run and why" is produced by `gov test-policy resolve`, not here.

export const READ_IO_METHODS = Object.freeze(['exists', 'readText', 'listDir']);
export const POLICY_FILE_NAME = 'test-policy.json';
export const DECISIONS_FILE_NAME = 'schedule-decisions.ndjson';
export const LAST_QUALIFIED_FILE_NAME = 'last-qualified.json';
export const REPORT_FILE_NAME = 'test-policy-report.json';
export const EXCEPTIONS_KEY = 'test_policy_exceptions';
export const DECISION_TAIL = 20;
export const TICKET_REF = /^[A-Z][A-Z0-9]{0,15}-\d{1,6}$/;
export const STAGE_NAMES = Object.freeze(['developer', 'pr', 'nightly', 'promotion']);

const BRANCH_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export function isTicketRef(ref) {
  return typeof ref === 'string' && TICKET_REF.test(ref);
}

// A branch reference is only ever echoed into a displayed command; it is never
// used to build a path or passed to git from the web tier.
export function isBranchRef(ref) {
  return typeof ref === 'string' && BRANCH_REF.test(ref) && !ref.includes('..');
}

export function assertReadOnlyIo(io) {
  if (!io || typeof io !== 'object') throw new Error('testing-policy-view: io is required');
  for (const name of READ_IO_METHODS) {
    if (typeof io[name] !== 'function') throw new Error(`testing-policy-view: io.${name} must be a read method`);
  }
}

function readJson(io, file) {
  if (!io.exists(file)) return null;
  try {
    return JSON.parse(io.readText(file));
  } catch {
    return { __unreadable: true };
  }
}

function scalarPairs(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => ({ key: k, value: String(v) }));
}

function summarizeValue(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function stageView(name, stage) {
  const checks = Object.entries(stage.checks || {}).map(([scope, list]) => ({
    scope,
    checks: Array.isArray(list) ? list : []
  }));
  const details = Object.entries(stage)
    .filter(([k]) => !['purpose', 'checks', 'full_on', 'coverage'].includes(k))
    .map(([k, v]) => ({ key: k, value: summarizeValue(v) }));
  return {
    name,
    purpose: String(stage.purpose || ''),
    coverage: String(stage.coverage || 'unspecified'),
    fullOn: Array.isArray(stage.full_on) ? stage.full_on.map(String) : [],
    checks,
    details
  };
}

function exceptionRows(boardJson, state) {
  const all = (boardJson && boardJson.metadata && boardJson.metadata[EXCEPTIONS_KEY]) || {};
  const rows = [];
  for (const [ticket, list] of Object.entries(all)) {
    for (const e of Array.isArray(list) ? list : []) {
      const withdrawn = Boolean(e && e.withdrawn_at);
      rows.push({
        id: String(e.id || ''),
        ticket,
        kind: String(e.kind || 'unknown'),
        stage: String(e.stage || 'unknown'),
        items: Array.isArray(e.items) ? e.items.map(String) : [],
        reason: String(e.reason || ''),
        approver: e.authority && e.authority.approver ? String(e.authority.approver) : null,
        authorityKind: e.authority && e.authority.kind ? String(e.authority.kind) : null,
        recordedBy: e.authority && e.authority.recorded_by ? String(e.authority.recorded_by) : null,
        recordedAt: e.recorded_at ? String(e.recorded_at) : null,
        withdrawn,
        withdrawnAt: withdrawn ? String(e.withdrawn_at) : null,
        // Lapse depends on the current diff; only the governed resolver can decide it.
        lapse: withdrawn ? 'withdrawn' : 'computed by gov test-policy resolve for the current diff',
        state
      });
    }
  }
  rows.sort((a, b) => (a.ticket + a.id).localeCompare(b.ticket + b.id));
  return rows;
}

function parseDecisions(text) {
  const entries = [];
  let total = 0;
  let unreadable = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unreadable += 1;
    }
  }
  return { total, unreadable, tail: entries.slice(-DECISION_TAIL).map(decisionRow) };
}

function decisionRow(d) {
  return {
    decision: String(d.decision || 'unknown'),
    reason: String(d.reason || ''),
    recordedAt: d.recorded_at || d.at || d.now || null,
    head: d.head ? String(d.head) : null
  };
}

function readRuntime(io, paths) {
  const decisionsText = io.exists(paths.decisionsFile) ? io.readText(paths.decisionsFile) : '';
  const lastQualified = readJson(io, paths.lastQualifiedFile);
  const promotions = [];
  if (io.exists(paths.runDir)) {
    const names = [...io.listDir(paths.runDir)].sort();
    for (const name of names) {
      const reportFile = paths.join(paths.runDir, name, REPORT_FILE_NAME);
      const report = readJson(io, reportFile);
      if (!report || report.__unreadable) continue;
      const outcome = report.metrics && report.metrics.promotion_outcome;
      if (outcome) promotions.push({ run: name, stage: String(outcome.stage || ''), result: String(outcome.result || 'unknown') });
    }
  }
  return {
    decisions: parseDecisions(decisionsText),
    lastQualified: lastQualified && !lastQualified.__unreadable ? scalarPairs(lastQualified) : null,
    lastQualifiedUnreadable: Boolean(lastQualified && lastQualified.__unreadable),
    promotions: promotions.slice(-DECISION_TAIL)
  };
}

// Full read view: the versioned policy, its override state, exceptions, the
// scheduled-run and promotion records, and the adopter configuration rows the
// caller supplies (from the existing Configuration data layer).
export function loadTestingPolicyView({ io, paths, override = null, overrideError = null, settings = [], governedChangeNote = '' }) {
  assertReadOnlyIo(io);
  const policy = readJson(io, paths.policyFile);
  const board = readJson(io, paths.boardFile);
  const runtime = readRuntime(io, paths);
  const policyPresent = Boolean(policy) && !policy.__unreadable;
  const stageNames = policyPresent ? Object.keys(policy.stages || {}) : [];
  const stages = STAGE_NAMES.filter((n) => stageNames.includes(n)).map((n) => stageView(n, policy.stages[n]))
    .concat(stageNames.filter((n) => !STAGE_NAMES.includes(n)).map((n) => stageView(n, policy.stages[n])));
  const checks = policyPresent
    ? Object.entries(policy.checks || {}).map(([id, c]) => ({
        id,
        kind: String((c && c.kind) || ''),
        source: String((c && c.source) || ''),
        description: String((c && c.description) || '')
      }))
    : [];
  const aliases = policyPresent
    ? Object.entries(policy.stage_aliases || {}).map(([alias, stage]) => ({ alias, stage: String(stage) }))
    : [];
  const warnings = [];
  if (!policyPresent) warnings.push('engine policy file is missing or unreadable');
  if (override && override.__error) warnings.push(`adopter override refused: ${override.__error}`);
  if (overrideError) warnings.push(`adopter override refused: ${overrideError}`);
  const exceptions = exceptionRows(board && !board.__unreadable ? board : { metadata: {} }, 'recorded');
  return {
    readOnly: true,
    policy: policyPresent
      ? {
          policyVersion: String(policy.policy_version ?? 'unknown'),
          schemaVersion: String(policy.schema_version ?? 'unknown'),
          landingGates: String((policy.operating_mode && policy.operating_mode.landing_gates) || 'unknown'),
          pilot: String((policy.operating_mode && policy.operating_mode.pilot) || 'unknown'),
          selection: scalarPairs(policy.selection).concat(
            Array.isArray(policy.selection && policy.selection.always_required_suites)
              ? [{ key: 'always_required_suites', value: String(policy.selection.always_required_suites.length) }]
              : []
          ),
          overrideKeys: override && !override.__error ? Object.keys(override).sort() : []
        }
      : null,
    warnings,
    stages,
    stageAliases: aliases,
    checks,
    exceptions,
    runtime,
    settings: Array.isArray(settings) ? settings : [],
    governedChangeNote: String(governedChangeNote || '')
  };
}

// Resolved-policy view for a ticket or branch: which stages exist, the checks each
// stage names, the ticket's recorded exceptions and repo. What the diff selects is
// shown as the governed command that computes it; this module never runs git.
export function buildResolvedView({ ref, rows = [], boardJson = null, policyView }) {
  const kind = isTicketRef(ref) ? 'ticket' : isBranchRef(ref) ? 'branch' : null;
  if (!kind) return null;
  const row = kind === 'ticket' ? rows.find((r) => r && r.id === ref) || null : null;
  const exceptions = kind === 'ticket'
    ? exceptionRows(boardJson && !boardJson.__unreadable ? boardJson : { metadata: {} }, 'recorded').filter((e) => e.ticket === ref)
    : [];
  const target = kind === 'ticket' ? ['--ticket', ref] : ['--head', ref];
  const commands = STAGE_NAMES.map((stage) => ({
    stage,
    command: ['coord/scripts/gov', 'test-policy', 'resolve', '--stage', stage, '--base', 'origin/dev', ...target].join(' ')
  }));
  return {
    kind,
    ref,
    repo: row && row.repo ? String(row.repo) : null,
    status: row && row.status ? String(row.status) : null,
    rowFound: Boolean(row),
    stages: policyView ? policyView.stages.map((s) => ({ name: s.name, purpose: s.purpose, checks: s.checks, fullOn: s.fullOn })) : [],
    exceptions,
    commands,
    note: 'Which checks this change selects depends on its diff. The governed resolver computes it; the web tier does not run git.'
  };
}
