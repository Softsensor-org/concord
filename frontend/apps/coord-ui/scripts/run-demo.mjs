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
console.log(`[demo] COORD_DIR = ${demoCoord}`);
console.log('[demo] cockpit on http://localhost:3002');

const child = spawn('npx', ['next', 'dev', '-p', '3002'], {
  stdio: 'inherit',
  cwd: uiRoot,
  env: { ...process.env, COORD_DIR: demoCoord },
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
