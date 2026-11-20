"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const { resolvePlanEvidence } = require(resolveEngineModule(__dirname + "/../..", "scripts/plan-evidence-supersession.js"));

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CONFIG: ARCH_DEFAULT_CONFIG, countLoc } = require("./arch-checks.js");
const { gitTry, formatGitCommand } = require(resolveEngineModule(COORD_DIR, "scripts/git-ops.js"));

const DECOMPOSITION_REFACTOR_SIGNAL = /\b(?:slimm?ing|slimmed|decomposition|decomposed|decompose|extract(?:ed|ion|ing)?|pure composition[- ]root|composition[- ]root|countloc|logical[- ]loc|loc ratchet|ratchet budget|monolith)\b/i;
const DECOMPOSITION_PROOF_PREFIX = "decomposition-proof:";

function isMeaningfulText(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text);
}

function ticketClaimsDecompositionRefactor(row, planState) {
  if (String(row?.Type || "").trim().toLowerCase() !== "refactor") {
    return false;
  }
  const text = [
    row?.Description,
    ...(Array.isArray(planState?.change_summary) ? planState.change_summary : []),
    ...(Array.isArray(planState?.requirement_closure) ? planState.requirement_closure : []),
  ].join("\n");
  return DECOMPOSITION_REFACTOR_SIGNAL.test(text);
}

function collectDecompositionProofEntries(planState) {
  const cycleTexts = Array.isArray(planState?.self_review_cycles)
    ? planState.self_review_cycles.map((cycle) => cycle?.raw || cycle?.diff || cycle?.verification || "")
    : [];
  return [
    ...(Array.isArray(planState?.feature_proof) ? planState.feature_proof : []),
    ...resolvePlanEvidence(planState || {}).repo_gates,
    ...(Array.isArray(planState?.requirement_closure) ? planState.requirement_closure : []),
    ...cycleTexts,
  ]
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.toLowerCase().includes(DECOMPOSITION_PROOF_PREFIX));
}

