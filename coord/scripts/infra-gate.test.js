"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evaluateInfra, runInfraGate } = require("./infra-gate.js");

function goodConfig(overrides = {}) {
  return Object.assign(
    {
      navigationFallback: { rewrite: "/index.html" },
      routes: [{ route: "/*", serve: "/index.html" }],
      globalHeaders: {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
        "Content-Security-Policy": "default-src 'self'",
        "X-Content-Type-Options": "nosniff",
      },
    },
    overrides
  );
}

const goodWorkflow = `
jobs:
  build_and_deploy:
    steps:
      - uses: Azure/static-web-apps-deploy@v1
        with:
          app_location: "/"
`;

test("passes a valid config with HSTS+CSP and a deploy step", () => {
  const r = evaluateInfra({ staticwebappConfig: goodConfig(), workflowText: goodWorkflow });
  assert.strictEqual(r.result, "pass");
  assert.strictEqual(r.gateProc, "infra");
  assert.strictEqual(r.track, "devops");
  assert.strictEqual(r.target, "static-web-app");
  assert.ok(r.checks.find((c) => c.name === "swa_config_valid" && c.result === "pass"));
});

test("accepts a raw JSON string for the config", () => {
  const r = evaluateInfra({ staticwebappConfig: JSON.stringify(goodConfig()), workflowText: goodWorkflow });
  assert.strictEqual(r.result, "pass");
});

test("fails swa_config_valid when neither routes nor navigationFallback present", () => {
  const cfg = { globalHeaders: goodConfig().globalHeaders };
  const r = evaluateInfra({ staticwebappConfig: cfg, workflowText: goodWorkflow });
  const c = r.checks.find((x) => x.name === "swa_config_valid");
  assert.strictEqual(c.result, "fail");
  assert.strictEqual(r.result, "fail");
});

test("fails security_headers when HSTS is missing", () => {
  const cfg = goodConfig({
    globalHeaders: { "Content-Security-Policy": "default-src 'self'" },
  });
  const r = evaluateInfra({ staticwebappConfig: cfg, workflowText: goodWorkflow });
  const c = r.checks.find((x) => x.name === "security_headers");
  assert.strictEqual(c.result, "fail");
  assert.match(c.detail, /Strict-Transport-Security/);
});

test("fails security_headers when CSP is missing", () => {
  const cfg = goodConfig({
    globalHeaders: { "Strict-Transport-Security": "max-age=63072000" },
  });
  const r = evaluateInfra({ staticwebappConfig: cfg, workflowText: goodWorkflow });
  const c = r.checks.find((x) => x.name === "security_headers");
  assert.strictEqual(c.result, "fail");
  assert.match(c.detail, /Content-Security-Policy/);
});

test("header lookup is case-insensitive", () => {
  const cfg = goodConfig({
    globalHeaders: {
      "strict-transport-security": "max-age=63072000",
      "content-security-policy": "default-src 'self'",
    },
  });
  const r = evaluateInfra({ staticwebappConfig: cfg, workflowText: goodWorkflow });
  assert.strictEqual(r.checks.find((c) => c.name === "security_headers").result, "pass");
});

test("fails workflow_deploy_step when the SWA action is absent", () => {
  const r = evaluateInfra({ staticwebappConfig: goodConfig(), workflowText: "jobs:\n  build:\n    steps: []\n" });
  const c = r.checks.find((x) => x.name === "workflow_deploy_step");
  assert.strictEqual(c.result, "fail");
  assert.strictEqual(r.result, "fail");
});

test("fails swa_config_valid on malformed JSON", () => {
  const r = evaluateInfra({ staticwebappConfig: "{ not: valid json ", workflowText: goodWorkflow });
  const c = r.checks.find((x) => x.name === "swa_config_valid");
  assert.strictEqual(c.result, "fail");
  assert.match(c.detail, /did not parse/);
  // headers check should also fail gracefully, not throw
  assert.strictEqual(r.checks.find((x) => x.name === "security_headers").result, "fail");
});

test("deploy_smoke is always skip; smoke url recorded as artifact", () => {
  const without = evaluateInfra({ staticwebappConfig: goodConfig(), workflowText: goodWorkflow });
  assert.strictEqual(without.checks.find((c) => c.name === "deploy_smoke").result, "skip");

  const withUrl = evaluateInfra({
    staticwebappConfig: goodConfig(),
    workflowText: goodWorkflow,
    deploySmokeUrl: "https://preview.example",
  });
  assert.strictEqual(withUrl.checks.find((c) => c.name === "deploy_smoke").result, "skip");
  assert.ok(withUrl.artifact_paths.includes("https://preview.example"));
});

test("runInfraGate passes through in-memory inputs and honors target", () => {
  const r = runInfraGate({
    staticwebappConfig: goodConfig(),
    workflowText: goodWorkflow,
    target: "softsensor-www",
  });
  assert.strictEqual(r.result, "pass");
  assert.strictEqual(r.target, "softsensor-www");
});
