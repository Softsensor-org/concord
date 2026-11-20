"use strict";

// COORD-950: real-process crash harness. A test spawns THIS file as a child
// process; the child runs a real governed mutation (withGovernanceMutation, the
// real journal, the real restore point and the real recovery path) inside an
// os.tmpdir() sandbox. At a named crash point (crashPoint() in journal.js /
// governance-side-effects.js) the child writes a `reached` marker file and
// blocks, and the parent SIGKILLs it. The parent then runs the retry or
// inspect modes in fresh child processes against the same on-disk state.
//
// Usage: node crash-window-child.js <mode> <sandboxDir> [scenario] [point] [index] [tear]
//   mode = init | kill | retry | recover | effect-only | inspect
//   kill    : run the scenario and block at <point> (only when index matches)
//   retry   : run the same logical mutation again (no hook); prints JSON
//   recover : run the real recovery entry point alone; prints JSON
//   inspect : print the journal events and chain verification as JSON

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCoordPaths, resolveEngineModule } = require("../../../paths.js");

const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const ROOT_DIR = path.dirname(COORD_ROOT_DIR);
const governanceTestContext = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-context.js"));
const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const sideEffects = require("../governance-side-effects.js");
const journalModule = require("../journal.js");
const { MERGE_EFFECT_TYPE, findRecordedWorkspaceMerge } = require("../control-plane-merge-history.js");

const TICKET = "COORD-950";
const IDEMPOTENCY_KEY = "coord-950-crash-probe";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Every path the governed surface reads or writes, rooted at one sandbox dir.
// Mirrors withGovernedSurfaceSandbox in coord/scripts/governance-test-utils.js.
function sandboxOverrides(dir) {
  const runtimeDir = path.join(dir, ".runtime");
  return {
    RUNTIME_DIR: runtimeDir,
    LOCKS_DIR: path.join(runtimeDir, "locks"),
    LEGACY_LOCKS_DIR: path.join(dir, "locks"),
    PLAN_RECORDS_DIR: path.join(dir, "plans"),
    BOARD_PATH: path.join(dir, "tasks.json"),
    PLAN_PATH: path.join(dir, "PLAN.md"),
    QUESTIONS_PATH: path.join(dir, "QUESTIONS.md"),
    AGENTS_PATH: path.join(dir, "agents.json"),
    AGENT_SESSIONS_PATH: path.join(runtimeDir, "agent_sessions.json"),
    PROMPTS_DIR: path.join(dir, "prompts"),
    RENDERED_DIR: path.join(dir, "rendered"),
    DECISIONS_DIR: path.join(dir, "docs", "decisions"),
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    COORD_STATE_LOCK_DIR: path.join(runtimeDir, ".coord-state.lock"),
    AGENT_STATE_LOCK_DIR: path.join(runtimeDir, ".agent-state.lock"),
    MEMORY_DIR: path.join(dir, "memory"),
  };
}

