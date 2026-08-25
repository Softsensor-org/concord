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
const {
  PUSH_STATUS,
  pushControlPlaneIntegrationBranch,
} = require("./control-plane-push.js");
// COORD-635 / ADR-0008: control-plane git resolves to coordRepoRoot, never to
// path.dirname(COORD_DIR). See control-plane-paths.js for the three roots.
const { createGovernedWorkspaceRecovery } = require("./governed-workspace-recovery.js");
const {
  defaultControlPlaneLayout,
  requireCoordRepoRoot,
  coordWorktreeRuntimeDir,
  significantWorktreeStatusEntries,
  resolveControlPlaneIntegrationBranch,
} = require("./control-plane-paths.js");

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

  // COORD-635: injectable so tests can drive a fixture topology; production
  // resolves the memoized engine layout.
  const controlPlaneLayout = () => (
    typeof deps.controlPlaneLayout === "function"
      ? deps.controlPlaneLayout()
      : (deps.controlPlaneLayout || defaultControlPlaneLayout())
  );

  // The ONLY control-plane git root. Fails closed with one actionable message
  // rather than silently resolving to the workspace container (ADR-0008).
  function coordRepoRoot(action) {
    return requireCoordRepoRoot(controlPlaneLayout(), fail, action);
  }

  function coordIntegrationBranch() {
    return resolveControlPlaneIntegrationBranch(controlPlaneLayout(), {
      configuredBranch: DEFAULT_PATHS.controlPlaneIntegrationBranch,
      gitTry,
    });
  }

  // COORD-635: governed workspace RECOVERY is built here because this factory
  // already owns every dependency it needs (ensureTicketWorkspace,
  // listGitWorktrees, the repo registry and the control-plane layout). Both
  // `return-doing` and `resume` consume this one instance, so recovery cannot
  // fork into two implementations.
  const { ensureGovernedWorkspaceForTicket } = createGovernedWorkspaceRecovery({
    ensureTicketWorkspace: (...args) => ensureTicketWorkspace(...args),
    listGitWorktrees: (...args) => listGitWorktrees(...args),
    getRepoRoot: (...args) => getRepoRoot(...args),
    isRepoBackedCode: (...args) => isRepoBackedCode(...args),
    controlPlaneLayout,
    fail,
  });

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
    // COORD-635: report the control-plane repository and each worktree's
    // REGISTRATION state, so `gov doctor` can say "control-plane state in
    // coord/" and distinguish a registered worktree (remove it through git)
    // from orphaned residue (a directory git no longer knows about).
    const layout = controlPlaneLayout();
    const registeredByPath = new Map();
    if (layout && layout.coordRepoRoot) {
      for (const entry of listGitWorktrees(layout.coordRepoRoot)) {
        registeredByPath.set(path.resolve(entry.path), entry.branch || null);
      }
    }
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
          const resolved = path.resolve(ticketPath);
          worktrees.push({
            owner,
            path: ticketPath,
            ticket: ticketId,
            status: row ? row.Status : null,
            registered: registeredByPath.has(resolved),
            branch: registeredByPath.get(resolved) || null,
          });
        }
      }
    }
  
    return {
      repo_root: root,
      control_plane_repo_root: (layout && layout.coordRepoRoot) || null,
      control_plane_topology: (layout && layout.topology) || null,
      // Registered in git but the directory is gone: an orphaned registration,
      // the residue class that used to require a manual `git worktree prune`.
      orphaned_registrations: [...registeredByPath.keys()]
        .filter((entry) => entry.startsWith(`${path.resolve(root)}${path.sep}`) && !fs.existsSync(entry)),
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
  
    // COORD-635: `cleanup-worktree` used to accept ONLY repo-backed codes, so
    // the single command operators are told to use refused the exact case that
    // produces residue — leaving the manual `git worktree remove` governance
    // otherwise forbids as the only remediation. "coord" / "X" now resolve to
    // the control-plane repository.
    const isControlPlane = isControlPlaneRepoArg(repoArg);
    const repoCode = isControlPlane ? "X" : repoCodeForCliRepoArg(repoArg);
    if (!repoCode) {
      fail(`cleanup-worktree repo must be one of: ${configuredRepoArgDescription()}, coord.`);
    }

    const repoRoot = isControlPlane
      ? coordRepoRoot("gov cleanup-worktree for a control-plane (coord) worktree")
      : getRepoRoot(repoCode);
    const worktrees = listGitWorktrees(repoRoot);
    let target = resolveCleanupTarget(worktrees, ticketOrPath);
    if (!target && isControlPlane) {
      // Unregistered control-plane residue (a directory left behind by an
      // older engine that deleted without deregistering) is still cleanable.
      const candidate = path.isAbsolute(ticketOrPath)
        ? path.resolve(ticketOrPath)
        : path.join(coordWorktreesRoot(), ticketOrPath);
      const scan = auditCoordWorktrees(new Map()).worktrees
        .find((entry) => path.resolve(entry.path) === candidate || entry.ticket === ticketOrPath);
      if (scan) {
        target = { path: scan.path, branch: null };
      }
    }
    if (!target) {
      fail(`Could not resolve worktree target "${ticketOrPath}" in ${repoRoot}.`);
    }
    if (path.resolve(target.path) === path.resolve(repoRoot)) {
      fail("Refusing to remove the repo root worktree.");
    }

    // Same governed removal as closeout: refuses a dirty worktree, deregisters
    // rather than deleting, and prunes orphaned registrations.
    const removed = removeGovernedWorktree({
      repoRoot,
      worktree: target.path,
      branch: target.branch,
      deleteBranch: options.deleteBranch,
      label: isControlPlane ? "Control-plane worktree" : "Worktree",
    });
    console.log(`Removed worktree ${removed.worktree}`);
    if (isControlPlane) {
      pruneEmptyParents(removed.worktree, coordWorktreesRoot());
    }
    if (options.deleteBranch && removed.branch) {
      console.log(`Deleted local branch ${removed.branch}`);
    }
  }

  // "coord" and "X" are the control-plane aliases. Kept next to the CLI verb so
  // the accepted vocabulary and the resolution live together.
  function isControlPlaneRepoArg(repoArg) {
    const normalized = String(repoArg || "").trim();
    return normalized === "X" || normalized.toLowerCase() === "coord";
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

  function ensureCoordGitWorktree({ worktree, branch, base }) {
    // COORD-635 defect (1): this used path.dirname(COORD_DIR) — the workspace
    // CONTAINER — so control-plane worktrees were cut from whatever repository
    // happened to own the parent directory. ADR-0008 makes coord/ the owner.
    const repoRoot = coordRepoRoot("gov start for a control-plane (Repo X) ticket");
    const worktrees = listGitWorktrees(repoRoot);
    const existingByPath = worktrees.find((entry) => entry.path === worktree);
    if (existingByPath) {
      ensureCoordWorktreeRuntime(worktree);
      return {
        createdWorktree: false,
        createdBranch: false,
        repoCode: "X",
        worktree,
        branch,
      };
    }
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const branchExists = gitTry(repoRoot, ["rev-parse", "--verify", branch], { stdio: "ignore" }).status === 0;
    if (branchExists) {
      runGit(repoRoot, ["worktree", "add", worktree, branch]);
      ensureCoordWorktreeRuntime(worktree);
      return {
        createdWorktree: true,
        createdBranch: false,
        repoCode: "X",
        worktree,
        branch,
      };
    }
    const baseRef = base && gitCommitishExists(repoRoot, base) ? base : "HEAD";
    runGit(repoRoot, ["worktree", "add", worktree, "-b", branch, baseRef]);
    ensureCoordWorktreeRuntime(worktree);
    return {
      createdWorktree: true,
      createdBranch: true,
      repoCode: "X",
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
      return ensureCoordGitWorktree({
        worktree,
        branch,
        base,
      });
    }
    fail(`Unsupported repo code "${repoCode}".`);
  }

  function ensureCoordWorktreeRuntime(worktree) {
    // COORD-635 defect (3): a worktree OF the coord repository mirrors
    // coordRepoRoot, so governance state sits at <worktree>/<coordPathPrefix>/
    // — "" in an adopter (coord/.git), "coord" in the donor. The old hardcoded
    // <worktree>/coord/.runtime was only ever right for the donor.
    const runtimeDir = coordWorktreeRuntimeDir(controlPlaneLayout(), worktree);
    for (const rel of [
      ".",
      "locks",
      "plans",
      "session-threads",
      "governance-snapshots",
      "identity",
    ]) {
      fs.mkdirSync(path.join(runtimeDir, rel), { recursive: true });
    }
    const gitignorePath = path.join(runtimeDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
    }
    const roleMarkerPath = path.join(runtimeDir, "runtime-role.json");
    if (!fs.existsSync(roleMarkerPath)) {
      fs.writeFileSync(roleMarkerPath, `${JSON.stringify({
        schema_version: 1,
        role: "ephemeral_worktree",
        authority: "non_authoritative_until_landed",
        canonical_write_path: "integration_tree_via_merge_queue",
      }, null, 2)}\n`, "utf8");
    }
    return runtimeDir;
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
      const repoRoot = coordRepoRoot("failed-start cleanup of a control-plane worktree");
      const current = listGitWorktrees(repoRoot).find((entry) => entry.path === prepared.worktree);
      if (current) {
        runGit(repoRoot, ["worktree", "remove", "--force", prepared.worktree]);
      } else {
        fs.rmSync(prepared.worktree, { recursive: true, force: true });
      }
      if (prepared.createdBranch) {
        const branchExists = gitTry(repoRoot, ["rev-parse", "--verify", prepared.branch], { stdio: "ignore" }).status === 0;
        if (branchExists) {
          runGit(repoRoot, ["branch", "-D", prepared.branch]);
        }
      }
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
    // COORD-635: a configured product-repo directory that is NOT itself a Git
    // repository makes `git -C <dir> worktree list` walk UP and answer for
    // whatever repository encloses it. That is how stale CONTROL-PLANE
    // worktrees were reported as backend/frontend state, sending the operator
    // to the wrong repository. Answer only for a directory that owns its own
    // repository; anything else audits as "not a repository", which is the
    // truthful finding.
    const toplevelProbe = gitTry(repoRoot, ["rev-parse", "--show-toplevel"]);
    const toplevel = toplevelProbe.status === 0 ? path.resolve(String(toplevelProbe.stdout || "").trim()) : null;
    if (toplevel !== path.resolve(repoRoot)) {
      return {
        repo_root: repoRoot,
        is_own_repository: false,
        enclosing_repository: toplevel,
        worktrees: [],
        review_ticket_worktrees: [],
        stale_ticket_worktrees: [],
        unknown_ticket_worktrees: [],
        helper_worktrees: [],
        missing_doing_worktrees: Array.from(ticketsById.values())
          .filter((row) => row.Repo === repoCode && row.Status.startsWith("doing"))
          .map((row) => row.ID),
      };
    }
    const controlPlaneWorktreesRoot = path.resolve(coordWorktreesRoot());
    const worktrees = listGitWorktrees(repoRoot);
    const ticketWorktrees = worktrees
      .filter((entry) => entry.path !== repoRoot)
      // Defence in depth for the donor layout, where coordRepoRoot and a
      // product repo can be the same repository: control-plane worktrees are
      // never product-repo state.
      .filter((entry) => !path.resolve(entry.path).startsWith(`${controlPlaneWorktreesRoot}${path.sep}`))
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
      is_own_repository: true,
      enclosing_repository: toplevel,
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
  
  function pushBranchToOrigin(cwd, branch, options = {}) {
    const commitSha = resolveCommitishInRepo(cwd, branch);
    if (!commitSha) {
      fail(`Could not resolve branch ${branch} before publishing it from ${cwd}.`);
    }
    const receipt = pushControlPlaneIntegrationBranch({
      repoRoot: cwd,
      branch,
      commitSha,
      remote: "origin",
      setUpstream: true,
      gitFn: options.gitFn,
    });
    if (typeof options.onReceipt === "function") {
      options.onReceipt(receipt);
    }
    if (receipt.status === PUSH_STATUS.NO_REMOTE) {
      fail(`Branch ${branch} cannot be published because ${cwd} has no origin remote.`);
    }
    if (receipt.status === PUSH_STATUS.FAILED) {
      fail(`git push origin ${branch}:${branch} did not publish ${commitSha} from ${cwd}: ${receipt.detail || "unknown failure"}.`);
    }
    return receipt;
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
      // COORD-697: all local comparison/argument checks above complete before
      // this irreversible action. The shared COORD-691 primitive classifies
      // remote state first, never forces, post-verifies lost acknowledgements,
      // and returns already_present on retry instead of pushing twice.
      const pushReceipt = pushBranchToOrigin(options.pushCwd || repoRoot, branch, {
        gitFn: options.gitFn,
        onReceipt: options.onPushReceipt,
      });
      return { localAhead, pushReceipt };
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
    return { localAhead, pushReceipt: null };
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

  // COORD-635: the ONE governed worktree removal. Every caller (successful
  // closeout, failed-start cleanup, `gov cleanup-worktree`) goes through it, so
  // the dirty-worktree refusal and the DEREGISTRATION cannot diverge again.
  //
  // Two properties this replaces four inconsistent copies of:
  //   - never discard uncommitted work: a dirty worktree is refused, never
  //     force-removed. `git worktree remove` (no --force) would also refuse,
  //     but with a git-dialect message; we check first so the operator is told
  //     which ticket and what to do.
  //   - deregister, do not delete: `fs.rmSync` on a registered worktree leaves
  //     an orphan registration behind, which is exactly the stale-worktree
  //     residue that had to be repaired by hand. We remove through git, then
  //     prune, and only fall back to a directory delete for a path git does
  //     not know about.
  function removeGovernedWorktree({ repoRoot, worktree, branch, deleteBranch, label }) {
    const target = path.resolve(worktree);
    const registered = listGitWorktrees(repoRoot).find((entry) => path.resolve(entry.path) === target);
    const describe = label || `worktree ${target}`;

    // The dirty-work refusal applies to a real worktree. A path that is not the
    // TOPLEVEL of its own worktree is plain residue with no git notion of
    // "dirty" — and asking `git status` there would answer for whatever
    // repository encloses it, producing a bogus refusal from unrelated state.
    const toplevelProbe = fs.existsSync(target) ? gitTry(target, ["rev-parse", "--show-toplevel"]) : null;
    const isOwnWorktree = Boolean(
      toplevelProbe &&
      toplevelProbe.status === 0 &&
      path.resolve(String(toplevelProbe.stdout || "").trim()) === target
    );

    if (fs.existsSync(target) && isOwnWorktree) {
      const statusResult = gitTry(target, ["status", "--porcelain"]);
      if (statusResult.status !== 0) {
        fail(`Could not verify worktree cleanliness for ${describe} in ${target}.`);
      }
      if (significantWorktreeStatusEntries(controlPlaneLayout(), target, statusResult.stdout).length > 0) {
        fail(
          `${describe} is dirty at ${target}. Cleanup refuses to discard uncommitted work. ` +
          `Commit it (coord/scripts/gov commit-ticket <ticket-id> -m "...") or discard it deliberately ` +
          `(git -C ${target} checkout -- . && git -C ${target} clean -fd), then retry.`
        );
      }
    }

    if (registered) {
      // Plain `git worktree remove` first — no --force. Git applies its own
      // modified/untracked check, which is a second, independent refusal.
      const removeResult = gitTry(repoRoot, ["worktree", "remove", target]);
      if (removeResult.status !== 0) {
        // Git also counts the engine's own ephemeral runtime scaffolding as
        // "modified or untracked". Escalating to --force is permitted ONLY
        // here, and only because the cleanliness check above has already
        // established that nothing outside the runtime directory differs — so
        // there is provably no work to discard. Any other difference reached
        // the refusal above and never gets here.
        const stillDirty = fs.existsSync(target)
          ? significantWorktreeStatusEntries(controlPlaneLayout(), target, gitTry(target, ["status", "--porcelain"]).stdout)
          : [];
        if (stillDirty.length > 0) {
          fail(
            `${describe} could not be removed from ${repoRoot}: ` +
            `${String(removeResult.stderr || "").trim() || "git worktree remove failed"}`
          );
        }
        runGit(repoRoot, ["worktree", "remove", "--force", target]);
      }
    } else if (fs.existsSync(target)) {
      // Unregistered residue: a plain directory git never knew about.
      fs.rmSync(target, { recursive: true, force: true });
    }
    // Prune any registration whose directory is already gone, so a previously
    // hand-deleted worktree does not keep haunting `git worktree list`.
    runGit(repoRoot, ["worktree", "prune"]);

    const resolvedBranch = branch || registered?.branch || null;
    if (deleteBranch && resolvedBranch) {
      const branchExists = gitTry(repoRoot, ["rev-parse", "--verify", resolvedBranch], { stdio: "ignore" }).status === 0;
      if (branchExists) {
        runGit(repoRoot, ["branch", "-D", resolvedBranch]);
      }
    }
    return { worktree: target, branch: resolvedBranch, deregistered: Boolean(registered) };
  }

  function cleanupTicketWorktree(ticketId, row, options = {}) {
    // COORD-635 defect (4): the old blanket `!isRepoBackedCode -> return null`
    // meant successful closeout of a control-plane ticket cleaned nothing.
    if (!isRepoBackedCode(row.Repo) && row.Repo !== "X") {
      return null;
    }

    const context = resolveTicketGitContext(row, ticketId);
    if (!context.worktree || !fs.existsSync(context.worktree) || context.worktree === context.repoRoot) {
      return null;
    }
    const repoRoot = context.repoRoot
      || (row.Repo === "X" ? coordRepoRoot(`closeout cleanup for control-plane ticket ${ticketId}`) : null);
    if (!repoRoot) {
      return null;
    }

    const removed = removeGovernedWorktree({
      repoRoot,
      worktree: context.worktree,
      branch: context.branch,
      deleteBranch: options.deleteBranch,
      label: `Ticket ${ticketId} worktree`,
    });
    if (row.Repo === "X") {
      pruneEmptyParents(removed.worktree, coordWorktreesRoot());
    }
    return {
      worktree: removed.worktree,
      branch: removed.branch,
    };
  }

  function cleanupCoordTicketWorktrees(ticketId) {
    const repoRoot = coordRepoRoot(`closeout cleanup for control-plane ticket ${ticketId}`);
    const worktrees = auditCoordWorktrees(new Map([[ticketId, { ID: ticketId, Status: STATUS.SUPERSEDED, Repo: "X" }]])).worktrees
      .filter((entry) => entry.ticket === ticketId);
    if (worktrees.length === 0) {
      return null;
    }
    const registered = listGitWorktrees(repoRoot);
    for (const entry of worktrees) {
      const match = registered.find((wt) => path.resolve(wt.path) === path.resolve(entry.path));
      removeGovernedWorktree({
        repoRoot,
        worktree: entry.path,
        branch: match?.branch || null,
        deleteBranch: false,
        label: `Ticket ${ticketId} control-plane worktree`,
      });
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
      // Prefer the lock/context-resolved worktree, then sweep any remaining
      // registered residue for the same ticket.
      const viaContext = cleanupTicketWorktree(ticketId, row, options);
      const viaAudit = cleanupCoordTicketWorktrees(ticketId);
      if (viaAudit) {
        return viaAudit;
      }
      return viaContext;
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
    removeGovernedWorktree, isControlPlaneRepoArg, coordRepoRoot, coordIntegrationBranch,
    ensureGovernedWorkspaceForTicket,
    controlPlaneLayout,
    buildDependencyBootstrapGuidance, repoBootstrapLabel, inferTicketIdFromPath,
    cleanupTicketWorktree, cleanupCoordTicketWorktrees, cleanupClosedTicketWorkspace,
    ensureCoordWorktreeRuntime,
  };
};
