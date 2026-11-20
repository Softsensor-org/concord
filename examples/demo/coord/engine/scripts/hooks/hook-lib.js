"use strict";

// COORD-476 — portable, config-aware parsing helpers for the shipped Claude
// hooks.
//
// Field evidence: stock macOS ships Bash 3.2 (no associative arrays) and BSD
// grep (no PCRE flag), so the previous inline-shell hook parsing failed
// silently on stock macOS. All hook parsing now lives HERE, in unit-tested
// Node code, and the generated hook command strings stay `/bin/sh`-compatible
// with zero GNU-only utilities.
//
// Config awareness: integration branches are resolved from
// `coord/project.config.js` (via `coord/paths.js` when the engine is
// available) — never from a hardcoded branch literal.

const nodePath = require("node:path");
const nodeChildProcess = require("node:child_process");

// Engine fallback default when a repo omits `integrationBranch` entirely.
// Mirrors DEFAULT_INTEGRATION_BRANCH in coord/paths.js; used only when
// coord/paths.js itself cannot be loaded (e.g. minimal fixtures).
const DEFAULT_INTEGRATION_BRANCH = "dev";

// The coord workspace (repo "X", the board) branch FALLBACK. COORD-895: the
// real value is project.config.js `boardBranch` (via coord/paths.js); this
// constant is used only when no config can supply one.
const COORD_WORKSPACE_BRANCH = "main";

function configuredBoardBranch(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : COORD_WORKSPACE_BRANCH;
}

const TICKET_ID_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/;

function extractTicketId(text) {
  const match = String(text || "").match(TICKET_ID_PATTERN);
  return match ? match[0] : null;
}

