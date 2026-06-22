"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { COORD_DIR, ROOT_DIR, defaultFail } = require("./governance-context.js");

const OPERATION_CLASSES = Object.freeze({
  read_safe: {
    approval: "ticket",
    receipt: true,
    cleanup: false,
    redaction: "recommended",
  },
  read_sensitive: {
    approval: "human",
    receipt: true,
    cleanup: false,
    redaction: "required",
  },
  write_low: {
    approval: "human",
    receipt: true,
    cleanup: false,
    redaction: "recommended",
  },
  write_prod: {
    approval: "human",
    receipt: true,
    cleanup: true,
    redaction: "required",
  },
  destructive: {
    approval: "human_admin",
    receipt: true,
    cleanup: true,
    redaction: "required",
  },
});

const EVIDENCE_CLASSES = new Set([
  "fixture",
  "gate",
  "runtime",
  "mcp-oracle",
  "deploy",
  "bootstrap",
]);

const RESULT_VALUES = new Set(["pass", "fail", "observed", "blocked"]);

function rel(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function nowIso() {
  return new Date().toISOString();
}

function compactIso(value) {
  return String(value || nowIso()).replace(/[^0-9TZ]/g, "").slice(0, 16);
}

function safeSlug(value) {
  return String(value || "receipt")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "receipt";
}

function requireText(value, label, fail) {
  const text = String(value || "").trim();
  if (!text) {
    fail(`${label} is required.`);
  }
  return text;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function parseKeyValueList(values, fail = defaultFail) {
  const out = {};
  for (const raw of Array.isArray(values) ? values : values ? [values] : []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const idx = text.indexOf("=");
    if (idx <= 0) {
      fail(`Expected key=value metadata, got "${text}".`);
    }
    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1).trim();
    if (!key || !value) {
      fail(`Expected key=value metadata, got "${text}".`);
    }
    out[key] = value;
  }
  return out;
}

function parseJsonFile(filePath, label, fail = defaultFail) {
  const resolved = path.resolve(ROOT_DIR, filePath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    fail(`Could not read ${label} at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} at ${filePath} is not valid JSON: ${error.message}`);
  }
}

function receiptBaseDir(kind, coordDir = COORD_DIR) {
  return path.join(coordDir, "evidence", kind);
}

function receiptPath(kind, ticket, label, options = {}) {
  const base = options.baseDir || receiptBaseDir(kind, options.coordDir || COORD_DIR);
  const filename = `${compactIso(options.timestamp)}-${safeSlug(ticket)}-${safeSlug(label)}.json`;
  return path.join(base, filename);
}

function writeReceipt(kind, ticket, label, payload, options = {}) {
  const filePath = options.path || receiptPath(kind, ticket, label, options);
  const record = {
    schema_version: 1,
    kind,
    ticket,
    recorded_at: payload.recorded_at || options.timestamp || nowIso(),
    ...payload,
  };
  const json = `${JSON.stringify(record, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, json, "utf8");
  return { path: filePath, relpath: rel(filePath), record };
}

function readReceipt(filePath, fail = defaultFail) {
  return parseJsonFile(filePath, "receipt", fail);
}

function latestReceipt(kind, ticket, options = {}) {
  const base = options.baseDir || receiptBaseDir(kind, options.coordDir || COORD_DIR);
  if (!fs.existsSync(base)) {
    return null;
  }
  const files = fs.readdirSync(base)
    .filter((name) => name.endsWith(".json") && name.includes(`-${safeSlug(ticket)}-`))
    .map((name) => path.join(base, name))
    .sort();
  return files.length ? files[files.length - 1] : null;
}

function validateLiveMcpReceipt(receipt, fail = defaultFail) {
  const operationClass = requireText(receipt.operation_class, "operation_class", fail);
  const policy = OPERATION_CLASSES[operationClass];
  if (!policy) {
    fail(`Unsupported operation_class "${operationClass}".`);
  }
  requireText(receipt.ticket, "ticket", fail);
  requireText(receipt.adapter, "adapter", fail);
  requireText(receipt.operation, "operation", fail);
  requireText(receipt.scope, "scope", fail);
  requireText(receipt.result, "result", fail);
  if (policy.redaction === "required") {
    requireText(receipt.redaction, "redaction", fail);
  }
  if (policy.approval !== "ticket") {
    requireText(receipt.approval, "approval", fail);
  }
  if (policy.cleanup) {
    requireText(receipt.cleanup, "cleanup", fail);
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
    fail("At least one evidence entry is required.");
  }
  return { ok: true, policy };
}

function normalizeLiveMcpReceipt(ticket, options = {}, fail = defaultFail) {
  const operationClass = requireText(options.operationClass || options.operation_class, "--class", fail);
  const receipt = {
    ticket: requireText(ticket || options.ticket, "ticket", fail),
    adapter: requireText(options.adapter, "--adapter", fail),
    operation_class: operationClass,
    operation: requireText(options.operation, "--operation", fail),
    scope: requireText(options.scope, "--scope", fail),
    redaction: optionalText(options.redaction),
    approval: optionalText(options.approval),
    cleanup: optionalText(options.cleanup),
    result: requireText(options.receiptResult || options.gateResult || options.result || "observed", "--receipt-result", fail),
    evidence: Array.isArray(options.evidence) ? options.evidence : options.evidence ? [options.evidence] : [],
    metadata: parseKeyValueList(options.meta, fail),
  };
  validateLiveMcpReceipt(receipt, fail);
  return receipt;
}

function validateDeployReceipt(receipt, fail = defaultFail) {
  requireText(receipt.ticket, "ticket", fail);
  requireText(receipt.environment, "environment", fail);
  requireText(receipt.landed_commit, "landed_commit", fail);
  requireText(receipt.build_source, "build_source", fail);
  requireText(receipt.artifact, "artifact", fail);
  requireText(receipt.running_artifact, "running_artifact", fail);
  requireText(receipt.deploy_id, "deploy_id", fail);
  requireText(receipt.operator, "operator", fail);
  requireText(receipt.rollback, "rollback", fail);
  return assertDeployIdentity(receipt, fail);
}

function assertDeployIdentity(receipt, fail = defaultFail) {
  const expected = String(receipt.artifact || "").trim();
  const running = String(receipt.running_artifact || "").trim();
  const landed = String(receipt.landed_commit || "").trim();
  const buildSource = String(receipt.build_source || "").trim();
  const problems = [];
  if (expected && running && expected !== running) {
    problems.push(`running_artifact (${running}) does not match artifact (${expected})`);
  }
  if (landed && buildSource && landed !== buildSource) {
    problems.push(`build_source (${buildSource}) does not match landed_commit (${landed})`);
  }
  if (problems.length > 0) {
    fail(`Deploy identity check failed: ${problems.join("; ")}.`);
  }
  return { ok: true, artifact: expected, commit: landed };
}

function normalizeDeployReceipt(ticket, options = {}, fail = defaultFail) {
  const receipt = {
    ticket: requireText(ticket || options.ticket, "ticket", fail),
    environment: requireText(options.environment || options.env, "--environment", fail),
    landed_commit: requireText(options.commit || options.landedCommit || options.landed_commit, "--commit", fail),
    build_source: requireText(options.buildSource || options.build_source || options.commit, "--build-source", fail),
    artifact: requireText(options.artifact, "--artifact", fail),
    running_artifact: requireText(options.runningArtifact || options.running_artifact || options.artifact, "--running-artifact", fail),
    deploy_id: requireText(options.deployId || options.deploy_id, "--deploy-id", fail),
    rollout_status: optionalText(options.status) || optionalText(options.receiptResult) || optionalText(options.gateResult) || "unknown",
    operator: requireText(options.operator || options.owner || process.env.USER || "unknown", "--operator", fail),
    rollback: requireText(options.rollback, "--rollback", fail),
    evidence: Array.isArray(options.evidence) ? options.evidence : options.evidence ? [options.evidence] : [],
    metadata: parseKeyValueList(options.meta, fail),
  };
  validateDeployReceipt(receipt, fail);
  return receipt;
}

function validateBootstrapReceipt(receipt, fail = defaultFail) {
  requireText(receipt.ticket, "ticket", fail);
  requireText(receipt.job, "job", fail);
  requireText(receipt.execution_mode, "execution_mode", fail);
  requireText(receipt.resource_envelope, "resource_envelope", fail);
  requireText(receipt.idempotency, "idempotency", fail);
  requireText(receipt.observability, "observability", fail);
  requireText(receipt.disable_or_rollback, "disable_or_rollback", fail);
  requireText(receipt.result, "result", fail);
  if (receipt.execution_mode === "api-startup") {
    fail("Server bootstrap jobs must not run heavy/risky work in api-startup mode.");
  }
  if (/marker after/i.test(String(receipt.idempotency || ""))) {
    fail("Idempotency must not rely on writing the marker only after work completes.");
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
    fail("At least one bootstrap evidence entry is required.");
  }
  return { ok: true };
}

function normalizeBootstrapReceipt(ticket, options = {}, fail = defaultFail) {
  const receipt = {
    ticket: requireText(ticket || options.ticket, "ticket", fail),
    job: requireText(options.job, "--job", fail),
    execution_mode: requireText(options.executionMode || options.execution_mode, "--execution-mode", fail),
    resource_envelope: requireText(options.resourceEnvelope || options.resource_envelope, "--resource-envelope", fail),
    idempotency: requireText(options.idempotency, "--idempotency", fail),
    query_shape: optionalText(options.queryShape || options.query_shape),
    observability: requireText(options.observability, "--observability", fail),
    disable_or_rollback: requireText(options.disableRollback || options.disable_or_rollback || options.rollback, "--disable-rollback", fail),
    result: requireText(options.receiptResult || options.gateResult || options.result || "observed", "--receipt-result", fail),
    evidence: Array.isArray(options.evidence) ? options.evidence : options.evidence ? [options.evidence] : [],
    metadata: parseKeyValueList(options.meta, fail),
  };
  validateBootstrapReceipt(receipt, fail);
  return receipt;
}

function validateRuntimeVerification(receipt, fail = defaultFail) {
  requireText(receipt.ticket, "ticket", fail);
  requireText(receipt.environment, "environment", fail);
  const evidenceClass = requireText(receipt.evidence_class, "evidence_class", fail);
  if (!EVIDENCE_CLASSES.has(evidenceClass)) {
    fail(`Unsupported evidence_class "${evidenceClass}".`);
  }
  const result = requireText(receipt.result, "result", fail);
  if (!RESULT_VALUES.has(result)) {
    fail(`Unsupported verification result "${result}".`);
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
    fail("At least one verification evidence entry is required.");
  }
  return { ok: true };
}

function normalizeRuntimeVerification(ticket, options = {}, fail = defaultFail) {
  const receipt = {
    ticket: requireText(ticket || options.ticket, "ticket", fail),
    environment: requireText(options.environment || options.env, "--environment", fail),
    evidence_class: requireText(options.evidenceClass || options.evidence_class, "--evidence-class", fail),
    result: requireText(options.receiptResult || options.gateResult || options.result || "observed", "--receipt-result", fail),
    claim: requireText(options.claim || options.summary, "--claim", fail),
    evidence: Array.isArray(options.evidence) ? options.evidence : options.evidence ? [options.evidence] : [],
    metadata: parseKeyValueList(options.meta, fail),
  };
  validateRuntimeVerification(receipt, fail);
  return receipt;
}

function validateFalsificationReceipt(receipt, fail = defaultFail) {
  requireText(receipt.ticket, "ticket", fail);
  requireText(receipt.falsified_by, "falsified_by", fail);
  requireText(receipt.reason, "reason", fail);
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
    fail("At least one falsification evidence entry is required.");
  }
  return { ok: true };
}

function normalizeFalsification(ticket, options = {}, fail = defaultFail) {
  const receipt = {
    ticket: requireText(ticket || options.ticket, "ticket", fail),
    falsified_by: requireText(options.by || options.falsifiedBy || options.falsified_by, "--by", fail),
    reason: requireText(options.reason, "--reason", fail),
    evidence: Array.isArray(options.evidence) ? options.evidence : options.evidence ? [options.evidence] : [],
    metadata: parseKeyValueList(options.meta, fail),
  };
  validateFalsificationReceipt(receipt, fail);
  return receipt;
}

function printRecordResult(result, options = {}) {
  const payload = {
    ok: true,
    path: result.relpath,
    receipt: result.record,
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Recorded ${result.record.kind} receipt: ${result.relpath}`);
  }
  return payload;
}

