"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");


const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
// COORD-690: RED tests for the second measured instance — `add-feature-proof`
// accepted a symbol that existed nowhere in the canonical tree.
//
// Measured on COORD-667: the proof
// `symbol:engine/scripts/lifecycle-repox-closeout.js#mergeWorkspaceTicketBranches` was
// recorded and passed, while grep across canonical coord/scripts returned zero
// hits and `git grep` at the unlanded branch returned 22. Two different states —
// "reachable only from an unlanded branch" and "never existed anywhere" — were
// indistinguishable, because nothing resolved the proof against any ref at all:
// validation was pure syntax, and the closeout audit that does resolve proofs
// skips repo "X" (isRepoBackedCode("X") === false).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

// COORD-790: plan-record application reads the agent registry under its
// directory lock. Redirect that incidental lock before importing modules that
// can reach governance state, so this test worker never writes into live coord/.
const governanceTestUtils = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const processRuntimeLocksSandboxDir = governanceTestUtils.sandboxProcessRuntimeLocks();

const {
  evaluateFeatureProofEntryInWorktree,
  mainWorktreeBranch,
  parseFeatureProofEntry,
  resolveFeatureProofReachability,
} = require("./feature-proof-resolution.js");
const createPlanRecords = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-records.js"));
const { createFeatureProofEntryValidator } = require("./feature-proof-entry-validation.js");
const { createFeatureProofNormalization } = require("./feature-proof-audit.js");

function git(dir, ...args) {
  const result = gitFixtureSpawn(dir, args);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout || "").trim();
}