function parseDecompositionProofEntry(raw) {
  const lower = String(raw || "").toLowerCase();
  const marker = lower.indexOf(DECOMPOSITION_PROOF_PREFIX);
  if (marker < 0) {
    return null;
  }
  const body = String(raw).slice(marker + DECOMPOSITION_PROOF_PREFIX.length);
  const fields = {};
  for (const part of body.split(/[;|]/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase().replace(/-/g, "_");
    fields[key] = match[2].replace(/^`|`$/g, "").replace(/^"|"$/g, "").trim();
  }
  return { raw, fields };
}

function readIntegerProofField(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const parsed = Number.parseInt(String(value).replace(/^<=?/, "").trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeProofTargetPath(value) {
  const rel = String(value || "").trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) {
    return null;
  }
  return rel;
}

// COORD-826: a refactor lives in the ticket's worktree until it lands, so the
// canonical tree still holds the pre-change file. Measure inside the lock's
// worktree while the lock is live.
function readTicketWorktree(locksDir, ticketId) {
  try {
    const worktree = String(JSON.parse(fs.readFileSync(path.join(locksDir, `${ticketId}.lock`), "utf8")).worktree || "").trim();
    return worktree && fs.existsSync(worktree) ? path.resolve(worktree) : null;
  } catch {
    return null;
  }
}

// Proof paths are relative to the workspace parent of coord/. A worktree is a
// checkout of the ticket repo's Git root, so the path is re-based from that
// root (found from the repo dir's --show-prefix: coord/ and backend/ share one
// root in the donor, and are their own roots when installed side by side).
function resolveTicketGitRoot(ticketRepoRoot) {
  const prefix = gitTry(ticketRepoRoot, ["rev-parse", "--show-prefix"]);
  const depth = prefix.status === 0 ? String(prefix.stdout).trim().split("/").filter(Boolean).length : 0;
  return path.resolve(ticketRepoRoot, ...Array(depth).fill(".."));
}

function resolveCommit(dir, commitish) {
  const result = gitTry(dir, ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`]);
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function workingTreeMeasurement(base, resolve, label) {
  return {
    label,
    read(file) {
      const abs = resolve(file);
      if (!abs.startsWith(`${base}${path.sep}`)) return { escapes: true };
      return fs.existsSync(abs) ? { text: fs.readFileSync(abs, "utf8") } : { missing: true };
    },
  };
}

// COORD-830: at closeout the lock is gone and the canonical tree may still hold
// the pre-change file, so the proof is measured at the exact reviewed source
// commit, read from the ticket repo's object store, never from a checkout.
function commitMeasurement(gitRoot, rootDir, sha) {
  return {
    label: `the reviewed source commit ${sha}`,
    read(file) {
      const rel = path.relative(gitRoot, path.resolve(rootDir, file)).split(path.sep).join("/");
      if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return { escapes: true };
      // COORD-830 review: `git show <sha>:<dir>` prints a tree listing, which
      // countLoc would happily measure. Only a blob is a file to measure.
      const type = gitTry(gitRoot, ["cat-file", "-t", `${sha}:${rel}`]);
      if (type.status !== 0) return { missing: true };
      const kind = String(type.stdout).trim();
      if (kind !== "blob") return { notFile: kind };
      const blob = gitTry(gitRoot, ["show", `${sha}:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
      return blob.status === 0 ? { text: String(blob.stdout) } : { missing: true };
    },
  };
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// COORD-830 review (fourth pass), finding 5: `closeout` (from the resolver)
// names the finalize flags the ticket needs (--no-pr, --merge-workspace) and
// whether land applies; without it both generic commands are named.
function sourceRecoverySteps(ticketId, expectedSha, closeout = null) {
  const sha = expectedSha || "<reviewed PR head sha>";
  const flags = closeout?.flags || [];
  const steps = [["coord/scripts/gov finalize", ticketId, ...flags, `--source-commit ${sha}`].join(" ")];
  if (closeout?.landable !== false) steps.push(`coord/scripts/gov land ${ticketId} --source-commit ${sha}`);
  return steps;
}

// `recovery` overrides the default re-run advice when re-running with
// --source-commit cannot work (ambiguous provenance, an unfetched commit).
function sourceRefusal(ticketId, reason, expectedSha = null, recovery = null, closeout = null) {
  const advice = recovery?.advice || (expectedSha
    ? `re-run closeout naming the exact reviewed head ${expectedSha} with --source-commit.`
    : "re-run closeout naming the exact reviewed head (the PR head commit) with --source-commit.");
  return {
    issue: {
      code: "decomposition_proof_source_unavailable",
      message: `Decomposition-proof for ${ticketId} cannot be qualified: ${reason}. ` +
        `The canonical tree is not the reviewed source and is never measured in its place; ${advice}`,
      next_steps: recovery?.steps || sourceRecoverySteps(ticketId, expectedSha, closeout),
      severity: "blocker",
    },
  };
}

// COORD-830 review: a supplied source is qualification evidence only when it is
// a full commit SHA EQUAL to the reviewed head that durable provenance names
// (the verified PR head for a PR-backed ticket, the recorded landing source for
// a no-PR one). Branch names, HEAD, abbreviations and ancestors of the reviewed
// head are refused: each can name a commit where the file happened to be smaller.
function readReviewedSource(resolveReviewedSource) {
  if (typeof resolveReviewedSource !== "function") {
    return { sha: null, reason: "this caller supplies no durable reviewed-source provenance" };
  }
  const resolved = resolveReviewedSource() || {};
  const sha = String(resolved.sha || "").trim().toLowerCase();
  const closeout = resolved.closeout || null;
  return FULL_SHA.test(sha)
    ? { sha, label: resolved.label || "the reviewed head", fetchRef: resolved.fetchRef || null, closeout }
    : { sha: null, reason: resolved.reason || "no durable provenance records the reviewed head", recovery: resolved.recovery || null, advice: resolved.advice || null, closeout };
}

// COORD-830 review (third pass), finding 3: when nothing durable names the
// reviewed head, the resolver supplies the steps that create that provenance;
// a placeholder SHA no value can satisfy is never the recovery.
function provenanceRecovery(reviewed) {
  return reviewed.recovery?.length
    ? { advice: reviewed.advice || "resolve the recorded evidence first, then re-run closeout with --source-commit.", steps: reviewed.recovery }
    : null;
}

function bindSourceToProvenance(ticketId, requested, resolveReviewedSource) {
  const reviewed = readReviewedSource(resolveReviewedSource);
  if (!FULL_SHA.test(requested)) {
    return sourceRefusal(ticketId, `source commit "${requested}" is not a full 40-character commit SHA; ` +
      "a branch name, HEAD, or abbreviation is not reviewed-source evidence", reviewed.sha, null, reviewed.closeout);
  }
  if (!reviewed.sha) {
    // COORD-830 review: when provenance itself is ambiguous, re-running with
    // --source-commit cannot help; the resolver names the step that can.
    return sourceRefusal(ticketId, `source commit ${requested} cannot be bound to durable provenance: ${reviewed.reason}`, null, provenanceRecovery(reviewed), reviewed.closeout);
  }
  if (requested.toLowerCase() !== reviewed.sha) {
    return sourceRefusal(ticketId, `source commit ${requested} is not ${reviewed.label} ${reviewed.sha}; ` +
      "an ancestor or any other commit is not the reviewed source", reviewed.sha, null, reviewed.closeout);
  }
  return { reviewed };
}

function unfetchedSourceRefusal(ticketId, sha, ticketRepoRoot, fetchRef, closeout) {
  const fetch = [formatGitCommand(ticketRepoRoot, ["fetch", "origin", sha])];
  if (fetchRef) fetch.push(formatGitCommand(ticketRepoRoot, ["fetch", "origin", fetchRef]));
  return sourceRefusal(ticketId, `source commit "${sha}" does not resolve in ${ticketRepoRoot}; ` +
    "the reviewed head has not been fetched into the ticket repository", sha, {
    advice: `fetch the reviewed head into ${ticketRepoRoot} (${fetch.join(", or ")}), then re-run closeout with --source-commit ${sha}.`,
    steps: [...fetch, ...sourceRecoverySteps(ticketId, sha, closeout)],
  });
}

// COORD-830 review (third pass), finding 4: a live worktree whose HEAD is not
// the reviewed source is usually just on another commit, so "commit or discard
// changes" cannot fix it. Name the reviewed SHA to move the worktree to (a
// branch keeps its name via reset --keep; a detached HEAD checks it out), or the
// release of a lock that is simply stale.
function staleWorktreeRefusal(ticketId, worktree, head, reviewed) {
  const onBranch = gitTry(worktree, ["symbolic-ref", "--quiet", "HEAD"]).status === 0;
  const move = formatGitCommand(worktree, onBranch ? ["reset", "--keep", reviewed.sha] : ["checkout", "--detach", reviewed.sha]);
  const release = `coord/scripts/gov release-lock ${ticketId}`;
  // COORD-830 review (fourth pass), finding 4: moving the worktree back strands
  // any commits beyond the reviewed head, so the first step saves them.
  const kept = String(head || "HEAD");
  const save = formatGitCommand(worktree, ["branch", `${ticketId}-beyond-review-${kept.replace(/[^0-9A-Za-z]/g, "-")}`, kept]);
  return sourceRefusal(ticketId, `the live ticket worktree ${worktree} HEAD ${head || "(unresolvable)"} is not ${reviewed.label} ${reviewed.sha}`, reviewed.sha, {
    // guard:decomposition-proof
    advice: `save its commits (${save}), then move the worktree to the reviewed source (${move}; it refuses rather than overwrite uncommitted changes) or, if the lock is stale, release it (${release}), then re-run closeout with --source-commit ${reviewed.sha}.`,
    steps: [save, move, release, ...sourceRecoverySteps(ticketId, reviewed.sha, reviewed.closeout)],
  });
}

// Proof paths are relative to the workspace parent of coord/. Outside closeout
// (no reviewed-source resolver: doing-state readiness) a live lock keeps
// COORD-826's worktree measurement, and a supplied source commit must be the
// full SHA of its HEAD. In closeout (a resolver is supplied) a worktree is not
// evidence of the reviewed source (human-admin ruling 2026-10-14): the supplied
// source is bound to durable provenance and measured at that commit even while
// a lock lives, and a live worktree whose HEAD disagrees refuses. With neither
// a lock nor a source the gate refuses rather than guessing.
function resolveMeasurementRoot({ ticketId, coordDir, locksDir, repoRoot, sourceCommit, resolveReviewedSource }) {
  const rootDir = path.dirname(coordDir);
  const ticketRepoRoot = repoRoot || coordDir;
  const gitRoot = resolveTicketGitRoot(ticketRepoRoot);
  const requested = String(sourceCommit || "").trim();
  const worktree = readTicketWorktree(locksDir, ticketId);
  const closeout = typeof resolveReviewedSource === "function";
  if (worktree && !closeout) {
    if (requested) {
      const head = resolveCommit(worktree, "HEAD");
      if (!FULL_SHA.test(requested) || requested.toLowerCase() !== head) {
        return sourceRefusal(ticketId, `source commit "${requested}" does not match the live ticket worktree ${worktree} HEAD ${head || "(unresolvable)"}`, head);
      }
    }
    return workingTreeMeasurement(worktree, (file) => path.resolve(worktree, path.relative(gitRoot, path.resolve(rootDir, file))), `the ticket worktree ${worktree}`);
  }
  if (!requested) {
    // In closeout, name the reviewed head (or the steps that create one).
    const reviewed = closeout ? readReviewedSource(resolveReviewedSource) : { sha: null };
    return sourceRefusal(ticketId, worktree
      ? `closeout measures the reviewed source, never the live ticket worktree ${worktree}, and no reviewed source commit was supplied`
      : "the ticket has no live lock and no reviewed source commit was supplied", reviewed.sha, reviewed.sha ? null : provenanceRecovery(reviewed), reviewed.closeout);
  }
  const bound = bindSourceToProvenance(ticketId, requested, resolveReviewedSource);
  if (bound.issue) {
    return bound;
  }
  if (worktree) {
    const head = resolveCommit(worktree, "HEAD");
    if (head !== bound.reviewed.sha) {
      return staleWorktreeRefusal(ticketId, worktree, head, bound.reviewed);
    }
  }
  const sha = resolveCommit(ticketRepoRoot, requested);
  if (!sha) {
    return unfetchedSourceRefusal(ticketId, bound.reviewed.sha, ticketRepoRoot, bound.reviewed.fetchRef, bound.reviewed.closeout);
  }
  return commitMeasurement(gitRoot, rootDir, sha);
}

function proofRepoGateHint(ticketId, file, after) {
  return `coord/scripts/gov update-plan ${ticketId} --repo-gate "decomposition-proof: file=${file}; before=<countLoc before>; after=<${after}>; claimed_reduction=<before-after>; target_max=<max LOC>; budget=<ratchet LOC>; extracted=<functions moved or explicit rationale>"`;
}

// guard:decomposition-proof
function collectDecompositionProofIssues({ ticketId, row, planState, coordDir, locksDir, repoRoot, sourceCommit, resolveReviewedSource }) {
  if (!ticketClaimsDecompositionRefactor(row, planState)) {
    return [];
  }
  const proofEntries = collectDecompositionProofEntries(planState);
  if (proofEntries.length === 0) {
    return [{
      code: "decomposition_proof_missing",
      message: `Refactor ticket ${ticketId} claims slimming/decomposition work but has no computed decomposition-proof entry.`,
      next_steps: [
        proofRepoGateHint(ticketId, "<repo-relative target>", "countLoc after"),
      ],
      severity: "blocker",
    }];
  }

  const measurement = resolveMeasurementRoot({ ticketId, coordDir, locksDir, repoRoot, sourceCommit, resolveReviewedSource });
  if (measurement.issue) {
    return [measurement.issue];
  }
  const issues = [];
  for (const raw of proofEntries) {
    // Every entry was selected for carrying the prefix, so it always parses.
    const { fields } = parseDecompositionProofEntry(raw);
    const file = normalizeProofTargetPath(fields.file || fields.path || fields.target);
    const before = readIntegerProofField(fields, ["before", "before_loc"]);
    const recordedAfter = readIntegerProofField(fields, ["after", "after_loc", "measured_after"]);
    const claimedReduction = readIntegerProofField(fields, ["claimed_reduction", "min_reduction", "reduction"]);
    const targetMax = readIntegerProofField(fields, ["target_max", "target", "max_loc"]);
    const recordedBudget = readIntegerProofField(fields, ["budget", "ratchet_budget", "prodloc_budget", "high_water"]);
    const extracted = fields.extracted || fields.moved || fields.functions || fields.rationale || "";
    const entryIssues = [];

    if (!file) entryIssues.push("file=<repo-relative target> is required");
    if (before === null) entryIssues.push("before=<countLoc before> is required");
    if (recordedAfter === null) entryIssues.push("after=<countLoc after> is required");
    if (claimedReduction === null) entryIssues.push("claimed_reduction=<before-after> is required");
    if (!isMeaningfulText(extracted)) entryIssues.push("extracted=<functions moved> or rationale=<explicit non-extraction rationale> is required");

    let actualAfter = null;
    if (file) {
      const measured = measurement.read(file);
      if (measured.escapes) {
        entryIssues.push(`file=${file} escapes ${measurement.label}`);
      } else if (measured.notFile) {
        entryIssues.push(`file=${file} is a ${measured.notFile}, not a file, in ${measurement.label}`);
      } else if (measured.missing) {
        entryIssues.push(`file=${file} does not exist in ${measurement.label} for countLoc verification`);
      } else {
        actualAfter = countLoc(measured.text).loc;
      }
    }

    if (actualAfter !== null && recordedAfter !== null && actualAfter !== recordedAfter) {
      entryIssues.push(`after=${recordedAfter} does not match computed countLoc=${actualAfter} for ${file} in ${measurement.label}`);
    }
    if (before !== null && actualAfter !== null && before < actualAfter) {
      entryIssues.push(`before=${before} is lower than computed after=${actualAfter}; slimming delta cannot be positive`);
    }
    if (before !== null && actualAfter !== null && claimedReduction !== null) {
      const actualReduction = before - actualAfter;
      if (actualReduction < claimedReduction) {
        entryIssues.push(`computed reduction ${actualReduction} is lower than claimed_reduction=${claimedReduction}`);
      }
    }
    if (actualAfter !== null && targetMax !== null && actualAfter > targetMax) {
      entryIssues.push(`computed countLoc=${actualAfter} exceeds target_max=${targetMax}`);
    }

    const highWater = file ? ARCH_DEFAULT_CONFIG?.checks?.prodloc?.highWater?.[file] : null;
    // COORD-675: cap is a bound; exactness belongs to recordedAfter above.
    // Accept unused headroom without increasing or re-stamping any cap.
    if (actualAfter !== null && highWater !== undefined && highWater !== null && actualAfter > highWater) {
      entryIssues.push(`computed after=${actualAfter} for ${file} exceeds prodloc highWater budget ${highWater}`);
    }
    if (actualAfter !== null && recordedBudget !== null && actualAfter > recordedBudget) {
      entryIssues.push(`computed countLoc=${actualAfter} exceeds recorded budget=${recordedBudget}`);
    }
    if (targetMax === null && recordedBudget === null && (highWater === undefined || highWater === null)) {
      entryIssues.push("target_max=<max LOC> or budget=<ratchet LOC> is required");
    }

    if (entryIssues.length > 0) {
      issues.push({
        // guard:decomposition-proof
        code: "decomposition_proof_invalid",
        message: `Invalid decomposition-proof for ${ticketId}: ${entryIssues.join("; ")}.`,
        next_steps: [
          "Recompute the target with arch-checks countLoc and update the proof entry.",
          proofRepoGateHint(ticketId, file || "<repo-relative target>", "computed countLoc after"),
        ],
        severity: "blocker",
      });
    }
  }
  return issues;
}

module.exports = {
  collectDecompositionProofIssues,
};
