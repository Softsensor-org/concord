"use strict";

// COORD-292: the sync / provenance-baseline service, extracted from lifecycle.js
// (lifecycle decomposition epic COORD-291..297, slice #1 — the first behavior-
// preserving extraction after the COORD-291 boundary contract). ONE cohesive
// boundary: the scoped canonical-delta sync and the post-mutation provenance-
// baseline advance that every TERMINAL lifecycle verb (finalize/land/mark-done/
// finish) runs after its governed mutation has flipped the board row to its final
// `done` state on disk.
//
// CRITICAL INVARIANTS — preserved, NOT reimplemented:
//   - COORD-275 (scoped baseline advance): `lifecycleSyncScopePaths` derives the
//     EXACT coord-relative derived-path set this terminal sync is authorized to
//     rewrite (the canonical synced-artifact list PLUS the board json), and
//     `advanceProvenanceBaselineAfterLifecycle` constrains the baseline advance to
//     that set. A concurrent out-of-band edit to any OTHER coordination-state path
//     landing in the advance window is PRESERVED as detectable drift rather than
//     silently re-baselined as clean. The actual scope-checked advance lives in
//     journal.js (`advanceGovernanceProvenanceBaseline`) and is INJECTED here — it
//     is not duplicated.
//   - COORD-246 (no spurious post-finalize drift): the mutation's own post-journal
//     artifact writes (plan record / rendered / QUESTIONS / board json) ARE
//     absorbed into the baseline so the next governed mutation's fail-closed seal
//     does not mistake this mutation's own output for an out-of-band edit.
//   - COORD-196 (atomic terminal row commit): terminal callers set
//     `includeBoardJson:true` so the board-row transition lands atomically with the
//     derived-artifact sync commit.
//   - ENT-001 (opt-in push-on-finalize): push is OPT-IN (flag/env), never default,
//     and pushes only when the sync actually committed.
//
// Everything external is INJECTED via the createSyncProvenance factory (NO
// `require()` of governance internals here):
//   - sync/board helpers : runBoardSync, canonicalSyncablePaths, computeSyncDelta,
//     isInsideGitWorkTree, relativeCoordPath
//   - provenance seam     : advanceGovernanceProvenanceBaseline (the COORD-275
//     scope-checked journal baseline advance — injected, not reimplemented)
//   - git helper          : gitTry
//   - GovernanceError thrower `fail`
//   - value constants (by reference) : COORD_DIR, DEFAULT_PATHS
// `path` is a node builtin required directly by the module.
//
// lifecycle.js wires this factory (deferred `(...a)=>fn(...a)` wrappers for the
// function deps, by-reference for the value constants) and re-destructures the
// eight returned functions back into its scope so the `commands` dispatch table,
// the `__testing` facade, and `cli.js` (autoSyncAfterLifecycle / runSyncCommand)
// all resolve exactly as before the move.

