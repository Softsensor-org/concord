"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, sandboxProcessRuntimeLocks } = require("./governance-test-utils.js");

// COORD-299: redirect this worker's coarse state-locks to an os.tmpdir() sandbox.
// The COORD-277 agent-state-lock tests below assert against the resolved lock dir
// (state.AGENT_STATE_LOCK_DIR), which now points inside this sandbox instead of the
// live coord/.agent-state.lock.
sandboxProcessRuntimeLocks();

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in governance-context.js — the stale directory
// lock reclaimer (tryReclaimStaleDirectoryLock). Exercised through the
// fully-wired `__testing` facade.


test("tryReclaimStaleDirectoryLock reclaims only stale directory locks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-stale-lock-"));
  const staleLock = path.join(tempDir, "stale.lock");
  const freshLock = path.join(tempDir, "fresh.lock");
  const deadOwnerLock = path.join(tempDir, "dead-owner.lock");
  fs.mkdirSync(staleLock, { recursive: true });
  fs.mkdirSync(freshLock, { recursive: true });
  fs.mkdirSync(deadOwnerLock, { recursive: true });
  fs.writeFileSync(path.join(deadOwnerLock, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    created_at: new Date().toISOString(),
  }, null, 2));
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(staleLock, staleAt, staleAt);

  assert.equal(__testing.tryReclaimStaleDirectoryLock(staleLock, 60_000), true);
  assert.equal(fs.existsSync(staleLock), false);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(freshLock, 60_000), false);
  assert.equal(fs.existsSync(freshLock), true);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(deadOwnerLock, 60_000), true);
  assert.equal(fs.existsSync(deadOwnerLock), false);
});

// COORD-270: a live, local lock owner must NEVER be age-reclaimed. The lock-dir
// mtime is stamped once at acquire and never refreshed, so a governed mutation
// that runs longer than *_STALE_MS (large sync + push / clock skew) must keep
// its lock — reclaiming it admits two concurrent journal appenders (the
// COORD-115/123 hash-chain corruption). Reclaim a KNOWN owner only when it is
// genuinely gone (dead pid / foreign host); fall back to age ONLY when ownership
// is undeterminable (no/legacy metadata with no pid) so recovery isn't bricked.
test("COORD-270: a live local owner is NOT reclaimed even when its lock is older than staleMs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord270-live-holder-"));
  const liveLock = path.join(tempDir, "live.lock");
  fs.mkdirSync(liveLock, { recursive: true });
  // Metadata for THIS process on THIS host — a genuinely-held lock.
  fs.writeFileSync(path.join(liveLock, "lock-owner.json"), JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    created_at: new Date().toISOString(),
  }, null, 2));
  // Age the lock far past staleMs — the bug condition (long-running mutation).
  const oldAt = new Date(Date.now() - 600_000);
  fs.utimesSync(liveLock, oldAt, oldAt);

  // The proof: age alone must NOT evict a live local holder.
  assert.equal(__testing.tryReclaimStaleDirectoryLock(liveLock, 60_000), false);
  assert.equal(fs.existsSync(liveLock), true);
});

test("COORD-270: a legacy lock (pid recorded, no host) owned by a live local pid is NOT age-reclaimed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord270-legacy-live-"));
  const legacyLive = path.join(tempDir, "legacy-live.lock");
  fs.mkdirSync(legacyLive, { recursive: true });
  // Pre-COORD-270 metadata shape: has a pid but no host field.
  fs.writeFileSync(path.join(legacyLive, "lock-owner.json"), JSON.stringify({
    pid: process.pid,
    created_at: new Date().toISOString(),
  }, null, 2));
  const oldAt = new Date(Date.now() - 600_000);
  fs.utimesSync(legacyLive, oldAt, oldAt);

  // Ownership IS determinable (pid present + alive) -> not reclaimable by age.
  assert.equal(__testing.tryReclaimStaleDirectoryLock(legacyLive, 60_000), false);
  assert.equal(fs.existsSync(legacyLive), true);
});

test("COORD-270: a foreign-host owner IS reclaimed even when its pid is alive locally and the lock is fresh", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord270-foreign-host-"));
  const foreignLock = path.join(tempDir, "foreign.lock");
  fs.mkdirSync(foreignLock, { recursive: true });
  // pid is THIS process (so isProcessAlive() returns true), but the owning host
  // differs — the lock owner cannot be us; treat as gone so recovery proceeds.
  fs.writeFileSync(path.join(foreignLock, "lock-owner.json"), JSON.stringify({
    pid: process.pid,
    host: `${os.hostname()}-some-other-host`,
    created_at: new Date().toISOString(),
  }, null, 2));
  // Fresh mtime — proves foreign-host reclaim does not depend on age.

  assert.equal(__testing.tryReclaimStaleDirectoryLock(foreignLock, 60_000), true);
  assert.equal(fs.existsSync(foreignLock), false);
});

