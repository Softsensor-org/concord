"use strict";

// COORD-963: the owner WIP cap (wip-cap) is retired. Its attention concern (one owner silently
// holding unrelated doing tickets; COORD-008, COORD-558, COORD-692) is now a doctor warning
// (owner-doing) built on followups.js findUnrelatedOwnerDoingPairs.
//
// Golden equivalence: __fixtures__/wip-cap-golden.json freezes the retired guard's decision
// (refuse R / admit A) for 4610 owner/doing-state boards, recorded on unmodified origin/dev
// 7e08e065 before the removal. After admission the ticket is doing under the actor, so the
// warning must fire on exactly the refused states, plus the pinned set of admitted states the old
// cap let through only because it checked the owner's first doing row (see the fixture note).

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { findUnrelatedOwnerDoingPairs } = require("./followups.js");
const { buildOwnerDoingDoctorWarnings } = require("./doctor-report.js");

const OWNER = "claudea808";
const OTHER = "claudea11";
const T = "COORD-T";

// Same enumeration as the recorded golden. Do not reorder: case ids and decision positions depend on it.
function buildMatrix() {
  const excKinds = ["none", "pairT", "pairR", "unrelatedParent"];
  const tStatuses = ["todo", "review"];
  const rowStatus = ["doing", "doingBlocked", "review", "todo"];
  const rowOwner = [OWNER, OTHER];
  const otherSets = [[]];
  for (const s1 of rowStatus) for (const o1 of rowOwner) {
    otherSets.push([{ key: "R1", owner: o1, status: s1 }]);
    for (const s2 of rowStatus) for (const o2 of rowOwner) {
      otherSets.push([{ key: "R1", owner: o1, status: s1 }, { key: "R2", owner: o2, status: s2 }]);
    }
  }
  const statusText = (s) => (s === "doingBlocked" ? "doing (blocked: waiting on input)" : s);
  const cases = [];
  let n = 0;
  for (const tStatus of tStatuses) for (const others of otherSets) for (const tExc of excKinds) for (const rExc of excKinds) for (const order of ["forward", "reverse"]) {
    if (others.length === 0 && (tExc !== "none" || rExc !== "none" || order !== "forward")) continue;
    const rows = [{ ID: T, Status: tStatus, Owner: tStatus === "todo" ? "unassigned" : OWNER }];
    const ids = {};
    others.forEach((o, i) => {
      const id = `COORD-R${i + 1}`;
      ids[i] = id;
      rows.push({ ID: id, Status: statusText(o.status), Owner: o.owner });
    });
    const exceptions = {};
    const r1 = ids[0];
    if (r1) {
      if (tExc === "pairT") exceptions[T] = { type: "closeout-blocker", parent: r1 };
      if (tExc === "unrelatedParent") exceptions[T] = { type: "closeout-blocker", parent: "COORD-ZZZ" };
      if (rExc === "pairR") exceptions[r1] = { type: "closeout-blocker", parent: T };
      if (rExc === "unrelatedParent") exceptions[r1] = { type: "closeout-blocker", parent: "COORD-ZZZ" };
    }
    if (order === "reverse") rows.reverse();
    cases.push({
      id: `case-${String(++n).padStart(4, "0")}`,
      board: { sections: [{ rows }], followup_exceptions: exceptions },
    });
  }
  return cases;
}

// Post-admission state: T is doing under the actor (the owner who would have been refused).
function afterAdmission(board) {
  const copy = JSON.parse(JSON.stringify(board));
  for (const row of copy.sections[0].rows) {
    if (row.ID === T) {
      row.Status = "doing";
      row.Owner = OWNER;
    }
  }
  return copy;
}

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "wip-cap-golden.json"), "utf8"));

test("COORD-963: the regenerated matrix is the recorded golden (same size, same ids, same refusal count)", () => {
  const cases = buildMatrix();
  assert.equal(cases.length, golden.case_count);
  assert.equal(golden.cap_decisions.length, golden.case_count);
  assert.equal((golden.cap_decisions.match(/R/g) || []).length, golden.refused_count);
  cases.forEach((entry, index) => {
    assert.equal(entry.id, `case-${String(index + 1).padStart(4, "0")}`);
  });
});

test("COORD-963: the owner-doing warning fires on exactly the states the retired wip-cap refused, plus the pinned masked admissions", () => {
  const masked = new Set(golden.admitted_with_unrelated_second_doing_row);
  const cases = buildMatrix();
  let refusedFlagged = 0;
  cases.forEach((entry, index) => {
    const pairs = findUnrelatedOwnerDoingPairs(afterAdmission(entry.board));
    const flagged = pairs.some((pair) => pair.left === T || pair.right === T);
    if (golden.cap_decisions[index] === "R") {
      assert.equal(flagged, true, `${entry.id}: wip-cap refused this state, so the owner-doing warning must fire`);
      refusedFlagged += 1;
    } else {
      assert.equal(flagged, masked.has(entry.id), `${entry.id}: wip-cap admitted this state; the warning fires only for the pinned masked set`);
    }
  });
  assert.equal(refusedFlagged, golden.refused_count);
  assert.equal(masked.size, 56, "the masked set is pinned; a change here must be reviewed");
});

test("COORD-963: a closeout-blocker pair (either direction) is not reported; an unrelated pair is", () => {
  for (const board of [null, {}, { sections: [{ heading: "Notes" }] }]) {
    assert.deepEqual(findUnrelatedOwnerDoingPairs(board), []);
  }
  const rows = [
    { ID: "COORD-A", Status: "doing", Owner: OWNER },
    { ID: "COORD-B", Status: "doing (blocked: x)", Owner: OWNER },
    { ID: "COORD-C", Status: "doing", Owner: OTHER },
  ];
  const linked = { sections: [{ rows }], followup_exceptions: { "COORD-B": { type: "closeout-blocker", parent: "COORD-A" } } };
  assert.deepEqual(findUnrelatedOwnerDoingPairs(linked), []);
  const unlinked = { sections: [{ rows }], followup_exceptions: {} };
  assert.deepEqual(findUnrelatedOwnerDoingPairs(unlinked), [{ owner: OWNER, left: "COORD-A", right: "COORD-B" }]);
});

test("COORD-963: the doctor warning names the owner and both unrelated doing tickets", () => {
  const board = {
    sections: [{ rows: [
      { ID: "COORD-A", Status: "doing", Owner: OWNER },
      { ID: "COORD-B", Status: "doing", Owner: OWNER },
    ] }],
    followup_exceptions: {},
  };
  const warnings = buildOwnerDoingDoctorWarnings({ board });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[owner-doing\] claudea808 holds unrelated doing tickets COORD-A and COORD-B /);
  assert.match(warnings[0], /WIP cap is retired, ADR 0021/);
  assert.deepEqual(buildOwnerDoingDoctorWarnings({ board: { sections: [{ rows: [] }], followup_exceptions: {} } }), []);
});
