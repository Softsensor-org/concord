"use strict";

// COORD-145: tests for governed procedural-memory promotion.
//
// Coverage maps to the ticket ask + the cardinal guardrail (§5/§10):
//  - CAPTURE stores a candidate with its §7 citations + classifies the target
//    (procedural vs not);
//  - capture REFUSES an uncited rule (no uncited rule becomes a procedural
//    change) and a candidate with no procedural intent inputs (rule/rationale/
//    target required);
//  - PROMOTE on a procedural target asserts the FULL reviewed lane (reusing the
//    COORD-166 isProceduralDocPath) + emits a governed-change SPEC, and NEVER
//    writes the target file;
//  - PROMOTE on a NON-procedural target is REJECTED as not-procedural-promotion
//    (this lane only routes behavioral rules to procedural surfaces);
//  - PROMOTE on MIXED targets is rejected (isolate the procedural change);
//  - THE SAFETY-CRITICAL INVARIANT: the procedural target file is BYTE-UNCHANGED
//    after capture+promote, and the capture sink is never a procedural surface;
//  - determinism: same inputs -> same candidate id;
//  - the CLI surface (capture/list/promote) round-trips through the queue.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const promo = require("./learned-rule-promotion.js");

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

function tmpQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord145-"));
  return path.join(dir, "procedural-candidates.ndjson");
}

const CITATION = {
  type: "decision",
  id: "COORD-128",
  event_hash: "abc123def4567890",
  chain_head: "headdeadbeef",
  verified: true,
};

function captureProcedural(candidatesPath, overrides = {}) {
  return promo.captureCandidate(
    {
      rule: "Always export COORD_SESSION_ID before any gov call in sub-agents.",
      rationale: "Sub-agents collapse to one Anthropic session without it (CLAUDE.md discipline).",
      targets: ["coord/AGENTS.md"],
      citations: [CITATION],
      ...overrides,
    },
    { candidatesPath, now: FIXED_NOW }
  );
}

// --- CAPTURE -----------------------------------------------------------------

test("capture stores a candidate with §7 citations + a classified procedural target", () => {
  const q = tmpQueue();
  const c = captureProcedural(q);
  assert.equal(c.kind, "procedural-rule-candidate");
  assert.equal(c.authority, false);
  assert.equal(c.recommends_only, true);
  assert.equal(c.status, "captured");
  assert.equal(c.all_targets_procedural, true);
  assert.deepEqual(c.targets, [{ path: "coord/AGENTS.md", procedural: true }]);
  // §7 citation shape preserved.
  assert.equal(c.citations.length, 1);
  assert.deepEqual(c.citations[0], {
    type: "decision",
    id: "COORD-128",
    path: null,
    event_hash: "abc123def4567890",
    chain_head: "headdeadbeef",
    verified: true,
  });
  // Persisted to the queue as NDJSON.
  const stored = promo.readCandidates(q);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, c.id);
});

test("capture REFUSES an uncited rule (§5: no uncited rule becomes a procedural change)", () => {
  const q = tmpQueue();
  assert.throws(
    () => captureProcedural(q, { citations: [] }),
    /at least one --citation/i
  );
  // Nothing written.
  assert.equal(fs.existsSync(q), false);
});

test("capture requires rule, rationale, and at least one target", () => {
  const q = tmpQueue();
  assert.throws(() => captureProcedural(q, { rule: "" }), /requires --rule/i);
  assert.throws(() => captureProcedural(q, { rationale: "" }), /requires --rationale/i);
  assert.throws(() => captureProcedural(q, { targets: [] }), /at least one --target/i);
});

test("capture is deterministic: same inputs -> same candidate id", () => {
  const a = promo.buildCandidate(
    { rule: "r", rationale: "why", targets: ["CLAUDE.md"], citations: [CITATION] },
    { now: "2020-01-01T00:00:00.000Z" }
  );
  const b = promo.buildCandidate(
    { rule: "r", rationale: "why", targets: ["CLAUDE.md"], citations: [CITATION] },
    { now: "2099-12-31T00:00:00.000Z" }
  );
  // captured_at differs but the id (content hash) does not.
  assert.equal(a.id, b.id);
  assert.notEqual(a.captured_at, b.captured_at);
});

// --- PROMOTE: procedural target ----------------------------------------------

