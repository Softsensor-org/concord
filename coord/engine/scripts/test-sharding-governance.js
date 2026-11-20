"use strict";

// COORD-900 donor-side comparison and receipt helpers. Cut runners are never
// trusted to read mutable governance state; only the donor wrapper can issue a
// receipt after validating the live board and journal.
const fs = require("node:fs");
const crypto = require("node:crypto");
const runManifest = require("./run-manifest.js");

const KEY = "test_sharding";
const REQUIRED_COMPARISONS = Object.freeze(["test_identity", "outcome", "coverage_findings"]);
const canonical = runManifest.canonicalJson;
const digest = (value) => runManifest.digestOf(value);
const fileDigest = (file) => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;

function readEvidence(reportPath, manifestPath, { allowFailed = false, qualificationMode = "full" } = {}) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestErrors = runManifest.validateManifest(manifest);
  if (manifestErrors.length) throw new Error(`invalid run manifest: ${manifestErrors.join("; ")}`);
  const artifact = manifest.artifacts.find((entry) => entry.path === reportPath);
  if (!artifact || artifact.sha256 !== fileDigest(reportPath)) throw new Error("run manifest does not bind the exact report bytes");
  if (!report || report.tool !== "coord/scripts/test-runner.js" || !["pass", "fail"].includes(report.suite_result) || !["pass", "fail", "provisional"].includes(report.result)) throw new Error("runner report is missing or malformed");
  const coverageValid = qualificationMode === "selection"
    ? report.engine_coverage?.ratchet == null
    : report.engine_coverage?.ratchet?.result === "pass";
  if (!allowFailed && (report.suite_result !== "pass" || !["pass", "provisional"].includes(report.result) || !coverageValid)) {
    throw new Error(`runner report is not passing ${qualificationMode} sharding evidence`);
  }
  return { report, manifest, report_digest: artifact.sha256, manifest_digest: fileDigest(manifestPath) };
}

function inventoryOf(report) {
  const paths = (report.inventory || []).flatMap((module) => module.files || []).map(String).sort();
  return paths;
}

function outcomesOf(report) {
  const rows = [];
  for (const module of report.results || []) {
    for (const item of module.test_outcomes || []) {
      rows.push({ suite_module: module.module, identity: item.identity, outcome: item.outcome });
    }
  }
  rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return rows;
}

function coverageOf(report) {
  const coverage = report.engine_coverage;
  if (!coverage || !coverage.measurement || !coverage.ratchet) throw new Error("coverage measurement or ratchet is missing");
  return { measurement: coverage.measurement, ratchet: coverage.ratchet };
}

