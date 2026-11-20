"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

// Paths are Git-relative literals, not shell words or pathspecs. In particular,
// whitespace and backslashes on POSIX are meaningful filename characters.
function literalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid declared commit path ${JSON.stringify(value)}; use a repository-relative literal path.`);
  }
  return value;
}

function declaredScope(record, { workspaceRoot, repoRoot }) {
  const entries = record?.intended_files;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Commit requires declared intended_files; use gov update-plan --files before committing.");
  }
  const relativeRoot = path.relative(workspaceRoot, repoRoot).split(path.sep).join("/");
  if (relativeRoot.startsWith("../") || relativeRoot === ".." || path.isAbsolute(relativeRoot)) {
    throw new Error("Cannot map commit scope for a repository outside the configured workspace.");
  }
  return [...new Set(entries.map((entry) => {
    if (typeof entry !== "string" || /^\s*TODO\b/i.test(entry) ||
        /(?:^|\/)\.worktrees\//.test(entry)) {
      throw new Error("Commit scope contains a scaffold placeholder; declare concrete paths with gov update-plan --files.");
    }
    // Workspace-qualified declarations take precedence when they explicitly
    // name this registered repository. Other declarations are repo-relative.
    // Never add both interpretations as aliases.
    const candidate = relativeRoot && entry.startsWith(`${relativeRoot}/`)
      ? entry.slice(relativeRoot.length + 1) : entry;
    return literalPath(candidate.endsWith("/") ? candidate.slice(0, -1) : candidate);
  }))];
}

function checkPaths(staged, scope, acknowledgements) {
  const outsiders = staged.filter((file) => !scope.some((entry) => file === entry || file.startsWith(`${entry}/`)));
  const ack = [...new Set(acknowledgements.map(literalPath))];
  const missing = outsiders.filter((file) => !ack.includes(file));
  const extra = ack.filter((file) => !outsiders.includes(file));
  if (missing.length || extra.length) {
    // guard:commit-scope
    throw new Error(
      `Commit scope refused. Outside declared scope: ${JSON.stringify(outsiders)}. ` +
      `Unacknowledged: ${JSON.stringify(missing)}. Unmatched acknowledgements: ${JSON.stringify(extra)}. ` +
      "Declare the intended scope with gov update-plan --files, or explicitly name each exception with --ack-outside-scope <exact Git-relative path>."
    );
  }
  return outsiders;
}

function gitBytes(gitTry, root, args, env) {
  const result = gitTry(root, args, { encoding: null, env });
  if (result.status !== 0) {
    throw new Error(`Commit preflight git ${args[0]} failed: ${String(result.stderr || result.error || "unknown Git failure")}`);
  }
  return result.stdout;
}

function decodePaths(bytes) {
  // Replacing malformed UTF-8 could equate two distinct paths in JSON evidence.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return text.split("\0").filter(Boolean);
}

function readIndex(indexPath) {
  try { return fs.readFileSync(indexPath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameIndex(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

// Evaluate git add against a disposable index before changing the real index.
// Git may write blobs, but this path cannot create a commit. A governance lock
// does not serialize arbitrary external Git clients or user hooks: detect a
// changed HEAD/index at admission and recheck the actual staged set before the
// normal commit. Never restore/copy an index over another writer's changes.
function prepareCommitScope({ gitTry, worktree, record, layout, repoRoot, files, all, acknowledgements = [] }) {
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"]) {
    if (process.env[name]) throw new Error(`Commit scope cannot use ambient ${name}; unset the Git override.`);
  }
  const scope = declaredScope(record, { workspaceRoot: layout.workspaceRoot, repoRoot });
  const env = { ...process.env };
  const indexPath = gitBytes(gitTry, worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"], env).toString("utf8").trim();
  const originalIndex = readIndex(indexPath);
  const head = () => {
    const result = gitTry(worktree, ["rev-parse", "--verify", "HEAD"], { env });
    if (result.status === 0) return String(result.stdout).trim();
    // An unborn branch is valid; other failures must not masquerade as one.
    gitBytes(gitTry, worktree, ["symbolic-ref", "HEAD"], env);
    return null;
  };
  const originalHead = head();
  const addArgs = files.length === 0 || all ? ["add", "-A"] : ["add", "--", ...files];
  const stagedPaths = (gitEnv) => decodePaths(gitBytes(gitTry, worktree,
    ["diff", "--cached", "--name-only", "--no-renames", "-z"], gitEnv));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "concord-commit-index-"));
  let staged;
  try {
    const temporaryIndex = path.join(scratch, "index");
    const temporaryEnv = { ...env, GIT_INDEX_FILE: temporaryIndex };
    if (originalIndex !== null) fs.writeFileSync(temporaryIndex, originalIndex);
    else gitBytes(gitTry, worktree, ["read-tree", "--empty"], temporaryEnv);
    gitBytes(gitTry, worktree, addArgs, temporaryEnv);
    staged = stagedPaths(temporaryEnv);
    checkPaths(staged, scope, acknowledgements);
    if (!staged.length) throw new Error("Ticket has no staged changes to commit.");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    addArgs,
    stagedFiles: staged,
    assertUnchanged() {
      if (head() !== originalHead || !sameIndex(originalIndex, readIndex(indexPath))) {
        throw new Error("Commit preflight became stale: HEAD or index changed; retry after coordinating Git writers.");
      }
    },
    validateStaged() {
      // guard:commit-scope
      if (head() !== originalHead) throw new Error("HEAD changed while staging; commit refused.");
      const actual = stagedPaths(env);
      const admitted = checkPaths(actual, scope, acknowledgements);
      if (JSON.stringify(actual) !== JSON.stringify(staged)) {
        throw new Error("Staged path set changed after preflight; commit refused without overwriting the index.");
      }
      return { declared_files: [...record.intended_files], staged_files: actual, acknowledged_outside_scope: admitted };
    },
  };
}

module.exports = { declaredScope, checkPaths, prepareCommitScope };
