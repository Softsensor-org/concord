"use strict";

// COORD-572 criterion (e): EVERY EMITTED REMEDIATION MUST BE EXECUTABLE AND
// PARSER-VALID.
//
// This is the criterion that catches the class the other four cannot. A flag can
// be published, a verb can be documented, an enum can be printed — and the gate
// that blocks you can still steer you AWAY from the mechanism. Both halves of
// that happened in one session:
//   * the context-pack-ack gate said "record context_pack_ack in the canonical
//     plan record" and NAMED NO COMMAND, so three agents (COORD-607/609/611)
//     hand-edited coord/.runtime/plans/<ticket>.json — the exact action
//     GOVERNANCE.md forbids;
//   * agent-commands.js told the operator to "use an explicit human-admin
//     transfer path" WITHOUT NAMING IT while resolving --transfer-to twenty
//     lines above.
// Neither is a typo. Both are a gate whose advice does not resolve to the
// mechanism it is talking about, and the cost of each was a wrongly-filed ticket.
//
// WHY THIS TEST IS NOT VACUOUS. It does not assert "the string is non-empty" or
// pattern-match source text. It resolves the remediation strings the gates
// really emit, extracts the command each one presents, and feeds that command
// through THE LIVE PARSER — the same parseFlags cli.js runs — then holds the
// result to the accepted verb list, the accepted flag list, and the accepted
// enum literals. The self-tests at the bottom prove each check fires RED on a
// deliberately broken remediation.
//
// WHY IT IS NOT NOISY EITHER. Not every string a gate prints is a command; some
// are prose describing a state to reach. A checker that demands all of them
// parse produces false failures and gets switched off (COORD-488's first draft
// raised 164 findings, 81 of them legitimate vocabulary, and had to be narrowed
// to survive). So classification is EXPLICIT, published in cli-surface.js, and
// itself asserted below: a string that names a shipped CLI entrypoint is an
// ACTION and is held to the full bar; a string that names none is an
// EXPLANATION and is held to the hand-edit rule. The bucket counts are pinned so
// the classifier cannot quietly drift toward "everything is a placeholder" and
// stop checking anything.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = __dirname;
const surface = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli-surface.js"));
// COORD-989: the parser-dependent exports need the live cli.js parser bound first.
surface.bindParser(() => require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli.js")).__testing.parseFlags);

// --- harvest ---------------------------------------------------------------

function listEngineSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|artifacts)$/.test(entry.name)) {
        listEngineSources(full, out);
      }
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

// Extract the source text of every `next_steps: [ ... ]` array literal. The
// remediation channel is structured, so the harvest can be structural too.
function extractNextStepArrays(source) {
  const arrays = [];
  const opener = /next_steps:\s*\[/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let index = match.index + match[0].length;
    const start = index;
    let depth = 1;
    let quote = null;
    let escaped = false;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (escaped) {
        escaped = false;
      } else if (quote) {
        if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
      }
      index += 1;
    }
    arrays.push(stripComments(source.slice(start, index - 1)));
  }
  return arrays;
}

