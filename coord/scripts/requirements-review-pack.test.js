"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const reviewPack = require("./requirements-review-pack.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("review pack defines the required read-only sub-agent lenses and synthesizer", () => {
  const pack = reviewPack.reviewPack({ project: "sample" });
  assert.equal(pack.kind, "concord.requirements.multi_agent_review_pack");
  assert.deepEqual(
    pack.lenses.map((lens) => lens.id),
    ["persona", "workflow", "screen", "backend_api", "data_event", "security_rbac", "evidence_test", "donor_reuse"]
  );
  assert.equal(pack.safety_model.sub_agents, "read_only_findings_only");
  assert.equal(pack.safety_model.synthesizer, "single_governed_writer");
  assert.match(pack.finding_schema.mutation_rule, /must not edit docs, board rows, prompts, plan records/);
  assert.match(pack.synthesizer.mutation_path, /one governed ticket/);
});

test("review pack JSON output is deterministic and source-citation oriented", () => {
  const first = JSON.stringify(reviewPack.reviewPack({ project: "sample" }), null, 2);
  const second = JSON.stringify(reviewPack.reviewPack({ project: "sample" }), null, 2);
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.ok(parsed.finding_schema.required_fields.includes("source_citations"));
  assert.match(parsed.finding_schema.source_citation_rule, /private:\/\/ pointers/);
});

test("review pack command writes only the explicit output artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-review-pack-"));
  const output = "coord/.runtime/requirements/review-pack.json";
  const result = reviewPack.run(["--project", "sample", "--json", "--output", output], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.project, "sample");
  assert.equal(written.lenses.length, 8);
  assert.equal(fs.existsSync(path.join(dir, "coord/board/tasks.json")), false);
});

test("product CLI routes requirements-review-pack", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-review-pack"].run, "function");
  const cap = capture();
  const result = dispatch(["requirements-review-pack", "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.multi_agent_review_pack");
});
