"use strict";

require("../../scripts/governance-test-utils.js").sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const createGovernanceValidation = require("./governance-validation.js");
const { toArray, escapeRegex } = require("./lifecycle-utils.js");
const createTestingInfraPaths = require("./testing-infra-paths.js");
const createLandingResolution = require("./landing-resolution.js");

function validation() {
  const { splitPlanPathValues } = createTestingInfraPaths({ toArray });
  return createGovernanceValidation({
    toArray,
    escapeRegex,
    splitPlanPathValues,
    repoPrefixesForCode: () => ["products/service/"],
    resolveRepoCodeForTicket: () => "B",
    fail(message) { throw new Error(message); },
  });
}

test("review cycle input preserves explicit numbering and normalizes pasted typography", () => {
  const api = validation();
  assert.equal(api.normalizeSelfReviewCycleLine("", null), null);
  for (const input of [
    "- Self-review cycle 2/4: checked",
    "Self-review cycle 2/4: checked",
    "2/4: checked",
  ]) {
    assert.equal(api.normalizeSelfReviewCycleLine("", input), "- Self-review cycle 2/4: checked");
  }
  assert.equal(
    api.normalizeSelfReviewCycleLine("", "checked ‘single’ and “double”"),
    '- Self-review cycle 1/3: checked \'single\' and "double"',
  );
  assert.equal(
    api.normalizeSelfReviewCycleLine("- Self-review cycle 1/3: prior", "next"),
    "- Self-review cycle 2/3: next",
  );
});

test("landing base-ref refresh defaults omitted and blank refs through fetchRepoRef", () => {
  const calls = [];
  const resolution = createLandingResolution({
    DEFAULT_INTEGRATION_BRANCH: "dev",
    fetchRepoRef: (repoRoot, ref) => {
      calls.push([repoRoot, ref]);
      return true;
    },
  });

  for (const baseRef of [undefined, "", "   "]) {
    assert.equal(resolution.refreshLandingBaseRef("/fixture-repository", baseRef), true);
  }
  assert.deepEqual(calls, [
    ["/fixture-repository", "dev"],
    ["/fixture-repository", "dev"],
    ["/fixture-repository", "dev"],
  ]);
});

test("review-cycle replacement removes stale cycles, deduplicates explicit entries and preserves surrounding plan text", () => {
  const api = validation();
  const cycle = "- Self-review cycle 1/3: replacement";
  assert.equal(
    api.replaceSelfReviewCycles("Summary\n- Self-review cycle 1/3: stale", [null, "", cycle, cycle]),
    `Summary\n${cycle}`,
  );
  assert.equal(
    api.replaceSelfReviewCycles("Summary\n- Rollback strategy:\nRevert commit", ["replacement"]),
    `Summary\n${cycle}\n- Rollback strategy:\nRevert commit`,
  );
});

test("review parser distinguishes empty scaffolds, legacy verdicts and structured evidence", () => {
  const api = validation();
  assert.deepEqual(api.parseSelfReviewCycles(null), []);
  const empty = api.parseSelfReviewCycles("- Self-review cycle 1/3:")[0];
  assert.equal(empty.body, "");
  assert.equal(empty.structured, false);
  assert.equal(empty.riskCount, 0);
  assert.equal(empty.verdict, null);
  assert.deepEqual(empty.missingFields, ["lens", "diff", "risks", "findings", "verification", "verdict"]);
  assert.equal(api.hasOnlyScaffoldSelfReviewCycles("- Self-review cycle 1/3:"), false);
  assert.equal(api.hasOnlyScaffoldSelfReviewCycles("- Self-review cycle 1/3: TODO review"), true);
  const legacy = api.parseSelfReviewCycles("- Self-review cycle 1/3: old evidence; verdict: pass")[0];
  assert.equal(legacy.verdict, "pass");
  assert.equal(legacy.structured, false);
  const structured = api.parseSelfReviewCycles(
    "- Self-review cycle 1/3: lens=contract; diff=readiness predicate; risks=false ready, false refusal; findings=shared collector; verification=regression; verdict=pass",
  )[0];
  assert.equal(structured.structured, true);
  assert.equal(structured.riskCount, 2);
  assert.equal(structured.verdict, "pass");
  assert.equal(api.extractTaggedReviewField(null, "verdict", []), null);
  assert.equal(api.extractTaggedReviewField("verification=regression; verdict=pass", "verification", ["verdict"]), "regression");
});

test("light-lane classification fails closed for missing type and paths while accepting lowercase legacy type", () => {
  const api = validation();
  assert.equal(api.isLightLaneEligible(null, ["README.md"]).eligible, false);
  assert.match(api.isLightLaneEligible({}, ["README.md"]).reason, /\(none\)/);
  assert.equal(api.isLightLaneEligible({ type: "docs" }, ["README.md"]).eligible, true);
  assert.equal(api.isLightLaneEligible({ Type: "docs" }, "README.md").eligible, false);
  assert.equal(api.isLightLaneEligible({ Type: "docs" }, [null, ""]).eligible, false);
  assert.equal(api.isProceduralDocPath(null), false);
  assert.equal(api.resolveTicketLightLane("T-1", { Type: "docs" }, { intended_files: ["./README.md"] }).eligible, true);
  assert.equal(api.ticketRequiresBaseline(null), false);
});

