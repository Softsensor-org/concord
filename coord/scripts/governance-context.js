"use strict";

const path = require("path");
const { createCoordPaths } = require("../paths.js");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const SCRIPTS_DIR = __dirname;
const COORD_DIR = path.dirname(SCRIPTS_DIR);
const ROOT_DIR = path.dirname(COORD_DIR);
const DEFAULT_PATHS = createCoordPaths({ coordDir: COORD_DIR, rootDir: ROOT_DIR });
// COORD-299: the two directory-lock paths default to the live coord/ tree but are
// resolved LIVE off `state` (see resolveAgentStateLockDir / resolveCoordStateLockDir)
// so the __testing.paths override can sandbox them at an os.tmpdir() dir, exactly
// like RUNTIME_DIR / GOVERNANCE_EVENT_LOCK_DIR. Without this, every test that takes
// the coord-state / agent-state lock wrote coord/.coord-state.lock /
// coord/.agent-state.lock into the LIVE tree (the shared-worktree friction).
const AGENT_STATE_LOCK_TIMEOUT_MS = 5000;
const AGENT_STATE_LOCK_STALE_MS = 60 * 1000;
const COORD_STATE_LOCK_TIMEOUT_MS = 5000;
const COORD_STATE_LOCK_STALE_MS = 60 * 1000;
const GOVERNANCE_EVENT_LOCK_TIMEOUT_MS = 30 * 1000;
const GOVERNANCE_EVENT_LOCK_STALE_MS = 2 * 60 * 1000;

const CONTINUITY_AUTHORITY_CONTRACT = Object.freeze({
  role: "continuity",
  certification: "not-certified-truth",
  rule: "continuity-is-owed-certification-is-earned",
  citation_use:
    "A nontrivial session may cite a warm-start or cold-finish artifact as advisory resume context, but must verify any truth claim against governed sources before treating it as authoritative.",
});

const DAILY_JOURNAL_AUTHORITY_CONTRACT = Object.freeze({
  role: "daily-journal",
  certification: "not-certified-truth",
  promotion_boundary:
    "Daily journal entries are scratch continuity only; they cannot create policy, requirements, business rules, ADRs, ticket state, or active memory without promotion through the owning governed artifact.",
  reuse_boundary:
    "Warm-start and durability-sweep tooling may use daily journal entries as advisory leads only after checking source freshness, sensitivity, and citations.",
});

const CADENCE_CURSOR_AUTHORITY_CONTRACT = Object.freeze({
  role: "cadence-cursor",
  certification: "not-certified-truth",
  ticket_boundary:
    "A cadence may advance its cursor as continuity state without becoming a feature ticket or changing board lifecycle status.",
  scheduler_boundary:
    "Phase 1 defines cadence/cursor schema and readouts only; it does not require a scheduler, daemon, or autonomous pull loop.",
  read_before_pull:
    "Before pulling a recurring source, read the cadence contract, cursor, source freshness policy, sensitivity policy, and last emitted evidence.",
});

const CONTINUITY_WRITE_SAFETY_CONTRACT = Object.freeze({
  append_only_records: "daily journals, decisions, and promotion candidates append new records or explicit superseding records; they never rewrite an existing record body in place",
  cursor_cas: "cadence cursor advancement must compare the caller's observed cursor generation before writing the next cursor",
  derived_view_hashes: "derived readouts carry input generation hashes and must be regenerated when canonical inputs change",
  stale_reread: "context-pack and cold-finish writers must fail closed when their observed source hashes no longer match current sources",
  single_writer_indexes: "shared continuity indexes are governed coord-state mutations and must run through the single-writer mutation path",
});

const DAILY_JOURNAL_ENTRY_FIELDS = Object.freeze([
  "date",
  "project_scope",
  "actor",
  "mode",
  "workstream",
  "observations",
  "dead_ends",
  "decisions_needed",
  "reuse_candidates",
  "promotion_candidates",
  "source_freshness",
  "sensitivity",
  "citations",
  "authority",
]);

const CADENCE_CURSOR_FIELDS = Object.freeze([
  "id",
  "owner",
  "frequency",
  "cursor",
  "freshness_policy",
  "inputs",
  "operation_class",
  "read_before_pull",
  "warm_start_required",
  "cold_finish_required",
  "last_run",
  "next_run",
  "blocked_on_decisions",
  "promotion_triggers",
  "authority",
]);

const DAILY_JOURNAL_MODES = Object.freeze([
  "scratch",
  "exploration",
  "audit_note",
  "cadence_note",
  "handoff_note",
  "durability_sweep_input",
]);

const CADENCE_OPERATION_CLASSES = Object.freeze([
  "scan",
  "audit",
  "refresh",
  "reconcile",
  "backfill",
  "campaign_follow_up",
  "audit_remediate_reaudit",
]);

const CADENCE_CURSOR_TYPES = Object.freeze([
  "source_version",
  "hash",
  "event_index",
  "timestamp",
  "query_bounds",
  "compound",
  "manual_checkpoint",
  "unknown",
]);

const CADENCE_FRESHNESS_STATUSES = Object.freeze([
  "fresh",
  "stale",
  "expired",
  "unknown",
  "blocked",
]);

const DURABILITY_SWEEP_INPUT_TYPES = Object.freeze([
  "daily_journal",
  "cold_finish",
  "decision",
  "cadence",
  "quality_scan",
  "scratch_output",
]);

const DURABILITY_SWEEP_PROMOTION_TYPES = Object.freeze([
  "ticket",
  "adr_proposal",
  "memory_claim",
  "cadence_object",
  "adapter_tool_consolidation",
  "stale_knowledge_demotion",
]);

const CONTINUITY_SENSITIVITY_CLASSES = Object.freeze([
  "public",
  "internal",
  "sensitive",
  "secret_prohibited",
]);

const WARM_START_FIELDS = Object.freeze([
  "prior_context",
  "stale_sources",
  "open_decisions",
  "cursor_state",
  "dead_ends",
  "prior_work",
  "source_refs",
  "verification_needed",
]);

const COLD_FINISH_FIELDS = Object.freeze([
  "changed",
  "learned",
  "failed",
  "promote_candidates",
  "invalidated",
  "human_decision_needed",
  "evidence_refs",
  "next_cursor",
]);

const CONTINUITY_ARTIFACT_SHAPES = Object.freeze({
  agent_session: Object.freeze({
    shape: "agent_session",
    scope: "one agent runtime session across zero or more governed actions",
    warm_start: WARM_START_FIELDS,
    cold_finish: COLD_FINISH_FIELDS,
    expected_sources: Object.freeze([
      "AGENTS.md/CODEX.md/CLAUDE.md/GEMINI.md",
      "coord/GOVERNANCE.md",
      "coord/scripts/gov explain <ticket> when ticket-scoped",
      "active plan/context artifacts",
      "recent governance events and session/cursor records",
    ]),
    optional_verbs: Object.freeze(["gov warm-start [<ticket>]", "gov cold-finish [<ticket>]"]),
  }),
  ticket: Object.freeze({
    shape: "ticket",
    scope: "one governed ticket from start/resume through handoff or closeout",
    warm_start: WARM_START_FIELDS,
    cold_finish: COLD_FINISH_FIELDS,
    expected_sources: Object.freeze([
      "current board row and prompt or waiver",
      "plan/prework/context-pack records",
      "ticket-local notes",
      "requirements, ADRs, questions, review cycles, repo gates, and feature proofs",
    ]),
    optional_verbs: Object.freeze(["gov warm-start <ticket>", "gov cold-finish <ticket>"]),
  }),
  scratch: Object.freeze({
    shape: "scratch",
    scope: "exploration residue that is useful but not yet durable knowledge",
    warm_start: WARM_START_FIELDS,
    cold_finish: COLD_FINISH_FIELDS,
    expected_sources: Object.freeze([
      "daily journal or scratch ledger",
      "source references and retrieval bounds",
      "classification and expiry/revisit cues",
    ]),
    optional_verbs: Object.freeze(["gov continuity scratch-start", "gov continuity scratch-finish"]),
  }),
  audit: Object.freeze({
    shape: "audit",
    scope: "read-only sweep, review, or quality/audit pass",
    warm_start: WARM_START_FIELDS,
    cold_finish: COLD_FINISH_FIELDS,
    expected_sources: Object.freeze([
      "audit target contract",
      "last audit readout",
      "known stale or skipped sources",
      "open findings, waivers, and prior false positives",
    ]),
    optional_verbs: Object.freeze(["gov continuity audit-start", "gov continuity audit-finish"]),
  }),
  cadence_run: Object.freeze({
    shape: "cadence_run",
    scope: "recurring scan, refresh, reconciliation, or campaign follow-up",
    warm_start: WARM_START_FIELDS,
    cold_finish: COLD_FINISH_FIELDS,
    expected_sources: Object.freeze([
      "cadence contract",
      "cursor state",
      "last source version, hash, event index, timestamp, or query bounds",
      "last emitted, skipped, promoted, or rejected records",
    ]),
    optional_verbs: Object.freeze(["gov continuity cadence-start <cadence>", "gov continuity cadence-finish <cadence>"]),
  }),
});

function continuityArtifactShapes() {
  return Object.keys(CONTINUITY_ARTIFACT_SHAPES);
}

