"use strict";

// COORD-924: the module graph behind affected-test selection (ADR 0021).
//
// Nodes are tracked files. An edge A -> B means "A may load or run B":
//   - static: require("./b"), import ... from "./b", import("./b");
//   - shim registry resolution: resolveEngineModule(dir, "scripts/b.js") and
//     "engine-only:scripts/b.js" resolve to coord/engine/<path> and, for the
//     plain form, the legacy coord/<path> too;
//   - mentions: a path or file-name token in a JS or shell file's code or
//     strings (comments stripped) that names a tracked file. This covers
//     path.join(__dirname, "b.js"), spawned scripts, fixtures and data files,
//     and constants later passed to a dynamic require. It over-approximates,
//     which only ever selects more.
// A dynamic load whose target the graph cannot name (require(x) where nothing
// in the file names a loadable file) is recorded as an unknown dynamic site.
// JSON and Markdown files are leaves: listing a path is not loading it. A code
// file under __fixtures__/ keeps its static requires but not its mentions: the
// paths it names are test data (for example the historical cases of the
// selection fault suite), not files it runs.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stripComments } = require("./comment-lexer.js");
const { toPosix } = require("./lifecycle-utils.js");
const { addCliVerbNodes } = require("./affected-cli-verbs.js");
const COMMAND_ROWS = require("./command-declaration.js").ROWS;

