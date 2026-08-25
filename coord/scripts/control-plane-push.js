"use strict";

// COORD-691 — governed pre-closeout push of the control-plane integration
// branch.
//
// WHY THIS EXISTS. `gov land` on a Repo-X ticket enforces THREE git
// preconditions and performs none of them: the ticket branch is merged
// locally, the landing commit is an ancestor of origin/<integrationBranch>
// (control-plane-landing.js:198, COORD-635/ADR-0008), and the closeout sync
// reaches the remote. The third is already governed — `--push-after-sync`
// (sync-provenance.js) — and COORD-667 owns the first. The SECOND had no
// governed verb at all, while `coord/scripts/hooks/pre-bash-guard.js` correctly
// refuses a hand-run push to a protected integration branch. Measured
// 2026-08-21/22 landing COORD-680: land refused for remote ancestry, the manual
// push was refused by the guard, and the ticket only landed because a
// human-admin ran the push by hand.
//
// THE FIX IS A VERB, NOT AN EXEMPTION. The guard is not weakened, taught to
// recognise a blessed caller, or given an env override: a guard with a
// recognition rule is a guard with a credential, and the credential lives in
// the same place as the attacker (standing ruling, 2026-08-16). Governance
// performs the push itself, so the guard never has to distinguish callers.
//
// NEVER FORCE. Every push this module makes is a plain, explicitly-refspec'd
// push. `assertNoForceArgs` re-checks the argv actually handed to git, so a
// future edit that threads a force flag through fails loudly here rather than
// overwriting the integration branch — which is the exact hole COORD-664 was
// filed for and the reason the guard exists at all.
//
// RETRY-SAFE BY CLASSIFICATION, NOT BY RE-RUNNING BLIND. A pre-closeout push
// is an irreversible outward operation, so this module decides what state the
// world is in BEFORE it acts, and returns that state as a receipt:
//
//   no_remote          — no governance remote; nothing to push, not an error
//   no_remote_branch   — the remote has no such branch yet; pushing it CREATES
//                        it, which is a different act from advancing one, so it
//                        is named separately on the receipt
//   already_present    — the commit is already an ancestor of the remote branch;
//                        no push is attempted at all (the re-run case)
//   commit_not_on_head — the commit is not reachable from the local branch, so
//                        pushing it would not deliver the commit; refused
//   diverged           — the remote branch holds commits the local branch does
//                        not; refused WITHOUT pushing, because the only way to
//                        make this push succeed is a force
//   pushed             — the push ran and post-verification confirms the commit
//                        is now an ancestor of the remote branch
//
// A re-run after any partial failure lands in one of these same states and
// converges: already_present short-circuits, diverged refuses, pushed verifies.

const { gitTry } = require("./git-ops.js");
const {
  defaultControlPlaneLayout,
  resolveControlPlaneIntegrationBranch,
} = require("./control-plane-paths.js");

const PUSH_STATUS = Object.freeze({
  NO_REMOTE: "no_remote",
  NO_REMOTE_BRANCH: "no_remote_branch",
  ALREADY_PRESENT: "already_present",
  COMMIT_NOT_ON_HEAD: "commit_not_on_head",
  DIVERGED: "diverged",
  PUSHED: "pushed",
  FAILED: "failed",
});

// COORD-691 round 1 review, finding 1: an argv blocklist is NOT sufficient, and
// the first version of this module shipped a false guarantee. Two escapes were
// demonstrated:
//
//   1. `+main:main` — git's force syntax is a LEADING PLUS ON THE REFSPEC, not
//      a flag. The flag list accepted it.
//   2. `git push` with no refspec at all — which is what the shared primitive
//      was called with from sync-provenance — obeys `remote.origin.push`
//      configuration. With `remote.origin.push=+refs/heads/main:refs/heads/main`
//      configured, that call force-overwrote a diverged remote and returned
//      success.
//
// Case 2 is the important one: the dangerous instruction was not in the argv at
// all, so no amount of argv inspection could have found it. A blocklist over
// the command answers "did the caller ASK for something dangerous"; the
// question that matters is "can this invocation POSSIBLY do something
// dangerous". So the shape is now an ALLOWLIST: a governed push must name its
// remote and a plain, explicit, non-plus refspec, and anything else — including
// silence — is refused. Silence is refused precisely because silence is what
// delegates the decision to configuration.
const FORCE_ARG = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes(=.*)?)$/;

