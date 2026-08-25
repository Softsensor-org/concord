"use strict";

// COORD-635 — governed workspace RECOVERY, and the isolation post-condition.
//
// THE HAZARD THIS REMOVES. A governed lock names a worktree path. When that
// worktree is gone — directory and registration both — the recovery verbs used
// to do one of two unsafe things:
//
//   `return-doing`  for Repo X ran `fs.mkdirSync(worktree)` and called it a
//                   worktree (ticket-transitions.js). A PLAIN DIRECTORY.
//   `resume`        ensured nothing at all and exited 0, leaving the lock
//                   pointing at a path that does not exist.
//
// Both end the same way. The governed worktree path lives INSIDE the canonical
// tree (coord/.worktrees/... and <repo>/.worktrees/...), so a plain directory
// there is not isolated from anything: `git -C <that dir> rev-parse
// --show-toplevel` walks UP and answers **canonical**. An agent told "your
// worktree is <path>" then edits, stages and commits against canonical `main`
// while believing it is isolated. That is the failure that corrupted three
// concurrent runs in one session.
//
// THE CONTRACT. Recovery has exactly two acceptable outcomes:
//
//   RECONSTRUCT  materialize a real git worktree through the same
//                ensureTicketWorkspace the start path uses, then PROVE
//                isolation before handing it back, or
//   FAIL CLOSED  refuse, naming the exact remediation.
//
// A third outcome — "carry on with something that is not a worktree" — is not
// available, and `assertGovernedWorktreeIsolated` is what makes that structural
// rather than a matter of care. It is called on EVERY recovery path, for
// product repos exactly as for the control plane: the hazard is a property of
// worktree paths nested inside their own repository, which both share.
//
// The isolation assertion is deliberately a POST-CONDITION on the real
// filesystem, not a check of what we intended to do. Reconstruction that
// silently no-ops, a stale `.git` file, a registration pointing elsewhere, a
// path that resolves to the canonical tree — all of them fail the same way,
// because what is asserted is the thing that actually matters: this directory
// is its own worktree, and git agrees.

const fs = require("fs");
const path = require("path");
const { gitTry: defaultGitTry } = require("./git-ops.js");

// Does `worktree` resolve to ITSELF as a git worktree top level? This is the
// question that separates a real worktree from a plain directory nested in the
// canonical tree — the latter answers with the canonical root.
function resolveWorktreeToplevel(worktree, gitTry = defaultGitTry) {
  if (!fs.existsSync(worktree)) {
    return null;
  }
  // Pinned with an explicit directory (git -C): a subprocess that inherits the
  // wrong cwd resolves the wrong repository (COORD-631).
  const probe = gitTry(worktree, ["rev-parse", "--show-toplevel"]);
  if (!probe || probe.status !== 0) {
    return null;
  }
  const top = String(probe.stdout || "").trim();
  return top ? path.resolve(top) : null;
}

// Name the type in refusals, so an operator is told what is actually there
// rather than just that it is "not a directory".
function describeFileType(stats) {
  if (stats.isFile()) return "a regular file";
  if (stats.isSymbolicLink()) return "a symbolic link";
  if (stats.isBlockDevice()) return "a block device";
  if (stats.isCharacterDevice()) return "a character device";
  if (stats.isFIFO()) return "a FIFO";
  if (stats.isSocket()) return "a socket";
  return "an unrecognized file type";
}

function isOwnWorktreeToplevel(worktree, gitTry = defaultGitTry) {
  return resolveWorktreeToplevel(worktree, gitTry) === path.resolve(worktree);
}

// The post-condition. Both halves matter and neither implies the other:
//   - show-toplevel === the worktree  proves the directory is not a plain
//     directory resolving upward to the canonical tree.
//   - registered in <repoRoot>        proves git owns it, so cleanup,
//     `worktree list`, doctor and prune can all see it.
function assertGovernedWorktreeIsolated({
  ticketId,
  worktree,
  repoRoot,
  listGitWorktrees,
  gitTry = defaultGitTry,
  fail,
  stage = "recovery",
}) {
  const target = path.resolve(worktree);
  const raise = (message) => {
    if (typeof fail === "function") {
      fail(message);
    }
    throw new Error(message);
  };

  if (!fs.existsSync(target)) {
    raise(
      `Ticket ${ticketId} governed worktree ${target} does not exist after ${stage}. ` +
      "Governance refuses to continue with a lock that points at a missing workspace."
    );
  }

  const toplevel = resolveWorktreeToplevel(target, gitTry);
  if (toplevel !== target) {
    raise(
      `Ticket ${ticketId} governed worktree ${target} is NOT an isolated git worktree after ${stage}: ` +
      `git resolves it to ${toplevel || "no repository"}. ` +
      (toplevel && toplevel !== target
        ? `Working there would edit and stage ${toplevel} — the canonical tree — while appearing to be isolated. `
        : "") +
      `Remove the stray path and re-create the governed worktree: ` +
      `\`coord/scripts/gov cleanup-worktree ${repoRoot ? "<repo>" : "coord"} ${ticketId} --yes\` then ` +
      `\`coord/scripts/gov resume ${ticketId}\`.`
    );
  }

  if (typeof listGitWorktrees === "function" && repoRoot) {
    const registered = listGitWorktrees(repoRoot).some((entry) => path.resolve(entry.path) === target);
    if (!registered) {
      raise(
        `Ticket ${ticketId} governed worktree ${target} is not registered in ${repoRoot} after ${stage}. ` +
        "An unregistered worktree is invisible to cleanup, doctor and `git worktree list`, and becomes orphaned residue. " +
        `Re-create it with \`coord/scripts/gov resume ${ticketId}\`.`
      );
    }
  }

  return { worktree: target, repoRoot: repoRoot || null, isolated: true };
}

