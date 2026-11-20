const fs = require("fs");
const path = require("path");

const KNOWN_NON_CLI_VERB_ALLOWLIST = new Set([
  // Add a verb here only if it is a documented facade/MCP alias with no direct
  // dispatchCommand handler, with a comment explaining why.
]);

function extractBacktickedVerbs(docText, leadingToken) {
  const verbs = new Set();
  if (typeof docText !== "string" || !docText) {
    return verbs;
  }
  const spanPattern = /`([^`\n]+)`/g;
  const verbPattern = new RegExp(
    "(?:^|/)" + leadingToken + "\\s+([a-z][a-z0-9-]*)",
    "g"
  );
  let spanMatch;
  while ((spanMatch = spanPattern.exec(docText)) !== null) {
    const span = spanMatch[1];
    verbPattern.lastIndex = 0;
    let verbMatch;
    while ((verbMatch = verbPattern.exec(span)) !== null) {
      verbs.add(verbMatch[1]);
    }
  }
  return verbs;
}

function parseDocumentedGovVerbs(docText) {
  return extractBacktickedVerbs(docText, "gov");
}

function parseDocumentedAgentVerbs(docText) {
  return extractBacktickedVerbs(docText, "agent");
}

function fallbackCliSource(sourceText) {
  if (
    typeof sourceText === "string" &&
    (sourceText.includes('require("./cli.js")') || sourceText.includes('require("./lifecycle.js")'))
  ) {
    return fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");
  }
  return sourceText;
}

// COORD-1016: the routed verb set is the command declaration's (command-declaration.js). The
// literal cli.js switch is proven equal to it, in both directions, by command-declaration.test.js.
// The source text only gates the result: text that is not the dispatchCommand router yields none.
function collectDispatchCommandVerbs(sourceText) {
  sourceText = fallbackCliSource(sourceText);
  const routed = typeof sourceText === "string" && sourceText.includes("function dispatchCommand(");
  return new Set(routed ? require("./command-declaration.js").SPELLINGS : []);
}

function collectParseFlagsFlags(sourceText) {
  const flags = new Set();
  sourceText = fallbackCliSource(sourceText);
  if (typeof sourceText !== "string") {
    return flags;
  }
  // COORD-094: parseFlags is now data-driven — the flag spec lives in the
  // VALUE_FLAGS / APPEND_FLAGS / BOOL_FLAGS / SPECIAL_FLAGS object literals that
  // immediately precede `function parseFlags(`, not in `case "--x":` arms. Scan
  // the region spanning those tables through the end of the parseFlags body and
  // collect every quoted flag-string key (`"--flag":` and the `-m` short flag),
  // plus any legacy `case "--x":` labels so the collector keeps working for
  // switch-style parsers (e.g. lifecycle-flags) and during transition.
  const tableStart = sourceText.indexOf("const VALUE_FLAGS");
  const fnStart = sourceText.indexOf("function parseFlags(");
  if (fnStart === -1) {
    return flags;
  }
  const start = tableStart !== -1 && tableStart < fnStart ? tableStart : fnStart;
  const rest = sourceText.slice(start);
  // End at the first `\nfunction ` that appears AT/AFTER parseFlags so the
  // tables-before-parseFlags region is fully included.
  const afterFn = rest.slice(fnStart - start);
  const fnEnd = afterFn.indexOf("\nfunction ");
  const body = fnEnd === -1 ? rest : rest.slice(0, (fnStart - start) + fnEnd);
  // Quoted flag keys in the tables/special handlers: "--flag" or "-m".
  const keyPattern = /"(--?[a-z][a-z0-9-]*)"\s*:/g;
  // Legacy switch arms (kept for resilience / other parsers).
  const casePattern = /case\s+"(--?[a-z][a-z0-9-]*)":/g;
  let match;
  while ((match = keyPattern.exec(body)) !== null) {
    flags.add(match[1]);
  }
  while ((match = casePattern.exec(body)) !== null) {
    flags.add(match[1]);
  }
  // COORD-984: shared flags are spread into the tables from flag-tables.js, not written in cli.js.
  if (body.includes("...SHARED_")) {
    for (const table of Object.values(require("./flag-tables.js"))) {
      for (const key of Object.keys(table)) flags.add(key);
    }
  }
  // The `--plan-update` guard is an explicit branch, not a table key.
  if (body.includes('"--plan-update"') || body.includes("--plan-update")) {
    flags.add("--plan-update");
  }
  return flags;
}

function collectAgentFacadeVerbs(agentScriptText) {
  const verbs = new Set();
  if (typeof agentScriptText !== "string") {
    return verbs;
  }
  const pattern = /^\s*([a-z][a-z0-9-]*)\)/gm;
  let match;
  while ((match = pattern.exec(agentScriptText)) !== null) {
    verbs.add(match[1]);
  }
  return verbs;
}

function collectAgentWrapperFlags(agentScriptText) {
  const flags = new Set();
  if (typeof agentScriptText !== "string") {
    return flags;
  }
  const pattern = /(--[a-z][a-z0-9-]*)/g;
  let match;
  while ((match = pattern.exec(agentScriptText)) !== null) {
    if (match[1] === "--help") {
      continue;
    }
    flags.add(match[1]);
  }
  return flags;
}

function runVerbParityCheck({
  docTexts = [],
  governanceSource = "",
  agentScriptText = "",
  testFileText = "",
} = {}) {
  const documentedGovVerbs = new Set();
  const documentedAgentVerbs = new Set();
  for (const docText of docTexts) {
    for (const verb of parseDocumentedGovVerbs(docText)) {
      documentedGovVerbs.add(verb);
    }
    for (const verb of parseDocumentedAgentVerbs(docText)) {
      documentedAgentVerbs.add(verb);
    }
  }
  const dispatchVerbs = collectDispatchCommandVerbs(governanceSource);
  const parseFlagsFlags = collectParseFlagsFlags(governanceSource);
  const facadeVerbs = collectAgentFacadeVerbs(agentScriptText);
  const wrapperFlags = collectAgentWrapperFlags(agentScriptText);

  const missingGovHandlers = [];
  for (const verb of documentedGovVerbs) {
    if (!dispatchVerbs.has(verb) && !KNOWN_NON_CLI_VERB_ALLOWLIST.has(verb)) {
      missingGovHandlers.push(verb);
    }
  }

  const missingAgentVerbs = [];
  for (const verb of documentedAgentVerbs) {
    if (
      !facadeVerbs.has(verb) &&
      !dispatchVerbs.has(verb) &&
      !KNOWN_NON_CLI_VERB_ALLOWLIST.has(verb)
    ) {
      missingAgentVerbs.push(verb);
    }
  }

  const missingFlagHandlers = [];
  for (const flag of wrapperFlags) {
    if (!parseFlagsFlags.has(flag)) {
      missingFlagHandlers.push(flag);
    }
  }

  const lifecycleVerbCoverageTokens = {
    start: ["start", "startTicket"],
    submit: ["submit", "submitTicket"],
    "move-review": ["move-review", "moveReview", "review"],
    land: ["land", "landTicket"],
    finalize: ["finalize", "finalizeTicket"],
    "mark-done": ["mark-done", "markDone"],
    unstart: ["unstart", "unstartTicket"],
    "lock-abandon": ["lock-abandon", "lockAbandon", "abandon-lock"],
    block: ["blockTicket"],
    unblock: ["unblockTicket"],
    "return-doing": ["return-doing", "returnDoing", "ReturnDoing", "repair"],
    reopen: ["reopen", "reopenTicket"],
  };
  const lifecycleVerbsWithoutTests = [];
  if (testFileText) {
    const haystack = testFileText.toLowerCase();
    for (const [verb, tokens] of Object.entries(lifecycleVerbCoverageTokens)) {
      const covered = tokens.some((token) => haystack.includes(token.toLowerCase()));
      if (!covered) {
        lifecycleVerbsWithoutTests.push(verb);
      }
    }
  }

  return {
    documentedGovVerbs: [...documentedGovVerbs].sort(),
    documentedAgentVerbs: [...documentedAgentVerbs].sort(),
    dispatchVerbs: [...dispatchVerbs].sort(),
    facadeVerbs: [...facadeVerbs].sort(),
    parseFlagsFlags: [...parseFlagsFlags].sort(),
    wrapperFlags: [...wrapperFlags].sort(),
    missingGovHandlers: missingGovHandlers.sort(),
    missingAgentVerbs: missingAgentVerbs.sort(),
    missingFlagHandlers: missingFlagHandlers.sort(),
    lifecycleVerbsWithoutTests: lifecycleVerbsWithoutTests.sort(),
    ok:
      missingGovHandlers.length === 0 &&
      missingAgentVerbs.length === 0 &&
      missingFlagHandlers.length === 0,
  };
}

// COORD-955: documented-flag and operator-doc parity. The helpers below are
// pure text extractors (no I/O) so the checks can be exercised on synthetic
// fixtures; the live parser and dispatch tables are injected by the caller.

// Operator-facing documents whose commands, flags and repo paths must resolve.
// Paths are repo-relative. coord/engine/docs/*.md is added by operatorDocSources.
const OPERATOR_DOC_PATHS = Object.freeze([
  "coord/GOVERNANCE.md",
  "coord/VERB_CONTRACT.md",
  "coord/scripts/README.md",
  "coord/product/TESTING_AND_GATES.md",
  "USER_MANUAL.md",
  "QUICKSTART.md",
  "README.md",
  "KNOWN_ISSUES.md",
  "CLAUDE.md",
  "AGENTS.md",
]);

function operatorDocSources(repoRoot) {
  const engineDocs = path.join(repoRoot, "coord", "engine", "docs");
  const extra = fs.existsSync(engineDocs)
    ? fs.readdirSync(engineDocs).filter((name) => name.endsWith(".md")).sort()
      .map((name) => path.posix.join("coord/engine/docs", name))
    : [];
  return [...OPERATOR_DOC_PATHS, ...extra];
}

// Code segments of a Markdown document: fenced blocks plus inline code spans
// found in prose. Continuation lines (backslash-newline) are joined. Mirrors the
// extraction used by coord/scripts/documented-gov-verbs.test.js.
function documentedCodeSegments(text) {
  if (typeof text !== "string") return [];
  const code = [], prose = [];
  let fence = null, fenced = [];
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { fence = marker[1]; fenced = []; continue; }
    if (marker && marker[1][0] === fence?.[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      code.push(fenced.join("\n")); fence = null; continue;
    }
    if (fence) fenced.push(line);
    else prose.push(line);
  }
  if (fence) code.push(fenced.join("\n"));
  for (const match of prose.join("\n").matchAll(/(?<!\\)(`+)([\s\S]*?)(?<!\\)\1/g)) code.push(match[2]);
  return code.map((block) => block.replace(/\\\r?\n/g, " "));
}

