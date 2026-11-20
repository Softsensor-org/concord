"use strict";

// COORD-1041 batch 1: the in-process integration-authority fixture, factored out of
// integration-authority.test.js so the verb-level attempt tests can share it. The body is
// unchanged from the original test-local helper.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../../paths.js");
const COORD_ROOT = path.resolve(__dirname, "..", "..", "..");
const { withScopedGovernanceTestContext } = require(resolveEngineModule(COORD_ROOT, "scripts/governance-test-utils.js"));
const authority = require("../integration-authority.js");
const { createIntegrationCommands } = require("../integration-commands.js");
const { createApprovalFixture } = require("./approval-fixture.js");

const ORCH = "codexa02";
const WORKER = "codexa01";

function withCanonicalAuthorityContext(run, { onVerified } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord915-canonical-module-"));
  const runtime = path.join(root, ".runtime");
  const boardPath = path.join(root, "board", "tasks.json");
  const agentsPath = path.join(runtime, "agents.json");
  const sessionsPath = path.join(runtime, "agent_sessions.json");
  const eventLogPath = path.join(runtime, "governance-events.ndjson");
  const previousReaders = authority.__testing.getSessionReaders();
  const previousMutation = authority.__testing.getJournalMutation();
  const previousJournalReader = authority.__testing.getJournalReader();
  const approvalFixture = createApprovalFixture({ allowedVerbs: ["integration handoff", "integration recover --abandon"] });
  let threadId = null;
  const scoped = {
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    RUNTIME_DIR: runtime,
    PLAN_RECORDS_DIR: path.join(runtime, 'plans'),
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtime, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtime, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtime, "governance.lock"),
    COORD_STATE_LOCK_DIR: path.join(runtime, ".coord-state.lock"),
    AGENT_STATE_LOCK_DIR: path.join(runtime, ".agent-state.lock"),
  };
  try {
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }));
    fs.writeFileSync(agentsPath, JSON.stringify([
      { handle: ORCH, status: "active" }, { handle: WORKER, status: "active" },
    ]));
    const sessions = [
      { handle: ORCH, thread_id: "thread-old", session_id: "session-old", board_path: boardPath, status: "active" },
      { handle: WORKER, thread_id: "thread-new", session_id: "session-new", board_path: boardPath, status: "active" },
    ];
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
    fs.writeFileSync(path.join(root, ".gitignore"), ".runtime/\n");
    const git = (...args) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
    git("add", ".");
    git("commit", "-m", "seed scoped canonical-module workspace");
    return withScopedGovernanceTestContext(scoped, () => {
      authority.__testing.setSessionReaders({ resolveEffectiveThreadId: () => threadId });
      authority.__testing.setJournalReader(() => {
        if (!fs.existsSync(eventLogPath)) return [];
        return fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      });
      authority.__testing.setJournalMutation((metadata, body) => {
        const result = body();
        fs.appendFileSync(eventLogPath, `${JSON.stringify({ command: metadata.command, details: metadata.details })}\n`);
        return result;
      });
      const appendApprovalEvent = (event) => {
        fs.appendFileSync(eventLogPath, `${JSON.stringify({ ...event, details: event })}\n`);
        if (event.event === "approval.verified") onVerified?.();
      };
      const rawCommands = () => {
        const client = approvalFixture.client();
        const approvalClient = onVerified ? {
          ...client,
          runSign(requestText) {
            approvalFixture.login(JSON.parse(requestText));
            return client.runSign(requestText);
          },
        } : client;
        return createIntegrationCommands({ appendGovernanceEvent: appendApprovalEvent, runtimeDir: runtime, approvalClient });
      };
      const invokeSigned = (args, verb, ticket) => {
        try {
          return rawCommands().integrationCommand(args);
        } catch (error) {
          const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
          if (!digest) throw error;
          approvalFixture.login({ verb, ticket, subject_sha256: digest[1] });
          return rawCommands().integrationCommand(args);
        }
      };
      const commands = { integrationCommand(args) {
        if (args[0] === "handoff" && args.includes("--human-admin-override")) {
          return invokeSigned(args, "integration handoff", args[args.indexOf("--to") + 1]);
        }
        if (args[0] === "recover" && args.includes("--abandon") && args.includes("--human-admin-override")) {
          return invokeSigned(args, "integration recover --abandon", authority.readRecord()?.operation?.ticket);
        }
        return rawCommands().integrationCommand(args);
      } };
      const setThread = (value) => { threadId = value; };
      const updateSession = (thread, patch) => {
        const current = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
        fs.writeFileSync(sessionsPath, JSON.stringify(current.map((session) =>
          session.thread_id === thread ? { ...session, ...patch } : session)));
      };
      try {
        return run({ root, runtime, boardPath, agentsPath, sessionsPath, eventLogPath, git, commands, invokeSigned, setThread, updateSession });
      } finally {
        authority.__testing.setSessionReaders(previousReaders);
        authority.__testing.setJournalMutation(previousMutation);
        authority.__testing.setJournalReader(previousJournalReader);
      approvalFixture.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  } catch (error) {
    authority.__testing.setSessionReaders(previousReaders);
    authority.__testing.setJournalMutation(previousMutation);
    authority.__testing.setJournalReader(previousJournalReader);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { ORCH, WORKER, withCanonicalAuthorityContext };
