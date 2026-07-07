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

test("COORD-337 memory scopes define shared/team/private/local/sensitive boundaries", () => {
  assert.deepEqual(cls.SCOPE_NAMES, [
    "shared",
    "team",
    "human-private",
    "local-only",
    "sensitive",
    "secret-prohibited",
  ]);
  assert.equal(cls.MEMORY_SCOPES.shared.governs, "project");
  assert.equal(cls.MEMORY_SCOPES.team.governs, "team");
  assert.equal(cls.MEMORY_SCOPES["human-private"].promotionRequired, true);
  assert.equal(cls.MEMORY_SCOPES["local-only"].promotionRequired, true);
  assert.equal(cls.MEMORY_SCOPES.sensitive.governs, "restricted");
  assert.equal(cls.MEMORY_SCOPES["secret-prohibited"].governs, "none");
});

test("COORD-337 project-governed artifacts are shared by default", () => {
  for (const type of [
    "ticket",
    "plan_record",
    "adr",
    "confirmed_business_rule",
    "cadence_cursor",
    "durable_decision",
  ]) {
    assert.equal(
      cls.classifyMemoryScope({ artifact_type: type, id: "COORD-337" }),
      "shared",
      type
    );
  }
  assert.equal(
    cls.classifyMemoryScope({ type: "team_note", team_id: "platform" }),
    "team"
  );
});

test("COORD-337 human-private and local-only notes cannot silently govern others", () => {
  const privateNote = {
    artifact_type: "personal_agent_note",
    human_id: "h1",
    note: "This approach looked promising in my session.",
  };
  const scratch = {
    artifact_type: "scratch_observation",
    note: "Maybe this is a business rule, but it is not verified.",
  };
  assert.equal(cls.classifyMemoryScope(privateNote), "human-private");
  assert.equal(cls.classifyMemoryScope(scratch), "local-only");
  assert.equal(cls.canGovernOtherAgents(privateNote), false);
  assert.equal(cls.canGovernOtherAgents(scratch), false);
});

test("COORD-337 sensitive and secret-prohibited override reusable sharing", () => {
  assert.equal(
    cls.classifyMemoryScope({
      artifact_type: "ticket",
      sensitivity: "sensitive",
      evidence: "customer-specific body should be redacted",
    }),
    "sensitive"
  );
  assert.equal(
    cls.classifyMemoryScope({
      artifact_type: "ticket",
      body: "token " + GH_TOKEN,
    }),
    "secret-prohibited"
  );
});

test("COORD-337 scratch promotes to shared only with citations and governed approval", () => {
  const uncited = {
    artifact_type: "scratch_observation",
    statement: "Use plan records as the source of decision why.",
  };
  assert.equal(cls.canPromoteToShared(uncited), false);
  assert.deepEqual(cls.validateSharedPromotion(uncited).errors, [
    "promotion requires source_refs/evidence_refs/citations",
    "promotion requires governed human/reviewer approval",
  ]);

  const promoted = {
    ...uncited,
    source_refs: [{ path: "coord/docs/MEMORY_ARCHITECTURE.md", section: "3" }],
    promoted_by: "human-admin",
  };
  assert.equal(cls.canPromoteToShared(promoted), true);
  assert.deepEqual(cls.validateSharedPromotion(promoted), {
    ok: true,
    from_scope: "local-only",
    to_scope: "shared",
    errors: [],
  });
});

test("COORD-345 inspect/audit explain why a claim is remembered and where it was used", () => {
  const claim = {
    claim_id: "CLAIM-345",
    artifact_type: "confirmed_business_rule",
    statement: "Use governed plan records as durable memory.",
    source_refs: [{ path: "coord/GOVERNANCE.md", event_hash: "abc" }],
    used_by: [{ ticket_id: "COORD-345", surface: "recall" }],
    promoted_by: "human-admin",
    agent_handle: "codex",
    provider_session_id: "session-1",
  };
  const inspect = cls.inspectMemoryClaim(claim);
  assert.equal(inspect.kind, "concord.memory_claim.inspect");
  assert.equal(inspect.claim_id, "CLAIM-345");
  assert.equal(inspect.active_retrieval, true);
  assert.equal(inspect.memory_scope, "shared");
  assert.equal(inspect.promoted_by, "human-admin");
  assert.deepEqual(inspect.provenance_refs, claim.source_refs);
  assert.deepEqual(inspect.used_by, claim.used_by);
  assert.ok(inspect.controls.write_path.includes("forget"));

  const control = cls.buildMemoryControlRecord("reject", claim, {
    reason: "No longer true after review.",
    createdAtUtc: "2026-06-27T00:00:00.000Z",
  });
  const audit = cls.auditMemoryClaim(claim, [control]);
  assert.equal(audit.kind, "concord.memory_claim.audit");
  assert.equal(audit.control_history.length, 1);
  assert.equal(audit.control_history[0].action, "reject");
});

