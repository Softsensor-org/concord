"use strict";

const path = require("path");
const {
  defaultControlPlaneLayout,
  controlPlaneRepoUnavailableMessage,
  manifestPathForCoordRepoPath,
  resolveControlPlaneIntegrationBranch,
} = require("./control-plane-paths.js");

module.exports = function createLifecycleRepoXCloseout({
  COORD_DIR,
  REPO_ROOTS,
  enginePin,
  getRepoRoot,
  gitTry,
  inferTicketIdFromPath,
  listGitWorktrees,
  readTicketFileSurface,
  recordExternalSideEffect,
  repoDisplayNameForCode,
  controlPlaneLayout,
}) {
  // COORD-635 defect (2): Repo-X closeout ran its git verbs against ROOT_DIR —
  // the workspace CONTAINER. Under ADR-0008 the container is not a repository
  // at all, so every one of those probes was either meaningless or aimed at
  // somebody else's repository. Control-plane closeout resolves to
  // coordRepoRoot, the same root `gov start` cut the worktree from.
  function layout() {
    if (typeof controlPlaneLayout === "function") {
      return controlPlaneLayout();
    }
    return controlPlaneLayout || defaultControlPlaneLayout();
  }

  function coordRepoRootOrFail(ticketId) {
    const current = layout();
    if (current && current.coordRepoRoot) {
      return current.coordRepoRoot;
    }
    throw new Error(
      `Ticket ${ticketId} Repo X closeout cannot verify control-plane delivery: ` +
      controlPlaneRepoUnavailableMessage(current, "Repo X closeout")
    );
  }
  function collectTicketWorktreeResidue(ticketId, worktreesByRepo) {
    const residue = [];
    const coordRoot = path.resolve(COORD_DIR, ".worktrees");
    for (const [repoCode, worktrees] of Object.entries(worktreesByRepo || {})) {
      for (const entry of worktrees || []) {
        if (!entry || !entry.path || inferTicketIdFromPath(entry.path) !== ticketId) {
          continue;
        }
        if (path.resolve(entry.path).startsWith(`${coordRoot}${path.sep}`)) {
          continue;
        }
        residue.push({
          repoCode,
          repoLabel: repoDisplayNameForCode(repoCode),
          path: entry.path,
          branch: entry.branch || null,
        });
      }
    }
    return residue;
  }

  function findTicketProductWorktreeResidue(ticketId) {
    const worktreesByRepo = {};
    for (const repoCode of Object.keys(REPO_ROOTS).filter((code) => code !== "X")) {
      const repoRoot = getRepoRoot(repoCode);
      worktreesByRepo[repoCode] = listGitWorktrees(repoRoot).filter((entry) => entry.path !== repoRoot);
    }
    return collectTicketWorktreeResidue(ticketId, worktreesByRepo);
  }

  // COORD-512: a Repo-X ticket's governed work lands on the COORD WORKSPACE
  // branch (the ticket worktree branch cut by `gov start`), but the old
  // closeout path never checked it — `land`/`finalize` marked review -> done
  // while workspace main could still hold pre-ticket content (silent doc
  // loss). Detect any workspace ticket branch that is not an ancestor of the
  // workspace HEAD and refuse mark-done, printing the exact merge command.
  // Fail-closed: we refuse rather than auto-merge into the adopter's live
  // branch. Branch-absent is NOT an error — a merged-and-deleted branch (or
  // work committed directly on main) leaves nothing detectable to lose.
  function listWorkspaceTicketBranches(ticketId) {
    if (typeof gitTry !== "function") {
      throw new Error(
        "createLifecycleRepoXCloseout requires gitTry to verify Repo X control-plane landing (COORD-512/COORD-635)."
      );
    }
    const coordRoot = coordRepoRootOrFail(ticketId);
    const listed = gitTry(coordRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agent/"]);
    if (listed.status !== 0) {
      throw new Error(
        `Ticket ${ticketId} Repo X closeout could not list workspace ticket branches: ` +
        `${String(listed.stderr || "").trim() || `git for-each-ref exited ${listed.status}`}.`
      );
    }
    const marker = new RegExp(`-${String(ticketId).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-|$)`);
    return String(listed.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((branch) => marker.test(branch.toLowerCase()));
  }

  function findUnmergedWorkspaceTicketBranches(ticketId) {
    const branches = listWorkspaceTicketBranches(ticketId);
    const coordRoot = coordRepoRootOrFail(ticketId);
    const unmerged = [];
    for (const branch of branches) {
      const probe = gitTry(coordRoot, ["merge-base", "--is-ancestor", branch, "HEAD"]);
      if (probe.status === 0) {
        continue; // merged
      }
      if (probe.status === 1) {
        unmerged.push(branch); // real branch, not an ancestor of HEAD
        continue;
      }
      throw new Error(
        `Ticket ${ticketId} Repo X closeout could not verify branch ${branch}: ` +
        `${String(probe.stderr || "").trim() || `git merge-base exited ${probe.status}`}.`
      );
    }
    return unmerged;
  }

  // COORD-591: COORD-512 closed with an intentional coord/scripts/lifecycle.js
  // engine change while canonical main stayed DRIFTED on both integrity
  // surfaces (check-template-sync + verify-engine) — the closeout gate never
  // consulted them. For a Repo-X ticket whose change surface touches the
  // pinned engine surface, refuse mark-done until BOTH surfaces pass, naming
  // the exact drifted paths. Scoped to engine-facing tickets so unrelated
  // doc-only Repo-X closeouts are not blocked by pre-existing drift they did
  // not create (the repair ticket that re-stamps/re-pins merges its stamp
  // first, so its own closeout passes — the intentional-upgrade path).

  // Attribute the ticket's merged change surface via the explicit workspace
  // merge commit (second parent == ticket branch tip). Branch-absent or
  // fast-forwarded histories yield no attribution here — the plan-record
  // surface below still applies, mirroring the ancestry guard's
  // branch-absent semantics.
  function findTicketMergedChangeSurface(ticketId) {
    const files = new Set();
    const coordRoot = coordRepoRootOrFail(ticketId);
    const current = layout();
    for (const branch of listWorkspaceTicketBranches(ticketId)) {
      const tipProbe = gitTry(coordRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
      if (tipProbe.status !== 0) {
        throw new Error(
          `Ticket ${ticketId} Repo X closeout could not resolve branch ${branch}: ` +
          `${String(tipProbe.stderr || "").trim() || `git rev-parse exited ${tipProbe.status}`}.`
        );
      }
      const tip = String(tipProbe.stdout || "").trim();
      const merged = gitTry(coordRoot, ["merge-base", "--is-ancestor", branch, "HEAD"]);
      if (merged.status !== 0) {
        continue; // unmerged branches are the ancestry guard's problem, not attribution's
      }
      const logProbe = gitTry(coordRoot, ["log", "--merges", "--format=%H %P", "-n", "500", "HEAD"]);
      if (logProbe.status !== 0) {
        throw new Error(
          `Ticket ${ticketId} Repo X closeout could not scan workspace merges: ` +
          `${String(logProbe.stderr || "").trim() || `git log exited ${logProbe.status}`}.`
        );
      }
      for (const line of String(logProbe.stdout || "").split("\n")) {
        const parts = line.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 3) continue;
        const [mergeSha, firstParent, ...otherParents] = parts;
        if (!otherParents.includes(tip)) continue;
        const diff = gitTry(coordRoot, ["diff", "--name-only", firstParent, mergeSha]);
        if (diff.status !== 0) {
          throw new Error(
            `Ticket ${ticketId} Repo X closeout could not diff merge ${mergeSha}: ` +
            `${String(diff.stderr || "").trim() || `git diff exited ${diff.status}`}.`
          );
        }
        for (const file of String(diff.stdout || "").split("\n")) {
          const trimmed = file.trim();
          if (!trimmed) continue;
          // COORD-635 defect (5): git reports paths relative to coordRepoRoot
          // ("scripts/worktree-ops.js" when coord/ IS the repository) while the
          // engine manifest names them relative to the workspace
          // ("coord/scripts/worktree-ops.js"). Without this translation the
          // engine-facing test below silently matched nothing and the
          // integrity gate never fired for a control-plane change.
          const manifestPath = manifestPathForCoordRepoPath(current, trimmed);
          files.add(manifestPath || trimmed);
        }
        break;
      }
    }
    return [...files];
  }

  function normalizeSurfacePath(filePath) {
    return String(filePath || "").trim().replace(/\\/g, "/");
  }

  function ensureEngineIntegrityForCloseout(ticketId) {
    if (!enginePin || typeof enginePin.verifyManifest !== "function" || typeof enginePin.verify !== "function") {
      throw new Error(
        "createLifecycleRepoXCloseout requires an enginePin surface to verify Repo X engine integrity (COORD-591)."
      );
    }
    const planSurface = typeof readTicketFileSurface === "function" ? readTicketFileSurface(ticketId) : [];
    const changed = new Set(
      [...(planSurface || []), ...findTicketMergedChangeSurface(ticketId)]
        .map(normalizeSurfacePath)
        .filter(Boolean)
    );
    if (changed.size === 0) {
      return null;
    }
    const enginePaths = new Set(
      (enginePin.deriveManifestFingerprint().manifest.items || [])
        .map((item) => item && item.path)
        .filter(Boolean)
        .map(normalizeSurfacePath)
    );
    enginePaths.add("coord/TEMPLATE_SYNC_MANIFEST.json");
    enginePaths.add("coord/engine-pin.json");
    const engineFacing = [...changed].filter((file) => enginePaths.has(file)).sort();
    if (engineFacing.length === 0) {
      return null;
    }

    const manifestReport = enginePin.verifyManifest();
    const pinReport = enginePin.verify();
    const problems = [];
    if (!manifestReport.ok) {
      problems.push(
        `check-template-sync drift: ${manifestReport.failures.map((f) => `${f.path} (${f.kind})`).join(", ")}`
      );
    }
    if (!pinReport.ok) {
      const driftedPaths = (pinReport.drifted_files || []).map((f) => `${f.path} (${f.kind})`);
      problems.push(
        `verify-engine drift: ${driftedPaths.length ? driftedPaths.join(", ") : pinReport.problems.map((p) => p.code).join(", ")}`
      );
    }
    if (problems.length > 0) {
      throw new Error(
        `Ticket ${ticketId} is Repo X with engine-facing changes (${engineFacing.join(", ")}) ` +
        `but the donor integrity surfaces are DRIFTED — ${problems.join("; ")}. ` +
        `Marking done now would publish an engine change without re-stamped integrity (COORD-591; the COORD-512 sequence). ` +
        "Re-stamp coord/TEMPLATE_SYNC_MANIFEST.json and re-pin with `gov verify-engine --pin` as part of the reviewed change, " +
        "merge that into the workspace branch, then retry."
      );
    }
    return null;
  }

  // COORD-667: THE TWO GUARDS DEADLOCKED, AND NEITHER WAS WRONG.
  //
  // The COORD-512 ancestry guard above refuses mark-done until the workspace
  // ticket branch is an ancestor of the workspace branch, and told the operator
  // to run `git merge --no-ff <branch>` by hand. But `gov start` cuts Repo-X
  // worktrees from the workspace branch, so at closeout HEAD is on the
  // protected integration branch — and `coord/scripts/hooks/pre-bash-guard.js`
  // refuses exactly that command under rule `head-on-protected-branch`
  // (COORD-664). The guard is fail-closed BY DESIGN and has no env override, so
  // the instruction governance printed was one governance's own safety hook
  // existed to refuse: no repo-X ticket could be landed by any sanctioned path.
  //
  // The fix is NOT to weaken either guard. It is to stop delegating a governed
  // mutation to a hand-run command: governance performs the workspace merge
  // ITSELF, in-process, inside the same journaled transaction that is about to
  // mark the ticket done. The pre-bash-guard is untouched — it guards the Bash
  // surface, and the hand-run merge stays refused there forever.
  //
  // THIS DOES NOT BYPASS THE COORD-512 GUARD. The merge runs BEFORE
  // findUnmergedWorkspaceTicketBranches, and that check still runs afterwards
  // and is still the only authority on whether closeout may proceed. A merge
  // that silently did nothing would leave the guard refusing exactly as before.
  //
  // OPT-IN, NOT AUTOMATIC. COORD-512 ruled explicitly for the fail-closed shape
  // over auto-merge ("do not auto-merge into the adopter's live main"), and
  // that ruling still holds: coord/ installs into adopter workspaces, and a
  // closeout must not advance a human's live integration branch as a silent
  // side effect of a board transition. `--merge-workspace` is the operator
  // saying so. What COORD-667 changes is that every command governance now
  // prints is a command governance itself will execute.
  function assertMergeableWorkspaceHead(ticketId, coordRoot, branch, options = {}) {
    const headProbe = gitTry(coordRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (headProbe.status !== 0) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: HEAD in ${coordRoot} is detached, so there is no branch ` +
        "for the governed merge to land on. Check out the control-plane integration branch and retry."
      );
    }
    const head = String(headProbe.stdout || "").trim();
    if (!head) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: could not read the current branch in ${coordRoot}.`
      );
    }
    if (head === branch) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: HEAD is already on the ticket branch ${branch}. ` +
        "Run the closeout from the control-plane integration branch, not from the ticket branch itself."
      );
    }
    if (/^agent\//.test(head)) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: HEAD is on ticket branch ${head}, not a control-plane ` +
        `integration branch. Merging ${branch} there would record delivery on somebody else's ticket branch.`
      );
    }
    // `--base` is the operator's explicit assertion about which branch this
    // closeout is allowed to advance. It is checked when supplied and never
    // invented: resolveControlPlaneIntegrationBranch falls back to the CURRENT
    // branch in a clone with no resolvable origin/HEAD, so comparing HEAD to an
    // unrequested resolution would be a check that can only ever pass.
    const requested = String(options.base || "").trim();
    if (requested && requested !== head) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: --base named "${requested}" but HEAD in ${coordRoot} is on ` +
        `"${head}". Governance will not merge onto a branch the caller did not ask for.`
      );
    }
    return head;
  }

  // A `git merge` aborts when it would clobber uncommitted work, and reports it
  // as a bare failure after the fact. Governed closeout runs on a tree that
  // routinely carries in-flight governed churn (board rows, PLAN.md, the event
  // journal), so the overlap is named UP FRONT and refused precisely: only the
  // paths the incoming merge actually touches matter, so an unrelated dirty
  // file is not turned into a blanket refusal.
  function findUncommittedMergeOverlap(ticketId, coordRoot, branch) {
    const status = gitTry(coordRoot, ["status", "--porcelain"]);
    if (status.status !== 0) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: could not read the working tree state in ${coordRoot}: ` +
        `${String(status.stderr || "").trim() || `git status exited ${status.status}`}.`
      );
    }
    const dirty = new Set();
    for (const line of String(status.stdout || "").split("\n")) {
      if (!line.trim()) continue;
      const entry = line.slice(3).trim();
      if (!entry) continue;
      // Rename/copy entries are reported as "old -> new"; both sides are live.
      for (const part of entry.split(" -> ")) {
        const cleaned = part.trim().replace(/^"(.*)"$/, "$1");
        if (cleaned) dirty.add(cleaned);
      }
    }
    if (dirty.size === 0) {
      return [];
    }
    const incoming = gitTry(coordRoot, ["diff", "--name-only", `HEAD...${branch}`]);
    if (incoming.status !== 0) {
      throw new Error(
        `Ticket ${ticketId} workspace merge refused: could not compute the incoming change surface for ${branch}: ` +
        `${String(incoming.stderr || "").trim() || `git diff exited ${incoming.status}`}.`
      );
    }
    return String(incoming.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && dirty.has(line))
      .sort();
  }

  // `--no-ff` is REQUIRED, not stylistic. findTicketMergedChangeSurface above
  // attributes a ticket's engine-facing surface through the merge commit whose
  // second parent is the branch tip; a fast-forward produces no such commit and
  // would silently disarm the COORD-591 integrity gate. A hand-run merge could
  // always be typed without it. In-process, it cannot.
  function mergeWorkspaceTicketBranches(ticketId, options = {}) {
    const pending = findUnmergedWorkspaceTicketBranches(ticketId);
    if (pending.length === 0) {
      return [];
    }
    const coordRoot = coordRepoRootOrFail(ticketId);
    const integrationBranch = resolveControlPlaneIntegrationBranch(layout(), {
      configuredBranch: options.base,
      gitTry,
    });
    const merged = [];
    for (const branch of pending) {
      const head = assertMergeableWorkspaceHead(ticketId, coordRoot, branch, options);
      const overlap = findUncommittedMergeOverlap(ticketId, coordRoot, branch);
      if (overlap.length > 0) {
        throw new Error(
          `Ticket ${ticketId} workspace merge refused: ${overlap.length} path(s) the merge of ${branch} would ` +
          `write are uncommitted in ${coordRoot}: ${overlap.join(", ")}. Commit, stash, or restore them and retry — ` +
          "governance will not merge over uncommitted work it cannot attribute."
        );
      }
      const result = gitTry(coordRoot, [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Merge ${branch} into ${head} (${ticketId} governed control-plane landing)`,
        branch,
      ]);
      if (result.status !== 0) {
        // Leave no half-merged tree behind: a conflicted MERGE_HEAD would make
        // every later governed verb fail for a reason unrelated to its own work.
        gitTry(coordRoot, ["merge", "--abort"]);
        throw new Error(
          `Ticket ${ticketId} workspace merge of ${branch} into ${head} failed and was aborted: ` +
          `${String(result.stderr || result.stdout || "").trim() || `git merge exited ${result.status}`}. ` +
          "Resolve the conflict on the ticket branch (rebase or merge the integration branch into it there), " +
          "then retry the closeout."
        );
      }
      const shaProbe = gitTry(coordRoot, ["rev-parse", "HEAD"]);
      const mergeCommitSha = shaProbe.status === 0 ? (String(shaProbe.stdout || "").trim() || null) : null;
      // The merge commit is IRREVERSIBLE by the governed rollback, which only
      // restores governed FILES. Record it the way a merged PR is recorded, so a
      // later failure in the same transaction reports what already happened
      // instead of silently rolling the board back over a real merge.
      if (typeof recordExternalSideEffect === "function") {
        recordExternalSideEffect({
          type: "control_plane_workspace_merge",
          ticket: ticketId,
          branch,
          base_branch: head,
          integration_branch: integrationBranch,
          merge_commit_sha: mergeCommitSha,
          repo_root: coordRoot,
        });
      }
      merged.push({ branch, base_branch: head, merge_commit_sha: mergeCommitSha });
    }
    return merged;
  }

  function ensureRepoXCloseoutReady(ticketId, options = {}) {
    const residue = findTicketProductWorktreeResidue(ticketId);
    if (residue.length > 0) {
      const details = residue
        .map((entry) => `${entry.repoLabel}:${entry.path}${entry.branch ? ` (${entry.branch})` : ""}`)
        .join(", ");
      throw new Error(
        `Ticket ${ticketId} is Repo X but still has governed backend/frontend worktree residue: ${details}. ` +
        "Repo X closeout cannot hide product-repo delivery; split that work into B/F tickets or land and clean the repo worktrees before mark-done."
      );
    }

    // COORD-667: perform the merge in-process when asked, THEN re-run the
    // COORD-512 ancestry check below. The check, not the merge, remains the
    // authority on whether this closeout may proceed.
    if (options.mergeWorkspace === true) {
      mergeWorkspaceTicketBranches(ticketId, options);
    }

    const unmerged = findUnmergedWorkspaceTicketBranches(ticketId);
    if (unmerged.length > 0) {
      throw new Error(
        `Ticket ${ticketId} is Repo X but its workspace ticket branch is not merged into the workspace branch: ` +
        `${unmerged.join(", ")}. Marking done now would record delivery the control-plane repository does not contain (COORD-512). ` +
        `Land it through governance, which performs this merge itself, in-process, inside this same transaction: re-run ` +
        `this closeout with --merge-workspace (\`coord/scripts/gov land ${ticketId} --merge-workspace\`, or ` +
        `\`coord/scripts/gov finalize ${ticketId} --no-pr --merge-workspace --landed "<evidence>"\`). ` +
        "Do NOT run `git merge` by hand: coord/scripts/hooks/pre-bash-guard.js refuses it whenever HEAD is on a " +
        "protected integration branch (rule head-on-protected-branch, COORD-664), and that refusal is correct — " +
        "delegating this merge to a command the guard exists to reject was the COORD-667 deadlock."
      );
    }

    ensureEngineIntegrityForCloseout(ticketId);
    return null;
  }

  return {
    collectTicketWorktreeResidue,
    ensureEngineIntegrityForCloseout,
    ensureRepoXCloseoutReady,
    findTicketMergedChangeSurface,
    findTicketProductWorktreeResidue,
    findUncommittedMergeOverlap,
    findUnmergedWorkspaceTicketBranches,
    mergeWorkspaceTicketBranches,
  };
};
