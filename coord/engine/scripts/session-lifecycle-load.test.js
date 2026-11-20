'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { startLoad, parseArgs } = require('./session-lifecycle-load');

function loadWithMockSpawn(t, spawnImpl) {
  const childProcess = require('node:child_process');
  const modulePath = require.resolve('./session-lifecycle-load');
  const originalSpawn = childProcess.spawn;
  delete require.cache[modulePath];
  childProcess.spawn = spawnImpl;
  t.after(() => {
    childProcess.spawn = originalSpawn;
    delete require.cache[modulePath];
  });
  return require(modulePath);
}

async function reapChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('COORD-937: the synthetic load parser applies defaults and rejects malformed flags', () => {
  assert.deepEqual(parseArgs(['--cpu', '3', '--io', '2', '--seconds', '5', '--io-mib', '4']),
    { cpu: 3, io: 2, seconds: 5, ioMib: 4, dir: os.tmpdir() });
  assert.deepEqual(parseArgs([]), { cpu: 0, io: 0, seconds: 60, ioMib: 16, dir: os.tmpdir() });
  assert.throws(() => parseArgs(['--cpu', '-1']), /--cpu/);
  assert.throws(() => parseArgs(['--seconds', '0']), /--seconds/);
  assert.throws(() => parseArgs(['--bogus', '1']), /unknown/);
});

test('COORD-937: startLoad runs real CPU and fsync I/O children until stopped, then leaves nothing behind', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord937-load-'));
  const foreign = path.join(dir, 'load-io-another-run-123.bin');
  fs.writeFileSync(foreign, 'foreign run data\n');
  let load;
  t.after(async () => {
    if (load) await load.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  load = await startLoad({ cpu: 1, io: 1, dir, ioMib: 1 });
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('load-io-') && name !== path.basename(foreign)),
    'the I/O child writes its own file before start resolves');
  const summary = await load.stop();
  assert.equal(summary.children, 2);
  assert.deepEqual(summary.signals, ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(foreign)], 'stop removes only this invocation’s file');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign run data\n', 'another run’s file is preserved');
});

test('COORD-1052: zero-worker cleanup preserves files owned by another load run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord1052-load-foreign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const foreign = path.join(dir, 'load-io-another-run-123.bin');
  fs.writeFileSync(foreign, 'foreign run data\n');
  const load = await startLoad({ cpu: 0, io: 0, dir });
  assert.deepEqual(await load.stop(), { children: 0, signals: [] });
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign run data\n');
});

test('COORD-1052: early child exit is rejected and startup cleanup removes the exit listener', async (t) => {
  const realSpawn = require('node:child_process').spawn;
  const children = [];
  let calls = 0;
  const { startLoad: mockedStartLoad } = loadWithMockSpawn(t, (executable, args, options) => {
    calls += 1;
    const child = calls === 1
      ? realSpawn(executable, args, options)
      : realSpawn(process.execPath, ['-e', 'setImmediate(() => process.exit(9))'], options);
    children.push(child);
    return child;
  });
  t.after(async () => { await Promise.all(children.map(reapChild)); });
  const before = process.listenerCount('exit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord1052-load-early-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(mockedStartLoad({ cpu: 1, io: 1, dir }), /load child exited before starting \(code 9\)/);
  assert.equal(calls, 2);
  assert.equal(children.length, 2);
  assert.equal(children[0].signalCode, 'SIGKILL', 'the running CPU sibling is stopped after another child exits early');
  assert.equal(children[1].exitCode, 9);
  assert.equal(children.every(child => child.exitCode !== null || child.signalCode !== null), true, 'all started children are reaped');
  assert.equal(process.listenerCount('exit'), before, 'failed startup removes its parent-exit listener');

  calls = 0;
  const originalExitListeners = new Set(process.listeners('exit'));
  const load = await mockedStartLoad({ cpu: 1, io: 0, dir });
  const child = children.at(-1);
  const onParentExit = process.listeners('exit').find(listener => !originalExitListeners.has(listener));
  assert.equal(typeof onParentExit, 'function');
  const childExit = once(child, 'exit');
  onParentExit();
  assert.deepEqual(await childExit, [null, 'SIGKILL']);
  assert.deepEqual(await load.stop(), { children: 1, signals: ['SIGKILL'] });
  assert.equal(process.listenerCount('exit'), before);
});

test('COORD-1052: synchronous later spawn failure kills and reaps children already started', async (t) => {
  const realSpawn = require('node:child_process').spawn;
  const children = [];
  let calls = 0;
  const { startLoad: mockedStartLoad } = loadWithMockSpawn(t, (executable, args, options) => {
    calls += 1;
    if (calls === 1) {
      const child = realSpawn(executable, args, options);
      children.push(child);
      return child;
    }
    throw new Error('fixture later spawn failure');
  });
  t.after(async () => { await Promise.all(children.map(reapChild)); });
  const before = process.listenerCount('exit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord1052-load-spawn-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(mockedStartLoad({ cpu: 1, io: 1, dir }), /fixture later spawn failure/);
  assert.equal(calls, 2);
  assert.equal(children.length, 1);
  assert.equal(children[0].signalCode, 'SIGKILL', 'cleanup waits until the started child reports exit');
  assert.equal(children[0].exitCode, null);
  assert.equal(process.listenerCount('exit'), before, 'failed startup removes its parent-exit listener');
});


test('COORD-1052: load CLI reports a bounded observation and rejects missing directory input', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord1052-load-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, 'session-lifecycle-load.js');
  const result = spawnSync(process.execPath, [script, '--cpu', '0', '--io', '0', '--seconds', '1', '--dir', dir],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.seconds, 1);
  assert.equal(report.cpu, 0);
  assert.equal(report.io, 0);
  assert.deepEqual(report.stopped, { children: 0, signals: [] });
  assert.deepEqual(Object.keys(report.pressure).sort(), ['after', 'before', 'mid']);
  assert.deepEqual(fs.readdirSync(dir), []);
  const invalid = spawnSync(process.execPath, [script, '--dir'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--dir needs a path/);
  assert.equal(invalid.stdout, '');

  // Wait for the actual signal subscription, so the test never races startup.
  const preload = path.join(dir, 'observe-load-signal.cjs');
  fs.writeFileSync(preload, `process.on('newListener', event => {
    if (event === 'SIGTERM') setImmediate(() => process.send('ready'));
  });\n`);
  const { fork } = require('node:child_process');
  const interrupted = fork(script, ['--cpu', '1', '--seconds', '30', '--dir', dir], {
    execArgv: ['--require', preload], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => reapChild(interrupted));
  let output = '';
  interrupted.stdout.on('data', chunk => { output += chunk; });
  const closed = once(interrupted, 'close');
  const [ready] = await Promise.race([
    once(interrupted, 'message'),
    closed.then(([code, signal]) => assert.fail(`load exited before installing signal handlers: ${code} ${signal}`)),
  ]);
  assert.equal(ready, 'ready');
  interrupted.kill('SIGTERM');
  assert.deepEqual(await closed, [130, null]);
  assert.deepEqual(JSON.parse(output), { stoppedEarly: true, stopped: { children: 1, signals: ['SIGTERM'] } });
});
