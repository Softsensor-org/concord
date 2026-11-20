"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evidenceRef,
  stableSupersessionId,
  stableDispositionId,
  applyInvariantRetraction,
  applySupersession,
  applySupersessionToRecord,
  appendIfCorrectionBound,
  resolveEntrySelector,
  resolvePlanEvidence,
  readPlanEvidenceFromBlock,
  renderPlanEvidenceSections,
  validatePlanEvidenceRecord,
} = require("./plan-evidence-supersession.js");
const { createReviewCloseoutGate } = require("./gates/review-closeout.js");

const actor = "codexa756";
const timestamp = "2026-10-05T19:30:00.000Z";

function record(overrides = {}) {
  return {
    repo_gates: ["npm test - result=pass", "npm test - result=pass", "npm run gate - result=pass"],
    verification_commands: ["node --test old.test.js", "npm run verify"],
    critical_invariants: ["timing probe 1", "keep a real invariant", "probe A"],
    ...overrides,
  };
}

function supersede(target, kind, index, replacement, reason = "The recorded command targeted an obsolete source head.") {
  return applySupersession(target, {
    kind,
    entry: evidenceRef(kind, index, target[kind === "repo_gate" ? "repo_gates" : "verification_commands"][index - 1]),
    replacement,
    reason,
    actor,
    timestamp,
  });
}

test("legacy identity is stable on append and distinguishes duplicate values by ordinal", () => {
  const initial = record({ repo_gates: ["same", "same"] });
  const first = evidenceRef("repo_gate", 1, "same");
  const second = evidenceRef("repo_gate", 2, "same");
  assert.notEqual(first, second);
  assert.equal(evidenceRef("repo_gate", 1, "same"), first);
  assert.equal(evidenceRef("repo_gate", 1, "same"), evidenceRef("repo_gate", 1, initial.repo_gates[0]));
  assert.notEqual(evidenceRef("repo_gate", 3, "next"), first);
});

test("inherited object property names are refused as evidence kinds", () => {
  for (const kind of ["__proto__", "constructor", "toString"]) {
    assert.throws(() => evidenceRef(kind, 1, "value"), /unsupported evidence kind/);
    assert.throws(() => resolveEntrySelector(record(), kind, "value"), /unsupported evidence kind/);
    assert.throws(() => applySupersession(record(), { kind, entry: "value", replacement: "next", reason: "fix", actor }), /unsupported evidence kind/);
  }
});

test("invalid stable selectors and correction fields are refused with specific guards", () => {
  assert.throws(() => evidenceRef("repo_gate", 0, "value"), /positive integer/);
  assert.throws(() => evidenceRef("repo_gate", 1.5, "value"), /positive integer/);

  const input = record();
  const verificationRef = evidenceRef("verification_command", 1, input.verification_commands[0]);
  assert.throws(() => resolveEntrySelector(input, "repo_gate", verificationRef), /selector kind does not match/);
  assert.throws(
    () => resolveEntrySelector(input, "repo_gate", `repo_gate:99:${"0".repeat(64)}`),
    /does not match a recorded value/,
  );

  const valid = {
    kind: "repo_gate",
    entry: evidenceRef("repo_gate", 1, input.repo_gates[0]),
    replacement: "replacement gate",
    reason: "correct the source head",
    actor,
  };
  for (const [field, value, expected] of [
    ["replacement", 4, /non-empty replacement value/],
    ["replacement", "  ", /non-empty replacement value/],
    ["reason", 4, /non-empty reason/],
    ["reason", "  ", /non-empty reason/],
    ["actor", 4, /non-empty actor/],
    ["actor", "  ", /non-empty actor/],
  ]) {
    assert.throws(() => applySupersession(input, { ...valid, [field]: value }), expected);
  }
  assert.throws(
    () => applySupersession(input, { ...valid, replacement: input.repo_gates[0] }),
    /replacement must differ from the source value/,
  );

  const withoutTimestamp = applySupersession(input, valid);
  assert.equal(withoutTimestamp.changed, true);
  assert.ok(Number.isFinite(Date.parse(withoutTimestamp.relation.timestamp)));
});

