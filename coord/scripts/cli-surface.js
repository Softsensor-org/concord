"use strict";

// COORD-572: THE MACHINE-FACING SURFACE OF THE CLI, DERIVED FROM THE CLI.
//
// The defect this module exists for is not "some flags are undocumented". It is
// that EVERY machine-facing surface — flag names, canonical verb names and the
// aliases a caller is likely to guess, JSON field names, accepted enum literals,
// and the remediation text the gates print — was hand-maintained, drifted from
// the code implementing it, and taught agents to read ABSENCE FROM DOCUMENTATION
// as ABSENCE FROM PRODUCT. Five confirmed instances each cost a wrongly-filed
// ticket or a wrong closure decision:
//   1. --context-pack-ack        (fixed by COORD-612)
//   2. --closeout-blocker        filed as an unrecoverable WIP deadlock
//   3. --transfer-to             the "explicit human-admin transfer path" that
//                                agent-commands.js resolved but never named
//   4. add-prompt                already shipped as `register-prompt --create`
//   5. business-context status   a closed enum advertised as `<owner/status>`
//
// COORD-612 made the update-plan FLAG surface generated. This module generalizes
// the mechanism to the rest of the machine-facing surface, and every accessor
// here is a DERIVATION with a fidelity assertion — never a hand-written list:
//   * verbs        come from the live dispatch switch (verb-parity.js)
//   * flags        come from cli.js's dispatch tables, and every flag's option
//                  key is OBSERVED by feeding it through the live parseFlags
//   * enums        come from the parser itself: a value the parser rejects must
//                  name its accepted literals, and each named literal is
//                  re-fed through the parser to prove the advice is true
//   * JSON fields  come from plan-records.js's exported field table joined to
//                  board/plan.schema.json, so the snake_case record spelling and
//                  the camelCase option spelling are always published together
//
// cli.js is required LAZILY everywhere below: cli.js may consume this module for
// its unknown-verb/unknown-flag suggestions, and a top-level require would close
// that cycle.

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = __dirname;

// The shipped CLI entrypoints a remediation string may name. `gov` and
// `governance.js` are the same binary; `coord` is the product CLI.
const ENTRYPOINTS = Object.freeze([
  Object.freeze({ token: "node coord/scripts/governance.js", cli: "gov" }),
  Object.freeze({ token: "coord/scripts/governance.js", cli: "gov" }),
  Object.freeze({ token: "coord/scripts/gov", cli: "gov" }),
  Object.freeze({ token: "coord/scripts/coord", cli: "coord" }),
  Object.freeze({ token: "coord/scripts/agent", cli: "agent" }),
]);

const FLAG_TABLE_NAMES = Object.freeze([
  "VALUE_FLAGS",
  "APPEND_FLAGS",
  "BOOL_FLAGS",
  "SPECIAL_FLAGS",
]);

// A parser refusal publishes its accepted literals in one of two equivalent
// renderings. Both are contract, and the guard re-verifies every literal it
// extracts, so a message that lists the WRONG values fails just as loudly as a
// message that lists none.
const ACCEPTED_LITERALS_PATTERN = /(?:Accepted|must be one of):\s*([a-z0-9][a-z0-9 |_-]*)/i;

// Calls that appear in many switch arms because they shape arguments or wrap the
// terminal-lifecycle boundary, not because they are the arm's handler.
const ARG_PLUMBING_CALLS = new Set([
  "parseFlags",
  "optionalLeadingId",
  "flagsAfterOptionalId",
  "hasLeadingPositional",
  "runTerminalLifecycle",
  "require",
  "String",
  "Number",
  "Boolean",
  // JS keywords that read as calls to a token scanner.
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
]);

let cliModule = null;
function cli() {
  if (!cliModule) {
    cliModule = require("./cli.js");
  }
  return cliModule;
}

function readScript(name) {
  return fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
}

function assertFidelity(condition, message) {
  if (!condition) {
    throw new Error(`cli-surface derivation is no longer faithful: ${message}`);
  }
}

// --- verbs -----------------------------------------------------------------

// Every verb the router actually dispatches, canonical names and aliases alike,
// read from the live switch by the same collector the COORD-007 verb-parity
// drift detector uses.
function verbs() {
  const collected = require("./verb-parity.js").collectDispatchCommandVerbs(readScript("cli.js"));
  const list = [...collected].sort();
  assertFidelity(
    list.length >= 100,
    `only ${list.length} verbs parsed out of the dispatchCommand switch`
  );
  for (const anchor of ["start", "update-plan", "register-prompt", "land"]) {
    assertFidelity(list.includes(anchor), `verb parse lost the known verb "${anchor}"`);
  }
  return list;
}

