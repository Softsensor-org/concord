"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

test("coord-ui human-agent route renders the governed authoring model", () => {
  const page = fs.readFileSync(path.join(ROOT, "frontend/apps/coord-ui/app/human-agent/page.tsx"), "utf8");
  const model = fs.readFileSync(path.join(ROOT, "frontend/apps/coord-ui/lib/human-agent.ts"), "utf8");

  assert.match(page, /Human-agent loop/);
  assert.match(page, /Requirement draft intent/);
  assert.match(page, /Feedback intent/);
  assert.match(page, /Grooming pipeline/);
  assert.match(page, /Product-screen bridge/);
  assert.match(page, /Screen feedback targets/);
  assert.match(page, /Loop orchestration/);
  assert.match(page, /Evidence return/);
  assert.match(page, /Hosted control plane/);
  assert.match(page, /Deployment readiness/);
  assert.match(model, /buildHumanAgentPlatformModel/);
  assert.match(model, /coord_ui_may_write: false/);
});