test("supersession appends a successor and preserves current, historical, and unrelated entries", () => {
  const original = record();
  const before = JSON.parse(JSON.stringify(original));
  const result = supersede(original, "repo_gate", 1, "npm test - commit=abc123 - result=pass");

  assert.equal(result.changed, true);
  assert.deepEqual(original, before, "the pure writer must not mutate its input");
  assert.deepEqual(result.record.repo_gates.slice(0, 3), original.repo_gates);
  assert.deepEqual(result.record.verification_commands, original.verification_commands);
  assert.equal(result.record.repo_gates.length, 4);
  const projection = resolvePlanEvidence(result.record);
  assert.deepEqual(projection.repo_gates, [
    "npm test - commit=abc123 - result=pass",
    "npm test - result=pass",
    "npm run gate - result=pass",
  ]);
  assert.equal(projection.history.length, 1);
  assert.equal(projection.history[0].source.value, original.repo_gates[0]);
  assert.equal(projection.history[0].successor.value, "npm test - commit=abc123 - result=pass");
  assert.equal(projection.history[0].reason, "The recorded command targeted an obsolete source head.");
  assert.equal(projection.history[0].actor, actor);
  assert.equal(projection.history[0].timestamp, timestamp);
});

test("critical-invariant supersession history retains its successor in the derived history view", () => {
  const original = record({ critical_invariants: ["obsolete invariant", "keep this invariant"] });
  const sourceRef = evidenceRef("critical_invariant", 1, "obsolete invariant");
  const result = applySupersession(original, {
    kind: "critical_invariant",
    entry: sourceRef,
    replacement: "replacement invariant",
    reason: "The previous statement was too broad.",
    actor,
    timestamp,
  });

  assert.deepEqual(resolvePlanEvidence(result.record).critical_invariants, ["replacement invariant", "keep this invariant"]);
  assert.deepEqual(resolvePlanEvidence(result.record).critical_invariant_history[0], {
    source_ref: sourceRef,
    index: 1,
    value: "obsolete invariant",
    status: "superseded",
    disposition: null,
    successor: "replacement invariant",
    reason: "The previous statement was too broad.",
    actor,
    timestamp,
  });
});