// Modes that rewrite or remove remote refs wholesale. `--mirror` in particular
// deletes remote refs that are absent locally, which is destructive without
// ever being "a force" in the flag sense.
const DESTRUCTIVE_MODE_ARG = /^(--mirror|--delete|-d|--prune|--all|--tags|--follow-tags)$/;

// The only option flags a governed push may carry. Everything else is refused
// rather than reasoned about — an allowlist that is argued with is a blocklist.
const ALLOWED_OPTION_ARG = /^(--porcelain|--quiet|-q|--no-verify|--atomic|--set-upstream|-u)$/;

// <src>:<dst>, no leading '+', no refspec-level force, no wildcards, and no
// deletion form (`:dst`). Ref names are constrained to what git accepts for a
// branch, so `--upload-pack=...`-style smuggling cannot masquerade as a refspec.
const PLAIN_REFSPEC = /^[A-Za-z0-9._\/-]+:[A-Za-z0-9._\/-]+$/;

function assertNoForceArgs(args) {
  const argv = (args || []).map((arg) => String(arg));
  const offending = argv.filter((arg) => FORCE_ARG.test(arg) || DESTRUCTIVE_MODE_ARG.test(arg));
  if (offending.length > 0) {
    throw new Error(
      `Refusing to run a governed push with force/destructive argument(s): ${offending.join(", ")}. ` +
      "A governed pre-closeout push may only fast-forward the named branch (COORD-691); " +
      "overwriting or removing remote refs is the COORD-664 hazard the bash guard exists to prevent."
    );
  }
  return args;
}

// The full check. `assertNoForceArgs` is kept as the narrow flag test (it is
// what the hook-facing tests pin), but every push this module performs goes
// through this one, which also refuses the two escapes above.
function assertGovernedPushArgv(argv) {
  const args = (argv || []).map((arg) => String(arg));
  if (args[0] !== "push") {
    throw new Error(`Refusing a governed push whose argv does not start with "push": ${args.join(" ")}.`);
  }
  assertNoForceArgs(args);

  const rest = args.slice(1);
  const options = rest.filter((arg) => arg.startsWith("-"));
  const positional = rest.filter((arg) => !arg.startsWith("-"));

  for (const option of options) {
    if (!ALLOWED_OPTION_ARG.test(option)) {
      throw new Error(
        `Refusing a governed push with the unrecognised option "${option}". A governed push accepts only ` +
        `${ALLOWED_OPTION_ARG.source} — anything else is refused rather than interpreted (COORD-691).`
      );
    }
  }

  // Exactly <remote> <refspec>. Silence is the escape: `git push` with no
  // refspec resolves through remote.<name>.push / push.default, which can be
  // configured to a forcing refspec the argv never mentions.
  if (positional.length !== 2) {
    throw new Error(
      "Refusing a governed push that does not name exactly one remote and one refspec " +
      `(got ${positional.length}: ${positional.join(" ") || "<none>"}). An implicit push resolves through ` +
      "remote.<name>.push / push.default, so a repository can be CONFIGURED to force without the command " +
      "ever saying so — measured in review as remote.origin.push=+refs/heads/main:refs/heads/main " +
      "overwriting a diverged remote (COORD-691)."
    );
  }
  const [, refspec] = positional;
  if (refspec.startsWith("+")) {
    throw new Error(
      `Refusing a governed push with the forcing refspec "${refspec}". A leading "+" IS git's force syntax; ` +
      "it carries the same overwrite semantics as --force while passing any flag-level check (COORD-691)."
    );
  }
  if (!PLAIN_REFSPEC.test(refspec)) {
    throw new Error(
      `Refusing a governed push with the refspec "${refspec}". A governed push requires a plain explicit ` +
      "<src>:<dst> with no wildcard and no deletion form (COORD-691)."
    );
  }
  return args;
}

function runGit(repoRoot, args, gitFn) {
  const run = typeof gitFn === "function" ? gitFn : gitTry;
  return run(repoRoot, args);
}

function ok(result) {
  return Boolean(result) && result.status === 0;
}

function trimmed(result) {
  return String((result && result.stdout) || "").trim();
}

