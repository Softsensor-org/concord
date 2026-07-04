import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR } from './coord-paths';
import { listEvents } from './events';
import { loadBoard } from './board';
import type { GovEvent } from './types';

/**
 * UI-007 — /cost operator view data surface.
 *
 * Server-only, strictly READ-ONLY. Mirrors the cost-ledger read path of
 * coord/scripts/token-economics.js (collectCostObservations / aggregateCost /
 * costReport) by reading the SAME inputs directly:
 *   - coord/.runtime/governance-events.ndjson  → `cost.observed` journal events
 *     (only result === "succeeded", exactly like collectCostObservations)
 *   - coord/product/model-prices.json           → the price table (display only)
 *   - coord/board/tasks.json (via loadBoard)     → ticket status for landed/done
 *
 * It RECORDS NOTHING. The web tier never calls `gov record-cost`, never mutates,
 * never spawns. We intentionally do NOT import token-economics.js: that module is
 * a factory wired to the full governance-mutation machinery (withGovernanceMutation,
 * ensureCurrentAgentIdentity, …), so re-deriving the pure read logic here keeps the
 * page free of any mutation surface while staying byte-faithful to its math.
 *
 * DETERMINISM: USD is summed then rounded to 6 dp (Math.round(x * 1e6) / 1e6) and
 * every bucket array is key-sorted — identical to aggregateCost — so identical
 * journal input yields identical totals and ordering, with no timestamps.
 */

const COST_EVENT_TYPE = 'cost.observed';

/** One cost.observed journal entry (the `details.cost` payload). */
export interface CostObservation {
  ticket: string;
  agent: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  estimated: boolean;
  pricedBy: string | null;
  phase: string | null;
}

export interface CostTotals {
  observations: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export type CostDimension = 'ticket' | 'agent' | 'model' | 'tier';

export interface CostBucket extends CostTotals {
  key: string;
  /** how many distinct observations were priced by the fallback (unknown model). */
  fallbackPriced: number;
}

/** A model row from the price table (display only; never used to re-cost). */
export interface PriceRow {
  model: string;
  input: number;
  output: number;
}

export interface PriceTable {
  /** false when the table file is absent/unreadable — the page calls this out. */
  present: boolean;
  /** coord-relative label of the source, or "builtin-default" when absent. */
  source: string;
  rows: PriceRow[];
  fallback: { input: number; output: number };
  currency: string;
  unit: string;
}

export interface CostLedger {
  /** total cost.observed events in scope (after the optional ticket filter). */
  totals: CostTotals;
  /** true when no observations exist at all — drives the zero state. */
  empty: boolean;
  ticketFilter: string | null;
  /** breakdowns, each deterministically key-sorted. */
  byTicket: CostBucket[];
  byAgent: CostBucket[];
  byModel: CostBucket[];
  byTier: CostBucket[];
  /** landed/done view: per-ticket cost limited to tickets whose status is done. */
  byLandedTicket: CostBucket[];
  /** count of observations whose model is unknown to the price table. */
  fallbackPricedCount: number;
  /** estimated (vs. explicit --usd) observation count. */
  estimatedCount: number;
  price: PriceTable;
}

// --- price table (display + missing-data flag) --------------------------------

const MODEL_PRICES_PATH = path.join(COORD_DIR, 'product', 'model-prices.json');
/** Built-in conservative fallback, mirrors token-economics.readModelPrices. */
const BUILTIN_FALLBACK = { input: 15.0, output: 75.0 };

function coordRel(p: string): string {
  const rel = path.relative(COORD_DIR, p).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? `coord/${rel}` : p;
}

export function loadPriceTable(): PriceTable {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(MODEL_PRICES_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    raw = null;
  }
  if (!raw) {
    // Missing/unreadable price data — surfaced explicitly, never crashes render.
    return {
      present: false,
      source: 'builtin-default',
      rows: [],
      fallback: { ...BUILTIN_FALLBACK },
      currency: 'USD',
      unit: 'per_1m_tokens'
    };
  }
  const models = (raw.models && typeof raw.models === 'object' ? raw.models : {}) as Record<
    string,
    { input?: unknown; output?: unknown }
  >;
  const rows: PriceRow[] = Object.entries(models)
    .map(([model, rate]) => ({
      model,
      input: Number(rate?.input),
      output: Number(rate?.output)
    }))
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const def = (raw.default && typeof raw.default === 'object' ? raw.default : null) as {
    input?: unknown;
    output?: unknown;
  } | null;
  const fallback = def
    ? { input: Number(def.input), output: Number(def.output) }
    : { ...BUILTIN_FALLBACK };
  return {
    present: true,
    source: coordRel(MODEL_PRICES_PATH),
    rows,
    fallback,
    currency: typeof raw.currency === 'string' ? raw.currency : 'USD',
    unit: typeof raw.unit === 'string' ? raw.unit : 'per_1m_tokens'
  };
}

// --- observations -------------------------------------------------------------

function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round like token-economics: 6 dp, hash-stable. */
function round6(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Collect cost.observed observations from the journal. Mirrors
 * collectCostObservations: only succeeded events with a cost.observed payload,
 * optional ticket filter. listEvents returns newest-first; we re-sort by ts then
 * a stable index so aggregation order never depends on file truncation.
 */
function collectObservations(filterTicket: string | null): CostObservation[] {
  // A generous limit so the cost picture is not silently truncated for the
  // (rare) journal that exceeds the default page size.
  const events: GovEvent[] = listEvents({ limit: 100000 });
  const out: CostObservation[] = [];
  for (const ev of events) {
    if (ev.result !== 'succeeded') continue;
    const details = ev.details as { event_type?: string; cost?: Record<string, unknown> } | undefined;
    if (!details || details.event_type !== COST_EVENT_TYPE || !details.cost) continue;
    const c = details.cost;
    const ticket = typeof c.ticket === 'string' ? c.ticket : '(none)';
    if (filterTicket && ticket !== filterTicket) continue;
    out.push({
      ticket,
      agent: typeof c.agent === 'string' ? c.agent : null,
      model: typeof c.model === 'string' ? c.model : null,
      inputTokens: toCount(c.input_tokens),
      outputTokens: toCount(c.output_tokens),
      usd: toCount(c.usd),
      estimated: c.usd_estimated === true,
      pricedBy: typeof c.priced_by === 'string' ? c.priced_by : null,
      phase: typeof c.phase === 'string' ? c.phase : null
    });
  }
  return out;
}

// --- tier resolution (deterministic, read-only) -------------------------------

const TIER_POLICY_PATH = path.join(COORD_DIR, 'product', 'tier-policy.json');
const BUILTIN_BY_PRI: Record<string, string> = {
  P0: 'critical',
  P1: 'critical',
  P2: 'standard',
  P3: 'standard'
};

/** Pri → tier map, data-driven from tier-policy.json with a safe builtin. */
function loadTierByPri(): { byPri: Record<string, string>; defaultTier: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(TIER_POLICY_PATH, 'utf8')) as Record<string, unknown>;
    const derivation = raw.derivation as { by_pri?: Record<string, string> } | undefined;
    const byPri = derivation?.by_pri && typeof derivation.by_pri === 'object' ? derivation.by_pri : BUILTIN_BY_PRI;
    const defaultTier = typeof raw.default_tier === 'string' ? raw.default_tier : 'standard';
    return { byPri, defaultTier };
  } catch {
    return { byPri: BUILTIN_BY_PRI, defaultTier: 'standard' };
  }
}

