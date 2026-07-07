"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const walking = require("./requirements-walking-skeleton.js");
const { buildRegistry } = require("./coord-cli.js");

test("fixture flows through import, link, trace, and readout", () => {
  const result = walking.run(["--json"], { log: () => {} });
  assert.equal(result.code, 0);
  assert.equal(result.registry.requirements.length, 2);
  assert.equal(result.matrix.summary.linked_requirements, 2);
  assert.equal(result.readout.traceability_summary.linked_tickets, 2);
  assert.deepEqual(result.readout.rows, [
    { requirement_id: "URS-001", tickets: ["REQSKEL-001"] },
    { requirement_id: "URS-002", tickets: ["REQSKEL-002"] },
  ]);
});

test("run writes minimal CLI readout when output is explicit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-walking-skeleton-"));
  const output = path.join(dir, "readout.md");
  const result = walking.run(["--output", output], { log: () => {} });
  assert.equal(result.code, 0);
  const body = fs.readFileSync(output, "utf8");
  assert.match(body, /Imported requirements: 2/);
  assert.match(body, /Linked tickets: 2/);
  assert.match(body, /URS-001: REQSKEL-001/);
});

test("coord CLI registers the walking-skeleton command", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry["requirements-walking-skeleton"]);
  assert.equal(typeof registry["requirements-walking-skeleton"].run, "function");
});
