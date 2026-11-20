'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForMessage, createLaneWaits, fixedLayoutEnv, PROGRESS_DEFAULTS, readHostLoad, hostIsLoaded, formatHost,
  createLaneTracker } = require('./session-lifecycle-test-utils');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

test('COORD-757: fixed-layout child isolates config while ordinary children retain the caller override', () => {
  const coord = path.resolve(__dirname, '..', '..');
  const override = path.join(__dirname, '../../scripts/__fixtures__/project.config.nondefault.js');
  const inherited = { ...process.env, COORD_PROJECT_CONFIG: override, COORD_SESSION_ID: 'parent-session' };
  const before = { ...inherited };
  const env = fixedLayoutEnv('isolated-lane', inherited);
  assert.equal(env.COORD_PROJECT_CONFIG, undefined);
  assert.equal(env.COORD_SESSION_ID, undefined);
  assert.equal(env.CODEX_THREAD_ID, 'isolated-lane');
  assert.deepEqual(inherited, before, 'do not change the caller matrix or identity');
  const readConfigPath = childEnv => {
    const script = 'process.stdout.write(require(process.argv[1]).resolveProjectConfigPath(process.argv[2]))';
    const result = spawnSync(process.execPath, ['-e', script, path.join(coord, 'paths.js'), coord],
      { env: childEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(readConfigPath(env), path.join(coord, 'project.config.js'));
  assert.equal(readConfigPath(inherited), override, 'ordinary production resolver still honors matrix override');
});

function fixture() {
  let now = 0, next = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, delay) { const id = ++next; pending.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) { pending.delete(id); entry.fn(); }
      }
    },
    get count() { return pending.size; },
    now() { return now; },
  };
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, sends: 0, kills: 0,
    send(message, callback) { assert.equal(message, 'continue'); this.sends++; callback?.(null); },
    kill() { this.kills++; },
  });
  return { child, timers };
}
function cleaned(child, timers) {
  assert.equal(timers.count, 0);
  for (const name of ['message', 'error', 'exit']) assert.equal(child.listenerCount(name), 0, name);
}

test('COORD-757: delayed continuation does not spend completion budget; active hang still expires', async () => {
  const { child, timers } = fixture();
  const waits = createLaneWaits(child, 2, timers);
  child.emit('message', { type: 'ready' });
  await waits.ready;
  assert.equal(waits.done, undefined);
  timers.advance(30001);
  assert.equal(child.kills, 0, 'parked lane must not be killed by a completion timer');
  cleaned(child, timers);
  const done = waits.continue();
  const rejected = assert.rejects(done, /lane 2 did not emit done within 30000ms/);
  assert.equal(waits.continue(), done, 'continuation is idempotent');
  assert.equal(child.sends, 1);
  timers.advance(29999);
  assert.equal(child.kills, 0);
  timers.advance(1);
  await rejected;
  assert.equal(child.kills, 1);
  cleaned(child, timers);
});

test('COORD-757: continuation listener catches synchronous reply and ignores unrelated messages', async () => {
  const { child, timers } = fixture();
  const waits = createLaneWaits(child, 1, timers);
  child.emit('message', null);
  child.emit('message', { type: 'other' });
  assert.equal(timers.count, 1);
  child.emit('message', { type: 'ready' });
  await waits.ready;
  child.send = () => child.emit('message', { type: 'done', events: 42 });
  assert.equal((await waits.continue()).events, 42);
  timers.advance(30000);
  assert.equal(child.kills, 0);
  cleaned(child, timers);
});

test('COORD-757: readiness and explicit startup failure deadlines remain bounded', async () => {
  for (const ms of [30000, 3000]) {
    const { child, timers } = fixture();
    const ready = waitForMessage(child, 'ready', 1, ms, timers);
    const rejected = assert.rejects(ready, new RegExp(`within ${ms}ms`));
    timers.advance(ms - 1); assert.equal(child.kills, 0);
    timers.advance(1); await rejected;
    assert.equal(child.kills, 1); cleaned(child, timers);
  }
});

test('COORD-757: exit, signal, IPC error and send failures reject without leaking timers', async () => {
  for (const mode of ['exit', 'signal', 'error', 'throw', 'callback', 'already-exited']) {
    const { child, timers } = fixture();
    const waits = createLaneWaits(child, 3, timers);
    child.emit('message', { type: 'ready' }); await waits.ready;
    if (mode === 'already-exited') child.exitCode = 1;
    child.send = (_message, callback) => {
      if (mode === 'throw') throw new Error('send failed');
      if (mode === 'callback') callback(new Error('send failed'));
    };
    const done = waits.continue();
    const rejected = assert.rejects(done, /exited before done|send failed|IPC failed/);
    if (mode === 'exit' || mode === 'signal') {
      child.exitCode = mode === 'exit' ? 1 : null;
      child.signalCode = mode === 'signal' ? 'SIGTERM' : null;
      child.emit('exit', child.exitCode);
    }
    if (mode === 'error') child.emit('error', new Error('IPC failed'));
    await rejected; cleaned(child, timers);
  }
});

