"use strict";

// Static syntax inventory for JavaScript, TypeScript, JSX and TSX. The parser
// consumes source text only; it never imports, evaluates, or executes adopter
// code. Findings are candidate evidence, not confirmed business behavior.
const babelParser = require("../vendor/babel-parser");

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const WORKFLOW_METHODS = new Set(["schedule", "scheduleJob", "process", "add", "repeat", "define", "every"]);
// `add` is also a collection method, so it counts only on a proven queue binding.
const UNPROVEN_WORKFLOW_METHODS = new Set(["schedule", "scheduleJob", "process", "repeat", "define", "every"]);
// Packages whose import proves a scheduler or queue binding. Anything else is unknown.
const SCHEDULER_MODULES = new Set(["node-cron", "node-schedule", "cron", "agenda", "bull", "bullmq", "bee-queue"]);
const SCHEDULER_NAME = /(?:cron|schedule|scheduler|agenda|queue|worker|job)/i;

function propertyName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return null;
}

function memberParts(node) {
  if (!node || node.type !== "MemberExpression" || node.computed) return null;
  return { object: node.object, property: propertyName(node.property) };
}

// A string literal or a template literal with no expressions, else null.
function staticString(node) {
  if (node?.type === "StringLiteral") return node.value;
  return node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
}

function literalPaths(node) {
  const text = staticString(node);
  if (text !== null) return [text];
  if (node?.type === "ArrayExpression") {
    return node.elements.map((element) => element?.type === "StringLiteral" ? element.value : null);
  }
  return null;
}

function callMethod(node) {
  if (node?.type !== "CallExpression") return null;
  return memberParts(node.callee);
}

function identifier(node) {
  return node?.type === "Identifier" ? node.name : null;
}

function normalizeJoinedPath(prefix, local) {
  if (!prefix) return local || "/";
  if (!local || local === "/") return prefix;
  const left = String(prefix).replace(/\/+$/, "");
  const right = String(local).replace(/^\/+/, "");
  return `${left}/${right}`;
}

function componentName(node) {
  const parts = [];
  while (node?.type === "JSXMemberExpression") {
    // Babel's JSX member property is always a JSXIdentifier; the object may be another member.
    parts.push(node.property.name);
    node = node.object;
  }
  if (node?.type !== "JSXIdentifier") return null;
  parts.push(node.name);
  return parts.reverse().join(".");
}

function isComponentName(name) {
  return typeof name === "string" && /[A-Z]/.test(name[0]);
}

function childNodes(node, excluded = new Set(["loc", "start", "end", "extra", "comments", "tokens"])) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (excluded.has(key)) continue;
    if (Array.isArray(value)) children.push(...value.filter((child) => child && typeof child === "object"));
    else if (value && typeof value === "object") children.push(value);
  }
  return children;
}

const GUARD_TYPES = new Set(["IfStatement", "ConditionalExpression", "LogicalExpression", "SwitchStatement", "TryStatement",
  "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

// Preorder node list beneath a root, computed once and shared by every pass
// over it so the number of passes does not multiply the traversal cost.
// `guard` marks nodes beneath a conditional, loop or try construct.
const flattenedNodes = new WeakMap();
function flatten(root) {
  let entries = flattenedNodes.get(root);
  if (entries) return entries;
  entries = [];
  const pending = [{ node: root, parent: null, guard: false }];
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    const guard = current.guard || GUARD_TYPES.has(current.node.type);
    const children = childNodes(current.node);
    for (let i = children.length - 1; i >= 0; i -= 1) pending.push({ node: children[i], parent: current.node, guard });
  }
  flattenedNodes.set(root, entries);
  return entries;
}

function walk(node, visit) {
  for (const entry of flatten(node)) visit(entry.node, entry.parent);
}

function bindingNames(pattern) {
  const names = new Set();
  const pending = [pattern];
  while (pending.length) {
    const part = pending.pop();
    if (!part) continue;
    if (part.type === "Identifier") names.add(part.name);
    else if (part.type === "RestElement") pending.push(part.argument);
    else if (part.type === "AssignmentPattern") pending.push(part.left);
    else if (part.type === "ObjectPattern") {
      for (const property of part.properties) pending.push(property.type === "RestElement" ? property.argument : property.value);
    } else if (part.type === "ArrayPattern") pending.push(...part.elements);
  }
  return names;
}

const NAMED_DEFINITIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ClassDeclaration", "ClassExpression"]);

// There is no scope or flow analysis here. A name is treated as one proven
// binding only when the whole file declares it exactly once and never writes
// to it again; a second declaration anywhere (a sibling function, a parameter,
// a catch clause, an import) or any reassignment makes every use unproven.
function classifyLocalBindings(ast) {
  const declared = new Map();
  const reassigned = new Set();
  const declare = (names) => { for (const name of names) declared.set(name, (declared.get(name) || 0) + 1); };
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator") declare(bindingNames(node.id));
    else if (node.type === "ImportDeclaration") declare(node.specifiers.map((specifier) => specifier.local.name));
    else if (node.type === "CatchClause") declare(bindingNames(node.param));
    else if (node.type === "AssignmentExpression" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
      for (const name of bindingNames(node.left)) reassigned.add(name);
    } else if (node.type === "UpdateExpression") {
      for (const name of bindingNames(node.argument)) reassigned.add(name);
    }
    if (Array.isArray(node.params)) for (const param of node.params) declare(bindingNames(param));
    if (NAMED_DEFINITIONS.has(node.type) && node.id) declare([node.id.name]);
  });
  return (name) => declared.get(name) !== 1 || reassigned.has(name);
}

function requireSource(node) {
  return node?.type === "CallExpression" && identifier(node.callee) === "require" &&
    node.arguments?.length === 1 && node.arguments[0]?.type === "StringLiteral"
    ? node.arguments[0].value : null;
}

// Names bound from a scheduler/queue package, and instances constructed from
// those names (`new Queue("emails")`). `root` is the imported name an instance
// was built from; both must be proven bindings before a call is attributed.
function classifySchedulerBindings(ast) {
  const bindings = new Map();
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration" && SCHEDULER_MODULES.has(node.source.value)) {
      for (const specifier of node.specifiers) bindings.set(specifier.local.name, { module: node.source.value, root: specifier.local.name });
    } else if (node.type === "VariableDeclarator" && SCHEDULER_MODULES.has(requireSource(node.init))) {
      for (const name of bindingNames(node.id)) bindings.set(name, { module: requireSource(node.init), root: name });
    }
  });
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || node.init?.type !== "NewExpression") return;
    const root = identifier(node.init.callee) || identifier(memberParts(node.init.callee)?.object);
    if (bindings.has(root)) bindings.set(node.id.name, { module: bindings.get(root).module, root });
  });
  return bindings;
}

// Bodies that do not run when the code around them runs: functions, methods,
// class fields and static blocks. Code inside one runs only if it is invoked.
const DEFERRED_BODIES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod",
  "ClassMethod", "ClassPrivateMethod", "StaticBlock", "ClassProperty", "ClassPrivateProperty", "ClassAccessorProperty"]);

// Whether `node` runs when the code around `parent` runs: anything but the
// body of a deferred parent. A computed key of a method or field is evaluated
// where its class or object is defined.
const runsWithParent = (node, parent) => !DEFERRED_BODIES.has(parent.type) || (parent.computed === true && parent.key === node);

// Statements and declarators that sit directly at module level.
function noteModuleLevel(node, moduleLevel) {
  if (node.type === "Program") {
    for (const statement of node.body) {
      moduleLevel.add(statement);
      if (statement.declaration) moduleLevel.add(statement.declaration);
    }
  } else if (node.type === "VariableDeclaration" && moduleLevel.has(node)) {
    for (const declarator of node.declarations) moduleLevel.add(declarator);
  }
}

// The name a module-level function or class is declared under, if it has one.
function moduleFunctionName(node, parent, moduleLevel) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return moduleLevel.has(node) ? identifier(node.id) : null;
  return parent.type === "VariableDeclarator" && moduleLevel.has(parent) ? identifier(parent.id) : null;
}

