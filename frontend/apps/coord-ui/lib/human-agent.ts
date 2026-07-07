import 'server-only';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

type HumanAgentEngine = {
  buildHumanAgentPlatformModel: (opts?: Record<string, unknown>) => HumanAgentPlatformModel;
};

export interface HumanAgentPlatformModel {
  kind: string;
  schema_version: number;
  read_only_policy: { coord_ui_may_write: boolean; mutation_path: string };
  tranches: Array<{ id: string; name: string; status: string; capabilities: string[] }>;
  authoring: {
    statuses: string[];
    draft_intent: null | { verb: string; action: string; mutating: boolean; writer?: { queue_key?: string } };
    feedback_intent: null | { verb: string; action: string; mutating: boolean; writer?: { queue_key?: string } };
    grooming_pipeline: string[];
  };
  screen_bridge: {
    status: string;
    summary: { screens: number; mapped: number; unmapped: number };
    screens: Array<{
      id: string;
      title: string;
      route: string | null;
      mapped: boolean;
      requirement_refs: Array<{ anchor: string; text: string; confidence: string }>;
      feedback_intent: null | { verb: string; action: string; mutating: boolean };
      gap: string | null;
    }>;
    gaps: Array<{ screen_id: string; route: string | null; reason: string | null }>;
  };
  loop: {
    status: string;
    blockers: Array<{ code: string; questions?: string[]; required_role?: string }>;
    stages: Array<{
      id: string;
      name: string;
      actor: string;
      mode: string;
      input: string;
      output: string;
      governance: Record<string, unknown>;
    }>;
    evidence_return: { required: string[]; returned_to: string; route: string };
  };
  deployment: HostedControlPlaneTopology;
}

export interface HostedControlPlaneTopology {
  kind: string;
  schema_version: number;
  status: string;
  provider: string;
  data_light_contract: {
    valid: boolean;
    canonical_authority: string;
    control_plane_allowed_stores: string[];
    canonical_artifacts: string[];
  };
  isolation: {
    tenants: number;
    teams: number;
    coord_data_repos: number;
    sole_writer_per_repo: boolean;
    tenant_boundary: string;
  };
  readiness: {
    ready: boolean;
    blockers: number;
    warnings: number;
    gaps: Array<{ code: string; severity: string; message: string; scope: string }>;
  };
  tenants: Array<{
    id: string;
    name: string;
    cloud: string;
    identity_provider_configured: boolean;
    git_app_configured: boolean;
    conformance_attestation: boolean;
    teams: Array<{
      id: string;
      name: string;
      coord_data_repo: string;
      writer_id: string;
      read_cache: string;
    }>;
  }>;
  invariants: string[];
}

let cached: HumanAgentEngine | null = null;

function engine(): HumanAgentEngine {
  if (!cached) {
    cached = requireExternal<HumanAgentEngine>(path.join(COORD_DIR, 'scripts', 'human-agent-platform.js'));
  }
  return cached;
}

export function loadHumanAgentPlatform(): HumanAgentPlatformModel {
  try {
    return engine().buildHumanAgentPlatformModel({ board_id: 'coord-template' });
  } catch {
    return {
      kind: 'concord.human_agent.platform_model',
      schema_version: 1,
      read_only_policy: {
        coord_ui_may_write: false,
        mutation_path: 'unavailable'
      },
      tranches: [],
      authoring: {
        statuses: [],
        draft_intent: null,
        feedback_intent: null,
        grooming_pipeline: []
      },
      screen_bridge: {
        status: 'missing_screen_index',
        summary: { screens: 0, mapped: 0, unmapped: 0 },
        screens: [],
        gaps: []
      },
      loop: {
        status: 'unavailable',
        blockers: [],
        stages: [],
        evidence_return: { required: [], returned_to: '', route: '' }
      },
      deployment: {
        kind: 'concord.human_agent.hosted_control_plane_topology',
        schema_version: 1,
        status: 'unavailable',
        provider: '',
        data_light_contract: {
          valid: false,
          canonical_authority: '',
          control_plane_allowed_stores: [],
          canonical_artifacts: []
        },
        isolation: {
          tenants: 0,
          teams: 0,
          coord_data_repos: 0,
          sole_writer_per_repo: false,
          tenant_boundary: ''
        },
        readiness: {
          ready: false,
          blockers: 0,
          warnings: 0,
          gaps: []
        },
        tenants: [],
        invariants: []
      }
    };
  }
}
