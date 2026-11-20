"use strict";

// COORD-072: single-sourced raw git invocation. Every engine module that shells
// out to git routes through gitTry so the `git -C <dir> ...` argv shape and the
// default `encoding: "utf8"` capture policy live in exactly one place. Callers
// keep their own status check + (often bespoke) failure message; gitTry never
// throws and returns the raw spawnSync result.
//
// runGit / gitOutput are the two generic-message convenience wrappers that
// previously lived inline in worktree-ops.js. They take an explicit `fail`
// (the caller's DI failure thunk) so GovernanceError semantics are unchanged.

const { spawnSync } = require("child_process");

// Tolerant primitive. Runs `git -C <dir> <...args>` and returns the raw
// spawnSync result ({ status, stdout, stderr, ... }) without throwing.
// Defaults to encoding:"utf8"; pass options (e.g. { stdio: "ignore" } or
// { stdio: "inherit" }) to override capture behavior exactly as a bare
// spawnSync call would. options spreads last so an explicit stdio wins over
// the default encoding.
function gitTry(dir, args, options = {}) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", ...options });
}

// COORD-985: null-on-failure policy for engine readers that treat a failed git call as "no answer".
// Returns the UNTRIMMED stdout on exit 0 and null on any other outcome. Callers that need a trimmed
// value trim it themselves, so the bytes a digest or diff reads stay exactly as git printed them.
function gitOrNull(dir, args, options = {}) {
  const result = gitTry(dir, args, options);
  return result.status === 0 ? result.stdout : null;
}

// Generic-message wrapper mirroring the historical worktree-ops runGit:
// inherits stdio (interactive), throws via `fail` on nonzero status.
function runGit(fail, repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed in ${repoRoot}.`);
  }
}

// Generic-message wrapper mirroring the historical worktree-ops gitOutput:
// captures utf8 stdout, throws via `fail` (stderr-preferred) on nonzero status,
// returns stdout as a string.
function gitOutput(fail, repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail((result.stderr || "").trim() || `git ${args.join(" ")} failed in ${repoRoot}.`);
  }
  return String(result.stdout || "");
}

// COORD-856: the ONE quoting rule for every command an engine message prints
// for an operator to copy. A filesystem path (or any other interpolated word)
// is POSIX single-quoted unless it is made only of characters no shell treats
// specially, so a path holding a space, parentheses or `$` is one literal word
// when pasted, and ordinary paths print exactly as before. An embedded single
// quote closes the quote, emits an escaped quote and reopens it.
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
function shellQuote(value) {
  const text = String(value);
  return SHELL_SAFE_WORD.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

// The printed twin of gitTry's argv: `git -C <dir> <...args>` with every word
// quoted by shellQuote.
function formatGitCommand(dir, args = []) {
  return ["git", "-C", dir, ...args].map(shellQuote).join(" ");
}

module.exports = { gitTry, gitOrNull, runGit, gitOutput, shellQuote, formatGitCommand };
