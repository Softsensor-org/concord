"use strict";

// COORD-706 round 1 review, finding 2 — recovering a governed workspace merge
// that a previous attempt already performed.
//
// THE CASE THIS EXISTS FOR. A closeout merges the ticket branch in-process,
// records the merge as an external side effect, and then fails downstream. The
// merge is IRREVERSIBLE — the governed rollback restores files, not history —
// so on retry `mergeWorkspaceTicketBranches` correctly finds nothing to merge
// and returns an empty list. Without this reader the retry has no commit to
// hand the landing-record writer and the record regresses to
// local_only/no_resolvable_commit_sha: the exact defect this ticket exists to
// remove, reappearing on the second attempt.
//
// The journal is the right source. recordGovernanceExternalSideEffect attaches
// the merge receipt to the mutation record even when that mutation FAILS, and
// coord/.runtime/governance-events.ndjson is force-tracked in git while the
// rest of that directory is ignored. The board cannot be the source: it is
// precisely what the rollback discarded.
//
// Read-only and best-effort: a closeout must never be refused because history
// could not be re-read. A missing or unreadable journal yields null and the
// caller records what it can observe instead.

const fs = require("fs");
const path = require("path");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const { state } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const { gitTry } = require("./git-ops.js");

const MERGE_EFFECT_TYPE = "control_plane_workspace_merge";

function journalPath(options = {}) {
  return options.journalPath || state.GOVERNANCE_EVENT_LOG_PATH;
}

function sameRepositoryRoot(recordedRoot, currentRoot) {
  if (!recordedRoot || !currentRoot) return false;
  try {
    return fs.realpathSync(path.resolve(recordedRoot)) === fs.realpathSync(path.resolve(currentRoot));
  } catch {
    return false;
  }
}

// Newest LAST-merge first. Both dimensions matter: the most recent event, and
// within it the last merge that event performed. The final merge is the one
// that put the integration branch where it now stands.
function findRecordedWorkspaceMerge(ticketId, options = {}) {
  if (!ticketId) return null;
  let text;
  try {
    text = fs.readFileSync(journalPath(options), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue; // a torn tail belongs to the journal repair path, not this one
    }
    const effects = event?.details?.external_side_effects;
    if (!Array.isArray(effects)) continue;
    // COORD-706 round 2, finding 1: iterate the effects in REVERSE too. One
    // transaction can merge several ticket branches, and every merge lands in
    // the SAME event's external_side_effects array in merge order — so a
    // forward scan returns the FIRST merge while the fresh path takes the LAST
    // (lifecycle-repox-closeout.js: merged[merged.length - 1]). Reversing the
    // outer line loop alone made the two paths disagree exactly when a retry
    // mattered most: the run that merged more than one branch.
    for (let j = effects.length - 1; j >= 0; j -= 1) {
      const effect = effects[j];
      if (
        effect &&
        effect.type === MERGE_EFFECT_TYPE &&
        effect.ticket === ticketId &&
        effect.merge_commit_sha
      ) {
        // A journal can be copied or shared between clones. A merge receipt is
        // useful only in the repository where its commit object was created;
        // otherwise it can name a plausible SHA that is absent here and mask
        // the exact integration HEAD that should be verified on retry.
        if (!sameRepositoryRoot(effect.repo_root, options.repoRoot)) continue;
        const commit = gitTry(options.repoRoot, ["cat-file", "-e", `${effect.merge_commit_sha}^{commit}`]);
        if (commit.status !== 0) continue;
        return {
          mergeCommitSha: effect.merge_commit_sha,
          branch: effect.branch || null,
          baseBranch: effect.base_branch || null,
          recordedAt: effect.recorded_at || event.ts || null,
          recovered: true,
        };
      }
    }
  }
  return null;
}

module.exports = { MERGE_EFFECT_TYPE, findRecordedWorkspaceMerge, sameRepositoryRoot };