test("proof syntax and path helpers reject empty or malformed input and preserve supported proof forms", () => {
  const api = validation();
  assert.equal(api.normalizeRepoRelativeProofPathForRepo(null, "B"), "");
  assert.equal(api.normalizeRepoRelativeProofPathForRepo("./products/service/src/app.js", "B"), "src/app.js");
  assert.equal(api.normalizeFeatureProofEntryForTicket(null, "T-1"), "");
  assert.equal(api.normalizeFeatureProofEntryForTicket("route:/health", "T-1"), "route:/health");
  assert.throws(() => api.validateFeatureProofEntry(null), /may not be empty/);
  assert.throws(() => api.validateFeatureProofEntry("unsupported:proof"), /is invalid/);
  assert.throws(() => api.validateFeatureProofEntry("path:app.js#handler"), /Use "path:<file>"/);
  for (const proof of ["path:app.js", "symbol:app.js#handler", "text:handler", "route:/health"]) {
    assert.doesNotThrow(() => api.validateFeatureProofEntry(proof));
  }
});

test("dependency formatting tolerates incomplete input without inventing a dependency chain", () => {
  const api = validation();
  assert.deepEqual(api.dedupeDependencyChains([null, [null, " A ", "B"], ["A", "B"], []]), [["A", "B"]]);
  assert.equal(api.formatGovernanceBlockers("T-1", [{ message: "missing evidence" }], "Blocked"), "Blocked T-1:\n1. missing evidence");
});

