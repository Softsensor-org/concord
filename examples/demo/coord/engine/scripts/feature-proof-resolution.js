"use strict";

// COORD-690: everything about a feature proof — parsing an entry, evaluating it
// against a ref, and resolving WHERE it is reachable — in one module.
//
// It was extracted from governance-validation.js, which the arch-checks
// composition-root policy forbids from receiving new business logic (and whose
// LOC ratchet may only move down). The cohesion is real rather than incidental:
// the reachability resolver added here is the same evaluation the closeout audit
// already ran, applied earlier and against a NAMED ref, so both callers now
// share one definition of what "this proof resolves" means.
//
// Self-contained by design: it derives repo facts from DEFAULT_PATHS instead of
// taking an injected registry, so plan-records can require it directly at the
// point a proof is recorded without threading a new dependency through the
// composition root.

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_INTEGRATION_BRANCH, resolveEngineModule } = require("../../paths.js");

const COORD_DIR = path.resolve(__dirname, "..", "..");
const { gitTry } = require(resolveEngineModule(COORD_DIR, "scripts/git-ops.js"));
const { DEFAULT_PATHS, state } = require(resolveEngineModule(COORD_DIR, "scripts/governance-context.js"));

function gitPathExistsAtRef(repoRoot, refName, filePath) {
  return gitTry(repoRoot, ["cat-file", "-e", `${refName}:${filePath}`]).status === 0;
}

function readTextFileFromRef(repoRoot, refName, filePath) {
  const result = gitTry(repoRoot, ["show", `${refName}:${filePath}`]);
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "");
}

function gitRefContainsLiteral(repoRoot, refName, text) {
  const result = gitTry(repoRoot, ["grep", "-F", "-n", "--", text, refName]);
  return result.status === 0;
}

function parseFeatureProofEntry(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const match = /^([a-z_]+):(.*)$/i.exec(raw);
  if (!match) {
    return {
      raw,
      kind: "invalid",
      valid: false,
      reason: 'use one of "path:", "symbol:", "text:", or "route:"',
    };
  }
  const kind = String(match[1] || "").trim().toLowerCase();
  const remainder = String(match[2] || "").trim();
  if (!remainder) {
    return {
      raw,
      kind,
      valid: false,
      reason: "missing proof value",
    };
  }
  if (kind === "path") {
    return { raw, kind, valid: true, path: remainder };
  }
  if (kind === "text" || kind === "route") {
    return { raw, kind, valid: true, text: remainder };
  }
  if (kind === "symbol") {
    const hashIndex = remainder.indexOf("#");
    if (hashIndex <= 0 || hashIndex === remainder.length - 1) {
      return {
        raw,
        kind,
        valid: false,
        reason: 'use "symbol:<repo-relative-path>#<literal-or-symbol>"',
      };
    }
    return {
      raw,
      kind,
      valid: true,
      path: remainder.slice(0, hashIndex).trim(),
      symbol: remainder.slice(hashIndex + 1).trim(),
    };
  }
  return {
    raw,
    kind,
    valid: false,
    reason: `unsupported proof kind "${kind}"`,
  };
}

function evaluateFeatureProofEntry(repoRoot, refName, entry) {
  if (!entry?.valid) {
    return {
      ok: false,
      reason: entry?.reason || "invalid feature proof entry",
    };
  }
  if (entry.kind === "path") {
    const ok = gitPathExistsAtRef(repoRoot, refName, entry.path);
    return {
      ok,
      reason: ok ? null : `missing path ${entry.path}`,
    };
  }
  if (entry.kind === "symbol") {
    const content = readTextFileFromRef(repoRoot, refName, entry.path);
    if (content === null) {
      return {
        ok: false,
        reason: `missing path ${entry.path}`,
      };
    }
    const ok = content.includes(entry.symbol);
    return {
      ok,
      reason: ok ? null : `missing literal "${entry.symbol}" in ${entry.path}`,
    };
  }
  if (entry.kind === "text" || entry.kind === "route") {
    const ok = gitRefContainsLiteral(repoRoot, refName, entry.text);
    return {
      ok,
      reason: ok ? null : `missing literal "${entry.text}" in repo`,
    };
  }
  return {
    ok: false,
    reason: entry.reason || "invalid feature proof entry",
  };
}