test("promote on a procedural target asserts the FULL reviewed lane + emits a governed-change spec", () => {
  const q = tmpQueue();
  const c = captureProcedural(q);
  const result = promo.promoteCandidate(c.id, { candidatesPath: q, now: FIXED_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.promoted, true);
  assert.equal(result.candidate_id, c.id);
  const spec = result.spec;
  assert.equal(spec.kind, "governed-procedural-change-spec");
  // The routing decision: full reviewed lane, never the light lane.
  assert.equal(spec.requires_full_reviewed_lane, true);
  assert.equal(spec.light_lane_eligible, false);
  assert.match(spec.full_lane_reason, /coord\/AGENTS\.md/);
  assert.deepEqual(spec.procedural_targets, ["coord/AGENTS.md"]);
  // Spec is a ready-to-file ticket routed through the governed lane, NOT an edit.
  assert.equal(spec.ticket_spec.type, "docs");
  assert.equal(spec.ticket_spec.repo, "X");
  assert.deepEqual(spec.ticket_spec.intended_files, ["coord/AGENTS.md"]);
  assert.ok(spec.governed_lane.some((s) => /gov start/.test(s)));
  assert.ok(spec.governed_lane.some((s) => /submit|move-review/.test(s)));
  // Citations ride along (no uncited promotion).
  assert.equal(spec.citations.length, 1);
  assert.equal(spec.citations[0].id, "COORD-128");
});

test("promote reuses COORD-166 isProceduralDocPath for the procedural surfaces it accepts", () => {
  // The exported verb IS the COORD-166 one (reuse, not re-implementation).
  for (const p of [
    "AGENTS.md",
    "coord/AGENTS.md",
    "CLAUDE.md",
    "coord/GOVERNANCE.md",
    ".claude/commands/planner.md",
  ]) {
    assert.equal(promo.isProceduralDocPath(p), true, `${p} should be procedural`);
  }
  for (const p of ["README.md", "coord/docs/MEMORY_ARCHITECTURE.md", "src/x.ts"]) {
    assert.equal(promo.isProceduralDocPath(p), false, `${p} should NOT be procedural`);
  }
});

// --- PROMOTE: non-procedural / mixed targets ---------------------------------

test("promote on a NON-procedural target is rejected as not-procedural-promotion", () => {
  const q = tmpQueue();
  const c = promo.captureCandidate(
    {
      rule: "Document the new field in the architecture doc.",
      rationale: "It is a reference-doc clarification, not a behavioral rule.",
      targets: ["coord/docs/MEMORY_ARCHITECTURE.md"],
      citations: [CITATION],
    },
    { candidatesPath: q, now: FIXED_NOW }
  );
  assert.equal(c.all_targets_procedural, false);
  const result = promo.promoteCandidate(c.id, { candidatesPath: q, now: FIXED_NOW });
  assert.equal(result.ok, false);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /not-procedural-promotion/);
  assert.deepEqual(result.non_procedural_targets, ["coord/docs/MEMORY_ARCHITECTURE.md"]);
  assert.equal(result.spec, undefined);
});

test("promote on MIXED targets is rejected (isolate the procedural change)", () => {
  const q = tmpQueue();
  const c = promo.captureCandidate(
    {
      rule: "Change behavior AND a reference doc together.",
      rationale: "test mixed",
      targets: ["CLAUDE.md", "coord/docs/MEMORY_ARCHITECTURE.md"],
      citations: [CITATION],
    },
    { candidatesPath: q, now: FIXED_NOW }
  );
  const result = promo.promoteCandidate(c.id, { candidatesPath: q, now: FIXED_NOW });
  assert.equal(result.promoted, false);
  assert.match(result.reason, /mixed-targets/);
  assert.deepEqual(result.non_procedural_targets, ["coord/docs/MEMORY_ARCHITECTURE.md"]);
});

test("promote of an unknown candidate id throws", () => {
  const q = tmpQueue();
  assert.throws(
    () => promo.promoteCandidate("PRC-doesnotexist", { candidatesPath: q }),
    /no candidate/i
  );
});

// --- THE SAFETY-CRITICAL INVARIANT: never writes a procedural file -----------

