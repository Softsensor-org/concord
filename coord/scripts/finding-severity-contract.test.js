// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// COORD-717: finding-severity CONTRACT.
//
// The defect: the severity vocabulary was declared independently in the board
// validator, the board schema, four help lines and the role command docs, while
// the CLI parser checked nothing. An out-of-vocabulary `--severity` was only
// refused AFTER the board had been written, by the schema layer, with
// "tasks.json.review_findings.<T>[n].severity must be one of: HIGH, MED, LOW." —
// a message that names the permitted set but never the value it received, so a
// caller could not tell what had actually been rejected.
//
// These tests pin the whole class:
//   * one canonical vocabulary (../engine/scripts/governance-constants.js),
//   * both flag parsers refuse an out-of-vocabulary value up front, naming the
//     received value, and accept every advertised value,
//   * the board validator, the schema copies, the help text and the role command
//     docs all agree with that vocabulary — and the JOIN tests below break each
//     production consumer's link to it and require the consumer to follow.
const constants = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-constants.js"));
const {
  __testing,
  executeCommand,
  setupCoord003Workspace,
} = require("./governance-test-utils.js");
const boardModule = require("../board/board.js");

// Hermetic identity env: strip ambient ids (mirrors ticket-transitions.test.js).
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const OWNER = "claudea0000";
const COORD_DIR = path.join(__dirname, "..");
const ROOT_DIR = path.join(COORD_DIR, "..");
const CONSTANTS_PATH = require.resolve("../engine/scripts/governance-constants.js");
const REJECTED = ["high", "High", "HIGH ", "CRITICAL", "BLOCKING", "MEDIUM", "CRIT"];
const SEVERITY_VERBS = ["add-finding", "return-doing", "repair", "correct-finding-severity"];

function vocabulary() {
  return constants.ORDERED_FINDING_SEVERITIES;
}

function usageToken(values = vocabulary()) {
  return `--severity <${values.join("|")}>`;
}

function parseError(parse, value) {
  try {
    parse(["--severity", value]);
  } catch (error) {
    return String(error.message || "");
  }
  return null;
}

function lifecycleFlagParser(flagsModule = require("../engine/scripts/lifecycle-flags.js")) {
  return flagsModule({
    isLegalStatus: () => true,
    LEGAL_FINDING_STATUSES: new Set(),
  }).parseLifecycleFlags;
}

// Load `modulePath` fresh against a governance-constants whose severity
// vocabulary has been replaced, then restore the module cache. A consumer that
// hardcodes the vocabulary instead of joining to the constant ignores the swap.
function withSeverityVocabulary(values, modulePath, body) {
  const resolved = require.resolve(modulePath);
  const savedConstants = require.cache[CONSTANTS_PATH];
  const flagTables = require.resolve("../engine/scripts/flag-tables.js");
  const savedFlagTables = require.cache[flagTables];
  const savedModule = require.cache[resolved];
  const frozen = Object.freeze([...values]);
  require.cache[CONSTANTS_PATH] = {
    ...savedConstants,
    exports: {
      ...constants,
      ORDERED_FINDING_SEVERITIES: frozen,
      findingSeveritySet: () => new Set(frozen),
      FINDING_SEVERITY_USAGE: `<${frozen.join("|")}>`,
      buildInvalidFindingSeverityMessage: (value) =>
        `--severity must be one of: ${frozen.join(" | ")} (got ${JSON.stringify(String(value))}).`,
    },
  };
  delete require.cache[resolved];
  delete require.cache[flagTables];
  try {
    return body(require(resolved));
  } finally {
    require.cache[CONSTANTS_PATH] = savedConstants;
    if (savedFlagTables) require.cache[flagTables] = savedFlagTables;
    else delete require.cache[flagTables];
    if (savedModule) {
      require.cache[resolved] = savedModule;
    } else {
      delete require.cache[resolved];
    }
  }
}

function findingErrors(board, severity) {
  const errors = [];
  const boardTesting = board.__testing;
  boardTesting.validateFindings(
    { "IMP-700": [{ id: "IMP-700-F1", severity, summary: "s", status: "open", round: 1, qref: "L1" }] },
    new Map([["IMP-700", {}]]),
    errors
  );
  return errors;
}

function fullHelp(helpText = __testing.buildHelpText) {
  return `${helpText()}\n${helpText({ all: true })}`;
}

