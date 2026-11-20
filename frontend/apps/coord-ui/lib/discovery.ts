import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './coord-paths';

// COORD-408 "/discovery" — READ-ONLY view of the self-learning knowledge
// extraction. The business-discovery engine extracts knowledge from the existing
// repo into coord/.runtime/discovery/{run.json,synthesis.json}; this surfaces the
// persisted synthesis (no re-extraction) so non-developers can see "what coord
// learned about this codebase". Advisory/derived — never authority.

const DISCOVERY_DIR = path.join(RUNTIME_DIR, 'discovery');

export interface DiscoveryFact {
  id: string;
  kind: string;
  statement: string;
  confidence?: string;
  classification?: string;
}

export interface DiscoveryQuestion {
  id: string;
  statement: string;
}

export interface DiscoveryModel {
  found: boolean;
  generatedAt: string | null;
  project: { name: string; scope: string; repos: string[] };
  summary: {
    sources: number;
    facts: number;
    open_questions: number;
    decisions: number;
    workarounds: number;
    preservation_candidates: number;
    contradictions: number;
    graph_nodes: number;
    graph_edges: number;
  };
  byConfidence: Record<string, number>;
  byStatus: Record<string, number>;
  byAuthority: Record<string, number>;
  facts: DiscoveryFact[];
  openQuestions: DiscoveryQuestion[];
}

const FACT_LIMIT = 40;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const p = path.join(DISCOVERY_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function asRecord(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'number') out[k] = val;
  }
  return out;
}

const EMPTY: DiscoveryModel = {
  found: false,
  generatedAt: null,
  project: { name: '—', scope: '—', repos: [] },
  summary: {
    sources: 0,
    facts: 0,
    open_questions: 0,
    decisions: 0,
    workarounds: 0,
    preservation_candidates: 0,
    contradictions: 0,
    graph_nodes: 0,
    graph_edges: 0
  },
  byConfidence: {},
  byStatus: {},
  byAuthority: {},
  facts: [],
  openQuestions: []
};

export function loadDiscovery(): DiscoveryModel {
  const synthesis = readJson('synthesis.json');
  const run = readJson('run.json');
  if (!synthesis && !run) return EMPTY;

  const cockpit = (synthesis?.cockpit_readout as Record<string, unknown> | undefined) ?? {};
  const factConfidence = (cockpit.fact_confidence as Record<string, unknown> | undefined) ?? {};
  const graph = (synthesis?.context_graph as Record<string, unknown> | undefined) ?? {};
  const evidence = (synthesis?.evidence_classification as Record<string, unknown> | undefined) ?? {};
  const project = (run?.project as Record<string, unknown> | undefined) ?? {};

  const rawFacts = Array.isArray(factConfidence.facts) ? (factConfidence.facts as Record<string, unknown>[]) : [];
  const facts: DiscoveryFact[] = rawFacts.slice(0, FACT_LIMIT).map((f) => ({
    id: String(f.id ?? ''),
    kind: String(f.kind ?? ''),
    statement: String(f.statement ?? ''),
    confidence: f.confidence ? String(f.confidence) : undefined,
    classification: f.classification ? String(f.classification) : undefined
  }));

  const rawQuestions = Array.isArray(cockpit.open_questions)
    ? (cockpit.open_questions as Record<string, unknown>[])
    : [];
  const openQuestions: DiscoveryQuestion[] = rawQuestions.map((q) => ({
    id: String(q.id ?? ''),
    statement: String(q.statement ?? q.question ?? '')
  }));

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;

  return {
    found: true,
    generatedAt: (synthesis?.generated_at_utc as string) ?? (run?.generated_at_utc as string) ?? null,
    project: {
      name: String(project.name ?? 'discovered project'),
      scope: String(project.scope ?? ''),
      repos: Array.isArray(project.repos) ? (project.repos as unknown[]).map(String) : []
    },
    summary: {
      sources: Array.isArray(run?.sources) ? (run!.sources as unknown[]).length : 0,
      facts: rawFacts.length,
      open_questions: openQuestions.length,
      decisions: Array.isArray(cockpit.decisions) ? (cockpit.decisions as unknown[]).length : 0,
      workarounds: Array.isArray(cockpit.workarounds) ? (cockpit.workarounds as unknown[]).length : 0,
      preservation_candidates: Array.isArray(cockpit.preservation_candidates)
        ? (cockpit.preservation_candidates as unknown[]).length
        : 0,
      contradictions: Array.isArray(cockpit.contradictions) ? (cockpit.contradictions as unknown[]).length : 0,
      graph_nodes: nodes,
      graph_edges: edges
    },
    byConfidence: asRecord(factConfidence.by_confidence),
    byStatus: asRecord(factConfidence.by_status),
    byAuthority: asRecord((evidence as Record<string, unknown>).by_authority),
    facts,
    openQuestions
  };
}
