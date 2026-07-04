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

// COORD-272: stable fingerprint of an ed25519 public key — sha256 hex over its
// SPKI DER encoding. Encoding-independent (a PEM and its DER yield the SAME
// fingerprint), so a pinned trust anchor can be expressed as EITHER a public-key
// PEM or a bare 64-hex fingerprint and still compare equal to the embedded key.
function publicKeyFingerprint(publicKeyOrPem) {
  const der = crypto
    .createPublicKey(publicKeyOrPem)
    .export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

// COORD-272: normalize ONE trust-anchor entry to a fingerprint hex. Accepts:
//   - a sha256 fingerprint hex (optionally colon/whitespace separated);
//   - an ed25519 public-key PEM ("-----BEGIN PUBLIC KEY----- ...");
//   - a filesystem path to a file containing such a PEM.
// Returns null (entry ignored, never throws) when it can't be coerced, so a
// malformed anchor never crashes verify — it simply doesn't grant trust.
function normalizeTrustAnchor(entry) {
  if (entry === null || entry === undefined) return null;
  let s = String(entry).trim();
  if (!s) return null;
  // A bare path to a PEM file (no inline PEM, no newlines, exists on disk).
  if (!s.includes("BEGIN") && !s.includes("\n")) {
    try {
      if (fs.existsSync(s) && fs.statSync(s).isFile()) {
        s = fs.readFileSync(s, "utf8").trim();
      }
    } catch {
      /* not a readable path — fall through to the literal interpretations */
    }
  }
  if (s.includes("BEGIN") && s.includes("KEY")) {
    try {
      return publicKeyFingerprint(s);
    } catch {
      return null;
    }
  }
  const hex = s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

module.exports = function createConformanceAttestation(deps = {}) {
  const {
    coordDir,
    verifyGovernanceChain,
    readEngineVersion,
    fail,
    // COORD-272: OPTIONAL pinned trust anchor(s). When set (here, or via
    // project.config.js `conformance.trustedAttestationKeys`, or the
    // CONFORMANCE_TRUST_ANCHOR env, or a per-call `verify(file, { trustAnchor })`)
    // verify() REQUIRES the attestation's signing key to match a trusted
    // fingerprint — closing the forge-with-your-own-key authenticity bypass.
    // When unset (the community self-hosting case) verify() still works, but
    // reports the result HONESTLY as self-signed (unverified authenticity).
    trustedAttestationKeys,
    // COORD-300: OPTIONAL resolver for the runtime root that the gitignored keypair
    // + attestation artifacts live under. Defaults to <coordDir>/.runtime (the pure
    // DI contract — keys stay under the injected coordDir, unchanged for the unit
    // test). The PRODUCTION composition root (lifecycle.js) injects
    // `() => state.RUNTIME_DIR` so a test that redirects RUNTIME_DIR to an
    // os.tmpdir() sandbox (withJournalSandbox / sandboxProcessRuntime) also sandboxes
    // the lazily-generated conformance keypair instead of writing the live tree.
    resolveRuntimeDir,
  } = deps;

  const failFn =
    fail ||
    ((m) => {
      throw new Error(m);
    });

  // Local keypair home. Private key is gitignored (under .runtime/); the public
  // key is exportable so a verifier (or ENT-007) can check the signature.
  // Resolved at CALL TIME so a runtime-dir override (sandbox) is honoured.
  const runtimeRoot = () =>
    (typeof resolveRuntimeDir === "function" ? resolveRuntimeDir() : null) ||
    path.join(coordDir, ".runtime");
  const keyDir = () => path.join(runtimeRoot(), "conformance-keys");
  const privateKeyPath = () => path.join(keyDir(), "attestation-signing-key.pem");
  const publicKeyPath = () => path.join(keyDir(), "attestation-signing-key.pub.pem");
  // COORD-279 (item 2): a stable per-instance id, persisted alongside the keypair
  // (gitignored .runtime/), so a verifier can bind an attestation to the issuing
  // instance. The nonce is per-emit; the instance id is per-checkout.
  const instanceIdPath = () => path.join(keyDir(), "attestation-instance-id");
  const attestDir = () => path.join(runtimeRoot(), "attestations");
  const MANIFEST_PATH = path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json");
  const PROVENANCE_PATH = path.join(coordDir, "RELEASE_PROVENANCE.json");
  const GATE_ARTIFACT_ROOT = path.join(coordDir, "artifacts", "gates");

  const ATTESTATION_SCHEMA_VERSION = 1;
  const SIGNATURE_ALGORITHM = "ed25519";
  // COORD-279 (item 2): default replay-protection window. A captured attestation
  // is only valid until `expires_at`; after that verify() reports it expired so a
  // stale artifact can't be replayed indefinitely. Overridable per emit() call
  // via { ttlMs } or { expiresAt }.
  const REPLAY_PROTECTION_VERSION = 1;
  const DEFAULT_ATTESTATION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  // Lazily generate + persist the local ed25519 keypair. The PRIVATE key is
  // written 0600 under the gitignored .runtime/ tree and must NEVER be committed.
  function ensureKeypair() {
    const dir = keyDir();
    const privatePath = privateKeyPath();
    const publicPath = publicKeyPath();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
      const publicPem = publicKey.export({ type: "spki", format: "pem" });
      fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
      fs.writeFileSync(publicPath, publicPem);
    }
    const privatePem = fs.readFileSync(privatePath, "utf8");
    const publicPem = fs.readFileSync(publicPath, "utf8");
    return {
      privateKey: crypto.createPrivateKey(privatePem),
      publicKey: crypto.createPublicKey(publicPem),
      publicKeyPem: publicPem,
    };
  }

  // COORD-279 (item 2): lazily generate + persist a stable instance id under the
  // gitignored .runtime/ tree (same home as the signing key).
  function ensureInstanceId() {
    const idPath = instanceIdPath();
    fs.mkdirSync(keyDir(), { recursive: true });
    if (!fs.existsSync(idPath)) {
      fs.writeFileSync(idPath, `${crypto.randomUUID()}\n`);
    }
    return fs.readFileSync(idPath, "utf8").trim();
  }

  // COORD-279 (item 2): canonical digest binding the replay-protection envelope
  // to a SPECIFIC subject (via its digest), so a replay block can't be lifted off
  // one attestation and pasted onto another.
  function digestReplayProtection(subjectDigest, replayProtection) {
    return sha256Hex(
      canonicalJson({ subject_digest: subjectDigest, replay_protection: replayProtection })
    );
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
        // COORD-289: make the era of the signed head EXPLICIT (sha1 = pre-
        // migration, sha256 = post hash-alg-migration). The subject digest is
        // already sha256; this just records which algorithm produced `head` so a
        // verifier never has to guess across the migration boundary.
        head_alg: chain.headAlg || null,
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

  // COORD-272: load the org-configured trust anchors from the project config
  // seam (`conformance.trustedAttestationKeys`). Explicit dep injection wins
  // (tests + a host that already resolved its config). Tolerant: a
  // missing/broken config or absent block yields [] so the unanchored community
  // path is preserved exactly.
  function loadConfiguredTrustAnchors() {
    if (Array.isArray(trustedAttestationKeys)) return trustedAttestationKeys;
    try {
      const configPath = process.env.COORD_PROJECT_CONFIG
        ? path.resolve(process.env.COORD_PROJECT_CONFIG)
        : path.join(coordDir, "project.config.js");
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const cfg = require(configPath) || {};
      const list = cfg.conformance && cfg.conformance.trustedAttestationKeys;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // COORD-272: resolve the EFFECTIVE set of trusted signing-key fingerprints for
  // a verify() call. Unions three OPTIONAL sources (any one pins a trust root):
  //   1. per-call `verify(file, { trustAnchor })` — CLI `--trust-anchor`;
  //   2. the CONFORMANCE_TRUST_ANCHOR env (comma-separated PEM-path|PEM|hex);
  //   3. project.config.js `conformance.trustedAttestationKeys`.
  // Each entry is coerced to a fingerprint; malformed entries are dropped.
  // Returns [] when NOTHING is configured (the unanchored / self-signed case).
  function resolveTrustAnchorFingerprints(options = {}) {
    const raw = [];
    const opt = options.trustAnchor;
    if (Array.isArray(opt)) raw.push(...opt);
    else if (opt) raw.push(opt);
    if (process.env.CONFORMANCE_TRUST_ANCHOR) {
      raw.push(
        ...process.env.CONFORMANCE_TRUST_ANCHOR.split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      );
    }
    raw.push(...loadConfiguredTrustAnchors());
    const fingerprints = new Set();
    for (const entry of raw) {
      const fp = normalizeTrustAnchor(entry);
      if (fp) fingerprints.add(fp);
    }
    return [...fingerprints];
  }

  // EMIT: derive -> sign -> write the signed attestation artifact.
  function emit(options = {}) {
    const { privateKey, publicKeyPem } = ensureKeypair();
    const subject = deriveSubject();
    const subjectDigest = digestSubject(subject);
    const signature = crypto
      .sign(null, Buffer.from(subjectDigest, "hex"), privateKey)
      .toString("base64");

    // COORD-279 (item 2): replay-protection envelope — nonce + instance id +
    // issued-at/expiry. Separately signed (binding the engine subject_digest)
    // so it is tamper-evident, while the PRIMARY subject_digest signature above
    // stays UNCHANGED (preserving determinism + the COORD-272 authenticity
    // model, which checks the embedded-key signature over the subject_digest).
    const nowMs = typeof options.now === "number" ? options.now : Date.now();
    const ttlMs =
      typeof options.ttlMs === "number" ? options.ttlMs : DEFAULT_ATTESTATION_TTL_MS;
    const issuedAtIso = new Date(nowMs).toISOString();
    const expiresAtIso = options.expiresAt || new Date(nowMs + ttlMs).toISOString();
    const replayProtection = {
      version: REPLAY_PROTECTION_VERSION,
      nonce: options.nonce || crypto.randomUUID(),
      instance_id: options.instanceId || ensureInstanceId(),
      issued_at: issuedAtIso,
      expires_at: expiresAtIso,
    };
    const replayDigest = digestReplayProtection(subjectDigest, replayProtection);
    const replaySignature = crypto
      .sign(null, Buffer.from(replayDigest, "hex"), privateKey)
      .toString("base64");

    const attestation = {
      schema_version: ATTESTATION_SCHEMA_VERSION,
      // The wall-clock issuance ts lives in the OUTER envelope, OUTSIDE the
      // signed subject, so it never breaks digest reproducibility.
      issued_at: issuedAtIso,
      subject,
      subject_digest: subjectDigest,
      signature: {
        algorithm: SIGNATURE_ALGORITHM,
        value: signature,
        public_key_pem: publicKeyPem,
      },
      // COORD-279 (item 2): replay protection (additive; legacy artifacts omit it).
      replay_protection: replayProtection,
      replay_protection_digest: replayDigest,
      replay_protection_signature: {
        algorithm: SIGNATURE_ALGORITHM,
        value: replaySignature,
      },
    };

    const attestationDir = attestDir();
    fs.mkdirSync(attestationDir, { recursive: true });
    const headTag = (subject.journal_chain_head.head || "no-chain-head").slice(0, 16);
    const fileName = options.fileName || `${headTag}.${subjectDigest.slice(0, 12)}.json`;
    const outPath = options.outPath || path.join(attestationDir, fileName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(attestation, null, 2) + "\n");

    return { attestation, path: outPath, subjectDigest };
  }

  // VERIFY: re-derive the live inputs, recompute the digest, check the
  // signature, and flag every mismatch (drift vs tamper). Read-only.
  //
  // COORD-272 — integrity vs AUTHENTICITY:
  //   - signature_valid only proves the artifact wasn't bit-flipped vs the
  //     public key EMBEDDED IN THE SAME ARTIFACT. That key is attacker-chosen,
  //     so a valid signature gives ZERO authenticity on its own.
  //   - When a trust anchor IS configured (options.trustAnchor /
  //     CONFORMANCE_TRUST_ANCHOR / project.config.js trustedAttestationKeys),
  //     verify() additionally REQUIRES the signing key's fingerprint to be in
  //     the allowlist and FAILS (authenticity: "untrusted-key") otherwise —
  //     closing the forge-with-your-own-key bypass.
  //   - When NO anchor is configured, verify() does NOT imply authenticity: it
  //     reports authenticity: "self-signed" (trusted: false) and still runs the
  //     integrity/drift checks (back-compat for community self-hosting).
  function verify(filePath, options = {}) {
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

    // (b2) AUTHENTICITY (COORD-272): the embedded-key signature above proves
    // integrity-vs-bitflips ONLY. To establish WHO signed, compare the signing
    // key's fingerprint against the configured trust anchor(s).
    const anchorFingerprints = resolveTrustAnchorFingerprints(options);
    const trustAnchorConfigured = anchorFingerprints.length > 0;
    let signingKeyFingerprint = null;
    if (sig.public_key_pem) {
      try {
        signingKeyFingerprint = publicKeyFingerprint(sig.public_key_pem);
      } catch {
        signingKeyFingerprint = null;
      }
    }
    let authenticity;
    let trusted = false;
    if (!trustAnchorConfigured) {
      // No org trust root pinned (community self-hosting). HONEST label: the
      // signature gives bitflip integrity, NOT authenticity. Not a failure —
      // this path stays back-compatible — but it must never read as "trusted".
      authenticity = "self-signed";
    } else if (
      signingKeyFingerprint &&
      anchorFingerprints.includes(signingKeyFingerprint)
    ) {
      authenticity = "trusted";
      trusted = true;
    } else {
      // A trust root IS pinned and this key is NOT in it: forged or unknown
      // signer. FAIL authenticity even if the embedded-key signature is valid.
      authenticity = "untrusted-key";
      problems.push({
        code: "untrusted_signing_key",
        detail:
          "attestation signing key is not in the configured trust anchor allowlist " +
          "(authenticity FAIL — forged with an untrusted key or signed by an unknown party)",
        signing_key_fingerprint: signingKeyFingerprint,
      });
    }

    // (b3) REPLAY PROTECTION (COORD-279 item 2): a captured attestation must not
    // replay forever. NEW attestations carry a signed replay_protection envelope
    // (nonce + instance id + issued-at/expiry). LEGACY artifacts predate it and
    // verify with an honest "legacy, no replay protection" note rather than a
    // hard fail (back-compat policy). When present, enforce: digest binding,
    // signature over the replay digest (embedded key), expiry, and — where the
    // caller supplies them — instance/nonce binding.
    const replay = attestation.replay_protection;
    let replayProtectionStatus;
    let replayExpiresAt = null;
    if (!replay || typeof replay !== "object") {
      replayProtectionStatus = "legacy-absent";
    } else {
      replayProtectionStatus = "enforced";
      replayExpiresAt = replay.expires_at || null;
      const recordedReplayDigest = attestation.replay_protection_digest || null;
      const expectedReplayDigest = digestReplayProtection(recordedDigest, replay);
      if (recordedReplayDigest !== expectedReplayDigest) {
        problems.push({
          code: "replay_protection_tampered",
          detail:
            "recorded replay_protection_digest does not match the recorded replay_protection envelope (tamper)",
        });
      }
      const replaySig = attestation.replay_protection_signature || {};
      let replaySignatureValid = false;
      if (recordedReplayDigest && replaySig.value && sig.public_key_pem) {
        try {
          replaySignatureValid = crypto.verify(
            null,
            Buffer.from(recordedReplayDigest, "hex"),
            crypto.createPublicKey(sig.public_key_pem),
            Buffer.from(replaySig.value, "base64")
          );
        } catch {
          replaySignatureValid = false;
        }
      }
      if (!replaySignatureValid) {
        problems.push({
          code: "replay_protection_signature_invalid",
          detail:
            "replay_protection signature does not verify over the recorded replay_protection_digest (tamper)",
        });
      }
      const nowMs = typeof options.now === "number" ? options.now : Date.now();
      const expiresMs = Date.parse(replay.expires_at);
      if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
        problems.push({
          code: "attestation_expired",
          detail: `attestation expired at ${replay.expires_at} (replay window elapsed)`,
          expires_at: replay.expires_at,
        });
      }
      // Optional instance binding: the verifier knows which instance it expects.
      if (options.expectedInstanceId && replay.instance_id !== options.expectedInstanceId) {
        problems.push({
          code: "instance_id_mismatch",
          detail: "attestation instance_id does not match the expected issuing instance",
          instance_id: replay.instance_id || null,
        });
      }
      // Optional nonce-replay binding: the verifier tracks already-seen nonces.
      if (options.seenNonces) {
        const seen =
          options.seenNonces instanceof Set
            ? options.seenNonces
            : new Set(options.seenNonces);
        if (replay.nonce && seen.has(replay.nonce)) {
          problems.push({
            code: "nonce_replayed",
            detail: "attestation nonce has already been seen (replay)",
            nonce: replay.nonce,
          });
        }
      }
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
      // signature_valid = bitflip integrity vs the EMBEDDED key only (NOT proof
      // of authenticity — see authenticity/trusted below).
      signature_valid: signatureValid,
      // COORD-272 — honest authenticity reporting:
      //   "trusted"       — anchor configured AND signing key is in the allowlist
      //   "untrusted-key" — anchor configured AND signing key is NOT (FAIL)
      //   "self-signed"   — NO anchor configured (integrity only, unverified authenticity)
      authenticity,
      trusted,
      trust_anchor_configured: trustAnchorConfigured,
      signing_key_fingerprint: signingKeyFingerprint,
      // COORD-279 (item 2): replay-protection report.
      //   "enforced"     — replay envelope present + checked (expiry/binding)
      //   "legacy-absent" — older artifact with no replay fields (back-compat note)
      replay_protection: replayProtectionStatus,
      replay_protection_expires_at: replayExpiresAt,
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
    // COORD-279 (item 2): replay-protection helpers exposed for tests + reuse.
    ensureInstanceId,
    digestReplayProtection,
    // COORD-272: trust-anchor helpers exposed for tests + reuse.
    publicKeyFingerprint,
    normalizeTrustAnchor,
    resolveTrustAnchorFingerprints,
    // COORD-300: resolved against the CURRENT runtime root so a sandbox redirect is
    // reflected. Exposed for tests + reuse.
    paths: {
      get KEY_DIR() { return keyDir(); },
      get PRIVATE_KEY_PATH() { return privateKeyPath(); },
      get PUBLIC_KEY_PATH() { return publicKeyPath(); },
      get ATTEST_DIR() { return attestDir(); },
      MANIFEST_PATH,
      PROVENANCE_PATH,
      GATE_ARTIFACT_ROOT,
    },
  };
};

module.exports.__internals = {
  canonicalize,
  canonicalJson,
  sha256Hex,
  publicKeyFingerprint,
  normalizeTrustAnchor,
};
