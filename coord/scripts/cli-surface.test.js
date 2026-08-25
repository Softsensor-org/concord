"use strict";

// COORD-572 criteria (b), (c) and (d): a capability must be findable by the name
// a caller is likely to GUESS; a JSON field must be findable under BOTH the
// spelling the record uses and the spelling the CLI uses; and an accepted enum
// must be printed AT THE POINT OF USE.
//
// Each of these is a confirmed instance, not a hypothetical:
//   (b) `add-prompt` was filed as a missing verb (COORD-511) while it had
//       already shipped as `register-prompt --create`.
//   (c) `context_pack_ack` vs `contextPackAck` is the split that hid the ack
//       writer from three agents, who then hand-edited the plan record.
//   (d) gates/business-context.js required one of a six-value closed enum while
//       printing `<owner/status>` (COORD-553, refiled as COORD-569).
//
// Everything asserted here is DERIVED from the live CLI by cli-surface.js, so a
// future flag, verb, enum, or plan field is covered the moment it is added.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const surface = require("./cli-surface.js");
const cli = require("./cli.js");
const { buildHelpText, parseFlags } = cli.__testing;

const HELP = [buildHelpText({ all: false }), buildHelpText({ all: true })].join("\n");

// --- the settled inventory --------------------------------------------------

// THE DEFENSIBLE COUNT. The ticket recorded two irreconcilable measurements: a
// peer's 136 registered / 24 undocumented, and a broader regex over
// lifecycle-flags.js + cli.js giving 194 / 70. Both are artifacts of HOW they
// counted. The peer measured lifecycle-flags.js alone (the DI-decoupled copy of
// the table, which is smaller); the regex swept every quoted `--token` in both
// files, including tokens inside comments and prose that no table registers.
//
// This is the count that survives review, because it is the count the RUNTIME
// produces: every key of cli.js's four dispatch tables, each one fed through the
// live parseFlags and confirmed to yield an option key, checked against the exact
// text `gov help` and `gov help --all` emit.
const FLAGS = surface.flagTokens();
const UNDOCUMENTED_FLAGS = FLAGS.filter((flag) => !HELP.includes(flag));

test("COORD-572: the flag inventory is measured from the live parser, and undocumented flags may only shrink", () => {
  // 192 -> 194: COORD-667 adds `--merge-workspace` and COORD-691 adds
  // `--push-before-closeout`. Both are documented in lifecycle-help.js, so the
  // undocumented ratchet below is unchanged.
  assert.strictEqual(
    FLAGS.length,
    194,
    `the accepted-flag count moved to ${FLAGS.length}. That is fine when flags are added or removed — ` +
      "update this number and the ratchet below together, deliberately."
  );
  // Every counted token must actually be a flag the live parser accepts. This is
  // what makes 194 a measurement rather than a regex artifact.
  for (const flag of FLAGS) {
    assert.ok(
      surface.flagOptionKeys(flag).length > 0,
      `${flag} is registered in a dispatch table but produces no option key through the live parser.`
    );
  }
  // COORD-616 owns draining the remaining backlog; this guard's job is to make
  // sure it cannot refill. A NEW undocumented flag fails here.
  assert.ok(
    UNDOCUMENTED_FLAGS.length <= 41,
    `undocumented flags grew to ${UNDOCUMENTED_FLAGS.length} (ratchet 41). New flag(s) shipped without ` +
      `a help entry: ${UNDOCUMENTED_FLAGS.join(", ")}. Publish them in coord/scripts/lifecycle-help.js.`
  );
});

// --- (b) canonical names AND aliases ---------------------------------------

