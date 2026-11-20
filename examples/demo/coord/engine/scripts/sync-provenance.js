"use strict";

const { nonForcePush } = require("./control-plane-push.js");
const { boardPushRefusalHint, createDefaultGh, isRuleRefusal } = require("./board-push-preflight.js");
const { publishSyncCommitViaPr, prWaitFromSeconds } = require("./board-pr-landing.js");
const integrationAuthority = require("./integration-authority.js");
const { assertFactoryDependencies } = require("./factory-deps.js");
const { assertPromptIndexCommittable } = require("./prompt-index-commit.js");

// COORD-292/668: scoped Git synchronization for governed output. Regeneration
// is a journaled mutation; publication follows that committed provenance.
// Terminal callers include the completed board row and may opt into a non-force
// push. A failed or skipped sync never rebaselines residual drift by path.
//
// lifecycleSyncScopePaths / advanceProvenanceBaselineAfterLifecycle remain
// exported for compatibility with explicit legacy callers; terminal automation
// no longer invokes the latter. New sanctioned writers must journal their own
// output through withGovernanceMutation, including post-finalize plan writes.
// All governance collaborators are injected from lifecycle.js.

module.exports = function createSyncProvenance(deps = {}) {
  const path = require("path");
  const treeMutationSafety = require("./tree-mutation-safety.js");
  const resolvedDeps = integrationAuthority.resolveTicketFenceDependencies(deps, { includeDecision: true });
  assertFactoryDependencies("createSyncProvenance", resolvedDeps, { callable: ["assertTicketFence", "decisionFenceForTicket"], value: [] });
  const {
    // sync / board helpers
    withGovernanceMutation,
    detectGovernanceProvenanceDrift,
    splitGovernanceProvenanceDrift,
    state,
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
    resolveCurrentAgentId,
    // provenance seam (COORD-275 scope-checked advance, injected not reimplemented)
    advanceGovernanceProvenanceBaseline,
    // git helper
    gitTry,
    withActiveCommandFence = integrationAuthority.withActiveCommandFence,
    assertTicketFence,
    decisionFenceForTicket,
    // GovernanceError thrower
    fail,
    // value constants (injected by reference)
    COORD_DIR,
    DEFAULT_PATHS,
  } = resolvedDeps;

  // guard:sync-unapproved-drift
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
      resolveCurrentAgentId,
      fail,
    });
  }

  // COORD-928 option A (human-admin 2026-11-13): an UNTRACKED file under the ADR 0020
  // authored classes (coord/prompts/, coord/docs/decisions/) is published with the board
  // when the journal accounts for it: it is in the current snapshot and is not drift.
  // COORD-1007: a TRACKED file modified in place (" M" / "M " porcelain, e.g. register-prompt
  // --body-file over a committed stub) is accounted the same way. Drift is the set of paths
  // whose digest differs from the latest journal snapshot, so "not drift" means its bytes
  // equal the journaled snapshot; an out-of-band edit is drift and stays refused.
  // Anything else stays unaccounted and refuses. Returns coord-relative paths.
  const AUTHORED_CLASS_PREFIXES = ["prompts/", "docs/decisions/"];
  function journalAccountedAuthoredPaths(repoRoot, provenance) {
    const status = gitTry(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
    if (!status || status.status !== 0) {
      fail(`git status failed in ${repoRoot}: ${String((status && status.stderr) || "").trim()}`);
    }
    const coordName = path.basename(COORD_DIR);
    const snapshot = new Set(((provenance && provenance.currentSnapshot && provenance.currentSnapshot.files) || [])
      .filter((entry) => entry && entry.exists)
      .map((entry) => entry.path));
    const drifted = new Set((provenance && provenance.drift) || []);
    return String(status.stdout || "").split("\n")
      .filter((line) => line.startsWith("?? ") || line[0] === "M" || line[1] === "M")
      .map((line) => line.slice(3).trim())
      .map((entry) => (entry.startsWith(`${coordName}/`) ? entry.slice(coordName.length + 1) : entry))
      .filter((rel) => AUTHORED_CLASS_PREFIXES.some((prefix) => rel.startsWith(prefix))
        && snapshot.has(rel) && !drifted.has(rel));
  }

  // The publication delta: sync-scoped canonical paths plus journal-accounted authored files.
  function publicationDelta(repoRoot, paths, provenance) {
    const accounted = journalAccountedAuthoredPaths(repoRoot, provenance);
    return { delta: [...new Set([...computeSyncDelta(repoRoot, paths), ...accounted])], accounted: new Set(accounted) };
  }

  // COORD-928: every board publication refuses a prompt_index entry whose prompt file
  // is not in the commit being published. `stagedPaths` is the sync delta.
  // guard:publish-board-refusal
  function assertPromptIndexPublishable(stagedPaths) {
    const board = typeof readBoard === "function" ? readBoard() : null;
    assertPromptIndexCommittable({
      coordDir: COORD_DIR,
      promptIndex: board && board.prompt_index,
      stagedPaths,
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
    // COORD-533: every sync includes the authoritative board with its views.
    // Publishing a todo/doing/review row preserves its actual status; omitting
    // it publishes an orphaned view. COORD-196's terminal includeBoardJson seam
    // remains compatible for injected/older scope providers, with deduplication.
    const paths = [...canonicalSyncablePaths()];
    const questionRel = path.relative(COORD_DIR, state.QUESTIONS_PATH).split(path.sep).join("/");
    if (!paths.includes(questionRel)) paths.push(questionRel);
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

    // Check provenance under the same lock as regeneration. A manual edit to
    // a derived file must not be erased and then mistaken for sanctioned output.
    withGovernanceMutation({ command: "sync", ticket: options.currentTicketId || null }, () => {
      const provenance = detectGovernanceProvenanceDrift();
      const { blocking } = splitGovernanceProvenanceDrift(provenance.drift || []);
      const recovered = state.activeGovernanceMutationContext?.metadata?.details?.derived_sync_recovery;
      const recoveredPaths = new Set((recovered || []).map((e) => e.path));
      const current = new Map((provenance.currentSnapshot?.files || []).map((e) => [e.path, e.digest]));
      if (blocking.some((p) => !recoveredPaths.has(p)) ||
          (recovered || []).some((e) => current.get(e.path) !== e.after_digest)) {
        fail(`Refusing sync over unapproved governance drift: ${blocking.join(", ")}. Inspect with gov doctor; approved recovery requires gov reconcile --human-admin-override.`);
      }
      // COORD-978: one ticket's lock-head mismatch is a scoped warning here, not a board-wide refusal.
      runBoardSync({ ticketScopedValidation: false, lockHeadMismatchPolicy: "scoped-warning" });
    });

    const { delta } = publicationDelta(repoRoot, paths, detectGovernanceProvenanceDrift());
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

    // Step 3: scope-limited commit of source, views and evidence delta paths.
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
    assertPromptIndexPublishable(delta);
    withActiveCommandFence("sync", () => {
      const stage = gitTry(repoRoot, ["add", "--", ...delta]);
      if (stage.status !== 0) {
        fail(
          `git add failed in ${repoRoot}: ` +
            String(stage.stderr || "").trim()
        );
      }
      // pathspec on commit is what actually enforces the scope-limit; the
      // pre-emptive `git add` stays as defense-in-depth so new/untracked
      // delta files are explicitly staged first. The active authority fence
      // remains locked across both Git commands, so a handoff cannot slip
      // between the check and the commit.
      const commit = gitTry(repoRoot, ["commit", "-m", message, "--", ...delta]);
      if (commit.status !== 0) {
        fail(
          `git commit failed in ${repoRoot}: ` +
            String(commit.stderr || "").trim()
        );
      }
    });
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

  // COORD-894: boardLanding "pr" publishes the sync commit through a
  // governance-only PR instead of a direct push. Resumable: a re-run reuses the
  // open PR, and an already-published HEAD is a no-op. A failed result always
  // carries `detail` (publishSyncCommitViaPr).
  // guard:publish-board-refusal
  function assertPublicationTicketFences(ticketId, ticketFence, ticketFences) {
    if (ticketId) assertTicketFence(ticketId, ticketFence);
    for (const [ticket, fence] of Object.entries(ticketFences || {})) assertTicketFence(ticket, fence);
  }

  function pushSyncCommitViaPr({ verb, repoRoot, ticketId, ticketFence, ticketFences, pr = {} }) {
    const gh = pr.gh || createDefaultGh();
    const result = publishSyncCommitViaPr({
      repoRoot, ticketId,
      gh: (args, options) => args[0] === "pr" && (args[1] === "create" || args[1] === "merge")
        ? withActiveCommandFence(verb || "sync", () => {
          assertPublicationTicketFences(ticketId, ticketFence, ticketFences);
          return gh(args, options);
        })
        : gh(args, options),
      gitFn: (root, args) => args[0] === "push"
        ? withActiveCommandFence(verb || "sync", () => {
          assertPublicationTicketFences(ticketId, ticketFence, ticketFences);
          return gitTry(root, args);
        })
        : gitTry(root, args),
      sleep: pr.sleep,
      wait: pr.wait || prWaitFromSeconds(DEFAULT_PATHS && DEFAULT_PATHS.boardLandingWaitSeconds),
    });
    if (result.failed) {
      console.warn(
        `[gov sync] boardLanding "pr": the post-${verb} sync commit is not yet on the board branch ` +
        `(PR ${result.pr_url || "not opened"}: ${result.status}, ${result.detail}). ` +
        `The ${verb} action and local sync commit succeeded. Once the PR merges, re-run the governed terminal ` +
        "verb with `--push-after-sync`; the open PR is reused and no second PR is opened (COORD-894)."
      );
    }
    return result;
  }

  function pushAfterLifecycleSync({ verb, repoRoot = COORD_DIR, pushFn, ticketId = null, ticketFences = null, pr = null } = {}) {
    const ticketFence = ticketId ? decisionFenceForTicket(ticketId) : null;
    if (typeof pushFn !== "function" && ((pr && pr.boardLanding) || (DEFAULT_PATHS && DEFAULT_PATHS.boardLanding)) === "pr") {
      return pushSyncCommitViaPr({ verb, repoRoot, ticketId, ticketFence, ticketFences, pr: pr || {} });
    }
    // COORD-691: the push PRIMITIVE is shared with the governed pre-closeout
    // push rather than each end of a landing keeping its own `git push` call.
    //
    // ROUND 1 REVIEW, finding 1: this used to call the primitive with NO
    // refspec — the historical `git push` — which delegates the decision to
    // `remote.<name>.push` / `push.default`. With
    // `remote.origin.push=+refs/heads/main:refs/heads/main` configured, that
    // call force-overwrote a diverged remote and reported success. The
    // dangerous instruction was in configuration, not in the argv, so no
    // argv-level check could have caught it. The remote and refspec are now
    // resolved and named EXPLICITLY, and the primitive refuses an implicit
    // push outright.
    // ROUND 2 REVIEW, finding 1. The round-1 repair named the remote and
    // refspec explicitly — correct — but derived them from the LOCAL branch
    // name and `branch.<b>.remote`, which is not what `git push` did. Two
    // regressions followed, both measured in review:
    //
    //   * with NO upstream, the historical call SKIPPED ("no upstream"); the
    //     repair pushed to origin/<local-branch> instead, creating a remote
    //     branch nobody asked for.
    //   * with `main` tracking `origin/trunk`, it pushed main:main — leaving
    //     trunk untouched, creating origin/main, and reporting success.
    //
    // Both come from assuming the destination ref shares the local branch's
    // name. The upstream is the authority on where this branch pushes, so it is
    // resolved as a unit (`@{upstream}` -> <remote>/<remote-branch>) and the
    // refspec is <local>:<remote-branch>. No upstream is a REFUSAL to guess:
    // the opt-in push has nothing to push to, which is the original behaviour.
    const doPush = typeof pushFn === "function"
      ? pushFn
      : (root) => {
        const branch = String((gitTry(root, ["symbolic-ref", "--short", "HEAD"]).stdout || "")).trim();
        if (!branch) {
          return { status: 1, stdout: "", stderr: "no upstream: HEAD is detached, so there is no branch to push" };
        }
        const upstream = gitTry(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
        const tracked = upstream && upstream.status === 0 ? String(upstream.stdout || "").trim() : "";
        if (!tracked) {
          return {
            status: 1,
            stdout: "",
            stderr: `no upstream configured for ${branch}; refusing to guess a destination`,
          };
        }
        const slash = tracked.indexOf("/");
        const remote = slash > 0 ? tracked.slice(0, slash) : "origin";
        const remoteBranch = slash > 0 ? tracked.slice(slash + 1) : tracked;
        if (!remoteBranch) {
          return { status: 1, stdout: "", stderr: `no upstream branch resolved for ${branch} (tracked "${tracked}")` };
        }
        // <local>:<remote-branch>, NOT <local>:<local> — the two differ
        // whenever a branch tracks an upstream under another name.
        return nonForcePush(root, [remote, `${branch}:${remoteBranch}`], {
          gitFn: (pushRoot, args) => withActiveCommandFence(verb || "sync", () => {
            assertPublicationTicketFences(ticketId, ticketFence, ticketFences);
            return gitTry(pushRoot, args);
          }),
        });
      };
    const result = typeof pushFn === "function"
      ? withActiveCommandFence(verb || "sync", () => {
        assertPublicationTicketFences(ticketId, ticketFence, ticketFences);
        return doPush(repoRoot);
      })
      : doPush(repoRoot);
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
      `plans/snapshots are committed locally. Resolve the upstream state, then ` +
      `retry the governed terminal verb with \`--push-after-sync\`.` +
      // COORD-894: a branch rule refused the push; name the PR-mode setting.
      (isRuleRefusal(stderr) ? `\n${boardPushRefusalHint(DEFAULT_PATHS.boardBranch)}` : "")
    );
    return { pushed: false, failed: true, detail: stderr };
  }

  // Board-wide publication has no single ticket id. Compare the board rows
  // being published with the configured upstream base, then capture one
  // canonical decision for every changed/added/removed ticket. The returned
  // map is carried unchanged to the last-moment push/PR callback.
  function captureBoardPublicationFences(repoRoot, board) {
    const branchResult = gitTry(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
    const branch = branchResult && branchResult.status === 0 ? String(branchResult.stdout || "").trim() : "";
    if (!branch) return { ticketFences: null, reason: "detached-head" };
    const upstreamResult = gitTry(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
    const upstream = upstreamResult && upstreamResult.status === 0 ? String(upstreamResult.stdout || "").trim() : "";
    const slash = upstream.indexOf("/");
    if (slash <= 0 || slash === upstream.length - 1) return { ticketFences: null, reason: "no-upstream" };
    const remote = upstream.slice(0, slash);
    const remoteBranch = upstream.slice(slash + 1);
    const listed = gitTry(repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${remoteBranch}`]);
    // guard:publish-board-refusal
    if (!listed || listed.status !== 0) fail(`Could not inspect board publication base ${remote}/${remoteBranch}; refusing an unfenced board push.`);

    let baseBoard = { sections: [] };
    if (String(listed.stdout || "").trim()) {
      const fetched = gitTry(repoRoot, ["fetch", "--quiet", remote, remoteBranch]);
      // guard:publish-board-refusal
      if (!fetched || fetched.status !== 0) fail(`Could not refresh board publication base ${remote}/${remoteBranch}; refusing an unfenced board push.`);
      const boardPath = state.BOARD_PATH || (DEFAULT_PATHS && DEFAULT_PATHS.boardPath);
      // guard:publish-board-refusal
      if (!boardPath) fail("Cannot resolve the canonical board path for publication; refusing an unfenced board push.");
      const top = gitTry(repoRoot, ["rev-parse", "--show-toplevel"]);
      const gitRoot = top && top.status === 0 ? String(top.stdout || "").trim() : "";
      // guard:publish-board-refusal
      if (!gitRoot) fail("Cannot resolve the Git top-level for board publication; refusing an unfenced board push.");
      const boardRel = path.relative(gitRoot, boardPath).split(path.sep).join("/");
      const shown = gitTry(repoRoot, ["show", `FETCH_HEAD:${boardRel}`], { maxBuffer: 16 * 1024 * 1024 });
      if (shown && shown.status === 0) {
        try { baseBoard = JSON.parse(String(shown.stdout || "")); }
        catch {
          // guard:publish-board-refusal
          fail(`Board publication base ${upstream}:${boardRel} is unreadable; refusing an unfenced board push.`);
        }
      } else if (!/Path .* does not exist|exists on disk, but not in|does not exist in/i.test(String(shown && shown.stderr || ""))) {
        // guard:publish-board-refusal
        fail(`Could not read fetched board publication base ${remote}/${remoteBranch}:${boardRel}; refusing an unfenced board push.`);
      }
    }

    const rowMap = (value) => new Map((typeof getRows === "function" ? getRows(value) : (value?.sections || []).flatMap((section) => section.rows || []))
      .filter((row) => row && row.ID).map((row) => [row.ID, JSON.stringify(row)]));
    const before = rowMap(baseBoard);
    const after = rowMap(board);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((ticket) => before.get(ticket) !== after.get(ticket)).sort();
    const ticketFences = {};
    for (const ticket of changed) {
      const fence = decisionFenceForTicket(ticket);
      if (!fence || fence.reason === "attempt-remote-unconfigured") {
        // guard:publish-board-refusal
        fail(`Cannot establish the attempt coordination remote for changed board ticket ${ticket}; refusing an unfenced board push.`);
      }
      ticketFences[ticket] = fence;
    }
    return { ticketFences, changed };
  }

  // COORD-246: after a terminal lifecycle verb syncs its post-journal artifacts
  // (plan record / rendered / QUESTIONS), advance the journal's provenance baseline
  // so the next governed mutation's fail-closed entry-check sees the FINAL on-disk
  // state as in-band. Best-effort and never throws out of the auto-sync helper: a
  // baseline-advance failure is itself surfaced by `gov doctor`, and must not undo a
  // lifecycle action that has already completed (and may have merged a PR).
  // COORD-275/533: the exact coord-relative canonical sync scope. The real
  // provider includes board source for every sync; retain explicit deduplicated
  // inclusion for injected/older providers used by terminal boundaries. The post-mutation
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

  // COORD-696: terminal governance may create a canonical sync commit and then
  // fail (or simply omit) the opt-in push. A successful local commit is not a
  // durable closeout when the configured upstream does not contain it. Resolve
  // the branch's upstream as a unit and refresh that exact remote ref before
  // classifying publication; never infer the destination from the local branch
  // name, and never trust a previous fetch or a push exit status.
  function assessCanonicalPublication({ repoRoot = COORD_DIR } = {}) {
    // A missing collaborator is not evidence that publication is inapplicable.
    // Fail closed so a future composition regression cannot silently turn this
    // integrity check off. A real non-git/no-remote installation is identified
    // positively below and remains release-safe.
    if (typeof gitTry !== "function" || !repoRoot) {
      return {
        required: true,
        published: false,
        status: "publication-check-not-configured",
      };
    }

    const inside = gitTry(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.status !== 0 || String(inside.stdout || "").trim() !== "true") {
      return { required: false, published: true, status: "not-a-git-repository" };
    }

    const remotesResult = gitTry(repoRoot, ["remote"]);
    if (!remotesResult || remotesResult.status !== 0) {
      return {
        required: true,
        published: false,
        status: "remote-list-failed",
        detail: String((remotesResult && remotesResult.stderr) || "unable to list git remotes").trim(),
      };
    }
    const remotes = String(remotesResult.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (remotes.length === 0) {
      return { required: false, published: true, status: "no-remote" };
    }

    const branchResult = gitTry(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
    const branch = branchResult && branchResult.status === 0
      ? String(branchResult.stdout || "").trim()
      : "";
    if (!branch) {
      return { required: true, published: false, status: "detached-head" };
    }

    const remoteResult = gitTry(repoRoot, ["config", "--get", `branch.${branch}.remote`]);
    const mergeResult = gitTry(repoRoot, ["config", "--get", `branch.${branch}.merge`]);
    const remote = remoteResult && remoteResult.status === 0
      ? String(remoteResult.stdout || "").trim()
      : "";
    const mergeRef = mergeResult && mergeResult.status === 0
      ? String(mergeResult.stdout || "").trim()
      : "";
    if (!remote || !mergeRef) {
      return { required: true, published: false, status: "no-upstream", branch };
    }
    if (remote === ".") {
      return { required: false, published: true, status: "local-upstream", branch };
    }

    const remoteBranch = mergeRef.replace(/^refs\/heads\//, "");
    const upstream = `${remote}/${remoteBranch}`;
    const fetch = gitTry(repoRoot, ["fetch", "--quiet", remote, remoteBranch]);
    if (!fetch || fetch.status !== 0) {
      return {
        required: true,
        published: false,
        status: "fetch-failed",
        branch,
        upstream,
        detail: String((fetch && fetch.stderr) || "unable to refresh configured upstream").trim(),
      };
    }

    const localResult = gitTry(repoRoot, ["rev-parse", "HEAD"]);
    const remoteShaResult = gitTry(repoRoot, ["rev-parse", `refs/remotes/${upstream}`]);
    const localSha = localResult && localResult.status === 0 ? String(localResult.stdout || "").trim() : "";
    const remoteSha = remoteShaResult && remoteShaResult.status === 0
      ? String(remoteShaResult.stdout || "").trim()
      : "";
    if (!localSha || !remoteSha) {
      return {
        required: true,
        published: false,
        status: "upstream-unresolved",
        branch,
        upstream,
        local_sha: localSha || null,
        remote_sha: remoteSha || null,
      };
    }

    const remoteContainsLocal = gitTry(repoRoot, ["merge-base", "--is-ancestor", localSha, remoteSha]);
    if (remoteContainsLocal && remoteContainsLocal.status === 0) {
      return {
        required: true,
        published: true,
        status: "published",
        branch,
        upstream,
        local_sha: localSha,
        remote_sha: remoteSha,
      };
    }

    const localContainsRemote = gitTry(repoRoot, ["merge-base", "--is-ancestor", remoteSha, localSha]);
    if (localContainsRemote && localContainsRemote.status === 0) {
      const count = gitTry(repoRoot, ["rev-list", "--count", `${remoteSha}..${localSha}`]);
      return {
        required: true,
        published: false,
        status: "ahead",
        branch,
        upstream,
        local_sha: localSha,
        remote_sha: remoteSha,
        ahead_by: Number.parseInt(String((count && count.stdout) || "0").trim(), 10) || 0,
      };
    }

    return {
      required: true,
      published: false,
      status: "diverged",
      branch,
      upstream,
      local_sha: localSha,
      remote_sha: remoteSha,
    };
  }

  function attachPublicationEvidence(summary, { syncSucceeded }) {
    const publication = assessCanonicalPublication();
    return {
      ...summary,
      publication,
      // A repository with no external publication contract can release. When
      // publication is required, BOTH the terminal sync and remote containment
      // must be proven; either half missing retains the session for recovery.
      session_release_safe: publication.required === false || (syncSucceeded === true && publication.published === true),
    };
  }

  function autoSyncAfterLifecycle({ verb, ticketId, options = {}, syncFn, pushFn } = {}) {
    // COORD-668: every sanctioned writer now journals its own output. Residual
    // drift is never proof of provenance merely because its path is syncable.
    if (options && options.noSync === true) {
      return attachPublicationEvidence({ skipped: true, reason: "--no-sync" }, { syncSucceeded: false });
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
      // COORD-696: the explicit governed push also runs when THIS sync is a
      // no-op. A prior terminal attempt may already have committed canonical
      // history locally and failed before publication; restricting recovery to
      // a newly-created commit strands that history forever. The destination is
      // still the configured upstream and the shared primitive still refuses
      // every non-fast-forward/destructive form.
      let push = { pushed: false, reason: "not-requested" };
      if (pushOnFinalizeEnabled(options)) {
        push = pushAfterLifecycleSync({ verb, pushFn, ticketId });
      }
      return attachPublicationEvidence({ skipped: false, result, push }, { syncSucceeded: true });
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      // An off-Git workspace has no publication contract. Preserve its journal
      // baseline even when Git reports that there is nothing to synchronize.
      if (/not a git repository|show-toplevel failed|rev-parse --show-toplevel/i.test(reason)) {
        return attachPublicationEvidence(
          { skipped: true, reason: "coord-root-not-a-git-repo" },
          { syncSucceeded: false },
        );
      }
      // Best-effort: never throw out of this helper. The lifecycle action
      // already succeeded by the time we get here.
      console.warn(
        `[gov sync] best-effort post-${verb} sync failed: ${reason}\n` +
        `The ${verb} action itself succeeded; canonical derived artifacts ` +
        `may now lag the journal. Run \`gov sync --commit "<msg>"\` ` +
        `manually, or rely on \`gov doctor\` to surface persistent drift.`
      );
      return attachPublicationEvidence(
        { skipped: false, failed: true, error: reason },
        { syncSucceeded: false },
      );
    }
  }

  // COORD-911: `gov publish-board` commits and publishes the canonical governance
  // state (board, journal-backed rendered views, prompts, plan records) while
  // tickets are doing. Scope is the canonical syncable set only, never a ticket
  // worktree or another session's edits. Refusal is precise: a dirty path outside
  // that set, or a canonical path the journal does not account for, is listed, and
  // a path under a live foreign session's worktree is named as that session's work.
  // The regeneration and commit run under withGovernanceMutation (the runtime lock
  // serializes them with other board mutations). The push runs after the lock is
  // released, using the configured landing mode (direct or COORD-894 PR). Re-running
  // with nothing to commit is a no-op commit, and the publish still re-attempts an
  // unpublished HEAD, as the COORD-696 recovery path does.
  function publishBoardState(options = {}) {
    const command = "publish-board";
    if (!isInsideGitWorkTree(COORD_DIR)) {
      return {
        command,
        repo_root: relativeCoordPath(COORD_DIR),
        skipped: true,
        reason: "coord root is not inside a git work tree",
      };
    }
    const repoRoot = COORD_DIR;
    const paths = [...canonicalSyncablePaths()];
    const questionRel = path.relative(COORD_DIR, state.QUESTIONS_PATH).split(path.sep).join("/");
    if (!paths.includes(questionRel)) paths.push(questionRel);
    const canonical = new Set(paths);
    const COORD_DIR_NAME = path.basename(COORD_DIR);
    const message = String(options.commit || "").trim() || "chore(coord): publish board state while work is active";
    let summary = null;
    let ticketFences = null;

    withGovernanceMutation({ command, ticket: null }, () => {
      const status = gitTry(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
      if (!status || status.status !== 0) {
        fail(`git status failed in ${repoRoot}: ${String((status && status.stderr) || "").trim()}`);
      }
      const liveLocks = treeMutationSafety.liveForeignDoingLocks({
        board: typeof readBoard === "function" ? readBoard() : null,
        getRows,
        isDoingStatus,
        findLockForTicket,
        isStaleTicketLock,
        currentTicketId: null,
      });
      const foreign = [];
      const unaccounted = [];
      // COORD-928 option A: journal-accounted authored files ride with the board commit.
      const provenance = detectGovernanceProvenanceDrift();
      const accountedAuthored = new Set(journalAccountedAuthoredPaths(repoRoot, provenance));
      for (const entry of treeMutationSafety.parsePorcelainStatusPaths(status.stdout)) {
        // git reports repo-top-relative paths; the canonical set is coord-relative.
        const coordRel = entry.startsWith(`${COORD_DIR_NAME}/`) ? entry.slice(COORD_DIR_NAME.length + 1) : entry;
        if (canonical.has(coordRel) || accountedAuthored.has(coordRel)) continue;
        const absolute = path.resolve(COORD_DIR, "..", entry);
        const owner = liveLocks.find((lock) => lock.worktree
          && absolute.startsWith(`${path.resolve(lock.worktree)}${path.sep}`));
        if (owner) foreign.push(`${entry} [${owner.ticket}(${owner.owner}) ${owner.session_relationship || "foreign-session"}]`);
        else unaccounted.push(entry);
      }
      // Canonical paths the journal does not account for: out-of-band edits.
      const { blocking } = splitGovernanceProvenanceDrift(provenance.drift || []);
      for (const drifted of blocking) {
        if (!unaccounted.includes(drifted)) unaccounted.push(drifted);
      }
      if (foreign.length > 0 || unaccounted.length > 0) {
        // guard:publish-board-refusal
        const refusal = "Refusing gov publish-board: " +
          (foreign.length > 0
            ? `dirty path(s) belong to another live session's uncommitted work: ${foreign.join(", ")}. `
            : "") +
          (unaccounted.length > 0
            ? `unaccounted path(s), not produced by governed verbs or not in the journal: ${unaccounted.join(", ")}. `
            : "") +
          "Commit or revert them through governed verbs first; nothing was published.";
        fail(refusal);
      }

      runBoardSync({ ticketScopedValidation: false });
      const fenceSnapshot = captureBoardPublicationFences(repoRoot, readBoard());
      ticketFences = fenceSnapshot.ticketFences;
      if (!ticketFences) {
        // guard:publish-board-refusal
        fail(`Cannot establish a board publication base (${fenceSnapshot.reason}); refusing an unfenced board push.`);
      }
      // Option A runs before the COORD-928 prompt_index check, so an accounted prompt passes it.
      const delta = [...new Set([...computeSyncDelta(repoRoot, paths), ...accountedAuthored])];
      assertPromptIndexPublishable(delta);
      summary = { command, repo_root: relativeCoordPath(repoRoot), canonical_paths: paths, delta, committed: false, message };
      if (delta.length > 0) {
        commitCanonicalDelta(repoRoot, message, delta);
        summary.committed = true;
      }
    });

    // Publish after the lock is released. A PR-mode board landing and a direct
    // push are both resolved by pushAfterLifecycleSync from DEFAULT_PATHS.
    summary.push = pushAfterLifecycleSync({ verb: command, repoRoot, ticketId: null, ticketFences, pr: options.pr || null, pushFn: options.pushFn });
    summary.ticket_fence_count = Object.keys(ticketFences).length;
    // A refused publish must not look successful: the commit stays local, and a
    // re-run publishes the same HEAD without creating a second commit.
    if (summary.push && summary.push.failed === true) {
      fail(`gov publish-board: the commit is local but was not published (${summary.push.detail || "push refused"}). Re-run gov publish-board to retry; it creates no second commit.`);
    }
    summary = attachPublicationEvidence(summary, { syncSucceeded: true });
    if (options.quiet !== true) console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  return {
    runSyncCommand,
    publishBoardState,
    commitCanonicalDelta,
    buildAutoSyncMessage,
    pushOnFinalizeEnabled,
    pushAfterLifecycleSync,
    lifecycleSyncScopePaths,
    advanceProvenanceBaselineAfterLifecycle,
    autoSyncAfterLifecycle,
    assessCanonicalPublication,
  };
};