function continuityArtifactShape(shape) {
  if (!Object.prototype.hasOwnProperty.call(CONTINUITY_ARTIFACT_SHAPES, shape)) {
    fail(`Unknown continuity artifact shape: ${shape}`);
  }
  return CONTINUITY_ARTIFACT_SHAPES[shape];
}

function buildContinuityArtifactTemplate(shape, phase) {
  const contract = continuityArtifactShape(shape);
  if (phase !== "warm_start" && phase !== "cold_finish") {
    fail(`Unknown continuity artifact phase: ${phase}`);
  }
  return {
    schema_version: "continuity-phase1/v1",
    shape: contract.shape,
    phase,
    scope: contract.scope,
    authority: CONTINUITY_AUTHORITY_CONTRACT,
    expected_sources: [...contract.expected_sources],
    optional_verbs: [...contract.optional_verbs],
    fields: [...contract[phase]],
  };
}

function buildDailyJournalEntryTemplate() {
  return {
    schema_version: "continuity-daily-journal/v1",
    shape: "daily_journal_entry",
    fields: [...DAILY_JOURNAL_ENTRY_FIELDS],
    modes: [...DAILY_JOURNAL_MODES],
    sensitivity_classes: [...CONTINUITY_SENSITIVITY_CLASSES],
    authority: DAILY_JOURNAL_AUTHORITY_CONTRACT,
    feeds: ["warm_start", "durability_sweep"],
    required_source_controls: [
      "source_freshness",
      "sensitivity",
      "citations",
    ],
  };
}

function buildCadenceCursorTemplate() {
  return {
    schema_version: "continuity-cadence-cursor/v1",
    shape: "cadence_cursor",
    fields: [...CADENCE_CURSOR_FIELDS],
    operation_classes: [...CADENCE_OPERATION_CLASSES],
    cursor_types: [...CADENCE_CURSOR_TYPES],
    freshness_statuses: [...CADENCE_FRESHNESS_STATUSES],
    authority: CADENCE_CURSOR_AUTHORITY_CONTRACT,
    phase1: {
      no_scheduler_or_daemon_required: true,
      persistence_boundary:
        "This helper defines schema/readout contracts; a future governed artifact may persist cadence records.",
      advance_boundary:
        "Cursor advancement records recurrence position and evidence, not feature-ticket lifecycle state.",
    },
    required_source_controls: [
      "freshness_policy",
      "inputs",
      "read_before_pull",
      "last_run",
      "blocked_on_decisions",
    ],
  };
}

function cadenceFreshnessStatus(cadence) {
  const explicit = cadence?.freshness_policy?.status || cadence?.cursor?.freshness || cadence?.freshness_status;
  if (CADENCE_FRESHNESS_STATUSES.includes(explicit)) return explicit;
  if (!cadence || !cadence.cursor || cadence.cursor.value === undefined || cadence.cursor.value === null || cadence.cursor.value === "") {
    return "unknown";
  }
  return "unknown";
}

function summarizeCadenceCursorState(cadencesInput) {
  const cadences = Array.isArray(cadencesInput) ? cadencesInput : [];
  if (cadences.length === 0) {
    return [
      {
        id: null,
        status: "unknown",
        stale_or_unknown: true,
        reason: "No cadence/cursor records supplied to warm-start; read governed cadence artifacts before recurring pulls.",
        read_before_pull: true,
      },
    ];
  }
  return cadences.map((cadence) => {
    const status = cadenceFreshnessStatus(cadence);
    const cursor = cadence?.cursor || {};
    return {
      id: cadence?.id || null,
      owner: cadence?.owner || null,
      frequency: cadence?.frequency || null,
      operation_class: cadence?.operation_class || null,
      cursor_type: cursor.type || "unknown",
      cursor_value: cursor.value === undefined ? null : cursor.value,
      status,
      stale_or_unknown: status !== "fresh",
      freshness_policy: cadence?.freshness_policy || null,
      read_before_pull: cadence?.read_before_pull !== false,
      warm_start_required: cadence?.warm_start_required !== false,
      blocked_on_decisions: cadence?.blocked_on_decisions || [],
      next_run: cadence?.next_run || null,
    };
  });
}

function stableContinuityStringify(value) {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "undefined" : primitive;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableContinuityStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableContinuityStringify(value[key])}`)
    .join(",")}}`;
}

function computeContinuityGenerationHash(value) {
  return `sha256:${crypto.createHash("sha256").update(stableContinuityStringify(value)).digest("hex")}`;
}

function continuityRecordId(record) {
  return record?.id || record?.record_id || record?.decision_id || record?.candidate_id || record?.event_id || null;
}

function annotateContinuityRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("continuity append-only records must be objects");
  }
  const id = continuityRecordId(record);
  if (!id) {
    fail("continuity append-only records require a stable id, record_id, decision_id, candidate_id, or event_id");
  }
  const canonical = {
    ...record,
    record_hash: record.record_hash || computeContinuityGenerationHash({
      ...record,
      record_hash: undefined,
    }),
  };
  if (options.requireAppendOnly !== false && canonical.replaces && !canonical.supersedes) {
    fail(`continuity record ${id} declares replaces without supersedes; append a superseding record instead of rewriting history`);
  }
  return canonical;
}

function mergeAppendOnlyContinuityRecords(existingInput, incomingInput, options = {}) {
  const existing = Array.isArray(existingInput) ? existingInput : [];
  const incoming = Array.isArray(incomingInput) ? incomingInput : [];
  const byId = new Map();
  const merged = [];
  for (const record of existing) {
    const annotated = annotateContinuityRecord(record, options);
    const id = continuityRecordId(annotated);
    if (byId.has(id)) {
      fail(`append-only continuity log already contains duplicate record id ${id}; repair the source before merging`);
    }
    byId.set(id, annotated);
    merged.push(annotated);
  }
  const appended = [];
  for (const record of incoming) {
    const annotated = annotateContinuityRecord(record, options);
    const id = continuityRecordId(annotated);
    const prior = byId.get(id);
    if (!prior) {
      byId.set(id, annotated);
      merged.push(annotated);
      appended.push(id);
      continue;
    }
    if (prior.record_hash !== annotated.record_hash) {
      fail(
        `append-only continuity conflict for ${id}: an existing journal/decision/promotion record has the same id with different content. ` +
        `Re-read the current continuity source, append a new superseding record id, and retry through the governed single-writer path.`
      );
    }
  }
  return {
    schema_version: "continuity-append-only-merge/v1",
    merged,
    appended,
    generation_hash: computeContinuityGenerationHash(merged),
    append_only: true,
    existing_count: existing.length,
    incoming_count: incoming.length,
    merged_count: merged.length,
  };
}

function advanceCadenceCursor(cadenceInput, cursorUpdate, runUpdate = {}) {
  if (!cadenceInput || typeof cadenceInput !== "object") {
    fail("cadence record is required");
  }
  if (!cadenceInput.id) {
    fail("cadence id is required");
  }
  const cursor = cursorUpdate || {};
  if (!cursor.type || !CADENCE_CURSOR_TYPES.includes(cursor.type)) {
    fail(`Unknown cadence cursor type: ${cursor.type || "<missing>"}`);
  }
  const observedCursorHash = computeContinuityGenerationHash(cadenceInput.cursor || null);
  const expectedCursorHash = runUpdate.expected_cursor_hash || runUpdate.expectedCursorHash || null;
  if (expectedCursorHash && expectedCursorHash !== observedCursorHash) {
    fail(
      `Stale cadence cursor for ${cadenceInput.id}: expected ${expectedCursorHash} but current cursor is ${observedCursorHash}. ` +
      `Re-read the cadence cursor and last-run evidence before advancing.`
    );
  }
  if (Object.prototype.hasOwnProperty.call(runUpdate, "expected_cursor_value")) {
    const currentValue = cadenceInput.cursor?.value === undefined ? null : cadenceInput.cursor.value;
    if (currentValue !== runUpdate.expected_cursor_value) {
      fail(
        `Stale cadence cursor for ${cadenceInput.id}: expected value ${JSON.stringify(runUpdate.expected_cursor_value)} but current value is ${JSON.stringify(currentValue)}. ` +
        `Re-read the cadence cursor and last-run evidence before advancing.`
      );
    }
  }
  const advanced = {
    ...cadenceInput,
    cursor: {
      type: cursor.type,
      value: cursor.value === undefined ? null : cursor.value,
      evidence_ref: cursor.evidence_ref || null,
      advanced_at_utc: runUpdate.advancedAtUtc || "1970-01-01T00:00:00.000Z",
    },
    last_run: runUpdate.last_run || {
      at_utc: runUpdate.advancedAtUtc || "1970-01-01T00:00:00.000Z",
      evidence_refs: runUpdate.evidence_refs || [],
      emitted: runUpdate.emitted || [],
      skipped: runUpdate.skipped || [],
      promoted: runUpdate.promoted || [],
      rejected: runUpdate.rejected || [],
    },
    next_run: runUpdate.next_run || cadenceInput.next_run || null,
    authority: CADENCE_CURSOR_AUTHORITY_CONTRACT,
    lifecycle_effect: "cursor_advanced_without_ticket_state_change",
  };
  advanced.previous_cursor_hash = observedCursorHash;
  advanced.generation_hash = computeContinuityGenerationHash({
    id: advanced.id,
    cursor: advanced.cursor,
    last_run: advanced.last_run,
    next_run: advanced.next_run,
  });
  return advanced;
}

