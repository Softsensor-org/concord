"use strict";

const parser = require("../vendor/babel-parser");

// Static recognition only: never evaluate the dependency bundle or its values.
function pureDependencyProperty(node) {
  if (node.type !== "ObjectProperty" || node.computed || node.method || node.key.type !== "Identifier") return false;
  const value = node.value;
  if (value.type === "Identifier") return true;
  if (value.type === "MemberExpression") {
    return !value.computed && value.object.type === "Identifier" && value.property.type === "Identifier";
  }
  if (value.type !== "ArrowFunctionExpression" || value.async || value.params.length !== 1) return false;
  const param = value.params[0];
  const body = value.body;
  return param.type === "RestElement" && param.argument.type === "Identifier" &&
    body.type === "CallExpression" && !body.optional && body.callee.type === "Identifier" &&
    body.callee.name === node.key.name && body.arguments.length === 1 &&
    body.arguments[0].type === "SpreadElement" && body.arguments[0].argument.type === "Identifier" &&
    body.arguments[0].argument.name === param.argument.name;
}

function dependencyBundleWiringLines(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 1000000) return new Set();
  let ast;
  try { ast = parser.parse(source, { sourceType: "unambiguous" }); }
  catch { return new Set(); }
  const entries = [];
  const parents = new Map();
  const pending = [{ node: ast, parent: null }];
  while (pending.length) {
    if (entries.length > 100000) return new Set();
    const entry = pending.pop();
    entries.push(entry);
    parents.set(entry.node, entry.parent);
    for (const value of Object.values(entry.node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") pending.push({ node: child, parent: entry.node });
      } else if (value && typeof value.type === "string") pending.push({ node: value, parent: entry.node });
    }
  }
  const intervals = [];
  let referenceBudget = 1000000;
  for (const { node, parent } of entries) {
    if (node.type !== "VariableDeclarator" || parent.type !== "VariableDeclaration" || parent.kind !== "const" ||
      parent.declarations.length !== 1 || node.id.type !== "Identifier" || node.init?.type !== "ObjectExpression" ||
      !node.init.properties.every(pureDependencyProperty)) continue;
    const name = node.id.name;
    const spreads = [];
    let safe = true;
    for (const entry of entries) {
      if (--referenceBudget < 0) return new Set();
      const ref = entry.node;
      const holder = entry.parent;
      if (ref.type !== "Identifier" || ref.name !== name || ref === node.id) continue;
      // A noncomputed property name is not a reference to the local binding.
      if ((holder?.type === "ObjectProperty" || holder?.type === "ObjectMethod") && holder.key === ref && !holder.computed && !holder.shorthand) continue;
      if (holder?.type === "MemberExpression" && holder.property === ref && !holder.computed) continue;
      if (holder?.type === "SpreadElement" && holder.argument === ref) {
        const container = parents.get(holder);
        const call = parents.get(container);
        if (container?.type === "ObjectExpression" && call?.type === "CallExpression" && !call.optional &&
          call.callee.type === "Identifier" && /^create[A-Z][A-Za-z0-9_$]*$/.test(call.callee.name) &&
          call.arguments.includes(container)) { spreads.push(holder); continue; }
      }
      // This also refuses shadowing, mutation, aliasing and function-call escapes.
      safe = false;
      break;
    }
    if (safe && spreads.length > 0) intervals.push(parent, ...spreads);
  }
  const masked = source.split("");
  for (const node of intervals) {
    for (let i = node.start; i < node.end; i += 1) if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
  }
  const original = source.split("\n");
  const remainder = masked.join("").split("\n");
  const allowed = new Set();
  for (let i = 0; i < remainder.length; i += 1) {
    if (original[i] !== remainder[i] && /^[\s,;]*$/.test(remainder[i])) allowed.add(i + 1);
  }
  return allowed;
}

module.exports = { dependencyBundleWiringLines };
