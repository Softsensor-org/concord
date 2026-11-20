import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_PATH, COORD_DIR } from './coord-paths';
import { requireExternal, uncacheExternal } from './external-require';
import { loadConfigView } from './config-view';
import { loadBoard } from './board';
import {
  buildResolvedView,
  loadTestingPolicyView,
  type ResolvedView,
  type TestingPolicyIo,
  type TestingPolicyPaths,
  type TestingPolicyView
} from './testing-policy-core';

/**
 * COORD-939 — READ-ONLY testing-policy views (data layer).
 *
 * Reads the engine testing policy, the adopter override (testPolicy block of
 * coord/project.config.js), the board's recorded ticket exceptions, the
 * scheduled-run decisions and promotion outcomes, and the existing Configuration
 * rows. The pure logic lives in ./testing-policy-core.js, which receives an `io`
 * with three read methods only. This file supplies those from fs.
 *
 * STRICTLY READ-ONLY: no write, no spawn, no fetch, no POST. Every change is a
 * governed command the views render (see governedChangeNote). The absence of a
 * mutation path is asserted by coord/engine/scripts/coord-ui-testing-policy-view.test.js
 * and by lib/testing-policy-core.test.js.
 */

const RUNTIME_TEST_POLICY_DIR = path.join(COORD_DIR, '.runtime', 'test-policy');
const POLICY_FILE = path.join(COORD_DIR, 'engine', 'test-policy.json');
const PROJECT_CONFIG_FILE = path.join(COORD_DIR, 'project.config.js');

const readIo: TestingPolicyIo = {
  exists: (file) => fs.existsSync(file),
  readText: (file) => fs.readFileSync(file, 'utf8'),
  listDir: (dir) => fs.readdirSync(dir)
};

const paths: TestingPolicyPaths = {
  policyFile: POLICY_FILE,
  boardFile: BOARD_PATH,
  decisionsFile: path.join(RUNTIME_TEST_POLICY_DIR, 'schedule-decisions.ndjson'),
  lastQualifiedFile: path.join(RUNTIME_TEST_POLICY_DIR, 'last-qualified.json'),
  runDir: RUNTIME_TEST_POLICY_DIR,
  join: (...parts: string[]) => path.join(...parts)
};

const GOVERNED_CHANGE_NOTE =
  'Read-only. The testing policy and the adopter override change only through a governed commit: ' +
  'edit coord/engine/test-policy.json (engine) or the testPolicy block of coord/project.config.js (adopter), ' +
  'commit through coord/scripts/gov commit, then check it with coord/scripts/gov test-policy show. ' +
  'Ticket exceptions are recorded with coord/scripts/gov test-policy except and need a human-admin override. ' +
  'This view does not propose, record or approve anything.';

function readAdopterOverride(): { override: Record<string, unknown> | null; overrideError: string | null } {
  if (!fs.existsSync(PROJECT_CONFIG_FILE)) return { override: null, overrideError: null };
  try {
    uncacheExternal(PROJECT_CONFIG_FILE);
    const raw = requireExternal<{ testPolicy?: unknown }>(PROJECT_CONFIG_FILE);
    const tp = raw && typeof raw.testPolicy === 'object' && raw.testPolicy !== null ? raw.testPolicy : null;
    return { override: tp as Record<string, unknown> | null, overrideError: null };
  } catch {
    return { override: null, overrideError: 'project.config.js could not be read' };
  }
}

export function loadTestingPolicy(): TestingPolicyView {
  const { override, overrideError } = readAdopterOverride();
  const config = loadConfigView();
  return loadTestingPolicyView({
    io: readIo,
    paths,
    override,
    overrideError,
    settings: config.settings,
    governedChangeNote: GOVERNED_CHANGE_NOTE
  });
}

export function loadResolvedPolicy(ref: string): ResolvedView | null {
  const board = loadBoard();
  const boardJson = readIo.exists(BOARD_PATH)
    ? (() => {
        try {
          return JSON.parse(readIo.readText(BOARD_PATH));
        } catch {
          return null;
        }
      })()
    : null;
  return buildResolvedView({
    ref,
    rows: board.rows.map((r) => ({ id: r.id, repo: r.repo ?? null, status: r.status ?? null })),
    boardJson,
    policyView: loadTestingPolicy()
  });
}
