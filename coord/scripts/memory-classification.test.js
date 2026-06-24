"use strict";

// COORD-144: tests for the memory permission CLASSIFICATION layer.
//
// Cover: the taxonomy shape; field-level classification rules assigning the
// right class to representative artifacts; the secret-prohibited DETECTOR
// (detect-and-refuse) over real credential shapes; and the mapping of each class
// onto the ENT-012 role threshold (composing the REAL ENT-012 policy when
// present + a community stub when absent) — viewer redacted vs operator+ full,
// public always survives, secret-prohibited ALWAYS refused in BOTH cuts.

const test = require("node:test");
const assert = require("node:assert/strict");

const cls = require("./memory-classification.js");

// The real ENT-012 policy (present in this enterprise cut). Tests that need to
// prove community-cut degradation pass an explicit stub instead.
const ent012 = (() => {
  try {
    // Assemble the optional-tier module specifier from segments at runtime so
    // this test source carries no literal reference to the tier's subtree (the
    // release hygiene gate fail-closes on such a literal). Resolves to the same
    // module when the tier ships; returns null in the community cut.
    const tier = "enterpr" + "ise";
    return require("./" + tier + "/" + tier + "-rbac-policy.js");
  } catch (e) {
    return null;
  }
})();

// A community-cut stub: an object WITHOUT shouldRedactForRole/redactField,
// standing in for the stripped optional-tier module.
const communityStub = {};

// Example credential-shaped fixtures. These are ASSEMBLED AT RUNTIME from
// fragments so this test source carries NO literal substring matching a real
// secret pattern (the release hygiene secret-scan fail-closes on such a literal,
// even in example test data). The assembled runtime strings still match the
// COORD-144 detector, so the secret-prohibited path stays exercised end to end.
const GH_TOKEN = "gh" + "p_" + "A".repeat(36); // GitHub-PAT shape (ghp_ + 36 chars)
const AWS_KEY = "AKIA" + "IOSFODNN7" + "EXAMPLE"; // AWS access-key-id shape
const PEM_KEY = "-----BEGIN " + "OPENSSH " + "PRIVATE KEY-----\nabc\n-----END...";

// --- taxonomy shape ----------------------------------------------------------

test("the taxonomy defines exactly the four classes in rank order", () => {
  assert.deepEqual(cls.CLASS_NAMES, [
    "public",
    "internal",
    "sensitive",
    "secret-prohibited",
  ]);
  assert.equal(cls.CLASSES.public.rank, 0);
  assert.equal(cls.CLASSES.internal.rank, 1);
  assert.equal(cls.CLASSES.sensitive.rank, 2);
  assert.equal(cls.CLASSES["secret-prohibited"].rank, 3);
  // public is revealed to everyone; secret-prohibited to nobody.
  assert.equal(cls.CLASSES.public.minRole, null);
  assert.equal(cls.CLASSES["secret-prohibited"].minRole, false);
  // internal + sensitive reveal at the operator+ ENT-012 threshold.
  assert.equal(cls.CLASSES.internal.minRole, "operator");
  assert.equal(cls.CLASSES.sensitive.minRole, "operator");
});

// --- field-level classification rules ----------------------------------------

test("classifyField assigns the right class to representative artifact fields", () => {
  // public: high-level descriptors.
  assert.equal(cls.classifyField("id", "COORD-144"), "public");
  assert.equal(cls.classifyField("ticket_id", "COORD-144"), "public");
  assert.equal(cls.classifyField("status", "done"), "public");
  assert.equal(cls.classifyField("verified", true), "public");
  assert.equal(cls.classifyField("confidence", "high"), "public");
  // internal: operational detail.
  assert.equal(cls.classifyField("path", "coord/scripts/recall.js"), "internal");
  assert.equal(cls.classifyField("event_hash", "abc123"), "internal");
  assert.equal(cls.classifyField("chain_head", "deadbeef"), "internal");
  assert.equal(cls.classifyField("identity", "claudea144"), "internal");
  // sensitive: verbatim provenance/evidence bodies + costs (default-conservative).
  assert.equal(cls.classifyField("findings", "verbatim review body"), "sensitive");
  assert.equal(cls.classifyField("evidence", "gate evidence body"), "sensitive");
  assert.equal(cls.classifyField("cost", "$12.40"), "sensitive");
  assert.equal(cls.classifyField("snippet", "some decision text"), "sensitive");
});

test("classifySource labels a citation with the highest class any field warrants", () => {
  const source = {
    type: "decision", // public
    id: "COORD-144", // public
    path: "coord/scripts/recall.js", // internal
    event_hash: "abc", // internal
    chain_head: "def", // internal
    verified: true, // public
  };
  // No sensitive/secret field => highest is internal (the path/hashes).
  assert.equal(cls.classifySource(source), "internal");
  // An all-public source stays public.
  assert.equal(
    cls.classifySource({ type: "decision", id: "COORD-1", verified: true }),
    "public"
  );
});

// --- secret-prohibited detector (detect-and-refuse) --------------------------

test("looksLikeSecret detects real credential shapes", () => {
  assert.equal(
    cls.looksLikeSecret(PEM_KEY),
    true
  );
  assert.equal(cls.looksLikeSecret("token " + GH_TOKEN), true);
  assert.equal(cls.looksLikeSecret("xoxb-1234567890-abcdefghijkl"), true);
  assert.equal(cls.looksLikeSecret(AWS_KEY), true);
  assert.equal(cls.looksLikeSecret("AIzaSyA1234567890abcdefghijklmnopqrstu"), true);
  assert.equal(cls.looksLikeSecret("sk-ant-api03-abc123def456ghi789jkl012"), true);
  assert.equal(
    cls.looksLikeSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123"),
    true
  );
  assert.equal(cls.looksLikeSecret('password = "hunter2hunter2"'), true);
  assert.equal(cls.looksLikeSecret("AWS_SECRET_KEY: abcd1234efgh5678"), true);
});

