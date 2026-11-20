"use strict";

const SNAPSHOT_NEUTRAL_APPROVAL_EVENTS = new Set(["approval.refused", "approval.verified", "override_without_session"]);

function selectSnapshotEvent(latestEvent, readEvents) {
  if (!latestEvent || !SNAPSHOT_NEUTRAL_APPROVAL_EVENTS.has(latestEvent.event) ||
      latestEvent.snapshot_digest || latestEvent.snapshot) return latestEvent;
  const events = readEvents();
  let index = events.length - 1;
  while (index >= 0 && SNAPSHOT_NEUTRAL_APPROVAL_EVENTS.has(events[index]?.event) &&
      !events[index]?.snapshot_digest && !events[index]?.snapshot) index -= 1;
  return index >= 0 ? events[index] : null;
}

// Ordinary journal events and migration anchors persist their existing snapshot
// identically. Persist before returning the digest reference; a failed write must
// prevent append, and the caller's event and snapshot stay unchanged.
function serializeSnapshotEvent(event, writeSnapshotArtifact) {
  const serialized = { ...event };
  if (event.snapshot) {
    writeSnapshotArtifact(event.snapshot);
    serialized.snapshot_digest = event.snapshot.digest;
    delete serialized.snapshot;
  }
  return serialized;
}

function createJournalSnapshots(deps = {}) {
  const { path, state } = deps;

  function governanceSnapshotArtifactPath(digest) {
    return path.join(state.GOVERNANCE_SNAPSHOTS_DIR, `${digest}.json`);
  }

  function formatUnavailableSnapshotMessage(provenance) {
    return `Governance snapshot baseline unavailable for digest ${provenance.expectedSnapshotDigest || "unknown"}; current state cannot be verified. ` +
      'Inspect with gov reconcile --reason "baseline recovery" --dry-run, then, after review, re-run it with --human-admin-override "<approval for these exact changes>" --expect-paths-file <the approved path and sha256 packet>.';
  }

  return {
    governanceSnapshotArtifactPath,
    formatUnavailableSnapshotMessage,
  };
}

module.exports = {
  createJournalSnapshots,
  selectSnapshotEvent,
  serializeSnapshotEvent,
};
