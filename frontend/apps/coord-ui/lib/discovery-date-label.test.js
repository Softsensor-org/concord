import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveryDateLabel } from './discovery-date-label.js';

test('discovery date label hides the deterministic epoch sentinel', () => {
  assert.equal(discoveryDateLabel('1970-01-01T00:00:00.000Z'), null);
});

test('discovery date label keeps a real extraction date', () => {
  assert.equal(discoveryDateLabel('2026-09-29T14:42:00.000Z'), '2026-09-29');
});

test('discovery date label omits a missing timestamp', () => {
  assert.equal(discoveryDateLabel(null), null);
});
