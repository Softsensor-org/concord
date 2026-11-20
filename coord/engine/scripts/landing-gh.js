"use strict";

const { spawnSync } = require("child_process");
const { spawnGh } = require("./gh-spawn.js");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const { ROOT_DIR, GovernanceError, defaultFail } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));

// COORD-072: shared GovernanceError thunk (was an inline `function fail`).
const fail = defaultFail;
const evidenceRecord = require("./evidence-record.js");
const { ticketBranchMatches } = require("./control-plane-pr-evidence.js"); // COORD-1013

function toArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function mergedPrAffiliatesWithTicket(ticketId, payload) {
  const normalizedTicketId = String(ticketId || "").trim().toLowerCase();
  if (!normalizedTicketId) {
    return false;
  }
  const branch = String(payload?.headRefName || "").toLowerCase();
  // COORD-1013: a governed agent/ head branch is affiliated only through the id after its handle.
  if (branch.startsWith("agent/")) return ticketBranchMatches(normalizedTicketId, branch);
  return branch.includes(`-${normalizedTicketId}-`) || branch.endsWith(`-${normalizedTicketId}`);
}

function refsContainMergedPrForTicket(ticketId, refs, prView = ghPrView) {
  return toArray(refs).some((ref) => {
    if (!isGitHubPrUrl(ref)) {
      return false;
    }
    const payload = prView(ref);
    const merged = payload.state === "MERGED" && Boolean(payload.mergedAt);
    return merged && mergedPrAffiliatesWithTicket(ticketId, payload);
  });
}

function mergeUniqueRefs(existing, additions) {
  const merged = [];
  for (const ref of [...toArray(existing), ...toArray(additions)]) {
    if (ref && !merged.includes(ref)) {
      merged.push(ref);
    }
  }
  return merged;
}

function verifyPrEvidence(ticketId, refs, options = {}) {
  const requireMerged = Boolean(options.requireMerged);
  const allowNoPr = options.allowNoPr !== false;
  const verified = [];
  for (const ref of refs) {
    if (/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(ref)) {
      const payload = ghPrView(ref);
      const merged = payload.state === "MERGED" && Boolean(payload.mergedAt);
      if (requireMerged) {
        if (!merged) {
          fail(`Ticket ${ticketId} references PR ${ref}, but it is not merged.`);
        }
      } else if (payload.state !== "OPEN" && !merged) {
        fail(`Ticket ${ticketId} references PR ${ref}, but it is neither open nor merged.`);
      }
      verified.push({ ref, payload });
      continue;
    }
    if (!(allowNoPr && /\(no PR\)/.test(ref))) {
      fail(`Ticket ${ticketId} PR evidence "${ref}" must either be a merged GitHub PR URL or include "(no PR)".`);
    }
  }
  return verified;
}

function isGitHubPrUrl(value) {
  return /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(String(value || ""));
}

function ghPrIsMerged(url) {
  const payload = ghPrView(url);
  return payload.state === "MERGED" && Boolean(payload.mergedAt);
}

function isTransientGhError(message) {
  return /HTTP 401|Requires authentication|GraphQL|secondary rate|rate limit|abuse detection|HTTP 4(03|29)|HTTP 5\d\d|timed out|timeout/i.test(String(message || ""));
}

// Test-only seam: when set, sleepSyncMs delegates here instead of spawning a
// real `sleep`, so the ghPrView retry test runs instantly.
let __sleepSyncForTesting = null;

function sleepSyncMs(ms) {
  if (typeof __sleepSyncForTesting === "function") {
    __sleepSyncForTesting(ms);
    return;
  }
  try { spawnSync("sleep", [String(Math.max(0, ms) / 1000)]); } catch (_) {}
}

function setRunGhForTesting(fn) { __runGhForTesting = typeof fn === "function" ? fn : null; }

function resetRunGhForTesting() { __runGhForTesting = null; }

function setSleepSyncForTesting(fn) { __sleepSyncForTesting = typeof fn === "function" ? fn : null; }

