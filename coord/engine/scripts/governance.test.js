const test = require("node:test");
const governanceCommands = require("./lifecycle.js").commands;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const approvalVerifier = require("./approval-verifier.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

const governanceModule = require("./governance.js");
const { GovernanceError, executeCommand, __testing } = governanceModule;
const governanceContext = require("./governance-context.js");
const { state: governanceState, DEFAULT_PATHS } = governanceContext;
const createLifecycleReviewState = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-review-state.js"));
const createPlanRecords = require("./plan-records.js");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const createGovernancePlanShape = require("./governance-plan-shape.js");
const createGovernanceValidation = require("./governance-validation.js");
const { integerOrDefault, escapeRegex, toArray } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const { DEFAULT_INTEGRATION_BRANCH, resolveEngineModule } = require("../../paths.js");
const coordRoot = path.resolve(__dirname, "..", "..");
const { parseFeatureProofEntry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-resolution.js"));
const { createFeatureProofNormalization } = require(resolveEngineModule(coordRoot, "scripts/feature-proof-audit.js"));
const { createFeatureProofEntryValidator } = require(resolveEngineModule(coordRoot, "scripts/feature-proof-entry-validation.js"));
const { mergeUniqueRefs } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/landing-gh.js"));
const governanceValidationOwner = createGovernanceValidation({
  GovernanceError,
  fail: (message) => { throw new GovernanceError(message); },
  integerOrDefault,
  escapeRegex,
  toArray,
  isMeaningfulText: (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return Boolean(normalized) && !normalized.includes("todo");
  },
});
const governancePlanShapeOwner = createGovernancePlanShape({
  state: governanceContext.state,
  REPO_INTEGRATION_BRANCHES: DEFAULT_PATHS.repoIntegrationBranches,
  DEFAULT_INTEGRATION_BRANCH,
  isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
  repoNameForCode: repoRegistryOwner.repoNameForCode,
  toArray,
});
const { normalizeFeatureProofEntryForTicket } = createFeatureProofNormalization({
  parseFeatureProofEntry,
  resolveRepoCodeForTicket: (ticketId, row) => row?.Repo || repoRegistryOwner.inferRepoCodeFromTicketId(ticketId),
  repoPrefixesForCode: repoRegistryOwner.repoPrefixesForCode,
});
const { validateFeatureProofEntry } = createFeatureProofEntryValidator({
  fail: (message) => { throw new GovernanceError(message); },
});
const planRecordOwner = createPlanRecords({
  fail: (message) => { throw new GovernanceError(message); },
  resolveRepoCodeForTicket: (ticketId) => repoRegistryOwner.inferRepoCodeFromTicketId(ticketId),
  buildDefaultGovernancePlan: governancePlanShapeOwner.buildDefaultGovernancePlan,
  normalizeGovernancePlanShape: governancePlanShapeOwner.normalizeGovernancePlanShape,
  formatGovernancePlanEntry: governancePlanShapeOwner.formatGovernancePlanEntry,
  formatGovernanceReviewProfileEntry: governancePlanShapeOwner.formatGovernanceReviewProfileEntry,
  formatGovernanceRepairEntry: governancePlanShapeOwner.formatGovernanceRepairEntry,
  parseGovernancePlanEntries: governancePlanShapeOwner.parseGovernancePlanEntries,
  scaffoldSelfReviewCycle: governancePlanShapeOwner.scaffoldSelfReviewCycle,
  resolveRepoIntegrationBranch: repoRegistryOwner.resolveRepoIntegrationBranch,
  isTestingInfrastructureTicket: () => false,
  todayIso: () => "2026-01-01",
  escapeTable: (value) => String(value || ""),
  toArray,
  normalizeSelfReviewCycleLine: governanceValidationOwner.normalizeSelfReviewCycleLine,
  parseSelfReviewCycles: governanceValidationOwner.parseSelfReviewCycles,
  validateRequirementClosureEntry: governanceValidationOwner.validateRequirementClosureEntry,
  validateFeatureProofEntry,
  normalizeFeatureProofEntryForTicket,
  isMeaningfulText: governanceValidationOwner.isMeaningfulText,
  escapeRegex,
  integerOrDefault,
  readBoard: () => ({ sections: [] }),
  getTicketRef: () => null,
  inferRequiredReviewRound: governanceValidationOwner.inferRequiredReviewRound,
  normalizeOwnerValue: (value) => String(value || ""),
  repoNameForCode: repoRegistryOwner.repoNameForCode,
  ensurePlanStub: () => null,
  mergeUniqueRefs,
  isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
});
const { withCleanRuntimeFixture, runGit, writeRepoFile, createTempGitRepo, createTempGitRepoWithOrigin, createMinimalGovernanceWorkspace, setupCoord003Workspace, readBoardRow, withCanonicalTicketPrompt, withRegisterPromptHarness, sandboxProcessRuntime, withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const verbParity = require("./verb-parity.js");
const createWorktreeOps = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/worktree-ops.js"));
const { gitTry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const worktreeOpsOwner = createWorktreeOps({
  ...repoRegistryOwner,
  gitTry,
});

// COORD-300: redirect the full runtime surface (agent registry + sessions + coarse
// locks + RUNTIME_DIR) to a per-process os.tmpdir() sandbox so the few full-stack
// governed flows here that touch the live agent registry write tmp instead of the
// live coord/.runtime tree — letting governance.test.js leave the isolation-guard allowlist.
sandboxProcessRuntime();

// Hermetic session env: these tests control provider session/thread ids
// explicitly. Strip any ambient id the host injects (e.g. Claude Code exports
// CLAUDE_CODE_SESSION_ID) so it cannot leak into fingerprint/identity tests.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;
// COORD-883: the Gemini/Grok runtime detection flags alone make the provider
// google/xai, which may not act as these fixtures' anthropic owners; a test that
// wants either provider detected sets its flag itself.
delete process.env.GEMINI_AGENT;
delete process.env.GROK_AGENT;

test("COORD-390: process runtime sandbox redirects seal-sensitive prompt/render surfaces", () => {
  const livePromptsDir = path.resolve(__dirname, "..", "..", "prompts");
  const liveRenderedDir = path.resolve(__dirname, "..", "..", "rendered");
  const tempRoot = fs.realpathSync(os.tmpdir());
  const isInsideTempRoot = (candidate) => {
    const relative = path.relative(tempRoot, fs.realpathSync(candidate));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.notEqual(path.resolve(governanceState.PROMPTS_DIR), livePromptsDir);
  assert.notEqual(path.resolve(governanceState.RENDERED_DIR), liveRenderedDir);
  assert.equal(isInsideTempRoot(governanceState.PROMPTS_DIR), true, "prompt sandbox resolves inside os.tmpdir()");
  assert.equal(isInsideTempRoot(governanceState.RENDERED_DIR), true, "render sandbox resolves inside os.tmpdir()");
});

test("COORD-394: ephemeral worktree live-authority writes fail closed, sandbox writes remain allowed", () => {
  const coordDir = path.join(os.tmpdir(), "coord394-live", "coord");
  const livePaths = {
    BOARD_PATH: path.join(coordDir, "board", "tasks.json"),
    GOVERNANCE_EVENT_LOG_PATH: path.join(coordDir, ".runtime", "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(coordDir, ".runtime", "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(coordDir, ".runtime", "governance-snapshots"),
    PLAN_RECORDS_DIR: path.join(coordDir, ".runtime", "plans"),
  };
  const role = { role: "ephemeral_worktree", reason: "test marker" };
  const issue = governanceContext.canonicalAuthorityWriteIssue({ role, coordDir, paths: livePaths });
  assert.equal(issue.code, "ephemeral_canonical_authority_write");
  assert.throws(
    () => governanceContext.assertCanonicalAuthorityWriteAllowed({ role, coordDir, paths: livePaths }),
    /Refusing canonical governance-state mutation from an ephemeral linked worktree/
  );

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord394-sandbox-"));
  const sandboxPaths = {
    ...livePaths,
    GOVERNANCE_EVENT_LOG_PATH: path.join(sandboxDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(sandboxDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(sandboxDir, "governance-snapshots"),
    PLAN_RECORDS_DIR: path.join(sandboxDir, "plans"),
  };
  assert.equal(governanceContext.canonicalAuthorityWriteIssue({ role, coordDir, paths: sandboxPaths }), null);
  assert.doesNotThrow(() => governanceContext.assertCanonicalAuthorityWriteAllowed({ role, coordDir, paths: sandboxPaths }));
});

test("COORD-394: canonical integration role can mutate canonical authority paths", () => {
  const coordDir = path.join(os.tmpdir(), "coord394-canonical", "coord");
  const paths = {
    BOARD_PATH: path.join(coordDir, "board", "tasks.json"),
    GOVERNANCE_EVENT_LOG_PATH: path.join(coordDir, ".runtime", "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(coordDir, ".runtime", "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(coordDir, ".runtime", "governance-snapshots"),
    PLAN_RECORDS_DIR: path.join(coordDir, ".runtime", "plans"),
  };
  const role = { role: "canonical_integration_tree", reason: "test marker" };
  assert.equal(governanceContext.canonicalAuthorityWriteIssue({ role, coordDir, paths }), null);
  assert.doesNotThrow(() => governanceContext.assertCanonicalAuthorityWriteAllowed({ role, coordDir, paths }));
});

// ---------------------------------------------------------------------------
// COORD-280: __testing facade surface check (required-subset, auto-derived).
//
// HISTORY: this used to be an exact `deepEqual(Object.keys(__testing).sort(),
// <a ~1,633-key frozen literal>)`. That literal was a merge-conflict magnet and
// forced a manual edit on every facade add/remove. The PROTECTION we keep: a
// refactor (e.g. the COORD-281/282/283 extractions) that DROPS or RENAMES an
// internal that the test suite still depends on must fail here.
//
// HOW THE REQUIRED SET IS DERIVED (self-maintaining — do NOT hand-edit a list):
// We scan every sibling `coord/scripts/*.test.js` that consumes the governance
// `__testing` facade (directly from `./governance.js`, via `governanceModule`,
// or via the `./governance-test-utils.js` re-export) and collect every
// `__testing.<key>` member access. That set IS the honest "depended upon"
// surface. The facade must be a SUPERSET of it.
//   - ADD a new `__testing` export  -> nothing references it yet -> still PASS
//     (the brittleness is gone; no manual literal edit, no merge conflict).
//   - DROP/RENAME a depended-on key  -> some test still says `__testing.<key>`
//     -> key is in the required set but missing from the facade -> FAIL
//     (the COORD-066-adjacent safety net is preserved).
// When an extraction renames an internal, update the call sites (the tests that
// reference it) — the required set follows automatically from those edits.
//
// Access is always `__testing.<identifier>` (no destructuring/aliasing/dynamic
// bracket access exists in the suite — verified COORD-280), so a single member
// -access regex captures the full dependency surface.

// COORD-869: suites moved under coord/engine/scripts reach the facade through
// resolveEngineModule (or ../../scripts/) and count the same.
const GOVERNANCE_FACADE_REQUIRE_RE =
  // COORD-873: also the inline resolver form the batch-10 repoint writes (its nested
  // require("node:path").resolve(__dirname, ...) call holds parentheses).
  /require\((?:["'](?:\.|\.\.\/\.\.\/scripts)\/governance(?:-test-utils)?\.js["']|resolveEngineModule\([^)]*["']scripts\/governance(?:-test-utils)?\.js["']\)|require\(["'](?:\.\.\/)+paths\.js["']\)\.resolveEngineModule\(require\(["']node:path["']\)\.resolve\(__dirname(?:, ["']\.\.["'])+\), ["']scripts\/governance(?:-test-utils)?\.js["']\))\)/;

// Intentionally-OPTIONAL references: keys a test reads through the facade but
// guards with a fallback (e.g. `__testing.CHAIN_GENESIS_PREV || "genesis"`),
// so the facade NOT exporting them does not break anything. These are excluded
// from the required set to keep it honest — they are referenced but not truly
// depended upon. Add an entry here only with a matching fallback-guarded call
// site and a note explaining why its absence is tolerated.
//   - CHAIN_GENESIS_PREV: journal.js keeps this genesis-anchor constant module-
//     private; journal.test.js reads it opportunistically with a "genesis"
//     fallback, so the export is optional by design.
const OPTIONAL_TESTING_KEYS = new Set(["CHAIN_GENESIS_PREV"]);

// A file participates in the required-surface derivation only if it pulls the
// governance facade in (so a future sibling that exposes a *different* module's
// `__testing` is never misattributed to this surface).
function importsGovernanceTestingFacade(sourceText) {
  return (
    GOVERNANCE_FACADE_REQUIRE_RE.test(sourceText) &&
    /\b__testing\b/.test(sourceText)
  );
}

function governanceTestingBindings(sourceText) {
  const moduleBindings = new Set();
  const testingBindings = new Set();
  const governanceImport = new RegExp(GOVERNANCE_FACADE_REQUIRE_RE.source, "g");
  let imported;
  while ((imported = governanceImport.exec(sourceText)) !== null) {
    const before = sourceText.slice(0, imported.index);
    const statementStart = before.lastIndexOf(";") + 1;
    const prefix = before.slice(statementStart);
    const moduleBinding = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/s.exec(prefix);
    if (moduleBinding) moduleBindings.add(moduleBinding[1]);
    const directDestructure = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*$/s.exec(prefix);
    if (directDestructure) addTestingDestructureAliases(directDestructure[1], testingBindings);
    const directTestingAlias = /^\s*\.\s*__testing\b/.test(sourceText.slice(imported.index + imported[0].length));
    if (directTestingAlias) {
      const testingDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/.exec(prefix);
      if (testingDeclaration) testingBindings.add(testingDeclaration[1]);
    }
  }

  const destructured = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let binding;
  while ((binding = destructured.exec(sourceText)) !== null) {
    if (moduleBindings.has(binding[2])) addTestingDestructureAliases(binding[1], testingBindings);
  }
  return { moduleBindings, testingBindings };
}

function addTestingDestructureAliases(properties, into) {
  for (const property of properties.split(",")) {
    const match = /^\s*__testing(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(property);
    if (match) into.add(match[1] || "__testing");
  }
}

function collectTestingKeyReferences(sourceText, into) {
  const { moduleBindings, testingBindings } = governanceTestingBindings(sourceText);
  const ignoredReferenceOffsets = new Set();
  const explicitlyAbsentAssertion = /assert\.(?:equal|strictEqual)\(\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*__testing\.([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*undefined\s*\)/g;
  let absent;
  while ((absent = explicitlyAbsentAssertion.exec(sourceText)) !== null) {
    ignoredReferenceOffsets.add(
      absent.index + absent[0].indexOf("__testing." + absent[1])
    );
  }

  // closeout.test.js also imports the separate board-testing path object. Do
  // not attribute that owner module's `paths` seam to governance.__testing.
  const boardTestingPaths = /require\(["'](?:\.\.\/)+board\/board\.js["']\)\.__(?:testing)\.paths/g;
  let boardPaths;
  while ((boardPaths = boardTestingPaths.exec(sourceText)) !== null) {
    ignoredReferenceOffsets.add(
      boardPaths.index + boardPaths[0].indexOf("__testing" + ".paths")
    );
  }

  // COORD-869: engine-tree suites (correct-finding-severity) reach board.js's
  // own __testing through a board* binding; that is not the governance facade.
  const boardModuleTesting = /\bboard\w*\.__testing\./g;
  let boardModule;
  while ((boardModule = boardModuleTesting.exec(sourceText)) !== null) {
    ignoredReferenceOffsets.add(boardModule.index + boardModule[0].indexOf("__testing."));
  }

  // Only follow the binding that imported the governance module or its
  // governance-test-utils re-export. Files often import several modules whose
  // own `__testing` objects are unrelated (for example, integration authority).
  const qualifiedAccess = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*__testing\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match;
  while ((match = qualifiedAccess.exec(sourceText)) !== null) {
    const owner = match[1];
    const memberOffset = match.index + match[0].indexOf("__testing.");
    if (moduleBindings.has(owner) && !ignoredReferenceOffsets.has(memberOffset)) into.add(match[2]);
  }

  const governanceRequire = new RegExp(GOVERNANCE_FACADE_REQUIRE_RE.source, "g");
  while ((match = governanceRequire.exec(sourceText)) !== null) {
    const suffix = sourceText.slice(match.index + match[0].length);
    const directAccess = /^\s*\.\s*__testing\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(suffix);
    if (directAccess) into.add(directAccess[1]);
  }

  // COORD-946: a bare identifier that is itself a property of another expression
  // (`require("../../board/board.js").__testing.validateSchema`) names a different
  // module's facade, so it must not be read as a bound governance `__testing` alias.
  const boundAccess = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((match = boundAccess.exec(sourceText)) !== null) {
    if (/\.\s*$/.test(sourceText.slice(0, match.index))) continue;
    if (testingBindings.has(match[1]) && !ignoredReferenceOffsets.has(match.index)) into.add(match[2]);
  }
  return into;
}

test("testing facade census ignores explicit absence assertions and other owners", () => {
  const source =
    'const governanceModule = require("./governance.js");\n' +
    "const { __testing } = governanceModule;\n" +
    'const authority = require("./integration-authority.js");\n' +
    "assert.equal(__testing" + ".retired, undefined);\n" +
    "assert.equal(authority.__testing.getJournalMutation, null);\n" +
    "assert.equal(authority.__testing.setFaultHook, null);\n" +
    'const boardPaths = require("../../board/board.js").__testing.paths;\n' +
    "assert.equal(governanceModule.__testing" + ".live, true);";
  const required = collectTestingKeyReferences(source, new Set());
  assert.deepEqual([...required], ["live"]);
});

test("COORD-946: testing facade census ignores another module's __testing member access", () => {
  const source = [
    'const governanceModule = require("./governance.js");',
    "const { __testing } = governanceModule;",
    "__testing" + ".live;",
    'require("../../board/board.js").__testing' + ".validateSchema(schema, value, \"fixture\", errors);",
    'const { __testing: schemaTesting } = require("../../board/board.js");',
    "schemaTesting" + ".validateSchema(schema, value, \"fixture\", errors);",
  ].join("\n");
  assert.deepEqual([...collectTestingKeyReferences(source, new Set())].sort(), ["live"]);
});

test("testing facade census follows direct governance requires and resolver imports", () => {
  const source = [
    'const direct = require("./governance.js").__testing;',
    'direct.claimTicket();',
    'require("./governance-test-utils.js").__testing.appendGovernanceEvent();',
    'const { __testing: resolvedTesting } = require(resolveEngineModule(COORD_ROOT, "scripts/governance.js"));',
    'resolvedTesting.finalizeTicket();',
  ].join("\n");
  assert.deepEqual(
    [...collectTestingKeyReferences(source, new Set())].sort(),
    ["appendGovernanceEvent", "claimTicket", "finalizeTicket"],
  );
});

test("COORD-915: mixed-module testing references are attributed to their imported facade", () => {
  const source = [
    'const governanceModule = require("./governance.js");',
    'const { __testing: govTesting } = governanceModule;',
    'const authority = require("./integration-authority.js");',
    'const { __testing: authorityTesting } = authority;',
    'govTesting.claimTicket("COORD-915");',
    'governanceModule.__testing.appendGovernanceEvent("COORD-915");',
    'authority.__testing.getJournalMutation();',
    'authorityTesting.setActiveOperationId("operation");',
  ].join("\n");
  assert.deepEqual(
    [...collectTestingKeyReferences(source, new Set())].sort(),
    ["appendGovernanceEvent", "claimTicket"],
    "a mixed import file counts governance aliases and excludes the authority module's own facade",
  );
});

// Derive the required `__testing` surface from actual usage across the suite.
function collectGovernanceTestingRequirements() {
  const required = new Set();
  for (const file of [path.join(__dirname, "..", "..", "scripts"), __dirname].flatMap((dir) => fs.readdirSync(dir).map((name) => path.join(dir, name)))) {
    if (!file.endsWith(".test.js")) continue;
    const sourceText = fs.readFileSync(file, "utf8");
    if (!importsGovernanceTestingFacade(sourceText)) continue;
    collectTestingKeyReferences(sourceText, required);
  }
  for (const optional of OPTIONAL_TESTING_KEYS) required.delete(optional);
  return required;
}

// Pure helper (unit-tested below): which required keys are absent from a facade.
function missingRequiredTestingKeys(facadeKeys, requiredKeys) {
  const present = new Set(facadeKeys);
  return [...requiredKeys].filter((key) => !present.has(key)).sort();
}

test("__testing facade exposes every internal the test suite depends on (required-subset, auto-derived)", () => {
  const required = collectGovernanceTestingRequirements();
  // Self-check: the derivation actually found a substantial surface. Guards
  // against a silent regex/scan breakage that would make the check vacuous.
  // Extraction can shrink this set; it remains separate from any facade budget.
  assert.ok(
    required.size >= 100,
    `expected the derived required __testing surface to remain non-vacuous; ` +
      `got ${required.size} — the usage scan likely broke`
  );
  const missing = missingRequiredTestingKeys(Object.keys(__testing), required);
  assert.deepEqual(
    missing,
    [],
    `__testing facade is missing internals the test suite depends on ` +
      `(dropped or renamed by a refactor without updating call sites?): ` +
      `${missing.join(", ")}`
  );
});

test("COORD-280 ADD-KEY-OK: a NEW __testing export does not break the surface check", () => {
  // Synthetic: a brand-new internal nothing references yet must pass.
  const required = new Set(["alpha", "beta"]);
  assert.deepEqual(
    missingRequiredTestingKeys(["alpha", "beta", "freshInternalFromARefactor"], required),
    []
  );
  // Against the REAL facade: a superset (every real key plus a synthetic new
  // one) still passes — proving adds never force a manual literal edit.
  const realRequired = collectGovernanceTestingRequirements();
  const supersetFacade = [...Object.keys(__testing), "__coord280_synthetic_new_export"];
  assert.deepEqual(missingRequiredTestingKeys(supersetFacade, realRequired), []);
});

test("COORD-280 DROP-DEPENDED-KEY-FAILS: removing a depended-on __testing key still fails", () => {
  // Synthetic: dropping a required key is reported.
  const required = new Set(["alpha", "beta"]);
  assert.deepEqual(missingRequiredTestingKeys(["alpha"], required), ["beta"]);
  // Against the REAL derived surface: drop one genuinely-depended key and
  // confirm the check fires — the extraction safety net is intact.
  const realRequired = collectGovernanceTestingRequirements();
  const [sampleDependedKey] = [...realRequired];
  assert.ok(sampleDependedKey, "expected at least one depended-on key");
  const facadeMissingOne = Object.keys(__testing).filter((key) => key !== sampleDependedKey);
  assert.deepEqual(missingRequiredTestingKeys(facadeMissingOne, realRequired), [sampleDependedKey]);
});

// COORD-825 stage 3: token-economics factory keys move to their owning module.
// Ratchet the facade down by the full 21-key group; do not widen the budget.
const LIFECYCLE_TESTING_FACADE_KEY_BUDGET = 104;

test("COORD-825 stages 2-3: lifecycle __testing has no path facade and stays under budget", () => {
  const lifecycleFacade = require("./lifecycle.js").__testing;
  const count = Object.keys(lifecycleFacade).length;
  assert.equal(Object.hasOwn(lifecycleFacade, "paths"), false,
    "lifecycle paths are provided through scoped module context, not the testing facade");
  assert.ok(
    count <= LIFECYCLE_TESTING_FACADE_KEY_BUDGET,
    `lifecycle __testing grew to ${count} keys (budget ${LIFECYCLE_TESTING_FACADE_KEY_BUDGET}); ` +
      `test the owning module factory directly instead of widening the facade`
  );
  const source = fs.readFileSync(path.join(__dirname, "lifecycle.js"), "utf8");
  const block = source.slice(source.indexOf("  __testing: {\n"));
  const entries = [...block.matchAll(/^ {4}([A-Za-z_$][\w$]*),$/gm)].map((match) => match[1]);
  assert.deepEqual(entries.filter((key, index) => entries.indexOf(key) !== index), [],
    "a duplicated facade entry inflates the literal without adding a key");
});

test("buildDependencyBootstrapGuidance is registry-generalized (no hardcoded B/F→repo names)", () => {
  const repo = createTempGitRepo("legacy-bootstrap-guidance-", {
    "README.md": "backend\n",
  }, "seed");
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { B: "dev" },
  }, () => {
    // Repo label derived from the registry (repoNameForCode), not a hardcoded
    // "msrv"/"frontend" literal. base_ref is the template default "dev".
    assert.deepEqual(worktreeOpsOwner.buildDependencyBootstrapGuidance("B", "/tmp/wt"), {
      base_ref: "dev",
      commands: [
        `git -C ${repoRegistryOwner.repoNameForCode("B")} fetch origin dev`,
        "pnpm --dir /tmp/wt install --frozen-lockfile",
      ],
    });
    assert.equal(worktreeOpsOwner.repoBootstrapLabel("B"), repoRegistryOwner.repoNameForCode("B"));
    // Non-repo-backed codes return null guidance / coord label.
    assert.equal(worktreeOpsOwner.buildDependencyBootstrapGuidance("X", "/tmp/wt"), null);
    assert.equal(worktreeOpsOwner.repoBootstrapLabel("X"), "coord");
  });
});

test("ensureGitWorktree fails closed with a generalized missing-base-ref message", () => {
  const repo = createTempGitRepo("legacy-missing-baseref-", {
    "README.md": "backend\n",
  }, "seed");
  const repoLabel = repoRegistryOwner.repoNameForCode("B");
  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-900");

  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { B: "dev" },
  }, () => {
    // gitCommitishExists is honest about an existing vs missing ref.
    assert.equal(worktreeOpsOwner.gitCommitishExists(repo.repoRoot, "dev"), true);
    assert.equal(worktreeOpsOwner.gitCommitishExists(repo.repoRoot, "missing-base"), false);

    const message = worktreeOpsOwner.formatMissingStartBaseRefMessage("B", repo.repoRoot, "missing-base");
    assert.match(message, new RegExp(`Cannot create governed ${repoLabel} worktree from missing-base`));
    assert.match(message, new RegExp(`git -C ${repoLabel} fetch origin dev`));
    assert.match(message, /install --frozen-lockfile/);

    assert.throws(
      () =>
        __testing.withPreparedTicketWorkspace(
          {
            repoCode: "B",
            worktree,
            branch: "agent/agenta01-be-900-x",
            base: "missing-base",
          },
          () => {
            throw new GovernanceError("should not reach work fn");
          }
        ),
      (error) =>
        error instanceof GovernanceError &&
        // COORD-125: when the origin fetch fails AND no local base ref (neither
        // origin/<base> nor a local <base> branch) resolves, there is genuinely
        // no base to cut from, so start fails closed with the generalized
        // missing-base message (no worktree, no silent stale-base fallback).
        new RegExp(`Cannot create governed ${repoLabel} worktree from missing-base`).test(error.message)
    );
    assert.equal(fs.existsSync(worktree), false);
  });
});

test("GCV-2: ensureGitWorktree bases a new ticket branch on origin/<baseRef>, not stale local dev", () => {
  const repo = createTempGitRepoWithOrigin("legacy-gcv2-stale-base-", {
    "README.md": "backend\n",
  }, "seed");
  const staleHead = repo.head; // local dev will be pinned here (stale)

  // Advance origin/dev to a new commit, then rewind local dev so the
  // local branch is behind origin (the FE-385/FE-386 condition).
  writeRepoFile(repo.repoRoot, "fresh.txt", "origin-only change\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "origin-only advance"]);
  const originHead = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(repo.repoRoot, ["push", "origin", "dev"]);
  runGit(repo.repoRoot, ["reset", "--hard", staleHead]);
  assert.notEqual(originHead, staleHead);
  assert.equal(runGit(repo.repoRoot, ["rev-parse", "dev"]), staleHead); // local dev IS stale

  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-901");

  return withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
    REPO_INTEGRATION_BRANCHES: { B: "dev" },
  }, () => {
    let worktreeHead = null;
    __testing.withPreparedTicketWorkspace(
      { repoCode: "B", worktree, branch: "agent/agenta01-be-901-x", base: "dev" },
      () => {
        worktreeHead = runGit(worktree, ["rev-parse", "HEAD"]);
      }
    );
    // The governed worktree must be cut from origin/dev (fresh), never the
    // stale local dev ref.
    assert.equal(worktreeHead, originHead, "worktree should be based on origin/dev");
    assert.notEqual(worktreeHead, staleHead, "worktree must NOT be based on stale local dev");
  });
});

test("COORD-125: ensureGitWorktree gracefully falls back to the LOCAL base (with a warning) when origin fetch fails — never hard-fails offline", () => {
  // Reproduction: a local origin/<base> tracking ref already exists (from a
  // prior successful fetch/push) but the remote URL is broken now, so
  // `git fetch` fails (the offline/unreachable case). The fresh-from-origin
  // path (GCV-2) is preferred when reachable, but COORD-125 must NOT hard-fail
  // a local/offline workflow: it falls back to the local base ref and warns.
  const repo = createTempGitRepoWithOrigin("coord125-offline-", {
    "README.md": "backend\n",
  }, "seed");
  // Confirm the tracking ref exists locally (set by the push during fixture
  // setup) so a safe local fallback base is available.
  assert.equal(worktreeOpsOwner.gitCommitishExists(repo.repoRoot, "origin/dev"), true);
  // Break the remote URL so any subsequent fetch fails (offline).
  runGit(repo.repoRoot, ["remote", "set-url", "origin", "/tmp/does-not-exist-coord125"]);
  assert.equal(worktreeOpsOwner.gitCommitishExists(repo.repoRoot, "origin/dev"), true);

  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-902");

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  try {
    return withScopedGovernanceTestContext({
      REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
      REPO_INTEGRATION_BRANCHES: { B: "dev" },
    }, () => {
    const result = __testing.withPreparedTicketWorkspace(
      {
        repoCode: "B",
        worktree,
        branch: "agent/agenta01-be-902-x",
        base: "dev",
      },
      (prepared) => prepared
    );
    // Offline start succeeded (no hard-fail): the worktree + branch exist,
    // cut from the local origin/dev tracking ref, with a clear staleness warning.
    assert.equal(result.createdWorktree, true);
    assert.equal(result.createdBranch, true);
    assert.equal(fs.existsSync(worktree), true);
    assert.ok(
      warnings.some((m) => /could not fetch origin dev/i.test(m) && /LOCAL base/i.test(m)),
      "offline fallback must emit a clear staleness warning"
    );
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("preflightPrBranch fails clearly when the branch is not pushed", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-", { "README.md": "seed\n" });
  writeRepoFile(repo.repoRoot, "feature.txt", "delta\n");
  runGit(repo.repoRoot, ["checkout", "-b", "agent/test-ticket"]);
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "feature"]);

  assert.throws(
    () => __testing.preflightPrBranch(repo.repoRoot, "agent/test-ticket", "dev", {}),
    /is not published on origin/
  );
});

test("preflightPrBranch fails clearly when git cannot compare the requested refs", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-bad-ref-", { "README.md": "seed\n" });

  assert.throws(
    () => __testing.preflightPrBranch(repo.repoRoot, "missing-branch", "dev", {}),
    (error) => error instanceof GovernanceError && /Failed to compare missing-branch against origin\/dev/i.test(error.message)
  );
});

test("preflightPrBranch pushes from options.pushCwd so pre-push hooks run against the worktree, not the repo root", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-worktree-", { "README.md": "seed\n" });
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-worktree-wt-"));
  fs.rmSync(worktreePath, { recursive: true, force: true });
  const branch = "agent/test-ticket-pushcwd";
  runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktreePath, "dev"]);
  writeRepoFile(worktreePath, "feature.txt", "worktree delta\n");
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["commit", "-m", "feature from worktree"]);

  const hookLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-hooklog-")),
    "hook.log",
  );
  const hookPath = path.join(repo.repoRoot, ".git", "hooks", "pre-push");
  fs.writeFileSync(
    hookPath,
    `#!/usr/bin/env sh\nprintf 'cwd=%s\\n' "$PWD" > "${hookLogPath}"\nprintf 'toplevel=%s\\n' "$(git rev-parse --show-toplevel)" >> "${hookLogPath}"\nexit 0\n`,
    "utf8",
  );
  fs.chmodSync(hookPath, 0o755);

  __testing.preflightPrBranch(repo.repoRoot, branch, "dev", { push: true, pushCwd: worktreePath });

  const hookLog = fs.readFileSync(hookLogPath, "utf8");
  const cwdLine = hookLog.match(/^cwd=(.+)$/m);
  const toplevelLine = hookLog.match(/^toplevel=(.+)$/m);
  assert.ok(cwdLine, `pre-push hook did not record cwd; got:\n${hookLog}`);
  assert.ok(toplevelLine, `pre-push hook did not record toplevel; got:\n${hookLog}`);
  assert.equal(
    fs.realpathSync(cwdLine[1]),
    fs.realpathSync(worktreePath),
    "pre-push hook cwd should be the worktree path passed as pushCwd",
  );
  assert.equal(
    fs.realpathSync(toplevelLine[1]),
    fs.realpathSync(worktreePath),
    "git rev-parse --show-toplevel inside the hook should resolve to the worktree",
  );

  assert.equal(
    runGit(repo.remoteRoot, ["rev-parse", `refs/heads/${branch}`]),
    runGit(worktreePath, ["rev-parse", "HEAD"]),
    "origin should now have the agent branch at the worktree HEAD",
  );
});

test("preflightPrBranch falls back to repoRoot when options.pushCwd is not set", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-fallback-", { "README.md": "seed\n" });
  const branch = "agent/test-ticket-fallback";
  runGit(repo.repoRoot, ["checkout", "-b", branch]);
  writeRepoFile(repo.repoRoot, "feature.txt", "repo-root delta\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "feature from repo root"]);

  const hookLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-fallback-hooklog-")),
    "hook.log",
  );
  const hookPath = path.join(repo.repoRoot, ".git", "hooks", "pre-push");
  fs.writeFileSync(
    hookPath,
    `#!/usr/bin/env sh\nprintf 'cwd=%s\\n' "$PWD" > "${hookLogPath}"\nexit 0\n`,
    "utf8",
  );
  fs.chmodSync(hookPath, 0o755);

  __testing.preflightPrBranch(repo.repoRoot, branch, "dev", { push: true });

  const hookLog = fs.readFileSync(hookLogPath, "utf8");
  const cwdLine = hookLog.match(/^cwd=(.+)$/m);
  assert.ok(cwdLine, `pre-push hook did not record cwd; got:\n${hookLog}`);
  assert.equal(
    fs.realpathSync(cwdLine[1]),
    fs.realpathSync(repo.repoRoot),
    "pre-push hook cwd should fall back to repoRoot when pushCwd is omitted",
  );
});

test("assertCommittedReviewState rejects source commits already landed on origin/dev when local dev is stale", () => {
  const backendRepo = createTempGitRepoWithOrigin("legacy-review-state-origin-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-904-review-state"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "review-state-remote\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-904 landed before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);
  runGit(backendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);
  const worktreePath = path.join(backendRepo.repoRoot, ".worktrees", "codexa34", "MSRV-904");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(backendRepo.repoRoot, ["worktree", "add", worktreePath, "agent/codexa34-backend-904-review-state"]);

  const service = createLifecycleReviewState({
    assertCurrentTicketLockIntegrity: () => {},
    fail: (message) => { throw new GovernanceError(message); },
    fs,
    getRepoRoot: () => backendRepo.repoRoot,
    gitTry: (repo, args) => {
      try {
        return { status: 0, stdout: runGit(repo, args), stderr: "" };
      } catch (error) {
        return { status: 1, stdout: "", stderr: error.message };
      }
    },
    isCommitAncestorOfRef: () => true,
    isRepoBackedCode: () => true,
    planTargetsCoordOnlyArtifacts: (ticketId) => planRecordOwner.planTargetsCoordOnlyArtifacts(ticketId),
    repoNameForCode: () => backendRepo.repoRoot,
    resolveCommitishInRepo: (_repo, commitish) => commitish,
    resolveLandingBaseRef: () => ({ baseRef: "origin/dev" }),
    resolveRepoIntegrationBranch: () => "dev",
    resolveSourceCommitSha: () => sourceHead,
  });
  assert.throws(
    () => service.assertCommittedReviewState(
      "MSRV-904",
      { Repo: "B", Type: "feature" },
      {
        worktree: worktreePath,
        branch: "agent/codexa34-backend-904-review-state",
        owner: "codexa34",
        repo: backendRepo.repoRoot,
        head: sourceHead,
      },
      { sourceCommit: sourceHead }
    ),
    /already appears landed on .*\/origin\/dev/
  );
});

// COORD-293: the ensureDoingTicketLockIntegrity doing-lock-recreation test moved
// to ticket-lock-service.test.js alongside the extracted ticket-lock service.

function prepareReviewableDocsTicket(ctx, ticketId, intendedFile) {
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const row = board.sections.flatMap((section) => section.rows).find((candidate) => candidate.ID === ticketId);
  row.Type = "docs";
  row.Description = "Maintain a coordination reference note.";
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  const planPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.intended_files = [intendedFile];
  delete plan.scaffold_placeholders;
  plan.requirement_closure = [
    "Ticket ask: maintain the coordination reference note.",
    "Implemented: updated the coordination reference note.",
  ];
  plan.repo_gates = ["node --test coord/scripts/governance.test.js"];
  plan.self_review_cycles = [{
    cycle: 1,
    total: 1,
    lens: "contract/state invariants",
    diff: `git diff -- ${intendedFile}`,
    risks: ["stale guidance", "broken references"],
    findings: "none",
    verification: "node --check coord/scripts/governance.test.js",
    verdict: "pass",
    raw: `lens=contract/state invariants; diff=git diff -- ${intendedFile}; risks=stale guidance, broken references; findings=none; verification=node --check coord/scripts/governance.test.js; verdict=pass`,
  }];
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  __testing.advanceGovernanceProvenanceBaseline("coord825-review-composition-fixture");
  return planPath;
}

test("lifecycle move-review uses the plan-record owner to allow a coord-only product ticket", () => {
  const ticketId = "MSRV-825";
  const owner = "claudea825";
  const ctx = setupCoord003Workspace("coord825-review-coord-only-", ticketId, owner);
  const originalLog = console.log;
  try {
    const planPath = prepareReviewableDocsTicket(ctx, ticketId, "coord/docs/COORD-825.md");

    console.log = () => {};
    assert.doesNotThrow(() => governanceCommands.moveReview(ticketId, { pr: ["local-review (no PR)"] }));

    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "review");
    assert.equal(fs.existsSync(ctx.lockPath), false, "successful review releases the doing lock");
    const savedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(savedPlan.intended_files, ["coord/docs/COORD-825.md"]);
    assert.equal(savedPlan.review_submission.repository, "backend");
    assert.equal(savedPlan.review_submission.commit, runGit(ctx.backendRoot, ["rev-parse", "dev"]));
  } finally {
    console.log = originalLog;
    ctx.restore();
  }
});

test("lifecycle move-review refuses a product source commit already on its integration branch", () => {
  const ticketId = "MSRV-827";
  const owner = "claudea827";
  const ctx = setupCoord003Workspace("coord825-review-already-landed-", ticketId, owner, { withCommit: true });
  try {
    const sourceCommit = runGit(ctx.worktreePath, ["rev-parse", "HEAD"]);
    runGit(ctx.backendRoot, ["merge", "--ff-only", sourceCommit]);
    const planPath = prepareReviewableDocsTicket(ctx, ticketId, "backend/docs/COORD-825.md");
    const before = {
      board: fs.readFileSync(ctx.boardPath),
      lock: fs.readFileSync(ctx.lockPath),
      plan: fs.readFileSync(planPath),
    };

    assert.throws(
      () => governanceCommands.moveReview(ticketId, { pr: ["local-review (no PR)"] }),
      (error) => error instanceof GovernanceError && /already appears landed on backend\/dev/.test(error.message),
    );

    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.lockPath), true, "refusal preserves the doing lock");
    assert.deepEqual(fs.readFileSync(ctx.boardPath), before.board);
    assert.deepEqual(fs.readFileSync(ctx.lockPath), before.lock);
    assert.deepEqual(fs.readFileSync(planPath), before.plan);
  } finally {
    ctx.restore();
  }
});

test("lifecycle finalize recovery uses the configured integration branch for provenance steps", () => {
  const ticketId = "MSRV-828";
  const owner = "claudea828";
  const ctx = setupCoord003Workspace("coord825-closeout-integration-branch-", ticketId, owner, {
    ticketStatus: "review",
  });
  const originalLog = console.log;
  try {
    prepareReviewableDocsTicket(ctx, ticketId, "README.md");

    // Model a review-ready refactor whose source is not recorded by a governed
    // commit. Review state has no doing lock, and the no-PR ref is already on
    // the board, so finalize proceeds to the missing-provenance recovery path.
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections.flatMap((section) => section.rows).find((candidate) => candidate.ID === ticketId);
    row.Type = "refactor";
    row.Description = "Extract a lifecycle helper into its owning module.";
    board.pr_index[ticketId] = ["local-review (no PR)"];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    const planPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.change_summary = ["Extracted lifecycle helper into its owning module."];
    plan.feature_proof = ["path:README.md"];
    plan.repo_gates = [
      "node --test coord/scripts/governance.test.js",
      "decomposition-proof: file=README.md; before=1; after=1; claimed_reduction=0; target_max=1; budget=1; rationale=fixture records a composition-only boundary",
    ];
    plan.requirement_closure = [
      "Ticket ask: extract a lifecycle helper.",
      "Implemented: extracted lifecycle helper into its owning module.",
      "Not implemented: none.",
      "Deferred to: none.",
      "Closeout verdict: complete.",
    ];
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    fs.rmSync(ctx.lockPath, { force: true });
    __testing.advanceGovernanceProvenanceBaseline("coord825-closeout-missing-provenance-fixture");
    console.log = () => {};
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const planBefore = fs.readFileSync(planPath);
    const journalBefore = fs.existsSync(ctx.logPath) ? fs.readFileSync(ctx.logPath) : null;
    const landedCommit = runGit(ctx.backendRoot, ["rev-parse", "dev"]);

    assert.throws(
      () => governanceCommands.finalizeTicket(ticketId, {
        noPr: true,
        landed: [`canonical closeout ${landedCommit}`],
      }),
      (error) => error instanceof GovernanceError &&
        /b="dev"; case/.test(error.message) &&
        new RegExp(`gov return-doing ${ticketId}`).test(error.message),
    );

    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "review");
    assert.deepEqual(fs.readFileSync(ctx.boardPath), boardBefore);
    assert.equal(fs.existsSync(ctx.lockPath), false, "review fixture has no doing lock");
    assert.deepEqual(fs.readFileSync(planPath), planBefore);
    if (journalBefore === null) assert.equal(fs.existsSync(ctx.logPath), false);
    else assert.deepEqual(fs.readFileSync(ctx.logPath), journalBefore);
  } finally {
    console.log = originalLog;
    ctx.restore();
  }
});

test("lifecycle doctor requires landing evidence only after a configured repo threshold", () => {
  const ticketId = "MSRV-829";
  const ctx = setupCoord003Workspace("coord825-doctor-landing-threshold-", ticketId, "claudea829", {
    ticketStatus: "done",
  });
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections.flatMap((section) => section.rows).find((candidate) => candidate.ID === ticketId);
    assert.equal(row.Repo, "B");
    board.metadata.landing_index_required_from_ticket.B = "MSRV-800";
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    assert.throws(
      () => governanceCommands.doctor({ ticket: ticketId }),
      (error) => error instanceof GovernanceError &&
        new RegExp(`Ticket ${ticketId} is done but missing landing_index evidence`).test(error.message),
    );

    delete board.metadata.landing_index_required_from_ticket.B;
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    let defaultError = null;
    try {
      governanceCommands.doctor({ ticket: ticketId });
    } catch (error) {
      defaultError = error;
    }
    assert.ok(defaultError === null || defaultError instanceof GovernanceError,
      "doctor either succeeds or reports governed diagnostics");
    assert.doesNotMatch(defaultError?.message || "", new RegExp(`Ticket ${ticketId} is done but missing landing_index evidence`));
  } finally {
    ctx.restore();
  }
});