// Calls, `new` expressions, optional calls and tagged templates all run the
// body they name. A tagged template calls its tag with the strings array, then
// each `${}` value.
const CALL_TYPES = new Set(["CallExpression", "NewExpression", "OptionalCallExpression", "TaggedTemplateExpression"]);
const calleeOf = (call) => call.type === "TaggedTemplateExpression" ? call.tag : call.callee;
const argumentsOf = (call) => call.type === "TaggedTemplateExpression" ? [call.quasi, ...call.quasi.expressions] : call.arguments;
// `new` runs a plain function; an arrow, async or generator function throws instead.
const constructible = (body) => (body.type === "FunctionDeclaration" || body.type === "FunctionExpression") && !body.async;
// Static blocks and static fields run, in order, when their class is defined.
const CLASS_FIELDS = new Set(["ClassProperty", "ClassPrivateProperty", "ClassAccessorProperty"]);
const definedWithClass = (node) => node.type === "StaticBlock" || (CLASS_FIELDS.has(node.type) && node.static);

const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const EXIT_STATEMENTS = new Set(["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"]);

// `process.exit(...)` ends the process, so it is an exit like `throw`. A computed
// key counts when it is a static string (`process["exit"]`, a template with no expressions).
function isProcessExit(node) {
  const callee = node.type === "CallExpression" ? node.callee : null;
  if (callee?.type !== "MemberExpression" || identifier(callee.object) !== "process") return false;
  return (callee.computed ? staticString(callee.property) : identifier(callee.property)) === "exit";
}

function isExit(node) {
  return EXIT_STATEMENTS.has(node.type) || isProcessExit(node);
}

// The truth of a literal constant (`true`, `false`, a number, `null`, a
// string or expression-free template), or null when `node` is not one.
function constantTruth(node) {
  if (node.type === "BooleanLiteral" || node.type === "NumericLiteral") return Boolean(node.value);
  if (node.type === "NullLiteral") return false;
  const text = staticString(node);
  return text === null ? null : Boolean(text);
}

// A `for`, `while` or `do` loop with no test or a constant truthy literal one
// (`true`, a non-zero number, a non-empty string) ends only through a break,
// return or throw.
function loopNeverEnds(node) {
  if (node.type !== "ForStatement" && node.type !== "WhileStatement" && node.type !== "DoWhileStatement") return false;
  return !node.test || constantTruth(node.test) === true;
}

// The breaks and continues inside `loop` that hand control to a construct
// outside it, or null when a break targets the loop so the loop can complete.
// A continue that names the loop's own label keeps the loop running. The walk
// is in source order and stops at the first break that targets the loop, so
// nested loops that each break early (`for (;;) { if (a) break; ... }`) are
// walked in linear time.
function escapingJumps(loop, outerParentOf) {
  const ownLabels = new Set();
  for (let parent = outerParentOf.get(loop); parent?.type === "LabeledStatement"; parent = outerParentOf.get(parent)) {
    ownLabels.add(parent.label.name);
  }
  const parentOf = new Map();
  const escaping = [];
  const pending = [{ node: loop, parent: null }];
  while (pending.length) {
    const { node, parent } = pending.pop();
    const children = childNodes(node);
    for (let i = children.length - 1; i >= 0; i -= 1) pending.push({ node: children[i], parent: node });
    parentOf.set(node, parent);
    if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") continue;
    let target = parentOf.get(node);
    while (target && !isExitTarget(node, target)) target = parentOf.get(target);
    if (target === loop && node.type === "BreakStatement") return null;
    if (!target && !(node.type === "ContinueStatement" && ownLabels.has(node.label.name))) escaping.push(node);
  }
  return escaping;
}

// Whether `node` is the construct a break or continue hands control back to.
// A return, throw or process.exit() leaves the whole body, so it has none.
function isExitTarget(exit, node) {
  if (exit.label) return node.type === "LabeledStatement" && node.label.name === exit.label.name;
  if (exit.type === "BreakStatement") return LOOP_TYPES.has(node.type) || node.type === "SwitchStatement";
  return exit.type === "ContinueStatement" && LOOP_TYPES.has(node.type);
}

// An exit that can be taken, guarded or not, means the statements after the
// statement holding it run on some paths only. Walk up from the exit to its
// target or its own body and mark the later statements of each list passed.
// A loop that never ends is treated the same way, up to whatever construct a
// break or continue inside it hands control to. A return, throw or exit call
// has no target, so the walk up from any node is the same for each of them:
// theirs stops at a node one of theirs went on from (`untargeted`), which
// keeps a deep chain of such exits linear.
function markAfterExit(start, parentOf, marks, isTarget, untargeted = null) {
  let current = start;
  for (let parent = parentOf.get(current); parent && runsWithParent(current, parent); parent = parentOf.get(current)) {
    if (parent.type === "Program" || parent.type === "BlockStatement") markLaterStatements(parent, current, marks);
    if (isTarget(parent) || untargeted?.has(parent)) return;
    untargeted?.add(parent);
    current = parent;
  }
}

// Marks the statements of `list` after `statement`, skipping those an earlier
// exit in a statement before it has marked already.
function markLaterStatements(list, statement, { afterExit, laterStatements }) {
  let entry = laterStatements.get(list);
  if (!entry) {
    entry = { position: new Map(list.body.map((node, i) => [node, i])), from: list.body.length - 1 };
    laterStatements.set(list, entry);
  }
  const position = entry.position.get(statement);
  for (let i = position + 1; i <= entry.from; i += 1) afterExit.add(list.body[i]);
  entry.from = Math.min(entry.from, position);
}

// Inside the expression that holds an exit call, the parts evaluated after
// the call may not run either, and a call that encloses it may not be made.
// Walk up through the positions listed in EVALUATED_FIRST: where the exit sits
// in a part its parent always evaluates first, every later part of that
// parent (and any part that may not run, such as the right side of `||`)
// comes after it. An exit in a part that may not run (`port || die()`) can
// still be taken, so, as for the statements after any takeable exit, the walk
// goes on: `app.listen(port || die())` may never call `listen`. An exit in a
// part a literal constant rules out (`true || die()`, `false ? die() : port`)
// is never taken, so the walk stops there. The walk also stops at a parent an
// earlier exit's walk went on from, since the rest of the way up is the same,
// and each parent's later parts are marked once, so a long `||` chain or
// argument list of exits is walked in linear time.
function markWithinExpression(exit, parentOf, marks) {
  let current = exit;
  marks.walked.add(exit);
  for (let parent = parentOf.get(current); parent && EVALUATED_FIRST[parent.type] && !ruledOut(current, parent); parent = parentOf.get(current)) {
    markLaterParts(parent, current, marks);
    if (CALL_TYPES.has(parent.type)) marks.notMade.add(parent);
    if (marks.walked.has(parent)) return;
    marks.walked.add(parent);
    current = parent;
  }
}

// Marks the children of `parent` that do not come before or at `part` in its
// EVALUATED_FIRST order, or nothing when `part` is not in that order or an
// earlier exit in a part at or before it has marked them already.
function markLaterParts(parent, part, { afterExit, laterParts }) {
  let entry = laterParts.get(parent);
  if (!entry) {
    const order = EVALUATED_FIRST[parent.type](parent);
    entry = { position: new Map(order.map((node, i) => [node, i])), from: Infinity };
    laterParts.set(parent, entry);
  }
  const position = entry.position.get(part);
  if (position === undefined || entry.from <= position) return;
  for (const child of childNodes(parent)) if (!(entry.position.get(child) <= position)) afterExit.add(child);
  entry.from = position;
}

// Whether a literal constant test or left operand means `node` never runs
// when its parent does: the right side of `||` after a truthy literal, of
// `&&` after a falsy one, of `??` after a literal other than `null`, or the
// branch of `?:` its constant test does not take.
function ruledOut(node, parent) {
  if (parent.type === "ConditionalExpression") {
    const truth = constantTruth(parent.test);
    return truth !== null && node === (truth ? parent.alternate : parent.consequent);
  }
  if (parent.type !== "LogicalExpression" || node !== parent.right) return false;
  const truth = constantTruth(parent.left);
  if (parent.operator === "??") return truth !== null && parent.left.type !== "NullLiteral";
  return truth === (parent.operator === "||");
}