function resetSleepSyncForTesting() { __sleepSyncForTesting = null; }

function ghPrView(url) {
  const maxAttempts = 6;
  const request = () => {
    const output = runGh(ROOT_DIR, [
      "pr",
      "view",
      url,
      "--json",
      "number,url,state,mergedAt,title,headRefName,headRefOid,baseRefName,isDraft,author,mergeStateStatus,mergeCommit",
    ], { capture: true });
    return JSON.parse(output);
  };
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    try {
      return request();
    } catch (error) {
      if (!isTransientGhError(error && error.message)) throw error;
      sleepSyncMs(1500 * attempt);
    }
  }
  return request();
}

function ghRepoView(repoRoot = ROOT_DIR) {
  const output = runGh(repoRoot, ["repo", "view", "--json", "nameWithOwner"], { capture: true });
  return JSON.parse(output);
}

function isCheckedOutLocalBranchDeleteFailure(message) {
  const text = String(message || "");
  return /failed to delete local branch/i.test(text) &&
    /cannot delete branch/i.test(text) &&
    /used by worktree/i.test(text);
}

function shouldIgnoreMergeFailureAfterSuccessfulMerge(errorMessage, prPayload, options = {}) {
  return Boolean(options.deleteBranch) &&
    Boolean(prPayload) &&
    prPayload.state === "MERGED" &&
    Boolean(prPayload.mergedAt) &&
    isCheckedOutLocalBranchDeleteFailure(errorMessage);
}

function ghPrListByBranch(repoRoot, branch) {
  const output = runGh(repoRoot, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,url,state,mergedAt,title,headRefName,baseRefName,isDraft",
  ], { capture: true });
  return JSON.parse(output);
}

function ghPrListMergedByBase(repoRoot, base) {
  const output = runGh(repoRoot, [
    "pr", "list", "--base", base, "--state", "merged", "--limit", "1000",
    "--json", "number,url,state,mergedAt,title,body,headRefName,baseRefName,isDraft,mergeCommit",
  ], { capture: true });
  return JSON.parse(output);
}