function extractWorktreePath(text) {
  const s = String(text || "");
  let match = s.match(/worktree=([^\s"']+)/);
  if (match) return match[1];
  match = s.match(/"worktree"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function isGovCommitCommand(text) {
  return /\bgov(?:ernance\.js)?\s+commit\b/.test(String(text || ""));
}

function isGovLandCommand(text) {
  const s = String(text || "");
  return /\bgov(?:ernance\.js)?\s+land\b/.test(s) || /coord\/scripts\/agent\s+land\b/.test(s);
}

function outputReportsMerged(text) {
  return /"status"\s*:\s*"merged"/.test(String(text || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// COORD-664 — classify by WHAT THE COMMAND DOES, not by what its text contains.
//
// The COORD-476 guard matched a regex requiring the protected branch NAME to
// appear in the command text. That misses the PRIMARY case: landing a ticket
// branch means checking out the integration branch and taking a source commit
// BY SHA. Such a command never names the branch — because that branch is where
// you already are. Symmetrically it refused harmless text (`git merge-base
// --is-ancestor <sha> main`, and even a `gov file-ticket --description` whose
// PROSE quoted such a command), because "merge" and "main" were both present
// as substrings.
//
// The fix is to parse instead of to grep: split the command with a quote-aware
// lexer, find the segments whose COMMAND WORD is `git`, read the real
// subcommand (so `merge-base` is not `merge`), and judge that. Prose inside a
// quoted argument to some other program is an argument, never a command.
// ---------------------------------------------------------------------------

// Words that may precede the real command word without changing it.
const COMMAND_PREFIX_WORDS = new Set([
  "env",
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "timeout",
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
]);

// Programs that EXECUTE one of their arguments as a shell command; their
// argument text is re-parsed rather than treated as inert data.
const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);

// COORD-948: subcommand option arguments of the wrappers that may precede `git`.
const PREFIX_VALUE_FLAGS = {
  env: new Set(["-u", "-C", "-S"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-I", "-n", "-d", "-P", "-L", "-s", "-E", "-a"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
};

function wrapperFlagConsumesValue(command, token, valueFlags) {
  if (valueFlags.has(token)) return true;
  if (command !== "timeout") return false;
  if (token.startsWith("--") && token !== "--" && !token.includes("=")) {
    const longOptions = ["--kill-after", "--signal", "--preserve-status", "--foreground", "--verbose", "--help", "--version"];
    const matches = longOptions.filter((option) => option.startsWith(token));
    return matches.length === 1 && valueFlags.has(matches[0]);
  }
  // A signal or kill-after flag at the end of a short cluster takes a separate value.
  return /^-[vfp]*[sk]$/.test(token);
}

// COORD-948: git runs a builtin in preference to an alias of the same name, so a
// builtin subcommand never needs an alias lookup.
const GIT_BUILTIN_SUBCOMMANDS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file",
  "check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index",
  "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-tree", "config",
  "count-objects", "describe", "diff", "diff-files", "diff-index", "diff-tree", "difftool",
  "fast-export", "fast-import", "fetch", "fetch-pack", "fmt-merge-msg", "for-each-ref", "format-patch",
  "fsck", "gc", "grep", "gui", "hash-object", "help", "index-pack", "init", "instaweb", "log",
  "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base",
  "merge-file", "merge-index", "merge-tree", "mergetool", "mktag", "mktree", "multi-pack-index", "mv",
  "name-rev", "notes", "pack-objects", "pack-refs", "patch-id", "prune", "pull", "push", "range-diff",
  "read-tree", "rebase", "receive-pack", "reflog", "remote", "repack", "replace", "request-pull",
  "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "scalar", "shortlog", "show",
  "show-branch", "show-index", "show-ref", "sparse-checkout", "stash", "status", "submodule", "switch",
  "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-pack", "var", "verify-commit", "verify-pack",
  "verify-tag", "version", "whatchanged", "worktree", "write-tree",
]);

// COORD-948: subcommands that move refs. Their words decide whether an
// unresolvable command word is worth refusing.
const REF_MOVING_WORDS = new Set(["push", "merge", "cherry-pick", "pull", "fetch"]);

// COORD-948: a token is statically unresolvable when the shell would expand it:
// a variable, a command substitution, or a backtick. The guard cannot know the
// value, so it may not treat the token as a literal name.
function isUnresolved(token) {
  return /[$`]/.test(String(token === undefined || token === null ? "" : token));
}

// `git` global options that consume the following token as their value, so the
// subcommand is not mistaken for that value (e.g. `git -C api push`).
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

// Subcommand options that consume the following token, so a commit MESSAGE or
// a strategy name is never read as a ref.
const GIT_ARG_VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
  "--into-name",
  "--cleanup",
]);

// `git merge`/`git cherry-pick` in these modes do not take a new commit; they
// abandon or resume an in-progress sequencer operation. Refusing them would
// block recovery, which is the opposite of the control's purpose.
const SEQUENCER_CONTROL_FLAGS = new Set(["--abort", "--continue", "--quit", "--skip"]);

// Push modes whose destination is explicitly NOT "the current branch".
const PUSH_NON_DEFAULT_DESTINATION_FLAGS = new Set(["--all", "--mirror", "--tags"]);

// COORD-930: `pull` moves HEAD (fetch + merge/rebase into the current branch), so
// it is guarded like the other ref-moving commands.
const GIT_MUTATION_SUBCOMMANDS = new Set(["merge", "cherry-pick", "push", "fetch", "pull"]);

// COORD-930: the trusted config root is the workspace that CONTAINS the engine
// install. The engine lives at <workspace>/coord/engine/scripts/hooks, so the
// root is four levels above the hook directory. It is never taken from cwd, the
// target repository, or an environment variable, all of which the caller controls.
function trustedEngineRoot(hooksDir) {
  const dir = nodePath.resolve(hooksDir);
  const tail = dir.split(nodePath.sep).slice(-4).join("/");
  if (tail !== "coord/engine/scripts/hooks") {
    throw new Error(`engine hook directory is not installed at coord/engine/scripts/hooks: ${dir}`);
  }
  return nodePath.resolve(dir, "..", "..", "..", "..");
}

function commandWordBase(token) {
  const s = String(token || "");
  const cut = s.lastIndexOf("/");
  return cut === -1 ? s : s.slice(cut + 1);
}

// Quote-aware lexer. Returns one token array per command segment, where a
// segment ends at a shell separator (`;` `|` `&` newline `(` `)` backtick) that
// is not inside quotes. Quoting is honoured, so `--description "git merge X"`
// stays ONE token belonging to the outer command.
function isSubstitutionStart(src, i) {
  return src[i] === "`" || (src[i] === "$" && src[i + 1] === "(");
}

// Index of the character that closes the substitution opened at `i`. An unclosed
// substitution runs to the end of the text: fail closed, never fail open.
function substitutionEnd(src, i) {
  if (src[i] === "`") {
    const close = src.indexOf("`", i + 1);
    return close === -1 ? src.length - 1 : close;
  }
  let depth = 0;
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === "(") depth += 1;
    else if (src[j] === ")") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return src.length - 1;
}

// COORD-948: the bodies of every $(...) and `...` outside single quotes. The
// shell runs each body, so each one is parsed as a command of its own.
function substitutionBodies(text) {
  const src = String(text || "");
  const bodies = [];
  let single = false;
  let double = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (single) {
      if (ch === "'") single = false;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" && !double) {
      single = true;
      continue;
    }
    if (ch === '"') {
      double = !double;
      continue;
    }
    if (isSubstitutionStart(src, i)) {
      const end = substitutionEnd(src, i);
      bodies.push(src.slice(src[i] === "`" ? i + 1 : i + 2, end));
      i = end;
    }
  }
  return bodies;
}

// Quote-aware lexer. Returns one token array per command segment, where a
// segment ends at a shell separator (`;` `|` `&` newline `(` `)`) that is not
// inside quotes. Quoting is honoured, so `--description "git merge X"` stays ONE
// token belonging to the outer command. COORD-948: a command substitution stays
// inside its word, so `git push origin $(echo main)` has the token `$(echo main)`
// and the guard can see that the refspec is unresolved.
function lexShellSegments(text) {
  const src = String(text || "");
  const segments = [];
  let tokens = [];
  let buf = "";
  let hasBuf = false;
  let quote = null;

  const flushToken = () => {
    if (hasBuf) {
      tokens.push(buf);
      buf = "";
      hasBuf = false;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        buf += ch;
        hasBuf = true;
      }
      continue;
    }
    if (isSubstitutionStart(src, i)) {
      const end = substitutionEnd(src, i);
      buf += src.slice(i, end + 1);
      hasBuf = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < src.length) {
        i += 1;
        buf += src[i];
        hasBuf = true;
      } else {
        buf += ch;
        hasBuf = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasBuf = true;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      i += 1;
      buf += src[i];
      hasBuf = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushToken();
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      flushSegment();
      continue;
    }
    buf += ch;
    hasBuf = true;
  }
  flushSegment();
  return segments;
}

// Every `git` invocation the command would actually EXECUTE, as
// { subcommand, args }. Text that merely mentions git inside an argument of
// another program yields nothing.
// COORD-948: `alias.<name>` is honoured only for non-builtin names, as git does.
function expandInlineAliases(invocation, depth) {
  const aliases = invocation.aliases;
  const name = invocation.subcommand;
  if (!name || GIT_BUILTIN_SUBCOMMANDS.has(name)) return [invocation];
  if (!Object.prototype.hasOwnProperty.call(aliases, name)) return [invocation];
  return expandAliasValue(invocation, aliases[name], depth);
}

// COORD-948: the invocations an alias value runs. A shell alias (`!...`) is code
// the guard cannot read: it is refused as unresolved, and any git command it
// contains is parsed as well.
function expandAliasValue(invocation, value, depth) {
  const aliasDepth = (invocation.aliasDepth || 0) + 1;
  if (depth > 3 || aliasDepth > 4) {
    return [{ ...invocation, unresolved: "alias", token: invocation.subcommand, error: `alias ${invocation.subcommand} expands too deeply` }];
  }
  if (String(value).startsWith("!")) {
    return [
      { ...invocation, subcommand: null, unresolved: "command", token: `!${invocation.subcommand}`, aliasDepth },
      ...parseGitInvocations(String(value).slice(1), depth + 1),
    ];
  }
  const words = lexShellSegments(value)[0] || [];
  if (!words.length) {
    return [{ ...invocation, unresolved: "alias", token: invocation.subcommand, error: `alias ${invocation.subcommand} is empty`, aliasDepth }];
  }
  const next = {
    ...invocation,
    subcommand: words[0],
    args: [...words.slice(1), ...invocation.args],
    token: words[0],
    aliasDepth,
    unresolved: isUnresolved(words[0]) ? "subcommand" : null,
  };
  return expandInlineAliases(next, depth + 1);
}

// Every `git` invocation the command would actually EXECUTE, as
// { subcommand, args, ... }. Text that merely mentions git inside an argument of
// another program yields nothing. COORD-948: command substitutions are parsed as
// commands of their own, and shell wrappers (`sh -c`, `bash -c`, `eval`) have
// every argument parsed, because the argument is the program.
function parseGitInvocations(text, depth = 0) {
  const found = [];
  if (depth > 3) return found;
  for (const body of substitutionBodies(text)) found.push(...parseGitInvocations(body, depth + 1));
  for (const tokens of lexShellSegments(text)) found.push(...parseSegmentInvocations(tokens, depth));
  return found;
}

function parseSegmentInvocations(tokens, depth) {
  let i = 0;
  const assigned = {};
  let viaXargs = false;
  while (i < tokens.length) {
    const assignment = tokens[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (assignment) {
      assigned[assignment[1]] = assignment[2];
      i += 1;
      continue;
    }
    const base = commandWordBase(tokens[i]);
    if (!COMMAND_PREFIX_WORDS.has(base)) break;
    if (base === "xargs") viaXargs = true;
    i += 1;
    const valueFlags = PREFIX_VALUE_FLAGS[base] || new Set();
    while (i < tokens.length && tokens[i].startsWith("-")) i += wrapperFlagConsumesValue(base, tokens[i], valueFlags) ? 2 : 1;
    if (base === "timeout" && i < tokens.length) i += 1;
  }
  if (i >= tokens.length) return [];
  const rest = tokens.slice(i + 1);
  if (isUnresolved(tokens[i])) {
    // The command word itself is unknown. It is only worth refusing when it is
    // asked to move refs; otherwise `$EDITOR file` is an ordinary command.
    if (!rest.some((token) => REF_MOVING_WORDS.has(token))) return [];
    return [
      { subcommand: null, unresolved: "command", token: tokens[i], args: rest, directories: [], gitDir: null, workTree: null, env: { ...assigned }, aliases: {}, viaXargs },
    ];
  }
  const word = commandWordBase(tokens[i]);
  if (word === "git") {
    const invocation = parseGitTokens(rest);
    if (!invocation) return [];
    invocation.env = { ...assigned };
    invocation.viaXargs = viaXargs;
    return expandInlineAliases(invocation, 0);
  }
  if (SHELL_WORDS.has(word)) {
    const found = [];
    for (const argument of rest) found.push(...parseGitInvocations(argument, depth + 1));
    return found;
  }
  return [];
}

// COORD-930: every form that changes which repository a git command targets is
// captured: `-C <dir>` (repeatable, applied in order), `--git-dir`, `--work-tree`
// (space or `=` form). Leading `GIT_DIR=`/`GIT_WORK_TREE=` assignments are
// carried on the invocation as `env`. COORD-948: `-c alias.<name>=<value>` is
// captured so an inline alias resolves to the command it runs.
function parseGitTokens(rest) {
  let i = 0;
  const directories = [];
  let gitDir = null;
  let workTree = null;
  const aliases = {};
  while (i < rest.length && rest[i].startsWith("-")) {
    const flag = rest[i];
    const eq = flag.indexOf("=");
    const name = eq > 0 ? flag.slice(0, eq) : flag;
    const inline = eq > 0 ? flag.slice(eq + 1) : null;
    const value = inline !== null ? inline : rest[i + 1];
    const consumes = inline === null && GIT_GLOBAL_VALUE_FLAGS.has(name);
    if (name === "-C" && value !== undefined) directories.push(value);
    if (name === "--git-dir" && value !== undefined) gitDir = value;
    if (name === "--work-tree" && value !== undefined) workTree = value;
    if (name === "-c" && value !== undefined) {
      const definition = value.match(/^alias\.([^=]+)=([\s\S]*)$/);
      if (definition) aliases[definition[1]] = definition[2];
    }
    i += consumes ? 2 : 1;
  }
  if (i >= rest.length) return null;
  const subcommand = rest[i];
  return {
    subcommand,
    args: rest.slice(i + 1),
    directories,
    directory: directories.length ? directories[directories.length - 1] : null,
    gitDir,
    workTree,
    env: {},
    aliases,
    token: subcommand,
    unresolved: isUnresolved(subcommand) ? "subcommand" : null,
  };
}

// The repository a git invocation really targets, resolved exactly as git itself
// does: `-C` directories apply in order from the acting cwd; `--git-dir` and
// `--work-tree` are relative to that directory; `GIT_DIR`/`GIT_WORK_TREE` come from
// the command's own leading assignments, else from the inherited environment.
function resolveGitTarget(invocation, actingCwd, processEnv = process.env) {
  let cwd = nodePath.resolve(actingCwd || process.cwd());
  for (const dir of (invocation && invocation.directories) || []) cwd = nodePath.resolve(cwd, dir);
  const assigned = (invocation && invocation.env) || {};
  const pick = (flagValue, envName) => {
    const value = flagValue || assigned[envName] || (processEnv && processEnv[envName]) || null;
    return value ? nodePath.resolve(cwd, value) : null;
  };
  return {
    cwd,
    gitDir: pick(invocation && invocation.gitDir, "GIT_DIR"),
    workTree: pick(invocation && invocation.workTree, "GIT_WORK_TREE"),
  };
}

function resolveEffectiveGitRoot(command, actingRoot) {
  const invocation = parseGitInvocations(command).find((entry) => entry.directories && entry.directories.length);
  return resolveGitTarget(invocation || {}, actingRoot).cwd;
}

// Positional (ref-shaped) arguments only: options and the values they consume
// are excluded, so `-m "merge into main"` is not a ref named main.
function positionalArgs(args) {
  const out = [];
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === "--") {
      out.push(...list.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (GIT_ARG_VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// The mutation class of one git invocation, or null when it mutates nothing
// relevant. Exact subcommand equality is what keeps `merge-base` (a read-only
// ancestry query) out of the `merge` class.
function gitMutationKind(invocation) {
  if (!invocation || !GIT_MUTATION_SUBCOMMANDS.has(invocation.subcommand)) return null;
  if (!["push", "fetch"].includes(invocation.subcommand)) {
    const args = Array.isArray(invocation.args) ? invocation.args : [];
    if (args.some((a) => SEQUENCER_CONTROL_FLAGS.has(a))) return null;
  }
  return invocation.subcommand;
}

// COORD-969: option tokens only (values consumed by value flags are skipped, and
// everything after `--` is a path). `-m "--amend"` is therefore not a flag.
function optionTokens(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      out.push(arg);
      if (GIT_ARG_VALUE_FLAGS.has(arg)) i += 1;
    }
  }
  return out;
}

// True when an option token set carries one of the long names, or a short letter
// inside a cluster such as `-fD`.
function hasOption(tokens, longNames, letters) {
  return tokens.some((token) => {
    if (token.startsWith("--")) return longNames.includes(token.split("=")[0]);
    return [...token.slice(1)].some((c) => letters.includes(c));
  });
}

// COORD-969: verbs that rewrite whatever branch HEAD is on. Judged by HEAD only:
// refused on a protected HEAD, allowed on a feature branch. Recovery modes of
// rebase are not rewrites.
function headRewriteKind(invocation) {
  if (!invocation || !GIT_BUILTIN_SUBCOMMANDS.has(invocation.subcommand)) return null;
  const { args } = invocation;
  if (invocation.subcommand === "reset") return "reset";
  if (invocation.subcommand === "rebase") {
    return optionTokens(args).some((a) => SEQUENCER_CONTROL_FLAGS.has(a)) ? null : "rebase";
  }
  if (invocation.subcommand === "commit" && optionTokens(args).includes("--amend")) return "commit --amend";
  return null;
}

// COORD-969: verbs that move or delete a NAMED ref (branch -f/-D/-d/-M/-m/-C,
// checkout -B, switch -C, update-ref). Judged by the ref they name, from any HEAD.
// The moved ref is the first positional, except for branch delete/move/copy, where
// every name is moved. `names` may hold unresolvable tokens; `opaque` marks a form
// whose targets cannot be listed at all (update-ref --stdin).
function namedRefMove(invocation) {
  if (!invocation || !GIT_BUILTIN_SUBCOMMANDS.has(invocation.subcommand)) return null;
  const { args } = invocation;
  const flags = optionTokens(args);
  const positional = positionalArgs(args);
  if (invocation.subcommand === "update-ref") {
    if (flags.includes("--stdin")) return { kind: "update-ref", names: [], opaque: "update-ref --stdin" };
    return { kind: "update-ref", names: positional.slice(0, 1), opaque: null };
  }
  if (invocation.subcommand === "branch") {
    if (!hasOption(flags, ["--force", "--delete", "--move", "--copy"], "fdDmMC")) return null;
    const bulk = hasOption(flags, ["--delete", "--move", "--copy"], "dDmMC");
    return { kind: "branch", names: bulk ? positional : positional.slice(0, 1), opaque: null };
  }
  if (invocation.subcommand === "checkout" && hasOption(flags, [], "B")) {
    return { kind: "checkout -B", names: positional.slice(0, 1), opaque: null };
  }
  if (invocation.subcommand === "switch" && hasOption(flags, ["--force-create"], "C")) {
    return { kind: "switch -C", names: positional.slice(0, 1), opaque: null };
  }
  return null;
}

// Does this ref token name `branch`? Path segments and refspec sides count
// (`origin/main`, `HEAD:main`, `+refs/heads/main`), preserving COORD-476's
// breadth; `main-menu` and `mainline` still do not.
function refMentionsBranch(token, branch) {
  for (const side of String(token).split(":")) {
    for (const segment of side.replace(/^\+/, "").split("/")) {
      if (segment === branch) return true;
    }
  }
  return false;
}

// True when a push's destination is the CURRENT branch by default — no
// explicit refspec was given. This stays destination/refspec semantics; it is
// never a substring search.
function pushUsesDefaultDestination(invocation) {
  const args = Array.isArray(invocation.args) ? invocation.args : [];
  if (args.some((a) => PUSH_NON_DEFAULT_DESTINATION_FLAGS.has(a))) return false;
  // positional 1 is the remote; a refspec would be positional 2+.
  return positionalArgs(args).length < 2;
}

function normalizeBranchList(branches) {
  return (Array.isArray(branches) ? branches : []).filter((b) => b && typeof b === "string");
}

// True when `command` is a manual git mutation (merge / cherry-pick / push)
// that NAMES the given protected branch. Same contract as the COORD-476
// helper — it is one of two independent reasons to refuse — but decided from
// the parsed invocation rather than from a substring of the whole command.
function protectedBranchMutation(command, branches) {
  const list = normalizeBranchList(branches);
  if (!list.length) return null;
  for (const invocation of parseGitInvocations(command)) {
    if (!gitMutationKind(invocation)) continue;
    for (const token of positionalArgs(invocation.args)) {
      for (const branch of list) {
        if (refMentionsBranch(token, branch)) return branch;
      }
    }
  }
  return null;
}

// Read the CURRENT branch from trusted repository state. The answer comes from
// git in the resolved repo — never from the command text, and never from
// anything the caller can put in a payload. A caller that writes
// `git merge feature/x` while standing on a protected branch is judged by
// where it stands.
//
// Outcomes: { ok: true, branch: "<name>" } on a branch; { ok: true,
// detached: true, branch: null } for a trustworthy "not on any branch";
// { ok: false, error } when the question could not be answered at all —
// which callers must treat as "cannot verify", not as "not protected".
function resolveCurrentBranch(target, deps = {}) {
  const execFileSync = deps.execFileSync || nodeChildProcess.execFileSync;
  // COORD-930: accepts a plain directory or a resolved git target
  // ({cwd, gitDir, workTree}) so the branch is read from the repository that the
  // command will actually act on, not the caller's cwd.
  const resolved = typeof target === "object" && target !== null ? target : { cwd: target };
  const root = nodePath.resolve(resolved.cwd || process.cwd());
  const scope = [
    "-C",
    root,
    ...(resolved.gitDir ? ["--git-dir", resolved.gitDir] : []),
    ...(resolved.workTree ? ["--work-tree", resolved.workTree] : []),
  ];
  const git = (args) =>
    String(
      execFileSync("git", [...scope, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }) || ""
    ).trim();

  try {
    const name = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (name) return { ok: true, branch: name, detached: false, source: "git symbolic-ref --short HEAD", error: null };
  } catch {
    /* detached HEAD exits nonzero here by design — ask rev-parse to confirm */
  }
  try {
    const name = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (name && name !== "HEAD") {
      return { ok: true, branch: name, detached: false, source: "git rev-parse --abbrev-ref HEAD", error: null };
    }
    if (name === "HEAD") {
      return { ok: true, branch: null, detached: true, source: "git rev-parse --abbrev-ref HEAD", error: null };
    }
    return {
      ok: false,
      branch: null,
      detached: false,
      source: null,
      error: `git rev-parse --abbrev-ref HEAD in ${root} produced no branch name`,
    };
  } catch (error) {
    return {
      ok: false,
      branch: null,
      detached: false,
      source: null,
      error: `cannot read the current branch in ${root}: ${(error && error.message) || error}`,
    };
  }
}

// COORD-948: a git command that could move refs, or whose subcommand the guard
// cannot classify (an unresolved word, or a non-builtin name that may be an
// alias). Only these reach the decision; `git status` never does.
function isRefMutationCandidate(invocation) {
  if (invocation.unresolved) return true;
  if (gitMutationKind(invocation)) return true;
  if (headRewriteKind(invocation) || namedRefMove(invocation)) return true;
  return !GIT_BUILTIN_SUBCOMMANDS.has(invocation.subcommand);
}

// True when the command needs the protected-branch decision at all.
function gitCommandNeedsDecision(command) {
  return parseGitInvocations(command).some(isRefMutationCandidate);
}

// The first part of a mutation that the guard cannot resolve to a value, or null.
// A target flag or environment value that is unknown means the repository the
// command acts on is unknown, so HEAD cannot be read; an unknown push refspec
// means the destination is unknown.
function unresolvedMutationPart(invocation, kind) {
  for (const directory of invocation.directories) {
    if (isUnresolved(directory)) return `-C ${directory}`;
  }
  if (isUnresolved(invocation.gitDir)) return `--git-dir ${invocation.gitDir}`;
  if (isUnresolved(invocation.workTree)) return `--work-tree ${invocation.workTree}`;
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) {
    const value = invocation.env[name];
    if (isUnresolved(value)) return `${name}=${value}`;
  }
  if (invocation.viaXargs) return "arguments supplied by xargs";
  if (kind === "push" || kind === "fetch") {
    const unknown = positionalArgs(invocation.args).find((token) => isUnresolved(token));
    if (unknown !== undefined) return unknown;
  }
  return null;
}

// `git push --mirror` force-updates and DELETES every remote ref that is not a
// local branch, protected or not. It is never a governed push.
function pushMirrorsAllRefs(invocation) {
  return Array.isArray(invocation.args) && invocation.args.includes("--mirror");
}

// COORD-948: the alias named by `alias.<name>` in the targeted repository. Git
// reads its global and local config, so the answer is trusted repository state.
// Exit status 1 is "not set"; any other failure is "cannot verify".
function configuredAlias(target, name) {
  const scope = [
    "-C",
    target.cwd,
    ...(target.gitDir ? ["--git-dir", target.gitDir] : []),
    ...(target.workTree ? ["--work-tree", target.workTree] : []),
  ];
  try {
    const out = nodeChildProcess.execFileSync("git", [...scope, "config", "--get", `alias.${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).replace(/\r?\n$/, "");
    return { ok: true, value: out === "" ? null : out, error: null };
  } catch (error) {
    if (error.status === 1) return { ok: true, value: null, error: null };
    return { ok: false, value: null, error: `cannot read alias.${name} in ${target.cwd}: ${error.message}` };
  }
}

// The whole protected-branch decision, as a pure function of (command text,
// protected set, trusted branch state). Returns:
//   { risky, blocked, rule, branch, kind }
// rule is one of:
//   "names-protected-branch"   — COORD-476: the command targets a protected ref
//   "head-on-protected-branch" — COORD-664: HEAD is standing on a protected
//                                integration branch and this would land onto it
//   "unverifiable-current-branch" — fail-closed: the branch could not be read
//   "unverifiable-push-targets"   — fail-closed: --all/--mirror could not be listed
//   "mirror-deletes-remote-refs"  — --mirror is never a governed push (COORD-948)
//   "unresolvable-expansion"      — COORD-948 fail-closed: a shell expansion sits
//                                   in a push refspec, a target flag, or a command word
//   "unresolvable-alias"          — COORD-948 fail-closed: an alias could not be read
//   "moves-protected-branch"      — COORD-969: branch -f/-D/-M, checkout -B, switch -C or
//                                   update-ref names a protected ref (any HEAD)
function protectedBranchOperation(command, options = {}) {
  const branches = normalizeBranchList(options.branches);
  const none = { risky: false, blocked: false, rule: null, branch: null, kind: null };
  const candidates = parseGitInvocations(command).filter(isRefMutationCandidate);
  if (!candidates.length) return none;
  if (!branches.length) return { ...none, risky: true };

  // COORD-930: every invocation is judged against the repository IT targets
  // (-C chain, --git-dir, --work-tree, GIT_DIR/GIT_WORK_TREE), resolved from the
  // acting cwd. The caller's cwd is never the policy source.
  const actingCwd = options.actingRoot || process.cwd();
  const processEnv = options.processEnv || process.env;
  const readBranch = typeof options.currentBranchFor === "function" ? options.currentBranchFor : () => options.currentBranch;
  const listBranches = typeof options.listLocalBranches === "function" ? options.listLocalBranches : (target) => listLocalBranches(target);
  const aliasFor = typeof options.aliasFor === "function" ? options.aliasFor : (target, name) => configuredAlias(target, name);

  // COORD-948: a non-builtin subcommand may be an alias. It is looked up in the
  // targeted repository and replaced by the command it runs, so `git p origin main`
  // is judged as the push it is. A lookup that cannot be answered is refused.
  const entries = [];
  const work = candidates.slice();
  while (work.length) {
    const invocation = work.shift();
    if (!invocation.unresolved && !GIT_BUILTIN_SUBCOMMANDS.has(invocation.subcommand) && !gitMutationKind(invocation)) {
      if ((invocation.aliasDepth || 0) >= 4) {
        entries.push({ ...invocation, unresolved: "alias", token: invocation.subcommand, error: `alias ${invocation.subcommand} expands too deeply` });
        continue;
      }
      const looked = aliasFor(resolveGitTarget(invocation, actingCwd, processEnv), invocation.subcommand);
      if (!looked || looked.ok !== true) {
        entries.push({ ...invocation, unresolved: "alias", token: invocation.subcommand, error: (looked && looked.error) || `alias ${invocation.subcommand} was not resolved` });
        continue;
      }
      if (typeof looked.value === "string" && looked.value !== "") {
        work.push(...expandAliasValue(invocation, looked.value, 0));
        continue;
      }
    }
    entries.push(invocation);
  }

  for (const invocation of entries) {
    const target = resolveGitTarget(invocation, actingCwd, processEnv);
    if (invocation.unresolved) {
      return {
        risky: true,
        blocked: true,
        rule: invocation.unresolved === "alias" ? "unresolvable-alias" : "unresolvable-expansion",
        branch: null,
        kind: invocation.subcommand || "git",
        token: invocation.token,
        detail: invocation.error || null,
        target: target.cwd,
      };
    }
    const kind = gitMutationKind(invocation);
    const rewrite = kind ? null : headRewriteKind(invocation);
    const moved = kind || rewrite ? null : namedRefMove(invocation);
    const label = kind || rewrite || (moved && moved.kind);
    if (!label) continue;

    const unresolvedPart = unresolvedMutationPart(invocation, label);
    if (unresolvedPart) {
      return { risky: true, blocked: true, rule: "unresolvable-expansion", branch: null, kind: label, token: unresolvedPart, target: target.cwd };
    }
    if (kind === "push" && pushMirrorsAllRefs(invocation)) {
      return { risky: true, blocked: true, rule: "mirror-deletes-remote-refs", branch: null, kind, target: target.cwd };
    }

    // COORD-969: a verb that moves or deletes a named ref is judged by that ref,
    // from any HEAD. An unresolvable name cannot be certified, so it is refused.
    if (moved) {
      if (moved.opaque) {
        return { risky: true, blocked: true, rule: "unresolvable-expansion", branch: null, kind: label, token: moved.opaque, target: target.cwd };
      }
      for (const name of moved.names) {
        if (isUnresolved(name)) {
          return { risky: true, blocked: true, rule: "unresolvable-expansion", branch: null, kind: label, token: name, target: target.cwd };
        }
        const hit = branches.find((branch) => refMentionsBranch(name, branch));
        if (hit) {
          return { risky: true, blocked: true, rule: "moves-protected-branch", branch: hit, kind: label, token: name, target: target.cwd };
        }
      }
      continue;
    }

    // Destination is "wherever HEAD is": merge, cherry-pick, pull, reset, rebase,
    // commit --amend, or a push with no explicit refspec. HEAD is read from the
    // targeted repository.
    if (rewrite || !["push", "fetch"].includes(kind) || pushUsesDefaultDestination(invocation)) {
      const current = readBranch(target);
      if (!current || current.ok !== true) {
        return {
          risky: true,
          blocked: true,
          rule: "unverifiable-current-branch",
          branch: null,
          kind: label,
          target: target.cwd,
          error: (current && current.error) || "the current branch was not resolved",
        };
      }
      if (current.branch && branches.includes(current.branch)) {
        return {
          risky: true,
          blocked: true,
          rule: "head-on-protected-branch",
          branch: current.branch,
          kind: label,
          source: current.source,
          target: target.cwd,
        };
      }
    }

    // COORD-930: `push --all` names every local branch, protected ones included.
    // Refuse when the targeted repository has any protected branch.
    if (kind === "push" && pushNamesAllBranches(invocation)) {
      const listing = listBranches(target);
      if (!listing || listing.ok !== true) {
        return {
          risky: true,
          blocked: true,
          rule: "unverifiable-push-targets",
          branch: null,
          kind,
          target: target.cwd,
          error: (listing && listing.error) || "local branches were not listed",
        };
      }
      const hit = listing.branches.find((name) => branches.includes(name));
      if (hit) return { risky: true, blocked: true, rule: "names-protected-branch", branch: hit, kind, target: target.cwd };
    }
  }

  // A named protected ref is a destination for push, but a source for merge or
  // cherry-pick. Only the former is blocked on a feature branch; the latter is
  // the ordinary, safe way to refresh a feature branch from main/dev.
  for (const invocation of entries) {
    const kind = gitMutationKind(invocation);
    if (kind !== "push" && kind !== "fetch") continue;
    for (const token of positionalArgs(invocation.args)) {
      for (const branch of branches) {
        if (refMentionsBranch(token, branch) && (kind === "push" || token.includes(":"))) {
          return { risky: true, blocked: true, rule: "names-protected-branch", branch, kind };
        }
      }
    }
  }
  return { ...none, risky: true };
}

function pushNamesAllBranches(invocation) {
  return invocation.args.some((a) => a === "--all" || a === "--mirror");
}

// Local branch names of a resolved git target. Failure is reported, never
// treated as "no branches".
function listLocalBranches(target, deps = {}) {
  const execFileSync = deps.execFileSync || nodeChildProcess.execFileSync;
  try {
    const scope = [
      "-C",
      target.cwd,
      ...(target.gitDir ? ["--git-dir", target.gitDir] : []),
      ...(target.workTree ? ["--work-tree", target.workTree] : []),
    ];
    const out = String(
      execFileSync("git", [...scope, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }) || ""
    );
    return { ok: true, branches: out.split("\n").map((s) => s.trim()).filter(Boolean), error: null };
  } catch (error) {
    return { ok: false, branches: [], error: `cannot list local branches in ${target.cwd}: ${(error && error.message) || error}` };
  }
}

// Resolve the per-repo integration-branch map from project config.
// Order: coord/paths.js (authoritative engine resolution) -> direct
// project.config.js read (fixtures / minimal workspaces) -> error.
// Returns { map: {code: branch}|null, boardBranch, source, error }.
function loadIntegrationBranchMap(rootDir, deps = {}) {
  const requireFn = deps.requireFn || require;
  const root = nodePath.resolve(rootDir || process.cwd());
  try {
    const pathsMod = requireFn(nodePath.join(root, "coord", "paths.js"));
    const paths = pathsMod.createCoordPaths();
    const map = {};
    for (const [code, branch] of Object.entries(paths.repoIntegrationBranches || {})) {
      if (typeof branch === "string" && branch.trim() !== "") map[code] = branch.trim();
    }
    return { map, boardBranch: configuredBoardBranch(paths.boardBranch), source: "coord/paths.js", error: null };
  } catch (pathsError) {
    try {
      const config = requireFn(nodePath.join(root, "coord", "project.config.js"));
      const map = {};
      for (const [code, entry] of Object.entries((config && config.repos) || {})) {
        const branch =
          entry && typeof entry.integrationBranch === "string" && entry.integrationBranch.trim() !== ""
            ? entry.integrationBranch.trim()
            : DEFAULT_INTEGRATION_BRANCH;
        map[code] = branch;
      }
      return { map, boardBranch: configuredBoardBranch(config && config.boardBranch), source: "coord/project.config.js", error: null };
    } catch (configError) {
      return {
        map: null,
        source: null,
        error: `cannot resolve integration branches from ${root} (paths.js: ${pathsError.message}; project.config.js: ${configError.message})`,
      };
    }
  }
}

// The full protected-branch set: every configured repo integration branch
// plus the configured coord workspace (board) branch. Fail-closed callers must
// treat a null `branches` (load error) as "cannot verify".
function loadProtectedBranches(rootDir, deps = {}) {
  const { map, boardBranch, source, error } = loadIntegrationBranchMap(rootDir, deps);
  if (!map) return { branches: null, source, error };
  const set = new Set(Object.values(map));
  set.add(boardBranch);
  return { branches: Array.from(set), source, error: null };
}

// Diff range for post-land advisories: prefer the remote-tracking ref when it
// exists, otherwise the local branch — never a hardcoded branch literal.
function integrationDiffRange(branch, hasRemoteRef) {
  const ref = hasRemoteRef ? `origin/${branch}` : branch;
  return `${ref}~1..${ref}`;
}

// Read TOOL_INPUT/TOOL_OUTPUT the way the settings.json hook commands provide
// them: environment variables first, with a JSON-on-stdin fallback matching
// the Claude Code hook payload shape ({ tool_input, tool_output }).
//
// COORD-660: `stdinText` may be a THUNK. It is invoked only when the
// environment payload does not already answer, so a caller that is fully
// served by env never causes fd 0 to be touched at all. A read that never
// happens cannot lose a race. Acquisition itself lives in
// `coord/scripts/hooks/hook-stdin.js`; this function only parses.
function readHookPayload(env, stdinText) {
  const payload = { toolInput: "", toolOutput: "" };
  if (env && typeof env.TOOL_INPUT === "string" && env.TOOL_INPUT !== "") {
    payload.toolInput = env.TOOL_INPUT;
  }
  if (env && typeof env.TOOL_OUTPUT === "string" && env.TOOL_OUTPUT !== "") {
    payload.toolOutput = env.TOOL_OUTPUT;
  }
  if (payload.toolInput !== "" && payload.toolOutput !== "") return payload;
  if (typeof stdinText === "function") stdinText = stdinText();
  if (stdinText && stdinText.trim() !== "") {
    try {
      const parsed = JSON.parse(stdinText);
      const input = parsed && parsed.tool_input;
      const output = parsed && (parsed.tool_output || parsed.tool_response);
      if (payload.toolInput === "") {
        if (typeof input === "string") payload.toolInput = input;
        else if (input && typeof input.command === "string") payload.toolInput = input.command;
        else if (input) payload.toolInput = JSON.stringify(input);
      }
      if (payload.toolOutput === "") {
        if (typeof output === "string") payload.toolOutput = output;
        else if (output) payload.toolOutput = JSON.stringify(output);
      }
    } catch {
      /* non-JSON stdin: env values already applied */
    }
  }
  return payload;
}

// COORD-660: `readStdinSafe()` USED TO LIVE HERE. It read `process.stdin.isTTY`
// (which materializes the stream and puts fd 0 into O_NONBLOCK) and then did a
// SYNCHRONOUS `readFileSync(0)`, whose EAGAIN was swallowed into `""`. Every
// hook that used it silently treated "I failed to read the payload" as "the
// actor sent an empty payload" — and, in the protected-branch guard, as "there
// is no command here to refuse". It is deliberately GONE rather than repaired
// in place, so no future caller can reach for a synchronous one-shot stdin
// read again. Use `acquireHookPayload()` from
// `coord/scripts/hooks/hook-stdin.js`, which is lazy, stream-based, bounded,
// and reports WHY a payload is missing instead of returning a bare "".

module.exports = {
  COORD_WORKSPACE_BRANCH,
  DEFAULT_INTEGRATION_BRANCH,
  TICKET_ID_PATTERN,
  extractTicketId,
  extractWorktreePath,
  isGovCommitCommand,
  isGovLandCommand,
  outputReportsMerged,
  escapeRegExp,
  lexShellSegments,
  parseGitInvocations,
  resolveEffectiveGitRoot,
  resolveGitTarget,
  listLocalBranches,
  trustedEngineRoot,
  gitMutationKind,
  positionalArgs,
  protectedBranchMutation,
  protectedBranchOperation,
  gitCommandNeedsDecision,
  isUnresolved,
  resolveCurrentBranch,
  loadIntegrationBranchMap,
  loadProtectedBranches,
  integrationDiffRange,
  readHookPayload,
};
