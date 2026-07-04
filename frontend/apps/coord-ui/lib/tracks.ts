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
    return null;
  }
}

function enginePath(file: string): string {
  return path.join(COORD_DIR, 'scripts', file);
}

function policyPath(): string {
  return path.join(COORD_DIR, 'gates', 'track-evidence-policy.json');
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
  try {
    const createTrackRegistry = requireExternal<() => TrackRegistry>(enginePath('track-registry.js'));
    const registry = createTrackRegistry();
    const policy = readJson<EvidencePolicy>(policyPath()) || {};
    const prefixMap = Object.entries(registry.prefixToTrack())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([prefix, track]) => ({ prefix, track }));
    const tracks = registry.listTracks().map((track) => normalizeTrack(track, policy));
    const dataTrack = tracks.find((track) => track.name === 'data-analytics');

    return {
      found: true,
      sourcePaths: [
        'coord/scripts/track-registry.js',
        'coord/scripts/track-evidence-policy.js',
        'coord/gates/track-evidence-policy.json',
        'coord/scripts/data-contract-gate.js',
        'coord/scripts/analytics-gate.js'
      ],
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
  } catch {
    return {
      found: false,
      sourcePaths: ['coord/scripts/track-registry.js', 'coord/gates/track-evidence-policy.json'],
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
