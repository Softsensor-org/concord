// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, GovernanceError, runGit, createTempGitRepo } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const governanceContext = require("./governance-context.js");
const createTicketLockService = require("./ticket-lock-service.js");
const lifecycleModule = require("./lifecycle.js");

// COORD-293: behavior tests for the ticket-lock service extracted from
// lifecycle.js into ticket-lock-service.js (lifecycle decomposition slice #2,
// per the COORD-291 boundary contract). The behavior tests below were relocated
// VERBATIM from lifecycle.test.js (refreshLockHead legacy-promote + corrupt-JSON)
// and governance.test.js (ensureDoingTicketLockIntegrity doing-lock recreation) —
// they reach the same fully-wired `__testing` facade, so behavior is
// byte-identical; only the home moved to co-locate the coverage with the module
// that now owns it. The legacy-lock-path compatibility, doing-lock-integrity, and
// the live-holder / stale-lock protections are all exercised through this facade.

// --- DI wiring guard: factory shape + lifecycle composition-root wiring --------

test("COORD-293 wiring: createTicketLockService returns exactly the seven public functions", () => {
  const svc = createTicketLockService({});
  const expected = [
    "resolveLockHead",
    "safeResolveLockHead",
    "refreshLockHead",
    "shouldUseLegacyLockCompatibility",
    "existingLockDirs",
    "resolveTicketLockPath",
    "ensureDoingTicketLockIntegrity",
  ];
  assert.deepEqual(Object.keys(svc).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof svc[name], "function", `${name} must be a function`);
  }
});

test("COORD-293 wiring: lifecycle.js re-exports the extracted lock functions through the __testing facade", () => {
  // BRACKET form (COORD-280 facade-scanner safe): the facade only re-exports the
  // two lock helpers it exported before the move (refreshLockHead +
  // ensureDoingTicketLockIntegrity); the other five stay internal exactly as
  // before, so the facade surface is unchanged by this extraction.
  for (const name of ["refreshLockHead", "ensureDoingTicketLockIntegrity"]) {
    assert.equal(typeof lifecycleModule.__testing[name], "function", `lifecycle __testing[${name}] resolves`);
  }
});

test("product lock-head resolution refuses a successful Git response with no commit id", () => {
  const service = createTicketLockService({
    isRepoBackedCode: (code) => code === "B",
    gitTry: () => ({ status: 0, stdout: "", stderr: "" }),
    fail: (message) => { throw new GovernanceError(message); },
  });

  assert.throws(() => service.resolveLockHead("B", "/repo/.worktrees/codexa00/IMP-644"),
    (error) => error instanceof GovernanceError && /Could not resolve HEAD for worktree/.test(error.message),
    "a nominally successful adapter response cannot create an empty product lock head");
});

// --- legacy-lock-path compatibility (relocated from lifecycle.test.js) ----------

test("refreshLockHead promotes a legacy lock into runtime before rewriting it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-lock-"));
  const repo = createTempGitRepo("coord644-lock-head-repo-", { "README.md": "lock head fixture\n" });
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa00", "IMP-311");
  const branch = "agent/codexa00-imp-311-runtime";
  runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  const gitTry = (cwd, args) => {
    try { return { status: 0, stdout: `${runGit(cwd, args)}\n`, stderr: "" }; }
    catch (error) { return { status: 1, stdout: "", stderr: error.message }; }
  };
  const svc = createTicketLockService({
    state: { LOCKS_DIR: path.join(tempDir, ".runtime", "locks"), LEGACY_LOCKS_DIR: path.join(tempDir, "locks") },
    isRepoBackedCode: () => false,
    repoCodeForLockRepoName: () => "X",
    controlPlaneLayout: () => ({ coordRepoRoot: repo.repoRoot }),
    gitTry,
    readLockFileOrFail: (_ticketId, lockPath) => JSON.parse(fs.readFileSync(lockPath, "utf8")),
    moveFileIfNeeded: (source, target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      return target;
    },
    fail: (message) => { throw new GovernanceError(message); },
  });
  const runtimeLocksDir = path.join(tempDir, ".runtime", "locks");
  const legacyLocksDir = path.join(tempDir, "locks");
  const runtimeLockPath = path.join(runtimeLocksDir, "IMP-311.lock");
  const legacyLockPath = path.join(legacyLocksDir, "IMP-311.lock");
  fs.mkdirSync(legacyLocksDir, { recursive: true });
  fs.writeFileSync(legacyLockPath, JSON.stringify({
    owner: "codexa00",
    ticket: "IMP-311",
    status: "doing",
    repo: "coord",
    branch,
    head: "stale-head",
    worktree,
    started_at_utc: "2026-03-29T12:00:00.000Z",
    heartbeat_utc: "2026-03-29T12:00:00.000Z",
  }, null, 2), "utf8");

  try {
    assert.deepEqual(svc.existingLockDirs(), [legacyLocksDir]);
    svc.refreshLockHead("IMP-311");
    assert.equal(fs.existsSync(runtimeLockPath), true);
    assert.equal(fs.existsSync(legacyLockPath), false);
    assert.deepEqual(svc.existingLockDirs(), [runtimeLocksDir, legacyLocksDir]);
    assert.equal(JSON.parse(fs.readFileSync(runtimeLockPath, "utf8")).head, repo.head);
    assert.throws(() => svc.refreshLockHead("IMP-311", "stale-supplied-head"), GovernanceError);
    assert.equal(JSON.parse(fs.readFileSync(runtimeLockPath, "utf8")).head, repo.head,
      "a caller-supplied commit must not override the registered worktree HEAD");
  } finally {
    runGit(repo.repoRoot, ["worktree", "remove", "--force", worktree]);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
});

