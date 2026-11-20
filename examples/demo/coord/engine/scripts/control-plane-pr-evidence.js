"use strict";

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const { gitTry } = require(resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/git-ops.js"));
const { slugify } = require(resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/lifecycle-utils.js"));
// COORD-1019: reuse the governance regex escaper rather than a second copy.
const { escapeRegExp } = require("./governance-constants.js");

// Proof objects are created only after all GH identity and source-lineage
// checks below pass. The landing writer accepts this in-process capability,
// never a caller-shaped JSON object that merely has similar fields.
const verifiedProofs = new WeakSet();
const verifiedProofSets = new WeakSet();

function fail(message) {
  throw new Error(message);
}

function canonicalRepository(value) {
  const name = String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const match = /^([^/]+)\/([^/]+)$/.exec(name);
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : null;
}

function parsePullRequestUrl(value, label) {
  const raw = String(value || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${label} is not a valid GitHub pull-request URL.`);
  }
  if (!/^https:\/\/github\.com\//i.test(raw) || url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port || url.search || url.hash) {
    return fail(`${label} must be a canonical https://github.com pull-request URL.`);
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match) return fail(`${label} must identify one GitHub pull request.`);
  const repository = canonicalRepository(`${match[1]}/${match[2]}`);
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return fail(`${label} has an invalid pull-request number.`);
  return {
    repository,
    number,
    canonicalUrl: `https://github.com/${repository}/pull/${number}`,
  };
}

function normalizeBranch(value) {
  return String(value || "").trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function resolveCommit(repoRoot, value, label) {
  const raw = String(value || "").trim();
  if (!/^[a-f0-9]{40}$/i.test(raw)) return fail(`${label} must be a full 40-character commit OID.`);
  const result = gitTry(repoRoot, ["rev-parse", "--verify", `${raw}^{commit}`]);
  if (result.status !== 0) return fail(`${label} ${raw} does not resolve in the control-plane repository.`);
  const resolved = String(result.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(resolved)) return fail(`${label} did not resolve to a full commit OID.`);
  return resolved;
}

// COORD-1019: the governed workspace branch format is defined once, here. Builders
// (ticket-transitions.js) and the matcher below both read these constants.
const GOVERNED_BRANCH_PREFIX = "agent/";
const GOVERNED_BRANCH_SLUG_MAX = 40;
const TICKET_ID_SHAPE = /^[a-z][a-z0-9]*-\d+$/;

// COORD-1013: governed workspace branches are agent/<handle>-<ticket-id>-<slug>
// (buildTicketBranchName below builds them). The ticket id is the first <prefix>-<digits>
// token after the handle, so a ticket id that only appears inside another ticket's
// slug does not affiliate the branch. Handles may contain hyphens (independent-reviews
// HANDLE_PATTERN), which the lazy handle match tolerates. Non-governed branches keep
// the bounded-token match.
function ticketBranchMatches(ticketId, branch) {
  const normalized = String(ticketId || "").trim().toLowerCase();
  if (!TICKET_ID_SHAPE.test(normalized)) return false;
  const normalizedBranch = String(branch || "").trim().toLowerCase();
  if (normalizedBranch.startsWith(GOVERNED_BRANCH_PREFIX)) {
    const prefix = normalized.replace(/-\d+$/, "");
    const governed = new RegExp(`^${escapeRegExp(GOVERNED_BRANCH_PREFIX)}.+?-(${prefix}-\\d+)(?=-|$)`).exec(normalizedBranch);
    return governed !== null && governed[1] === normalized;
  }
  const escaped = escapeRegExp(normalized);
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(normalizedBranch);
}

// COORD-1019: the one builder for governed workspace branch names. `slug` is the free-text
// title (topic or board description); it is slugified and capped at GOVERNED_BRANCH_SLUG_MAX.
// The result must round-trip through ticketBranchMatches, so a handle that carries its own
// <prefix>-<digits> token (which would make the id ambiguous) is refused instead of minted.
// Ids outside the matcher's shape (e.g. B-772-START) are not refused: the matcher already
// ignores them, so their branch names are unchanged.
function buildTicketBranchName({ owner, ticketId, slug } = {}) {
  if (typeof owner !== "string" || owner === "") {
    // guard:workspace-recovery-safety
    return fail("buildTicketBranchName requires a non-empty owner handle.");
  }
  if (typeof ticketId !== "string" || ticketId === "") {
    // guard:workspace-recovery-safety
    return fail("buildTicketBranchName requires a non-empty ticket id.");
  }
  const name = `${GOVERNED_BRANCH_PREFIX}${owner.toLowerCase()}-${ticketId.toLowerCase()}-${slugify(slug).slice(0, GOVERNED_BRANCH_SLUG_MAX)}`;
  if (TICKET_ID_SHAPE.test(ticketId.toLowerCase()) && !ticketBranchMatches(ticketId, name)) {
    // guard:workspace-recovery-safety
    return fail(`Governed branch ${name} for ${ticketId} would not match back to ${ticketId}; owner handle ${owner} is not usable in a governed branch name.`);
  }
  return name;
}

function ticketIsAffiliated(ticketId, branch) {
  if (!/^[a-z]+-\d+$/.test(String(ticketId || "").trim().toLowerCase())) return false;
  return ticketBranchMatches(ticketId, branch);
}

function verifyControlPlanePrEvidence({
  ticketId,
  refs,
  verifiedPrs,
  expectedRepository,
  selectedBaseRef,
  sourceCommitSha,
  repoRoot,
}) {
  if (!repoRoot) return fail(`Ticket ${ticketId} has no control-plane repository for PR provenance verification.`);
  if (!Array.isArray(verifiedPrs) || verifiedPrs.length !== 1) {
    return fail(`Ticket ${ticketId} PR-backed control-plane closeout requires exactly one verified PR; multi-PR source attribution is ambiguous.`);
  }
  const refList = Array.isArray(refs) ? refs : [];
  if (refList.some((ref) => /\(no PR\)/i.test(String(ref)))) {
    return fail(`Ticket ${ticketId} cannot mix a PR with a no-PR landing marker.`);
  }
  const { ref, payload } = verifiedPrs[0] || {};
  const requestRefs = refList.filter((value) => /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(value || "")));
  if (requestRefs.length !== 1 || requestRefs[0] !== ref) {
    return fail(`Ticket ${ticketId} verified PR response does not match its single registered PR request.`);
  }
  const requested = parsePullRequestUrl(ref, "Requested PR URL");
  const returned = parsePullRequestUrl(payload && payload.url, "GitHub PR URL");
  const repository = canonicalRepository(expectedRepository);
  if (!repository) return fail("GitHub did not return a valid configured control-plane repository identity.");
  if (requested.repository !== repository || returned.repository !== repository ||
      requested.number !== returned.number || requested.number !== payload.number ||
      requested.canonicalUrl !== returned.canonicalUrl) {
    return fail(`Ticket ${ticketId} PR identity does not match the configured control-plane repository and requested PR.`);
  }

  const baseRef = normalizeBranch(selectedBaseRef);
  if (!baseRef || normalizeBranch(payload.baseRefName) !== baseRef) {
    return fail(`Ticket ${ticketId} PR base ${String(payload.baseRefName || "(missing)")} does not match selected control-plane base ${baseRef || "(missing)"}.`);
  }
  if (payload.state !== "MERGED" || typeof payload.mergedAt !== "string" || !Number.isFinite(Date.parse(payload.mergedAt))) {
    return fail(`Ticket ${ticketId} PR ${requested.canonicalUrl} is not verifiably merged.`);
  }
  const headRef = String(payload.headRefName || "").trim();
  if (!ticketIsAffiliated(ticketId, headRef)) {
    return fail(`Ticket ${ticketId} PR head branch "${headRef || "(missing)"}" is not affiliated with the ticket.`);
  }
  const headSha = resolveCommit(repoRoot, payload.headRefOid, "PR head OID");
  const sourceSha = resolveCommit(repoRoot, sourceCommitSha, "Reviewed source commit");
  const mergeValue = payload.mergeCommit && typeof payload.mergeCommit === "object"
    ? payload.mergeCommit.oid
    : payload.mergeCommit;
  const mergeSha = resolveCommit(repoRoot, mergeValue, "GitHub PR merge OID");
  const ancestry = gitTry(repoRoot, ["merge-base", "--is-ancestor", sourceSha, headSha]);
  if (ancestry.status === 1) {
    return fail(`Ticket ${ticketId} reviewed source ${sourceSha} is not an ancestor of PR head ${headSha}.`);
  }
  if (ancestry.status !== 0) {
    return fail(`Ticket ${ticketId} could not verify reviewed-source ancestry to PR head: ${String(ancestry.stderr || "").trim() || `git merge-base exited ${ancestry.status}`}.`);
  }

  const proof = Object.freeze({
    requested_url: String(ref),
    url: requested.canonicalUrl,
    repository,
    number: requested.number,
    base_ref: baseRef,
    state: "MERGED",
    merged_at: payload.mergedAt,
    head_ref: headRef,
    head_sha: headSha,
    merge_sha: mergeSha,
    ticket_id: String(ticketId),
    source_commit_sha: sourceSha,
  });
  verifiedProofs.add(proof);
  return proof;
}

// COORD-943: a ticket may be represented by a primary PR plus explicitly
// attributed supplemental PRs. Verify each recorded ref independently; do not
// collapse the set to whichever PR happens to be listed first.
function verifyControlPlanePrEvidenceSet(args) {
  const refs = Array.isArray(args.refs) ? args.refs : [];
  const verified = Array.isArray(args.verifiedPrs) ? args.verifiedPrs : [];
  if (refs.length === 0 || refs.some((ref) => /\(no PR\)/i.test(String(ref)))) {
    return fail(`Ticket ${args.ticketId} multi-PR closeout requires one or more PR refs and cannot mix a no-PR marker.`);
  }
  const requested = refs.map((ref) => parsePullRequestUrl(ref, "Recorded PR URL"));
  const keys = requested.map((pr) => pr.canonicalUrl.toLowerCase());
  if (new Set(keys).size !== keys.length) return fail(`Ticket ${args.ticketId} records duplicate PR refs; refusing ambiguous multi-PR attribution.`);
  if (verified.length !== refs.length) {
    return fail(`Ticket ${args.ticketId} requires a live verified response for every recorded PR (${refs.length} recorded, ${verified.length} verified).`);
  }
  const proofs = [];
  for (const ref of refs) {
    const parsed = parsePullRequestUrl(ref, "Recorded PR URL");
    const match = verified.filter((entry) => {
      try { return parsePullRequestUrl(entry && entry.ref, "Verified PR URL").canonicalUrl.toLowerCase() === parsed.canonicalUrl.toLowerCase(); }
      catch { return false; }
    });
    if (match.length !== 1) return fail(`Ticket ${args.ticketId} recorded PR ${parsed.canonicalUrl} does not have exactly one matching live verification.`);
    const sourceCommitSha = proofs.length === 0 ? args.sourceCommitSha : proofs[proofs.length - 1].merge_sha;
    proofs.push(verifyControlPlanePrEvidence({ ...args, sourceCommitSha, refs: [ref], verifiedPrs: match }));
  }
  // The first ref is the primary reviewed change. Each later PR must explicitly
  // descend from the already-reviewed chain (head or merge), so a collection of
  // unrelated PRs cannot be presented as one ticket's delivery.
  for (let index = 1; index < proofs.length; index += 1) {
    const prior = proofs[index - 1];
    const current = proofs[index];
    const ancestry = gitTry(args.repoRoot, ["merge-base", "--is-ancestor", prior.merge_sha, current.head_sha]);
    if (ancestry.status === 1) {
      return fail(`Ticket ${args.ticketId} supplemental PR ${current.url} is not based on the preceding verified PR merge ${prior.merge_sha}; its relationship to the ticket source is ambiguous.`);
    }
    if (ancestry.status !== 0) {
      return fail(`Ticket ${args.ticketId} could not verify supplemental PR ancestry for ${current.url}: ${String(ancestry.stderr || "").trim() || `git merge-base exited ${ancestry.status}`}.`);
    }
  }
  const proofSet = Object.freeze(proofs);
  verifiedProofSets.add(proofSet);
  return proofSet;
}

function evidenceList(value) { return Array.isArray(value) ? value : value ? [value] : []; }

function isVerifiedControlPlanePrEvidence(value) {
  return Boolean(value && verifiedProofs.has(value));
}

function isVerifiedControlPlanePrEvidenceSet(value) {
  return Boolean(Array.isArray(value) && verifiedProofSets.has(value) && value.length > 1);
}

// guard:closeout-pr-ancestry
function assertGithubMergeInIntegration({ ticketId, prEvidence, repoRoot, integrationCommitSha }) {
  const proofs = evidenceList(prEvidence);
  if (proofs.length === 0 || proofs.some((proof) => !isVerifiedControlPlanePrEvidence(proof)) ||
      (proofs.length > 1 && !isVerifiedControlPlanePrEvidenceSet(prEvidence))) {
    return fail(`Ticket ${ticketId} PR landing requires verified in-process PR evidence.`);
  }
  const integrationSha = resolveCommit(repoRoot, integrationCommitSha, "Governed integration commit");
  for (const proof of proofs) {
    const ancestry = gitTry(repoRoot, ["merge-base", "--is-ancestor", proof.merge_sha, integrationSha]);
    if (ancestry.status === 1) {
      return fail(`Ticket ${ticketId} GitHub PR merge ${proof.merge_sha} (${proof.url}) is not an ancestor of governed integration ${integrationSha}.`);
    }
    if (ancestry.status !== 0) {
      return fail(`Ticket ${ticketId} could not verify GitHub PR merge ancestry for ${proof.url}: ${String(ancestry.stderr || "").trim() || `git merge-base exited ${ancestry.status}`}.`);
    }
  }
  return integrationSha;
}

// guard:closeout-pr-ancestry
function assertGithubMergeInPlannedIntegration({ ticketId, prEvidence, repoRoot, currentHeadSha, incomingBranchTips = [] }) {
  const proofs = evidenceList(prEvidence);
  if (proofs.length === 0 || proofs.some((proof) => !isVerifiedControlPlanePrEvidence(proof)) ||
      (proofs.length > 1 && !isVerifiedControlPlanePrEvidenceSet(prEvidence))) {
    return fail(`Ticket ${ticketId} PR landing requires verified in-process PR evidence.`);
  }
  const candidates = [currentHeadSha, ...incomingBranchTips.map((entry) => entry && entry.head_sha)];
  if (candidates.some((candidate) => !/^[a-f0-9]{40}$/i.test(String(candidate || "")))) {
    return fail(`Ticket ${ticketId} could not resolve every planned control-plane integration candidate before workspace merge.`);
  }
  const resolvedCandidates = candidates.map((candidate) => resolveCommit(repoRoot, candidate, "Planned governed integration candidate"));
  for (const candidateSha of resolvedCandidates) {
    let includesEveryMerge = true;
    for (const proof of proofs) {
      const ancestry = gitTry(repoRoot, ["merge-base", "--is-ancestor", proof.merge_sha, candidateSha]);
      if (ancestry.status === 1) { includesEveryMerge = false; break; }
      if (ancestry.status !== 0) {
        return fail(`Ticket ${ticketId} could not verify GitHub PR merge ancestry for ${proof.url} against planned integration candidate ${candidateSha}: ${String(ancestry.stderr || "").trim() || `git merge-base exited ${ancestry.status}`}.`);
      }
    }
    if (includesEveryMerge) return candidateSha;
  }
  return fail(`Ticket ${ticketId} verified PR merges are not all ancestors of one current integration HEAD or planned workspace branch tip; refusing before workspace merge.`);
}

module.exports = {
  buildTicketBranchName,
  ticketBranchMatches,
  verifyControlPlanePrEvidence,
  verifyControlPlanePrEvidenceSet,
  assertGithubMergeInIntegration,
  assertGithubMergeInPlannedIntegration,
  isVerifiedControlPlanePrEvidence,
  isVerifiedControlPlanePrEvidenceSet,
};