// Alias groups: verbs whose switch arm delegates to the SAME handler. Derived by
// reading each `case "<verb>":` arm out of the live switch and normalizing its
// body, so `register-prompt` and `new`/`file-ticket` style pairs are published
// as one capability instead of looking like unrelated commands.
function verbAliasGroups() {
  const source = readScript("cli.js");
  const start = source.indexOf("function dispatchCommand(");
  assertFidelity(start >= 0, "cli.js no longer defines dispatchCommand");
  const body = source.slice(start);
  const arms = [...body.matchAll(/case\s+"([a-z][a-z0-9-]*)":([\s\S]*?)(?=\n {4}case\s+"|\n {4}case\s+undefined|\n {4}default:)/g)];
  assertFidelity(arms.length >= 100, `only ${arms.length} switch arms parsed`);
  const groups = new Map();
  let pending = [];
  for (const [, verb, armBody] of arms) {
    pending.push(verb);
    const trimmed = armBody.trim();
    if (trimmed === "") {
      // Fallthrough alias: it shares the next arm's body.
      continue;
    }
    // The handler identity is the first NON-plumbing function the arm calls.
    // Argument-shaping helpers and the terminal-lifecycle wrapper are shared by
    // many arms, so counting them as the handler would fuse unrelated verbs into
    // one bogus alias group.
    const code = trimmed.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const calls = [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((match) => match[1])
      .filter((name) => !ARG_PLUMBING_CALLS.has(name));
    const key = calls.length > 0 ? calls[0] : trimmed;
    const existing = groups.get(key) || [];
    groups.set(key, [...existing, ...pending]);
    pending = [];
  }
  return [...groups.entries()]
    .map(([handler, names]) => ({ handler, verbs: names.sort() }))
    .sort((a, b) => a.verbs[0].localeCompare(b.verbs[0]));
}

// --- flags -----------------------------------------------------------------

function flagTokens() {
  const source = readScript("cli.js");
  const tokens = new Set();
  for (const name of FLAG_TABLE_NAMES) {
    const start = source.indexOf(`const ${name} = Object.freeze({`);
    assertFidelity(start >= 0, `cli.js no longer defines a ${name} dispatch table`);
    const end = source.indexOf("\n});", start);
    assertFidelity(end > start, `cli.js ${name} table has no recognizable end`);
    for (const match of source.slice(start, end).matchAll(/"(-{1,2}[a-z0-9-]+)"\s*:/g)) {
      tokens.add(match[1]);
    }
  }
  const list = [...tokens].sort();
  assertFidelity(list.length >= 150, `only ${list.length} flag tokens parsed out of cli.js`);
  for (const anchor of ["--context-pack-ack", "--transfer-to", "--closeout-blocker", "--summary"]) {
    assertFidelity(list.includes(anchor), `flag parse lost the known flag ${anchor}`);
  }
  return list;
}

// Probe values cover the flags that validate their argument and the ones coerced
// to an integer, so no flag is misclassified by guesswork.
const PROBE_VALUES = Object.freeze(["1", "pass", "todo"]);

// Ask the LIVE parser what option key(s) a flag produces. Never assumed.
function flagOptionKeys(flag) {
  const { parseFlags } = cli().__testing;
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

function flagIndex() {
  const index = new Map();
  for (const flag of flagTokens()) {
    index.set(flag, flagOptionKeys(flag));
  }
  return index;
}

// --- enum literals ---------------------------------------------------------

// A flag is ENUM-CONSTRAINED when the live parser rejects an arbitrary value for
// it. For each such flag the parser's own refusal is the documentation, so this
// derivation is also the check: it extracts the literals the message advertises
// and re-feeds each one through the parser. An enum-constrained flag whose
// message names no literals yields `accepted: []`, which the guard treats as a
// failure — that is criterion (d), enforced rather than described.
function enumConstrainedFlags() {
  const { parseFlags } = cli().__testing;
  const probe = "coord-572-not-a-real-enum-value";
  const results = [];
  for (const flag of flagTokens()) {
    try {
      parseFlags([flag]);
      continue; // a boolean flag takes no value and constrains nothing
    } catch {
      // takes a value — keep probing
    }
    let message = null;
    try {
      parseFlags([flag, probe]);
      continue; // accepted an arbitrary value -> not enum-constrained
    } catch (error) {
      message = String(error.message || "");
    }
    if (/requires a value/i.test(message)) {
      continue;
    }
    const match = message.match(ACCEPTED_LITERALS_PATTERN);
    const advertised = match
      ? match[1].split("|").map((value) => value.trim()).filter(Boolean)
      : [];
    const accepted = advertised.filter((value) => {
      try {
        parseFlags([flag, value]);
        return true;
      } catch {
        return false;
      }
    });
    results.push({ flag, message, advertised, accepted });
  }
  return results;
}

// --- JSON field names ------------------------------------------------------

// (c): the snake_case record spelling and the camelCase option spelling of every
// JSON-object plan field, joined to the flag that writes it. `context_pack_ack`
// vs `contextPackAck` is the split that hid the ack writer; publishing both
// spellings against one flag is what makes either spelling find the mechanism.
function planObjectFields() {
  const planRecords = require("./plan-records.js");
  const table = planRecords.JSON_OBJECT_PLAN_FIELDS;
  assertFidelity(
    Array.isArray(table) && table.length >= 5,
    "plan-records.js no longer exports JSON_OBJECT_PLAN_FIELDS"
  );
  const schema = JSON.parse(
    fs.readFileSync(path.join(SCRIPTS_DIR, "..", "board", "plan.schema.json"), "utf8")
  );
  return table.map(([optionKey, field]) => ({
    record_field: field,
    option_key: optionKey,
    flag: planRecords.optionKeyToFlag(optionKey),
    declared_in_schema: Boolean(schema.properties && schema.properties[field]),
  }));
}

// --- suggestions -----------------------------------------------------------

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

// (b): a capability must be findable by the name a caller is LIKELY TO GUESS.
// `add-prompt` is not within edit distance of `register-prompt`, but it shares
// the word "prompt" — so shared word-parts rank first and edit distance only
// breaks ties. That ordering is what turns instance 4 from a filed ticket into
// a one-line answer at the prompt.
function rank(guess, candidates) {
  const needle = String(guess || "").replace(/^-+/, "").toLowerCase();
  if (!needle) {
    return [];
  }
  const needleParts = needle.split(/[-_]/).filter(Boolean);
  return candidates
    .map((candidate) => {
      const bare = candidate.replace(/^-+/, "").toLowerCase();
      const parts = bare.split(/[-_]/).filter(Boolean);
      const shared = needleParts.filter((part) => parts.includes(part)).length;
      const substring = bare.includes(needle) || needle.includes(bare) ? 1 : 0;
      const distance = levenshtein(needle, bare);
      return { candidate, shared, substring, distance };
    })
    .filter((entry) => entry.shared > 0 || entry.substring > 0 || entry.distance <= 3)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.substring - a.substring ||
        a.distance - b.distance ||
        a.candidate.localeCompare(b.candidate)
    )
    .map((entry) => entry.candidate);
}

function suggestVerbs(guess, limit = 4) {
  const all = verbs();
  const groups = verbAliasGroups();
  const ranked = rank(guess, all).slice(0, limit);
  return ranked.map((verb) => {
    const group = groups.find((entry) => entry.verbs.includes(verb));
    const aliases = group ? group.verbs.filter((name) => name !== verb) : [];
    return aliases.length > 0 ? `${verb} (alias: ${aliases.join(", ")})` : verb;
  });
}

function suggestFlags(guess, limit = 4) {
  return rank(guess, flagTokens()).slice(0, limit);
}

// --- remediation classification -------------------------------------------

// THE EXPLICIT, TESTABLE CLASSIFICATION every remediation string falls under.
// It has to be explicit: a checker that guesses produces false failures on prose
// (COORD-488 drafted 164 findings, 81 of them legitimate vocabulary, and had to
// be narrowed to survive), and a checker that shrugs at anything unrecognized
// silently drifts to "everything is a placeholder" and stops catching anything.
//
//   ACTION      — the string names a shipped CLI entrypoint. Everything from the
//                 entrypoint token to the end of its quoted span or the string is
//                 the command, and it is held to the full bar: real verb, real
//                 flags, accepted enum values, canonical JSON field casing.
//   EXPLANATION — the string names no entrypoint. It is prose describing a
//                 situation or a state to reach, and is held only to the rule
//                 that it must not steer a caller into editing governed state.
//
// A new gate message is therefore never unclassified: naming a command makes it
// an ACTION and subjects it to the parser; not naming one makes it an
// EXPLANATION and subjects it to the hand-edit rule.
function classifyRemediation(text) {
  const value = String(text == null ? "" : text);
  let best = null;
  for (const entry of ENTRYPOINTS) {
    const at = value.indexOf(entry.token);
    if (at < 0) {
      continue;
    }
    if (!best || at < best.at || (at === best.at && entry.token.length > best.entry.token.length)) {
      best = { at, entry };
    }
  }
  if (!best) {
    return { kind: "explanation", text: value, cli: null, command: null };
  }
  let rest = value.slice(best.at);
  // The command may be embedded in a sentence inside quotes ("Run
  // `coord/scripts/gov update-plan --help` for the shape"). Stop at the closing
  // quote when the entrypoint was opened by one.
  const opener = value.slice(0, best.at).match(/(["'`])\s*$/);
  if (opener) {
    const close = rest.indexOf(opener[1]);
    if (close > 0) {
      rest = rest.slice(0, close);
    }
  }
  // A trailing sentence period that is not part of a path/flag token.
  rest = rest.replace(/\.\s*$/, "").trim();
  return { kind: "action", text: value, cli: best.entry.cli, command: rest };
}

// Shell-ish tokenizer: enough to split a documented command the way a copying
// operator's shell would, including the single-quoted JSON payloads the plan
// flags take.
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of String(command || "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        tokens.push(current);
      }
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current) {
    tokens.push(current);
  }
  return tokens;
}

// Feed a documented `gov` command through the REAL parser — the same parseFlags
// the CLI runs, never a regex approximation of it. Returns the resolved verb and
// either the parsed options or the parser's own refusal.
function parseGovRemediation(command) {
  const tokens = tokenizeCommand(command);
  const entry = ENTRYPOINTS.find((candidate) => command.startsWith(candidate.token));
  const skip = entry ? tokenizeCommand(entry.token).length : 1;
  const rest = tokens.slice(skip);
  const verb = rest[0] || null;
  // Positional arguments (ticket ids, subcommands, paths) precede the flags.
  const firstFlag = rest.findIndex((token) => token.startsWith("-"));
  const argv = firstFlag < 0 ? [] : rest.slice(firstFlag);
  // A trailing comment (`# if you create ...`) is operator prose, not argv.
  const commentAt = argv.findIndex((token) => token.startsWith("#"));
  // `--help` / `-h` never reach parseFlags: dispatchCommand intercepts them
  // ahead of the router (cli.js), so they are accepted on every verb and must
  // not be judged against the flag tables.
  const flagArgv = (commentAt < 0 ? argv : argv.slice(0, commentAt)).filter(
    (token) => token !== "--help" && token !== "-h"
  );
  const { parseFlags } = cli().__testing;
  try {
    return { verb, argv: flagArgv, ok: true, options: parseFlags(flagArgv) };
  } catch (error) {
    return { verb, argv: flagArgv, ok: false, error: String(error.message || error) };
  }
}

// --- the published surface -------------------------------------------------

function buildSurfaceReport() {
  const index = flagIndex();
  return {
    generated_by: "coord/scripts/cli-surface.js",
    verbs: verbs(),
    verb_aliases: verbAliasGroups().filter((group) => group.verbs.length > 1),
    flags: [...index.entries()].map(([flag, optionKeys]) => ({ flag, option_keys: optionKeys })),
    enums: enumConstrainedFlags().map(({ flag, accepted }) => ({ flag, accepted })),
    json_fields: planObjectFields(),
  };
}

function printSurface(options = {}) {
  const report = buildSurfaceReport();
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(`Governance CLI surface — generated from the live parser and dispatch table.`);
  console.log("");
  console.log(`Verbs (${report.verbs.length}):`);
  console.log(`  ${report.verbs.join(" ")}`);
  console.log("");
  console.log("Aliases (one capability, several spellings):");
  for (const group of report.verb_aliases) {
    console.log(`  ${group.verbs.join(" = ")}`);
  }
  console.log("");
  console.log(`Flags (${report.flags.length}):`);
  for (const entry of report.flags) {
    console.log(`  ${entry.flag}${entry.option_keys.length ? ` -> ${entry.option_keys.join(", ")}` : ""}`);
  }
  console.log("");
  console.log("Accepted enum literals (printed by the parser at the point of use):");
  for (const entry of report.enums) {
    console.log(`  ${entry.flag}: ${entry.accepted.join(" | ") || "(none published)"}`);
  }
  console.log("");
  console.log("JSON plan fields (record spelling / option spelling / writer flag):");
  for (const entry of report.json_fields) {
    console.log(`  ${entry.record_field} / ${entry.option_key} / ${entry.flag}`);
  }
  return report;
}

module.exports = {
  ENTRYPOINTS,
  buildSurfaceReport,
  classifyRemediation,
  enumConstrainedFlags,
  flagIndex,
  flagOptionKeys,
  flagTokens,
  parseGovRemediation,
  planObjectFields,
  printSurface,
  suggestFlags,
  suggestVerbs,
  tokenizeCommand,
  verbAliasGroups,
  verbs,
};
