"use strict";

// COORD-663 — THE CHANNEL, not the decision.
//
// COORD-645 delivered the runtime authority write barrier and hardened it
// across five review rounds: a pure decision core, 40+ proofs, an
// out-of-process wrapper lifecycle test, an adversarially reviewed fail-open
// repair. Every one of those proofs called `decide()` (or spawned the hook and
// handed it a payload) directly. None of them looked at the line in
// `.claude/settings.json` that decides what the HARNESS is allowed to put on
// fd 0, which was:
//
//     printf '%s' "$TOOL_INPUT" | node coord/scripts/runtime-authority-hook.js
//
// `TOOL_INPUT` is unset in this harness, so the pipe REPLACED the harness's
// real PreToolUse envelope with an empty string. `decide()` was never handed a
// command or a write target, and the barrier permitted everything, for its
// whole life, while reading in every review like a check that passed
// (COORD-480). Meanwhile `pre-bash-guard.js`, wired as a bare `node …` with no
// pipe, received the genuine payload and refused correctly throughout. Same
// repo, same session, two hooks, one armed and one inert, differing only in
// the wiring line.
//
// So these proofs are deliberately NOT more decision-core tests. They assert:
//
//   1. the WIRING SHAPE actually shipped in `.claude/settings.json` — both
//      PreToolUse matchers, bare `node …`, no stdin producer of any kind;
//   2. that a real harness-shaped envelope reaches `decide()` INTACT, by
//      capturing the argument `decide()` was called with and comparing the
//      parsed structure — not by reading an exit code, which is what let an
//      empty payload look like a pass;
//   3. the RED FORM, executable: the shipped wiring string run against the same
//      fixture, where the payload never reaches `decide()` at all; and
//   4. enforcement and non-enforcement at the boundary — refusal with a real
//      active lock, permissiveness with none.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { decide } = require("./runtime-authority-decision.js");

const HOOK = path.join(__dirname, "runtime-authority-hook.js");
const DECISION = path.join(__dirname, "runtime-authority-decision.js");
// `.claude/` is a workspace-root surface (coord/TEMPLATE_SYNC_MANIFEST.json
// lists `.claude/settings.json` as a curated extra), and `coord/` sits directly
// beneath that root in both the donor and an installed workspace.
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const SETTINGS = path.join(WORKSPACE_ROOT, ".claude", "settings.json");

// The two wiring strings, verbatim, as they appear/appeared in settings.json
// with the script path made absolute so they can run against a fixture. The
// shape assertions below pin the RELATIVE forms that actually ship.
const SHIPPED_WIRING = `printf '%s' "$TOOL_INPUT" | node ${JSON.stringify(HOOK)}`;
const REPAIRED_WIRING = `node ${JSON.stringify(HOOK)}`;
const SHIPPED_COMMAND = "node coord/scripts/runtime-authority-hook.js";
const AUTHORITY_MATCHERS = ["Bash", "Write|Edit|MultiEdit|apply_patch"];

// ---------------------------------------------------------------------------
// Fixture: a workspace with a canonical tree, a ticket worktree, and a REAL
// lock file of the shape `gov start` writes.
// ---------------------------------------------------------------------------

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-663-")));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "scripts", "governed-workspace-recovery.js"), "// canonical\n");
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), "[]\n");
  return root;
}

function makeWorktree(root, owner, ticket) {
  const worktree = path.join(root, "coord", ".worktrees", owner, ticket);
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  return worktree;
}

function activeLock(root, { ticket = "COORD-663", owner = "claudea663" } = {}) {
  const worktree = makeWorktree(root, owner, ticket);
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", `${ticket}.lock`),
    `${JSON.stringify({ ticket, owner, status: "doing", worktree, session_id: "a663-fixture" }, null, 2)}\n`
  );
  return worktree;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// A capture shim, injected with `node -r`. It replaces `decide` on the SAME