// COORD-896: progress deadlines, driven by the fake clock and fake lanes above.
const QUIET = Object.freeze({ ioPressure: 'some avg10=0.00 avg60=0.00 | full avg10=0.00 avg60=0.00', ioFullAvg10: 0,
  loadavg: '0.50 0.40 0.30 1/200 99', load1: 0.5, cpus: 8 });
const IO_BOUND = Object.freeze({ ...QUIET, ioPressure: 'some avg10=52.00 | full avg10=47.89', ioFullAvg10: 47.89 });
function lanes(count, host = QUIET, options = {}) {
  const timers = fixture().timers;
  const tracker = createLaneTracker({ now: timers.now, readHost: () => host, ...options });
  const all = Array.from({ length: count }, (_, i) => {
    const { child } = fixture();
    return { child, waits: createLaneWaits(child, i + 1, timers, tracker) };
  });
  // Advance in small steps so re-armed deadlines fire at their own times.
  const run = (ms, every = 0, lane = all[0], step = 'reconcile') => {
    for (let t = 1000; t <= ms; t += 1000) {
      timers.advance(1000);
      if (every && t % every === 0) lane.child.emit('message', { type: 'progress', step, steps: t / every });
    }
  };
  return { timers, tracker, all, run };
}

test('COORD-896: a stalled lane fails promptly at the stall limit on a quiet host', async () => {
  const { all: [one, two], run } = lanes(2);
  two.child.emit('message', { type: 'ready' }); await two.waits.ready;
  const rejected = assert.rejects(one.waits.ready, error => {
    assert.match(error.message, /^lane 1 made no progress toward ready for 30000ms after 40000ms \(stall limit 30000ms, 120000ms under host pressure\)/);
    return true;
  });
  run(10000, 10000);
  run(29000);
  assert.equal(one.child.kills, 0, 'not before the stall limit');
  run(1000);
  await rejected;
  assert.equal(one.child.kills, 1, 'the stalled lane is killed');
  assert.equal(two.child.kills, 0, 'a parked sibling is never charged for it');
});

test('COORD-896: a slow lane that keeps progressing passes, and parked time never counts toward completion', async () => {
  const { all: [one], run } = lanes(1);
  run(200000, 25000);
  one.child.emit('message', { type: 'ready' });
  await one.waits.ready;
  run(500000);
  const done = one.waits.continue();
  run(220000, 25000);
  one.child.emit('message', { type: 'done', events: 7 });
  assert.equal((await done).events, 7);
  assert.equal(one.child.kills, 0, 'slow progress is never a timeout');
});

test('COORD-896: a silent step under host I/O pressure gets the loaded stall limit, then still fails', async () => {
  const { all: [one], run } = lanes(1, IO_BOUND);
  const rejected = assert.rejects(one.waits.ready, /^Error: lane 1 made no progress toward ready for 120000ms after 120000ms/);
  run(119000);
  assert.equal(one.child.kills, 0, 'a loaded host extends a silent step');
  run(1000);
  await rejected;
  assert.equal(one.child.kills, 1);
});

test('COORD-896: a lane still progressing fails at its phase ceiling', async () => {
  assert.equal(PROGRESS_DEFAULTS.ceilingMs, 600000);
  const { all: [one], run } = lanes(1, QUIET, { ceilingMs: 240000 });
  const rejected = assert.rejects(one.waits.ready, /^Error: lane 1 did not emit ready within the 240000ms ceiling \(still progressing; idle 10000ms\)/);
  run(239000, 10000);
  assert.equal(one.child.kills, 0);
  run(1000, 10000);
  await rejected;
  assert.equal(one.child.kills, 1);
});

test('COORD-896: the deadline message reports every lane phase, step and elapsed time, and the host load', async () => {
  const { all: [one, two, three], run } = lanes(3, IO_BOUND);
  for (const lane of [one, two, three]) lane.child.emit('message', { type: 'progress', step: 'engine copy', steps: 1 });
  run(5000);
  two.child.emit('message', { type: 'ready' }); await two.waits.ready;
  three.child.emit('message', { type: 'ready' }); await three.waits.ready;
  const done = three.waits.continue();
  run(4000, 2000, three, 'land');
  let message = '';
  const rejected = assert.rejects(one.waits.ready, error => { message = error.message; return true; });
  run(111000, 0);
  await rejected;
  assert.deepEqual(message.split('\n'), [
    'lane 1 made no progress toward ready for 120000ms after 120000ms (stall limit 30000ms, 120000ms under host pressure)',
    'lane progress:',
    '  lane 1: phase=before ready last_step=engine copy steps=1 phase_elapsed=120000ms idle=120000ms',
    '  lane 2: phase=ready last_step=engine copy steps=1 phase_elapsed=115000ms idle=115000ms',
    '  lane 3: phase=before done last_step=land steps=3 phase_elapsed=115000ms idle=111000ms',
    'host: io_pressure=some avg10=52.00 | full avg10=47.89; loadavg=0.50 0.40 0.30 1/200 99; cpus=8; under I/O or CPU pressure',
  ]);
  const late = assert.rejects(done, /^Error: lane 3 made no progress toward done for 120000ms/);
  run(9000);
  await late;
});