test("withPreparedTicketWorkspace removes a newly created Repo X workspace when later validation fails", () => {
  // This fixture exercises the intentional /tmp helper-worktree classification;
  // keep that policy path explicit even when the host's TMPDIR is elsewhere.
  const tempDir = fs.mkdtempSync(path.join("/tmp", "legacy-governance-workspace-cleanup-"));
  const worktree = path.join(tempDir, ".worktrees", "codexa00", "DEBT-048");

  assert.throws(
    () =>
      __testing.withPreparedTicketWorkspace(
        {
          repoCode: "X",
          worktree,
          branch: "agent/codexa00-debt-048",
          // This disposable test exercises failed-start cleanup, not base
          // branch selection. HEAD exists in single-branch and release-cut
          // checkouts where a local main ref may not be present.
          base: "HEAD",
        },
        () => {
          assert.equal(fs.existsSync(worktree), true);
          throw new GovernanceError("synthetic failure");
        }
      ),
    (error) => error instanceof GovernanceError && /synthetic failure/.test(error.message)
  );

  assert.equal(fs.existsSync(worktree), false);
});

test("executeCommand captures governance stdout while restoring cwd and env overrides", () => {
  const originalCwd = process.cwd();
  const originalThreadId = process.env.AGENT_THREAD_ID;
  const originalMcpCaller = process.env.GOVERNANCE_MCP_CALLER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-exec-"));

  const result = executeCommand(["counts"], {
    cwd: tempDir,
    env: {
      ...process.env,
      AGENT_THREAD_ID: "exec-thread-test",
      GOVERNANCE_MCP_CALLER: "true",
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.stdout, /^Board:/m);
  assert.equal(result.stderr, "");
  assert.equal(process.cwd(), originalCwd);
  assert.equal(process.env.AGENT_THREAD_ID, originalThreadId);
  assert.equal(process.env.GOVERNANCE_MCP_CALLER, originalMcpCaller);
});

test("counts treats superseded tickets as closed instead of open", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-counts-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "Counts Test Board" },
    sections: [
      {
        rows: [
          { ID: "DONE-001", Repo: "X", Status: "done", Owner: "codexa00", Description: "done" },
          { ID: "SUPER-001", Repo: "X", Status: "superseded", Owner: "codexa00", Description: "retired" },
          { ID: "TODO-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "todo" },
          { ID: "DOING-001", Repo: "X", Status: "doing", Owner: "codexa00", Description: "doing" },
          // COORD-285: a quarantined proposed ticket must NOT count as open work.
          { ID: "PROP-001", Repo: "X", Status: "proposed", Owner: "unassigned", Description: "proposed debt" },
        ],
      },
    ],
  }, null, 2), "utf8");

  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath, LOCKS_DIR: locksDir }, () => {
    const result = executeCommand(["counts"]);
    assert.equal(result.ok, true);
    assert.match(result.stdout, /^Tickets: 5$/m);
    // COORD-285: Open still counts only TODO-001 + DOING-001 — proposed is excluded
    // alongside done/superseded.
    assert.match(result.stdout, /^Open: 2 \(excludes done, superseded, and proposed\)$/m);
    assert.match(result.stdout, /^Closed: 2$/m);
    assert.match(result.stdout, /^Superseded: 1$/m);
    assert.match(result.stdout, /^Proposed: 1 \(awaiting approve\/reject\)$/m);

    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const activeRow = board.sections[0].rows.find((row) => row.ID === "DOING-001");
    activeRow.Status = "done";
    fs.writeFileSync(boardPath, JSON.stringify(board), "utf8");
    const idle = executeCommand(["counts"]);
    assert.equal(idle.ok, true);
    assert.match(idle.stdout, /^Active:\n  none$/m);
  });
});

