import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_RECORDS_DIR } from './coord-paths';

// COORD-410 "/ticket gate-plan panel" — READ-ONLY. Renders the deterministic
// gate-plan receipt already recorded on the ticket's plan record
// (planState.gate_plan, produced by gov gate-plan), so the cockpit can answer
// "why this exact gate for this ticket": track, risk class, selected vs skipped
// gates with reasons, required evidence, and any fallback-to-full reason.

export interface GatePlanGate {
  id: string;
  kind?: string;
  command?: string;
  reason?: string;
}

export interface GatePlanReceipt {
  track: { name: string; gate_proc?: string; default_lane?: string; operator?: string } | null;
  riskClass: string;
  enforcement?: string;
  mode: string;
  selectedGates: GatePlanGate[];
  skippedGates: GatePlanGate[];
  requiredEvidence: string[];
  fallbackReason: string | null;
}

function normGate(x: Record<string, unknown>): GatePlanGate {
  return {
    id: String(x.id ?? ''),
    kind: x.kind ? String(x.kind) : undefined,
    command: x.command ? String(x.command) : undefined,
    reason: x.reason ? String(x.reason) : undefined
  };
}

export function loadGatePlan(ticketId: string): GatePlanReceipt | null {
  try {
    const file = path.join(PLAN_RECORDS_DIR, `${ticketId}.json`);
    if (!fs.existsSync(file)) return null;
    const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const g = plan.gate_plan as Record<string, unknown> | undefined;
    if (!g || typeof g !== 'object') return null;

    let track: GatePlanReceipt['track'] = null;
    if (g.track && typeof g.track === 'object') {
      const t = g.track as Record<string, unknown>;
      track = {
        name: String(t.name ?? ''),
        gate_proc: t.gate_proc ? String(t.gate_proc) : undefined,
        default_lane: t.default_lane ? String(t.default_lane) : undefined,
        operator: t.operator ? String(t.operator) : undefined
      };
    } else if (typeof g.track === 'string') {
      track = { name: g.track };
    }

    const affected = (g.affected_targets as Record<string, unknown> | undefined) ?? {};

    return {
      track,
      riskClass: String(g.risk_class ?? ''),
      enforcement: g.enforcement ? String(g.enforcement) : undefined,
      mode: String(affected.mode ?? g.mode ?? ''),
      selectedGates: Array.isArray(g.selected_gates) ? (g.selected_gates as Record<string, unknown>[]).map(normGate) : [],
      skippedGates: Array.isArray(g.skipped_gates) ? (g.skipped_gates as Record<string, unknown>[]).map(normGate) : [],
      requiredEvidence: Array.isArray(g.required_evidence) ? (g.required_evidence as unknown[]).map(String) : [],
      fallbackReason: g.fallback_reason ? String(g.fallback_reason) : null
    };
  } catch {
    return null;
  }
}