function validateContinuityFreshRead(sourceSnapshotsInput, currentSourcesInput, options = {}) {
  const sourceSnapshots = Array.isArray(sourceSnapshotsInput) ? sourceSnapshotsInput : [];
  const currentSources = Array.isArray(currentSourcesInput) ? currentSourcesInput : [];
  const currentById = new Map(currentSources.map((source) => [source.id || source.path, source]));
  const stale = [];
  for (const snapshot of sourceSnapshots) {
    const id = snapshot?.id || snapshot?.path;
    if (!id) {
      stale.push({ id: null, reason: "snapshot is missing id/path" });
      continue;
    }
    const current = currentById.get(id);
    if (!current) {
      stale.push({ id, reason: "source no longer present; re-read current context before cold-finish" });
      continue;
    }
    const observedHash = snapshot.generation_hash || snapshot.hash || computeContinuityGenerationHash(snapshot.content ?? snapshot.value ?? snapshot);
    const currentHash = current.generation_hash || current.hash || computeContinuityGenerationHash(current.content ?? current.value ?? current);
    if (observedHash !== currentHash) {
      stale.push({ id, observed_hash: observedHash, current_hash: currentHash, reason: "source changed since observed" });
    }
  }
  const result = {
    schema_version: "continuity-fresh-read-check/v1",
    ok: stale.length === 0,
    stale,
    source_count: sourceSnapshots.length,
    guidance: stale.length === 0
      ? []
      : [
          "Re-read the listed context-pack, warm-start, cadence, or cold-finish sources.",
          "Regenerate the derived continuity readout from current sources.",
          "Retry the write through the governed single-writer path with the new generation hashes.",
        ],
  };
  if (!result.ok && options.throwOnStale) {
    fail(`Stale continuity context: ${stale.map((item) => item.id || "<unknown>").join(", ")}. ${result.guidance.join(" ")}`);
  }
  return result;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringifySweepValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    if (value.text) return stringifySweepValue(value.text);
    if (value.summary) return stringifySweepValue(value.summary);
    if (value.description) return stringifySweepValue(value.description);
    if (value.question) return stringifySweepValue(value.question);
    if (value.id) return stringifySweepValue(value.id);
    if (value.path) return stringifySweepValue(value.path);
    return JSON.stringify(value);
  }
  return String(value).trim();
}

function normalizedSweepKey(value) {
  return stringifySweepValue(value)
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function artifactSourceRefs(artifact, index) {
  const explicit = [
    ...asArray(artifact.citations),
    ...asArray(artifact.sources),
    ...asArray(artifact.source_refs),
    ...asArray(artifact.evidence_refs),
  ]
    .map(stringifySweepValue)
    .filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];
  if (artifact.path) return [String(artifact.path)];
  if (artifact.id) return [`${artifact.type || artifact.kind || "artifact"}:${artifact.id}`];
  return [`input:${index}`];
}

function collectSweepItems(artifact, fieldNames) {
  const values = [];
  for (const field of fieldNames) {
    for (const value of asArray(artifact[field])) {
      const text = stringifySweepValue(value);
      if (text) values.push(text);
    }
  }
  return values;
}

function addSweepOccurrence(map, kind, target, sourceRefs) {
  const normalized = normalizedSweepKey(target);
  if (!normalized) return;
  const key = `${kind}:${normalized}`;
  const existing = map.get(key) || {
    kind,
    target: stringifySweepValue(target),
    count: 0,
    source_refs: [],
  };
  existing.count += 1;
  existing.source_refs.push(...sourceRefs);
  existing.source_refs = [...new Set(existing.source_refs)];
  map.set(key, existing);
}

function dedupeSweepRecommendations(recommendations) {
  const byKey = new Map();
  for (const recommendation of recommendations) {
    const key = [
      recommendation.promotion_type,
      recommendation.category,
      normalizedSweepKey(recommendation.target),
      normalizedSweepKey(recommendation.reason),
    ].join(":");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...recommendation,
        source_refs: [...new Set(recommendation.source_refs || [])],
      });
      continue;
    }
    existing.source_refs = [...new Set([...(existing.source_refs || []), ...(recommendation.source_refs || [])])];
    existing.evidence_count = Math.max(existing.evidence_count || 0, recommendation.evidence_count || 0);
  }
  return [...byKey.values()].sort((a, b) => {
    const typeOrder = DURABILITY_SWEEP_PROMOTION_TYPES.indexOf(a.promotion_type) -
      DURABILITY_SWEEP_PROMOTION_TYPES.indexOf(b.promotion_type);
    if (typeOrder !== 0) return typeOrder;
    return `${a.category}:${a.target}`.localeCompare(`${b.category}:${b.target}`);
  });
}

function sweepRecommendation(promotionType, category, target, reason, sourceRefs, evidenceCount = sourceRefs.length) {
  if (!DURABILITY_SWEEP_PROMOTION_TYPES.includes(promotionType)) {
    fail(`Unknown durability sweep promotion type: ${promotionType}`);
  }
  return {
    promotion_type: promotionType,
    category,
    target: stringifySweepValue(target),
    reason,
    source_refs: [...new Set(sourceRefs)].filter(Boolean),
    evidence_count: evidenceCount,
    mutation_boundary:
      promotionType === "ticket"
        ? "ticket recommendations are read-only; file only through governed approval and a gov file-ticket path"
        : "recommendation only; promotion requires the governed owner for the target artifact",
  };
}

function buildContinuityDurabilitySweepReadout(artifactsInput, options = {}) {
  const artifacts = Array.isArray(artifactsInput) ? artifactsInput : [];
  const repeated = new Map();
  const recommendations = [];

  artifacts.forEach((artifactInput, index) => {
    const artifact = artifactInput && typeof artifactInput === "object" ? artifactInput : {};
    const type = artifact.type || artifact.kind || artifact.shape || "scratch_output";
    const sourceRefs = artifactSourceRefs(artifact, index);

    for (const item of collectSweepItems(artifact, ["dead_ends", "failed", "failures"])) {
      addSweepOccurrence(repeated, "dead_end", item, sourceRefs);
    }
    for (const item of collectSweepItems(artifact, ["re_pulls", "repulls", "source_pulls", "pulls"])) {
      addSweepOccurrence(repeated, "re_pull", item, sourceRefs);
    }
    for (const item of collectSweepItems(artifact, ["scripts", "tools", "adapters"])) {
      addSweepOccurrence(repeated, "tool", item, sourceRefs);
    }
    for (const item of collectSweepItems(artifact, ["manual_steps", "commands", "manual_commands"])) {
      addSweepOccurrence(repeated, "manual_step", item, sourceRefs);
    }

    const freshnessStatus = artifact.source_freshness?.status || artifact.freshness_policy?.status || artifact.freshness_status;
    if (["stale", "expired", "unknown", "blocked"].includes(freshnessStatus)) {
      recommendations.push(sweepRecommendation(
        "stale_knowledge_demotion",
        "source_freshness_uncertainty",
        artifact.id || artifact.path || `${type}:${index}`,
        `source freshness is ${freshnessStatus}`,
        sourceRefs,
      ));
    }
    for (const item of collectSweepItems(artifact, ["stale_sources", "invalidated", "superseded"])) {
      recommendations.push(sweepRecommendation(
        "stale_knowledge_demotion",
        "stale_or_invalidated_context",
        item,
        "continuity source marks this context stale, invalidated, or superseded",
        sourceRefs,
      ));
    }

    for (const item of collectSweepItems(artifact, ["decisions_needed", "open_decisions", "human_decision_needed", "blocked_on_decisions"])) {
      recommendations.push(sweepRecommendation(
        "adr_proposal",
        "pending_decision",
        item,
        "decision remains pending in continuity artifacts; promote to ADR proposal when high-impact, otherwise keep as scoped decision object",
        sourceRefs,
      ));
    }

    for (const item of collectSweepItems(artifact, ["reuse_candidates", "promotion_candidates", "promote_candidates"])) {
      recommendations.push(sweepRecommendation(
        "memory_claim",
        "reusable_artifact",
        item,
        "continuity artifact marks this as reusable or promotable; verify against governed sources before memory promotion",
        sourceRefs,
      ));
    }

    if (type === "cadence" || artifact.shape === "cadence_cursor" || artifact.cursor || artifact.next_run) {
      const status = cadenceFreshnessStatus(artifact);
      if (status !== "fresh" || artifact.read_before_pull !== false || asArray(artifact.blocked_on_decisions).length > 0) {
        recommendations.push(sweepRecommendation(
          "cadence_object",
          "cadence_cursor_review",
          artifact.id || artifact.path || `cadence:${index}`,
          `cadence cursor is ${status}; preserve read-before-pull, decision blockers, and next cursor before recurring work`,
          sourceRefs,
        ));
      }
    }
  });

  for (const occurrence of repeated.values()) {
    if (occurrence.count < (options.repeatThreshold || 2)) continue;
    if (occurrence.kind === "dead_end") {
      recommendations.push(sweepRecommendation(
        "ticket",
        "repeated_dead_end",
        occurrence.target,
        "same dead end appears in multiple continuity artifacts",
        occurrence.source_refs,
        occurrence.count,
      ));
    } else if (occurrence.kind === "re_pull") {
      recommendations.push(sweepRecommendation(
        "cadence_object",
        "repeated_re_pull",
        occurrence.target,
        "same source pull appears repeatedly; capture cursor, source freshness, and read-before-pull controls",
        occurrence.source_refs,
        occurrence.count,
      ));
    } else if (occurrence.kind === "tool") {
      recommendations.push(sweepRecommendation(
        "adapter_tool_consolidation",
        "duplicate_script_or_tool",
        occurrence.target,
        "same script, tool, or adapter appears repeatedly; consider consolidation or shared adapter ownership",
        occurrence.source_refs,
        occurrence.count,
      ));
    } else if (occurrence.kind === "manual_step") {
      recommendations.push(sweepRecommendation(
        "ticket",
        "repeated_manual_step",
        occurrence.target,
        "same manual step appears repeatedly; consider automation or documented runbook work",
        occurrence.source_refs,
        occurrence.count,
      ));
    }
  }

  const dedupedRecommendations = dedupeSweepRecommendations(recommendations);
  return {
    kind: "concord.continuity_durability_sweep_readout",
    schema_version: "continuity-durability-sweep/v1",
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    authority: CONTINUITY_AUTHORITY_CONTRACT,
    read_model: "read-only-continuity-artifacts",
    write_model: "promotion-recommendations-only",
    input_types: [...DURABILITY_SWEEP_INPUT_TYPES],
    promotion_types: [...DURABILITY_SWEEP_PROMOTION_TYPES],
    artifacts_read: artifacts.length,
    no_mutations_performed: true,
    ticket_filing_boundary:
      "This readout never files tickets by itself. Ticket recommendations require explicit human/governed approval and the governed ticket filing path.",
    recommendations: dedupedRecommendations,
    recommendation_count: dedupedRecommendations.length,
    source_cited: dedupedRecommendations.every((recommendation) => recommendation.source_refs.length > 0),
  };
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfPresent(filePath, maxChars = 4000) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function citation(id, label, filePath, available, extra = {}) {
  return {
    id,
    label,
    path: filePath || null,
    available: Boolean(available),
    ...extra,
  };
}

function normalizeTicketId(ticket) {
  const value = String(ticket || "").trim();
  if (!value) fail("ticket is required");
  return value;
}

function rootRelative(rootDir, filePath) {
  if (!filePath) return null;
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function findBoardRow(board, ticket) {
  const queue = [board];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value) continue;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value === "object") {
      if (value.ID === ticket || value.id === ticket) return value;
      queue.push(...Object.values(value));
    }
  }
  return null;
}

