"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const coord = path.resolve(__dirname, "../..");
const createValidators = require(resolveEngineModule(coord, "scripts/plan-record-field-validators.js"));
const validate = createValidators({ fail(message) { throw new Error(message); } }).assertValidContextPackAck;
const schema = JSON.parse(fs.readFileSync(resolveEngineModule(coord, "board/plan.schema.json"))).properties.context_pack_ack;

test("COORD-571 admission vectors are anchored to the unchanged canonical acknowledgement schema", () => {
  const legacySchema = JSON.parse(fs.readFileSync(path.join(coord, "board/plan.schema.json"))).properties.context_pack_ack;
  assert.deepEqual(schema, legacySchema);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["authority", "closeout_learning", "considered", "refs"]);
  for (const group of ["considered", "authority", "closeout_learning"]) {
    assert.equal(schema.properties[group].type, "object");
    assert.equal(schema.properties[group].additionalProperties, false);
  }
  assert.deepEqual(Object.keys(schema.properties.considered.properties).sort(), ["active_constraints", "adrs", "business_rules", "conflicts", "open_questions", "stale_warnings"]);
  assert.deepEqual(Object.keys(schema.properties.authority.properties).sort(), ["advisory_only", "constraints"]);
  const learning = schema.properties.closeout_learning.properties;
  assert.deepEqual(learning.decision.type, ["string", "null"]);
  assert.deepEqual(learning.decision.enum, ["promote", "demote", "scratch-only", "mixed", "none", null]);
  assert.deepEqual(learning.rationale.type, ["string", "null"]);
});

test("COORD-571 writer rejects schema-invalid list, object, extra-key and enum values without coercion", () => {
  // Fixed admissions were independently checked against JSON Schema before
  // implementation. The board validator is not an oracle for union types
  // until COORD-801 lands; do not copy its known false accepts here.
  for (const value of [{}, { refs: [] }, { considered: {} }, { authority: {} }, { closeout_learning: {} }]) {
    assert.doesNotThrow(() => validate(value));
  }
  for (const decision of ["promote", "demote", "scratch-only", "mixed", "none", null]) {
    assert.doesNotThrow(() => validate({ closeout_learning: { decision } }));
  }
  for (const rationale of ["", "reason", null]) {
    assert.doesNotThrow(() => validate({ closeout_learning: { rationale } }));
  }
  const rejected = [null, [], "ack", 1, false, { notes: [] }, { unknown: [] }, { authority: { rejected_authority: [] } }];
  for (const group of ["considered", "authority", "closeout_learning"]) {
    for (const value of [null, [], "text", 1, false, { unknown: [] }]) rejected.push({ [group]: value });
  }
  for (const decision of ["archive", "", ["none"], {}, 1, false]) rejected.push({ closeout_learning: { decision } });
  for (const rationale of [[], ["text"], {}, 1, false]) rejected.push({ closeout_learning: { rationale } });
  for (const value of rejected) assert.throws(() => validate(value), /context_pack_ack.*--context-pack-ack/, JSON.stringify(value));

  const listFields = [[null, "refs"], ...Object.keys(schema.properties.considered.properties).map(key => ["considered", key]), ...Object.keys(schema.properties.authority.properties).map(key => ["authority", key]), ...["promote", "demote", "scratch_only"].map(key => ["closeout_learning", key])];
  for (const [group, key] of listFields) {
    const fieldSchema = group ? schema.properties[group].properties[key] : schema.properties[key];
    assert.equal(fieldSchema.type, "array");
    assert.deepEqual(fieldSchema.items, { type: "string" });
    const ack = value => group ? { [group]: { [key]: value } } : { [key]: value };
    for (const value of [[], [""], ["one", "two"]]) assert.doesNotThrow(() => validate(ack(value)));
    for (const value of ["text", null, {}, 1, false, ["ok", 1], [null]]) {
      assert.throws(() => validate(ack(value)), /must be an array of strings.*--context-pack-ack/, `${group}.${key}: ${JSON.stringify(value)}`);
    }
  }
});

test("COORD-571 legacy read compatibility is bounded to historically accepted acknowledgement shapes", () => {
  const legacy = { legacyAcknowledgementRead: true };
  for (const value of [
    { considered: { open_questions: "none", adrs: ["ADR-0002"] } },
    { authority: { constraints: "old", rejected_authority: ["old source"] } },
    { notes: "old note", closeout_learning: { decision: ["none"] } },
    { notes: [] },
  ]) assert.doesNotThrow(() => validate(value, legacy));
  for (const value of [
    { notes: 1 }, { considered: { open_questions: [1] } },
    { authority: { constraints: null } }, { authority: { unknown: [] } },
    { closeout_learning: { decision: ["archive"] } }, { closeout_learning: { rationale: {} } },
  ]) assert.throws(() => validate(value, legacy), /--context-pack-ack/);
});

