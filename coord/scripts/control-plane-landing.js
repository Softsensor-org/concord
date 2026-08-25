"use strict";

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
// Self-contained on purpose. `coord/scripts/lifecycle.js` and
// `coord/scripts/governance-validation.js` are append-free composition roots
// (arch-checks `compositionRoot`): new control-flow logic belongs in a module
// that consumers require directly, not in DI wiring threaded through a root.

const { gitTry } = require("./git-ops.js");
const {
  pushControlPlaneIntegrationBranch,
  preCloseoutPushEnabled,
} = require("./control-plane-push.js");
const { recordGovernanceExternalSideEffect } = require("./governance-side-effects.js");
const { findRecordedControlPlanePush } = require("./control-plane-push-history.js");
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

function layoutFor(options = {}) {
  return options.layout || defaultControlPlaneLayout();
}

function integrationBranchFor(layout, options = {}) {
  return resolveControlPlaneIntegrationBranch(layout, {
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
  // COORD-691: the governed pre-closeout push. Before this, the refusal below
  // was terminal for an agent: it instructs "push the control-plane integration
  // branch", and pre-bash-guard.js correctly refuses a hand-run push to a
  // protected branch, so a Repo-X landing could only be completed by a human.
  // Governance performs the push itself instead of exempting a caller from the
  // guard. Opt-in, never forcing, and it does NOT relax the check: the ancestry
  // re-test below is the same test, run again after the push, and a failed or
  // refused push falls through to the same refusal.
  let pushReceipt = null;
  if (!isAncestor(coordRepoRoot, commitSha, remoteBaseRef) && preCloseoutPushEnabled(options)) {
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
  if (!pushReceipt) {
    pushReceipt = findRecordedControlPlanePush(ticketId, commitSha, options);
  }
  if (!isAncestor(coordRepoRoot, commitSha, remoteBaseRef)) {
    throw new Error(
      `Ticket ${ticketId} control-plane landing commit ${commitSha} is not an ancestor of ${remoteBaseRef} in ` +
      `${coordRepoRoot}. Push the control-plane integration branch before finalizing, or the landing record ` +
      "would assert delivery the governance remote does not contain (COORD-635/ADR-0008)." +
      (pushReceipt
        ? ` The governed pre-closeout push ran and did not deliver it: status=${pushReceipt.status}` +
          `${pushReceipt.detail ? ` (${pushReceipt.detail})` : ""} (COORD-691).`
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
  };
}

// Validate-time counterpart of assertLandingIntegrity for control-plane rows.
// Re-verifies ONLY records that claim remote verification.
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
    fulfilled_by_commit_sha: null,
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
function ensureControlPlaneLandingRecord(ticketId, board, row, options = {}) {
  if (!board || typeof board !== "object") {
    return null;
  }
  if (!board.landing_index || typeof board.landing_index !== "object") {
    board.landing_index = {};
  }
  const existing = board.landing_index[ticketId];
  if (existing && Array.isArray(existing.evidence) && existing.evidence.length > 0) {
    return existing;
  }
  const landedRaw = options.landed === undefined || options.landed === null
    ? []
    : (Array.isArray(options.landed) ? options.landed : [options.landed]);
  const prNoPr = (board.pr_index?.[ticketId] || []).filter((entry) => /\(no PR\)/.test(String(entry)));
  const evidence = [...new Set([...landedRaw, ...prNoPr].map((entry) => String(entry).trim()).filter(Boolean))];
  if (evidence.length === 0) {
    return null;
  }
  const assessment = evaluateControlPlaneLanding(
    ticketId,
    { evidence, commit_sha: options.commitSha || null },
    options
  );
  board.landing_index[ticketId] = {
    recorded_at: new Date().toISOString(),
    ...(assessment.base_ref ? { base_ref: assessment.base_ref } : {}),
    method: "no_pr",
    ...(assessment.commit_sha ? { commit_sha: assessment.commit_sha } : {}),
    provenance_status: "explicit",
    control_plane_verification: assessment.verification,
    // COORD-691 (d): the receipt for the push this closeout performed, on the
    // BOARD — a git-tracked artifact — so the record CITES what reached the
    // remote instead of asserting delivery. coord/.runtime/ is gitignored and
    // would not have been durable; that is the trap found landing COORD-680.
    ...(assessment.pre_closeout_push ? { pre_closeout_push: assessment.pre_closeout_push } : {}),
    ...(assessment.reason ? { control_plane_verification_reason: assessment.reason } : {}),
    evidence,
  };
  return board.landing_index[ticketId];
}

module.exports = {
  CONTROL_PLANE_VERIFICATION,
  CONTROL_PLANE_VERIFICATION_REASON,
  controlPlaneLandingVerificationClass,
  resolveControlPlaneLandingCommit,
  evaluateControlPlaneLanding,
  assertControlPlaneLandingIntegrity,
  classifyControlPlaneLandingRecord,
  ensureControlPlaneLandingRecord,
};
