'use strict';

const fs = require('node:fs');
const path = require('node:path');

function meaningful(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimOrNull(value) {
  return meaningful(value) ? value.trim() : null;
}

function statusField(value, redacted) {
  if (!meaningful(value)) return { state: 'absent', detail: null };
  return { state: 'present', detail: redacted ? null : value.trim() };
}

function receiptStatus({
  id,
  declaration,
  engine,
  redacted,
  coordDir,
  projectRoot,
  fsImpl = fs,
  pathImpl = path,
}) {
  if (!engine) return { state: 'unknown', result: null, path: null };
  try {
    let file = engine.latestReceipt('live-mcp', id, { coordDir });
    if (!file && meaningful(declaration.receipt_path)) {
      file = pathImpl.resolve(projectRoot, declaration.receipt_path.trim());
    }
    if (!file || !fsImpl.existsSync(file)) {
      const inline = declaration.receipt;
      if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
        const result = inline.result;
        return {
          state: 'present',
          result: redacted ? null : trimOrNull(result) || 'recorded',
          path: null,
        };
      }
      return { state: 'absent', result: null, path: null };
    }
    const receipt = engine.readReceipt(file, (msg) => {
      throw new Error(msg);
    });
    const rel = pathImpl.relative(projectRoot, file).split(pathImpl.sep).join('/');
    return {
      state: 'present',
      result: redacted ? null : trimOrNull(receipt.result) || 'recorded',
      path: redacted ? null : rel,
    };
  } catch {
    return { state: 'unknown', result: null, path: null };
  }
}

function buildTicketView({
  id,
  status,
  planState,
  declaration,
  lifecycle,
  receipts,
  redacted,
  coordDir,
  projectRoot,
}) {
  const result = lifecycle.buildLiveMcpLifecycle({ planState });
  const linkedDev = declaration.development_ticket ?? declaration.linked_ticket;
  const deployedVerification = declaration.deployed_verification ?? declaration.deploy_receipt;
  return {
    id,
    status: meaningful(status) ? status.trim() : 'unknown',
    adapter: trimOrNull(declaration.adapter),
    operation: meaningful(declaration.operation) && !redacted ? declaration.operation.trim() : null,
    environment: trimOrNull(declaration.environment),
    operationClass: trimOrNull(declaration.operation_class),
    scope: statusField(declaration.scope, redacted),
    approval: statusField(declaration.approval, redacted),
    redaction: statusField(declaration.redaction, redacted),
    cleanup: statusField(declaration.cleanup, redacted),
    promotion: statusField(declaration.promotion, redacted),
    receipt: receiptStatus({ id, declaration, engine: receipts, redacted, coordDir, projectRoot }),
    blockers: Array.isArray(result.issues) ? result.issues : [],
    linkedDevelopmentTicket: trimOrNull(linkedDev),
    deployedVerificationReceipt:
      meaningful(deployedVerification) && !redacted ? deployedVerification.trim() : null,
  };
}

function collectLiveMcpExportTicket({
  id,
  planState,
  declaration,
  lifecycle,
  receipts,
  coordDir,
  projectRoot,
}) {
  const result = lifecycle.buildLiveMcpLifecycle({ planState });
  const r = receiptStatus({
    id,
    declaration,
    engine: receipts,
    redacted: false,
    coordDir,
    projectRoot,
  });
  return {
    id,
    adapter: trimOrNull(declaration.adapter),
    operationClass: trimOrNull(declaration.operation_class),
    environment: trimOrNull(declaration.environment),
    receiptPath: r.path,
    unresolvedBlockers: Array.isArray(result.issues) ? result.issues : [],
  };
}

module.exports = {
  meaningful,
  statusField,
  receiptStatus,
  buildTicketView,
  collectLiveMcpExportTicket,
};
