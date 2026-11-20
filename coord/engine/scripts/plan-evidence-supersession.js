"use strict";

const { sha256Text } = require("./lifecycle-utils.js");
// COORD-718: independent reviews ride the same PLAN.md, validation and
// canonical-writer seams as the evidence ledgers, owned by their own module.
const independentReviews = require("./independent-reviews.js");
const managedExecution = require("./managed-execution-record.js");

const EVIDENCE_FIELDS = Object.freeze(Object.assign(Object.create(null), {
  repo_gate: "repo_gates",
  verification_command: "verification_commands",
  critical_invariant: "critical_invariants",
}));

function hasEvidenceKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_FIELDS, kind);
}

const REF_PATTERN = /^(repo_gate|verification_command|critical_invariant):([1-9][0-9]*):([a-f0-9]{64})$/;
const SUPERSESSION_ID_PATTERN = /^pes1-[a-f0-9]{64}$/;
const DISPOSITION_ID_PATTERN = /^ped1-[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`Plan evidence supersession ${message}`);
}

function evidenceRef(kind, index, value) {
  const field = EVIDENCE_FIELDS[kind];
  if (!hasEvidenceKind(kind)) fail(`has unsupported evidence kind ${JSON.stringify(kind)}.`);
  if (!Number.isInteger(index) || index < 1) fail("entry index must be a positive integer.");
  return `${kind}:${index}:${sha256Text(`plan-evidence/v1\0${kind}\0${index}\0${String(value)}`)}`;
}

function parseEvidenceRef(value) {
  const match = String(value || "").match(REF_PATTERN);
  if (!match) return null;
  return { kind: match[1], index: Number(match[2]), digest: match[3] };
}

function listEntries(record, kind) {
  const field = EVIDENCE_FIELDS[kind];
  if (!hasEvidenceKind(kind)) fail(`has unsupported evidence kind ${JSON.stringify(kind)}.`);
  const values = record?.[field] ?? [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    fail(`${field} must be an array of strings.`);
  }
  return values.map((value, offset) => ({
    kind,
    index: offset + 1,
    value,
    ref: evidenceRef(kind, offset + 1, value),
  }));
}

function stableSupersessionId(sourceRef, successorRef) {
  return `pes1-${sha256Text(`plan-evidence-supersession/v1\0${sourceRef}\0${successorRef}`)}`;
}

function stableDispositionId(sourceRef, disposition) {
  return `ped1-${sha256Text(`plan-evidence-disposition/v1\0${sourceRef}\0${disposition}`)}`;
}