function resolveCommitish(repoRoot, commitish, gitFn) {
  if (!commitish) return null;
  const result = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`], gitFn);
  return ok(result) ? trimmed(result) : null;
}

function isAncestor(repoRoot, commitSha, refName, gitFn) {
  if (!commitSha || !refName) return false;
  return ok(runGit(repoRoot, ["merge-base", "--is-ancestor", commitSha, refName], gitFn));
}

function hasRemote(repoRoot, remote, gitFn) {
  const result = runGit(repoRoot, ["remote"], gitFn);
  if (!ok(result)) return false;
  return trimmed(result).split(/\r?\n/).map((line) => line.trim()).includes(remote);
}

// The state of the world BEFORE any push. Separated from the push itself so the
// decision is testable without a remote and so the receipt can record what was
// observed rather than what was assumed.
function classifyPushNeed({ repoRoot, branch, commitSha, remote = "origin", gitFn } = {}) {
  const remoteRef = `${remote}/${String(branch).replace(new RegExp(`^${remote}/`), "")}`;
  if (!hasRemote(repoRoot, remote, gitFn)) {
    return { status: PUSH_STATUS.NO_REMOTE, remote_ref: remoteRef };
  }
  // A stale tracking ref reads exactly like a missing branch; refresh before
  // concluding either.
  runGit(repoRoot, ["fetch", remote, branch], gitFn);

  const localSha = resolveCommitish(repoRoot, branch, gitFn);
  const remoteSha = resolveCommitish(repoRoot, remoteRef, gitFn);

  if (commitSha && !isAncestor(repoRoot, commitSha, branch, gitFn)) {
    return {
      status: PUSH_STATUS.COMMIT_NOT_ON_HEAD,
      remote_ref: remoteRef,
      local_sha: localSha,
      remote_sha: remoteSha,
    };
  }
  if (!remoteSha) {
    return { status: PUSH_STATUS.NO_REMOTE_BRANCH, remote_ref: remoteRef, local_sha: localSha, remote_sha: null };
  }
  if (commitSha && isAncestor(repoRoot, commitSha, remoteRef, gitFn)) {
    return { status: PUSH_STATUS.ALREADY_PRESENT, remote_ref: remoteRef, local_sha: localSha, remote_sha: remoteSha };
  }
  // Diverged: the remote holds history the local branch does not. Only a force
  // could resolve it, so this refuses instead of pushing.
  if (!isAncestor(repoRoot, remoteSha, branch, gitFn)) {
    return { status: PUSH_STATUS.DIVERGED, remote_ref: remoteRef, local_sha: localSha, remote_sha: remoteSha };
  }
  return { status: "needed", remote_ref: remoteRef, local_sha: localSha, remote_sha: remoteSha };
}

// The single non-force push primitive. `sync-provenance.js` delegates its
// opt-in post-sync push here rather than keeping a second implementation:
// two independently written push paths in one engine drift, and the one that
// drifts is the one nobody reads (COORD-691 acceptance (f)).
function nonForcePush(repoRoot, args, { gitFn } = {}) {
  const argv = ["push", ...(args || [])];
  assertGovernedPushArgv(argv);
  return runGit(repoRoot, argv, gitFn);
}

// The refspec a caller should use when it means "advance this branch on this
// remote". Exists so callers cannot express the intent any other way — in
// particular so no caller can express it by saying nothing.
function branchRefspec(branch) {
  const name = String(branch || "").trim().replace(/^\+/, "");
  if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name)) {
    throw new Error(`Refusing to build a push refspec from the branch name "${branch}".`);
  }
  return `${name}:${name}`;
}

function pushControlPlaneIntegrationBranch(options = {}) {
  const layout = options.layout || defaultControlPlaneLayout(options);
  const repoRoot = options.repoRoot || (layout && layout.coordRepoRoot);
  if (!repoRoot) {
    return { status: PUSH_STATUS.NO_REMOTE, pushed: false, forced: false, reason: "no_control_plane_repository" };
  }
  const remote = options.remote || "origin";
  const branch = String(
    options.branch || resolveControlPlaneIntegrationBranch(layout, options)
  ).replace(new RegExp(`^${remote}/`), "");
  const commitSha = options.commitSha || null;
  const gitFn = options.gitFn;

  const need = classifyPushNeed({ repoRoot, branch, commitSha, remote, gitFn });
  const base = {
    ref: branch,
    remote,
    remote_ref: need.remote_ref,
    commit_sha: commitSha,
    local_sha: need.local_sha || null,
    remote_sha_before: need.remote_sha || null,
    forced: false,
    observed_at: options.now || new Date().toISOString(),
  };

  if (need.status === PUSH_STATUS.DIVERGED) {
    throw new Error(
      `Refusing the governed pre-closeout push: ${remote}/${branch} holds commits the local ${branch} does not ` +
      `(remote ${need.remote_sha}, local ${need.local_sha}). Reconciling that requires a force, which a governed ` +
      "push must never perform (COORD-664/COORD-691). Integrate the remote history locally, then retry."
    );
  }
  if (need.status === PUSH_STATUS.COMMIT_NOT_ON_HEAD) {
    throw new Error(
      `Refusing the governed pre-closeout push: landing commit ${commitSha} is not reachable from ${branch} in ` +
      `${repoRoot}, so pushing ${branch} would not deliver it. Merge the ticket branch first (COORD-667).`
    );
  }
  if (need.status === PUSH_STATUS.NO_REMOTE || need.status === PUSH_STATUS.ALREADY_PRESENT) {
    // Both are no-ops, and both are SUCCESS: already_present is the re-run of a
    // push that already happened, which must converge rather than repeat.
    return { ...base, status: need.status, pushed: false, remote_sha_after: need.remote_sha || null };
  }

  // ROUND 2 REVIEW, finding 2. The exit status is NOT the outcome. A push can
  // succeed on the server and still report failure locally — a dropped
  // connection after the ref update, a lost acknowledgement — and the previous
  // code returned FAILED without looking at the remote. The remote had moved,
  // the receipt said pushed=false, no external side effect was recorded, and a
  // downstream rollback then recreated exactly the missing-receipt failure that
  // round 1's finding 2 was about. So: every ATTEMPTED push is post-verified
  // against the remote, whatever git said, and `attempted` is on the receipt so
  // the caller can record an effect for the ambiguous case as well as the
  // clean one.
  const result = nonForcePush(
    repoRoot,
    [...(options.setUpstream ? ["--set-upstream"] : []), remote, branchRefspec(branch)],
    { gitFn },
  );
  const acknowledged = ok(result);
  const stderr = String((result && result.stderr) || "").trim();

  runGit(repoRoot, ["fetch", remote, branch], gitFn);
  const after = resolveCommitish(repoRoot, need.remote_ref, gitFn);
  const delivered = commitSha
    ? isAncestor(repoRoot, commitSha, need.remote_ref, gitFn)
    : Boolean(after && after !== need.remote_sha);
  // The remote moved even if the commit under test is not the reason. Recorded
  // separately from `delivered` because "we changed the remote" and "we
  // delivered what we meant to" are different facts, and the audit needs the
  // first one even when the second is false.
  const remoteMoved = Boolean(after && after !== (need.remote_sha || null));

  const receipt = {
    ...base,
    attempted: true,
    acknowledged,
    remote_moved: remoteMoved,
    created_remote_branch: need.status === PUSH_STATUS.NO_REMOTE_BRANCH,
    remote_sha_after: after || need.remote_sha || null,
  };

  if (delivered) {
    return {
      ...receipt,
      status: PUSH_STATUS.PUSHED,
      pushed: true,
      ...(acknowledged
        ? {}
        : {
          // The dangerous case, and the reason this branch exists: git said no,
          // the remote says yes. Believing git here loses the record of an
          // irreversible act that already happened.
          ack_lost: true,
          detail:
            "the push was NOT acknowledged locally " +
            `(${stderr || "no stderr"}) but the remote branch now contains the commit; ` +
            "delivery confirmed by post-verification, not by exit status",
        }),
    };
  }
  return {
    ...receipt,
    status: PUSH_STATUS.FAILED,
    pushed: false,
    detail: acknowledged
      ? "push reported success but the commit is still not an ancestor of the remote branch"
      : stderr || "unknown push failure",
  };
}

// OPT-IN, LIKE THE POST-SYNC PUSH. A push is an irreversible outward
// operation. `--push-before-closeout` (or COORD_PUSH_BEFORE_CLOSEOUT) mirrors
// `--push-after-sync` / COORD_PUSH_ON_FINALIZE deliberately: one mental model
// for both ends of a landing, and neither is ever the default.
function preCloseoutPushEnabled(options = {}) {
  if (options && options.pushBeforeCloseout === true) return true;
  const value = process.env.COORD_PUSH_BEFORE_CLOSEOUT;
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
}

module.exports = {
  PUSH_STATUS,
  preCloseoutPushEnabled,
  FORCE_ARG,
  assertNoForceArgs,
  assertGovernedPushArgv,
  branchRefspec,
  classifyPushNeed,
  nonForcePush,
  pushControlPlaneIntegrationBranch,
};
