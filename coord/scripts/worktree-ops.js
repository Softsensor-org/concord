"use strict";

// B3 decomposition slice: git + worktree lifecycle extracted from lifecycle.js.
// Covers git primitives (runGit/gitOutput/ref+ancestry checks), worktree
// create/cleanup/audit, branch preflight/push, and their worktree-specific
// helpers. Factory-injected for repo-registry, board, plan-record, and session
// accessors; shared state/paths come from governance-context.

const fs = require("fs");
const path = require("path");
const { GovernanceError, defaultFail, COORD_DIR, DEFAULT_PATHS, state } = require("./governance-context.js");
const { gitTry, runGit: sharedRunGit, gitOutput: sharedGitOutput } = require("./git-ops.js");

const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const { STATUS } = require("./governance-constants.js");
const REPO_ROOTS = DEFAULT_PATHS.repoRoots;
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};
// COORD-125: configurable start-base seam. Per-repo `startBaseRef` and the
// project-wide `defaultStartBaseRef` let a project branch new governed work off
// an explicit base (e.g. "main") instead of always the repo's integrationBranch.
// `REPO_START_BASE_REFS` is the shared (in-place mutable) per-repo map; the
// project-wide fallback is read LIVE off the shared DEFAULT_PATHS object so the
// __testing facade can override it (DEFAULT_PATHS is a shared reference).
const REPO_START_BASE_REFS = DEFAULT_PATHS.repoStartBaseRefs || {};
// Bounded fetch so a hung/offline remote can't make `gov start` hang forever.
// Overridable for tests via COORD_START_FETCH_TIMEOUT_MS; 0/invalid disables.
const START_FETCH_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.COORD_START_FETCH_TIMEOUT_MS || "").trim(), 10);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return 20000;
})();

