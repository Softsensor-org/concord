#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
// COORD-949: the engine requires are a load-safe unit. A require-time failure (a
// partially installed or half-upgraded engine) must not escape as an uncaught
// exception: node exits 1, which the harness treats as a NON-blocking error, so the
// tool call would proceed. Run as the entrypoint, a load failure exits 2 while locks
// are active (the same scope as the barrier's runtime policy); required as a module
// it rethrows, so the coord/scripts shim still sees the real error and blocks.
// The recovery every fail-closed message names. A block raised by this barrier also
// blocks the shell an in-session operator would repair it from, so it is out of band.
const OUT_OF_BAND_RECOVERY =
  "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent " +
  "harness, restore the engine copy under coord/engine/scripts and restart the session; or, if no governed work is in " +
  "flight, release the active lock through the governance CLI.";
let createEnvelope, deriveSubagentEnvelope, finishSubagent, registerSubagent, appendEntry;
let decide, enumerateLocks, resolveActor, stdinSeam, resolveSubagentParent;
try {
  ({ createEnvelope, deriveSubagentEnvelope, finishSubagent, registerSubagent } = require("./runtime-authority.js"));
  ({ appendEntry } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/auto-mode-ledger.js")));
  ({ decide, enumerateLocks, resolveActor } = require("./runtime-authority-decision.js"));
  stdinSeam = require("./hooks/hook-stdin.js");
  ({ resolveSubagentParent } = require("./runtime-authority-subagent.js"));
} catch (error) {
  if (require.main !== module) throw error;
  const detail = (error && error.message) || String(error);
  process.stderr.write(
    `CONCORD BARRIER ERROR: cannot load the authority barrier's engine modules: ${detail} (coord/engine/scripts/runtime-authority-hook.js). ` +
      `${OUT_OF_BAND_RECOVERY}\n`
  );
  process.exit(locksActiveWithoutEngine() ? 2 : 0);
}

// COORD-660 — THIRD INSTANCE OF THE SAME STDIN SEAM, brought under the same
// rule. This file used to do:
//
//     function readStdin() { try { return fs.readFileSync(0,"utf8"); } catch { return ""; } }
//     const payload = { ...parse(process.env.TOOL_INPUT || "{}"), ...parse(readStdin()) };
//
// which carried two defects beyond the shared one:
//   * no `isTTY` guard at all, so a hand-run hook did a blocking synchronous
//     read of a terminal (and, against a caller that opens an fd 0 it never
//     writes or closes, wedged — the suite-wide deadlock of COORD-658); and
//   * the stdin object was spread LAST, so it took precedence over the
//     environment payload.
//
// Acquisition is now the shared lazy / stream-based / bounded seam, and the
// environment is spread last so precedence matches `hook-lib.readHookPayload`.
// A stdin document that fails to parse contributes NOTHING instead of being
// able to blank the payload.
function parse(value) { try { return JSON.parse(value); } catch { return {}; } }
function parseObject(value) {
  const parsed = parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
// COORD-949: a non-empty payload that is not a JSON object (truncated JSON, an array,
// a scalar, non-UTF-8 bytes) carries no inspectable tool call. parseObject() would
// turn it into {}, and decide({}) allows it, so it is a refusal, not an empty payload.
function isObjectOrEmpty(text) {
  if (typeof text !== "string" || text.trim() === "") return true;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
}
// COORD-949: the lock fallback for a load failure, where the engine's enumerateLocks
// is unavailable. Same question as the barrier asks: is any governed work in flight?
// A lock file that cannot be parsed, or cannot be read, counts as activity.
function locksActiveWithoutEngine() {
  const dir = path.join(resolveCoordDir(__dirname), ".runtime", "locks");
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) { return !(error && error.code === "ENOENT"); }
  return names.filter((name) => name.endsWith(".lock")).some((name) => {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return Boolean(lock) && lock.status === "doing";
    } catch { return true; }
  });
}
// COORD-930: the canonical coord directory is derived from the installed engine's
// own location, the same rule the guard uses. A ticket worktree's engine copy sits
// under <canonical>/coord/.worktrees/<handle>/<ticket>/..., so the canonical coord
// dir is recovered from __dirname. Neither the caller's cwd nor
// COORD_CANONICAL_DIR (both caller-controlled) can point the barrier at another
// state tree.
function resolveCoordDir(scriptDir) {
  const marker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;
  const index = scriptDir.indexOf(marker);
  if (index >= 0) return scriptDir.slice(0, index + `${path.sep}coord`.length);
  return path.resolve(scriptDir, "..", "..");
}
function findLock(coordDir) {
  const dir = path.join(coordDir, ".runtime", "locks");
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".lock")).sort()) {
    const lock = parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    if (lock.status === "doing" && lock.worktree && (process.cwd() === lock.worktree || process.cwd().startsWith(`${lock.worktree}${path.sep}`))) return lock;
  }
  return null;
}

