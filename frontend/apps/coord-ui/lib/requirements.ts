import 'server-only';
import path from 'node:path';
import { PROJECT_ROOT, COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

// COORD_UI_CONTRACT "/requirements" — READ-ONLY requirements-assurance index.
//
// Reuses the canonical requirements cockpit model from the gov engine
// (coord/scripts/requirements-cockpit-model.js `buildCockpitModel`). That model
// is a meta-cockpit: it enumerates the requirements-assurance views, which data
// sources each needs, whether those sources are present, and the copyable
// command to (re)generate each. We render it as a single guided landing that
// complements /urs (the document) and /screens (the index). The detailed
// /requirements/<view> sub-routes can be added later; their generate commands
// are surfaced here as copyable text (read-only — the web tier never executes).

export interface RequirementsView {
  id: string;
  route: string;
  title: string;
  copy_command: string;
  available: boolean;
  missing_sources: string[];
  source_status?: Array<{ path: string; exists: boolean; kind: string }>;
}

export interface RequirementsCockpitModel {
  found: boolean;
  views: RequirementsView[];
  summary: { views: number; available_views: number; missing_all_sources: number };
  read_only_policy: { web_tier_may_write: boolean; mutation_path: string };
}

type RequirementsEngine = {
  buildCockpitModel: (opts: {
    cwd?: string;
    dir?: string;
    generatedAtUtc?: string;
  }) => Omit<RequirementsCockpitModel, 'found'>;
};

let cached: RequirementsEngine | null = null;
function engine(): RequirementsEngine {
  if (!cached) {
    cached = requireExternal<RequirementsEngine>(
      path.join(COORD_DIR, 'scripts', 'requirements-cockpit-model.js')
    );
  }
  return cached;
}

export function loadRequirements(): RequirementsCockpitModel {
  try {
    const model = engine().buildCockpitModel({ cwd: PROJECT_ROOT, dir: '.' });
    return { found: true, ...model };
  } catch {
    return {
      found: false,
      views: [],
      summary: { views: 0, available_views: 0, missing_all_sources: 0 },
      read_only_policy: { web_tier_may_write: false, mutation_path: '' }
    };
  }
}

export function slugForRequirementRoute(route: string): string {
  return route.replace(/^\/requirements\/?/, '').replace(/\/$/, '') || 'index';
}

export function loadRequirementView(slug: string): (RequirementsView & { slug: string }) | null {
  const model = loadRequirements();
  const view = model.views.find((v) => slugForRequirementRoute(v.route) === slug);
  return view ? { ...view, slug } : null;
}