// Tracks, in preorder, which nodes sit after a takeable exit in their own
// body. The mark does not cross into a nested deferred body, which runs (if
// at all) only when it is invoked. `callExits` are calls that can throw or
// never return (see collectCallExits); they are exits like `process.exit()`.
// `notMade` collects the calls that enclose an exit call, found only after
// the enclosing call was visited.
function exitTracker(callExits) {
  const parentOf = new Map();
  const afterExit = new Set();
  const exited = new WeakSet();
  const notMade = new WeakSet();
  const marks = { afterExit, notMade, walked: new WeakSet(), laterParts: new WeakMap(), laterStatements: new WeakMap() };
  const untargeted = new WeakSet();
  const track = (node, parent) => {
    parentOf.set(node, parent);
    if ((parent && runsWithParent(node, parent) && exited.has(parent)) || afterExit.has(node)) exited.add(node);
    if (isExit(node) || callExits.has(node)) {
      const jump = node.type === "BreakStatement" || node.type === "ContinueStatement";
      markAfterExit(node, parentOf, marks, (parent) => isExitTarget(node, parent), jump ? null : untargeted);
      markWithinExpression(node, parentOf, marks);
    } else if (loopNeverEnds(node)) {
      const jumps = escapingJumps(node, parentOf);
      if (jumps) markAfterExit(node, parentOf, marks, (parent) => jumps.some((jump) => isExitTarget(jump, parent)));
    }
    return exited.has(node);
  };
  return Object.assign(track, { notMade });
}

// What a module-level name holds and the source offset from which it holds
// it: a function declaration from the start (it is hoisted), a `const`/`let`
// function once its declarator has run, and a class once its declaration has
// run. A class's constructor is not followed, so it names no body (null).
function moduleBinding(node, parent) {
  if (node.type === "ClassDeclaration") return { body: null, from: node.end };
  if (node.type === "ClassExpression") return { body: null, from: parent.end };
  return { body: node, from: node.type === "FunctionDeclaration" ? 0 : parent.end };
}

// Records the binding a module-level non-generator function or a class is
// declared under, if it has a name.
function noteModuleBinding(node, parent, moduleLevel, moduleFunctions) {
  const bindable = DEFERRED_BODIES.has(node.type) ? !node.generator : node.type === "ClassDeclaration" || node.type === "ClassExpression";
  const name = bindable ? moduleFunctionName(node, parent, moduleLevel) : null;
  if (name) moduleFunctions.set(name, moduleBinding(node, parent));
}

// Whether a function is run where it is written: called or constructed in
// place. Calling a generator creates an iterator; it does not run the body.
function runsInPlace(node, parent) {
  if (node.generator || !CALL_TYPES.has(parent.type) || calleeOf(parent) !== node) return false;
  return parent.type !== "NewExpression" || constructible(node);
}

// Groups every call under its nearest deferred body (null for module level),
// and records which bodies are invoked in place or named at module level.
// A call after a takeable exit is recorded as guarded. Entering a static
// block or field is a call made where its class is defined.
function indexDeferredBodies(ast, callExits = new WeakSet()) {
  const scopeOf = new Map([[ast, null]]);
  const callsByScope = new Map([[null, []]]);
  const invokedInPlace = new WeakSet();
  const moduleLevel = new Set();
  const moduleFunctions = new Map();
  const afterExit = exitTracker(callExits);
  for (const entry of flatten(ast)) {
    const { node, parent } = entry;
    const guard = afterExit(node, parent) || entry.guard;
    if (parent) scopeOf.set(node, runsWithParent(node, parent) ? scopeOf.get(parent) : parent);
    noteModuleLevel(node, moduleLevel);
    if (DEFERRED_BODIES.has(node.type)) {
      callsByScope.set(node, []);
      if (runsInPlace(node, parent)) invokedInPlace.add(node);
    }
    noteModuleBinding(node, parent, moduleLevel, moduleFunctions);
    if (CALL_TYPES.has(node.type) || definedWithClass(node)) callsByScope.get(scopeOf.get(node)).push({ node, guard });
  }
  for (const calls of callsByScope.values()) for (const call of calls) if (afterExit.notMade.has(call.node)) call.guard = true;
  return { callsByScope, invokedInPlace, moduleFunctions };
}

// The body a call enters, and the source offset from which its binding holds
// the function or class, whether or not the call itself is guarded: a
// function invoked in place, a static block or field of a class being
// defined, or a module-level function or class called by a stable name. A
// class names no body (null).
function callTarget(node, index, bindingUnstable) {
  if (definedWithClass(node)) return { body: node, from: 0 };
  const callee = calleeOf(node);
  if (index.invokedInPlace.has(callee)) return { body: callee, from: 0 };
  if (callee.type !== "Identifier" || bindingUnstable(callee.name)) return null;
  const target = index.moduleFunctions.get(callee.name);
  if (!target) return null;
  return node.type === "NewExpression" && target.body && !constructible(target.body) ? null : target;
}

// The deferred body a reached call proves runs, if any. A guarded call
// proves nothing, even when it invokes a function in place. `position` is the
// earliest source offset at which the call can run: its own offset at module
// level, or the earliest proven call into the body that holds it.
function invokedBody({ node, guard }, index, bindingUnstable, position) {
  if (guard) return null;
  const target = callTarget(node, index, bindingUnstable);
  return target && position >= target.from ? target.body : null;
}

// The earliest offset each body can be entered from through the calls `enter`
// follows: a lower bound over every candidate path. Returns the earliest
// offset a call can run at, undefined for a body nothing enters.
function earliestEntries(index, enter) {
  const entry = new Map();
  const position = (scope, call) => scope === null ? call.node.start : entry.get(scope);
  const pending = [null];
  while (pending.length) {
    const scope = pending.pop();
    for (const call of index.callsByScope.get(scope)) {
      const target = enter(call);
      if (target && !(entry.get(target) <= position(scope, call))) {
        entry.set(target, position(scope, call));
        pending.push(target);
      }
    }
  }
  return position;
}

// Statement completion, used to find function bodies that can never return to
// their caller. Each statement yields the set of ways it can end: "normal",
// "return", "throw", "break:<label>" or "continue:<label>" (an empty label
// when unlabelled). An empty set means it never ends. Nesting deeper than the
// bound is assumed to be able to end normally or return, which keeps the code
// after it proven and lets the body holding it return (the may-return answer
// the recursion fixpoint needs; see neverReturningBodies).
const MAX_FLOW_DEPTH = 256;
const NORMAL = new Set(["normal"]);
const UNBOUNDED = new Set(["normal", "return"]);
const THROWS = new Set(["throw"]);
const union = (left, right) => new Set([...left, ...right]);
const without = (outcomes, removed) => new Set([...outcomes].filter((outcome) => outcome !== removed));
const jumpOutcome = (kind, node) => new Set([`${kind}:${node.label ? node.label.name : ""}`]);
// `return f()` ends the way f() does when f() never returns.
const returned = (outcomes) => outcomes.has("normal") ? union(without(outcomes, "normal"), ["return"]) : outcomes;

function flowOutcomes(node, callEnds, labels = [], depth = 0) {
  if (depth >= MAX_FLOW_DEPTH) return UNBOUNDED;
  const handler = FLOW_HANDLERS[node.type];
  if (!handler) return NORMAL;
  return handler(node, (child, ownLabels = []) => flowOutcomes(child, callEnds, ownLabels, depth + 1), labels, callEnds);
}

// Statements after one that cannot end normally are never reached; an async
// body's analysis records them (see suspends).
function listOutcomes(statements, next, callEnds) {
  const result = new Set();
  for (const [i, statement] of statements.entries()) {
    const outcomes = next(statement);
    for (const outcome of outcomes) if (outcome !== "normal") result.add(outcome);
    if (!outcomes.has("normal")) {
      for (const skipped of statements.slice(i + 1)) callEnds.cut?.add(skipped);
      return result;
    }
  }
  return result.add("normal");
}

// A loop ends normally when its test can fail or a break targets it; a
// continue that targets it keeps it running.
function loopOutcomes(node, next, labels) {
  const result = new Set();
  let ends = !loopNeverEnds(node);
  for (const outcome of next(node.body)) {
    const [kind, label] = outcome.split(":");
    const own = label === "" || labels.includes(label);
    if (kind === "break" && own) ends = true;
    else if (kind !== "normal" && !(kind === "continue" && own)) result.add(outcome);
  }
  if (ends) result.add("normal");
  return result;
}

