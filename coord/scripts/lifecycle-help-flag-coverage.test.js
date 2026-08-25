"use strict";

// COORD-612: a supported-but-undocumented CLI flag is a governance hazard, not a
// cosmetic gap.
//
// `gov update-plan --context-pack-ack` was fully wired (cli.js flag table ->
// plan-records.applyPlanUpdateOptionsToRecord -> context_pack_ack), and the
// review gate REQUIRES a structured context_pack_ack — but the flag appeared in
// no help surface. Three agents in one session (COORD-607/609/611) concluded "no
// CLI verb exists for this" and wrote the ack straight into the canonical plan
// record under coord/.runtime/plans/<TICKET>.json, which is exactly the
// hand-editing of governed state GOVERNANCE.md forbids. The tool's own
// documentation gap manufactured the forbidden action.
//
// This guard makes that class of gap unrepresentable for `update-plan`: every
// flag the CLI actually dispatches into the update-plan option surface must be
// published in the help text.
//
// DERIVATION, NOT A HAND-LIST. A hand-maintained flag list here would reproduce
// the very drift the ticket is about, so both ends are derived from the real
// artifacts:
//   * the FLAG side is ground truth from the live parser — every flag token in
//     cli.js's dispatch tables is fed through the exported `parseFlags` and the
//     option key it produces is OBSERVED, not assumed;
//   * the CONSUMER side is parsed out of plan-records.js's
//     `applyPlanUpdateOptionsToRecord` body — the single function that decides
//     which `options.*` keys an `update-plan` call can affect;
//   * the HELP side is the same text `gov help` / `gov <verb> --help` emit.
// Both derivations are protected by explicit fidelity assertions below, so this
// file cannot silently disarm itself if either source file is restructured.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = __dirname;
const cli = require("./cli.js");
const { parseFlags } = cli.__testing;
const { buildHelpText, buildVerbHelpText } = cli.__testing;

// --- derivation 1: every flag token the CLI dispatch tables accept -----------

const CLI_SOURCE = fs.readFileSync(path.join(SCRIPTS_DIR, "cli.js"), "utf8");
const FLAG_TABLE_NAMES = ["VALUE_FLAGS", "APPEND_FLAGS", "BOOL_FLAGS", "SPECIAL_FLAGS"];

function extractFlagTokens() {
  const tokens = new Set();
  for (const name of FLAG_TABLE_NAMES) {
    const start = CLI_SOURCE.indexOf(`const ${name} = Object.freeze({`);
    assert.ok(start >= 0, `cli.js no longer defines a ${name} dispatch table — this guard must be re-pointed, not deleted.`);
    const end = CLI_SOURCE.indexOf("\n});", start);
    assert.ok(end > start, `cli.js ${name} table has no recognizable end — re-point this guard.`);
    for (const match of CLI_SOURCE.slice(start, end).matchAll(/"(--[a-z0-9-]+)"\s*:/g)) {
      tokens.add(match[1]);
    }
  }
  return [...tokens].sort();
}

// Ask the LIVE parser what option key a flag produces. Probe values cover the
// flags that validate their argument (--status, --result, --base-result) and the
// ones coerced to an integer, so no flag is misclassified by guesswork.
const PROBE_VALUES = ["1", "pass", "todo"];

function optionKeysFor(flag) {
  try {
    return Object.keys(parseFlags([flag]));
  } catch {
    // needs a value
  }
  for (const value of PROBE_VALUES) {
    try {
      return Object.keys(parseFlags([flag, value]));
    } catch {
      // try the next probe
    }
  }
  return [];
}

// --- derivation 2: the option keys an update-plan call can actually affect ---

const PLAN_RECORDS_SOURCE = fs.readFileSync(path.join(SCRIPTS_DIR, "plan-records.js"), "utf8");

function extractUpdatePlanOptionKeys() {
  const marker = "function applyPlanUpdateOptionsToRecord(record, options = {}) {";
  const start = PLAN_RECORDS_SOURCE.indexOf(marker);
  assert.ok(
    start >= 0,
    "plan-records.js no longer defines applyPlanUpdateOptionsToRecord(record, options) — " +
      "the update-plan option surface moved and this guard must be re-pointed, not deleted."
  );
  // The function body ends at the next declaration at the same (2-space) indent.
  const rest = PLAN_RECORDS_SOURCE.slice(start + marker.length);
  const endMatch = rest.match(/\n {2}function [A-Za-z]/);
  const body = endMatch ? rest.slice(0, endMatch.index) : rest;
  const keys = new Set();
  for (const match of body.matchAll(/\boptions\.([A-Za-z][A-Za-z0-9]*)/g)) {
    keys.add(match[1]);
  }
  // COORD-572: the JSON-object plan fields are no longer four copies of the same
  // `if (options.x !== undefined)` block — they are one loop over an exported
  // table, so they are read as `options[optionKey]` and a source regex cannot
  // see them. Union the table itself: reading the DATA the writer iterates is a
  // strictly better derivation than scraping the imperative body for names, and
  // it is what let `--bootstrap-risk` join the surface at all.
  for (const [optionKey] of require("./plan-records.js").JSON_OBJECT_PLAN_FIELDS) {
    keys.add(optionKey);
  }
  return keys;
}

// --- derivation 3: the published help for the verb ---------------------------

function updatePlanHelpText() {
  const verbHelp = buildVerbHelpText("update-plan");
  assert.ok(verbHelp, "`gov update-plan --help` produced no text.");
  // Only lines that are ABOUT update-plan count: a flag documented for some
  // other verb must not launder an update-plan flag into "documented".
  const scoped = [buildHelpText({ all: false }), buildHelpText({ all: true })]
    .join("\n")
    .split(/\n(?=\s*(?:coord\/scripts\/gov|node coord\/scripts\/governance\.js)\s)/)
    .filter((entry) => /(?:coord\/scripts\/gov|governance\.js)\s+update-plan\b/.test(entry))
    .join("\n");
  return { verbHelp, scoped };
}