test("COORD-270: a dead owner IS reclaimed (recovery preserved) regardless of lock age", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord270-dead-owner-"));
  const deadFresh = path.join(tempDir, "dead-fresh.lock");
  fs.mkdirSync(deadFresh, { recursive: true });
  fs.writeFileSync(path.join(deadFresh, "lock-owner.json"), JSON.stringify({
    pid: 999999, // not alive
    host: os.hostname(),
    created_at: new Date().toISOString(),
  }, null, 2));
  // Fresh mtime: dead-owner reclaim must not require age.
  assert.equal(__testing.tryReclaimStaleDirectoryLock(deadFresh, 60_000), true);
  assert.equal(fs.existsSync(deadFresh), false);
});

test("COORD-270: an unowned lock (no metadata / no pid) stays age-reclaimable so recovery isn't bricked", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord270-unowned-"));
  // No metadata at all (e.g. the agent-state lock writes none) — age governs.
  const noMeta = path.join(tempDir, "no-meta.lock");
  fs.mkdirSync(noMeta, { recursive: true });
  const oldAt = new Date(Date.now() - 600_000);
  fs.utimesSync(noMeta, oldAt, oldAt);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(noMeta, 60_000), true);
  assert.equal(fs.existsSync(noMeta), false);

  // Metadata present but with NO usable pid (legacy/corrupt) — also age-governed.
  const noPid = path.join(tempDir, "no-pid.lock");
  fs.mkdirSync(noPid, { recursive: true });
  fs.writeFileSync(path.join(noPid, "lock-owner.json"), JSON.stringify({
    kind: "coord-state",
    created_at: new Date().toISOString(),
  }, null, 2));
  fs.utimesSync(noPid, oldAt, oldAt);
  assert.equal(__testing.tryReclaimStaleDirectoryLock(noPid, 60_000), true);
  assert.equal(fs.existsSync(noPid), false);

  // ...but an unowned FRESH lock is left alone (not yet stale).
  const freshNoMeta = path.join(tempDir, "fresh-no-meta.lock");
  fs.mkdirSync(freshNoMeta, { recursive: true });
  assert.equal(__testing.tryReclaimStaleDirectoryLock(freshNoMeta, 60_000), false);
  assert.equal(fs.existsSync(freshNoMeta), true);
});

test("COORD-428: governance-runtime reclaim can require known owner metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord428-runtime-known-owner-"));
  const unknownOwner = path.join(tempDir, "unknown-owner.lock");
  fs.mkdirSync(unknownOwner, { recursive: true });
  const oldAt = new Date(Date.now() - 600_000);
  fs.utimesSync(unknownOwner, oldAt, oldAt);

  assert.equal(
    __testing.tryReclaimStaleDirectoryLock(unknownOwner, 60_000, { requireKnownOwner: true }),
    false
  );
  assert.equal(fs.existsSync(unknownOwner), true);

  const deadOwner = path.join(tempDir, "dead-owner.lock");
  fs.mkdirSync(deadOwner, { recursive: true });
  fs.writeFileSync(path.join(deadOwner, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    host: os.hostname(),
    created_at: new Date().toISOString(),
  }, null, 2));
  assert.equal(
    __testing.tryReclaimStaleDirectoryLock(deadOwner, 60_000, { requireKnownOwner: true }),
    true
  );
  assert.equal(fs.existsSync(deadOwner), false);
});

// COORD-223: nested-lock ordering invariant. The three governed locks must always
// be acquired outermost-first (governance-runtime > coord-state > agent-state); a
// coarser lock nested inside a finer one can deadlock and is fail-closed.
const governanceContext = require("./governance-context.js");

