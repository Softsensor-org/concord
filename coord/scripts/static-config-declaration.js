"use strict";

// coord/scripts/static-config-declaration.js — COORD-657.
//
// Reads an ADOPTER-owned `coord/project.config.js` WITHOUT EXECUTING IT.
//
// TRUST BOUNDARY (ADR-0007 context, ADR-0010 class). Business discovery runs
// against repositories Concord has never seen — onboarding is precisely the
// moment the engine meets an untrusted workspace. A `project.config.js` found
// there is INPUT the code receives from its environment, not state it holds,
// exactly as ADR-0010 ruled for the install ledger and mutex. It must never be
// handed a running process with the operator's ambient credentials, so this
// module never calls `require`, `eval`, `new Function`, or `node:vm` on it.
//
// It parses a deliberately small DECLARATIVE grammar instead:
//
//     ["use strict";]
//     module.exports = <object literal of literals only>;
//
// where a value is a string, number, `true`, `false`, `null`, an array of
// values, or an object of values. Anything that could run — an identifier
// reference, a call, a template literal, a spread, a function, a computed key,
// an operator — is REFUSED and NAMED. There is no partial-execution mode and
// no fallback that runs the file.
//
// Refusals are classified (`code`) and carry operator remediation naming the
// file. They never echo file CONTENT: a refusal reports the construct KIND and
// its line/column only, so a secret or canary sitting inside a rejected
// configuration cannot ride the error message into a discovery artifact.
//
// This module is for the UNTRUSTED discovery boundary only. The engine's own
// governed load of its OWN workspace config (`coord/paths.js`
// `loadProjectConfig`, and the CLI/init/contract/shim callers that go through
// it) is the TRUSTED path and is deliberately unchanged.

const fs = require("node:fs");
const path = require("node:path");

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 20000;

const REFUSAL_CODES = Object.freeze({
  UNREADABLE: "config_unreadable",
  TOO_LARGE: "config_too_large",
  UNSUPPORTED_SHAPE: "config_unsupported_module_shape",
  NOT_DECLARATIVE: "config_not_declarative",
  UNTRUSTED_PATH: "config_untrusted_path",
  PLATFORM_UNSUPPORTED: "config_platform_unsupported",
});

class DeclarationRefusal extends Error {
  constructor(code, detail, position) {
    super(detail);
    this.name = "DeclarationRefusal";
    this.code = code;
    this.detail = detail;
    this.position = position || null;
  }
}

function refuse(code, detail, position) {
  throw new DeclarationRefusal(code, detail, position);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// `(` and `)` are tokenized rather than refused outright so the PARSER, which
// knows where it is, can name the construct precisely — "a module load
// expression" inside a value, "no top-level `module.exports` assignment" at the
// program level. Nothing here evaluates; tokenizing a character is not running
// it.
const PUNCTUATION = new Set(["{", "}", "[", "]", ":", ",", ";", "=", ".", "(", ")"]);

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function decodeStringLiteral(raw, quote, position) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": out += "\0"; break;
      case "\\": out += "\\"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "\n": break;
      case "x": {
        const hex = raw.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a malformed hex escape in a string literal", position);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        if (raw[i + 1] === "{") {
          const end = raw.indexOf("}", i + 2);
          const hex = end === -1 ? "" : raw.slice(i + 2, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a malformed unicode escape in a string literal", position);
          out += String.fromCodePoint(parseInt(hex, 16));
          i = end;
        } else {
          const hex = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a malformed unicode escape in a string literal", position);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default:
        if (next === undefined) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "an unterminated string literal", position);
        out += next;
    }
  }
  void quote;
  return out;
}

