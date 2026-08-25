#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { createEnvelope, deriveSubagentEnvelope, finishSubagent, registerSubagent } = require("./runtime-authority.js");
const { appendEntry } = require("./auto-mode-ledger.js");
const { decide, enumerateLocks, resolveActor } = require("./runtime-authority-decision.js");
const stdinSeam = require("./hooks/hook-stdin.js");

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
function resolveCoordDir() {
  if (process.env.COORD_CANONICAL_DIR) return path.resolve(process.env.COORD_CANONICAL_DIR);
  for (const candidate of [process.cwd(), __dirname]) {
    const marker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;
    const index = candidate.indexOf(marker);
    if (index >= 0) return candidate.slice(0, index + `${path.sep}coord`.length);
  }
  return path.resolve(__dirname, "..");
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

const root = resolveCoordDir();
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
  return { payload, acquired };
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
const { payload, acquired } = await acquirePayload();

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
  const payloadUnavailable = !acquired.ok && Object.keys(payload).length === 0;
  if (payloadUnavailable && locksActive) {
    const reason =
      `no tool payload reached the authority barrier (${stdinSeam.explainStdinReason(acquired.stdinReason)}); ` +
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
    process.stderr.write(`CONCORD BARRIER ERROR: ${error.message} (coord/scripts/runtime-authority-decision.js)\n`);
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
const envelope = createEnvelope({ ticket: lock.ticket, session: lock.session_id, provider: process.env.COORD_PROVIDER || "claude", worktree: lock.worktree, coverage: "partial" });
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
  process.exit(0);
}
if (process.argv.includes("--subagent-stop")) {
  const session = String(payload.agent_id || payload.session_id || "").trim();
  const summary = String(payload.last_assistant_message || payload.summary || "").trim();
  try {
    finishSubagent(supervisor, session, { explained: Boolean(summary), action_digest: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
    appendEntry(ledger, { type: "subagent_stop", ticket: lock.ticket, parent_session: envelope.session, actor_session: session, explained: Boolean(summary) });
  } catch (error) {
    process.stderr.write(`CONCORD DENY: ${error.message}.\n`);
    process.exit(2);
  }
  process.exit(0);
}
process.exit(0);
}

// A crash in the barrier is a nonzero exit only where there is a boundary to
// enforce — same scoped fail-closed policy as the decision path above.
main().catch((error) => {
  process.stderr.write(`CONCORD BARRIER ERROR: ${(error && error.message) || error} (coord/scripts/runtime-authority-hook.js)\n`);
  let active = 0;
  try {
    const locks = enumerateLocks(readLockEntries(root));
    active = locks.active.length + locks.unreadable.length;
  } catch { /* if we cannot even enumerate locks, do not brick the workspace */ }
  process.exit(active ? 2 : 0);
});
