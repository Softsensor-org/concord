import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBoardRows, normalizeStatus, nonRunnableStatusGuidance } from './board-state.js';

const row = (id, status, fields = {}) => ({ id, repo: 'F', status, source: 'tasks.json', ...fields });

test('normalizes proposed and blocked reason while keeping malformed states unknown', () => {
  assert.deepEqual(normalizeStatus('doing (blocked: waiting on COORD-900)'), {
    status: 'blocked',
    blockedReason: 'waiting on COORD-900'
  });
  assert.deepEqual(normalizeStatus('proposed'), { status: 'proposed' });
  assert.deepEqual(normalizeStatus('doing (blocked: )'), { status: 'unknown' });
  assert.deepEqual(normalizeStatus('doing (blocked: reason'), { status: 'unknown' });
});

test('proposed, blocked, and unknown statuses never produce ordinary start guidance', () => {
  for (const status of ['proposed', 'blocked', 'unknown']) {
    const guidance = nonRunnableStatusGuidance('UI-544', status, 'waiting on approval');
    assert.ok(guidance);
    assert.ok(guidance.every((line) => !/gov start\b/.test(line)));
  }
  assert.match(nonRunnableStatusGuidance('UI-544', 'proposed').join('\n'), /quarantined pending acceptance/);
  assert.match(nonRunnableStatusGuidance('UI-544', 'blocked', 'waiting on approval').join('\n'), /waiting on approval/);
  assert.equal(nonRunnableStatusGuidance('UI-544', 'todo'), null, 'todo continues through canonical next-command guidance');
});

test('canonical blocked row wins over active note, retained lock, and successful block event', () => {
  const locks = new Map([['UI-544', { id: 'UI-544', owner: 'lock-owner', branch: 'agent/544' }]]);
  const eventsByTicket = new Map([['UI-544', [{
    ticket: 'UI-544', command: 'block', result: 'succeeded',
    after_status: 'doing (blocked: dependency is still open)', identity: { owner: 'event-owner' }
  }]]]);
  const [merged] = mergeBoardRows({
    boardRows: [row('UI-544', 'doing (blocked: waiting on COORD-900)', { owner: 'board-owner' })],
    activeRows: [row('UI-544', 'unknown', { source: 'active' })],
    locks,
    eventsByTicket
  });

  assert.equal(merged.status, 'blocked');
  assert.equal(merged.blockedReason, 'waiting on COORD-900');
  assert.equal(merged.owner, 'board-owner');
  assert.equal(merged.source, 'tasks.json', 'canonical status and metadata keep canonical source attribution');
  assert.equal(locks.get('UI-544').branch, 'agent/544', 'the lock remains available as ownership metadata');
});

test('canonical doing and closed rows ignore stale locks, active notes, and journal promotions', () => {
  const locks = new Map([['UI-544', { id: 'UI-544', owner: 'retained-owner' }]]);
  const activeRows = [row('UI-544', 'unknown', { source: 'active' }), row('UI-699', 'unknown', { source: 'active' })];
  const eventsByTicket = new Map([
    ['UI-544', [{ ticket: 'UI-544', command: 'block', result: 'succeeded', after_status: 'doing (blocked: old reason)' }]],
    ['UI-699', [{ ticket: 'UI-699', command: 'update-plan', result: 'succeeded', after_status: 'doing' }]]
  ]);
  const rows = mergeBoardRows({
    boardRows: [row('UI-544', 'doing'), row('UI-699', 'done')],
    activeRows,
    locks,
    eventsByTicket
  });

  assert.equal(rows.find((r) => r.id === 'UI-544').status, 'doing');
  assert.equal(rows.find((r) => r.id === 'UI-544').blockedReason, undefined);
  assert.equal(rows.find((r) => r.id === 'UI-544').owner, 'retained-owner');
  assert.equal(rows.find((r) => r.id === 'UI-699').status, 'done');
});

