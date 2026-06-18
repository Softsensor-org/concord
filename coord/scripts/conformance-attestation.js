"use strict";

// ENT-010: conformance attestation EMIT + local self-verify (Community half of
// ENT-007). This is the per-team trust feature: a team proves its OWN engine
// integrity locally — no central service. `gov conform --attest` derives a
// deterministic attestation over the engine-integrity inputs, signs the
// canonical digest with a LOCAL ed25519 keypair, and writes the signed artifact.
// `gov conform --verify-attestation <file>` RE-derives the inputs, recomputes
// the digest, checks the signature, and flags any mismatch (drift or tamper).
//
// The signed attestation is the exact input a future Enterprise central re-hash
// service (ENT-007) would re-compute and compare — but that central service is
// OUT OF SCOPE here. This module is emit + LOCAL verify only.
//
// Attestation `subject` (the SIGNED, deterministic payload) captures:
//   1. engine_version       — the engine version string.
//   2. template_sync_manifest — sha256 of coord/TEMPLATE_SYNC_MANIFEST.json
//                               (the exact-match engine-surface fingerprint).
//   3. gate                 — gate config + the latest gate-artifact
//                             result/coverage/audit/completeness summary
//                             per repo (COORD-080), or null when none emitted.
//   4. release_provenance   — the RELEASE_PROVENANCE.json donor SHA (COORD-044)
//                             when present, else null.
//   5. journal_chain_head   — the journal hash-chain head (ENT-002).
//
// Determinism: identical inputs -> byte-identical canonical subject -> identical
// digest -> a signature that verifies. The wall-clock `issued_at` ts is recorded
// in the OUTER envelope, NOT inside the signed digest, so it never breaks
// reproducibility. Read-only except writing the attestation artifact and (on
// first use) the local keypair — both under coord/.runtime/ (gitignored).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Canonical JSON: stable key ordering so the digest is reproducible regardless
// of insertion order. Recursively sorts object keys; arrays keep their order
// (order is semantically meaningful in the inputs we capture).
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = function createConformanceAttestation(deps = {}) {
  const {
    coordDir,
    verifyGovernanceChain,
    readEngineVersion,
    fail,
  } = deps;

  const failFn =
    fail ||
    ((m) => {
      throw new Error(m);
    });

  // Local keypair home. Private key is gitignored (under .runtime/); the public
  // key is exportable so a verifier (or ENT-007) can check the signature.
  const KEY_DIR = path.join(coordDir, ".runtime", "conformance-keys");
  const PRIVATE_KEY_PATH = path.join(KEY_DIR, "attestation-signing-key.pem");
  const PUBLIC_KEY_PATH = path.join(KEY_DIR, "attestation-signing-key.pub.pem");
  const ATTEST_DIR = path.join(coordDir, ".runtime", "attestations");
  const MANIFEST_PATH = path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json");
  const PROVENANCE_PATH = path.join(coordDir, "RELEASE_PROVENANCE.json");
  const GATE_ARTIFACT_ROOT = path.join(coordDir, "artifacts", "gates");

  const ATTESTATION_SCHEMA_VERSION = 1;
  const SIGNATURE_ALGORITHM = "ed25519";

  // Lazily generate + persist the local ed25519 keypair. The PRIVATE key is
  // written 0600 under the gitignored .runtime/ tree and must NEVER be committed.
  function ensureKeypair() {
    fs.mkdirSync(KEY_DIR, { recursive: true });
    if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
      const publicPem = publicKey.export({ type: "spki", format: "pem" });
      fs.writeFileSync(PRIVATE_KEY_PATH, privatePem, { mode: 0o600 });
      fs.writeFileSync(PUBLIC_KEY_PATH, publicPem);
    }
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const publicPem = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");
    return {
      privateKey: crypto.createPrivateKey(privatePem),
      publicKey: crypto.createPublicKey(publicPem),
      publicKeyPem: publicPem,
    };
  }

  // 2. TEMPLATE_SYNC_MANIFEST.json fingerprint (the exact-match engine surface).
  function deriveManifestFingerprint() {
    if (!fs.existsSync(MANIFEST_PATH)) {
      return { present: false, sha256: null, bytes: 0 };
    }
    const buf = fs.readFileSync(MANIFEST_PATH);
    let manifestVersion = null;
    try {
      manifestVersion = JSON.parse(buf.toString("utf8")).manifest_version || null;
    } catch {
      manifestVersion = null;
    }
    return {
      present: true,
      sha256: sha256Hex(buf),
      bytes: buf.length,
      manifest_version: manifestVersion,
    };
  }

  // 3. Gate config + the LATEST gate-artifact result/coverage/audit/completeness
  // per repo (COORD-080). The runner writes `<lane>.latest.json` per repo under
  // coord/artifacts/gates/<repo>/. We summarize the discriminating, deterministic
  // fields only (verdict + coverage/audit one-liners + completeness), not the
  // whole artifact, so the digest is stable and small. Returns null when no gate
  // artifact has been emitted (a fresh clone / never-gated repo).
  function deriveGateSummary() {
    if (!fs.existsSync(GATE_ARTIFACT_ROOT)) return null;
    const repos = fs.readdirSync(GATE_ARTIFACT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const perRepo = {};
    for (const repo of repos) {
      const repoDir = path.join(GATE_ARTIFACT_ROOT, repo);
      const latestFiles = fs.readdirSync(repoDir)
        .filter((f) => /\.latest\.json$/.test(f) && !/\.(local|ci)\.latest\.json$/.test(f))
        .sort();
      const lanes = {};
      for (const file of latestFiles) {
        const lane = file.replace(/\.latest\.json$/, "");
        let artifact = null;
        try {
          artifact = JSON.parse(fs.readFileSync(path.join(repoDir, file), "utf8"));
        } catch {
          continue;
        }
        lanes[lane] = {
          result: artifact.result || artifact.status || null,
          commit: artifact.commit || null,
          coverage: typeof artifact.coverage === "string" ? artifact.coverage : null,
          audit: typeof artifact.audit === "string" ? artifact.audit : null,
          complete: artifact.complete === true,
          incomplete_fields: Array.isArray(artifact.incomplete_fields)
            ? [...artifact.incomplete_fields].sort()
            : [],
        };
      }
      if (Object.keys(lanes).length > 0) {
        perRepo[repo] = lanes;
      }
    }
    return Object.keys(perRepo).length > 0 ? perRepo : null;
  }

  // 4. RELEASE_PROVENANCE donor SHA (COORD-044) when present, else null.
  function deriveReleaseProvenance() {
    if (!fs.existsSync(PROVENANCE_PATH)) return null;
    let provenance = null;
    try {
      provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
    } catch {
      return null;
    }
    const donorSha =
      provenance?.donor_sha ||
      provenance?.donor?.sha ||
      provenance?.template_head_sha ||
      provenance?.source_sha ||
      null;
    return { donor_sha: donorSha };
  }

  // 1. Engine version. The TEMPLATE_SYNC_MANIFEST's `manifest_version` is the
  // canonical engine-surface version marker (e.g. "2026-06-15-coord-100"); a
  // host may inject a richer source via the readEngineVersion dep.
  function deriveEngineVersion(manifestFingerprint) {
    if (readEngineVersion) {
      const injected = readEngineVersion();
      if (injected) return injected;
    }
    return manifestFingerprint?.manifest_version || null;
  }

  // Derive the deterministic SIGNED subject — the 5 engine-integrity inputs.
  function deriveSubject() {
    const chain = verifyGovernanceChain();
    const manifestFingerprint = deriveManifestFingerprint();
    return {
      engine_version: deriveEngineVersion(manifestFingerprint),
      template_sync_manifest: manifestFingerprint,
      gate: deriveGateSummary(),
      release_provenance: deriveReleaseProvenance(),
      journal_chain_head: {
        head: chain.head,
        ok: chain.ok === true,
        total_events: chain.total,
        chained_events: chain.chainedCount,
      },
    };
  }

  // Compute the canonical digest of a subject (hex sha256 of canonical JSON).
  function digestSubject(subject) {
    return sha256Hex(canonicalJson(subject));
  }

  // EMIT: derive -> sign -> write the signed attestation artifact.
  function emit(options = {}) {
    const { privateKey, publicKeyPem } = ensureKeypair();
    const subject = deriveSubject();
    const subjectDigest = digestSubject(subject);
    const signature = crypto
      .sign(null, Buffer.from(subjectDigest, "hex"), privateKey)
      .toString("base64");

    const attestation = {
      schema_version: ATTESTATION_SCHEMA_VERSION,
      // The wall-clock issuance ts lives in the OUTER envelope, OUTSIDE the
      // signed subject, so it never breaks digest reproducibility.
      issued_at: new Date().toISOString(),
      subject,
      subject_digest: subjectDigest,
      signature: {
        algorithm: SIGNATURE_ALGORITHM,
        value: signature,
        public_key_pem: publicKeyPem,
      },
    };

    fs.mkdirSync(ATTEST_DIR, { recursive: true });
    const headTag = (subject.journal_chain_head.head || "no-chain-head").slice(0, 16);
    const fileName = options.fileName || `${headTag}.${subjectDigest.slice(0, 12)}.json`;
    const outPath = options.outPath || path.join(ATTEST_DIR, fileName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2) + "\n");

    return { attestation, path: outPath, subjectDigest };
  }

  // VERIFY: re-derive the live inputs, recompute the digest, check the
  // signature, and flag every mismatch (drift vs tamper). Read-only.
  function verify(filePath) {
    if (!filePath) {
      failFn("verify-attestation requires a path to an attestation file.");
    }
    if (!fs.existsSync(filePath)) {
      failFn(`Attestation file not found: ${filePath}`);
    }
    let attestation = null;
    try {
      attestation = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      failFn(`Attestation file is not valid JSON: ${filePath} (${error.message})`);
    }

    const problems = [];
    const sig = attestation.signature || {};
    const recordedSubject = attestation.subject || {};
    const recordedDigest = attestation.subject_digest || null;

    // (a) Internal consistency: does the recorded digest match the recorded
    // subject? A mismatch means a SIGNED field was tampered post-signing.
    const recomputedRecordedDigest = digestSubject(recordedSubject);
    const digestMatchesSubject = recomputedRecordedDigest === recordedDigest;
    if (!digestMatchesSubject) {
      problems.push({
        code: "subject_digest_mismatch",
        detail: "recorded subject_digest does not match the recorded subject (tamper)",
      });
    }

    // (b) Signature: does the signature verify over the recorded digest using
    // the embedded public key? A bad signature means tamper or a wrong key.
    let signatureValid = false;
    if (recordedDigest && sig.value && sig.public_key_pem) {
      try {
        signatureValid = crypto.verify(
          null,
          Buffer.from(recordedDigest, "hex"),
          crypto.createPublicKey(sig.public_key_pem),
          Buffer.from(sig.value, "base64")
        );
      } catch {
        signatureValid = false;
      }
    }
    if (!signatureValid) {
      problems.push({
        code: "signature_invalid",
        detail: "ed25519 signature does not verify over the recorded subject_digest (tamper)",
      });
    }

    // (c) Drift: re-derive the live engine inputs and compare against the
    // attested subject. A mismatch means the engine surface changed since the
    // attestation was issued (drift) — not necessarily tamper, but flagged.
    const liveSubject = deriveSubject();
    const liveDigest = digestSubject(liveSubject);
    const matchesLive = liveDigest === recordedDigest;
    if (!matchesLive) {
      problems.push({
        code: "engine_input_drift",
        detail: "live engine inputs no longer match the attested subject (drift or stale attestation)",
        live_digest: liveDigest,
        attested_digest: recordedDigest,
      });
    }

    const ok = problems.length === 0;
    return {
      ok,
      path: filePath,
      digest_matches_subject: digestMatchesSubject,
      signature_valid: signatureValid,
      matches_live_inputs: matchesLive,
      attested_digest: recordedDigest,
      live_digest: liveDigest,
      problems,
    };
  }

  return {
    emit,
    verify,
    // Exposed for tests + reuse.
    deriveSubject,
    digestSubject,
    canonicalJson,
    ensureKeypair,
    paths: {
      KEY_DIR,
      PRIVATE_KEY_PATH,
      PUBLIC_KEY_PATH,
      ATTEST_DIR,
      MANIFEST_PATH,
      PROVENANCE_PATH,
      GATE_ARTIFACT_ROOT,
    },
  };
};

module.exports.__internals = { canonicalize, canonicalJson, sha256Hex };
