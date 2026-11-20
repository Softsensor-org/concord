"use strict";

// COORD-1031 (d): CLI-verb-to-module edges for affected-test selection.
//
// A suite that reaches the engine only by spawning the CLI (`gov <verb>`) does not require the
// modules a verb's handler uses, so a static require walk never connects it to them. This module
// derives that link from the source, not from a list:
//   - each route in cli.js's route tables (`  "<handler>": (command, args) => ...`) is an arm;
//     an arm reaches the modules its body requires, and the top-level declarations of cli.js it
//     names, transitively (a name is a declaration of cli.js or a require binding);
//   - every arm also reaches cli.js itself (the dispatcher can change any verb), so an arm the
//     parser cannot find falls back to cli.js alone and is never dropped;
//   - a suite that names the CLI (governance.js, cli.js, scripts/gov, runFixtureGovernance) and
//     a verb spelling as a literal reaches that verb's arm.
// The arm is a pseudo node `cli-verb:<handler>` in the graph. It is never a suite and never a file
// on disk; affected-graph.js adds it after the static edges are built.

const { stripComments } = require("./comment-lexer.js");

const CLI_REL = "coord/engine/scripts/cli.js";
const PREFIX = "cli-verb:";
const ARM = /^  "([^"]+)": /;
const TOP = /^\S/;
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s/;
const CLI_CALLER = /governance\.js|\/cli\.js|scripts\/gov\b|runFixtureGovernance/;
const IDENT = /[A-Za-z_$][\w$]*/g;

const nodeOf = (handler) => `${PREFIX}${handler}`;

// Top-level declarations of cli.js, by name: the text from the declaration line to the next
// top-level line. Destructured requires name each binding.
function topLevelChunks(code) {
  const lines = code.split("\n");
  const starts = [];
  lines.forEach((line, i) => { if (TOP.test(line) && DECL.test(line)) starts.push(i); });
  const chunks = new Map();
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const text = lines.slice(start, end).join("\n");
    const head = lines[start];
    const fn = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(head);
    const single = /^(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(head);
    const destructured = /^(?:const|let|var)\s+\{([^}]*)\}/.exec(head);
    const names = [];
    if (fn) names.push(fn[1]);
    if (single) names.push(single[1]);
    if (destructured) for (const part of destructured[1].split(",")) {
      const name = part.split(":").pop().trim().split("=")[0].trim();
      if (name) names.push(name);
    }
    for (const name of names) chunks.set(name, text);
  });
  return chunks;
}

// Route arms of cli.js by handler key. An arm runs from its key line to the next key or the next
// top-level line.
function routeArms(code) {
  const lines = code.split("\n");
  const arms = new Map();
  let current = null;
  for (const line of lines) {
    const m = ARM.exec(line);
    if (m) { current = m[1]; if (!arms.has(current)) arms.set(current, []); arms.get(current).push(line); continue; }
    if (TOP.test(line)) { current = null; continue; }
    if (current) arms.get(current).push(line);
  }
  return new Map([...arms].map(([key, body]) => [key, body.join("\n")]));
}

// The verb handlers an arm reaches within cli.js: the arm body, then the top-level declarations it
// names, transitively. Returns the arm text plus the declaration texts it reaches.
function reachedCliText(arm, chunks) {
  const seen = new Set();
  const texts = [arm];
  const queue = [...new Set(arm.match(IDENT) || [])];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name) || !chunks.has(name)) continue;
    seen.add(name);
    const text = chunks.get(name);
    texts.push(text);
    for (const id of text.match(IDENT) || []) if (!seen.has(id)) queue.push(id);
  }
  return texts;
}

// Adds one pseudo node per handler to `graph`. `texts` maps each tracked file to its source
// (null when unreadable). `targetsOf(rel, text)` returns the static targets of a source (the same
// resolution the graph uses). `rows` is command-declaration.js ROWS.
function addCliVerbNodes(graph, { texts, targetsOf, rows }) {
  const cliText = texts.get(CLI_REL);
  if (typeof cliText !== "string") return graph;
  const code = stripComments(cliText);
  const arms = routeArms(code);
  const chunks = topLevelChunks(code);
  const handlerOf = new Map(rows.map((row) => [row.spelling, row.handler]));
  const handlers = [...new Set(rows.map((row) => row.handler))];
  for (const handler of handlers) {
    const node = nodeOf(handler);
    const arm = arms.get(handler);
    const targets = new Set([CLI_REL]);
    if (arm === undefined) {
      // Unparsed arm: cli.js itself is the sound fallback.
    } else {
      for (const text of reachedCliText(arm, chunks)) for (const t of targetsOf(CLI_REL, text)) targets.add(t);
    }
    graph.edges.set(node, new Set(targets));
    graph.loadEdges.set(node, new Set(targets));
    if (!graph.reverse.has(node)) graph.reverse.set(node, new Set());
    for (const t of targets) {
      if (!graph.reverse.has(t)) graph.reverse.set(t, new Set());
      graph.reverse.get(t).add(node);
    }
  }
  for (const [rel, text] of texts) {
    if (!rel.endsWith(".test.js") || typeof text !== "string" || !CLI_CALLER.test(text)) continue;
    const code2 = stripComments(text);
    for (const [spelling, handler] of handlerOf) {
      const literal = new RegExp(`(["'\`])${spelling.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\1`);
      if (!literal.test(code2)) continue;
      const node = nodeOf(handler);
      graph.edges.get(rel).add(node);
      graph.loadEdges.get(rel).add(node);
      graph.reverse.get(node).add(rel);
    }
  }
  return graph;
}

module.exports = { addCliVerbNodes, routeArms, topLevelChunks, reachedCliText, nodeOf, CLI_REL, PREFIX };