// A `do ... while` loop reaches its test only when its body can end normally
// or continue it; an async body's analysis records a test it never reaches. A
// test that never returns ends the loop the same way; a test that can be false
// ends it normally.
function doWhileOutcomes(node, next, labels, callEnds, testOutcomes) {
  const result = new Set();
  let ends = false;
  let tested = false;
  for (const outcome of next(node.body)) {
    const [kind, label] = outcome.split(":");
    const own = label === "" || labels.includes(label);
    if (kind === "break" && own) ends = true;
    else if (kind === "normal" || (kind === "continue" && own)) tested = true;
    else result.add(outcome);
  }
  if (!tested) callEnds.cut?.add(node.test);
  else {
    const testEnds = testOutcomes();
    if (!testEnds.has("normal")) for (const outcome of testEnds) result.add(outcome);
    else if (!loopNeverEnds(node)) ends = true;
  }
  if (ends) result.add("normal");
  return result;
}

// A literal constant test runs one branch only; the other is never reached.
function ifOutcomes(node, next, labels, callEnds) {
  const truth = constantTruth(node.test);
  const branches = truth === true ? [node.consequent] : truth === false ? [node.alternate] : [node.consequent, node.alternate];
  if (truth !== null) callEnds.cut?.add(truth ? node.alternate : node.consequent);
  let result = new Set();
  for (const branch of branches) result = union(result, branch ? next(branch) : NORMAL);
  return result;
}

// A case runs on to the next one; the last case, an unlabelled break, or a
// missing default ends the switch normally.
function switchOutcomes(node, next, labels, callEnds) {
  const result = new Set();
  node.cases.forEach((branch, i) => {
    for (const outcome of listOutcomes(branch.consequent, next, callEnds)) {
      if (outcome === "break:") result.add("normal");
      else if (outcome !== "normal" || i === node.cases.length - 1) result.add(outcome);
    }
  });
  if (!node.cases.some((branch) => !branch.test)) result.add("normal");
  return result;
}

// Any call in the block may throw, so a catch clause can always run. A
// finally block runs only when the block or catch clause can end; an async
// body's analysis records one that never runs.
function tryOutcomes(node, next, labels, callEnds) {
  const block = next(node.block);
  const caught = node.handler ? union(without(block, "throw"), next(node.handler.body)) : block;
  if (!node.finalizer) return caught;
  if (!caught.size) {
    callEnds.cut?.add(node.finalizer);
    return caught;
  }
  const final = next(node.finalizer);
  return final.has("normal") ? union(caught, without(final, "normal")) : final;
}

// The right side of `||` with a falsy literal left, of `&&` with a truthy
// one, and of `??` with `null`, always runs.
function rightAlwaysRuns(node) {
  if (node.operator === "??") return node.left.type === "NullLiteral";
  return constantTruth(node.left) === (node.operator === "&&");
}

// A class definition evaluates its heritage, then each computed member key,
// then each static block and static field in order.
function classParts(body) {
  const keys = body.body.filter((member) => member.computed).map((member) => member.key);
  return [...keys, ...body.body.filter(definedWithClass)];
}

// The parts of an expression or declaration that always run when it runs:
// not the right side of `&&`, `||` or `??` (or of `&&=`, `||=` or `??=`), the
// branches of `?:`, the arguments of an optional call, or any function or
// callback body, which may not run. A literal constant test or left operand
// decides which of those parts runs. Any node type missing here is not looked
// into. Keep this table and the list in BUSINESS_DISCOVERY_PROTOCOL.md
// ("Never-returning calls") in step; a test checks it.
const SHORT_CIRCUIT_ASSIGNMENT = new Set(["&&=", "||=", "??="]);
const EVALUATED_FIRST = {
  CallExpression: (node) => [node.callee, ...node.arguments],
  NewExpression: (node) => [node.callee, ...node.arguments],
  OptionalCallExpression: (node) => [node.callee],
  MemberExpression: (node) => [node.object, node.property],
  OptionalMemberExpression: (node) => [node.object],
  BinaryExpression: (node) => [node.left, node.right],
  AssignmentExpression: (node) => [...(node.left.type === "MemberExpression" ? [node.left] : []),
    ...(SHORT_CIRCUIT_ASSIGNMENT.has(node.operator) ? [] : [node.right])],
  LogicalExpression: (node) => rightAlwaysRuns(node) ? [node.left, node.right] : [node.left],
  ConditionalExpression: (node) => {
    const truth = constantTruth(node.test);
    return truth === null ? [node.test] : [node.test, truth ? node.consequent : node.alternate];
  },
  SequenceExpression: (node) => node.expressions,
  UnaryExpression: (node) => [node.argument],
  AwaitExpression: (node) => [node.argument],
  TemplateLiteral: (node) => node.expressions,
  TaggedTemplateExpression: (node) => [node.tag, node.quasi],
  ArrayExpression: (node) => node.elements,
  ObjectExpression: (node) => node.properties,
  ObjectProperty: (node) => node.computed ? [node.key, node.value] : [node.value],
  SpreadElement: (node) => [node.argument],
  ClassDeclaration: (node) => [node.superClass, node.body],
  ClassExpression: (node) => [node.superClass, node.body],
  ClassBody: classParts,
  VariableDeclaration: (node) => node.declarations,
  VariableDeclarator: (node) => [node.init],
};

// How evaluating `expr` can end: the outcomes of the first call it always
// makes that never returns (`process.exit()` or a call into a body that can
// never return), in evaluation order, or NORMAL when there is none. An async
// body's analysis records what was evaluated and what was not (see suspends).
function expressionEnds(expr, callEnds) {
  const order = [];
  const pending = [expr];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    order.push(node);
    pending.push(...(EVALUATED_FIRST[node.type]?.(node) || []));
  }
  // Reversed, this preorder (children last to first) is evaluation order.
  order.reverse();
  for (const node of order) callEnds.evaluated?.add(node);
  for (const [i, node] of order.entries()) {
    const outcomes = callEnds(node);
    if (outcomes.has("normal")) continue;
    for (const skipped of order.slice(i + 1)) callEnds.after?.add(skipped);
    return outcomes;
  }
  return NORMAL;
}

// A statement whose leading expression never completes ends the way it does;
// otherwise it goes on to the rest of the statement.
const leading = (field, rest) => (node, next, labels, callEnds) => {
  const outcomes = expressionEnds(node[field], callEnds);
  return outcomes.has("normal") ? rest(node, next, labels, callEnds) : outcomes;
};

const FLOW_HANDLERS = {
  BlockStatement: (node, next, labels, callEnds) => listOutcomes(node.body, next, callEnds),
  StaticBlock: (node, next, labels, callEnds) => listOutcomes(node.body, next, callEnds),
  ExpressionStatement: leading("expression", () => NORMAL),
  VariableDeclaration: (node, next, labels, callEnds) => expressionEnds(node, callEnds),
  ClassDeclaration: (node, next, labels, callEnds) => expressionEnds(node, callEnds),
  ReturnStatement: (node, next, labels, callEnds) => returned(expressionEnds(node.argument, callEnds)),
  ThrowStatement: () => THROWS,
  BreakStatement: (node) => jumpOutcome("break", node),
  ContinueStatement: (node) => jumpOutcome("continue", node),
  IfStatement: leading("test", ifOutcomes),
  LabeledStatement: (node, next, labels) => {
    const outcomes = next(node.body, [...labels, node.label.name]);
    const own = `break:${node.label.name}`;
    return outcomes.has(own) ? union(without(outcomes, own), NORMAL) : outcomes;
  },
  SwitchStatement: leading("discriminant", switchOutcomes),
  TryStatement: tryOutcomes,
  ForStatement: leading("init", leading("test", loopOutcomes)),
  ForInStatement: leading("right", loopOutcomes),
  ForOfStatement: leading("right", loopOutcomes),
  WhileStatement: leading("test", loopOutcomes),
  DoWhileStatement: (node, next, labels, callEnds) => doWhileOutcomes(node, next, labels, callEnds, () => expressionEnds(node.test, callEnds)),
};

// Whether an async body can reach an `await` of its own, where it returns its
// promise to the caller. An await is skipped only when the analysis proved it
// is not reached: it sits in a statement after one that cannot end, in the
// branch a constant test never takes, or after (in evaluation order) a call
// that never returns. Elsewhere, including any position the analysis did not
// look into, it is assumed to be reached.
function suspends(body, tracked) {
  const pending = [{ node: body.body, reached: true }];
  while (pending.length) {
    const { node, reached: above } = pending.pop();
    if (tracked.cut.has(node)) continue;
    const reached = tracked.evaluated.has(node) ? !tracked.after.has(node) : above;
    if (reached && (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await))) return true;
    for (const child of childNodes(node)) if (!DEFERRED_BODIES.has(child.type)) pending.push({ node: child, reached });
  }
  return false;
}