test("COORD-572 (b): a capability is findable under the name a caller is likely to guess", () => {
  // The exact miss that produced COORD-511.
  const suggestions = surface.suggestVerbs("add-prompt");
  assert.ok(
    suggestions.some((entry) => entry.startsWith("register-prompt")),
    `"add-prompt" must resolve to register-prompt; got ${JSON.stringify(suggestions)}.`
  );
  // And the CLI itself must say so, not just the library.
  const result = cli.executeCommand(["add-prompt"]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Unknown command "add-prompt"/);
  assert.match(result.error, /register-prompt/);

  // Every dispatched verb resolves to itself, so no shipped capability is
  // unreachable by its own name.
  for (const verb of surface.verbs()) {
    const ranked = surface.suggestVerbs(verb, 6).map((entry) => entry.split(" ")[0]);
    assert.ok(ranked.includes(verb), `"${verb}" does not rank itself as a suggestion.`);
  }

  // A mistyped flag suggests the real one rather than only refusing.
  const flagResult = cli.executeCommand(["update-plan", "COORD-000", "--contextpackack", "{}"]);
  assert.strictEqual(flagResult.ok, false);
  assert.match(flagResult.error, /--context-pack-ack/);
});

test("COORD-572 (b): alias groups are derived from the dispatch table and stay consistent", () => {
  const groups = surface.verbAliasGroups();
  const verbs = new Set(surface.verbs());
  const seen = new Set();
  for (const group of groups) {
    for (const verb of group.verbs) {
      assert.ok(verbs.has(verb), `alias group names "${verb}", which is not a dispatched verb.`);
      assert.ok(!seen.has(verb), `"${verb}" appears in more than one alias group.`);
      seen.add(verb);
    }
  }
  assert.deepStrictEqual(
    [...verbs].filter((verb) => !seen.has(verb)),
    [],
    "every dispatched verb must belong to exactly one alias group."
  );
  // Known aliases the router really has, as a fidelity anchor.
  const grouped = groups.map((group) => group.verbs.join(","));
  for (const expected of ["file-ticket,new", "abandon-lock,lock-abandon", "start,start-ticket"]) {
    assert.ok(grouped.includes(expected), `alias derivation lost the known group ${expected}.`);
  }
});

// --- (c) JSON field names ---------------------------------------------------

test("COORD-572 (c): every JSON plan field is reachable and published under both spellings", () => {
  const fields = surface.planObjectFields();
  assert.ok(fields.length >= 5, `only ${fields.length} JSON plan fields derived.`);
  for (const field of fields) {
    // The two spellings are mechanically related, so neither can drift.
    const camelFromSnake = field.record_field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.strictEqual(
      camelFromSnake,
      field.option_key,
      `plan field ${field.record_field} and option key ${field.option_key} are not the same name.`
    );
    assert.ok(field.declared_in_schema, `${field.record_field} is written by the CLI but absent from plan.schema.json.`);
    // A WRITER MUST EXIST. bootstrap_risk was schema-declared and gate-enforced
    // with no reachable writer, which is why its gate could only advise a
    // hand-edit of the canonical plan record.
    assert.deepStrictEqual(
      surface.flagOptionKeys(field.flag),
      [field.option_key],
      `${field.flag} does not parse to ${field.option_key} through the live parser.`
    );
    // And it must be discoverable.
    assert.ok(
      HELP.includes(field.flag),
      `${field.flag} writes ${field.record_field} but appears in no help surface.`
    );
  }
  // The writer really writes the canonical snake_case key.
  const planRecords = require("./plan-records.js");
  assert.ok(Array.isArray(planRecords.JSON_OBJECT_PLAN_FIELDS));
  for (const [optionKey, recordField] of planRecords.JSON_OBJECT_PLAN_FIELDS) {
    assert.strictEqual(planRecords.optionKeyToFlag(optionKey), `--${recordField.replace(/_/g, "-")}`);
  }
});

test("COORD-572 (c): `gov surface` publishes both spellings against the writing flag", () => {
  const report = surface.buildSurfaceReport();
  const ack = report.json_fields.find((entry) => entry.record_field === "context_pack_ack");
  assert.ok(ack, "the surface no longer publishes context_pack_ack.");
  assert.strictEqual(ack.option_key, "contextPackAck");
  assert.strictEqual(ack.flag, "--context-pack-ack");
});

// --- (d) accepted enum literals, printed at the point of use ----------------

