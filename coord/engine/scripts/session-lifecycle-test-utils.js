'use strict';
const fs = require('node:fs');
const os = require('node:os');

function fixedLayoutEnv(thread, inherited = process.env) {
  const env = { ...inherited, CODEX_THREAD_ID: thread };
  // These workers create their own backend/dev config. Only their child env
  // drops the caller's matrix override; production config resolution is intact.
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_CHANNEL_FD', 'COORD_SESSION_ID',
    'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'AGENT_THREAD_ID',
    'COORD_AGENT_ID', 'COORD_AGENT_HANDLE', 'COORD_OWNER', 'COORD_PROJECT_CONFIG']) {
    delete env[key];
  }
  return env;
}

// COORD-896: progress deadlines. A fixed wall-clock budget failed healthy lanes
// whenever host I/O was under pressure (single governance CLI calls measured at
// 18-54s with /proc/pressure/io full avg10 at 70-86%, ~1s when quiet; a ready
// phase of 10 steps ran past 240s at full avg10=77%). A phase now fails when it
// makes no progress for stallMs, or loadedStallMs while the host reports I/O or
// CPU pressure, and in every case at ceilingMs.
const PROGRESS_DEFAULTS = Object.freeze({ stallMs: 30000, loadedStallMs: 120000, ceilingMs: 600000, ioFullPressure: 10 });

function readHostLoad(read = file => fs.readFileSync(file, 'utf8'), cpus = os.cpus().length) {
  const text = file => { try { return read(file).trim().replace(/\s*\n\s*/g, ' | '); } catch { return null; } };
  const ioPressure = text('/proc/pressure/io'), loadavg = text('/proc/loadavg');
  const ioFullAvg10 = Number(/full avg10=([\d.]+)/.exec(ioPressure || '')?.[1] ?? NaN);
  const load1 = Number(/^[\d.]+/.exec(loadavg || '')?.[0] ?? NaN);
  return { ioPressure, ioFullAvg10, loadavg, load1, cpus };
}

function hostIsLoaded(host, ioFullPressure = PROGRESS_DEFAULTS.ioFullPressure) {
  return host.ioFullAvg10 >= ioFullPressure || host.load1 >= host.cpus;
}

function formatHost(host) {
  return `host: io_pressure=${host.ioPressure ?? 'unavailable'}; loadavg=${host.loadavg ?? 'unavailable'}; cpus=${host.cpus}; ` +
    `${hostIsLoaded(host) ? 'under' : 'not under'} I/O or CPU pressure`;
}

// One deadline per phase. progress() moves the stall window; the ceiling never moves.
function createProgressDeadline({ stallMs, loadedStallMs, ceilingMs, ioFullPressure, timers, now, readHost, onExpire }) {
  const started = now();
  let last = started, timer, stopped = false;
  const arm = due => { timer = timers.setTimeout(check, Math.max(1, due - now())); };
  function check() {
    const t = now(), idleMs = t - last, elapsedMs = t - started;
    if (elapsedMs >= ceilingMs) return expire({ reason: 'ceiling', idleMs, elapsedMs, host: readHost() });
    if (idleMs < stallMs) return arm(Math.min(last + stallMs, started + ceilingMs));
    const host = readHost();
    if (hostIsLoaded(host, ioFullPressure) && idleMs < loadedStallMs) return arm(Math.min(last + loadedStallMs, started + ceilingMs));
    return expire({ reason: 'stall', idleMs, elapsedMs, host });
  }
  function expire(info) { stopped = true; onExpire(info); }
  arm(started + Math.min(stallMs, ceilingMs)); // COORD-937: the ceiling is exact even when shorter than the stall limit
  return {
    progress() { last = now(); },
    stop() { if (!stopped) { stopped = true; timers.clearTimeout(timer); } },
  };
}

