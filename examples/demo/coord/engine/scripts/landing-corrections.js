"use strict";

// Corrections are superseding claims, never edits of historical landing_index.
// No prose SHA resolution: every Git fact below has a structured input.
const { createHash } = require("node:crypto");
const { gitTry } = require("./git-ops.js");
const { defaultControlPlaneLayout, resolveControlPlaneIntegrationBranch } = require("./control-plane-paths.js");
const approvalVerifier = require("./approval-verifier.js");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function git(root, args) {
  const result = gitTry(root, args, { timeout: 20000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Landing correction Git ${args[0]} failed; no correction written.`);
  return String(result.stdout || "").trim();
}
function sha(root, value) {
  if (!/^[a-f0-9]{40}$/.test(String(value || ""))) throw new Error("Landing correction requires full commit SHAs.");
  return git(root, ["rev-parse", "--verify", `${value}^{commit}`]);
}
function ancestor(root, source, target) {
  const result = gitTry(root, ["merge-base", "--is-ancestor", source, target]);
  if (result.status !== 0 && result.status !== 1) throw new Error("Landing correction ancestry check failed.");
  return result.status === 0;
}
function rows(board) {
  return (board.sections || []).flatMap((section) => section.rows || []);
}
function repository(options) {
  const layout = options.layout || defaultControlPlaneLayout();
  if (!layout?.coordRepoRoot) throw new Error("Landing corrections require a control-plane repository.");
  const branch = resolveControlPlaneIntegrationBranch(layout, { configuredBranch: options.configuredBranch, gitTry });
  return { root: layout.coordRepoRoot, branch };
}

function verifyMerge(root, merge, source, anchor) {
  sha(root, merge); sha(root, source); sha(root, anchor);
  const parents = git(root, ["show", "-s", "--format=%P", merge]).split(/\s+/);
  if (parents.length < 2) throw new Error("Landing correction requires an actual merge, not a source parent.");
  const firstParents = git(root, ["rev-list", "--first-parent", anchor]).split("\n");
  if (!firstParents.includes(merge)) throw new Error("Landing merge is not on remote integration first-parent history.");
  if (ancestor(root, source, parents[0]) || !parents.slice(1).some((parent) => ancestor(root, source, parent))) {
    throw new Error("Landing merge does not prove first-introduction of the source.");
  }
}

function verifyBinding(root, ticket, original, correction) {
  // Older records may lack structured source metadata. In that case require an
  // independently committed, exact ticket identifier on the actual merge.
  const recordedSource = original.source_commit_sha || original.commit_sha;
  if (recordedSource) {
    const resolved = git(root, ["rev-parse", "--verify", `${recordedSource}^{commit}`]);
    if (resolved !== correction.source_commit_sha) throw new Error("Correction source does not match original structured provenance.");
  } else {
    const subject = git(root, ["show", "-s", "--format=%s", correction.commit_sha]);
    if (!(subject.match(/\b[A-Z]+-\d+\b/g) || []).includes(ticket)) {
      throw new Error("Historical merge has no exact ticket binding; independent disposition required.");
    }
  }
}

function validateLandingCorrections(board, options = {}) {
  const errors = [];
  for (const [ticket, chain] of Object.entries(board.landing_corrections || {})) {
    try {
      const original = board.landing_index?.[ticket];
      if (!original || !rows(board).some((row) => row.ID === ticket && row.Repo === "X" && row.Status === "done")) {
        throw new Error("Correction requires an original landing for a done control-plane ticket.");
      }
      if (!Array.isArray(chain) || !chain.length) throw new Error("Correction chain must be nonempty.");
      const { root } = repository(options);
      let previous = null;
      for (const correction of chain) {
        if (correction.original_record_digest !== digest(original)) throw new Error("Original landing digest mismatch.");
        if (correction.previous_correction_digest !== previous) throw new Error("Previous correction digest mismatch.");
        if (!correction.approval?.trim() || !correction.reason?.trim() ||
            !rows(board).some((row) => row.ID === correction.correction_ticket && row.Repo === "X") ||
            correction.correction_ticket === ticket || !correction.base_ref ||
            !Number.isFinite(Date.parse(correction.recorded_at))) throw new Error("Correction authority or metadata is invalid.");
        git(root, ["check-ref-format", `refs/heads/${correction.base_ref}`]);
        verifyMerge(root, correction.commit_sha, correction.source_commit_sha, correction.verified_remote_sha);
        verifyBinding(root, ticket, original, correction);
        previous = digest(correction);
      }
    } catch (error) { errors.push(`${ticket}: ${error.message}`); }
  }
  return errors;
}

function correctLanding(board, options = {}, deps = {}) {
  const ticket = String(options.ticket || "");
  const original = board.landing_index?.[ticket];
  if (!original || !rows(board).some((row) => row.ID === ticket && row.Repo === "X" && row.Status === "done")) {
    throw new Error("Correction requires --ticket naming a done control-plane ticket with an original landing.");
  }
  const approval = String(options.humanAdminOverride || "").trim();
  const reason = String(options.reason || "").trim();
  const correctionTicket = String(options.correctionTicket || "");
  if (!approval || !reason || correctionTicket === ticket || !rows(board).some((row) =>
    row.ID === correctionTicket && row.Repo === "X" && String(row.Status).startsWith("doing"))) {
    throw new Error("Correction requires --human-admin-override, --reason, and an active --correction-ticket.");
  }
  const errors = validateLandingCorrections(board, options);
  if (errors.length) throw new Error(errors.join("\n"));
  const { root, branch } = repository(options);
  git(root, ["remote", "get-url", "origin"]);
  // Even idempotent retries must observe a fresh remote. No cached fallback.
  if (options.write) git(root, ["fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remote = git(root, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]);
  const chain = board.landing_corrections?.[ticket] || [];
  const correction = {
    recorded_at: new Date().toISOString(), correction_ticket: correctionTicket,
    original_record_digest: digest(original),
    previous_correction_digest: chain.length ? digest(chain[chain.length - 1]) : null,
    commit_sha: sha(root, options.correctMerge), source_commit_sha: sha(root, options.sourceCommit),
    base_ref: branch, verified_remote_sha: remote, approval, reason,
  };
  verifyMerge(root, correction.commit_sha, correction.source_commit_sha, remote);
  verifyBinding(root, ticket, original, correction);
  const prior = chain[chain.length - 1];
  const same = prior && ["correction_ticket", "commit_sha", "source_commit_sha", "approval", "reason"]
    .every((key) => prior[key] === correction[key]);
  if (options.write && !same) {
    approvalVerifier.requireSignedOverride({
      commandName: "audit-landings correction", ticketId: correctionTicket,
      row: { ticket, original_record_digest: correction.original_record_digest,
        previous_correction_digest: correction.previous_correction_digest,
        correction_ticket: correction.correction_ticket, commit_sha: correction.commit_sha,
        source_commit_sha: correction.source_commit_sha, base_ref: correction.base_ref,
        verified_remote_sha: correction.verified_remote_sha, reason },
      options,
      deps: { resolveHumanAdminOverride: deps.resolveHumanAdminOverride, fail: deps.fail,
        appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir },
    });
    board.landing_corrections ||= {};
    board.landing_corrections[ticket] = [...chain, correction];
  }
  return { ticket, changed: Boolean(options.write && !same), read_only: !options.write,
    remote_observation: options.write ? "fresh_fetch" : "cached_read_only", original_landing: original,
    correction: same ? prior : correction };
}

function correctedLanding(board, ticket, options = {}) {
  const chain = board.landing_corrections?.[ticket];
  if (!chain) return null;
  const errors = validateLandingCorrections({ ...board, landing_corrections: { [ticket]: chain } }, options);
  if (errors.length) throw new Error(errors.join("\n"));
  const latest = chain[chain.length - 1];
  return { ...board.landing_index[ticket], commit_sha: latest.commit_sha,
    source_commit_sha: latest.source_commit_sha, base_ref: latest.base_ref,
    control_plane_verification: "remote_ancestry", control_plane_verification_reason: undefined };
}

module.exports = { digest, correctLanding, correctedLanding, validateLandingCorrections };