// How a body ends when it is entered: a static field by its value, any other
// body by its statements or expression body.
function bodyOutcomes(body, callEnds) {
  if (CLASS_FIELDS.has(body.type)) return expressionEnds(body.value, callEnds);
  if (body.type === "StaticBlock" || body.body.type === "BlockStatement") return flowOutcomes(body.type === "StaticBlock" ? body : body.body, callEnds);
  return returned(expressionEnds(body.body, callEnds));
}

// A body returns to its caller when it can end normally or return. An async
// body also returns its promise when it throws or reaches an await.
function bodyReturns(body, callEnds) {
  const tracked = body.async ? Object.assign((expr) => callEnds(expr), { evaluated: new Set(), after: new Set(), cut: new Set() }) : callEnds;
  const outcomes = bodyOutcomes(body, tracked);
  if (outcomes.has("normal") || outcomes.has("return")) return null;
  return body.async && (outcomes.has("throw") || suspends(body, tracked)) ? null : outcomes;
}

// How the default parameter values a call leaves to its callee end. A call
// that passes fewer arguments than a parameter's position evaluates that
// parameter's default, in order.
function defaultsEnd(call, body, callEnds) {
  const args = argumentsOf(call);
  if (!body.params || args.some((arg) => arg.type === "SpreadElement")) return NORMAL;
  for (const param of body.params.slice(args.length)) {
    if (param.type !== "AssignmentPattern") continue;
    const outcomes = expressionEnds(param.right, callEnds);
    if (!outcomes.has("normal")) return outcomes;
  }
  return NORMAL;
}

// The callee bodies, grouped so each group comes after every group it calls
// into: a group is one body, or bodies that call each other (Tarjan's
// strongly connected components, iteratively). Settling callees first means
// each body is analysed once, after what it calls, instead of once for every
// callee that changes.
function calleeFirstGroups(bodies, callees) {
  const order = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  for (const root of bodies) {
    if (order.has(root)) continue;
    const frames = [];
    const open = (body) => {
      order.set(body, order.size);
      low.set(body, order.get(body));
      stack.push(body);
      onStack.add(body);
      frames.push({ body, edges: [...callees.get(body)], next: 0 });
    };
    open(root);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.edges.length) {
        const callee = frame.edges[frame.next++];
        if (!order.has(callee)) open(callee);
        else if (onStack.has(callee)) low.set(frame.body, Math.min(low.get(frame.body), order.get(callee)));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const up = frames[frames.length - 1].body;
        low.set(up, Math.min(low.get(up), low.get(frame.body)));
      }
      if (low.get(frame.body) !== order.get(frame.body)) continue;
      const group = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        group.push(member);
      } while (member !== frame.body);
      groups.push({ members: group, recursive: group.length > 1 || callees.get(frame.body).has(frame.body) });
    }
  }
  return groups;
}

const sameOutcomes = (left, right) => !left || !right ? !left === !right
  : left.size === right.size && [...left].every((outcome) => right.has(outcome));

// The bodies (among those a call can enter) that can never return to their
// caller, each with how it ends instead (a throw, or never), and how each call
// ends. A statement ends that way when an expression it always evaluates
// first makes such a call: `process.exit()`, a call into another such body,
// or a call whose missing argument's default value makes one (see
// expressionEnds). Bodies that call each other without end overflow the
// stack, which throws: each starts assumed to throw, and is cleared once its
// body can return (the greatest such set). Default values that call each
// other the same way (`function f(a = f()) {}` called as `f()`) overflow it
// too: a call met again while its own defaults are being followed was reached
// by making that same call again with no way out. When every callee on that
// cycle is synchronous, the overflow throws through all of them, so the call
// met again throws. When one is async, it turns the overflow into a rejected
// promise at whatever depth the stack runs out, and the calls around it go on
// from there: the call met again may return, throw, or never return (its
// callee's body may loop), so it is taken to never return (fail-closed) and
// so is every call whose defaults reach it. An async callee turns a throw
// from a default into a rejected promise, which it returns without running
// its body; a default that never ends (an infinite loop, `process.exit()`)
// still never returns. A call's answer is kept until a body's answer
// changes, unless it relied on a call being followed: such an answer depends
// on which calls were being followed, so chains of defaults are followed
// once per query, and every query starts with none followed. An async
// callee's rejected promise is kept whichever call threw, because a call met
// again can only throw when every callee on its cycle is synchronous, so that
// cycle lies within the async callee's own defaults; a call met again through
// an async callee never throws, so it cannot be turned into a return.
function neverReturningBodies(groups, targets) {
  const ends = new Map();
  // Each call being followed, with how many async callees the calls before it
  // on the way in have.
  const following = new Map();
  let asyncFollowed = 0;
  const settled = new Map();
  let assumed = 0;
  const callEnds = (expr) => {
    if (isProcessExit(expr)) return new Set();
    const target = targets.get(expr);
    if (!target?.body) return NORMAL;
    if (settled.has(expr)) return settled.get(expr);
    if (following.has(expr)) {
      assumed += 1;
      return asyncFollowed > following.get(expr) ? new Set() : THROWS;
    }
    const before = assumed;
    following.set(expr, asyncFollowed);
    if (target.body.async) asyncFollowed += 1;
    const defaults = defaultsEnd(expr, target.body, callEnds);
    if (target.body.async) asyncFollowed -= 1;
    following.delete(expr);
    const rejects = !defaults.has("normal") && target.body.async && defaults.has("throw");
    const outcomes = defaults.has("normal") ? ends.get(target.body) || NORMAL : rejects ? NORMAL : defaults;
    if (rejects) assumed = before;
    if (assumed === before) settled.set(expr, outcomes);
    return outcomes;
  };
  for (const { members, recursive } of groups) {
    if (recursive) {
      settled.clear();
      for (const body of members) ends.set(body, THROWS);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const body of members) {
        const outcomes = bodyReturns(body, callEnds);
        if (sameOutcomes(outcomes, ends.get(body))) continue;
        changed = recursive;
        settled.clear();
        if (outcomes) ends.set(body, outcomes);
        else ends.delete(body);
      }
    }
  }
  return { ends, callEnds };
}

// For each body, the latest declarator offset a call made inside it, directly
// or through the bodies it calls, needs to have run: entering the body any
// earlier can call a `const`/`let`/`var` function or a class before its
// declaration, which throws. An async body turns that throw into a rejected
// promise, so it never throws to its caller.
function declaratorBounds(groups, index, targets) {
  const bound = new Map();
  for (const { members, recursive } of groups) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const body of members) {
        if (body.async) continue;
        let latest = bound.get(body) ?? -Infinity;
        for (const { node } of index.callsByScope.get(body)) {
          const target = targets.get(node);
          if (target) latest = Math.max(latest, target.from, bound.get(target.body) ?? -Infinity);
        }
        if (latest === (bound.get(body) ?? -Infinity)) continue;
        bound.set(body, latest);
        changed = recursive;
      }
    }
  }
  return bound;
}

// Calls the code after them in their own body cannot rely on: a call that can
// run before the declarator of a function or class it reaches (it throws
// there), and a call into a body that can never return. Guards are ignored,
// as for any exit: a call that can be taken is enough.
function collectCallExits(index, bindingUnstable) {
  const targets = new Map();
  const callees = new Map([...index.callsByScope.keys()].map((scope) => [scope, new Set()]));
  const entered = new Set();
  for (const [scope, calls] of index.callsByScope) {
    for (const { node } of calls) {
      const target = callTarget(node, index, bindingUnstable);
      if (!target) continue;
      targets.set(node, target);
      if (!target.body) continue;
      entered.add(target.body);
      callees.get(scope).add(target.body);
    }
  }
  const groups = calleeFirstGroups(entered, callees);
  const { callEnds } = neverReturningBodies(groups, targets);
  const bounds = declaratorBounds(groups, index, targets);
  const position = earliestEntries(index, ({ node }) => targets.get(node)?.body);
  const exits = new WeakSet();
  for (const [scope, calls] of index.callsByScope) {
    for (const call of calls) {
      const target = targets.get(call.node);
      if (!target) continue;
      const needed = Math.max(target.from, bounds.get(target.body) ?? -Infinity);
      if (!callEnds(call.node).has("normal") || position(scope, call) < needed) exits.add(call.node);
    }
  }
  return exits;
}

