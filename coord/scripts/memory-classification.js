"use strict";

// COORD-144: [Memory] Cross-cutting — memory permission CLASSIFICATION layer.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 principle 4 ("permission
// classification") and §12.3 ("data governance"), memory artifacts are
// classified into one of FOUR classes and enforced through the EXISTING ENT-012
// RBAC redaction layer (the optional tier's RBAC policy, when that tier ships):
//
//   public            — safe for anyone (ticket id, status, high-level decision).
//   internal          — operational detail (filesystem paths, identities, gate
//                       specifics) — redacted for viewer, shown to operator+.
//   sensitive         — provenance/evidence bodies, costs — redacted below the
//                       operator trust boundary per ENT-012.
//   secret-prohibited — secrets/tokens/keys that MUST NEVER be stored in memory
//                       at all. REFUSE/REDACT-ALWAYS in BOTH cuts; a detector
//                       flags secret-like content so it is never surfaced.
//
// WHY A SEPARATE LAYER (not a recall rewrite): COORD-141's recall.js already
// delegates redaction to ENT-012 (`--role`, best-effort load, graceful community
// degradation). This module adds the EXPLICIT artifact-classification taxonomy
// on TOP of that — it does NOT reimplement RBAC. Each class maps to an ENT-012
// ROLE THRESHOLD (the lowest role at which the class is revealed) and to an
// ENT-012 REDACTION KIND, so enforcement is delegated to ENT-012's
// `shouldRedactForRole` / `redactField` rather than re-derived here.
//
// CARDINAL GUARDRAIL (§5). Classification NEVER fabricates and NEVER weakens the
// guardrail: secret-prohibited content is refused/redacted regardless of role
// AND regardless of cut. A viewer never sees verbatim evidence; nobody — not
// even admin/auditor — sees a stored secret, because secrets must never enter
// memory in the first place.
//
// ZERO new runtime deps. Pure functions; no fs/process/network. ENT-012 is
// loaded BEST-EFFORT by the caller (recall.js) and passed in — there is NO hard
// core->tier dependency, so the community cut (the optional tier stripped)
// degrades to the documented safe default.

// --- the taxonomy (as data) --------------------------------------------------
// Each class declares:
//   - rank          ordering (public < internal < sensitive < secret-prohibited)
//   - minRole       the LOWEST ENT-012 operational role at which the class is
//                   REVEALED unredacted. `null` for public (everyone sees it);
//                   `false` for secret-prohibited (NOBODY sees it — always
//                   refused). Mapped onto ENT-012's role lattice, not redefined.
//   - redactionKind the ENT-012 REDACTION_KIND used to redact a field of this
//                   class (so redaction is delegated to ENT-012.redactField).
//   - desc          human description.
//
// ENT-012's UNREDACTED_ROLES = {operator, maintainer, admin, auditor}; viewer is
// the only redacted operational role. So mapping `internal` and `sensitive` to
// minRole "operator" means: viewer is redacted, operator+ is full — exactly the
// ticket's "viewer gets redacted summaries, operator/admin get full provenance".
const CLASSES = Object.freeze({
  public: Object.freeze({
    rank: 0,
    minRole: null, // everyone, including an unknown/absent role
    redactionKind: null, // never redacted
    desc: "Safe for anyone: ticket id, status, high-level decision label.",
  }),
  internal: Object.freeze({
    rank: 1,
    minRole: "operator", // viewer redacted; operator+ full
    redactionKind: "path", // operational detail (paths/identities) -> path/identity kind
    desc: "Operational detail (filesystem paths, identities, gate specifics).",
  }),
  sensitive: Object.freeze({
    rank: 2,
    minRole: "operator", // viewer redacted; operator+ full (per ENT-012 trust model)
    redactionKind: "evidence", // provenance/evidence bodies, costs
    desc: "Provenance/evidence bodies and costs (verbatim decision text).",
  }),
  "secret-prohibited": Object.freeze({
    rank: 3,
    minRole: false, // NOBODY — always refused/redacted, in BOTH cuts
    redactionKind: "evidence",
    desc: "Secrets/tokens/keys that must NEVER be stored in memory at all.",
  }),
});

const CLASS_NAMES = Object.freeze(Object.keys(CLASSES));

function isClass(name) {
  return Object.prototype.hasOwnProperty.call(CLASSES, name);
}