// COORD-251: the governance-runtime lock acquires a directory at
// state.GOVERNANCE_EVENT_LOCK_DIR (default: live coord/.runtime/governance.lock).
// Any test here that genuinely mkdir's that lock serialized against the rest of
// the parallel suite on the LIVE lock and intermittently timed out (30s). Point
// state.RUNTIME_DIR + state.GOVERNANCE_EVENT_LOCK_DIR at a throwaway dir for the
// duration of fn so the acquisition hits the sandbox lock, never the live one.
// (The coord-state / agent-state locks resolve to module-const dirs under
// coordDir and are not the contended governance.lock; out-of-order acquisitions
// fail-closed in assertLockOrder BEFORE any mkdir, so only the runtime-lock
// acquisition needs the sandbox.)
function withRuntimeLockSandbox(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord251-runtime-lock-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const { state } = governanceContext;
  const originalRuntimeDir = state.RUNTIME_DIR;
  const originalLockDir = state.GOVERNANCE_EVENT_LOCK_DIR;
  state.RUNTIME_DIR = runtimeDir;
  state.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  try {
    return fn();
  } finally {
    state.RUNTIME_DIR = originalRuntimeDir;
    state.GOVERNANCE_EVENT_LOCK_DIR = originalLockDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("COORD-223: canonical lock order — coarser-then-finer nesting is allowed", () => {
  withRuntimeLockSandbox(() => {
    const { withGovernanceRuntimeLock, withCoordStateLock, withAgentStateLock, state } =
      governanceContext;
    let reached = false;
    withGovernanceRuntimeLock(() => {
      withCoordStateLock(() => {
        withAgentStateLock(() => {
          reached = true;
          // All three depths are held simultaneously in canonical order.
          assert.equal(state.governanceEventLockDepth, 1);
          assert.equal(state.coordStateLockDepth, 1);
          assert.equal(state.agentStateLockDepth, 1);
        });
      });
    });
    assert.equal(reached, true);
    // Every lock released cleanly.
    assert.equal(state.governanceEventLockDepth, 0);
    assert.equal(state.coordStateLockDepth, 0);
    assert.equal(state.agentStateLockDepth, 0);
  });
});

test("COORD-223: out-of-order acquisition (coarser inside finer) is rejected fail-closed", () => {
  const { withCoordStateLock, withGovernanceRuntimeLock, state, GovernanceError } =
    governanceContext;
  assert.throws(
    () => {
      // Hold the FINER coord-state lock, then try to acquire the COARSER
      // governance-runtime lock — the canonical-order inversion.
      withCoordStateLock(() => {
        withGovernanceRuntimeLock(() => {
          throw new Error("should never reach the body of an out-of-order acquisition");
        });
      });
    },
    (error) =>
      error instanceof GovernanceError && /Lock-order violation/.test(error.message),
  );
  // The guard threw before acquiring the coarser lock and unwound the finer one.
  assert.equal(state.coordStateLockDepth, 0);
  assert.equal(state.governanceEventLockDepth, 0);
});

test("COORD-223: agent-state inside coord-state inside runtime is the allowed direction; the reverse trips", () => {
  const { withAgentStateLock, withCoordStateLock, state, GovernanceError } =
    governanceContext;
  // Forward (coarser->finer) is fine.
  withCoordStateLock(() => {
    withAgentStateLock(() => {
      assert.equal(state.coordStateLockDepth, 1);
      assert.equal(state.agentStateLockDepth, 1);
    });
  });
  // Reverse (finer->coarser) is rejected.
  assert.throws(
    () =>
      withAgentStateLock(() => {
        withCoordStateLock(() => {});
      }),
    (error) =>
      error instanceof GovernanceError && /Lock-order violation/.test(error.message),
  );
  assert.equal(state.agentStateLockDepth, 0);
  assert.equal(state.coordStateLockDepth, 0);
});

// COORD-277: the agent-state lock previously mkdir'd its lock dir WITHOUT writing
// owner metadata (unlike the coord-state and runtime locks). Without pid/host,
// `tryReclaimStaleDirectoryLock` could not liveness-reclaim a dead holder and was
// forced to wait the full 60s age window. The fix brings the agent-state lock to
// parity: it writes the same owner metadata, so a dead local holder is reclaimed
// immediately and a live local holder is never evicted.
test("COORD-277 METADATA-WRITTEN: acquiring the agent-state lock writes owner metadata (pid + host) like the other two locks", () => {
  const { withAgentStateLock, readDirectoryLockMetadata, state } = governanceContext;
  const lockDir = state.AGENT_STATE_LOCK_DIR;
  let metaWhileHeld = null;
  withAgentStateLock(() => {
    metaWhileHeld = readDirectoryLockMetadata(lockDir);
  });
  assert.ok(metaWhileHeld, "agent-state lock dir must contain owner metadata while held");
  assert.equal(metaWhileHeld.kind, "agent-state");
  assert.equal(metaWhileHeld.pid, process.pid);
  assert.equal(metaWhileHeld.host, os.hostname());
  // Lock released cleanly (dir + metadata removed).
  assert.equal(fs.existsSync(lockDir), false);
});

test("COORD-277 DEAD-OWNER-RECLAIMED: an agent-state lock held by a DEAD pid is reclaimed immediately (no full age-window wait)", () => {
  const { withAgentStateLock, readDirectoryLockMetadata, state } = governanceContext;
  const lockDir = state.AGENT_STATE_LOCK_DIR;
  // Pre-create the lock dir held by a dead pid with a FRESH mtime: if reclaim were
  // age-only it would block for the 60s window; ownership-gated reclaim takes it now.
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "lock-owner.json"),
    JSON.stringify({ kind: "agent-state", pid: 999999, host: os.hostname(), created_at: new Date().toISOString() }, null, 2),
  );
  const startedAt = Date.now();
  let body = null;
  withAgentStateLock(() => {
    body = readDirectoryLockMetadata(lockDir);
  });
  const elapsed = Date.now() - startedAt;
  // Reclaimed immediately and replaced with OUR ownership (not the dead pid).
  assert.ok(body, "lock metadata must exist while held");
  assert.equal(body.pid, process.pid);
  assert.ok(elapsed < 5_000, `dead-owner reclaim must be immediate, took ${elapsed}ms`);
  assert.equal(fs.existsSync(lockDir), false);
});