// Produces a flat token stream. Comments and whitespace are dropped. Any
// construct that is not part of the declarative grammar is refused here or in
// the parser; nothing is ever compiled or evaluated.
function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function position() {
    return { line, column };
  }

  function advance(count) {
    for (let i = 0; i < count; i += 1) {
      if (source[index] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  }

  while (index < source.length) {
    const ch = source[index];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v" || ch === "﻿") {
      advance(1);
      continue;
    }

    if (ch === "#" && index === 0 && source[1] === "!") {
      const end = source.indexOf("\n", index);
      advance((end === -1 ? source.length : end) - index);
      continue;
    }

    if (ch === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      advance((end === -1 ? source.length : end) - index);
      continue;
    }

    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "an unterminated block comment", position());
      advance(end + 2 - index);
      continue;
    }

    if (ch === "`") {
      refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a template literal", position());
    }

    if (ch === "'" || ch === '"') {
      const start = position();
      const quote = ch;
      let cursor = index + 1;
      let raw = "";
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          raw += current + (source[cursor + 1] ?? "");
          cursor += 2;
          continue;
        }
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\n") break;
        raw += current;
        cursor += 1;
      }
      if (!closed) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "an unterminated string literal", start);
      advance(cursor + 1 - index);
      tokens.push({ type: "string", value: decodeStringLiteral(raw, quote, start), position: start });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[index + 1] || ""))) {
      const start = position();
      const match = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(index));
      if (!match) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a malformed numeric literal", start);
      const text = match[0];
      if (/[n]$/.test(source.slice(index + text.length, index + text.length + 1))) {
        refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a bigint literal", start);
      }
      const numeric = Number(text.replace(/_/g, ""));
      if (!Number.isFinite(numeric)) refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a non-finite numeric literal", start);
      advance(text.length);
      tokens.push({ type: "number", value: numeric, position: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = position();
      let cursor = index;
      while (cursor < source.length && isIdentPart(source[cursor])) cursor += 1;
      const text = source.slice(index, cursor);
      advance(text.length);
      tokens.push({ type: "identifier", value: text, position: start });
      continue;
    }

    if (PUNCTUATION.has(ch)) {
      const start = position();
      advance(1);
      tokens.push({ type: "punct", value: ch, position: start });
      continue;
    }

    refuse(REFUSAL_CODES.NOT_DECLARATIVE, `an unsupported \`${ch}\` operator or expression`, position());
  }

  tokens.push({ type: "eof", value: null, position: position() });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — literals only
// ---------------------------------------------------------------------------