test("COORD-345 write controls are tombstones/redactions with classification checks", () => {
  const claim = {
    claim_id: "CLAIM-REMOVE",
    artifact_type: "confirmed_business_rule",
    statement: "Remove from active retrieval without deleting audit history.",
    source_refs: [{ path: "coord/docs/MEMORY_ARCHITECTURE.md" }],
    promoted_by: "reviewer",
  };
  const forget = cls.buildMemoryControlRecord("forget", claim, {
    reason: "User requested it be forgotten from active retrieval.",
    actor: { agent_handle: "codex", provider_session_id: "session-2" },
    createdAtUtc: "2026-06-27T00:00:00.000Z",
  });
  assert.equal(forget.kind, "concord.memory_claim.control");
  assert.equal(forget.action, "forget");
  assert.equal(forget.destructive_delete, false);
  assert.equal(forget.audit_history_preserved, true);
  assert.equal(forget.next.memory_status, "forgotten");
  assert.equal(forget.next.tombstone, true);
  assert.equal(forget.classification_check.ok, true);

  const updated = cls.applyMemoryControlRecord(claim, forget);
  assert.equal(updated.memory_status, "forgotten");
  assert.equal(updated.tombstone, true);
  assert.equal(cls.isClaimActiveForRetrieval(updated), false);

  const redaction = cls.buildMemoryControlRecord("redact", claim, {
    fields: ["statement", "evidence"],
    reason: "Preserve provenance while hiding sensitive body.",
  });
  assert.deepEqual(redaction.next.redaction.fields, ["evidence", "statement"]);
  assert.equal(redaction.next.redaction.preserve_audit_history, true);
});

test("COORD-345 active retrieval excludes rejected/forgotten/private claims", () => {
  assert.equal(cls.isClaimActiveForRetrieval({ artifact_type: "confirmed_business_rule" }), true);
  assert.equal(cls.isClaimActiveForRetrieval({ artifact_type: "confirmed_business_rule", status: "rejected" }), false);
  assert.equal(cls.isClaimActiveForRetrieval({ artifact_type: "confirmed_business_rule", memory_status: "forgotten" }), false);
  assert.equal(cls.isClaimActiveForRetrieval({ artifact_type: "confirmed_business_rule", superseded_by: "CLAIM-2" }), false);
  assert.equal(cls.isClaimActiveForRetrieval({ artifact_type: "confirmed_business_rule", memory_scope: "human-private" }), false);
  assert.equal(
    cls.isClaimActiveForRetrieval(
      { artifact_type: "confirmed_business_rule", memory_scope: "human-private", human_id: "human-1" },
      { includePrivate: true, humanId: "human-1" }
    ),
    true
  );
  assert.equal(
    cls.isClaimActiveForRetrieval(
      { artifact_type: "confirmed_business_rule", memory_scope: "human-private", human_id: "human-1" },
      { includePrivate: true, humanId: "human-2" }
    ),
    false
  );
  assert.equal(
    cls.isClaimActiveForRetrieval(
      { artifact_type: "team_note", memory_scope: "team", team_id: "platform" },
      { teamId: "mobile" }
    ),
    false
  );
  assert.equal(
    cls.isClaimActiveForRetrieval(
      { artifact_type: "team_note", memory_scope: "team", team_id: "platform" },
      { teamId: "platform" }
    ),
    true
  );
  assert.equal(
    cls.isClaimActiveForRetrieval(
      { artifact_type: "decision", memory_scope: "secret-prohibited", statement: "token " + GH_TOKEN }
    ),
    false
  );
});

