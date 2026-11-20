"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");


const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { __testing, sandboxProcessRuntime, setupCoord003Workspace } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const createCloseout = require("./closeout.js");
sandboxProcessRuntime();

const TICKET = "COORD-646";
const NOTE = "Authorship correction: implementation belongs to the original author.";
const URL = "https://example.invalid/project/pull/646";
const LANDING = "abc1234 landed on the canonical integration branch";

// Exercise actual closeout control flow and the actual CAS-backed plan writer.
// External GitHub/landing gates are collaborators, not the evidence consumer.
function withCloseout(method, priorNote, run) {
  const ctx = setupCoord003Workspace("coord646-provenance-", TICKET, "claudea0000");
  try {
    __testing.updateCanonicalPlanState(TICKET, { provenanceNote: priorNote });
    const row = { ID: TICKET, Repo: "B", Status: "review", Owner: "claudea0000" };
    const board = { pr_index: { [TICKET]: [method === "pr" ? URL : "local-review (no PR)"] }, review_findings: {}, landing_index: {} };
    let landedOptions;
    const closeout = createCloseout({
      fail: (message) => { throw new Error(message); },
      readBoard: () => board, getTicketRef: () => ({ row }), inferTicketStatus: () => row.Status,
      withGovernanceMutation: (_mutation, fn) => fn(), ensureTicketMutationOwnership: () => ({}),
      isRepoBackedCode: (code) => code === "B", resolveRepoIntegrationBranch: () => "dev",
      getRepoRoot: () => ctx.backendRoot, resolvePrUrlForTicket: () => URL,
      assertReviewPlanReady: () => {}, verifyPrEvidence: () => {},
      findOutstandingCloseoutBlockerFollowups: () => [], findLockForTicket: () => null,
      prMerge: (_ticket, options) => { landedOptions = options; return { status: "merged" }; },
      refreshLandingBaseRef: () => {}, persistMergedPrLandingSnapshot: () => ({ commit_sha: "abc1234" }),
      ensureLandingRecord: () => ({ commit_sha: "abc1234" }), assertLandingIntegrity: () => {},
      ensureTestingInfrastructureLandingAudit: () => {}, ensureFeatureProofLandingAudit: () => {},
      cleanupTicketWorktree: () => {}, buildQuestionRow: () => "", buildLandCloseoutAnswer: () => "",
      appendQuestionRowText: () => {}, removeQuestionRowText: () => {},
      applyMarkDone: () => { row.Status = "done"; },
      markDone: (_ticket, options) => { landedOptions = options; row.Status = "done"; },
      setPrRefs: () => {}, moveReview: () => { row.Status = "review"; },
      mergeUniqueRefs: (a, b) => [...new Set([...a, ...b])],
      toArray: (value) => value == null ? [] : Array.isArray(value) ? value : [value],
      updateCanonicalPlanState: __testing.updateCanonicalPlanState,
    });
    const read = () => JSON.parse(fs.readFileSync(path.join(ctx.planRecordsDir, `${TICKET}.json`), "utf8"));
    const land = (landed) => {
      const wasDone = row.Status === "done";
      const options = landed === undefined ? {} : { landed };
      if (method === "pr") closeout.landTicket(TICKET, options);
      else closeout.finalizeTicket(TICKET, { ...options, noPr: true, ...(method === "fulfilled_by" ? { fulfilledByCommit: "abc1234" } : {}) });
      assert.equal(row.Status, "done");
      if (!wasDone) assert.equal(landedOptions.landed, landed, "the original landing evidence must reach its existing consumer unchanged");
      return read().governance.expected_closeout;
    };
    run({ land, read, ctx, row });
  } finally { ctx.restore(); }
}

for (const method of ["no_pr", "fulfilled_by"]) {
  test(`COORD-646: ${method} without landed text preserves a persisted operator note`, () => {
    withCloseout(method, NOTE, ({ land }) => {
      assert.equal(land().provenance_note, NOTE);
      assert.equal(land().provenance_note, NOTE, "done-state retry must preserve the note too");
    });
  });
  test(`COORD-646: ${method} appends landing evidence once and preserves explicit later edits`, () => {
    withCloseout(method, NOTE, ({ land }) => {
      const expected = `${NOTE}\n\nLanding provenance:\n${LANDING}`;
      assert.equal(land(LANDING).provenance_note, expected);
      assert.equal(land(LANDING).provenance_note, expected);
      assert.equal(land().provenance_note, expected);
      __testing.updateCanonicalPlanState(TICKET, { provenanceNote: "Operator replacement" });
      assert.equal(land().provenance_note, "Operator replacement");
    });
  });
  test(`COORD-646: ${method} with no prior note retains ordinary landing behavior`, () => {
    withCloseout(method, null, ({ land }) => {
      assert.equal(land().provenance_note, null);
      assert.equal(land(LANDING).provenance_note, LANDING);
      assert.equal(land(LANDING).method, method);
      assert.equal(land(LANDING).provenance_note, LANDING);
    });
  });
}

test("COORD-646: PR landing appends provenance to the real persisted note", () => {
  withCloseout("pr", NOTE, ({ land }) => {
    assert.equal(land().provenance_note, `${NOTE}\n\nLanding provenance:\nPR-backed landing via ${URL}`);
    assert.ok(fs.readFileSync(governanceState.PLAN_PATH, "utf8").includes(NOTE), "compatibility rendering retains the operator evidence");
  });
});

test("COORD-646: PR landing without a prior note retains the existing exact provenance", () => {
  withCloseout("pr", null, ({ land }) => {
    assert.equal(land().provenance_note, `PR-backed landing via ${URL}`);
  });
});

test("COORD-646: verb-specific help explains durable provenance and explicit replacement", () => {
  const result = spawnSync(process.execPath, [resolveEngineModule(COORD_ROOT_DIR, "scripts/governance.js"), "update-plan", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--provenance-note.*operator.*replac/i);
  assert.match(result.stdout, /closeout preserves.*appends landing provenance/i);
  assert.match(result.stdout, /without --landed.*preserved/i);
});