test("terminal invariant retraction retains history but removes the junk value from active evidence", () => {
  const original = record({
    critical_invariants: ["timing probe 1", "Canonical state stays journaled.", "probe A"],
  });
  const sourceRef = evidenceRef("critical_invariant", 1, original.critical_invariants[0]);
  const result = applyInvariantRetraction(original, {
    entry: sourceRef,
    reason: "Recorded timing-probe text was not an invariant and must not count toward readiness.",
    actor,
    timestamp,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(original.critical_invariants, ["timing probe 1", "Canonical state stays journaled.", "probe A"]);
  assert.deepEqual(result.record.critical_invariants, original.critical_invariants, "the append-only historical array keeps every original byte-value");
  assert.deepEqual(resolvePlanEvidence(result.record).critical_invariants, ["Canonical state stays journaled.", "probe A"]);
  assert.deepEqual(result.record.evidence_dispositions, [{
    id: stableDispositionId(sourceRef, "retracted"),
    kind: "critical_invariant",
    source_ref: sourceRef,
    disposition: "retracted",
    reason: "Recorded timing-probe text was not an invariant and must not count toward readiness.",
    actor,
    timestamp,
  }]);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].source.value, "timing probe 1");
  assert.equal(result.history[0].successor, null);
  assert.equal(result.history[0].disposition, "retracted");
  assert.equal(result.history[0].reason, result.record.evidence_dispositions[0].reason);
  assert.equal(result.history[0].actor, actor);
  assert.equal(result.history[0].timestamp, timestamp);
  assert.deepEqual(resolvePlanEvidence(result.record).critical_invariant_history.map(({ value, status, disposition, reason, actor }) => ({ value, status, disposition, reason, actor })), [
    {
      value: "timing probe 1",
      status: "retracted",
      disposition: "retracted",
      reason: "Recorded timing-probe text was not an invariant and must not count toward readiness.",
      actor,
    },
    { value: "Canonical state stays journaled.", status: "active", disposition: null, reason: null, actor: null },
    { value: "probe A", status: "active", disposition: null, reason: null, actor: null },
  ]);
  assert.deepEqual(resolvePlanEvidence(result.record).repo_gates, original.repo_gates);
  assert.deepEqual(resolvePlanEvidence(result.record).verification_commands, original.verification_commands);

  const replay = applyInvariantRetraction(result.record, {
    entry: sourceRef,
    reason: result.record.evidence_dispositions[0].reason,
    actor,
    timestamp: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(replay.changed, false, "identical intent is idempotent even when the retry timestamp differs");
  assert.equal(replay.record, result.record);
});

test("terminal invariant retraction refuses malformed, ambiguous, conflicting, and non-invariant dispositions", () => {
  const input = record({ critical_invariants: ["duplicate", "duplicate"] });
  const before = structuredClone(input);
  assert.throws(() => applyInvariantRetraction(input, { entry: "duplicate", reason: "wrong", actor }), /ambiguous/);
  assert.throws(() => applyInvariantRetraction(input, { entry: "critical_invariant:1:bad", reason: "wrong", actor }), /malformed/);
  assert.throws(() => applyInvariantRetraction(input, { kind: "repo_gate", entry: "x", reason: "wrong", actor }), /only for critical_invariant/);
  assert.throws(() => applyInvariantRetraction(input, { entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: " ", actor }), /non-empty reason/);
  assert.throws(() => applyInvariantRetraction(input, { entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: 17, actor }), /non-empty reason/);
  assert.throws(() => applyInvariantRetraction(input, { entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: "valid", actor: 17 }), /non-empty actor/);
  assert.throws(() => resolvePlanEvidence({ ...input, evidence_dispositions: {} }), /dispositions ledger must be an array/);
  assert.throws(() => applyInvariantRetraction({ ...input, evidence_dispositions: {} }, {
    entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: "valid", actor,
  }), /dispositions ledger must be an array/);
  assert.deepEqual(input, before, "refusals must occur before any durable or caller-visible write");

  const first = applyInvariantRetraction(input, {
    entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: "not an invariant", actor, timestamp,
  });
  assert.throws(() => applyInvariantRetraction(first.record, {
    entry: evidenceRef("critical_invariant", 1, "duplicate"), reason: "conflicting disposition", actor,
  }), /conflicting disposition/);
  assert.equal(resolvePlanEvidence(first.record).critical_invariants[0], "duplicate", "the duplicate value at ordinal 2 remains active");
});

test("review readiness counts active invariants only after terminal retraction", () => {
  const input = record({ critical_invariants: ["timing probe 1", "A real invariant remains active."] });
  const corrected = applyInvariantRetraction(input, {
    entry: evidenceRef("critical_invariant", 1, input.critical_invariants[0]),
    reason: "The timing probe is measurement text, not an invariant.",
    actor,
    timestamp,
  }).record;
  const gate = createReviewCloseoutGate({
    coordDir: "/tmp/coord807-readiness-fixture",
    effectiveTierMinimum: (_tier, key, fallback) => key === "min_critical_invariants" ? 2 : (key === "min_feature_proofs" ? 0 : fallback),
    fieldHasMeaningfulValue: (values) => Array.isArray(values) && values.some((value) => String(value || "").trim()),
    isMeaningfulText: (value) => typeof value === "string" && value.trim().length > 0,
    isTestingInfrastructureTicket: () => true,
    parseSelfReviewCycles: () => [],
    requiresFeatureProofGovernance: () => false,
    resolveTicketTier: () => ({ tier: "standard" }),
    classifyReviewLensBuckets: () => new Set(),
    normalizeReviewVerdict: (value) => value,
  });
  const issues = gate.collectClosureReadinessIssues("COORD-730", { Repo: "X" }, corrected, { metadata: {} }, {
    productRepo: true,
    requirementClosure: {
      ticket_ask: "repair an old plan record",
      implemented: "append-only disposition support",
      not_implemented: "no live correction performed",
      deferred_to: "none",
      closeout_verdict: "incomplete",
    },
  });
  assert.ok(issues.some((issue) => issue.code === "critical_invariants"), "the retracted string cannot satisfy the two-invariant readiness minimum");
  assert.deepEqual(resolvePlanEvidence(corrected).critical_invariants, ["A real invariant remains active."]);
});

test("raw-text selectors refuse duplicate ambiguity while stable references choose one entry", () => {
  const input = record({ repo_gates: ["duplicate", "duplicate"] });
  assert.throws(
    () => resolveEntrySelector(input, "repo_gate", "duplicate"),
    /ambiguous; use a stable entry reference/,
  );
  const firstRef = evidenceRef("repo_gate", 1, "duplicate");
  const secondRef = evidenceRef("repo_gate", 2, "duplicate");
  assert.equal(resolveEntrySelector(record(), "repo_gate", "npm run gate - result=pass").index, 3);
  assert.equal(resolveEntrySelector(input, "repo_gate", firstRef).index, 1);
  assert.equal(resolveEntrySelector(input, "repo_gate", secondRef).index, 2);
});

test("successive corrections form a chain and identical replay is a no-op", () => {
  const first = supersede(record(), "verification_command", 1, "node --test current.test.js");
  const second = supersede(first.record, "verification_command", 3, "node --test current.test.js --test-reporter=spec", "The first correction was still incomplete.");
  const replay = applySupersession(second.record, {
    kind: "verification_command",
    entry: second.relation.source_ref,
    replacement: "node --test current.test.js --test-reporter=spec",
    reason: "The first correction was still incomplete.",
    actor,
    timestamp: "2026-10-06T00:00:00.000Z",
  });

  assert.equal(replay.changed, false);
  assert.equal(replay.record, second.record);
  const normalizedReplay = applySupersession(second.record, {
    kind: "verification_command",
    entry: second.relation.source_ref,
    replacement: " node --test current.test.js --test-reporter=spec ",
    reason: "  The first correction was still incomplete.  ",
    actor,
  });
  assert.equal(normalizedReplay.changed, false);
  assert.equal(second.record.verification_commands.length, 4);
  const resolved = resolvePlanEvidence(second.record);
  assert.deepEqual(resolved.verification_commands, ["node --test current.test.js --test-reporter=spec", "npm run verify"]);
  assert.equal(resolved.history.length, 2);
  assert.equal(resolved.history[1].source.value, "node --test current.test.js");
});

test("conflicting reuse, malformed refs, missing refs, and invalid ledgers fail closed", () => {
  const applied = supersede(record(), "repo_gate", 1, "npm test @ abc123");
  assert.equal(resolveEntrySelector(applied.record, "repo_gate", record().repo_gates[0]).index, 2,
    "an exact-value alias resolves the remaining active duplicate after its first ordinal is superseded");
  assert.equal(resolveEntrySelector(applied.record, "repo_gate", "npm test @ abc123").index, 4);
  assert.throws(
    () => applySupersession(applied.record, {
      kind: "repo_gate",
      entry: applied.relation.source_ref,
      replacement: "npm test @ def456",
      reason: "Different correction",
      actor,
      timestamp,
    }),
    /already has a conflicting successor/,
  );
  assert.throws(() => resolveEntrySelector(record(), "repo_gate", "repo_gate:1:not-a-digest"), /malformed/);
  assert.throws(() => resolveEntrySelector(record(), "repo_gate", "missing command"), /no current entry/);
  assert.throws(() => resolveEntrySelector(record(), "repo_gate", ""), /non-empty --entry selector/);
  assert.throws(() => resolveEntrySelector(applied.record, "repo_gate", applied.relation.source_ref), /already superseded/);
  assert.throws(() => resolvePlanEvidence(record({ repo_gates: [1] })), /repo_gates must be an array of strings/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: {} })), /ledger must be an array/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: [{}] })), /malformed kind or evidence reference/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: [{ ...applied.relation, unknown: true }] })), /unknown field/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: [{ ...applied.relation, kind: "verification_command" }] })), /crosses evidence kinds/);
  const forked = {
    ...applied.record,
    repo_gates: [...applied.record.repo_gates, "another successor"],
    evidence_supersessions: [...applied.record.evidence_supersessions, {
      ...applied.relation,
      id: stableSupersessionId(applied.relation.source_ref, evidenceRef("repo_gate", 5, "another successor")),
      successor_ref: evidenceRef("repo_gate", 5, "another successor"),
    }],
  };
  assert.throws(() => resolvePlanEvidence(forked), /ledger forks from source/);
  const mergeRecord = record({ repo_gates: ["first source", "second source", "shared successor"] });
  const firstRef = evidenceRef("repo_gate", 1, mergeRecord.repo_gates[0]);
  const secondRef = evidenceRef("repo_gate", 2, mergeRecord.repo_gates[1]);
  const sharedRef = evidenceRef("repo_gate", 3, mergeRecord.repo_gates[2]);
  const relation = (sourceRef) => ({
    id: stableSupersessionId(sourceRef, sharedRef),
    kind: "repo_gate",
    source_ref: sourceRef,
    successor_ref: sharedRef,
    reason: "validate unique successor ownership",
    actor,
    timestamp,
  });
  assert.throws(() => resolvePlanEvidence({
    ...mergeRecord,
    evidence_supersessions: [relation(firstRef), relation(secondRef)],
  }), /ledger links multiple sources to successor/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: [{
    ...applied.relation,
    successor_ref: applied.relation.source_ref,
  }] })), /not an append-only forward link/);
  assert.throws(() => resolvePlanEvidence(record({ evidence_supersessions: [
    { ...applied.relation, successor_ref: "repo_gate:999:" + "0".repeat(64) },
  ] })), /entry that does not exist/);
  assert.throws(() => resolvePlanEvidence({
    ...applied.record,
    evidence_supersessions: [{ ...applied.relation, id: "pes1-" + "1".repeat(64) }],
  }), /invalid stable id/);
  for (const invalid of [
    { reason: " " },
    { actor: " " },
    { timestamp: "not a timestamp" },
  ]) {
    assert.throws(() => resolvePlanEvidence({
      ...applied.record,
      evidence_supersessions: [{ ...applied.relation, ...invalid }],
    }), /needs (a reason|an actor|a valid timestamp)/);
  }
  assert.throws(() => resolvePlanEvidence({
    ...applied.record,
    evidence_supersessions: [{ ...applied.relation, timestamp: "2026-01-01T00:00:00.000Z", extra: 1 }],
  }), /unknown field/);
});