// `fresh` writes the governed fixture files; every other mode reuses the
// on-disk state that the killed child left behind.
function installSandbox(dir, { fresh = false } = {}) {
  const overrides = sandboxOverrides(dir);
  for (const key of ["LOCKS_DIR", "PROMPTS_DIR", "RENDERED_DIR", "DECISIONS_DIR", "PLAN_RECORDS_DIR", "RUNTIME_DIR"]) {
    fs.mkdirSync(overrides[key], { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rendered"), { recursive: true });
  if (fresh) {
    fs.writeFileSync(overrides.BOARD_PATH, JSON.stringify({ sections: [] }, null, 2), "utf8");
    fs.writeFileSync(overrides.PLAN_PATH, "plan\n", "utf8");
    fs.writeFileSync(overrides.QUESTIONS_PATH, "# Questions\n", "utf8");
    fs.writeFileSync(overrides.AGENTS_PATH, "[]\n", "utf8");
    fs.writeFileSync(overrides.AGENT_SESSIONS_PATH, "[]\n", "utf8");
  }
  const harness = governanceTestContext.createGovernanceTestContextHarness({
    state,
    defaultPaths: createCoordPaths({ coordDir: COORD_ROOT_DIR, rootDir: ROOT_DIR }),
  });
  harness.installWorkerContext(overrides, process);
  return overrides;
}

// The journal factory, wired exactly as journal.test.js wires it.
function buildJournal() {
  const stateIo = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/state-io.js"));
  const { GovernanceError, withGovernanceRuntimeLock } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const createQuestions = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/questions.js"));
  const createGovernanceRepair = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-repair.js"));
  const createGovernanceBoardState = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-board-state.js"));
  const createChainTransitionSigner = require("../chain-transition-signer.js");
  const createConformanceAttestation = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-attestation.js"));
  const { signTransition } = require("../chain-migration-signing.js");
  const questionWriter = createQuestions({
    state,
    readCanonicalTextFile: stateIo.readCanonicalTextFile,
    writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
    classifyQuestionOperationalType: createGovernanceRepair({}).classifyQuestionOperationalType,
    uniqueStrings: (values) => [...new Set(values)],
    todayIso: () => new Date().toISOString().slice(0, 10),
    escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
  });
  const boardStateProjection = createGovernanceBoardState({});
  const { signChainTransition } = createChainTransitionSigner({
    coordDir: COORD_ROOT_DIR,
    resolveRuntimeDir: () => state.RUNTIME_DIR,
    createConformanceAttestation,
    signTransition,
  });
  const warningDriftPrefixes = [".runtime/agent_sessions.json", ".runtime/session-threads/"];
  return journalModule({
    fail: (message) => { throw new GovernanceError(message); },
    relativeCoordPath: (filePath) => path.relative(COORD_ROOT_DIR, filePath).replace(/\\/g, "/"),
    existingLockDirs: () => [state.LOCKS_DIR, state.LEGACY_LOCKS_DIR],
    writeFileAtomicSync: stateIo.writeFileAtomicSync,
    readJsonFileState: stateIo.readJsonFileState,
    formatJsonFileIssue: stateIo.formatJsonFileIssue,
    readLastNonEmptyLine: stateIo.readLastNonEmptyLine,
    withGovernanceRuntimeLock,
    readCanonicalTextFile: stateIo.readCanonicalTextFile,
    writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
    buildQuestionRow: questionWriter.buildQuestionRow,
    appendQuestionRowText: questionWriter.appendQuestionRowText,
    parseQuestionRow: questionWriter.parseQuestionRow,
    escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
    ensureCurrentAgentIdentity: () => null,
    resolveEffectiveThreadId: () => null,
    readAgentSessions: () => stateIo.readJsonArrayFileOrFail(state.AGENT_SESSIONS_PATH, "agent sessions file"),
    readCanonicalJsonFile: stateIo.readCanonicalJsonFile,
    getRows: boardStateProjection.getRows,
    formatGovernanceJournalUninitializedMessage: () => "journal is uninitialized",
    splitGovernanceProvenanceDrift: (files) => ({
      warnings: files.filter((file) => warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
      blocking: files.filter((file) => !warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
    }),
    signChainTransition,
    GovernanceError,
  });
}

// The governed work. Each scenario is one logical mutation, keyed by
// IDEMPOTENCY_KEY, so a retry after a crash must produce exactly one succeeded
// event. Every external effect is a fake provider call whose side effect is
// durable on disk (a remote ledger file, and a real git commit for workspace
// merges) so the parent can count how many times it actually happened.
function remoteLedgerPath(dir) {
  return path.join(dir, "remote", "provider-ledger.ndjson");
}

function providerCalls(dir) {
  try {
    return fs.readFileSync(remoteLedgerPath(dir), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function providerDo(dir, action, payload) {
  fs.mkdirSync(path.dirname(remoteLedgerPath(dir)), { recursive: true });
  fs.appendFileSync(remoteLedgerPath(dir), `${JSON.stringify({ action, ...payload })}\n`, "utf8");
}

function journaledEffect(journal, type) {
  const events = journal.readGovernanceEventLog();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const effects = events[i]?.details?.external_side_effects;
    if (!Array.isArray(effects)) continue;
    for (let j = effects.length - 1; j >= 0; j -= 1) {
      if (effects[j]?.type === type && effects[j]?.ticket === TICKET) return effects[j];
    }
  }
  return null;
}

function markDone(boardPath, marker) {
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "markdown", level: 2, heading: TICKET, body: [marker] }] }, null, 2), "utf8");
}

function runScenario(journal, dir, scenario, { onRetry = false } = {}) {
  const boardPath = state.BOARD_PATH;
  const metadata = { command: `crash-probe-${scenario}`, ticket: TICKET, idempotencyKey: IDEMPOTENCY_KEY };
  const outcome = {};
  journal.withGovernanceMutation(metadata, () => {
    if (scenario === "board") {
      markDone(boardPath, onRetry ? "retry" : "first");
      return;
    }
    if (scenario === "pr-merge") {
      const prior = journaledEffect(journal, "github_pr_merge");
      if (prior) {
        outcome.reusedMergeSha = prior.merge_commit_sha;
      } else {
        const sha = `pr-merge-${providerCalls(dir).filter((c) => c.action === "merge").length + 1}`;
        providerDo(dir, "merge", { pr: 17, merge_commit_sha: sha });
        outcome.mergedSha = sha;
        sideEffects.recordGovernanceExternalSideEffect({
          type: "github_pr_merge",
          ticket: TICKET,
          pr_url: "https://github.example/pull/17",
          merge_commit_sha: sha,
        });
      }
      markDone(boardPath, "merged");
      return;
    }
    if (scenario === "workspace-merge") {
      const repo = path.join(dir, "repo");
      const prior = findRecordedWorkspaceMerge(TICKET, { repoRoot: repo, journalPath: state.GOVERNANCE_EVENT_LOG_PATH });
      if (prior) {
        outcome.reusedMergeSha = prior.mergeCommitSha;
      } else {
        const sha = execFileSync("git", ["-C", repo, "commit-tree", EMPTY_TREE, "-m", `merge ${TICKET}`], { encoding: "utf8" }).trim();
        providerDo(dir, "merge", { merge_commit_sha: sha });
        outcome.mergedSha = sha;
        sideEffects.recordGovernanceExternalSideEffect({
          type: MERGE_EFFECT_TYPE,
          ticket: TICKET,
          repo_root: fs.realpathSync(repo),
          branch: `agent/${TICKET}`,
          base_branch: "dev",
          merge_commit_sha: sha,
        });
      }
      markDone(boardPath, "merged");
      return;
    }
    throw new Error(`unknown scenario ${scenario}`);
  });
  return outcome;
}

function initRepo(dir) {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "dev"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"]);
}

// Kill points for the parent: the child blocks here until SIGKILL.
function armKillPoint(dir, point, index, tear) {
  // index: the record index inside a multi-record append (null = any).
  const reachedPath = path.join(dir, "reached.json");
  const block = new Int32Array(new SharedArrayBuffer(4));
  sideEffects.setCrashPointHook((name, context) => {
    if (name !== point) return;
    if (index !== null && context.index !== index) return;
    if (tear && context.line !== undefined) {
      // A torn write: half of the record reaches disk, then the process dies.
      fs.writeSync(context.fd, context.line.slice(0, Math.floor(context.line.length / 2)));
    }
    fs.writeFileSync(reachedPath, `${JSON.stringify({ point: name, index: context.index ?? null, pid: process.pid })}\n`, "utf8");
    for (;;) Atomics.wait(block, 0, 0, 50);
  });
}

function main(argv) {
  const [mode, dir, scenario = "board", point = null, rawIndex = "", tear = ""] = argv;
  if (!mode || !dir) throw new Error("usage: crash-window-child.js <mode> <sandboxDir> [scenario] [point] [index] [tear]");
  const index = rawIndex === "" ? null : Number(rawIndex);
  fs.mkdirSync(dir, { recursive: true });
  installSandbox(dir, { fresh: mode === "init" });
  const journal = buildJournal();
  if (mode === "init") {
    if (scenario === "workspace-merge") initRepo(dir);
    // A first chained mutation writes the journal checkpoint. The legacy variant
    // then strips the chain link from that single event, so the next append
    // must insert a legacy-migration anchor before the event (a two-record batch).
    journal.withGovernanceMutation({ command: "crash-probe-init", ticket: TICKET }, () => {
      markDone(state.BOARD_PATH, "init");
    });
    if (scenario === "legacy-anchor") {
      const logPath = state.GOVERNANCE_EVENT_LOG_PATH;
      const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => {
        const event = JSON.parse(line);
        delete event.prev_event_hash;
        delete event.hash_alg;
        return JSON.stringify(event);
      });
      fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
    }
    console.log(JSON.stringify({ initialized: true }));
    return;
  }
  if (mode === "kill") {
    armKillPoint(dir, point, index, tear === "tear");
    runScenario(journal, dir, scenario);
    // Reaching here means the kill point was never hit: the parent treats it as a failure.
    console.log(JSON.stringify({ killPointNotReached: point }));
    return;
  }
  if (mode === "recover") {
    const pendingBefore = fs.existsSync(path.join(state.RUNTIME_DIR, "governance-external-effects.ndjson"));
    const result = journal.recoverCrashedGovernanceMutation();
    console.log(JSON.stringify({ recovery: result ?? null, pendingEffectsFileBefore: pendingBefore }));
    return;
  }
  if (mode === "retry") {
    const outcome = runScenario(journal, dir, scenario, { onRetry: true });
    console.log(JSON.stringify({ retried: true, ...outcome, providerCalls: providerCalls(dir) }));
    return;
  }
  if (mode === "effect-only") {
    // An effect-only mutation: it changes no governed file and carries no
    // idempotency key, so only the effect itself makes it worth an event.
    journal.withGovernanceMutation({ command: "crash-probe-effect-only", ticket: TICKET }, () => {
      sideEffects.recordGovernanceExternalSideEffect({
        type: "github_pr_merge",
        ticket: TICKET,
        pr_url: "https://github.example/pull/18",
        merge_commit_sha: "effect-only-sha",
      });
    });
    console.log(JSON.stringify({ effectOnly: true }));
    return;
  }
  if (mode === "inspect") {
    const events = journal.readGovernanceEventLog();
    const chain = journal.verifyGovernanceChain(events);
    console.log(JSON.stringify({
      events: events.map((event) => ({
        command: event.command,
        ticket: event.ticket ?? null,
        result: event.result,
        idempotency_key: event.details?.idempotency_key ?? null,
        external_side_effects: event.details?.external_side_effects ?? null,
        hash_alg: event.hash_alg ?? null,
        prev_event_hash: event.prev_event_hash ?? null,
      })),
      chain,
      providerCalls: providerCalls(dir),
    }));
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

module.exports = { sandboxOverrides, remoteLedgerPath, providerCalls, IDEMPOTENCY_KEY, TICKET };

if (require.main === module) {
  main(process.argv.slice(2));
}
