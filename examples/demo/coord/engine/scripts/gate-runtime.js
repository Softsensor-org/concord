"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

// Wave 2 (COORD-058): gate runtime extracted from lifecycle.js — gate script /
// invocation / artifact-dir resolution, package-manager detection, and the
// clean-checkout gate runner. DI-factory; repo resolution injected.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawnSync } = require("child_process");
// COORD-909: product test and gate children never inherit agent or session identity.
// Only the child copy is scrubbed; this process keeps its identity to record the gate.
const { scrubIdentityEnv } = require("./agent-identity-env.js");
const { gitTry } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/git-ops.js"));
const { GovernanceError, defaultFail, COORD_DIR, ROOT_DIR } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const { GATE_LANES, gateLaneSet } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-constants.js"));
const {
  validateGateArtifact,
  formatCompletenessSummary,
} = require("./gate-artifact-schema.js");
const runManifest = require("./run-manifest.js");

// COORD-093: defensive clamp for the gate artifact `duration_ms`. The COORD-080
// completeness schema requires duration_ms to be a finite, non-negative number.
// A monotonic measurement should never be negative, but we clamp regardless so a
// bad runner-supplied value (NaN, negative from a backward wall-clock step, a
// non-number) can never fail the schema: NaN/non-finite/non-number -> null
// (honestly "no duration"), negative -> 0, otherwise the value unchanged.
function clampDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}

function reconcileGateReceipt({ requestedLane, exitCode, artifactLane, artifactResult, artifactStatus, trackedContentChanged }) {
  const contradictions = [];
  if (exitCode !== 0 && artifactResult === "pass") contradictions.push("receipt_passed_observed_process_failed");
  if (exitCode !== 0 && artifactStatus === "pass") contradictions.push("status_passed_observed_process_failed");
  if (artifactLane && artifactLane !== requestedLane) contradictions.push("receipt_lane_mismatch");
  if (trackedContentChanged) contradictions.push("tracked_content_changed_after_run");
  return {
    contradictions,
    status: contradictions.length ? "contradictory" : "authoritative",
    result: contradictions.length ? "fail" : (artifactResult || (exitCode === 0 ? "pass" : "fail")),
  };
}

function buildEvidenceIsolation({ repoRoot, checkoutPath }) {
  const root = path.resolve(repoRoot);
  const checkout = path.resolve(checkoutPath);
  const relative = path.relative(root, checkout);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new GovernanceError("Gate evidence isolation cannot be proven: disposable checkout is inside the source repository.");
  }
  return {
    contract: "disposable-exact-commit",
    checkout_root: checkout,
    scanned_paths: [checkout],
    excluded_paths: [path.join(root, ".worktrees")],
    sibling_worktrees_excluded: true,
  };
}

// COORD-909: the environment every product install and gate child receives: a copy of the
// given env minus identity (provider-complete list, shared with the coord runner). Credentials,
// proxy/network, PATH and toolchain variables pass through unchanged.
function productChildEnv(env = process.env) {
  return scrubIdentityEnv(env);
}