test("product lock-head refresh keeps its supplied-head behavior", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-product-head-"));
  const lockPath = path.join(tempDir, "TICKET-1.lock");
  const lock = { repo: "backend", worktree: path.join(tempDir, "worktree"), head: "old-head" };
  fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");
  const svc = createTicketLockService({
    state: { LOCKS_DIR: tempDir, LEGACY_LOCKS_DIR: path.join(tempDir, "legacy") },
    isRepoBackedCode: (repoCode) => repoCode === "B",
    repoCodeForLockRepoName: () => "B",
    resolveTicketLockPath: () => lockPath,
    readLockFileOrFail: () => JSON.parse(fs.readFileSync(lockPath, "utf8")),
    gitTry: () => assert.fail("a supplied product-repo head keeps the existing no-probe behavior"),
    fail: (message) => { throw new GovernanceError(message); },
  });
  try {
    svc.refreshLockHead("TICKET-1", "caller-supplied-product-head");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).head, "caller-supplied-product-head");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Repo X keeps the no-Git sentinel when ADR-0008 finds no control-plane repository", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-no-git-lock-"));
  const svc = createTicketLockService({
    state: { LOCKS_DIR: tempDir, LEGACY_LOCKS_DIR: path.join(tempDir, "legacy") },
    isRepoBackedCode: () => false,
    controlPlaneLayout: () => ({ coordRepoRoot: null }),
    gitTry: () => assert.fail("no-repository topology must not probe an unrelated Git root"),
    fail: (message) => { throw new GovernanceError(message); },
  });
  try {
    assert.equal(svc.resolveLockHead("X", path.join(tempDir, "missing-worktree")), "coord-no-git-head");
    assert.equal(svc.safeResolveLockHead("X", path.join(tempDir, "missing-worktree")), "coord-no-git-head");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Repo X resolves only the registered worktree HEAD, not the integration checkout or enclosing repo", () => {
  const repo = createTempGitRepo("coord644-registered-control-plane-", { "README.md": "control-plane fixture\n" });
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa88", "COORD-644-fixture");
  const detachedWorktree = path.join(repo.repoRoot, ".worktrees", "detached-fixture");
  const featureWorktree = path.join(repo.repoRoot, ".worktrees", "feature-fixture");
  const ordinaryDir = path.join(repo.repoRoot, "ordinary-directory");
  const unrelated = createTempGitRepo("coord644-unrelated-repo-", { "README.md": "unrelated\n" });
  const gitTry = (cwd, args) => {
    try { return { status: 0, stdout: `${runGit(cwd, args)}\n`, stderr: "" }; }
    catch (error) { return { status: 1, stdout: "", stderr: error.message }; }
  };
  const svc = createTicketLockService({
    isRepoBackedCode: () => false,
    controlPlaneLayout: () => ({ coordRepoRoot: repo.repoRoot }),
    gitTry,
    fail: (message) => { throw new GovernanceError(message); },
  });
  runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa88-coord-644-fixture", worktree, "HEAD"]);
  runGit(repo.repoRoot, ["worktree", "add", "--detach", detachedWorktree, "HEAD"]);
  runGit(repo.repoRoot, ["worktree", "add", "-b", "feature/not-a-ticket", featureWorktree, "HEAD"]);
  fs.mkdirSync(ordinaryDir);

  try {
    const serviceWithGitTry = (gitTryImpl) => createTicketLockService({
      isRepoBackedCode: () => false,
      controlPlaneLayout: () => ({ coordRepoRoot: repo.repoRoot }),
      gitTry: gitTryImpl,
      fail: (message) => { throw new GovernanceError(message); },
    });
    runGit(worktree, ["config", "user.name", "COORD test"]);
    runGit(worktree, ["config", "user.email", "coord-test@example.invalid"]);
    fs.writeFileSync(path.join(worktree, "ticket-only.txt"), "worktree commit\n");
    runGit(worktree, ["add", "ticket-only.txt"]);
    runGit(worktree, ["commit", "-m", "ticket worktree only"]);
    const ownHead = runGit(worktree, ["rev-parse", "HEAD"]);
    assert.notEqual(ownHead, repo.head, "the integration checkout and ticket worktree must differ");
    assert.equal(svc.resolveLockHead("X", worktree), ownHead);
    const failedHeadService = createTicketLockService({
      isRepoBackedCode: () => false,
      controlPlaneLayout: () => ({ coordRepoRoot: repo.repoRoot }),
      gitTry: (cwd, args) => cwd === worktree && args[0] === "rev-parse" && args[1] === "HEAD"
        ? { status: 1, stdout: "", stderr: "simulated HEAD read failure" }
        : gitTry(cwd, args),
      fail: (message) => { throw new GovernanceError(message); },
    });
    assert.throws(() => failedHeadService.resolveLockHead("X", worktree),
      /Could not resolve HEAD for worktree/,
      "a registered governed worktree whose final HEAD read fails is refused explicitly");
    assert.equal(svc.safeResolveLockHead("X", ordinaryDir), null,
      "an ordinary directory inherits rev-parse from its parent but is not a registered worktree");
    assert.equal(svc.safeResolveLockHead("X", path.join(repo.repoRoot, "missing-worktree")), null,
      "a removed Repo X worktree cannot retain a resolvable lock head");
    assert.throws(() => svc.resolveLockHead("X", unrelated.repoRoot), GovernanceError,
      "an unrelated Git repository is not part of the control-plane worktree registry");
    assert.throws(() => svc.resolveLockHead("X", detachedWorktree), /not on a governed agent branch/,
      "a registered Git worktree without an agent branch is not an active Repo X ticket worktree");
    assert.equal(svc.safeResolveLockHead("X", detachedWorktree), null,
      "safe Repo X resolution still fails closed for registered detached worktrees");
    assert.throws(() => svc.resolveLockHead("X", featureWorktree), /not on a governed agent branch/,
      "a registered non-agent branch is not a valid Repo X ticket worktree");
    const emptyBranchName = serviceWithGitTry((cwd, args) =>
      cwd === worktree && args[0] === "symbolic-ref"
        ? { status: 0, stdout: "", stderr: "" }
        : gitTry(cwd, args)
    );
    assert.throws(() => emptyBranchName.resolveLockHead("X", worktree), /not on a governed agent branch/,
      "a successful but empty branch-name response fails closed");

    const emptyRegistration = serviceWithGitTry((cwd, args) =>
      cwd === repo.repoRoot && args[0] === "worktree"
        ? { status: 0, stdout: "", stderr: "" }
        : gitTry(cwd, args)
    );
    assert.throws(() => emptyRegistration.resolveLockHead("X", worktree),
      /not a registered control-plane worktree/,
      "a successful but empty worktree registry fails closed");

    const failedTopLevel = serviceWithGitTry((cwd, args) =>
      cwd === worktree && args[0] === "rev-parse" && args[1] === "--show-toplevel"
        ? { status: 1, stdout: "", stderr: "injected top-level probe failure" }
        : gitTry(cwd, args)
    );
    assert.throws(() => failedTopLevel.resolveLockHead("X", worktree), /not its own Git worktree root/,
      "a failed top-level probe refuses the candidate even when Git supplies stderr");

    const emptyTopLevel = serviceWithGitTry((cwd, args) =>
      cwd === worktree && args[0] === "rev-parse" && args[1] === "--show-toplevel"
        ? { status: 0, stdout: "", stderr: "" }
        : gitTry(cwd, args)
    );
    assert.throws(() => emptyTopLevel.resolveLockHead("X", worktree), /not its own Git worktree root/,
      "a successful but empty top-level response cannot establish worktree identity");

    const emptyHead = serviceWithGitTry((cwd, args) =>
      cwd === worktree && args[0] === "rev-parse" && args[1] === "HEAD"
        ? { status: 0, stdout: "", stderr: "" }
        : gitTry(cwd, args)
    );
    assert.throws(() => emptyHead.resolveLockHead("X", worktree), /Could not resolve HEAD for worktree/,
      "a successful Git process with an empty HEAD is not accepted as a commit id");

    fs.rmSync(featureWorktree, { recursive: true, force: true });
    assert.equal(svc.safeResolveLockHead("X", ordinaryDir), null,
      "a stale registered path is ignored and cannot make an ordinary directory a ticket worktree");

    fs.unlinkSync(path.join(worktree, ".git"));
    assert.equal(svc.safeResolveLockHead("X", worktree), null,
      "registered metadata pointing to a worktree with missing .git identity fails closed");
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(unrelated.repoRoot, { recursive: true, force: true });
  }
});

