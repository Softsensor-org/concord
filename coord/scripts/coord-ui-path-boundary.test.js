'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isWithinRoot,
  isAllowlisted,
  evaluatePath,
  assertWithinBoundary,
  parseAllowlist,
  sanitizeProjectConfig,
} = require('./coord-ui-path-boundary.js');

const ROOT = path.resolve('/srv/project');

test('isWithinRoot: the root itself is contained', () => {
  assert.equal(isWithinRoot(ROOT, ROOT), true);
});

test('isWithinRoot: a descendant is contained', () => {
  assert.equal(isWithinRoot(ROOT, path.join(ROOT, 'coord', 'board')), true);
});

test('isWithinRoot: an absolute path outside the root is NOT contained', () => {
  assert.equal(isWithinRoot(ROOT, '/etc/passwd'), false);
});

test('isWithinRoot: a sibling that shares a name prefix is NOT contained', () => {
  // /srv/project-secrets must not be treated as inside /srv/project.
  assert.equal(isWithinRoot(ROOT, '/srv/project-secrets/data'), false);
});

test('isWithinRoot: `..` traversal that escapes the root is NOT contained', () => {
  assert.equal(isWithinRoot(ROOT, path.join(ROOT, '..', '..', 'etc', 'passwd')), false);
});

test('isWithinRoot: rejects empty/non-string inputs', () => {
  assert.equal(isWithinRoot('', ROOT), false);
  assert.equal(isWithinRoot(ROOT, ''), false);
  assert.equal(isWithinRoot(null, undefined), false);
});

test('isAllowlisted: matches an entry that contains the candidate', () => {
  assert.equal(isAllowlisted('/mnt/shared/docs/URS.md', ['/mnt/shared']), true);
});

test('isAllowlisted: no match outside every entry', () => {
  assert.equal(isAllowlisted('/etc/passwd', ['/mnt/shared', '/opt/data']), false);
});

test('isAllowlisted: empty allowlist never matches', () => {
  assert.equal(isAllowlisted('/etc/passwd', []), false);
});

test('evaluatePath: inside-root path is permitted', () => {
  const v = evaluatePath({ projectRoot: ROOT, candidate: path.join(ROOT, 'coord', 'product', 'REQUIREMENTS.md') });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'within-root');
  assert.equal(v.error, null);
  assert.equal(v.resolved, path.join(ROOT, 'coord', 'product', 'REQUIREMENTS.md'));
});

test('evaluatePath: outside-root absolute path is REJECTED by default with a clear error', () => {
  const v = evaluatePath({ projectRoot: ROOT, candidate: '/etc/passwd', label: 'COORD_REQUIREMENTS_PATH' });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'outside-root');
  assert.match(v.error, /OUTSIDE/);
  assert.match(v.error, /COORD_REQUIREMENTS_PATH/);
  assert.match(v.error, /COORD_UI_PATH_ALLOWLIST/);
});

test('evaluatePath: an allowlisted outside-root path is PERMITTED', () => {
  const v = evaluatePath({
    projectRoot: ROOT,
    candidate: '/mnt/shared/docs/URS.md',
    allowlist: ['/mnt/shared'],
  });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'allowlisted');
  assert.equal(v.error, null);
});

test('evaluatePath: empty candidate is rejected', () => {
  const v = evaluatePath({ projectRoot: ROOT, candidate: '' });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'empty');
});

test('assertWithinBoundary: returns the resolved path when permitted', () => {
  const inside = path.join(ROOT, 'coord');
  assert.equal(assertWithinBoundary({ projectRoot: ROOT, candidate: inside }), inside);
});

test('assertWithinBoundary: throws a clear error when rejected', () => {
  assert.throws(
    () => assertWithinBoundary({ projectRoot: ROOT, candidate: '/etc/shadow', label: 'COORD_DIR' }),
    /OUTSIDE the project root/
  );
});

test('parseAllowlist: splits on path delimiter and commas, trims, drops empties', () => {
  assert.deepEqual(parseAllowlist('/a/b:/c/d'), ['/a/b', '/c/d']);
  assert.deepEqual(parseAllowlist('/a, /b ,'), ['/a', '/b']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('sanitizeProjectConfig: accepts a valid config and keeps string fields', () => {
  const out = sanitizeProjectConfig({
    repos: {
      B: { path: 'backend', integrationBranch: 'dev', extra: 'ignored' },
      F: { path: 'frontend' },
    },
  });
  assert.deepEqual(out, {
    repos: {
      B: { path: 'backend', integrationBranch: 'dev' },
      F: { path: 'frontend' },
    },
  });
});

test('sanitizeProjectConfig: flags/drops invalid shapes -> empty repos', () => {
  assert.deepEqual(sanitizeProjectConfig(null), { repos: {} });
  assert.deepEqual(sanitizeProjectConfig('nope'), { repos: {} });
  assert.deepEqual(sanitizeProjectConfig({}), { repos: {} });
  assert.deepEqual(sanitizeProjectConfig({ repos: 'bad' }), { repos: {} });
});

test('sanitizeProjectConfig: drops non-object repo entries and non-string fields', () => {
  const out = sanitizeProjectConfig({
    repos: {
      B: 'not-an-object',
      F: { path: 42, integrationBranch: true },
      G: { path: 'good' },
    },
  });
  assert.deepEqual(out, { repos: { F: {}, G: { path: 'good' } } });
});
