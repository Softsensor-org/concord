"use strict";

// COORD-281: smoke + behavior coverage for the extracted lifecycle CLI
// presentation / thin-wrapper surface (createLifecycleHelp). These functions had
// no direct unit tests before the move (help/initiate were covered only through
// the cli integration, and the command wrappers through spawned `gov` calls), so
// this asserts the extraction stays behavior-preserving: help/primer text is
// emitted, and each thin wrapper's argument-validation path still routes through
// the injected `fail`. The factory is exercised with stub deps so no governance
// engine has to stand up.

const test = require("node:test");
const assert = require("node:assert/strict");

const createLifecycleHelp = require("./lifecycle-help.js");

class StubGovernanceError extends Error {}

function makeApi(overrides = {}) {
  return createLifecycleHelp({
    fail: (message) => {
      throw new StubGovernanceError(message);
    },
    ensureCurrentAgentIdentity: () => {
      throw new StubGovernanceError("no identity");
    },
    GovernanceError: StubGovernanceError,
    state: { GOVERNANCE_EVENT_LOG_PATH: "/tmp/none.ndjson", RUNTIME_DIR: "/tmp" },
    COORD_DIR: "/tmp",
    ...overrides,
  });
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("factory returns the expected presentation surface", () => {
  const api = makeApi();
  assert.deepEqual(Object.keys(api).sort(), [
    "buildInitiateSummary",
    "closeoutSummaryCommand",
    "coverageRollupCommand",
    "insightsCommand",
    "learnedRuleCommand",
    "preworkCommand",
    "printHelp",
    "printInitiate",
    "recallCommand",
    "signJournalCommand",
  ]);
});

test("printHelp emits the preferred-workflow help by default", () => {
  const out = captureLog(() => makeApi().printHelp());
  assert.match(out, /Governance helper CLI/);
  assert.match(out, /Preferred workflow:/);
  assert.match(out, /coord\/scripts\/gov start <ticket-id>/);
});

test("printHelp --all emits the advanced/admin usage block", () => {
  const out = captureLog(() => makeApi().printHelp({ all: true }));
  assert.match(out, /node coord\/scripts\/governance\.js initiate/);
  assert.match(out, /agent-rebind --fresh/);
});

test("buildInitiateSummary renders the session primer with the claimed identity", () => {
  const api = makeApi({
    ensureCurrentAgentIdentity: () => ({
      agent: { handle: "claudea1", id: "a1" },
      session: { session_id: "a1-xyz" },
    }),
  });
  const summary = api.buildInitiateSummary();
  assert.match(summary, /Governance Session Primer/);
  assert.match(summary, /claudea1 \(a1\) via a1-xyz/);
});

test("buildInitiateSummary degrades to the no-session line on GovernanceError", () => {
  // The default stub ensureCurrentAgentIdentity throws a GovernanceError, which
  // the primer must swallow (the catch only rethrows non-GovernanceError).
  const summary = makeApi().buildInitiateSummary();
  assert.match(summary, /No active claimed agent session is bound to this thread yet\./);
});

test("printInitiate rejects options through the injected fail", () => {
  assert.throws(
    () => makeApi().printInitiate({ all: true }),
    /initiate does not take options/
  );
});

test("thin command wrappers route argument-validation failures through fail", () => {
  const api = makeApi();
  assert.throws(() => api.recallCommand(""), /recall requires a query/);
  assert.throws(() => api.preworkCommand(null, {}), /prework requires a ticket id or --scope/);
  assert.throws(() => api.closeoutSummaryCommand(null), /closeout-summary requires a ticket id/);
  assert.throws(() => api.learnedRuleCommand("bogus"), /learned-rule requires a subcommand/);
  assert.throws(() => api.signJournalCommand("bogus"), /sign-journal requires a subcommand/);
});