test("Repo X resolver reports missing inputs and preserves Git failures through the service boundary", () => {
  assert.throws(
    () => createTicketLockService.resolveRegisteredControlPlaneWorktreeHead(),
    /Could not verify Repo X worktree \(missing\)/,
    "the shared resolver rejects an omitted options object with a domain error"
  );

  const repo = createTempGitRepo("coord644-resolver-failure-", { "README.md": "disposable\n" });
  const worktree = path.join(repo.repoRoot, "existing-directory");
  fs.mkdirSync(worktree);
  const statusFailure = () => ({ status: 1, stdout: "", stderr: "" });
  const statusError = createTicketLockService.resolveRegisteredControlPlaneWorktreeHead;
  try {
    assert.throws(
      () => statusError({ repoRoot: repo.repoRoot, worktree, gitTry: statusFailure }),
      (error) => error.message.includes(`Could not list control-plane worktrees for ${repo.repoRoot}`),
      "an unsuccessful Git command with empty stderr receives the explicit fallback"
    );

    const service = createTicketLockService({
      isRepoBackedCode: () => false,
      controlPlaneLayout: () => ({ coordRepoRoot: repo.repoRoot }),
      gitTry: () => { throw "simulated git runner failure"; },
      fail: (message) => { throw new GovernanceError(message); },
    });
    assert.throws(() => service.resolveLockHead("X", worktree), (error) => {
      assert.ok(error instanceof GovernanceError);
      assert.match(error.message, /simulated git runner failure/);
      return true;
    });
    assert.equal(service.safeResolveLockHead("X", worktree), null,
      "safe resolution converts a thrown Git runner failure to null");
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
});

test("COORD-644: lock refresh preserves product and no-Git semantics across the shared resolver boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-lock-refresh-branches-"));
  const product = createTempGitRepo("coord644-product-refresh-", { "README.md": "product lock fixture\n" });
  const productWorktree = path.join(product.repoRoot, ".worktrees", "codexa01", "PRODUCT-644");
  const productBranch = "agent/codexa01-product-644";
  const productLockPath = path.join(tempDir, "PRODUCT-644.lock");
  const coordLockPath = path.join(tempDir, "COORD-644.lock");
  runGit(product.repoRoot, ["worktree", "add", "-b", productBranch, productWorktree, "HEAD"]);

  const makeService = ({ repoCode, repoBacked, lockPath, controlPlaneLayout, gitTry: gitTryImpl }) => createTicketLockService({
    state: { LOCKS_DIR: tempDir, LEGACY_LOCKS_DIR: path.join(tempDir, "legacy") },
    isRepoBackedCode: (code) => code === repoCode && repoBacked,
    repoCodeForLockRepoName: () => repoCode,
    resolveTicketLockPath: () => lockPath,
    readLockFileOrFail: (_id, resolvedPath) => JSON.parse(fs.readFileSync(resolvedPath, "utf8")),
    controlPlaneLayout,
    gitTry: gitTryImpl,
    fail: (message) => { throw new GovernanceError(message); },
  });
  const gitTry = (cwd, args) => {
    try { return { status: 0, stdout: `${runGit(cwd, args)}\n`, stderr: "" }; }
    catch (error) { return { status: 1, stdout: "", stderr: error.message }; }
  };

  try {
    fs.writeFileSync(productLockPath, JSON.stringify({ repo: "backend", worktree: productWorktree, head: "old" }));
    const productService = makeService({ repoCode: "B", repoBacked: true, lockPath: productLockPath, gitTry });
    productService.refreshLockHead("PRODUCT-644");
    assert.equal(JSON.parse(fs.readFileSync(productLockPath, "utf8")).head, runGit(productWorktree, ["rev-parse", "HEAD"]),
      "omitting an optional product head resolves the current product worktree commit");

    fs.writeFileSync(coordLockPath, JSON.stringify({ repo: "coord", worktree: path.join(tempDir, "no-worktree"), head: "legacy" }));
    const coordService = makeService({
      repoCode: "X",
      repoBacked: false,
      lockPath: coordLockPath,
      controlPlaneLayout: () => ({ coordRepoRoot: null }),
      gitTry: () => assert.fail("a no-repository Repo X refresh must not probe an enclosing Git root"),
    });
    coordService.refreshLockHead("COORD-644");
    assert.equal(JSON.parse(fs.readFileSync(coordLockPath, "utf8")).head, "coord-no-git-head",
      "legacy no-Git locks normalize to the sentinel without a Git probe");

    const failedProduct = makeService({
      repoCode: "B",
      repoBacked: true,
      lockPath: productLockPath,
      gitTry: () => ({ status: 1, stdout: "", stderr: "simulated worktree HEAD failure" }),
    });
    assert.throws(() => failedProduct.resolveLockHead("B", productWorktree), GovernanceError);
    assert.equal(failedProduct.safeResolveLockHead("B", productWorktree), null,
      "safe resolution converts a failed product probe to an absent anchor for diagnostics");
  } finally {
    runGit(product.repoRoot, ["worktree", "remove", "--force", productWorktree]);
    fs.rmSync(product.repoRoot, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("refreshLockHead fails explicitly when the governed lock JSON is corrupted", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-corrupt-lock-"));
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, "IMP-311.lock"), "{not json}\n", "utf8");

  withScopedGovernanceTestContext({ LOCKS_DIR: locksDir, LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks") }, () => {
    assert.throws(
      () => __testing.refreshLockHead("IMP-311"),
      (error) => error instanceof GovernanceError && /not valid JSON/i.test(error.message)
    );
  });
});

