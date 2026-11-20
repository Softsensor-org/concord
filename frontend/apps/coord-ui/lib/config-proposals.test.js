import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.resolve(import.meta.dirname, '..');
const LIB = fs.readFileSync(path.join(UI, 'lib/config-proposals.ts'), 'utf8');
const ROUTE = fs.readFileSync(path.join(UI, 'app/api/config/proposals/route.ts'), 'utf8');
const FORM = fs.readFileSync(path.join(UI, 'app/testing-policy/proposal-form.tsx'), 'utf8');
const { proposalArgs, parseProposalResult, pendingProposals } = await import('./config-proposals-core.js');
const CORE = fs.readFileSync(path.join(UI, 'lib/config-proposals-core.js'), 'utf8');

test('UI submits through the governed config propose command with an exact source digest', () => {
  assert.match(LIB, /createHash\('sha256'\)/);
  assert.match(LIB, /proposalArgs\(\{ target, value, baseDigest \}\)/);
  assert.match(LIB, /spawnSync\(process\.execPath, args/);
  assert.match(CORE, /JSON\.stringify\(value\)/);
  assert.doesNotMatch(LIB, /writeFile|appendFile|renameSync/);
});

test('proposal route requires operator access and same-origin JSON', () => {
  assert.match(ROUTE, /requireRole\('operator'\)/);
  assert.match(ROUTE, /same-origin request required/);
  assert.match(ROUTE, /proposeConfig\(input\.target, input\.value\)/);
});

test('the UI exposes proposal creation and diff/refusal display without an approval control', () => {
  assert.match(FORM, /Create proposal/);
  assert.match(FORM, /proposal\.diff/);
  assert.match(FORM, /setRefusal/);
  assert.doesNotMatch(FORM, /config approve|human-admin-override/i);
});

test('UI adapter args parse to the same governed CLI target, value and base digest', () => {
  const value = { stageMap: { qa: 'pr' } };
  const args = proposalArgs({ target: 'project.testPolicy', value, baseDigest: 'a'.repeat(64) });
  const options = new Map(args.slice(2).reduce((pairs, item, index, rest) => index % 2 === 0 ? [...pairs, [item, rest[index + 1]]] : pairs, []));
  assert.equal(args[0], 'config');
  assert.equal(args[1], 'propose');
  assert.equal(options.get('--target'), 'project.testPolicy');
  assert.equal(options.get('--base-digest'), 'a'.repeat(64));
  assert.deepEqual(JSON.parse(options.get('--value-json')), value);
  assert.deepEqual(parseProposalResult(JSON.stringify({ proposal_id: 'p1', target: 'project.testPolicy', base_digest: 'a'.repeat(64), diff: { before: null, after: value }, refusal: null })).diff.after, value);
});

test('pending UI view is derived from journal proposal and terminal events', () => {
  const proposal = { proposal_id: 'p1', type: 'config.proposed', target: 'project.testPolicy', base_digest: 'a', result_digest: 'b', created_at: 'now' };
  assert.deepEqual(pendingProposals([proposal, { proposal_id: 'p2', type: 'config.proposed' }, { proposal_id: 'p2', type: 'config.applied' }]).map((item) => item.proposal_id), ['p1']);
});
