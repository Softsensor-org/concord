"use strict";

// ENT-010: conformance attestation emit + local self-verify unit tests.
//
// All fixtures are temp dirs — the live engine/journal/board are never touched.
// We instantiate the DI factory against a temp coordDir and an injected
// verifyGovernanceChain stub, so emit/verify run end-to-end with no network and
// no side effects on the real .runtime/. We prove:
//   - emit produces a well-formed signed attestation with the 5 inputs;
//   - self-verify PASSES on a clean attestation;
//   - a tampered SIGNED subject field is detected;
//   - a tampered signature is detected;
//   - a changed engine input (mutated manifest) is detected as drift;
//   - identical inputs -> identical deterministic subject digest;
//   - the private signing key is gitignored (live repo check).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const createConformanceAttestation = require("./conformance-attestation.js");

const SAMPLE_MANIFEST = JSON.stringify(
  { schema_version: 1, manifest_version: "test-engine-v1", items: [] },
  null,
  2
);

// Build a temp coordDir with a manifest + an injected chain stub, return the
// instantiated attestation module + the temp paths for cleanup/mutation.
function makeFixture(overrides = {}) {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "ent010-"));
  fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), SAMPLE_MANIFEST);
  const chain = overrides.chain || {
    ok: true,
    head: "abc123def456",
    total: 10,
    chainedCount: 5,
  };
  // Optional gate artifact fixture under artifacts/gates/<repo>/<lane>.latest.json
  if (overrides.gate) {
    const repoDir = path.join(coordDir, "artifacts", "gates", "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "full.latest.json"),
      JSON.stringify(overrides.gate, null, 2)
    );
  }
  // Optional RELEASE_PROVENANCE.json fixture
  if (overrides.provenance) {
    fs.writeFileSync(
      path.join(coordDir, "RELEASE_PROVENANCE.json"),
      JSON.stringify(overrides.provenance, null, 2)
    );
  }
  const mod = createConformanceAttestation({
    coordDir,
    verifyGovernanceChain: () => chain,
    fail: (m) => {
      throw new Error(m);
    },
    // COORD-272: optionally inject a pinned trust anchor (array of PEM /
    // fingerprint / file-path entries) so anchored-verify tests don't depend on
    // a project.config.js on disk.
    trustedAttestationKeys: overrides.trustedAttestationKeys,
  });
  return { mod, coordDir };
}

// COORD-272: forge an attestation — keep the (genuine, live-matching) subject
// and digest, but RE-SIGN with a freshly generated attacker key and embed THAT
// attacker public key. The embedded-key signature is internally valid and the
// digest matches the subject, so the ONLY thing distinguishing it from a genuine
// attestation is the signing key's identity (authenticity).
function forgeWithOwnKey(outPath) {
  const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const forgedSig = crypto
    .sign(null, Buffer.from(attestation.subject_digest, "hex"), privateKey)
    .toString("base64");
  attestation.signature.value = forgedSig;
  attestation.signature.public_key_pem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));
  return attestation;
}

function cleanup(coordDir) {
  fs.rmSync(coordDir, { recursive: true, force: true });
}

test("emit produces a well-formed signed attestation with the 5 inputs", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { attestation, path: outPath, subjectDigest } = mod.emit();
    assert.ok(fs.existsSync(outPath), "attestation file written");
    assert.equal(attestation.schema_version, 1);
    assert.ok(attestation.issued_at, "issued_at recorded (in envelope, not subject)");
    // The 5 engine-integrity inputs.
    const s = attestation.subject;
    assert.equal(s.engine_version, "test-engine-v1");
    assert.equal(s.template_sync_manifest.present, true);
    assert.match(s.template_sync_manifest.sha256, /^[0-9a-f]{64}$/);
    assert.ok("gate" in s, "gate input present");
    assert.ok("release_provenance" in s, "release_provenance input present");
    assert.equal(s.journal_chain_head.head, "abc123def456");
    // Signed digest + ed25519 signature + embedded public key.
    assert.equal(attestation.subject_digest, subjectDigest);
    assert.equal(attestation.signature.algorithm, "ed25519");
    assert.ok(attestation.signature.value, "signature value present");
    assert.match(attestation.signature.public_key_pem, /BEGIN PUBLIC KEY/);
    // issued_at must NOT be inside the signed subject (reproducibility).
    assert.ok(!("issued_at" in s), "issued_at is outside the signed subject");
  } finally {
    cleanup(coordDir);
  }
});