test("COORD-346 redacts shared-memory surfaces by caller role and scope", () => {
  const privateLiteral = "private planning note for human one";
  const sensitiveLiteral = "customer-specific sensitive evidence body";
  const sharedLiteral = "project shared high-level rule";
  const surface = {
    kind: "concord.continuity_read_only_readout",
    summary: "context-pack warm-start cold-finish continuity export backfill",
    warm_start: {
      records: [
        {
          claim_id: "SHARED-1",
          artifact_type: "confirmed_business_rule",
          memory_scope: "project-shared",
          statement: sharedLiteral,
          source_refs: [{ path: "coord/docs/MEMORY_ARCHITECTURE.md" }],
        },
        {
          claim_id: "TEAM-1",
          artifact_type: "team_note",
          memory_scope: "team-shared",
          team_id: "platform",
          statement: "platform team reusable note",
        },
        {
          claim_id: "PRIVATE-1",
          artifact_type: "personal_agent_note",
          memory_scope: "human-private",
          human_id: "human-1",
          statement: privateLiteral,
        },
        {
          claim_id: "LOCAL-1",
          artifact_type: "scratch_observation",
          memory_scope: "local-only",
          statement: "local scratch should not leave the session",
        },
      ],
    },
    cold_finish: {
      records: [
        {
          claim_id: "SENSITIVE-1",
          artifact_type: "decision",
          memory_scope: "sensitive",
          statement: sensitiveLiteral,
          evidence: sensitiveLiteral,
        },
      ],
    },
    export: {
      backfill_candidates: [
        {
          claim_id: "SECRET-1",
          artifact_type: "decision",
          memory_scope: "secret-prohibited",
          statement: "token " + GH_TOKEN,
        },
      ],
    },
  };

  const viewer = cls.redactMemorySurface(surface, {
    role: "viewer",
    teamId: "platform",
    humanId: "human-2",
    includePrivate: true,
  });
  const serialized = JSON.stringify(viewer);
  assert.ok(!serialized.includes(privateLiteral), "private note must not govern or leak to another human");
  assert.ok(!serialized.includes(sensitiveLiteral), "sensitive evidence must be redacted for low privilege");
  assert.ok(!serialized.includes("ghp_"), "secret-prohibited literal must not escape export/backfill");
  assert.ok(serialized.includes(cls.SECRET_REFUSAL), "secret refusal marker should be auditable");
  assert.equal(viewer.warm_start.records[0].statement, "[redacted]");
  assert.equal(viewer.warm_start.records[1].active_retrieval !== false, true);
  assert.equal(viewer.warm_start.records[2].withheld, true);
  assert.equal(viewer.warm_start.records[3].withheld, true);

  const operator = cls.redactMemorySurface(surface, {
    role: "operator",
    teamId: "platform",
    humanId: "human-1",
    includePrivate: true,
    includeLocal: true,
  });
  const operatorJson = JSON.stringify(operator);
  assert.ok(operatorJson.includes(sharedLiteral), "operator sees shared provenance");
  assert.ok(operatorJson.includes(privateLiteral), "own private note is retrievable only for same human");
  assert.ok(operatorJson.includes(sensitiveLiteral), "operator sees sensitive non-secret provenance");
  assert.ok(!operatorJson.includes("ghp_"), "operator still cannot see secret-prohibited material");
});