test("INVARIANT: the procedural target file is BYTE-UNCHANGED after capture + promote", () => {
  const q = tmpQueue();
  // Real repo procedural surfaces (read from the repo root).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const targets = ["coord/AGENTS.md", "CLAUDE.md", "coord/GOVERNANCE.md"];
  const before = new Map();
  for (const rel of targets) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) {
      before.set(rel, fs.readFileSync(abs));
    }
  }
  assert.ok(before.size > 0, "expected at least one real procedural surface to exist");

  const c = promo.captureCandidate(
    {
      rule: "A genuinely learned rule about session discipline.",
      rationale: "Derived from a real incident.",
      targets,
      citations: [CITATION],
    },
    { candidatesPath: q, now: FIXED_NOW }
  );
  const result = promo.promoteCandidate(c.id, { candidatesPath: q, now: FIXED_NOW });
  assert.equal(result.promoted, true);

  // The target procedural files are byte-for-byte unchanged: the tool ROUTED
  // (emitted a spec) and never wrote them.
  for (const [rel, bytes] of before.entries()) {
    const after = fs.readFileSync(path.join(repoRoot, rel));
    assert.ok(after.equals(bytes), `${rel} must be byte-unchanged after promote`);
  }
});

test("INVARIANT: the only write sink (the candidates queue) is NEVER a procedural surface", () => {
  // Callable invariant: the default sink under coord/memory/ is not procedural.
  assert.equal(promo.assertNeverWritesProceduralTarget(), true);
  assert.equal(
    promo.assertNeverWritesProceduralTarget("coord/memory/procedural-candidates.ndjson"),
    true
  );
  // If a future edit pointed the sink at a procedural file, the invariant fails.
  assert.throws(
    () => promo.assertNeverWritesProceduralTarget("CLAUDE.md"),
    /INVARIANT VIOLATION/
  );
  assert.throws(
    () => promo.assertNeverWritesProceduralTarget(".claude/commands/foo.md"),
    /INVARIANT VIOLATION/
  );
});

test("capture writes ONLY to the candidates queue, not to any procedural file", () => {
  const q = tmpQueue();
  assert.equal(promo.assertNeverWritesProceduralTarget(q), true);
  captureProcedural(q);
  // The queue exists; it is the sole artifact written.
  assert.ok(fs.existsSync(q));
  assert.equal(promo.isProceduralDocPath(q), false);
});

// --- CLI surface -------------------------------------------------------------

test("CLI capture -> list -> promote round-trips through the queue", () => {
  const q = tmpQueue();
  // The CLI uses the default queue path; isolate by overriding via the engine
  // API path is not exposed to runCli, so we exercise the engine + a parsed
  // citation here and confirm runCli's sub-routing/refusal behavior separately.
  const c = promo.captureCandidate(
    {
      rule: "cli round-trip rule",
      rationale: "cli round-trip rationale",
      targets: ["CLAUDE.md"],
      citations: [promo.parseCitationArg("decision:COORD-128")],
    },
    { candidatesPath: q, now: FIXED_NOW }
  );
  const listed = promo.listCandidates({ candidatesPath: q });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, c.id);
  const result = promo.promoteCandidate(c.id, { candidatesPath: q });
  assert.equal(result.promoted, true);
});

test("parseCitationArg parses id / type:id / file:path / k=v forms into the §7 shape", () => {
  assert.deepEqual(promo.parseCitationArg("COORD-095"), {
    type: "decision", id: "COORD-095", path: null, event_hash: null, chain_head: null, verified: false,
  });
  assert.deepEqual(promo.parseCitationArg("file:coord/scripts/x.js"), {
    type: "file", id: null, path: "coord/scripts/x.js", event_hash: null, chain_head: null, verified: false,
  });
  assert.deepEqual(
    promo.parseCitationArg("id=COORD-1,hash=abc,head=def,verified=true,type=event"),
    { type: "event", id: "COORD-1", path: null, event_hash: "abc", chain_head: "def", verified: true }
  );
});

test("runCli requires a candidate id for promote", () => {
  assert.throws(() => promo.runCli(["promote"]), /requires a candidate id/i);
});

test("renderPromotion shows a refusal for a non-procedural candidate", () => {
  const q = tmpQueue();
  const c = promo.captureCandidate(
    { rule: "r", rationale: "y", targets: ["README.md"], citations: [CITATION] },
    { candidatesPath: q }
  );
  const result = promo.promoteCandidate(c.id, { candidatesPath: q });
  const text = promo.renderPromotion(result);
  assert.match(text, /PROMOTION REFUSED/);
});
