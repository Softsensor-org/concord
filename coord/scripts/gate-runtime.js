"use strict";

// Wave 2 (COORD-058): gate runtime extracted from lifecycle.js — gate script /
// invocation / artifact-dir resolution, package-manager detection, and the
// clean-checkout gate runner. DI-factory; repo resolution injected.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { gitTry } = require("./git-ops.js");
const { GovernanceError, defaultFail, COORD_DIR, ROOT_DIR } = require("./governance-context.js");
const { GATE_LANES, gateLaneSet } = require("./governance-constants.js");
const {
  validateGateArtifact,
  formatCompletenessSummary,
} = require("./gate-artifact-schema.js");

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
  
    // Create a temporary worktree under .worktrees/.gate-tmp/
    // Use a temporary branch so the gate runner sees a named branch (not detached HEAD),
    // which is required for local/hook sources to produce authoritative artifacts.
    const tmpId = `gate-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const tmpWorktree = path.join(repoRoot, ".worktrees", ".gate-tmp", tmpId);
    const tmpBranch = `tmp/gate-checkout-${tmpId}`;
    fs.mkdirSync(path.dirname(tmpWorktree), { recursive: true });
  
    const wtResult = gitTry(repoRoot, ["worktree", "add", "-b", tmpBranch, tmpWorktree, targetCommit]);
    if (wtResult.status !== 0) {
      fail(
        `Failed to create temporary worktree for gate run:\n${(wtResult.stderr || "").trim()}`
      );
    }
  
    let gateArtifact = null;
    let exitCode = 1;
  
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
          stdio: "inherit",
          timeout: 300_000,
        });
      } else {
        gateResult = spawnSync(
          pkgManager.bin,
          pkgManager.runScriptArgs(invocation.script),
          {
            cwd: tmpWorktree,
            stdio: "inherit",
            timeout: 300_000,
          }
        );
      }
      const gateMeasuredMs = Number(process.hrtime.bigint() - gateStartNs) / 1e6;
      exitCode = gateResult.status ?? 1;
  
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
        gateArtifact.clean_checkout = {
          materialized: true,
          worktree_path: tmpWorktree,
          tmp_branch: tmpBranch,
          source_branch: branch,
          source_commit: targetCommit,
          worktree_clean_before_run: true,
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
          status: "authoritative",
          reason: "governed clean-checkout materialization",
        };
  
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

        const artifactJson = JSON.stringify(gateArtifact, null, 2) + "\n";
        fs.writeFileSync(canonicalLatest, artifactJson);
        fs.writeFileSync(canonicalSourceLatest, artifactJson);
        fs.writeFileSync(canonicalHistory, artifactJson);
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
      // Prune empty parent directories
      try {
        const gateTmpDir = path.join(repoRoot, ".worktrees", ".gate-tmp");
        if (fs.existsSync(gateTmpDir) && fs.readdirSync(gateTmpDir).length === 0) {
          fs.rmdirSync(gateTmpDir);
        }
      } catch {
        // best effort cleanup
      }
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
    clampDurationMs,
  };
};

// COORD-093: also export the pure clamp directly so the schema-contract test can
// exercise it without constructing the full DI runtime.
module.exports.clampDurationMs = clampDurationMs;
