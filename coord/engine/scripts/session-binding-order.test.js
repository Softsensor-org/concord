"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { stampSessionBinding, appendSessionBinding, latestSessionBinding } = require("./session-binding-order.js");
const row = (id, sequence, time = "2026-09-22T12:00:00Z") => ({
  session_id: id, board_path: "/fixture/board.json", thread_id: "native-thread", claimed_at: time,
  ...(sequence === undefined ? {} : { binding_sequence: sequence }),
});

test("COORD-766: append records order without changing historical intervals or consulting clocks", () => {
  const history = [row("earlier", 7, "2099-01-01T00:00:00Z")], before = structuredClone(history);
  const next = row("next", undefined, "2000-01-01T00:00:00Z");
  appendSessionBinding(history, next);
  assert.equal(next.binding_sequence, 8);
  assert.deepEqual(history.slice(0, -1), before);
  assert.equal(latestSessionBinding(history), next);
});

test("COORD-766: ordering is isolated by both board and native thread", () => {
  const history = [row("own", 2), { ...row("foreign-thread", Number.MAX_SAFE_INTEGER), thread_id: "other" },
    { ...row("foreign-board", null), board_path: "/other/board.json" }];
  const next = row("next"); appendSessionBinding(history, next);
  assert.equal(next.binding_sequence, 3);
});

test("COORD-766: an in-place authorized repair becomes latest without moving array entries", () => {
  const history = [row("repair", 1), row("later", 2)];
  stampSessionBinding(history, history[0]);
  assert.equal(history[0].binding_sequence, 3);
  assert.equal(latestSessionBinding(history).session_id, "repair");
});

test("COORD-766: a new recorded binding supersedes legacy timestamps without rewriting them", () => {
  const history = [row("legacy", undefined, "2099-01-01T00:00:00Z")], before = structuredClone(history);
  appendSessionBinding(history, row("new"));
  assert.equal(latestSessionBinding(history).session_id, "new");
  assert.deepEqual(history[0], before[0]);
});

test("COORD-766: legacy order must be unambiguous and agree with the stored sequence", () => {
  const first = row("first", undefined, "2026-01-01T00:00:00Z"), last = row("last");
  assert.equal(latestSessionBinding([first, last]), last);
  assert.equal(latestSessionBinding([last, first]), null);
  assert.equal(latestSessionBinding([last, { ...last, session_id: "tie" }]), null);
  assert.equal(latestSessionBinding([]), null);
  assert.equal(latestSessionBinding([{ ...last, claimed_at: "invalid" }]), null);
});

test("COORD-766: conflicting latest sequence refuses until explicit binding records a later interval", () => {
  const history = [row("one", 2), row("two", 2)];
  assert.equal(latestSessionBinding(history), null);
  appendSessionBinding(history, row("explicit-new-binding"));
  assert.equal(latestSessionBinding(history).session_id, "explicit-new-binding");
});

for (const value of [null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
  test(`COORD-766: malformed ordering ${JSON.stringify(value)} refuses before append`, () => {
    const history = [row("bad", value)], before = structuredClone(history);
    assert.equal(latestSessionBinding(history), null);
    assert.throws(() => appendSessionBinding(history, row("next")), /Invalid session binding_sequence/);
    assert.deepEqual(history, before);
  });
}

test("COORD-766: exhausted sequence never wraps or partially appends", () => {
  const history = [row("last", Number.MAX_SAFE_INTEGER)], before = structuredClone(history);
  assert.throws(() => appendSessionBinding(history, row("next")), /exhausted/);
  assert.deepEqual(history, before);
});