module.exports = function createWorktreeOps(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    configuredRepoArgDescription,
    getRepoRoot,
    getRows,
    rowsById,
    isDoingStatus,
    isRepoBackedCode,
    readBoard,
    readPlanRecord,
    repoCodeForCliRepoArg,
    repoNameForCode,
    // resolveTicketGitContext lives in lifecycle.js (it depends on lifecycle's
    // lock registry) and is injected as a deferred wrapper for the closed-ticket
    // workspace-cleanup functions below.
    resolveTicketGitContext,
  } = deps;

  function resolveCommitishInRepo(repoRoot, commitish) {
    const normalized = String(commitish || "").trim();
    if (!normalized) {
      return null;
    }
    const result = gitTry(repoRoot, ["rev-parse", "--verify", `${normalized}^{commit}`]);
    if (result.status !== 0) {
      return null;
    }
    return String(result.stdout || "").trim() || null;
  }
  
  function fetchRepoRef(repoRoot, refName, options = {}) {
    const normalized = String(refName || "").trim();
    if (!normalized) {
      return false;
    }
    const remoteRef = normalized.startsWith("origin/") ? normalized.slice("origin/".length) : normalized;
    // COORD-125: bound the fetch so an unreachable/hung remote cannot make
    // `gov start` hang. A timeout/non-zero exit is reported as "not fetched"
    // and the caller decides whether a local-base fallback is safe.
    const gitOptions = {};
    const timeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs")
      ? options.timeoutMs
      : START_FETCH_TIMEOUT_MS;
    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      gitOptions.timeout = timeoutMs;
      gitOptions.killSignal = "SIGKILL";
    }
    const result = gitTry(repoRoot, ["fetch", "origin", remoteRef], gitOptions);
    return result.status === 0;
  }
  
  function isCommitAncestorOfRef(repoRoot, commitSha, refName) {
    const result = gitTry(repoRoot, ["merge-base", "--is-ancestor", commitSha, refName]);
    return result.status === 0;
  }
  
  function gitPathExistsAtRef(repoRoot, refName, filePath) {
    const result = gitTry(repoRoot, ["cat-file", "-e", `${refName}:${filePath}`]);
    return result.status === 0;
  }
  
  function auditWorktrees() {
    const board = readBoard();
    const ticketsById = rowsById(board);
    const report = {};
    for (const repoCode of Object.keys(REPO_ROOTS).filter((code) => code !== "X").sort()) {
      report[repoNameForCode(repoCode)] = auditRepoWorktrees(repoCode, ticketsById);
    }
    report.coord = auditCoordWorktrees(ticketsById);
    console.log(JSON.stringify(report, null, 2));
  }
  
  function coordWorktreesRoot() {
    return path.join(path.dirname(state.QUESTIONS_PATH), ".worktrees");
  }
  
  function auditCoordWorktrees(ticketsById) {
    const root = coordWorktreesRoot();
    const worktrees = [];
    if (fs.existsSync(root)) {
      for (const owner of fs.readdirSync(root)) {
        const ownerDir = path.join(root, owner);
        if (!fs.statSync(ownerDir).isDirectory()) {
          continue;
        }
        for (const ticketEntry of fs.readdirSync(ownerDir)) {
          const ticketPath = path.join(ownerDir, ticketEntry);
          if (!fs.statSync(ticketPath).isDirectory()) {
            continue;
          }
          const ticketId = inferTicketIdFromPath(ticketPath);
          if (!ticketId) {
            continue;
          }
          const row = ticketsById.get(ticketId) || null;
          worktrees.push({
            owner,
            path: ticketPath,
            ticket: ticketId,
            status: row ? row.Status : null,
          });
        }
      }
    }
  
    return {
      repo_root: root,
      worktrees,
      stale_worktrees: worktrees.filter((entry) => entry.status && !isDoingStatus(entry.status) && entry.status !== STATUS.REVIEW),
      unknown_ticket_worktrees: worktrees.filter((entry) => !entry.status),
      missing_doing_worktrees: Array.from(ticketsById.values())
        .filter((row) => row.Repo === "X" && isDoingStatus(row.Status))
        .filter((row) => !worktrees.some((entry) => entry.ticket === row.ID))
        .map((row) => row.ID),
    };
  }
  
  function pruneEmptyParents(startPath, stopPath) {
    let current = path.dirname(startPath);
    while (current.startsWith(stopPath) && current !== stopPath) {
      if (!fs.existsSync(current)) {
        current = path.dirname(current);
        continue;
      }
      const entries = fs.readdirSync(current);
      if (entries.length > 0) {
        break;
      }
      fs.rmdirSync(current);
      current = path.dirname(current);
    }
  }
  
  function cleanupWorktree(repoArg, ticketOrPath, options) {
    if (!repoArg || !ticketOrPath) {
      fail("cleanup-worktree requires <repo-code|repo-name> <ticket-id|path>.");
    }
    if (!options.yes) {
      fail("cleanup-worktree is destructive; rerun with --yes.");
    }
  
    const repoCode = repoCodeForCliRepoArg(repoArg);
    if (!repoCode) {
      fail(`cleanup-worktree repo must be one of: ${configuredRepoArgDescription()}.`);
    }
  
    const repoRoot = getRepoRoot(repoCode);
    const worktrees = listGitWorktrees(repoRoot);
    const target = resolveCleanupTarget(worktrees, ticketOrPath);
    if (!target) {
      fail(`Could not resolve worktree target "${ticketOrPath}" in ${repoRoot}.`);
    }
    if (target.path === repoRoot) {
      fail("Refusing to remove the repo root worktree.");
    }
  
    runGit(repoRoot, ["worktree", "remove", "--force", target.path]);
    console.log(`Removed worktree ${target.path}`);
  
    if (options.deleteBranch && target.branch) {
      runGit(repoRoot, ["branch", "-D", target.branch]);
      console.log(`Deleted local branch ${target.branch}`);
    }
  }
  
  function cleanupHelperWorktrees(repoArg, options) {
    if (!repoArg) {
      fail("cleanup-helpers requires <repo-code|repo-name>.");
    }
    if (!options.yes) {
      fail("cleanup-helpers is destructive; rerun with --yes.");
    }
  
    const repoCode = repoCodeForCliRepoArg(repoArg);
    if (!repoCode) {
      fail(`cleanup-helpers repo must be one of: ${configuredRepoArgDescription()}.`);
    }
  
    const audit = auditRepoWorktrees(repoCode, rowsById(readBoard()));
    if (audit.helper_worktrees.length === 0) {
      console.log(`No helper worktrees found in ${audit.repo_root}.`);
      return;
    }
  
    for (const helper of audit.helper_worktrees) {
      runGit(audit.repo_root, ["worktree", "remove", "--force", helper.path]);
      console.log(`Removed helper worktree ${helper.path}`);
      if (options.deleteBranch && helper.branch) {
        runGit(audit.repo_root, ["branch", "-D", helper.branch]);
        console.log(`Deleted local branch ${helper.branch}`);
      }
    }
  }
  
  function resolveTicketBaseRef(ticketId, row, options = {}) {
    const explicit = Object.prototype.hasOwnProperty.call(options, "base")
      ? options.base
      : options.baseRef;
    if (explicit !== undefined && explicit !== null) {
      const trimmed = String(explicit).trim();
      if (trimmed) {
        return trimmed;
      }
    }
    if (ticketId) {
      try {
        const record = readPlanRecord(ticketId, { allowMissing: true });
        const planBaseRef = String(record?.governance?.expected_closeout?.base_ref || "").trim();
        if (planBaseRef) {
          return planBaseRef;
        }
      } catch {
        // fall through to registry / fallback
      }
    }
    if (row?.Repo) {
      // COORD-125 precedence: per-repo startBaseRef > global defaultStartBaseRef
      // > per-repo integrationBranch > engine default ("dev").
      const repoStartBaseRef = REPO_START_BASE_REFS[row.Repo];
      if (repoStartBaseRef) {
        const trimmed = String(repoStartBaseRef).trim();
        if (trimmed) {
          return trimmed;
        }
      }
      const globalDefault = DEFAULT_PATHS.defaultStartBaseRef;
      if (globalDefault) {
        const trimmed = String(globalDefault).trim();
        if (trimmed) {
          return trimmed;
        }
      }
      const registryDefault = REPO_INTEGRATION_BRANCHES[row.Repo];
      if (registryDefault) {
        const trimmed = String(registryDefault).trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
    return "dev";
  }
  
  function gitCommitishExists(repoRoot, refName) {
    return gitTry(repoRoot, ["rev-parse", "--verify", `${refName}^{commit}`], { stdio: "ignore" }).status === 0;
  }
  
  function repoBootstrapLabel(repoCode) {
    if (repoCode === "X") {
      return "coord";
    }
    if (!isRepoBackedCode(repoCode)) {
      return "coord";
    }
    return repoNameForCode(repoCode);
  }
  
  function buildDependencyBootstrapGuidance(repoCode, worktree = null) {
    if (!isRepoBackedCode(repoCode)) {
      return null;
    }
    const repoLabel = repoBootstrapLabel(repoCode);
    const installRoot = worktree || repoLabel;
    const baseRef = REPO_INTEGRATION_BRANCHES[repoCode] || DEFAULT_INTEGRATION_BRANCH;
    return {
      base_ref: baseRef,
      commands: [
        `git -C ${repoLabel} fetch origin ${baseRef}`,
        `pnpm --dir ${installRoot} install --frozen-lockfile`,
      ],
    };
  }
  
  function formatMissingStartBaseRefMessage(repoCode, repoRoot, baseRef) {
    const guidance = buildDependencyBootstrapGuidance(repoCode);
    const refreshCommand = guidance?.commands?.[0] || `git -C ${repoRoot} fetch origin ${baseRef}`;
    const installCommand = guidance?.commands?.[1] || null;
    return [
      `Cannot create governed ${repoBootstrapLabel(repoCode)} worktree from ${baseRef}: ${baseRef} is missing in ${repoRoot}.`,
      `Refresh the canonical base first: ${refreshCommand}`,
      installCommand ? `After the worktree is created, bootstrap dependencies reproducibly with: ${installCommand}` : null,
      "Then rerun the same gov start or return-doing command.",
    ].filter(Boolean).join("\n");
  }
  
  function ensureGitWorktree({ repoCode, worktree, branch, base }) {
    const repoRoot = getRepoRoot(repoCode);
    const baseRef = base || REPO_INTEGRATION_BRANCHES[repoCode] || DEFAULT_INTEGRATION_BRANCH;
    const worktrees = listGitWorktrees(repoRoot);
    const existingByPath = worktrees.find((entry) => entry.path === worktree);
    if (existingByPath) {
      return {
        createdWorktree: false,
        createdBranch: false,
        repoCode,
        worktree,
        branch,
      };
    }
  
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const branchExists = gitTry(repoRoot, ["rev-parse", "--verify", branch], { stdio: "ignore" }).status === 0;
  
    if (branchExists) {
      // Existing ticket branch: reuse as-is (do not re-base in-flight work).
      runGit(repoRoot, ["worktree", "add", worktree, branch]);
    } else {
      // GCV-2 + COORD-125: a new governed branch is cut from the authoritative
      // remote (origin/<baseRef>) so new work never starts off a stale local
      // checkout (the old local `baseRef` path produced stale bases when local
      // `dev` lagged origin/dev — FE-385/FE-386). The resolved baseRef itself
      // is config-aware (per-repo startBaseRef > defaultStartBaseRef >
      // integrationBranch); see resolveTicketBaseRef.
      //
      // Freshness: we attempt a BOUNDED fetch of origin/<baseRef> first. When
      // the fetch SUCCEEDS we branch from the freshened origin/<baseRef>.
      //
      // Offline/unreachable fallback: when the fetch FAILS (network down,
      // remote missing, auth lost, or no remote configured at all), we do NOT
      // hard-fail a local/offline workflow. Instead we fall back to a LOCAL
      // base ref with a clear warning, preferring a pre-existing local
      // origin/<baseRef> tracking ref, then the local <baseRef> branch. Only
      // when NEITHER resolves do we fail closed (there is genuinely no base).
      const remoteBaseRef = `origin/${String(baseRef).replace(/^origin\//, "")}`;
      const fetched = fetchRepoRef(repoRoot, baseRef);
      let cutFrom = remoteBaseRef;
      if (!fetched) {
        const localFallback = gitCommitishExists(repoRoot, remoteBaseRef)
          ? remoteBaseRef
          : (gitCommitishExists(repoRoot, baseRef) ? baseRef : null);
        if (!localFallback) {
          fail(formatMissingStartBaseRefMessage(repoCode, repoRoot, baseRef));
        }
        cutFrom = localFallback;
        console.warn(
          `[gov start] WARNING: could not fetch origin ${baseRef} in ${repoRoot} ` +
          `(remote unreachable/offline). Branching from the LOCAL base ` +
          `${localFallback}, which may be stale vs origin. When back online, ` +
          `refresh with \`git -C ${repoRoot} fetch origin ${baseRef}\` and rebase ` +
          `this worktree onto origin/${baseRef.replace(/^origin\//, "")} if needed.`
        );
      } else if (!gitCommitishExists(repoRoot, remoteBaseRef)) {
        fail(formatMissingStartBaseRefMessage(repoCode, repoRoot, remoteBaseRef));
      }
      runGit(repoRoot, ["worktree", "add", worktree, "-b", branch, cutFrom]);
    }
    return {
      createdWorktree: true,
      createdBranch: !branchExists,
      repoCode,
      worktree,
      branch,
    };
  }
  
  function ensureTicketWorkspace({ repoCode, worktree, branch, base }) {
    if (isRepoBackedCode(repoCode)) {
      return ensureGitWorktree({
        repoCode,
        worktree,
        branch,
        base,
      });
    }
    if (repoCode === "X") {
      const existed = fs.existsSync(worktree);
      fs.mkdirSync(worktree, { recursive: true });
      return {
        createdWorktree: !existed,
        createdBranch: false,
        repoCode,
        worktree,
        branch,
      };
    }
    fail(`Unsupported repo code "${repoCode}".`);
  }
  
  function cleanupPreparedTicketWorkspace(prepared) {
    if (!prepared?.createdWorktree) {
      return;
    }
    if (isRepoBackedCode(prepared.repoCode)) {
      const repoRoot = getRepoRoot(prepared.repoCode);
      const current = listGitWorktrees(repoRoot).find((entry) => entry.path === prepared.worktree);
      if (current) {
        runGit(repoRoot, ["worktree", "remove", "--force", prepared.worktree]);
      }
      if (prepared.createdBranch) {
        const branchExists = gitTry(repoRoot, ["rev-parse", "--verify", prepared.branch], { stdio: "ignore" }).status === 0;
        if (branchExists) {
          runGit(repoRoot, ["branch", "-D", prepared.branch]);
        }
      }
      return;
    }
    if (prepared.repoCode === "X" && fs.existsSync(prepared.worktree)) {
      fs.rmSync(prepared.worktree, { recursive: true, force: true });
      pruneEmptyParents(prepared.worktree, coordWorktreesRoot());
    }
  }
  
  function withPreparedTicketWorkspace(options, fn) {
    const prepared = ensureTicketWorkspace(options);
    try {
      return fn(prepared);
    } catch (error) {
      if (!prepared.createdWorktree) {
        throw error;
      }
      try {
        cleanupPreparedTicketWorkspace(prepared);
      } catch (cleanupError) {
        const message =
          `${error?.message || String(error)}\n` +
          `Prepared worktree cleanup failed: ${cleanupError?.message || String(cleanupError)}`;
        if (error instanceof GovernanceError) {
          error.message = message;
          throw error;
        }
        throw new GovernanceError(message);
      }
      throw error;
    }
  }
  
  function auditRepoWorktrees(repoCode, ticketsById) {
    const repoRoot = getRepoRoot(repoCode);
    const worktrees = listGitWorktrees(repoRoot);
    const ticketWorktrees = worktrees
      .filter((entry) => entry.path !== repoRoot)
      .map((entry) => {
        const ticketId = inferTicketIdFromPath(entry.path);
        const row = ticketId ? ticketsById.get(ticketId) : null;
        return {
          path: entry.path,
          branch: entry.branch,
          ticket: ticketId,
          status: row ? row.Status : null,
          owner: row ? row.Owner : null,
          helper: isHelperWorktree(entry),
        };
      });
  
    const review = ticketWorktrees.filter(
      (entry) => entry.ticket && entry.status === STATUS.REVIEW
    );
    const stale = ticketWorktrees.filter(
      (entry) => entry.ticket
        && entry.status
        && entry.status !== STATUS.REVIEW
        && !entry.status.startsWith("doing")
    );
    const unknown = ticketWorktrees.filter((entry) => entry.ticket && !entry.status);
    const helper = ticketWorktrees.filter((entry) => entry.helper);
  
    const missingDoing = Array.from(ticketsById.values())
      .filter((row) => row.Repo === repoCode && row.Status.startsWith("doing"))
      .filter((row) => !ticketWorktrees.some((entry) => entry.ticket === row.ID));
  
    return {
      repo_root: repoRoot,
      worktrees: ticketWorktrees,
      review_ticket_worktrees: review,
      stale_ticket_worktrees: stale,
      unknown_ticket_worktrees: unknown,
      helper_worktrees: helper,
      missing_doing_worktrees: missingDoing.map((row) => row.ID),
    };
  }
  
  function listGitWorktrees(repoRoot) {
    const result = gitTry(repoRoot, ["worktree", "list", "--porcelain"]);
    if (result.status !== 0) {
      fail(result.stderr || `Failed to list worktrees for ${repoRoot}.`);
    }
  
    const blocks = result.stdout.trim().split(/\n\s*\n/).filter(Boolean);
    return blocks.map((block) => {
      const entry = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          entry.path = line.slice("worktree ".length).trim();
        } else if (line.startsWith("branch refs/heads/")) {
          entry.branch = line.slice("branch refs/heads/".length).trim();
        } else if (line.startsWith("detached")) {
          entry.branch = null;
        }
      }
      return entry;
    });
  }
  
  function resolveCleanupTarget(worktrees, ticketOrPath) {
    if (path.isAbsolute(ticketOrPath)) {
      return worktrees.find((entry) => entry.path === ticketOrPath) || null;
    }
  
    const matches = worktrees.filter((entry) => inferTicketIdFromPath(entry.path) === ticketOrPath);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      fail(`Multiple worktrees matched ticket ${ticketOrPath}; use an absolute path instead.`);
    }
    return worktrees.find((entry) => path.basename(entry.path) === ticketOrPath) || null;
  }
  
  function isHelperWorktree(entry) {
    const base = path.basename(entry.path);
    if (entry.path.startsWith("/tmp/")) {
      return true;
    }
    if (/^(CLOSE-|merge-)/.test(base)) {
      return true;
    }
    if (base.includes("-backend") || base.includes("-frontend") || base.includes("-pr")) {
      return true;
    }
    if (entry.branch && (/^tmp\//.test(entry.branch) || /-pr$/.test(entry.branch))) {
      return true;
    }
    return false;
  }
  
  function gitRefExists(repoRoot, refName) {
    return Boolean(resolveCommitishInRepo(repoRoot, refName));
  }
  
  function gitRemoteBranchExists(repoRoot, branch) {
    const result = gitTry(repoRoot, ["ls-remote", "--exit-code", "--heads", "origin", branch]);
    return result.status === 0;
  }
  
  function countCommitsAhead(repoRoot, baseRef, branchRef) {
    const result = gitTry(repoRoot, ["rev-list", "--count", `${baseRef}..${branchRef}`]);
    if (result.status !== 0) {
      return null;
    }
    const count = parseInt(String(result.stdout || "").trim(), 10);
    return Number.isInteger(count) ? count : null;
  }
  
  function assertCommitAheadCount(count, repoRoot, baseRef, branchRef) {
    if (count !== null) {
      return count;
    }
    fail(
      `Failed to compare ${branchRef} against ${baseRef} in ${repoRoot}. ` +
      "Refresh refs or verify the branch/base names before creating a PR."
    );
  }
  
  function pushBranchToOrigin(cwd, branch) {
    const result = gitTry(cwd, ["push", "-u", "origin", branch], { stdio: "inherit" });
    if (result.status !== 0) {
      fail(`git push -u origin ${branch} failed in ${cwd}.`);
    }
  }
  
  function preflightPrBranch(repoRoot, branch, baseRef, options = {}) {
    const remoteBaseRef = gitRefExists(repoRoot, `origin/${baseRef}`) ? `origin/${baseRef}` : baseRef;
    const localAhead = assertCommitAheadCount(
      countCommitsAhead(repoRoot, remoteBaseRef, branch),
      repoRoot,
      remoteBaseRef,
      branch
    );
    if (localAhead === 0) {
      fail(`Branch ${branch} has no commits ahead of ${remoteBaseRef}. Push is unnecessary and PR creation would fail.`);
    }
    if (options.push && localAhead && localAhead > 0) {
      pushBranchToOrigin(options.pushCwd || repoRoot, branch);
    }
    if (!gitRemoteBranchExists(repoRoot, branch)) {
      fail(
        `Branch ${branch} is not published on origin. ` +
        `Run \`git -C ${repoRoot} push -u origin ${branch}\` or pass \`--push\` to pr-create/submit.`
      );
    }
    const remoteAhead = assertCommitAheadCount(
      countCommitsAhead(repoRoot, remoteBaseRef, `origin/${branch}`),
      repoRoot,
      remoteBaseRef,
      `origin/${branch}`
    );
    if (remoteAhead === 0) {
      fail(
        `Branch origin/${branch} has no commits ahead of ${remoteBaseRef}. ` +
        `PR creation would fail with "No commits between" / "Head sha can't be blank".`
      );
    }
  }
  
  function isInsideGitWorkTree(dir) {
    const result = gitTry(dir, ["rev-parse", "--is-inside-work-tree"]);
    return result.status === 0 && String(result.stdout || "").trim() === "true";
  }
  
  // COORD-072: thin closures over the shared git-ops wrappers (single-sourced
  // invocation + generic-message policy), binding this factory's fail thunk.
  function runGit(repoRoot, args) {
    return sharedRunGit(fail, repoRoot, args);
  }

  function gitOutput(repoRoot, args) {
    return sharedGitOutput(fail, repoRoot, args);
  }
  
  function defaultWorktreePath(repoCode, owner, ticketId) {
    if (repoCode === "X") {
      return path.join(COORD_DIR, ".worktrees", owner, ticketId);
    }
    return path.join(getRepoRoot(repoCode), ".worktrees", owner, ticketId);
  }
  
  function inferTicketIdFromPath(worktreePath) {
    const parts = worktreePath.split(path.sep).filter(Boolean);
    for (const part of parts.reverse()) {
      if (/^[A-Z]+-\d+$/.test(part)) {
        return part;
      }
    }
    return null;
  }

  function cleanupTicketWorktree(ticketId, row, options = {}) {
    if (!isRepoBackedCode(row.Repo)) {
      return null;
    }

    const context = resolveTicketGitContext(row, ticketId);
    if (!context.worktree || !fs.existsSync(context.worktree) || context.worktree === context.repoRoot) {
      return null;
    }

    const statusResult = gitTry(context.worktree, ["status", "--porcelain"]);
    if (statusResult.status !== 0) {
      fail(`Could not verify worktree cleanliness for ${ticketId} in ${context.worktree}.`);
    }
    if (String(statusResult.stdout || "").trim()) {
      fail(`Ticket ${ticketId} worktree ${context.worktree} is dirty. Clean or commit it before closeout; done now requires worktree removal.`);
    }

    runGit(context.repoRoot, ["worktree", "remove", context.worktree]);
    if (options.deleteBranch && context.branch) {
      runGit(context.repoRoot, ["branch", "-D", context.branch]);
    }
    return {
      worktree: context.worktree,
      branch: context.branch || null,
    };
  }

  function cleanupCoordTicketWorktrees(ticketId) {
    const worktrees = auditCoordWorktrees(new Map([[ticketId, { ID: ticketId, Status: STATUS.SUPERSEDED, Repo: "X" }]])).worktrees
      .filter((entry) => entry.ticket === ticketId);
    if (worktrees.length === 0) {
      return null;
    }
    for (const entry of worktrees) {
      fs.rmSync(entry.path, { recursive: true, force: true });
      pruneEmptyParents(entry.path, coordWorktreesRoot());
    }
    return {
      removed_worktrees: worktrees.map((entry) => entry.path),
    };
  }

  function cleanupClosedTicketWorkspace(ticketId, row, options = {}) {
    if (isRepoBackedCode(row.Repo)) {
      return cleanupTicketWorktree(ticketId, row, options);
    }
    if (row.Repo === "X") {
      return cleanupCoordTicketWorktrees(ticketId);
    }
    return null;
  }
  return {
    resolveCommitishInRepo, fetchRepoRef, isCommitAncestorOfRef, gitPathExistsAtRef,
    auditWorktrees, auditCoordWorktrees, cleanupWorktree, cleanupHelperWorktrees,
    resolveTicketBaseRef, gitCommitishExists, ensureGitWorktree, ensureTicketWorkspace,
    cleanupPreparedTicketWorkspace, withPreparedTicketWorkspace, auditRepoWorktrees,
    listGitWorktrees, resolveCleanupTarget, isHelperWorktree, gitRefExists,
    gitRemoteBranchExists, countCommitsAhead, assertCommitAheadCount, pushBranchToOrigin,
    preflightPrBranch, isInsideGitWorkTree, runGit, gitOutput, defaultWorktreePath,
    coordWorktreesRoot, pruneEmptyParents, formatMissingStartBaseRefMessage,
    buildDependencyBootstrapGuidance, repoBootstrapLabel, inferTicketIdFromPath,
    cleanupTicketWorktree, cleanupCoordTicketWorktrees, cleanupClosedTicketWorkspace,
  };
};
