"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dc = require("./duplicate-check.js");
const { FIXTURE_ROWS, PROPOSALS, GUARD_IDS } = require("./__fixtures__/duplicate-check.fixtures.js");

const NOW = new Date("2026-11-14T00:00:00.000Z");
const GUARD_MERGE_IDS = ["COORD-958", "COORD-959", "COORD-960", "COORD-961", "COORD-962", "COORD-963", "COORD-964"];

function candidatesFor(description, rows = FIXTURE_ROWS, doneDates = {}) {
  return dc.findCandidates({ description, rows, guardIds: GUARD_IDS, doneDates, now: NOW, top: 20 });
}

function find(list, id) {
  return list.find((candidate) => candidate.id === id);
}

test("COORD-975: threshold, top-N and policy default are pinned constants", () => {
  assert.equal(dc.DUPLICATE_THRESHOLD, 0.2);
  assert.equal(dc.RECENT_DONE_DAYS, 90);
  assert.deepEqual(dc.ENFORCEMENT_MODES, ["off", "on"]);
  const missing = path.join(os.tmpdir(), `coord975-no-policy-${process.pid}.json`);
  assert.deepEqual(dc.readFilingPolicy(missing), { enforcement: "off", source: "default" });
});

test("COORD-975: the shipped policy file keeps enforcement off until ADR 0026 is accepted", () => {
  const shipped = path.resolve(__dirname, "..", "duplicate-check-policy.json");
  assert.equal(dc.readFilingPolicy(shipped).enforcement, "off");
});

test("COORD-975: F-08 guard merge proposal is flagged as a near-duplicate of COORD-958..964", () => {
  const list = candidatesFor(PROPOSALS.F08_GUARD_MERGES);
  for (const id of GUARD_MERGE_IDS) {
    const candidate = find(list, id);
    assert.ok(candidate, `${id} is a candidate`);
    assert.equal(candidate.flagged, true, `${id} scores ${candidate.score} at or above ${dc.DUPLICATE_THRESHOLD}`);
    assert.ok(candidate.evidence.guards.length > 0, `${id} shares a named guard id with the proposal`);
  }
  assert.ok(GUARD_MERGE_IDS.includes(list[0].id), "the top candidate is one of the guard merge tickets");
  assert.deepEqual(find(list, "COORD-958").evidence.guards, ["engine-pin", "template-sync"]);
});

test("COORD-975: F-02 gitFileMode proposal is flagged as a near-duplicate of COORD-938", () => {
  const list = candidatesFor(PROPOSALS.F02_GITFILEMODE);
  const candidate = find(list, "COORD-938");
  assert.ok(candidate, "COORD-938 is a candidate");
  assert.equal(candidate.flagged, true, `score ${candidate.score}`);
  assert.deepEqual(candidate.evidence.paths, ["tree-fingerprint.js"]);
  assert.equal(list[0].id, "COORD-938", "COORD-938 is the top candidate");
});

test("COORD-975: F-15 base-ref proposal is flagged as a near-duplicate of COORD-898", () => {
  const list = candidatesFor(PROPOSALS.F15_BASE_REF);
  const candidate = find(list, "COORD-898");
  assert.ok(candidate, "COORD-898 is a candidate");
  assert.equal(candidate.flagged, true, `score ${candidate.score}`);
  assert.deepEqual(candidate.evidence.paths, ["landing-resolution.js"]);
  assert.equal(list[0].id, "COORD-898", "COORD-898 is the top candidate");
});

test("COORD-975: a near miss with distinct scope is flagged (shared guard file) and needs a recorded distinction", () => {
  const list = candidatesFor(PROPOSALS.NEAR_MISS_ANSWERS);
  const candidate = find(list, "COORD-958");
  assert.equal(candidate.flagged, true, `score ${candidate.score}`);
  assert.deepEqual(candidate.evidence.paths, ["governance-guards.json"], "the only shared evidence is the registry file");
  assert.deepEqual(candidate.evidence.guards, [], "no guard id is shared: the concern is answers hygiene, not a merge");
  const flagged = list.filter((item) => item.flagged);
  assert.equal(dc.evaluateFiling({ candidates: list }).decision, "advisory", "with enforcement off it is advisory");
  assert.equal(dc.evaluateFiling({ candidates: list, links: { distinctFrom: ["COORD-958"], reason: "answers hygiene, not guard merges" } }).decision, "linked");
  assert.ok(flagged.length > 0);
});

test("COORD-975: an unrelated ticket has no flagged candidate and no shared paths or guards", () => {
  const list = candidatesFor(PROPOSALS.UNRELATED_UI);
  assert.equal(list.some((candidate) => candidate.flagged), false);
  for (const candidate of list) {
    assert.deepEqual(candidate.evidence.paths, []);
    assert.deepEqual(candidate.evidence.guards, []);
  }
});

