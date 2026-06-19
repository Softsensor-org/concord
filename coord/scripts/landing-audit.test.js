"use strict";

// Wave 3 (COORD-070, slice B): landing provenance / audit tests relocated out of
// governance.test.js into a module-owned file alongside landing-audit.js. Exercise
// the landing-audit report cluster, the testing-infrastructure landing audit, and
// the merged-PR landing snapshot writer via the governance __testing surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __testing, runGit, writeRepoFile, createTempGitRepo } = require("./governance-test-utils.js");

test("ensureTestingInfrastructureLandingAudit fails when canonical branch tip is missing a required gate script", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gate-audit-missing-script-"));
  const { repoRoot, head } = createTempGitRepo("ebmr-gate-audit-frontend-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: {
        "gate:default": "vitest run",
      },
    }, null, 2),
    "vitest.config.ts": "export default {};\n",
  }, "frontend test infra");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.writeFileSync(path.join(recordsDir, "FE-019.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "FE-019",
    markdown_heading: "## FE-019 — 2026-04-02T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: pnpm test", "Outcome: test runner missing"],
    prior_findings: [],
    intended_files: ["frontend/.worktrees/unassigned/FE-019/vitest.config.ts"],
    change_summary: ["Set up frontend test infrastructure."],
    verification_commands: [
      "pnpm gate:default",
      "pnpm gate:full",
    ],
    critical_invariants: ["Root scripts must stay truthful.", "Vitest config must stay on the canonical branch."],
    requirement_closure: ["Ticket ask: auditing", "Implemented: auditing", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["pnpm gate:default", "pnpm gate:full"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    F: repoRoot,
  };

  try {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`local-review ${head}`],
    };
    const row = {
      ID: "FE-019",
      Repo: "F",
      Type: "test",
      Description: "Set up frontend test infrastructure with vitest and governed gates.",
    };

    assert.throws(
      () => __testing.ensureTestingInfrastructureLandingAudit("FE-019", row, landing),
      /Missing at branch tip: scripts gate:full/
    );
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("ensureTestingInfrastructureLandingAudit tolerates renamed historical harness files when current capability still exists", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gate-audit-renamed-harness-"));
  const { repoRoot, head } = createTempGitRepo("ebmr-gate-audit-renamed-frontend-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: {
        "test:contracts": "node tools/testing/run-contract-lane.mjs",
      },
    }, null, 2),
    "README.md": "# frontend\n",
    "tools/testing/run-contract-lane.mjs": "console.log('contracts');\n",
    "packages/testkit/src/index.ts": "export const ok = true;\n",
  }, "frontend test infra");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };
  const fe045RepoPrefix = __testing.repoNameForCode("F");

  fs.writeFileSync(path.join(recordsDir, "FE-045.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "FE-045",
    markdown_heading: "## FE-045 — 2026-04-03T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: inspect historical harness path", "Outcome: harness runner renamed on dev"],
    prior_findings: [],
    // COORD-006: derive the repo-directory prefix from the live registry so the
    // fixture stays valid under a customized registry (acme etc.), not only
    // the coord-template default where F maps to "frontend".
    intended_files: [
      `${fe045RepoPrefix}/package.json`,
      `${fe045RepoPrefix}/tools/testing/run-contract-tests.mjs`,
      `${fe045RepoPrefix}/packages/testkit/src/index.ts`,
    ],
    change_summary: ["Historical ticket originally landed a contract runner under a different file name."],
    verification_commands: [
      `node /tmp/test-project/${fe045RepoPrefix}/.worktrees/codexa00/FE-045/tools/testing/run-contract-tests.mjs`,
    ],
    critical_invariants: ["Contract lane must stay truthful."],
    requirement_closure: ["Ticket ask: auditing", "Implemented: auditing", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [],
    repo_gates: ["pnpm test:contracts"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    F: repoRoot,
  };

  try {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`local-review ${head}`],
    };
    const row = {
      ID: "FE-045",
      Repo: "F",
      Type: "test",
      Description: "Historical contract runner audit.",
    };

    const audit = __testing.ensureTestingInfrastructureLandingAudit("FE-045", row, landing);

    assert.equal(audit.presentFiles.includes("package.json"), true);
    assert.equal(audit.missingFiles.includes("tools/testing/run-contract-tests.mjs"), true);
    assert.deepEqual(audit.missingScripts, []);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("ensureTestingInfrastructureLandingAudit ignores trailing punctuation after repo-gate script names", () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gate-audit-script-punctuation-"));
  const { repoRoot, head } = createTempGitRepo("ebmr-gate-audit-script-punctuation-frontend-", {
    "package.json": JSON.stringify({
      name: "@template/frontend",
      scripts: {
        "test:contracts": "node tools/testing/run-contract-lane.mjs",
      },
    }, null, 2),
    "tools/testing/run-contract-lane.mjs": "console.log('contracts');\n",
  }, "frontend test infra");
  const original = {
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };
  const fe106RepoPrefix = __testing.repoNameForCode("F");

  fs.writeFileSync(path.join(recordsDir, "FE-106.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "FE-106",
    markdown_heading: "## FE-106 — 2026-04-06T00:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: inspect repo-gate script parsing", "Outcome: trailing punctuation preserved in note text"],
    prior_findings: [],
    // COORD-006: registry-agnostic repo prefix (see FE-045 fixture above).
    intended_files: [`${fe106RepoPrefix}/package.json`, `${fe106RepoPrefix}/tools/testing/run-contract-lane.mjs`],
    change_summary: ["Record test contract evidence without breaking script detection."],
    verification_commands: [],
    critical_invariants: ["Repo-gate script detection must tolerate human result suffixes."],
    requirement_closure: ["Ticket ask: normalize repo-gate parsing", "Implemented: trailing punctuation is ignored", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [],
    repo_gates: ["pnpm test:contracts: 64/64 pass"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
  }, null, 2), "utf8");

  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    F: repoRoot,
  };

  try {
    const landing = {
      base_ref: "dev",
      method: "no_pr",
      commit_sha: head,
      evidence: [`local-review ${head}`],
    };
    const row = {
      ID: "FE-106",
      Repo: "F",
      Type: "test",
      Description: "Normalize repo-gate parsing.",
    };

    const audit = __testing.ensureTestingInfrastructureLandingAudit("FE-106", row, landing);
    assert.deepEqual(audit.requiredScripts, ["test:contracts"]);
    assert.deepEqual(audit.missingScripts, []);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
  }
});

