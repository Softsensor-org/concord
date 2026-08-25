'use strict';

/**
 * COORD-543 — the cockpit must read the REAL product repos, or say it did not.
 *
 * REGRESSION UNDER TEST
 * ---------------------
 * `confineRepoDir(dir) => isPathWithinWorkspace(dir) ? dir : PROJECT_ROOT`
 * clamped any repo resolving outside PROJECT_ROOT back TO PROJECT_ROOT (the
 * engine tree). In the documented sibling-coord topology BOTH product repos
 * resolve outside PROJECT_ROOT, so the test-file inventory counted the engine's
 * own suite once per repo and the git view inspected the engine once per repo
 * and rendered "working tree clean" for repos it had never looked at.
 *
 * FIXTURE TOPOLOGY (models the confirmed adoption model — the parent container
 * is deliberately NOT a git repository, each product repo owns its own .git):
 *
 *   <tmp>/workspace/                 <- container, NO .git
 *     engine/                        <- PROJECT_ROOT (the coord checkout)
 *       coord/                       <- COORD_DIR
 *       engine-a.test.js
 *       engine-b.test.js
 *       engine-c.test.js
 *     backend/     .git/  + 2 test files   <- configured "../backend"
 *     frontend/    .git/  + 1 test file    <- configured "../frontend"
 *     unconfigured-sibling/  .git/         <- exists, NOT configured
 *     outside/                             <- symlink + traversal target
 *
 * Read-only with respect to the repo under test: everything happens in a
 * throwaway tmp dir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  isWithinRoot,
  resolveRepoScope,
  isRepoDirPermitted,
  evaluateRepoRoot,
} = require('./coord-ui-path-boundary.js');

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const PROBES = { realpath: realpathOrNull, isDirectory };

function gitInit(dir) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore', env });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'fixture@example.invalid'], {
    stdio: 'ignore',
    env,
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'fixture'], { stdio: 'ignore', env });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore', env });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture baseline', '--allow-empty'], {
    stdio: 'ignore',
    env,
  });
}

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord543-')));
  const workspace = path.join(root, 'workspace');
  const engine = path.join(workspace, 'engine');
  const coordDir = path.join(engine, 'coord');
  const backend = path.join(workspace, 'backend');
  const frontend = path.join(workspace, 'frontend');
  const unconfigured = path.join(workspace, 'unconfigured-sibling');
  const outside = path.join(root, 'outside');

  for (const d of [coordDir, backend, frontend, unconfigured, outside]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // The container is NOT a git repository — that is the real topology.
  assert.equal(fs.existsSync(path.join(workspace, '.git')), false);

  // Engine tree carries its own test files — the ones the bug double-counted.
  for (const f of ['engine-a.test.js', 'engine-b.test.js', 'engine-c.test.js']) {
    fs.writeFileSync(path.join(engine, f), '// engine suite\n');
  }
  // Product repos carry DIFFERENT, distinguishable counts.
  fs.writeFileSync(path.join(backend, 'api.test.js'), '// backend\n');
  fs.writeFileSync(path.join(backend, 'db.test.js'), '// backend\n');
  fs.writeFileSync(path.join(frontend, 'ui.test.js'), '// frontend\n');

  gitInit(backend);
  gitInit(frontend);
  gitInit(unconfigured);

  return { root, workspace, engine, coordDir, backend, frontend, unconfigured, outside };
}

// The SIBLING-COORD config: correctly scoped, and the primary adoption model.
const SIBLING_REPOS = {
  B: { path: '../backend' },
  F: { path: '../frontend' },
};

function scopeFor(fx, repos = SIBLING_REPOS, allowlist = []) {
  return resolveRepoScope({ coordDir: fx.coordDir, repos, allowlist, ...PROBES });
}

function entry(scope, code) {
  return scope.entries.find((e) => e.code === code);
}

// The PRE-FIX behaviour, reproduced verbatim so the regression is proven red
// against the old logic rather than asserted from memory.
function legacyConfineRepoDir(projectRoot, dir) {
  return isWithinRoot(projectRoot, dir) ? dir : projectRoot;
}

// Mirrors tests.ts walkCount over a resolved dir.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.worktrees']);
const TEST_RE = /\.test\.(tsx?|mjs|jsx?)$/;
function walkCount(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      total += walkCount(path.join(dir, e.name));
    } else if (TEST_RE.test(e.name)) {
      total += 1;
    }
  }
  return total;
}

// Mirrors git.ts's porcelain read over a resolved dir.
function porcelain(dir) {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// ---------------------------------------------------------------------------
// RED PROOF — the pre-fix logic, on this exact fixture, is wrong
// ---------------------------------------------------------------------------

test('COORD-543 regression witness: the pre-fix clamp re-points BOTH product repos at the engine tree', () => {
  const fx = makeWorkspace();
  const projectRoot = path.dirname(fx.coordDir);

  const legacyBackend = legacyConfineRepoDir(
    projectRoot,
    path.resolve(projectRoot, SIBLING_REPOS.B.path)
  );
  const legacyFrontend = legacyConfineRepoDir(
    projectRoot,
    path.resolve(projectRoot, SIBLING_REPOS.F.path)
  );

  // This is the bug: two correctly-scoped product repos, both silently
  // substituted with the engine root.
  assert.equal(legacyBackend, fx.engine);
  assert.equal(legacyFrontend, fx.engine);

  // ...and the consequences the ticket reports, reproduced numerically.
  assert.equal(walkCount(legacyBackend) + walkCount(legacyFrontend), 6, 'engine suite counted twice');
  assert.equal(walkCount(fx.backend) + walkCount(fx.frontend), 3, 'the REAL product-repo total');
});

// ---------------------------------------------------------------------------
// GREEN — the sibling layout resolves to the REAL product repos
// ---------------------------------------------------------------------------

test('sibling-coord layout resolves each product repo to its own real directory', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx);

  assert.equal(scope.projectRoot, fx.engine);
  assert.equal(scope.workspaceRoot, fx.workspace);

  assert.equal(entry(scope, 'B').status, 'ok');
  assert.equal(entry(scope, 'B').dir, fx.backend);
  assert.equal(entry(scope, 'F').status, 'ok');
  assert.equal(entry(scope, 'F').dir, fx.frontend);

  // Explicitly NOT the engine tree.
  assert.notEqual(entry(scope, 'B').dir, fx.engine);
  assert.notEqual(entry(scope, 'F').dir, fx.engine);
});

test('test-file inventory counts the PRODUCT repos, not the engine suite', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx);
  const counts = scope.entries.map((e) => (e.dir ? walkCount(e.dir) : 0));

  assert.deepEqual(counts, [2, 1]);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    3,
    'total must be the real product-repo total, not the engine suite counted once per repo'
  );
  assert.notEqual(counts.reduce((a, b) => a + b, 0), 6);
});

test('git state comes from the product repos: an uncommitted change IS surfaced', () => {
  const fx = makeWorkspace();
  fs.writeFileSync(path.join(fx.backend, 'uncommitted.txt'), 'dirty\n');

  const scope = scopeFor(fx);
  const byCode = Object.fromEntries(scope.entries.map((e) => [e.code, e]));

  // The engine tree is clean-ish/irrelevant; what matters is that the BACKEND's
  // own working tree is what gets inspected.
  const backendStatus = porcelain(byCode.B.dir);
  assert.match(backendStatus, /uncommitted\.txt/);
  assert.equal(porcelain(byCode.F.dir), '', 'frontend is genuinely clean');

  // Pre-fix, both would have pointed at the engine, which is not even a git
  // repo in this fixture — the change would have been invisible.
  assert.equal(fs.existsSync(path.join(fx.engine, '.git')), false);
});

// ---------------------------------------------------------------------------
// NEGATIVE CASES — refusal, never substitution
// ---------------------------------------------------------------------------

test('a configured repo that does not exist is reported UNAVAILABLE, never substituted', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx, { B: { path: '../backend' }, Z: { path: '../not-checked-out' } });
  const z = entry(scope, 'Z');

  assert.equal(z.status, 'unavailable');
  assert.equal(z.dir, null, 'no fallback directory is ever supplied');
  assert.match(z.reason, /does not exist/i);
  assert.notEqual(z.dir, fx.engine);
  assert.notEqual(z.dir, scope.projectRoot);
});

test('an unconfigured sibling is NOT a member of the scope', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx);

  assert.equal(
    scope.entries.some((e) => e.dir === fx.unconfigured),
    false,
    'never enumerated'
  );
  assert.equal(
    isRepoDirPermitted(fx.unconfigured, scope),
    false,
    'membership is an allowlist of CONFIGURED roots, not containment in the workspace'
  );
});

test('a symlink escaping the configured set is refused (realpath canonicalization)', () => {
  const fx = makeWorkspace();
  const link = path.join(fx.workspace, 'evil');
  fs.symlinkSync(fx.outside, link, 'dir');

  const scope = scopeFor(fx, { E: { path: '../evil' } });
  const e = entry(scope, 'E');

  assert.equal(e.status, 'out-of-scope');
  assert.equal(e.dir, null);
  assert.notEqual(e.dir, fx.outside);
});

test('`..` traversal that escapes the workspace is refused', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx, { T: { path: '../../outside' } });
  const t = entry(scope, 'T');

  assert.equal(t.status, 'out-of-scope');
  assert.equal(t.dir, null);
  assert.match(t.reason, /outside the coord workspace/i);
});

test('an absolute path outside the workspace is refused', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx, { A: { path: os.tmpdir() } });
  assert.equal(entry(scope, 'A').status, 'out-of-scope');
  assert.equal(entry(scope, 'A').dir, null);
});

test('the workspace container itself is never an admissible repo root', () => {
  const fx = makeWorkspace();
  // The container is not a git repo and owns nothing; pointing a repo at it is
  // the COORD-543 bug wearing a different costume.
  const scope = scopeFor(fx, { W: { path: '..' } });
  assert.equal(entry(scope, 'W').status, 'out-of-scope');
  assert.equal(entry(scope, 'W').dir, null);

  const verdict = evaluateRepoRoot({
    projectRoot: fx.engine,
    workspaceRoot: fx.workspace,
    canonical: fx.workspace,
  });
  assert.equal(verdict.admissible, false);
});

// ---------------------------------------------------------------------------
// The other supported layouts still work
// ---------------------------------------------------------------------------

test('embedded layout (repos inside the coord checkout) still resolves', () => {
  const fx = makeWorkspace();
  const inner = path.join(fx.engine, 'services');
  fs.mkdirSync(inner, { recursive: true });

  const scope = scopeFor(fx, { S: { path: 'services' } });
  assert.equal(entry(scope, 'S').status, 'ok');
  assert.equal(entry(scope, 'S').dir, inner);
});

test('single-repo adoption (coord inside the product repo, path ".") still resolves', () => {
  const fx = makeWorkspace();
  const scope = scopeFor(fx, { A: { path: '.' } });
  assert.equal(entry(scope, 'A').status, 'ok');
  assert.equal(entry(scope, 'A').dir, fx.engine);
});

test('an operator allowlist entry can opt an out-of-workspace repo back in', () => {
  const fx = makeWorkspace();
  const refused = scopeFor(fx, { O: { path: fx.outside } });
  assert.equal(entry(refused, 'O').status, 'out-of-scope');

  const allowed = scopeFor(fx, { O: { path: fx.outside } }, [fx.outside]);
  assert.equal(entry(allowed, 'O').status, 'ok');
  assert.equal(entry(allowed, 'O').dir, fx.outside);
});

// ---------------------------------------------------------------------------
// Wiring invariants — the consumers must branch on status and never fall back
// ---------------------------------------------------------------------------

const UI_LIB = path.join(__dirname, '..', '..', 'frontend', 'apps', 'coord-ui', 'lib');

test('project-config.ts no longer substitutes PROJECT_ROOT for an unresolved repo', () => {
  const src = fs.readFileSync(path.join(UI_LIB, 'project-config.ts'), 'utf8');
  assert.ok(!/confineRepoDir/.test(src), 'the clamping helper must be gone');
  assert.ok(
    !/\?\s*dir\s*:\s*PROJECT_ROOT/.test(src),
    'no ternary may fall back to PROJECT_ROOT as a repo dir'
  );
  assert.match(src, /resolveRepoScope/, 'must resolve through the shared boundary core');
  assert.match(src, /dir:\s*string\s*\|\s*null/, 'dir must be nullable so callers cannot ignore it');
});

test('tests.ts and git.ts branch on repo status before reading anything', () => {
  for (const file of ['tests.ts', 'git.ts']) {
    const src = fs.readFileSync(path.join(UI_LIB, file), 'utf8');
    assert.match(
      src,
      /repo\.status !== 'ok'/,
      `${file} must short-circuit on an unresolved repo before touching the filesystem`
    );
  }
});

test('the dirty-repo denominator counts only INSPECTED repos', () => {
  const src = fs.readFileSync(path.join(UI_LIB, 'git.ts'), 'utf8');
  assert.match(src, /summarizeGitStatus/);
  assert.match(src, /unresolved:/);
  assert.match(src, /inspected:/);
});