test('event-only fallback accepts successful lifecycle transitions and leaves failed or unrelated evidence unknown', () => {
  const rows = mergeBoardRows({
    activeRows: [
      row('UI-BLOCK', 'unknown', { source: 'active' }),
      row('UI-UNBLOCK', 'unknown', { source: 'active' }),
      row('UI-FAILED', 'unknown', { source: 'active' }),
      row('UI-START', 'unknown', { source: 'active' }),
      row('UI-NO-EVENT', 'unknown', { source: 'active' }),
      row('UI-MALFORMED-AFTER', 'unknown', { source: 'active' }),
      row('UI-NULL-AFTER', 'unknown', { source: 'active' }),
      row('UI-INHERITED-NO-AFTER', 'unknown', { source: 'active' }),
      row('UI-INHERITED-AFTER', 'unknown', { source: 'active' })
    ],
    eventsByTicket: new Map([
      ['UI-BLOCK', [{ ticket: 'UI-BLOCK', command: 'block', result: 'succeeded', after_status: 'doing (blocked: waiting for review)' }]],
      ['UI-UNBLOCK', [
        { ticket: 'UI-UNBLOCK', command: 'update-plan', result: 'succeeded', after_status: 'doing' },
        { ticket: 'UI-UNBLOCK', command: 'unblock', result: 'succeeded', after_status: 'doing' }
      ]],
      ['UI-FAILED', [
        { ticket: 'UI-FAILED', command: 'block', result: 'failed', after_status: 'doing (blocked: rejected)' },
        { ticket: 'UI-FAILED', command: 'custom-note', result: 'succeeded', after_status: 'done' }
      ]],
      ['UI-MALFORMED-AFTER', [{ ticket: 'UI-MALFORMED-AFTER', command: 'start', result: 'succeeded', after_status: '' }]],
      ['UI-NULL-AFTER', [{ ticket: 'UI-NULL-AFTER', command: 'start', result: 'succeeded', after_status: null }]],
      ['UI-INHERITED-NO-AFTER', [{ ticket: 'UI-INHERITED-NO-AFTER', command: 'toString', result: 'succeeded' }]],
      ['UI-INHERITED-AFTER', [{ ticket: 'UI-INHERITED-AFTER', command: 'constructor', result: 'succeeded', after_status: 'done' }]],
      ['UI-START', [{ ticket: 'UI-START', command: 'start', result: 'succeeded', after_status: 'doing', identity: { owner: 'started-by' } }]]
    ])
  });

  assert.equal(rows.find((r) => r.id === 'UI-BLOCK').status, 'blocked');
  assert.equal(rows.find((r) => r.id === 'UI-BLOCK').blockedReason, 'waiting for review');
  assert.equal(rows.find((r) => r.id === 'UI-UNBLOCK').status, 'doing');
  assert.equal(rows.find((r) => r.id === 'UI-FAILED').status, 'unknown');
  assert.equal(rows.find((r) => r.id === 'UI-NO-EVENT').status, 'unknown');
  assert.equal(rows.find((r) => r.id === 'UI-MALFORMED-AFTER').status, 'unknown', 'present malformed status does not fall back to command mapping');
  assert.equal(rows.find((r) => r.id === 'UI-NULL-AFTER').status, 'doing', 'legacy command mapping applies when after_status is null');
  assert.equal(rows.find((r) => r.id === 'UI-INHERITED-NO-AFTER').status, 'unknown');
  assert.equal(rows.find((r) => r.id === 'UI-INHERITED-AFTER').status, 'unknown');
  assert.equal(rows.find((r) => r.id === 'UI-START').status, 'doing');
  assert.equal(rows.find((r) => r.id === 'UI-START').owner, 'started-by');
});

test('a retained lock without a canonical row or successful lifecycle event does not invent todo status', () => {
  const [merged] = mergeBoardRows({
    activeRows: [row('UI-LOCK-ONLY', 'unknown', { source: 'active' })],
    locks: new Map([['UI-LOCK-ONLY', { id: 'UI-LOCK-ONLY', owner: 'retained-owner' }]])
  });
  assert.equal(merged.status, 'unknown');
  assert.equal(merged.owner, 'retained-owner');
});

test('canonical proposed and malformed statuses remain quarantined/unknown despite lock and event', () => {
  const locks = new Map([['UI-PROP', { id: 'UI-PROP', owner: 'operator' }]]);
  const rows = mergeBoardRows({
    boardRows: [row('UI-PROP', 'proposed'), row('UI-BAD', 'doing (blocked: incomplete')],
    activeRows: [row('UI-PROP', 'unknown', { source: 'active' })],
    locks,
    eventsByTicket: new Map([['UI-BAD', [{ ticket: 'UI-BAD', command: 'start', result: 'succeeded', after_status: 'doing' }]]])
  });
  assert.equal(rows.find((r) => r.id === 'UI-PROP').status, 'proposed');
  assert.equal(rows.find((r) => r.id === 'UI-PROP').owner, 'operator');
  assert.equal(rows.find((r) => r.id === 'UI-BAD').status, 'unknown');
});
