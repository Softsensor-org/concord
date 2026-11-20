"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileLandingCandidates, summarizeLandingReconciliation } = require("./landing-reconciliation.js");

const base = { number: 1, state: "MERGED", mergedAt: "2026-09-10T00:00:00Z", mergeCommit: { oid: "abc" }, headRefName: "agent/a-COORD-737-fix" };

test("COORD-737 classifies merged PRs without mutating board state", () => {
  const rows = [{ ID: "COORD-737", Status: "todo" }];
  const board = { "COORD-737": { commit_sha: "old" } };
  const report = reconcileLandingCandidates({ rows, landingIndex: board, pullRequests: [base], repoRoot: "/repo", baseRef: "origin/main", isCommitAncestorOfRef: () => true });
  assert.equal(report[0].classification, "recorded");
  assert.equal(report[0].ancestry_status, "confirmed");
  assert.equal(rows[0].Status, "todo");
  assert.deepEqual(board, { "COORD-737": { commit_sha: "old" } });
});

test("COORD-737 distinguishes untracked, ambiguous, unrelated, and missing closeout", () => {
  const prs = [
    { ...base, url: "u1", title: "COORD-900: landed work", headRefName: "coord-900" },
    { ...base, url: "u2", title: "COORD-901 and COORD-902 shared change", headRefName: "shared" },
    { ...base, url: "u3", title: "dependency update", headRefName: "renovate" },
    { ...base, url: "u4", title: "COORD-903: missing closeout", headRefName: "coord-903" },
  ];
  const report = reconcileLandingCandidates({ rows: [{ ID: "COORD-903", Status: "todo" }], pullRequests: prs });
  assert.deepEqual(summarizeLandingReconciliation(report), { recorded: 0, merged_without_closeout: 1, untracked: 1, ambiguous: 1, unrelated: 1 });
});