function resolvePlanEvidence(record = {}) {
  const entries = [
    ...listEntries(record, "repo_gate"),
    ...listEntries(record, "verification_command"),
    ...listEntries(record, "critical_invariant"),
  ];
  const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
  const supersessions = record.evidence_supersessions ?? [];
  if (!Array.isArray(supersessions)) fail("ledger must be an array.");

  const superseded = new Set();
  const predecessor = new Map();
  const successors = new Set();
  const ids = new Set();
  const history = [];
  for (const [offset, relation] of supersessions.entries()) {
    if (!relation || typeof relation !== "object" || Array.isArray(relation)) {
      fail(`ledger entry ${offset + 1} must be an object.`);
    }
    const { id, kind, source_ref: sourceRef, successor_ref: successorRef, reason, actor, timestamp } = relation;
    const allowedKeys = new Set(["id", "kind", "source_ref", "successor_ref", "reason", "actor", "timestamp"]);
    if (Object.keys(relation).some((key) => !allowedKeys.has(key))) {
      fail(`ledger entry ${offset + 1} contains an unknown field.`);
    }
    const sourceParts = parseEvidenceRef(sourceRef);
    const successorParts = parseEvidenceRef(successorRef);
    if (!hasEvidenceKind(kind) || !sourceParts || !successorParts) {
      fail(`ledger entry ${offset + 1} has a malformed kind or evidence reference.`);
    }
    if (sourceParts.kind !== kind || successorParts.kind !== kind) {
      fail(`ledger entry ${offset + 1} crosses evidence kinds.`);
    }
    if (sourceRef === successorRef || successorParts.index <= sourceParts.index) {
      fail(`ledger entry ${offset + 1} is not an append-only forward link.`);
    }
    const source = byRef.get(sourceRef);
    const successor = byRef.get(successorRef);
    if (!source || !successor) fail(`ledger entry ${offset + 1} refers to an entry that does not exist.`);
    if (!SUPERSESSION_ID_PATTERN.test(String(id || "")) || id !== stableSupersessionId(sourceRef, successorRef)) {
      fail(`ledger entry ${offset + 1} has an invalid stable id.`);
    }
    if (ids.has(id)) fail(`ledger repeats id ${id}.`);
    if (superseded.has(sourceRef)) fail(`ledger forks from source ${sourceRef}.`);
    if (successors.has(successorRef)) fail(`ledger links multiple sources to successor ${successorRef}.`);
    if (typeof reason !== "string" || !reason.trim()) fail(`ledger entry ${offset + 1} needs a reason.`);
    if (typeof actor !== "string" || !actor.trim()) fail(`ledger entry ${offset + 1} needs an actor.`);
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      fail(`ledger entry ${offset + 1} needs a valid timestamp.`);
    }
    ids.add(id);
    superseded.add(sourceRef);
    successors.add(successorRef);
    predecessor.set(successorRef, sourceRef);
    history.push({
      id,
      kind,
      source: { ...source },
      successor: { ...successor },
      disposition: null,
      reason,
      actor,
      timestamp,
    });
  }

  const dispositions = record.evidence_dispositions ?? [];
  if (!Array.isArray(dispositions)) fail("dispositions ledger must be an array.");
  const disposed = new Set();
  for (const [offset, relation] of dispositions.entries()) {
    if (!relation || typeof relation !== "object" || Array.isArray(relation)) {
      fail(`disposition entry ${offset + 1} must be an object.`);
    }
    const { id, kind, source_ref: sourceRef, disposition, reason, actor, timestamp } = relation;
    const allowedKeys = new Set(["id", "kind", "source_ref", "disposition", "reason", "actor", "timestamp"]);
    if (Object.keys(relation).some((key) => !allowedKeys.has(key))) {
      fail(`disposition entry ${offset + 1} contains an unknown field.`);
    }
    const sourceParts = parseEvidenceRef(sourceRef);
    if (kind !== "critical_invariant" || !sourceParts || sourceParts.kind !== kind) {
      fail(`disposition entry ${offset + 1} has a malformed or unsupported kind or evidence reference.`);
    }
    if (disposition !== "retracted") fail(`disposition entry ${offset + 1} has an unsupported disposition.`);
    const source = byRef.get(sourceRef);
    if (!source) fail(`disposition entry ${offset + 1} refers to an entry that does not exist.`);
    if (!DISPOSITION_ID_PATTERN.test(String(id || "")) || id !== stableDispositionId(sourceRef, disposition)) {
      fail(`disposition entry ${offset + 1} has an invalid stable id.`);
    }
    if (ids.has(id)) fail(`ledger repeats id ${id}.`);
    if (disposed.has(sourceRef) || superseded.has(sourceRef)) {
      fail(`disposition entry ${offset + 1} conflicts with an existing correction for ${sourceRef}.`);
    }
    if (typeof reason !== "string" || !reason.trim()) fail(`disposition entry ${offset + 1} needs a reason.`);
    if (typeof actor !== "string" || !actor.trim()) fail(`disposition entry ${offset + 1} needs an actor.`);
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      fail(`disposition entry ${offset + 1} needs a valid timestamp.`);
    }
    ids.add(id);
    disposed.add(sourceRef);
    history.push({ id, kind, source: { ...source }, successor: null, disposition, reason, actor, timestamp });
  }
  for (const sourceRef of disposed) {
    if (superseded.has(sourceRef)) fail(`disposition conflicts with supersession of ${sourceRef}.`);
  }

  const lineageStart = (ref) => {
    let current = ref;
    while (predecessor.has(current)) current = predecessor.get(current);
    return parseEvidenceRef(current).index;
  };
  // Ledger validation admits disjoint linear chains only, so active entries
  // always have distinct lineage roots and this comparator cannot tie.
  const projectEntries = (kind) => listEntries(record, kind)
    .filter((entry) => !superseded.has(entry.ref) && !disposed.has(entry.ref))
    .sort((a, b) => lineageStart(a.ref) - lineageStart(b.ref));
  const repoGateEntries = projectEntries("repo_gate");
  const verificationCommandEntries = projectEntries("verification_command");
  const criticalInvariantEntries = projectEntries("critical_invariant");
  const invariantRelations = new Map(history
    .filter((item) => item.kind === "critical_invariant")
    .map((item) => [item.source.ref, item]));
  const criticalInvariantHistory = listEntries(record, "critical_invariant").map((entry) => {
    const relation = invariantRelations.get(entry.ref);
    return {
      source_ref: entry.ref,
      index: entry.index,
      value: entry.value,
      status: relation ? (relation.disposition || "superseded") : "active",
      disposition: relation?.disposition || null,
      successor: relation?.successor?.value || null,
      reason: relation?.reason || null,
      actor: relation?.actor || null,
      timestamp: relation?.timestamp || null,
    };
  });
  return {
    repo_gates: repoGateEntries.map((entry) => entry.value),
    verification_commands: verificationCommandEntries.map((entry) => entry.value),
    critical_invariants: criticalInvariantEntries.map((entry) => entry.value),
    current_entries: {
      repo_gates: repoGateEntries,
      verification_commands: verificationCommandEntries,
      critical_invariants: criticalInvariantEntries,
    },
    critical_invariant_history: criticalInvariantHistory,
    history,
  };
}