function compareReports({ serialReport, serialManifest, shardedReport, shardedManifest }) {
  const serial = readEvidence(serialReport, serialManifest, { allowFailed: true });
  const sharded = readEvidence(shardedReport, shardedManifest, { allowFailed: true });
  const mismatches = [];
  const a = serial.manifest.inputs;
  const b = sharded.manifest.inputs;
  for (const field of ["source.commit", "source.tree", "source.base", "policy.digest", "edition", "toolchain.node"]) {
    const get = (obj) => field.split(".").reduce((value, key) => value?.[key], obj);
    if (get(a) !== get(b)) mismatches.push({ field: `manifest.inputs.${field}`, serial: get(a) ?? null, sharded: get(b) ?? null });
  }
  if (a.source?.dirty || b.source?.dirty) mismatches.push({ field: "manifest.inputs.source.dirty", serial: a.source?.dirty, sharded: b.source?.dirty });
  if (serial.report.suite_result !== "pass" || serial.report.result !== "pass") mismatches.push({ field: "serial_run_result", result: serial.report.result, suite_result: serial.report.suite_result });
  if (sharded.report.suite_result !== "pass" || !["pass", "provisional"].includes(sharded.report.result)) mismatches.push({ field: "sharded_run_result", result: sharded.report.result, suite_result: sharded.report.suite_result });
  const serialInventory = inventoryOf(serial.report);
  const shardedInventory = inventoryOf(sharded.report);
  if (!serialInventory.length || !shardedInventory.length || new Set(serialInventory).size !== serialInventory.length || new Set(shardedInventory).size !== shardedInventory.length) {
    mismatches.push({ field: "suite_inventory_integrity", serial_count: serialInventory.length, sharded_count: shardedInventory.length });
  }
  if (canonical(serialInventory) !== canonical(shardedInventory)) mismatches.push({ field: "suite_inventory", serial: digest(serialInventory), sharded: digest(shardedInventory) });
  const serialOutcomes = outcomesOf(serial.report);
  const shardedOutcomes = outcomesOf(sharded.report);
  if (!serialOutcomes.length || !shardedOutcomes.length || new Set(serialOutcomes.map(canonical)).size !== serialOutcomes.length || new Set(shardedOutcomes.map(canonical)).size !== shardedOutcomes.length) {
    mismatches.push({ field: "test_identity_integrity", serial_count: serialOutcomes.length, sharded_count: shardedOutcomes.length });
  }
  if (canonical(serialOutcomes) !== canonical(shardedOutcomes)) mismatches.push({ field: "test_identity_outcome", serial: digest(serialOutcomes), sharded: digest(shardedOutcomes) });
  const serialCoverage = serial.report.engine_coverage ? coverageOf(serial.report) : null;
  const shardedCoverage = sharded.report.engine_coverage ? coverageOf(sharded.report) : null;
  if (!serialCoverage || !shardedCoverage || canonical(serialCoverage) !== canonical(shardedCoverage)) mismatches.push({ field: "coverage_findings", serial: serialCoverage ? digest(serialCoverage) : null, sharded: shardedCoverage ? digest(shardedCoverage) : null });
  if (serial.report.engine_coverage?.ratchet?.result !== "pass") mismatches.push({ field: "serial_coverage_ratchet", result: serial.report.engine_coverage?.ratchet?.result || "missing" });
  if (sharded.report.engine_coverage?.ratchet?.result !== "pass") mismatches.push({ field: "sharded_coverage_ratchet", result: sharded.report.engine_coverage?.ratchet?.result || "missing" });
  if (!Array.isArray(sharded.report.shards) || !sharded.report.shards.length || sharded.report.shards.some((shard) => shard.result !== "pass")) {
    mismatches.push({ field: "shard_outcomes", reason: "missing or failing shard" });
  }
  return {
    matched: mismatches.length === 0,
    mismatches,
    identity: { commit: a.source?.commit || null, tree: a.source?.tree || null, policy_digest: a.policy.digest,
      edition: a.edition, node_version: a.toolchain.node },
    evidence: {
      serial_report: serial.report_digest, serial_manifest: serial.manifest_digest,
      sharded_report: sharded.report_digest, sharded_manifest: sharded.manifest_digest,
      inventory_digest: digest(serialInventory), test_outcomes_digest: digest(serialOutcomes), coverage_digest: digest(serialCoverage),
    },
    compared: REQUIRED_COMPARISONS,
  };
}

function comparisonId(comparison, at) { return digest({ comparison, at }); }

function updateBoardState(board, comparison, { at = new Date().toISOString(), id = comparisonId(comparison, at) } = {}) {
  if (!board || typeof board !== "object") throw new Error("governance board is unavailable");
  board.metadata ||= {};
  const current = board.metadata[KEY] || { comparisons: [], suspension: { active: false, reason: null, comparison_id: null } };
  const record = { id, at, ...comparison };
  const next = { ...current, comparisons: [...(current.comparisons || []), record] };
  if (!comparison.matched) {
    next.suspension = { active: true, reason: "serial/sharded mismatch", comparison_id: id,
      evidence_digest: digest(comparison.evidence), since: at };
  }
  board.metadata[KEY] = next;
  return { state: next, comparison: record };
}

function authorityState(board) {
  const state = board?.metadata?.[KEY];
  if (!state) return { allowed: true, reason: "no mismatch suspension recorded", evidence_pending: true };
  if (state.suspension?.active) return { allowed: false, reason: state.suspension.reason, suspension: state.suspension };
  return { allowed: true, reason: "no mismatch suspension recorded", evidence_pending: !(state.comparisons || []).some((entry) => entry.matched) };
}

