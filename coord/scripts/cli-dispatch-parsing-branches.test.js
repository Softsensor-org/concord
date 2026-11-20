// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
"use strict";

// COORD-718: adding the record-independent-review verb to the dispatch switch
// re-attributes the argument-parsing branches of its older inline verbs. These
// tests pin those parsers through the real dispatcher: each case stops at a
// deterministic refusal after its argument loop ran, so nothing is mutated.

const test = require("node:test");
const assert = require("node:assert/strict");
const { executeCommand, withRegisterPromptHarness } = require("./governance-test-utils.js");

function run(args) {
  return executeCommand(args, { env: { ...process.env, COORD_SESSION_ID: undefined, CLAUDE_CODE_SESSION_ID: "c718-dispatch-branches" } });
}

test("COORD-718: inline verb parsers route --json, valued flags, other flags and positionals", () => {
  withRegisterPromptHarness("c718-dispatch-", { ticketId: "IMP-718" }, () => {
    // A trailing valued flag without a value is refused by parseFlags only after
    // the inline loop has classified every token.
    for (const args of [
      ["recall", "query", "words", "--json", "--role", "viewer", "--limit"],
      ["code-search", "query", "--json", "--top", "1", "--n", "2", "--limit"],
    ]) {
      const result = run(args);
      assert.equal(result.ok, false);
      // --n is consumed with its value by the code-search loop, then refused by parseFlags.
      assert.match(result.error, /--limit requires a value|Unknown flag "--n"/);
    }
    const missing = run(["sign-journal", "verify", "/nonexistent/c718-batch.json", "--json", "--event", "abc"]);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Signed-batch file not found: \/nonexistent\/c718-batch\.json/, "a positional batch file is the verify target");
    assert.match(run(["sign-journal", "verify", "--bogus"]).error, /Unknown flag "--bogus"/);
    // code-diff splits an optional leading base ref from its flags; an unknown
    // flag stops it before any git work runs.
    assert.match(run(["code-diff", "HEAD", "--bogus"]).error, /Unknown flag "--bogus"/);
    assert.match(run(["code-diff", "--bogus"]).error, /Unknown flag "--bogus"/);
  });
});

test("COORD-718: recent owner-lease evidence reports lease events, ignores others and tolerates a journal failure", () => {
  const createGovernanceSession = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-session.js"));
  const session = (findLatestTicketGovernanceEvent) => createGovernanceSession({
    findLatestTicketGovernanceEvent,
    summarizeGovernanceEvent: (event) => ({ command: event.command }),
    state: {},
  });
  assert.equal(session(() => null).summarizeRecentOwnerLeaseEvidence("IMP-1"), null);
  assert.equal(session(() => ({ command: "record-independent-review" })).summarizeRecentOwnerLeaseEvidence("IMP-1"), null);
  assert.equal(session(() => ({})).summarizeRecentOwnerLeaseEvidence("IMP-1"), null, "an event without a command is not lease evidence");
  assert.deepEqual(session(() => ({ command: "claim" })).summarizeRecentOwnerLeaseEvidence("IMP-1"), { command: "claim" });
  assert.equal(session(() => { throw new Error("journal unreadable"); }).summarizeRecentOwnerLeaseEvidence("IMP-1"), null);
});
