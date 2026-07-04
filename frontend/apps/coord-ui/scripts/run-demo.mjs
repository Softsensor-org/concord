#!/usr/bin/env node
// Launches the cockpit against the bundled demo coord (examples/demo/coord) so
// `npm run demo` shows a populated board, traceability, and timeline on first run.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../coord-ui/scripts
const uiRoot = path.resolve(here, '..'); // .../coord-ui
const demoCoord = path.resolve(uiRoot, '../../../examples/demo/coord');

if (!fs.existsSync(demoCoord)) {
  console.error(`[demo] demo coord not found at ${demoCoord}`);
  process.exit(1);
}

// The cockpit loads several engine modules from `<COORD_DIR>/scripts/` (the
// path-boundary core, access core, token-economics, gate-proc-registry, ...).
// The demo coord ships a `scripts` symlink to the repo's real `coord/scripts`.
// On a clone where symlinks were not preserved (some Windows/CI checkouts),
// recreate it so `npm run demo` still works out of the box. Inert if present.
const demoScripts = path.join(demoCoord, 'scripts');
const realScripts = path.resolve(demoCoord, '../../../coord/scripts');
try {
  if (!fs.existsSync(demoScripts) && fs.existsSync(realScripts)) {
    fs.symlinkSync(path.relative(demoCoord, realScripts), demoScripts, 'dir');
    console.log('[demo] linked examples/demo/coord/scripts -> coord/scripts');
  }
} catch (err) {
  console.warn(`[demo] could not create scripts symlink (${err.message}); ` +
    'some cockpit views may not load. Create it manually: ' +
    'ln -s ../../../coord/scripts examples/demo/coord/scripts');
}

console.log(`[demo] COORD_DIR = ${demoCoord}`);
console.log('[demo] cockpit on http://localhost:3002');

const child = spawn('npx', ['next', 'dev', '-p', '3002'], {
  stdio: 'inherit',
  cwd: uiRoot,
  env: { ...process.env, COORD_DIR: demoCoord },
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
