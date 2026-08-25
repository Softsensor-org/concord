"use strict";

// COORD-645 — pure, injectable decision core for the runtime authority write
// barrier (`coord/scripts/runtime-authority-hook.js`).
//
// WHY THIS MODULE EXISTS
// ---------------------
// The shipped hook computed its authority from `process.cwd()`: it looked for
// an active `doing` lock whose worktree CONTAINED the cwd, and if it found
// none it fell straight through to `process.exit(0)`. So the barrier engaged
// only for a session already confined to a ticket worktree and disengaged
// completely for a session sitting in the CANONICAL tree — the shared,
// commit-visible checkout, which is the only place an unattributed write can
// be swept into somebody else's commit. That is exactly what happened on
// 2026-08-04 (COORD-645): with an active `doing` lock held by another session,
// canonical-root edits to two governed files were permitted, landed in a
// foreign commit, and had to be re-attributed by hand.
//
// It is the same shape as the two fail-opens closed under COORD-635 —
// ABSENCE OF EVIDENCE READ AS PERMISSION. Three defects of that class are
// repaired here:
//
//   1. no cwd-matching lock  -> permit everything           (the reported one)
//   2. payload shape not the one `evaluateToolCall` expects -> zero target
//      paths extracted -> "no write targets" -> permit      (silent inertness)
//   3. unresolvable actor identity -> treated as authorized (the inversion)
//
// DESIGN CONSTRAINTS
// ------------------
// * PURE + INJECTABLE. Nothing here reads `process.env`, touches the
//   filesystem, or calls `process.exit`. Locks, identity, cwd, env and the
//   tool payload are handed in. The live wired wrapper is therefore a thin
//   adapter and every proof in `runtime-authority-decision.test.js` runs
//   against this module rather than against the live hook.
// * FAIL-CLOSED IS SCOPED, NOT BLANKET. Refusal applies at ONE applicable
//   authority boundary: an active governed lock exists AND the write targets
//   the canonical tree. With no active lock, or outside the workspace, the
//   barrier deliberately stays out of the way — a barrier that refuses
//   everything gets disabled, and a disabled barrier protects nothing.
// * IDENTITY IS CORROBORATION, NOT AUTHENTICATION. When an actor DOES resolve,
//   it resolves owner-authoritatively (identity v2, `coord/GOVERNANCE.md`):
//   from the cwd-independent provider identity exported by
//   `coord/scripts/hooks/session-start.js` to a registered handle / owner
//   lease, with legacy lock `session_id` / `thread_id` carried as MIGRATION AND
//   COLLISION DIAGNOSTICS ONLY. But the channel it arrives on is actor-
//   controlled (see TRUST MODEL), so resolution is never treated as proof of
//   who is acting: it may only ADD refusals. Nothing here authenticates
//   anybody, and the canonical boundary does not consult it at all.
//
// TRUST MODEL (ADR-0010's standard: the artifact you receive from the
// environment is INPUT, not state you hold)
// ---------------------------------------------------------------------------
// A PreToolUse hook receives exactly two channels, and BOTH are controlled by
// the actor being judged:
//   * the tool payload — it is the thing under judgement; it cannot also be the
//     evidence of who is acting; and
//   * the process environment — the agent exports its own variables in its own
//     shell commands, so `COORD_SESSION_ID` / `COORD_PROVIDER` /
//     `COORD_INSTANCE_ID` are self-asserted.
// Only two inputs are TRUSTED: the lock files and identity registry under
// `coord/.runtime/`, which only `gov` writes, transactionally, under lock and
// journaled; and the filesystem itself, read through `realpath`.
//
// The rule that follows, and which the tests pin: EVERY GRANT DERIVES FROM
// TRUSTED STATE; SELF-ASSERTED IDENTITY MAY ONLY TIGHTEN. Canonical-tree
// refusal never consults identity. Identity is used solely to ADD refusals
// (a resolvable foreign owner, or an instance the trusted registry positively
// disowns). Forging identity can therefore never widen authority — the worst an
// actor achieves by lying is to be treated as unknown, which grants it nothing
// that path classification did not already grant.
//
// WHAT THIS MODULE DELIVERS, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// DELIVERED (this is the whole of the enforcement):
//   * canonical governed paths are refused whenever an applicable active lock
//     exists — IDENTITY-INDEPENDENTLY, so an unresolvable or forged actor gains
//     nothing; and
//   * an actor the trusted owner-lease registry POSITIVELY DISOWNS is refused
//     inside the ticket worktree as well.
//
// ACCEPTED LIMITATION — COORD-645-F2, tracked by COORD-648
// ---------------------------------------------------------------------------
// In-worktree OWNERSHIP IS NOT ENFORCED. A write INSIDE an active ticket
// worktree by an actor whose identity cannot be resolved is PERMITTED. This is
// an accepted limitation by human-admin scope decision, not enforcement and not
// a check that merely happens not to fire: the hook has no trustworthy
// authentication channel, so there is nothing here to enforce with. Closing it
// requires a per-actor identity channel the acting session cannot forge, and
// none exists today — the harness gives every sub-agent of a conversation the
// same session id, gives hooks no access to the per-sub-agent
// `COORD_SESSION_ID` override, and every other visible signal (ppid, POSIX sid,
// cwd, transcript path) is either shared across sub-agents or actor-settable.
// Denying unresolved in-worktree writes without such a channel would deny the
// legitimate owner's own work. COORD-648 (spike, outside the release chain)
// carries the evidence and the adversarial acceptance test: an actor that
// controls its own environment and tool input must not be able to present
// itself as a different owner.

const path = require("node:path");
const { DESTRUCTIVE_SHELL } = require("./runtime-authority.js");

// Canonical-tree subtrees that carry no governance authority: build output,
// dependency trees, VCS internals, and the worktree container itself (whose
// contents are classified as worktree writes, never canonical writes).
const UNGOVERNED_CANONICAL_SEGMENTS = [
  ".git",
  "node_modules",
  "coord/.worktrees",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
];

