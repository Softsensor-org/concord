"use strict";

function createFeatureProofEntryValidator({ fail }) {
  function validateFeatureProofEntry(value) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      fail("Feature proof entries may not be empty.");
    }
    if (/^path:/.test(normalized)) {
      if (/#/.test(normalized)) {
        fail(
          `Feature proof entry "${normalized}" is invalid. ` +
          `Use "path:<file>" for file proofs or "symbol:<file>#<symbol>" for symbol proofs.`
        );
      }
      return;
    }
    if (/^symbol:[^#]+#.+$/.test(normalized)) {
      return;
    }
    if (/^(text|route):.+$/.test(normalized)) {
      return;
    }
    fail(
      `Feature proof entry "${normalized}" is invalid. ` +
      `Use "path:<file>", "symbol:<file>#<symbol>", "text:<literal>", or "route:<literal-route>". ` +
      `Cross-repository proof prefixes are unsupported; record a proof relative to the ticket's repository.`
    );
  }

  return { validateFeatureProofEntry };
}

module.exports = {
  createFeatureProofEntryValidator,
};