test("COORD-571 public update-plan refuses invalid writes atomically and explicitly repairs a sealed legacy acknowledgement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord571-public-"));
  const target = path.join(root, "coord");
  const ticket = "ACK-571";
  try {
    for (const dir of ["engine", "scripts", "product", "docs"]) {
      const from = path.join(coord, dir);
      fs.cpSync(from, path.join(target, dir), {
        recursive: true,
        filter: source => !/\.test\.js$/.test(source) && !path.relative(from, source).split(path.sep).some(part => [".runtime", ".worktrees", "node_modules"].includes(part)),
      });
    }
    fs.mkdirSync(path.join(target, "board"), { recursive: true });
    for (const file of fs.readdirSync(path.join(coord, "board"))) {
      if (file === "board.js" || file.endsWith(".schema.json")) fs.copyFileSync(path.join(coord, "board", file), path.join(target, "board", file));
    }
    for (const file of ["paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "engine-pin.json", "TEMPLATE_SYNC_MANIFEST.json"]) {
      fs.copyFileSync(path.join(coord, file), path.join(target, file));
    }
    const row = { ID: ticket, Repo: "X", Type: "bug", Pri: "P1", Status: "todo", Owner: "unassigned", Description: "Acknowledgement migration fixture", "Depends On": "" };
    const board = {
      version: 1,
      metadata: { title: "Acknowledgement fixture", last_updated: "2026-01-01", canonical_references: [], plan_markdown_render_statuses: ["todo", "doing", "review"], preamble: [] },
      sections: [{ kind: "table", level: 2, heading: "Fixture", separator_before: false, columns: Object.keys(row), rows: [row] }],
      prompt_index: { [ticket]: `coord/prompts/${ticket}.md` }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
    };
    fs.writeFileSync(path.join(target, "board/tasks.json"), JSON.stringify(board));
    fs.mkdirSync(path.join(target, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(target, `prompts/${ticket}.md`), `# ${ticket}\n`);
    fs.writeFileSync(path.join(target, "PLAN.md"), "");
    fs.writeFileSync(path.join(target, "QUESTIONS.md"), "# Questions\n");
    const { fixedLayoutEnv } = require(resolveEngineModule(coord, "scripts/session-lifecycle-test-utils.js"));
    const env = fixedLayoutEnv(path.basename(root));
    const cliPath = path.join(target, "scripts/governance.js");
    const child = args => spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 30000 });
    const cli = (...args) => child([cliPath, ...args]);
    const ok = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    // Author a disposable historical state through the existing fixture seam;
    // the actual commands below use the public CLI with no validator override.
    ok(child(["-e", `const path=require("node:path");const {resolveEngineModule}=require(${JSON.stringify(path.join(coord,"paths.js"))});const u=require(resolveEngineModule(${JSON.stringify(target)},"scripts/governance-test-utils.js"));u.__testing.ensureGovernanceJournalBaseline("isolated ACK fixture");`]));
    ok(cli("agentid", "--assign"));
    ok(cli("plan", ticket, "--seed"));
    const planPath = path.join(target, `.runtime/plans/${ticket}.json`);
    const journalPath = path.join(target, ".runtime/governance-events.ndjson");
    const snapshot = () => [planPath, path.join(target, "PLAN.md"), path.join(target, "board/tasks.json"), journalPath].map(file => fs.readFileSync(file, "utf8"));
    for (const invalid of [{ considered: { open_questions: "none" } }, { notes: [] }, { authority: { rejected_authority: [] } }, { closeout_learning: { decision: ["none"] } }, { closeout_learning: { rationale: 1 } }]) {
      const before = snapshot();
      const refusal = cli("update-plan", ticket, "--context-pack-ack", JSON.stringify(invalid));
      assert.equal(refusal.status, 1);
      assert.match(refusal.stderr, /context_pack_ack.*--context-pack-ack/);
      assert.deepEqual(snapshot(), before, "invalid public write must preserve plan, projection, board and journal");
    }
    const legacy = { considered: { open_questions: "none" }, authority: { rejected_authority: ["old source"] }, notes: "old note", closeout_learning: { decision: ["none"] } };
    const record = JSON.parse(fs.readFileSync(planPath, "utf8"));
    record.context_pack_ack = legacy;
    fs.writeFileSync(planPath, `${JSON.stringify(record, null, 2)}\n`);
    // This setup event models an already-sealed record admitted by the old
    // writer. It does not alter the production validator or mutation under test.
    ok(child(["-e", `const fs=require("node:fs"),path=require("node:path"),{resolveEngineModule}=require(${JSON.stringify(path.join(coord,"paths.js"))}),u=require(resolveEngineModule(${JSON.stringify(target)},"scripts/governance-test-utils.js"));const r=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}));u.__testing.writePlanCompatibilityBlockFromRecord(${JSON.stringify(ticket)},r);u.__testing.appendGovernanceEvent({ts:new Date().toISOString(),command:"fixture-legacy-state",ticket:${JSON.stringify(ticket)},changed_paths:[],snapshot:u.__testing.buildGovernanceSnapshot()});`]));
    const before = snapshot();
    const unrelated = cli("update-plan", ticket, "--summary", "unrelated change");
    assert.equal(unrelated.status, 1);
    assert.match(unrelated.stderr, /--context-pack-ack/);
    assert.deepEqual(snapshot(), before);
    const replacement = { considered: { open_questions: [] }, authority: { constraints: [] }, closeout_learning: { decision: null, rationale: null } };
    ok(cli("update-plan", ticket, "--context-pack-ack", JSON.stringify(replacement)));
    const repaired = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(repaired.context_pack_ack, replacement);
    assert.doesNotThrow(() => validate(repaired.context_pack_ack));
    assert.match(fs.readFileSync(path.join(target, "PLAN.md"), "utf8"), /"decision":null/);
    const events = fs.readFileSync(journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.at(-1).command, "update-plan");
    assert.ok(events.at(-1).changed_paths.some(file => file.endsWith(`${ticket}.json`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