function createParser(tokens) {
  let cursor = 0;
  let nodes = 0;

  function peek(offset = 0) {
    return tokens[Math.min(cursor + offset, tokens.length - 1)];
  }

  function next() {
    const token = peek();
    if (token.type !== "eof") cursor += 1;
    return token;
  }

  function countNode(position) {
    nodes += 1;
    if (nodes > MAX_NODES) {
      refuse(REFUSAL_CODES.TOO_LARGE, `more than ${MAX_NODES} declared values`, position);
    }
  }

  function describe(token) {
    if (token.type === "identifier") return `an identifier reference \`${token.value}\``;
    if (token.type === "eof") return "an unexpected end of file";
    if (token.type === "punct" && (token.value === "(" || token.value === ")")) return "a parenthesized or called expression";
    if (token.type === "punct") return `an unexpected \`${token.value}\``;
    return `an unexpected ${token.type}`;
  }

  function parseValue(depth) {
    if (depth > MAX_DEPTH) refuse(REFUSAL_CODES.TOO_LARGE, `a value nested deeper than ${MAX_DEPTH} levels`, peek().position);
    const token = next();
    countNode(token.position);

    if (token.type === "string") return token.value;
    if (token.type === "number") return token.value;

    if (token.type === "identifier") {
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      if (token.value === "function" || token.value === "async" || token.value === "class") {
        refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a function or class expression", token.position);
      }
      if (token.value === "require" || token.value === "import") {
        refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a module load expression", token.position);
      }
      if (token.value === "new") refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a constructor expression", token.position);
      refuse(REFUSAL_CODES.NOT_DECLARATIVE, `an identifier reference \`${token.value}\``, token.position);
    }

    if (token.type === "punct" && token.value === "[") {
      const items = [];
      while (!(peek().type === "punct" && peek().value === "]")) {
        if (peek().type === "eof") refuse(REFUSAL_CODES.NOT_DECLARATIVE, "an unterminated array literal", token.position);
        items.push(parseValue(depth + 1));
        if (peek().type === "punct" && peek().value === ",") {
          next();
          continue;
        }
        break;
      }
      const close = next();
      if (!(close.type === "punct" && close.value === "]")) {
        refuse(REFUSAL_CODES.NOT_DECLARATIVE, describe(close), close.position);
      }
      return items;
    }

    if (token.type === "punct" && token.value === "{") {
      const object = {};
      while (!(peek().type === "punct" && peek().value === "}")) {
        const keyToken = next();
        if (keyToken.type === "eof") refuse(REFUSAL_CODES.NOT_DECLARATIVE, "an unterminated object literal", token.position);
        let key;
        if (keyToken.type === "string") key = keyToken.value;
        else if (keyToken.type === "number") key = String(keyToken.value);
        else if (keyToken.type === "identifier") key = keyToken.value;
        else if (keyToken.type === "punct" && keyToken.value === "[") {
          refuse(REFUSAL_CODES.NOT_DECLARATIVE, "a computed property key", keyToken.position);
        } else {
          refuse(REFUSAL_CODES.NOT_DECLARATIVE, describe(keyToken), keyToken.position);
        }

        const colon = next();
        if (!(colon.type === "punct" && colon.value === ":")) {
          // `{ foo }` shorthand, `{ foo() {} }` methods, `{ ...spread }` all land here.
          refuse(REFUSAL_CODES.NOT_DECLARATIVE, `a non-literal property \`${key}\``, keyToken.position);
        }

        // Reject prototype-polluting keys outright rather than silently
        // materializing them (validate before any property is believed).
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          refuse(REFUSAL_CODES.NOT_DECLARATIVE, `a reserved property key \`${key}\``, keyToken.position);
        }

        // Every parsed value is materialized. Nothing is silently dropped:
        // `undefined` is an IDENTIFIER and is refused by parseValue (F10).
        const value = parseValue(depth + 1);
        Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

        if (peek().type === "punct" && peek().value === ",") {
          next();
          continue;
        }
        break;
      }
      const close = next();
      if (!(close.type === "punct" && close.value === "}")) {
        refuse(REFUSAL_CODES.NOT_DECLARATIVE, describe(close), close.position);
      }
      return object;
    }

    refuse(REFUSAL_CODES.NOT_DECLARATIVE, describe(token), token.position);
    return undefined;
  }

  function parseProgram() {
    // Optional leading directive prologue ("use strict" and friends).
    while (peek().type === "string" && peek(1).type === "punct" && [";", "}"].includes(peek(1).value)) {
      next();
      next();
    }
    while (peek().type === "string" && peek(1).type === "identifier" && peek(1).value === "module") {
      next();
    }

    const moduleToken = next();
    if (!(moduleToken.type === "identifier" && moduleToken.value === "module")) {
      refuse(REFUSAL_CODES.UNSUPPORTED_SHAPE, "no top-level `module.exports = { ... }` assignment", moduleToken.position);
    }
    const dot = next();
    if (!(dot.type === "punct" && dot.value === ".")) {
      refuse(REFUSAL_CODES.UNSUPPORTED_SHAPE, "no top-level `module.exports = { ... }` assignment", dot.position);
    }
    const exportsToken = next();
    if (!(exportsToken.type === "identifier" && exportsToken.value === "exports")) {
      refuse(REFUSAL_CODES.UNSUPPORTED_SHAPE, "no top-level `module.exports = { ... }` assignment", exportsToken.position);
    }
    const equals = next();
    if (!(equals.type === "punct" && equals.value === "=")) {
      refuse(REFUSAL_CODES.UNSUPPORTED_SHAPE, "no top-level `module.exports = { ... }` assignment", equals.position);
    }

    const open = peek();
    if (!(open.type === "punct" && open.value === "{")) {
      refuse(REFUSAL_CODES.UNSUPPORTED_SHAPE, "a `module.exports` value that is not an object literal", open.position);
    }
    const value = parseValue(0);

    if (peek().type === "punct" && peek().value === ";") next();
    const trailing = peek();
    if (trailing.type !== "eof") {
      refuse(REFUSAL_CODES.NOT_DECLARATIVE, `a second top-level statement (${describe(trailing)})`, trailing.position);
    }
    return value;
  }

  return { parseProgram };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function remediationFor(code, shown) {
  const rerun = "then re-run `coord business-discovery`";
  if (code === REFUSAL_CODES.PLATFORM_UNSUPPORTED) {
    return `Run \`coord business-discovery\` on a platform whose filesystem can open a file without following symbolic links. Concord fails closed rather than reading ${shown} through a link it cannot refuse or blocking forever on an entry it cannot decline.`;
  }
  if (code === REFUSAL_CODES.UNTRUSTED_PATH) {
    return `Replace ${shown} with a regular file inside the scanned workspace — not a symbolic link, and not reached through a symlinked parent directory — and make sure nothing rewrites it while discovery runs, ${rerun}.`;
  }
  if (code === REFUSAL_CODES.UNREADABLE) {
    return `Make ${shown} readable as a regular file (check permissions and that every parent component is a directory), ${rerun}.`;
  }
  if (code === REFUSAL_CODES.TOO_LARGE) {
    return `Reduce ${shown} to a declaration Concord can read without executing it (at most ${MAX_CONFIG_BYTES} bytes, ${MAX_NODES} values, ${MAX_DEPTH} levels of nesting), ${rerun}.`;
  }
  if (code === REFUSAL_CODES.UNSUPPORTED_SHAPE) {
    return `Rewrite ${shown} as a single top-level \`module.exports = { ... }\` object literal, ${rerun}.`;
  }
  return `Replace the dynamic expression in ${shown} with literal values (strings, numbers, booleans, null, arrays, objects) so Concord can read the declaration without executing it, ${rerun}. Discovery will not run adopter code to learn the repo map; if the file must stay dynamic, remove it from the scanned root and declare the repo map to the operator instead.`;
}

