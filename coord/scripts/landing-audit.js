"use strict";

// Wave 3 (COORD-070, slice B): landing provenance / audit surface consolidated
// out of governance-validation.js and lifecycle.js into a dedicated DI-factory
// module. This owns:
//   - the landing-audit REPORT surface (collectLandingAuditCandidates,
//     summarizeLandingAuditEntries, collectLandingAuditReport,
//     applyLandingAuditBackfill, formatLandingAuditSummary) — moved from
//     governance-validation.js,
//   - the testing-infrastructure / feature-proof landing audits
//     (ensureTestingInfrastructureLandingAudit, ensureFeatureProofLandingAudit) —
//     moved from governance-validation.js,
//   - the landing-RECORD writers (ensureLandingRecord,
//     persistMergedPrLandingSnapshot) — moved from lifecycle.js.
//
// DI-factory. The cohesive landing-audit/provenance cluster moves here; general
// validation/board/journal/status-constant deps are INJECTED from their owning
// modules (governance-validation.js retains classifyLandingRecord /
// deriveTestingInfrastructureAudit / deriveFeatureProofAudit / requiresLanding-
// Governance, which are still consumed broadly and are injected back at call
// time). BOUNDARY: verifyPrEvidence stays in landing-gh.js (GH-specific PR
// evidence verification); it is NOT moved here — the land path and closeout.js
// keep calling it directly from landing-gh.js. createLandingAudit is wired in
// lifecycle.js AFTER createGovernanceValidation (for the classify/derive deps)
// and after the landing-record primitives are available.

const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");