// module object the hook destructures, so what lands in the capture file is
// exactly the argument the hook passed, before any assertion touches it.
function writeCaptureShim(dir) {
  const shim = path.join(dir, "capture-decide.js");
  fs.writeFileSync(
    shim,
    [
      '"use strict";',
      'const fs = require("node:fs");',
      "const mod = require(process.env.CAPTURE_DECISION_MODULE);",
      "const original = mod.decide;",
      "mod.decide = function capturing(input) {",
      "  const verdict = original(input);",
      "  fs.appendFileSync(process.env.CAPTURE_FILE, `${JSON.stringify({",
      "    payload: input && input.payload,",
      "    cwd: input && input.cwd,",
      "    workspaceRoot: input && input.workspaceRoot,",
      "    activeLocks: input && input.locks && input.locks.active,",
      "    verdict,",
      "  })}\\n`);",
      "  return verdict;",
      "};",
      "",
    ].join("\n")
  );
  return shim;
}

// Run one of the wiring strings through a REAL shell, exactly as the harness
// runs a `"type": "command"` hook, with the envelope delivered on fd 0 and
// TOOL_INPUT unset — the measured condition of this harness.
function runWiring(root, wiring, payload, { capture = null } = {}) {
  const env = {
    ...process.env,
    COORD_CANONICAL_DIR: path.join(root, "coord"),
    COORD_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    COORD_PROVIDER: "",
    COORD_INSTANCE_ID: "",
    TOOL_INPUT: "",
  };
  if (capture) {
    env.CAPTURE_FILE = capture.file;
    env.CAPTURE_DECISION_MODULE = DECISION;
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(capture.shim)}`.trim();
  }
  const res = spawnSync("bash", ["-c", wiring], {
    cwd: root,
    encoding: "utf8",
    env,
    input: JSON.stringify(payload),
  });
  return res;
}

function captured(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// A harness-shaped PreToolUse envelope, with the awkward content that a
// reconstruct-from-environment channel mangles and a real stdin channel does
// not: embedded double quotes, a single quote, a newline, a `%s`, a `$VAR`,
// and non-ASCII text.
// COORD-661: these path literals are identity-only test data and are never
// resolved, so they must stay NEUTRAL — `release/scan-client-refs.sh` rejects
// personal home-directory-shaped absolute paths in a published cut, and it
// matches on CONTENT, so even a comment naming those shapes would fail the cut.
function bashEnvelope(command) {
  return {
    session_id: "6f1c2f4e-0d3a-4a11-9d2e-0d1f2a3b4c5d",
    transcript_path: "/workspace/fixture/.claude/projects/x/transcript.jsonl",
    cwd: "/workspace/fixture/checkout",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
    tool_name: "Bash",
    tool_input: {
      command,
      description: `quote " and ' and %s and $TOOL_INPUT and ünïcödé\nsecond line`,
      timeout: 120000,
    },
  };
}

function writeEnvelope(filePath) {
  return {
    session_id: "6f1c2f4e-0d3a-4a11-9d2e-0d1f2a3b4c5d",
    hook_event_name: "PreToolUse",
    tool_use_id: "toolu_02ZyXwVuTsRqPoNmLkJiHgFe",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "compromised\n" },
  };
}

// ---------------------------------------------------------------------------
// 1. The wiring shape that actually ships.
// ---------------------------------------------------------------------------

test("COORD-663: BOTH PreToolUse matchers invoke the barrier bare, with nothing in front of it", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
  assert.ok(pre.length, "settings.json must declare PreToolUse hooks");

  for (const matcher of AUTHORITY_MATCHERS) {
    const entry = pre.find((e) => e && e.matcher === matcher);
    assert.ok(entry, `no PreToolUse entry for matcher ${matcher}`);
    const authority = (entry.hooks || []).filter((h) => /runtime-authority-hook\.js/.test(String(h.command || "")));
    assert.equal(authority.length, 1, `matcher ${matcher} must wire the authority barrier exactly once`);
    // Equality, not a regex: any prefix, suffix, pipe or redirection is a
    // different channel, and this control is exactly as good as its channel.
    assert.equal(
      authority[0].command,
      SHIPPED_COMMAND,
      `matcher ${matcher} must invoke the barrier bare so the harness envelope reaches fd 0 unchanged`
    );
  }
});

