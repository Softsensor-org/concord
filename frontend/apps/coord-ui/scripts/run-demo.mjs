#!/usr/bin/env node
// Launches the cockpit against the bundled demo coord (examples/demo/coord) so
// `npm run demo` shows a populated board, traceability, and timeline on first run.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_LINKS } from '../lib/demo-links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../coord-ui/scripts
const uiRoot = path.resolve(here, '..'); // .../coord-ui
const demoCoord = path.resolve(uiRoot, '../../../examples/demo/coord');

if (!fs.existsSync(demoCoord)) {
  console.error(`[demo] demo coord not found at ${demoCoord}`);
  process.exit(1);
}

// The cockpit loads engine modules from `<COORD_DIR>/scripts/` and
// `<COORD_DIR>/engine/scripts/` (middleware, lib/coord-paths). Git does not track
// copies of those trees (COORD-990): a source checkout links each DEMO_LINKS
// entry into the demo coord, and each release cut carries generated copies.
// Links are created here if missing; inert if present.
for (const link of DEMO_LINKS) {
  const demoLink = path.join(demoCoord, link.name);
  const realTarget = path.resolve(demoCoord, link.target);
  try {
    if (!fs.existsSync(demoLink) && fs.existsSync(realTarget)) {
      fs.symlinkSync(link.target, demoLink, 'dir');
      console.log(`[demo] linked examples/demo/coord/${link.name} -> ${link.target}`);
    }
  } catch (err) {
    console.warn(`[demo] could not create ${link.name} symlink (${err.message}); ` +
      'some cockpit views may not load. Create it manually: ' +
      `ln -s ${link.target} examples/demo/coord/${link.name}`);
  }
}

console.log(`[demo] COORD_DIR = ${demoCoord}`);
console.log('[demo] cockpit on http://localhost:3002');

// COORD-940: bind loopback explicitly (Next otherwise listens on all interfaces) and set the
// bind-scope marker that lets the edge middleware trust the local peer.
const child = spawn('npx', ['next', 'dev', '-H', '127.0.0.1', '-p', '3002'], {
  stdio: 'inherit',
  cwd: uiRoot,
  env: { ...process.env, COORD_DIR: demoCoord, COORD_UI_BIND_SCOPE: 'loopback' },
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