test("COORD-277 LIVE-OWNER-NOT-EVICTED: an agent-state lock held by a LIVE local pid is NOT reclaimed", () => {
  const { tryReclaimStaleDirectoryLock, state } = governanceContext;
  const lockDir = state.AGENT_STATE_LOCK_DIR;
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { recursive: true });
  // Owner is THIS live, local process — even with a stale mtime it must survive.
  fs.writeFileSync(
    path.join(lockDir, "lock-owner.json"),
    JSON.stringify({ kind: "agent-state", pid: process.pid, host: os.hostname(), created_at: new Date().toISOString() }, null, 2),
  );
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, staleAt, staleAt);
  // 60_000 == AGENT_STATE_LOCK_STALE_MS; the live local owner is never age-reclaimed.
  assert.equal(tryReclaimStaleDirectoryLock(lockDir, 60_000), false);
  assert.equal(fs.existsSync(lockDir), true);
  // Cleanup.
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test("COORD-223: finerLocksHeld reports the inversion set for a fresh acquisition rank", () => {
  const { withAgentStateLock, finerLocksHeld } = governanceContext;
  // No locks held: nothing finer than coord-state (rank 2).
  assert.deepEqual(finerLocksHeld(2), []);
  withAgentStateLock(() => {
    // agent-state (rank 3) is held; acquiring coord-state (rank 2) would invert.
    assert.deepEqual(finerLocksHeld(2), ["agent-state"]);
    // Acquiring governance-runtime (rank 1) would also invert.
    assert.deepEqual(finerLocksHeld(1), ["agent-state"]);
    // Nothing is finer than agent-state itself.
    assert.deepEqual(finerLocksHeld(3), []);
  });
});

test("COORD-328: continuity Phase 1 covers required artifact shapes", () => {
  const { continuityArtifactShapes } = governanceContext;
  assert.deepEqual(
    continuityArtifactShapes().sort(),
    ["agent_session", "audit", "cadence_run", "scratch", "ticket"].sort(),
  );
});

test("COORD-328: warm-start templates retrieve context, stale sources, decisions, cursors, dead ends, and prior work", () => {
  const { buildContinuityArtifactTemplate } = governanceContext;
  for (const shape of ["agent_session", "ticket", "scratch", "audit", "cadence_run"]) {
    const template = buildContinuityArtifactTemplate(shape, "warm_start");
    assert.equal(template.schema_version, "continuity-phase1/v1");
    assert.equal(template.phase, "warm_start");
    assert.equal(template.shape, shape);
    assert.equal(template.authority.certification, "not-certified-truth");
    for (const required of [
      "prior_context",
      "stale_sources",
      "open_decisions",
      "cursor_state",
      "dead_ends",
      "prior_work",
      "source_refs",
      "verification_needed",
    ]) {
      assert.ok(template.fields.includes(required), `${shape} missing ${required}`);
    }
    assert.ok(template.expected_sources.length > 0, `${shape} must name expected source families`);
    assert.ok(template.optional_verbs.length > 0, `${shape} must name optional verbs`);
  }
});

test("COORD-328: cold-finish templates record changes, learning, failures, promotions, invalidations, and human decisions", () => {
  const { buildContinuityArtifactTemplate } = governanceContext;
  for (const shape of ["agent_session", "ticket", "scratch", "audit", "cadence_run"]) {
    const template = buildContinuityArtifactTemplate(shape, "cold_finish");
    assert.equal(template.phase, "cold_finish");
    assert.equal(template.authority.role, "continuity");
    assert.match(template.authority.citation_use, /advisory resume context/);
    for (const required of [
      "changed",
      "learned",
      "failed",
      "promote_candidates",
      "invalidated",
      "human_decision_needed",
      "evidence_refs",
      "next_cursor",
    ]) {
      assert.ok(template.fields.includes(required), `${shape} missing ${required}`);
    }
  }
});

test("COORD-328: continuity template helpers reject unknown shapes and phases", () => {
  const { GovernanceError, continuityArtifactShape, buildContinuityArtifactTemplate } =
    governanceContext;
  assert.throws(
    () => continuityArtifactShape("memory_claim"),
    (error) => error instanceof GovernanceError && /Unknown continuity artifact shape/.test(error.message),
  );
  assert.throws(
    () => buildContinuityArtifactTemplate("ticket", "certify"),
    (error) => error instanceof GovernanceError && /Unknown continuity artifact phase/.test(error.message),
  );
});