module.exports = function createLandingAudit(deps = {}) {
  const {
    // status / constants
    STATUS,
    REPO_ROOTS,
    REPO_INTEGRATION_BRANCHES,
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
    FEATURE_PROOF_EVIDENCE_PREFIX,
    GovernanceError,
    // generic helpers
    fail,
    toArray,
    mergeUniqueRefs,
    extractCommitShas,
    isRepoBackedCode,
    isGitHubPrUrl,
    // repo/commit resolution
    getRepoRoot,
    repoNameForCode,
    resolveCommitishInRepo,
    resolveLandingBaseRef,
    resolveLandingCommitSha,
    resolveSourceCommitSha,
    resolveFulfilledByLandingCommit,
    // board / index access
    getRows,
    readBoard,
    writeBoard,
    ensureLandingIndex,
    runBoardSync,
    ghPrView,
    // validation surface retained in governance-validation.js (injected back)
    classifyLandingRecord,
    deriveTestingInfrastructureAudit,
    deriveFeatureProofAudit,
    requiresLandingGovernance,
  } = deps;

  function collectLandingAuditCandidates(repoRoot, evidence = []) {
    const candidates = mergeUniqueRefs([], toArray(evidence))
      .flatMap((entry) => extractCommitShas(entry))
      .map((entry) => resolveCommitishInRepo(repoRoot, entry))
      .filter(Boolean);
    return [...new Set(candidates)];
  }

  function summarizeLandingAuditEntries(entries = []) {
    const byRepo = Object.fromEntries(
      Object.keys(REPO_ROOTS)
        .filter((repoCode) => repoCode !== "X")
        .sort()
        .map((repoCode) => [repoNameForCode(repoCode), { merged: 0, not_ancestor: 0, unknown: 0 }])
    );
    const summary = {
      by_repo: byRepo,
      by_provenance: {
        explicit: { merged: 0, not_ancestor: 0, unknown: 0 },
        legacy: { merged: 0, not_ancestor: 0, unknown: 0 },
        fulfilled_by: { merged: 0, not_ancestor: 0, unknown: 0 },
        unknown: { merged: 0, not_ancestor: 0, unknown: 0 },
      },
      totals: { merged: 0, not_ancestor: 0, unknown: 0 },
    };

    for (const entry of entries) {
      const repoBucket = repoNameForCode(entry.repo);
      if (repoBucket && summary.by_repo[repoBucket]) {
        summary.by_repo[repoBucket][entry.status] += 1;
      }
      if (summary.by_provenance[entry.provenance]) {
        summary.by_provenance[entry.provenance][entry.status] += 1;
      }
      summary.totals[entry.status] += 1;
    }
    return summary;
  }

  function collectLandingAuditReport(board, options = {}) {
    const rows = Array.isArray(options.rows) ? options.rows : getRows(board);
    const ticketFilter = options.ticket ? String(options.ticket).trim() : null;
    const repoFilter = options.repo ? String(options.repo).trim() : null;
    const entries = [];

    for (const row of rows) {
      if (ticketFilter && row.ID !== ticketFilter) {
        continue;
      }
      if (repoFilter && row.Repo !== repoFilter) {
        continue;
      }
      if (row.Status !== STATUS.DONE || !isRepoBackedCode(row.Repo)) {
        continue;
      }
      if (!requiresLandingGovernance(board, row.ID, row)) {
        continue;
      }
      const entry = classifyLandingRecord(row.ID, row, board.landing_index?.[row.ID] || null);
      if (entry) {
        entries.push(entry);
      }
    }

    return {
      scope: {
        ticket: ticketFilter,
        repo: repoFilter,
      },
      summary: summarizeLandingAuditEntries(entries),
      explicit_not_ancestor: entries.filter((entry) => entry.provenance === "explicit" && entry.status === "not_ancestor"),
      legacy_not_ancestor: entries.filter((entry) => entry.provenance === "legacy" && entry.status === "not_ancestor"),
      unknown: entries.filter((entry) => entry.status === "unknown"),
      backfillable: entries.filter((entry) => entry.provenance === "legacy" && entry.status === "merged"),
      entries,
    };
  }

  function applyLandingAuditBackfill(board, options = {}) {
    const report = collectLandingAuditReport(board, options);
    const backfilled = [];

    for (const entry of report.entries) {
      if (!entry.landing) {
        continue;
      }
      let changed = false;
      if (!entry.landing.provenance_status || entry.landing.provenance_status !== entry.provenance) {
        entry.landing.provenance_status = entry.provenance;
        changed = true;
      }
      if (!entry.landing.commit_sha && entry.provenance === "legacy" && entry.status === "merged" && entry.resolved_commit_sha) {
        entry.landing.commit_sha = entry.resolved_commit_sha;
        changed = true;
      }
      if (changed) {
        backfilled.push({
          ticket_id: entry.ticket_id,
          repo: entry.repo,
          base_ref: entry.base_ref,
          commit_sha: entry.resolved_commit_sha,
          provenance_status: entry.provenance,
        });
      }
    }

    return {
      ...collectLandingAuditReport(board, options),
      backfilled,
    };
  }

  function formatLandingAuditSummary(report) {
    if (!report) {
      return [];
    }
    const explicitFailures = report.explicit_not_ancestor.length;
    const legacyFailures = report.legacy_not_ancestor.length;
    const unknownCount = report.unknown.length;
    const backfillable = report.backfillable.length;
    if (explicitFailures === 0 && legacyFailures === 0 && unknownCount === 0 && backfillable === 0) {
      return [];
    }

    const repoSummary = Object.entries(report.summary.by_repo || {})
      .map(([repoName, counts]) => `${repoName} ${counts.merged} merged / ${counts.not_ancestor} not_ancestor / ${counts.unknown} unknown`)
      .join("; ");
    const lines = [
      `Landing audit: ${repoSummary || "no repo entries"}.`,
      `Landing audit buckets: explicit ${report.summary.by_provenance.explicit.merged} merged / ` +
        `${report.summary.by_provenance.explicit.not_ancestor} not_ancestor / ${report.summary.by_provenance.explicit.unknown} unknown; ` +
        `fulfilled_by ${report.summary.by_provenance.fulfilled_by.merged} merged / ` +
        `${report.summary.by_provenance.fulfilled_by.not_ancestor} not_ancestor / ${report.summary.by_provenance.fulfilled_by.unknown} unknown; ` +
        `legacy ${report.summary.by_provenance.legacy.merged} merged / ${report.summary.by_provenance.legacy.not_ancestor} not_ancestor / ${report.summary.by_provenance.legacy.unknown} unknown; ` +
        `unknown ${report.summary.by_provenance.unknown.unknown}.`,
    ];
    if (report.explicit_not_ancestor.length > 0) {
      lines.push(`Landing audit explicit failures: ${report.explicit_not_ancestor.map((entry) => entry.ticket_id).join(", ")}.`);
    }
    if (report.unknown.length > 0) {
      lines.push(`Landing audit unresolved records: ${report.unknown.map((entry) => entry.ticket_id).join(", ")}.`);
    }
    if (report.backfillable.length > 0) {
      lines.push("Run `coord/scripts/gov audit-landings --write` to backfill commit_sha for legacy merged landing records.");
    } else if (report.legacy_not_ancestor.length > 0 || report.unknown.length > 0) {
      lines.push("Run `coord/scripts/gov audit-landings` for the full landing-provenance breakdown.");
    }
    return lines;
  }

  function ensureTestingInfrastructureLandingAudit(ticketId, row, landing, options = {}) {
    const audit = deriveTestingInfrastructureAudit(ticketId, row, landing);
    if (!audit) {
      return null;
    }
    if ((audit.presentFiles?.length || 0) === 0 && audit.requiredScripts.length === 0) {
      throw new Error(
        `Ticket ${ticketId} testing-infrastructure audit failed against ${audit.repoLabel}/${audit.baseRef}. ` +
        `No current testing-infrastructure files or scripts remain at branch tip to verify this capability.`
      );
    }
    if (audit.missingScripts.length > 0) {
      const missing = [];
      if (audit.missingScripts.length > 0) {
        missing.push(`scripts ${audit.missingScripts.join(", ")}`);
      }
      throw new Error(
        `Ticket ${ticketId} testing-infrastructure audit failed against ${audit.repoLabel}/${audit.baseRef}. Missing at branch tip: ${missing.join("; ")}.`
      );
    }
    if (options.recordEvidence) {
      const evidence = toArray(landing.evidence).filter(
        (entry) => !String(entry || "").startsWith(TESTING_INFRA_LANDING_EVIDENCE_PREFIX)
      );
      evidence.push(audit.evidence);
      landing.evidence = evidence;
    }
    return audit;
  }

  function ensureFeatureProofLandingAudit(ticketId, row, landing, metadata, options = {}) {
    const audit = deriveFeatureProofAudit(ticketId, row, landing, metadata);
    if (!audit) {
      return null;
    }
    if (options.recordEvidence) {
      const evidence = toArray(landing.evidence).filter(
        (entry) => !String(entry || "").startsWith(FEATURE_PROOF_EVIDENCE_PREFIX)
      );
      evidence.push(audit.evidence);
      landing.evidence = evidence;
    }
    return audit;
  }

  function ensureLandingRecord(ticketId, board, row, options = {}) {
    ensureLandingIndex(board);
    const existing = board.landing_index[ticketId];
    if (existing && Array.isArray(existing.evidence) && existing.evidence.length > 0) {
      if (!existing.source_commit_sha) {
        const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);
        if (sourceCommitSha) {
          existing.source_commit_sha = sourceCommitSha;
        }
      }
      if (!existing.provenance_status) {
        existing.provenance_status = existing.fulfilled_by_ticket || existing.fulfilled_by_commit_sha
          ? "fulfilled_by"
          : existing.commit_sha
            ? "explicit"
            : "legacy";
      }
      return existing;
    }

    const prRefs = board.pr_index?.[ticketId] || [];
    const prUrls = prRefs.filter((entry) => isGitHubPrUrl(entry));
    const noPrRefs = prRefs.filter((entry) => /\(no PR\)/.test(String(entry)));
    const fulfilledBy = resolveFulfilledByLandingCommit(ticketId, row, board, options);
    const explicitEvidence = toArray(options.landed);
    const autoEvidence = prUrls.map((url) => {
      const payload = ghPrView(url);
      if (payload.state !== "MERGED" || !payload.mergedAt) {
        fail(`Ticket ${ticketId} references PR ${url}, but it is not merged.`);
      }
      const mergeCommitSha = payload?.mergeCommit?.oid ? ` commit ${payload.mergeCommit.oid}` : "";
      return `${url} merged ${payload.mergedAt}${mergeCommitSha}`;
    });

    if (!fulfilledBy && prUrls.length === 0 && noPrRefs.length > 0 && explicitEvidence.length === 0) {
      fail(`Ticket ${ticketId} uses "(no PR)" closeout evidence. Pass --landed "<canonical-branch closeout proof>" before mark-done.`);
    }

    const fulfilledByEvidence = fulfilledBy
      ? [
        [
          `fulfilled-by ${fulfilledBy.fulfilledByTicket || "commit"}`,
          fulfilledBy.fulfilledByCommitSha,
        ].filter(Boolean).join(" "),
      ]
      : [];
    const evidence = mergeUniqueRefs(autoEvidence, explicitEvidence, fulfilledByEvidence);
    if (evidence.length === 0) {
      if (requiresLandingGovernance(board, ticketId, row)) {
        fail(`Ticket ${ticketId} is governed by landing_index enforcement and needs landing evidence. Pass --landed or merge a PR first.`);
      }
      return null;
    }

    const method = fulfilledBy
      ? "manual"
      : prUrls.length > 0
      ? "pr"
      : noPrRefs.length > 0
        ? "no_pr"
        : "manual";
    const requestedBaseRef = String(options.base || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim() || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH;
    const commitSha = fulfilledBy
      ? fulfilledBy.fulfilledByCommitSha
      : resolveLandingCommitSha(ticketId, row, method, evidence, prUrls, {
      baseRef: requestedBaseRef,
    });
    const baseResolution = resolveLandingBaseRef(getRepoRoot(row.Repo), requestedBaseRef, commitSha, {
      explicitBase: options.baseExplicit === true,
    });
    if (baseResolution.warning) {
      console.warn(baseResolution.warning);
    }
    const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);

    board.landing_index[ticketId] = {
      recorded_at: new Date().toISOString(),
      base_ref: baseResolution.baseRef,
      method,
      commit_sha: commitSha,
      ...(sourceCommitSha ? { source_commit_sha: sourceCommitSha } : {}),
      ...(fulfilledBy?.fulfilledByTicket ? { fulfilled_by_ticket: fulfilledBy.fulfilledByTicket } : {}),
      ...(fulfilledBy?.fulfilledByCommitSha ? { fulfilled_by_commit_sha: fulfilledBy.fulfilledByCommitSha } : {}),
      provenance_status: fulfilledBy ? "fulfilled_by" : "explicit",
      evidence,
    };
    return board.landing_index[ticketId];
  }

  function persistMergedPrLandingSnapshot(ticketId, row, prUrl, options = {}) {
    if (!isRepoBackedCode(row.Repo)) {
      return null;
    }
    const payload = options.prViewPayload || ghPrView(prUrl);
    if (!(payload.state === "MERGED" && payload.mergedAt)) {
      return null;
    }
    const requestedBaseRef = String(options.base || payload.baseRefName || DEFAULT_INTEGRATION_BRANCH).trim() || DEFAULT_INTEGRATION_BRANCH;
    const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);
    const mergeCommitSha = String(payload?.mergeCommit?.oid || "").trim() || null;
    const nextLandingRecord = {
      recorded_at: new Date().toISOString(),
      base_ref: requestedBaseRef,
      method: "pr",
      ...(mergeCommitSha ? { commit_sha: mergeCommitSha } : {}),
      ...(sourceCommitSha ? { source_commit_sha: sourceCommitSha } : {}),
      provenance_status: "explicit",
      evidence: [`${prUrl} merged ${payload.mergedAt}${mergeCommitSha ? ` commit ${mergeCommitSha}` : ""}`],
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const board = readBoard();
      ensureLandingIndex(board)[ticketId] = nextLandingRecord;
      try {
        if (typeof options.onBeforeWrite === "function") {
          options.onBeforeWrite(attempt, board);
        }
        writeBoard(board);
        if (!options.skipBoardSync) {
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        }
        return board.landing_index[ticketId];
      } catch (error) {
        if (!(error instanceof GovernanceError) || !/changed during this command/i.test(error.message) || attempt === 2) {
          throw error;
        }
      }
    }
    fail(
      `Landing record for ${ticketId} could not be persisted after 3 attempts due to concurrent board changes. ` +
      `Retry the command, or manually record landing evidence with: coord/scripts/gov mark-done ${ticketId} --landed "<evidence>".`
    );
  }

  return {
    collectLandingAuditCandidates,
    summarizeLandingAuditEntries,
    collectLandingAuditReport,
    applyLandingAuditBackfill,
    formatLandingAuditSummary,
    ensureTestingInfrastructureLandingAudit,
    ensureFeatureProofLandingAudit,
    ensureLandingRecord,
    persistMergedPrLandingSnapshot,
  };
};