// Comments sit between remediation elements and routinely contain quotes and
// commas (the business-context gate's own comment quotes "claudea11/complete"),
// so they must be removed BEFORE the element splitter runs or a stray quote
// swallows the elements that follow. Quote-aware, so a `//` inside a string is
// left alone.
function stripComments(source) {
  let out = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (quote) {
      out += char;
      if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

// Split an array literal into top-level elements. Commas inside strings,
// template substitutions, calls, or nested literals do not separate elements, so
// the scanner keeps a context stack: `${` inside a template pushes a CODE
// context (which may itself contain strings and commas) and its matching `}`
// pops back to the template.
function splitTopLevelElements(arrayBody) {
  const elements = [];
  const stack = [{ type: "code", depth: 0 }];
  let current = "";
  let escaped = false;
  for (let index = 0; index < arrayBody.length; index += 1) {
    const char = arrayBody[index];
    const top = stack[stack.length - 1];
    current += char;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (top.type === "string") {
      if (char === top.quote) stack.pop();
      continue;
    }
    if (top.type === "template") {
      if (char === "`") {
        stack.pop();
      } else if (char === "$" && arrayBody[index + 1] === "{") {
        stack.push({ type: "code", depth: 0, substitution: true });
        current += "{";
        index += 1;
      }
      continue;
    }
    // code context
    if (char === '"' || char === "'") {
      stack.push({ type: "string", quote: char });
      continue;
    }
    if (char === "`") {
      stack.push({ type: "template" });
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      top.depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (top.depth === 0 && top.substitution) {
        stack.pop();
      } else {
        top.depth -= 1;
      }
      continue;
    }
    if (char === "," && stack.length === 1 && top.depth === 0) {
      elements.push(current.slice(0, -1));
      current = "";
    }
  }
  elements.push(current);
  return elements.map((value) => value.trim()).filter(Boolean);
}

// A ticket id substituted into advice must look like a real ticket id, because
// the surrounding command is about to be parsed for real.
const TICKET_PLACEHOLDER = "COORD-000";
const GENERIC_PLACEHOLDER = "<value>";

// Resolve a string/template literal to the text the gate would emit, replacing
// each `${expr}` with a stable stand-in. Interpolations are the only dynamic
// part of these literals; the surrounding command text is fixed, and the command
// text is what the parser has to accept.
function renderLiteral(literal) {
  const quote = literal[0];
  let body = literal.slice(1, -1);
  if (quote === "`") {
    body = body.replace(/\$\{/g, (matchText, offset, whole) => matchText && " {");
    let out = "";
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === " " && body[index + 1] === "{") {
        let depth = 1;
        let end = index + 2;
        while (end < body.length && depth > 0) {
          if (body[end] === "{") depth += 1;
          if (body[end] === "}") depth -= 1;
          end += 1;
        }
        const expression = body.slice(index + 2, end - 1);
        out += /ticket/i.test(expression) ? TICKET_PLACEHOLDER : GENERIC_PLACEHOLDER;
        index = end - 1;
        continue;
      }
      out += body[index];
    }
    body = out;
  }
  return body.replace(/\\`/g, "`").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, " ");
}

function isLiteral(element) {
  return element.startsWith('"') || element.startsWith("'") || element.startsWith("`");
}

// A remediation element may be an identifier or a call (`reviewCycleCommand`,
// `buildPromptWaiverCommand(ticketId)`), because gates factor shared advice into
// a builder. Those are resolved by locating the symbol's definition anywhere in
// the engine and harvesting the command literals inside it. An element that
// CANNOT be resolved FAILS the test rather than being skipped — that is what
// keeps this guard from quietly going blind as gates are refactored.
function resolveSymbolLiterals(symbol, sources) {
  const definition = new RegExp(
    `(?:function\\s+${symbol}\\s*\\(|const\\s+${symbol}\\s*=)`
  );
  for (const [, source] of sources) {
    const at = source.search(definition);
    if (at < 0) {
      continue;
    }
    // A generous window: enough to cover the builder, bounded so an unrelated
    // later literal cannot be attributed to it.
    const body = source.slice(at, at + 2500);
    const literals = [...body.matchAll(/`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)]
      .map((match) => renderLiteral(match[0]))
      .filter((text) => surface.classifyRemediation(text).kind === "action");
    if (literals.length > 0) {
      return literals;
    }
  }
  return [];
}

function harvestRemediations() {
  // COORD-867: the gate modules moved to coord/engine/scripts; harvest both trees so a moved gate's advice stays checked.
  const ENGINE_SCRIPTS_DIR = path.join(SCRIPTS_DIR, "..", "engine", "scripts");
  const files = [...listEngineSources(SCRIPTS_DIR), ...listEngineSources(ENGINE_SCRIPTS_DIR)];
  const sources = files.map((file) => [path.relative(path.join(SCRIPTS_DIR, ".."), file), fs.readFileSync(file, "utf8")]);
  const issues = [];
  const unresolved = [];
  for (const [relative, source] of sources) {
    for (const arrayBody of extractNextStepArrays(source)) {
      const steps = [];
      for (const element of splitTopLevelElements(arrayBody)) {
        if (isLiteral(element)) {
          steps.push({ file: relative, text: renderLiteral(element), origin: "literal" });
          continue;
        }
        const symbol = (element.match(/^([A-Za-z_$][\w$]*)/) || [])[1];
        if (!symbol) {
          unresolved.push({ file: relative, element });
          continue;
        }
        const resolved = resolveSymbolLiterals(symbol, sources);
        if (resolved.length === 0) {
          unresolved.push({ file: relative, element });
          continue;
        }
        for (const text of resolved) {
          steps.push({ file: relative, text, origin: symbol });
        }
      }
      if (steps.length > 0) {
        issues.push({ file: relative, steps });
      }
    }
  }
  return { issues, unresolved, steps: issues.flatMap((issue) => issue.steps) };
}

const HARVEST = harvestRemediations();
const ACTIONS = HARVEST.steps.filter((step) => surface.classifyRemediation(step.text).kind === "action");
const EXPLANATIONS = HARVEST.steps.filter((step) => surface.classifyRemediation(step.text).kind === "explanation");

// --- the bar an ACTION must clear ------------------------------------------

const VERBS = new Set(surface.verbs());
const FLAG_INDEX = surface.flagIndex();
const ENUMS = new Map(surface.enumConstrainedFlags().map((entry) => [entry.flag, entry.accepted]));
const PLAN_FIELDS = surface.planObjectFields();

// A value written as `<placeholder>` is deliberately not a literal, so an enum
// check must not treat it as a wrong one.
function isPlaceholderValue(value) {
  return /^<.*>$/.test(String(value || "").trim()) || value === GENERIC_PLACEHOLDER;
}

// The single validator. Exported shape: a list of human-readable defects, empty
// when the remediation is executable. The self-tests below drive it directly, so
// every rule it enforces is demonstrated failing.
function validateAction(text) {
  const classified = surface.classifyRemediation(text);
  if (classified.kind !== "action") {
    return [];
  }
  const defects = [];
  const parsed = surface.parseGovRemediation(classified.command);
  if (classified.cli === "gov") {
    if (!parsed.verb || !VERBS.has(parsed.verb)) {
      defects.push(`names verb "${parsed.verb}", which the dispatch table does not handle`);
    }
    if (!parsed.ok) {
      defects.push(`does not parse through the live parseFlags: ${parsed.error}`);
    }
    for (let index = 0; index < parsed.argv.length; index += 1) {
      const token = parsed.argv[index];
      if (!token.startsWith("--") && token !== "-m") {
        continue;
      }
      if (token === "--help" || token === "-h") {
        continue; // intercepted by dispatchCommand, accepted on every verb
      }
      if (!FLAG_INDEX.has(token)) {
        defects.push(`uses flag ${token}, which no dispatch table registers`);
        continue;
      }
      const accepted = ENUMS.get(token);
      const value = parsed.argv[index + 1];
      if (accepted && accepted.length > 0 && value && !isPlaceholderValue(value) && !accepted.includes(value)) {
        defects.push(`passes ${token} ${value}, outside the accepted enum ${accepted.join("|")}`);
      }
    }
  }
  // Canonical JSON field casing: the camelCase option key is an INTERNAL name.
  // Printing it sends a caller looking for `contextPackAck` in a plan record
  // that spells it `context_pack_ack` — the split that hid the ack writer.
  for (const field of PLAN_FIELDS) {
    if (text.includes(field.option_key)) {
      defects.push(
        `prints the internal option spelling "${field.option_key}"; the record spells it "${field.record_field}"`
      );
    }
  }
  return defects;
}

// The hard rule, checked on ACTIONS and EXPLANATIONS alike: advice must never
// steer a caller into editing governed state by hand. This is a defect even when
// the string parses, and it is the failure that produced COORD-612.
const GOVERNED_STATE_PATTERN =
  /\bcoord\/\.runtime\/plans\b|\bcoord\/board\b|\bcoord\/locks\b|\bQUESTIONS\.md\b|\bcanonical plan record\b|\bplan record\b|\bprompt_index\b|\btasks\.json\b/i;
const EDIT_IMPERATIVE_PATTERN =
  /\b(?:update|edit|add|set|record|write|put|append|insert|modify|change|complete|move)\b/i;
const NEGATED_PATTERN = /\b(?:do not|don't|never|no need to|instead of|rather than)\b|\bNOT\b/;

function validateNoHandEdit(text) {
  if (!GOVERNED_STATE_PATTERN.test(text)) {
    return [];
  }
  if (NEGATED_PATTERN.test(text)) {
    return [];
  }
  if (surface.classifyRemediation(text).kind === "action") {
    // It names a command, so the command IS the mechanism.
    return [];
  }
  if (!EDIT_IMPERATIVE_PATTERN.test(text)) {
    return [];
  }
  return [
    "tells the caller to change governed state but names no command; " +
      "a remediation that describes the edit without naming the writer is what produced " +
      "the hand-edited plan records in COORD-607/609/611",
  ];
}

// --- tests -----------------------------------------------------------------

test("COORD-572: the remediation harvest is faithful (this guard cannot silently disarm)", () => {
  assert.deepStrictEqual(
    HARVEST.unresolved,
    [],
    "every next_steps element must resolve to the text a gate would emit. Unresolved elements " +
      "mean a gate factored its advice into a shape this harvest cannot read, and an unreadable " +
      "remediation is an unchecked remediation: " +
      HARVEST.unresolved.map((entry) => `${entry.file}: ${entry.element}`).join(" | ")
  );
  assert.ok(
    HARVEST.issues.length >= 45,
    `only ${HARVEST.issues.length} next_steps arrays harvested; the extraction is no longer faithful.`
  );
  assert.ok(
    ACTIONS.length >= 40,
    `only ${ACTIONS.length} remediations classified as executable actions. The classifier has drifted ` +
      "toward treating everything as prose, which would make this whole guard vacuous."
  );
  // Anchors: the exact remediations whose absence or wrongness cost a ticket.
  const all = HARVEST.steps.map((step) => step.text).join("\n");
  assert.ok(all.includes("--context-pack-ack"), "the ack writer is no longer named in any remediation.");
  assert.ok(
    all.includes("business-context investigation: not-required"),
    "the business-context gate no longer emits a concrete, enum-valid investigation disposition."
  );
  assert.ok(all.includes("--bootstrap-risk"), "the bootstrap_risk writer is no longer named in any remediation.");
});

test("COORD-572: every remediation presented as an action is executable and parser-valid", () => {
  const defects = [];
  for (const step of ACTIONS) {
    for (const defect of validateAction(step.text)) {
      defects.push(`${step.file}: ${defect}\n    ${step.text}`);
    }
  }
  assert.deepStrictEqual(
    defects,
    [],
    `remediation(s) a gate prints as a runnable command do not resolve against the live CLI:\n${defects.join("\n")}`
  );
});

test("COORD-572: no remediation steers a caller into hand-editing governed state", () => {
  const defects = [];
  for (const step of HARVEST.steps) {
    for (const defect of validateNoHandEdit(step.text)) {
      defects.push(`${step.file}: ${defect}\n    ${step.text}`);
    }
  }
  assert.deepStrictEqual(defects, [], `forbidden hand-edit advice:\n${defects.join("\n")}`);
});

test("COORD-572: the action-vs-explanation classification is explicit and cannot drift", () => {
  // Rule 1: naming an entrypoint is what makes a string an action. Nothing that
  // names one may be filed as prose and thereby escape the parser.
  for (const step of HARVEST.steps) {
    const namesEntrypoint = surface.ENTRYPOINTS.some((entry) => step.text.includes(entry.token));
    const classified = surface.classifyRemediation(step.text);
    assert.strictEqual(
      classified.kind === "action",
      namesEntrypoint,
      `${step.file}: classification disagrees with the published rule for: ${step.text}`
    );
  }
  // Rule 2: an explanation may not mention a flag. Advice that talks about a
  // flag while showing no command is exactly the unnamed-mechanism defect.
  const flagInProse = EXPLANATIONS.filter((step) => /(?:^|\s)--[a-z]/.test(step.text));
  assert.deepStrictEqual(
    flagInProse.map((step) => `${step.file}: ${step.text}`),
    [],
    "an explanation that names a flag must show the command that takes it."
  );
  // Rule 3: both buckets must stay populated. An empty explanation bucket would
  // mean the rule collapsed; an empty action bucket would mean it went blind.
  assert.ok(EXPLANATIONS.length > 0, "no explanations classified — the rule has collapsed.");
  assert.ok(ACTIONS.length > EXPLANATIONS.length, "actions must dominate the remediation corpus.");
});

// The ONE narrow exemption, named and justified rather than pattern-matched.
// install-preview runs against a target that does not have coord installed yet:
// there is no coord/scripts/gov to name, which is the entire point of the
// preview. Every other emitter is a governed gate that blocks a caller who DOES
// have the CLI. The list is asserted below so it cannot grow quietly.
const COMMANDLESS_EXEMPT = Object.freeze(["hooks/install-preview.js"]);

test("COORD-572: every issue that emits remediations offers at least one runnable command", () => {
  assert.deepStrictEqual(
    COMMANDLESS_EXEMPT,
    ["hooks/install-preview.js"],
    "the commandless exemption list changed. Each entry must be a surface where the gov CLI " +
      "genuinely does not exist yet — not a gate that simply has not named its mechanism."
  );
  const commandless = HARVEST.issues
    .filter((issue) => !COMMANDLESS_EXEMPT.includes(issue.file))
    .filter((issue) => !issue.steps.some((step) => surface.classifyRemediation(step.text).kind === "action"))
    .map((issue) => `${issue.file}: ${issue.steps.map((step) => step.text).join(" / ")}`);
  assert.deepStrictEqual(
    commandless,
    [],
    "a gate that blocks the caller and names no command is the COORD-612 defect verbatim:\n" +
      commandless.join("\n")
  );
});

// --- RED PROOF: each rule demonstrated failing ------------------------------
//
// A checker nobody has seen fail is a checker nobody can trust. These drive the
// SAME validators the corpus tests use against deliberately broken remediations,
// so the guard's teeth are part of the suite rather than a claim in a commit
// message.

test("COORD-572 red proof: a remediation naming a non-existent verb fails", () => {
  const defects = validateAction("coord/scripts/gov add-prompt COORD-000 --create");
  assert.ok(
    defects.some((defect) => /does not handle/.test(defect)),
    `expected an unknown-verb defect, got: ${JSON.stringify(defects)}`
  );
  // ...and the real spelling passes, which is the point of instance 4.
  assert.deepStrictEqual(validateAction("coord/scripts/gov register-prompt COORD-000 --create"), []);
});

test("COORD-572 red proof: a remediation naming a non-existent flag fails", () => {
  const defects = validateAction('coord/scripts/gov update-plan COORD-000 --context-pack "{}"');
  assert.ok(
    defects.some((defect) => /no dispatch table registers|does not parse/.test(defect)),
    `expected an unknown-flag defect, got: ${JSON.stringify(defects)}`
  );
});

test("COORD-572 red proof: a remediation passing a value outside a closed enum fails", () => {
  const defects = validateAction("coord/scripts/gov add-repo-gate COORD-000 --command x --result maybe");
  assert.ok(
    defects.some((defect) => /outside the accepted enum|does not parse/.test(defect)),
    `expected an enum defect, got: ${JSON.stringify(defects)}`
  );
  assert.deepStrictEqual(
    validateAction("coord/scripts/gov add-repo-gate COORD-000 --command x --result pass"),
    []
  );
});

test("COORD-572 red proof: a remediation using the internal camelCase JSON spelling fails", () => {
  const defects = validateAction("coord/scripts/gov update-plan COORD-000 --summary \"set contextPackAck\"");
  assert.ok(
    defects.some((defect) => /internal option spelling/.test(defect)),
    `expected a JSON-casing defect, got: ${JSON.stringify(defects)}`
  );
});

test("COORD-572 red proof: advice that steers to a hand-edit fails even though it is valid prose", () => {
  // The literal advice the context-pack-ack gate used to print.
  const defects = validateNoHandEdit("Record context_pack_ack in the canonical plan record before review.");
  assert.strictEqual(defects.length, 1, `expected a hand-edit defect, got: ${JSON.stringify(defects)}`);
  // Naming the sanctioned writer clears it.
  assert.deepStrictEqual(
    validateNoHandEdit(
      "Record it with coord/scripts/gov update-plan COORD-000 --context-pack-ack '<json>' — never hand-edit the plan record."
    ),
    []
  );
});
