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
  });
  return { mod, coordDir };
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
