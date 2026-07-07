// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  runGit,
  writeRepoFile,
  createTempGitRepo,
  createTempGitRepoWithOrigin,
} = require("./governance-test-utils.js");
const { DEFAULT_PATHS: ACTIVE_PATHS } = require("./governance-context.js");
const {
  advanceCadenceCursor,
  buildContinuityReadOnlyReadout,
  computeContinuityGenerationHash,
  mergeAppendOnlyContinuityRecords,
  validateContinuityFreshRead,
} = require("./governance-context.js");
const { countLoc } = require("./arch-checks.js");
const createGovernanceValidation = require("./governance-validation.js");

// COORD-098 (governance.test residual split, slice 3): validation / readiness
// behavior. Every subject here is DEFINED in governance-validation.js — the
// module that owns readiness evaluation and closeout/landing validation rules:
//   - deriveGovernanceReadiness / collectStartReadinessBlockers / evaluateReadiness
//   - collectReviewPlanReadinessIssues / assertReviewPlanReady / submitRequiresReviewPlanCheck
//   - deriveTestingInfrastructureAudit / deriveFeatureProofAudit / validateFeatureProofEntry
//   - assertAlreadyLandedNoPrReconcileReady / assertLandingIntegrity / classifyLandingRecord
//   - detectSupersedeLandingBypass
//   - replaceSelfReviewCycles / inferRequiredReviewRound (self-review-cycle helpers)
// Landing-side neighbors stay in their owning suites: landing-resolution.test.js
// keeps commit/base-ref resolution, landing-audit.test.js keeps audit/report
// writers, and lifecycle-owned validation (assertCommittedReviewState,
// appendReviewFollowupPlan, ensurePlanStub) plus the cross-module facade cases
// remain in governance.test.js.
//
// Hermetic session env: strip any ambient provider id the host injects (e.g.
// Claude Code exports CLAUDE_CODE_SESSION_ID) so it cannot leak into readiness
// fixtures that control identity explicitly.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

// COORD-071: feature-proof normalization infers a ticket's repo from its id
// prefix (project.config.js `ticketPrefixes`). The proof-normalization test
// below passes no board/row context, so its ticket id must use a prefix that
// maps to repo B under whichever config-matrix leg is running (default "MSRV",
// non-default "API"). Derive a B-mapped prefix from the active registry.
const B_TICKET_PREFIX =
  Object.entries(ACTIVE_PATHS.ticketPrefixToRepoCode || {}).find(([, code]) => code === "B")?.[0] || "MSRV";

test("continuity cursor advancement uses compare-and-swap to reject stale concurrent writers", () => {
  const baseCadence = {
    id: "cadence.validation.weekly",
    owner: "ops",
    cursor: { type: "hash", value: "export:a" },
  };
  const observedHash = computeContinuityGenerationHash(baseCadence.cursor);
  const writerA = advanceCadenceCursor(
    baseCadence,
    { type: "hash", value: "export:b", evidence_ref: "journal:a" },
    { expected_cursor_hash: observedHash, advancedAtUtc: "2026-06-27T12:00:00.000Z" }
  );

  assert.equal(writerA.previous_cursor_hash, observedHash);
  assert.equal(writerA.cursor.value, "export:b");
  assert.throws(
    () => advanceCadenceCursor(
      writerA,
      { type: "hash", value: "export:c", evidence_ref: "journal:b" },
      { expected_cursor_hash: observedHash, advancedAtUtc: "2026-06-27T12:01:00.000Z" }
    ),
    /Stale cadence cursor.*Re-read the cadence cursor/
  );
});

test("continuity append-only merge allows independent appends and rejects record rewrites", () => {
  const existing = [
    { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["read current cursor"] },
  ];
  const merged = mergeAppendOnlyContinuityRecords(existing, [
    { id: "journal.2026-06-27.002", kind: "daily_journal", observations: ["new note"] },
    { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["read current cursor"] },
  ]);

  assert.deepEqual(merged.appended, ["journal.2026-06-27.002"]);
  assert.equal(merged.merged.length, 2);
  assert.equal(existing[0].record_hash, undefined);
  assert.throws(
    () => mergeAppendOnlyContinuityRecords(existing, [
      { id: "journal.2026-06-27.001", kind: "daily_journal", observations: ["rewritten note"] },
    ]),
    /append-only continuity conflict/
  );
});

test("continuity stale context checks fail with re-read guidance before cold-finish", () => {
  const observed = [
    { id: "context-pack:COORD-340", hash: "sha256:old" },
  ];
  const current = [
    { id: "context-pack:COORD-340", hash: "sha256:new" },
  ];
  const report = validateContinuityFreshRead(observed, current);

  assert.equal(report.ok, false);
  assert.match(report.guidance.join(" "), /Re-read the listed context-pack/);

  const validation = createGovernanceValidation({ GovernanceError });
  const issues = validation.collectContinuityWriteSafetyIssues({
    fresh_read: { observed, current },
  });
  assert.equal(issues[0].code, "continuity_stale_reread_required");
  assert.match(issues[0].next_steps.join(" "), /Regenerate the derived continuity readout/);
});

test("continuity derived-view generation hashes change without corrupting governance journal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-derived-journal-"));
  const journalPath = path.join(tempDir, "governance-events.ndjson");
  const originalJournal = JSON.stringify({ event: "prior", ticket: "COORD-340" }) + "\n";
  fs.writeFileSync(journalPath, originalJournal, "utf8");

  const firstInput = {
    ticket: { ID: "COORD-340" },
    warm_start_records: [{ id: "warm.COORD-340", source_refs: ["coord/scripts/gov explain COORD-340"] }],
    cold_finish_records: [{ id: "finish.COORD-340", evidence_refs: ["test:pending"] }],
    cadences: [{ id: "cadence.safe", cursor: { type: "hash", value: "a" }, freshness_policy: { status: "fresh" } }],
  };
  const secondInput = {
    ...firstInput,
    cadences: [{ id: "cadence.safe", cursor: { type: "hash", value: "b" }, freshness_policy: { status: "fresh" } }],
  };
  const first = buildContinuityReadOnlyReadout(firstInput, { generatedAtUtc: "2026-06-27T12:00:00.000Z" });
  const second = buildContinuityReadOnlyReadout(secondInput, { generatedAtUtc: "2026-06-27T12:00:00.000Z" });

  assert.notEqual(first.input_generation_hash, second.input_generation_hash);
  assert.notEqual(first.generation_hash, second.generation_hash);
  assert.equal(fs.readFileSync(journalPath, "utf8"), originalJournal);

  const validation = createGovernanceValidation({ GovernanceError });
  const issues = validation.collectContinuityWriteSafetyIssues({
    derived_view: {
      expected_input_generation_hash: first.input_generation_hash,
      current_inputs: secondInput,
    },
  });
  assert.equal(issues[0].code, "continuity_derived_view_stale");
  assert.match(issues[0].next_steps.join(" "), /Do not append derived readout output to the governance journal/);
});

test("deriveGovernanceReadiness respects explicit required_question_logged=false in plan governance", () => {
  const readiness = __testing.deriveGovernanceReadiness(
    "FE-999",
    { ID: "FE-999", Repo: "F", Type: "bug", Description: "test ticket" },
    { metadata: {}, sections: [] },
    null,
    {
      startup_checklist: ["completed"],
      traceability_gate: ["verified"],
      repo_gates: ["pnpm test"],
      feature_proof: ["path:frontend/file.tsx"],
      governance: {
        expected_closeout: {
          method: "pr",
          base_ref: "dev",
          provenance_note: null,
        },
        review_profile: "standard",
        ticket_local_repairs: [
          {
            kind: "recover",
            required_question_logged: false,
            note: "missing resolved question log",
          },
        ],
      },
    },
    { required: false }
  );

  assert.equal(readiness.closeout.repair_ticket_local, true);
  assert.equal(readiness.closeout.repair_question_logged, false);
});

