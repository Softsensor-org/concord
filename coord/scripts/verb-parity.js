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

function collectDispatchCommandVerbs(sourceText) {
  const verbs = new Set();
  sourceText = fallbackCliSource(sourceText);
  if (typeof sourceText !== "string") {
    return verbs;
  }
  const start = sourceText.indexOf("function dispatchCommand(");
  if (start === -1) {
    return verbs;
  }
  const rest = sourceText.slice(start);
  const end = rest.indexOf("\nfunction ");
  const body = end === -1 ? rest : rest.slice(0, end);
  const pattern = /case\s+"([a-z][a-z0-9-]*)":/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    verbs.add(match[1]);
  }
  return verbs;
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

module.exports = {
  collectAgentFacadeVerbs,
  collectAgentWrapperFlags,
  collectDispatchCommandVerbs,
  collectParseFlagsFlags,
  parseDocumentedAgentVerbs,
  parseDocumentedGovVerbs,
  runVerbParityCheck,
};

