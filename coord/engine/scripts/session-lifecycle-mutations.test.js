'use strict';
// COORD-852 / COORD-857: keep the COORD-712 mutation harness from rotting
// silently. A deterministic real-mutation sample runs in the default lane; the
// exhaustive six-mutant run remains opt-in via COORD_RUN_MUTATIONS=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn, spawnSync } = require('node:child_process');
const harness = require('./session-lifecycle-mutations.js');
const { PROGRESS_DEFAULTS, createLaneTracker, createProgressDeadline, deadlineMessage } = require('./session-lifecycle-test-utils');
const HARNESS = path.join(__dirname, 'session-lifecycle-mutations.js');
const DEFAULT_MUTATIONS = Object.freeze(['distinct-native-identity', 'whole-plan-rendering']);
// COORD-896: the sample shares the burn-in's cause (its worker target is a lifecycle
// lane), so it gets the same progress deadline instead of a fixed 60s budget.
const SAMPLE_CEILING_MS = PROGRESS_DEFAULTS.ceilingMs, EXHAUSTIVE_CEILING_MS = 3 * PROGRESS_DEFAULTS.ceilingMs;

function scrubbed(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/SESSION_ID|THREAD_ID|NODE_TEST_CONTEXT|NODE_CHANNEL_FD/.test(k)) delete env[k];
  return env;
}
// Runs a child under a progress deadline: output from it, and growth of the worker
// progress file its targets append to, count as progress. Its whole process group
// (the harness and any target it is running) is killed when the deadline expires.
function runWithProgress(args, env, { ceilingMs, label = 'mutation-sample', ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord896-sample-')), progressFile = path.join(dir, 'progress.log');
  const tracker = createLaneTracker({ ceilingMs, ...options });
  const started = performance.now();
  const child = spawn(process.execPath, args, { env: { ...env, COORD_LIFECYCLE_PROGRESS_FILE: progressFile }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', size = 0, expired = null;
  tracker.phase(label, 'before results');
  const deadline = createProgressDeadline({ ...tracker.config, timers: globalThis, onExpire: info => {
    expired = deadlineMessage(label, 'results', tracker, info);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  } });
  const step = text => { tracker.progress(label, { step: text.trim().split('\n').at(-1).slice(0, 160) }); deadline.progress(); };
  child.stdout.on('data', d => { stdout += d; step(String(d)); });
  child.stderr.on('data', d => { stderr += d; step(String(d)); });
  const poll = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(progressFile, 'utf8'); } catch {}
    if (text.length > size) { size = text.length; step(text); }
  }, 250);
  return new Promise(resolve => child.on('close', (status, signal) => {
    clearInterval(poll); deadline.stop(); fs.rmSync(dir, { recursive: true, force: true });
    resolve({ status, signal, stdout, stderr, expired, elapsedMs: performance.now() - started });
  }));
}
function runRealMutants(names, ceilingMs) {
  const script = `
    const harness = require(${JSON.stringify(HARNESS)});
    const names = JSON.parse(process.env.COORD_MUTATION_NAMES);
    const mutants = harness.MUTANTS.filter(m => names.includes(m.name));
    if (mutants.length !== names.length) throw new Error('Unknown or duplicate mutation name');
    // The worker control needs ~13s unloaded and ~40s under heavy I/O pressure
    // (COORD-869, COORD-896). A hung target is caught by the caller's progress
    // deadline, which reads each logged result and the worker's progress file;
    // this per-target cap is only the backstop at the ceiling.
    const result = harness.runMutants({ mutants, targetTimeoutMs: ${ceilingMs}, log: line => process.stderr.write(line + '\\n') });
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      controls: result.controls.map(c => [c.control, c.passed]),
      results: result.results.map(r => [r.mutation, r.killed]),
    }) + '\\n');
    process.exitCode = result.ok ? 0 : 1;
  `;
  return runWithProgress(['-e', script], scrubbed({ COORD_MUTATION_NAMES: JSON.stringify(names) }), { ceilingMs });
}
function tinySource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord852-harness-src-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('engine/board/schema.json', '{}\n');
  write('scripts/a.js', 'module.exports = "ALIVE";\n');
  write('scripts/b.js', 'module.exports = "ALIVE";\n');
  write('scripts/w.js', '');
  write('scripts/t.test.js', '');
  write('paths.js', '');
  return root;
}
const toDead = s => harness.replaceOnce(s, '"ALIVE"', '"DEAD"');
const tinyMutants = [
  { name: 'worker-mutant', file: 'scripts/a.js', target: { worker: 'scripts/w.js' }, change: toDead },
  { name: 'test-mutant', file: 'scripts/b.js', target: { test: 'scripts/t.test.js', pattern: 'P', env: { TINY_TARGET: 'b' } }, change: toDead },
];
// A fake child: a run "fails an assertion" when the file under test was mutated.
function fakeSpawn({ survivor = null, controlStatus = 0, calls = [] } = {}) {
  return (exe, args, options) => {
    const copy = path.join(options.cwd, 'coord');
    const mutated = ['a', 'b'].find(n => fs.readFileSync(path.join(copy, `scripts/${n}.js`), 'utf8').includes('DEAD'));
    calls.push({ args, mutated, tmpdir: options.env.TMPDIR, targetEnv: options.env.TINY_TARGET, tmpExists: fs.existsSync(options.env.TMPDIR) });
    if (!mutated) return { status: controlStatus, stdout: controlStatus ? 'crashed' : '# pass 1\n', stderr: '' };
    if (survivor === mutated) return { status: 0, stdout: '# pass 1\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'AssertionError [ERR_ASSERTION]: caught' };
  };
}

test('COORD-852: every listed mutant anchor matches the live source exactly once and compiles', () => {
  const rows = harness.checkAnchors();
  assert.deepEqual(rows.map(r => r.mutation), ['runtime-lock', 'distinct-native-identity', 'transfer-authority',
    'repair-authority', 'whole-plan-rendering', 'exactly-once-journal']);
  assert.ok(rows.every(r => r.anchor === 'ok'));
  assert.ok(harness.MUTANTS.every(m => typeof m.change === 'function' && (m.target.worker || (m.target.test && m.target.pattern))));
});

test('COORD-852: a stale, ambiguous or no-op anchor and a mutant that does not compile are refused', () => {
  assert.throws(() => harness.replaceOnce('abc', 'x', 'y'), /exactly once \(found 0\)/);
  assert.throws(() => harness.replaceOnce('x x', 'x', 'y'), /exactly once \(found 2\)/);
  assert.equal(harness.replaceOnce('a$b', '$', '$&$&'), 'a$&$&b', 'replacement text is literal');
  assert.throws(() => harness.duplicateSucceededJournalAppend('nothing here'), /Journal success append missing/);
  assert.throws(() => harness.duplicateSucceededJournalAppend('          appendGovernanceEvent({ result'), /Journal success append missing/);
  assert.throws(() => harness.duplicateSucceededJournalAppend('          appendGovernanceEvent({ result: "failed",\n          });'), /Wrong journal mutation join/);
  const once = '          appendGovernanceEvent({ result: "succeeded",\n          });';
  assert.equal(harness.duplicateSucceededJournalAppend(`x\n${once}\ny`), `x\n${once}\n${once}\ny`);
  const src = tinySource();
  try {
    assert.throws(() => harness.mutate(src, { name: 'noop', file: 'scripts/a.js', change: s => s }), /leaves scripts\/a\.js unchanged/);
    assert.throws(() => harness.mutate(src, { name: 'broken', file: 'scripts/a.js', change: s => `${s}(` }), SyntaxError);
    fs.writeFileSync(path.join(src, 'scripts/a.js'), '#!/usr/bin/env node\nmodule.exports = "ALIVE";\n');
    assert.equal(harness.mutate(src, tinyMutants[0]).mutated, '#!/usr/bin/env node\nmodule.exports = "DEAD";\n', 'a hashbang source still compiles');
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('COORD-852: the fixture copy carries the engine tree and child runs are confined to the run root', () => {
  const src = tinySource(), out = fs.mkdtempSync(path.join(os.tmpdir(), 'coord852-harness-copy-'));
  try {
    const copy = harness.prepareCopy(out, src);
    assert.ok(fs.existsSync(path.join(copy, 'engine/board/schema.json')), 'engine/ is copied (the COORD-852 defect)');
    assert.ok(fs.existsSync(path.join(copy, 'scripts/a.js')) && fs.existsSync(path.join(copy, 'paths.js')));
    assert.equal(fs.existsSync(path.join(copy, 'board')), false, 'absent sources are skipped');
    const env = harness.childEnv(out, { KEEP: '1', CODEX_THREAD_ID: 't', COORD_SESSION_ID: 's', NODE_V8_COVERAGE: '/x' });
    assert.deepEqual(env, { KEEP: '1', TMPDIR: path.join(out, 'tmp') });
    assert.deepEqual(harness.childEnv(out, { KEEP: '1', COORD_BURNIN_N: '1', COORD_BURNIN_CONCURRENCY: '1' }, { COORD_BURNIN_N: '12', TMPDIR: '/elsewhere' }),
      { KEEP: '1', COORD_BURNIN_N: '12', TMPDIR: path.join(out, 'tmp') }, 'a target sets its own parameters; inherited ones never leak through and TMPDIR stays confined');
    const burnin = harness.MUTANTS.find(m => m.name === 'runtime-lock').target;
    assert.deepEqual(burnin.env, { COORD_BURNIN_N: '12', COORD_BURNIN_CONCURRENCY: '4' }, 'the burn-in runs at the sizes that reliably expose a lock-free race');
    assert.equal(harness.MUTANTS.find(m => m.name === 'exactly-once-journal').target, burnin);
    assert.deepEqual(harness.targetArgs(copy, { worker: 'scripts/w.js' }), [path.join(copy, 'scripts/w.js'), '1']);
    assert.deepEqual(harness.targetArgs(copy, { test: 'scripts/t.test.js', pattern: 'P' }), ['--test', '--test-name-pattern=P', path.join(copy, 'scripts/t.test.js')]);
    assert.deepEqual(harness.classify({ status: 1, stdout: 'AssertionError', stderr: '' }), { output: 'AssertionError', passed: false, killed: true });
    assert.equal(harness.classify({ status: 1, stderr: 'SyntaxError' }).killed, false, 'a syntax error is not a kill');
    assert.equal(harness.classify({ status: 1, stderr: 'worker exited unexpectedly' }).killed, false, 'a crash without an assertion is not a kill');
    assert.equal(harness.classify({ status: null, signal: 'SIGKILL', stdout: 'AssertionError from partial output' }).killed, false,
      'a signal-terminated child is not a kill even if partial output contains an assertion');
    assert.equal(harness.classify({ status: null, error: new Error('ETIMEDOUT'), stdout: 'ERR_ASSERTION' }).killed, false, 'a timeout is not a kill');
    assert.equal(harness.classify({ status: 0 }).passed, true);
  } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});

test('COORD-857: a timed-out child with partial assertion output is not a mutant kill', () => {
  const r = spawnSync(process.execPath, ['-e', 'require("node:fs").writeSync(1, "AssertionError from partial output\\n"); setInterval(() => {}, 1000);'], {
    encoding: 'utf8', timeout: 1000,
  });
  assert.equal(r.status, null);
  assert.equal(r.error?.code, 'ETIMEDOUT');
  assert.match(r.stdout, /AssertionError/);
  assert.equal(harness.classify(r).killed, false);
});

test('COORD-852: the harness runs controls first, restores each mutant, and reports kills, survivors and broken controls', () => {
  const src = tinySource(), logs = [];
  try {
    const calls = [];
    const all = harness.runMutants({ sourceRoot: src, mutants: tinyMutants, spawn: fakeSpawn({ calls }), log: l => logs.push(l) });
    assert.equal(all.ok, true); assert.equal(all.retained, false);
    assert.equal(fs.existsSync(all.root), false, 'a clean run leaves nothing behind');
    assert.deepEqual(calls.map(c => c.mutated), [undefined, undefined, 'a', 'b'], 'two controls, then one run per mutant on restored sources');
    assert.ok(calls.every(c => c.tmpExists && c.tmpdir.startsWith(all.root)));
    assert.deepEqual(calls.map(c => c.targetEnv), [undefined, 'b', undefined, 'b'], 'each run gets only its own target env');
    assert.deepEqual(all.controls.map(c => c.passed), [true, true]);
    assert.deepEqual(all.results.map(r => [r.mutation, r.killed]), [['worker-mutant', true], ['test-mutant', true]]);

    const kept = harness.runMutants({ sourceRoot: src, mutants: tinyMutants, keep: true, spawn: fakeSpawn(), log: l => logs.push(l) });
    try {
      assert.equal(kept.ok, true); assert.equal(kept.retained, true);
      const saved = JSON.parse(fs.readFileSync(path.join(kept.root, 'results.json'), 'utf8'));
      assert.equal(saved.results.length, 2);
      assert.equal(fs.readFileSync(path.join(kept.root, 'coord/scripts/a.js'), 'utf8'), 'module.exports = "ALIVE";\n', 'mutant restored');
    } finally { fs.rmSync(kept.root, { recursive: true, force: true }); }

    const survived = harness.runMutants({ sourceRoot: src, mutants: tinyMutants, spawn: fakeSpawn({ survivor: 'b' }), log: l => logs.push(l) });
    try {
      assert.equal(survived.ok, false); assert.equal(survived.retained, true);
      assert.deepEqual(survived.results.map(r => r.killed), [true, false]);
    } finally { fs.rmSync(survived.root, { recursive: true, force: true }); }

    const broken = harness.runMutants({ sourceRoot: src, mutants: tinyMutants, spawn: fakeSpawn({ controlStatus: 1 }), log: l => logs.push(l) });
    try {
      assert.equal(broken.ok, false); assert.deepEqual(broken.results, [], 'no mutant is judged against a failing control');
      assert.deepEqual(broken.controls.map(c => c.passed), [false, false]);
    } finally { fs.rmSync(broken.root, { recursive: true, force: true }); }
    assert.ok(logs.some(l => l.startsWith('Mutation evidence retained:')));
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('COORD-852: the CLI checks anchors fast, rejects unknown arguments, and gates its exit code on the run', () => {
  const r = spawnSync(process.execPath, [HARNESS, '--check-anchors'], { encoding: 'utf8', env: scrubbed() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').map(JSON.parse).length, harness.MUTANTS.length);
  const logs = [];
  assert.equal(harness.main(['--bogus'], { log: l => logs.push(l) }), 2);
  assert.match(logs.at(-1), /Unknown argument\(s\): --bogus/);
  const src = tinySource();
  try {
    assert.equal(harness.main(['--check-anchors'], { sourceRoot: path.resolve(__dirname, '..', '..'), log: () => {} }), 0);
    assert.equal(harness.main([], { sourceRoot: src, mutants: tinyMutants, spawn: fakeSpawn(), log: () => {} }), 0);
    let root;
    assert.equal(harness.main(['--keep'], { sourceRoot: src, mutants: tinyMutants, spawn: fakeSpawn({ survivor: 'a' }),
      log: l => { root = /retained: (.+)$/.exec(l)?.[1] || root; } }), 1);
    fs.rmSync(root, { recursive: true, force: true });
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('COORD-857: deterministic real mutation sample runs by default; opt-in expands to all six',
  { timeout: (process.env.COORD_RUN_MUTATIONS ? EXHAUSTIVE_CEILING_MS : SAMPLE_CEILING_MS) + 20000 }, async t => {
  const exhaustive = Boolean(process.env.COORD_RUN_MUTATIONS);
  const selected = exhaustive ? harness.MUTANTS.map(m => m.name) : [...DEFAULT_MUTATIONS];
  assert.equal(selected.length, exhaustive ? harness.MUTANTS.length : DEFAULT_MUTATIONS.length);
  assert.deepEqual(selected, exhaustive ? harness.MUTANTS.map(m => m.name) : DEFAULT_MUTATIONS);

  // The harness is synchronous, so it runs in a child under a progress deadline.
  const result = await runRealMutants(selected, exhaustive ? EXHAUSTIVE_CEILING_MS : SAMPLE_CEILING_MS);
  const { elapsedMs } = result;
  assert.equal(result.expired, null, result.expired);
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.ok, true);
  assert.ok(summary.controls.length > 0 && summary.controls.every(([, passed]) => passed));
  assert.deepEqual(summary.results, selected.map(name => [name, true]));
  t.diagnostic(`${exhaustive ? 'exhaustive' : 'default'} mutation set: ${selected.join(', ')}; elapsed ${elapsedMs}ms under a progress deadline (ceiling ${exhaustive ? EXHAUSTIVE_CEILING_MS : SAMPLE_CEILING_MS}ms)`);
});

test('COORD-896: the mutation sample runner kills a silent harness and its targets at the stall limit and reports why', async () => {
  // The child starts a grandchild in its own process group, reports one step, then hangs.
  const script = `
    const target = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write('target ' + target.pid + '\\n');
    setTimeout(() => require('node:fs').appendFileSync(process.env.COORD_LIFECYCLE_PROGRESS_FILE, '1 1 reconcile\\n'), 300);
    setInterval(() => {}, 1000);
  `;
  const quiet = () => ({ ioPressure: 'some avg10=0.00 | full avg10=0.00', ioFullAvg10: 0, loadavg: '0.10 0.10 0.10 1/1 1', load1: 0.1, cpus: 4 });
  const r = await runWithProgress(['-e', script], scrubbed(), { ceilingMs: 60000, stallMs: 1500, loadedStallMs: 1500, readHost: quiet });
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(r.elapsedMs < 20000, `stalled sample took ${r.elapsedMs}ms to fail`);
  assert.match(r.expired, /^lane mutation-sample made no progress toward results for \d+ms/);
  assert.match(r.expired, /lane mutation-sample: phase=before results last_step=1 1 reconcile steps=2 /);
  const target = Number(/^target (\d+)$/m.exec(r.stdout)[1]);
  const alive = () => { try { process.kill(target, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the hung target is killed with its harness');
  assert.match(r.expired, /host: io_pressure=some avg10=0\.00 \| full avg10=0\.00; loadavg=0\.10 0\.10 0\.10 1\/1 1; cpus=4; not under I\/O or CPU pressure/);
});

// COORD-873: the CLI shim calls the engine main() with no arguments; the exported
// wrapper must then parse the real command line and set process.exitCode, but must
// leave the exit code alone when the caller injects deps. Drive both arms in children
// with a controlled process.argv so no mutant ever runs.
function runWrapperChild(callExpr) {
  const script = `
    process.argv = [process.execPath, 'session-lifecycle-mutations.js', '--coord-873-bogus'];
    const harness = require(${JSON.stringify(HARNESS)});
    const logs = [];
    const rc = ${callExpr};
    process.stderr.write(JSON.stringify({ rc, exitCode: process.exitCode ?? null, logs }) + '\\n');
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: scrubbed(), timeout: 30000 });
}
test('COORD-873: the exported main() runs the command line and sets the exit code only when called with no arguments', () => {
  const cli = runWrapperChild('harness.main()');
  assert.equal(cli.status, 2, JSON.stringify({ stdout: cli.stdout, stderr: cli.stderr }));
  assert.match(cli.stdout, /Unknown argument\(s\): --coord-873-bogus/);
  assert.deepEqual(JSON.parse(cli.stderr.trim()), { rc: 2, exitCode: 2, logs: [] });

  const injected = runWrapperChild('harness.main(undefined, { log: l => logs.push(l) })');
  assert.equal(injected.status, 0, JSON.stringify({ stdout: injected.stdout, stderr: injected.stderr }));
  assert.equal(injected.stdout, '', 'injected log receives the usage message');
  const report = JSON.parse(injected.stderr.trim());
  assert.equal(report.rc, 2);
  assert.equal(report.exitCode, null, 'an injected-deps call must not set process.exitCode');
  assert.match(report.logs.at(-1), /Unknown argument\(s\): --coord-873-bogus/);
});