test("not-required repo gate semantics remain in the active projection", () => {
  const result = supersede(record({ repo_gates: ["not-required"] }), "repo_gate", 1, "npm run full-gate");
  assert.deepEqual(resolvePlanEvidence(result.record).repo_gates, ["npm run full-gate"]);
  assert.equal(resolvePlanEvidence({ repo_gates: ["not-required"] }).repo_gates[0], "not-required");
});

test("plan-record adapter rejects malformed and non-object disposition history", () => {
  const read = (values, fail = (message) => { throw new Error(message); }) => readPlanEvidenceFromBlock("", {
    readList: (_block, name) => name === "Evidence dispositions" ? values : [],
    stripTicks: (value) => value,
    fail,
  });

  assert.throws(() => read(["not JSON"]), /Could not parse plan record evidence dispositions entry 1/);
  assert.throws(() => read(["null"]), /Plan record evidence dispositions entry 1 must be a JSON object/);
  assert.throws(() => read(["[]"]), /Plan record evidence dispositions entry 1 must be a JSON object/);

  const validDisposition = { id: "ped1-test", kind: "critical_invariant", disposition: "retracted" };
  assert.deepEqual(read([JSON.stringify(validDisposition)]).evidence_dispositions, [validDisposition]);

  let emptyFailureAttempts = 0;
  assert.throws(() => read(["null"], (message) => {
    throw new Error(emptyFailureAttempts++ === 0 ? "" : message);
  }), /Could not parse plan record evidence dispositions entry 1/);
});