// A call is certain only when it is unguarded and the file proves the code
// around it runs. Calls beneath a conditional, loop or try construct, or after
// a return, throw, break or continue that can be taken, run on some paths
// only. A deferred body is proven to run only when it is
// immediately invoked from proven code, or when it is a non-generator function
// declared at module level under a stable name and called directly and
// unconditionally from proven code (after its declarator, unless hoisted).
// A call made inside another body counts as after the declarator only when
// every way into that body starts after it. A call that can throw or never
// return is an exit for the code after it (see collectCallExits).
// Every other call is conditional.
function collectConditionalCalls(ast, bindingUnstable) {
  const index = indexDeferredBodies(ast, collectCallExits(indexDeferredBodies(ast), bindingUnstable));
  // First, the earliest offset each body can be entered from, ignoring the
  // declarator rule: a lower bound over every candidate path.
  const position = earliestEntries(index, (call) => invokedBody(call, index, bindingUnstable, Infinity));
  const reached = new Set([null]);
  const pending = [null];
  while (pending.length) {
    const scope = pending.pop();
    for (const call of index.callsByScope.get(scope)) {
      const target = invokedBody(call, index, bindingUnstable, position(scope, call));
      if (target && !reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  const conditional = new WeakSet();
  for (const [scope, calls] of index.callsByScope) {
    for (const { node, guard } of calls) if (guard || !reached.has(scope)) conditional.add(node);
  }
  return conditional;
}

const SERVER_MODULES = new Set(["http", "https", "node:http", "node:https"]);

// Names bound to Node's http/https module, and names bound to its
// `createServer` export, so `http.createServer(app)` can prove a server root.
function classifyServerFactories(ast) {
  const modules = new Set();
  const factories = new Set();
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration" && SERVER_MODULES.has(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") modules.add(specifier.local.name);
        else if (propertyName(specifier.imported) === "createServer") factories.add(specifier.local.name);
      }
    } else if (node.type === "VariableDeclarator" && SERVER_MODULES.has(requireSource(node.init))) {
      if (node.id.type === "Identifier") modules.add(node.id.name);
      else for (const alias of propertyAliases(node.id, "createServer")) factories.add(alias);
    }
  });
  return { modules, factories };
}

// An application is a root only when the file serves it from reached,
// unconditional code: `app.listen(...)`, or `http.createServer(app)` whose
// returned server is listened on, chained directly or through a stable
// binding of it. Any other application may be mounted by another file under
// a prefix this file cannot see.
function servedApplications(ast, applications, conditionalCalls, bindingUnstable) {
  const factories = classifyServerFactories(ast);
  const serverFactory = (callee) => {
    const member = memberParts(callee);
    const name = member ? identifier(member.object) : identifier(callee);
    if (!name || bindingUnstable(name)) return false;
    return member ? member.property === "createServer" && factories.modules.has(name) : factories.factories.has(name);
  };
  const listened = new Set();
  walk(ast, (node) => {
    const member = callMethod(node);
    if (member?.property === "listen" && !conditionalCalls.has(node)) listened.add(identifier(member.object) || member.object);
  });
  const listenedServer = (call, parent) => {
    if (listened.has(call)) return true;
    const name = parent.type === "VariableDeclarator" ? identifier(parent.id) : null;
    return listened.has(name) && !bindingUnstable(name);
  };
  const served = new Set();
  walk(ast, (node, parent) => {
    if (node.type !== "CallExpression" || conditionalCalls.has(node)) return;
    const member = callMethod(node);
    const targets = member?.property === "listen" ? [member.object]
      : serverFactory(node.callee) && listenedServer(node, parent) ? node.arguments : [];
    for (const argument of targets) if (applications.has(identifier(argument))) served.add(identifier(argument));
  });
  return served;
}

// Plain `{ key: alias }` and `{ key }` bindings of one property; anything else is not proven.
function propertyAliases(pattern, key) {
  const aliases = [];
  if (pattern.type !== "ObjectPattern") return aliases;
  for (const property of pattern.properties) {
    if (property.type === "ObjectProperty" && !property.computed && propertyName(property.key) === key &&
        property.value.type === "Identifier") aliases.push(property.value.name);
  }
  return aliases;
}

function classifyExpressBinding(ast) {
  let trusted = false;
  let unrelated = false;
  let ambiguous = false;
  let expressImportedUnderAlias = false;
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        if (node.source?.value === "express" && specifier.local?.name !== "express" &&
            (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier" ||
             (specifier.type === "ImportSpecifier" && specifier.imported?.name === "default"))) {
          expressImportedUnderAlias = true;
        }
        if (specifier.local?.name !== "express") continue;
        if (node.source?.value === "express" &&
            (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier")) trusted = true;
        else if (node.source?.value === "express") ambiguous = true;
        else unrelated = true;
      }
      return;
    }
    if (node.type === "VariableDeclarator" && node.id) {
      const declaresExpress = (() => {
        let found = false;
        walk(node.id, (part) => { if (part.type === "Identifier" && part.name === "express") found = true; });
        return found;
      })();
      if (!declaresExpress) return;
      const init = node.init;
      const isSimpleExpressBinding = node.id.type === "Identifier" && node.id.name === "express";
      const isExpressRequire = isSimpleExpressBinding && init?.type === "CallExpression" && identifier(init.callee) === "require" &&
        init.arguments?.length === 1 && init.arguments[0]?.type === "StringLiteral" && init.arguments[0].value === "express";
      if (isExpressRequire) trusted = true;
      else if (isSimpleExpressBinding && init?.type === "CallExpression" && identifier(init.callee) === "require" &&
          init.arguments?.length === 1 && init.arguments[0]?.type === "StringLiteral") unrelated = true;
      else ambiguous = true;
      return;
    }
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ClassDeclaration") && node.id?.name === "express") {
      ambiguous = true;
    }
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
        node.params.some((param) => {
          let found = false;
          walk(param, (part) => { if (part.type === "Identifier" && part.name === "express") found = true; });
          return found;
        })) {
      ambiguous = true;
    }
    if (node.type === "AssignmentExpression") walk(node.left, (part) => { if (part.type === "Identifier" && part.name === "express") ambiguous = true; });
    if (node.type === "UpdateExpression" && node.argument?.type === "Identifier" && node.argument.name === "express") {
      ambiguous = true;
    }
    if (node.type === "CatchClause" && node.param) {
      let found = false;
      walk(node.param, (part) => { if (part.type === "Identifier" && part.name === "express") found = true; });
      if (found) ambiguous = true;
    }
  });
  // "implicit" means the file never binds `express`. A call through that name
  // is still a candidate, but the framework is unproven and stays unresolved.
  if (ambiguous || (trusted && unrelated) || (expressImportedUnderAlias && !trusted)) return "ambiguous";
  if (trusted) return "express";
  if (unrelated) return "unrelated";
  return "implicit";
}

