"use strict";

// COORD-085 (Wave 4 slice 1): behavior tests for the READ-ONLY governance
// doctor REPORTING surface (doctor-report.js) — scope resolution
// (resolveDoctorScope / resolveDoctorOwnerScope), the ticket-scoped
// resolution-guidance builder, and the canonical-derived drift report builder.
// These are the deep doctor-report assertions relocated out of
// governance.test.js when the report surface was extracted from lifecycle.js
// (the MUTATING repair behavior tests stay with doctor-recovery). They reach
// the report surface through the stable governance.js __testing facade, which
// re-exports the doctor-report factory bindings.

const test = require("node:test");
const assert = require("node:assert/strict");

// Hermetic session env: the scope-self test below asserts the no-active-claim
// branch, so strip any ambient provider session/thread id the host injects
// (e.g. Claude Code exports CLAUDE_CODE_SESSION_ID) before requiring the
// governance facade — otherwise a live claim leaks an owner handle into the
// resolveDoctorOwnerScope({ scopeSelf: true }) result. Mirrors the same guard
// at the top of governance.test.js.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.COORD_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;

test("buildDoctorResolutionGuidance adds a QUESTIONS.md reminder for ticket-scoped doctor issues", () => {
  const guidance = __testing.buildDoctorResolutionGuidance([
    "Ticket IMP-245 is doing but has no lock.",
    "backend missing doing worktree for DEBT-042",
  ]);

  assert.match(guidance, /Ticket-scoped governance issues must be closed with a recorded resolution in coord\/QUESTIONS\.md/);
  assert.match(guidance, /Affected tickets: IMP-245, DEBT-042|Affected tickets: DEBT-042, IMP-245/);
  assert.match(guidance, /coord\/scripts\/gov log-question --from <agent> --to orchestrator/);
});

test("resolveDoctorScope narrows ticket-scoped doctor rows without discarding dependency context", () => {
  const board = {
    sections: [
      {
        rows: [
          { ID: "FE-045", Repo: "F", Status: "done", Owner: "codexa00", "Depends On": "FE-019" },
          { ID: "FE-019", Repo: "F", Status: "done", Owner: "codexa00", "Depends On": "" },
        ],
      },
    ],
  };

  const scope = __testing.resolveDoctorScope(board, "FE-045");

  assert.equal(scope.targetRef.row.ID, "FE-045");
  assert.deepEqual(scope.rows.map((row) => row.ID), ["FE-045"]);
  assert.equal(scope.byId.get("FE-019").ID, "FE-019");
});

test("buildDoctorResolutionGuidance stays empty for non-ticket doctor issues", () => {
  assert.equal(__testing.buildDoctorResolutionGuidance([
    "frontend unknown ticket worktree: /tmp/ebmr-review",
    "Invalid governance event log entry in coord/.runtime/governance-events.ndjson: unexpected token",
  ]), "");
});

test("resolveDoctorOwnerScope returns null when neither --owner nor --scope-self is set", () => {
  assert.equal(__testing.resolveDoctorOwnerScope({}), null);
  assert.equal(__testing.resolveDoctorOwnerScope({ owner: "" }), null);
  assert.equal(__testing.resolveDoctorOwnerScope({ scopeSelf: false }), null);
});

test("resolveDoctorOwnerScope returns null when --scope-self is set but no claimed session exists", () => {
  // No agent state mutation needed: ensureCurrentAgentIdentity throws
  // NoActiveClaimedSessionError when the current thread has no active claim,
  // which the helper catches and converts to a null scope (i.e. unfiltered doctor).
  const original = process.env.AGENT_THREAD_ID;
  process.env.AGENT_THREAD_ID = `scope-self-test-${Date.now()}`;
  try {
    assert.equal(__testing.resolveDoctorOwnerScope({ scopeSelf: true }), null);
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_THREAD_ID;
    } else {
      process.env.AGENT_THREAD_ID = original;
    }
  }
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError is null on clean state (no false positive)", () => {
  assert.equal(__testing.buildCanonicalDerivedDriftError([]), null);
  assert.equal(__testing.buildCanonicalDerivedDriftError(null), null);
  assert.equal(__testing.buildCanonicalDerivedDriftError(undefined), null);
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError names every drifting path + remediation", () => {
  const msg = __testing.buildCanonicalDerivedDriftError([
    "rendered/TASKS.md",
    "PLAN.md",
  ]);
  assert.match(msg, /Canonical derived artifacts drift from HEAD on 2 path\(s\)/);
  // Both paths surfaced, sorted (PLAN.md before rendered/TASKS.md).
  assert.match(msg, /PLAN\.md, rendered\/TASKS\.md/);
  // Remediation pointer to gov sync --commit (not gov recover; this is
  // derived-state drift, not journal/lock drift).
  assert.match(msg, /gov sync --commit/);
  // Mentions the slice-2 opt-out so operators learn the connection.
  assert.match(msg, /--no-sync/);
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError is deterministic on path order", () => {
  // Input order should not affect the formatted message — it sorts before
  // formatting, so two runs with the same set produce identical output.
  const a = __testing.buildCanonicalDerivedDriftError([
    "rendered/TASKS.md",
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
  ]);
  const b = __testing.buildCanonicalDerivedDriftError([
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ]);
  assert.equal(a, b);
});
