import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import { COORD_DIR, LOCKS_DIR } from './coord-paths';
import { requireExternal } from './external-require';
import {
  activePlanEvidence,
  independentReviewView,
  type ActivePlanEvidence,
  type IndependentReviewProjection,
  type IndependentReviewScope,
  type IndependentReviewView,
  type ResolvedPlanEvidence
} from './plan-evidence.js';

/**
 * COORD-822 — server-side entry point for reading plan evidence. Loads the
 * canonical engine projection (the same module the `gov` CLI uses) and applies
 * it through the tested pure helper in ./plan-evidence.js.
 */
interface PlanEvidenceEngine {
  resolvePlanEvidence: (plan: Record<string, unknown>) => ResolvedPlanEvidence;
}

function loadEngine(): PlanEvidenceEngine {
  const paths = requireExternal<{ resolveEngineModule: (coordDir: string, relativePath: string) => string }>(
    path.join(COORD_DIR, 'paths.js')
  );
  return requireExternal<PlanEvidenceEngine>(
    paths.resolveEngineModule(COORD_DIR, 'scripts/plan-evidence-supersession.js')
  );
}

export function loadActivePlanEvidence(plan: Record<string, unknown> | null): ActivePlanEvidence {
  return activePlanEvidence(plan, (record) => loadEngine().resolvePlanEvidence(record));
}

/**
 * COORD-718 — independent reviews through the engine's projection and claimed
 * scope resolver (lock head, else landed source commit), exactly as `gov
 * explain` reads them.
 */
interface IndependentReviewEngine {
  projectIndependentReviews: (plan: Record<string, unknown>, options: Record<string, unknown>) => IndependentReviewProjection;
  readClaimedReviewScope: (input: Record<string, unknown>) => IndependentReviewScope | null;
}

function loadReviewEngine(): { engine: IndependentReviewEngine; repoRegistry: Record<string, string> } {
  const paths = requireExternal<{
    resolveEngineModule: (coordDir: string, relativePath: string) => string;
    createCoordPaths: () => { repoRegistry?: Record<string, string> };
  }>(path.join(COORD_DIR, 'paths.js'));
  let repoRegistry: Record<string, string> = {};
  try {
    repoRegistry = paths.createCoordPaths().repoRegistry || {};
  } catch {
    repoRegistry = {};
  }
  return {
    engine: requireExternal<IndependentReviewEngine>(paths.resolveEngineModule(COORD_DIR, 'scripts/independent-reviews.js')),
    repoRegistry
  };
}

export function loadIndependentReviews(
  plan: Record<string, unknown> | null,
  ticketId: string,
  board: Record<string, unknown>,
  row: { Repo?: string; Owner?: string; Status?: string } | null
): IndependentReviewView {
  const owner = row?.Owner && row.Owner !== 'unassigned' ? row.Owner : null;
  // The engine loads lazily inside the projection call, so a missing engine
  // fails closed in independentReviewView instead of breaking the page.
  return independentReviewView(plan, { scope: null, owner }, (record, options) => {
    const { engine, repoRegistry } = loadReviewEngine();
    const scope = engine.readClaimedReviewScope({ fs, path, locksDir: LOCKS_DIR, ticketId, board, repoCode: row?.Repo || 'X', repoRegistry, status: row?.Status, reviewSubmission: plan?.review_submission });
    return engine.projectIndependentReviews(record, { ...options, scope });
  });
}