test("self-verify PASSES on a clean attestation", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const report = mod.verify(outPath);
    assert.equal(report.ok, true);
    assert.equal(report.signature_valid, true);
    assert.equal(report.digest_matches_subject, true);
    assert.equal(report.matches_live_inputs, true);
    assert.equal(report.problems.length, 0);
  } finally {
    cleanup(coordDir);
  }
});

test("a tampered SIGNED subject field is detected", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
    // Tamper a signed field WITHOUT updating the digest/signature.
    attestation.subject.engine_version = "evil-tampered-version";
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));
    const report = mod.verify(outPath);
    assert.equal(report.ok, false);
    const codes = report.problems.map((p) => p.code);
    // The recorded subject_digest + signature are unchanged, so the signature
    // still verifies over the (original) digest — but that digest no longer
    // matches the tampered subject. The internal-consistency check catches it.
    assert.ok(codes.includes("subject_digest_mismatch"), "digest mismatch flagged");
    assert.equal(report.digest_matches_subject, false);
  } finally {
    cleanup(coordDir);
  }
});

test("a tampered signature is detected", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
    // Flip the signature bytes; subject + digest left intact.
    const buf = Buffer.from(attestation.signature.value, "base64");
    buf[0] ^= 0xff;
    attestation.signature.value = buf.toString("base64");
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));
    const report = mod.verify(outPath);
    assert.equal(report.ok, false);
    assert.equal(report.signature_valid, false);
    assert.ok(report.problems.some((p) => p.code === "signature_invalid"));
  } finally {
    cleanup(coordDir);
  }
});

test("a changed engine input (mutated manifest) is detected as drift", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    // Mutate the live manifest AFTER issuing the attestation. The signature is
    // still valid (subject untouched) but the live inputs no longer match.
    fs.writeFileSync(
      path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"),
      JSON.stringify({ schema_version: 1, manifest_version: "drifted-v2", items: [] }, null, 2)
    );
    const report = mod.verify(outPath);
    assert.equal(report.ok, false);
    assert.equal(report.signature_valid, true, "signature still valid (subject untouched)");
    assert.equal(report.matches_live_inputs, false, "live inputs drifted");
    assert.ok(report.problems.some((p) => p.code === "engine_input_drift"));
  } finally {
    cleanup(coordDir);
  }
});

test("identical inputs produce an identical deterministic subject digest", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const d1 = mod.digestSubject(mod.deriveSubject());
    const d2 = mod.digestSubject(mod.deriveSubject());
    assert.equal(d1, d2, "digest is deterministic for identical inputs");
    // Canonical JSON is key-order independent.
    const a = mod.canonicalJson({ b: 1, a: 2 });
    const b = mod.canonicalJson({ a: 2, b: 1 });
    assert.equal(a, b, "canonical JSON is key-order independent");
  } finally {
    cleanup(coordDir);
  }
});

test("gate + provenance inputs are captured when present", () => {
  const { mod, coordDir } = makeFixture({
    gate: {
      result: "pass",
      commit: "deadbeef",
      coverage: "coverage: pass min=80",
      audit: "audit: pass threshold=high",
      complete: true,
      incomplete_fields: [],
    },
    provenance: { donor_sha: "feedface123" },
  });
  try {
    const subject = mod.deriveSubject();
    assert.ok(subject.gate, "gate summary captured");
    assert.equal(subject.gate.backend.full.result, "pass");
    assert.equal(subject.gate.backend.full.complete, true);
    assert.equal(subject.release_provenance.donor_sha, "feedface123");
  } finally {
    cleanup(coordDir);
  }
});

