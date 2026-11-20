import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { buildScreenIndex, type ScreenIndex } from './screen-index-core';
import {
  SCREEN_INDEX_PATH,
  FRONTEND_APPS_DIR,
  REQUIREMENTS_DOC_LABEL,
  REQUIREMENTS_PATH
} from './coord-paths';

export type { ScreenIndex, AppEntry, Screen, RequirementRef } from './screen-index-core';

export interface ScreenIndexResult {
  index: ScreenIndex;
  /** 'artifact' = read pre-generated file; 'derived' = computed in-memory. */
  origin: 'artifact' | 'derived';
}

function readArtifact(): ScreenIndex | null {
  try {
    const raw = fs.readFileSync(SCREEN_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ScreenIndex;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.apps)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// Read-only: prefer the generated artifact; if absent/invalid, derive the
// index in memory so the route always serves. Never writes (web-tier
// no-mutation invariant — generation is a separate explicit step).
export function loadScreenIndex(): ScreenIndexResult {
  const artifact = readArtifact();
  if (artifact) return { index: artifact, origin: 'artifact' };
  const index = buildScreenIndex({
    appsDir: FRONTEND_APPS_DIR,
    ursPath: REQUIREMENTS_PATH,
    ursDocLabel: REQUIREMENTS_DOC_LABEL,
    repoRelativeTo: path.resolve(FRONTEND_APPS_DIR, '..')
  });
  return { index, origin: 'derived' };
}
