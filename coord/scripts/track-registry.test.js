"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createTrackRegistry = require("./track-registry.js");
const { prefixOf, mergeTrack, BUILTIN_TRACKS, DEFAULT_TRACK_NAME } = createTrackRegistry;

// All tests inject an explicit projectConfig so they are hermetic and do not
// depend on the live coord/project.config.js.

test("prefixOf extracts the ticket prefix, including multi-segment prefixes", () => {
  assert.strictEqual(prefixOf("WEB-12"), "WEB");
  assert.strictEqual(prefixOf("COORD-181"), "COORD");
  assert.strictEqual(prefixOf("LIVE-MCP-007"), "LIVE-MCP");
  assert.strictEqual(prefixOf("web-3"), "WEB"); // case-insensitive
  assert.strictEqual(prefixOf("not-a-ticket"), null);
  assert.strictEqual(prefixOf(null), null);
});

test("built-in tracks resolve with no project config (every ticket -> development)", () => {
  const reg = createTrackRegistry({ projectConfig: {} });
  // Unknown prefix falls back to development + test gate (pre-track behavior).
  const t = reg.resolveTrack("BE-001");
  assert.strictEqual(t.name, DEFAULT_TRACK_NAME);
  assert.strictEqual(t.gateProc, "test");
  // Built-in prefixes still classify even without project overrides.
  assert.strictEqual(reg.trackNameForTicket("WEB-1"), "marketing");
  assert.strictEqual(reg.trackNameForTicket("OPS-1"), "devops");
  assert.strictEqual(reg.trackNameForTicket("LIVE-MCP-1"), "product-engineering");
  assert.strictEqual(reg.trackNameForTicket("DATA-1"), "data-analytics");
});

test("resolveTrack returns gate-proc, default lane, skills, review policy, operator", () => {
  const reg = createTrackRegistry({ projectConfig: {} });
  const pe = reg.resolveTrack("PE-9");
  assert.strictEqual(pe.name, "product-engineering");
  assert.strictEqual(pe.gateProc, "evidence");
  assert.strictEqual(pe.defaultLane, "default");
  assert.ok(pe.skills.includes("insight-analyst"));
  assert.strictEqual(pe.operator, "product-engineer");
  assert.strictEqual(pe.reviewPolicy.approvers, 1);

  const ops = reg.resolveTrack("OPS-2");
  assert.strictEqual(ops.gateProc, "infra");
  assert.strictEqual(ops.defaultLane, "full");
  assert.strictEqual(ops.reviewPolicy.approvers, 2);
});

test("data-analytics track maps to the data-contract gate", () => {
  const reg = createTrackRegistry({ projectConfig: {} });
  assert.strictEqual(reg.gateProcForTicket("ANALYTICS-4"), "data-contract");
  assert.strictEqual(reg.defaultLaneForTicket("DATA-4"), "default");
});

test("project.config tracks override built-ins (prefixes + reviewPolicy merge)", () => {
  const reg = createTrackRegistry({
    projectConfig: {
      tracks: {
        marketing: { prefixes: ["SITE"], reviewPolicy: { approvers: 3 } },
      },
    },
  });
  // overridden prefix now classifies marketing...
  assert.strictEqual(reg.trackNameForTicket("SITE-1"), "marketing");
  // ...and the old built-in prefix no longer maps to marketing (override replaces).
  assert.strictEqual(reg.trackNameForTicket("WEB-1"), DEFAULT_TRACK_NAME);
  const m = reg.trackByName("marketing");
  assert.strictEqual(m.reviewPolicy.approvers, 3); // override
  assert.strictEqual(m.gateProc, "content"); // built-in preserved via merge
});

test("a project can define an entirely new track", () => {
  const reg = createTrackRegistry({
    projectConfig: {
      tracks: {
        security: { gateProc: "test", defaultLane: "full", prefixes: ["SEC"], operator: "appsec" },
      },
    },
  });
  const s = reg.resolveTrack("SEC-1");
  assert.strictEqual(s.name, "security");
  assert.strictEqual(s.operator, "appsec");
});

test("--track override wins and rejects unknown tracks", () => {
  const reg = createTrackRegistry({ projectConfig: {} });
  // override a development ticket onto the devops track
  const t = reg.resolveTrack("BE-1", { override: "devops" });
  assert.strictEqual(t.name, "devops");
  assert.strictEqual(t.gateProc, "infra");
  assert.throws(() => reg.resolveTrack("BE-1", { override: "nope" }), /Unknown track/);
});

test("listTracks returns all merged tracks sorted", () => {
  const reg = createTrackRegistry({ projectConfig: {} });
  const names = reg.listTracks().map((t) => t.name);
  assert.deepStrictEqual(
    names,
    ["data-analytics", "development", "devops", "marketing", "product-engineering"]
  );
});

test("mergeTrack defaults gateProc to test and lane to default", () => {
  const merged = mergeTrack(undefined, { prefixes: ["Z"] });
  assert.strictEqual(merged.gateProc, "test");
  assert.strictEqual(merged.defaultLane, "default");
  assert.deepStrictEqual(merged.prefixes, ["Z"]);
});

test("BUILTIN_TRACKS is frozen and exposes the five tracks", () => {
  assert.ok(Object.isFrozen(BUILTIN_TRACKS));
  assert.deepStrictEqual(
    Object.keys(BUILTIN_TRACKS).sort(),
    ["data-analytics", "development", "devops", "marketing", "product-engineering"]
  );
});