function messageFor(code, detail, position, shown) {
  const where = position ? ` at line ${position.line}, column ${position.column}` : "";
  if (
    code === REFUSAL_CODES.UNREADABLE
    || code === REFUSAL_CODES.UNTRUSTED_PATH
    || code === REFUSAL_CODES.TOO_LARGE
    || code === REFUSAL_CODES.PLATFORM_UNSUPPORTED
  ) {
    return `Refused to read ${shown}: ${detail}.`;
  }
  return `Refused to read ${shown} without executing it: found ${detail}${where}.`;
}

function refusalResult(code, detail, configPath, shown, position = null) {
  return {
    status: "refused",
    path: configPath,
    code,
    message: messageFor(code, detail, position, shown),
    remediation: remediationFor(code, shown),
    position,
  };
}

function errorCode(error) {
  return error && error.code ? error.code : "unknown error";
}

// COORD-657 F9/H3 — no silent downgrade.
//
// `O_NOFOLLOW` makes opening a symlink FAIL rather than follow it. `O_NONBLOCK`
// makes the open of a FIFO or a device node return immediately instead of
// blocking until a peer appears (F8/H2) — discovery must never hang on an entry
// an adopter controls.
//
// BOTH are REQUIRED. Where the platform cannot express either one, this FAILS
// CLOSED (`null`) and the caller refuses with `config_platform_unsupported`.
// An earlier revision fell back to a plain `"r"` open without O_NOFOLLOW, and a
// later one treated O_NONBLOCK as optional while the ADR claimed every open
// used it. Both were bypasses, and a disclosed bypass is still a bypass: a
// platform that cannot refuse a symlink, or cannot decline to block on a FIFO,
// cannot honour this boundary at all.
//
// O_DIRECTORY stays advisory — it narrows the directory-chain opens where the
// platform has it, but its absence is covered by the `fstat().isDirectory()`
// check on the handle, so it is not a constraint that can be silently lost.
function openFlags({ directory = false, constants = fs.constants } = {}) {
  constants = constants || {};
  if (
    typeof constants.O_RDONLY !== "number"
    || typeof constants.O_NOFOLLOW !== "number"
    || typeof constants.O_NONBLOCK !== "number"
  ) {
    return null;
  }
  let flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (directory && typeof constants.O_DIRECTORY === "number") flags |= constants.O_DIRECTORY;
  return flags;
}