function createReceipt({ reportPath, manifestPath, skipLogDir = null, stage = "release", qualificationMode = "full", qualificationPlan = null, board, policy, journalEvents, eventDigest, verifyJournal = () => true,
  verifyCutInventory = null }) {
  const checked = readEvidence(reportPath, manifestPath, { qualificationMode });
  const authorization = authorityState(board);
  if (!authorization.allowed) throw new Error(`sharded result refused: donor suspension is active (${authorization.reason})`);
  const shardingPolicy = policy?.sharding;
  if (shardingPolicy?.authoritative !== true || shardingPolicy.scope !== "resolved-policy-plan" ||
      shardingPolicy.comparison?.mismatch_action !== "fail-qualification-and-automatically-suspend" ||
      shardingPolicy.comparison?.comparison_execution !== "donor-journaled-transaction" ||
      shardingPolicy.comparison?.first_sharded_run_requires_same_tree_serial_comparison !== false) {
    throw new Error("sharded result refused: current donor policy does not authorize full-gate sharding");
  }
  const argv = checked.report.argv || [];
  if (!new Set(["developer", "pr", "nightly", "promotion", "release"]).has(stage) || checked.report.result !== "provisional" || !String(checked.report.qualification).includes("donor receipt required") ||
      !argv.includes("--qualification-stage") || argv[argv.indexOf("--qualification-stage") + 1] !== stage ||
      !argv.includes("--qualification-mode") || argv[argv.indexOf("--qualification-mode") + 1] !== qualificationMode ||
      !argv.includes("--shards") ||
      !Array.isArray(checked.report.shards) || checked.report.shards.length === 0 || checked.report.shards.some((item) => item.result !== "pass")) {
    throw new Error(`sharded result refused: ${stage} report lacks matching provisional shard execution`);
  }
  const expectedEdition = checked.manifest.inputs.edition;
  const allowedEditions = stage === "release" ? ["Community", "Enterprise"] : ["donor"];
  if (!allowedEditions.includes(expectedEdition) || runManifest.detectEdition(checked.report.workspace_root) !== expectedEdition || !checked.report.inventory?.length) {
    throw new Error(`sharded result refused: ${stage} edition or full inventory is missing`);
  }
  if (stage !== "release") {
    const stageMatches = qualificationPlan?.base_stage === stage &&
      argv.includes("--policy-stage") && argv[argv.indexOf("--policy-stage") + 1] === qualificationPlan?.stage;
    const fullCheck = qualificationPlan?.checks?.some((item) => item.id === "full-suite" && item.args?.includes("--engine-coverage"));
    const selectedSuites = [...new Set((qualificationPlan?.checks || []).filter((item) => Array.isArray(item.suites)).flatMap((item) => item.suites))].sort();
    if (!stageMatches) throw new Error(`sharded result refused: ${stage} is not bound to the exact resolved policy stage`);
    if (qualificationMode === "full") {
      const stageEligible = stage === "pr"
        ? qualificationPlan?.selection?.tier === "T2" || (qualificationPlan?.selection?.fallback_reasons || []).length > 0 || qualificationPlan?.selection?.would_gate === "full"
        : ["nightly", "promotion"].includes(stage) && qualificationPlan?.qualifies === true;
      if (!fullCheck || !stageEligible || !checked.report.engine_coverage?.ratchet || checked.report.engine_coverage.ratchet.result !== "pass") {
        throw new Error(`sharded result refused: ${stage} lacks an eligible full plan and aggregate coverage ratchet`);
      }
    } else if (qualificationMode === "selection") {
      const assigned = checked.report.shards.flatMap((item) => item.assigned || []).map(String).sort();
      if (!["developer", "pr"].includes(stage) || qualificationPlan?.decision !== "selected" || !qualificationPlan.selection || fullCheck ||
          !selectedSuites.length || canonical(selectedSuites) !== canonical(assigned) || new Set(assigned).size !== assigned.length ||
          argv.includes("--engine-coverage") || checked.report.engine_coverage?.ratchet) {
        throw new Error("sharded result refused: selected-mode receipt does not match the exact selected-plus-mandatory suite set without a whole-suite ratchet");
      }
    } else {
      throw new Error(`sharded result refused: unsupported qualification mode ${qualificationMode}`);
    }
  } else if (qualificationPlan) {
    throw new Error("sharded release receipt does not accept a donor test-policy plan; cut inventory is its qualification plan");
  }
  const { spawnSync } = require("node:child_process");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: checked.report.workspace_root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`sharded result refused: cannot verify cut Git identity (${result.stderr || result.error?.message || result.status})`);
    return result.stdout.trim();
  };
  if (git(["rev-parse", "HEAD"]) !== checked.manifest.inputs.source.commit ||
      git(["rev-parse", "HEAD^{tree}"]) !== checked.manifest.inputs.source.tree ||
      (stage === "promotion" && checked.manifest.inputs.source.dirty)) {
    throw new Error("sharded result refused: report manifest is not bound to the exact clean cut tree");
  }
  const donorPolicyFile = require("node:path").resolve(__dirname, "../test-policy.json");
  const policyEntry = checked.manifest.inputs.policy.files.find((entry) => entry.path === "coord/engine/test-policy.json");
  if (!policyEntry || policyEntry.sha256 !== fileDigest(donorPolicyFile)) throw new Error("sharded result refused: cut manifest policy does not match the current donor policy");
  if (stage === "release") {
    const inventoryCheck = verifyCutInventory
      ? verifyCutInventory(checked.report, { reportPath, skipLogDir })
      : require(require("node:path").resolve(__dirname, "../../../release/suite-inventory.js")).verifySuiteInventory({
        artifact: checked.report.workspace_root, reportPath, skipLogDir,
        manifestFile: require("node:path").resolve(__dirname, "../../../release/suite-inventory.json"), allowProvisional: true });
    if (!inventoryCheck?.ok) throw new Error(`sharded result refused: exact cut inventory did not verify (${(inventoryCheck?.problems || []).join("; ")})`);
  } else if (qualificationMode === "full") {
    const inventory = inventoryOf(checked.report);
    const assigned = checked.report.shards.flatMap((item) => item.assigned || []).map(String).sort();
    if (!inventory.length || new Set(inventory).size !== inventory.length || canonical(inventory) !== canonical(assigned) || new Set(assigned).size !== assigned.length) {
      throw new Error("sharded result refused: promotion report does not assign the complete inventory exactly once");
    }
  }
  if (!verifyJournal(journalEvents)) throw new Error("sharded result refused: donor journal chain is invalid");
  const source = checked.manifest.inputs.source;
  const proof = [...(board.metadata[KEY]?.comparisons || [])].reverse().find((item) => item.matched &&
    item.identity.tree === source.tree && item.identity.commit === source.commit &&
    item.identity.policy_digest === checked.manifest.inputs.policy.digest && item.identity.edition === checked.manifest.inputs.edition &&
    item.identity.node_version === checked.manifest.inputs.toolchain.node);
  const journalEvent = journalEvents.at(-1);
  if (!journalEvent) throw new Error("sharded result refused: donor journal has no current event to bind");
  const receipt = { schema: "coord.shard-authority-receipt/v1", tree: source.tree, commit: source.commit,
    policy_digest: checked.manifest.inputs.policy.digest, edition: checked.manifest.inputs.edition, node_version: checked.manifest.inputs.toolchain.node,
    authority_source: "versioned-donor-policy", authority_policy_digest: digest(shardingPolicy),
    stage, qualification_mode: qualificationMode, qualification_plan_digest: qualificationPlan ? digest(qualificationPlan) : null,
    comparison_id: proof?.id || null, journal_head_digest: eventDigest(journalEvent), report_digest: checked.report_digest,
    manifest_digest: checked.manifest_digest, issued_at: new Date().toISOString() };
  receipt.receipt_digest = digest(receipt);
  return receipt;
}

