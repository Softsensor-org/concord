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

// The coord workspace (repo "X") integration base. Mirrors the engine's
// closeout base for non-repo-backed tickets (coord/scripts/closeout.js).
const COORD_WORKSPACE_BRANCH = "main";

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
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
]);

// Programs that EXECUTE one of their arguments as a shell command; their
// argument text is re-parsed rather than treated as inert data.
const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);

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

const GIT_MUTATION_SUBCOMMANDS = new Set(["merge", "cherry-pick", "push"]);

function commandWordBase(token) {
  const s = String(token || "");
  const cut = s.lastIndexOf("/");
  return cut === -1 ? s : s.slice(cut + 1);
}

// Quote-aware lexer. Returns one token array per command segment, where a
// segment ends at a shell separator (`;` `|` `&` newline `(` `)` backtick) that
// is not inside quotes. Quoting is honoured, so `--description "git merge X"`
// stays ONE token belonging to the outer command.
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
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < src.length) {
        i += 1;
        buf += src[i];
        hasBuf = true;
        continue;
      }
      buf += ch;
      hasBuf = true;
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
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "`") {
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
function parseGitInvocations(text, depth = 0) {
  const found = [];
  if (depth > 3) return found;
  for (const tokens of lexShellSegments(text)) {
    let i = 0;
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || COMMAND_PREFIX_WORDS.has(commandWordBase(tokens[i])))
    ) {
      i += 1;
    }
    if (i >= tokens.length) continue;
    const word = commandWordBase(tokens[i]);
    if (word === "git") {
      const invocation = parseGitTokens(tokens.slice(i + 1));
      if (invocation) found.push(invocation);
      continue;
    }
    // `sh -c "git merge <sha>"` really does run git: re-parse the argument.
    if (SHELL_WORDS.has(word)) {
      for (const argument of tokens.slice(i + 1)) {
        if (/(?:^|[\s;&|])git(?:\s|$)/.test(argument)) found.push(...parseGitInvocations(argument, depth + 1));
      }
    }
  }
  return found;
}

function parseGitTokens(rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    if (GIT_GLOBAL_VALUE_FLAGS.has(rest[i])) i += 1;
    i += 1;
  }
  if (i >= rest.length) return null;
  return { subcommand: rest[i], args: rest.slice(i + 1) };
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
  if (invocation.subcommand !== "push") {
    const args = Array.isArray(invocation.args) ? invocation.args : [];
    if (args.some((a) => SEQUENCER_CONTROL_FLAGS.has(a))) return null;
  }
  return invocation.subcommand;
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
function resolveCurrentBranch(rootDir, deps = {}) {
  const execFileSync = deps.execFileSync || nodeChildProcess.execFileSync;
  const root = nodePath.resolve(rootDir || process.cwd());
  const git = (args) =>
    String(
      execFileSync("git", ["-C", root, ...args], {
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

// The whole protected-branch decision, as a pure function of (command text,
// protected set, trusted branch state). Returns:
//   { risky, blocked, rule, branch, kind }
// rule is one of:
//   "names-protected-branch"   — COORD-476: the command targets a protected ref
//   "head-on-protected-branch" — COORD-664: HEAD is standing on a protected
//                                integration branch and this would land onto it
//   "unverifiable-current-branch" — fail-closed: the branch could not be read
function protectedBranchOperation(command, options = {}) {
  const branches = normalizeBranchList(options.branches);
  const invocations = parseGitInvocations(command)
    .map((invocation) => ({ invocation, kind: gitMutationKind(invocation) }))
    .filter((entry) => entry.kind);

  const none = { risky: false, blocked: false, rule: null, branch: null, kind: null };
  if (!invocations.length) return none;
  if (!branches.length) return { ...none, risky: true };

  const named = protectedBranchMutation(command, branches);
  if (named) {
    const kind = invocations.find(({ invocation }) =>
      positionalArgs(invocation.args).some((token) => refMentionsBranch(token, named))
    );
    return { risky: true, blocked: true, rule: "names-protected-branch", branch: named, kind: kind ? kind.kind : null };
  }

  // Operations whose destination is "wherever HEAD is" — a merge, a
  // cherry-pick, or a push with no explicit refspec.
  const headSensitive = invocations.filter(
    ({ invocation, kind }) => kind !== "push" || pushUsesDefaultDestination(invocation)
  );
  if (!headSensitive.length) return { ...none, risky: true };

  const current = options.currentBranch;
  if (!current || current.ok !== true) {
    return {
      risky: true,
      blocked: true,
      rule: "unverifiable-current-branch",
      branch: null,
      kind: headSensitive[0].kind,
      error: (current && current.error) || "the current branch was not resolved",
    };
  }
  if (current.branch && branches.includes(current.branch)) {
    return {
      risky: true,
      blocked: true,
      rule: "head-on-protected-branch",
      branch: current.branch,
      kind: headSensitive[0].kind,
      source: current.source,
    };
  }
  return { ...none, risky: true };
}

// Resolve the per-repo integration-branch map from project config.
// Order: coord/paths.js (authoritative engine resolution) -> direct
// project.config.js read (fixtures / minimal workspaces) -> error.
// Returns { map: {code: branch}|null, source, error }.
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
    return { map, source: "coord/paths.js", error: null };
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
      return { map, source: "coord/project.config.js", error: null };
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
// plus the coord workspace base. Fail-closed callers must treat a null
// `branches` (load error) as "cannot verify".
function loadProtectedBranches(rootDir, deps = {}) {
  const { map, source, error } = loadIntegrationBranchMap(rootDir, deps);
  if (!map) return { branches: null, source, error };
  const set = new Set(Object.values(map));
  set.add(COORD_WORKSPACE_BRANCH);
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
  gitMutationKind,
  positionalArgs,
  protectedBranchMutation,
  protectedBranchOperation,
  resolveCurrentBranch,
  loadIntegrationBranchMap,
  loadProtectedBranches,
  integrationDiffRange,
  readHookPayload,
};
