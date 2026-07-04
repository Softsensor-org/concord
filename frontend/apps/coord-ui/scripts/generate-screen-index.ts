// Screen/requirement-index generator.
// Reads frontend app sources + the URS doc, writes the derived artifact to
// coord/.runtime/screen-index.json. Read-only w.r.t. governance/URS/screens.
//
// Run:  npm run gen:screens   (from frontend/apps/coord-ui)
// Not in tsconfig `include`, so `.ts` import specifiers are intentional
// (executed by Node's native type stripping, never type-checked here).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  FRONTEND_APPS_DIR,
  REQUIREMENTS_DOC_LABEL,
  REQUIREMENTS_PATH,
  SCREEN_INDEX_PATH
} from '../lib/coord-paths.ts';
import { buildScreenIndex } from '../lib/screen-index-core.ts';

function gitSha(repoDir: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const repoRoot = path.resolve(FRONTEND_APPS_DIR, '..');
const index = buildScreenIndex({
  appsDir: FRONTEND_APPS_DIR,
  ursPath: REQUIREMENTS_PATH,
  ursDocLabel: REQUIREMENTS_DOC_LABEL,
  sourceCommit: gitSha(repoRoot),
  repoRelativeTo: repoRoot
});

fs.mkdirSync(path.dirname(SCREEN_INDEX_PATH), { recursive: true });
fs.writeFileSync(SCREEN_INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf8');

const screens = index.apps.reduce((n, a) => n + a.screens.length, 0);
const cov = index.requirements.coverage;
console.log(
  `screen-index: ${index.apps.length} apps, ${screens} screens; ` +
    `URS coverage ${cov.linked_anchors}/${cov.total_anchors} linked, ` +
    `${cov.unlinked_anchors.length} unlinked -> ${path.relative(repoRoot, SCREEN_INDEX_PATH)}`
);
