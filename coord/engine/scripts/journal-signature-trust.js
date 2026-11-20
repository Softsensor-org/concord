"use strict";

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = path.resolve(__dirname, "..", "..");
const { publicKeyFingerprint, normalizeTrustAnchor } = require(resolveEngineModule(COORD_DIR, "scripts/conformance-attestation.js")).__internals;

// Same trust sources and fingerprint representation as conformance attestations.
// Invalid configured anchors must not silently become an unanchored verifier.
function assessSignerTrust(publicKeyPem, signatureValid, options = {}) {
  const raw = [];
  const add = value => {
    if (Array.isArray(value)) raw.push(...value);
    else if (value !== undefined && value !== null) raw.push(value);
  };
  add(options.trustAnchors);
  add(options.trustAnchor);
  let invalidConfig = false;
  if (options.coordDir) {
    if (process.env.CONFORMANCE_TRUST_ANCHOR !== undefined) {
      add(process.env.CONFORMANCE_TRUST_ANCHOR.split(","));
    }
    const configPath = process.env.COORD_PROJECT_CONFIG
      ? path.resolve(process.env.COORD_PROJECT_CONFIG)
      : path.join(options.coordDir, "project.config.js");
    try {
      const configured = require(configPath)?.conformance?.trustedAttestationKeys;
      if (configured !== undefined && !Array.isArray(configured)) invalidConfig = true;
      else add(configured);
    } catch (error) {
      // A missing optional config is different from a broken configured module.
      if (process.env.COORD_PROJECT_CONFIG || error.code !== "MODULE_NOT_FOUND" || require("node:fs").existsSync(configPath)) invalidConfig = true;
    }
  }
  const anchors = raw.map(normalizeTrustAnchor);
  const configured = raw.length > 0 || invalidConfig;
  let fingerprint = null;
  try { fingerprint = publicKeyFingerprint(publicKeyPem); } catch { /* invalid signer */ }
  const trusted = signatureValid && !invalidConfig && !anchors.includes(null)
    && configured && fingerprint !== null && anchors.includes(fingerprint);
  return {
    authenticity: !configured ? "self-signed" : trusted ? "trusted" : "untrusted-key",
    trust_checked: configured,
    trusted,
    signing_key_fingerprint: fingerprint,
  };
}

module.exports = { assessSignerTrust };
