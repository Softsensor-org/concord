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

const lib = require("./hook-lib.js");
const stdinSeam = require("./hook-stdin.js");

const BLOCK_EXIT_CODE = 2;

function resolveRoot() {
  if (process.env.COORD_HOOK_ROOT) return process.env.COORD_HOOK_ROOT;
  return process.cwd();
}

function looksLikeRiskyGitMutation(command) {
  // COORD-664: "risky" is now decided by parsing the command into the git
  // invocations it would actually run, not by testing it for the substrings
  // "git" and "merge". `git merge-base` is an ancestry QUERY, and a quoted
  // argument that merely quotes a merge is data, not a command.
  return lib.parseGitInvocations(command).some((invocation) => lib.gitMutationKind(invocation));
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
  const decision = lib.protectedBranchOperation(command, {
    branches,
    currentBranch: lib.resolveCurrentBranch(resolveRoot()),
  });

  if (decision.blocked && decision.rule === "names-protected-branch") {
    console.error(
      `BLOCKED: manual git merge/cherry-pick/push targeting protected integration branch '${decision.branch}' ` +
        `(configured in ${source}). Use gov land or gov finalize — never merge the integration branch by hand.`
    );
    process.exit(BLOCK_EXIT_CODE);
  }

  if (decision.blocked && decision.rule === "head-on-protected-branch") {
    console.error(
      `BLOCKED: HEAD is on protected integration branch '${decision.branch}' (configured in ${source}), so this ` +
        `manual git ${decision.kind} would land onto it — even though the branch is not named in the command ` +
        `(${decision.source}). This is exactly the by-SHA landing COORD-664 was filed for. ` +
        `Use gov land or gov finalize — never take a commit onto the integration branch by hand.`
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

  process.exit(0);
}

// A crash is a nonzero exit, which the hook runner treats as a block — a
// REQUIRED hook can never fail open, including on an unexpected rejection.
main().catch((error) => {
  console.error(`BLOCKED (fail-closed): pre-bash-guard crashed: ${(error && error.message) || error}`);
  process.exit(BLOCK_EXIT_CODE);
});