function printPolicy(options = {}) {
  const payload = {
    ok: true,
    operation_classes: OPERATION_CLASSES,
    evidence_classes: [...EVIDENCE_CLASSES].sort(),
    receipt_roots: {
      live_mcp: rel(receiptBaseDir("live-mcp")),
      deployment: rel(receiptBaseDir("deployment")),
      bootstrap: rel(receiptBaseDir("bootstrap")),
      runtime: rel(receiptBaseDir("runtime")),
      falsification: rel(receiptBaseDir("falsification")),
    },
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("Production/runtime evidence policy:");
    for (const [name, rule] of Object.entries(OPERATION_CLASSES)) {
      console.log(`- ${name}: approval=${rule.approval} redaction=${rule.redaction} cleanup=${rule.cleanup ? "required" : "not-required"}`);
    }
  }
  return payload;
}

function liveMcpRecord(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receipt = normalizeLiveMcpReceipt(ticket, options, fail);
  const result = writeReceipt("live-mcp", receipt.ticket, receipt.operation, receipt, {
    coordDir: deps.coordDir,
    timestamp: deps.timestamp,
  });
  return printRecordResult(result, options);
}

function deployRecord(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receipt = normalizeDeployReceipt(ticket, options, fail);
  const result = writeReceipt("deployment", receipt.ticket, receipt.deploy_id, receipt, {
    coordDir: deps.coordDir,
    timestamp: deps.timestamp,
  });
  return printRecordResult(result, options);
}