test("plan-record adapters preserve raw history, escape multiline provenance, and validate stored ledgers", () => {
  const corrected = supersede(record(), "repo_gate", 1, "npm test @ abc123", "corrected\n- Repo gates: injected\n`|` section");
  const sections = [];
  const pushList = (lines, title, values, format = (value) => value) => {
    lines.push(`- ${title}:`);
    for (const value of values) lines.push(`  - ${format(value)}`);
  };
  renderPlanEvidenceSections(sections, corrected.record, pushList, "repo");
  assert.ok(sections.includes("- Repo gates:"));
  assert.ok(sections.includes("  - npm test @ abc123"));
  assert.ok(sections.includes(`  - ${record().repo_gates[0]}`));
  assert.ok(sections.some((line) => line.includes("reason=\"corrected\\n- Repo gates: injected\\n`|` section\"")));
  assert.ok(!sections.some((line) => line === "- Repo gates: injected"));

  const verificationRecord = supersede(record(), "verification_command", 1, "node --test current.test.js").record;
  const verificationSections = [];
  renderPlanEvidenceSections(verificationSections, verificationRecord, pushList, "verification");
  assert.ok(verificationSections.includes("- Verification commands:"));
  assert.ok(verificationSections.includes("  - `node --test current.test.js`"));
  assert.ok(verificationSections.includes("- Verification command history (append-only):"));
  assert.ok(verificationSections.includes("  - `node --test old.test.js`"));

  const stored = readPlanEvidenceFromBlock("", {
    readList: (_block, name) => ({
      "Evidence supersessions": [JSON.stringify(corrected.relation)],
      "Repo gate history (append-only)": ["`old`", "`other`", "`third`", "`npm test @ abc123`"],
      "Verification command history (append-only)": [],
      "Repo gates": ["filtered active value that must not replace raw history"],
      "Verification commands": ["`node verify`"],
    }[name] || []),
    stripTicks: (value) => value.replace(/^`|`$/g, ""),
    fail: (message) => { throw new Error(message); },
  });
  assert.deepEqual(stored.repo_gates, ["old", "other", "third", "npm test @ abc123"]);
  assert.deepEqual(stored.verification_commands, ["node verify"]);
  assert.deepEqual(stored.evidence_supersessions, [corrected.relation]);
  assert.doesNotThrow(() => validatePlanEvidenceRecord(corrected.record, (message) => { throw new Error(message); }));
  assert.throws(() => validatePlanEvidenceRecord({ ...corrected.record, evidence_supersessions: [null] }, (message) => { throw new Error(message); }), /must be an object/);
  assert.throws(() => readPlanEvidenceFromBlock("", {
    readList: (_block, name) => name === "Evidence supersessions" ? ["not json"] : [],
    stripTicks: (value) => value,
    fail: (message) => { throw new Error(message); },
  }), /Could not parse plan record evidence supersessions entry 1/);
  assert.throws(() => readPlanEvidenceFromBlock("", {
    readList: (_block, name) => name === "Evidence supersessions" ? ["null"] : [],
    stripTicks: (value) => value,
    fail: (message) => { throw new Error(message); },
  }), /must be a JSON object/);
  let emptyFailureAttempts = 0;
  assert.throws(() => readPlanEvidenceFromBlock("", {
    readList: (_block, name) => name === "Evidence supersessions" ? ["null"] : [],
    stripTicks: (value) => value,
    fail: (message) => { throw new Error(emptyFailureAttempts++ === 0 ? "" : message); },
  }), /Could not parse plan record evidence supersessions entry 1/);
});