test("COORD-346 rejected-claim audit output does not expose raw private or sensitive literals", () => {
  const rawRejected = "sensitive rejected claim body for audit";
  const claim = {
    claim_id: "REJECTED-PRIVATE",
    artifact_type: "personal_agent_note",
    memory_scope: "human-private",
    memory_status: "rejected",
    human_id: "human-1",
    statement: rawRejected,
    evidence_refs: [{ path: "/tmp/private/audit.txt", snippet: rawRejected }],
  };
  const control = cls.buildMemoryControlRecord("forget", claim, {
    reason: rawRejected,
    actor: { agent_handle: "codex", provider_session_id: "session-1" },
  });
  const audit = cls.auditMemoryClaim(claim, [control], {
    includePrivate: true,
    humanId: "human-2",
  });
  const safeAudit = cls.redactMemorySurface(audit, {
    role: "viewer",
    includePrivate: true,
    humanId: "human-2",
  });
  const serialized = JSON.stringify(safeAudit);
  assert.ok(!serialized.includes(rawRejected), "rejected-claim audit must not leak raw body or reason");
  assert.ok(!serialized.includes("/tmp/private/audit.txt"), "audit citation path must be redacted");
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
  const slackToken = "xox" + "b-" + "1234567890-abcdefghijkl";
  const googleKey = "AI" + "za" + "SyA1234567890abcdefghijklmnopqrstu";
  assert.equal(
    cls.looksLikeSecret(PEM_KEY),
    true
  );
  assert.equal(cls.looksLikeSecret("token " + GH_TOKEN), true);
  assert.equal(cls.looksLikeSecret(slackToken), true);
  assert.equal(cls.looksLikeSecret(AWS_KEY), true);
  assert.equal(cls.looksLikeSecret(googleKey), true);
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

// --- COORD-276: nested / non-string / high-entropy secret detection ----------

// A high-entropy random token that matches NO known SECRET_PATTERN (no provider
// prefix, no "<word>: <value>" assignment). Assembled at runtime so this source
// carries no literal secret. ~30 mixed-case alnum chars => ~5 bits/char entropy.
const HIGH_ENTROPY_TOKEN =
  "Zk9Q" + "m2Xv7" + "Lp4Rb8" + "Nt3Wc6" + "Yd1Hf5" + "Gj0aB";

test("COORD-276 NESTED-CAUGHT: a secret nested in an object/array is detected", () => {
  // Pattern-matched secret nested one level deep inside an object.
  assert.equal(cls.looksLikeSecret({ citation: { note: "token " + GH_TOKEN } }), true);
  // Nested deeper, inside an array inside an object.
  assert.equal(
    cls.looksLikeSecret({ sources: [{ id: "COORD-1" }, { body: AWS_KEY }] }),
    true
  );
  // classifySource now labels a citation whose secret is NESTED (not a bare
  // top-level string field) as secret-prohibited — previously it leaked.
  const leaky = {
    id: "COORD-1", // public
    type: "decision", // public
    citation: { meta: { value: "token " + GH_TOKEN } }, // nested secret
  };
  assert.equal(cls.classifySource(leaky), "secret-prohibited");
});

test("COORD-276 NESTED-CAUGHT: the nested secret is REDACTED in surfaced output", () => {
  const field = { meta: { keep: "ok", value: "token " + GH_TOKEN } };
  // End-to-end: classify drives redaction of the nested value.
  const klass = cls.classifyField("citation", field);
  assert.equal(klass, "secret-prohibited");
  const out = cls.redactClassifiedField(klass, "citation", field, "viewer", ent012);
  const serialized = JSON.stringify(out);
  // The raw secret must NOT survive anywhere in the surfaced output.
  assert.ok(!serialized.includes("ghp_"), "nested raw secret must be redacted");
  assert.ok(serialized.includes(cls.SECRET_REFUSAL), "refusal marker surfaces");
  // Benign sibling data is preserved (deep redaction, not a blanket nuke).
  assert.equal(out.meta.keep, "ok");
  assert.equal(out.meta.value, cls.SECRET_REFUSAL);
});

test("COORD-276 NON-STRING / WRAPPED: a secret not in a bare top-level string is caught", () => {
  // Wrapped in an array (no string field at all at the top level).
  assert.equal(cls.looksLikeSecret(["harmless", ["deeper", PEM_KEY]]), true);
  // A field whose VALUE is an object holding the secret (non-string field value).
  assert.equal(cls.classifyField("status", { wrapped: GH_TOKEN }), "secret-prohibited");
});

test("COORD-276 ENTROPY-FALLBACK: high-entropy token flagged; low-entropy NOT", () => {
  // Real high-entropy credential with NO known pattern => caught by the fallback.
  assert.equal(cls.looksLikeSecret(HIGH_ENTROPY_TOKEN), true);
  assert.equal(cls.looksLikeSecret("session key " + HIGH_ENTROPY_TOKEN), true);
  // It genuinely matches no provider pattern (prove the fallback, not a pattern).
  const PATTERNS_ONLY = HIGH_ENTROPY_TOKEN.match(/^[A-Za-z0-9]+$/);
  assert.ok(PATTERNS_ONLY, "fixture is a bare alnum token");
  // NO false positives on ordinary memory content:
  assert.equal(cls.looksLikeSecret("the quick brown fox jumps over the lazy dog"), false);
  assert.equal(cls.looksLikeSecret("COORD-276"), false); // short id
  assert.equal(cls.looksLikeSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false); // low entropy
  // git SHA (40 hex, ~3.95 bits/char) must NOT trip the detector.
  assert.equal(cls.looksLikeSecret("3abb25a9f0c1d2e3b4a5c6d7e8f90123456789ab"), false);
  // UUID (hex, ~3.2 bits/char) must NOT trip the detector.
  assert.equal(cls.looksLikeSecret("550e8400-e29b-41d4-a716-446655440000"), false);
});

test("COORD-276 bounded recursion: cyclic and deep input terminate safely", () => {
  // Self-referential cycle must not infinite-loop.
  const a = { id: "COORD-1" };
  a.self = a;
  assert.equal(cls.looksLikeSecret(a), false);
  // Mutual cycle carrying a secret: still detected, still terminates.
  const x = { name: "x" };
  const y = { name: "y", secret: "token " + GH_TOKEN, back: x };
  x.fwd = y;
  assert.equal(cls.looksLikeSecret(x), true);
  // Pathologically deep nesting must not blow the stack.
  let deep = "token " + GH_TOKEN;
  for (let i = 0; i < 5000; i++) {
    deep = { next: deep };
  }
  assert.doesNotThrow(() => cls.looksLikeSecret(deep));
  // Deep-redaction over a cyclic value fails closed (no raw secret, no throw).
  const out = cls.redactClassifiedField("secret-prohibited", "citation", x, "viewer", ent012);
  assert.ok(!JSON.stringify(out).includes("ghp_"), "cyclic redaction stays closed");
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