// --- aggregation --------------------------------------------------------------

function bucketKey(obs: CostObservation, dimension: CostDimension, tierOf: (ticket: string) => string): string {
  switch (dimension) {
    case 'agent':
      return obs.agent || '(unattributed)';
    case 'model':
      return obs.model || '(unknown)';
    case 'tier':
      return tierOf(obs.ticket);
    case 'ticket':
    default:
      return obs.ticket || '(none)';
  }
}

/**
 * Key-sorted aggregation, mirroring aggregateCost: sums tokens + usd, rounds usd
 * to 6 dp per bucket, sorts by key. `fallbackPriced` counts observations the
 * price table could not match (priced_by === "default"), so the page can flag
 * unknown-model spend without breaking.
 */
function aggregate(
  observations: CostObservation[],
  dimension: CostDimension,
  tierOf: (ticket: string) => string
): CostBucket[] {
  const buckets = new Map<string, CostBucket>();
  for (const obs of observations) {
    const key = bucketKey(obs, dimension, tierOf);
    let b = buckets.get(key);
    if (!b) {
      b = { key, observations: 0, inputTokens: 0, outputTokens: 0, usd: 0, fallbackPriced: 0 };
      buckets.set(key, b);
    }
    b.observations += 1;
    b.inputTokens += obs.inputTokens;
    b.outputTokens += obs.outputTokens;
    b.usd += obs.usd;
    if (obs.pricedBy === 'default') b.fallbackPriced += 1;
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, usd: round6(b.usd) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function sumTotals(observations: CostObservation[]): CostTotals {
  const t = observations.reduce(
    (acc, obs) => {
      acc.observations += 1;
      acc.inputTokens += obs.inputTokens;
      acc.outputTokens += obs.outputTokens;
      acc.usd += obs.usd;
      return acc;
    },
    { observations: 0, inputTokens: 0, outputTokens: 0, usd: 0 }
  );
  t.usd = round6(t.usd);
  return t;
}

/**
 * Build the full cost ledger view. `ticketFilter` narrows to a single ticket
 * (used by the ticket-detail → /cost?ticket=ID link). The empty-ledger case is
 * a first-class state: every breakdown is [] and the page renders a zero state.
 */
export function loadCostLedger(ticketFilter: string | null = null): CostLedger {
  const observations = collectObservations(ticketFilter);
  const price = loadPriceTable();

  // Resolve each ticket's tier deterministically from its board Pri.
  const board = loadBoard();
  const priByTicket = new Map<string, string>();
  const statusByTicket = new Map<string, string>();
  for (const row of board.rows) {
    if (row.priority) priByTicket.set(row.id, row.priority);
    statusByTicket.set(row.id, row.status);
  }
  const { byPri, defaultTier } = loadTierByPri();
  const tierOf = (ticket: string): string => {
    const pri = priByTicket.get(ticket);
    if (!pri) return `${defaultTier} (no pri)`;
    return byPri[pri] || defaultTier;
  };

  const totals = sumTotals(observations);
  const landedObservations = observations.filter((o) => statusByTicket.get(o.ticket) === 'done');

  return {
    totals,
    empty: observations.length === 0,
    ticketFilter,
    byTicket: aggregate(observations, 'ticket', tierOf),
    byAgent: aggregate(observations, 'agent', tierOf),
    byModel: aggregate(observations, 'model', tierOf),
    byTier: aggregate(observations, 'tier', tierOf),
    byLandedTicket: aggregate(landedObservations, 'ticket', tierOf),
    fallbackPricedCount: observations.filter((o) => o.pricedBy === 'default').length,
    estimatedCount: observations.filter((o) => o.estimated).length,
    price
  };
}
