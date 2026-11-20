"use strict";

const RUNTIME_LEDGER_DRIFT_PREFIXES = [".runtime/"];

function isRuntimeLedgerDriftPath(relativePath) {
  return RUNTIME_LEDGER_DRIFT_PREFIXES.some((prefix) =>
    String(relativePath || "").startsWith(prefix)
  );
}

module.exports = {
  RUNTIME_LEDGER_DRIFT_PREFIXES,
  isRuntimeLedgerDriftPath,
};