// --- COORD-337: shared/private memory scope model ----------------------------
// Permission classes answer "who can see the field value?" Memory scopes answer
// "where may this record govern or be reused?" Keep them separate: a
// human-private note can still contain only public-safe text, but it must not
// silently govern other agents until a cited governed promotion creates a shared
// artifact.
const MEMORY_SCOPES = Object.freeze({
  shared: Object.freeze({
    rank: 0,
    governs: "project",
    promotionRequired: false,
    desc: "Project-shared governed memory: reusable across project agents when source-cited.",
  }),
  team: Object.freeze({
    rank: 1,
    governs: "team",
    promotionRequired: false,
    desc: "Team-scoped memory: reusable only inside the named team/project boundary.",
  }),
  "human-private": Object.freeze({
    rank: 2,
    governs: "human",
    promotionRequired: true,
    desc: "Personal human or agent notes that cannot govern other agents without promotion.",
  }),
  "local-only": Object.freeze({
    rank: 3,
    governs: "local",
    promotionRequired: true,
    desc: "Session/worktree scratch that must stay local unless promoted with citations.",
  }),
  sensitive: Object.freeze({
    rank: 4,
    governs: "restricted",
    promotionRequired: true,
    desc: "Sensitive memory: pointer/summary preferred; bodies require redaction controls.",
  }),
  "secret-prohibited": Object.freeze({
    rank: 5,
    governs: "none",
    promotionRequired: false,
    desc: "Secrets/tokens/keys are rejected from memory and cannot be promoted.",
  }),
});

const SCOPE_NAMES = Object.freeze(Object.keys(MEMORY_SCOPES));

const MEMORY_CONTROL_ACTIONS = Object.freeze([
  "inspect",
  "audit",
  "demote",
  "supersede",
  "reject",
  "forget",
  "redact",
]);

const READ_ONLY_MEMORY_CONTROL_ACTIONS = Object.freeze(["inspect", "audit"]);
const WRITE_MEMORY_CONTROL_ACTIONS = Object.freeze(["demote", "supersede", "reject", "forget", "redact"]);
const HISTORY_ONLY_STATUSES = Object.freeze(["rejected", "forgotten", "superseded"]);

function isScope(name) {
  return Object.prototype.hasOwnProperty.call(MEMORY_SCOPES, name);
}

function isMemoryControlAction(action) {
  return MEMORY_CONTROL_ACTIONS.includes(String(action || ""));
}

const ATTRIBUTION_FIELDS = Object.freeze([
  "human_id",
  "agent_handle",
  "provider_session_id",
  "coord_session_id",
  "acting_for",
  "team_id",
  "project_id",
  "source_worktree",
  "ticket_id",
]);

