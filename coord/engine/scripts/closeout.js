"use strict";

// Wave 2 (COORD-062): the ticket closeout / land surface extracted from
// lifecycle.js — finalize / land / finish-ticket and the shared
// prepareDoneCloseout readiness gate they all funnel through. DI-factory;
// every cross-module dependency (board-state mutators/readers, identity /
// ownership, PR-merge + landing-evidence helpers, review-readiness + lock /
// worktree checks, journal withGovernanceMutation / inferTicketStatus, plan-
// state writers, repo registry, and the question-log builders) is injected
// rather than re-implemented here.
//
// This module sits downstream of the ticket-transitions state machine
// (COORD-061): finalize/land/finish call moveReview / markDone / applyMarkDone
// from that surface, which is injected as `ticketTransitions`. In turn
// ticket-transitions.markDone needs prepareDoneCloseout (the review->done
// readiness gate that lives here); lifecycle.js resolves that near-circular
// edge by injecting closeout's prepareDoneCloseout into transitions as a
// deferred wrapper. closeout's factory MUST therefore be wired AFTER
// createTicketTransitions. Keep the exported function set clean and complete.

const fs = require("fs");
const path = require("path");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
const { defaultFail, ROOT_DIR, state: governanceState } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const { performValidatedExternalEffect } = require("./governed-external-effect.js");
const { gitTry: closeoutGitTry, formatGitCommand } = require("./git-ops.js");
const { assertWorkspaceDecisionPacketAt } = require("./lifecycle-repox-closeout.js");
const { assertFactoryDependencies } = require("./factory-deps.js");
const integrationAuthority = require("./integration-authority.js");

// COORD-703: resolving a commit is needed BEFORE the merge, and the resolver
// lives in the worktree-ops factory. Injecting it would cost a line in
// coord/engine/scripts/lifecycle.js, which the decomposition proof holds to an EXACT
// line count that may only ratchet DOWNWARD — so it is required directly here,
// the same way control-plane-landing.js is. `deps.resolveCommitishInRepo` still
// wins when supplied, so a test can observe the call.
function resolveCommitInRepo(repoRoot, commitish) {
  if (!repoRoot || !commitish) return null;
  const result = closeoutGitTry(repoRoot, ["rev-parse", "--verify", "--quiet", `${String(commitish)}^{commit}`]);
  // gitTry captures UTF-8 stdout; successful rev-parse emits a commit OID.
  return result.status === 0 ? result.stdout.trim() : null;
}
const { DEFAULT_INTEGRATION_BRANCH } = require("../../paths.js");
// COORD-830 review: the head the governed `commit` verb journalled last for a
// ticket (details.source_commit_sha). It is engine-written provenance of the
// reviewed source for a no-PR ticket, unlike an operator-supplied value.
function readGovernedCommitHead(ticketId, journalPath = governanceState.GOVERNANCE_EVENT_LOG_PATH) {
  let text = "";
  try {
    text = fs.readFileSync(journalPath, "utf8");
  } catch {
    return null;
  }
  let head = null;
  for (const line of text.split("\n")) {
    if (!line.includes("source_commit_sha")) continue;
    try {
      const event = JSON.parse(line);
      if (event.command === "commit" && event.ticket === ticketId && event.result === "succeeded" && event.details?.source_commit_sha) {
        head = String(event.details.source_commit_sha);
      }
    } catch {
      // A torn line is not provenance; the journal's own verifier owns it.
    }
  }
  return head;
}