test("COORD-338: warm-start briefing composes existing governed artifacts with honest gaps", () => {
  const { buildContinuityWarmStartBriefing } = governanceContext;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-warm-start-"));
  const write = (rel, body) => {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, "utf8");
  };
  write("coord/board/tasks.json", JSON.stringify({
    tasks: [{ ID: "COORD-338", Status: "todo", Description: "Continuity bridge MVP" }],
    promptMap: { "COORD-338": "coord/prompts/tickets/COORD-338.md" },
  }, null, 2));
  write("coord/prompts/tickets/COORD-338.md", "# COORD-338\n\nImplement warm-start.\n");
  write("coord/.runtime/plans/COORD-338.json", JSON.stringify({ ticket: "COORD-338", steps: ["plan"] }, null, 2));
  write("coord/.runtime/context-packs/COORD-338.json", JSON.stringify({ kind: "concord.business_context_pack", ticket: "COORD-338" }, null, 2));
  write("coord/QUESTIONS.md", "- COORD-338 open decision: choose existing artifacts first.\n");
  write("coord/.runtime/governance-events.ndjson", `${JSON.stringify({ ticket: "COORD-338", event: "plan", at: "2026-06-27T00:00:00Z" })}\n`);
  write("coord/product/REQUIREMENTS.md", "# Requirements\n");
  write("coord/docs/decisions/0001-continuity.md", [
    "# ADR 0001: Continuity",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** COORD-338",
    "",
    "## Decision",
    "",
    "Use existing artifacts first.",
    "",
  ].join("\n"));

  const briefing = buildContinuityWarmStartBriefing("COORD-338", {
    rootDir: root,
    govExplain: "COORD-338 explanation",
    recallResult: {
      answer: "Prior continuity work exists.",
      sources: [{ type: "adr", id: "ADR-0001" }],
      confidence: "high",
      staleness: "fresh",
    },
  });

  assert.equal(briefing.kind, "concord.continuity_warm_start_briefing");
  assert.equal(briefing.read_model, "existing-governed-artifacts-only");
  assert.equal(briefing.briefing.board_row.ID, "COORD-338");
  assert.equal(briefing.briefing.plan_record.ticket, "COORD-338");
  assert.equal(briefing.briefing.context_pack.ticket, "COORD-338");
  assert.equal(briefing.briefing.linked_adrs[0].id, "0001-continuity");
  assert.equal(briefing.briefing.requirement_docs.some((doc) => doc.path === "coord/product/REQUIREMENTS.md"), true);
  assert.equal(briefing.briefing.recent_journal_events[0].event, "plan");
  assert.match(briefing.briefing.open_decisions[0].line, /open decision/);
  assert.equal(briefing.sources.every((source) => Object.prototype.hasOwnProperty.call(source, "available")), true);
  assert.match(briefing.missing_memory_surfaces.join("\n"), /No canonical daily-journal store/);
});

test("COORD-338: cold-finish contract writes only existing governed outputs first", () => {
  const { buildContinuityColdFinishContract } = governanceContext;
  const contract = buildContinuityColdFinishContract("COORD-338");
  assert.equal(contract.no_new_continuity_store, true);
  assert.deepEqual(contract.required_finish_sections, governanceContext.COLD_FINISH_FIELDS);
  assert.ok(contract.governed_outputs.some((output) => output.name === "plan_record_updates"));
  assert.ok(contract.governed_outputs.some((output) => output.name === "adr_links_or_proposals"));
  assert.match(contract.missing_memory_surfaces_policy, /Label absent daily-journal/);
});

test("COORD-329: daily journal template defines required scratch continuity fields", () => {
  const { buildDailyJournalEntryTemplate } = governanceContext;
  const template = buildDailyJournalEntryTemplate();
  assert.equal(template.schema_version, "continuity-daily-journal/v1");
  assert.equal(template.shape, "daily_journal_entry");
  for (const required of [
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
  ]) {
    assert.ok(template.fields.includes(required), `daily journal missing ${required}`);
  }
});

test("COORD-329: daily journal entries are non-certified and promotion-gated", () => {
  const { buildDailyJournalEntryTemplate } = governanceContext;
  const template = buildDailyJournalEntryTemplate();
  assert.equal(template.authority.certification, "not-certified-truth");
  assert.match(template.authority.promotion_boundary, /cannot create policy/);
  assert.match(template.authority.promotion_boundary, /business rules/);
  assert.match(template.authority.promotion_boundary, /without promotion/);
  assert.deepEqual(template.feeds.sort(), ["durability_sweep", "warm_start"].sort());
});

