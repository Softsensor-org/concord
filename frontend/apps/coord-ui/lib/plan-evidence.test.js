import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { activePlanEvidence, independentReviewView } from './plan-evidence.js';

// COORD-822: the cockpit uses the SAME engine projection as the gov CLI.
const require = createRequire(import.meta.url);
const engine = require('../../../../coord/engine/scripts/plan-evidence-supersession.js');
const correction = { actor: 'codexa756', timestamp: '2026-10-13T00:00:00.000Z' };

test('superseded repo gates and retracted invariants are not current cockpit evidence', () => {
  let plan = {
    repo_gates: ['npm test - result=pass on stale head', 'npm run gate - result=pass'],
    verification_commands: ['node --test old.test.js'],
    critical_invariants: ['timing probe 1', 'Journal state stays verifiable.']
  };
  plan = engine.applySupersession(plan, { ...correction, kind: 'repo_gate', entry: plan.repo_gates[0], replacement: 'npm test - result=fail on current head', reason: 'stale head' }).record;
  plan = engine.applyInvariantRetraction(plan, { ...correction, entry: 'timing probe 1', reason: 'measurement text' }).record;

  assert.deepEqual(activePlanEvidence(plan, engine.resolvePlanEvidence), {
    repoGates: ['npm test - result=fail on current head', 'npm run gate - result=pass'],
    verificationCommands: ['node --test old.test.js'],
    criticalInvariants: ['Journal state stays verifiable.'],
    error: null
  });
  assert.equal(plan.repo_gates.length, 3, 'the raw append-only history is untouched');
});

test('a plan without corrections reads unchanged and a missing plan is empty', () => {
  const plan = { repo_gates: ['g'], verification_commands: ['v'], critical_invariants: ['i'] };
  assert.deepEqual(activePlanEvidence(plan, engine.resolvePlanEvidence), {
    repoGates: ['g'], verificationCommands: ['v'], criticalInvariants: ['i'], error: null
  });
  assert.deepEqual(activePlanEvidence(null, engine.resolvePlanEvidence), {
    repoGates: [], verificationCommands: [], criticalInvariants: [], error: null
  });
});

test('an invalid correction ledger fails closed instead of showing raw history as current', () => {
  const plan = { repo_gates: ['npm test - result=pass'], evidence_supersessions: [{}] };
  const view = activePlanEvidence(plan, engine.resolvePlanEvidence);
  assert.deepEqual(view.repoGates, []);
  assert.deepEqual(view.criticalInvariants, []);
  assert.match(view.error, /malformed kind or evidence reference/);
  assert.equal(activePlanEvidence(plan, () => { throw 'engine unavailable'; }).error, 'engine unavailable');
});

// COORD-718: the cockpit's independent-review view is the engine projection.
const reviewEngine = require('../../../../coord/engine/scripts/independent-reviews.js');
const reviewOf = (handle, commit, extra = {}) => reviewEngine.buildIndependentReview({
  ticketId: 'COORD-718', reviewer: { handle, agent_id: null, session_id: `${handle}-s`, thread_id: null }, ownerAtReview: 'claudea12',
  repository: 'coord', commit, method: 'code review', findings: ['F1'], verdict: 'pass', timestamp: '2026-10-21T20:00:00.000Z', ...extra
});

test('independent reviews split into current and historical at the claimed head', () => {
  const head = 'a'.repeat(40);
  const stale = reviewOf('claudea13', 'b'.repeat(40), { reviewKey: 'first' });
  const fresh = reviewOf('claudea13', head, { reviewKey: 'second', supersedes: stale.id, reason: 'fix head' });
  const plan = { ticket_id: 'COORD-718', independent_reviews: [stale, fresh] };
  const view = independentReviewView(plan, { scope: { repository: 'coord', commit: head, source: 'lock' }, owner: 'claudea12' }, reviewEngine.projectIndependentReviews);
  assert.equal(view.currentCount, 1);
  assert.deepEqual(view.current.map((row) => row.id), [fresh.id], 'only the exact-head, unsuperseded review is current');
  assert.equal(view.current[0].reviewer, 'claudea13');
  assert.equal(view.current[0].ownerAtReview, 'claudea12');
  assert.deepEqual(view.historical.map((row) => [row.id, row.currency, row.successor]), [[stale.id, 'superseded', fresh.id]]);
  const unscoped = independentReviewView(plan, { scope: null, owner: null }, reviewEngine.projectIndependentReviews);
  assert.equal(unscoped.currentCount, 0, 'no claimed head means nothing is current');
});

test('a plan without independent reviews shows none, and an invalid ledger fails closed', () => {
  const none = independentReviewView({ ticket_id: 'COORD-718', self_review_cycles: [{ cycle: 1 }] }, { scope: null, owner: null }, reviewEngine.projectIndependentReviews);
  assert.deepEqual([none.currentCount, none.historicalCount, none.error], [0, 0, null], 'self-review cycles are not independent reviews');
  const invalid = independentReviewView({ ticket_id: 'COORD-718', independent_reviews: [{ id: 'x' }] }, { scope: null, owner: null }, reviewEngine.projectIndependentReviews);
  assert.equal(invalid.currentCount, 0);
  assert.match(invalid.error, /Independent review entry 1/);
  const unloadable = independentReviewView({ independent_reviews: [] }, null, () => { throw new Error('engine missing'); });
  assert.deepEqual([unloadable.currentCount, unloadable.current, unloadable.error], [0, [], 'engine missing']);
});
