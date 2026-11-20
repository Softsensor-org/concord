"use strict";

// COORD-892: keep a product clone's `git status` clean while governed ticket
// worktrees live inside it.
//
// `gov start` provisions a product-repo ticket worktree at
// <repoRoot>/.worktrees/<owner>/<ticket> (worktree-ops defaultWorktreePath).
// That directory sits inside the product clone's own working tree, and nothing
// in an adopter's product repository ignores it, so the clone reports
// `?? .worktrees/`. Adopters must not have to edit (and commit) the product
// repository's .gitignore to hide governance plumbing.
//
// The fix writes ONLY the clone-local, never-tracked exclude file
// <git-common-dir>/info/exclude. The common dir (not the per-worktree git dir)
// is used so a linked product checkout shares one rule with its main clone.
// The anchored pattern is computed from `git rev-parse --show-prefix`, so a
// product directory that is a subdirectory of an enclosing repository (the
// donor layout) gets `/<prefix>.worktrees/`, never a repository-wide match.
//
// Every operation is idempotent and best-effort: an existing ignore rule (in a
// tracked .gitignore, the exclude file or core.excludesFile) is respected and
// nothing is written.

const fs = require("node:fs");
const path = require("node:path");
const { gitTry: defaultGitTry, shellQuote } = require("./git-ops.js");

const WORKTREES_DIRNAME = ".worktrees";
const EXCLUDE_COMMENT = "# coord: governed ticket worktrees stay out of this clone's status (COORD-892)";

function gitLine(gitTry, dir, args) {
  const result = gitTry(dir, args);
  return result && result.status === 0 ? String(result.stdout || "").replace(/\r?\n$/, "") : null;
}

function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

// Read-only. `applicable: false` means repoRoot is not inside a Git working
// tree (or Git could not answer), so there is nothing to keep clean.
function inspectProductWorktreeExclude({ repoRoot, gitTry = defaultGitTry } = {}) {
  const root = path.resolve(String(repoRoot || "."));
  const worktreesRoot = path.join(root, WORKTREES_DIRNAME);
  const prefix = gitLine(gitTry, root, ["rev-parse", "--show-prefix"]);
  const commonDir = gitLine(gitTry, root, ["rev-parse", "--git-common-dir"]);
  if (prefix === null || !commonDir) {
    return { applicable: false, worktrees_root: worktreesRoot };
  }
  const probe = gitTry(root, ["check-ignore", "-q", `${WORKTREES_DIRNAME}/`]);
  if (!probe || (probe.status !== 0 && probe.status !== 1)) {
    return { applicable: false, worktrees_root: worktreesRoot };
  }
  const pattern = `/${prefix}${WORKTREES_DIRNAME}/`;
  const excludePath = path.join(path.resolve(root, commonDir), "info", "exclude");
  const ignored = probe.status === 0;
  const present = fs.existsSync(worktreesRoot);
  return {
    applicable: true,
    ignored,
    present,
    visible: present && !ignored,
    pattern,
    exclude_path: excludePath,
    exclude_has_pattern: readTextOrEmpty(excludePath).split(/\r?\n/).some((line) => line.trim() === pattern),
    worktrees_root: worktreesRoot,
  };
}

// Idempotent. Appends the anchored pattern to info/exclude only when Git does
// not already ignore the worktree root and the exact line is not there yet (a
// tracked negation such as `!.worktrees/` outranks info/exclude; duplicating
// the line would not help, so doctor reports that case instead).
function ensureProductWorktreeExclude({ repoRoot, gitTry = defaultGitTry } = {}) {
  const inspection = inspectProductWorktreeExclude({ repoRoot, gitTry });
  if (!inspection.applicable || inspection.ignored || inspection.exclude_has_pattern) {
    return { ...inspection, changed: false };
  }
  const current = readTextOrEmpty(inspection.exclude_path);
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(inspection.exclude_path), { recursive: true });
  fs.appendFileSync(inspection.exclude_path, `${separator}${EXCLUDE_COMMENT}\n${inspection.pattern}\n`, "utf8");
  return { ...inspection, exclude_has_pattern: true, changed: true };
}

// Doctor wording: null unless the worktree root is present and visible.
function formatProductWorktreeExcludeWarning(repoName, inspection) {
  if (!inspection || !inspection.applicable || !inspection.visible) return null;
  const head = `[worktree-visibility] ${repoName}: the governed worktree root ${inspection.worktrees_root} ` +
    "shows as an untracked folder in that product clone's git status.";
  if (inspection.exclude_has_pattern) {
    return `${head} ${inspection.exclude_path} already lists ${inspection.pattern}, so a higher-precedence rule ` +
      `(for example \`!${WORKTREES_DIRNAME}/\` in a tracked .gitignore) re-includes it; the product repository owner must decide that rule.`;
  }
  return `${head} Remedy (clone-local, never committed; do not edit the product .gitignore): ` +
    `\`printf '%s\\n' ${shellQuote(inspection.pattern)} >> ${shellQuote(inspection.exclude_path)}\`. ` +
    `The next gov start or resume of a ${repoName} ticket adds the same rule automatically.`;
}

module.exports = {
  WORKTREES_DIRNAME,
  EXCLUDE_COMMENT,
  inspectProductWorktreeExclude,
  ensureProductWorktreeExclude,
  formatProductWorktreeExcludeWarning,
};
