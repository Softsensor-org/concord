"use strict";

// Strip JS comments (`//` line + `/* */` block) from a source string in a way
// that is ROBUST to comment markers appearing inside string and regex literals.
// COORD-094: the previous regex approach (`text.replace(/\/\*[\s\S]*?\*\//g)`)
// treated any `/*` as a block-comment opener even when it sat inside a string
// (e.g. `"coord/.runtime/plans/*.json"`, `endsWith("/*")`, the template literal
// `${id}/*`) or a regex. An unbalanced `/*` inside a literal would swallow
// hundreds of real lines as a phantom comment, mis-counting large files (it
// under-counted lifecycle.js by ~1600 LOC). This is a small character-by-char
// state machine over lexical contexts that can contain a `/*` or `//`:
//   - inside a single/double-quoted or template string
//   - inside a regex literal
//   - inside a line/block comment (the only contexts where markers count)
// Markers found inside strings/regex are emitted verbatim (NOT stripped) so the
// surrounding code line survives; only genuine comment spans are removed.
// Returns the source with comment characters replaced by spaces (newlines in a
// block comment are preserved so line numbering downstream is unaffected).
const REGEX_PREFIX_WORDS = new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do"]);
const CONTROL_WORDS = new Set(["if", "while", "for", "with", "switch", "catch"]);

function stripComments(source) {
  const text = String(source == null ? "" : source);
  let out = "";
  // States: code | line (//) | block (/* */) | sq ('') | dq ("") | tpl (``) | re (//)
  let state = "code";
  // For regex detection we track the previous significant token so
  // we can decide whether a `/` starts a regex or is a division operator.
  let prevSig = "";
  // Each ${...} frame saves its enclosing interpolation while nested templates run.
  const interpolations = [];
  let braces = 0;
  let regexClass = false;
  const parens = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
        const word = text.slice(i, end);
        out += word; prevSig = prevSig === "." ? "value" : word; i = end - 1; continue;
      }
      if (ch === "(") parens.push(CONTROL_WORDS.has(prevSig));
      if (ch === ")") {
        prevSig = parens.pop() ? "control-end" : ")"; out += ch; continue;
      }
      if (ch === "/" && next === "/") { state = "line"; out += "  "; i += 1; continue; }
      if (ch === "/" && next === "*") { state = "block"; out += "  "; i += 1; continue; }
      if (ch === "'") { state = "sq"; out += ch; prevSig = ch; continue; }
      if (ch === "\"") { state = "dq"; out += ch; prevSig = ch; continue; }
      if (ch === "`") { state = "tpl"; out += ch; prevSig = ch; continue; }
      if (ch === "/" && regexCanStartAfter(prevSig)) { state = "re"; regexClass = false; out += ch; continue; }
      if (interpolations.length && ch === "{") braces += 1;
      if (interpolations.length && ch === "}" && --braces === 0) {
        ({ braces, prevSig } = interpolations.pop());
        state = "tpl"; out += ch; continue;
      }
      out += ch;
      if (!/\s/.test(ch)) prevSig = ch;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      else out += " ";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; out += "  "; i += 1; }
      else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    // string / template / regex bodies: copy verbatim, honoring escapes.
    out += ch;
    if (ch === "\\") { out += next == null ? "" : next; i += 1; continue; }
    if (state === "tpl" && ch === "$" && next === "{") {
      interpolations.push({ braces, prevSig });
      braces = 1; prevSig = ""; state = "code"; out += next; i += 1; continue;
    }
    // A slash inside a character class cannot close the regex literal.
    if (state === "re" && ch === "[") regexClass = true;
    else if (state === "re" && ch === "]") regexClass = false;
    if (state === "sq" && ch === "'") { state = "code"; prevSig = "value"; }
    else if (state === "dq" && ch === "\"") { state = "code"; prevSig = "value"; }
    else if (state === "tpl" && ch === "`") { state = "code"; prevSig = "value"; }
    else if (state === "re" && ch === "/" && !regexClass) { state = "code"; prevSig = "value"; }
  }
  return out;
}

// A `/` begins a regex literal (not division) when the previous significant
// token expects an expression, including return/throw and a completed control
// condition. Value tokens and ordinary call parentheses retain division context.
function regexCanStartAfter(prevSig) {
  if (prevSig === "" || prevSig === "control-end" || REGEX_PREFIX_WORDS.has(prevSig)) return true;
  return !/[A-Za-z0-9_$)\]]/.test(prevSig);
}

module.exports = { stripComments };