// The single recovery entry point. Reconstructs when it safely can, fails
// closed when it cannot, and NEVER returns without the post-condition holding.
//
// `ensureTicketWorkspace` is the SAME function `gov start` uses, so a recovered
// worktree is identical to a freshly started one — recovery cannot drift into
// a second, weaker construction path.
function ensureGovernedWorkspace({
  ticketId,
  repoCode,
  worktree,
  branch,
  base,
  repoRoot,
  ensureTicketWorkspace,
  listGitWorktrees,
  gitTry = defaultGitTry,
  fail,
  stage = "recovery",
}) {
  const target = path.resolve(worktree);
  const raise = (message) => {
    if (typeof fail === "function") {
      fail(message);
    }
    throw new Error(message);
  };

  if (typeof ensureTicketWorkspace !== "function") {
    raise(`Ticket ${ticketId} workspace recovery requires ensureTicketWorkspace (${stage}).`);
  }

  // A path that exists but is not its own worktree is the dangerous state: it
  // is what the old `fs.mkdirSync(worktree)` produced, and what a hand-made
  // directory produces. We never adopt it — and we never delete anything we
  // have not positively identified as an empty ordinary directory.
  //
  // The clearing step below is the ONLY destructive act in recovery, and it sits
  // directly under the guard whose entire purpose is "never delete something we
  // do not understand". So every question it asks fails CLOSED:
  //
  //   lstat, not stat/existsSync : stat FOLLOWS symlinks, so a symlink to an
  //                                empty directory would be reported as an
  //                                ordinary empty directory and unlinked.
  //                                existsSync answers a different question
  //                                entirely and also follows links.
  //   only Directory proceeds    : a regular file makes readdir throw ENOTDIR;
  //                                sockets, FIFOs, devices and unknown types are
  //                                not ours to remove either.
  //   errors NEVER mean "empty"  : EACCES / EPERM / EIO / a stale mount are
  //                                reasons we cannot inspect, not evidence that
  //                                there is nothing to lose.
  //   rmdir, not rm -r           : a NON-recursive rmdir refuses atomically if
  //                                content appears between our inspection and
  //                                the removal. That closes the check-then-act
  //                                race by construction rather than by making
  //                                the window smaller.
  //
  // Presence is decided ONCE, here, by lstat — and never re-asked with
  // existsSync. existsSync answers "does this path resolve to something", which
  // is FALSE for a DANGLING SYMLINK even though the link plainly exists. Asking
  // it skipped the whole guard below AND satisfied the reconstruction test at
  // the bottom, so recovery would have run `git worktree add` straight through
  // the link. A link pointing at the canonical tree is exactly the redirection
  // this function exists to prevent, arriving through the one question that
  // did not look. Only ENOENT means absent; every other error is a refusal.
  let stats = null;
  let present;
  try {
    stats = fs.lstatSync(target);
    present = true;
  } catch (error) {
    if (error.code === "ENOENT") {
      present = false;
    } else {
      raise(
        `Ticket ${ticketId} workspace path ${target} could not be inspected ` +
        `(${error.code || error.message}). Governance refuses to treat a path it cannot identify ` +
        `as absent, because the next step would create a worktree over it. ` +
        `Inspect it manually, then rerun \`coord/scripts/gov resume ${ticketId}\`.`
      );
    }
  }

  // Symlinks are refused BEFORE git is consulted, and regardless of what they
  // point at — dangling, live, or even resolving to a genuine worktree. The
  // lock names a path; if that path is a link then the recorded location and
  // the working location are not the same place, which is the ambiguity the
  // isolation post-condition exists to exclude.
  if (present && stats.isSymbolicLink()) {
    raise(
      `Ticket ${ticketId} workspace path ${target} is a SYMLINK, not a governed worktree. ` +
      "Governance refuses to remove it or to build over it: the link may point anywhere — " +
      "including at the canonical tree — and following it is never recovery. " +
      `Inspect and remove it deliberately, then rerun \`coord/scripts/gov resume ${ticketId}\`.`
    );
  }

  if (present && !isOwnWorktreeToplevel(target, gitTry)) {
    const describeStray = () =>
      `git resolves it to ${resolveWorktreeToplevel(target, gitTry) || "no repository"}, ` +
      "so working there would edit the canonical tree";

    if (!stats.isDirectory()) {
      raise(
        `Ticket ${ticketId} workspace path ${target} is not a directory (it is ` +
        `${describeFileType(stats)}), so it is not a governed worktree and not recovery's to delete. ` +
        `Move or remove it deliberately, then rerun \`coord/scripts/gov resume ${ticketId}\`.`
      );
    }

    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch (error) {
      // Fail CLOSED. An unreadable directory is the case we know least about,
      // which makes it the last thing that should be deleted automatically.
      raise(
        `Ticket ${ticketId} workspace path ${target} is a directory whose contents could not be read ` +
        `(${error.code || error.message}). Governance refuses to remove a path it cannot verify is empty. ` +
        `Inspect it manually, then rerun \`coord/scripts/gov resume ${ticketId}\`.`
      );
    }

    if (entries.length > 0) {
      // Non-empty and not a worktree: there may be real content here. Refuse —
      // recovery must never delete something it does not understand.
      raise(
        `Ticket ${ticketId} workspace path ${target} exists but is NOT a git worktree, and is not empty ` +
        `(${entries.length} entr${entries.length === 1 ? "y" : "ies"}). ${describeStray()}. ` +
        "Governance refuses to delete it automatically. Inspect and move or remove it, then rerun " +
        `\`coord/scripts/gov resume ${ticketId}\`.`
      );
    }

    // Confirmed: an ordinary, readable, EMPTY directory. Non-recursive rmdir —
    // if anything appeared since the readdir above, this refuses rather than
    // deleting it.
    try {
      fs.rmdirSync(target);
    } catch (error) {
      raise(
        `Ticket ${ticketId} workspace path ${target} could not be removed (${error.code || error.message}). ` +
        (error.code === "ENOTEMPTY"
          ? "Content appeared while recovery was inspecting it, so removal was refused rather than " +
            "deleting work that arrived in the meantime. "
          : "") +
        `Inspect it manually, then rerun \`coord/scripts/gov resume ${ticketId}\`.`
      );
    }
    // Removed by US, deliberately, after positive identification. Recording it
    // as state rather than re-deriving it means reconstruction is driven by
    // what recovery actually did, not by a second filesystem question whose
    // answer could differ.
    present = false;
  }

  if (!present) {
    ensureTicketWorkspace({ repoCode, worktree: target, branch, base });
  }

  return assertGovernedWorktreeIsolated({
    ticketId,
    worktree: target,
    repoRoot,
    listGitWorktrees,
    gitTry,
    fail,
    stage,
  });
}