// Shared across lanes so any lane's failure reports every lane's position.
function createLaneTracker(options = {}) {
  const config = { ...PROGRESS_DEFAULTS, now: Date.now, readHost: readHostLoad, ...options };
  const lanes = new Map();
  const entry = lane => {
    if (!lanes.has(lane)) lanes.set(lane, { phase: 'spawned', since: config.now(), last: config.now(), step: null, steps: 0, maxGapMs: 0 });
    return lanes.get(lane);
  };
  // COORD-937: the largest silent gap per lane is the measured margin against the stall limit.
  const silence = e => { const t = config.now(); e.maxGapMs = Math.max(e.maxGapMs, t - e.last); return t; };
  return {
    config,
    phase(lane, phase) { const e = entry(lane); silence(e); e.phase = phase; e.since = e.last = config.now(); },
    progress(lane, message) { const e = entry(lane); const t = silence(e); e.step = message.step ?? null; e.steps++; e.last = t; },
    stats() {
      return Object.fromEntries([...lanes].map(([lane, e]) => [lane, { steps: e.steps, maxGapMs: e.maxGapMs, phase: e.phase }]));
    },
    describe(host) {
      const t = config.now();
      const rows = [...lanes].sort(([a], [b]) => a - b).map(([lane, e]) =>
        `  lane ${lane}: phase=${e.phase} last_step=${e.step ?? 'none'} steps=${e.steps} phase_elapsed=${t - e.since}ms idle=${t - e.last}ms`);
      return ['lane progress:', ...rows, formatHost(host)].join('\n');
    },
  };
}

function deadlineMessage(lane, type, tracker, { reason, idleMs, elapsedMs, host }) {
  const { stallMs, loadedStallMs, ceilingMs } = tracker.config;
  const head = reason === 'ceiling'
    ? `lane ${lane} did not emit ${type} within the ${ceilingMs}ms ceiling (still progressing; idle ${idleMs}ms)`
    : `lane ${lane} made no progress toward ${type} for ${idleMs}ms after ${elapsedMs}ms (stall limit ${stallMs}ms, ${loadedStallMs}ms under host pressure)`;
  return `${head}\n${tracker.describe(host)}`;
}

// Test-only IPC deadlines. A completion phase begins when its lane is released,
// not while it is parked behind another lane's preservation assertions. With a
// tracker the fixed timeoutMs is replaced by a progress deadline (COORD-896).
function waitForMessage(child, type, lane, timeoutMs = 30000, timers = globalThis, start, tracker) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer, deadline;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      deadline?.stop();
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      fn(value);
    };
    const onMessage = message => {
      if (tracker && message?.type === 'progress') { tracker.progress(lane, message); deadline?.progress(); }
      if (message?.type === type) { tracker?.phase(lane, type); finish(resolve, message); }
    };
    const onError = error => finish(reject, error);
    const onExit = code => finish(reject, new Error(`lane ${lane} exited before ${type} (code ${code})`));
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode);
      return;
    }
    const expire = error => {
      finish(reject, error);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    if (tracker) {
      tracker.phase(lane, `before ${type}`);
      deadline = createProgressDeadline({ ...tracker.config, timers,
        onExpire: info => expire(new Error(deadlineMessage(lane, type, tracker, info))) });
    } else {
      // COORD-952: a caller without a tracker still gets host load on expiry, so a
      // fixed budget that expires under I/O or CPU pressure is self-diagnosing.
      timer = timers.setTimeout(() => expire(new Error(`lane ${lane} did not emit ${type} within ${timeoutMs}ms; ${formatHost(readHostLoad())}`)), timeoutMs);
    }
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    try { start?.(onError); } catch (error) { onError(error); }
  });
}

function createLaneWaits(child, lane, timers = globalThis, tracker) {
  const ready = waitForMessage(child, 'ready', lane, 30000, timers, undefined, tracker);
  let done;
  return {
    ready,
    get done() { return done; },
    continue() {
      if (!done) {
        done = waitForMessage(child, 'done', lane, 30000, timers, onError => {
          // Subscribe before send: even an immediate reply must be observed.
          child.send('continue', error => { if (error) onError(error); });
        }, tracker);
      }
      return done;
    },
  };
}

module.exports = { waitForMessage, createLaneWaits, fixedLayoutEnv, PROGRESS_DEFAULTS, readHostLoad, hostIsLoaded,
  formatHost, createProgressDeadline, createLaneTracker, deadlineMessage };