function cleanAttributionScalar(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAttribution(record) {
  const source =
    record && typeof record === "object" && record.attribution && typeof record.attribution === "object"
      ? record.attribution
      : record;
  const attribution = {};
  for (const field of ATTRIBUTION_FIELDS) {
    attribution[field] = cleanAttributionScalar(source?.[field]);
  }
  return Object.freeze(attribution);
}

function hasAnyAttribution(record) {
  const attribution = normalizeAttribution(record);
  return ATTRIBUTION_FIELDS.some((field) => attribution[field] !== null);
}

function attributionHasExecutingSession(attribution) {
  return Boolean(
    attribution.agent_handle &&
      (attribution.provider_session_id || attribution.coord_session_id)
  );
}

function validateSharedAttribution(record, currentActor = {}) {
  const errors = [];
  const scope = classifyMemoryScope(record);
  const attribution = normalizeAttribution(record);
  const current = normalizeAttribution(currentActor);

  if (hasAnyAttribution(record) && attribution.agent_handle && !attributionHasExecutingSession(attribution)) {
    errors.push("agent attribution requires provider_session_id or coord_session_id");
  }

  if (scope === "team" && !attribution.team_id) {
    errors.push("team-scoped memory requires team_id attribution");
  }

  if (
    scope === "human-private" &&
    attribution.human_id &&
    current.human_id &&
    attribution.human_id !== current.human_id
  ) {
    errors.push("human-private notes cannot be claimed as another human's shared authority");
  }

  return Object.freeze({
    ok: errors.length === 0,
    scope,
    attribution,
    errors: Object.freeze(errors),
  });
}

const SHARED_BY_DEFAULT_TYPES = new Set([
  "ticket",
  "board_ticket",
  "plan",
  "plan_record",
  "adr",
  "accepted_adr",
  "business_rule",
  "confirmed_business_rule",
  "cadence_cursor",
  "cursor",
  "decision",
  "durable_decision",
]);

const TEAM_BY_DEFAULT_TYPES = new Set([
  "team_note",
  "team_cadence",
  "team_runbook",
  "team_retrospective",
  "team_decision",
]);

const HUMAN_PRIVATE_TYPES = new Set([
  "human_private",
  "human_private_note",
  "private_note",
  "personal_note",
  "personal_agent_note",
  "preference",
]);

const LOCAL_ONLY_TYPES = new Set([
  "scratch",
  "local_scratch",
  "session_scratch",
  "scratch_observation",
  "unverified_observation",
  "daily_journal_entry",
  "transcript_note",
]);

function normalizeScope(scope) {
  if (!scope) {
    return null;
  }
  const normalized = String(scope).toLowerCase().replace(/_/g, "-");
  if (normalized === "project-shared" || normalized === "project") {
    return "shared";
  }
  if (normalized === "team-shared") {
    return "team";
  }
  if (normalized === "private" || normalized === "human-private-note") {
    return "human-private";
  }
  if (normalized === "local" || normalized === "scratch-only") {
    return "local-only";
  }
  if (normalized === "secret" || normalized === "secret_prohibited") {
    return "secret-prohibited";
  }
  return isScope(normalized) ? normalized : null;
}

function recordType(record) {
  return String(
    (record && (record.artifact_type || record.record_type || record.type || record.kind)) || ""
  ).toLowerCase();
}

function explicitScope(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return normalizeScope(
    record.memory_scope || record.scope || record.visibility || record.sharing || record.privacy
  );
}

function explicitControlScope(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return normalizeScope(
    record.memory_scope ||
      record.scope ||
      record.visibility ||
      record.sharing ||
      record.privacy ||
      record.retrieval_scope
  );
}

function classifyMemoryScope(record) {
  if (looksLikeSecret(record)) {
    return "secret-prohibited";
  }
  if (!record || typeof record !== "object") {
    return "local-only";
  }

  const explicit = explicitScope(record);
  if (explicit) {
    return explicit;
  }

  const sensitivity = normalizeScope(
    record.sensitivity || record.classification || record.permission_class || record.data_class
  );
  if (sensitivity === "secret-prohibited") {
    return "secret-prohibited";
  }
  if (sensitivity === "sensitive") {
    return "sensitive";
  }

  const type = recordType(record);
  if (SHARED_BY_DEFAULT_TYPES.has(type)) {
    return "shared";
  }
  if (TEAM_BY_DEFAULT_TYPES.has(type) || record.team_id) {
    return "team";
  }
  if (HUMAN_PRIVATE_TYPES.has(type) || record.human_id || record.personal === true) {
    return "human-private";
  }
  if (LOCAL_ONLY_TYPES.has(type) || record.local_only === true || record.scratch === true) {
    return "local-only";
  }

  return "local-only";
}

function hasPromotionCitation(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  const refs = record.source_refs || record.evidence_refs || record.citations || record.sources;
  return Array.isArray(refs) && refs.length > 0;
}

function hasPromotionApproval(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  return Boolean(
    record.promoted_by ||
      record.approved_by ||
      record.reviewed_by ||
      record.governed_promotion === true ||
      record.promotion_status === "promoted"
  );
}

function canPromoteToShared(record) {
  return validateSharedPromotion(record).ok;
}

function canGovernOtherAgents(record) {
  const scope = classifyMemoryScope(record);
  if (!validateSharedAttribution(record).ok) {
    return false;
  }
  if (scope === "shared") {
    return true;
  }
  if (scope === "team") {
    return Boolean(record && record.team_id);
  }
  return false;
}

function validateSharedPromotion(record) {
  const scope = classifyMemoryScope(record);
  const errors = [];
  const approvedHumanId =
    record?.approved_by_human_id ||
    record?.reviewed_by_human_id ||
    record?.promoted_by_human_id ||
    null;
  const attribution = validateSharedAttribution(record, { human_id: approvedHumanId });
  if (scope === "secret-prohibited") {
    errors.push("secret-prohibited material cannot be stored or promoted");
  }
  if (!hasPromotionCitation(record)) {
    errors.push("promotion requires source_refs/evidence_refs/citations");
  }
  if (!hasPromotionApproval(record)) {
    errors.push("promotion requires governed human/reviewer approval");
  }
  errors.push(...attribution.errors);
  return Object.freeze({
    ok: errors.length === 0,
    from_scope: scope,
    to_scope: errors.length === 0 ? "shared" : null,
    errors: Object.freeze(errors),
  });
}

function claimIdentifier(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return (
    record.claim_id ||
    record.id ||
    record.candidate_id ||
    record.ticket_id ||
    record.memory_id ||
    null
  );
}

function normalizeMemoryStatus(record) {
  if (!record || typeof record !== "object") {
    return "active";
  }
  const raw = String(
    record.memory_status ||
      record.lifecycle_status ||
      record.retrieval_status ||
      record.status ||
      ""
  ).toLowerCase().replace(/_/g, "-");
  if (record.forgotten === true || raw === "forget" || raw === "forgotten") {
    return "forgotten";
  }
  if (record.rejected === true || raw === "reject" || raw === "rejected") {
    return "rejected";
  }
  if (record.superseded_by || raw === "supersede" || raw === "superseded") {
    return "superseded";
  }
  if (record.demoted === true || raw === "demote" || raw === "demoted") {
    return "demoted";
  }
  if (raw === "inactive" || raw === "quarantined" || raw === "redacted") {
    return raw;
  }
  return "active";
}

function isHistoryOnlyStatus(status) {
  return HISTORY_ONLY_STATUSES.includes(String(status || ""));
}

function promotedBy(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return (
    record.promoted_by ||
    record.promoted_by_human_id ||
    record.approved_by ||
    record.reviewed_by ||
    record.owner ||
    null
  );
}

function provenanceRefs(record) {
  if (!record || typeof record !== "object") {
    return [];
  }
  for (const key of ["source_refs", "evidence_refs", "citations", "sources", "provenance"]) {
    if (Array.isArray(record[key])) {
      return record[key].map((ref) => ({ ...ref }));
    }
  }
  return [];
}

function usageRefs(record) {
  if (!record || typeof record !== "object") {
    return [];
  }
  for (const key of ["used_by", "retrieval_uses", "context_pack_refs", "usage_refs"]) {
    if (Array.isArray(record[key])) {
      return record[key].map((ref) => ({ ...ref }));
    }
  }
  return [];
}

function retrievalDecision(record, options = {}) {
  const status = normalizeMemoryStatus(record);
  const explicit = explicitControlScope(record);
  const scope = explicit || classifyMemoryScope(record);
  const attribution = normalizeAttribution(record || {});
  const reasons = [];
  let active = true;

  if (isHistoryOnlyStatus(status)) {
    active = false;
    reasons.push(`${status} claims are retained for audit only`);
  }
  if (status === "quarantined") {
    active = false;
    reasons.push("quarantined claims require review before active retrieval");
  }
  if (scope === "secret-prohibited" && explicit) {
    active = false;
    reasons.push("secret-prohibited claims are rejected before active retrieval");
  }
  if (scope === "human-private" && !options.includePrivate) {
    active = false;
    reasons.push("human-private claims are excluded from shared retrieval");
  }
  if (
    scope === "human-private" &&
    options.includePrivate &&
    attribution.human_id &&
    attribution.human_id !== cleanAttributionScalar(options.humanId)
  ) {
    active = false;
    reasons.push("human-private claim belongs to a different human");
  }
  if (scope === "local-only" && explicit && !options.includeLocal) {
    active = false;
    reasons.push("local-only claims are excluded from shared retrieval");
  }
  if (scope === "team" && record?.team_id && record.team_id !== cleanAttributionScalar(options.teamId)) {
    active = false;
    reasons.push(options.teamId ? "team-scoped claim belongs to a different team" : "team-scoped claim requires caller team scope");
  }

  return Object.freeze({
    active,
    status,
    scope,
    history_only: !active && (isHistoryOnlyStatus(status) || status === "quarantined"),
    reasons: Object.freeze(reasons),
  });
}

function isClaimActiveForRetrieval(record, options = {}) {
  return retrievalDecision(record, options).active;
}

function inspectMemoryClaim(record, options = {}) {
  const retrieval = retrievalDecision(record, options);
  const attribution = normalizeAttribution(record || {});
  return Object.freeze({
    kind: "concord.memory_claim.inspect",
    schema_version: 1,
    claim_id: claimIdentifier(record),
    statement: record?.statement || record?.context_pack_statement || null,
    status: retrieval.status,
    memory_scope: retrieval.scope,
    shared_status: retrieval.scope,
    active_retrieval: retrieval.active,
    retrieval_reasons: retrieval.reasons,
    promoted_by: promotedBy(record),
    attribution,
    provenance_refs: Object.freeze(provenanceRefs(record)),
    used_by: Object.freeze(usageRefs(record)),
    classification: classifySource(record || {}),
    controls: Object.freeze({
      read_only: READ_ONLY_MEMORY_CONTROL_ACTIONS,
      write_path: WRITE_MEMORY_CONTROL_ACTIONS,
      removal_model: "tombstone_or_redaction_preserves_audit_history",
    }),
  });
}

function auditMemoryClaim(record, controlRecords = [], options = {}) {
  const inspect = inspectMemoryClaim(record, options);
  const claimId = inspect.claim_id;
  const history = (controlRecords || [])
    .filter((entry) => !claimId || entry.claim_id === claimId || entry.target_claim_id === claimId)
    .map((entry) => ({ ...entry }));
  return Object.freeze({
    kind: "concord.memory_claim.audit",
    schema_version: 1,
    claim_id: claimId,
    current: inspect,
    control_history: Object.freeze(history),
  });
}

function lowPrivilegeFallbackPolicy() {
  return Object.freeze({
    shouldRedactForRole(role) {
      return role != null && !["operator", "maintainer", "admin", "auditor"].includes(String(role));
    },
    redactField(kind, value) {
      if (kind === "path" && typeof value === "string") {
        const parts = value.split(/[\\/]/).filter(Boolean);
        return parts.length ? `.../${parts[parts.length - 1]}` : "[redacted]";
      }
      return "[redacted]";
    },
  });
}

function effectivePolicyForMemorySurface(options = {}) {
  if (options.policy && typeof options.policy.shouldRedactForRole === "function") {
    return options.policy;
  }
  if (options.rbacPolicy && typeof options.rbacPolicy.shouldRedactForRole === "function") {
    return options.rbacPolicy;
  }
  if (options.role != null && options.failClosedWithoutPolicy !== false) {
    return lowPrivilegeFallbackPolicy();
  }
  return options.policy || options.rbacPolicy || null;
}

function looksLikeScopedMemoryRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (
        value.memory_scope ||
        value.scope ||
        value.visibility ||
        value.sharing ||
        value.privacy ||
        value.memory_status ||
        value.retrieval_status ||
        value.artifact_type ||
        value.record_type ||
        value.claim_id ||
        value.memory_id
      )
  );
}

