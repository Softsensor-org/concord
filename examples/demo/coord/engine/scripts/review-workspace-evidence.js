"use strict";

// COORD-920: the workspace behind a review ticket's PR (worktree, branch, PR head).
//
// move-review releases the ticket lock, so a review ticket carries no lock that says
// where its PR was built. The governed evidence that does say so is:
//   - the journaled pr-create branch push (git_branch_push: branch, pushed head and the
//     worktree that pushed it),
//   - the immutable review_submission in the plan record (the reviewed head), and
//   - the journaled claim-ticket transfer, which names the owner whose namespace holds
//     the worktree (details.previous_owner).
// COORD-979: a hand-opened PR (gh pr create, then move-review or submit --pr) has no pr-create
// push. Then the move-review event's details.workspace_evidence (the released lock's branch,
// worktree and reviewed head) is the evidence; its pr_head_ref, when the submit path verified
// it, must equal the journaled branch.
// This module reads that evidence and checks the workspace against it. It writes nothing;
// the verbs that consume it decide what to refuse.

const fs = require("node:fs");
const path = require("node:path");
const { gitOrNull } = require("./git-ops.js");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
const { state } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));

const REVIEW_STATUS = require("./governance-constants.js").STATUS.REVIEW;
const { readNdjsonRecords } = require("./ndjson-records.js");
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

function readJournalEvents(journalPath) {
  let entries;
  try {
    entries = readNdjsonRecords(journalPath);
  } catch {
    return [];
  }
  // A torn line is the journal verifier's concern, not provenance.
  return entries.filter((entry) => !entry.error).map((entry) => entry.record);
}

// The newest delivered branch push for the ticket, with the index of its event.
function latestPushEvidence(events, ticketId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const effects = events[i]?.details?.external_side_effects;
    if (!Array.isArray(effects)) continue;
    for (let j = effects.length - 1; j >= 0; j -= 1) {
      const effect = effects[j];
      if (
        effect &&
        effect.type === "git_branch_push" &&
        effect.ticket === ticketId &&
        effect.delivered === true &&
        typeof effect.branch === "string" &&
        effect.branch
      ) {
        return {
          index: i,
          branch: effect.branch,
          commit_sha: typeof effect.commit_sha === "string" ? effect.commit_sha : null,
          worktree: typeof effect.worktree === "string" && effect.worktree ? effect.worktree : null,
        };
      }
    }
  }
  return null;
}

// COORD-979: the newest move-review that journaled workspace evidence for the ticket. The same
// shape as latestPushEvidence, so the reader treats both kinds of evidence alike.
function latestWorkspaceEvidence(events, ticketId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.command !== "move-review" || event.ticket !== ticketId || event.result !== "succeeded") continue;
    const evidence = event.details?.workspace_evidence;
    if (!evidence || typeof evidence.branch !== "string" || !evidence.branch) continue;
    return {
      index: i,
      branch: evidence.branch,
      commit_sha: typeof evidence.head === "string" && evidence.head ? evidence.head : null,
      worktree: typeof evidence.worktree === "string" && evidence.worktree ? evidence.worktree : null,
      pr_url: typeof evidence.pr_url === "string" && evidence.pr_url ? evidence.pr_url : null,
      pr_head_ref: typeof evidence.pr_head_ref === "string" && evidence.pr_head_ref ? evidence.pr_head_ref : null,
    };
  }
  return null;
}

// The owner whose namespace holds the PR worktree: the previous owner of the first
// transfer made after the push, or the current owner when the ticket was never transferred
// since the push.
function namespaceOwnerSincePush(events, ticketId, pushIndex, currentOwner) {
  for (let i = pushIndex + 1; i < events.length; i += 1) {
    const event = events[i];
    if (
      event?.command === "claim-ticket" &&
      event.ticket === ticketId &&
      event.result === "succeeded" &&
      typeof event.details?.previous_owner === "string" &&
      event.details.previous_owner
    ) {
      return event.details.previous_owner;
    }
  }
  return currentOwner;
}

function reviewedHead(ticketId, recordsDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(recordsDir, `${ticketId}.json`), "utf8"));
    const commit = record?.review_submission?.commit;
    return typeof commit === "string" && commit ? commit : null;
  } catch {
    return null;
  }
}