function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out[path.relative(root, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

test("COORD-717: one canonical finding-severity vocabulary is exported", () => {
  assert.deepEqual([...vocabulary()], ["HIGH", "MED", "LOW"]);
  assert.ok(Object.isFrozen(vocabulary()), "the canonical vocabulary must not be mutable at runtime");
  assert.deepEqual([...constants.findingSeveritySet()], [...vocabulary()]);
  assert.equal(constants.FINDING_SEVERITY_USAGE, "<HIGH|MED|LOW>");
});

test("COORD-717: both flag parsers accept every advertised severity and refuse everything else, naming the received value", () => {
  const parsers = {
    "../engine/scripts/cli.js parseFlags": __testing.parseFlags,
    "engine/scripts/lifecycle-flags.js parseLifecycleFlags": lifecycleFlagParser(),
  };
  for (const [label, parse] of Object.entries(parsers)) {
    for (const value of vocabulary()) {
      assert.deepEqual(parse(["--severity", value]), { severity: value }, `${label} must accept ${value}`);
    }
    for (const value of REJECTED) {
      const message = parseError(parse, value);
      assert.ok(message, `${label} must refuse --severity ${JSON.stringify(value)} at parse time`);
      assert.ok(
        message.includes(`must be one of: ${vocabulary().join(" | ")}`),
        `${label} refusal must advertise exactly the canonical vocabulary; got: ${message}`
      );
      assert.ok(
        message.includes(JSON.stringify(value)),
        `${label} refusal must name the value it received; got: ${message}`
      );
      assert.equal(vocabulary().includes(value), false, "a rejected value must be absent from the advertised set");
    }
  }
});

test("COORD-717: an out-of-vocabulary add-finding fails closed before anything is written; every advertised value is recorded", () => {
  const ticketId = "MSRV-717";
  const ctx = setupCoord003Workspace("coord717-severity-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  const add = (severity) =>
    executeCommand(["add-finding", ticketId, "--severity", severity, "--summary", `finding ${severity}`, "--qref", "L1"]);
  try {
    for (const value of vocabulary()) {
      const result = add(value);
      assert.equal(result.ok, true, `--severity ${value} is advertised and must succeed; got: ${result.error}`);
    }
    const recorded = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).review_findings[ticketId];
    assert.deepEqual(recorded.map((finding) => finding.severity), [...vocabulary()]);

    for (const value of REJECTED) {
      const before = snapshotTree(ctx.coordRoot);
      const result = add(value);
      assert.equal(result.ok, false, `--severity ${JSON.stringify(value)} must fail closed`);
      assert.match(result.error, /--severity must be one of: HIGH \| MED \| LOW/);
      assert.ok(result.error.includes(JSON.stringify(value)), `refusal must name the received value; got: ${result.error}`);
      assert.deepEqual(
        snapshotTree(ctx.coordRoot),
        before,
        `a refused --severity ${JSON.stringify(value)} must not change the board, PLAN.md, journal or lock state`
      );
    }
  } finally {
    ctx.restore();
  }
});

test("COORD-717: the board validator refuses an out-of-vocabulary stored severity and names both the value and the vocabulary", () => {
  for (const value of vocabulary()) {
    assert.deepEqual(findingErrors(boardModule, value), [], `stored severity ${value} must validate`);
  }
  for (const value of REJECTED) {
    const errors = findingErrors(boardModule, value);
    assert.equal(errors.length, 1, `stored severity ${JSON.stringify(value)} must be refused once; got: ${errors.join(" / ")}`);
    assert.ok(errors[0].includes(JSON.stringify(value)), `validator must name the stored value; got: ${errors[0]}`);
    assert.ok(errors[0].includes(vocabulary().join(" | ")), `validator must name the vocabulary; got: ${errors[0]}`);
  }
});

test("COORD-717: both board schema copies declare exactly the canonical vocabulary", () => {
  for (const relative of ["board/tasks.schema.json", "engine/board/tasks.schema.json"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(COORD_DIR, relative), "utf8"));
    const finding = schema.properties.review_findings.additionalProperties.items.properties;
    assert.deepEqual(finding.severity.enum, [...vocabulary()], `${relative} severity enum drifted from governance-constants.js`);
    // COORD-820: the original value and the correction history use the same vocabulary.
    assert.deepEqual(finding.original_severity.enum, [...vocabulary()], `${relative} original_severity enum drifted from governance-constants.js`);
    for (const field of ["from", "to"]) {
      assert.deepEqual(
        finding.severity_history.items.properties[field].enum,
        [...vocabulary()],
        `${relative} severity_history.${field} enum drifted from governance-constants.js`
      );
    }
  }
});

test("COORD-717: help advertises the canonical vocabulary on every verb that takes --severity", () => {
  const help = fullHelp();
  for (const verb of SEVERITY_VERBS) {
    const lines = help.split("\n").filter((line) => new RegExp(`\\b${verb} <ticket-id>`).test(line));
    assert.ok(lines.length > 0, `help no longer documents ${verb}`);
    for (const line of lines) {
      assert.ok(line.includes(usageToken()), `help for ${verb} must advertise ${usageToken()}; got: ${line.trim()}`);
    }
  }
  const advertised = help.match(/--severity <[^>]*>/g) || [];
  assert.ok(advertised.length >= SEVERITY_VERBS.length);
  assert.deepEqual([...new Set(advertised)], [usageToken()], "help advertises a severity set the parser does not accept");
});

test("COORD-717: the role command docs advertise only the canonical vocabulary", () => {
  const commandsDir = path.join(ROOT_DIR, ".claude", "commands");
  let checked = 0;
  for (const name of fs.readdirSync(commandsDir).filter((entry) => entry.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(commandsDir, name), "utf8");
    for (const token of text.match(/--severity <[^>]*>/g) || []) {
      assert.equal(token, usageToken(), `.claude/commands/${name} advertises ${token}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `expected the role docs to document --severity; found ${checked} usages`);
});

// JOIN tests: swap the canonical vocabulary and require each production consumer
// to follow it. A consumer that re-declares the list locally fails here.
test("COORD-717 (join): lifecycle-flags.js parser follows the canonical vocabulary", () => {
  withSeverityVocabulary(["HIGH", "MED", "LOW", "ZZZ"], "../engine/scripts/lifecycle-flags.js", (flagsModule) => {
    const parse = lifecycleFlagParser(flagsModule);
    assert.deepEqual(parse(["--severity", "ZZZ"]), { severity: "ZZZ" });
    assert.match(parseError(parse, "nope"), /must be one of: HIGH \| MED \| LOW \| ZZZ/);
  });
  withSeverityVocabulary(["LOW"], "../engine/scripts/lifecycle-flags.js", (flagsModule) => {
    assert.match(parseError(lifecycleFlagParser(flagsModule), "HIGH"), /must be one of: LOW \(got "HIGH"\)/);
  });
});

test("COORD-717 (join): lifecycle-help.js help text follows the canonical vocabulary", () => {
  withSeverityVocabulary(["HIGH", "MED", "LOW", "ZZZ"], "../engine/scripts/lifecycle-help.js", (helpModule) => {
    const help = fullHelp(helpModule({}).buildHelpText);
    const advertised = [...new Set(help.match(/--severity <[^>]*>/g) || [])];
    assert.deepEqual(advertised, [usageToken(["HIGH", "MED", "LOW", "ZZZ"])]);
  });
});

test("COORD-717 (join): board.js validator follows the canonical vocabulary", () => {
  withSeverityVocabulary(["HIGH", "MED", "LOW", "ZZZ"], "../board/board.js", (board) => {
    assert.deepEqual(findingErrors(board, "ZZZ"), []);
  });
  withSeverityVocabulary(["LOW"], "../board/board.js", (board) => {
    assert.equal(findingErrors(board, "HIGH").length, 1);
  });
});

test("COORD-717 (join): no production consumer re-declares the severity list", () => {
  const consumers = [
    "engine/scripts/cli.js",
    "engine/scripts/flag-tables.js",
    "engine/scripts/lifecycle-flags.js",
    "engine/scripts/lifecycle-help.js",
    "engine/scripts/lifecycle-ticket-admin.js",
    "engine/scripts/ticket-transitions.js",
    "engine/scripts/correct-finding-severity.js",
    "board/board.js",
  ];
  for (const relative of consumers) {
    const source = fs.readFileSync(path.join(COORD_DIR, relative), "utf8");
    assert.doesNotMatch(
      source,
      /HIGH\s*["']?\s*[|,]\s*["']?\s*MED\s*["']?\s*[|,]\s*["']?\s*LOW/,
      `${relative} hardcodes the severity vocabulary instead of joining to governance-constants.js`
    );
  }
  for (const file of ["engine/scripts/cli.js", "engine/scripts/lifecycle-flags.js"]) {
    const source = fs.readFileSync(path.join(COORD_DIR, file), "utf8");
    assert.match(source, /"--severity": commonFlagHandlers\.severity/, file);
  }
  const handlers = fs.readFileSync(path.join(COORD_DIR, "engine/scripts/flag-tables.js"), "utf8");
  assert.match(handlers, /if \(!FINDING_SEVERITIES\.has\(next\)\) fail\(buildInvalidFindingSeverityMessage\(next\)\)/);
});