test("verify fails cleanly on a missing or malformed attestation file", () => {
  const { mod, coordDir } = makeFixture();
  try {
    assert.throws(() => mod.verify(), /requires a path/);
    assert.throws(() => mod.verify(path.join(coordDir, "nope.json")), /not found/);
    const bad = path.join(coordDir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    assert.throws(() => mod.verify(bad), /not valid JSON/);
  } finally {
    cleanup(coordDir);
  }
});

// ---------------------------------------------------------------------------
// COORD-272 — pinned trust anchor closes the forge-with-your-own-key bypass.
// ---------------------------------------------------------------------------

// Re-instantiate the module over the SAME coordDir with a pinned trust anchor.
function anchoredModFor(coordDir, chain, trustedAttestationKeys) {
  return createConformanceAttestation({
    coordDir,
    verifyGovernanceChain: () => chain,
    fail: (m) => {
      throw new Error(m);
    },
    trustedAttestationKeys,
  });
}

const CHAIN = { ok: true, head: "abc123def456", total: 10, chainedCount: 5 };

test("PROOF: a forged attestation (re-signed with a DIFFERENT key) is REJECTED when a trust anchor is configured", () => {
  const { mod, coordDir } = makeFixture();
  try {
    // Genuine emit, capture the genuine signing key as the pinned trust anchor.
    const { path: outPath } = mod.emit();
    const { publicKeyPem: genuinePem } = mod.ensureKeypair();

    // Forge: keep the live-matching subject/digest, re-sign with an attacker key.
    forgeWithOwnKey(outPath);

    // Anchored verify with the GENUINE key pinned.
    const anchored = anchoredModFor(coordDir, CHAIN, [genuinePem]);
    const report = anchored.verify(outPath);

    // The embedded-key signature is internally valid AND the digest matches the
    // subject — under the OLD model this returned signature_valid:true and passed.
    assert.equal(report.signature_valid, true, "forged sig is internally valid vs embedded attacker key");
    assert.equal(report.digest_matches_subject, true, "digest still matches the (untouched) subject");
    // ...but authenticity is REJECTED: the signing key is not the pinned root.
    assert.equal(report.trust_anchor_configured, true);
    assert.equal(report.authenticity, "untrusted-key");
    assert.equal(report.trusted, false);
    assert.equal(report.ok, false, "verify FAILS on the forged key — bypass closed");
    assert.ok(
      report.problems.some((p) => p.code === "untrusted_signing_key"),
      "untrusted_signing_key flagged"
    );
  } finally {
    cleanup(coordDir);
  }
});

test("a genuine attestation signed with the TRUSTED key passes authenticity when the anchor is configured", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const { publicKeyPem: genuinePem } = mod.ensureKeypair();

    const anchored = anchoredModFor(coordDir, CHAIN, [genuinePem]);
    const report = anchored.verify(outPath);

    assert.equal(report.ok, true);
    assert.equal(report.trust_anchor_configured, true);
    assert.equal(report.authenticity, "trusted");
    assert.equal(report.trusted, true);
    assert.equal(report.signature_valid, true);
    assert.equal(report.problems.length, 0);
  } finally {
    cleanup(coordDir);
  }
});

test("a trust anchor pinned as a bare FINGERPRINT hex also authenticates the genuine key", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const { publicKeyPem: genuinePem } = mod.ensureKeypair();
    const fingerprint = mod.publicKeyFingerprint(genuinePem);

    const anchored = anchoredModFor(coordDir, CHAIN, [fingerprint]);
    const report = anchored.verify(outPath);
    assert.equal(report.authenticity, "trusted");
    assert.equal(report.trusted, true);
    assert.equal(report.signing_key_fingerprint, fingerprint);

    // And the SAME fingerprint anchor rejects a forged key (bypass closed).
    forgeWithOwnKey(outPath);
    const forgedReport = anchored.verify(outPath);
    assert.equal(forgedReport.authenticity, "untrusted-key");
    assert.equal(forgedReport.ok, false);
  } finally {
    cleanup(coordDir);
  }
});

test("a per-call --trust-anchor option pins the root for a single verify", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const { publicKeyPem: genuinePem } = mod.ensureKeypair();

    // No factory anchor; supply it per-call (the CLI --trust-anchor path).
    const trusted = mod.verify(outPath, { trustAnchor: genuinePem });
    assert.equal(trusted.authenticity, "trusted");
    assert.equal(trusted.trusted, true);

    // A wrong per-call anchor → untrusted-key (genuine key not in allowlist).
    const otherPem = crypto
      .generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" });
    const rejected = mod.verify(outPath, { trustAnchor: otherPem });
    assert.equal(rejected.authenticity, "untrusted-key");
    assert.equal(rejected.ok, false);
  } finally {
    cleanup(coordDir);
  }
});

test("UNANCHORED verify is HONEST: self-signed (not trusted), and a forged key still passes (integrity-only) — authenticity is the org's job", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();

    // Genuine, no anchor: honest self-signed label, NOT trusted, but ok (back-compat).
    const clean = mod.verify(outPath);
    assert.equal(clean.ok, true);
    assert.equal(clean.trust_anchor_configured, false);
    assert.equal(clean.authenticity, "self-signed");
    assert.equal(clean.trusted, false, "self-signed is NEVER reported as trusted");
    assert.match(clean.signing_key_fingerprint, /^[0-9a-f]{64}$/);

    // Forged-with-own-key, STILL no anchor: signature is internally valid, so an
    // unanchored verify cannot tell — exactly why the honest label matters. The
    // result must NOT claim authenticity.
    forgeWithOwnKey(outPath);
    const forged = mod.verify(outPath);
    assert.equal(forged.signature_valid, true);
    assert.equal(forged.authenticity, "self-signed");
    assert.equal(forged.trusted, false);
  } finally {
    cleanup(coordDir);
  }
});