module.exports = function createSyncProvenance(deps = {}) {
  const path = require("path");
  const treeMutationSafety = require("./tree-mutation-safety.js");
  const {
    // sync / board helpers
    runBoardSync,
    canonicalSyncablePaths,
    computeSyncDelta,
    isInsideGitWorkTree,
    relativeCoordPath,
    readBoard,
    getRows,
    isDoingStatus,
    findLockForTicket,
    isStaleTicketLock,
    // provenance seam (COORD-275 scope-checked advance, injected not reimplemented)
    advanceGovernanceProvenanceBaseline,
    // git helper
    gitTry,
    // GovernanceError thrower
    fail,
    // value constants (injected by reference)
    COORD_DIR,
    DEFAULT_PATHS,
  } = deps;

  function assertSyncSafety({ repoRoot, allowedPaths, currentTicketId = null } = {}) {
    return treeMutationSafety.assertNoUnsafeTreeMutation({
      gitTry,
      repoRoot,
      allowedPaths,
      board: typeof readBoard === "function" ? readBoard() : null,
      getRows,
      isDoingStatus,
      findLockForTicket,
      isStaleTicketLock,
      currentTicketId,
      fail,
    });
  }

  // GCV-3 — deterministic regen + scope-limited commit of canonical
  // derived artifacts. Replaces the heavy-handed `git add -A` "board-sync"
  // pattern with a scope-frozen single commit on ONLY the C6-classified
  // canonical tracked-derived paths. First slice: standalone command.
  // Lifecycle-boundary auto-trigger (post-`land`) is the next commit;
  // `gov doctor` invariant tightening is the third. Propagation to
  // acme-ops/coord and acme stays held (downstream-gated per spec).

  // COORD-022: detect whether a directory is inside a git work tree. The
  // canonical multi-repo-workspace shape places coord/ outside any git repo;
  // in that legitimate shape gov sync has no repo to commit into and must skip
  // quietly (clear single-line info) rather than emit a scary failure warning.
  function runSyncCommand(options = {}) {
    // Step 0: the canonical sync surface is git-backed. When the coord root is
    // not inside a git work tree (the off-git multi-repo-workspace shape), there
    // is nothing to commit — skip with a clear single-line info message and a
    // success status instead of regenerating + failing on the git commit.
    if (!isInsideGitWorkTree(COORD_DIR)) {
      const summary = {
        command: "sync",
        repo_root: relativeCoordPath(COORD_DIR),
        skipped: true,
        reason: "coord root is not inside a git work tree",
      };
      if (options.quiet !== true) {
        console.log("[gov sync] coord root is not inside a git work tree; skipping canonical sync (nothing to commit).");
      }
      return summary;
    }

    // Step 1: compute the authorized sync scope and refuse before regenerating
    // derived artifacts if a concurrent live ticket owns this checkout and there
    // is dirty non-derived work outside that scope.
    // Step 2: regenerate the canonical derived artifacts from current state.
    // Step 3: detect which canonical paths (and only those) now differ from
    // git HEAD. The path set is small and explicit — no ambient sweep.
    const repoRoot = COORD_DIR;
    // COORD-196: the standalone `gov sync` surface deliberately EXCLUDES the
    // canonical board json (board/tasks.json) — see canonicalSyncablePaths():
    // on a non-terminal mutation the row is mid-flight (todo/doing/review) and
    // committing it would freeze an in-progress transition. But terminal
    // lifecycle boundaries (finalize/land/mark-done/finish) flip the row to its
    // FINAL `done` state (status + Owner + landing_index) BEFORE this sync runs,
    // so on those boundaries the board json MUST join the same scope-limited sync
    // commit — otherwise the canonical source of truth reads not-done until a
    // manual corrective commit. `includeBoardJson` is the opt-in seam those
    // terminal callers (autoSyncAfterLifecycle) set; standalone `gov sync` never
    // sets it and keeps its frozen surface.
    const paths = canonicalSyncablePaths();
    if (options.includeBoardJson === true) {
      const boardRel = path
        .relative(COORD_DIR, DEFAULT_PATHS.boardPath)
        .split(path.sep)
        .join("/");
      if (!paths.includes(boardRel)) {
        paths.push(boardRel);
      }
    }
    assertSyncSafety({
      repoRoot,
      allowedPaths: paths,
      currentTicketId: options.currentTicketId || null,
    });

    runBoardSync({ ticketScopedValidation: false });

    const delta = computeSyncDelta(repoRoot, paths);
    const quiet = options.quiet === true;
    const emit = (payload) => {
      if (!quiet) console.log(JSON.stringify(payload, null, 2));
    };

    const summary = {
      command: "sync",
      repo_root: relativeCoordPath(repoRoot),
      canonical_paths: paths,
      delta,
      committed: false,
    };

    if (delta.length === 0) {
      summary.note = "No drift on canonical derived paths; nothing to commit.";
      emit(summary);
      return summary;
    }
    if (!options.commit) {
      summary.note =
        "Drift detected on canonical derived paths. Re-run with " +
        '`--commit "<message>"` to create a deterministic single commit ' +
        "limited to these paths.";
      emit(summary);
      return summary;
    }

    // Step 3: scope-limited commit on the delta paths only.
    const message =
      String(options.commit).trim() ||
      "chore(coord): deterministic gov sync of canonical derived artifacts";
    commitCanonicalDelta(repoRoot, message, delta);
    summary.committed = true;
    summary.message = message;
    emit(summary);
    return summary;
  }

  // Stage and commit exactly the given delta paths in repoRoot. The commit
  // is scope-limited via pathspec — even if the index has UNRELATED staged
  // files, they are NOT included in this commit. That closes reviewer
  // finding #2 on PR #4: a `git commit -m <msg>` without pathspec would
  // have included any pre-existing staged files alongside the auto-sync
  // after a lifecycle action, silently breaking the "single commit limited
  // to canonical derived paths" claim.
  function commitCanonicalDelta(repoRoot, message, delta) {
    if (!Array.isArray(delta) || delta.length === 0) {
      fail("commitCanonicalDelta requires a non-empty delta list.");
    }
    const stage = gitTry(repoRoot, ["add", "--", ...delta]);
    if (stage.status !== 0) {
      fail(
        `git add failed in ${repoRoot}: ` +
          String(stage.stderr || "").trim()
      );
    }
    // pathspec on commit is what actually enforces the scope-limit; the
    // pre-emptive `git add` stays as defense-in-depth so new/untracked
    // delta files are explicitly staged first.
    const commit = gitTry(repoRoot, ["commit", "-m", message, "--", ...delta]);
    if (commit.status !== 0) {
      fail(
        `git commit failed in ${repoRoot}: ` +
          String(commit.stderr || "").trim()
      );
    }
  }

  // GCV-3 slice 2 — best-effort auto-trigger at terminal lifecycle
  // boundaries (post-land / finalize / mark-done). A sync failure does NOT
  // unwind the lifecycle action (which may have already merged a PR / closed
  // a ticket / made other irreversible side-effects); we log a clear warning
  // and let `gov doctor` (slice 3) enforce the journal-vs-board invariant.
  // `syncFn` is injectable so unit tests don't have to touch live COORD_DIR.
  function buildAutoSyncMessage(verb, ticketId) {
    const v = String(verb || "").trim() || "lifecycle";
    const t = String(ticketId || "").trim();
    return `chore(coord): sync canonical derived artifacts (post-${v}${t ? ` ${t}` : ""})`;
  }

  // ENT-001: opt-in push of the post-finalize canonical-sync commit so the
  // durable journal/plans/snapshots reach the coord remote without a manual
  // step. This is OPT-IN (flag `--push-after-sync` or env COORD_PUSH_ON_FINALIZE)
  // and NEVER the default. It does a plain (non-force) `git push` of the current
  // branch to its configured upstream; if there is no upstream / no remote it
  // skips with a clear reason rather than failing the lifecycle action (which
  // already succeeded). `pushFn` is injectable for tests.
  function pushOnFinalizeEnabled(options = {}) {
    if (options && options.pushAfterSync === true) return true;
    const env = process.env.COORD_PUSH_ON_FINALIZE;
    return typeof env === "string" && env.trim() !== "" && env.trim() !== "0" && env.trim().toLowerCase() !== "false";
  }

  function pushAfterLifecycleSync({ verb, repoRoot = COORD_DIR, pushFn } = {}) {
    const doPush = typeof pushFn === "function" ? pushFn : (root) => gitTry(root, ["push"]);
    const result = doPush(repoRoot);
    if (result && result.status === 0) {
      return { pushed: true };
    }
    const stderr = String((result && result.stderr) || "").trim();
    // No upstream configured / no remote: opt-in push has nothing to push to.
    if (/no upstream|no configured push destination|does not appear to be a git repository|No such remote/i.test(stderr)) {
      return { pushed: false, reason: "no-upstream-or-remote", detail: stderr };
    }
    console.warn(
      `[gov sync] opt-in post-${verb} push failed: ${stderr || "unknown error"}\n` +
      `The ${verb} action and local sync commit succeeded; the durable journal/` +
      `plans/snapshots are committed locally. Push manually with \`git push\`.`
    );
    return { pushed: false, failed: true, detail: stderr };
  }

  // COORD-246: after a terminal lifecycle verb syncs its post-journal artifacts
  // (plan record / rendered / QUESTIONS), advance the journal's provenance baseline
  // so the next governed mutation's fail-closed entry-check sees the FINAL on-disk
  // state as in-band. Best-effort and never throws out of the auto-sync helper: a
  // baseline-advance failure is itself surfaced by `gov doctor`, and must not undo a
  // lifecycle action that has already completed (and may have merged a PR).
  // COORD-275: the exact coord-relative derived-path set a terminal lifecycle
  // sync is authorized to rewrite. This is the canonical synced-artifact list
  // (`canonicalSyncablePaths`) PLUS the canonical board json, which terminal
  // boundaries commit atomically via `includeBoardJson`. The post-mutation
  // baseline advance is constrained to THIS set, so a concurrent hand-edit to any
  // OTHER coordination-state path (a prompt source file, another ticket's row,
  // etc.) landing in the advance window is preserved as detectable drift rather
  // than silently re-baselined as clean.
  function lifecycleSyncScopePaths() {
    const paths = canonicalSyncablePaths();
    const boardRel = path
      .relative(COORD_DIR, DEFAULT_PATHS.boardPath)
      .split(path.sep)
      .join("/");
    if (!paths.includes(boardRel)) {
      paths.push(boardRel);
    }
    return paths;
  }

  function advanceProvenanceBaselineAfterLifecycle(verb, scopePaths) {
    try {
      advanceGovernanceProvenanceBaseline(
        `post-${String(verb || "lifecycle").trim()}-sync`,
        Array.isArray(scopePaths) ? { scopePaths } : {}
      );
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      console.warn(
        `[gov sync] post-${verb} provenance baseline advance failed: ${reason}\n` +
        `The ${verb} action itself succeeded; run \`gov doctor\` to inspect residual drift.`
      );
    }
  }

  function autoSyncAfterLifecycle({ verb, ticketId, options = {}, syncFn, pushFn } = {}) {
    // COORD-275: scope every post-mutation baseline advance below to exactly the
    // derived paths this terminal lifecycle sync is authorized to rewrite, so a
    // concurrent out-of-band edit landing in the advance window is never absorbed.
    const scopePaths = lifecycleSyncScopePaths();
    if (options && options.noSync === true) {
      // Even when the git-backed sync is skipped, the post-journal artifact writes
      // (plan record / QUESTIONS) are already on disk and must be absorbed into the
      // baseline so the next governed mutation does not trip the fail-closed seal.
      advanceProvenanceBaselineAfterLifecycle(verb, scopePaths);
      return { skipped: true, reason: "--no-sync" };
    }
    const sync = typeof syncFn === "function" ? syncFn : runSyncCommand;
    const message = buildAutoSyncMessage(verb, ticketId);
    try {
      // COORD-196: every caller of this helper is a TERMINAL lifecycle boundary
      // (finalize/land/close/finish/mark-done/finish-ticket) — by the time we run,
      // the board row has already been flipped to its final `done` state on disk.
      // Include the canonical board json (board/tasks.json) in the same
      // scope-limited sync commit so the row transition lands ATOMICALLY with the
      // derived-artifact sync; without this the source of truth reads not-done
      // until a manual corrective commit (observed across the X-lane finalizes).
      const result = sync({ commit: message, quiet: true, includeBoardJson: true, currentTicketId: ticketId || null });
      // ENT-001: opt-in push only when something was actually committed, so a
      // no-op sync doesn't push an unrelated already-tracked tip.
      let push = { pushed: false, reason: "not-requested" };
      if (pushOnFinalizeEnabled(options)) {
        push = result && result.committed
          ? pushAfterLifecycleSync({ verb, pushFn })
          : { pushed: false, reason: "no-commit-to-push" };
      }
      // COORD-246: the sync above regenerated + (possibly) committed the post-journal
      // artifacts; now re-baseline the journal to that final on-disk state so the next
      // governed mutation's fail-closed seal does not mistake this mutation's own
      // output for an out-of-band edit.
      advanceProvenanceBaselineAfterLifecycle(verb, scopePaths);
      return { skipped: false, result, push };
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      // Benign: a coord/ checkout that isn't itself a git worktree can't be
      // synced; that's expected and not a drift signal, so skip quietly. The
      // on-disk post-journal artifacts still exist, so absorb them into the
      // baseline before returning.
      if (/not a git repository|show-toplevel failed|rev-parse --show-toplevel/i.test(reason)) {
        advanceProvenanceBaselineAfterLifecycle(verb, scopePaths);
        return { skipped: true, reason: "coord-root-not-a-git-repo" };
      }
      // Best-effort: never throw out of this helper. The lifecycle action
      // already succeeded by the time we get here.
      console.warn(
        `[gov sync] best-effort post-${verb} sync failed: ${reason}\n` +
        `The ${verb} action itself succeeded; canonical derived artifacts ` +
        `may now lag the journal. Run \`gov sync --commit "<msg>"\` ` +
        `manually, or rely on \`gov doctor\` to surface persistent drift.`
      );
      advanceProvenanceBaselineAfterLifecycle(verb, scopePaths);
      return { skipped: false, failed: true, error: reason };
    }
  }

  return {
    runSyncCommand,
    commitCanonicalDelta,
    buildAutoSyncMessage,
    pushOnFinalizeEnabled,
    pushAfterLifecycleSync,
    lifecycleSyncScopePaths,
    advanceProvenanceBaselineAfterLifecycle,
    autoSyncAfterLifecycle,
  };
};