test("COORD-329: daily journal supports sensitivity and freshness checks before reuse", () => {
  const { buildDailyJournalEntryTemplate } = governanceContext;
  const template = buildDailyJournalEntryTemplate();
  assert.deepEqual(
    template.sensitivity_classes,
    ["public", "internal", "sensitive", "secret_prohibited"],
  );
  for (const control of ["source_freshness", "sensitivity", "citations"]) {
    assert.ok(template.required_source_controls.includes(control), `daily journal missing ${control} control`);
  }
  assert.match(template.authority.reuse_boundary, /source freshness/);
  assert.match(template.authority.reuse_boundary, /sensitivity/);
  assert.match(template.authority.reuse_boundary, /citations/);
});

test("COORD-331: cadence/cursor template models recurring work without scheduler requirements", () => {
  const { buildCadenceCursorTemplate } = governanceContext;
  const template = buildCadenceCursorTemplate();
  assert.equal(template.schema_version, "continuity-cadence-cursor/v1");
  assert.equal(template.shape, "cadence_cursor");
  for (const required of [
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
  ]) {
    assert.ok(template.fields.includes(required), `cadence cursor missing ${required}`);
  }
  assert.ok(template.operation_classes.includes("scan"));
  assert.ok(template.operation_classes.includes("audit_remediate_reaudit"));
  assert.ok(template.cursor_types.includes("timestamp"));
  assert.ok(template.cursor_types.includes("query_bounds"));
  assert.equal(template.phase1.no_scheduler_or_daemon_required, true);
  assert.match(template.authority.ticket_boundary, /without becoming a feature ticket/);
});

test("COORD-331: a cadence advances its cursor without ticket lifecycle state", () => {
  const { advanceCadenceCursor } = governanceContext;
  const cadence = {
    id: "cadence.memory-audit.weekly",
    owner: "governance",
    frequency: "weekly",
    cursor: { type: "timestamp", value: "2026-06-20T00:00:00.000Z" },
    operation_class: "audit",
    read_before_pull: true,
  };
  const advanced = advanceCadenceCursor(
    cadence,
    {
      type: "timestamp",
      value: "2026-06-27T00:00:00.000Z",
      evidence_ref: "coord/.runtime/governance-events.ndjson#hash",
    },
    {
      advancedAtUtc: "2026-06-27T01:00:00.000Z",
      evidence_refs: ["node coord/scripts/governance-context.test.js"],
      emitted: ["readout:weekly-memory-audit"],
      next_run: "2026-07-04T00:00:00.000Z",
    },
  );

  assert.equal(advanced.id, cadence.id);
  assert.equal(advanced.cursor.value, "2026-06-27T00:00:00.000Z");
  assert.equal(advanced.cursor.evidence_ref, "coord/.runtime/governance-events.ndjson#hash");
  assert.deepEqual(advanced.last_run.emitted, ["readout:weekly-memory-audit"]);
  assert.equal(advanced.next_run, "2026-07-04T00:00:00.000Z");
  assert.equal(advanced.lifecycle_effect, "cursor_advanced_without_ticket_state_change");
  assert.equal(Object.prototype.hasOwnProperty.call(advanced, "Status"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(advanced, "ticket"), false);
});

test("COORD-331: warm-start exposes stale and unknown cursor state", () => {
  const { buildContinuityWarmStartBriefing } = governanceContext;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-cadence-warm-start-"));
  const write = (rel, body) => {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, "utf8");
  };
  write("coord/board/tasks.json", JSON.stringify({
    tasks: [{ ID: "COORD-331", Status: "todo", Description: "Cadence cursor schema" }],
    promptMap: { "COORD-331": "coord/prompts/tickets/COORD-331.md" },
  }, null, 2));
  write("coord/prompts/tickets/COORD-331.md", "# COORD-331\n");
  const briefing = buildContinuityWarmStartBriefing("COORD-331", {
    rootDir: root,
    cadenceCursors: [
      {
        id: "cadence.audit.weekly",
        owner: "ops",
        frequency: "weekly",
        operation_class: "audit",
        cursor: { type: "timestamp", value: "2026-06-01T00:00:00.000Z" },
        freshness_policy: { status: "stale", max_age: "P7D" },
        read_before_pull: true,
        blocked_on_decisions: ["decision.audit-scope"],
      },
      {
        id: "cadence.crm.refresh",
        owner: "growth",
        frequency: "daily",
        operation_class: "refresh",
        cursor: { type: "unknown" },
        freshness_policy: { status: "unknown" },
      },
    ],
  });

  assert.equal(briefing.briefing.cursor_state.length, 2);
  assert.equal(briefing.briefing.cursor_state[0].status, "stale");
  assert.equal(briefing.briefing.cursor_state[1].status, "unknown");
  assert.deepEqual(
    briefing.stale_or_unknown_cursors.map((cursor) => cursor.id),
    ["cadence.audit.weekly", "cadence.crm.refresh"],
  );
  assert.equal(briefing.sources.find((source) => source.id === "cadence_cursor").available, true);
});

