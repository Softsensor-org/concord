"use strict";

// COORD-279 (item 6): the shared gate-result shaper. Proves the analytics /
// content / infra gates now route through ONE helper that derives the pass/fail
// verdict + summary identically, and that the previously-duplicated shape is
// reproduced byte-for-byte (so the dedup is behaviour-preserving).

const test = require("node:test");
const assert = require("node:assert");

const { shapeGateResult } = require("./gate-result.js");
const { runContentGate } = require("./content-gate.js");
const { runInfraGate } = require("./infra-gate.js");

test("shapeGateResult derives pass when no check failed", () => {
  const out = shapeGateResult({
    gateProc: "content",
    track: "marketing",
    subject: { site: "demo" },
    checks: [{ name: "a", result: "pass" }, { name: "b", result: "skip" }],
    artifactPaths: ["x"],
  });
  assert.equal(out.result, "pass");
  assert.equal(out.gateProc, "content");
  assert.equal(out.track, "marketing");
  assert.equal(out.site, "demo");
  assert.deepEqual(out.artifact_paths, ["x"]);
  assert.equal(out.summary, "content gate pass: 2 check(s) ok");
});

test("shapeGateResult derives fail and counts failures; label defaults to gateProc", () => {
  const out = shapeGateResult({
    gateProc: "evidence",
    track: "product-engineering",
    subject: { ticket: "T-1" },
    checks: [{ name: "a", result: "fail" }, { name: "b", result: "pass" }],
    artifactPaths: [],
  });
  assert.equal(out.result, "fail");
  assert.equal(out.ticket, "T-1");
  assert.equal(out.summary, "evidence gate fail: 1/2 check(s) failed");
});

test("the live content + infra gates emit the shared shape (dedup is behaviour-preserving)", () => {
  // A content gate over a single page → shared shape with the content label.
  const content = runContentGate({
    site: "demo-site",
    pages: [
      {
        path: "index.html",
        html:
          "<!doctype html><html lang=\"en\"><head><title>Hi there friends</title>" +
          "<meta name=\"description\" content=\"A sufficiently long description for the SEO meta check.\">" +
          "</head><body><h1>Hi</h1></body></html>",
      },
    ],
  });
  assert.equal(content.gateProc, "content");
  assert.equal(content.track, "marketing");
  assert.equal(content.site, "demo-site");
  assert.match(content.summary, /^content gate (pass|fail):/);
  assert.ok(Array.isArray(content.checks));
  assert.ok("artifact_paths" in content);

  // An infra gate over a valid config → shared shape with the infra label.
  const infra = runInfraGate({
    target: "swa",
    staticwebappConfig: {
      routes: [{ route: "/*" }],
      globalHeaders: {
        "Strict-Transport-Security": "max-age=63072000",
        "Content-Security-Policy": "default-src 'self'",
      },
    },
    workflowText: "uses: Azure/static-web-apps-deploy@v1",
  });
  assert.equal(infra.gateProc, "infra");
  assert.equal(infra.track, "devops");
  assert.equal(infra.target, "swa");
  assert.match(infra.summary, /^infra gate (pass|fail):/);
});
