"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const parser = require("./business-discovery-source-parser.js");

test("resolves literal Express registrations through static nested router mounts", () => {
  const result = parser.inspectSource(`
    import express from "express";
    const app = express();
    app.listen(3000);
    const api = express.Router();
    const orders = express.Router();
    app.use("/api", api);
    api.use("/v1", orders);
    orders.route("/orders/:id").patch(updateOrder);
  `);
  assert.equal(result.parse_status, "parsed");
  assert.deepEqual(result.findings.filter((item) => item.kind === "integration_contract").map((item) => item.subject), ["PATCH /api/v1/orders/:id"]);
});

test("COORD-582: unrelated express imports are excluded and ambiguous bindings stay explicit", () => {
  for (const source of [
    `import express from "unrelated"; const app=express(); app.get("/x", handler);`,
    `const express=require("other-package"); const app=express(); app.get("/x", handler);`,
  ]) {
    const result = parser.inspectSource(source);
    assert.equal(result.findings.some((item) => item.kind === "integration_contract"), false, source);
  }
  for (const source of [
    `const express = makeOtherThing(); const app=express(); app.get("/x", handler);`,
    `function build(express) { const app=express(); app.get("/x", handler); }`,
    `const express=require("express"); express=other; const app=express(); app.get("/x", handler);`,
    `import expressFactory from "express"; const app=express(); app.get("/x", handler);`,
    `const build = ({express}) => { const app=express(); app.get("/x", handler); };`,
  ]) {
    const result = parser.inspectSource(source);
    assert.ok(result.findings.some((item) => item.kind === "integration_contract" && item.resolution_status === "unresolved_framework"), source);
  }
});

test("COORD-582: actual Express imports remain recognized", () => {
  for (const source of [
    `import express from "express"; const app=express(); app.get("/x", handler);`,
    `const express=require("express"); const app=express(); app.get("/x", handler);`,
    `const app=express(); app.get("/x", handler);`,
  ]) {
    const result = parser.inspectSource(source);
    assert.ok(result.findings.some((item) => item.kind === "integration_contract" && item.subject === "GET /x"), source);
  }
});

test("COORD-582: bare Router bindings are checked against import and shadow provenance", () => {
  const unrelated = parser.inspectSource(`import { Router } from "unrelated"; const router=Router(); router.get("/x", handler);`);
  assert.equal(unrelated.findings.some((item) => item.kind === "integration_contract"), false);

  const ambiguous = parser.inspectSource(`function build(Router) { const router=Router(); router.get("/x", handler); }`);
  assert.ok(ambiguous.findings.some((item) => item.kind === "integration_contract" && item.resolution_status === "unresolved_framework"));

  const imported = parser.inspectSource(`import { Router } from "express"; const router=Router(); router.get("/x", handler);`);
  assert.ok(imported.findings.some((item) => item.kind === "integration_contract" && item.subject === "GET /x"));
});

test("COORD-582: statically proven Router factory aliases preserve Express route evidence", () => {
  const sources = [
    `const express = require("express"); const { Router: makeRouter } = require("express"); const app=express(); app.listen(3000); const r=makeRouter(); app.use("/api",r); r.get("/x",handler);`,
    `import express, { Router as makeRouter } from "express"; const app=express(); app.listen(3000); const r=makeRouter(); app.use("/api",r); r.get("/x",handler);`,
  ];
  for (const source of sources) {
    const result = parser.inspectSource(source);
    assert.ok(result.findings.some((item) => item.kind === "integration_contract" &&
      item.subject === "GET /api/x" && item.resolution_status === "resolved"), source);
  }
});

test("COORD-582: Router alias destructuring defaults, rest, and nested patterns stay source-proven", () => {
  const defaultAlias = parser.inspectSource(`const express=require("express"); const { Router: makeRouter = fallback, ...rest }=require("express"); const app=express(); app.listen(3000); const r=makeRouter(); app.use("/api",r); r.get("/x",handler);`);
  assert.ok(defaultAlias.findings.some((item) => item.subject === "GET /api/x" && item.resolution_status === "resolved"));

  const nestedAlias = parser.inspectSource(`const express=require("express"); const { Router: { makeRouter } }=require("express"); const app=express(); const r=makeRouter(); app.use("/api",r); r.get("/x",handler);`);
  assert.ok(nestedAlias.findings.some((item) => item.kind === "integration_contract" && item.resolution_status !== "resolved"));

  const arrayShadow = parser.inspectSource(`import express, { Router as makeRouter } from "express"; function build([, makeRouter]) { const app=express(); const r=makeRouter(); app.use("/api",r); r.get("/x",handler); }`);
  assert.ok(arrayShadow.findings.some((item) => item.kind === "integration_contract" && item.resolution_status !== "resolved"));

  const localShadow = parser.inspectSource(`import express, { Router as makeRouter } from "express"; function build() { const makeRouter=fake; const app=express(); const r=makeRouter(); app.use("/api",r); r.get("/x",handler); }`);
  assert.ok(localShadow.findings.some((item) => item.kind === "integration_contract" && item.resolution_status !== "resolved"));
});

test("COORD-582: unrelated and shadowed Router aliases do not become trusted Express factories", () => {
  for (const source of [
    `const { Router: makeRouter } = require("other-package"); const r=makeRouter(); r.get("/x",handler);`,
    `import { Router as makeRouter } from "other-package"; const r=makeRouter(); r.get("/x",handler);`,
  ]) {
    assert.equal(parser.inspectSource(source).findings.some((item) => item.kind === "integration_contract"), false, source);
  }
  const shadowed = parser.inspectSource(`import { Router as makeRouter } from "express"; function build(makeRouter) { const r=makeRouter(); r.get("/x",handler); }`);
  assert.ok(shadowed.findings.some((item) => item.kind === "integration_contract" &&
    item.resolution_status === "unresolved_framework"));
  assert.equal(shadowed.findings.some((item) => item.kind === "integration_contract" &&
    item.resolution_status === "resolved"), false);
});

test("COORD-582: non-Express and dynamic Router bindings remain untrusted", () => {
  const expressModuleFunction = parser.inspectSource(`const Router=require("express"); const app=Router(); app.get("/x",handler);`);
  assert.ok(expressModuleFunction.findings.some((item) => item.kind === "integration_contract" && item.resolution_status !== "resolved"));

  const unrelatedModuleFunction = parser.inspectSource(`const Router=require("other-package"); const r=Router(); r.get("/x",handler);`);
  assert.equal(unrelatedModuleFunction.findings.some((item) => item.kind === "integration_contract"), false);

  const dynamicModuleFunction = parser.inspectSource(`const Router=loadRouter(); const r=Router(); r.get("/x",handler);`);
  assert.ok(dynamicModuleFunction.findings.some((item) => item.kind === "integration_contract" && item.resolution_status !== "resolved"));

  const unrelatedDestructure = parser.inspectSource(`const {Other: Router}=require("other-package"); const r=Router(); r.get("/x",handler);`);
  assert.equal(unrelatedDestructure.findings.some((item) => item.kind === "integration_contract"), false);
});

test("COORD-582: source findings include the exact syntax location", () => {
  const source = `const app=express();\napp.get("/orders", handler);`;
  const finding = parser.inspectSource(source).findings.find((item) => item.kind === "integration_contract");
  assert.deepEqual(finding.source_location, { line_start: 2, line_end: 2, offset: source.indexOf("app.get") });
});

test("keeps dynamic Express path and mount registrations explicit and unresolved", () => {
  const result = parser.inspectSource(`
    const express = require("express"); const app = express();
    const router = express.Router();
    app.use(prefixFromConfig, router);
    router.get(routeFromConfig, handler);
  `);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].resolution_status, "unresolved_path");
  assert.equal(result.findings[0].subject, "GET <dynamic>");
});

test("does not guess a route's full path when only its router mount is dynamic", () => {
  const result = parser.inspectSource(`
    const express = require("express"); const app = express();
    const router = express.Router();
    app.use(configuredPrefix, router);
    router.get("/orders", handler);
  `);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].resolution_status, "unresolved_mount");
  assert.equal(result.findings[0].subject, "GET /orders");
});

test("reports same-file JSX containment edges and ignores intrinsic elements", () => {
  const result = parser.inspectSource(`
    export function OrdersPage() { return <PageLayout><OrderList><OrderRow /></OrderList></PageLayout>; }
    function PageLayout({ children }) { return <main>{children}</main>; }
  `);
  assert.deepEqual(result.relationships, [
    { from: "OrdersPage", type: "contains_component", to: "PageLayout" },
    { from: "PageLayout", type: "contains_component", to: "OrderList" },
    { from: "OrderList", type: "contains_component", to: "OrderRow" },
  ]);
  assert.equal(result.findings.some((item) => item.subject === "main"), false);
});

test("does not treat comments and strings as executable registrations", () => {
  const result = parser.inspectSource(`
    // app.get("/fake", handler)
    const example = "cron.schedule('*', fake)";
    const pattern = /router.post\\('fake'\\)/;
  `);
  assert.deepEqual(result.findings, []);
});

test("reports syntax failures without guessing source registrations", () => {
  const result = parser.inspectSource("const broken = <OrdersPage>");
  assert.equal(result.parse_status, "unparsed");
  assert.deepEqual(result.findings, []);
  assert.ok(result.parse_error);
});

test("reports React createElement component syntax without executing the module", () => {
  const result = parser.inspectSource("const node = React.createElement(OrderPanel, { compact: true });");
  assert.ok(result.findings.some((item) => item.kind === "ux_behavior" && item.subject === "OrderPanel"));
});

test("rejects source beyond the byte bound with an explicit skipped status", () => {
  const result = parser.inspectSource(" ".repeat(32), { maxBytes: 16 });
  assert.equal(result.parse_status, "skipped_too_large");
  assert.deepEqual(result.findings, []);
});

