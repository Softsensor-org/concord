"use strict";

function createJournalRepair(deps = {}) {
  const { state } = deps;

  function governanceChainRepairBackupPath(ts) {
    const safeTs = String(ts).replace(/[:.]/g, "-");
    return `${state.GOVERNANCE_EVENT_LOG_PATH}.pre-repair-${safeTs}`;
  }

  return {
    governanceChainRepairBackupPath,
  };
}

module.exports = {
  createJournalRepair,
};
