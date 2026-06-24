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

  if (inputs.deploySmokeUrl) artifactPaths.push(inputs.deploySmokeUrl);

  return finalize(target, checks, artifactPaths);
}

function finalize(target, checks, artifactPaths) {
  const failed = checks.filter((c) => c.result === "fail");
  return {
    gateProc: "infra",
    track: "devops",
    target,
    result: failed.length === 0 ? "pass" : "fail",
    checks,
    artifact_paths: artifactPaths,
    summary:
      failed.length === 0
        ? `infra gate pass: ${checks.length} check(s) ok`
        : `infra gate fail: ${failed.length}/${checks.length} check(s) failed`,
  };
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
  const inputs = {
    target: options.target,
    deploySmokeUrl: options.deploySmokeUrl,
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
  main,
};
