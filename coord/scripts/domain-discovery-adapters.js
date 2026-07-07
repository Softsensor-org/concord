"use strict";

const STARTER_ADAPTERS = [
  {
    id: "generic-existing-repo",
    label: "Generic existing repo",
    signals: [/package\.json$/, /pyproject\.toml$/, /requirements\.txt$/, /src\//, /docs?\//],
    probes: ["inventory package managers, entrypoints, tests, docs, schemas, and runtime config"],
    risks: ["implementation behavior may be accidental", "docs may lag current code"],
    questions: ["Which sources are authoritative for product intent?"],
  },
  {
    id: "pos-menu",
    label: "POS/menu",
    signals: [/menu/i, /pos/i, /item/i, /modifier/i, /option/i, /tax/i, /price/i],
    probes: ["inspect item/modifier/group/tax/price contracts and import/export adapters"],
    risks: ["names may be used as foreign keys", "downstream POS schema may cap representable fidelity"],
    questions: ["Which downstream POS or menu format is authoritative?"],
  },
  {
    id: "erp-configuration",
    label: "ERP/configuration",
    signals: [/erp/i, /config/i, /setting/i, /workflow/i, /approval/i, /tenant/i],
    probes: ["inventory tenant settings, approval flows, seeded metadata, and customization points"],
    risks: ["configuration may encode real business process", "tenant-specific exceptions may look like global rules"],
    questions: ["Which configured variants are intentional and currently used?"],
  },
  {
    id: "manufacturing",
    label: "Manufacturing",
    signals: [/bom/i, /work.?order/i, /routing/i, /capacity/i, /station/i, /inventory/i],
    probes: ["inspect BOM, routing, capacity, inventory, quality, and shop-floor state transitions"],
    risks: ["real-world capacity constraints may not be visible in code", "manual overrides may be operationally required"],
    questions: ["Which physical process constraints must be preserved?"],
  },
  {
    id: "finance",
    label: "Finance",
    signals: [/invoice/i, /ledger/i, /payment/i, /posting/i, /reconciliation/i, /tax/i],
    probes: ["inspect money movement, posting, reconciliation, audit, and irreversible operations"],
    risks: ["financial operations may be irreversible", "rounding or tax behavior may be jurisdiction-specific"],
    questions: ["Which ledgers/reports are authoritative for financial correctness?"],
  },
  {
    id: "regulated",
    label: "Regulated",
    signals: [/gxp/i, /audit/i, /validation/i, /sop/i, /patient/i, /quality/i],
    probes: ["inspect audit trails, validation evidence, access control, controlled docs, and signatures"],
    risks: ["runtime behavior may require validation-grade evidence", "private/sensitive data must not enter shared memory"],
    questions: ["Which compliance scope applies to this workflow?"],
  },
  {
    id: "integration-api",
    label: "Integration/API",
    signals: [/api\//, /routes?\//, /webhook/i, /connector/i, /adapter/i, /import/i, /export/i],
    probes: ["inspect API routes, payload schemas, webhooks, file contracts, retries, and idempotency"],
    risks: ["external contracts may be more authoritative than local types", "retry/idempotency behavior may be business-critical"],
    questions: ["Which external systems consume or produce this contract?"],
  },
  {
    id: "ecommerce",
    label: "Ecommerce",
    signals: [/shopify/i, /cart/i, /checkout/i, /product/i, /collection/i, /order/i, /discount/i],
    probes: ["inspect product/catalog/cart/checkout/order flows and rendered buyer experience"],
    risks: ["rendered store behavior may differ from source templates", "merchant configuration may drive core behavior"],
    questions: ["Which storefront states and buyer journeys are commercially critical?"],
  },
];

function normalizePath(filePath) {
  return String(filePath || "").split("\\").join("/");
}

function detectAdapters(filePaths, adapters = STARTER_ADAPTERS) {
  const normalized = filePaths.map(normalizePath);
  return adapters.map((adapter) => {
    const matches = [];
    for (const filePath of normalized) {
      if (adapter.signals.some((signal) => signal.test(filePath))) matches.push(filePath);
    }
    return {
      id: adapter.id,
      label: adapter.label,
      matched: matches.length > 0,
      confidence: matches.length >= 3 ? "observed" : matches.length > 0 ? "inferred" : "unknown",
      matched_paths: matches.slice(0, 20),
      probes: adapter.probes,
      risks: adapter.risks,
      questions: adapter.questions,
    };
  }).filter((result) => result.matched);
}

module.exports = {
  STARTER_ADAPTERS,
  detectAdapters,
};