function classifyRouterBindings(ast) {
  const trusted = new Set();
  const unrelated = new Set();
  const ambiguous = new Set();
  const candidates = new Set(["Router"]);
  const recognizedDeclarators = new Map();
  function mark(name, state) {
    candidates.add(name);
    if (state === "express") trusted.add(name);
    else if (state === "unrelated") unrelated.add(name);
    else ambiguous.add(name);
  }
  function objectPatternAliases(pattern, source) {
    if (pattern?.type !== "ObjectPattern") return [];
    const aliases = [];
    for (const property of pattern.properties) {
      if (property.type !== "ObjectProperty" || property.computed || propertyName(property.key) !== "Router") continue;
      if (property.value.type === "Identifier") aliases.push(property.value.name);
      else if (property.value.type === "AssignmentPattern" && property.value.left?.type === "Identifier") aliases.push(property.value.left.name);
      else for (const name of bindingNames(property.value)) aliases.push({ name, ambiguous: true });
    }
    return aliases.map((entry) => {
      const alias = typeof entry === "string" ? { name: entry } : entry;
      return { ...alias, state: alias.ambiguous || !source ? "ambiguous" : source === "express" ? "express" : "unrelated" };
    });
  }

  // First collect direct imports/destructures so renamed static Router factories
  // are distinguished from similarly named local functions and packages.
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        const local = specifier.local?.name;
        const imported = specifier.type === "ImportSpecifier" ? propertyName(specifier.imported) : null;
        if (local !== "Router" && imported !== "Router") continue;
        const state = node.source?.value === "express" && specifier.type === "ImportSpecifier" && imported === "Router"
          ? "express" : node.source?.value === "express" ? "ambiguous" : "unrelated";
        mark(local, state);
      }
      return;
    }
    if (node.type !== "VariableDeclarator" || !node.id) return;
    const source = requireSource(node.init);
    const aliases = objectPatternAliases(node.id, source);
    const recognized = new Set();
    for (const alias of aliases) {
      mark(alias.name, alias.state);
      recognized.add(alias.name);
    }
    if (node.id.type === "Identifier" && node.id.name === "Router") {
      mark("Router", source === "express" ? "ambiguous" : source ? "unrelated" : "ambiguous");
      recognized.add("Router");
    } else if (node.id.type === "ObjectPattern" && bindingNames(node.id).has("Router") && !recognized.has("Router")) {
      mark("Router", source && source !== "express" ? "unrelated" : "ambiguous");
      recognized.add("Router");
    }
    if (recognized.size) recognizedDeclarators.set(node, recognized);
  });

  // Any second declaration, parameter, assignment or catch binding with one of
  // these names makes attribution uncertain. This mirrors the existing
  // whole-file shadowing rule while extending it to the proven aliases above.
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id) {
      const recognized = recognizedDeclarators.get(node) || new Set();
      for (const name of bindingNames(node.id)) {
        if (candidates.has(name) && !recognized.has(name)) ambiguous.add(name);
      }
    }
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
        node.params.some((param) => Array.from(bindingNames(param)).some((name) => candidates.has(name)))) {
      for (const param of node.params) for (const name of bindingNames(param)) if (candidates.has(name)) ambiguous.add(name);
    }
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ClassDeclaration") && candidates.has(node.id?.name)) {
      ambiguous.add(node.id.name);
    }
    if (node.type === "CatchClause" && node.param) for (const name of bindingNames(node.param)) if (candidates.has(name)) ambiguous.add(name);
    if (node.type === "AssignmentExpression") for (const name of bindingNames(node.left)) if (candidates.has(name)) ambiguous.add(name);
    if (node.type === "UpdateExpression" && node.argument?.type === "Identifier" && candidates.has(node.argument.name)) ambiguous.add(node.argument.name);
  });

  for (const name of trusted) if (unrelated.has(name)) ambiguous.add(name);
  return { trusted, unrelated, ambiguous };
}

