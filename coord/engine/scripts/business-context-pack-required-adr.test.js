"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const contextPack = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/business-context-pack.js"));
const { publicSafePilotRun } = require("./business-context-pack-test-fixtures.js");

const QUERY = {
  ticket: "PILOT-001",
  scope: "menu tax publish approval configuration",
  touchedFiles: ["generic-pos/src/api/menuAdapter.ts", "generic-erp/config/tenant-approval-workflow.yaml"],
  requirements: ["Resolve whether menu tax changes can publish immediately or require ERP approval."],
  limit: 2,
};

function adrFile(dir, number, title, decision) {
  fs.writeFileSync(path.join(dir, `${number}-${title}.md`), [
    `# ADR ${number}: ${title}`,
    "",
    "- **Status:** Accepted",
    "- **Ticket:** COORD-TEST",
    "- **Date:** 2026-11-16",
    "",
    "## Decision",
    "",
    decision,
    "",
  ].join("\n"));
}

// A required, low-scoring accepted ADR plus ten accepted ADRs that score higher on the query.
function registryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-required-adr-"));
  adrFile(dir, "0012", "signing-authority", "Signing authority moves to a customer-managed KMS.");
  for (let i = 1; i <= 10; i += 1) {
    adrFile(dir, `01${String(i).padStart(2, "0")}`, `menu-tax-${i}`,
      "Menu tax publish approval configuration: menu tax publish approval configuration governs menu tax publish approval configuration.");
  }
  return dir;
}

function adrIds(pack) {
  return pack.sections.adrs.items.map((item) => item.id || item.adr_id || item.title || JSON.stringify(item).slice(0, 60));
}

function hasAdr(pack, number) {
  return JSON.stringify(pack.sections.adrs.items).includes(`ADR-${number}`) ||
    JSON.stringify(pack.sections.adrs.items).includes(`${number}-`);
}

test("a scenario-required ADR survives score ranking and the limit when more high-scoring ADRs are accepted", () => {
  const dir = registryDir();
  try {
    const { synthesis } = publicSafePilotRun();
    const pack = contextPack.buildPack(synthesis, { ...QUERY, rootDir: dir, adrDir: dir });
    assert.equal(hasAdr(pack, "0012"), true, JSON.stringify(pack.sections.adrs.items).slice(0, 400));
    const scoreRanked = pack.sections.adrs.items.filter((item) => !/required by the pack scenario/.test(JSON.stringify(item)));
    assert.equal(scoreRanked.length, 2, "the limit still bounds the score-ranked remainder");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a scenario declaration the same ADR is evicted, so the declaration is what keeps it", () => {
  const dir = registryDir();
  try {
    const { synthesis } = publicSafePilotRun();
    const undeclared = { ...synthesis };
    delete undeclared.required_adr_refs;
    const pack = contextPack.buildPack(undeclared, { ...QUERY, rootDir: dir, adrDir: dir });
    assert.equal(hasAdr(pack, "0012"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("options.requiredAdrs keeps a caller-named accepted ADR the same way", () => {
  const dir = registryDir();
  try {
    const { synthesis } = publicSafePilotRun();
    const undeclared = { ...synthesis };
    delete undeclared.required_adr_refs;
    const pack = contextPack.buildPack(undeclared, { ...QUERY, rootDir: dir, adrDir: dir, requiredAdrs: ["ADR-0012"] });
    assert.equal(hasAdr(pack, "0012"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("required decisions remain ordered and visible when the ranking limit is smaller than the required set", () => {
  const dir = registryDir();
  try {
    const { synthesis } = publicSafePilotRun();
    const pack = contextPack.buildPack(synthesis, {
      ...QUERY, rootDir: dir, adrDir: dir, requiredAdrs: ["ADR-0102", "ADR-0012"], limit: 1,
    });
    assert.deepEqual(adrIds(pack).slice(0, 2), ["ADR-0012", "ADR-0102"]);
    assert.equal(adrIds(pack).filter(id => id === "ADR-0012").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sparse synthesis still requires a ticket and represents missing evidence explicitly", () => {
  const { synthesis } = publicSafePilotRun();
  assert.throws(() => contextPack.buildPack(null), /synthesis artifact/);
  assert.throws(() => contextPack.buildPack(synthesis), /ticket is required/);
  const sparse = { ...synthesis };
  delete sparse.generated_at_utc;
  delete sparse.unknowns;
  delete sparse.promotion_candidates;
  const pack = contextPack.buildPack(sparse, { ticket: "PILOT-002" });
  assert.equal(pack.input.source_generated_at_utc, null);
  assert.deepEqual(pack.sections.approvals.items, []);
  assert.deepEqual(pack.sections.open_questions.items, []);
});
