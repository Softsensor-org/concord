import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR, PROJECT_ROOT } from './coord-paths';
import { requireExternal } from './external-require';

// COORD-409 "/knowledge" — READ-ONLY memory / knowledge-compiler cockpit.
//
// This page reuses the canonical memory engine modules in coord/scripts. It
// intentionally does not rebuild indexes, run recall, or run the full memory
// eval on request. The web tier shows current cheap read-state plus the exact
// governed commands for expensive/derived evidence.

type KnowledgeCompiler = {
  COMPILER_CONTRACT: {
    name: string;
    purpose: string;
    producers: string[];
    consumers: string[];
    guardrail: string;
    vector_role: string;
  };
  CONTINUITY_LADDER: {
    states: string[];
    authoritative_states: string[];
    context_pack_states: string[];
    history_only_states: string[];
    robust_promotion_targets: string[];
  };
  DEFAULT_POLICY: {
    max_claims_per_ticket: number;
    max_claims_per_reviewer: number;
    extraction_precision_thresholds: Record<string, number>;
  };
};

type MemoryGraph = {
  buildContinuitySeed: (opts?: { rootDir?: string }) => {
    counts?: Record<string, number>;
    sparse_memory_warning?: boolean;
    missing_context?: Array<{ priority?: string; item?: string; reason?: string; source_type?: string }>;
    facts?: Array<{ id?: string; fact_type?: string; status?: string; statement?: string; ticket_id?: string | null }>;
  };
  checkDerivedIndexes: (opts?: { rootDir?: string }) => {
    memory_generation?: number;
    index_generation?: number;
    warnings?: Array<{ code?: string; message?: string; action?: string; source?: string }>;
  };
};

type MemoryClassification = {
  CLASS_NAMES: string[];
  SCOPE_NAMES: string[];
  READ_ONLY_MEMORY_CONTROL_ACTIONS: string[];
  WRITE_MEMORY_CONTROL_ACTIONS: string[];
};

type MemoryVector = {
  DEFAULT_DIM: number;
};

export interface KnowledgeModel {
  found: boolean;
  contract: {
    name: string;
    purpose: string;
    guardrail: string;
    vectorRole: string;
    producers: string[];
    consumers: string[];
  };
  ladder: {
    states: string[];
    contextPackStates: string[];
    authoritativeStates: string[];
    historyOnlyStates: string[];
    promotionTargets: string[];
  };
  counts: Record<string, number>;
  sparseMemoryWarning: boolean;
  missingContext: Array<{ priority: string; item: string; reason: string; sourceType: string }>;
  sampleFacts: Array<{ id: string; type: string; status: string; statement: string; ticketId: string | null }>;
  derivedIndexes: {
    memoryGeneration: number;
    indexGeneration: number;
    warnings: Array<{ code: string; message: string; action: string; source: string }>;
  };
  classification: {
    classes: string[];
    scopes: string[];
    readOnlyActions: string[];
    writeActions: string[];
  };
  eval: {
    cases: number;
    benchmarkPath: string;
    command: string;
    claimThresholds: Record<string, number>;
  };
  vector: {
    defaultDim: number;
    role: string;
    enabledByDefault: boolean;
  };
}

function enginePath(file: string): string {
  return path.join(COORD_DIR, 'scripts', file);
}

function readEvalCases(): number {
  try {
    const benchmarkPath = path.join(COORD_DIR, 'memory', 'eval', 'benchmark.json');
    const raw = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8')) as { cases?: unknown[] };
    return Array.isArray(raw.cases) ? raw.cases.length : 0;
  } catch {
    return 0;
  }
}

function emptyModel(): KnowledgeModel {
  return {
    found: false,
    contract: {
      name: 'Concord Knowledge Compiler',
      purpose: 'Gate source-backed claims before they become governed knowledge or ticket context.',
      guardrail: 'Memory recommends; governance decides; sources are cited; execution remains gated.',
      vectorRole: 'retrieval_view_only',
      producers: [],
      consumers: []
    },
    ladder: {
      states: [],
      contextPackStates: [],
      authoritativeStates: [],
      historyOnlyStates: [],
      promotionTargets: []
    },
    counts: {},
    sparseMemoryWarning: true,
    missingContext: [],
    sampleFacts: [],
    derivedIndexes: { memoryGeneration: 0, indexGeneration: 0, warnings: [] },
    classification: { classes: [], scopes: [], readOnlyActions: [], writeActions: [] },
    eval: {
      cases: 0,
      benchmarkPath: 'coord/memory/eval/benchmark.json',
      command: 'node coord/scripts/memory-eval.js --json',
      claimThresholds: {}
    },
    vector: { defaultDim: 0, role: 'retrieval_view_only', enabledByDefault: false }
  };
}