function redactedRecordStub(record, decision) {
  return Object.freeze({
    claim_id: claimIdentifier(record),
    id: record?.id || null,
    ticket_id: record?.ticket_id || null,
    memory_scope: decision.scope,
    status: decision.status,
    active_retrieval: false,
    withheld: true,
    withheld_reasons: decision.reasons,
  });
}

function redactMemorySurfaceValue(value, options, seen, depth) {
  if (value == null) {
    return value;
  }
  const role = options.role ?? null;
  const policy = effectivePolicyForMemorySurface(options);
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    const cls = classifyField(options.fieldName || "value", value);
    return redactClassifiedField(cls, options.fieldName || "value", value, role, policy);
  }
  if (t !== "object") {
    return value;
  }
  if (depth >= MAX_SCAN_DEPTH || seen.has(value)) {
    return SECRET_REFUSAL;
  }
  if (looksLikeScopedMemoryRecord(value)) {
    const decision = retrievalDecision(value, options);
    if (!decision.active) {
      return redactedRecordStub(value, decision);
    }
  }
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => redactMemorySurfaceValue(item, options, seen, depth + 1));
  } else {
    out = {};
    for (const [key, child] of Object.entries(value)) {
      const cls = classifyField(key, child);
      if (cls === "secret-prohibited") {
        out[key] = redactClassifiedField(cls, key, child, role, policy);
      } else if (child !== null && typeof child === "object") {
        out[key] = redactMemorySurfaceValue(child, { ...options, fieldName: key }, seen, depth + 1);
      } else {
        out[key] = redactClassifiedField(cls, key, child, role, policy);
      }
    }
  }
  seen.delete(value);
  return out;
}