const FLAG_TOKENS = extractFlagTokens();
const UPDATE_PLAN_OPTION_KEYS = extractUpdatePlanOptionKeys();
const UPDATE_PLAN_FLAGS = FLAG_TOKENS.filter((flag) =>
  optionKeysFor(flag).some((key) => UPDATE_PLAN_OPTION_KEYS.has(key))
);

test("COORD-612: the derivation itself is intact (this guard cannot silently disarm)", () => {
  assert.ok(
    FLAG_TOKENS.length >= 100,
    `parsed only ${FLAG_TOKENS.length} flag tokens out of cli.js — the dispatch tables were restructured and the parse is no longer faithful.`
  );
  for (const anchor of ["--summary", "--invariant", "--context-pack-ack", "--review-cycle"]) {
    assert.ok(FLAG_TOKENS.includes(anchor), `flag-token parse lost the known flag ${anchor}.`);
  }
  assert.ok(
    UPDATE_PLAN_OPTION_KEYS.size >= 20,
    `parsed only ${UPDATE_PLAN_OPTION_KEYS.size} option keys out of applyPlanUpdateOptionsToRecord — the parse is no longer faithful.`
  );
  for (const anchor of ["contextPackAck", "invariant", "repoGate", "reviewCycle"]) {
    assert.ok(UPDATE_PLAN_OPTION_KEYS.has(anchor), `option-key parse lost the known key ${anchor}.`);
  }
  assert.ok(
    UPDATE_PLAN_FLAGS.length >= 15,
    `derived only ${UPDATE_PLAN_FLAGS.length} update-plan flags; the flag->option-key join is broken.`
  );
  assert.ok(
    UPDATE_PLAN_FLAGS.includes("--context-pack-ack"),
    "the flag that caused this ticket is no longer derived as an update-plan flag."
  );
  const { scoped } = updatePlanHelpText();
  assert.ok(scoped.length > 200, "no update-plan-scoped help text was found to check against.");
});

test("COORD-612: every flag the CLI dispatches for update-plan is published in its help", () => {
  const { scoped } = updatePlanHelpText();
  const undocumented = UPDATE_PLAN_FLAGS.filter((flag) => !scoped.includes(flag));
  assert.deepStrictEqual(
    undocumented,
    [],
    `update-plan accepts flag(s) that appear in NO help surface: ${undocumented.join(", ")}. ` +
      "A supported-but-invisible flag pushes agents toward hand-editing governed plan state " +
      "(COORD-607/609/611). Publish it in coord/scripts/lifecycle-help.js."
  );
});

test("COORD-612: `gov update-plan --help` publishes the same flag set", () => {
  const { verbHelp } = updatePlanHelpText();
  const missing = UPDATE_PLAN_FLAGS.filter((flag) => !verbHelp.includes(flag));
  assert.deepStrictEqual(missing, [], `\`gov update-plan --help\` omits: ${missing.join(", ")}.`);
});

// --- the documented --context-pack-ack example must actually be accepted -----

function documentedContextPackAckExample() {
  const { verbHelp } = updatePlanHelpText();
  const match = verbHelp.match(/--context-pack-ack '(\{.*\})'/);
  assert.ok(match, "the help no longer carries a concrete --context-pack-ack JSON example.");
  return JSON.parse(match[1]);
}

test("COORD-612: the documented --context-pack-ack example is accepted by the runtime validator", () => {
  const createValidators = require("./plan-record-field-validators.js");
  const { assertValidContextPackAck } = createValidators({
    fail: (message) => {
      throw new Error(message);
    },
  });
  assert.doesNotThrow(() => assertValidContextPackAck(documentedContextPackAckExample()));
});

test("COORD-612: the documented --context-pack-ack example is accepted by plan.schema.json", () => {
  // plan.schema.json declares context_pack_ack with additionalProperties:false at
  // every level, and it is STRICTER than the runtime validator in places (it has
  // no `notes`, no `authority.rejected_authority`, and requires arrays where the
  // validator also allows a bare string). The documented example must satisfy the
  // stricter of the two, or copying it would produce a record the schema rejects.
  const schema = JSON.parse(
    fs.readFileSync(path.join(SCRIPTS_DIR, "..", "board", "plan.schema.json"), "utf8")
  );
  const ackSchema = schema.properties.context_pack_ack;
  assert.ok(ackSchema, "plan.schema.json no longer declares context_pack_ack.");

  const walk = (value, node, pointer) => {
    if (node.additionalProperties === false && node.properties) {
      for (const key of Object.keys(value)) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(node.properties, key),
          `documented context_pack_ack example uses ${pointer}.${key}, which plan.schema.json rejects.`
        );
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = node.properties?.[key];
      if (!childSchema) {
        continue;
      }
      if (childSchema.type === "array") {
        assert.ok(
          Array.isArray(child),
          `documented context_pack_ack example sets ${pointer}.${key} to a non-array; plan.schema.json requires an array.`
        );
      } else if (childSchema.type === "object" && child && typeof child === "object") {
        walk(child, childSchema, `${pointer}.${key}`);
      } else if (Array.isArray(childSchema.enum)) {
        assert.ok(
          childSchema.enum.includes(child),
          `documented context_pack_ack example sets ${pointer}.${key}=${child}, outside the schema enum.`
        );
      }
    }
  };
  walk(documentedContextPackAckExample(), ackSchema, "context_pack_ack");
});