const CODE_FILE = /\.(?:c|m)?js$/;
const SHELL_FILE = /\.sh$/;
const STATIC_SPEC = /\brequire\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
const ENGINE_SPEC = /\bresolveEngineModule\s*\([^"'`()]*(?:\([^()]*\)[^"'`()]*)*["'`]((?:engine-only:)?[^"'`$]+)["'`]\s*\)/g;
const DYNAMIC_CALL = /\b(?:require|import)\s*\(\s*(?!["'`]|resolveEngineModule\b|\))/g;
const SPAWN_CALL = /\bspawn(?:Sync)?\s*\([^;]*/g;
// COORD-953: a spawn whose script path is computed loads a target the graph cannot name: an
// unresolved dynamic site. (A shim call with a computed spec is handled in dynamicSites.)
const DYNAMIC_SPAWN = /\bspawn(?:Sync)?\s*\([^;]*?\bpath\.join\(\s*__dirname\s*,\s*(?!\s*["'`])/g;
const PATH_TOKEN = /[A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@.-]+)+|[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.(?:(?:c|m)?js|json|sh|md|ya?ml|txt|tap|info)\b/g;
const RESOLVE_SUFFIXES = Object.freeze(["", ".js", ".cjs", ".mjs", ".json", "/index.js"]);
// COORD-966: a literal argument is a plain string (no interpolation, no escapes). A call whose
// spec argument is a literal names its target, so it is a static edge, not an unresolved site.
const LITERAL_ARG = /^(["'`])([^"'`$\\\r\n]*)\1$/;
const ENGINE_CALL = /\bresolveEngineModule\s*\(/g;
const ENGINE_EXPR = /^(?:require\(\s*["'`][^"'`]+["'`]\s*\)\s*\.)?resolveEngineModule\s*\(/;
const CALL_OPEN = /\b(?:require|import)\s*\(/g;
const JOIN_CALL = /^(?:[A-Za-z_$][\w$]*|require\(\s*["'`]node:path["'`]\s*\))\.(?:join|resolve)\s*\(/;
// COORD-966 (human-admin decision 2026-11-13): the template TEXT that renders a generated JS shim
// is not code this file runs. Only dynamic sites inside the named function's template text are
// exempt; every other site in the file stays unresolved (pinned by affected-graph.test.js).
const TEXT_EXEMPTIONS = Object.freeze([
  { file: "coord/paths.js", function: "renderShimSource",
    reason: "renders the source of a generated JS shim; the template text names the shim's own engine target, and the generated shim states that target as a literal (byte-identity pinned by affected-graph.test.js)" },
  { file: "coord/paths.js", function: "renderFailClosedShimSource",
    reason: "renders the fail-closed JS shim source; the template text names the shim's own engine target, and the generated shim states that target as a literal (byte-identity pinned by affected-graph.test.js)" },
]);

function git(root, args, input) {
  const r = spawnSync("git", args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr || "").trim()}`);
  return r.stdout;
}

function listFiles(root, ref) {
  const out = ref ? git(root, ["ls-tree", "-r", "--name-only", "-z", ref]) : git(root, ["ls-files", "-z"]);
  return out.toString("utf8").split("\0").filter(Boolean).sort();
}

function wantsText(rel) { return CODE_FILE.test(rel) || SHELL_FILE.test(rel); }

// Contents of every code and shell file at `ref` (one git cat-file --batch),
// or in the working tree when ref is null.
function readSources(root, ref, files) {
  const wanted = files.filter(wantsText);
  const sources = new Map();
  if (!ref) {
    for (const rel of wanted) {
      try {
        sources.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
      } catch {
        sources.set(rel, null);
      }
    }
    return sources;
  }
  const buf = git(root, ["cat-file", "--batch"], wanted.map((rel) => `${ref}:${rel}`).join("\n") + "\n");
  let offset = 0;
  for (const rel of wanted) {
    const nl = buf.indexOf(10, offset);
    const header = buf.subarray(offset, nl).toString("utf8").split(" ");
    const size = Number(header[2]);
    offset = nl + 1;
    if (header[1] === "missing" || !Number.isFinite(size)) {
      sources.set(rel, null);
      continue;
    }
    sources.set(rel, buf.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return sources;
}

function createIndex(files) {
  const set = new Set(files);
  const byBase = new Map();
  for (const rel of files) {
    const base = path.posix.basename(rel);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  }
  return { set, byBase };
}

function resolveRelative(index, fromFile, spec) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return RESOLVE_SUFFIXES.map((s) => joined + s).filter((c) => index.set.has(c));
}

function resolveEngineSpec(index, spec) {
  const engineOnly = spec.startsWith("engine-only:");
  const rel = engineOnly ? spec.slice("engine-only:".length) : spec;
  const candidates = engineOnly ? [`coord/engine/${rel}`] : [`coord/engine/${rel}`, `coord/${rel}`];
  return candidates.filter((c) => index.set.has(c));
}

// A token with a slash names files whose path ends with it; a bare file name
// names every tracked file with that base name.
function resolveMention(index, token, fromFile) {
  if (/^\.\.?\//.test(token)) return resolveRelative(index, fromFile, token).filter((f) => f !== fromFile);
  const clean = token.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return [];
  if (!clean.includes("/")) return (index.byBase.get(clean) || []).filter((f) => f !== fromFile);
  const suffix = (index.byBase.get(path.posix.basename(clean)) || []).filter((f) => f === clean || f.endsWith(`/${clean}`));
  return suffix.filter((f) => f !== fromFile);
}

function lineOf(text, offset) { return text.slice(0, offset).split("\n").length; }

// Per-character classes of a JS source: 0 code, 1 string literal or template delimiter, 2 template
// TEXT (not an interpolated ${...} expression). Nested templates are tracked with a frame stack.
function maskCode(code) {
  const mask = new Uint8Array(code.length);
  const frames = [{ kind: "code", braces: 0 }];
  for (let i = 0; i < code.length; i++) {
    const top = frames[frames.length - 1];
    const ch = code[i];
    if (top.kind === "tpl") {
      if (ch === "\\") { mask[i] = 2; if (i + 1 < code.length) mask[i + 1] = 2; i++; continue; }
      if (ch === "`") { mask[i] = 1; frames.pop(); continue; }
      if (ch === "$" && code[i + 1] === "{") { mask[i] = 1; mask[i + 1] = 1; frames.push({ kind: "code", braces: 0, expr: true }); i++; continue; }
      mask[i] = 2;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
      for (let k = i; k <= Math.min(j, code.length - 1); k++) mask[k] = 1;
      i = j;
      continue;
    }
    if (ch === "`") { mask[i] = 1; frames.push({ kind: "tpl" }); continue; }
    if (ch === "{") top.braces++;
    else if (ch === "}") {
      if (top.braces > 0) top.braces--;
      else if (top.expr) { mask[i] = 1; frames.pop(); }
    }
  }
  return mask;
}

// The [open, close] offsets of `function <name>(...) { ... }`, or null when it is not found.
function functionBodyRange(code, mask, name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code);
  if (!m) return null;
  const params = splitArgs(code, m.index + m[0].length - 1);
  if (!params) return null;
  const open = code.indexOf("{", params.end);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (mask[i] !== 0) continue;
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return null;
}

// Whether a dynamic site at `offset` is exempt: it is template text inside an exempt function.
function exemptSite(rel, code, exemptions) {
  const mine = exemptions.filter((e) => e.file === rel);
  if (!mine.length) return () => false;
  const mask = maskCode(code);
  const ranges = mine.map((e) => functionBodyRange(code, mask, e.function)).filter(Boolean);
  return (offset) => mask[offset] === 2 && ranges.some(([a, b]) => offset > a && offset < b);
}

function literalValue(text) {
  const m = LITERAL_ARG.exec(String(text).trim());
  return m ? m[2] : null;
}

// Skips the string or template literal that opens at `i`; returns its closing index, or -1
// when it cannot be read (an interpolated template is never parsed).
function skipString(code, i) {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j++) {
    const ch = code[j];
    if (ch === "\\") { j++; continue; }
    if (quote === "`" && ch === "$" && code[j + 1] === "{") return -1;
    if (ch === quote) return j;
  }
  return -1;
}

// The top-level arguments of the call whose "(" is at `open`. Null when the text does not
// parse, and the caller then treats the call as unresolved (fail closed).
function splitArgs(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      const end = skipString(code, i);
      if (end < 0) return null;
      i = end;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const last = code.slice(start, i).trim();
        if (last || args.length) args.push(last);
        return { args, end: i };
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

// Every resolveEngineModule(root, spec) call (a declaration is not a call). `spec` is the
// literal second argument, or null when it is computed or the call does not parse.
function engineCalls(code) {
  const out = [];
  for (const m of code.matchAll(ENGINE_CALL)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const parsed = splitArgs(code, m.index + m[0].length - 1);
    const spec = parsed && parsed.args.length >= 2 ? literalValue(parsed.args[1]) : null;
    out.push({ index: m.index, spec, parsed });
  }
  return out;
}

// path.join / path.resolve over __dirname and literal segments, starting at `start` in `text`:
// the file-relative path, or null when any segment is computed or absolute.
function staticJoinAt(text, start) {
  const m = JOIN_CALL.exec(text.slice(start));
  if (!m) return null;
  const parsed = splitArgs(text, start + m[0].length - 1);
  if (!parsed || parsed.args[0] !== "__dirname") return null;
  const parts = parsed.args.slice(1).map(literalValue);
  if (parts.some((p) => p === null || p.startsWith("/"))) return null;
  return { value: path.posix.join(...parts), end: parsed.end };
}

// require(x) whose whole argument is a literal path.join(__dirname, ...) or a shim call with
// a literal spec: the load is resolved statically.
function isResolvedRequireArg(arg) {
  const join = staticJoinAt(arg, 0);
  if (join) return join.end === arg.length - 1;
  const m = ENGINE_EXPR.exec(arg);
  if (!m) return false;
  const parsed = splitArgs(arg, m[0].length - 1);
  return Boolean(parsed && parsed.args.length >= 2 && literalValue(parsed.args[1]) !== null &&
    arg.slice(parsed.end + 1).trim() === "");
}

function staticTargets(index, rel, code) {
  const out = new Set();
  for (const m of code.matchAll(STATIC_SPEC)) {
    const spec = m[1] || m[2] || m[3];
    if (spec.startsWith(".")) for (const t of resolveRelative(index, rel, spec)) out.add(t);
  }
  for (const m of code.matchAll(ENGINE_SPEC)) for (const t of resolveEngineSpec(index, m[1])) out.add(t);
  for (const call of engineCalls(code)) if (call.spec !== null) for (const t of resolveEngineSpec(index, call.spec)) out.add(t);
  for (const m of code.matchAll(CALL_OPEN)) {
    const parsed = splitArgs(code, m.index + m[0].length - 1);
    if (!parsed || parsed.args.length !== 1) continue;
    const join = staticJoinAt(parsed.args[0], 0);
    if (join && join.end === parsed.args[0].length - 1) {
      for (const t of resolveRelative(index, rel, join.value)) out.add(t);
    }
  }
  return out;
}

function mentionTargets(index, rel, code) {
  const out = new Set();
  for (const m of code.matchAll(PATH_TOKEN)) for (const t of resolveMention(index, m[0], rel)) out.add(t);
  return out;
}

// A dynamic require(x) is known when the file names some loadable code file
// (the constant or path.join behind x); otherwise its target is unknown.
function dynamicSites(rel, code, mentioned, exempt) {
  const loadable = [...mentioned].some((t) => CODE_FILE.test(t));
  const sites = [];
  for (const m of code.matchAll(DYNAMIC_CALL)) {
    if (exempt(m.index)) continue;
    const open = code.indexOf("(", m.index);
    const parsed = splitArgs(code, open);
    // COORD-966: a literal path.join(__dirname, ...) or a literal shim spec is a static edge.
    if (parsed && parsed.args.length === 1 && isResolvedRequireArg(parsed.args[0])) continue;
    const arg = code.slice(m.index + m[0].length, m.index + m[0].length + 60).split("\n")[0];
    const config = /config/i.test(arg);
    sites.push({ file: rel, line: lineOf(code, m.index), argument: arg.trim(), known: loadable || config, config });
  }
  // A shim call with a computed spec (COORD-953); the literal-spec calls are static edges.
  for (const call of engineCalls(code)) {
    if (call.spec !== null || exempt(call.index)) continue;
    // computed: widens the selection only; it does not trigger the same-directory full fallback
    sites.push({ file: rel, line: lineOf(code, call.index), argument: code.slice(call.index, call.index + 60).trim(), known: false, config: false, computed: true });
  }
  for (const m of code.matchAll(DYNAMIC_SPAWN)) {
    // COORD-966: a spawn whose script path is path.join(__dirname, literals...) is static.
    const pj = m.index + m[0].lastIndexOf("path.join(");
    if (staticJoinAt(code, pj) !== null || exempt(m.index)) continue;
    sites.push({ file: rel, line: lineOf(code, m.index), argument: m[0].slice(0, 60).trim(), known: false, config: false, computed: true });
  }
  return sites;
}

function extractEdges(index, rel, text, exemptions = TEXT_EXEMPTIONS) {
  const code = CODE_FILE.test(rel) ? stripComments(text) : text.replace(/^\s*#.*$/gm, "");
  const targets = CODE_FILE.test(rel) ? staticTargets(index, rel, code) : new Set();
  const mentioned = /(?:^|\/)__fixtures__\//.test(rel) ? new Set() : mentionTargets(index, rel, code);
  for (const t of mentioned) targets.add(t);
  const dynamic = CODE_FILE.test(rel) ? dynamicSites(rel, code, mentioned, exemptSite(rel, code, exemptions)) : [];
  // Loads: edges whose target the file runs (not merely reads). A spawned script runs too.
  const loads = CODE_FILE.test(rel) ? staticTargets(index, rel, code) : new Set();
  if (CODE_FILE.test(rel)) for (const m of code.matchAll(SPAWN_CALL)) for (const t of mentionTargets(index, rel, m[0])) loads.add(t);
  return { targets, loads, dynamic };
}

// Build the graph at `ref` (null = working tree). `unreadable` lists code
// files whose content could not be read: analysis over them is incomplete.
function buildGraph({ root, ref = null, files = null, sources = null, cliRows = COMMAND_ROWS }) {
  const all = files || listFiles(root, ref);
  const texts = sources || readSources(root, ref, all);
  const index = createIndex(all);
  const edges = new Map();
  const loadEdges = new Map();
  const reverse = new Map();
  const dynamic = [];
  const unreadable = [];
  for (const rel of all) {
    edges.set(rel, new Set());
    loadEdges.set(rel, new Set());
    if (!reverse.has(rel)) reverse.set(rel, new Set());
  }
  for (const [rel, text] of texts) {
    if (text === null) {
      unreadable.push(rel);
      continue;
    }
    const result = extractEdges(index, rel, text);
    edges.set(rel, result.targets);
    loadEdges.set(rel, result.loads);
    for (const t of result.targets) reverse.get(t).add(rel);
    dynamic.push(...result.dynamic);
  }
  // COORD-1031 (d): CLI-verb pseudo nodes (cli-verb:<handler>) link suites that spawn the CLI to the
  // modules each verb's route reaches. They are not files and never suites.
  const graph = { files: all, index, edges, loadEdges, reverse, dynamic, unreadable };
  addCliVerbNodes(graph, { texts, targetsOf: (rel, code) => staticTargets(index, rel, code), rows: cliRows });
  return graph;
}

// Every file that can reach one of `starts` (inclusive). Above a changed file,
// every reader is affected. Above a suite that is not a start, only the files that
// LOAD it (run its code, through a require, import or spawn) are affected: a file
// that only mentions it reads its text, which is unchanged. COORD-953: this walk
// used to stop at every suite, which omitted a suite that loads another suite.
function dependentsOf(graph, starts) {
  const seen = new Set();
  const queue = [...starts].filter((s) => graph.reverse.has(s));
  for (const s of queue) seen.add(s);
  while (queue.length) {
    const next = queue.pop();
    const suiteAbove = next.endsWith(".test.js") && !starts.includes(next);
    for (const dep of graph.reverse.get(next)) {
      if (suiteAbove && !(graph.loadEdges.get(dep) || new Set()).has(next)) continue;
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

module.exports = {
  toPosix, listFiles, readSources, createIndex, resolveRelative, resolveEngineSpec, resolveMention,
  extractEdges, buildGraph, dependentsOf, TEXT_EXEMPTIONS, maskCode, functionBodyRange,
};