// A sanctioned governed transaction: the governance CLI itself, recognized as
// the COMPLETE command. `coord/scripts/gov` is a Bash shim and must never be
// run through node, so both spellings are matched explicitly.
//
// COORD-645-F1: this used to be a substring match, and the match then exempted
// the ENTIRE compound command — so `gov explain X; echo compromised >
// coord/GOVERNANCE.md` was waved through. Two independent repairs:
//   1. recognition is now whole-command and lexer-based (below), so a governed
//      invocation appearing ANYWHERE inside a larger command is not one; and
//   2. the recognizer no longer GRANTS anything. Write targets are scanned on
//      every shell command. The real distinction between a sanctioned governed
//      transaction and an arbitrary shell write is that `gov` performs its
//      canonical mutations IN-PROCESS, transactionally, under lock and
//      journaled — it never redirects into a governed path — so scanning it
//      costs nothing, while an arbitrary redirect into the canonical tree is
//      refused. A classifier that can only tighten cannot be turned into a
//      bypass.
const GOVERNED_INVOCATION = /^(?:[\w.@~+-]*\/)*coord\/scripts\/gov$/;
const GOVERNANCE_JS = /^(?:[\w.@~+-]*\/)*coord\/scripts\/governance\.js$/;

// Operators that introduce, chain or substitute ANOTHER command.
const COMPOSITION_OPS = new Set([";", "&", "&&", "|", "||", "\n", "\r", "`", "$("]);

function parseJsonSafe(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lock enumeration — ALL active locks, never a cwd-scoped subset.
// ---------------------------------------------------------------------------

// `entries` is [{ name, text }] handed in by the caller (the wrapper reads the
// directory). A lock whose JSON is unreadable is NOT silently dropped: it is
// returned as `unreadable` so the caller can treat "there might be an active
// lock I cannot parse" as evidence of activity rather than as absence.
function enumerateLocks(entries) {
  const active = [];
  const unreadable = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry && entry.name ? entry.name : "");
    if (!name.endsWith(".lock")) continue;
    const parsed = parseJsonSafe(entry && entry.text);
    if (!parsed) {
      unreadable.push(name);
      continue;
    }
    if (parsed.status !== "doing" || !parsed.worktree) continue;
    active.push({
      ticket: String(parsed.ticket || name.replace(/\.lock$/, "")),
      owner: String(parsed.owner || "").trim(),
      worktree: String(parsed.worktree),
      status: parsed.status,
      identity_model: parsed.identity_model || null,
      // DIAGNOSTIC ONLY (identity v2). Never consulted for authority.
      legacy_session_id: parsed.session_id || null,
    });
  }
  return { active, unreadable };
}

// ---------------------------------------------------------------------------
// Actor identity — cwd-independent, owner-authoritative.
// ---------------------------------------------------------------------------

// Mirrors coord/scripts/identity-v2.js readEnvIdentity(): identity comes from
// the durable channel written by the SessionStart hook, never inferred.
function readProviderIdentity(env) {
  const e = env && typeof env === "object" ? env : {};
  const provider = String(e.COORD_PROVIDER || "").trim();
  const providerSessionId = String(e.COORD_PROVIDER_SESSION_ID || "").trim();
  const instanceId = String(e.COORD_INSTANCE_ID || "").trim();
  return { provider, providerSessionId, instanceId, present: Boolean(provider && instanceId) };
}