test("COORD-663: no hook command reconstructs a tool payload from the environment", () => {
  const raw = fs.readFileSync(SETTINGS, "utf8");
  const settings = JSON.parse(raw);
  const commands = [];
  for (const event of Object.values(settings.hooks || {})) {
    for (const entry of event || []) {
      for (const hook of (entry && entry.hooks) || []) {
        if (typeof hook.command === "string") commands.push(hook.command);
      }
    }
  }
  assert.ok(commands.length >= 6, `expected the shipped hook surface, saw ${commands.length} commands`);
  for (const command of commands) {
    assert.doesNotMatch(command, /\$\{?TOOL_INPUT/, `hook command reconstructs its payload from the environment: ${command}`);
    assert.doesNotMatch(
      command,
      /(?:^|\|)\s*(?:printf|echo|cat)\b[^|]*\|/,
      `hook command pipes a synthesized document over the harness payload: ${command}`
    );
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. The channel, proven in both directions against ONE fixture.
// ---------------------------------------------------------------------------

test("COORD-663 RED PROOF: under the SHIPPED wiring the envelope never reaches decide() at all", () => {
  const root = makeWorkspace();
  activeLock(root);
  const capture = { file: path.join(root, "capture.ndjson"), shim: writeCaptureShim(root) };
  const canonical = path.join(root, "coord", "scripts", "governed-workspace-recovery.js");

  const res = runWiring(root, SHIPPED_WIRING, bashEnvelope(`echo compromised > ${canonical}`), { capture });

  // The whole defect in one assertion: a destructive, unambiguous canonical
  // write was submitted to the barrier and the decision core never saw it.
  assert.deepEqual(captured(capture.file), [], "the shipped wiring must be shown to deliver NOTHING to decide()");
  // And with the COORD-663 reader armed, an uninspected call inside the
  // authority boundary is refused rather than waved through as it was.
  assert.equal(res.status, 2, `an uninspected call must not be permitted (stderr: ${res.stderr})`);
  assert.match(res.stderr, /CONCORD DENY \[payload_unavailable\]/);
  cleanup(root);
});

test("COORD-663: under the REPAIRED wiring the harness envelope reaches decide() BYTE-INTACT", () => {
  const root = makeWorkspace();
  activeLock(root);
  const capture = { file: path.join(root, "capture.ndjson"), shim: writeCaptureShim(root) };
  const worktreeFile = path.join(root, "coord", ".worktrees", "claudea663", "COORD-663", "src", "fix.txt");
  const envelope = bashEnvelope(`printf 'ok' > ${JSON.stringify(worktreeFile)}`);

  const res = runWiring(root, REPAIRED_WIRING, envelope, { capture });

  const calls = captured(capture.file);
  assert.equal(calls.length, 1, `decide() must be called exactly once (stderr: ${res.stderr})`);
  // THE STRUCTURE, not the exit code. Every field the harness sent, including
  // the ones the barrier does not read, must survive the channel unchanged.
  assert.deepEqual(calls[0].payload, envelope, "the parsed payload must equal the envelope the harness sent");
  assert.equal(calls[0].payload.tool_input.command, envelope.tool_input.command, "the command text must be preserved verbatim");
  assert.equal(
    calls[0].payload.tool_input.description,
    envelope.tool_input.description,
    "quotes, newlines, %s, $VAR and non-ASCII must survive the channel"
  );
  // The rest of the decision inputs must be real too, or the payload arriving
  // intact would still decide nothing.
  assert.equal(calls[0].activeLocks.length, 1, "the real lock file must be enumerated as active");
  assert.equal(calls[0].activeLocks[0].ticket, "COORD-663");
  assert.equal(calls[0].workspaceRoot, root);
  cleanup(root);
});

test("COORD-663: an empty payload handed straight to decide() is exactly the fail-open the wrapper must pre-empt", () => {
  // Why the wrapper refuses BEFORE calling decide() rather than leaving the
  // core to handle it: the core's contract for "no command, no targets" is a
  // permit, and COORD-645 hardened that deliberately. Changing it would refuse
  // every read-only tool call. The channel failure has to be caught where the
  // channel is.
  const verdict = decide({
    payload: {},
    cwd: "/tmp/x",
    workspaceRoot: "/tmp/x",
    locks: { active: [{ ticket: "COORD-663", owner: "claudea663", worktree: "/tmp/x/wt", status: "doing" }], unreadable: [] },
    actor: { resolved: false, owner: null, reason: "unresolved" },
  });
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.code, "no_write_target");
});

// ---------------------------------------------------------------------------
// 4. Enforcement at the boundary, through the repaired channel only.
// ---------------------------------------------------------------------------

test("COORD-663: with a REAL active lock, a canonical Bash redirect is REFUSED and the target bytes are unchanged", () => {
  const root = makeWorkspace();
  activeLock(root);
  const canonical = path.join(root, "coord", "scripts", "governed-workspace-recovery.js");
  const before = fs.readFileSync(canonical);

  const res = runWiring(root, REPAIRED_WIRING, bashEnvelope(`echo compromised > ${JSON.stringify(canonical)}`), {});

  assert.equal(res.status, 2, `the canonical redirect must be refused (stderr: ${res.stderr})`);
  assert.match(res.stderr, /CONCORD DENY \[shell_canonical_write\]/);
  assert.deepEqual(fs.readFileSync(canonical), before, "the canonical file must be byte-identical after the refusal");
  cleanup(root);
});

test("COORD-663: with a REAL active lock, a canonical Write is REFUSED and the target bytes are unchanged", () => {
  const root = makeWorkspace();
  activeLock(root);
  const canonical = path.join(root, "coord", "board", "tasks.json");
  const before = fs.readFileSync(canonical);

  const res = runWiring(root, REPAIRED_WIRING, writeEnvelope(canonical), {});

  assert.equal(res.status, 2, `the canonical write must be refused (stderr: ${res.stderr})`);
  assert.match(res.stderr, /CONCORD DENY \[canonical_write_refused\]/);
  assert.match(res.stderr, /COORD-663/, "the refusal must name the lock it is protecting");
  assert.deepEqual(fs.readFileSync(canonical), before, "the canonical file must be byte-identical after the refusal");
  cleanup(root);
});

test("COORD-663: refusal is IDENTITY-INDEPENDENT — a forged actor gains nothing through the repaired channel", () => {
  const root = makeWorkspace();
  activeLock(root);
  const canonical = path.join(root, "coord", "board", "tasks.json");
  const env = { ...process.env, COORD_SESSION_ID: "claudea663", COORD_PROVIDER: "claude", COORD_INSTANCE_ID: "forged" };
  const res = spawnSync("bash", ["-c", REPAIRED_WIRING], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, COORD_CANONICAL_DIR: path.join(root, "coord"), TOOL_INPUT: "" },
    input: JSON.stringify(writeEnvelope(canonical)),
  });
  assert.equal(res.status, 2, "self-asserted identity must not widen authority over the canonical tree");
  assert.match(res.stderr, /CONCORD DENY \[canonical_write_refused\]/);
  cleanup(root);
});

test("COORD-663: legitimate in-worktree work is still PERMITTED under COORD-645's accepted boundary", () => {
  // The COORD-645-F2 limitation tracked by COORD-648 is preserved deliberately:
  // an in-worktree write by an actor whose identity does not resolve is
  // permitted, because denying it would deny the legitimate owner's own work.
  const root = makeWorkspace();
  const worktree = activeLock(root);
  const res = runWiring(root, REPAIRED_WIRING, writeEnvelope(path.join(worktree, "src", "fix.txt")), {});
  assert.equal(res.status, 0, `worktree work must not be blocked (stderr: ${res.stderr})`);
  cleanup(root);
});

test("COORD-663: with NO lock the repaired channel stays permissive, canonical writes included", () => {
  const root = makeWorkspace();
  const canonical = path.join(root, "coord", "board", "tasks.json");
  for (const envelope of [writeEnvelope(canonical), bashEnvelope(`echo x > ${JSON.stringify(canonical)}`), bashEnvelope("rm -rf build")]) {
    const res = runWiring(root, REPAIRED_WIRING, envelope, {});
    assert.equal(res.status, 0, `bootstrap/adoption must stay unblocked (stderr: ${res.stderr})`);
  }
  cleanup(root);
});
