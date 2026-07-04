"use strict";

// COORD-183: gate-proc for the DEVOPS track.
//
// Where the marketing `content` gate (content-gate.js / COORD-182) gates on
// static-site integrity, the devops `infra` gate gates on DEPLOYMENT-CONFIG
// INTEGRITY for the Azure Static Web App: the staticwebapp.config.json must
// parse and define routing, must ship hardening headers (HSTS + CSP), and the
// CI workflow must actually invoke the SWA deploy action. The post-deploy smoke
// check is surfaced as a skip — the engine is pure and offline and never makes
// network calls.
//
// Per the track contract in coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md,
// this emits a track-gate report in the shared shape used by the other
// gate-procs (analytics-gate.js, content-gate.js).

const fs = require("fs");
const { shapeGateResult } = require("./gate-result.js");

// ---- pure helpers ---------------------------------------------------------

// Accept either a parsed object or a raw JSON string; return { config, error }.
function coerceConfig(input) {
  if (input && typeof input === "object") return { config: input, error: null };
  if (typeof input === "string") {
    try {
      return { config: JSON.parse(input), error: null };
    } catch (err) {
      return { config: null, error: err && err.message ? err.message : String(err) };
    }
  }
  return { config: null, error: "no staticwebapp.config.json provided" };
}

// globalHeaders may be expressed with any casing; normalize keys for lookup.
function headerKeys(config) {
  const gh = config && config.globalHeaders;
  if (!gh || typeof gh !== "object") return new Set();
  return new Set(Object.keys(gh).map((k) => k.toLowerCase()));
}

// ---- per-check evaluation (pure) -----------------------------------------

function checkSwaConfigValid(config, parseError) {
  if (parseError) {
    return { name: "swa_config_valid", result: "fail", detail: `staticwebapp.config.json did not parse: ${parseError}` };
  }
  if (!config || typeof config !== "object") {
    return { name: "swa_config_valid", result: "fail", detail: "staticwebapp.config.json is empty or not an object." };
  }
  const hasRoutes = Array.isArray(config.routes);
  const hasFallback = !!config.navigationFallback;
  if (!hasRoutes && !hasFallback) {
    return {
      name: "swa_config_valid",
      result: "fail",
      detail: 'config has neither "routes" nor "navigationFallback".',
    };
  }
  return {
    name: "swa_config_valid",
    result: "pass",
    detail: `config parses with ${hasRoutes ? "routes" : ""}${hasRoutes && hasFallback ? " + " : ""}${hasFallback ? "navigationFallback" : ""}.`,
  };
}

function checkSecurityHeaders(config, parseError) {
  if (parseError || !config) {
    return { name: "security_headers", result: "fail", detail: "cannot inspect headers: config unavailable." };
  }
  const keys = headerKeys(config);
  const missing = [];
  if (!keys.has("strict-transport-security")) missing.push("Strict-Transport-Security");
  if (!keys.has("content-security-policy")) missing.push("Content-Security-Policy");
  return missing.length === 0
    ? { name: "security_headers", result: "pass", detail: "globalHeaders include HSTS and CSP." }
    : { name: "security_headers", result: "fail", detail: `missing globalHeaders: ${missing.join(", ")}` };
}

function checkWorkflowDeployStep(workflowText) {
  if (typeof workflowText !== "string" || workflowText.trim() === "") {
    return { name: "workflow_deploy_step", result: "fail", detail: "no workflow text provided." };
  }
  return workflowText.includes("Azure/static-web-apps-deploy")
    ? { name: "workflow_deploy_step", result: "pass", detail: "workflow invokes Azure/static-web-apps-deploy." }
    : {
        name: "workflow_deploy_step",
        result: "fail",
        detail: "workflow does not reference the Azure/static-web-apps-deploy action.",
      };
}

function checkDeploySmoke(deploySmokeUrl) {
  return deploySmokeUrl
    ? { name: "deploy_smoke", result: "skip", detail: "run smoke against preview" }
    : { name: "deploy_smoke", result: "skip", detail: "no deploySmokeUrl provided; run smoke against preview" };
}

function enterpriseRequired(inputs = {}) {
  return Boolean(
    inputs.enterpriseRequired ||
    inputs.enterpriseConfig?.required ||
    inputs.deploymentEvidence?.enterprise_required
  );
}

function deploymentEvidence(inputs = {}) {
  return inputs.deploymentEvidence && typeof inputs.deploymentEvidence === "object"
    ? inputs.deploymentEvidence
    : {};
}

