"use strict";

// COORD-989 (ARCH-AUDIT-2026-11-13 F-14): the engine must not regrow the require
// cycles below. The scan is a small lexer over every engine module: comments and
// string literals are skipped, and only the literal argument of a require('...')
// call is read, so prose that mentions require() cannot create an edge. Lazy
// requires (inside a function body) count, because they are real cycles at runtime.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = __dirname;
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

// Returns [{ spec, lazy }] for every require('<literal>') in one module's source.
function requireCalls(source) {
  const calls = [];
  const parenHeads = [];
  let lastParenHead = null;
  let lastWord = "";
  let prevSignificant = "";
  let pendingFunction = false;
  let depth = 0;
  const functionDepths = [];
  const isIdentifier = (ch) => /[A-Za-z0-9_$]/.test(ch || "");
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      i = j + 1;
      prevSignificant = "s";
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let interpolation = 0;
      while (j < source.length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (interpolation === 0 && source[j] === "`") break;
        if (source[j] === "$" && source[j + 1] === "{") { interpolation += 1; j += 2; continue; }
        if (interpolation > 0 && source[j] === "}") interpolation -= 1;
        j += 1;
      }
      i = j + 1;
      prevSignificant = "s";
      continue;
    }
    if (isIdentifier(ch)) {
      let j = i;
      while (j < source.length && isIdentifier(source[j])) j += 1;
      const word = source.slice(i, j);
      if (word === "require" && source[i - 1] !== "." && !isIdentifier(source[i - 1])) {
        let k = j;
        while (/\s/.test(source[k] || "")) k += 1;
        if (source[k] === "(") {
          k += 1;
          while (/\s/.test(source[k] || "")) k += 1;
          const quote = source[k];
          if (quote === "'" || quote === '"' || quote === "`") {
            let end = k + 1;
            while (end < source.length && source[end] !== quote) end += 1;
            calls.push({ spec: source.slice(k + 1, end), lazy: functionDepths.length > 0 });
          }
        }
      }
      if (word === "function") pendingFunction = true;
      lastWord = word;
      prevSignificant = "w";
      i = j;
      continue;
    }
    if (ch === "(") {
      parenHeads.push(prevSignificant === "w" ? lastWord : "");
      prevSignificant = "(";
    } else if (ch === ")") {
      lastParenHead = parenHeads.pop();
      prevSignificant = ")";
    } else if (ch === "=" && source[i + 1] === ">") {
      pendingFunction = true;
      i += 2;
      prevSignificant = "=>";
      continue;
    } else if (ch === "{") {
      depth += 1;
      // Function bodies: `function`, arrows, and method shorthand `name(...) {`.
      const method = prevSignificant === ")" && lastParenHead !== undefined && !CONTROL_KEYWORDS.has(lastParenHead);
      if (pendingFunction || method) functionDepths.push(depth);
      pendingFunction = false;
      prevSignificant = "{";
    } else if (ch === "}") {
      if (functionDepths.length && functionDepths[functionDepths.length - 1] === depth) functionDepths.pop();
      depth -= 1;
      prevSignificant = "}";
    } else if (ch === ";") {
      pendingFunction = false;
      prevSignificant = ";";
    } else if (!/\s/.test(ch)) {
      prevSignificant = ch;
    }
    i += 1;
  }
  return calls;
}

function engineGraph() {
  const modules = fs.readdirSync(SCRIPTS_DIR).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"));
  const known = new Set(modules);
  const graph = new Map();
  for (const name of modules) {
    const edges = new Set();
    for (const { spec } of requireCalls(fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec)).replace(/\.js$/, "") + ".js";
      if (known.has(target)) edges.add(target);
    }
    graph.set(name, edges);
  }
  return graph;
}

// Tarjan's strongly connected components; returns only the components with a cycle.
function cyclicComponents(graph) {
  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const components = [];
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) || []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return components;
}

const NAMED_MODULES = [
  "affected-state.js",
  "affected-landing.js",
  "test-policy.js",
  "cli.js",
  "cli-surface.js",
];

test("COORD-989: the affected-state / affected-landing / test-policy and cli / cli-surface cycles stay broken", () => {
  const cycles = cyclicComponents(engineGraph());
  for (const name of NAMED_MODULES) {
    const component = cycles.find((members) => members.includes(name));
    assert.equal(component, undefined, `${name} is in a require cycle: ${component && component.join(" -> ")}`);
  }
});

test("COORD-989: no lazy upward require of lifecycle.js from command-registry or context-pack-ack-commands", () => {
  for (const name of ["command-registry.js", "context-pack-ack-commands.js"]) {
    const specs = requireCalls(fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8")).map((call) => call.spec);
    assert.ok(!specs.some((spec) => /(^|\/)lifecycle\.js$/.test(spec)), `${name} requires lifecycle.js; inject the callback from cli.js instead`);
  }
});

test("COORD-989: the injected-dependency edges are not re-introduced", () => {
  const forbidden = [
    ["affected-state.js", "affected-landing.js"],
    ["test-policy.js", "affected-landing.js"],
    ["cli-surface.js", "cli.js"],
  ];
  for (const [from, to] of forbidden) {
    const specs = requireCalls(fs.readFileSync(path.join(SCRIPTS_DIR, from), "utf8")).map((call) => call.spec);
    assert.ok(!specs.some((spec) => path.posix.basename(spec) === to), `${from} requires ${to}; this edge closes a cycle`);
  }
});

test("COORD-989: the cycle scanner ignores string literals, comments and property access", () => {
  const source = [
    "// require('./cli.js') in a comment",
    "const text = \"require('./cli.js')\";",
    "const tpl = `require('./cli.js')`;",
    "const obj = other.require('./cli.js');",
    "/* require('./cli.js') */",
  ].join("\n");
  assert.deepEqual(requireCalls(source), []);
  const real = requireCalls("function f() { return require('./cli.js'); }\nconst top = require('./top.js');");
  assert.deepEqual(real, [{ spec: "./cli.js", lazy: true }, { spec: "./top.js", lazy: false }]);
});