// The effective thread id used by the engine's own binding path
// (governance-session.js currentRuntimeThreadId): an explicit orchestrator
// override wins over the harness-injected provider id.
function effectiveThreadId(env) {
  const e = env && typeof env === "object" ? env : {};
  for (const name of ["COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "GEMINI_THREAD_ID", "AGENT_THREAD_ID"]) {
    const value = String(e[name] || "").trim();
    if (value) return value;
  }
  return "";
}

// Resolve the acting session to a REGISTERED HANDLE (the owner identity the
// board and locks are keyed on).
//
//   1. identity v2 owner lease — the authority under GOVERNANCE.md. The
//      durable COORD_INSTANCE_ID resolves to a registered instance, and the
//      instance's owner must actually HOLD that owner's lease. An instance
//      that is revoked/ended, or whose lease has moved on, is NOT the owner.
//   2. registered agent session — the pre-v2 binding path, keyed on the
//      effective thread id. Still owner-authoritative in its result (it yields
//      a handle); the thread id is only the lookup key, never the authority.
//   3. unresolved.
//
// A lock's own `session_id`/`thread_id` is never an input here; it is reported
// separately as collision diagnostics.
function resolveActor({ env, identityRegistry, agentSessions, boardPath } = {}) {
  const provider = readProviderIdentity(env);
  const registry = identityRegistry && typeof identityRegistry === "object" ? identityRegistry : null;

  // `contradicted` means the durable channel was present AND the trusted
  // registry was readable AND it says this instance is not a lease-holding
  // owner. That is a POSITIVE statement of non-authority, distinct from
  // "no evidence either way" — and only the positive form may tighten a
  // decision. When the registry is absent the channel simply cannot be
  // evaluated, and treating that as contradiction would lock out every adopter
  // who has never run a v2 claim.
  if (provider.present && registry) {
    const instances = Array.isArray(registry.instances) ? registry.instances : [];
    const leases = registry.leases && typeof registry.leases === "object" ? registry.leases : {};
    const instance = instances.find((i) => i && i.instance_id === provider.instanceId) || null;
    if (instance && instance.status === "active" && String(instance.owner || "").trim()) {
      const owner = String(instance.owner).trim();
      const lease = leases[owner];
      if (lease && lease.instance_id === instance.instance_id) {
        return { resolved: true, contradicted: false, owner, source: "identity-v2-lease", provider, reason: null };
      }
      return {
        resolved: false,
        contradicted: true,
        owner: null,
        source: "identity-v2-lease",
        provider,
        reason: `instance ${provider.instanceId} does not hold the owner lease for "${owner}"`,
      };
    }
    if (instance) {
      return {
        resolved: false,
        contradicted: true,
        owner: null,
        source: "identity-v2-lease",
        provider,
        reason: `instance ${provider.instanceId} is ${instance.status || "unknown"}, not an active owner`,
      };
    }
  }

  const threadId = effectiveThreadId(env);
  if (threadId && Array.isArray(agentSessions)) {
    const match = agentSessions.find(
      (s) =>
        s &&
        s.status === "active" &&
        s.thread_id === threadId &&
        (!boardPath || !s.board_path || s.board_path === boardPath)
    );
    if (match && String(match.handle || "").trim()) {
      return { resolved: true, contradicted: false, owner: String(match.handle).trim(), source: "agent-session", provider, reason: null };
    }
  }

  return {
    resolved: false,
    contradicted: false,
    owner: null,
    source: null,
    provider,
    reason: provider.present
      ? "durable provider identity is present but resolves to no registered owner"
      : "no durable governance identity (COORD_PROVIDER/COORD_INSTANCE_ID) and no registered agent session for this thread",
  };
}

// ---------------------------------------------------------------------------
// Path classification — symlink- and case-alias-resistant.
// ---------------------------------------------------------------------------

function foldCase(value, caseInsensitive) {
  return caseInsensitive ? String(value).toLowerCase() : String(value);
}

function isInside(parent, child, caseInsensitive) {
  if (!parent || !child) return false;
  const rel = path.relative(foldCase(path.resolve(parent), caseInsensitive), foldCase(path.resolve(child), caseInsensitive));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// realpath() fails on a path that does not exist yet — which is precisely the
// case for a Write that creates a file. Resolve the deepest ancestor that DOES
// exist and re-append the remainder, so a symlinked parent directory cannot
// launder a target out of its true classification.
function resolveRealPath(absolute, realpath) {
  if (typeof realpath !== "function") return absolute;
  let current = path.resolve(absolute);
  const trailing = [];
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const resolved = realpath(current);
      return trailing.length ? path.join(resolved, ...trailing) : resolved;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(absolute);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(absolute);
}

// Every path a target could be reached by: as written, and as it truly
// resolves. Classification takes the MOST RESTRICTIVE verdict across both, so
// neither a symlink nor a `..` segment nor a case alias can downgrade it.
function candidatePaths(target, { cwd, realpath }) {
  const absolute = path.resolve(cwd || ".", String(target));
  const real = resolveRealPath(absolute, realpath);
  return real === absolute ? [absolute] : [absolute, real];
}

function classifyPath(absolute, { workspaceRoot, locks, caseInsensitive }) {
  for (const lock of locks || []) {
    if (isInside(lock.worktree, absolute, caseInsensitive)) {
      return { kind: "worktree", lock };
    }
  }
  if (!workspaceRoot || !isInside(workspaceRoot, absolute, caseInsensitive)) {
    return { kind: "outside", lock: null };
  }
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolute));
  const segments = foldCase(relative, caseInsensitive).split(/[\\/]/).filter(Boolean);
  for (const ungoverned of UNGOVERNED_CANONICAL_SEGMENTS) {
    const parts = foldCase(ungoverned, caseInsensitive).split("/");
    for (let i = 0; i + parts.length <= segments.length; i += 1) {
      if (parts.every((part, j) => segments[i + j] === part)) {
        return { kind: "canonical-ungoverned", lock: null };
      }
    }
  }
  return { kind: "canonical-governed", lock: null };
}

const KIND_SEVERITY = { outside: 0, "canonical-ungoverned": 1, worktree: 2, "canonical-governed": 3 };

function classifyTarget(target, options) {
  let worst = null;
  for (const absolute of candidatePaths(target, options)) {
    const classification = { ...classifyPath(absolute, options), path: absolute };
    if (!worst || KIND_SEVERITY[classification.kind] > KIND_SEVERITY[worst.kind]) worst = classification;
  }
  return { target: String(target), ...worst };
}

// ---------------------------------------------------------------------------
// Tool payload extraction.
// ---------------------------------------------------------------------------

const INPUT_KEYS = ["file_path", "path", "target", "paths", "notebook_path", "command", "cmd", "script", "patch", "edits", "content", "old_string"];

// Fail-open #2: the previous code read `call.input || call.tool_input` only.
// Claude Code pipes the tool_input OBJECT ITSELF into this hook, so that lookup
// produced `{}` — no paths, no command, unconditional allow. Accept every shape
// the hook can actually be handed.
function extractCall(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const tool = String(raw.tool_name || raw.tool || "");
  const nested = (raw.tool_input && typeof raw.tool_input === "object" && raw.tool_input) ||
    (raw.input && typeof raw.input === "object" && raw.input) ||
    null;
  const selfShaped = INPUT_KEYS.some((key) => raw[key] !== undefined);
  const input = nested ? { ...(selfShaped ? raw : {}), ...nested } : selfShaped ? raw : {};
  return { tool, input };
}

function commandFrom(input) {
  return String((input && (input.command || input.cmd || input.script)) || "");
}

function patchPaths(input) {
  const patch = String((input && (input.patch || input.input)) || "");
  const found = [];
  const re = /\*\*\*\s+(?:Add|Update|Delete|Move)\s+File:\s*(.+)/gi;
  let match;
  while ((match = re.exec(patch)) !== null) found.push(match[1].trim());
  return found;
}

function targetPaths(input) {
  const values = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  };
  if (!input || typeof input !== "object") return values;
  push(input.file_path);
  push(input.path);
  push(input.target);
  push(input.notebook_path);
  if (Array.isArray(input.paths)) input.paths.forEach(push);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") {
        push(edit.file_path);
        push(edit.path);
      }
    }
  }
  patchPaths(input).forEach(push);
  return Array.from(new Set(values));
}