function checkEnterpriseOptIn(inputs) {
  if (enterpriseRequired(inputs)) {
    return { name: "enterprise_deployment_policy", result: "pass", detail: "enterprise deployment proof is required." };
  }
  if (inputs.deploymentEvidence || inputs.enterpriseConfig) {
    return { name: "enterprise_deployment_policy", result: "pass", detail: "enterprise deployment evidence supplied; evaluating optional hardening checks." };
  }
  return { name: "enterprise_deployment_policy", result: "skip", detail: "no enterprise deployment policy supplied; scaffold-only infra gate." };
}

function evidencePass(name, ok, passDetail, failDetail, required) {
  if (ok) return { name, result: "pass", detail: passDetail };
  return required
    ? { name, result: "fail", detail: failDetail }
    : { name, result: "skip", detail: failDetail };
}

function checkDeployIdentity(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(evidence.deploy_identity || evidence.operator || evidence.actor);
  return evidencePass(
    "deploy_identity",
    ok,
    `deploy identity recorded: ${evidence.deploy_identity || evidence.operator || evidence.actor}`,
    "deploy identity absent.",
    enterpriseRequired(inputs)
  );
}

function checkArtifactIdentity(inputs) {
  const evidence = deploymentEvidence(inputs);
  const landed = evidence.landed_commit || evidence.landedCommit;
  const deployed = evidence.deployed_commit || evidence.deployedCommit || evidence.deployed_artifact_commit;
  const ok = evidence.artifact_matches_commit === true || (landed && deployed && String(landed) === String(deployed));
  return evidencePass(
    "artifact_identity",
    ok,
    landed && deployed ? `deployed artifact commit matches landed commit ${landed}` : "artifact identity marked verified.",
    "deployed artifact is not proven to equal the landed commit.",
    enterpriseRequired(inputs)
  );
}

function looksLikeLiteralSecret(text) {
  return /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_+/.=-]{12,}/i.test(String(text || ""));
}

function checkSecretReferences(inputs) {
  const evidence = deploymentEvidence(inputs);
  const configText = [
    inputs.manifestText,
    inputs.workflowText,
    JSON.stringify(inputs.enterpriseConfig || {}),
  ].join("\n");
  const ok = evidence.secret_refs_only === true || (!looksLikeLiteralSecret(configText) && Boolean(evidence.secret_store_ref || evidence.secretKeyRef));
  return evidencePass(
    "secret_references",
    ok,
    "deploy configuration uses secret references, not literal secrets.",
    "secret references not proven, or a literal secret-like value appears in config.",
    enterpriseRequired(inputs)
  );
}

function checkSecretStoreKms(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(
    evidence.secret_store_ref ||
    evidence.secretStoreRef ||
    evidence.kms_key_ref ||
    evidence.kmsKeyRef
  );
  return evidencePass(
    "secret_store_kms",
    ok,
    "secret-store/KMS reference recorded.",
    "secret-store/KMS reference absent.",
    enterpriseRequired(inputs)
  );
}

function checkEnvironmentDiff(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(evidence.environment_diff_reviewed || evidence.env_diff_reviewed || evidence.environment_diff);
  return evidencePass(
    "environment_diff",
    ok,
    "environment diff reviewed.",
    "environment diff review absent.",
    enterpriseRequired(inputs)
  );
}

function checkIamNetworkPolicy(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(evidence.iam_policy_reviewed || evidence.iamPolicyReviewed) &&
    Boolean(evidence.network_policy_reviewed || evidence.networkPolicyReviewed);
  return evidencePass(
    "iam_network_policy",
    ok,
    "IAM and network-policy guardrails reviewed.",
    "IAM and network-policy guardrails not both reviewed.",
    enterpriseRequired(inputs)
  );
}

function checkRollbackPath(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(evidence.rollback_path || evidence.rollbackPath || evidence.disable_switch);
  return evidencePass(
    "rollback_path",
    ok,
    "rollback/disable path recorded.",
    "rollback/disable path absent.",
    enterpriseRequired(inputs)
  );
}

function checkRuntimeSmoke(inputs) {
  const evidence = deploymentEvidence(inputs);
  const ok = Boolean(evidence.runtime_smoke || evidence.runtimeSmoke || evidence.deploy_smoke || inputs.deploySmokeUrl);
  return evidencePass(
    "runtime_smoke",
    ok,
    "post-land runtime smoke/verify evidence recorded.",
    "post-land runtime smoke/verify evidence absent.",
    enterpriseRequired(inputs)
  );
}

