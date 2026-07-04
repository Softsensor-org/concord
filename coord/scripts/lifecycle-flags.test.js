"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createLifecycleFlags = require("./lifecycle-flags.js");

// COORD-099 (governance.test residual split, slice 4): the `parseFlags`
// flag-acceptance tests below were relocated here from governance.test.js.
// `parseFlags` (cli.js) is the CLI-facade flag parser — the deliberate
// data-parallel sibling of this module's `parseLifecycleFlags` (see the
// COORD-094 header note in lifecycle-flags.js). Both flag parsers now live
// beside each other. The relocated tests exercise the fully-wired parser via
// the governance facade (`__testing.parseFlags`, == cli.__testing.parseFlags)
// exactly as before, so behavior is byte-identical — only the home moved.
const { __testing } = require("./governance-test-utils.js");

const LEGAL_FINDING_STATUSES = new Set(["open", "resolved"]);
function build() {
  return createLifecycleFlags({
    fail: (message) => { throw new Error(message); },
    isLegalStatus: (s) => ["todo", "doing", "review", "done"].includes(s),
    LEGAL_FINDING_STATUSES,
  });
}

test("parses simple value flags into normalized keys", () => {
  const { parseLifecycleFlags } = build();
  const p = parseLifecycleFlags(["--owner", "claudea11", "--repo", "B", "--mode", "general"]);
  assert.equal(p.owner, "claudea11");
  assert.equal(p.repo, "B");
  assert.equal(p.mode, "general");
});

test("boolean flags set true without consuming a value", () => {
  const { parseLifecycleFlags } = build();
  const p = parseLifecycleFlags(["--assign"]);
  assert.equal(p.assign, true);
});

test("requireValue rejects a flag missing its value", () => {
  const { parseLifecycleFlags } = build();
  assert.throws(() => parseLifecycleFlags(["--owner"]), /--owner requires a value/);
});

test("--status accepts a legal board status (short-circuit path)", () => {
  const { parseLifecycleFlags } = build();
  assert.equal(parseLifecycleFlags(["--status", "doing"]).status, "doing");
});

test("--status accepts a legal finding status via LEGAL_FINDING_STATUSES", () => {
  const { parseLifecycleFlags } = build();
  // 'open' is not a board status; this exercises the injected
  // LEGAL_FINDING_STATUSES branch that was previously an implicit dependency.
  assert.equal(parseLifecycleFlags(["--status", "open"]).status, "open");
});

test("--status rejects an entirely unknown status", () => {
  const { parseLifecycleFlags } = build();
  assert.throws(() => parseLifecycleFlags(["--status", "bogus"]), /Invalid status/);
});

test("requireValue/appendValue are exported for reuse", () => {
  const { requireValue, appendValue } = build();
  const obj = {};
  appendValue(obj, "x", 1);
  appendValue(obj, "x", 2);
  assert.deepEqual(obj.x, [1, 2]);
  assert.throws(() => requireValue("--f", ""), /--f requires a value/);
});

// --- cli.js parseFlags acceptance (relocated from governance.test.js, COORD-099) ---

test("parseFlags accepts the documented commit-ticket --all flag", () => {
  assert.deepEqual(
    __testing.parseFlags(["--message", "ready", "--all"]),
    {
      message: "ready",
      all: true,
    }
  );

  assert.deepEqual(
    __testing.parseFlags(["--files", "scripts/governance.js", "--all"]),
    {
      files: ["scripts/governance.js"],
      all: true,
    }
  );

  assert.deepEqual(
    __testing.parseFlags(["--assign"]),
    {
      assign: true,
    }
  );
});

test("parseFlags accepts the documented audit-landings --write flag", () => {
  assert.deepEqual(
    __testing.parseFlags(["--repo", "B", "--write"]),
    {
      repo: "B",
      write: true,
    }
  );
});

test("parseFlags accepts the documented finalize --already-landed flag", () => {
  assert.deepEqual(
    __testing.parseFlags(["--no-pr", "--already-landed", "--landed", "backend/dev landed at abc1234"]),
    {
      noPr: true,
      alreadyLanded: true,
      landed: ["backend/dev landed at abc1234"],
    }
  );
});

test("parseFlags accepts push, autofill-startup, and -m aliases", () => {
  assert.deepEqual(
    __testing.parseFlags(["--push", "--autofill-startup", "-m", "ship it"]),
    {
      push: true,
      autofillStartup: true,
      message: "ship it",
    }
  );
});

test("parseFlags accepts the documented human-admin override flag", () => {
  assert.deepEqual(
    __testing.parseFlags(["--human-admin-override", "approved cleanup"]),
    {
      humanAdminOverride: "approved cleanup",
    }
  );
});

test("parseFlags accepts break-runtime-lock --force-live break-glass flag", () => {
  assert.equal(__testing.parseFlags(["--yes", "--force-live"]).forceLive, true);
});

test("parseFlags accepts --fresh so agent-rebind reaches rebindAgent (COORD-003)", () => {
  assert.deepEqual(
    __testing.parseFlags(["--fresh"]),
    { fresh: true }
  );
  assert.deepEqual(
    __testing.parseFlags(["--fresh", "--session-label", "demo"]),
    { fresh: true, sessionLabel: "demo" }
  );
});

test("COORD-003 Fix 1: parseFlags accepts --scope-self as a boolean flag", () => {
  assert.equal(__testing.parseFlags(["--scope-self"]).scopeSelf, true);
  // It does not throw the "Unknown flag" error the doctor owner-scope wrapper hit.
  assert.doesNotThrow(() => __testing.parseFlags(["--scope-self", "--dry-run"]));
  const parsed = __testing.parseFlags(["--scope-self", "--dry-run"]);
  assert.equal(parsed.scopeSelf, true);
  assert.equal(parsed.dryRun, true);
  // Absent flag leaves scopeSelf undefined (no accidental default-true).
  assert.equal(__testing.parseFlags([]).scopeSelf, undefined);
});