const root = resolveCoordDir(__dirname);
const isSubagentEvent = process.argv.includes("--subagent-start") || process.argv.includes("--subagent-stop");

// A subagent event carries `agent_id` / `session_id`, which only ever arrive on
// stdin — the environment can never satisfy it, so stdin is always consulted
// there. For a tool event, a populated TOOL_INPUT answers the question and
// fd 0 is never touched.
async function acquirePayload() {
  const acquired = await stdinSeam.acquireHookPayload({
    env: process.env,
    needs: isSubagentEvent ? [] : ["TOOL_INPUT"],
  });
  const payload = { ...parseObject(acquired.stdinText), ...parseObject(process.env.TOOL_INPUT) };
  // Only a successful read can be malformed. A failed read (too-large, timeout) leaves a
  // partial text that is reported by its acquisition reason, not as a parse failure.
  const malformed = acquired.ok && (!isObjectOrEmpty(acquired.stdinText) || !isObjectOrEmpty(process.env.TOOL_INPUT));
  return { payload, acquired, malformed };
}

// COORD-645: read ALL locks, independent of cwd. A locks directory that does
// not exist means "no governed work in flight"; a directory that exists but
// cannot be read is EVIDENCE OF ACTIVITY WE CANNOT SEE, and is reported as
// unreadable so the decision core fails closed instead of reading the failure
// as permission.
function readLockEntries(coordDir) {
  const dir = path.join(coordDir, ".runtime", "locks");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return error && error.code === "ENOENT" ? [] : [{ name: "<unreadable>.lock", text: null }];
  }
  return names.filter((name) => name.endsWith(".lock")).sort().map((name) => {
    try { return { name, text: fs.readFileSync(path.join(dir, name), "utf8") }; }
    catch { return { name, text: null }; }
  });
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