// Every `gov <verb> ...` invocation in the code segments, with the long flags
// that appear in its argument text. Arguments stop at a shell separator, quoted
// text is ignored (a flag inside a quoted message is not a flag), and --help is
// not a parser flag.
function govInvocations(text) {
  const out = [];
  for (const segment of documentedCodeSegments(text)) {
    for (const match of segment.matchAll(/\bgov\s+([a-z][a-z0-9-]*)\b([^\n`]*)/g)) {
      const args = match[2].split(/&&|\|\||;/)[0].replace(/"[^"]*"|'[^']*'/g, " ");
      const flags = [...args.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)].map((m) => m[1])
        .filter((flag) => flag !== "--help");
      out.push({ verb: match[1], flags: [...new Set(flags)] });
    }
  }
  return out;
}

// Script paths named after `node` in code segments (node coord/.../x.js).
function documentedNodeScripts(text) {
  const scripts = new Set();
  for (const segment of documentedCodeSegments(text)) {
    for (const match of segment.matchAll(/\bnode\s+((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs))\b/g)) {
      scripts.add(match[1]);
    }
  }
  return [...scripts].sort();
}

const PATH_ROOTS = /^(?:coord|scripts|engine|docs|release|create-concord|test|frontend|examples|\.github|\.claude)\//;
const PATH_EXTENSION = /\.(?:js|json|md|sh|ts|tsx|mjs|cjs|yml|yaml|txt|py|toml|csv)$/;

// Repo-path tokens written inside inline backtick spans (prose code, not fences).
function documentedBacktickPaths(text) {
  const paths = new Set();
  if (typeof text !== "string") return [];
  const prose = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { fence = marker[1]; continue; }
    if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; continue; }
    if (!fence) prose.push(line);
  }
  for (const match of prose.join("\n").matchAll(/(?<!\\)`([^`\n]+)`/g)) {
    for (const raw of match[1].split(/\s+/)) {
      const token = raw.replace(/^[("'\[]+|[)"'\],.;:]+$/g, "");
      if (!token || /[*<>${}|]|:\/\/|^--/.test(token)) continue;
      if (!PATH_ROOTS.test(token)) continue;
      if (PATH_EXTENSION.test(token) || /^coord\/scripts\/[\w-]+$/.test(token) || token.endsWith("/")) paths.add(token);
    }
  }
  return [...paths].sort();
}

// Ask a LIVE parser whether it accepts a flag. The probe passes the flag with a
// value. The parser refuses a flag it does not know by naming that exact flag in
// one of its refusal forms; a refusal about the probe value, a missing value, or a
// suggestion list that merely contains the flag as a prefix is not a refusal of
// the flag itself.
function flagAcceptedByParser(parse, flag) {
  try {
    parse([flag, "probe"]);
    return true;
  } catch (error) {
    const message = String((error && error.message) || "");
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const refusesFlag = new RegExp(`Unknown flag "${escaped}"|unknown or valueless argument ${escaped}(?![\\w-])`);
    return !refusesFlag.test(message);
  }
}

// Long flags written inside inline backtick spans (prose or fenced code excluded),
// whether or not a verb precedes them: a documented flag is a documented flag.
function documentedBacktickFlags(text) {
  const flags = new Set();
  if (typeof text !== "string") return [];
  const prose = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { fence = marker[1]; continue; }
    if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; continue; }
    if (!fence) prose.push(line);
  }
  for (const match of prose.join("\n").matchAll(/(?<!\\)`([^`\n]+)`/g)) {
    for (const m of match[1].matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) {
      if (m[1] !== "--help") flags.add(m[1]);
    }
  }
  return [...flags].sort();
}

// docs: [{ path, text }]. parserFor(verb) returns the live parse function that
// owns the verb's flags, or null when the verb's argv parser has no dry seam.
// Structured findings let callers apply a reviewed allowlist per document.
function runVerbFlagParityCheck({ docs = [], verbs = [], parserFor } = {}) {
  const dispatch = new Set(verbs);
  const unknownVerbs = [];
  const unacceptedFlags = [];
  const unverified = [];
  let invocationCount = 0;
  for (const doc of docs) {
    for (const invocation of govInvocations(doc.text)) {
      invocationCount++;
      if (!dispatch.has(invocation.verb)) {
        unknownVerbs.push({ doc: doc.path, verb: invocation.verb });
        continue;
      }
      const parse = parserFor(invocation.verb);
      if (!parse) {
        if (invocation.flags.length) unverified.push({ doc: doc.path, verb: invocation.verb });
        continue;
      }
      for (const flag of invocation.flags) {
        if (!flagAcceptedByParser(parse, flag)) {
          unacceptedFlags.push({ doc: doc.path, verb: invocation.verb, flag });
        }
      }
    }
  }
  return { invocationCount, unknownVerbs, unacceptedFlags, unverified };
}

module.exports = {
  OPERATOR_DOC_PATHS,
  documentedBacktickFlags,
  documentedBacktickPaths,
  documentedCodeSegments,
  documentedNodeScripts,
  flagAcceptedByParser,
  govInvocations,
  operatorDocSources,
  runVerbFlagParityCheck,
  collectAgentFacadeVerbs,
  collectAgentWrapperFlags,
  collectDispatchCommandVerbs,
  collectParseFlagsFlags,
  parseDocumentedAgentVerbs,
  parseDocumentedGovVerbs,
  runVerbParityCheck,
};

