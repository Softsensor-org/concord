"use strict";
// COORD-1010: characterization of ADR-reference normalization on every path.
// Pins what is admitted today (upper- and lower-case) before and after the
// adr-validator.js unification. The legacy validator copy and the shared
// normalizer must agree on every input.
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeAdrRef } = require("./adr-reference.js");
const { expandDecisionContext } = require("./decision-context.js");
const adrValidator = require("./adr-validator.js");
const { executeCommand, withRegisterPromptHarness, __testing } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-test-utils.js"));
const { state: governanceState } = require("./governance-context.js");

// [input, canonical id or null]. Upper- and lower-case rows are both admitted.
const CORPUS = [
  ["ADR-0021", "0021"],
  ["adr-0021", "0021"],
  ["Adr-0021", "0021"],
  ["adr 0021", "0021"],
  ["adr:0021", "0021"],
  ["ADR0021", "0021"],
  ["0021", "0021"],
  ["docs/decisions/adr-0021-foo.md", "0021"],
  ["ADR-21", null],
  ["adr-21", null],
  ["adr-0021x", null],
  ["", null],
  ["   ", null],
  ["not-an-adr", null],
  [null, null],
  [undefined, null],
  [21, null],
];

test("COORD-1010: shared normalizer admits upper- and lower-case ADR refs identically", () => {
  for (const [input, expected] of CORPUS) {
    assert.equal(normalizeAdrRef(input), expected, `shared normalizer on ${JSON.stringify(input)}`);
  }
});

test("COORD-1010: adr-validator normalizer admits upper- and lower-case ADR refs identically", () => {
  const validatorNormalize = adrValidator.__testing.normalizeAdrRef;
  for (const [input, expected] of CORPUS) {
    assert.equal(validatorNormalize(input), expected, `validator normalizer on ${JSON.stringify(input)}`);
  }
});

test("COORD-1010: the two normalizers agree on every corpus input", () => {
  const validatorNormalize = adrValidator.__testing.normalizeAdrRef;
  for (const [input] of CORPUS) {
    assert.equal(validatorNormalize(input), normalizeAdrRef(input), `disagreement on ${JSON.stringify(input)}`);
  }
});

test("COORD-1010: decision-context packet admits lower- and upper-case adr_refs", () => {
  for (const ref of ["ADR-0021", "adr-0021"]) {
    const result = expandDecisionContext({ schema_version: 1, adr_refs: [ref] });
    assert.equal(result.ok, true, `packet refused ${ref}: ${JSON.stringify(result.problems)}`);
    assert.deepEqual(result.options.adrRef, [ref]);
  }
  const refused = expandDecisionContext({ schema_version: 1, adr_refs: ["adr-21"] });
  assert.equal(refused.ok, false);
});

test("COORD-1010: update-plan admits upper- and lower-case --adr-ref and stores the spelling given", () => {
  withRegisterPromptHarness("c1010-adr-case-", { ticketId: "IMP-1010" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c1010-fixture-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-1010", "--seed"]).ok, true);
    const upper = run(["update-plan", "IMP-1010", "--adr-ref", "ADR-0001"]);
    assert.equal(upper.ok, true, upper.error);
    const lower = run(["update-plan", "IMP-1010", "--adr-ref", "adr-0002"]);
    assert.equal(lower.ok, true, lower.error);
    const record = JSON.parse(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-1010.json"), "utf8"));
    assert.deepEqual(record.adr_refs, ["ADR-0001", "adr-0002"]);
    const unrecognized = run(["update-plan", "IMP-1010", "--adr-ref", "adr-21"]);
    assert.equal(unrecognized.ok, false);
  });
});