function enterpriseDeploymentChecks(inputs = {}) {
  const checks = [checkEnterpriseOptIn(inputs)];
  if (checks[0].result === "skip") {
    return checks;
  }
  checks.push(checkDeployIdentity(inputs));
  checks.push(checkArtifactIdentity(inputs));
  checks.push(checkSecretReferences(inputs));
  checks.push(checkSecretStoreKms(inputs));
  checks.push(checkEnvironmentDiff(inputs));
  checks.push(checkIamNetworkPolicy(inputs));
  checks.push(checkRollbackPath(inputs));
  checks.push(checkRuntimeSmoke(inputs));
  return checks;
}

// ---- core pure evaluation -------------------------------------------------

// evaluateInfra(inputs) -> report
// inputs: { staticwebappConfig (object|string), workflowText (string),
//           deploySmokeUrl?, target? }
function evaluateInfra(inputs = {}) {
  const target = inputs.target || "static-web-app";
  const checks = [];
  const artifactPaths = [];

  const { config, error } = coerceConfig(inputs.staticwebappConfig);

  checks.push(checkSwaConfigValid(config, error));
  checks.push(checkSecurityHeaders(config, error));
  checks.push(checkWorkflowDeployStep(inputs.workflowText));
  checks.push(checkDeploySmoke(inputs.deploySmokeUrl));
  checks.push(...enterpriseDeploymentChecks(inputs));

  if (inputs.deploySmokeUrl) artifactPaths.push(inputs.deploySmokeUrl);
  if (inputs.deploymentEvidence?.receipt_path) artifactPaths.push(inputs.deploymentEvidence.receipt_path);

  return finalize(target, checks, artifactPaths);
}

function finalize(target, checks, artifactPaths) {
  // COORD-279: shared gate-result shaping (was an inlined duplicate of the
  // analytics/content blocks).
  return shapeGateResult({
    gateProc: "infra",
    track: "devops",
    subject: { target },
    checks,
    artifactPaths,
  });
}

// ---- fs loaders (thin layer over the pure core) --------------------------

// loadConfig(configPath) -> raw string (left unparsed so a malformed file is
// surfaced by the swa_config_valid check rather than throwing here).
function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return undefined;
  return fs.readFileSync(configPath, "utf8");
}

function loadWorkflow(workflowPath) {
  if (!workflowPath || !fs.existsSync(workflowPath)) return undefined;
  return fs.readFileSync(workflowPath, "utf8");
}

// runInfraGate({ configPath?, staticwebappConfig?, workflowPath?, workflowText?, deploySmokeUrl?, target? })
function runInfraGate(options = {}) {
  let deploymentEvidence = options.deploymentEvidence;
  if (!deploymentEvidence && options.deployReceiptPath && fs.existsSync(options.deployReceiptPath)) {
    deploymentEvidence = JSON.parse(fs.readFileSync(options.deployReceiptPath, "utf8"));
  }
  const inputs = {
    target: options.target,
    deploySmokeUrl: options.deploySmokeUrl,
    enterpriseRequired: options.enterpriseRequired,
    enterpriseConfig: options.enterpriseConfig,
    deploymentEvidence,
    manifestText: options.manifestText,
    staticwebappConfig:
      options.staticwebappConfig !== undefined ? options.staticwebappConfig : loadConfig(options.configPath),
    workflowText: options.workflowText !== undefined ? options.workflowText : loadWorkflow(options.workflowPath),
  };
  return evaluateInfra(inputs);
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--config") out.configPath = argv[++i];
    else if (a === "--workflow") out.workflowPath = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--smoke-url") out.deploySmokeUrl = argv[++i];
    else if (a === "--enterprise-required") out.enterpriseRequired = true;
    else if (a === "--deploy-receipt") out.deployReceiptPath = argv[++i];
    else if (!out.configPath && !a.startsWith("--")) out.configPath = a;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.configPath && args.staticwebappConfig === undefined) {
    process.stderr.write(
      "usage: node infra-gate.js --config <staticwebapp.config.json> --workflow <deploy.yml> [--smoke-url <url>] [--json]\n"
    );
    process.exit(2);
  }
  const report = runInfraGate(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${report.summary}\n`);
    for (const c of report.checks) {
      process.stdout.write(`  [${c.result}] ${c.name}: ${c.detail}\n`);
    }
  }
  process.exit(report.result === "pass" ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateInfra,
  loadConfig,
  loadWorkflow,
  runInfraGate,
  enterpriseDeploymentChecks,
  main,
};