function promptPathFor(board, ticket, rootDir) {
  const fromMap = board && board.promptMap && board.promptMap[ticket];
  const rel = fromMap || path.join("coord", "prompts", "tickets", `${ticket}.md`);
  return path.resolve(rootDir, rel);
}

function summarizeQuestions(text, ticket) {
  if (!text) return { matching_lines: [], open_decisions: [] };
  const lines = text.split(/\r?\n/);
  const matchingLines = lines
    .map((line, index) => ({ line: line.trim(), line_number: index + 1 }))
    .filter((item) => item.line && (item.line.includes(ticket) || /decision|question|blocked|open/i.test(item.line)))
    .slice(0, 20);
  const openDecisions = matchingLines
    .filter((item) => /decision|decide|open|blocked|question/i.test(item.line))
    .slice(0, 10);
  return { matching_lines: matchingLines, open_decisions: openDecisions };
}

function recentJournalEvents(rootDir, ticket, limit = 8) {
  const journalPath = path.join(rootDir, "coord", ".runtime", "governance-events.ndjson");
  if (!fs.existsSync(journalPath)) {
    return { path: journalPath, events: [], missing_reason: "governance journal not present" };
  }
  const lines = fs.readFileSync(journalPath, "utf8").split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines.slice().reverse()) {
    if (!line.includes(ticket)) continue;
    try {
      const parsed = JSON.parse(line);
      events.push({
        event: parsed.event || parsed.type || parsed.action || "event",
        ticket: parsed.ticket || parsed.id || ticket,
        at: parsed.at || parsed.created_at || parsed.timestamp || null,
      });
    } catch {
      events.push({ event: "raw", ticket, at: null, line: line.slice(0, 240) });
    }
    if (events.length >= limit) break;
  }
  return { path: journalPath, events };
}

function requirementDocs(rootDir) {
  const productDir = path.join(rootDir, "coord", "product");
  if (!fs.existsSync(productDir)) return [];
  return fs.readdirSync(productDir)
    .filter((name) => /^[A-Z0-9_]+\.md$/.test(name))
    .sort()
    .map((name) => path.join(productDir, name));
}

