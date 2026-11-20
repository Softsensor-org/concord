"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");

// guard:static-config-safety
function assertTargetConfigEnvironment(workspaceRoot) {
  const override = String(process.env.COORD_PROJECT_CONFIG || "").trim();
  if (!override) return;
  const requested = path.resolve(override);
  const target = path.join(workspaceRoot, "coord/project.config.js");
  let requestedReal;
  let targetReal;
  try {
    requestedReal = fs.realpathSync(requested);
    targetReal = fs.realpathSync(target);
  } catch (error) {
    throw new Error(`cannot validate COORD_PROJECT_CONFIG against the installed target: ${error.message}`);
  }
  if (requestedReal !== targetReal) {
    throw new Error(`refusing target lifecycle load: COORD_PROJECT_CONFIG resolves outside this installed workspace (${requestedReal})`);
  }
}

function createInstallerGovernance(coordRoot) {
  const workspaceRoot = path.resolve(coordRoot);
  assertTargetConfigEnvironment(workspaceRoot);
  const root = path.join(workspaceRoot, "coord");
  const lifecyclePath = resolveEngineModule(root, "scripts/lifecycle.js"); // COORD-873: engine copy, or a pre-873 install's legacy file
  const lifecycle = require(lifecyclePath).installerGovernance;
  if (!lifecycle || typeof lifecycle.buildSnapshot !== "function" || typeof lifecycle.ensureBaseline !== "function") {
    throw new Error("target lifecycle does not expose installer governance services");
  }

  function inspectJournal() {
    const events = lifecycle.readEventLog();
    const chain = lifecycle.verifyChain(events);
    const provenance = lifecycle.detectProvenanceDrift();
    const genesis = events.some((event) => event.command === "journal-baseline" && !!event.snapshot_digest);
    const snapshotMatches = !provenance.snapshotPruned || provenance.snapshotMatchesCurrent;
    const chainVerified = chain.ok === true && chain.chainedCount > 0 && chain.preChainCount === 0;
    const chainStatus = chainVerified ? "verified" : chain.ok === true ? "legacy-unverified" : "invalid";
    const clean = genesis && chain.ok === true && !provenance.uninitialized && snapshotMatches && (provenance.drift || []).length === 0;
    return clean
      ? { status: "ready", chain: chainStatus, chained_event_count: chain.chainedCount || 0, pre_chain_event_count: chain.preChainCount || 0, snapshot: "matches current governed bytes", event_count: events.length }
      : { status: "blocked", chain: chainStatus, chained_event_count: chain.chainedCount || 0, pre_chain_event_count: chain.preChainCount || 0, genesis, drift_paths: provenance.drift || [], snapshot_matches: snapshotMatches };
  }

  function createGenesisAnchor(authorize) {
    if (typeof authorize !== "function") throw new TypeError("installer genesis requires a transaction-owned authorization callback");
    let consumed = false;
    return function anchorInstalledWorkspaceJournalGenesis() {
      if (consumed) throw new Error("installer journal-genesis authority was already consumed");
      const before = lifecycle.readEventLog();
      // guard:journal-genesis
      if (before.length > 0) throw new Error("installer journal-genesis authority refuses an existing journal");
      const snapshot = lifecycle.buildSnapshot();
      const artifact = path.resolve(lifecycle.snapshotArtifactPath(snapshot.digest));
      const sidecars = [
        path.relative(workspaceRoot, artifact).split(path.sep).join("/"),
        "coord/.runtime/governance-events.ndjson",
        "coord/.runtime/governance-latest-snapshot.json",
      ];
      authorize(artifact, sidecars);
      consumed = true;
      const result = lifecycle.ensureBaseline("create-concord-reviewed-install");
      if (result !== true) throw new Error("target lifecycle refused to establish a fresh install journal baseline");
      const after = lifecycle.readEventLog();
      const chain = lifecycle.verifyChain(after);
      if (chain.ok !== true || chain.chainedCount < 1 || chain.preChainCount !== 0) {
        throw new Error("target lifecycle did not establish a verifiable chained journal genesis");
      }
      if (after[0]?.command !== "journal-baseline" || !fs.existsSync(artifact)) {
        throw new Error("target lifecycle did not persist the authorized journal genesis and snapshot");
      }
      return true;
    };
  }

  function inspectGit(plan, gitBootstrap, captureRootGitState, coordRepoRoot) {
    const coordGit = captureRootGitState(coordRepoRoot(workspaceRoot));
    if (coordGit.state === "established") return { status: "ready", state: coordGit.state, root: coordGit.root };
    return {
      status: "incomplete",
      state: coordGit.state,
      required_consent: "coord-only Git initialization, exact staging, and baseline commit",
      next_action: `Review a fresh plan with --git-init --git-ignore-block --git-stage --git-baseline-commit --git-scope coord for ${workspaceRoot}, then apply the matching digest and flags`,
      requested: !!gitBootstrap?.requested,
      baseline_commit_requested: !!plan.git_actions?.baseline_commit?.requested,
    };
  }

  function inspectRepoMapping(captureRootGitState, inside) {
    const projectConfig = path.join(workspaceRoot, "coord/project.config.js");
    try {
      const { readDeclaredConfig } = require(resolveEngineModule(root, "scripts/static-config-declaration.js"));
      const paths = require(path.join(root, "paths.js"));
      const declared = readDeclaredConfig(projectConfig);
      // guard:static-config-safety
      if (declared.status !== "declared") throw new Error(declared.message || `config declaration refused (${declared.status})`);
      const mapping = paths.validateProjectConfig(declared.declared).repos;
      const invalid = [];
      const realWorkspace = fs.realpathSync(workspaceRoot);
      const realCoordRoot = fs.realpathSync(root);
      for (const [code, repo] of Object.entries(mapping)) {
        const repoRoot = path.resolve(workspaceRoot, repo.path);
        if (!inside(workspaceRoot, repoRoot)) { invalid.push(`${code}: path escapes workspace`); continue; }
        if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) { invalid.push(`${code}: mapped sibling path is missing`); continue; }
        const realRepoRoot = fs.realpathSync(repoRoot);
        if (!inside(realWorkspace, realRepoRoot)) { invalid.push(`${code}: resolved repository path escapes workspace through a symlink`); continue; }
        if (inside(realCoordRoot, realRepoRoot) || inside(realRepoRoot, realCoordRoot)) {
          invalid.push(`${code}: mapped repository path overlaps the Concord control-plane root`);
          continue;
        }
        const git = captureRootGitState(repoRoot);
        if (git.root !== repoRoot || !["unborn", "established"].includes(git.state)) invalid.push(`${code}: mapped path is not an independent Git repository`);
      }
      if (invalid.length) return { status: "blocked", invalid, repo_codes: Object.keys(mapping).sort() };
      if (Object.keys(mapping).length === 0) {
        return {
          status: "pending_operator_decision",
          reason: "no sibling product repositories are mapped yet",
          next_action: "Choose sibling repository codes and paths with `coord/scripts/coord-cli.js init --wizard --dry-run`, apply the reviewed config with `--confirm`, then review `npm run concord -- onboard . --dry-run`.",
          repo_codes: [],
        };
      }
      return {
        status: "ready",
        repo_codes: Object.keys(mapping).sort(),
        validation: "declarative config validated; every mapped path resolves to an independent sibling Git repository",
      };
    } catch (error) {
      if (error.code === "ENOENT") return { status: "blocked", reason: "coord/project.config.js is missing" };
      return { status: "blocked", reason: `could not read project config: ${error.message}` };
    }
  }

  function inspectStarterConsistency(plan, repoMapping) {
    try {
      require(path.join(root, "board/board.js")).validateBoardState();
      const board = JSON.parse(fs.readFileSync(path.join(root, "board/tasks.json"), "utf8"));
      const rows = board.sections.flatMap((section) => section.rows || []);
      const ids = rows.map((row) => row.ID);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const starters = Array.from({ length: 9 }, (_, index) => `SETUP-${String(index + 1).padStart(3, "0")}`);
      const freshInstall = plan.install_genesis?.eligible === true;
      const requiredStarters = freshInstall ? starters : starters.filter((id) => ids.includes(id));
      const rowById = new Map(rows.map((row) => [row.ID, row]));
      const missingIds = requiredStarters.filter((id) => !rowById.has(id));
      const malformedStarterRows = requiredStarters.filter((id) => rowById.has(id) && rowById.get(id).Repo !== "X");
      const expectedPrompts = freshInstall ? require(resolveEngineModule(root, "scripts/coord-init-starter-board.js")).buildStarterPrompts() : null;
      const missingPrompts = requiredStarters.filter((id) => {
        const promptPath = path.join(root, "prompts/tickets", `${id}.md`);
        if (!fs.existsSync(promptPath)) return true;
        const prompt = fs.readFileSync(promptPath, "utf8");
        return expectedPrompts ? prompt !== expectedPrompts[id] : prompt.trim().length === 0;
      });
      const sampleIds = plan.install_mode === "workspace" && (plan.payload_surfaces?.classes_excluded || []).includes("product-sample")
        ? rows.filter((row) => /^SAMPLE-\d+$/.test(String(row.ID))).map((row) => row.ID)
        : [];
      const mappedCodes = new Set(["X", ...(Array.isArray(repoMapping.repo_codes) ? repoMapping.repo_codes : [])]);
      const unmappedStarterRepos = requiredStarters.filter((id) => rowById.has(id) && !mappedCodes.has(rowById.get(id).Repo));
      const blocked = missingIds.length || malformedStarterRows.length || missingPrompts.length || sampleIds.length || duplicateIds.length || unmappedStarterRepos.length;
      if (blocked) return { status: "blocked", missing_setup_rows: missingIds, malformed_setup_rows: malformedStarterRows, missing_or_stub_prompts: missingPrompts, duplicate_ids: duplicateIds, unmapped_setup_repos: unmappedStarterRepos, excluded_sample_rows: sampleIds };
      return { status: "ready", setup_rows_checked: requiredStarters.length, prompt_check: freshInstall ? "exact shipped starter assignment match" : "retained starter prompt files present", excluded_sample_rows: [] };
    } catch (error) {
      return { status: "blocked", reason: error.message };
    }
  }

  function inspectReadiness(plan, gitBootstrap, { captureRootGitState, coordRepoRoot, inside }) {
    let journal;
    try { journal = inspectJournal(); }
    catch (error) { journal = { status: "blocked", reason: error.code === "ENOENT" ? "missing" : `verification failed: ${error.message}` }; }
    const governanceGit = inspectGit(plan, gitBootstrap, captureRootGitState, coordRepoRoot);
    const repoMapping = inspectRepoMapping(captureRootGitState, inside);
    const starterConsistency = inspectStarterConsistency(plan, repoMapping);
    const checks = { journal, governance_git: governanceGit, repo_mapping: repoMapping, starter_consistency: starterConsistency };
    const hardBlockers = [journal, governanceGit, repoMapping, starterConsistency].some((entry) => entry.status === "blocked" || entry.status === "incomplete");
    const status = hardBlockers ? "incomplete"
      : repoMapping.status === "pending_operator_decision" ? "ready_with_operator_decision"
        : "ready";
    return {
      schema: "concord.install/readiness/v1",
      status,
      checks,
      git_bootstrap_requested: !!gitBootstrap?.requested,
      business_decisions_are_not_tool_failures: repoMapping.status === "pending_operator_decision",
    };
  }

  return Object.freeze({ inspectJournal, createGenesisAnchor, inspectReadiness });
}

module.exports = { assertTargetConfigEnvironment, createInstallerGovernance };