test("COORD-332: durability sweep dedupes repeated dead ends, tools, pulls, and manual steps with citations", () => {
  const { buildContinuityDurabilitySweepReadout } = governanceContext;
  const readout = buildContinuityDurabilitySweepReadout([
    {
      type: "daily_journal",
      id: "journal.2026-06-27",
      citations: ["coord/journal/2026-06-27.md#L10"],
      dead_ends: ["reran stale CRM export without cursor"],
      source_pulls: ["crm:contacts export"],
      tools: ["scripts/export-crm.js"],
      manual_steps: ["copy CSV into intake folder"],
    },
    {
      type: "cold_finish",
      id: "finish.COORD-320",
      evidence_refs: ["coord/.runtime/plans/COORD-320.json#cold_finish"],
      failed: ["reran stale CRM export without cursor"],
      pulls: ["crm:contacts export"],
      scripts: ["scripts/export-crm.js"],
      commands: ["copy CSV into intake folder"],
    },
    {
      type: "quality_scan",
      id: "scan.crm",
      citations: ["coord/quality/scans/crm.md#duplicate-tool"],
      tools: ["scripts/export-crm.js"],
    },
  ], { generatedAtUtc: "2026-06-27T12:00:00.000Z" });

  assert.equal(readout.kind, "concord.continuity_durability_sweep_readout");
  assert.equal(readout.no_mutations_performed, true);
  assert.match(readout.ticket_filing_boundary, /never files tickets/);
  assert.equal(readout.source_cited, true);

  const repeatedDeadEnd = readout.recommendations.find((item) => item.category === "repeated_dead_end");
  assert.equal(repeatedDeadEnd.promotion_type, "ticket");
  assert.equal(repeatedDeadEnd.evidence_count, 2);
  assert.deepEqual(repeatedDeadEnd.source_refs.sort(), [
    "coord/.runtime/plans/COORD-320.json#cold_finish",
    "coord/journal/2026-06-27.md#L10",
  ].sort());

  const repeatedPull = readout.recommendations.find((item) => item.category === "repeated_re_pull");
  assert.equal(repeatedPull.promotion_type, "cadence_object");

  const duplicateTool = readout.recommendations.find((item) => item.category === "duplicate_script_or_tool");
  assert.equal(duplicateTool.promotion_type, "adapter_tool_consolidation");
  assert.equal(duplicateTool.evidence_count, 3);

  const manualStep = readout.recommendations.find((item) => item.category === "repeated_manual_step");
  assert.equal(manualStep.promotion_type, "ticket");
  assert.match(manualStep.mutation_boundary, /governed approval/);
});

test("COORD-332: durability sweep recommends demotions, decision promotion, cadence review, and reusable claims without writes", () => {
  const { buildContinuityDurabilitySweepReadout } = governanceContext;
  const readout = buildContinuityDurabilitySweepReadout([
    {
      type: "decision",
      id: "decision.memory-authority",
      citations: ["coord/QUESTIONS.md#memory-authority"],
      open_decisions: ["Should continuity claims promote through ADR or memory compiler?"],
    },
    {
      type: "daily_journal",
      id: "journal.2026-06-28",
      citations: ["coord/journal/2026-06-28.md#L8"],
      source_freshness: { status: "unknown" },
      reuse_candidates: ["normalize source freshness warnings into one helper"],
      stale_sources: ["old scratch note says daily journal is canonical"],
    },
    {
      type: "cadence",
      id: "cadence.quality.weekly",
      citations: ["coord/cadences/quality-weekly.json"],
      cursor: { type: "timestamp", value: "2026-06-01T00:00:00.000Z" },
      freshness_policy: { status: "stale" },
      blocked_on_decisions: ["decision.quality-source"],
      read_before_pull: true,
    },
  ]);

  assert.equal(readout.write_model, "promotion-recommendations-only");
  assert.equal(readout.artifacts_read, 3);
  assert.equal(readout.recommendations.every((item) => item.source_refs.length > 0), true);

  assert.ok(readout.recommendations.some((item) =>
    item.promotion_type === "adr_proposal" &&
    item.category === "pending_decision" &&
    /continuity claims/.test(item.target)
  ));
  assert.ok(readout.recommendations.some((item) =>
    item.promotion_type === "memory_claim" &&
    item.category === "reusable_artifact"
  ));
  assert.ok(readout.recommendations.some((item) =>
    item.promotion_type === "stale_knowledge_demotion" &&
    item.category === "source_freshness_uncertainty"
  ));
  assert.ok(readout.recommendations.some((item) =>
    item.promotion_type === "stale_knowledge_demotion" &&
    item.category === "stale_or_invalidated_context"
  ));
  assert.ok(readout.recommendations.some((item) =>
    item.promotion_type === "cadence_object" &&
    item.category === "cadence_cursor_review" &&
    item.target === "cadence.quality.weekly"
  ));
});

