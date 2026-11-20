"use strict";

// COORD-898: the ONE integration base-ref resolver. Every start, submit, PR,
// closeout and delta/ancestry check resolves its base through here, so a product
// clone that has only origin/<base> (no local <base> branch) works, and a stale
// local <base> cannot inflate a commit count.
//
// Preference: the remote-tracking origin/<base> (what `gov start` cuts from and
// what fetch keeps current). Fallback: the local <base> branch. Fail closed only
// when neither resolves, with a message naming both refs and the remedy.

const { spawnSync } = require("node:child_process");

function stripOriginPrefix(baseRef) {
  return String(baseRef || "").trim().replace(/^origin\//, "");
}

function commitResolves(repoRoot, ref) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

function integrationBaseRefRemedy(baseRef) {
  const base = stripOriginPrefix(baseRef);
  return `git fetch origin ${base}`;
}

function missingIntegrationBaseRefMessage(repoRoot, baseRef) {
  const base = stripOriginPrefix(baseRef);
  return (
    `Cannot resolve integration branch ${base} in ${repoRoot}: neither origin/${base} nor local ${base} exists. ` +
    `Remedy: \`${integrationBaseRefRemedy(base)}\` (creates origin/${base}), then retry.`
  );
}

// Returns { ref, source } where ref is "origin/<base>" (preferred) or "<base>" (local
// fallback). Throws the named-remedy message when neither resolves.
function resolveIntegrationBaseRef(repoRoot, baseRef) {
  const base = stripOriginPrefix(baseRef);
  if (!base) {
    throw new Error("Cannot resolve an empty integration branch name.");
  }
  const remote = `origin/${base}`;
  if (commitResolves(repoRoot, remote)) {
    return { ref: remote, source: "origin" };
  }
  if (commitResolves(repoRoot, base)) {
    return { ref: base, source: "local" };
  }
  throw new Error(missingIntegrationBaseRefMessage(repoRoot, base));
}

// Doctor / onboard classification of a product clone's integration-branch refs.
// Returns [] when usable, otherwise findings with an exact remedy.
function integrationBaseRefFindings(repoRoot, baseRef) {
  const base = stripOriginPrefix(baseRef);
  const remote = `origin/${base}`;
  const hasRemote = commitResolves(repoRoot, remote);
  const hasLocal = commitResolves(repoRoot, base);
  if (!hasRemote && !hasLocal) {
    return [{
      code: "integration-base-ref-missing",
      severity: "high",
      message: `no usable integration-branch ref: neither ${remote} nor local ${base} exists`,
      remedy: integrationBaseRefRemedy(base),
    }];
  }
  if (!hasRemote) {
    return [{
      code: "integration-base-ref-no-origin",
      severity: "high",
      message: `local ${base} exists but ${remote} does not; governed start and submit need the remote-tracking ref`,
      remedy: integrationBaseRefRemedy(base),
    }];
  }
  if (hasLocal) {
    const localSha = spawnSync("git", ["-C", repoRoot, "rev-parse", base], { encoding: "utf8" }).stdout.trim();
    const remoteSha = spawnSync("git", ["-C", repoRoot, "rev-parse", remote], { encoding: "utf8" }).stdout.trim();
    if (localSha && remoteSha && localSha !== remoteSha) {
      const lags = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", localSha, remoteSha], { encoding: "utf8" }).status === 0;
      if (lags) {
        return [{
          code: "integration-base-ref-lags-origin",
          severity: "medium",
          message: `local ${base} (${localSha.slice(0, 12)}) lags ${remote} (${remoteSha.slice(0, 12)}); a stale local pointer is not used by the resolver but misleads manual rev-list counts`,
          remedy: `run inside the product clone: git branch -D ${base}  (or: git branch -f ${base} ${remote} when not checked out)`,
        }];
      }
    }
  }
  return [];
}

module.exports = {
  resolveIntegrationBaseRef,
  integrationBaseRefFindings,
  missingIntegrationBaseRefMessage,
};
