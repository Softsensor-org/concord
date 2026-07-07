"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildContinuityCockpitModel } = require("./continuity-cockpit-model.js");

test("continuity model exposes the defined object shapes (reused from the engine)", () => {
  const model = buildContinuityCockpitModel({});
  assert.equal(model.kind, "concord.continuity.cockpit_model");
  assert.equal(model.mode, "read-only");
  assert.ok(model.shapes.length >= 1, "expected at least one defined continuity shape");
  for (const shape of model.shapes) {
    assert.ok(typeof shape.shape === "string" && shape.shape.length > 0);
    assert.ok(Array.isArray(shape.warm_start_fields));
    assert.ok(Array.isArray(shape.cold_finish_fields));
  }
});

test("empty plan dir → zero coverage and an honest adoption note", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-empty-"));
  try {
    const model = buildContinuityCockpitModel({ plansDir: dir });
    assert.equal(model.summary.with_any_continuity, 0);
    assert.equal(model.records.length, 0);
    assert.ok(model.adoption_note && /not in active use/.test(model.adoption_note));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only populated continuity blocks count (empty block is not a false positive)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-data-"));
  try {
    // empty warm_start block must NOT count
    fs.writeFileSync(path.join(dir, "T-1.json"), JSON.stringify({ ticket: "T-1", warm_start: {} }));
    // nested, populated warm_start + cold_finish must count
    fs.writeFileSync(
      path.join(dir, "T-2.json"),
      JSON.stringify({
        ticket: "T-2",
        continuity: { warm_start: { prior_context: "x" }, cold_finish: { changed: "y" } },
      })
    );
    const model = buildContinuityCockpitModel({ plansDir: dir });
    assert.equal(model.summary.plan_records_scanned, 2);
    assert.equal(model.summary.with_any_continuity, 1, "only T-2 has populated continuity data");
    assert.equal(model.records[0].ticket, "T-2");
    assert.equal(model.records[0].warm_start, true);
    assert.equal(model.records[0].cold_finish, true);
    assert.equal(model.adoption_note, null, "a populated record clears the adoption note");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