function mergePrUrl(url, method, options, repoRootOverride) {
  const pr = ghPrView(url);
  // COORD-830 review (third pass), finding 2: merge exactly the reviewed head.
  // A push between this view (or the closeout preflight that qualified the
  // head) and the merge would otherwise land a head nobody measured; GitHub
  // refuses the merge when --match-head-commit no longer names the PR head.
  const viewedHead = String(pr.headRefOid || "").trim().toLowerCase();
  const reviewedHead = String(options.matchHeadCommit || "").trim().toLowerCase() || viewedHead;
  if (pr.state === "MERGED" && pr.mergedAt) {
    // COORD-830 review (fourth pass), finding 1: a PR already merged at a head
    // other than the qualified one landed a commit nobody measured; reporting
    // already_merged would record the measured head as its source.
    if (options.matchHeadCommit && reviewedHead !== viewedHead) {
      // guard:evidence-record
      fail(evidenceRecord.alreadyMergedUnmeasuredHeadMessage(url, viewedHead, reviewedHead));
    }
    const result = {
      pr_url: url,
      status: "already_merged",
      merged_at: pr.mergedAt,
      method,
      delete_branch: Boolean(options.deleteBranch),
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (pr.state !== "OPEN") {
    fail(`PR ${url} is in state ${pr.state}; only OPEN PRs can be merged.`);
  }

  if (pr.mergeStateStatus && pr.mergeStateStatus !== "MERGEABLE" && pr.mergeStateStatus !== "UNKNOWN" && pr.mergeStateStatus !== "CLEAN") {
    const mergeRecoveryHint =
      `git fetch origin ${pr.baseRefName} && git merge origin/${pr.baseRefName} --no-edit (resolve, commit), ` +
      `then a normal git push — no force; land --method squash flattens the merge. ` +
      `(Alternative where force-push is allowed: git rebase origin/${pr.baseRefName} && git push --force-with-lease.)`;
    const recoveryHint = pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY"
      ? mergeRecoveryHint
      : pr.mergeStateStatus === "BLOCKED"
        ? "Resolve failing status checks or required reviews before merging."
        : `Resolve merge conflicts: ${mergeRecoveryHint}`;

    fail(
      `PR ${url} is not mergeable (mergeStateStatus=${pr.mergeStateStatus}). ` +
      `Recovery: ${recoveryHint}`
    );
  }

  if (options.matchHeadCommit && reviewedHead !== viewedHead) {
    // guard:evidence-record
    fail(evidenceRecord.unmeasuredHeadMessage(url, viewedHead, reviewedHead));
  }
  const repoRoot = repoRootOverride || ROOT_DIR;
  const args = ["pr", "merge", url, `--${method}`];
  if (/^[0-9a-f]{40}$/.test(reviewedHead)) {
    args.push("--match-head-commit", reviewedHead);
  }
  if (options.deleteBranch) {
    args.push("--delete-branch");
  }
  if (options.admin) {
    args.push("--admin");
  }

  let mergeError = null;
  try {
    runGh(repoRoot, args, { capture: true });
  } catch (error) {
    if (!(error instanceof GovernanceError)) {
      throw error;
    }
    mergeError = error;
  }
  const merged = ghPrView(url);
  if (mergeError && shouldIgnoreMergeFailureAfterSuccessfulMerge(mergeError.message, merged, options)) {
    const result = {
      pr_url: url,
      status: "merged",
      merged_at: merged.mergedAt,
      method,
      delete_branch: false,
      delete_branch_skipped: true,
      delete_branch_reason: "local branch is still checked out by a governed worktree",
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (mergeError) {
    fail(mergeError.message);
  }
  if (merged.state !== "MERGED" || !merged.mergedAt) {
    fail(`PR ${url} did not reach MERGED state after gh pr merge.`);
  }
  const result = {
    pr_url: url,
    status: "merged",
    merged_at: merged.mergedAt,
    method,
    delete_branch: Boolean(options.deleteBranch),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function buildLandCloseoutAnswer({ ticketId, prUrl, prRefs, method, landing }) {
  const refs = prUrl
    ? [prUrl]
    : toArray(prRefs).filter((entry) => isGitHubPrUrl(entry) || /\(no PR\)/.test(String(entry)));
  const refText = refs.length > 0 ? refs.join(", ") : "no PR evidence recorded";
  const landingText = landing?.evidence?.length
    ? ` Landing evidence: ${landing.evidence.join("; ")}.`
    : "";
  return `Merged and closed via \`coord/scripts/gov land ${ticketId}\` using method \`${method}\`; PR refs: ${refText}.${landingText}`;
}

// Test-only seam: when set, runGh delegates here instead of shelling out to
// `gh`. Lets unit tests exercise the ghPrView retry/backoff logic against a
// stubbed gh without spawning a real process. Never set in production paths.
let __runGhForTesting = null;

function runGh(cwd, args, options = {}) {
  if (typeof __runGhForTesting === "function") {
    return __runGhForTesting(cwd, args, options);
  }
  const result = spawnGh(args, {
    cwd,
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    const stderr = options.capture === false ? "" : (result.stderr || "").trim();
    fail(stderr || `gh ${args.join(" ")} failed in ${cwd}.`);
  }
  return options.capture === false ? "" : (result.stdout || "");
}

module.exports = {
  mergedPrAffiliatesWithTicket,
  refsContainMergedPrForTicket,
  mergeUniqueRefs,
  verifyPrEvidence,
  isGitHubPrUrl,
  ghPrIsMerged,
  isTransientGhError,
  sleepSyncMs,
  setRunGhForTesting,
  resetRunGhForTesting,
  setSleepSyncForTesting,
  resetSleepSyncForTesting,
  ghPrView,
  ghRepoView,
  isCheckedOutLocalBranchDeleteFailure,
  shouldIgnoreMergeFailureAfterSuccessfulMerge,
  ghPrListByBranch,
  ghPrListMergedByBase,
  mergePrUrl,
  buildLandCloseoutAnswer,
  runGh,
};
