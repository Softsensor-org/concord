"use strict";
const { resolveEngineModule } = require("../../paths.js");
const { loadShimRegistry } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const { gitTry: defaultGitTry } = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const { defaultControlPlaneLayout, manifestPathForCoordRepoPath } = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js"));
const { DEFAULT_CONFIG } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));
// COORD-957: the budget decision and refusal wording are shared with the arch-checks gate.
const { highWaterOf, maxLocOf, shouldCheckProductionModuleLoc, budgetFor, productionLocExcess, measuredRefusalText, declaredRefusalText } = require("./prodloc-budget.js");
const { previewIntegrationTree } = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/landing-decision-packet.js"));
// COORD-976: the engine ratchet (guard, production module and LOC counts) is decided here too.
const { evaluateRatchet, measureEngine, isEngineProductionModule, GUARDS_REL, RATCHET_REL } = require("./architecture-audit.js");

// Reads a blob at a revision; null when the path is absent there.
function blobAt(gitTry, root, rev, rel) {
  const result = gitTry(root, ["show", `${rev}:${rel}`], { maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout || "") : null;
}

function parseRatchet(text, label) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

// COORD-913: a trusted legacy budget follows a file only through a registered shim move
// (coord/engine/shim-registry.json) or a git rename, and only at the trusted legacy number.
// A candidate's own declared number is data read from the candidate tree: it may equal or
// undercut the carried budget, never exceed it. Any other path gets the default budget.
function carriedMoves({ git, head, tree, layout, shims, needRenames }) {
  const prefix = layout.coordPathPrefix ? `${layout.coordPathPrefix}/` : "";
  const carried = new Map();
  for (const shim of shims) {
    if (!shim || typeof shim.path !== "string" || typeof shim.target !== "string") continue;
    if (!shim.target.startsWith("engine/scripts/")) continue;
    carried.set(`${prefix}${shim.target}`, { from: `${prefix}${shim.path}`, kind: "registered shim" });
  }
  if (!needRenames) return carried;
  const parts = git(["diff-tree", "-r", "-M", "-z", "--name-status", head, tree]).split("\0").filter(Boolean);
  for (let i = 0; i < parts.length;) {
    if (parts[i].startsWith("R")) {
      if (!carried.has(parts[i + 2])) carried.set(parts[i + 2], { from: parts[i + 1], kind: "git rename" });
      i += 3;
    } else i += 2;
  }
  return carried;
}

// The candidate's arch-checks highWater literal, parsed as text from its immutable blob (never executed).
function parseDeclaredBudgets(text) {
  const declared = new Map();
  const start = text.indexOf("highWater: Object.freeze({");
  if (start < 0) return declared;
  const end = text.indexOf("})", start);
  // guard:production-loc-budget
  if (end < 0) throw new Error("Production LOC closeout refused: unterminated highWater budget declaration.");
  for (const match of text.slice(start, end).matchAll(/"([^"\n]+)"\s*:\s*(\d+)/g)) declared.set(match[1], Number(match[2]));
  return declared;
}

// Read immutable Git objects using the running, trusted engine's checker and
// budgets. Candidate source (including a changed checker) is never executed.
// Preview objects have no refs and are not delivery commits or board evidence.
// guard:production-loc-budget
function assertProductionLocForCloseout(ticketId, { layout = defaultControlPlaneLayout(), branches = [], gitTry = defaultGitTry,
  trustedConfig = DEFAULT_CONFIG.checks.prodloc, shimRegistry = loadShimRegistry(ENGINE_COORD_DIR).shims } = {}) {
  const root = layout?.coordRepoRoot;
  if (!root) throw new Error(`Ticket ${ticketId} prodloc closeout refused: no control-plane Git repository.`);
  function git(args, options = {}) {
    const result = gitTry(root, args, { maxBuffer: 32 * 1024 * 1024, ...options });
    if (result.status !== 0) throw new Error(`Ticket ${ticketId} prodloc closeout refused: Git ${args[0]} could not verify the integration tree. ${String(result.stderr || "").trim()}`);
    return String(result.stdout || "");
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const tips = branches.map((branch) => git(["rev-parse", "--verify", `${branch}^{commit}`]).trim());
  const tree = previewIntegrationTree(git, head, tips, { message: "Unreferenced production LOC validation preview",
    onInvalidTree: () => { throw new Error(`Ticket ${ticketId} prodloc closeout refused: invalid merge preview tree.`); } });
  const trusted = highWaterOf(trustedConfig);
  const maxLoc = maxLocOf(trustedConfig);
  const prefixes = ["scripts", "engine/scripts"].map((dir) => (layout.coordPathPrefix ? `${layout.coordPathPrefix}/${dir}` : dir)); // COORD-871: engine budgets too
  const coordPrefix = layout.coordPathPrefix ? `${layout.coordPathPrefix}/` : "";
  const entries = git(["ls-tree", "-rz", "--full-tree", tree, "--", ...prefixes]).split("\0").filter(Boolean);
  const items = [];
  const present = new Set();
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error(`Ticket ${ticketId} prodloc closeout refused: invalid Git tree entry.`);
    const [, mode, type, object, repoPath] = match;
    const file = manifestPathForCoordRepoPath(layout, repoPath);
    present.add(file);
    if (!shouldCheckProductionModuleLoc(file, trustedConfig)) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`Ticket ${ticketId} prodloc closeout refused: ${file} must be a regular production source file, not a link.`);
    }
    items.push({ file, object });
  }
  // Rename detection runs only when a trusted legacy (coord/scripts/) budget has no file at its key.
  const needRenames = Object.keys(trusted).some((key) => key.startsWith(`${coordPrefix}scripts/`) && !present.has(key));
  const carried = carriedMoves({ git, head, tree, layout, shims: Array.isArray(shimRegistry) ? shimRegistry : [], needRenames });
  const scope = { trusted, maxLoc, carried };
  const refusals = [];
  let declared = new Map();
  const archKey = `${coordPrefix}engine/scripts/arch-checks.js`;
  const engineSources = [];
  for (const { file, object } of items) {
    const source = git(["cat-file", "blob", object]);
    if (file === archKey) declared = parseDeclaredBudgets(source);
    if (isEngineProductionModule(file)) engineSources.push({ path: file, source });
    const hit = productionLocExcess({ file, source, config: trustedConfig, carried });
    if (hit) refusals.push(measuredRefusalText(file, hit));
  }
  for (const [file, number] of declared) {
    if (!shouldCheckProductionModuleLoc(file, trustedConfig)) continue;
    const { budget, carry } = budgetFor(file, scope);
    if (number <= budget) continue;
    refusals.push(declaredRefusalText(file, number, { budget, carry, trusted }));
  }
  // COORD-976: the engine ratchet is read from the candidate tree and the base (head). A
  // ratchet absent at both is not yet adopted; a ratchet deleted from the candidate is refused.
  const candidateRatchetText = blobAt(gitTry, root, tree, RATCHET_REL);
  const baseRatchetText = blobAt(gitTry, root, head, RATCHET_REL);
  const ratchetRefusals = [];
  if (candidateRatchetText != null || baseRatchetText != null) {
    const ratchet = parseRatchet(candidateRatchetText, RATCHET_REL);
    const baseRatchet = parseRatchet(baseRatchetText, RATCHET_REL);
    const guardsText = blobAt(gitTry, root, tree, GUARDS_REL);
    const measured = measureEngine(engineSources, guardsText);
    ratchetRefusals.push(...evaluateRatchet({ ticketId, measured, ratchet, baseRatchet }));
  }
  if (refusals.length) {
    throw new Error(`Ticket ${ticketId} prodloc closeout refused: ${refusals.join("; ")}. Split the module or land a shrink repair; do not raise its budget.`);
  }
  if (ratchetRefusals.length) {
    // guard:production-loc-budget
    throw new Error(`Ticket ${ticketId} engine ratchet refused: ${ratchetRefusals.join("; ")}. Record growth on this ticket in ${RATCHET_REL} or split the change.`);
  }
  return { result: "pass", checked: items.length, tree };
}

// COORD-888: the registered legacy CLI shim re-dispatches this main (same argv, same exit code).
function main() {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node coord/engine/scripts/prodloc-closeout.js (checks committed HEAD with trusted production LOC budgets)");
    console.log(JSON.stringify(assertProductionLocForCloseout("operator-check")));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { assertProductionLocForCloseout, main };
if (require.main === module) main();