async function main() {
const { payload, acquired, malformed } = await acquirePayload();

if (!isSubagentEvent) {
  const locks = enumerateLocks(readLockEntries(root));
  const locksActive = locks.active.length > 0 || locks.unreadable.length > 0;

  // COORD-660 / COORD-663 — THE PAYLOAD-UNAVAILABLE CASE IS A REFUSAL.
  //
  // `decide()` given an empty payload extracts no command and no write
  // targets, and returns allow("no_write_target"). That is the barrier's own
  // version of "absence of evidence read as permission" — the class closed
  // under COORD-635/642/656/626/660 — and it was reachable for the whole life
  // of this control: the shipped wiring in `.claude/settings.json` was
  // `printf '%s' "$TOOL_INPUT" | node coord/scripts/runtime-authority-hook.js`,
  // which REPLACED the harness hook envelope on fd 0 with the contents of an
  // environment variable. Measured in a live Claude Code session on
  // 2026-08-10, with an active `doing` lock present, `$TOOL_INPUT` was unset:
  // a `rmdir` command — an unambiguous DESTRUCTIVE_SHELL match — was NOT
  // denied, because the barrier was handed `{}`.
  //
  // COORD-660 recorded the inertness instead of refusing, and said why: while
  // the channel was severed the payload was unobtainable on EVERY invocation,
  // so refusing would have denied every Bash/Write/Edit in the workspace while
  // any lock was active — a lockout, not a control. COORD-663 repairs the
  // channel (both PreToolUse matchers are now bare `node …`, so the harness
  // envelope reaches fd 0 intact) and, in the SAME change, arms the refusal:
  // the two must move together, because armed-plus-severed is the lockout and
  // repaired-plus-permissive is the fail-open all over again.
  //
  // SCOPE. Only inside the authority boundary: with no active lock there is
  // nothing to protect and the hook stays out of the way (a barrier that
  // refuses everything gets disabled, and a disabled barrier protects
  // nothing). Subagent events are handled below and are not gated here.
  //
  // RECOVERY. This refusal denies the very Bash calls an in-session operator
  // would use to undo it, so the message names the OUT-OF-BAND repair — a
  // terminal outside the agent harness — rather than an in-session one.
  // COORD-949: a payload that arrived but is not a JSON object is the same refusal:
  // the barrier has no tool call to inspect, and {} would be allowed.
  const payloadUnavailable = malformed || (!acquired.ok && Object.keys(payload).length === 0);
  if (payloadUnavailable && locksActive) {
    const cause = malformed
      ? "the tool payload that reached the authority barrier is not a JSON object (truncated, an array, a scalar, or non-UTF-8)"
      : `no tool payload reached the authority barrier (${stdinSeam.explainStdinReason(acquired.stdinReason)})`;
    const reason =
      `${cause}; ` +
      `nothing could be inspected while ${locks.active.length} governed lock(s) are active, and an uninspected ` +
      "call is not a call that passed";
    try {
      const file = path.join(root, ".runtime", "action-ledgers", "_authority-barrier.ndjson");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      appendEntry(file, {
        type: "action",
        ticket: null,
        action_id: `${Date.now()}-${process.pid}`,
        actor_owner: null,
        actor_resolved: false,
        tool: "unknown",
        decision: "deny",
        code: "payload_unavailable",
        reason,
      });
    } catch { /* the audit record is best-effort; the refusal below is not */ }
    process.stderr.write(
      `CONCORD DENY [payload_unavailable]: ${reason}. ` +
        "The PreToolUse wiring in .claude/settings.json must deliver the harness hook JSON on fd 0: both the " +
        "`Bash` and `Write|Edit|MultiEdit|apply_patch` matchers must invoke `node coord/scripts/runtime-authority-hook.js` " +
        "with NO leading producer (no `printf`, no `echo`, no `$TOOL_INPUT` pipe). " +
        "OUT-OF-BAND RECOVERY (this refusal also blocks the shell you would fix it from): in a terminal outside the " +
        "agent harness, restore that wiring in .claude/settings.json and restart the session; or, if no governed work " +
        "is in flight, release the active lock through the governance CLI.\n"
    );
    process.exit(2);
  }

  let verdict;
  try {
    verdict = decide({
      payload,
      cwd: process.cwd(),
      workspaceRoot: path.dirname(root),
      locks,
      // COORD-663-F1/D1: values for expanding shell variables in write
      // targets. Actor-controlled, so the decision module uses it only to ADD
      // candidate paths — never to remove the conservative literal-prefix one.
      env: process.env,
      actor: resolveActor({
        env: process.env,
        identityRegistry: readJson(path.join(root, ".runtime", "identity", "instances.json")),
        agentSessions: readJson(path.join(root, ".runtime", "agent_sessions.json")),
        boardPath: path.join(root, "board", "tasks.json"),
      }),
      realpath: fs.realpathSync,
      caseInsensitive: process.platform === "darwin" || process.platform === "win32",
    });
  } catch (error) {
    // A crash in the barrier must not silently permit a write inside the
    // authority boundary — nor brick a workspace that has no governed work in
    // flight and therefore no boundary to enforce.
    // COORD-949: the recovery names the block; with no lock the message is unchanged (exit 0).
    process.stderr.write(
      `CONCORD BARRIER ERROR: ${error.message} (coord/engine/scripts/runtime-authority-decision.js)` +
        `${locksActive ? ` ${OUT_OF_BAND_RECOVERY}` : ""}\n`
    );
    process.exit(locksActive ? 2 : 0);
  }
  if (verdict.decision === "deny" || verdict.ticket) {
    try {
      const file = path.join(root, ".runtime", "action-ledgers", `${verdict.ticket || "_authority-barrier"}.ndjson`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      appendEntry(file, {
        type: "action",
        ticket: verdict.ticket || null,
        action_id: payload.tool_use_id || `${Date.now()}-${process.pid}`,
        actor_owner: verdict.actor_owner,
        actor_resolved: verdict.actor_resolved,
        tool: verdict.tool || "unknown",
        decision: verdict.decision,
        code: verdict.code,
        reason: verdict.reason,
      });
    } catch { /* the audit record is best-effort; the decision below is not */ }
  }
  if (verdict.decision === "deny") {
    process.stderr.write(`CONCORD DENY [${verdict.code}]: ${verdict.reason}.\n`);
    process.exit(2);
  }
  process.exit(0);
}

const lock = findLock(root);
if (!lock) process.exit(0);
const parent = resolveSubagentParent(lock, readJson(path.join(root, ".runtime", "identity", "instances.json")));
if (!parent.ok) {
  process.stderr.write(`CONCORD DENY [${parent.code}]: ${parent.reason}.\n`);
  process.exit(2);
}
const envelope = createEnvelope({ ticket: lock.ticket, session: parent.session, provider: parent.provider, worktree: lock.worktree, coverage: "partial" });
const supervisor = path.join(root, ".runtime", "subagents", `${lock.ticket}.json`);
const ledger = path.join(root, ".runtime", "action-ledgers", `${lock.ticket}.ndjson`);
fs.mkdirSync(path.dirname(ledger), { recursive: true });
if (process.argv.includes("--subagent-start")) {
  const session = String(payload.agent_id || payload.session_id || "").trim();
  if (!session) {
    process.stderr.write("CONCORD DENY: subagent start has no stable identity.\n");
    process.exit(2);
  }
  const child = deriveSubagentEnvelope(envelope, { session });
  registerSubagent(supervisor, envelope, child);
  appendEntry(ledger, { type: "subagent_start", ticket: lock.ticket, parent_session: envelope.session, actor_session: session, envelope_digest: child.digest });
} else {
  const session = String(payload.agent_id || payload.session_id || "").trim();
  const summary = String(payload.last_assistant_message || payload.summary || "").trim();
  try {
    finishSubagent(supervisor, session, { explained: Boolean(summary), action_digest: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
    appendEntry(ledger, { type: "subagent_stop", ticket: lock.ticket, parent_session: envelope.session, actor_session: session, explained: Boolean(summary) });
  } catch (error) {
    process.stderr.write(`CONCORD DENY: ${error.message}.\n`);
    process.exit(2);
  }
}
process.exit(0);
}

// A crash in the barrier is a nonzero exit only where there is a boundary to
// enforce — same scoped fail-closed policy as the decision path above.
function runHook() {
  return main().catch((error) => {
    let active = 0;
    try {
      const locks = enumerateLocks(readLockEntries(root));
      active = locks.active.length + locks.unreadable.length;
    } catch { /* if we cannot even enumerate locks, do not brick the workspace */ }
    process.stderr.write(
      `CONCORD BARRIER ERROR: ${(error && error.message) || error} (coord/scripts/runtime-authority-hook.js)` +
        `${active ? ` ${OUT_OF_BAND_RECOVERY}` : ""}\n`
    );
    process.exit(active ? 2 : 0);
  });
}
// COORD-872: the permanent shim at the legacy coord/scripts path re-dispatches
// runHook, so the fail-closed crash handling above is part of the exported main.
if (require.main === module) runHook();
module.exports = { main: runHook, resolveCoordDir };
