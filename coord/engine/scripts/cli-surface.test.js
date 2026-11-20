"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");


const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require("./governance-context.js");
// COORD-572 criteria (b), (c) and (d): a capability must be findable by the name
// a caller is likely to GUESS; a JSON field must be findable under BOTH the
// spelling the record uses and the spelling the CLI uses; and an accepted enum
// must be printed AT THE POINT OF USE.
//
// Each of these is a confirmed instance, not a hypothetical:
//   (b) `add-prompt` was filed as a missing verb (COORD-511) while it had
//       already shipped as `register-prompt --create`.
//   (c) `context_pack_ack` vs `contextPackAck` is the split that hid the ack
//       writer from three agents, who then hand-edited the plan record.
//   (d) coord/engine/scripts/gates/business-context.js required one of a six-value closed enum while
//       printing `<owner/status>` (COORD-553, refiled as COORD-569).
//
// Everything asserted here is DERIVED from the live CLI by cli-surface.js, so a
// future flag, verb, enum, or plan field is covered the moment it is added.

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const { spawnSync } = require("node:child_process");

const surface = require("./cli-surface.js");
const cli = require("./cli.js");
surface.bindParser(() => cli.__testing.parseFlags);
const createLifecycleFlags = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-flags.js"));
const { buildHelpText, buildVerbHelpText, parseFlags } = cli.__testing;

test("COORD-562: unknown-flag refusal survives a broken suggestion helper", () => {
  const originalLoad = Module._load;
  Module._load = function loadWithBrokenSuggestions(request, parent, isMain) {
    if (parent && parent.filename === require.resolve("./cli.js") && request === "./cli-surface.js") {
      throw new Error("suggestion table unavailable");
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    assert.throws(() => parseFlags(["--not-a-real-option"]), (error) => {
      assert.match(error.message, /Unknown flag "--not-a-real-option"\./);
      assert.doesNotMatch(error.message, /suggestion table unavailable/);
      return true;
    });
  } finally {
    Module._load = originalLoad;
  }
});

test("COORD-562: direct CLI entry converts governance refusal to a clean failure", () => {
  const childEnv = { PATH: process.env.PATH || "" };
  if (process.env.NODE_V8_COVERAGE) childEnv.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, "cli.js"), "not-a-real-command"], {
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command "not-a-real-command"/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(result.stdout, "");
});

