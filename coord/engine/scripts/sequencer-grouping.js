"use strict";

// COORD-749: pure overlap grouping, stable group identity and risk aggregation.
// These helpers own no board state and preserve the sequencer's existing format.
const crypto = require("node:crypto");

function makeUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let p = parent.get(id);
    while (p !== parent.get(p)) {
      p = parent.get(p);
    }
    let current = id;
    while (parent.get(current) !== p) {
      const next = parent.get(current);
      parent.set(current, p);
      current = next;
    }
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  };
  return { find, union };
}

function sequencerGroupId(tickets) {
  const material = tickets
    .map((item) => `${item.ticket}:${item.files.join(",")}:${item.reasons.map((r) => r.code).join(",")}`)
    .sort()
    .join("|");
  return `sha256:${crypto.createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

function gateModeForReasons(reasons) {
  return reasons.some((reason) => reason.gate_mode === "full") ? "full" : "slice";
}

module.exports = { makeUnionFind, sequencerGroupId, gateModeForReasons };