function redactMemorySurface(value, options = {}) {
  return redactMemorySurfaceValue(value, options, new Set(), 0);
}

function nextStateForControl(action, record, options) {
  const currentScope = classifyMemoryScope(record || {});
  switch (action) {
    case "demote":
      return {
        memory_status: "active",
        memory_scope: normalizeScope(options.to_scope) || "local-only",
        tombstone: false,
        redaction: null,
      };
    case "supersede":
      return {
        memory_status: "superseded",
        memory_scope: currentScope,
        superseded_by: options.superseded_by || options.replacement_claim_id || null,
        tombstone: true,
        redaction: null,
      };
    case "reject":
      return {
        memory_status: "rejected",
        memory_scope: currentScope,
        rejection_code: options.rejection_code || options.reason_code || "governed_rejection",
        tombstone: true,
        redaction: null,
      };
    case "forget":
      return {
        memory_status: "forgotten",
        memory_scope: "human-private",
        tombstone: true,
        redaction: {
          mode: "withhold_from_active_retrieval",
          preserve_audit_history: true,
        },
      };
    case "redact":
      return {
        memory_status: normalizeMemoryStatus(record),
        memory_scope: currentScope,
        tombstone: false,
        redaction: {
          mode: options.redaction_mode || "replace_body_with_marker",
          fields: Array.isArray(options.fields) ? options.fields.slice().sort() : [],
          marker: options.marker || "[redacted-by-governed-memory-control]",
          preserve_audit_history: true,
        },
      };
    default:
      return null;
  }
}

function buildMemoryControlRecord(action, record, options = {}) {
  const normalizedAction = String(action || "").toLowerCase();
  if (!WRITE_MEMORY_CONTROL_ACTIONS.includes(normalizedAction)) {
    throw new Error(`Unsupported governed memory write control: ${action}`);
  }
  const classificationCheck = validateSharedAttribution(record || {}, options.actor || {});
  const secretBlocked = looksLikeSecret(record);
  const next = nextStateForControl(normalizedAction, record || {}, options);
  const errors = [...classificationCheck.errors];
  if (secretBlocked && normalizedAction !== "redact" && normalizedAction !== "forget") {
    errors.push("secret-prohibited material must be redacted/forgotten, not promoted or reused");
  }
  if (normalizedAction === "supersede" && !next.superseded_by) {
    errors.push("supersede requires superseded_by or replacement_claim_id");
  }
  if (normalizedAction === "redact" && (!next.redaction.fields || next.redaction.fields.length === 0)) {
    errors.push("redact requires fields");
  }
  return Object.freeze({
    kind: "concord.memory_claim.control",
    schema_version: 1,
    action: normalizedAction,
    claim_id: claimIdentifier(record),
    reason: options.reason || null,
    actor: normalizeAttribution(options.actor || {}),
    created_at_utc: options.createdAtUtc || "1970-01-01T00:00:00.000Z",
    previous: Object.freeze({
      memory_status: normalizeMemoryStatus(record),
      memory_scope: classifyMemoryScope(record || {}),
      active_retrieval: isClaimActiveForRetrieval(record || {}),
    }),
    next: Object.freeze(next),
    provenance_refs: Object.freeze(provenanceRefs(record)),
    classification_check: Object.freeze({
      ok: errors.length === 0,
      scope: classificationCheck.scope,
      attribution: classificationCheck.attribution,
      contains_secret_prohibited: secretBlocked,
      errors: Object.freeze(errors),
    }),
    write_path: "governed_memory_control_record",
    audit_history_preserved: true,
    destructive_delete: false,
  });
}