// COORD-822: selection reads the validated projection, so a retraction removes
// an entry from selection exactly as a supersession does. Active entries win an
// exact-text match; an inactive entry is chosen only when no active one matches
// and the caller allows that state (idempotent replay of its own correction).
function resolveEntrySelector(record, kind, selector, { allowSuperseded = false, allowRetracted = false } = {}) {
  if (typeof selector !== "string" || !selector.length) fail("requires a non-empty --entry selector.");
  const entries = listEntries(record, kind);
  const parsed = parseEvidenceRef(selector);
  const inactive = new Map(resolvePlanEvidence(record).history.map((item) => [item.source.ref, item.disposition || "superseded"]));
  const permitted = (entry) => {
    const state = inactive.get(entry.ref);
    return !state || (state === "superseded" ? allowSuperseded : allowRetracted);
  };
  if (parsed) {
    if (parsed.kind !== kind) fail(`selector kind does not match ${kind}.`);
    const entry = entries.find((candidate) => candidate.ref === selector);
    if (!entry) fail(`entry selector ${selector} does not match a recorded value.`);
    if (!permitted(entry)) {
      fail(inactive.get(selector) === "superseded"
        ? `entry selector ${selector} is already superseded; select its current successor.`
        : `entry selector ${selector} is already retracted and has no successor.`);
    }
    return entry;
  }
  if (/^(repo_gate|verification_command|critical_invariant):/.test(selector)) fail(`entry selector ${JSON.stringify(selector)} is malformed.`);
  const exact = entries.filter((entry) => entry.value === selector);
  const active = exact.filter((entry) => !inactive.has(entry.ref));
  const matches = active.length ? active : exact.filter(permitted);
  if (matches.length === 0) fail(`no current entry exactly matches ${JSON.stringify(selector)}.`);
  if (matches.length > 1) fail(`selector ${JSON.stringify(selector)} is ambiguous; use a stable entry reference.`);
  return matches[0];
}