test('COORD-896: host load is read from /proc and absence or CPU saturation is reported', () => {
  const files = { '/proc/pressure/io': 'some avg10=54.00 avg60=31.08\nfull avg10=47.89 avg60=27.68\n', '/proc/loadavg': '6.50 4.28 4.13 1/700 641275\n' };
  const host = readHostLoad(file => files[file], 8);
  assert.deepEqual(host, { ioPressure: 'some avg10=54.00 avg60=31.08 | full avg10=47.89 avg60=27.68', ioFullAvg10: 47.89,
    loadavg: '6.50 4.28 4.13 1/700 641275', load1: 6.5, cpus: 8 });
  assert.equal(hostIsLoaded(host), true);
  const none = readHostLoad(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, 2);
  assert.equal(none.ioPressure, null); assert.ok(Number.isNaN(none.ioFullAvg10)); assert.ok(Number.isNaN(none.load1));
  assert.equal(hostIsLoaded(none), false, 'an unreadable host is treated as quiet: the short stall limit applies');
  assert.equal(formatHost(none), 'host: io_pressure=unavailable; loadavg=unavailable; cpus=2; not under I/O or CPU pressure');
  assert.equal(hostIsLoaded({ ...QUIET, load1: 8 }), true, 'a run queue at the CPU count is CPU pressure');
  assert.equal(hostIsLoaded({ ...QUIET, ioFullAvg10: 9.99 }), false);
  assert.equal(typeof readHostLoad().cpus, 'number', 'the default reader works on this host');
  assert.deepEqual(Object.keys(PROGRESS_DEFAULTS), ['stallMs', 'loadedStallMs', 'ceilingMs', 'ioFullPressure']);
});

test('COORD-896: a real IPC lane that stops progressing is killed at its stall limit', async () => {
  const script = "process.send({ type: 'progress', step: 'reconcile', steps: 1 }); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const tracker = createLaneTracker({ stallMs: 500, loadedStallMs: 500, ceilingMs: 30000, readHost: () => QUIET });
  const started = Date.now();
  try {
    await assert.rejects(createLaneWaits(child, 1, globalThis, tracker).ready,
      /^Error: lane 1 made no progress toward ready for \d+ms[^]*lane 1: phase=before ready last_step=reconcile steps=1 /);
    assert.ok(Date.now() - started < 10000);
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    assert.equal(child.signalCode, 'SIGTERM', 'the hung lane is killed');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

// COORD-937: the tracker reports each lane's largest silent gap so burn-in runs can record measured margins.
test('COORD-937: the tracker records each lane largest silent gap between progress and phase changes', () => {
  let t = 0;
  const tracker = createLaneTracker({ now: () => t, readHost: () => QUIET });
  tracker.phase(1, 'before ready');
  t = 4000; tracker.progress(1, { step: 'a' });
  t = 5000; tracker.progress(1, { step: 'b' });
  t = 40000; tracker.phase(1, 'ready');
  assert.deepEqual(tracker.stats()[1], { steps: 2, maxGapMs: 35000, phase: 'ready' });
});

// COORD-937: the hard ceiling is exact even when it is shorter than the stall limit.
test('COORD-937: a progressing lane fails at a ceiling shorter than its stall limit, not at the next stall tick', async () => {
  const { child, timers } = fixture();
  const tracker = createLaneTracker({ now: timers.now, readHost: () => QUIET, stallMs: 30000, ceilingMs: 5000 });
  const ready = waitForMessage(child, 'ready', 1, 30000, timers, undefined, tracker);
  const rejected = assert.rejects(ready, /^Error: lane 1 did not emit ready within the 5000ms ceiling \(still progressing; idle 1000ms\)/);
  for (let t = 1000; t <= 4000; t += 1000) { timers.advance(1000); child.emit('message', { type: 'progress', step: 'x', steps: t / 1000 }); }
  assert.equal(child.kills, 0, 'not before the ceiling');
  timers.advance(999);
  assert.equal(child.kills, 0, 'not one millisecond early');
  timers.advance(1);
  await rejected;
  assert.equal(child.kills, 1);
  cleaned(child, timers);
});