test("COORD-975: scoring is deterministic and ties are ordered by id", () => {
  const first = candidatesFor(PROPOSALS.F08_GUARD_MERGES);
  const second = candidatesFor(PROPOSALS.F08_GUARD_MERGES);
  assert.deepEqual(first, second);
  const tied = [
    { ID: "COORD-902", Status: "todo", Description: "same words here" },
    { ID: "COORD-901", Status: "todo", Description: "same words here" },
  ];
  const ordered = dc.findCandidates({ description: "same words here", rows: tied, guardIds: GUARD_IDS, now: NOW });
  assert.deepEqual(ordered.map((candidate) => candidate.id), ["COORD-901", "COORD-902"]);
  const repeated = dc.findCandidates({
    description: "same words here",
    rows: [tied[0], { ...tied[0], Status: "doing" }],
    guardIds: GUARD_IDS,
    now: NOW,
  });
  assert.deepEqual(repeated.map((candidate) => candidate.status), ["todo", "doing"]);
  const partial = dc.extractFacets("verify receipt guard:prompt-record");
  assert.deepEqual([...partial.guards], ["prompt-record"]);
  const unweighted = dc.scoreFacets(partial, partial);
  assert.equal(unweighted.contributing.description, 1);
  assert.equal(unweighted.contributing.guards, 1);
  assert.deepEqual(unweighted.evidence.description, [...partial.description].sort());
  const negativeWeights = new Map([...partial.description].map((word) => [word, -1]));
  const invalidWeights = dc.scoreFacets(partial, partial, negativeWeights);
  assert.equal(invalidWeights.contributing.description, 0);
  assert.equal(invalidWeights.contributing.guards, 1);

});

test("COORD-975: superseded rows are never candidates; done rows age out of the 90-day window", () => {
  const rows = [
    { ID: "COORD-801", Status: "superseded", Description: PROPOSALS.F02_GITFILEMODE },
    { ID: "COORD-802", Status: "done", Description: PROPOSALS.F02_GITFILEMODE },
    { ID: "COORD-803", Status: "done", Description: PROPOSALS.F02_GITFILEMODE },
    { ID: "COORD-804", Status: "done", Description: PROPOSALS.F02_GITFILEMODE },
  ];
  const doneDates = { "COORD-802": "2026-07-01T00:00:00.000Z", "COORD-803": "2026-11-01T00:00:00.000Z" };
  const ids = candidatesFor(PROPOSALS.F02_GITFILEMODE, rows, doneDates).map((candidate) => candidate.id);
  assert.equal(ids.includes("COORD-801"), false, "superseded is excluded");
  assert.equal(ids.includes("COORD-802"), false, "done 136 days ago is outside the window");
  assert.equal(ids.includes("COORD-803"), true, "done 13 days ago is inside the window");
  assert.equal(ids.includes("COORD-804"), true, "undated done rows are kept (date unknown, conservative)");
});

test("COORD-975: evaluateFiling decides advisory, linked, refuse and none", () => {
  const flagged = [{ id: "COORD-958", flagged: true, score: 0.5, evidence: {} }];
  const quiet = [{ id: "COORD-999", flagged: false, score: 0.1, evidence: {} }];
  assert.equal(dc.evaluateFiling({ candidates: quiet }).decision, "none");
  assert.equal(dc.evaluateFiling({ candidates: flagged }).decision, "advisory");
  assert.equal(dc.evaluateFiling({ candidates: flagged, policy: { enforcement: "on" } }).decision, "blocked");
  assert.equal(dc.evaluateFiling({ candidates: flagged, links: { duplicateOf: "COORD-958" }, policy: { enforcement: "on" } }).decision, "linked");
  assert.equal(dc.evaluateFiling({ candidates: flagged, links: { distinctFrom: ["COORD-958"] }, policy: { enforcement: "on" } }).decision, "linked");
});

test("COORD-975: policy values outside off|on are refused, not silently treated as on", () => {
  assert.throws(() => dc.normalizePolicy({ enforcement: "maybe" }), /enforcement must be one of off, on/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord975-policy-"));
  try {
    const file = path.join(dir, "duplicate-check-policy.json");
    fs.writeFileSync(file, JSON.stringify({ enforcement: "on" }));
    assert.equal(dc.readFilingPolicy(file).enforcement, "on");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-975: the advisory text lists each candidate with its score and shared evidence", () => {
  const list = candidatesFor(PROPOSALS.F02_GITFILEMODE).slice(0, 2);
  const lines = dc.formatAdvisory(list).join("\n");
  assert.match(lines, /COORD-938 \[done\] score \d\.\d{3}/);
  assert.match(lines, /shared (description|paths|guards|functions|verbs):/);
});

test("partial board rows retain eligible matches and use mapped completion dates", () => {
  const description = PROPOSALS.F02_GITFILEMODE;
  const candidates = dc.findCandidates({
    description,
    rows: [null, {}, { ID: "TEST-1", Description: description },
      { ID: "TEST-2", Status: "done", Description: description }],
    now: NOW.toISOString(),
    guardIds: new Set(GUARD_IDS),
    doneDates: new Map([["TEST-2", "2020-01-01"]]),
  });
  assert.deepEqual(candidates.map(({ id, status }) => ({ id, status })), [{ id: "TEST-1", status: "" }]);
  assert.deepEqual(dc.findCandidates(), []);
});

test("unreadable filing policy propagates the read error and missing enforcement defaults off", () => {
  assert.throws(() => dc.readFilingPolicy(__dirname), { code: "EISDIR" });
  assert.deepEqual(dc.normalizePolicy({}), { enforcement: "off", source: "override" });
  assert.throws(() => dc.normalizePolicy(null), /enforcement must be one of/);
});

test("advisory retains low-score candidates with no shared evidence", () => {
  const lines = dc.formatAdvisory([{ id: "TEST-1", status: "todo", score: 0.1, flagged: false, evidence: {} }]);
  assert.deepEqual(lines, ["  TEST-1 [todo] score 0.100\n      no shared evidence"]);
});
