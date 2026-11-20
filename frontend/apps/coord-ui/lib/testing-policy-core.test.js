// COORD-939: behavioural tests for the read-only testing-policy core.
// The core takes an io with three read methods only. Here the io is a fake
// whose every other member throws, so a write (or any extra fs/child-process
// capability) cannot be reached from the core: the test would throw.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READ_IO_METHODS,
  assertReadOnlyIo,
  buildResolvedView,
  isBranchRef,
  isTicketRef,
  loadTestingPolicyView
} from './testing-policy-core.js';

function fakeIo(files, dirs = {}) {
  const reads = [];
  const base = {
    exists: (f) => { reads.push(f); return Object.hasOwn(files, f) || Object.hasOwn(dirs, f); },
    readText: (f) => { if (!Object.hasOwn(files, f)) throw new Error(`no file ${f}`); return files[f]; },
    listDir: (d) => { if (!Object.hasOwn(dirs, d)) throw new Error(`no dir ${d}`); return dirs[d]; }
  };
  // Any member beyond the three read methods (writeFileSync, appendFileSync, mkdir, rm,
  // spawn, ...) throws if touched, so a write path cannot be reached silently.
  const io = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!Object.hasOwn(target, prop)) throw new Error(`write-class or unknown io member touched: ${String(prop)}`);
      return target[prop];
    },
    set() { throw new Error('io is read-only'); },
    defineProperty() { throw new Error('io is read-only'); },
    deleteProperty() { throw new Error('io is read-only'); }
  });
  return { io, reads };
}

const POLICY = {
  schema_version: 2,
  policy_version: 2,
  operating_mode: { pilot: 'runnable-now', landing_gates: 'active' },
  selection: { mode: 'enforce', always_required_suites: ['a.test.js', 'b.test.js'] },
  stage_aliases: { staging: 'promotion', release: 'promotion' },
  checks: {
    'selected-suites': { kind: 'engine-suites', source: 'selection', description: 'Suites the selection reaches.' }
  },
  stages: {
    developer: { purpose: 'Fast local feedback.', checks: { engine: ['selected-suites'] }, full_on: ['t2-change'], coverage: 'advisory' },
    promotion: { purpose: 'Full qualification.', checks: { engine: ['full-suite'] }, full_on: [], coverage: 'ratchet' }
  }
};

const BOARD = {
  metadata: {
    test_policy_exceptions: {
      'COORD-1': [
        { id: 'EX-1', ticket: 'COORD-1', kind: 'add', stage: 'pr', items: ['smoke'], reason: 'flaky area',
          authority: { kind: 'human-admin-override', approver: 'admin-x', recorded_by: 'claudea9' },
          recorded_at: '2026-11-01', withdrawn_at: null },
        { id: 'EX-2', ticket: 'COORD-1', kind: 'reduce', stage: 'pr', items: ['x'], reason: 'old',
          authority: { kind: 'human-admin-override', approver: 'admin-x', recorded_by: 'claudea9' },
          recorded_at: '2026-10-01', withdrawn_at: '2026-10-02' }
      ]
    }
  }
};

const paths = {
  policyFile: '/c/engine/test-policy.json',
  boardFile: '/c/board/tasks.json',
  decisionsFile: '/c/.runtime/test-policy/schedule-decisions.ndjson',
  lastQualifiedFile: '/c/.runtime/test-policy/last-qualified.json',
  runDir: '/c/.runtime/test-policy',
  join: (...p) => p.join('/')
};

function fullFiles(extra = {}) {
  return {
    '/c/engine/test-policy.json': JSON.stringify(POLICY),
    '/c/board/tasks.json': JSON.stringify(BOARD),
    '/c/.runtime/test-policy/schedule-decisions.ndjson':
      `${JSON.stringify({ decision: 'skip', reason: 'no change', recorded_at: '2026-11-10' })}\nnot json\n`,
    '/c/.runtime/test-policy/last-qualified.json': JSON.stringify({ head: 'abc', at: '2026-11-09' }),
    '/c/.runtime/test-policy/nightly-1/test-policy-report.json': JSON.stringify({ metrics: { promotion_outcome: { stage: 'promotion', result: 'pass' } } }),
    ...extra
  };
}

test('the core accepts only the three read methods and rejects a write-capable io', () => {
  assert.deepEqual([...READ_IO_METHODS], ['exists', 'readText', 'listDir']);
  const { io } = fakeIo({});
  assert.doesNotThrow(() => assertReadOnlyIo(io));
  assert.throws(() => assertReadOnlyIo({ exists() {}, readText() {} }), /listDir/);
  assert.throws(() => assertReadOnlyIo(null), /io is required/);
});

