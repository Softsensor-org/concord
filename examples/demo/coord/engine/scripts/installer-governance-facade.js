"use strict";

// Named production surface for create-concord's target-local installer.
// Keep lifecycle.js limited to injecting its existing journal services.
function createInstallerGovernanceFacade(services = {}) {
  return Object.freeze({
    installerGovernance: Object.freeze({
      buildSnapshot: services.buildSnapshot,
      snapshotArtifactPath: services.snapshotArtifactPath,
      readEventLog: services.readEventLog,
      verifyChain: services.verifyChain,
      detectProvenanceDrift: services.detectProvenanceDrift,
      ensureBaseline: services.ensureBaseline,
    }),
  });
}

module.exports = { createInstallerGovernanceFacade };