function applyMemoryControlRecord(record, controlRecord) {
  if (!controlRecord || controlRecord.kind !== "concord.memory_claim.control") {
    throw new Error("applyMemoryControlRecord requires a governed memory control record");
  }
  if (!controlRecord.classification_check?.ok) {
    throw new Error(`memory control failed classification checks: ${(controlRecord.classification_check.errors || []).join("; ")}`);
  }
  return {
    ...(record || {}),
    memory_status: controlRecord.next.memory_status,
    memory_scope: controlRecord.next.memory_scope,
    superseded_by: controlRecord.next.superseded_by || record?.superseded_by || null,
    tombstone: controlRecord.next.tombstone,
    redaction: controlRecord.next.redaction || record?.redaction || null,
    last_memory_control: controlRecord,
  };
}

// --- secret-prohibited detector ----------------------------------------------
// Detect secret-LIKE content so it is never surfaced. This is deliberately
// conservative + deterministic (no model): a small set of high-signal patterns
// for the credential shapes that must never live in governed memory. A match
// means "treat as secret-prohibited regardless of any other classification".
//
// Patterns cover: private key PEM blocks, common provider token prefixes
// (GitHub ghp_/gho_/ghs_, Slack xox*, AWS AKIA, Google AIza, OpenAI/Anthropic
// sk-/sk-ant-), JWTs, and explicit "<secret-word>: <value>" assignments. The
// goal is detect-and-refuse at the memory boundary, not exhaustive DLP.
const SECRET_PATTERNS = Object.freeze([
  // PEM private key blocks.
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  // Provider API key / token prefixes.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, // GitHub PAT / OAuth / server / refresh
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, // Slack tokens
  /\bAKIA[0-9A-Z]{12,}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Google API key
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/, // OpenAI / Anthropic secret keys
  // JWT (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Explicit "<secretword> = / : <value>" assignments (token/secret/password/
  // api[_-]key/private[_-]key/access[_-]key) with a non-trivial value. A
  // prefix like "AWS_" is allowed (no leading word-boundary) since "_" is a word
  // char and would otherwise block "AWS_SECRET_KEY".
  /(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|private[_-]?key|password|passwd|token|bearer|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+_=-]{8,}/i,
]);

// --- entropy-based fallback (COORD-276) ---------------------------------------
// Some real credentials are RANDOM tokens that match no known provider prefix
// (rotated/custom/self-issued keys, raw base64 secrets). A pattern list can never
// be exhaustive, so we add a deterministic Shannon-entropy fallback: a long
// CONTIGUOUS token whose per-character entropy exceeds a threshold is treated as
// a likely secret. The threshold is tuned to clear ordinary memory content —
// natural-language prose splits into short word tokens; git SHAs (hex, ~3.95
// bits/char) and UUIDs (hex, ~3.2 bits/char) sit BELOW the bar; random base64
// secrets (~4.8-5.0 bits/char) sit comfortably ABOVE it. See the test's
// both-directions assertions (real token caught; sha/uuid/prose not).
const ENTROPY_MIN_TOKEN_LEN = 24; // ignore short ids/words entirely
const ENTROPY_BITS_THRESHOLD = 4.3; // hex maxes at 4.0; base64 secrets ~4.8+
// Token boundary: split on anything that is NOT a credential character. Keeps
// secret charset (alnum + - _ + / =) contiguous while breaking prose on spaces
// and sentence punctuation (incl. '.', which separates dotted ids/filenames).
const ENTROPY_TOKEN_SPLIT = /[^A-Za-z0-9+/=_-]+/;