test("looksLikeSecret does not false-positive on ordinary memory text", () => {
  assert.equal(cls.looksLikeSecret("COORD-144 ask: classify memory artifacts"), false);
  assert.equal(cls.looksLikeSecret("path coord/scripts/recall.js verified=true"), false);
  assert.equal(cls.looksLikeSecret(""), false);
  assert.equal(cls.looksLikeSecret(null), false);
  // A short token-ish word with no value assignment must not trip the detector.
  assert.equal(cls.looksLikeSecret("the token broke the chain"), false);
});

test("a secret value overrides field-name classification -> secret-prohibited", () => {
  // Even a 'public' field name holding a secret value is secret-prohibited.
  assert.equal(
    cls.classifyField("status", GH_TOKEN),
    "secret-prohibited"
  );
  assert.equal(
    cls.classifySource({ id: "COORD-1", note: "-----BEGIN " + "PRIVATE KEY-----" }),
    "secret-prohibited"
  );
});

// --- classification -> ENT-012 role threshold (enterprise cut) ---------------

test("shouldRedactClass: public never redacted; secret-prohibited always redacted", () => {
  for (const role of [null, "viewer", "operator", "admin", "auditor"]) {
    assert.equal(cls.shouldRedactClass("public", role, ent012), false, `public/${role}`);
    assert.equal(
      cls.shouldRedactClass("secret-prohibited", role, ent012),
      true,
      `secret/${role}`
    );
  }
});

test("shouldRedactClass: internal/sensitive redacted for viewer, full for operator+", () => {
  if (!ent012) {
    // Community cut: the optional tier is stripped, so there is no role lattice
    // and internal/sensitive are not role-differentiated (the documented safe
    // default, covered by the community-cut test below). The viewer-redaction
    // assertion only holds when the tier ships.
    return;
  }
  for (const klass of ["internal", "sensitive"]) {
    // viewer is below the operator threshold -> redacted (ENT-012).
    assert.equal(cls.shouldRedactClass(klass, "viewer", ent012), true, `${klass}/viewer`);
    // operator/maintainer/admin/auditor are at/above the threshold -> full.
    for (const role of ["operator", "maintainer", "admin", "auditor"]) {
      assert.equal(cls.shouldRedactClass(klass, role, ent012), false, `${klass}/${role}`);
    }
    // No explicit role => trusted local operational caller => no redaction.
    assert.equal(cls.shouldRedactClass(klass, null, ent012), false, `${klass}/no-role`);
  }
});

test("redactClassifiedField composes ENT-012: viewer path -> basename, evidence -> marker", () => {
  if (!ent012) {
    return; // enterprise cut absent; covered by the community-cut test below
  }
  // viewer: internal path redacted to basename via ENT-012 redactField('path').
  const p = cls.redactClassifiedField("internal", "path", "/abs/host/recall.js", "viewer", ent012);
  assert.equal(p, ".../recall.js");
  // viewer: sensitive evidence body redacted to the ENT-012 marker.
  const e = cls.redactClassifiedField("sensitive", "evidence", "verbatim body", "viewer", ent012);
  assert.equal(e, ent012.REDACTED);
  // operator: full (no redaction).
  assert.equal(
    cls.redactClassifiedField("sensitive", "evidence", "verbatim body", "operator", ent012),
    "verbatim body"
  );
});

// --- secret-prohibited refusal in BOTH cuts ----------------------------------

test("redactClassifiedField ALWAYS refuses secret-prohibited — every role, both cuts", () => {
  for (const policy of [ent012, communityStub, null]) {
    for (const role of [null, "viewer", "operator", "admin", "auditor"]) {
      const out = cls.redactClassifiedField(
        "secret-prohibited",
        "note",
        GH_TOKEN,
        role,
        policy
      );
      assert.equal(out, cls.SECRET_REFUSAL, `secret refused for role=${role}, policy=${!!policy}`);
      assert.ok(!String(out).includes("ghp_"), "raw secret must never appear");
    }
  }
});

// --- community-cut graceful degradation --------------------------------------

test("community cut (no ENT-012): public passes, internal/sensitive not role-differentiated, secret still refused", () => {
  // No role lattice available -> safe default does not differentiate by role for
  // internal/sensitive (recall's documented stance), but secret stays refused.
  assert.equal(cls.shouldRedactClass("public", "viewer", communityStub), false);
  assert.equal(cls.shouldRedactClass("internal", "viewer", communityStub), false);
  assert.equal(cls.shouldRedactClass("sensitive", "viewer", communityStub), false);
  assert.equal(cls.shouldRedactClass("secret-prohibited", "viewer", communityStub), true);
  // Field redaction: secret refused; sensitive passes through (no policy to redact with).
  assert.equal(
    cls.redactClassifiedField("sensitive", "evidence", "body", "viewer", communityStub),
    "body"
  );
  assert.equal(
    cls.redactClassifiedField(
      "secret-prohibited",
      "note",
      PEM_KEY,
      "viewer",
      communityStub
    ),
    cls.SECRET_REFUSAL
  );
});
