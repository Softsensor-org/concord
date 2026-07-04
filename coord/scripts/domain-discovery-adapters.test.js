"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const adapters = require("./domain-discovery-adapters.js");

test("domain adapter registry detects starter domain lenses without declaring truth", () => {
  const signals = adapters.detectAdapters([
    "backend/src/api/menuItems.ts",
    "backend/src/api/modifiers.ts",
    "backend/src/api/taxRules.ts",
    "frontend/src/pages/checkout.tsx",
    "integrations/shopify/products.ts",
  ]);
  const ids = signals.map((signal) => signal.id);
  assert.ok(ids.includes("pos-menu"));
  assert.ok(ids.includes("integration-api"));
  assert.ok(ids.includes("ecommerce"));
  assert.ok(signals.every((signal) => ["observed", "inferred"].includes(signal.confidence)));
  assert.ok(signals.every((signal) => signal.probes.length > 0 && signal.questions.length > 0));
});

test("domain adapter registry returns no matches for unrelated paths", () => {
  const signals = adapters.detectAdapters(["README.md", "LICENSE", "scripts/check.js"]);
  assert.equal(signals.length, 0);
});

test("domain adapter registry activates public-safe POS and ERP pilot fixtures", () => {
  const signals = adapters.detectAdapters([
    "fixtures/public-safe/pos/menu-adapter-contract.json",
    "fixtures/public-safe/pos/item-modifier-tax-contract.json",
    "fixtures/public-safe/pos/price-option-export.json",
    "fixtures/public-safe/erp/tenant-approval-workflow.config.json",
    "fixtures/public-safe/erp/invoice-setting-fixture.yaml",
    "fixtures/public-safe/erp/configured-approval-variant.json",
  ]);
  const byId = new Map(signals.map((signal) => [signal.id, signal]));

  assert.equal(byId.get("pos-menu").confidence, "observed");
  assert.equal(byId.get("erp-configuration").confidence, "observed");
  assert.ok(byId.get("pos-menu").matched_paths.some((file) => file.includes("menu-adapter-contract")));
  assert.ok(byId.get("erp-configuration").matched_paths.some((file) => file.includes("tenant-approval-workflow")));
  assert.ok(byId.get("pos-menu").probes.some((probe) => /contract/.test(probe)));
  assert.ok(byId.get("erp-configuration").questions.some((question) => /configured variants/.test(question)));
});
