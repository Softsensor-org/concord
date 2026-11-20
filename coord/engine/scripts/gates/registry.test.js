"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createGateRegistry, runGatePipeline } = require("./registry.js");

test("runGatePipeline composes pure GateCheck issue arrays in order", () => {
  const calls = [];
  const issues = runGatePipeline([
    (ctx) => {
      calls.push(`first:${ctx.phase}`);
      return [{ code: "first" }];
    },
    () => null,
    (ctx) => {
      calls.push(`second:${ctx.ticketId}`);
      return [{ code: "second" }];
    },
  ], { phase: "review", ticketId: "COORD-374" });

  assert.deepEqual(calls, ["first:review", "second:COORD-374"]);
  assert.deepEqual(issues.map((issue) => issue.code), ["first", "second"]);
});

test("createGateRegistry scopes checks by phase and injects phase into context", () => {
  const registry = createGateRegistry({
    start: [(ctx) => [{ code: `start:${ctx.phase}` }]],
    review: [(ctx) => [{ code: `review:${ctx.ticketId}` }]],
  });

  assert.deepEqual(registry.checks("start").length, 1);
  assert.deepEqual(registry.run("start", {}).map((issue) => issue.code), ["start:start"]);
  assert.deepEqual(registry.run("review", { ticketId: "COORD-374" }).map((issue) => issue.code), ["review:COORD-374"]);
  assert.deepEqual(registry.run("missing", { ticketId: "COORD-374" }), []);
});