test("record adapter short-circuits semantic replay and mutates only for a correction", () => {
  const target = record();
  const before = JSON.stringify(target);
  const input = {
    kind: "repo_gate",
    entry: evidenceRef("repo_gate", 1, target.repo_gates[0]),
    replacement: "new gate",
    reason: "replace old gate",
    actor,
    timestamp,
  };
  applySupersessionToRecord(target, input);
  assert.notEqual(JSON.stringify(target), before);
  const corrected = JSON.stringify(target);
  applySupersessionToRecord(target, { ...input, replacement: " new gate ", reason: " replace old gate " });
  assert.equal(JSON.stringify(target), corrected);
});

test("correction-bound appends preserve history and refuse no-op or duplicate appends", () => {
  const legacy = record();
  const originalLegacy = JSON.stringify(legacy);
  assert.equal(appendIfCorrectionBound(legacy, "repo_gates", "new gate"), false);
  assert.equal(appendIfCorrectionBound(legacy, "other_field", "new gate"), false);
  assert.equal(JSON.stringify(legacy), originalLegacy);

  const corrected = supersede(record(), "repo_gate", 1, "replacement gate").record;
  const oldHistory = [...corrected.repo_gates];
  assert.equal(appendIfCorrectionBound(corrected, "repo_gates", "replacement gate"), true);
  assert.deepEqual(corrected.repo_gates, oldHistory, "an already-active value is not appended again");
  assert.equal(appendIfCorrectionBound(corrected, "repo_gates", "  "), true);
  assert.deepEqual(corrected.repo_gates, oldHistory, "blank additions preserve the existing ledger-bound array");
  assert.equal(appendIfCorrectionBound(corrected, "repo_gates", null), true);
  assert.deepEqual(corrected.repo_gates, oldHistory, "falsey additions preserve the existing ledger-bound array");
  assert.equal(appendIfCorrectionBound(corrected, "repo_gates", "  later gate  "), true);
  assert.deepEqual(corrected.repo_gates, [...oldHistory, "later gate"]);
  assert.deepEqual(resolvePlanEvidence(corrected).repo_gates, ["replacement gate", record().repo_gates[1], record().repo_gates[2], "later gate"]);

  const missingOtherList = supersede(record(), "repo_gate", 1, "another replacement").record;
  delete missingOtherList.verification_commands;
  assert.equal(appendIfCorrectionBound(missingOtherList, "verification_commands", "node --test added.test.js"), true);
  assert.deepEqual(missingOtherList.verification_commands, ["node --test added.test.js"]);

  const legacyBlank = supersede(record({ repo_gates: ["", "old gate", "other gate"] }), "repo_gate", 2, "corrected gate").record;
  assert.equal(appendIfCorrectionBound(legacyBlank, "repo_gates", "fresh gate"), true);
  assert.equal(legacyBlank.repo_gates.at(-1), "fresh gate", "empty legacy entries remain safe during duplicate checks");
});

