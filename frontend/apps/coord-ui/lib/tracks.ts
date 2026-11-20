import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

// COORD-414 "/tracks" — READ-ONLY multi-track governance profile.
//
// The UI mirrors the canonical track registry and track-evidence policy. It
// never classifies or mutates tickets from the web tier; ticket lifecycle still
// goes through `gov gate-plan` / `gov start` / closeout gates.

type TrackRegistry = {
  listTracks: () => Array<{
    name: string;
    gateProc?: string;
    defaultLane?: string;
    skills?: string[];
    reviewPolicy?: {
      approvers?: number;
      requiredArtifacts?: string[];
    };
    operator?: string;
    prefixes?: string[];
  }>;
  prefixToTrack: () => Record<string, string>;
};

interface EvidencePolicy {
  schema_version?: number;
  tracks?: Record<string, {
    required?: Array<{
      id?: string;
      label?: string;
      blocking_from?: string;
    }>;
  }>;
  bootstrap_overlay?: {
    high_risk_classes?: string[];
    required?: Array<{ id?: string; label?: string }>;
  };
}

export interface TrackProfile {
  name: string;
  gateProc: string;
  defaultLane: string;
  operator: string;
  prefixes: string[];
  skills: string[];
  approvers: number | null;
  requiredArtifacts: string[];
  evidence: Array<{ id: string; label: string; blockingFrom: string }>;
}

export interface TracksModel {
  found: boolean;
  sourcePaths: string[];
  sourceError: string | null;
  defaultTrack: string;
  prefixMap: Array<{ prefix: string; track: string }>;
  tracks: TrackProfile[];
  bootstrapOverlay: {
    highRiskClasses: string[];
    required: Array<{ id: string; label: string }>;
  };
  dataAnalytics: {
    gateProc: string;
    requiredArtifacts: string[];
    qualityChecks: string[];
    lifecycleInvariants: string[];
  };
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    // Preserve the existing UI contract: malformed or absent policy data is
    // represented as an empty policy while the registry remains available.
    return null;
  }
}

// COORD-867: track-registry moved to coord/engine/scripts; resolve through the engine resolver.
function enginePath(file: string): string {
  const paths = requireExternal<{ resolveEngineModule: (coordDir: string, relativePath: string) => string }>(
    path.join(COORD_DIR, 'paths.js')
  );
  return paths.resolveEngineModule(COORD_DIR, 'scripts/' + file);
}

function policyPath(): string {
  const paths = requireExternal<{ resolveEngineModule: (coordDir: string, relativePath: string) => string }>(
    path.join(COORD_DIR, 'paths.js')
  );
  return paths.resolveEngineModule(COORD_DIR, 'gates/track-evidence-policy.json');
}

function coordRelativePath(filePath: string): string {
  return path.relative(path.dirname(COORD_DIR), filePath).split(path.sep).join('/');
}

function normalizeEvidence(policy: EvidencePolicy, trackName: string): TrackProfile['evidence'] {
  return (policy.tracks?.[trackName]?.required || []).map((entry) => ({
    id: String(entry.id || ''),
    label: String(entry.label || ''),
    blockingFrom: String(entry.blocking_from || 'R4')
  }));
}

function normalizeTrack(track: ReturnType<TrackRegistry['listTracks']>[number], policy: EvidencePolicy): TrackProfile {
  return {
    name: track.name,
    gateProc: String(track.gateProc || 'test'),
    defaultLane: String(track.defaultLane || 'default'),
    operator: String(track.operator || ''),
    prefixes: (track.prefixes || []).map(String),
    skills: (track.skills || []).map(String),
    approvers: typeof track.reviewPolicy?.approvers === 'number' ? track.reviewPolicy.approvers : null,
    requiredArtifacts: (track.reviewPolicy?.requiredArtifacts || []).map(String),
    evidence: normalizeEvidence(policy, track.name)
  };
}

export function loadTracks(): TracksModel {
  let resolvedPolicyPath: string | null = null;
  try {
    const createTrackRegistry = requireExternal<() => TrackRegistry>(enginePath('track-registry.js'));
    const registry = createTrackRegistry();
    resolvedPolicyPath = policyPath();
    const policy = readJson<EvidencePolicy>(resolvedPolicyPath) || {};
    const prefixMap = Object.entries(registry.prefixToTrack())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([prefix, track]) => ({ prefix, track }));
    const tracks = registry.listTracks().map((track) => normalizeTrack(track, policy));
    const dataTrack = tracks.find((track) => track.name === 'data-analytics');

    return {
      found: true,
      sourcePaths: [
        'coord/engine/scripts/track-registry.js',
        'coord/engine/scripts/track-evidence-policy.js',
        coordRelativePath(resolvedPolicyPath),
        'coord/engine/scripts/data-contract-gate.js',
        'coord/engine/scripts/analytics-gate.js'
      ],
      sourceError: null,
      defaultTrack: 'development',
      prefixMap,
      tracks,
      bootstrapOverlay: {
        highRiskClasses: (policy.bootstrap_overlay?.high_risk_classes || []).map(String),
        required: (policy.bootstrap_overlay?.required || []).map((entry) => ({
          id: String(entry.id || ''),
          label: String(entry.label || '')
        }))
      },
      dataAnalytics: {
        gateProc: dataTrack?.gateProc || 'data-contract',
        requiredArtifacts: dataTrack?.requiredArtifacts || [],
        qualityChecks: [
          'row_count_positive',
          'required_columns',
          'no_duplicate_key',
          'currency_suffix',
          'reconciles_to',
          'reconciles_to_row_count',
          'baseline_metric',
          'key_coverage_with',
          'period_identity'
        ],
        lifecycleInvariants: ['certified_inputs', 'no_superseded_feed']
      }
    };
  } catch (error) {
    // Keep the diagnostic source list tied to a file that the resolver actually
    // found. A legacy-only install must not claim the engine path, and a missing
    // or colliding config must not be represented as an existing source.
    if (!resolvedPolicyPath) {
      try {
        resolvedPolicyPath = policyPath();
      } catch {
        // No policy file could be resolved, so there is no truthful file path
        // to report in the fallback model.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      found: false,
      sourcePaths: [
        // The registry path is deterministic and was the path attempted above;
        // a policy path is listed only when the resolver returned one.
        coordRelativePath(enginePath('track-registry.js')),
        ...(resolvedPolicyPath ? [coordRelativePath(resolvedPolicyPath)] : []),
      ],
      sourceError: message.split(COORD_DIR).join('coord'),
      defaultTrack: 'development',
      prefixMap: [],
      tracks: [],
      bootstrapOverlay: { highRiskClasses: [], required: [] },
      dataAnalytics: {
        gateProc: 'data-contract',
        requiredArtifacts: [],
        qualityChecks: [],
        lifecycleInvariants: []
      }
    };
  }
}
