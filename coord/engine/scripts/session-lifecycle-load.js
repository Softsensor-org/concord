#!/usr/bin/env node
'use strict';
// COORD-937: reproducible synthetic host pressure for the lifecycle gate-timeout verification.
//
// Usage:
//   node coord/engine/scripts/session-lifecycle-load.js --cpu <n> --io <n> --seconds <s> [--io-mib <n>] [--dir <path>]
//   --cpu <n>      n busy-loop child processes (run-queue pressure; a load average at or above the CPU
//                  count counts as CPU pressure in session-lifecycle-test-utils.js hostIsLoaded).
//   --io <n>       n child processes that repeatedly write --io-mib MiB and fsync it to --dir (I/O
//                  pressure; /proc/pressure/io full avg10 at or above 10 counts as I/O pressure).
//   --seconds <s>  run for s seconds, then stop every child and print one JSON line with the host
//                  pressure sampled before, midway and after. SIGINT and SIGTERM also stop the load.
// Children are killed when this process exits, and stop() removes the files they wrote.
// Calibration on the reference host is recorded in coord/docs/evidence/COORD-937-gate-timeout-burn-in.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readHostLoad } = require('./session-lifecycle-test-utils');

const CPU_CHILD = "process.stdout.write('started\\n');for(;;){}";
const IO_CHILD = [
  "const fs=require('node:fs'),path=require('node:path');",
  "const [dir,mib,tag]=process.argv.slice(1);const buf=Buffer.alloc(1<<20,7);",
  "const file=path.join(dir,'load-io-'+tag+'-'+process.pid+'.bin');let n=0;",
  "for(;;){const fd=fs.openSync(file,'w');for(let i=0;i<Number(mib);i++)fs.writeSync(fd,buf);",
  "fs.fsyncSync(fd);fs.closeSync(fd);if(++n===1)process.stdout.write('started\\n');}",
].join('');

const INTEGER_FLAGS = { '--cpu': 'cpu', '--io': 'io', '--seconds': 'seconds', '--io-mib': 'ioMib' };
function parseArgs(argv) {
  const opts = { cpu: 0, io: 0, seconds: 60, ioMib: 16, dir: os.tmpdir() };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--dir') { if (!value) throw new Error('--dir needs a path'); opts.dir = value; continue; }
    const key = INTEGER_FLAGS[flag];
    if (!key) throw new Error(`unknown argument ${flag}`);
    const number = Number(value);
    const minimum = key === 'seconds' || key === 'ioMib' ? 1 : 0;
    if (!Number.isInteger(number) || number < minimum) throw new Error(`${flag} must be an integer >= ${minimum}`);
    opts[key] = number;
  }
  return opts;
}

// Starts the children and resolves once each has reported it is running, so the caller
// knows the pressure exists before it measures anything.
async function startLoad({ cpu = 0, io = 0, dir = os.tmpdir(), ioMib = 16 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const specs = [
    ...Array.from({ length: cpu }, () => ['-e', CPU_CHILD]),
    ...Array.from({ length: io }, (_, i) => ['-e', IO_CHILD, dir, String(ioMib), String(i)]),
  ];
  const children = [];
  const ownedFiles = [];
  const exited = child => child.exitCode !== null || child.signalCode !== null;
  const onParentExit = () => { for (const child of children) if (!exited(child)) child.kill('SIGKILL'); };
  async function stop(signal = 'SIGTERM') {
    for (const child of children) if (!exited(child)) child.kill(signal);
    await Promise.all(children.map(child => exited(child) || !child.pid ? null : new Promise(resolve => child.once('exit', resolve))));
    process.removeListener('exit', onParentExit);
    for (const file of ownedFiles) fs.rmSync(file, { force: true });
    return { children: children.length, signals: children.map(child => child.signalCode) };
  }
  process.on('exit', onParentExit);
  try {
    const readiness = [];
    for (const args of specs) {
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      children.push(child);
      if (args[1] === IO_CHILD && child.pid) ownedFiles.push(path.join(dir, `load-io-${args[4]}-${child.pid}.bin`));
      const ready = new Promise((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`load child exited before starting (code ${code})`)));
      });
      // A later synchronous spawn failure still cleans earlier children without unhandled rejections.
      ready.catch(() => {});
      readiness.push(ready);
    }
    await Promise.all(readiness);
  } catch (error) {
    await stop('SIGKILL');
    throw error;
  }
  return { pids: children.map(child => child.pid), stop: () => stop() };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const sample = () => readHostLoad();
  const before = sample();
  const load = await startLoad(opts);
  const stopEarly = async () => { const stopped = await load.stop(); console.log(JSON.stringify({ stoppedEarly: true, stopped })); process.exit(130); };
  process.once('SIGINT', stopEarly);
  process.once('SIGTERM', stopEarly);
  const mid = await new Promise(resolve => setTimeout(() => resolve(sample()), opts.seconds * 500));
  await new Promise(resolve => setTimeout(resolve, opts.seconds * 500));
  const after = sample();
  const stopped = await load.stop();
  console.log(JSON.stringify({ cpu: opts.cpu, io: opts.io, ioMib: opts.ioMib, seconds: opts.seconds,
    pressure: { before, mid, after }, stopped }));
}

module.exports = { startLoad, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