test("executeCommand returns governance failures without throwing for GovernanceError paths", () => {
  const result = executeCommand(["definitely-not-a-real-command"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown command/);
});

// COORD-099: allBoardRepoCodes unit tests relocated to paths.test.js (its
// owning module, coord/paths.js).

// GOV-008 — gate-failure attribution on add-repo-gate entries
// GOV-008 — stale drift-note retirement
test("GCV-3: computeSyncDelta returns only canonical paths that differ from HEAD (never sweeps unrelated drift)", () => {
  const repo = createTempGitRepo("legacy-gcv3-sync-delta-", {
    "PLAN.md": "initial\n",
    "rendered/TASKS.md": "initial\n",
    "rendered/PROMPT_INDEX.md": "initial\n",
    "unrelated.md": "untouched-by-sync\n",
  }, "seed");
  const paths = [
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ];
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, paths), []);

  writeRepoFile(repo.repoRoot, "PLAN.md", "modified\n");
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, paths), ["PLAN.md"]);

  writeRepoFile(repo.repoRoot, "unrelated.md", "drift the manual board-sync would have swept\n");
  assert.deepEqual(
    __testing.computeSyncDelta(repo.repoRoot, paths),
    ["PLAN.md"],
    "computeSyncDelta must ignore drift outside the canonical path set"
  );

  writeRepoFile(repo.repoRoot, "rendered/TASKS.md", "modified\n");
  assert.deepEqual(
    __testing.computeSyncDelta(repo.repoRoot, paths),
    ["PLAN.md", "rendered/TASKS.md"]
  );
});