test("continuity diagnostics identify a malformed snapshot instead of silently accepting it", () => {
  const api = validation();
  const issues = api.collectContinuityWriteSafetyIssues({ fresh_read: { observed: [{}], current: [] } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "continuity_stale_reread_required");
  assert.equal(issues[0].message, "Continuity write is stale for <unknown>.");
  assert.ok(issues[0].next_steps.some((step) => step.includes("Re-read")));
});

const LANDED = "a".repeat(40);
const UNLANDED = "b".repeat(40);
const ROW = { ID: "FE-1", Repo: "F" };

// These collaborator fixtures exercise classification and refusal contracts.
// Real Git ancestry and remote publication remain covered in the adjacent
// governance-validation suite; a simulated resolver is not landing proof.
function landingValidation(overrides = {}) {
  return createGovernanceValidation({
    toArray,
    fail(message) { throw new Error(message); },
    REPO_INTEGRATION_BRANCHES: { F: "dev" },
    isRepoBackedCode: (repo) => repo === "F",
    getRepoRoot: () => "/fixture-repository",
    repoNameForCode: () => "frontend",
    resolveCommitishInRepo: (_root, ref) => [LANDED, UNLANDED].includes(ref) ? ref : null,
    resolveLandingBaseRef: (_root, baseRef) => ({ baseRef }),
    isCommitAncestorOfRef: (_root, sha) => sha === LANDED,
    resolveLandingCommitSha: () => null,
    refreshLandingBaseRef: () => false,
    collectLandingAuditCandidates: (_root, evidence) => evidence.filter((entry) => [LANDED, UNLANDED].includes(entry)),
    pickBestLandingCommit: () => null,
    isGitHubPrUrl: (ref) => /^https:\/\//.test(ref),
    ghPrView: () => ({ state: "OPEN" }),
    mergedPrAffiliatesWithTicket: (_ticket, payload) => payload.affiliated === true,
    resolveSourceCommitSha: () => null,
    commitSubjectAffiliatesWithTicket: () => false,
    ...overrides,
  });
}

test("supersede protection recognizes landed index and affiliated merged PR evidence, not mere records", () => {
  const api = landingValidation({ REPO_INTEGRATION_BRANCHES: {} });
  assert.equal(api.detectSupersedeLandingBypass("X-1", { Repo: "X" }, {}), null);
  assert.deepEqual(api.detectSupersedeLandingBypass(ROW.ID, ROW, {
    landing_index: { [ROW.ID]: { fulfilled_by_commit_sha: LANDED } },
  }), { kind: "landing_index", commitSha: LANDED, baseRef: "dev" });
  assert.equal(api.detectSupersedeLandingBypass(ROW.ID, ROW, {
    landing_index: { [ROW.ID]: { commit_sha: UNLANDED } },
  }), null);
  const merged = { state: "MERGED", mergedAt: "2026-10-01", affiliated: true };
  const payloads = {
    "https://example.test/open": { state: "OPEN" },
    "https://example.test/foreign": { ...merged, affiliated: false },
    "https://example.test/unresolved": { ...merged },
    "https://example.test/landed": { ...merged, mergeCommit: { oid: LANDED } },
  };
  const prs = landingValidation({ ghPrView: (ref) => payloads[ref] });
  assert.deepEqual(prs.detectSupersedeLandingBypass(ROW.ID, ROW, {
    pr_index: { [ROW.ID]: ["local-review", ...Object.keys(payloads)] },
  }), { kind: "merged_pr", commitSha: LANDED, baseRef: "dev", ref: "https://example.test/landed" });
});

test("landing integrity retries an unavailable ref after refresh and rejects unresolved evidence", () => {
  const missing = landingValidation({ REPO_INTEGRATION_BRANCHES: {} });
  assert.throws(() => missing.assertLandingIntegrity(ROW.ID, ROW, {}), /missing a resolvable commit_sha for base dev/);
  let refreshed = false;
  const recovered = landingValidation({
    resolveCommitishInRepo: (_root, ref) => refreshed && ref === LANDED ? LANDED : null,
    refreshLandingBaseRef: () => { refreshed = true; return true; },
  });
  assert.doesNotThrow(() => recovered.assertLandingIntegrity(ROW.ID, ROW, { commit_sha: LANDED }));
  assert.equal(refreshed, true);
});

test("landing classification distinguishes fulfilled, explicit, legacy, ambiguous and absent evidence", () => {
  const api = landingValidation();
  const classify = (landing) => api.classifyLandingRecord(ROW.ID, ROW, landing);
  assert.equal(api.classifyLandingRecord("X-1", { Repo: "X" }, null), null);
  assert.equal(classify(null).reason, "missing_landing_record");
  assert.equal(classify({ evidence: "not an array" }).reason, "missing_landing_evidence");
  assert.equal(classify({ evidence: [] }).reason, "missing_landing_evidence");
  const fulfilled = classify({ fulfilled_by_ticket: "FE-0", commit_sha: LANDED, evidence: ["prior ticket"], method: " " });
  assert.equal(fulfilled.provenance, "fulfilled_by");
  assert.equal(fulfilled.fulfilled_by_ticket, "FE-0");
  assert.equal(fulfilled.status, "merged");
  assert.equal(fulfilled.method, "manual");
  const unlanded = classify({ fulfilled_by_commit_sha: UNLANDED, evidence: ["prior work"] });
  assert.equal(unlanded.fulfilled_by_ticket, null);
  assert.equal(unlanded.reason, "fulfilled_by_commit_not_ancestor");
  assert.equal(classify({ provenance_status: "fulfilled_by", evidence: ["unknown"] }).reason, "unresolvable_fulfilled_by_commit_sha");
  assert.equal(classify({ provenance_status: "legacy", commit_sha: LANDED, evidence: [LANDED] }).provenance, "legacy");
  assert.equal(classify({ commit_sha: "missing", evidence: ["unknown"] }).reason, "unresolvable_commit_sha");
  assert.equal(classify({ evidence: ["unknown"] }).reason, "no_resolvable_commit_sha_in_evidence");
  assert.equal(classify({ evidence: [LANDED, UNLANDED] }).reason, "ambiguous_legacy_commit_candidates");
  assert.equal(classify({ evidence: [LANDED] }).status, "merged");
  assert.equal(classify({ evidence: [UNLANDED] }).reason, "legacy_commit_not_ancestor");
  const selected = landingValidation({ pickBestLandingCommit: () => LANDED }).classifyLandingRecord(
    ROW.ID, ROW, { evidence: [LANDED, UNLANDED] },
  );
  assert.equal(selected.resolved_commit_sha, LANDED);
  assert.equal(selected.status, "merged");
});

test("already-landed reconciliation repairs only its private board copy when the PR index is malformed", () => {
  const board = { pr_index: "legacy-invalid-index" };
  const api = landingValidation({
    ensureLandingRecord: (ticket, copy) => {
      assert.notEqual(copy, board);
      assert.deepEqual(copy.pr_index, { [ticket]: ["local-review (no PR)"] });
      return { commit_sha: LANDED };
    },
  });
  assert.equal(api.assertAlreadyLandedNoPrReconcileReady(ROW.ID, board, ROW, ["local-review (no PR)"], {
    alreadyLanded: true, landed: ["canonical evidence"],
  }), true);
  assert.deepEqual(board, { pr_index: "legacy-invalid-index" });
});

test("requirement closure rejects empty and unrecognized fields without rejecting supported fields", () => {
  const api = validation();
  assert.throws(() => api.validateRequirementClosureEntry(null), /may not be empty/);
  assert.throws(() => api.validateRequirementClosureEntry("Unknown: evidence"), /must start with one of/);
  for (const entry of ["Ticket ask: change", "Implemented: change", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"]) {
    assert.doesNotThrow(() => api.validateRequirementClosureEntry(entry));
  }
});