function containsJsx(node) {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    if (current !== node && (current.type === "FunctionDeclaration" || current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression")) continue;
    if (current.type === "JSXElement" || current.type === "JSXFragment") return true;
    pending.push(...childNodes(current));
  }
  return false;
}

function functionComponentName(node, parent) {
  if (node.id?.type === "Identifier" && isComponentName(node.id.name)) return node.id.name;
  if (parent?.type === "VariableDeclarator" && isComponentName(parent.id?.name)) return parent.id.name;
  if (parent?.type === "AssignmentExpression" && isComponentName(parent.left?.name)) return parent.left.name;
  return null;
}

function inspectSource(source, options = {}) {
  const text = String(source || "");
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.min(options.maxBytes, 250_000) : 250_000;
  if (options.truncated || Buffer.byteLength(text, "utf8") > maxBytes) {
    return { findings: [], relationships: [], parse_status: "skipped_too_large", parse_error: null };
  }

  let ast;
  try {
    ast = babelParser.parse(text, {
      sourceType: "unambiguous",
      errorRecovery: false,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript", "decorators-legacy", "importAttributes"],
    });
  } catch (error) {
    return { findings: [], relationships: [], parse_status: "unparsed", parse_error: String(error.message).slice(0, 240) };
  }

  const findings = [];
  const findingKeys = new Set();
  const relationships = [];
  const relationshipKeys = new Set();
  const routers = new Set();
  const applications = new Set();
  const mounts = new Map();
  const mountResolutions = new Map();
  let remainingMountStates = 4096;
  const schedulerBindings = classifySchedulerBindings(ast);
  const expressBindingState = classifyExpressBinding(ast);
  const routerBindings = classifyRouterBindings(ast);
  const bindingUnstable = classifyLocalBindings(ast);
  const conditionalCalls = collectConditionalCalls(ast, bindingUnstable);
  // Applications the file proves are served directly, so their own paths are real.
  const rootApplications = new Set();
  // Applications and routers created through a name this file never proves is Express.
  const frameworkUnproven = new Set();
  const receiverUnproven = (name) => frameworkUnproven.has(name) || bindingUnstable(name);
  const expressBindingAmbiguous = expressBindingState === "ambiguous" || routerBindings.ambiguous.size > 0;

  function addFinding(kind, label, subject, resolution, sourceNode) {
    const key = `${kind}\u0000${subject}\u0000${label}\u0000${resolution}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    const finding = { kind, label, subject, source_registration: true, resolution_status: resolution };
    // All callers pass a parsed Babel node; locations are always enabled.
    finding.source_location = {
        line_start: sourceNode.loc.start.line,
        line_end: sourceNode.loc.end.line,
        offset: sourceNode.start,
    };
    findings.push(finding);
  }

  function addRelationship(from, to) {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}`;
    if (relationshipKeys.has(key)) return;
    relationshipKeys.add(key);
    relationships.push({ from, type: "contains_component", to });
  }

  walk(ast, (node, parent) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || !node.init) return;
    const call = node.init.type === "NewExpression" ? node.init : node.init.type === "CallExpression" ? node.init : null;
    if (!call) return;
    const calleeMember = memberParts(call.callee);
    const calleeId = identifier(call.callee);
    const expressRouter = calleeMember?.property === "Router" && identifier(calleeMember.object) === "express";
    if (expressBindingState !== "unrelated" && (expressRouter || calleeId === "express")) {
      (expressRouter ? routers : applications).add(node.id.name);
      if (expressBindingState === "implicit") frameworkUnproven.add(node.id.name);
    }
    if (calleeId && (routerBindings.trusted.has(calleeId) || routerBindings.ambiguous.has(calleeId) ||
        (calleeId === "Router" && !routerBindings.unrelated.has(calleeId)))) {
      routers.add(node.id.name);
      if (!routerBindings.trusted.has(calleeId)) frameworkUnproven.add(node.id.name);
    }
  });

  // Gather static `app.use('/prefix', router)` and nested router mounts before
  // resolving route registrations, so source order does not affect results.
  const routeChainCalls = new WeakSet();
  walk(ast, (node) => {
    const member = callMethod(node);
    if (member?.property !== "use" || !member.object || member.object.type !== "Identifier") return;
    const parentName = member.object.name;
    const args = node.arguments;
    let prefixNode = args[0];
    let childNode = args[1];
    if (args.length === 1) { prefixNode = null; childNode = args[0]; }
    const childName = identifier(childNode);
    if (!childName || (!routers.has(childName) && !applications.has(childName))) return;
    const prefixes = prefixNode ? literalPaths(prefixNode) : [""];
    const mountList = mounts.get(childName) || [];
    if (prefixes === null || conditionalCalls.has(node)) mountList.push({ parent: parentName, prefix: null });
    else for (const prefix of prefixes) mountList.push({ parent: parentName, prefix });
    mounts.set(childName, mountList);
  });

  for (const name of servedApplications(ast, applications, conditionalCalls, bindingUnstable)) rootApplications.add(name);

  // Bound total graph expansion as well as source bytes: a small mount DAG can
  // otherwise have exponentially many paths. The stack also avoids JS call-depth limits.
  function resolveMounts(routerName) {
    if (mountResolutions.has(routerName)) return mountResolutions.get(routerName);
    const unresolved = [{ prefix: null, resolved: false }];
    if (remainingMountStates-- <= 0) {
      mountResolutions.set(routerName, unresolved);
      return unresolved;
    }
    const pending = [{ name: routerName, prefix: "", visited: new Set() }];
    const results = [];
    while (pending.length) {
      const current = pending.pop();
      // An ancestor whose binding is unproven cannot anchor a resolved path.
      if (receiverUnproven(current.name) || current.visited.has(current.name)) {
        results.push({ prefix: null, resolved: false });
        continue;
      }
      // A served application anchors a path; if it is also mounted, its mounts
      // are real paths too. Unserved applications compose like routers.
      const root = rootApplications.has(current.name);
      if (root) results.push({ prefix: current.prefix, resolved: current.prefix !== null });
      const entries = mounts.get(current.name) || [];
      if (entries.length === 0) {
        if (!root) results.push({ prefix: null, resolved: false });
        continue;
      }
      const visited = new Set(current.visited).add(current.name);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        // Refuse the entire resolution rather than emit a misleading partial path list.
        if (remainingMountStates-- <= 0) {
          mountResolutions.set(routerName, unresolved);
          return unresolved;
        }
        const entry = entries[i];
        pending.push({
          name: entry.parent,
          prefix: entry.prefix === null || current.prefix === null ? null : normalizeJoinedPath(entry.prefix, current.prefix),
          visited,
        });
      }
    }
    mountResolutions.set(routerName, results);
    return results;
  }

  function emitRoute(method, routePaths, routerName, unresolvedPath, sourceNode) {
    const paths = routePaths || ["<dynamic>"];
    for (const path of paths) {
      const pathUnresolved = unresolvedPath || path === null;
      const routePath = pathUnresolved ? "<dynamic>" : path;
      if (expressBindingAmbiguous || receiverUnproven(routerName)) {
        addFinding("integration_contract", `Express ${method.toUpperCase()} ${routePath} (framework binding unresolved)`,
          `${method.toUpperCase()} ${routePath}`, "unresolved_framework", sourceNode);
        continue;
      }
      if (conditionalCalls.has(sourceNode)) {
        addFinding("integration_contract", `Express ${method.toUpperCase()} ${routePath} (registration conditional)`,
          `${method.toUpperCase()} ${routePath}`, "unresolved_conditional", sourceNode);
        continue;
      }
      for (const mount of resolveMounts(routerName)) {
        if (mount.resolved && !pathUnresolved) {
          const joined = normalizeJoinedPath(mount.prefix, routePath);
          addFinding("integration_contract", `Express ${method.toUpperCase()} ${joined}`, `${method.toUpperCase()} ${joined}`, "resolved", sourceNode);
        } else {
          const suffix = pathUnresolved ? "path unresolved" : "mount prefix unresolved";
          const local = pathUnresolved ? "<dynamic>" : routePath;
          addFinding("integration_contract", `Express ${method.toUpperCase()} ${local} (${suffix})`, `${method.toUpperCase()} ${local}`, pathUnresolved ? "unresolved_path" : "unresolved_mount", sourceNode);
        }
      }
    }
  }

  const routeChainBases = new WeakMap();
  function routeChainBase(call) {
    const trail = [];
    let base = null;
    while (call?.type === "CallExpression") {
      if (routeChainBases.has(call)) { base = routeChainBases.get(call); break; }
      const member = callMethod(call);
      trail.push(call);
      if (member?.property === "route") { base = call; break; }
      if (!member || !ROUTE_METHODS.has(member.property)) break;
      call = member.object;
    }
    for (const item of trail) routeChainBases.set(item, base);
    return base;
  }

  walk(ast, (node) => {
    const member = callMethod(node);
    if (!member) return;
    if (ROUTE_METHODS.has(member.property) && identifier(member.object)) {
      const name = identifier(member.object);
      if (applications.has(name) || routers.has(name) || mounts.has(name)) {
        // Express app.get(name) reads a setting; it does not register a route.
        if (applications.has(name) && member.property === "get" && node.arguments.length === 1) return;
        const paths = literalPaths(node.arguments?.[0]);
        emitRoute(member.property, paths, name, paths === null, node);
      }
      return;
    }
    // Express' `router.route('/x').get(handler)` chain is one registration.
    if (ROUTE_METHODS.has(member.property) && member.object?.type === "CallExpression") {
      const routeCall = routeChainBase(member.object);
      if (!routeCall) return;
      const routeMember = callMethod(routeCall);
      const name = identifier(routeMember.object);
      if (!name || (!applications.has(name) && !routers.has(name) && !mounts.has(name))) return;
      const paths = literalPaths(routeCall.arguments?.[0]);
      emitRoute(member.property, paths, name, paths === null, node);
      routeChainCalls.add(routeCall);
      return;
    }
    if (member.property === "route" && identifier(member.object)) {
      if (routeChainCalls.has(node)) return;
      const name = identifier(member.object);
      if (!applications.has(name) && !routers.has(name) && !mounts.has(name)) return;
      const paths = literalPaths(node.arguments?.[0]);
      emitRoute("route", paths, name, paths === null, node);
    }
  });

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    // A one-shot setTimeout is a delay, not a registration. A recurring timer
    // is kept as a hypothesis because it proves no scheduler or queue.
    if (identifier(node.callee) === "setInterval") {
      addFinding("hypothesis", "setInterval recurring timer (no scheduler binding)", "setInterval", "timer_only", node);
      return;
    }
    const member = callMethod(node);
    const callee = node.callee?.type === "MemberExpression" ? node.callee : null;
    if (callee && identifier(callee.object) === "React" && propertyName(callee.property) === "createElement") {
      const name = identifier(node.arguments?.[0]) || (node.arguments?.[0]?.type === "StringLiteral" ? node.arguments[0].value : null);
      if (isComponentName(name)) addFinding("ux_behavior", `React element ${name}`, name, "resolved", node);
      return;
    }
    if (!member || !WORKFLOW_METHODS.has(member.property)) return;
    const objectName = identifier(member.object);
    const binding = schedulerBindings.get(objectName);
    if (binding && !bindingUnstable(objectName) && !bindingUnstable(binding.root)) {
      const conditional = conditionalCalls.has(node);
      addFinding("workflow", `${binding.module} ${objectName}.${member.property} registration${conditional ? " (registration conditional)" : ""}`,
        `${objectName}.${member.property}`, conditional ? "unresolved_conditional" : "resolved", node);
    } else if (binding || (UNPROVEN_WORKFLOW_METHODS.has(member.property) && SCHEDULER_NAME.test(objectName))) {
      // Unknown schedulers stay a hypothesis: the receiver name is the only signal.
      addFinding("hypothesis", `${objectName}.${member.property} call (scheduler binding unresolved)`, `${objectName}.${member.property}`, "unresolved_scheduler", node);
    }
  });

  // Track JSX elements nested inside a component definition. Relationship
  // edges represent only explicit syntax in the same AST; imported or dynamic
  // components are not resolved across files.
  function nextUiFrames(node, state, parent) {
    if (node.type === "JSXElement") {
      const tag = componentName(node.openingElement?.name);
      const component = isComponentName(tag);
      if (component) {
        addFinding("ux_behavior", `JSX component ${tag}`, tag, "resolved", node);
        addRelationship(state.jsxParent || state.currentComponent, tag);
      }
      const next = { ...state, jsxParent: component ? tag : state.jsxParent };
      const frames = node.children.map((child) => ({ node: child, parent: node, state: next }));
      for (const attribute of node.openingElement.attributes) frames.push({ node: attribute, parent: node.openingElement, state: next });
      return frames;
    }
    if (node.type === "JSXFragment") return node.children.map((child) => ({ node: child, parent: node, state }));
    const excluded = new Set(["loc", "start", "end", "extra", "comments", "tokens", "openingElement", "closingElement", "children"]);
    return childNodes(node, excluded).map((child) => ({ node: child, parent: node, state }));
  }

  function visitUi(root) {
    const pending = [{ node: root, parent: null, state: { currentComponent: null, jsxParent: null } }];
    while (pending.length) {
      const frame = pending.pop();
      const { node, parent } = frame;
      let state = frame.state;
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        const declared = functionComponentName(node, parent);
        if (declared && containsJsx(node.body)) {
          addFinding("ux_behavior", `React component definition ${declared}`, declared, "resolved", node);
          state = { currentComponent: declared, jsxParent: null };
        }
      } else if (node.type === "ClassDeclaration" && isComponentName(node.id?.name) && containsJsx(node.body)) {
        addFinding("ux_behavior", `React component definition ${node.id.name}`, node.id.name, "resolved", node);
        state = { currentComponent: node.id.name, jsxParent: null };
      }
      const children = nextUiFrames(node, state, parent);
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]);
    }
  }
  visitUi(ast);

  return { findings, relationships, parse_status: "parsed", parse_error: null };
}

module.exports = { inspectSource };