function shannonEntropyPerChar(str) {
  const freq = new Map();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// True iff `str` contains a long, high-entropy, mixed-charset contiguous token.
function hasHighEntropyToken(str) {
  if (str.length < ENTROPY_MIN_TOKEN_LEN) {
    return false;
  }
  for (const tok of str.split(ENTROPY_TOKEN_SPLIT)) {
    if (tok.length < ENTROPY_MIN_TOKEN_LEN) {
      continue;
    }
    // Require BOTH letters and digits: real random tokens mix character classes,
    // while long single-class strings (e.g. a run of one char, an all-letter
    // identifier) are far more likely to be benign — this trims false positives.
    if (!/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) {
      continue;
    }
    if (shannonEntropyPerChar(tok) >= ENTROPY_BITS_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// True iff a STRING scalar looks like a secret (known pattern OR high entropy).
function stringLooksLikeSecret(str) {
  if (typeof str !== "string" || str.length === 0) {
    return false;
  }
  if (SECRET_PATTERNS.some((re) => re.test(str))) {
    return true;
  }
  return hasHighEntropyToken(str);
}

// COORD-276: bound the recursion so cyclic or pathologically deep adversarial
// input can neither infinite-loop nor blow the stack. MAX_SCAN_DEPTH caps how
// deep we descend; a per-path `seen` set breaks reference cycles.
const MAX_SCAN_DEPTH = 8;

// Recursively scan a value (string, scalar, object, or array at any depth) for
// secret-like content. Scalars are stringified before the secret test so a
// secret WRAPPED in a non-string container, or NESTED inside an object/array, is
// inspected rather than silently passed through. Returns true on the first hit.
function scanForSecret(value, seen, depth) {
  if (value == null) {
    return false;
  }
  const t = typeof value;
  if (t === "string") {
    return stringLooksLikeSecret(value);
  }
  if (t === "number" || t === "boolean" || t === "bigint") {
    return stringLooksLikeSecret(String(value));
  }
  if (t !== "object") {
    return false; // function / symbol / undefined carry no surfaced text
  }
  if (depth >= MAX_SCAN_DEPTH || seen.has(value)) {
    return false; // depth cap + cycle guard: terminate safely
  }
  seen.add(value);
  let found = false;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (scanForSecret(child, seen, depth + 1)) {
      found = true;
      break;
    }
  }
  seen.delete(value); // path-scoped: allow shared (non-cyclic) DAG siblings
  return found;
}

// True iff `value` contains secret-like content that must never be surfaced.
// COORD-276: now recurses into objects/arrays and stringifies non-string scalars
// (previously returned false for anything that was not a top-level string), and
// adds the high-entropy fallback for credentials matching no known pattern.
function looksLikeSecret(value) {
  return scanForSecret(value, new Set(), 0);
}

// --- field-level classification rules ----------------------------------------
// Classify ONE memory field (a logical role within an artifact) given its name
// and value. Secret detection runs FIRST and overrides everything: any value
// that looks like a secret is `secret-prohibited` no matter the field name.
//
// Field-name rules (deterministic, data-driven):
//   id / ticket_id / status / type / confidence / staleness / verified / kind
//       -> public  (high-level, non-sensitive descriptors)
//   path / chain_head / event_hash / identity / owner / handle / session
//   / pid / cmdline / gate / verification
//       -> internal  (operational detail)
//   everything else (snippet / answer / evidence / findings / risks / cost /
//   decision bodies) -> sensitive  (verbatim provenance/evidence)
const PUBLIC_FIELDS = new Set([
  "id",
  "ticket_id",
  "status",
  "type",
  "confidence",
  "staleness",
  "verified",
  "kind",
  "verdict",
  "class",
  "classification",
]);

const INTERNAL_FIELDS = new Set([
  "path",
  "source_path",
  "chain_head",
  "event_hash",
  "identity",
  "owner",
  "handle",
  "session",
  "session_id",
  "pid",
  "cmdline",
  "gate",
  "verification",
  "branch",
  "worktree",
]);

function classifyField(fieldName, value) {
  // Secret detection overrides all field-name rules: a secret value is
  // secret-prohibited even in a field that would otherwise be public/internal.
  if (looksLikeSecret(value)) {
    return "secret-prohibited";
  }
  const name = String(fieldName || "").toLowerCase();
  if (PUBLIC_FIELDS.has(name)) {
    return "public";
  }
  if (INTERNAL_FIELDS.has(name)) {
    return "internal";
  }
  // Default-conservative: unrecognized fields carry verbatim provenance/evidence
  // and are treated as sensitive (revealed only at the operator+ trust boundary).
  return "sensitive";
}

// Classify a whole recall citation `source` object into the HIGHEST (most
// restrictive) class any of its fields warrants. Used to label each cited
// source with a classification for the caller/UI.
function classifySource(source) {
  if (!source || typeof source !== "object") {
    return "public";
  }
  let top = "public";
  for (const [k, v] of Object.entries(source)) {
    const cls = classifyField(k, v);
    if (CLASSES[cls].rank > CLASSES[top].rank) {
      top = cls;
    }
  }
  return top;
}

// --- mapping classification -> ENT-012 enforcement ---------------------------
// Decide whether a field of class `cls` should be redacted for `role`, and how,
// by COMPOSING the ENT-012 policy (passed in best-effort by the caller). This is
// the SINGLE place classification is mapped onto the existing RBAC layer — RBAC
// is NOT reimplemented.
//
// Trust model (mirrors recall.js): the local governed CLI is a trusted
// operational caller, so NO explicit role => the operational (unredacted) view
// — EXCEPT secret-prohibited, which is refused even there. With an explicit
// role, enforcement defers to ENT-012:
//   - public            -> never redacted.
//   - internal/sensitive -> redacted iff the role is below the class minRole
//                           (delegated to ENT-012.shouldRedactForRole, which
//                           makes viewer redacted and operator+ full).
//   - secret-prohibited  -> ALWAYS redacted, every role, both cuts.
//
// Community cut (no ENT-012): `policy` is null/!shouldRedactForRole. We FAIL
// SAFE — public passes; secret-prohibited is ALWAYS redacted; internal/sensitive
// follow recall's documented community default of NOT differentiating by role
// (no role lattice is available), i.e. they pass UNREDACTED for the trusted
// local operational caller. secret-prohibited never relaxes in either cut.
function shouldRedactClass(cls, role, policy) {
  const def = CLASSES[isClass(cls) ? cls : "sensitive"];
  // secret-prohibited: never reveal, any role, any cut.
  if (def.minRole === false) {
    return true;
  }
  // public: never redact.
  if (def.minRole === null) {
    return false;
  }
  // No explicit role => trusted local operational caller => no redaction
  // (matches recall.js resolveRedaction default).
  if (role == null) {
    return false;
  }
  // Explicit role + ENT-012 present: delegate to the RBAC redaction decision.
  // ENT-012's UNREDACTED_ROLES (operator/maintainer/admin/auditor) satisfy the
  // operator+ threshold; viewer (the only redacted operational role) does not.
  if (policy && typeof policy.shouldRedactForRole === "function") {
    return policy.shouldRedactForRole(role);
  }
  // Community cut: no role lattice available -> safe default is no role
  // differentiation for internal/sensitive (recall's documented stance);
  // secret-prohibited already handled above.
  return false;
}

// Redact a classified field value for a role, composing ENT-012's redactField
// when the class is redacted. secret-prohibited is ALWAYS replaced with the
// refusal marker (never the raw value), independent of the policy/cut. For
// internal/sensitive we use the class's ENT-012 redaction kind so the redaction
// SHAPE matches the rest of the cockpit (path -> basename, evidence -> marker).
const SECRET_REFUSAL = "[secret-prohibited: refused — secrets must never be stored in memory]";

// COORD-276: deep-redact a secret-prohibited value so the redaction APPLIES to
// the nested finding (not just a flag). A scalar/string secret collapses to the
// refusal marker. An object/array is rebuilt with each secret-bearing leaf
// replaced by the marker while benign siblings survive — so a nested secret is
// removed from the surfaced output without nuking unrelated structure. Bounded
// by the same depth cap + cycle guard as the detector; a cycle or over-depth
// branch collapses entirely to the marker (fail-closed, never the raw value).
function redactSecretsDeep(value, seen, depth) {
  if (value == null) {
    return value;
  }
  const t = typeof value;
  if (t === "string") {
    return stringLooksLikeSecret(value) ? SECRET_REFUSAL : value;
  }
  if (t === "number" || t === "boolean" || t === "bigint") {
    return stringLooksLikeSecret(String(value)) ? SECRET_REFUSAL : value;
  }
  if (t !== "object") {
    return value;
  }
  if (depth >= MAX_SCAN_DEPTH || seen.has(value)) {
    return SECRET_REFUSAL; // fail-closed on pathological/cyclic input
  }
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((el) => redactSecretsDeep(el, seen, depth + 1));
  } else {
    out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, seen, depth + 1);
    }
  }
  seen.delete(value);
  return out;
}