// A minimal POSIX-ish shell lexer. COORD-645-F1: the previous regex scan could
// not tell an operator inside quotes from a real one, which cuts both ways — it
// missed `> "coord/GOVERNANCE.md"` and it would have fired on a harmless
// `--summary "a > b"`. Quote state is the only way to get this right, so it is
// tracked explicitly. Returns [{ type: "word"|"op", value, quoted }].
// COORD-663-F1 / D2 / D3. A heredoc BODY is data the shell feeds to a
// program's stdin; it is not shell syntax and it names nothing. Lexing it as
// syntax invented redirect targets out of prose: `cat > path <<EOF` whose body
// contained the sentence fragment "… > Stop …" produced the write target
// `Stop`, and a `python3 - "$f" <<PY` body containing `>=` produced the target
// `=`. Both were then classified against the canonical tree and REFUSED —
// and neither command wrote anything at all. Bodies are now consumed whole and
// contribute no tokens. Only the opener's own line is lexed, so a genuine
// `cat <<EOF > coord/GOVERNANCE.md` is still caught.
function readHeredocDelimiter(source, start) {
  let index = start;
  let stripTabs = false;
  if (source[index] === "-") {
    stripTabs = true;
    index += 1;
  }
  while (source[index] === " " || source[index] === "\t") index += 1;
  let delimiter = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, index + 1);
      delimiter += end < 0 ? source.slice(index + 1) : source.slice(index + 1, end);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "\\" && index + 1 < source.length) {
      delimiter += source[index + 1];
      index += 2;
      continue;
    }
    if (/[\s;&|<>()]/.test(ch)) break;
    delimiter += ch;
    index += 1;
  }
  return { delimiter, stripTabs, index };
}

