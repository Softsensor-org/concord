#!/usr/bin/env node
"use strict";

// COORD-476 — ADVISORY hook (PostToolUse: Bash).
//
// Consolidates the previous inline-shell PostToolUse advisories into one
// tested, portable helper:
//   1. heartbeat after a `gov commit` (lock HEAD sync);
//   2. post-land test-maturity staleness advisory;
//   3. post-land "no test files in the landed diff" advisory.
//
// Advisory contract: this hook NEVER blocks. Every internal failure is
// downgraded to a visible `ADVISORY skipped (...)` line so skips stay
// observable instead of vanishing behind `2>/dev/null || true`. The process
// always exits 0.
//
// Portability / config-awareness:
//   - all parsing lives in hook-lib.js (no GNU-only grep flags, no Bash 4
//     features);
//   - governance is invoked as `node coord/scripts/governance.js ...` —
//     never the Bash `gov` shim run through node;
//   - the landed-diff advisory diffs the repo's CONFIGURED integration
//     branch from coord/project.config.js, never a hardcoded branch literal.
//
// COORD-660 — SAME READER, DIFFERENT VERDICT, AND THE DIFFERENCE IS STATED.
// This hook shared the defective `readStdinSafe()` seam, so it too could lose
// its payload to a late stdin write; it now acquires the payload through the
// lazy, stream-based, bounded `hook-stdin.js` seam like every other hook.
// What it deliberately does NOT share is the refusal. `pre-bash-guard.js` runs
// at PreToolUse and DECIDES WHETHER AN OPERATION MAY PROCEED, so a payload it
// cannot read must be a refusal — otherwise absence of evidence becomes
// permission. This hook runs at PostToolUse: the command has ALREADY RUN, this
// process grants nothing and can withhold nothing, and its only output is
// advice. There is no permission here to fail open on. An unreadable payload
// therefore costs an advisory, not a control — and it is REPORTED as an
// observable `ADVISORY skipped (payload)` line rather than silently producing
// no advice, which is the actual COORD-660 failure mode applied here.

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const lib = require("./hook-lib.js");
const stdinSeam = require("./hook-stdin.js");

function resolveRoot() {
  if (process.env.COORD_HOOK_ROOT) return process.env.COORD_HOOK_ROOT;
  return process.cwd();
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function skipped(what, reason) {
  say(`ADVISORY skipped (${what}): ${reason}`);
}

function runHeartbeat(root, toolInput) {
  if (!lib.isGovCommitCommand(toolInput)) return;
  const ticket = lib.extractTicketId(toolInput);
  if (!ticket) {
    skipped("heartbeat", "no ticket id found in the gov commit command");
    return;
  }
  const governanceJs = path.join(root, "coord", "scripts", "governance.js");
  const result = spawnSync(process.execPath, [governanceJs, "heartbeat", ticket], {
    cwd: root,
    stdio: "ignore",
    timeout: 30000,
  });
  if (result.status !== 0) {
    skipped("heartbeat", `governance.js heartbeat ${ticket} exited ${result.status == null ? "abnormally" : result.status}`);
  }
}

function runTestMaturityAdvisory(root) {
  const maturityPath = path.join(root, "coord", "TEST_MATURITY.md");
  const body = fs.existsSync(maturityPath) ? fs.readFileSync(maturityPath, "utf8") : "";
  const last = body.match(/Last updated: (.*)/);
  if (!last || last[1] === "not yet run") {
    say("ADVISORY: Test maturity has never been audited. Consider running /test-strategy after this epic.");
    return;
  }
  const at = new Date(last[1]);
  if (Number.isNaN(at.getTime())) {
    skipped("test-maturity", `unparseable Last updated value: ${last[1]}`);
    return;
  }
  const ageDays = Math.floor((Date.now() - at.getTime()) / 86400000);
  if (ageDays > 7) {
    say(`ADVISORY: Test maturity last audited ${ageDays} days ago. Consider running /test-strategy.`);
  }
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 });
}

function runLandedDiffAdvisory(root, ticket) {
  if (!ticket) {
    skipped("landed-diff", "no ticket id found in the land command");
    return;
  }
  const pathsMod = require(path.join(root, "coord", "paths.js"));
  const paths = pathsMod.createCoordPaths();
  const board = JSON.parse(fs.readFileSync(paths.boardPath, "utf8"));
  const rows = (board.sections || []).flatMap((section) => section.rows || []);
  const row = rows.find((r) => r.ID === ticket);
  if (!row || row.Repo === "X") return; // coord tickets: no repo diff to audit
  const repoRoot = paths.repoRoots[row.Repo];
  const branch = (paths.repoIntegrationBranches || {})[row.Repo];
  if (!repoRoot || !branch) {
    skipped("landed-diff", `no configured root/integrationBranch for repo ${row.Repo}`);
    return;
  }
  const hasRemote = git(repoRoot, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]).status === 0;
  const range = lib.integrationDiffRange(branch, hasRemote);
  const diff = git(repoRoot, ["diff", range, "--name-only"]);
  if (diff.status !== 0) {
    skipped("landed-diff", `git diff ${range} failed in ${repoRoot}`);
    return;
  }
  if (!/\.test\./.test(diff.stdout || "")) {
    say(`ADVISORY: Last landed ticket (${ticket}) diff has no test files. Consider checking /test-strategy ${ticket} for coverage gaps.`);
  }
}

async function main() {
  const root = resolveRoot();
  const acquired = await stdinSeam.acquireHookPayload({
    env: process.env,
    needs: ["TOOL_INPUT", "TOOL_OUTPUT"],
  });
  const payload = lib.readHookPayload(process.env, acquired.stdinText);

  // Report, never assume. A missing payload here means "no advice is
  // possible", and saying so keeps this hook from becoming silently inert the
  // way the guard did.
  if (!acquired.ok || String(payload.toolInput).trim() === "") {
    skipped(
      "payload",
      `${stdinSeam.explainStdinReason(acquired.stdinReason)}; no tool payload to advise on ` +
        "(advisory only — PostToolUse grants no permission, so this is not a fail-open)"
    );
    return;
  }

  try {
    runHeartbeat(root, payload.toolInput);
  } catch (error) {
    skipped("heartbeat", String(error.message || error));
  }

  if (lib.isGovLandCommand(payload.toolInput) && lib.outputReportsMerged(payload.toolOutput)) {
    try {
      runTestMaturityAdvisory(root);
    } catch (error) {
      skipped("test-maturity", String(error.message || error));
    }
    try {
      runLandedDiffAdvisory(root, lib.extractTicketId(payload.toolInput));
    } catch (error) {
      skipped("landed-diff", String(error.message || error));
    }
  }
}

main()
  .catch((error) => {
    skipped("post-bash", String((error && error.message) || error));
  })
  .finally(() => {
    process.exit(0);
  });
