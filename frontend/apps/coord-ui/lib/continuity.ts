import 'server-only';
import path from 'node:path';
import { COORD_DIR, PLAN_RECORDS_DIR, EVENT_LOG_PATH } from './coord-paths';
import { requireExternal } from './external-require';

// COORD_UI_CONTRACT "/continuity" — READ-ONLY continuity readout.
//
// Reuses the canonical continuity model (coord/scripts/continuity-cockpit-model.js
// `buildContinuityCockpitModel`, which itself reuses the engine's defined
// CONTINUITY_ARTIFACT_SHAPES) via requireExternal. The model reports the defined
// continuity object shapes plus an honest coverage scan of plan records and the
// journal — today that is "shapes defined, no records yet".

export interface ContinuityShape {
  shape: string;
  scope: string;
  warm_start_fields: string[];
  cold_finish_fields: string[];
}

export interface ContinuityRecord {
  ticket: string;
  warm_start: boolean;
  cold_finish: boolean;
}

export interface ContinuityEvent {
  command: string;
  ticket: string | null;
  recorded_at: string | null;
}

export interface ContinuityModel {
  summary: {
    defined_shapes: number;
    plan_records_scanned: number;
    with_warm_start: number;
    with_cold_finish: number;
    with_any_continuity: number;
    recent_events: number;
  };
  shapes: ContinuityShape[];
  records: ContinuityRecord[];
  recent_events: ContinuityEvent[];
  adoption_note: string | null;
}

type ContinuityEngine = {
  buildContinuityCockpitModel: (opts: { plansDir?: string; journalPath?: string }) => ContinuityModel;
};

let cached: ContinuityEngine | null = null;
function engine(): ContinuityEngine {
  if (!cached) {
    cached = requireExternal<ContinuityEngine>(
      path.join(COORD_DIR, 'scripts', 'continuity-cockpit-model.js')
    );
  }
  return cached;
}

export function loadContinuity(): ContinuityModel {
  try {
    return engine().buildContinuityCockpitModel({
      plansDir: PLAN_RECORDS_DIR,
      journalPath: EVENT_LOG_PATH
    });
  } catch {
    return {
      summary: {
        defined_shapes: 0,
        plan_records_scanned: 0,
        with_warm_start: 0,
        with_cold_finish: 0,
        with_any_continuity: 0,
        recent_events: 0
      },
      shapes: [],
      records: [],
      recent_events: [],
      adoption_note: 'Continuity model unavailable.'
    };
  }
}
