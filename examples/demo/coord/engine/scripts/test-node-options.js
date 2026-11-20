"use strict";

// Keep nested governance runners on their own checkout's isolation guard while
// preserving all unrelated inherited Node options.
function tokenizeNodeOptions(source) {
  const tokens = [];
  let raw = "";
  let value = "";
  let quote = null;
  let escaped = false;
  const push = () => {
    if (raw) tokens.push({ raw, value });
    raw = "";
    value = "";
  };
  for (const char of String(source || "")) {
    if (!quote && !escaped && /\s/.test(char)) { push(); continue; }
    raw += char;
    if (escaped) { value += char; escaped = false; }
    else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = null;
      else value += char;
    } else if (char === "\"" || char === "'") quote = char;
    else value += char;
  }
  if (escaped) value += "\\";
  push();
  return tokens;
}

function quoteNodeOption(value) {
  return /\s/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function isIsolationGuardOption(value) {
  return String(value).replace(/\\/g, "/").split("/").pop() === "test-isolation-guard.js";
}

function withoutInheritedIsolationGuardOptions(source) {
  const tokens = tokenizeNodeOptions(source);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].value;
    if (token === "--require" || token === "-r" || token === "--test-coverage-exclude") {
      const next = tokens[i + 1];
      if (next && isIsolationGuardOption(next.value)) { i += 1; continue; }
    }
    if (token.startsWith("--require=") && isIsolationGuardOption(token.slice("--require=".length))) continue;
    if (token.startsWith("-r") && token.length > 2 && isIsolationGuardOption(token.slice(2).replace(/^=/, ""))) continue;
    if (token.startsWith("--test-coverage-exclude=") && isIsolationGuardOption(token.slice("--test-coverage-exclude=".length))) continue;
    kept.push(tokens[i].raw);
  }
  return kept.join(" ");
}

module.exports = { tokenizeNodeOptions, quoteNodeOption, isIsolationGuardOption, withoutInheritedIsolationGuardOptions };