test("legacy compatibility parsing falls back to current lists and legacy rendering has no history section", () => {
  const stored = readPlanEvidenceFromBlock("", {
    readList: (_block, name) => ({
      "Evidence supersessions": [],
      "Repo gate history (append-only)": [],
      "Verification command history (append-only)": [],
      "Repo gates": ["current gate"],
      "Verification commands": ["`node --test current.test.js`"],
    }[name] || []),
    stripTicks: (value) => value.replace(/^`|`$/g, ""),
    fail: (message) => { throw new Error(message); },
  });
  assert.deepEqual(stored.repo_gates, ["current gate"]);
  assert.deepEqual(stored.verification_commands, ["node --test current.test.js"]);

  const sections = [];
  const pushList = (lines, title, values, format = (value) => value) => {
    lines.push(`- ${title}:`);
    for (const value of values) lines.push(`  - ${format(value)}`);
  };
  const legacy = record();
  renderPlanEvidenceSections(sections, legacy, pushList, "repo");
  renderPlanEvidenceSections(sections, legacy, pushList, "verification");
  assert.ok(sections.includes("- Repo gates:"));
  assert.ok(sections.includes("- Verification commands:"));
  assert.ok(!sections.some((line) => line.includes("history (append-only)")));

  const repoOnlyCorrection = supersede(record(), "repo_gate", 1, "repo successor").record;
  delete repoOnlyCorrection.verification_commands;
  const missingVerification = [];
  renderPlanEvidenceSections(missingVerification, repoOnlyCorrection, pushList, "verification");
  assert.ok(missingVerification.includes("- Verification command history (append-only):"));
  const verificationOnlyCorrection = supersede(record(), "verification_command", 1, "verify successor").record;
  delete verificationOnlyCorrection.repo_gates;
  const missingRepoGates = [];
  renderPlanEvidenceSections(missingRepoGates, verificationOnlyCorrection, pushList, "repo");
  assert.ok(missingRepoGates.includes("- Repo gate history (append-only):"));
});

// COORD-822: selectors resolve against the active projection, so a retraction
// is honoured exactly like a supersession when an operator selects by text.
test("COORD-822: retract-then-re-add selects the active ordinal by text and refuses the retracted ref", () => {
  const value = "keep a real invariant";
  const retracted = applyInvariantRetraction(record(), {
    entry: value, reason: "Restated after review.", actor, timestamp,
  }).record;
  const reAdded = { ...retracted, critical_invariants: [...retracted.critical_invariants, value] };
  const retractedRef = evidenceRef("critical_invariant", 2, value);
  const activeRef = evidenceRef("critical_invariant", 4, value);

  assert.equal(resolveEntrySelector(reAdded, "critical_invariant", value).ref, activeRef,
    "text selects the only active entry rather than reporting the retracted ordinal as ambiguous");
  assert.throws(() => resolveEntrySelector(reAdded, "critical_invariant", retractedRef), /already retracted/);
  assert.equal(resolveEntrySelector(reAdded, "critical_invariant", retractedRef, { allowRetracted: true }).ref, retractedRef);
  assert.throws(() => applySupersession(reAdded, {
    kind: "critical_invariant", entry: retractedRef, replacement: "a substitute", reason: "contradict", actor, timestamp,
  }), /already retracted/, "a retracted entry cannot be given a successor");

  const second = applyInvariantRetraction(reAdded, { entry: value, reason: "Withdrawn again.", actor, timestamp });
  assert.equal(second.changed, true);
  assert.equal(second.relation.source_ref, activeRef);
  assert.deepEqual(resolvePlanEvidence(second.record).critical_invariants, ["timing probe 1", "probe A"]);

  // Two active duplicates remain ambiguous; retracted history never adds a third candidate.
  const twoActive = { ...reAdded, critical_invariants: [...reAdded.critical_invariants, value] };
  assert.throws(() => resolveEntrySelector(twoActive, "critical_invariant", value), /ambiguous; use a stable entry reference/);
});

