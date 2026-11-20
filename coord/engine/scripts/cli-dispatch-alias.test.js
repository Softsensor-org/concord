"use strict";

// COORD-988 (ARCH-AUDIT-2026-11-13 F-12): the terminal alias verbs close, finish and
// finish-ticket share one handler body. Each alias must still journal under the label
// the user typed, and the handler must receive the same ticket and flags as before.

const test = require("node:test");
const assert = require("node:assert/strict");

const cli = require("./cli.js");

function recordingDependencies() {
  const calls = { sync: [], release: [] };
  return {
    calls,
    dependencies: {
      autoSyncAfterLifecycle: (input) => {
        calls.sync.push(input);
        return { session_release_safe: true, publication: { status: "skipped", published: false } };
      },
      releaseTerminalTicketSession: (ticketId, options) => {
        calls.release.push({ ticketId, options });
        return { reason: "released" };
      },
    },
  };
}

test("COORD-988: runTerminalAliasVerb is exported for the alias dispatch", () => {
  assert.equal(typeof cli.__testing.runTerminalAliasVerb, "function");
});

for (const alias of ["close", "finish", "finish-ticket"]) {
  test(`COORD-988: ${alias} journals its typed label and passes the ticket and flags to the handler`, () => {
    const handled = [];
    const handler = (ticketId, flags) => {
      handled.push({ ticketId, flags });
      return { ok: true, verb: alias };
    };
    const { calls, dependencies } = recordingDependencies();
    const args = ["COORD-988-ALIAS-FIXTURE", "--reason", "fixture"];

    const result = cli.__testing.runTerminalAliasVerb(alias, args, handler, dependencies);

    assert.deepEqual(result, { ok: true, verb: alias });
    assert.equal(handled.length, 1);
    assert.equal(handled[0].ticketId, "COORD-988-ALIAS-FIXTURE");
    assert.deepEqual(handled[0].flags, cli.__testing.parseFlags(["--reason", "fixture"]));
    assert.equal(calls.sync.length, 1);
    assert.equal(calls.sync[0].verb, alias);
    assert.equal(calls.sync[0].ticketId, "COORD-988-ALIAS-FIXTURE");
    assert.equal(calls.release.length, 1);
    assert.equal(calls.release[0].ticketId, "COORD-988-ALIAS-FIXTURE");
  });
}

test("COORD-1052: doctor recovery dispatch defaults to dry-run and forwards only explicit apply", (t) => {
  const ownership = require("./run-ownership.js");
  const governanceState = require("./governance-context.js").state;
  const calls = [], output = [];
  t.mock.method(ownership, "recoverRuns", (options) => {
    calls.push(options);
    return { dry_run: !options.apply, runs: [], staging: [] };
  });
  t.mock.method(console, "log", (text) => output.push(JSON.parse(text)));
  for (const flags of [["--recover-runs"], ["--recover-runs", "--yes"]]) {
    assert.equal(cli.__testing.ROUTE_HANDLERS.doctor("doctor", flags), 0);
  }
  assert.deepEqual(calls.map((entry) => entry.apply), [false, true]);
  assert.deepEqual(output.map((entry) => entry.dry_run), [true, false]);
  for (const entry of calls) {
    assert.deepEqual(entry.stagingLocks, [
      { kind: "governance-runtime", path: governanceState.GOVERNANCE_EVENT_LOCK_DIR, staleMs: 60_000 },
      { kind: "agent-state", path: governanceState.AGENT_STATE_LOCK_DIR, staleMs: 60_000 },
      { kind: "coord-state", path: governanceState.COORD_STATE_LOCK_DIR, staleMs: 60_000 },
    ]);
    assert.equal(entry.dir, ownership.defaultRunsDir(require("node:path").resolve(__dirname, "..", "..")));
  }
});

test("promote rejects a reverse promotion edge when no repository is specified", () => {
  const result = cli.executeCommand(["promote", "--from", "main", "--to", "dev", "--commit", "HEAD"], {
    env: { ...process.env, COORD_PROMOTE_REPO: undefined },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /promote: edge main->dev is not an allowed edge/);
});

test("start keeps the local result when attempt publication lacks a base commit", (t) => {
  const { commands } = require("./lifecycle.js");
  const result = {
    ticket: "COORD-START-FIXTURE", handle: "fixture", branch: "fixture/work",
    base_sha: null, base_ref: null,
  };
  const calls = [];
  t.mock.method(commands, "startTicket", (ticket, options) => {
    calls.push({ ticket, options });
    return result;
  });
  t.mock.method(commands, "recordLifecycleCostBoundary", (...args) => calls.push(args));

  // The CLI binds lifecycle functions as it loads. Restore the original entry
  // so other tests keep the production lifecycle functions.
  const modulePath = require.resolve("./cli.js");
  const original = require.cache[modulePath];
  delete require.cache[modulePath];
  let fixtureCli;
  try {
    fixtureCli = require(modulePath);
  } finally {
    require.cache[modulePath] = original;
  }

  const output = fixtureCli.executeCommand(["start", result.ticket, "--owner", result.handle]);
  assert.equal(output.ok, true, output.error);
  assert.equal(output.value, result);
  assert.deepEqual(calls, [
    { ticket: result.ticket, options: { owner: result.handle } },
    [result.ticket, "plan", ["start"]],
  ]);
  assert.equal(output.stderr, `[warning] attempt for ${result.ticket} not published: no base commit was resolved for this repo.`);
});

test("publish-board rejects unrecognized flags before publishing", () => {
  const result = cli.executeCommand(["publish-board", "--unsupported-fixture-flag"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown flag "--unsupported-fixture-flag"/);
});

test("update-plan explains how to replace the retired --plan-update flag", () => {
  const result = cli.executeCommand(["update-plan", "COORD-PLAN-FIXTURE", "--plan-update"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown flag "--plan-update"/);
  assert.match(result.error, /update-plan <ticket-id> --summary/);
});
