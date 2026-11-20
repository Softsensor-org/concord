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

function asBootstrapRisk(planState) {
  const v = planState && planState.bootstrap_risk;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return null;
}

function serverReadiness(br) {
  if (!br) {
    return { workClass: null, runsAtBoot: null, sharesAppProcess: null, posture: 'undeclared' };
  }
  const workClass = trimOrNull(br.startup_work_class);
  const runsAtBoot = typeof br.runs_at_boot === 'boolean' ? br.runs_at_boot : null;
  const sharesAppProcess = typeof br.shares_app_process === 'boolean' ? br.shares_app_process : null;
  let posture = 'undeclared';
  if (runsAtBoot === true && sharesAppProcess === true) {
    posture = 'declared-risky';
  } else if (runsAtBoot === false || sharesAppProcess === false) {
    posture = 'declared-safe';
  }
  return { workClass, runsAtBoot, sharesAppProcess, posture };
}

function resourceEnvelope(br, redacted) {
  const env = br && br.resource_envelope;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { state: 'absent', summary: null };
  }
  const parts = [];
  const push = (label, value, suffix = '') => {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      parts.push(`${label}=${String(value).trim()}${suffix}`);
    }
  };
  push('memory', env.memory_mb, 'mb');
  push('timeout', env.timeout_s, 's');
  push('rows', env.expected_rows);
  push('batch', env.batch_size);
  push('db', env.db_pool_impact);
  if (parts.length === 0) return { state: 'absent', summary: null };
  return { state: 'present', summary: redacted ? null : parts.join(', ') };
}

function jobCompletion({
  id,
  engine,
  redacted,
  coordDir,
  projectRoot,
  fsImpl = fs,
  pathImpl = path,
}) {
  if (!engine) return { state: 'unknown', result: null, path: null };
  try {
    const file = engine.latestReceipt('bootstrap', id, { coordDir });
    if (!file || !fsImpl.existsSync(file)) return { state: 'absent', result: null, path: null };
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

function queryScanText(br) {
  if (!br) return '';
  const parts = [];
  for (const key of ['data_access_shape', 'checkpoint_strategy', 'idempotency_strategy']) {
    if (meaningful(br[key])) parts.push(br[key]);
  }
  const env = br.resource_envelope;
  if (env && typeof env === 'object' && !Array.isArray(env) && meaningful(env.db_pool_impact)) {
    parts.push(env.db_pool_impact);
  }
  return parts.join('\n');
}

function buildTicketView({
  id,
  row,
  planState,
  source,
  advisory,
  queryEngine,
  receipts,
  redacted,
  coordDir,
  projectRoot,
}) {
  const br = asBootstrapRisk(planState);
  const obs = br && br.observability_requirements;
  const obsItems = Array.isArray(obs) ? obs.filter((x) => meaningful(x)) : [];
  const scanText = queryScanText(br);
  const queryResult =
    queryEngine && scanText.trim() ? queryEngine.scanBackfillQueryText(scanText) : null;
  const queryWarnings = queryResult && Array.isArray(queryResult.findings) ? queryResult.findings : [];

  return {
    id,
    status: meaningful(row && row.Status) ? row.Status.trim() : 'unknown',
    source,
    serverReadiness: serverReadiness(br),
    resourceEnvelope: resourceEnvelope(br, redacted),
    idempotency: statusField(br && br.idempotency_strategy, redacted),
    checkpoint: statusField(br && br.checkpoint_strategy, redacted),
    verificationSignal: statusField(br && br.verification_signal, redacted),
    rollbackOrDisable: statusField(br && br.rollback_or_disable, redacted),
    observability: {
      state: obsItems.length > 0 ? 'present' : 'absent',
      items: obsItems.length === 0 ? null : redacted ? null : obsItems,
    },
    dataAccessShape: statusField(br && br.data_access_shape, redacted),
    jobCompletion: jobCompletion({ id, engine: receipts, redacted, coordDir, projectRoot }),
    matchedSignals: Array.isArray(advisory.matched_signals) ? advisory.matched_signals : [],
    missingEvidence: Array.isArray(advisory.missing_evidence) ? advisory.missing_evidence : [],
    advisoryMessage: advisory.triggered ? advisory.message : null,
    queryWarnings,
  };
}

module.exports = {
  meaningful,
  statusField,
  asBootstrapRisk,
  serverReadiness,
  resourceEnvelope,
  jobCompletion,
  queryScanText,
  buildTicketView,
};
