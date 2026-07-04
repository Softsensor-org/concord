"use strict";

// COORD-289: signing + verification primitives for the journal hash-chain
// SHA-1 -> SHA-256 versioned forward transition (the `hash-alg-migration`
// bridge event).
//
// WHAT THIS IS. The migration event is the single, governed hinge that bridges
// the historical SHA-1 hash-chain era to the new SHA-256 era WITHOUT re-hashing
// or re-chaining any historical event. It is SHA-1-linked to the prior tip
// (continuity: the old chain still verifies end-to-end up to it), it carries
// `hash_alg: "sha256"`, and its own SHA-256 record-hash becomes the checkpoint
// genesis the next era links to. To make the bridge non-repudiable, the event
// embeds an ed25519 SIGNATURE over the deterministic transition payload
//   { migrated_at, sha1_chain_head, verifier_version }
// so a later auditor can prove the key-holder authorized this exact transition
// off this exact SHA-1 head.
//
// REUSED CRYPTO (no new crypto rolled). The ed25519 + canonical-JSON + sha256
// envelope is the IDENTICAL stack as conformance-attestation.js: we import its
// `__internals` (canonicalJson, sha256Hex, publicKeyFingerprint,
// normalizeTrustAnchor) so the transition signature CANNOT diverge from the
// existing conformance attestation surface, and the migration is signed with the
// SAME conformance keypair (coord/.runtime/conformance-keys/). Trust-anchor
// resolution mirrors COORD-272 exactly: a self-signed signature still verifies
// for integrity, but AUTHENTICITY is only granted when a configured trust anchor
// pins the signer — so a forged signature (re-signed under an attacker key) is
// rejected once a trust anchor is configured.

const crypto = require("node:crypto");

const {
  canonicalJson,
  sha256Hex,
  publicKeyFingerprint,
  normalizeTrustAnchor,
} = require("./conformance-attestation.js").__internals;

const SIGNATURE_ALGORITHM = "ed25519";

// Deterministic transition payload. Key ORDER is irrelevant (canonicalJson sorts
// keys), but we pin the exact field set so the signed subject is stable + minimal.
// This is the ONLY thing the signature covers — NOT the whole event record — so
// the event's linkage fields (prev_event_hash, the embedded signature object
// itself) never feed back into what is signed.
function transitionPayload({ migrated_at, sha1_chain_head, verifier_version }) {
  return {
    migrated_at: migrated_at ?? null,
    sha1_chain_head: sha1_chain_head ?? null,
    verifier_version: verifier_version ?? null,
  };
}

// sha256 hex digest of the canonical transition payload — the bytes that are
// ed25519-signed (matching conformance-attestation.js, which signs the hex
// subject digest, not the raw JSON).
function transitionDigest(payload) {
  return sha256Hex(canonicalJson(transitionPayload(payload)));
}

// Sign a transition payload with the supplied (conformance) ed25519 private key.
// Returns the embeddable signature object: the value, the algorithm, the signer
// PUBLIC key PEM (so any reader can self-verify integrity), and the key
// fingerprint (so a trust-anchor check can pin authenticity).
function signTransition(payload, privateKey, publicKeyPem) {
  const digest = transitionDigest(payload);
  const value = crypto
    .sign(null, Buffer.from(digest, "hex"), privateKey)
    .toString("base64");
  return {
    algorithm: SIGNATURE_ALGORITHM,
    value,
    public_key_pem: publicKeyPem,
    key_fingerprint: publicKeyFingerprint(publicKeyPem),
  };
}

// Verify a transition signature against its payload.
//   - signature_checked: there was enough material (value + embedded key) to run
//     the check at all.
//   - signature_valid: the ed25519 signature verifies over the recorded payload
//     digest using the EMBEDDED public key (integrity; detects any bit-flip of
//     the signature OR the signed payload fields).
//   - trust_checked / trusted: when a non-empty trustAnchors set is supplied
//     (COORD-272 composition), authenticity additionally REQUIRES the signer
//     fingerprint to be pinned. A forged signature (valid under the attacker's
//     own embedded key) passes integrity but FAILS trust.
// Never throws — malformed material yields signature_valid:false.
function verifyTransitionSignature(payload, signature, options = {}) {
  const sig = signature || {};
  const publicKeyPem = sig.public_key_pem || null;
  const result = {
    signature_checked: false,
    signature_valid: false,
    trust_checked: false,
    trusted: false,
    fingerprint: null,
  };
  if (!sig.value || !publicKeyPem) {
    return result;
  }
  result.signature_checked = true;
  const digest = transitionDigest(payload);
  try {
    result.signature_valid = crypto.verify(
      null,
      Buffer.from(digest, "hex"),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(sig.value, "base64")
    );
  } catch {
    result.signature_valid = false;
  }
  try {
    result.fingerprint = publicKeyFingerprint(publicKeyPem);
  } catch {
    result.fingerprint = null;
  }

  const anchors = Array.isArray(options.trustAnchors)
    ? options.trustAnchors.map(normalizeTrustAnchor).filter(Boolean)
    : [];
  if (anchors.length > 0) {
    result.trust_checked = true;
    result.trusted =
      result.signature_valid &&
      result.fingerprint !== null &&
      anchors.includes(result.fingerprint);
  }
  return result;
}

module.exports = {
  SIGNATURE_ALGORITHM,
  transitionPayload,
  transitionDigest,
  signTransition,
  verifyTransitionSignature,
};