// COORD-822: one definition of "identical replay", read from the plan record
// alone. The command checks it before opening a governed mutation, so a replay
// never journals regardless of later ticket status; the writers reuse it so an
// identical relation short-circuits and any other prior relation conflicts.
// Callers pass a validated record (resolveEntrySelector ran first) and strings.
function isIdenticalCorrection(record, { kind, sourceRef, replacement, disposition, reason }) {
  const reasonValue = String(reason).trim();
  if (disposition !== undefined) {
    const prior = (record.evidence_dispositions ?? []).find((relation) => relation.source_ref === sourceRef);
    return Boolean(prior) && prior.disposition === disposition && prior.reason === reasonValue;
  }
  const prior = (record.evidence_supersessions ?? []).find((relation) => relation.source_ref === sourceRef);
  if (!prior) return false;
  const successor = listEntries(record, kind).find((entry) => entry.ref === prior.successor_ref);
  return successor?.value === String(replacement).trim() && prior.reason === reasonValue;
}

function applySupersession(record, input = {}) {
  const kind = input.kind;
  const field = EVIDENCE_FIELDS[kind];
  const replacementValue = typeof input.replacement === "string" ? input.replacement.trim() : input.replacement;
  const reasonValue = typeof input.reason === "string" ? input.reason.trim() : input.reason;
  if (!hasEvidenceKind(kind)) fail(`has unsupported evidence kind ${JSON.stringify(kind)}.`);
  if (typeof replacementValue !== "string" || !replacementValue) fail("requires a non-empty replacement value.");
  if (typeof reasonValue !== "string" || !reasonValue) fail("requires a non-empty reason.");
  if (typeof input.actor !== "string" || !input.actor.trim()) fail("requires a non-empty actor.");

  const existingLedger = record.evidence_supersessions ?? [];
  const current = resolvePlanEvidence(record);
  const source = resolveEntrySelector(record, kind, input.entry, { allowSuperseded: true });
  if (source.value === replacementValue) fail("replacement must differ from the source value.");

  if (existingLedger.some((relation) => relation.source_ref === source.ref)) {
    if (isIdenticalCorrection(record, { kind, sourceRef: source.ref, replacement: replacementValue, reason: reasonValue })) {
      return { record, history: current.history, changed: false };
    }
    fail(`source ${source.ref} already has a conflicting successor.`);
  }
  const nextRecord = JSON.parse(JSON.stringify(record));
  nextRecord[field] = [...nextRecord[field], replacementValue];
  const successor = listEntries(nextRecord, kind).at(-1);
  const id = stableSupersessionId(source.ref, successor.ref);
  const timestamp = input.timestamp || new Date().toISOString();
  const relation = {
    id,
    kind,
    source_ref: source.ref,
    successor_ref: successor.ref,
    reason: reasonValue,
    actor: input.actor.trim(),
    timestamp,
  };
  nextRecord.evidence_supersessions = [...existingLedger, relation];
  const resolved = resolvePlanEvidence(nextRecord);
  return { record: nextRecord, relation, history: resolved.history, changed: true };
}