// COORD-830 review: one reading of a pr_index ref. A GitHub PR URL is
// normalised (trailing slash, query or fragment dropped) so it is compared and
// verified as the PR it names; a ref that looks like a PR URL but does not parse
// is reported as malformed, never silently treated as no-PR evidence.
const PR_URL = /^https:\/\/github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pulls?\/(\d+)\/?(?:[?#]\S*)?$/i;
function classifyPrRef(value) {
  const text = String(value ?? "").trim();
  const match = PR_URL.exec(text);
  if (match) {
    const number = String(Number(match[3]));
    const url = `https://github.com/${match[1]}/${match[2]}/pull/${number}`;
    return { kind: "pr", text, url, key: url.toLowerCase(), number };
  }
  if (/github\.com\/.*\/pull\//i.test(text) && !/\(no PR\)/.test(text)) return { kind: "malformed", text };
  return { kind: /^fulfilled by\b/i.test(text) ? "fulfilled" : "other", text };
}

function recordedPrs(refs) {
  const byKey = new Map();
  for (const entry of (refs || []).map(classifyPrRef)) {
    if (entry.kind === "pr" && !byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

// COORD-830 review finding 1: the PR a closeout command lands or records must be
// the PR the ticket already records, so the decomposition gate qualifies the
// head of the PR that is actually merged. A different PR is refused BEFORE any
// side effect; the governed replacement (`gov set-pr --replace`) records it first.
function commandPrDisagreement(ticketId, requested, recordedRefs) {
  const recorded = recordedPrs(recordedRefs);
  if (recorded.length === 0) return null;
  for (const entry of requested.map(classifyPrRef)) {
    if (entry.kind === "pr" && recorded.some((pr) => pr.key === entry.key)) continue;
    const named = entry.kind === "pr" ? entry.url : entry.text;
    return `Ticket ${ticketId} records ${recorded.map((pr) => pr.url).join(", ")}; --pr "${named}" ` +
      `${entry.kind === "malformed" ? "is not a canonical GitHub PR URL" : "is not a recorded PR"}. ` +
      "Closeout lands and qualifies only the PR the ticket records. To change it, record the replacement " +
      `through governance first: coord/scripts/gov set-pr ${ticketId} --replace --pr "<pr-url>", then re-run without a different --pr.`;
  }
  return null;
}

// COORD-843: two ref lists record the same evidence when they name the same set
// of PRs (compared by normalised key) and the same non-PR entries.
const prRefKey = (value) => {
  const entry = classifyPrRef(value);
  return entry.kind === "pr" ? `pr:${entry.key}` : `text:${entry.text}`;
};
function samePrRefs(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || right.length === 0) return false;
  const a = new Set(left.map(prRefKey)), b = new Set(right.map(prRefKey));
  return a.size === b.size && [...a].every((key) => b.has(key));
}

const requestedPrRefs = (value) => (value === undefined || value === null ? [] : [].concat(value)).filter((entry) => String(entry).trim());

const { defaultControlPlaneLayout, resolveControlPlaneIntegrationBranch, configuredBoardBranch } = require("./control-plane-paths.js");
const { STATUS, FINDING_STATUS } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-constants.js"));
const { ghRepoView: importedGhRepoView } = require("./landing-gh.js");
const evidenceRecord = require("./evidence-record.js");
const controlPlanePrEvidence = require("./control-plane-pr-evidence.js");

// COORD-635 / ADR-0008: control-plane landing evidence. Required directly —
// lifecycle.js is an append-free composition root (arch-checks compositionRoot).
const {
  ensureControlPlaneLandingRecord: importedEnsureControlPlaneLandingRecord,
  assertControlPlaneLandingIntegrity,
  resolveSourceCommitOrRefuse: importedResolveSourceCommitOrRefuse,
  resolveControlPlaneFulfillment,
} = require("./control-plane-landing.js");


// COORD-706: which commit the control-plane landing record should claim.
//
// An explicit operator value WINS. `--source-commit` names the REVIEWED SOURCE,
// which legitimately differs from the merge commit — on the COORD-701 landing
// they were 7082ea7c and 8abccf8f — so an operator who supplied one is not
// overridden by inference.
//
// Otherwise the governed merge's own commit is used. It is taken from what the
// merge RETURNED rather than re-derived: a fresh rev-parse at closeout time
// would resolve HEAD after any commit made since the merge and quietly name the
// wrong one.
//
// When no governed merge ran, nothing is added. A record must never gain a
// commit that no step in this closeout produced.
function resolveControlPlaneCommitOptions(options = {}, repoXCloseout = null) {
  const merged = repoXCloseout && repoXCloseout.mergeCommitSha;
  if (!merged || options.commitSha) {
    return options;
  }
  return { ...options, commitSha: merged };
}

function resolveControlPlaneIntegrationCommit(repoXCloseout, preflightCurrentHeadSha, currentHeadSha) {
  const actualMergeSha = repoXCloseout && repoXCloseout.mergeCommitSha;
  if (actualMergeSha) return actualMergeSha;

  const noWorkspaceMerge = repoXCloseout &&
    Array.isArray(repoXCloseout.merged) && repoXCloseout.merged.length === 0 &&
    !repoXCloseout.recoveredMerge;
  if (!noWorkspaceMerge || !preflightCurrentHeadSha) return null;

  if (String(currentHeadSha || "").toLowerCase() !== String(preflightCurrentHeadSha).toLowerCase()) {
    // guard:closeout-pr-ancestry
    throw new Error("Control-plane integration HEAD changed after PR ancestry preflight; refusing to record an unverified integration commit.");
  }
  return preflightCurrentHeadSha;
}

// COORD-830 review (third pass), finding 1: the workspace merge lands every
// incoming ticket-branch TIP, so a decomposition proof measured at the reviewed
// source qualifies the landing only when nothing beyond that source is merged.
// No-PR: every tip must EQUAL the measured commit. PR: every tip must already be
// in what GitHub merged (an ancestor of, or equal to, the PR merge commit, or of
// the PR head when the merge was a squash or rebase).
function isAncestorOrEqual(repoRoot, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (String(ancestor).toLowerCase() === String(descendant).toLowerCase()) return true;
  return closeoutGitTry(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function findBranchCheckout(repoRoot, branch) {
  const listed = closeoutGitTry(repoRoot, ["worktree", "list", "--porcelain"]);
  let current = null;
  for (const line of String(listed.status === 0 ? listed.stdout : "").split("\n")) {
    const listedPath = /^worktree (.+)$/.exec(line);
    if (listedPath) current = listedPath[1];
    else if (line.trim() === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

// COORD-834: the PR containment rule binds EVERY PR-backed closeout, measured or
// not: the PR review covers only what GitHub merged, so a local commit after the
// reviewed PR head is unreviewed whether or not a decomposition proof exists.
// No-PR closeouts stay gated only when a proof was measured.
// guard:closeout-pr-ancestry
function assertIncomingTipsMeasured({ ticketId, measured, prEvidence = null, repoRoot, incomingBranchTips = [] }) {
  if (!measured && !prEvidence) return;
  const proofs = Array.isArray(prEvidence) ? prEvidence : prEvidence ? [prEvidence] : [];
  for (const { branch, head_sha: tip } of incomingBranchTips) {
    const contained = proofs.length > 0
      ? proofs.some((proof) => [proof.merge_sha, proof.head_sha].some((target) => isAncestorOrEqual(repoRoot, tip, target)))
      : String(tip || "").toLowerCase() === measured.sha;
    if (contained) continue;
    // COORD-834: on the PR path the reset names the GitHub merge commit when one
    // is recorded. It is inside what the PR merged in both the squash and the
    // merge-commit shape, and it carries the GitHub merge the integration check
    // needs; the bare PR head of a squash does not, so resetting there could
    // never be accepted.
    const representativeProof = proofs[0] || null;
    const resetTo = representativeProof ? (representativeProof.merge_sha || representativeProof.head_sha) : measured.sha;
    const checkout = findBranchCheckout(repoRoot, branch);
    const reset = checkout ? formatGitCommand(checkout, ["reset", "--keep", resetTo]) : formatGitCommand(repoRoot, ["branch", "-f", branch, resetTo]);
    // COORD-830 review (fourth pass), finding 4: moving the branch back strands
    // the commits beyond the reviewed head; the recovery saves them first.
    // COORD-830 review (fifth pass): the saved name carries the tip, so a second
    // branch, or a second recovery, never collides with an earlier save.
    const kept = String(tip || branch);
    const save = formatGitCommand(repoRoot, ["branch", `${ticketId}-beyond-review-${kept.replace(/[^0-9A-Za-z]/g, "-")}`, kept]);
    const reReview = representativeProof
      ? `land the extra commits through their own reviewed PR instead (${representativeProof.url} merged ${representativeProof.head_sha})`
      : `make the new tip the reviewed source: coord/scripts/gov return-doing ${ticketId} --summary "<why>" --severity low --qref <Lxx>, ` +
        `coord/scripts/gov commit ${ticketId} --message "<message>" --all from the ticket worktree, re-measure the decomposition-proof at the new head ` +
        `(coord/scripts/gov update-plan ${ticketId} --repo-gate "decomposition-proof: ..."), coord/scripts/gov move-review ${ticketId}, ` +
        "then re-run closeout with --source-commit <the new governed head>";
    throw new Error(
      `Ticket ${ticketId} workspace merge refused: ticket branch ${branch} is at ${tip}, which is not ` +
      `${representativeProof ? (proofs.length === 1 ? `contained in the merged PR ${representativeProof.url}` : `contained in the verified PR set (${proofs.map((proof) => proof.url).join(", ")})`) : measured.label} ${representativeProof ? `(head ${representativeProof.head_sha}, merge ${representativeProof.merge_sha})` : measured.sha}. ` +
      (measured
        ? "The decomposition proof was measured at that reviewed source, so merging this tip would land a commit the proof never measured. "
        : "The PR was reviewed at that head, so merging this tip would land commits no review covered. ") +
      `Recover by saving the commits beyond the reviewed head (${save}), resetting the branch to ${prEvidence ? "what the PR merged" : "the reviewed commit"} (${reset}) and re-running this closeout, or ${reReview}.`
    );
  }
}
// COORD-834 review: a fulfilled-by closeout builds no verified PR evidence, yet
// a PR recorded in pr_index still bounds what was reviewed. The containment
// check needs only the PR's head and GitHub merge commit, read from the merged
// PR that verifyPrEvidence already returned. When those cannot be established
// the closeout refuses any workspace merge instead of skipping the check.
function resolveRecordedPrContainment({ ticketId, prRefs, verifiedPrs, repoRoot }) {
  // COORD-843 (3): one PR recorded under two spellings (case, trailing slash,
  // /pulls) is one PR. Recorded and verified refs are both counted by the
  // normalised key classifyPrRef gives them, never by the exact string.
  const recorded = recordedPrs(prRefs);
  const keys = new Set(recorded.map((pr) => pr.key));
  const verifiedByKey = new Map();
  for (const entry of Array.isArray(verifiedPrs) ? verifiedPrs : []) {
    if (!entry || !entry.payload) continue;
    const classified = classifyPrRef(entry.ref);
    if (classified.kind === "pr" && keys.has(classified.key) && !verifiedByKey.has(classified.key)) verifiedByKey.set(classified.key, entry);
  }
  const entries = [...verifiedByKey.values()];
  const payload = entries.length === 1 && recorded.length === 1 ? entries[0].payload : null;
  const mergeValue = payload && payload.mergeCommit && typeof payload.mergeCommit === "object" ? payload.mergeCommit.oid : payload && payload.mergeCommit;
  const headSha = payload ? resolveCommitInRepo(repoRoot, payload.headRefOid) : null;
  const mergeSha = payload ? resolveCommitInRepo(repoRoot, mergeValue) : null;
  if (headSha && mergeSha) return { evidence: { url: recorded[0].url, head_sha: headSha, merge_sha: mergeSha } };
  const reason = !payload
    ? `exactly one merged PR must be recorded and verified, found ${recorded.length} recorded and ${entries.length} verified`
    : `the PR head ${payload.headRefOid || "(missing)"} or GitHub merge ${mergeValue || "(missing)"} does not resolve in ${repoRoot}`;
  return {
    error: `Ticket ${ticketId} workspace merge refused: the recorded PR ${recorded.map((pr) => pr.url).join(", ")} cannot be verified (${reason}), ` +
      "so the incoming ticket-branch tips cannot be checked against what the PR merged. " +
      `Recover by fetching the PR's commits (${formatGitCommand(repoRoot, ["fetch", "origin"])}) and re-running this closeout, ` +
      `or by correcting pr_index to the single reviewed PR (coord/scripts/gov set-pr ${ticketId} --pr <url> --replace) first.`,
  };
}

// COORD-843 (2): the tip containment above judges only the branches about to be
// merged. A commit made on the local integration branch by hand, after the PR
// merge was brought in, is merged by nothing, so it was never judged, and a
// closeout that merges nothing still reached done with it in local history.
//
// The rule is deliberately narrow, because local dev routinely carries
// unpublished board, journal, prompt and plan commits: it refuses only a
// NON-MERGE commit on the local integration branch that touches a file the PR
// itself changed (the GitHub merge commit's diff against its first parent) and
// that no reviewed or published history already contains: not an ancestor of
// the GitHub merge or the PR head, not reachable from any remote-tracking ref,
// and not inside another ticket's recorded governed landing. Governed-artifact
// commits do not touch the PR's files, so they do not trip it; merge commits
// are skipped because their content is their parents', which are judged instead.
function findUnreviewedLocalBaseCommits({ repoRoot, baseBranch, prEvidence, landingIndex = {}, ticketId, git = closeoutGitTry }) {
  const proofs = Array.isArray(prEvidence) ? prEvidence : prEvidence ? [prEvidence] : [];
  if (!repoRoot || !baseBranch || proofs.length === 0 || proofs.some((proof) => !proof.merge_sha)) return [];
  const baseSha = resolveCommitInRepo(repoRoot, `refs/heads/${baseBranch}`);
  if (!baseSha) return [];
  const lines = (result, label) => {
    if (result.status !== 0) {
      // guard:closeout-pr-ancestry
      throw new Error(`Ticket ${ticketId} closeout refused: could not ${label} in ${repoRoot}: ${String(result.stderr || "").trim() || `git exited ${result.status}`}.`);
    }
    return String(result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
  };
  const files = [...new Set(proofs.flatMap((proof) => lines(git(repoRoot, ["diff-tree", "-r", "--name-only", "--no-commit-id", "--root", "-m", "--first-parent", proof.merge_sha]),
    proofs.length === 1 ? `read the files the PR changed (${proof.merge_sha})` : `read the files PR ${proof.url} changed (${proof.merge_sha})`)))].sort();
  if (files.length === 0) return [];
  // Only the integration branch's published history counts as reviewed: a ticket
  // branch pushed to any remote is not review, so other remote refs excuse nothing.
  const remoteTips = lines(git(repoRoot, ["for-each-ref", "--format=%(objectname)", `refs/remotes/*/${baseBranch}`]), "read the remote-tracking refs");
  const landed = Object.entries(landingIndex || {})
    .filter(([id, landing]) => id !== ticketId && landing && /^[0-9a-f]{7,40}$/i.test(String(landing.commit_sha || "")))
    .map(([, landing]) => String(landing.commit_sha));
  const exclusions = [...proofs.flatMap((proof) => [proof.merge_sha, proof.head_sha]), ...remoteTips, ...landed].filter(Boolean);
  const input = `${[baseSha, ...exclusions.map((sha) => `^${sha}`)].join("\n")}\n`;
  const commits = lines(git(repoRoot, ["--literal-pathspecs", "rev-list", "--no-merges", "--full-history", "--ignore-missing", "--stdin", "--", ...files], { input }),
    `list the commits on local ${baseBranch} beyond the PR merge`);
  const candidates = commits.map((sha) => ({
    sha,
    files: lines(git(repoRoot, ["--literal-pathspecs", "diff-tree", "-r", "--name-only", "--no-commit-id", "--root", sha, "--", ...files]), `read the files ${sha} changed`),
  }));
  if (candidates.length === 0) return candidates;

  // A different commit SHA can still be the exact patch already reviewed in
  // the PR. The GitHub merge's first parent is the base as integrated, while
  // the reviewed head may have diverged from it (including squash merges).
  // The unique merge-base between those commits identifies the reviewed range.
  // Missing or ambiguous topology never excuses a local-base commit.
  const patchId = (sha) => {
    const shown = git(repoRoot, ["show", "--format=", "--binary", sha]);
    if (shown.status !== 0 || !String(shown.stdout || "").trim()) return null;
    const identified = git(repoRoot, ["patch-id", "--stable"], { input: shown.stdout });
    if (identified.status !== 0) return null;
    const rows = String(identified.stdout || "").trim().split("\n").filter(Boolean);
    if (rows.length !== 1) return null;
    const match = /^([a-f0-9]{40})\s+([a-f0-9]{40})$/i.exec(rows[0].trim());
    return match ? match[1].toLowerCase() : null;
  };
  const reviewedPatchIds = new Set();
  for (const proof of proofs) {
    const reviewedHead = /^[a-f0-9]{40}$/i.test(String(proof.head_sha || "")) ? resolveCommitInRepo(repoRoot, proof.head_sha) : null;
    const mergeParentResult = git(repoRoot, ["rev-parse", "--verify", `${proof.merge_sha}^1`]);
    const integrationBase = mergeParentResult.status === 0 ? String(mergeParentResult.stdout || "").trim().toLowerCase() : null;
    let reviewedBase = null;
    if (/^[a-f0-9]{40}$/.test(integrationBase || "") && reviewedHead) {
      const mergeBases = git(repoRoot, ["merge-base", "--all", integrationBase, reviewedHead]);
      const bases = mergeBases.status === 0 ? String(mergeBases.stdout || "").trim().split("\n").map((sha) => sha.trim().toLowerCase()).filter(Boolean) : [];
      if (bases.length === 1 && /^[a-f0-9]{40}$/.test(bases[0])) reviewedBase = bases[0];
    }
    const rangeIsVerified = Boolean(reviewedBase && reviewedHead) &&
      git(repoRoot, ["merge-base", "--is-ancestor", reviewedBase, reviewedHead]).status === 0 &&
      git(repoRoot, ["merge-base", "--is-ancestor", reviewedBase, integrationBase]).status === 0;
    if (rangeIsVerified) {
      const reviewedCommits = lines(git(repoRoot, ["rev-list", "--no-merges", `${reviewedBase}..${reviewedHead}`]),
        `read the verified PR reviewed range ${reviewedBase}..${reviewedHead}`);
      for (const sha of reviewedCommits) {
        const id = patchId(sha);
        if (id) reviewedPatchIds.add(id);
      }
    }
  }
  return candidates.filter((commit) => {
    const id = patchId(commit.sha);
    return !id || !reviewedPatchIds.has(id);
  });
}

// guard:closeout-pr-ancestry
function assertLocalBaseContainedInPr(args) {
  const offenders = findUnreviewedLocalBaseCommits(args);
  if (offenders.length === 0) return;
  const { ticketId, repoRoot, baseBranch, prEvidence } = args;
  const proofs = Array.isArray(prEvidence) ? prEvidence : [prEvidence];
  const representative = proofs[0];
  const listed = offenders.slice(0, 5).map((commit) => `${commit.sha} (${commit.files.join(", ")})`).join("; ");
  const provenanceDescription = proofs.length === 1
    ? `the PR ${representative.url} changed that are outside its verified reviewed patch range (head ${representative.head_sha}, merge ${representative.merge_sha})`
    : `the verified PR set (${proofs.map((proof) => proof.url).join(", ")}) changed that are outside its verified reviewed patch ranges (representative head ${representative.head_sha}, merge ${representative.merge_sha})`;
  throw new Error(
    `Ticket ${ticketId} closeout refused: local ${baseBranch} in ${repoRoot} carries ${offenders.length} commit(s) touching files ${provenanceDescription} and that no remote or ` +
    `recorded landing contains: ${listed}${offenders.length > 5 ? "; ..." : ""}. Closing now would record the PR as the delivery while ` +
    `local ${baseBranch} holds changes to the same files no review covered. Recover by saving each commit on its own branch ` +
    `(${formatGitCommand(repoRoot, ["branch", `${ticketId}-unreviewed-${offenders[0].sha}`, offenders[0].sha])}), removing it from local ${baseBranch} history, ` +
    "and landing it through its own reviewed PR, then re-running this closeout."
  );
}

// COORD-706 round 1, finding 1: `--source-commit` does NOT compete with this.
// It parses to `sourceCommit` and names the REVIEWED SOURCE; the landing commit
// is what the governed merge created. An earlier version of this helper treated
// them as one field and "operator wins" — and its test passed only because the
// test supplied `commitSha` directly, a key the CLI never produces. The two are
// now recorded separately by the writer, so there is nothing to arbitrate.

module.exports = function createCloseout(deps = {}) {
  const resolvedDeps = integrationAuthority.resolveTicketFenceDependencies(deps);
  const fail = resolvedDeps.fail || defaultFail;
  assertFactoryDependencies("createCloseout", resolvedDeps, { callable: ["assertTicketFence"], value: [] });

  const {
    // board-state mutators / readers
    readBoard,
    getTicketRef,
    // journal-produced (must be wired after createJournal)
    withGovernanceMutation,
    inferTicketStatus,
    // identity / ownership
    ensureTicketMutationOwnership,
    assertTicketFence,
    // ticket-transitions surface (must be wired after createTicketTransitions)
    moveReview,
    markDone,
    applyMarkDone,
    // PR merge + landing evidence
    prMerge,
    persistMergedPrLandingSnapshot,
    refreshLandingBaseRef,
    resolvePrUrlForTicket,
    ensureLandingRecord,
    assertLandingIntegrity,
    ensureTestingInfrastructureLandingAudit,
    ensureFeatureProofLandingAudit,
    verifyPrEvidence,
    // review / closeout readiness
    assertReviewPlanReady,
    findOutstandingCloseoutBlockerFollowups,
    findLockForTicket,
    ensureRepoXCloseoutReady,
    cleanupTicketWorktree,
    resolveLifecyclePrRefs,
    // plan-state writers
    updateCanonicalPlanState,
    // question-log builders
    buildQuestionRow,
    buildLandCloseoutAnswer,
    appendQuestionRowText,
    removeQuestionRowText,
    // repo registry
    isRepoBackedCode,
    getRepoRoot,
    resolveRepoIntegrationBranch,
    // misc utilities
    mergeUniqueRefs,
    toArray,
  } = resolvedDeps;

  function closeoutPlanBaseRef(row, options) {
    if (isRepoBackedCode(row.Repo)) return resolveRepoIntegrationBranch(row.Repo);
    // Preserve the legacy plan default when no explicit selector was supplied;
    // COORD-895: that default is the project-configured board branch.
    const hasSelector = [options.base, options.configuredBranch].some(value => String(value || "").trim());
    const layout = options.layout || defaultControlPlaneLayout();
    return hasSelector ? resolveControlPlaneIntegrationBranch(layout, options) : configuredBoardBranch(layout);
  }

  function buildPrCloseoutPlanUpdate(row, prUrl, options = {}) {
    return {
      closeoutMethod: "pr",
      closeoutBaseRef: closeoutPlanBaseRef(row, options),
      provenanceNote: prUrl ? `PR-backed landing via ${prUrl}` : "PR-backed landing through governance",
    };
  }

  function buildNoPrCloseoutPlanUpdate(row, options = {}) {
    return {
      closeoutMethod: options.fulfilledByCommit || options.fulfilledByTicket ? "fulfilled_by" : "no_pr",
      closeoutBaseRef: closeoutPlanBaseRef(row, options),
      provenanceNote: options.landed || null,
    };
  }

  function landTicket(ticketId, options) {
    const mutation = {
      command: "land",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("land requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.REVIEW) {
        fail(`Ticket ${ticketId} must be in review to land; current status is "${ref.row.Status}".`);
      }
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, null, options);

      const prRefs = board.pr_index?.[ticketId] || [];
      const owner = ref.row.Owner || "unassigned";
      const repoRoot = isRepoBackedCode(ref.row.Repo) ? getRepoRoot(ref.row.Repo) : null;
      const requestedBaseRef = String(options.base || DEFAULT_INTEGRATION_BRANCH).trim() || DEFAULT_INTEGRATION_BRANCH;
      const hasNoPrEvidence = prRefs.some((entry) => /\(no PR\)/.test(String(entry)));
      const requestedPr = requestedPrRefs(options.pr);
      const prDisagreement = hasNoPrEvidence ? null : commandPrDisagreement(ticketId, requestedPr, prRefs);
      if (prDisagreement) fail(prDisagreement);
      if (!hasNoPrEvidence && requestedPr.length > 1) fail(`land merges one PR; pass a single --pr <url> for ${ticketId}.`);
      const requestedUrl = requestedPr.length > 0 ? classifyPrRef(requestedPr[0]) : null;
      const prUrl = hasNoPrEvidence ? null
        : (requestedUrl ? (requestedUrl.url || requestedUrl.text) : resolvePrUrlForTicket(board, ref.row, ticketId));
      if (prUrl && !isRepoBackedCode(ref.row.Repo)) {
        // COORD-055: `land` performs a GitHub merge (prMerge), which only supports
        // repo-backed tickets. A PR-backed repo-X (coord / cross-repo) ticket has no
        // repo to merge into; close it with the PR-backed finalize, which records the
        // PR evidence and marks it done without a merge or board hand-edits. (No-PR
        // repo-X tickets still land normally below.)
        fail(
          `Ticket ${ticketId} is repo ${ref.row.Repo} with PR evidence; \`land\` performs a GitHub merge and ` +
          `only supports repo-backed tickets. Close PR-backed ${ref.row.Repo} (coord/cross-repo) tickets with ` +
          `\`coord/scripts/gov finalize ${ticketId} --pr "${prUrl}"\`, which records the PR evidence and marks it done.`
        );
      }
      let mergeResult = null;
      let preflightReceipt = null;
      if (prUrl) {
        // COORD-703: VALIDATE BEFORE ACT. Every merge-independent closeout
        // precondition runs here, before the GitHub merge, through the shared
        // rule in governed-external-effect.js. Previously they were reached only
        // via prepareDoneCloseout — AFTER this merge — so a landing that failed
        // any of them left a merged PR with no board record and required an
        // operator to notice and retry.
        //
        // The same helper serves `submit`, so the ordering is one rule with one
        // implementation rather than a convention each verb is trusted to
        // remember. Three verbs have now broken it independently (COORD-697,
        // this ticket, and the COORD-706 fix's own source validation).
        const effect = performValidatedExternalEffect({
          label: `land:${ticketId}:pr-merge`,
          validations: [
            // Round 1 review: provenance too. An unresolvable --source-commit,
            // or manual/no-PR evidence naming no resolvable commit (the literal
            // CONS-025 failure), must refuse HERE — not after the merge.
            () => { preflightReceipt = runCloseoutPreflight(ticketId, board, ref, options, prUrl); },
            () => assertTicketFence(ticketId),
          ],
          // The merge is handed the PR the preflight qualified, never re-resolved.
          // COORD-830 (third pass), finding 2: and only at the head the
          // decomposition gate measured, via gh's --match-head-commit.
          act: () => prMerge(ticketId, { ...options, pr: prUrl, ...(measuredSources.has(ticketId) ? { matchHeadCommit: measuredSources.get(ticketId).sha } : {}) }),
        });
        mergeResult = effect.result;
        if (
          repoRoot &&
          mergeResult &&
          (mergeResult.status === "merged" || mergeResult.status === "already_merged")
        ) {
          refreshLandingBaseRef(repoRoot, requestedBaseRef);
        }
      } else if (!hasNoPrEvidence) {
        fail(`Could not resolve a GitHub PR for ${ticketId}, and no explicit "(no PR)" evidence is recorded.`);
      }
      let postMergeBoard = readBoard();
      let postMergeRef = getTicketRef(postMergeBoard, ticketId);
      if (!postMergeRef) {
        fail(`Unknown ticket "${ticketId}" after PR merge.`);
      }
      if (prUrl && mergeResult && (mergeResult.status === "merged" || mergeResult.status === "already_merged")) {
        // COORD-703: hand the PRE-RESOLVED source forward. The writer used to
        // resolve it itself, after the merge, and silently fall back when the
        // operator's value did not resolve.
        const landingRecord = persistMergedPrLandingSnapshot(ticketId, postMergeRef.row, prUrl,
          preflightReceipt && preflightReceipt.sourceCommitSha
            ? { ...options, sourceCommit: preflightReceipt.sourceCommitSha }
            : options);
        if (!landingRecord && isRepoBackedCode(postMergeRef.row.Repo)) {
          fail(
            `Landing evidence for ${ticketId} could not be recorded after PR merge. ` +
            `The PR was merged but the board state may be incomplete. ` +
            `Recovery: retry "coord/scripts/gov land ${ticketId}" or use "coord/scripts/gov mark-done ${ticketId} --landed \\"<evidence>\\"".`
          );
        }
        postMergeBoard = readBoard();
        postMergeRef = getTicketRef(postMergeBoard, ticketId);
        if (!postMergeRef) {
          fail(`Unknown ticket "${ticketId}" after recording landing evidence.`);
        }
      }
      try {
        prepareDoneCloseout(ticketId, postMergeBoard, postMergeRef, options, preflightReceipt);
        const rowText = buildQuestionRow({
          from: owner,
          to: "all",
          question: `${ticketId} landed through governance.`,
          answer: buildLandCloseoutAnswer({
            ticketId,
            prUrl,
            prRefs,
            method: options.method || "squash",
            landing: postMergeBoard.landing_index?.[ticketId] || null,
          }),
          resolved: "yes",
        });
        assertTicketFence(ticketId);
        appendQuestionRowText(rowText);
        try {
          assertTicketFence(ticketId);
          applyMarkDone(ticketId, postMergeBoard, postMergeRef);
          updateCanonicalPlanState(ticketId, buildPrCloseoutPlanUpdate(ref.row, prUrl, options), { appendLandingProvenance: true });
        } catch (error) {
          removeQuestionRowText(rowText);
          throw error;
        }
      } catch (error) {
        fail(error.message);
      }
      console.log(`Logged governance closeout note for ${ticketId}.`);
    });
  }

  // COORD-839: finalize and finish journal move-review / set-pr as their own
  // mutations before mark-done, so the ADR packet check inside the workspace
  // integration alone would refuse only after those writes. Run it first,
  // against the same control-plane layout the merge will use. Required here
  // rather than injected: lifecycle.js is a wiring-only root at its LOC cap.
  const assertWorkspaceDecisionPacket = deps.assertWorkspaceDecisionPacket ||
    ((ticketId, options) => assertWorkspaceDecisionPacketAt({
      ticketId, options, layout: options.layout || defaultControlPlaneLayout(), gitTry: closeoutGitTry,
    }));
  function preflightDecisionPacket(ticketId, row, options) {
    if (row.Repo === "X") assertWorkspaceDecisionPacket(ticketId, options);
  }

  function writeFinalizedPlanState(ticketId, row, options) {
    return withGovernanceMutation({ command: "closeout-plan", ticket: ticketId }, () =>
      updateCanonicalPlanState(ticketId, buildNoPrCloseoutPlanUpdate(row, options), { appendLandingProvenance: true })
    );
  }

  function finalizeTicket(ticketId, options = {}) {
    if (!ticketId) {
      fail("finalize requires <ticket-id>.");
    }
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    const prDisagreement = commandPrDisagreement(ticketId, requestedPrRefs(options.pr), board.pr_index?.[ticketId]);
    if (prDisagreement) fail(prDisagreement);
    preflightDecisionPacket(ticketId, ref.row, options);

    if (options.alreadyLanded && !options.noPr) {
      fail("finalize --already-landed requires --no-pr. PR-backed landings should use submit/land or the merged-PR review path.");
    }

    if (options.noPr) {
      const noPrRefs = mergeUniqueRefs(board.pr_index?.[ticketId] || [], toArray(options.pr));
      const explicitNoPr = noPrRefs.some((entry) => /\(no PR\)/.test(String(entry)));
      const refs = explicitNoPr ? noPrRefs : mergeUniqueRefs(noPrRefs, ["local-review (no PR)"]);

      if (ref.row.Status === STATUS.DOING) {
        assertTicketFence(ticketId);
        const result = markDone(ticketId, {
          ...options,
          closeoutFromDoing: true,
          closeoutPrRefs: refs,
        });
        writeFinalizedPlanState(ticketId, ref.row, options);
        return result;
      }
      if (ref.row.Status === STATUS.REVIEW) {
        const existingRefs = board.pr_index?.[ticketId] || [];
        if (existingRefs.length > 0 && !existingRefs.some((entry) => /\(no PR\)/.test(String(entry)))) {
          fail(`Ticket ${ticketId} already has PR evidence recorded. Do not use --no-pr on a ticket that already points at a PR.`);
        }
        assertTicketFence(ticketId);
        const result = markDone(ticketId, { ...options, closeoutPrRefs: refs });
        writeFinalizedPlanState(ticketId, ref.row, options);
        return result;
      }
      // COORD-434/668: retry the stranded plan write idempotently, but journal
      // it as its own mutation so the following sync does not absorb unproven
      // bytes or reject a sanctioned closeout write as semantic drift.
      if (ref.row.Status === STATUS.DONE) {
        assertTicketFence(ticketId);
        writeFinalizedPlanState(ticketId, ref.row, options);
        return;
      }
      fail(`Ticket ${ticketId} must be doing or review to finalize; current status is "${ref.row.Status}".`);
    }

    assertTicketFence(ticketId);
    return finishTicket(ticketId, options);
  }

  // COORD-703: the closeout preconditions that do NOT depend on the merge.
  //
  // Every check here can be decided from local state alone, so every one of them
  // can — and must — run before anything irreversible. They were previously
  // reached only through prepareDoneCloseout, which `land` calls AFTER the PR
  // merge: measured on CONS-025, where PR #12 was squash-merged and the landing
  // then failed and rolled the governed files back, leaving a merged PR with no
  // board record. Extracted so the pre-merge gate and the closeout run the same
  // code rather than two lists that drift.
  // COORD-830: the lock is released at move-review, so review readiness is
  // handed the operator's reviewed source commit (--source-commit) to measure
  // decomposition proofs at; it is never inferred from a worktree or branch.
  // COORD-830 review: the reviewed head a supplied --source-commit must EQUAL.
  // Lazy, so only a refactor measured at a commit asks; resolved from durable
  // provenance (the verified PR head, else the recorded landing source, else
  // the last governed commit), never from the operator's value, a worktree or
  // a branch.
  function readVerifiedPrHead(ticketId, pr) {
    try {
      const verified = verifyPrEvidence(ticketId, [pr.url], { requireMerged: false, allowNoPr: false });
      return {
        sha: verified?.[0]?.payload?.headRefOid,
        label: `the verified PR head of ${pr.url}`,
        reason: `GitHub returned no full head OID for ${pr.url}`,
        fetchRef: `pull/${pr.number}/head`,
      };
    } catch (error) {
      return { reason: `the PR head of ${pr.url} could not be verified (${error.message})` };
    }
  }

  const setPrReplacement = (ticketId, value) => `coord/scripts/gov set-pr ${ticketId} --replace --pr "${value}"`;

  // The head of the PR the command lands, which must be a recorded PR.
  function resolveCommandPrHead(ticketId, prs, commandPr) {
    const selected = classifyPrRef(commandPr);
    const recorded = selected.kind === "pr" && prs.find((pr) => pr.key === selected.key);
    if (!recorded) {
      return { reason: `the PR this command lands (${commandPr}) is not recorded in pr_index for ${ticketId}`, recovery: [setPrReplacement(ticketId, selected.url || commandPr)] };
    }
    return readVerifiedPrHead(ticketId, recorded);
  }

  // COORD-830 review (third pass), finding 3: steps that CREATE the missing
  // provenance. Re-running with --source-commit cannot help when nothing durable
  // names the reviewed head; a governed commit is the engine-written record the
  // no-PR resolver reads (readGovernedCommitHead), so the recovery makes one.
  // COORD-830 review (fourth pass), finding 2: the soft reset goes to the FORK
  // POINT of the ticket branch, never to the integration branch itself: reset
  // onto the branch tip would make the governed commit silently revert every
  // change other tickets landed there since the fork. The branch is named.
  // COORD-830 review (fifth pass): a Repo-X workspace merge lands on whatever
  // branch the coord root has checked out at closeout (assertMergeableWorkspaceHead),
  // so the fork point is resolved against that branch when the step runs, never
  // guessed from origin/HEAD, which can name a different default branch.
  const integrationBranchFor = (row) => (isRepoBackedCode(row.Repo)
    ? resolveRepoIntegrationBranch(row.Repo)
    : `$(${formatGitCommand(defaultControlPlaneLayout().coordRepoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])})`);
  // COORD-830 review (fourth pass), finding 5: the finalize flags this ticket
  // needs (--no-pr without a PR, --merge-workspace for a Repo-X ticket); land
  // applies only to a PR-backed repo-backed ticket.
  const closeoutShape = (row, noPr) => {
    const repoX = !isRepoBackedCode(row.Repo);
    return { flags: [...(noPr ? ["--no-pr"] : []), ...(repoX ? ["--merge-workspace"] : [])], landable: !repoX && !noPr };
  };
  const createProvenanceSteps = (ticketId, row) => {
    // COORD-830 review (sixth pass): the step refuses, rather than silently doing
    // nothing or re-parenting onto the wrong history, when the integration checkout
    // is detached or on a ticket branch, and never resets onto an empty fork point.
    // guard:closeout-pr-ancestry
    const reparent = `b="${integrationBranchFor(row)}"; case "$b" in ""|agent/*) echo "refused: the integration checkout must be on its integration branch, not '$b'" >&2; false;; esac` +
      ' && f=$(git -C <ticket worktree> merge-base HEAD "$b") && [ -n "$f" ] && git -C <ticket worktree> reset --soft "$f"';
    return [
      `coord/scripts/gov return-doing ${ticketId} --summary "record governed provenance for the reviewed head" --severity low --qref <Lxx>`,
      `git -C <ticket worktree> branch ${ticketId}-before-provenance-$(git -C <ticket worktree> rev-parse --short=12 HEAD) HEAD  # keeps the hand-made commits reachable`,
      `${reparent}  # only when every change is already committed by hand; keeps the tree, re-parents onto the fork point`,
      `coord/scripts/gov commit ${ticketId} --message "<message>" --all`,
      `coord/scripts/gov move-review ${ticketId}`,
      ["coord/scripts/gov finalize", ticketId, ...closeoutShape(row, true).flags, "--source-commit <head printed by gov commit>"].join(" "),
    ];
  };

  // A PR replacement can succeed only when the PR's head branch is the ticket's
  // own (the control-plane PR verifier refuses an unaffiliated head branch).
  function prHeadIsAffiliated(ticketId, pr) {
    let headRef = "";
    try {
      headRef = String(verifyPrEvidence(ticketId, [pr.url], { requireMerged: false, allowNoPr: false })?.[0]?.payload?.headRefName || "");
    } catch {
      return false;
    }
    // COORD-1013: the shared governed-branch matcher (a PR head naming the id only in another slug is not affiliated).
    return controlPlanePrEvidence.ticketBranchMatches(ticketId, headRef);
  }

  // COORD-830 review finding 2: one PR beside non-PR evidence (live shape: a PR
  // plus "Fulfilled by ... (no PR)"). The fulfilment landing's recorded,
  // verified source is the provenance when one exists; otherwise the refusal
  // names only the replacements that resolve it, since --source-commit alone
  // cannot: the PR replacement when its head branch is the ticket's, the
  // non-PR replacement when a landing source or governed commit then names the
  // head, and the provenance-creating steps when neither does.
  function resolvePrBesideNoPrEvidence(ticketId, pr, others, landing, row) {
    const fulfilled = others.every((entry) => entry.kind === "fulfilled") &&
      Boolean(landing?.fulfilled_by_commit_sha || landing?.fulfilled_by_ticket);
    if (fulfilled && landing.source_commit_sha) {
      return { sha: landing.source_commit_sha, label: "the recorded fulfilment landing source" };
    }
    const recovery = [];
    if (prHeadIsAffiliated(ticketId, pr)) recovery.push(setPrReplacement(ticketId, pr.url));
    const noPrHead = landing?.source_commit_sha || (deps.readGovernedCommitHead || readGovernedCommitHead)(ticketId);
    if (noPrHead) recovery.push(setPrReplacement(ticketId, others[0].text));
    return {
      reason: `pr_index for ${ticketId} names ${pr.url} beside non-PR evidence "${others[0].text}" and no recorded fulfilment landing source resolves which is the reviewed head`,
      recovery: recovery.length > 0 ? recovery : [setPrReplacement(ticketId, others[0].text), ...createProvenanceSteps(ticketId, row)],
    };
  }

  // `commandPr` is the PR the command itself will merge (land); when absent the
  // ticket's recorded pr_index is the only source.
  function reviewedSourceResolver(ticketId, board, row, commandPr = null) {
    const resolveSource = () => {
      const refs = (board.pr_index?.[ticketId] || []).map(classifyPrRef);
      const malformed = refs.find((entry) => entry.kind === "malformed");
      if (malformed) {
        return {
          reason: `pr_index for ${ticketId} holds "${malformed.text}", which is not a canonical GitHub PR URL, so the reviewed head cannot be read from it`,
          recovery: [setPrReplacement(ticketId, "https://github.com/<owner>/<repo>/pull/<number>")],
        };
      }
      const prs = recordedPrs(board.pr_index?.[ticketId]);
      if (commandPr) return resolveCommandPrHead(ticketId, prs, commandPr);
      if (prs.length > 1) {
        return {
          reason: `pr_index for ${ticketId} names ${prs.length} PRs, so the reviewed head is ambiguous`,
          recovery: [setPrReplacement(ticketId, "<the reviewed PR url>"), `coord/scripts/gov land ${ticketId} --pr "<the reviewed PR url>"`],
        };
      }
      const others = refs.filter((entry) => entry.kind !== "pr");
      const landing = board.landing_index?.[ticketId];
      if (prs.length === 1) {
        return others.length === 0 ? readVerifiedPrHead(ticketId, prs[0]) : resolvePrBesideNoPrEvidence(ticketId, prs[0], others, landing, row);
      }
      if (landing?.source_commit_sha) return { sha: landing.source_commit_sha, label: "the recorded landing source" };
      return {
        sha: (deps.readGovernedCommitHead || readGovernedCommitHead)(ticketId),
        label: "the ticket's last governed commit",
        reason: `no PR, recorded landing source, or governed commit names the reviewed head of ${ticketId}`,
        // COORD-830 (third pass), finding 3: used only when no sha resolved.
        recovery: createProvenanceSteps(ticketId, row),
        advice: "create governed provenance for the reviewed head first (the steps below), then re-run closeout with --source-commit set to the head gov commit printed.",
      };
    };
    // COORD-830 review (fourth pass), finding 5: the gate's re-run steps carry
    // the flags this ticket's closeout needs.
    return () => ({ ...resolveSource(), closeout: closeoutShape(row, !commandPr && recordedPrs(board.pr_index?.[ticketId]).length === 0) });
  }

  // COORD-830 review (third pass), finding 1: the reviewed head each closeout
  // resolved for the decomposition gate. The gate refuses unless the measured
  // source EQUALS it, so a value here after readiness passed is the commit the
  // proof measured; the workspace merge then refuses to land anything else.
  const measuredSources = new Map();
  function measuringSourceResolver(ticketId, board, row, commandPr = null) {
    const resolve = reviewedSourceResolver(ticketId, board, row, commandPr);
    return () => {
      const resolved = resolve();
      const sha = String(resolved?.sha || "").trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(sha)) measuredSources.set(ticketId, { sha, label: resolved.label });
      return resolved;
    };
  }

  // guard:evidence-record
  function assertMergeIndependentCloseoutPreconditions(ticketId, board, ref, sourceCommit, commandPr = null, options = {}) {
    if (ref.row.Status !== STATUS.REVIEW) {
      throw new Error(`Ticket ${ticketId} must be in review; current status is "${ref.row.Status}".`);
    }

    measuredSources.delete(ticketId);
    assertReviewPlanReady(ticketId, ref.row, { sourceCommit, resolveReviewedSource: measuringSourceResolver(ticketId, board, ref.row, commandPr) });

    const prRefsForCheck = board.pr_index?.[ticketId];
    if (!Array.isArray(prRefsForCheck) || prRefsForCheck.length === 0) {
      throw new Error(`Ticket ${ticketId} is review but has no pr_index evidence.`);
    }

    const findingsForCheck = board.review_findings?.[ticketId] || [];
    const openForCheck = findingsForCheck.filter((finding) => finding.status === FINDING_STATUS.OPEN);
    if (openForCheck.length > 0) {
      throw new Error(`Ticket ${ticketId} still has open review findings.`);
    }

    const outstandingForCheck = findOutstandingCloseoutBlockerFollowups(board, ticketId);
    if (outstandingForCheck.length > 0) {
      throw new Error(
        `Ticket ${ticketId} cannot close while closeout-blocker follow-up tickets remain open: ` +
        `${outstandingForCheck.map((row) => `${row.ID} (${row.Status})`).join(", ")}.`
      );
    }

    // ROUND 1 REVIEW: this list was INCOMPLETE, which is worse than having no
    // preflight at all — it looked like the ordering was fixed while the engine
    // could still merge and then refuse. A production probe with a lingering
    // lock produced:
    //
    //   validate:review-plan / ACT:pr-merge / record:landing-snapshot /
    //   validate:merged-pr / validate:lock / ERROR: still has a lock file
    //
    // Everything below is decidable from local state, so everything below must
    // be decided BEFORE the merge.
    const lockForCheck = findLockForTicket(ticketId);
    if (lockForCheck && options.closeoutFromDoing !== true) {
      throw new Error(
        `Ticket ${ticketId} still has a lock file at ${path.relative(ROOT_DIR, lockForCheck.path)}.`
      );
    }
  }

  // COORD-703 round 1: provenance the landing will need, resolved BEFORE the
  // merge and handed forward. `resolveSourceCommitSha` previously ran inside the
  // post-merge snapshot writer (landing-audit.js:389) and, worse, SILENTLY
  // IGNORED an unresolvable --source-commit by falling through to the worktree
  // head — so a typo produced a landing recorded against a different commit
  // than the operator named, after the merge had already happened.
  function preflightLandingProvenance(ticketId, board, ref, options = {}) {
    const resolved = { sourceCommitSha: null };
    if (!isRepoBackedCode(ref.row.Repo)) {
      return resolved;
    }
    if (options.sourceCommit) {
      const repoRoot = getRepoRoot(ref.row.Repo);
      const explicit = (deps.resolveCommitishInRepo || resolveCommitInRepo)(repoRoot, options.sourceCommit);
      if (!explicit) {
        // guard:evidence-record
        throw new Error(evidenceRecord.explicitSourceCommitUnresolvableMessage(ticketId, options.sourceCommit, repoRoot));
      }
      resolved.sourceCommitSha = explicit;
      return resolved;
    }
    // ROUND 2 REVIEW: the IMPLICIT path was uncovered. With no --source-commit
    // the preflight resolved nothing, the writer received sourceCommit=none, and
    // resolveSourceCommitSha re-derived it AFTER the merge from the worktree
    // head or branch (landing-audit.js:398). Resolution must happen before the
    // act on every path, not only when the operator names a value.
    // Injected when the composition root wires it; absent in the narrow test
    // factories, where the explicit path above is what is under test.
    if (typeof deps.resolveSourceCommitSha === "function") {
      resolved.sourceCommitSha = deps.resolveSourceCommitSha(ticketId, ref.row, options) || null;
    }
    return resolved;
  }

  // COORD-703 round 2: the PREFLIGHT RECEIPT.
  //
  // Round 1 preflighted a subset. Round 2's repair preflighted the rest — and
  // then prepareDoneCloseout ran the SAME checks again after the merge, so any
  // of them could still refuse post-merge. Repeating a check after the act is
  // the defect in miniature: it does not matter that it passed before if it can
  // fail after. The receipt records that the merge-independent set has already
  // been decided, so the closeout runs only what genuinely depends on the merge.
  function runCloseoutPreflight(ticketId, board, ref, options = {}, commandPr = null) {
    assertMergeIndependentCloseoutPreconditions(ticketId, board, ref, options.sourceCommit, commandPr, options);
    assertLandingCommitResolvable(ticketId, board, ref, options);
    const provenance = preflightLandingProvenance(ticketId, board, ref, options);
    return {
      preflighted: true,
      ticketId,
      sourceCommitSha: provenance.sourceCommitSha,
    };
  }


  // COORD-703 round 1: the literal CONS-025 failure, moved before the merge.
  // A landing whose evidence is manual or no-PR must name a commit that
  // resolves; that was previously discovered only inside the post-merge landing
  // writer, which is how PR #12 came to be squash-merged before the landing was
  // refused.
  // guard:evidence-record
  function assertLandingCommitResolvable(ticketId, board, ref, options = {}) {
    if (!isRepoBackedCode(ref.row.Repo)) {
      return;
    }
    const landedRaw = options.landed === undefined || options.landed === null
      ? []
      : (Array.isArray(options.landed) ? options.landed : [options.landed]);
    if (landedRaw.length === 0) {
      return; // no manual evidence supplied: the merge itself will name the commit
    }
    const repoRoot = getRepoRoot(ref.row.Repo);
    const resolver = deps.resolveCommitishInRepo || resolveCommitInRepo;
    const tokens = landedRaw
      .flatMap((entry) => String(entry).match(/\b[0-9a-f]{7,40}\b/gi) || [])
      .map((token) => resolver(repoRoot, token))
      .filter(Boolean);
    if (tokens.length === 0) {
      // guard:evidence-record
      throw new Error(evidenceRecord.landedEvidenceUnresolvableMessage(ticketId));
    }
  }

  function prepareDoneCloseout(ticketId, board, ref, options = {}, preflight = null) {
    // COORD-703 round 2: when a preflight receipt is present, the
    // merge-independent set was already decided BEFORE the irreversible act and
    // is NOT re-run here. Re-running it is what kept the defect alive: a check
    // that passed pre-merge and fails post-merge still refuses after the merge.
    // Verbs that reach this function without an irreversible act of their own
    // (finalize, mark-done) pass no receipt and run the full set, as before.
    if (!preflight || preflight.preflighted !== true) {
      assertMergeIndependentCloseoutPreconditions(ticketId, board, ref, options.sourceCommit, null, options);
    }

    const prRefs = board.pr_index?.[ticketId];
    if (!Array.isArray(prRefs) || prRefs.length === 0) {
      throw new Error(`Ticket ${ticketId} is review but has no pr_index evidence.`);
    }
    // MERGE-DEPENDENT by construction: this asserts the PR is merged, which is
    // only true after the act. It stays.
    const verifiedPrRefs = verifyPrEvidence(ticketId, prRefs, {
      requireMerged: true,
      allowNoPr: true,
    });

    let repoXCloseout = null;
    let resolvedSourceCommit = null;
    let controlPlaneFulfillment = null;
    let verifiedControlPlanePr = null;
    let controlPlaneRepoRoot = null;
    let verifiedControlPlaneIntegrationCommitSha = null;
    if (ref.row.Repo === "X") {
      // COORD-667: options carry `--merge-workspace`, the opt-in that lets
      // governance perform the control-plane workspace merge in-process rather
      // than printing a `git merge` the pre-bash-guard is designed to refuse.
      // COORD-706 round 2, finding 2 — PREFLIGHT, before anything irreversible.
      //
      // The reviewed source was previously validated inside the landing-record
      // writer, which runs AFTER the in-process workspace integration below and
      // after the pre-closeout push the writer itself performs. A
      // production-order probe returned ["workspace-merge",
      // "source-validation"]: an invalid source still left a real irreversible
      // integration, and possibly a real push, behind. This is COORD-703's
      // class — validate before you act — appearing inside the fix for a
      // different provenance defect, so it is corrected here rather than
      // waited on.
      const preflightSourceCommit = deps.resolveSourceCommitOrRefuse || importedResolveSourceCommitOrRefuse;
      resolvedSourceCommit = preflightSourceCommit(ticketId, options);
      controlPlaneFulfillment = resolveControlPlaneFulfillment(ticketId, board, ref.row, options);

      const hasPrRef = prRefs.some((value) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(String(value)));
      let preflightCurrentHeadSha = null;
      if (hasPrRef && !controlPlaneFulfillment) {
        if (options.mergeWorkspace !== true) {
          throw new Error(`Ticket ${ticketId} PR-backed Repo-X closeout requires --merge-workspace so the governed integration commit can be verified.`);
        }
        const layout = options.layout || defaultControlPlaneLayout();
        controlPlaneRepoRoot = layout && layout.coordRepoRoot;
        const repository = (deps.ghRepoView || importedGhRepoView)(controlPlaneRepoRoot);
        const selectedBaseRef = resolveControlPlaneIntegrationBranch(layout, options);
        const proofs = controlPlanePrEvidence.verifyControlPlanePrEvidenceSet({
          ticketId,
          refs: prRefs,
          verifiedPrs: verifiedPrRefs,
          expectedRepository: repository && repository.nameWithOwner,
          selectedBaseRef,
          sourceCommitSha: resolvedSourceCommit,
          repoRoot: controlPlaneRepoRoot,
        });
        verifiedControlPlanePr = proofs.length === 1 ? proofs[0] : proofs;
      }

      // COORD-703: the Repo-X in-process integration is irreversible too, so it
      // goes through the same rule. The preconditions have already run above in
      // prepareDoneCloseout, but stating them here as the effect's validations
      // makes the ordering structural rather than positional — a later edit that
      // moves this call cannot silently move it ahead of the checks.
      // Read when the merge is planned: the readiness re-run below re-binds it.
      // COORD-830 review (fourth pass), finding 5: so the validator is always
      // attached and reads measuredSources itself; deciding here would miss a
      // measurement made only by that re-run.
      const measuredRoot = controlPlaneRepoRoot || (options.layout || defaultControlPlaneLayout())?.coordRepoRoot;
      const recordedPr = hasPrRef && controlPlaneFulfillment
        ? resolveRecordedPrContainment({ ticketId, prRefs, verifiedPrs: verifiedPrRefs, repoRoot: measuredRoot })
        : null;
      // guard:evidence-record
      const assertMeasuredLands = (plan) => {
        if (recordedPr && recordedPr.error && plan.incomingBranchTips.length > 0) throw new Error(recordedPr.error);
        assertIncomingTipsMeasured({
          ticketId, measured: measuredSources.get(ticketId) || null, prEvidence: verifiedControlPlanePr || (recordedPr && recordedPr.evidence) || null,
          repoRoot: measuredRoot, incomingBranchTips: plan.incomingBranchTips,
        });
      };
      const readinessOptions = !verifiedControlPlanePr
        ? { ...options, validatePlannedWorkspaceIntegration: assertMeasuredLands }
        : {
            ...options,
            validatePlannedWorkspaceIntegration: (plan) => {
              assertMeasuredLands(plan);
              const validated = controlPlanePrEvidence.assertGithubMergeInPlannedIntegration({
                ticketId,
                prEvidence: verifiedControlPlanePr,
                repoRoot: controlPlaneRepoRoot,
                currentHeadSha: plan.currentHeadSha,
                incomingBranchTips: plan.incomingBranchTips,
              });
              // A current integration HEAD can be the planned landing only
              // when there are no workspace branches to merge. Incoming tips
              // are never fallback evidence: the lifecycle must return the
              // actual commit it creates for those integrations.
              if (plan.incomingBranchTips.length === 0) preflightCurrentHeadSha = validated;
              return validated;
            },
          };
      const containedPrEvidence = verifiedControlPlanePr || (recordedPr && recordedPr.evidence) || null;
      repoXCloseout = performValidatedExternalEffect({
        label: `closeout:${ticketId}:workspace-integration`,
        validations: [
          () => assertMergeIndependentCloseoutPreconditions(ticketId, board, ref, resolvedSourceCommit || options.sourceCommit, null, options),
          () => containedPrEvidence && assertLocalBaseContainedInPr({
            ticketId, repoRoot: measuredRoot, prEvidence: containedPrEvidence, landingIndex: board.landing_index,
            baseBranch: resolveControlPlaneIntegrationBranch(options.layout || defaultControlPlaneLayout(), options),
          }),
        ],
        act: () => ensureRepoXCloseoutReady(ticketId, readinessOptions) || null,
      }).result;

      if (verifiedControlPlanePr) {
        const currentHeadSha = resolveCommitInRepo(controlPlaneRepoRoot, "HEAD");
        verifiedControlPlaneIntegrationCommitSha = resolveControlPlaneIntegrationCommit(
          repoXCloseout,
          preflightCurrentHeadSha,
          currentHeadSha
        );
        if (!verifiedControlPlaneIntegrationCommitSha) {
          throw new Error(`Ticket ${ticketId} PR closeout did not produce or preflight a verified control-plane integration commit.`);
        }
        controlPlanePrEvidence.assertGithubMergeInIntegration({
          ticketId,
          prEvidence: verifiedControlPlanePr,
          repoRoot: controlPlaneRepoRoot,
          integrationCommitSha: verifiedControlPlaneIntegrationCommitSha,
        });
      }
    }
    if (isRepoBackedCode(ref.row.Repo)) {
      const landing = ensureLandingRecord(ticketId, board, ref.row, options);
      assertLandingIntegrity(ticketId, ref.row, landing);
      ensureTestingInfrastructureLandingAudit(ticketId, ref.row, landing, { recordEvidence: true });
      ensureFeatureProofLandingAudit(ticketId, ref.row, landing, board.metadata, { recordEvidence: true });
      cleanupTicketWorktree(ticketId, ref.row, options);
    } else if (ref.row.Repo === "X") {
      // COORD-635 defects (2)+(3): a control-plane closeout previously did
      // NEITHER of the two things a product closeout does — it recorded no
      // landing evidence and it cleaned no worktree. Successful closeout was
      // therefore the largest producer of stale X worktrees, and the one that
      // had to be repaired by hand. Both now run, through the same verbs.
      // COORD-706: hand the governed merge's own commit to the landing-record
      // writer, through a helper that is exported and unit-tested. Inlining the
      // decision here left it unpinned: ensureControlPlaneLandingRecord is
      // imported directly rather than injected, so no closeout-level test can
      // observe what it was handed, and deleting this join passed the whole
      // suite.
      // The preflight already resolved and normalized the source; hand the
      // normalized value forward so the writer records exactly what was
      // validated rather than re-deriving it from the raw operator string.
      const controlPlaneOptions = resolveControlPlaneCommitOptions(
        {
          ...options,
          ...(resolvedSourceCommit ? { sourceCommit: resolvedSourceCommit } : {}),
          ...(verifiedControlPlanePr ? { prEvidence: verifiedControlPlanePr } : {}),
        },
        repoXCloseout
      );
      if (verifiedControlPlanePr && verifiedControlPlaneIntegrationCommitSha) {
        controlPlaneOptions.commitSha = verifiedControlPlaneIntegrationCommitSha;
      }
      // COORD-706: the writer is resolved through deps when supplied. It stays
      // a direct require by default (lifecycle.js is an append-free composition
      // root), but a direct-only binding made the JOIN untestable — a test can
      // pin what the helper decides and what the writer does with a commit, and
      // still not see whether the two are connected. Bypassing the call site
      // passed the entire suite until this seam existed.
      const writeControlPlaneLanding =
        deps.ensureControlPlaneLandingRecord || importedEnsureControlPlaneLandingRecord;
      const landing = writeControlPlaneLanding(ticketId, board, ref.row, controlPlaneOptions, controlPlaneFulfillment);
      assertControlPlaneLandingIntegrity(ticketId, landing);
      cleanupTicketWorktree(ticketId, ref.row, options);
    }
  }

  function finishTicket(ticketId, options) {
    if (!ticketId) {
      fail("finish-ticket requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const prDisagreement = commandPrDisagreement(ticketId, requestedPrRefs(options.pr), board.pr_index?.[ticketId]);
    if (prDisagreement) fail(prDisagreement);
    const refs = resolveLifecyclePrRefs(ticketId, ref.row, board, options);
    preflightDecisionPacket(ticketId, ref.row, options);

    if (ref.row.Status === STATUS.DOING) {
      // Keep the doing -> review -> done lifecycle under markDone's single
      // governed transaction. In particular, a closeout preflight refusal
      // must not leave changed refs or an intermediate review transition.
      assertTicketFence(ticketId);
      return markDone(ticketId, {
        ...options,
        closeoutFromDoing: true,
        closeoutPrRefs: refs,
      });
    }
    if (ref.row.Status === STATUS.REVIEW) {
      // COORD-855: pass changed refs into markDone so its full preflight sees
      // the prospective board while the only persisted write is part of the
      // same journaled transaction as landing evidence and review -> done.
      assertTicketFence(ticketId);
      return markDone(ticketId, {
        ...options,
        closeoutPrRefs: refs,
      });
    }
    if (ref.row.Status === STATUS.DONE) {
      // Replaying the same verified refs lets markDone's stable transaction
      // key return the prior result without duplicating closeout evidence.
      assertTicketFence(ticketId);
      return markDone(ticketId, { ...options, closeoutPrRefs: refs });
    }
    fail(`Ticket ${ticketId} must be doing or review; current status is "${ref.row.Status}".`);
  }

  return {
    finalizeTicket,
    finishTicket,
    landTicket,
    prepareDoneCloseout,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
    // COORD-869: no verb reaches the preflight with a Repo-X ref (see closeout.test.js).
    __testing: { runCloseoutPreflight },
  };
};

module.exports.__testing = { assertIncomingTipsMeasured, resolveRecordedPrContainment, findUnreviewedLocalBaseCommits, assertLocalBaseContainedInPr, samePrRefs, resolveControlPlaneCommitOptions, resolveControlPlaneIntegrationCommit, readGovernedCommitHead, classifyPrRef };