test('a full view is produced using only read methods (writes would throw in the fake)', () => {
  const { io, reads } = fakeIo(fullFiles(), { '/c/.runtime/test-policy': ['nightly-1', 'schedule-decisions.ndjson'] });
  const view = loadTestingPolicyView({ io, paths, override: { stageMap: {} }, settings: [{ key: 'k', value: 'v', description: 'd', changeCommand: 'c' }], governedChangeNote: 'note' });
  assert.equal(view.readOnly, true);
  assert.equal(view.policy.policyVersion, '2');
  assert.equal(view.policy.landingGates, 'active');
  assert.deepEqual(view.policy.overrideKeys, ['stageMap']);
  assert.deepEqual(view.stages.map((s) => s.name), ['developer', 'promotion']);
  assert.deepEqual(view.stages[0].fullOn, ['t2-change']);
  assert.deepEqual(view.stageAliases.map((a) => a.alias).sort(), ['release', 'staging']);
  assert.equal(view.checks[0].id, 'selected-suites');
  assert.ok(reads.length > 0);
});

test('exceptions show scope, reason, authority and withdrawn state; lapse is deferred to the resolver', () => {
  const { io } = fakeIo(fullFiles(), { '/c/.runtime/test-policy': [] });
  const view = loadTestingPolicyView({ io, paths });
  assert.equal(view.exceptions.length, 2);
  const active = view.exceptions.find((e) => e.id === 'EX-1');
  assert.equal(active.kind, 'add');
  assert.equal(active.withdrawn, false);
  assert.equal(active.approver, 'admin-x');
  assert.match(active.lapse, /gov test-policy resolve/);
  const gone = view.exceptions.find((e) => e.id === 'EX-2');
  assert.equal(gone.withdrawn, true);
  assert.equal(gone.lapse, 'withdrawn');
});

test('scheduled-run decisions skip unreadable lines and report counts; promotions are read from reports', () => {
  const { io } = fakeIo(fullFiles(), { '/c/.runtime/test-policy': ['nightly-1'] });
  const view = loadTestingPolicyView({ io, paths });
  assert.equal(view.runtime.decisions.total, 2);
  assert.equal(view.runtime.decisions.unreadable, 1);
  assert.equal(view.runtime.decisions.tail[0].decision, 'skip');
  assert.equal(view.runtime.lastQualified[0].key, 'head');
  assert.deepEqual(view.runtime.promotions, [{ run: 'nightly-1', stage: 'promotion', result: 'pass' }]);
});

test('empty state: no policy file, no board exceptions, no runtime records', () => {
  const { io } = fakeIo({});
  const view = loadTestingPolicyView({ io, paths });
  assert.equal(view.policy, null);
  assert.ok(view.warnings.some((w) => /missing or unreadable/.test(w)));
  assert.deepEqual(view.exceptions, []);
  assert.equal(view.runtime.decisions.total, 0);
  assert.equal(view.runtime.lastQualified, null);
  assert.deepEqual(view.runtime.promotions, []);
});

test('an unreadable last-qualified record is reported, not thrown', () => {
  const { io } = fakeIo(fullFiles({ '/c/.runtime/test-policy/last-qualified.json': '{bad' }), { '/c/.runtime/test-policy': [] });
  const view = loadTestingPolicyView({ io, paths });
  assert.equal(view.runtime.lastQualifiedUnreadable, true);
});

test('ticket and branch references are validated; hostile input is rejected', () => {
  assert.equal(isTicketRef('COORD-939'), true);
  assert.equal(isTicketRef('COORD-939; rm -rf'), false);
  assert.equal(isTicketRef('../COORD-1'), false);
  assert.equal(isBranchRef('agent/claudea806-coord-939'), true);
  assert.equal(isBranchRef('../etc/passwd'), false);
  assert.equal(isBranchRef('a..b'), false);
  assert.equal(isBranchRef('$(reboot)'), false);
});

test('resolved view names the ticket repo and stages, lists its exceptions, and renders resolver commands only', () => {
  const { io } = fakeIo(fullFiles(), { '/c/.runtime/test-policy': [] });
  const policyView = loadTestingPolicyView({ io, paths });
  const rows = [{ id: 'COORD-1', repo: 'X', status: 'doing' }];
  const view = buildResolvedView({ ref: 'COORD-1', rows, boardJson: BOARD, policyView });
  assert.equal(view.kind, 'ticket');
  assert.equal(view.repo, 'X');
  assert.equal(view.rowFound, true);
  assert.equal(view.exceptions.length, 2);
  assert.ok(view.commands.every((c) => /test-policy resolve/.test(c.command)));
  assert.ok(view.commands.some((c) => c.command.includes('--ticket COORD-1')));
  assert.match(view.note, /governed resolver/);
});

test('branch view renders resolver commands with --head and never runs git', () => {
  const { io } = fakeIo(fullFiles(), { '/c/.runtime/test-policy': [] });
  const policyView = loadTestingPolicyView({ io, paths });
  const view = buildResolvedView({ ref: 'agent/x-1', rows: [], boardJson: BOARD, policyView });
  assert.equal(view.kind, 'branch');
  assert.ok(view.commands.every((c) => c.command.includes('--head agent/x-1')));
  assert.equal(buildResolvedView({ ref: '../x', policyView }), null);
});