test("COORD-770: public context request is an ownership-bound observation and reader stays read-only", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const savedThread = process.env.AGENT_THREAD_ID;
  const savedCodexThread = process.env.CODEX_THREAD_ID;
  const savedDetectionFlags = clearAmbientDetectionFlags();
  try {
    delete process.env.CODEX_THREAD_ID;
    utils.withRegisterPromptHarness("coord770-context-request-", { ticketId: "CTX-770", status: "doing" }, ({ boardPath }) => {
      const state = governanceState;
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections[0].rows[0].Owner = "claudea11";
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 bound request fixture");
      const command = (args) => cli.executeCommand(args, {
        env: { ...process.env, AGENT_THREAD_ID: "coord770-context-owner-thread" },
      });
      const bound = command(["agentid", "--owner", "claudea11"]);
      assert.equal(bound.ok, true, bound.error);
      const boundSession = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"))
        .find((session) => session.handle === "claudea11" && session.status === "active");
      assert.ok(boundSession, "fixture binds a registered active owner session");
      const lockPath = path.join(state.LOCKS_DIR, "CTX-770.lock");
      fs.writeFileSync(lockPath, `${JSON.stringify({
        ticket: "CTX-770", owner: "claudea11", agent_id: "a11", session_id: boundSession.session_id,
        status: "doing", repo: repoRegistryOwner.repoNameForCode("B"), branch: "dev", head: "fixture-head",
        worktree: path.join(os.tmpdir(), "coord770-context-worktree"),
        started_at_utc: new Date().toISOString(), heartbeat_utc: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 bound owner lock fixture");

      const agentStateBefore = [state.AGENTS_PATH, state.AGENT_SESSIONS_PATH].map((file) => fs.readFileSync(file));
      const snapshotFiles = (files) => files.map((file) => fs.existsSync(file)
        ? { exists: true, bytes: fs.readFileSync(file) }
        : { exists: false });
      assert.equal(fs.existsSync(state.PLAN_PATH), false, "fixture starts with no PLAN.md");
      const protectedBeforeRequest = snapshotFiles([state.BOARD_PATH, state.PLAN_PATH, lockPath]);
      const journalBeforeRequest = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split(/\r?\n/).length;
      const requestedPath = "coord/requirements/COORD-770-unlisted-canary.md";
      const absoluteCanary = path.resolve(requestedPath);
      const guardedFsMethods = ["existsSync", "statSync", "lstatSync", "readFileSync", "realpathSync"];
      const originals = new Map(guardedFsMethods.map((name) => [name, fs[name]]));
      const touches = [];
      for (const name of guardedFsMethods) {
        fs[name] = function refuseCanaryAccess(target, ...args) {
          if (typeof target === "string" && path.resolve(target) === absoluteCanary) {
            touches.push(name);
            throw new Error(`unexpected access to requested context path via ${name}`);
          }
          return originals.get(name).call(this, target, ...args);
        };
      }
      let request;
      try {
        request = command(["request-context", "CTX-770", "--path", requestedPath, "--reason", "Check whether this requirement applies"]);
      } finally {
        for (const [name, original] of originals) fs[name] = original;
      }
      assert.equal(request.ok, true, request.error);
      assert.equal(request.value.access_granted, false);
      assert.deepEqual(touches, [], "requesting context must not stat or read the path");
      assert.deepEqual(snapshotFiles([state.BOARD_PATH, state.PLAN_PATH, lockPath]), protectedBeforeRequest,
        "successful request preserves board/lock bytes and leaves missing PLAN.md absent");
      const journalEvents = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(journalEvents.length, journalBeforeRequest + 1, "request appends one journal observation");
      assert.equal(journalEvents.at(-1).command, "request-context");
      assert.equal(journalEvents.at(-1).result, "succeeded");
      assert.equal(journalEvents.at(-1).details.event_type, "context.requested");
      assert.deepEqual([state.AGENTS_PATH, state.AGENT_SESSIONS_PATH].map((file) => fs.readFileSync(file)), agentStateBefore,
        "ownership validation must not continue or rewrite identity state");

      const beforeRead = snapshotFiles([state.BOARD_PATH, state.PLAN_PATH, state.GOVERNANCE_EVENT_LOG_PATH, lockPath, state.AGENTS_PATH, state.AGENT_SESSIONS_PATH]);
      const listing = command(["context-requests", "CTX-770", "--limit", "5", "--json"]);
      assert.equal(listing.ok, true, listing.error);
      const payload = JSON.parse(listing.stdout);
      assert.equal(payload.observation_only, true);
      assert.equal(payload.count, 1);
      assert.deepEqual({ ...payload.requests[0], requested_at: "<timestamp>" }, {
        ticket: "CTX-770",
        requested_by: "claudea11",
        requested_agent_id: "a11",
        requested_at: "<timestamp>",
        path: requestedPath,
        reason: "Check whether this requirement applies",
      });
      assert.ok(Number.isFinite(Date.parse(payload.requests[0].requested_at)), "reader carries the journal timestamp");
      assert.equal(Object.hasOwn(payload.requests[0], "access_granted"), false);
      assert.deepEqual(
        snapshotFiles([state.BOARD_PATH, state.PLAN_PATH, state.GOVERNANCE_EVENT_LOG_PATH, lockPath, state.AGENTS_PATH, state.AGENT_SESSIONS_PATH]),
        beforeRead,
        "read-only listing leaves board, plan, and journal bytes unchanged"
      );
      assert.deepEqual([state.AGENTS_PATH, state.AGENT_SESSIONS_PATH].map((file) => fs.readFileSync(file)), agentStateBefore,
        "read-only listing and ownership validation leave identity state unchanged");
      assert.equal(fs.existsSync(absoluteCanary), false, "the observation never materializes the requested file");

      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock.owner = "foreign-agent";
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 foreign lock refusal fixture");
      const protectedPaths = [state.BOARD_PATH, state.PLAN_PATH, lockPath, state.AGENTS_PATH, state.AGENT_SESSIONS_PATH];
      const beforeForeignLock = snapshotFiles(protectedPaths);
      const refusedForeignLock = command(["request-context", "CTX-770", "--path", "coord/other.md", "--reason", "This lock is foreign"]);
      assert.equal(refusedForeignLock.ok, false);
      assert.match(refusedForeignLock.error, /Lock for CTX-770 is owned by foreign-agent, not claudea11/i);
      assert.deepEqual(snapshotFiles(protectedPaths), beforeForeignLock,
        "foreign-lock refusal preserves canonical and identity state");
      const afterForeignLockRead = command(["context-requests", "CTX-770", "--json"]);
      assert.equal(afterForeignLockRead.ok, true, afterForeignLockRead.error);
      assert.equal(JSON.parse(afterForeignLockRead.stdout).count, 1,
        "foreign-lock failure is not projected as a successful request");

      lock.owner = "claudea11";
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const sessionsPath = state.AGENT_SESSIONS_PATH;
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      const ownerSession = sessions.find((session) => session.session_id === boundSession.session_id);
      ownerSession.status = "released";
      ownerSession.released_at = new Date().toISOString();
      fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 expired owner session refusal fixture");
      const expiredState = [state.AGENTS_PATH, state.AGENT_SESSIONS_PATH, lockPath].map((file) => fs.readFileSync(file));
      const expired = command(["request-context", "CTX-770", "--path", "coord/expired.md", "--reason", "Owner session ended"]);
      assert.equal(expired.ok, false);
      assert.deepEqual([state.AGENTS_PATH, sessionsPath, lockPath].map((file) => fs.readFileSync(file)), expiredState,
        "expired-session refusal does not revive or rewrite identity/lock state");

      ownerSession.status = "active";
      ownerSession.released_at = null;
      fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
      const agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
      agents[0].status = "disabled";
      fs.writeFileSync(state.AGENTS_PATH, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 disabled agent refusal fixture");
      const disabledState = [state.AGENTS_PATH, sessionsPath, lockPath].map((file) => fs.readFileSync(file));
      const disabled = command(["request-context", "CTX-770", "--path", "coord/disabled.md", "--reason", "Agent disabled"]);
      assert.equal(disabled.ok, false);
      assert.deepEqual([state.AGENTS_PATH, sessionsPath, lockPath].map((file) => fs.readFileSync(file)), disabledState,
        "disabled-agent refusal leaves registered identity and ownership untouched");
      const finalRead = command(["context-requests", "CTX-770", "--json"]);
      assert.equal(finalRead.ok, true, finalRead.error);
      assert.equal(JSON.parse(finalRead.stdout).count, 1, "expired and disabled failures are not successful request evidence");
    });
  } finally {
    if (savedThread === undefined) delete process.env.AGENT_THREAD_ID;
    else process.env.AGENT_THREAD_ID = savedThread;
    if (savedCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = savedCodexThread;
    restoreDetectionFlags(savedDetectionFlags);
  }
});

test("COORD-770: ephemeral refusal and canonical retry use real linked-checkout metadata", () => {
  const sourceCoord = path.resolve(__dirname, "..", "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord770-operating-path-"));
  const canonicalRoot = path.join(tempRoot, "canonical");
  const ephemeralRoot = path.join(tempRoot, "worker");
  fs.mkdirSync(canonicalRoot, { recursive: true });

  // Copy executable source into a disposable repository. Runtime and worktree
  // directories are excluded; the linked worktree is created by Git below.
  const git = (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout.trim();
  };
  const runGov = (root, args, env) => {
    const result = spawnSync("bash", [path.join(root, "coord", "scripts", "gov"), ...args], {
      cwd: root, encoding: "utf8", env,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const snapshotFiles = (files) => files.map((file) => fs.existsSync(file)
    ? { exists: true, bytes: fs.readFileSync(file) }
    : { exists: false });
  try {
    fs.cpSync(sourceCoord, path.join(canonicalRoot, "coord"), {
      recursive: true,
      filter(source) {
        const relative = path.relative(sourceCoord, source);
        const components = relative.split(path.sep);
        const first = components[0];
        if (components.includes(".git") || components.includes(".worktrees")) return false;
        if ([".runtime", "active", "rendered", "locks"].includes(first)) return false;
        return !source.endsWith(".test.js");
      },
    });
    git(canonicalRoot, ["init", "--quiet"]);
    git(canonicalRoot, ["config", "user.name", "COORD-770 fixture"]);
    git(canonicalRoot, ["config", "user.email", "coord770-fixture@example.invalid"]);
    git(canonicalRoot, ["add", "coord"]);
    git(canonicalRoot, ["commit", "--quiet", "-m", "seed isolated governance fixture"]);
    git(canonicalRoot, ["worktree", "add", "--quiet", "-b", "agent/coord770-worker", ephemeralRoot, "HEAD"]);

    const canonicalUtils = require(path.join(canonicalRoot, "coord", "scripts", "governance-test-utils.js"));
    const canonicalContext = require(path.join(canonicalRoot, "coord", "engine", "scripts", "governance-context.js"));
    const ephemeralUtils = require(path.join(ephemeralRoot, "coord", "scripts", "governance-test-utils.js"));
    const ephemeralContext = require(path.join(ephemeralRoot, "coord", "engine", "scripts", "governance-context.js"));
    assert.equal(canonicalContext.detectCheckoutRuntimeRole().role, "canonical_integration_tree");
    assert.equal(ephemeralContext.detectCheckoutRuntimeRole().role, "ephemeral_worktree");

    let fixtureBoard;
    let fixtureAgents;
    canonicalUtils.withRegisterPromptHarness("coord770-canonical-owner-", { ticketId: "CTX-772", status: "doing" }, ({ boardPath }) => {
      const fixture = canonicalContext.state;
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections[0].rows[0].Owner = "claudea11";
      board.sections[0].rows[0].Repo = "X";
      fixtureBoard = Buffer.from(`${JSON.stringify(board, null, 2)}\n`);
      fixtureAgents = fs.readFileSync(fixture.AGENTS_PATH);
    });

    const canonicalState = canonicalContext.state;
    const canonicalRuntime = canonicalState.RUNTIME_DIR;
    assert.equal(canonicalState.BOARD_PATH, path.join(canonicalContext.COORD_DIR, "board", "tasks.json"));
    assert.equal(canonicalState.GOVERNANCE_EVENT_LOG_PATH, path.join(canonicalContext.COORD_DIR, ".runtime", "governance-events.ndjson"));
    fs.mkdirSync(path.join(canonicalRuntime, "locks"), { recursive: true });
    fs.mkdirSync(path.join(canonicalRuntime, "plans"), { recursive: true });
    fs.writeFileSync(canonicalState.BOARD_PATH, fixtureBoard);
    fs.writeFileSync(canonicalState.AGENTS_PATH, fixtureAgents);
    fs.writeFileSync(canonicalState.AGENT_SESSIONS_PATH, "[]\n", "utf8");
    canonicalUtils.__testing.ensureGovernanceJournalBaseline("COORD-770 canonical owner fixture");
    const env = { ...process.env };
    for (const variable of [
      "COORD_SESSION_ID", "COORD_PROVIDER_SESSION_ID", "COORD_INSTANCE_ID", "AGENT_THREAD_ID",
      "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID",
      "GROK_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID", ...runtimeDetectionFlags(),
    ]) delete env[variable];
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ""}`;
    env.AGENT_THREAD_ID = "coord770-same-owner-thread";
    const runCanonicalGov = (args) => runGov(canonicalRoot, args, env);
    const bindResult = runCanonicalGov(["agentid", "--owner", "claudea11"]);
    assert.equal(bindResult.status, 0, bindResult.stderr || bindResult.stdout);
    const ownerSession = JSON.parse(fs.readFileSync(canonicalState.AGENT_SESSIONS_PATH, "utf8"))
      .find((entry) => entry.handle === "claudea11" && entry.status === "active");
    assert.ok(ownerSession, "the canonical checkout registers the worker's active owner session");
    const canonicalLockPath = path.join(canonicalState.LOCKS_DIR, "CTX-772.lock");
    const lock = {
      ticket: "CTX-772", owner: "claudea11", agent_id: "a11", session_id: ownerSession.session_id,
      status: "doing", repo: repoRegistryOwner.repoNameForCode("X"), branch: "agent/coord770-worker",
      head: git(ephemeralRoot, ["rev-parse", "HEAD"]),
      worktree: ephemeralRoot, started_at_utc: new Date().toISOString(), heartbeat_utc: new Date().toISOString(),
    };
    fs.writeFileSync(canonicalLockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    canonicalUtils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 canonical owner lock");
    assert.equal(canonicalContext.canonicalAuthorityWriteIssue(), null,
      "the canonical writer's authority paths are inside its actual canonical checkout");
    const canonicalProtected = [canonicalState.BOARD_PATH, canonicalState.PLAN_PATH, canonicalLockPath,
      canonicalState.AGENTS_PATH, canonicalState.AGENT_SESSIONS_PATH];
    const canonicalBefore = snapshotFiles(canonicalProtected);
    const requestArgs = ["request-context", "CTX-772", "--path", "coord/requirements/COORD-770-extra.md", "--reason", "Need one referenced contract"];

    const ephemeralState = ephemeralContext.state;
    const ephemeralRuntime = ephemeralState.RUNTIME_DIR;
    assert.equal(ephemeralState.BOARD_PATH, path.join(ephemeralContext.COORD_DIR, "board", "tasks.json"));
    assert.equal(ephemeralState.GOVERNANCE_EVENT_LOG_PATH, path.join(ephemeralContext.COORD_DIR, ".runtime", "governance-events.ndjson"));
    assert.equal(fs.existsSync(ephemeralRuntime), false, "the disposable linked checkout starts without runtime authority files");
    fs.copyFileSync(canonicalState.BOARD_PATH, ephemeralState.BOARD_PATH);
    fs.cpSync(canonicalRuntime, ephemeralRuntime, { recursive: true });
    const ephemeralLockPath = path.join(ephemeralState.LOCKS_DIR, "CTX-772.lock");
    const ephemeralProtected = [ephemeralState.BOARD_PATH, ephemeralState.PLAN_PATH, ephemeralLockPath,
      ephemeralState.AGENTS_PATH, ephemeralState.AGENT_SESSIONS_PATH];
    const ephemeralBefore = snapshotFiles(ephemeralProtected);
    const ephemeralJournal = ephemeralState.GOVERNANCE_EVENT_LOG_PATH;
    const journalBefore = fs.readFileSync(ephemeralJournal);
    const runEphemeralGov = (args) => runGov(ephemeralRoot, args, env);
    const refused = runEphemeralGov(requestArgs);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ephemeral linked worktree/i);
    assert.deepEqual(fs.readFileSync(ephemeralJournal), journalBefore,
      "the actual linked-worktree guard refuses without appending request evidence");
    assert.deepEqual(snapshotFiles(ephemeralProtected), ephemeralBefore,
      "refusal preserves the worker's copied registered session, lock, board, and plan bytes");
    const refusedEvents = fs.readFileSync(ephemeralJournal, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(refusedEvents.filter((event) => event.ticket === "CTX-772" && event.details?.event_type === "context.requested").length, 0,
      "a failed ephemeral attempt is not request evidence");

    const canonicalAccepted = runCanonicalGov(requestArgs);
    assert.equal(canonicalAccepted.status, 0, canonicalAccepted.stderr || canonicalAccepted.stdout);
    assert.deepEqual(snapshotFiles(canonicalProtected), canonicalBefore,
      "canonical request preserves board, lock, and registered worker identity bytes");
    const projectionResult = runCanonicalGov(["context-requests", "CTX-772", "--json"]);
    assert.equal(projectionResult.status, 0, projectionResult.stderr || projectionResult.stdout);
    const projection = JSON.parse(projectionResult.stdout);
    assert.equal(projection.count, 1, "only the canonical command is projected");
    assert.equal(projection.requests[0].requested_by, "claudea11");
    assert.equal(projection.requests[0].requested_agent_id, "a11");
    const events = fs.readFileSync(canonicalState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const requestEvents = events.filter((event) => event.ticket === "CTX-772" && event.details?.event_type === "context.requested");
    assert.equal(requestEvents.length, 1, "the canonical retry appends exactly one context.requested event");
    assert.equal(requestEvents[0].identity.owner, "claudea11");
    assert.equal(requestEvents[0].identity.agent_id, "a11");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("COORD-770: refusals never turn an unbound request into a grant or alter board/plan/lock state", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const savedThread = process.env.AGENT_THREAD_ID;
  try {
    delete process.env.AGENT_THREAD_ID;
    utils.withRegisterPromptHarness("coord770-context-refusal-", { ticketId: "CTX-771", status: "doing" }, ({ boardPath }) => {
      const state = governanceState;
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections[0].rows[0].Owner = "claudea11";
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      const lockPath = path.join(state.LOCKS_DIR, "CTX-771.lock");
      fs.writeFileSync(lockPath, `${JSON.stringify({
        ticket: "CTX-771", owner: "claudea11", agent_id: "a11", session_id: "unbound-fixture-session",
        status: "doing", repo: repoRegistryOwner.repoNameForCode("B"), branch: "dev", head: "fixture-head",
        worktree: path.join(os.tmpdir(), "coord770-unbound-worktree"),
        started_at_utc: new Date().toISOString(), heartbeat_utc: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 unbound request fixture");
      const command = (args) => cli.executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "coord770-unbound-thread" } });
      const before = [state.BOARD_PATH, state.PLAN_PATH, path.join(state.LOCKS_DIR, "CTX-771.lock"), state.AGENTS_PATH, state.AGENT_SESSIONS_PATH]
        .map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
      for (const args of [
        ["request-context", "CTX-771", "--path", "coord/secret.md", "--reason", "Need context"],
        ["request-context", "CTX-771", "--path", "../secret.md", "--reason", "Need context"],
        ["request-context", "CTX-771", "--path", "coord/secret.md", "--reason", "\nNeed context"],
        ["request-context", "CTX-771", "--path", "coord/secret.md", "--reason", "Need context", "--path", "coord/other.md"],
        ["request-context", "CTX-771", "--path", "coord/secret.md", "--reason", "Need context", "toString", "ignored"],
        ["request-context", "CTX-771", "--path", "coord/secret.md", "--reason", "Need context", "constructor", "ignored"],
        ["request-context", "MISSING-770", "--path", "coord/secret.md", "--reason", "Need context"],
      ]) {
        const refused = command(args);
        assert.equal(refused.ok, false, `unexpected request success for ${JSON.stringify(args)}`);
      }
      assert.deepEqual(
        [state.BOARD_PATH, state.PLAN_PATH, path.join(state.LOCKS_DIR, "CTX-771.lock"), state.AGENTS_PATH, state.AGENT_SESSIONS_PATH]
          .map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null),
        before,
        "invalid, unknown-ticket, and unbound requests preserve canonical board/plan/lock artifacts"
      );
      const listed = command(["context-requests", "CTX-771", "--json"]);
      assert.equal(listed.ok, true, listed.error);
      assert.equal(JSON.parse(listed.stdout).count, 0, "failed/refused receipts are not presented as successful requests");
    });
  } finally {
    if (savedThread === undefined) delete process.env.AGENT_THREAD_ID;
    else process.env.AGENT_THREAD_ID = savedThread;
  }
});

test("COORD-770: request transaction records a failed drift-note write without claiming it was logged", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const savedThread = process.env.AGENT_THREAD_ID;
  const savedCodexThread = process.env.CODEX_THREAD_ID;
  const savedDetectionFlags = clearAmbientDetectionFlags();
  try {
    delete process.env.CODEX_THREAD_ID;
    utils.withRegisterPromptHarness("coord770-drift-note-write-failure-", { ticketId: "CTX-772", status: "doing" }, ({ boardPath }) => {
      const state = governanceState;
      // Keep the redirected registry outside the special .runtime/ prefix so
      // the drift classifier treats this test-only change as reportable, just
      // like the existing journal drift regression. It remains under tempDir.
      const redirectedAgentsPath = path.join(path.dirname(boardPath), "agents.json");
      fs.copyFileSync(state.AGENTS_PATH, redirectedAgentsPath);
      return utils.withScopedGovernanceTestContext({ AGENTS_PATH: redirectedAgentsPath }, () => {
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections[0].rows[0].Owner = "claudea11";
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 drift-note failure owner fixture");
      const command = (args) => cli.executeCommand(args, {
        env: { ...process.env, AGENT_THREAD_ID: "coord770-drift-note-failure-thread" },
      });
      const bound = command(["agentid", "--owner", "claudea11"]);
      assert.equal(bound.ok, true, bound.error);
      const boundSession = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"))
        .find((session) => session.handle === "claudea11" && session.status === "active");
      assert.ok(boundSession, "fixture binds a registered active owner session");
      const lockPath = path.join(state.LOCKS_DIR, "CTX-772.lock");
      fs.writeFileSync(lockPath, `${JSON.stringify({
        ticket: "CTX-772", owner: "claudea11", agent_id: "a11", session_id: boundSession.session_id,
        status: "doing", repo: repoRegistryOwner.repoNameForCode("B"), branch: "dev", head: "fixture-head",
        worktree: path.join(os.tmpdir(), "coord770-drift-note-worktree"),
        started_at_utc: new Date().toISOString(), heartbeat_utc: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      utils.__testing.advanceGovernanceProvenanceBaseline("COORD-770 drift-note failure lock fixture");

      // A whitespace-only registry change remains valid JSON while creating
      // the harmless runtime drift that causes the transaction to append a note.
      fs.appendFileSync(state.AGENTS_PATH, "\n", "utf8");
      const questionsBefore = fs.readFileSync(state.QUESTIONS_PATH, "utf8");
      const protectedPaths = [state.BOARD_PATH, state.PLAN_PATH, lockPath, state.AGENTS_PATH, state.AGENT_SESSIONS_PATH];
      const protectedBefore = protectedPaths.map((file) => fs.existsSync(file)
        ? { exists: true, bytes: fs.readFileSync(file) }
        : { exists: false });
      const journalBefore = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split(/\r?\n/).length;
      const originalRenameSync = fs.renameSync;
      let injectedQuestionFailure = false;
      let request;
      try {
        fs.renameSync = function failOnlyQuestionNoteRename(source, destination) {
          if (path.resolve(String(destination)) === path.resolve(state.QUESTIONS_PATH)) {
            injectedQuestionFailure = true;
            throw new Error("");
          }
          return originalRenameSync.call(this, source, destination);
        };
        request = command(["request-context", "CTX-772", "--path", "coord/requirements/unlisted-context.md", "--reason", "Request the named context"]);
      } finally {
        fs.renameSync = originalRenameSync;
      }

      assert.equal(injectedQuestionFailure, true, "the failure is injected at the isolated QUESTIONS atomic rename");
      assert.equal(request.ok, true, request.error);
      assert.equal(request.value.access_granted, false);
      assert.equal(fs.readFileSync(state.QUESTIONS_PATH, "utf8"), questionsBefore,
        "failed atomic note replacement leaves no false drift note");
      assert.deepEqual(protectedPaths.map((file) => fs.existsSync(file)
        ? { exists: true, bytes: fs.readFileSync(file) }
        : { exists: false }), protectedBefore,
      "the request leaves board, plan, lock, registry, and session bytes unchanged");

      const events = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(events.length, journalBefore + 1, "the primary transaction still records exactly one success event");
      const event = events.at(-1);
      assert.equal(event.command, "request-context");
      assert.equal(event.result, "succeeded");
      assert.equal(event.details.event_type, "context.requested");
      const agentsDriftPath = path.relative(path.join(__dirname, "..", ".."), state.AGENTS_PATH).replace(/\\/g, "/");
      assert.ok(event.details.preexisting_drift.includes(agentsDriftPath),
        `the transaction records the fixture registry drift at ${agentsDriftPath}`);
      assert.equal(event.details.preexisting_drift_logged_to_questions, false);
      assert.equal(event.details.preexisting_drift_question_log_error, "Error",
        "the empty-message filesystem error is normalized and retained in the journal");
      });
    });
  } finally {
    if (savedThread === undefined) delete process.env.AGENT_THREAD_ID;
    else process.env.AGENT_THREAD_ID = savedThread;
    if (savedCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = savedCodexThread;
    restoreDetectionFlags(savedDetectionFlags);
  }
});

test("COORD-562: direct CLI entry rethrows unexpected failures with their diagnostic context", () => {
  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord562-cli-entry-"));
  const preload = path.join(tempDir, "plain-failure.cjs");
  const cliPath = path.join(__dirname, "cli.js");
  fs.writeFileSync(preload, [
    "const Module = require('node:module');",
    `const expectedCliPath = ${JSON.stringify(cliPath)};`,
    "const originalLoad = Module._load;",
    "Module._load = function loadWithPlainFailure(request, parent, isMain) {",
    "  if (parent && parent.filename === expectedCliPath && request === './lifecycle.js') {",
    "    const lifecycle = originalLoad.call(this, request, parent, isMain);",
    "    const commands = { ...lifecycle.commands, fail: (message) => { throw Object.assign(new Error(message), { name: 'UnexpectedCliFailure' }); } };",
    "    return { ...lifecycle, commands };",
    "  }",
    "  return originalLoad.call(this, request, parent, isMain);",
    "};",
    "",
  ].join("\n"));
  try {
    const childEnv = { PATH: process.env.PATH || "" };
    if (process.env.NODE_V8_COVERAGE) childEnv.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
    const result = childProcess.spawnSync(process.execPath, ["--require", preload, cliPath, "not-a-real-command"], {
      encoding: "utf8",
      env: childEnv,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /UnexpectedCliFailure: Unknown command "not-a-real-command"/);
    assert.ok(
      result.stderr.split(/\r?\n/).some((line) => line.includes(cliPath) && /:\d+:\d+\)$/.test(line)),
      `expected a stack frame for ${cliPath}; stderr was:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-731: update-plan refuses parsed flags its consumer does not accept", () => {
  assert.throws(
    () => cli.__testing.rejectUnsupportedUpdatePlanOptions({ verification: "node --test" }),
    /update-plan does not accept --verification.*Did you mean: --verify/,
  );
  assert.doesNotThrow(() => cli.__testing.rejectUnsupportedUpdatePlanOptions({ verify: ["node --test"] }));
});

const HELP = [buildHelpText({ all: false }), buildHelpText({ all: true })].join("\n");

test("COORD-739: every canonical writer option remains in the shared contract", () => {
  const { PLAN_UPDATE_OPTION_KEYS, JSON_OBJECT_PLAN_FIELDS } = require("./plan-update-options.js");
  const source = fs.readFileSync(path.join(__dirname, "plan-records.js"), "utf8");
  const writer = source.slice(source.indexOf("function applyPlanUpdateOptionsToRecord("),
    source.indexOf("function updateCanonicalPlanState("))
    + fs.readFileSync(path.join(__dirname, "plan-governance-options.js"), "utf8")
    + require("./plan-evidence-supersession.js").applyCorrectionsToRecord.toString();
  const consumed = new Set([...writer.matchAll(/\boptions\.([A-Za-z]\w*)/g)].map((m) => m[1]));
  for (const [key] of JSON_OBJECT_PLAN_FIELDS) consumed.add(key);
  assert.deepStrictEqual([...PLAN_UPDATE_OPTION_KEYS].sort(), [...consumed].sort());
  for (const args of [["--gate-plan", "{}"], ["--bootstrap-risk", "{}"],
    ["--replace-review-cycle", "1", "--review-cycle", "replacement"], ["--drop-review-cycle", "1"]]) {
    assert.doesNotThrow(() => cli.__testing.rejectUnsupportedUpdatePlanOptions(parseFlags(args)));
  }
});

// --- the settled inventory --------------------------------------------------

// The accepted inventory comes from the live CLI parser, not a text scan. Help
// matching uses whole tokens so --env cannot be satisfied by --environment and
// --push cannot be satisfied by --push-before-closeout.
const FLAGS = surface.flagTokens();

function helpHasFlagToken(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`).test(text);
}

test("COORD-572/616: every live accepted flag is documented as a whole token", () => {
  // 192 -> 194: COORD-667 adds `--merge-workspace` and COORD-691 adds
  // `--push-before-closeout`. Both are documented in lifecycle-help.js.
  // COORD-714 adds documented --adr-ref: 194 -> 195, no undocumented allowance.
  // COORD-756 adds documented --correct-merge and --correction-ticket: 197.
  // COORD-695 adds documented --expected-row-digest; --evidence stays repeatable.
  // COORD-685 adds documented --allow-command-probes: 198 -> 199.
  // COORD-686 adds documented --allow-insecure-transport: 199 -> 200.
  // COORD-562 adds documented --show-template-feedback: 200 -> 201.
  // COORD-662 adds documented description/body and six literal prose file flags: 200 -> 208.
  // COORD-713 adds documented --kind, --entry, and --replacement: 209 -> 212.
  // COORD-529 adds documented --ids for explicit requirement links: 212 -> 213.
  // COORD-771 adds documented --expected-prefix-hash and --used-prefix-hash: 213 -> 215.
  // COORD-557 adds documented set-context-pack-ack flags --considered, --authority,
  // --advisory-only, --learning, --rationale and --not-applicable: 215 -> 221.
  // COORD-807 adds documented --disposition for terminal invariant retraction: 221 -> 222.
  // COORD-722 adds documented --expect-paths-file (reconcile approved packet): 222 -> 223.
  // COORD-718 adds documented record-independent-review flags --repository,
  // --review-key, --supersedes, --corrects and --finding: 223 -> 228.
  // COORD-772 adds six documented dispatch/cost flags --dispatch-execution-id,
  // --execution-id, --attempt-id, --measurement-source, --usage-scope and
  // --unknown-reason: 228 -> 234.
  // COORD-860 adds documented --gaps for the record-managed-evidence technical exception: 234 -> 235.
  // COORD-894 adds documented `gov doctor --offline` (skip the remote board-push rules check): 235 -> 236.
  // COORD-924 adds documented `add-repo-gate --selection-manifest` (selected-suite repo-gate evidence): 236 -> 237.
  // COORD-931 adds documented break-runtime-lock --sweep-staging (dry-run staging sweep): 237 -> 238.
  // COORD-972 adds documented add-repo-gate --arch (architecture summary annotation): 238 -> 239.
  // COORD-905 adds documented gov doctor --recover-runs (dry-run dead-run and staging recovery): 239 -> 240.
  // COORD-975 adds documented file-ticket --duplicate-of and --distinct-from (duplicate check before filing): 241 -> 243.
  // COORD-978 adds documented repair-lock-head --expect (expected-state digest for the apply): 240 -> 241.
  // COORD-958 adds gov verify-engine --regenerate (the one regenerate-and-verify step): 243 -> 244.
  // COORD-932 adds documented update-plan --decision-context and --decision-context-file (versioned decision packet): 244 -> 246.
  assert.deepStrictEqual(parseFlags(["--evidence", "first", "--evidence", "second"]).evidence, ["first", "second"]);
  assert.ok(surface.verbs().includes("resolve-question"));
  assert.strictEqual(
    FLAGS.length,
    246,
    `the accepted-flag count moved to ${FLAGS.length}. That is fine when flags are added or removed — ` +
      "update this number and the ratchet below together, deliberately."
  );
  assert.throws(() => parseFlags(["--autofill-startup"]), /Unknown flag/);
  // Every counted token must actually be a flag the live parser accepts. This is
  // what makes 194 a measurement rather than a regex artifact.
  for (const flag of FLAGS) {
    assert.ok(
      surface.flagOptionKeys(flag).length > 0,
      `${flag} is registered in a dispatch table but produces no option key through the live parser.`
    );
  }
  const missing = FLAGS.filter((flag) => !helpHasFlagToken(HELP, flag));
  assert.deepStrictEqual(
    missing,
    [],
    `accepted flags must be documented as whole tokens, not accidentally matched inside aliases or longer flags: ${missing.join(", ")}`
  );
});

test("COORD-662: safe text-file flags are accepted by the public parser", () => {
  assert.deepEqual(
    parseFlags([
      "--description-file", "/tmp/literal description.md",
      "--body-file", "/tmp/literal prompt.md",
    ]),
    {
      descriptionFile: "/tmp/literal description.md",
      bodyFile: "/tmp/literal prompt.md",
    }
  );
  assert.throws(() => parseFlags(["--description-file"]), /--description-file requires a value/);
  assert.throws(() => parseFlags(["--body-file"]), /--body-file requires a value/);

  for (const [flag, optionKey] of [
    ["--description-file", "descriptionFile"],
    ["--body-file", "bodyFile"],
    ["--reason-file", "reason"],
    ["--summary-file", "summary"],
    ["--human-admin-override-file", "humanAdminOverride"],
    ["--landed-file", "landed"],
    ["--review-cycle-file", "reviewCycle"],
    ["--closure-file", "closure"],
  ]) {
    assert.deepStrictEqual(surface.flagOptionKeys(flag), [optionKey]);
  }
  assert.ok(
    surface.enumConstrainedFlags().every(({ flag }) => !flag.endsWith("-file")),
    "file-input options must be recognized as paths, not parser enums."
  );
});

test("COORD-662: prose file flags preserve scalar exclusion and append order in both parsers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-prose-flags-"));
  const file = (name, value) => {
    const target = path.join(tempDir, name);
    fs.writeFileSync(target, value, "utf8");
    return target;
  };
  const values = {
    reason: file("reason.txt", "reason $(literal)\nsecond line\n"),
    summary: file("summary.txt", "summary `$HOME`\n"),
    override: file("override.txt", "approval 'literal'\n"),
    landed: file("landed.txt", "landed `literal`\n"),
    review: file("review.txt", "review cycle $(literal)\n"),
    closure: file("closure.txt", "closure $HOME\n"),
  };
  try {
    const args = [
      "--reason-file", values.reason,
      "--summary-file", values.summary,
      "--human-admin-override-file", values.override,
      "--landed", "inline before", "--landed-file", values.landed, "--landed", "inline after",
      "--review-cycle-file", values.review, "--review-cycle", "inline review",
      "--closure", "inline closure", "--closure-file", values.closure,
    ];
    const expected = {
      reason: fs.readFileSync(values.reason, "utf8"),
      summary: fs.readFileSync(values.summary, "utf8"),
      humanAdminOverride: fs.readFileSync(values.override, "utf8"),
      landed: ["inline before", fs.readFileSync(values.landed, "utf8"), "inline after"],
      reviewCycle: [fs.readFileSync(values.review, "utf8"), "inline review"],
      closure: ["inline closure", fs.readFileSync(values.closure, "utf8")],
    };
    assert.deepStrictEqual(parseFlags(args), expected);

    const lifecycleFlags = createLifecycleFlags({
      fail: (message) => { throw new Error(message); },
      isLegalStatus: () => true,
      LEGAL_FINDING_STATUSES: new Set(),
    });
    assert.deepStrictEqual(lifecycleFlags.parseLifecycleFlags(args), expected);

    for (const [flag, text, key, append] of [
      ["--reason-file", fs.readFileSync(values.reason, "utf8"), "reason", false],
      ["--summary-file", fs.readFileSync(values.summary, "utf8"), "summary", false],
      ["--human-admin-override-file", fs.readFileSync(values.override, "utf8"), "humanAdminOverride", false],
      ["--landed-file", fs.readFileSync(values.landed, "utf8"), "landed", true],
      ["--review-cycle-file", fs.readFileSync(values.review, "utf8"), "reviewCycle", true],
      ["--closure-file", fs.readFileSync(values.closure, "utf8"), "closure", true],
    ]) {
      const filePath = flag === "--reason-file" ? values.reason
        : flag === "--summary-file" ? values.summary
          : flag === "--human-admin-override-file" ? values.override
            : flag === "--landed-file" ? values.landed
              : flag === "--review-cycle-file" ? values.review : values.closure;
      const value = append ? [text] : text;
      assert.deepStrictEqual(parseFlags([flag, filePath]), { [key]: value }, `${flag} must independently load its exact file text`);
      assert.deepStrictEqual(lifecycleFlags.parseLifecycleFlags([flag, filePath]), { [key]: value }, `${flag} lifecycle parser must independently load its exact file text`);
    }

    for (const [inlineFlag, fileFlag, filePath] of [
      ["--reason", "--reason-file", values.reason],
      ["--summary", "--summary-file", values.summary],
      ["--human-admin-override", "--human-admin-override-file", values.override],
    ]) {
      assert.throws(() => parseFlags([inlineFlag, "inline", fileFlag, filePath]), /cannot be combined/);
      assert.throws(() => parseFlags([fileFlag, filePath, inlineFlag, "inline"]), /cannot be combined/);
      assert.throws(() => lifecycleFlags.parseLifecycleFlags([inlineFlag, "inline", fileFlag, filePath]), /cannot be combined/);
      assert.throws(() => lifecycleFlags.parseLifecycleFlags([fileFlag, filePath, inlineFlag, "inline"]), /cannot be combined/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- (b) canonical names AND aliases ---------------------------------------

test("COORD-572 (b): a capability is findable under the name a caller is likely to guess", () => {
  // The exact miss that produced COORD-511.
  const suggestions = surface.suggestVerbs("add-prompt");
  assert.ok(
    suggestions.some((entry) => entry.startsWith("register-prompt")),
    `"add-prompt" must resolve to register-prompt; got ${JSON.stringify(suggestions)}.`
  );
  // And the CLI itself must say so, not just the library.
  const result = cli.executeCommand(["add-prompt"]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Unknown command "add-prompt"/);
  assert.match(result.error, /register-prompt/);

  // Every dispatched verb resolves to itself, so no shipped capability is
  // unreachable by its own name.
  for (const verb of surface.verbs()) {
    const ranked = surface.suggestVerbs(verb, 6).map((entry) => entry.split(" ")[0]);
    assert.ok(ranked.includes(verb), `"${verb}" does not rank itself as a suggestion.`);
  }

  // A mistyped flag suggests the real one rather than only refusing.
  const flagResult = cli.executeCommand(["update-plan", "COORD-000", "--contextpackack", "{}"]);
  assert.strictEqual(flagResult.ok, false);
  assert.match(flagResult.error, /--context-pack-ack/);
});

test("COORD-572 (b): alias groups are derived from the dispatch table and stay consistent", () => {
  const groups = surface.verbAliasGroups();
  const verbs = new Set(surface.verbs());
  const seen = new Set();
  for (const group of groups) {
    for (const verb of group.verbs) {
      assert.ok(verbs.has(verb), `alias group names "${verb}", which is not a dispatched verb.`);
      assert.ok(!seen.has(verb), `"${verb}" appears in more than one alias group.`);
      seen.add(verb);
    }
  }
  assert.deepStrictEqual(
    [...verbs].filter((verb) => !seen.has(verb)),
    [],
    "every dispatched verb must belong to exactly one alias group."
  );
  // Known aliases the router really has, as a fidelity anchor.
  const grouped = groups.map((group) => group.verbs.join(","));
  for (const expected of ["file-ticket,new", "abandon-lock,lock-abandon", "start,start-ticket"]) {
    assert.ok(grouped.includes(expected), `alias derivation lost the known group ${expected}.`);
  }
});

// COORD-1021 (b): the groups are the declaration's handler partition, labelled by the declared function
// name. A pinned fixture: the governance-tier group's label is the bare function name (the one deliberate
// change against the pre-COORD-1021 arm-text label, which was not a function name at all).
test("COORD-1021 (b): alias groups equal the declaration's handler partition, with declared labels", () => {
  const declaration = require("./command-declaration.js");
  const expected = new Map();
  for (const row of declaration.ROWS) {
    const label = row.fn;
    expected.set(label, [...(expected.get(label) || []), row.spelling].sort());
  }
  const derived = surface.verbAliasGroups();
  assert.deepStrictEqual(
    derived.map((group) => group.handler).sort(),
    [...expected.keys()].sort(),
    "one group per declared handler function"
  );
  for (const group of derived) {
    assert.deepStrictEqual(group.verbs, expected.get(group.handler), `group ${group.handler} is the declared partition`);
  }
  const governance = derived.find((group) => group.verbs.includes("guided-closeout"));
  assert.deepStrictEqual(governance, { handler: "runAdoptionGovernanceCommand", verbs: ["governance-tier", "guided-closeout", "publishability-check"] });
  const multi = derived.filter((group) => group.verbs.length > 1).map((group) => group.handler).sort();
  assert.deepStrictEqual(multi, ["commitTicket", "fileTicket", "runTerminalAliasVerb", "lockAbandonTicket", "moveReview", "orchestratorCycle", "printCounts", "recommendTickets", "reopenTicket", "returnDoing", "runAdoptionGovernanceCommand", "runTicketCycle", "startTicket", "unstartTicket"].sort(), "the multi-spelling groups are the declared aliases");
});

// --- (c) JSON field names ---------------------------------------------------

test("COORD-572 (c): every JSON plan field is reachable and published under both spellings", () => {
  const fields = surface.planObjectFields();
  assert.ok(fields.length >= 5, `only ${fields.length} JSON plan fields derived.`);
  for (const field of fields) {
    // The two spellings are mechanically related, so neither can drift.
    const camelFromSnake = field.record_field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.strictEqual(
      camelFromSnake,
      field.option_key,
      `plan field ${field.record_field} and option key ${field.option_key} are not the same name.`
    );
    assert.ok(field.declared_in_schema, `${field.record_field} is written by the CLI but absent from plan.schema.json.`);
    // A WRITER MUST EXIST. bootstrap_risk was schema-declared and gate-enforced
    // with no reachable writer, which is why its gate could only advise a
    // hand-edit of the canonical plan record.
    assert.deepStrictEqual(
      surface.flagOptionKeys(field.flag),
      [field.option_key],
      `${field.flag} does not parse to ${field.option_key} through the live parser.`
    );
    // And it must be discoverable.
    assert.ok(
      HELP.includes(field.flag),
      `${field.flag} writes ${field.record_field} but appears in no help surface.`
    );
  }
  // The writer really writes the canonical snake_case key.
  const planRecords = require("./plan-records.js");
  assert.ok(Array.isArray(planRecords.JSON_OBJECT_PLAN_FIELDS));
  for (const [optionKey, recordField] of planRecords.JSON_OBJECT_PLAN_FIELDS) {
    assert.strictEqual(planRecords.optionKeyToFlag(optionKey), `--${recordField.replace(/_/g, "-")}`);
  }
});

test("COORD-572 (c): `gov surface` publishes both spellings against the writing flag", () => {
  const report = surface.buildSurfaceReport();
  const ack = report.json_fields.find((entry) => entry.record_field === "context_pack_ack");
  assert.ok(ack, "the surface no longer publishes context_pack_ack.");
  assert.strictEqual(ack.option_key, "contextPackAck");
  assert.strictEqual(ack.flag, "--context-pack-ack");
});

// --- (d) accepted enum literals, printed at the point of use ----------------

test("COORD-572 (d): every parser-constrained flag prints its accepted literals, and they are true", () => {
  const constrained = surface.enumConstrainedFlags();
  assert.ok(constrained.length >= 3, `only ${constrained.length} enum-constrained flags found.`);
  for (const entry of constrained) {
    assert.ok(
      entry.advertised.length > 0,
      `${entry.flag} rejects values but its refusal names no accepted literal, so the only way to learn ` +
        `the enum is to read the source. Message was: ${entry.message}`
    );
    // Advertised is not the same as true. Every literal the message names is
    // re-fed through the live parser, so advice that lists the WRONG values
    // fails exactly as loudly as advice that lists none.
    assert.deepStrictEqual(
      entry.advertised,
      entry.accepted,
      `${entry.flag} advertises literal(s) the parser rejects: ` +
        `${entry.advertised.filter((value) => !entry.accepted.includes(value)).join(", ")}`
    );
  }
  const status = constrained.find((entry) => entry.flag === "--status");
  assert.ok(status, "--status is no longer detected as enum-constrained.");
  const { legalStatusSet, legalFindingStatusSet } = require("./governance-constants.js");
  for (const value of [...legalStatusSet(), ...legalFindingStatusSet()]) {
    assert.ok(
      status.accepted.includes(value),
      `--status accepts "${value}" but does not advertise it.`
    );
  }
});

test("COORD-572 (d): the business-context closed enum is printed by the gate that enforces it", () => {
  const businessContext = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  const statuses = businessContext.BUSINESS_CONTEXT_INVESTIGATION_STATUSES;
  assert.ok(statuses.length >= 6, "the investigation status enum shrank unexpectedly.");
  const source = fs.readFileSync(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"), "utf8");
  assert.ok(
    source.includes("BUSINESS_CONTEXT_INVESTIGATION_STATUSES.join"),
    "the gate no longer derives its printed remediation from the enum constant, so the two can drift again."
  );
  // The remediation the gate emits must satisfy the recognizer that emitted it.
  for (const status of statuses) {
    assert.match(
      `business-context investigation: ${status}`,
      businessContext.BUSINESS_CONTEXT_INVESTIGATION_PATTERN,
      `the gate accepts "${status}" but its own recognizer does not.`
    );
  }
  // And the trap value the gate used to advertise must NOT satisfy it.
  assert.doesNotMatch(
    "business-context investigation: claudea11/complete",
    businessContext.BUSINESS_CONTEXT_INVESTIGATION_PATTERN,
    "free text in the <owner/status> shape must remain unrecognized — it is what COORD-553 mis-filed."
  );
});

// --- the generated surface is actually reachable ---------------------------

test("COORD-572: `gov surface` runs and reports the generated inventory", () => {
  const result = cli.executeCommand(["surface", "--json"]);
  assert.strictEqual(result.ok, true, `gov surface failed: ${result.error}`);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.flags.length, FLAGS.length);
  assert.ok(report.verbs.includes("surface"), "the surface verb does not list itself.");
  assert.ok(report.verb_aliases.length >= 10, "alias groups are missing from the report.");
  assert.ok(HELP.includes("gov surface"), "the surface verb is itself undocumented.");
});

test("COORD-770: context request verbs are dispatched and documented as observation-only", () => {
  const result = cli.executeCommand(["surface", "--json"]);
  assert.equal(result.ok, true, result.error);
  const report = JSON.parse(result.stdout);
  assert.ok(report.verbs.includes("request-context"));
  assert.ok(report.verbs.includes("context-requests"));
  assert.match(HELP, /gov request-context <ticket-id> --path <relative-posix-path> --reason <text>/);
  assert.match(HELP, /gov context-requests \[<ticket-id>\] \[--limit <1-100>\] \[--json\]/);
  assert.match(HELP, /never reads the path or grants access/);
  assert.match(HELP, /requests are not grants/);
});

test("COORD-572: the derivation fails loudly rather than reporting an empty surface", () => {
  // The fidelity assertions inside cli-surface.js are what stop this whole guard
  // from passing by measuring nothing. Prove the tripwire is real: the verb
  // collector returns an EMPTY set for input it cannot read, and cli-surface
  // requires >= 100 verbs, so an unreadable dispatch table throws instead of
  // silently publishing an empty inventory.
  const collect = require("./verb-parity.js").collectDispatchCommandVerbs;
  assert.strictEqual(collect("not javascript at all").size, 0);
  assert.strictEqual(collect(12345).size, 0);
  const fresh = spawnSync(process.execPath, ["-e", [
    'const surface = require("./cli-surface.js");',
    'const assert = require("node:assert/strict");',
    'assert.throws(() => surface.parseGovRemediation("gov counts"), /parseFlags is not bound/);',
    'surface.bindParser(() => require("./cli.js").__testing.parseFlags);',
    'assert.deepEqual(surface.parseGovRemediation("coord/scripts/gov counts # comment"), {',
    '  verb: "counts", argv: [], ok: true, options: {},',
    '});',
    'assert.match(surface.parseGovRemediation("gov counts --no-fixture-flag").error, /Unknown flag/);',
    'surface.bindParser(() => () => { throw "plain parser refusal"; });',
    'assert.deepEqual(surface.parseGovRemediation("gov"), {',
    '  verb: null, argv: [], ok: false, error: "plain parser refusal",',
    '});',
  ].join("\n")], { cwd: __dirname, encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(surface.verbs().length >= 100);
  assert.ok(surface.flagTokens().length >= 150);
  for (const anchor of ["--context-pack-ack", "--transfer-to", "--closeout-blocker"]) {
    assert.ok(surface.flagTokens().includes(anchor), `flag derivation lost ${anchor}.`);
  }
});

test("COORD-662: surface derivation handles file-path probes, empty guesses, and both render modes", () => {
  assert.deepStrictEqual(surface.flagOptionKeys("--not-a-real-file"), []);
  assert.deepStrictEqual(surface.suggestFlags(""), []);
  assert.deepStrictEqual(surface.suggestVerbs("not-a-real-command-name"), []);

  const originalLog = console.log;
  const output = [];
  try {
    console.log = (...values) => output.push(values.join(" "));
    const textReport = surface.printSurface();
    assert.ok(textReport.flags.length >= 200);
    assert.ok(output.some((line) => line.includes("Governance CLI surface")));
    assert.ok(output.some((line) => line.startsWith("  --summary-file -> summary")));
    assert.ok(output.some((line) => line.startsWith("  --closure-file -> closure")));
    output.length = 0;
    const jsonReport = surface.printSurface({ json: true });
    assert.deepStrictEqual(JSON.parse(output[0]), jsonReport);
  } finally {
    console.log = originalLog;
  }
});

test("COORD-662: text surface prints flags without option keys and empty enum advice", () => {
  const originalParser = cli.__testing.parseFlags;
  const originalLog = console.log;
  const output = [];
  try {
    cli.__testing.parseFlags = (args) => {
      if (args[0] === "--summary") return {};
      if (args[0] === "--status" && args.length > 1) throw new Error("status has no published literals");
      return originalParser(args);
    };
    console.log = (...values) => output.push(values.join(" "));
    surface.printSurface();
    assert.ok(output.includes("  --summary"), "flags with no derived option keys omit the arrow suffix");
    assert.ok(output.includes("  --status: (none published)"), "an empty enum list has explicit text output");
  } finally {
    cli.__testing.parseFlags = originalParser;
    console.log = originalLog;
  }
});

test("COORD-662: enum derivation tolerates required-value and malformed advertised-literal parser messages", () => {
  const parser = cli.__testing.parseFlags;
  try {
    cli.__testing.parseFlags = (args) => {
      if (args[0] === "--status" && args.length > 1) throw new Error("--status requires a value");
      return parser(args);
    };
    assert.equal(surface.enumConstrainedFlags().some((entry) => entry.flag === "--status"), false);

    cli.__testing.parseFlags = (args) => {
      if (args[0] === "--status" && args[1] === "coord-572-not-a-real-enum-value") {
        throw new Error("--status must be one of: todo | | legacy");
      }
      if (args[0] === "--status" && args[1] === "legacy") throw new Error("--status must be one of: todo | | legacy");
      return parser(args);
    };
    const filtered = surface.enumConstrainedFlags().find((entry) => entry.flag === "--status");
    assert.deepStrictEqual(filtered.advertised, ["todo", "legacy"]);
    assert.deepStrictEqual(filtered.accepted, ["todo"]);

    cli.__testing.parseFlags = (args) => {
      if (args[0] === "--status" && args.length > 1) throw { message: "" };
      return parser(args);
    };
    const emptyMessage = surface.enumConstrainedFlags().find((entry) => entry.flag === "--status");
    assert.deepStrictEqual(emptyMessage, { flag: "--status", message: "", advertised: [], accepted: [] });
  } finally {
    cli.__testing.parseFlags = parser;
  }
});

test("COORD-662: verb help names the prose file companions operators can pass", () => {
  const expectations = [
    ["update-plan", ["--summary-file", "--closure-file", "--review-cycle-file"]],
    ["block", ["--reason-file"]],
    ["audit-landings", ["--reason-file", "--human-admin-override-file"]],
    ["finalize", ["--landed-file"]],
  ];
  for (const [verb, flags] of expectations) {
    const help = buildVerbHelpText(verb);
    assert.ok(help, `${verb} should retain its per-verb usage`);
    for (const flag of flags) assert.ok(help.includes(flag), `${verb} help omits ${flag}`);
  }
});

test("COORD-662: unknown-flag advice fails closed if the suggestion module throws", () => {
  const suggestions = require("./cli-surface.js");
  const original = suggestions.suggestFlags;
  try {
    suggestions.suggestFlags = () => { throw new Error("surface derivation unavailable"); };
    assert.throws(
      () => parseFlags(["--definitely-not-supported"]),
      /^GovernanceError: Unknown flag "--definitely-not-supported"\.$/
    );
  } finally {
    suggestions.suggestFlags = original;
  }
});

test("COORD-662: direct CLI entry converts a public governance refusal into exit status 1", () => {
  const cliPath = path.join(__dirname, "cli.js");
  const result = spawnSync(process.execPath, [cliPath, "not-a-governance-verb"], {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unknown command "not-a-governance-verb"/);
  assert.doesNotMatch(result.stderr, /GovernanceError:.*\n\s+at /);
});

test("COORD-662: direct CLI entry rethrows unexpected failures with their stack", () => {
  const cliPath = path.join(__dirname, "cli.js");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-cli-entry-"));
  const preload = path.join(tempDir, "throwing-surface.cjs");
  fs.writeFileSync(preload, [
    '"use strict";',
    'const Module = require("node:module");',
    'const original = Module._load;',
    `const cliPath = ${JSON.stringify(cliPath)};`,
    'Module._load = function(request, parent, isMain) {',
    '  if (request === "./cli-surface.js" && parent && parent.filename === cliPath) {',
    '    return { suggestVerbs() { throw new TypeError("deliberate unexpected CLI failure"); } };',
    '  }',
    '  return original.call(this, request, parent, isMain);',
    '};',
    "",
  ].join("\n"), "utf8");
  try {
    const result = spawnSync(process.execPath, [cliPath, "unexpected-failure-probe"], {
      cwd: path.resolve(__dirname, "..", "..", ".."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
      timeout: 15000,
    });
    assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TypeError: deliberate unexpected CLI failure/);
  assert.match(result.stderr, /cli\.js/);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("flag-bearing governed commands reject unknown flags before changing ticket or runtime evidence", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  utils.sandboxProcessRuntime();
  utils.withRegisterPromptHarness("cli-flag-refusal-", { ticketId: "IMP-799" }, ({ tempDir }) => {
    const snapshot = () => {
      const files = {};
      const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.isFile()) files[path.relative(tempDir, file)] = fs.readFileSync(file).toString("base64");
        }
      };
      visit(tempDir);
      return files;
    };
    // Exercise the public argument boundary, including terminal aliases: an
    // unsupported flag must never cause a partial mutation, sync, or release.
    const ticketCommands = [
      "pick", "run-ticket-cycle", "ticket-cycle", "fleet-golden-path", "guided-closeout",
      "claim", "agent-claim", "agent-release", "rebuild-board", "recent", "recover", "resume",
      "pr-view", "pr-create", "pr-merge", "submit", "land", "close", "finish", "finalize",
      "mark-done", "supersede", "finish-ticket", "review", "move-review", "reopen", "reopen-ticket",
      "repair", "start-ticket", "unstart", "unstart-ticket", "lock-abandon", "abandon-lock",
      "block", "unblock", "commit", "commit-ticket", "open-followup", "file-ticket", "new",
      "amend-ticket", "split-ticket", "set-waiver", "set-pr", "update-finding", "set-requirement-closure",
      "add-feature-proof", "drop-feature-proof", "add-repo-gate", "gate-plan", "prework", "closeout-summary",
      "code-search", "code-context", "set-review-cycles", "release-lock", "cleanup-helpers",
      "gate", "live-mcp-record", "bootstrap-record", "deploy-record", "deploy-check", "verify", "falsify",
      "validate-receipt",
    ];
    const flagCommands = [
      "list", "recommend", "next-ticket", "initiate", "agent-rebind", "repair-chain", "migrate-chain-hash",
      "verify-engine", "orch", "orchestrator-cycle", "reconcile-landings", "reap-gate-procs",
      "resolve-question", "insights", "coverage-rollup", "code-index",
      "clean-runtime", "sync", "runtime-lock-status", "break-runtime-lock", "retire-stale-drift-notes",
      "live-mcp-policy",
    ];
    const before = snapshot();
    const problems = [];
    for (const [verb, args] of [
      ...ticketCommands.map(verb => [verb, ["IMP-799", "--not-a-governed-option"]]),
      ...flagCommands.map(verb => [verb, ["--not-a-governed-option"]]),
      ["recall", ["literal query", "--not-a-governed-option"]],
      ["sign-journal", ["sign", "--not-a-governed-option"]],
      ["code-diff", ["HEAD", "--not-a-governed-option"]],
      ["cleanup-worktree", ["claudea11", "IMP-799", "--not-a-governed-option"]],
    ]) {
      const result = cli.executeCommand([verb, ...args]);
      if (result.ok || !/unknown (flag|option|argument)/i.test(result.error || "")) {
        problems.push({ verb, ok: result.ok, error: result.error, stdout: result.stdout });
      }
      assert.deepStrictEqual(snapshot(), before, `${verb}: rejected input must preserve every fixture file`);
    }
    assert.deepStrictEqual(problems, [], "every routed command must refuse the unsupported option before effects");
  });
});

test("CLI passthroughs preserve failure exits and refuse incomplete promotion without writing rules", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-passthrough-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "cli.js"), "quality-scan", "--not-a-governed-option"], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unknown flag --not-a-governed-option/);
    assert.deepStrictEqual(fs.readdirSync(root), [], "a rejected standalone scan must not create artifacts");
    assert.throws(() => cli.executeCommand(["learned-rule", "promote"]), /requires a candidate id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public reports preserve initialized evidence and heartbeat refuses an absent lock", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  utils.sandboxProcessRuntime();
  utils.withRegisterPromptHarness("cli-reports-", { ticketId: "IMP-799" }, ({ tempDir }) => {
    // Initialize the existing legacy registry mirror before measuring reports.
    const agents = cli.executeCommand(["agents", "list"]);
    assert.equal(agents.ok, true, agents.error);
    assert.match(agents.stdout, /claudea11/);
    const snapshot = () => {
      const files = {};
      const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.isFile()) files[path.relative(tempDir, file)] = fs.readFileSync(file).toString("base64");
        }
      };
      visit(tempDir);
      return files;
    };
    const before = snapshot();
    for (const [argv, expected] of [
      [["agent-status", "claudea11"], /claudea11/],
      [["ticket", "IMP-799"], /IMP-799/],
      [["explain", "IMP-799"], /IMP-799/],
      [["next-id", "IMP"], /IMP-800/],
      [["audit-worktrees"], /worktree|findings|issues/i],
      [["help"], /gov|usage/i],
      [[], /gov|usage/i],
    ]) {
      const result = cli.executeCommand(argv);
      assert.equal(result.ok, true, `${argv.join(" ")}: ${result.error}`);
      assert.match(result.stdout, expected);
      assert.deepStrictEqual(snapshot(), before, `${argv.join(" ")}: report must not alter initialized evidence`);
    }
    const refusal = cli.executeCommand(["heartbeat", "IMP-799"]);
    assert.equal(refusal.ok, false);
    assert.match(refusal.error, /lock/i);
    assert.deepStrictEqual(snapshot(), before, "heartbeat must not manufacture a missing lock or successful event");
  });
});


test("standalone CLI failures and unavailable scan runtime preserve failing exit codes", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-runtime-refusal-"));
  try {
    for (const argv of [["ticket"], ["learned-rule", "promote"]]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "cli.js"), ...argv], { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /requires/);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    }
    const executable = process.execPath;
    const priorExit = process.exitCode;
    try {
      // Real ENOENT from spawnSync, not a fabricated child result.
      process.execPath = path.join(dir, "missing-node-runtime");
      cli.executeCommand(["quality-scan", "--not-a-governed-option"]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.execPath = executable;
      process.exitCode = priorExit;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent command dispatch persists explicit registry changes and refuses invalid operations", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  utils.withRegisterPromptHarness("cli-agent-dispatch-", { ticketId: "IMP-799" }, () => {
    for (const [argv, status] of [
      [["agents", "register", "--id", "a799", "--handle", "fixturea799", "--provider", "unknown"], "active"],
      [["agents", "disable", "fixturea799"], "disabled"],
      [["agents", "enable", "fixturea799"], "active"],
    ]) {
      const result = cli.executeCommand(argv);
      assert.equal(result.ok, true, result.error);
      const agents = JSON.parse(fs.readFileSync(governanceState.AGENTS_PATH, "utf8"));
      assert.equal(agents.find(agent => agent.handle === "fixturea799").status, status);
    }
    const before = fs.readFileSync(governanceState.AGENTS_PATH, "utf8");
    const refused = cli.executeCommand(["agents", "unsupported-operation"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /agents requires one of/);
    assert.equal(fs.readFileSync(governanceState.AGENTS_PATH, "utf8"), before);
    for (const argv of [["ticket"], ["ticket", "MISSING-799"]]) {
      const result = cli.executeCommand(argv);
      assert.equal(result.ok, false);
      assert.match(result.error, /requires|Unknown ticket/);
    }
  });
});

test("agent reports count only matching active sessions and retain empty-registry diagnostics", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  utils.withGovernedSurfaceSandbox(() => {
    const state = governanceState;
    const agents = [{ id: "a42", handle: "codexa42", status: "active", aliases: [] },
      { id: "a43", handle: "codexa43", status: "active", provider: "openai", lane: "engine", aliases: [] }];
    const now = new Date().toISOString();
    const session = { session_id: "report-session", agent_id: "a42", handle: "codexa42", board_path: state.BOARD_PATH,
      thread_id: "report-only-thread", status: "active", claimed_at: now, last_seen_at: now };
    fs.writeFileSync(state.AGENTS_PATH, JSON.stringify(agents));
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([session,
      { ...session, session_id: "other-board", board_path: "different-board" },
      { ...session, session_id: "released", status: "released" }]));
    const list = cli.executeCommand(["agents", "list"]);
    assert.equal(list.ok, true, list.error);
    assert.match(list.stdout, /codexa42\tactive\t-\t-\tactive_sessions:1/);
    assert.match(list.stdout, /codexa43\tactive\tengine\topenai\tactive_sessions:0/);
    const report = cli.executeCommand(["agent-status", "report-session"]);
    assert.equal(report.ok, true, report.error);
    assert.deepStrictEqual(JSON.parse(report.stdout).session, session);
    const unknown = cli.executeCommand(["agent-status", "missing-session"]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unknown agent or session/);
    fs.writeFileSync(state.AGENTS_PATH, "[]");
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, "[]");
    const empty = cli.executeCommand(["agents", "list"]);
    assert.equal(empty.ok, true, empty.error);
    assert.match(empty.stdout, /No registered agents/);
  });
});

test("agent registration infers defaults and rejects duplicate or missing registry subjects without writes", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
    "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    utils.withRegisterPromptHarness("cli-agent-defaults-", { ticketId: "IMP-799" }, () => {
      for (const provider of ["unknown", "openai"]) {
        if (provider === "openai") process.env.CODEX_THREAD_ID = "registration-fixture-thread";
        const registered = cli.executeCommand(["agents", "register"]);
        assert.equal(registered.ok, true, registered.error);
        const record = JSON.parse(registered.stdout);
        assert.equal(record.provider, provider);
        assert.match(record.id, /^a\d+$/);
        assert.equal(record.handle, `${provider === "openai" ? "codex" : "agent"}${record.id}`);
        const state = governanceState;
        const paths = [state.BOARD_PATH, state.AGENTS_PATH, state.AGENT_SESSIONS_PATH, state.GOVERNANCE_EVENT_LOG_PATH];
        const before = paths.map(file => fs.readFileSync(file));
        for (const [argv, message] of [
          [["agents", "register", "--id", record.id.toUpperCase()], /simple-id .* already registered/],
          [["agents", "register", "--handle", record.handle.toUpperCase()], /handle .* already registered/],
          [["agents", "disable"], /disable requires/],
          [["agents", "enable"], /enable requires/],
          [["agents", "enable", "missing-registry-handle"], /Unknown registered agent/],
        ]) {
          const refused = cli.executeCommand(argv);
          assert.equal(refused.ok, false);
          assert.match(refused.error, message);
          paths.forEach((file, index) => assert.deepStrictEqual(fs.readFileSync(file), before[index], file));
        }
      }
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("heartbeat refreshes only existing Git worktree HEAD and refuses missing ticket identity", () => {
  const utils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const repo = utils.createTempGitRepo("cli-heartbeat-head-", { "README.md": "fixture\n" });
  try {
    for (const name of names) delete process.env[name];
    process.env.CODEX_THREAD_ID = "heartbeat-fixture-thread";
    for (const { worktree, legacyRepo } of [
      { worktree: repo.repoRoot }, { worktree: repo.repoRoot, legacyRepo: true },
      { worktree: path.join(repo.repoRoot, "absent-checkout") }, { worktree: "" },
    ]) {
      utils.withGovernedSurfaceSandbox(({ boardPath }) => {
        const state = governanceState;
        const now = new Date().toISOString();
        const row = { ID: "IMP-799", Repo: "B", Type: "bug", Pri: "P2", Status: "doing", Owner: "codexa42", Description: "heartbeat fixture", "Depends On": "" };
        fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "table", heading: "Fixture", rows: [row] }] }));
        fs.writeFileSync(state.AGENTS_PATH, JSON.stringify([{ id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] }]));
        fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([{ session_id: "heartbeat-session", agent_id: "a42", handle: "codexa42",
          board_path: boardPath, thread_id: process.env.CODEX_THREAD_ID, status: "active", claimed_at: now, last_seen_at: now }]));
        const lockPath = path.join(state.LOCKS_DIR, "IMP-799.lock");
        const lock = { ticket: "IMP-799", owner: "codexa42", agent_id: "a42", session_id: "heartbeat-session", status: "doing",
          repo: legacyRepo ? "unmapped-legacy-repo" : repoRegistryOwner.repoNameForCode("B"), branch: "dev", head: "recorded-old-head", worktree,
          started_at_utc: now, heartbeat_utc: "2000-01-01T00:00:00.000Z" };
        fs.writeFileSync(lockPath, JSON.stringify(lock));
        fs.writeFileSync(path.join(state.LOCKS_DIR, "MISSING-799.lock"), JSON.stringify({ ...lock, ticket: "MISSING-799" }));
        utils.__testing.ensureGovernanceJournalBaseline("heartbeat boundary fixture");
        assert.equal(utils.__testing.readLockFileOrFail("ABSENT-799", path.join(state.LOCKS_DIR, "ABSENT-799.lock"), { allowMissing: true }), null);
        for (const argv of [["heartbeat"], ["heartbeat", "MISSING-799"]]) {
          const result = cli.executeCommand(argv);
          assert.equal(result.ok, false);
          assert.match(result.error, /requires|Unknown ticket/);
        }
        const result = cli.executeCommand(["heartbeat", "IMP-799"]);
        assert.equal(result.ok, true, result.error);
        const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        assert.equal(after.head, worktree === repo.repoRoot ? repo.head : lock.head);
        assert.ok(Date.parse(after.heartbeat_utc) > Date.parse(lock.heartbeat_utc));
        assert.equal(after.owner, lock.owner);
        assert.equal(after.session_id, lock.session_id);
        assert.equal(fs.existsSync(path.join(repo.repoRoot, "absent-checkout")), false);
      });
    }
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// COORD-820: the inline argument parsers of `register-prompt`, `recall`,
// `sign-journal`, `code-search` and `code-diff` live inside dispatchCommand and
// shape what the command receives. A fresh cli.js is loaded over a lifecycle
// whose command functions only RECORD their arguments, so each parse is
// asserted exactly and no real command (or its state writes) runs.
const RECORDED_INLINE_PARSER_COMMANDS = [
  "registerPrompt", "recallCommand", "signJournalCommand", "codeSearchCommand", "codeDiffCommand",
];

function loadCliWithRecordingCommands(names) {
  const cliPath = require.resolve("./cli.js");
  const realLifecycle = require("./lifecycle.js");
  const calls = [];
  const stubs = Object.fromEntries(names.map((name) => [name, (...received) => {
    calls.push({ name, args: received });
    return name;
  }]));
  const cached = require.cache[cliPath];
  const originalLoad = Module._load;
  delete require.cache[cliPath];
  Module._load = function loadRecordingLifecycle(request, parent, isMain) {
    if (parent && parent.filename === cliPath && request === "./lifecycle.js") {
      return { ...realLifecycle, commands: { ...realLifecycle.commands, ...stubs } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { dispatchCommand } = require(cliPath).__testing;
    return { dispatchCommand, calls };
  } finally {
    Module._load = originalLoad;
    if (cached) require.cache[cliPath] = cached;
    else delete require.cache[cliPath];
  }
}

function loadCliWithCommandStubs(stubs) {
  const cliPath = require.resolve("./cli.js");
  const realLifecycle = require("./lifecycle.js");
  const cached = require.cache[cliPath];
  const originalLoad = Module._load;
  delete require.cache[cliPath];
  Module._load = function loadStubbedLifecycle(request, parent, isMain) {
    if (parent && parent.filename === cliPath && request === "./lifecycle.js") {
      return { ...realLifecycle, commands: { ...realLifecycle.commands, ...stubs } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(cliPath).executeCommand;
  } finally {
    Module._load = originalLoad;
    if (cached) require.cache[cliPath] = cached;
    else delete require.cache[cliPath];
  }
}

test("COORD-772: terminal aliases execute through the public CLI wrapper and retain sync, release, and cost boundaries", () => {
  const calls = [];
  let releaseThrows = false;
  const operation = (name) => (...args) => {
    calls.push({ name, args });
    return { operation: name, args };
  };
  const executeCommand = loadCliWithCommandStubs({
    landTicket: operation("landTicket"),
    finishTicket: operation("finishTicket"),
    finalizeTicket: operation("finalizeTicket"),
    markDone: operation("markDone"),
    autoSyncAfterLifecycle: operation("autoSyncAfterLifecycle"),
    releaseTerminalTicketSession: (...args) => {
      calls.push({ name: "releaseTerminalTicketSession", args });
      if (releaseThrows) throw new Error("runtime session cleanup unavailable");
      return { operation: "releaseTerminalTicketSession", args };
    },
    recordLifecycleCostBoundary: operation("recordLifecycleCostBoundary"),
  });
  const cases = [
    ["land", "landTicket"],
    ["close", "finishTicket"],
    ["finish", "finishTicket"],
    ["finalize", "finalizeTicket"],
    ["mark-done", "markDone"],
    ["finish-ticket", "finishTicket"],
  ];

  for (const [verb, operationName] of cases) {
    calls.length = 0;
    const result = executeCommand([verb, "T-772", "--json"]);
    assert.equal(result.ok, true, `${verb}: ${result.error}`);
    assert.deepEqual(result.value, {
      operation: operationName,
      args: ["T-772", { json: true }],
    }, `${verb}: lifecycle operation result is preserved`);
    assert.deepEqual(calls, [
      { name: operationName, args: ["T-772", { json: true }] },
      { name: "recordLifecycleCostBoundary", args: ["T-772", "review", ["land", "mark-done"]] },
      { name: "autoSyncAfterLifecycle", args: [{ verb, ticketId: "T-772", options: { json: true } }] },
      { name: "releaseTerminalTicketSession", args: ["T-772", {
        terminalSync: {
          operation: "autoSyncAfterLifecycle",
          args: [{ verb, ticketId: "T-772", options: { json: true } }],
        },
      }] },
    ], `${verb}: dispatch invokes the terminal wrapper with parsed flags and preserves ordering`);
  }

  calls.length = 0;
  releaseThrows = true;
  const completed = executeCommand(["land", "T-772", "--json"]);
  assert.equal(completed.ok, true, "best-effort session cleanup cannot roll back a completed lifecycle command");
  assert.deepEqual(completed.value, { operation: "landTicket", args: ["T-772", { json: true }] });
  assert.deepEqual(calls.map(({ name }) => name), [
    "landTicket", "recordLifecycleCostBoundary", "autoSyncAfterLifecycle", "releaseTerminalTicketSession",
  ], "a failed release is swallowed after the lifecycle result and sync evidence are preserved");
});

test("COORD-820: inline verb parsers hand each flag and positional to the command exactly", () => {
  const { dispatchCommand, calls } = loadCliWithRecordingCommands(RECORDED_INLINE_PARSER_COMMANDS);
  const cases = [
    // register-prompt: optional positional path, --path wins, flags only, bare ticket.
    [["register-prompt", "T-1", "prompts/p.md", "--create"], "registerPrompt", ["T-1", { path: "prompts/p.md", create: true }]],
    [["register-prompt", "T-1", "prompts/positional.md", "--path", "prompts/flag.md"], "registerPrompt", ["T-1", { path: "prompts/flag.md" }]],
    [["register-prompt", "T-1", "--path", "prompts/flag.md", "--force"], "registerPrompt", ["T-1", { path: "prompts/flag.md", force: true }]],
    [["register-prompt", "T-1"], "registerPrompt", ["T-1", {}]],
    // recall: every positional joins the query; --role takes a value; --json is boolean.
    [["recall", "stale", "--role", "planner", "lock", "--json"], "recallCommand", ["stale lock", { role: "planner", json: true }]],
    [["recall", "--json", "only"], "recallCommand", ["only", { json: true }]],
    [["recall", "plain", "query"], "recallCommand", ["plain query", {}]],
    // sign-journal: --out/--file/--event map to their own key, --trust-anchor
    // appends, and a verify positional becomes the file only when --file is absent.
    [["sign-journal", "sign", "--out", "batch.json", "--json"], "signJournalCommand", ["sign", { out: "batch.json", json: true }]],
    [["sign-journal", "verify", "positional.json", "--event", "abc", "--trust-anchor", "k1", "--trust-anchor", "k2"], "signJournalCommand",
      ["verify", { event: "abc", trustAnchor: ["k1", "k2"], file: "positional.json" }]],
    [["sign-journal", "verify", "positional.json", "--file", "flag.json"], "signJournalCommand", ["verify", { file: "flag.json" }]],
    [["sign-journal", "verify"], "signJournalCommand", ["verify", {}]],
    // code-search: positionals join, --top takes a value, --json is boolean.
    [["code-search", "parse", "--top", "3", "flags", "--json"], "codeSearchCommand", ["parse flags", { top: "3", json: true }]],
    [["code-search", "--json", "solo"], "codeSearchCommand", ["solo", { json: true }]],
    // code-diff: a leading positional is the base ref; otherwise every arg is a flag.
    [["code-diff", "origin/dev", "--json"], "codeDiffCommand", ["origin/dev", { json: true }]],
    [["code-diff", "--json"], "codeDiffCommand", [null, { json: true }]],
    [["code-diff"], "codeDiffCommand", [null, {}]],
  ];
  for (const [argv, name, expected] of cases) {
    const label = argv.join(" ");
    calls.length = 0;
    assert.equal(dispatchCommand(argv[0], argv.slice(1)), name, label);
    assert.deepEqual(calls, [{ name, args: expected }], label);
  }
});

test("COORD-820: inline verb parsers refuse malformed flags before any command runs", () => {
  const { dispatchCommand, calls } = loadCliWithRecordingCommands(RECORDED_INLINE_PARSER_COMMANDS);
  const refusals = [
    [["register-prompt", "T-1", "a.md", "b.md"], /Unknown flag "b\.md"/],
    [["recall", "q", "--role"], /--role requires a value/],
    [["recall", "q", "--not-a-real-option"], /Unknown flag "--not-a-real-option"/],
    [["sign-journal", "sign", "--out"], /--out requires a value/],
    [["sign-journal", "verify", "batch.json", "--trust-anchor"], /--trust-anchor requires a value/],
    [["sign-journal", "sign", "--bogus"], /Unknown flag "--bogus"\./],
    [["code-search", "q", "--top"], /--top requires a value/],
    // `--n` was never a parser flag: the dispatcher once skipped its value as an
    // alias of --top, but parseFlags refused it either way, so it stays refused.
    [["code-search", "q", "--n", "3"], /Unknown flag "--n"/],
    [["code-diff", "origin/dev", "--bogus"], /Unknown flag "--bogus"/],
  ];
  for (const [argv, pattern] of refusals) {
    const label = argv.join(" ");
    calls.length = 0;
    assert.throws(() => dispatchCommand(argv[0], argv.slice(1)), pattern, label);
    assert.deepEqual(calls, [], `${label} runs no command`);
  }
});

// COORD-883: provider detection is fixture-owned. An ambient CLAUDECODE,
// GEMINI_AGENT or GROK_AGENT from the invoking shell would make the runtime
// provider anthropic, google or xai and change which owner a fixture may bind.
function runtimeDetectionFlags() {
  return ["CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
}
function clearAmbientDetectionFlags() {
  const saved = Object.fromEntries(runtimeDetectionFlags().map((name) => [name, process.env[name]]));
  for (const name of runtimeDetectionFlags()) delete process.env[name];
  return saved;
}
function restoreDetectionFlags(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test("COORD-915: CLI execution without an argument array returns help and restores console methods", () => {
  const before = { log: console.log, error: console.error, warn: console.warn };
  const result = cli.executeCommand(null);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /^Governance helper CLI/);
  assert.equal(result.stdout, cli.executeCommand([]).stdout);
  const refusal = cli.executeCommand(["__coord_915_no_such_command__"]);
  assert.equal(refusal.ok, false);
  assert.match(refusal.error, /Unknown command/);
  assert.equal(result.stderr, "");
  assert.deepEqual({ log: console.log, error: console.error, warn: console.warn }, before);
});

test("COORD-915: CLI execution preserves unexpected errors and captures both output streams", () => {
  const failure = new Error("diff provider unavailable");
  const before = { log: console.log, error: console.error, warn: console.warn };
  const execute = loadCliWithCommandStubs({ codeDiffCommand: () => {
    console.log("diff %s", "started");
    console.error("provider %d", 7);
    console.warn("retry later");
    throw failure;
  } });
  assert.throws(() => execute(["code-diff"]), (error) => {
    assert.equal(error, failure, "unexpected errors retain their identity and stack");
    assert.equal(error.capturedStdout, "diff started");
    assert.equal(error.capturedStderr, "provider 7\nretry later");
    return true;
  });
  assert.deepEqual({ log: console.log, error: console.error, warn: console.warn }, before);
});

// COORD-972: `add-repo-gate --arch` hands the architecture summary to the gate
// record, which already annotates it (formatRepoGateEntry, COORD-078).
test("COORD-972: add-repo-gate --arch is parsed into the arch summary the gate record annotates", () => {
  assert.equal(parseFlags(["--arch", "arch: warn files=42 findings=3"]).arch, "arch: warn files=42 findings=3");
  assert.throws(() => parseFlags(["--arch"]), /--arch requires a value/);
});

// COORD-972: sign-journal's argv parser is a dry seam. It reads the same argv that
// dispatch reads, so the parity check can dry-check its flags without running sign.
test("COORD-972: sign-journal dry parse seam returns the subcommand and options dispatch would pass", () => {
  const { parseSignJournalArgs } = cli.__testing;
  assert.deepEqual(parseSignJournalArgs(["sign", "--out", "batch.json", "--json"]), { sub: "sign", opts: { out: "batch.json", json: true } });
  assert.deepEqual(parseSignJournalArgs(["verify", "positional.json", "--event", "abc", "--trust-anchor", "k1", "--trust-anchor", "k2"]),
    { sub: "verify", opts: { event: "abc", trustAnchor: ["k1", "k2"], file: "positional.json" } });
  assert.deepEqual(parseSignJournalArgs(["verify", "positional.json", "--file", "flag.json"]), { sub: "verify", opts: { file: "flag.json" } });
  assert.throws(() => parseSignJournalArgs(["sign", "--bogus"]), /Unknown flag "--bogus"\./);
  assert.throws(() => parseSignJournalArgs(["sign", "--out"]), /--out requires a value/);
});