function redactClassifiedField(cls, fieldName, value, role, policy) {
  const klass = isClass(cls) ? cls : "sensitive";
  if (klass === "secret-prohibited") {
    // Object/array: deep-redact the offending leaf, keep benign siblings.
    if (value !== null && typeof value === "object") {
      return redactSecretsDeep(value, new Set(), 0);
    }
    return SECRET_REFUSAL;
  }
  if (!shouldRedactClass(klass, role, policy)) {
    return value;
  }
  const kind = CLASSES[klass].redactionKind;
  // Prefer the field's own ENT-012 kind for paths (basename redaction); fall
  // back to the class default kind.
  const useKind =
    String(fieldName || "").toLowerCase() === "path" ? "path" : kind || "evidence";
  if (policy && typeof policy.redactField === "function") {
    const redacted = policy.redactField(useKind, value, role);
    if (useKind === "path" && redacted === value && typeof value === "string") {
      const parts = value.split(/[\\/]/).filter(Boolean);
      return parts.length ? `.../${parts[parts.length - 1]}` : "[redacted]";
    }
    return redacted;
  }
  // Community-cut fallback (policy absent but redaction still required, i.e.
  // secret handled above already): mask conservatively.
  return "[redacted]";
}

module.exports = {
  CLASSES,
  CLASS_NAMES,
  MEMORY_SCOPES,
  SCOPE_NAMES,
  MEMORY_CONTROL_ACTIONS,
  READ_ONLY_MEMORY_CONTROL_ACTIONS,
  WRITE_MEMORY_CONTROL_ACTIONS,
  HISTORY_ONLY_STATUSES,
  SECRET_REFUSAL,
  isClass,
  isScope,
  isMemoryControlAction,
  normalizeScope,
  ATTRIBUTION_FIELDS,
  normalizeAttribution,
  validateSharedAttribution,
  classifyMemoryScope,
  canPromoteToShared,
  canGovernOtherAgents,
  validateSharedPromotion,
  normalizeMemoryStatus,
  isHistoryOnlyStatus,
  retrievalDecision,
  isClaimActiveForRetrieval,
  inspectMemoryClaim,
  auditMemoryClaim,
  buildMemoryControlRecord,
  applyMemoryControlRecord,
  redactMemorySurface,
  looksLikeSecret,
  classifyField,
  classifySource,
  shouldRedactClass,
  redactClassifiedField,
};
