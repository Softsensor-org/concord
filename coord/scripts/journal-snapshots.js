"use strict";

function createJournalSnapshots(deps = {}) {
  const { path, state } = deps;

  function governanceSnapshotArtifactPath(digest) {
    return path.join(state.GOVERNANCE_SNAPSHOTS_DIR, `${digest}.json`);
  }

  return {
    governanceSnapshotArtifactPath,
  };
}

module.exports = {
  createJournalSnapshots,
};
