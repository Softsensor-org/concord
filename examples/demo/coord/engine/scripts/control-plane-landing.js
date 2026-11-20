"use strict";

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const controlPlanePrEvidence = require("./control-plane-pr-evidence.js");

// COORD-635 / ADR-0008 — control-plane (Repo X) landing evidence.
//
// Before this module, `classifyLandingRecord` returned `null` for every
// non-repo-backed code and `assertLandingIntegrity` returned early on the same
// test, so `assertLandingIntegrity` was skipped ENTIRELY for X. A repo-F
// landing is refused unless its commit is an ancestor of
// `origin/<integrationBranch>`; ~22 X landings in one session recorded delivery
// with no remote verification at all. That asymmetry was defensible while X had
// no repository of its own. Under ADR-0008 `coord/` becomes a real repository
// with a governance remote, so the same standard applies.
//
// TWO EVIDENCE CLASSES, NAMED ON THE RECORD:
//
//   "remote_ancestry" — the landed commit is an ancestor of the control-plane
//                       repository's origin/<integrationBranch>. The same bar a
//                       product-repo landing must clear.
//   "local_only"      — there is no control-plane repository, or no governance
//                       remote to verify against. Delivery is asserted from
//                       local history alone.
//
// HISTORICAL RECORDS ARE NOT RETROACTIVELY INVALIDATED AND ARE NOT LEVELLED UP.
// A Repo-X landing record written before this change carries no
// `control_plane_verification` field. It is read as `local_only`: accepted as
// it stands, never re-checked against a remote it was never held to, and never
// relabelled as remotely verified. Only records that CLAIM `remote_ancestry`
// are re-verified at validate time.
//
// Self-contained on purpose. `coord/engine/scripts/lifecycle.js` and
// `coord/engine/scripts/governance-validation.js` are append-free composition roots
// (arch-checks `compositionRoot`): new control-flow logic belongs in a module
// that consumers require directly, not in DI wiring threaded through a root.

const { gitTry } = require("./git-ops.js");
const { resolveFulfillment } = require("./control-plane-fulfillment.js");
const {
  pushControlPlaneIntegrationBranch,
  preCloseoutPushEnabled,
} = require("./control-plane-push.js");
const { recordGovernanceExternalSideEffect } = require("./governance-side-effects.js");
const { findRecordedControlPlanePush } = require("./control-plane-push-history.js");
const { boardPushRefusalHint, isRuleRefusal } = require("./board-push-preflight.js");
const {
  landBoardCommitViaPr, findMergedBoardPr, prWaitFromSeconds, boardPrLandingSideEffect, boardPrLandingRecord, PR_LANDING_STATUS,
} = require("./board-pr-landing.js");
const {
  defaultControlPlaneLayout,
  resolveControlPlaneIntegrationBranch,
} = require("./control-plane-paths.js");

const CONTROL_PLANE_VERIFICATION = Object.freeze({
  REMOTE_ANCESTRY: "remote_ancestry",
  LOCAL_ONLY: "local_only",
});

// The closed set of reasons a landing is classified local_only. Emitted ONLY by
// evaluateControlPlaneLanding and persisted as control_plane_verification_reason,
// so it is a board-schema-visible vocabulary, not free text. Named here so the
// schema enum and the writer are pinned to one another by
// control-plane-landing-schema.test.js rather than by a hand-copied list.
const CONTROL_PLANE_VERIFICATION_REASON = Object.freeze({
  NO_REPOSITORY: "no_control_plane_repository",
  NO_REMOTE: "no_control_plane_remote",
  NO_REMOTE_BRANCH: "no_control_plane_remote_branch",
  NO_RESOLVABLE_COMMIT_SHA: "no_resolvable_commit_sha",
});

// Every git call below is pinned with an explicit directory (gitTry uses
// `git -C <dir>`): resolving the right root does not help if a subprocess
// inherits the wrong cwd (COORD-631).
function resolveCommitish(repoRoot, commitish) {
  const normalized = String(commitish || "").trim();
  if (!normalized) {
    return null;
  }
  const result = gitTry(repoRoot, ["rev-parse", "--verify", `${normalized}^{commit}`]);
  return result.status === 0 ? (String(result.stdout || "").trim() || null) : null;
}

