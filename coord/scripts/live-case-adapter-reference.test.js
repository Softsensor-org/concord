"use strict";

// COORD-154: tests for the read-only live-case adapter reference + the
// live->fixture promotion helper. SYNTHETIC INPUTS ONLY — no committed customer
// data, no real credentials, no network. Tests prove the four guarantees:
//   1. a properly-narrowed read produces redacted compact evidence + a valid
//      COORD-152 receipt (validates via validateLiveMcpReceipt);
//   2. a broad/unfiltered request is REFUSED (no dump);
//   3. sensitive fields are redacted out of the evidence;
//   4. the live->fixture promotion yields a synthetic fixture with NO sensitive
//      data; plus an assertion that committed source carries no real-credential
//      / customer-data patterns.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const adapter = require("./adapters/live-case-adapter-reference.js");
const promotion = require("./adapters/live-case-fixture-promotion.js");
const { validateLiveMcpReceipt } = require("./runtime-evidence.js");

// A synthetic raw case record as a real adopter reader MIGHT return it. The
// sensitive fields below are FAKE and exist only to prove redaction works.
function syntheticRawCase() {
  return {
    case_id: "case-7",
    status: "open",
    shape: "escalation",
    priority: 2,
    name: "Jane Synthetic",
    email: "jane@example.test",
    phone: "555-0100",
    raw_payload: { secret: "should-never-leak" },
    history: ["a", "b", "c"],
  };
}

const NARROW_FILTERS = { client: "acme", date: "2026-06-24", entity: "case-7" };

function fakeReader() {
  return [syntheticRawCase()];
}

test("narrowed read produces redacted compact evidence + a valid COORD-152 receipt", () => {
  const { scope, evidence, receipt } = adapter.readLiveCase({
    ticket: "COORD-154",
    adapter: "live-case-readonly",
    filters: NARROW_FILTERS,
    fetchCase: fakeReader,
    approval: "human:alice approved bounded read",
  });

  assert.deepEqual(scope, NARROW_FILTERS);
  assert.equal(evidence.record_count, 1);
  assert.equal(evidence.redacted, true);

  // Receipt validates against the COORD-152 substrate => satisfies COORD-153.
  assert.doesNotThrow(() => validateLiveMcpReceipt(receipt));
  assert.equal(receipt.operation_class, "read_sensitive");
  assert.equal(receipt.ticket, "COORD-154");
  assert.ok(receipt.redaction && receipt.redaction.length > 0, "redaction evidence present");
  assert.ok(receipt.approval && receipt.approval.length > 0, "approval evidence present");
  assert.ok(Array.isArray(receipt.evidence) && receipt.evidence.length > 0);
});

test("broad / unfiltered request is REFUSED (no dump)", () => {
  // Missing all filters.
  assert.throws(
    () => adapter.readLiveCase({ ticket: "COORD-154", filters: {}, fetchCase: fakeReader }),
    adapter.BroadReadRefusedError
  );
  // Wildcard client.
  assert.throws(
    () =>
      adapter.readLiveCase({
        ticket: "COORD-154",
        filters: { client: "*", date: "2026-06-24", entity: "case-7" },
        fetchCase: fakeReader,
      }),
    /broad\/wildcard/
  );
  // "all" sentinel entity.
  assert.throws(
    () =>
      adapter.readLiveCase({
        ticket: "COORD-154",
        filters: { client: "acme", date: "2026-06-24", entity: "all" },
        fetchCase: fakeReader,
      }),
    adapter.BroadReadRefusedError
  );
  // Missing entity only.
  assert.throws(
    () =>
      adapter.readLiveCase({
        ticket: "COORD-154",
        filters: { client: "acme", date: "2026-06-24" },
        fetchCase: fakeReader,
      }),
    /missing required filter/
  );
});

test("a refused read NEVER invokes the reader (no broad dump executed)", () => {
  let called = false;
  const spyReader = () => {
    called = true;
    return [syntheticRawCase()];
  };
  assert.throws(() =>
    adapter.readLiveCase({ ticket: "COORD-154", filters: { client: "*" }, fetchCase: spyReader })
  );
  assert.equal(called, false, "reader must not run when scope is refused");
});