test("COORD-335: public-safe continuity pilot fixtures cover recurring validation and audit-remediate-reaudit", () => {
  const { buildPublicSafeContinuityPilotFixtures } = governanceContext;
  const fixturePack = buildPublicSafeContinuityPilotFixtures();

  assert.equal(fixturePack.schema_version, "continuity-pilot-fixtures/v1");
  assert.equal(fixturePack.public_safe, true);
  assert.match(fixturePack.privacy_boundary, /no private project names/);
  assert.deepEqual(fixturePack.fixtures.map((fixture) => fixture.id).sort(), [
    "fixture.audit-remediate-reaudit",
    "fixture.recurring-validation",
  ]);

  for (const fixture of fixturePack.fixtures) {
    assert.ok(fixture.ticket.ID, "fixture has a generic ticket id");
    assert.ok(fixture.warm_start_records.length > 0, "fixture has warm-start records");
    assert.ok(fixture.cold_finish_records.length > 0, "fixture has cold-finish records");
    assert.ok(fixture.daily_journals.length > 0, "fixture has daily journal entries");
    assert.ok(fixture.decisions.some((decision) => decision.status === "open"), "fixture has an open decision");
    assert.ok(fixture.cadences.some((cadence) => cadence.read_before_pull), "fixture has read-before-pull cadence");
    assert.equal(JSON.stringify(fixture).includes("acme"), false);
  }
});

test("COORD-335: continuity readout is read-only and proves cold-start resume path", () => {
  const {
    buildPublicSafeContinuityPilotFixtures,
    buildContinuityReadOnlyReadout,
  } = governanceContext;
  const fixture = buildPublicSafeContinuityPilotFixtures().fixtures.find(
    (item) => item.id === "fixture.recurring-validation"
  );
  const readout = buildContinuityReadOnlyReadout(fixture, {
    generatedAtUtc: "2026-06-28T00:00:00.000Z",
  });

  assert.equal(readout.kind, "concord.continuity_read_only_readout");
  assert.equal(readout.read_only, true);
  assert.equal(readout.no_mutations_performed, true);
  assert.match(readout.change_boundary.statement, /never changes/);
  assert.ok(readout.change_boundary.governed_commands_for_changes.includes("coord/scripts/gov explain <ticket>"));
  assert.equal(readout.summary.warm_start_records, 1);
  assert.equal(readout.summary.cold_finish_records, 1);
  assert.equal(readout.summary.daily_journal_entries, 1);
  assert.equal(readout.summary.open_decisions, 1);
  assert.equal(readout.summary.active_cadences, 1);
  assert.ok(readout.summary.stale_sources >= 1);
  assert.ok(readout.summary.promotion_candidates >= 1);
  assert.ok(readout.summary.read_before_pull_findings >= 1);
  assert.equal(readout.warm_start.enough_to_resume, true);
  assert.equal(readout.cold_start_resume_proof.verdict, "resume_without_rediscovery");
  assert.ok(readout.cold_start_resume_proof.required_first_reads.includes("coord/scripts/gov explain VAL-001"));
  assert.ok(readout.read_before_pull_findings.some((finding) =>
    finding.cadence_id === "cadence.validation.weekly" &&
    /Read cadence contract/.test(finding.finding)
  ));
  assert.ok(readout.promotion_candidates.every((item) => item.source_refs.length > 0));
});

test("COORD-335: audit-remediate-reaudit readout leaves acceptance to governed commands", () => {
  const {
    buildPublicSafeContinuityPilotFixtures,
    buildContinuityReadOnlyReadout,
  } = governanceContext;
  const fixture = buildPublicSafeContinuityPilotFixtures().fixtures.find(
    (item) => item.id === "fixture.audit-remediate-reaudit"
  );
  const readout = buildContinuityReadOnlyReadout(fixture);

  assert.equal(readout.ticket, "AUD-001");
  assert.ok(readout.open_decisions.some((decision) =>
    decision.id === "decision.reaudit-acceptance" &&
    /gov log-question/.test(decision.change_command)
  ));
  assert.ok(readout.daily_journal_summary.some((entry) =>
    entry.dead_ends.includes("Do not mark finding closed from demo readout alone.")
  ));
  assert.ok(readout.cold_finish.evidence_refs.includes("coord/.runtime/audits/generic/reaudit.json"));
  assert.ok(readout.durability_sweep.recommendations.some((item) =>
    item.promotion_type === "memory_claim" &&
    item.category === "reusable_artifact"
  ));
  assert.equal(readout.change_boundary.governed_commands_for_changes.some((command) =>
    /adr new\|link\|supersede/.test(command)
  ), true);
});
