"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createLifecycleFlags = require("./lifecycle-flags.js");

// COORD-099 (governance.test residual split, slice 4): the `parseFlags`
// flag-acceptance tests below were relocated here from governance.test.js.
// `parseFlags` (../engine/scripts/cli.js) is the CLI-facade flag parser — the deliberate
// data-parallel sibling of this module's `parseLifecycleFlags` (see the
// COORD-094 header note in lifecycle-flags.js). Both flag parsers now live
// beside each other. The relocated tests exercise the fully-wired parser via
// the governance facade (`__testing.parseFlags`, == cli.__testing.parseFlags)
// exactly as before, so behavior is byte-identical — only the home moved.
const { __testing } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

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

test("review-cycle replacement and removal flags preserve their numeric operands", () => {
  const { parseLifecycleFlags } = build();
  assert.deepEqual(
    parseLifecycleFlags(["--replace-review-cycle", "3", "--review-cycle", "revised evidence"]),
    { replaceReviewCycle: 3, reviewCycle: ["revised evidence"] }
  );
  assert.deepEqual(parseLifecycleFlags(["--drop-review-cycle", "2"]), { dropReviewCycle: 2 });
  assert.ok(Number.isNaN(parseLifecycleFlags(["--replace-review-cycle", "not-a-number"]).replaceReviewCycle));
  assert.ok(Number.isNaN(parseLifecycleFlags(["--drop-review-cycle", "not-a-number"]).dropReviewCycle));
});

test("parseLifecycleFlags gives dedicated plan-update and unknown-flag refusals", () => {
  const { parseLifecycleFlags } = build();
  assert.throws(
    () => parseLifecycleFlags(["--plan-update"]),
    /Plan fields are updated separately: use `coord\/scripts\/gov update-plan/
  );
  assert.throws(
    () => parseLifecycleFlags(["--unregistered-lifecycle-option"]),
    /Unknown flag "--unregistered-lifecycle-option"\./
  );
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

test("parseFlags accepts push and -m aliases but rejects removed dead autofill flag", () => {
  assert.deepEqual(
    __testing.parseFlags(["--push", "-m", "ship it"]),
    {
      push: true,
      message: "ship it",
    }
  );
  assert.throws(() => __testing.parseFlags(["--autofill-startup"]), /Unknown flag/);
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

test("COORD-562: parseFlags accepts the doctor template-feedback detail flag only by its exact name", () => {
  assert.deepEqual(__testing.parseFlags(["--show-template-feedback"]), {
    showTemplateFeedback: true,
  });
  assert.throws(
    () => __testing.parseFlags(["--show-template-feedbak"]),
    /Unknown flag "--show-template-feedbak"/
  );
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

// Paths must survive repeated parsing literally, including whitespace.
test("COORD-720: both parsers retain exact repeated scope acknowledgements", () => {
  const args = ["--ack-outside-scope", " outside.txt", "--ack-outside-scope", "two\nlines.txt"];
  const expected = { ackOutsideScope: [" outside.txt", "two\nlines.txt"] };
  assert.deepStrictEqual(__testing.parseFlags(args), expected);
  assert.deepStrictEqual(require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/cli.js")).__testing.parseFlags(args), expected);
});

test("COORD-924: --selection-manifest parses in both flag parsers", () => {
  const { parseLifecycleFlags } = build();
  assert.equal(parseLifecycleFlags(["--selection-manifest", "m.json", "--base", "dev"]).selectionManifest, "m.json");
  assert.equal(__testing.parseFlags(["--selection-manifest", "m.json"]).selectionManifest, "m.json");
  assert.throws(() => parseLifecycleFlags(["--selection-manifest"]), /requires a value|missing/i);
});