function verifyReceipt({ receipt, reportPath, manifestPath, stage = receipt?.stage || "release", qualificationMode = receipt?.qualification_mode || "full", qualificationPlan = null, board, policy, journalEvents, eventDigest, verifyJournal = () => true, verifyCutInventory = null }) {
  if (!receipt || receipt.schema !== "coord.shard-authority-receipt/v1") throw new Error("invalid or missing sharded authority receipt");
  const { receipt_digest: claimed, ...unsigned } = receipt;
  if (claimed !== digest(unsigned)) throw new Error("sharded authority receipt digest mismatch");
  const rebuilt = createReceipt({ reportPath, manifestPath, stage, qualificationMode, qualificationPlan, board, policy, journalEvents, eventDigest, verifyJournal, verifyCutInventory });
  for (const key of ["stage", "qualification_mode", "qualification_plan_digest", "tree", "commit", "policy_digest", "edition", "node_version", "authority_source", "authority_policy_digest", "comparison_id", "journal_head_digest", "report_digest", "manifest_digest"]) {
    if (receipt[key] !== rebuilt[key]) throw new Error(`sharded authority receipt is stale or mismatched: ${key}`);
  }
  return true;
}

module.exports = { KEY, REQUIRED_COMPARISONS, compareReports, comparisonId, updateBoardState, authorityState, createReceipt, verifyReceipt, outcomesOf, inventoryOf };