// Skip each pending heredoc's body in order, starting just after the newline
// that ended the opener line. An UNTERMINATED heredoc consumes the remainder of
// the command — which is what the shell itself does, and which also means no
// token can be lifted out of an unterminated body.
//
// COORD-663-F3: the body is CAPTURED onto its `<<` token as well as skipped.
// Skipping is what keeps prose in a `cat > file <<EOF` body from inventing
// write targets (D2/D3). Capturing is what lets destructive-operation
// detection still see a body that an INTERPRETER EXECUTES — `python3 - <<PY`
// reads its program from stdin, so that body is program text, not data, and
// treating every heredoc body as data would open a real deletion bypass.
function skipHeredocBodies(source, start, heredocs, tokens) {
  let index = start;
  for (const doc of heredocs) {
    const bodyStart = index;
    let bodyEnd = index;
    while (index <= source.length) {
      const newline = source.indexOf("\n", index);
      const hasNewline = newline >= 0;
      const end = hasNewline ? newline : source.length;
      let line = source.slice(index, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      bodyEnd = index;
      index = hasNewline ? end + 1 : source.length;
      if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      bodyEnd = index;
      if (!hasNewline) break;
    }
    const token = tokens && typeof doc.tokenIndex === "number" ? tokens[doc.tokenIndex] : null;
    if (token) {
      token.heredoc = { delimiter: doc.delimiter, body: source.slice(bodyStart, bodyEnd) };
    }
  }
  return index;
}

function lexShell(command) {
  const s = String(command || "");
  const out = [];
  let word = null;
  let quoted = false;
  const pendingHeredocs = [];
  const flush = () => {
    if (word !== null) out.push({ type: "word", value: word, quoted });
    word = null;
    quoted = false;
  };
  const op = (value) => {
    flush();
    out.push({ type: "op", value });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // A herestring feeds one word to stdin; it is never a write target, but it
    // must be recognised before `<<` so its word is not read as a delimiter.
    if (s.slice(i, i + 3) === "<<<") {
      op("<<<");
      i += 3;
      continue;
    }
    if (s.slice(i, i + 2) === "<<") {
      const parsed = readHeredocDelimiter(s, i + 2);
      op("<<");
      if (parsed.delimiter) {
        pendingHeredocs.push({
          delimiter: parsed.delimiter,
          stripTabs: parsed.stripTabs,
          tokenIndex: out.length - 1,
        });
      }
      i = parsed.index;
      continue;
    }
    if ((c === "\n" || c === "\r") && pendingHeredocs.length) {
      op(c);
      i += 1;
      if (c === "\r" && s[i] === "\n") i += 1;
      i = skipHeredocBodies(s, i, pendingHeredocs, out);
      pendingHeredocs.length = 0;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      // Single quotes suppress EVERY expansion, so their content is literal
      // text and can never introduce a second command.
      word = (word || "") + (end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
      quoted = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let segment = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) {
          segment += s[j + 1];
          j += 2;
          continue;
        }
        segment += s[j];
        j += 1;
      }
      // Double quotes still expand $( ) and backticks — that IS composition.
      if (/\$\(|`/.test(segment)) out.push({ type: "op", value: "$(" });
      word = (word || "") + segment;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      word = (word || "") + s[i + 1];
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    const pair = s.slice(i, i + 2);
    if (pair === "&&" || pair === "||" || pair === ">>" || pair === "$(") {
      op(pair);
      i += 2;
      continue;
    }
    if (";&|\n\r`><".includes(c)) {
      op(c);
      i += 1;
      continue;
    }
    word = (word || "") + c;
    i += 1;
  }
  flush();
  return out;
}

function hasShellComposition(tokens) {
  return tokens.some((token) => token.type === "op" && COMPOSITION_OPS.has(token.value));
}

function commandWord(value) {
  return String(value || "").split("/").pop();
}

// Paths a shell command writes to. Still deliberately narrow — this hook gates
// Bash, so a false positive can block an operator's own recovery — but now
// quote-aware, so neither `> "path"` nor a quoted `>` inside an argument is
// mis-read.
function shellWriteTargets(command) {
  return collectShellWriteTargets(lexShell(command));
}

function collectShellWriteTargets(tokens) {
  const found = [];
  const push = (value) => {
    const trimmed = String(value || "").trim();
    if (trimmed && trimmed !== "/dev/null" && !/^&?\d+$/.test(trimmed)) found.push(trimmed);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "op" && (token.value === ">" || token.value === ">>")) {
      const next = tokens[i + 1];
      if (next && next.type === "word") push(next.value);
      continue;
    }
    if (token.type !== "word") continue;
    const name = commandWord(token.value);
    if (name === "tee") {
      for (let j = i + 1; j < tokens.length && tokens[j].type === "word"; j += 1) {
        if (!tokens[j].value.startsWith("-")) push(tokens[j].value);
      }
    }
    if (name === "sed") {
      const words = [];
      let inPlace = false;
      for (let j = i + 1; j < tokens.length && tokens[j].type === "word"; j += 1) {
        if (/^-[a-zA-Z]*i/.test(tokens[j].value)) inPlace = true;
        words.push(tokens[j].value);
      }
      if (inPlace && words.length) push(words[words.length - 1]);
    }
  }
  return Array.from(new Set(found));
}

// ---------------------------------------------------------------------------
// COORD-663-F1 / D1 — unexpanded shell variables in a write target.
// ---------------------------------------------------------------------------
// `echo x > "$w/probe.txt"` used to be classified as a write to the LITERAL
// path `<workspace>/$w/probe.txt`, which sits inside the canonical tree and was
// therefore refused — while the identical write spelled literally succeeded.
// The refusal was on a path that can never exist.
//
// The repair resolves a target to EVERY path it could denote and takes the
// most restrictive verdict across all of them:
//
//   * every value the command itself assigns to the variable (all of them, not
//     just the last — `w=coord; … ; w=/tmp` must not launder the first);
//   * the value in the process environment, if any; and
//   * ALWAYS the LITERALLY-NAMED PARENT DIRECTORY, when the target names one
//     before its first variable (`coord/$x` → `coord`).
//
// The literal-prefix candidate is what keeps this fail-closed and keeps the
// module's trust rule intact: assignments and the environment are BOTH actor-
// controlled, so they may only ADD candidates and can never remove the
// conservative one. `coord/$x` is refused whatever `$x` is claimed to be.
// A target with NO literally-named parent and no resolvable value denotes
// nothing this hook can classify: it is permitted and RECORDED as
// `unresolved_write_targets`, never silently dropped.
//
// KNOWN, TESTED LIMITATION: `coord/$x` is refused even when `$x` would have
// expanded into `coord/.worktrees/...`, and a variable holding `..` can still
// escape a literal prefix. Spell the path literally, or expand the variable in
// the command, to write there under an active lock.
const SHELL_VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const MAX_EXPANSION_CANDIDATES = 32;

function hasShellVariable(value) {
  SHELL_VARIABLE.lastIndex = 0;
  return SHELL_VARIABLE.test(String(value || ""));
}

function shellVariableNames(value) {
  const names = new Set();
  String(value || "").replace(SHELL_VARIABLE, (whole, braced, bare) => {
    names.add(braced || bare);
    return whole;
  });
  return names;
}

function expandShellValue(value, resolve) {
  let out = String(value);
  for (let depth = 0; depth < 4 && hasShellVariable(out); depth += 1) {
    const next = out.replace(SHELL_VARIABLE, (whole, braced, bare) => {
      const replacement = resolve(braced || bare);
      return replacement === undefined ? whole : replacement;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// `NAME=value` words anywhere in the command, including after `export`. Every
// distinct value per name is kept.
function collectShellAssignments(tokens) {
  const assignments = new Map();
  for (const token of tokens) {
    if (token.type !== "word") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(token.value);
    if (!match) continue;
    const values = assignments.get(match[1]) || [];
    if (!values.includes(match[2])) values.push(match[2]);
    assignments.set(match[1], values);
  }
  return assignments;
}

// The directory the target names LITERALLY, before its first variable. `.` and
// `./` do not count: they denote the acting cwd, which is the canonical root
// for most sessions, and treating them as a literal governed prefix is exactly
// the D1 false positive in another spelling.
function literalDirectoryPrefix(value) {
  const raw = String(value);
  const dollar = raw.indexOf("$");
  if (dollar < 0) return null;
  const cut = raw.slice(0, dollar).lastIndexOf("/");
  if (cut <= 0) return null;
  const prefix = raw.slice(0, cut).replace(/^(?:\.\/)+/, "");
  return prefix && prefix !== "." ? prefix : null;
}

function shellTargetCandidates(rawTarget, assignments, env) {
  const raw = String(rawTarget);
  if (!hasShellVariable(raw)) return { raw, candidates: [raw], unresolved: false };

  const names = shellVariableNames(raw);
  const pools = new Map();
  for (const name of names) {
    const pool = [];
    for (const value of assignments.get(name) || []) if (!pool.includes(value)) pool.push(value);
    const fromEnv = env && typeof env === "object" ? env[name] : undefined;
    if (typeof fromEnv === "string" && !pool.includes(fromEnv)) pool.push(fromEnv);
    if (pool.length) pools.set(name, pool);
  }

  const combos = [];
  const poolNames = Array.from(pools.keys());
  const build = (depth, current) => {
    if (combos.length >= MAX_EXPANSION_CANDIDATES) return;
    if (depth >= poolNames.length) {
      combos.push(new Map(current));
      return;
    }
    const name = poolNames[depth];
    for (const value of pools.get(name)) {
      current.set(name, value);
      build(depth + 1, current);
      if (combos.length >= MAX_EXPANSION_CANDIDATES) break;
    }
    current.delete(name);
  };
  build(0, new Map());

  const candidates = [];
  for (const combo of combos) {
    const expanded = expandShellValue(raw, (name) => combo.get(name));
    if (hasShellVariable(expanded)) continue;
    if (expanded.trim() && !candidates.includes(expanded)) candidates.push(expanded);
  }
  const truncated = combos.length >= MAX_EXPANSION_CANDIDATES;
  const unresolved = pools.size !== names.size || candidates.length === 0 || truncated;

  const prefix = literalDirectoryPrefix(raw);
  if (prefix && !candidates.includes(prefix)) candidates.push(prefix);

  return { raw, candidates, unresolved };
}

// Write targets with every path each one could denote. `env` is optional and,
// like the command's own assignments, may only ADD candidates.
function resolveShellWriteTargets(command, env) {
  const tokens = lexShell(command);
  const assignments = collectShellAssignments(tokens);
  return collectShellWriteTargets(tokens).map((raw) => shellTargetCandidates(raw, assignments, env));
}

// ---------------------------------------------------------------------------
// COORD-663-F3 (D5) — EXECUTABLE REGIONS.
// ---------------------------------------------------------------------------
// Destructive-operation detection used to run the DESTRUCTIVE_SHELL patterns
// against the RAW command string, before any lexing. Raw text cannot tell an
// operation from a description of one, so the barrier refused commands that
// deleted nothing: a `gov add-finding --summary "…"` whose PROSE named the
// tokens (which blocked the filing of this very defect), and a heredoc whose
// executed body WROTE a removal call into a test file as source text.
//
// The repair analyses executable REGIONS. What is and is not executable:
//
//   * the command word IS executable however it is spelled — quoting does not
//     exempt it, because the shell runs a quoted command word just the same;
//   * UNQUOTED argument words stay visible, because that is where `-delete`,
//     `--delete`, `--hard` and git subcommands live;
//   * QUOTED argument words are DATA and are masked — that is the prose case;
//   * an INTERPRETER-FED heredoc body is program text and stays executable
//     (`python3 -`, `bash`, `sh -s` all execute their body). A body fed to a
//     non-interpreter (`cat > file <<EOF`) is data;
//   * evaluator-surface ARGUMENTS become executable: the `-c` of bash/sh/python
//     and the `-e` of node, through any `env` prefix, and the command that
//     `xargs` builds;
//   * inside PROGRAM text, string literals are data — that is the source-text
//     case, and it is the same code-vs-data rule applied one level down.
//
// Blanket "ignore heredoc bodies" or "ignore quoted text" rules were rejected:
// either one is a bypass. A body piped into `python3 -` really does delete.
const SHELL_EVALUATORS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const PROGRAM_EVALUATORS = new Map([
  ["python", "-c"],
  ["python2", "-c"],
  ["python3", "-c"],
  ["node", "-e"],
  ["nodejs", "-e"],
  ["perl", "-e"],
  ["ruby", "-e"],
]);
// Interpreters that EXECUTE whatever arrives on stdin, so a heredoc feeding
// them is program text. `python3 -`, `python3` with no script, `bash`, `sh -s`.
const STDIN_PROGRAM_INTERPRETERS = new Set([
  "bash", "sh", "dash", "zsh", "ksh", "python", "python2", "python3", "node", "nodejs", "perl", "ruby",
]);
const MAX_REGION_DEPTH = 4;

// Mask string literals in PROGRAM text so a removal call quoted as data cannot
// read as a removal call performed. Deliberately conservative: only complete,
// closed literals are masked, so an unterminated quote leaves the text visible
// rather than swallowing the rest of the program.
function maskProgramStringLiterals(text) {
  return String(text || "")
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '"DATA"')
    .replace(/`(?:\\.|[^`\\])*`/g, '"DATA"')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '"DATA"')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '"DATA"');
}

function simpleCommandsFrom(tokens) {
  const commands = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === "op" && COMPOSITION_OPS.has(token.value)) {
      if (current.length) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) commands.push(current);
  return commands;
}

// The argv of one simple command, with quoted ARGUMENTS masked and the command
// word always kept. Leading `VAR=value` assignments and an `env` prefix are
// stepped over so the real command word is found.
function executableShellText(tokens) {
  const words = tokens.filter((token) => token.type === "word");
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index += 1;
  if (index < words.length && commandWord(words[index].value) === "env") {
    index += 1;
    while (index < words.length && (/^-[iu]/.test(words[index].value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value))) {
      index += 1;
    }
  }
  const rendered = [];
  for (let i = index; i < words.length; i += 1) {
    const token = words[i];
    // i === index is the command word: executable however it is quoted.
    rendered.push(i === index || !token.quoted ? token.value : "DATA");
  }
  return rendered.join(" ");
}

function evaluatorArguments(tokens) {
  const words = tokens.filter((token) => token.type === "word").map((token) => token.value);
  const out = [];
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  if (index < words.length && commandWord(words[index]) === "env") {
    index += 1;
    while (index < words.length && (/^-[iu]/.test(words[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) {
      index += 1;
    }
  }
  if (index >= words.length) return out;
  const name = commandWord(words[index]);
  // `xargs <command> …`: everything after xargs's own flags builds a command.
  if (name === "xargs") {
    let cursor = index + 1;
    while (cursor < words.length && words[cursor].startsWith("-")) cursor += 1;
    if (cursor < words.length) out.push({ kind: "shell", text: words.slice(cursor).join(" ") });
    return out;
  }
  const shellEval = SHELL_EVALUATORS.has(name);
  const programFlag = PROGRAM_EVALUATORS.get(name);
  for (let i = index + 1; i < words.length; i += 1) {
    if (shellEval && words[i] === "-c" && i + 1 < words.length) {
      out.push({ kind: "shell", text: words[i + 1] });
      i += 1;
      continue;
    }
    if (programFlag && words[i] === programFlag && i + 1 < words.length) {
      out.push({ kind: "program", text: words[i + 1] });
      i += 1;
    }
  }
  return out;
}

// Does this simple command execute whatever arrives on its stdin? `python3 -`
// and a bare `bash` do; `python3 script.py` and `cat` do not.
function consumesStdinAsProgram(tokens) {
  const words = tokens.filter((token) => token.type === "word").map((token) => token.value);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  if (index < words.length && commandWord(words[index]) === "env") {
    index += 1;
    while (index < words.length && (/^-[iu]/.test(words[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) {
      index += 1;
    }
  }
  if (index >= words.length) return false;
  const name = commandWord(words[index]);
  if (!STDIN_PROGRAM_INTERPRETERS.has(name)) return false;
  const rest = words.slice(index + 1);
  if (rest.includes("-") || rest.includes("-s")) return true;
  // A bare interpreter with no script operand reads its program from stdin.
  return rest.every((word) => word.startsWith("-"));
}

/**
 * Every region of `command` that is EXECUTED, as {kind, text}. `kind` is
 * "shell" for shell syntax and "program" for another language's source, whose
 * string literals are masked before it is returned.
 */
function executableRegions(command, depth = 0) {
  const regions = [];
  if (depth > MAX_REGION_DEPTH) return regions;
  const tokens = lexShell(command);
  for (const simple of simpleCommandsFrom(tokens)) {
    const text = executableShellText(simple);
    if (text.trim()) regions.push({ kind: "shell", text });
    for (const nested of evaluatorArguments(simple)) {
      if (nested.kind === "shell") regions.push(...executableRegions(nested.text, depth + 1));
      else regions.push({ kind: "program", text: maskProgramStringLiterals(nested.text) });
    }
    if (consumesStdinAsProgram(simple)) {
      for (const token of simple) {
        if (token.type !== "op" || !token.heredoc) continue;
        regions.push({ kind: "program", text: maskProgramStringLiterals(token.heredoc.body) });
      }
    }
  }
  return regions;
}

function hasDestructiveOperation(command) {
  if (!command) return false;
  return executableRegions(command).some((region) =>
    DESTRUCTIVE_SHELL.some((pattern) => pattern.test(region.text))
  );
}

// True only when the WHOLE command is a governance CLI invocation. Any shell
// composition disqualifies it outright, so a governed invocation embedded in a
// compound command is never mistaken for the command itself. Recording-only:
// nothing is exempted on the strength of this (see GOVERNED_INVOCATION above).
function isGovernedTransaction(command) {
  const tokens = lexShell(command);
  if (!tokens.length || hasShellComposition(tokens)) return false;
  const words = [];
  for (const token of tokens) {
    if (token.type === "word") words.push(token.value);
    else break; // a redirect ends the command's own argument list
  }
  let index = 0;
  // Leading VAR=value assignments, and an `env` prefix with only -u/-i/NAME=.
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  if (index < words.length && commandWord(words[index]) === "env") {
    index += 1;
    while (index < words.length && (/^-[iu]/.test(words[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) {
      if (/^-[iu]$/.test(words[index])) index += 2;
      else index += 1;
    }
  }
  if (index >= words.length) return false;
  if (GOVERNED_INVOCATION.test(words[index])) return true;
  return commandWord(words[index]) === "node" && index + 1 < words.length && GOVERNANCE_JS.test(words[index + 1]);
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

function deny(code, reason, extra = {}) {
  return { decision: "deny", code, reason, ...extra };
}
function allow(code, reason, extra = {}) {
  return { decision: "allow", code, reason, ...extra };
}

/**
 * @param {object} input
 * @param {object} input.payload        raw hook payload (any accepted shape)
 * @param {string} input.cwd            acting cwd (evidence, never authority)
 * @param {string} input.workspaceRoot  the canonical workspace root
 * @param {{active: Array, unreadable: Array}} input.locks  ALL locks, cwd-independent
 * @param {object} input.actor          resolveActor() result
 * @param {function} [input.realpath]   symlink resolver
 * @param {boolean} [input.caseInsensitive]
 */
function decide(input = {}) {
  const { tool, input: toolInput } = extractCall(input.payload);
  const lockState = input.locks && typeof input.locks === "object" ? input.locks : { active: [], unreadable: [] };
  const locks = Array.isArray(lockState.active) ? lockState.active : [];
  const unreadable = Array.isArray(lockState.unreadable) ? lockState.unreadable : [];
  const actor = input.actor || { resolved: false, owner: null, reason: "no actor supplied" };
  const options = {
    cwd: input.cwd || ".",
    workspaceRoot: input.workspaceRoot || null,
    locks,
    realpath: input.realpath,
    caseInsensitive: Boolean(input.caseInsensitive),
  };
  const command = commandFrom(toolInput);
  // "There is a lock I cannot read" is evidence of activity, not absence of it
  // — the exact inversion this ticket exists to remove.
  const locksActive = locks.length > 0 || unreadable.length > 0;
  const context = { tool, ticket: null, actor_owner: actor.owner || null, actor_resolved: Boolean(actor.resolved) };

  // (1) Defined no-active-lock behaviour. With no governed work in flight
  // there is no authority boundary to enforce and nothing to mis-attribute, so
  // the barrier stays out of the way. This is what keeps the repair from
  // becoming a blanket refusal of bootstrap, adoption and read-only use — and
  // it is the FIRST rule deliberately, so that "no ticket in flight" is a
  // stated, tested behaviour rather than an accident of falling off the end.
  if (!locksActive) {
    return allow("no_active_lock", "no active governed lock; authority boundary does not apply", context);
  }

  // (2) Prohibitions that hold anywhere inside the boundary — same rules as
  // the pre-existing evaluateToolCall, but no longer conditional on the acting
  // cwd happening to sit inside a worktree.
  // COORD-663-F3: matched against EXECUTABLE REGIONS, not the raw command
  // string. Prose in an argument and a removal call written as source text are
  // data; an interpreter-fed heredoc body and an evaluator's -c/-e string are
  // not.
  if (hasDestructiveOperation(command)) {
    return deny("destructive_shell", "permanent deletion or destructive Git operation", context);
  }
  if (/apply_patch/i.test(tool) && /\*\*\*\s+Delete File:/i.test(String((toolInput && (toolInput.patch || toolInput.input)) || ""))) {
    return deny("patch_delete", "file deletion through patch", context);
  }
  if (/delete|remove|unlink|rmdir/i.test(tool)) {
    return deny("delete_tool", "delete-like tool is not permitted", context);
  }

  const cwdLock = locks.find((lock) => isInside(lock.worktree, path.resolve(options.cwd), options.caseInsensitive)) || null;

  // (3) Shell writes. Write targets are scanned on EVERY command, including a
  // governed one: `gov` mutates canonical state in-process under lock, never by
  // redirecting into a governed path, so scanning costs it nothing. The
  // governed-transaction classification is recorded for audit but grants no
  // exemption — COORD-645-F1 showed that an exemption keyed on text appearing
  // somewhere in a compound command is a bypass, and the safe repair is for the
  // classification to be unable to permit anything at all.
  if (command) {
    context.governed_transaction = isGovernedTransaction(command);
    const unresolved = [];
    for (const target of resolveShellWriteTargets(command, input.env)) {
      if (target.unresolved) unresolved.push(target.raw);
      // Most restrictive verdict across every path this token could denote
      // (see shellTargetCandidates). A token that denotes nothing classifiable
      // yields no candidates and is recorded rather than refused.
      let classification = null;
      for (const candidate of target.candidates) {
        const next = classifyTarget(candidate, options);
        if (!classification || KIND_SEVERITY[next.kind] > KIND_SEVERITY[classification.kind]) classification = next;
      }
      if (!classification) continue;
      const viaVariable = classification.target !== target.raw
        ? ` (written as \`${target.raw}\`, classified by the path it can denote)`
        : "";
      if (classification.kind === "canonical-governed") {
        return deny(
          "shell_canonical_write",
          `shell write to canonical governance path ${classification.path}${viaVariable} while ${locks.length} governed lock(s) are active; ` +
            "route canonical mutations through the governed CLI (coord/scripts/gov), which mutates transactionally under lock",
          { ...context, path: classification.path, target: target.raw }
        );
      }
      if (classification.kind === "worktree" && classification.lock && actor.resolved && actor.owner !== classification.lock.owner) {
        return deny(
          "shell_foreign_worktree_write",
          `shell write into ${classification.lock.ticket}'s worktree, owned by ${classification.lock.owner}, by ${actor.owner}`,
          { ...context, ticket: classification.lock.ticket, path: classification.path, target: target.raw }
        );
      }
    }
    // Loud, never silent: a target this hook could not resolve is reported on
    // the permitting decision, so an unenforced target can never be mistaken
    // for a target that was checked and passed (COORD-480).
    if (unresolved.length) context.unresolved_write_targets = unresolved;
    return allow("shell_permitted", null, context);
  }

  const targets = targetPaths(toolInput);
  if (targets.length === 0) {
    return allow("no_write_target", null, context);
  }

  for (const raw of targets) {
    const classification = classifyTarget(raw, options);

    // (4) THE REPAIRED BOUNDARY. A write to the canonical tree while any
    // governed lock is active is refused: the canonical checkout is shared and
    // its uncommitted changes are swept into whatever the lock holder commits
    // next — that is the 2026-08-04 false-authorship incident. The lock holder
    // has a worktree; anyone else has no filesystem authority here at all.
    // Unresolvable identity is refused HERE, rather than being read as
    // permission.
    if (classification.kind === "canonical-governed") {
      const who = actor.resolved
        ? `session bound to owner ${actor.owner}`
        : `unresolved session (${actor.reason})`;
      const held = actor.resolved ? locks.filter((lock) => lock.owner === actor.owner) : [];
      const remedy = held.length
        ? `write inside your ticket worktree ${held[0].worktree} instead`
        : "start or resume a ticket with `coord/scripts/gov start <ticket>` and write inside its worktree";
      return deny(
        "canonical_write_refused",
        `${who} attempted a write to the canonical tree at ${classification.path} while ${locks.length} governed lock(s) are active ` +
          `(${locks.map((lock) => `${lock.ticket}:${lock.owner}`).join(", ")}); ${remedy}`,
        { ...context, path: classification.path, held_tickets: held.map((lock) => lock.ticket) }
      );
    }

    if (classification.kind === "worktree") {
      const lock = classification.lock;
      // A session that HAPPENED to resolve as a different owner. Opportunistic
      // only — an actor that asserts nothing resolves to nothing and is
      // permitted here (COORD-645-F2 / COORD-648). This does not make
      // in-worktree ownership enforced; it is a refusal added when corroborating
      // evidence is volunteered, never a check the barrier can rely on.
      if (actor.resolved && lock.owner && actor.owner !== lock.owner) {
        return deny(
          "foreign_worktree_write",
          `${actor.owner} attempted a write into ${lock.ticket}'s worktree, which is owned by ${lock.owner}`,
          { ...context, ticket: lock.ticket, path: classification.path }
        );
      }
      // Positively contradicted identity: the trusted registry says this
      // instance holds no owner lease. Absence of evidence is NOT contradiction
      // and falls through to the accepted limitation (COORD-645-F2 /
      // COORD-648): in-worktree ownership is not enforced.
      if (actor.contradicted) {
        return deny(
          "contradicted_worktree_write",
          `write into ${lock.ticket}'s worktree by a session the owner-lease registry does not recognise (${actor.reason})`,
          { ...context, ticket: lock.ticket, path: classification.path }
        );
      }
      // Pre-existing worktree confinement: a session acting from inside one
      // worktree may not write into another.
      if (cwdLock && cwdLock.ticket !== lock.ticket) {
        return deny(
          "cross_worktree_write",
          `write outside ticket authority: acting from ${cwdLock.ticket}'s worktree into ${lock.ticket}'s worktree`,
          { ...context, ticket: cwdLock.ticket, path: classification.path }
        );
      }
      context.ticket = lock.ticket;
      continue;
    }

    // Pre-existing worktree confinement: a session acting from inside a
    // worktree may not write anywhere outside it.
    if (cwdLock) {
      return deny(
        "write_outside_ticket_authority",
        `write outside ticket authority: ${cwdLock.ticket} is fixed to ${cwdLock.worktree}`,
        { ...context, ticket: cwdLock.ticket, path: classification.path }
      );
    }
  }

  return allow("permitted", null, context);
}

module.exports = {
  COMPOSITION_OPS,
  GOVERNED_INVOCATION,
  UNGOVERNED_CANONICAL_SEGMENTS,
  classifyTarget,
  executableRegions,
  hasDestructiveOperation,
  hasShellComposition,
  lexShell,
  decide,
  effectiveThreadId,
  enumerateLocks,
  extractCall,
  isGovernedTransaction,
  isInside,
  literalDirectoryPrefix,
  readProviderIdentity,
  resolveActor,
  resolveRealPath,
  resolveShellWriteTargets,
  shellWriteTargets,
  targetPaths,
};