test("deriveTestingInfrastructureAudit normalizes worktree paths and records branch-reachability evidence", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gate-audit-records-"));
  const { repoRoot, head } = createTempGitRepo("ebmr-gate-audit-backend-", {
    "package.json": JSON.stringify({
      name: "@template/backend",
      scripts: {
        "gate:default": "node tools/gates/run-gate.mjs --lane default",
        "gate:full": "node tools/gates/run-gate.mjs --lane full",
        "gate:extended": "node tools/gates/run-gate.mjs --lane extended",
      },
    }, null, 2),
    "README.md": "# backend\n",
    "tools/gates/run-gate.mjs": "console.log('gate');\n",
    "tools/testing/run-test-lane.mjs": "console.log('lane');\n",
  }, "gate infra");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.writeFileSync(path.join(recordsDir, "MSRV-041.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "MSRV-041",
    markdown_heading: "## MSRV-041 — 2026-04-02T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: pnpm gate:default", "Outcome: reproduced missing CI/hook wiring"],
    prior_findings: [],
    intended_files: [
      "backend/.worktrees/unassigned/MSRV-041/tools/gates/run-gate.mjs",
      "backend/.worktrees/unassigned/MSRV-041/README.md",
    ],
    change_summary: ["Wire backend gate automation and make the closeout contract auditable."],
    verification_commands: [
      "node tools/testing/run-test-lane.mjs",
      "pnpm gate:default",
      "pnpm gate:full",
      "pnpm gate:extended",
    ],
    critical_invariants: ["Default/full/extended lanes stay truthful.", "Canonical dev must carry the landed gate scripts."],
    requirement_closure: ["Ticket ask: auditing", "Implemented: auditing", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["pnpm gate:default", "pnpm gate:full", "pnpm gate:extended"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    B: repoRoot,
  };

  try {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`local-review ${head}`],
    };
    const row = {
      ID: "MSRV-041",
      Repo: "B",
      Type: "infra",
      Description: "Wire the backend default/full/extended gates into CI and documented hook flow.",
    };

    const audit = __testing.deriveTestingInfrastructureAudit("MSRV-041", row, landing);

    assert.deepEqual(audit.requiredFiles, [
      "README.md",
      "package.json",
      "tools/gates/run-gate.mjs",
      "tools/testing/run-test-lane.mjs",
    ]);
    assert.deepEqual(audit.requiredScripts, [
      "gate:default",
      "gate:extended",
      "gate:full",
    ]);

    __testing.ensureTestingInfrastructureLandingAudit("MSRV-041", row, landing, { recordEvidence: true });
    assert.equal(
      landing.evidence.some((entry) => new RegExp(`testing-infra audit: commit .* is an ancestor of ${audit.repoLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/dev`).test(entry)),
      true
    );
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("deriveTestingInfrastructureAudit ignores feature tickets with feed-runner wording and incidental package manifests", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gate-audit-backend051-"));
  const { repoRoot, head } = createTempGitRepo("ebmr-gate-audit-feature-", {
    "apps/ingest-worker/src/feed-runner.ts": "export function createFeedRunner() { return 'ok'; }\n",
    "apps/ingest-worker/src/feed-runner.test.ts": "export {};\n",
    "apps/ingest-worker/src/main.ts": "export const main = true;\n",
    "apps/ingest-worker/package.json": JSON.stringify({
      name: "@template/ingest-worker",
      dependencies: {
        "@template/http-contracts": "workspace:*",
      },
    }, null, 2),
  }, "feature ticket with feed runner");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.writeFileSync(path.join(recordsDir, "MSRV-051.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "MSRV-051",
    markdown_heading: "## MSRV-051 — 2026-04-03T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: [
      "backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/feed-runner.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/feed-runner.test.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/src/main.ts,backend/.worktrees/claudea37/MSRV-051/apps/ingest-worker/package.json",
    ],
    change_summary: [
      "Wire integration adapters to ingest-worker with feed-runner engine and dead-letter retry queue.",
    ],
    verification_commands: [
      "node --experimental-strip-types --test apps/ingest-worker/src/feed-runner.test.ts",
    ],
    critical_invariants: ["Feed jobs preserve retry count.", "Dedup still rejects duplicates."],
    requirement_closure: ["Ticket ask: feature", "Implemented: feature", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: [
      "git diff --check dev...HEAD: pass",
      "testing-infra audit: MSRV-051 is a feature ticket that touched apps/ingest-worker/package.json to add http-contracts dep. No testing infrastructure added. Feed-runner and dead-letter retry are ingest-worker domain features.",
    ],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    B: repoRoot,
  };

  try {
    const row = {
      ID: "MSRV-051",
      Repo: "B",
      Type: "feature",
      Description: "Wire integration adapter feed jobs to the ingest-worker app and implement dead-letter retry.",
    };
    const planState = JSON.parse(fs.readFileSync(path.join(recordsDir, "MSRV-051.json"), "utf8"));
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`landing audit backfill: git merge-base --is-ancestor ${head} dev == true`],
    };

    assert.equal(__testing.isTestingInfrastructureTicket(row, planState), false);
    assert.equal(__testing.deriveTestingInfrastructureAudit("MSRV-051", row, landing), null);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("deriveFeatureProofAudit verifies canonical path, symbol, and route proofs", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-feature-proof-records-"));
  const frontendRepo = createTempGitRepo("ebmr-feature-proof-frontend-", {
    "apps/public-web/app/[flow]/page.tsx": "export function SecureLinkProofPage() { return '/proof'; }\n",
    "apps/public-web/app/page.tsx": "export default function PublicHome() { return null; }\n",
  }, "public flow");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.writeFileSync(path.join(recordsDir, "FE-079.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "FE-079",
    markdown_heading: "## FE-079 — 2026-04-02T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test", "Outcome: public flow stub reproduced"],
    prior_findings: [],
    intended_files: ["frontend/apps/public-web/app/[flow]/page.tsx"],
    change_summary: ["Recover the public secure-link proof flow."],
    verification_commands: ["pnpm test:components"],
    critical_invariants: ["Secure-link proof route must exist.", "Public flow shell must be canonical."],
    requirement_closure: ["Ticket ask: recover FE-007 flow", "Implemented: public proof flow", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [
      "path:apps/public-web/app/[flow]/page.tsx",
      "symbol:apps/public-web/app/[flow]/page.tsx#SecureLinkProofPage",
      "route:/proof",
    ],
    repo_gates: ["pnpm test:components"],
    self_review_cycles: [],
    rollback_strategy: ["revert public flow"],
    security_surface: "yes",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    F: frontendRepo.repoRoot,
  };

  try {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: frontendRepo.head,
      evidence: [`local-review ${frontendRepo.head}`],
    };
    const row = {
      ID: "FE-079",
      Repo: "F",
      Type: "feature",
      Description: "Recover the public secure-link flow.",
    };

    const audit = __testing.deriveFeatureProofAudit("FE-079", row, landing, {
      feature_proof_required_from_ticket: {
        F: "FE-079",
      },
    });

    assert.deepEqual(audit.proofs, [
      "path:apps/public-web/app/[flow]/page.tsx",
      "symbol:apps/public-web/app/[flow]/page.tsx#SecureLinkProofPage",
      "route:/proof",
    ]);
    __testing.ensureFeatureProofLandingAudit("FE-079", row, landing, {
      feature_proof_required_from_ticket: {
        F: "FE-079",
      },
    }, { recordEvidence: true });
    assert.equal(
      landing.evidence.some((entry) => new RegExp(`feature-proof audit: commit .* verified 3 proof\\(s\\) on ${__testing.repoNameForCode("F").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/dev`).test(entry)),
      true
    );
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("deriveFeatureProofAudit normalizes repo-prefixed proofs and prefers origin/dev when local dev is stale", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-feature-proof-origin-fallback-"));
  const backendRepo = createTempGitRepoWithOrigin("ebmr-feature-proof-backend-", {
    "packages/platform/core/src/event-bus.ts": "export function emitEvent() { return true; }\n",
    "packages/modules/planning-dispatch/src/planning-dispatch.core.ts": "export function transitionRouteForActor() { return true; }\n",
    "apps/api/src/http/events.controller.ts": "export class EventsController {}\n",
  }, "event stream");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  const updaterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-feature-proof-origin-fallback-updater-"));
  runGit(path.dirname(updaterRoot), ["clone", backendRepo.remoteRoot, updaterRoot]);
  runGit(updaterRoot, ["checkout", "dev"]);
  runGit(updaterRoot, ["config", "user.email", "governance-tests@example.com"]);
  runGit(updaterRoot, ["config", "user.name", "Governance Tests"]);
  writeRepoFile(updaterRoot, "packages/platform/core/src/event-store.ts", "export function createStore() { return true; }\n");
  runGit(updaterRoot, ["add", "."]);
  runGit(updaterRoot, ["commit", "-m", "remote-only advance"]);
  runGit(updaterRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["fetch", "origin"]);

  const tid = `${B_TICKET_PREFIX}-085`;
  fs.writeFileSync(path.join(recordsDir, `${tid}.json`), JSON.stringify({
    schema_version: 1,
    ticket_id: tid,
    markdown_heading: `## ${tid} — 2026-04-06T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["not-required"],
    prior_findings: [],
    intended_files: [`${__testing.repoPrefixForCode("B")}packages/platform/core/src/event-bus.ts`],
    change_summary: ["Add backend event stream APIs."],
    verification_commands: ["pnpm gate:default"],
    critical_invariants: ["Events persist before broadcast.", "Replay cursors stay stable."],
    requirement_closure: ["Ticket ask: add SSE event APIs", "Implemented: event bus and store", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [
      `path:${__testing.repoPrefixForCode("B")}packages/platform/core/src/event-bus.ts`,
      `path:${__testing.repoPrefixForCode("B")}apps/api/src/http/events.controller.ts`,
      `symbol:${__testing.repoPrefixForCode("B")}packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor`,
    ],
    repo_gates: ["pnpm gate:default"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    B: backendRepo.repoRoot,
  };

  try {
    const originHead = runGit(backendRepo.repoRoot, ["rev-parse", "origin/dev"]);
    const localHead = runGit(backendRepo.repoRoot, ["rev-parse", "dev"]);
    assert.notEqual(originHead, localHead);

    const landing = {
      base_ref: "dev",
      method: "pr",
      commit_sha: originHead,
      evidence: [`merged ${originHead}`],
    };
    const row = {
      ID: tid,
      Repo: "B",
      Type: "feature",
      Description: "Add backend event stream APIs.",
    };

    const audit = __testing.deriveFeatureProofAudit(tid, row, landing, {
      feature_proof_required_from_ticket: {
        B: tid,
      },
    });

    assert.equal(audit.baseRef, "origin/dev");
    assert.deepEqual(audit.proofs, [
      "path:packages/platform/core/src/event-bus.ts",
      "path:apps/api/src/http/events.controller.ts",
      "symbol:packages/modules/planning-dispatch/src/planning-dispatch.core.ts#transitionRouteForActor",
    ]);
    // Evidence label is the registry-derived repo display name
    // (repoNameForCode = basename of REPO_ROOTS[code]); derive it the same way
    // so the assertion holds for any active registry (GOV-015).
    assert.match(audit.evidence, new RegExp(`on ${__testing.repoNameForCode("B").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/origin\\/dev:`));
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("validateFeatureProofEntry accepts text and route proofs documented in governance", () => {
  assert.doesNotThrow(() => __testing.validateFeatureProofEntry("text:actionTemplate"));
  assert.doesNotThrow(() => __testing.validateFeatureProofEntry("route:/proof"));
});

test("replaceSelfReviewCycles overwrites scaffold TODO review cycles with real entries", () => {
  const block = `## IMP-228 — 2026-03-28T00:00:00Z

- Repo gates:
  - pytest -q tests/test_reference_data.py
- Self-review cycle 1/3: lens=TODO contract/state invariants; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Self-review cycle 2/3: lens=TODO auth/security/failure modes; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Self-review cycle 3/3: lens=TODO tests/operability/performance; diff=TODO git diff origin/dev...HEAD -- <paths>; risks=TODO failure mode 1, TODO failure mode 2; findings=TODO none or describe issues fixed; verification=TODO command rerun; verdict=TODO pass or fail
- Rollback strategy:
  - revert
`;

  assert.equal(__testing.hasOnlyScaffoldSelfReviewCycles(block), true);

  const updated = __testing.replaceSelfReviewCycles(block, [
    "lens=contract/state invariants; diff=git diff -- services/audit.py; risks=route bypass could still commit, helper could raise after persistence; findings=none; verification=pytest -q tests/test_form_types.py; verdict=pass",
    "lens=auth/security/failure modes; diff=git diff -- routes/users.py tests/test_integration.py; risks=signature scope mismatch, stale admin payloads could 422 before audit assertions; findings=repaired stale integration expectations; verification=pytest -q tests/test_integration.py -k s8_site_create_audited; verdict=pass",
    "lens=tests/operability/performance; diff=git diff -- tests/test_reference_data.py tests/test_users.py; risks=stable seam coverage could miss adapter regressions, full-suite debt could hide local confidence; findings=none; verification=pytest -q tests/test_reference_data.py tests/test_users.py; verdict=pass",
  ]);

  assert.equal(__testing.hasOnlyScaffoldSelfReviewCycles(updated), false);
  assert.doesNotMatch(updated, /TODO contract\/state invariants/);
  assert.match(updated, /- Self-review cycle 1\/3: lens=contract\/state invariants;/);
  assert.match(updated, /- Self-review cycle 3\/3: lens=tests\/operability\/performance;/);
});

test("review round helpers default initial review to round 1 and honor latest finding round", () => {
  assert.equal(__testing.inferRequiredReviewRound([]), 1);
  assert.equal(__testing.inferRequiredReviewRound([{ id: "IMP-200-F1", round: 1 }]), 1);
  assert.equal(
    __testing.inferRequiredReviewRound([
      { id: "IMP-200-F1", round: 1 },
      { id: "IMP-200-F2", round: 2 },
    ]),
    2
  );

  const block = `## IMP-200 — 2026-03-25T15:00:00Z

- Review round:
  - 2
`;
  assert.equal(__testing.readPlanScalarField(block, "Review round"), "2");
});

test("submitRequiresReviewPlanCheck only triggers before first PR creation", () => {
  const row = {
    ID: "IMP-240",
    Status: "doing",
  };

  assert.equal(
    __testing.submitRequiresReviewPlanCheck({ pr_index: {} }, row, "IMP-240", {}),
    true
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck(
      { pr_index: { "IMP-240": ["https://github.com/example/repo/pull/57"] } },
      row,
      "IMP-240",
      {}
    ),
    false
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck(
      { pr_index: {} },
      row,
      "IMP-240",
      { pr: ["https://github.com/example/repo/pull/57"] }
    ),
    false
  );
  assert.equal(
    __testing.submitRequiresReviewPlanCheck({ pr_index: {} }, { ID: "IMP-240", Status: "review" }, "IMP-240", {}),
    false
  );
});

test("assertAlreadyLandedNoPrReconcileReady validates explicit no-PR landing evidence against canonical dev", () => {
  const backendRepo = createTempGitRepo("ebmr-already-landed-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-900-reconcile-path"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "recovered\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-900 recover merge-before-review closeout"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  const originalBranches = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
  };
  __testing.paths.REPO_INTEGRATION_BRANCHES = {
    ...originalBranches,
    B: "dev",
  };

  try {
    const board = {
      sections: [],
      review_findings: {},
      pr_index: {},
      landing_index: {},
    };
    assert.equal(
      __testing.assertAlreadyLandedNoPrReconcileReady(
        "MSRV-900",
        board,
        { Repo: "B", Type: "feature" },
        ["local-review (no PR)"],
        {
          alreadyLanded: true,
          landed: [`backend/dev landed at ${sourceHead} via local-review no-pr closeout`],
          sourceCommit: sourceHead,
        }
      ),
      true
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
    __testing.paths.REPO_INTEGRATION_BRANCHES = originalBranches;
  }
});

test("assertLandingIntegrity accepts no-pr landing commits that are ancestors of origin/dev when local dev is stale", () => {
  const frontendRepo = createTempGitRepoWithOrigin("ebmr-no-pr-integrity-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-903-no-pr-integrity"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "no-pr-integrity\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-903 no-pr landing"]);
  const landedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", landedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    F: frontendRepo.repoRoot,
  };

  try {
    assert.doesNotThrow(() => __testing.assertLandingIntegrity("FE-903", { Repo: "F" }, {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: landedCommit,
      evidence: [`local-review ${landedCommit}`],
    }));
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("classifyLandingRecord treats no-pr landing commits on origin/dev as merged when local dev is stale", () => {
  const frontendRepo = createTempGitRepoWithOrigin("ebmr-no-pr-classify-origin-", {
    "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2),
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "agent/codexa44-fe-904-no-pr-classify"]);
  writeRepoFile(frontendRepo.repoRoot, "feature.txt", "no-pr-classify\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "FE-904 no-pr landing"]);
  const landedCommit = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);
  runGit(frontendRepo.repoRoot, ["merge", "--ff-only", landedCommit]);
  runGit(frontendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(frontendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    F: frontendRepo.repoRoot,
  };

  try {
    const entry = __testing.classifyLandingRecord("FE-904", { Repo: "F" }, {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: landedCommit,
      evidence: [`local-review ${landedCommit}`],
    });
    assert.equal(entry.status, "merged");
    assert.equal(entry.base_ref, "origin/dev");
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("detectSupersedeLandingBypass catches ticket-affiliated source commits that already landed on dev", () => {
  const backendRepo = createTempGitRepo("ebmr-supersede-landed-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-901-supersede-guard"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "guard\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-901 land before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  const originalBranches = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
  };
  __testing.paths.REPO_INTEGRATION_BRANCHES = {
    ...originalBranches,
    B: "dev",
  };

  try {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-901",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: sourceHead }
    );
    assert.deepEqual(detected, {
      kind: "source_commit",
      commitSha: sourceHead,
      baseRef: "dev",
    });
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
    __testing.paths.REPO_INTEGRATION_BRANCHES = originalBranches;
  }
});

test("detectSupersedeLandingBypass catches ticket-affiliated source commits already landed on origin/dev when local dev is stale", () => {
  const backendRepo = createTempGitRepoWithOrigin("ebmr-supersede-remote-origin-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-903-supersede-guard"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "guard-remote\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-903 land before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);
  runGit(backendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  const originalBranches = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
  };
  __testing.paths.REPO_INTEGRATION_BRANCHES = {
    ...originalBranches,
    B: "dev",
  };

  try {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-903",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: sourceHead }
    );
    assert.deepEqual(detected, {
      kind: "source_commit",
      commitSha: sourceHead,
      baseRef: "origin/dev",
    });
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
    __testing.paths.REPO_INTEGRATION_BRANCHES = originalBranches;
  }
});

test("detectSupersedeLandingBypass ignores base commits that do not affiliate with the ticket", () => {
  const backendRepo = createTempGitRepo("ebmr-supersede-safe-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
  };

  try {
    const detected = __testing.detectSupersedeLandingBypass(
      "MSRV-902",
      { Repo: "B", Type: "feature" },
      { pr_index: {}, landing_index: {} },
      { sourceCommit: backendRepo.head }
    );
    assert.equal(detected, null);
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("collectStartReadinessBlockers avoids follow-up rewrite suggestions when multiple dependencies are present", () => {
  const blockers = __testing.collectStartReadinessBlockers(
    "DEBT-042",
    {
      ID: "DEBT-042",
      Repo: "X",
      Type: "infra",
      Status: "todo",
      Owner: "unassigned",
      Description: "Follow-up dependency repair",
      "Depends On": "IMP-245, IMP-246",
    },
    {
      sections: [
        {
          rows: [
            {
              ID: "DEBT-042",
              Repo: "X",
              Type: "infra",
              Status: "todo",
              Owner: "unassigned",
              Description: "Follow-up dependency repair",
              "Depends On": "IMP-245, IMP-246",
            },
            {
              ID: "IMP-245",
              Repo: "X",
              Type: "infra",
              Status: "doing",
              Owner: "codexa00",
              Description: "Parent one",
              "Depends On": "",
            },
            {
              ID: "IMP-246",
              Repo: "X",
              Type: "infra",
              Status: "review",
              Owner: "codexa01",
              Description: "Parent two",
              "Depends On": "",
            },
          ],
        },
      ],
      prompt_index: {
        "DEBT-042": "coord/prompts/DEBT-042.md",
      },
      followup_exceptions: {},
    }
  );

  const dependencyBlocker = blockers.find((entry) => entry.code === "dependencies");
  assert.ok(dependencyBlocker);
  assert.deepEqual(dependencyBlocker.next_steps, [
    "coord/scripts/gov explain IMP-245",
    "coord/scripts/gov explain IMP-246",
  ]);
});

test("collectStartReadinessBlockers blocks manual reopen attempts when historical closeout evidence exists", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: "IMP-100",
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: "todo",
            Owner: "unassigned",
            Description: "Legacy ticket manually reset after closeout",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {
      "IMP-100": ["https://github.com/example/repo/pull/100"],
    },
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
    waiver_index: {},
  };

  const blockers = __testing.collectStartReadinessBlockers("IMP-100", board.sections[0].rows[0], board);

  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "closed_ticket_history");
  assert.match(blockers[0].message, /cannot be restarted/i);
  assert.deepEqual(blockers[0].next_steps, [
    'coord/scripts/gov open-followup <NEW-FOLLOWUP-ID> --depends-on IMP-100 --repo B --type bug --pri P1 --description "Follow-up for post-close finding"',
  ]);
});

test("collectStartReadinessBlockers surfaces gov plan --seed when plan state is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-start-readiness-"));
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };
  fs.mkdirSync(path.join(tempDir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "PLAN.md"), "", "utf8");
  __testing.paths.PLAN_PATH = path.join(tempDir, "PLAN.md");
  __testing.paths.PLAN_RECORDS_DIR = path.join(tempDir, "plans");

  try {
    const blockers = __testing.collectStartReadinessBlockers(
      "DEBT-043",
      {
        ID: "DEBT-043",
        Repo: "B",
        Type: "test",
        Status: "todo",
        Owner: "unassigned",
        Description: "Bootstrap readiness",
        "Depends On": "",
      },
      {
        sections: [
          {
            rows: [
              {
                ID: "DEBT-043",
                Repo: "B",
                Type: "test",
                Status: "todo",
                Owner: "unassigned",
                Description: "Bootstrap readiness",
                "Depends On": "",
              },
            ],
          },
        ],
        prompt_index: {
          "DEBT-043": "coord/prompts/DEBT-043.md",
        },
      }
    );

    const missingPlan = blockers.find((entry) => entry.code === "missing_plan_state");
    assert.ok(missingPlan);
    assert.deepEqual(missingPlan.next_steps, [
      "coord/scripts/gov plan DEBT-043 --seed",
    ]);
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
});

test("COORD-355: repo-X start readiness advises declared files without blocking", () => {
  const originalPromptsDir = __testing.paths.PROMPTS_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "declared-files-advisory-"));
  __testing.paths.PROMPTS_DIR = path.join(tempDir, "prompts");
  try {
    const row = { ID: "COORD-998", Repo: "X", Status: "todo", Owner: "unassigned", Description: "coord work" };
    const advisories = __testing.collectStartReadinessAdvisories("COORD-998", row);
    assert.equal(advisories.length, 1);
    assert.equal(advisories[0].code, "repo_x_declared_files_missing");
    assert.match(advisories[0].message, /plan-waves must schedule it alone/);
  } finally {
    __testing.paths.PROMPTS_DIR = originalPromptsDir;
  }
});

test("COORD-355: declared files from board or prompt suppress repo-X advisory", () => {
  const originalPromptsDir = __testing.paths.PROMPTS_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "declared-files-present-"));
  const promptsDir = path.join(tempDir, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  __testing.paths.PROMPTS_DIR = promptsDir;
  try {
    const boardDeclared = {
      ID: "COORD-997",
      Repo: "X",
      Status: "todo",
      Owner: "unassigned",
      Description: "coord work",
      "Declared Files": "coord/scripts/token-economics.js",
    };
    assert.deepEqual(__testing.collectStartReadinessAdvisories("COORD-997", boardDeclared), []);

    fs.writeFileSync(
      path.join(ticketsDir, "COORD-996.md"),
      [
        "# COORD-996",
        "",
        "## Likely Files",
        "",
        "- `coord/docs/MULTI_AGENT_TOPOLOGIES.md`",
      ].join("\n"),
      "utf8"
    );
    const promptDeclared = { ID: "COORD-996", Repo: "X", Status: "todo", Owner: "unassigned", Description: "coord work" };
    assert.deepEqual(__testing.collectStartReadinessAdvisories("COORD-996", promptDeclared), []);
  } finally {
    __testing.paths.PROMPTS_DIR = originalPromptsDir;
  }
});

test("collectStartReadinessBlockers offers governed follow-up relation repairs for a single blocking dependency", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-start-followup-repair-"));
  const original = {
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };
  fs.mkdirSync(path.join(tempDir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "PLAN.md"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "plans", "DEBT-042.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-042",
    markdown_heading: "## DEBT-042 — 2026-03-29T17:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Repair follow-up guidance."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Follow-up repair guidance must stay governed."],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert guidance change"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T17:00:00.000Z",
  }, null, 2), "utf8");
  __testing.paths.PLAN_PATH = path.join(tempDir, "PLAN.md");
  __testing.paths.PLAN_RECORDS_DIR = path.join(tempDir, "plans");

  try {
    const blockers = __testing.collectStartReadinessBlockers(
      "DEBT-042",
      {
        ID: "DEBT-042",
        Repo: "X",
        Type: "infra",
        Status: "todo",
        Owner: "unassigned",
        Description: "Follow-up dependency repair",
        "Depends On": "IMP-245",
      },
      {
        sections: [
          {
            rows: [
              {
                ID: "DEBT-042",
                Repo: "X",
                Type: "infra",
                Status: "todo",
                Owner: "unassigned",
                Description: "Follow-up dependency repair",
                "Depends On": "IMP-245",
              },
              {
                ID: "IMP-245",
                Repo: "X",
                Type: "infra",
                Status: "doing",
                Owner: "codexa00",
                Description: "Parent ticket",
                "Depends On": "",
              },
            ],
          },
        ],
        prompt_index: {
          "DEBT-042": "coord/prompts/DEBT-042.md",
        },
        followup_exceptions: {},
      }
    );

    const dependencyBlocker = blockers.find((entry) => entry.code === "dependencies");
    assert.ok(dependencyBlocker);
    assert.match(dependencyBlocker.message, /repair the relation with set-followup-relation/);
    assert.deepEqual(dependencyBlocker.next_steps, [
      "coord/scripts/gov explain IMP-245",
      "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation related",
      "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation closeout-blocker",
    ]);
  } finally {
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
});

test("evaluateReadiness ignores related follow-up dependencies but still blocks normal ones", () => {
  const byId = new Map([
    ["IMP-245", { ID: "IMP-245", Status: "doing" }],
    ["IMP-246", { ID: "IMP-246", Status: "review" }],
  ]);

  const relatedReadiness = __testing.evaluateReadiness(
    { ID: "DEBT-042", "Depends On": "IMP-245" },
    byId,
    {
      followup_exceptions: {
        "DEBT-042": {
          parent: "IMP-245",
          type: "related-followup",
        },
      },
    }
  );
  assert.equal(relatedReadiness.ready, true);
  assert.deepEqual(relatedReadiness.blockedBy, []);

  const blockingReadiness = __testing.evaluateReadiness(
    { ID: "DEBT-042", "Depends On": "IMP-246" },
    byId,
    { followup_exceptions: {} }
  );
  assert.equal(blockingReadiness.ready, false);
  assert.deepEqual(blockingReadiness.blockedBy, ["IMP-246"]);
});

test("evaluateReadiness surfaces transitive blocker chains for nested dependency graphs", () => {
  const readiness = __testing.evaluateReadiness(
    { ID: "DEBT-047", "Depends On": "IMP-245" },
    new Map([
      ["DEBT-047", { ID: "DEBT-047", Status: "todo", "Depends On": "IMP-245" }],
      ["IMP-245", { ID: "IMP-245", Status: "review", "Depends On": "IMP-246" }],
      ["IMP-246", { ID: "IMP-246", Status: "todo", "Depends On": "" }],
    ]),
    { followup_exceptions: {} }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockedBy, ["IMP-245"]);
  assert.deepEqual(readiness.transitiveBlockedBy.sort(), ["IMP-245", "IMP-246"]);
  assert.deepEqual(readiness.blockerChains, [["IMP-245", "IMP-246"]]);
  assert.deepEqual(readiness.cycles, []);
});

test("evaluateReadiness detects circular dependencies and fails closed", () => {
  const readiness = __testing.evaluateReadiness(
    { ID: "DEBT-047", "Depends On": "DEBT-048" },
    new Map([
      ["DEBT-047", { ID: "DEBT-047", Status: "todo", "Depends On": "DEBT-048" }],
      ["DEBT-048", { ID: "DEBT-048", Status: "todo", "Depends On": "DEBT-047" }],
    ]),
    { followup_exceptions: {} }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockedBy, ["DEBT-048"]);
  assert.deepEqual(readiness.blockerChains, []);
  assert.deepEqual(readiness.cycles, [["DEBT-047", "DEBT-048", "DEBT-047"]]);
});

test("collectStartReadinessBlockers fails closed on a fresh feature stub until startup evidence is explicit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-start-stub-feature-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.ensurePlanStub("IMP-311", "F", "codexa00");
    const blockers = __testing.collectStartReadinessBlockers(
      "IMP-311",
      { ID: "IMP-311", Repo: "F", Type: "feature", Status: "todo" },
      { prompt_index: { "IMP-311": "coord/prompts/example.md" }, sections: [{ rows: [{ ID: "IMP-311" }] }] }
    );

    assert.deepEqual(blockers.map((blocker) => blocker.code), ["startup_checklist", "traceability_gate"]);
    const block = fs.readFileSync(planPath, "utf8");
    assert.match(block, /TODO: completed/);
    assert.match(block, /TODO: verified \| closing-gap \| exempt/);
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("collectStartReadinessBlockers keeps baseline reproduction mandatory for test tickets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-start-stub-test-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.ensurePlanStub("TST-002", "B", "codexa00");
    const blockers = __testing.collectStartReadinessBlockers(
      "TST-002",
      { ID: "TST-002", Repo: "B", Type: "test", Status: "todo" },
      { prompt_index: { "TST-002": "coord/prompts/example.md" }, sections: [{ rows: [{ ID: "TST-002" }] }] }
    );

    assert.deepEqual(
      blockers.map((blocker) => blocker.code),
      ["startup_checklist", "traceability_gate", "baseline_reproduction"]
    );
    const block = fs.readFileSync(planPath, "utf8");
    assert.match(block, /TODO: completed/);
    assert.match(block, /TODO: verified \| closing-gap \| exempt/);
    assert.match(block, /TODO: Command: <required for test\/contract\/infra tickets/);
    assert.match(block, /TODO: Outcome: <required for test\/contract\/infra tickets/);
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("assertReviewPlanReady fails closed when a canonical record exists but self-review cycles are missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-review-plan-ready-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const boardPath = path.join(tempDir, "tasks.json");
  fs.mkdirSync(recordsDir, { recursive: true });

  fs.writeFileSync(planPath, `## DEBT-021 — 2026-03-25T22:13:17.979Z

- Review round:
  - 1
- Critical invariants:
  - Canonical record should be authoritative.
  - Stale markdown must not satisfy review readiness.
- Repo gates:
  - not-required
- Self-review cycle 1/3: lens=contract/state invariants; diff=manual; risks=state drift, stale evidence; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 2/3: lens=auth/security/failure modes; diff=manual; risks=auth drift, invalid fallback; findings=none; verification=node coord/board/board.js validate; verdict=pass
- Self-review cycle 3/3: lens=tests/operability/performance; diff=manual; risks=missing coverage, false readiness; findings=none; verification=node coord/board/board.js validate; verdict=pass
`, "utf8");

  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  const recordPath = path.join(recordsDir, "DEBT-021.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-021",
    markdown_heading: "## DEBT-021 — 2026-03-25T22:13:17.979Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: canonical record intentionally missing review cycles"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Remove markdown parser enforcement."],
    verification_commands: ["node coord/scripts/governance.test.js"],
    critical_invariants: [
      "Canonical record must remain authoritative once it exists.",
      "Missing canonical self-review cycles must fail closed.",
    ],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-25T22:13:17.983Z",
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    assert.throws(
      () => __testing.assertReviewPlanReady("DEBT-021", { ID: "DEBT-021", Repo: "X", Type: "debt" }),
      (error) => error instanceof GovernanceError && /must record at least 3 self-review cycles/i.test(error.message)
    );
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("collectReviewPlanReadinessIssues reports the full missing review-plan stack", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-review-plan-blockers-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-245.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-245",
    markdown_heading: "## IMP-245 — 2026-03-29T22:13:17.979Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: ["Command: pytest -q tests/test_signatures.py", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["services/signature.py"],
    change_summary: ["Enforce functional-area separation of duties for signatures."],
    verification_commands: ["pytest -q tests/test_signatures.py"],
    critical_invariants: [],
    requirement_closure: [],
    repo_gates: [],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-03-29T22:13:17.983Z",
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-245", { ID: "IMP-245", Repo: "B", Type: "feature" });
    assert.deepEqual(
      issues.map((issue) => issue.code),
      [
        "critical_invariants",
        "repo_gates",
        "requirement_closure",
        "self_review_cycle_count",
      ]
    );
    assert.match(issues[0].next_steps[0], /--invariant/);
    assert.match(issues[1].next_steps[0], /--repo-gate/);
    assert.match(issues[2].next_steps[0], /--closure/);
    assert.match(issues[3].next_steps[0], /--review-cycle/);
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

function decompositionRefactorRecord(ticketId, featureProof = []) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-29T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    review_round: 1,
    baseline_reproduction: ["Command: node --test coord/scripts/governance-validation.test.js", "Outcome: reproduced closeout-proof behavior"],
    prior_findings: [],
    intended_files: ["coord/scripts/lifecycle.js", "coord/scripts/arch-checks.js"],
    change_summary: ["Slim lifecycle.js into a pure composition root by extracting command clusters."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: slim lifecycle composition root", "Implemented: extracted lifecycle helpers", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: featureProof,
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    governance: {},
  };
}

test("collectReviewPlanReadinessIssues blocks slimming refactors without computed decomposition proof", () => {
  const ticketId = "COORD-910";
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-missing",
    ticketId,
    record: decompositionRefactorRecord(ticketId),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }));

  assert.ok(issues.some((issue) => issue.code === "decomposition_proof_missing"));
});

test("collectReviewPlanReadinessIssues fail-closes stale decomposition proof using computed countLoc", () => {
  const ticketId = "COORD-911";
  const lifecyclePath = "coord/scripts/lifecycle.js";
  const actualAfter = countLoc(fs.readFileSync(path.join(process.cwd(), lifecyclePath), "utf8")).loc;
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-stale",
    ticketId,
    record: decompositionRefactorRecord(ticketId, [
      `decomposition-proof: file=${lifecyclePath}; before=3675; after=${actualAfter + 1}; claimed_reduction=1076; target_max=2600; budget=${actualAfter}; extracted=heartbeat, reapGateProcs`,
    ]),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }));

  const blocker = issues.find((issue) => issue.code === "decomposition_proof_invalid");
  assert.ok(blocker, "stale proof should block closeout");
  assert.match(blocker.message, /does not match computed countLoc/);
});

test("collectReviewPlanReadinessIssues accepts computed decomposition proof with ratcheted budget", () => {
  const ticketId = "COORD-912";
  const lifecyclePath = "coord/scripts/lifecycle.js";
  const actualAfter = countLoc(fs.readFileSync(path.join(process.cwd(), lifecyclePath), "utf8")).loc;
  const issues = withGovernanceFixturePaths({
    prefix: "decomp-valid",
    ticketId,
    record: decompositionRefactorRecord(ticketId, [
      `decomposition-proof: file=${lifecyclePath}; before=3675; after=${actualAfter}; claimed_reduction=${3675 - actualAfter}; target_max=2600; budget=${actualAfter}; extracted=heartbeat, reapGateProcs, withTemporaryExecutionContext`,
    ]),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "refactor",
    Description: "Slim lifecycle.js to a pure composition root by extracting command clusters.",
  }));

  const codes = issues.map((issue) => issue.code);
  assert.equal(codes.includes("decomposition_proof_missing"), false);
  assert.equal(codes.includes("decomposition_proof_invalid"), false);
});

// COORD-153: live-MCP lifecycle enforcement is wired into the move-review /
// closeout readiness gate (collectReviewPlanReadinessIssues). It must (a) add
// live_mcp blockers ONLY when the plan declares a live_mcp operation, and (b)
// leave a normal ticket's readiness byte-identical (no new requirements).
test("collectReviewPlanReadinessIssues enforces live-MCP evidence only for declared live-mcp tickets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-live-mcp-readiness-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  // A complete coord/X (non-product-repo) plan record that otherwise passes the
  // readiness gate, so any extra issue must come from the live-MCP enforcement.
  const baseRecord = {
    schema_version: 1,
    markdown_heading: "## LMCP-1 — 2026-06-24T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["exempt"],
    governance: {
      expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null },
      review_profile: "standard",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: [],
    prior_findings: [],
    intended_files: ["coord/scripts/example.js"],
    change_summary: ["Example coord change."],
    verification_commands: ["node --test coord/scripts/example.test.js"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: example", "Implemented: example"],
    feature_proof: [],
    repo_gates: ["node --test coord/scripts/example.test.js"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract/state invariants",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
      {
        cycle: 2,
        total: 3,
        lens: "auth/security/failure modes",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=auth/security/failure modes; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
      {
        cycle: 3,
        total: 3,
        lens: "tests/operability/performance",
        diff: "example",
        risks: ["r1", "r2"],
        findings: "none",
        verification: "node --test",
        verdict: "pass",
        raw: "lens=tests/operability/performance; diff=example; risks=r1, r2; findings=none; verification=node --test; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    security_surface: "coord-only",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
  };

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    // (a) NORMAL ticket (no live_mcp): readiness has zero issues, and crucially
    // no live_mcp_* code is ever introduced.
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-1.json"),
      JSON.stringify({ ...baseRecord, ticket_id: "LMCP-1" }, null, 2),
      "utf8"
    );
    const normalIssues = __testing.collectReviewPlanReadinessIssues("LMCP-1", { ID: "LMCP-1", Repo: "X", Type: "feature" });
    assert.deepEqual(normalIssues, []);
    assert.equal(normalIssues.filter((issue) => issue.code.startsWith("live_mcp")).length, 0);

    // (b) DECLARED live-mcp ticket missing required evidence: the same gate now
    // lists the missing live-MCP items as blockers.
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-2.json"),
      JSON.stringify({
        ...baseRecord,
        ticket_id: "LMCP-2",
        markdown_heading: "## LMCP-2 — 2026-06-24T00:00:00.000Z",
        live_mcp: { operation_class: "read_sensitive", adapter: "db", operation: "q", environment: "prod", scope: "client=X" },
      }, null, 2),
      "utf8"
    );
    const liveIssues = __testing.collectReviewPlanReadinessIssues("LMCP-2", { ID: "LMCP-2", Repo: "X", Type: "feature" });
    const liveCodes = liveIssues.map((issue) => issue.code);
    // read_sensitive with no redaction and no receipt -> both required.
    assert.ok(liveCodes.includes("live_mcp_redaction"));
    assert.ok(liveCodes.includes("live_mcp_receipt"));

    // (c) DECLARED live-mcp ticket with full evidence -> ready (no live_mcp codes).
    fs.writeFileSync(
      path.join(recordsDir, "LMCP-3.json"),
      JSON.stringify({
        ...baseRecord,
        ticket_id: "LMCP-3",
        markdown_heading: "## LMCP-3 — 2026-06-24T00:00:00.000Z",
        live_mcp: {
          operation_class: "read_sensitive",
          adapter: "db",
          operation: "q",
          environment: "prod",
          scope: "client=X",
          redaction: "masked",
          approval: "human-admin",
          receipt_path: "coord/evidence/live-mcp/q.json",
        },
        context_pack_ack: contextPackAck({
          considered: {
            active_constraints: ["live-MCP operation constraints checked"],
            open_questions: ["none"],
          },
          closeout_learning: {
            decision: "scratch-only",
            scratch_only: ["live-MCP receipt is ticket-local evidence only"],
          },
        }),
      }, null, 2),
      "utf8"
    );
    const readyIssues = __testing.collectReviewPlanReadinessIssues("LMCP-3", { ID: "LMCP-3", Repo: "X", Type: "feature" });
    assert.deepEqual(readyIssues, []);
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("collectReviewPlanReadinessIssues allows bounded repair tickets to pass with three focused review cycles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-review-plan-bounded-pass-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-246.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-246",
    markdown_heading: "## IMP-246 — 2026-04-04T20:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    governance: {
      expected_closeout: {
        method: "pr",
        base_ref: "dev",
        provenance_note: null,
      },
      review_profile: "bounded_repair",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test:reports", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["apps/ops-web/app/reports/data.ts", "apps/ops-web/app/reports/data.test.ts"],
    change_summary: ["Repair report fallback handling without widening product scope."],
    verification_commands: ["pnpm test:reports"],
    critical_invariants: ["business-context investigation: not-required", "Fallback reports must not throw without an actor.", "Report defaults must still use tenant-local date boundaries."],
    requirement_closure: ["Ticket ask: fix reports fallback", "Implemented: fixed fallback guard", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        active_constraints: ["report fallback constraints checked"],
        business_rules: ["business-context investigation: not-required"],
      },
      closeout_learning: {
        decision: "none",
        rationale: "No new durable business learning was produced.",
      },
    }),
    feature_proof: ["path:apps/ops-web/app/reports/data.ts"],
    repo_gates: ["pnpm test:reports"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract/state invariants",
        diff: "git diff -- apps/ops-web/app/reports/data.ts",
        risks: ["fallback state drift", "timezone regression"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=git diff -- apps/ops-web/app/reports/data.ts; risks=fallback state drift, timezone regression; findings=none; verification=pnpm test:reports; verdict=pass",
      },
      {
        cycle: 2,
        total: 3,
        lens: "auth/security/failure modes",
        diff: "git diff -- apps/ops-web/app/reports/data.ts",
        risks: ["unauthenticated crash", "permission bypass"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=auth/security/failure modes; diff=git diff -- apps/ops-web/app/reports/data.ts; risks=unauthenticated crash, permission bypass; findings=none; verification=pnpm test:reports; verdict=pass",
      },
      {
        cycle: 3,
        total: 3,
        lens: "tests/operability/performance",
        diff: "git diff -- apps/ops-web/app/reports/data.test.ts",
        risks: ["regression gap", "test runtime drift"],
        findings: "none",
        verification: "pnpm test:reports",
        verdict: "pass",
        raw: "lens=tests/operability/performance; diff=git diff -- apps/ops-web/app/reports/data.test.ts; risks=regression gap, test runtime drift; findings=none; verification=pnpm test:reports; verdict=pass",
      },
    ],
    rollback_strategy: ["revert reports fallback repair"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-04-04T20:00:00.000Z",
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-246", { ID: "IMP-246", Repo: "F", Type: "bug" });
    assert.deepEqual(issues, []);
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("collectReviewPlanReadinessIssues rejects bounded repair profile when the repair scope is not actually bounded", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-review-plan-bounded-reject-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(recordsDir, "IMP-247.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-247",
    markdown_heading: "## IMP-247 — 2026-04-04T20:30:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    governance: {
      expected_closeout: {
        method: "pr",
        base_ref: "dev",
        provenance_note: null,
      },
      review_profile: "bounded_repair",
      ticket_local_repairs: [],
    },
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test", "Outcome: reproduced"],
    prior_findings: [],
    intended_files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    change_summary: ["Broader change still marked as bounded repair."],
    verification_commands: ["pnpm test"],
    critical_invariants: ["invariant 1", "invariant 2"],
    requirement_closure: ["Ticket ask: broader change", "Implemented: broader change", "Not implemented: follow-up", "Deferred to: FE-999", "Closeout verdict: complete"],
    feature_proof: ["path:a.ts"],
    repo_gates: ["pnpm test"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "yes",
    synced_from_markdown_at: "2026-04-04T20:30:00.000Z",
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    const issues = __testing.collectReviewPlanReadinessIssues("IMP-247", { ID: "IMP-247", Repo: "F", Type: "bug" });
    assert.equal(issues[0].code, "bounded_repair_ineligible");
    assert.match(issues[0].message, /1-3 intended files/);
    assert.match(issues[0].message, /Not implemented: none/);
    assert.match(issues[0].message, /Deferred to: none/);
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

// ===========================================================================
// COORD-166: type:docs / chore LIGHT LANE — reduced plan-completeness for
// reference/design docs, with a HARD carve-out for procedural-doc surfaces.
// ===========================================================================

function withGovernanceFixturePaths(fixture, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ebmr-${fixture.prefix}-`));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {},
    sections: fixture.sections || [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(recordsDir, `${fixture.ticketId}.json`), JSON.stringify(fixture.record, null, 2), "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    return fn();
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
}

// A minimal but VALID single self-review cycle (structured, non-shallow,
// passing) — the floor the light lane still requires.
const LIGHT_LANE_VALID_CYCLE = {
  cycle: 1,
  total: 1,
  lens: "requirement closure",
  diff: "git diff -- coord/docs/SOME_DESIGN.md",
  risks: ["stale reference", "broken internal link"],
  findings: "none",
  verification: "node coord/board/board.js validate",
  verdict: "pass",
  raw: "lens=requirement closure; diff=git diff -- coord/docs/SOME_DESIGN.md; risks=stale reference, broken internal link; findings=none; verification=node coord/board/board.js validate; verdict=pass",
};

function lightLaneDocsRecord(ticketId, intendedFiles, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-24T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: docs change"],
    prior_findings: [],
    intended_files: intendedFiles,
    change_summary: ["Update reference/design documentation."],
    verification_commands: ["node coord/board/board.js validate"],
    critical_invariants: [],
    requirement_closure: ["Ticket ask: refresh the design doc"],
    feature_proof: [],
    repo_gates: ["node coord/board/board.js validate"],
    self_review_cycles: [LIGHT_LANE_VALID_CYCLE],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

function standardCoordReviewCycles() {
  return [
    {
      cycle: 1,
      total: 3,
      lens: "contract/state invariants",
      diff: "git diff -- coord/scripts/governance-validation.js",
      risks: ["missing context gate", "false positive blocker"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=contract/state invariants; diff=git diff -- coord/scripts/governance-validation.js; risks=missing context gate, false positive blocker; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
    {
      cycle: 2,
      total: 3,
      lens: "auth/security/failure modes",
      diff: "git diff -- coord/scripts/governance-validation.js",
      risks: ["implementation accident treated as intent", "uncertain finding becomes todo"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=auth/security/failure modes; diff=git diff -- coord/scripts/governance-validation.js; risks=implementation accident treated as intent, uncertain finding becomes todo; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
    {
      cycle: 3,
      total: 3,
      lens: "tests/operability/performance",
      diff: "git diff -- coord/scripts/governance-validation.test.js",
      risks: ["stale pack path", "board intake status drift"],
      findings: "none",
      verification: "node --test coord/scripts/governance-validation.test.js",
      verdict: "pass",
      raw: "lens=tests/operability/performance; diff=git diff -- coord/scripts/governance-validation.test.js; risks=stale pack path, board intake status drift; findings=none; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
    },
  ];
}

function contextPackAck(overrides = {}) {
  return {
    refs: [],
    considered: {
      active_constraints: ["none"],
      adrs: ["none"],
      business_rules: ["none"],
      conflicts: ["none"],
      stale_warnings: ["none"],
      open_questions: ["none"],
      ...(overrides.considered || {}),
    },
    authority: {
      constraints: ["confirmed/current sources only"],
      advisory_only: ["candidate, inferred, stale, private, rejected, and conflicted claims kept advisory"],
      ...(overrides.authority || {}),
    },
    closeout_learning: {
      decision: "none",
      promote: [],
      demote: [],
      scratch_only: [],
      rationale: "No reusable learning created.",
      ...(overrides.closeout_learning || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["considered", "authority", "closeout_learning"].includes(key))),
  };
}

function businessContextGateRecord(ticketId, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-27T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: ["backend/src/invoices/post.ts"],
    change_summary: ["Change invoice approval workflow behavior."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: ["Approval behavior must preserve business intent.", "Unknown business rules must not govern implementation."],
    requirement_closure: ["Ticket ask: change invoice workflow", "Implemented: added behavior", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        active_constraints: ["invoice approval constraints checked"],
        business_rules: ["confirmed/current invoice rules only"],
      },
    }),
    feature_proof: ["path:coord/scripts/governance-validation.js"],
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function adrDecisionRecord(ticketId, overrides = {}) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-06-27T00:00:00.000Z`,
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance-validation.js"],
    change_summary: ["Change governance policy for high-impact decisions."],
    verification_commands: ["node --test coord/scripts/governance-validation.test.js"],
    critical_invariants: ["High-impact governance policy changes must be backed by decision evidence."],
    adr_refs: [],
    requirement_closure: ["Ticket ask: change governance policy", "Implemented: added guidance", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    context_pack_ack: contextPackAck({
      considered: {
        adrs: ["decision surface checked"],
      },
    }),
    feature_proof: ["path:coord/scripts/governance-validation.js"],
    repo_gates: ["node --test coord/scripts/governance-validation.test.js"],
    self_review_cycles: standardCoordReviewCycles(),
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

test("collectReviewPlanReadinessIssues blocks high-risk behavior tickets without business context evidence", () => {
  const ticketId = "BCTX-001";
  const issues = withGovernanceFixturePaths({
    prefix: "business-context-gate-",
    ticketId,
    record: businessContextGateRecord(ticketId, { context_pack_ack: undefined }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.ok(issues.some((issue) => issue.code === "business_context_gate"));
  assert.ok(issues.some((issue) => issue.code === "context_pack_ack"));
});

test("collectReviewPlanReadinessIssues ignores tickets without business-context risk signals", () => {
  const ticketId = "BCTX-002";
  const issues = withGovernanceFixturePaths({
    prefix: "business-context-safe-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      intended_files: ["coord/docs/README.md"],
      change_summary: ["Refresh developer documentation wording."],
      critical_invariants: ["Docs remain readable.", "Links stay valid."],
      requirement_closure: ["Ticket ask: docs wording", "Implemented: docs wording", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Refresh developer documentation wording.",
  }));
  assert.equal(issues.some((issue) => issue.code === "business_context_gate"), false);
  assert.equal(issues.some((issue) => issue.code === "business_context_proposed_intake"), false);
});

test("collectReviewPlanReadinessIssues routes uncertain business-context findings through proposed intake", () => {
  const ticketId = "BCTX-003";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-ref-"));
  const packPath = path.join(dir, "BCTX-003.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    proposed_ticket_recommendations: [
      {
        source_record_id: "BD-REC-CONFLICT",
        suggested_type: "spike",
        suggested_priority: "P1",
        statement: "Imported invoices can skip approval.",
      },
    ],
  }, null, 2), "utf8");

  const missingProposalIssues = withGovernanceFixturePaths({
    prefix: "business-context-proposed-missing-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.ok(missingProposalIssues.some((issue) => issue.code === "business_context_proposed_intake"));

  const proposedRows = [{
    name: "Proposed",
    rows: [
      {
        ID: "BCTX-PROP-1",
        Repo: "X",
        Type: "spike",
        Pri: "P1",
        Status: "proposed",
        Owner: "unassigned",
        Description: "BD-REC-CONFLICT: investigate imported invoice approval exception.",
      },
    ],
  }];
  const proposedIssues = withGovernanceFixturePaths({
    prefix: "business-context-proposed-present-",
    ticketId,
    sections: proposedRows,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));
  assert.equal(proposedIssues.some((issue) => issue.code === "business_context_proposed_intake"), false);
});

test("COORD-367: an explicit investigation disposition neutralizes proposed-ticket findings", () => {
  const ticketId = "BCTX-367";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord367-"));
  const packPath = path.join(dir, "BCTX-367.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    proposed_ticket_recommendations: [
      { source_record_id: "BD-REC-CONFLICT", suggested_type: "spike", suggested_priority: "P1", statement: "Imported invoices can skip approval." },
    ],
  }, null, 2), "utf8");

  // A pack ref but NO disposition -> the proposed-ticket finding still blocks.
  const blocked = withGovernanceFixturePaths({
    prefix: "coord367-nodisp-", ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [`business-context: ${packPath}`, "Unknown business rules must not govern implementation."],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, { ID: ticketId, Repo: "X", Type: "feature", Description: "Change invoice approval workflow." }));
  assert.ok(blocked.some((i) => i.code === "business_context_proposed_intake"), "no disposition -> findings block");

  // The SAME pack with an explicit investigation disposition -> findings neutralized.
  const neutralized = withGovernanceFixturePaths({
    prefix: "coord367-disp-", ticketId,
    record: businessContextGateRecord(ticketId, {
      critical_invariants: [
        `business-context: ${packPath}`,
        "business-context investigation: not-required",
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, { ID: ticketId, Repo: "X", Type: "feature", Description: "Change invoice approval workflow." }));
  assert.equal(neutralized.some((i) => i.code === "business_context_proposed_intake"), false, "explicit disposition neutralizes proposed-ticket findings");
});

test("COORD-348 requires context-pack acknowledgement for high-risk work", () => {
  const ticketId = "CTXACK-001";
  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-ack-missing-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: undefined,
      critical_invariants: [
        "business-context investigation: investigated by product owner",
        "Unknown business rules must not govern implementation.",
      ],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_ack"));
});

test("COORD-348 requires explicit handling of context-pack conflict, stale, and open-question sections", () => {
  const ticketId = "CTXACK-002";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-mandatory-"));
  const packPath = path.join(dir, "CTXACK-002.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    sections: {
      conflicts: { items: [{ id: "BD-REC-CONFLICT", statement: "approval rule conflicts" }] },
      stale_sources: { items: [{ id: "BD-REC-STALE", statement: "old approval source" }] },
      open_questions: { items: [{ id: "BD-Q-1", statement: "who owns exception approval?" }] },
    },
  }, null, 2), "utf8");

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-ack-mandatory-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: contextPackAck({
        refs: [packPath],
        considered: {
          active_constraints: ["confirmed/current invoice approval constraints"],
          business_rules: ["confirmed/current approval rules"],
          conflicts: ["none"],
          stale_warnings: ["none"],
          open_questions: ["none"],
        },
      }),
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  const mandatory = issues.find((issue) => issue.code === "context_pack_ack_mandatory_sections");
  assert.ok(mandatory, `expected mandatory section blocker, got ${JSON.stringify(issues.map((issue) => issue.code))}`);
  assert.match(mandatory.message, /conflicts/);
  assert.match(mandatory.message, /stale_warnings/);
  assert.match(mandatory.message, /open_questions/);
});

test("COORD-348 blocks advisory memory when cited as implementation authority", () => {
  const ticketId = "CTXACK-003";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-advisory-"));
  const packPath = path.join(dir, "CTXACK-003.json");
  fs.writeFileSync(packPath, JSON.stringify({
    kind: "concord.business_context_pack",
    sections: {
      conflicts: { items: [{ id: "BD-REC-CONFLICT", statement: "approval rule conflicts" }] },
      stale_sources: { items: [] },
      open_questions: { items: [] },
    },
  }, null, 2), "utf8");

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-advisory-authority-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: contextPackAck({
        refs: [packPath],
        considered: {
          conflicts: ["handled: kept advisory pending proposed spike"],
        },
        authority: {
          constraints: ["BD-REC-CONFLICT"],
          advisory_only: [],
        },
      }),
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_advisory_authority"));
});

test("COORD-348 requires closeout learning disposition in context-pack acknowledgement", () => {
  const ticketId = "CTXACK-004";
  const ack = contextPackAck();
  delete ack.closeout_learning;

  const issues = withGovernanceFixturePaths({
    prefix: "context-pack-closeout-learning-",
    ticketId,
    record: businessContextGateRecord(ticketId, {
      context_pack_ack: ack,
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  }));

  assert.ok(issues.some((issue) => issue.code === "context_pack_closeout_learning"));
});

test("COORD-322 blocks high-impact decision tickets without accepted ADR refs or waiver", () => {
  const ticketId = "ADRREQ-001";
  const issues = withGovernanceFixturePaths({
    prefix: "adr-required-missing-",
    ticketId,
    record: adrDecisionRecord(ticketId),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "feature",
    Description: "Change governance policy for high-impact tickets.",
  }));
  const issue = issues.find((entry) => entry.code === "adr_required");
  assert.ok(issue, `expected adr_required issue, got ${JSON.stringify(issues.map((entry) => entry.code))}`);
  assert.match(issue.message, /accepted ADR ref/i);
});

test("COORD-322 accepts explicit decision waiver or investigation status for high-impact work", () => {
  const waiverTicket = "ADRREQ-002";
  const waiverIssues = withGovernanceFixturePaths({
    prefix: "adr-required-waiver-",
    ticketId: waiverTicket,
    record: adrDecisionRecord(waiverTicket, {
      decision_required: {
        required: true,
        status: "waived",
        reason: "security boundary change is intentionally waived for one ticket",
        waiver: "human-admin approved ticket-scoped waiver",
      },
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(waiverTicket, {
    ID: waiverTicket,
    Repo: "X",
    Type: "feature",
    Description: "Change security boundary policy.",
  }));
  assert.equal(waiverIssues.some((entry) => entry.code === "adr_required"), false);

  const investigationTicket = "ADRREQ-003";
  const investigationIssues = withGovernanceFixturePaths({
    prefix: "adr-required-investigation-",
    ticketId: investigationTicket,
    record: adrDecisionRecord(investigationTicket, {
      decision_required: {
        required: true,
        status: "investigating",
        reason: "cross-repo contract decision still in discovery",
        owner: "architecture-owner",
      },
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(investigationTicket, {
    ID: investigationTicket,
    Repo: "X",
    Type: "spike",
    Description: "Investigate cross-repo contract options.",
  }));
  assert.equal(investigationIssues.some((entry) => entry.code === "adr_required"), false);
});

test("COORD-322 accepts an ADR ref only when the registry record is accepted", () => {
  const decisionsReadmePath = path.join(__dirname, "..", "docs", "decisions", "README.md");
  const adrPath = path.join(__dirname, "..", "docs", "decisions", "0001-resource-aware-multi-agent-test-architecture.md");
  const originalReadme = fs.readFileSync(decisionsReadmePath, "utf8");
  const originalAdr = fs.readFileSync(adrPath, "utf8");
  try {
    fs.writeFileSync(adrPath, originalAdr.replace("- **Status:** Deferred", "- **Status:** Accepted"), "utf8");
    fs.writeFileSync(
      decisionsReadmePath,
      originalReadme.replace("| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Deferred |", "| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Accepted |"),
      "utf8"
    );
    const ticketId = "ADRREQ-004";
    const issues = withGovernanceFixturePaths({
      prefix: "adr-required-accepted-",
      ticketId,
      record: adrDecisionRecord(ticketId, { adr_refs: ["ADR-0001"] }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.equal(issues.some((entry) => entry.code === "adr_required"), false);
  } finally {
    fs.writeFileSync(adrPath, originalAdr, "utf8");
    fs.writeFileSync(decisionsReadmePath, originalReadme, "utf8");
  }
});

test("COORD-324 requires ADR-aware review answers and closeout citation for decision-required work", () => {
  const decisionsReadmePath = path.join(__dirname, "..", "docs", "decisions", "README.md");
  const adrPath = path.join(__dirname, "..", "docs", "decisions", "0001-resource-aware-multi-agent-test-architecture.md");
  const originalReadme = fs.readFileSync(decisionsReadmePath, "utf8");
  const originalAdr = fs.readFileSync(adrPath, "utf8");
  try {
    fs.writeFileSync(adrPath, originalAdr.replace("- **Status:** Deferred", "- **Status:** Accepted"), "utf8");
    fs.writeFileSync(
      decisionsReadmePath,
      originalReadme.replace("| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Deferred |", "| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Accepted |"),
      "utf8"
    );

    const ticketId = "ADRREQ-324";
    const missingIssues = withGovernanceFixturePaths({
      prefix: "adr-aware-review-missing-",
      ticketId,
      record: adrDecisionRecord(ticketId, { adr_refs: ["ADR-0001"] }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.ok(missingIssues.some((entry) => entry.code === "adr_review_cycle"));
    assert.ok(missingIssues.some((entry) => entry.code === "adr_closeout_citation"));

    const readyIssues = withGovernanceFixturePaths({
      prefix: "adr-aware-review-ready-",
      ticketId,
      record: adrDecisionRecord(ticketId, {
        adr_refs: ["ADR-0001"],
        requirement_closure: [
          "Ticket ask: change governance policy",
          "Implemented: added guidance",
          "Not implemented: none",
          "Deferred to: none",
          "ADR compliance: follows ADR-0001 by preserving exact-commit landing evidence.",
          "Closeout verdict: complete",
        ],
        self_review_cycles: [
          ...standardCoordReviewCycles(),
          {
            cycle: 4,
            total: 4,
            lens: "ADR compliance",
            diff: "governance decision gate",
            risks: ["ADR drift", "rejected alternative regression"],
            findings: "ADR compliance: follows ADR-0001. Rejected alternatives: does not violate rejected shared-evidence broker. Revisit trigger: not triggered. New ADR: not required.",
            verification: "node --test coord/scripts/governance-validation.test.js",
            verdict: "pass",
            raw: "lens=ADR compliance; diff=governance decision gate; risks=ADR drift, rejected alternative regression; findings=ADR compliance: follows ADR-0001. Rejected alternatives: does not violate rejected shared-evidence broker. Revisit trigger: not triggered. New ADR: not required.; verification=node --test coord/scripts/governance-validation.test.js; verdict=pass",
          },
        ],
      }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: "feature",
      Description: "Change governance policy for high-impact tickets.",
    }));
    assert.equal(readyIssues.some((entry) => entry.code === "adr_required"), false);
    assert.equal(readyIssues.some((entry) => entry.code === "adr_review_cycle"), false);
    assert.equal(readyIssues.some((entry) => entry.code === "adr_closeout_citation"), false);
  } finally {
    fs.writeFileSync(adrPath, originalAdr, "utf8");
    fs.writeFileSync(decisionsReadmePath, originalReadme, "utf8");
  }
});

test("COORD-324 leaves ordinary low-risk tickets free of ADR review ceremony", () => {
  const ticketId = "ADRSAFE-324";
  const issues = withGovernanceFixturePaths({
    prefix: "adr-safe-low-risk-",
    ticketId,
    record: adrDecisionRecord(ticketId, {
      intended_files: ["coord/docs/README.md"],
      change_summary: ["Local wording maintenance."],
      critical_invariants: ["Existing behavior is preserved."],
      requirement_closure: ["Ticket ask: docs wording", "Implemented: docs wording", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    }),
  }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
    ID: ticketId,
    Repo: "X",
    Type: "docs",
    Description: "Local wording maintenance.",
  }));
  assert.equal(issues.some((entry) => entry.code === "adr_review_cycle"), false);
  assert.equal(issues.some((entry) => entry.code === "adr_closeout_citation"), false);
});

test("COORD-322 leaves ordinary bug docs and test tickets unblocked by ADR guidance", () => {
  for (const type of ["bug", "docs", "test"]) {
    const suffix = { bug: "001", docs: "002", test: "003" }[type];
    const ticketId = `ADRSAFE-${suffix}`;
    const issues = withGovernanceFixturePaths({
      prefix: `adr-safe-${type}-`,
      ticketId,
      record: adrDecisionRecord(ticketId, {
        intended_files: ["coord/docs/README.md"],
        change_summary: ["Local wording or regression-only maintenance."],
        critical_invariants: ["Existing behavior is preserved."],
        requirement_closure: ["Ticket ask: local maintenance", "Implemented: local maintenance", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      }),
    }, () => __testing.collectReviewPlanReadinessIssues(ticketId, {
      ID: ticketId,
      Repo: "X",
      Type: type,
      Description: "Local maintenance.",
    }));
    assert.equal(issues.some((entry) => entry.code === "adr_required"), false, `${type} should not require ADR`);
  }
});

test("COORD-322 deriveGovernanceReadiness surfaces missing ADR guidance in explain output", () => {
  const readiness = __testing.deriveGovernanceReadiness(
    "ADRREQ-005",
    { ID: "ADRREQ-005", Repo: "X", Type: "feature", Description: "Change RBAC permission model." },
    { metadata: {}, sections: [] },
    null,
    adrDecisionRecord("ADRREQ-005", {
      change_summary: ["Change RBAC permission model."],
    })
  );
  assert.equal(readiness.decision_required.required, true);
  assert.equal(readiness.decision_required.satisfied, false);
  assert.match(readiness.decision_required.reason, /RBAC|rbac|permission/i);
});

test("COORD-166 isLightLaneEligible: docs ticket touching reference/design docs is light-lane eligible", () => {
  const decision = __testing.isLightLaneEligible(
    { Type: "docs" },
    ["README.md", "CHANGELOG.md", "coord/docs/MEMORY_ARCHITECTURE.md"]
  );
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /reference-doc/i);
});

test("COORD-166 isLightLaneEligible: chore touching only a reference doc is eligible", () => {
  assert.equal(__testing.isLightLaneEligible({ Type: "chore" }, ["coord/docs/QUALITY_DIMENSIONS.md"]).eligible, true);
});

test("COORD-166 isLightLaneEligible: HARD carve-out — procedural-doc surfaces are NOT eligible", () => {
  for (const procedural of [
    "AGENTS.md",
    "coord/AGENTS.md",
    "CLAUDE.md",
    "coord/GOVERNANCE.md",
    ".claude/commands/code-writer.md",
    "frontend/AGENTS.md",
  ]) {
    const decision = __testing.isLightLaneEligible({ Type: "docs" }, ["README.md", procedural]);
    assert.equal(decision.eligible, false, `${procedural} must force the full lane`);
    assert.match(decision.reason, /procedural/i);
  }
});

test("COORD-166 isLightLaneEligible: non-docs/chore ticket is never light-lane eligible", () => {
  for (const type of ["feature", "bug", "task", "spike", "refactor", "test"]) {
    assert.equal(__testing.isLightLaneEligible({ Type: type }, ["README.md"]).eligible, false);
  }
});

test("COORD-166 isLightLaneEligible: fails toward FULL lane when no changed paths are recorded", () => {
  const decision = __testing.isLightLaneEligible({ Type: "docs" }, []);
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /no changed/i);
});

test("COORD-166 isProceduralDocPath matches behavior-defining surfaces and not plain reference docs", () => {
  assert.equal(__testing.isProceduralDocPath("AGENTS.md"), true);
  assert.equal(__testing.isProceduralDocPath("coord/AGENTS.md"), true);
  assert.equal(__testing.isProceduralDocPath("CLAUDE.md"), true);
  assert.equal(__testing.isProceduralDocPath("coord/GOVERNANCE.md"), true);
  assert.equal(__testing.isProceduralDocPath(".claude/commands/planner.md"), true);
  assert.equal(__testing.isProceduralDocPath("nested/.claude/x.md"), true);
  assert.equal(__testing.isProceduralDocPath("README.md"), false);
  assert.equal(__testing.isProceduralDocPath("CHANGELOG.md"), false);
  assert.equal(__testing.isProceduralDocPath("coord/docs/MEMORY_ARCHITECTURE.md"), false);
});

test("COORD-166 (a) docs reference-doc ticket passes review readiness under the reduced light lane", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-light-pass",
    ticketId: "DOC-900",
    record: lightLaneDocsRecord("DOC-900", ["README.md", "coord/docs/MEMORY_ARCHITECTURE.md", "CHANGELOG.md"]),
  }, () => __testing.collectReviewPlanReadinessIssues("DOC-900", { ID: "DOC-900", Repo: "X", Type: "docs" }));
  assert.deepEqual(issues, [], `light-lane docs ticket should have no blockers, got: ${JSON.stringify(issues)}`);
});

test("COORD-166 (b) docs ticket touching a procedural-doc surface is NOT eligible and requires the FULL lane", () => {
  // Same reduced evidence as the passing light-lane case, but the intended
  // files include GOVERNANCE.md / AGENTS.md / .claude — this MUST fall back to
  // the full lane and therefore block on the missing full self-review ceremony.
  for (const procedural of ["coord/GOVERNANCE.md", "coord/AGENTS.md", ".claude/commands/code-writer.md", "CLAUDE.md"]) {
    const issues = withGovernanceFixturePaths({
      prefix: "coord166-procedural-full",
      ticketId: "DOC-901",
      record: lightLaneDocsRecord("DOC-901", ["README.md", procedural]),
    }, () => __testing.collectReviewPlanReadinessIssues("DOC-901", { ID: "DOC-901", Repo: "X", Type: "docs" }));
    const codes = issues.map((i) => i.code);
    assert.ok(
      codes.includes("self_review_cycle_count"),
      `procedural surface ${procedural} must require the full self-review ceremony; got codes ${JSON.stringify(codes)}`
    );
  }
});

test("COORD-166 (c) feature/code ticket is unaffected — full lane enforced exactly as before", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-feature-unaffected",
    ticketId: "IMP-902",
    record: {
      schema_version: 1,
      ticket_id: "IMP-902",
      markdown_heading: "## IMP-902 — 2026-06-24T00:00:00.000Z",
      startup_checklist: ["completed"],
      traceability_gate: ["verified"],
      review_round: 1,
      baseline_reproduction: ["Command: pytest -q", "Outcome: reproduced"],
      prior_findings: [],
      intended_files: ["services/widget.py"],
      change_summary: ["Add widget."],
      verification_commands: ["pytest -q"],
      critical_invariants: [],
      requirement_closure: [],
      repo_gates: [],
      self_review_cycles: [],
      rollback_strategy: ["revert"],
      security_surface: "yes",
      synced_from_markdown_at: "2026-06-24T00:00:00.000Z",
    },
  }, () => __testing.collectReviewPlanReadinessIssues("IMP-902", { ID: "IMP-902", Repo: "B", Type: "feature" }));
  // Byte-identical to the pre-existing full-lane "missing stack" expectation.
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["critical_invariants", "repo_gates", "requirement_closure", "self_review_cycle_count"]
  );
});

test("COORD-166 (d) the light lane never removes attribution/repo-gate — a docs ticket with NO repo gate still blocks", () => {
  const issues = withGovernanceFixturePaths({
    prefix: "coord166-light-keeps-gate",
    ticketId: "DOC-903",
    record: lightLaneDocsRecord("DOC-903", ["README.md", "coord/docs/SOME_DESIGN.md"], { repo_gates: [] }),
  }, () => __testing.collectReviewPlanReadinessIssues("DOC-903", { ID: "DOC-903", Repo: "X", Type: "docs" }));
  assert.ok(
    issues.some((i) => i.code === "repo_gates"),
    `light lane must still require a repo-gate equivalent; got ${JSON.stringify(issues.map((i) => i.code))}`
  );
});

test("COORD-166 deriveGovernanceReadiness surfaces the active_lane decision in explain output", () => {
  const lightRow = { ID: "DOC-904", Repo: "X", Type: "docs", Description: "doc" };
  const lightReadiness = __testing.deriveGovernanceReadiness(
    "DOC-904",
    lightRow,
    { metadata: {}, sections: [] },
    null,
    { startup_checklist: ["completed"], intended_files: ["README.md", "coord/docs/X.md"], repo_gates: ["node coord/board/board.js validate"], self_review_cycles: [LIGHT_LANE_VALID_CYCLE], governance: {} }
  );
  assert.equal(lightReadiness.active_lane.lane, "light");
  assert.equal(lightReadiness.active_lane.light_lane_eligible, true);

  const proceduralReadiness = __testing.deriveGovernanceReadiness(
    "DOC-905",
    { ID: "DOC-905", Repo: "X", Type: "docs", Description: "doc" },
    { metadata: {}, sections: [] },
    null,
    { startup_checklist: ["completed"], intended_files: ["coord/GOVERNANCE.md"], governance: {} }
  );
  assert.equal(proceduralReadiness.active_lane.lane, "full");
  assert.match(proceduralReadiness.active_lane.reason, /procedural/i);
});