// COORD-690: resolve a feature proof against NAMED refs when it is RECORDED.
//
// The gap this closes was measured on COORD-667: a proof was accepted as
// `symbol:engine/scripts/lifecycle-repox-closeout.js#mergeWorkspaceTicketBranches`
// while grep across the canonical tree returned zero hits — the symbol existed
// only on an unlanded branch. Nothing rejected it, because `add-feature-proof`
// ran pure SYNTAX validation (validateFeatureProofEntry) and the closeout audit
// that does resolve proofs (deriveFeatureProofAudit) returns null for repo "X"
// — `isRepoBackedCode("X")` is false. So for every coord-engine ticket, a
// feature proof was never resolved against anything at all, and the check could
// not tell "proof exists somewhere unreachable" from "proof never existed".
//
// The fix records WHERE the proof resolves. Refs are tried canonical-first, so
// a landed proof reports the canonical ref and an in-flight one reports the
// branch or worktree it actually lives in. A proof that resolves at NO ref is
// refused — that is the "never existed anywhere" case the old check could not
// see. A branch-only or worktree-only resolution is ACCEPTED, because for a
// repo-X ticket the work is unlanded by design; it is simply recorded as such
// instead of being silently indistinguishable from canonical.
const FEATURE_PROOF_REF_KINDS = Object.freeze(["canonical", "branch", "worktree", "unverifiable"]);

function readTicketWorkspaceRef(ticketId) {
  const locksDir = state?.LOCKS_DIR || DEFAULT_PATHS?.locksDir;
  if (!locksDir) {
    return {};
  }
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(locksDir, `${ticketId}.lock`), "utf8"));
    return {
      branch: String(lock?.branch || "").trim() || null,
      worktree: String(lock?.worktree || "").trim() || null,
    };
  } catch {
    return {};
  }
}

function gitRefExists(repoRoot, refName) {
  return gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", `${refName}^{commit}`]).status === 0;
}

