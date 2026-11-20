"use strict";

// Shared synthetic pilot fixture; never embeds real customer identifiers.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const discovery = require("./business-discovery.js");
const synth = require("./business-discovery-synthesize.js");

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function publicSafePilotRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-pilot-"));
  write(path.join(dir, "coord/project.config.js"), [
    "module.exports = {",
    "  repos: {",
    "    POS: { path: 'generic-pos', integrationBranch: 'main' },",
    "    ERP: { path: 'generic-erp', integrationBranch: 'main' }",
    "  }",
    "};",
    "",
  ].join("\n"));
  write(path.join(dir, "generic-pos/src/api/menuAdapter.ts"), "const app = express(); app.post('/menu', publishMenuContract);\n");
  write(path.join(dir, "generic-pos/src/api/itemModifierTaxRules.ts"), "export function validateTaxContract() {}\n");
  write(path.join(dir, "generic-pos/fixtures/menu-adapter-contract.json"), "{\"items\":[],\"modifiers\":[],\"taxRules\":[]}\n");
  write(path.join(dir, "generic-erp/config/tenant-approval-workflow.yaml"), "approval: required\n");
  write(path.join(dir, "generic-erp/src/workflows/approvalSettings.ts"), "export const approvalSettings = {};\n");
  write(path.join(dir, "generic-erp/docs/configuration-surface.md"), "# Generic ERP configuration\n");

  const run = discovery.analyze(dir, { maxFiles: 100 });
  const source = run.sources.find((candidate) => /tenant-approval-workflow/.test(candidate.path)) || run.sources[0];
  run.records.push({
    id: "BD-REC-PILOT-CONFLICT",
    kind: "contradiction",
    subject: "generic-approval-policy",
    predicate: "approval_before_menu_publish",
    object: null,
    statement: "Generic POS fixture says menu tax changes can publish immediately, while generic ERP fixture requires approval before publish.",
    scope: { repos: ["POS", "ERP"], bounded_context: "public-safe-pilot", tenants: [], applies_when: "menu tax configuration changes" },
    confidence: "contradicted",
    status: "candidate",
    classification: "internal",
    evidence: [{ source_id: source.id, note: "synthetic public-safe contradiction for pilot fixture" }],
    history: { effective_from: null, effective_to: null, supersedes: [], superseded_by: null, source_hashes: [] },
    review: { owner: "business-domain-owner", review_required: true, reason: "resolve generic fixture contradiction before behavior-changing work" },
  });
  // Client policy of this pilot scenario: customer-managed KMS signing authority is
  // governed by ADR 0012. The scenario declares it, so the pack must keep it.
  run.required_adr_refs = ["ADR-0012"];
  return { dir, run, synthesis: synth.synthesize(run) };
}

module.exports = { publicSafePilotRun };