// --- doing-lock integrity: live-holder + recreate (relocated from governance.test.js)

test("ensureDoingTicketLockIntegrity recreates a missing doing lock from the canonical worktree", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-recreate-doing-lock-"));
  const repo = createTempGitRepo("legacy-governance-doing-lock-repo-", {
    "README.md": "lock recreation fixture\n",
  });
  const ticketId = "IMP-997";
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId);
  runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa04-imp-997-fix", worktree, "HEAD"]);

  const boardPath = path.join(tempDir, "tasks.json");
  const locksDir = path.join(tempDir, "locks");
  const legacyLocksDir = path.join(tempDir, "legacy-locks");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(legacyLocksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{
      heading: "Backend",
      rows: [{
        ID: ticketId,
        Repo: "B",
        Status: "doing",
        Owner: "codexa04",
        Description: "Repair lost lock",
        "Depends On": "",
      }],
    }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-current",
      agent_id: "a04",
      handle: "codexa04",
      board_path: boardPath,
      thread_id: "codex-thread-recover-lock",
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: "active",
    },
  ], null, 2));

  const originalEnv = { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, AGENT_THREAD_ID: process.env.AGENT_THREAD_ID };
  process.env.CODEX_THREAD_ID = "codex-thread-recover-lock";
  delete process.env.AGENT_THREAD_ID;

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: legacyLocksDir,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    REPO_ROOTS: { ...governanceContext.DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
  }, () => {
  try {
    const row = {
      ID: ticketId,
      Repo: "B",
      Status: "doing",
      Owner: "codexa04",
      Description: "Repair lost lock",
    };
    const lock = __testing.ensureDoingTicketLockIntegrity(ticketId, row, {});
    assert.equal(lock.owner, "codexa04");
    assert.equal(lock.branch, "agent/codexa04-imp-997-fix");
    assert.equal(lock.worktree, worktree);
    assert.equal(lock.session_id, "a04-current");
    assert.equal(fs.existsSync(path.join(locksDir, `${ticketId}.lock`)), true);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("ensureDoingTicketLockIntegrity refuses unsafe recreation before writing", () => {
  const scenarios = [
    { name: "unassigned owner", row: { Status: "doing", Owner: "unassigned" }, error: /no assigned owner/ },
    { name: "different actor", row: { Status: "doing", Owner: "codexa04" }, identity: "claudea02", error: /cannot auto-recreate its lock/ },
    { name: "missing identity", row: { Status: "doing", Owner: "codexa04" }, identityResult: null, error: /cannot auto-recreate its lock for unknown/ },
    { name: "missing agent", row: { Status: "doing", Owner: "codexa04" }, identityResult: {}, error: /cannot auto-recreate its lock for unknown/ },
    { name: "missing identity handle", row: { Status: "doing", Owner: "codexa04" }, identityResult: { agent: {} }, error: /cannot auto-recreate its lock for unknown/ },
    { name: "empty identity handle", row: { Status: "doing", Owner: "codexa04" }, identityResult: { agent: { handle: "" } }, error: /cannot auto-recreate its lock for unknown/ },
    { name: "missing canonical worktree", row: { Status: "doing", Owner: "codexa04" }, identity: "codexa04", context: { worktree: "/path/that/does/not/exist", branch: "agent/codexa04-x" }, error: /no canonical worktree/ },
  ];
  for (const scenario of scenarios) {
    const calls = [];
    const service = createTicketLockService({
      findLockForTicket: () => null,
      isDoingStatus: (status) => status === "doing",
      canonicalizeOwnerOrFail: (owner) => owner,
      ensureTicketMutationOwnership: () => {
        calls.push("identity");
        return Object.hasOwn(scenario, "identityResult") ? scenario.identityResult : { agent: { handle: scenario.identity } };
      },
      resolveTicketGitContext: () => { calls.push("context"); return scenario.context; },
      writeLock: () => calls.push("write"),
      fail: (message) => { throw new GovernanceError(message); },
    });
    assert.throws(() => service.ensureDoingTicketLockIntegrity("B-1", scenario.row), scenario.error, scenario.name);
    assert.equal(calls.includes("write"), false, `${scenario.name} must not persist a lock`);
    if (scenario.name === "unassigned owner") assert.deepEqual(calls, [], "unassigned owner stops before identity lookup");
    if (scenario.name === "different actor") assert.deepEqual(calls, ["identity"], "wrong actor stops before worktree lookup");
    if (scenario.name.includes("identity") || scenario.name === "missing agent") {
      assert.deepEqual(calls, ["identity"], `${scenario.name} must refuse before canonical worktree lookup`);
    }
  }
});

// COORD-1015: the registered worktree reached through a symlinked parent must
// resolve to the same HEAD as its real path (git reports canonical paths and the
// resolver canonicalizes the caller path). Pins the behaviour the audit found safe.
test("COORD-1015 Repo X worktree head resolves through a symlinked parent directory", () => {
  const repo = createTempGitRepo("coord1015-lock-", { "README.md": "control-plane fixture\n" });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "coord1015-link-"));
  try {
    const worktree = path.join(repo.repoRoot, ".worktrees", "codexa88", "COORD-1015-fixture");
    runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa88-coord-1015-fixture", worktree, "HEAD"]);
    fs.symlinkSync(repo.repoRoot, path.join(linkParent, "alias"), "dir");
    const viaLink = path.join(linkParent, "alias", ".worktrees", "codexa88", "COORD-1015-fixture");
    const gitTry = (cwd, args) => {
      try { return { status: 0, stdout: `${runGit(cwd, args)}\n`, stderr: "" }; }
      catch (error) { return { status: 1, stdout: "", stderr: error.message }; }
    };
    const expected = runGit(worktree, ["rev-parse", "HEAD"]);
    const { resolveRegisteredControlPlaneWorktreeHead } = require("./ticket-lock-service.js");
    const head = resolveRegisteredControlPlaneWorktreeHead({ repoRoot: repo.repoRoot, worktree: viaLink, gitTry, fs, path });
    assert.equal(head, expected);
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
});