test("collectLandingAuditReport classifies explicit, legacy, and unknown landing records", () => {
  const backendRepo = createTempGitRepo("ebmr-landing-audit-backend-", {
    "README.md": "# backend\n",
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "feature/not-landed"]);
  writeRepoFile(backendRepo.repoRoot, "worker.js", "console.log('worker');\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "feature only"]);
  const backendFeatureHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);

  const frontendRepo = createTempGitRepo("ebmr-landing-audit-frontend-", {
    "README.md": "# frontend\n",
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "feature/not-landed"]);
  writeRepoFile(frontendRepo.repoRoot, "tests/critical.test.ts", "export const ok = true;\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "frontend feature only"]);
  const frontendFeatureHead = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
    F: frontendRepo.repoRoot,
  };

  try {
    const board = {
      metadata: {
        landing_index_required_from_ticket: {
          B: "MSRV-001",
          F: "FE-001",
        },
      },
      sections: [
        {
          rows: [
            {
              ID: "MSRV-006",
              Repo: "B",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa00",
              Description: "Legacy no-pr ticket without a usable landing SHA.",
              "Depends On": "MSRV-001",
            },
            {
              ID: "FE-020",
              Repo: "F",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa00",
              Description: "Legacy landing evidence that names the landed commit in free text.",
              "Depends On": "FE-001",
            },
            {
              ID: "FE-049",
              Repo: "F",
              Type: "feature",
              Pri: "P1",
              Status: "done",
              Owner: "codexa00",
              Description: "Explicit landing SHA that is not on dev.",
              "Depends On": "FE-024",
            },
          ],
        },
      ],
      landing_index: {
        "MSRV-006": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          evidence: ["local-review (no PR)"],
        },
        "FE-020": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          evidence: [`Local review commit ${frontendRepo.head} landed on frontend dev baseline`],
        },
        "FE-049": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          commit_sha: frontendFeatureHead,
          evidence: [`frontend dev @ ${frontendFeatureHead.slice(0, 7)} local-review no-pr closeout against dev baseline`],
        },
      },
    };

    const report = __testing.collectLandingAuditReport(board);

    assert.deepEqual(report.summary.by_repo[__testing.repoNameForCode("B")], {
      merged: 0,
      not_ancestor: 0,
      unknown: 1,
    });
    assert.deepEqual(report.summary.by_repo[__testing.repoNameForCode("F")], {
      merged: 1,
      not_ancestor: 1,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.explicit, {
      merged: 0,
      not_ancestor: 1,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.fulfilled_by, {
      merged: 0,
      not_ancestor: 0,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.legacy, {
      merged: 1,
      not_ancestor: 0,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.unknown, {
      merged: 0,
      not_ancestor: 0,
      unknown: 1,
    });
    assert.equal(report.explicit_not_ancestor.length, 1);
    assert.equal(report.explicit_not_ancestor[0].ticket_id, "FE-049");
    assert.equal(report.legacy_not_ancestor.length, 0);
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0].ticket_id, "MSRV-006");
    assert.equal(report.backfillable.length, 1);
    assert.equal(report.backfillable[0].ticket_id, "FE-020");

    const summaryLines = __testing.formatLandingAuditSummary(report).join("\n");
    assert.match(summaryLines, /FE-049/);
    assert.match(summaryLines, /MSRV-006/);
    assert.match(summaryLines, /audit-landings --write/);
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("applyLandingAuditBackfill records commit_sha only for legacy merged landing records", () => {
  const frontendRepo = createTempGitRepo("ebmr-landing-backfill-frontend-", {
    "README.md": "# frontend\n",
  }, "frontend seed");
  runGit(frontendRepo.repoRoot, ["checkout", "-b", "feature/not-landed"]);
  writeRepoFile(frontendRepo.repoRoot, "tests/missing.test.ts", "export const missing = true;\n");
  runGit(frontendRepo.repoRoot, ["add", "."]);
  runGit(frontendRepo.repoRoot, ["commit", "-m", "feature only"]);
  const frontendFeatureHead = runGit(frontendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(frontendRepo.repoRoot, ["checkout", "dev"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    F: frontendRepo.repoRoot,
  };

  try {
    const board = {
      metadata: {
        landing_index_required_from_ticket: {
          F: "FE-001",
        },
      },
      sections: [
        {
          rows: [
            {
              ID: "FE-020",
              Repo: "F",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa00",
              Description: "Legacy merged row.",
              "Depends On": "FE-001",
            },
            {
              ID: "FE-021",
              Repo: "F",
              Type: "feature",
              Pri: "P1",
              Status: "done",
              Owner: "codexa00",
              Description: "Legacy non-ancestor row.",
              "Depends On": "FE-001",
            },
            {
              ID: "FE-022",
              Repo: "F",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa00",
              Description: "Unknown landing row.",
              "Depends On": "FE-001",
            },
          ],
        },
      ],
      landing_index: {
        "FE-020": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          evidence: [`Local review commit ${frontendRepo.head} landed on frontend dev baseline`],
        },
        "FE-021": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          evidence: [`Local review commit ${frontendFeatureHead} landed on frontend dev baseline`],
        },
        "FE-022": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "no_pr",
          evidence: ["local-review (no PR)"],
        },
      },
    };

    const report = __testing.applyLandingAuditBackfill(board);

    assert.equal(board.landing_index["FE-020"].commit_sha, frontendRepo.head);
    assert.equal(board.landing_index["FE-020"].provenance_status, "legacy");
    assert.equal(board.landing_index["FE-021"].provenance_status, "legacy");
    assert.equal(board.landing_index["FE-022"].provenance_status, "unknown");
    assert.equal(board.landing_index["FE-021"].commit_sha, undefined);
    assert.equal(board.landing_index["FE-022"].commit_sha, undefined);
    assert.equal(report.backfilled.length, 3);
    const backfilledByTicket = new Map(report.backfilled.map((entry) => [entry.ticket_id, entry]));
    assert.deepEqual(backfilledByTicket.get("FE-020"), {
      ticket_id: "FE-020",
      repo: "F",
      base_ref: "dev",
      commit_sha: frontendRepo.head,
      provenance_status: "legacy",
    });
    assert.deepEqual(backfilledByTicket.get("FE-021"), {
      ticket_id: "FE-021",
      repo: "F",
      base_ref: "dev",
      commit_sha: frontendFeatureHead,
      provenance_status: "legacy",
    });
    assert.deepEqual(backfilledByTicket.get("FE-022"), {
      ticket_id: "FE-022",
      repo: "F",
      base_ref: "dev",
      commit_sha: null,
      provenance_status: "unknown",
    });
    assert.deepEqual(report.summary.by_provenance.explicit, {
      merged: 0,
      not_ancestor: 0,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.fulfilled_by, {
      merged: 0,
      not_ancestor: 0,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.legacy, {
      merged: 1,
      not_ancestor: 1,
      unknown: 0,
    });
    assert.deepEqual(report.summary.by_provenance.unknown, {
      merged: 0,
      not_ancestor: 0,
      unknown: 1,
    });
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("collectLandingAuditReport classifies fulfilled-by landing records separately", () => {
  const frontendRepo = createTempGitRepo("ebmr-landing-fulfilled-by-frontend-", {
    "README.md": "# frontend\n",
    "apps/public-web/app/[flow]/page.tsx": "export function SecureLinkProofPage() { return '/proof'; }\n",
  }, "frontend seed");

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    F: frontendRepo.repoRoot,
  };

  try {
    const board = {
      metadata: {
        landing_index_required_from_ticket: {
          F: "FE-001",
        },
      },
      sections: [
        {
          rows: [
            {
              ID: "FE-079",
              Repo: "F",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa01",
              Description: "Legacy flow now fulfilled by a later public-web recovery ticket.",
              "Depends On": "FE-025",
            },
            {
              ID: "FE-080",
              Repo: "F",
              Type: "feature",
              Pri: "P0",
              Status: "done",
              Owner: "codexa01",
              Description: "The later ticket that actually landed the public-web flow.",
              "Depends On": "FE-079",
            },
          ],
        },
      ],
      landing_index: {
        "FE-079": {
          recorded_at: "2026-04-02T00:00:00.000Z",
          base_ref: "dev",
          method: "manual",
          commit_sha: frontendRepo.head,
          fulfilled_by_ticket: "FE-080",
          fulfilled_by_commit_sha: frontendRepo.head,
          provenance_status: "fulfilled_by",
          evidence: [`fulfilled-by FE-080 ${frontendRepo.head}`],
        },
      },
    };

    const report = __testing.collectLandingAuditReport(board);

    assert.deepEqual(report.summary.by_provenance.fulfilled_by, {
      merged: 1,
      not_ancestor: 0,
      unknown: 0,
    });
    assert.equal(report.entries[0].provenance, "fulfilled_by");
    assert.equal(report.entries[0].fulfilled_by_ticket, "FE-080");
    assert.equal(report.entries[0].fulfilled_by_commit_sha, frontendRepo.head);
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
  }
});

test("persistMergedPrLandingSnapshot retries on stale board writes before recording landing evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-landing-snapshot-retry-"));
  const boardPath = path.join(tempDir, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    sections: [],
    review_findings: {},
    pr_index: {},
    landing_index: {},
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  // COORD-010: redirect F to a real temp git repo so getRepoRoot and the
  // worktree-list lookup do not fail closed under a non-default registry
  // where F points at an unprovisioned directory. The test exercises the
  // board-write retry path, not repo git state.
  const fRepo = createTempGitRepo("ebmr-landing-snapshot-frepo-", { "README.md": "f repo\n" });
  __testing.paths.REPO_ROOTS = { F: fRepo.repoRoot };
  __testing.paths.BOARD_PATH = boardPath;
  try {
    const landing = __testing.persistMergedPrLandingSnapshot(
      "FE-115",
      { Repo: "F" },
      "https://github.com/example/repo/pull/115",
      {
        prViewPayload: {
          state: "MERGED",
          mergedAt: "2026-04-05T12:00:00.000Z",
          baseRefName: "dev",
          mergeCommit: { oid: "abc123def456" },
        },
        skipBoardSync: true,
        onBeforeWrite(attempt) {
          if (attempt === 0) {
            fs.writeFileSync(boardPath, JSON.stringify({
              version: 1,
              sections: [],
              review_findings: {},
              pr_index: {},
              landing_index: {
                OTHER: { evidence: ["preserve concurrent update"] },
              },
            }, null, 2), "utf8");
          }
        },
      }
    );

    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(landing.commit_sha, "abc123def456");
    assert.equal(board.landing_index.OTHER.evidence[0], "preserve concurrent update");
    assert.equal(board.landing_index["FE-115"].commit_sha, "abc123def456");
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.REPO_ROOTS = originalRoots;
  }
});