module.exports = function createGateRuntime(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    configuredRepoArgDescription,
    getRepoRoot,
    repoCodeForCliRepoArg,
    repoDisplayNameForCode,
    readJsonFileFromRef,
  } = deps;

  function readPackageScripts(repoRoot, refName = null) {
    let packageJson = null;
    if (refName) {
      packageJson = readJsonFileFromRef(repoRoot, refName, "package.json");
    } else {
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      } catch {
        packageJson = null;
      }
    }
    return packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
      ? packageJson.scripts
      : {};
  }
  
  function resolveGateScript(repoRoot, lane, source, branch = "dev") {
    const scripts = readPackageScripts(repoRoot, branch);
    const candidate = source === "local" ? `gate:${lane}` : `gate:${lane}:${source}`;
    if (Object.prototype.hasOwnProperty.call(scripts, candidate)) {
      return candidate;
    }
    if (source === "ci" && Object.prototype.hasOwnProperty.call(scripts, `gate:${lane}`)) {
      return `gate:${lane}`;
    }
    const supported = Object.keys(scripts)
      .filter((name) => name === `gate:${lane}` || name.startsWith(`gate:${lane}:`))
      .sort();
    fail(
      `Repo gate lane/source combination is unsupported: lane=${lane}, source=${source}. ` +
      `Expected script "${candidate}" in package.json. ` +
      `Supported scripts for lane ${lane}: ${supported.length > 0 ? supported.join(", ") : "none"}.`
    );
  }
  
  function resolveGateInvocation(repoRoot, lane, source, branch = "dev") {
    let script = null;
    try {
      script = resolveGateScript(repoRoot, lane, source, branch);
    } catch (error) {
      if (!(error instanceof GovernanceError)) throw error;
      // No npm gate script for this lane/source. Try the bash fallback.
      if (fs.existsSync(path.join(repoRoot, "scripts", "gate.sh"))) {
        return { kind: "bash", command: "bash", args: ["scripts/gate.sh", lane] };
      }
      throw error;
    }
    return { kind: "script", script };
  }
  
  function resolveGateArtifactDir(repoCode) {
    const repoName = repoDisplayNameForCode(repoCode);
    return path.join(COORD_DIR, "artifacts", "gates", repoName);
  }
  
  function detectGatePackageManager(worktree) {
    const has = (file) => fs.existsSync(path.join(worktree, file));
    if (has("pnpm-lock.yaml")) {
      return {
        name: "pnpm",
        bin: "pnpm",
        installArgs: ["install", "--frozen-lockfile"],
        runScriptArgs: (script) => [script],
      };
    }
    if (has("yarn.lock")) {
      return {
        name: "yarn",
        bin: "yarn",
        installArgs: ["install", "--frozen-lockfile"],
        runScriptArgs: (script) => [script],
      };
    }
    if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
      return {
        name: "npm",
        bin: "npm",
        installArgs: ["ci"],
        runScriptArgs: (script) => ["run", script],
      };
    }
    // No recognized lockfile — preserve the historical pnpm default.
    return {
      name: "pnpm",
      bin: "pnpm",
      installArgs: ["install", "--frozen-lockfile"],
      runScriptArgs: (script) => [script],
    };
  }
  
  function runCleanCheckoutGate(repoArg, flags) {
    // COORD-075: the accepted lane vocabulary is single-sourced in
    // governance-constants.GATE_LANES so coord validation, the template repo
    // gate.sh runners, and CI can never silently diverge again.
    const VALID_LANES = gateLaneSet();
    const VALID_SOURCES = new Set(["local", "hook", "ci"]);
  
    const repoCode = repoCodeForCliRepoArg(repoArg);
    if (!repoCode) {
      fail(`Invalid repo "${repoArg}". Use one of: ${configuredRepoArgDescription()}.`);
    }
  
    const lane = flags.lane;
    if (!lane || !VALID_LANES.has(lane)) {
      fail(`--lane is required. Use one of: ${GATE_LANES.join(", ")}.`);
    }
  
    const source = flags.source || "local";
    if (!VALID_SOURCES.has(source)) {
      fail(`Invalid --source "${source}". Use one of: local, hook, ci.`);
    }
  
    const branch = flags.branch || "dev";
    const repoRoot = getRepoRoot(repoCode);
    const repoName = repoDisplayNameForCode(repoCode);
  
    // Verify the branch exists
    const branchCheck = gitTry(repoRoot, ["rev-parse", "--verify", branch]);
    if (branchCheck.status !== 0) {
      fail(`Branch "${branch}" does not exist in ${repoName}.`);
    }
  
    // Resolve the commit before creating the worktree
    const branchCommit = gitTry(repoRoot, ["rev-parse", branch]);
    if (branchCommit.status !== 0) {
      fail(`Could not resolve commit for branch "${branch}" in ${repoName}.`);
    }
    const targetCommit = String(branchCommit.stdout).trim();
  
    // Create a disposable worktree outside the source repository. Keeping the
    // checkout outside repoRoot is material: recursive linters/test discovery
    // inside the checkout cannot see sibling agent worktrees under repoRoot.
    // Use a temporary branch so the gate runner sees a named branch (not detached HEAD),
    // which is required for local/hook sources to produce authoritative artifacts.
    const tmpId = `gate-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const tmpWorktree = path.join(os.tmpdir(), "coord-gates", tmpId);
    const tmpBranch = `tmp/gate-checkout-${tmpId}`;
    const isolation = (() => {
      try { return buildEvidenceIsolation({ repoRoot, checkoutPath: tmpWorktree }); }
      catch (error) { fail(error.message); }
    })();
    fs.mkdirSync(path.dirname(tmpWorktree), { recursive: true });
  
    const wtResult = gitTry(repoRoot, ["worktree", "add", "-b", tmpBranch, tmpWorktree, targetCommit]);
    if (wtResult.status !== 0) {
      fail(
        `Failed to create temporary worktree for gate run:\n${(wtResult.stderr || "").trim()}`
      );
    }
  
    let gateArtifact = null;
    let exitCode = 1;
    let postRunStatus = null;
  
    try {
      // Verify the worktree is clean (it should be since we just created it from a commit)
      const statusCheck = gitTry(tmpWorktree, ["status", "--porcelain"]);
      if (statusCheck.status !== 0 || String(statusCheck.stdout || "").trim().length > 0) {
        fail(`Temporary worktree is unexpectedly dirty after creation.`);
      }
  
      // Install dependencies using the package manager the worktree's lockfile
      // declares. COORD-022: the gate previously hardcoded pnpm, which fails on
      // npm (package-lock.json) and yarn (yarn.lock) adopters. Detect from the
      // lockfile present in the worktree; fall back to pnpm (the donor default)
      // when no lockfile is found, preserving prior behavior.
      const pkgManager = detectGatePackageManager(tmpWorktree);
      const installResult = spawnSync(pkgManager.bin, pkgManager.installArgs, {
        cwd: tmpWorktree,
        env: productChildEnv(),
        stdio: "inherit",
        timeout: 120_000,
      });
      if (installResult.status !== 0) {
        fail(`${pkgManager.name} install (${pkgManager.installArgs.join(" ")}) failed in temporary worktree.`);
      }
  
      // Resolve how to run the gate lane: prefer an npm `gate:<lane>` script
      // (unchanged behavior); fall back to `bash scripts/gate.sh <lane>` when the
      // repo has no such script but ships scripts/gate.sh (COORD bash fallback).
      const invocation = resolveGateInvocation(repoRoot, lane, source, branch);
      let gateResult;
      // COORD-093: measure the gate run with a MONOTONIC clock
      // (process.hrtime.bigint) around the invocation. The repo gate.sh writes
      // its own duration_ms with whole-second wall-clock math (date +%s), which
      // (1) rounds sub-second runs to 0 and (2) can go NEGATIVE on a backward
      // clock step (NTP correction) — violating the COORD-080 schema. We finalize
      // duration_ms below from this monotonic measurement (sub-second, never
      // negative), overriding the runner's value exactly as we already override
      // commit/artifact_paths.
      const gateStartNs = process.hrtime.bigint();
      if (invocation.kind === "bash") {
        gateResult = spawnSync("bash", ["scripts/gate.sh", lane], {
          cwd: tmpWorktree,
          env: productChildEnv(),
          stdio: "inherit",
          timeout: 300_000,
        });
      } else {
        gateResult = spawnSync(
          pkgManager.bin,
          pkgManager.runScriptArgs(invocation.script),
          {
            cwd: tmpWorktree,
            env: productChildEnv(),
            stdio: "inherit",
            timeout: 300_000,
          }
        );
      }
      const gateMeasuredMs = Number(process.hrtime.bigint() - gateStartNs) / 1e6;
      exitCode = gateResult.status ?? 1;
      // A gate is authoritative only when the observed process result and the
      // materialized checkout agree with its receipt.  Capture this before any
      // artifact annotation so a runner cannot turn a dirty/failing execution
      // into a clean passing claim.
      postRunStatus = gitTry(tmpWorktree, ["status", "--porcelain"]);
  
      // Read the produced artifact
      const artifactDir = path.join(tmpWorktree, "artifacts", "gates");
      const latestArtifactPath = path.join(artifactDir, `${lane}.latest.json`);
  
      if (fs.existsSync(latestArtifactPath)) {
        try {
          gateArtifact = JSON.parse(fs.readFileSync(latestArtifactPath, "utf8"));
        } catch {
          // artifact unreadable — will be reported below
        }
      }
  
      // A bash gate may not emit artifacts/gates/<lane>.latest.json. When the
      // bash path ran and produced no artifact, synthesize a minimal artifact so
      // the downstream annotate/record/provenance path still works. The pass/fail
      // decision keys off exitCode.
      //
      // COORD-080 (QGATE-006): completeness is now MEASURED, not papered over.
      // A synthesized artifact is inherently THIN — it has no real duration, no
      // command list, and no coverage/audit signal — so we synthesize-WITH-WARNING
      // rather than fail: the artifact carries the fields it can, marks the
      // coverage/audit signals as skipped (so they validate as legitimately
      // null), and the validator below records exactly which fields had to be
      // synthesized (`complete: false`, `incomplete_fields`). Rationale: failing
      // here would break the long-standing graceful path for repos whose gate.sh
      // predates the complete-artifact contract; surfacing incompleteness on the
      // board is the acceptance criterion, and it keeps the minimal template
      // stubs runnable. A repo gate.sh that emits a complete artifact (the
      // template runners now do) is used verbatim and validates as complete.
      if (!gateArtifact && invocation.kind === "bash") {
        const bashResult = exitCode === 0 ? "pass" : "fail";
        gateArtifact = {
          lane,
          result: bashResult,
          status: bashResult,
          // No real timing/steps are recoverable post-hoc from a bash runner
          // that did not emit them; leave them unpopulated so the validator
          // flags them rather than fabricating values.
          duration_ms: null,
          command_list: [],
          coverage: null,
          coverage_skip_reason: "repo gate.sh emitted no artifact; coverage not captured",
          audit: null,
          audit_skip_reason: "repo gate.sh emitted no artifact; audit not captured",
          git: { branch, commit: targetCommit },
          clean_checkout: {
            materialized: true,
            worktree_path: tmpWorktree,
            source_branch: branch,
            source_commit: targetCommit,
            isolation,
          },
          authority: {
            status: "authoritative",
            reason: "governed clean-checkout materialization (bash scripts/gate.sh)",
          },
          gate_runner: "scripts/gate.sh",
          synthesized: true,
        };
      }
  
      // Annotate the artifact with clean-checkout provenance
      if (gateArtifact) {
        const trackedContentChanged = postRunStatus.status === 0 && String(postRunStatus.stdout || "").trim().length > 0;
        const reconciliation = reconcileGateReceipt({
          requestedLane: lane, exitCode, artifactLane: gateArtifact.lane,
          artifactResult: gateArtifact.result, artifactStatus: gateArtifact.status,
          trackedContentChanged,
        });
        const receiptContradictions = reconciliation.contradictions;
        gateArtifact.clean_checkout = {
          materialized: true,
          worktree_path: tmpWorktree,
          tmp_branch: tmpBranch,
          source_branch: branch,
          source_commit: targetCommit,
          worktree_clean_before_run: true,
          worktree_clean_after_run: !trackedContentChanged,
          tracked_content_changed: trackedContentChanged,
          isolation,
        };
  
        // Overwrite git provenance to reflect the actual materialized state
        gateArtifact.git = gateArtifact.git || {};
        gateArtifact.git.branch = branch;
        gateArtifact.git.commit = targetCommit;
        gateArtifact.git.worktree_clean = true;
        gateArtifact.git.clean_checkout = true;

        // COORD-080: the completeness schema requires a top-level `commit` + `lane`.
        // Set commit authoritatively from the materialized checkout (overriding
        // whatever the repo runner wrote) so the validator + board see the real sha.
        gateArtifact.commit = targetCommit;
        if (!gateArtifact.lane) gateArtifact.lane = lane;

        // COORD-093: finalize duration_ms from the monotonic measurement taken
        // around the gate spawn. This is the most robust home (we already
        // authoritatively override commit/artifact_paths here): it is sub-second
        // accurate and monotonic, so it fixes both the "fast lane -> 0" and the
        // "backward clock step -> negative" defects regardless of what the repo
        // runner wrote with its wall-clock math. The synthesized bash artifact
        // (no real run timing) keeps its honest null. We clamp as a defensive
        // backstop so a bad value can never fail the COORD-080 schema.
        if (!gateArtifact.synthesized) {
          gateArtifact.duration_ms = clampDurationMs(gateMeasuredMs);
        } else {
          gateArtifact.duration_ms = clampDurationMs(gateArtifact.duration_ms);
        }

        gateArtifact.authority = {
          status: reconciliation.status,
          reason: receiptContradictions.length
            ? "receipt contradicts observed gate execution or tracked-content provenance"
            : "governed clean-checkout materialization",
        };
        gateArtifact.execution = {
          requested_lane: lane,
          observed_lane: gateArtifact.lane,
          observed_exit_code: exitCode,
          receipt_contradictions: receiptContradictions,
        };
        if (receiptContradictions.length) {
          gateArtifact.result = reconciliation.result;
          gateArtifact.status = reconciliation.result;
          exitCode = 1;
        }
  
        // Write the annotated artifact under coord/ so clean-checkout runs never dirty canonical repo roots.
        const canonicalArtifactDir = resolveGateArtifactDir(repoCode);
        fs.mkdirSync(canonicalArtifactDir, { recursive: true });
        const canonicalLatest = path.join(canonicalArtifactDir, `${lane}.latest.json`);
        const canonicalSourceLatest = path.join(
          canonicalArtifactDir,
          `${lane}.${source}.latest.json`
        );
        const timestamp = new Date().toISOString().replaceAll(":", "-");
        const canonicalHistory = path.join(
          canonicalArtifactDir,
          `${lane}.${source}.${timestamp}.json`
        );
  
        gateArtifact.artifact_paths = [
          path.relative(ROOT_DIR, canonicalLatest).replace(/\\/g, "/"),
          path.relative(ROOT_DIR, canonicalSourceLatest).replace(/\\/g, "/"),
          path.relative(ROOT_DIR, canonicalHistory).replace(/\\/g, "/"),
        ];

        // COORD-080 (QGATE-006): validate the (now fully-annotated) artifact
        // against the completeness schema and record the verdict ON the artifact
        // itself. A repo gate.sh that emits the complete contract validates as
        // complete; a thin/synthesized one is marked incomplete with the exact
        // missing-field list, so completeness is measured + surfaced rather than
        // silently papered over.
        const completeness = validateGateArtifact(gateArtifact);
        gateArtifact.complete = completeness.complete;
        gateArtifact.incomplete_fields = completeness.missing;

        // COORD-910: the repo-gate evidence names its run manifest, which hashes
        // the three artifact copies once they are written.
        const manifestFile = canonicalHistory.replace(/\.json$/, ".manifest.json");
        const manifestDraft = runManifest.repoGateManifest({ root: tmpWorktree, lane, invocation, exitCode,
          signal: gateResult.signal || null, durationMs: gateMeasuredMs });
        gateArtifact.run_manifest = { path: path.relative(ROOT_DIR, manifestFile).replace(/\\/g, "/"),
          schema_version: manifestDraft.schema_version, input_digest: manifestDraft.input_digest };

        const artifactJson = JSON.stringify(gateArtifact, null, 2) + "\n";
        fs.writeFileSync(canonicalLatest, artifactJson);
        fs.writeFileSync(canonicalSourceLatest, artifactJson);
        fs.writeFileSync(canonicalHistory, artifactJson);
        runManifest.writeManifest(manifestFile, runManifest.finalizeManifest(manifestDraft, [canonicalLatest, canonicalSourceLatest, canonicalHistory]));
      }
    } finally {
      // Clean up the temporary worktree
      const removeResult = gitTry(repoRoot, ["worktree", "remove", "--force", tmpWorktree]);
      if (removeResult.status !== 0) {
        console.error(
          `Warning: failed to remove temporary worktree ${tmpWorktree}: ${(removeResult.stderr || "").trim()}`
        );
      }
      // Delete the temporary branch
      gitTry(repoRoot, ["branch", "-D", tmpBranch]);
      // The disposable checkout lives under os.tmpdir(); no source-repo
      // sibling-worktree cleanup is needed or permitted here.
    }
  
    // Print summary
    const status = gateArtifact?.status || (exitCode === 0 ? "pass" : "fail");
    const duration = gateArtifact?.duration_ms != null ? `${gateArtifact.duration_ms}ms` : "unknown";
    const budget = gateArtifact?.budget?.status || "unknown";
  
    console.log("");
    console.log(`${repoName} gate:${lane} clean-checkout`);
    console.log(`  branch:   ${branch}`);
    console.log(`  commit:   ${targetCommit}`);
    console.log(`  source:   ${source}`);
    console.log(`  status:   ${status}`);
    console.log(`  duration: ${duration}`);
    console.log(`  budget:   ${budget}`);
    // COORD-080: surface artifact completeness (which required fields the
    // emitted/synthesized artifact populated). "complete N/N" or "incomplete
    // .../N missing=...".
    if (gateArtifact) {
      const completeness = validateGateArtifact(gateArtifact);
      console.log(`  ${formatCompletenessSummary(completeness)}`);
    }
    if (gateArtifact?.artifact_paths) {
      for (const artifactPath of gateArtifact.artifact_paths) {
        console.log(`  artifact: ${artifactPath}`);
      }
    }
    if (!gateArtifact) {
      console.log(`  warning:  no gate artifact was produced`);
    }
  
    console.log(JSON.stringify({
      command: "gate",
      repo: repoName,
      repo_code: repoCode,
      lane,
      source,
      branch,
      commit: targetCommit,
      status,
      duration_ms: gateArtifact?.duration_ms ?? null,
      budget_status: budget,
      clean_checkout: true,
      isolation,
      artifact_complete: gateArtifact?.complete ?? null,
      incomplete_fields: gateArtifact?.incomplete_fields ?? null,
      artifact: gateArtifact || null,
    }, null, 2));
  
    if (exitCode !== 0) {
      process.exitCode = 1;
    }
  }
  return {
    readPackageScripts, resolveGateScript, resolveGateInvocation,
    resolveGateArtifactDir, detectGatePackageManager, runCleanCheckoutGate,
    reconcileGateReceipt,
    clampDurationMs,
    buildEvidenceIsolation,
  };
};

// COORD-093: also export the pure clamp directly so the schema-contract test can
// exercise it without constructing the full DI runtime.
module.exports.clampDurationMs = clampDurationMs;
module.exports.productChildEnv = productChildEnv;
module.exports.reconcileGateReceipt = reconcileGateReceipt;
module.exports.buildEvidenceIsolation = buildEvidenceIsolation;