test("COORD-572 (d): every parser-constrained flag prints its accepted literals, and they are true", () => {
  const constrained = surface.enumConstrainedFlags();
  assert.ok(constrained.length >= 3, `only ${constrained.length} enum-constrained flags found.`);
  for (const entry of constrained) {
    assert.ok(
      entry.advertised.length > 0,
      `${entry.flag} rejects values but its refusal names no accepted literal, so the only way to learn ` +
        `the enum is to read the source. Message was: ${entry.message}`
    );
    // Advertised is not the same as true. Every literal the message names is
    // re-fed through the live parser, so advice that lists the WRONG values
    // fails exactly as loudly as advice that lists none.
    assert.deepStrictEqual(
      entry.advertised,
      entry.accepted,
      `${entry.flag} advertises literal(s) the parser rejects: ` +
        `${entry.advertised.filter((value) => !entry.accepted.includes(value)).join(", ")}`
    );
  }
  const status = constrained.find((entry) => entry.flag === "--status");
  assert.ok(status, "--status is no longer detected as enum-constrained.");
  const { legalStatusSet, legalFindingStatusSet } = require("./governance-constants.js");
  for (const value of [...legalStatusSet(), ...legalFindingStatusSet()]) {
    assert.ok(
      status.accepted.includes(value),
      `--status accepts "${value}" but does not advertise it.`
    );
  }
});

test("COORD-572 (d): the business-context closed enum is printed by the gate that enforces it", () => {
  const businessContext = require("./gates/business-context.js");
  const statuses = businessContext.BUSINESS_CONTEXT_INVESTIGATION_STATUSES;
  assert.ok(statuses.length >= 6, "the investigation status enum shrank unexpectedly.");
  const source = fs.readFileSync(path.join(__dirname, "gates", "business-context.js"), "utf8");
  assert.ok(
    source.includes("BUSINESS_CONTEXT_INVESTIGATION_STATUSES.join"),
    "the gate no longer derives its printed remediation from the enum constant, so the two can drift again."
  );
  // The remediation the gate emits must satisfy the recognizer that emitted it.
  for (const status of statuses) {
    assert.match(
      `business-context investigation: ${status}`,
      businessContext.BUSINESS_CONTEXT_INVESTIGATION_PATTERN,
      `the gate accepts "${status}" but its own recognizer does not.`
    );
  }
  // And the trap value the gate used to advertise must NOT satisfy it.
  assert.doesNotMatch(
    "business-context investigation: claudea11/complete",
    businessContext.BUSINESS_CONTEXT_INVESTIGATION_PATTERN,
    "free text in the <owner/status> shape must remain unrecognized — it is what COORD-553 mis-filed."
  );
});

// --- the generated surface is actually reachable ---------------------------

test("COORD-572: `gov surface` runs and reports the generated inventory", () => {
  const result = cli.executeCommand(["surface", "--json"]);
  assert.strictEqual(result.ok, true, `gov surface failed: ${result.error}`);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.flags.length, FLAGS.length);
  assert.ok(report.verbs.includes("surface"), "the surface verb does not list itself.");
  assert.ok(report.verb_aliases.length >= 10, "alias groups are missing from the report.");
  assert.ok(HELP.includes("gov surface"), "the surface verb is itself undocumented.");
});

test("COORD-572: the derivation fails loudly rather than reporting an empty surface", () => {
  // The fidelity assertions inside cli-surface.js are what stop this whole guard
  // from passing by measuring nothing. Prove the tripwire is real: the verb
  // collector returns an EMPTY set for input it cannot read, and cli-surface
  // requires >= 100 verbs, so an unreadable dispatch table throws instead of
  // silently publishing an empty inventory.
  const collect = require("./verb-parity.js").collectDispatchCommandVerbs;
  assert.strictEqual(collect("not javascript at all").size, 0);
  assert.strictEqual(collect(12345).size, 0);
  assert.ok(surface.verbs().length >= 100);
  assert.ok(surface.flagTokens().length >= 150);
  for (const anchor of ["--context-pack-ack", "--transfer-to", "--closeout-blocker"]) {
    assert.ok(surface.flagTokens().includes(anchor), `flag derivation lost ${anchor}.`);
  }
});
