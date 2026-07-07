"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const coverage = require("./requirements-screen-coverage.js");

const screenIndex = {
  version: 1,
  apps: [
    {
      app: "web",
      framework: "next-app-router",
      screens: [
        {
          id: "web:orders",
          route: "/orders",
          title: "Orders",
          source: "app/orders/page.tsx",
          requirement_refs: [{ doc: "REQ.md", anchor: "req-001-orders", confidence: "explicit" }],
        },
        {
          id: "web:dispatch",
          route: "/dispatch",
          title: "Dispatch",
          source: "app/dispatch/page.tsx",
          requirement_refs: [{ doc: "REQ.md", anchor: "req-002-dispatch", confidence: "inferred" }],
        },
        {
          id: "web:settings",
          route: "/settings",
          title: "Settings",
          source: "app/settings/page.tsx",
          requirement_refs: [],
        },
      ],
    },
  ],
  requirements: {
    source: "REQ.md",
    headings: [
      { anchor: "req-001-orders", text: "Orders", level: 2 },
      { anchor: "req-002-dispatch", text: "Dispatch", level: 2 },
      { anchor: "req-003-billing", text: "Billing", level: 2 },
    ],
  },
};

test("analyzeScreenCoverage reports missing screens, unlinked screens, and inferred links", () => {
  const report = coverage.analyzeScreenCoverage(screenIndex);
  assert.deepEqual(report.requirements_without_screen, ["req-003-billing"]);
  assert.deepEqual(report.screens_without_requirement.map((screen) => screen.screen_id), ["web:settings"]);
  assert.deepEqual(report.inferred_links_needing_confirmation.map((ref) => `${ref.screen_id}:${ref.anchor}`), ["web:dispatch:req-002-dispatch"]);
  assert.equal(report.summary.screens, 3);
});

test("registry anchors override screen-index heading list when provided", () => {
  const report = coverage.analyzeScreenCoverage(screenIndex, {
    requirements: [
      { id: "REQ-001", title: "Orders", source: { anchor: "req-001-orders" } },
      { id: "REQ-004", title: "Returns", source: { anchor: "req-004-returns" } },
    ],
  });
  assert.deepEqual(report.requirements_without_screen, ["req-004-returns"]);
  assert.equal(report.summary.requirement_anchors, 2);
});

test("run writes output only when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-screen-coverage-"));
  fs.mkdirSync(path.join(dir, "coord/.runtime"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/screen-index.json"), JSON.stringify(screenIndex, null, 2));
  const out = [];
  const result = coverage.run(["--dir", dir, "--output", "coord/.runtime/requirements/screen-coverage.json", "--json"], {
    cwd: dir,
    log: (line) => out.push(line),
  });
  assert.equal(result.code, 0);
  assert.equal(out.length, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/requirements/screen-coverage.json"), "utf8"));
  assert.equal(written.kind, "concord.requirements.screen_coverage");
  assert.equal(written.summary.screens_without_requirement, 1);
});
