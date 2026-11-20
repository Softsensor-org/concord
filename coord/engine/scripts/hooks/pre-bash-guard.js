#!/usr/bin/env node
"use strict";

// COORD-476 — REQUIRED safety hook (PreToolUse: Bash).
//
// Blocks manual `git merge` / `git cherry-pick` / `git push` mutations that
// name a protected integration branch. The protected set is resolved from
// `coord/project.config.js` (every configured `integrationBranch`, plus the
// coord workspace base) — NOT a hardcoded `dev` literal.
//
// Fail-closed contract: this hook is a safety gate. If the command looks like
// a risky git mutation and the protected-branch set cannot be resolved, the
// hook BLOCKS (nonzero exit) with an actionable message instead of silently
// passing. Any crash of this script is itself a nonzero exit, which the hook
// runner treats as a block — a required hook can never fail open.
//
// COORD-660 — THE PAYLOAD IS PART OF THE FAIL-CLOSED CONTRACT. This hook used
// to acquire its command through a synchronous one-shot read of fd 0 whose
// EAGAIN was swallowed into `""`. With no command text there was nothing to
// classify, so the guard exited 0 and the protected-branch push went through:
// the control failed open whenever the harness wrote stdin a few milliseconds
// after spawn. Payload acquisition now lives in the pure, injectable
// `hook-stdin.js` seam (lazy, stream-based, bounded), and NO PAYLOAD IS A
// REFUSAL. Absence of evidence is not permission, and an unreadable payload is
// never "an empty command".
//
// Exit codes: 0 = allow; 2 = block (Claude Code PreToolUse blocking code).
//
// Portability: pure Node. The generated hook command is plain
// `node coord/scripts/hooks/pre-bash-guard.js` — `/bin/sh`-safe, no GNU
// utilities, no Bash 4 features.

const BLOCK_EXIT_CODE = 2;

// COORD-949: the requires are load-safe. A require-time failure (a partially
// installed or half-upgraded engine) must not escape as an uncaught exception: node
// exits 1, a NON-blocking error to the harness, and the git operation would proceed.
// Run as the entrypoint it blocks; required as a module it rethrows.
const OUT_OF_BAND_RECOVERY =
  "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent " +
  "harness, restore the engine copy under coord/engine/scripts/hooks, restart the session, or land the change through " +
  "governance (gov land / gov finalize) from that terminal.";
let lib;
let stdinSeam;
try {
  lib = require("./hook-lib.js");
  stdinSeam = require("./hook-stdin.js");
} catch (error) {
  if (require.main !== module) throw error;
  process.stderr.write(
    `BLOCKED (fail-closed): pre-bash-guard cannot load its engine modules: ${(error && error.message) || error} ` +
      `(coord/engine/scripts/hooks/pre-bash-guard.js). ${OUT_OF_BAND_RECOVERY}\n`
  );
  process.exit(BLOCK_EXIT_CODE);
}

// COORD-930: the trusted config root is the INSTALLED ENGINE's workspace, derived
// from this file's own location. It is never the caller's cwd, the target
// repository (a planted coord/project.config.js there changes nothing), or an
// environment variable. A hook directory that is not at coord/engine/scripts/hooks
// throws, and that throw is a fail-closed block.
function resolveRoot() {
  return lib.trustedEngineRoot(__dirname);
}

function looksLikeRiskyGitMutation(command) {
  // COORD-664: "risky" is now decided by parsing the command into the git
  // invocations it would actually run, not by testing it for the substrings
  // "git" and "merge". `git merge-base` is an ancestry QUERY, and a quoted
  // argument that merely quotes a merge is data, not a command.
  // COORD-948: an unresolved command word, or a non-builtin subcommand that may be
  // an alias, also needs the decision: the guard must not pass what it cannot read.
  return lib.gitCommandNeedsDecision(command);
}