function gitRefSha(repoRoot, refName) {
  const result = gitTry(repoRoot, ["rev-parse", refName]);
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

// Evaluates one parsed proof entry against an on-disk working tree rather than
// a commit. This is the seam that keeps the new refusal from firing on honest
// in-flight work: an agent records a proof for code it has written but not yet
// committed, and that is a real resolution at a nameable location.
function evaluateFeatureProofEntryInWorktree(worktreeRoot, entry) {
  if (!entry?.valid) return { ok: false, reason: entry?.reason || "invalid feature proof entry" };
  if (!worktreeRoot) return { ok: false, reason: "no worktree to resolve against" };
  if (entry.kind === "path" || entry.kind === "symbol") {
    let absolute;
    try {
      const realRoot = fs.realpathSync(worktreeRoot);
      absolute = fs.realpathSync(path.resolve(worktreeRoot, entry.path));
      const relative = path.relative(realRoot, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return { ok: false, reason: `proof path escapes the Git worktree root: ${entry.path}` };
      }
    } catch {
      return { ok: false, reason: `missing path ${entry.path}` };
    }
    if (entry.kind === "path") return { ok: true, reason: null };
    try {
      const ok = fs.readFileSync(absolute, "utf8").includes(entry.symbol);
      return { ok, reason: ok ? null : `missing literal "${entry.symbol}" in ${entry.path}` };
    } catch {
      return { ok: false, reason: `unreadable path ${entry.path}` };
    }
  }
  if (entry.kind === "text" || entry.kind === "route") {
    const result = gitTry(worktreeRoot, ["grep", "-F", "-l", "--", entry.text]);
    const ok = result.status === 0;
    return { ok, reason: ok ? null : `missing literal "${entry.text}" in worktree` };
  }
  return { ok: false, reason: entry.reason || "invalid feature proof entry" };
}

// Every proof is recorded relative to its repo dir — a repo-X proof as
// "scripts/coord-cli.js", a repo-B proof as "src/app.js". Whether that prefix
// is also needed to address the file inside git depends on the install
// topology: in the donor template `coord/` and `backend/` are subdirectories of
// one repo, while an installed coord and a real product repo are their own
// roots. `--show-prefix` answers that for the tree actually on disk, instead of
// guessing per topology — and `git show <ref>:<path>` is always repo-root
// relative, so the prefix is exactly what a nested layout needs.
function repoPathPrefixWithinGitRoot(repoRoot) {
  const result = gitTry(repoRoot, ["rev-parse", "--show-prefix"]);
  if (result.status !== 0) {
    return "";
  }
  return String(result.stdout || "").trim();
}

function applyProofPathPrefix(entry, prefix) {
  if (!entry?.path) return entry;
  if (path.posix.isAbsolute(entry.path) || path.win32.isAbsolute(entry.path)) {
    return { ...entry, valid: false, reason: "absolute proof paths are outside the repository-relative contract" };
  }
  // Git tree paths do not normalize dot segments as filesystem reads do.
  const prefixed = prefix && !entry.path.startsWith(prefix) ? `${prefix}${entry.path}` : entry.path;
  const normalized = path.posix.normalize(prefixed);
  if (normalized === ".." || normalized.startsWith("../")) {
    return { ...entry, valid: false, reason: "proof path escapes the Git root" };
  }
  return { ...entry, path: normalized === "." ? "" : normalized };
}

// The ordered refs a proof for `ticketId` may resolve at. Canonical first: a
// proof that is already landed must never be recorded as branch-only.
//
// Repo X has no configured integration branch (it is the coord engine itself,
// not a product repo), so its canonical ref is the canonical tree's HEAD —
// which is exactly the "canonical tree" a COORD-690-style grep searches.
// Repo facts come from DEFAULT_PATHS rather than the injected repo registry, so
// this module stays require-able from the record path. A repo code the caller
// already knows is preferred; otherwise it is inferred from the ticket prefix
// the same way the registry's fallback does.
function repoCodeForTicket(ticketId, explicitRepoCode) {
  if (explicitRepoCode) {
    return explicitRepoCode;
  }
  const normalized = String(ticketId || "").trim().toUpperCase();
  const dashIndex = normalized.indexOf("-");
  const prefix = dashIndex > 0 ? normalized.slice(0, dashIndex) : "";
  return DEFAULT_PATHS.ticketPrefixToRepoCode?.[prefix] || "X";
}

// COORD-690 (review round 1): for repo X, "canonical" must mean the branch the
// MAIN working tree has checked out, not the HEAD of whatever tree the engine
// happens to be running in.
//
// The engine runs from the canonical tree for governance verbs and from a
// linked worktree for code, so a bare "HEAD" silently means main in one case
// and the ticket's own unlanded branch in the other — which would label a
// branch-only proof "canonical" and erase the very distinction this resolution
// exists to draw. `git worktree list` names the main working tree's branch
// unambiguously from inside either one. Repo X has no configured integration
// branch (it is the coord engine, not a product repo), which is why this is
// derived rather than read from config.
function mainWorktreeBranch(repoRoot) {
  const result = gitTry(repoRoot, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    return null;
  }
  for (const line of String(result.stdout || "").split("\n")) {
    // The first block is always the main working tree; its branch line ends it.
    const match = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

function featureProofCandidateRefs(ticketId, options = {}) {
  const repoCode = repoCodeForTicket(ticketId, options.repoCode);
  const configuredRoot = DEFAULT_PATHS.repoRoots?.[repoCode];
  const repoBacked = Boolean(repoCode && repoCode !== "X" && configuredRoot);
  // A configured repo whose working copy is absent (a partial checkout, a
  // renamed repo, a template install) yields NO searchable refs. That is a
  // different answer from "the proof is not there", so it produces an empty
  // candidate list — reported as unverifiable — rather than a refusal.
  if (repoBacked && !fs.existsSync(configuredRoot)) {
    return [];
  }
  const repoRoot = repoBacked ? configuredRoot : DEFAULT_PATHS.coordDir;
  const pathPrefix = repoPathPrefixWithinGitRoot(repoRoot);
  const workspace = readTicketWorkspaceRef(ticketId);
  const integrationBranch = String(
    DEFAULT_PATHS.repoIntegrationBranches?.[repoCode] || DEFAULT_INTEGRATION_BRANCH
  ).trim();

  const candidates = [];
  // Repo X is the coord engine itself and has no configured integration branch,
  // so its canonical ref is the canonical tree's HEAD — exactly the tree a
  // "does this symbol exist?" grep searches.
  const canonicalRefs = repoBacked
    ? [`origin/${integrationBranch}`, integrationBranch, "HEAD"]
    : [mainWorktreeBranch(repoRoot), "HEAD"].filter(Boolean);
  for (const ref of canonicalRefs) {
    if (gitRefExists(repoRoot, ref)) {
      candidates.push({ ref, ref_kind: "canonical", repoRoot, pathPrefix });
      break;
    }
  }
  if (workspace.branch && gitRefExists(repoRoot, workspace.branch)) {
    candidates.push({ ref: workspace.branch, ref_kind: "branch", repoRoot, pathPrefix });
  }
  if (workspace.worktree && fs.existsSync(workspace.worktree)) {
    candidates.push({ ref: workspace.worktree, ref_kind: "worktree", repoRoot: workspace.worktree, pathPrefix });
  }
  return candidates;
}

// Returns { resolved, ref, ref_kind, sha, attempted[] }. `attempted` is kept on
// the failure path so the refusal message can say WHICH refs were searched —
// "not found" is only actionable when the search space is named.
function resolveFeatureProofReachability(ticketId, entryValue, options = {}) {
  const raw = String(entryValue || "").trim();
  const entry = parseFeatureProofEntry(raw);
  if (!entry?.valid) {
    return { resolved: false, unverifiable: false, entry: raw, ref: null, ref_kind: null, sha: null, attempted: [], reason: entry?.reason || "invalid feature proof entry" };
  }
  const candidates = options.candidates || featureProofCandidateRefs(ticketId, options);
  const attempted = [];
  for (const candidate of candidates) {
    const candidateEntry = applyProofPathPrefix(entry, candidate.pathPrefix);
    const evaluation = candidate.ref_kind === "worktree"
      ? evaluateFeatureProofEntryInWorktree(candidate.repoRoot, candidateEntry)
      : evaluateFeatureProofEntry(candidate.repoRoot, candidate.ref, candidateEntry);
    attempted.push({ ref: candidate.ref, ref_kind: candidate.ref_kind, ok: evaluation.ok, reason: evaluation.reason });
    if (evaluation.ok) {
      return {
        resolved: true,
        entry: raw,
        ref: candidate.ref,
        ref_kind: candidate.ref_kind,
        sha: candidate.ref_kind === "worktree" ? null : gitRefSha(candidate.repoRoot, candidate.ref),
        attempted,
        reason: null,
      };
    }
  }
  // "Searched everywhere and found nothing" and "had nowhere to search" are
  // different findings, and collapsing them is the very confusion this ticket
  // exists to remove. Only the first is a refusal; the second is recorded as
  // unverifiable, so the plan record states plainly that no ref was searchable
  // rather than implying a proof was checked.
  if (attempted.length === 0) {
    return {
      resolved: false,
      unverifiable: true,
      entry: raw,
      ref: null,
      ref_kind: "unverifiable",
      sha: null,
      attempted,
      reason: "no canonical, branch, or worktree ref was available to resolve against",
    };
  }
  return {
    resolved: false,
    unverifiable: false,
    entry: raw,
    ref: null,
    ref_kind: null,
    sha: null,
    attempted,
    reason: attempted.map((item) => `${item.ref_kind}:${item.ref} (${item.reason})`).join("; "),
  };
}


module.exports = {
  FEATURE_PROOF_REF_KINDS,
  applyProofPathPrefix,
  evaluateFeatureProofEntry,
  evaluateFeatureProofEntryInWorktree,
  featureProofCandidateRefs,
  gitPathExistsAtRef,
  mainWorktreeBranch,
  gitRefContainsLiteral,
  parseFeatureProofEntry,
  readTextFileFromRef,
  resolveFeatureProofReachability,
};
