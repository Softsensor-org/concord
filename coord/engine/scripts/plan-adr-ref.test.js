"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

const { state: governanceState } = require("./governance-context.js");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { executeCommand, withRegisterPromptHarness, __testing } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { parseFlags, buildVerbHelpText } = require("./cli.js").__testing;
require("./cli-surface.js").bindParser(() => parseFlags);
const { parseLifecycleFlags } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-flags.js"))({});

function readPlanRecordFromSandbox(ticketId) {
  return JSON.parse(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`), "utf8"));
}

test("COORD-714: both parsers preserve repeated ADR refs and help advertises them", () => {
  for (const parse of [parseFlags, parseLifecycleFlags]) {
    assert.deepEqual(parse(["--adr-ref", "ADR-0001", "--adr-ref", "0002"]), { adrRef: ["ADR-0001", "0002"] });
    assert.throws(() => parse(["--adr-ref"]), /requires a value/);
    assert.throws(() => parse(["--adr-ref", ""]), /requires a value/);
  }
  assert.match(buildVerbHelpText("update-plan"), /--adr-ref/);
  const entry = require("./cli-surface.js").buildSurfaceReport().flags.find((entry) => entry.flag === "--adr-ref");
  assert.deepEqual(entry.option_keys, ["adrRef"]);
});

test("COORD-714: public update-plan persists, validates and renders ADR refs atomically", () => {
  withRegisterPromptHarness("c714-plan-", { ticketId: "IMP-714" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c714-fixture-thread" } });
    const bind = run(["agentid", "--owner", "claudea11"]);
    assert.equal(bind.ok, true, bind.error);
    const seed = run(["plan", "IMP-714", "--seed"]);
    assert.equal(seed.ok, true, seed.error);
    const update = run(["update-plan", "IMP-714", "--adr-ref", "ADR-0001", "--adr-ref", "0002"]);
    assert.equal(update.ok, true, update.error);
    const record = readPlanRecordFromSandbox("IMP-714");
    assert.deepEqual(record.adr_refs, ["ADR-0001", "0002"]);
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), /`ADR-0001`/);
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), /`0002`/);
    const files = [path.join(governanceState.PLAN_RECORDS_DIR, "IMP-714.json"), governanceState.PLAN_PATH, governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH];
    const before = files.map((file) => fs.readFileSync(file, "utf8"));
    for (const bad of ["", "   ", "ADR-nope", "123", "not-an-adr"]) {
      const rejected = run(["update-plan", "IMP-714", "--adr-ref", "ADR-0003", "--adr-ref", bad]);
      assert.equal(rejected.ok, false, `invalid reference ${JSON.stringify(bad)} accepted`);
      assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before, "a rejected batch must not append the valid prefix");
    }
  });
});

test("COORD-714: every public plan option has an executable flag on both parsers", () => {
  const { PLAN_UPDATE_OPTION_KEYS } = require("./plan-update-options.js");
  const surface = require("./cli-surface.js");
  // These writer switches belong to explicit structured setter/correction
  // verbs, not update-plan. Exposing wholesale replacement would change
  // COORD-748; exposing evidenceSupersession or evidenceDisposition (COORD-807
  // invariant retraction) would bypass the dedicated actor-attributed
  // correction command. COORD-718: independentReview belongs to
  // record-independent-review, whose reviewer is never the plan owner.
  // COORD-860: managedExecution belongs to record-managed-evidence, which
  // computes the summary instead of accepting one.
  const internal = new Set(["replaceClosure", "replaceAllReviewCycles", "evidenceSupersession", "evidenceDisposition", "independentReview", "managedExecution"]);
  const help = buildVerbHelpText("update-plan");
  const flags = surface.flagTokens();
  for (const key of PLAN_UPDATE_OPTION_KEYS.filter((key) => !internal.has(key))) {
    const matches = flags.filter((flag) => surface.flagOptionKeys(flag).includes(key));
    assert.ok(matches.length, `public plan option ${key} is unreachable`);
    let reached = false;
    for (const flag of matches) {
      assert.ok(help.includes(flag), `${flag} missing from update-plan help`);
      for (const value of ["ADR-0001", "1", "none", "{}", "yes", "completed", "verified", "standard", "no_pr"]) {
        try {
          const left = parseFlags([flag, value]);
          const right = parseLifecycleFlags([flag, value]);
          if (Object.hasOwn(left, key) && Object.hasOwn(right, key)) reached = true;
        } catch { /* probe another valid value */ }
      }
    }
    assert.ok(reached, `public plan option ${key} missing from a parser`);
  }
});

test("COORD-713: evidence supersession stays private to its governed correction verb", () => {
  const { evidenceRef, resolvePlanEvidence } = require("./plan-evidence-supersession.js");
  withRegisterPromptHarness("c713-private-supersession-option-", { ticketId: "IMP-713" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c713-private-option-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm test [result=pass] on stale head"]).ok, true);

    const injected = JSON.stringify({
      kind: "repo_gate",
      entry: "repo_gate:1:example",
      replacement: "npm test corrected [result=pass] on current head",
      reason: "private writer data must not be a public update-plan option",
      actor: "forged-actor",
    });
    for (const parse of [parseFlags, parseLifecycleFlags]) {
      assert.throws(() => parse(["--evidence-supersession", injected]), /Unknown flag/);
    }

    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json");
    const planPath = governanceState.PLAN_PATH;
    const boardPath = governanceState.BOARD_PATH;
    const eventPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const before = [recordPath, planPath, boardPath, eventPath].map((file) => fs.readFileSync(file, "utf8"));
    const publicInjection = run(["update-plan", "IMP-713", "--evidence-supersession", injected]);
    assert.equal(publicInjection.ok, false);
    assert.match(publicInjection.error, /Unknown flag/);
    assert.deepEqual([recordPath, planPath, boardPath, eventPath].map((file) => fs.readFileSync(file, "utf8")), before,
      "the public update-plan dispatcher refuses private correction data before writes");

    const source = readPlanRecordFromSandbox("IMP-713").repo_gates[0];
    const correction = run([
      "supersede-plan-evidence", "IMP-713", "--kind", "repo_gate",
      "--entry", evidenceRef("repo_gate", 1, source),
      "--replacement", "npm test corrected [result=pass] on current head",
      "--reason", "The recorded result used a stale head.",
    ]);
    assert.equal(correction.ok, true, correction.error);
    const corrected = readPlanRecordFromSandbox("IMP-713");
    const projection = resolvePlanEvidence(corrected);
    assert.equal(corrected.evidence_supersessions.length, 1);
    assert.equal(corrected.evidence_supersessions[0].actor, "claudea11");
    assert.deepEqual(projection.repo_gates, ["npm test corrected [result=pass] on current head"]);
    assert.deepEqual(corrected.repo_gates, [source, "npm test corrected [result=pass] on current head"],
      "the raw record keeps source history and appends the correction target");
  });
});

test("COORD-807: invariant retraction stays private to its governed correction verb", () => {
  const { resolvePlanEvidence } = require("./plan-evidence-supersession.js");
  withRegisterPromptHarness("c807-private-disposition-option-", { ticketId: "IMP-807" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c807-private-option-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-807", "--seed"]).ok, true);
    const junk = "timing probe 1 finished in 12ms";
    const kept = "retraction must leave unrelated invariants active";
    assert.equal(run(["update-plan", "IMP-807", "--invariant", junk, "--invariant", kept]).ok, true);

    const injected = JSON.stringify({
      kind: "critical_invariant",
      entry: junk,
      disposition: "retracted",
      reason: "private writer data must not be a public update-plan option",
      actor: "forged-actor",
    });
    for (const parse of [parseFlags, parseLifecycleFlags]) {
      assert.throws(() => parse(["--evidence-disposition", injected]), /Unknown flag/);
    }

    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-807.json");
    const files = [recordPath, governanceState.PLAN_PATH, governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH];
    const before = files.map((file) => fs.readFileSync(file, "utf8"));
    const publicInjection = run(["update-plan", "IMP-807", "--evidence-disposition", injected]);
    assert.equal(publicInjection.ok, false);
    assert.match(publicInjection.error, /Unknown flag/);
    assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before,
      "the public update-plan dispatcher refuses private retraction data before writes");
    // --disposition is a real flag, but only the correction verb consumes it:
    // update-plan must not turn it into a retraction.
    run(["update-plan", "IMP-807", "--disposition", "retracted", "--summary", "disposition flag is inert on update-plan"]);
    assert.equal(readPlanRecordFromSandbox("IMP-807").evidence_dispositions, undefined);
    assert.deepEqual(resolvePlanEvidence(readPlanRecordFromSandbox("IMP-807")).critical_invariants, [junk, kept]);

    const correction = run([
      "supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant",
      "--entry", junk, "--disposition", "retracted",
      "--reason", "A timing probe is not an invariant.",
    ]);
    assert.equal(correction.ok, true, correction.error);
    const corrected = readPlanRecordFromSandbox("IMP-807");
    assert.equal(corrected.evidence_dispositions.length, 1);
    assert.equal(corrected.evidence_dispositions[0].actor, "claudea11");
    assert.deepEqual(resolvePlanEvidence(corrected).critical_invariants, [kept]);
    assert.deepEqual(corrected.critical_invariants, [junk, kept], "the raw record keeps the retracted source");
  });
});

test("COORD-662: update-plan file companions preserve literal text in both parser entry points", () => {
  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord662-plan-files-"));
  const contents = new Map([
    ["--summary-file", "summary line one\nsummary $(literal)\n"],
    ["--closure-file", "closure line one\nclosure $HOME\n"],
    ["--review-cycle-file", "review line one\nreview `literal`\n"],
  ]);
  try {
    for (const [flag, text] of contents) {
      const file = path.join(tempDir, `${flag.slice(2)}.txt`);
      fs.writeFileSync(file, text, "utf8");
      const option = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()).replace(/File$/, "");
      const expected = { [option]: flag === "--closure-file" || flag === "--review-cycle-file" ? [text] : text };
      for (const parse of [parseFlags, parseLifecycleFlags]) {
        assert.deepStrictEqual(parse([flag, file]), expected, `${flag} must be parsed from its own literal file`);
      }
    }
    const help = buildVerbHelpText("update-plan");
    for (const flag of contents.keys()) assert.ok(help.includes(flag), `${flag} is missing from update-plan help`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const disposition of ["compliance", "waiver"]) {
  test(`COORD-641: emitted ADR ${disposition} closure command executes and clears its citation gate`, () => {
    withRegisterPromptHarness(`c641-${disposition}-`, { ticketId: "IMP-641" }, () => {
      const run = args => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: `c641-${disposition}-thread` } });
      for (const args of [["agentid", "--owner", "claudea11"], ["plan", "IMP-641", "--seed"],
        ["update-plan", "IMP-641", "--adr-ref", "ADR-0002", "--decision-required", JSON.stringify({ required: true, reason: "Synthetic governance policy advice verification" })]]) {
        const result = run(args);
        assert.equal(result.ok, true, result.error);
      }
      const { createAdrGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/adr.js"));
      const { escapeRegex } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
      const { validate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/adr-validator.js"));
      const gate = createAdrGate({ COORD_DIR: path.resolve(__dirname, "..", ".."), path, escapeRegex, validateAdrRegistry: validate });
      const row = { ID: "IMP-641", Type: "bug", Description: "Governance policy advice" };
      const before = gate.collectAdrCloseoutCitationIssues("IMP-641", row, readPlanRecordFromSandbox("IMP-641"));
      assert.equal(before.length, 1);
      assert.equal(before[0].code, "adr_closeout_citation");
      assert.equal(before[0].next_steps.length, 2);
      const commands = before[0].next_steps.filter(command => command.includes(`ADR ${disposition}:`));
      assert.equal(commands.length, 1);
      const command = commands[0].replace("<id>", "0002").replace("<short evidence>", "Preserves canonical evidence")
        .replace("<human-admin waiver / scope>", "Fixture administrator approves only this isolated synthetic advice case");
      // Tokenize the actual printed command; no reconstructed update-plan call.
      const tokens = command.match(/"[^"\n]*"|[^\s]+/g).map(token => token.startsWith('"') ? token.slice(1, -1) : token);
      assert.equal(tokens.shift(), "coord/scripts/gov");
      assert.equal(tokens[0], "update-plan");
      const result = run(tokens);
      assert.equal(result.ok, true, result.error);
      const plan = readPlanRecordFromSandbox("IMP-641");
      assert.ok(plan.requirement_closure.includes(tokens[tokens.indexOf("--closure") + 1]));
      assert.deepEqual(gate.collectAdrCloseoutCitationIssues("IMP-641", row, plan), []);
      const files = [path.join(governanceState.PLAN_RECORDS_DIR, "IMP-641.json"), governanceState.PLAN_PATH, governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH];
      const bytes = files.map(file => fs.readFileSync(file, "utf8"));
      const invalid = run(["update-plan", "IMP-641", "--closure", "ADR compliance: invalid prefix must still refuse"]);
      assert.equal(invalid.ok, false);
      assert.match(invalid.error, /must start with one of/);
      assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), bytes);
    });
  });
}