async function main() {
  // gather inputs -> call module -> act. This wired file stays deliberately
  // thin; the decisions it makes are proven against `hook-stdin.js` and
  // `hook-lib.js` out of process.
  const acquired = await stdinSeam.acquireHookPayload({
    env: process.env,
    // TOOL_OUTPUT does not exist at PreToolUse and this guard never reads it,
    // so TOOL_INPUT alone makes stdin unnecessary.
    needs: ["TOOL_INPUT"],
  });
  const payload = lib.readHookPayload(process.env, acquired.stdinText);
  const command = payload.toolInput;

  // NO PAYLOAD IS A REFUSAL. Reaching here with nothing means the command
  // under judgement could not be read — not that there was no command. The
  // guard cannot certify what it never saw.
  if (!acquired.ok || String(command).trim() === "") {
    console.error(
      "BLOCKED (fail-closed): this PreToolUse guard received no command to inspect, " +
        "so it cannot certify that this operation is not a manual merge/cherry-pick/push " +
        "of a protected integration branch.\n" +
        `Reason: ${stdinSeam.explainStdinReason(acquired.stdinReason)}` +
        (acquired.stdinConsulted ? "" : " and TOOL_INPUT was empty") +
        ".\n" +
        "This is usually a transient hook-payload delivery failure: retry the command. " +
        "If it repeats, the hook wiring in .claude/settings.json is not delivering the " +
        "tool payload (TOOL_INPUT env or the hook JSON on stdin) to " +
        "coord/scripts/hooks/pre-bash-guard.js."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (!looksLikeRiskyGitMutation(command)) {
    process.exit(0);
  }

  const { branches, source, error } = lib.loadProtectedBranches(resolveRoot());
  if (!branches) {
    console.error(
      "BLOCKED (fail-closed): cannot resolve the protected integration branches, " +
        "so this git merge/cherry-pick/push cannot be verified as safe.\n" +
        `Reason: ${error}\n` +
        "Fix coord/project.config.js (integrationBranch per repo) or run the mutation through governance (gov land / gov finalize)."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  // COORD-664: the branch under HEAD comes from TRUSTED REPOSITORY STATE in
  // the resolved repo. It is never taken from the command text, so a command
  // that names a non-protected branch cannot steer the answer.
  // COORD-930: the repository each git invocation targets (-C, --git-dir,
  // --work-tree, GIT_DIR/GIT_WORK_TREE) is resolved per invocation from the acting
  // cwd, and HEAD is read from that repository.
  const decision = lib.protectedBranchOperation(command, {
    branches,
    actingRoot: process.cwd(),
    currentBranchFor: (target) => lib.resolveCurrentBranch(target),
  });

  if (decision.blocked && decision.rule === "names-protected-branch") {
    console.error(
      `BLOCKED: manual git merge/cherry-pick/push targeting protected integration branch '${decision.branch}' ` +
        `(configured in ${source}). Use gov land or gov finalize — never merge the integration branch by hand.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "head-on-protected-branch") {
    // COORD-969: reset, rebase and commit --amend rewrite the branch under HEAD.
    const landing = ["merge", "cherry-pick", "push", "pull"].includes(decision.kind);
    console.error(
      `BLOCKED: HEAD is on protected integration branch '${decision.branch}' (configured in ${source}), so this ` +
        `manual git ${decision.kind} would ${landing ? "land onto it" : "rewrite it"} — even though the branch is not named in the command ` +
        `(${decision.source}).${landing ? " This is exactly the by-SHA landing COORD-664 was filed for." : ""} ` +
        `Use gov land or gov finalize — never change the integration branch by hand; make the change in your ticket worktree.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  // COORD-969: branch -f/-D/-d/-M/-m/-C, checkout -B, switch -C and update-ref name a
  // protected ref. The ref is moved or deleted whatever HEAD is on.
  if (decision.blocked && decision.rule === "moves-protected-branch") {
    console.error(
      `BLOCKED: git ${decision.kind} would move, rename or delete protected integration branch '${decision.branch}' ` +
        `(configured in ${source}), whatever branch HEAD is on. Use gov land or gov finalize, or do the work in your ` +
        `ticket worktree. The integration branch is never reset or deleted by hand.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "unverifiable-current-branch") {
    console.error(
      `BLOCKED (fail-closed): this git ${decision.kind} lands onto whatever branch HEAD is on, and the current ` +
        `branch could not be read from repository state, so it cannot be verified as not-a-protected-branch.\n` +
        `Reason: ${decision.error}\n` +
        "Run the operation inside the intended git repository, or land through governance (gov land / gov finalize)."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  // COORD-948: an unresolvable expansion in a push refspec, a target flag, or a
  // command word. The value cannot be known, so the guard refuses rather than guesses.
  if (decision.blocked && decision.rule === "unresolvable-expansion") {
    console.error(
      `BLOCKED (fail-closed): unresolvable shell expansion in protected-branch-sensitive position: ` +
        `'${decision.token}' (${decision.kind || "git"} in ${decision.target}). The guard cannot know what this ` +
        `resolves to, so it cannot certify that the operation does not reach the protected integration branches (${source}). ` +
        "Use gov land or gov finalize, or write the branch name literally."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "unresolvable-alias") {
    console.error(
      `BLOCKED (fail-closed): git subcommand '${decision.token}' may be an alias, and its definition could not be ` +
        `read from ${decision.target}, so it cannot be verified as not-a-protected-branch push.\n` +
        `Reason: ${decision.detail}\n` +
        "Use gov land or gov finalize, or run the git command under its real name."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "mirror-deletes-remote-refs") {
    console.error(
      "BLOCKED: git push --mirror force-updates and deletes every remote ref that is not a local branch, " +
        `including protected integration branches (${source}). Use gov land or gov finalize.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "unverifiable-push-targets") {
    console.error(
      `BLOCKED (fail-closed): git push --all/--mirror names every local branch, and the local branches could not ` +
        `be listed, so it cannot be verified as not touching a protected branch (${source}).\n` +
        `Reason: ${decision.error}\n` +
        "Use gov land or gov finalize."
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  // COORD-948: any other block is still a block. A rule this file does not name must
  // never fall through to exit 0.
  // guard:governed-push-safety
  if (decision.blocked) {
    console.error(
      `BLOCKED (fail-closed): protected-branch guard refused this git ${decision.kind || "command"} ` +
        `(rule ${decision.rule}). Use gov land or gov finalize.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  process.exit(0);
}

// A crash is a nonzero exit, which the hook runner treats as a block — a
// REQUIRED hook can never fail open, including on an unexpected rejection.
function runHook() {
  return main().catch((error) => {
    console.error(`BLOCKED (fail-closed): pre-bash-guard crashed: ${(error && error.message) || error} ${OUT_OF_BAND_RECOVERY}`);
    process.exit(BLOCK_EXIT_CODE);
  });
}
// COORD-872: the permanent shim at the legacy coord/scripts path re-dispatches
// runHook, so the fail-closed crash handling above is part of the exported main.
if (require.main === module) runHook();
module.exports = { main: runHook };
