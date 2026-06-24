"use strict";

// COORD-154: live -> fixture/regression/synthetic promotion helper (Production
// MCP P3). This is the reusable bridge that turns a (redacted) live observation
// into a REPRODUCIBLE, CUSTOMER-SAFE synthetic fixture so it can become a
// regression test or synthetic case. It is the executable counterpart to the
// promotion doc (coord/docs/LIVE_CASE_ADAPTER_REFERENCE.md).
//
// Why this exists: COORD-153 requires fixture/test/spec promotion when a live
// observation influences product behavior. A live read produces compact REDACTED
// evidence (via live-case-adapter-reference.js); this helper converts that
// evidence into a synthetic fixture with:
//   - synthetic, non-identifying ids (no live client/entity ids carried over);
//   - sensitive fields removed/neutralized (never copied raw);
//   - the structural SHAPE preserved (so the regression test exercises the same
//     code path the live read exposed).
//
// Non-goal: this never reads the network and never persists customer data. It
// operates purely on the already-redacted evidence object.

// Field names whose VALUES must never survive into a committed fixture even if
// they slipped through redaction. Kept in sync with the adapter's default set.
const NEVER_PERSIST_FIELDS = Object.freeze([
  "name",
  "full_name",
  "email",
  "phone",
  "address",
  "ssn",
  "dob",
  "raw_payload",
  "notes",
  "contact",
  "client",
]);

function isRedactedMarker(value) {
  return typeof value === "string" && /^\[redacted/.test(value);
}

// neutralizeValue — replace any value that could carry identity with a synthetic
// stand-in while preserving its TYPE so the fixture is structurally faithful.
function neutralizeValue(key, value, index) {
  const lowerKey = String(key).toLowerCase();
  if (NEVER_PERSIST_FIELDS.includes(lowerKey) || isRedactedMarker(value)) {
    return `synthetic-${lowerKey}-${index}`;
  }
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (typeof value === "object") {
    // The adapter already summarized nested objects; keep a synthetic marker.
    return Array.isArray(value) ? [] : {};
  }
  // Non-sensitive scalar structural fields (status, shape, type, ...) are safe
  // to keep — they describe the SHAPE, not the customer.
  return value;
}

function neutralizeRecord(record, index) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    out[key] = neutralizeValue(key, value, index);
  }
  return out;
}

// promoteEvidenceToFixture — pure. Given a compact redacted evidence object (the
// shape returned by buildCompactEvidence), return a synthetic fixture object.
//
// Output shape:
//   {
//     fixture_kind: "synthetic-live-case",
//     source_ticket, promoted_at,
//     scope_shape: { client: "synthetic-client", date: "<preserved-or-synthetic>", entity: "synthetic-entity" },
//     record_count, records: [<neutralized synthetic records>],
//     synthetic: true
//   }
function promoteEvidenceToFixture(evidence, options = {}) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("promoteEvidenceToFixture requires a compact evidence object.");
  }
  const records = Array.isArray(evidence.records) ? evidence.records : [];
  // The scope itself names a live client/entity — synthesize it. Keep the DATE
  // structure only as a generic placeholder so the fixture is reproducible.
  const scopeShape = {
    client: "synthetic-client",
    date: "synthetic-date",
    entity: "synthetic-entity",
  };
  return {
    fixture_kind: "synthetic-live-case",
    source_ticket: options.ticket || evidence.ticket || "unknown",
    promoted_at: options.promotedAt || new Date().toISOString(),
    note:
      "Synthetic fixture promoted from a redacted live-case observation. " +
      "Structure preserved; all identifying values neutralized. Safe to commit.",
    scope_shape: scopeShape,
    record_count: records.length,
    records: records.map((r, i) => neutralizeRecord(r, i)),
    synthetic: true,
  };
}

// assertFixtureCustomerSafe — defensive check used by tests and adopters: throws
// if a fixture still contains anything that looks like a redacted marker or a
// raw value under a never-persist key. A clean fixture passes silently.
function assertFixtureCustomerSafe(fixture) {
  const json = JSON.stringify(fixture || {});
  if (/\[redacted/i.test(json)) {
    throw new Error("Fixture still contains redacted markers — neutralization incomplete.");
  }
  for (const record of fixture && Array.isArray(fixture.records) ? fixture.records : []) {
    for (const [key, value] of Object.entries(record)) {
      const lowerKey = String(key).toLowerCase();
      if (NEVER_PERSIST_FIELDS.includes(lowerKey) && typeof value === "string" && !/^synthetic-/.test(value)) {
        throw new Error(`Fixture field "${key}" carries a non-synthetic value.`);
      }
    }
  }
  return true;
}

module.exports = {
  NEVER_PERSIST_FIELDS,
  neutralizeRecord,
  promoteEvidenceToFixture,
  assertFixtureCustomerSafe,
};