test("covers static template and array route declarations while preserving unresolved expressions", () => {
  const source = [
    'const express = require("express"); const app = express(); app.listen(3000);',
    'const api = express.Router();',
    'app.use(["/v1", "/v2"], api);',
    'api.get(`/orders`, handler);',
    'api.post(routePrefix + "/orders", handler);',
  ].join("\n");
  const result = parser.inspectSource(source);
  assert.equal(result.parse_status, "parsed");
  assert.deepEqual(result.findings.filter((item) => item.kind === "integration_contract").map((item) => item.subject), [
    "GET /v1/orders", "GET /v2/orders", "POST <dynamic>",
  ]);
});

test("covers path root normalization and duplicate route evidence", () => {
  const result = parser.inspectSource(`
    const express = require("express"); const app = express(); app.listen(3000);
    const api = express.Router();
    app.use("/api/", api);
    api.get("/", handler);
    api.get("/", handler);
  `);
  assert.deepEqual(result.findings.filter((item) => item.kind === "integration_contract").map((item) => item.subject), ["GET /api/"]);
});

test("covers React member names and function component declaration forms", () => {
  const result = parser.inspectSource(`
    function Declared() { return <Widgets.OrderList />; }
    const Assigned = function Named() { return <div><OrderRow /></div>; };
    let Arrow;
    Arrow = () => <OrderCell />;
    class ClassPage extends React.Component { render() { return <Panel />; } }
    const element = React["createElement"](OrderCard, {});
  `);
  const subjects = result.findings.filter((item) => item.kind === "ux_behavior").map((item) => item.subject);
  for (const name of ["Declared", "Widgets.OrderList", "Named", "OrderRow", "Arrow", "OrderCell", "ClassPage", "Panel", "OrderCard"]) {
    assert.ok(subjects.includes(name), `expected ${name}`);
  }
});

test("covers workflow variants and nested function JSX exclusion", () => {
  const result = parser.inspectSource(`
    const app = express();
    app.get("/health", handler);
    setTimeout(() => { function Inner() { return <Hidden />; } }, 10);
    const cron = createCron();
    cron.schedule("* * * * *", run);
    const fromFragment = <><Visible /></>;
  `);
  assert.equal(result.findings.some((item) => item.subject === "setTimeout"), false, "a one-shot delay is not a registration");
  assert.ok(result.findings.some((item) => item.kind === "hypothesis" && item.subject === "cron.schedule"));
  assert.ok(result.findings.some((item) => item.subject === "Visible"));
  assert.ok(result.findings.some((item) => item.subject === "Hidden"), "a nested function is still analyzed as its own component");
  assert.equal(result.findings.some((item) => item.subject === "<anonymous>"), false);
});

test("treats non-string inputs as empty source and reports invalid syntax without findings", () => {
  assert.equal(parser.inspectSource(null).parse_status, "parsed");
  assert.equal(parser.inspectSource("const x = 1", { truncated: true }).parse_status, "skipped_too_large");
  const invalid = parser.inspectSource("export default (");
  assert.equal(invalid.parse_status, "unparsed");
  assert.deepEqual(invalid.findings, []);
});


test("covers mount aliases, one-argument mounts, cycles, and unknown parents without guessing", () => {
  const result = parser.inspectSource(`
    const express = require("express"); const { Router } = require("express"); const app = express(); app.listen(3000);
    const first = Router();
    const second = express.Router();
    app.use(first);
    first.use("/second", second);
    second.use("/cycle", first);
    second.get("/orders", handler);
    const missing = express.Router();
    container.use("/unresolved", missing);
    missing.get("/items", handler);
  `);
  assert.ok(result.findings.some((item) => item.subject === "GET /second/orders" && item.resolution_status === "resolved"));
  assert.ok(result.findings.some((item) => item.subject === "GET /orders" && item.resolution_status === "unresolved_mount"));
  assert.ok(result.findings.some((item) => item.subject === "GET /items" && item.resolution_status === "unresolved_mount"));
});

test("covers empty anonymous and assignment component declarations plus JSX attributes", () => {
  const result = parser.inspectSource(`
    const Anonymous = function () { return <div><Row dataCell={<Cell />} /></div>; };
    let Assigned;
    Assigned = () => <><Nested /></>;
    const topLevel = <Solo />;
  `);
  const subjects = result.findings.filter((item) => item.kind === "ux_behavior").map((item) => item.subject);
  for (const name of ["Anonymous", "Row", "Cell", "Assigned", "Nested", "Solo"]) assert.ok(subjects.includes(name), name);
  assert.ok(result.relationships.some((item) => item.from === "Anonymous" && item.to === "Row"));
  assert.ok(result.relationships.some((item) => item.from === "Row" && item.to === "Cell"));
  assert.equal(result.relationships.some((item) => item.to === "Solo"), false);
});

test("filters nonliteral paths and ignores intrinsic React.createElement tags", () => {
  const result = parser.inspectSource([
    'const express = require("express"); const app = express(); app.listen(3000);',
    'const api = express.Router();',
    'app.use(["/v1", dynamicPrefix, 4], api);',
    'api.get(`/orders`, handler);',
    'React.createElement("section", {});',
    'React.createElement(UnknownComponent, {});',
  ].join("\n"));
  assert.ok(result.findings.some((item) => item.subject === "GET /v1/orders"));
  assert.ok(result.findings.some((item) => item.subject === "UnknownComponent"));
  assert.equal(result.findings.some((item) => item.subject === "section"), false);
});

test("covers path-less direct and mounted app routes and preserves source-only behavior", () => {
  const result = parser.inspectSource(`
    const app = express();
    const api = express.Router();
    app.get("/", handler);
    app.use(api);
    api.get("/", handler);
    const queue = makeWorker();
    queue.process(task);
  `);
  assert.ok(result.findings.some((item) => item.subject === "GET /"));
  assert.ok(result.findings.some((item) => item.subject === "process" || item.subject === "queue.process"));
});


test("covers direct app routes, unknown route objects, route chains, and string React components", () => {
  const result = parser.inspectSource([
    'const app = express();',
    'const api = express.Router();',
    'app.get("/direct", handler);',
    'app.get(dynamicRoute, handler);',
    'unknown.get("/ignored", handler);',
    'unknown.route("/ignored").get(handler);',
    'api.use("/group", another).get("/ignored", handler);',
    'api.route("/orders").get(handler);',
    'React.createElement("OrderBadge", {});',
    'React[`${method}`]("/x");',
  ].join("\n"));
  assert.ok(result.findings.some((item) => item.subject === "GET /direct"));
  assert.ok(result.findings.some((item) => item.subject === "GET <dynamic>"));
  assert.ok(result.findings.some((item) => item.subject === "OrderBadge"));
  assert.equal(result.findings.some((item) => item.subject === "GET /ignored"), false);
});

test("covers unsupported JSX names and suppresses duplicate or self containment edges", () => {
  const result = parser.inspectSource([
    'function Same() { return <Same><svg:path /><Child /><Child /></Same>; }',
    'const unrelated = <lowercase />;',
  ].join("\n"));
  assert.ok(result.findings.some((item) => item.subject === "Same"));
  assert.ok(result.findings.some((item) => item.subject === "Child"));
  assert.equal(result.findings.some((item) => item.subject === "Lowercase"), false);
  assert.equal(result.findings.some((item) => item.subject === "svg:path"), false);
  assert.equal(result.relationships.filter((item) => item.from === "Same" && item.to === "Child").length, 1);
  assert.equal(result.relationships.some((item) => item.from === "Same" && item.to === "Same"), false);
});

test("covers tagged templates, static Router constructors, scheduler aliases, and standalone route declarations", () => {
  const result = parser.inspectSource([
    'const express = require("express"); const { Router } = require("express"); const app = express(); app.listen(3000);',
    'const api = new Router();',
    'app.use("/api", api);',
    'api.get(tag`/raw\\8`, handler);',
    'api.route("/standalone");',
    'const jobs = new agenda.Queue();',
    'jobs.process(task);',
  ].join("\n"));
  assert.ok(result.findings.some((item) => item.subject === "GET <dynamic>" && item.resolution_status === "unresolved_path"));
  assert.ok(result.findings.some((item) => item.subject === "ROUTE /api/standalone"));
  assert.ok(result.findings.some((item) => item.subject === "jobs.process"));
});

test("covers unsupported dynamic React member names and a tagged noncomponent name", () => {
  const result = parser.inspectSource([
    'React[`${method}`]("/ignored");',
    'React.createElement(makeComponent(), {});',
    'const view = <svg:path />;',
  ].join("\n"));
  assert.equal(result.findings.length, 0);
});

test("does not infer a component from nested callback JSX or JSX-free functions", () => {
  const result = parser.inspectSource([
    'function CallbackOwner() { const callback = () => <NestedOnly />; return null; }',
    'function PlainUtility() { return 1; }',
    'const api = {}; api.add(handler);',
  ].join("\n"));
  assert.ok(result.findings.some((item) => item.subject === "NestedOnly"));
  assert.equal(result.findings.some((item) => item.subject === "CallbackOwner"), false);
  assert.equal(result.findings.some((item) => item.subject === "PlainUtility"), false);
  assert.equal(result.findings.some((item) => item.subject === "api.add"), false);
});

test("COORD-582: deep mount chains stay within the source bound without recursive overflow", () => {
  const count = 4000;
  let source = "const express=require('express');\nconst app=express();\napp.listen(3000);\n";
  for (let i=0;i<count;i++) source += `const r${i}=express.Router();\n`;
  source += "app.use('/x',r0);\n";
  for (let i=1;i<count;i++) source += `r${i-1}.use(r${i});\n`;
  source += `r${count-1}.get('/end',handler);`;
  assert.ok(Buffer.byteLength(source) < 250000);
  const result = parser.inspectSource(source);
  assert.equal(result.parse_status, "parsed");
  assert.ok(result.findings.some(f=>f.subject === "GET /x/end" && f.resolution_status === "resolved"));
});