function isInside(root, candidate) {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Every directory component from `root` (inclusive) down to `leafDir`
// (inclusive), in order.
function directoryChain(root, leafDir) {
  const chain = [root];
  if (leafDir === root) return chain;
  const relative = path.relative(root, leafDir);
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") continue;
    current = path.join(current, part);
    chain.push(current);
  }
  return chain;
}

function sameEntry(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read an adopter `project.config.js` as a static declaration.
 *
 * Never executes the file. Returns one of:
 *   { status: "absent",  path: null }
 *   { status: "declared", path, declared }
 *   { status: "refused",  path, code, message, remediation, position }
 *
 * `message`/`remediation` name the FILE and the operator's next step and never
 * quote file content — only the construct kind and its line/column.
 */
function readDeclaredConfig(configPath, deps = {}) {
  const io = deps.fs || fs;
  // Messages name the file by its DISPLAY path when the caller supplies one, so
  // an artifact carries the workspace-relative name rather than the operator's
  // absolute layout.
  const shown = deps.displayPath || configPath;

  // ---- Platform capability (COORD-657 H3) ---------------------------------
  // Fail closed rather than silently downgrading to a following open.
  const constants = deps.constants || fs.constants;
  const fileFlags = openFlags({ constants });
  if (fileFlags === null) {
    return refusalResult(
      REFUSAL_CODES.PLATFORM_UNSUPPORTED,
      "this platform cannot open a file both without following symbolic links and without blocking",
      configPath,
      shown
    );
  }

  // ---- Containment (COORD-657 F2 + H1) ------------------------------------
  // O_NOFOLLOW guards only the FINAL component. An adopter-controlled PARENT —
  // a `coord/` replaced by a symlink — is re-resolved by the kernel at open
  // time, so canonicalizing the parent and then opening the original path
  // string is the F3 check-then-act shape moved up one directory level.
  //
  // Node exposes no `openat`, no `O_PATH` and no directory file descriptor
  // (`fs.opendirSync` returns a Dir with no `fd`), so the opened object CANNOT
  // be bound to a directory handle in pure Node — see ADR-0011 "Residual risk".
  //
  // ORDERING (COORD-657 H4/H5/M6). The chain that is INSPECTED is the ORIGINAL
  // LEXICAL one, never a canonicalized one. An earlier revision called
  // `realpathSync` on the parent FIRST and then walked the result; because
  // `realpathSync` FOLLOWS symlinks, the adopter-controlled component was
  // resolved away before anything looked at it, so the symlink check could not
  // fire by construction and a dangling parent symlink surfaced as ENOENT —
  // i.e. as "absent". Canonicalization is now used ONLY for the containment
  // comparison, and only AFTER the lexical chain is proven symlink-free.
  //
  // Each component BELOW the scanned root is inspected with a no-follow lstat
  // and classified exactly:
  //   missing entirely            -> absent
  //   present but a symlink       -> config_untrusted_path (dangling or not)
  //   present but not a directory -> config_unreadable
  //   unreadable for any reason   -> config_unreadable
  // The scanned root itself is the operator-supplied trust anchor and is not
  // subject to the symlink refusal (a legitimately symlinked scan root must
  // still work); everything beneath it is adopter-controlled and is.
  // `inspectedDir` is the LEXICAL parent this reader verified component by
  // component. Everything downstream opens and re-checks THAT path, so the
  // thing inspected and the thing opened are the same name.
  let inspectedDir = null;
  let realDir = null;
  let chain = [];
  if (deps.containmentRoot) {
    const lexicalRoot = path.resolve(deps.containmentRoot);
    const lexicalDir = path.resolve(path.dirname(configPath));
    if (!isInside(lexicalRoot, lexicalDir)) {
      return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path lies outside the scanned workspace", configPath, shown);
    }

    for (const component of directoryChain(lexicalRoot, lexicalDir)) {
      if (component === lexicalRoot) continue;
      let entry = null;
      try {
        entry = io.lstatSync(component);
      } catch (error) {
        const code = errorCode(error);
        // Nothing is there at all — the only honest absence.
        if (code === "ENOENT") return { status: "absent", path: null };
        return refusalResult(REFUSAL_CODES.UNREADABLE, `a parent directory could not be inspected (${code})`, configPath, shown);
      }
      // Present but a symlink — dangling or not, it is refused, not followed.
      if (entry.isSymbolicLink()) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "a parent directory of the path is a symbolic link", configPath, shown);
      }
      // Present but not a directory (a regular file at `coord`, a FIFO, a
      // device node): unreadable, NOT a symlink claim.
      if (!entry.isDirectory()) {
        return refusalResult(REFUSAL_CODES.UNREADABLE, "a parent component of the path is not a directory", configPath, shown);
      }
      chain.push({ path: component, dev: entry.dev, ino: entry.ino });
    }

    // Only now — with every component below the root proven to be a real
    // directory — is canonicalization meaningful. It is a containment
    // cross-check, not the source of the chain and not the absence decision.
    let realRoot = null;
    try {
      realRoot = io.realpathSync(deps.containmentRoot);
    } catch (error) {
      return refusalResult(REFUSAL_CODES.UNREADABLE, `the scanned root could not be resolved (${errorCode(error)})`, configPath, shown);
    }
    try {
      realDir = io.realpathSync(lexicalDir);
    } catch (error) {
      return refusalResult(REFUSAL_CODES.UNREADABLE, `the path could not be resolved (${errorCode(error)})`, configPath, shown);
    }
    if (!isInside(realRoot, realDir)) {
      return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path resolves outside the scanned workspace", configPath, shown);
    }
    inspectedDir = lexicalDir;
  }

  // ---- One no-follow, non-blocking handle (F1 + F2 + F3 + H2) --------------
  // A check performed on a PATH and a read performed on the same PATH are two
  // different objects in the presence of a concurrent writer. Everything below
  // is bound to a single handle: open once with no-follow AND non-blocking
  // semantics (so a FIFO or device node cannot hang discovery), fstat THAT
  // handle, and bound the read by the bytes actually read.
  const openTarget = inspectedDir ? path.join(inspectedDir, path.basename(configPath)) : configPath;
  let fd = null;
  try {
    fd = io.openSync(openTarget, fileFlags);
  } catch (error) {
    const code = errorCode(error);
    // ENOENT from a no-follow open is the ONLY genuine absence. ENOTDIR,
    // EACCES, EIO, ELOOP, ENAMETOOLONG and EPERM are all anomalies about the
    // workspace and must be classified, never read as "no config here".
    if (code === "ENOENT") return { status: "absent", path: null };
    if (code === "ELOOP" || code === "EMLINK") {
      return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path is a symbolic link", configPath, shown);
    }
    return refusalResult(REFUSAL_CODES.UNREADABLE, `the path could not be opened (${code})`, configPath, shown);
  }

  let source = "";
  try {
    let handleStat = null;
    try {
      handleStat = io.fstatSync(fd);
    } catch (error) {
      return refusalResult(REFUSAL_CODES.UNREADABLE, `the open file could not be inspected (${errorCode(error)})`, configPath, shown);
    }
    if (handleStat.isSymbolicLink && handleStat.isSymbolicLink()) {
      return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path is a symbolic link", configPath, shown);
    }
    // A FIFO, socket, or device node reaches here because O_NONBLOCK let the
    // open return; it is refused before a single byte is read.
    if (!handleStat.isFile()) {
      return refusalResult(REFUSAL_CODES.UNREADABLE, "the path is not a regular file", configPath, shown);
    }

    // ---- Chain re-verification (COORD-657 H1) ------------------------------
    // The open re-resolved the path, so re-verify every directory component
    // against the identity recorded before the open. A parent swapped in that
    // window changes dev/ino here and is refused BEFORE any content is read.
    for (const recorded of chain) {
      let now = null;
      try {
        now = io.lstatSync(recorded.path);
      } catch (error) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, `a parent directory changed while the path was being opened (${errorCode(error)})`, configPath, shown);
      }
      if (now.isSymbolicLink()) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "a parent directory of the path is a symbolic link", configPath, shown);
      }
      if (!sameEntry(recorded, now)) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "a parent directory changed while the path was being opened", configPath, shown);
      }
    }

    // Identity binding: prove the handle we hold IS the contained entry, so an
    // entry swapped between canonicalization and open cannot be read.
    if (inspectedDir && typeof handleStat.ino === "number") {
      let entryStat = null;
      try {
        entryStat = io.lstatSync(path.join(inspectedDir, path.basename(configPath)));
      } catch (error) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, `the path changed while it was being read (${errorCode(error)})`, configPath, shown);
      }
      if (entryStat.isSymbolicLink()) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path is a symbolic link", configPath, shown);
      }
      if (entryStat.ino !== handleStat.ino || entryStat.dev !== handleStat.dev) {
        return refusalResult(REFUSAL_CODES.UNTRUSTED_PATH, "the path changed while it was being read", configPath, shown);
      }
    }

    // Bounded read against the BYTES ACTUALLY READ. The buffer is one byte
    // larger than the cap, so a file that grew after the fstat overflows it and
    // is refused rather than silently accepted.
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    try {
      while (total <= MAX_CONFIG_BYTES) {
        const read = io.readSync(fd, buffer, total, buffer.length - total, null);
        if (!read) break;
        total += read;
      }
    } catch (error) {
      return refusalResult(REFUSAL_CODES.UNREADABLE, `the file could not be read (${errorCode(error)})`, configPath, shown);
    }
    if (total > MAX_CONFIG_BYTES) {
      return refusalResult(REFUSAL_CODES.TOO_LARGE, `more than ${MAX_CONFIG_BYTES} bytes`, configPath, shown);
    }
    source = buffer.subarray(0, total).toString("utf8");
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      /* the handle is already gone; nothing is owed */
    }
  }

  try {
    const declared = createParser(tokenize(source)).parseProgram();
    return { status: "declared", path: configPath, declared };
  } catch (error) {
    const code = error instanceof DeclarationRefusal ? error.code : REFUSAL_CODES.NOT_DECLARATIVE;
    const detail = error instanceof DeclarationRefusal ? error.detail : "an unparsable declaration";
    const position = error instanceof DeclarationRefusal ? error.position : null;
    return {
      status: "refused",
      path: configPath,
      code,
      message: messageFor(code, detail, position, shown),
      remediation: remediationFor(code, shown),
      position,
    };
  }
}

module.exports = {
  MAX_CONFIG_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  REFUSAL_CODES,
  openFlags,
  readDeclaredConfig,
};