test("UNANCHORED verify still catches a bitflip: a tampered subject fails digest_matches_subject", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
    attestation.subject.engine_version = "bitflipped";
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));

    const report = mod.verify(outPath); // no anchor configured
    assert.equal(report.authenticity, "self-signed");
    assert.equal(report.digest_matches_subject, false);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === "subject_digest_mismatch"));
  } finally {
    cleanup(coordDir);
  }
});

test("the private signing key is gitignored in the live repo", () => {
  // The PRIVATE key must never be committed. git check-ignore exits 0 (ignored).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const keyPath = "coord/.runtime/conformance-keys/attestation-signing-key.pem";
  const res = spawnSync("git", ["check-ignore", keyPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `private signing key must be gitignored (${keyPath})`);
  assert.match(res.stdout, /attestation-signing-key\.pem/);
});

// --- COORD-279 (item 2): replay protection (nonce / instance-id / expiry) -----

test("COORD-279: a FRESH attestation carries an enforced replay envelope and verifies", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { attestation, path: outPath } = mod.emit();
    // The signed replay envelope is present with nonce + instance-id + window.
    const rp = attestation.replay_protection;
    assert.ok(rp, "replay_protection envelope present");
    assert.match(rp.nonce, /[0-9a-f-]{36}/, "nonce is a uuid");
    assert.ok(rp.instance_id, "instance_id present");
    assert.ok(rp.issued_at && rp.expires_at, "issued_at + expires_at present");
    assert.ok(attestation.replay_protection_signature.value, "replay signature present");

    const report = mod.verify(outPath);
    assert.equal(report.ok, true, "fresh attestation verifies");
    assert.equal(report.replay_protection, "enforced");
    assert.equal(report.problems.length, 0);
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-279: an EXPIRED attestation is rejected", () => {
  const { mod, coordDir } = makeFixture();
  try {
    // Issue with an already-elapsed window (ttl in the past).
    const past = Date.now() - 10 * 60 * 1000;
    const { path: outPath } = mod.emit({ now: past, ttlMs: 60 * 1000 });
    const report = mod.verify(outPath); // verified "now" — well past expiry
    assert.equal(report.ok, false, "expired attestation FAILS");
    assert.equal(report.replay_protection, "enforced");
    assert.ok(
      report.problems.some((p) => p.code === "attestation_expired"),
      "attestation_expired flagged"
    );
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-279: tampering the replay envelope (extending expiry) is detected", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit({ ttlMs: 60 * 1000 });
    const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
    // Push expiry far into the future WITHOUT re-signing the replay envelope.
    attestation.replay_protection.expires_at = new Date(Date.now() + 1e12).toISOString();
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));
    const report = mod.verify(outPath);
    assert.equal(report.ok, false, "tampered replay window FAILS");
    const codes = report.problems.map((p) => p.code);
    assert.ok(
      codes.includes("replay_protection_tampered") ||
        codes.includes("replay_protection_signature_invalid"),
      "replay tamper detected"
    );
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-279: optional nonce-replay + instance binding are enforced when supplied", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { attestation, path: outPath } = mod.emit();
    const nonce = attestation.replay_protection.nonce;
    const instanceId = attestation.replay_protection.instance_id;

    // A verifier that has ALREADY seen this nonce rejects the replay.
    const replayed = mod.verify(outPath, { seenNonces: new Set([nonce]) });
    assert.equal(replayed.ok, false);
    assert.ok(replayed.problems.some((p) => p.code === "nonce_replayed"));

    // A mismatched expected instance id is rejected.
    const wrongInstance = mod.verify(outPath, { expectedInstanceId: "some-other-instance" });
    assert.equal(wrongInstance.ok, false);
    assert.ok(wrongInstance.problems.some((p) => p.code === "instance_id_mismatch"));

    // The genuine instance id passes the binding.
    const ok = mod.verify(outPath, { expectedInstanceId: instanceId });
    assert.equal(ok.ok, true);
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-279: a LEGACY attestation (no replay fields) verifies with a legacy-absent note, not a hard fail", () => {
  const { mod, coordDir } = makeFixture();
  try {
    const { path: outPath } = mod.emit();
    const attestation = JSON.parse(fs.readFileSync(outPath, "utf8"));
    // Strip the replay fields to simulate a pre-COORD-279 artifact.
    delete attestation.replay_protection;
    delete attestation.replay_protection_digest;
    delete attestation.replay_protection_signature;
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2));
    const report = mod.verify(outPath);
    assert.equal(report.replay_protection, "legacy-absent");
    assert.equal(report.ok, true, "legacy artifact still verifies (back-compat)");
    assert.equal(report.problems.length, 0);
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-279: replay protection COMPOSES with COORD-272 — expired AND untrusted both fail", () => {
  const { coordDir } = makeFixture();
  try {
    // Emit genuine, capture its key, then pin a DIFFERENT key as the trust anchor.
    const genuine = makeFixtureInDir(coordDir);
    const past = Date.now() - 10 * 60 * 1000;
    const { path: outPath } = genuine.emit({ now: past, ttlMs: 60 * 1000 });
    const otherPem = crypto
      .generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" });
    const anchored = makeFixtureInDir(coordDir, [otherPem]);
    const report = anchored.verify(outPath);
    assert.equal(report.ok, false);
    const codes = report.problems.map((p) => p.code);
    assert.ok(codes.includes("attestation_expired"), "expiry enforced");
    assert.ok(codes.includes("untrusted_signing_key"), "COORD-272 trust anchor still enforced");
  } finally {
    cleanup(coordDir);
  }
});

