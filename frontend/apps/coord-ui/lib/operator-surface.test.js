import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildCommandPalette, visibleNavigation } from './operator-surface.js';

const commands = [
  { name: 'doctor', namespace: 'product', maturity: 'stable', safety: 'read_only', summary: 'Inspect readiness.', docs: 'doctor.md', ui_palette: true },
  { name: 'business-discovery', namespace: 'product', maturity: 'alpha', safety: 'read_only', role: 'analyst', summary: 'Discover business context.', docs: 'discovery.md', ui_palette: true, advanced: true },
  { name: 'requirements', namespace: 'product', maturity: 'planned_surface', safety: 'read_only', summary: 'Future requirements surface.', docs: 'requirements.md', ui_palette: true, advanced: true },
  { name: 'start', namespace: 'governance', maturity: 'existing_lifecycle', safety: 'governance_mutation', summary: 'Start ticket work.', docs: 'lifecycle.md', ui_palette: false, advanced: true },
];

test('default palette contains only stable registry entries marked for UI discovery', () => {
  const result = buildCommandPalette(commands);
  assert.deepEqual(result.map(({ namespace, name }) => `${namespace}:${name}`), ['product:doctor']);
  assert.equal(result[0].advanced, false);
  assert.equal(result[0].planned, false);
  assert.equal('command' in result[0], false);
});

test('advanced palette adds discoverable alpha metadata while preserving its role and safety labels', () => {
  const result = buildCommandPalette(commands, { includeAdvanced: true });
  const alpha = result.find((command) => command.name === 'business-discovery');
  assert.ok(alpha);
  assert.equal(alpha.advanced, true);
  assert.equal(alpha.role, 'analyst');
  assert.equal(alpha.safety, 'read_only');
});

test('planned entries are visibly classified metadata and non-palette lifecycle commands stay excluded', () => {
  const result = buildCommandPalette(commands, { includeAdvanced: true });
  const planned = result.find((command) => command.name === 'requirements');
  assert.ok(planned);
  assert.equal(planned.planned, true);
  assert.equal(planned.advanced, true);
  assert.equal('command' in planned, false);
  assert.equal(result.some((command) => command.name === 'start'), false);
});

test('advanced navigation preserves every route while default keeps only stable operator views', () => {
  const nav = [
    { href: '/', label: 'board', group: 'Work', maturity: 'stable' },
    { href: '/dispatch', label: 'dispatch', group: 'Work', maturity: 'stable' },
    { href: '/live-mcp', label: 'live-mcp', group: 'Risk', maturity: 'advanced' },
  ];
  assert.deepEqual(visibleNavigation(nav).map((item) => item.href), ['/', '/dispatch']);
  assert.deepEqual(visibleNavigation(nav, true), nav);
});

test('the real registry supplies stable defaults and planned entries only in advanced metadata', () => {
  const require = createRequire(import.meta.url);
  const registry = require('../../../../coord/engine/scripts/command-registry.js');
  const defaults = registry.listCommandMetadata();
  assert.ok(defaults.length > 0);
  assert.ok(defaults.every((command) => command.namespace === 'product' && command.maturity === 'stable' && command.role === 'operator'));

  const defaultPalette = buildCommandPalette(defaults);
  assert.ok(defaultPalette.length > 0);
  assert.ok(defaultPalette.every((command) => !command.advanced && !command.planned));

  const advanced = buildCommandPalette(registry.listCommandMetadata({ includeAdvanced: true }), {
    includeAdvanced: true,
  });
  assert.ok(advanced.some((command) => command.advanced && command.maturity === 'alpha'));
  assert.ok(advanced.some((command) => command.planned && command.maturity === 'planned_surface'));
  assert.ok(advanced.every((command) => !('command' in command)));
});