function applyInvariantRetraction(record, input = {}) {
  const kind = input.kind || "critical_invariant";
  if (kind !== "critical_invariant") fail("retraction is supported only for critical_invariant.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : input.reason;
  if (typeof reason !== "string" || !reason) fail("requires a non-empty reason.");
  if (typeof input.actor !== "string" || !input.actor.trim()) fail("requires a non-empty actor.");
  const current = resolvePlanEvidence(record);
  const source = resolveEntrySelector(record, kind, input.entry, { allowRetracted: true });
  const existing = record.evidence_dispositions ?? [];
  // resolvePlanEvidence validated this ledger before this append path.
  const prior = existing.find((relation) => relation.source_ref === source.ref);
  if (prior) {
    if (isIdenticalCorrection(record, { kind, sourceRef: source.ref, disposition: "retracted", reason })) {
      return { record, relation: prior, history: current.history, changed: false };
    }
    fail(`source ${source.ref} already has a conflicting disposition.`);
  }
  const timestamp = input.timestamp || new Date().toISOString();
  const relation = {
    id: stableDispositionId(source.ref, "retracted"),
    kind,
    source_ref: source.ref,
    disposition: "retracted",
    reason,
    actor: input.actor.trim(),
    timestamp,
  };
  const nextRecord = JSON.parse(JSON.stringify(record));
  nextRecord.evidence_dispositions = [...existing, relation];
  const result = resolvePlanEvidence(nextRecord);
  return { record: nextRecord, relation, history: result.history, changed: true };
}

function applySupersessionToRecord(record, input) {
  const result = applySupersession(record, input);
  if (result.changed) Object.assign(record, result.record);
}

function applyInvariantRetractionToRecord(record, input) {
  const result = applyInvariantRetraction(record, input);
  if (result.changed) Object.assign(record, result.record);
}

// The canonical writer delegates both correction forms to their owning module.
function applyCorrectionsToRecord(record, options) {
  if (options.evidenceSupersession) {
    applySupersessionToRecord(record, options.evidenceSupersession);
  }
  if (options.evidenceDisposition) {
    applyInvariantRetractionToRecord(record, options.evidenceDisposition);
  }
  if (options.independentReview !== undefined) independentReviews.applyIndependentReviewToRecord(record, options);
  // COORD-860: the managed-execution summary has one governed writer.
  if (options.managedExecution !== undefined) managedExecution.applyManagedExecutionToRecord(record, options, (message) => { throw new Error(message); });
}

function appendIfCorrectionBound(record, field, value) {
  const kind = Object.keys(EVIDENCE_FIELDS).find((candidate) => EVIDENCE_FIELDS[candidate] === field);
  if (!kind) return false;
  const hasSupersessions = Array.isArray(record.evidence_supersessions) && record.evidence_supersessions.length > 0;
  const hasDispositions = kind === "critical_invariant" && Array.isArray(record.evidence_dispositions) && record.evidence_dispositions.length > 0;
  if (!hasSupersessions && !hasDispositions) return false;
  const normalized = String(value || "").trim();
  const activeValues = resolvePlanEvidence(record)[field];
  if (normalized && !activeValues.some((entry) => String(entry || "").trim() === normalized)) {
    record[field] = [...(Array.isArray(record[field]) ? record[field] : []), normalized];
  }
  return true;
}

function readPlanEvidenceFromBlock(block, { readList, stripTicks, fail: reject }) {
  const supersessionValues = readList(block, "Evidence supersessions");
  const supersessions = supersessionValues.map((value, index) => {
    try {
      const relation = JSON.parse(value);
      if (!relation || typeof relation !== "object" || Array.isArray(relation)) {
        reject(`Plan record evidence supersessions entry ${index + 1} must be a JSON object.`);
      }
      return relation;
    } catch (error) {
      if (String(error.message || "").includes("evidence supersessions entry")) throw error;
      reject(`Could not parse plan record evidence supersessions entry ${index + 1}: ${error.message}`);
    }
  });
  const dispositionValues = readList(block, "Evidence dispositions");
  const dispositions = dispositionValues.map((value, index) => {
    try {
      const relation = JSON.parse(value);
      if (!relation || typeof relation !== "object" || Array.isArray(relation)) {
        reject(`Plan record evidence dispositions entry ${index + 1} must be a JSON object.`);
      }
      return relation;
    } catch (error) {
      if (String(error.message || "").includes("evidence dispositions entry")) throw error;
      reject(`Could not parse plan record evidence dispositions entry ${index + 1}: ${error.message}`);
    }
  });
  const readListField = (historyName, currentName) => {
    const history = readList(block, historyName);
    return (history.length ? history : readList(block, currentName)).map(stripTicks);
  };
  return {
    repo_gates: readListField("Repo gate history (append-only)", "Repo gates"),
    verification_commands: readListField("Verification command history (append-only)", "Verification commands"),
    critical_invariants: readListField("Critical invariant history (append-only)", "Critical invariants"),
    ...(supersessions.length ? { evidence_supersessions: supersessions } : {}),
    ...(dispositions.length ? { evidence_dispositions: dispositions } : {}),
    ...optionalField("independent_reviews", independentReviews.readIndependentReviewsFromBlock(block, { readList, fail: reject })),
    ...optionalField("review_submission", independentReviews.readReviewSubmissionFromBlock(block, { readList, fail: reject })),
  };
}

function optionalField(name, value) {
  return value === undefined ? {} : { [name]: value };
}

function renderPlanEvidenceSections(lines, record, pushList, kind) {
  const active = resolvePlanEvidence(record);
  if (kind === "invariants") {
    pushList(lines, "Critical invariants", active.critical_invariants);
    const hasInvariantHistory = (record.evidence_supersessions || []).some((relation) => relation.kind === "critical_invariant") ||
      (record.evidence_dispositions || []).length > 0;
    if (hasInvariantHistory) {
      pushList(lines, "Critical invariant history (append-only)", record.critical_invariants || []);
      lines.push("- Evidence dispositions:");
      for (const relation of record.evidence_dispositions || []) {
        const entry = active.history.find((item) => item.id === relation.id);
        lines.push(`  - ${JSON.stringify(relation)}`);
        lines.push(`    - History: ${JSON.stringify(entry?.source.value)} disposition=${relation.disposition}; reason=${JSON.stringify(relation.reason)}; actor=${JSON.stringify(relation.actor)}; timestamp=${relation.timestamp}`);
      }
    }
    return;
  }
  if (kind === "verification") {
    pushList(lines, "Verification commands", active.verification_commands, (value) => `\`${value}\``);
    if ((record.evidence_supersessions || []).length > 0) {
      pushList(lines, "Verification command history (append-only)", record.verification_commands || [], (value) => `\`${value}\``);
    }
    return;
  }
  pushList(lines, "Repo gates", active.repo_gates);
  if ((record.evidence_supersessions || []).length > 0) {
    pushList(lines, "Repo gate history (append-only)", record.repo_gates || []);
  }
  // COORD-822: active invariant refs are listed too, so an operator never
  // computes a retraction selector by hand.
  const identities = [
    ...active.current_entries.repo_gates,
    ...active.current_entries.verification_commands,
    ...active.current_entries.critical_invariants,
  ];
  if (identities.length > 0) {
    lines.push("- Evidence identities (derived):");
    for (const entry of identities) {
      lines.push(`  - ${entry.ref} = ${JSON.stringify(entry.value)}`);
    }
  }
  if ((record.evidence_supersessions || []).length > 0) {
    lines.push("- Evidence supersessions:");
    for (const relation of record.evidence_supersessions) {
      const history = active.history.find((entry) => entry.id === relation.id);
      lines.push(`  - ${JSON.stringify(relation)}`);
      lines.push(`    - History: ${JSON.stringify(history?.source.value)} superseded by ${JSON.stringify(history?.successor.value)}; reason=${JSON.stringify(relation.reason)}; actor=${JSON.stringify(relation.actor)}; timestamp=${relation.timestamp}`);
    }
  }
}

function validatePlanEvidenceRecord(record, reject) {
  try {
    resolvePlanEvidence(record);
  } catch (error) {
    reject(error.message);
  }
  independentReviews.validateIndependentReviewRecord(record, reject);
  managedExecution.validateManagedExecutionRecord(record, reject);
}

module.exports = {
  EVIDENCE_FIELDS,
  evidenceRef,
  parseEvidenceRef,
  stableSupersessionId,
  stableDispositionId,
  resolvePlanEvidence,
  resolveEntrySelector,
  isIdenticalCorrection,
  applySupersession,
  applyInvariantRetraction,
  applyInvariantRetractionToRecord,
  applySupersessionToRecord,
  applyCorrectionsToRecord,
  appendIfCorrectionBound,
  readPlanEvidenceFromBlock,
  renderPlanEvidenceSections,
  validatePlanEvidenceRecord,
  // COORD-718: PLAN.md renders the review ledger after the repo-gate section.
  renderIndependentReviewSection: independentReviews.renderIndependentReviewSection,
  renderReviewSubmissionSection: independentReviews.renderReviewSubmissionSection,
  renderManagedExecutionSection: managedExecution.renderManagedExecutionSection,
};
