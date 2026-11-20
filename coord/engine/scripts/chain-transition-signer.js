"use strict";

// COORD-377: hash-chain migration bridge signing belongs outside lifecycle.js.
// The signer deliberately reuses the conformance attestation keypair so the
// migration bridge cannot drift from the local conformance identity.

module.exports = function createChainTransitionSigner(deps = {}) {
  const {
    coordDir,
    resolveRuntimeDir,
    createConformanceAttestation,
    signTransition,
  } = deps;

  function signChainTransition(payload) {
    const att = createConformanceAttestation({
      coordDir,
      resolveRuntimeDir,
    });
    const { privateKey, publicKeyPem } = att.ensureKeypair();
    return signTransition(payload, privateKey, publicKeyPem);
  }

  return { signChainTransition };
};