// Re-instantiate the attestation module against an EXISTING coordDir (reuses the
// same keypair/instance-id), optionally with a pinned trust anchor.
function makeFixtureInDir(coordDir, trustedAttestationKeys) {
  return createConformanceAttestation({
    coordDir,
    verifyGovernanceChain: () => ({ ok: true, head: "abc123def456", total: 10, chainedCount: 5 }),
    fail: (m) => {
      throw new Error(m);
    },
    trustedAttestationKeys,
  });
}

// COORD-289: the signed subject records the journal chain head's ERA (head_alg)
// alongside the head, so a verifier never has to guess the algorithm across the
// SHA-1 -> SHA-256 migration boundary. This composes with COORD-272 (the trust
// anchor still gates authenticity) and COORD-279 (the replay envelope is intact).
test("COORD-289: emit signs journal_chain_head.head_alg and self-verify still passes (sha256 era)", () => {
  const { mod, coordDir } = makeFixture({
    chain: {
      ok: true,
      head: "f".repeat(64),
      headAlg: "sha256",
      total: 12,
      chainedCount: 6,
      sha1ChainedCount: 4,
      sha256ChainedCount: 2,
      migrationIndex: 4,
    },
  });
  try {
    const { attestation, path: outPath } = mod.emit();
    // head_alg is part of the SIGNED subject.
    assert.equal(attestation.subject.journal_chain_head.head, "f".repeat(64));
    assert.equal(attestation.subject.journal_chain_head.head_alg, "sha256");
    // Self-verify passes and the replay-protection envelope (COORD-279) is intact.
    const report = mod.verify(outPath);
    assert.equal(report.ok, true);
    assert.equal(report.digest_matches_subject, true);
    assert.ok(attestation.replay_protection, "COORD-279 replay envelope present");
    assert.ok(attestation.replay_protection_signature, "COORD-279 replay signature present");
  } finally {
    cleanup(coordDir);
  }
});

test("COORD-289: head_alg is deterministic in the signed digest (same era -> same digest)", () => {
  const chain = { ok: true, head: "a".repeat(64), headAlg: "sha256", total: 3, chainedCount: 3 };
  const a = makeFixture({ chain });
  const b = makeFixture({ chain });
  try {
    assert.equal(a.mod.emit().subjectDigest, b.mod.emit().subjectDigest, "identical era inputs -> identical digest");
  } finally {
    cleanup(a.coordDir);
    cleanup(b.coordDir);
  }
});

// COORD-289: a sha1-era (pre-migration) attestation must be BYTE-COMPATIBLE in
// shape — head_alg is simply "sha1" (or null when no chain stub provides it), and
// the existing COORD-272 anchored-verify path is unchanged.
test("COORD-289: pre-migration (sha1) head_alg flows through without disturbing anchored verify", () => {
  const { mod, coordDir } = makeFixture({
    chain: { ok: true, head: "abc123", headAlg: "sha1", total: 5, chainedCount: 5 },
  });
  try {
    const { attestation, path: outPath } = mod.emit();
    assert.equal(attestation.subject.journal_chain_head.head_alg, "sha1");
    const report = mod.verify(outPath);
    assert.equal(report.ok, true);
  } finally {
    cleanup(coordDir);
  }
});
