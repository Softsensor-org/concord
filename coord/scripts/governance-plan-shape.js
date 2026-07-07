"use strict";

// COORD-295: the governance PLAN-SHAPE service, extracted from lifecycle.js
// (lifecycle decomposition epic COORD-291..297, slice #4 — the fourth
// behavior-preserving extraction after the COORD-291 boundary contract, following
// sync-provenance / ticket-lock-service / ticket-queue-service). ONE cohesive
// boundary: governance-plan NORMALIZATION (the `governance` sub-record shape) and
// SCAFFOLD-PLAN construction — distinct from `plan-records.js` (canonical plan
// record IO) and `plan-command.js` (the `gov plan`/`update-plan` verbs). The
// functions moved here are the pure-ish shape builders/parsers/formatters plus the
// `ensurePlanStub` seam that composes them with the (injected) plan-record IO.
//
// CRITICAL INVARIANTS — preserved, NOT reimplemented:
//   - Plan JSON/markdown ROUND-TRIPS byte-stable where expected:
//     `normalizeGovernancePlanShape` / `parseGovernancePlanEntries` /
//     `formatGovernancePlanEntry` (+ the review-profile / repair sibling
//     formatters) produce byte-identical output to the pre-move inline code.
//   - `buildDefaultGovernancePlan` / `buildScaffoldPlanRecord` / `ensurePlanStub` /
//     `scaffoldSelfReviewCycle` yield identical plan records (same field order,
//     same TODO scaffolds, same self-review-cycle raw lines, same timestamps via
//     the injected clock-free `new Date().toISOString()` path).
//   - COORD-007: `buildDefaultGovernancePlan` seeds `expected_closeout.base_ref`
//     from the LIVE `REPO_INTEGRATION_BRANCHES` map (injected BY REFERENCE so the
//     `__testing.paths.REPO_INTEGRATION_BRANCHES` in-place mutation propagates).
//
// Everything external is INJECTED via the createGovernancePlanShape factory (NO
// `require()` of governance internals here). Primitives that are guaranteed live at
// factory-call time are injected BY REFERENCE: the governance-context `state`
// object (holding `PLAN_PATH`), the `REPO_INTEGRATION_BRANCHES` map +
// `DEFAULT_INTEGRATION_BRANCH`, the repo-registry predicates `isRepoBackedCode` /
// `repoNameForCode`, the `toArray` util, and the state-io canonical readers/writers
// (`readCanonicalTextFile` / `writeCanonicalTextFile` / `writeCanonicalJsonFile`).
// The plan-record IO collaborators that lifecycle.js wires LATER (from
// `createPlanRecords`) are injected as deferred `(...a) => fn(...a)` wrappers so
// factory wiring order never constrains call-time resolution:
//   - readPlanRecord, extractPlanBlock, renderPlanRecordBlock, appendPlanBlock,
//     syncPlanRecordFromBlock, planRecordPath, writePlanCompatibilityBlockFromRecord
//
// lifecycle.js wires this factory EARLY (before createGovernanceValidation /
// createPlanRecords, which both inject these shape functions) and re-destructures
// the returned functions back into its scope so the `commands` dispatch table, the
// `__testing` facade, and the deferred wrappers other factories inject all resolve
// exactly as before the move.