test("COORD-582: mount DAG path expansion is bounded and never reports a partial resolved list", () => {
  let source = "const express=require('express');\nconst app=express();\n";
  for(let i=0;i<16;i++) source += `const r${i}=express.Router();\n`;
  source += "app.use('/root',r0);\n";
  for(let i=1;i<16;i++) source += `r${i-1}.use('/a',r${i}); r${i-1}.use('/b',r${i});\n`;
  source += "r15.get('/end',handler); r15.post('/end',handler); r0.get('/late',handler);";
  const result = parser.inspectSource(source);
  const routes = result.findings.filter(f=>f.kind === "integration_contract");
  assert.equal(routes.length, 3);
  assert.ok(routes.every(route => route.resolution_status === "unresolved_mount"));
  assert.equal(routes[0].resolution_status, "unresolved_mount");
  assert.equal(routes[0].subject, "GET /end");
});

test("COORD-582: Express settings lookups are not route registrations", () => {
  const result = parser.inspectSource(`const app=express(); app.get('env'); app.get('view engine'); app.get('/actual',handler);`);
  assert.deepEqual(result.findings.filter(f=>f.kind === 'integration_contract').map(f=>f.subject), ['GET /actual']);
});

test("COORD-582: deep JSX member names do not recurse on the JavaScript stack", () => {
  const name = 'A' + '.B'.repeat(30000);
  const source = 'const value=<' + name + '/>;';
  assert.ok(Buffer.byteLength(source) < 250000);
  const result = parser.inspectSource(source);
  assert.equal(result.parse_status, 'parsed');
  assert.ok(result.findings.some(f=>f.kind === 'ux_behavior' && f.subject === name));
});


test("preserves unresolved entries in route arrays and every method in route chains", () => {
  const result = parser.inspectSource(`
    const express = require("express"); const app = express(); app.listen(3000);
    const router = express.Router();
    app.use(["/known", dynamicMount], router);
    router.route("/orders").get(read).post(create).delete(remove);
    app.get(["/literal", dynamicPath, ...otherPaths], handler);
    app.post([dynamicOnly], handler);
    app.route("/ignored").custom().get(handler);
  `);
  const routes = result.findings.filter(item => item.kind === "integration_contract");
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.ok(routes.some(item => item.subject === `${method} /known/orders` && item.resolution_status === "resolved"));
    assert.ok(routes.some(item => item.subject === `${method} /orders` && item.resolution_status === "unresolved_mount"));
  }
  assert.ok(routes.some(item => item.subject === "GET /literal" && item.resolution_status === "resolved"));
  for (const method of ["GET", "POST"]) assert.ok(routes.some(item => item.subject === `${method} <dynamic>` && item.resolution_status === "unresolved_path"));
  assert.equal(routes.some(item => item.subject === "GET /ignored"), false);
});


test("source limits can narrow the hard byte bound but cannot disable or enlarge it", () => {
  const tooLarge = " ".repeat(250_001);
  for (const maxBytes of [300_000, Infinity, NaN, -1, 0, "300000"]) {
    assert.equal(parser.inspectSource(tooLarge, { maxBytes }).parse_status, "skipped_too_large");
  }
  assert.equal(parser.inspectSource("const ok = 1;", { maxBytes: 300_000 }).parse_status, "parsed");
});


test("binding uncertainty covers declaration, assignment and catch patterns", () => {
  for (const declaration of [
    "function express() {}", "const express = function() {};", "class express {}", "let express; express++;",
    "let express; ({express} = object);", "const {express} = object;", "import {factory as express} from 'express';",
    "const build = (express = factory) => {};", "const build = (...express) => {};", "try {} catch(express) {}",
    "function Router() {}", "class Router {}", "let Router; Router++;", "let Router; ({Router} = object);",
    "try {} catch(Router) {}", "const {Other:Router} = require('express');", "import Router from 'express';",
    "const Router = unknown;", "const build = ({Router}) => {};",
    "const express = require('express'); function nested(){ const express = require('other'); }",
    "import {Router} from 'express'; function nested(){const Router = require('other');}",
  ]) {
    const result = parser.inspectSource(`${declaration}; const app=express(); const router=Router(); app.use('/api',router); router.get('/x',h); app.post('/y',h);`);
    assert.equal(result.parse_status, "parsed", declaration);
    assert.ok(result.findings.some(f => f.resolution_status === "unresolved_framework"), declaration);
    assert.equal(result.findings.some(f => f.resolution_status === "resolved"), false, declaration);
  }
  for (const source of [
    "import * as express from 'express'; const app=express(); app.listen(3000); const router=express.Router(); app.use('/api',router); router.get('/x',h);",
    "const express = require('express'); const {Router} = require('express'); const app=express(); app.listen(3000); const router=Router(); app.use('/api',router); router.get('/x',h);",
  ]) {
    const result = parser.inspectSource(source);
    assert.ok(result.findings.some(f => f.subject === 'GET /api/x' && f.resolution_status === 'resolved'), source);
  }
});

test("COORD-582 F3: a route is resolved only when its receiver binding is proven", () => {
  const routes = (source) => {
    const result = parser.inspectSource(source);
    assert.equal(result.parse_status, "parsed", source);
    return result.findings.filter((item) => item.kind === "integration_contract");
  };
  const express = `const express = require("express");`;
  for (const source of [
    // The same name is bound to another framework in a sibling function.
    `${express} const Koa = require("koa"); function a() { const app = express(); app.get("/x", h); } function b() { const app = new Koa(); app.get("/y", h); }`,
    // Reassigned after creation.
    `${express} let app = express(); app = makeOther(); app.get("/x", h);`,
    `${express} let app = express(); for (app of others) {} app.get("/x", h);`,
    `${express} let app = express(); for (app in others) {} app.get("/x", h);`,
    // Shadowed by a parameter.
    `${express} const app = express(); function register(app) { app.get("/x", h); }`,
    `${express} const app = express(); class Api { register(app) { app.get("/x", h); } }`,
    // No import or require of express at all.
    `const app = express(); app.get("/x", h);`,
    `const router = express.Router(); router.get("/x", h);`,
    `const app = express(); const router = Router(); app.use("/v1", router); router.get("/x", h);`,
  ]) {
    const found = routes(source);
    assert.ok(found.length > 0, source);
    assert.deepEqual(found.filter((item) => item.resolution_status !== "unresolved_framework"), [], source);
  }

  // A router whose mount chain passes through an unproven binding stays unresolved.
  for (const source of [
    `${express} let app = express(); app = makeOther(); const router = express.Router(); app.use("/v1", router); router.get("/x", h);`,
    `import { Router } from "express"; const app = express(); const router = Router(); app.use("/v1", router); router.get("/x", h);`,
  ]) {
    assert.deepEqual(routes(source).map((item) => [item.subject, item.resolution_status]), [["GET /x", "unresolved_mount"]], source);
  }

  // A conditional mount or registration is never reported as certain.
  for (const guard of ["if (flag) MOUNT;", "flag && MOUNT;", "flag ? MOUNT : null;", "for (const v of versions) MOUNT;",
    "while (more()) MOUNT;", "do MOUNT; while (more());", "try { MOUNT; } catch {}", "switch (mode) { case 1: MOUNT; }",
    "for (; more();) MOUNT;", "for (const k in versions) MOUNT;", "flag || MOUNT;", "flag ?? MOUNT;", "app?.use('/v1', router);"]) {
    const source = `${express} const app = express(); app.listen(3000); const router = express.Router(); ${guard.replace("MOUNT", `app.use("/v1", router)`)} router.get("/x", h);`;
    assert.deepEqual(routes(source).map((item) => [item.subject, item.resolution_status]), [["GET /x", "unresolved_mount"]], source);
  }
  // A loop that never ends hides the registration after it, not only the mount inside it.
  assert.deepEqual(routes(`${express} const app = express(); app.listen(3000); const router = express.Router(); for (;;) app.use("/v1", router); router.get("/x", h);`)
    .map((item) => [item.subject, item.resolution_status]), [["GET /x", "unresolved_conditional"]]);
  assert.deepEqual(
    routes(`${express} const app = express(); app.listen(3000); if (flag) app.get("/x", h); if (flag) app.route("/y").post(h); app.get("/z", h);`)
      .map((item) => [item.subject, item.resolution_status]),
    [["GET /x", "unresolved_conditional"], ["POST /y", "unresolved_conditional"], ["GET /z", "resolved"]]
  );
  // An unconditional mount beside a conditional one keeps both answers.
  assert.deepEqual(
    routes(`${express} const app = express(); app.listen(3000); const router = express.Router(); app.use("/v2", router); if (flag) app.use("/v1", router); router.get("/x", h);`)
      .map((item) => [item.subject, item.resolution_status]).sort(),
    [["GET /v2/x", "resolved"], ["GET /x", "unresolved_mount"]]
  );
  // The proven straight-line form is still resolved at module level and in an immediately invoked factory.
  assert.deepEqual(
    routes(`${express} (() => { const app = express(); const router = express.Router(); app.use("/v1", router); router.get("/x", h); app.listen(3000); })();`)
      .map((item) => [item.subject, item.resolution_status]),
    [["GET /v1/x", "resolved"]]
  );
  // A factory the file never calls is not proven to run (human-admin ruling 2026-10-14).
  assert.deepEqual(
    routes(`${express} function build() { const app = express(); const router = express.Router(); app.use("/v1", router); router.get("/x", h); app.listen(3000); return app; }`)
      .map((item) => [item.subject, item.resolution_status]),
    [["GET /x", "unresolved_conditional"]]
  );
});