function deployCheck(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receiptFile = options.receipt
    ? path.resolve(ROOT_DIR, options.receipt)
    : latestReceipt("deployment", requireText(ticket || options.ticket, "ticket", fail), { coordDir: deps.coordDir });
  if (!receiptFile) {
    fail(`No deployment receipt found for ${ticket}.`);
  }
  const receipt = readReceipt(receiptFile, fail);
  const result = validateDeployReceipt(receipt, fail);
  const payload = { ok: true, path: rel(receiptFile), identity: result };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Deploy identity PASS: ${rel(receiptFile)}`);
  }
  return payload;
}

function bootstrapRecord(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receipt = normalizeBootstrapReceipt(ticket, options, fail);
  const result = writeReceipt("bootstrap", receipt.ticket, receipt.job, receipt, {
    coordDir: deps.coordDir,
    timestamp: deps.timestamp,
  });
  return printRecordResult(result, options);
}

function verifyRuntime(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receipt = normalizeRuntimeVerification(ticket, options, fail);
  const result = writeReceipt("runtime", receipt.ticket, receipt.claim, receipt, {
    coordDir: deps.coordDir,
    timestamp: deps.timestamp,
  });
  return printRecordResult(result, options);
}

function falsify(ticket, options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const receipt = normalizeFalsification(ticket, options, fail);
  const result = writeReceipt("falsification", receipt.ticket, receipt.falsified_by, receipt, {
    coordDir: deps.coordDir,
    timestamp: deps.timestamp,
  });
  return printRecordResult(result, options);
}

function validateReceiptCommand(options = {}, deps = {}) {
  const fail = deps.fail || defaultFail;
  const file = requireText(options.receipt || options.path, "--receipt", fail);
  const receipt = readReceipt(file, fail);
  switch (receipt.kind) {
    case "live-mcp":
      validateLiveMcpReceipt(receipt, fail);
      break;
    case "deployment":
      validateDeployReceipt(receipt, fail);
      break;
    case "bootstrap":
      validateBootstrapReceipt(receipt, fail);
      break;
    case "runtime":
      validateRuntimeVerification(receipt, fail);
      break;
    case "falsification":
      validateFalsificationReceipt(receipt, fail);
      break;
    default:
      fail(`Unsupported receipt kind "${receipt.kind}".`);
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const payload = { ok: true, kind: receipt.kind, ticket: receipt.ticket, digest };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Receipt validation PASS: ${file}`);
  }
  return payload;
}

module.exports = {
  EVIDENCE_CLASSES,
  OPERATION_CLASSES,
  assertDeployIdentity,
  bootstrapRecord,
  deployCheck,
  deployRecord,
  falsify,
  latestReceipt,
  liveMcpRecord,
  normalizeBootstrapReceipt,
  normalizeDeployReceipt,
  normalizeFalsification,
  normalizeLiveMcpReceipt,
  normalizeRuntimeVerification,
  printPolicy,
  readReceipt,
  validateBootstrapReceipt,
  validateDeployReceipt,
  validateFalsificationReceipt,
  validateLiveMcpReceipt,
  validateReceiptCommand,
  validateRuntimeVerification,
  verifyRuntime,
  writeReceipt,
  __testing: {
    parseKeyValueList,
    receiptPath,
    safeSlug,
  },
};