module.exports = function createGovernancePlanShape(deps = {}) {
  const {
    // governance-context primitive (injected BY REFERENCE)
    state,
    // repo registry / integration-branch config (BY REFERENCE)
    REPO_INTEGRATION_BRANCHES,
    DEFAULT_INTEGRATION_BRANCH,
    isRepoBackedCode,
    repoNameForCode,
    // util
    toArray,
    // state-io canonical readers/writers (BY REFERENCE)
    readCanonicalTextFile,
    writeCanonicalTextFile,
    writeCanonicalJsonFile,
    // plan-record IO collaborators (DEFERRED wrappers — wired later in lifecycle.js)
    readPlanRecord,
    extractPlanBlock,
    renderPlanRecordBlock,
    appendPlanBlock,
    syncPlanRecordFromBlock,
    planRecordPath,
    writePlanCompatibilityBlockFromRecord,
  } = deps;

  function scaffoldSelfReviewCycle(cycleNumber, totalCycles, {
    lens,
    diff,
    risks,
    findings,
    verification,
    verdict,
  } = {}) {
    const raw = [
      `lens=${lens || "TODO"}`,
      `diff=${diff || "TODO"}`,
      `risks=${Array.isArray(risks) && risks.length > 0 ? risks.join(", ") : "TODO"}`,
      `findings=${findings || "TODO"}`,
      `verification=${verification || "TODO"}`,
      `verdict=${verdict || "TODO"}`,
    ].join("; ");
    return {
      cycle: cycleNumber,
      total: totalCycles,
      lens: lens || "TODO",
      diff: diff || "TODO",
      risks: Array.isArray(risks) && risks.length > 0 ? risks : ["TODO"],
      findings: findings || "TODO",
      verification: verification || "TODO",
      verdict: verdict || "TODO",
      raw,
    };
  }

  function buildDefaultGovernancePlan(repoCode) {
    const isRepoBacked = isRepoBackedCode(repoCode);
    // COORD-007: seed expected_closeout.base_ref from REPO_INTEGRATION_BRANCHES so
    // new plan records pick up the repo's configured integration branch instead
    // of always defaulting to "dev".
    const integrationBranch = isRepoBacked
      ? (REPO_INTEGRATION_BRANCHES[repoCode] || DEFAULT_INTEGRATION_BRANCH)
      : "main";
    return {
      expected_closeout: {
        method: isRepoBacked ? "pr" : "no_pr",
        base_ref: integrationBranch,
        provenance_note: null,
      },
      review_profile: "standard",
      ticket_local_repairs: [],
    };
  }

  function normalizeGovernancePlanShape(governance, repoCode) {
    const defaults = buildDefaultGovernancePlan(repoCode);
    const genericDefaults = buildDefaultGovernancePlan("X");
    if (!governance || typeof governance !== "object" || Array.isArray(governance)) {
      return defaults;
    }
    const expectedCloseout = governance.expected_closeout &&
      typeof governance.expected_closeout === "object" &&
      !Array.isArray(governance.expected_closeout)
        ? governance.expected_closeout
        : {};
    const repairs = Array.isArray(governance.ticket_local_repairs) ? governance.ticket_local_repairs : [];
    const normalized = {
      expected_closeout: {
        method: String(expectedCloseout.method || defaults.expected_closeout.method),
        base_ref: String(expectedCloseout.base_ref || defaults.expected_closeout.base_ref),
        provenance_note: expectedCloseout.provenance_note == null ? null : String(expectedCloseout.provenance_note),
      },
      review_profile:
        String(governance.review_profile || defaults.review_profile).trim() === "bounded_repair"
          ? "bounded_repair"
          : defaults.review_profile,
      ticket_local_repairs: repairs
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          kind: String(entry.kind || "").trim(),
          required_question_logged: Boolean(entry.required_question_logged),
          note: entry.note == null ? null : String(entry.note),
        }))
        .filter((entry) => entry.kind),
    };
    if (
      isRepoBackedCode(repoCode) &&
      normalized.expected_closeout.method === genericDefaults.expected_closeout.method &&
      normalized.expected_closeout.base_ref === genericDefaults.expected_closeout.base_ref &&
      normalized.review_profile === genericDefaults.review_profile &&
      normalized.expected_closeout.provenance_note == null &&
      normalized.ticket_local_repairs.length === 0
    ) {
      return defaults;
    }
    return normalized;
  }

  function formatGovernancePlanEntry(value) {
    return `expected_closeout: method=${value.expected_closeout.method}; base_ref=${value.expected_closeout.base_ref}; provenance_note=${value.expected_closeout.provenance_note || "none"}`;
  }

  function formatGovernanceReviewProfileEntry(value) {
    return `review_profile: ${value.review_profile || "standard"}`;
  }

  function formatGovernanceRepairEntry(entry) {
    return `ticket_local_repair: kind=${entry.kind}; required_question_logged=${entry.required_question_logged ? "yes" : "no"}; note=${entry.note || "none"}`;
  }

  function parseGovernancePlanEntries(values, repoCode = "X") {
    const governance = buildDefaultGovernancePlan(repoCode);
    for (const rawValue of values || []) {
      const value = String(rawValue || "").trim();
      if (!value) {
        continue;
      }
      if (/^expected_closeout:/i.test(value)) {
        const method = /method=([^;]+)/i.exec(value)?.[1]?.trim();
        const baseRef = /base_ref=([^;]+)/i.exec(value)?.[1]?.trim();
        const provenanceNote = /provenance_note=(.+)$/i.exec(value)?.[1]?.trim();
        if (method) {
          governance.expected_closeout.method = method;
        }
        if (baseRef) {
          governance.expected_closeout.base_ref = baseRef;
        }
        governance.expected_closeout.provenance_note =
          provenanceNote && provenanceNote.toLowerCase() !== "none" ? provenanceNote : null;
        continue;
      }
      if (/^review_profile:/i.test(value)) {
        const reviewProfile = value.replace(/^review_profile:\s*/i, "").trim();
        governance.review_profile = reviewProfile === "bounded_repair" ? "bounded_repair" : "standard";
        continue;
      }
      if (/^ticket_local_repair:/i.test(value)) {
        const kind = /kind=([^;]+)/i.exec(value)?.[1]?.trim();
        if (!kind) {
          continue;
        }
        const requiredQuestionLogged = /required_question_logged=([^;]+)/i.exec(value)?.[1]?.trim().toLowerCase() === "yes";
        const note = /note=(.+)$/i.exec(value)?.[1]?.trim();
        governance.ticket_local_repairs.push({
          kind,
          required_question_logged: requiredQuestionLogged,
          note: note && note.toLowerCase() !== "none" ? note : null,
        });
      }
    }
    return governance;
  }

  function buildScaffoldPlanRecord(ticketId, repoCode, owner, options = {}) {
    const repoPrefix = repoNameForCode(repoCode);
    const intendedFilesPlaceholder = `${repoPrefix}/.worktrees/${owner}/${ticketId}/*`;
    const now = new Date().toISOString();
    const reviewRound = Number.isInteger(options.reviewRound) && options.reviewRound > 0
      ? options.reviewRound
      : 1;
    const totalCycles = isRepoBackedCode(repoCode) ? 4 : 3;
    const priorFindings = toArray(options.priorFindings).filter(Boolean);
    const changeSummary = toArray(options.changeSummary).filter(Boolean);

    return {
      schema_version: 1,
      ticket_id: ticketId,
      markdown_heading: `## ${ticketId} — ${now}`,
      startup_checklist: ["TODO: completed"],
      traceability_gate: ["TODO: verified | closing-gap | exempt"],
      governance: buildDefaultGovernancePlan(repoCode),
      review_round: reviewRound,
      baseline_reproduction: [
        "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
        "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
      ],
      prior_findings: priorFindings,
      scaffold_placeholders: {
        intended_files: [intendedFilesPlaceholder],
      },
      intended_files: [intendedFilesPlaceholder],
      change_summary: changeSummary.length > 0 ? changeSummary : ["TODO: describe the intended change."],
      verification_commands: ["TODO"],
      critical_invariants: [
        "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
        "TODO: include at least one invariant about state/contract consistency",
      ],
      requirement_closure: [
        "TODO: Ticket ask: <what the ticket said to deliver>",
        "TODO: Implemented: <what is actually delivered in this change>",
        "TODO: Not implemented: <residual gap or none>",
        "TODO: Deferred to: <ticket-id or none>",
        "TODO: Closeout verdict: complete | incomplete",
      ],
      feature_proof: [
        "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
        "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
      ],
      repo_gates: ["TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets"],
      self_review_cycles: [
        scaffoldSelfReviewCycle(1, totalCycles, {
          lens: "TODO contract/state invariants",
          diff: "TODO git diff origin/dev...HEAD -- <paths>",
          risks: ["TODO failure mode 1", "TODO failure mode 2"],
          findings: "TODO none or describe issues fixed",
          verification: "TODO command rerun",
          verdict: "TODO pass or fail — fixed N issues, re-cycling",
        }),
        scaffoldSelfReviewCycle(2, totalCycles, {
          lens: "TODO auth/security/failure modes",
          diff: "TODO git diff origin/dev...HEAD -- <paths>",
          risks: ["TODO failure mode 1", "TODO failure mode 2"],
          findings: "TODO none or describe issues fixed",
          verification: "TODO command rerun",
          verdict: "TODO pass or fail — fixed N issues, re-cycling",
        }),
        scaffoldSelfReviewCycle(3, totalCycles, {
          lens: "TODO tests/operability/performance",
          diff: "TODO git diff origin/dev...HEAD -- <paths>",
          risks: ["TODO failure mode 1", "TODO failure mode 2"],
          findings: "TODO none or describe issues fixed",
          verification: "TODO command rerun",
          verdict: "TODO pass or fail — fixed N issues, re-cycling",
        }),
        ...(totalCycles > 3 ? [scaffoldSelfReviewCycle(4, totalCycles, {
          lens: "TODO requirement closure",
          diff: "TODO ticket ask vs implemented vs deferred scope",
          risks: ["TODO omitted requirement", "TODO incorrect closeout claim"],
          findings: "TODO none or describe scope gaps fixed",
          verification: "TODO compare ticket ask, files, and follow-up tickets",
          verdict: "TODO pass or fail — fixed N issues, re-cycling",
        })] : []),
      ],
      rollback_strategy: ["TODO"],
      security_surface: "no",
      synced_from_markdown_at: now,
    };
  }

  function ensurePlanStub(ticketId, repoCode, owner) {
    const plan = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
    const existingRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
    const existingBlock = extractPlanBlock(plan, ticketId);
    if (existingRecord) {
      if (existingBlock) {
        return { createdMarkdownBlock: false, source: "existing-record-and-block" };
      }
      const block = renderPlanRecordBlock(existingRecord, ticketId);
      writeCanonicalTextFile(state.PLAN_PATH, appendPlanBlock(plan, block), { expectedRaw: plan });
      return { createdMarkdownBlock: true, source: "canonical-record" };
    }
    if (existingBlock) {
      syncPlanRecordFromBlock(ticketId, existingBlock);
      return { createdMarkdownBlock: false, source: "existing-block" };
    }

    const record = buildScaffoldPlanRecord(ticketId, repoCode, owner);
    writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw: "" });
    writePlanCompatibilityBlockFromRecord(ticketId, record);
    return { createdMarkdownBlock: true, source: "new-stub" };
  }

  return {
    scaffoldSelfReviewCycle,
    buildDefaultGovernancePlan,
    normalizeGovernancePlanShape,
    formatGovernancePlanEntry,
    formatGovernanceReviewProfileEntry,
    formatGovernanceRepairEntry,
    parseGovernancePlanEntries,
    buildScaffoldPlanRecord,
    ensurePlanStub,
  };
};