test("COORD-582 F4: workflow evidence requires a proven scheduler or queue binding", () => {
  const found = (source) => {
    const result = parser.inspectSource(source);
    assert.equal(result.parse_status, "parsed", source);
    return result.findings.filter((item) => item.kind === "workflow" || item.kind === "hypothesis")
      .map((item) => [item.kind, item.subject, item.resolution_status]);
  };

  // A scheduler-sounding name, a collection method or a one-shot timer is not a registration.
  assert.deepEqual(found(`const workerSet = new Set(); workerSet.add(x); const jobQueue = []; jobQueue.add(1); setTimeout(done, 10);`), []);

  // Receivers bound from a scheduler or queue module are resolved, whatever they are called.
  for (const [source, subject] of [
    [`import nc from "node-cron"; nc.schedule("* * * * *", run);`, "nc.schedule"],
    [`const { scheduleJob: later } = require("node-schedule"); const s = require("node-schedule"); s.scheduleJob("* * * * *", run);`, "s.scheduleJob"],
    [`const Queue = require("bull"); const emails = new Queue("emails"); emails.process(send);`, "emails.process"],
    [`import { Queue as Q } from "bullmq"; const outbox = new Q("outbox"); outbox.add("send", {});`, "outbox.add"],
    [`import * as bull from "bullmq"; const outbox = new bull.Queue("outbox"); outbox.add("send", {});`, "outbox.add"],
  ]) {
    assert.deepEqual(found(source), [["workflow", subject, "resolved"]], source);
  }
  const labelled = parser.inspectSource(`const Queue = require("bull"); const emails = new Queue("emails"); emails.process(send);`).findings[0];
  assert.equal(labelled.label, "bull emails.process registration");

  // The same call shape without a proven binding is a hypothesis, never a workflow.
  for (const [source, subject] of [
    [`cron.schedule("* * * * *", run);`, "cron.schedule"],
    [`const queue = makeWorker(); queue.process(task);`, "queue.process"],
    [`import nc from "node-cron"; function later(nc) { nc.schedule("* * * * *", run); }`, "nc.schedule"],
    [`const Queue = require("bull"); let emails = new Queue("emails"); emails = other; emails.process(send);`, "emails.process"],
    [`let Queue = require("bull"); Queue = Other; const emails = new Queue("emails"); emails.add({});`, "emails.add"],
  ]) {
    assert.deepEqual(found(source), [["hypothesis", subject, "unresolved_scheduler"]], source);
  }

  // A recurring global timer is kept as a hypothesis; it proves no scheduler.
  assert.deepEqual(found(`setInterval(tick, 1000);`), [["hypothesis", "setInterval", "timer_only"]]);
  // Instances built from anything other than a scheduler binding stay unproven and unnamed ones are dropped.
  assert.deepEqual(found(`const Queue = require("bull"); const emails = new Other("emails"); emails.process(send); const t = new (pick())(); t.process(x);`), []);
});

const routeStates = (source) => {
  const result = parser.inspectSource(source);
  assert.equal(result.parse_status, "parsed", source);
  return result.findings.filter((item) => item.kind === "integration_contract")
    .map((item) => [item.subject, item.resolution_status]).sort();
};
const EXPRESS = `const express = require("express");`;