test("COORD-822: an exact-text replay of a retraction stays idempotent once no active entry matches", () => {
  const value = "probe A";
  const first = applyInvariantRetraction(record(), { entry: value, reason: "Measurement text.", actor, timestamp });
  const replay = applyInvariantRetraction(first.record, { entry: value, reason: "Measurement text.", actor, timestamp });
  assert.equal(replay.changed, false);
  assert.equal(replay.record, first.record);
  assert.throws(() => resolveEntrySelector(first.record, "critical_invariant", value), /no current entry exactly matches/,
    "without an explicit allowance a retracted value is not a current entry");
  // A supersession replay still resolves its superseded source when no active entry matches.
  const corrected = supersede(record(), "verification_command", 1, "node --test current.test.js");
  assert.equal(resolveEntrySelector(corrected.record, "verification_command", "node --test old.test.js", { allowSuperseded: true }).index, 1);
});

// COORD-822 (3): correction identity is (kind, source, successor-or-disposition,
// reason). actor and timestamp attribute the FIRST recording; a different-actor
// retry of the same intent is the same fact and does not rewrite attribution.
test("COORD-822: same- and different-actor retries of one correction keep the first attribution", () => {
  const retracted = applyInvariantRetraction(record(), { entry: "probe A", reason: "Measurement text.", actor, timestamp });
  for (const retryActor of [actor, "claudeb22"]) {
    const retry = applyInvariantRetraction(retracted.record, {
      entry: evidenceRef("critical_invariant", 3, "probe A"), reason: "Measurement text.", actor: retryActor, timestamp: "2026-10-13T00:00:00.000Z",
    });
    assert.equal(retry.changed, false);
    assert.equal(retry.relation.actor, actor);
    assert.equal(retry.relation.timestamp, timestamp);
  }
  const superseded = supersede(record(), "repo_gate", 1, "npm test @ abc123");
  const retry = applySupersession(superseded.record, {
    kind: "repo_gate", entry: superseded.relation.source_ref, replacement: "npm test @ abc123",
    reason: "The recorded command targeted an obsolete source head.", actor: "claudeb22", timestamp: "2026-10-13T00:00:00.000Z",
  });
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.record.evidence_supersessions, superseded.record.evidence_supersessions);
});

test("COORD-822: plan-record rendering exposes stable refs for active invariants", () => {
  const sections = [];
  const pushList = (lines, title, values, format = (value) => value) => {
    lines.push(`- ${title}:`);
    for (const value of values) lines.push(`  - ${format(value)}`);
  };
  const corrected = applyInvariantRetraction(record(), { entry: "probe A", reason: "Measurement text.", actor, timestamp }).record;
  renderPlanEvidenceSections(sections, corrected, pushList, "repo");
  const identities = sections.slice(sections.indexOf("- Evidence identities (derived):") + 1);
  for (const [index, value] of [[1, "timing probe 1"], [2, "keep a real invariant"]]) {
    assert.ok(identities.includes(`  - ${evidenceRef("critical_invariant", index, value)} = ${JSON.stringify(value)}`));
  }
  assert.ok(!identities.some((line) => line.includes(evidenceRef("critical_invariant", 3, "probe A"))), "retracted refs are history, not current identities");

  const invariantsOnly = [];
  renderPlanEvidenceSections(invariantsOnly, { critical_invariants: ["only invariant"] }, pushList, "repo");
  assert.deepEqual(invariantsOnly, [
    "- Repo gates:",
    "- Evidence identities (derived):",
    `  - ${evidenceRef("critical_invariant", 1, "only invariant")} = "only invariant"`,
  ]);
});