test("sensitive fields are redacted out of the emitted evidence", () => {
  const { evidence } = adapter.readLiveCase({
    ticket: "COORD-154",
    filters: NARROW_FILTERS,
    fetchCase: fakeReader,
    approval: "human:alice",
  });
  const record = evidence.records[0];
  // Sensitive scalars masked.
  assert.equal(record.name, "[redacted]");
  assert.equal(record.email, "[redacted]");
  assert.equal(record.phone, "[redacted]");
  // Nested sensitive payload never leaks its raw contents.
  assert.equal(record.raw_payload, "[redacted]");
  // Non-sensitive nested structure summarized, not emitted raw.
  assert.equal(record.history, "[redacted:array(3)]");
  // Structural / non-sensitive scalar fields pass through.
  assert.equal(record.case_id, "case-7");
  assert.equal(record.status, "open");
  assert.equal(record.priority, 2);
  // The raw secret string appears nowhere in the evidence JSON.
  assert.ok(!JSON.stringify(evidence).includes("should-never-leak"));
});

test("live->fixture promotion yields a synthetic fixture with no sensitive data", () => {
  const { evidence } = adapter.readLiveCase({
    ticket: "COORD-154",
    filters: NARROW_FILTERS,
    fetchCase: fakeReader,
    approval: "human:alice",
  });

  const fixture = promotion.promoteEvidenceToFixture(evidence, { ticket: "COORD-154", promotedAt: "2026-06-24T00:00:00.000Z" });

  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.fixture_kind, "synthetic-live-case");
  assert.equal(fixture.source_ticket, "COORD-154");
  assert.equal(fixture.record_count, 1);

  // Customer-safe: no redacted markers survive, no raw identity values.
  assert.doesNotThrow(() => promotion.assertFixtureCustomerSafe(fixture));

  const fixtureJson = JSON.stringify(fixture);
  assert.ok(!fixtureJson.includes("[redacted"), "no redacted markers in fixture");
  assert.ok(!fixtureJson.includes("Jane Synthetic"));
  assert.ok(!fixtureJson.includes("jane@example.test"));
  assert.ok(!fixtureJson.includes("should-never-leak"));

  // Structural shape preserved so a regression test exercises the same path.
  const fr = fixture.records[0];
  assert.equal(fr.status, "open");
  assert.equal(fr.priority, 2);
  // Identity fields neutralized to synthetic stand-ins.
  assert.match(fr.name, /^synthetic-/);
  assert.equal(fixture.scope_shape.client, "synthetic-client");
});

test("assertFixtureCustomerSafe catches a leaked redacted marker / raw identity", () => {
  assert.throws(
    () => promotion.assertFixtureCustomerSafe({ records: [{ name: "[redacted]" }] }),
    /redacted markers/
  );
  assert.throws(
    () => promotion.assertFixtureCustomerSafe({ records: [{ email: "real@person.test" }] }),
    /non-synthetic value/
  );
});

test("adapter requires a governing ticket and an injected reader (no built-in network)", () => {
  assert.throws(() => adapter.readLiveCase({ filters: NARROW_FILTERS, fetchCase: fakeReader }), /governing ticket/);
  assert.throws(() => adapter.readLiveCase({ ticket: "COORD-154", filters: NARROW_FILTERS }), /fetchCase/);
});

test("committed reference source contains no real-credential / customer-data patterns", () => {
  const files = [
    path.join(__dirname, "adapters", "live-case-adapter-reference.js"),
    path.join(__dirname, "adapters", "live-case-fixture-promotion.js"),
    __filename,
  ];
  // Patterns that would indicate a real secret/credential or a real endpoint
  // leaked into committed source. Synthetic ".test"/"example" hosts are allowed.
  const forbidden = [
    /AKIA[0-9A-Z]{16}/, // AWS access key id
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private key block
    /\bpassword\s*[:=]\s*["'][^"']+["']/i, // hard-coded password literal
    /\bBearer\s+[A-Za-z0-9._-]{20,}/, // bearer token
    /https?:\/\/(?!.*(example|localhost|test))[a-z0-9.-]+\.(com|net|io|aws)\b/i, // real endpoint
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${path.basename(file)} matched forbidden pattern ${pattern}`);
    }
  }
});