function sameDirectory(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// Returns null when the journal holds no PR branch push for the ticket (nothing to preserve).
// Otherwise returns the preserved workspace with `problems` naming every way the live
// workspace differs from the evidence. An empty `problems` list means it is intact.
function resolvePreservedReviewWorkspace({
  ticketId,
  row,
  currentOwner,
  prRefs = [],
  journalPath = state.GOVERNANCE_EVENT_LOG_PATH,
  recordsDir = state.PLAN_RECORDS_DIR,
  defaultWorktreePath = null,
}) {
  const events = readJournalEvents(journalPath);
  // COORD-979: the newest evidence wins, whether it is a pr-create push or a move-review record.
  const push = [latestPushEvidence(events, ticketId), latestWorkspaceEvidence(events, ticketId)]
    .filter(Boolean)
    .sort((a, b) => b.index - a.index)[0] || null;
  if (!push) return null;

  const workspaceOwner = namespaceOwnerSincePush(events, ticketId, push.index, currentOwner);
  const worktree =
    push.worktree ||
    (typeof defaultWorktreePath === "function" && row?.Repo ? defaultWorktreePath(row.Repo, workspaceOwner, ticketId) : null);
  const prHead = reviewedHead(ticketId, recordsDir) || push.commit_sha;
  const prUrl = (Array.isArray(prRefs) ? prRefs : []).find((ref) => PR_URL.test(String(ref || "").trim())) || null;
  const problems = [];
  // COORD-979 cross-check: the PR head ref the submit path verified must be the journaled branch,
  // and the PR the workspace was recorded for must still be the PR pr_index records.
  if (push.pr_head_ref && push.pr_head_ref !== push.branch) {
    problems.push(`the PR head ref ${push.pr_head_ref} differs from the journaled branch ${push.branch}`);
  }
  if (push.pr_url && prUrl && push.pr_url !== prUrl) {
    problems.push(`pr_index records ${prUrl}, not the PR ${push.pr_url} the workspace was recorded for`);
  }
  if (worktree) {
    if (!fs.existsSync(worktree)) {
      problems.push(`the original worktree ${worktree} is missing`);
    } else {
      const listing = (gitOrNull(worktree, ["worktree", "list", "--porcelain"]) || "").trim();
      const registered = listing.split("\n").some((line) => line.startsWith("worktree ") && sameDirectory(line.slice("worktree ".length), worktree));
      if (!registered) {
        problems.push(`${worktree} is not a registered worktree of this repository`);
      } else {
        const checkedOut = gitOrNull(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null;
        if (checkedOut !== push.branch) {
          problems.push(`${worktree} has ${checkedOut || "no branch"} checked out, not the PR branch ${push.branch}`);
        }
        const head = gitOrNull(worktree, ["rev-parse", "HEAD"])?.trim() ?? null;
        if (prHead && head !== prHead) {
          problems.push(`the head of ${worktree} is ${head || "unknown"}, not the PR head ${prHead}`);
        }
      }
    }
  } else {
    problems.push("the journal does not record the PR worktree and no default location resolves it");
  }
  return {
    ticket: ticketId,
    branch: push.branch,
    worktree,
    workspace_owner: workspaceOwner,
    pr_head: prHead,
    pr_url: prUrl,
    problems,
    repair:
      `Repair: restore the PR workspace${worktree ? ` at ${worktree}` : ""} on branch ${push.branch}` +
      `${prHead ? ` at PR head ${prHead}` : ""} (recreate it from the pushed branch, or move the worktree back), then retry.`,
  };
}

// claim --transfer-to of a review ticket: refuse (through `fail`, before any write) when the
// PR workspace is missing or diverged; otherwise return what the transfer must record.
// guard:workspace-recovery-safety
function assertReviewWorkspaceTransferable({ isOwnerTransfer, ticketId, row, currentOwner, prRefs = [], fail }) {
  if (!isOwnerTransfer || row?.Status !== REVIEW_STATUS) return null;
  const preserved = resolvePreservedReviewWorkspace({ ticketId, row, currentOwner, prRefs });
  if (preserved && preserved.problems.length > 0) {
    // guard:workspace-recovery-safety
    fail(`claim --transfer-to ${ticketId} refused: ${preserved.problems.join("; ")}. ${preserved.repair}`);
  }
  return preserved;
}

// The journal details a transfer of a review ticket records about its PR workspace.
function transferDetailsForPreservedWorkspace(preserved, { from, to, reason, previousSessionId }) {
  return {
    preserved_workspace: {
      worktree: preserved.worktree,
      branch: preserved.branch,
      pr_head: preserved.pr_head,
      pr_url: preserved.pr_url,
      workspace_owner: preserved.workspace_owner,
    },
    transfer_provenance: [{
      from,
      to,
      at: new Date().toISOString(),
      workspace_owner: preserved.workspace_owner,
      reason,
      previous_session_id: previousSessionId,
    }],
  };
}

module.exports = {
  resolvePreservedReviewWorkspace,
  assertReviewWorkspaceTransferable,
  transferDetailsForPreservedWorkspace,
  readJournalEvents,
  latestPushEvidence,
  namespaceOwnerSincePush,
};