export function loadKnowledge(): KnowledgeModel {
  try {
    const compiler = requireExternal<KnowledgeCompiler>(enginePath('knowledge-claim-compiler.js'));
    const graph = requireExternal<MemoryGraph>(enginePath('memory-graph.js'));
    const classification = requireExternal<MemoryClassification>(enginePath('memory-classification.js'));
    const vector = requireExternal<MemoryVector>(enginePath('memory-vector.js'));

    const seed = graph.buildContinuitySeed({ rootDir: PROJECT_ROOT });
    const indexes = graph.checkDerivedIndexes({ rootDir: PROJECT_ROOT });

    return {
      found: true,
      contract: {
        name: compiler.COMPILER_CONTRACT.name,
        purpose: compiler.COMPILER_CONTRACT.purpose,
        guardrail: compiler.COMPILER_CONTRACT.guardrail,
        vectorRole: compiler.COMPILER_CONTRACT.vector_role,
        producers: Array.from(compiler.COMPILER_CONTRACT.producers || []),
        consumers: Array.from(compiler.COMPILER_CONTRACT.consumers || [])
      },
      ladder: {
        states: Array.from(compiler.CONTINUITY_LADDER.states || []),
        contextPackStates: Array.from(compiler.CONTINUITY_LADDER.context_pack_states || []),
        authoritativeStates: Array.from(compiler.CONTINUITY_LADDER.authoritative_states || []),
        historyOnlyStates: Array.from(compiler.CONTINUITY_LADDER.history_only_states || []),
        promotionTargets: Array.from(compiler.CONTINUITY_LADDER.robust_promotion_targets || [])
      },
      counts: seed.counts || {},
      sparseMemoryWarning: seed.sparse_memory_warning === true,
      missingContext: (seed.missing_context || []).map((m) => ({
        priority: String(m.priority || 'P2'),
        item: String(m.item || ''),
        reason: String(m.reason || ''),
        sourceType: String(m.source_type || '')
      })),
      sampleFacts: (seed.facts || []).slice(0, 8).map((f) => ({
        id: String(f.id || ''),
        type: String(f.fact_type || ''),
        status: String(f.status || ''),
        statement: String(f.statement || ''),
        ticketId: f.ticket_id ? String(f.ticket_id) : null
      })),
      derivedIndexes: {
        memoryGeneration: typeof indexes.memory_generation === 'number' ? indexes.memory_generation : 0,
        indexGeneration: typeof indexes.index_generation === 'number' ? indexes.index_generation : 0,
        warnings: (indexes.warnings || []).map((w) => ({
          code: String(w.code || ''),
          message: String(w.message || ''),
          action: String(w.action || ''),
          source: String(w.source || '')
        }))
      },
      classification: {
        classes: Array.from(classification.CLASS_NAMES || []),
        scopes: Array.from(classification.SCOPE_NAMES || []),
        readOnlyActions: Array.from(classification.READ_ONLY_MEMORY_CONTROL_ACTIONS || []),
        writeActions: Array.from(classification.WRITE_MEMORY_CONTROL_ACTIONS || [])
      },
      eval: {
        cases: readEvalCases(),
        benchmarkPath: 'coord/memory/eval/benchmark.json',
        command: 'node coord/scripts/memory-eval.js --json',
        claimThresholds: compiler.DEFAULT_POLICY.extraction_precision_thresholds || {}
      },
      vector: {
        defaultDim: vector.DEFAULT_DIM || 0,
        role: compiler.COMPILER_CONTRACT.vector_role,
        enabledByDefault: false
      }
    };
  } catch {
    return emptyModel();
  }
}