test("COORD-582 R1: an application's own paths are real only when the file proves it is served", () => {
  // A mounted application composes its prefix like a router; it is not a root of its own.
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); const admin=express(); admin.get("/users",h); app.use("/admin",admin);`),
    [["GET /users", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); const admin=express(); admin.get("/users",h); app.use("/admin",admin); app.listen(3000);`),
    [["GET /admin/users", "resolved"]]);
  const nested = `${EXPRESS} const app=express(); const admin=express(); app.use("/admin",admin); const r=express.Router(); r.get("/x",h); admin.use("/r",r);`;
  assert.deepEqual(routeStates(nested), [["GET /x", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${nested} app.listen(3000);`), [["GET /admin/r/x", "resolved"]]);
  // An exported sub-application has a mount this file cannot see.
  assert.deepEqual(routeStates(`${EXPRESS} const sub=express(); sub.post("/pay",h); module.exports=sub;`), [["POST /pay", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${EXPRESS} const sub=express(); sub.get(dynamicPath,h); module.exports=sub;`), [["GET <dynamic>", "unresolved_path"]]);
  // A served application that is also mounted reports both real paths.
  assert.deepEqual(routeStates(`${EXPRESS} const main=express(); const sub=express(); main.listen(1); sub.listen(2); main.use("/s",sub); sub.get("/x",h);`),
    [["GET /s/x", "resolved"], ["GET /x", "resolved"]]);
  // A served application reached through a cycle never anchors that cycle's path.
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); const r=express.Router(); app.listen(1); r.use("/loop",app); app.use("/r",r); r.get("/x",h);`),
    [["GET /r/x", "resolved"], ["GET /x", "unresolved_mount"]]);
});

test("COORD-582 R1: http and https server factories prove a root only through a stable module binding", () => {
  const served = (prelude, call) => routeStates(`${EXPRESS} ${prelude} const app=express(); app.get("/x",h); ${call}`);
  for (const [prelude, call] of [
    [`const http=require("http");`, `http.createServer(app).listen(80);`],
    [`import https from "https";`, `const server = https.createServer(options, app); server.listen(443);`],
    [`import * as http from "node:http";`, `http.createServer(app).listen(80);`],
    [`import { createServer } from "http";`, `createServer(app).listen(80);`],
    [`import { createServer as serve } from "node:https";`, `const server = serve(options, app); server.listen(443);`],
    [`const { createServer } = require("http");`, `createServer(app).listen(80);`],
    [`const { createServer: serve, request } = require("node:https");`, `serve(options, app).listen(443);`],
    [`const http=require("http");`, `async function main() { await ready(); http.createServer(app).listen(80); } main();`],
  ]) assert.deepEqual(served(prelude, call), [["GET /x", "resolved"]], `${prelude} ${call}`);
  for (const [prelude, call] of [
    // A server that is created but never listened on in reached code proves nothing is served.
    [`import https from "https";`, `https.createServer(options, app);`],
    [`import * as http from "node:http";`, `http.createServer(app);`],
    [`import { createServer } from "http";`, `createServer(app);`],
    [`import { createServer as serve } from "node:https";`, `serve(options, app);`],
    [`const http=require("http");`, `const server = http.createServer(app); module.exports = server;`],
    [`const http=require("http");`, `const server = http.createServer(app); if (main) server.listen(80);`],
    [`const http=require("http");`, `const server = http.createServer(app); function start() { server.listen(80); }`],
    [`const http=require("http");`, `const server = http.createServer(app); other.listen(80);`],
    [`const http=require("http");`, `let server = http.createServer(app); server = other; server.listen(80);`],
    [`const http=require("http");`, `const { server } = http.createServer(app); server.listen(80);`],
    [`const http=require("http");`, `const server = main ? http.createServer(app) : null; server.listen(80);`],
    [`const http=require("http");`, `if (main) http.createServer(app).listen(80);`],
    [`const http=require("http");`, `wrap(http.createServer(app)).listen(80);`],
    [``, `if (main) app.listen(80);`],
    [``, `function start() { app.listen(80); }`],
    [``, `unbound.createServer(app);`],
    [`const http=require("other");`, `http.createServer(app);`],
    [`let http=require("http"); http=other;`, `http.createServer(app);`],
    [`const http=require("http");`, `http.request(app);`],
    [`const http=require("http");`, `http.createServer(handler);`],
    [`const http=require("http");`, `nested.http.createServer(app);`],
    [`import { request as createServer } from "http";`, `createServer(app);`],
    [`const { request: createServer, ["createServer"]: computed, createServer: { inner }, ...rest } = require("http");`, `createServer(app); computed(app); inner(app); rest(app);`],
    [`const [createServer] = require("http");`, `createServer(app);`],
    [``, `makeFactory()(app); server.listen(80); factory.listen();`],
  ]) assert.deepEqual(served(prelude, call), [["GET /x", "unresolved_mount"]], `${prelude} ${call}`);
});

test("COORD-582 R2: a conditional scheduler registration is never a resolved workflow", () => {
  const workflows = (source) => parser.inspectSource(source).findings.filter((item) => item.kind === "workflow")
    .map((item) => [item.subject, item.resolution_status, item.label]);
  assert.deepEqual(workflows(`const cron=require("node-cron"); if (enabled) { cron.schedule("* * * * *", run); }`),
    [["cron.schedule", "unresolved_conditional", "node-cron cron.schedule registration (registration conditional)"]]);
  assert.deepEqual(workflows(`const cron=require("node-cron"); function later() { cron.schedule("* * * * *", run); }`),
    [["cron.schedule", "unresolved_conditional", "node-cron cron.schedule registration (registration conditional)"]]);
  assert.deepEqual(workflows(`const cron=require("node-cron"); cron.schedule("* * * * *", run);`),
    [["cron.schedule", "resolved", "node-cron cron.schedule registration"]]);
});

test("COORD-582 R3: registrations in a body the file does not prove runs are conditional", () => {
  const served = (body) => routeStates(`${EXPRESS} const app=express(); app.listen(80); ${body}`);
  // Module-level and immediately invoked registrations stay resolved.
  assert.deepEqual(served(`app.get("/top",h);`), [["GET /top", "resolved"]]);
  assert.deepEqual(served(`(() => { app.get("/arrow",h); })(); (function () { app.get("/fn",h); })(); (async () => { app.get("/async",h); })();`),
    [["GET /arrow", "resolved"], ["GET /async", "resolved"], ["GET /fn", "resolved"]]);
  assert.deepEqual(served(`(() => { (() => { app.get("/deep",h); })(); })();`), [["GET /deep", "resolved"]]);
  // Module-level functions called directly and unconditionally from proven code stay resolved.
  for (const body of [
    `function setup() { app.get("/s",h); } setup();`,
    `const setup = () => { app.get("/s",h); }; setup(app);`,
    `const setup = async function () { app.get("/s",h); }; setup();`,
    `export function setup() { app.get("/s",h); } setup(); export { setup as configure };`,
    `function outer() { setup(); } function setup() { app.get("/s",h); } outer();`,
    `function setup() { app.get("/s",h); setup.done || setup(); } setup(); setup();`,
    `(() => { setup(); })(); function setup() { app.get("/s",h); }`,
    // A static block runs when its class is defined (COORD-845).
    `class Api { static { app.get("/s",h); } }`,
  ]) assert.deepEqual(served(body), [["GET /s", "resolved"]], body);
  // Everything else is downgraded rather than guessed.
  for (const body of [
    `function later() { app.get("/s",h); }`,
    `[1, 2].forEach(() => { app.get("/s",h); });`,
    `module.exports = (a) => { app.get("/s",h); };`,
    `export default function () { app.get("/s",h); }`,
    `if (flag) setup(); function setup() { app.get("/s",h); }`,
    `function* setup() { app.get("/s",h); } setup();`,
    `(function* () { app.get("/s",h); })();`,
    `const setup = function* () { app.get("/s",h); }; setup();`,
    `(() => { function inner() { app.get("/s",h); } inner(); })();`,
    `function setup() { app.get("/s",h); } let alias = setup; alias(); setup.call(null);`,
    `let setup = () => { app.get("/s",h); }; setup = noop; setup();`,
    `const tasks = { setup() { app.get("/s",h); } }; tasks.setup();`,
    `class Api { register() { app.get("/s",h); } }`,
    `class Api { field = app.get("/s",h); }`,
    `class Api { #field = app.get("/s",h); }`,
    `class Api { #register() { app.get("/s",h); } }`,
    `const [setup] = [() => { app.get("/s",h); }]; setup();`,
    `app.listen(81, () => { app.get("/s",h); });`,
  ]) assert.deepEqual(served(body), [["GET /s", "unresolved_conditional"]], body);
  // A mount in an unreached body leaves the prefix unknown, and an unreached listen proves no root.
  assert.deepEqual(served(`const r=express.Router(); r.get("/x",h); function mount() { app.use("/r", r); }`), [["GET /x", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); app.get("/x",h); module.exports = () => app.listen(80);`), [["GET /x", "unresolved_mount"]]);
});

const CRON = `const cron=require("node-cron");`;
const workflowStates = (source) => parser.inspectSource(source).findings.filter((item) => item.kind === "workflow")
  .map((item) => [item.subject, item.resolution_status]);

test("COORD-582 R4: code after a return, throw, break or continue that can be taken is conditional", () => {
  // A reached body does not run top to bottom past an exit that can be taken.
  for (const body of [
    `function setup() { if (!enabled) return; cron.schedule("*", run); } setup();`,
    `function setup() { if (!enabled) throw new Error("off"); cron.schedule("*", run); } setup();`,
    `function setup() { return; cron.schedule("*", run); } setup();`,
    `function setup() { { if (!enabled) return; } cron.schedule("*", run); } setup();`,
    `(() => { if (!enabled) return; cron.schedule("*", run); })();`,
    `function setup() { if (!enabled) return; go(); } function go() { cron.schedule("*", run); } setup();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  // A served root is not proven when its listen call follows a guarded return.
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); app.get("/a",h); function main() { if (!process.env.PORT) return; app.listen(1); } main();`),
    [["GET /a", "unresolved_mount"]]);
  // Exits that cannot leave the statement holding them leave later code proven.
  for (const body of [
    `function setup() { return cron.schedule("*", run); } setup();`,
    `function setup() { [1].forEach(() => { return; }); cron.schedule("*", run); } setup();`,
    `function setup() { const stop = () => { throw new Error("x"); }; cron.schedule("*", run); } setup();`,
    `switch (mode) { case 1: break; default: break; } cron.schedule("*", run);`,
    `for (const item of items) { if (item) continue; } cron.schedule("*", run);`,
    `while (more) { if (done) break; } cron.schedule("*", run);`,
    `do { switch (mode) { case 1: continue; } } while (more); cron.schedule("*", run);`,
    `setup(); function setup() { cron.schedule("*", run); } function stop() { return; }`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
  // A hoisted function declared after an exit still runs when it is called before it.
  assert.deepEqual(workflowStates(`${CRON} setup(); throw new Error("stop"); function setup() { cron.schedule("*", run); }`),
    [["cron.schedule", "resolved"]]);
});

test("COORD-582 R5: a const or let function is reached only by a call after its declarator", () => {
  // Calling a `const`/`let` binding before its declarator throws (temporal dead zone).
  for (const body of [
    `setup(); const setup = () => { cron.schedule("*", run); };`,
    `setup(); let setup = function () { cron.schedule("*", run); };`,
    `const setup = () => { cron.schedule("*", run); setup(); };`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  // Declarations are hoisted, and a call after the declarator runs it.
  for (const body of [
    `setup(); function setup() { cron.schedule("*", run); }`,
    `const setup = () => { cron.schedule("*", run); }; setup();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R6: a labelled break or continue and process.exit() are exits", () => {
  for (const body of [
    `out: { break out; cron.schedule("*", run); }`,
    `out: { inner: { if (done) break out; } cron.schedule("*", run); }`,
    `process.exit(0); cron.schedule("*", run);`,
    `if (!enabled) process.exit(1); cron.schedule("*", run);`,
    `function setup() { process.exit(1); cron.schedule("*", run); } setup();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  // Control resumes after the labelled statement a labelled exit targets.
  for (const body of [
    `out: { if (done) break out; } cron.schedule("*", run);`,
    `outer: for (const a of items) { inner: for (const b of a) { continue outer; } } cron.schedule("*", run);`,
    `other.exit(0); exit(0); process.exitCode = 1; cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R7: a function invoked in place after a takeable exit is not proven to run", () => {
  for (const body of [
    `function setup() { if (!enabled) return; (() => { cron.schedule("*", run); })(); } setup();`,
    `process.exit(0); (() => { cron.schedule("*", run); })();`,
    `out: { break out; (function () { cron.schedule("*", run); })(); }`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  assert.deepEqual(routeStates(`${EXPRESS} const app=express(); app.get("/a",h); function main() { if (!port) return; (() => app.listen(1))(); } main();`),
    [["GET /a", "unresolved_mount"]]);
  // An unguarded immediately invoked function stays proven.
  assert.deepEqual(workflowStates(`${CRON} (() => { cron.schedule("*", run); })(); process.exit(0);`), [["cron.schedule", "resolved"]]);
});

test("COORD-582 R8: a const function called from another body is reached only if every way in starts after its declarator", () => {
  for (const body of [
    `main(); const setup = () => { cron.schedule("*", run); }; function main() { setup(); }`,
    `(() => { main(); })(); const setup = () => { cron.schedule("*", run); }; function main() { setup(); }`,
    `main(); const setup = () => { cron.schedule("*", run); }; function main() { setup(); } main();`,
    `function outer() { main(); } outer(); const setup = () => { cron.schedule("*", run); }; function main() { setup(); }`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    `const setup = () => { cron.schedule("*", run); }; function main() { setup(); } main();`,
    `const setup = () => { cron.schedule("*", run); }; (() => { main(); })(); function main() { setup(); }`,
    `function main() { setup(); } function setup() { cron.schedule("*", run); } main();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R9: process[\"exit\"]() is an exit and a loop that never ends hides the code after it", () => {
  for (const body of [
    `process["exit"](0); cron.schedule("*", run);`,
    `for (;;) { if (idle) continue; } cron.schedule("*", run);`,
    `while (true) { tick(); } cron.schedule("*", run);`,
    `while (1) { tick(); } cron.schedule("*", run);`,
    `do { tick(); } while (true); cron.schedule("*", run);`,
    `outer: for (;;) { for (;;) { continue outer; } } cron.schedule("*", run);`,
    `spin: while (true) { continue spin; } cron.schedule("*", run);`,
    `while (true) { switch (mode) { case 1: break; } [1].forEach(() => { for (;;) break; }); } cron.schedule("*", run);`,
    `function setup() { while (true) { if (done) return; } cron.schedule("*", run); } setup();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    `process[exit](0); process["other"](0); process.exitCode = 1; cron.schedule("*", run);`,
    `while (true) { if (done) break; } cron.schedule("*", run);`,
    `stop: for (;;) { break stop; } cron.schedule("*", run);`,
    `out: { while (true) { break out; } } cron.schedule("*", run);`,
    `outer: for (const a of items) { while (true) { continue outer; } } cron.schedule("*", run);`,
    `while (false) { tick(); } while (0) { tick(); } while ("") { tick(); } for (; more;) { tick(); } cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R10: a call that can reach a const or let function before its declarator throws there", () => {
  for (const body of [
    // a() throws (temporal dead zone), so b() never runs.
    `function a() { setup(); } function b() { setup(); } a(); const setup = () => { cron.schedule("*", run); }; b();`,
    `function a() { setup(); } if (x) a(); const setup = () => { cron.schedule("*", run); }; a();`,
    `function a() { inner(); } function inner() { setup(); } a(); const setup = () => { cron.schedule("*", run); }; inner();`,
    `function a() { if (x) setup(); } a(); const setup = () => { cron.schedule("*", run); }; setup();`,
    `setup(); const setup = () => {}; cron.schedule("*", run);`,
    `var setup = () => {}; go(); var go = () => {}; cron.schedule("*", run);`,
    `(() => { setup(); })(); const setup = () => {}; cron.schedule("*", run);`,
    `function a() { b(); } function b() { a(); setup(); } a(); const setup = () => {}; cron.schedule("*", run);`,
    `function a() { setup(); cron.schedule("*", run); } a(); const setup = () => {};`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    `const setup = () => {}; function a() { setup(); } a(); cron.schedule("*", run);`,
    `function a() { setup(); } const setup = () => {}; a(); cron.schedule("*", run);`,
    `function a() { setup(); } function setup() {} a(); cron.schedule("*", run);`,
    // An async body turns the throw into a rejected promise; the caller goes on.
    `async function a() { setup(); } a(); const setup = () => {}; cron.schedule("*", run);`,
    `function later() { setup(); } const setup = () => {}; cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R11: code after a call into a body that can never complete normally is conditional", () => {
  for (const body of [
    `function spin() { for (;;) {} } spin(); cron.schedule("*", run);`,
    `function spin() { while (true) { tick(); } } spin(); cron.schedule("*", run);`,
    `function fail() { throw new Error("x"); } fail(); cron.schedule("*", run);`,
    `const stop = () => process.exit(0); stop(); cron.schedule("*", run);`,
    `function stop() { process.exit(0); } function main() { stop(); } main(); cron.schedule("*", run);`,
    `function stop() { return stop2(); } function stop2() { throw new Error("x"); } stop(); cron.schedule("*", run);`,
    `(() => { for (;;) {} })(); cron.schedule("*", run);`,
    `function spin() { for (;;) {} } if (x) spin(); cron.schedule("*", run);`,
    `function spin() { for (;;) {} } function setup() { spin(); cron.schedule("*", run); } setup();`,
    `function f() { if (x) { throw e; } else { process.exit(1); } } f(); cron.schedule("*", run);`,
    `function f() { switch (m) { case 1: throw e; default: throw e; } } f(); cron.schedule("*", run);`,
    `function f() { try { throw e; } catch (err) { throw err; } } f(); cron.schedule("*", run);`,
    `function f() { try { tick(); } finally { throw e; } } f(); cron.schedule("*", run);`,
    `function f() { try { throw e; } finally { cleanup(); } } f(); cron.schedule("*", run);`,
    `function f() { out: for (;;) { for (;;) { continue out; } } } f(); cron.schedule("*", run);`,
    `function f() { for (;;) { switch (m) { case 1: break; } } } f(); cron.schedule("*", run);`,
    `async function spin() { for (;;) {} } spin(); cron.schedule("*", run);`,
    `const spin = async () => process.exit(1); spin(); cron.schedule("*", run);`,
    // COORD-845: a do-while body that never reaches its test, and unbounded recursion (it overflows the stack).
    `function f() { do { throw e; } while (more); } f(); cron.schedule("*", run);`,
    `function f() { f(); } f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    // A takeable return inside the infinite loop lets the body complete.
    `function f() { for (;;) { if (done) return; } } f(); cron.schedule("*", run);`,
    `function f() { while (true) { if (done) break; } } f(); cron.schedule("*", run);`,
    `function f() { stop: for (;;) { break stop; } } f(); cron.schedule("*", run);`,
    `function f() { out: { for (;;) { break out; } } } f(); cron.schedule("*", run);`,
    `function f() { if (x) throw e; } f(); cron.schedule("*", run);`,
    `function f() { switch (m) { case 1: throw e; } } f(); cron.schedule("*", run);`,
    `function f() { switch (m) { case 1: break; default: throw e; } } f(); cron.schedule("*", run);`,
    `function f() { switch (m) { case 1: throw e; default: } } f(); cron.schedule("*", run);`,
    `function f() { try { throw e; } catch (err) { log(err); } } f(); cron.schedule("*", run);`,
    `function f() { try { if (x) throw e; } finally { cleanup(); } } f(); cron.schedule("*", run);`,
    `function f() { try { return 1; } finally { cleanup(); } } f(); cron.schedule("*", run);`,
    `function f() { for (const x of xs) { throw e; } } f(); cron.schedule("*", run);`,
    `function f() { return 1; } function g() { f(); } g(); cron.schedule("*", run);`,
    `const f = () => 1; f(); cron.schedule("*", run);`,
    `function f() { const g = () => { for (;;) {} }; } f(); cron.schedule("*", run);`,
    // An async body that throws, or awaits, returns a promise to its caller.
    `async function fail() { throw new Error("x"); } fail(); cron.schedule("*", run);`,
    `async function spin() { await tick(); for (;;) {} } spin(); cron.schedule("*", run);`,
    `async function spin() { for await (const x of xs) {} for (;;) {} } spin(); cron.schedule("*", run);`,
    `async function spin() { const g = async () => { await x; }; for (;;) {} } function setup() { cron.schedule("*", run); } setup(); if (y) spin();`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R12: a static template key names process.exit and a constant truthy string never ends a loop", () => {
  for (const body of [
    "process[`exit`](0); cron.schedule(\"*\", run);",
    `while ("x") { tick(); } cron.schedule("*", run);`,
    "while (`go`) { tick(); } cron.schedule(\"*\", run);",
    `for (; "yes";) { tick(); } cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    "process[`other`](0); process[`${name}`](0); while (``) { tick(); } while (`${x}`) { tick(); } cron.schedule(\"*\", run);",
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R11: deeply nested statements stop the completion analysis without overflowing", () => {
  const nested = `${"{ ".repeat(400)}throw e;${" }".repeat(400)}`;
  // Past the depth bound the body is assumed to complete, as before the analysis.
  assert.deepEqual(workflowStates(`${CRON} function f() { ${nested} } f(); cron.schedule("*", run);`), [["cron.schedule", "resolved"]]);
  // COORD-845: it is also assumed able to return, so a recursive function whose base case sits past the bound can
  // return (the recursion fixpoint starts from "never returns" and needs the may-return answer); the same shape
  // within the bound is still analysed.
  const deepBase = `${"{ ".repeat(300)}if (n) return 1;${" }".repeat(300)}`;
  assert.deepEqual(workflowStates(`${CRON} function f(n) { ${deepBase} return f(n); } f(1); cron.schedule("*", run);`),
    [["cron.schedule", "resolved"]]);
  assert.deepEqual(workflowStates(`${CRON} function f(n) { { if (n) throw e; } return f(n); } f(1); cron.schedule("*", run);`),
    [["cron.schedule", "unresolved_conditional"]]);
});

test("COORD-582 R13: a never-returning call in any expression a statement always evaluates first ends the body", () => {
  const FAIL = `function fail() { throw e; }`;
  for (const body of [
    `${FAIL} function f() { const x = fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { if (fail()) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { switch (fail()) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { for (const x of fail()) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { for (const k in fail()) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { while (fail()) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { for (let i = fail(); i;) {} } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { for (; fail();) {} } f(); cron.schedule("*", run);`,
    `function f() { void process.exit(1); } f(); cron.schedule("*", run);`,
    `function f() { log(), process.exit(1); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { let y; y = log(o[fail()]) + 1; } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { return (fail() || a) ? b : c; } f(); cron.schedule("*", run);`,
    `function f() { const x = setup(); } f(); const setup = () => 1; cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    // Branches, short-circuited operands and callbacks may not run.
    `${FAIL} function f() { const x = a && fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { return a ? fail() : 1; } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { const g = () => fail(); [1].forEach(() => process.exit(0)); return; } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { for (const x of xs) { fail(); } while (a) fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { if (a) fail(); for (let i = 0; i < 1; i++) {} } f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

test("COORD-582 R14: a logical assignment's right side may not run, so it does not end the body", () => {
  const FAIL = `function fail() { throw e; }`;
  for (const body of [
    `${FAIL} function f() { x ||= fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { x &&= fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { x ??= fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { const y = (x ||= fail()); } f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
  for (const body of [
    `${FAIL} function f() { x = fail(); } f(); cron.schedule("*", run);`,
    `${FAIL} function f() { x += fail(); } f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
});

test("COORD-582 R15: an arrow expression body ends like the same expression in a statement", () => {
  const FAIL = `function fail() { throw e; }`;
  for (const body of [
    `${FAIL} const f = () => (log(), fail()); f(); cron.schedule("*", run);`,
    `${FAIL} const f = () => void fail(); f(); cron.schedule("*", run);`,
    `${FAIL} const f = () => fail() + 1; f(); cron.schedule("*", run);`,
    `${FAIL} const f = () => { log(), fail(); }; f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "unresolved_conditional"]], body);
  for (const body of [
    `${FAIL} const f = () => a && fail(); f(); cron.schedule("*", run);`,
    `${FAIL} const f = () => (x ??= fail()); f(); cron.schedule("*", run);`,
  ]) assert.deepEqual(workflowStates(`${CRON} ${body}`), [["cron.schedule", "resolved"]], body);
});

const FAIL = `function fail() { throw e; }`;
const SPIN = `function spin() { for (;;) {} }`;
const expectWorkflows = (bodies, state) => {
  for (const body of bodies) assert.deepEqual(workflowStates(`${CRON} ${FAIL} ${SPIN} ${body}`), [["cron.schedule", state]], body);
};

test("COORD-845 G1: never-returning calls in new, template, optional, literal, class, member-target, do-while and default positions", () => {
  expectWorkflows([
    `function f() { new X(fail()); } f(); cron.schedule("*", run);`,
    `function F() { throw e; } function f() { new F(); } f(); cron.schedule("*", run);`,
    `function F() { throw e; } new F(); cron.schedule("*", run);`,
    "function f() { `a${fail()}`; } f(); cron.schedule(\"*\", run);",
    "function f() { tag`a${fail()}`; } f(); cron.schedule(\"*\", run);",
    `function f() { fail?.(); } f(); cron.schedule("*", run);`,
    `function f() { [1, , fail()]; } f(); cron.schedule("*", run);`,
    `function f() { ({ a: fail() }); } f(); cron.schedule("*", run);`,
    `function f() { ({ [fail()]: 1 }); } f(); cron.schedule("*", run);`,
    `function f() { [...fail()]; } f(); cron.schedule("*", run);`,
    `function f() { log(...fail()); } f(); cron.schedule("*", run);`,
    `function f() { class A extends fail() {} } f(); cron.schedule("*", run);`,
    `function f() { const A = class extends fail() {}; } f(); cron.schedule("*", run);`,
    `function f() { class A { [fail()]() {} } } f(); cron.schedule("*", run);`,
    `function f() { o[fail()] = 1; } f(); cron.schedule("*", run);`,
    `function f() { o[fail()] ||= 1; } f(); cron.schedule("*", run);`,
    `function f() { do {} while (fail()); } f(); cron.schedule("*", run);`,
    `function f() { do { continue; } while (fail()); } f(); cron.schedule("*", run);`,
    `function f() { do { tick(); } while (true); } f(); cron.schedule("*", run);`,
    `function g(a, b, c = fail()) {} g(1); cron.schedule("*", run);`,
    `function g(a = fail()) {} function f() { g(); } f(); cron.schedule("*", run);`,
    // A tagged template calls its tag with the strings array, then each `${}` value.
    "fail`x`; cron.schedule(\"*\", run);",
    "function f() { spin`x`; } f(); cron.schedule(\"*\", run);",
    "(function () { throw e; })`x`; cron.schedule(\"*\", run);",
    "function g(s, a, b = fail()) {} g`${1}`; cron.schedule(\"*\", run);",
  ], "unresolved_conditional");
  expectWorkflows([
    `function f() { o?.m(fail()); a?.[fail()]; } f(); cron.schedule("*", run);`,
    `function f() { ({ m() { fail(); }, [k]: 1, a }); } f(); cron.schedule("*", run);`,
    `function f() { class A { m() { fail(); } x = fail(); } } f(); cron.schedule("*", run);`,
    `function f() { o.x = 1; [a, b] = pair; } f(); cron.schedule("*", run);`,
    `function f() { do { if (x) break; } while (fail()); } f(); cron.schedule("*", run);`,
    `function f() { do { tick(); } while (more); } f(); cron.schedule("*", run);`,
    `function g(a = fail()) {} g(1); g(...args); cron.schedule("*", run);`,
    `async function g(a = fail()) {} g(); cron.schedule("*", run);`,
    "function g(s, b = fail()) {} g`${1}`; cron.schedule(\"*\", run);",
    // Not modelled (see Limits): new on an arrow throws a TypeError the parser does not see.
    `const A = () => { throw e; }; new A(); cron.schedule("*", run);`,
  ], "resolved");
});

test("COORD-845 G2: a literal constant test decides which branch or operand runs when a body can return", () => {
  expectWorkflows([
    `function f() { if (true) throw e; } f(); cron.schedule("*", run);`,
    `function f() { if (false) return; throw e; } f(); cron.schedule("*", run);`,
    `function f() { if (null) { return; } else { throw e; } } f(); cron.schedule("*", run);`,
    "function f() { if (`go`) { throw e; } else { return; } } f(); cron.schedule(\"*\", run);",
    `function f() { return 1 ? fail() : 0; } f(); cron.schedule("*", run);`,
    `function f() { false || fail(); } f(); cron.schedule("*", run);`,
    `function f() { true && fail(); } f(); cron.schedule("*", run);`,
    `function f() { null ?? fail(); } f(); cron.schedule("*", run);`,
    // Folding is not applied to the exit marking (see Limits), so this stays conditional.
    `function setup() { if (false) return; cron.schedule("*", run); } setup();`,
  ], "unresolved_conditional");
  expectWorkflows([
    `function f() { if (false) throw e; } f(); cron.schedule("*", run);`,
    `function f() { if (0) { throw e; } } f(); cron.schedule("*", run);`,
    `function f() { return false ? fail() : 0; } f(); cron.schedule("*", run);`,
    `function f() { true || fail(); 0 && fail(); 0 ?? fail(); x ?? fail(); x || fail(); } f(); cron.schedule("*", run);`,
  ], "resolved");
});

test("COORD-845 G3: functions that call each other with no path that returns overflow the stack", () => {
  expectWorkflows([
    `function a() { b(); } function b() { a(); } a(); cron.schedule("*", run);`,
    `function f(n) { return f(n - 1) + 1; } f(1); cron.schedule("*", run);`,
    `function a() { b(); } function b() { c(); a(); } function c() { for (;;) {} } a(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
  expectWorkflows([
    `function f(n) { if (n) f(n - 1); } f(1); cron.schedule("*", run);`,
    `function f() { try { f(); } catch (err) {} } f(); cron.schedule("*", run);`,
    `async function f() { f(); } f(); cron.schedule("*", run);`,
    `function a() { b(); } function b() { if (x) return; a(); } function c() { a(); b(); } c(); cron.schedule("*", run);`,
  ], "resolved");
});

test("COORD-845 G4: a call an expression always makes that never returns hides the rest of the expression", () => {
  expectWorkflows([
    `spin(), cron.schedule("*", run);`,
    `cron.schedule(spin());`,
    `[fail(), cron.schedule("*", run)];`,
    `const a = fail(), b = cron.schedule("*", run);`,
    `class A extends spin() { static { cron.schedule("*", run); } }`,
  ], "unresolved_conditional");
  // A never-returning call in a part that may not run can still be taken (the 2026-10-19 strict decision, see G12):
  // the call enclosing it may not be made and the parts after it may not run.
  expectWorkflows([
    `cron.schedule("*", x || spin());`,
    `cron.schedule(o?.m(spin()));`,
    `x ? spin() : 0, cron.schedule("*", run);`,
    `[x && spin(), cron.schedule("*", run)];`,
  ], "unresolved_conditional");
  expectWorkflows([
    `cron.schedule("*", () => spin());`,
    `cron.schedule("*", function () { x || spin(); });`,
  ], "resolved");
  assert.deepEqual(routeStates(`${EXPRESS} ${SPIN} const app=express(); app.get("/a",h); [spin(), app.listen(1)];`), [["GET /a", "unresolved_mount"]]);
});

test("COORD-845 G5 and G7: exits through aliases or callbacks, and runtime errors other than throw, are not modelled", () => {
  expectWorkflows([
    `const s = spin; s(); cron.schedule("*", run);`,
    `function f() { null.x; } f(); cron.schedule("*", run);`,
    `log(port); const port = 1; cron.schedule("*", run);`,
  ], "resolved");
});

test("COORD-845 G6: an async body returns at an await only when the await can be reached", () => {
  expectWorkflows([
    `async function f() { for (;;) {} await x; } f(); cron.schedule("*", run);`,
    `async function f() { await spin(); } f(); cron.schedule("*", run);`,
    `async function f() { if (false) { await x; } for (;;) {} } f(); cron.schedule("*", run);`,
    `async function f() { if (true) { for (;;) {} } else { await x; } } f(); cron.schedule("*", run);`,
    `async function f() { spin() && await x; } f(); cron.schedule("*", run);`,
    `async function f() { [spin(), await x]; } f(); cron.schedule("*", run);`,
    `const f = async () => spin(); f(); cron.schedule("*", run);`,
    // A finally block runs only when its try or catch can end; a do-while test only when the body reaches it.
    `async function f() { try { for (;;) {} } finally { await x; } } f(); cron.schedule("*", run);`,
    `async function f() { try { for (;;) {} } catch (err) { for (;;) {} } finally { await x; } } f(); cron.schedule("*", run);`,
    `async function f() { do { for (;;) {} } while (await x); } f(); cron.schedule("*", run);`,
    // A default value that never ends is not a rejected promise.
    `async function f(a = spin()) { await x; } f(); cron.schedule("*", run);`,
    `const f = async (a = process.exit(1)) => 1; f(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
  expectWorkflows([
    `async function f() { x && await y; for (;;) {} } f(); cron.schedule("*", run);`,
    `async function f() { (x && await y) + spin(); } f(); cron.schedule("*", run);`,
    `async function f() { await fail(); } f(); cron.schedule("*", run);`,
    `async function f() { for (;;) { await x; } } f(); cron.schedule("*", run);`,
    `const f = async () => (await x, spin()); f(); cron.schedule("*", run);`,
    `async function f() { for (;;) { label: { if (x) { await y; } } } } f(); cron.schedule("*", run);`,
    `async function f() { try { for (;;) { if (x) break; } } finally { await y; } for (;;) {} } f(); cron.schedule("*", run);`,
    `async function f() { try { for (;;) {} } catch (err) { log(err); } finally { await y; } for (;;) {} } f(); cron.schedule("*", run);`,
    `async function f() { do { tick(); } while (await x); for (;;) {} } f(); cron.schedule("*", run);`,
    `async function f(a = spin()) { await x; } f(1); cron.schedule("*", run);`,
    `async function f(a = fail()) { for (;;) {} } f(); cron.schedule("*", run);`,
  ], "resolved");
  // Outside an async body the same never-ending try and do-while bodies end their function.
  expectWorkflows([
    `function f() { try { for (;;) {} } finally { log(); } } f(); cron.schedule("*", run);`,
    `function f() { do { for (;;) {} } while (x); } f(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
});

test("COORD-845 G9: calling or constructing a class before its declaration throws", () => {
  expectWorkflows([
    `new Svc(); class Svc {} cron.schedule("*", run);`,
    `Svc(); class Svc {} cron.schedule("*", run);`,
    `new Svc(); const Svc = class {}; cron.schedule("*", run);`,
    `function make() { return new Svc(); } make(); class Svc {} cron.schedule("*", run);`,
  ], "unresolved_conditional");
  expectWorkflows([
    `class Svc {} new Svc(); cron.schedule("*", run);`,
    `const Svc = class {}; new Svc(); cron.schedule("*", run);`,
    `function make() { return new Svc(); } class Svc {} make(); cron.schedule("*", run);`,
  ], "resolved");
  // A plain function constructed with new runs; a constructor, arrow or async function does not prove anything.
  const served = (body) => routeStates(`${EXPRESS} const app=express(); app.listen(80); ${body}`);
  for (const body of [
    `function Svc() { app.get("/s",h); } new Svc();`,
    `new (function () { app.get("/s",h); })();`,
    `function setup() { app.get("/s",h); } setup?.();`,
    `(() => { app.get("/s",h); })?.();`,
  ]) assert.deepEqual(served(body), [["GET /s", "resolved"]], body);
  for (const body of [
    `class Svc { constructor() { app.get("/s",h); } } new Svc();`,
    `new (() => { app.get("/s",h); })();`,
    `const Svc = async function () { app.get("/s",h); }; new Svc();`,
  ]) assert.deepEqual(served(body), [["GET /s", "unresolved_conditional"]], body);
});

test("COORD-845 G10: static blocks and static fields run when their class is defined", () => {
  expectWorkflows([
    `class A { static { throw e; } } cron.schedule("*", run);`,
    `class A { static x = fail(); } cron.schedule("*", run);`,
    `if (x) { class A { static { cron.schedule("*", run); } } }`,
    `function f() { class A { static { throw e; } } } f(); cron.schedule("*", run);`,
    `class A { static { spin(); } static { cron.schedule("*", run); } }`,
    `function later() { class A { static { cron.schedule("*", run); } } }`,
  ], "unresolved_conditional");
  expectWorkflows([
    `class A { static { cron.schedule("*", run); } }`,
    `class A { static #p = cron.schedule("*", run); }`,
    `const A = class { static { cron.schedule("*", run); } };`,
    `class A { x = fail(); static y = 1; static { setup(); } } function setup() { cron.schedule("*", run); }`,
  ], "resolved");
});

test("COORD-845 G11: one body with thousands of guarded calls into throwing functions stays fast", () => {
  const count = 4000;
  const functions = Array.from({ length: count }, (_, i) => `function f${i}() { throw e; }`).join("\n");
  const calls = Array.from({ length: count }, (_, i) => `if (a) f${i}();`).join("\n");
  const started = process.hrtime.bigint();
  const states = workflowStates(`${CRON}\n${functions}\nfunction main() {\n${calls}\ncron.schedule("*", run);\n}\nmain();`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(states, [["cron.schedule", "unresolved_conditional"]]);
  // Before COORD-845 this took about 26 s (each throwing callee re-analysed main).
  assert.ok(elapsedMs < 5000, `took ${Math.round(elapsedMs)} ms`);
});

test("COORD-845 G12: an exit that fires only on missing configuration still hides later code (strict, decided 2026-10-19)", () => {
  const app = `${EXPRESS} function die() { process.exit(1); } const app=express(); app.get("/a",h);`;
  assert.deepEqual(routeStates(`${app} if (!port) die(); app.listen(port);`), [["GET /a", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${app} const port = process.env.PORT || die(); app.listen(port);`), [["GET /a", "unresolved_mount"]]);
  // The same guarded exit inside the listen call's arguments may stop the call being made.
  assert.deepEqual(routeStates(`${app} app.listen(process.env.PORT || die());`), [["GET /a", "unresolved_mount"]]);
  assert.deepEqual(routeStates(`${app} app.listen(port);`), [["GET /a", "resolved"]]);
});

test("COORD-845 G13: default values that call their own function again overflow the stack instead of the parser's", () => {
  for (const source of [`function f(a = f()) {}`, `const walk = (n, d = walk(n.parent)) => d;`,
    `function f(a = g()) {} function g(b = f()) {}`]) {
    assert.equal(parser.inspectSource(source).parse_status, "parsed", source);
  }
  expectWorkflows([
    `function f(a = f()) {} f(); cron.schedule("*", run);`,
    `const walk = (n, d = walk(n.parent)) => d; walk(x); cron.schedule("*", run);`,
    `function f(a = g()) {} function g(b = f()) {} f(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
  expectWorkflows([
    `function f(a = f(1)) {} f(); cron.schedule("*", run);`,
    `function f(a = f()) {} if (x) f(1); f(1); cron.schedule("*", run);`,
    `const walk = (n, d = n ? walk(n.parent) : 0) => d; walk(x); cron.schedule("*", run);`,
  ], "resolved");
  // Each call's defaults are followed once: a chain where every default calls the previous function twice took
  // about 2.3 s at 20 levels (doubling with each level) before the answers were kept.
  const chain = Array.from({ length: 40 }, (_, i) => `function f${i + 1}(a = f${i}(), b = f${i}()) {}`).join("\n");
  const started = process.hrtime.bigint();
  const states = workflowStates(`${CRON}\nfunction f0() { throw e; }\n${chain}\nf40();\ncron.schedule("*", run);`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(elapsedMs < 5000, `took ${Math.round(elapsedMs)} ms`);
  const returning = Array.from({ length: 40 }, (_, i) => `function f${i + 1}(a = f${i}(), b = f${i}()) {}`).join("\n");
  const quick = process.hrtime.bigint();
  assert.deepEqual(workflowStates(`${CRON}\nfunction f0() {}\n${returning}\nf40();\ncron.schedule("*", run);`), [["cron.schedule", "resolved"]]);
  assert.ok(Number(process.hrtime.bigint() - quick) / 1e6 < 5000);
});

const timed = (source) => {
  const started = process.hrtime.bigint();
  const states = workflowStates(source);
  return { states, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
};

test("COORD-845 G14: async defaults that call each other in a cycle are followed once per call, not once per path", () => {
  // Every async function's two defaults call the next one, and the last calls the first. Where the stack runs
  // out depends on the runtime, so the call met again is taken to never return (fail-closed). Before answers
  // that end were kept this doubled with each level (about 5 s at 16 levels, 195 s at 22).
  const levels = 40;
  const chain = Array.from({ length: levels }, (_, i) => {
    const next = i + 1 === levels ? 1 : i + 2;
    return `async function f${i + 1}(a = f${next}(), b = f${next}()) {}`;
  }).join("\n");
  const { states, elapsedMs } = timed(`${CRON}\n${chain}\nf1();\ncron.schedule("*", run);`);
  assert.deepEqual(states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(elapsedMs < 3000, `took ${Math.round(elapsedMs)} ms`);
  expectWorkflows([
    `async function f(a = g(), b = spin()) {} function g(x = f()) {} f(); cron.schedule("*", run);`,
    `async function f(a = g(), b = 1) {} function g(x = f()) {} f(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
  // A cycle of synchronous callees inside an async callee's default throws through all of them, and the async
  // callee returns its rejected promise.
  expectWorkflows([
    `async function f(a = g()) {} function g(x = g()) {} f(); cron.schedule("*", run);`,
    `async function f(a = g()) {} function g(x = h()) {} function h(y = g()) {} f(); cron.schedule("*", run);`,
  ], "resolved");
});

test("COORD-845 G17: a default cycle through an async callee never counts as returning, whatever was analysed first", () => {
  // An async callee on the cycle turns the stack overflow into a rejected promise at whatever depth the stack
  // runs out; the calls below it then go on, so h() runs its loop and m() never returns. Before, an async call
  // answered while another call was being followed kept "returns", and a later query reused it (z primes it).
  const cycle = `async function g(c = h()) {} function h(a = m()) { for(;;){} } async function m(b = g()) {} `;
  expectWorkflows([
    `${cycle}function z(){ if (x) h(); } m(); cron.schedule("*", run); z();`,
    `${cycle}function z(){ if (x) h(); } z(); m(); cron.schedule("*", run);`,
    `${cycle}m(); cron.schedule("*", run);`,
    `async function g(c = h()) {} function h(a = m(), q = spin()) {} async function m(b = g()) {} function z(){ if (x) h(); } m(); cron.schedule("*", run); z();`,
    `async function g(c = h()) {} function h(a = m(), q = spin()) {} async function m(b = g()) {} m(); cron.schedule("*", run);`,
  ], "unresolved_conditional");
  // The same program with its declarations in every order gives the same verdicts.
  const declarations = [`async function g(c = h()) {}`, `function h(a = m()) { for(;;){} }`, `async function m(b = g()) {}`,
    `function z(){ if (x) h(); }`, `function y(){ if (x) g(); }`];
  const tail = `m(); cron.schedule("*", run); z(); y();`;
  const permutations = (items) => items.length <= 1 ? [items]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  const verdicts = new Set(permutations(declarations).map((order) => JSON.stringify(workflowStates(`${CRON}\n${order.join("\n")}\n${tail}`))));
  assert.deepEqual([...verdicts], [JSON.stringify([["cron.schedule", "unresolved_conditional"]])]);
});

test("COORD-845 G15: thousands of exits in one expression are walked in linear time", () => {
  // Each exit on the right of `||` walked to the top of the chain, and each exit call to the top of its body.
  const chain = timed(`${CRON}\ncron.schedule("*", run, a ${"|| process.exit() ".repeat(2000)});`);
  assert.deepEqual(chain.states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(chain.elapsedMs < 3000, `took ${Math.round(chain.elapsedMs)} ms`);
  const defaults = timed(`${CRON}\nfunction g(x = process.exit()) {}\ncron.schedule("*", run, ${"g() || ".repeat(2000)}0);`);
  assert.deepEqual(defaults.states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(defaults.elapsedMs < 3000, `took ${Math.round(defaults.elapsedMs)} ms`);
  const args = timed(`${CRON}\nf(${"process.exit(), ".repeat(4000)});\ncron.schedule("*", run);`);
  assert.deepEqual(args.states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(args.elapsedMs < 3000, `took ${Math.round(args.elapsedMs)} ms`);
  const statements = timed(`${CRON}\nfunction main() {\n${"if (a) return;\n".repeat(4000)}cron.schedule("*", run);\n}\nmain();`);
  assert.deepEqual(statements.states, [["cron.schedule", "unresolved_conditional"]]);
  assert.ok(statements.elapsedMs < 3000, `took ${Math.round(statements.elapsedMs)} ms`);
});

test("COORD-845 G16: an exit in a part of the expression a literal constant rules out is never taken", () => {
  expectWorkflows([
    `cron.schedule("*", false ? spin() : run);`,
    `cron.schedule("*", true ? run : spin());`,
    `cron.schedule("*", run, true || spin());`,
    `cron.schedule("*", run, 0 && spin());`,
    `cron.schedule("*", run, "x" ?? spin());`,
    `cron.schedule("*", false ? (x || spin()) : run);`,
    `cron.schedule("*", run, 1 || process.exit());`,
  ], "resolved");
  expectWorkflows([
    `cron.schedule("*", run, false || spin());`,
    `cron.schedule("*", run, 1 && spin());`,
    `cron.schedule("*", run, null ?? spin());`,
    `cron.schedule("*", run, x || spin());`,
    `cron.schedule("*", x ? spin() : run);`,
    `cron.schedule("*", true ? spin() : run);`,
  ], "unresolved_conditional");
});

test("COORD-582 R16: the protocol's never-returning list names exactly the modelled node types", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "business-discovery-source-parser.js"), "utf8");
  const table = (name) => source.slice(source.indexOf(`const ${name} = {`), source.indexOf("\n};", source.indexOf(`const ${name} = {`)));
  const modelled = new Set([...table("EVALUATED_FIRST").matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]));
  for (const match of table("FLOW_HANDLERS").matchAll(/^ {2}(\w+): .*(?:leading\(|expressionEnds\()/gm)) modelled.add(match[1]);
  const doc = fs.readFileSync(path.join(__dirname, "../../product/BUSINESS_DISCOVERY_PROTOCOL.md"), "utf8");
  const start = doc.indexOf("#### Never-returning calls");
  assert.ok(start > 0, "protocol section missing");
  const section = doc.slice(start, doc.indexOf("\n### ", start));
  const listed = new Set([...section.matchAll(/^- `(\w+)`(?: and `(\w+)`)?:/gm)].flatMap((match) => match.slice(1).filter(Boolean)));
  assert.deepEqual([...listed].sort(), [...modelled].sort());
});