test("GCV-3: computeSyncDelta gracefully handles empty / nonsense path inputs", () => {
  const repo = createTempGitRepo("legacy-gcv3-sync-empty-", {
    "PLAN.md": "x\n",
  }, "seed");
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, []), []);
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, ["does-not-exist.md"]), []);
});

test("GCV-3: computeSyncDelta is toplevel-aware (no false-clean when coord is a subdir of an outer repo)", () => {
  // Regression for reviewer finding #1: `git status --porcelain` emits
  // paths relative to the GIT TOPLEVEL. When coord lives as a SUBDIRECTORY
  // of an outer git repo (a consumer that embeds coord rather than running
  // coord as its own repo), porcelain reports `coord/PLAN.md` and a naive
  // includes() filter that expected `PLAN.md` silently drops it → false
  // clean → both `gov sync` and the slice-3 doctor invariant miss real
  // drift. The fix must handle BOTH layouts identically.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv3-subdir-"));
  runGit(outer, ["init", "-b", "main"]);
  runGit(outer, ["config", "user.email", "tests@example.com"]);
  runGit(outer, ["config", "user.name", "Tests"]);
  fs.mkdirSync(path.join(outer, "coord", "rendered"), { recursive: true });
  writeRepoFile(outer, "coord/PLAN.md", "seed\n");
  writeRepoFile(outer, "coord/rendered/TASKS.md", "seed\n");
  writeRepoFile(outer, "coord/rendered/PROMPT_INDEX.md", "seed\n");
  runGit(outer, ["add", "."]);
  runGit(outer, ["commit", "-m", "seed"]);

  const coordDir = path.join(outer, "coord");
  const canonical = ["PLAN.md", "rendered/TASKS.md", "rendered/PROMPT_INDEX.md"];

  // Clean tree → no delta in either layout.
  assert.deepEqual(__testing.computeSyncDelta(coordDir, canonical), []);

  // Drift one canonical path: porcelain emits `coord/PLAN.md` (toplevel-
  // relative); the toplevel-aware filter must still surface it as
  // `PLAN.md` (the caller's coord-relative input form).
  writeRepoFile(outer, "coord/PLAN.md", "drift\n");
  assert.deepEqual(
    __testing.computeSyncDelta(coordDir, canonical),
    ["PLAN.md"],
    "coord-as-subdir must report the drifted canonical path, not silently drop it"
  );

  // Drift another canonical path: still scope-limited (no unrelated sweep).
  writeRepoFile(outer, "coord/rendered/TASKS.md", "drift\n");
  writeRepoFile(outer, "unrelated-outside-coord.md", "drift\n");
  assert.deepEqual(
    __testing.computeSyncDelta(coordDir, canonical),
    ["PLAN.md", "rendered/TASKS.md"],
    "subdir delta must not pick up drift outside the coord subdirectory"
  );
});