// Factory binding the recovery entry point to an engine's dependency set, so
// `return-doing` and `resume` share ONE implementation and cannot drift apart
// on what recovery means. Repo-root resolution is the only per-repo-kind
// difference: product repos resolve through the repo registry, the control
// plane through coordRepoRoot (ADR-0008).
function createGovernedWorkspaceRecovery(deps = {}) {
  const {
    ensureTicketWorkspace,
    listGitWorktrees,
    getRepoRoot,
    isRepoBackedCode,
    controlPlaneLayout,
    gitTry = defaultGitTry,
    fail,
  } = deps;

  function repoRootForRow(row) {
    if (typeof isRepoBackedCode === "function" && isRepoBackedCode(row?.Repo)) {
      return getRepoRoot(row.Repo);
    }
    if (row?.Repo === "X") {
      const layout = typeof controlPlaneLayout === "function"
        ? controlPlaneLayout()
        : (controlPlaneLayout || require("./control-plane-paths.js").defaultControlPlaneLayout());
      return layout?.coordRepoRoot || null;
    }
    return null;
  }

  function ensureGovernedWorkspaceForTicket({ ticketId, row, worktree, branch, base, stage }) {
    return ensureGovernedWorkspace({
      ticketId,
      repoCode: row?.Repo,
      worktree,
      branch,
      base,
      repoRoot: repoRootForRow(row),
      ensureTicketWorkspace,
      listGitWorktrees,
      gitTry,
      fail,
      stage,
    });
  }

  return { ensureGovernedWorkspaceForTicket, repoRootForRow };
}

module.exports = {
  createGovernedWorkspaceRecovery,
  describeFileType,
  resolveWorktreeToplevel,
  isOwnWorktreeToplevel,
  assertGovernedWorktreeIsolated,
  ensureGovernedWorkspace,
};
