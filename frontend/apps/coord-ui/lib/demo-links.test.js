// COORD-990: every COORD_DIR module the cockpit loads must resolve in the bundled
// demo: either a committed file under examples/demo/coord or a directory that
// scripts/run-demo.mjs links (DEMO_LINKS). A future cockpit module that needs an
// unlinked directory fails here, instead of returning 500 in a source checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_LINKS } from './demo-links.mjs';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(uiRoot, '../../..');
const demoCoord = path.join(repoRoot, 'examples/demo/coord');

function cockpitSources() {
  const files = [path.join(uiRoot, 'middleware.ts')];
  for (const dir of ['lib', 'app', 'components']) {
    const root = path.join(uiRoot, dir);
    if (!fs.existsSync(root)) continue;
    const walk = (abs) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(child); }
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.(js|mjs)$/.test(entry.name)) files.push(child);
      }
    };
    walk(root);
  }
  return files.filter((file) => fs.existsSync(file));
}

// COORD_DIR references, with the first path segment of each literal and whether
// the reference loads a module (a .js/.mjs file, or a module directory such as
// engine/scripts or scripts). Data reads (docs/decisions, board) are not modules.
// e.g. path.join(COORD_DIR, 'engine', 'scripts', 'x.js') -> segment 'engine', module.
function coordDirReferences() {
  const refs = [];
  const pattern = /COORD_DIR,\s*((?:'[^']*'\s*,?\s*)+)/g;
  for (const file of cockpitSources()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const literals = [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const joined = literals.join('/').split('/').filter(Boolean);
      if (joined.length === 0) continue;
      const segment = joined[0];
      const isModule = /\.m?js$/.test(joined[joined.length - 1]) || segment === 'engine' || segment === 'scripts';
      refs.push({ file: path.relative(repoRoot, file), segment, literal: match[1].trim(), isModule });
    }
  }
  return refs;
}

test('the scanner finds the engine module loads it is meant to guard', () => {
  const refs = coordDirReferences();
  assert.ok(refs.some((ref) => ref.isModule && ref.segment === 'engine'),
    'expected the cockpit to load COORD_DIR/engine/scripts modules; a vacuous scan would pass everything');
});

test('every DEMO_LINKS target exists in the repository', () => {
  for (const link of DEMO_LINKS) {
    assert.ok(fs.existsSync(path.resolve(demoCoord, link.target)), `missing link target ${link.target}`);
  }
});

test('every COORD_DIR path the cockpit loads is linked or committed in the demo', () => {
  const linked = new Set(DEMO_LINKS.map((link) => link.name));
  const unresolved = coordDirReferences().filter((ref) => ref.isModule &&
    !linked.has(ref.segment) && !fs.existsSync(path.join(demoCoord, ref.segment)));
  assert.deepEqual(unresolved.map((ref) => `${ref.file}: COORD_DIR, ${ref.literal}`), [],
    'add the directory to DEMO_LINKS (scripts/run-demo.mjs links it) or commit the file under examples/demo/coord');
});