test("GCV-3 slice 2: commitCanonicalDelta is scoped by pathspec — pre-existing staged unrelated files do NOT ride along", () => {
  // Reviewer finding #2: the prior `git commit -m <msg>` would commit the
  // WHOLE current index. Auto-trigger after a lifecycle action could then
  // silently include any pre-existing staged files unrelated to the
  // canonical derived surface. The fix passes the delta as an explicit
  // pathspec to `git commit -- <delta>` so the commit is scope-limited
  // regardless of what else is staged.
  const repo = createTempGitRepo("legacy-gcv3-commit-pathspec-", {
    "rendered/TASKS.md": "seed\n",
    "PLAN.md": "seed\n",
    "unrelated.md": "pre-existing tracked unrelated\n",
  }, "seed");

  writeRepoFile(repo.repoRoot, "PLAN.md", "drift\n");
  writeRepoFile(repo.repoRoot, "unrelated.md", "drift unrelated\n");
  runGit(repo.repoRoot, ["add", "unrelated.md"]);
  const preStaged = runGit(repo.repoRoot, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    preStaged.includes("unrelated.md"),
    "test setup: unrelated.md must be pre-staged before commitCanonicalDelta runs"
  );

  // Isolate this Git path-scope test from canonical authority; real CLI
  // authority checks are covered by the integration-authority suite.
  const syncProvenance = require("./sync-provenance.js");
  const syncService = syncProvenance({
    withActiveCommandFence: (_command, run) => run(),
    gitTry,
    fail: (message) => { throw new GovernanceError(message); },
    COORD_DIR: repo.repoRoot,
    DEFAULT_PATHS: { boardPath: path.join(repo.repoRoot, "board/tasks.json") },
  });
  syncService.commitCanonicalDelta(
    repo.repoRoot,
    "test: scope-limited sync",
    ["PLAN.md"]
  );

  const committed = runGit(repo.repoRoot, [
    "show",
    "--name-only",
    "--format=",
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    committed.sort(),
    ["PLAN.md"],
    "auto-sync commit must include ONLY the canonical delta paths, never pre-existing staged unrelated files"
  );
  const stillStaged = runGit(repo.repoRoot, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    stillStaged.includes("unrelated.md"),
    "pre-staged unrelated files must remain in the index for the operator to handle"
  );
});

// ---------------------------------------------------------------------------
// COORD-003: --scope-self parseFlags case, gov unstart, gov block / unblock.
// ---------------------------------------------------------------------------

// COORD-099: the COORD-003 `parseFlags accepts --scope-self` flag-acceptance
// test relocated to lifecycle-flags.test.js (beside cli.js's parseFlags
// data-parallel sibling parseLifecycleFlags).

// COORD-061: the COORD-003 workspace harness (createMinimalGovernanceWorkspace,
// setupCoord003Workspace, readBoardRow) now lives in governance-test-utils.js so
// the relocated transition block/unblock tests can share it.
test("COORD-003 Fix 2: unstart reverts a clean doing ticket to todo and clears owner/lock/worktree", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-happy-", ticketId, owner);
  try {
    governanceCommands.unstartTicket(ticketId, {});
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "lock file must be removed");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("COORD-529: unstart safely resolves the canonical lock path when the lock file is already absent", () => {
  const ticketId = "MSRV-307";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord529-unstart-missing-lock-", ticketId, owner);
  try {
    fs.rmSync(ctx.lockPath, { force: true });
    assert.doesNotThrow(() => governanceCommands.unstartTicket(ticketId, {}));
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false);
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on review evidence (recorded findings)", () => {
  const ticketId = "MSRV-301";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-review-", ticketId, owner);
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.review_findings[ticketId] = [
      { id: `${ticketId}-F1`, severity: "MED", summary: "x", status: "open", round: 1, qref: "L1" },
    ];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    // COORD-273: re-anchor the journal baseline to this fixture edit so the
    // command under test runs over a consistent journal (intent: exercise the
    // review-evidence guard, not the out-of-band seal).
    __testing.advanceGovernanceProvenanceBaseline("coord003-review-fixture");
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /review findings recorded/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on landing evidence (landing_index record)", () => {
  const ticketId = "MSRV-302";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-landing-", ticketId, owner);
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.landing_index[ticketId] = { commit_sha: "abc1234", evidence: ["dev landing"] };
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    // COORD-273: re-anchor the journal baseline to this fixture edit (intent:
    // exercise the landing-evidence guard, not the out-of-band seal).
    __testing.advanceGovernanceProvenanceBaseline("coord003-landing-fixture");
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /landing_index evidence recorded/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on plan evidence (plan advanced past round 1)", () => {
  const ticketId = "MSRV-303";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-plan-", ticketId, owner, { reviewRound: 2 });
  try {
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /review round 2/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on workspace evidence (worktree has commits)", () => {
  const ticketId = "MSRV-304";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-workspace-", ticketId, owner, { withCommit: true });
  try {
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /commit\(s\) ahead of/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with commits must be preserved");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart rejects a foreign owner and directs to admin paths", () => {
  const ticketId = "MSRV-305";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-foreign-", ticketId, owner);
  try {
    // claudea99 is the current session's identity only if it owns the session;
    // here the active session is owner's. Pass an explicit foreign --owner.
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, { owner: "claudea99" }),
      (error) => error instanceof GovernanceError &&
        /same-owner only/.test(error.message) &&
        /release-lock|human-admin-override/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart rejects a non-doing ticket", () => {
  const ticketId = "MSRV-306";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unstart-nondoing-", ticketId, owner, { ticketStatus: "todo" });
  try {
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /must be doing/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

// COORD-009 end-to-end: a freshly-started, completely unworked code ticket
// whose prompt carried a `## Likely Files` section. `gov start` seeded those
// prompt-derived paths into `intended_files` and recorded the same values
// into `scaffold_placeholders.intended_files`. `gov unstart` MUST still
// succeed — the seeded multi-path `intended_files` is start scaffold, not
// authored content.
test("COORD-009: unstart succeeds on an unworked ticket seeded with Likely Files intended_files", () => {
  const ticketId = "MSRV-309";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord009-unstart-seeded-", ticketId, owner);
  try {
    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    // The shape `gov start` produces from a prompt's `## Likely Files`: the
    // implicit worktree placeholder plus prompt-derived paths, with the SAME
    // set recorded as the start seed.
    const seed = [
      `backend/.worktrees/${owner}/${ticketId}/*`,
      "src/auth/session.ts",
      "src/auth/token.ts",
      "src/auth/index.ts",
      "services/api/middleware/auth.ts",
    ];
    record.intended_files = [...seed];
    record.scaffold_placeholders = { intended_files: [...seed] };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    // COORD-273: re-anchor the journal baseline to this plan-record fixture edit
    // (intent: exercise the start-seed comparison, not the out-of-band seal).
    __testing.advanceGovernanceProvenanceBaseline("coord009-seed-fixture");

    assert.doesNotThrow(() => governanceCommands.unstartTicket(ticketId, {}));
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo", "ticket must revert to todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "lock must be cleared");
  } finally {
    ctx.restore();
  }
});

// COORD-009 end-to-end: an `intended_files` entry an agent added beyond the
// recorded start seed is genuine authored work — `gov unstart` must fail
// closed so the work stays on the board.
test("COORD-009: unstart fails closed when intended_files is edited beyond the start seed", () => {
  const ticketId = "MSRV-310";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord009-unstart-edited-", ticketId, owner);
  try {
    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const seed = [
      `backend/.worktrees/${owner}/${ticketId}/*`,
      "src/auth/session.ts",
    ];
    // `intended_files` carries a path NOT in the recorded start seed — the
    // agent ran `gov update-plan --file src/auth/NEW-authored.ts`.
    record.intended_files = [...seed, "src/auth/NEW-authored.ts"];
    record.scaffold_placeholders = { intended_files: [...seed] };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    // COORD-273: re-anchor the journal baseline to this plan-record fixture edit
    // (intent: exercise the authored-content guard, not the out-of-band seal).
    __testing.advanceGovernanceProvenanceBaseline("coord009-edited-fixture");

    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError &&
        /authored content beyond the start scaffold/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
  } finally {
    ctx.restore();
  }
});

// COORD-009 / COORD-566: start records prompt-declared files as the initial
// change surface, without carrying the worktree location into that list.
// Seeding remains a no-op once the record carries authored content.
test("COORD-009: seedStartIntendedFilesFromPrompt records the start seed and is idempotent on authored content", () => {
  const ticketId = "MSRV-311";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord009-seed-", ticketId, owner);
  try {
    // Author a prompt with a `## Likely Files` section.
    const promptPath = path.join(ctx.coordRoot, "prompts", `${ticketId}.md`);
    fs.writeFileSync(promptPath, [
      `# ${ticketId}: seed test.`,
      "",
      "## Likely Files",
      "- `src/auth/session.ts`",
      "- `src/auth/token.ts` — the token path",
      "",
      "## Verification",
      "- `node --test`",
    ].join("\n"), "utf8");

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    // Point prompt_index at the absolute prompt path — readTicketPromptText
    // resolves relative paths against the engine's ROOT_DIR, which the harness
    // does not redirect.
    board.prompt_index = { ...board.prompt_index, [ticketId]: promptPath };
    __testing.seedStartIntendedFilesFromPrompt(ticketId, board);

    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const seeded = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const expectedSeed = ["src/auth/session.ts", "src/auth/token.ts"];
    assert.deepEqual(seeded.intended_files, expectedSeed);
    assert.deepEqual(seeded.scaffold_placeholders.intended_files, expectedSeed);
    // The seeded record is still recognized as start scaffold.
    assert.equal(
      planRecordOwner.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(seeded),
      true
    );

    // Re-seeding after the agent authored a path is a no-op (the record is no
    // longer a pristine scaffold).
    seeded.intended_files = ["src/agent-authored.ts"];
    seeded.scaffold_placeholders = {};
    fs.writeFileSync(recordPath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
    __testing.seedStartIntendedFilesFromPrompt(ticketId, board);
    const afterReseed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.deepEqual(afterReseed.intended_files, ["src/agent-authored.ts"],
      "seeding must not overwrite authored intended_files");
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// COORD-004: gov lock-abandon — the foreign-owner admin counterpart of unstart.
// ---------------------------------------------------------------------------

// Re-point a workspace built by setupCoord003Workspace so the ticket and its
// lock are owned by `claudea99` (registered agent a99) while the current
// session stays `claudea0000`. This is the stale-foreign-lock scenario.
function makeForeignOwned(ctx, ticketId) {
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const row = board.sections[0].rows.find((r) => r.ID === ticketId);
  row.Owner = "claudea99";
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  if (fs.existsSync(ctx.lockPath)) {
    const lock = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    lock.owner = "claudea99";
    lock.agent_id = "a99";
    lock.session_id = "claudea99-stale";
    fs.writeFileSync(ctx.lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
  // COORD-273: this fixture edits the board out-of-band (re-owning the row) after
  // the harness anchored its journal baseline. Re-anchor the baseline to the
  // edited state so the command under test runs over a consistent journal — the
  // intent here is to exercise lock-abandon's own guards, not the out-of-band seal.
  __testing.advanceGovernanceProvenanceBaseline("coord004-foreign-owner-fixture");
}

test("COORD-004: lock-abandon returns a foreign-owned evidence-free doing ticket to todo", () => {
  const ticketId = "MSRV-400";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord004-lockabandon-happy-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    withSignedApprovalRetry("lock-abandon", ticketId, () =>
      governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session, owner offline" }));
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "stale foreign lock must be removed");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("lock-abandon signs and journals the absence of a stale foreign lock and workspace", () => {
  const ticketId = "MSRV-405";
  const ctx = setupCoord003Workspace("lockabandon-no-residue-", ticketId, "claudea0000");
  const reason = "clear a stale foreign owner after workspace removal";
  try {
    fs.unlinkSync(ctx.lockPath);
    runGit(ctx.backendRoot, ["worktree", "remove", ctx.worktreePath]);
    makeForeignOwned(ctx, ticketId);
    const row = readBoardRow(ctx.boardPath, ticketId);
    const identity = require("./lifecycle.js").ensureCurrentAgentIdentity({ allowAutoClaim: false });
    const state = { ticket: row, lock: null, identity: identity.agent, blockers: [] };
    const run = () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: reason });
    withSignedTicketApproval("lock-abandon", ticketId, reason, state, run);

    const updated = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(updated.Status, "todo");
    assert.equal(updated.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false);
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse);
    const event = events.findLast((entry) => entry.command === "lock-abandon" && entry.ticket === ticketId);
    assert.equal(event.details.previous_owner, "claudea99");
    assert.equal(event.details.previous_session_id, null);
    assert.equal(event.details.cleaned_workspace, null);
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon requires --human-admin-override", () => {
  const ticketId = "MSRV-401";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord004-lockabandon-nooverride-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => governanceCommands.lockAbandonTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /requires --human-admin-override/.test(error.message)
    );
    const fixture = createApprovalFixture({ allowedVerbs: ["lock-abandon"] });
    try {
      withApprovalTestClient(coordRoot, fixture.client(), () => assert.throws(
        () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "bare string is not approval" }),
        (error) => error instanceof GovernanceError && /requires a signed human-admin approval/.test(error.message)
      ));
    } finally { fixture.cleanup(); }
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.lockPath), true, "lock must be preserved when rejected");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon rejects a ticket owned by the current session and directs to unstart", () => {
  const ticketId = "MSRV-402";
  const owner = "claudea0000";
  // No makeForeignOwned: the ticket stays owned by the current session.
  const ctx = setupCoord003Workspace("coord004-lockabandon-sameowner-", ticketId, owner);
  try {
    assert.throws(
      () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "any reason" }),
      (error) => error instanceof GovernanceError &&
        /owned by the current session/.test(error.message) &&
        /gov unstart/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon fails closed on review evidence and directs to supersede/reconcile", () => {
  const ticketId = "MSRV-403";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord004-lockabandon-evidence-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.review_findings[ticketId] = [
      { id: `${ticketId}-F1`, severity: "MED", summary: "x", status: "open", round: 1, qref: "L1" },
    ];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    // COORD-273: re-anchor again after the extra review-evidence fixture edit
    // (intent: exercise lock-abandon's evidence guard, not the out-of-band seal).
    __testing.advanceGovernanceProvenanceBaseline("coord004-review-fixture");
    assert.throws(
      () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError &&
        /review findings recorded/.test(error.message) &&
        /supersede|reconcile/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
    assert.equal(fs.existsSync(ctx.lockPath), true, "lock must be preserved on evidence");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon fails closed on workspace evidence (worktree has commits)", () => {
  const ticketId = "MSRV-404";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord004-lockabandon-workspace-", ticketId, owner, { withCommit: true });
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError &&
        /commit\(s\) ahead of/.test(error.message) &&
        /supersede|reconcile/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with commits must be preserved");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon rejects a non-doing ticket", () => {
  const ticketId = "MSRV-405";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord004-lockabandon-nondoing-", ticketId, owner, { ticketStatus: "todo" });
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => governanceCommands.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError && /must be doing/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("open-followup --prefix auto-allocates the next free id under the runtime lock", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("legacy-autoid-openfollowup-", ticketId, owner);
  try {
    governanceCommands.openFollowup(null, {
      prefix: "MSRV",
      dependsOn: ticketId,
      repo: "B",
      type: "followup",
      pri: "P2",
      description: "Auto-allocated follow-up from the parent ticket.",
      relation: "related",
    });
    // Parent is MSRV-300, so the first auto-allocated MSRV id is MSRV-301.
    const created = readBoardRow(ctx.boardPath, "MSRV-301");
    assert.ok(created, "open-followup --prefix must create MSRV-301");
    assert.equal(created.Repo, "B");
    assert.equal(created.Status, "todo");
    assert.equal(created["Depends On"], ticketId);
  } finally {
    ctx.restore();
  }
});

test("open-followup with neither <id> nor --prefix fails closed", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("legacy-autoid-openfollowup-missing-", ticketId, owner);
  try {
    assert.throws(
      () => governanceCommands.openFollowup(null, {
        dependsOn: ticketId,
        repo: "B",
        type: "followup",
        pri: "P2",
        description: "No id and no prefix.",
        relation: "related",
      }),
      (error) => error instanceof GovernanceError && /--prefix <PREFIX> to auto-allocate/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("split-ticket --into B,F creates two auto-allocated repo halves, each related to the umbrella", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("legacy-autoid-split-", ticketId, owner);
  try {
    governanceCommands.splitTicket(ticketId, {
      into: "B,F",
      // prefix is derived from the parent id (MSRV) when omitted.
      description: "Cross-repo split umbrella.",
    });
    // Two new MSRV-* halves, one per repo, auto-allocated from MSRV-300.
    const backendHalf = readBoardRow(ctx.boardPath, "MSRV-301");
    const frontendHalf = readBoardRow(ctx.boardPath, "MSRV-302");
    assert.ok(backendHalf, "split-ticket must create the first auto-allocated half");
    assert.ok(frontendHalf, "split-ticket must create the second auto-allocated half");
    const repos = new Set([backendHalf.Repo, frontendHalf.Repo]);
    assert.deepEqual([...repos].sort(), ["B", "F"], "one half per --into repo");
    // Both halves depend on (are related to) the umbrella, ready immediately.
    assert.equal(backendHalf["Depends On"], ticketId);
    assert.equal(frontendHalf["Depends On"], ticketId);
  } finally {
    ctx.restore();
  }
});

test("ghPrView rethrows a non-transient gh error without retrying", () => {
  const url = "https://github.com/acme/widget/pull/9";
  let calls = 0;
  __testing.setSleepSyncForTesting(() => {});
  __testing.setRunGhForTesting(() => {
    calls += 1;
    throw new Error("could not resolve to a PullRequest with the URL");
  });
  try {
    assert.throws(
      () => __testing.ghPrView(url),
      (error) => /could not resolve to a PullRequest/.test(error.message)
    );
    assert.equal(calls, 1, "a non-transient error must fail on the first attempt");
  } finally {
    __testing.resetRunGhForTesting();
    __testing.resetSleepSyncForTesting();
  }
});

// ---------------------------------------------------------------------------
// COORD-005: workspace-evidence detection compares a governed worktree's HEAD
// against the remote-tracking ref origin/<integration> — never the local
// integration branch, which can lag origin and false-positive the guard.
// ---------------------------------------------------------------------------

// Advance origin/dev one commit past local dev (which stays behind), then move
// the ticket worktree's HEAD onto origin/dev. The worktree thus sits exactly at
// origin/dev while the LOCAL dev branch is stale. Returns the origin/dev SHA.
function advanceOriginAheadOfStaleLocal(ctx) {
  // Local dev is currently the integration branch tip. Add a commit on a
  // throwaway branch and push it to origin/dev so origin moves ahead while
  // the local dev branch ref is left untouched (stale).
  const localDev = runGit(ctx.backendRoot, ["rev-parse", "dev"]);
  runGit(ctx.backendRoot, ["checkout", "-b", "coord005-origin-advance", "dev"]);
  writeRepoFile(ctx.backendRoot, "src/coord005-origin.txt", "advanced on origin\n");
  runGit(ctx.backendRoot, ["add", "."]);
  runGit(ctx.backendRoot, ["commit", "-m", "COORD-005 advance origin/dev"]);
  const originDev = runGit(ctx.backendRoot, ["rev-parse", "HEAD"]);
  runGit(ctx.backendRoot, ["push", "origin", "HEAD:dev"]);
  runGit(ctx.backendRoot, ["checkout", "dev"]);
  runGit(ctx.backendRoot, ["branch", "-D", "coord005-origin-advance"]);
  runGit(ctx.backendRoot, ["fetch", "origin"]);
  // Local dev must still lag origin/dev for this scenario to be meaningful.
  assert.equal(runGit(ctx.backendRoot, ["rev-parse", "dev"]), localDev);
  assert.notEqual(originDev, localDev);
  return originDev;
}

test("COORD-005: resolveWorktreeBaseCompareRef prefers origin/<base> over the local branch", () => {
  const ticketId = "MSRV-500";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord005-comparer-", ticketId, owner);
  try {
    assert.equal(
      __testing.resolveWorktreeBaseCompareRef(ctx.worktreePath, "dev"),
      "origin/dev",
      "should resolve to the remote-tracking ref when origin/dev exists"
    );
    // COORD-898 (1): the shared resolver fails closed when neither origin/<base> nor
    // the local <base> resolves, naming both refs and the remedy. The old literal
    // fallback to the bare base name is retired because it is what made submit fail.
    assert.throws(
      () => __testing.resolveWorktreeBaseCompareRef(ctx.worktreePath, "no-such-branch"),
      (error) => {
        assert.match(String(error.message), /origin\/no-such-branch/);
        assert.match(String(error.message), /local no-such-branch/);
        assert.match(String(error.message), /git fetch origin no-such-branch/);
        return true;
      },
      "neither origin/<base> nor local <base> must fail closed with the named remedy"
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-005: worktree HEAD at origin/<base> is 0 commits ahead even when local <base> is stale", () => {
  const ticketId = "MSRV-501";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord005-stale-local-", ticketId, owner);
  try {
    const originDev = advanceOriginAheadOfStaleLocal(ctx);
    // Point the governed worktree's HEAD exactly at origin/dev — a genuine
    // unworked wrong-start: no commits beyond the remote integration tip.
    runGit(ctx.worktreePath, ["reset", "--hard", originDev]);
    assert.equal(runGit(ctx.worktreePath, ["rev-parse", "HEAD"]), originDev);

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections[0].rows.find((r) => r.ID === ticketId);
    const blockers = __testing.collectUnstartEvidenceBlockers(ticketId, row, board);
    assert.deepEqual(
      blockers,
      [],
      `worktree at origin/dev must yield no workspace blocker; got: ${blockers.join("; ")}`
    );

    // And unstart must succeed end-to-end on this genuine wrong-start.
    governanceCommands.unstartTicket(ticketId, {});
    const after = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(after.Status, "todo");
    assert.equal(after.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("COORD-005: a real commit beyond origin/<base> is STILL detected and fails the guard closed", () => {
  const ticketId = "MSRV-502";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord005-real-ahead-", ticketId, owner);
  try {
    const originDev = advanceOriginAheadOfStaleLocal(ctx);
    // Worktree sits at origin/dev plus one genuine ticket commit on top.
    runGit(ctx.worktreePath, ["reset", "--hard", originDev]);
    writeRepoFile(ctx.worktreePath, "src/coord005-work.txt", "ticket work beyond origin\n");
    runGit(ctx.worktreePath, ["add", "."]);
    runGit(ctx.worktreePath, ["commit", "-m", `${ticketId} real ticket work`]);

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections[0].rows.find((r) => r.ID === ticketId);
    const blockers = __testing.collectUnstartEvidenceBlockers(ticketId, row, board);
    assert.equal(blockers.length, 1, `expected one workspace blocker; got: ${blockers.join("; ")}`);
    assert.match(blockers[0], /1 commit\(s\) ahead of origin\/dev/);

    // unstart must fail closed and preserve the worktree.
    assert.throws(
      () => governanceCommands.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /commit\(s\) ahead of origin\/dev/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with real commits must be preserved");
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// COORD-007: CI parity check for documented lifecycle verbs.
//
// COORD-003/004/005/006 all traced back to GOVERNANCE.md / VERB_CONTRACT.md
// documenting verbs and a flag the engine never implemented. These tests give
// CI a mechanical drift-catcher and also self-test that the catcher WOULD fire
// on a synthetic divergence.
// ---------------------------------------------------------------------------

const COORD007_CLI_SRC = fs.readFileSync(
  path.join(__dirname, "cli.js"),
  "utf8"
);
const COORD007_AGENT_SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "scripts", "agent"),
  "utf8"
);
const COORD007_GOVERNANCE_MD = fs.readFileSync(
  path.join(__dirname, "..", "..", "GOVERNANCE.md"),
  "utf8"
);
const COORD007_VERB_CONTRACT_MD = fs.readFileSync(
  path.join(__dirname, "..", "..", "VERB_CONTRACT.md"),
  "utf8"
);
// COORD-007 verb-parity reads the regression suite to prove every lifecycle
// verb keeps coverage. As governance.test.js is progressively split into
// subject-owned siblings (COORD-090/096/097/098/099), the relocated regression
// tests still count toward parity — concatenate the sibling test sources so a
// verb covered in a split-out file is not falsely reported as uncovered.
// COORD-099 added lifecycle-flags.test.js (cli.js parseFlags acceptance tests,
// which carry agent/gov flag tokens for the flag-parity leg) and
// prompt-coverage.test.js / paths.test.js to this concatenation.
// COORD-100 (facade capstone) relocated the lifecycle.js helper unit tests into
// lifecycle.test.js — those bodies carry lifecycle-verb tokens (finalize / land
// / mark-done / move-review / plan), so add lifecycle.test.js here to keep verb
// parity drift-proof if a verb's only regression token ever lives there.
// COORD-280: the block/unblock regression coverage lives in
// ticket-transitions.test.js (and single-writer-board.test.js). Previously the
// block/unblock verb tokens were incidentally present in this file via the
// ~1,633-key EXPECTED_TESTING_KEYS literal (blockTicket / unblockTicket ...).
// That literal was removed (it was a merge-conflict magnet), so concatenate the
// files that hold the ACTUAL block/unblock regression tests — pointing parity at
// real coverage instead of relying on an incidental substring.
const COORD007_TEST_SRC = [
  fs.readFileSync(__filename, "utf8"),
  ...["governance-validation.test.js", "lifecycle-flags.test.js", "prompt-coverage.test.js", "paths.test.js", "lifecycle.test.js", "ticket-transitions.test.js", "single-writer-board.test.js"]
    .flatMap((name) => [path.join(__dirname, name), path.join(__dirname, "..", "..", "scripts", name)]) // COORD-873: moved or not
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8")),
].join("\n");

test("COORD-007: every documented gov/agent verb resolves and the parity check passes on main", () => {
  const report = verbParity.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD, COORD007_VERB_CONTRACT_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.deepEqual(
    report.missingGovHandlers,
    [],
    `documented \`gov <verb>\` references with no dispatchCommand handler: ${report.missingGovHandlers.join(", ")}`
  );
  assert.deepEqual(
    report.missingAgentVerbs,
    [],
    `documented \`agent <verb>\` references the facade does not expose: ${report.missingAgentVerbs.join(", ")}`
  );
  assert.deepEqual(
    report.missingFlagHandlers,
    [],
    `flags the \`agent\` wrapper passes that parseFlags does not handle: ${report.missingFlagHandlers.join(", ")}`
  );
  assert.equal(report.ok, true, "verb/flag parity check must pass on current main");
  // The docs must reference a non-trivial verb surface — guards against the
  // parser silently matching nothing and the test passing vacuously.
  assert.ok(
    report.documentedGovVerbs.length >= 8,
    `expected the governance docs to reference >=8 gov verbs; got ${report.documentedGovVerbs.length}`
  );
});

test("COORD-007: every lifecycle verb has at least one regression test, or the gap is reported", () => {
  const report = verbParity.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD, COORD007_VERB_CONTRACT_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.deepEqual(
    report.lifecycleVerbsWithoutTests,
    [],
    `lifecycle verbs with no regression coverage: ${report.lifecycleVerbsWithoutTests.join(", ")}`
  );
});

test("COORD-007 self-test: the parity check FAILS when a documented gov verb lacks a handler", () => {
  // Synthetic doc references a bogus `gov teleport` verb that no
  // dispatchCommand case handles. The check must catch it.
  const syntheticDoc = "Operators run `coord/scripts/gov teleport <ticket>` to relocate work.";
  const report = verbParity.runVerbParityCheck({
    docTexts: [syntheticDoc],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.equal(report.ok, false, "a documented verb with no handler must fail the check");
  assert.deepEqual(report.missingGovHandlers, ["teleport"]);
});

test("COORD-007 self-test: the parity check FAILS when the wrapper passes an unhandled flag", () => {
  // Synthetic `agent` wrapper that injects a `--warp-speed` flag parseFlags
  // never accepts — exactly the COORD-003 `--scope-self` class of drift.
  const syntheticAgent = [
    "#!/usr/bin/env bash",
    "case \"$command\" in",
    "  next)",
    "    exec \"$GOV\" pick --mode general --warp-speed",
    "    ;;",
    "esac",
  ].join("\n");
  const report = verbParity.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: syntheticAgent,
    testFileText: COORD007_TEST_SRC,
  });
  assert.equal(report.ok, false, "an unhandled wrapper flag must fail the check");
  assert.ok(
    report.missingFlagHandlers.includes("--warp-speed"),
    `expected --warp-speed in missingFlagHandlers; got ${report.missingFlagHandlers.join(", ")}`
  );
});

test("COORD-007: verb parser only treats backtick-quoted command forms as verbs (no prose drift)", () => {
  // Prose that mentions the words "gov" and "agent" must NOT yield verbs;
  // only complete inline-code spans count.
  const prose = "The agent must run governance carefully. A gov decision matters.";
  assert.deepEqual([...verbParity.parseDocumentedGovVerbs(prose)], []);
  assert.deepEqual([...verbParity.parseDocumentedAgentVerbs(prose)], []);

  // Real command forms ARE recognized, with or without the path prefix.
  const commands = "Run `gov start TICKET` then `coord/scripts/gov mark-done TICKET`.";
  const govVerbs = [...verbParity.parseDocumentedGovVerbs(commands)].sort();
  assert.deepEqual(govVerbs, ["mark-done", "start"]);

  // An unterminated backtick must not let a verb leak out of the span.
  const unterminated = "Broken `gov start and trailing text with no closing tick";
  assert.deepEqual([...verbParity.parseDocumentedGovVerbs(unterminated)], []);
});

test("COORD-007: dispatchCommand verb collector reads the real switch, not a duplicate list", () => {
  const verbs = verbParity.collectDispatchCommandVerbs(COORD007_CLI_SRC);
  // Spot-check verbs the COORD-003/004 work added — proof the collector sees
  // the live switch surface.
  for (const verb of ["start", "unstart", "lock-abandon", "land", "submit"]) {
    assert.ok(verbs.has(verb), `dispatchCommand should expose "${verb}"`);
  }
  // A verb that does not exist must not be reported.
  assert.equal(verbs.has("teleport"), false);
});

// ---------------------------------------------------------------------------
// COORD-008: start gate verifies ticket prompt preconditions.
//
// A ticket prompt may declare an OPTIONAL `## Preconditions` section listing
// artifacts it claims already exist. The start gate verifies each against the
// target repo's integration branch BEFORE lock/worktree creation and fails
// with a clear stale-prompt error if any does not resolve.
// ---------------------------------------------------------------------------

// COORD-099: parsePromptPreconditions / classifyPreconditionArtifact /
// verifyPromptPreconditions unit tests relocated to prompt-coverage.test.js
// (their owning module). The start-gate integration tests below
// (assertPromptRecord, the precondition step, via the runCoord008StartGate harness)
// stay here — they drive the governance start gate end-to-end.

// Shared harness: build a coord workspace + a backend repo, register one
// `todo` ticket with a prompt that declares the given preconditions, then run
// the COORD-008 start-gate hook against it. Returns the thrown error (or null)
// plus the lock path so tests can prove no lock was created on failure.
function runCoord008StartGate(prefix, { repoFiles, promptBody, repoCode = "B" }) {
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace(prefix);
  // Re-seed the backend repo with the requested premise files.
  if (repoFiles && Object.keys(repoFiles).length > 0) {
    for (const [rel, content] of Object.entries(repoFiles)) {
      writeRepoFile(backendRoot, rel, content);
    }
    runGit(backendRoot, ["add", "."]);
    runGit(backendRoot, ["commit", "-m", "coord008 premise"]);
    runGit(backendRoot, ["push", "origin", "dev"]);
  }
  const ticketId = "MSRV-800";
  const promptPath = path.join(coordRoot, "prompts", `${ticketId}.md`);
  // COORD-956: the prompt-record check reads the content contract before the preconditions.
  // The harness supplies a ticket-specific acceptance heading so these tests keep exercising
  // the precondition check; the precondition sections themselves are untouched.
  const promptText = /^## Acceptance/m.test(promptBody)
    ? promptBody
    : `${promptBody}\n## Acceptance Criteria\n\n- Harness acceptance criterion for the precondition gate.\n`;
  fs.writeFileSync(promptPath, promptText, "utf8");

  const board = {
    sections: [{ rows: [{ ID: ticketId, Repo: repoCode, Status: "todo", Owner: "unassigned" }] }],
    // Absolute prompt path — assertPromptRecord honors absolute paths.
    prompt_index: { [ticketId]: promptPath },
  };
  const row = board.sections[0].rows[0];

  let thrown = null;
  withScopedGovernanceTestContext({
    REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, [repoCode]: backendRoot },
    REPO_INTEGRATION_BRANCHES: { ...DEFAULT_PATHS.repoIntegrationBranches, [repoCode]: "dev" },
  }, () => {
    try {
      __testing.assertPromptRecord(ticketId, row, board, {});
    } catch (error) {
      thrown = error;
    }
  });
  return { thrown, ticketId };
}

test("COORD-008: start gate fails with a stale-prompt error when a declared precondition does not resolve", () => {
  const { thrown } = runCoord008StartGate("coord008-startfail-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: gate the call-center route",
      "",
      "## Preconditions",
      "- route:/floor-workscreen",
      "- symbol:src/screens/Call.tsx#CallCenterWorkscreen",
      "",
      "## Likely Files",
      "- src/keep.ts",
    ].join("\n"),
  });
  assert.ok(thrown instanceof GovernanceError, "start gate must fail closed on a stale prompt");
  assert.match(thrown.message, /stale/i);
  assert.match(thrown.message, /\/floor-workscreen/);
  assert.match(thrown.message, /CallCenterWorkscreen/);
});

test("COORD-008: start gate passes when the prompt's declared preconditions are accurate", () => {
  const { thrown } = runCoord008StartGate("coord008-startok-", {
    repoFiles: {
      "src/floor.ts": "export const route = '/floor-workscreen';\n",
      "src/screens/Call.tsx": "export function CallCenterWorkscreen() { return null; }\n",
    },
    promptBody: [
      "# MSRV-800: gate the call-center route",
      "",
      "## Preconditions",
      "- route:/floor-workscreen",
      "- symbol:src/screens/Call.tsx#CallCenterWorkscreen",
      "- path:src/floor.ts",
    ].join("\n"),
  });
  assert.equal(thrown, null, thrown ? `unexpected start-gate failure: ${thrown.message}` : "");
});

test("COORD-008: start gate passes for a prompt with no Preconditions section (back-compat)", () => {
  const { thrown } = runCoord008StartGate("coord008-nosection-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: a normal feature ticket",
      "",
      "## Context",
      "This prompt declares no preconditions.",
      "",
      "## Likely Files",
      "- src/brand-new-file.ts",
    ].join("\n"),
  });
  assert.equal(thrown, null, thrown ? `back-compat prompt must still start: ${thrown.message}` : "");
});

test("COORD-008: Likely Files pointing at to-be-created files never block start", () => {
  const { thrown } = runCoord008StartGate("coord008-likelyfiles-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: create new files",
      "",
      "## Preconditions",
      "- path:src/keep.ts",
      "",
      "## Likely Files",
      "- src/does-not-exist-yet.ts",
      "- src/screens/AlsoNew.tsx",
    ].join("\n"),
  });
  // The only DECLARED precondition (src/keep.ts) resolves; the non-existent
  // "Likely Files" entries are outside the section and must not block.
  assert.equal(thrown, null, thrown ? `Likely Files must not block start: ${thrown.message}` : "");
});

test("COORD-022: isInsideGitWorkTree distinguishes a git repo from an off-git directory", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord022-git-"));
  try {
    const offGit = path.join(base, "off-git");
    fs.mkdirSync(offGit, { recursive: true });
    assert.equal(worktreeOpsOwner.isInsideGitWorkTree(offGit), false);

    const gitDir = path.join(base, "in-git");
    fs.mkdirSync(gitDir, { recursive: true });
    runGit(gitDir, ["init", "-q"]);
    assert.equal(worktreeOpsOwner.isInsideGitWorkTree(gitDir), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("COORD-023: register-prompt happy path writes prompt_index through the board", () => {
  withRegisterPromptHarness("coord023-rp-happy-", {}, ({ promptOnDisk, ticketId, readBoard }) => {
    const result = executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]);
    assert.equal(result.ok, true, `register-prompt should succeed: ${result.error || result.stderr || result.stdout}`);
    const board = readBoard();
    assert.ok(board.prompt_index[ticketId], "prompt_index must now have the ticket");
  });
});

test("COORD-023: register-prompt fails clearly when the prompt file does not exist", () => {
  withRegisterPromptHarness("coord023-rp-missing-", {}, ({ ticketId, tempDir }) => {
    const missing = path.join(tempDir, "nope.md");
    const result = executeCommand(["register-prompt", ticketId, "--path", missing]);
    assert.equal(result.ok, false, "register-prompt must fail on a missing file");
    assert.match(String(result.error || result.stderr || result.stdout), /prompt file not found|not found/i);
  });
});

test("COORD-023: register-prompt with no path defaults to the canonical on-disk prompt and auto-discover registers it", () => {
  // Use COORD-023 itself: its prompt exists at the canonical path on disk, but
  // the temp board has no prompt_index entry — exactly the import-onboarding
  // gap. register-prompt with no --path must resolve and register the default.
  withCanonicalTicketPrompt("COORD-023", "# COORD-023 fixture prompt\n", () => {
    withRegisterPromptHarness("coord023-rp-default-", { ticketId: "COORD-023" }, ({ ticketId, readBoard }) => {
      assert.equal(readBoard().prompt_index[ticketId], undefined, "precondition: not yet registered");
      const result = executeCommand(["register-prompt", ticketId]);
      assert.equal(result.ok, true, `default-path register-prompt should succeed: ${result.error}`);
      assert.equal(readBoard().prompt_index[ticketId], "coord/prompts/tickets/COORD-023.md");
    });
  });
});

test("COORD-023: register-prompt is idempotent and refuses a conflicting remap without --force", () => {
  withRegisterPromptHarness("coord023-rp-force-", {}, ({ promptOnDisk, ticketId, tempDir, readBoard }) => {
    // First registration.
    assert.equal(executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]).ok, true);
    // Same path again is idempotent (success, no overwrite error).
    const idem = executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]);
    assert.equal(idem.ok, true, "re-registering the same path must be idempotent");
    assert.match(String(idem.stdout), /idempotent/i);

    // A different existing path is refused without --force.
    const other = path.join(tempDir, "other.md");
    fs.writeFileSync(other, "# other\n", "utf8");
    const refused = executeCommand(["register-prompt", ticketId, "--path", other]);
    assert.equal(refused.ok, false, "conflicting remap must be refused without --force");
    assert.match(String(refused.error || refused.stderr || refused.stdout), /--force/);

    // With --force it overwrites.
    const forced = executeCommand(["register-prompt", ticketId, "--path", other, "--force"]);
    assert.equal(forced.ok, true, "remap must succeed with --force");
    const board = readBoard();
    assert.match(board.prompt_index[ticketId], /other\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Grooming verbs: set-priority / set-type mutate Pri/Type through gov so the
// canonical board (and the rendered TASKS.md view) stay in sync.
// ---------------------------------------------------------------------------

test("set-priority changes Pri on a non-terminal ticket through gov", () => {
  withRegisterPromptHarness("groom-setpri-", { ticketId: "IMP-700", pri: "P2" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P0"]);
    assert.equal(result.ok, true, `set-priority should succeed: ${result.error || result.stderr || result.stdout}`);
    const row = readBoard().sections[0].rows.find((r) => r.ID === "IMP-700");
    assert.equal(row.Pri, "P0");
  });
});

test("COORD-855: lifecycle closeout adapters route a set-pr transaction and reject a missing finalize ID", () => {
  const ticketId = "COORD-855-ADAPTER";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord855-lifecycle-adapters-", ticketId, owner);
  try {
    // The public lifecycle factory's deferred adapters must reach the ticket
    // admin's normal transaction so toArray and verifyPrEvidence run together.
    const result = executeCommand(["set-pr", ticketId, "--pr", "local-review (no PR)"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).pr_index[ticketId], ["local-review (no PR)"]);
    assert.throws(() => __testing.finalizeTicket(null, {}), /finalize requires <ticket-id>/);
  } finally {
    ctx.restore();
  }
});

test("set-priority rejects an invalid --pri value", () => {
  withRegisterPromptHarness("groom-setpri-bad-", { ticketId: "IMP-700" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P9"]);
    assert.equal(result.ok, false, "invalid --pri must be rejected");
    assert.match(String(result.error || result.stderr || result.stdout), /--pri <P0\|P1\|P2\|P3>/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Pri, "P2");
  });
});

test("set-priority refuses a ticket in a terminal status", () => {
  withRegisterPromptHarness("groom-setpri-done-", { ticketId: "IMP-700", status: "done", pri: "P2" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P0"]);
    assert.equal(result.ok, false, "terminal-status reprioritize must be refused");
    assert.match(String(result.error || result.stderr || result.stdout), /Refusing to reprioritize .* terminal status "done"/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Pri, "P2");
  });
});

test("set-type changes Type on a non-terminal ticket through gov", () => {
  withRegisterPromptHarness("groom-settype-", { ticketId: "IMP-700", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "bug"]);
    assert.equal(result.ok, true, `set-type should succeed: ${result.error || result.stderr || result.stdout}`);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "bug");
  });
});

test("set-type rejects an invalid --type value", () => {
  withRegisterPromptHarness("groom-settype-bad-", { ticketId: "IMP-700", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "epic"]);
    assert.equal(result.ok, false, "invalid --type must be rejected");
    assert.match(String(result.error || result.stderr || result.stdout), /set-type requires --type/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "feature");
  });
});

test("set-type refuses a ticket in a terminal status", () => {
  withRegisterPromptHarness("groom-settype-superseded-", { ticketId: "IMP-700", status: "superseded", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "bug"]);
    assert.equal(result.ok, false, "terminal-status retype must be refused");
    assert.match(String(result.error || result.stderr || result.stdout), /Refusing to retype .* terminal status "superseded"/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "feature");
  });
});

// ---------------------------------------------------------------------------
// COORD-285: approval-gated intake — the `proposed` quarantine status + the two
// human-only governed verbs `gov approve` (proposed -> todo) and `gov reject`
// (proposed -> superseded). These exercise the full governed lane (executeCommand
// -> cli dispatch -> withBoardTransaction) against a real board + agent registry.
// ---------------------------------------------------------------------------

function countJournalEvents() {
  const logPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
  if (!fs.existsSync(logPath)) {
    return 0;
  }
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

function withSignedTicketApproval(verb, ticket, reason, state, run) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const subject_sha256 = approvalVerifier.subjectSha256({ verb, ticket, reason, state: approvalVerifier.canonicalJson(state) });
    fixture.login({ verb, ticket, subject_sha256 });
    return withApprovalTestClient(coordRoot, fixture.client(), run);
  } finally {
    fixture.cleanup();
  }
}

function withSignedApprovalRetry(verb, ticket, run) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    return withApprovalTestClient(coordRoot, fixture.client(), () => {
      try { return run(); } catch (error) {
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
        if (!digest) throw error;
        fixture.login({ verb, ticket, subject_sha256: digest[1] });
        return run();
      }
    });
  } finally { fixture.cleanup(); }
}

test("COORD-285 APPROVE-PROMOTES: gov approve moves proposed -> todo with a signed human approval, then start works", () => {
  withRegisterPromptHarness("prop-approve-", { ticketId: "PROP-700", status: "proposed" }, ({ readBoard }) => {
    const before = countJournalEvents();
    const approvedRow = readBoard().sections[0].rows.find((r) => r.ID === "PROP-700");
    const override = "human admin approves promotion to schedulable work";
    const result = withSignedTicketApproval("approve", "PROP-700", override, approvedRow, () =>
      executeCommand(["approve", "PROP-700", "--owner", "claudea11", "--human-admin-override", override]));
    assert.equal(result.ok, true, `approve should succeed: ${result.error || result.stderr || result.stdout}`);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "PROP-700").Status, "todo");
    assert.equal(countJournalEvents(), before + 2, "approval verification and approve transition are journaled");
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const approveEvent = events.reverse().find((event) => event.command === "approve" && event.ticket === "PROP-700");
    assert.ok(approveEvent.details.human_admin_session);
    assert.ok(approveEvent.details.approval_record);
    assert.match(approveEvent.details.approval_verified, /^key_id=/);
    assert.match(String(result.stdout), /proposed -> todo/);
  });
});

test("COORD-844: gov approve without --owner uses the bound identity through lifecycle wiring", () => {
  withRegisterPromptHarness("prop-approve-bound-", { ticketId: "PROP-700", status: "proposed" }, ({ readBoard }) => {
    const envNames = [
      "COORD_SESSION_ID",
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_SESSION_ID",
    ];
    const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.COORD_SESSION_ID = "coord844-approve-bound-thread";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "coord844-approve-bound-thread";
    try {
      const binding = executeCommand(["agentid", "--owner", "claudea11"]);
      assert.equal(binding.ok, true, `agent binding should succeed: ${binding.error || binding.stderr || binding.stdout}`);
      assert.match(String(binding.stdout), /claudea11/);

      const before = countJournalEvents();
      const approvedRow = readBoard().sections[0].rows.find((entry) => entry.ID === "PROP-700");
      const override = "human admin approves promotion to schedulable work";
      const result = withSignedTicketApproval("approve", "PROP-700", override, approvedRow, () =>
        executeCommand(["approve", "PROP-700", "--human-admin-override", override]));
      assert.equal(result.ok, true, `approve should use the bound identity: ${result.error || result.stderr || result.stdout}`);
      assert.equal(readBoard().sections[0].rows.find((row) => row.ID === "PROP-700").Status, "todo");
      assert.equal(countJournalEvents(), before + 2, "approval verification and approve transition are journaled");
      const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      const approveEvent = events.reverse().find((event) => event.command === "approve" && event.ticket === "PROP-700");
      assert.equal(approveEvent?.identity?.owner, "claudea11", "approve records the bound session as actor");
    } finally {
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  });
});

test("COORD-285 APPROVE fails closed on a non-proposed ticket", () => {
  withRegisterPromptHarness("prop-approve-bad-", { ticketId: "PROP-700", status: "todo" }, ({ readBoard }) => {
    const result = executeCommand(["approve", "PROP-700", "--owner", "claudea11"]);
    assert.equal(result.ok, false, "approving a non-proposed ticket must fail closed");
    assert.match(String(result.error || result.stderr || result.stdout), /only promotes a "proposed" ticket/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "PROP-700").Status, "todo", "status unchanged");
  });
});

test("COORD-285 REJECT-RECORDS: gov reject moves proposed -> superseded with signed approval and reason", () => {
  withRegisterPromptHarness("prop-reject-", { ticketId: "PROP-700", status: "proposed" }, ({ readBoard }) => {
    const before = countJournalEvents();
    const proposedRow = readBoard().sections[0].rows.find((r) => r.ID === "PROP-700");
    const rejectReason = "duplicate of PROP-1";
    const override = "human admin rejects this duplicate proposal";
    const subjectState = { ticket: proposedRow, rejection_reason: rejectReason };
    const result = withSignedTicketApproval("reject", "PROP-700", override, subjectState, () =>
      executeCommand(["reject", "PROP-700", "--owner", "claudea11", "--reason", rejectReason, "--human-admin-override", override]));
    assert.equal(result.ok, true, `reject should succeed: ${result.error || result.stderr || result.stdout}`);
    const row = readBoard().sections[0].rows.find((r) => r.ID === "PROP-700");
    assert.equal(row.Status, "superseded");
    assert.equal(row["Supersede Reason"], "duplicate of PROP-1", "decline reason recorded inline on the row");
    assert.equal(countJournalEvents(), before + 2, "approval verification and reject transition are journaled");
    // The reason is journaled in the reject event details.
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rejectEvent = events.reverse().find((e) => e.command === "reject" && e.ticket === "PROP-700");
    assert.ok(rejectEvent, "a reject event was journaled");
    assert.equal(rejectEvent.details.reason, "duplicate of PROP-1");
    assert.equal(rejectEvent.after_status, "superseded");
    assert.ok(rejectEvent.details.human_admin_session);
    assert.ok(rejectEvent.details.approval_record);
    assert.match(rejectEvent.details.approval_verified, /^key_id=/);
  });
});

test("COORD-285 REJECT requires --reason (fails closed without it)", () => {
  withRegisterPromptHarness("prop-reject-noreason-", { ticketId: "PROP-700", status: "proposed" }, ({ readBoard }) => {
    const result = executeCommand(["reject", "PROP-700", "--owner", "claudea11"]);
    assert.equal(result.ok, false, "reject without --reason must fail closed");
    assert.match(String(result.error || result.stderr || result.stdout), /reject requires --reason/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "PROP-700").Status, "proposed", "status unchanged");
  });
});

test("COORD-285 REJECT fails closed on a non-proposed ticket", () => {
  withRegisterPromptHarness("prop-reject-bad-", { ticketId: "PROP-700", status: "todo" }, ({ readBoard }) => {
    const result = executeCommand(["reject", "PROP-700", "--owner", "claudea11", "--reason", "x"]);
    assert.equal(result.ok, false, "rejecting a non-proposed ticket must fail closed");
    assert.match(String(result.error || result.stderr || result.stdout), /only declines a "proposed" ticket/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "PROP-700").Status, "todo", "status unchanged");
  });
});

test("COORD-285 START-REFUSED: gov start refuses a proposed ticket and directs to gov approve", () => {
  withRegisterPromptHarness("prop-start-", { ticketId: "PROP-700", status: "proposed" }, ({ readBoard }) => {
    const result = executeCommand(["start", "PROP-700", "--owner", "claudea11", "--allow-shared-worktree"]);
    assert.equal(result.ok, false, "starting a proposed ticket must fail closed");
    assert.match(String(result.error || result.stderr || result.stdout), /is "proposed".*gov approve PROP-700/s);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "PROP-700").Status, "proposed", "status unchanged");
  });
});