function linkedAdrSummaries(rootDir, ticket, limit = 8) {
  const adrDir = path.join(rootDir, "coord", "docs", "decisions");
  if (!fs.existsSync(adrDir)) return [];
  return fs.readdirSync(adrDir)
    .filter((name) => /^[0-9]{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(adrDir, name);
      const body = fs.readFileSync(filePath, "utf8");
      if (!body.includes(ticket)) return null;
      const title = body.split(/\r?\n/).find((line) => line.startsWith("# ")) || name;
      const status = body.match(/\*\*Status:\*\*\s*([^\n]+)/i)?.[1]?.trim() || "unknown";
      return {
        id: name.replace(/\.md$/, ""),
        title: title.replace(/^#\s*/, ""),
        status,
        path: rootRelative(rootDir, filePath),
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function buildContinuityWarmStartBriefing(ticketInput, options = {}) {
  const ticket = normalizeTicketId(ticketInput);
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const boardPath = options.boardPath || path.join(rootDir, "coord", "board", "tasks.json");
  const board = readJsonIfPresent(boardPath);
  const boardRow = findBoardRow(board, ticket);
  const promptPath = options.promptPath || promptPathFor(board, ticket, rootDir);
  const planPath = options.planPath || path.join(rootDir, "coord", ".runtime", "plans", `${ticket}.json`);
  const legacyPlanPath = options.legacyPlanPath || path.join(rootDir, "coord", "board", "plans", `${ticket}.json`);
  const planRecord = readJsonIfPresent(planPath) || readJsonIfPresent(legacyPlanPath);
  const contextPackPath = options.contextPackPath || path.join(rootDir, "coord", ".runtime", "context-packs", `${ticket}.json`);
  const preworkPath = options.preworkPath || path.join(rootDir, "coord", ".runtime", "prework", `${ticket}.json`);
  const contextPack = options.contextPack || readJsonIfPresent(contextPackPath) || readJsonIfPresent(preworkPath);
  const questionsPath = options.questionsPath || path.join(rootDir, "coord", "QUESTIONS.md");
  const questionsText = readTextIfPresent(questionsPath, 20000);
  const questions = summarizeQuestions(questionsText, ticket);
  const journal = options.journalEvents || recentJournalEvents(rootDir, ticket, options.journalLimit || 8);
  const recallResult = options.recallResult || null;
  const govExplain = options.govExplain || null;
  const cadenceCursorState = summarizeCadenceCursorState(options.cadenceCursors);
  const adrs = options.linkedAdrs || linkedAdrSummaries(rootDir, ticket);
  const reqDocs = options.requirementDocs || requirementDocs(rootDir).map((filePath) => ({
    path: rootRelative(rootDir, filePath),
  }));

  const sources = [
    citation("gov_explain", "coord/scripts/gov explain output", null, Boolean(govExplain), {
      missing_reason: govExplain ? null : "not supplied to read-only briefing builder; run coord/scripts/gov explain <ticket> before planning",
    }),
    citation("board_row", "current board row", rootRelative(rootDir, boardPath), Boolean(boardRow), {
      missing_reason: boardRow ? null : "ticket was not found in board",
    }),
    citation("ticket_prompt", "ticket prompt", rootRelative(rootDir, promptPath), fs.existsSync(promptPath), {
      missing_reason: fs.existsSync(promptPath) ? null : "ticket prompt file not found",
    }),
    citation("plan_record", "active plan record", rootRelative(rootDir, fs.existsSync(planPath) ? planPath : legacyPlanPath), Boolean(planRecord), {
      missing_reason: planRecord ? null : "no plan record found in runtime or legacy plan location",
    }),
    citation("context_pack_or_prework", "context-pack/prework", rootRelative(rootDir, fs.existsSync(contextPackPath) ? contextPackPath : preworkPath), Boolean(contextPack), {
      missing_reason: contextPack ? null : "no context-pack/prework artifact found",
    }),
    citation("recall", "governed recall", null, Boolean(recallResult && recallResult.sources && recallResult.sources.length), {
      missing_reason: recallResult ? null : "recall result not supplied",
    }),
    citation("questions", "QUESTIONS.md", rootRelative(rootDir, questionsPath), Boolean(questionsText), {
      missing_reason: questionsText ? null : "QUESTIONS.md not found",
    }),
    citation("governance_journal", "recent governance events", rootRelative(rootDir, journal.path), journal.events.length > 0, {
      missing_reason: journal.events.length > 0 ? null : journal.missing_reason || "no recent events matched this ticket",
    }),
    citation("cadence_cursor", "cadence/cursor state", null, Boolean(options.cadenceCursors && options.cadenceCursors.length), {
      missing_reason: options.cadenceCursors && options.cadenceCursors.length ? null : "no cadence/cursor records supplied; warm-start cursor state is unknown",
    }),
  ];

  return {
    kind: "concord.continuity_warm_start_briefing",
    schema_version: "continuity-bridge-mvp/v1",
    ticket,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    authority: CONTINUITY_AUTHORITY_CONTRACT,
    read_model: "existing-governed-artifacts-only",
    sources,
    briefing: {
      gov_explain: govExplain,
      board_row: boardRow,
      ticket_prompt: readTextIfPresent(promptPath, 4000),
      plan_record: planRecord,
      context_pack: contextPack,
      recall: recallResult,
      linked_adrs: adrs,
      questions: questions.matching_lines,
      requirement_docs: reqDocs,
      recent_journal_events: journal.events,
      open_decisions: questions.open_decisions,
      cursor_state: cadenceCursorState,
    },
    missing_memory_surfaces: [
      "No canonical daily-journal store is required for this MVP; absence is reported instead of blocking warm-start.",
      "No cadence/cursor store is required for this MVP; absent cursor state is reported as unknown in warm-start.",
      "No standalone decision-object store is required for this MVP; open decisions are read from QUESTIONS.md, ADRs, plans, and context packs.",
    ],
    verification_needed: sources
      .filter((source) => !source.available)
      .map((source) => `${source.id}: ${source.missing_reason}`),
    stale_or_unknown_cursors: cadenceCursorState.filter((cursor) => cursor.stale_or_unknown),
  };
}

function buildContinuityColdFinishContract(ticketInput, options = {}) {
  const ticket = normalizeTicketId(ticketInput);
  return {
    kind: "concord.continuity_cold_finish_contract",
    schema_version: "continuity-bridge-mvp/v1",
    ticket,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    authority: CONTINUITY_AUTHORITY_CONTRACT,
    write_model: "existing-governed-outputs-first",
    no_new_continuity_store: true,
    governed_outputs: [
      { name: "plan_record_updates", path: `coord/.runtime/plans/${ticket}.json`, write_surface: "gov plan/prework/review lifecycle only" },
      { name: "review_cycles", path: "plan record review/self-review fields", write_surface: "gov review cycle commands" },
      { name: "questions_decisions_reflections", path: "coord/QUESTIONS.md or governed question/decision helpers", write_surface: "governed append/update path only" },
      { name: "adr_links_or_proposals", path: "coord/docs/decisions", write_surface: "gov adr link/new/proposal helpers" },
      { name: "feature_proofs", path: "plan record feature proof fields", write_surface: "governed proof evidence" },
      { name: "closeout_evidence", path: "board/plan closeout evidence", write_surface: "gov submit/finalize/land closeout paths" },
    ],
    required_finish_sections: [...COLD_FINISH_FIELDS],
    missing_memory_surfaces_policy:
      "Label absent daily-journal, cadence/cursor, and standalone decision-object stores honestly; do not block useful closeout when existing governed outputs can carry the handoff.",
  };
}

function buildPublicSafeContinuityPilotFixtures() {
  const recurringValidation = {
    id: "fixture.recurring-validation",
    title: "Generic recurring validation",
    scenario: "A weekly validation checks governed evidence for a reusable service adapter.",
    ticket: {
      ID: "VAL-001",
      Repo: "X",
      Type: "chore",
      Pri: "P2",
      Status: "doing",
      Owner: "agent-example",
      Description: "Validate that adapter evidence is current and that stale source warnings are visible before the next recurring pull.",
    },
    warm_start_records: [
      {
        type: "warm_start",
        id: "warm.VAL-001",
        source_refs: ["coord/scripts/gov explain VAL-001", "coord/.runtime/plans/VAL-001.json"],
        prior_context: ["Prior run verified schema coverage but skipped source freshness because the upstream export was unavailable."],
        stale_sources: ["adapter-schema-export older than freshness policy"],
        open_decisions: ["Decide whether skipped upstream export should block weekly validation."],
        cursor_state: [{ id: "cadence.validation.weekly", status: "stale", value: "export-hash:abc123" }],
        dead_ends: ["Rerunning the export without checking the cursor repeats stale data."],
        verification_needed: ["Read cadence cursor before pulling the adapter export."],
      },
    ],
    cold_finish_records: [
      {
        type: "cold_finish",
        id: "finish.VAL-000",
        evidence_refs: ["coord/.runtime/plans/VAL-000.json#feature-proof"],
        changed: ["Added source freshness warning to the validation readout."],
        learned: ["The weekly validation is useful only when it displays the last source hash and skipped-source reason."],
        failed: ["Manual export retry before cursor check."],
        promote_candidates: ["Create a cadence object for adapter validation."],
        next_cursor: { id: "cadence.validation.weekly", value: "export-hash:def456" },
      },
    ],
    daily_journals: [
      {
        type: "daily_journal",
        id: "journal.validation.2026-06-27",
        date: "2026-06-27",
        mode: "cadence_note",
        workstream: "adapter validation",
        observations: ["Validation can resume from last source hash and skip reason."],
        dead_ends: ["Do not rerun source pull before reading cursor."],
        decisions_needed: ["Owner must choose fail-open or fail-closed on unavailable source exports."],
        reuse_candidates: ["Surface source freshness in warm-start."],
        promotion_candidates: ["cadence.validation.weekly"],
        stale_sources: ["old export hash abc123"],
        source_freshness: { status: "stale" },
        citations: ["coord/.runtime/validation/adapter-weekly.json"],
      },
    ],
    decisions: [
      {
        id: "decision.validation-source-unavailable",
        status: "open",
        summary: "Whether unavailable source export blocks weekly validation.",
        owner: "operator",
        source_refs: ["coord/QUESTIONS.md#validation-source-unavailable"],
      },
    ],
    cadences: [
      {
        id: "cadence.validation.weekly",
        owner: "operator",
        frequency: "weekly",
        operation_class: "scan",
        cursor: { type: "hash", value: "export-hash:def456" },
        freshness_policy: { status: "stale", max_age: "7d" },
        inputs: ["adapter export", "plan evidence"],
        read_before_pull: true,
        warm_start_required: true,
        cold_finish_required: true,
        last_run: { at_utc: "2026-06-27T13:00:00.000Z", evidence_refs: ["coord/.runtime/validation/adapter-weekly.json"] },
        next_run: "2026-07-04T13:00:00.000Z",
        blocked_on_decisions: ["decision.validation-source-unavailable"],
      },
    ],
  };

  const auditRemediateReaudit = {
    id: "fixture.audit-remediate-reaudit",
    title: "Audit, remediate, re-audit",
    scenario: "A read-only audit finds a gap, a separate governed ticket remediates it, and the next audit verifies the fix without accepting findings from the readout.",
    ticket: {
      ID: "AUD-001",
      Repo: "X",
      Type: "feature",
      Pri: "P2",
      Status: "review",
      Owner: "agent-example",
      Description: "Re-audit generic evidence after a governed remediation ticket landed.",
    },
    warm_start_records: [
      {
        type: "warm_start",
        id: "warm.AUD-001",
        source_refs: ["coord/scripts/gov explain AUD-001", "coord/.runtime/audits/generic/latest.json"],
        prior_context: ["Previous audit found missing read-before-pull guidance."],
        stale_sources: ["pre-remediation audit readout"],
        open_decisions: ["Reviewer must decide whether the remediation evidence closes the finding."],
        cursor_state: [{ id: "cadence.audit.monthly", status: "fresh", value: "audit-event:42" }],
        verification_needed: ["Read the remediation ticket closeout before accepting the re-audit."],
      },
    ],
    cold_finish_records: [
      {
        type: "cold_finish",
        id: "finish.AUD-001",
        evidence_refs: ["coord/.runtime/audits/generic/reaudit.json"],
        changed: ["Re-audit readout now links remediation evidence and remaining decision."],
        learned: ["Readout can prove what changed while leaving acceptance to governed review."],
        failed: [],
        promote_candidates: ["Memory claim: audit readouts should show remediation evidence refs."],
        next_cursor: { id: "cadence.audit.monthly", value: "audit-event:43" },
      },
    ],
    daily_journals: [
      {
        type: "daily_journal",
        id: "journal.audit.2026-06-27",
        date: "2026-06-27",
        mode: "audit_note",
        workstream: "generic re-audit",
        observations: ["Remediation evidence exists; acceptance remains a governed review decision."],
        dead_ends: ["Do not mark finding closed from demo readout alone."],
        decisions_needed: ["Reviewer acceptance of remediation."],
        reuse_candidates: ["Use audit-remediate-reaudit structure for pilot demos."],
        promotion_candidates: ["Document audit readout command in UI contract."],
        source_freshness: { status: "fresh" },
        citations: ["coord/.runtime/audits/generic/reaudit.json"],
      },
    ],
    decisions: [
      {
        id: "decision.reaudit-acceptance",
        status: "open",
        summary: "Whether remediation evidence closes the audit finding.",
        owner: "reviewer",
        source_refs: ["coord/QUESTIONS.md#reaudit-acceptance"],
      },
    ],
    cadences: [
      {
        id: "cadence.audit.monthly",
        owner: "operator",
        frequency: "monthly",
        operation_class: "audit_remediate_reaudit",
        cursor: { type: "event_index", value: 43 },
        freshness_policy: { status: "fresh", max_age: "30d" },
        inputs: ["last audit", "remediation closeout", "re-audit evidence"],
        read_before_pull: true,
        warm_start_required: true,
        cold_finish_required: true,
        last_run: { at_utc: "2026-06-27T15:00:00.000Z", evidence_refs: ["coord/.runtime/audits/generic/reaudit.json"] },
        next_run: "2026-07-27T15:00:00.000Z",
        blocked_on_decisions: ["decision.reaudit-acceptance"],
      },
    ],
  };

  return {
    schema_version: "continuity-pilot-fixtures/v1",
    public_safe: true,
    privacy_boundary: "Generic fixture data only; no private project names, customer names, secrets, or proprietary source bodies.",
    fixtures: [recurringValidation, auditRemediateReaudit],
  };
}

function buildContinuityReadOnlyReadout(input = {}, options = {}) {
  const ticket = input.ticket || options.ticket || {};
  const ticketId = normalizeTicketId(ticket.ID || ticket.id || options.ticketId || "CONTINUITY-PILOT");
  const warmStartRecords = asArray(input.warm_start_records);
  const coldFinishRecords = asArray(input.cold_finish_records);
  const dailyJournals = asArray(input.daily_journals);
  const decisions = asArray(input.decisions);
  const cadences = asArray(input.cadences);
  const artifacts = [
    ...warmStartRecords,
    ...coldFinishRecords,
    ...dailyJournals,
    ...decisions.map((decision) => ({ ...decision, type: "decision", open_decisions: decision.status === "open" ? [decision.summary || decision.id] : [] })),
    ...cadences.map((cadence) => ({ ...cadence, type: "cadence" })),
    ...asArray(input.artifacts),
  ];
  const durabilitySweep = buildContinuityDurabilitySweepReadout(artifacts, {
    generatedAtUtc: options.generatedAtUtc,
  });
  const inputGenerationHash = computeContinuityGenerationHash({
    ticket,
    warm_start_records: warmStartRecords,
    cold_finish_records: coldFinishRecords,
    daily_journals: dailyJournals,
    decisions,
    cadences,
    artifacts: asArray(input.artifacts),
  });
  const cursorState = summarizeCadenceCursorState(cadences);
  const openDecisions = decisions
    .filter((decision) => !decision.status || ["open", "pending", "blocked"].includes(decision.status))
    .map((decision) => ({
      id: decision.id || null,
      summary: decision.summary || stringifySweepValue(decision),
      owner: decision.owner || null,
      source_refs: asArray(decision.source_refs || decision.citations).map(stringifySweepValue).filter(Boolean),
      change_command: "coord/scripts/gov log-question --resolved yes ...",
    }));
  const staleSources = artifacts.flatMap((artifact, index) =>
    collectSweepItems(artifact, ["stale_sources", "invalidated"]).map((source) => ({
      source,
      source_refs: artifactSourceRefs(artifact, index),
      change_command: "record remediation through the owning governed artifact or file a governed follow-up ticket",
    }))
  );
  const readBeforePullFindings = cursorState
    .filter((cursor) => cursor.read_before_pull || cursor.stale_or_unknown || cursor.blocked_on_decisions.length > 0)
    .map((cursor) => ({
      cadence_id: cursor.id,
      status: cursor.status,
      read_before_pull: cursor.read_before_pull,
      blocked_on_decisions: cursor.blocked_on_decisions,
      finding: cursor.stale_or_unknown
        ? "Read cadence contract, cursor, freshness policy, and last evidence before pulling the source."
        : "Read cadence contract and last evidence before pulling the next source.",
    }));

  const readout = {
    kind: "concord.continuity_read_only_readout",
    schema_version: "continuity-readout/v1",
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    ticket: ticketId,
    read_only: true,
    no_mutations_performed: true,
    authority: CONTINUITY_AUTHORITY_CONTRACT,
    write_safety: CONTINUITY_WRITE_SAFETY_CONTRACT,
    input_generation_hash: inputGenerationHash,
    regeneration_required_when_inputs_change: true,
    change_boundary: {
      statement: "This readout never changes board, plan, journal, decision, cadence, or memory state.",
      governed_commands_for_changes: [
        "coord/scripts/gov explain <ticket>",
        "coord/scripts/gov update-plan <ticket> --repo-gate ...",
        "coord/scripts/gov update-plan <ticket> --review-cycle ...",
        "coord/scripts/gov log-question ...",
        "coord/scripts/gov adr new|link|supersede ...",
        "coord/scripts/gov file-ticket ...",
      ],
    },
    summary: {
      warm_start_records: warmStartRecords.length,
      cold_finish_records: coldFinishRecords.length,
      daily_journal_entries: dailyJournals.length,
      open_decisions: openDecisions.length,
      active_cadences: cadences.length,
      stale_sources: staleSources.length,
      promotion_candidates: durabilitySweep.recommendations.length,
      read_before_pull_findings: readBeforePullFindings.length,
    },
    warm_start: {
      records: warmStartRecords,
      enough_to_resume:
        warmStartRecords.length > 0 &&
        (warmStartRecords.some((record) => asArray(record.source_refs).length > 0) || artifacts.some((artifact) => artifactSourceRefs(artifact, 0).length > 0)),
    },
    cold_finish: {
      records: coldFinishRecords,
      evidence_refs: [...new Set(coldFinishRecords.flatMap((record) => artifactSourceRefs(record, 0)))],
    },
    daily_journal_summary: dailyJournals.map((entry) => ({
      id: entry.id || null,
      date: entry.date || null,
      mode: entry.mode || null,
      workstream: entry.workstream || null,
      observations: asArray(entry.observations),
      dead_ends: asArray(entry.dead_ends),
      decisions_needed: asArray(entry.decisions_needed),
      promotion_candidates: asArray(entry.promotion_candidates),
      citations: artifactSourceRefs(entry, 0),
      authority: DAILY_JOURNAL_AUTHORITY_CONTRACT,
    })),
    open_decisions: openDecisions,
    active_cadences: cursorState,
    stale_sources: staleSources,
    promotion_candidates: durabilitySweep.recommendations,
    durability_sweep: durabilitySweep,
    read_before_pull_findings: readBeforePullFindings,
    cold_start_resume_proof: {
      verdict:
        warmStartRecords.length > 0 &&
        coldFinishRecords.length > 0 &&
        readBeforePullFindings.length > 0 &&
        durabilitySweep.recommendations.every((item) => item.source_refs.length > 0)
          ? "resume_without_rediscovery"
          : "needs_more_source_context",
      required_first_reads: [
        "AGENTS.md and tool shim",
        "coord/GOVERNANCE.md",
        `coord/scripts/gov explain ${ticketId}`,
        "listed warm-start source refs",
        "listed cold-finish evidence refs",
        "active cadence read-before-pull findings",
      ],
      yesterday_work_preserved_by: [
        "warm-start source refs",
        "cold-finish evidence refs",
        "daily journal summaries",
        "open decisions with owners",
        "cadence cursors",
        "durability-sweep recommendations",
      ],
    },
  };
  readout.generation_hash = computeContinuityGenerationHash({
    schema_version: readout.schema_version,
    ticket: readout.ticket,
    input_generation_hash: readout.input_generation_hash,
    summary: readout.summary,
    active_cadences: readout.active_cadences,
    stale_sources: readout.stale_sources,
    promotion_candidates: readout.promotion_candidates,
    read_before_pull_findings: readout.read_before_pull_findings,
  });
  return readout;
}

class GovernanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "GovernanceError";
  }
}

const state = {
  BOARD_PATH: DEFAULT_PATHS.boardPath,
  // COORD-220: coordination-state surfaces used by the out-of-band bypass detector.
  // Prompts live under coord/prompts; rendered board artifacts under coord/rendered.
  PROMPTS_DIR: path.join(COORD_DIR, "prompts"),
  RENDERED_DIR: DEFAULT_PATHS.renderedDir,
  PLAN_RECORDS_DIR: DEFAULT_PATHS.planRecordsDir,
  LEGACY_PLAN_RECORDS_DIR: DEFAULT_PATHS.legacyPlanRecordsDir,
  LOCKS_DIR: DEFAULT_PATHS.locksDir,
  LEGACY_LOCKS_DIR: DEFAULT_PATHS.legacyLocksDir,
  PLAN_PATH: DEFAULT_PATHS.planPath,
  QUESTIONS_PATH: DEFAULT_PATHS.questionsPath,
  TEMPLATE_FEEDBACK_PATH: path.join(COORD_DIR, "TEMPLATE_FEEDBACK.md"),
  AGENTS_PATH: DEFAULT_PATHS.agentsPath,
  LEGACY_AGENTS_PATH: DEFAULT_PATHS.legacyAgentsPath,
  AGENT_SESSIONS_PATH: DEFAULT_PATHS.agentSessionsPath,
  LEGACY_AGENT_SESSIONS_PATH: DEFAULT_PATHS.legacyAgentSessionsPath,
  RUNTIME_DIR: DEFAULT_PATHS.runtimeDir,
  GOVERNANCE_EVENT_LOG_PATH: DEFAULT_PATHS.governanceEventLogPath,
  GOVERNANCE_SNAPSHOT_PATH: DEFAULT_PATHS.governanceSnapshotPath,
  GOVERNANCE_SNAPSHOTS_DIR: DEFAULT_PATHS.governanceSnapshotsDir,
  GOVERNANCE_EVENT_LOCK_DIR: DEFAULT_PATHS.governanceEventLockDir,
  RUNTIME_ROLE_MARKER_PATH: path.join(DEFAULT_PATHS.runtimeDir, "runtime-role.json"),
  // COORD-299: overridable directory-lock paths + memory dir (sandboxable runtime).
  COORD_STATE_LOCK_DIR: DEFAULT_PATHS.coordStateLockDir,
  AGENT_STATE_LOCK_DIR: DEFAULT_PATHS.agentStateLockDir,
  MEMORY_DIR: path.join(COORD_DIR, "memory"),
  MODEL_PRICES_PATH: path.join(COORD_DIR, "product", "model-prices.json"),
  TIER_POLICY_PATH_OVERRIDE: null,
  agentStateLockDepth: 0,
  coordStateLockDepth: 0,
  governanceEventLockDepth: 0,
  activeGovernanceMutationContext: null,
};

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readRuntimeRoleMarker(markerPath = state.RUNTIME_ROLE_MARKER_PATH) {
  try {
    if (!markerPath || !fs.existsSync(markerPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function detectCheckoutRuntimeRole(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const coordDir = options.coordDir || COORD_DIR;
  const marker = options.marker === undefined ? readRuntimeRoleMarker(options.markerPath) : options.marker;
  const gitPath = path.join(rootDir, ".git");
  let role = "unknown";
  let reason = ".git metadata not found";
  let gitdir = null;
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      role = "canonical_integration_tree";
      reason = ".git is a directory";
      gitdir = gitPath;
    } else if (stat.isFile()) {
      const text = fs.readFileSync(gitPath, "utf8");
      const match = text.match(/gitdir:\s*(.+)/i);
      gitdir = match ? path.resolve(rootDir, match[1].trim()) : null;
      role = gitdir && /(?:^|[\\/])worktrees(?:[\\/]|$)/.test(gitdir)
        ? "ephemeral_worktree"
        : "linked_gitdir";
      reason = gitdir ? `.git file points to ${gitdir}` : ".git is a file";
    }
  } catch {
    // keep unknown
  }
  if (marker?.role === "ephemeral_worktree" || marker?.role === "canonical_integration_tree") {
    role = marker.role;
    reason = `runtime role marker ${marker.role}`;
  }
  return {
    role,
    reason,
    root_dir: rootDir,
    coord_dir: coordDir,
    gitdir,
    marker: marker || null,
  };
}

function canonicalAuthorityPaths(paths = state, coordDir = COORD_DIR) {
  const runtimeAuthorityPaths = [
    paths.GOVERNANCE_EVENT_LOG_PATH,
    paths.GOVERNANCE_SNAPSHOT_PATH,
    paths.GOVERNANCE_SNAPSHOTS_DIR,
    paths.PLAN_RECORDS_DIR,
  ].filter(Boolean);
  const runtimeAuthorityIsLive = runtimeAuthorityPaths.some((entry) => isPathInside(coordDir, entry));
  return [
    ...runtimeAuthorityPaths,
    // Tests often sandbox runtime/journal paths while leaving BOARD_PATH pointed
    // at the fixture checkout. Treat board as canonical-authority only when the
    // runtime authority paths are live too; real lifecycle mutations in a linked
    // worktree have both live and are blocked.
    runtimeAuthorityIsLive ? paths.BOARD_PATH : null,
  ].filter(Boolean);
}

function canonicalAuthorityWriteIssue(options = {}) {
  const role = options.role || detectCheckoutRuntimeRole(options);
  if (role.role !== "ephemeral_worktree") {
    return null;
  }
  const coordDir = options.coordDir || COORD_DIR;
  const paths = canonicalAuthorityPaths(options.paths || state, coordDir);
  const liveAuthorityPaths = paths
    .map((entry) => path.resolve(entry))
    .filter((entry) => isPathInside(coordDir, entry));
  if (liveAuthorityPaths.length === 0) {
    return null;
  }
  return {
    code: "ephemeral_canonical_authority_write",
    role,
    live_authority_paths: liveAuthorityPaths,
    message:
      "Refusing canonical governance-state mutation from an ephemeral linked worktree. " +
      "Run the mutation from the canonical integration tree, or record a land/merge-queue request and let the orchestrator serialize the canonical write.",
  };
}

function assertCanonicalAuthorityWriteAllowed(options = {}) {
  if (options.allowEphemeralAuthorityWrite === true) {
    return;
  }
  const issue = canonicalAuthorityWriteIssue(options);
  if (issue) {
    fail(`${issue.message} role=${issue.role.role}; paths=${issue.live_authority_paths.join(", ")}`);
  }
}

function fail(message) {
  throw new GovernanceError(message);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait. This CLI is short-lived and only uses this during brief lock contention.
  }
}

// COORD-223: canonical nested-lock acquisition order.
//
// Three process-coarse advisory locks guard governed coordination state. To make
// deadlock structurally impossible they MUST always be acquired outermost-first in
// one fixed total order, and a finer lock may never wrap a coarser one:
//
//   1. governance-runtime  (withGovernanceRuntimeLock) — outermost; serializes the
//      whole journaled mutation (held by withGovernanceMutation).
//   2. coord-state         (withCoordStateLock)        — board/plan/render writes
//      INSIDE a mutation body.
//   3. agent-state         (withAgentStateLock)        — innermost; agent registry /
//      session lease writes.
//
// Lower rank = coarser = acquired first. The invariant: acquiring a FRESH lock of
// rank R is illegal while any STRICTLY-FINER lock (rank > R) is already held, because
// that is the out-of-order acquisition that lets two callers deadlock. Re-entrant
// re-acquisition of an already-held lock is always fine (depth counter). Acquiring a
// finer lock while holding a coarser one is the canonical, allowed nesting.
//
// This is a fail-closed assertion, not a scheduler: it codifies the order that the
// code already follows and turns any future inversion into an immediate, loud error
// instead of an intermittent production deadlock.
const LOCK_RANKS = {
  "governance-runtime": 1,
  "coord-state": 2,
  "agent-state": 3,
};

function lockRankDepth(rank) {
  switch (rank) {
    case 1:
      return state.governanceEventLockDepth;
    case 2:
      return state.coordStateLockDepth;
    case 3:
      return state.agentStateLockDepth;
    default:
      return 0;
  }
}

function lockNameForRank(rank) {
  return Object.keys(LOCK_RANKS).find((name) => LOCK_RANKS[name] === rank) || `rank-${rank}`;
}

// Returns the names of any strictly-finer locks currently held. A non-empty result
// means a fresh acquisition at `rank` would invert the canonical order.
function finerLocksHeld(rank) {
  const held = [];
  for (const finerRank of Object.values(LOCK_RANKS)) {
    if (finerRank > rank && lockRankDepth(finerRank) > 0) {
      held.push(lockNameForRank(finerRank));
    }
  }
  return held;
}

function assertLockOrder(name) {
  const rank = LOCK_RANKS[name];
  if (rank === undefined) {
    return;
  }
  const inverted = finerLocksHeld(rank);
  if (inverted.length > 0) {
    fail(
      `Lock-order violation: cannot acquire the ${name} lock while holding the ` +
        `finer-grained ${inverted.join(", ")} lock. Governed locks MUST be acquired ` +
        `outermost-first (governance-runtime > coord-state > agent-state); a coarser ` +
        `lock nested inside a finer one can deadlock. See coord/scripts/governance-context.js ` +
        `(COORD-223 canonical nested-lock order).`
    );
  }
}

function readLockAgeMs(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

function sameFilesystemEntry(left, right) {
  if (!left || !right) {
    return false;
  }
  if (Number.isInteger(left.dev) && Number.isInteger(left.ino) && Number.isInteger(right.dev) && Number.isInteger(right.ino)) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return Math.abs((left.mtimeMs || 0) - (right.mtimeMs || 0)) < 1;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH");
  }
}

function directoryLockMetadataPath(lockPath) {
  return path.join(lockPath, "lock-owner.json");
}

function writeDirectoryLockMetadata(lockPath, metadata = {}) {
  // COORD-437: atomic write (temp file + rename). readDirectoryLockMetadata returns
  // null on ANY parse failure, and a null owner is treated as unknown/pid-less
  // (reclaimable by age) — so a concurrent reader that caught a TORN metadata file
  // mid-write could mis-classify a live lock as ownerless and steal it. rename is
  // atomic on POSIX, so a reader only ever sees a complete file. (A stray .tmp on a
  // mid-write crash is harmless — nothing reads it; the metadata name is fixed.)
  const target = directoryLockMetadataPath(lockPath);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    cwd: process.cwd(),
    created_at: new Date().toISOString(),
    ...metadata,
  }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

function readDirectoryLockMetadata(lockPath) {
  try {
    const raw = fs.readFileSync(directoryLockMetadataPath(lockPath), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tryReclaimStaleDirectoryLock(lockPath, staleMs, options = {}) {
  let observed;
  try {
    observed = fs.statSync(lockPath);
  } catch {
    return false;
  }
  const metadata = readDirectoryLockMetadata(lockPath);
  // COORD-270: the lock-dir mtime is written ONCE at acquire and is never
  // refreshed during a held operation, so a governed mutation that legitimately
  // runs longer than `staleMs` (a large `gov sync` + push, or clock skew) would
  // have its still-held lock reclaimed by age alone — admitting two concurrent
  // journal appenders (the COORD-115/123 hash-chain corruption the lock exists
  // to prevent). The correctness rule: a lock held by a process that is STILL
  // ALIVE on THIS host must NEVER be reclaimed by age. Reclaim a KNOWN owner
  // only when it is genuinely gone (dead pid / foreign host). Age is kept as a
  // fallback ONLY when ownership can't be determined (no/legacy metadata with no
  // pid) so a crashed pre-this-change lock is still recoverable.
  const ownerPid = Number.isInteger(metadata?.pid) ? metadata.pid : null;
  const ownerHost = typeof metadata?.host === "string" && metadata.host.length > 0 ? metadata.host : null;
  const ownerKnown = ownerPid !== null;
  const foreignHost = ownerHost !== null && ownerHost !== os.hostname();
  const ownerDead = ownerKnown && (foreignHost || !isProcessAlive(ownerPid));
  const staleByAge = Date.now() - observed.mtimeMs > staleMs;
  if (!ownerKnown && options.requireKnownOwner) {
    return false;
  }
  // Known owner: reclaim ONLY if dead/foreign (age is irrelevant for a live
  // local owner). Unknown owner: fall back to age.
  const reclaimable = ownerKnown ? ownerDead : staleByAge;
  if (!reclaimable) {
    return false;
  }

  const claimPath = `${lockPath}.reclaim-${process.pid || "pid"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }

  try {
    const claimed = fs.statSync(claimPath);
    if (!sameFilesystemEntry(observed, claimed)) {
      try {
        if (!fs.existsSync(lockPath)) {
          fs.renameSync(claimPath, lockPath);
        }
      } catch {
        // Leave the moved directory in place for explicit repair rather than deleting a potentially fresh lock.
      }
      return false;
    }
    fs.rmSync(claimPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (fs.existsSync(claimPath)) {
      throw error;
    }
    return false;
  }
}

function describeDirectoryLockHolder(lockPath) {
  const metadata = readDirectoryLockMetadata(lockPath);
  const ageMs = readLockAgeMs(lockPath);
  if (!metadata && ageMs === null) {
    return "";
  }
  const parts = [];
  if (metadata?.kind) {
    parts.push(`holder kind=${metadata.kind}`);
  }
  if (Number.isInteger(metadata?.pid)) {
    parts.push(`pid=${metadata.pid}`);
    parts.push(isProcessAlive(metadata.pid) ? "owner_alive=yes" : "owner_alive=no");
  }
  if (metadata?.cwd) {
    parts.push(`cwd=${metadata.cwd}`);
  }
  if (Number.isFinite(ageMs)) {
    parts.push(`age_ms=${Math.max(0, Math.round(ageMs))}`);
  }
  return parts.length > 0 ? `Current lock holder: ${parts.join(" ")}` : "";
}

function withAgentStateLock(fn) {
  if (state.agentStateLockDepth > 0) {
    state.agentStateLockDepth += 1;
    try {
      return fn();
    } finally {
      state.agentStateLockDepth -= 1;
    }
  }

  assertLockOrder("agent-state");
  const lockDir = state.AGENT_STATE_LOCK_DIR;
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeDirectoryLockMetadata(lockDir, { kind: "agent-state" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(lockDir, AGENT_STATE_LOCK_STALE_MS)) {
        continue;
      }
      if (Date.now() - startedAt > AGENT_STATE_LOCK_TIMEOUT_MS) {
        fail(`Timed out waiting for agent state lock at ${lockDir}.`);
      }
      sleepSync(50);
    }
  }

  state.agentStateLockDepth = 1;
  try {
    return fn();
  } finally {
    state.agentStateLockDepth = 0;
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function withCoordStateLock(fn) {
  if (state.coordStateLockDepth > 0) {
    state.coordStateLockDepth += 1;
    try {
      return fn();
    } finally {
      state.coordStateLockDepth -= 1;
    }
  }

  assertLockOrder("coord-state");
  const lockDir = state.COORD_STATE_LOCK_DIR;
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeDirectoryLockMetadata(lockDir, { kind: "coord-state" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(lockDir, COORD_STATE_LOCK_STALE_MS)) {
        continue;
      }
      if (Date.now() - startedAt > COORD_STATE_LOCK_TIMEOUT_MS) {
        fail(`Timed out waiting for coord state lock at ${lockDir}.`);
      }
      sleepSync(50);
    }
  }

  state.coordStateLockDepth = 1;
  try {
    return fn();
  } finally {
    state.coordStateLockDepth = 0;
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function withGovernanceRuntimeLock(fn) {
  if (state.governanceEventLockDepth > 0) {
    state.governanceEventLockDepth += 1;
    try {
      return fn();
    } finally {
      state.governanceEventLockDepth -= 1;
    }
  }

  assertLockOrder("governance-runtime");
  assertCanonicalAuthorityWriteAllowed();
  fs.mkdirSync(state.RUNTIME_DIR, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(state.GOVERNANCE_EVENT_LOCK_DIR);
      writeDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR, { kind: "governance-runtime" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(state.GOVERNANCE_EVENT_LOCK_DIR, GOVERNANCE_EVENT_LOCK_STALE_MS, { requireKnownOwner: true })) {
        continue;
      }
      if (Date.now() - startedAt > GOVERNANCE_EVENT_LOCK_TIMEOUT_MS) {
        const holder = describeDirectoryLockHolder(state.GOVERNANCE_EVENT_LOCK_DIR);
        fail(
          `Timed out waiting for governance runtime lock at ${state.GOVERNANCE_EVENT_LOCK_DIR}.` +
          (holder ? ` ${holder}` : "") +
          ` Recovery: run "coord/scripts/gov runtime-lock-status" to inspect the holder, then ` +
          `"coord/scripts/gov break-runtime-lock --yes" for a stale/dead holder. ` +
          `Live local holders require "--force-live" and human-admin confirmation.`
        );
      }
      sleepSync(50);
    }
  }

  state.governanceEventLockDepth = 1;
  try {
    return fn();
  } finally {
    state.governanceEventLockDepth = 0;
    fs.rmSync(state.GOVERNANCE_EVENT_LOCK_DIR, { recursive: true, force: true });
  }
}

module.exports = {
  SCRIPTS_DIR,
  COORD_DIR,
  ROOT_DIR,
  DEFAULT_PATHS,
  GovernanceError,
  // COORD-072: canonical DI failure thunk. DI-factory modules do
  // `const fail = deps.fail || defaultFail;` instead of inlining the
  // `(m) => { throw new GovernanceError(m); }` thunk.
  defaultFail: fail,
  state,
  readLockAgeMs,
  isProcessAlive,
  tryReclaimStaleDirectoryLock,
  describeDirectoryLockHolder,
  directoryLockMetadataPath,
  writeDirectoryLockMetadata,
  readDirectoryLockMetadata,
  readRuntimeRoleMarker,
  detectCheckoutRuntimeRole,
  canonicalAuthorityWriteIssue,
  assertCanonicalAuthorityWriteAllowed,
  withAgentStateLock,
  withCoordStateLock,
  withGovernanceRuntimeLock,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
  CONTINUITY_AUTHORITY_CONTRACT,
  DAILY_JOURNAL_AUTHORITY_CONTRACT,
  CADENCE_CURSOR_AUTHORITY_CONTRACT,
  CONTINUITY_WRITE_SAFETY_CONTRACT,
  DAILY_JOURNAL_ENTRY_FIELDS,
  CADENCE_CURSOR_FIELDS,
  DAILY_JOURNAL_MODES,
  CADENCE_OPERATION_CLASSES,
  CADENCE_CURSOR_TYPES,
  CADENCE_FRESHNESS_STATUSES,
  DURABILITY_SWEEP_INPUT_TYPES,
  DURABILITY_SWEEP_PROMOTION_TYPES,
  CONTINUITY_SENSITIVITY_CLASSES,
  WARM_START_FIELDS,
  COLD_FINISH_FIELDS,
  CONTINUITY_ARTIFACT_SHAPES,
  continuityArtifactShapes,
  continuityArtifactShape,
  buildContinuityArtifactTemplate,
  buildDailyJournalEntryTemplate,
  buildCadenceCursorTemplate,
  stableContinuityStringify,
  computeContinuityGenerationHash,
  annotateContinuityRecord,
  mergeAppendOnlyContinuityRecords,
  summarizeCadenceCursorState,
  advanceCadenceCursor,
  validateContinuityFreshRead,
  buildContinuityWarmStartBriefing,
  buildContinuityColdFinishContract,
  buildContinuityDurabilitySweepReadout,
  buildPublicSafeContinuityPilotFixtures,
  buildContinuityReadOnlyReadout,
  // COORD-223: nested-lock ordering invariant (canonical order + fail-closed guard).
  LOCK_RANKS,
  assertLockOrder,
  finerLocksHeld,
};
