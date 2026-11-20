"use strict";

// COORD-612: a supported-but-undocumented CLI flag is a governance hazard, not a
// cosmetic gap.
//
// `gov update-plan --context-pack-ack` was fully wired (../engine/scripts/cli.js flag table ->
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
const cli = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/cli.js"));
const surface = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/cli-surface.js"));
const { parseFlags } = cli.__testing;
surface.bindParser(() => cli.__testing.parseFlags);
const { buildHelpText, buildVerbHelpText } = cli.__testing;

// --- derivation 1: every flag token the CLI dispatch tables accept -----------

const CLI_SOURCE = fs.readFileSync(path.join(SCRIPTS_DIR, "cli.js"), "utf8");
const FLAG_TABLE_NAMES = ["VALUE_FLAGS", "APPEND_FLAGS", "BOOL_FLAGS", "SPECIAL_FLAGS"];

function extractFlagTokens() {
  const tokens = new Set();
  for (const name of FLAG_TABLE_NAMES) {
    const start = CLI_SOURCE.indexOf(`const ${name} = Object.freeze({`);
    assert.ok(start >= 0, `../engine/scripts/cli.js no longer defines a ${name} dispatch table — this guard must be re-pointed, not deleted.`);
    const end = CLI_SOURCE.indexOf("\n});", start);
    assert.ok(end > start, `../engine/scripts/cli.js ${name} table has no recognizable end — re-point this guard.`);
    for (const match of CLI_SOURCE.slice(start, end).matchAll(/"(--[a-z0-9-]+)"\s*:/g)) {
      tokens.add(match[1]);
    }
  }
  // COORD-984: the shared flags are defined once in flag-tables.js and spread into cli.js's tables.
  for (const table of Object.values(require("./flag-tables.js"))) {
    for (const key of Object.keys(table)) {
      if (/^--[a-z0-9-]+$/.test(key)) tokens.add(key);
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
    "coord/engine/scripts/plan-records.js no longer defines applyPlanUpdateOptionsToRecord(record, options) — " +
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
  for (const [optionKey] of require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/plan-records.js")).JSON_OBJECT_PLAN_FIELDS) {
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
      "(COORD-607/609/611). Publish it in coord/engine/scripts/lifecycle-help.js."
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
  const createValidators = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/plan-record-field-validators.js"));
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
    fs.readFileSync(path.join(SCRIPTS_DIR, "..", "..", "board", "plan.schema.json"), "utf8")
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

function hasWholeToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`).test(text);
}

test("COORD-616: every dispatched spelling has usable per-verb help, aliases included", () => {
  const missing = surface.verbs().filter((verb) => !buildVerbHelpText(verb));
  assert.deepStrictEqual(missing, [], `dispatched verb spellings with no projected help: ${missing.join(", ")}`);
  for (const verb of surface.verbs().filter((value) => value !== "help")) {
    const result = cli.executeCommand([verb, "--help"]);
    assert.strictEqual(result.ok, true, `${verb} --help was not handled by the public CLI route.`);
    assert.strictEqual(result.stdout, buildVerbHelpText(verb), `${verb} --help did not emit its projected usage.`);
  }
  const helpCommand = cli.executeCommand(["help", "--help"]);
  assert.strictEqual(helpCommand.ok, true);
  assert.ok(helpCommand.stdout.includes("gov help [--all]"), "gov help must explain its --all usage.");
});

test("COORD-1027: config per-verb help documents the proposal and signed approval inputs", () => {
  const help = buildVerbHelpText("config");
  assert.ok(help, "config must have projected per-verb help");
  for (const token of [
    "config propose",
    "--target",
    "--value-json",
    "--diff-file",
    "--base-digest",
    "config approve",
    "--proposal-id",
    "--human-admin-override",
  ]) {
    assert.ok(help.includes(token), `config help must document ${token}`);
  }
  assert.match(help, /project\.testPolicy/);
  assert.match(help, /signed human-admin override/);
});

// The original source-derived gap inventory is retained here as the contract
// being drained. Each entry joins parser output to a real consumer and the
// command whose help must explain it. This is deliberately command-scoped:
// putting a token elsewhere in the global help cannot satisfy its owner.
const COORD_616_FLAG_CONSUMERS = [
  ["--adapter", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["adapter"]],
  ["--approval", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["approval"]],
  ["--artifact", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["artifact"]],
  ["--build-source", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["buildSource"]],
  ["--claim", "verify", "engine/scripts/runtime-evidence.js", "normalizeRuntimeVerification", ["claim"]],
  ["--class", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["operationClass"]],
  ["--operation-class", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["operationClass"]],
  ["--cleanup", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["cleanup"]],
  ["--closeout-blocker", "open-followup", "engine/scripts/followups.js", "normalizeFollowupRelation", ["closeoutBlocker"]],
  // COORD-867: gates.js moved to coord/engine/scripts; a consumer named by a coord-relative path is read from coord/.
  ["--coverage", "add-repo-gate", "engine/scripts/gates.js", "addRepoGateCommand", ["coverage"]],
  ["--deploy-id", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["deployId"]],
  ["--disable-rollback", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["disableRollback"]],
  ["--env", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["environment"]],
  ["--environment", "verify", "engine/scripts/runtime-evidence.js", "normalizeRuntimeVerification", ["environment"]],
  ["--evidence-class", "verify", "engine/scripts/runtime-evidence.js", "normalizeRuntimeVerification", ["evidenceClass"]],
  ["--execution-mode", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["executionMode"]],
  ["--ext", "code-index", "engine/scripts/code-context.js", "buildIndex", ["ext"]],
  ["--git", "code-index", "engine/scripts/code-context.js", "codeIndexCommand", ["git"]],
  ["--idempotency", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["idempotency"]],
  ["--job", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["job"]],
  ["--meta", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["meta"]],
  ["--observability", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["observability"]],
  ["--operation", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["operation"]],
  ["--operator", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["operator"]],
  ["--parent", "open-followup", "engine/scripts/ticket-commands.js", "openFollowup", ["dependsOn"]],
  ["--parent", "file-ticket", "engine/scripts/ticket-commands.js", "fileTicket", ["dependsOn"]],
  ["--query-shape", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["queryShape"]],
  ["--receipt", "deploy-check", "engine/scripts/runtime-evidence.js", "deployCheck", ["receipt"]],
  ["--receipt", "validate-receipt", "engine/scripts/runtime-evidence.js", "validateReceiptCommand", ["receipt"]],
  ["--receipt-result", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["receiptResult"]],
  ["--redaction", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["redaction"]],
  ["--resource-envelope", "bootstrap-record", "engine/scripts/runtime-evidence.js", "normalizeBootstrapReceipt", ["resourceEnvelope"]],
  ["--role", "recall", "lifecycle-help.js", "recallCommand", ["role"]],
  ["--running-artifact", "deploy-record", "engine/scripts/runtime-evidence.js", "normalizeDeployReceipt", ["runningArtifact"]],
  ["--scope", "live-mcp-record", "engine/scripts/runtime-evidence.js", "normalizeLiveMcpReceipt", ["scope"]],
  ["--scope", "prework", "lifecycle-help.js", "preworkCommand", ["scope"]],
  ["--scope-self", "doctor", "engine/scripts/doctor-report.js", "resolveDoctorOwnerScope", ["scopeSelf"]],
  ["--section-heading", "open-followup", "engine/scripts/ticket-commands.js", "openFollowup", ["sectionHeading"]],
  ["--track", "gate-plan", "lifecycle-gate-code-commands.js", "gatePlanCommand", ["trackOverride"]],
  ["--transfer-to", "claim", "engine/scripts/agent-commands.js", "claimTicket", ["transferTo"]],
  ["--trust-anchor", "sign-journal", "lifecycle-help.js", "signJournalCommand", ["trustAnchor"]],
  ["--worktree", "start", "engine/scripts/ticket-transitions.js", "startTicket", ["worktree"]],
];

const COORD_616_BASELINE_GAPS = [
  "--adapter", "--approval", "--artifact", "--autofill-startup", "--build-source", "--claim",
  "--class", "--cleanup", "--closeout-blocker", "--coverage", "--deploy-id", "--disable-rollback",
  "--env", "--environment", "--evidence-class", "--execution-mode", "--ext", "--git",
  "--idempotency", "--job", "--meta", "--observability", "--operation", "--operation-class",
  "--operator", "--parent", "--query-shape", "--receipt", "--receipt-result", "--redaction",
  "--resource-envelope", "--role", "--running-artifact", "--scope", "--scope-self",
  "--section-heading", "--track", "--transfer-to", "--trust-anchor", "--worktree",
];

function extractFunctionSource(source, functionName) {
  const declaration = new RegExp(`(?:^|\\n)([ \\t]*)function ${functionName}\\s*\\(`).exec(source);
  assert.ok(declaration, `could not find the declared consumer function ${functionName}.`);
  const start = declaration.index + declaration[0].indexOf("function");
  const indent = declaration[1];
  const next = new RegExp(`\\n${indent}function [A-Za-z_$][\\w$]*\\s*\\(`).exec(source.slice(start + declaration[0].length));
  return source.slice(start, next ? start + declaration[0].length + next.index : source.length);
}

test("COORD-616: originally undocumented flags are parser-backed, consumed and documented by their command", () => {
  assert.deepStrictEqual(
    [...new Set(COORD_616_FLAG_CONSUMERS.map(([flag]) => flag))].sort(),
    COORD_616_BASELINE_GAPS.filter((flag) => flag !== "--autofill-startup").sort(),
    "the baseline gap inventory must be completely mapped; removed dead flags are the only excluded token."
  );
  const byToken = new Map();
  const missing = [];
  for (const [flag, verb, sourceName, functionName, keys] of COORD_616_FLAG_CONSUMERS) {
    const optionKeys = surface.flagOptionKeys(flag);
    assert.ok(optionKeys.length > 0, `${flag} is no longer in the accepted CLI parser.`);
    assert.ok(
      optionKeys.some((key) => keys.includes(key)),
      `${flag} no longer parses to one of its documented consumer keys: ${optionKeys.join(", ")}`
    );
    const sourcePath = sourceName.includes("/") ? path.join(SCRIPTS_DIR, "..", "..", sourceName) : path.join(SCRIPTS_DIR, sourceName);
    const source = extractFunctionSource(fs.readFileSync(sourcePath, "utf8"), functionName);
    assert.ok(
      keys.some((key) => new RegExp(`\\boptions\\.${key}\\b`).test(source)),
      `${verb} consumer source ${sourceName} no longer reads the mapped option key(s) ${keys.join(", ")}`
    );
    const help = buildVerbHelpText(verb);
    assert.ok(help, `${verb} has no per-verb help output.`);
    if (!hasWholeToken(help, flag)) missing.push(`${verb} ${flag}`);
    if (!byToken.has(flag)) byToken.set(flag, []);
    byToken.get(flag).push(verb);
  }
  assert.deepStrictEqual(missing, [], `missing consumer-scoped flag help: ${missing.join(", ")}`);
  assert.ok(!byToken.has("--autofill-startup"), "the unused autofill parser flag must not be reintroduced as vocabulary.");
});