function isAncestor(repoRoot, commitSha, refName) {
  return gitTry(repoRoot, ["merge-base", "--is-ancestor", commitSha, refName]).status === 0;
}

// A CONFIGURED remote named origin — not merely a refs/remotes/origin/* ref.
// A stale remote-tracking ref can outlive the remote that created it (a renamed
// or removed remote leaves refs/remotes/origin/main behind indefinitely).
// Treating that leftover as a governance remote would hold landings to an
// ancestry bar against a ref nothing can ever update — a blanket refusal, not a
// guard, in any clone whose governance remote has been renamed or removed.
//
// CORRECTION (COORD-635 closeout): this hardening was first justified by a
// misreading of the donor, which was believed to have no `origin` remote. It
// does have one; the donor's landing was refused because canonical main was
// genuinely unpushed, which is the guard working as intended. The hardening is
// kept on its own merits — a stale ref is still not a remote — but it is not
// the donor's situation, and it must not be cited as a reason to relax the bar.
function hasOriginRemote(repoRoot) {
  const result = gitTry(repoRoot, ["remote", "get-url", "origin"]);
  return result.status === 0 && Boolean(String(result.stdout || "").trim());
}

function fetchBase(repoRoot, baseRef) {
  const remoteRef = String(baseRef || "").replace(/^origin\//, "");
  if (!remoteRef) {
    return false;
  }
  return gitTry(repoRoot, ["fetch", "origin", remoteRef], { timeout: 20000, killSignal: "SIGKILL" }).status === 0;
}

function controlPlaneLandingVerificationClass(landing) {
  return String(landing?.control_plane_verification || "").trim() === CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY
    ? CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY
    // Absent marker => pre-COORD-635 record: local-only evidence, grandfathered.
    : CONTROL_PLANE_VERIFICATION.LOCAL_ONLY;
}

// COORD-894: project.config.js `boardLanding` ("push" default, or "pr") and
// `boardLandingWaitSeconds`; options override both (tests, callers).
function boardLandingSettings(options = {}) {
  const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
  const paths = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js")).DEFAULT_PATHS;
  return {
    mode: options.boardLanding || paths.boardLanding || "push",
    wait: options.prWait || prWaitFromSeconds(paths.boardLandingWaitSeconds),
  };
}

function layoutFor(options = {}) {
  return options.layout || defaultControlPlaneLayout();
}

function integrationBranchFor(layout, options = {}) {
  return resolveControlPlaneIntegrationBranch(layout, {
    base: options.base,
    configuredBranch: options.configuredBranch,
    gitTry,
  });
}

// Resolve the commit a control-plane landing claims. Never invents one: an
// explicit commit_sha first, then any commit-ish named in the evidence strings
// that actually resolves in the control-plane repository.
function resolveControlPlaneLandingCommit(coordRepoRoot, landing) {
  const explicit = resolveCommitish(coordRepoRoot, landing?.commit_sha || landing?.fulfilled_by_commit_sha);
  if (explicit) {
    return explicit;
  }
  const tokens = String((landing?.evidence || []).join(" ")).match(/\b[0-9a-f]{7,40}\b/gi) || [];
  for (const token of tokens) {
    const resolved = resolveCommitish(coordRepoRoot, token);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

// The verification a NEW control-plane landing record must clear, plus the
// class it is stamped with. Throws only when a remote IS available and the
// commit is absent or not on it — the same fail-closed shape as repo-backed
// landings, and never a refusal in a topology that cannot support the check.
function evaluateControlPlaneLanding(ticketId, landing, options = {}) {
  const layout = layoutFor(options);
  if (!layout || !layout.coordRepoRoot) {
    return {
      verification: CONTROL_PLANE_VERIFICATION.LOCAL_ONLY,
      commit_sha: null,
      base_ref: null,
      reason: CONTROL_PLANE_VERIFICATION_REASON.NO_REPOSITORY,
    };
  }
  const coordRepoRoot = layout.coordRepoRoot;
  const baseRef = integrationBranchFor(layout, options);
  const remoteBaseRef = `origin/${String(baseRef).replace(/^origin\//, "")}`;
  const commitSha = resolveControlPlaneLandingCommit(coordRepoRoot, landing);

  // No configured governance remote => nothing to verify against. Local-only
  // evidence, recorded and named as such; never a refusal.
  if (!hasOriginRemote(coordRepoRoot)) {
    return {
      verification: CONTROL_PLANE_VERIFICATION.LOCAL_ONLY,
      commit_sha: commitSha,
      base_ref: baseRef,
      reason: CONTROL_PLANE_VERIFICATION_REASON.NO_REMOTE,
    };
  }
  // Distinguish "remote has no such branch" from "merely stale tracking ref".
  if (!resolveCommitish(coordRepoRoot, remoteBaseRef)) {
    fetchBase(coordRepoRoot, baseRef);
  }
  if (!resolveCommitish(coordRepoRoot, remoteBaseRef)) {
    return {
      verification: CONTROL_PLANE_VERIFICATION.LOCAL_ONLY,
      commit_sha: commitSha,
      base_ref: baseRef,
      reason: CONTROL_PLANE_VERIFICATION_REASON.NO_REMOTE_BRANCH,
    };
  }

  // Evidence that names no commit at all cannot be checked against the remote.
  // That is WEAKER evidence, not proof of non-delivery, so it is classified
  // local_only rather than refused: refusing here would newly block every
  // prose-only control-plane closeout the lifecycle accepts today, which is a
  // blanket refusal, not a guard. The asymmetry this ticket exists to close is
  // the other one — a landing that NAMES a commit the governance remote does
  // not contain, which is refused immediately below.
  if (!commitSha) {
    return {
      verification: CONTROL_PLANE_VERIFICATION.LOCAL_ONLY,
      commit_sha: null,
      base_ref: baseRef,
      reason: CONTROL_PLANE_VERIFICATION_REASON.NO_RESOLVABLE_COMMIT_SHA,
    };
  }
  if (!isAncestor(coordRepoRoot, commitSha, remoteBaseRef)) {
    fetchBase(coordRepoRoot, baseRef);
  }
  if (options.requireExistingLanding && !isAncestor(coordRepoRoot, commitSha, remoteBaseRef)) {
    throw new Error(`Ticket ${ticketId} fulfilled-by commit ${commitSha} is not already an ancestor of ${remoteBaseRef}. Land and publish the implementation through its normal governed path first; fulfillment does not push it.`);
  }
  // COORD-691: the governed pre-closeout push. Before this, the refusal below
  // was terminal for an agent: it instructs "push the control-plane integration
  // branch", and pre-bash-guard.js correctly refuses a hand-run push to a
  // protected branch, so a Repo-X landing could only be completed by a human.
  // Governance performs the push itself instead of exempting a caller from the
  // guard. Opt-in, never forcing, and it does NOT relax the check: the ancestry
  // re-test below is the same test, run again after the push, and a failed or
  // refused push falls through to the same refusal.
  let pushReceipt = null;
  let prLanding = null;
  // COORD-894: PR landing mode. The setting is the opt-in: the board commit
  // goes through a governance-only PR (auto-merge, merge commit) and closeout
  // continues only once the merge has landed — the ancestry re-test below is
  // unchanged, so a pending PR refuses exactly like an undelivered push.
  const landingMode = boardLandingSettings(options);
  const delivered = isAncestor(coordRepoRoot, commitSha, remoteBaseRef);
  if (landingMode.mode === "pr") {
    // A retry after an earlier run's PR merged: cite that PR, never open a second.
    prLanding = delivered
      ? findMergedBoardPr({ repoRoot: coordRepoRoot, branch: baseRef, commitSha, ticketId, gh: options.gh, gitFn: options.gitFn })
      : landBoardCommitViaPr({
        repoRoot: coordRepoRoot, branch: baseRef, commitSha, ticketId,
        gh: options.gh, gitFn: options.gitFn, sleep: options.sleep, wait: landingMode.wait,
      });
    if (prLanding) recordGovernanceExternalSideEffect(boardPrLandingSideEffect(ticketId, prLanding));
  } else if (!isAncestor(coordRepoRoot, commitSha, remoteBaseRef) && preCloseoutPushEnabled(options)) {
    pushReceipt = pushControlPlaneIntegrationBranch({
      repoRoot: coordRepoRoot,
      branch: baseRef,
      commitSha,
      gitFn: options.gitFn,
    });
    // ROUND 1 REVIEW, finding 2. A successful push has advanced a REAL remote.
    // Recording it only on the in-memory board was not durable: closeout still
    // runs cleanup and mark-done after this point, and a failure there rolls
    // the board back and takes the receipt with it — while the remote stays
    // advanced. The retry then finds ancestry already satisfied, skips the
    // push, and records nothing, so the surviving evidence says no push ever
    // happened. recordGovernanceExternalSideEffect is the mechanism the
    // governance transaction uses precisely for effects it cannot roll back:
    // the mutation is journaled with the effect attached even when it fails.
    // ROUND 2 REVIEW, finding 2: the condition was `pushed`, so an ATTEMPTED
    // push whose outcome was ambiguous — or which moved the remote without
    // delivering the commit under test — recorded nothing at all, and a
    // downstream rollback then lost the only trace of it. The trigger is now
    // "did anything irreversible happen or might it have", not "did we succeed".
    if (pushReceipt && (pushReceipt.pushed || pushReceipt.remote_moved || pushReceipt.attempted)) {
      recordGovernanceExternalSideEffect({
        type: "control_plane_push",
        ticket: ticketId,
        ref: pushReceipt.ref,
        remote: pushReceipt.remote,
        remote_ref: pushReceipt.remote_ref,
        commit_sha: pushReceipt.commit_sha,
        remote_sha_before: pushReceipt.remote_sha_before,
        remote_sha_after: pushReceipt.remote_sha_after,
        forced: false,
        status: pushReceipt.status,
        delivered: Boolean(pushReceipt.pushed),
        remote_moved: Boolean(pushReceipt.remote_moved),
        acknowledged: pushReceipt.acknowledged !== false,
        ...(pushReceipt.ack_lost ? { ack_lost: true } : {}),
        ...(pushReceipt.detail ? { detail: pushReceipt.detail } : {}),
        summary:
          (pushReceipt.pushed
            ? "governed pre-closeout push advanced "
            : pushReceipt.remote_moved
              ? "governed pre-closeout push MOVED the remote without delivering the landing commit on "
              : "governed pre-closeout push ATTEMPTED (outcome not observed as delivery) on ") +
          `${pushReceipt.remote_ref} from ` +
          `${String(pushReceipt.remote_sha_before || "(none)").slice(0, 12)} to ` +
          `${String(pushReceipt.remote_sha_after || "(unchanged)").slice(0, 12)} for ${ticketId}`,
      });
    }
  }
  // The retry case. If an earlier attempt already pushed this commit and then
  // failed downstream, the ancestry test now passes and no push is needed —
  // but the landing record must still CITE the push that delivered it, or the
  // absence of a receipt would falsely read as "the remote always had it".
  if (!pushReceipt && !prLanding) {
    pushReceipt = findRecordedControlPlanePush(ticketId, commitSha, options);
  }
  if (!isAncestor(coordRepoRoot, commitSha, remoteBaseRef)) {
    throw new Error(
      `Ticket ${ticketId} control-plane landing commit ${commitSha} is not an ancestor of ${remoteBaseRef} in ` +
      `${coordRepoRoot}. Push the control-plane integration branch before finalizing, or the landing record ` +
      "would assert delivery the governance remote does not contain (COORD-635/ADR-0008)." +
      (prLanding ? ` ${describePrLandingRefusal(prLanding, ticketId)}` : pushReceipt
        ? ` The governed pre-closeout push ran and did not deliver it: status=${pushReceipt.status}` +
          `${pushReceipt.detail ? ` (${pushReceipt.detail})` : ""} (COORD-691).` +
          (isRuleRefusal(pushReceipt.detail) ? ` ${boardPushRefusalHint(baseRef)}` : "")
        : " A governed push is available: re-run with --push-before-closeout (COORD-691).")
    );
  }
  return {
    verification: CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY,
    commit_sha: commitSha,
    base_ref: baseRef,
    reason: null,
    // COORD-691 acceptance (d): the landing record CITES what reached the
    // remote instead of asserting delivery. Only present when this closeout
    // performed the push.
    ...(pushReceipt ? { pre_closeout_push: pushReceipt } : {}),
    ...(prLanding ? { board_pr_landing: boardPrLandingRecord(prLanding) } : {}),
  };
}

// COORD-894: why a PR-mode landing has not (yet) delivered the commit.
function describePrLandingRefusal(receipt, ticketId) {
  const where = receipt.pr_url ? ` ${receipt.pr_url}` : "";
  if (receipt.status === PR_LANDING_STATUS.MERGED) {
    return `boardLanding is "pr": the board PR${where} merged${receipt.merge_commit_sha ? ` as ${receipt.merge_commit_sha}` : ""} ` +
      "but the landing commit is not on the board branch; merge board PRs with a merge commit, not squash or rebase (COORD-894).";
  }
  // landBoardCommitViaPr always sets `detail` on a pending, closed or failed receipt.
  if (receipt.status === PR_LANDING_STATUS.PENDING) {
    return `boardLanding is "pr": the board PR${where} is ${receipt.status}` +
      ` (${receipt.detail})${receipt.auto_merge ? " with auto-merge enabled" : ""}; ` +
      "closeout completes only after it merges. Nothing was marked done and the PR stays open, so this is resumable: " +
      `once it merges, re-run the same terminal verb (for example \`coord/scripts/gov finalize ${ticketId}\`); ` +
      "the merged PR is found and cited, and no second PR is opened. Raise boardLandingWaitSeconds in " +
      "coord/project.config.js to wait longer (COORD-894).";
  }
  return `boardLanding is "pr": the board PR landing ${receipt.status}${where}` +
    ` (${receipt.detail}); nothing landed (COORD-894).`;
}

// Validate-time counterpart of assertLandingIntegrity for control-plane rows.
// Re-verifies ONLY records that claim remote verification.
// guard:landing-record-integrity
function assertControlPlaneLandingIntegrity(ticketId, landing, options = {}) {
  if (!landing) {
    return;
  }
  if (controlPlaneLandingVerificationClass(landing) !== CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY) {
    return; // grandfathered local-only evidence
  }
  const layout = layoutFor(options);
  if (!layout || !layout.coordRepoRoot) {
    return;
  }
  const baseRef = landing.base_ref || integrationBranchFor(layout, options);
  const remoteBaseRef = `origin/${String(baseRef).replace(/^origin\//, "")}`;
  const commitSha = resolveControlPlaneLandingCommit(layout.coordRepoRoot, landing);
  if (!commitSha) {
    throw new Error(
      `Ticket ${ticketId} control-plane landing record claims remote-verified delivery but has no resolvable ` +
      `commit in ${layout.coordRepoRoot}.`
    );
  }
  if (
    hasOriginRemote(layout.coordRepoRoot) &&
    resolveCommitish(layout.coordRepoRoot, remoteBaseRef) &&
    !isAncestor(layout.coordRepoRoot, commitSha, remoteBaseRef)
  ) {
    throw new Error(
      `Ticket ${ticketId} control-plane landing commit ${commitSha} claims remote-verified delivery but is not ` +
      `an ancestor of ${remoteBaseRef} in ${layout.coordRepoRoot}.`
    );
  }
}

// Audit classification. Returning `null` for X made every control-plane landing
// invisible to `gov audit-landings` — not "audited and clean", but never looked
// at. Control-plane records are classified with their evidence class stated, so
// a local-only record is never mistaken for a remotely verified one.
function classifyControlPlaneLandingRecord(ticketId, row, landing, options = {}) {
  const layout = layoutFor(options);
  const entry = {
    ticket_id: ticketId,
    repo: row.Repo,
    repo_label: "coord",
    base_ref: String(landing?.base_ref || "").trim() || null,
    method: String(landing?.method || "manual").trim() || "manual",
    landing: landing || null,
    provenance: "control_plane",
    evidence_class: controlPlaneLandingVerificationClass(landing),
    control_plane_repo_root: layout?.coordRepoRoot || null,
    status: "unknown",
    resolved_commit_sha: null,
    evidence_commit_candidates: [],
    fulfilled_by_ticket: landing?.fulfilled_by_ticket || null,
    fulfilled_by_commit_sha: landing?.fulfilled_by_commit_sha || null,
    reason: null,
  };
  if (!landing) {
    entry.reason = "missing_landing_record";
    return entry;
  }
  if (!Array.isArray(landing.evidence) || landing.evidence.length === 0) {
    entry.reason = "missing_landing_evidence";
    return entry;
  }
  if (!layout || !layout.coordRepoRoot) {
    entry.status = "local_only";
    entry.reason = "no_control_plane_repository";
    return entry;
  }
  entry.base_ref = entry.base_ref || integrationBranchFor(layout, options);
  const remoteBaseRef = `origin/${String(entry.base_ref).replace(/^origin\//, "")}`;
  entry.resolved_commit_sha = resolveControlPlaneLandingCommit(layout.coordRepoRoot, landing);
  if (!entry.resolved_commit_sha) {
    entry.status = entry.evidence_class === CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY ? "unknown" : "local_only";
    entry.reason = "no_resolvable_commit_sha_in_evidence";
    return entry;
  }
  if (!hasOriginRemote(layout.coordRepoRoot) || !resolveCommitish(layout.coordRepoRoot, remoteBaseRef)) {
    entry.status = "local_only";
    entry.reason = "no_control_plane_remote";
    return entry;
  }
  entry.status = isAncestor(layout.coordRepoRoot, entry.resolved_commit_sha, remoteBaseRef)
    ? "merged"
    : "not_ancestor";
  entry.reason = entry.status === "merged" ? null : "control_plane_commit_not_ancestor";
  return entry;
}

// The control-plane counterpart of ensureLandingRecord. A Repo-X closeout
// previously wrote NO landing record at all — the whole block sat inside
// `if (isRepoBackedCode(...))`. Records the same shape of evidence a product
// landing does, resolved against coordRepoRoot, and stamps the evidence class.
//
// Deliberately does NOT invent evidence and does NOT newly refuse a closeout
// governance already permits: with no `--landed` evidence it returns null and
// the existing closeout gates remain the authority.

// COORD-706 round 2, finding 2: the reviewed source is provenance, so it is
// verified like provenance. It must resolve in the control-plane repository;
// the normalized full sha is what gets recorded, so a short or symbolic value
// cannot later be re-read as something else.
function resolveSourceCommitOrRefuse(ticketId, options = {}) {
  const layout = layoutFor(options);
  const base = integrationBranchFor(layout, options);
  const coordRepoRoot = layout && layout.coordRepoRoot;
  // This preflight runs before the irreversible workspace merge, even when
  // no reviewed source was supplied. A typo must not become local-only proof.
  if (options.base && coordRepoRoot &&
      !resolveCommitish(coordRepoRoot, `refs/heads/${base}`) &&
      !resolveCommitish(coordRepoRoot, `refs/remotes/origin/${base}`)) {
    throw new Error(`Ticket ${ticketId} names missing control-plane base branch "${base}".`);
  }
  const raw = options.sourceCommit;
  if (!raw) {
    return null;
  }
  if (!coordRepoRoot) {
    return null;
  }
  const resolved = resolveCommitish(coordRepoRoot, String(raw));
  if (!resolved) {
    throw new Error(
      `Ticket ${ticketId} names source commit "${raw}", which does not resolve in the control-plane repository ` +
      `${coordRepoRoot}. A landing record may not carry a provenance claim that cannot be verified — supply a ` +
      "commit that exists in this repository, or omit --source-commit."
    );
  }
  return resolved;
}

function resolveControlPlaneFulfillment(ticketId, board, row, options = {}) {
  return resolveFulfillment(ticketId, board, row, options,
    (commitSha, verificationOptions) => evaluateControlPlaneLanding(ticketId, { commit_sha: commitSha }, verificationOptions));
}

function ensureControlPlaneLandingRecord(ticketId, board, row, options = {}, preflightFulfillment) {
  if (!board || typeof board !== "object") {
    return null;
  }
  const rawPrEvidence = options.prEvidence || null;
  const prEvidences = Array.isArray(rawPrEvidence) ? rawPrEvidence : rawPrEvidence ? [rawPrEvidence] : [];
  const prEvidence = prEvidences[0] || null;
  if (prEvidences.some((entry) => !controlPlanePrEvidence.isVerifiedControlPlanePrEvidence(entry))) {
    throw new Error(`Ticket ${ticketId} PR landing requires verified in-process PR evidence.`);
  }
  if (prEvidences.length > 1 && !controlPlanePrEvidence.isVerifiedControlPlanePrEvidenceSet(rawPrEvidence)) {
    throw new Error(`Ticket ${ticketId} multi-PR landing requires a verified, ordered PR evidence set.`);
  }
  if (prEvidences.some((entry) => entry.ticket_id !== ticketId)) {
    throw new Error(`Ticket ${ticketId} PR evidence is affiliated with a different ticket.`);
  }
  if (prEvidence && prEvidences.some((entry) => entry.base_ref !== prEvidence.base_ref)) {
    throw new Error(`Ticket ${ticketId} PR evidence set has inconsistent base attribution.`);
  }
  const existing = board.landing_index?.[ticketId];
  if (existing && Array.isArray(existing.evidence) && existing.evidence.length > 0) {
    if (!prEvidence) return existing;
    const expectedCommit = resolveCommitish(layoutFor(options)?.coordRepoRoot, options.commitSha);
    const prFields = [
      "requested_url", "url", "repository", "number", "base_ref", "state", "merged_at",
      "head_ref", "head_sha", "merge_sha", "ticket_id", "source_commit_sha",
    ];
    const existingProofs = existing.additional_pr_evidence ? [existing.pr_evidence, ...existing.additional_pr_evidence] : [existing.pr_evidence];
    const sameProof = existing.method === "pr" &&
      existing.control_plane_verification === CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY &&
      Boolean(expectedCommit) && existing.commit_sha === expectedCommit &&
      existing.source_commit_sha === prEvidence.source_commit_sha &&
      existing.base_ref === prEvidence.base_ref &&
      existingProofs.length === prEvidences.length && existingProofs.every((stored, index) =>
        prFields.every((field) => stored?.[field] === prEvidences[index]?.[field]));
    if (!sameProof) {
      throw new Error(`Ticket ${ticketId} already has a different or incomplete control-plane landing record; refusing conflicting PR evidence replay.`);
    }
    return existing;
  }
  const fulfillment = preflightFulfillment === undefined
    ? resolveControlPlaneFulfillment(ticketId, board, row, options) : preflightFulfillment;
  const landedRaw = options.landed === undefined || options.landed === null
    ? []
    : (Array.isArray(options.landed) ? options.landed : [options.landed]);
  const prNoPr = (board.pr_index?.[ticketId] || []).filter((entry) => /\(no PR\)/.test(String(entry)));
  const evidence = [...new Set([...landedRaw, ...prNoPr].map((entry) => String(entry).trim()).filter(Boolean))];
  if (fulfillment) evidence.push(`fulfilled-by ${fulfillment.ticket ? `ticket ${fulfillment.ticket} ` : ""}commit ${fulfillment.commitSha}`);
  for (const proof of prEvidences) evidence.push(`Verified GitHub PR ${proof.url} merged as ${proof.merge_sha}`);
  if (prEvidence && fulfillment) {
    throw new Error(`Ticket ${ticketId} cannot combine PR landing evidence with parent-ticket fulfillment.`);
  }
  if (evidence.length === 0) {
    return null;
  }
  // Resolve the reviewed source against the control-plane repository BEFORE it
  // is recorded, and fail closed when it does not resolve. Refusing is right
  // rather than silently dropping it: an operator who names a source is making
  // a provenance claim, and a claim that cannot be resolved is a defect in the
  // landing, not a field to quietly discard.
  const resolvedSourceCommit = resolveSourceCommitOrRefuse(ticketId, options);
  let expectedIntegration = null;
  if (prEvidence) {
    const layout = layoutFor(options);
    const repoRoot = layout && layout.coordRepoRoot;
    const normalizedSource = resolveCommitish(repoRoot, resolvedSourceCommit);
    expectedIntegration = resolveCommitish(repoRoot, options.commitSha);
    if (integrationBranchFor(layout, options) !== prEvidence.base_ref) {
      throw new Error(`Ticket ${ticketId} PR evidence base does not match the selected control-plane base.`);
    }
    if (!normalizedSource || normalizedSource !== prEvidence.source_commit_sha) {
      throw new Error(`Ticket ${ticketId} PR evidence does not match its resolved reviewed source commit.`);
    }
    if (!expectedIntegration) {
      throw new Error(`Ticket ${ticketId} PR-backed landing lacks the actual governed integration commit.`);
    }
    // Defend the writer boundary too: closeout performs this proof after the
    // workspace merge, but before evaluateControlPlaneLanding may publish the
    // integration branch. A direct trusted caller must not be able to push an
    // unrelated commit with otherwise valid PR evidence.
    controlPlanePrEvidence.assertGithubMergeInIntegration({ ticketId, prEvidence: prEvidences, repoRoot, integrationCommitSha: expectedIntegration });
  }
  const assessment = fulfillment?.assessment || evaluateControlPlaneLanding(
    ticketId,
    // New writes use only the structured governed-merge result. Prose token
    // resolution remains available for detecting historical records, not for
    // manufacturing new claims (COORD-707 / COORD-756).
    { commit_sha: options.commitSha || null },
    options
  );
  if (prEvidence) {
    if (assessment.verification !== CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY || assessment.commit_sha !== expectedIntegration) {
      throw new Error(`Ticket ${ticketId} PR-backed landing requires remote-ancestry verification of its governed integration commit.`);
    }
  }
  if (!board.landing_index || typeof board.landing_index !== "object") board.landing_index = {};
  board.landing_index[ticketId] = {
    recorded_at: new Date().toISOString(),
    ...(assessment.base_ref ? { base_ref: assessment.base_ref } : {}),
    method: fulfillment ? "manual" : prEvidence ? "pr" : "no_pr",
    ...(assessment.commit_sha ? { commit_sha: assessment.commit_sha } : {}),
    provenance_status: fulfillment ? "fulfilled_by" : "explicit",
    ...(fulfillment ? { fulfilled_by_commit_sha: fulfillment.commitSha } : {}),
    ...(fulfillment?.ticket ? { fulfilled_by_ticket: fulfillment.ticket } : {}),
    // COORD-706 round 1, finding 1: --source-commit maps to `sourceCommit` and
    // names the REVIEWED SOURCE, which is a different fact from the landing
    // commit — on the COORD-701 landing they were 7082ea7c and 8abccf8f. The
    // control-plane writer recorded neither, so an operator's explicit source
    // was silently dropped. Both are kept, in the two fields the board schema
    // already distinguishes; the product landing writer (landing-audit.js:380)
    // has always done this.
    //
    // ROUND 2, finding 2: RESOLVED AND NORMALIZED, never copied. The first
    // version stored the operator's string verbatim while remote verification
    // checked only the landing commit, so a nonexistent source (ffffffff...)
    // produced a VALID remote_ancestry record carrying a false provenance
    // claim. A record that is trusted precisely because it says
    // remote_ancestry must not contain an unverified field: the whole point of
    // the class is that its contents were checked.
    ...(resolvedSourceCommit ? { source_commit_sha: resolvedSourceCommit } : {}),
    ...(prEvidence ? { pr_evidence: prEvidence, ...(prEvidences.length > 1 ? { additional_pr_evidence: prEvidences.slice(1) } : {}) } : {}),
    control_plane_verification: assessment.verification,
    // COORD-691 (d): the receipt for the push this closeout performed, on the
    // BOARD — a git-tracked artifact — so the record CITES what reached the
    // remote instead of asserting delivery. coord/.runtime/ is gitignored and
    // would not have been durable; that is the trap found landing COORD-680.
    ...(assessment.pre_closeout_push ? { pre_closeout_push: assessment.pre_closeout_push } : {}),
    ...(assessment.board_pr_landing ? { board_pr_landing: assessment.board_pr_landing } : {}),
    ...(assessment.reason ? { control_plane_verification_reason: assessment.reason } : {}),
    evidence,
  };
  return board.landing_index[ticketId];
}

module.exports = {
  resolveControlPlaneFulfillment,
  // COORD-706 round 3: exported so a caller can validate the reviewed source
  // BEFORE performing anything irreversible. Validating inside the writer was
  // too late — by then the in-process integration has happened and the
  // pre-closeout push may have too.
  resolveSourceCommitOrRefuse,
  CONTROL_PLANE_VERIFICATION,
  CONTROL_PLANE_VERIFICATION_REASON,
  controlPlaneLandingVerificationClass,
  resolveControlPlaneLandingCommit,
  evaluateControlPlaneLanding,
  assertControlPlaneLandingIntegrity,
  classifyControlPlaneLandingRecord,
  ensureControlPlaneLandingRecord,
};