// A repo whose canonical tip does NOT contain the symbol and whose feature
// branch does — the exact shape the COORD-667 proof was recorded in.
function repoWithUnlandedSymbol() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-proof-reach-"));
  fs.mkdirSync(path.join(root, "engine", "scripts"), { recursive: true });
  gitFixture(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  fs.writeFileSync(path.join(root, "engine", "scripts", "closeout.js"), "function landed() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "canonical");
  git(root, "checkout", "--quiet", "-b", "agent/unlanded");
  fs.writeFileSync(path.join(root, "engine", "scripts", "closeout.js"), "function landed() {}\nfunction mergeWorkspaceTicketBranches() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "unlanded work");
  git(root, "checkout", "--quiet", "main");
  return root;
}

function candidatesFor(root, { worktree = null } = {}) {
  return [
    { ref: "main", ref_kind: "canonical", repoRoot: root, pathPrefix: "" },
    { ref: "agent/unlanded", ref_kind: "branch", repoRoot: root, pathPrefix: "" },
    ...(worktree ? [{ ref: worktree, ref_kind: "worktree", repoRoot: worktree, pathPrefix: "" }] : []),
  ];
}

test("a symbol reachable only from an unlanded branch resolves AS branch-reachable, not as canonical", () => {
  const root = repoWithUnlandedSymbol();
  const result = resolveFeatureProofReachability("COORD-667", "symbol:engine/scripts/closeout.js#mergeWorkspaceTicketBranches", {
    candidates: candidatesFor(root),
  });
  assert.equal(result.resolved, true);
  assert.equal(result.ref_kind, "branch");
  assert.equal(result.ref, "agent/unlanded");
  assert.equal(result.sha, git(root, "rev-parse", "agent/unlanded"));
  // The canonical miss is retained, so the record says where it is NOT.
  assert.ok(result.attempted.some((entry) => entry.ref_kind === "canonical" && entry.ok === false));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a symbol that exists at NO ref is refused, and the refusal names every ref searched", () => {
  const root = repoWithUnlandedSymbol();
  const result = resolveFeatureProofReachability("COORD-667", "symbol:engine/scripts/closeout.js#neverExistedAnywhere", {
    candidates: candidatesFor(root),
  });
  assert.equal(result.resolved, false);
  assert.equal(result.ref, null);
  assert.match(result.reason, /canonical:main/);
  assert.match(result.reason, /branch:agent\/unlanded/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a proof naming a file that exists nowhere is refused", () => {
  const root = repoWithUnlandedSymbol();
  const result = resolveFeatureProofReachability("COORD-667", "path:scripts/never-written.js", {
    candidates: candidatesFor(root),
  });
  assert.equal(result.resolved, false);
  assert.match(result.reason, /missing path scripts\/never-written\.js/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("canonical wins when a proof resolves at more than one ref", () => {
  const root = repoWithUnlandedSymbol();
  const result = resolveFeatureProofReachability("COORD-667", "symbol:engine/scripts/closeout.js#landed", {
    candidates: candidatesFor(root),
  });
  assert.equal(result.resolved, true);
  assert.equal(result.ref_kind, "canonical");
  fs.rmSync(root, { recursive: true, force: true });
});

test("in-flight work that is written but not yet committed resolves at the worktree", () => {
  const root = repoWithUnlandedSymbol();
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "feature-proof-wt-"));
  fs.mkdirSync(path.join(worktree, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "scripts", "brand-new.js"), "function writtenNotCommitted() {}\n");
  const result = resolveFeatureProofReachability("COORD-690", "symbol:scripts/brand-new.js#writtenNotCommitted", {
    candidates: candidatesFor(root, { worktree }),
  });
  assert.equal(result.resolved, true);
  assert.equal(result.ref_kind, "worktree");
  assert.equal(result.sha, null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("an entry that is not a valid proof is refused without touching git", () => {
  const result = resolveFeatureProofReachability("COORD-690", "just some prose", { candidates: [] });
  assert.equal(result.resolved, false);
  assert.deepEqual(result.attempted, []);
});

test("coord-prefixed path and symbol proofs remain unsupported by the real parser", () => {
  for (const entry of ["coord:path:README.md", "coord:symbol:README.md#Concord", "unknown:path:README.md"]) {
    const parsed = parseFeatureProofEntry(entry);
    assert.equal(parsed.valid, false, entry);
    assert.equal(parsed.kind, entry.split(":", 1)[0], entry);
    assert.match(parsed.reason, /unsupported proof kind/);
    const result = resolveFeatureProofReachability("COORD-798", entry, { candidates: [] });
    assert.equal(result.resolved, false, entry);
    assert.deepEqual(result.attempted, [], entry);
  }
});

test("worktree evaluation distinguishes a missing file from a missing symbol inside it", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "feature-proof-wt-"));
  fs.writeFileSync(path.join(worktree, "present.js"), "const knownSymbol = 1;\n");
  assert.equal(
    evaluateFeatureProofEntryInWorktree(worktree, { valid: true, kind: "symbol", path: "present.js", symbol: "knownSymbol" }).ok,
    true
  );
  assert.match(
    evaluateFeatureProofEntryInWorktree(worktree, { valid: true, kind: "symbol", path: "present.js", symbol: "absentSymbol" }).reason,
    /missing literal "absentSymbol"/
  );
  assert.match(
    evaluateFeatureProofEntryInWorktree(worktree, { valid: true, kind: "symbol", path: "absent.js", symbol: "knownSymbol" }).reason,
    /missing path absent\.js/
  );
  fs.rmSync(worktree, { recursive: true, force: true });
});

// The resolver only closes the gap if the RECORD path actually calls it. These
// tests hold that wiring: without them the resolver is a function nobody runs,
// which is the same presence-not-content shape the ticket is about.
const fs2 = require("node:fs");
const path2 = require("node:path");
const { GovernanceError } = governanceTestUtils;

function createReadonlyPlanRecordHarness() {
  const fail = (message) => { throw new GovernanceError(message); };
  const defaultGovernance = () => ({
    expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null },
    review_profile: "standard",
    ticket_local_repairs: [],
  });
  const { validateFeatureProofEntry } = createFeatureProofEntryValidator({ fail });
  const { normalizeFeatureProofEntryForTicket } = createFeatureProofNormalization({
    parseFeatureProofEntry,
    resolveRepoCodeForTicket: () => "X",
    repoPrefixesForCode: (code) => code === "X" ? ["coord/"] : [],
  });
  return createPlanRecords({
    fail,
    resolveRepoCodeForTicket: () => "X",
    buildDefaultGovernancePlan: defaultGovernance,
    normalizeGovernancePlanShape: (value) => ({ ...defaultGovernance(), ...(value || {}) }),
    formatGovernancePlanEntry: () => "",
    formatGovernanceReviewProfileEntry: () => "",
    formatGovernanceRepairEntry: () => "",
    parseGovernancePlanEntries: defaultGovernance,
    scaffoldSelfReviewCycle: () => ({ cycle: 1, total: 1, raw: "", risks: [] }),
    resolveRepoIntegrationBranch: () => "main",
    isTestingInfrastructureTicket: () => false,
    todayIso: () => "2026-01-01",
    escapeTable: (value) => String(value || ""),
    toArray: (value) => Array.isArray(value) ? value : value == null ? [] : [value],
    normalizeSelfReviewCycleLine: (value) => ({ raw: String(value || ""), risks: [] }),
    parseSelfReviewCycles: () => [],
    validateRequirementClosureEntry: () => {},
    validateFeatureProofEntry,
    normalizeFeatureProofEntryForTicket,
    isMeaningfulText: (value) => String(value || "").trim().length > 0,
    escapeRegex: (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    integerOrDefault: (value, fallback) => Number.isInteger(Number(value)) ? Number(value) : fallback,
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => null,
    inferRequiredReviewRound: () => 1,
    normalizeOwnerValue: (value) => String(value || ""),
    repoNameForCode: () => "coord",
    ensurePlanStub: () => null,
    mergeUniqueRefs: (...groups) => [...new Set(groups.flat())],
    isRepoBackedCode: () => false,
  });
}
const planRecords = createReadonlyPlanRecordHarness();

test("COORD-790: feature-proof plan updates keep the agent-state lock in the worker sandbox", () => {
  const liveAgentStateLock = path2.join(__dirname, "..", "..", ".agent-state.lock");
  assert.equal(governanceState.AGENT_STATE_LOCK_DIR, path2.join(processRuntimeLocksSandboxDir, ".agent-state.lock"));

  planRecords.applyPlanUpdateOptionsToRecord(
    { schema_version: 1, ticket_id: "COORD-790", feature_proof: [] },
    { featureProof: ["path:engine/scripts/guided-closeout.js"] }
  );

  assert.equal(fs2.existsSync(liveAgentStateLock), false, "plan updates must not create a live agent-state lock");
  assert.equal(fs2.existsSync(governanceState.AGENT_STATE_LOCK_DIR), false, "the transient worker lock must be released");
});

test("add-feature-proof REFUSES a symbol that exists at no ref", () => {
  const record = { schema_version: 1, ticket_id: "COORD-690", feature_proof: [] };
  assert.throws(
    () => planRecords.applyPlanUpdateOptionsToRecord(record, {
      featureProof: ["symbol:engine/scripts/guided-closeout.js#thisSymbolHasNeverExisted"],
    }),
    (error) => {
      assert.ok(error instanceof GovernanceError);
      assert.match(error.message, /does not resolve at any known ref/);
      // The refusal must name the search space; "not found" is only actionable
      // when the reader knows where it was looked for.
      assert.match(error.message, /canonical:/);
      return true;
    }
  );
  assert.deepEqual(record.feature_proof, []);
});

test("an accepted proof records the ref it resolved at", () => {
  const record = { schema_version: 1, ticket_id: "COORD-690", feature_proof: [] };
  const next = planRecords.applyPlanUpdateOptionsToRecord(record, {
    featureProof: ["path:engine/scripts/guided-closeout.js"],
  });
  assert.deepEqual(next.feature_proof, ["path:engine/scripts/guided-closeout.js"]);
  const ref = next.feature_proof_refs["path:engine/scripts/guided-closeout.js"];
  assert.ok(ref, "the accepted proof must carry its resolving ref");
  assert.ok(["canonical", "branch", "worktree"].includes(ref.ref_kind));
  assert.ok(ref.ref);
});

test("plan-record application refuses coord-prefixed proofs without mutating the record and preserves ordinary proofs", () => {
  for (const entry of ["coord:path:README.md", "coord:symbol:README.md#Concord", "unknown:path:README.md"]) {
    const original = {
      schema_version: 1,
      ticket_id: "COORD-798",
      feature_proof: ["path:engine/scripts/guided-closeout.js"],
      feature_proof_refs: {
        "path:engine/scripts/guided-closeout.js": {
          ref: "main",
          ref_kind: "canonical",
          sha: "existing-sha",
          resolved_at: "2026-10-02",
        },
      },
    };
    const before = structuredClone(original);
    assert.throws(
      () => planRecords.applyPlanUpdateOptionsToRecord(original, { featureProof: [entry] }),
      (error) => {
        assert.ok(error instanceof GovernanceError);
        assert.match(error.message, /Feature proof entry .* is invalid/i);
        assert.doesNotMatch(error.message, /cross-repo proofs that resolve/i);
        return true;
      },
      entry,
    );
    assert.deepEqual(original, before, `${entry} must not append a proof or ref`);
  }

  const accepted = planRecords.applyPlanUpdateOptionsToRecord({
    schema_version: 1,
    ticket_id: "COORD-798",
    feature_proof: [],
  }, {
    featureProof: [
      "path:engine/scripts/governance-validation.js",
      "symbol:paths.js#resolveEngineModule",
    ],
  });
  assert.deepEqual(accepted.feature_proof, [
    "path:engine/scripts/governance-validation.js",
    "symbol:paths.js#resolveEngineModule",
  ]);
  assert.deepEqual(Object.keys(accepted.feature_proof_refs).sort(), accepted.feature_proof.slice().sort());
  assert.ok(Object.values(accepted.feature_proof_refs).every((ref) => ["canonical", "branch", "worktree"].includes(ref.ref_kind)));
});

test("dropping a proof drops its recorded ref with it", () => {
  const record = { schema_version: 1, ticket_id: "COORD-690", feature_proof: [] };
  const added = planRecords.applyPlanUpdateOptionsToRecord(record, {
    featureProof: ["path:engine/scripts/guided-closeout.js"],
  });
  const dropped = planRecords.applyPlanUpdateOptionsToRecord(added, {
    dropFeatureProof: ["path:engine/scripts/guided-closeout.js"],
  });
  assert.deepEqual(dropped.feature_proof, []);
  assert.equal(dropped.feature_proof_refs, undefined);
});

// The resolver reaches plan-records by a direct require rather than injection,
// precisely so it cannot be silently unwired by a composition root that forgets
// to pass it. This holds that choice: a require that turns back into an
// injected-and-defaulted seam would let every proof be accepted again with
// nothing else failing.
test("the record path requires the resolver directly rather than taking it injected", () => {
  const planRecordsSource = fs2.readFileSync(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-records.js"), "utf8");
  assert.match(planRecordsSource, /require\(resolveEngineModule\([^\n]*"scripts\/feature-proof-resolution\.js"\)\)/);
  const depsBlock = planRecordsSource.slice(
    planRecordsSource.indexOf("module.exports = function createPlanRecords"),
    planRecordsSource.indexOf("} = deps;")
  );
  assert.doesNotMatch(depsBlock, /resolveFeatureProofReachability/);
});

// COORD-690 (review round 1): "canonical" must not mean "HEAD of whichever tree
// the engine is running in". Governance verbs run from the canonical tree and
// code runs in a linked worktree, so a bare HEAD would resolve to main in one
// case and to the ticket's own unlanded branch in the other — labelling a
// branch-only proof canonical and erasing the distinction this ticket adds.
test("the canonical ref is the MAIN working tree's branch, read the same way from a linked worktree", () => {
  const root = repoWithUnlandedSymbol();
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "feature-proof-linked-"));
  const worktreePath = path.join(linked, "wt");
  git(root, "worktree", "add", "--quiet", worktreePath, "agent/unlanded");
  try {
    // Asked from the main tree and from the linked worktree, the answer is the
    // main tree's branch both times — never the linked worktree's own branch.
    assert.equal(mainWorktreeBranch(root), "main");
    assert.equal(mainWorktreeBranch(worktreePath), "main");
  } finally {
    git(root, "worktree", "remove", "--force", worktreePath);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});

// COORD-690 (review round 2): a canonical resolution must read the Git OBJECT at
// the ref, never the files sitting in the main working tree.
//
// The distinction is invisible until the main tree is dirty, and then it is the
// whole point: if resolution touched the filesystem, uncommitted content would
// resolve as "canonical" and be sealed with the main HEAD sha — recreating the
// worktree problem under a strictly stronger label, where the recorded sha names
// a commit that provably does not contain the proof. Every read path is covered
// (cat-file for paths, show for symbols, grep for literals) because a regression
// in any one of them reintroduces the hole on its own.
test("a proof present ONLY as an unstaged edit in the main tree does not resolve as canonical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dirty-canonical-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  gitFixture(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  fs.writeFileSync(path.join(root, "scripts", "mod.js"), "function committedSymbol() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");

  // Everything below this line exists on disk and in NO commit.
  fs.appendFileSync(path.join(root, "scripts", "mod.js"), "function unstagedSymbol() {}\n");
  fs.writeFileSync(path.join(root, "scripts", "untracked.js"), "const untrackedMarker = 1;\n");

  const candidates = [{ ref: "main", ref_kind: "canonical", repoRoot: root, pathPrefix: "" }];
  const resolve = (proof) => resolveFeatureProofReachability("COORD-690", proof, { candidates });

  // The committed symbol resolves, and its sha is the commit that contains it.
  const committed = resolve("symbol:scripts/mod.js#committedSymbol");
  assert.equal(committed.resolved, true);
  assert.equal(committed.ref_kind, "canonical");
  assert.equal(committed.sha, git(root, "rev-parse", "main"));

  // The uncommitted ones must not — one case per read path.
  for (const proof of [
    "symbol:scripts/mod.js#unstagedSymbol", // git show <ref>:<path>
    "path:scripts/untracked.js",            // git cat-file -e <ref>:<path>
    "text:untrackedMarker",                 // git grep -F -- <text> <ref>
  ]) {
    const result = resolve(proof);
    assert.equal(result.resolved, false, `${proof} must not resolve against a dirty working tree`);
    assert.equal(result.sha, null, `${proof} must never be sealed with the main HEAD sha`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
